import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatPanel } from './chat/chat-panel'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')
createRoot(root).render(
  <StrictMode>
    <ChatPanel />
  </StrictMode>,
)
