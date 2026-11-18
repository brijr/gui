// Builds Gui's native helpers (scripts/build-native.sh) where they can be built: on a Mac.
// Elsewhere there's nothing to build, and no `sh` to ask on Windows.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

if (process.platform !== 'darwin') {
  console.error("build-native: no swiftc here; narrated recordings won't be transcribed.")
  process.exit(0)
}
const script = join(import.meta.dirname, 'build-native.sh')
const { status } = spawnSync('sh', [script], { stdio: 'inherit' })
process.exit(status ?? 1)
