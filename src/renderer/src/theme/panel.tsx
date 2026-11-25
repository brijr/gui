import { useEffect, useState, useSyncExternalStore } from 'react'
import { formatColor, parseColor } from '../../../shared/theme-color'
import {
  type PanelRow,
  panelRows,
  type ThemeKind,
  type ThemeMode,
  type ThemeSnapshot,
  type ThemeVariable,
} from '../../../shared/theme-tokens'
import type { ThemePanelState } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { ChevronDown, Lock, X } from '../lib/icons'
import { trackDrag } from '../lib/pointer-drag'
import { GroupLabel, PopoverNote, PopoverSearch } from '../lib/surface'
import { Button, IconButton, TextButton } from '../lib/ui'
import { ColorField, TextField } from './color-field'
import { ScrubHandle } from './scrub'

const GROUP_NAMES: Record<ThemeKind, string> = {
  color: 'Colors',
  size: 'Sizes',
  font: 'Fonts',
  other: 'Other',
}
/** A folded scale shows this many of its shades. */
const SCALE_PREVIEW = 5
/** Fewer color variables than this, and the agent can be asked to add them. */
const FEW_COLORS = 3
/** How far a reference is followed for its swatch */
const MAX_HOPS = 10

/** The value being edited: a variable in a mode, from the row (`row`) it was opened under. */
interface Editing {
  row: string
  name: string
  mode: string
}

type PendingOf = (name: string, mode: string) => string | null

// Heard from the start: main sends the state as the page finishes loading, before React's
// first effects have run.
let latest: ThemePanelState | null = null
const listeners = new Set<() => void>()
gui.onThemeState((state) => {
  latest = state
  for (const listener of listeners) listener()
})
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The Theme popover (main/theme-popover.ts): the preview's CSS variables by kind, a column per
 * mode, edited live; nothing is written until Keep.
 */
export function ThemePanel() {
  const state = useSyncExternalStore(subscribe, () => latest)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      gui.toggleTheme()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const snapshot = state?.snapshot ?? null
  const pending = state?.pending ?? []
  const pendingOf: PendingOf = (name, mode) =>
    pending.find((edit) => edit.name === name && edit.mode === mode)?.value ?? null
  const row = (variable: ThemeVariable) => (
    <VariableRow
      key={variable.name}
      variable={variable}
      snapshot={snapshot as ThemeSnapshot}
      pendingOf={pendingOf}
      editing={editing?.row === variable.name ? editing : null}
      onEdit={setEditing}
    />
  )
  const groups = snapshot ? panelRows(snapshot, query) : []
  const colors = snapshot?.variables.filter((v) => v.kind === 'color').length ?? 0
  const shownMode = snapshot?.modes.find((mode) => mode.id === state?.mode) ?? null

  return (
    <div className="h-screen p-3">
      <div className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-overlay text-small text-fg shadow-popover">
        <header
          className="flex h-9 shrink-0 cursor-grab touch-none items-center gap-1.5 border-b-hairline border-line pr-1.5 pl-3 select-none active:cursor-grabbing [&_button]:cursor-default"
          onPointerDown={(event) => {
            if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
            trackDrag(
              event,
              (dx, dy) => gui.themeDrag(dx, dy),
              () => undefined,
            )
          }}
        >
          <h1 className="font-semibold">Theme</h1>
          {snapshot && (
            <span className="text-caption text-subtle tabular-nums">
              {snapshot.variables.length}
            </span>
          )}
          <span className="flex-1" />
          <IconButton label="Close" size="sm" icon={X} onClick={() => gui.toggleTheme()} />
        </header>
        <PopoverSearch
          aria-label="Search variables"
          placeholder="Search variables"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        {snapshot && snapshot.modes.length > 1 && (
          <ModeHeaders snapshot={snapshot} shown={state?.mode ?? null} />
        )}
        {shownMode && snapshot?.appSetsMode.includes(shownMode.id) && (
          <p className="shrink-0 border-b-hairline border-line px-3 py-1.5 text-caption text-muted">
            The app sets its own theme here. Edits still preview.
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {!snapshot ? (
            <PopoverNote loading>Reading the theme…</PopoverNote>
          ) : groups.length === 0 ? (
            <PopoverNote>
              {query ? 'No variables match' : 'No CSS variables on this page'}
            </PopoverNote>
          ) : (
            groups.map(({ group, rows }) => (
              <section key={group} className="pt-2">
                <GroupLabel as="h2" className="px-3 pb-1 uppercase">
                  {GROUP_NAMES[group]}
                </GroupLabel>
                {rows.map((item) =>
                  item.kind === 'var' ? (
                    row(item.variable)
                  ) : (
                    <ScaleRow
                      key={item.prefix}
                      scale={item}
                      mode={state?.mode ?? snapshot.modes[0]?.id ?? 'default'}
                      expanded={open.has(item.prefix)}
                      onToggle={() => {
                        const next = new Set(open)
                        if (!next.delete(item.prefix)) next.add(item.prefix)
                        setOpen(next)
                      }}
                    >
                      {item.variables.map(row)}
                    </ScaleRow>
                  ),
                )}
              </section>
            ))
          )}
          {snapshot && colors < FEW_COLORS && !query && (
            <div className="px-3 pt-3">
              <Button size="sm" onClick={() => gui.themeAskAgent(null)}>
                Ask the agent to use variables
              </Button>
            </div>
          )}
        </div>
        {state?.blocked && (
          <p
            role="alert"
            className="shrink-0 border-t-hairline border-line bg-danger-soft px-3 py-1.5 text-danger wrap-anywhere"
          >
            {state.blocked.name
              ? `${state.blocked.name}: ${state.blocked.reason}`
              : state.blocked.reason}
          </p>
        )}
        {pending.length > 0 && (
          <footer className="flex h-10 shrink-0 items-center gap-1.5 border-t-hairline border-line px-3">
            <span className="flex-1 text-muted">
              {pending.length === 1 ? '1 change' : `${pending.length} changes`}
            </span>
            <Button size="sm" variant="ghost" onClick={() => gui.themeCancel()}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => gui.themeKeep()}>
              Keep
            </Button>
          </footer>
        )}
      </div>
    </div>
  )
}

/** A column per mode; choosing one shows the preview in it, choosing it again its own. */
function ModeHeaders({ snapshot, shown }: { snapshot: ThemeSnapshot; shown: string | null }) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b-hairline border-line px-3 py-1">
      <span className="flex-1 text-caption text-subtle">Shown in</span>
      {snapshot.modes.map((mode) => (
        <button
          key={mode.id}
          type="button"
          aria-pressed={mode.id === shown}
          title={
            snapshot.appSetsMode.includes(mode.id) ? 'The app sets its own theme here' : undefined
          }
          onClick={() => gui.themeMode(mode.id === shown ? null : mode.id)}
          className={cn(
            'w-14 truncate rounded-sm px-1 py-0.5 text-center text-caption font-medium',
            mode.id === shown ? 'bg-accent-soft text-accent-text' : 'text-muted hover:bg-hover',
          )}
        >
          {mode.label}
        </button>
      ))}
    </div>
  )
}

/** A variable: its name and use count, a cell per mode, and the editor under it while open. */
function VariableRow({
  variable,
  snapshot,
  pendingOf,
  editing,
  onEdit,
}: {
  variable: ThemeVariable
  snapshot: ThemeSnapshot
  pendingOf: PendingOf
  /** What's being edited from this row, if anything */
  editing: Editing | null
  onEdit: (editing: Editing | null) => void
}) {
  // Editing a reference edits what it refers to in that mode, so the chain of tokens stays.
  const targetIn = (mode: string) => {
    const name = variable.refersTo[mode]
    return (name && snapshot.variables.find((v) => v.name === name)) || variable
  }
  const target = editing ? targetIn(editing.mode) : variable
  const shown = (v: ThemeVariable, mode: string) => pendingOf(v.name, mode) ?? v.values[mode]
  const modes = snapshot.modes
  return (
    <div className={cn('px-3', variable.locked && 'opacity-60')}>
      <div className="flex h-7 items-center gap-1">
        <span className="min-w-0 flex-1 truncate font-mono" title={variable.name}>
          {variable.name}
        </span>
        <span className="shrink-0 text-caption text-subtle tabular-nums" title="Uses on this page">
          {variable.uses}
        </span>
        {modes.map((mode) => (
          <ValueCell
            key={mode.id}
            variable={variable}
            mode={mode}
            value={shown(variable, mode.id)}
            swatch={swatchOf(variable, mode.id, snapshot, pendingOf)}
            wide={modes.length === 1}
            active={editing?.mode === mode.id}
            onClick={() =>
              onEdit(
                editing?.mode === mode.id
                  ? null
                  : { row: variable.name, name: targetIn(mode.id).name, mode: mode.id },
              )
            }
          />
        ))}
      </div>
      {variable.locked && (
        <div className="flex items-center gap-1.5 pb-1 text-caption text-muted">
          <Lock className="size-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate" title={variable.locked}>
            {variable.locked}
          </span>
          <TextButton onClick={() => gui.themeAskAgent(variable.name)}>Ask the agent</TextButton>
        </div>
      )}
      {editing && (
        <Editor
          variable={target}
          mode={editing.mode}
          value={shown(target, editing.mode) ?? target.resolved[editing.mode] ?? ''}
        />
      )}
    </div>
  )
}

function ValueCell({
  variable,
  mode,
  value,
  swatch,
  wide,
  active,
  onClick,
}: {
  variable: ThemeVariable
  mode: ThemeMode
  value: string | null
  swatch: string | null
  wide: boolean
  active: boolean
  onClick: () => void
}) {
  const inherited = value === null
  const reference = variable.refersTo[mode.id]
  const text = reference ? `→ ${reference}` : (value ?? variable.resolved[mode.id])
  const font = variable.kind === 'font' && !reference
  return (
    <button
      type="button"
      title={`${mode.label}: ${text}${inherited ? ' (inherited)' : ''}`}
      aria-label={`Edit ${variable.name} in ${mode.label}`}
      aria-expanded={active}
      onClick={onClick}
      className={cn(
        'flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-1 hover:bg-hover aria-expanded:bg-accent-soft',
        wide ? 'w-28' : 'w-14',
        inherited && 'text-subtle',
      )}
    >
      {variable.kind === 'color' && (
        <span
          className="size-4 shrink-0 rounded-sm border border-line"
          style={{ background: swatch ?? 'transparent' }}
        />
      )}
      {(wide || variable.kind !== 'color') && (
        <span
          className={cn('min-w-0 truncate text-caption', !font && 'font-mono')}
          style={font ? { fontFamily: text } : undefined}
        >
          {text}
        </span>
      )}
    </button>
  )
}

/** The editor under the row: a color field for colors, text for the rest. */
function Editor({
  variable,
  mode,
  value,
}: {
  variable: ThemeVariable
  mode: string
  value: string
}) {
  const label = `${variable.name} in ${mode}`
  const preview = (next: string) => gui.themePreview({ name: variable.name, mode, value: next })
  return (
    <div className="pb-2">
      {variable.kind === 'color' ? (
        <ColorField value={value} label={label} onChange={preview} />
      ) : variable.kind === 'size' ? (
        <div className="flex items-center gap-2">
          <ScrubHandle name={variable.name} value={value} onChange={preview} />
          <TextField value={value} label={label} onChange={preview} />
        </div>
      ) : (
        <TextField value={value} label={label} onChange={preview} />
      )}
    </div>
  )
}

/** A Tailwind scale, folded: a few of its shades and how many there are; it opens to its rows. */
function ScaleRow({
  scale,
  mode,
  expanded,
  onToggle,
  children,
}: {
  scale: Extract<PanelRow, { kind: 'scale' }>
  mode: string
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  const step = Math.max(1, Math.floor(scale.variables.length / SCALE_PREVIEW))
  const shades = scale.variables.filter((_, i) => i % step === 0).slice(0, SCALE_PREVIEW)
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex h-7 w-full items-center gap-1.5 px-3 text-left hover:bg-hover"
      >
        <ChevronDown
          className={cn(
            'size-3 shrink-0 text-subtle transition-transform',
            !expanded && '-rotate-90',
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate font-mono">{scale.prefix}</span>
        {scale.variables[0]?.kind === 'color' && (
          <span className="flex shrink-0">
            {shades.map((shade) => (
              <span
                key={shade.name}
                className="size-3.5 border-y border-line first:rounded-l-sm first:border-l last:rounded-r-sm last:border-r"
                style={{
                  background: cssColor(shade.resolved[mode] ?? shade.values[mode]) ?? 'transparent',
                }}
              />
            ))}
          </span>
        )}
        <span className="shrink-0 text-caption text-subtle">{scale.variables.length} shades</span>
      </button>
      {expanded && <div className="pl-3">{children}</div>}
    </div>
  )
}

/** A color the swatch can draw: bare `H S% L%` channels aren't one on their own. */
function cssColor(value: string | null | undefined): string | null {
  if (!value) return null
  const parsed = parseColor(value)
  if (parsed) return formatColor(parsed.rgba, 'rgb')
  return CSS.supports('color', value) ? value : null
}

/**
 * What a variable's swatch shows in `mode`: an edit pending on it, or on what it refers to
 * (following the chain), else its resolved value.
 */
function swatchOf(
  variable: ThemeVariable,
  mode: string,
  snapshot: ThemeSnapshot,
  pendingOf: PendingOf,
) {
  let current: ThemeVariable | undefined = variable
  for (let hop = 0; current && hop < MAX_HOPS; hop++) {
    const edited = pendingOf(current.name, mode)
    if (edited !== null) return cssColor(edited)
    const next: string | null = current.refersTo[mode]
    current = next ? snapshot.variables.find((v) => v.name === next) : undefined
  }
  return cssColor(variable.resolved[mode])
}
