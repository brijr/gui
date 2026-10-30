import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { watchErrors } from './lib/crash-reports'
import { ErrorBoundary } from './lib/error-boundary'
import { PickOverlay } from './pick/overlay'
import './styles.css'
import './lib/appearance'

watchErrors()
const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary fallback={() => null}>
      <PickOverlay />
    </ErrorBoundary>
  </StrictMode>,
)
