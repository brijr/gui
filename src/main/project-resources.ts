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

  constructor(private readonly history: HistoryClaims) {}

  get active() {
    return !this.disposed
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
    this.disposed = true
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
    safely(() => devServer?.dispose())
    safely(() => terminals?.dispose())
    const saved = safely(() => chat?.dispose())
    safely(() => mcp?.close())
    safely(() => board?.dispose())
    // History must remain claimed until the last save completes. Recordings also remain
    // available until chat persistence has captured its references.
    void Promise.resolve(saved)
      .catch((error: unknown) => console.error('[gui] final chat save failed', error))
      .then(async () => {
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
      .then(complete)
    return this.completion
  }
}
