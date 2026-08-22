// Locked model pool: ONLY models with 250K TPM on the free tier.
// Real measured token rate at DEFAULT media resolution is ~65 tokens/frame
// (NOT the 258 in the docs — that figure only applies to MEDIA_RESOLUTION_HIGH).
// Each chunk-map request (short ~60-90s + 60s chunk @ 24 fps) is ~190K-234K tokens,
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

/** fps used for every chunk-map request (locked).
 * Short + 60s chunk together @ 24 fps × 65 tok/frame ≈ ~190K tokens — fits under the 250K TPM cap at default resolution. */
export const SCAN_FPS = 24

export const CHUNK_SECONDS = 60
