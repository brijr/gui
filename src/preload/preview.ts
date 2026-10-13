/// <reference lib="dom" />
import { ipcRenderer } from 'electron'
import { MAX_PREVIEW_TEXT, PreviewText } from '../shared/preview-text'
import { ACCENT } from '../shared/theme'

// Double-click page copy in the preview to edit it in place; main writes it to the source
// (src/main/text-edit.ts) or hands it to the agent. This runs in the preview's isolated world:
// the page can't reach it or fake its events, and it only reads and edits the DOM.

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
}

let editing: Editing | null = null
let starting = false

/** The element to edit from a double-click's target: one that holds only text. */
function copyAt(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement) || target.isContentEditable) return null
  if (target.closest(NOT_COPY)) return null
  const nodes = [...target.childNodes].filter((node) => node.nodeType !== Node.COMMENT_NODE)
  if (!nodes.length || nodes.some((node) => node.nodeType !== Node.TEXT_NODE)) return null
  const text = target.textContent ?? ''
  return text.trim() && text.length <= MAX_PREVIEW_TEXT ? target : null
}

// Bubbling, so a page that handles its own double-clicks (and says so) keeps them.
window.addEventListener('dblclick', (event) => {
  if (!event.isTrusted || event.defaultPrevented || editing || starting) return
  const el = copyAt(event.target)
  if (!el) return
  const before = el.textContent ?? ''
  starting = true
  ipcRenderer
    .invoke(PreviewText.start, { x: event.clientX, y: event.clientY }, before)
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
  }
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
