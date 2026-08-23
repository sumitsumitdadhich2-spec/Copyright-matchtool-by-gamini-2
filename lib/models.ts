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

/** CHUNK-MAP models (locked): ONLY gemini-3.6-flash and gemini-3.7-flash are
 * allowed to run chunk-time mapping requests. Every other model gives wrong
 * chunk-map results, so they are BANNED from this phase. All API keys run
 * BOTH models in parallel on the shared chunk queue. */
export const CHUNK_MODEL_POOL: ModelSpec[] = [
  { id: 'gemini-3.6-flash', rpm: 5, rpd: 20 },
  { id: 'gemini-3.7-flash', rpm: 5, rpd: 20 },
]

/** VERIFY / RESCAN models: every other available model. Used for candidate
 * verification, rescans, and re-verification — NEVER for chunk mapping.
 * gemini-2.5-flash and gemini-2.5-flash-lite are RETIRED (no longer available). */
export const VERIFY_MODEL_POOL: ModelSpec[] = [
  { id: 'gemini-flash-lite-latest', rpm: 15, rpd: 500 },
  { id: 'gemini-3.1-flash-lite', rpm: 15, rpd: 500 },
  { id: 'gemini-3.5-flash', rpm: 5, rpd: 20 },
  { id: 'gemini-3-flash-preview', rpm: 5, rpd: 20 },
  { id: 'gemini-3.5-flash-lite', rpm: 10, rpd: 20 },
]

/** Full pool (chunk + verify) — used by the UI model board and reports. */
export const MODEL_POOL: ModelSpec[] = [...CHUNK_MODEL_POOL, ...VERIFY_MODEL_POOL]

/** Is this model one of the two locked chunk-map models? */
export function isChunkModel(id: string): boolean {
  return CHUNK_MODEL_POOL.some((m) => m.id === id)
}

/** Max AUTOMATIC quality retries per chunk when the output looks like a false
 * result (extrapolated A-to-Z mapping / zero NOT FOUND lines). After this many
 * auto-retries the result is accepted as-is — quota is precious. */
export const MAX_QUALITY_RETRIES = 1

/** Thinking level for EVERY Gemini request (chunk map, verify, rescan). */
export const THINKING_LEVEL = 'high'

/** Max output tokens for EVERY Gemini request — always the maximum. */
export const MAX_OUTPUT_TOKENS = 65_536

/** Minimum spacing between requests per model (ms). TPM 250K vs ~190K tokens/request
 * (short + chunk @ 24 fps × 65 tok/frame at default resolution) => 1 req/min. */
export const MODEL_MIN_INTERVAL_MS = 60_000

/** Cooldown applied on RPM/TPM-type 429s (ms). */
export const RATE_COOLDOWN_MS = 60_000

/** fps used for every chunk-map request (locked).
 * Short + 60s chunk together @ 24 fps × 65 tok/frame ≈ ~190K tokens — fits under the 250K TPM cap at default resolution. */
export const SCAN_FPS = 24

export const CHUNK_SECONDS = 60

/** Free-tier TPM cap shared by every model in the pool. */
export const TPM_LIMIT = 250_000

/** Measured token cost per video frame at DEFAULT media resolution. */
export const TOKENS_PER_FRAME = 65

/** Estimate the token cost of a request from its total video seconds (all clips combined, 24 fps). */
export function estimateRequestTokens(totalVideoSeconds: number): number {
  return Math.ceil(totalVideoSeconds * SCAN_FPS * TOKENS_PER_FRAME) + 2_000
}

/** Minimum spacing (ms) between requests of this size on one (key × model) lane
 * so the model runs at FULL TPM capacity — small verify clips wait seconds,
 * full chunk-map requests wait the whole minute. */
export function pacingIntervalMs(totalVideoSeconds: number): number {
  const tokens = estimateRequestTokens(totalVideoSeconds)
  const ms = Math.ceil((tokens / TPM_LIMIT) * 60_000)
  return Math.min(MODEL_MIN_INTERVAL_MS, Math.max(3_000, ms))
}
