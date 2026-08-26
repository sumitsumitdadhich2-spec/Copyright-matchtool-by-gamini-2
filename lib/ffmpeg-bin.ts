import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { get } from '@vercel/blob'

// ffmpeg/ffprobe binaries are too large to bundle into Vercel serverless
// functions (they push the deployment over the 12-function Hobby limit).
// Locally (dev / sandbox) the binaries ship with node_modules; in production
// they are pulled ONCE per server instance from Blob storage into /tmp.

const LOCAL_FFMPEG = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')
const LOCAL_FFPROBE = path.join(
  process.cwd(),
  'node_modules',
  'ffprobe-static',
  'bin',
  process.platform,
  process.arch,
  process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
)

const TMP_BIN_DIR = '/tmp/cmt-bin'

// Only one download per binary at a time — parallel requests share it.
const inflight = new Map<string, Promise<string>>()

async function ensureBinary(name: 'ffmpeg' | 'ffprobe', localPath: string): Promise<string> {
  // Local dev / sandbox: binaries are present in node_modules.
  if (fs.existsSync(/*turbopackIgnore: true*/ localPath)) return localPath

  const dest = path.join(TMP_BIN_DIR, name)
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest

  const existing = inflight.get(name)
  if (existing) return existing

  const job = (async (): Promise<string> => {
    try {
      fs.mkdirSync(TMP_BIN_DIR, { recursive: true })
      const result = await get(`bin/${name}`, { access: 'private' })
      if (!result || !('stream' in result) || !result.stream) {
        throw new Error(`${name} binary not found in Blob storage (expected at bin/${name})`)
      }
      const tmp = `${dest}.dl-${process.pid}`
      await pipeline(Readable.fromWeb(result.stream as never), fs.createWriteStream(tmp, { mode: 0o755 }))
      fs.chmodSync(tmp, 0o755)
      fs.renameSync(tmp, dest)
      return dest
    } finally {
      inflight.delete(name)
    }
  })()
  inflight.set(name, job)
  return job
}

/** Absolute path to a runnable ffmpeg binary (downloads from Blob on first use in production). */
export function getFfmpegPath(): Promise<string> {
  return ensureBinary('ffmpeg', LOCAL_FFMPEG)
}

/** Absolute path to a runnable ffprobe binary (downloads from Blob on first use in production). */
export function getFfprobePath(): Promise<string> {
  return ensureBinary('ffprobe', LOCAL_FFPROBE)
}
