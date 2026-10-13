import type { Root } from 'hast'

/** Bound both live parser input and per-frame mounting of a single dense root block. */
export const MAX_MARKDOWN_TAIL = 16_384
export const MARKDOWN_NODE_BUDGET = 400

export interface MarkdownBlock {
  key: string
  end: number
  tree: Root
  signature: string
  nodes: number
}

export interface MarkdownUpdate {
  reset: boolean
  complete: boolean
  /** Newly settled blocks while live; the full, reference-resolved document when complete. */
  blocks: MarkdownBlock[]
  tail: MarkdownBlock | null
  raw: string
  parsedSize: number
}
