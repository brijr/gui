import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatPanel } from './chat/chat-panel'
import { ErrorBoundary, windowFallback } from './lib/error-boundary'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary fallback={windowFallback}>
      <ChatPanel />
    </ErrorBoundary>
  </StrictMode>,
)
