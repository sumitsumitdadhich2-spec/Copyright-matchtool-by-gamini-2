// Locked model pool: ONLY models with 250K TPM on the free tier.
// Each scan request is ~217K tokens at 7 fps, so every model is
// effectively limited to 1 request per minute by TPM regardless of RPM.
export interface ModelSpec {
  id: string
  rpm: number
  rpd: number
}

export const MODEL_POOL: ModelSpec[] = [
  { id: 'gemini-flash-lite-latest', rpm: 15, rpd: 500 },
  { id: 'gemini-3.1-flash-lite', rpm: 15, rpd: 500 },
  { id: 'gemini-3.6-flash', rpm: 5, rpd: 20 },
  { id: 'gemini-3.5-flash', rpm: 5, rpd: 20 },
  { id: 'gemini-2.5-flash', rpm: 5, rpd: 20 },
  { id: 'gemini-2.5-flash-lite', rpm: 10, rpd: 20 },
]

/** Minimum spacing between requests per model (ms). TPM 250K vs ~217K tokens/request => 1 req/min. */
export const MODEL_MIN_INTERVAL_MS = 60_000

/** Cooldown applied on RPM/TPM-type 429s (ms). */
export const RATE_COOLDOWN_MS = 60_000

/** Accept a chunk match only at or above this confidence. */
export const CONFIDENCE_THRESHOLD = 85

/** fps used for the one-time short-video segmentation pass (locked). */
export const SEGMENT_FPS = 20

/** fps used during the main scan (locked). */
export const SCAN_FPS = 7

/** fps used during the final verification pass (locked). */
export const VERIFY_FPS = 14

export const CHUNK_SECONDS = 60
