// Standalone test - app se alag. 1-min chunk ko 24fps par Gemini ko bhejta hai
// aur specific timestamps par description maangta hai.
import fs from 'node:fs'
import { GoogleGenAI } from '@google/genai'

const settings = JSON.parse(fs.readFileSync('/vercel/share/v0-project/data/settings.json', 'utf8'))
const keys = [settings.apiKey, settings.apiKey2, settings.apiKey3].filter(Boolean)
const videoBytes = fs.readFileSync('/tmp/gemini-test/chunk-1min.mp4').toString('base64')

const PROMPT = `You are analyzing a video clip. Read ALL of the following context carefully before answering.

=== VIDEO SPECIFICATIONS (ground truth, do not question these) ===
- Total duration: EXACTLY 60 seconds (one minute). The clip starts at 00:00 and ends at 01:00.
- Frame rate: 24 frames per second. You are receiving 24 frames for every 1 second of video.
- Therefore frame number N corresponds to timestamp N/24 seconds. Example: frame 240 = 00:10, frame 720 = 00:30, frame 1200 = 00:50.

=== TIMESTAMP FORMAT RULES (follow strictly) ===
- Format: MM:SS where MM = minutes, SS = seconds.
- SS (seconds) can ONLY be 00 to 59. A value like "34:70" is INVALID and must never appear.
- Because the clip is only 60 seconds long, every timestamp you output MUST be between 00:00 and 01:00. Anything like "02:40" or "24:20" is impossible and wrong.
- If you are unsure of an exact second, say "approximately" - never invent precision you do not have.

=== TASK ===
Describe EXACTLY what is visible at these three specific timestamps:
1. 00:10 (= 10 seconds in = frame 240 of 1440)
2. 00:30 (= 30 seconds in = frame 720 of 1440)
3. 00:50 (= 50 seconds in = frame 1200 of 1440)

For each timestamp, describe:
- Who is on screen (people, their appearance, clothing)
- What they are doing (action/pose)
- Camera framing (close-up / medium / wide)
- The EXACT subtitle text visible at that precise moment (if any). Do not report a subtitle from a nearby moment - only the one visible AT that timestamp.
- Location/background

=== TIMELINE ===
Then give a scene-by-scene timeline of the full 60 seconds. Every start/end timestamp must be within 00:00 - 01:00 and use valid MM:SS format.

Before you output your answer, re-check every timestamp against the rules above. Only describe what is actually visible at those exact moments.`

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
