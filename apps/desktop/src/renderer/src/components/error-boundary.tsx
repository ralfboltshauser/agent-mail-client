import { Component, type PropsWithChildren } from 'react'
import { type FailureDetails, formatFailure } from '../../../shared/failure'
import { reportRendererFailure } from '../lib/failure'
import { Button } from './ui/button'

export class ErrorBoundary extends Component<
  PropsWithChildren<{ onReload: () => void }>,
  { failed: boolean; details?: FailureDetails }
> {
  override state: { failed: boolean; details?: FailureDetails } = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch(error: unknown) {
    this.setState({ details: reportRendererFailure('react.boundary', error) })
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="grid min-h-dvh place-items-center p-6">
        <div className="space-y-3 text-center">
          <p role="alert" className="text-sm font-medium">
            AMC couldn’t start.
          </p>
          {this.state.details && (
            <p className="select-text text-xs text-muted-foreground">
              {formatFailure(this.state.details)}
            </p>
          )}
          <Button onClick={this.props.onReload}>Reload</Button>
        </div>
      </main>
    )
  }
}
