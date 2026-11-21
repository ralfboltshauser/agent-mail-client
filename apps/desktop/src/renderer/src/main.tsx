import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { ErrorBoundary } from './components/error-boundary'
import './styles.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ErrorBoundary onReload={() => window.location.reload()}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
