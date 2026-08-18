import { GoogleGenAI } from '@google/genai'
import { SCAN_FPS, VERIFY_FPS } from './models'

export interface ChunkScanResult {
  match: boolean
  confidence: number
  short_segment: string
  chunk_segment: string
  note: string
}

export type GeminiErrorKind = 'rpd' | 'rate' | 'other'

export class GeminiError extends Error {
  kind: GeminiErrorKind
  constructor(kind: GeminiErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

export function getClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey })
}

/** Upload a local video file to the Gemini Files API and wait until it is ACTIVE. */
export async function uploadVideo(ai: GoogleGenAI, filePath: string): Promise<{ uri: string; name: string }> {
  const file = await ai.files.upload({ file: filePath, config: { mimeType: 'video/mp4' } })
  let f = file
  const deadline = Date.now() + 5 * 60_000
  while (f.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new GeminiError('other', 'File processing timed out')
    await new Promise((r) => setTimeout(r, 2500))
    f = await ai.files.get({ name: f.name! })
  }
  if (f.state !== 'ACTIVE') throw new GeminiError('other', `File upload failed (state=${f.state})`)
  return { uri: f.uri!, name: f.name! }
}

export async function deleteFileQuiet(ai: GoogleGenAI, name: string) {
  try {
    await ai.files.delete({ name })
  } catch {
    // best effort
  }
}

function classifyError(err: unknown): GeminiError {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  const is429 =
    lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota') || lower.includes('rate limit')
  if (is429) {
    // Distinguish daily quota (RPD) from per-minute (RPM/TPM) limits from the message.
    if (
      lower.includes('perday') ||
      lower.includes('per day') ||
      lower.includes('daily') ||
      lower.includes('requests per day') ||
      lower.includes('generaterequestsperday')
    ) {
      return new GeminiError('rpd', msg)
    }
    return new GeminiError('rate', msg)
  }
  return new GeminiError('other', msg)
}

/** Strict JSON parsing with fallback repair when the model wraps JSON in markdown. */
export function parseModelJSON(text: string): ChunkScanResult {
  let raw = text.trim()
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) raw = fence[1].trim()
  if (!raw.startsWith('{')) {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1)
  }
  const parsed = JSON.parse(raw) as Partial<ChunkScanResult>
  return {
    match: Boolean(parsed.match),
    confidence: Number(parsed.confidence) || 0,
    short_segment: String(parsed.short_segment || ''),
    chunk_segment: String(parsed.chunk_segment || ''),
    note: String(parsed.note || ''),
  }
}

const SCAN_PROMPT = `This is a copyright match tool. You are given TWO videos.
Video 1 is a SHORT VIDEO (the clip we are trying to locate).
Video 2 is a ONE-MINUTE CHUNK taken from a full movie.

Does any part of the short video appear in this movie chunk? Compare the actual visual content (scenes, people, actions, camera shots) and audio.

Answer in strict JSON, nothing else:
{"match": true or false, "confidence": 0-100, "short_segment": "mm:ss-mm:ss", "chunk_segment": "mm:ss-mm:ss", "note": "one short sentence"}

Rules:
- "confidence" is how certain you are the SAME footage appears in both.
- "short_segment" = the time range WITHIN the short video that matches.
- "chunk_segment" = the time range WITHIN this movie chunk where it appears.
- If no match: {"match": false, "confidence": 0, "short_segment": "", "chunk_segment": "", "note": "..."}`

const VERIFY_PROMPT = `This is a copyright match verification pass. You are given TWO short videos.
Video 1 is a segment from a SHORT VIDEO. Video 2 is a segment from a MOVIE that was flagged as a possible match.

Carefully compare them frame by frame. Is Video 1's footage the same footage that appears in Video 2?

Answer in strict JSON, nothing else:
{"match": true or false, "confidence": 0-100, "short_segment": "mm:ss-mm:ss", "chunk_segment": "mm:ss-mm:ss", "note": "one short sentence"}`

async function generate(
  ai: GoogleGenAI,
  model: string,
  parts: object[],
): Promise<ChunkScanResult> {
  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: parts as never }],
      config: { responseMimeType: 'application/json', temperature: 0 },
    })
    const text = resp.text
    if (!text) throw new Error('Empty model response')
    try {
      return parseModelJSON(text)
    } catch {
      throw new Error(`Unparseable JSON from model: ${text.slice(0, 200)}`)
    }
  } catch (err) {
    if (err instanceof GeminiError) throw err
    throw classifyError(err)
  }
}

/** Main scan request: short video + one movie chunk at 7 fps, default media resolution. */
export async function scanChunkRequest(
  ai: GoogleGenAI,
  model: string,
  shortUri: string,
  chunkUri: string,
): Promise<ChunkScanResult> {
  return generate(ai, model, [
    { fileData: { fileUri: shortUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
    { fileData: { fileUri: chunkUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
    { text: SCAN_PROMPT },
  ])
}

/** Verification request: matched short segment vs matched movie segment at 14 fps. */
export async function verifyRequest(
  ai: GoogleGenAI,
  model: string,
  shortSegUri: string,
  movieSegUri: string,
): Promise<ChunkScanResult> {
  return generate(ai, model, [
    { fileData: { fileUri: shortSegUri, mimeType: 'video/mp4' }, videoMetadata: { fps: VERIFY_FPS } },
    { fileData: { fileUri: movieSegUri, mimeType: 'video/mp4' }, videoMetadata: { fps: VERIFY_FPS } },
    { text: VERIFY_PROMPT },
  ])
}

/** Parse "mm:ss-mm:ss" (or h:mm:ss) into seconds tuple. Returns null when unparseable. */
export function parseSegment(s: string): [number, number] | null {
  const m = s.match(/(\d+(?::\d+){1,2})\s*[-–]\s*(\d+(?::\d+){1,2})/)
  if (!m) return null
  const toSec = (t: string) => {
    const p = t.split(':').map(Number)
    if (p.some((n) => !Number.isFinite(n))) return null
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2]
    return p[0] * 60 + p[1]
  }
  const a = toSec(m[1])
  const b = toSec(m[2])
  if (a === null || b === null || b <= a) return null
  return [a, b]
}
