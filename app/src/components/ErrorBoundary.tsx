import React from 'react';
import { ErrorPage } from '../pages/ErrorPage';
import { Icon } from './Icon';
import { Sentry } from '../lib/sentry';

interface Props {
  children: React.ReactNode;
  /**
   * Render a compact inline card instead of the full-screen ErrorPage.
   * Use this for pages rendered inside AppShell so the nav stays functional
   * when a single page crashes.
   */
  inline?: boolean;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
    Sentry.captureException(error, { extra: { componentStack: info.componentStack } });
  }

  private handleRetry = () => this.setState({ hasError: false, error: null });

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.inline) {
      return (
        <div className="flex flex-col items-center justify-center p-16 text-center">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5"
            style={{ background: '#fee2e2', border: '1px solid #fecaca' }}
          >
            <Icon name="error_outline" size={28} style={{ color: '#dc2626' }} />
          </div>
          <h3 className="font-bold text-lg mb-2" style={{ color: '#1a1f36' }}>
            Something went wrong
          </h3>
          <p className="text-sm mb-5 max-w-xs leading-relaxed" style={{ color: '#595c5e' }}>
            An unexpected error occurred on this page. Your other tabs and data are
            unaffected.
          </p>
          <button
            onClick={this.handleRetry}
            className="px-5 py-2 rounded-xl text-sm font-semibold text-white"
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
          >
            Try again
          </button>
        </div>
      );
    }

    return (
      <ErrorPage
        type="server-error"
        onRetry={this.handleRetry}
      />
    );
  }
}
