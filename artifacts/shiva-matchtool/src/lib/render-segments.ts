import type { Scan } from './types'

export interface RenderSegment {
  movieStart: number
  movieEnd: number
  shortStart: number
  shortEnd: number
}

/** Single source of truth for both instant preview and exported scene order.
 *
 *  Ordering rules:
 *  1. Scenes ALWAYS follow the short video's timeline (shortStart ascending).
 *  2. When two matches overlap on the short timeline, VERIFIED matches win
 *     over unverified ones; ties break on the earlier movie window.
 *  3. Overlapping tails are TRIMMED (1:1 time mapping) instead of dropping the
 *     whole match, so no short-video coverage is silently lost.
 *  4. Back-to-back matches that are continuous in BOTH clocks (e.g. a scene
 *     crossing the 60s minute boundary of a 2-min short) are MERGED into one
 *     scene, so the render has no artificial cut at the boundary. */
export function buildRenderSegments(scan: Pick<Scan, 'matches'>): RenderSegment[] {
  const matches = [...(scan.matches || [])]
    .filter((match) => match.movieEnd - match.movieStart > 0.05)
    .sort(
      (a, b) =>
        a.shortStart - b.shortStart ||
        Number(b.verified === true) - Number(a.verified === true) ||
        a.movieStart - b.movieStart,
    )

  const segments: RenderSegment[] = []
  for (const match of matches) {
    let { shortStart, movieStart } = match
    const { shortEnd, movieEnd } = match
    const previous = segments.at(-1)

    if (previous) {
      const overlap = previous.shortEnd - shortStart
      if (overlap > 0.25) {
        // Fully covered already (duplicate candidate for the same short window) — skip.
        if (shortEnd <= previous.shortEnd + 0.25) continue
        // Partial overlap — trim the front (mapping is 1:1 same-duration) so the
        // extra tail is kept instead of throwing the whole match away.
        movieStart += previous.shortEnd - shortStart
        shortStart = previous.shortEnd
        if (shortEnd - shortStart <= 0.05 || movieEnd - movieStart <= 0.05) continue
      }
      // CONTINUITY MERGE: continuous in both the short AND the movie clock
      // (typical at the 60s minute boundary of a multi-minute short).
      if (
        Math.abs(shortStart - previous.shortEnd) <= 0.25 &&
        Math.abs(movieStart - previous.movieEnd) <= 0.25 &&
        movieEnd > previous.movieEnd
      ) {
        previous.shortEnd = shortEnd
        previous.movieEnd = movieEnd
        continue
      }
    }

    segments.push({ movieStart, movieEnd, shortStart, shortEnd })
  }
  return segments
}

export function totalStitchedSeconds(segments: RenderSegment[]): number {
  return segments.reduce((total, segment) => total + Math.max(0, segment.movieEnd - segment.movieStart), 0)
}
