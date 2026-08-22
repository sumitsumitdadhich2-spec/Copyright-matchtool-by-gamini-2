'use client'

import { useRef, useState } from 'react'
import { Target, Play } from 'lucide-react'
import type { Scan, Candidate } from '@/lib/types'
import { fmtTime } from '@/lib/format'

export function CandidatesPanel({ scan }: { scan: Scan }) {
  // Candidate system backend removed — panel keeps its exact UI and shows the
  // empty state until the candidate system is re-implemented.
  const candidates = scan.candidates ?? []
  return (
    <section aria-label="Match candidates" className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Target className="size-4 text-destructive" aria-hidden />
        <h2 className="text-sm font-semibold">Match Candidates</h2>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{candidates.length}</span>
      </div>
      {candidates.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Scanner candidates appear here live as the scan runs. Model confidence is informational only — a candidate counts as matched only after 24fps verifier confirmation.
        </p>
      ) : (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {[...candidates]
            .sort((a, b) => a.absSegment[0] - b.absSegment[0])
            .map((c) => (
              <CandidateCard key={c.id} scan={scan} c={c} />
            ))}
        </div>
      )}
    </section>
  )
}

function CandidateCard({ scan, c }: { scan: Scan; c: Candidate }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [showVideo, setShowVideo] = useState(false)

  function openPreview() {
    setShowVideo(true)
    // Seek to the matched movie time once metadata is available.
    requestAnimationFrame(() => {
      const v = videoRef.current
      if (!v) return
      const seek = () => {
        v.currentTime = c.absSegment[0]
        void v.play().catch(() => {})
      }
      if (v.readyState >= 1) seek()
      else v.addEventListener('loadedmetadata', seek, { once: true })
    })
  }

  return (
    <div className="rounded-md border border-destructive/30 bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-semibold text-destructive">
          {fmtTime(c.absSegment[0])} – {fmtTime(c.absSegment[1])}
        </span>
        <span
          title="Self-reported model confidence — informational only, not used for ranking; only the 24fps verifier decides"
          className="rounded-full bg-destructive/15 px-2 py-0.5 font-mono text-xs text-destructive"
        >
          model conf {c.confidence}
        </span>
      </div>
      <div className="mt-1.5 grid gap-0.5 text-xs text-muted-foreground">
        <span>
          Short segment: <span className="font-mono text-foreground">{fmtTime(c.shortSegment[0])} – {fmtTime(c.shortSegment[1])}</span>
        </span>
        <span>
          Model: <span className="font-mono">{c.model}</span> · chunk {c.chunkIndex}
        </span>
        {c.note && <span className="line-clamp-2 italic">{c.note}</span>}
      </div>
      {showVideo ? (
        <video
          ref={videoRef}
          src={`/api/scans/${scan.id}/media?kind=movie`}
          controls
          className="mt-2 w-full rounded-md bg-black"
          aria-label={`Movie preview at ${fmtTime(c.absSegment[0])}`}
        />
      ) : (
        <button
          type="button"
          onClick={openPreview}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-input py-1.5 text-xs font-medium hover:bg-secondary"
        >
          <Play className="size-3.5" aria-hidden /> Preview at {fmtTime(c.absSegment[0])}
        </button>
      )}
    </div>
  )
}
