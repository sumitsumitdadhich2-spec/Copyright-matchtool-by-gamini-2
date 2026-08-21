// Standalone test - app se alag. 1-min chunk ko 24fps par Gemini ko bhejta hai
// aur specific timestamps par description maangta hai.
import fs from 'node:fs'
import { GoogleGenAI } from '@google/genai'

const settings = JSON.parse(fs.readFileSync('/vercel/share/v0-project/data/settings.json', 'utf8'))
const keys = [settings.apiKey, settings.apiKey2, settings.apiKey3].filter(Boolean)
const videoBytes = fs.readFileSync('/tmp/gemini-test/chunk-1min.mp4').toString('base64')

const PROMPT = `You are analyzing a 60-second video clip sampled at 24 frames per second.

TASK: Describe EXACTLY what is visible at these three specific timestamps in this clip:
1. 00:10 (10 seconds)
2. 00:30 (30 seconds)
3. 00:50 (50 seconds)

For each timestamp, describe:
- Who is on screen (people, their appearance, clothing)
- What they are doing (action/pose)
- Camera framing (close-up / medium / wide)
- Any visible on-screen text or subtitles
- Location/background

Then give a brief scene-by-scene timeline of the full 60 seconds with start/end timestamps (MM:SS).

Be precise. Only describe what is actually visible at those exact moments.`

const MODELS = ['gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']

let done = false
for (const key of keys) {
  if (done) break
  const ai = new GoogleGenAI({ apiKey: key })
  for (const model of MODELS) {
    try {
      console.log(`[v0] Trying model=${model} key=...${key.slice(-6)}`)
      const res = await ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: { mimeType: 'video/mp4', data: videoBytes },
                videoMetadata: { fps: 24 },
              },
              { text: PROMPT },
            ],
          },
        ],
      })
      console.log('\n===== MODEL:', model, '=====\n')
      console.log(res.text)
      done = true
      break
    } catch (e) {
      console.log(`[v0] FAILED ${model}: ${String(e).slice(0, 300)}`)
    }
  }
}
if (!done) console.log('[v0] All models/keys failed')
