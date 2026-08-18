import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { CHUNK_SECONDS } from './models'

const FFMPEG = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')
const FFPROBE = path.join(
  process.cwd(),
  'node_modules',
  'ffprobe-static',
  'bin',
  process.platform,
  process.arch,
  process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
)

function run(bin: string, args: string[], onStderr?: (line: string) => void): Promise<string> {
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
  const out = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    file,
  ])
  const dur = Number.parseFloat(out.trim())
  if (!Number.isFinite(dur) || dur <= 0) throw new Error('Could not determine video duration')
  return dur
}

function parseFfmpegTime(line: string): number | null {
  const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/**
 * Cut the movie into exact sequential 1-minute chunks.
 * Re-encodes at 640px width / CRF 28 with keyframes forced at every 60s so
 * chunk boundaries are frame-accurate and files stay small for upload.
 */
export async function chunkMovie(
  movieFile: string,
  outDir: string,
  duration: number,
  onProgress: (pct: number) => void,
): Promise<number> {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const pattern = path.join(outDir, 'chunk-%04d.mp4')
  await run(
    FFMPEG,
    [
      '-y',
      '-i', movieFile,
      '-vf', 'scale=640:-2',
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
  return fs.readdirSync(outDir).filter((f) => f.startsWith('chunk-') && f.endsWith('.mp4')).length
}

export function chunkPath(outDir: string, index: number): string {
  return path.join(outDir, `chunk-${String(index).padStart(4, '0')}.mp4`)
}

/** Extract a sub-segment from a video (used for the 14fps verification pass). */
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
    '-vf', 'scale=640:-2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    outFile,
  ])
}

export function cleanupChunks(outDir: string) {
  if (!fs.existsSync(outDir)) return
  for (const f of fs.readdirSync(outDir)) {
    if (f.startsWith('chunk-') || f.startsWith('verify-')) {
      try {
        fs.unlinkSync(path.join(outDir, f))
      } catch {
        // ignore
      }
    }
  }
}
