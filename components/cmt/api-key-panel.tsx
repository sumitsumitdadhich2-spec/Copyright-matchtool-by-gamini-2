'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { KeyRound, Check, ShieldCheck, X } from 'lucide-react'
import { fetcher } from '@/lib/format'

interface KeySlot {
  index: number
  hasKey: boolean
  maskedKey: string | null
}

interface SettingsResponse {
  keys: KeySlot[]
  maxKeys: number
}

const MAX_SLOTS = 20

function slotLabel(n: number): string {
  return n === 1 ? 'API Key 1 — Main Scanner' : `API Key ${n} — Worker (optional)`
}

export function ApiKeyPanel() {
  const { data, mutate } = useSWR<SettingsResponse>('/api/settings', fetcher)
  const [values, setValues] = useState<Record<number, string>>({})
  const [saving, setSaving] = useState<number | null>(null)
  const [saved, setSaved] = useState<number | null>(null)
  const [removing, setRemoving] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const slots: KeySlot[] =
    data?.keys ?? Array.from({ length: MAX_SLOTS }, (_, i) => ({ index: i + 1, hasKey: false, maskedKey: null }))

  async function save(n: number) {
    const v = (values[n] || '').trim()
    if (!v) return
    setSaving(n)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [`apiKey${n}`]: v }),
    })
    setSaving(null)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to save key')
      return
    }
    setValues((p) => ({ ...p, [n]: '' }))
    setSaved(n)
    setTimeout(() => setSaved(null), 2500)
    void mutate()
  }

  async function remove(n: number) {
    setRemoving(n)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: n }),
    })
    setRemoving(null)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to remove key')
      return
    }
    void mutate()
  }

  return (
    <section aria-label="API key settings" className="rounded-lg border border-border bg-card p-4">
      {slots.map((slot) => {
        const n = slot.index
        const Icon = n === 1 ? KeyRound : ShieldCheck
        return (
          <div key={n} className={n === 1 ? '' : 'mt-4 border-t border-border pt-4'}>
            <div className="flex items-center gap-2">
              <Icon className="size-4 text-primary" aria-hidden />
              <h2 className="text-sm font-semibold">{slotLabel(n)}</h2>
              {slot.hasKey ? (
                <span className="ml-auto flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 font-mono text-xs text-success">
                  <Check className="size-3" aria-hidden />
                  {slot.maskedKey}
                </span>
              ) : n === 1 ? (
                <span className="ml-auto rounded-full bg-destructive/15 px-2 py-0.5 text-xs text-destructive">not set</span>
              ) : (
                <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">not set</span>
              )}
            </div>
            <div className="mt-3 flex gap-2">
              <input
                type="password"
                value={values[n] || ''}
                onChange={(e) => setValues((p) => ({ ...p, [n]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) save(n)
                }}
                placeholder={
                  slot.hasKey
                    ? 'Paste a new key to replace'
                    : n === 1
                      ? 'Paste your Gemini API key'
                      : `Paste Gemini API key ${n} (different account)`
                }
                aria-label={`Gemini API key ${n}`}
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => save(n)}
                disabled={saving !== null || !(values[n] || '').trim()}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
              >
                {saving === n ? 'Saving...' : saved === n ? 'Saved' : slot.hasKey ? 'Update' : 'Save'}
              </button>
              {slot.hasKey && (
                <button
                  type="button"
                  onClick={() => remove(n)}
                  disabled={removing !== null}
                  aria-label={`Remove API key ${n}`}
                  title="Remove this key"
                  className="rounded-md border border-border px-2.5 py-2 text-sm text-muted-foreground hover:text-destructive disabled:opacity-40"
                >
                  {removing === n ? '...' : <X className="size-4" aria-hidden />}
                </button>
              )}
            </div>
          </div>
        )
      })}

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Add 1 to 20 keys — the scan works with ANY number. All keys scan chunks in parallel first, then all keys run 24fps
        verification together, and whichever key is free picks up any pending work. Each key uses all 6 models with its own
        daily counters. More keys = faster scans. Keys are stored server-side only.
      </p>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      {!slots[0]?.hasKey && <p className="mt-1 text-xs text-destructive">No Key 1 = no scan. Add it to enable scanning.</p>}
    </section>
  )
}
