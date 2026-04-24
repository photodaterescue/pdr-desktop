import { useEffect, useRef, useState } from 'react';
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
        typeToConfirm={opts.typeToConfirm}
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
  /** When set, the user must type this exact string (case-insensitive,
   *  trimmed) into an input field before the Confirm button activates.
   *  Used for high-stakes destructive actions where a plain Yes/No
   *  could be clicked by accident — typing requires intent. */
  typeToConfirm?: string;
}

function ConfirmDialog({
  message, title, confirmLabel, cancelLabel, danger, hideCancel, typeToConfirm, onConfirm, onCancel,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  const [mounted, setMounted] = useState(false);
  const [typedValue, setTypedValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // For a type-to-confirm dialog, the confirm is enabled only when the
  // user's typed input matches (trimmed + lower-cased) the target
  // string. Case- and whitespace-insensitive keeps the gate effective
  // for intent while forgiving for minor fumbles.
  const requiresTyping = !!typeToConfirm;
  const typedMatches = requiresTyping
    ? typedValue.trim().toLowerCase() === typeToConfirm!.trim().toLowerCase()
    : true;

  useEffect(() => {
    setMounted(true);
    // Focus the type-to-confirm input when one's present so the user
    // can start typing immediately without hunting for the field.
    if (requiresTyping && inputRef.current) {
      inputRef.current.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      // Only auto-confirm on Enter when the gate is passed. Without
      // this, a user hitting Enter before typing would bypass the
      // whole point of the confirmation.
      else if (e.key === 'Enter' && typedMatches) onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, onConfirm, requiresTyping, typedMatches]);

  return (
    <div
      className={`fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4 transition-opacity ${mounted ? 'opacity-100' : 'opacity-0'}`}
      onClick={onCancel}
    >
      <div
        className={`bg-background rounded-xl shadow-2xl border border-border max-w-sm w-full p-5 transform transition-all ${mounted ? 'scale-100' : 'scale-95'}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="relative mb-4">
          <button
            onClick={onCancel}
            className="absolute right-0 top-0 p-1 rounded hover:bg-accent"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
          {danger && (
            <div className="flex justify-center mb-2">
              <div className="shrink-0 w-8 h-8 rounded-full bg-red-500/10 flex items-center justify-center">
                <AlertTriangle className="w-4 h-4 text-red-600" />
              </div>
            </div>
          )}
          {title && (
            <h3 className="text-base font-semibold text-center mb-2 px-6">{title}</h3>
          )}
          <p className="text-sm text-foreground">{message}</p>
        </div>
        {requiresTyping && (
          <div className="mb-4">
            <p className="text-xs text-muted-foreground mb-1.5">
              To confirm, type <strong className="text-foreground">{typeToConfirm}</strong> below:
            </p>
            <input
              ref={inputRef}
              type="text"
              value={typedValue}
              onChange={e => setTypedValue(e.target.value)}
              placeholder={typeToConfirm}
              className={`w-full px-3 py-1.5 rounded-lg border bg-background text-sm font-mono ${
                typedMatches
                  ? 'border-primary/50'
                  : typedValue.length > 0
                  ? 'border-red-400/50'
                  : 'border-border'
              }`}
            />
          </div>
        )}
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
            onClick={() => { if (typedMatches) onConfirm(); }}
            autoFocus={!requiresTyping}
            disabled={!typedMatches}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-opacity disabled:opacity-40 disabled:cursor-not-allowed ${
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
