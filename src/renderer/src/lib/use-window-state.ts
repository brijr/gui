import { useEffect, useState } from 'react'
import type { WindowState } from '../../../shared/types'
import { gui } from './api'

export function useWindowState() {
  const [state, setState] = useState<WindowState | null>(null)
  useEffect(() => {
    let live = true
    const off = gui.onState(setState)
    void gui.getState().then((initial) => {
      if (live) setState((current) => current ?? initial)
    })
    return () => {
      live = false
      off()
    }
  }, [])
  return state
}
