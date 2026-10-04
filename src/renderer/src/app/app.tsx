import { useWindowState } from '../lib/use-window-state'
import { Canvas, EnvBanner } from './canvas'
import { Logs } from './logs'
import { Toolbar } from './toolbar'

export function App() {
  const state = useWindowState()
  if (!state) return <div className="drag h-dvh bg-surface" />
  return (
    <div className="flex h-dvh flex-col">
      <Toolbar state={state} />
      {/* Outside the canvas, so the preview is laid out below it. Keyed so a dismissal is per project. */}
      <EnvBanner key={state.project?.root} state={state} />
      <Canvas state={state} />
      <Logs state={state} />
    </div>
  )
}
