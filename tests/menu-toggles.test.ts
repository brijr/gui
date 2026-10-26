import { describe, expect, test } from 'bun:test'
import { chatWillHide, terminalWillHide } from '../src/main/menu-toggles'

describe('View menu: Show or Hide', () => {
  test('Hide Chat only while the chat shows in the window', () => {
    const shown = { chatVisible: true, poppedOut: false, focusMode: false }
    expect(chatWillHide(shown)).toBe(true)
    expect(chatWillHide({ ...shown, chatVisible: false })).toBe(false)
    // ⌘B brings a popped-out chat forward, and shows it in focus mode.
    expect(chatWillHide({ ...shown, poppedOut: true })).toBe(false)
    expect(chatWillHide({ ...shown, focusMode: true })).toBe(false)
  })

  test('Hide Terminal only while the drawer is open and showing', () => {
    expect(terminalWillHide({ drawerOpen: true, focusMode: false })).toBe(true)
    expect(terminalWillHide({ drawerOpen: false, focusMode: false })).toBe(false)
    expect(terminalWillHide({ drawerOpen: true, focusMode: true })).toBe(false)
  })
})
