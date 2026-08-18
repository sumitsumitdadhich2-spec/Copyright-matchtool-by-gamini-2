import { NextResponse } from 'next/server'
import { getApiKey, setApiKey, getAllUsage } from '@/lib/store'
import { MODEL_POOL } from '@/lib/models'

export const runtime = 'nodejs'

export async function GET() {
  const key = getApiKey()
  return NextResponse.json({
    hasKey: Boolean(key),
    maskedKey: key ? `${key.slice(0, 6)}...${key.slice(-4)}` : null,
    usage: key ? getAllUsage(key) : null,
    models: MODEL_POOL,
  })
}

export async function POST(req: Request) {
  const body = (await req.json()) as { apiKey?: string }
  const apiKey = (body.apiKey || '').trim()
  if (!apiKey || apiKey.length < 10) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 400 })
  }
  setApiKey(apiKey)
  return NextResponse.json({ ok: true })
}
