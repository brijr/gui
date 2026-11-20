import type { KeepAwakeMode } from '../shared/types'

export class SleepPrevention {
  private readonly working = new Set<object>()
  private mode: KeepAwakeMode = 'off'
  private release: (() => void) | null = null
  private disposed = false

  constructor(private readonly acquire: () => () => void) {}

  setMode(mode: KeepAwakeMode) {
    if (this.disposed) return
    this.mode = mode
    this.sync()
  }

  setWorking(source: object, working: boolean) {
    if (this.disposed) return
    if (working) this.working.add(source)
    else this.working.delete(source)
    this.sync()
  }

  dispose() {
    this.disposed = true
    this.working.clear()
    this.mode = 'off'
    this.sync()
  }

  private sync() {
    const wanted = this.mode === 'always' || (this.mode === 'working' && this.working.size > 0)
    if (wanted) this.release ??= this.acquire()
    else if (this.release) {
      this.release()
      this.release = null
    }
  }
}
