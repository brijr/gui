import type { Root as HtmlRoot, Nodes } from 'hast'
import type { Root as MarkdownRoot } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import {
  MARKDOWN_NODE_BUDGET,
  MAX_MARKDOWN_TAIL,
  type MarkdownBlock,
  type MarkdownUpdate,
} from './markdown-model'

export { MAX_MARKDOWN_TAIL } from './markdown-model'

const parser = unified().use(remarkParse).use(remarkGfm)
const renderer = unified().use(remarkRehype, {
  // Match ReactMarkdown's escaped HTML, without ever transferring executable raw nodes.
  handlers: {
    html: (_state, node) => ({ type: 'text', value: node.value, position: node.position }),
  },
})

/** The same protocol policy as ReactMarkdown's defaultUrlTransform. */
export function safeMarkdownUrl(value: string) {
  const colon = value.indexOf(':')
  const question = value.indexOf('?')
  const hash = value.indexOf('#')
  const slash = value.indexOf('/')
  return colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (question !== -1 && colon > question) ||
    (hash !== -1 && colon > hash) ||
    /^(https?|ircs?|mailto|xmpp)$/i.test(value.slice(0, colon))
    ? value
    : ''
}

function prepare(node: Nodes): number {
  delete node.position
  if (node.type === 'element') {
    for (const key of ['href', 'src']) {
      if (Object.hasOwn(node.properties, key)) {
        node.properties[key] = safeMarkdownUrl(String(node.properties[key] || ''))
      }
    }
  }
  let count = 1
  if ('children' in node) for (const child of node.children) count += prepare(child)
  // The view can subdivide one huge list/table too, retaining its actual parent element.
  node.data = { ...node.data, guiMarkdownNodes: count }
  return count
}

function block(key: string, end: number, tree: HtmlRoot): MarkdownBlock {
  const nodes = prepare(tree)
  return { key, end, tree, nodes, signature: JSON.stringify(tree) }
}

function html(tree: MarkdownRoot) {
  return renderer.runSync(tree) as HtmlRoot
}

/** Parse once off the UI thread. References and footnotes see the whole document. */
export function completeMarkdown(text: string): MarkdownBlock[] {
  const tree = html(parser.parse(text))
  const blocks: MarkdownBlock[] = []
  for (const child of tree.children) {
    // remark-rehype separates root blocks with newlines; the view supplies these between
    // cached blocks. Other root text (escaped HTML) remains ordinary content.
    if (child.type === 'text' && child.value === '\n') continue
    const start = child.position?.start.offset
    const end = child.position?.end.offset ?? text.length
    blocks.push(
      block(start === undefined ? `generated:${blocks.length}` : String(start), end, {
        type: 'root',
        children: [child],
      }),
    )
  }
  return blocks
}

/**
 * Keep the last root block unstable: a following line can turn it into a table/setext
 * heading, extend its list/quote, or close its fence. Definitions can change older links;
 * completion deliberately reparses the complete document in the worker to resolve them.
 */
export class StreamingMarkdown {
  private source = ''
  private offset = 0
  private live = true

  update(text: string, live: boolean): MarkdownUpdate {
    const reset = !text.startsWith(this.source) || (!this.live && live)
    if (reset) this.offset = 0
    this.source = text
    this.live = live
    if (!live) {
      this.offset = 0
      return {
        reset: true,
        complete: true,
        blocks: completeMarkdown(text),
        tail: null,
        raw: '',
        parsedSize: text.length,
      }
    }
    const pending = text.slice(this.offset)
    if (pending.length > MAX_MARKDOWN_TAIL) {
      return { reset, complete: false, blocks: [], tail: null, raw: pending, parsedSize: 0 }
    }
    const tree = parser.parse(pending)
    const settled = tree.children.slice(0, -1)
    const blocks: MarkdownBlock[] = []
    for (const node of settled) {
      const start = this.offset + (node.position?.start.offset ?? 0)
      const end = this.offset + (node.position?.end.offset ?? 0)
      const rendered = html({ type: 'root', children: [node] })
      // Definitions don't draw anything; keep them in the original source for completion.
      if (rendered.children.length) blocks.push(block(String(start), end, rendered))
    }
    const last = tree.children.at(-1)
    let tail: MarkdownBlock | null = null
    if (last) {
      this.offset += last.position?.start.offset ?? 0
      tail = block(`tail:${this.offset}`, text.length, html({ type: 'root', children: [last] }))
    }
    // A very dense unfinished list/table also stays text: bounding bytes alone doesn't
    // bound the number of React elements a mutable root block could recreate.
    const raw = tail && tail.nodes > MARKDOWN_NODE_BUDGET ? text.slice(this.offset) : ''
    return {
      reset,
      complete: false,
      blocks,
      tail: raw ? null : tail,
      raw,
      parsedSize: pending.length,
    }
  }
}
