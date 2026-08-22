// Standalone experiment: chunk 2 (60s-120s) map with the EXACT prompt.
// Completely separate from the app — writes raw output to data/experiments/.
import { GoogleGenAI } from '@google/genai'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const MEDIA_DIR = path.join(ROOT, 'data', 'media', 'b7c0145c6e135393')
const SHORT = path.join(MEDIA_DIR, 'short.mp4')
const MOVIE = path.join(MEDIA_DIR, 'movie.mp4')
const OUT_DIR = path.join(ROOT, 'data', 'experiments')
const CHUNK_FILE = path.join(OUT_DIR, 'chunk-0002.mp4')
const RAW_OUT = path.join(OUT_DIR, 'chunk2-raw-output.txt')
const MODEL = 'gemini-3.5-flash'
const FPS = 24
const CHUNK_START = 60 // chunk 2 = second minute of the movie
const CHUNK_SECONDS = 60

const FFMPEG = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg')

const PROMPT = fs
  .readFileSync(path.join(ROOT, 'data', 'experiment-prompt.md'), 'utf8')
  .split('---\n')[1]
  .trim()

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args)
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`)),
    )
  })
}

async function cutChunk2() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  if (fs.existsSync(CHUNK_FILE)) {
    console.log('[v0] chunk-0002.mp4 already exists, reusing')
    return
  }
  console.log('[v0] Cutting chunk 2 (60s-120s) from movie...')
  await run(FFMPEG, [
    '-y',
    '-ss', String(CHUNK_START),
    '-i', MOVIE,
    '-t', String(CHUNK_SECONDS),
    '-vf', 'scale=640:-2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    CHUNK_FILE,
  ])
  console.log('[v0] Chunk 2 cut done:', (fs.statSync(CHUNK_FILE).size / 1024 / 1024).toFixed(1), 'MB')
}

async function uploadVideo(ai, filePath, label) {
  console.log(`[v0] Uploading ${label}...`)
  let f = await ai.files.upload({ file: filePath, config: { mimeType: 'video/mp4' } })
  const deadline = Date.now() + 5 * 60_000
  while (f.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error('File processing timed out')
    await new Promise((r) => setTimeout(r, 2500))
    f = await ai.files.get({ name: f.name })
  }
  if (f.state !== 'ACTIVE') throw new Error(`Upload failed (state=${f.state})`)
  console.log(`[v0] ${label} ACTIVE: ${f.uri}`)
  return f
}

async function main() {
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'settings.json'), 'utf8'))
  const keys = [settings.apiKey, settings.apiKey2, settings.apiKey3].filter(Boolean)

  await cutChunk2()

  let lastErr = null
  for (const key of keys) {
    const ai = new GoogleGenAI({ apiKey: key })
    try {
      const shortFile = await uploadVideo(ai, SHORT, 'short video')
      const chunkFile = await uploadVideo(ai, CHUNK_FILE, 'movie chunk 2')

      console.log(`[v0] Calling ${MODEL} with the exact prompt...`)
      const t0 = Date.now()
      const resp = await ai.models.generateContent({
        model: MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              { fileData: { fileUri: shortFile.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: FPS } },
              { fileData: { fileUri: chunkFile.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: FPS } },
              { text: PROMPT },
            ],
          },
        ],
        config: { temperature: 0 },
      })
      const secs = ((Date.now() - t0) / 1000).toFixed(1)
      const text = resp.text
      if (!text) throw new Error('Empty model response')

      const usage = resp.usageMetadata
      const header =
        `MODEL: ${MODEL}\nCHUNK: 2 (movie 60s-120s)\nRESPONSE TIME: ${secs}s\n` +
        `TOKENS: prompt=${usage?.promptTokenCount ?? '?'} output=${usage?.candidatesTokenCount ?? '?'} total=${usage?.totalTokenCount ?? '?'}\n` +
        `${'='.repeat(60)}\n\n`
      fs.writeFileSync(RAW_OUT, header + text)
      console.log(`[v0] Done in ${secs}s. Raw output saved to data/experiments/chunk2-raw-output.txt`)
      console.log('\n===== RAW GEMINI OUTPUT START =====\n')
      console.log(text)
      console.log('\n===== RAW GEMINI OUTPUT END =====')
      return
    } catch (err) {
      lastErr = err
      console.log(`[v0] Key failed (${String(err.message).slice(0, 160)}), trying next key...`)
    }
  }
  throw lastErr
}

main().catch((e) => {
  console.error('[v0] FAILED:', e.message)
  process.exit(1)
})
