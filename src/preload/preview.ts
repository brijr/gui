/// <reference lib="dom" />
import { ipcRenderer } from 'electron'
import { PreviewGuides } from '../shared/preview-guides'
import { MAX_PREVIEW_TEXT, PreviewText } from '../shared/preview-text'
import { ACCENT } from '../shared/theme'

// Double-click page copy in Design mode to edit it in place: main asks for the text where it
// was double-clicked (`PreviewText.begin`), then writes the edit to the source
// (src/main/text-edit.ts) or hands it to the agent. A double-click in the app itself is the
// app's: it selects a word, as in a browser. This runs in the preview's isolated world: the
// page can't reach it or fake main's messages, and it only reads and edits the DOM.

/** Elements whose text isn't copy to rewrite: form controls, code, drawings. */
const NOT_COPY = 'input,textarea,select,option,script,style,svg,canvas,video,audio,iframe'

/** An element being edited, and how to put it back as it was. */
interface Editing {
  el: HTMLElement
  id: string
  before: string
  /** Its children as the page made them; React holds these text nodes, so they go back. */
  children: ChildNode[]
  /** What its text nodes said; typing changes the nodes themselves, so that goes back too. */
  texts: [Text, string][]
  editable: string | null
  outline: string
  outlineOffset: string
  /** What Return and Esc do, beside the element; Gui's own, in a closed shadow root */
  hint: HTMLElement
}

let editing: Editing | null = null
let starting = false

/** The element to edit where Design mode was double-clicked: one that holds only text. */
function copyAt(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement) || target.isContentEditable) return null
  if (target.closest(NOT_COPY)) return null
  const nodes = [...target.childNodes].filter((node) => node.nodeType !== Node.COMMENT_NODE)
  if (!nodes.length || nodes.some((node) => node.nodeType !== Node.TEXT_NODE)) return null
  const text = target.textContent ?? ''
  return text.trim() && text.length <= MAX_PREVIEW_TEXT ? target : null
}

ipcRenderer.on(PreviewText.begin, (_event, at: unknown) => {
  if (editing || starting || !isPoint(at)) return
  const el = copyAt(document.elementFromPoint(at.x, at.y))
  if (!el) return
  const before = el.textContent ?? ''
  starting = true
  ipcRenderer
    .invoke(PreviewText.start, { x: at.x, y: at.y }, before)
    .then((id: unknown) => {
      if (typeof id !== 'string') return
      if (!el.isConnected || el.textContent !== before) {
        ipcRenderer.send(PreviewText.end, id, null)
        return
      }
      begin(el, id, before)
    })
    .catch(() => undefined)
    .finally(() => {
      starting = false
    })
})

function isPoint(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== 'object') return false
  const { x, y } = value as Record<string, unknown>
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x + y)
}

/** Below the element (above it near the viewport's bottom), at its left edge */
const HINT_GAP = 8
const HINT_HEIGHT = 24

/**
 * The hint beside an edit: Return keeps it, Esc cancels. Gui's own, so it sits in a closed
 * shadow root on the document element, out of the page's styles and its framework's way;
 * it never takes the pointer.
 */
function makeHint(): HTMLElement {
  const host = document.createElement('gui-text-edit-hint')
  const root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; position: fixed; z-index: 2147483647; pointer-events: none;
      animation: in 120ms ease-out both; }
    div { display: flex; align-items: center; gap: 4px; height: ${HINT_HEIGHT}px;
      padding: 0 8px; border-radius: 6px; background: rgba(20, 20, 22, 0.92); color: #e6e6e8;
      font: 500 11px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      white-space: nowrap; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18); }
    kbd { font: inherit; color: #fff; }
    span { color: #9a9aa0; }
    span:not(:last-child) { margin-right: 6px; }
    @keyframes in { from { opacity: 0; transform: translateY(-2px); } }
    @media (prefers-reduced-motion: reduce) { :host { animation-name: fade; } }
    @keyframes fade { from { opacity: 0; } }
  `
  const line = document.createElement('div')
  for (const [key, what] of [
    ['Return', 'to keep'],
    ['Esc', 'to cancel'],
  ]) {
    const kbd = document.createElement('kbd')
    kbd.textContent = key
    const span = document.createElement('span')
    span.textContent = what
    line.append(kbd, span)
  }
  root.append(style, line)
  return host
}

/** Puts the hint under the element being edited, or over it when there's no room below. */
function placeHint() {
  const current = editing
  if (!current) return
  const rect = current.el.getBoundingClientRect()
  const below = rect.bottom + HINT_GAP
  const top =
    below + HINT_HEIGHT <= window.innerHeight
      ? below
      : Math.max(HINT_GAP, rect.top - HINT_GAP - HINT_HEIGHT)
  current.hint.style.top = `${Math.round(top)}px`
  current.hint.style.left = `${Math.round(Math.max(HINT_GAP, rect.left))}px`
}

function begin(el: HTMLElement, id: string, before: string) {
  editing = {
    el,
    id,
    before,
    children: [...el.childNodes],
    texts: [...el.childNodes]
      .filter((node): node is Text => node.nodeType === Node.TEXT_NODE)
      .map((node) => [node, node.data]),
    editable: el.getAttribute('contenteditable'),
    outline: el.style.outline,
    outlineOffset: el.style.outlineOffset,
    hint: makeHint(),
  }
  document.documentElement.append(editing.hint)
  placeHint()
  el.contentEditable = 'plaintext-only'
  el.style.outline = `2px solid ${ACCENT.light}`
  el.style.outlineOffset = '2px'
  el.focus({ preventScroll: true })
  const range = document.createRange()
  range.selectNodeContents(el)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  for (const type of KEYS) window.addEventListener(type, onKey, true)
  for (const type of POINTER) window.addEventListener(type, onPointer, true)
  el.addEventListener('focusout', onBlur)
  window.addEventListener('pagehide', onLeave)
  window.addEventListener('scroll', placeHint, { capture: true, passive: true })
  window.addEventListener('resize', placeHint)
}

/** Ends the edit: the element goes back to how the page made it, with the new text if any. */
function finish(keep: boolean) {
  const current = editing
  if (!current) return
  editing = null
  const { el } = current
  for (const type of KEYS) window.removeEventListener(type, onKey, true)
  for (const type of POINTER) window.removeEventListener(type, onPointer, true)
  el.removeEventListener('focusout', onBlur)
  window.removeEventListener('pagehide', onLeave)
  window.removeEventListener('scroll', placeHint, { capture: true })
  window.removeEventListener('resize', placeHint)
  current.hint.remove()

  const after = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  const changed = keep && after !== current.before.replace(/\s+/g, ' ').trim()
  if (current.editable === null) el.removeAttribute('contenteditable')
  else el.setAttribute('contenteditable', current.editable)
  el.style.outline = current.outline
  el.style.outlineOffset = current.outlineOffset
  el.replaceChildren(...current.children)
  for (const [node, data] of current.texts) node.data = data
  // Shown at once; the source change (or the agent's) follows with the next reload.
  if (changed && current.texts.length === 1) current.texts[0][0].data = after
  window.getSelection()?.removeAllRanges()
  ipcRenderer.send(PreviewText.end, current.id, changed ? after.slice(0, MAX_PREVIEW_TEXT) : null)
}

const KEYS = ['keydown', 'keypress', 'keyup'] as const
const POINTER = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick'] as const

/** Keys typed into the edit are the edit's alone: the page's shortcuts don't see them. */
function onKey(event: KeyboardEvent) {
  if (!editing?.el.contains(event.target as Node)) return
  event.stopPropagation()
  if (event.type !== 'keydown' || event.isComposing) return
  if (event.key === 'Enter') {
    event.preventDefault()
    finish(true)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    finish(false)
  }
}

/** Clicks inside the edit place the caret; the page (a link around it, say) doesn't get them. */
function onPointer(event: Event) {
  if (!editing?.el.contains(event.target as Node)) return
  event.stopPropagation()
  if (event.type === 'click') event.preventDefault()
}

function onBlur() {
  finish(true)
}

function onLeave() {
  finish(false)
}

// Rulers and guides (main/guides.ts): guides keep to the page's content as it scrolls, so main
// hears where it's scrolled; and ⇧R, outside the page's text fields, shows or hides them.

let scrollFrame = 0
function sendScroll() {
  scrollFrame = 0
  ipcRenderer.send(PreviewGuides.scroll, window.scrollX, window.scrollY)
}
// The document's own scrolling only: an element's scroll events don't reach the window.
window.addEventListener(
  'scroll',
  () => {
    if (!scrollFrame) scrollFrame = requestAnimationFrame(sendScroll)
  },
  { passive: true },
)
// A new page starts where it is (restored, or at a #fragment), not where the last one was.
window.addEventListener('pageshow', sendScroll)

/** The element that has the keyboard, inside shadow roots too. */
function focused(): Element | null {
  let el = document.activeElement
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement
  return el
}

/** What typing goes into: a text field, a select (typing picks an option), editable content. */
function takesTyping(el: Element | null) {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLSelectElement) return true
  if (!(el instanceof HTMLInputElement)) return false
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(
    el.type,
  )
}

// Capturing on the window, added before the page's own scripts run, so this hears it first.
window.addEventListener(
  'keydown',
  (event) => {
    if (!event.isTrusted || event.repeat || event.isComposing || editing) return
    if (event.key !== 'R' || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey)
      return
    if (takesTyping(focused())) return
    event.preventDefault()
    event.stopImmediatePropagation()
    ipcRenderer.send(PreviewGuides.toggle)
  },
  true,
)
