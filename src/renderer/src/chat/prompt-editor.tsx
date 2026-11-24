import 'prosemirror-view/style/prosemirror.css'
import { baseKeymap, splitBlock } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { type Node, Schema } from 'prosemirror-model'
import { EditorState, Selection, TextSelection } from 'prosemirror-state'
import { EditorView, type NodeView } from 'prosemirror-view'
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { imageRef, imageRefParts } from '../../../shared/image-refs'
import { cn } from '../lib/cn'
import { fileSize, shortName } from './images'
import { useChat } from './store'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: {
      content: 'inline*',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    image: {
      inline: true,
      group: 'inline',
      atom: true,
      selectable: false,
      attrs: { n: { validate: 'number' } },
      parseDOM: [
        {
          tag: 'span[data-image-ref]',
          getAttrs: (dom) => ({ n: Number((dom as HTMLElement).dataset.imageRef) }),
        },
      ],
      toDOM: (node) => ['span', { 'data-image-ref': String(node.attrs.n) }, imageRef(node.attrs.n)],
    },
    text: { group: 'inline' },
  },
})

const OBJECT = '\uFFFC'

const isImage = (node: Node) => node.type === schema.nodes.image

function inlineNodes(line: string, count: number) {
  return imageRefParts(line).flatMap((part) =>
    typeof part === 'string'
      ? part
        ? [schema.text(part)]
        : []
      : part >= 1 && part <= count
        ? [schema.nodes.image.create({ n: part })]
        : [schema.text(imageRef(part))],
  )
}

function toDoc(text: string, count: number) {
  return schema.nodes.doc.create(
    null,
    text.split('\n').map((line) => schema.nodes.paragraph.create(null, inlineNodes(line, count))),
  )
}

const nodeText = (node: Node) => (isImage(node) ? imageRef(node.attrs.n) : (node.text ?? ''))

function lineText(paragraph: Node) {
  let line = ''
  paragraph.forEach((child) => {
    line += nodeText(child)
  })
  return line
}

function toText(doc: Node) {
  const lines: string[] = []
  doc.forEach((paragraph) => {
    lines.push(lineText(paragraph))
  })
  return lines.join('\n')
}

function offsetOf(doc: Node, pos: number) {
  let offset = 0
  let found = 0
  doc.forEach((paragraph, start, index) => {
    if (index > 0) offset += 1
    const from = start + 1
    if (pos >= from && pos <= from + paragraph.content.size) {
      let at = from
      let inner = offset
      paragraph.forEach((child) => {
        if (at >= pos) return
        inner += child.isText ? Math.min(child.nodeSize, pos - at) : nodeText(child).length
        at += child.nodeSize
      })
      found = inner
    }
    offset += lineText(paragraph).length
  })
  return found
}

function posOf(doc: Node, target: number) {
  let offset = 0
  let found = doc.content.size - 1
  let done = false
  doc.forEach((paragraph, start, index) => {
    if (done) return
    if (index > 0) offset += 1
    const length = lineText(paragraph).length
    if (target > offset + length) {
      offset += length
      return
    }
    let pos = start + 1
    let at = offset
    paragraph.forEach((child) => {
      if (at >= target) return
      pos += child.isText ? Math.min(child.nodeSize, target - at) : child.nodeSize
      at += nodeText(child).length
    })
    found = pos
    done = true
  })
  return found
}

const redraws = new Set<() => void>()

function imageView(node: Node): NodeView {
  const dom = document.createElement('span')
  dom.contentEditable = 'false'
  dom.dataset.imageRef = String(node.attrs.n)
  dom.className =
    'mx-0.5 inline-flex max-w-56 items-center gap-1 rounded-md border border-line bg-fill py-px pr-1.5 pl-0.5 align-bottom text-small leading-snug text-fg select-none'
  const draw = () => {
    const image = useChat.getState().attachments[node.attrs.n - 1]
    dom.replaceChildren()
    if (!image) {
      dom.removeAttribute('title')
      dom.append(imageRef(node.attrs.n))
      return
    }
    dom.title = image.name
    const thumbnail = document.createElement('img')
    thumbnail.src = image.thumbnail
    thumbnail.alt = ''
    thumbnail.className = 'size-4 shrink-0 rounded-sm object-cover'
    const name = document.createElement('span')
    name.className = 'truncate'
    name.textContent = shortName(image.name)
    dom.append(thumbnail, name)
    if (image.size) {
      const size = document.createElement('span')
      size.className = 'shrink-0 text-caption text-subtle'
      size.textContent = fileSize(image.size)
      dom.append(size)
    }
  }
  draw()
  redraws.add(draw)
  return { dom, ignoreMutation: () => true, destroy: () => redraws.delete(draw) }
}

export interface PromptEditorHandle {
  focus(options?: FocusOptions): void
  setCaret(offset: number): void
  insertImages(numbers: number[]): void
}

interface PromptEditorProps {
  ref?: Ref<PromptEditorHandle>
  value: string
  onChange(text: string): void
  onCaret(text: string, offset: number): void
  onKeyDown(event: KeyboardEvent): boolean
  onPaste(event: ClipboardEvent): boolean
  attributes: Record<string, string>
  placeholder: string
  className?: string
}

export function PromptEditor({
  ref,
  value,
  onChange,
  onCaret,
  onKeyDown,
  onPaste,
  attributes,
  placeholder,
  className,
}: PromptEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef({ onChange, onCaret, onKeyDown, onPaste })
  latest.current = { onChange, onCaret, onKeyDown, onPaste }
  const count = useChat((s) => s.attachments.length)
  const initial = useRef(value)

  const domAttributes = (state: EditorState): Record<string, string> => ({
    ...attributes,
    role: attributes.role ?? 'textbox',
    'aria-multiline': 'true',
    'aria-placeholder': placeholder,
    'data-placeholder': placeholder,
    ...(toText(state.doc) === '' ? { 'data-empty': '' } : {}),
    class: cn(
      'relative whitespace-pre-wrap break-words outline-none focus-visible:outline-none',
      'data-empty:before:pointer-events-none data-empty:before:absolute data-empty:before:text-subtle data-empty:before:content-[attr(data-placeholder)]',
      className,
    ),
  })
  const attributesRef = useRef(domAttributes)
  attributesRef.current = domAttributes

  useLayoutEffect(() => {
    if (!host.current) return
    const doc = toDoc(initial.current, useChat.getState().attachments.length)
    const editor: EditorView = new EditorView(host.current, {
      state: EditorState.create({
        doc,
        selection: Selection.atEnd(doc),
        plugins: [
          history(),
          keymap({ 'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo, 'Shift-Enter': splitBlock }),
          keymap(baseKeymap),
        ],
      }),
      attributes: (state) => attributesRef.current(state),
      nodeViews: { image: (node) => imageView(node) },
      handleKeyDown: (_view, event) => latest.current.onKeyDown(event),
      handlePaste: (editorView, event) => {
        if (latest.current.onPaste(event)) return true
        const text = event.clipboardData?.getData('text/plain') ?? ''
        return text ? editorView.pasteText(text, event) : false
      },
      clipboardTextSerializer: (slice) => {
        const lines: string[] = []
        slice.content.forEach((node) => {
          lines.push(node.isTextblock ? lineText(node) : nodeText(node))
        })
        return lines.join('\n')
      },
      dispatchTransaction(tr) {
        const next = editor.state.apply(tr)
        editor.updateState(next)
        const text = toText(next.doc)
        if (tr.docChanged) latest.current.onChange(text)
        if (tr.docChanged || tr.selectionSet) {
          const { empty, from } = next.selection
          latest.current.onCaret(text, empty ? offsetOf(next.doc, from) : -1)
        }
      },
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const { doc, selection } = editor.state
    if (toText(doc) === value) return
    const caret = Math.min(offsetOf(doc, selection.from), value.length)
    const tr = editor.state.tr.replaceWith(0, doc.content.size, toDoc(value, count).content)
    tr.setSelection(TextSelection.near(tr.doc.resolve(posOf(tr.doc, caret))))
    tr.setMeta('addToHistory', false)
    editor.dispatch(tr)
  }, [value, count])

  useEffect(
    () =>
      useChat.subscribe((state, previous) => {
        if (state.attachments !== previous.attachments) for (const redraw of redraws) redraw()
      }),
    [],
  )

  useEffect(() => {
    view.current?.setProps({ attributes: (state) => attributesRef.current(state) })
  })

  useImperativeHandle(ref, () => ({
    focus(options) {
      view.current?.dom.focus(options)
    },
    setCaret(offset) {
      const editor = view.current
      if (!editor) return
      const { doc } = editor.state
      editor.dispatch(
        editor.state.tr.setSelection(TextSelection.near(doc.resolve(posOf(doc, offset)))),
      )
    },
    insertImages(numbers) {
      const editor = view.current
      if (!editor || numbers.length === 0) return
      const { $from, $to, from, to } = editor.state.selection
      const before = $from.parent.textBetween(0, $from.parentOffset, undefined, OBJECT)
      const after = $to.parent.textBetween(
        $to.parentOffset,
        $to.parent.content.size,
        undefined,
        OBJECT,
      )
      const nodes: Node[] = []
      if (before && !/\s$/.test(before)) nodes.push(schema.text(' '))
      numbers.forEach((n, i) => {
        if (i > 0) nodes.push(schema.text(' '))
        nodes.push(schema.nodes.image.create({ n }))
      })
      if (!/^\s/.test(after)) nodes.push(schema.text(' '))
      const size = nodes.reduce((total, node) => total + node.nodeSize, 0)
      const tr = editor.state.tr.replaceWith(from, to, nodes)
      tr.setSelection(TextSelection.create(tr.doc, from + size)).scrollIntoView()
      editor.dispatch(tr)
      editor.dom.focus({ preventScroll: true })
    },
  }))

  return <div ref={host} className="contents" />
}
