'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Target, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import type { Scan, Candidate } from '@/lib/types'
import { fmtTimeMs } from '@/lib/format'

/** Natural sort key so S2 comes before S10, and coarse candidates sort by short start. */
function segOrder(c: Candidate): number {
  if (c.segmentId) {
    const n = Number(c.segmentId.replace(/[^0-9]/g, ''))
    if (Number.isFinite(n)) return n
  }
  return 1000 + c.shortSegment[0]
}

export function CandidatesPanel({ scan }: { scan: Scan }) {
  const candidates = useMemo(
    () => [...scan.candidates].sort((a, b) => segOrder(a) - segOrder(b)),
    [scan.candidates],
  )
  const [index, setIndex] = useState(0)

  // Keep the active index in range as new matches stream in.
  useEffect(() => {
    if (index > candidates.length - 1) setIndex(Math.max(0, candidates.length - 1))
  }, [candidates.length, index])

  const active = candidates[index]

  return (
    <section aria-label="Segment match map" className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Target className="size-4 text-destructive" aria-hidden />
        <h2 className="text-sm font-semibold">Segment Match Map</h2>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {candidates.length} mapped
        </span>
      </div>

      {candidates.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Each short-video segment (S1, S2, …) is mapped to the exact spot it appears in the movie. Matches show up here
          live, side by side, as the scan runs.
        </p>
      ) : (
        <>
          <SegmentTabs candidates={candidates} index={index} onSelect={setIndex} />
          {active && <ComparisonViewer key={active.id} scan={scan} c={active} />}
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={index === 0}
              className="flex items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-40"
            >
              <ChevronLeft className="size-3.5" aria-hidden /> Previous
            </button>
            <span className="font-mono text-xs text-muted-foreground">
              {index + 1} / {candidates.length}
            </span>
            <button
              type="button"
              onClick={() => setIndex((i) => Math.min(candidates.length - 1, i + 1))}
              disabled={index >= candidates.length - 1}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
            >
              Next preview <ChevronRight className="size-3.5" aria-hidden />
            </button>
          </div>
        </>
      )}
    </section>
  )
}

function SegmentTabs({
  candidates,
  index,
  onSelect,
}: {
  candidates: Candidate[]
  index: number
  onSelect: (i: number) => void
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {candidates.map((c, i) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onSelect(i)}
          className={`rounded-full px-2.5 py-1 font-mono text-xs transition-colors ${
            i === index
              ? 'bg-destructive text-destructive-foreground'
              : 'border border-input text-muted-foreground hover:bg-secondary'
          }`}
        >
          {c.segmentId || `M${i + 1}`}
        </button>
      ))}
    </div>
  )
}

function ComparisonViewer({ scan, c }: { scan: Scan; c: Candidate }) {
  const shortDur = c.shortSegment[1] - c.shortSegment[0]
  const movieDur = c.absSegment[1] - c.absSegment[0]

  return (
    <div className="mt-3 rounded-md border border-destructive/30 bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        {c.segmentId && (
          <span className="rounded-full bg-destructive/15 px-2 py-0.5 font-mono text-xs font-semibold text-destructive">
            {c.segmentId}
          </span>
        )}
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">conf {c.confidence}</span>
        {c.speed && (
          <span
            className={`rounded-full px-2 py-0.5 font-mono text-xs ${
              c.speed === '1.0x' ? 'bg-secondary text-muted-foreground' : 'bg-primary/15 text-primary'
            }`}
          >
            {c.speed === '1.0x' ? 'same speed' : c.speed}
          </span>
        )}
        <span className="ml-auto font-mono text-xs text-muted-foreground">chunk {c.chunkIndex} · {c.model}</span>
      </div>

      {c.segmentDescription && (
        <p className="mt-1.5 text-xs italic text-muted-foreground">{c.segmentDescription}</p>
      )}

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <ClipPlayer
          label="Short clip"
          src={`/api/scans/${scan.id}/media?kind=short`}
          start={c.shortSegment[0]}
          end={c.shortSegment[1]}
          duration={shortDur}
          accent="short"
        />
        <ClipPlayer
          label="Movie match"
          src={`/api/scans/${scan.id}/media?kind=movie`}
          start={c.absSegment[0]}
          end={c.absSegment[1]}
          duration={movieDur}
          accent="movie"
        />
      </div>

      <p className="mt-2 text-center font-mono text-xs text-muted-foreground">
        {shortDur.toFixed(2)}s vs {movieDur.toFixed(2)}s
        {Math.abs(shortDur - movieDur) <= 0.75
          ? ' · near-identical duration'
          : ' · length differs (likely slowed/sped edit)'}
      </p>

      {c.note && <p className="mt-1 text-center text-xs italic text-muted-foreground">{c.note}</p>}
    </div>
  )
}

function ClipPlayer({
  label,
  src,
  start,
  end,
  duration,
  accent,
}: {
  label: string
  src: string
  start: number
  end: number
  duration: number
  accent: 'short' | 'movie'
}) {
  const ref = useRef<HTMLVideoElement>(null)

  // Seek to the segment start once metadata is ready, then start playback.
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const seek = () => {
      try {
        v.currentTime = start
      } catch {
        /* ignore */
      }
    }
    if (v.readyState >= 1) seek()
    else v.addEventListener('loadedmetadata', seek, { once: true })
  }, [start])

  // Loop strictly within [start, end] so the preview stays on the matched footage.
  function onTimeUpdate() {
    const v = ref.current
    if (!v) return
    if (v.currentTime >= end - 0.03 || v.currentTime < start - 0.5) {
      v.currentTime = start
    }
  }

  function replay() {
    const v = ref.current
    if (!v) return
    v.currentTime = start
    void v.play().catch(() => {})
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span
          className={`text-xs font-semibold ${accent === 'short' ? 'text-destructive' : 'text-primary'}`}
        >
          {label}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {fmtTimeMs(start)}–{fmtTimeMs(end)} · {duration.toFixed(2)}s
        </span>
      </div>
      <video
        ref={ref}
        src={src}
        controls
        playsInline
        muted
        onTimeUpdate={onTimeUpdate}
        className="aspect-video w-full rounded-md bg-black"
        aria-label={`${label} from ${fmtTimeMs(start)} to ${fmtTimeMs(end)}`}
      />
      <button
        type="button"
        onClick={replay}
        className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md border border-input py-1 text-xs font-medium hover:bg-secondary"
      >
        <RefreshCw className="size-3" aria-hidden /> Replay segment
      </button>
    </div>
  )
}
