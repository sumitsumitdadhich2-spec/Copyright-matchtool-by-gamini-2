import { put, del, list, get } from '@vercel/blob'
import fs from 'node:fs'
import path from 'node:path'
import type { Scan } from './types'

// Scan records are mirrored to Vercel Blob (private store) so history and
// results survive serverless restarts/redeploys where /tmp is wiped.
// Media files (videos) stay local-only: ffmpeg needs local files and videos
// are pruned to the newest MAX_SCANS anyway.

const BLOB_SCAN_PREFIX = 'scans/'

function blobPath(id: string) {
  return `${BLOB_SCAN_PREFIX}${id}.json`
}

// ---------- Throttled backup ----------
// saveScan() fires extremely often during a scan (progress updates), so we
// throttle uploads per scan id and always flush a trailing write.

const THROTTLE_MS = 15_000
const lastUpload = new Map<string, number>()
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
const latestPayload = new Map<string, string>()

async function uploadNow(id: string) {
  const payload = latestPayload.get(id)
  if (!payload) return
  lastUpload.set(id, Date.now())
  try {
    await put(blobPath(id), payload, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
    })
  } catch (err) {
    console.error('[scan-blob] backup failed:', err instanceof Error ? err.message : err)
  }
}

/** Fire-and-forget: mirror the scan JSON to Blob (throttled, trailing flush). */
export function backupScanToBlob(scan: Scan) {
  const id = scan.id
  latestPayload.set(id, JSON.stringify(scan))

  const isFinal = scan.status === 'done' || scan.status === 'error' || scan.finishedAt != null
  const elapsed = Date.now() - (lastUpload.get(id) || 0)

  if (isFinal || elapsed >= THROTTLE_MS) {
    const t = pendingTimers.get(id)
    if (t) {
      clearTimeout(t)
      pendingTimers.delete(id)
    }
    void uploadNow(id)
    return
  }

  // Trailing flush so the last state always lands in Blob.
  if (!pendingTimers.has(id)) {
    const t = setTimeout(() => {
      pendingTimers.delete(id)
      void uploadNow(id)
    }, THROTTLE_MS - elapsed)
    // Don't keep the process alive just for a backup timer.
    if (typeof t.unref === 'function') t.unref()
    pendingTimers.set(id, t)
  }
}

/** Delete ALL of a scan's Blob data: the JSON record AND its videos (media/{id}/...). */
export async function deleteScanBlob(id: string) {
  try {
    const [record, media] = await Promise.all([
      list({ prefix: blobPath(id) }),
      list({ prefix: `media/${id}/` }),
    ])
    const urls = [...record.blobs, ...media.blobs].map((b) => b.url)
    if (urls.length) await del(urls)
  } catch (err) {
    console.error('[scan-blob] delete failed:', err instanceof Error ? err.message : err)
  }
  lastUpload.delete(id)
  latestPayload.delete(id)
  const t = pendingTimers.get(id)
  if (t) {
    clearTimeout(t)
    pendingTimers.delete(id)
  }
}

// ---------- Restore ----------
// After a cold start /tmp is empty. Before listing scans we pull the JSON
// records back from Blob so history/results reappear. Runs once per process.

let restored = false
let restoring: Promise<void> | null = null

export function restoreScansFromBlob(scansDir: string): Promise<void> {
  if (restored) return Promise.resolve()
  if (restoring) return restoring
  restoring = (async () => {
    try {
      const { blobs } = await list({ prefix: BLOB_SCAN_PREFIX })
      fs.mkdirSync(scansDir, { recursive: true })
      for (const b of blobs) {
        const name = path.basename(b.pathname)
        if (!name.endsWith('.json')) continue
        const local = path.join(scansDir, name)
        if (fs.existsSync(/*turbopackIgnore: true*/ local)) continue
        try {
          const result = await get(b.pathname, { access: 'private' })
          if (!result || result.statusCode === 304) continue
          const text = await new Response(result.stream).text()
          JSON.parse(text) // validate before writing
          fs.writeFileSync(local, text)
        } catch (err) {
          console.error('[scan-blob] restore of', name, 'failed:', err instanceof Error ? err.message : err)
        }
      }
      restored = true
    } catch (err) {
      console.error('[scan-blob] restore failed:', err instanceof Error ? err.message : err)
    } finally {
      restoring = null
    }
  })()
  return restoring
}
