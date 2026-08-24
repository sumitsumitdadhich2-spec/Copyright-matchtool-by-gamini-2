import { NextResponse } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getScan, saveScan, addLog, scanMediaDir } from '@/lib/store'
import type { Scan } from '@/lib/types'
import { probeDuration, chunkShort, cleanupSegments } from '@/lib/ffmpeg'
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
    // drops long-running requests. The ORIGINAL short.mp4 is NEVER overwritten:
    // preview, verifier clips and the render pipeline all use it at full quality.
    // Scanning uses separate re-encoded 1-minute segment files cut in the background.
    scan.shortName = name
    scan.shortSize = size
    scan.shortDuration = duration
    const segCount = Math.max(1, Math.ceil(duration / CHUNK_SECONDS))
    scan.shortSegments = Array.from({ length: segCount }, (_, i) => ({
      index: i,
      start: i * CHUNK_SECONDS,
      end: Math.min((i + 1) * CHUNK_SECONDS, duration),
      status: 'pending' as const,
      chunks: [],
    }))
    scan.currentShortSegment = 0
    scan.shortSegmentingProgress = 0
    addLog(
      scan,
      'info',
      segCount > 1
        ? `Short video uploaded: ${name} (${fmtDur(duration)}) — will be scanned minute-by-minute (${segCount} segments), original quality preserved`
        : `Short video uploaded: ${name} (${fmtDur(duration)}) — original quality preserved, scan copy cut in background`,
    )
    saveScan(scan)

    // Background: cut 24 fps / 640px scan segments (seg-0000.mp4, ...) — original untouched.
    const segDir = path.join(mediaDir, 'segments')
    void (async () => {
      try {
        cleanupSegments(segDir)
        const actual = await chunkShort(dest, segDir, duration, (pct) => {
          const s = getScan(id)
          if (s) {
            s.shortSegmentingProgress = pct
            saveScan(s)
          }
        })
        const s = getScan(id)
        if (s) {
          s.shortSegmentingProgress = 100
          if (actual !== s.shortSegments?.length) {
            s.shortSegments = Array.from({ length: actual }, (_, i) => ({
              index: i,
              start: i * CHUNK_SECONDS,
              end: Math.min((i + 1) * CHUNK_SECONDS, duration),
              status: 'pending' as const,
              chunks: [],
            }))
          }
          addLog(s, 'success', `Short scan segments ready: ${actual} × 1-minute file(s) at 24 fps`)
          saveScan(s)
        }
      } catch (err) {
        const s = getScan(id)
        if (s) {
          s.shortSegmentingProgress = 100
          addLog(s, 'warn', `Short segment cutting failed (segments will be re-cut on demand during the scan): ${err instanceof Error ? err.message : String(err)}`)
          saveScan(s)
        }
      }
    })()
  } else {
    scan.movieName = name
    scan.movieSize = size
    scan.movieDuration = duration
    // Chunking WAITS for the trim confirmation — the user can select just the
    // range that holds their scene (saves API quota) or confirm the full movie.
    scan.chunkCount = 0
    scan.chunks = []
    scan.awaitingTrim = true
    scan.movieTrimStart = undefined
    scan.movieTrimEnd = undefined
    scan.status = 'created'
    scan.chunkingProgress = 0
    addLog(
      scan,
      'info',
      `Movie uploaded: ${name} (${fmtDur(duration)}) — select a trim range (optional) and confirm to start chunking`,
    )
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
