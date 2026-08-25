import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { CHUNK_SECONDS } from './models'
import { getFfmpegPath, getFfprobePath } from './ffmpeg-bin'

async function run(binPromise: Promise<string>, args: string[], onStderr?: (line: string) => void): Promise<string> {
  const bin = await binPromise
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => {
      const s = d.toString()
      stderr += s
      onStderr?.(s)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${stderr.slice(-800)}`))
    })
  })
}

export async function probeDuration(file: string): Promise<number> {
  const out = await run(getFfprobePath(), [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    file,
  ])
  const dur = Number.parseFloat(out.trim())
  if (!Number.isFinite(dur) || dur <= 0) throw new Error('Could not determine video duration')
  return dur
}

/** True when the file has at least one audio stream (silent movies need a synthesized track for concat). */
export async function probeHasAudio(file: string): Promise<boolean> {
  try {
    const out = await run(getFfprobePath(), [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      file,
    ])
    return out.trim().length > 0
  } catch {
    return false
  }
}

function parseFfmpegTime(line: string): number | null {
  const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/** Every file sent to Gemini is hard-encoded at 24 fps (Gemini's default video rate). */
const SCAN_FPS_STR = '24'

/**
 * Cut the movie into exact sequential 1-minute chunks.
 * Re-encodes at 24 fps / 640px width / CRF 28 with keyframes forced at every 60s so
 * chunk boundaries are frame-accurate and files stay small for upload.
 * Optional trimStart/trimEnd (ABSOLUTE original-movie seconds) chunk ONLY that range —
 * the original movie file is never modified, only the scan copies are cut.
 */
export async function chunkMovie(
  movieFile: string,
  outDir: string,
  duration: number,
  onProgress: (pct: number) => void,
  trimStart = 0,
  trimEnd?: number,
): Promise<number> {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const pattern = path.join(outDir, 'chunk-%04d.mp4')
  const rangeEnd = trimEnd !== undefined && trimEnd > trimStart ? Math.min(trimEnd, duration) : duration
  const rangeDur = Math.max(1, rangeEnd - trimStart)
  const trimmed = trimStart > 0.01 || rangeEnd < duration - 0.01
  const args: string[] = ['-y']
  if (trimStart > 0.01) args.push('-ss', trimStart.toFixed(3))
  args.push('-i', movieFile)
  if (trimmed) args.push('-t', rangeDur.toFixed(3))
  args.push(
    '-vf', `scale=640:-2,fps=${SCAN_FPS_STR}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-force_key_frames', `expr:gte(t,n_forced*${CHUNK_SECONDS})`,
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    '-f', 'segment',
    '-segment_time', String(CHUNK_SECONDS),
    '-reset_timestamps', '1',
    pattern,
  )
  await run(FFMPEG, args, (line) => {
    const t = parseFfmpegTime(line)
    if (t !== null) onProgress(Math.min(99, Math.round((t / rangeDur) * 100)))
  })
  onProgress(100)
  return fs.readdirSync(outDir).filter((f) => f.startsWith('chunk-') && f.endsWith('.mp4')).length
}

export function chunkPath(outDir: string, index: number): string {
  return path.join(outDir, `chunk-${String(index).padStart(4, '0')}.mp4`)
}

/**
 * Cut the SHORT video into exact sequential 1-minute scan segments (seg-0000.mp4, ...).
 * Same encode params as movie chunks (24 fps / 640px / CRF 28) — these files are
 * ONLY for scanning; the original short.mp4 is never touched.
 */
export async function chunkShort(
  shortFile: string,
  outDir: string,
  duration: number,
  onProgress: (pct: number) => void,
): Promise<number> {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const pattern = path.join(outDir, 'seg-%04d.mp4')
  await run(
    FFMPEG,
    [
      '-y',
      '-i', shortFile,
      '-vf', `scale=640:-2,fps=${SCAN_FPS_STR}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-force_key_frames', `expr:gte(t,n_forced*${CHUNK_SECONDS})`,
      '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
      '-f', 'segment',
      '-segment_time', String(CHUNK_SECONDS),
      '-reset_timestamps', '1',
      pattern,
    ],
    (line) => {
      const t = parseFfmpegTime(line)
      if (t !== null) onProgress(Math.min(99, Math.round((t / duration) * 100)))
    },
  )
  onProgress(100)
  return fs.readdirSync(outDir).filter((f) => f.startsWith('seg-') && f.endsWith('.mp4')).length
}

export function segmentPath(outDir: string, index: number): string {
  return path.join(outDir, `seg-${String(index).padStart(4, '0')}.mp4`)
}

/** Remove all short-segment scan files. */
export function cleanupSegments(outDir: string) {
  if (!fs.existsSync(outDir)) return
  for (const f of fs.readdirSync(outDir)) {
    if (f.startsWith('seg-')) {
      try {
        fs.unlinkSync(path.join(outDir, f))
      } catch {
        // ignore
      }
    }
  }
}

// ---------- Render/export helpers (used by lib/render.ts) ----------

/** Absolute path to the bundled ffmpeg binary (render pipeline spawns its own process for kill support). */
export const FFMPEG_BIN = FFMPEG

/** Parse an ffmpeg progress line into { time, speed } (either may be null). */
export function parseFfmpegProgress(line: string): { time: number | null; speed: number | null } {
  const time = parseFfmpegTime(line)
  const sm = line.match(/speed=\s*(\d+(?:\.\d+)?)x/)
  const speed = sm ? Number.parseFloat(sm[1]) : null
  return { time, speed }
}

/** Extract a sub-clip from a video (used when trimming the short video on upload). Output is 24 fps. */
export async function extractSegment(
  sourceFile: string,
  start: number,
  end: number,
  outFile: string,
): Promise<void> {
  const dur = Math.max(1, end - start)
  await run(FFMPEG, [
    '-y',
    '-ss', start.toFixed(2),
    '-i', sourceFile,
    '-t', dur.toFixed(2),
    '-vf', `scale=640:-2,fps=${SCAN_FPS_STR}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    outFile,
  ])
}

/** Millisecond-precise clip cut for the verifier/rescan pipeline.
 * Re-encodes at 24 fps (640px / CRF 28 / mono AAC) so cuts are frame-accurate at 24 fps.
 * Very short windows are padded to a minimum of 1s so Gemini gets enough frames. */
export async function extractClipPrecise(
  sourceFile: string,
  start: number,
  end: number,
  outFile: string,
): Promise<void> {
  const dur = Math.max(1, end - start)
  await run(FFMPEG, [
    '-y',
    '-ss', Math.max(0, start).toFixed(3),
    '-i', sourceFile,
    '-t', dur.toFixed(3),
    '-vf', `scale=640:-2,fps=${SCAN_FPS_STR}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    outFile,
  ])
}

/** Remove all temporary verifier/rescan clip files. */
export function cleanupClips(clipsDir: string) {
  if (!fs.existsSync(clipsDir)) return
  for (const f of fs.readdirSync(clipsDir)) {
    if (f.endsWith('.mp4')) {
      try {
        fs.unlinkSync(path.join(clipsDir, f))
      } catch {
        // ignore
      }
    }
  }
}

export function cleanupChunks(outDir: string) {
  if (!fs.existsSync(outDir)) return
  for (const f of fs.readdirSync(outDir)) {
    if (f.startsWith('chunk-')) {
      try {
        fs.unlinkSync(path.join(outDir, f))
      } catch {
        // ignore
      }
    }
  }
}
