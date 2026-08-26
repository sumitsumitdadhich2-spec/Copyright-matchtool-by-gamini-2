import { NextResponse } from 'next/server'
import { getScan, SCANS_DIR } from '@/lib/store'
import { restoreScansFromBlob, flushScanToBlob } from '@/lib/scan-blob'
import { finalizeUploadedMedia } from '@/lib/media'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * Called by the client AFTER the direct browser → Blob upload finished.
 * Pulls the video from Blob to /tmp, probes it with ffmpeg and sets up the
 * scan state (segments for shorts, trim-await for movies).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  let scan = getScan(id)
  if (!scan) {
    await restoreScansFromBlob(SCANS_DIR)
    scan = getScan(id)
  }
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as { kind?: string; name?: string }
  const kind = body.kind
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'video.mp4'
  if (kind !== 'short' && kind !== 'movie') {
    return NextResponse.json({ error: 'kind must be short or movie' }, { status: 400 })
  }

  const result = await finalizeUploadedMedia(scan, kind, name)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  // CRITICAL on Vercel: make sure the finalized state is IN Blob storage
  // before we respond. The next poll may hit a different serverless instance,
  // and a fire-and-forget write can be cut off when this instance freezes.
  const finalized = getScan(id)
  if (finalized) await flushScanToBlob(finalized)

  return NextResponse.json({ ok: true, duration: result.duration, size: result.size })
}
