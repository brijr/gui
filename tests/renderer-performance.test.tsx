import { expect, test } from 'bun:test'
import { Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MarkdownNode, MarkdownTree, markdownComponents } from '../src/renderer/src/chat/markdown'
import {
  completeMarkdown,
  MAX_MARKDOWN_TAIL,
  StreamingMarkdown,
  safeMarkdownUrl,
} from '../src/renderer/src/chat/markdown-parser'
import { markdownCadence } from '../src/renderer/src/chat/markdown-worker-client'
import { TURN_GAP, TurnLayout } from '../src/renderer/src/chat/turn-layout'
import { TurnPresentation } from '../src/renderer/src/chat/turn-presentation'

function finalHtml(text: string) {
  return renderToStaticMarkup(
    completeMarkdown(text).map((block, index) => (
      <Fragment key={block.key}>
        {index > 0 && '\n'}
        <MarkdownTree block={block} />
      </Fragment>
    )),
  )
}

function expectedHtml(text: string) {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {text}
    </ReactMarkdown>,
  )
}

test('the turn window stays bounded as archived history grows, while active turns stay mounted', () => {
  for (const count of [50, 300, 10_000]) {
    const ids = Array.from({ length: count }, (_, index) => `turn-${index}`)
    const layout = new TurnLayout(ids, new Map())
    const middle = layout.offsets[Math.floor(count / 2)]
    const visible = layout.window(middle, 600, [ids[count - 1]])
    expect(visible.length).toBeLessThanOrEqual(10)
    expect(visible).toContain(count - 1)
    expect(visible).toContain(Math.floor(count / 2))
    expect(layout.window(layout.total - 600, 600).at(-1)).toBe(count - 1)
  }
})

test('measured heights preserve a reading anchor, and stand until the turn is measured again', () => {
  const ids = ['first', 'second', 'reading', 'last']
  const before = new TurnLayout(ids, new Map())
  const anchor = before.anchor(before.offsets[2] + 45)
  expect(anchor).toEqual({ id: 'reading', offset: 45 })
  const heights = new Map([
    ['first', 400],
    ['second', 20],
  ])
  const after = new TurnLayout(ids, heights)
  if (!anchor) throw new Error('Expected a reading anchor')
  expect(after.restore(anchor)).toBe(after.offsets[2] + 45)
  expect(after.restore({ id: 'removed', offset: 10 })).toBeNull()
  // Measured at another width (the panel resized since), a height is still a better guess for
  // a turn out of view than the estimate; one in view is measured again before it's painted.
  expect(after.offsets[2]).toBe(400 + 20 + 2 * TURN_GAP)
  expect(new TurnLayout([], new Map()).window(0, 600)).toEqual([])
})

test('disclosures and pending actions survive row unmount subscriptions and prune on chat replacement', () => {
  const state = new TurnPresentation()
  const key = 'turn-one\0steps:tool'
  let notified = 0
  const unsubscribe = state.subscribe(key, () => notified++)
  expect(state.read(key, false)).toBe(false)
  state.write(key, true, false)
  expect(notified).toBe(1)
  unsubscribe()
  // A remount reads the user's expanded choice. An async action finishing while offscreen
  // writes its result too, instead of leaving a busy button after the row returns.
  expect(state.read(key, false)).toBe(true)
  state.write('turn-one\0result:busy', true, false)
  state.write('turn-one\0result:busy', false, false)
  expect(state.read('turn-one\0result:busy', true)).toBe(false)
  state.retain(['turn-one'])
  expect(state.read(key, false)).toBe(true)
  state.retain(['another-chat'])
  expect(state.read(key, false)).toBe(false)
})

test('final worker blocks match ReactMarkdown GFM, including late references, tables, code and footnotes', () => {
  const cases = [
    '# Heading\n\nA [later link][target] and ![reference image][image].\n\n[target]: https://example.com "Later"\n[image]: https://example.com/image.png',
    '| Choice | Cost |\n| :--- | ---: |\n| A | **$5** |\n| B | $7 |\n\nAfter the table.',
    '```tsx\nconst value = "<script>"\n\n// blank line stays in code\n```\n\n`inline` and ~~deleted~~.',
    '1. One\n\n   A nested paragraph.\n\n   - nested\n   - list\n\n2. Two\n\n> Quote\n>\n> continued\n\nTail',
    'Setext heading\n---\n\n- [x] Complete\n- [ ] Pending\n\nhttps://example.com\n\nFootnote[^note].\n\n[^note]: Note with [a link](https://example.com).',
    '<script>alert("hello")</script>\n\n[bad](javascript:alert%281%29) ![image](https://example.com/remote.png)',
    '[unfinished](https://example.com\n\n~~~js\nconst partial = 1\n',
  ]
  for (const text of cases) expect(finalHtml(text)).toBe(expectedHtml(text))
  const images = finalHtml('![private](https://example.com/private.png)')
  expect(images).not.toContain('<img')
  expect(images).toContain('rel="noreferrer"')
})

test('incremental parsing only touches the unfinished root block and bounds oversized tails', () => {
  const parser = new StreamingMarkdown()
  const paragraph = '## A settled heading\n\n- one\n- two\n\nA following paragraph.\n\n'
  let source = ''
  let settled = 0
  for (let index = 0; index < 300; index++) {
    source += paragraph
    const result = parser.update(source, true)
    expect(result.reset).toBe(false)
    expect(result.parsedSize).toBeLessThan(paragraph.length * 2)
    settled += result.blocks.length
  }
  expect(settled).toBeGreaterThan(500)
  source += `\n\n\`\`\`txt\n${'unstable code '.repeat(3000)}`
  const oversized = parser.update(source, true)
  expect(oversized.parsedSize).toBe(0)
  expect(oversized.tail).toBeNull()
  expect(oversized.raw.length).toBeGreaterThan(MAX_MARKDOWN_TAIL)
  expect(parser.update(`${source}\n\`\`\``, false).complete).toBe(true)
})

test('streaming retains incomplete lists, quotes, tables and fences until another root block proves their end', () => {
  for (const text of [
    '- first\n\n  second paragraph\n\n- second',
    '> quoted\n>\n> still quoted',
    '| name | value |\n| --- | --- |\n| a | b |',
    '```js\nconst value = 1\n\n// still code\n```',
    'heading\n---',
    '[late][reference]\n\n[reference]: https://example.com',
  ]) {
    const parser = new StreamingMarkdown()
    for (let length = 1; length <= text.length; length++) {
      const live = parser.update(text.slice(0, length), true)
      expect(live.parsedSize).toBeLessThanOrEqual(MAX_MARKDOWN_TAIL)
    }
    expect(parser.update(text, false).blocks).toEqual(completeMarkdown(text))
  }
  const parser = new StreamingMarkdown()
  parser.update('old answer\n\ncontinued', true)
  const replaced = parser.update('replacement', true)
  expect(replaced.reset).toBe(true)
  expect(replaced.tail?.tree.children).toHaveLength(1)
})

test('worker URL policy matches the existing renderer and cadence adapts without unbounded delays', () => {
  for (const url of [
    'https://example.com',
    'mailto:user@example.com',
    '/relative/path',
    '#note',
    'path?q=javascript:expression',
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///private/file',
  ]) {
    expect(safeMarkdownUrl(url)).toBe(defaultUrlTransform(url))
  }
  expect(markdownCadence(1000)).toBe(32)
  expect(markdownCadence(50_000)).toBe(100)
  expect(markdownCadence(1_000_000)).toBe(200)
})

test('one large list or table preserves its real container and bounds incremental subtree mounting', () => {
  const cases = [
    Array.from({ length: 1000 }, (_, index) => `- Row ${index} with **emphasis**`).join('\n'),
    '| Name | Value |\n| --- | --- |\n' +
      Array.from({ length: 1000 }, (_, index) => `| Row ${index} | **${index}** |`).join('\n'),
  ]
  for (const text of cases) {
    const [block] = completeMarkdown(text)
    expect(block.nodes).toBeGreaterThan(4000)
    const partial = renderToStaticMarkup(<MarkdownNode node={block.tree} budget={400} />)
    const next = renderToStaticMarkup(<MarkdownNode node={block.tree} budget={800} />)
    const full = renderToStaticMarkup(<MarkdownNode node={block.tree} budget={block.nodes} />)
    expect(full).toBe(expectedHtml(text))
    expect(partial.match(/<(?:ul|table)(?: |>)/g)).toHaveLength(1)
    expect(partial.match(/<(?:li|tr)(?: |>)/g)?.length ?? 0).toBeLessThan(100)
    expect(next.length).toBeGreaterThan(partial.length)
    const parser = new StreamingMarkdown()
    const dense = parser.update(text.slice(0, 12_000), true)
    expect(dense.tail).toBeNull()
    expect(dense.raw.length).toBeGreaterThan(0)
  }
})
