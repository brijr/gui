import { randomUUID } from 'node:crypto'
import { MAX_NARRATED_RECORDING_MS, MAX_RECORDING_FRAMES } from '../shared/bounded'
import { parseCommands } from '../shared/commands'
import {
  type AgentCommand,
  DEFAULT_AGENT_ID,
  type FollowUp,
  type ImageAttachment,
  isAgentId,
  type Picked,
  type RecordingAttachment,
  type RecordingNarration,
  type Turn,
  type TurnItem,
} from '../shared/types'
import type { SavedChat, SavedQueued } from './history'
import { settleVersions } from './history-format'
import { CHAT_ID, cleanTitle } from './history-summary'
import type { PromptViewport } from './prompt'

/** Parse and settle in the read worker; only the settled result crosses to main. */
export function settleHistory(value: unknown): SavedChat {
  const parsed = value as Partial<SavedChat> | null
  if (parsed?.version !== 1 || !Array.isArray(parsed.turns)) throw new Error('unknown format')
  const checkpoints = parsed.checkpoints ?? {}
  return {
    version: 1,
    id: typeof parsed.id === 'string' && CHAT_ID.test(parsed.id) ? parsed.id : randomUUID(),
    createdAt:
      typeof parsed.createdAt === 'number'
        ? parsed.createdAt
        : (parsed.turns[0]?.startedAt ?? Date.now()),
    ...(typeof parsed.title === 'string' && parsed.title.trim()
      ? { title: cleanTitle(parsed.title) }
      : {}),
    agentId: isAgentId(parsed.agentId) ? parsed.agentId : DEFAULT_AGENT_ID,
    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
    primed: parsed.primed === true,
    primedWithTools: parsed.primedWithTools === true,
    primedVersion: typeof parsed.primedVersion === 'number' ? parsed.primedVersion : undefined,
    turns: parsed.turns.map((turn) => settleTurn(turn, checkpoints[turn.id]?.before ?? null)),
    checkpoints,
    redo: parsed.redo ?? null,
    commands: settleCommands(parsed.commands),
    queue: settleQueue(parsed.queue),
    versions: settleVersions(parsed.versions),
  }
}

/** An unreadable transcript must not be treated as having no retained resources. */
export function historyReferences(value: unknown) {
  const saved = value as Partial<SavedChat> | null
  if (saved?.version !== 1 || !Array.isArray(saved.turns)) throw new Error('unknown format')
  const checkpoints = new Set<string>()
  const recordings = new Set<string>()
  for (const point of Object.values(saved.checkpoints ?? {})) {
    if (typeof point?.before === 'string') checkpoints.add(point.before)
    if (typeof point?.after === 'string') checkpoints.add(point.after)
  }
  if (typeof saved.redo?.sha === 'string') checkpoints.add(saved.redo.sha)
  for (const version of Array.isArray(saved.versions) ? saved.versions : []) {
    if (typeof version?.sha === 'string') checkpoints.add(version.sha)
  }
  const queued = Array.isArray(saved.queue) ? saved.queue.map((entry) => entry?.message) : []
  for (const turn of [...saved.turns, ...queued]) {
    for (const clip of Array.isArray(turn?.recordings) ? turn.recordings : []) {
      if (typeof clip?.id === 'string') recordings.add(clip.id)
    }
  }
  return { checkpoints: [...checkpoints], recordings: [...recordings] }
}

/** Nothing was running when the app quit, so open permission prompts can't be answered. */
function settleTurn(turn: Turn, before: string | null): Turn {
  const items = turn.items.map(settleItem)
  const attachments = settleAttachments(turn.attachments)
  const context = settleContext(turn.context)
  const recordings = settleRecordings(turn.recordings)
  if (turn.status !== 'running') return { ...turn, items, attachments, context, recordings }
  return {
    ...turn,
    items,
    attachments,
    context,
    recordings,
    status: 'cancelled',
    endedAt: turn.startedAt,
    // Its edits were never diffed, but its starting checkpoint can still undo them.
    ...(before && turn.changes === null ? { changesUnknown: true } : {}),
  }
}

/** Turns saved before several things could be picked hold one element, or null. */
function settleContext(value: unknown): Picked[] {
  if (Array.isArray(value)) return value as Picked[]
  return value && typeof value === 'object' ? [value as Picked] : []
}

/** Each agent's saved command list, checked like one the agent sent. */
function settleCommands(value: unknown): Record<string, AgentCommand[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const commands: Record<string, AgentCommand[]> = {}
  for (const [agentId, list] of Object.entries(value)) {
    if (isAgentId(agentId)) commands[agentId] = parseCommands(list)
  }
  return commands
}

/** Same limits main puts on attachments when they're sent (see `isImage` in index.ts). */
const THUMBNAIL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const MAX_THUMBNAIL = 256 * 1024
const MAX_NAME = 200

type Attachment = NonNullable<Turn['attachments']>[number]

function isAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== 'object') return false
  const { name, thumbnail } = value as Record<string, unknown>
  return (
    typeof name === 'string' &&
    name.length <= MAX_NAME &&
    typeof thumbnail === 'string' &&
    thumbnail.length <= MAX_THUMBNAIL &&
    THUMBNAIL.test(thumbnail)
  )
}

/**
 * History only ever holds thumbnails, but the file is just JSON on disk: keep the
 * attachments that are exactly that and drop anything else.
 */
function settleAttachments(value: unknown): Turn['attachments'] {
  if (!Array.isArray(value)) return undefined
  const valid = value.filter(isAttachment).map(({ name, thumbnail }) => ({ name, thumbnail }))
  return valid.length ? valid : undefined
}

function settleRecordings(value: unknown): RecordingAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const valid = value
    .filter((clip): clip is RecordingAttachment => {
      if (!clip || typeof clip !== 'object') return false
      const data: Record<string, unknown> = clip
      return (
        typeof data.id === 'string' &&
        /^[a-f0-9-]{36}$/.test(data.id) &&
        typeof data.url === 'string' &&
        /^gui-recording:\/\/[a-f0-9]{32}\/[a-f0-9-]{36}\/video\.webm$/.test(data.url) &&
        data.url.endsWith(`/${data.id}/video.webm`) &&
        ['durationMs', 'width', 'height', 'frameCount'].every(
          (key) =>
            typeof data[key] === 'number' && Number.isFinite(data[key]) && Number(data[key]) > 0,
        ) &&
        Number(data.durationMs) <= MAX_NARRATED_RECORDING_MS + 1000 &&
        Number(data.width) <= 1920 &&
        Number(data.height) <= 1920 &&
        Number.isInteger(data.frameCount) &&
        Number(data.frameCount) <= MAX_RECORDING_FRAMES &&
        isAttachment(data)
      )
    })
    .map((clip) => {
      const narration = settleNarration(clip.narration, clip.id)
      const { narration: _narration, ...rest } = clip
      return narration ? { ...rest, narration } : rest
    })
    .slice(0, 3)
  return valid.length ? valid : undefined
}

/** A narrated clip's transcript as saved; one still being made counts as lost. */
function settleNarration(value: unknown, id: string): RecordingNarration | undefined {
  if (!value || typeof value !== 'object') return undefined
  const data = value as Record<string, unknown>
  const text = typeof data.text === 'string' ? data.text.slice(0, 4000) : undefined
  const captions =
    typeof data.captions === 'string' &&
    /^gui-recording:\/\/[a-f0-9]{32}\/[a-f0-9-]{36}\/captions\.vtt$/.test(data.captions) &&
    data.captions.endsWith(`/${id}/captions.vtt`)
      ? data.captions
      : undefined
  if (data.status === 'done' && text) return { status: 'done', text, captions }
  const error = typeof data.error === 'string' ? data.error.slice(0, 300) : undefined
  return { status: 'failed', error: error ?? "The recording wasn't transcribed." }
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
/** As main accepts them when they're sent (`MAX_IMAGE_BASE64` in index.ts) */
const MAX_IMAGE_BASE64 = 7 * 1024 * 1024

function isImage(value: unknown): value is ImageAttachment {
  if (!isAttachment(value)) return false
  const { mimeType, data } = value as unknown as Record<string, unknown>
  return (
    typeof mimeType === 'string' &&
    IMAGE_TYPES.has(mimeType) &&
    typeof data === 'string' &&
    data.length <= MAX_IMAGE_BASE64 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(data)
  )
}

function isViewport(value: unknown): value is PromptViewport {
  if (!value || typeof value !== 'object') return false
  const { name, width, height, fixed } = value as Record<string, unknown>
  return (
    typeof name === 'string' &&
    typeof width === 'number' &&
    typeof height === 'number' &&
    typeof fixed === 'boolean'
  )
}

function isFollowUp(value: unknown): value is FollowUp {
  if (!value || typeof value !== 'object') return false
  const { turnId, number, prompt } = value as Record<string, unknown>
  return typeof turnId === 'string' && typeof number === 'number' && typeof prompt === 'string'
}

/** The saved queue, keeping only messages that are whole. */
function settleQueue(value: unknown): SavedQueued[] | undefined {
  if (!Array.isArray(value)) return undefined
  const queue = value.flatMap((entry): SavedQueued[] => {
    if (!entry || typeof entry !== 'object') return []
    const { message, images, selection, viewport, fix } = entry as Record<string, unknown>
    if (!message || typeof message !== 'object') return []
    const { id, prompt, context, attachments, recordings, followUp } = message as Record<
      string,
      unknown
    >
    if (typeof id !== 'string' || !CHAT_ID.test(id) || typeof prompt !== 'string' || !prompt)
      return []
    const picked = settleContext(context)
    return [
      {
        message: {
          id,
          prompt,
          context: picked,
          attachments: settleAttachments(attachments) ?? [],
          recordings: settleRecordings(recordings) ?? [],
          ...(isFollowUp(followUp) ? { followUp } : {}),
        },
        images: Array.isArray(images) ? images.filter(isImage) : [],
        selection: Array.isArray(selection) ? settleContext(selection) : picked,
        viewport: isViewport(viewport) ? viewport : null,
        ...(fix === 'startup' ? { fix } : {}),
      },
    ]
  })
  return queue.length ? queue : undefined
}

function settleItem(item: TurnItem): TurnItem {
  if (item.kind !== 'permission') return item
  // Saved before prompts described the action; fill in what the transcript expects.
  return {
    ...item,
    toolKind: item.toolKind ?? 'other',
    locations: item.locations ?? [],
    sensitive: item.sensitive ?? false,
    resolved: item.resolved ?? 'cancelled',
  }
}
