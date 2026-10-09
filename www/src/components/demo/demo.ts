import { svg } from './icons'

// "Try it now" (Demo.astro). The page itself goes into the demo: it is fixed in place, scrolled in
// its own box, and scaled into the preview area of a Gui window, so what the visitor sees shrink
// is the real page and what the agent changes is the real headline. A scripted session plays
// first; then the visitor can select any element and try the suggested changes. Closing the demo
// undoes every change and puts the page back where it was.

type Point = { x: number; y: number }
type Rect = { x: number; y: number; w: number; h: number }
type Styled = HTMLElement | SVGElement

interface Geometry {
  /** The page's scale in the window */
  s: number
  /** The window, in the viewport */
  win: Rect
  /** The preview area of the window, in the viewport */
  area: Rect
  /** The scaled page, in the viewport */
  page: Rect
  /** The chat, in the window */
  chat: Rect
  /** The toolbar's height */
  tb: number
  narrow: boolean
}

interface Change {
  plus: number
  minus: number
  applied: boolean
  apply(): void
  revert(): void
}

interface Turn {
  prompt: string
  target: Element | null
  reply: string
  change?: Change
  /** Show the selected words before and after the change */
  compare?: boolean
}

type State = 'closed' | 'opening' | 'intro' | 'idle' | 'working' | 'closing'

// The shrink: quick to start, long to settle, like a window going into place.
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'
const EASE_OUT = 'cubic-bezier(0.2, 0, 0, 1)'
const EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)'
const EASE_MOVE = 'cubic-bezier(0.45, 0, 0.15, 1)'
const EASE_DRAW = 'cubic-bezier(0.65, 0, 0.35, 1)'
const FILE = 'src/pages/index.astro'
const NARROW = 760
/** The desktop's menu bar, over the wallpaper (wide screens only) */
const MENU_BAR = 26

const PROMPT = 'Make this semi-bold.'
const REPLY =
  'I changed the weight of “real app” from 250 to 450, a semi-bold for this light headline. The rest of the headline stays light, so the two words stand out.'
/** The weight the scripted change gives the words; the headline is 250 */
const BOLD = '450'
const FREE_REPLY =
  'This demo has no agent, so it can only make the changes in the suggestions. In Gui, your own agent reads your code and makes the change that you write.'

class Cancelled extends Error {}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/** When the animations end, or when they should have: a hidden tab runs no frames, so a
    switch to another tab would otherwise leave the demo half open or half closed. */
function settled(animations: Animation[]) {
  const longest = Math.max(
    ...animations.map((a) => {
      const timing = a.effect?.getComputedTiming()
      return Number(timing?.endTime ?? 0)
    }),
  )
  return Promise.race([
    Promise.all(animations.map((a) => a.finished)).then(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, longest + 100)),
  ])
}
const at = (p: Point) => `translate(${p.x}px, ${p.y}px)`
const center = (r: DOMRect): Point => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
const tagOf = (el: Element) => el.tagName.toLowerCase()

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

function excerpt(el: Element) {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 28 ? `${text.slice(0, 27)}…` : text
}

export function setup() {
  const root = document.querySelector<HTMLElement>('[data-demo]')
  const page = document.querySelector<HTMLElement>('[data-page]')
  const openers = document.querySelectorAll<HTMLElement>('[data-demo-open]')
  if (root && page && openers.length > 0) demo(root, page, openers)
}

function demo(root: HTMLElement, page: HTMLElement, openers: NodeListOf<HTMLElement>) {
  const q = <T extends Element = HTMLElement>(selector: string) => root.querySelector(selector) as T
  const desk = q('[data-desk]')
  const wallpaper = q<HTMLImageElement>('[data-wallpaper]')
  const clock = q('[data-clock]')
  const win = q('[data-window]')
  const toolbar = q('[data-toolbar]')
  const chat = q('[data-chat]')
  const edge = q('[data-edge]')
  const cursor = q('[data-cursor]')
  const cursorArrow = q<SVGElement>('[data-cursor] svg')
  const ripple = q('[data-cursor] .ripple')
  const hoverMark = q('[data-hover]')
  const selectedMark = q('[data-selected]')
  const transcript = q('[data-transcript]')
  const empty = q('[data-empty]')
  const suggest = q('[data-suggest]')
  const hint = q('[data-suggest-hint]')
  const form = q<HTMLFormElement>('[data-composer]')
  const chips = q('[data-chips]')
  const input = q<HTMLTextAreaElement>('[data-input]')
  const send = q<HTMLButtonElement>('[data-send]')
  const toolbarSelect = q<HTMLButtonElement>('[data-toolbar] [data-select]')
  const closeButton = q<HTMLButtonElement>('.done')
  const selectButtons = root.querySelectorAll<HTMLButtonElement>('[data-select]')
  const suggestions = root.querySelectorAll<HTMLButtonElement>('[data-suggestion]')
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  const moving = [page, desk, win, toolbar, chat, edge]

  let state: State = 'closed'
  let geo: Geometry
  /** Bumped to cancel whatever script is running */
  let run = 0
  let picking = false
  let hovered: Element | null = null
  let selected: Element | null = null
  let cursorAt: Point = { x: 0, y: 0 }
  let opener: HTMLElement | null = null
  let frame = 0
  let resizing = 0
  const applied: Change[] = []
  /** The style attribute of each element the demo changed, from before the demo */
  const originals = new Map<Styled, string | null>()

  // Timing

  const sleep = (ms: number, id: number) =>
    new Promise<void>((resolve, reject) => {
      setTimeout(() => (id === run ? resolve() : reject(new Cancelled())), ms)
    })

  function check(id: number) {
    if (id !== run) throw new Cancelled()
  }

  function script(fn: (id: number) => Promise<void>) {
    const id = run
    fn(id).catch((error) => {
      if (!(error instanceof Cancelled)) throw error
    })
  }

  function setState(next: State) {
    state = next
    root.dataset.state = next
    sync()
  }

  // Geometry: where the window goes, and how far the page shrinks to fill its preview.

  function measure(): Geometry {
    const vw = page.offsetWidth
    const vh = innerHeight
    const W = innerWidth
    const H = innerHeight
    if (W >= NARROW) {
      // The preview keeps the viewport's shape, so the page shrinks as one picture and nothing
      // in it moves. The chat goes to its left; the window is centered on the desktop, under
      // the menu bar.
      const m = clamp(Math.min(W, H) * 0.045, 16, 44)
      const tb = 44
      const chatW = Math.round(clamp(W * 0.25, 300, 360))
      const s0 = Math.min((W - 2 * m - chatW) / vw, (H - MENU_BAR - 2 * m - tb) / vh, 0.78)
      const pw = Math.round(vw * s0)
      const s = pw / vw
      const ph = vh * s
      const win = {
        x: Math.round((W - pw - chatW) / 2),
        y: Math.round(MENU_BAR + (H - MENU_BAR - ph - tb) / 2),
        w: pw + chatW,
        h: ph + tb,
      }
      const area = { x: win.x + chatW, y: win.y + tb, w: pw, h: ph }
      return {
        s,
        win,
        area,
        page: area,
        chat: { x: 0, y: tb, w: chatW, h: ph },
        tb,
        narrow: false,
      }
    }
    // Phones: the chat goes under the preview, and the page sits in it like a device frame.
    const m = 8
    const tb = 40
    const win = { x: m, y: m, w: W - 2 * m, h: H - 2 * m }
    const chatH = Math.round(clamp(win.h * 0.4, 240, 380))
    const area = { x: win.x, y: win.y + tb, w: win.w, h: win.h - tb - chatH }
    const s = Math.min((area.w - 24) / vw, (area.h - 24) / vh)
    const pageRect = {
      x: area.x + (area.w - vw * s) / 2,
      y: area.y + (area.h - vh * s) / 2,
      w: vw * s,
      h: vh * s,
    }
    return {
      s,
      win,
      area,
      page: pageRect,
      chat: { x: 0, y: tb + area.h, w: win.w, h: chatH },
      tb,
      narrow: true,
    }
  }

  function layout() {
    page.style.width = `${document.documentElement.clientWidth}px`
    page.style.height = `${innerHeight}px`
    geo = measure()
    const set = (name: string, value: number) => root.style.setProperty(name, `${value}px`)
    for (const [key, r] of [
      ['win', geo.win],
      ['area', geo.area],
      ['chat', geo.chat],
    ] as const) {
      set(`--${key}-x`, r.x)
      set(`--${key}-y`, r.y)
      set(`--${key}-w`, r.w)
      set(`--${key}-h`, r.h)
    }
    set('--tb', geo.tb)
    root.toggleAttribute('data-narrow', geo.narrow)
    // In page pixels, so they come out right once the page is scaled.
    const px = (n: number) => `${n / geo.s}px`
    page.style.setProperty('--demo-page-radius', geo.narrow ? px(8) : `0 0 ${px(12)} 0`)
    page.style.setProperty(
      '--demo-page-ring',
      geo.narrow ? `0 0 0 ${px(1)} var(--rule), 0 ${px(6)} ${px(20)} rgb(0 0 0 / 0.1)` : 'none',
    )
  }

  const shrunk = () => `translate(${geo.page.x}px, ${geo.page.y}px) scale(${geo.s})`
  const full = 'translate(0px, 0px) scale(1)'

  // Open and close

  function open(from: HTMLElement) {
    if (state !== 'closed') return
    opener = from
    loadWallpaper()
    clock.textContent = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date())
    const top = scrollY
    root.hidden = false
    page.classList.add('is-demo')
    layout()
    page.scrollTop = top
    document.documentElement.classList.add('demo-open')
    resetChat()
    setState('opening')
    const id = ++run
    closeButton.focus({ preventScroll: true })
    track()

    const slide = geo.narrow ? 'translateY(24px)' : 'translateX(-24px)'
    const motion = reduce.matches
      ? [
          page.animate(
            [
              { opacity: 0, transform: shrunk() },
              { opacity: 1, transform: shrunk() },
            ],
            {
              duration: 200,
              fill: 'both',
            },
          ),
          ...[desk, win, toolbar, chat, edge].map((el) =>
            el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'both' }),
          ),
        ]
      : [
          page.animate([{ transform: full }, { transform: shrunk() }], {
            duration: 760,
            easing: EASE,
            fill: 'both',
          }),
          desk.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 500,
            easing: EASE_OUT,
            fill: 'both',
          }),
          win.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 380,
            delay: 120,
            easing: EASE_OUT,
            fill: 'both',
          }),
          toolbar.animate(
            [
              { opacity: 0, transform: 'translateY(-10px)' },
              { opacity: 1, transform: 'none' },
            ],
            { duration: 480, delay: 200, easing: EASE, fill: 'both' },
          ),
          chat.animate(
            [
              { opacity: 0, transform: slide },
              { opacity: 1, transform: 'none' },
            ],
            { duration: 540, delay: 240, easing: EASE, fill: 'both' },
          ),
          edge.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 300,
            delay: 440,
            easing: EASE_OUT,
            fill: 'both',
          }),
        ]
    settled(motion).then(
      () => {
        if (id !== run) return
        page.style.transform = shrunk()
        for (const a of motion) a.cancel()
        setState('intro')
        script(intro)
      },
      () => {},
    )
  }

  function close() {
    if (state === 'closed' || state === 'closing') return
    run++
    setState('closing')
    setPicking(false)
    select(null)
    hideCursor()
    revertAll()

    // From wherever things are, so closing while it opens turns it around smoothly.
    const from = new Map(
      moving.map((el) => {
        const style = getComputedStyle(el)
        return [el, { transform: style.transform, opacity: Number(style.opacity) }]
      }),
    )
    for (const el of moving) for (const a of el.getAnimations()) a.cancel()
    const start = (el: HTMLElement) => from.get(el) ?? { transform: 'none', opacity: 1 }
    const out = (el: HTMLElement, to: Keyframe, options: KeyframeAnimationOptions) =>
      el.animate([start(el) as Keyframe, to], { fill: 'both', ...options })

    let shrinkBack: Animation
    if (reduce.matches) {
      for (const el of [desk, win, toolbar, chat, edge]) out(el, { opacity: 0 }, { duration: 150 })
      shrinkBack = out(page, { opacity: 0 }, { duration: 150 })
    } else {
      out(
        toolbar,
        { opacity: 0, transform: 'translateY(-6px)' },
        { duration: 180, easing: EASE_IN },
      )
      out(
        chat,
        { opacity: 0, transform: geo.narrow ? 'translateY(12px)' : 'translateX(-12px)' },
        { duration: 180, easing: EASE_IN },
      )
      out(edge, { opacity: 0 }, { duration: 160, easing: EASE_IN })
      out(win, { opacity: 0 }, { duration: 280, delay: 60, easing: EASE_IN })
      out(desk, { opacity: 0 }, { duration: 460, delay: 120, easing: EASE_OUT })
      shrinkBack = out(page, { transform: full }, { duration: 640, easing: EASE })
    }

    settled([shrinkBack]).then(() => {
      if (state !== 'closing') return
      const top = page.scrollTop
      cancelAnimationFrame(frame)
      for (const el of moving) for (const a of el.getAnimations()) a.cancel()
      page.classList.remove('is-demo', 'is-picking')
      for (const prop of [
        'width',
        'height',
        'transform',
        '--demo-page-radius',
        '--demo-page-ring',
      ]) {
        page.style.removeProperty(prop)
      }
      if (!page.getAttribute('style')) page.removeAttribute('style')
      document.documentElement.classList.remove('demo-open')
      scrollTo({ top, behavior: 'instant' })
      restoreOriginals()
      resetChat()
      root.hidden = true
      setState('closed')
      if (reduce.matches) {
        page.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 })
      }
      opener?.focus({ preventScroll: true })
    })
  }

  // Outlines over the preview, kept on their elements every frame (the page can scroll).

  function track() {
    place(hoverMark, hovered !== selected ? hovered : null)
    place(selectedMark, selected)
    frame = requestAnimationFrame(track)
  }

  function place(mark: HTMLElement, el: Element | null) {
    if (!el?.isConnected) {
      mark.classList.remove('is-on')
      return
    }
    const r = el.getBoundingClientRect()
    const y = r.top - geo.area.y
    mark.style.transform = `translate(${r.left - geo.area.x}px, ${y}px)`
    mark.style.width = `${r.width}px`
    mark.style.height = `${r.height}px`
    mark.classList.toggle('is-low', y < 26)
    mark.classList.add('is-on')
    const label = mark.firstElementChild as HTMLElement
    const text = `${tagOf(el)}|${Math.round(r.width / geo.s)} × ${Math.round(r.height / geo.s)}`
    if (label.dataset.text !== text) {
      label.dataset.text = text
      const [name, size] = text.split('|')
      label.replaceChildren(name, h('span', '', size))
    }
  }

  function glide(mark: HTMLElement) {
    if (reduce.matches || !mark.classList.contains('is-on')) return
    mark.classList.add('is-gliding')
    clearTimeout(Number(mark.dataset.glide))
    mark.dataset.glide = String(setTimeout(() => mark.classList.remove('is-gliding'), 180))
  }

  function setHover(el: Element | null) {
    if (el === hovered) return
    glide(hoverMark)
    hovered = el
  }

  function select(el: Element | null) {
    if (el && selected) glide(selectedMark)
    selected = el
    chips.replaceChildren(...(el ? [chip(el)] : []))
    sync()
  }

  function setPicking(on: boolean) {
    picking = on
    for (const button of selectButtons) button.setAttribute('aria-pressed', String(on))
    page.classList.toggle('is-picking', on)
    if (!on) setHover(null)
  }

  function pickable(target: EventTarget | null): Element | null {
    if (!(target instanceof Element)) return null
    const el = target.closest('svg') ?? target
    if (!page.contains(el) || el === page || el.tagName === 'MAIN') return null
    return el
  }

  // The fake cursor

  function showCursor(p: Point) {
    cursorAt = p
    cursor.style.transform = at(p)
    cursor.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' })
  }

  function hideCursor() {
    for (const a of cursor.getAnimations()) a.cancel()
    cursor.style.transform = at(cursorAt)
    if (state !== 'closed') {
      cursor.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' })
    }
  }

  async function moveTo(to: Point, id: number) {
    const from = cursorAt
    cursorAt = to
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    const duration = reduce.matches ? 0 : clamp(260 + distance * 0.55, 360, 950)
    const move = cursor.animate([{ transform: at(from) }, { transform: at(to) }], {
      duration,
      easing: EASE_MOVE,
    })
    cursor.style.transform = at(to)
    await move.finished.catch(() => {})
    check(id)
  }

  async function click(id: number) {
    if (!reduce.matches) {
      cursorArrow.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(0.82)' }, { transform: 'scale(1)' }],
        {
          duration: 220,
          easing: EASE_OUT,
        },
      )
      ripple.animate(
        [
          { opacity: 0.55, transform: 'scale(0.3)' },
          { opacity: 0, transform: 'scale(1.15)' },
        ],
        { duration: 460, easing: EASE_OUT },
      )
    }
    await sleep(170, id)
  }

  async function type(text: string, id: number, pace: number) {
    input.value = ''
    if (reduce.matches) {
      input.value = text
      sync()
      return
    }
    for (const ch of text) {
      input.value += ch
      input.scrollTop = input.scrollHeight
      sync()
      const pause = ch === ',' || ch === '.' ? 140 : ch === ' ' ? 20 : 0
      await sleep(pace * (0.6 + Math.random() * 0.9) + pause, id)
    }
  }

  // The scripted session

  async function intro(id: number) {
    const words = page.querySelector<HTMLElement>('[data-demo-target]')
    const headline = words?.closest('h1')
    if (!words || !headline) {
      ready()
      return
    }
    await sleep(320, id)

    // The headline has to be in the preview; the visitor may have scrolled before opening.
    const r = headline.getBoundingClientRect()
    if (r.top < geo.area.y + 8 || r.bottom > geo.area.y + geo.area.h - 8) {
      page.scrollTo({ top: 0, behavior: reduce.matches ? 'instant' : 'smooth' })
      await sleep(reduce.matches ? 60 : 700, id)
    }

    showCursor({ x: geo.area.x + geo.area.w * 0.6, y: geo.area.y + geo.area.h * 0.7 })
    await sleep(260, id)
    await moveTo(center(toolbarSelect.getBoundingClientRect()), id)
    await click(id)
    setPicking(true)
    await sleep(220, id)

    const line = headline.getBoundingClientRect()
    await moveTo({ x: line.left + line.width * 0.22, y: line.top + line.height * 0.3 }, id)
    setHover(headline)
    await sleep(480, id)
    const word = words.getClientRects()[0] ?? words.getBoundingClientRect()
    await moveTo({ x: word.left + word.width * 0.5, y: word.top + word.height * 0.55 }, id)
    setHover(words)
    await sleep(420, id)
    await click(id)
    select(words)
    setHover(null)
    await sleep(380, id)

    const field = input.getBoundingClientRect()
    await moveTo(
      { x: field.left + Math.min(60, field.width / 3), y: field.top + field.height / 2 },
      id,
    )
    await click(id)
    form.classList.add('is-active')
    await type(PROMPT, id, 30)
    await sleep(320, id)
    await moveTo(center(send.getBoundingClientRect()), id)
    send.classList.add('is-pressed')
    await click(id)
    send.classList.remove('is-pressed')
    form.classList.remove('is-active')
    hideCursor()

    await converse(
      { prompt: PROMPT, target: words, reply: REPLY, change: bold(words), compare: true },
      id,
    )
    ready()
  }

  function ready() {
    setState('idle')
    setPicking(true)
    suggest.hidden = false
    sync()
  }

  async function converse(turn: Turn, id: number) {
    empty.hidden = true
    input.value = ''
    sync()
    const you = h('div', 'row you')
    if (turn.target) you.append(h('div', 'chips'))
    if (turn.target) you.firstElementChild?.append(chip(turn.target))
    you.append(h('p', '', turn.prompt))
    add(you)
    const started = performance.now()

    const thinking = add(h('p', 'row thinking', 'Thinking…'))
    await sleep(900, id)
    thinking.remove()
    if (turn.change) {
      const read = add(step('Read', 0, 0))
      await sleep(700, id)
      finish(read)
      const edit = add(step('Edit', turn.change.plus, turn.change.minus))
      await sleep(380, id)
      turn.change.apply()
      turn.change.applied = true
      applied.push(turn.change)
      await sleep(900, id)
      finish(edit)
      await sleep(200, id)
    }
    await stream(turn.reply, id)
    if (turn.change) {
      await sleep(120, id)
      add(card(turn.change, turn.compare ? turn.target : null))
    }
    const seconds = Math.max(1, Math.round((performance.now() - started) / 1000))
    add(h('p', 'row meta', `Worked for ${seconds}s`))
  }

  async function stream(text: string, id: number) {
    const reply = add(h('p', 'row reply'))
    for (const token of text.split(' ')) {
      const word = h('span', 'word')
      const code = token.match(/^`([^`]+)`(.*)$/)
      if (code) word.append(h('code', '', code[1]), code[2])
      else word.textContent = token
      reply.append(word, ' ')
      if (!reduce.matches) {
        scrollDown()
        await sleep(26 + Math.random() * 34, id)
      }
    }
    scrollDown()
  }

  // Transcript rows

  function add<T extends HTMLElement>(row: T): T {
    transcript.append(row)
    scrollDown()
    return row
  }

  function scrollDown() {
    transcript.scrollTo({
      top: transcript.scrollHeight,
      behavior: reduce.matches ? 'instant' : 'smooth',
    })
  }

  function chip(el: Element) {
    const node = h('span', 'chip')
    node.innerHTML = svg('pointer', 11)
    node.append(h('b', '', tagOf(el)))
    const text = excerpt(el)
    if (text) node.append(h('i', '', text))
    return node
  }

  function step(verb: string, plus: number, minus: number) {
    const row = h('div', 'row step')
    const mark = h('span', 'step-icon')
    mark.append(h('span', 'spinner'))
    row.append(mark, `${verb} `, h('code', '', FILE))
    if (plus || minus) row.append(diffstat(plus, minus))
    return row
  }

  function finish(row: HTMLElement) {
    row.classList.add('is-done')
    const mark = row.querySelector('.step-icon')
    if (mark) mark.innerHTML = svg('check', 12)
  }

  function diffstat(plus: number, minus: number) {
    const stat = h('span', 'diffstat')
    stat.append(h('span', 'plus', `+${plus}`), ' ', h('span', 'minus', `−${minus}`))
    return stat
  }

  function card(change: Change, compare: Element | null) {
    const node = h('div', 'row card')
    if (compare) {
      const words = (compare.textContent ?? '').trim()
      const grid = h('div', 'compare')
      for (const [title, drawn] of [
        ['Before', false],
        ['After', true],
      ] as const) {
        const figure = h('figure', '', title)
        const shot = h('div', 'shot')
        const text = h('span', '', words)
        if (drawn) text.style.fontWeight = BOLD
        shot.append(text)
        figure.append(shot)
        grid.append(figure)
      }
      node.append(grid)
    }
    const foot = h('div', 'card-foot')
    foot.innerHTML = svg('chevronRight', 12)
    foot.append('1 file changed', diffstat(change.plus, change.minus))
    const undo = h('button', 'button')
    undo.type = 'button'
    const label = () => {
      undo.innerHTML = svg(change.applied ? 'undo' : 'redo')
      undo.append(change.applied ? 'Undo' : 'Redo')
    }
    label()
    undo.addEventListener('click', () => {
      if (state !== 'idle') return
      if (change.applied) change.revert()
      else change.apply()
      change.applied = !change.applied
      label()
    })
    foot.append(undo)
    node.append(foot)
    return node
  }

  function resetChat() {
    transcript.replaceChildren(empty)
    empty.hidden = false
    suggest.hidden = true
    input.value = ''
    select(null)
  }

  // Changes to the page

  function remember(el: Styled) {
    if (!originals.has(el)) originals.set(el, el.getAttribute('style'))
  }

  // The variable font has every weight between, so the words thicken smoothly in place.
  function bold(words: HTMLElement): Change {
    return {
      ...restyle(words, 'font-weight', BOLD, `font-weight 700ms ${EASE_DRAW}`),
      plus: 3,
      minus: 1,
    }
  }

  function restyle(
    el: Styled,
    prop: string,
    value: string,
    transition: string,
    fade = false,
  ): Change {
    remember(el)
    const before = el.style.getPropertyValue(prop)
    const set = (v: string) => {
      el.style.transition = transition
      if (v) el.style.setProperty(prop, v)
      else el.style.removeProperty(prop)
    }
    // A font can't animate from one family to the next, so it dips out and back instead.
    const swap = (v: string) => {
      if (!fade || reduce.matches) return set(v)
      el.animate([{ opacity: 1 }, { opacity: 0.08, offset: 0.45 }, { opacity: 1 }], {
        duration: 560,
        easing: 'ease-in-out',
      })
      setTimeout(() => set(v), 250)
    }
    return {
      plus: 1,
      minus: 1,
      applied: false,
      apply: () => swap(value),
      revert: () => swap(before),
    }
  }

  function suggestion(kind: string, el: Element): Turn | null {
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) return null
    const tag = tagOf(el)
    const style = getComputedStyle(el)
    if (kind === 'bolder') {
      const weight = Math.round(Number.parseFloat(style.fontWeight))
      const to = Math.min(900, Math.round((weight + 300) / 50) * 50)
      if (to <= weight) {
        return {
          prompt: 'Make this bolder.',
          target: el,
          reply: `The \`${tag}\` is already at the heaviest weight, ${weight}.`,
        }
      }
      return {
        prompt: 'Make this bolder.',
        target: el,
        change: restyle(el, 'font-weight', String(to), `font-weight 700ms ${EASE_DRAW}`),
        reply: `I changed the weight of the \`${tag}\` from ${weight} to ${to}. The page uses a variable font, so each weight is available.`,
      }
    }
    if (kind === 'serif') {
      return {
        prompt: 'Use a serif font for this.',
        target: el,
        change: restyle(
          el,
          'font-family',
          "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
          'none',
          true,
        ),
        reply: `I set the \`${tag}\` in Iowan Old Style, with Georgia as the fallback.`,
      }
    }
    if (kind === 'blue') {
      return {
        prompt: 'Make this blue, the same blue as Gui.',
        target: el,
        change: restyle(el, 'color', 'light-dark(#0066ff, #5c9dff)', `color 600ms ${EASE_OUT}`),
        reply: `I changed the color of the \`${tag}\` to the Gui blue, \`#0066ff\`. In dark mode it is \`#5c9dff\`, so that it stays easy to read.`,
      }
    }
    return null
  }

  function revertAll() {
    for (const change of applied.reverse()) if (change.applied) change.revert()
    applied.length = 0
  }

  function restoreOriginals() {
    for (const [el, style] of originals) {
      // Chrome writes edits to el.style into the attribute lazily, when something reads it. Read
      // it first, or a pending edit comes back as style="" after the attribute is gone.
      el.getAttribute('style')
      if (style === null) el.removeAttribute('style')
      else el.setAttribute('style', style)
    }
    originals.clear()
  }

  // Controls

  function sync() {
    const idle = state === 'idle'
    input.readOnly = !idle
    send.disabled = !input.value.trim() || !(idle || state === 'intro')
    for (const button of suggestions) button.disabled = !idle || !selected
    hint.textContent = selected
      ? `Try a change to the selected ${tagOf(selected)}:`
      : 'Select an element on the page, then try a change.'
  }

  // The wallpaper is big, so it loads only once a visit looks likely: a pointer or focus on
  // "Try it now", or the page sitting idle. Until it is in, the desk shows its gradient.
  // It shows once it is decoded, so decoding never holds up a frame of the opening.
  function loadWallpaper() {
    if (wallpaper.loading === 'eager') return
    wallpaper.loading = 'eager'
    wallpaper
      .decode()
      .then(() => wallpaper.classList.add('is-ready'))
      .catch(() => {})
  }
  for (const button of openers) {
    button.addEventListener('click', () => open(button))
    button.addEventListener('pointerenter', loadWallpaper, { once: true })
    button.addEventListener('focus', loadWallpaper, { once: true })
    button.addEventListener('touchstart', loadWallpaper, { once: true, passive: true })
  }
  addEventListener('load', () => {
    if ('requestIdleCallback' in window) requestIdleCallback(loadWallpaper, { timeout: 4000 })
  })
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-close]')) {
    button.addEventListener('click', close)
  }
  desk.addEventListener('click', close)
  for (const button of selectButtons) {
    button.addEventListener('click', () => {
      if (state === 'idle') setPicking(!picking)
    })
  }
  q('[data-restart]').addEventListener('click', () => {
    if (state !== 'intro' && state !== 'idle' && state !== 'working') return
    run++
    hideCursor()
    revertAll()
    setPicking(false)
    setHover(null)
    form.classList.remove('is-active')
    resetChat()
    setState('intro')
    script(intro)
  })
  for (const button of suggestions) {
    button.addEventListener('click', () => {
      if (state !== 'idle' || !selected) return
      const turn = suggestion(button.dataset.suggestion ?? '', selected)
      if (!turn) return
      setState('working')
      script(async (id) => {
        await type(turn.prompt, id, 14)
        await sleep(160, id)
        await converse(turn, id)
        setState('idle')
      })
    })
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const prompt = input.value.trim()
    if (state !== 'idle' || !prompt) return
    setState('working')
    script(async (id) => {
      await converse({ prompt, target: selected, reply: FREE_REPLY }, id)
      setState('idle')
    })
  })
  input.addEventListener('input', sync)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      form.requestSubmit()
    }
  })

  // Picking on the page. Clicks never reach the page while the demo is open: a link would leave.
  page.addEventListener('pointermove', (event) => {
    if (state === 'idle' && picking) setHover(pickable(event.target))
  })
  page.addEventListener('pointerleave', () => {
    if (state === 'idle') setHover(null)
  })
  page.addEventListener(
    'click',
    (event) => {
      if (state === 'closed') return
      event.preventDefault()
      event.stopPropagation()
      if (state !== 'idle' || !picking) return
      const el = pickable(event.target)
      if (el) select(el)
    },
    true,
  )

  addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state !== 'closed') close()
  })
  addEventListener('resize', () => {
    if (state === 'closed' || state === 'closing') return
    cancelAnimationFrame(resizing)
    resizing = requestAnimationFrame(() => {
      layout()
      if (state !== 'opening') page.style.transform = shrunk()
    })
  })
}
