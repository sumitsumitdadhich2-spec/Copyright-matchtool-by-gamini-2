'use client'

import { useRef, useState, type DragEvent } from 'react'
import { Film, Clapperboard, Loader2, CheckCircle2 } from 'lucide-react'
import type { Scan } from '@/lib/types'
import { fmtTime, fmtBytes } from '@/lib/format'

interface Props {
  scan: Scan | null
  onScanCreated: (id: string) => void
  refresh: () => void
}

type Kind = 'short' | 'movie'

export function UploadPanel({ scan, onScanCreated, refresh }: Props) {
  const [uploading, setUploading] = useState<Kind | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const scanIdRef = useRef<string | null>(scan?.id || null)
  scanIdRef.current = scan?.id || scanIdRef.current

  async function ensureScan(): Promise<string> {
    if (scanIdRef.current) return scanIdRef.current
    const res = await fetch('/api/scans', { method: 'POST' })
    const j = await res.json()
    scanIdRef.current = j.id
    onScanCreated(j.id)
    return j.id
  }

  function uploadFile(kind: Kind, file: File) {
    setError(null)
    setUploading(kind)
    setProgress(0)
    void ensureScan().then((id) => {
      // XHR gives real upload progress for multi-GB movies.
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', `/api/scans/${id}/upload?kind=${kind}&name=${encodeURIComponent(file.name)}`)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100))
      }
      xhr.onload = () => {
        setUploading(null)
        if (xhr.status >= 400) {
          try {
            setError(JSON.parse(xhr.responseText).error || 'Upload failed')
          } catch {
            setError('Upload failed')
          }
        }
        refresh()
      }
      xhr.onerror = () => {
        setUploading(null)
        setError('Upload failed — network error')
      }
      xhr.send(file)
    })
  }

  const chunking = scan?.status === 'chunking'

  return (
    <section aria-label="Upload videos" className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">Source Files</h2>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Dropzone
          kind="short"
          icon={<Film className="size-5" aria-hidden />}
          title="Short video"
          subtitle="The clip to find — auto-trimmed to first 1 min if longer"
          name={scan?.shortName}
          duration={scan?.shortDuration}
          size={scan?.shortSize}
          uploading={uploading === 'short'}
          progress={progress}
          disabled={uploading !== null}
          onFile={(f) => uploadFile('short', f)}
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
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={scan?.chunkingProgress}>
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${scan?.chunkingProgress || 0}%` }} />
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
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const allFilesInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const done = Boolean(props.name && props.duration)

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f && !props.disabled) props.onFile(f)
  }

  return (
    <div className="flex flex-col gap-1.5">
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
      className={`flex flex-col items-start gap-1 rounded-md border border-dashed p-4 text-left transition-colors ${
        dragOver ? 'border-primary bg-primary/10' : done ? 'border-success/40 bg-success/5' : 'border-input hover:border-primary/60'
      } disabled:opacity-60`}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*,.mp4,.mov,.m4v,.mkv,.webm,.avi,.3gp,.3g2,.ts,.mts,.m2ts,.flv,.wmv,.mpg,.mpeg"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) props.onFile(f)
          e.target.value = ''
        }}
      />
      {/* Unfiltered picker: opens the system Files app so every video is selectable, even ones the gallery picker greys out */}
      <input
        ref={allFilesInputRef}
        type="file"
        accept="*/*"
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
        <div className="w-full truncate font-mono text-xs text-muted-foreground">
          {props.name} · {fmtTime(props.duration!)} · {props.size ? fmtBytes(props.size) : ''}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">{props.subtitle} — click or drop a file</span>
      )}
    </button>
    <button
      type="button"
      disabled={props.disabled}
      onClick={() => allFilesInputRef.current?.click()}
      className="self-start text-xs text-primary underline underline-offset-2 hover:opacity-80 disabled:opacity-50"
    >
      Video not showing in gallery? Browse all files
    </button>
    </div>
  )
}
