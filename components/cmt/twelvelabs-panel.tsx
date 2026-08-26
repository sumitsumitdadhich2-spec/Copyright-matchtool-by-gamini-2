'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { Layers, Loader2, Check, AlertTriangle, Filter, Clock, Zap } from 'lucide-react'
import type { Scan, TwelveLabsState, PrefilterInfo } from '@/lib/types'
import { fetcher } from '@/lib/format'

interface TLStatusResponse {
  hasKey: boolean
  twelveLabs: TwelveLabsState
  embeddingsSaved: boolean
  embeddingsCount: number
  prefilter: PrefilterInfo | null
}

/** Stage-based indexing progress (TL koi % nahi deta — stage se estimate). */
function stagePct(progress?: string): number {
  if (!progress) return 5
  const p = progress.toLowerCase()
  if (p.includes('download')) return 90
  if (p.includes('indexing')) return 55
  if (p.includes('upload')) return 18
  return 8
}

function fmtDur(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

/** SEPARATE optional section at the top of the app. Twelve Labs is a pure
 *  pre-filter — without a key (or on any error) the existing Gemini flow
 *  runs 100% unchanged (normal full scan). */
export function TwelveLabsPanel({ scan }: { scan: Scan }) {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 1s tick for the live elapsed timer during indexing.
  const [, setTick] = useState(0)

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

  useEffect(() => {
    if (!indexing) return
    const t = setInterval(() => setTick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [indexing])

  // Key na ho (ya status abhi load ho raha ho) to section bilkul na dikhe —
  // app 100% normal dikhta aur chalta hai. Key dalte hi section aa jata hai.
  if (!data || !hasKey) return null

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

  const elapsed = tl.startedAt ? Date.now() - tl.startedAt : 0
  // Rough estimate: upload + indexing time roughly scales with movie length.
  const estimateMin = scan.movieDuration ? Math.max(3, Math.round((scan.movieDuration / 60) * 0.15)) : null
  const pct = stagePct(tl.progress)

  // PER-MINUTE PLAN (Twelve Labs): har short minute ke liye kitne chunks scan/verify
  // honge, kitne windows expected hain, kitne match mile, early-stop ne kitne bachaye.
  const minuteRows = (scan.shortSegments || [])
    .filter((s) => s.selected !== false && Array.isArray(s.prefilterChunks) && s.prefilterChunks.length > 0)
    .map((s) => {
      const planned = s.prefilterChunks!.length
      const scanned = s.chunks.filter((c) => c.status === 'match' || c.status === 'no_match').length
      const matched = s.chunks.filter((c) => c.status === 'match').length
      return {
        index: s.index,
        planned,
        scanned,
        matched,
        windows: s.tlWindows?.length ?? 0,
        saved: s.earlyStopSavedChunks ?? 0,
        status: s.status,
      }
    })

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

      {/* LIVE INDEXING TRACKING: stage progress bar + elapsed + rough estimate */}
      {indexing && (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="size-3 animate-spin text-primary" aria-hidden />
              {tl.progress || 'Working...'}
            </span>
            <span className="flex items-center gap-1 tabular-nums text-muted-foreground">
              <Clock className="size-3" aria-hidden />
              {tl.startedAt ? fmtDur(elapsed) : '--'}
              {estimateMin ? ` / ~${estimateMin}m estimate` : ''}
            </span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Twelve Labs indexing progress"
            className="h-1.5 w-full overflow-hidden rounded-full bg-secondary"
          >
            <div className="h-full rounded-full bg-primary transition-all duration-700" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Stage: {pct < 30 ? 'Upload' : pct < 80 ? 'Indexing (Marengo embeddings)' : 'Embeddings download'} — ye
            one-time kaam hai, har scan me reuse hota hai.
          </p>
        </div>
      )}

      {/* DONE: kitna time laga pura kaam hone me */}
      {indexed && tl.totalMs ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3" aria-hidden />
          Indexing me total {fmtDur(tl.totalMs)} laga (upload → index → embeddings download).
        </p>
      ) : null}

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

      {/* PER-MINUTE PLAN: har minute me kitne chunks scan/verify honge + live progress */}
      {prefilter?.mode === 'prefiltered' && minuteRows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-xs">
            <caption className="sr-only">Twelve Labs per-minute chunk plan</caption>
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th scope="col" className="py-1.5 pr-2 font-medium">Minute</th>
                <th scope="col" className="py-1.5 pr-2 font-medium">Chunks to scan</th>
                <th scope="col" className="py-1.5 pr-2 font-medium">Scanned</th>
                <th scope="col" className="py-1.5 pr-2 font-medium">Chunks w/ match</th>
                <th scope="col" className="py-1.5 pr-2 font-medium">Expected windows</th>
                <th scope="col" className="py-1.5 font-medium">Early-stop saved</th>
              </tr>
            </thead>
            <tbody>
              {minuteRows.map((r) => (
                <tr key={r.index} className="border-b border-border/50 last:border-0">
                  <td className="py-1.5 pr-2 font-medium">
                    {r.index + 1}
                    {r.status === 'done' && <Check className="ml-1 inline size-3 text-success" aria-label="done" />}
                    {(r.status === 'scanning' || r.status === 'verifying') && (
                      <Loader2 className="ml-1 inline size-3 animate-spin text-primary" aria-label={r.status} />
                    )}
                  </td>
                  <td className="py-1.5 pr-2 tabular-nums">{r.planned}</td>
                  <td className="py-1.5 pr-2 tabular-nums text-muted-foreground">
                    {r.scanned}/{r.planned}
                  </td>
                  <td className="py-1.5 pr-2 tabular-nums">{r.matched}</td>
                  <td className="py-1.5 pr-2 tabular-nums">{r.windows}</td>
                  <td className="py-1.5 tabular-nums">
                    {r.saved > 0 ? (
                      <span className="flex items-center gap-1 text-success">
                        <Zap className="size-3" aria-hidden />
                        {r.saved} chunk(s)
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Optional: movie ko ek baar index karo — har scan me embeddings reuse hoti hain aur sirf matching chunks Gemini ko
        jaate hain (threshold 0.82 — strong matches only, quota saver + buffer chunks). Har expected window ka match
        milte hi aur har matched chunk ka 1 segment verify hote hi bache chunks skip ho jaate hain (early-stop). Key ya
        index na ho, ya koi error aaye — app automatically normal full scan chalata hai.
      </p>
    </section>
  )
}
