import type { BrowserWindowConstructorOptions } from 'electron'
import { TRAFFIC_LIGHTS } from '../shared/layout'
import { IS_MAC, IS_WINDOWS } from '../shared/platform'

export const DEFAULT_SHELL = IS_MAC ? '/bin/zsh' : '/bin/bash'

const systemRoot = () => process.env.SystemRoot ?? 'C:\\Windows'

/** bsdtar: macOS's and Windows 10's (System32\tar.exe, which also unpacks .zip). */
export const tarPath = () =>
  IS_WINDOWS ? `${systemRoot()}\\System32\\tar.exe` : '/usr/bin/tar'

export function windowChrome(): BrowserWindowConstructorOptions {
  return IS_MAC
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: TRAFFIC_LIGHTS }
    : { autoHideMenuBar: true }
}
