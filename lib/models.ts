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

/** Accept a segment/chunk match only at or above this confidence (strict: >= 90). */
export const CONFIDENCE_THRESHOLD = 90

/** fps used for the one-time short-video segmentation pass (locked).
 * 15 fps × 60s = 900 frames × 258 tok/frame ≈ 232K tokens — fits under the 250K TPM cap at default resolution. */
export const SEGMENT_FPS = 15

/** fps used during the main scan (locked). */
export const SCAN_FPS = 7

/** fps used during the final verification pass (locked). */
export const VERIFY_FPS = 14

/** fps for LIVE per-segment verification (2-key flow). Both clips are short (<30s combined),
 * so 24fps at default resolution stays well under the 250K TPM cap. */
export const VERIFY_LIVE_FPS = 24

/** fps for the 13fps RESCAN after a verifier rejection: full 1-minute chunk + the rejected
 * short clip in one request. 13fps × ~65s combined ≈ 218K tokens — fits under 250K TPM. */
export const RESCAN_FPS = 13

export const CHUNK_SECONDS = 60
