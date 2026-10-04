import { Fragment } from 'react'
import { useWindowState } from '../lib/use-window-state'
import { Canvas, EnvBanner } from './canvas'
import { Drawer } from './drawer'
import { TabStrip } from './tab-strip'
import { Toolbar } from './toolbar'

export function App() {
  const state = useWindowState()
  if (!state) return <div className="drag h-dvh bg-surface" />
  return (
    <div className="flex h-dvh flex-col">
      <TabStrip state={state} />
      {/* Keyed by tab, so each tab's project gets its own toolbar, canvas and drawer. */}
      <Fragment key={state.activeTab}>
        <Toolbar state={state} />
        {/* Outside the canvas, so the preview is laid out below it. Keyed so a dismissal is per project. */}
        <EnvBanner key={state.project?.root} state={state} />
        <Canvas state={state} />
        <Drawer state={state} />
      </Fragment>
    </div>
  )
}
