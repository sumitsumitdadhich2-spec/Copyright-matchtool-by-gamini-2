import { NextResponse } from 'next/server'
import { getApiKey, setApiKey, getApiKey2, setApiKey2, getAllUsage } from '@/lib/store'
import { MODEL_POOL } from '@/lib/models'

export const runtime = 'nodejs'

export async function GET() {
  const key = getApiKey()
  const key2 = getApiKey2()
  return NextResponse.json({
    hasKey: Boolean(key),
    maskedKey: key ? `${key.slice(0, 6)}...${key.slice(-4)}` : null,
    hasKey2: Boolean(key2),
    maskedKey2: key2 ? `${key2.slice(0, 6)}...${key2.slice(-4)}` : null,
    usage: key ? getAllUsage(key) : null,
    models: MODEL_POOL,
  })
}

export async function POST(req: Request) {
  const body = (await req.json()) as { apiKey?: string; apiKey2?: string }
  const apiKey = (body.apiKey || '').trim()
  const apiKey2 = (body.apiKey2 || '').trim()

  if (!apiKey && !apiKey2) {
    return NextResponse.json({ error: 'No API key provided' }, { status: 400 })
  }
  if (apiKey) {
    if (apiKey.length < 10) return NextResponse.json({ error: 'Invalid API key' }, { status: 400 })
    if (!apiKey2 && apiKey === getApiKey2()) {
      return NextResponse.json({ error: 'Key 1 must be DIFFERENT from Key 2 — same key gives no extra quota' }, { status: 400 })
    }
    setApiKey(apiKey)
  }
  if (apiKey2) {
    if (apiKey2.length < 10) return NextResponse.json({ error: 'Invalid API key 2' }, { status: 400 })
    if (apiKey2 === (apiKey || getApiKey())) {
      return NextResponse.json({ error: 'Key 2 must be DIFFERENT from Key 1 — same key gives no extra quota' }, { status: 400 })
    }
    setApiKey2(apiKey2)
  }
  return NextResponse.json({ ok: true })
}
