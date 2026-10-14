// Catches render errors in a subtree and shows a recoverable error state.

import { TriangleExclamation } from '@gravity-ui/icons';
import { Button } from '@heroui/react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

import { t } from '../lib/i18n';
import { EmptyState } from './EmptyState';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Changing this value resets the boundary (e.g. the current route). */
  resetKey?: unknown;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Short name of the area, shown in the message. */
  area?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[iPhone AI] UI error', error, info.componentStack);
  }

  override componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.reset();
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <EmptyState
        tone="danger"
        size="lg"
        icon={<TriangleExclamation />}
        title={this.props.area ? t('error.boundary.titleArea', { area: this.props.area }) : t('error.boundary.title')}
        description={
          <>
            <p>{t('error.boundary.body')}</p>
            <p className="mt-2 font-mono text-xs break-all text-muted/80">{error.message}</p>
          </>
        }
        actions={
          <>
            <Button variant="secondary" onPress={this.reset}>
              {t('common.tryAgain')}
            </Button>
            <Button variant="tertiary" onPress={() => window.location.reload()}>
              {t('common.reload')}
            </Button>
          </>
        }
      />
    );
  }
}
