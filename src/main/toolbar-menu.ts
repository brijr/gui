import { type BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { SHORTCUTS } from '../shared/shortcuts'
import type { ToolbarMenuItem } from '../shared/types'

export { toolbarMenuItems } from '../shared/toolbar-menu'

/*
 * The toolbar's overflow ("…") menu. The chrome decides what's in it (the tools it had no room
 * for, renderer app/toolbar-fit.ts) and does what's chosen; this only shows it as a native
 * menu, which, unlike a popover in the page, can open over the preview.
 */

/** Shows `items` at `at` in `win`; resolves with the chosen item's id, or null. */
export function showToolbarMenu(
  win: BrowserWindow,
  items: ToolbarMenuItem[],
  at: { x: number; y: number },
): Promise<string | null> {
  return new Promise((resolve) => {
    const template = items.map((item): MenuItemConstructorOptions => {
      if (item.type === 'separator') return { type: 'separator' }
      return {
        type: item.type ?? 'normal',
        label: item.label,
        enabled: item.enabled ?? true,
        checked: item.checked,
        // Shown, not registered: the app menu's item already answers the keys.
        ...(item.shortcut && {
          accelerator: SHORTCUTS[item.shortcut].accelerator,
          registerAccelerator: false,
        }),
        click: () => resolve(item.id),
      }
    })
    Menu.buildFromTemplate(template).popup({
      window: win,
      x: Math.round(at.x),
      y: Math.round(at.y),
      // Electron runs a chosen item's click before this, so this only settles a dismissal.
      callback: () => resolve(null),
    })
  })
}
