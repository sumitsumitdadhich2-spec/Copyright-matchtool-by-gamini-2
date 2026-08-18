'use client'

import type { Scan } from '@/lib/types'
import { fmtTime } from '@/lib/format'

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-muted',
  scanning: 'bg-primary animate-pulse',
  no_match: 'bg-success/70',
  match: 'bg-destructive',
  failed: 'bg-amber-500/80',
  cancelled: 'bg-muted/50',
}

export function ScanTimeline({ scan }: { scan: Scan }) {
  if (scan.chunkCount === 0) {
    return (
      <section aria-label="Scan timeline" className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Scan Timeline</h2>
        <p className="mt-2 text-xs text-muted-foreground">Upload a movie to see the minute-by-minute timeline.</p>
      </section>
    )
  }

  const done = scan.chunks.filter((c) => c.status === 'match' || c.status === 'no_match').length

  return (
    <section aria-label="Scan timeline" className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Scan Timeline</h2>
        <span className="font-mono text-xs text-muted-foreground">
          {done}/{scan.chunkCount} chunks
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1" role="list" aria-label="Movie minute blocks">
        {scan.chunks.map((c) => (
          <div
            key={c.index}
            role="listitem"
            title={`Minute ${c.index} (${fmtTime(c.index * 60)}) — ${c.status}${c.model ? ` · ${c.model}` : ''}${
              c.confidence !== undefined ? ` · conf ${c.confidence}` : ''
            }`}
            className={`h-5 w-5 rounded-sm ${STATUS_CLASS[c.status] || 'bg-muted'} transition-colors`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <LegendDot cls="bg-muted" label="pending" />
        <LegendDot cls="bg-primary" label="scanning" />
        <LegendDot cls="bg-success/70" label="no match" />
        <LegendDot cls="bg-destructive" label="match" />
        <LegendDot cls="bg-amber-500/80" label="failed" />
        <LegendDot cls="bg-muted/50" label="cancelled" />
      </div>
    </section>
  )
}

function LegendDot({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${cls}`} aria-hidden />
      {label}
    </span>
  )
}
