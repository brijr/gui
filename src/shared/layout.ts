/**
 * Geometry main and the renderer both lay out against: main positions windows and native
 * views with it, the renderer draws the matching chrome.
 */

/** The window's toolbar; main lays the preview out below it. */
export const TOOLBAR_HEIGHT = 44

/** Where the window's traffic lights sit (main and Settings windows). */
export const TRAFFIC_LIGHTS = { x: 16, y: 15 } as const

/** Room the toolbar leaves on its left for the traffic lights. */
export const TRAFFIC_LIGHTS_INSET = 84

/** Transparent margin around the floating chat panel, so its shadow isn't clipped. */
export const PANEL_SHADOW_MARGIN = 18

/** The floating panel while the user picks an element: a round button at its anchored corner. */
export const BUBBLE = { width: 44, height: 44 } as const

/** The minimized chat pill. */
export const MINI = { width: 248, height: 52 } as const
