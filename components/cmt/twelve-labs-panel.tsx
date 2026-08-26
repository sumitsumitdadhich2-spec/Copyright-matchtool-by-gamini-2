'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Layers, Loader2, CheckCircle2, AlertTriangle, UploadCloud } from 'lucide-react'
import type { Scan, TwelveLabsState, PrefilterInfo } from '@/lib/types'
import { fetcher } from '@/lib/format'

interface TLStatusResponse {
  hasKey: boolean
  twelveLabs: TwelveLabsState
  embeddingsSaved: boolean
  embeddingsCount: number
  prefilter: PrefilterInfo | null
}

/** SEPARATE optional Twelve Labs pre-filter section (top of the app).
 *  Shows movie index status + the one-time "Index Movie" button + the last
 *  scan's pre-filter decision. Fully optional — without a key the app's
 *  existing flow runs 100% unchanged. */
export function TwelveLabsPanel({ scan }: { scan: Scan }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data, mutate } = useSWR<TLStatusResponse>(
    scan.id ? `/api/scans/${scan.id}/twelvelabs` : null,
    fetcher,
    {
      refreshInterval: (latest) => (latest?.twelveLabs?.status === 'indexing' ? 4000 : 15000),
    },
  )

  const tl = data?.twelveLabs ?? scan.twelveLabs ?? { status: 'none' as const }
  const hasKey = data?.hasKey ?? false
  const indexed = tl.status === 'ready' || Boolean(data?.embeddingsSaved)
  const indexing = tl.status === 'indexing'
  const movieReady = Boolean(scan.movieDuration)
  const prefilter = data?.prefilter ?? scan.prefilter ?? null

  async function startIndexing() {
    setBusy(true)
    setError(null)
    const res = await fetch(`/api/scans/${scan.id}/twelvelabs`, { method: 'POST' })
    setBusy(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Indexing start nahi ho paayi')
    }
    void mutate()
  }

  return (
    <section aria-label="Twelve Labs pre-filter" className="panel">
      <div className="flex flex-wrap items-center gap-2">
        <Layers className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Twelve Labs Pre-Filter (Optional)</h2>

        {/* Index status pill */}
        {indexing ? (
          <span className="ml-auto flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/15 px-3 py-1 text-xs font-medium text-warning">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Indexing...
          </span>
        ) : indexed ? (
          <span className="ml-auto flex items-center gap-1.5 rounded-full border border-success/30 bg-success/15 px-3 py-1 text-xs font-medium text-success">
            <CheckCircle2 className="size-3.5" aria-hidden />
            Movie indexed{data?.embeddingsCount ? ` · ${data.embeddingsCount} segments` : ''}
          </span>
        ) : tl.status === 'error' ? (
          <span className="ml-auto flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/15 px-3 py-1 text-xs font-medium text-destructive">
            <AlertTriangle className="size-3.5" aria-hidden />
            Indexing failed
          </span>
        ) : (
          <span className="ml-auto rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">Not indexed</span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => startIndexing()}
          disabled={!hasKey || !movieReady || indexing || indexed || busy}
          className="btn-press flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/25 disabled:opacity-40 disabled:shadow-none"
        >
          {indexing || busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <UploadCloud className="size-4" aria-hidden />
          )}
          {indexed ? 'Movie indexed' : indexing ? 'Indexing...' : 'Index Movie on Twelve Labs'}
        </button>

        {indexing && tl.progress && (
          <span className="font-mono text-xs text-muted-foreground">{tl.progress}</span>
        )}
      </div>

      {/* Last scan's pre-filter decision — user ko clearly pata rahe kya skip hua */}
      {prefilter && (
        <p className="mt-2 text-xs">
          {prefilter.mode === 'prefiltered' ? (
            <span className="font-medium text-success">
              Pre-filter: {prefilter.selectedChunks} of {prefilter.totalChunks} chunks selected — sirf yehi chunks Gemini
              ko gaye (Twelve Labs pre-filtered scan)
            </span>
          ) : (
            <span className="text-muted-foreground">
              Last scan: Full scan ({prefilter.selectedChunks} chunks)
              {prefilter.reason && prefilter.reason !== 'Twelve Labs key not set' ? ` — ${prefilter.reason}` : ''}
            </span>
          )}
        </p>
      )}

      {tl.status === 'error' && tl.error && <p className="mt-2 text-xs text-destructive">{tl.error}</p>}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {!hasKey
          ? 'Twelve Labs API key set nahi hai — app normal full scan par chal raha hai (Settings me optional key add kar sakte ho).'
          : !movieReady
            ? 'Movie upload hone ke baad yahan se one-time indexing kar sakte ho.'
            : indexed
              ? 'Scan ke time short video ke embeddings se matching chunks nikale jayenge — sirf wahi chunks Gemini ko jayenge (threshold 0.75, ±1 buffer chunks). Koi bhi doubt/error = automatic full scan.'
              : 'One-time indexing: movie Twelve Labs par upload hogi, embeddings download hokar save ho jayenge, aur har scan me reuse honge. Poori tarah optional — bina iske sab kuch abhi jaisa chalta hai.'}
      </p>
    </section>
  )
}
