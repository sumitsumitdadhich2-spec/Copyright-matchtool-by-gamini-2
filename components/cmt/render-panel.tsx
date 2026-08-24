'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import { Clapperboard, Download, Loader2, Pause, Play, RotateCcw, Square, X } from 'lucide-react'
import type { Scan, RenderResolution } from '@/lib/types'
import { fmtTime, fmtBytes } from '@/lib/format'
import { buildRenderSegments, type RenderSegment } from '@/lib/render-segments'

const RESOLUTIONS: { value: RenderResolution; label: string; defaultKbps: number }[] = [
  { value: '480p', label: '480p (854×480)', defaultKbps: 2000 },
  { value: '720p', label: '720p (1280×720)', defaultKbps: 4500 },
  { value: '1080p', label: '1080p (1920×1080)', defaultKbps: 9000 },
  { value: '2k', label: '2K (2560×1440)', defaultKbps: 18000 },
  { value: '4k', label: '4K (3840×2160)', defaultKbps: 40000 },
]

const AUDIO_BITRATES = [96, 128, 192, 256, 320]

export function RenderPanel({ scan }: { scan: Scan }) {
  const segments = useMemo(() => buildRenderSegments(scan), [scan])
  const totalSeconds = useMemo(
    () => segments.reduce((acc, s) => acc + Math.max(0, s.movieEnd - s.movieStart), 0),
    [segments],
  )

  // ---- Render settings ----
  const [resolution, setResolution] = useState<RenderResolution>('1080p')
  const [fps, setFps] = useState(24)
  const [videoKbps, setVideoKbps] = useState(9000)
  const [audioKbps, setAudioKbps] = useState(192)
  const [bitrateTouched, setBitrateTouched] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const { mutate } = useSWRConfig()

  function pickResolution(r: RenderResolution) {
    setResolution(r)
    if (!bitrateTouched) {
      setVideoKbps(RESOLUTIONS.find((x) => x.value === r)?.defaultKbps ?? 9000)
    }
  }

  const job = scan.renderJob
  const rendering = job?.status === 'rendering'
  const done = job?.status === 'done'
  const failed = job?.status === 'error'

  async function startRender() {
    setActionBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/scans/${scan.id}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution, fps, videoBitrateKbps: videoKbps, audioBitrateKbps: audioKbps }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setActionError(j.error || 'Failed to start render')
      }
      void mutate(`/api/scans/${scan.id}`)
    } catch {
      setActionError('Failed to start render — network error')
    } finally {
      setActionBusy(false)
    }
  }

  async function cancelRender() {
    setActionBusy(true)
    try {
      await fetch(`/api/scans/${scan.id}/render/cancel`, { method: 'POST' })
      void mutate(`/api/scans/${scan.id}`)
    } finally {
      setActionBusy(false)
    }
  }

  if (segments.length === 0) return null

  const downloadBase = `/api/scans/${scan.id}/render/download`
  const elapsed = rendering && job?.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0

  return (
    <section aria-label="Render and export" className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Clapperboard className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Render — Stitched Movie Scenes</h2>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">{segments.length} scene(s)</span>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">{fmtTime(totalSeconds)} total</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Sab matched movie scenes short ke order me ek video ki tarah — neeche instant preview (bina processing),
        aur real export ORIGINAL movie quality se ffmpeg ke saath.
      </p>

      <StitchedPreview scan={scan} segments={segments} totalSeconds={totalSeconds} />

      {/* ---- Export controls ---- */}
      <div className="mt-4 rounded-md border border-border bg-background p-3">
        <h3 className="text-xs font-semibold">Export settings</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Resolution</span>
            <select
              value={resolution}
              onChange={(e) => pickResolution(e.target.value as RenderResolution)}
              disabled={rendering}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            >
              {RESOLUTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">FPS (1–120)</span>
            <input
              type="number"
              min={1}
              max={120}
              step={1}
              value={fps}
              onChange={(e) => setFps(Math.max(1, Math.min(120, Math.round(Number(e.target.value) || 24))))}
              disabled={rendering}
              className="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Video bitrate (kbps)</span>
            <input
              type="number"
              min={250}
              max={100000}
              step={250}
              value={videoKbps}
              onChange={(e) => {
                setBitrateTouched(true)
                setVideoKbps(Math.max(250, Math.min(100000, Math.round(Number(e.target.value) || 250))))
              }}
              disabled={rendering}
              className="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Audio bitrate</span>
            <select
              value={audioKbps}
              onChange={(e) => setAudioKbps(Number(e.target.value))}
              disabled={rendering}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            >
              {AUDIO_BITRATES.map((b) => (
                <option key={b} value={b}>
                  {b} kbps
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!rendering && (
            <button
              type="button"
              onClick={() => void startRender()}
              disabled={actionBusy}
              className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground disabled:opacity-40"
            >
              <Clapperboard className="size-3.5" aria-hidden />
              {done || failed ? 'Re-render & Export' : 'Render & Export'}
            </button>
          )}
          {rendering && (
            <button
              type="button"
              onClick={() => void cancelRender()}
              disabled={actionBusy}
              className="flex items-center gap-1.5 rounded-md border border-destructive/50 px-4 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-40"
            >
              <X className="size-3.5" aria-hidden /> Cancel render
            </button>
          )}
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            {resolution} · {fps}fps · {videoKbps}k video / {audioKbps}k audio
          </span>
        </div>

        {actionError && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {actionError}
          </p>
        )}

        {rendering && job && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />
                Rendering {job.segmentCount} scenes with ffmpeg (original movie quality source)...
              </span>
              <span className="font-mono">
                {job.pct}%
                {job.etaSeconds !== null && job.etaSeconds > 0 ? ` · ~${fmtTime(job.etaSeconds)} left` : ''}
                {elapsed > 0 ? ` · ${fmtTime(elapsed)} elapsed` : ''}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={job.pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${job.pct}%` }} />
            </div>
          </div>
        )}

        {failed && job?.error && (
          <p role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Render failed: {job.error}
          </p>
        )}

        {done && job && (
          <div className="mt-3 flex flex-col gap-2 rounded-md border border-success/40 bg-success/5 p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-success">Render complete</span>
              {job.fileSize !== null && <span className="font-mono text-muted-foreground">{fmtBytes(job.fileSize)}</span>}
              {job.settings && (
                <span className="font-mono text-muted-foreground">
                  {job.settings.resolution} · {job.settings.fps}fps · {job.settings.videoBitrateKbps}k
                </span>
              )}
              <a
                href={`${downloadBase}?download=1`}
                download
                className="ml-auto flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
              >
                <Download className="size-3.5" aria-hidden /> Download MP4
              </a>
            </div>
            <video
              key={job.finishedAt ?? 0}
              src={downloadBase}
              controls
              preload="metadata"
              playsInline
              className="aspect-video w-full rounded-md border border-border bg-black object-contain"
            />
          </div>
        )}
      </div>
    </section>
  )
}

// ---------- Instant stitched preview (zero processing) ----------

function StitchedPreview({
  scan,
  segments,
  totalSeconds,
}: {
  scan: Scan
  segments: RenderSegment[]
  totalSeconds: number
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [segIdx, setSegIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [stitchedPos, setStitchedPos] = useState(0)

  // Seconds of stitched output before segment i starts.
  const offsets = useMemo(() => {
    const out: number[] = []
    let acc = 0
    for (const s of segments) {
      out.push(acc)
      acc += Math.max(0, s.movieEnd - s.movieStart)
    }
    return out
  }, [segments])

  // Reset when the segment list changes (new matches between refreshes).
  useEffect(() => {
    setSegIdx(0)
    setPlaying(false)
    setStitchedPos(0)
  }, [segments.length])

  function seekToSegment(i: number, autoplay: boolean) {
    const v = videoRef.current
    const seg = segments[i]
    if (!v || !seg) return
    setSegIdx(i)
    v.currentTime = seg.movieStart
    if (autoplay) {
      void v.play()
      setPlaying(true)
    }
  }

  function onTimeUpdate() {
    const v = videoRef.current
    const seg = segments[segIdx]
    if (!v || !seg) return
    setStitchedPos(offsets[segIdx] + Math.max(0, v.currentTime - seg.movieStart))
    // Drifted before the window (user scrubbed native controls are hidden, but seek safety):
    if (v.currentTime < seg.movieStart - 0.3) {
      v.currentTime = seg.movieStart
      return
    }
    // Segment finished — jump instantly to the next scene.
    if (v.currentTime >= seg.movieEnd - 0.05) {
      if (segIdx < segments.length - 1) {
        seekToSegment(segIdx + 1, true)
      } else {
        v.pause()
        setPlaying(false)
        seekToSegment(0, false)
      }
    }
  }

  function togglePlay() {
    const v = videoRef.current
    if (!v) return
    if (playing) {
      v.pause()
      setPlaying(false)
    } else {
      const seg = segments[segIdx]
      if (seg && (v.currentTime < seg.movieStart - 0.3 || v.currentTime >= seg.movieEnd - 0.05)) {
        v.currentTime = seg.movieStart
      }
      void v.play()
      setPlaying(true)
    }
  }

  function restart() {
    seekToSegment(0, playing)
    setStitchedPos(0)
  }

  const current = segments[segIdx]

  return (
    <div className="mt-3 rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold">Instant stitched preview</h3>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px]">
          scene {segIdx + 1}/{segments.length}
        </span>
        {current && (
          <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px]">
            movie {fmtTime(current.movieStart)}–{fmtTime(current.movieEnd)}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {fmtTime(stitchedPos)} / {fmtTime(totalSeconds)}
        </span>
      </div>

      <video
        ref={videoRef}
        src={`/api/scans/${scan.id}/media?kind=movie`}
        preload="metadata"
        playsInline
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={() => {
          const v = videoRef.current
          const seg = segments[0]
          if (v && seg && segIdx === 0 && !playing) v.currentTime = seg.movieStart
        }}
        className="mt-2 aspect-video w-full rounded-md border border-border bg-black object-contain"
      />

      {/* Proportional segment timeline */}
      <div className="mt-2 flex h-2.5 w-full gap-px overflow-hidden rounded-full" role="group" aria-label="Stitched scene timeline">
        {segments.map((s, i) => {
          const w = totalSeconds > 0 ? (Math.max(0, s.movieEnd - s.movieStart) / totalSeconds) * 100 : 0
          const active = i === segIdx
          return (
            <button
              key={`${s.movieStart}-${i}`}
              type="button"
              onClick={() => seekToSegment(i, playing)}
              title={`Scene ${i + 1}: movie ${fmtTime(s.movieStart)}–${fmtTime(s.movieEnd)} (short ${fmtTime(s.shortStart)}–${fmtTime(s.shortEnd)})`}
              aria-label={`Jump to scene ${i + 1}`}
              className={`h-full min-w-1 transition-colors ${active ? 'bg-primary' : 'bg-muted hover:bg-primary/50'}`}
              style={{ width: `${w}%` }}
            />
          )
        })}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={togglePlay}
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground"
        >
          {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          {playing ? 'Pause' : 'Play stitched'}
        </button>
        <button
          type="button"
          onClick={restart}
          className="flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-xs font-medium hover:bg-secondary"
        >
          <RotateCcw className="size-3.5" aria-hidden /> Restart
        </button>
        <button
          type="button"
          onClick={() => {
            const v = videoRef.current
            if (v) {
              v.pause()
              setPlaying(false)
            }
            seekToSegment(0, false)
            setStitchedPos(0)
          }}
          className="flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-xs font-medium hover:bg-secondary"
        >
          <Square className="size-3.5" aria-hidden /> Stop
        </button>
        <span className="ml-auto text-[10px] text-muted-foreground">audio on · plays scenes back-to-back from the original movie</span>
      </div>
    </div>
  )
}
