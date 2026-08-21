'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, Clock3, FileJson } from 'lucide-react'
import type { Scan, ChunkState, ChunkFoundSegment, SegmentMatch } from '@/lib/types'
import { fmtTime } from '@/lib/format'

const CHUNK_SECONDS = 60

type SegBadgeState = 'confirmed' | 'verifying' | 'rejected' | 'candidate'

/** Derive the live verification state of ONE found window inside ONE chunk. */
function badgeState(scan: Scan, chunk: ChunkState, f: ChunkFoundSegment): SegBadgeState {
  const sm: SegmentMatch | undefined = (scan.segmentMatches || []).find((s) => s.segmentIndex === f.segmentIndex)
  if (!sm) return 'candidate'
  const base = chunk.index * CHUNK_SECONDS
  const wStart = base + f.chunkStart
  const wEnd = base + f.chunkEnd
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.3
  // This exact window was finally rejected by the 24fps verifier.
  if ((sm.rejectedWindows || []).some((w) => near(w[0], wStart) && near(w[1], wEnd))) return 'rejected'
  // This window is the segment's current primary mapping.
  if (sm.chunkIndex === chunk.index && near(sm.movieStart, wStart) && near(sm.movieEnd, wEnd)) {
    const st = sm.verification?.state
    if (st === 'confirmed') return 'confirmed'
    if (st === 'rejected_final') return 'rejected'
    return 'verifying'
  }
  return 'candidate'
}

const BADGE_STYLE: Record<SegBadgeState, string> = {
  confirmed: 'bg-primary/15 text-primary border-primary/30',
  verifying: 'bg-secondary text-muted-foreground border-border',
  rejected: 'bg-destructive/10 text-destructive border-destructive/30 line-through',
  candidate: 'bg-secondary text-foreground border-border',
}

const BADGE_LABEL: Record<SegBadgeState, string> = {
  confirmed: 'confirmed',
  verifying: 'verifying',
  rejected: 'rejected',
  candidate: 'candidate',
}

export function ChunkResultsPanel({ scan }: { scan: Scan }) {
  const visible = scan.chunks.filter(
    (c) => c.status !== 'pending' || (c.foundSegments?.length ?? 0) > 0 || (c.rawOutputs?.length ?? 0) > 0,
  )
  if (visible.length === 0) return null

  return (
    <section aria-label="Chunk timeline results" className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Clock3 className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Chunk Timeline — Segments Found Per Minute</h2>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {visible.length}/{scan.chunkCount} chunk(s)
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Live per-minute results: which short-video segments were located in each movie minute, their exact windows,
        and the full Gemini output behind every verdict (click the arrow).
      </p>
      <div className="mt-3 flex flex-col gap-1.5">
        {visible.map((c) => (
          <ChunkRow key={c.index} scan={scan} chunk={c} />
        ))}
      </div>
    </section>
  )
}

function ChunkRow({ scan, chunk }: { scan: Scan; chunk: ChunkState }) {
  const [open, setOpen] = useState(false)
  const base = chunk.index * CHUNK_SECONDS
  const end = Math.min(base + CHUNK_SECONDS, scan.movieDuration || base + CHUNK_SECONDS)
  const found = chunk.foundSegments || []
  const raws = chunk.rawOutputs || []
  const scanning = chunk.status === 'scanning'

  return (
    <div className="rounded-md border border-border bg-background">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="font-mono text-xs font-semibold text-foreground">
          {fmtTime(base)} – {fmtTime(end)}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">chunk {chunk.index}</span>
        {scanning && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">scanning…</span>}
        {chunk.status === 'no_match' && found.length === 0 && (
          <span className="text-[11px] text-muted-foreground">no segments found</span>
        )}
        {chunk.status === 'failed' && <span className="text-[11px] text-destructive">failed</span>}
        <div className="flex flex-wrap items-center gap-1.5">
          {found.map((f) => {
            const st = badgeState(scan, chunk, f)
            return (
              <span
                key={`${f.segmentIndex}-${f.chunkStart}`}
                title={`S${f.segmentIndex}: ${fmtTime(base + f.chunkStart)} – ${fmtTime(base + f.chunkEnd)} in movie · conf ${f.confidence} · ${f.speed} · ${BADGE_LABEL[st]}`}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] ${BADGE_STYLE[st]}`}
              >
                S{f.segmentIndex}
                <span className="opacity-70">
                  {fmtTime(base + f.chunkStart)}–{fmtTime(base + f.chunkEnd)}
                </span>
                <span className="opacity-70">c{f.confidence}</span>
                <span className="sr-only">{BADGE_LABEL[st]}</span>
              </span>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={raws.length === 0}
          aria-expanded={open}
          className="ml-auto flex items-center gap-1 rounded-md border border-input px-2 py-1 text-[11px] font-medium hover:bg-secondary disabled:opacity-30"
        >
          {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
          Gemini output {raws.length > 0 ? `(${raws.length})` : ''}
        </button>
      </div>
      {open && raws.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
          {raws.map((r, i) => (
            <div key={`${r.t}-${i}`} className="rounded-md border border-border bg-card">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1">
                <FileJson className="size-3.5 text-muted-foreground" aria-hidden />
                <span className="rounded-full bg-secondary px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                  {r.kind}
                </span>
                {r.segment !== undefined && <span className="font-mono text-[10px] text-foreground">S{r.segment}</span>}
                <span className="font-mono text-[10px] text-muted-foreground">{r.model}</span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {new Date(r.t).toLocaleTimeString()}
                </span>
              </div>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-[10px] leading-relaxed text-foreground">
                {r.text}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
