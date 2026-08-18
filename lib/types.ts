export type ChunkStatus = 'pending' | 'scanning' | 'no_match' | 'match' | 'failed' | 'cancelled'

export interface ChunkState {
  index: number
  status: ChunkStatus
  model?: string
  attempts: number
  confidence?: number
}

/** One scene segment detected in the short video during the 20fps segmentation pass. */
export interface ShortSegment {
  index: number
  /** seconds within the short video, millisecond precision */
  start: number
  end: number
  description: string
}

export interface Candidate {
  id: string
  chunkIndex: number
  confidence: number
  /** which short-video segments (e.g. "S1, S3") were found in this chunk */
  matchedSegments?: string
  /** the single short segment id this candidate maps (e.g. "S1"), when per-segment mapping is available */
  segmentId?: string
  /** playback speed of the short clip vs the movie, e.g. "1.0x", "0.5x (slowed)", "2x (sped up)" */
  speed?: string
  /** one-line description of the short segment (from the segmentation pass) */
  segmentDescription?: string
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
  /** Gemini's guess of which movie the short video is from (segmentation pass). */
  movieGuess?: string | null
  /** Scene segments of the short video detected at 20 fps, saved once and reused. */
  shortSegments?: ShortSegment[]
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
