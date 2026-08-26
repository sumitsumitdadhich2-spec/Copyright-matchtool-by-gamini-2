import { NextResponse } from 'next/server'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { getScan, SCANS_DIR } from '@/lib/store'
import { restoreScansFromBlob } from '@/lib/scan-blob'
import { mediaBlobPath } from '@/lib/media'

export const runtime = 'nodejs'

/**
 * Token endpoint for DIRECT browser → Blob uploads (@vercel/blob/client).
 * The video never passes through this serverless function, so Vercel's 4.5MB
 * request-body limit and instance affinity don't matter — files of any size
 * land straight in Blob storage. After the upload completes the client calls
 * /upload/complete which pulls the file to /tmp and finalizes the scan state.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  let scan = getScan(id)
  if (!scan) {
    await restoreScansFromBlob(SCANS_DIR)
    scan = getScan(id)
  }
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  let body: HandleUploadBody
  try {
    body = (await req.json()) as HandleUploadBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const allowed = [mediaBlobPath(id, 'short'), mediaBlobPath(id, 'movie')]

  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!allowed.includes(pathname)) {
          throw new Error('Invalid upload path')
        }
        return {
          allowedContentTypes: ['video/*', 'application/octet-stream'],
          maximumSizeInBytes: 5 * 1024 * 1024 * 1024, // 5 GB per video
          addRandomSuffix: false,
          allowOverwrite: true,
        }
      },
      // Production webhook — the client-driven /upload/complete does the real
      // finalize (works in preview too, where this callback can't reach us).
      onUploadCompleted: async () => {},
    })
    return NextResponse.json(json)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Upload token failed' }, { status: 400 })
  }
}
