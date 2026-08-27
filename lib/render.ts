import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getFfmpegBin, parseFfmpegProgress, probeDuration, probeHasAudio } from './ffmpeg'
import { getScan, saveScan, scanMediaDir, addLog } from './store'
import type { RenderJob, RenderResolution, RenderSettings, Scan } from './types'
import { buildRenderSegments, totalStitchedSeconds, type RenderSegment } from './render-segments'

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
  child: ChildProcess | null
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

function renderPartsDir(scanId: string): string {
  return path.join(scanMediaDir(scanId), 'render-parts')
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

class RenderCancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

/** Run one ffmpeg command. Resolves on exit 0, rejects otherwise.
 *  Registers the child on `active` so Cancel can kill the CURRENT process. */
function runFfmpeg(
  bin: string,
  args: string[],
  active: ActiveRender,
  onStderr?: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (active.cancelled) return reject(new RenderCancelled())
    const child = spawn(bin, args)
    active.child = child
    let tail = ''
    child.stderr?.on('data', (d: Buffer) => {
      const line = d.toString()
      tail = (tail + line).slice(-1200)
      onStderr?.(line)
    })
    child.on('error', (err) => {
      active.child = null
      reject(new Error(`ffmpeg failed to start: ${err.message}`))
    })
    child.on('close', (code) => {
      active.child = null
      if (active.cancelled) return reject(new RenderCancelled())
      if (code === 0) return resolve()
      reject(new Error(`ffmpeg exited ${code}: ${tail.slice(-400)}`))
    })
  })
}

/**
 * Start a background render. Returns an error string if it cannot start.
 *
 * CRASH-PROOF PIPELINE: scenes are rendered ONE BY ONE into small part files
 * (one ffmpeg process + one input at a time — tiny memory footprint), then
 * losslessly joined with the concat demuxer (-c copy). The old single-command
 * approach opened EVERY scene as a separate input of the full movie at once,
 * which crashed on long scans / large movies.
 *
 * Progress is persisted into scan.renderJob (throttled), so the existing
 * GET /api/scans/[id] polling picks it up with no extra wiring.
 */
export async function startRender(scanId: string, settings: RenderSettings): Promise<string | null> {
  if (activeRenders.has(scanId)) return 'A render is already in progress for this scan'

  const scan = getScan(scanId)
  if (!scan) return 'Scan not found'
  // PARTIAL EXPORT: stopped scans can render too — whatever matched so far
  // (verified + unverified) gets exported; Resume still continues the scan.
  if (scan.status !== 'done' && scan.status !== 'stopped') {
    return 'Scan must be complete or stopped before rendering'
  }
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

  // Silent movie: audio stream refs would make ffmpeg fail — synthesize silence instead.
  const hasAudio = await probeHasAudio(movieFile)

  const totalOut = totalStitchedSeconds(segments)
  scan.renderJob = freshJob(settings, totalOut, segments.length)
  addLog(
    scan,
    'info',
    `Render started: ${segments.length} scenes, ${totalOut.toFixed(1)}s output, ${settings.resolution} @ ${settings.fps}fps, ${settings.videoBitrateKbps}kbps video / ${settings.audioBitrateKbps}kbps audio${scan.status === 'stopped' ? ' — PARTIAL export (scan stopped; ab tak ke matches)' : ''}`,
  )
  saveScan(scan)

  const active: ActiveRender = { child: null, cancelled: false }
  activeRenders.set(scanId, active)

  // Fire and forget — progress lands in scan.renderJob.
  void runRenderPipeline(scanId, settings, segments, movieFile, hasAudio, totalOut, active)

  return null
}

async function runRenderPipeline(
  scanId: string,
  settings: RenderSettings,
  segments: RenderSegment[],
  movieFile: string,
  hasAudio: boolean,
  totalOut: number,
  active: ActiveRender,
) {
  const { w, h } = RESOLUTION_MAP[settings.resolution]
  const outFile = renderOutputPath(scanId)
  const partsDir = renderPartsDir(scanId)

  let lastSave = 0
  const persist = (mutate: (s: Scan) => void, force = false) => {
    const now = Date.now()
    if (!force && now - lastSave < 800) return
    lastSave = now
    const fresh = getScan(scanId)
    if (!fresh) return
    mutate(fresh)
    saveScan(fresh)
  }

  const cleanupParts = () => {
    try {
      fs.rmSync(partsDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }

  try {
    const ffmpegBin = await getFfmpegBin()
    cleanupParts()
    fs.mkdirSync(partsDir, { recursive: true })

    // ---- Phase 1: render each scene into its own small part file (sequential —
    // one input, one process at a time; the crash-proof path for big movies). ----
    let doneSeconds = 0
    const partFiles: string[] = []
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const dur = Math.max(0.1, seg.movieEnd - seg.movieStart)
      const partFile = path.join(partsDir, `part-${String(i).padStart(4, '0')}.mp4`)
      partFiles.push(partFile)

      const args: string[] = ['-y', '-ss', seg.movieStart.toFixed(3), '-t', dur.toFixed(3), '-i', movieFile]
      if (!hasAudio) {
        args.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
      }
      args.push(
        '-filter_complex',
        `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=${settings.fps},setsar=1[v];` +
          (hasAudio ? `[0:a]aresample=48000[a]` : `[1:a]anull[a]`),
        '-map', '[v]',
        '-map', '[a]',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-b:v', `${settings.videoBitrateKbps}k`,
        '-maxrate', `${Math.round(settings.videoBitrateKbps * 1.5)}k`,
        '-bufsize', `${settings.videoBitrateKbps * 2}k`,
        '-c:a', 'aac',
        '-b:a', `${settings.audioBitrateKbps}k`,
        '-ar', '48000',
        partFile,
      )

      const base = doneSeconds
      await runFfmpeg(ffmpegBin, args, active, (line) => {
        const { time, speed } = parseFfmpegProgress(line)
        if (time === null) return
        const progressed = Math.min(base + Math.min(time, dur), totalOut)
        const pct = Math.min(98, Math.round((progressed / Math.max(0.1, totalOut)) * 100))
        const eta = speed && speed > 0 ? Math.max(0, Math.round((totalOut - progressed) / speed)) : null
        persist((s) => {
          if (!s.renderJob || s.renderJob.status !== 'rendering') return
          s.renderJob.pct = pct
          s.renderJob.etaSeconds = eta
        })
      })
      doneSeconds += dur
    }

    // ---- Phase 2: lossless concat of the parts (stream copy — fast + tiny memory). ----
    persist((s) => {
      if (!s.renderJob || s.renderJob.status !== 'rendering') return
      s.renderJob.pct = 99
      s.renderJob.etaSeconds = null
    }, true)

    const listFile = path.join(partsDir, 'concat.txt')
    fs.writeFileSync(listFile, partFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'))
    await runFfmpeg(ffmpegBin, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', outFile], active)

    activeRenders.delete(scanId)
    cleanupParts()

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
  } catch (err) {
    activeRenders.delete(scanId)
    cleanupParts()
    if (err instanceof RenderCancelled || active.cancelled) {
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
    const msg = err instanceof Error ? err.message : String(err)
    persist((s) => {
      if (!s.renderJob) return
      s.renderJob.status = 'error'
      s.renderJob.error = msg.slice(0, 600)
      s.renderJob.finishedAt = Date.now()
      addLog(s, 'error', `Render failed: ${msg.slice(0, 200)}`)
    }, true)
  }
}

/** Cancel an in-flight render. Returns false when nothing is rendering. */
export function cancelRender(scanId: string): boolean {
  const active = activeRenders.get(scanId)
  if (active) {
    active.cancelled = true
    try {
      active.child?.kill('SIGKILL')
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
