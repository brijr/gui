import type { GratApi } from '../shared/ipc'

declare global {
  interface Window {
    grat: GratApi
  }
}
