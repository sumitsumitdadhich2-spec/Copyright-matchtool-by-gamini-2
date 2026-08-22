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
