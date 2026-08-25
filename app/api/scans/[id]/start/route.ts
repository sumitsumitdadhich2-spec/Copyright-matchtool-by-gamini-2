import { NextResponse } from 'next/server'
import { scheduler } from '@/lib/scheduler'
import { getSession } from '@/lib/users'
import { getAllUserApiKeys } from '@/lib/user-keys'

export const runtime = 'nodejs'

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  let resume = false
  try {
    const body = (await req.json()) as { resume?: boolean }
    resume = Boolean(body.resume)
  } catch {
    // no body
  }

  // PER-USER KEYS: every scan runs ONLY on the logged-in user's own keys
  // (stored in their private Blob file) — never on anyone else's.
  const userApiKeys = await getAllUserApiKeys(session.username)
  if (userApiKeys.length === 0) {
    return NextResponse.json(
      { error: 'No Gemini API key configured for YOUR account. Add your key in Settings first.' },
      { status: 400 },
    )
  }

  const result = await scheduler.start(id, resume, userApiKeys)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ ok: true })
}
