import { NextResponse } from 'next/server'
import { scheduler } from '@/lib/scheduler'

export const runtime = 'nodejs'

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const result = scheduler.stop(id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ ok: true })
}
