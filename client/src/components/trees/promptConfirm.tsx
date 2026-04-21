import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, X } from 'lucide-react';

/**
 * promptConfirm(message) — async replacement for the native window.confirm().
 * Renders a PDR-styled modal and returns a Promise<boolean> that resolves
 * true if the user confirmed, false if they cancelled.
 *
 * Why: native confirm() shows Electron's default system dialog, which looks
 * like a Windows 95 leftover. This keeps all confirmations on-brand and
 * consistent with the rest of the Trees UI.
 *
 * Usage:
 *   if (!(await promptConfirm('Remove this?'))) return;
 */
export function promptConfirm(options: string | ConfirmOptions): Promise<boolean> {
  const opts: ConfirmOptions = typeof options === 'string' ? { message: options } : options;
  return new Promise<boolean>((resolve) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const close = (result: boolean) => {
      root.unmount();
      container.remove();
      resolve(result);
    };
    root.render(
      <ConfirmDialog
        message={opts.message}
        title={opts.title}
        confirmLabel={opts.confirmLabel}
        cancelLabel={opts.cancelLabel}
        danger={opts.danger}
        hideCancel={opts.hideCancel}
        onConfirm={() => close(true)}
        onCancel={() => close(false)}
      />
    );
  });
}

export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button red for destructive operations. */
  danger?: boolean;
  /** Hide the cancel button entirely — use for info-only "OK" dialogs
   *  where there's nothing to cancel. Clicking the backdrop or Escape
   *  still dismisses, but the footer shows only the confirm button. */
  hideCancel?: boolean;
}

function ConfirmDialog({
  message, title, confirmLabel, cancelLabel, danger, hideCancel, onConfirm, onCancel,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, onConfirm]);

  return (
    <div
      className={`fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4 transition-opacity ${mounted ? 'opacity-100' : 'opacity-0'}`}
      onClick={onCancel}
    >
      <div
        className={`bg-background rounded-xl shadow-2xl border border-border max-w-sm w-full p-5 transform transition-all ${mounted ? 'scale-100' : 'scale-95'}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-4">
          {danger ? (
            <div className="shrink-0 w-8 h-8 rounded-full bg-red-500/10 flex items-center justify-center">
              <AlertTriangle className="w-4 h-4 text-red-600" />
            </div>
          ) : null}
          <div className="flex-1">
            {title && <h3 className="text-base font-semibold mb-1">{title}</h3>}
            <p className="text-sm text-foreground">{message}</p>
          </div>
          <button onClick={onCancel} className="p-1 rounded hover:bg-accent">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center justify-end gap-2">
          {!hideCancel && (
            <button
              onClick={onCancel}
              className="px-3 py-1.5 rounded-lg text-sm hover:bg-accent"
            >
              {cancelLabel ?? 'Cancel'}
            </button>
          )}
          <button
            onClick={onConfirm}
            autoFocus
            className={`px-4 py-1.5 rounded-lg text-sm font-medium ${
              danger
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            }`}
          >
            {confirmLabel ?? (danger ? 'Remove' : 'OK')}
          </button>
        </div>
      </div>
    </div>
  );
}
