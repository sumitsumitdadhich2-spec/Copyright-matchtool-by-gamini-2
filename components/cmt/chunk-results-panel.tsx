'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, Clock3, FileText } from 'lucide-react'
import type { Scan, ChunkState } from '@/lib/types'
import { fmtTime } from '@/lib/format'

const CHUNK_SECONDS = 60

export function ChunkResultsPanel({ scan }: { scan: Scan }) {
  const visible = scan.chunks.filter(
    (c) => c.status !== 'pending' || (c.matches?.length ?? 0) > 0 || (c.rawOutputs?.length ?? 0) > 0,
  )
  if (visible.length === 0) return null

  return (
    <section aria-label="Chunk timeline results" className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Clock3 className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Chunk Timeline — Matches Per Minute</h2>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {visible.length}/{scan.chunkCount} chunk(s)
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Har movie minute ke liye ek hi Gemini call: short video + wo chunk. HISSA 2 ki matched lines yahan dikhti
        hain (movie time global hai), aur full raw output arrow se dekh sakte ho.
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
  const matches = chunk.matches || []
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
        {chunk.status === 'no_match' && matches.length === 0 && (
          <span className="text-[11px] text-muted-foreground">no matches in this minute</span>
        )}
        {chunk.status === 'failed' && <span className="text-[11px] text-destructive">failed</span>}
        <div className="flex flex-wrap items-center gap-1.5">
          {matches.map((f, i) => (
            <span
              key={`${f.shortStart}-${f.movieStart}-${i}`}
              title={`Short ${fmtTime(f.shortStart)}–${fmtTime(f.shortEnd)} → Movie ${fmtTime(f.movieStart)}–${fmtTime(f.movieEnd)} · ${f.model}`}
              className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/15 px-2 py-0.5 font-mono text-[10px] text-primary"
            >
              {fmtTime(f.shortStart)}–{fmtTime(f.shortEnd)}
              <span aria-hidden>→</span>
              <span className="font-semibold">
                {fmtTime(f.movieStart)}–{fmtTime(f.movieEnd)}
              </span>
            </span>
          ))}
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
                <FileText className="size-3.5 text-muted-foreground" aria-hidden />
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
