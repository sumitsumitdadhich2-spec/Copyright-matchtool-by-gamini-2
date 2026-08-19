'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, SplitSquareHorizontal } from 'lucide-react'
import type { Scan, SegmentVerification } from '@/lib/types'
import { fmtTime } from '@/lib/format'

/** One comparable pair: a short-video time range mapped to a movie time range of equal duration. */
interface ComparePair {
  id: string
  label: string
  shortStart: number
  shortEnd: number
  movieStart: number
  movieEnd: number
  confidence: number
  speed?: string
  verified?: { match: boolean; confidence: number; note?: string }
  /** live 2-key verification state for this segment */
  verification?: SegmentVerification
}

/** Side-by-side preview of matched timelapses. When the frame-by-frame segment map exists,
 *  every segment (S1, S2, ...) is its own pair with EXACTLY equal durations on both sides.
 *  Falls back to merged regions for legacy scans. */
export function ComparePanel({ scan }: { scan: Scan }) {
  const pairs = useMemo<ComparePair[]>(() => {
    const sms = scan.segmentMatches || []
    if (sms.length > 0) {
      return [...sms]
        .sort((a, b) => a.segmentIndex - b.segmentIndex)
        .map((s) => {
          const region = scan.regions.find((r) => (r.segmentIndexes || []).includes(s.segmentIndex))
          return {
            id: `S${s.segmentIndex}`,
            label: `S${s.segmentIndex}`,
            shortStart: s.shortStart,
            shortEnd: s.shortEnd,
            movieStart: s.movieStart,
            movieEnd: s.movieEnd,
            confidence: s.confidence,
            speed: s.speed,
            verification: s.verification,
            verified: region?.verified
              ? { match: region.verified.match, confidence: region.verified.confidence, note: region.verified.note }
              : undefined,
          }
        })
    }
    return scan.regions.map((r, i) => ({
      id: r.id,
      label: `region ${i + 1}`,
      shortStart: r.shortStart,
      shortEnd: r.shortEnd,
      movieStart: r.movieStart,
      movieEnd: r.movieEnd,
      confidence: r.maxConfidence,
      verified: r.verified
        ? { match: r.verified.match, confidence: r.verified.confidence, note: r.verified.note }
        : undefined,
    }))
  }, [scan.segmentMatches, scan.regions])

  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const shortRef = useRef<HTMLVideoElement>(null)
  const movieRef = useRef<HTMLVideoElement>(null)

  const pair: ComparePair | undefined = pairs[Math.min(idx, pairs.length - 1)]

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
  }, [pair?.id]) // eslint-disable-line react-hooks/exhaustive-deps

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
      // Re-align both to the segment start if either has drifted past the end.
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
  const isSegmentMode = (scan.segmentMatches || []).length > 0

  return (
    <section aria-label="Side-by-side comparison" className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <SplitSquareHorizontal className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">{isSegmentMode ? 'Frame-by-Frame Segment Comparison' : 'Side-by-Side Comparison'}</h2>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">
          {pair.label} · {idx + 1} / {pairs.length}
        </span>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">{duration.toFixed(3)}s{pair.speed && pair.speed !== '1.0x' ? ` @ ${pair.speed}` : ''}</span>
        {pair.verification ? (
          <span
            className={`rounded-full px-2 py-0.5 font-mono text-xs ${
              pair.verification.state === 'confirmed'
                ? 'bg-success/15 text-success'
                : pair.verification.state === 'rejected_final'
                  ? 'bg-destructive/15 text-destructive'
                  : 'bg-secondary text-muted-foreground'
            }`}
          >
            {pair.verification.state === 'confirmed'
              ? `CONFIRMED @24fps · ${pair.verification.confidence ?? ''}`
              : pair.verification.state === 'rejected_final'
                ? 'REJECTED by Verifier (API 2)'
                : pair.verification.state === 'rescanning'
                  ? 're-scanning @13fps'
                  : pair.verification.state === 'verifying'
                    ? 'verifying @24fps'
                    : 'pending verification'}
          </span>
        ) : (
          pair.verified && (
            <span
              className={`rounded-full px-2 py-0.5 font-mono text-xs ${
                pair.verified.match ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'
              }`}
            >
              {pair.verified.match ? 'verified match' : 'rejected'} · {pair.verified.confidence}
            </span>
          )
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
          <RotateCcw className="size-3.5" aria-hidden /> Restart segment
        </button>
        <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">scan conf {pair.confidence}</span>
      </div>
      {pair.verification?.state === 'rejected_final' && pair.verification.reason && (
        <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs leading-relaxed text-destructive">
          Rejected by Verifier (API 2): {pair.verification.reason}
        </p>
      )}
      {pair.verification?.state === 'confirmed' && pair.verification.note && (
        <p className="mt-2 text-xs italic text-success">{pair.verification.note}</p>
      )}
      {pair.verified?.note && <p className="mt-2 text-xs italic text-muted-foreground">{pair.verified.note}</p>}
    </section>
  )
}
