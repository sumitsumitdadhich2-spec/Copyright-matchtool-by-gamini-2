'use client'

import { Fragment } from 'react'
import { FileCheck2, ShieldCheck } from 'lucide-react'
import type { Scan, SegmentVerification } from '@/lib/types'
import { fmtTime, fmtDuration } from '@/lib/format'

function verifyBadge(v?: SegmentVerification) {
  if (!v) return { label: 'not verified', cls: 'bg-secondary text-muted-foreground' }
  switch (v.state) {
    case 'confirmed':
      return { label: `CONFIRMED ${v.confidence ?? ''}`.trim(), cls: 'bg-success/15 text-success' }
    case 'rejected_final':
      return { label: 'REJECTED (API 2)', cls: 'bg-destructive/15 text-destructive' }
    case 'verifying':
      return { label: 'verifying @24fps', cls: 'bg-warning/15 text-warning' }
    case 'rescanning':
      return { label: 're-scanning @13fps', cls: 'bg-warning/15 text-warning' }
    default:
      return { label: 'pending verification', cls: 'bg-secondary text-muted-foreground' }
  }
}

export function ReportPanel({ scan }: { scan: Scan }) {
  const report = scan.report
  if (!report) return null

  const selected = report.regions.filter((r) => r.selected)

  return (
    <section aria-label="Final report" className="rounded-lg border border-success/30 bg-card p-4">
      <div className="flex items-center gap-2">
        <FileCheck2 className="size-4 text-success" aria-hidden />
        <h2 className="text-sm font-semibold">Final Report</h2>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <Stat label="Scan time" value={fmtDuration(report.totalScanTimeMs)} />
        <Stat label="Chunks scanned" value={String(report.chunksScanned)} />
        <Stat label="Chunks failed" value={String(report.chunksFailed)} />
        <Stat label="Models used" value={String(report.modelsUsed.length)} />
      </div>

      {(report.segmentMatches || []).length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-semibold text-muted-foreground">Frame-by-frame segment map (exact durations)</h3>
          <div className="mt-1.5 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="py-1 pr-2 font-medium">Seg</th>
                  <th className="py-1 pr-2 font-medium">Short video</th>
                  <th className="py-1 pr-2 font-medium">Movie (exact)</th>
                  <th className="py-1 pr-2 font-medium">Duration</th>
                  <th className="py-1 pr-2 font-medium">Speed</th>
                  <th className="py-1 pr-2 font-medium">Conf</th>
                  <th className="py-1 pr-2 font-medium">Model</th>
                  <th className="py-1 font-medium">Verification</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {(report.segmentMatches || []).map((s) => {
                  const rejected = s.verification?.state === 'rejected_final'
                  const badge = verifyBadge(s.verification)
                  return (
                    <Fragment key={s.segmentIndex}>
                      <tr className={`border-b ${rejected ? 'border-destructive/30 bg-destructive/5' : 'border-border/50'}`}>
                        <td className={`py-1 pr-2 font-semibold ${rejected ? 'text-destructive' : ''}`}>S{s.segmentIndex}</td>
                        <td className="py-1 pr-2">
                          {fmtTime(s.shortStart)} – {fmtTime(s.shortEnd)}
                        </td>
                        <td className={`py-1 pr-2 ${rejected ? 'text-destructive line-through' : 'text-success'}`}>
                          {fmtTime(s.movieStart)} – {fmtTime(s.movieEnd)}
                        </td>
                        <td className="py-1 pr-2">{(s.movieEnd - s.movieStart).toFixed(3)}s</td>
                        <td className="py-1 pr-2">{s.speed}</td>
                        <td className="py-1 pr-2">{s.confidence}</td>
                        <td className="py-1 pr-2 text-muted-foreground">{s.model.replace('gemini-', '')}</td>
                        <td className="py-1">
                          <span className={`rounded-full px-2 py-0.5 text-[11px] ${badge.cls}`}>{badge.label}</span>
                        </td>
                      </tr>
                      {rejected && s.verification?.reason && (
                        <tr className="border-b border-destructive/30 bg-destructive/5">
                          <td />
                          <td colSpan={7} className="py-1 pr-2 font-sans text-[11px] leading-relaxed text-destructive">
                            Rejected by Verifier (API 2): {s.verification.reason}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
                {r.segmentIndexes && r.segmentIndexes.length > 0 && (
                  <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">
                    S{r.segmentIndexes[0]}
                    {r.segmentIndexes.length > 1 ? `–S${r.segmentIndexes[r.segmentIndexes.length - 1]}` : ''}
                  </span>
                )}
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
