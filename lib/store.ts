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

interface Settings {
  apiKey?: string
  apiKey2?: string
}

export function getApiKey(): string | null {
  const s = readJSON<Settings>(SETTINGS_FILE, {})
  return s.apiKey || null
}

/** Second API key (Verifier lane). Optional — verification falls back to key 1 when absent. */
export function getApiKey2(): string | null {
  const s = readJSON<Settings>(SETTINGS_FILE, {})
  return s.apiKey2 || null
}

export function setApiKey(apiKey: string) {
  const s = readJSON<Settings>(SETTINGS_FILE, {})
  writeJSON(SETTINGS_FILE, { ...s, apiKey })
}

export function setApiKey2(apiKey2: string) {
  const s = readJSON<Settings>(SETTINGS_FILE, {})
  writeJSON(SETTINGS_FILE, { ...s, apiKey2 })
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
    candidates: [],
    regions: [],
    logs: [],
    startedAt: null,
    finishedAt: null,
    earlyStopped: false,
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
      matchCount: s.regions.length || s.candidates.length,
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
