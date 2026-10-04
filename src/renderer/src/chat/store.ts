import { create } from 'zustand'
import type {
  ChatMeta,
  ChatSnapshot,
  ImageAttachment,
  PanelCorner,
  Turn,
} from '../../../shared/types'
import { gui } from '../lib/api'
import { type DraftImage, MAX_IMAGES } from './images'

interface ChatStore {
  meta: ChatMeta | null
  turns: Turn[]
  /** Unsent composer text; kept here so it survives the composer remounting on dock/float/minimize */
  draft: string
  /** Images attached to the draft, already downscaled; kept here for the same reason */
  attachments: DraftImage[]
  /** Why an image wasn't attached; the composer shows it briefly */
  notice: string | null
  /** Where the floating panel is a bubble while the user picks, if it is (main sizes the view) */
  bubble: PanelCorner | null
}

export const useChat = create<ChatStore>(() => ({
  meta: null,
  turns: [],
  draft: '',
  attachments: [],
  notice: null,
  bubble: null,
}))

export function setDraft(draft: string) {
  useChat.setState({ draft })
}

export function setNotice(notice: string | null) {
  useChat.setState({ notice })
}

export function addAttachments(images: DraftImage[]) {
  if (images.length === 0) return
  useChat.setState(({ attachments }) => ({ attachments: [...attachments, ...images] }))
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

function applySnapshot(snapshot: ChatSnapshot) {
  useChat.setState({ meta: snapshot.meta, turns: snapshot.turns })
}

function upsertTurn(turn: Turn) {
  useChat.setState(({ turns }) => {
    const index = turns.findIndex((t) => t.id === turn.id)
    if (index === -1) return { turns: [...turns, turn].sort((a, b) => a.index - b.index) }
    const next = turns.slice()
    next[index] = turn
    return { turns: next }
  })
}

export function connectChat() {
  const offs = [
    gui.onChatMeta((meta) => useChat.setState({ meta })),
    gui.onChatTurn(upsertTurn),
    gui.onChatReset(applySnapshot),
    // Here rather than in the composer, which isn't mounted while the panel is minimized.
    gui.onChatAttach(attachFromMain),
    gui.onChatBubble((bubble) => useChat.setState({ bubble })),
  ]
  void gui.getChat().then((snapshot) => {
    if (!useChat.getState().meta) applySnapshot(snapshot)
  })
  return () => {
    for (const off of offs) off()
  }
}
