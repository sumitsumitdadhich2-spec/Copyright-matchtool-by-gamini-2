// Locked model pool: ONLY models with 250K TPM on the free tier.
// Real measured token rate at DEFAULT media resolution is ~65 tokens/frame
// (NOT the 258 in the docs — that figure only applies to MEDIA_RESOLUTION_HIGH).
// Each scan request (short ~60-90s + 60s chunk @ 24 fps) is ~190K-234K tokens,
// so every model is effectively limited to 1 request per minute by TPM regardless of RPM.
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

/** Minimum spacing between requests per model (ms). TPM 250K vs ~190K tokens/request
 * (short + chunk @ 24 fps × 65 tok/frame at default resolution) => 1 req/min. */
export const MODEL_MIN_INTERVAL_MS = 60_000

/** Cooldown applied on RPM/TPM-type 429s (ms). */
export const RATE_COOLDOWN_MS = 60_000

/** Accept a segment/chunk match only at or above this confidence (strict: >= 90). */
export const CONFIDENCE_THRESHOLD = 90

/** A verifier CONFIRM is accepted ONLY at or above this confidence (ultra-strict: >= 97).
 * A CONFIRM is treated as ground truth and shown to the user as a legal copyright match,
 * so it demands near-certainty — anything less is downgraded to REJECT server-side. */
export const VERIFY_CONFIRM_THRESHOLD = 97

/** fps used for the one-time short-video segmentation pass (locked).
 * 24 fps × 60s = 1,440 frames × 65 tok/frame ≈ 93.6K tokens — fits under the 250K TPM cap at default resolution. */
export const SEGMENT_FPS = 24

/** fps used during the main scan (locked).
 * Short + 60s chunk together @ 24 fps × 65 tok/frame ≈ ~190K tokens — fits under the 250K TPM cap at default resolution. */
export const SCAN_FPS = 24

/** fps used during the final verification pass (locked).
 * 24 fps at default resolution ≈ 1,561 tokens/sec of video (24 × 65). */
export const VERIFY_FPS = 24

/** fps for LIVE per-segment verification (2-key flow). Both clips are short (<30s combined),
 * so 24fps at default resolution stays well under the 250K TPM cap. */
export const VERIFY_LIVE_FPS = 24

/** fps for the 24 fps RESCAN after a verifier rejection: full 1-minute chunk + the rejected
 * short clip in one request. 24 fps × ~65s combined × 65 tok/frame ≈ 101K tokens — fits under 250K TPM. */
export const RESCAN_FPS = 24

export const CHUNK_SECONDS = 60
