import { SHORTCUTS, type ShortcutId } from './shortcuts'
import type { ToolbarMenuItem } from './types'

/** What the chrome may put in the toolbar's "…" menu (main/toolbar-menu.ts shows it). */
const MAX_ITEMS = 32
const MAX_LABEL = 100
const MAX_ID = 64

const isShortcut = (value: unknown): value is ShortcutId =>
  typeof value === 'string' && Object.hasOwn(SHORTCUTS, value)

/** The items, if they're well-formed; null otherwise. */
export function toolbarMenuItems(value: unknown): ToolbarMenuItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null
  const items: ToolbarMenuItem[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null
    const item = raw as Record<string, unknown>
    if (item.type === 'separator') {
      items.push({ type: 'separator' })
      continue
    }
    const type = item.type ?? 'normal'
    if (type !== 'normal' && type !== 'checkbox' && type !== 'radio') return null
    if (typeof item.id !== 'string' || !item.id || item.id.length > MAX_ID) return null
    if (typeof item.label !== 'string' || !item.label || item.label.length > MAX_LABEL) return null
    if (item.shortcut !== undefined && !isShortcut(item.shortcut)) return null
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') return null
    if (item.checked !== undefined && typeof item.checked !== 'boolean') return null
    items.push({
      type,
      id: item.id,
      label: item.label,
      shortcut: item.shortcut,
      enabled: item.enabled,
      checked: item.checked,
    })
  }
  return items
}
