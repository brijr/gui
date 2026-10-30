import { SPRINGS, Spring } from '../../../shared/motion'
import { CHAT_FORMS, type ChatForm, type PanelCorner } from '../../../shared/types'
import { animateFade, animateSpring, motionMs, prefersReducedMotion } from '../lib/motion'

/*
 * The floating chat moving between its forms (the panel, the pill, the bubble), all drawn at
 * the view's anchored corner. Each form has a presence on a spring, 1 shown and 0 gone: the
 * one going away shrinks toward the corner and fades while the next grows out of it, so the
 * panel reads as becoming the bubble and back. Interrupted, every form turns around from where
 * it is, at the speed it was going. With reduced motion they change immediately in place.
 */

/** How small the pill and the bubble are as they appear or go: grown out of the corner. */
const SMALL_SCALE: Record<Exclude<ChatForm, 'panel'>, number> = { pill: 0.8, bubble: 0.5 }
/**
 * How small the panel gets going into (or coming out of) each: about the smaller form's share
 * of a panel's width, so it shrinks into it rather than just fading. Fixed rather than measured,
 * since the panel's layer is the smaller form's size while the view is, and it's out of sight
 * well before it gets this small.
 */
const PANEL_SCALE: Record<Exclude<ChatForm, 'panel'>, number> = { pill: 0.6, bubble: 0.15 }
/** Presence is close enough to 0 or 1 to stop at this. */
const PRECISION = 0.002

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/**
 * Opacity for a presence: the panel stays solid until it's well on its way, and the smaller
 * forms only show once the panel has mostly gone, so the two read as one thing changing. A
 * plain cross-fade with reduced motion.
 */
function opacityOf(form: ChatForm, presence: number, reduced: boolean) {
  if (reduced) return clamp01(presence)
  return form === 'panel' ? clamp01((presence - 0.15) / 0.55) : clamp01((presence - 0.35) / 0.5)
}

interface MorphOptions {
  /** The element drawing `form`, while it's mounted */
  element: (form: ChatForm) => HTMLElement | null
  /**
   * Every form but `form` has gone from sight, so they can unmount and the view can shrink to
   * `form`; `form` itself may still be settling, inside its own box.
   */
  gone: (form: ChatForm) => void
}

export class Morph {
  private readonly presence: Record<ChatForm, Spring>
  private readonly stops: Partial<Record<ChatForm, () => void>> = {}
  private form: ChatForm
  private reduced = false
  /** Where each form shrinks to and grows from, kept for the length of its animation. */
  private readonly origins: Partial<Record<ChatForm, string>> = {}
  /** The smaller form the panel shrinks into or grows out of, kept the same way. */
  private panelAway: Exclude<ChatForm, 'panel'> = 'bubble'
  private readonly options: MorphOptions

  constructor(form: ChatForm, options: MorphOptions) {
    this.form = form
    this.options = options
    const spring = (shown: boolean) =>
      new Spring(shown ? 1 : 0, { config: { ...SPRINGS.default, response: 0.22 } })
    this.presence = {
      panel: spring(form === 'panel'),
      pill: spring(form === 'pill'),
      bubble: spring(form === 'bubble'),
    }
  }

  /** Shows `form`, morphing from whatever is drawn now; `corner` is where they're anchored. */
  to(form: ChatForm, corner: PanelCorner) {
    this.form = form
    this.reduced = prefersReducedMotion()
    for (const each of CHAT_FORMS) {
      const spring = this.presence[each]
      const target = each === form ? 1 : 0
      const running = this.stops[each] !== undefined
      if (!running && spring.value === target) {
        this.apply(each)
        continue
      }
      if (!running) {
        this.origins[each] = `${corner.x} ${corner.y}`
        if (each === 'panel' && form !== 'panel') this.panelAway = form
      }
      spring.retarget(target)
      // Before the first frame, so a form that just mounted doesn't flash in full.
      this.apply(each)
      // A fade can't turn around midway like a spring: it starts again from where it is.
      if (running && this.reduced) {
        this.stops[each]?.()
        delete this.stops[each]
      }
      if (this.stops[each] === undefined) this.start(each)
    }
    this.checkGone()
  }

  /** Stops where everything is (the chat unmounted). */
  stop() {
    for (const each of CHAT_FORMS) {
      this.stops[each]?.()
      delete this.stops[each]
    }
  }

  private start(form: ChatForm) {
    const spring = this.presence[form]
    const rest = () => {
      delete this.stops[form]
      this.apply(form)
      this.checkGone()
    }
    // A form on its way out is done once it can't be seen: the rest of its spring would only
    // keep the view large.
    const update = () => {
      this.apply(form)
      const leaving = form !== this.form
      if (!leaving || opacityOf(form, spring.value, this.reduced) > 0) return
      this.stops[form]?.()
      spring.retarget(0)
      spring.finish()
      rest()
    }
    const stop = this.reduced
      ? animateFade(
          spring.value,
          spring.target,
          motionMs('--motion-fade') * Math.abs(spring.target - spring.value),
          {
            update: (value) => {
              spring.value = value
              this.apply(form)
            },
            rest: () => {
              spring.finish()
              rest()
            },
          },
        )
      : animateSpring(spring, { precision: PRECISION, update, rest })
    // Null when it landed at once (a hidden page): nothing is running.
    if (stop) this.stops[form] = stop
  }

  /** Tells the chat once every form but the current one is out of sight. */
  private checkGone() {
    const gone = CHAT_FORMS.every(
      (each) => each === this.form || (!this.stops[each] && this.presence[each].value === 0),
    )
    if (gone) this.options.gone(this.form)
  }

  /** Writes a form's presence to its element: scale toward its corner, and opacity. */
  private apply(form: ChatForm) {
    const el = this.options.element(form)
    if (!el) return
    const presence = this.presence[form].value
    const resting = presence === (form === this.form ? 1 : 0) && !this.stops[form]
    el.style.opacity =
      resting && presence === 1 ? '' : String(opacityOf(form, presence, this.reduced))
    el.style.transformOrigin = this.origins[form] ?? ''
    // Shown and at rest, nothing is scaled. Gone, it stays shrunk into its corner until it
    // unmounts, so it's never full size for a frame, even unseen.
    if ((resting && presence === 1) || this.reduced) {
      el.style.transform = ''
      return
    }
    const from = form === 'panel' ? PANEL_SCALE[this.panelAway] : SMALL_SCALE[form]
    el.style.transform = `scale(${from + (1 - from) * presence})`
  }
}
