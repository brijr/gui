import type { BoardSession } from './board-session'
import type { ChatController } from './chat'
import type { DevServer } from './dev-server'
import type { RunningMcpServer } from './mcp-server'
import type { PreviewTools } from './preview-tools'
import type { Recordings } from './recordings'
import type { Terminals } from './terminals'

interface HistoryClaims {
  release(file: string): void
  retire(root: string, file: string): void | Promise<void>
}

/** One project opening's lifetime, including resources created before it becomes visible. */
export class ProjectResources {
  devServer: DevServer | null = null
  terminals: Terminals | null = null
  chat: ChatController | null = null
  recordings: Recordings | null = null
  mcp: RunningMcpServer | null = null
  previewTools: PreviewTools | null = null
  /** The canvas this is, when it's one rather than a project */
  board: BoardSession | null = null
  historyFile: string | null = null
  historyRoot: string | null = null
  private claimedFile: string | null = null
  private disposed = false
  private completion: Promise<void> | null = null
  /** Bumped on dispose so a captured token from this opening fails `stillCurrent`. */
  private gen = 0
  private closing = new AbortController()

  constructor(private readonly history: HistoryClaims) {}

  get active() {
    return !this.disposed
  }

  get generation() {
    return this.gen
  }

  /** Aborts on dispose, for long work (a website capture) that can stop part way. */
  get signal() {
    return this.closing.signal
  }

  /** False once this opening has been closed or replaced. */
  stillCurrent(generation: number) {
    return this.active && generation === this.gen
  }

  /** Runs `fn` only while this opening is still the live one; otherwise drops the result. */
  ifCurrent<T>(generation: number, fn: () => T): T | undefined {
    if (!this.stillCurrent(generation)) return undefined
    return fn()
  }

  /** A claim that finishes after close is immediately returned to the history pool. */
  claim(file: string): boolean {
    if (this.disposed) {
      this.history.release(file)
      return false
    }
    this.claimedFile = file
    return true
  }

  attachHistory(root: string, file: string) {
    if (this.disposed || file !== this.claimedFile) throw new Error('Project lifetime ended')
    this.historyRoot = root
    this.historyFile = file
  }

  /** The MCP listener may finish opening while its project is being replaced. */
  attachMcp(mcp: RunningMcpServer | null): boolean {
    if (this.disposed) {
      mcp?.close()
      return false
    }
    this.mcp = mcp
    return true
  }

  dispose(): Promise<void> {
    if (this.completion) return this.completion
    this.gen++
    this.disposed = true
    this.closing.abort()
    let complete!: () => void
    this.completion = new Promise<void>((resolve) => {
      complete = resolve
    })
    // Clear ownership before teardown: callbacks during disposal see no live project.
    const {
      devServer,
      terminals,
      chat,
      recordings,
      mcp,
      board,
      claimedFile,
      historyFile,
      historyRoot,
    } = this
    this.devServer = null
    this.board = null
    this.terminals = null
    this.chat = null
    this.recordings = null
    this.mcp = null
    this.previewTools = null
    this.claimedFile = null
    this.historyFile = null
    this.historyRoot = null
    const safely = (cleanup: () => unknown) => {
      try {
        return cleanup()
      } catch (error) {
        console.error('[gui] project resource teardown failed', error)
      }
    }
    // They stop in the background; the opening isn't over until they have exited, so a
    // worktree's folder is never removed, nor the project reopened, under a live process.
    const exited = Promise.all([
      safely(() => devServer?.dispose()),
      safely(() => terminals?.dispose()),
    ]).catch((error: unknown) => console.error('[gui] project process teardown failed', error))
    const saved = safely(() => chat?.dispose())
    safely(() => mcp?.close())
    const boardSaved = safely(() => board?.dispose())
    // History must remain claimed until the last save completes. Recordings also remain
    // available until chat persistence has captured its references.
    const retired = Promise.all([
      Promise.resolve(saved).catch((error: unknown) =>
        console.error('[gui] final chat save failed', error),
      ),
      Promise.resolve(boardSaved).catch((error: unknown) =>
        console.error('[gui] final canvas save failed', error),
      ),
    ]).then(async () => {
      try {
        await safely(() => {
          if (historyFile && historyRoot) return this.history.retire(historyRoot, historyFile)
          if (claimedFile) this.history.release(claimedFile)
        })
      } catch (error) {
        console.error('[gui] history retirement failed', error)
      }
      safely(() => recordings?.dispose())
    })
    void Promise.all([retired, exited]).then(complete)
    return this.completion
  }
}
