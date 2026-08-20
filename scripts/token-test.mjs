// One-off test: real token usage for 2 YouTube videos at 24fps, LOW vs MEDIUM resolution
import fs from 'node:fs'
import { GoogleGenAI } from '@google/genai'

const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'))
const apiKey = process.env.USE_KEY2 === '1' ? settings.apiKey2 : settings.apiKey
if (!apiKey) {
  console.log('[v0] No API key in data/settings.json')
  process.exit(1)
}
console.log(`[v0] Using key ${process.env.USE_KEY2 === '1' ? '2' : '1'}`)
const ai = new GoogleGenAI({ apiKey })

const VIDEOS = [
  { label: 'Short (OviXedit)', url: 'https://youtube.com/shorts/2jQ_VTWK0Ws' },
  { label: 'Video (Kunal Thakurz)', url: 'https://youtu.be/Xi4eKnhiMjE' },
]
const RESOLUTIONS = (process.env.ONLY_RES ? [process.env.ONLY_RES] : ['MEDIA_RESOLUTION_LOW', 'MEDIA_RESOLUTION_MEDIUM'])
const MODEL = 'gemini-3.6-flash'

for (const res of RESOLUTIONS) {
  let grandTotal = 0
  console.log(`\n===== ${res} @ 24fps =====`)
  for (const v of VIDEOS) {
    try {
      const r = await ai.models.generateContent({
        model: MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              { fileData: { fileUri: v.url } , videoMetadata: { fps: 24 } },
              { text: 'Is video me kya he? 2 line me batao.' },
            ],
          },
        ],
        config: { mediaResolution: res },
      })
      const u = r.usageMetadata || {}
      const total = u.totalTokenCount ?? 0
      grandTotal += total
      console.log(`\n[${v.label}]`)
      console.log(`  input(prompt) tokens : ${u.promptTokenCount}`)
      console.log(`  output tokens        : ${u.candidatesTokenCount}`)
      console.log(`  thoughts tokens      : ${u.thoughtsTokenCount ?? 0}`)
      console.log(`  TOTAL tokens         : ${total}`)
      const vid = (u.promptTokensDetails || []).find((d) => d.modality === 'VIDEO')
      const aud = (u.promptTokensDetails || []).find((d) => d.modality === 'AUDIO')
      if (vid) console.log(`  video-only tokens    : ${vid.tokenCount}`)
      if (aud) console.log(`  audio-only tokens    : ${aud.tokenCount}`)
    } catch (e) {
      console.log(`\n[${v.label}] ERROR: ${String(e).slice(0, 300)}`)
    }
  }
  console.log(`\n>>> ${res} — DONO VIDEOS KA GRAND TOTAL: ${grandTotal} tokens`)
}
