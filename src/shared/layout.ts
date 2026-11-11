/**
 * Geometry main and the renderer both lay out against: main positions windows and native
 * views with it, the renderer draws the matching chrome.
 */

/** The window's toolbar; main lays the preview out below it. */
export const TOOLBAR_HEIGHT = 44

/** Where the window's traffic lights sit (main and Settings windows). */
export const TRAFFIC_LIGHTS = { x: 16, y: 15 } as const

/** The tab row above the toolbar, shown while a window has two or more tabs (tab-strip.tsx). */
export const TAB_ROW_HEIGHT = 36

/** The traffic lights while the tab row shows: centered in it. */
export const TAB_ROW_TRAFFIC_LIGHTS = { x: 16, y: 11 } as const

/** Focus mode's title bar, all there is above the preview: room to drag the window by. */
export const FOCUS_BAR_HEIGHT = 28

/** The traffic lights in focus mode's title bar: centered in it. */
export const FOCUS_TRAFFIC_LIGHTS = { x: 16, y: 7 } as const

/** Room the toolbar leaves on its left for the traffic lights. */
export const TRAFFIC_LIGHTS_INSET = 84

/** Transparent margin around the floating chat panel, so its shadow isn't clipped. */
export const PANEL_SHADOW_MARGIN = 18

/** The floating panel while the user picks an element: a round button at its anchored corner. */
export const BUBBLE = { width: 44, height: 44 } as const

/** Room a device frame (a fixed viewport) leaves around it on the canvas. */
export const FRAME_MARGIN = 24

/** The line above a device frame that names it: "Laptop · 1440 × 900 · 80%". */
export const FRAME_LABEL_HEIGHT = 24

/** The rulers along the canvas's top and left edges (⇧R), which the preview moves over for. */
export const RULER_SIZE = 20
