import { expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeTemplate } from '../src/main/templates'

// A folder name can hold all of these; none of them may escape into markup or code.
const awkward = `Tom's "app" <script>alert(1)</script> \`tick\` \${x} & co`

const FILES = [
  '.gitignore',
  'index.html',
  'package.json',
  'src/App.jsx',
  'src/index.css',
  'src/main.jsx',
  'vite.config.js',
]

async function written(template: 'website' | 'dashboard' | 'blank') {
  const root = await mkdtemp(join(tmpdir(), 'gui-template-'))
  await writeTemplate(root, template, awkward)
  return root
}

for (const template of ['website', 'dashboard'] as const) {
  test(`${template} writes its files and keeps an awkward name safe`, async () => {
    const root = await written(template)
    try {
      const files = await readdir(root, { recursive: true })
      expect(files.filter((f) => f.includes('.')).sort()).toEqual(FILES)

      const html = await readFile(join(root, 'index.html'), 'utf8')
      expect(html).toContain(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the name's literal "${x}", kept as text
        '<title>Tom&#39;s &#34;app&#34; &#60;script&#62;alert(1)&#60;/script&#62; `tick` ${x} &#38; co</title>',
      )
      expect(html).not.toContain('<script>alert')

      const app = await readFile(join(root, 'src/App.jsx'), 'utf8')
      const first = app.split('\n')[0] ?? ''
      expect(first.startsWith('const name = ')).toBe(true)
      expect(JSON.parse(first.slice('const name = '.length))).toBe(awkward)
      // The name is a string literal once, and the page shows it only through `{name}`.
      expect(app.split(awkward).length).toBe(1)
      expect(app).toContain('{name}')

      const css = await readFile(join(root, 'src/index.css'), 'utf8')
      expect(css).toContain('@theme')
      expect(css).toContain('prefers-color-scheme: dark')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('blank writes nothing', async () => {
  const root = await written('blank')
  try {
    expect(await readdir(root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
