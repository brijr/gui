import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { watchErrors } from './lib/crash-reports'
import { ErrorBoundary, windowFallback } from './lib/error-boundary'
import { SettingsApp } from './settings/settings-app'
import './styles.css'
import './lib/appearance'

watchErrors()
const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary fallback={windowFallback}>
      <SettingsApp />
    </ErrorBoundary>
  </StrictMode>,
)
