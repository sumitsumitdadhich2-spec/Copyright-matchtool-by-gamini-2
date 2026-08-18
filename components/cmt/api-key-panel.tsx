'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { KeyRound, Check } from 'lucide-react'
import { fetcher } from '@/lib/format'

interface SettingsResponse {
  hasKey: boolean
  maskedKey: string | null
}

export function ApiKeyPanel() {
  const { data, mutate } = useSWR<SettingsResponse>('/api/settings', fetcher)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!value.trim()) return
    setSaving(true)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: value.trim() }),
    })
    setSaving(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to save key')
      return
    }
    setValue('')
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
    void mutate()
  }

  return (
    <section aria-label="API key settings" className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Gemini API Key</h2>
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
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) save()
          }}
          placeholder={data?.hasKey ? 'Paste a new key to replace' : 'Paste your Gemini API key'}
          aria-label="Gemini API key"
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={save}
          disabled={saving || !value.trim()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
        >
          {saving ? 'Saving...' : saved ? 'Saved' : data?.hasKey ? 'Update' : 'Save'}
        </button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Stored server-side only, never exposed to the browser. Daily request counters are tracked per key.
      </p>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      {!data?.hasKey && (
        <p className="mt-1 text-xs text-destructive">No key = no scan. Add your key to enable scanning.</p>
      )}
    </section>
  )
}
