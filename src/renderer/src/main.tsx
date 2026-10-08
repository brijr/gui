import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/app'
import { ErrorBoundary, windowFallback } from './lib/error-boundary'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary fallback={windowFallback}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
