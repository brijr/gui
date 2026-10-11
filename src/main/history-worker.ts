import { type FileHandle, open, rm } from 'node:fs/promises'
import { parentPort } from 'node:worker_threads'
import { writeTemp } from './atomic-file'
import type { HistoryWriteRequest } from './history-format'

const writes = new Map<string, { file: string; handle: FileHandle }>()
parentPort?.on('message', async (request: HistoryWriteRequest) => {
  try {
    let result: string | null = null
    if (request.action === 'begin') {
      const file = await writeTemp(request.file, '')
      try {
        const handle = await open(file, 'a')
        writes.set(request.id, { file, handle })
        result = file
      } catch (error) {
        await rm(file, { force: true })
        throw error
      }
    } else {
      const write = writes.get(request.id)
      if (!write) throw new Error('History write ended.')
      if (request.action === 'append') await write.handle.writeFile(request.text)
      else {
        writes.delete(request.id)
        try {
          if (request.action === 'finish') await write.handle.sync()
        } finally {
          await write.handle.close()
        }
        if (request.action === 'abort') await rm(write.file, { force: true })
        else result = write.file
      }
    }
    parentPort?.postMessage({ result })
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
})
