import { NextResponse } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getScan, saveScan, addLog, scanMediaDir } from '@/lib/store'
import type { Scan } from '@/lib/types'
import { probeDuration, chunkMovie, extractSegment } from '@/lib/ffmpeg'
import { CHUNK_SECONDS } from '@/lib/models'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const scan = getScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const url = new URL(req.url)
  const kind = url.searchParams.get('kind')
  const name = url.searchParams.get('name') || 'video.mp4'
  if (kind !== 'short' && kind !== 'movie') {
    return NextResponse.json({ error: 'kind must be short or movie' }, { status: 400 })
  }
  if (!req.body) return NextResponse.json({ error: 'No file body' }, { status: 400 })

  const mediaDir = scanMediaDir(id)
  const dest = path.join(mediaDir, `${kind}.mp4`)

  // Sliced upload: big files (movies) are sent as many small slices so the
  // preview/production proxy never sees one huge long-running request body.
  const partParam = url.searchParams.get('part')
  const partsParam = url.searchParams.get('parts')

  if (partParam !== null && partsParam !== null) {
    const part = Number.parseInt(partParam, 10)
    const parts = Number.parseInt(partsParam, 10)
    if (!Number.isInteger(part) || !Number.isInteger(parts) || part < 0 || parts < 1 || part >= parts) {
      return NextResponse.json({ error: 'Invalid part/parts' }, { status: 400 })
    }

    const tmp = path.join(mediaDir, `${kind}.uploading`)
    const progressFile = path.join(mediaDir, `${kind}.uploading.next`)

    // Part 0 always starts a fresh file. Later parts must arrive in order —
    // if a slice was already written (a retry of a delivered slice), accept it as a no-op.
    const expected = part === 0 ? 0 : readNextPart(progressFile)
    if (part < expected) {
      // Slice already landed (client retried after the proxy dropped the response).
      return NextResponse.json({ ok: true, part, alreadyReceived: true })
    }
    if (part > expected) {
      return NextResponse.json({ error: `Out of order slice: expected ${expected}, got ${part}`, expected }, { status: 409 })
    }

    await pipeline(
      Readable.fromWeb(req.body as never),
      fs.createWriteStream(tmp, { flags: part === 0 ? 'w' : 'a' }),
    )
    fs.writeFileSync(progressFile, String(part + 1))

    if (part < parts - 1) {
      return NextResponse.json({ ok: true, part })
    }

    // Last slice — assemble complete file and finalize.
    fs.renameSync(tmp, dest)
    try {
      fs.unlinkSync(progressFile)
    } catch {
      // ignore
    }
    return finalizeUpload(scan, id, kind, name, dest, mediaDir)
  }

  // Single-shot upload (small files).
  await pipeline(Readable.fromWeb(req.body as never), fs.createWriteStream(dest))
  return finalizeUpload(scan, id, kind, name, dest, mediaDir)
}

function readNextPart(progressFile: string): number {
  try {
    const n = Number.parseInt(fs.readFileSync(progressFile, 'utf8').trim(), 10)
    return Number.isInteger(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

async function finalizeUpload(
  scan: Scan,
  id: string,
  kind: 'short' | 'movie',
  name: string,
  dest: string,
  mediaDir: string,
) {
  const size = fs.statSync(dest).size

  let duration: number
  try {
    duration = await probeDuration(dest)
  } catch {
    fs.unlinkSync(dest)
    return NextResponse.json({ error: 'Could not read video file. Is it a valid video?' }, { status: 400 })
  }

  if (kind === 'short') {
    // Record the upload immediately and respond fast — the preview/production proxy
    // drops long-running requests, so the 24 fps re-encode MUST happen in the background.
    scan.shortName = name
    scan.shortSize = size
    scan.shortDuration = duration
    addLog(scan, 'info', `Short video uploaded: ${name} (${fmtDur(duration)})`)
    saveScan(scan)

    // Background: ALWAYS re-encode the short video to 24 fps (trim to first minute when longer).
    const originalDur = duration
    const wasTrimmed = duration > CHUNK_SECONDS + 1
    const reencoded = path.join(mediaDir, 'short-24fps.mp4')
    void (async () => {
      try {
        await extractSegment(dest, 0, Math.min(originalDur, CHUNK_SECONDS), reencoded)
        fs.renameSync(reencoded, dest)
        const newSize = fs.statSync(dest).size
        const newDuration = await probeDuration(dest)
        const s = getScan(id)
        if (s) {
          s.shortSize = newSize
          s.shortDuration = newDuration
          addLog(
            s,
            'info',
            wasTrimmed
              ? `Short clip was ${fmtDur(originalDur)} — auto-trimmed to first ${fmtDur(newDuration)} and compressed to 24 fps for scanning`
              : `Short clip compressed to 24 fps for scanning (${fmtDur(newDuration)}) — original quality is not needed for matching`,
          )
          saveScan(s)
        }
      } catch (err) {
        try {
          if (fs.existsSync(reencoded)) fs.unlinkSync(reencoded)
        } catch {
          // ignore
        }
        const s = getScan(id)
        if (s) {
          addLog(s, 'warn', `24 fps re-encode failed, keeping original ${fmtDur(originalDur)} clip: ${err instanceof Error ? err.message : String(err)}`)
          saveScan(s)
        }
      }
    })()
  } else {
    scan.movieName = name
    scan.movieSize = size
    scan.movieDuration = duration
    // Dynamic chunk count from actual duration — never hardcoded.
    const count = Math.ceil(duration / CHUNK_SECONDS)
    scan.chunkCount = count
    scan.chunks = Array.from({ length: count }, (_, i) => ({ index: i, status: 'pending' as const, attempts: 0 }))
    scan.status = 'chunking'
    scan.chunkingProgress = 0
    addLog(scan, 'info', `Movie uploaded: ${name} (${fmtDur(duration)}) — cutting into ${count} one-minute chunks`)
    saveScan(scan)

    // Chunk in the background; the client polls chunkingProgress.
    void (async () => {
      try {
        const actual = await chunkMovie(dest, path.join(mediaDir, 'chunks'), duration, (pct) => {
          const s = getScan(id)
          if (s) {
            s.chunkingProgress = pct
            saveScan(s)
          }
        })
        const s = getScan(id)
        if (s) {
          if (actual !== s.chunkCount) {
            s.chunkCount = actual
            s.chunks = Array.from({ length: actual }, (_, i) => ({ index: i, status: 'pending' as const, attempts: 0 }))
          }
          s.status = 'ready'
          s.chunkingProgress = 100
          addLog(s, 'success', `Chunking complete: ${actual} chunks ready`)
          saveScan(s)
        }
      } catch (err) {
        const s = getScan(id)
        if (s) {
          s.status = 'error'
          s.error = `Chunking failed: ${err instanceof Error ? err.message : String(err)}`
          addLog(s, 'error', s.error)
          saveScan(s)
        }
      }
    })()
  }

  saveScan(scan)
  return NextResponse.json({ ok: true, duration, size })
}

function fmtDur(sec: number): string {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0 ? `${h}h ${m}m ${ss}s` : `${m}m ${ss}s`
}
