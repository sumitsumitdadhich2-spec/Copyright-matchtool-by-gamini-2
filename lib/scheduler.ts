import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import type { GoogleGenAI } from '@google/genai'
import type { Scan, Candidate, MatchRegion, SegmentMatch, ShortSegment } from './types'
import {
  MODEL_POOL,
  MODEL_MIN_INTERVAL_MS,
  RATE_COOLDOWN_MS,
  CONFIDENCE_THRESHOLD,
  CHUNK_SECONDS,
  SEGMENT_FPS,
  type ModelSpec,
} from './models'
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
import { chunkPath, extractSegment, cleanupChunks } from './ffmpeg'
import {
  getClient,
  uploadVideo,
  deleteFileQuiet,
  scanChunkRequest,
  segmentShortRequest,
  segmentsToPromptText,
  singleSegmentPromptText,
  verifyRequest,
  liveVerifyRequest,
  rescanSegmentRequest,
  parseSegment,
  enforceSegmentDurations,
  GeminiError,
  type RescanHistory,
} from './gemini'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One API key lane (1-5). Lane 1 = Main Scanner key; lanes 2+ are parallel workers
 *  that prefer verification work but pick up scan chunks whenever they are free.
 *  Gemini Files API uploads are PER KEY, so each lane keeps its own short-video URI. */
interface KeyLane {
  idx: number
  apiKey: string
  ai: GoogleGenAI
  shortUri: string | null
  /** in-flight upload lock so two workers never double-upload the short video */
  shortUriPromise: Promise<string> | null
}

/** A queued verification job for ONE short-video segment. */
interface VerifyTask {
  kind: 'verify' | 'rescan'
  segmentIndex: number
  /** rescan tasks target ONE specific candidate chunk (confidence-ordered hunt) */
  chunkIndex?: number
}

interface Job {
  scan: Scan
  lanes: KeyLane[]
  /** scan-phase chunk queue */
  queue: number[]
  inFlight: Set<number>
  /** live verification task queue (verify @24fps / rescan @24fps) */
  verifyQueue: VerifyTask[]
  /** in-flight task keys (`v:{seg}` / `r:{seg}:{chunk}`) — a verify and a rescan for the
   *  SAME segment may run in parallel on different keys during the rescan phase */
  verifyInFlight: Set<string>
  /** transient error counter per segment so a flaky segment can't loop forever */
  verifyErrors: Record<number, number>
  /** true once the INITIAL chunk-scan phase fully finished — verification never starts
   *  before this: both keys scan all chunks first, then both keys verify */
  initialScanDone: boolean
  stopping: boolean
  segmentsText: string | null
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

    // Rebuild the verification queue from persisted per-segment states (resume-safe).
    const verifyQueue: VerifyTask[] = []
    for (const sm of scan.segmentMatches || []) {
      const v = sm.verification
      if (!v) continue
      if (v.state === 'verifying') v.state = 'pending'
      if (v.state === 'pending') verifyQueue.push({ kind: 'verify', segmentIndex: sm.segmentIndex })
      else if (v.state === 'rescanning') {
        const chunk =
          sm.rescanChunkQueue && sm.rescanChunkQueue.length > 0 ? sm.rescanChunkQueue.shift()! : sm.chunkIndex
        verifyQueue.push({ kind: 'rescan', segmentIndex: sm.segmentIndex, chunkIndex: chunk })
      }
    }

    if (queue.length === 0 && verifyQueue.length === 0 && scan.status !== 'stopped') {
      return { ok: false, error: 'No pending chunks to scan.' }
    }

    scan.status = 'scanning'
    scan.error = null
    if (!scan.startedAt) scan.startedAt = Date.now()

    // One lane per configured key (1-5, already de-duplicated). Work is shared across
    // ALL lanes: every key scans chunks first, then every key runs verification.
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
        ? `Resuming: ${queue.length} chunk(s) + ${verifyQueue.length} verification(s) pending`
        : `Scan started: ${queue.length} chunks queued across ${MODEL_POOL.length} models × ${lanes.length} API key(s)`,
    )
    if (lanes.length > 1)
      addLog(
        scan,
        'info',
        `${lanes.length} API keys active — ALL keys scan chunks in parallel first, then ALL keys run 24fps verification in confidence order`,
      )
    else addLog(scan, 'warn', 'Only 1 API key set — it will scan all chunks first, then handle 24fps verification. Add more keys (up to 5) for parallel speed.')

    const job: Job = {
      scan,
      lanes,
      queue,
      inFlight: new Set(),
      verifyQueue,
      verifyInFlight: new Set(),
      verifyErrors: {},
      // On resume with no pending chunks, the initial scan already finished.
      initialScanDone: queue.length === 0,
      stopping: false,
      segmentsText: null,
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

    // Upload the short video for lane 1 up front (segmentation + scans reuse it).
    await this.ensureShortUri(job, job.lanes[0])

    // Phase 1: one-time segmentation pass. Reuses saved segments on resume.
    if (scan.shortSegments && scan.shortSegments.length > 0) {
      job.segmentsText = segmentsToPromptText(scan.shortSegments)
      addLog(scan, 'info', `Reusing ${scan.shortSegments.length} saved segment(s) from previous run`)
    } else {
      await this.segmentShort(job)
    }
    this.mark(job)

    // One worker per (key lane × model), all pulling from the shared queues in parallel.
    // Lane 1 prefers scan chunks, lanes 2-5 prefer verifications — whichever is free
    // picks up whatever work is left, so no key ever sits idle.
    const workers: Promise<void>[] = []
    for (const lane of job.lanes) {
      for (const m of MODEL_POOL) workers.push(this.worker(job, lane, m))
    }
    await Promise.all(workers)

    // All phases over. Persist final model states.
    for (const lane of job.lanes) {
      for (const m of MODEL_POOL) {
        const s = this.modelState(job, lane, m)
        if (s.state === 'active' || s.state === 'waiting') s.state = 'idle'
        s.currentChunk = null
      }
    }

    if (job.stopping) {
      scan.status = 'stopped'
      addLog(scan, 'warn', 'Scan stopped. Pending chunks/verifications saved — use Resume to continue.')
      this.finish(job)
      return
    }

    // Build merged regions from the (now live-verified) segment map.
    await this.verificationPass(job)

    const sms = scan.segmentMatches || []
    const confirmed = sms.filter((s) => s.verification?.state === 'confirmed').length
    const rejected = sms.filter((s) => s.verification?.state === 'rejected_final').length
    const pendingV = sms.filter((s) => s.verification && !['confirmed', 'rejected_final'].includes(s.verification.state)).length

    scan.status = 'done'
    scan.finishedAt = Date.now()
    scan.report = {
      totalScanTimeMs: scan.finishedAt - (scan.startedAt || scan.finishedAt),
      chunksScanned: scan.chunks.filter((c) => c.status === 'match' || c.status === 'no_match').length,
      chunksFailed: scan.chunks.filter((c) => c.status === 'failed').length,
      modelsUsed: MODEL_POOL.filter((m) => job.lanes.some((l) => getModelUsage(m.id, l.apiKey) > 0)).map((m) => m.id),
      regions: scan.regions,
      segmentMatches: sms,
    }
    if (sms.length > 0) {
      addLog(scan, 'success', `Verification summary: ${confirmed} confirmed · ${rejected} rejected · ${pendingV} pending`)
    }
    addLog(scan, 'success', `Scan complete: ${scan.regions.filter((r) => r.selected).length} final match region(s)`)
    cleanupChunks(path.join(scanMediaDir(scan.id), 'chunks'))
    addLog(scan, 'info', 'Temporary chunk files cleaned up')
    this.finish(job)
  }

  /** Phase 1: send the whole short video at 24 fps → movie guess + millisecond scene segments. */
  private async segmentShort(job: Job) {
    const { scan } = job
    const lane = job.lanes[0]
    addLog(scan, 'info', `Segmentation pass: analyzing short video at ${SEGMENT_FPS} fps (movie ID + scene changes)...`)
    this.mark(job)
    const tried = new Set<string>()
    for (let attempt = 0; attempt < 4; attempt++) {
      // Rotate models between attempts — a model that returned broken JSON once
      // will usually return the same broken JSON again at temperature 0.
      const model = this.pickFreeModel(job, lane, tried)
      if (!model) break
      tried.add(model.id)
      try {
        const rk = this.rateKey(lane, model)
        const wait = (job.lastRequestAt[rk] || 0) + MODEL_MIN_INTERVAL_MS - Date.now()
        if (wait > 0) await sleep(wait)
        job.lastRequestAt[rk] = Date.now()
        const used = incrementModelUsage(model.id, lane.apiKey)
        this.modelState(job, lane, model).usedToday = used
        this.mark(job)
        const result = await segmentShortRequest(lane.ai, model.id, lane.shortUri!)
        scan.movieGuess = result.movieGuess
        scan.shortSegments = result.segments
        job.segmentsText = segmentsToPromptText(result.segments)
        addLog(scan, 'success', `Movie identified: "${result.movieGuess}" — ${result.segments.length} scene segment(s) detected`)
        for (const s of result.segments) {
          addLog(scan, 'info', `  S${s.index}: ${s.start.toFixed(3)}s-${s.end.toFixed(3)}s — ${s.description.slice(0, 80)}`)
        }
        this.mark(job)
        return
      } catch (err) {
        const e = err instanceof GeminiError ? err : new GeminiError('other', err instanceof Error ? err.message : String(err))
        if (e.kind === 'rpd' || e.kind === 'unavailable') setModelExhausted(model.id, lane.apiKey, model.rpd)
        else if (e.kind === 'rate') job.cooldownUntil[this.rateKey(lane, model)] = Date.now() + RATE_COOLDOWN_MS
        addLog(scan, 'warn', `Segmentation attempt ${attempt + 1}/4 failed on ${model.id}: ${e.message.slice(0, 120)}`)
        this.mark(job)
      }
    }
    addLog(scan, 'warn', 'Segmentation pass failed — continuing scan without segment data')
    this.mark(job)
  }

  private finish(job: Job) {
    if (job.saverTimer) clearInterval(job.saverTimer)
    saveScan(job.scan)
    this.jobs.delete(job.scan.id)
  }

  /** Stable key for a task — a verify and a rescan of the same segment are DIFFERENT tasks
   *  (they may run in parallel on the two keys during the rescan phase). */
  private taskKey(t: VerifyTask): string {
    return t.kind === 'verify' ? `v:${t.segmentIndex}` : `r:${t.segmentIndex}:${t.chunkIndex ?? -1}`
  }

  /** Queue a segment for live 24fps verification (idempotent — never double-queues). */
  private enqueueVerify(job: Job, segmentIndex: number, kind: VerifyTask['kind'] = 'verify', chunkIndex?: number) {
    const t: VerifyTask = { kind, segmentIndex, ...(chunkIndex !== undefined ? { chunkIndex } : {}) }
    const key = this.taskKey(t)
    if (job.verifyInFlight.has(key)) return
    if (job.verifyQueue.some((q) => this.taskKey(q) === key)) return
    job.verifyQueue.push(t)
  }

  /** CONFIDENCE-ORDERED dequeue: the candidate with the highest scan confidence is
   *  verified FIRST. Verify tasks outrank rescan tasks so a freshly-found window is
   *  checked immediately while the next rescan runs in parallel. */
  private dequeueVerify(job: Job): VerifyTask | null {
    const conf = (t: VerifyTask) =>
      (job.scan.segmentMatches || []).find((s) => s.segmentIndex === t.segmentIndex)?.confidence ?? 0
    job.verifyQueue.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'verify' ? -1 : 1
      return conf(b) - conf(a)
    })
    return job.verifyQueue.shift() || null
  }

  /** Is a rescan for this segment still queued or in flight? */
  private hasRescanWork(job: Job, segmentIndex: number): boolean {
    if (job.verifyQueue.some((t) => t.kind === 'rescan' && t.segmentIndex === segmentIndex)) return true
    for (const k of job.verifyInFlight) if (k.startsWith(`r:${segmentIndex}:`)) return true
    return false
  }

  /** True when the scan phase is fully finished (no chunks queued or in flight). */
  private scanPhaseDone(job: Job) {
    return job.queue.length === 0 && job.inFlight.size === 0
  }

  /** Unified worker: one per (key lane × model). Picks work by lane priority —
   *  lane 1: scan chunks first, then verifications; lanes 2-5: verifications first,
   *  then scan chunks. Exits only when BOTH queues are fully drained. */
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

      // ----- Phase gate: BOTH keys finish ALL chunk scans first, THEN verification starts.
      // (Chunks re-queued later — rescan-phase requeues — run in parallel with verification.)
      if (!job.initialScanDone && this.scanPhaseDone(job)) {
        job.initialScanDone = true
        if (job.verifyQueue.length > 0) {
          addLog(
            scan,
            'info',
            `Scan phase complete — starting 24fps verification of ${job.verifyQueue.length} candidate(s) in CONFIDENCE order (both keys)`,
          )
        }
        this.mark(job)
      }

      // ----- Work selection (per-lane priority, free key takes any pending work) -----
      const canScan = job.queue.length > 0
      const canVerify = job.initialScanDone && job.verifyQueue.length > 0
      let verifyTask: VerifyTask | null = null
      let chunkIndex: number | undefined

      if (lane.idx >= 2) {
        if (canVerify) verifyTask = this.dequeueVerify(job)
        else if (canScan) chunkIndex = job.queue.shift()
      } else {
        if (canScan) chunkIndex = job.queue.shift()
        else if (canVerify) verifyTask = this.dequeueVerify(job)
      }

      // ----- Per-chunk segment selection -----
      // Segments locked at conf 100 (or already 24fps-confirmed) are NOT searched again
      // in later chunks. Everything below 100 keeps being searched in EVERY chunk —
      // the real match may live in a later minute. If a locked segment is later rejected
      // by the verifier, chunks that skipped it are re-queued (see onSegmentRejectedFinal).
      let activeSegs: ShortSegment[] | null = null
      let lockedIdx: number[] = []
      if (chunkIndex !== undefined) {
        const segsAll = scan.shortSegments || []
        if (segsAll.length > 0) {
          const locked = this.lockedSegmentIndexes(scan)
          activeSegs = segsAll.filter((s) => !locked.has(s.index))
          lockedIdx = segsAll.filter((s) => locked.has(s.index)).map((s) => s.index)
          if (activeSegs.length === 0) {
            // Nothing left to search in this chunk — every segment is locked.
            const c = scan.chunks[chunkIndex]
            c.status = 'cancelled'
            c.excludedSegments = lockedIdx
            addLog(scan, 'info', `chunk ${chunkIndex} skipped — all segments locked (conf 100 / 24fps-confirmed); will re-queue if the verifier rejects one`)
            this.mark(job)
            continue
          }
        }
      }

      if (verifyTask === null && chunkIndex === undefined) {
        // Nothing to grab right now. Exit only when everything is fully drained.
        if (this.scanPhaseDone(job) && job.verifyQueue.length === 0 && job.verifyInFlight.size === 0) {
          st.state = 'idle'
          st.currentChunk = null
          this.mark(job)
          return
        }
        // Scan chunks done but verifications still running → surface it in the status.
        if (this.scanPhaseDone(job) && scan.status === 'scanning') {
          scan.status = 'verifying'
          this.mark(job)
        }
        st.state = 'waiting'
        this.mark(job)
        await sleep(1500)
        continue
      }

      // Enforce 1 request/minute per (key, model) — TPM is the real limiter.
      const rk = this.rateKey(lane, m)
      const wait = (job.lastRequestAt[rk] || 0) + MODEL_MIN_INTERVAL_MS - Date.now()
      if (wait > 0) {
        st.state = 'waiting'
        st.currentChunk = chunkIndex ?? null
        this.mark(job)
        let remaining = wait
        while (remaining > 0 && !job.stopping) {
          const step = Math.min(1000, remaining)
          await sleep(step)
          remaining -= step
        }
        if (job.stopping) {
          if (chunkIndex !== undefined) job.queue.unshift(chunkIndex)
          if (verifyTask) job.verifyQueue.unshift(verifyTask)
          return
        }
      }

      if (verifyTask) {
        const keepWorker = await this.runVerifyTask(job, lane, m, verifyTask)
        if (!keepWorker) return
        continue
      }

      // ----- Scan one chunk (unchanged core flow) -----
      const idx = chunkIndex!
      const chunk = scan.chunks[idx]
      chunk.status = 'scanning'
      chunk.model = m.id
      chunk.attempts += 1
      st.state = 'active'
      st.currentChunk = idx
      job.inFlight.add(idx)
      job.lastRequestAt[rk] = Date.now()
      const used = incrementModelUsage(m.id, lane.apiKey)
      st.usedToday = used
      addLog(scan, 'info', `chunk ${idx} → ${m.id} (key ${lane.idx}, ${used}/${m.rpd} today)`)
      this.mark(job)

      let uploadedName: string | null = null
      try {
        const shortUri = await this.ensureShortUri(job, lane)
        const chunkFile = chunkPath(path.join(scanMediaDir(scan.id), 'chunks'), idx)
        const uploaded = await uploadVideo(lane.ai, chunkFile)
        uploadedName = uploaded.name
        // Only ask about segments still being searched — locked (conf 100 / confirmed)
        // segments are excluded from this chunk's prompt and recorded for re-queue safety.
        const segText = activeSegs ? segmentsToPromptText(activeSegs) : job.segmentsText || undefined
        if (lockedIdx.length > 0) {
          chunk.excludedSegments = lockedIdx
          addLog(scan, 'info', `chunk ${idx}: searching ${activeSegs!.length} segment(s) — S${lockedIdx.join(', S')} locked (conf 100 / confirmed), excluded`)
        }
        const result = await scanChunkRequest(lane.ai, m.id, shortUri, uploaded.uri, segText, job.scan.movieGuess)

        // Server-side false-positive filter: when segments exist, the model's answer is
        // ONLY trusted if it reported per-segment windows of the segment's EXACT duration.
        const segs = activeSegs || []
        const enforced = segs.length > 0 ? enforceSegmentDurations(result, segs) : null
        if (enforced) {
          for (const d of enforced.dropped) {
            addLog(scan, 'warn', `chunk ${idx}: duration check — ${d.slice(0, 200)}`)
          }
        }
        // STRICT per-segment acceptance: every segment window must individually be >= threshold.
        const validAccepted = enforced ? enforced.valid.filter((v) => v.confidence >= CONFIDENCE_THRESHOLD) : []
        if (enforced) {
          for (const v of enforced.valid) {
            if (v.confidence < CONFIDENCE_THRESHOLD) {
              addLog(scan, 'info', `chunk ${idx}: S${v.segmentIndex} conf ${v.confidence} < ${CONFIDENCE_THRESHOLD} — rejected (strict threshold)`)
            }
          }
        }
        const accepted = enforced
          ? validAccepted.length > 0
          : result.match && result.confidence >= CONFIDENCE_THRESHOLD

        if (accepted) {
          const base = idx * CHUNK_SECONDS
          let chunkSeg: [number, number]
          let shortSeg: [number, number]
          let matchedIds: string | undefined
          let confidence: number
          if (enforced) {
            // Rebuild all ranges strictly from VALIDATED per-segment windows.
            const v = validAccepted
            chunkSeg = [Math.min(...v.map((x) => x.chunkStart)), Math.max(...v.map((x) => x.chunkEnd))]
            shortSeg = [Math.min(...v.map((x) => x.shortStart)), Math.max(...v.map((x) => x.shortEnd))]
            matchedIds = v.map((x) => `S${x.segmentIndex}`).join(', ')
            confidence = Math.max(...v.map((x) => x.confidence))
            // FRAME-BY-FRAME MAP: persist each validated segment window as an exact
            // short↔movie mapping. Keep only the best mapping per segment — and queue
            // every new/changed mapping for LIVE 24fps verification immediately.
            if (!scan.segmentMatches) scan.segmentMatches = []
            for (const x of v) {
              const sm: SegmentMatch = {
                segmentIndex: x.segmentIndex,
                shortStart: x.shortStart,
                shortEnd: x.shortEnd,
                movieStart: base + x.chunkStart,
                movieEnd: base + x.chunkEnd,
                confidence: x.confidence,
                speed: x.speed || '1.0x',
                model: m.id,
                chunkIndex: idx,
                verification: { state: 'pending', attempts: 0 },
              }
              const existing = scan.segmentMatches.find((e) => e.segmentIndex === x.segmentIndex)
              const sameWindow = (aS: number, aE: number, bS: number, bE: number) => Math.abs(aS - bS) <= 0.25 && Math.abs(aE - bE) <= 0.25
              if (!existing) {
                this.recordCandidateChunk(sm, idx, x.confidence)
                scan.segmentMatches.push(sm)
                this.enqueueVerify(job, sm.segmentIndex)
              } else if (existing.verification?.state === 'confirmed') {
                // ORDER SAFETY: a frame-verified mapping is LOCKED — never replaced by a
                // later unverified claim, even at higher scan confidence.
                addLog(scan, 'info', `  S${x.segmentIndex}: new candidate ignored — segment already CONFIRMED at 24fps`)
                continue
              } else if (
                (existing.rejectedWindows || []).some((w) => sameWindow(sm.movieStart, sm.movieEnd, w[0], w[1]))
              ) {
                // This exact window was already REJECTED by the 24fps verifier — never retry it.
                addLog(scan, 'info', `  S${x.segmentIndex}: candidate ${fmt(sm.movieStart)}-${fmt(sm.movieEnd)} ignored — window already rejected by verifier`)
                continue
              } else if (sm.confidence > existing.confidence || existing.verification?.state === 'rejected_final') {
                this.recordCandidateChunk(existing, idx, x.confidence)
                const windowChanged = !sameWindow(existing.movieStart, existing.movieEnd, sm.movieStart, sm.movieEnd)
                const wasRejected = existing.verification?.state === 'rejected_final'
                const prevVerification = existing.verification
                // Keep the displaced (unverified) window as an alternate — it may still be
                // the real match if the new one gets rejected.
                if (windowChanged && !wasRejected) {
                  this.addAlternate(existing, {
                    shortStart: existing.shortStart,
                    shortEnd: existing.shortEnd,
                    movieStart: existing.movieStart,
                    movieEnd: existing.movieEnd,
                    confidence: existing.confidence,
                    speed: existing.speed,
                    model: existing.model,
                    chunkIndex: existing.chunkIndex,
                  })
                }
                Object.assign(existing, sm)
                // Object.assign copies sm's fresh verification too — restore the real
                // state unless the mapping actually changed (or was rejected before).
                if (windowChanged || wasRejected) {
                  existing.verification = { state: 'pending', attempts: 0 }
                } else {
                  existing.verification = prevVerification
                }
                if (existing.verification?.state === 'pending') this.enqueueVerify(job, sm.segmentIndex)
              } else {
                // SUSPECT-CONFIDENCE RULE: any accepted match below conf 100 stays suspect,
                // so equal/lower-confidence windows found in LATER chunks are kept as
                // alternates — promoted for 24fps verification if the current one fails.
                // NOTE: the same footage CAN legitimately appear twice in a movie
                // (flashback/recap/repeated establishing shot) — duplicates are NOT
                // auto-rejected; the 24fps verifier decides and the first CONFIRM wins.
                this.recordCandidateChunk(existing, idx, x.confidence)
                const windowChanged = !sameWindow(existing.movieStart, existing.movieEnd, sm.movieStart, sm.movieEnd)
                if (windowChanged) {
                  const added = this.addAlternate(existing, {
                    shortStart: sm.shortStart,
                    shortEnd: sm.shortEnd,
                    movieStart: sm.movieStart,
                    movieEnd: sm.movieEnd,
                    confidence: sm.confidence,
                    speed: sm.speed,
                    model: sm.model,
                    chunkIndex: sm.chunkIndex,
                  })
                  if (added) {
                    addLog(
                      scan,
                      'info',
                      `  S${x.segmentIndex}: ALTERNATE window saved ${fmt(sm.movieStart)}-${fmt(sm.movieEnd)} conf ${sm.confidence} (chunk ${idx}) — will be verified if the current mapping is rejected`,
                    )
                  }
                }
              }
              addLog(
                scan,
                'success',
                `  S${x.segmentIndex} mapped: short ${x.shortStart.toFixed(3)}s-${x.shortEnd.toFixed(3)}s ↔ movie ${(base + x.chunkStart).toFixed(3)}s-${(base + x.chunkEnd).toFixed(3)}s (${(x.chunkEnd - x.chunkStart).toFixed(3)}s @ ${x.speed || '1.0x'}, conf ${x.confidence}) → queued for 24fps verification`,
              )
            }
            scan.segmentMatches.sort((a, b) => a.segmentIndex - b.segmentIndex)
          } else {
            chunkSeg = parseSegment(result.chunk_segment) || [0, CHUNK_SECONDS]
            shortSeg = parseSegment(result.short_segment) || [0, scan.shortDuration || 60]
            matchedIds = result.matched_segments || undefined
            confidence = result.confidence
          }
          const cand: Candidate = {
            id: crypto.randomBytes(6).toString('hex'),
            chunkIndex: idx,
            confidence,
            shortSegment: shortSeg,
            chunkSegment: chunkSeg,
            absSegment: [base + chunkSeg[0], base + chunkSeg[1]],
            matchedSegments: matchedIds,
            model: m.id,
            note: result.note,
          }
          scan.candidates.push(cand)
          chunk.status = 'match'
          chunk.confidence = confidence
          addLog(
            scan,
            'success',
            `match found ${fmt(cand.absSegment[0])}-${fmt(cand.absSegment[1])} conf ${confidence}${matchedIds ? ` [segments: ${matchedIds}]` : ''} (chunk ${idx}, ${m.id})`,
          )
          // NO EARLY STOP: every chunk is always scanned. A "full coverage" claim from
          // unverified matches proved unreliable — the real match may be in a later chunk.
        } else {
          chunk.status = 'no_match'
          chunk.confidence = enforced ? enforced.confidence : result.confidence
          if (enforced && result.match && !enforced.match) {
            addLog(scan, 'warn', `chunk ${idx}: model claimed a match but NO segment passed the exact-duration check — rejected as false positive`)
          } else if (result.match) {
            addLog(scan, 'info', `chunk ${idx}: low confidence (<${CONFIDENCE_THRESHOLD}) — treated as no match`)
          }
        }
        for (const rl of result.rejected_lookalikes || []) {
          addLog(scan, 'info', `chunk ${idx}: rejected lookalike ${rl.segment} @ ${rl.chunk_range} — ${rl.reason.slice(0, 120)}`)
        }
      } catch (err) {
        const e = err instanceof GeminiError ? err : new GeminiError('other', err instanceof Error ? err.message : String(err))
        if (e.kind === 'rpd' || e.kind === 'unavailable') {
          setModelExhausted(m.id, lane.apiKey, m.rpd)
          st.state = 'exhausted'
          chunk.status = 'pending'
          chunk.model = undefined
          // Not the chunk's fault — refund the attempt so it still gets 3 real tries.
          chunk.attempts = Math.max(0, chunk.attempts - 1)
          job.queue.push(idx)
          addLog(
            scan,
            'warn',
            e.kind === 'unavailable'
              ? `${m.id} (key ${lane.idx}) unavailable (404/retired) — removed from pool, requeued chunk ${idx}`
              : `429 (daily quota) on ${m.id} (key ${lane.idx}) — exhausted, requeued chunk ${idx}`,
          )
          job.inFlight.delete(idx)
          if (uploadedName) void deleteFileQuiet(lane.ai, uploadedName)
          this.mark(job)
          return
        } else if (e.kind === 'rate') {
          job.cooldownUntil[rk] = Date.now() + RATE_COOLDOWN_MS
          st.state = 'cooling'
          st.cooldownUntil = job.cooldownUntil[rk]
          chunk.status = 'pending'
          chunk.model = undefined
          job.queue.push(idx)
          addLog(scan, 'warn', `429 (rate) on ${m.id} (key ${lane.idx}) — cooling 60s, requeued chunk ${idx}`)
        } else {
          // 500 / timeout / parse failure: retry up to 2 more times on another model.
          if (chunk.attempts <= 2) {
            chunk.status = 'pending'
            chunk.model = undefined
            job.queue.push(idx)
            addLog(scan, 'warn', `error on chunk ${idx} via ${m.id}: ${e.message.slice(0, 140)} — retry ${chunk.attempts}/3`)
          } else {
            chunk.status = 'failed'
            addLog(scan, 'error', `chunk ${idx} failed after 3 attempts: ${e.message.slice(0, 140)}`)
          }
        }
      } finally {
        job.inFlight.delete(idx)
        if (uploadedName) void deleteFileQuiet(lane.ai, uploadedName)
        st.currentChunk = null
        this.mark(job)
      }
    }
  }

  /** Execute one live verification task (verify @24fps or rescan @24fps).
   *  Returns false when this worker must exit (RPD exhausted / model retired). */
  private async runVerifyTask(job: Job, lane: KeyLane, m: ModelSpec, task: VerifyTask): Promise<boolean> {
    const { scan } = job
    const st = this.modelState(job, lane, m)
    const sm = (scan.segmentMatches || []).find((s) => s.segmentIndex === task.segmentIndex)

    // Idempotency guard: the segment's persisted state must still expect this task.
    // A CONFIRMED segment cancels everything else instantly; a rescan may run in
    // parallel with a verify of another candidate window for the same segment.
    if (!sm || !sm.verification) return true
    if (task.kind === 'verify' && sm.verification.state !== 'pending') return true
    if (task.kind === 'rescan' && (sm.verification.state === 'confirmed' || sm.verification.state === 'rejected_final'))
      return true

    const mediaDir = scanMediaDir(scan.id)
    const rk = this.rateKey(lane, m)
    const tKey = this.taskKey(task)
    job.verifyInFlight.add(tKey)
    st.state = 'active'
    st.currentChunk = null
    job.lastRequestAt[rk] = Date.now()
    const used = incrementModelUsage(m.id, lane.apiKey)
    st.usedToday = used
    this.mark(job)

    const tmpFiles: string[] = []
    const remoteNames: string[] = []
    try {
      if (task.kind === 'verify') {
        sm.verification.state = 'verifying'
        addLog(scan, 'info', `verify S${sm.segmentIndex} @24fps → ${m.id} (key ${lane.idx}, attempt ${sm.verification.attempts + 1})`)
        this.mark(job)

        const tag = `${sm.segmentIndex}-${Date.now()}`
        const shortClip = path.join(mediaDir, `vlive-short-${tag}.mp4`)
        const movieClip = path.join(mediaDir, `vlive-movie-${tag}.mp4`)
        tmpFiles.push(shortClip, movieClip)
        await extractSegment(path.join(mediaDir, 'short.mp4'), sm.shortStart, sm.shortEnd, shortClip)
        await extractSegment(path.join(mediaDir, 'movie.mp4'), sm.movieStart, sm.movieEnd, movieClip)

        const su = await uploadVideo(lane.ai, shortClip)
        remoteNames.push(su.name)
        const mu = await uploadVideo(lane.ai, movieClip)
        remoteNames.push(mu.name)
        const res = await liveVerifyRequest(lane.ai, m.id, su.uri, mu.uri)

        sm.verification.attempts += 1
        sm.verification.model = m.id
        sm.verification.keyLane = lane.idx
        sm.verification.confidence = res.confidence

        // Release the in-flight key BEFORE follow-up enqueues (they dedupe by key).
        job.verifyInFlight.delete(tKey)

        if (res.verdict === 'CONFIRM' && res.confidence >= CONFIDENCE_THRESHOLD) {
          sm.verification.state = 'confirmed'
          sm.verification.note = res.note
          sm.verification.reason = undefined
          addLog(scan, 'success', `S${sm.segmentIndex} CONFIRMED @24fps conf ${res.confidence} (${m.id}, key ${lane.idx}) — ${res.note.slice(0, 100)}`)
          // First CONFIRM wins — instantly cancel every other candidate/rescan for this segment.
          this.onSegmentConfirmed(job, sm)
        } else {
          const reason = res.reason || res.note || 'verifier gave no reason'
          sm.verification.reason = reason
          sm.verification.rejectedWindow = [sm.movieStart, sm.movieEnd]
          // One verify per candidate window: on REJECT move to the NEXT candidate
          // (other chunks included — duplicates are decided by the verifier, not assumed).
          this.onWindowRejected(job, sm, reason)
        }
      } else {
        // ----- 24fps rescan of ONE candidate chunk (confidence-ordered hunt) -----
        // The target chunk comes from the task — rescans walk the candidateChunks list
        // (highest scan confidence first), NOT just the current primary chunk.
        const targetChunk = task.chunkIndex ?? sm.chunkIndex
        const seg = (scan.shortSegments || []).find((s) => s.index === sm.segmentIndex)
        if (!seg) {
          job.verifyInFlight.delete(tKey)
          addLog(scan, 'error', `re-scan S${sm.segmentIndex}: segment data missing — skipping chunk ${targetChunk}`)
          if (!this.startNextRescan(job, sm)) this.maybeFinalizeAfterRescans(job, sm)
          return true
        }
        addLog(scan, 'info', `re-scan S${sm.segmentIndex} @24fps in chunk ${targetChunk} → ${m.id} (key ${lane.idx})`)
        this.mark(job)

        const base = targetChunk * CHUNK_SECONDS
        const chunkEnd = Math.min(base + CHUNK_SECONDS, scan.movieDuration || base + CHUNK_SECONDS)
        const tag = `${sm.segmentIndex}-${targetChunk}-${Date.now()}`
        const shortClip = path.join(mediaDir, `vrescan-short-${tag}.mp4`)
        const chunkClip = path.join(mediaDir, `vrescan-chunk-${tag}.mp4`)
        tmpFiles.push(shortClip, chunkClip)
        await extractSegment(path.join(mediaDir, 'short.mp4'), seg.start, seg.end, shortClip)
        await extractSegment(path.join(mediaDir, 'movie.mp4'), base, chunkEnd, chunkClip)

        const su = await uploadVideo(lane.ai, shortClip)
        remoteNames.push(su.name)
        const cu = await uploadVideo(lane.ai, chunkClip)
        remoteNames.push(cu.name)

        // Prefer the rejected window that belongs to THIS chunk as rescan context.
        const inChunk = (w: [number, number]) => w[0] >= base - 0.5 && w[1] <= base + CHUNK_SECONDS + 0.5
        const firstWindow =
          (sm.rejectedWindows || []).find(inChunk) || sm.verification.rejectedWindow || [sm.movieStart, sm.movieEnd]
        const history: RescanHistory = {
          segmentIndex: sm.segmentIndex,
          segmentDuration: seg.end - seg.start,
          segmentText: singleSegmentPromptText(seg),
          firstWindow: [Math.max(0, firstWindow[0] - base), Math.max(0, firstWindow[1] - base)],
          firstConfidence: sm.confidence,
          rejectionReason: sm.verification.reason || '',
          movieGuess: scan.movieGuess,
        }
        const result = await rescanSegmentRequest(lane.ai, m.id, su.uri, cu.uri, history)

        // Release the in-flight key BEFORE follow-up enqueues (they dedupe by key).
        job.verifyInFlight.delete(tKey)

        // FIRST CONFIRM WINS: another candidate got confirmed while this rescan ran —
        // discard this result entirely, the hunt for this segment is over.
        if (sm.verification.state === 'confirmed') {
          addLog(scan, 'info', `re-scan S${sm.segmentIndex} (chunk ${targetChunk}): result discarded — segment already CONFIRMED at 24fps`)
          return true
        }

        const enforced = enforceSegmentDurations(result, [seg])
        for (const d of enforced.dropped) addLog(scan, 'warn', `re-scan S${sm.segmentIndex}: ${d.slice(0, 160)}`)
        let best = enforced.valid.filter((v) => v.confidence >= CONFIDENCE_THRESHOLD).sort((a, b) => b.confidence - a.confidence)[0]

        if (best) {
          const newStart = base + best.chunkStart
          const newEnd = base + best.chunkEnd
          const alreadyRejected = (sm.rejectedWindows || []).some(
            (w) => Math.abs(w[0] - newStart) <= 0.25 && Math.abs(w[1] - newEnd) <= 0.25,
          )
          if (alreadyRejected) {
            addLog(scan, 'warn', `re-scan S${sm.segmentIndex} (chunk ${targetChunk}): only found the already-rejected window ${fmt(newStart)}-${fmt(newEnd)} — discarded`)
            best = undefined as never
          } else if (sm.verification.state === 'rescanning') {
            // Primary slot free → this window becomes the primary and goes STRAIGHT
            // to 24fps verification, while the next rescan starts in parallel below.
            sm.movieStart = newStart
            sm.movieEnd = newEnd
            sm.confidence = best.confidence
            sm.speed = best.speed || sm.speed
            sm.model = m.id
            sm.chunkIndex = targetChunk
            this.recordCandidateChunk(sm, targetChunk, best.confidence)
            sm.verification.state = 'pending'
            this.enqueueVerify(job, sm.segmentIndex, 'verify')
            addLog(
              scan,
              'success',
              `re-scan S${sm.segmentIndex}: window found in chunk ${targetChunk} ${fmt(newStart)}-${fmt(newEnd)} conf ${best.confidence} — sent to 24fps verification IMMEDIATELY`,
            )
          } else {
            // A verify for another window is already pending/in flight — keep this
            // find as a candidate; it is promoted if that verify rejects.
            this.recordCandidateChunk(sm, targetChunk, best.confidence)
            const added = this.addAlternate(sm, {
              shortStart: seg.start,
              shortEnd: seg.end,
              movieStart: newStart,
              movieEnd: newEnd,
              confidence: best.confidence,
              speed: best.speed || '1.0x',
              model: m.id,
              chunkIndex: targetChunk,
            })
            if (added) {
              addLog(scan, 'info', `re-scan S${sm.segmentIndex}: window found in chunk ${targetChunk} ${fmt(newStart)}-${fmt(newEnd)} conf ${best.confidence} — saved as CANDIDATE (a verify is already running)`)
            }
          }
        }
        if (!best) {
          addLog(scan, 'warn', `re-scan S${sm.segmentIndex}: no same-to-same window in chunk ${targetChunk} (${result.note?.slice(0, 100) || 'no note'})`)
        }

        // Keep the hunt moving: start the NEXT rescan right away — never wait for
        // the verification verdict of the window just found.
        if (!this.startNextRescan(job, sm)) this.maybeFinalizeAfterRescans(job, sm)
      }
      return true
    } catch (err) {
      const e = err instanceof GeminiError ? err : new GeminiError('other', err instanceof Error ? err.message : String(err))
      // Roll the segment back to a queueable state — verification must NEVER block the scan.
      sm.verification.state = task.kind === 'rescan' ? 'rescanning' : 'pending'
      // Release the in-flight lock BEFORE re-enqueueing — enqueueVerify silently
      // drops tasks that are still marked in-flight, which would lose the retry.
      job.verifyInFlight.delete(tKey)
      if (e.kind === 'rpd' || e.kind === 'unavailable') {
        setModelExhausted(m.id, lane.apiKey, m.rpd)
        st.state = 'exhausted'
        this.enqueueVerify(job, task.segmentIndex, task.kind)
        addLog(scan, 'warn', `${m.id} (key ${lane.idx}) ${e.kind === 'rpd' ? 'quota exhausted' : 'unavailable'} during verification — S${task.segmentIndex} requeued`)
        this.mark(job)
        return false
      } else if (e.kind === 'rate') {
        job.cooldownUntil[rk] = Date.now() + RATE_COOLDOWN_MS
        st.state = 'cooling'
        st.cooldownUntil = job.cooldownUntil[rk]
        this.enqueueVerify(job, task.segmentIndex, task.kind)
        addLog(scan, 'warn', `429 (rate) on ${m.id} (key ${lane.idx}) during verification — cooling 60s, S${task.segmentIndex} requeued`)
      } else {
        const errs = (job.verifyErrors[task.segmentIndex] = (job.verifyErrors[task.segmentIndex] || 0) + 1)
        if (errs <= 3) {
          addLog(scan, 'warn', `verification error for S${task.segmentIndex} via ${m.id}: ${e.message.slice(0, 120)} — retry ${errs}/3 (with backoff)`)
          // Backoff FIRST, then re-enqueue: the task must not sit in the queue (or be
          // grabbed by another worker) while this segment is mid-backoff.
          await sleep(Math.min(15_000, 2_000 * 2 ** (errs - 1)))
          this.enqueueVerify(job, task.segmentIndex, task.kind)
        } else {
          addLog(scan, 'error', `S${task.segmentIndex} verification failed ${errs - 1} times: ${e.message.slice(0, 120)} — left as "pending" (scan result kept)`)
        }
      }
      return true
    } finally {
      job.verifyInFlight.delete(tKey)
      for (const name of remoteNames) void deleteFileQuiet(lane.ai, name)
      for (const f of tmpFiles) {
        try {
          fs.unlinkSync(f)
        } catch {
          /* ignore */
        }
      }
      this.mark(job)
    }
  }

  /** Segments that no longer need to be searched in upcoming chunks:
   *  24fps-CONFIRMED, or matched at confidence 100 (and not verifier-rejected).
   *  Anything below 100 is treated as suspect and keeps being searched everywhere. */
  private lockedSegmentIndexes(scan: Scan): Set<number> {
    const out = new Set<number>()
    for (const sm of scan.segmentMatches || []) {
      const st = sm.verification?.state
      if (st === 'rejected_final') continue
      if (st === 'confirmed' || sm.confidence >= 100) out.add(sm.segmentIndex)
    }
    return out
  }

  /** Store an alternate window on a segment (deduped by ~0.25s window). Returns true if added. */
  private addAlternate(sm: SegmentMatch, alt: NonNullable<SegmentMatch['alternates']>[number]): boolean {
    if (!sm.alternates) sm.alternates = []
    const dup = sm.alternates.some(
      (a) => Math.abs(a.movieStart - alt.movieStart) <= 0.25 && Math.abs(a.movieEnd - alt.movieEnd) <= 0.25,
    )
    if (dup) return false
    const rejected = (sm.rejectedWindows || []).some(
      (w) => Math.abs(w[0] - alt.movieStart) <= 0.25 && Math.abs(w[1] - alt.movieEnd) <= 0.25,
    )
    if (rejected) return false
    sm.alternates.push(alt)
    // Keep the list bounded: best 5 by confidence.
    sm.alternates.sort((a, b) => b.confidence - a.confidence)
    if (sm.alternates.length > 5) sm.alternates.length = 5
    return true
  }

  /** Record that a chunk produced a candidate window for this segment (best confidence
   *  per chunk). This is the memory the confidence-ordered rescan hunt runs on: when
   *  every candidate is rejected, rescans start with the HIGHEST-confidence chunk first. */
  private recordCandidateChunk(sm: SegmentMatch, chunkIndex: number, confidence: number) {
    if (!sm.candidateChunks) sm.candidateChunks = []
    const existing = sm.candidateChunks.find((c) => c.chunkIndex === chunkIndex)
    if (existing) existing.confidence = Math.max(existing.confidence, confidence)
    else sm.candidateChunks.push({ chunkIndex, confidence })
  }

  /** Is this window (movie seconds) already finally rejected for this segment? */
  private isWindowRejected(sm: SegmentMatch, start: number, end: number): boolean {
    return (sm.rejectedWindows || []).some((w) => Math.abs(w[0] - start) <= 0.25 && Math.abs(w[1] - end) <= 0.25)
  }

  /** Promote the best non-rejected alternate window to primary and queue it for
   *  24fps verification. Returns false when no usable alternate is left. */
  private promoteBestAlternate(job: Job, sm: SegmentMatch): boolean {
    const alts = (sm.alternates || []).filter((a) => !this.isWindowRejected(sm, a.movieStart, a.movieEnd))
    if (alts.length === 0) return false
    const best = alts.sort((a, b) => b.confidence - a.confidence)[0]
    sm.alternates = (sm.alternates || []).filter((a) => a !== best)
    sm.shortStart = best.shortStart
    sm.shortEnd = best.shortEnd
    sm.movieStart = best.movieStart
    sm.movieEnd = best.movieEnd
    sm.confidence = best.confidence
    sm.speed = best.speed
    sm.model = best.model
    sm.chunkIndex = best.chunkIndex
    if (!sm.verification) sm.verification = { state: 'pending', attempts: 0 }
    else sm.verification.state = 'pending'
    this.enqueueVerify(job, sm.segmentIndex, 'verify')
    addLog(
      job.scan,
      'info',
      `S${sm.segmentIndex}: promoting NEXT candidate ${fmt(best.movieStart)}-${fmt(best.movieEnd)} conf ${best.confidence} (from chunk ${best.chunkIndex}) for 24fps verification`,
    )
    this.mark(job)
    return true
  }

  /** FIRST CONFIRM WINS: the moment one candidate window is frame-confirmed, every
   *  other candidate, queued verify and queued/planned rescan for this segment is
   *  cancelled instantly. In-flight tasks self-discard via the confirmed guards. */
  private onSegmentConfirmed(job: Job, sm: SegmentMatch) {
    const droppedAlts = (sm.alternates || []).length
    const droppedRescans = (sm.rescanChunkQueue || []).length
    sm.alternates = []
    sm.rescanChunkQueue = []
    const before = job.verifyQueue.length
    job.verifyQueue = job.verifyQueue.filter((t) => t.segmentIndex !== sm.segmentIndex)
    const removedTasks = before - job.verifyQueue.length
    if (droppedAlts + droppedRescans + removedTasks > 0) {
      addLog(
        job.scan,
        'info',
        `S${sm.segmentIndex}: first CONFIRM wins — cancelled ${removedTasks} queued task(s), dropped ${droppedAlts} alternate(s) and ${droppedRescans} planned rescan(s)`,
      )
    }
    this.mark(job)
  }

  /** One verify per candidate window. Called when the 24fps verifier REJECTS the
   *  segment's current window:
   *  1) record the window as rejected (never retried),
   *  2) promote the NEXT candidate (any chunk — duplicates across chunks are expected,
   *     e.g. flashbacks/recaps; the verifier decides which one is real, never assumption),
   *  3) when NO candidate is left, start the confidence-ordered rescan hunt over every
   *     chunk that ever produced a candidate (highest scan confidence first),
   *  4) when even that is exhausted, finalize as rejected_final. */
  private onWindowRejected(job: Job, sm: SegmentMatch, reason: string) {
    const { scan } = job
    if (!sm.rejectedWindows) sm.rejectedWindows = []
    if (!this.isWindowRejected(sm, sm.movieStart, sm.movieEnd)) {
      sm.rejectedWindows.push([sm.movieStart, sm.movieEnd])
    }
    addLog(
      scan,
      'warn',
      `S${sm.segmentIndex} REJECTED @24fps: window ${fmt(sm.movieStart)}-${fmt(sm.movieEnd)} (chunk ${sm.chunkIndex}) — ${reason.slice(0, 140)}`,
    )
    this.mark(job)

    // 1) Next candidate first — verified one at a time, confidence order.
    if (this.promoteBestAlternate(job, sm)) return

    // 2) Rescans for this segment still queued/in flight? They may deliver the next
    //    candidate any moment — stay in "rescanning" and let their results drive us.
    if (this.hasRescanWork(job, sm.segmentIndex)) {
      sm.verification!.state = 'rescanning'
      this.mark(job)
      return
    }

    // 3) All candidates rejected → build the rescan queue ONCE from the recorded
    //    candidate chunks, highest scan confidence first (that chunk is rescanned first).
    if (sm.rescanChunkQueue === undefined) {
      sm.rescanChunkQueue = (sm.candidateChunks || [])
        .slice()
        .sort((a, b) => b.confidence - a.confidence)
        .map((c) => c.chunkIndex)
      if (sm.rescanChunkQueue.length > 0) {
        addLog(
          scan,
          'warn',
          `S${sm.segmentIndex}: ALL candidates rejected — starting 24fps re-scan hunt in confidence order: chunk(s) ${sm.rescanChunkQueue.join(', ')}`,
        )
      }
    }
    sm.verification!.state = 'rescanning'
    if (!this.startNextRescan(job, sm)) this.maybeFinalizeAfterRescans(job, sm)
  }

  /** Queue the NEXT chunk rescan for this segment (confidence order). Never waits for
   *  a pending verification verdict — the hunt keeps moving in parallel.
   *  Returns false when the rescan queue is empty (or the segment is settled). */
  private startNextRescan(job: Job, sm: SegmentMatch): boolean {
    const v = sm.verification
    if (!v || v.state === 'confirmed' || v.state === 'rejected_final') return false
    if (!sm.rescanChunkQueue || sm.rescanChunkQueue.length === 0) return false
    const chunk = sm.rescanChunkQueue.shift()!
    // Keep a pending/verifying state intact — a verify of a promoted window may be
    // running in parallel with this rescan on the other API key.
    if (v.state !== 'pending' && v.state !== 'verifying') v.state = 'rescanning'
    this.enqueueVerify(job, sm.segmentIndex, 'rescan', chunk)
    this.mark(job)
    return true
  }

  /** Called when a rescan finishes and no further rescan could be started. Decides
   *  whether the segment is truly finished: only when NO verify is pending/in flight,
   *  NO rescan is queued/in flight, and NO candidate is left does the segment become
   *  rejected_final (per policy: all candidates rejected + all rescans failed). */
  private maybeFinalizeAfterRescans(job: Job, sm: SegmentMatch) {
    const { scan } = job
    const v = sm.verification
    if (!v || v.state === 'confirmed' || v.state === 'rejected_final') return
    // A promoted window is still being verified — its verdict drives the next step.
    if (v.state === 'pending' || v.state === 'verifying') return
    if (this.hasRescanWork(job, sm.segmentIndex)) return
    if ((sm.rescanChunkQueue || []).length > 0) {
      this.startNextRescan(job, sm)
      return
    }
    // A parallel rescan may have parked a candidate as an alternate — verify it now.
    if (this.promoteBestAlternate(job, sm)) return

    // Exhausted: every candidate rejected AND every candidate-chunk rescan failed.
    v.state = 'rejected_final'
    addLog(
      scan,
      'error',
      `S${sm.segmentIndex} REJECTED_FINAL — every candidate window rejected and every candidate-chunk 24fps re-scan found no same-to-same footage`,
    )
    this.mark(job)
    // Safety net: re-queue chunks that skipped this segment while it was locked.
    this.onSegmentRejectedFinal(job, sm)
  }

  /** Called whenever the verifier FINALLY rejects a segment's current window.
   *  1) Records the rejected window so it is never retried.
   *  2) Promotes the best saved alternate window (from another chunk) for verification.
   *  3) If no alternate exists, re-queues every already-scanned chunk that had EXCLUDED
   *     this segment from its prompt (it was locked at conf 100 back then). */
  private onSegmentRejectedFinal(job: Job, sm: SegmentMatch) {
    const { scan } = job
    if (!sm.rejectedWindows) sm.rejectedWindows = []
    if (!sm.rejectedWindows.some((w) => Math.abs(w[0] - sm.movieStart) <= 0.25 && Math.abs(w[1] - sm.movieEnd) <= 0.25)) {
      sm.rejectedWindows.push([sm.movieStart, sm.movieEnd])
    }

    // 1) Promote the best alternate window not already rejected.
    const alts = (sm.alternates || []).filter(
      (a) => !sm.rejectedWindows!.some((w) => Math.abs(w[0] - a.movieStart) <= 0.25 && Math.abs(w[1] - a.movieEnd) <= 0.25),
    )
    if (alts.length > 0) {
      const best = alts.sort((a, b) => b.confidence - a.confidence)[0]
      sm.alternates = (sm.alternates || []).filter((a) => a !== best)
      sm.shortStart = best.shortStart
      sm.shortEnd = best.shortEnd
      sm.movieStart = best.movieStart
      sm.movieEnd = best.movieEnd
      sm.confidence = best.confidence
      sm.speed = best.speed
      sm.model = best.model
      sm.chunkIndex = best.chunkIndex
      sm.verification = { state: 'pending', attempts: 0 }
      job.verifyInFlight.delete(`v:${sm.segmentIndex}`)
      this.enqueueVerify(job, sm.segmentIndex, 'verify')
      addLog(
        scan,
        'warn',
        `S${sm.segmentIndex}: current window rejected — promoting ALTERNATE ${fmt(best.movieStart)}-${fmt(best.movieEnd)} conf ${best.confidence} (chunk ${best.chunkIndex}) for 24fps verification`,
      )
      this.mark(job)
      return
    }

    // 2) No alternates left — re-queue chunks that skipped this segment (it was locked then).
    let requeued = 0
    for (const c of scan.chunks) {
      if (!(c.excludedSegments || []).includes(sm.segmentIndex)) continue
      if (c.status !== 'match' && c.status !== 'no_match' && c.status !== 'cancelled') continue
      c.status = 'pending'
      c.excludedSegments = undefined
      c.model = undefined
      if (!job.queue.includes(c.index) && !job.inFlight.has(c.index)) job.queue.push(c.index)
      requeued++
    }
    if (requeued > 0) {
      addLog(
        scan,
        'warn',
        `S${sm.segmentIndex} rejected with no alternates — re-queued ${requeued} chunk(s) that had skipped this segment while it was locked`,
      )
      this.mark(job)
    }
  }

  /** Build verification regions. STRICT: when a frame-by-frame segment map exists, regions
   *  are built ONLY from validated segment matches that were NOT rejected by the verifier —
   *  consecutive segments are merged ONLY when their movie windows are contiguous in the
   *  same way as their short windows, so a region's movie duration always equals its short
   *  duration. Never merge across distant movie positions. */
  private buildRegions(scan: Scan): MatchRegion[] {
    const sms = (scan.segmentMatches || []).filter((s) => s.verification?.state !== 'rejected_final')
    if (sms.length > 0) {
      const sorted = [...sms].sort((a, b) => a.segmentIndex - b.segmentIndex)
      const regions: MatchRegion[] = []
      let group: SegmentMatch[] = []
      const flush = () => {
        if (group.length === 0) return
        regions.push({
          id: crypto.randomBytes(6).toString('hex'),
          movieStart: group[0].movieStart,
          movieEnd: group[group.length - 1].movieEnd,
          shortStart: group[0].shortStart,
          shortEnd: group[group.length - 1].shortEnd,
          candidateIds: [],
          segmentIndexes: group.map((g) => g.segmentIndex),
          maxConfidence: Math.max(...group.map((g) => g.confidence)),
        })
        group = []
      }
      for (const sm of sorted) {
        const prev = group[group.length - 1]
        if (!prev) {
          group.push(sm)
          continue
        }
        const shortGap = sm.shortStart - prev.shortEnd
        const movieGap = sm.movieStart - prev.movieEnd
        // Merge only truly consecutive segments whose movie windows line up the same
        // way (same gap within 1s) — keeps short/movie region durations equal.
        const contiguous =
          sm.segmentIndex === prev.segmentIndex + 1 && movieGap >= -0.5 && Math.abs(movieGap - shortGap) <= 1.0
        if (contiguous) group.push(sm)
        else {
          flush()
          group.push(sm)
        }
      }
      flush()
      return regions
    }

    // Legacy fallback (no segment map): merge adjacent/overlapping candidates.
    const sorted = [...scan.candidates].sort((a, b) => a.absSegment[0] - b.absSegment[0])
    const regions: MatchRegion[] = []
    for (const c of sorted) {
      const last = regions[regions.length - 1]
      const lastChunkOf = (r: MatchRegion) => Math.max(...r.candidateIds.map((id) => scan.candidates.find((x) => x.id === id)!.chunkIndex))
      if (last && (c.absSegment[0] <= last.movieEnd + 5 || c.chunkIndex - lastChunkOf(last) <= 1)) {
        last.movieEnd = Math.max(last.movieEnd, c.absSegment[1])
        last.shortStart = Math.min(last.shortStart, c.shortSegment[0])
        last.shortEnd = Math.max(last.shortEnd, c.shortSegment[1])
        last.maxConfidence = Math.max(last.maxConfidence, c.confidence)
        last.candidateIds.push(c.id)
      } else {
        regions.push({
          id: crypto.randomBytes(6).toString('hex'),
          movieStart: c.absSegment[0],
          movieEnd: c.absSegment[1],
          shortStart: c.shortSegment[0],
          shortEnd: c.shortSegment[1],
          candidateIds: [c.id],
          maxConfidence: c.confidence,
        })
      }
    }
    return regions
  }

  /** Merge matches into regions. When the LIVE 24fps per-segment verification ran, region
   *  verdicts are derived directly from it (no duplicate model calls). The legacy 24fps
   *  region pass only runs for candidate-only scans with no segment map. */
  private async verificationPass(job: Job) {
    const { scan } = job
    const sms = scan.segmentMatches || []
    if (scan.candidates.length === 0 && sms.length === 0) {
      scan.regions = []
      return
    }
    scan.status = 'verifying'
    this.mark(job)

    const regions = this.buildRegions(scan)
    scan.regions = regions

    if (sms.length > 0) {
      // Live-verified path: derive each region's verdict from its segments' 24fps results.
      addLog(scan, 'info', `Regions built from the live-verified segment map: ${regions.length} region(s)`)
      const rejectedCount = sms.filter((s) => s.verification?.state === 'rejected_final').length
      if (rejectedCount > 0) addLog(scan, 'warn', `${rejectedCount} segment(s) rejected by the 24fps verifier are EXCLUDED from final regions`)
      for (const region of regions) {
        const segs = (region.segmentIndexes || []).map((i) => sms.find((s) => s.segmentIndex === i)).filter(Boolean) as SegmentMatch[]
        const confirmed = segs.filter((s) => s.verification?.state === 'confirmed')
        if (segs.length > 0 && confirmed.length === segs.length) {
          region.verified = {
            match: true,
            confidence: Math.max(...confirmed.map((s) => s.verification?.confidence || 0)),
            model: confirmed[0].verification?.model || 'live-verifier',
            note: `All ${segs.length} segment(s) frame-verified at 24fps`,
          }
        } else {
          region.verified = {
            match: true,
            confidence: region.maxConfidence,
            model: 'unverified',
            note: `${confirmed.length}/${segs.length} segment(s) verified — rest pending (verifier quota/errors); scan confidence kept`,
          }
        }
      }
      for (const g of this.groupOverlapping(regions)) {
        const best = g.reduce((a, b) => ((b.verified?.confidence || 0) > (a.verified?.confidence || 0) ? b : a))
        best.selected = true
      }
      this.mark(job)
      return
    }

    // ----- Legacy path (no segment map): 24fps region verification -----
    addLog(scan, 'info', 'Starting final verification pass (24 fps)...')
    addLog(scan, 'info', `${regions.length} merged match region(s) to verify`)
    this.mark(job)

    const mediaDir = scanMediaDir(scan.id)
    const lane = job.lanes[job.lanes.length - 1] // prefer the verifier key when present
    for (const region of regions) {
      try {
        const shortSeg = path.join(mediaDir, `verify-short-${region.id}.mp4`)
        const movieSeg = path.join(mediaDir, `verify-movie-${region.id}.mp4`)
        await extractSegment(path.join(mediaDir, 'short.mp4'), region.shortStart, region.shortEnd, shortSeg)
        await extractSegment(path.join(mediaDir, 'movie.mp4'), region.movieStart, region.movieEnd, movieSeg)

        const model = this.pickFreeModel(job, lane)
        if (!model) {
          addLog(scan, 'warn', `No model available to verify region ${fmt(region.movieStart)}-${fmt(region.movieEnd)} — keeping scan confidence`)
          region.verified = { match: true, confidence: region.maxConfidence, model: 'unverified', note: 'All models exhausted; using scan confidence' }
          continue
        }
        const rk = this.rateKey(lane, model)
        const wait = (job.lastRequestAt[rk] || 0) + MODEL_MIN_INTERVAL_MS - Date.now()
        if (wait > 0) await sleep(wait)
        job.lastRequestAt[rk] = Date.now()
        const used = incrementModelUsage(model.id, lane.apiKey)
        this.modelState(job, lane, model).usedToday = used
        addLog(scan, 'info', `verifying region ${fmt(region.movieStart)}-${fmt(region.movieEnd)} → ${model.id} @24fps (key ${lane.idx})`)
        this.mark(job)

        const su = await uploadVideo(lane.ai, shortSeg)
        const mu = await uploadVideo(lane.ai, movieSeg)
        const result = await verifyRequest(lane.ai, model.id, su.uri, mu.uri)
        void deleteFileQuiet(lane.ai, su.name)
        void deleteFileQuiet(lane.ai, mu.name)

        region.verified = {
          match: result.match && result.confidence >= CONFIDENCE_THRESHOLD,
          confidence: result.confidence,
          model: model.id,
          note: result.note,
        }
        addLog(scan, result.match ? 'success' : 'warn', `region ${fmt(region.movieStart)}-${fmt(region.movieEnd)} verified: ${result.match ? 'MATCH' : 'no match'} conf ${result.confidence}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        addLog(scan, 'error', `verification failed for region ${fmt(region.movieStart)}: ${msg.slice(0, 140)} — keeping scan confidence`)
        region.verified = { match: true, confidence: region.maxConfidence, model: 'unverified', note: 'Verification errored; using scan confidence' }
      }
      this.mark(job)
    }

    // When multiple regions overlap the same short-video scene, select the highest verified confidence.
    for (const g of this.groupOverlapping(regions)) {
      const matching = g.filter((r) => r.verified?.match)
      const pool = matching.length > 0 ? matching : g
      const best = pool.reduce((a, b) => ((b.verified?.confidence || 0) > (a.verified?.confidence || 0) ? b : a))
      best.selected = true
    }
    this.mark(job)
  }

  private groupOverlapping(regions: MatchRegion[]): MatchRegion[][] {
    const groups: MatchRegion[][] = []
    for (const r of regions) {
      const g = groups.find((grp) => grp.some((x) => r.shortStart < x.shortEnd && x.shortStart < r.shortEnd))
      if (g) g.push(r)
      else groups.push([r])
    }
    return groups
  }

  private pickFreeModel(job: Job, lane: KeyLane, exclude?: Set<string>): ModelSpec | null {
    for (const m of MODEL_POOL) {
      if (exclude?.has(m.id)) continue
      if (getModelUsage(m.id, lane.apiKey) >= m.rpd) continue
      const cool = job.cooldownUntil[this.rateKey(lane, m)] || 0
      if (cool > Date.now()) continue
      return m
    }
    // Everything excluded but still available? Fall back to any usable model.
    if (exclude && exclude.size > 0) return this.pickFreeModel(job, lane)
    return null
  }
}

function fmt(sec: number): string {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`
}

// Singleton that survives HMR in dev.
const g = globalThis as unknown as { __cmtScheduler?: Scheduler }
export const scheduler: Scheduler = g.__cmtScheduler || (g.__cmtScheduler = new Scheduler())
