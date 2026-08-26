import { NextResponse } from 'next/server'
import path from 'node:path'
import fs from 'node:fs'
import { getFreshScan, getScan, saveScan, addLog, scanMediaDir } from '@/lib/store'
import { getSession } from '@/lib/users'
import { getUserTwelveLabsKey } from '@/lib/user-keys'
import {
  ensureIndex,
  createIndexTask,
  pollTaskUntilReady,
  fetchVideoEmbeddings,
  loadEmbeddings,
  saveEmbeddings,
} from '@/lib/twelvelabs'

export const runtime = 'nodejs'

// Per-process lock so a double-click never starts two indexing jobs.
const indexing = new Set<string>()

/** GET: Twelve Labs status for this scan (key set? indexed? embeddings saved?). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const scan = await getFreshScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const tlKey = await getUserTwelveLabsKey(session.username)
  const emb = await loadEmbeddings(id, 'movie')

  return NextResponse.json({
    hasKey: Boolean(tlKey),
    twelveLabs: scan.twelveLabs ?? { status: 'none' },
    embeddingsSaved: Boolean(emb),
    embeddingsCount: emb?.segments.length ?? 0,
    prefilter: scan.prefilter ?? null,
  })
}

/** POST: index the movie on Twelve Labs (one-time). Upload + poll + download
 *  ALL segment embeddings and save them locally + to Blob for reuse in every
 *  scan — the API is never hit again for this movie. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const tlKey = await getUserTwelveLabsKey(session.username)
  if (!tlKey) {
    return NextResponse.json({ error: 'Twelve Labs API key set nahi hai — Settings me add karo.' }, { status: 400 })
  }

  const scan = await getFreshScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const movieFile = path.join(scanMediaDir(id), 'movie.mp4')
  if (!scan.movieDuration || !fs.existsSync(movieFile)) {
    return NextResponse.json({ error: 'Movie upload hone ke baad hi indexing ho sakti hai.' }, { status: 400 })
  }
  if (indexing.has(id) || scan.twelveLabs?.status === 'indexing') {
    return NextResponse.json({ error: 'Indexing already in progress' }, { status: 409 })
  }
  const existing = await loadEmbeddings(id, 'movie')
  if (existing) {
    scan.twelveLabs = {
      ...(scan.twelveLabs || { status: 'ready' }),
      status: 'ready',
      segmentCount: existing.segments.length,
    }
    saveScan(scan)
    return NextResponse.json({ ok: true, alreadyIndexed: true })
  }

  const indexingStartedAt = Date.now()
  scan.twelveLabs = { status: 'indexing', progress: 'Uploading movie to Twelve Labs...', error: null, startedAt: indexingStartedAt }
  addLog(scan, 'info', 'Twelve Labs: movie indexing started (upload → index → download embeddings)')
  saveScan(scan, { immediate: true })
  indexing.add(id)

  // Fire-and-forget (same pattern as the scan scheduler) — the UI polls GET.
  void (async () => {
    const update = (progress: string) => {
      const s = getScan(id)
      if (!s) return
      s.twelveLabs = { ...(s.twelveLabs || { status: 'indexing' }), status: 'indexing', progress }
      saveScan(s)
    }
    try {
      const indexId = await ensureIndex(tlKey)
      update('Uploading movie (4GB/4h tak ek saath — no chunking)...')
      const { taskId } = await createIndexTask(tlKey, indexId, movieFile)
      {
        const s = getScan(id)
        if (s) {
          s.twelveLabs = { ...(s.twelveLabs || { status: 'indexing' }), status: 'indexing', indexId, taskId }
          saveScan(s)
        }
      }
      update('Indexing on Twelve Labs (polling until ready)...')
      const videoId = await pollTaskUntilReady(tlKey, taskId, {
        onTick: (st) => update(`Indexing: ${st}...`),
      })
      update('Downloading segment embeddings...')
      const segments = await fetchVideoEmbeddings(tlKey, indexId, videoId)
      await saveEmbeddings(id, 'movie', { indexId, videoId, savedAt: Date.now(), segments })

      const s = getScan(id)
      if (s) {
        const totalMs = Date.now() - indexingStartedAt
        s.twelveLabs = {
          status: 'ready',
          indexId,
          taskId,
          videoId,
          segmentCount: segments.length,
          indexedAt: Date.now(),
          startedAt: indexingStartedAt,
          totalMs,
          error: null,
        }
        addLog(s, 'success', `Twelve Labs: movie indexed — ${segments.length} segment embedding(s) saved locally for reuse (total time: ${Math.round(totalMs / 60000)}m ${Math.round((totalMs % 60000) / 1000)}s)`)
        saveScan(s, { immediate: true })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const s = getScan(id)
      if (s) {
        s.twelveLabs = { ...(s.twelveLabs || { status: 'error' }), status: 'error', error: msg }
        addLog(s, 'error', `Twelve Labs indexing failed: ${msg} — app normal full scan par chalta rahega`)
        saveScan(s, { immediate: true })
      }
    } finally {
      indexing.delete(id)
    }
  })()

  return NextResponse.json({ ok: true, started: true })
}
