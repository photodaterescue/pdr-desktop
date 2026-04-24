import { X, Move, Check } from 'lucide-react';
import type { PersonGender } from '@/lib/electron-bridge';
import { useDraggableModal } from './useDraggableModal';

interface GenderPickerModalProps {
  /** Anchor person the gender will be set on. Used only for the
   *  modal header; the write happens in `onSelect`. */
  personName: string;
  /** Currently-stored gender, used to pre-highlight a row so the user
   *  can see what's active. */
  currentGender: PersonGender;
  onSelect: (gender: PersonGender) => void;
  onClose: () => void;
}

const OPTIONS: { value: Exclude<PersonGender, null>; label: string; symbol: string; description: string }[] = [
  { value: 'male',               label: 'Male',               symbol: '♂', description: 'Mars symbol on the card' },
  { value: 'female',             label: 'Female',             symbol: '♀', description: 'Venus symbol on the card' },
  { value: 'non_binary',         label: 'Non-binary',         symbol: '⚥', description: 'Combined Venus + Mars symbol' },
  { value: 'prefer_not_to_say',  label: 'Prefer not to say',  symbol: '—', description: 'Private. No symbol shown on the card.' },
  { value: 'unknown',            label: 'Unknown',            symbol: '—', description: 'Historical record lost. No symbol shown.' },
];

/** Lightweight draggable modal to pick a person's gender — drives
 *  gendered relationship labels (Mother/Father/Sister/Brother) and the
 *  Mars/Venus/Combined symbol in the top-right of their card. */
export function GenderPickerModal({ personName, currentGender, onSelect, onClose }: GenderPickerModalProps) {
  // Shared drag hook — clamps so header stays on-screen.
  const { modalRef, dragHandleProps } = useDraggableModal();

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        ref={modalRef}
        className="bg-background rounded-xl shadow-2xl border border-border w-full max-w-md"
        onClick={e => e.stopPropagation()}
      >
        <div
          {...dragHandleProps}
          className={`border-b border-border px-4 py-3 relative ${dragHandleProps.className}`}
        >
          <Move className="absolute left-3 top-3 w-3.5 h-3.5 text-muted-foreground/60" aria-hidden />
          <button onClick={onClose} className="absolute right-3 top-3 p-1 rounded hover:bg-accent" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
          <h3 className="text-base font-semibold text-center text-foreground">Gender</h3>
          <p className="text-xs text-muted-foreground text-center mt-0.5">
            for <span className="font-medium text-foreground">{personName}</span>
          </p>
        </div>

        <div className="p-3 flex flex-col gap-1.5">
          {OPTIONS.map(opt => {
            const isCurrent = currentGender === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => onSelect(opt.value)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors ${
                  isCurrent
                    ? 'border-primary bg-primary/10'
                    : 'border-border hover:border-primary/40 hover:bg-accent/50'
                }`}
              >
                <div
                  className={`shrink-0 w-9 h-9 rounded-md flex items-center justify-center text-xl font-semibold ${
                    isCurrent ? 'bg-primary text-primary-foreground' : 'bg-accent text-foreground'
                  }`}
                  aria-hidden
                >
                  {opt.symbol}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground">{opt.label}</p>
                  <p className="text-xs text-muted-foreground truncate">{opt.description}</p>
                </div>
                {isCurrent && <Check className="w-4 h-4 text-primary shrink-0" />}
              </button>
            );
          })}

          {currentGender != null && (
            <button
              onClick={() => onSelect(null)}
              className="mt-1 text-xs text-muted-foreground hover:text-foreground text-center px-3 py-2 rounded-md hover:bg-accent/40"
            >
              Clear gender
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Pick the symbol rendered in the top-right corner of a person's card
 *  based on their stored gender. Returns null when no visible marker
 *  should show (unset / privacy / unknown). */
export function genderMarkerSymbol(gender: string | null | undefined): string | null {
  switch (gender) {
    case 'male':        return '♂';
    case 'female':      return '♀';
    case 'non_binary':  return '⚥';
    default:            return null;
  }
}
