import { parentPort } from 'node:worker_threads'

parentPort?.on('message', (input: { wait?: number; fail?: boolean; value: string }) => {
  if (input.fail) throw new Error('Fixture failure')
  if (input.wait === -1) return
  setTimeout(() => parentPort?.postMessage({ result: input.value }), input.wait ?? 0)
})
