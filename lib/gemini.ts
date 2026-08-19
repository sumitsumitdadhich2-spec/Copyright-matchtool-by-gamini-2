import { GoogleGenAI } from '@google/genai'
import { SCAN_FPS, VERIFY_FPS, SEGMENT_FPS, VERIFY_LIVE_FPS, RESCAN_FPS } from './models'
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

export type GeminiErrorKind = 'rpd' | 'rate' | 'unavailable' | 'other'

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
  // Model retired / not accessible for this API key — permanently remove from pool for the day.
  if (
    lower.includes('no longer available') ||
    (lower.includes('404') && (lower.includes('not found') || lower.includes('models/')))
  ) {
    return new GeminiError('unavailable', msg)
  }
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

/** Extract the JSON block from a model response (strips markdown fences / surrounding prose). */
function extractJsonBlock(text: string): string {
  let raw = text.trim()
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) raw = fence[1].trim()
  if (!raw.startsWith('{')) {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1)
  }
  return raw
}

/** Remove trailing commas before } or ] — string-aware so content inside strings is untouched. */
function stripTrailingCommas(raw: string): string {
  let inStr = false
  let esc = false
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < raw.length && /\s/.test(raw[j])) j++
      if (raw[j] === '}' || raw[j] === ']') continue
    }
    out += c
  }
  return out
}

/** Salvage JSON that was cut off mid-output: keep everything up to the last complete value and close open brackets. */
function salvageTruncatedJson(raw: string): string | null {
  let inStr = false
  let esc = false
  let lastComplete = -1
  const stack: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') stack.push(c)
    else if (c === '}' || c === ']') {
      stack.pop()
      if (stack.length > 0) lastComplete = i
    }
  }
  if (lastComplete < 0) return null
  const prefix = raw.slice(0, lastComplete + 1).replace(/,\s*$/, '')
  // Recompute which brackets are still open in the prefix, then close them.
  inStr = false
  esc = false
  const open: string[] = []
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') open.push(c)
    else if (c === '}' || c === ']') open.pop()
  }
  let out = prefix
  for (let i = open.length - 1; i >= 0; i--) out += open[i] === '{' ? '}' : ']'
  try {
    JSON.parse(out)
    return out
  } catch {
    return null
  }
}

/** Tolerant JSON.parse: tries strict parse, then trailing-comma repair, then truncation salvage. */
export function tolerantJsonParse<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    // fall through to repairs
  }
  const cleaned = stripTrailingCommas(raw)
  try {
    return JSON.parse(cleaned) as T
  } catch {
    // fall through to truncation salvage
  }
  const salvaged = salvageTruncatedJson(cleaned)
  if (salvaged !== null) return JSON.parse(salvaged) as T
  throw new Error('Unrepairable JSON from model')
}

/** Strict JSON parsing with fallback repair when the model wraps JSON in markdown. */
export function parseModelJSON(text: string): ChunkScanResult {
  const raw = extractJsonBlock(text)
  const parsed = tolerantJsonParse<Partial<ChunkScanResult>>(raw)
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
7. AUDIO: dialogue words (if any) QUOTED VERBATIM, music, sound effects during this segment. Spoken dialogue is one of the strongest fingerprints — never summarize it, always quote the exact words.
8. DISTINGUISHING MARKS: what makes THIS segment different from every other similar-looking segment in the video. This is MANDATORY and most important for conversation scenes where the same two people talk across many consecutive shots — for those, the description "woman talking to woman" is USELESS. Instead capture: the exact dialogue line spoken, hand/head positions at start and end, which shoulder the camera looks over, blinks, gestures, background passersby, objects held, and body posture changes.

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
      "audio": "...",
      "distinguishing_marks": "..."
    }
  ]
}

Rules:
- Every cut in the video = a new segment. Do not merge two shots into one segment.
- Segments must be contiguous: each segment's start = previous segment's end.
- Do NOT skip any part of the video. The last segment must end at the video's total duration.
- Write descriptions so specific that a different take of the same scene (same actors, same location, different moment) would FAIL to match them.
- NO TWO SEGMENTS may have interchangeable descriptions. If two of your descriptions could be swapped without anyone noticing, they are BOTH too vague — rewrite them with the exact dialogue words, gestures, and frame details that tell them apart.`

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

ANTI-ECHO RULE (violating this invalidates your whole answer):
- The timestamps in the SEGMENTS list above describe positions in VIDEO 1 (the short). They tell you NOTHING about where footage sits inside Video 2.
- COPYING a segment's start/end timestamps from the list above into "chunk_start"/"chunk_end" is FORBIDDEN. Video 2 is a different file with its own timeline — chunk_start/chunk_end MUST be read off Video 2's own clock by actually locating the frames there.
- It is statistically near-impossible for many segments to sit at the SAME timestamps in the chunk as in the short. If your answer maps segment after segment to identical timestamps (e.g. S5 at 00:10.400-00:12.000 in the short AND at 00:10.400-00:12.000 in the chunk, S6 likewise, ...), you have NOT compared the videos — you have echoed the input. STOP, discard that answer, and re-examine Video 2 frame by frame.
- Claiming "the entire short matches this chunk cut-for-cut, every segment in order" requires the strongest possible evidence: for EACH segment your "evidence" field must cite a concrete visual fingerprint you saw in VIDEO 2 at that exact position (a background object, on-screen text, an extra's position). Generic evidence like "same scene, same actors" is NOT acceptable for such a claim.
- If you cannot genuinely locate a segment's frames inside Video 2, report NO match for it. An honest "no match" is correct; an echoed timestamp is a critical failure.

CRITICAL WARNINGS (false positives must be ELIMINATED):
- Movies contain many similar-looking scenes: same actors, same location, same costumes, similar framing. These are NOT matches. A different moment or a different take of the same scene must be REJECTED even if it looks 90% similar.
- Matching only on the description (e.g. "boy runs to bottle" appears in both) is FORBIDDEN. The frames themselves must be identical.
- Any candidate window whose duration does not equal the segment's exact duration (after accounting for a verified speed change) is a FALSE POSITIVE — put it in "rejected_lookalikes", never in "segment_matches".
- A false positive is much worse than a miss. When in doubt, leave it out and record it in "rejected_lookalikes" with the reason.

CONFIDENCE SCALE (per segment — STRICT):
- 95-100: all five tests passed, start and end frames verified identical.
- 90-94: same take, minor uncertainty (e.g. compression artifacts).
- Below 90: DO NOT report the segment at all. It goes in "rejected_lookalikes" instead. The server DISCARDS anything under 90.

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
- NEVER answer with the whole minute (e.g. chunk range 00:00-01:00). Every match MUST be an individual entry in "segment_matches" with its own exact-duration chunk_start/chunk_end. A match without a per-segment exact-duration window will be DISCARDED by the server.
- The server compares your chunk_start/chunk_end values against the segment list. If most of your matches simply repeat the segments' own short-video timestamps, the entire answer is treated as an echo and DISCARDED. chunk timestamps must come from Video 2's timeline, found by real frame comparison.
- "segment_matches" contains ONLY segments that passed all five tests with confidence >= 90.
- Each segment_matches entry MUST be an exact frame-mapped window: (chunk_end - chunk_start) MUST equal that segment's duration_seconds (adjusted only for a verified speed change). The server measures this and rejects any window that fails.
- "rejected_lookalikes" must list any similar-looking footage you found and WHY you rejected it — this proves you checked properly.
- "match" is true if at least one segment passed.
- "confidence" (top-level) = highest segment confidence, or 0 if nothing matched.
- "short_segment" = the time range WITHIN the short video that matches; "chunk_segment" = the time range WITHIN this chunk covering all matched segments.
- If nothing matches: {"match": false, "confidence": 0, "matched_segments": "", "segment_matches": [], "rejected_lookalikes": [], "short_segment": "", "chunk_segment": "", "note": "..."}`
}

const VERIFY_PROMPT = `This is a STRICT copyright match verification pass. You are given TWO video clips that were cut to (almost) the SAME duration.
Video 1 is a segment cut from a SHORT VIDEO. Video 2 is a segment cut from a MOVIE at the exact position where a scan flagged a match.

If the flag was correct, these two clips are the SAME footage playing in parallel: frame 1 of Video 1 corresponds to frame 1 of Video 2, and every action happens at the same offset in both clips.

METHOD (strict):
1. Compare the FIRST frames of both clips — same shot, same pose, same background object positions.
2. Compare the LAST frames of both clips the same way.
3. Step through the clips in parallel — every action, cut, and camera move must happen at the SAME time offset in both.
4. Aspect ratios may differ (the short may be cropped for vertical format) and colors may be graded/filtered — that is acceptable. Different takes, different moments, or different scenes are NOT.

CONFIDENCE (strict): 90+ ONLY if this is verifiably the same recording frame for frame. Below 90 = reject. A false positive is worse than a miss.

WARNING: The scan that flagged this match may itself have been WRONG (models sometimes echo timestamps without comparing frames). Do NOT assume the clips match just because they were flagged. Your job is to independently DISPROVE the match; only confirm it if the first-frame, last-frame, and parallel-timeline checks genuinely pass. In your "note", cite one concrete visual detail you verified in BOTH clips.

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
    const raw = extractJsonBlock(text)
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
      distinguishing_marks?: string
    }
    const parsed = tolerantJsonParse<{ movie_guess?: string; segments?: RawForensicSegment[] }>(raw)
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

// ---------- LIVE per-segment verification (2-key flow) ----------

export interface LiveVerifyResult {
  verdict: 'CONFIRM' | 'REJECT'
  confidence: number
  /** detailed visual reason — REQUIRED on REJECT (what differs: scene, subjects, motion, timing...) */
  reason: string
  note: string
}

const LIVE_VERIFY_PROMPT = `This is a STRICT frame-by-frame copyright verification at 24 fps. You are given TWO short clips:
Video 1 = a segment cut from a SHORT VIDEO. Video 2 = the window cut from a MOVIE where a scan claims the SAME footage sits.

If the claim is correct these clips are the SAME recording playing in parallel: frame 1 of Video 1 corresponds to frame 1 of Video 2, and every action, cut and camera move happens at the same offset in both.

METHOD (all mandatory):
1. FIRST FRAME: compare the very first frames — same shot, same pose, same background object positions.
2. LAST FRAME: compare the very last frames the same way.
3. PARALLEL TIMELINE: step through both clips together at 24 fps — every movement must occur at the SAME time offset.
4. FINGERPRINTS: at least one unique visual detail (background object, on-screen text, an extra, lighting shape) must be present in BOTH clips at the same moment.
5. Aspect-ratio crops (vertical reframing) and color grading/filters are ACCEPTABLE differences. Different takes, different moments, different scenes, or timing drift are NOT.

The scan that produced this claim may be WRONG (models sometimes echo timestamps without comparing frames). Your job is to try to DISPROVE the match. Only CONFIRM when checks 1-4 genuinely pass.

VERDICT RULES:
- "CONFIRM" ONLY if this is verifiably the same recording frame for frame (confidence 90-100).
- Otherwise "REJECT" — and "reason" MUST spell out exactly WHAT is visually different and WHERE: scene, subjects, clothing, motion, timing offset, camera angle, background objects, on-screen text. Never leave the reason vague; the user reads it to judge the rejection.

Answer in strict JSON, nothing else:
{"verdict": "CONFIRM" or "REJECT", "confidence": 0-100, "reason": "detailed visual reason (mandatory on REJECT, empty string on CONFIRM)", "note": "one concrete visual detail you verified or refuted in BOTH clips"}`

/** LIVE verification: matched short clip vs matched movie window at 24 fps, one request.
 *  Combined duration is always < 30s so default resolution fits the TPM cap. */
export async function liveVerifyRequest(
  ai: GoogleGenAI,
  model: string,
  shortClipUri: string,
  movieClipUri: string,
): Promise<LiveVerifyResult> {
  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: shortClipUri, mimeType: 'video/mp4' }, videoMetadata: { fps: VERIFY_LIVE_FPS } },
            { fileData: { fileUri: movieClipUri, mimeType: 'video/mp4' }, videoMetadata: { fps: VERIFY_LIVE_FPS } },
            { text: LIVE_VERIFY_PROMPT },
          ] as never,
        },
      ],
      config: { responseMimeType: 'application/json', temperature: 0 },
    })
    const text = resp.text
    if (!text) throw new Error('Empty model response')
    const parsed = tolerantJsonParse<Partial<LiveVerifyResult>>(extractJsonBlock(text))
    const verdict = String(parsed.verdict || '').toUpperCase() === 'CONFIRM' ? 'CONFIRM' : 'REJECT'
    return {
      verdict,
      confidence: Number(parsed.confidence) || 0,
      reason: String(parsed.reason || ''),
      note: String(parsed.note || ''),
    }
  } catch (err) {
    if (err instanceof GeminiError) throw err
    throw classifyError(err)
  }
}

/** Context handed to the 13fps rescan after a verifier rejection. */
export interface RescanHistory {
  segmentIndex: number
  segmentDuration: number
  /** forensic prompt text describing ONLY this segment */
  segmentText: string
  /** the first (rejected) window inside the chunk, seconds */
  firstWindow: [number, number]
  firstConfidence: number
  /** verifier's detailed rejection reason */
  rejectionReason: string
  movieGuess?: string | null
}

function buildRescanPrompt(h: RescanHistory): string {
  const fmtT = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec - m * 60
    return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`
  }
  const guessLine = h.movieGuess && h.movieGuess !== 'uncertain' ? `\nThe clip is believed to be from the movie: ${h.movieGuess}.` : ''
  return `You are a forensic video analyst for a Copyright Match Tool doing a RE-CHECK after a failed verification. You are given TWO videos:
- Video 1: ONE short clip (segment S${h.segmentIndex} of a short video) with EXACT duration ${h.segmentDuration.toFixed(3)}s.
- Video 2: the SAME one-minute movie chunk that was scanned before.
${guessLine}
SEGMENT DESCRIPTION (from the original forensic analysis):
${h.segmentText}

HISTORY — WHY YOU ARE RE-CHECKING:
- A previous scan of this exact chunk mapped segment S${h.segmentIndex} to the window ${fmtT(h.firstWindow[0])}-${fmtT(h.firstWindow[1])} (confidence ${h.firstConfidence}).
- An independent 24fps frame-by-frame verification then REJECTED that mapping. The verifier's reason was:
"${h.rejectionReason || 'no reason recorded'}"
- So the window ${fmtT(h.firstWindow[0])}-${fmtT(h.firstWindow[1])} is either WRONG or misaligned. Do NOT simply repeat it unless you can refute the verifier's reason with concrete frame evidence.

TASK: Search this ENTIRE one-minute chunk again, frame by frame, for the SAME-TO-SAME footage of Video 1 — the exact same take, the same recording. Pay special attention to what the verifier said was different, and make sure your new window does not have that problem.

DURATION LOCK: the matched window MUST be EXACTLY ${h.segmentDuration.toFixed(3)}s long (chunk_end - chunk_start = ${h.segmentDuration.toFixed(3)}s within ±0.10s), unless there is a verified speed change (report it in "speed" with the scaled duration justified).

METHOD (strict):
1. Memorize Video 1: start frame, end frame, action timeline.
2. Scan Video 2 completely — do not stop at the first lookalike.
3. For every candidate window run: START FRAME TEST, END FRAME TEST, TIMELINE TEST, CAMERA TEST, FINGERPRINT TEST (unique background details must line up).
4. A match is valid ONLY if all five tests pass — the exact same take, frame for frame.
5. If the correct window is genuinely NOT in this chunk, say so — an honest "no match" is correct. A false positive is much worse than a miss.

CONFIDENCE (strict): 90+ only when all tests pass with frame-level certainty. Below 90 = report no match.

Output strict JSON only, nothing else:
{
  "match": true or false,
  "confidence": 0-100,
  "segment_matches": [
    {"segment": "S${h.segmentIndex}", "chunk_start": "mm:ss.mmm", "chunk_end": "mm:ss.mmm", "confidence": 0-100, "speed": "1.0x", "evidence": "concrete start/end frame fingerprints you saw in VIDEO 2"}
  ],
  "rejected_lookalikes": [{"segment": "S${h.segmentIndex}", "chunk_range": "mm:ss.mmm-mm:ss.mmm", "reason": "why rejected"}],
  "short_segment": "",
  "chunk_segment": "",
  "note": "one short sentence"
}
If nothing matches: {"match": false, "confidence": 0, "segment_matches": [], "rejected_lookalikes": [...], "short_segment": "", "chunk_segment": "", "note": "..."}`
}

/** 13fps RESCAN after a verifier rejection: full 1-minute chunk + rejected short clip + history, one request. */
export async function rescanSegmentRequest(
  ai: GoogleGenAI,
  model: string,
  shortClipUri: string,
  chunkUri: string,
  history: RescanHistory,
): Promise<ChunkScanResult> {
  return generate(ai, model, [
    { fileData: { fileUri: shortClipUri, mimeType: 'video/mp4' }, videoMetadata: { fps: RESCAN_FPS } },
    { fileData: { fileUri: chunkUri, mimeType: 'video/mp4' }, videoMetadata: { fps: RESCAN_FPS } },
    { text: buildRescanPrompt(history) },
  ])
}

/** Render ONE segment's forensic description for the rescan prompt. */
export function singleSegmentPromptText(seg: ShortSegment): string {
  if (seg.forensic) {
    return JSON.stringify({ id: `S${seg.index}`, duration_seconds: Number((seg.end - seg.start).toFixed(3)), ...seg.forensic }, null, 1)
  }
  return `S${seg.index} (${(seg.end - seg.start).toFixed(3)}s): ${seg.description}`
}

/** A segment match that passed server-side duration validation. */
export interface ValidatedSegmentMatch {
  segmentIndex: number
  /** seconds within the chunk */
  chunkStart: number
  chunkEnd: number
  /** seconds within the short video */
  shortStart: number
  shortEnd: number
  confidence: number
  speed: string
}

export interface EnforcedResult {
  match: boolean
  confidence: number
  valid: ValidatedSegmentMatch[]
  /** human-readable reasons for every dropped/rewritten claim (for logs) */
  dropped: string[]
}

/**
 * Server-side FALSE POSITIVE filter. The model is never trusted:
 * - Every claimed segment match must reference a real segment (S1, S2, ...).
 * - chunk_start/chunk_end must parse and the window duration must equal the
 *   segment's EXACT duration (adjusted for a reported speed change) within tolerance.
 * - Whole-chunk answers ("the minute contains scenes") with no valid per-segment
 *   exact-duration windows are REJECTED entirely.
 */
export function enforceSegmentDurations(result: ChunkScanResult, segments: ShortSegment[]): EnforcedResult {
  const dropped: string[] = []
  const valid: ValidatedSegmentMatch[] = []
  const byId = new Map(segments.map((s) => [`S${s.index}`, s]))

  for (const m of result.segment_matches || []) {
    const seg = byId.get(m.segment.trim().toUpperCase())
    if (!seg) {
      dropped.push(`${m.segment}: unknown segment id`)
      continue
    }
    const cs = toSecondsMs(m.chunk_start)
    const ce = toSecondsMs(m.chunk_end)
    if (cs === null || ce === null || ce <= cs) {
      dropped.push(`S${seg.index}: unparseable chunk window "${m.chunk_start}-${m.chunk_end}"`)
      continue
    }
    const segDur = seg.end - seg.start
    // speed = playback speed of the short vs the movie. Short slowed to 0.5x → the
    // original movie window is HALF the short segment's duration.
    const speedNum = Number.parseFloat(m.speed) || 1
    const speedFactor = speedNum > 0.1 && speedNum < 10 ? speedNum : 1
    const expected = segDur * speedFactor
    const tolerance = Math.max(0.35, expected * 0.15)
    const actual = ce - cs
    if (Math.abs(actual - expected) > tolerance) {
      dropped.push(
        `S${seg.index}: duration mismatch — segment is ${segDur.toFixed(3)}s (expected window ${expected.toFixed(3)}s @ ${speedFactor}x) but model reported ${actual.toFixed(3)}s window — rejected as false positive`,
      )
      continue
    }
    valid.push({
      segmentIndex: seg.index,
      chunkStart: cs,
      chunkEnd: ce,
      shortStart: seg.start,
      shortEnd: seg.end,
      confidence: m.confidence,
      speed: m.speed,
    })
  }

  if (result.match && (result.segment_matches?.length || 0) === 0) {
    dropped.push('model claimed a match but gave NO per-segment exact-duration windows — rejected entirely')
  }

  const confidence = valid.length > 0 ? Math.max(...valid.map((v) => v.confidence)) : 0
  return { match: valid.length > 0, confidence, valid, dropped }
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
