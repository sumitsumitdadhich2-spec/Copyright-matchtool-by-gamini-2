import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Scan, ScanSummary, LogEntry } from './types'
import { MODEL_POOL } from './models'

// On Vercel the project directory is read-only; only /tmp is writable.
// Using /tmp there also keeps the data dir out of build output tracing.
const BASE_DIR = process.env.VERCEL ? '/tmp' : process.cwd()
export const DATA_DIR = path.join(BASE_DIR, 'data')
export const SCANS_DIR = path.join(DATA_DIR, 'scans')
export const MEDIA_DIR = path.join(DATA_DIR, 'media')

function ensureDirs() {
  for (const d of [DATA_DIR, SCANS_DIR, MEDIA_DIR]) {
    if (!fs.existsSync(/*turbopackIgnore: true*/ d)) fs.mkdirSync(d, { recursive: true })
  }
}

function readJSON<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJSON(file: string, data: unknown) {
  ensureDirs()
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, file)
}

// ---------- Settings (API key) ----------

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')

/** Up to 5 Gemini API keys. Key 1 is required; 2-5 are optional parallel workers. */
export const MAX_API_KEYS = 5

interface Settings {
  apiKey?: string
  apiKey2?: string
  apiKey3?: string
  apiKey4?: string
  apiKey5?: string
}

function keyField(n: number): keyof Settings {
  return (n === 1 ? 'apiKey' : `apiKey${n}`) as keyof Settings
}

/** Read API key for slot n (1-5). Slot 1 keeps the legacy `apiKey` field name. */
export function getApiKeyN(n: number): string | null {
  const s = readJSON<Settings>(SETTINGS_FILE, {})
  return (s[keyField(n)] as string | undefined) || null
}

export function getApiKey(): string | null {
  return getApiKeyN(1)
}

/** All configured keys in slot order, de-duplicated (a repeated key gives no extra quota). */
export function getAllApiKeys(): string[] {
  const out: string[] = []
  for (let n = 1; n <= MAX_API_KEYS; n++) {
    const k = getApiKeyN(n)
    if (k && !out.includes(k)) out.push(k)
  }
  return out
}

export function setApiKeyN(n: number, key: string) {
  const s = readJSON<Settings>(SETTINGS_FILE, {})
  writeJSON(SETTINGS_FILE, { ...s, [keyField(n)]: key })
}

/** Remove the key in slot n (slot 1 can also be cleared, but scanning then stops working). */
export function clearApiKeyN(n: number) {
  const s = readJSON<Settings>(SETTINGS_FILE, {})
  delete s[keyField(n)]
  writeJSON(SETTINGS_FILE, s)
}

export function apiKeyHash(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 10)
}

// ---------- Per-model daily request counters ----------
// Keyed by model + UTC date + API key hash. Persist across restarts/reloads.

const COUNTERS_FILE = path.join(DATA_DIR, 'counters.json')

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function counterKey(model: string, apiKey: string): string {
  return `${model}|${todayKey()}|${apiKeyHash(apiKey)}`
}

export function getModelUsage(model: string, apiKey: string): number {
  const counters = readJSON<Record<string, number>>(COUNTERS_FILE, {})
  return counters[counterKey(model, apiKey)] || 0
}

export function incrementModelUsage(model: string, apiKey: string): number {
  const counters = readJSON<Record<string, number>>(COUNTERS_FILE, {})
  const key = counterKey(model, apiKey)
  counters[key] = (counters[key] || 0) + 1
  // prune keys from other days to keep the file small
  const today = todayKey()
  for (const k of Object.keys(counters)) {
    if (!k.includes(`|${today}|`)) delete counters[k]
  }
  writeJSON(COUNTERS_FILE, counters)
  return counters[key]
}

export function setModelExhausted(model: string, apiKey: string, rpd: number) {
  // Force the counter to the daily cap so it is treated as exhausted everywhere.
  const counters = readJSON<Record<string, number>>(COUNTERS_FILE, {})
  const key = counterKey(model, apiKey)
  counters[key] = Math.max(counters[key] || 0, rpd)
  writeJSON(COUNTERS_FILE, counters)
}

export function getAllUsage(apiKey: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of MODEL_POOL) out[m.id] = getModelUsage(m.id, apiKey)
  return out
}

// ---------- Scans ----------

function scanFile(id: string) {
  return path.join(SCANS_DIR, `${id}.json`)
}

export function newScan(): Scan {
  ensureDirs()
  const id = crypto.randomBytes(8).toString('hex')
  const scan: Scan = {
    id,
    createdAt: Date.now(),
    status: 'created',
    shortName: null,
    movieName: null,
    shortSize: null,
    movieSize: null,
    shortDuration: null,
    movieDuration: null,
    chunkCount: 0,
    chunkingProgress: 0,
    chunks: [],
    matches: [],
    candidateGroups: [],
    logs: [],
    startedAt: null,
    finishedAt: null,
    error: null,
    report: null,
    modelStates: {},
  }
  saveScan(scan)
  return scan
}

export function getScan(id: string): Scan | null {
  return readJSON<Scan | null>(scanFile(id), null)
}

export function saveScan(scan: Scan) {
  if (scan.logs.length > 600) scan.logs = scan.logs.slice(-500)
  writeJSON(scanFile(scan.id), scan)
}

export function listScans(): ScanSummary[] {
  ensureDirs()
  const files = fs.readdirSync(SCANS_DIR).filter((f) => f.endsWith('.json'))
  const out: ScanSummary[] = []
  for (const f of files) {
    const s = readJSON<Scan | null>(path.join(SCANS_DIR, f), null)
    if (!s) continue
    out.push({
      id: s.id,
      createdAt: s.createdAt,
      status: s.status,
      movieName: s.movieName,
      shortName: s.shortName,
      movieDuration: s.movieDuration,
      matchCount: (s.matches || []).length,
      finishedAt: s.finishedAt,
    })
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export function scanMediaDir(id: string): string {
  const dir = path.join(MEDIA_DIR, id)
  if (!fs.existsSync(/*turbopackIgnore: true*/ dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function addLog(scan: Scan, level: LogEntry['level'], msg: string) {
  scan.logs.push({ t: Date.now(), level, msg })
}
