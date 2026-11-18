type Platform = 'mac' | 'windows' | 'linux'

function detectPlatform(): Platform {
  const scope = globalThis as {
    process?: { platform?: string }
    navigator?: { platform?: string; userAgent?: string }
  }
  const platform = scope.process?.platform
  if (typeof platform === 'string') {
    return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux'
  }
  const agent = scope.navigator?.platform || scope.navigator?.userAgent || ''
  return /mac/i.test(agent) ? 'mac' : /win/i.test(agent) ? 'windows' : 'linux'
}

const PLATFORM = detectPlatform()

export const IS_MAC = PLATFORM === 'mac'
export const IS_WINDOWS = PLATFORM === 'windows'
/** Linux and the other Unixes: anything that is neither macOS nor Windows. */
export const IS_LINUX = PLATFORM === 'linux'

/** The computer Gui runs on, in prose: "isn't installed on this Mac" / "on this computer". */
export const THIS_COMPUTER = IS_MAC ? 'this Mac' : 'this computer'
/** "runs commands on your Mac" / "on your computer". */
export const YOUR_COMPUTER = IS_MAC ? 'your Mac' : 'your computer'
/** The system's name, as crash reports carry its version. */
export const SYSTEM_NAME = IS_MAC ? 'macOS' : 'Linux'
/** The menu item that shows a file in the system's file manager. */
export const REVEAL_IN_FILES = IS_MAC ? 'Reveal in Finder' : 'Show in Folder'
