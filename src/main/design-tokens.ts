import type { ThemeEdit, ThemeSnapshot } from '../shared/theme-tokens'
import { safeName } from '../shared/theme-tokens'
import type { Turn } from '../shared/types'
import {
  injectable,
  markersOf,
  modeExpression,
  modeKeptExpression,
  type PageTheme,
  pageModeOf,
  parsePageTheme,
  previewCss,
  previewExpression,
  READ_THEME,
  REMOVE_PREVIEW,
  snapshotFrom,
} from './theme-page'
import { locate, readCssFiles, writeThemeEdits } from './theme-source'

type KeptEdits = NonNullable<Turn['themeEdits']>

/** The chat Keep records its write in, as a turn of the user's own (ChatController). */
interface KeepChat {
  writeThemeEdits: (edits: KeptEdits, write: () => Promise<boolean>) => Promise<boolean>
}

type Kept = { ok: true } | { ok: false; blocked: string; reason: string }

const CLOSED: Kept = { ok: false, blocked: '', reason: 'The project was closed.' }

/** How long the app has to put its own mode back after Gui shows one. */
const MODE_CHECK_MS = 300

interface Deps {
  command: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
  root: string
  /** False once the opening is closed or replaced */
  live: () => boolean
}

/**
 * One opening's theme: the latest read of the preview's CSS variables, the edits previewed
 * in it (nothing is written to disk here), and the mode the popover shows.
 */
export class DesignTokens {
  private snapshot: ThemeSnapshot | null = null
  private readonly edits = new Map<string, ThemeEdit>()
  private shown: string | null = null
  private emulating = false
  private isOpen = false
  /** Bumped per read, so an older read can't land over a newer one. */
  private reads = 0
  private modeCheck: ReturnType<typeof setTimeout> | null = null
  private readonly listeners = new Set<(snapshot: ThemeSnapshot) => void>()
  private disposed = false

  constructor(private readonly deps: Deps) {}

  latest() {
    return this.snapshot
  }

  pending() {
    return [...this.edits.values()]
  }

  get open() {
    return this.isOpen
  }

  /** Set by the popover. Closing it drops the edits and puts the page's own mode back. */
  set open(value: boolean) {
    if (value === this.isOpen) return
    this.isOpen = value
    if (value) return
    void this.cancel().catch(() => undefined)
    void this.showMode(null).catch(() => undefined)
  }

  onChange(cb: (snapshot: ThemeSnapshot) => void) {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /** After each preview load: reads the theme again, and while open puts the preview back. */
  async loaded() {
    const read = ++this.reads
    const current = () => this.live() && read === this.reads
    const page = parsePageTheme(await this.evaluate(READ_THEME))
    if (!current() || !page) return
    const resolved = (modes: ThemeSnapshot['modes']) => ({
      [pageModeOf(page.state, modes)]: page.computed,
    })
    const hsl = new Set(page.hsl)
    const unlocked = snapshotFrom(page.declarations, {}, page.uses, hsl, new Map())
    const locks = await this.locks(page, unlocked)
    if (!current()) return
    const snapshot = snapshotFrom(
      page.declarations,
      resolved(unlocked.modes),
      page.uses,
      hsl,
      locks,
    )
    snapshot.appSetsMode = (this.snapshot?.appSetsMode ?? []).filter((id) =>
      snapshot.modes.some((mode) => mode.id === id),
    )
    this.snapshot = snapshot
    this.emit()
    if (!this.isOpen) return
    await this.applyPreview()
    if (this.shown !== null && current()) await this.showMode(this.shown)
  }

  /** Shows `edit` in the preview with the other pending edits. Throws on an unsafe edit. */
  async preview(edit: ThemeEdit) {
    if (!safeName(edit.name) || !injectable(edit.value)) {
      throw new Error('Not a value Gui can preview')
    }
    if (!this.snapshot?.modes.some((mode) => mode.id === edit.mode)) {
      throw new Error('Unknown theme mode')
    }
    const { name, mode, value } = edit
    this.edits.set(`${mode} ${name}`, { name, mode, value })
    await this.applyPreview()
  }

  /** Drops every pending edit and takes the preview style off the page. */
  async cancel() {
    this.edits.clear()
    await this.evaluate(REMOVE_PREVIEW)
  }

  /**
   * Writes every pending edit into the project's CSS, or none, as one undoable turn of
   * `chat`. The kept edits' preview stays until the theme is read again over the new values
   * (`loaded`, after the chat's `filesChanged`).
   */
  async keep(chat: KeepChat): Promise<Kept> {
    const snapshot = this.snapshot
    const edits = this.pending()
    if (!snapshot || !edits.length || !this.live()) return { ok: true }
    const { files } = await readCssFiles(this.deps.root)
    if (!this.live()) return CLOSED
    const kept: KeptEdits = []
    for (const edit of edits) {
      const mode = snapshot.modes.find((m) => m.id === edit.mode)
      const found = mode ? locate(files, edit.name, mode) : null
      if (!found?.ok) {
        return { ok: false, blocked: edit.name, reason: found?.reason ?? 'Unknown theme mode' }
      }
      const variable = snapshot.variables.find((v) => v.name === edit.name)
      // A mode override Keep adds had no value of its own: what it inherited.
      const before = variable?.values[edit.mode] ?? variable?.resolved[edit.mode] ?? ''
      kept.push({ name: edit.name, mode: edit.mode, before, after: edit.value, file: found.file })
    }
    let refused: Kept | null = null
    const write = async () => {
      // The chat outlives the opening: a closed one's edits are never written.
      if (!this.live()) return false
      const result = await writeThemeEdits(this.deps.root, edits, snapshot.modes)
      if (!result.ok) refused = result
      return result.ok
    }
    const wrote = await chat.writeThemeEdits(kept, write).catch((error: unknown) => {
      console.error('[gui] failed to keep theme changes', error)
      return null
    })
    if (refused) return refused
    if (!wrote && !this.live()) return CLOSED
    if (wrote === null) {
      return { ok: false, blocked: '', reason: "Gui couldn't write the project's CSS" }
    }
    if (!wrote) {
      return {
        ok: false,
        blocked: '',
        reason: 'The agent is working. Keep again when it finishes.',
      }
    }
    // An edit previewed while Keep wrote stays pending.
    for (const edit of edits) {
      const key = `${edit.mode} ${edit.name}`
      if (this.edits.get(key)?.value === edit.value) this.edits.delete(key)
    }
    return { ok: true }
  }

  /** Shows the preview in mode `id`, the way the project's own toggle would; null: its own. */
  async showMode(id: string | null) {
    const mode = id === null ? null : this.snapshot?.modes.find((m) => m.id === id)
    if (mode === undefined) throw new Error('Unknown theme mode')
    if (mode && !this.live()) return
    this.shown = id
    if (this.modeCheck) clearTimeout(this.modeCheck)
    this.modeCheck = null
    // Emulation is the tab's, not the page's: it's reset first, even for a closed opening.
    if (!mode) await this.stopEmulating()
    else if (this.snapshot?.modes.some((m) => m.how.kind === 'media')) {
      const value = mode.how.kind === 'media' ? 'dark' : 'light'
      this.emulating = true
      await this.deps.command('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value }],
      })
    }
    await this.evaluate(modeExpression(mode ? markersOf(mode) : null))
    if (!mode || mode.how.kind === 'media' || !this.live()) return
    // The app may put its own mode back (next-themes does on load): Gui doesn't fight it.
    this.modeCheck = setTimeout(() => {
      this.modeCheck = null
      void this.evaluate(modeKeptExpression(markersOf(mode)))
        .then((kept) => {
          const snapshot = this.snapshot
          if (kept !== false || !snapshot || !this.live() || this.shown !== id) return
          if (snapshot.appSetsMode.includes(mode.id)) return
          this.snapshot = { ...snapshot, appSetsMode: [...snapshot.appSetsMode, mode.id] }
          this.emit()
        })
        .catch(() => undefined)
    }, MODE_CHECK_MS)
  }

  dispose() {
    this.disposed = true
    if (this.modeCheck) clearTimeout(this.modeCheck)
    this.modeCheck = null
    this.listeners.clear()
    void this.stopEmulating().catch(() => undefined)
  }

  private async stopEmulating() {
    if (!this.emulating) return
    this.emulating = false
    await this.deps.command('Emulation.setEmulatedMedia', { features: [] })
  }

  private live() {
    return !this.disposed && this.deps.live()
  }

  private emit() {
    const snapshot = this.snapshot
    if (snapshot) for (const cb of this.listeners) cb(snapshot)
  }

  private async applyPreview() {
    const snapshot = this.snapshot
    const css = snapshot ? previewCss(this.pending(), snapshot) : ''
    await this.evaluate(css ? previewExpression(css) : REMOVE_PREVIEW)
  }

  /** Why Keep couldn't write each variable, from the project's CSS on disk. */
  private async locks(page: PageTheme, snapshot: ThemeSnapshot) {
    const locks = new Map<string, string>()
    const read = await readCssFiles(this.deps.root).catch(() => null)
    const dependency = new Set<string>()
    const own = new Set<string>()
    for (const d of page.declarations) {
      ;(d.sheet?.includes('/node_modules/') ? dependency : own).add(d.name)
    }
    for (const variable of snapshot.variables) {
      const reason =
        dependency.has(variable.name) && !own.has(variable.name)
          ? 'Defined in node_modules'
          : !read
            ? "Gui couldn't read the project's CSS"
            : read.incomplete
      if (reason) {
        locks.set(variable.name, reason)
        continue
      }
      for (const mode of snapshot.modes) {
        if (variable.values[mode.id] === null) continue
        const found = locate(read?.files ?? [], variable.name, mode)
        if (!found.ok) {
          locks.set(variable.name, found.reason)
          break
        }
      }
    }
    return locks
  }

  private async evaluate(expression: string) {
    const { result, exceptionDetails } = await this.deps.command<{
      result?: { value?: unknown }
      exceptionDetails?: unknown
    }>('Runtime.evaluate', { expression, returnByValue: true })
    if (exceptionDetails) throw new Error('The page threw')
    return result?.value
  }
}
