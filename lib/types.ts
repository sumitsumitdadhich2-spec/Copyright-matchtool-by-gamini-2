export type ChunkStatus = 'pending' | 'scanning' | 'no_match' | 'match' | 'failed' | 'cancelled'

export interface ChunkState {
  index: number
  status: ChunkStatus
  model?: string
  attempts: number
  confidence?: number
}

export interface Candidate {
  id: string
  chunkIndex: number
  confidence: number
  /** seconds within the short video [start, end] */
  shortSegment: [number, number]
  /** seconds within the chunk [start, end] */
  chunkSegment: [number, number]
  /** absolute seconds within the movie [start, end] */
  absSegment: [number, number]
  model: string
  note: string
}

export interface MatchRegion {
  id: string
  /** absolute movie seconds */
  movieStart: number
  movieEnd: number
  /** short-video seconds */
  shortStart: number
  shortEnd: number
  candidateIds: string[]
  maxConfidence: number
  verified?: {
    match: boolean
    confidence: number
    model: string
    note: string
  }
  selected?: boolean
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
  | 'verifying'
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
  earlyStopped: boolean
  regions: MatchRegion[]
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
  candidates: Candidate[]
  regions: MatchRegion[]
  logs: LogEntry[]
  startedAt: number | null
  finishedAt: number | null
  earlyStopped: boolean
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
