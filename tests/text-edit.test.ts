import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@babel/parser'
import { replaceText, rewriteText } from '../src/main/text-edit'

// Text double-clicked in the preview is rewritten in its source only when that's plainly safe;
// everything else goes to the agent (null here). Both texts come from the page, whose scripts
// can set them to anything, so the second half of this file checks every rewrite against a
// real parser: whatever the page sends, the file's code and markup stay as they were.

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

test('an element with handlers and expressions in its tag still has its copy rewritten', () => {
  const source = '<button type="button" onClick={() => setOpen(true)}>Open menu</button>'
  expect(replaceText(source, 'Open menu', 'Menu', null)).toBe(
    '<button type="button" onClick={() => setOpen(true)}>Menu</button>',
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

test('only what an element holds is copy: strings, attributes and code are left to the agent', () => {
  // A string literal or an attribute's value may be copy, or a URL, a path, a command.
  expect(replaceText(`const items = [{ label: 'Pricing' }]`, 'Pricing', 'Plans', null)).toBeNull()
  expect(replaceText('<Card title="Pricing" />', 'Pricing', 'Plans', null)).toBeNull()
  expect(replaceText('<script src="/app.js"></script>', '/app.js', '/other.js', null)).toBeNull()
  // Text between two strings is code, though quotes are on both sides of it.
  expect(replaceText(`const list = ['a','b']`, ',', ', c ,', null)).toBeNull()
  // Code that reads the same as something on the page.
  expect(replaceText('const admin = false\n', 'const admin = false', 'x', null)).toBeNull()
  expect(replaceText('if (a) {\n  go()\n} else {\n  stop()\n}', 'else', 'x', null)).toBeNull()
  // A script's or a style's content isn't text.
  expect(replaceText('<script>start()</script>', 'start()', 'stop()', null)).toBeNull()
  expect(replaceText('<style>body</style>', 'body', 'html', null)).toBeNull()
  // Text beside a child element or a comment isn't all its element holds.
  expect(replaceText('<p><b>Hi</b> there</p>', 'there', 'you', null)).toBeNull()
  expect(replaceText('<p>{/* note */}Hello</p>', 'Hello', 'Hi', null)).toBeNull()
  expect(replaceText('<Icon />Hello</Icon>', 'Hello', 'Hi', null)).toBeNull()
})

test('the old text has to be plain too: it cannot take markup or code out with it', () => {
  expect(replaceText('<p><b>a</b><b>c</b></p>', 'a</b><b>c', 'x', null)).toBeNull()
  expect(replaceText('<p>{count} items</p>', '{count} items', 'x', null)).toBeNull()
  const joined = `el.innerHTML = '<b>a' + clean(name) + 'c</b>'`
  expect(replaceText(joined, "a' + clean(name) + 'c", 'x', null)).toBeNull()
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

test('a quote is refused only where it could end a string the markup sits in', () => {
  const jsx = `import { a } from "a"\nexport const A = () => <p className="x">Hello</p>\nconst b = "b"\n`
  expect(replaceText(jsx, 'Hello', "It's here", null)).toBe(jsx.replace('Hello', "It's here"))
  expect(replaceText(jsx, 'Hello', 'Say "hi"', null)).toBeNull()
  const inString = `el.innerHTML = '<p>Hello</p>'`
  expect(replaceText(inString, 'Hello', "It's here", null)).toBeNull()
  expect(replaceText(inString, 'Hello', 'Say "hi"', null)).toBe(`el.innerHTML = '<p>Say "hi"</p>'`)
  const inTemplate = 'el.innerHTML = `<p>Hello</p>`'
  expect(replaceText(inTemplate, 'Hello', 'a `b` c', null)).toBeNull()
  expect(replaceText(inTemplate, 'Hello', "It's here", null)).toBe(
    "el.innerHTML = `<p>It's here</p>`",
  )
})

test('line breaks of every kind land as one space, on one line', () => {
  const breaks = 'One\nTwo\r\nThree Four Five\tSix\vSeven\fEight'
  expect(replaceText('<p>Hello</p>', 'Hello', breaks, null)).toBe(
    '<p>One Two Three Four Five Six Seven Eight</p>',
  )
  // A line comment ends at a line break, so none may reach it.
  expect(replaceText('// <p>Hello</p>\nstart()', 'Hello', 'a\nstop()', null)).toBe(
    '// <p>a stop()</p>\nstart()',
  )
})

// What a page could send as the new text to get code or markup into the file.
const HOSTILE = [
  '{x()}',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder, as a page would send it
  '${x()}',
  'a}{b',
  '{{x}}',
  '{% x %}',
  '<b>bold</b>',
  '<img src=x onerror=x()>',
  '</h1><script>x()</script>',
  '</script><script>x()</script>',
  '</style>',
  '<!-- x',
  'x -->',
  '<%= x %>',
  '<?php x(); ?>',
  '&lt;script&gt;x()&lt;/script&gt;',
  '&#60;b&#62;',
  '&#x3c;b&#x3e;',
  '&lt b &gt',
  '&#60b',
  '&quot; onclick=&quot;x()',
  '&apos;);x();(&apos;',
  '&#39);x();(&#39',
  '" onclick="x()',
  "' onclick='x()",
  '` onclick=`x()',
  "'+x()+'",
  '"+x()+"',
  '`+x()+`',
  "';x();'",
  '";x();"',
  '`;x();`',
  '\\u003cb\\u003e',
  '\\x3cb\\x3e',
  "\\'",
  'a\\',
  '*/x()/*',
  '*/}{x()}{/*',
  '%3Cb%3E',
  '%27);x();(%27',
  'a\nx()',
  'a\r\nx()',
  'a x()',
  'a x()',
  'a\u0085x()',
  'a\u0000b',
  'a\u001bb',
  '//',
  '/* x',
  ';x()',
  ')};x();({',
  '@x()',
  '#{x}',
  '[[x]]',
  '$x',
  // Unicode look-alikes of quotes, brackets and braces: no parser reads them as syntax.
  '＂x＂ ＇x＇ ｀x｀',
  '‘x’ “x” ′x″ ‹b› «b»',
  '＜b＞x＜/b＞ ﹤b﹥',
  '｛x()｝ ﹛x﹜',
  // Plain words, so each context below is shown to rewrite at all.
  'Plain words, really',
]

/**
 * A JS or JSX file's code with every text taken out: its nodes, names, operators and numbers,
 * with text nodes, string contents and comments blanked. Two sources with the same shape
 * differ only in text.
 */
function shape(code: string) {
  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
    errorRecovery: false,
  })
  const TEXT = new Set(['JSXText', 'StringLiteral', 'TemplateElement', 'DirectiveLiteral'])
  const SKIP = new Set(['loc', 'start', 'end', 'range', 'extra', 'errors', 'tokens'])
  const walk = (node: unknown): unknown => {
    // An element emptied of its text has one child fewer, and is still the same element.
    if (Array.isArray(node)) return node.filter((child) => child?.type !== 'JSXText').map(walk)
    if (!node || typeof node !== 'object') return node
    const record = node as Record<string, unknown>
    if (record.type === 'CommentBlock' || record.type === 'CommentLine') return record.type
    if (TEXT.has(record.type as string)) return record.type
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => !SKIP.has(key))
        .map(([key, value]) => [key, walk(value)]),
    )
  }
  return walk(ast)
}

/**
 * Bun's HTML tokenizer, as much of it as `structure` uses. The tests take only `bun:test`'s
 * typings (tests/tsconfig.json), so the global is declared here.
 */
interface Rewriter {
  on(
    selector: string,
    handlers: {
      element?(el: { tagName: string; attributes: Iterable<[string, string]> }): void
      text?(chunk: { text: string; lastInTextNode: boolean }): void
    },
  ): Rewriter
  onDocument(handlers: { comments?(): void }): Rewriter
  transform(input: Response): Response
}
declare const HTMLRewriter: new () => Rewriter

/**
 * An HTML page's structure: its elements with their attributes, its comments, and its scripts
 * and styles as written. Text in other elements is left out.
 */
async function structure(html: string, attributeValues = true) {
  const out: unknown[] = []
  let code = ''
  const rewriter = new HTMLRewriter()
    .on('*', {
      element(el) {
        const attributes = [...el.attributes].map(([name, value]) =>
          attributeValues ? [name, value] : [name],
        )
        out.push(['element', el.tagName, attributes])
      },
    })
    .on('script, style', {
      text(chunk) {
        code += chunk.text
        if (!chunk.lastInTextNode) return
        out.push(['code', code])
        code = ''
      },
    })
    .onDocument({
      comments() {
        out.push(['comment'])
      },
    })
  await rewriter.transform(new Response(html)).text()
  return out
}

const TSX = `import { useState } from 'react'
import { track } from "./track"

const links = [{ label: 'Pricing', href: '/pricing' }, { label: "Docs", href: "/docs" }]
const pair = ['a','b']
const note = \`Hello \${links.length} there\`

/* Shown first: <h2>Old title</h2> */
export default function App({ admin = false }: { admin?: boolean }) {
  const [count, setCount] = useState(0)
  // <h2>Hidden for now</h2>
  if (admin) {
    track('admin')
  } else {
    track("guest")
  }
  return (
    <main className="page" data-tpl="<i>In an attribute</i>">
      <h1 className="title">
        Hello there
      </h1>
      {/* <p>Commented out</p> */}
      <p title="Fine print">Fine print</p>
      <button type="button" onClick={() => setCount((c) => c + 1)}>Add one</button>
      <span>{count > 1 ? 'Many' : 'One'}</span>
      <a href="/pricing">Pricing</a>
      <div dangerouslySetInnerHTML={{ __html: '<em>In a string</em>' }} />
      <div dangerouslySetInnerHTML={{ __html: "<em>In a double string</em>" }} />
      <div dangerouslySetInnerHTML={{ __html: \`<em>In a template</em>\` }} />
    </main>
  )
}
`

/** Where page copy can sit in a JS or JSX file, markup inside strings and comments included. */
const TSX_COPY = [
  'Hello there',
  'Fine print',
  'Add one',
  'Pricing',
  'Old title',
  'Hidden for now',
  'Commented out',
  'In an attribute',
  'In a string',
  'In a double string',
  'In a template',
]

const HTML = `<!doctype html>
<html lang="en">
<head>
  <title>Frame</title>
  <script src="https://cdn.example.com/lib.js"></script>
  <style>
    body { margin: 0 }
    .title::after { content: "<b>In a style</b>" }
  </style>
</head>
<body class="page">
  <!-- <p>Commented out</p> -->
  <h1 class="title" title="Hello there">
    Hello there
  </h1>
  <div data-tpl='<i>In an attribute</i>'></div>
  <p onclick="show('<b>In a handler</b>')">Fine print</p>
  <a href="/pricing">Pricing</a>
  <textarea><p>In a text field</p></textarea>
  <script>
    const start = 'go'
    list.innerHTML = '<li>In a string</li>'
    list.innerHTML += "<li>In a double string</li>"
    list.innerHTML += \`<li>In a template \${start}</li><li>In a template</li>\`
    start()
  </script>
</body>
</html>
`

const HTML_COPY = [
  'Hello there',
  'Fine print',
  'Pricing',
  'Commented out',
  'In an attribute',
  'In a handler',
  'In a text field',
  'In a style',
  'In a string',
  'In a double string',
  'In a template',
]

const ASTRO = `---
import Layout from '../layouts/Layout.astro'
const title = 'Hello there'
const links = [{ label: 'Pricing', href: '/pricing' }]
---
<Layout title={title}>
  <h1 class="title">Hello there</h1>
  {links.map((link) => <a href={link.href}>{link.label}</a>)}
  <p set:html={'<b>In a string</b>'} />
  <p>Fine print</p>
  <script>
    document.title = '<b>In a script</b>'
  </script>
</Layout>
`

const ASTRO_COPY = ['Hello there', 'Fine print', 'Pricing', 'In a string', 'In a script']

/** An Astro file's frontmatter (code) and the count of braces in its template (expressions). */
function astroParts(source: string) {
  const [, frontmatter = '', template = ''] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source) ?? []
  return { frontmatter, template, braces: template.replace(/[^{}]/g, '') }
}

/**
 * Every run of the source a page could name as the old text: runs of words, and what sits
 * between any two quotes, tags or braces near each other.
 */
function runs(source: string) {
  const found = new Set<string>()
  const words = [...source.matchAll(/\S+/g)]
  for (let i = 0; i < words.length; i++) {
    for (let j = i; j < Math.min(words.length, i + 5); j++) {
      found.add(source.slice(words[i].index, words[j].index + words[j][0].length))
    }
  }
  const edges = [...source.matchAll(/[<>{}"'`()[\],;=]/g)].map((match) => match.index)
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < Math.min(edges.length, i + 8); j++) {
      found.add(source.slice(edges[i] + 1, edges[j]))
      found.add(source.slice(edges[i], edges[j] + 1))
    }
  }
  return [...found].filter((run) => run.trim())
}

describe('a JS or JSX file keeps its code whatever the page sends', () => {
  const before = shape(TSX)

  test('the fixture rewrites plain copy, so the checks below are not empty', () => {
    expect(replaceText(TSX, 'Add one', 'Add two', null)).toBe(TSX.replace('Add one', 'Add two'))
    expect(replaceText(TSX, 'Hello there', 'Hi', null)).toBe(TSX.replace('Hello there', 'Hi'))
  })

  test('hostile new text never becomes code or markup', () => {
    let rewritten = 0
    for (const copy of TSX_COPY) {
      for (const after of HOSTILE) {
        const next = replaceText(TSX, copy, after, null)
        if (next === null) continue
        rewritten++
        expect(shape(next), `${copy} → ${after}`).toEqual(before)
      }
    }
    expect(rewritten).toBeGreaterThan(TSX_COPY.length)
  })

  test('hostile old text never takes code or markup out, wherever it points', () => {
    for (const run of runs(TSX)) {
      for (const after of ['x', 'Plain words', '']) {
        const next = replaceText(TSX, run, after, null) ?? replaceText(TSX, run, after, 19)
        if (next !== null) expect(shape(next), `${run} → ${after}`).toEqual(before)
      }
    }
  })
})

describe('an HTML page, a canvas frame included, keeps its markup and scripts', () => {
  const scripts = (html: string) =>
    [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => shape(match[1]))

  /** Same elements and attributes, and scripts that differ in text only. */
  async function sameStructure(next: string, label: string) {
    // Markup inside an attribute's value or a script's string is text there: the value or
    // the string may change, the attribute and the script's code may not.
    const loose = async (html: string) =>
      (await structure(html, false)).filter((entry) => (entry as unknown[])[0] !== 'code')
    expect(await loose(next), label).toEqual(await loose(HTML))
    expect(scripts(next), label).toEqual(scripts(HTML))
    const styles = (html: string) =>
      /<style>([\s\S]*?)<\/style>/.exec(html)?.[1].replace(/"[^"]*"/g, '""')
    expect(styles(next), label).toBe(styles(HTML))
  }

  test('the fixture rewrites plain copy, so the checks below are not empty', () => {
    expect(replaceText(HTML, 'Pricing', 'Plans', null)).toBe(HTML.replace('>Pricing<', '>Plans<'))
    // Its tag has markup in an attribute, so where the tag starts isn't plain to see.
    expect(replaceText(HTML, 'Fine print', 'Small print', null)).toBeNull()
    // The heading's own text, not the attribute that says the same.
    expect(replaceText(HTML, 'Hello there', 'Hi', null)).toBe(
      HTML.replace('\n    Hello there\n', '\n    Hi\n'),
    )
  })

  test('a page of text only changes in text', async () => {
    const page = '<main><h1 class="t">Hello there</h1><script>start()</script></main>'
    for (const after of HOSTILE) {
      const next = replaceText(page, 'Hello there', after, null)
      if (next !== null) expect(await structure(next), after).toEqual(await structure(page))
    }
  })

  test('hostile new text never becomes code or markup', async () => {
    let rewritten = 0
    for (const copy of HTML_COPY) {
      for (const after of HOSTILE) {
        const next = replaceText(HTML, copy, after, null)
        if (next === null) continue
        rewritten++
        await sameStructure(next, `${copy} → ${after}`)
      }
    }
    expect(rewritten).toBeGreaterThan(HTML_COPY.length)
  })

  test('hostile old text never takes code or markup out, wherever it points', async () => {
    for (const run of runs(HTML)) {
      const next = replaceText(HTML, run, 'x', null)
      if (next !== null) await sameStructure(next, run)
    }
  })

  test('nothing ends a script early', () => {
    for (const copy of ['In a string', 'In a double string', 'In a template']) {
      for (const after of HOSTILE) {
        const next = replaceText(HTML, copy, after, null)
        if (next !== null) expect(next.match(/<\/?script/g)).toEqual(HTML.match(/<\/?script/g))
      }
    }
  })
})

describe('an Astro file keeps its frontmatter and expressions', () => {
  const before = astroParts(ASTRO)

  test('copy is rewritten in the template, not in the frontmatter string that says the same', () => {
    expect(replaceText(ASTRO, 'Hello there', 'Hi', null)).toBe(
      ASTRO.replace('<h1 class="title">Hello there</h1>', '<h1 class="title">Hi</h1>'),
    )
  })

  test('hostile text, old or new, changes text only', async () => {
    const check = async (next: string, label: string) => {
      const parts = astroParts(next)
      expect(parts.frontmatter, label).toBe(before.frontmatter)
      expect(parts.braces, label).toBe(before.braces)
      const loose = async (html: string) => structure(html.replace(/'<b>[^']*<\/b>'/g, "''"), false)
      expect(await loose(parts.template), label).toEqual(await loose(before.template))
    }
    for (const copy of ASTRO_COPY) {
      for (const after of HOSTILE) {
        const next = replaceText(ASTRO, copy, after, null)
        if (next !== null) await check(next, `${copy} → ${after}`)
      }
    }
    for (const run of runs(ASTRO)) {
      const next = replaceText(ASTRO, run, 'x', null)
      if (next !== null) await check(next, run)
    }
  })
})

describe('which files are rewritten', () => {
  const directories: string[] = []
  afterAll(async () => {
    for (const directory of directories) await rm(directory, { recursive: true, force: true })
  })
  const write = async (name: string, content: string) => {
    const directory = await mkdtemp(join(tmpdir(), 'gui-text-edit-'))
    directories.push(directory)
    const file = join(directory, name)
    await writeFile(file, content)
    return file
  }

  test('JSX, Astro and HTML files are', async () => {
    for (const name of ['App.tsx', 'App.jsx', 'page.js', 'index.astro', 'frame.html', 'old.HTM']) {
      const file = await write(name, '<h1>Hello there</h1>\n')
      expect(await rewriteText(file, 'Hello there', 'Hi', null), name).toBe(true)
      expect(await readFile(file, 'utf8')).toBe('<h1>Hi</h1>\n')
    }
  })

  // The page says which file wrote an element, so it could name any file in the project.
  test('nothing else is: Vue, Svelte, config, data, scripts and templates Gui cannot read', async () => {
    const names = [
      'App.vue',
      'App.svelte',
      'vite.config.ts',
      'package.json',
      'notes.md',
      'page.mdx',
      'view.blade.php',
      'page.erb',
      'build.sh',
      '.env',
      'Makefile',
    ]
    for (const name of names) {
      const file = await write(name, '<h1>Hello there</h1>\n')
      expect(await rewriteText(file, 'Hello there', 'Hi', null), name).toBe(false)
      expect(await readFile(file, 'utf8')).toBe('<h1>Hello there</h1>\n')
    }
  })

  test('hostile text is written as text or not at all', async () => {
    const source = 'export const A = () => <h1>Hello there</h1>\n'
    const file = await write('App.tsx', source)
    for (const after of HOSTILE) {
      const wrote = await rewriteText(file, 'Hello there', after, null)
      const written = await readFile(file, 'utf8')
      if (wrote) expect(shape(written), after).toEqual(shape(source))
      else expect(written, after).toBe(source)
      await writeFile(file, source)
    }
  })
})
