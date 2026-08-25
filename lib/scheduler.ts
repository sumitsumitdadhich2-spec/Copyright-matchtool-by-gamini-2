import path from 'node:path'
import fs from 'node:fs'
import type { GoogleGenAI } from '@google/genai'
import type { Scan, ChunkState, ChunkMatch, CandidateGroup, ShortSegmentState } from './types'
import {
  MODEL_POOL,
  CHUNK_MODEL_POOL,
  VERIFY_MODEL_POOL,
  RESCAN_MODEL_POOL,
  isRescanModel,
  PADDED_VERIFY_MODEL_POOL,
  isPaddedVerifyModel,
  MAX_QUALITY_RETRIES,
  MODEL_MIN_INTERVAL_MS,
  RATE_COOLDOWN_MS,
  CHUNK_SECONDS,
  pacingIntervalMs,
  type ModelSpec,
} from './models'
import {
  getScan,
  saveScan,
  addLog,
  getModelUsage,
  incrementModelUsage,
  setModelExhausted,
  scanMediaDir,
} from './store'
import { chunkPath, cleanupChunks, cleanupClips, extractClipPrecise, extractSegment, segmentPath } from './ffmpeg'
import { chunkOverlapsSegRange, segMovieRange } from './segment-range'
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
  isSuspiciousChunkOutput,
  GeminiError,
  classifyError,
} from './gemini'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Max attempts per chunk before it is marked failed. */
const MAX_CHUNK_ATTEMPTS = 3

/** One API key lane (1-20). Gemini Files API uploads are PER KEY,
 *  so each lane keeps its own uploaded short-SEGMENT URIs (one per minute). */
interface KeyLane {
  idx: number
  apiKey: string
  ai: GoogleGenAI
  /** uploaded short-segment URIs keyed by segment index */
  segUris: Map<number, string>
  /** per-segment in-flight upload locks so two workers never double-upload */
  segUriPromises: Map<number, Promise<string>>
}

interface Job {
  scan: Scan
  lanes: KeyLane[]
  /** the short segment (minute) currently being scanned — workers read this */
  seg: ShortSegmentState | null
  /** chunk queue (indexes) for the CURRENT segment */
  queue: number[]
  inFlight: Set<number>
  /** verification phase: candidate-group queue (indexes into scan.candidateGroups) */
  verifyQueue: number[]
  verifyInFlight: Set<number>
  /** true once the CURRENT minute's chunk workers have all drained — verify
   *  workers keep waiting for new candidates until this flips to true. */
  chunkPhaseDone: boolean
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

/** ABSOLUTE original-movie window of a chunk: chunks cover ONLY the confirmed
 *  trim range, so every chunk's absolute start = trimStart + index * 60. */
function chunkAbsWindow(scan: Scan, chunkIndex: number): { start: number; end: number } {
  const trimStart = scan.movieTrimStart ?? 0
  const rangeEnd = scan.movieTrimEnd ?? scan.movieDuration ?? Number.POSITIVE_INFINITY
  const start = trimStart + chunkIndex * CHUNK_SECONDS
  return { start, end: Math.min(start + CHUNK_SECONDS, rangeEnd) }
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

  /** Synthesize/repair scan.shortSegments. Migration shim: old scans (short was
   *  trimmed to 1 minute) become a single segment that ADOPTS the existing
   *  scan.chunks array by reference, so all prior chunk states are preserved. */
  private ensureSegments(scan: Scan) {
    const dur = scan.shortDuration || CHUNK_SECONDS
    const segCount = Math.max(1, Math.ceil(dur / CHUNK_SECONDS))
    if (!scan.shortSegments || scan.shortSegments.length === 0) {
      scan.shortSegments = Array.from({ length: segCount }, (_, i) => ({
        index: i,
        start: i * CHUNK_SECONDS,
        end: Math.min((i + 1) * CHUNK_SECONDS, dur),
        status: 'pending' as const,
        chunks: i === 0 && Array.isArray(scan.chunks) && scan.chunks.length > 0 ? scan.chunks : [],
      }))
    }
    for (const seg of scan.shortSegments) {
      if (!Array.isArray(seg.chunks)) seg.chunks = []
      while (seg.chunks.length < scan.chunkCount) {
        seg.chunks.push({ index: seg.chunks.length, status: 'pending', attempts: 0 })
      }
      if (seg.chunks.length > scan.chunkCount) seg.chunks = seg.chunks.slice(0, scan.chunkCount)
    }
    if (scan.currentShortSegment === undefined) scan.currentShortSegment = 0
  }

  async start(scanId: string, resume: boolean, userApiKeys?: string[]): Promise<{ ok: boolean; error?: string }> {
    if (this.jobs.has(scanId)) return { ok: false, error: 'Scan already running' }
    // PER-USER KEYS ONLY: the route passes the logged-in user's own keys
    // (from their private Blob file). There is NO shared/global fallback —
    // every user scans strictly on their own keys.
    const apiKeys = userApiKeys ?? []
    if (apiKeys.length === 0) return { ok: false, error: 'No Gemini API key configured for YOUR account. Add your key in Settings first.' }
    const scan = getScan(scanId)
    if (!scan) return { ok: false, error: 'Scan not found' }
    if (!scan.shortDuration || !scan.movieDuration || scan.chunkCount === 0) {
      return { ok: false, error: 'Both videos must be uploaded and chunked before scanning.' }
    }

    // Segments: synthesize/repair the per-minute structure (migration shim for old scans).
    this.ensureSegments(scan)
    const segments = scan.shortSegments!

    // Reset orphaned "scanning" chunks + resume cancelled ones ACROSS ALL segments.
    // PER-MINUTE MOVIE RANGE: chunks outside a minute's chosen movie range are
    // marked cancelled (skipped) so only in-range chunks consume API quota.
    for (const seg of segments) {
      for (const c of seg.chunks) {
        const inRange = chunkOverlapsSegRange(scan, seg, c.index)
        if (c.status === 'scanning') c.status = 'pending'
        if (resume && c.status === 'cancelled' && inRange) c.status = 'pending'
        if (c.status === 'pending' && !inRange) c.status = 'cancelled'
      }
      if (seg.status === 'scanning' || seg.status === 'verifying') seg.status = 'pending'
      if (seg.status === 'done' && seg.chunks.some((c) => c.status === 'pending')) seg.status = 'pending'
    }
    // MINUTE SELECTION: only segments with selected !== false take part in the
    // scan (default = all selected). Unselected minutes are skipped entirely.
    const selectedSegs = segments.filter((s) => s.selected !== false)
    const pendingChunks = selectedSegs.reduce((n, s) => n + s.chunks.filter((c) => c.status === 'pending').length, 0)
    const allSettled = selectedSegs.every((s) => s.chunks.every((c) => c.status !== 'pending' && c.status !== 'scanning'))

    // Verification-only resume: all chunks already mapped but candidate groups
    // still have pending verifier/rescan work (or matches were never verified).
    const hasVerifyWork =
      (scan.candidateGroups || []).some((g) => g.status === 'pending' || g.status === 'verifying' || g.status === 'rescanning') ||
      (!scan.candidateGroups?.length && (scan.matches || []).length > 0 && allSettled)

    if (pendingChunks === 0 && !hasVerifyWork) return { ok: false, error: 'No pending chunks to scan.' }

    // Mirror the first incomplete SELECTED segment's chunks so the UI shows the right minute.
    const firstIncomplete = selectedSegs.find((s) => s.status !== 'done') || selectedSegs[0] || segments[0]
    scan.currentShortSegment = firstIncomplete.index
    scan.chunks = firstIncomplete.chunks

    if (!Array.isArray(scan.matches)) scan.matches = []
    scan.status = 'scanning'
    scan.error = null
    if (!scan.startedAt) scan.startedAt = Date.now()

    // One lane per configured key (1-20, already de-duplicated). All lanes pull
    // chunks from the same shared queue in parallel.
    const lanes: KeyLane[] = apiKeys.map((k, i) => ({
      idx: i + 1,
      apiKey: k,
      ai: getClient(k),
      segUris: new Map(),
      segUriPromises: new Map(),
    }))

    const minuteNote = segments.length > 1 ? ` across ${segments.length} short minutes (scanned sequentially)` : ''
    addLog(
      scan,
      'info',
      resume
        ? `Resuming: ${pendingChunks} chunk(s) pending${minuteNote}`
        : `Scan started: ${pendingChunks} chunk(s) queued${minuteNote} across ${CHUNK_MODEL_POOL.length} chunk models (${CHUNK_MODEL_POOL.map((m) => m.id).join(', ')}) × ${lanes.length} API key(s) — one prompt per chunk`,
    )

    const job: Job = {
      scan,
      lanes,
      seg: null,
      queue: [],
      inFlight: new Set(),
      verifyQueue: [],
      verifyInFlight: new Set(),
      chunkPhaseDone: false,
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

  /** MANUAL chunk retry: reset one chunk and re-run its mapping (chunk models only).
   *  Works while a scan is running (re-queues on the live job) AND after it has
   *  finished (restarts the scheduler in resume mode; the chunk file is re-cut
   *  from the movie automatically if it was cleaned up). */
  async retryChunk(
    scanId: string,
    chunkIndex: number,
    segmentIndex?: number,
    userApiKeys?: string[],
  ): Promise<{ ok: boolean; error?: string }> {
    const job = this.jobs.get(scanId)
    const scan = job ? job.scan : getScan(scanId)
    if (!scan) return { ok: false, error: 'Scan not found' }

    // RESCAN LOCK: a manual retry NEVER starts while the verification queue has
    // pending candidates — verification must fully drain first.
    const pendingVerify = (scan.candidateGroups || []).filter(
      (g) => g.status === 'pending' || g.status === 'verifying' || g.status === 'rescanning',
    ).length
    if (pendingVerify > 0) {
      return {
        ok: false,
        error: `Verification in progress — ${pendingVerify} candidate group(s) pending. Retry tabhi milega jab saare candidates verify ho jayen${job ? '' : ' (Resume karke verification poori karo)'}.`,
      }
    }

    // Resolve the target segment (default: the current/selected minute).
    let seg: ShortSegmentState | null = null
    let chunk: ChunkState | undefined
    if (scan.shortSegments?.length) {
      const si = segmentIndex ?? scan.currentShortSegment ?? 0
      seg = scan.shortSegments[si] ?? null
      if (!seg) return { ok: false, error: `Short minute ${si} not found` }
      chunk = seg.chunks[chunkIndex]
    } else {
      chunk = scan.chunks?.[chunkIndex]
    }
    if (!chunk) return { ok: false, error: `Chunk ${chunkIndex} not found` }

    const isActiveSeg = !seg || !job || job.seg === seg
    if ((chunk.status === 'scanning' || job?.inFlight.has(chunkIndex)) && isActiveSeg) {
      return { ok: false, error: `Chunk ${chunkIndex} is currently in flight — wait for it to finish` }
    }
    if (job && isActiveSeg && job.queue.includes(chunkIndex)) {
      return { ok: false, error: `Chunk ${chunkIndex} is already queued` }
    }
    if (job && !isActiveSeg) {
      return {
        ok: false,
        error: `Scan is busy on minute ${(job.seg?.index ?? 0) + 1} — retry this chunk of minute ${(seg?.index ?? 0) + 1} after the scan finishes`,
      }
    }

    // Reset the chunk and wipe its old evidence — ONLY within this segment's short window.
    const segStart = seg ? seg.start : 0
    const segEnd = seg ? seg.end : Number.POSITIVE_INFINITY
    chunk.status = 'pending'
    chunk.attempts = 0
    chunk.qualityRetries = 0
    chunk.matches = []
    scan.matches = (scan.matches || []).filter(
      (mm) => !(mm.chunkIndex === chunkIndex && mm.shortStart >= segStart && mm.shortStart < segEnd),
    )
    if (scan.candidateGroups?.length) {
      scan.candidateGroups = scan.candidateGroups.filter(
        (g) => !(g.shortStart >= segStart && g.shortStart < segEnd && g.candidates.some((c) => c.chunkIndex === chunkIndex)),
      )
    }
    if (seg && seg.status === 'done') seg.status = 'pending'
    addLog(
      scan,
      'info',
      seg && (scan.shortSegments?.length ?? 0) > 1
        ? `Manual retry: minute ${seg.index + 1} · chunk ${chunkIndex} reset and re-queued for chunk-model mapping`
        : `Manual retry: chunk ${chunkIndex} reset and re-queued for chunk-model mapping`,
    )

    if (job) {
      job.queue.push(chunkIndex)
      this.mark(job)
      return { ok: true }
    }

    // No live job — persist the reset state and restart in resume mode
    // using the SAME user's own keys that were passed in.
    if (scan.status === 'done' || scan.status === 'stopped' || scan.status === 'error') scan.status = 'stopped'
    saveScan(scan)
    return this.start(scanId, true, userApiKeys)
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
   *  lanes 2-20 keep their own suffixed entries so keys never overwrite each other. */
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

  /** Upload ONE short-minute segment file per key lane (Files API uploads are per key).
   *  The segment file is re-cut from the ORIGINAL short.mp4 if it went missing. */
  private async ensureSegmentUri(job: Job, lane: KeyLane, seg: ShortSegmentState): Promise<string> {
    const existing = lane.segUris.get(seg.index)
    if (existing) return existing
    let p = lane.segUriPromises.get(seg.index)
    if (!p) {
      p = (async () => {
        const mediaDir = scanMediaDir(job.scan.id)
        const segDir = path.join(mediaDir, 'segments')
        const file = segmentPath(segDir, seg.index)
        if (!fs.existsSync(file)) {
          fs.mkdirSync(segDir, { recursive: true })
          addLog(job.scan, 'info', `Minute ${seg.index + 1}: segment file missing — re-cutting ${ts(seg.start)}–${ts(seg.end)} from the original short`)
          await extractSegment(path.join(mediaDir, 'short.mp4'), seg.start, seg.end, file)
        }
        addLog(job.scan, 'info', `Uploading short minute ${seg.index + 1} to the scanner (key ${lane.idx})...`)
        this.mark(job)
        const f = await uploadVideo(lane.ai, file)
        lane.segUris.set(seg.index, f.uri)
        addLog(job.scan, 'success', `Short minute ${seg.index + 1} ready on the scanner (key ${lane.idx})`)
        this.mark(job)
        return f.uri
      })().catch((err) => {
        lane.segUriPromises.delete(seg.index)
        throw err
      })
      lane.segUriPromises.set(seg.index, p)
    }
    return p
  }

  private async runScan(job: Job) {
    const { scan } = job
    const segments = scan.shortSegments || []
    const multi = segments.length > 1

    // Reset transient verify states from an interrupted run + queue any groups
    // still pending from a previous session (verification-only resume).
    this.prepareVerifyState(scan)
    this.enqueueNewGroups(job, true)

    // PER-MINUTE PASSES with PIPELINE PARALLELISM: within a minute, the two
    // dedicated CHUNK models map chunks while the separate VERIFY models verify
    // finished chunks' candidates AT THE SAME TIME — neither pipeline ever
    // waits for the other. Minute N+1 still only starts after minute N is
    // fully mapped AND verified (API tokens stay focused on one short minute).
    for (const seg of segments) {
      if (job.stopping) break
      // MINUTE SELECTION: unselected minutes are skipped entirely (quota saver).
      if (seg.selected === false) continue
      const pending = seg.chunks.filter((c) => c.status === 'pending')
      if (pending.length === 0 && seg.status === 'done' && job.verifyQueue.length === 0 && job.verifyInFlight.size === 0) continue

      scan.currentShortSegment = seg.index
      job.seg = seg
      // Mirror: scan.chunks IS this segment's chunks array (same reference),
      // so the existing worker code + UI keep working unchanged.
      scan.chunks = seg.chunks
      scan.status = 'scanning'
      this.mark(job)

      if (pending.length > 0) {
        seg.status = 'scanning'
        job.queue = pending.map((c) => c.index)
        job.chunkPhaseDone = false
        if (multi) {
          const r = segMovieRange(scan, seg)
          const rangeNote = r.custom ? ` (movie range ${ts(r.start)}–${ts(r.end)} only — baaki chunks skipped)` : ''
          addLog(scan, 'info', `Minute ${seg.index + 1}/${segments.length}: scanning short ${ts(seg.start)}–${ts(seg.end)} against ${pending.length} pending movie chunk(s)${rangeNote}`)
        }
        addLog(
          scan,
          'info',
          `Pipeline parallelism ON: chunk models (${CHUNK_MODEL_POOL.map((m) => m.id).join(', ')}) map chunks while verify models check finished candidates in parallel`,
        )
        this.mark(job)

        // CHUNK PIPELINE: one worker per (key lane × CHUNK model) — these
        // workers ONLY do chunk mapping, never verification.
        const chunkWorkers: Promise<void>[] = []
        for (const lane of job.lanes) {
          for (const m of CHUNK_MODEL_POOL) chunkWorkers.push(this.worker(job, lane, m))
        }
        // VERIFY PIPELINE (runs CONCURRENTLY): one worker per (key lane ×
        // VERIFY model) — these ONLY verify candidate groups, never chunk-map.
        // They idle-wait until chunk workers feed the queue, and exit once the
        // chunk phase is done AND the verify queue has fully drained.
        const verifyWorkers: Promise<void>[] = []
        for (const lane of job.lanes) {
          for (const m of VERIFY_MODEL_POOL) verifyWorkers.push(this.verifyWorker(job, lane, m))
        }

        const chunkPhase = Promise.all(chunkWorkers).then(() => {
          job.chunkPhaseDone = true
          // Catch any candidates merged by the very last chunk.
          this.enqueueNewGroups(job)
          if (!job.stopping && !seg.chunks.some((c) => c.status === 'pending' || c.status === 'scanning')) {
            seg.status = 'verifying'
            if (job.verifyQueue.length > 0 || job.verifyInFlight.size > 0) scan.status = 'verifying'
            this.mark(job)
          }
        })
        await Promise.all([chunkPhase, ...verifyWorkers])
      } else {
        // Nothing to map for this minute — verification-only pass.
        job.chunkPhaseDone = true
        this.enqueueNewGroups(job)
        if (job.verifyQueue.length > 0 || job.verifyInFlight.size > 0) {
          seg.status = 'verifying'
          scan.status = 'verifying'
          this.mark(job)
          const verifyWorkers: Promise<void>[] = []
          for (const lane of job.lanes) {
            for (const m of VERIFY_MODEL_POOL) verifyWorkers.push(this.verifyWorker(job, lane, m))
          }
          await Promise.all(verifyWorkers)
        }
      }
      if (job.stopping) break

      // Quota exhausted mid-minute: chunks still pending — do NOT advance.
      if (seg.chunks.some((c) => c.status === 'pending' || c.status === 'scanning')) break

      const leftoverNow = (scan.candidateGroups || []).filter(
        (g) => g.status === 'pending' || g.status === 'verifying' || g.status === 'rescanning',
      )
      if (leftoverNow.length > 0) break // quota exhausted mid-verification — resumable below

      seg.status = 'done'
      if (multi) addLog(scan, 'success', `Minute ${seg.index + 1}/${segments.length} complete — mapped + verified against the whole movie`)
      this.mark(job)
    }

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

    const groups = scan.candidateGroups || []
    const leftover = groups.filter((g) => g.status === 'pending' || g.status === 'verifying' || g.status === 'rescanning')
    const chunksLeft = segments.some((s) => s.chunks.some((c) => c.status === 'pending' || c.status === 'scanning'))

    // Quota ran out mid-scan/mid-verification: keep the scan resumable instead of finishing.
    if (leftover.length > 0 || chunksLeft) {
      scan.status = 'stopped'
      addLog(
        scan,
        'warn',
        leftover.length > 0
          ? `Verification paused: ${leftover.length} group(s) still pending (daily quota exhausted?). Use Resume to continue.`
          : 'Scan paused: chunks still pending (daily quota exhausted?). Use Resume to continue.',
      )
      this.finish(job)
      return
    }

    for (const seg of segments) if (seg.status !== 'done') seg.status = 'done'

    const allChunks = segments.flatMap((s) => s.chunks)
    scan.status = 'done'
    scan.finishedAt = Date.now()
    scan.matches.sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)
    scan.report = {
      totalScanTimeMs: scan.finishedAt - (scan.startedAt || scan.finishedAt),
      chunksScanned: allChunks.filter((c) => c.status === 'match' || c.status === 'no_match').length,
      chunksFailed: allChunks.filter((c) => c.status === 'failed').length,
      modelsUsed: MODEL_POOL.filter((m) => job.lanes.some((l) => getModelUsage(m.id, l.apiKey) > 0)).map((m) => m.id),
      matches: scan.matches,
      groupsTotal: groups.length,
      groupsConfirmed: groups.filter((g) => g.status === 'confirmed').length,
      groupsRejected: groups.filter((g) => g.status === 'rejected').length,
      groupsUnverified: groups.filter((g) => g.status === 'unverified').length,
    }
    addLog(scan, 'success', `Scan complete: ${scan.matches.length} matched segment(s)${multi ? ` across ${segments.length} short minute(s)` : ''}`)
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
    // Incremental: existing groups are kept; only UNVERIFIED chunk-phase matches
    // (verified === undefined) are grouped — so a manually retried chunk's fresh
    // matches get queued for verification without re-verifying finished groups.
    const groups: CandidateGroup[] = scan.candidateGroups || []
    const sorted = [...(scan.matches || [])]
      .filter((m) => m.verified === undefined)
      .sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)
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
        // New evidence for an already-finished group (manual chunk retry) — reopen it.
        if (g.status === 'rejected' || g.status === 'unverified') g.status = 'pending'
      }
    }
    scan.candidateGroups = groups
  }

  /** Reset transient candidate-group states left over from an interrupted run. */
  private prepareVerifyState(scan: Scan) {
    for (const g of scan.candidateGroups || []) {
      if (g.status === 'verifying' || g.status === 'rescanning') g.status = 'pending'
      for (const c of g.candidates) {
        if (c.verdict === 'verifying') c.verdict = 'pending'
        if (c.rescan === 'rescanning') c.rescan = 'pending'
        if (c.rescanVerdict === 'verifying') c.rescanVerdict = 'pending'
      }
    }
  }

  /** Incrementally (re)build candidate groups from fresh unverified matches and
   *  push every pending group that is not already queued or in flight onto the
   *  verify queue. Called after EVERY finished chunk so verification starts the
   *  moment a chunk's candidates exist — the verify pipeline never waits for
   *  the whole chunk phase. Safe against double-queueing (single-threaded). */
  private enqueueNewGroups(job: Job, logResume = false) {
    const { scan } = job
    this.buildCandidateGroups(scan)
    const groups = scan.candidateGroups || []
    let added = 0
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].status !== 'pending') continue
      if (job.verifyQueue.includes(i) || job.verifyInFlight.has(i)) continue
      job.verifyQueue.push(i)
      added++
    }
    if (added > 0) {
      addLog(
        scan,
        'info',
        logResume
          ? `Verification resume: ${added} candidate group(s) still pending — queued across ${job.lanes.length} API key(s) × ${VERIFY_MODEL_POOL.length} verify models`
          : `Verify pipeline: ${added} new candidate group(s) queued (${job.verifyQueue.length} waiting, ${job.verifyInFlight.size} in flight) — chunk models keep scanning in parallel`,
      )
      this.mark(job)
    }
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
        // PIPELINE PARALLELISM: while the chunk phase is still running, verify
        // workers idle-wait — new candidate groups arrive as chunks finish.
        // Only exit once the chunk phase is done AND nothing is in flight.
        if (job.verifyInFlight.size === 0 && job.chunkPhaseDone) {
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

    // ---- PADDING (only for very small segments) ----
    // Segments shorter than 1.5s are too small for Gemini to compare reliably
    // (a 0.4s clip is ~10 frames). Pad BOTH clips equally on each side so the
    // model gets enough context, and tell it EXACTLY where the real target
    // window sits inside the padded clips (so extra padded scenes never confuse it).
    // Final report timestamps stay ORIGINAL — padding is for verification only.
    const segDur = g.shortEnd - g.shortStart
    const needsPad = segDur < 1.5
    const PAD_EACH = 0.75
    const shortTotal = scan.shortDuration || g.shortEnd
    const padBefore = needsPad ? Math.min(PAD_EACH, Math.max(0, g.shortStart)) : 0
    const padAfter = needsPad ? Math.min(PAD_EACH, Math.max(0, shortTotal - g.shortEnd)) : 0
    const tgtStart = padBefore
    const tgtEnd = padBefore + segDur
    const verifyPadNote = needsPad
      ? `IMPORTANT — PADDING NOTE (dhyan se padho):\nDono clips me asli TARGET SEGMENT sirf ${ts(tgtStart)} se ${ts(tgtEnd)} tak hai (har clip ki apni clock par). Is window ke pehle aur baad ka content sirf PADDING hai jo context ke liye joda gaya hai — wahan alag scene ho sakta hai, us se CONFUSE mat hona. SAME/DIFFERENT ka faisla SIRF target window ${ts(tgtStart)}–${ts(tgtEnd)} ke frames aur audio par karo. Agar target window ka footage exact same hai to VERDICT: SAME do, chahe padding area me kuch bhi ho.`
      : undefined
    const rescanPadNote = needsPad
      ? `IMPORTANT — PADDING NOTE (dhyan se padho):\nVideo 1 me asli TARGET SEGMENT sirf ${ts(tgtStart)} se ${ts(tgtEnd)} tak hai (Video 1 ki apni clock par). Uske pehle aur baad ka content sirf PADDING hai — context ke liye joda gaya hai. HISSA 1 me poora Video 1 map karo, lekin MATCH sirf TARGET window ${ts(tgtStart)}–${ts(tgtEnd)} ke liye do — matched movie window ki duration EXACTLY ${segDur.toFixed(3)}s honi chahiye (padding wali duration NAHI).`
      : undefined

    // PADDED clips are LOCKED to gemini-3-flash-preview / gemini-3.5-flash /
    // gemini-3.5-flash-lite for EVERY verify request (thinking HIGH is global).
    // Use the worker's own model when it is one of the three, otherwise pick an
    // available padded-verify model on this key. Non-padded verifies keep `m`.
    const pickVerifyModel = (): ModelSpec => {
      if (!needsPad || isPaddedVerifyModel(m.id)) return m
      const vm = PADDED_VERIFY_MODEL_POOL.find((x) => getModelUsage(x.id, lane.apiKey) < x.rpd)
      if (!vm) {
        throw new GeminiError(
          'other',
          `Padded-verify models (${PADDED_VERIFY_MODEL_POOL.map((x) => x.id).join(', ')}) exhausted on key ${lane.idx} — group re-queued for another key`,
        )
      }
      return vm
    }

    g.status = 'verifying'
    this.mark(job)

    // Cut + upload the short-video segment ONCE for this group (per-key upload).
    // Small segments are cut WITH padding; the padding note tells the model where the target is.
    const shortClipFile = path.join(clipsDir, `${g.id}-short.mp4`)
    await extractClipPrecise(path.join(mediaDir, 'short.mp4'), g.shortStart - padBefore, g.shortEnd + padAfter, shortClipFile)
    if (needsPad) {
      addLog(scan, 'info', `Padding: short segment ${ts(g.shortStart)}–${ts(g.shortEnd)} is only ${segDur.toFixed(3)}s — clips padded (+${padBefore.toFixed(3)}s / +${padAfter.toFixed(3)}s), target window written into the prompt`)
    }
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
        await extractClipPrecise(path.join(mediaDir, 'movie.mp4'), Math.max(0, c.movieStart - padBefore), c.movieEnd + padAfter, movieClipFile)
        const movieClip = await uploadVideo(lane.ai, movieClipFile)
        uploadedNames.push(movieClip.name)

        const vm = pickVerifyModel()
        addLog(scan, 'info', `Verify: short ${ts(g.shortStart)}–${ts(g.shortEnd)} vs movie ${ts(c.movieStart)}–${ts(c.movieEnd)}${needsPad ? ' (padded)' : ''} on ${vm.id} (key ${lane.idx})`)
        const clipSecs = shortDur + padBefore + padAfter + Math.max(1, c.movieEnd - c.movieStart) + padBefore + padAfter
        const raw = await this.paceAndSend(job, lane, vm, clipSecs, () => verifyRequest(lane.ai, vm.id, shortClip.uri, movieClip.uri, verifyPadNote))
        const v = parseVerdict(raw)
        if (!v) throw new GeminiError('other', 'Verifier gave no clear VERDICT line')

        c.verifierModel = vm.id
        c.verifierReason = v.reason
        c.verdict = v.same ? 'same' : 'different'
        this.mark(job)

        if (v.same) {
          g.status = 'confirmed'
          g.confirmedIndex = i
          g.confirmedViaRescan = false
          this.applyGroupResult(job, g)
          addLog(scan, 'success', `CONFIRMED: short ${ts(g.shortStart)}–${ts(g.shortEnd)} = movie ${ts(c.movieStart)}–${ts(c.movieEnd)} (verifier: ${vm.id})`)
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
          // TRIM-AWARE: the chunk's absolute window in the ORIGINAL movie.
          const { start: chunkStart, end: chunkEnd } = chunkAbsWindow(scan, c.chunkIndex)

          // Reuse the original chunk file if it still exists, else cut it fresh from the movie.
          let chunkFile = chunkPath(path.join(mediaDir, 'chunks'), c.chunkIndex)
          if (!fs.existsSync(/*turbopackIgnore: true*/ chunkFile)) {
            chunkFile = path.join(clipsDir, `${g.id}-c${i}-chunk.mp4`)
            await extractClipPrecise(path.join(mediaDir, 'movie.mp4'), chunkStart, chunkEnd, chunkFile)
          }
          const chunkUp = await uploadVideo(lane.ai, chunkFile)
          uploadedNames.push(chunkUp.name)

          // RESCAN is LOCKED to gemini-3-flash-preview / gemini-3.5-flash only —
          // lite models give weak rescan results. Use the worker's own model when
          // it is one of the two, otherwise pick an available rescan model on this key.
          const rm = isRescanModel(m.id)
            ? m
            : RESCAN_MODEL_POOL.find((x) => getModelUsage(x.id, lane.apiKey) < x.rpd)
          if (!rm) {
            throw new GeminiError(
              'other',
              `Rescan models (${RESCAN_MODEL_POOL.map((x) => x.id).join(', ')}) exhausted on key ${lane.idx} — group re-queued for another key`,
            )
          }

          addLog(scan, 'info', `Rescan: hunting short ${ts(g.shortStart)}–${ts(g.shortEnd)} inside full chunk ${c.chunkIndex} on ${rm.id} (key ${lane.idx})`)
          const raw = await this.paceAndSend(job, lane, rm, shortDur + padBefore + padAfter + (chunkEnd - chunkStart), () => rescanRequest(lane.ai, rm.id, shortClip.uri, chunkUp.uri, rescanPadNote))
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
        await extractClipPrecise(path.join(mediaDir, 'movie.mp4'), Math.max(0, c.rescanMovieStart! - padBefore), c.rescanMovieEnd! + padAfter, reFile)
        const reUp = await uploadVideo(lane.ai, reFile)
        uploadedNames.push(reUp.name)

        const rvm = pickVerifyModel()
        addLog(scan, 'info', `Re-verify rescan window movie ${ts(c.rescanMovieStart!)}–${ts(c.rescanMovieEnd!)}${needsPad ? ' (padded)' : ''} on ${rvm.id} (key ${lane.idx})`)
        const reSecs = shortDur + padBefore + padAfter + Math.max(1, c.rescanMovieEnd! - c.rescanMovieStart!) + padBefore + padAfter
        const raw2 = await this.paceAndSend(job, lane, rvm, reSecs, () => verifyRequest(lane.ai, rvm.id, shortClip.uri, reUp.uri, verifyPadNote))
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

  /** Merge a chunk's parsed matches into the scan-level list. Replaces ONLY this
   *  chunk's old entries WITHIN the given short-minute window — the same movie
   *  chunk can legitimately hold matches from other short minutes. */
  private mergeMatches(scan: Scan, chunkIndex: number, matches: ChunkMatch[], seg: ShortSegmentState | null) {
    const segStart = seg ? seg.start : 0
    const segEnd = seg ? seg.end : Number.POSITIVE_INFINITY
    scan.matches = (scan.matches || []).filter(
      (m) => !(m.chunkIndex === chunkIndex && m.shortStart >= segStart && m.shortStart < segEnd),
    )
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
      const seg = job.seg
      if (!seg) return
      const minutePrefix = (scan.shortSegments?.length ?? 0) > 1 ? `Minute ${seg.index + 1} · ` : ''
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

        // The uploaded SHORT file is the current minute's re-encoded segment
        // (uploaded once per key lane per minute; original short.mp4 untouched).
        const shortUri = await this.ensureSegmentUri(job, lane, seg)

        // Upload THIS chunk for THIS key (Files API uploads are per key).
        const chunksDir = path.join(scanMediaDir(scan.id), 'chunks')
        const chunkFile = chunkPath(chunksDir, chunkIndex)
        if (!fs.existsSync(chunkFile)) {
          // Chunk files are cleaned up after a scan finishes — re-cut from the
          // movie so a MANUAL chunk retry works even after completion.
          // TRIM-AWARE: chunk N starts at trimStart + N*60 in the ORIGINAL movie.
          const { start: cs, end: ce } = chunkAbsWindow(scan, chunkIndex)
          fs.mkdirSync(chunksDir, { recursive: true })
          addLog(scan, 'info', `Chunk ${chunkIndex}: chunk file missing — re-cutting ${cs}s–${ce}s from movie`)
          await extractClipPrecise(path.join(scanMediaDir(scan.id), 'movie.mp4'), cs, ce, chunkFile)
        }
        const uploaded = await uploadVideo(lane.ai, chunkFile)
        chunkFileName = uploaded.name

        job.nextFreeAt[rk] = Date.now() + MODEL_MIN_INTERVAL_MS
        const used = incrementModelUsage(m.id, lane.apiKey)
        st.usedToday = used
        this.mark(job)

        addLog(scan, 'info', `${minutePrefix}Chunk ${chunkIndex}: mapping short → movie minute ${chunkIndex} on ${m.id} (key ${lane.idx})`)
        const raw = await mapChunkRequest(lane.ai, m.id, shortUri, uploaded.uri)
        this.recordChunkOutput(chunk, m.id, raw)

        // Model timestamps are LOCAL to the 1-minute segment file — shift them by
        // seg.start so every stored match carries ABSOLUTE short-video seconds.
        // Movie offset is TRIM-AWARE: reported movie times stay absolute to the ORIGINAL movie.
        // ORDERING SAFETY: the segment file is physically at most (seg.end - seg.start)
        // seconds long, so any local timestamp beyond that is a model hallucination.
        // Clamp into the segment window (and drop fully-outside matches) so a
        // minute-2 match can NEVER land at a wrong absolute time and break ordering.
        const segLocalDur = seg.end - seg.start
        const matches = parseChunkMatches(raw, chunkIndex, chunkAbsWindow(scan, chunkIndex).start, m.id)
          .filter((mm) => mm.shortStart < segLocalDur - 0.02 && mm.shortEnd > 0)
          .map((mm) => ({
            ...mm,
            shortStart: seg.start + Math.min(Math.max(0, mm.shortStart), segLocalDur),
            shortEnd: seg.start + Math.min(Math.max(0, mm.shortEnd), segLocalDur),
          }))
          .filter((mm) => mm.shortEnd - mm.shortStart > 0.02)
        chunk.attempts += 1

        // FALSE-RESULT DETECTOR: no NOT FOUND anywhere / fixed-offset A-to-Z
        // extrapolation => auto retry ONCE, then accept whatever comes.
        const suspicion = isSuspiciousChunkOutput(raw, matches)
        if (suspicion && (chunk.qualityRetries || 0) < MAX_QUALITY_RETRIES) {
          chunk.qualityRetries = (chunk.qualityRetries || 0) + 1
          chunk.status = 'pending'
          chunk.matches = []
          job.queue.push(chunkIndex)
          addLog(scan, 'warn', `${minutePrefix}Chunk ${chunkIndex}: SUSPICIOUS output on ${m.id} — ${suspicion}. Auto-retry ${chunk.qualityRetries}/${MAX_QUALITY_RETRIES} queued`)
          this.mark(job)
          continue
        }
        if (suspicion) {
          addLog(scan, 'warn', `Chunk ${chunkIndex}: output still suspicious after ${MAX_QUALITY_RETRIES} auto-retry (${suspicion}) — accepting result, use manual Retry if needed`)
        }

        chunk.matches = matches
        chunk.status = matches.length > 0 ? 'match' : 'no_match'
        this.mergeMatches(scan, chunkIndex, matches, seg)
        // PIPELINE PARALLELISM: this chunk's candidates go to the verify queue
        // IMMEDIATELY — the concurrent verify workers pick them up while this
        // chunk model moves straight on to the next chunk.
        if (matches.length > 0) this.enqueueNewGroups(job)

        if (matches.length > 0) {
          addLog(scan, 'success', `${minutePrefix}Chunk ${chunkIndex}: ${matches.length} matched segment(s) found`)
        } else {
          addLog(scan, 'info', `${minutePrefix}Chunk ${chunkIndex}: no segments found in this minute`)
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
          addLog(scan, 'error', `${minutePrefix}Chunk ${chunkIndex} failed after ${chunk.attempts} attempt(s): ${e.message.slice(0, 140)}`)
        } else {
          chunk.status = 'pending'
          job.queue.push(chunkIndex)
          addLog(scan, 'warn', `Chunk ${chunkIndex} attempt ${chunk.attempts} failed on ${m.id} (key ${lane.idx}) �� re-queued: ${e.message.slice(0, 120)}`)
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
