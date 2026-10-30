import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportError } from './crash-reports'
import { Button } from './ui'

interface Props {
  /** What it shows in place of what failed; `retry` draws it again. The default says so in a line. */
  fallback?: (retry: () => void) => ReactNode
  /** Tries drawing again whenever this changes, as when what failed to draw has been updated */
  resetKey?: unknown
  children: ReactNode
}

/**
 * Keeps an error drawing one part from blanking the rest: React unmounts everything up to
 * the nearest boundary. Agent output is drawn inside these, so whatever an agent writes can
 * take down at most its own block.
 */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[gui] render failed', error, info.componentStack)
    reportError(error)
  }

  componentDidUpdate(previous: Props) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.retry()
  }

  retry = () => this.setState({ failed: false })

  render() {
    if (!this.state.failed) return this.props.children
    if (this.props.fallback) return this.props.fallback(this.retry)
    return <p className="text-small text-danger">Couldn’t show this part.</p>
  }
}

/** A whole window's fallback: what failed can't be drawn, so offer to load it again. */
export function windowFallback() {
  return (
    <div className="flex h-dvh flex-col items-start justify-center gap-3 bg-raised p-6">
      <p className="text-small text-fg">Gui couldn’t draw this window.</p>
      <Button onClick={() => window.location.reload()}>Reload</Button>
    </div>
  )
}
