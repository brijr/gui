import { useEffect, useRef, useState } from 'react'
import { formatColor, parseColor, toHex } from '../../../shared/theme-color'
import { nudgeSize } from '../../../shared/theme-tokens'
import { Input } from '../lib/field'

/**
 * A value as text, sent on Enter or when the field is left. Sizes nudge with the arrow keys.
 * It stays mounted, so the keyboard stays in it, and takes a new value from main only while
 * it isn't being typed in.
 */
export function TextField({
  value,
  label,
  onChange,
}: {
  value: string
  label: string
  onChange: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])
  const commit = (text: string) => {
    if (text.trim() && text.trim() !== value) onChange(text.trim())
  }
  return (
    <Input
      mono
      aria-label={label}
      spellCheck={false}
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onFocus={() => {
        focused.current = true
      }}
      onBlur={() => {
        focused.current = false
        commit(draft)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') return commit(draft)
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        const nudged = nudgeSize(draft, event.key === 'ArrowUp' ? 1 : -1, event.shiftKey)
        if (nudged === null) return
        event.preventDefault()
        setDraft(nudged)
        onChange(nudged)
      }}
    />
  )
}

/**
 * A color: the platform's picker beside its text. The picker only speaks #rrggbb, so its
 * choice is written back in the value's own format, with the value's alpha. A value that isn't
 * one Gui parses (a named color, color-mix(), calc()) is edited as text only.
 */
export function ColorField({
  value,
  label,
  onChange,
}: {
  value: string
  label: string
  onChange: (value: string) => void
}) {
  const parsed = parseColor(value)
  return (
    <div className="flex items-center gap-2">
      {parsed && (
        <input
          type="color"
          aria-label={`${label} color`}
          value={toHex(parsed.rgba)}
          onChange={(event) => {
            const picked = parseColor(event.currentTarget.value)
            if (picked) onChange(formatColor({ ...picked.rgba, a: parsed.rgba.a }, parsed.format))
          }}
          className="h-7 w-9 shrink-0 cursor-pointer rounded-md border border-edge bg-raised p-0.5"
        />
      )}
      <TextField value={value} label={label} onChange={onChange} />
    </div>
  )
}
