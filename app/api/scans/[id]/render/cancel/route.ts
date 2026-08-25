import { NextResponse } from 'next/server'
import { getFreshScan } from '@/lib/store'
import { cancelRender } from '@/lib/render'

export const runtime = 'nodejs'

/** Cancel an in-flight render (kills the ffmpeg process, resets renderJob to idle). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  // Cross-instance safe read: pulls the scan from Blob when /tmp is stale.
  if (!(await getFreshScan(id))) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const cancelled = cancelRender(id)
  if (!cancelled) return NextResponse.json({ error: 'No render in progress' }, { status: 400 })
  return NextResponse.json({ ok: true })
}
