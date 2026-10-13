import { expect, test } from 'bun:test'
import { replaceText } from '../src/main/text-edit'

// Text double-clicked in the preview is rewritten in its source only when that's plainly safe;
// everything else goes to the agent (null here).

test('JSX copy is rewritten where it is, even wrapped across lines', () => {
  const source = `export function Hero() {
  return (
    <h1 className="title">
      Build something
      people love
    </h1>
  )
}`
  expect(replaceText(source, 'Build something people love', 'Ship it today', 3)).toBe(
    source.replace('Build something\n      people love', 'Ship it today'),
  )
})

test('a string literal keeps its quotes, and refuses text that would break them', () => {
  const source = `const items = [{ label: 'Pricing' }, { label: "Docs" }]`
  expect(replaceText(source, 'Pricing', 'Plans', null)).toBe(
    `const items = [{ label: 'Plans' }, { label: "Docs" }]`,
  )
  expect(replaceText(source, 'Pricing', "Plans & what's included", null)).toBeNull()
  expect(replaceText(source, 'Docs', "What's new", null)).toBe(
    `const items = [{ label: 'Pricing' }, { label: "What's new" }]`,
  )
})

test('markup refuses braces, tags and entities', () => {
  const source = '<p>Hello there</p>'
  expect(replaceText(source, 'Hello there', 'Hi {name}', null)).toBeNull()
  expect(replaceText(source, 'Hello there', 'Hi <b>you</b>', null)).toBeNull()
  expect(replaceText(source, 'Hello there', 'Fish &amp; chips', null)).toBeNull()
  expect(replaceText(source, 'Hello there', "Fish & chips, it's", null)).toBe(
    "<p>Fish & chips, it's</p>",
  )
})

test('text that is not in the source as written is left to the agent', () => {
  expect(replaceText('<p>{greeting}, {name}</p>', 'Hello, Ada', 'Hi, Ada', 1)).toBeNull()
  expect(replaceText('<p>Don&apos;t stop</p>', "Don't stop", 'Keep going', 1)).toBeNull()
})

test('only whole copy matches, not part of a word or identifier', () => {
  expect(replaceText('<HomePage /><a>Home</a>', 'Home', 'Start', null)).toBe(
    '<HomePage /><a>Start</a>',
  )
})

test('repeated copy is told apart by where the element was written, or not at all', () => {
  const source = [
    '<nav>',
    '  <a>Learn more</a>',
    '</nav>',
    '<main>',
    '  <a>Learn more</a>',
    '</main>',
  ].join('\n')
  expect(replaceText(source, 'Learn more', 'Read on', null)).toBeNull()
  expect(replaceText(source, 'Learn more', 'Read on', 5)).toBe(
    source.replace(/Learn more(?![\s\S]*Learn more)/, 'Read on'),
  )
  expect(replaceText(source, 'Learn more', 'Read on', 30)).toBeNull()
})

test('nothing changed is nothing to write', () => {
  expect(replaceText('<p>Same</p>', 'Same', '  Same ', null)).toBeNull()
})
