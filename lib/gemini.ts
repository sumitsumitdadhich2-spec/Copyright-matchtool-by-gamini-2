import { GoogleGenAI, ThinkingLevel } from '@google/genai'
import { SCAN_FPS, MAX_OUTPUT_TOKENS } from './models'
import type { ChunkMatch } from './types'

/** Shared generation config for EVERY request:
 * thinking level HIGH + max output tokens, always. */
const GEN_CONFIG = {
  temperature: 0,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
  // DEFAULT media resolution only (~65 tok/frame, measured). Never set
  // mediaResolution: LOW/MEDIUM behave the same as default, and HIGH
  // quadruples cost to ~257 tok/frame.
} as const

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

export function classifyError(err: unknown): GeminiError {
  if (err instanceof GeminiError) return err
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

/** The ONE prompt sent for EVERY movie chunk (word-for-word from data/experiment-prompt.md). */
export const CHUNK_MAP_PROMPT = `You are a forensic video analyst. You are given TWO videos:
- Video 1: a SHORT VIDEO that was edited together from clips of a movie.
- Video 2: a ONE-MINUTE CHUNK cut from the original movie.

Both videos are exactly 24 fps. Analyze them frame by frame at 24 fps precision.

Respond in Hinglish (Hindi written in Latin script). Spoken dialogue must always be QUOTED VERBATIM in its original language.

Your answer has exactly TWO parts:

=====================
HISSA 1 — SHORT VIDEO TIME MAP
=====================
Watch Video 1 from start to finish and break it into small, fine-grained segments:
- Har segment chhota hona chahiye — zyada tar segments 1 second ya usse kam ke hone chahiye. Ek lambi continuous shot ko bhi chhote sub-segments me todo taaki mapping precise rahe.
- Segments contiguous hone chahiye: har segment ka start = pichle segment ka end. Pehla segment 00:00.000 se shuru ho, aakhri segment video ki total duration par khatam ho. Koi gap nahi, koi overlap nahi.
- Har line ka format:
  mm:ss.mmm - mm:ss.mmm (startFrame-endFrame frames): <SHORT description, max 10-12 words — kaun kya kar raha hai; agar koi bolta hai to sirf exact quoted words>
- Description LAMBA MAT karo — output token budget limited hai. Sirf identify karne layak minimum detail + exact dialogue quote.
- Frame numbers = timestamp x 24 (24 fps). Timestamps millisecond precision me, frame boundaries 1/24s (0.0417s) steps par aligned.
- Dialogue sabse strong fingerprint hai — kabhi summarize mat karo, hamesha exact words quote karo.

=====================
HISSA 2 — MOVIE MAP TIME
=====================
Ab HISSA 1 ke HAR EK segment ke liye Video 2 (movie chunk) me EXACT wahi footage dhundho (same recording, frame for frame — sirf similar scene nahi).

STRICT RULES:
1. 1:1 SAME-DURATION MAPPING (sabse important rule): Har short segment ka movie me matched window EXACTLY utni hi duration ka hona chahiye. Agar short segment 0.417s ka hai, to movie window bhi 0.417s ka hoga — na kam, na zyada. (movie_end - movie_start) MUST equal (short_end - short_start). Kabhi bhi ek chhote short segment ko movie ke bade 5-10 second block par map mat karo.
2. HAR SEGMENT KI APNI LINE: Har short segment ke liye alag mapping line likho. Kai segments ko ek saath ek badi range me merge mat karo (consecutive NOT FOUND segments ko ek line me group karna allowed hai).
3. Movie timestamps Video 2 ki APNI clock se aane chahiye (00:00.000 se ~01:00.000) — frames ko actually dekh kar. Short video ke timestamps copy karke movie column me daalna FORBIDDEN hai jab tak tumne wahi frames Video 2 me us position par khud verify na kiye hon.
4. NO EXTRAPOLATION (CRITICAL): Ek baar offset mil jane ke baad "short_time + offset" formula se aage ke segments AUTOMATICALLY map karna STRICTLY FORBIDDEN hai. Ye sabse common galti hai. Har naye segment ke liye Video 2 ke actual frames FIR SE dekho aur independently verify karo. Agar tum notice karo ki tumhare consecutive mappings ek fixed offset follow kar rahe hain (e.g. har match exactly +3.000s par), to RUK JAO aur har ek ko dobara verify karo — ye extrapolation drift ka signal hai, real matching ka nahi.
5. DIALOGUE AUDIO VERIFICATION: Agar short segment me koi dialogue hai, to matched movie window me WAHI EXACT dialogue Video 2 ke audio me us position par actually SUNAI dena chahiye. Agar us movie window me wo words sunai nahi dete, to match INVALID hai — NOT FOUND likho. Bina dialogue verify kiye dialogue-wale segment ko map karna FORBIDDEN hai.
6. CHUNK KA END = FOOTAGE KA END: Ye chunk poori movie ka sirf ek 1-minute tukda hai. Short video ka content is chunk ke END par cut ho sakta hai — uske baad ke short segments AGLE chunk me hain, is chunk me NAHI. Agar tumhara matched footage Video 2 ke end ke paas khatam ho raha hai, to baaki bache short segments ko zabardasti aakhri seconds me squeeze mat karo — unhe NOT FOUND likho. Suspicious sign: agar tumhara last match exactly Video 2 ke end (~01:00.000) par khatam hota hai, to bahut dhyan se verify karo.
7. NOT FOUND: Agar koi short segment is movie chunk ke andar NAHI milta, to clearly likho "NOT FOUND — ye scene is movie chunk ke andar nahi hai". Bahut se segments milenge hi nahi — ye NORMAL aur EXPECTED hai. Zabardasti match banana false positive hai, jo miss karne se bahut zyada bura hai. SIMILAR IS NOT SAME — same actors/location par different moment = NOT FOUND. Ek naya scene short me shuru hua hai iska matlab ye NAHI ki wo is chunk me continue hota hai.
8. Movie ke andar segments ka order short video ke order se alag ho sakta hai (short video edited hai) — har segment independently dhundho.
9. FINAL SELF-CHECK: Answer dene se pehle apne saare matches dobara scan karo. Jo bhi match sirf "pichle match ke baad aata hai isliye" bana hai (frame evidence ke bina), use NOT FOUND me badlo.

Har matched line ka format:
  Short mm:ss.mmm - mm:ss.mmm --> Movie mm:ss.mmm - mm:ss.mmm (startFrame-endFrame frames)

Na milne par:
  Short mm:ss.mmm - mm:ss.mmm --> NOT FOUND — <chhota reason>

Poore answer me sirf HISSA 1 aur HISSA 2 do, aur kuch nahi.`

/** One chunk-map request: whole short video + one movie chunk, the SAME prompt every time.
 * Returns the raw model text (HISSA 1 + HISSA 2) — parsing happens separately. */
export async function mapChunkRequest(
  ai: GoogleGenAI,
  model: string,
  shortUri: string,
  chunkUri: string,
): Promise<string> {
  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: shortUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
            { fileData: { fileUri: chunkUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
            { text: CHUNK_MAP_PROMPT },
          ] as never,
        },
      ],
      config: GEN_CONFIG,
    })
    const text = resp.text
    if (!text) throw new Error('Empty model response')
    return text
  } catch (err) {
    throw classifyError(err)
  }
}

// ---------- Verifier (candidate confirmation) ----------

/** Special prompt for the VERIFIER: two tiny clips, decide SAME vs DIFFERENT. */
export const VERIFY_PROMPT = `You are a forensic video verifier. You are given TWO very short clips. Both are exactly 24 fps — compare them frame by frame at 24 fps precision.

- Video 1: ek segment jo ek SHORT VIDEO se kata gaya hai.
- Video 2: ek segment jo ek MOVIE se kata gaya hai.

SAWAL: Kya ye dono clips EXACT SAME footage hain — same recording, same moment, frame-for-frame?

RULES:
1. Visuals AUR audio dono compare karo, frame by frame.
2. Dialogue sabse strong fingerprint hai: agar dono clips me dialogue hai to EXACT same words, same voice, same timing hone chahiye. Words alag = DIFFERENT.
3. SIMILAR IS NOT SAME: same actors, same location, same costume, milta-julta scene — lekin different take ya different moment = DIFFERENT.
4. Crop, resize, compression, color-grade, watermark ya text-overlay ka difference IGNORE karo — underlying footage same ho sakta hai.
5. Agar Video 1 ka footage Video 2 me nahi hai, to bina jhijhak DIFFERENT bolo. Zabardasti SAME bolna STRICTLY FORBIDDEN hai. Doubt ho to DIFFERENT bolo.

Answer EXACTLY in this format (aur kuch nahi):
VERDICT: SAME
ya
VERDICT: DIFFERENT
REASON: <ek chhoti line Hinglish me>`

/** Special prompt for a RESCAN: one failed short segment + the full 1-minute chunk it was claimed in.
 * Structured like the chunk-map prompt (HISSA 1 time map + HISSA 2 hunt) for maximum accuracy. */
export const RESCAN_PROMPT = `You are a forensic video analyst. You are given TWO videos:
- Video 1: ek chhota TARGET SEGMENT jo ek SHORT VIDEO se kata gaya hai.
- Video 2: ek ONE-MINUTE CHUNK jo original movie se kata gaya hai.

Both videos are exactly 24 fps. Analyze them frame by frame at 24 fps precision.

Respond in Hinglish (Hindi written in Latin script). Spoken dialogue must always be QUOTED VERBATIM in its original language.

Your answer has exactly TWO parts:

=====================
HISSA 1 — TARGET SEGMENT TIME MAP
=====================
Watch Video 1 from start to finish and break it into small, fine-grained segments:
- Har segment chhota hona chahiye — zyada tar 1 second ya usse kam. Ek continuous shot ko bhi chhote sub-segments me todo.
- Har line ka format:
  mm:ss.mmm - mm:ss.mmm (startFrame-endFrame frames): <SHORT description, max 10-12 words; agar koi bolta hai to sirf exact quoted words>
- Frame numbers = timestamp x 24 (24 fps). Timestamps millisecond precision me.
- Dialogue sabse strong fingerprint hai — kabhi summarize mat karo, hamesha exact words quote karo.

=====================
HISSA 2 — MOVIE CHUNK ME HUNT
=====================
Ab poora Video 2 shuru se aakhir tak frame-by-frame scan karke EXACT wahi footage dhundho jo Video 1 ka target hai (same recording, frame for frame — sirf similar scene nahi).

STRICT RULES:
1. Poora Video 2 shuru se aakhir tak scan karo. Koi shortcut nahi.
2. Matched window ki duration EXACTLY Video 1 ke target ki duration ke barabar honi chahiye — na kam, na zyada.
3. Movie timestamps Video 2 ki APNI clock se aane chahiye (00:00.000 se ~01:00.000) — frames ko actually dekh kar. Video 1 ke timestamps copy karke daalna FORBIDDEN hai.
4. NO EXTRAPOLATION / NO GUESSING (CRITICAL): Kisi bhi formula, offset, ya andaze se timestamp banana STRICTLY FORBIDDEN hai. Sirf wahi window report karo jiske frames tumne Video 2 me khud dekhe aur verify kiye hain.
5. DIALOGUE AUDIO VERIFICATION: Agar Video 1 me koi dialogue hai, to matched window me WAHI EXACT dialogue Video 2 ke audio me us position par actually SUNAI dena chahiye. Words sunai nahi dete = match INVALID — NOT FOUND likho.
6. SIMILAR IS NOT SAME: same actors, same location, same costume par different moment ya different take = NOT FOUND.
7. NOT FOUND: Agar target Video 2 me NAHI hai, to saaf mana kar do. Zabardasti match banana false positive hai, jo miss karne se bahut zyada bura hai. NOT FOUND ek bilkul valid aur expected answer hai. Doubt ho to NOT FOUND.
8. FINAL SELF-CHECK: Answer dene se pehle apna MATCH dobara verify karo — kya wo window ke frames aur audio sach me Video 1 ke target se frame-for-frame match karte hain? Agar frame evidence nahi hai, to NOT FOUND me badlo.

HISSA 2 ke end me aakhri line EXACTLY is format me do (Video 2 ki apni clock par):
MATCH: mm:ss.mmm - mm:ss.mmm
ya
NOT FOUND — <chhota reason>

Poore answer me sirf HISSA 1 aur HISSA 2 do, aur kuch nahi.`

/** One verifier request: short-segment clip + movie-window clip, both @ 24 fps.
 * `paddingNote` (optional) is appended to the prompt when the clips were padded,
 * telling the model EXACTLY where the real target window sits inside each clip. */
export async function verifyRequest(
  ai: GoogleGenAI,
  model: string,
  shortClipUri: string,
  movieClipUri: string,
  paddingNote?: string,
): Promise<string> {
  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: shortClipUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
            { fileData: { fileUri: movieClipUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
            { text: paddingNote ? `${VERIFY_PROMPT}\n${paddingNote}` : VERIFY_PROMPT },
          ] as never,
        },
      ],
      config: GEN_CONFIG,
    })
    const text = resp.text
    if (!text) throw new Error('Empty verifier response')
    return text
  } catch (err) {
    throw classifyError(err)
  }
}

/** One rescan request: failed short-segment clip + the full 1-minute chunk, both @ 24 fps.
 * `paddingNote` (optional) is appended when the segment clip was padded, telling the
 * model EXACTLY where the real target window sits inside Video 1. */
export async function rescanRequest(
  ai: GoogleGenAI,
  model: string,
  segmentClipUri: string,
  chunkUri: string,
  paddingNote?: string,
): Promise<string> {
  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: segmentClipUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
            { fileData: { fileUri: chunkUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
            { text: paddingNote ? `${RESCAN_PROMPT}\n${paddingNote}` : RESCAN_PROMPT },
          ] as never,
        },
      ],
      config: GEN_CONFIG,
    })
    const text = resp.text
    if (!text) throw new Error('Empty rescan response')
    return text
  } catch (err) {
    throw classifyError(err)
  }
}

/** Parse the verifier's answer. Returns null when no clear verdict was given. */
export function parseVerdict(raw: string): { same: boolean; reason: string } | null {
  const m = raw.match(/VERDICT\s*:\s*(SAME|DIFFERENT)/i)
  if (!m) return null
  const r = raw.match(/REASON\s*:\s*(.+)/i)
  return { same: m[1].toUpperCase() === 'SAME', reason: (r?.[1] || '').trim().slice(0, 300) }
}

/** Parse a rescan answer into a chunk-local window, or null for NOT FOUND / unparseable. */
export function parseRescanMatch(raw: string): { start: number; end: number } | null {
  if (/NOT\s*FOUND/i.test(raw) && !/MATCH\s*:/i.test(raw)) return null
  const m = raw.match(/MATCH\s*:\s*(\d+:\d+(?:\.\d+)?)\s*-\s*(\d+:\d+(?:\.\d+)?)/i)
  if (!m) return null
  const start = parseTs(m[1])
  const end = parseTs(m[2])
  if (start === null || end === null || end <= start) return null
  return { start, end }
}

/** Parse "mm:ss.mmm" (also tolerates "m:ss.mm" / "mm:ss") into seconds. */
function parseTs(ts: string): number | null {
  const m = ts.trim().match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/)
  if (!m) return null
  const sec = Number(m[1]) * 60 + Number(m[2])
  return Number.isFinite(sec) ? sec : null
}

/** FALSE-RESULT DETECTOR for chunk-map outputs. Returns a reason string when
 * the output looks like a fabricated "same-2-same" A-to-Z mapping, else null.
 *
 * Signal 1 — NO "NOT FOUND" ANYWHERE: a real chunk-map answer almost always has
 * NOT FOUND lines (the chunk is only 1 minute of the whole movie). If Gemini's
 * output does not contain "NOT FOUND" even once, it mapped everything = false result.
 *
 * Signal 2 — FIXED-OFFSET EXTRAPOLATION: if every matched line follows the same
 * constant offset (movieStart - shortStart), the model broke prompt rule 4
 * (NO EXTRAPOLATION) and just applied "short_time + offset" A to Z. */
export function isSuspiciousChunkOutput(raw: string, matches: ChunkMatch[]): string | null {
  // Signal 1: not a single NOT FOUND line in the whole output.
  if (!/NOT\s*FOUND/i.test(raw)) {
    return 'output me kahin bhi NOT FOUND nahi hai — model ne sab kuch map kar diya (false result)'
  }
  // Signal 2: all matches share one fixed offset (extrapolation drift).
  if (matches.length >= 4) {
    const offsets = matches.map((m) => m.movieStart - m.shortStart)
    const min = Math.min(...offsets)
    const max = Math.max(...offsets)
    if (max - min < 0.25) {
      return `saare ${matches.length} matches ek hi fixed offset (+${min.toFixed(3)}s) par hain — extrapolated A-to-Z mapping (prompt rule 4 break)`
    }
  }
  return null
}

/** Parse the HISSA 2 lines of a chunk-map response into matches.
 * NOT FOUND lines are skipped; movie timestamps (chunk-local) are converted to
 * ABSOLUTE movie time using the chunk's start offset. */
export function parseChunkMatches(raw: string, chunkIndex: number, chunkOffsetSeconds: number, model: string): ChunkMatch[] {
  const out: ChunkMatch[] = []
  const re = /Short\s+(\d+:\d+(?:\.\d+)?)\s*-\s*(\d+:\d+(?:\.\d+)?)\s*-->\s*Movie\s+(\d+:\d+(?:\.\d+)?)\s*-\s*(\d+:\d+(?:\.\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const shortStart = parseTs(m[1])
    const shortEnd = parseTs(m[2])
    const movieLocalStart = parseTs(m[3])
    const movieLocalEnd = parseTs(m[4])
    if (shortStart === null || shortEnd === null || movieLocalStart === null || movieLocalEnd === null) continue
    if (shortEnd <= shortStart || movieLocalEnd <= movieLocalStart) continue
    out.push({
      shortStart,
      shortEnd,
      movieStart: chunkOffsetSeconds + movieLocalStart,
      movieEnd: chunkOffsetSeconds + movieLocalEnd,
      chunkIndex,
      model,
    })
  }
  return out
}
