import { execFileSync } from 'node:child_process'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import sharp from 'sharp'

const directory = new URL('../public/brand/', import.meta.url)
// Outlined from the existing Inter Tight font at weight 600.
const { word, wordWidth } = JSON.parse(
  await readFile(new URL('./brand-wordmark.json', import.meta.url), 'utf8'),
)
const colors = ['#0066FF', '#1F78FF', '#7CB0FF', '#5A9CFF', '#4590FF', '#1E78FF']
const positions = [
  [0, 0],
  [61.3333, 0],
  [0, 30.6667],
  [61.3333, 30.6667],
  [0, 61.3333],
  [30.6667, 61.3333],
]
const mark = (monochrome) =>
  positions
    .map(
      ([x, y], i) =>
        `<rect x="${x}" y="${y}" width="30.6667" height="30.6667" fill="${monochrome || colors[i]}"/>`,
    )
    .join('')
const svg = (width, height, content) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none"><title>Gui</title>${content}</svg>\n`
const save = async (name, content, width) => {
  await writeFile(new URL(`${name}.svg`, directory), content)
  await sharp(Buffer.from(content))
    .resize({ width })
    .png()
    .toFile(new URL(`${name}.png`, directory).pathname)
}
await save('gui-mark', svg(92, 92, mark()), 1024)
for (const [name, color] of [
  ['dark', '#111111'],
  ['light', '#F2F2F2'],
]) {
  await save(`gui-mark-${name}`, svg(92, 92, mark(color)), 1024)
  await save(`gui-wordmark-${name}`, svg(wordWidth, 40, `<g fill="${color}">${word}</g>`), 1024)
  await save(
    `gui-logo-${name}`,
    svg(
      56 + wordWidth,
      40,
      `<g transform="scale(${40 / 92})">${mark()}</g><g transform="translate(56 0)" fill="${color}">${word}</g>`,
    ),
    1600,
  )
}
for (const [name, top, bottom, edge] of [
  ['light', '#FFFFFF', '#EEF1F5', '#000000'],
  ['dark', '#2C2D31', '#17181B', '#FFFFFF'],
]) {
  await save(
    `gui-app-icon-${name}`,
    svg(
      100,
      100,
      `<defs><linearGradient id="plate" x2="0" y2="1"><stop stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs><rect x=".5" y=".5" width="99" height="99" rx="22.5" fill="url(#plate)" stroke="${edge}" stroke-opacity=".1"/><g transform="translate(19 19) scale(.6739)">${mark()}</g>`,
    ),
    1024,
  )
}
for (const [source, target] of [
  ['mark-animated.svg', 'gui-mark-animated.svg'],
  ['favicon.svg', 'gui-favicon.svg'],
  ['favicon.ico', 'gui-favicon.ico'],
  ['apple-touch-icon.png', 'gui-apple-touch-icon.png'],
  ['og.jpg', 'gui-social-card.jpg'],
])
  await copyFile(new URL(`../public/${source}`, import.meta.url), new URL(target, directory))
await writeFile(
  new URL('colors.json', directory),
  `${JSON.stringify(
    {
      blue: '#0066FF',
      tiles: colors,
      ink: '#111111',
      paper: '#FAFAFA',
      dark: '#161616',
      light: '#F2F2F2',
    },
    null,
    2,
  )}\n`,
)
await writeFile(
  new URL('README.txt', directory),
  'Gui brand kit\n\nSVG files are scalable; wordmarks are outlined and need no fonts.\nPNG logos have transparent backgrounds.\nDark variants use dark lettering for light backgrounds; light variants use light lettering for dark backgrounds.\nApp icons include light and dark plates.\nTypography: Inter Tight, weight 600, letter spacing -0.055em for the wordmark.\nPrimary blue: #0066FF.\nKeep the proportions, colors, and clear space of the logo.\n',
)
await copyFile(
  new URL('../node_modules/@fontsource-variable/inter-tight/LICENSE', import.meta.url),
  new URL('Inter-Tight-LICENSE.txt', directory),
)
execFileSync('python3', [
  '-c',
  `
import zipfile, pathlib, sys
directory = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(directory / 'gui-brand-kit.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(directory.iterdir()):
        if file.suffix != '.zip':
            archive.write(file, 'gui-brand-kit/' + file.name)
`,
  directory.pathname,
])
console.log('Generated Gui brand assets and ZIP')
