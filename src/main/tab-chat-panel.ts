import { BrowserWindow, screen, type WebContentsView } from 'electron'
import { viewportRectFrom, viewRectFromViewport } from '../shared/coords'
import { Events } from '../shared/ipc'
import { BUBBLE, MINI, PANEL_SHADOW_MARGIN, TOOLBAR_HEIGHT, TRAFFIC_LIGHTS } from '../shared/layout'
import { project, SPRINGS, type SpringConfig } from '../shared/motion'
import type {
  ChatFloat,
  ChatForm,
  ChatGrab,
  MorphKind,
  PanelEdge,
  Point,
  Rect,
  SidebarSlide,
} from '../shared/types'
import {
  type Anchor,
  anchorFor,
  cornerPoint,
  fadeIn,
  inCorner,
  maxFloatingSize,
  PANEL_MARGIN,
} from './chat-presentation'
import { Flight, prefersReducedMotion } from './panel-flight'
import { type ChatSize, getPrefs, setPrefs } from './prefs'
import type { PreviewMorph } from './preview-morph'
import type { ProjectResources } from './project-resources'
import { clamp, inCanvas } from './tab-helpers'
import type { TabHost, TabState } from './tab-host'
import { followSurface, surfaceColor } from './theme'
import { focusWindow, showWindow } from './window-presentation'

const PANEL_MIN = { width: 320, height: 360 }
const PANEL_SHORTEST = 200
export const DOCK_MIN_WIDTH = 320
const DOCK_MAX_SHARE = 0.6
const THROW_SPEED = 500
const MAX_THROW_SPEED = 8000
const GRAB_SLOP = 240
const MORPH_TIMEOUT_MS = 700
/**
 * How long after the user went back to their app the floating panel shrinks to its message
 * box: long enough that a glance at the page and back doesn't fold the conversation away.
 */
const COLLAPSE_DELAY_MS = 2500
/** The message box's height until the chat says (one line, its tools and the panel's border) */
const BOX_HEIGHT = 96
const FORM_SIZE: Record<ChatForm, number> = { bubble: 0, pill: 1, panel: 2 }

/** What the chat panel needs from its tab: views, project resources, and layout hooks. */
export interface ChatPanelOwner {
  readonly id: string
  host: TabHost
  readonly chatView: WebContentsView
  readonly resources: ProjectResources
  readonly disposed: boolean
  readonly hasProject: boolean
  readonly title: string | null
  readonly morph: PreviewMorph
  readonly state: TabState
  patch(patch: Partial<TabState>): void
  sendChat(channel: string, payload: unknown): void
  /** To the window's chrome, while this tab is the one it shows */
  sendChrome(channel: string, payload: unknown): void
  leaveFocusMode(): void
  setSelecting(on: boolean): Promise<void>
  morphLayout(kind: MorphKind): void
  layout(): void
}

/**
 * The chat as a native view: docked, floating (panel, or its message box alone / pill /
 * bubble), or popped out.
 * ProjectTab owns preview layout; this owns the chat view's place and springs.
 */
export class ChatPanel {
  /**
   * Where the floating panel sits: by one of its corners, from the canvas's same corner, so it
   * stays there as the window and the logs resize.
   */
  private anchor: Anchor = { ...getPrefs().chatCorner, dx: PANEL_MARGIN, dy: PANEL_MARGIN }
  private flight: Flight | null = null
  /**
   * Floating, where the panel was drawn when the preview's morph was asked for: it stays there
   * while the canvas changes under it (the drawer taking its space at once, out of sight), then
   * flies to its new corner as the morph moves (`morphFlight`), rather than jumping.
   */
  private heldAt: Rect | null = null
  private morphFlight: Flight | null = null
  /**
   * The sidebar sliding in (or, `leaving`, out) at the window's edge with the preview's morph:
   * how far out of the window it is, from `from` (held there until the preview moves) to 0 in,
   * or its width out.
   */
  private dockSlide: { flight: Flight | null; from: number; leaving: boolean } | null = null
  /** The last `SidebarSlide` the chrome was sent, as JSON, so a resting sidebar sends nothing */
  private slideSent = 'null'
  private panelSize: ChatSize = getPrefs().chatSize
  private dockWidth = getPrefs().chatSidebarWidth
  private resizing: 'floating' | 'docked' | null = null
  private floatShown: ChatFloat | null = null
  private viewForm: ChatForm = 'panel'
  private morphing: { form: ChatForm; seq: number; timer: NodeJS.Timeout } | null = null
  private formSeq = 0
  private lastForm: ChatForm = 'panel'
  private attentionWaiting = false
  /**
   * The floating panel shows the conversation: since a reply started, the agent asked for
   * attention, or the user asked for it; until they went back to their app (`leftChat`).
   */
  private conversationShown = false
  /** The view is sized to the message box alone; it shrinks only once the panel has (`chatCollapsed`) */
  private viewCollapsed = true
  private collapsing: { seq: number; timer: NodeJS.Timeout } | null = null
  private collapseTimer: NodeJS.Timeout | null = null
  /** The user went back to their app (`byPage`: by using the page) and the panel may collapse */
  private collapseDue: { byPage: boolean } | null = null
  /** The pointer is over the panel, or a sheet in it is open: it stays as it is */
  private held = false
  private boxHeight = BOX_HEIGHT
  private lastCollapsed: boolean | null = null
  private popout: BrowserWindow | null = null

  constructor(private readonly tab: ChatPanelOwner) {}

  get popoutWindow() {
    return this.popout
  }

  get sidebarShown() {
    return this.chatShown && this.docked
  }

  get docked() {
    return this.tab.resources.chat?.meta.docked ?? getPrefs().chatSidebar
  }

  private get bubbled() {
    return this.tab.state.preview.selecting && this.chatShown && !this.docked
  }

  /** The chat is on screen in some form, popped out included, so its turns can be seen. */
  get chatInView() {
    return this.chatShown || !!this.popout
  }

  private get chatShown() {
    return (
      this.tab.state.chatVisible && this.tab.hasProject && !this.tab.host.focusMode && !this.popout
    )
  }

  /**
   * Where the floating chat lies over the window's content, for the board to frame its view
   * around it; null when the chat is docked, hidden, popped out or a bubble.
   */
  coverRect(): Rect | null {
    if (!this.chatShown || this.docked || this.bubbled) return null
    const [contentWidth, contentHeight] = this.tab.host.win.getContentSize()
    return this.floatingRect(contentWidth, contentHeight, undefined, true)
  }

  clearFloatShown() {
    this.floatShown = null
  }

  /** ⌘B and the toolbar's chat button: shows or hides the chat, in whichever form it takes. */
  toggleChat() {
    if (this.popout) return this.focusChat()
    if (this.tab.host.focusMode) return this.focusChat()
    if (this.docked) this.tab.morphLayout('dock')
    this.tab.patch({ chatVisible: !this.tab.state.chatVisible })
    if (this.docked) {
      if (this.tab.state.chatVisible) this.holdDock()
      else this.holdDock(true)
    }
    this.tab.layout()
    if (this.tab.state.chatVisible && !this.bubbled) this.focusChat()
    else if (!this.tab.state.chatVisible && this.tab.host.win.isFocused())
      this.tab.host.win.webContents.focus()
  }

  focusMessageBox() {
    if (!this.tab.hasProject) return
    this.focusChat()
  }

  setMinimized(minimized: boolean) {
    this.tab.resources.chat?.setMinimized(minimized)
    this.tab.layout()
  }

  /** The message box's Show conversation: the panel grows, its message box keeping the keyboard. */
  expandChat() {
    this.showConversation()
    this.focusChat()
  }

  togglePopOut() {
    if (!this.tab.hasProject || !this.tab.resources.chat) return
    if (this.popout) this.popIn()
    else this.popOut()
  }

  private popOut() {
    this.tab.leaveFocusMode()
    if (this.tab.state.preview.selecting) void this.tab.setSelecting(false)
    this.cancelCollapse()
    this.flight?.finish()
    if (this.sidebarShown) this.tab.morphLayout('dock')
    const bounds = this.popoutBounds()
    const win = new BrowserWindow({
      ...bounds,
      minWidth: DOCK_MIN_WIDTH,
      minHeight: PANEL_MIN.height,
      show: false,
      title: `${this.tab.title ?? 'Chat'} — Chat`,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: TRAFFIC_LIGHTS,
      fullscreenable: false,
      backgroundColor: surfaceColor(),
    })
    followSurface(win)
    win.webContents.loadURL('about:blank').catch(() => undefined)
    this.popout = win
    if (this.tab.host.isActive(this.tab))
      this.tab.host.win.contentView.removeChildView(this.tab.chatView)
    win.contentView.addChildView(this.tab.chatView)
    this.tab.chatView.setVisible(true)
    this.layoutPopout()
    win.on('resize', () => this.layoutPopout())
    win.on('close', (event) => {
      if (this.popout !== win) return
      event.preventDefault()
      this.popIn()
    })
    win.on('page-title-updated', (event) => event.preventDefault())
    this.tab.resources.chat?.setPopped(true)
    if (!this.tab.state.chatVisible) this.tab.patch({ chatVisible: true })
    this.tab.layout()
    // Out, ⌘B brings it forward rather than hiding it: the View menu says Show Chat.
    this.tab.host.tabChanged(this.tab, false)
    win.once('ready-to-show', () => {
      if (this.popout !== win || !this.tab.host.isActive(this.tab)) return
      fadeIn(win, this.tab.chatView.webContents)
      showWindow(win)
      this.focusChat()
    })
  }

  private popIn() {
    if (!this.popout) return
    this.closePopout()
    this.tab.resources.chat?.setPopped(false)
    if (this.tab.host.isActive(this.tab)) {
      this.tab.host.win.contentView.addChildView(this.tab.chatView)
      if (this.docked) {
        this.tab.morphLayout('dock')
        this.holdDock()
      }
    }
    if (!this.tab.state.chatVisible) this.tab.patch({ chatVisible: true })
    this.tab.layout()
    this.tab.host.tabChanged(this.tab, false)
    focusWindow(this.tab.host.win)
    this.focusChat()
  }

  closePopout() {
    const win = this.popout
    if (!win) return
    this.popout = null
    if (!win.isDestroyed()) {
      win.contentView.removeChildView(this.tab.chatView)
      win.destroy()
    }
  }

  private layoutPopout() {
    const win = this.popout
    if (!win || win.isDestroyed()) return
    const [width, height] = win.getContentSize()
    this.tab.chatView.setBounds({ x: 0, y: 0, width, height })
    this.tab.resources.chat?.setTrafficLights(true)
  }

  private popoutBounds() {
    const main = this.tab.host.win.getBounds()
    const { workArea } = screen.getDisplayMatching(main)
    const width = Math.max(DOCK_MIN_WIDTH, this.docked ? this.dockedWidth() : this.panelSize.width)
    const height = Math.min(main.height, workArea.height)
    const gap = 8
    const right = main.x + main.width + gap
    const left = main.x - gap - width
    const x =
      right + width <= workArea.x + workArea.width
        ? right
        : left >= workArea.x
          ? left
          : Math.max(workArea.x, main.x + main.width - width)
    return { x: Math.round(x), y: Math.max(workArea.y, main.y), width, height }
  }

  /**
   * Whether the floating panel is its message box alone: with no conversation yet (a new chat,
   * a project just opened), or once the user went back to their app after the agent was done.
   * Never while a reply runs or a card waits for an answer.
   */
  private collapsed() {
    const chat = this.tab.resources.chat
    if (!chat || this.docked || this.popout) return false
    if (chat.turnRunning || chat.awaitingPermission) return false
    return !this.conversationShown
  }

  /** A new chat: nothing to show yet, so the panel is its message box. */
  newConversation() {
    this.cancelCollapse()
    this.conversationShown = false
    this.tab.layout()
  }

  /** A reply started, a turn ended, the agent wants attention, or the user asked: it grows. */
  showConversation() {
    this.cancelCollapse()
    if (this.conversationShown) return
    this.conversationShown = true
    this.tab.layout()
  }

  /**
   * The user went back to their app: they used the page (`byPage`), or the keyboard left the
   * chat. A while later, if the agent's done and the user isn't at the panel, it collapses.
   */
  leftChat(byPage: boolean) {
    if (this.tab.disposed || !this.conversationShown || this.docked || this.popout) return
    this.collapseDue = { byPage: byPage || !!this.collapseDue?.byPage }
    this.scheduleCollapse()
  }

  private scheduleCollapse() {
    if (this.collapseTimer) clearTimeout(this.collapseTimer)
    this.collapseTimer = setTimeout(() => {
      this.collapseTimer = null
      if (!this.shouldCollapse()) return
      this.collapseDue = null
      this.conversationShown = false
      this.tab.layout()
    }, COLLAPSE_DELAY_MS)
  }

  private shouldCollapse() {
    const chat = this.tab.resources.chat
    const due = this.collapseDue
    return (
      due !== null &&
      !this.tab.disposed &&
      this.chatShown &&
      !this.docked &&
      !this.held &&
      !chat?.turnRunning &&
      !chat?.awaitingPermission &&
      !this.tab.state.preview.selecting &&
      !this.resizing &&
      !this.flight &&
      this.tab.host.isActive(this.tab) &&
      // Using the page is going back to the app; the keyboard merely leaving the chat is only
      // if it stayed in this window, and not back in the chat.
      (due.byPage || (this.tab.host.win.isFocused() && !this.tab.chatView.webContents.isFocused()))
    )
  }

  /** The user is back at the chat: nothing collapses until they leave it again. */
  cancelCollapse() {
    if (this.collapseTimer) clearTimeout(this.collapseTimer)
    this.collapseTimer = null
    this.collapseDue = null
  }

  /** The pointer is over the panel (or a sheet in it is open); leaving it, it may collapse. */
  hold(held: boolean) {
    this.held = held
    if (held) {
      if (this.collapseTimer) clearTimeout(this.collapseTimer)
      this.collapseTimer = null
    } else if (this.collapseDue) {
      this.scheduleCollapse()
    }
  }

  setBoxHeight(height: number) {
    const rounded = Math.max(1, Math.round(height))
    if (rounded === this.boxHeight) return
    this.boxHeight = rounded
    if (this.viewCollapsed) this.layoutChat()
  }

  chatCollapsed(seq: number) {
    if (this.collapsing?.seq !== seq) return
    this.settleCollapse(true)
    this.layoutChat()
  }

  private settleCollapse(collapsed: boolean) {
    this.viewCollapsed = collapsed
    if (this.collapsing) clearTimeout(this.collapsing.timer)
    this.collapsing = null
  }

  /** Keeps the view at the full panel until the chat has shrunk to its message box. */
  private awaitCollapse() {
    if (this.collapsing?.seq === this.formSeq) return
    if (this.collapsing) clearTimeout(this.collapsing.timer)
    const seq = this.formSeq
    const timer = setTimeout(() => this.chatCollapsed(seq), MORPH_TIMEOUT_MS)
    this.collapsing = { seq, timer }
  }

  grabChat(at: ChatGrab) {
    if (!this.flight && !this.heldAt) return
    const [contentWidth, contentHeight] = this.tab.host.win.getContentSize()
    const drawn = this.floatingRect(contentWidth, contentHeight)
    const view = this.floatingBounds(contentWidth, contentHeight, this.viewForm)
    const content = this.tab.host.win.getContentBounds()
    const zoom = this.tab.chatView.webContents.getZoomFactor()
    const dx = Math.round(at.screenX - content.x - at.clientX * zoom) - view.x
    const dy = Math.round(at.screenY - content.y - at.clientY * zoom) - view.y
    const near = Math.abs(dx) <= GRAB_SLOP && Math.abs(dy) <= GRAB_SLOP
    this.holdFlight(near ? { ...drawn, x: drawn.x + dx, y: drawn.y + dy } : drawn)
    this.layoutChat()
  }

  dragChat(dx: number, dy: number) {
    this.holdFlight()
    const [contentWidth, contentHeight] = this.tab.host.win.getContentSize()
    const rect = this.floatingRect(contentWidth, contentHeight)
    const area = this.anchorArea(contentWidth, contentHeight)
    this.anchor = anchorFor({ ...rect, x: rect.x + dx, y: rect.y + dy }, area, this.anchor)
    this.layoutChat()
  }

  endDragChat(release: Point = { x: 0, y: 0 }) {
    this.holdFlight()
    const [contentWidth, contentHeight] = this.tab.host.win.getContentSize()
    const rect = this.floatingRect(contentWidth, contentHeight)
    const area = this.anchorArea(contentWidth, contentHeight)
    const speed = Math.hypot(release.x, release.y)
    const cap = speed > MAX_THROW_SPEED ? MAX_THROW_SPEED / speed : 1
    const velocity = { x: release.x * cap, y: release.y * cap }
    const landing = {
      x: project(rect.x + rect.width / 2, velocity.x),
      y: project(rect.y + rect.height / 2, velocity.y),
    }
    this.anchor = {
      x: landing.x < area.x + area.width / 2 ? 'left' : 'right',
      y: landing.y < area.y + area.height / 2 ? 'top' : 'bottom',
      dx: PANEL_MARGIN,
      dy: PANEL_MARGIN,
    }
    setPrefs({ chatCorner: { x: this.anchor.x, y: this.anchor.y } })
    this.fly(rect, velocity, speed > THROW_SPEED ? SPRINGS.thrown : SPRINGS.default)
  }

  chatMorphed(form: ChatForm, seq: number) {
    if (this.morphing?.form !== form || this.morphing.seq !== seq) return
    this.settleForm(form)
    this.layoutChat()
  }

  resizeChat(edge: PanelEdge, dx: number, dy: number) {
    if (!this.tab.state.chatVisible || !this.tab.hasProject) return
    if (this.docked) {
      const left = getPrefs().chatSidebarSide === 'left'
      if (edge !== (left ? 'right' : 'left')) return
      const width = this.dockedWidth() + (left ? dx : -dx)
      const [contentWidth] = this.tab.host.win.getContentSize()
      this.dockWidth = Math.round(clamp(width, DOCK_MIN_WIDTH, contentWidth * DOCK_MAX_SHARE))
      this.resizing = 'docked'
    } else {
      if (this.tab.resources.chat?.meta.minimized || this.bubbled || this.collapsed()) return
      this.holdFlight()
      const [contentWidth, contentHeight] = this.tab.host.win.getContentSize()
      const area = this.anchorArea(contentWidth, contentHeight)
      const max = maxFloatingSize(contentWidth, area, PANEL_MIN.height)
      const panel = this.floatingRect(contentWidth, contentHeight)
      let left = panel.x
      let top = panel.y
      let right = panel.x + panel.width
      let bottom = panel.y + panel.height
      const [moveX, moveY] = [Math.round(dx), Math.round(dy)]
      if (edge.includes('left')) {
        const leftmost = Math.max(0, right - max.width)
        left = clamp(left + moveX, leftmost, right - PANEL_MIN.width)
      } else if (edge.includes('right')) {
        const rightmost = Math.min(contentWidth, left + max.width)
        right = clamp(right + moveX, left + PANEL_MIN.width, rightmost)
      }
      if (edge.startsWith('top')) {
        const highest = Math.max(this.tab.host.chromeHeight, bottom - max.height)
        top = clamp(top + moveY, highest, bottom - PANEL_MIN.height)
      } else if (edge.startsWith('bottom')) {
        const lowest = Math.min(area.y + area.height, top + max.height)
        bottom = clamp(bottom + moveY, top + PANEL_MIN.height, lowest)
      }
      this.panelSize = { width: right - left, height: bottom - top }
      this.anchor = anchorFor({ x: left, y: top, ...this.panelSize }, area, this.anchor)
      this.resizing = 'floating'
    }
    this.tab.layout()
  }

  endResizeChat() {
    if (this.resizing === 'docked') {
      setPrefs({ chatSidebarWidth: this.dockWidth })
    } else if (this.resizing === 'floating') {
      setPrefs({ chatSize: this.panelSize })
      this.settleAnchor()
    }
    this.resizing = null
    this.syncSidebarWidth()
    this.sendSlide()
  }

  focusChat() {
    this.tab.leaveFocusMode()
    this.cancelCollapse()
    if (this.popout) {
      if (!this.tab.host.isActive(this.tab)) return
      focusWindow(this.popout)
      this.tab.chatView.webContents.focus()
      this.tab.sendChat(Events.chatFocus, null)
      return
    }
    if (this.tab.state.preview.selecting && this.tab.hasProject && !this.docked) {
      void this.tab.setSelecting(false).then(() => {
        if (!this.tab.state.preview.selecting) this.focusChat()
      })
      return
    }
    if (!this.tab.state.chatVisible) {
      if (this.docked) {
        this.tab.morphLayout('dock')
        this.holdDock()
      }
      this.tab.patch({ chatVisible: true })
    }
    if (this.tab.resources.chat?.meta.minimized) this.tab.resources.chat.setMinimized(false)
    this.tab.layout()
    if (!this.tab.host.isActive(this.tab)) return
    this.tab.chatView.webContents.focus()
    this.tab.sendChat(Events.chatFocus, null)
  }

  onAttention() {
    // Whatever waits on the user is in the conversation: the panel shows it.
    this.showConversation()
    if (!this.tab.state.preview.selecting || this.docked) return this.focusChat()
    this.attentionWaiting = true
    if (!this.tab.state.chatVisible) {
      this.tab.patch({ chatVisible: true })
      this.tab.layout()
    }
  }

  takeAttention() {
    const waiting = this.attentionWaiting
    this.attentionWaiting = false
    return waiting
  }

  layoutChat() {
    if (this.tab.disposed || !this.tab.host.isActive(this.tab)) return
    // Before the sidebar's new width: the bars then hold where the sidebar is as it arrives.
    this.sendSlide()
    this.syncSidebarWidth()
    if (this.popout) return
    const [contentWidth, contentHeight] = this.tab.host.win.getContentSize()
    const showChat = this.chatShown
    // Hidden, the sidebar stays on screen until it has slid out of the window.
    const leaving = !showChat && this.docked && !!this.dockSlide?.leaving
    const docked = (showChat || leaving) && this.docked
    const covered = this.tab.host.sheetShown
    const float = this.float()
    const { form } = float
    if (!showChat || docked) {
      this.flight?.finish()
      this.settleForm(form)
      this.settleCollapse(float.collapsed)
      this.showFloat(float)
    }
    this.tab.chatView.setVisible((showChat || leaving) && !covered)
    this.tab.resources.chat?.setTrafficLights(
      docked && getPrefs().chatSidebarSide === 'left' && !this.tab.host.win.isFullScreen(),
    )
    // Taller chrome than the toolbar alone: the tab row is showing beside the sidebar.
    this.tab.resources.chat?.setTabRow(docked && this.tab.host.chromeHeight > TOOLBAR_HEIGHT)
    if (docked) {
      const dockWidth = this.dockedWidth()
      const slide = this.dockOffset()
      this.tab.chatView.setBounds({
        x:
          getPrefs().chatSidebarSide === 'left'
            ? -Math.round(slide)
            : contentWidth - dockWidth + Math.round(slide),
        y: 0,
        width: dockWidth,
        height: Math.max(0, contentHeight),
      })
      return
    }
    if (!showChat) return
    if (FORM_SIZE[form] > FORM_SIZE[this.viewForm]) this.settleForm(form)
    else if (form !== this.viewForm) this.awaitMorph(form)
    else this.settleForm(form)
    // Growing from the message box, the view is the full panel at once; shrinking to it, only
    // once the panel has (a bubble or pill drawn meanwhile takes the box's corner at once).
    if (!float.collapsed) this.settleCollapse(false)
    else if (this.viewCollapsed) this.settleCollapse(true)
    else if (form === 'panel' && this.viewForm === 'panel') this.awaitCollapse()
    else this.settleCollapse(true)
    this.tab.chatView.setBounds(this.floatingBounds(contentWidth, contentHeight, this.viewForm))
    this.showFloat(float)
  }

  wantedForm(): ChatForm {
    if (this.bubbled) return 'bubble'
    return this.tab.resources.chat?.meta.minimized ? 'pill' : 'panel'
  }

  float(): ChatFloat {
    const form = this.wantedForm()
    const collapsed = this.collapsed()
    if (form !== this.lastForm || collapsed !== this.lastCollapsed) {
      this.lastForm = form
      this.lastCollapsed = collapsed
      this.formSeq++
    }
    const [contentWidth, contentHeight] = this.tab.host.win.getContentSize()
    return {
      form,
      corner: { x: this.anchor.x, y: this.anchor.y },
      seq: this.formSeq,
      collapsed,
      panelHeight: this.floatingSize(contentWidth, contentHeight).height,
    }
  }

  settleForm(form: ChatForm) {
    this.viewForm = form
    if (this.morphing) clearTimeout(this.morphing.timer)
    this.morphing = null
  }

  private awaitMorph(form: ChatForm) {
    if (this.morphing?.form === form && this.morphing.seq === this.formSeq) return
    if (this.morphing) clearTimeout(this.morphing.timer)
    const seq = this.formSeq
    const timer = setTimeout(() => this.chatMorphed(form, seq), MORPH_TIMEOUT_MS)
    this.morphing = { form, seq, timer }
  }

  private floatingBounds(contentWidth: number, contentHeight: number, form: ChatForm): Rect {
    const base =
      form === 'bubble'
        ? this.floatingRect(contentWidth, contentHeight)
        : this.floatingRect(contentWidth, contentHeight, form)
    const { x, y, width, height } = form === 'bubble' ? inCorner(base, BUBBLE, this.anchor) : base
    return {
      x: x - PANEL_SHADOW_MARGIN,
      y: y - PANEL_SHADOW_MARGIN,
      width: width + PANEL_SHADOW_MARGIN * 2,
      height: height + PANEL_SHADOW_MARGIN * 2,
    }
  }

  private floatingRect(
    contentWidth: number,
    contentHeight: number,
    shape: 'panel' | 'pill' = this.tab.resources.chat?.meta.minimized ? 'pill' : 'panel',
    atRest = false,
  ): Rect {
    const { width, height } =
      shape === 'pill' ? MINI : this.floatingSize(contentWidth, contentHeight, this.viewCollapsed)
    const area = this.anchorArea(contentWidth, contentHeight)
    const { x, y, dx, dy } = this.anchor
    const held = !atRest && this.heldAt ? cornerPoint(this.heldAt, this.anchor) : null
    const corner = (!atRest && this.flight?.point) ||
      held || {
        x: x === 'left' ? area.x + dx : area.x + area.width - dx,
        y: y === 'top' ? area.y + dy : area.y + area.height - dy,
      }
    const left = x === 'left' ? corner.x : corner.x - width
    const top = y === 'top' ? corner.y : corner.y - height
    // Held or flying with a morph, the canvas has already changed under it: it keeps to the
    // window, not to the canvas, or it would jump there.
    const free =
      !atRest && (held !== null || (this.flight !== null && this.flight === this.morphFlight))
    const bottom = free ? contentHeight - height : area.y + area.height - height
    return {
      x: Math.round(clamp(left, 0, contentWidth - width)),
      y: Math.round(clamp(top, this.tab.host.chromeHeight, bottom)),
      width,
      height,
    }
  }

  private restingCorner(): Point {
    const [contentWidth, contentHeight] = this.tab.host.win.getContentSize()
    return cornerPoint(this.floatingRect(contentWidth, contentHeight, undefined, true), this.anchor)
  }

  private fly(from: Rect, velocity: Point, config: SpringConfig) {
    this.flight?.stop()
    this.flight = null
    if (prefersReducedMotion() || !this.tab.host.isActive(this.tab) || !this.chatShown) {
      this.layoutChat()
      return
    }
    const flight: Flight = new Flight({
      frames: this.tab.host.win.webContents,
      from: cornerPoint(from, this.anchor),
      velocity,
      config,
      target: () => this.restingCorner(),
      frame: () => this.layoutChat(),
      rest: () => {
        if (this.flight === flight) this.flight = null
        this.layoutChat()
      },
    })
    this.flight = flight
    this.layoutChat()
  }

  private holdFlight(at?: Rect) {
    if (!this.flight && !this.heldAt) return
    const [contentWidth, contentHeight] = this.tab.host.win.getContentSize()
    const rect = at ?? this.floatingRect(contentWidth, contentHeight)
    this.flight?.stop()
    this.flight = null
    this.heldAt = null
    this.morphFlight = null
    this.anchor = anchorFor(rect, this.anchorArea(contentWidth, contentHeight), this.anchor)
  }

  /** A morph was asked for: the floating panel stays where it's drawn until it moves. */
  holdFloat() {
    if (this.heldAt || this.flight || this.docked || this.popout || !this.chatShown) return
    if (!this.tab.morph.active || !this.tab.host.isActive(this.tab)) return
    const [contentWidth, contentHeight] = this.tab.host.win.getContentSize()
    this.heldAt = this.floatingRect(contentWidth, contentHeight)
  }

  /** The morph moves: the panel flies to its corner on the same spring, from the same moment. */
  flyHeld() {
    const from = this.heldAt
    if (!from) return
    this.heldAt = null
    this.fly(from, { x: 0, y: 0 }, SPRINGS.default)
    this.morphFlight = this.flight
  }

  /** The morph rests (or never moved): so does the panel, in its corner. */
  landFloat() {
    const flight = this.morphFlight
    this.morphFlight = null
    if (flight && this.flight === flight) flight.finish()
    if (!this.heldAt) return
    this.heldAt = null
    this.layoutChat()
  }

  /** How far the docked sidebar is out of the window now: 0 in place, its width out of sight. */
  private dockOffset() {
    const slide = this.dockSlide
    return slide ? (slide.flight?.point.x ?? slide.from) : 0
  }

  /**
   * Tells the chrome how much of the sliding sidebar is in the window, from the same offset
   * that places its view, so the bars beside it move with it frame for frame (renderer
   * app/layout-morph.ts). Null once it rests; snapped, it never slides.
   */
  private sendSlide() {
    const slide = this.dockSlide
    let payload: SidebarSlide = null
    if ((slide || this.resizing === 'docked') && this.docked && !this.popout) {
      const shown = Math.max(0, this.dockedWidth() - Math.round(this.dockOffset()))
      payload =
        getPrefs().chatSidebarSide === 'left'
          ? { left: shown, right: 0 }
          : { left: 0, right: shown }
    }
    const json = JSON.stringify(payload)
    if (json === this.slideSent) return
    this.slideSent = json
    this.tab.sendChrome(Events.sidebarSlide, payload)
  }

  /**
   * Holds the sidebar where it is (out of sight, coming in) until the preview's morph moves,
   * then `slideDock` slides it in, or with `leaving`, out. Mid-slide, it turns from where it is.
   */
  holdDock(leaving = false) {
    const slide = this.dockSlide
    const from = slide ? this.dockOffset() : leaving ? 0 : this.dockedWidth()
    slide?.flight?.stop()
    this.dockSlide = this.tab.morph.active ? { flight: null, from, leaving } : null
  }

  slideDock(reduced: boolean) {
    const slide = this.dockSlide
    if (!slide || slide.flight) return
    const wanted = slide.leaving ? !this.chatShown : this.chatShown
    if (reduced || !wanted || !this.docked || !this.tab.host.isActive(this.tab)) {
      this.dockSlide = null
      this.layoutChat()
      return
    }
    const flight: Flight = new Flight({
      frames: this.tab.host.win.webContents,
      from: { x: slide.from, y: 0 },
      velocity: { x: 0, y: 0 },
      config: SPRINGS.default,
      target: () => ({ x: slide.leaving ? this.dockedWidth() : 0, y: 0 }),
      frame: () => this.layoutChat(),
      rest: () => {
        if (this.dockSlide?.flight === flight) this.dockSlide = null
        this.layoutChat()
      },
    })
    slide.flight = flight
  }

  landDock() {
    const slide = this.dockSlide
    if (!slide) return
    if (slide.flight) return slide.flight.finish()
    this.dockSlide = null
    this.layoutChat()
  }

  private anchorArea(contentWidth: number, contentHeight: number): Rect {
    const { canvas, chromeHeight } = this.tab.host
    if (canvas.width > 0 && canvas.height > 0) return canvas
    return { x: 0, y: chromeHeight, width: contentWidth, height: contentHeight - chromeHeight }
  }

  private settleAnchor() {
    const [contentWidth, contentHeight] = this.tab.host.win.getContentSize()
    const rect = this.floatingRect(contentWidth, contentHeight)
    const area = this.anchorArea(contentWidth, contentHeight)
    this.anchor = anchorFor(rect, area, {
      x: rect.x + rect.width / 2 < area.x + area.width / 2 ? 'left' : 'right',
      y: rect.y + rect.height / 2 < area.y + area.height / 2 ? 'top' : 'bottom',
    })
  }

  private showFloat(float: ChatFloat) {
    const shown = this.floatShown
    const same =
      shown?.form === float.form &&
      shown.corner.x === float.corner.x &&
      shown.corner.y === float.corner.y &&
      shown.collapsed === float.collapsed &&
      shown.panelHeight === float.panelHeight
    if (same) return
    this.floatShown = float
    this.tab.sendChat(Events.chatFloat, float)
  }

  dockedWidth() {
    const [contentWidth] = this.tab.host.win.getContentSize()
    return Math.round(clamp(this.dockWidth, DOCK_MIN_WIDTH, contentWidth * DOCK_MAX_SHARE))
  }

  private syncSidebarWidth() {
    if (this.resizing === 'docked') return
    const width = this.sidebarShown ? this.dockedWidth() : 0
    const side = getPrefs().chatSidebarSide
    if (width !== this.tab.state.sidebarWidth || side !== this.tab.state.sidebarSide) {
      this.tab.patch({ sidebarWidth: width, sidebarSide: side })
    }
  }

  /**
   * The panel's size; `box`, the message box alone, as tall as the chat says, at the same
   * anchored corner: it's laid out, dragged and thrown as itself, and the panel grows from it.
   */
  private floatingSize(contentWidth: number, contentHeight: number, box = false): ChatSize {
    const max = maxFloatingSize(
      contentWidth,
      this.anchorArea(contentWidth, contentHeight),
      PANEL_MIN.height,
    )
    const height = Math.min(clamp(this.panelSize.height, PANEL_MIN.height, max.height), max.height)
    const full = Math.round(Math.max(height, PANEL_SHORTEST))
    return {
      width: Math.round(clamp(this.panelSize.width, PANEL_MIN.width, max.width)),
      height: box ? Math.min(this.boxHeight, full) : full,
    }
  }

  dodge(rect: Rect, placement: Rect, scale: number) {
    if (
      !this.tab.resources.chat ||
      this.tab.resources.chat.meta.docked ||
      !this.chatShown ||
      this.bubbled
    )
      return
    const scaled = viewRectFromViewport(viewportRectFrom(rect), scale)
    const element = {
      x: placement.x + scaled.x,
      y: placement.y + scaled.y,
      width: scaled.width,
      height: scaled.height,
    }
    const view = this.tab.chatView.getBounds()
    const panel = {
      x: view.x + PANEL_SHADOW_MARGIN,
      y: view.y + PANEL_SHADOW_MARGIN,
      width: view.width - PANEL_SHADOW_MARGIN * 2,
      height: view.height - PANEL_SHADOW_MARGIN * 2,
    }
    const overlaps =
      element.x < panel.x + panel.width &&
      element.x + element.width > panel.x &&
      element.y < panel.y + panel.height &&
      element.y + element.height > panel.y
    if (!overlaps) return
    const [contentWidth, contentHeight] = this.tab.host.win.getContentSize()
    const area = this.anchorArea(contentWidth, contentHeight)
    const elementCenter = element.x + element.width / 2
    const x = elementCenter > area.x + area.width / 2 ? 'left' : 'right'
    const from = this.floatingRect(contentWidth, contentHeight)
    const velocity = this.flight?.velocity ?? { x: 0, y: 0 }
    this.anchor = { ...this.anchor, x, dx: PANEL_MARGIN }
    this.fly(from, velocity, SPRINGS.default)
  }

  deactivate() {
    this.landDock()
    // The chrome drops a slide when the tab goes; this one starts over when it's back.
    this.slideSent = 'null'
    this.flight?.finish()
    this.settleForm(this.wantedForm())
    this.settleCollapse(this.collapsed())
  }

  dispose() {
    this.cancelCollapse()
    if (this.collapsing) clearTimeout(this.collapsing.timer)
    this.closePopout()
    this.flight?.stop()
    this.dockSlide?.flight?.stop()
    if (this.morphing) clearTimeout(this.morphing.timer)
  }

  frameInCanvas(bounds: Rect): Rect {
    return inCanvas(bounds, this.tab.host.canvas)
  }
}
