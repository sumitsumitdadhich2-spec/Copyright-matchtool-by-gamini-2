'use client'

import { useEffect, useState } from 'react'
import { useSWRConfig } from 'swr'
import { CheckSquare, ListChecks, Loader2, Play } from 'lucide-react'
import type { Scan } from '@/lib/types'
import { fmtTime } from '@/lib/format'

/** Short-video minute selection: pick exactly which minutes of the SHORT get
 *  scanned (any combination) — unselected minutes are skipped and save API
 *  quota. "Scan remaining" later adds the leftover minutes to the SAME scan;
 *  all results merge together. */
export function MinuteSelectPanel({ scan, running, refresh }: { scan: Scan; running: boolean; refresh: () => void }) {
  const segs = scan.shortSegments || []
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { mutate } = useSWRConfig()

  // Sync local selection from the server state whenever the scan changes.
  useEffect(() => {
    setPicked(new Set(segs.filter((s) => s.selected !== false).map((s) => s.index)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan.id, segs.length, segs.map((s) => (s.selected === false ? '0' : '1')).join('')])

  if (segs.length <= 1) return null

  const serverSelected = new Set(segs.filter((s) => s.selected !== false).map((s) => s.index))
  const dirty = picked.size !== serverSelected.size || [...picked].some((i) => !serverSelected.has(i))
  const doneCount = segs.filter((s) => s.status === 'done').length
  const remaining = segs.filter(
    (s) => s.status !== 'done' || s.chunks.some((c) => c.status === 'pending' || c.status === 'cancelled'),
  )
  const unselectedRemaining = remaining.filter((s) => s.selected === false)

  function toggle(i: number) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  async function apply(indexes: number[], thenResume = false) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/scans/${scan.id}/segments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected: indexes }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError(j.error || 'Failed to update minute selection')
        return
      }
      if (thenResume) {
        const r2 = await fetch(`/api/scans/${scan.id}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resume: true }),
        })
        if (!r2.ok) {
          const j = await r2.json().catch(() => ({}))
          setError(j.error || 'Selection saved, but the scan could not start')
        }
      }
      void mutate(`/api/scans/${scan.id}`)
      refresh()
    } catch {
      setError('Network error — try again')
    } finally {
      setBusy(false)
    }
  }

  /** Scan remaining: select ALL minutes that still have work (keeping finished
   *  ones as-is) and resume — results merge into this same scan. */
  function scanRemaining() {
    const indexes = new Set<number>([...segs.filter((s) => s.status === 'done').map((s) => s.index), ...remaining.map((s) => s.index)])
    void apply([...indexes], true)
  }

  return (
    <section aria-label="Short minute selection" className="panel">
      <div className="flex flex-wrap items-center gap-2">
        <ListChecks className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Short Minutes — Kaunse Minute Scan Karne Hain?</h2>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px]">
          {picked.size}/{segs.length} selected
        </span>
        {doneCount > 0 && (
          <span className="rounded-full bg-success/15 px-2 py-0.5 font-mono text-[10px] text-success">{doneCount} done</span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Sirf selected minutes ke chunks par scan chalega — baaki skip ho kar API quota bachega. Baad me &quot;Scan
        remaining&quot; se bache hue minutes isi scan me scan ho jayenge, sab results merge rahenge.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4" role="group" aria-label="Minute checkboxes">
        {segs.map((seg) => {
          const checked = picked.has(seg.index)
          const isDone = seg.status === 'done'
          return (
            <label
              key={seg.index}
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors ${
                checked ? 'border-primary bg-primary/10' : 'border-input hover:bg-secondary'
              } ${running ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={running || busy}
                onChange={() => toggle(seg.index)}
                className="size-3.5 accent-primary"
              />
              <span className="flex flex-col">
                <span className="font-medium">Minute {seg.index + 1}</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {fmtTime(seg.start)}–{fmtTime(seg.end)}
                </span>
              </span>
              {isDone && (
                <span className="ml-auto text-[10px] text-success" title="Scanned + verified">
                  ✓
                </span>
              )}
              {(seg.status === 'scanning' || seg.status === 'verifying') && (
                <span className="ml-auto inline-block size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
              )}
            </label>
          )
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setPicked(new Set(segs.map((s) => s.index)))}
          disabled={running || busy}
          className="flex items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-40"
        >
          <CheckSquare className="size-3.5" aria-hidden /> Select All
        </button>
        <button
          type="button"
          onClick={() => setPicked(new Set())}
          disabled={running || busy}
          className="rounded-md border border-input px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-40"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={() => void apply([...picked])}
          disabled={running || busy || picked.size === 0 || !dirty}
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          Apply selection
        </button>
        {unselectedRemaining.length > 0 && !running && (
          <button
            type="button"
            onClick={scanRemaining}
            disabled={busy}
            title={`Bache hue ${unselectedRemaining.length} minute(s) ko isi scan me scan karo — results merge honge`}
            className="ml-auto flex items-center gap-1.5 rounded-md border border-primary/50 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-40"
          >
            <Play className="size-3.5" aria-hidden /> Scan remaining ({unselectedRemaining.length})
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
