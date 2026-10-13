import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BOARD_MANIFEST, FRAMES_DIR } from '../shared/board'

/** Gui/checkpoint bookkeeping and atomic manifest temps are not page dependencies. */
export function isBoardAsset(path: string) {
  const parts = path.replaceAll('\\', '/').split('/')
  if (parts.some((part) => part === '.git' || part === '.gui')) return false
  if (path === BOARD_MANIFEST || (path.startsWith(`${BOARD_MANIFEST}.`) && path.endsWith('.tmp')))
    return false
  return !(parts.length === 2 && parts[0] === FRAMES_DIR && parts[1].endsWith('.html'))
}

export async function pageSignature(path: string) {
  const info = await stat(path).catch(() => null)
  return info?.isFile() ? `${info.size}:${info.mtimeMs}:${info.ctimeMs}` : null
}

/** Paths and directory metadata also detect removed/replaced dependencies after reopening. */
export async function boardAssetSignature(root: string): Promise<string> {
  const hash = createHash('sha256')
  const visit = async (directory: string, prefix = '') => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (!isBoardAsset(path)) continue
      // Frame folder mtime changes when a frame is added: only its shared contents matter.
      const info = await stat(join(directory, entry.name)).catch(() => null)
      if (path !== FRAMES_DIR)
        hash.update(JSON.stringify([path, info?.size, info?.mtimeMs, info?.ctimeMs]))
      if (entry.isDirectory()) await visit(join(directory, entry.name), path)
    }
  }
  await visit(root)
  return hash.digest('hex')
}
