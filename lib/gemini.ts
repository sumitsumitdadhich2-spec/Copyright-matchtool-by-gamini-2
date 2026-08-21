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
  /** verbatim model response text (for the per-chunk UI expander) */
  raw?: string
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

TASK: Detect EVERY hard cut in this short video, split it into its true shot segments (every cut = new segment), and write a FORENSIC-LEVEL description of each segment. These descriptions will later be used to locate the exact same footage inside the full movie, so they must be detailed enough that the segment can NEVER be confused with a similar-looking scene from the same movie.

WHAT A CUT IS (this is the core of your job):
- A cut is the exact frame boundary where frame N and frame N+1 belong to DIFFERENT shots: the camera position, framing, or scene content changes abruptly between two consecutive frames.
- Camera movement (pan/zoom/handheld), subject movement, or lighting changes WITHIN one continuous recording are NOT cuts. One continuous take = ONE segment, no matter how long.
- Gradual transitions (dissolve, fade, wipe) are also boundaries — place the boundary at the midpoint of the transition.

MANDATORY TWO-PASS METHOD:
- PASS 1 — CUT DETECTION: step through the video frame by frame at 24 fps and write down the exact timestamp of every shot change you actually SEE. Do not estimate, round, or guess. Boundaries land wherever the real cuts are — at irregular timestamps like 00:03.417, 00:07.208, 00:19.625.
- PASS 2 — DESCRIPTION: only after the full cut list is final, describe each segment using the fields below.

SEGMENT DURATIONS ARE IRREGULAR AND CAN BE TINY:
- Real edits produce segments of wildly different lengths: one segment may be 12 seconds, the next only 0.3 seconds. Fast-cut montages routinely contain shots of just a few frames (0.083s-0.5s).
- There is NO minimum segment length. A 2-frame flash shot is still its own segment. NEVER absorb a very short shot into its neighbor and NEVER skip it.
- NEVER split one continuous shot into multiple segments just to make durations look even.

ABSOLUTE PROHIBITION — DO NOT SLICE BY TIME:
- You are FORBIDDEN from dividing the video into equal or round-numbered intervals (e.g. every 5 seconds: 0-5, 5-10, 10-15...). That is not segmentation, it is fabrication, and the server automatically detects and REJECTS any output where segments have uniform durations or where boundaries all fall on round whole-second marks.
- If your draft output shows several segments with identical durations, or boundaries like 05.000 / 10.000 / 15.000, you did NOT watch the video — go back to PASS 1 and find the real cuts.
- If the video genuinely has no cuts at all, return ONE segment covering the whole video.

Analyze the video at 24 fps precision. All timestamps must be in mm:ss.mmm format (millisecond precision), and segment boundaries must be frame-accurate (aligned to 1/24s = 0.0417s steps).

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
- Every cut in the video = a new segment. Do not merge two shots into one segment, even if the shot is only a few frames long.
- Segments must be contiguous: each segment's start = previous segment's end.
- Do NOT skip any part of the video. The last segment must end at the video's total duration.
- Segment boundaries must come from PASS 1 cut detection — real, observed frame changes. Uniform or round-numbered boundaries will be rejected by the server.
- Write descriptions so specific that a different take of the same scene (same actors, same location, different moment) would FAIL to match them.
- NO TWO SEGMENTS may have interchangeable descriptions. If two of your descriptions could be swapped without anyone noticing, they are BOTH too vague — rewrite them with the exact dialogue words, gestures, and frame details that tell them apart.`

const SCAN_PROMPT_BASE = `You are a forensic video analyst for a copyright match tool. You are given TWO videos.
Video 1 is a SHORT VIDEO (the clip we are trying to locate).
Video 2 is a ONE-MINUTE CHUNK taken from a full movie.

Does any part of the short video appear in this movie chunk as the EXACT SAME RECORDING (same take, frame for frame)? Compare the actual frames: scenes, people, poses, actions, camera shots, background details, and audio (same dialogue words at the same offsets).

YOUR DEFAULT ANSWER IS "NO MATCH". Report a match ONLY when frame-level evidence compels you:
- SIMILAR IS NOT SAME. Same actors / same location / same costumes / similar framing is NOT a match — movies are full of similar-looking moments and alternate takes. A different moment of the same scene must be reported as NO match.
- Never guess or answer from overall plot similarity. If you cannot point to identical start frames, identical end frames, and identical action timing, it is NOT a match.
- The time ranges you report must be read off each video's OWN timeline by actually locating the frames — never invented, never copied from one video to the other.
- One hard contradiction (a mismatched frame, a missing gesture, a different background object) outweighs any number of similarities — reject immediately.
- If the footage is too dark/blurry/short to verify frame identity, that is NOT a match — unverifiable = no match.
- A false positive is far worse than a miss. There is NO penalty for missing — a strict verifier re-checks everything you report, and every false positive you emit wastes an expensive verification pass. When in doubt: {"match": false}.

Answer in strict JSON, nothing else:
{"match": true or false, "confidence": 0-100, "short_segment": "mm:ss-mm:ss", "chunk_segment": "mm:ss-mm:ss", "matched_segments": "e.g. S1, S3 or empty", "note": "one short sentence citing concrete frame evidence"}

Rules:
- "confidence" is how certain you are the SAME footage (same recording) appears in both. 90+ only with frame-level certainty; below 90 report {"match": false}.
- "short_segment" = the time range WITHIN the short video that matches.
- "chunk_segment" = the time range WITHIN this movie chunk where it appears — and its duration must equal the short_segment's duration (same footage = same length, unless visibly speed-changed).
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

REALITY CHECK (read before you start):
- This chunk is ONE minute out of a full movie, while the short's segments are scattered across the whole film. A typical chunk contains ZERO segments; a lucky chunk contains one or a few.
- Finding MANY segments in one chunk is an extraordinary claim. If your draft answer claims most of the listed segments are in this single minute, assume YOU made an error, restart, and re-verify each one against Video 2's actual frames.
- The segments' positions inside the short video are deliberately NOT given to you. The ONLY timeline you can report from is Video 2's own clock (00:00.000 to ~01:00.000). Any timestamp you output must correspond to frames you actually saw at that position in Video 2.

MANDATORY STEP 0 — CHUNK INVENTORY (do this BEFORE looking at any segment):
Watch Video 2 alone, start to finish, and write a "chunk_inventory": 3-8 short lines describing what actually happens in THIS chunk with time ranges from Video 2's own clock (e.g. "00:00-00:14 wide shot of a market street, vendor in red...", "00:14-00:31 interior kitchen, woman chopping..."). Every match you report later MUST be consistent with this inventory — a claimed match at a position whose inventory line describes different content proves you did not look.

DURATION LOCK (most important rule):
- Every segment has an EXACT duration (duration_seconds in the list above). When you search this chunk, you are looking for a window of EXACTLY that many seconds — no more, no less.
- Example: if a segment lasts 0.875 seconds, find the 0.875-second window in this chunk that contains it. Report chunk_start and chunk_end so that (chunk_end - chunk_start) equals the segment's duration within ±0.10s.
- The duration table above is authoritative: each segment begins and ends exactly at a cut. The matched chunk window must start on the same frame the segment starts on and end on the same frame the segment ends on.
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
   f. AUDIO TEST: if audio is available, the same dialogue words, music and sound effects must occur at the same offsets in both. Different or shifted dialogue = not the same take.
4. A match is valid ONLY if ALL six tests pass (audio may be skipped only when no usable audio exists). This must be the exact same take — the same recording, frame for frame.
5. DURATION CHECK: the matched chunk range must have almost the same duration as the segment. If durations differ, check whether the short clip was slowed down or sped up, and report it in "speed". If durations differ and there is no speed change, it is NOT a valid match.

ANTI-FABRICATION RULES (the server checks every one of these and DISCARDS your whole answer on violation):
- CHUNK-START ANCHORING: a real match almost never begins exactly at the chunk's first frame. If your chunk_start is 00:00.000, that is the signature of NOT having looked — you defaulted to the start of Video 2. Re-examine: either find the true irregular position of the frames, or report NO match. chunk_start 00:00.000 is only acceptable if your evidence explicitly states that the segment's first frame is literally the chunk's first frame and cites a fingerprint visible in that exact frame.
- ROUND-NUMBER TIMESTAMPS: real frame positions land at irregular millisecond values (e.g. 00:23.458, 00:41.792). If most of your chunk_start values end in .000 on exact whole seconds, you estimated instead of locating frames — the server rejects such answers. Read the timestamps off the frames you actually matched.
- ONE WINDOW = ONE SEGMENT: two different segments are two different recordings; they can NEVER occupy the same or overlapping windows in this chunk. If two of your matches overlap, at least one is fabricated — remove both and re-examine.
- ONE SEGMENT = ONE PLACE: report at most ONE window per segment in this chunk — the single best frame-verified one. Never report the same segment twice.
- CONFIDENCE 95+ REQUIRES CITED PROOF: you may only give confidence >= 95 when your "evidence" field names at least one unique visual fingerprint you saw in VIDEO 2 inside the claimed window (a specific background object and its position, on-screen text, an extra's action) AND the claimed window is consistent with your chunk_inventory. Without that, cap yourself at 70 — which means the match is dropped. Never inflate confidence to make a match "count": a wrong 100 is the worst possible failure and is how false copyright claims get generated.

ANTI-ECHO RULE (violating this invalidates your whole answer):
- The segments' positions in Video 1 are withheld on purpose. Do NOT try to reconstruct them (e.g. by laying the durations end to end from 00:00) and do NOT report reconstructed positions as chunk timestamps. chunk_start/chunk_end MUST be read off Video 2's own clock by actually locating the frames there.
- If your matches place segment after segment back-to-back in cumulative duration order starting near 00:00, you have reconstructed the short's timeline instead of watching Video 2 — the server detects this pattern and DISCARDS the whole answer. STOP and re-examine Video 2 frame by frame.
- Claiming "the entire short matches this chunk cut-for-cut, every segment in order" requires the strongest possible evidence: for EACH segment your "evidence" field must cite a concrete visual fingerprint you saw in VIDEO 2 at that exact position (a background object, on-screen text, an extra's position), AND that position must be consistent with your chunk_inventory. Generic evidence like "same scene, same actors" is NOT acceptable for such a claim.
- If you cannot genuinely locate a segment's frames inside Video 2, report NO match for it. An honest "no match" is correct; an invented timestamp is a critical failure.

CRITICAL WARNINGS (false positives must be ELIMINATED):
- YOUR DEFAULT ANSWER FOR EVERY SEGMENT IS "NO MATCH". A segment moves to "segment_matches" ONLY when frame evidence forensically compels you — never because it "probably" matches or "looks right".
- Movies contain many similar-looking scenes: same actors, same location, same costumes, similar framing. These are NOT matches. A different moment or a different take of the same scene must be REJECTED even if it looks 90% similar.
- Matching only on the description (e.g. "boy runs to bottle" appears in both) is FORBIDDEN. The frames themselves must be identical.
- Any candidate window whose duration does not equal the segment's exact duration (after accounting for a verified speed change) is a FALSE POSITIVE — put it in "rejected_lookalikes", never in "segment_matches".
- A false positive is much worse than a miss. When in doubt, leave it out and record it in "rejected_lookalikes" with the reason.

CONFIDENCE SCALE (per segment — STRICT):
- 95-100: all six tests passed, start and end frames verified identical.
- 90-94: same take, minor uncertainty (e.g. compression artifacts).
- Below 90: DO NOT report the segment at all. It goes in "rejected_lookalikes" instead. The server DISCARDS anything under 90.

All timestamps in mm:ss.mmm (millisecond precision).

Output strict JSON only, nothing else:
{
  "chunk_inventory": [
    "00:00.000-00:14.200 — what actually happens in this part of the chunk",
    "00:14.200-00:31.500 — ..."
  ],
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
- "chunk_inventory" is REQUIRED and must describe Video 2 only, from its own clock. Matches inconsistent with the inventory are treated as fabricated.
- NEVER answer with the whole minute (e.g. chunk range 00:00-01:00). Every match MUST be an individual entry in "segment_matches" with its own exact-duration chunk_start/chunk_end. A match without a per-segment exact-duration window will be DISCARDED by the server.
- The server knows where every segment sits in the short video and compares your chunk_start/chunk_end values against those positions. If your matches reproduce the short's own timeline (identity or back-to-back cumulative placement), the entire answer is treated as an echo and DISCARDED, and the chunk is rescanned by a different model. chunk timestamps must come from Video 2's timeline, found by real frame comparison.
- "segment_matches" contains ONLY segments that passed all six tests with confidence >= 90.
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

YOUR STANCE: the flagged match is FALSE until proven true. Your job is to DISPROVE it; finding even ONE frame-level difference (pose, timing, background object, dialogue word) proves it is not the same recording.

METHOD (strict):
0. FIRST, watch each clip SEPARATELY and note what you actually see in each (first frame, last frame, timed actions). Only then compare. If your two independent observations describe different content, the match is FALSE — reject immediately.
1. Compare the FIRST frames of both clips — same shot, same pose, same background object positions.
2. Compare the LAST frames of both clips the same way.
3. Step through the clips in parallel — every action, cut, and camera move must happen at the SAME time offset in both (within ~2 frames). Any drift, missing action, or reordering = reject.
4. Verify at least THREE unique fingerprints (background object positions, on-screen text, extras, reflections, prop orientations) present in BOTH clips at the same moment. Generic similarity (same actor, same room, same costume) is NOT a fingerprint.
5. If audio exists: the same dialogue words, music and effects must occur at the same offsets. Different or shifted dialogue = reject.
6. Aspect ratios may differ (the short may be cropped for vertical format) and colors may be graded/filtered — that is acceptable. Different takes, different moments, or different scenes are NOT.
7. ACTIVELY HUNT for differences (hand positions, background extras, cut timings, dialogue timing). Finding even ONE real frame-level difference proves it is NOT the same recording.

CONFIDENCE (ultra-strict): 97+ ONLY if this is verifiably the same recording frame for frame AND every check above passed AND your difference hunt came up empty. Anything below 97 = reject; if you cannot honestly give 97+, doubt remains. A false positive is far worse than a miss — when in doubt, reject.

WARNING: The scan that flagged this match may itself have been WRONG (models sometimes echo timestamps without comparing frames). Do NOT assume the clips match just because they were flagged. Your job is to independently DISPROVE the match; only confirm it if the first-frame, last-frame, and parallel-timeline checks genuinely pass. In your "note", cite one concrete visual detail you verified in BOTH clips.

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
      config: {
        responseMimeType: 'application/json',
        temperature: 0,
        // DEFAULT media resolution only (~65 tok/frame, measured). Never set
        // mediaResolution: LOW/MEDIUM behave the same as default, and HIGH
        // quadruples cost to ~257 tok/frame.
      },
    })
    const text = resp.text
    if (!text) throw new Error('Empty model response')
    try {
      const parsed = parseModelJSON(text)
      parsed.raw = text
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
function toSecondsMs(t: string): number | null {
  const m = t.trim().match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/)
  if (!m) return null
  const h = m[1] ? Number(m[1]) : 0
  const min = Number(m[2])
  const sec = Number(m[3])
  if (![h, min, sec].every(Number.isFinite)) return null
  return h * 3600 + min * 60 + sec
}

/** Detect "lazy" segmentation where the model sliced the video into equal/round intervals
 *  instead of finding real cuts (e.g. 0-5s, 5-10s, 10-15s...). Real edits virtually never
 *  produce several segments with identical durations or all boundaries on exact whole seconds. */
export function looksLikeUniformSlicing(segments: ShortSegment[]): string | null {
  if (segments.length < 3) return null
  const durations = segments.map((s) => s.end - s.start)
  const first = durations[0]
  // All segments the same length (within ~1 frame) = mechanical slicing, not cut detection.
  if (durations.every((d) => Math.abs(d - first) < 0.05)) {
    return `all ${segments.length} segments have identical ${first.toFixed(3)}s durations`
  }
  // 5+ segments whose boundaries ALL land on exact whole seconds (x.000) is equally implausible.
  if (segments.length >= 5) {
    const bounds = segments.flatMap((s) => [s.start, s.end])
    if (bounds.every((b) => Math.abs(b - Math.round(b)) < 0.002)) {
      return `all segment boundaries fall on exact whole seconds — no real cut detection`
    }
  }
  return null
}

/** One-time segmentation pass: whole short video at 24 fps → movie guess + scene segments. */
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
        // 24 fps × 60s = 1,440 frames × 65 tok/frame ≈ 93.6K tokens — fits under the 250K TPM cap at default resolution.
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
                ...(s.distinguishing_marks ? { distinguishing_marks: String(s.distinguishing_marks) } : {}),
              },
            }
          : {}),
      })
    }
    if (segments.length === 0) throw new Error(`Segmentation returned no valid segments: ${text.slice(0, 200)}`)
    const lazy = looksLikeUniformSlicing(segments)
    if (lazy) throw new Error(`Segmentation REJECTED (fabricated time-slices, not real cuts): ${lazy}`)
    return { movieGuess: String(parsed.movie_guess || 'uncertain'), segments }
  } catch (err) {
    if (err instanceof GeminiError) throw err
    throw classifyError(err)
  }
}

/** Render saved segments as prompt text — forensic JSON when available, legacy lines otherwise.
 * DELIBERATELY OMITS the segments' short-video timestamps: models were caught copying ("echoing")
 * those timestamps into chunk_start/chunk_end instead of actually locating frames in the chunk.
 * With only id + duration + description available, echoing positions is physically impossible. */
export function segmentsToPromptText(segments: ShortSegment[]): string {
  const hasForensic = segments.some((s) => s.forensic)
  // Duration table: exact duration of every segment, listed in the order they appear in the short.
  // NO positions given — chunk timestamps must be read off the chunk's own clock.
  const durationTable = segments
    .map((s) => `S${s.index}: EXACT duration ${(s.end - s.start).toFixed(3)}s (segment starts and ends exactly at a hard cut)`)
    .join('\n')
  const mapBlock = `SEGMENT DURATION TABLE (segments are listed in the order they appear in the short video; their positions in the short are withheld on purpose — you must find each one inside the chunk by its FRAMES, and report where it sits on the CHUNK's own timeline):\n${durationTable}`
  if (hasForensic) {
    const json = JSON.stringify(
      {
        segments: segments.map((s) => ({
          id: `S${s.index}`,
          duration_seconds: Number((s.end - s.start).toFixed(3)),
          ...(s.forensic || { description: s.description }),
        })),
      },
      null,
      1,
    )
    return `${mapBlock}\n\n${json}`
  }
  return `${mapBlock}\n\n${segments.map((s) => `S${s.index} (${(s.end - s.start).toFixed(3)}s): ${s.description}`).join('\n')}`
}

/** Main scan request: short video + one movie chunk at 24 fps, default media resolution.
 * Short (~60-90s) + 60s chunk @ 24 fps × 65 tok/frame ≈ ~190K-234K tokens — fits under 250K TPM. */
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

/** Verification request: matched short segment vs matched movie segment at 24 fps. */
export async function verifyRequest(
  ai: GoogleGenAI,
  model: string,
  shortSegUri: string,
  movieSegUri: string,
): Promise<ChunkScanResult> {
  // 24 fps at default resolution ≈ 1,561 tokens/sec of video (24 × 65) →
  // ~160s combined fits in 250K TPM. Default resolution only — never use HIGH (~257 tok/frame).
  return generate(ai, model, [
    { fileData: { fileUri: shortSegUri, mimeType: 'video/mp4' }, videoMetadata: { fps: VERIFY_FPS } },
    { fileData: { fileUri: movieSegUri, mimeType: 'video/mp4' }, videoMetadata: { fps: VERIFY_FPS } },
    { text: VERIFY_PROMPT },
  ])
}

// ---------- LIVE per-segment verification (2-key flow) ----------

export interface LiveVerifyChecks {
  first_frame: string
  last_frame: string
  parallel_timeline: string
  fingerprints: string
  audio: string
}

export interface LiveVerifyResult {
  verdict: 'CONFIRM' | 'REJECT'
  confidence: number
  /** per-test pass/fail results reported by the model (server re-validates these) */
  checks?: Partial<LiveVerifyChecks>
  /** concrete fingerprints the model claims to have verified in BOTH clips */
  fingerprints?: string[]
  /** exact matched extent WITHIN the short clip [start, end] seconds (CONFIRM only) */
  matchedV1?: [number, number] | null
  /** exact matched extent WITHIN the movie clip [start, end] seconds (CONFIRM only) */
  matchedV2?: [number, number] | null
  /** detailed visual reason — REQUIRED on REJECT (what differs: scene, subjects, motion, timing...) */
  reason: string
  note: string
  /** verbatim model response text (for the per-chunk UI expander) */
  raw?: string
}

const LIVE_VERIFY_PROMPT = `You are the FINAL, INDEPENDENT, ADVERSARIAL VERIFIER of a Copyright Match Tool, doing a frame-by-frame comparison at 24 fps. You are given TWO short clips:
Video 1 = a segment cut from a SHORT VIDEO. Video 2 = the window cut from a MOVIE where an earlier scan CLAIMS the same footage sits.

YOUR STANCE: the claim is GUILTY OF BEING FALSE until proven true. Earlier scan models are known to hallucinate matches, echo timestamps without looking at frames, and confuse similar-looking takes. Your ONLY job is to try as hard as possible to DISPROVE the claim. A CONFIRM from you is treated as ground truth by the system and shown to the user as a legal copyright match — a wrong CONFIRM is the worst possible failure. A wrong REJECT merely triggers another search. When ANY doubt remains: REJECT.

IRON RULES (these override everything else):
- SIMILAR IS NOT SAME. Same movie, same scene, same actors, same location, same costumes, same topic of dialogue — NONE of that is evidence. Only frame-level identity counts: the SAME recording, the SAME take, the SAME moment. If you catch yourself thinking "it's clearly the same scene" — that thought is worthless; only "frame N shows the identical pose/object/text in both clips" counts.
- Every "pass" you output MUST be backed by concrete evidence written in your observations. A pass you cannot justify with named specifics (which object, which position, which offset) is a FAIL.
- If ANY phase below cannot be completed properly (clip too dark, too blurry, too short, content unclear, frames unreadable) you MUST REJECT — an unverifiable claim is a false claim.
- You are graded ONLY on never confirming a false match. There is NO penalty for rejecting a true match — the system will simply search again.
- NEVER average your way to a verdict. One hard contradiction outweighs any number of similarities: a single mismatched frame, drifting offset, missing gesture, or different background object = REJECT, no matter how similar everything else looks.

If the claim were true, these clips are the SAME recording playing in parallel: frame 1 of Video 1 corresponds to frame 1 of Video 2, and every action, cut and camera move happens at the same time offset in both.

PHASE 0 — INDEPENDENT OBSERVATION (MANDATORY, do this BEFORE any comparison):
Watch each clip SEPARATELY and write down what you ACTUALLY SEE — do not look at the other clip yet:
- "video1_observation": describe Video 1's first frame, last frame, and every visible action with its time offset (e.g. "0.0s wide shot, man at left edge holding red cup; 0.4s he turns head right; 1.1s cut to close-up...").
- "video2_observation": the same, written independently for Video 2.
These observations are your evidence log. The server reads them: an empty, generic, or copy-pasted observation invalidates your whole answer. If your two observations describe different content but you still say CONFIRM, that is an automatic critical failure.

PHASE 1 — EVENT SYNC MAP (MANDATORY):
From your observations, build "event_map": at least THREE distinct micro-events (a gesture, a blink, a cut, a camera move, an object entering frame) with the time offset at which each occurs in Video 1 AND in Video 2. For the same recording these offsets align within ~2 frames (0.083s). Any event that exists in one clip but not the other, or occurs at a drifting offset, is PROOF of a false match — REJECT immediately and name it in "reason".

PHASE 2 — RUN ALL SIX TESTS — each MUST get an explicit pass/fail verdict in your output:
1. FIRST FRAME TEST ("first_frame"): freeze the very first frame of BOTH clips. Same shot type, same subject pose (limb positions, head direction, eye line), same background object positions, same lighting direction. A pose offset of even a few frames = fail.
2. LAST FRAME TEST ("last_frame"): freeze the very last frame of BOTH clips the same way. If one clip ends mid-action where the other has already finished the action = fail.
3. PARALLEL TIMELINE TEST ("parallel_timeline"): step through both clips together at 24 fps. EVERY movement, gesture, blink, cut and camera move must occur at the SAME offset (within ~2 frames) in both. Any timing drift, missing action, extra action, or reordering = fail.
4. FINGERPRINT TEST ("fingerprints"): find at least THREE unique, hard-to-fake visual details present in BOTH clips at the SAME moment — e.g. a specific background object and its exact position, on-screen text, an extra passing behind, a smoke/dust shape, a reflection, a prop orientation. Generic similarities (same actor, same room, same costume, same lighting) are NOT fingerprints and will be discarded by the server. Fewer than three verified concrete fingerprints = fail.
5. AUDIO TEST ("audio"): if both clips have audio — the same dialogue words, music beats and sound effects must occur at the same offsets. Different or shifted dialogue = fail. If either clip has no usable audio, report "na".
6. ACCEPTABLE DIFFERENCES: aspect-ratio crops (vertical reframing), letterboxing, resolution loss, compression artifacts and color grading/filters are acceptable and must NOT cause a fail on their own. Different takes, different moments of the same scene, or different scenes are NEVER acceptable.

PHASE 3 — ACTIVE DIFFERENCE HUNT (MANDATORY):
Before you are allowed to CONFIRM, you must actively hunt for differences and report the result in "difference_hunt": list every candidate difference you checked (hand positions, background extras, cut timings, object placements, dialogue timing) and why each turned out NOT to be a difference. An honest hunt that finds even ONE real difference = REJECT. If you cannot list at least three checked candidates, you have not hunted — REJECT.

TRAPS THAT HAVE FOOLED VERIFIERS BEFORE (check each explicitly):
- SAME SCENE, DIFFERENT MOMENT: the movie shows this location/conversation for minutes; the claimed window is from the wrong part. The first/last frame tests catch this — do them literally, not from memory.
- DIFFERENT TAKE: same actors, same blocking, nearly identical — but a hand position, background extra, or cut timing differs. Hunt for such micro-differences; finding ONE proves it is not the same recording.
- REPEATED FOOTAGE (flashback/recap): visually identical footage CAN legitimately appear — confirm only if every test passes for THIS window.
- ECHOED TIMESTAMPS: the scan may have copied timestamps without comparing frames. Never assume the clips are aligned; verify alignment yourself from frame 1.
- CONFIRMATION BIAS: you were TOLD these clips should match. Ignore that. Treat them as two random clips until your own frame evidence says otherwise.

VERDICT RULES (ultra-strict):
- "CONFIRM" ONLY if: ALL applicable tests pass ("audio" may be "na") AND at least THREE concrete fingerprints verified AND the event map aligns within 2 frames AND your difference hunt came up empty. Confidence for a CONFIRM must be 98-100 — if you cannot honestly give 98+, it means doubt remains, so REJECT.
- On CONFIRM you MUST also report the EXACT matched extent: "matched_v1_range" and "matched_v2_range" (mm:ss.mmm-mm:ss.mmm, read off each clip's OWN timeline). Usually the full clips match (0 to end); if only part of the clips is the identical recording, report exactly which part in each clip — and note that partial overlap means the claimed window was misaligned, which is itself grounds to REJECT unless the overlap covers essentially the whole clip.
- ANY failed test, ANY unverifiable test, ANY doubt → "REJECT". Confidence reflects how sure you are of the rejection.
- On REJECT, "reason" MUST spell out exactly WHAT is visually different and WHERE: scene, subjects, clothing, motion, timing offset, camera angle, background objects, on-screen text. Never vague — the user reads it.
- NEVER confirm based on plot, actors, location or overall similarity. Only frame-level identity counts.

Answer in strict JSON, nothing else:
{
  "verdict": "CONFIRM" or "REJECT",
  "confidence": 0-100,
  "video1_observation": "first frame, last frame, and timed action list of Video 1 as you actually saw it",
  "video2_observation": "first frame, last frame, and timed action list of Video 2 as you actually saw it",
  "event_map": [
    {"event": "micro-event description", "v1_offset": "s.mmm", "v2_offset": "s.mmm"}
  ],
  "checks": {
    "first_frame": "pass" or "fail",
    "last_frame": "pass" or "fail",
    "parallel_timeline": "pass" or "fail",
    "fingerprints": "pass" or "fail",
    "audio": "pass" or "fail" or "na"
  },
  "fingerprints_verified": ["concrete detail 1 seen in BOTH clips at the same moment", "concrete detail 2", "concrete detail 3"],
  "difference_hunt": ["candidate difference checked and its outcome", "...at least 3 entries..."],
  "matched_v1_range": "mm:ss.mmm-mm:ss.mmm (exact matched extent within Video 1; empty string on REJECT)",
  "matched_v2_range": "mm:ss.mmm-mm:ss.mmm (exact matched extent within Video 2; empty string on REJECT)",
  "reason": "detailed visual reason (mandatory on REJECT, empty string on CONFIRM)",
  "note": "one-line summary citing the strongest single piece of evidence"
}`

/** LIVE verification: matched short clip vs matched movie window at 24 fps, one request.
 *  Combined duration is always < 30s so default resolution fits the TPM cap. */
export async function liveVerifyRequest(
  ai: GoogleGenAI,
  model: string,
  shortClipUri: string,
  movieClipUri: string,
  /** expected clip duration in seconds — used to validate the reported matched extent */
  expectedDuration?: number,
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
    interface RawLiveVerify extends Partial<LiveVerifyResult> {
      fingerprints_verified?: unknown
      video1_observation?: unknown
      video2_observation?: unknown
      event_map?: unknown
      difference_hunt?: unknown
      matched_v1_range?: unknown
      matched_v2_range?: unknown
    }
    const parsed = tolerantJsonParse<RawLiveVerify>(extractJsonBlock(text))
    let verdict: 'CONFIRM' | 'REJECT' = String(parsed.verdict || '').toUpperCase() === 'CONFIRM' ? 'CONFIRM' : 'REJECT'
    let reason = String(parsed.reason || '')

    // Normalize checks + fingerprints reported by the model.
    const rawChecks = (parsed.checks && typeof parsed.checks === 'object' ? parsed.checks : {}) as Record<string, unknown>
    const norm = (v: unknown) => String(v ?? '').trim().toLowerCase()
    const checks: Partial<LiveVerifyChecks> = {
      first_frame: norm(rawChecks.first_frame),
      last_frame: norm(rawChecks.last_frame),
      parallel_timeline: norm(rawChecks.parallel_timeline),
      fingerprints: norm(rawChecks.fingerprints),
      audio: norm(rawChecks.audio),
    }
    const fingerprints = Array.isArray(parsed.fingerprints_verified)
      ? parsed.fingerprints_verified.map((f) => String(f)).filter((f) => f.trim().length > 0)
      : []

    // Evidence-log fields the ultra-strict prompt demands (server re-validates all of them).
    const obs1 = String(parsed.video1_observation || '').trim()
    const obs2 = String(parsed.video2_observation || '').trim()
    interface RawEvent {
      event?: unknown
      v1_offset?: unknown
      v2_offset?: unknown
    }
    const eventMap: { event: string; v1: number | null; v2: number | null }[] = Array.isArray(parsed.event_map)
      ? (parsed.event_map as RawEvent[])
          .filter((e) => e && typeof e === 'object')
          .map((e) => {
            const toOff = (v: unknown): number | null => {
              const s = String(v ?? '').trim()
              if (!s) return null
              // accept "s.mmm" plain seconds or "mm:ss.mmm"
              const plain = Number.parseFloat(s)
              if (/^\d+(?:\.\d+)?$/.test(s) && Number.isFinite(plain)) return plain
              const m = s.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/)
              if (!m) return Number.isFinite(plain) ? plain : null
              return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3])
            }
            return { event: String(e.event || ''), v1: toOff(e.v1_offset), v2: toOff(e.v2_offset) }
          })
          .filter((e) => e.event.trim().length > 0)
      : []
    const diffHunt = Array.isArray(parsed.difference_hunt)
      ? parsed.difference_hunt.map((d) => String(d)).filter((d) => d.trim().length > 0)
      : []
    const confidence = Number(parsed.confidence) || 0

    // SERVER-SIDE OVERRIDE — the model's CONFIRM is NEVER trusted blindly.
    // Every layer of evidence is re-validated; any weakness downgrades to REJECT:
    //  1. every mandatory test must be an explicit "pass"
    //  2. >= 3 concrete fingerprints must be cited
    //  3. independent observations of BOTH clips must be present and substantial
    //  4. an event sync map with >= 3 events must be present, offsets aligned within 0.15s
    //  5. a difference hunt with >= 3 checked candidates must be present
    //  6. confidence must be >= 98 (a CONFIRM below that means doubt remained)
    //  7. the matched extent must be reported and must cover (essentially) the whole clip
    const matchedV1 = parseSegment(String(parsed.matched_v1_range || ''))
    const matchedV2 = parseSegment(String(parsed.matched_v2_range || ''))
    if (verdict === 'CONFIRM') {
      const mandatory: (keyof LiveVerifyChecks)[] = ['first_frame', 'last_frame', 'parallel_timeline', 'fingerprints']
      const failed = mandatory.filter((k) => checks[k] !== 'pass')
      if (checks.audio === 'fail') failed.push('audio')
      const problems: string[] = []
      if (failed.length > 0) problems.push(`test(s) not explicitly passed: ${failed.join(', ')}`)
      if (fingerprints.length < 3) problems.push(`only ${fingerprints.length} concrete fingerprint(s) cited (3 required)`)
      if (obs1.length < 60 || obs2.length < 60)
        problems.push('independent per-clip observations missing or too thin — no proof the model actually watched both clips')
      if (obs1.length >= 60 && obs1 === obs2)
        problems.push('video1/video2 observations are identical text — copy-paste, not independent observation')
      if (eventMap.length < 3) problems.push(`event sync map has only ${eventMap.length} event(s) (3 required)`)
      const misaligned = eventMap.filter((e) => e.v1 !== null && e.v2 !== null && Math.abs(e.v1 - e.v2) > 0.15)
      if (misaligned.length > 0)
        problems.push(
          `event map contradicts CONFIRM — misaligned event(s): ${misaligned.map((e) => `"${e.event.slice(0, 40)}" v1@${e.v1}s vs v2@${e.v2}s`).join('; ')}`,
        )
      if (diffHunt.length < 3) problems.push(`difference hunt has only ${diffHunt.length} checked candidate(s) (3 required)`)
      if (confidence < 98) problems.push(`confidence ${confidence} < 98 — a CONFIRM with residual doubt is not accepted`)
      if (!matchedV1 || !matchedV2) {
        problems.push('matched extent (matched_v1_range/matched_v2_range) missing or unparseable — no proof of WHERE the clips match')
      } else if (expectedDuration && expectedDuration > 0.5) {
        // The extents must cover essentially the whole clip and be equally long.
        const cov1 = (matchedV1[1] - matchedV1[0]) / expectedDuration
        const cov2 = (matchedV2[1] - matchedV2[0]) / expectedDuration
        if (cov1 < 0.85 || cov2 < 0.85)
          problems.push(
            `matched extent covers only ${(Math.min(cov1, cov2) * 100).toFixed(0)}% of the clip — a partial overlap means the claimed window is misaligned`,
          )
        if (Math.abs((matchedV1[1] - matchedV1[0]) - (matchedV2[1] - matchedV2[0])) > 0.5)
          problems.push('matched extents in the two clips have different durations — same recording must match for the same length')
      }
      if (problems.length > 0) {
        verdict = 'REJECT'
        reason = `SERVER OVERRIDE — model said CONFIRM but evidence is insufficient: ${problems.join('; ')}. ${reason}`.trim()
      }
    }

    return {
      verdict,
      confidence,
      checks,
      fingerprints,
      matchedV1,
      matchedV2,
      reason,
      note: String(parsed.note || ''),
      raw: text,
    }
  } catch (err) {
    if (err instanceof GeminiError) throw err
    throw classifyError(err)
  }
}

/** Context handed to the 24 fps rescan after a verifier rejection. */
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
3. For every candidate window run: START FRAME TEST, END FRAME TEST, TIMELINE TEST, CAMERA TEST, FINGERPRINT TEST (unique background details must line up), AUDIO TEST (same dialogue words/music/effects at the same offsets, when audio exists).
4. A match is valid ONLY if all six tests pass — the exact same take, frame for frame. Your DEFAULT answer is "no match"; only concrete frame evidence may flip it.
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

/** 24 fps RESCAN after a verifier rejection: full 1-minute chunk + rejected short clip + history,
 * one request. 24 fps × ~65s combined × 65 tok/frame ≈ 101K tokens — fits under 250K TPM. */
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

/** Parse "mm:ss-mm:ss" (or h:mm:ss / mm:ss.mmm) into seconds tuple. Returns null when unparseable. */
export function parseSegment(s: string): [number, number] | null {
  const m = s.match(/(\d+(?::\d+){1,2}(?:\.\d+)?)\s*[-–]\s*(\d+(?::\d+){1,2}(?:\.\d+)?)/)
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
