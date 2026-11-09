// Its own module, like preview-text.ts: the preview's preload builds as one file.

/**
 * Preview → main, from the preview's own preload (src/preload/preview.ts): what the rulers and
 * guides need from the page.
 */
export const PreviewGuides = {
  /** (x: number, y: number): how far the page is scrolled, in its CSS pixels */
  scroll: 'preview-guides:scroll',
  /** ⇧R pressed in the page, outside anything that takes typing */
  toggle: 'preview-guides:toggle',
} as const
