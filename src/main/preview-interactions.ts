import type { Inspector } from './inspector'

export const PREVIEW_KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'Space',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
] as const
export type PreviewKey = (typeof PREVIEW_KEYS)[number]

const KEY_CODES: Record<PreviewKey, number> = {
  Enter: 13,
  Escape: 27,
  Tab: 9,
  Space: 32,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
}

/** Bounded page data, not a script supplied by the agent. Selectors are resolved afresh. */
const SNAPSHOT = `(() => {
  const clean = (text) => String(text || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
  const selector = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      const tag = node.localName;
      const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(n => n.localName === tag) : [node];
      parts.unshift(tag + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : ''));
    }
    return parts.join(' > ');
  };
  const elements = [];
  let omitted = 0;
  const candidates = document.querySelectorAll('h1,h2,h3,button,a[href],input,textarea,select,summary,[role],[contenteditable],[tabindex]');
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (!rect.width || !rect.height || style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') continue;
    if (elements.length >= 100) { omitted++; continue; }
    const labelIds = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
    const name = clean(el.getAttribute('aria-label') || labelIds.map(id => document.getElementById(id)?.textContent || '').join(' ') || (el.labels && Array.from(el.labels).map(n => n.textContent).join(' ')) || el.getAttribute('placeholder') || el.textContent);
    const password = el.localName === 'input' && el.type === 'password';
    elements.push({
      selector: selector(el), tag: el.localName, role: el.getAttribute('role') || undefined,
      name, type: el.getAttribute('type') || undefined,
      value: password ? undefined : ('value' in el ? clean(el.value) : undefined),
      disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
      checked: 'checked' in el ? el.checked : el.getAttribute('aria-checked') || undefined,
      expanded: el.getAttribute('aria-expanded') || undefined,
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
    });
  }
  return { title: clean(document.title), viewport: { width: innerWidth, height: innerHeight },
    scroll: { x: scrollX, y: scrollY }, text: (document.body?.innerText || '').slice(0, 8000), elements, omitted,
    limitation: 'Main document only; iframe contents and shadow roots are not listed. Selectors may change after navigation or hot reload.' };
})()`

/** Only prepares browser input; never changes application values or invokes .click(). */
const TARGET = `function () {
  if (!this.isConnected) return { error: 'The target was removed; take a fresh snapshot' };
  const style = getComputedStyle(this);
  const rect = this.getBoundingClientRect();
  if (!rect.width || !rect.height || style.visibility === 'hidden' || style.visibility === 'collapse') return { error: 'The target is not visible' };
  const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
  const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return { error: 'The target is outside the viewport' };
  const x = (left + right) / 2, y = (top + bottom) / 2;
  const hit = document.elementFromPoint(x, y);
  if (!hit || (hit !== this && !this.contains(hit))) return { error: 'The target is covered by another element' };
  return { x, y, disabled: this.matches(':disabled') || this.getAttribute('aria-disabled') === 'true',
    editable: !this.readOnly && (this.isContentEditable || this.localName === 'textarea' ||
      (this.localName === 'input' && ['text','search','email','url','tel','password','number'].includes(this.type))) };
}`

interface Target {
  x: number
  y: number
  disabled: boolean
  editable: boolean
  error?: string
}

/**
 * Before each input, where it lands (the page's CSS pixels) and whether it clicks: during a
 * walkthrough the user's visible pointer goes there first, at a pace they can follow.
 */
export type BeforeInput = (at: { x: number; y: number }, click: boolean) => Promise<void>

/** Real Chromium input in the shared preview; serializes with screenshots and picking. */
export class PreviewInteractions {
  constructor(
    private readonly inspector: Inspector,
    private readonly assertLoaded: () => void,
    private readonly beforeInput: BeforeInput = async () => {},
  ) {}

  /** The one element `selector` matches, scrolled into view: its node, to point at. */
  async locate(selector: string) {
    return this.exclusive(async () => {
      const node = await this.uniqueNode(selector)
      await this.cmd('DOM.scrollIntoViewIfNeeded', { backendNodeId: node }).catch(() => undefined)
      return node
    })
  }

  async snapshot() {
    return this.exclusive(async () => {
      const { result, exceptionDetails } = await this.cmd<{
        result: { value?: unknown }
        exceptionDetails?: unknown
      }>('Runtime.evaluate', { expression: SNAPSHOT, returnByValue: true })
      if (exceptionDetails || !result.value) throw new Error('Could not read the preview page')
      return result.value
    })
  }

  async click(selector: string) {
    return this.exclusive(async () => {
      const target = await this.target(selector)
      if (target.disabled) throw new Error('The target is disabled')
      await this.beforeInput(target, true)
      await this.clickAt(target)
    })
  }

  async hover(selector: string) {
    return this.exclusive(async () => {
      const { x, y } = await this.target(selector)
      await this.beforeInput({ x, y }, false)
      await this.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    })
  }

  async type(selector: string, text: string, replace = true) {
    return this.exclusive(async () => {
      const target = await this.target(selector)
      if (target.disabled || !target.editable)
        throw new Error('The target is not an editable field')
      await this.beforeInput(target, true)
      await this.clickAt(target)
      // Gui keeps the chat's keyboard while the agent works. Focus the DOM field without
      // bringing the app window forward, then verify a handler didn't replace it.
      const node = await this.uniqueNode(selector)
      await this.cmd('DOM.focus', { backendNodeId: node })
      const focused = await this.callOn<boolean>(
        node,
        `function () {
        return this === document.activeElement || (this.isContentEditable && this.contains(document.activeElement));
      }`,
      )
      if (!focused) throw new Error('The target did not receive focus; take a fresh snapshot')
      if (replace) {
        const modifiers = process.platform === 'darwin' ? 4 : 2
        await this.cmd('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: 'a',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
          modifiers,
          commands: ['selectAll'],
        })
        await this.cmd('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'a',
          code: 'KeyA',
          modifiers,
        })
      }
      if (text) await this.cmd('Input.insertText', { text })
      else if (replace) await this.key('Backspace', false)
    })
  }

  async press(key: PreviewKey, selector?: string, shift = false) {
    return this.exclusive(async () => {
      if (selector) {
        const target = await this.target(selector)
        if (target.disabled) throw new Error('The target is disabled')
        await this.beforeInput(target, false)
        await this.cmd('DOM.focus', { backendNodeId: await this.uniqueNode(selector) })
      }
      await this.key(key, shift)
    })
  }

  async scroll(deltaY: number, deltaX = 0, selector?: string) {
    return this.exclusive(async () => {
      let point: { x: number; y: number }
      if (selector) {
        point = await this.target(selector)
        await this.beforeInput(point, false)
      } else {
        const { cssVisualViewport: viewport } = await this.cmd<{
          cssVisualViewport: { clientWidth: number; clientHeight: number }
        }>('Page.getLayoutMetrics')
        point = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }
      }
      await this.cmd('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: point.x,
        y: point.y,
        deltaX,
        deltaY,
      })
    })
  }

  private exclusive<T>(action: () => Promise<T>) {
    return this.inspector.exclusive((session) =>
      session.withoutHighlight(async () => {
        // Check inside the lock too: a preceding action may have navigated away.
        this.assertLoaded()
        return action()
      }),
    )
  }

  private async uniqueNode(selector: string) {
    const { root } = await this.cmd<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 })
    const { nodeIds } = await this.cmd<{ nodeIds: number[] }>('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector,
    })
    if (nodeIds.length !== 1) {
      throw new Error(
        nodeIds.length
          ? `${selector} matches ${nodeIds.length} elements; use a unique selector`
          : `No element matches ${selector}`,
      )
    }
    const { node } = await this.cmd<{ node: { backendNodeId: number } }>('DOM.describeNode', {
      nodeId: nodeIds[0],
    })
    return node.backendNodeId
  }

  private async target(selector: string) {
    const node = await this.uniqueNode(selector)
    await this.cmd('DOM.scrollIntoViewIfNeeded', { backendNodeId: node }).catch(() => undefined)
    const target = await this.callOn<Target>(node, TARGET)
    if (target.error) throw new Error(target.error)
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y))
      throw new Error('The target has no input position')
    return target
  }

  private async clickAt({ x, y }: { x: number; y: number }) {
    await this.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.cmd('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
    await this.cmd('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
  }

  private async key(key: PreviewKey, shift: boolean) {
    const value = key === 'Space' ? ' ' : key
    const text = key === 'Enter' ? '\r' : key === 'Space' ? ' ' : undefined
    const params = {
      key: value,
      code: key,
      windowsVirtualKeyCode: KEY_CODES[key],
      modifiers: shift ? 8 : 0,
    }
    await this.cmd('Input.dispatchKeyEvent', {
      ...params,
      type: text ? 'keyDown' : 'rawKeyDown',
      text,
    })
    await this.cmd('Input.dispatchKeyEvent', { ...params, type: 'keyUp' })
  }

  private async callOn<T>(backendNodeId: number, functionDeclaration: string): Promise<T> {
    const { object } = await this.cmd<{ object: { objectId: string } }>('DOM.resolveNode', {
      backendNodeId,
    })
    try {
      const { result, exceptionDetails } = await this.cmd<{
        result: { value: T }
        exceptionDetails?: unknown
      }>('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration,
        returnByValue: true,
      })
      if (exceptionDetails) throw new Error('Could not read the target; take a fresh snapshot')
      return result.value
    } finally {
      await this.cmd('Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined)
    }
  }

  private cmd<T = unknown>(method: string, params?: Record<string, unknown>) {
    return this.inspector.command<T>(method, params)
  }
}
