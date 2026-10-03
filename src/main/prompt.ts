import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { ElementContext } from '../shared/types'

const PREAMBLE = `You are working inside Grat, a visual design tool. The user sees their app running live in a browser preview backed by its dev server with hot reload. They select elements in the preview and ask for interface changes.

- Edit the source files directly. The preview hot-reloads on save. Do not start, stop, or restart the dev server.
- Make the smallest change that fulfils the request. Match the project's existing styling approach (Tailwind classes, CSS modules, styled components, etc.) and conventions.
- When an element is selected, its details are in <selected_element>. The source location is a strong hint but may be approximate — confirm by reading the file.
- When done, reply in one or two sentences describing what changed.`

interface PromptOptions {
  text: string
  selection: ElementContext | null
  preamble: boolean
  images: boolean
}

export function buildPrompt({ text, selection, preamble, images }: PromptOptions): ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (preamble) blocks.push({ type: 'text', text: PREAMBLE })
  if (selection) {
    blocks.push({ type: 'text', text: describeElement(selection) })
    const image = images && selection.screenshot ? parseDataUrl(selection.screenshot) : null
    if (image) blocks.push({ type: 'image', ...image })
  }
  blocks.push({ type: 'text', text })
  return blocks
}

export function describeElement(el: ElementContext) {
  const lines = [`Page: ${el.url} (viewport ${el.viewport.width}×${el.viewport.height})`]
  lines.push(`Element: <${el.tag}>${el.text ? ` "${el.text.slice(0, 120)}"` : ''}`)
  if (el.source) {
    const position = `${el.source.file}:${el.source.line}${el.source.column ? `:${el.source.column}` : ''}`
    lines.push(`Source: ${position}${el.source.approximate ? ' (approximate)' : ''}`)
  }
  if (el.componentStack.length) {
    lines.push(`Components (innermost first): ${el.componentStack.join(' < ')}`)
  }
  lines.push(`Selector: ${el.selector}`)
  lines.push(
    `Box: ${Math.round(el.rect.width)}×${Math.round(el.rect.height)} at (${Math.round(el.rect.x)}, ${Math.round(el.rect.y)})`,
  )
  const styles = Object.entries(el.styles)
  if (styles.length) {
    lines.push('Computed styles:')
    for (const [key, value] of styles) lines.push(`  ${key}: ${value}`)
  }
  lines.push('HTML:', '```html', el.outerHTML, '```')
  return `<selected_element>\n${lines.join('\n')}\n</selected_element>`
}

function parseDataUrl(url: string) {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/)
  return match ? { mimeType: match[1], data: match[2] } : null
}
