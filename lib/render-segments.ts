import type { Scan } from './types'

export interface RenderSegment {
  movieStart: number
  movieEnd: number
  shortStart: number
  shortEnd: number
}

/** Single source of truth for both instant preview and exported scene order. */
export function buildRenderSegments(scan: Pick<Scan, 'matches'>): RenderSegment[] {
  const matches = [...(scan.matches || [])]
    .filter((match) => match.movieEnd - match.movieStart > 0.05)
    .sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)

  const segments: RenderSegment[] = []
  for (const match of matches) {
    const previous = segments.at(-1)
    if (previous && match.shortStart < previous.shortEnd - 0.25) continue
    segments.push({
      movieStart: match.movieStart,
      movieEnd: match.movieEnd,
      shortStart: match.shortStart,
      shortEnd: match.shortEnd,
    })
  }
  return segments
}

export function totalStitchedSeconds(segments: RenderSegment[]): number {
  return segments.reduce((total, segment) => total + Math.max(0, segment.movieEnd - segment.movieStart), 0)
}
