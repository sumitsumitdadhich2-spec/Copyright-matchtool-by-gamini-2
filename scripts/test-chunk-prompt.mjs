// Standalone test: send the EXACT app CHUNK_MAP_PROMPT + the same short video
// and one movie chunk to Gemini, outside the app, and print the raw response.
//
// Usage:
//   node scripts/test-chunk-prompt.mjs <scanId> <chunkIndex> [model]
// Example:
//   node scripts/test-chunk-prompt.mjs 8e3e67711e0e41cc 0 gemini-2.5-flash

import { GoogleGenAI } from '@google/genai'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..')

const scanId = process.argv[2] || '8e3e67711e0e41cc'
const chunkIndex = Number(process.argv[3] ?? 0)
const model = process.argv[4] || 'gemini-2.5-flash'

// --- Extract CHUNK_MAP_PROMPT verbatim from lib/gemini.ts (guaranteed same prompt) ---
const geminiSrc = readFileSync(path.join(ROOT, 'lib/gemini.ts'), 'utf8')
const promptMatch = geminiSrc.match(/export const CHUNK_MAP_PROMPT = `([\s\S]*?)`\n/)
if (!promptMatch) {
  console.error('CHUNK_MAP_PROMPT not found in lib/gemini.ts')
  process.exit(1)
}
const PROMPT = promptMatch[1]

// --- API key from the app's settings (never printed) ---
const settings = JSON.parse(readFileSync(path.join(ROOT, 'data/settings.json'), 'utf8'))
const apiKey = settings.apiKey || settings.apiKey2 || settings.apiKey3
if (!apiKey) {
  console.error('No API key in data/settings.json')
  process.exit(1)
}

const shortPath = path.join(ROOT, `data/media/${scanId}/short.mp4`)
const chunkPath = path.join(ROOT, `data/media/${scanId}/chunks/chunk-${String(chunkIndex).padStart(4, '0')}.mp4`)
for (const p of [shortPath, chunkPath]) {
  if (!existsSync(p)) {
    console.error('Missing file:', p)
    process.exit(1)
  }
}

const ai = new GoogleGenAI({ apiKey })

async function upload(filePath, label) {
  console.log(`[test] uploading ${label}: ${filePath}`)
  let f = await ai.files.upload({ file: filePath, config: { mimeType: 'video/mp4' } })
  const deadline = Date.now() + 5 * 60_000
  while (f.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error('File processing timed out')
    await new Promise((r) => setTimeout(r, 2500))
    f = await ai.files.get({ name: f.name })
  }
  if (f.state !== 'ACTIVE') throw new Error(`Upload failed (state=${f.state})`)
  console.log(`[test] ${label} ACTIVE`)
  return f
}

const shortFile = await upload(shortPath, 'short video')
const chunkFile = await upload(chunkPath, `chunk ${chunkIndex}`)

console.log(`[test] calling model: ${model} (temperature 0, fps 24, maxOutputTokens 65536)`)
const t0 = Date.now()
const resp = await ai.models.generateContent({
  model,
  contents: [
    {
      role: 'user',
      parts: [
        { fileData: { fileUri: shortFile.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: 24 } },
        { fileData: { fileUri: chunkFile.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: 24 } },
        { text: PROMPT },
      ],
    },
  ],
  config: { temperature: 0, maxOutputTokens: 65536 },
})
const secs = ((Date.now() - t0) / 1000).toFixed(1)

console.log(`[test] response in ${secs}s, finishReason: ${resp.candidates?.[0]?.finishReason}`)
console.log(`[test] usage: ${JSON.stringify(resp.usageMetadata)}`)
console.log('================ RAW GEMINI OUTPUT START ================')
console.log(resp.text ?? '(empty)')
console.log('================ RAW GEMINI OUTPUT END ==================')

// best-effort cleanup
for (const f of [shortFile, chunkFile]) {
  try {
    await ai.files.delete({ name: f.name })
  } catch {}
}
