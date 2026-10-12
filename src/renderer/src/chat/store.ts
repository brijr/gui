import { create } from 'zustand'
import { applyTurnUpdate, type ChatTurnUpdate } from '../../../shared/chat-transport'
import type {
  ChatFloat,
  ChatMeta,
  ChatSnapshot,
  ImageAttachment,
  QueuedMessage,
  RecordingAttachment,
  Turn,
} from '../../../shared/types'
import { gui } from '../lib/api'
import { type DraftImage, MAX_IMAGES } from './images'
import { closeShipSheet, useShipSheet } from './shipping-state'
import { applyInOrder, forgetSeen, type Move, markSeen, rowKeys, transition } from './transitions'
import { closeVersions, useVersions } from './versions-state'

interface ChatStore {
  meta: ChatMeta | null
  turns: Turn[]
  turnsById: Record<string, Turn>
  turnIds: string[]
  /** Unsent composer text; kept here so it survives the composer remounting on dock/float/minimize */
  draft: string
  /** Images attached to the draft, already downscaled; kept here for the same reason */
  attachments: DraftImage[]
  recordings: RecordingAttachment[]
  /** The earlier turn the draft follows up on (its Follow up button), by id */
  followUp: string | null
  /** Why an image wasn't attached; the composer shows it briefly */
  notice: string | null
  /** ⇧⌘M asked for the model picker; the composer's model button opens it and clears this */
  pickModel: boolean
  /** What the floating chat is drawn as, and its anchored corner (main sizes the view) */
  float: ChatFloat
}

export const useChat = create<ChatStore>(() => ({
  meta: null,
  turns: [],
  turnsById: {},
  turnIds: [],
  draft: '',
  attachments: [],
  recordings: [],
  followUp: null,
  notice: null,
  pickModel: false,
  float: { form: 'panel', corner: { x: 'right', y: 'bottom' }, seq: 0 },
}))

/** The permission card waiting longest for an answer, and its turn; null when none is. */
export function waitingCard(turns: Turn[]) {
  for (const turn of turns) {
    if (turn.status !== 'running') continue
    for (const item of turn.items) {
      if (item.kind === 'permission' && item.resolved === null) return { turnId: turn.id, item }
    }
  }
  return null
}

/**
 * What ⌘↩ (`allow`) or ⌘⌫ answers that card with: its Allow or Don't Allow, never an
 * "always". Null when no card waits or it doesn't offer that. Main's Agent menu answers
 * the same card the same way (`permissionAnswer` in tab.ts).
 */
export function keyedAnswer(turns: Turn[], allow: boolean) {
  const waiting = waitingCard(turns)
  const kind = allow ? 'allow_once' : 'reject_once'
  const option = waiting?.item.options.find((choice) => choice.kind === kind)
  if (!waiting || !option) return null
  return { turnId: waiting.turnId, itemId: waiting.item.id, optionId: option.optionId }
}

/** A float from main has arrived, so the snapshot's (possibly older) one doesn't apply. */
let floatReceived = false

export function setDraft(draft: string) {
  useChat.setState({ draft })
}

/** Follow up on an earlier turn: the composer shows it, and the next message takes it along. */
export function setFollowUp(followUp: string | null) {
  useChat.setState({ followUp })
}

export function setNotice(notice: string | null) {
  useChat.setState({ notice })
}

export function addAttachments(images: DraftImage[]) {
  if (images.length === 0) return
  useChat.setState(({ attachments }) => ({ attachments: [...attachments, ...images] }))
}

export function removeRecordings(ids: string[], discard = false) {
  useChat.setState(({ recordings }) => ({
    recordings: recordings.filter((clip) => !ids.includes(clip.id)),
  }))
  if (discard)
    for (const id of ids)
      void gui.discardRecording(id).catch(() => setNotice('Could not remove recording.'))
}

export function removeAttachments(ids: string[]) {
  useChat.setState(({ attachments }) => ({
    attachments: attachments.filter((image) => !ids.includes(image.id)),
  }))
}

/** An image main prepared for the draft, such as a screenshot of the preview. */
function attachFromMain(image: ImageAttachment) {
  if (useChat.getState().attachments.length >= MAX_IMAGES) {
    setNotice(`Up to ${MAX_IMAGES} images per message.`)
    return
  }
  addAttachments([{ ...image, id: crypto.randomUUID() }])
}

/**
 * ⇧⌘M: the composer's model picker. Main shows the chat first; the composer may still be
 * on its way (minimized, a bubble), so its model button opens the picker once it's there.
 */
function chooseModel() {
  if (!useChat.getState().meta?.models) return
  // The sheets hide the composer; their drafts are kept. They stay while busy.
  closeShipSheet()
  closeVersions()
  if (!useShipSheet.getState().open && !useVersions.getState().open) {
    useChat.setState({ pickModel: true })
  }
}

function applySnapshot(snapshot: ChatSnapshot) {
  // History, not news: none of it fades in.
  for (const turn of snapshot.turns) markSeen(rowKeys(turn))
  markSeen(snapshot.meta.queue.map((item) => `queue:${item.id}`))
  transportTurns = new Map(snapshot.turns.map((turn) => [turn.id, turn]))
  revisions = new Map(Object.entries(snapshot.revisions ?? {}))
  useChat.setState({
    meta: snapshot.meta,
    turns: snapshot.turns,
    turnsById: Object.fromEntries(transportTurns),
    turnIds: snapshot.turns.map((turn) => turn.id),
  })
}

function upsertTurn(turn: Turn) {
  // Whatever arrives while the transcript isn't drawn has no first appearance to show.
  if (!transcriptShown()) markSeen(rowKeys(turn))
  useChat.setState(({ turns }) => {
    const index = turns.findIndex((t) => t.id === turn.id)
    if (index === -1) {
      const next = [...turns, turn].sort((a, b) => a.index - b.index)
      return {
        turns: next,
        turnsById: { ...useChat.getState().turnsById, [turn.id]: turn },
        turnIds: next.map((t) => t.id),
      }
    }
    const next = turns.slice()
    next[index] = turn
    return { turns: next, turnsById: { ...useChat.getState().turnsById, [turn.id]: turn } }
  })
}

function transcriptShown() {
  const { meta, float } = useChat.getState()
  return document.visibilityState === 'visible' && (meta?.docked || float.form === 'panel')
}

// Elements that move between states, by what they show.
const composerInput = () => document.querySelector('[data-composer]')
const userMessage = (turnId: string) => () =>
  document.querySelector(`[data-user-message="${CSS.escape(turnId)}"]`)
const queueItem = (id: string) => () =>
  document.querySelector(`[data-queue-item="${CSS.escape(id)}"]`)
const permission = (itemId: string) => () =>
  document.querySelector(`[data-permission="${CSS.escape(itemId)}"]`)

interface Sent {
  prompt: string
  images: string[]
  recordings: string[]
  followUp: string | null
  at: number
  /** Main took it, but its turn (or queued message) hasn't arrived: clears the composer soon */
  fallback?: ReturnType<typeof setTimeout>
}

/** The message the composer just sent, until its turn or queued message arrives. */
let sent: Sent | null = null
/** How long a sent message waits for main's turn (or queued message) to rise into. */
const SENT_WINDOW_MS = 3000
/** How long main's answer waits for the turn before the composer clears without the rise. */
const SENT_CLEAR_MS = 300

/**
 * The composer is sending `text` with the draft images `images` (by id): when main's turn or
 * queued message for it arrives, it rises out of the composer as the composer clears.
 */
export function noteSend(
  text: string,
  images: string[],
  recordings: string[] = [],
  followUp: string | null = null,
) {
  sent = { prompt: text.trim(), images, recordings, followUp, at: performance.now() }
}

/**
 * Main answered the send. Taken, the composer clears: with the turn's arrival (the rise owns
 * the clear, so the rise starts from the text), or shortly after if that doesn't come. Not
 * taken, the draft stays as it was.
 */
export function settleSend(
  accepted: boolean,
  text: string,
  images: string[],
  recordings: string[] = [],
  followUp: string | null = null,
) {
  const pending = sent
  if (!accepted) {
    if (pending?.fallback) clearTimeout(pending.fallback)
    sent = null
    return
  }
  if (pending && !pending.fallback) {
    pending.fallback = setTimeout(() => {
      if (sent !== pending) return
      sent = null
      applyInOrder(() =>
        clearSent(pending.prompt, pending.images, pending.recordings, pending.followUp),
      )
    }, SENT_CLEAR_MS)
    return
  }
  // Already risen (or rising, its update about to apply): this only finds it done.
  applyInOrder(() => clearSent(text.trim(), images, recordings, followUp))
}

/** Takes the sent message if `prompt` is it, still fresh. */
function takeSent(prompt: string) {
  const match =
    sent !== null &&
    performance.now() - sent.at < SENT_WINDOW_MS &&
    (sent.prompt === prompt || sent.prompt === '')
  const taken = match ? sent : null
  if (taken?.fallback) clearTimeout(taken.fallback)
  if (match) sent = null
  return taken
}

/** Empties the composer of what was sent, unless the user has typed since. */
function clearSent(
  prompt: string,
  images: string[],
  recordings: string[],
  followUp: string | null,
) {
  const { draft } = useChat.getState()
  if (draft.trim() === prompt) setDraft('')
  if (followUp && useChat.getState().followUp === followUp) setFollowUp(null)
  removeAttachments(images)
  removeRecordings(recordings)
}

/** Queued messages the user removed: they leave, rather than wait for a turn to move into. */
const removing = new Set<string>()

export function noteRemoveQueued(id: string) {
  removing.add(id)
}

/**
 * A queued message main just took off the queue to start its turn: the queue's update waits
 * for that turn (main sends it next) so the message can move into the transcript.
 */
let starting: { meta: ChatMeta; item: QueuedMessage; timer: ReturnType<typeof setTimeout> } | null =
  null
/** Longer than main takes between the two; past it the queue updates on its own. */
const STARTING_WAIT_MS = 150

function releaseStarting() {
  if (!starting) return null
  clearTimeout(starting.timer)
  const held = starting
  starting = null
  // Removals that came in while it waited are done with too.
  for (const id of removing) {
    if (!held.meta.queue.some((item) => item.id === id)) removing.delete(id)
  }
  return held
}

/** `meta` with the queue as it's shown now: only the queue waits for the starting turn. */
function withShownQueue(meta: ChatMeta): ChatMeta {
  return { ...meta, queue: useChat.getState().meta?.queue ?? meta.queue }
}

/** Queued messages moving, entering and leaving between two queues. */
function queueMoves(before: QueuedMessage[], after: QueuedMessage[]): Move[] {
  const ids = new Set([...before, ...after].map((item) => item.id))
  const known = new Set(before.map((item) => item.id))
  const kept = new Set(after.map((item) => item.id))
  return [...ids].map((id) => ({
    name: `queue-${id}`,
    from: known.has(id) ? queueItem(id) : () => null,
    to: kept.has(id) ? queueItem(id) : () => null,
    enters: !known.has(id),
  }))
}

function onMeta(meta: ChatMeta) {
  const before = useChat.getState().meta?.queue ?? []
  const after = meta.queue
  const removed = before.filter((item) => !after.some((other) => other.id === item.id))
  const added = after.filter((item) => !before.some((other) => other.id === item.id))
  const apply = () => useChat.setState({ meta })

  if (starting) {
    // Newer news while a queued message starts: the queue waits on with the latest,
    // everything else applies now.
    starting.meta = meta
    applyInOrder(() => useChat.setState({ meta: withShownQueue(meta) }))
    return
  }
  // One message gone while idle, and the user didn't remove it: main took it to start its
  // turn (the next in line, or one sent from the middle of the queue).
  const [gone] = removed
  const idle = !useChat.getState().turns.some((turn) => turn.status === 'running')
  if (gone && removed.length === 1 && idle && !removing.has(gone.id)) {
    const timer = setTimeout(() => {
      const held = releaseStarting()
      if (held)
        transition(() => useChat.setState({ meta: held.meta }), queueMoves(before, held.meta.queue))
    }, STARTING_WAIT_MS)
    starting = { meta, item: gone, timer }
    applyInOrder(() => useChat.setState({ meta: withShownQueue(meta) }))
    return
  }
  for (const item of removed) removing.delete(item.id)

  if (removed.length === 0 && added.length === 0) {
    // The same messages, edited or rearranged: a new order moves, an edit just lands.
    const reordered = before.some((item, index) => item.id !== after[index]?.id)
    if (reordered) transition(apply, queueMoves(before, after))
    else applyInOrder(apply)
    return
  }
  const moves = queueMoves(before, after)
  const [newest] = added
  const message = newest && takeSent(newest.prompt)
  if (newest && message) {
    // Sent while the agent works: it rises from the composer into the queue.
    const index = moves.findIndex((move) => move.name === `queue-${newest.id}`)
    moves[index] = { name: `queue-${newest.id}`, from: composerInput, to: queueItem(newest.id) }
    transition(
      () => {
        apply()
        clearSent(message.prompt, message.images, message.recordings, message.followUp)
      },
      moves,
      [`queue:${newest.id}`],
    )
    return
  }
  transition(
    apply,
    moves,
    added.map((item) => `queue:${item.id}`),
  )
}

function onTurn(turn: Turn) {
  const existing = useChat.getState().turnsById[turn.id]
  if (!existing) {
    const held = starting?.item.prompt === turn.prompt ? releaseStarting() : null
    if (held) {
      // The queued message becomes the new turn's message.
      transition(
        () => {
          useChat.setState({ meta: held.meta })
          upsertTurn(turn)
        },
        [
          { name: 'chat-message', from: queueItem(held.item.id), to: userMessage(turn.id) },
          ...queueMoves(useChat.getState().meta?.queue ?? [], held.meta.queue).filter(
            (move) => move.name !== `queue-${held.item.id}`,
          ),
        ],
        [`${turn.id}:user`],
      )
      return
    }
    const message = turn.status === 'running' ? takeSent(turn.prompt) : null
    if (message) {
      transition(
        () => {
          upsertTurn(turn)
          clearSent(message.prompt, message.images, message.recordings, message.followUp)
        },
        [{ name: 'chat-message', from: composerInput, to: userMessage(turn.id) }],
        [`${turn.id}:user`],
      )
      return
    }
    applyInOrder(() => upsertTurn(turn))
    return
  }
  // A permission card answered (or expired) collapses into the line that records it.
  const answered = turn.items.filter(
    (item) =>
      item.kind === 'permission' &&
      item.resolved !== null &&
      existing.items.some(
        (old) => old.id === item.id && old.kind === 'permission' && old.resolved === null,
      ),
  )
  if (answered.length === 0) {
    applyInOrder(() => upsertTurn(turn))
    return
  }
  transition(
    () => upsertTurn(turn),
    answered.map((item, i) => ({
      name: `chat-permission-${i}`,
      from: permission(item.id),
      to: permission(item.id),
    })),
  )
}

function onReset(snapshot: ChatSnapshot) {
  cancelRecoveryRetry()
  recoveryRequired = false
  const generation = ++recoveryGeneration
  recovering = true
  recoveryUpdates = []
  recoveryMeta = null
  releaseStarting()
  if (sent?.fallback) clearTimeout(sent.fallback)
  sent = null
  applyInOrder(() => {
    if (generation !== recoveryGeneration) return
    forgetSeen()
    applySnapshot(snapshot)
    if (useChat.getState().notice === RECOVERY_FAILURE_NOTICE) setNotice(null)
    recovering = false
    if (recoveryMeta) onMeta(recoveryMeta)
    recoveryMeta = null
    const queued = recoveryUpdates
    recoveryUpdates = []
    for (const update of queued) onTurnUpdate(update)
  })
}

let transportTurns = new Map<string, Turn>()
let revisions = new Map<string, number>()
let recoveryGeneration = 0
let recovering = false
let recoveryRequired = false
let recoveryRetry: ReturnType<typeof setTimeout> | null = null
const RECOVERY_DELAYS_MS = [250, 750]
const RECOVERY_FAILURE_NOTICE =
  'Could not refresh the conversation after three attempts. Reload the chat to retry.'

function cancelRecoveryRetry() {
  if (recoveryRetry) clearTimeout(recoveryRetry)
  recoveryRetry = null
}
let recoveryMeta: ChatMeta | null = null
let recoveryUpdates: ChatTurnUpdate[] = []

function onTurnUpdate(update: ChatTurnUpdate) {
  if (recovering) {
    recoveryUpdates.push(update)
    return
  }
  if (recoveryRequired) {
    recoveryUpdates.push(update)
    refreshTransport()
    return
  }
  const id = update.kind === 'snapshot' ? update.turn.id : update.id
  const revision = revisions.get(id)
  // A recovered snapshot may already include this queued event.
  if (revision !== undefined && update.revision <= revision) return
  const turn = applyTurnUpdate(transportTurns.get(id), revision, update)
  if (turn) {
    transportTurns.set(id, turn)
    revisions.set(id, update.revision)
    onTurn(turn)
    return
  }
  refreshTransport()
}

function refreshTransport() {
  cancelRecoveryRetry()
  recovering = true
  recoveryRequired = true
  requestSnapshot(++recoveryGeneration, 0)
}

function requestSnapshot(generation: number, attempt: number) {
  if (generation !== recoveryGeneration) return
  void gui
    .getChat()
    .then((snapshot) => {
      applyInOrder(() => {
        if (generation !== recoveryGeneration) return
        applySnapshot(snapshot)
        if (snapshot.float && !floatReceived) useChat.setState({ float: snapshot.float })
        recovering = false
        recoveryRequired = false
        if (useChat.getState().notice === RECOVERY_FAILURE_NOTICE) setNotice(null)
        if (recoveryMeta) onMeta(recoveryMeta)
        recoveryMeta = null
        const queued = recoveryUpdates
        recoveryUpdates = []
        for (const next of queued) onTurnUpdate(next)
      })
    })
    .catch(() => {
      if (generation !== recoveryGeneration) return
      const delay = RECOVERY_DELAYS_MS[attempt]
      if (delay !== undefined) {
        recoveryRetry = setTimeout(() => {
          recoveryRetry = null
          requestSnapshot(generation, attempt + 1)
        }, delay)
        return
      }
      recovering = false
      setNotice(RECOVERY_FAILURE_NOTICE)
    })
}

export function connectChat() {
  recovering = true
  const offs = [
    gui.onChatMeta((meta) => {
      if (recovering || recoveryRequired) recoveryMeta = meta
      else onMeta(meta)
    }),
    gui.onChatTurn(onTurnUpdate),
    gui.onChatReset(onReset),
    // Here rather than in the composer, which isn't mounted while the panel is minimized.
    gui.onChatAttach(attachFromMain),
    gui.onRecordingAttach((clip) => {
      if (useChat.getState().recordings.length >= 3) {
        setNotice('Up to 3 recordings per message.')
        void gui.discardRecording(clip.id)
      } else useChat.setState(({ recordings }) => ({ recordings: [...recordings, clip] }))
    }),
    gui.onChatFloat((float) => {
      floatReceived = true
      applyInOrder(() => useChat.setState({ float }))
    }),
    gui.onCommand((command) => {
      if (command === 'chooseModel') chooseModel()
    }),
  ]
  refreshTransport()
  return () => {
    recoveryGeneration++
    cancelRecoveryRetry()
    recovering = false
    recoveryRequired = false
    recoveryUpdates = []
    recoveryMeta = null
    for (const off of offs) off()
  }
}
