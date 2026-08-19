'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Play, Square, RotateCcw, Loader2, ScanSearch } from 'lucide-react'
import type { Scan } from '@/lib/types'
import { fetcher } from '@/lib/format'
import { ApiKeyPanel } from './api-key-panel'
import { UploadPanel } from './upload-panel'
import { ScanTimeline } from './scan-timeline'
import { ModelBoard } from './model-board'
import { CandidatesPanel } from './candidates-panel'
import { LogsPanel } from './logs-panel'
import { ReportPanel } from './report-panel'
import { ComparePanel } from './compare-panel'
import { HistoryPanel } from './history-panel'

interface ScanResponse {
  scan: Scan
  running: boolean
  usage: Record<string, number> | null
}

export function Dashboard() {
  const [scanId, setScanId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const { data, mutate } = useSWR<ScanResponse>(scanId ? `/api/scans/${scanId}` : null, fetcher, {
    refreshInterval: (latest) => {
      const st = latest?.scan?.status
      return st === 'scanning' || st === 'verifying' || st === 'chunking' || latest?.running ? 1500 : 5000
    },
  })

  const scan = data?.scan || null
  const running = data?.running || false
  const status = scan?.status

  const canStart = Boolean(scan && !running && status === 'ready' && scan.chunkCount > 0)
  const canResume = Boolean(
    scan && !running && (status === 'stopped' || ((status === 'error' || status === 'scanning') && scan.chunks.some((c) => c.status === 'pending' || c.status === 'scanning' || c.status === 'cancelled'))),
  )
  const canStop = running

  async function action(path: string, body?: object) {
    if (!scanId) return
    setBusy(true)
    setActionError(null)
    const res = await fetch(`/api/scans/${scanId}/${path}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    setBusy(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setActionError(j.error || 'Action failed')
    }
    void mutate()
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-md bg-primary/15 text-primary">
            <ScanSearch className="size-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Copyright Match Tool</h1>
            <p className="text-xs text-muted-foreground">Gemini-powered clip-in-movie scanner · 7 fps scan · 14 fps verify</p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {(status === 'scanning' || status === 'verifying') && (
            <span className="flex items-center gap-1.5 rounded-full bg-primary/15 px-3 py-1 text-xs text-primary">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              {status === 'verifying' ? 'Verifying at 14 fps...' : 'Scanning...'}
            </span>
          )}
          <button
            type="button"
            onClick={() => action('start')}
            disabled={!canStart || busy}
            className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
          >
            <Play className="size-4" aria-hidden /> Start scan
          </button>
          <button
            type="button"
            onClick={() => action('start', { resume: true })}
            disabled={!canResume || busy}
            className="flex items-center gap-1.5 rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-40"
          >
            <RotateCcw className="size-4" aria-hidden /> Resume
          </button>
          <button
            type="button"
            onClick={() => action('stop')}
            disabled={!canStop || busy}
            className="flex items-center gap-1.5 rounded-md border border-destructive/50 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-40"
          >
            <Square className="size-4" aria-hidden /> Stop
          </button>
        </div>
      </header>

      {actionError && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </p>
      )}
      {scan?.error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Scan error: {scan.error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <UploadPanel scan={scan} onScanCreated={(id) => setScanId(id)} refresh={() => void mutate()} />
          <ScanTimeline scan={scan || emptyScan()} />
          <ModelBoard scan={scan} usage={data?.usage || null} />
          {scan && scan.report && <ReportPanel scan={scan} />}
          {scan && (scan.regions.length > 0 || (scan.segmentMatches?.length ?? 0) > 0) && <ComparePanel scan={scan} />}
          {scan && <CandidatesPanel scan={scan} />}
          {scan && <LogsPanel scan={scan} />}
        </div>
        <div className="flex flex-col gap-4">
          <ApiKeyPanel />
          <HistoryPanel
            activeId={scanId}
            onSelect={(id) => setScanId(id)}
            onNew={() => {
              setScanId(null)
              setActionError(null)
            }}
          />
        </div>
      </div>
    </div>
  )
}

function emptyScan(): Scan {
  return {
    id: '',
    createdAt: 0,
    status: 'created',
    shortName: null,
    movieName: null,
    shortSize: null,
    movieSize: null,
    shortDuration: null,
    movieDuration: null,
    chunkCount: 0,
    chunkingProgress: 0,
    chunks: [],
    candidates: [],
    regions: [],
    logs: [],
    startedAt: null,
    finishedAt: null,
    error: null,
    report: null,
    modelStates: {},
  }
}
