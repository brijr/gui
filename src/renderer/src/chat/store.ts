import { create } from 'zustand'
import type { ChatMeta, ChatSnapshot, Turn } from '../../../shared/types'
import { grat } from '../lib/api'
import type { DraftImage } from './images'

interface ChatStore {
  meta: ChatMeta | null
  turns: Turn[]
  /** Unsent composer text; kept here so it survives the composer remounting on dock/float/minimize */
  draft: string
  /** Images attached to the draft, already downscaled; kept here for the same reason */
  attachments: DraftImage[]
}

export const useChat = create<ChatStore>(() => ({
  meta: null,
  turns: [],
  draft: '',
  attachments: [],
}))

export function setDraft(draft: string) {
  useChat.setState({ draft })
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
    grat.onChatMeta((meta) => useChat.setState({ meta })),
    grat.onChatTurn(upsertTurn),
    grat.onChatReset(applySnapshot),
  ]
  void grat.getChat().then((snapshot) => {
    if (!useChat.getState().meta) applySnapshot(snapshot)
  })
  return () => {
    for (const off of offs) off()
  }
}
