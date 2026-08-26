import { NextResponse } from 'next/server'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getScan, SCANS_DIR } from '@/lib/store'
import { restoreScansFromBlob } from '@/lib/scan-blob'
import { finalizeUploadedMedia, localMediaPath } from '@/lib/media'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * DIRECT upload: the browser streams the raw video body straight to this
 * route, which writes it to local disk. No Blob round-trip — ffmpeg starts
 * on the local file immediately, so upload + processing are as fast as the
 * network/disk allow.
 *
 * Query params: ?kind=short|movie&name=<original filename>
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  let scan = getScan(id)
  if (!scan) {
    await restoreScansFromBlob(SCANS_DIR)
    scan = getScan(id)
  }
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const url = new URL(req.url)
  const kind = url.searchParams.get('kind')
  const rawName = url.searchParams.get('name') || 'video.mp4'
  const name = rawName.trim() || 'video.mp4'
  if (kind !== 'short' && kind !== 'movie') {
    return NextResponse.json({ error: 'kind must be short or movie' }, { status: 400 })
  }
  if (!req.body) {
    return NextResponse.json({ error: 'Empty upload body' }, { status: 400 })
  }

  // Stream the request body straight to disk (no memory buffering).
  const dest = localMediaPath(id, kind)
  const tmp = `${dest}.up-${process.pid}`
  try {
    await pipeline(Readable.fromWeb(req.body as never), fs.createWriteStream(tmp))
    fs.renameSync(tmp, dest)
  } catch (err) {
    try {
      if (fs.existsSync(/*turbopackIgnore: true*/ tmp)) fs.unlinkSync(tmp)
    } catch {
      // ignore cleanup failure
    }
    console.error('[upload] stream to disk failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Upload failed while saving the file. Please try again.' }, { status: 500 })
  }

  // Probe with ffmpeg and set up segments / trim state right away.
  const result = await finalizeUploadedMedia(scan, kind, name)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  return NextResponse.json({ ok: true, duration: result.duration, size: result.size })
}
