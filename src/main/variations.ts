import type { Turn, Variant, VariationAction } from '../shared/types'
import type { ChatController } from './chat'
import type { Inspector } from './inspector'
import type { Bar } from './picker'

/**
 * Variations (docs/variations.md): versions of one element the agent wrote as real code behind
 * a small switch, which Gui flips in the preview. Gui owns which version shows; the page keeps
 * it in localStorage, so it survives hot reload and reloads. A set belongs to the project
 * opening and to the chat turn that made it.
 */

/** Versions the agent can show at once, besides the original. */
export const MAX_VARIANTS = 15
/** Set and version ids: plain, so they're safe in a storage key and an attribute selector. */
export const VARIATION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
/** The code as it was: always a version, first, so ‹ › compare against it. */
export const ORIGINAL = 'original'

const storageKey = (set: string) => `gui:variation:${set}`
/** The root of whichever version renders carries the set's id, and its own (`data-gui-variant`). */
export const elementOf = (set: string) => `[data-gui-variation="${set}"]`

/** How long the page has to show a version the agent asked for. */
const SHOW_TIMEOUT_MS = 3000
const SHOW_POLL_MS = 100
/** How long a flip waits for the new version to render before it scrolls to it, or doesn't. */
const REVEAL_WAIT_MS = 1000
/** The longest a smooth scroll to it is waited for. */
const SCROLL_END_MS = 1000
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** What preview_variations asks: the set's id, its new versions in order, and one to show. */
export interface VariationsInput {
  set: string
  variants: Variant[]
  show?: string
}

interface Shown {
  set: string
  /** The original first, then the agent's, in its order */
  variants: Variant[]
  index: number
  /** The turn that made the set, which discarding undoes */
  turnId: string
  chat: ChatController
  generation: number
  confirm: number | null
  busy: boolean
  error: string | null
}

export interface VariationsDeps {
  inspector: Inspector
  chat: () => ChatController | null
  /** The project opening's (ProjectResources) */
  generation: () => number
  stillCurrent: (generation: number) => boolean
  /** The preview shows the user's app, not a website */
  onApp: () => boolean
  /** Shows the bar (null: takes it away) */
  setBar: (bar: Bar | null) => void
  /** Sends the agent a message from the user, as the board's starters do */
  send: (text: string) => Promise<boolean>
}

export class Variations {
  private shown: Shown | null = null

  constructor(private readonly deps: VariationsDeps) {}

  /** preview_variations: shows `show` (by default the first new version); what the agent is told. */
  async show({ set, variants, show }: VariationsInput): Promise<string> {
    const chat = this.deps.chat()
    const turnId = chat?.workingTurnId
    if (!chat || !turnId) throw new Error('Show variations while you work on a message.')
    if (!this.deps.onApp())
      throw new Error(
        "The preview shows a website: go back to the user's app first (preview_navigate with /).",
      )
    const ids = variants.map((variant) => variant.id)
    if (ids.includes(ORIGINAL))
      throw new Error(
        `"${ORIGINAL}" is Gui's own version, the code as it was; leave it out of \`variants\`.`,
      )
    if (new Set(ids).size !== ids.length) throw new Error('Give every version its own id.')
    const all = [{ id: ORIGINAL, name: 'Original' }, ...variants]
    const index = show === undefined ? 1 : all.findIndex((variant) => variant.id === show)
    if (index < 0) throw new Error(`\`show\` is none of the versions: ${show}`)

    const generation = this.deps.generation()
    const same = this.shown?.set === set && this.shown.chat === chat ? this.shown : null
    const shown: Shown = {
      set,
      variants: all,
      index,
      // Shown again later on (fixed, or flipped to check it): it's still the first turn's set,
      // and discarding it undoes from there.
      turnId: same?.turnId ?? turnId,
      chat,
      generation,
      confirm: null,
      busy: false,
      error: null,
    }
    this.shown = shown
    this.render()
    const variant = all[index]
    await this.write(set, variant.id)
    const showing = await this.waitFor(set, variant.id)
    if (this.shown !== shown) return 'The user closed the versions meanwhile.'
    if (showing === null)
      throw new Error(
        `The bar is up, but nothing in the page matches ${elementOf(set)}. Put data-gui-variation="${set}" and data-gui-variant="<version id>" on the root element of every version, the original too, then call this again.`,
      )
    if (showing !== variant.id) {
      const other = all.find((v) => v.id === showing)
      throw new Error(
        `Gui switched to "${variant.id}", but the page shows ${other ? `"${other.id}"` : 'another version'}. Make the switch read localStorage and re-render on the gui:variation event, as this tool describes, then call this again.`,
      )
    }
    await this.reveal(set, variant.id)
    return `The preview shows ${this.label(shown, index)}, scrolled into view, with Gui's bar at the preview's bottom-left. The user flips through the versions there, then keeps one (Use this, which sends you a message) or discards them all (which undoes this message).`
  }

  /** What the user did in the bar. */
  async act(action: VariationAction) {
    const shown = this.current()
    if (!shown || shown.busy) return
    if (action === 'previous' || action === 'next') {
      const count = shown.variants.length
      shown.index = (shown.index + (action === 'next' ? 1 : -1) + count) % count
      shown.confirm = null
      shown.error = null
      this.render()
      const variant = shown.variants[shown.index].id
      await this.write(shown.set, variant)
      await this.reveal(shown.set, variant)
    } else if (action === 'use') {
      const sent = await this.deps.send(keepPrompt(shown.set, shown.variants[shown.index]))
      if (this.shown !== shown) return
      if (sent) this.clear()
      else this.fail(shown, "Couldn't send that to the agent.")
    } else if (action === 'cancel') {
      shown.confirm = null
      this.render()
    } else {
      // Later messages are undone with it: asked first, the way Undo to here asks.
      const later = laterChanges(shown.chat.snapshot().turns, shown.turnId)
      if (action === 'discard' && later > 0) {
        shown.confirm = later
        shown.error = null
        return this.render()
      }
      await this.discard(shown)
    }
  }

  /**
   * Undoes the turn that made the set (and any later ones), with the chat's own Undo: it asks
   * before overwriting edits made outside Gui, and leaves the files alone when it can't. Once
   * that turn is marked undone, `onTurn` takes the bar away.
   */
  private async discard(shown: Shown) {
    shown.busy = true
    shown.confirm = null
    shown.error = null
    this.render()
    try {
      await shown.chat.restoreTurn(shown.turnId)
    } catch (error) {
      if (this.shown === shown) shown.error = error instanceof Error ? error.message : String(error)
    } finally {
      if (this.shown === shown) {
        shown.busy = false
        this.render()
      }
    }
  }

  /** A turn changed: the set goes once the turn that made it is undone, with its code. */
  onTurn(turn: Turn) {
    const shown = this.shown
    if (!shown || shown.turnId !== turn.id || !turn.reverted) return
    this.clear()
    void this.write(shown.set, null)
  }

  /** The chat was reset, or the project closed: the set goes with it. */
  clear() {
    if (!this.shown) return
    this.shown = null
    this.deps.setBar(null)
  }

  /** The set, while it's still the open project's and chat's. */
  private current() {
    const shown = this.shown
    if (shown && (!this.deps.stillCurrent(shown.generation) || this.deps.chat() !== shown.chat)) {
      this.clear()
      return null
    }
    return shown
  }

  private fail(shown: Shown, error: string) {
    shown.error = error
    this.render()
  }

  private label(shown: Shown, index: number) {
    if (index === 0) return 'Original'
    return `${index} of ${shown.variants.length - 1} · ${shown.variants[index].name}`
  }

  private render() {
    const shown = this.shown
    if (!shown) return this.deps.setBar(null)
    const { index, confirm, busy, error } = shown
    this.deps.setBar({
      labels: shown.variants.map((_variant, i) => this.label(shown, i)),
      index,
      confirm,
      busy,
      error,
    })
  }

  /**
   * Flips the page's switch, in the page's own world: the version to show in localStorage
   * (null: forgotten), and a `gui:variation` event so the switch renders it now.
   */
  private async write(set: string, variant: string | null) {
    if (!this.deps.onApp()) return
    const args = JSON.stringify({ key: storageKey(set), set, variant })
    const expression = `(({ key, set, variant }) => {
      try { variant === null ? localStorage.removeItem(key) : localStorage.setItem(key, variant) } catch {}
      if (variant !== null) dispatchEvent(new CustomEvent('gui:variation', { detail: { set, variant } }))
    })(${args})`
    await this.deps.inspector.command('Runtime.evaluate', { expression }).catch(() => undefined)
  }

  /**
   * Scrolls the page to the set's element once it renders `variant` (a short wait), unless it's
   * in full view already: centered, clear of the bar at the bottom; a version taller than the
   * page shows its top, and stays put while it fills the page. Smooth unless the page prefers
   * reduced motion, and done once the scroll ends, so a screenshot after it sees the page at
   * rest. Scrolling never moves the focus.
   */
  private async reveal(set: string, variant: string) {
    if (!this.deps.onApp()) return
    const args = JSON.stringify({
      selector: `${elementOf(set)}[data-gui-variant="${variant}"]`,
      wait: REVEAL_WAIT_MS,
      end: SCROLL_END_MS,
    })
    const expression = `(async ({ selector, wait, end }) => {
      const until = performance.now() + wait
      let element = document.querySelector(selector)
      while (!element && performance.now() < until) {
        await new Promise((next) => { requestAnimationFrame(next); setTimeout(next, 50) })
        element = document.querySelector(selector)
      }
      if (!element) return
      const { top, bottom, height } = element.getBoundingClientRect()
      const tall = height > innerHeight
      if (tall ? top <= 0 && bottom >= innerHeight : top >= 0 && bottom <= innerHeight) return
      const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches
      element.scrollIntoView({ block: tall ? 'start' : 'center', inline: 'nearest', behavior: smooth ? 'smooth' : 'instant' })
      if (smooth) await new Promise((done) => { addEventListener('scrollend', done, { once: true, capture: true }); setTimeout(done, end) })
    })(${args})`
    await this.deps.inspector
      .command('Runtime.evaluate', { expression, awaitPromise: true })
      .catch(() => undefined)
  }

  /**
   * Which version the page's element says it shows, once it's `variant` or the wait is over;
   * null when there's no element. Page data: only ever compared, never passed on.
   */
  private async waitFor(set: string, variant: string) {
    const expression = `document.querySelector(${JSON.stringify(elementOf(set))})?.getAttribute('data-gui-variant') ?? null`
    let showing: string | null = null
    for (let waited = 0; waited <= SHOW_TIMEOUT_MS; waited += SHOW_POLL_MS) {
      const { result } = await this.deps.inspector
        .command<{ result: { value?: unknown } }>('Runtime.evaluate', {
          expression,
          returnByValue: true,
        })
        .catch(() => ({ result: { value: null } }))
      showing = typeof result.value === 'string' ? result.value : null
      if (showing === variant) return showing
      await sleep(SHOW_POLL_MS)
    }
    return showing
  }
}

/** Later messages that changed files, which undoing `turnId` undoes too (as Undo to here counts). */
function laterChanges(turns: Turn[], turnId: string) {
  const at = turns.findIndex((turn) => turn.id === turnId)
  if (at < 0) return 0
  return turns
    .slice(at + 1)
    .filter((turn) => !turn.reverted && (!!turn.changes?.length || !!turn.changesUnknown)).length
}

/** What Use this asks the agent. */
function keepPrompt(set: string, variant: Variant) {
  const which = variant.id === ORIGINAL ? 'the original' : `"${variant.name}" (\`${variant.id}\`)`
  return `Keep ${which} of the "${set}" variations as the real code. Remove the other versions and Gui's switch (its localStorage reading, event listener and data-gui-variation attributes), so nothing of the set is left.`
}
