import { Fragment, useEffect, useRef } from 'react'
import { FOCUS_BAR_HEIGHT, TOOLBAR_HEIGHT } from '../../../shared/layout'
import type { WindowState } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { Button } from '../lib/ui'
import { useWindowState } from '../lib/use-window-state'
import { Canvas, EnvBanner } from './canvas'
import { Drawer } from './drawer'
import { useLayoutMorphs, useLayoutSlide } from './layout-morph'
import { ShortcutsSheet } from './shortcuts-sheet'
import { TabStrip } from './tab-strip'
import { focusAddressBar, Toolbar } from './toolbar'

export function App() {
  const state = useWindowState()
  const focusMode = state?.focusMode ?? false
  const sheet = state?.shortcutsOpen ?? false
  const bars = useRef<HTMLDivElement>(null)
  const morphs = useRef<HTMLDivElement>(null)
  // Focus mode slides the tab strip and the toolbar up out of the window as the preview grows
  // into their room, fading; out of it they come back the same way.
  const leaving = useLayoutSlide(!focusMode, bars, {
    edge: 'top',
    keep: FOCUS_BAR_HEIGHT,
    fade: true,
  })
  useLayoutMorphs(morphs, state?.activeTab ?? null)
  // Here rather than in the toolbar, which may only be on its way.
  useEffect(
    () =>
      gui.onCommand((command) => {
        if (command === 'focusAddress') focusAddressBar()
      }),
    [],
  )
  // Esc ends focus mode here; on the page, main sees it first (tab.ts). The sheet's own Esc
  // only closes the sheet.
  useEffect(() => {
    if (!focusMode || sheet) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) gui.setFocusMode(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [focusMode, sheet])

  return (
    // Clipped, never scrolled: the drawer and the bars slide in from past the window's edges,
    // and focusing something in them on the way must not scroll the whole window to it.
    <div
      className="relative flex h-dvh flex-col overflow-clip bg-canvas bg-clip-content"
      // The chat sidebar (its own view, from main) runs down the left: everything here starts
      // right of it, and its strip stays unpainted (bg-clip-content) for the window's material.
      style={{ paddingLeft: state?.sidebarWidth || undefined }}
    >
      {/* The preview's layout morphs: over the canvas, under the bars and the drawer. It's the
          canvas's own content moving, not chrome, so it takes the layer below chrome's: the
          bars and the drawer slide over the snapshot as they would over the preview. */}
      <div ref={morphs} aria-hidden="true" className="pointer-events-none fixed inset-0 z-sticky" />
      {!state ? (
        <div className="drag h-dvh bg-surface" />
      ) : (
        <>
          {focusMode && <FocusBar state={state} />}
          {/* Focus mode hides the bars rather than unmounting them, so they come back as they were. */}
          <div
            ref={bars}
            className={cn(
              'z-chrome shrink-0',
              focusMode && leaving ? 'absolute inset-x-0 top-0' : 'relative',
              focusMode && !leaving && 'hidden',
            )}
          >
            <TabStrip state={state} />
            {/* Keyed by tab, so each tab's project gets its own toolbar, canvas and drawer. */}
            <Fragment key={state.activeTab}>
              {state.project && <Toolbar state={state} />}
              {/* Outside the canvas, so the preview is laid out below it. Keyed so a dismissal is per project. */}
              <EnvBanner key={state.project?.root} state={state} />
            </Fragment>
          </div>
          {!state.project && state.tabs.length === 1 && (
            <div
              aria-hidden="true"
              className="drag absolute inset-x-0 top-0 z-chrome"
              style={{ height: TOOLBAR_HEIGHT }}
            />
          )}
          <Fragment key={state.activeTab}>
            <Canvas state={state} />
            <Drawer state={state} />
          </Fragment>
          <ShortcutsSheet open={sheet} />
        </>
      )}
    </div>
  )
}

/**
 * Focus mode's title bar, all that shows above the preview: room for the traffic lights, a
 * place to drag the window by, the project's name, and the way out (also ⌘\ or Esc).
 */
function FocusBar({ state }: { state: WindowState }) {
  return (
    <header
      className="drag relative z-chrome flex shrink-0 items-center gap-2 border-b border-line bg-surface pr-2 pl-20"
      style={{ height: FOCUS_BAR_HEIGHT }}
    >
      {/* After the traffic lights, left-aligned like every other title in Gui */}
      <p className="pointer-events-none min-w-0 flex-1 truncate text-caption font-medium text-subtle">
        {state.project?.name}
      </p>
      <Button
        variant="ghost"
        size="sm"
        shortcut="focusMode"
        onClick={() => gui.setFocusMode(false)}
      >
        Exit focus mode
      </Button>
    </header>
  )
}
