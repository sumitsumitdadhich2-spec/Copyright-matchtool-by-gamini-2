'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, SplitSquareHorizontal } from 'lucide-react'
import type { Scan, MatchRegion } from '@/lib/types'
import { fmtTime } from '@/lib/format'

/** Side-by-side preview of each matched region: short-video segment vs movie segment,
 *  with Previous / Next buttons to step through the regions. */
export function ComparePanel({ scan }: { scan: Scan }) {
  const regions = scan.regions
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const shortRef = useRef<HTMLVideoElement>(null)
  const movieRef = useRef<HTMLVideoElement>(null)

  const region: MatchRegion | undefined = regions[Math.min(idx, regions.length - 1)]

  // Keep index in range when regions change between refreshes.
  useEffect(() => {
    if (idx > 0 && idx >= regions.length) setIdx(Math.max(0, regions.length - 1))
  }, [idx, regions.length])

  // Seek both players to the region start whenever the region changes.
  useEffect(() => {
    if (!region) return
    const sv = shortRef.current
    const mv = movieRef.current
    if (sv) {
      sv.pause()
      sv.currentTime = region.shortStart
    }
    if (mv) {
      mv.pause()
      mv.currentTime = region.movieStart
    }
    setPlaying(false)
  }, [region?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!region) return null

  function clampLoop(video: HTMLVideoElement | null, start: number, end: number) {
    if (!video) return
    if (video.currentTime >= end || video.currentTime < start - 0.25) {
      video.currentTime = start
      video.pause()
      setPlaying(false)
    }
  }

  function togglePlay() {
    const sv = shortRef.current
    const mv = movieRef.current
    if (!sv || !mv) return
    if (playing) {
      sv.pause()
      mv.pause()
      setPlaying(false)
    } else {
      // Re-align both to the segment start if either has drifted past the end.
      if (sv.currentTime >= region!.shortEnd - 0.05) sv.currentTime = region!.shortStart
      if (mv.currentTime >= region!.movieEnd - 0.05) mv.currentTime = region!.movieStart
      void sv.play()
      void mv.play()
      setPlaying(true)
    }
  }

  function restart() {
    const sv = shortRef.current
    const mv = movieRef.current
    if (sv) sv.currentTime = region!.shortStart
    if (mv) mv.currentTime = region!.movieStart
  }

  const src = (kind: 'short' | 'movie') => `/api/scans/${scan.id}/media?kind=${kind}`

  return (
    <section aria-label="Side-by-side comparison" className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <SplitSquareHorizontal className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Side-by-Side Comparison</h2>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">
          region {idx + 1} / {regions.length}
        </span>
        {region.verified && (
          <span
            className={`rounded-full px-2 py-0.5 font-mono text-xs ${
              region.verified.match ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'
            }`}
          >
            {region.verified.match ? 'verified match' : 'rejected'} · {region.verified.confidence}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIdx((i) => Math.max(0, i - 1))}
            disabled={idx === 0}
            className="flex items-center gap-1 rounded-md border border-input px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-40"
          >
            <ChevronLeft className="size-3.5" aria-hidden /> Previous
          </button>
          <button
            type="button"
            onClick={() => setIdx((i) => Math.min(regions.length - 1, i + 1))}
            disabled={idx >= regions.length - 1}
            className="flex items-center gap-1 rounded-md border border-input px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-40"
          >
            Next <ChevronRight className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:gap-3">
        <figure className="flex flex-col gap-1.5">
          <figcaption className="flex flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:justify-between">
            <span className="font-medium">Short video</span>
            <span className="font-mono text-muted-foreground">
              {fmtTime(region.shortStart)} – {fmtTime(region.shortEnd)}
            </span>
          </figcaption>
          <video
            ref={shortRef}
            src={src('short')}
            preload="metadata"
            muted
            playsInline
            onTimeUpdate={() => clampLoop(shortRef.current, region.shortStart, region.shortEnd)}
            className="aspect-video w-full rounded-md border border-border bg-black object-contain"
          />
        </figure>
        <figure className="flex flex-col gap-1.5">
          <figcaption className="flex flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:justify-between">
            <span className="font-medium">Movie</span>
            <span className="font-mono text-muted-foreground">
              {fmtTime(region.movieStart)} – {fmtTime(region.movieEnd)}
            </span>
          </figcaption>
          <video
            ref={movieRef}
            src={src('movie')}
            preload="metadata"
            muted
            playsInline
            onTimeUpdate={() => clampLoop(movieRef.current, region.movieStart, region.movieEnd)}
            className="aspect-video w-full rounded-md border border-border bg-black object-contain"
          />
        </figure>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={togglePlay}
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground"
        >
          {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          {playing ? 'Pause both' : 'Play both'}
        </button>
        <button
          type="button"
          onClick={restart}
          className="flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-xs font-medium hover:bg-secondary"
        >
          <RotateCcw className="size-3.5" aria-hidden /> Restart segment
        </button>
        <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">scan conf {region.maxConfidence}</span>
      </div>
      {region.verified?.note && <p className="mt-2 text-xs italic text-muted-foreground">{region.verified.note}</p>}
    </section>
  )
}
