import { FolderOpen, TriangleAlert } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import type { WindowState } from '../../../shared/types'
import { grat } from '../lib/api'
import { Button, Spinner } from '../lib/ui'

/**
 * The preview is a native view layered over this element; we report our bounds so
 * main can position it. What we render here only shows while the preview is hidden.
 */
export function Canvas({ state }: { state: WindowState }) {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let frame = 0
    const report = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect()
        grat.setCanvasRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
      })
    }
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)
    report()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [])

  return (
    <main ref={ref} className="relative min-h-0 flex-1 bg-canvas">
      <div className="absolute inset-0 flex items-center justify-center p-8">
        <CanvasMessage state={state} />
      </div>
    </main>
  )
}

function CanvasMessage({ state }: { state: WindowState }) {
  const { project, devServer, preview } = state

  if (!project) return <EmptyState state={state} />

  if (preview.error) {
    return (
      <Message
        icon={<TriangleAlert className="size-5 text-danger" aria-hidden="true" />}
        title="The preview couldn't load"
        detail={preview.error}
        action={<Button onClick={() => grat.reload()}>Retry</Button>}
      />
    )
  }

  if (devServer.status === 'starting' || (devServer.status === 'running' && !preview.visible)) {
    return (
      <Message
        icon={<Spinner className="size-4 text-muted" />}
        title={devServer.status === 'starting' ? 'Starting dev server' : 'Loading preview'}
        detail={devServer.lastLine || devServer.command || ''}
        mono
      />
    )
  }

  if (devServer.status === 'exited') {
    return (
      <Message
        icon={<TriangleAlert className="size-5 text-danger" aria-hidden="true" />}
        title="The dev server stopped"
        detail={devServer.lastLine || `Exit code ${devServer.exitCode}`}
        mono
        action={<Button onClick={() => grat.restartDevServer()}>Restart</Button>}
      />
    )
  }

  if (!project.devCommand && !preview.url) {
    return (
      <Message
        title="No dev script found"
        detail="Add a dev script to package.json, or enter your app's URL in the address bar."
      />
    )
  }

  if (devServer.status === 'idle' && !preview.visible) {
    return (
      <Message
        title="Dev server is stopped"
        detail={project.devCommand ?? ''}
        mono
        action={
          <Button variant="primary" onClick={() => grat.startDevServer()}>
            Start dev server
          </Button>
        }
      />
    )
  }

  return null
}

interface MessageProps {
  icon?: ReactNode
  title: string
  detail: string
  mono?: boolean
  action?: ReactNode
}

function Message({ icon, title, detail, mono, action }: MessageProps) {
  return (
    <div className="flex max-w-md flex-col items-center gap-2 text-center">
      {icon}
      <p className="font-medium text-[13px]">{title}</p>
      {detail && (
        <p className={mono ? 'line-clamp-3 font-mono text-[11px] text-subtle' : 'text-muted'}>
          {detail}
        </p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

function EmptyState({ state }: { state: WindowState }) {
  return (
    <div className="flex w-full max-w-sm flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-[15px]">Open a project</h1>
        <p className="text-muted">
          Grat runs your dev server, shows your app, and lets your agent edit it while you point at
          things.
        </p>
      </div>
      <Button variant="primary" className="h-8 self-start" onClick={() => void grat.openProject()}>
        <FolderOpen className="size-3.5" aria-hidden="true" />
        Open project…
      </Button>
      {state.recent.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="font-medium text-[11px] text-subtle uppercase tracking-wide">Recent</p>
          <ul className="-mx-2 flex flex-col">
            {state.recent.slice(0, 6).map((project) => (
              <li key={project.root}>
                <button
                  type="button"
                  onClick={() => void grat.openRecent(project.root)}
                  className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-hover"
                >
                  <span className="font-medium">{project.name}</span>
                  <span className="w-full truncate font-mono text-[11px] text-subtle">
                    {project.root}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
