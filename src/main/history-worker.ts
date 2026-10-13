import { type FileHandle, open, rm, stat } from 'node:fs/promises'
import { parentPort } from 'node:worker_threads'
import { writeTemp } from './atomic-file'
import type { HistoryWriteRequest, HistoryWriteResult } from './history-format'
import { historyStamp, type LiveSummary, summaryFile } from './history-summary'

const writes = new Map<string, { file: string; target: string; handle: FileHandle }>()
parentPort?.on('message', async (request: HistoryWriteRequest) => {
  try {
    let result: HistoryWriteResult = null
    if (request.action === 'begin') {
      const file = await writeTemp(request.file, '')
      try {
        const handle = await open(file, 'a')
        writes.set(request.id, { file, target: request.file, handle })
        result = { file }
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
        else {
          result = { file: write.file }
          if (request.recent !== undefined) {
            const summary: LiveSummary = {
              version: 1,
              source: historyStamp(await stat(write.file)),
              recent: request.recent,
            }
            result.summary = await writeTemp(summaryFile(write.target), JSON.stringify(summary))
          }
        }
      }
    }
    parentPort?.postMessage({ result })
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
})
