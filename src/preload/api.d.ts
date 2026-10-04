import type { GuiApi } from '../shared/ipc'

declare global {
  interface Window {
    gui: GuiApi
  }
}
