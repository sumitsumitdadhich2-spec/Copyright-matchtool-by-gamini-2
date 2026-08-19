import path from 'node:path'
import crypto from 'node:crypto'
import type { GoogleGenAI } from '@google/genai'
import type { Scan, Candidate, MatchRegion } from './types'
import {
  MODEL_POOL,
  MODEL_MIN_INTERVAL_MS,
  RATE_COOLDOWN_MS,
  CONFIDENCE_THRESHOLD,
  CHUNK_SECONDS,
  type ModelSpec,
} from './models'
import {
  getScan,
  saveScan,
  addLog,
  getApiKey,
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
  verifyRequest,
  parseSegment,
  enforceSegmentDurations,
  GeminiError,
} from './gemini'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Job {
  scan: Scan
  ai: GoogleGenAI
  apiKey: string
  queue: number[]
  inFlight: Set<number>
  stopping: boolean
  earlyStop: boolean
  shortUri: string | null
  segmentsText: string | null
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
    const apiKey = getApiKey()
    if (!apiKey) return { ok: false, error: 'No Gemini API key configured. Add it in Settings first.' }
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
    if (queue.length === 0 && scan.status !== 'stopped') {
      return { ok: false, error: 'No pending chunks to scan.' }
    }

    scan.status = 'scanning'
    scan.error = null
    if (!scan.startedAt) scan.startedAt = Date.now()
    addLog(scan, 'info', resume ? `Resuming scan: ${queue.length} chunks pending` : `Scan started: ${queue.length} chunks queued across ${MODEL_POOL.length} models`)

    const job: Job = {
      scan,
      ai: getClient(apiKey),
      apiKey,
      queue,
      inFlight: new Set(),
      stopping: false,
      earlyStop: false,
      shortUri: null,
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

  private modelState(job: Job, m: ModelSpec) {
    const used = getModelUsage(m.id, job.apiKey)
    if (!job.scan.modelStates[m.id]) {
      job.scan.modelStates[m.id] = { state: 'idle', currentChunk: null, cooldownUntil: null, usedToday: used }
    }
    const s = job.scan.modelStates[m.id]
    s.usedToday = used
    return s
  }

  private async runScan(job: Job) {
    const { scan } = job
    const mediaDir = scanMediaDir(scan.id)

    // Upload the short video once; every request reuses its URI.
    addLog(scan, 'info', 'Uploading short video to Gemini Files API...')
    this.mark(job)
    const shortFile = await uploadVideo(job.ai, path.join(mediaDir, 'short.mp4'))
    job.shortUri = shortFile.uri
    addLog(scan, 'success', 'Short video ready on Gemini')
    this.mark(job)

    // Phase 1: one-time segmentation pass (20 fps). Reuses saved segments on resume.
    if (scan.shortSegments && scan.shortSegments.length > 0) {
      job.segmentsText = segmentsToPromptText(scan.shortSegments)
      addLog(scan, 'info', `Reusing ${scan.shortSegments.length} saved segment(s) from previous run`)
    } else {
      await this.segmentShort(job)
    }
    this.mark(job)

    // One worker per model, all pulling from the shared queue in parallel.
    await Promise.all(MODEL_POOL.map((m) => this.worker(job, m)))

    // Scan phase over. Persist final chunk states.
    for (const m of MODEL_POOL) {
      const s = this.modelState(job, m)
      if (s.state === 'active' || s.state === 'waiting') s.state = 'idle'
      s.currentChunk = null
    }

    if (job.stopping && !job.earlyStop) {
      scan.status = 'stopped'
      addLog(scan, 'warn', `Scan stopped. ${job.queue.length + scan.chunks.filter((c) => c.status === 'pending').length > 0 ? 'Pending chunks saved — use Resume to continue.' : ''}`)
      this.finish(job)
      return
    }

    if (job.earlyStop) {
      for (const c of scan.chunks) if (c.status === 'pending') c.status = 'cancelled'
      addLog(scan, 'success', 'Full match found, scan stopped early.')
      scan.earlyStopped = true
    }

    // Build merged regions and run the final 14fps verification pass.
    await this.verificationPass(job)

    scan.status = 'done'
    scan.finishedAt = Date.now()
    scan.report = {
      totalScanTimeMs: scan.finishedAt - (scan.startedAt || scan.finishedAt),
      chunksScanned: scan.chunks.filter((c) => c.status === 'match' || c.status === 'no_match').length,
      chunksFailed: scan.chunks.filter((c) => c.status === 'failed').length,
      modelsUsed: MODEL_POOL.filter((m) => getModelUsage(m.id, job.apiKey) > 0).map((m) => m.id),
      earlyStopped: scan.earlyStopped,
      regions: scan.regions,
    }
    addLog(scan, 'success', `Scan complete: ${scan.regions.filter((r) => r.selected).length} final match region(s)`) 
    cleanupChunks(path.join(mediaDir, 'chunks'))
    addLog(scan, 'info', 'Temporary chunk files cleaned up')
    this.finish(job)
  }

  /** Phase 1: send the whole short video at 20 fps → movie guess + millisecond scene segments. */
  private async segmentShort(job: Job) {
    const { scan } = job
    addLog(scan, 'info', `Segmentation pass: analyzing short video at 20 fps (movie ID + scene changes)...`)
    this.mark(job)
    const tried = new Set<string>()
    for (let attempt = 0; attempt < 4; attempt++) {
      // Rotate models between attempts — a model that returned broken JSON once
      // will usually return the same broken JSON again at temperature 0.
      const model = await this.pickVerifyModel(job, tried)
      if (!model) break
      tried.add(model.id)
      try {
        const wait = (job.lastRequestAt[model.id] || 0) + MODEL_MIN_INTERVAL_MS - Date.now()
        if (wait > 0) await sleep(wait)
        job.lastRequestAt[model.id] = Date.now()
        const used = incrementModelUsage(model.id, job.apiKey)
        this.modelState(job, model).usedToday = used
        this.mark(job)
        const result = await segmentShortRequest(job.ai, model.id, job.shortUri!)
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
        if (e.kind === 'rpd' || e.kind === 'unavailable') setModelExhausted(model.id, job.apiKey, model.rpd)
        else if (e.kind === 'rate') job.cooldownUntil[model.id] = Date.now() + RATE_COOLDOWN_MS
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

  private async worker(job: Job, m: ModelSpec) {
    const { scan } = job
    const mediaDir = path.join(scanMediaDir(scan.id), 'chunks')

    while (true) {
      if (job.stopping || job.earlyStop) return
      const st = this.modelState(job, m)

      // RPD check — never send request N+1 past the daily cap.
      if (getModelUsage(m.id, job.apiKey) >= m.rpd) {
        if (st.state !== 'exhausted') {
          st.state = 'exhausted'
          st.currentChunk = null
          addLog(scan, 'warn', `${m.id} exhausted for today (${m.rpd}/${m.rpd} RPD) — removed from pool`)
          this.mark(job)
        }
        return
      }

      // Cooldown check (RPM/TPM-type 429).
      const cool = job.cooldownUntil[m.id] || 0
      if (cool > Date.now()) {
        st.state = 'cooling'
        st.cooldownUntil = cool
        st.currentChunk = null
        this.mark(job)
        await sleep(Math.min(2000, cool - Date.now()))
        continue
      }
      st.cooldownUntil = null

      // Pull next chunk from the shared queue.
      const chunkIndex = job.queue.shift()
      if (chunkIndex === undefined) {
        if (job.inFlight.size === 0) {
          st.state = 'idle'
          st.currentChunk = null
          this.mark(job)
          return
        }
        st.state = 'waiting'
        this.mark(job)
        await sleep(1500)
        continue
      }

      // Enforce 1 request/minute per model (TPM is the real limiter).
      const wait = (job.lastRequestAt[m.id] || 0) + MODEL_MIN_INTERVAL_MS - Date.now()
      if (wait > 0) {
        st.state = 'waiting'
        st.currentChunk = chunkIndex
        this.mark(job)
        let remaining = wait
        while (remaining > 0 && !job.stopping && !job.earlyStop) {
          const step = Math.min(1000, remaining)
          await sleep(step)
          remaining -= step
        }
        if (job.stopping || job.earlyStop) {
          job.queue.unshift(chunkIndex)
          return
        }
      }

      const chunk = scan.chunks[chunkIndex]
      chunk.status = 'scanning'
      chunk.model = m.id
      chunk.attempts += 1
      st.state = 'active'
      st.currentChunk = chunkIndex
      job.inFlight.add(chunkIndex)
      job.lastRequestAt[m.id] = Date.now()
      const used = incrementModelUsage(m.id, job.apiKey)
      st.usedToday = used
      addLog(scan, 'info', `chunk ${chunkIndex} → ${m.id} (${used}/${m.rpd} today)`)
      this.mark(job)

      let uploadedName: string | null = null
      try {
        const chunkFile = chunkPath(mediaDir, chunkIndex)
        const uploaded = await uploadVideo(job.ai, chunkFile)
        uploadedName = uploaded.name
        const result = await scanChunkRequest(job.ai, m.id, job.shortUri!, uploaded.uri, job.segmentsText || undefined, job.scan.movieGuess)

        // Server-side false-positive filter: when segments exist, the model's answer is
        // ONLY trusted if it reported per-segment windows of the segment's EXACT duration.
        const segs = scan.shortSegments || []
        const enforced = segs.length > 0 ? enforceSegmentDurations(result, segs) : null
        if (enforced) {
          for (const d of enforced.dropped) {
            addLog(scan, 'warn', `chunk ${chunkIndex}: duration check — ${d.slice(0, 200)}`)
          }
        }
        const accepted = enforced
          ? enforced.match && enforced.confidence >= CONFIDENCE_THRESHOLD
          : result.match && result.confidence >= CONFIDENCE_THRESHOLD

        if (accepted) {
          const base = chunkIndex * CHUNK_SECONDS
          let chunkSeg: [number, number]
          let shortSeg: [number, number]
          let matchedIds: string | undefined
          let confidence: number
          if (enforced) {
            // Rebuild all ranges strictly from VALIDATED per-segment windows.
            const v = enforced.valid
            chunkSeg = [Math.min(...v.map((x) => x.chunkStart)), Math.max(...v.map((x) => x.chunkEnd))]
            shortSeg = [Math.min(...v.map((x) => x.shortStart)), Math.max(...v.map((x) => x.shortEnd))]
            matchedIds = v.map((x) => `S${x.segmentIndex}`).join(', ')
            confidence = enforced.confidence
          } else {
            chunkSeg = parseSegment(result.chunk_segment) || [0, CHUNK_SECONDS]
            shortSeg = parseSegment(result.short_segment) || [0, scan.shortDuration || 60]
            matchedIds = result.matched_segments || undefined
            confidence = result.confidence
          }
          const cand: Candidate = {
            id: crypto.randomBytes(6).toString('hex'),
            chunkIndex,
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
            `match found ${fmt(cand.absSegment[0])}-${fmt(cand.absSegment[1])} conf ${confidence}${matchedIds ? ` [segments: ${matchedIds}]` : ''} (chunk ${chunkIndex}, ${m.id})`,
          )
          // Early stop when accepted matches cover the whole short video.
          if (this.shortFullyCovered(scan)) {
            job.earlyStop = true
            addLog(scan, 'success', 'Accepted matches now cover the FULL short video — cancelling pending chunks')
          }
        } else {
          chunk.status = 'no_match'
          chunk.confidence = enforced ? enforced.confidence : result.confidence
          if (enforced && result.match && !enforced.match) {
            addLog(scan, 'warn', `chunk ${chunkIndex}: model claimed a match but NO segment passed the exact-duration check — rejected as false positive`)
          } else if (result.match) {
            addLog(scan, 'info', `chunk ${chunkIndex}: low confidence (<${CONFIDENCE_THRESHOLD}) — treated as no match`)
          }
        }
        for (const rl of result.rejected_lookalikes || []) {
          addLog(scan, 'info', `chunk ${chunkIndex}: rejected lookalike ${rl.segment} @ ${rl.chunk_range} — ${rl.reason.slice(0, 120)}`)
        }
      } catch (err) {
        const e = err instanceof GeminiError ? err : new GeminiError('other', err instanceof Error ? err.message : String(err))
        if (e.kind === 'rpd' || e.kind === 'unavailable') {
          setModelExhausted(m.id, job.apiKey, m.rpd)
          st.state = 'exhausted'
          chunk.status = 'pending'
          chunk.model = undefined
          // Not the chunk's fault — refund the attempt so it still gets 3 real tries.
          chunk.attempts = Math.max(0, chunk.attempts - 1)
          job.queue.push(chunkIndex)
          addLog(
            scan,
            'warn',
            e.kind === 'unavailable'
              ? `${m.id} unavailable (404/retired) — removed from pool, requeued chunk ${chunkIndex}`
              : `429 (daily quota) on ${m.id} — exhausted, requeued chunk ${chunkIndex}`,
          )
          job.inFlight.delete(chunkIndex)
          if (uploadedName) void deleteFileQuiet(job.ai, uploadedName)
          this.mark(job)
          return
        } else if (e.kind === 'rate') {
          job.cooldownUntil[m.id] = Date.now() + RATE_COOLDOWN_MS
          st.state = 'cooling'
          st.cooldownUntil = job.cooldownUntil[m.id]
          chunk.status = 'pending'
          chunk.model = undefined
          job.queue.push(chunkIndex)
          addLog(scan, 'warn', `429 (rate) on ${m.id} — cooling 60s, requeued chunk ${chunkIndex}`)
        } else {
          // 500 / timeout / parse failure: retry up to 2 more times on another model.
          if (chunk.attempts <= 2) {
            chunk.status = 'pending'
            chunk.model = undefined
            job.queue.push(chunkIndex)
            addLog(scan, 'warn', `error on chunk ${chunkIndex} via ${m.id}: ${e.message.slice(0, 140)} — retry ${chunk.attempts}/3`)
          } else {
            chunk.status = 'failed'
            addLog(scan, 'error', `chunk ${chunkIndex} failed after 3 attempts: ${e.message.slice(0, 140)}`)
          }
        }
      } finally {
        job.inFlight.delete(chunkIndex)
        if (uploadedName) void deleteFileQuiet(job.ai, uploadedName)
        st.currentChunk = null
        this.mark(job)
      }
    }
  }

  /** True when accepted candidates jointly cover the entire short video (2s tolerance). */
  private shortFullyCovered(scan: Scan): boolean {
    if (!scan.shortDuration) return false
    const intervals = scan.candidates
      .map((c) => c.shortSegment)
      .sort((a, b) => a[0] - b[0])
    let covered = 0
    let curStart = -1
    let curEnd = -1
    for (const [s, e] of intervals) {
      if (s > curEnd + 0.5) {
        if (curEnd > curStart) covered += curEnd - curStart
        curStart = s
        curEnd = e
      } else {
        curEnd = Math.max(curEnd, e)
      }
    }
    if (curEnd > curStart) covered += curEnd - curStart
    return covered >= scan.shortDuration - 2
  }

  /** Merge adjacent/overlapping candidates into regions, then verify each at 14fps. */
  private async verificationPass(job: Job) {
    const { scan } = job
    if (scan.candidates.length === 0) {
      scan.regions = []
      return
    }
    scan.status = 'verifying'
    addLog(scan, 'info', 'Starting final verification pass (14 fps)...')
    this.mark(job)

    // Merge candidates whose absolute movie segments overlap or sit in adjacent chunks.
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
    scan.regions = regions
    addLog(scan, 'info', `${regions.length} merged match region(s) to verify`)
    this.mark(job)

    const mediaDir = scanMediaDir(scan.id)
    for (const region of regions) {
      try {
        const shortSeg = path.join(mediaDir, `verify-short-${region.id}.mp4`)
        const movieSeg = path.join(mediaDir, `verify-movie-${region.id}.mp4`)
        await extractSegment(path.join(mediaDir, 'short.mp4'), region.shortStart, region.shortEnd, shortSeg)
        await extractSegment(path.join(mediaDir, 'movie.mp4'), region.movieStart, region.movieEnd, movieSeg)

        const model = await this.pickVerifyModel(job)
        if (!model) {
          addLog(scan, 'warn', `No model available to verify region ${fmt(region.movieStart)}-${fmt(region.movieEnd)} �� keeping scan confidence`)
          region.verified = { match: true, confidence: region.maxConfidence, model: 'unverified', note: 'All models exhausted; using scan confidence' }
          continue
        }
        const wait = (job.lastRequestAt[model.id] || 0) + MODEL_MIN_INTERVAL_MS - Date.now()
        if (wait > 0) await sleep(wait)
        job.lastRequestAt[model.id] = Date.now()
        const used = incrementModelUsage(model.id, job.apiKey)
        this.modelState(job, model).usedToday = used
        addLog(scan, 'info', `verifying region ${fmt(region.movieStart)}-${fmt(region.movieEnd)} → ${model.id} @14fps`)
        this.mark(job)

        const su = await uploadVideo(job.ai, shortSeg)
        const mu = await uploadVideo(job.ai, movieSeg)
        const result = await verifyRequest(job.ai, model.id, su.uri, mu.uri)
        void deleteFileQuiet(job.ai, su.name)
        void deleteFileQuiet(job.ai, mu.name)

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
    const groups: MatchRegion[][] = []
    for (const r of regions) {
      const g = groups.find((grp) => grp.some((x) => r.shortStart < x.shortEnd && x.shortStart < r.shortEnd))
      if (g) g.push(r)
      else groups.push([r])
    }
    for (const g of groups) {
      const matching = g.filter((r) => r.verified?.match)
      const pool = matching.length > 0 ? matching : g
      const best = pool.reduce((a, b) => ((b.verified?.confidence || 0) > (a.verified?.confidence || 0) ? b : a))
      best.selected = true
    }
    this.mark(job)
  }

  private async pickVerifyModel(job: Job, exclude?: Set<string>): Promise<ModelSpec | null> {
    for (const m of MODEL_POOL) {
      if (exclude?.has(m.id)) continue
      if (getModelUsage(m.id, job.apiKey) >= m.rpd) continue
      const cool = job.cooldownUntil[m.id] || 0
      if (cool > Date.now()) continue
      return m
    }
    // Everything excluded but still available? Fall back to any usable model.
    if (exclude && exclude.size > 0) return this.pickVerifyModel(job)
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
