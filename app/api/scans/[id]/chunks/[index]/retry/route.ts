import { NextResponse } from 'next/server'
import { scheduler } from '@/lib/scheduler'

export const runtime = 'nodejs'

/** MANUAL chunk retry: re-runs the chunk-map for one chunk on the locked
 * chunk models (gemini-3.6-flash / gemini-3.7-flash). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  const { id, index } = await params
  const chunkIndex = Number.parseInt(index, 10)
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return NextResponse.json({ ok: false, error: 'Invalid chunk index' }, { status: 400 })
  }
  const result = await scheduler.retryChunk(id, chunkIndex)
  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}
