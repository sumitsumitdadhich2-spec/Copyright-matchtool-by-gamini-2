import { NextResponse } from 'next/server'
import { getScan, saveScan, addLog } from '@/lib/store'
import { scheduler } from '@/lib/scheduler'

export const runtime = 'nodejs'

/** Update which short-video minutes are selected for scanning.
 *  Unselected minutes are skipped; select them later + Resume to scan the rest
 *  — results merge into the same scan. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const scan = getScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })
  if (scheduler.isRunning(id)) {
    return NextResponse.json({ error: 'Cannot change minute selection while a scan is running' }, { status: 409 })
  }
  const segs = scan.shortSegments
  if (!segs || segs.length === 0) {
    return NextResponse.json({ error: 'No short-video minutes to select' }, { status: 400 })
  }

  const body = (await req.json().catch(() => ({}))) as { selected?: number[] }
  const selected = Array.isArray(body.selected) ? body.selected.filter((n) => Number.isInteger(n)) : null
  if (!selected || selected.length === 0) {
    return NextResponse.json({ error: 'Select at least one minute to scan' }, { status: 400 })
  }
  const set = new Set(selected)
  for (const seg of segs) seg.selected = set.has(seg.index)

  // Reopen a finished scan when newly selected minutes still have work, so Resume enables.
  const hasWork = segs.some(
    (s) =>
      s.selected !== false &&
      (s.status !== 'done' ||
        s.chunks.some((c) => c.status === 'pending' || c.status === 'scanning' || c.status === 'cancelled')),
  )
  if (scan.status === 'done' && hasWork) scan.status = 'stopped'

  const picked = segs.filter((s) => s.selected !== false).map((s) => s.index + 1)
  addLog(scan, 'info', `Minute selection updated: scanning minute(s) ${picked.join(', ')} of ${segs.length}`)
  saveScan(scan)
  return NextResponse.json({ ok: true, selected: picked })
}
