export type ChunkStatus = 'pending' | 'scanning' | 'no_match' | 'match' | 'failed' | 'cancelled'

/** One parsed "Short X --> Movie Y" mapping line from the model's HISSA 2 output. */
export interface ChunkMatch {
  /** seconds within the short video */
  shortStart: number
  shortEnd: number
  /** ABSOLUTE seconds within the full movie (chunk offset + local chunk time) */
  movieStart: number
  movieEnd: number
  /** which movie chunk this match was found in */
  chunkIndex: number
  model: string
  /** verifier outcome: true = confirmed SAME at 24fps, false = kept but unverified (API errors) */
  verified?: boolean
  /** the confirmed window came from a rescan, not the original chunk mapping */
  viaRescan?: boolean
}

/** Full raw model output captured for a chunk request (for the UI expander). */
export interface ChunkRawOutput {
  model: string
  t: number
  text: string
}

export interface ChunkState {
  index: number
  status: ChunkStatus
  model?: string
  attempts: number
  /** legacy UI field — not set by the current pipeline */
  confidence?: number
  /** parsed HISSA 2 matches found inside THIS chunk (absolute movie seconds) */
  matches?: ChunkMatch[]
  /** full raw Gemini outputs produced for this chunk, oldest first */
  rawOutputs?: ChunkRawOutput[]
}

export interface LogEntry {
  t: number
  level: 'info' | 'warn' | 'error' | 'success'
  msg: string
}

export type ScanStatus =
  | 'created'
  | 'uploading'
  | 'chunking'
  | 'ready'
  | 'scanning'
  /** candidate-verification phase: verifier + rescan requests in flight */
  | 'verifying'
  | 'done'
  | 'stopped'
  | 'error'

// ---------- Candidate + Verifier system ----------

export type CandidateVerdict = 'pending' | 'verifying' | 'same' | 'different' | 'error'
export type RescanState = 'none' | 'pending' | 'rescanning' | 'found' | 'not_found' | 'error'

/** One movie-window candidate for a short segment (one parsed chunk match). */
export interface CandidateEntry {
  /** ABSOLUTE movie seconds */
  movieStart: number
  movieEnd: number
  chunkIndex: number
  /** model that produced this candidate during the chunk phase */
  model: string
  /** verifier verdict for this exact window */
  verdict: CandidateVerdict
  verifierModel?: string
  verifierReason?: string
  /** rescan of this candidate's full 1-minute chunk (runs only if verify said different) */
  rescan: RescanState
  /** window found by the rescan (ABSOLUTE movie seconds), if any */
  rescanMovieStart?: number
  rescanMovieEnd?: number
  /** verifier verdict for the rescan-found window */
  rescanVerdict?: CandidateVerdict
  rescanReason?: string
}

export type CandidateGroupStatus =
  | 'pending' // waiting for a verifier worker
  | 'verifying' // verifier requests in flight
  | 'rescanning' // all candidates failed verify — rescanning their chunks
  | 'confirmed' // a candidate (or rescan window) was verified SAME
  | 'rejected' // every candidate + every rescan failed — final decision: not a match
  | 'unverified' // could not verify due to repeated API errors — original match kept, flagged

/** All candidates that claim the SAME short-video segment, verified as one unit. */
export interface CandidateGroup {
  id: string
  /** seconds within the short video */
  shortStart: number
  shortEnd: number
  status: CandidateGroupStatus
  candidates: CandidateEntry[]
  /** index into candidates[] of the confirmed window (rescan window if confirmedViaRescan) */
  confirmedIndex: number | null
  confirmedViaRescan: boolean
  attempts: number
}

export interface ModelLiveState {
  state: 'idle' | 'active' | 'cooling' | 'exhausted' | 'waiting'
  currentChunk: number | null
  cooldownUntil: number | null
  usedToday: number
}

export interface ScanReport {
  totalScanTimeMs: number
  chunksScanned: number
  chunksFailed: number
  modelsUsed: string[]
  /** all parsed matches across all chunks (absolute movie seconds) */
  matches: ChunkMatch[]
  /** verifier pipeline stats (present when the verification phase ran) */
  groupsTotal?: number
  groupsConfirmed?: number
  groupsRejected?: number
  groupsUnverified?: number
}

export interface Scan {
  id: string
  createdAt: number
  status: ScanStatus
  shortName: string | null
  movieName: string | null
  shortSize: number | null
  movieSize: number | null
  shortDuration: number | null
  movieDuration: number | null
  chunkCount: number
  chunkingProgress: number
  chunks: ChunkState[]
  /** all parsed matches across all chunks, sorted by shortStart (absolute movie seconds) */
  matches: ChunkMatch[]
  /** Candidate + verifier pipeline: one group per claimed short segment */
  candidateGroups?: CandidateGroup[]
  logs: LogEntry[]
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  report: ScanReport | null
  modelStates: Record<string, ModelLiveState>
}

export interface ScanSummary {
  id: string
  createdAt: number
  status: ScanStatus
  movieName: string | null
  shortName: string | null
  movieDuration: number | null
  matchCount: number
  finishedAt: number | null
}
