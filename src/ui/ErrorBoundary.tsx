import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
  /** Said at the top of the message: what was being shown. */
  readonly what: string;
  /**
   * For a part of the screen that can be lost without losing the rest (a panel): show this instead of the full-screen
   * message, and call `onError` so it can be put away and the reason given. Without it the whole screen is the fallback.
   */
  readonly fallback?: ReactNode;
  readonly onError?: (error: Error) => void;
}

interface State {
  readonly error: Error | null;
  readonly componentStack: string;
}

/**
 * Catches an error thrown while drawing the screen, and says so.
 *
 * Without one, React takes down the *whole* tree when a component throws while rendering, and what is left is an empty
 * window — a black screen with no hint of what went wrong and the impression that the work in it was lost. The work is
 * not: it lives in the stores, not in the components, and is also in the autosave draft. So this shows what happened
 * (the message and where, to be read out), lets the screen be drawn again, and offers a reload, which restores the draft.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? '' });
    console.error('KK-Notes: a screen failed to draw', error, info.componentStack);
    this.props.onError?.(error);
  }

  private retry = (): void => this.setState({ error: null, componentStack: '' });

  override render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    const details = `${error.name}: ${error.message}\n${(error.stack ?? '').split('\n').slice(1, 8).join('\n')}\n${componentStack.split('\n').slice(0, 8).join('\n')}`.trim();
    return (
      <div
        role="alert"
        data-error-boundary
        className="flex h-full w-full flex-col items-center justify-center gap-3 overflow-auto bg-zinc-100 p-6 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
      >
        <h1 className="text-lg font-semibold">Something went wrong showing {this.props.what}.</h1>
        <p className="max-w-xl text-center text-sm text-zinc-600 dark:text-zinc-300">
          Your work is not lost: it is kept in the app and in its autosaved draft. Try drawing the screen again, or reload the app, which
          brings the draft back.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            data-error-retry
            className="h-9 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-500"
            onClick={this.retry}
          >
            Try again
          </button>
          <button
            type="button"
            className="h-9 rounded-lg border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
            onClick={() => window.location.reload()}
          >
            Reload the app
          </button>
        </div>
        <pre
          data-error-details
          className="max-h-64 w-full max-w-3xl select-text overflow-auto rounded-lg bg-zinc-200 p-3 text-[11px] leading-snug text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
        >
          {details}
        </pre>
      </div>
    );
  }
}
