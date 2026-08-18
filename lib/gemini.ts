import { GoogleGenAI } from '@google/genai'
import { SCAN_FPS, VERIFY_FPS, SEGMENT_FPS } from './models'
import type { ShortSegment } from './types'

export interface RawSegmentMatch {
  /** segment id, e.g. "S1" */
  segment: string
  /** exact time range within the movie chunk, mm:ss.mmm */
  chunk_start: string
  chunk_end: string
  confidence: number
  /** playback speed of the short clip vs the movie, e.g. "1.0x", "0.5x (slowed)", "2x (sped up)" */
  speed: string
}

export interface ChunkScanResult {
  match: boolean
  confidence: number
  short_segment: string
  chunk_segment: string
  matched_segments?: string
  segment_matches?: RawSegmentMatch[]
  note: string
  /** the raw, unparsed model reply text (for debugging/inspection) */
  raw?: string
}

export interface SegmentationResult {
  movieGuess: string
  segments: ShortSegment[]
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
  const segment_matches: RawSegmentMatch[] = Array.isArray(parsed.segment_matches)
    ? parsed.segment_matches
        .map((s) => ({
          segment: String(s?.segment || '').trim(),
          chunk_start: String(s?.chunk_start || '').trim(),
          chunk_end: String(s?.chunk_end || '').trim(),
          confidence: Number(s?.confidence) || 0,
          speed: String(s?.speed || '1.0x').trim(),
        }))
        .filter((s) => s.segment && s.chunk_start && s.chunk_end)
    : []
  return {
    match: Boolean(parsed.match),
    confidence: Number(parsed.confidence) || 0,
    short_segment: String(parsed.short_segment || ''),
    chunk_segment: String(parsed.chunk_segment || ''),
    matched_segments: String(parsed.matched_segments || ''),
    segment_matches,
    note: String(parsed.note || ''),
  }
}

const SEGMENT_PROMPT = `This is a copyright match tool. You are given ONE short video that was cut from a full movie.

Do two things:

1. Identify WHICH MOVIE this short video is most likely from (title). If unsure, give your best guess and say "uncertain".
2. Watch the video carefully and detect every SCENE CHANGE — points where the footage cuts to a different scene, shot, or location. The short may be edited: scenes that are together in the short might come from different places in the movie, and vice versa. Split the short into SEGMENTS, where each segment is one continuous piece of footage (one scene/shot that would be continuous in the source movie). Give segment boundaries with MILLISECOND precision.

Answer in strict JSON, nothing else:
{"movie_guess": "movie title or 'uncertain'", "segments": [{"start": "mm:ss.mmm", "end": "mm:ss.mmm", "description": "one short sentence: what happens in this segment"}]}

Rules:
- Timestamps use mm:ss.mmm (minutes:seconds.milliseconds), e.g. "00:04.320".
- Segments must be in order, non-overlapping, and together cover the whole video.
- Description should mention visual content (people, action, location, camera shot) so each segment is recognizable.`

const SCAN_PROMPT_BASE = `This is a copyright match tool. You are given TWO videos.
Video 1 is a SHORT VIDEO (the clip we are trying to locate).
Video 2 is a ONE-MINUTE CHUNK taken from a full movie.

Does any part of the short video appear in this movie chunk? Compare the actual visual content (scenes, people, actions, camera shots) and audio.

Answer in strict JSON, nothing else:
{"match": true or false, "confidence": 0-100, "short_segment": "mm:ss-mm:ss", "chunk_segment": "mm:ss-mm:ss", "matched_segments": "e.g. S1, S3 or empty", "note": "one short sentence"}

Rules:
- "confidence" is how certain you are the SAME footage appears in both.
- "short_segment" = the time range WITHIN the short video that matches.
- "chunk_segment" = the time range WITHIN this movie chunk where it appears.
- "matched_segments" = which of the listed short-video segments (by id) appear in this chunk.
- If no match: {"match": false, "confidence": 0, "short_segment": "", "chunk_segment": "", "matched_segments": "", "note": "..."}`

function buildScanPrompt(segmentsText?: string, movieGuess?: string | null): string {
  if (!segmentsText) return SCAN_PROMPT_BASE
  const guessLine = movieGuess && movieGuess !== 'uncertain' ? `\nThe short video is believed to be from the movie: ${movieGuess}.` : ''
  return `This is a copyright match tool. You are given TWO videos.
Video 1 is the SHORT VIDEO (the clip we are trying to locate). It was cut from a movie and has ALREADY been split into scene segments.
Video 2 is a ONE-MINUTE CHUNK taken from that full movie.
${guessLine}
The short video's scene segments are (id: start-end within the SHORT video — description):
${segmentsText}

Your job: for EACH segment above, decide whether that exact footage appears anywhere in this one-minute movie chunk, and if so, find the PRECISE time range inside this chunk where it appears.

CRITICAL — DO NOT confuse similar-looking scenes with the same scene. Movies often contain multiple scenes with the same actors, same location, same costumes, and similar camera framing. Those are NOT matches. A segment matches ONLY if the chunk contains the IDENTICAL footage — the exact same take, where every frame is the same recording.

Before reporting any segment as matched, verify ALL of these against the chunk footage:
1. The EXACT same action unfolds in the same order with the same timing (same gestures, same movements, same dialogue mouth movements).
2. The camera shot is identical: same angle, same framing, same camera movement (pan/zoom/static), same cut points.
3. Fine background details match: object positions, extras/background people, lighting, shadows, on-screen text.
4. The faces, expressions, and body positions at the START and at the END of the range match the segment's start and end frames.

If the scene merely LOOKS similar (same characters/location but a different moment, different take, or different camera angle) → it is NOT a match. DO NOT include it in "segment_matches". When in doubt, leave it out — a false match is much worse than a miss.

Confidence scale (per segment): 95-100 = frame-identical, verified start/end frames; 85-94 = same take, very confident; below 85 = do not report it at all.

Work segment by segment. The matched movie range should be almost the SAME DURATION as the short segment — but note the editor may have slowed down or sped up the clip, so the durations can differ. Report that as "speed":
- "1.0x" if the movie footage plays at the same speed as the short segment.
- "0.5x (slowed)" if the short clip is slowed down (movie range is shorter than the short segment).
- "2x (sped up)" if the short clip is sped up (movie range is longer than the short segment).

Give every timestamp with MILLISECOND precision as mm:ss.mmm (e.g. "00:12.480").

Answer in strict JSON, nothing else:
{"match": true or false, "confidence": 0-100, "matched_segments": "comma list of matched segment ids, e.g. S1, S3", "segment_matches": [{"segment": "S1", "chunk_start": "mm:ss.mmm", "chunk_end": "mm:ss.mmm", "confidence": 0-100, "speed": "1.0x"}], "short_segment": "mm:ss-mm:ss", "chunk_segment": "mm:ss-mm:ss", "note": "one short sentence"}

Rules:
- "segment_matches" MUST contain one object for EVERY segment that truly appears in this chunk, each with its own exact "chunk_start"/"chunk_end" (millisecond precision) and per-segment "confidence" (85 minimum — anything you are less sure about must be omitted).
- The duration of each matched chunk range should be close to that segment's own duration in the short video (unless the clip was slowed/sped up — reflect that in "speed").
- "matched_segments" is the comma-separated list of the same segment ids that are in "segment_matches".
- "short_segment"/"chunk_segment" = the overall span covering all matched footage (used as a summary).
- "match" is true if at least one segment matched.
- In "note", state briefly WHICH verification details confirmed the match (or why you rejected similar-looking footage).
- If NOTHING matches: {"match": false, "confidence": 0, "matched_segments": "", "segment_matches": [], "short_segment": "", "chunk_segment": "", "note": "..."}`
}

const VERIFY_PROMPT = `This is a copyright match verification pass. You are given TWO short videos.
Video 1 is a segment from a SHORT VIDEO. Video 2 is a segment from a MOVIE that was flagged as a possible match.

Carefully compare them frame by frame. Is Video 1's footage the IDENTICAL footage (the exact same take, same recording) that appears in Video 2?

WARNING: the earlier pass sometimes flags similar-looking scenes (same actors, same location, similar framing) that are actually DIFFERENT moments or takes. Your job is to catch those false positives. Confirm the match ONLY if the same action unfolds with the same timing, the camera shot/movement is identical, and background details (objects, extras, lighting, on-screen text) line up. Same characters in the same place is NOT enough — reject different takes or nearby moments.

Answer in strict JSON, nothing else:
{"match": true or false, "confidence": 0-100, "short_segment": "mm:ss-mm:ss", "chunk_segment": "mm:ss-mm:ss", "note": "one short sentence: which details confirmed or disproved the match"}`

async function generate(
  ai: GoogleGenAI,
  model: string,
  parts: object[],
  lowResolution = false,
): Promise<ChunkScanResult> {
  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: parts as never }],
      config: {
        responseMimeType: 'application/json',
        temperature: 0,
        ...(lowResolution ? { mediaResolution: 'MEDIA_RESOLUTION_LOW' as never } : {}),
      },
    })
    const text = resp.text
    if (!text) throw new Error('Empty model response')
    try {
      const parsed = parseModelJSON(text)
      parsed.raw = text.trim()
      return parsed
    } catch {
      throw new Error(`Unparseable JSON from model: ${text.slice(0, 200)}`)
    }
  } catch (err) {
    if (err instanceof GeminiError) throw err
    throw classifyError(err)
  }
}

/** Parse "mm:ss.mmm" (or h:mm:ss.mmm / mm:ss) into seconds with millisecond precision. */
export function toSecondsMs(t: string): number | null {
  const m = t.trim().match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/)
  if (!m) return null
  const h = m[1] ? Number(m[1]) : 0
  const min = Number(m[2])
  const sec = Number(m[3])
  if (![h, min, sec].every(Number.isFinite)) return null
  return h * 3600 + min * 60 + sec
}

/** One-time segmentation pass: whole short video at 20 fps → movie guess + scene segments. */
export async function segmentShortRequest(
  ai: GoogleGenAI,
  model: string,
  shortUri: string,
): Promise<SegmentationResult> {
  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: shortUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SEGMENT_FPS } },
            { text: SEGMENT_PROMPT },
          ] as never,
        },
      ],
      config: {
        responseMimeType: 'application/json',
        temperature: 0,
        // 15 fps × 60s = 900 frames × 258 tok/frame ≈ 232K tokens — fits under the 250K TPM cap at default resolution.
      },
    })
    const text = resp.text
    if (!text) throw new Error('Empty model response')
    let raw = text.trim()
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) raw = fence[1].trim()
    if (!raw.startsWith('{')) {
      const start = raw.indexOf('{')
      const end = raw.lastIndexOf('}')
      if (start >= 0 && end > start) raw = raw.slice(start, end + 1)
    }
    const parsed = JSON.parse(raw) as { movie_guess?: string; segments?: { start?: string; end?: string; description?: string }[] }
    const segments: ShortSegment[] = []
    for (const s of parsed.segments || []) {
      const start = toSecondsMs(String(s.start || ''))
      const end = toSecondsMs(String(s.end || ''))
      if (start === null || end === null || end <= start) continue
      segments.push({ index: segments.length + 1, start, end, description: String(s.description || '').slice(0, 300) })
    }
    if (segments.length === 0) throw new Error(`Segmentation returned no valid segments: ${text.slice(0, 200)}`)
    return { movieGuess: String(parsed.movie_guess || 'uncertain'), segments }
  } catch (err) {
    if (err instanceof GeminiError) throw err
    throw classifyError(err)
  }
}

/** Render saved segments as prompt text, e.g. "S1: 00:00.000-00:04.320 — description". */
export function segmentsToPromptText(segments: ShortSegment[]): string {
  const fmt = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec - m * 60
    return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`
  }
  return segments.map((s) => `S${s.index}: ${fmt(s.start)}-${fmt(s.end)} — ${s.description}`).join('\n')
}

/** Main scan request: short video + one movie chunk at 7 fps, default media resolution. */
export async function scanChunkRequest(
  ai: GoogleGenAI,
  model: string,
  shortUri: string,
  chunkUri: string,
  segmentsText?: string,
  movieGuess?: string | null,
): Promise<ChunkScanResult> {
  return generate(ai, model, [
    { fileData: { fileUri: shortUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
    { fileData: { fileUri: chunkUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
    { text: buildScanPrompt(segmentsText, movieGuess) },
  ])
}

/** Verification request: matched short segment vs matched movie segment at 14 fps. */
export async function verifyRequest(
  ai: GoogleGenAI,
  model: string,
  shortSegUri: string,
  movieSegUri: string,
): Promise<ChunkScanResult> {
  // 14 fps at default resolution = ~3.6K tokens/sec of video → only ~69s combined fits in 250K TPM.
  // Low resolution (~0.92K tokens/sec) allows ~4.5 minutes combined — required for longer regions.
  return generate(
    ai,
    model,
    [
      { fileData: { fileUri: shortSegUri, mimeType: 'video/mp4' }, videoMetadata: { fps: VERIFY_FPS } },
      { fileData: { fileUri: movieSegUri, mimeType: 'video/mp4' }, videoMetadata: { fps: VERIFY_FPS } },
      { text: VERIFY_PROMPT },
    ],
    true,
  )
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
