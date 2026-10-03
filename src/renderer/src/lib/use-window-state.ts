import { useEffect, useState } from 'react'
import type { WindowState } from '../../../shared/types'
import { grat } from './api'

export function useWindowState() {
  const [state, setState] = useState<WindowState | null>(null)
  useEffect(() => {
    let live = true
    const off = grat.onState(setState)
    void grat.getState().then((initial) => {
      if (live) setState((current) => current ?? initial)
    })
    return () => {
      live = false
      off()
    }
  }, [])
  return state
}
