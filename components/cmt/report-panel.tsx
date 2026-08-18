'use client'

import { FileCheck2, ShieldCheck } from 'lucide-react'
import type { Scan } from '@/lib/types'
import { fmtTime, fmtDuration } from '@/lib/format'

export function ReportPanel({ scan }: { scan: Scan }) {
  const report = scan.report
  if (!report) return null

  const selected = report.regions.filter((r) => r.selected)

  return (
    <section aria-label="Final report" className="rounded-lg border border-success/30 bg-card p-4">
      <div className="flex items-center gap-2">
        <FileCheck2 className="size-4 text-success" aria-hidden />
        <h2 className="text-sm font-semibold">Final Report</h2>
        {report.earlyStopped && (
          <span className="ml-auto rounded-full bg-success/15 px-2 py-0.5 text-xs text-success">early stop — full match</span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <Stat label="Scan time" value={fmtDuration(report.totalScanTimeMs)} />
        <Stat label="Chunks scanned" value={String(report.chunksScanned)} />
        <Stat label="Chunks failed" value={String(report.chunksFailed)} />
        <Stat label="Models used" value={String(report.modelsUsed.length)} />
      </div>

      {report.regions.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No matches found — the short video does not appear in this movie.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {report.regions.map((r) => (
            <div
              key={r.id}
              className={`rounded-md border p-3 ${r.selected ? 'border-success/50 bg-success/5' : 'border-border bg-background opacity-75'}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                {r.selected && <ShieldCheck className="size-4 text-success" aria-hidden />}
                <span className="font-mono text-sm font-semibold">
                  {fmtTime(r.movieStart)} – {fmtTime(r.movieEnd)}
                </span>
                <span className="text-xs text-muted-foreground">
                  short {fmtTime(r.shortStart)}–{fmtTime(r.shortEnd)}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  {r.verified && (
                    <span
                      className={`rounded-full px-2 py-0.5 font-mono text-xs ${
                        r.verified.match ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'
                      }`}
                    >
                      verified {r.verified.confidence} · {r.verified.model}
                    </span>
                  )}
                  <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">scan {r.maxConfidence}</span>
                </span>
              </div>
              {r.verified?.note && <p className="mt-1 text-xs italic text-muted-foreground">{r.verified.note}</p>}
            </div>
          ))}
        </div>
      )}
      {selected.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {selected.length} region(s) selected as final answer after the 14 fps verification pass.
        </p>
      )}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background p-2">
      <p className="text-muted-foreground">{label}</p>
      <p className="font-mono text-sm font-semibold">{value}</p>
    </div>
  )
}
