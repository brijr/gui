import { expect, test } from 'bun:test'
import { toolbarMenuItems } from '../src/shared/toolbar-menu'

test("the toolbar's overflow menu takes well-formed items only", () => {
  const items = [
    { id: 'back', label: 'Back', shortcut: 'back', enabled: false },
    { type: 'separator' },
    { type: 'radio', id: 'viewport:mobile', label: 'Mobile', checked: true },
  ]
  expect(toolbarMenuItems(items)).toEqual([
    {
      type: 'normal',
      id: 'back',
      label: 'Back',
      shortcut: 'back',
      enabled: false,
      checked: undefined,
    },
    { type: 'separator' },
    {
      type: 'radio',
      id: 'viewport:mobile',
      label: 'Mobile',
      shortcut: undefined,
      enabled: undefined,
      checked: true,
    },
  ])
  expect(toolbarMenuItems('nope')).toBeNull()
  expect(toolbarMenuItems([{ id: 'x', label: 'X', shortcut: 'notAShortcut' }])).toBeNull()
  expect(toolbarMenuItems([{ id: 'x', label: 'X', shortcut: 'toString' }])).toBeNull()
  expect(toolbarMenuItems([{ id: '', label: 'X' }])).toBeNull()
  expect(toolbarMenuItems([{ id: 'x', label: 'X', type: 'submenu' }])).toBeNull()
  expect(toolbarMenuItems(Array.from({ length: 40 }, () => ({ type: 'separator' })))).toBeNull()
})
