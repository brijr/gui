import type { WebContents } from 'electron'

/**
 * A text log of what happened in the preview while it was recorded: input, animations and
 * transitions, script-driven style changes, layout shifts and slow frames. Agents that can't
 * see the frames (or need exact timing the frames can't prove) read this instead.
 */

/** The isolated world in the preview's page that traces a recording; page scripts can't see it. */
const TRACE_WORLD = 1003
const MAX_ENTRIES = 2000

export type TraceEntry =
  | { kind: 'input'; at: number; event: string; target?: string; detail?: string }
  | {
      kind: 'animation'
      at: number
      type: 'transition' | 'css-animation' | 'script'
      target: string
      name?: string
      duration: number
      delay: number
      easing: string
      iterations: number | 'infinite'
      changes: string[]
      running?: boolean
    }
  | { kind: 'animation-end'; at: number; target: string; name?: string; cancelled?: boolean }
  | {
      kind: 'style'
      at: number
      end: number
      target: string
      updates: number
      changes: string[]
    }
  | { kind: 'class'; at: number; target: string; added: string[]; removed: string[] }
  | { kind: 'dom'; at: number; target: string; added: string[]; removed: string[] }
  | { kind: 'shift'; at: number; score: number; moves: string[] }
  | { kind: 'slow-frame'; at: number; duration: number; blocking: number }
  | { kind: 'scroll'; at: number; end: number; target: string; from: number | null; to: number }
  | { kind: 'navigate'; at: number; url: string }
  | { kind: 'truncated'; at: number }

/**
 * Runs in the page. Times are epoch ms (`timeOrigin + now`), the same clock the recorder in
 * Gui's chrome uses, so they line up with the frames. Calling it again drains what's logged.
 */
const TRACER = String.raw`(() => {
  if (globalThis.__guiTrace) return true
  const MAX = ${MAX_ENTRIES}
  const log = []
  let dropped = false
  const now = () => performance.timeOrigin + performance.now()
  const push = (entry) => {
    if (log.length >= MAX) { dropped = true; return }
    log.push(entry)
  }
  const clip = (value, size = 60) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim()
    return text.length > size ? text.slice(0, size - 1) + '…' : text
  }
  const part = (el) => {
    if (!(el instanceof Element)) return el === document ? 'document' : 'window'
    let name = el.localName
    if (el.id) return name + '#' + CSS.escape(el.id)
    const classes = [...el.classList].filter((c) => c.length <= 40).slice(0, 3)
    if (classes.length) name += '.' + classes.map((c) => CSS.escape(c)).join('.')
    const parent = el.parentElement
    if (parent) {
      const same = [...parent.children].filter((child) => child.localName === el.localName)
      if (same.length > 1) name += ':nth-of-type(' + (same.indexOf(el) + 1) + ')'
    }
    return name
  }
  const describe = (el) => {
    if (!(el instanceof Element)) return part(el)
    const parts = [part(el)]
    let node = el.parentElement
    while (node && parts.length < 3 && !parts[0].includes('#') && node !== document.body) {
      parts.unshift(part(node))
      if (node.id) break
      node = node.parentElement
    }
    let label = parts.join(' > ')
    const text = el.getAttribute('aria-label') || (el.children.length <= 2 ? el.textContent : '')
    if (text && clip(text)) label += ' "' + clip(text, 40) + '"'
    return label
  }

  // Input. Typed characters are not logged, only that typing happened.
  const pointer = (event) => push({ kind: 'input', at: now(), event: event.type, target: describe(event.target), detail: Math.round(event.clientX) + ',' + Math.round(event.clientY) })
  addEventListener('pointerdown', pointer, true)
  addEventListener('click', (event) => push({ kind: 'input', at: now(), event: 'click', target: describe(event.target) }), true)
  let hovered = null
  addEventListener('pointerover', (event) => {
    const target = event.target.closest?.('a,button,[role],[tabindex],input,select,textarea,summary,label') ?? null
    if (!target || target === hovered) return
    hovered = target
    push({ kind: 'input', at: now(), event: 'hover', target: describe(target) })
  }, true)
  let typing = null
  addEventListener('keydown', (event) => {
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
      if (typing && typing.target === event.target) { typing.entry.detail = ++typing.count + ' keys'; return }
      if (typing) delete typing.entry.open
      const entry = { kind: 'input', at: now(), event: 'type', target: describe(event.target), detail: '1 key', open: true }
      typing = { target: event.target, count: 1, entry }
      push(entry)
      return
    }
    if (typing) delete typing.entry.open
    typing = null
    const mods = [event.metaKey && 'Meta', event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean)
    push({ kind: 'input', at: now(), event: 'key', target: describe(event.target), detail: [...mods, event.key].join('+') })
  }, true)
  addEventListener('focusin', (event) => push({ kind: 'input', at: now(), event: 'focus', target: describe(event.target) }), true)

  // Scroll, one entry per burst.
  const scrolls = new Map()
  const position = (target) => target === window ? scrollY : target.scrollTop
  const settled = new WeakMap([[window, scrollY]])
  addEventListener('scroll', (event) => {
    const target = event.target === document ? window : event.target
    let burst = scrolls.get(target)
    if (!burst) {
      const from = settled.get(target)
      burst = { kind: 'scroll', at: now(), end: now(), target: target === window ? 'window' : describe(target), from: from === undefined ? null : Math.round(from), to: 0, open: true }
      scrolls.set(target, burst)
      push(burst)
    }
    burst.end = now()
    burst.to = Math.round(position(target))
    clearTimeout(burst.timer)
    burst.timer = setTimeout(() => {
      scrolls.delete(target)
      settled.set(target, position(target))
      delete burst.timer
      delete burst.open
    }, 150)
  }, true)

  // Animations and transitions: CSS ones and element.animate() alike, as they start.
  const seen = new WeakSet()
  const SKIP = new Set(['offset', 'easing', 'composite', 'computedOffset'])
  const changes = (effect) => {
    let frames = []
    try { frames = effect.getKeyframes() } catch {}
    const props = new Map()
    for (const frame of frames) for (const key of Object.keys(frame)) {
      if (SKIP.has(key)) continue
      if (!props.has(key)) props.set(key, [])
      props.get(key).push(clip(frame[key], 50))
    }
    return [...props].slice(0, 8).map(([key, values]) => {
      const kept = values.length > 4 ? [values[0], '…', values.at(-1)] : values
      return key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + ' ' + kept.join(' → ')
    })
  }
  const watch = (running) => {
    for (const animation of document.getAnimations()) {
      if (seen.has(animation)) continue
      seen.add(animation)
      const effect = animation.effect
      const target = effect?.target
      const timing = effect?.getComputedTiming?.() ?? {}
      const type = typeof CSSTransition !== 'undefined' && animation instanceof CSSTransition ? 'transition'
        : typeof CSSAnimation !== 'undefined' && animation instanceof CSSAnimation ? 'css-animation' : 'script'
      const name = type === 'transition' ? animation.transitionProperty : type === 'css-animation' ? animation.animationName : animation.id || undefined
      const label = describe(target) + (effect?.pseudoElement ? effect.pseudoElement : '')
      push({
        kind: 'animation', at: now(), type, target: label, name,
        duration: Math.round(Number(timing.duration) || 0), delay: Math.round(timing.delay || 0),
        easing: clip(timing.easing || 'linear', 80),
        iterations: timing.iterations === Infinity ? 'infinite' : timing.iterations ?? 1,
        changes: changes(effect),
        ...(running ? { running: true } : {}),
      })
      animation.finished.then(
        () => push({ kind: 'animation-end', at: now(), target: label, name }),
        () => push({ kind: 'animation-end', at: now(), target: label, name, cancelled: true }),
      )
    }
  }
  watch(true)
  const tick = () => { if (!globalThis.__guiTrace?.stopped) { watch(false); requestAnimationFrame(tick) } }
  requestAnimationFrame(tick)

  // Classes, inline styles (script-driven motion, coalesced per element) and added/removed nodes.
  const runs = new Map()
  const styles = (el) => {
    const out = {}
    for (const key of el.style) out[key] = el.style.getPropertyValue(key)
    return out
  }
  const nodeName = (node) => node instanceof Element ? describe(node) : null
  const observer = new MutationObserver((records) => {
    const at = now()
    const dom = new Map()
    for (const record of records) {
      const target = record.target
      if (record.type === 'attributes' && record.attributeName === 'class' && target instanceof Element) {
        const before = new Set(String(record.oldValue ?? '').split(/\s+/).filter(Boolean))
        const after = new Set(target.classList)
        const added = [...after].filter((c) => !before.has(c))
        const removed = [...before].filter((c) => !after.has(c))
        if (added.length || removed.length) push({ kind: 'class', at, target: describe(target), added, removed })
      } else if (record.type === 'attributes' && record.attributeName === 'style' && target instanceof HTMLElement) {
        let run = runs.get(target)
        if (!run) {
          const before = {}
          const old = document.createElement('div')
          old.setAttribute('style', record.oldValue ?? '')
          for (const key of old.style) before[key] = old.style.getPropertyValue(key)
          run = { entry: { kind: 'style', at, end: at, target: describe(target), updates: 0, changes: [], open: true }, before }
          runs.set(target, run)
          push(run.entry)
        }
        run.entry.updates++
        run.entry.end = at
        const after = styles(target)
        run.entry.changes = [...new Set([...Object.keys(run.before), ...Object.keys(after)])]
          .filter((key) => run.before[key] !== after[key])
          .slice(0, 8)
          .map((key) => key + ' ' + clip(run.before[key] || '(unset)', 50) + ' → ' + clip(after[key] || '(unset)', 50))
        clearTimeout(run.timer)
        run.timer = setTimeout(() => {
          runs.delete(target)
          delete run.entry.open
        }, 200)
      } else if (record.type === 'childList') {
        const parent = target instanceof Element ? target : document.documentElement
        const added = [...record.addedNodes].map(nodeName).filter(Boolean)
        const removed = [...record.removedNodes].map(nodeName).filter(Boolean)
        if (!added.length && !removed.length) continue
        const entry = dom.get(parent) ?? { kind: 'dom', at, target: describe(parent), added: [], removed: [] }
        dom.set(parent, entry)
        entry.added.push(...added)
        entry.removed.push(...removed)
      }
    }
    for (const entry of dom.values()) {
      entry.added = entry.added.slice(0, 5)
      entry.removed = entry.removed.slice(0, 5)
      push(entry)
    }
  })
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style'] })

  // Layout shifts and slow frames, as the browser measures them.
  const performanceObservers = []
  const observe = (type, onEntry) => {
    try {
      const po = new PerformanceObserver((list) => list.getEntries().forEach(onEntry))
      po.observe({ type, buffered: false })
      performanceObservers.push(po)
    } catch {}
  }
  observe('layout-shift', (entry) => {
    const rect = (r) => Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + '×' + Math.round(r.height)
    const moves = (entry.sources ?? []).slice(0, 5).map((source) =>
      (source.node ? nodeName(source.node) ?? 'text' : 'removed node') + ' ' + rect(source.previousRect) + ' → ' + rect(source.currentRect))
    push({ kind: 'shift', at: performance.timeOrigin + entry.startTime, score: Math.round(entry.value * 1000) / 1000, moves })
  })
  observe('long-animation-frame', (entry) => push({
    kind: 'slow-frame', at: performance.timeOrigin + entry.startTime,
    duration: Math.round(entry.duration), blocking: Math.round(entry.blockingDuration ?? 0),
  }))

  globalThis.__guiTrace = {
    stopped: false,
    // What's under the pointer at a viewport point, for a narrated recording's cursor: the
    // control it's in when there is one, else the element itself.
    at(x, y) {
      const el = document.elementFromPoint(x, y)
      if (!el) return null
      return describe(el.closest('a,button,[role],input,select,textarea,label,summary') ?? el)
    },
    // Entries still changing (a scroll or typing burst, a run of style updates) stay until
    // they settle, unless this is the last drain.
    drain(final) {
      const out = []
      for (let i = 0; i < log.length; ) {
        if (log[i].open && !final) { i++; continue }
        const { open, timer, ...entry } = log.splice(i, 1)[0]
        out.push(entry)
      }
      if (dropped) { out.push({ kind: 'truncated', at: now() }); dropped = false }
      return out
    },
    stop() {
      this.stopped = true
      observer.disconnect()
      for (const po of performanceObservers) po.disconnect()
    },
  }
  return true
})()`

/** Traces one recording of the preview, across reloads and navigations of its page. */
export class RecordingTrace {
  private entries: TraceEntry[] = []
  private timer: NodeJS.Timeout
  private stopped = false

  constructor(private contents: WebContents) {
    void this.inject()
    this.timer = setInterval(() => void this.drain(), 1000)
  }

  /** Drains the old page before it goes, when it still can. */
  async navigating() {
    await this.drain(true)
  }

  /** A new document in the preview: logs it and traces it too. */
  navigated(url: string) {
    this.add([{ kind: 'navigate', at: performance.timeOrigin + performance.now(), url }])
    void this.inject()
  }

  /** The element at a viewport point, described like the log's targets; null when none. */
  async locate(x: number, y: number): Promise<string | null> {
    if (this.stopped || !Number.isFinite(x) || !Number.isFinite(y)) return null
    const found = await this.run(
      `globalThis.__guiTrace?.at(${Math.round(x)}, ${Math.round(y)}) ?? null`,
    )
    return typeof found === 'string' && found ? found.slice(0, 200) : null
  }

  /** Everything traced, with times relative to `startedAt` (epoch ms) */
  async finish(startedAt: number, durationMs: number): Promise<TraceEntry[]> {
    clearInterval(this.timer)
    await this.drain(true)
    this.stopped = true
    void this.run('globalThis.__guiTrace?.stop(); delete globalThis.__guiTrace')
    const rel = (at: number) => Math.round((at - startedAt) * 10) / 10
    return (
      this.entries
        .map((entry) => {
          const out = { ...entry, at: rel(entry.at) }
          if ('end' in out) out.end = rel(out.end)
          return out
        })
        // What was already going on as the clip began (traced while the capture was starting)
        // counts from its first frame.
        .filter(
          (entry) =>
            entry.at <= durationMs + 50 &&
            (entry.at >= -50 ||
              (entry.kind === 'animation' && entry.running) ||
              ('end' in entry && entry.end >= 0)),
        )
        .map((entry) => (entry.at < 0 ? { ...entry, at: 0 } : entry))
        .sort((a, b) => a.at - b.at)
    )
  }

  dispose() {
    clearInterval(this.timer)
    if (this.stopped) return
    this.stopped = true
    void this.run('globalThis.__guiTrace?.stop(); delete globalThis.__guiTrace')
  }

  private async inject() {
    if (!this.stopped) await this.run(TRACER)
  }

  private async drain(final = false) {
    if (this.stopped) return
    const out = await this.run(`globalThis.__guiTrace?.drain(${final}) ?? []`)
    if (Array.isArray(out)) this.add(out as TraceEntry[])
  }

  private add(entries: TraceEntry[]) {
    for (const entry of entries) {
      if (this.entries.length >= MAX_ENTRIES) {
        if (this.entries.at(-1)?.kind !== 'truncated')
          this.entries.push({ kind: 'truncated', at: entry.at })
        return
      }
      if (entry && typeof entry === 'object' && Number.isFinite(entry.at)) this.entries.push(entry)
    }
  }

  /** A hung page gives up after a second, so it can't hold up saving the clip. */
  private async run(code: string): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined
    try {
      if (this.contents.isDestroyed()) return null
      return await Promise.race([
        this.contents.executeJavaScriptInIsolatedWorld(TRACE_WORLD, [{ code }]),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 1000)
        }),
      ])
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

const ms = (value: number) => `${value.toFixed(0)} ms`

function line(entry: TraceEntry): string {
  switch (entry.kind) {
    case 'input':
      return `${entry.event}${entry.target ? ` ${entry.target}` : ''}${entry.detail ? ` (${entry.detail})` : ''}`
    case 'animation': {
      const kind =
        entry.type === 'transition'
          ? 'CSS transition'
          : entry.type === 'css-animation'
            ? 'CSS animation'
            : 'script animation (WAAPI)'
      const name = entry.name ? ` ${entry.name}` : ''
      const repeat = entry.iterations === 1 ? '' : `, ${entry.iterations} iterations`
      const delay = entry.delay ? `, delay ${ms(entry.delay)}` : ''
      const changes = entry.changes.length ? `\n    ${entry.changes.join('\n    ')}` : ''
      return `${kind}${name} on ${entry.target}: ${ms(entry.duration)} ${entry.easing}${delay}${repeat}${entry.running ? ' (already running)' : ''}${changes}`
    }
    case 'animation-end':
      return `${entry.cancelled ? 'cancelled' : 'finished'}: ${entry.name ? `${entry.name} on ` : ''}${entry.target}`
    case 'style':
      return `inline style on ${entry.target} set by script ${entry.updates}× until ${ms(entry.end)}${entry.changes.length ? `\n    ${entry.changes.join('\n    ')}` : ''}`
    case 'class':
      return `class on ${entry.target}: ${[...entry.added.map((c) => `+${c}`), ...entry.removed.map((c) => `-${c}`)].join(' ')}`
    case 'dom':
      return `DOM in ${entry.target}: ${[...entry.added.map((n) => `+ ${n}`), ...entry.removed.map((n) => `- ${n}`)].join(', ')}`
    case 'shift':
      return `layout shift (score ${entry.score})${entry.moves.length ? `\n    ${entry.moves.join('\n    ')}` : ''}`
    case 'slow-frame':
      return `slow frame: ${ms(entry.duration)}${entry.blocking ? `, ${ms(entry.blocking)} blocking` : ''} (dropped frames / jank)`
    case 'scroll':
      return `scroll ${entry.target} ${entry.from === null ? '' : `${entry.from} → `}${entry.to}px until ${ms(entry.end)}`
    case 'navigate':
      return `navigated to ${entry.url}`
    case 'truncated':
      return 'log limit reached; later events were not recorded'
  }
}

/** The timeline as text, one event a line, optionally only those in a time range. */
export function formatTimeline(
  entries: TraceEntry[],
  {
    startMs = 0,
    endMs = Infinity,
    limit = Infinity,
  }: { startMs?: number; endMs?: number; limit?: number } = {},
) {
  const inRange = entries.filter((entry) => entry.at >= startMs && entry.at <= endMs)
  const lines = inRange
    .slice(0, limit)
    .map(
      (entry) =>
        `${ms(entry.at).padStart(9)}  ${line(entry).replaceAll('\n    ', '\n             ')}`,
    )
  if (inRange.length > limit) lines.push(`… ${inRange.length - limit} more events`)
  return lines.join('\n')
}
