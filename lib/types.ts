export type ChunkStatus = 'pending' | 'scanning' | 'no_match' | 'match' | 'failed' | 'cancelled'

/** Live 24fps verification state of one match.
 *  pending → verifying → confirmed | rejected. failed = verifier could not finish (quota/errors). */
export type MatchVerifyState = 'pending' | 'verifying' | 'confirmed' | 'rejected' | 'failed'

export interface MatchVerification {
  state: MatchVerifyState
  /** how many 24fps verification attempts have run for this match */
  attempts: number
  /** confidence (0-100) returned by the verifier's last verdict */
  confidence?: number
  /** model that produced the last verdict */
  model?: string
  /** which API key lane (1-5) ran the last verification */
  keyLane?: number
  /** verifier's reason (why it is / is not the same footage) */
  reason?: string
}

/** One parsed "Short X --> Movie Y" mapping line from the model's HISSA 2 output.
 *  Every match is a CANDIDATE until the 24fps verifier confirms or rejects it. */
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
  /** 24fps verifier result; absent = never queued for verification */
  verification?: MatchVerification
}

/** Full raw model output captured for a chunk request (for the UI expander). */
export interface ChunkRawOutput {
  /** scan = chunk-map request, verify = 24fps verification request */
  kind?: 'scan' | 'verify'
  model: string
  t: number
  text: string
}

export interface ChunkState {
  index: number
  status: ChunkStatus
  model?: string
  attempts: number
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
  | 'done'
  | 'stopped'
  | 'error'

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
