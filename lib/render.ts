import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { FFMPEG_BIN, parseFfmpegProgress, probeDuration, probeHasAudio } from './ffmpeg'
import { getScan, saveScan, scanMediaDir, addLog } from './store'
import type { RenderJob, RenderResolution, RenderSettings, Scan } from './types'
import { buildRenderSegments, totalStitchedSeconds } from './render-segments'

export { buildRenderSegments } from './render-segments'

// ---------- Settings validation ----------

export const RESOLUTION_MAP: Record<RenderResolution, { w: number; h: number }> = {
  '480p': { w: 854, h: 480 },
  '720p': { w: 1280, h: 720 },
  '1080p': { w: 1920, h: 1080 },
  '2k': { w: 2560, h: 1440 },
  '4k': { w: 3840, h: 2160 },
}

export function validateRenderSettings(input: unknown): { ok: true; settings: RenderSettings } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Missing render settings' }
  const s = input as Partial<RenderSettings>
  if (!s.resolution || !(s.resolution in RESOLUTION_MAP)) {
    return { ok: false, error: 'Invalid resolution (480p, 720p, 1080p, 2k, 4k)' }
  }
  const fps = Number(s.fps)
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) {
    return { ok: false, error: 'FPS must be an integer between 1 and 120' }
  }
  const vb = Number(s.videoBitrateKbps)
  if (!Number.isFinite(vb) || vb < 250 || vb > 100000) {
    return { ok: false, error: 'Video bitrate must be between 250 and 100000 kbps' }
  }
  const ab = Number(s.audioBitrateKbps)
  if (!Number.isFinite(ab) || ab < 32 || ab > 320) {
    return { ok: false, error: 'Audio bitrate must be between 32 and 320 kbps' }
  }
  return {
    ok: true,
    settings: { resolution: s.resolution, fps, videoBitrateKbps: Math.round(vb), audioBitrateKbps: Math.round(ab) },
  }
}

// ---------- Render job manager (one render at a time per scan) ----------

interface ActiveRender {
  child: ChildProcess
  cancelled: boolean
}

// Survives route-module reloads in dev.
const g = globalThis as unknown as { __cmtActiveRenders?: Map<string, ActiveRender> }
const activeRenders: Map<string, ActiveRender> = g.__cmtActiveRenders ?? new Map()
g.__cmtActiveRenders = activeRenders

export function isRenderActive(scanId: string): boolean {
  return activeRenders.has(scanId)
}

export function renderOutputPath(scanId: string): string {
  return path.join(scanMediaDir(scanId), 'render.mp4')
}

function freshJob(settings: RenderSettings, totalOutputSeconds: number, segmentCount: number): RenderJob {
  return {
    status: 'rendering',
    settings,
    pct: 0,
    etaSeconds: null,
    totalOutputSeconds,
    segmentCount,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    fileSize: null,
  }
}

/**
 * Start a background render. Returns an error string if it cannot start.
 * Progress is persisted into scan.renderJob (throttled), so the existing
 * GET /api/scans/[id] polling picks it up with no extra wiring.
 */
export async function startRender(scanId: string, settings: RenderSettings): Promise<string | null> {
  if (activeRenders.has(scanId)) return 'A render is already in progress for this scan'

  const scan = getScan(scanId)
  if (!scan) return 'Scan not found'
  if (scan.status !== 'done') return 'Scan must be complete before rendering'
  if (scan.renderJob?.status === 'rendering') {
    // stale flag from a crashed process — recover instead of blocking forever
    scan.renderJob.status = 'error'
    scan.renderJob.error = 'Previous render was interrupted'
  }

  const segments = buildRenderSegments(scan)
  if (segments.length === 0) return 'No matched scenes to render'

  const mediaDir = scanMediaDir(scanId)
  const movieFile = path.join(mediaDir, 'movie.mp4')
  if (!fs.existsSync(movieFile)) return 'Original movie file not found'

  // Silent movie: [i:a] filter refs would make ffmpeg fail — synthesize silence instead.
  const hasAudio = await probeHasAudio(movieFile)

  const totalOut = totalStitchedSeconds(segments)
  scan.renderJob = freshJob(settings, totalOut, segments.length)
  addLog(
    scan,
    'info',
    `Render started: ${segments.length} scenes, ${totalOut.toFixed(1)}s output, ${settings.resolution} @ ${settings.fps}fps, ${settings.videoBitrateKbps}kbps video / ${settings.audioBitrateKbps}kbps audio`,
  )
  saveScan(scan)

  const { w, h } = RESOLUTION_MAP[settings.resolution]
  const outFile = renderOutputPath(scanId)

  // Build a single ffmpeg command: one trimmed input per scene, scale/pad/fps
  // normalize each, then concat video+audio. Source is ALWAYS the original movie.
  const args: string[] = ['-y']
  for (const seg of segments) {
    const dur = Math.max(0.1, seg.movieEnd - seg.movieStart)
    args.push('-ss', seg.movieStart.toFixed(3), '-t', dur.toFixed(3), '-i', movieFile)
  }

  const filterParts: string[] = []
  const concatInputs: string[] = []
  for (let i = 0; i < segments.length; i++) {
    filterParts.push(
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=${settings.fps},setsar=1[v${i}]`,
    )
    if (hasAudio) {
      filterParts.push(`[${i}:a]aresample=48000[a${i}]`)
    } else {
      const segDur = Math.max(0.1, segments[i].movieEnd - segments[i].movieStart)
      filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${segDur.toFixed(3)}[a${i}]`)
    }
    concatInputs.push(`[v${i}][a${i}]`)
  }
  filterParts.push(`${concatInputs.join('')}concat=n=${segments.length}:v=1:a=1[outv][outa]`)

  args.push(
    '-filter_complex', filterParts.join(';'),
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-b:v', `${settings.videoBitrateKbps}k`,
    '-maxrate', `${Math.round(settings.videoBitrateKbps * 1.5)}k`,
    '-bufsize', `${settings.videoBitrateKbps * 2}k`,
    '-c:a', 'aac',
    '-b:a', `${settings.audioBitrateKbps}k`,
    '-movflags', '+faststart',
    outFile,
  )

  const child = spawn(FFMPEG_BIN, args)
  const active: ActiveRender = { child, cancelled: false }
  activeRenders.set(scanId, active)

  let lastSave = 0
  let stderrTail = ''

  const persist = (mutate: (s: Scan) => void, force = false) => {
    const now = Date.now()
    if (!force && now - lastSave < 800) return
    lastSave = now
    const fresh = getScan(scanId)
    if (!fresh) return
    mutate(fresh)
    saveScan(fresh)
  }

  child.stderr?.on('data', (d: Buffer) => {
    const line = d.toString()
    stderrTail = (stderrTail + line).slice(-1200)
    const { time, speed } = parseFfmpegProgress(line)
    if (time === null) return
    const pct = Math.min(99, Math.round((time / Math.max(0.1, totalOut)) * 100))
    const eta = speed && speed > 0 ? Math.max(0, Math.round((totalOut - time) / speed)) : null
    persist((s) => {
      if (!s.renderJob || s.renderJob.status !== 'rendering') return
      s.renderJob.pct = pct
      s.renderJob.etaSeconds = eta
    })
  })

  child.on('error', (err) => {
    activeRenders.delete(scanId)
    persist((s) => {
      if (!s.renderJob) return
      s.renderJob.status = 'error'
      s.renderJob.error = `ffmpeg failed to start: ${err.message}`
      s.renderJob.finishedAt = Date.now()
      addLog(s, 'error', `Render failed to start: ${err.message}`)
    }, true)
  })

  child.on('close', (code) => {
    const wasCancelled = active.cancelled
    activeRenders.delete(scanId)

    void (async () => {
      if (wasCancelled) {
        try {
          if (fs.existsSync(outFile)) fs.unlinkSync(outFile)
        } catch {
          // ignore
        }
        persist((s) => {
          if (!s.renderJob) return
          s.renderJob.status = 'idle'
          s.renderJob.pct = 0
          s.renderJob.etaSeconds = null
          s.renderJob.error = null
          s.renderJob.finishedAt = null
          addLog(s, 'warn', 'Render cancelled')
        }, true)
        return
      }

      if (code === 0 && fs.existsSync(outFile)) {
        let size: number | null = null
        try {
          size = fs.statSync(outFile).size
        } catch {
          // ignore
        }
        // Confirm real output with a probe (guarantees settings actually produced a playable file).
        let probedDur: number | null = null
        try {
          probedDur = await probeDuration(outFile)
        } catch {
          // ignore — file exists, size known
        }
        persist((s) => {
          if (!s.renderJob) return
          s.renderJob.status = 'done'
          s.renderJob.pct = 100
          s.renderJob.etaSeconds = 0
          s.renderJob.finishedAt = Date.now()
          s.renderJob.fileSize = size
          addLog(
            s,
            'success',
            `Render complete: ${probedDur ? `${probedDur.toFixed(1)}s, ` : ''}${size ? `${(size / (1024 * 1024)).toFixed(1)} MB` : 'file ready'} — download available`,
          )
        }, true)
        return
      }

      persist((s) => {
        if (!s.renderJob) return
        s.renderJob.status = 'error'
        s.renderJob.error = `ffmpeg exited ${code}: ${stderrTail.slice(-400)}`
        s.renderJob.finishedAt = Date.now()
        addLog(s, 'error', `Render failed (ffmpeg exited ${code})`)
      }, true)
    })()
  })

  return null
}

/** Cancel an in-flight render. Returns false when nothing is rendering. */
export function cancelRender(scanId: string): boolean {
  const active = activeRenders.get(scanId)
  if (active) {
    active.cancelled = true
    try {
      active.child.kill('SIGKILL')
    } catch {
      // ignore
    }
    return true
  }
  // No live process (e.g. server restarted mid-render) — reset the persisted state.
  const scan = getScan(scanId)
  if (scan?.renderJob?.status === 'rendering') {
    scan.renderJob.status = 'idle'
    scan.renderJob.pct = 0
    scan.renderJob.etaSeconds = null
    scan.renderJob.error = null
    scan.renderJob.finishedAt = null
    addLog(scan, 'warn', 'Render cancelled (no live process)')
    saveScan(scan)
    return true
  }
  return false
}
