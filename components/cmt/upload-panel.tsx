'use client'

import { useRef, useState, type DragEvent } from 'react'
import { upload } from '@vercel/blob/client'
import { Film, Clapperboard, Loader2, CheckCircle2 } from 'lucide-react'
import type { Scan } from '@/lib/types'
import { fmtTime, fmtBytes } from '@/lib/format'

interface Props {
  scan: Scan | null
  /** The dashboard's selected scan id — null means "new scan", so a fresh scan must be created on upload. */
  selectedScanId: string | null
  onScanCreated: (id: string) => void
  refresh: () => void
}

type Kind = 'short' | 'movie'

const ALLOWED_EXT = ['.mp4', '.mov', '.mkv', '.webm']
function isAllowedVideo(f: File) {
  const name = f.name.toLowerCase()
  return ALLOWED_EXT.some((ext) => name.endsWith(ext))
}

export function UploadPanel({ scan, selectedScanId, onScanCreated, refresh }: Props) {
  const [uploading, setUploading] = useState<Kind | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const scanIdRef = useRef<string | null>(selectedScanId)
  // Follow the dashboard's selection: when the user picks "New scan" (null) or
  // another history entry, drop any stale id so uploads never land in an old scan.
  const prevSelectedRef = useRef<string | null>(selectedScanId)
  if (prevSelectedRef.current !== selectedScanId) {
    prevSelectedRef.current = selectedScanId
    scanIdRef.current = selectedScanId
  }

  async function ensureScan(): Promise<string> {
    if (scanIdRef.current) return scanIdRef.current
    const res = await fetch('/api/scans', { method: 'POST' })
    const j = await res.json()
    scanIdRef.current = j.id
    onScanCreated(j.id)
    return j.id
  }

  function uploadFile(kind: Kind, file: File) {
    if (!isAllowedVideo(file)) {
      setError('Only MP4, MOV, MKV or WebM video files are supported')
      return
    }
    setError(null)
    setUploading(kind)
    setProgress(0)

    void (async () => {
      try {
        const id = await ensureScan()

        // DIRECT browser → Blob upload. The video never passes through a
        // serverless function, so Vercel's 4.5MB body limit doesn't apply —
        // this is what made big uploads fail in production. Multipart splits
        // the file into parts, uploads them in parallel and retries failures.
        await upload(`media/${id}/${kind}.mp4`, file, {
          access: 'private',
          handleUploadUrl: `/api/scans/${id}/upload`,
          contentType: file.type || 'application/octet-stream',
          multipart: true,
          onUploadProgress: ({ percentage }) => {
            // Reserve the last few % for the server-side finalize step.
            setProgress(Math.min(95, Math.round(percentage * 0.95)))
          },
        })

        // Upload landed in Blob — now let the server pull it, probe it with
        // ffmpeg and set up the scan state (segments / trim-await).
        setProgress(97)
        const res = await fetch(`/api/scans/${id}/upload/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, name: file.name }),
        })
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        if (!res.ok) throw new Error(j.error || 'Video uploaded but processing failed. Please try again.')

        setProgress(100)
        setUploading(null)
        setError(null)
        refresh()
      } catch (err) {
        setUploading(null)
        setError(err instanceof Error ? err.message : 'Upload failed. Please try again.')
        refresh()
      }
    })()
  }

  const chunking = scan?.status === 'chunking'

  return (
    <section aria-label="Upload videos" className="panel">
      <h2 className="text-sm font-semibold">Source Files</h2>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Dropzone
          kind="short"
          icon={<Film className="size-5" aria-hidden />}
          title="Short video"
          subtitle="The clip to find — any length, scanned minute-by-minute (original quality preserved)"
          name={scan?.shortName}
          duration={scan?.shortDuration}
          size={scan?.shortSize}
          uploading={uploading === 'short'}
          progress={progress}
          disabled={uploading !== null}
          onFile={(f) => uploadFile('short', f)}
          extraInfo={
            scan?.shortSegments && scan.shortSegments.length > 1
              ? `${scan.shortSegments.length} minutes — scanned minute-by-minute`
              : undefined
          }
        />
        <Dropzone
          kind="movie"
          icon={<Clapperboard className="size-5" aria-hidden />}
          title="Movie"
          subtitle="Any length — chunked into 1-min pieces"
          name={scan?.movieName}
          duration={scan?.movieDuration}
          size={scan?.movieSize}
          uploading={uploading === 'movie'}
          progress={progress}
          disabled={uploading !== null}
          onFile={(f) => uploadFile('movie', f)}
        />
      </div>
      {chunking && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />
              ffmpeg chunking movie into {scan?.chunkCount} one-minute chunks...
            </span>
            <span className="font-mono">{scan?.chunkingProgress}%</span>
          </div>
          <div className="progress-track mt-1.5" role="progressbar" aria-valuenow={scan?.chunkingProgress}>
            <div className="progress-fill" style={{ width: `${scan?.chunkingProgress || 0}%` }} />
          </div>
        </div>
      )}
      {scan?.shortSegmentingProgress !== undefined && scan.shortSegmentingProgress < 100 && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />
              ffmpeg cutting short into {scan?.shortSegments?.length ?? 1} one-minute scan segment(s) — original untouched...
            </span>
            <span className="font-mono">{scan.shortSegmentingProgress}%</span>
          </div>
          <div className="progress-track mt-1.5" role="progressbar" aria-valuenow={scan.shortSegmentingProgress}>
            <div className="progress-fill" style={{ width: `${scan.shortSegmentingProgress}%` }} />
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  )
}

function Dropzone(props: {
  kind: Kind
  icon: React.ReactNode
  title: string
  subtitle: string
  name?: string | null
  duration?: number | null
  size?: number | null
  uploading: boolean
  progress: number
  disabled: boolean
  onFile: (f: File) => void
  extraInfo?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const done = Boolean(props.name && props.duration)

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f && !props.disabled) props.onFile(f)
  }

  return (
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      disabled={props.disabled}
      className={`btn-press flex flex-col items-start gap-1 rounded-lg border border-dashed p-4 text-left ${
        dragOver
          ? 'scale-[1.01] border-primary bg-primary/10'
          : done
            ? 'border-success/40 bg-success/5'
            : 'border-input hover:border-primary/60 hover:bg-primary/5'
      } disabled:opacity-60`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) props.onFile(f)
          e.target.value = ''
        }}
      />
      <div className="flex w-full items-center gap-2">
        <span className={done ? 'text-success' : 'text-primary'}>{done ? <CheckCircle2 className="size-5" aria-hidden /> : props.icon}</span>
        <span className="text-sm font-medium">{props.title}</span>
        {props.uploading && (
          <span className="ml-auto flex items-center gap-1 font-mono text-xs text-primary">
            <Loader2 className="size-3 animate-spin" aria-hidden /> {props.progress}%
          </span>
        )}
      </div>
      {done ? (
        <>
          <div className="w-full truncate font-mono text-xs text-muted-foreground">
            {props.name} · {fmtTime(props.duration!)} · {props.size ? fmtBytes(props.size) : ''}
          </div>
          {props.extraInfo && <span className="text-[11px] text-primary">{props.extraInfo}</span>}
        </>
      ) : (
        <span className="text-xs text-muted-foreground">{props.subtitle} — click or drop a file</span>
      )}
    </button>
  )
}
