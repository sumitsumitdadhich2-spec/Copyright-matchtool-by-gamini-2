import { NextResponse } from 'next/server'
import { scheduler } from '@/lib/scheduler'
import { getSession } from '@/lib/users'
import { getAllUserApiKeys, getUserTwelveLabsKey } from '@/lib/user-keys'
import { deductTokens, refundTokens, SCAN_TOKEN_COST } from '@/lib/tokens'

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

  // TOKENS: 1 fresh scan = 100 tokens. Resume is free (already paid).
  // Admin (shiva) has unlimited tokens and never gets charged.
  let charged = false
  if (session.role !== 'admin' && !resume) {
    const newBalance = await deductTokens(session.username, SCAN_TOKEN_COST)
    if (newBalance === null) {
      return NextResponse.json(
        { error: `Tokens khatm ho gaye hain! 1 scan = ${SCAN_TOKEN_COST} tokens. Admin se tokens lo.`, tokensExhausted: true },
        { status: 402 },
      )
    }
    charged = true
  }

  // OPTIONAL Twelve Labs pre-filter key: passing it enables the embedding
  // pre-filter at scan time. Missing key = normal full scan (feature off).
  const tlApiKey = await getUserTwelveLabsKey(session.username)

  const result = await scheduler.start(id, resume, userApiKeys, tlApiKey)
  if (!result.ok) {
    // Scan didn't start — give the tokens back.
    if (charged) await refundTokens(session.username, SCAN_TOKEN_COST)
    return NextResponse.json({ error: result.error }, { status: 400 })
  }
  return NextResponse.json({ ok: true })
}
