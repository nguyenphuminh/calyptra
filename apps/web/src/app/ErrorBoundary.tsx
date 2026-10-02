import { Component, type ReactNode } from 'react';
import { errorText } from '../shared/ui.tsx';

/** A per-page error card with "Try again"; any refresh (new `resetKey`) clears the error. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: number }, { error: unknown }> {
  override state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(): void {}

  override componentDidUpdate(previous: { resetKey: number }): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== null) this.setState({ error: null });
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="card" role="alert">
        <h2>Something went wrong on this page</h2>
        <p>{errorText(this.state.error)}</p>
        <button type="button" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
