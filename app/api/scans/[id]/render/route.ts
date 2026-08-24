import { NextResponse } from 'next/server'
import { getScan } from '@/lib/store'
import { startRender, validateRenderSettings, buildRenderSegments } from '@/lib/render'

export const runtime = 'nodejs'
export const maxDuration = 300

/** Start a background render/export. Body = RenderSettings. Responds immediately;
 *  progress is polled through the existing GET /api/scans/[id] (scan.renderJob). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const scan = getScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })
  if (scan.status !== 'done') {
    return NextResponse.json({ error: 'Scan must be complete before rendering' }, { status: 400 })
  }
  if (buildRenderSegments(scan).length === 0) {
    return NextResponse.json({ error: 'No matched scenes to render' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const v = validateRenderSettings(body)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  const err = startRender(id, v.settings)
  if (err) return NextResponse.json({ error: err }, { status: 409 })

  return NextResponse.json({ ok: true })
}
