// Its own module: the preview's preload imports it, and nothing Gui's own preload does, so
// each preload builds as one file (a sandboxed preload can't load a shared chunk).

/**
 * Between main and the preview's own preload (src/preload/preview.ts), not Gui's pages: text
 * double-clicked in Design mode is edited in place in the page, and how it ended.
 */
export const PreviewText = {
  /** Main → preview (at: Point, the viewport's CSS pixels): edit the text there, if it's copy */
  begin: 'preview-text:begin',
  /** (at: Point, text: string) → an edit's id, or null when the page's text isn't editable now */
  start: 'preview-text:start',
  /** (id: string, text: string | null): the text as typed, or null when nothing changed */
  end: 'preview-text:end',
} as const
/** The most text an edit in the preview carries either way. */
export const MAX_PREVIEW_TEXT = 4000
