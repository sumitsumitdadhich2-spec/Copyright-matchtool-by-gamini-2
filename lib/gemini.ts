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
  /** which start/end frame details and fingerprints confirmed this exact take */
  evidence?: string
}

export interface RejectedLookalike {
  segment: string
  chunk_range: string
  reason: string
}

export interface ChunkScanResult {
  match: boolean
  confidence: number
  short_segment: string
  chunk_segment: string
  matched_segments?: string
  segment_matches?: RawSegmentMatch[]
  rejected_lookalikes?: RejectedLookalike[]
  note: string
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
  const segmentMatches: RawSegmentMatch[] = Array.isArray(parsed.segment_matches)
    ? parsed.segment_matches
        .filter((m) => m && typeof m === 'object')
        .map((m) => ({
          segment: String(m.segment || ''),
          chunk_start: String(m.chunk_start || ''),
          chunk_end: String(m.chunk_end || ''),
          confidence: Number(m.confidence) || 0,
          speed: String(m.speed || '1.0x'),
          evidence: String((m as { evidence?: string }).evidence || ''),
        }))
    : []
  const rejected: RejectedLookalike[] = Array.isArray(parsed.rejected_lookalikes)
    ? parsed.rejected_lookalikes
        .filter((r) => r && typeof r === 'object')
        .map((r) => ({
          segment: String(r.segment || ''),
          chunk_range: String(r.chunk_range || ''),
          reason: String(r.reason || ''),
        }))
    : []
  // Derive chunk_segment from per-segment matches when the model omits the global range.
  let chunkSegment = String(parsed.chunk_segment || '')
  if (!chunkSegment && segmentMatches.length > 0) {
    const starts = segmentMatches.map((m) => m.chunk_start).filter(Boolean).sort()
    const ends = segmentMatches.map((m) => m.chunk_end).filter(Boolean).sort()
    if (starts.length && ends.length) chunkSegment = `${starts[0]}-${ends[ends.length - 1]}`
  }
  return {
    match: Boolean(parsed.match),
    confidence: Number(parsed.confidence) || 0,
    short_segment: String(parsed.short_segment || ''),
    chunk_segment: chunkSegment,
    matched_segments: String(parsed.matched_segments || ''),
    segment_matches: segmentMatches,
    rejected_lookalikes: rejected,
    note: String(parsed.note || ''),
  }
}

const SEGMENT_PROMPT = `You are a forensic video analyst working for a Copyright Match Tool. You are given ONE short video that was edited together from clips of a movie.

TASK: Split this short video into its individual scene segments (every cut = new segment), and write a FORENSIC-LEVEL description of each segment. These descriptions will later be used to locate the exact same footage inside the full movie, so they must be detailed enough that the segment can NEVER be confused with a similar-looking scene from the same movie.

Analyze the video at 15 fps precision. All timestamps must be in mm:ss.mmm format (millisecond precision), and segment boundaries must be frame-accurate (aligned to 1/15s = 0.067s steps).

For EACH segment, describe ALL of the following:
1. ACTION TIMELINE: exactly what happens from the first frame to the last frame, in order, with the timing of each movement (e.g. "boy takes 3 steps, kneels at 0.4s into the segment, grabs bottle with right hand at 0.9s").
2. CAMERA: shot type (extreme close-up / close-up / medium / wide), angle (eye-level / low / high / overhead), and camera movement (static / pan left / zoom in / handheld shake), including WHERE in the segment the movement happens.
3. SUBJECTS: every person/creature visible — position in frame, facing direction, clothing details, expressions, and how these CHANGE during the segment.
4. START FRAME: precise description of the very first frame (who is where, pose, what is visible).
5. END FRAME: precise description of the very last frame before the cut.
6. BACKGROUND DETAILS: fixed objects and their positions, lighting direction, weather, colors, any on-screen text, and anything unique (a rock, a footprint, smoke shape) that can be used as a fingerprint.
7. AUDIO: dialogue words (if any), music, sound effects during this segment.

Output strict JSON only, nothing else:
{
  "movie_guess": "movie name or 'uncertain'",
  "total_duration": "mm:ss.mmm",
  "segments": [
    {
      "id": "S1",
      "start": "mm:ss.mmm",
      "end": "mm:ss.mmm",
      "duration_seconds": 1.333,
      "action_timeline": "...",
      "camera": "...",
      "subjects": "...",
      "start_frame": "...",
      "end_frame": "...",
      "background_details": "...",
      "audio": "..."
    }
  ]
}

Rules:
- Every cut in the video = a new segment. Do not merge two shots into one segment.
- Segments must be contiguous: each segment's start = previous segment's end.
- Do NOT skip any part of the video. The last segment must end at the video's total duration.
- Write descriptions so specific that a different take of the same scene (same actors, same location, different moment) would FAIL to match them.`

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
  return `You are a forensic video analyst working for a Copyright Match Tool. You are given TWO videos:
- Video 1: a SHORT VIDEO edited from movie clips. It has already been analyzed and split into scene segments (provided below with forensic descriptions).
- Video 2: a ONE-MINUTE CHUNK cut from the original movie.
${guessLine}
SEGMENTS OF THE SHORT VIDEO:
${segmentsText}

TASK: For EACH segment listed above, determine whether the IDENTICAL footage appears anywhere inside this one-minute chunk, and if it does, report the EXACT time range inside the chunk. You have BOTH videos in front of you — do NOT match based on the text descriptions alone. The descriptions only tell you WHAT to look for; the final decision must come from directly comparing the actual frames of Video 1 against the actual frames of Video 2.

DURATION LOCK (most important rule):
- Every segment has an EXACT duration (duration_seconds in the list above). When you search this chunk, you are looking for a window of EXACTLY that many seconds — no more, no less.
- Example: if a segment lasts 0.875 seconds, find the 0.875-second window in this chunk that contains it. Report chunk_start and chunk_end so that (chunk_end - chunk_start) equals the segment's duration within ±0.10s.
- The scene change map above is authoritative: each segment begins and ends exactly at a cut. The matched chunk window must start on the same frame the segment starts on and end on the same frame the segment ends on.
- If the only candidate window has a different duration, first check for a speed change (slowed/sped up) and report it in "speed" with the scaled duration justified. If durations differ and there is no speed change, it is NOT a match — reject it as a false positive.

METHOD (follow strictly, segment by segment):
1. Watch the segment in Video 1. Memorize its start frame, end frame, and action timeline.
2. Scan Video 2 for footage that could contain this segment.
3. If a candidate region is found, do a FRAME-BY-FRAME comparison:
   a. START FRAME TEST: the first frame of the segment must be visually identical to a frame in the chunk — same pose, same framing, same background object positions.
   b. END FRAME TEST: the last frame of the segment must also be identical to the corresponding chunk frame.
   c. TIMELINE TEST: every action in between must unfold with the SAME timing and in the SAME order.
   d. CAMERA TEST: identical shot type, angle, and camera movement at the same moments.
   e. FINGERPRINT TEST: unique background details (object positions, extras, lighting, smoke shapes, on-screen text) must line up.
4. A match is valid ONLY if ALL five tests pass. This must be the exact same take — the same recording, frame for frame.
5. DURATION CHECK: the matched chunk range must have almost the same duration as the segment. If durations differ, check whether the short clip was slowed down or sped up, and report it in "speed". If durations differ and there is no speed change, it is NOT a valid match.

CRITICAL WARNINGS (false positives must be ELIMINATED):
- Movies contain many similar-looking scenes: same actors, same location, same costumes, similar framing. These are NOT matches. A different moment or a different take of the same scene must be REJECTED even if it looks 90% similar.
- Matching only on the description (e.g. "boy runs to bottle" appears in both) is FORBIDDEN. The frames themselves must be identical.
- Any candidate window whose duration does not equal the segment's exact duration (after accounting for a verified speed change) is a FALSE POSITIVE — put it in "rejected_lookalikes", never in "segment_matches".
- A false positive is much worse than a miss. When in doubt, leave it out and record it in "rejected_lookalikes" with the reason.

CONFIDENCE SCALE (per segment):
- 95-100: all five tests passed, start and end frames verified identical.
- 85-94: same take, minor uncertainty (e.g. compression artifacts).
- Below 85: DO NOT report the segment at all.

All timestamps in mm:ss.mmm (millisecond precision).

Output strict JSON only, nothing else:
{
  "match": true,
  "confidence": 0,
  "matched_segments": "S1, S3",
  "segment_matches": [
    {
      "segment": "S1",
      "chunk_start": "mm:ss.mmm",
      "chunk_end": "mm:ss.mmm",
      "confidence": 96,
      "speed": "1.0x",
      "evidence": "which start/end frame details and fingerprints confirmed this exact take"
    }
  ],
  "rejected_lookalikes": [
    {
      "segment": "S2",
      "chunk_range": "mm:ss.mmm-mm:ss.mmm",
      "reason": "same location and actor but different take: camera angle differs, background extra missing"
    }
  ],
  "short_segment": "mm:ss-mm:ss",
  "chunk_segment": "mm:ss-mm:ss",
  "note": "one-line summary"
}

Rules:
- "segment_matches" contains ONLY segments that passed all five tests with confidence >= 85.
- "rejected_lookalikes" must list any similar-looking footage you found and WHY you rejected it — this proves you checked properly.
- "match" is true if at least one segment passed.
- "confidence" (top-level) = highest segment confidence, or 0 if nothing matched.
- "short_segment" = the time range WITHIN the short video that matches; "chunk_segment" = the time range WITHIN this chunk covering all matched segments.
- If nothing matches: {"match": false, "confidence": 0, "matched_segments": "", "segment_matches": [], "rejected_lookalikes": [], "short_segment": "", "chunk_segment": "", "note": "..."}`
}

const VERIFY_PROMPT = `This is a copyright match verification pass. You are given TWO short videos.
Video 1 is a segment from a SHORT VIDEO. Video 2 is a segment from a MOVIE that was flagged as a possible match.

Carefully compare them frame by frame. Is Video 1's footage the same footage that appears in Video 2?

Answer in strict JSON, nothing else:
{"match": true or false, "confidence": 0-100, "short_segment": "mm:ss-mm:ss", "chunk_segment": "mm:ss-mm:ss", "note": "one short sentence"}`

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
      return parseModelJSON(text)
    } catch {
      throw new Error(`Unparseable JSON from model: ${text.slice(0, 200)}`)
    }
  } catch (err) {
    if (err instanceof GeminiError) throw err
    throw classifyError(err)
  }
}

/** Parse "mm:ss.mmm" (or h:mm:ss.mmm / mm:ss) into seconds with millisecond precision. */
function toSecondsMs(t: string): number | null {
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
    interface RawForensicSegment {
      id?: string
      start?: string
      end?: string
      description?: string
      action_timeline?: string
      camera?: string
      subjects?: string
      start_frame?: string
      end_frame?: string
      background_details?: string
      audio?: string
    }
    const parsed = JSON.parse(raw) as { movie_guess?: string; segments?: RawForensicSegment[] }
    const segments: ShortSegment[] = []
    for (const s of parsed.segments || []) {
      const start = toSecondsMs(String(s.start || ''))
      const end = toSecondsMs(String(s.end || ''))
      if (start === null || end === null || end <= start) continue
      const hasForensic = Boolean(s.action_timeline || s.start_frame || s.end_frame)
      segments.push({
        index: segments.length + 1,
        start,
        end,
        description: String(s.description || s.action_timeline || '').slice(0, 300),
        ...(hasForensic
          ? {
              forensic: {
                action_timeline: String(s.action_timeline || ''),
                camera: String(s.camera || ''),
                subjects: String(s.subjects || ''),
                start_frame: String(s.start_frame || ''),
                end_frame: String(s.end_frame || ''),
                background_details: String(s.background_details || ''),
                audio: String(s.audio || ''),
              },
            }
          : {}),
      })
    }
    if (segments.length === 0) throw new Error(`Segmentation returned no valid segments: ${text.slice(0, 200)}`)
    return { movieGuess: String(parsed.movie_guess || 'uncertain'), segments }
  } catch (err) {
    if (err instanceof GeminiError) throw err
    throw classifyError(err)
  }
}

/** Render saved segments as prompt text — forensic JSON when available, legacy lines otherwise. */
export function segmentsToPromptText(segments: ShortSegment[]): string {
  const fmt = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec - m * 60
    return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`
  }
  const hasForensic = segments.some((s) => s.forensic)
  // Scene-change map: exact cut boundaries + exact duration of every segment.
  // This table is attached to EVERY one-minute movie chunk request.
  const sceneMap = segments
    .map(
      (s) =>
        `S${s.index}: scene change at ${fmt(s.start)} → next scene change at ${fmt(s.end)} — EXACT duration ${(s.end - s.start).toFixed(3)}s`,
    )
    .join('\n')
  const mapBlock = `SCENE CHANGE MAP OF THE SHORT VIDEO (authoritative — a cut happens exactly at each boundary):\n${sceneMap}`
  if (hasForensic) {
    const json = JSON.stringify(
      {
        segments: segments.map((s) => ({
          id: `S${s.index}`,
          start: fmt(s.start),
          end: fmt(s.end),
          duration_seconds: Number((s.end - s.start).toFixed(3)),
          ...(s.forensic || { description: s.description }),
        })),
      },
      null,
      1,
    )
    return `${mapBlock}\n\n${json}`
  }
  return `${mapBlock}\n\n${segments.map((s) => `S${s.index}: ${fmt(s.start)}-${fmt(s.end)} — ${s.description}`).join('\n')}`
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
