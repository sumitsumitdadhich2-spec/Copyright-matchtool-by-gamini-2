import { NextResponse } from 'next/server'
import { getScan, getApiKey, getAllUsage } from '@/lib/store'
import { scheduler } from '@/lib/scheduler'

export const runtime = 'nodejs'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const scan = getScan(id)
  if (!scan) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const key = getApiKey()
  return NextResponse.json({
    scan,
    running: scheduler.isRunning(id),
    usage: key ? getAllUsage(key) : null,
  })
}
