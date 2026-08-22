import path from 'node:path'
import type { GoogleGenAI } from '@google/genai'
import type { Scan, ChunkState, ChunkMatch } from './types'
import { MODEL_POOL, MODEL_MIN_INTERVAL_MS, RATE_COOLDOWN_MS, CHUNK_SECONDS, type ModelSpec } from './models'
import {
  getScan,
  saveScan,
  addLog,
  getAllApiKeys,
  getModelUsage,
  incrementModelUsage,
  setModelExhausted,
  scanMediaDir,
} from './store'
import { chunkPath, cleanupChunks } from './ffmpeg'
import { getClient, uploadVideo, deleteFileQuiet, mapChunkRequest, parseChunkMatches, GeminiError, classifyError } from './gemini'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Max attempts per chunk before it is marked failed. */
const MAX_CHUNK_ATTEMPTS = 3

/** One API key lane (1-5). Gemini Files API uploads are PER KEY,
 *  so each lane keeps its own uploaded short-video URI. */
interface KeyLane {
  idx: number
  apiKey: string
  ai: GoogleGenAI
  shortUri: string | null
  /** in-flight upload lock so two workers never double-upload the short video */
  shortUriPromise: Promise<string> | null
}

interface Job {
  scan: Scan
  lanes: KeyLane[]
  /** chunk queue (indexes) */
  queue: number[]
  inFlight: Set<number>
  stopping: boolean
  /** rate-limit state keyed by `${laneIdx}|${modelId}` */
  lastRequestAt: Record<string, number>
  cooldownUntil: Record<string, number>
  dirty: boolean
  saverTimer: ReturnType<typeof setInterval> | null
}

class Scheduler {
  jobs = new Map<string, Job>()

  isRunning(scanId: string) {
    return this.jobs.has(scanId)
  }

  async start(scanId: string, resume: boolean): Promise<{ ok: boolean; error?: string }> {
    if (this.jobs.has(scanId)) return { ok: false, error: 'Scan already running' }
    const apiKeys = getAllApiKeys()
    if (apiKeys.length === 0) return { ok: false, error: 'No Gemini API key configured. Add it in Settings first.' }
    const scan = getScan(scanId)
    if (!scan) return { ok: false, error: 'Scan not found' }
    if (!scan.shortDuration || !scan.movieDuration || scan.chunkCount === 0) {
      return { ok: false, error: 'Both videos must be uploaded and chunked before scanning.' }
    }

    // Build queue: pending chunks + orphaned "scanning" chunks from an interrupted run.
    for (const c of scan.chunks) {
      if (c.status === 'scanning') c.status = 'pending'
      if (resume && c.status === 'cancelled') c.status = 'pending'
    }
    const queue = scan.chunks.filter((c) => c.status === 'pending').map((c) => c.index)

    if (queue.length === 0) return { ok: false, error: 'No pending chunks to scan.' }

    if (!Array.isArray(scan.matches)) scan.matches = []
    scan.status = 'scanning'
    scan.error = null
    if (!scan.startedAt) scan.startedAt = Date.now()

    // One lane per configured key (1-5, already de-duplicated). All lanes pull
    // chunks from the same shared queue in parallel.
    const lanes: KeyLane[] = apiKeys.map((k, i) => ({
      idx: i + 1,
      apiKey: k,
      ai: getClient(k),
      shortUri: null,
      shortUriPromise: null,
    }))

    addLog(
      scan,
      'info',
      resume
        ? `Resuming: ${queue.length} chunk(s) pending`
        : `Scan started: ${queue.length} chunks queued across ${MODEL_POOL.length} models × ${lanes.length} API key(s) — one prompt per chunk`,
    )

    const job: Job = {
      scan,
      lanes,
      queue,
      inFlight: new Set(),
      stopping: false,
      lastRequestAt: {},
      cooldownUntil: {},
      dirty: true,
      saverTimer: null,
    }
    this.jobs.set(scanId, job)
    // Persist on an interval instead of every mutation (logs update very often).
    job.saverTimer = setInterval(() => {
      if (job.dirty) {
        job.dirty = false
        try {
          saveScan(job.scan)
        } catch {
          /* ignore */
        }
      }
    }, 800)
    saveScan(scan)

    void this.runScan(job).catch((err) => {
      addLog(job.scan, 'error', `Fatal scheduler error: ${err instanceof Error ? err.message : String(err)}`)
      job.scan.status = 'error'
      job.scan.error = err instanceof Error ? err.message : String(err)
      this.finish(job)
    })
    return { ok: true }
  }

  stop(scanId: string): { ok: boolean; error?: string } {
    const job = this.jobs.get(scanId)
    if (!job) return { ok: false, error: 'Scan is not running' }
    job.stopping = true
    addLog(job.scan, 'warn', 'Stop requested — finishing in-flight requests, counters saved')
    job.dirty = true
    return { ok: true }
  }

  private mark(job: Job) {
    job.dirty = true
  }

  /** Persist a verbatim Gemini response on a chunk (drives the UI raw-output expander).
   *  Bounded: 20KB per entry, max 12 entries per chunk (oldest dropped). */
  private recordChunkOutput(chunk: ChunkState | undefined, model: string, text?: string) {
    if (!chunk || !text) return
    if (!chunk.rawOutputs) chunk.rawOutputs = []
    chunk.rawOutputs.push({
      model,
      t: Date.now(),
      text: text.length > 20_000 ? `${text.slice(0, 20_000)}\n... [truncated]` : text,
    })
    if (chunk.rawOutputs.length > 12) chunk.rawOutputs.splice(0, chunk.rawOutputs.length - 12)
  }

  /** modelStates key: lane 1 uses the plain model id (drives the Model Pool board);
   *  lanes 2-5 keep their own suffixed entries so keys never overwrite each other. */
  private stateKey(lane: KeyLane, m: ModelSpec) {
    return lane.idx === 1 ? m.id : `${m.id}@${lane.idx}`
  }

  private rateKey(lane: KeyLane, m: ModelSpec) {
    return `${lane.idx}|${m.id}`
  }

  private modelState(job: Job, lane: KeyLane, m: ModelSpec) {
    const key = this.stateKey(lane, m)
    const used = getModelUsage(m.id, lane.apiKey)
    if (!job.scan.modelStates[key]) {
      job.scan.modelStates[key] = { state: 'idle', currentChunk: null, cooldownUntil: null, usedToday: used }
    }
    const s = job.scan.modelStates[key]
    s.usedToday = used
    return s
  }

  /** Upload the short video once per key lane (Files API uploads are per key). */
  private async ensureShortUri(job: Job, lane: KeyLane): Promise<string> {
    if (lane.shortUri) return lane.shortUri
    if (!lane.shortUriPromise) {
      lane.shortUriPromise = (async () => {
        addLog(job.scan, 'info', `Uploading short video to Gemini Files API (key ${lane.idx})...`)
        this.mark(job)
        const f = await uploadVideo(lane.ai, path.join(scanMediaDir(job.scan.id), 'short.mp4'))
        lane.shortUri = f.uri
        addLog(job.scan, 'success', `Short video ready on Gemini (key ${lane.idx})`)
        this.mark(job)
        return f.uri
      })().catch((err) => {
        lane.shortUriPromise = null
        throw err
      })
    }
    return lane.shortUriPromise
  }

  private async runScan(job: Job) {
    const { scan } = job

    // One worker per (key lane × model), all pulling from the shared chunk queue.
    const workers: Promise<void>[] = []
    for (const lane of job.lanes) {
      for (const m of MODEL_POOL) workers.push(this.worker(job, lane, m))
    }
    await Promise.all(workers)

    // All work over. Persist final model states.
    for (const lane of job.lanes) {
      for (const m of MODEL_POOL) {
        const s = this.modelState(job, lane, m)
        if (s.state === 'active' || s.state === 'waiting') s.state = 'idle'
        s.currentChunk = null
      }
    }

    if (job.stopping) {
      scan.status = 'stopped'
      addLog(scan, 'warn', 'Scan stopped. Pending chunks saved — use Resume to continue.')
      this.finish(job)
      return
    }

    scan.status = 'done'
    scan.finishedAt = Date.now()
    scan.matches.sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)
    scan.report = {
      totalScanTimeMs: scan.finishedAt - (scan.startedAt || scan.finishedAt),
      chunksScanned: scan.chunks.filter((c) => c.status === 'match' || c.status === 'no_match').length,
      chunksFailed: scan.chunks.filter((c) => c.status === 'failed').length,
      modelsUsed: MODEL_POOL.filter((m) => job.lanes.some((l) => getModelUsage(m.id, l.apiKey) > 0)).map((m) => m.id),
      matches: scan.matches,
    }
    addLog(scan, 'success', `Scan complete: ${scan.matches.length} matched segment(s) across ${scan.chunks.filter((c) => c.status === 'match').length} chunk(s)`)
    cleanupChunks(path.join(scanMediaDir(scan.id), 'chunks'))
    addLog(scan, 'info', 'Temporary chunk files cleaned up')
    this.finish(job)
  }

  private finish(job: Job) {
    if (job.saverTimer) clearInterval(job.saverTimer)
    saveScan(job.scan)
    this.jobs.delete(job.scan.id)
  }

  /** Merge a chunk's parsed matches into the scan-level list (replace this chunk's old entries). */
  private mergeMatches(scan: Scan, chunkIndex: number, matches: ChunkMatch[]) {
    scan.matches = (scan.matches || []).filter((m) => m.chunkIndex !== chunkIndex)
    scan.matches.push(...matches)
    scan.matches.sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)
  }

  /** Worker: one per (key lane × model). Pulls chunks from the shared queue until drained. */
  private async worker(job: Job, lane: KeyLane, m: ModelSpec) {
    const { scan } = job

    while (true) {
      if (job.stopping) return
      const st = this.modelState(job, lane, m)

      // RPD check — never send request N+1 past the daily cap.
      if (getModelUsage(m.id, lane.apiKey) >= m.rpd) {
        if (st.state !== 'exhausted') {
          st.state = 'exhausted'
          st.currentChunk = null
          addLog(scan, 'warn', `${m.id} (key ${lane.idx}) exhausted for today (${m.rpd}/${m.rpd} RPD) — removed from pool`)
          this.mark(job)
        }
        return
      }

      // Cooldown check (RPM/TPM-type 429).
      const cool = job.cooldownUntil[this.rateKey(lane, m)] || 0
      if (cool > Date.now()) {
        st.state = 'cooling'
        st.cooldownUntil = cool
        st.currentChunk = null
        this.mark(job)
        await sleep(Math.min(2000, cool - Date.now()))
        continue
      }
      st.cooldownUntil = null

      // Pull next chunk. When the queue is empty but other workers are still
      // in flight, wait — a failed chunk may be re-queued for retry.
      const chunkIndex = job.queue.shift()
      if (chunkIndex === undefined) {
        if (job.inFlight.size === 0) {
          if (st.state !== 'idle') {
            st.state = 'idle'
            st.currentChunk = null
            this.mark(job)
          }
          return
        }
        st.state = 'waiting'
        st.currentChunk = null
        await sleep(1000)
        continue
      }

      const chunk = scan.chunks[chunkIndex]
      if (!chunk || chunk.status !== 'pending') continue
      job.inFlight.add(chunkIndex)
      chunk.status = 'scanning'
      chunk.model = m.id
      st.state = 'active'
      st.currentChunk = chunkIndex
      this.mark(job)

      let chunkFileName: string | null = null
      try {
        // Per-model pacing (TPM ≈ 1 request/min per model per key).
        const rk = this.rateKey(lane, m)
        const wait = (job.lastRequestAt[rk] || 0) + MODEL_MIN_INTERVAL_MS - Date.now()
        if (wait > 0) {
          st.state = 'waiting'
          this.mark(job)
          await sleep(wait)
          st.state = 'active'
          this.mark(job)
        }

        const shortUri = await this.ensureShortUri(job, lane)

        // Upload THIS chunk for THIS key (Files API uploads are per key).
        const chunkFile = chunkPath(path.join(scanMediaDir(scan.id), 'chunks'), chunkIndex)
        const uploaded = await uploadVideo(lane.ai, chunkFile)
        chunkFileName = uploaded.name

        job.lastRequestAt[rk] = Date.now()
        const used = incrementModelUsage(m.id, lane.apiKey)
        st.usedToday = used
        this.mark(job)

        addLog(scan, 'info', `Chunk ${chunkIndex}: mapping short → movie minute ${chunkIndex} on ${m.id} (key ${lane.idx})`)
        const raw = await mapChunkRequest(lane.ai, m.id, shortUri, uploaded.uri)
        this.recordChunkOutput(chunk, m.id, raw)

        const matches = parseChunkMatches(raw, chunkIndex, chunkIndex * CHUNK_SECONDS, m.id)
        chunk.matches = matches
        chunk.attempts += 1
        chunk.status = matches.length > 0 ? 'match' : 'no_match'
        this.mergeMatches(scan, chunkIndex, matches)

        if (matches.length > 0) {
          addLog(scan, 'success', `Chunk ${chunkIndex}: ${matches.length} matched segment(s) found`)
        } else {
          addLog(scan, 'info', `Chunk ${chunkIndex}: no segments found in this minute`)
        }
        this.mark(job)
      } catch (err) {
        const e = err instanceof GeminiError ? err : classifyError(err)
        chunk.attempts += 1
        if (e.kind === 'rpd' || e.kind === 'unavailable') {
          setModelExhausted(m.id, lane.apiKey, m.rpd)
        } else if (e.kind === 'rate') {
          job.cooldownUntil[this.rateKey(lane, m)] = Date.now() + RATE_COOLDOWN_MS
        }
        if (chunk.attempts >= MAX_CHUNK_ATTEMPTS) {
          chunk.status = 'failed'
          addLog(scan, 'error', `Chunk ${chunkIndex} failed after ${chunk.attempts} attempt(s): ${e.message.slice(0, 140)}`)
        } else {
          chunk.status = 'pending'
          job.queue.push(chunkIndex)
          addLog(scan, 'warn', `Chunk ${chunkIndex} attempt ${chunk.attempts} failed on ${m.id} (key ${lane.idx}) — re-queued: ${e.message.slice(0, 120)}`)
        }
        this.mark(job)
      } finally {
        // The short video is reused across chunks; the chunk upload is one-shot.
        if (chunkFileName) void deleteFileQuiet(lane.ai, chunkFileName)
        job.inFlight.delete(chunkIndex)
        st.currentChunk = null
        if (st.state === 'active') st.state = 'idle'
        this.mark(job)
      }
    }
  }
}

const globalForScheduler = globalThis as unknown as { __cmtScheduler?: Scheduler }
export const scheduler = globalForScheduler.__cmtScheduler || (globalForScheduler.__cmtScheduler = new Scheduler())
