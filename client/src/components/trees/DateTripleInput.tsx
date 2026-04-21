import { useRef, useState, useEffect } from 'react';

interface DateTripleInputProps {
  /** ISO date string (YYYY-MM-DD) or empty. */
  value: string;
  onChange: (isoDate: string) => void;
  /** Optional label shown above the inputs. */
  label?: string;
  /** Optional smaller helper text shown underneath. */
  hint?: string;
}

/**
 * Triple-input date picker: DD / MM / YYYY, typed directly.
 *
 * Why this instead of the native <input type="date">:
 * selecting a year 20+ years in the past via the native year dropdown is
 * painful — the dropdown scrolls one year at a time. Here you just type
 * the four digits for the year; focus auto-advances between fields.
 *
 * Accepts partial entries (e.g. just the year) and only emits a final
 * ISO string when all three fields parse as a valid calendar date.
 */
export function DateTripleInput({ value, onChange, label, hint }: DateTripleInputProps) {
  const [day, setDay] = useState('');
  const [month, setMonth] = useState('');
  const [year, setYear] = useState('');

  const dayRef = useRef<HTMLInputElement>(null);
  const monthRef = useRef<HTMLInputElement>(null);
  const yearRef = useRef<HTMLInputElement>(null);

  // Sync incoming `value` → three fields.
  useEffect(() => {
    if (!value) {
      setDay(''); setMonth(''); setYear('');
      return;
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (m) {
      setYear(m[1]);
      setMonth(m[2]);
      setDay(m[3]);
    }
  }, [value]);

  // Emit canonical ISO string when all three parts are complete and valid.
  const emit = (d: string, mo: string, y: string) => {
    const dNum = parseInt(d, 10);
    const mNum = parseInt(mo, 10);
    const yNum = parseInt(y, 10);
    if (!Number.isFinite(dNum) || !Number.isFinite(mNum) || !Number.isFinite(yNum)) {
      onChange('');
      return;
    }
    if (y.length !== 4 || yNum < 1800 || yNum > 2200) { onChange(''); return; }
    if (mNum < 1 || mNum > 12) { onChange(''); return; }
    if (dNum < 1 || dNum > 31) { onChange(''); return; }
    // Minimal validity — let JS Date do the lift.
    const probe = new Date(yNum, mNum - 1, dNum);
    if (probe.getFullYear() !== yNum || probe.getMonth() !== mNum - 1 || probe.getDate() !== dNum) {
      onChange('');
      return;
    }
    const iso = `${y.padStart(4, '0')}-${String(mNum).padStart(2, '0')}-${String(dNum).padStart(2, '0')}`;
    onChange(iso);
  };

  const handleDayChange = (raw: string) => {
    const cleaned = raw.replace(/\D/g, '').slice(0, 2);
    setDay(cleaned);
    emit(cleaned, month, year);
    if (cleaned.length === 2) monthRef.current?.focus();
  };

  const handleMonthChange = (raw: string) => {
    const cleaned = raw.replace(/\D/g, '').slice(0, 2);
    setMonth(cleaned);
    emit(day, cleaned, year);
    if (cleaned.length === 2) yearRef.current?.focus();
  };

  const handleYearChange = (raw: string) => {
    const cleaned = raw.replace(/\D/g, '').slice(0, 4);
    setYear(cleaned);
    emit(day, month, cleaned);
  };

  const handleKey = (which: 'day' | 'month' | 'year', e: React.KeyboardEvent<HTMLInputElement>) => {
    // Backspace on empty field → jump back to previous field.
    if (e.key === 'Backspace') {
      const target = e.currentTarget.value;
      if (target === '') {
        if (which === 'month') dayRef.current?.focus();
        else if (which === 'year') monthRef.current?.focus();
      }
    }
    // Slash or space → jump forward.
    if (e.key === '/' || e.key === ' ' || e.key === '-') {
      e.preventDefault();
      if (which === 'day') monthRef.current?.focus();
      else if (which === 'month') yearRef.current?.focus();
    }
  };

  const clear = () => {
    setDay(''); setMonth(''); setYear('');
    onChange('');
    dayRef.current?.focus();
  };

  return (
    <div>
      {label && <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</label>}
      <div className={`mt-1.5 flex items-center gap-1 px-2 py-1 rounded-lg border border-border bg-background ${label ? '' : ''}`}>
        <input
          ref={dayRef}
          type="text"
          inputMode="numeric"
          placeholder="DD"
          value={day}
          onChange={e => handleDayChange(e.target.value)}
          onKeyDown={e => handleKey('day', e)}
          onFocus={e => e.currentTarget.select()}
          className="w-8 text-center bg-transparent text-sm focus:outline-none"
          maxLength={2}
        />
        <span className="text-muted-foreground">/</span>
        <input
          ref={monthRef}
          type="text"
          inputMode="numeric"
          placeholder="MM"
          value={month}
          onChange={e => handleMonthChange(e.target.value)}
          onKeyDown={e => handleKey('month', e)}
          onFocus={e => e.currentTarget.select()}
          className="w-8 text-center bg-transparent text-sm focus:outline-none"
          maxLength={2}
        />
        <span className="text-muted-foreground">/</span>
        <input
          ref={yearRef}
          type="text"
          inputMode="numeric"
          placeholder="YYYY"
          value={year}
          onChange={e => handleYearChange(e.target.value)}
          onKeyDown={e => handleKey('year', e)}
          onFocus={e => e.currentTarget.select()}
          className="w-14 text-center bg-transparent text-sm focus:outline-none"
          maxLength={4}
        />
        {(day || month || year) && (
          <button
            type="button"
            onClick={clear}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground px-1"
            title="Clear date"
          >
            ×
          </button>
        )}
      </div>
      {hint && <p className="text-[10px] text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}
