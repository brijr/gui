import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

/**
 * The race below is staged by replacing the history file while Gui has it open. Windows may
 * refuse that rename (EPERM), and then there is no race to stage.
 */
async function canReplaceOpenFile() {
  const dir = await mkdtemp(join(tmpdir(), 'gui-replace-open-'))
  const file = join(dir, 'a')
  await writeFile(file, 'a')
  await writeFile(join(dir, 'b'), 'b')
  const handle = await open(file, 'r')
  try {
    await rename(join(dir, 'b'), file)
    return true
  } catch {
    return false
  } finally {
    await handle.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test.skipIf(!(await canReplaceOpenFile()))(
  'history read failures cannot move or overwrite a newer replacement',
  async () => {
    const result = await promisify(execFile)(process.execPath, [
      join(import.meta.dirname, 'fast', 'history-read-race.ts'),
    ])
    expect(result.stdout).toContain('replacement retention and malformed recovery passed')
    expect(result.stderr).toBe('')
  },
  10_000,
)
