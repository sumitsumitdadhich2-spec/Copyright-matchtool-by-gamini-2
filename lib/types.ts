export type ChunkStatus = 'pending' | 'scanning' | 'no_match' | 'match' | 'failed' | 'cancelled'

export interface ChunkState {
  index: number
  status: ChunkStatus
  model?: string
  attempts: number
  confidence?: number
}

/** Forensic-level details captured for a segment during the segmentation pass. */
export interface SegmentForensics {
  action_timeline: string
  camera: string
  subjects: string
  start_frame: string
  end_frame: string
  background_details: string
  audio: string
}

/** One scene segment detected in the short video during the segmentation pass. */
export interface ShortSegment {
  index: number
  /** seconds within the short video, millisecond precision */
  start: number
  end: number
  description: string
  /** full forensic description used for exact-take matching in the scan prompt */
  forensic?: SegmentForensics
}

/** Frame-accurate mapping of ONE short-video segment to its exact location in the movie.
 *  This is the final per-segment result: window durations are validated server-side to
 *  equal the segment's exact duration. Only the best (highest confidence) mapping per
 *  segment is kept. */
export interface SegmentMatch {
  /** short-video segment index (S1, S2, ...) */
  segmentIndex: number
  /** seconds within the short video (from the segmentation scene map) */
  shortStart: number
  shortEnd: number
  /** ABSOLUTE seconds within the full movie — exact same duration as the short segment */
  movieStart: number
  movieEnd: number
  confidence: number
  /** playback speed of the short vs the movie, e.g. "1.0x" */
  speed: string
  model: string
  chunkIndex: number
}

export interface Candidate {
  id: string
  chunkIndex: number
  confidence: number
  /** which short-video segments (e.g. "S1, S3") were found in this chunk */
  matchedSegments?: string
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
  /** which short-video segments (by index) this region was built from */
  segmentIndexes?: number[]
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
  /** final frame-by-frame per-segment map (exact durations) */
  segmentMatches?: SegmentMatch[]
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
  /** Scene segments of the short video detected during the segmentation pass, saved once and reused. */
  shortSegments?: ShortSegment[]
  /** Frame-accurate per-segment matches accumulated during the scan (best per segment). */
  segmentMatches?: SegmentMatch[]
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
