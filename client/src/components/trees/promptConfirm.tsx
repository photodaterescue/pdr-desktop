import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, ChevronRight, X } from 'lucide-react';

/**
 * promptConfirm(message) — async replacement for the native window.confirm().
 * Renders a PDR-styled modal and returns a Promise<boolean | null>:
 *   - true  : user clicked the primary (Yes / Confirm) button.
 *   - false : user clicked the secondary text link (No / Cancel).
 *   - null  : user DISMISSED the modal (X close, backdrop click, Escape).
 *
 * The three-way return distinguishes an explicit "No" from a "I changed
 * my mind, abandon the whole flow" close. Existing callers using
 * `if (!ok) return` continue to work — null is falsy. New callers that
 * need to abort an enclosing operation on dismissal can check `=== null`.
 *
 * Why: native confirm() shows Electron's default system dialog, which looks
 * like a Windows 95 leftover. This keeps all confirmations on-brand and
 * consistent with the rest of the Trees UI.
 *
 * Premium-pass redesign (2026-04-30):
 *   • Wider (480px) so titles + buttons don't wrap on the most common copy.
 *   • Optional eyebrow caption ("CONFIRM PARENTAGE", small caps tracking)
 *     so the user knows the kind of decision before reading the title.
 *   • Optional avatar pair — two face crops with a chevron between them,
 *     anchoring "Is X also Y's parent?" visually.
 *   • Cancel rendered as a quiet text link, confirm as the primary
 *     button (one direction the user is being steered toward).
 *   • Footer separated from the body by a subtle border so the call to
 *     action sits in its own region.
 *
 * Usage:
 *   if (!(await promptConfirm('Remove this?'))) return;
 */
export function promptConfirm(options: string | ConfirmOptions): Promise<boolean | null> {
  const opts: ConfirmOptions = typeof options === 'string' ? { message: options } : options;
  return new Promise<boolean | null>((resolve) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const close = (result: boolean | null) => {
      root.unmount();
      container.remove();
      resolve(result);
    };
    root.render(
      <ConfirmDialog
        message={opts.message}
        title={opts.title}
        eyebrow={opts.eyebrow}
        avatars={opts.avatars}
        confirmLabel={opts.confirmLabel}
        cancelLabel={opts.cancelLabel}
        danger={opts.danger}
        hideCancel={opts.hideCancel}
        typeToConfirm={opts.typeToConfirm}
        onConfirm={() => close(true)}
        onCancel={() => close(false)}
        onDismiss={() => close(null)}
      />
    );
  });
}

export interface ConfirmAvatar {
  /** Image src — typically a base64 data URL from persons.avatar_data
   *  or a face crop generated via getFaceCrop. */
  src?: string | null;
  /** Single-character monogram fallback when no src is available. */
  initial?: string;
  /** Tooltip / aria label, e.g. the person's full name. */
  label?: string;
}

export interface ConfirmOptions {
  message: string;
  title?: string;
  /** Small-caps caption above the title — categorises the decision
   *  (e.g. "CONFIRM PARENTAGE"). Optional; omit for generic confirms. */
  eyebrow?: string;
  /** Pair of avatars rendered between eyebrow and title. Use the
   *  left/right slots when the question is about a relationship
   *  between two people; the chevron implies the direction. */
  avatars?: { left?: ConfirmAvatar; right?: ConfirmAvatar };
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
  message, title, eyebrow, avatars, confirmLabel, cancelLabel, danger, hideCancel, typeToConfirm, onConfirm, onCancel, onDismiss,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void; onDismiss: () => void }) {
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
      // Esc dismisses (different signal from the secondary "No"
      // button). Callers that want to abort a wider flow on
      // dismissal listen for the null return.
      if (e.key === 'Escape') onDismiss();
      // Only auto-confirm on Enter when the gate is passed. Without
      // this, a user hitting Enter before typing would bypass the
      // whole point of the confirmation.
      else if (e.key === 'Enter' && typedMatches) onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, onConfirm, requiresTyping, typedMatches]);

  const hasAvatars = !!avatars && (!!avatars.left || !!avatars.right);

  return (
    <div
      className={`fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4 transition-opacity ${mounted ? 'opacity-100' : 'opacity-0'}`}
      onClick={onDismiss}
    >
      <div
        className={`relative bg-background rounded-2xl shadow-2xl border border-border w-full max-w-[480px] transform transition-all ${mounted ? 'scale-100' : 'scale-95'}`}
        onClick={e => e.stopPropagation()}
      >
        {/* Close button — absolute so it never competes with the
            centred content for horizontal space. Dismisses (null)
            rather than counting as a "No" — important for callers
            that want to abort an enclosing flow on close. */}
        <button
          onClick={onDismiss}
          className="absolute right-3 top-3 p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Body */}
        <div className="px-6 pt-6 pb-5">
          {eyebrow && (
            <p className="text-[10px] font-semibold tracking-[0.18em] uppercase text-muted-foreground text-center mb-4">
              {eyebrow}
            </p>
          )}

          {hasAvatars && (
            <div className="flex items-center justify-center gap-3 mb-4">
              <Avatar avatar={avatars!.left} />
              {avatars!.left && avatars!.right && (
                <ChevronRight className="w-5 h-5 text-muted-foreground/60 shrink-0" />
              )}
              <Avatar avatar={avatars!.right} />
            </div>
          )}

          {/* Danger icon only renders when there are NO avatars — the
              two are mutually exclusive visual anchors and stacking
              both makes the modal head feel cluttered. */}
          {danger && !hasAvatars && (
            <div className="flex justify-center mb-3">
              <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
            </div>
          )}

          {title && (
            <h3 className="text-lg font-semibold text-foreground text-center mb-2 leading-snug">{title}</h3>
          )}
          <p className="text-sm text-muted-foreground text-center leading-relaxed">{message}</p>

          {requiresTyping && (
            <div className="mt-4">
              <p className="text-xs text-muted-foreground mb-1.5">
                To confirm, type <strong className="text-foreground">{typeToConfirm}</strong> below:
              </p>
              <input
                ref={inputRef}
                type="text"
                value={typedValue}
                onChange={e => setTypedValue(e.target.value)}
                placeholder={typeToConfirm}
                className={`w-full px-3 py-2 rounded-lg border bg-background text-sm font-mono ${
                  typedMatches
                    ? 'border-primary/60'
                    : typedValue.length > 0
                    ? 'border-red-400/60'
                    : 'border-border'
                }`}
              />
            </div>
          )}
        </div>

        {/* Footer — separated from body by a subtle border. Cancel
            renders as a quiet text link so the user's eye lands on
            the primary action; confirm is the bold call-to-action. */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-border/60">
          {!hideCancel ? (
            <button
              onClick={onCancel}
              className="text-sm text-muted-foreground hover:text-foreground font-medium transition-colors px-1"
            >
              {cancelLabel ?? 'Cancel'}
            </button>
          ) : <span />}
          <button
            onClick={() => { if (typedMatches) onConfirm(); }}
            autoFocus={!requiresTyping}
            disabled={!typedMatches}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              danger
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm'
            }`}
          >
            {confirmLabel ?? (danger ? 'Remove' : 'OK')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Multi-choice variant of promptConfirm. Same visual frame —
 *  width, eyebrow, avatars, title, body, footer separator — but the
 *  footer renders one button per choice instead of yes/no. Resolves
 *  to the chosen choice's id, or null on dismiss (X / backdrop / Esc).
 *
 *  Used for the parent-pair-relationship prompt in Trees: when a
 *  second parent is added for someone, ask whether the two parents
 *  are married, previously together, or just co-parents — each
 *  state maps to a different relationship-edge write.
 */
export function promptChoice<T extends string>(options: ChoiceOptions<T>): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const close = (result: T | null) => {
      root.unmount();
      container.remove();
      resolve(result);
    };
    root.render(
      <ChoiceDialog
        message={options.message}
        title={options.title}
        eyebrow={options.eyebrow}
        avatars={options.avatars}
        choices={options.choices}
        onPick={(id) => close(id)}
        onDismiss={() => close(null)}
      />
    );
  });
}

export interface ChoiceOption<T extends string> {
  /** Stable identifier returned to the caller. */
  id: T;
  /** Visible button text. */
  label: string;
  /** Optional secondary line under the label, lighter text. */
  description?: string;
  /** Visually emphasises this choice as the recommended path. The
   *  primary lavender button styling. Only one choice should set
   *  this. */
  primary?: boolean;
}

export interface ChoiceOptions<T extends string> {
  message: string;
  title?: string;
  eyebrow?: string;
  avatars?: { left?: ConfirmAvatar; right?: ConfirmAvatar };
  choices: ChoiceOption<T>[];
}

function ChoiceDialog<T extends string>({
  message, title, eyebrow, avatars, choices, onPick, onDismiss,
}: ChoiceOptions<T> & { onPick: (id: T) => void; onDismiss: () => void }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const hasAvatars = !!avatars && (!!avatars.left || !!avatars.right);

  return (
    <div
      className={`fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4 transition-opacity ${mounted ? 'opacity-100' : 'opacity-0'}`}
      onClick={onDismiss}
    >
      <div
        className={`relative bg-background rounded-2xl shadow-2xl border border-border w-full max-w-[480px] transform transition-all ${mounted ? 'scale-100' : 'scale-95'}`}
        onClick={e => e.stopPropagation()}
      >
        <button
          onClick={onDismiss}
          className="absolute right-3 top-3 p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="px-6 pt-6 pb-5">
          {eyebrow && (
            <p className="text-[10px] font-semibold tracking-[0.18em] uppercase text-muted-foreground text-center mb-4">
              {eyebrow}
            </p>
          )}

          {hasAvatars && (
            <div className="flex items-center justify-center gap-3 mb-4">
              <Avatar avatar={avatars!.left} />
              {avatars!.left && avatars!.right && (
                <ChevronRight className="w-5 h-5 text-muted-foreground/60 shrink-0" />
              )}
              <Avatar avatar={avatars!.right} />
            </div>
          )}

          {title && (
            <h3 className="text-lg font-semibold text-foreground text-center mb-2 leading-snug">{title}</h3>
          )}
          <p className="text-sm text-muted-foreground text-center leading-relaxed">{message}</p>
        </div>

        {/* Choice column — full-width buttons stacked vertically so
            each option's label has room to breathe. The recommended
            choice (primary: true) gets the bold lavender treatment;
            others render as secondary outline buttons. */}
        <div className="flex flex-col gap-2 px-6 py-4 border-t border-border/60">
          {choices.map(choice => (
            <button
              key={choice.id}
              onClick={() => onPick(choice.id)}
              className={`w-full text-left px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
                choice.primary
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm'
                  : 'bg-background border border-border hover:bg-accent text-foreground'
              }`}
            >
              <div>{choice.label}</div>
              {choice.description && (
                <div className={`text-xs font-normal mt-0.5 ${choice.primary ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>
                  {choice.description}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Single avatar slot — renders a face crop when src is provided,
 *  falls back to a coloured monogram circle otherwise. Used as a pair
 *  inside the modal's avatar row to anchor relationship questions. */
function Avatar({ avatar }: { avatar?: ConfirmAvatar }) {
  if (!avatar) return null;
  const initial = avatar.initial?.trim() || avatar.label?.trim()?.[0] || '?';
  return (
    <div className="shrink-0 w-14 h-14 rounded-full overflow-hidden ring-2 ring-primary/20 bg-primary/10 flex items-center justify-center" title={avatar.label}>
      {avatar.src ? (
        <img src={avatar.src} alt="" className="w-full h-full object-cover" />
      ) : (
        <span className="text-base font-semibold text-primary">{initial}</span>
      )}
    </div>
  );
}
