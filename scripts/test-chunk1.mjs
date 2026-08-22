// Standalone test OUTSIDE the app pipeline.
// Uses the EXACT same prompt (extracted verbatim from lib/gemini.ts), the same
// ffmpeg chunk settings, the same fps metadata, and the same model call config
// as the app. Prints Gemini's RAW response text and exact token usage.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { GoogleGenAI } from '@google/genai'

const ROOT = process.cwd()
const MODEL = process.env.TEST_MODEL || 'gemini-3.5-flash'
const SCAN_FPS = 24

// ---- 1. Extract the EXACT prompt from lib/gemini.ts (no re-typing) ----
const geminiSrc = fs.readFileSync(path.join(ROOT, 'lib/gemini.ts'), 'utf8')
const startMarker = 'export const CHUNK_MAP_PROMPT = `'
const si = geminiSrc.indexOf(startMarker)
if (si < 0) throw new Error('CHUNK_MAP_PROMPT not found')
const rest = geminiSrc.slice(si + startMarker.length)
const ei = rest.indexOf('`')
const CHUNK_MAP_PROMPT = rest.slice(0, ei)
console.log('[test] Prompt extracted from lib/gemini.ts — length:', CHUNK_MAP_PROMPT.length, 'chars')

// ---- 2. Cut chunk 1 (00:00 - 01:00) with the app's exact ffmpeg settings ----
const FFMPEG = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg')
const MEDIA = path.join(ROOT, 'data/media/fa10a62dcb5f4120')
const movie = path.join(MEDIA, 'movie.mp4')
const short = path.join(MEDIA, 'short.mp4')
const CHUNK_START = Number(process.env.CHUNK_START || 0) // seconds into the movie
const chunk1 = `/tmp/test-chunk-${String(CHUNK_START).padStart(4, '0')}.mp4`

if (!fs.existsSync(chunk1)) {
  console.log(`[test] Cutting chunk (${CHUNK_START}s - ${CHUNK_START + 60}s) with app-identical ffmpeg settings...`)
  const r = spawnSync(FFMPEG, [
    '-y', '-ss', String(CHUNK_START), '-i', movie,
    '-vf', 'scale=640:-2,fps=24',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    '-t', '60',
    chunk1,
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + r.stderr.toString().slice(-500))
}
console.log('[test] chunk1 size:', (fs.statSync(chunk1).size / 1e6).toFixed(2), 'MB | short size:', (fs.statSync(short).size / 1e6).toFixed(2), 'MB')

// ---- 3. API key from app settings (same key the app uses) ----
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/settings.json'), 'utf8'))
const apiKey = settings.apiKey || settings.apiKey2 || settings.apiKey3
if (!apiKey) throw new Error('No API key in data/settings.json')
const ai = new GoogleGenAI({ apiKey })

// ---- 4. Upload both videos to Files API and wait for ACTIVE ----
async function upload(fp, label) {
  console.log(`[test] Uploading ${label}...`)
  let f = await ai.files.upload({ file: fp, config: { mimeType: 'video/mp4' } })
  const deadline = Date.now() + 5 * 60_000
  while (f.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error('processing timeout')
    await new Promise((r) => setTimeout(r, 2500))
    f = await ai.files.get({ name: f.name })
  }
  if (f.state !== 'ACTIVE') throw new Error(`${label} upload failed state=${f.state}`)
  console.log(`[test] ${label} ACTIVE: ${f.name}`)
  return f
}

const shortFile = await upload(short, 'short.mp4 (60s)')
const chunkFile = await upload(chunk1, `chunk starting at ${CHUNK_START}s (60s)`)

// ---- 5. Same request shape as mapChunkRequest() in the app ----
console.log(`[test] Calling ${MODEL} with the app's exact chunk-map request...`)
const t0 = Date.now()
const resp = await ai.models.generateContent({
  model: MODEL,
  contents: [
    {
      role: 'user',
      parts: [
        { fileData: { fileUri: shortFile.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
        { fileData: { fileUri: chunkFile.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
        { text: CHUNK_MAP_PROMPT },
      ],
    },
  ],
  config: { temperature: 0 },
})
const secs = ((Date.now() - t0) / 1000).toFixed(1)

console.log('\n================ RAW GEMINI OUTPUT (verbatim) ================\n')
console.log(resp.text ?? '(EMPTY RESPONSE)')
console.log('\n================ END RAW OUTPUT ================\n')

const u = resp.usageMetadata ?? {}
console.log('[test] Model:', MODEL, '| wall time:', secs + 's')
console.log('[test] usageMetadata (exact, from API):')
console.log(JSON.stringify(u, null, 2))

// cleanup uploaded files
for (const f of [shortFile, chunkFile]) {
  try { await ai.files.delete({ name: f.name }) } catch {}
}
console.log('[test] Uploaded files deleted. Done.')
