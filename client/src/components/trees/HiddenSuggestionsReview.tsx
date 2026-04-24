import { useState } from 'react';
import { EyeOff, Eye } from 'lucide-react';

/** Inline review list for persons the user has hidden from this tree's
 *  suggestion pickers. Collapsed by default — a one-line summary
 *  ("N hidden — review") until the user explicitly opens it. Keeps the
 *  picker footprint small when they're not actively untangling a
 *  mistake. Shared between FocusPickerModal (quick-add picker) and
 *  PlaceholderResolver (the "Who is this?" popover) so hides made in
 *  one surface are reviewable in the other. */
export function HiddenSuggestionsReview({
  hidden,
  onUnhide,
}: {
  hidden: { id: number; name: string }[];
  onUnhide: (personId: number) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  if (hidden.length === 0) return null;
  return (
    <div className="mt-2 border-t border-border pt-2">
      <button
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <EyeOff className="w-3 h-3" />
        <span>
          {hidden.length} hidden from this tree {open ? '— close' : '— review'}
        </span>
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col gap-0.5 max-h-32 overflow-auto">
          {hidden.map(p => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-muted/40 text-xs"
            >
              <span className="truncate">{p.name}</span>
              <button
                onClick={() => onUnhide(p.id)}
                className="inline-flex items-center gap-1 text-primary hover:underline shrink-0"
              >
                <Eye className="w-3 h-3" />
                Un-hide
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
