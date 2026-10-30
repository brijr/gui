import type { Nodes } from 'hast'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import {
  cloneElement,
  Fragment,
  lazy,
  memo,
  type ReactElement,
  Suspense,
  useEffect,
  useRef,
  useState,
} from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import type { Components } from 'react-markdown'
import { ErrorBoundary } from '../lib/error-boundary'
import { MARKDOWN_NODE_BUDGET, type MarkdownBlock } from './markdown-model'
import { type MarkdownDisplay, MarkdownRequest } from './markdown-worker-client'

export const markdownComponents: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent-text underline">
      {children}
    </a>
  ),
  // Never auto-load remote images from agent output: that's an exfiltration channel.
  img: ({ src, alt }) =>
    typeof src === 'string' && src ? (
      <a href={src} target="_blank" rel="noreferrer" className="text-accent-text underline">
        {alt || src}
      </a>
    ) : null,
}

const loadSmallMarkdown = () => import('./small-markdown')
const SmallMarkdown = lazy(loadSmallMarkdown)
// Out of the first paint, but fetched once the window is idle: a restored chat's replies
// shouldn't flash as plain text, or change height under the scroll position.
if (typeof requestIdleCallback === 'function') requestIdleCallback(() => void loadSmallMarkdown())
const runtime = {
  Fragment,
  components: markdownComponents,
  ignoreInvalidStyle: true,
  jsx,
  jsxs,
  passKeys: true,
  passNode: true,
}

function nodeSize(node: Nodes) {
  return Number((node.data as { guiMarkdownNodes?: number } | undefined)?.guiMarkdownNodes ?? 1)
}

/** Keep a single real <ul>/<table>/<p>, while mounting its child subtrees between frames. */
export const MarkdownNode = memo(function MarkdownNode({
  node,
  budget,
}: {
  node: Nodes
  budget: number
}) {
  if (nodeSize(node) <= MARKDOWN_NODE_BUDGET || !('children' in node)) {
    return toJsxRuntime(node, runtime)
  }
  const children = []
  let remaining = budget - 1
  for (let index = 0; index < node.children.length && remaining > 0; index++) {
    const child = node.children[index]
    // ReactMarkdown filters whitespace children of these table containers. A separately
    // cached text subtree is a Fragment, so do the same filtering before creating it.
    if (
      node.type === 'element' &&
      ['table', 'tbody', 'thead', 'tfoot', 'tr'].includes(node.tagName) &&
      child.type === 'text' &&
      /^[\t\n\f\r ]*$/.test(child.value)
    )
      continue
    const size = nodeSize(child)
    children.push(<MarkdownNode key={index} node={child} budget={Math.min(remaining, size)} />)
    remaining -= size
  }
  const parent = toJsxRuntime({ ...node, children: [] }, runtime) as ReactElement<
    Record<string, unknown>
  >
  return cloneElement(
    parent,
    node.type === 'root'
      ? undefined
      : { 'data-markdown-rendering': budget < nodeSize(node) || undefined },
    children,
  )
})

function ProgressiveMarkdownTree({ block }: { block: MarkdownBlock }) {
  const [drawn, setDrawn] = useState({ tree: block.tree, budget: MARKDOWN_NODE_BUDGET })
  const budget = drawn.tree === block.tree ? drawn.budget : MARKDOWN_NODE_BUDGET
  useEffect(() => {
    let frame: number
    let drawn = MARKDOWN_NODE_BUDGET
    setDrawn({ tree: block.tree, budget: drawn })
    const step = () => {
      drawn = Math.min(block.nodes, drawn + MARKDOWN_NODE_BUDGET)
      setDrawn({ tree: block.tree, budget: drawn })
      if (drawn < block.nodes) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [block.tree, block.nodes])
  return <MarkdownNode node={block.tree} budget={budget} />
}

/** Stable worker-produced blocks don't rerun the Markdown parser or rebuild their JSX. */
export const MarkdownTree = memo(function MarkdownTree({ block }: { block: MarkdownBlock }) {
  if (block.nodes > MARKDOWN_NODE_BUDGET) return <ProgressiveMarkdownTree block={block} />
  return toJsxRuntime(block.tree, runtime)
})

function StreamedMarkdown({ text, live }: { text: string; live: boolean }) {
  const request = useRef<MarkdownRequest | null>(null)
  const [display, setDisplay] = useState<MarkdownDisplay>(() => ({
    blocks: [],
    tail: null,
    raw: text,
    complete: false,
  }))
  useEffect(() => {
    const owner = new MarkdownRequest(setDisplay)
    request.current = owner
    return () => {
      request.current = null
      owner.dispose()
    }
  }, [])
  useEffect(() => request.current?.update(text, live), [text, live])
  return (
    <div
      className="markdown break-words"
      data-markdown-phase={display.complete ? 'complete' : live ? 'live' : 'settling'}
    >
      <ErrorBoundary resetKey={text} fallback={() => <p className="whitespace-pre-wrap">{text}</p>}>
        {display.blocks.map((block, index) => (
          <Fragment key={block.key}>
            {index > 0 && '\n'}
            <MarkdownTree block={block} />
          </Fragment>
        ))}
        {display.tail && (
          <>
            {display.blocks.length > 0 && '\n'}
            <MarkdownTree block={display.tail} />
          </>
        )}
        {display.raw && <p className="whitespace-pre-wrap">{display.raw}</p>}
      </ErrorBoundary>
    </div>
  )
}

export function Markdown({ text, live = false }: { text: string; live?: boolean }) {
  // Small completed messages load their parser on demand. A large archived answer, or any
  // streaming answer, uses the same GFM parser off the renderer thread.
  if (live || text.length > 16_384) return <StreamedMarkdown text={text} live={live} />
  return (
    <div className="markdown break-words" data-markdown-phase="complete">
      {/* Agent output: if it can't be drawn as Markdown, show it as written. */}
      <ErrorBoundary resetKey={text} fallback={() => <p className="whitespace-pre-wrap">{text}</p>}>
        <Suspense fallback={<p className="whitespace-pre-wrap">{text}</p>}>
          <SmallMarkdown text={text} components={markdownComponents} />
        </Suspense>
      </ErrorBoundary>
    </div>
  )
}
