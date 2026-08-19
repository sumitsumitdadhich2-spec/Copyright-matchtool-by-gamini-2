'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { KeyRound, Check, ShieldCheck } from 'lucide-react'
import { fetcher } from '@/lib/format'

interface SettingsResponse {
  hasKey: boolean
  maskedKey: string | null
  hasKey2: boolean
  maskedKey2: string | null
}

export function ApiKeyPanel() {
  const { data, mutate } = useSWR<SettingsResponse>('/api/settings', fetcher)
  const [value, setValue] = useState('')
  const [value2, setValue2] = useState('')
  const [saving, setSaving] = useState<1 | 2 | null>(null)
  const [saved, setSaved] = useState<1 | 2 | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function save(which: 1 | 2) {
    const v = (which === 1 ? value : value2).trim()
    if (!v) return
    setSaving(which)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(which === 1 ? { apiKey: v } : { apiKey2: v }),
    })
    setSaving(null)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to save key')
      return
    }
    if (which === 1) setValue('')
    else setValue2('')
    setSaved(which)
    setTimeout(() => setSaved(null), 2500)
    void mutate()
  }

  return (
    <section aria-label="API key settings" className="rounded-lg border border-border bg-card p-4">
      {/* ----- Key 1: Main Scanner ----- */}
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">API Key 1 — Main Scanner</h2>
        {data?.hasKey ? (
          <span className="ml-auto flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 font-mono text-xs text-success">
            <Check className="size-3" aria-hidden />
            {data.maskedKey}
          </span>
        ) : (
          <span className="ml-auto rounded-full bg-destructive/15 px-2 py-0.5 text-xs text-destructive">not set</span>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) save(1)
          }}
          placeholder={data?.hasKey ? 'Paste a new key to replace' : 'Paste your Gemini API key'}
          aria-label="Gemini API key 1 (main scanner)"
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={() => save(1)}
          disabled={saving !== null || !value.trim()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
        >
          {saving === 1 ? 'Saving...' : saved === 1 ? 'Saved' : data?.hasKey ? 'Update' : 'Save'}
        </button>
      </div>

      {/* ----- Key 2: Verifier ----- */}
      <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
        <ShieldCheck className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">API Key 2 — Verifier (optional)</h2>
        {data?.hasKey2 ? (
          <span className="ml-auto flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 font-mono text-xs text-success">
            <Check className="size-3" aria-hidden />
            {data.maskedKey2}
          </span>
        ) : (
          <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">not set</span>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          type="password"
          value={value2}
          onChange={(e) => setValue2(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) save(2)
          }}
          placeholder={data?.hasKey2 ? 'Paste a new key to replace' : 'Paste a SECOND Gemini API key (different account)'}
          aria-label="Gemini API key 2 (verifier)"
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={() => save(2)}
          disabled={saving !== null || !value2.trim()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
        >
          {saving === 2 ? 'Saving...' : saved === 2 ? 'Saved' : data?.hasKey2 ? 'Update' : 'Save'}
        </button>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Key 1 scans chunks non-stop. Key 2 runs live 24fps verification in parallel so Key 1&apos;s rate limit is untouched — and
        whichever key is free picks up the other&apos;s pending work. Both stored server-side only; daily counters tracked per key.
      </p>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      {!data?.hasKey && (
        <p className="mt-1 text-xs text-destructive">No Key 1 = no scan. Add it to enable scanning.</p>
      )}
    </section>
  )
}
