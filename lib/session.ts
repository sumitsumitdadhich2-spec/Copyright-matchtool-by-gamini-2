import crypto from 'crypto'

// Signed stateless session tokens — no database needed.
// Secret: prefer SESSION_SECRET, fall back to the Blob token (always present when Blob is connected).
const SECRET = process.env.SESSION_SECRET || process.env.BLOB_READ_WRITE_TOKEN || 'cmt-dev-secret'

export const SESSION_COOKIE = 'cmt_session'
const SESSION_DAYS = 7

export interface SessionUser {
  username: string
  role: 'admin' | 'user'
}

interface TokenPayload {
  u: string
  r: 'admin' | 'user'
  exp: number
}

function hmac(payload: string): string {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
}

export function signSession(user: SessionUser): string {
  const payload = Buffer.from(
    JSON.stringify({ u: user.username, r: user.role, exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000 } satisfies TokenPayload),
  ).toString('base64url')
  return `${payload}.${hmac(payload)}`
}

export function verifySessionToken(token: string | undefined | null): SessionUser | null {
  if (!token) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = hmac(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as TokenPayload
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null
    if (typeof data.u !== 'string' || (data.r !== 'admin' && data.r !== 'user')) return null
    return { username: data.u, role: data.r }
  } catch {
    return null
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    // v0 preview iframe is cross-site; SameSite=None + Secure is required
    // for the cookie to be retained there. Also correct in production (HTTPS).
    sameSite: 'none' as const,
    secure: true,
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  }
}
