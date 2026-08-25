// Uploads the ffmpeg/ffprobe binaries from node_modules to Vercel Blob at
// bin/ffmpeg and bin/ffprobe. Production serverless functions download them
// from there on first use (see lib/ffmpeg-bin.ts) — they are intentionally
// NOT bundled into the deployment.
import fs from 'node:fs'
import path from 'node:path'
import { put, head } from '@vercel/blob'

const ROOT = process.cwd()

const targets = [
  {
    name: 'ffmpeg',
    local: path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg'),
    blobPath: 'bin/ffmpeg',
  },
  {
    name: 'ffprobe',
    local: path.join(ROOT, 'node_modules', 'ffprobe-static', 'bin', 'linux', 'x64', 'ffprobe'),
    blobPath: 'bin/ffprobe',
  },
]

// Runs automatically as part of `pnpm build` (see package.json) so every
// deployment guarantees the binaries exist in Blob before going live.
// Failures are non-fatal: if the binaries are already in Blob from a previous
// deploy, production keeps working, so the build must never be blocked.
try {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.warn('[upload] BLOB_READ_WRITE_TOKEN not set — skipping binary upload (production will use previously uploaded binaries)')
    process.exit(0)
  }

  for (const t of targets) {
    if (!fs.existsSync(t.local)) {
      console.warn(`[upload] ${t.name}: local binary not found at ${t.local} — skipping`)
      continue
    }
    const size = fs.statSync(t.local).size

    // Skip if already uploaded with the same size.
    try {
      const existing = await head(t.blobPath)
      if (existing && existing.size === size) {
        console.log(`[upload] ${t.name}: already in Blob (${(size / 1024 / 1024).toFixed(1)} MB) — skipping`)
        continue
      }
    } catch {
      // not there yet — upload below
    }

    console.log(`[upload] ${t.name}: uploading ${(size / 1024 / 1024).toFixed(1)} MB to ${t.blobPath} ...`)
    const stream = fs.createReadStream(t.local)
    const result = await put(t.blobPath, stream, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
    })
    console.log(`[upload] ${t.name}: done -> ${result.pathname}`)
  }

  console.log('[upload] all binaries uploaded')
} catch (err) {
  console.warn(`[upload] binary upload failed (non-fatal): ${err instanceof Error ? err.message : err}`)
  process.exit(0)
}
