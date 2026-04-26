import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { renamePerson } from '@/lib/electron-bridge';

interface NameQuickEditorProps {
  personId: number;
  /** Current short name (`persons.name`). */
  initialName: string;
  /** Current full name (`persons.full_name`) or null if not set. */
  initialFullName: string | null;
  x: number;
  y: number;
  onSaved: () => void;
  onClose: () => void;
}

/**
 * Compact two-field name editor anchored to a person's card on the
 * Trees canvas. Trees is where users most often realise they want to
 * fill in someone's middle / surname, so we surface the editor right
 * where they're looking. Mirrors DateQuickEditor's behaviour:
 * click-outside / Escape closes, Enter saves.
 *
 * Short name is required (it's the canonical identifier shown in PM
 * + S&D). Full name is optional — empty saves as null and Trees falls
 * back to the short name.
 */
export function NameQuickEditor({
  personId, initialName, initialFullName, x, y, onSaved, onClose,
}: NameQuickEditorProps) {
  const [shortName, setShortName] = useState(initialName);
  const [fullName, setFullName] = useState(initialFullName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(target)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  const save = async () => {
    setError(null);
    const trimmedShort = shortName.trim();
    if (!trimmedShort) { setError('Short name is required.'); return; }
    setBusy(true);
    // Empty full_name string → save as null so Trees falls back to
    // the short name and S&D / PM stay clean.
    const fullToSend = fullName.trim() ? fullName.trim() : null;
    const r = await renamePerson(personId, trimmedShort, fullToSend);
    setBusy(false);
    if (r.success) onSaved();
    else setError((r as any).error ?? 'Could not save.');
  };

  return (
    <div
      ref={ref}
      className="absolute z-40 bg-popover border border-border rounded-xl shadow-2xl p-3 min-w-[300px]"
      style={{ left: x, top: y, transform: 'translate(-50%, -50%)' }}
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm font-semibold flex-1 truncate">Edit names</span>
        <button onClick={onClose} className="p-0.5 rounded hover:bg-accent">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex flex-col gap-1.5 mb-2">
        <label className="text-[11px] text-muted-foreground">Name (short)</label>
        <input
          autoFocus
          type="text"
          value={shortName}
          onChange={e => setShortName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); }}
          placeholder="Terry"
          className="px-2 py-1 rounded border border-border bg-background text-sm"
        />
        <span className="text-[10px] text-muted-foreground/70">Used in People Manager and Search & Discovery.</span>
      </div>

      <div className="flex flex-col gap-1.5 mb-3">
        <label className="text-[11px] text-muted-foreground">Name (full) — optional</label>
        <input
          type="text"
          value={fullName}
          onChange={e => setFullName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); }}
          placeholder="Terry John Filmer Clapson"
          className="px-2 py-1 rounded border border-border bg-background text-sm"
        />
        <span className="text-[10px] text-muted-foreground/70">Shown on this Tree card. Leave blank to fall back to the short name.</span>
      </div>

      {error && <div className="mb-2 text-xs text-red-600">{error}</div>}

      <div className="flex items-center justify-end gap-2">
        <button onClick={onClose} className="px-3 py-1 rounded text-xs hover:bg-accent">Cancel</button>
        <button
          onClick={save}
          disabled={busy || !shortName.trim()}
          className="px-3 py-1 rounded bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 hover:bg-primary/90"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
