import type { Locator, Page } from '@playwright/test'

/**
 * The text on screen in the drawer terminal inside `scope`. Ghostty draws to a canvas; its host
 * keeps the text (app/terminal.ts `terminalText`).
 */
export function screenText(scope: Locator) {
  return scope
    .locator('[data-terminal]')
    .evaluate((el) => (el as HTMLElement & { terminalText?: string }).terminalText ?? '')
}

/** Whether the keyboard is in a drawer terminal: its host has it. */
export function terminalFocused(page: Page) {
  return page.evaluate(() => document.activeElement?.hasAttribute('data-terminal') ?? false)
}
