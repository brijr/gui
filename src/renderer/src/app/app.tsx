import { Fragment, useEffect } from 'react'
import { FOCUS_BAR_HEIGHT } from '../../../shared/layout'
import type { WindowState } from '../../../shared/types'
import { gui } from '../lib/api'
import { Button } from '../lib/ui'
import { useWindowState } from '../lib/use-window-state'
import { Canvas, EnvBanner } from './canvas'
import { Drawer } from './drawer'
import { TabStrip } from './tab-strip'
import { focusAddressBar, Toolbar } from './toolbar'

export function App() {
  const state = useWindowState()
  const focusMode = state?.focusMode ?? false
  // Here rather than in the toolbar, which may only be on its way.
  useEffect(
    () =>
      gui.onCommand((command) => {
        if (command === 'focusAddress') focusAddressBar()
      }),
    [],
  )
  // Esc ends focus mode here; on the page, main sees it first (tab.ts).
  useEffect(() => {
    if (!focusMode) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) gui.setFocusMode(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [focusMode])

  if (!state) return <div className="drag h-dvh bg-surface" />
  // Focus mode hides the chrome rather than unmounting it, so it comes back as it was.
  const chrome = focusMode ? 'hidden' : 'contents'
  return (
    <div className="flex h-dvh flex-col">
      {focusMode && <FocusBar state={state} />}
      <div className={chrome}>
        <TabStrip state={state} />
      </div>
      {/* Keyed by tab, so each tab's project gets its own toolbar, canvas and drawer. */}
      <Fragment key={state.activeTab}>
        <div className={chrome}>
          <Toolbar state={state} />
          {/* Outside the canvas, so the preview is laid out below it. Keyed so a dismissal is per project. */}
          <EnvBanner key={state.project?.root} state={state} />
        </div>
        <Canvas state={state} />
        <div className={chrome}>
          <Drawer state={state} />
        </div>
      </Fragment>
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
      className="drag relative flex shrink-0 items-center justify-end border-b border-line bg-surface pr-2"
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
