import { describe, expect, spyOn, test } from 'bun:test'
import { ProjectResources } from '../src/main/project-resources'

function fixture() {
  const events: string[] = []
  const resources = new ProjectResources({
    release: (file) => events.push(`release:${file}`),
    retire: (root, file) => events.push(`retire:${root}:${file}`),
  })
  return { resources, events }
}

describe('project lifetime', () => {
  test('completion waits for the canvas final save and repeated disposal shares it', async () => {
    const { resources, events } = fixture()
    let finishBoard!: () => void
    const boardSaving = new Promise<void>((resolve) => {
      finishBoard = resolve
    })
    resources.board = { dispose: () => boardSaving } as never
    resources.claim('chat.json')
    let finished = false
    const completion = resources.dispose()
    void completion.then(() => {
      finished = true
    })
    expect(resources.board).toBeNull()
    expect(resources.dispose()).toBe(completion)
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(events).toEqual([])
    finishBoard()
    await completion
    expect(finished).toBe(true)
    expect(events).toEqual(['release:chat.json'])
  })

  test('a failed canvas save is handled and does not strand remaining teardown', async () => {
    const { resources, events } = fixture()
    resources.board = { dispose: () => Promise.reject(new Error('Canvas disk failed')) } as never
    resources.recordings = { dispose: () => events.push('recordings') } as never
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await resources.dispose()
      expect(events).toEqual(['recordings'])
      expect(logged).toHaveBeenCalledTimes(1)
    } finally {
      logged.mockRestore()
    }
  })

  test('clears resources immediately, saves before retiring, and disposes once', async () => {
    const { resources, events } = fixture()
    let finishSave!: () => void
    const saving = new Promise<void>((resolve) => {
      finishSave = resolve
    })
    resources.claim('chat.json')
    resources.attachHistory('/project', 'chat.json')
    resources.chat = {
      dispose: () => {
        events.push('chat')
        return saving
      },
    } as never
    resources.devServer = { dispose: () => events.push('server') } as never
    resources.terminals = { dispose: () => events.push('terminal') } as never
    resources.mcp = { close: () => events.push('mcp') } as never
    resources.recordings = { dispose: () => events.push('recordings') } as never
    const completion = resources.dispose()
    expect(resources.dispose()).toBe(completion)
    expect(resources.chat).toBeNull()
    expect(resources.historyFile).toBeNull()
    expect(resources.active).toBe(false)
    expect(events).toEqual(['server', 'terminal', 'chat', 'mcp'])
    finishSave()
    await completion
    expect(events).toEqual([
      'server',
      'terminal',
      'chat',
      'mcp',
      'retire:/project:chat.json',
      'recordings',
    ])
  })

  test('late async work is dropped after dispose bumps the generation', async () => {
    const { resources } = fixture()
    const generation = resources.generation
    expect(resources.stillCurrent(generation)).toBe(true)
    expect(resources.ifCurrent(generation, () => 'ok')).toBe('ok')
    await resources.dispose()
    expect(resources.stillCurrent(generation)).toBe(false)
    expect(resources.ifCurrent(generation, () => 'ok')).toBeUndefined()
    expect(resources.generation).not.toBe(generation)
  })

  test('late claims and MCP listeners are released instead of attaching', async () => {
    const { resources, events } = fixture()
    await resources.dispose()
    expect(resources.claim('late.json')).toBe(false)
    expect(resources.attachMcp({ close: () => events.push('late-mcp') } as never)).toBe(false)
    expect(resources.historyFile).toBeNull()
    expect(resources.mcp).toBeNull()
    expect(events).toEqual(['release:late.json', 'late-mcp'])
  })

  test('an interrupted opening releases its unused claim without archiving', async () => {
    const { resources, events } = fixture()
    resources.claim('pending.json')
    await resources.dispose()
    expect(events).toEqual(['release:pending.json'])
    expect(() => resources.attachHistory('/project', 'pending.json')).toThrow(
      'Project lifetime ended',
    )
  })

  test('a failing teardown still closes other resources', async () => {
    const { resources, events } = fixture()
    resources.claim('pending.json')
    resources.devServer = {
      dispose: () => {
        throw new Error('broken teardown')
      },
    } as never
    resources.mcp = { close: () => events.push('mcp') } as never
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await resources.dispose()
      expect(events).toEqual(['mcp', 'release:pending.json'])
      expect(logged).toHaveBeenCalledTimes(1)
    } finally {
      logged.mockRestore()
    }
  })

  test('reentrant teardown shares completion and does not dispose twice', async () => {
    const { resources, events } = fixture()
    let reentrant: Promise<void> | null = null
    resources.devServer = {
      dispose: () => {
        events.push('server')
        reentrant = resources.dispose()
      },
    } as never
    const completion = resources.dispose()
    expect(reentrant).toBe(completion)
    await completion
    expect(events).toEqual(['server'])
  })

  test('failed final persistence still retires the claim and recordings', async () => {
    const { resources, events } = fixture()
    resources.claim('chat.json')
    resources.attachHistory('/project', 'chat.json')
    resources.chat = { dispose: () => Promise.reject(new Error('disk failed')) } as never
    resources.recordings = { dispose: () => events.push('recordings') } as never
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await resources.dispose()
      expect(events).toEqual(['retire:/project:chat.json', 'recordings'])
      expect(logged).toHaveBeenCalledTimes(1)
    } finally {
      logged.mockRestore()
    }
  })
})
