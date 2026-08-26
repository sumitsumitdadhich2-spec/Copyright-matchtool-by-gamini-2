'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Layers, Loader2, Check, AlertTriangle, Filter } from 'lucide-react'
import type { Scan, TwelveLabsState, PrefilterInfo } from '@/lib/types'
import { fetcher } from '@/lib/format'

interface TLStatusResponse {
  hasKey: boolean
  twelveLabs: TwelveLabsState
  embeddingsSaved: boolean
  embeddingsCount: number
  prefilter: PrefilterInfo | null
}

/** SEPARATE optional section at the top of the app. Twelve Labs is a pure
 *  pre-filter — without a key (or on any error) the existing Gemini flow
 *  runs 100% unchanged (normal full scan). */
export function TwelveLabsPanel({ scan }: { scan: Scan }) {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data, mutate } = useSWR<TLStatusResponse>(
    scan.id ? `/api/scans/${scan.id}/twelvelabs` : null,
    fetcher,
    {
      refreshInterval: (latest) => (latest?.twelveLabs?.status === 'indexing' ? 3000 : 15000),
    },
  )

  const tl = data?.twelveLabs ?? scan.twelveLabs ?? { status: 'none' as const }
  const hasKey = data?.hasKey ?? false
  const indexed = tl.status === 'ready' || (data?.embeddingsSaved ?? false)
  const indexing = tl.status === 'indexing'
  const prefilter = data?.prefilter ?? scan.prefilter ?? null
  const movieReady = Boolean(scan.movieDuration) && !scan.awaitingTrim

  async function startIndexing() {
    setStarting(true)
    setError(null)
    const res = await fetch(`/api/scans/${scan.id}/twelvelabs`, { method: 'POST' })
    setStarting(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Indexing start failed')
    }
    void mutate()
  }

  return (
    <section aria-label="Twelve Labs pre-filter" className="panel">
      <div className="flex flex-wrap items-center gap-2">
        <Layers className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">
          Twelve Labs Pre-Filter <span className="font-normal text-muted-foreground">(Optional)</span>
        </h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!hasKey ? (
            <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground">
              key not set — normal full scan
            </span>
          ) : indexed ? (
            <span className="flex items-center gap-1 rounded-full bg-success/15 px-2.5 py-0.5 text-xs text-success">
              <Check className="size-3" aria-hidden />
              Movie indexed{tl.segmentCount ? ` — ${tl.segmentCount} segments` : ''}
            </span>
          ) : indexing ? (
            <span className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/15 px-2.5 py-0.5 text-xs text-primary">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              Indexing...
            </span>
          ) : (
            <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground">not indexed</span>
          )}
          {hasKey && !indexed && (
            <button
              type="button"
              onClick={() => startIndexing()}
              disabled={starting || indexing || !movieReady}
              title={!movieReady ? 'Pehle movie upload/trim complete karo' : 'Index the movie on Twelve Labs'}
              className="btn-press rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm disabled:opacity-40"
            >
              {starting || indexing ? 'Indexing...' : 'Index Movie on Twelve Labs'}
            </button>
          )}
        </div>
      </div>

      {indexing && tl.progress && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin text-primary" aria-hidden />
          {tl.progress}
        </p>
      )}

      {tl.status === 'error' && tl.error && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>
            Indexing error: {tl.error} — koi problem nahi, scan normal FULL mode me chalega (accuracy 100% safe).
          </span>
        </p>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      {prefilter && (
        <p className="mt-2 flex items-center gap-1.5 text-xs">
          <Filter className="size-3 text-primary" aria-hidden />
          {prefilter.mode === 'prefiltered' ? (
            <span className="text-success">
              Pre-filter: {prefilter.selectedChunks} of {prefilter.totalChunks} chunks selected (Twelve Labs)
            </span>
          ) : (
            <span className="text-muted-foreground">
              Full scan: all {prefilter.totalChunks} chunks{prefilter.reason ? ` — ${prefilter.reason}` : ''}
            </span>
          )}
        </p>
      )}

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Optional: movie ko ek baar index karo — har scan me embeddings reuse hoti hain aur sirf matching chunks Gemini ko
        jaate hain (threshold 0.75 + buffer chunks, koi match miss nahi hota). Key ya index na ho, ya koi error aaye — app
        automatically normal full scan chalata hai.
      </p>
    </section>
  )
}
