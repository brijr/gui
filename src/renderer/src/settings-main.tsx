import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsApp } from './settings/settings-app'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')
createRoot(root).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>,
)
