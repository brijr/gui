import { Fragment, useEffect, useRef } from 'react'
import { FOCUS_BAR_HEIGHT } from '../../../shared/layout'
import type { WindowState } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { Button } from '../lib/ui'
import { useWindowState } from '../lib/use-window-state'
import { Canvas, EnvBanner } from './canvas'
import { Drawer } from './drawer'
import { useLayoutMorphs } from './layout-morph'
import { ShortcutsSheet } from './shortcuts-sheet'
import { TabStrip } from './tab-strip'
import { focusAddressBar, Toolbar } from './toolbar'

export function App() {
  const state = useWindowState()
  const focusMode = state?.focusMode ?? false
  const sheet = state?.shortcutsOpen ?? false
  const morphs = useRef<HTMLDivElement>(null)
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
    <div className="relative flex h-dvh flex-col">
      {/* The preview's layout morphs: over the canvas, under the bars and the drawer. */}
      <div ref={morphs} aria-hidden="true" className="pointer-events-none fixed inset-0 z-10" />
      {!state ? (
        <div className="drag h-dvh bg-surface" />
      ) : (
        <>
          {focusMode && <FocusBar state={state} />}
          {/* Focus mode hides the bars rather than unmounting them, so they come back as they were. */}
          <div className={cn('relative z-20 shrink-0', focusMode && 'hidden')}>
            <TabStrip state={state} />
            {/* Keyed by tab, so each tab's project gets its own toolbar, canvas and drawer. */}
            <Fragment key={state.activeTab}>
              <Toolbar state={state} />
              {/* Outside the canvas, so the preview is laid out below it. Keyed so a dismissal is per project. */}
              <EnvBanner key={state.project?.root} state={state} />
            </Fragment>
          </div>
          <Fragment key={state.activeTab}>
            <Canvas state={state} />
            <Drawer state={state} />
          </Fragment>
          {sheet && <ShortcutsSheet />}
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
      className="drag relative z-20 flex shrink-0 items-center justify-end border-b border-line bg-surface pr-2"
      style={{ height: FOCUS_BAR_HEIGHT }}
    >
      <p className="pointer-events-none absolute inset-x-40 truncate text-center text-caption font-medium text-subtle">
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
