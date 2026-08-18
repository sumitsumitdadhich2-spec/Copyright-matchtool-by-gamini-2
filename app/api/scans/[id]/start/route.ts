import { NextResponse } from 'next/server'
import { scheduler } from '@/lib/scheduler'

export const runtime = 'nodejs'

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  let resume = false
  try {
    const body = (await req.json()) as { resume?: boolean }
    resume = Boolean(body.resume)
  } catch {
    // no body
  }
  const result = await scheduler.start(id, resume)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ ok: true })
}
