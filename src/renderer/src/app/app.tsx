import { useWindowState } from '../lib/use-window-state'
import { Canvas } from './canvas'
import { Logs } from './logs'
import { Toolbar } from './toolbar'

export function App() {
  const state = useWindowState()
  if (!state) return <div className="drag h-dvh bg-surface" />
  return (
    <div className="flex h-dvh flex-col">
      <Toolbar state={state} />
      <Canvas state={state} />
      <Logs state={state} />
    </div>
  )
}
