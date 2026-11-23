import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { ErrorBoundary } from './components/error-boundary'
import { installRendererReporting } from './lib/failure'
import './styles.css'

installRendererReporting()

async function mount() {
  if (import.meta.env.DEV) {
    const scenario = new URLSearchParams(location.search).get('fixture')
    if (scenario) {
      const { loadFixture } = await import('./lib/amc')
      await loadFixture(scenario)
    }
  }

  createRoot(document.getElementById('root') as HTMLElement, {
    onCaughtError: () => {}, // ErrorBoundary forwards classified failures.
  }).render(
    <StrictMode>
      <ErrorBoundary onReload={() => window.location.reload()}>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
}

void mount()
