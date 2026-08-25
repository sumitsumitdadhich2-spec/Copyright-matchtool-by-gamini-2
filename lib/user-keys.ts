import 'server-only'

import { put, get } from '@vercel/blob'
import { MAX_API_KEYS } from './store'

// ---------------------------------------------------------------------------
// PER-USER Gemini API keys, stored in Vercel Blob (private store).
// Each account gets its own file: cmt-auth/keys/<username>.json
// so every user's keys are fully isolated from everyone else's.
// ---------------------------------------------------------------------------

const KEYS_PREFIX = 'cmt-auth/keys/'

/** slot number (as string) -> API key */
type UserKeys = Record<string, string>

// Small in-memory cache so we don't hit Blob on every request in one process.
const cache = new Map<string, { keys: UserKeys; at: number }>()
const CACHE_MS = 30_000

function cacheKey(username: string): string {
  return username.trim().toLowerCase()
}

function blobPathFor(username: string): string {
  // Usernames are validated at creation ([a-zA-Z0-9_.-]{3,32}), safe as a path.
  return `${KEYS_PREFIX}${cacheKey(username)}.json`
}

async function readUserKeys(username: string): Promise<UserKeys> {
  const ck = cacheKey(username)
  const cached = cache.get(ck)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.keys
  try {
    const result = await get(blobPathFor(username), { access: 'private' })
    if (!result || !result.stream) {
      cache.set(ck, { keys: {}, at: Date.now() })
      return {}
    }
    const data = (await new Response(result.stream).json()) as UserKeys
    const keys = data && typeof data === 'object' ? data : {}
    cache.set(ck, { keys, at: Date.now() })
    return keys
  } catch {
    cache.set(ck, { keys: {}, at: Date.now() })
    return {}
  }
}

async function writeUserKeys(username: string, keys: UserKeys): Promise<void> {
  await put(blobPathFor(username), JSON.stringify(keys), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    // Must be readable immediately after save.
    cacheControlMaxAge: 0,
  })
  cache.set(cacheKey(username), { keys, at: Date.now() })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read this user's API key for slot n (1-20). */
export async function getUserKeyN(username: string, n: number): Promise<string | null> {
  const keys = await readUserKeys(username)
  return keys[String(n)] || null
}

/** Save this user's API key in slot n (1-20). */
export async function setUserKeyN(username: string, n: number, key: string): Promise<void> {
  const keys = await readUserKeys(username)
  await writeUserKeys(username, { ...keys, [String(n)]: key })
}

/** Remove this user's key in slot n. */
export async function clearUserKeyN(username: string, n: number): Promise<void> {
  const keys = { ...(await readUserKeys(username)) }
  delete keys[String(n)]
  await writeUserKeys(username, keys)
}

/** All of this user's configured keys in slot order, de-duplicated. */
export async function getAllUserApiKeys(username: string): Promise<string[]> {
  const keys = await readUserKeys(username)
  const out: string[] = []
  for (let n = 1; n <= MAX_API_KEYS; n++) {
    const k = keys[String(n)]
    if (k && !out.includes(k)) out.push(k)
  }
  return out
}

/** Delete a user's entire key file (used when the account is deleted). */
export async function deleteUserKeys(username: string): Promise<void> {
  try {
    await writeUserKeys(username, {})
  } catch {
    // best-effort
  }
  cache.delete(cacheKey(username))
}
