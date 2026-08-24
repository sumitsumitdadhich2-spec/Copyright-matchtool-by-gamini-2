import { NextResponse } from 'next/server'
import { getApiKey, getApiKeyN, setApiKeyN, clearApiKeyN, getAllUsage, MAX_API_KEYS } from '@/lib/store'
import { MODEL_POOL } from '@/lib/models'

export const runtime = 'nodejs'

function mask(key: string) {
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}

export async function GET() {
  const keys: { index: number; hasKey: boolean; maskedKey: string | null }[] = []
  for (let n = 1; n <= MAX_API_KEYS; n++) {
    const k = getApiKeyN(n)
    keys.push({ index: n, hasKey: Boolean(k), maskedKey: k ? mask(k) : null })
  }
  const key1 = getApiKey()
  return NextResponse.json({
    keys,
    maxKeys: MAX_API_KEYS,
    // legacy fields kept for older clients
    hasKey: keys[0].hasKey,
    maskedKey: keys[0].maskedKey,
    hasKey2: keys[1].hasKey,
    maskedKey2: keys[1].maskedKey,
    usage: key1 ? getAllUsage(key1) : null,
    models: MODEL_POOL,
  })
}

export async function POST(req: Request) {
  const body = (await req.json()) as Record<string, unknown>

  // ----- Clear a key slot: { clear: n } -----
  if (typeof body.clear === 'number') {
    const n = body.clear
    if (!Number.isInteger(n) || n < 1 || n > MAX_API_KEYS) {
      return NextResponse.json({ error: 'Invalid key slot' }, { status: 400 })
    }
    clearApiKeyN(n)
    return NextResponse.json({ ok: true })
  }

  // ----- Save keys: accepts apiKey/apiKey1 ... apiKey20, any combination -----
  const updates: { n: number; key: string }[] = []
  for (let n = 1; n <= MAX_API_KEYS; n++) {
    const raw = n === 1 ? (body.apiKey1 ?? body.apiKey) : body[`apiKey${n}`]
    const key = typeof raw === 'string' ? raw.trim() : ''
    if (key) updates.push({ n, key })
  }
  if (updates.length === 0) {
    return NextResponse.json({ error: 'No API key provided' }, { status: 400 })
  }

  // Validate each key: length + must be DIFFERENT from every other slot (same key = no extra quota).
  for (const u of updates) {
    if (u.key.length < 10) {
      return NextResponse.json({ error: `Invalid API key ${u.n}` }, { status: 400 })
    }
    for (let other = 1; other <= MAX_API_KEYS; other++) {
      if (other === u.n) continue
      const otherKey = updates.find((x) => x.n === other)?.key ?? getApiKeyN(other)
      if (otherKey && otherKey === u.key) {
        return NextResponse.json(
          { error: `Key ${u.n} must be DIFFERENT from Key ${other} — the same key gives no extra quota` },
          { status: 400 },
        )
      }
    }
  }

  for (const u of updates) setApiKeyN(u.n, u.key)
  return NextResponse.json({ ok: true })
}
