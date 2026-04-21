import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { updatePersonLifeEvents } from '@/lib/electron-bridge';

interface DateQuickEditorProps {
  personId: number;
  personName: string;
  /** Existing ISO-ish birth date ('YYYY', 'YYYY-MM', 'YYYY-MM-DD') or null. */
  birthDate: string | null;
  /** Existing ISO-ish death date or null (= still living). */
  deathDate: string | null;
  x: number;
  y: number;
  onSaved: () => void;
  onClose: () => void;
}

/**
 * Compact year editor anchored to a person's card. Year-only for both
 * birth and death, because that's what families actually remember.
 * "Still living" toggles the death-year field off. Clicking outside or
 * Escape closes without saving; Enter saves.
 */
export function DateQuickEditor({
  personId, personName, birthDate, deathDate, x, y, onSaved, onClose,
}: DateQuickEditorProps) {
  const [birthYear, setBirthYear] = useState(extractYear(birthDate));
  const [deathYear, setDeathYear] = useState(extractYear(deathDate));
  const [stillLiving, setStillLiving] = useState(deathDate == null || deathDate === '');
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
    const bYear = birthYear.trim();
    const dYear = deathYear.trim();
    // Validation — allow blank birth, but if present must be 4 digits.
    if (bYear && !/^\d{4}$/.test(bYear)) { setError('Birth year must be 4 digits.'); return; }
    if (!stillLiving && dYear && !/^\d{4}$/.test(dYear)) { setError('Death year must be 4 digits.'); return; }
    const bNum = bYear ? parseInt(bYear, 10) : null;
    const dNum = (!stillLiving && dYear) ? parseInt(dYear, 10) : null;
    if (bNum != null && dNum != null && dNum < bNum) { setError('Death year is before birth year.'); return; }

    setBusy(true);
    const r = await updatePersonLifeEvents(personId, {
      birthDate: bYear || null,
      deathDate: stillLiving ? null : (dYear || null),
    });
    setBusy(false);
    if (r.success) onSaved();
    else setError(r.error ?? 'Could not save.');
  };

  return (
    <div
      ref={ref}
      className="absolute z-40 bg-popover border border-border rounded-xl shadow-2xl p-3 min-w-[260px]"
      style={{ left: x, top: y, transform: 'translate(-50%, -50%)' }}
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm font-semibold flex-1 truncate">{personName} — life dates</span>
        <button onClick={onClose} className="p-0.5 rounded hover:bg-accent">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-2 mb-2">
        <label className="text-xs text-muted-foreground w-16">Born</label>
        <input
          autoFocus
          type="text"
          inputMode="numeric"
          maxLength={4}
          value={birthYear}
          onChange={e => setBirthYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
          onKeyDown={e => { if (e.key === 'Enter') save(); }}
          placeholder="1948"
          className="flex-1 px-2 py-1 rounded border border-border bg-background text-sm font-mono"
        />
      </div>

      <div className="flex items-center gap-2 mb-2">
        <label className="text-xs text-muted-foreground w-16">Died</label>
        <input
          type="text"
          inputMode="numeric"
          maxLength={4}
          value={stillLiving ? '' : deathYear}
          onChange={e => setDeathYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
          onKeyDown={e => { if (e.key === 'Enter') save(); }}
          placeholder={stillLiving ? 'Still living' : '2022'}
          disabled={stillLiving}
          className="flex-1 px-2 py-1 rounded border border-border bg-background text-sm font-mono disabled:opacity-50"
        />
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-foreground mb-3 cursor-pointer">
        <input
          type="checkbox"
          checked={stillLiving}
          onChange={e => setStillLiving(e.target.checked)}
          className="accent-primary"
        />
        Still living
      </label>

      {error && <div className="mb-2 text-xs text-red-600">{error}</div>}

      <div className="flex items-center justify-end gap-2">
        <button onClick={onClose} className="px-3 py-1 rounded text-xs hover:bg-accent">Cancel</button>
        <button
          onClick={save}
          disabled={busy}
          className="px-3 py-1 rounded bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 hover:bg-primary/90"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

/** Pull the year out of a partial ISO date — we store 'YYYY', 'YYYY-MM'
 *  or 'YYYY-MM-DD' depending on what the user typed. */
function extractYear(value: string | null): string {
  if (!value) return '';
  const m = /^(\d{4})/.exec(value);
  return m ? m[1] : '';
}
