import 'server-only'

import { Pool } from 'pg'
import { cookies } from 'next/headers'
import crypto from 'crypto'

const globalForPool = globalThis as unknown as { __appAuthPool?: Pool }

export const pool =
  globalForPool.__appAuthPool ??
  new Pool({ connectionString: process.env.DATABASE_URL })

if (!globalForPool.__appAuthPool) {
  globalForPool.__appAuthPool = pool
}

export const SESSION_COOKIE = 'cmt_session'
const SESSION_DAYS = 7

export interface SessionUser {
  id: number
  username: string
  role: 'admin' | 'user'
}

export async function createSession(user: SessionUser): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)
  await pool.query(
    'INSERT INTO app_sessions (token, user_id, username, role, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [token, user.id, user.username, user.role, expiresAt.toISOString()],
  )
  return token
}

export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return null

  const { rows } = await pool.query(
    'SELECT user_id, username, role, expires_at FROM app_sessions WHERE token = $1',
    [token],
  )
  const row = rows[0]
  if (!row) return null

  if (new Date(row.expires_at).getTime() < Date.now()) {
    await pool.query('DELETE FROM app_sessions WHERE token = $1', [token])
    return null
  }

  return { id: row.user_id, username: row.username, role: row.role }
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (token) {
    await pool.query('DELETE FROM app_sessions WHERE token = $1', [token])
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
