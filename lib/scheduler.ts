import path from 'node:path'
import fs from 'node:fs'
import type { GoogleGenAI } from '@google/genai'
import type { Scan, ChunkState, ChunkMatch, CandidateGroup } from './types'
import { MODEL_POOL, MODEL_MIN_INTERVAL_MS, RATE_COOLDOWN_MS, CHUNK_SECONDS, pacingIntervalMs, type ModelSpec } from './models'
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
import { chunkPath, cleanupChunks, cleanupClips, extractClipPrecise } from './ffmpeg'
import {
  getClient,
  uploadVideo,
  deleteFileQuiet,
  mapChunkRequest,
  parseChunkMatches,
  verifyRequest,
  rescanRequest,
  parseVerdict,
  parseRescanMatch,
  GeminiError,
  classifyError,
} from './gemini'

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
  /** verification phase: candidate-group queue (indexes into scan.candidateGroups) */
  verifyQueue: number[]
  verifyInFlight: Set<number>
  stopping: boolean
  /** pacing state keyed by `${laneIdx}|${modelId}`: earliest time the next request may be sent.
   *  Set after every request from its actual token size so every model runs at full TPM capacity. */
  nextFreeAt: Record<string, number>
  cooldownUntil: Record<string, number>
  dirty: boolean
  saverTimer: ReturnType<typeof setInterval> | null
}

/** Max attempts (non-rate errors) per candidate group before it is kept as unverified. */
const MAX_GROUP_ATTEMPTS = 4

/** Format seconds as mm:ss.mmm for logs. */
function ts(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`
}

/** Two short-video ranges are "the same segment" when they overlap ≥50% of the shorter one. */
function sameShortSegment(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart)
  if (overlap <= 0) return false
  const shorter = Math.min(aEnd - aStart, bEnd - bStart)
  return shorter <= 0 ? false : overlap / shorter >= 0.5
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

    // Verification-only resume: all chunks already mapped but candidate groups
    // still have pending verifier/rescan work (or matches were never verified).
    const hasVerifyWork =
      (scan.candidateGroups || []).some((g) => g.status === 'pending' || g.status === 'verifying' || g.status === 'rescanning') ||
      (!scan.candidateGroups?.length && (scan.matches || []).length > 0 && scan.chunks.every((c) => c.status !== 'pending' && c.status !== 'scanning'))

    if (queue.length === 0 && !hasVerifyWork) return { ok: false, error: 'No pending chunks to scan.' }

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
      verifyQueue: [],
      verifyInFlight: new Set(),
      stopping: false,
      nextFreeAt: {},
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

    // ---------- PHASE 2: candidate verification (24 fps verifier + rescan) ----------
    await this.runVerification(job)

    if (job.stopping) {
      scan.status = 'stopped'
      addLog(scan, 'warn', 'Scan stopped during verification. Progress saved — use Resume to continue.')
      this.finish(job)
      return
    }

    const groups = scan.candidateGroups || []

    // Quota ran out mid-verification: keep the scan resumable instead of finishing.
    const leftover = groups.filter((g) => g.status === 'pending' || g.status === 'verifying' || g.status === 'rescanning')
    if (leftover.length > 0) {
      scan.status = 'stopped'
      addLog(scan, 'warn', `Verification paused: ${leftover.length} group(s) still pending (daily quota exhausted?). Use Resume to continue.`)
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
      groupsTotal: groups.length,
      groupsConfirmed: groups.filter((g) => g.status === 'confirmed').length,
      groupsRejected: groups.filter((g) => g.status === 'rejected').length,
      groupsUnverified: groups.filter((g) => g.status === 'unverified').length,
    }
    addLog(scan, 'success', `Scan complete: ${scan.matches.length} matched segment(s) across ${scan.chunks.filter((c) => c.status === 'match').length} chunk(s)`)
    cleanupChunks(path.join(scanMediaDir(scan.id), 'chunks'))
    cleanupClips(path.join(scanMediaDir(scan.id), 'clips'))
    addLog(scan, 'info', 'Temporary chunk files cleaned up')
    this.finish(job)
  }

  // ---------- Candidate + Verifier pipeline ----------

  /** Group all chunk-phase matches by short segment: two matches that claim the
   *  same short-video segment (≥50% overlap) become candidates of ONE group.
   *  Candidates are unlimited — every distinct movie window is saved. */
  private buildCandidateGroups(scan: Scan) {
    if (scan.candidateGroups?.length) return
    const groups: CandidateGroup[] = []
    const sorted = [...(scan.matches || [])].sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)
    for (const m of sorted) {
      let g = groups.find((x) => sameShortSegment(x.shortStart, x.shortEnd, m.shortStart, m.shortEnd))
      if (!g) {
        g = {
          id: `g${groups.length}-${Math.random().toString(36).slice(2, 8)}`,
          shortStart: m.shortStart,
          shortEnd: m.shortEnd,
          status: 'pending',
          candidates: [],
          confirmedIndex: null,
          confirmedViaRescan: false,
          attempts: 0,
        }
        groups.push(g)
      }
      // De-dupe near-identical movie windows (within 0.5s both ends).
      const dup = g.candidates.some(
        (c) => Math.abs(c.movieStart - m.movieStart) < 0.5 && Math.abs(c.movieEnd - m.movieEnd) < 0.5,
      )
      if (!dup) {
        g.candidates.push({
          movieStart: m.movieStart,
          movieEnd: m.movieEnd,
          chunkIndex: m.chunkIndex,
          model: m.model,
          verdict: 'pending',
          rescan: 'none',
        })
      }
    }
    scan.candidateGroups = groups
  }

  /** Verification phase: every (key lane × model) worker pulls candidate groups
   *  from a shared queue so ALL API keys verify in parallel — no key sits idle. */
  private async runVerification(job: Job) {
    const { scan } = job
    this.buildCandidateGroups(scan)
    const groups = scan.candidateGroups || []

    // Reset transient states from an interrupted run.
    for (const g of groups) {
      if (g.status === 'verifying' || g.status === 'rescanning') g.status = 'pending'
      for (const c of g.candidates) {
        if (c.verdict === 'verifying') c.verdict = 'pending'
        if (c.rescan === 'rescanning') c.rescan = 'pending'
        if (c.rescanVerdict === 'verifying') c.rescanVerdict = 'pending'
      }
    }

    job.verifyQueue = groups.map((_, i) => i).filter((i) => groups[i].status === 'pending')
    if (job.verifyQueue.length === 0) return

    scan.status = 'verifying'
    addLog(
      scan,
      'info',
      `Verification phase: ${job.verifyQueue.length} candidate group(s) queued — verifier clips at 24 fps, distributed across ${job.lanes.length} API key(s) × ${MODEL_POOL.length} models`,
    )
    this.mark(job)

    const workers: Promise<void>[] = []
    for (const lane of job.lanes) {
      for (const m of MODEL_POOL) workers.push(this.verifyWorker(job, lane, m))
    }
    await Promise.all(workers)

    for (const lane of job.lanes) {
      for (const m of MODEL_POOL) {
        const s = this.modelState(job, lane, m)
        if (s.state === 'active' || s.state === 'waiting') s.state = 'idle'
        s.currentChunk = null
      }
    }
    this.mark(job)
  }

  /** One verifier worker per (key lane × model) — pulls whole groups off the queue. */
  private async verifyWorker(job: Job, lane: KeyLane, m: ModelSpec) {
    const { scan } = job
    while (true) {
      if (job.stopping) return
      const st = this.modelState(job, lane, m)

      if (getModelUsage(m.id, lane.apiKey) >= m.rpd) {
        if (st.state !== 'exhausted') {
          st.state = 'exhausted'
          st.currentChunk = null
          this.mark(job)
        }
        return
      }

      const cool = job.cooldownUntil[this.rateKey(lane, m)] || 0
      if (cool > Date.now()) {
        st.state = 'cooling'
        st.cooldownUntil = cool
        this.mark(job)
        await sleep(Math.min(2000, cool - Date.now()))
        continue
      }
      st.cooldownUntil = null

      const gi = job.verifyQueue.shift()
      if (gi === undefined) {
        if (job.verifyInFlight.size === 0) {
          if (st.state !== 'idle') {
            st.state = 'idle'
            this.mark(job)
          }
          return
        }
        st.state = 'waiting'
        await sleep(1000)
        continue
      }

      const g = (scan.candidateGroups || [])[gi]
      if (!g || (g.status !== 'pending' && g.status !== 'verifying' && g.status !== 'rescanning')) continue
      job.verifyInFlight.add(gi)
      st.state = 'active'
      this.mark(job)

      try {
        await this.processGroup(job, lane, m, g)
      } catch (err) {
        const e = err instanceof GeminiError ? err : classifyError(err)
        if (e.kind === 'rpd' || e.kind === 'unavailable') {
          setModelExhausted(m.id, lane.apiKey, m.rpd)
          job.verifyQueue.push(gi) // another (key × model) worker retries the same work
          addLog(scan, 'warn', `Verifier: ${m.id} (key ${lane.idx}) exhausted — group ${g.id} re-queued for another worker`)
        } else if (e.kind === 'rate') {
          job.cooldownUntil[this.rateKey(lane, m)] = Date.now() + RATE_COOLDOWN_MS
          job.verifyQueue.push(gi)
          addLog(scan, 'warn', `Verifier: rate limit on ${m.id} (key ${lane.idx}) — group ${g.id} re-queued`)
        } else {
          g.attempts += 1
          if (g.attempts >= MAX_GROUP_ATTEMPTS) {
            g.status = 'unverified'
            this.applyGroupResult(job, g)
            addLog(scan, 'error', `Group ${g.id} (short ${ts(g.shortStart)}–${ts(g.shortEnd)}) could not be verified after ${g.attempts} attempts — original match kept, flagged unverified: ${e.message.slice(0, 120)}`)
          } else {
            job.verifyQueue.push(gi)
            addLog(scan, 'warn', `Verifier attempt ${g.attempts} failed for group ${g.id} on ${m.id} (key ${lane.idx}) — re-queued: ${e.message.slice(0, 120)}`)
          }
        }
        this.mark(job)
      } finally {
        job.verifyInFlight.delete(gi)
        if (st.state === 'active') st.state = 'idle'
        this.mark(job)
      }
    }
  }

  /** Pace + count one verifier/rescan request on this (key × model) lane.
   *  Pacing is sized from the ACTUAL video seconds so small verify clips only
   *  wait seconds while full 1-minute rescans wait the whole minute — full TPM capacity. */
  private async paceAndSend<T>(job: Job, lane: KeyLane, m: ModelSpec, videoSeconds: number, fn: () => Promise<T>): Promise<T> {
    if (getModelUsage(m.id, lane.apiKey) >= m.rpd) throw new GeminiError('rpd', `${m.id} daily cap reached`)
    const rk = this.rateKey(lane, m)
    const st = this.modelState(job, lane, m)
    const wait = (job.nextFreeAt[rk] || 0) - Date.now()
    if (wait > 0) {
      st.state = 'waiting'
      this.mark(job)
      await sleep(wait)
    }
    st.state = 'active'
    job.nextFreeAt[rk] = Date.now() + pacingIntervalMs(videoSeconds)
    st.usedToday = incrementModelUsage(m.id, lane.apiKey)
    this.mark(job)
    return fn()
  }

  /** Full verify → rescan → re-verify pipeline for ONE candidate group.
   *  All clips are cut with millisecond precision and sent to Gemini at 24 fps. */
  private async processGroup(job: Job, lane: KeyLane, m: ModelSpec, g: CandidateGroup) {
    const { scan } = job
    const mediaDir = scanMediaDir(scan.id)
    const clipsDir = path.join(mediaDir, 'clips')
    if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true })
    const shortDur = Math.max(1, g.shortEnd - g.shortStart)

    g.status = 'verifying'
    this.mark(job)

    // Cut + upload the short-video segment ONCE for this group (per-key upload).
    const shortClipFile = path.join(clipsDir, `${g.id}-short.mp4`)
    await extractClipPrecise(path.join(mediaDir, 'short.mp4'), g.shortStart, g.shortEnd, shortClipFile)
    const shortClip = await uploadVideo(lane.ai, shortClipFile)
    const uploadedNames: string[] = [shortClip.name]

    try {
      // ----- STEP 1: verify each candidate's exact movie window -----
      for (let i = 0; i < g.candidates.length; i++) {
        if (job.stopping) return
        const c = g.candidates[i]
        if (c.verdict === 'same' || c.verdict === 'different') continue
        c.verdict = 'verifying'
        this.mark(job)

        const movieClipFile = path.join(clipsDir, `${g.id}-c${i}-movie.mp4`)
        await extractClipPrecise(path.join(mediaDir, 'movie.mp4'), c.movieStart, c.movieEnd, movieClipFile)
        const movieClip = await uploadVideo(lane.ai, movieClipFile)
        uploadedNames.push(movieClip.name)

        addLog(scan, 'info', `Verify: short ${ts(g.shortStart)}–${ts(g.shortEnd)} vs movie ${ts(c.movieStart)}–${ts(c.movieEnd)} on ${m.id} (key ${lane.idx})`)
        const clipSecs = shortDur + Math.max(1, c.movieEnd - c.movieStart)
        const raw = await this.paceAndSend(job, lane, m, clipSecs, () => verifyRequest(lane.ai, m.id, shortClip.uri, movieClip.uri))
        const v = parseVerdict(raw)
        if (!v) throw new GeminiError('other', 'Verifier gave no clear VERDICT line')

        c.verifierModel = m.id
        c.verifierReason = v.reason
        c.verdict = v.same ? 'same' : 'different'
        this.mark(job)

        if (v.same) {
          g.status = 'confirmed'
          g.confirmedIndex = i
          g.confirmedViaRescan = false
          this.applyGroupResult(job, g)
          addLog(scan, 'success', `CONFIRMED: short ${ts(g.shortStart)}–${ts(g.shortEnd)} = movie ${ts(c.movieStart)}–${ts(c.movieEnd)} (verifier: ${m.id})`)
          return
        }
        addLog(scan, 'warn', `Verifier says DIFFERENT for movie ${ts(c.movieStart)}–${ts(c.movieEnd)}${g.candidates.length > i + 1 ? ' — checking next candidate' : ''}`)
      }

      // ----- STEP 2: all candidates failed → rescan each candidate's full 1-minute chunk -----
      g.status = 'rescanning'
      this.mark(job)
      addLog(scan, 'warn', `All ${g.candidates.length} candidate(s) rejected for short ${ts(g.shortStart)}–${ts(g.shortEnd)} — rescanning their full chunks`)

      for (let i = 0; i < g.candidates.length; i++) {
        if (job.stopping) return
        const c = g.candidates[i]
        if (c.rescan === 'not_found' || c.rescanVerdict === 'different') continue

        // 2a. Rescan the full 1-minute chunk with the special segment-hunt prompt.
        if (c.rescan !== 'found') {
          c.rescan = 'rescanning'
          this.mark(job)
          const chunkStart = c.chunkIndex * CHUNK_SECONDS
          const chunkEnd = Math.min(chunkStart + CHUNK_SECONDS, scan.movieDuration || chunkStart + CHUNK_SECONDS)

          // Reuse the original chunk file if it still exists, else cut it fresh from the movie.
          let chunkFile = chunkPath(path.join(mediaDir, 'chunks'), c.chunkIndex)
          if (!fs.existsSync(chunkFile)) {
            chunkFile = path.join(clipsDir, `${g.id}-c${i}-chunk.mp4`)
            await extractClipPrecise(path.join(mediaDir, 'movie.mp4'), chunkStart, chunkEnd, chunkFile)
          }
          const chunkUp = await uploadVideo(lane.ai, chunkFile)
          uploadedNames.push(chunkUp.name)

          addLog(scan, 'info', `Rescan: hunting short ${ts(g.shortStart)}–${ts(g.shortEnd)} inside full chunk ${c.chunkIndex} on ${m.id} (key ${lane.idx})`)
          const raw = await this.paceAndSend(job, lane, m, shortDur + (chunkEnd - chunkStart), () => rescanRequest(lane.ai, m.id, shortClip.uri, chunkUp.uri))
          const found = parseRescanMatch(raw)
          if (!found) {
            c.rescan = 'not_found'
            this.mark(job)
            addLog(scan, 'info', `Rescan of chunk ${c.chunkIndex}: NOT FOUND`)
            continue
          }
          c.rescan = 'found'
          c.rescanMovieStart = chunkStart + found.start
          c.rescanMovieEnd = chunkStart + found.end
          this.mark(job)
        }

        // 2b. Verify the freshly found rescan window — this verdict is FINAL.
        c.rescanVerdict = 'verifying'
        this.mark(job)
        const reFile = path.join(clipsDir, `${g.id}-c${i}-rescan.mp4`)
        await extractClipPrecise(path.join(mediaDir, 'movie.mp4'), c.rescanMovieStart!, c.rescanMovieEnd!, reFile)
        const reUp = await uploadVideo(lane.ai, reFile)
        uploadedNames.push(reUp.name)

        addLog(scan, 'info', `Re-verify rescan window movie ${ts(c.rescanMovieStart!)}–${ts(c.rescanMovieEnd!)} on ${m.id} (key ${lane.idx})`)
        const reSecs = shortDur + Math.max(1, c.rescanMovieEnd! - c.rescanMovieStart!)
        const raw2 = await this.paceAndSend(job, lane, m, reSecs, () => verifyRequest(lane.ai, m.id, shortClip.uri, reUp.uri))
        const v2 = parseVerdict(raw2)
        if (!v2) throw new GeminiError('other', 'Verifier gave no clear VERDICT line (rescan window)')

        c.rescanReason = v2.reason
        c.rescanVerdict = v2.same ? 'same' : 'different'
        this.mark(job)

        if (v2.same) {
          g.status = 'confirmed'
          g.confirmedIndex = i
          g.confirmedViaRescan = true
          this.applyGroupResult(job, g)
          addLog(scan, 'success', `CONFIRMED via rescan: short ${ts(g.shortStart)}–${ts(g.shortEnd)} = movie ${ts(c.rescanMovieStart!)}–${ts(c.rescanMovieEnd!)}`)
          return
        }
        addLog(scan, 'warn', `Rescan window rejected by verifier — final DIFFERENT for candidate ${i} (chunk ${c.chunkIndex})`)
      }

      // ----- STEP 3: everything failed — FINAL decision: not a match -----
      g.status = 'rejected'
      this.applyGroupResult(job, g)
      addLog(scan, 'error', `REJECTED (final): short ${ts(g.shortStart)}–${ts(g.shortEnd)} — every candidate and rescan failed verification, removed from matches`)
      this.mark(job)
    } finally {
      for (const n of uploadedNames) void deleteFileQuiet(lane.ai, n)
      try {
        for (const f of fs.readdirSync(clipsDir)) {
          if (f.startsWith(g.id)) fs.unlinkSync(path.join(clipsDir, f))
        }
      } catch {
        /* ignore */
      }
    }
  }

  /** Rewrite scan.matches for a finished group:
   *  confirmed → ONE verified match (rescan window when confirmedViaRescan),
   *  rejected → all this group's matches removed,
   *  unverified → original candidate windows kept, flagged verified=false. */
  private applyGroupResult(job: Job, g: CandidateGroup) {
    const { scan } = job
    scan.matches = (scan.matches || []).filter((m) => !sameShortSegment(g.shortStart, g.shortEnd, m.shortStart, m.shortEnd))
    if (g.status === 'confirmed' && g.confirmedIndex !== null) {
      const c = g.candidates[g.confirmedIndex]
      scan.matches.push({
        shortStart: g.shortStart,
        shortEnd: g.shortEnd,
        movieStart: g.confirmedViaRescan ? c.rescanMovieStart! : c.movieStart,
        movieEnd: g.confirmedViaRescan ? c.rescanMovieEnd! : c.movieEnd,
        chunkIndex: c.chunkIndex,
        model: c.model,
        verified: true,
        viaRescan: g.confirmedViaRescan || undefined,
      })
    } else if (g.status === 'unverified') {
      for (const c of g.candidates) {
        scan.matches.push({
          shortStart: g.shortStart,
          shortEnd: g.shortEnd,
          movieStart: c.movieStart,
          movieEnd: c.movieEnd,
          chunkIndex: c.chunkIndex,
          model: c.model,
          verified: false,
        })
      }
    }
    scan.matches.sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)
    this.mark(job)
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
        const wait = (job.nextFreeAt[rk] || 0) - Date.now()
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

        job.nextFreeAt[rk] = Date.now() + MODEL_MIN_INTERVAL_MS
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
