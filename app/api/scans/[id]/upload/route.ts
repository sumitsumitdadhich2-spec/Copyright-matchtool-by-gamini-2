import { NextResponse } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getScan, saveScan, addLog, scanMediaDir } from '@/lib/store'
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

  // Stream the request body straight to disk — movies can be gigabytes.
  await pipeline(Readable.fromWeb(req.body as never), fs.createWriteStream(dest))
  let size = fs.statSync(dest).size

  let duration: number
  try {
    duration = await probeDuration(dest)
  } catch {
    fs.unlinkSync(dest)
    return NextResponse.json({ error: 'Could not read video file. Is it a valid video?' }, { status: 400 })
  }

  if (kind === 'short') {
    // If the target clip is longer than 1 minute, keep only the first minute.
    if (duration > CHUNK_SECONDS + 1) {
      const originalDur = duration
      const trimmed = path.join(mediaDir, 'short-trimmed.mp4')
      try {
        await extractSegment(dest, 0, CHUNK_SECONDS, trimmed)
        fs.renameSync(trimmed, dest)
        size = fs.statSync(dest).size
        duration = await probeDuration(dest)
        addLog(scan, 'info', `Short clip was ${fmtDur(originalDur)} — auto-trimmed to first ${fmtDur(duration)}`)
      } catch (err) {
        try {
          if (fs.existsSync(trimmed)) fs.unlinkSync(trimmed)
        } catch {
          // ignore
        }
        addLog(scan, 'warn', `Auto-trim failed, keeping full ${fmtDur(originalDur)} clip: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    scan.shortName = name
    scan.shortSize = size
    scan.shortDuration = duration
    addLog(scan, 'info', `Short video uploaded: ${name} (${fmtDur(duration)})`)
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
