import { CHUNK_SECONDS } from './models'
import type { Scan, ShortSegmentState } from './types'

/** Client-safe helpers for the PER-MINUTE movie search range feature.
 *  Shared by the scheduler (server), the segments API route and the
 *  minute-select UI so all three agree on which chunks a minute covers. */

/** ABSOLUTE original-movie window of a chunk: chunks cover ONLY the confirmed
 *  trim range, so every chunk's absolute start = trimStart + index * 60. */
export function chunkAbsWindow(
  scan: Pick<Scan, 'movieTrimStart' | 'movieTrimEnd' | 'movieDuration'>,
  chunkIndex: number,
): { start: number; end: number } {
  const trimStart = scan.movieTrimStart ?? 0
  const rangeEnd = scan.movieTrimEnd ?? scan.movieDuration ?? Number.POSITIVE_INFINITY
  const start = trimStart + chunkIndex * CHUNK_SECONDS
  return { start, end: Math.min(start + CHUNK_SECONDS, rangeEnd) }
}

/** Effective movie search range for one short minute: its own per-minute range
 *  (clamped inside the trim window), or the whole trim window when unset. */
export function segMovieRange(
  scan: Pick<Scan, 'movieTrimStart' | 'movieTrimEnd' | 'movieDuration'>,
  seg: Pick<ShortSegmentState, 'movieRangeStart' | 'movieRangeEnd'>,
): { start: number; end: number; custom: boolean } {
  const trimStart = scan.movieTrimStart ?? 0
  const trimEnd = scan.movieTrimEnd ?? scan.movieDuration ?? Number.POSITIVE_INFINITY
  const hasCustom =
    typeof seg.movieRangeStart === 'number' && typeof seg.movieRangeEnd === 'number' && seg.movieRangeEnd > seg.movieRangeStart
  if (!hasCustom) return { start: trimStart, end: trimEnd, custom: false }
  const start = Math.max(trimStart, seg.movieRangeStart!)
  const end = Math.min(trimEnd, seg.movieRangeEnd!)
  if (end <= start) return { start: trimStart, end: trimEnd, custom: false }
  return { start, end, custom: true }
}

/** True when a movie chunk overlaps the minute's chosen movie search range —
 *  chunks outside the range are skipped for that minute (quota saver). */
export function chunkOverlapsSegRange(
  scan: Pick<Scan, 'movieTrimStart' | 'movieTrimEnd' | 'movieDuration'>,
  seg: Pick<ShortSegmentState, 'movieRangeStart' | 'movieRangeEnd'>,
  chunkIndex: number,
): boolean {
  const w = chunkAbsWindow(scan, chunkIndex)
  const r = segMovieRange(scan, seg)
  return w.start < r.end && w.end > r.start
}
