import { StreamingMarkdown } from './markdown-parser'

const sessions = new Map<number, StreamingMarkdown>()

self.addEventListener('message', (event: MessageEvent) => {
  const { owner, id, text, live, release } = event.data as {
    owner: number
    id: number
    text: string
    live: boolean
    release?: boolean
  }
  if (release) {
    sessions.delete(owner)
    return
  }
  try {
    const session = sessions.get(owner) ?? new StreamingMarkdown()
    sessions.set(owner, session)
    self.postMessage({ id, result: session.update(text, live) })
  } catch {
    self.postMessage({ id, result: null })
  }
})
