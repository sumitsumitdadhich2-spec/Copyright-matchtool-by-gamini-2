// Standalone test: send the EXACT same chunk-map request the app sends,
// outside the app, and print Gemini's raw output verbatim.
//
// Usage: node scripts/test-chunk-prompt.mjs [chunkIndex] [modelId]
//   defaults: chunkIndex=2, modelId=gemini-3.6-flash (same as the app's last matched chunk)

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { GoogleGenAI } from '@google/genai'

const ROOT = process.cwd()
const MEDIA_DIR = path.join(ROOT, 'data', 'media', 'fa10a62dcb5f4120')
const SHORT = path.join(MEDIA_DIR, 'short.mp4')
const MOVIE = path.join(MEDIA_DIR, 'movie.mp4')
const OUT_DIR = '/tmp/test-chunks'
const CHUNK_INDEX = Number(process.argv[2] ?? 2)
const MODEL = process.argv[3] ?? 'gemini-3.6-flash'
const SCAN_FPS = 24
const CHUNK_SECONDS = 60

// ---- 1. Pull the EXACT prompt out of lib/gemini.ts (word-for-word, no drift) ----
const geminiSrc = fs.readFileSync(path.join(ROOT, 'lib', 'gemini.ts'), 'utf8')
const m = geminiSrc.match(/export const CHUNK_MAP_PROMPT = `([\s\S]*?)`\n/)
if (!m) throw new Error('CHUNK_MAP_PROMPT not found in lib/gemini.ts')
const CHUNK_MAP_PROMPT = m[1]
console.log(`[test] Prompt extracted from lib/gemini.ts: ${CHUNK_MAP_PROMPT.length} chars`)

// ---- 2. API key from the app's settings (same key the app uses) ----
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'settings.json'), 'utf8'))
const apiKey = settings.apiKey
if (!apiKey) throw new Error('No apiKey in data/settings.json')

// ---- 3. Cut chunks with the app's EXACT ffmpeg command (lib/ffmpeg.ts chunkMovie) ----
const FFMPEG = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg')
function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args)
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))))
  })
}

const chunkFile = path.join(OUT_DIR, `chunk-${String(CHUNK_INDEX).padStart(4, '0')}.mp4`)
if (!fs.existsSync(chunkFile)) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  console.log('[test] Chunking movie with the app\'s exact ffmpeg command...')
  await run(FFMPEG, [
    '-y',
    '-i', MOVIE,
    '-vf', `scale=640:-2,fps=${SCAN_FPS}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-force_key_frames', `expr:gte(t,n_forced*${CHUNK_SECONDS})`,
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    '-f', 'segment',
    '-segment_time', String(CHUNK_SECONDS),
    '-reset_timestamps', '1',
    path.join(OUT_DIR, 'chunk-%04d.mp4'),
  ])
}
console.log(`[test] Using chunk ${CHUNK_INDEX}: ${chunkFile} (${(fs.statSync(chunkFile).size / 1e6).toFixed(1)} MB)`)
console.log(`[test] Short video: ${SHORT} (${(fs.statSync(SHORT).size / 1e6).toFixed(1)} MB)`)

// ---- 4. Upload both to the Gemini Files API (same as app's uploadVideo) ----
const ai = new GoogleGenAI({ apiKey })
async function uploadVideo(filePath, label) {
  console.log(`[test] Uploading ${label}...`)
  let f = await ai.files.upload({ file: filePath, config: { mimeType: 'video/mp4' } })
  const deadline = Date.now() + 5 * 60_000
  while (f.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error('File processing timed out')
    await new Promise((r) => setTimeout(r, 2500))
    f = await ai.files.get({ name: f.name })
  }
  if (f.state !== 'ACTIVE') throw new Error(`Upload failed (state=${f.state})`)
  console.log(`[test] ${label} ACTIVE: ${f.uri}`)
  return f
}

const shortFile = await uploadVideo(SHORT, 'short video (Video 1)')
const chunk = await uploadVideo(chunkFile, `movie chunk ${CHUNK_INDEX} (Video 2)`)

// ---- 5. The EXACT same request the app sends (mapChunkRequest) ----
console.log(`[test] Sending chunk-map request to ${MODEL} @ ${SCAN_FPS} fps, temperature 0...`)
const t0 = Date.now()
const resp = await ai.models.generateContent({
  model: MODEL,
  contents: [
    {
      role: 'user',
      parts: [
        { fileData: { fileUri: shortFile.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
        { fileData: { fileUri: chunk.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
        { text: CHUNK_MAP_PROMPT },
      ],
    },
  ],
  config: { temperature: 0 },
})
console.log(`[test] Response in ${((Date.now() - t0) / 1000).toFixed(1)}s | usage: ${JSON.stringify(resp.usageMetadata)}`)

const text = resp.text ?? '(EMPTY RESPONSE)'
fs.writeFileSync(`/tmp/gemini-chunk${CHUNK_INDEX}-output.txt`, text)
console.log('\n================ GEMINI RAW OUTPUT (verbatim) ================\n')
console.log(text)
console.log('\n===============================================================')
console.log(`[test] Saved to /tmp/gemini-chunk${CHUNK_INDEX}-output.txt`)

// best-effort cleanup of uploaded files
for (const name of [shortFile.name, chunk.name]) {
  try { await ai.files.delete({ name }) } catch {}
}
