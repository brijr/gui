import { useEffect, useState } from 'react'

/** Fast reloads need no spinner; keep longer ones from flashing on their first frame. */
export function useDelayedLoading(loading: boolean) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!loading) {
      setShown(false)
      return
    }
    const timer = window.setTimeout(() => setShown(true), 150)
    return () => window.clearTimeout(timer)
  }, [loading])
  return loading && shown
}
