import React from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useApp } from '../state/AppContext';

export const ToastContainer: React.FC = () => {
  const { toasts, dismissToast } = useApp();
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed right-4 top-4 flex w-full max-w-[360px] flex-col gap-2 pointer-events-none"
      style={{ zIndex: 'var(--z-toast)' }}
    >
      {toasts.map((t) => {
        const cls =
          t.tone === 'success'
            ? 'border-status-success-border bg-status-success-bg text-status-success-fg'
            : t.tone === 'warning'
              ? 'border-status-stale-border bg-status-stale-bg text-status-stale-fg'
              : t.tone === 'error'
                ? 'border-status-failed-border bg-status-failed-bg text-status-failed-fg'
                : 'border-line-default bg-elevated text-ink-primary';

        const Icon =
          t.tone === 'success'
            ? CheckCircle2
            : t.tone === 'warning'
              ? AlertTriangle
              : t.tone === 'error'
                ? XCircle
                : Info;

        return (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 shadow-popover text-xs ${cls}`}
          >
            <Icon className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-semibold">{t.title}</div>
              {t.description && <div className="mt-0.5 opacity-90">{t.description}</div>}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              className="opacity-70 hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
