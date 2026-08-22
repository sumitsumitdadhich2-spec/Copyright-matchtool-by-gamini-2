#!/usr/bin/env node
/**
 * STANDALONE CHUNK-PROMPT TEST SCRIPT (for humans and future AIs)
 * ----------------------------------------------------------------
 * Purpose: test the app's EXACT chunk-map prompt against Gemini OUTSIDE the app,
 * using the same videos already stored in data/media/, and print the RAW,
 * UNMODIFIED Gemini response plus exact token usage (usageMetadata).
 *
 * It reproduces the app pipeline 1:1:
 *   - Same prompt: CHUNK_MAP_PROMPT is read live from lib/gemini.ts (never drifts).
 *   - Same chunking: movie re-encoded 24fps / scale=640:-2 / CRF 28 / mono AAC 64k,
 *     segmented into 60s chunks (identical ffmpeg args as lib/ffmpeg.ts chunkMovie).
 *   - Same short video: data/media/<id>/short.mp4 is already the processed upload.
 *   - Same request: [short fileData @fps24, chunk fileData @fps24, prompt], temperature 0.
 *
 * Usage:
 *   node scripts/test-chunk-prompt.mjs [--models m1,m2] [--chunk N] [--media DIR]
 *
 * Defaults:
 *   --models gemini-3.5-flash-lite,gemini-2.5-flash,gemini-3.7-flash
 *   --chunk  1            (chunk index 1 = movie 01:00.000 - 02:00.000)
 *   --media  data/media/fa10a62dcb5f4120
 *
 * API key: read from data/settings.json (field "apiKey" — same as the app).
 * Output: raw response printed to stdout AND saved to data/test-runs/<model>-chunk<N>-<ts>.txt
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { GoogleGenAI } from '@google/genai'

const ROOT = process.cwd()
const CHUNK_SECONDS = 60
const SCAN_FPS = 24

// ---------- CLI args ----------
const args = process.argv.slice(2)
function argVal(name, def) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const MODELS = argVal('--models', 'gemini-3.5-flash-lite,gemini-2.5-flash,gemini-3.7-flash').split(',').map((s) => s.trim()).filter(Boolean)
const CHUNK_INDEX = Number(argVal('--chunk', '1'))
const MEDIA_DIR = path.resolve(ROOT, argVal('--media', 'data/media/fa10a62dcb5f4120'))

// ---------- read the EXACT prompt from lib/gemini.ts (single source of truth) ----------
function readChunkMapPrompt() {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'gemini.ts'), 'utf8')
  const m = src.match(/export const CHUNK_MAP_PROMPT = `([\s\S]*?)`\n/)
  if (!m) throw new Error('Could not extract CHUNK_MAP_PROMPT from lib/gemini.ts')
  return m[1]
}
const CHUNK_MAP_PROMPT = readChunkMapPrompt()

// ---------- API key from data/settings.json (same as the app) ----------
function readApiKey() {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'settings.json'), 'utf8'))
  const k = s.apiKey || s.apiKey2 || s.apiKey3 || s.apiKey4 || s.apiKey5
  if (!k) throw new Error('No Gemini API key in data/settings.json')
  return k
}

// ---------- ffmpeg (same binary + args as lib/ffmpeg.ts) ----------
const FFMPEG = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg')
function run(bin, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, cmdArgs)
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))))
  })
}

/** Cut ALL chunks exactly like the app's chunkMovie() and cache them. */
async function ensureChunks(movieFile, outDir) {
  const wanted = path.join(outDir, `chunk-${String(CHUNK_INDEX).padStart(4, '0')}.mp4`)
  if (fs.existsSync(wanted)) return wanted
  fs.mkdirSync(outDir, { recursive: true })
  console.log(`[test] Chunking movie exactly like the app (24fps / 640px / CRF28 / 60s segments)...`)
  await run(FFMPEG, [
    '-y',
    '-i', movieFile,
    '-vf', `scale=640:-2,fps=${SCAN_FPS}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-force_key_frames', `expr:gte(t,n_forced*${CHUNK_SECONDS})`,
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    '-f', 'segment',
    '-segment_time', String(CHUNK_SECONDS),
    '-reset_timestamps', '1',
    path.join(outDir, 'chunk-%04d.mp4'),
  ])
  if (!fs.existsSync(wanted)) throw new Error(`Chunk ${CHUNK_INDEX} was not produced`)
  return wanted
}

// ---------- Gemini helpers (mirror lib/gemini.ts) ----------
async function uploadVideo(ai, filePath) {
  const file = await ai.files.upload({ file: filePath, config: { mimeType: 'video/mp4' } })
  let f = file
  const deadline = Date.now() + 5 * 60_000
  while (f.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error('File processing timed out')
    await new Promise((r) => setTimeout(r, 2500))
    f = await ai.files.get({ name: f.name })
  }
  if (f.state !== 'ACTIVE') throw new Error(`File upload failed (state=${f.state})`)
  return f
}

async function main() {
  const apiKey = readApiKey()
  const ai = new GoogleGenAI({ apiKey })

  const shortFile = path.join(MEDIA_DIR, 'short.mp4')
  const movieFile = path.join(MEDIA_DIR, 'movie.mp4')
  if (!fs.existsSync(shortFile) || !fs.existsSync(movieFile)) {
    throw new Error(`short.mp4 / movie.mp4 not found in ${MEDIA_DIR}`)
  }

  const chunkFile = await ensureChunks(movieFile, path.join(MEDIA_DIR, 'test-chunks'))
  console.log(`[test] Chunk ${CHUNK_INDEX} file: ${chunkFile} (movie ${CHUNK_INDEX}:00 - ${CHUNK_INDEX + 1}:00)`)

  console.log('[test] Uploading short video to Gemini Files API...')
  const shortUp = await uploadVideo(ai, shortFile)
  console.log('[test] Uploading chunk to Gemini Files API...')
  const chunkUp = await uploadVideo(ai, chunkFile)

  const outDir = path.join(ROOT, 'data', 'test-runs')
  fs.mkdirSync(outDir, { recursive: true })

  for (const model of MODELS) {
    const banner = `\n${'='.repeat(80)}\nMODEL: ${model}   |   CHUNK ${CHUNK_INDEX} (${CHUNK_INDEX}:00-${CHUNK_INDEX + 1}:00)   |   ${new Date().toISOString()}\n${'='.repeat(80)}`
    console.log(banner)
    try {
      const t0 = Date.now()
      const resp = await ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              { fileData: { fileUri: shortUp.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
              { fileData: { fileUri: chunkUp.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
              { text: CHUNK_MAP_PROMPT },
            ],
          },
        ],
        config: { temperature: 0 },
      })
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      const text = resp.text || '(EMPTY RESPONSE)'
      const u = resp.usageMetadata || {}
      const usage = `TOKENS -> prompt: ${u.promptTokenCount ?? '?'} | output: ${u.candidatesTokenCount ?? '?'} | thoughts: ${u.thoughtsTokenCount ?? 0} | total: ${u.totalTokenCount ?? '?'} | time: ${elapsed}s`
      console.log('\n----- RAW GEMINI OUTPUT (verbatim, untouched) -----\n')
      console.log(text)
      console.log('\n----- END RAW OUTPUT -----')
      console.log(usage)
      const file = path.join(outDir, `${model}-chunk${CHUNK_INDEX}-${Date.now()}.txt`)
      fs.writeFileSync(file, `${banner}\n\n${usage}\n\n${text}\n`)
      console.log(`[test] Saved to ${file}`)
    } catch (err) {
      console.log(`[test] MODEL FAILED: ${model}`)
      console.log(String(err && err.message ? err.message : err))
    }
  }

  // best-effort cleanup of uploaded files
  try { await ai.files.delete({ name: shortUp.name }) } catch {}
  try { await ai.files.delete({ name: chunkUp.name }) } catch {}
}

main().catch((err) => {
  console.error('[test] FATAL:', err.message || err)
  process.exit(1)
})
