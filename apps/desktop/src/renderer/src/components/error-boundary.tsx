import { Component, type PropsWithChildren } from 'react'
import { Button } from './ui/button'

export class ErrorBoundary extends Component<
  PropsWithChildren<{ onReload: () => void }>,
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="grid min-h-dvh place-items-center p-6">
        <div className="space-y-3 text-center">
          <p role="alert" className="text-sm font-medium">
            AMC couldn’t start.
          </p>
          <Button onClick={this.props.onReload}>Reload</Button>
        </div>
      </main>
    )
  }
}
