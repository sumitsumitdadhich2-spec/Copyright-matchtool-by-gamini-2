'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, SplitSquareHorizontal } from 'lucide-react'
import type { Scan } from '@/lib/types'
import { fmtTime } from '@/lib/format'

/** Side-by-side preview of matched windows: each parsed "Short X --> Movie Y" line
 *  is one pair with (near-)equal durations on both sides. */
export function ComparePanel({ scan }: { scan: Scan }) {
  const pairs = scan.matches || []
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const shortRef = useRef<HTMLVideoElement>(null)
  const movieRef = useRef<HTMLVideoElement>(null)

  const pair = pairs[Math.min(idx, pairs.length - 1)]

  // Keep index in range when pairs change between refreshes.
  useEffect(() => {
    if (idx > 0 && idx >= pairs.length) setIdx(Math.max(0, pairs.length - 1))
  }, [idx, pairs.length])

  // Seek both players to the pair start whenever the pair changes.
  useEffect(() => {
    if (!pair) return
    const sv = shortRef.current
    const mv = movieRef.current
    if (sv) {
      sv.pause()
      sv.currentTime = pair.shortStart
    }
    if (mv) {
      mv.pause()
      mv.currentTime = pair.movieStart
    }
    setPlaying(false)
  }, [pair?.shortStart, pair?.movieStart]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!pair) return null

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
      // Re-align both to the window start if either has drifted past the end.
      if (sv.currentTime >= pair!.shortEnd - 0.05) sv.currentTime = pair!.shortStart
      if (mv.currentTime >= pair!.movieEnd - 0.05) mv.currentTime = pair!.movieStart
      void sv.play()
      void mv.play()
      setPlaying(true)
    }
  }

  function restart() {
    const sv = shortRef.current
    const mv = movieRef.current
    if (sv) sv.currentTime = pair!.shortStart
    if (mv) mv.currentTime = pair!.movieStart
  }

  const src = (kind: 'short' | 'movie') => `/api/scans/${scan.id}/media?kind=${kind}`
  const duration = pair.shortEnd - pair.shortStart

  return (
    <section aria-label="Side-by-side comparison" className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <SplitSquareHorizontal className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Side-by-Side Match Comparison</h2>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">
          match {idx + 1} / {pairs.length}
        </span>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">{duration.toFixed(3)}s</span>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">chunk {pair.chunkIndex}</span>
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
            onClick={() => setIdx((i) => Math.min(pairs.length - 1, i + 1))}
            disabled={idx >= pairs.length - 1}
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
              {fmtTime(pair.shortStart)} – {fmtTime(pair.shortEnd)}
            </span>
          </figcaption>
          <video
            ref={shortRef}
            src={src('short')}
            preload="metadata"
            muted
            playsInline
            onTimeUpdate={() => clampLoop(shortRef.current, pair.shortStart, pair.shortEnd)}
            className="aspect-video w-full rounded-md border border-border bg-black object-contain"
          />
        </figure>
        <figure className="flex flex-col gap-1.5">
          <figcaption className="flex flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:justify-between">
            <span className="font-medium">Movie</span>
            <span className="font-mono text-muted-foreground">
              {fmtTime(pair.movieStart)} – {fmtTime(pair.movieEnd)}
            </span>
          </figcaption>
          <video
            ref={movieRef}
            src={src('movie')}
            preload="metadata"
            muted
            playsInline
            onTimeUpdate={() => clampLoop(movieRef.current, pair.movieStart, pair.movieEnd)}
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
          <RotateCcw className="size-3.5" aria-hidden /> Restart match
        </button>
        <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">{pair.model}</span>
      </div>
    </section>
  )
}
