import { useState, useMemo, useRef, useEffect } from 'react';
import { Search, X, ArrowRight } from 'lucide-react';
import { searchCompanion, type CompanionResult } from '@/lib/companion-search';
import { COMPANION_PANEL_LABEL, type CompanionPanel } from '@/lib/companion-corpus';
import { AiSparkle } from '@/components/AiSparkle';

/**
 * Companion Phase A — "Ask PDR" smart help search (v3.1, Terry).
 *
 * A search box that answers a plain-English question from PDR's OWN built-in help. It surfaces only
 * real, curated answers (companion-corpus.ts) via a fast offline matcher (companion-search.ts) — no
 * download, no network, no made-up answers. "Read more in ‹panel›" deep-links to the fuller section.
 *
 * Lives at the top of Help & Support. The optional onNavigate lets a result jump to a Getting
 * Started / Best Practices section; when it's absent (e.g. the pre-Library-Drive Welcome modal) the
 * self-contained answer card is shown without the jump link.
 *
 * The single BEST answer (when the match is confident) wears the fuchsia→violet "Share" gradient
 * outline + glow (r588, Terry) — the same AI accent used across PDR — to signal "this is the answer".
 */
const EXAMPLES = [
  'How do I get my photos in?',
  'What does _MK mean?',
  'Where do my collages go?',
  'Is it private?',
  'Make an Instagram carousel',
];

export function CompanionSearch({ onNavigate }: { onNavigate?: (panel: CompanionPanel, section: string) => void }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const outcome = useMemo(() => searchCompanion(query), [query]);
  const trimmed = query.trim();
  const showResults = trimmed.length >= 2;
  const results = outcome.results.slice(0, 4);

  // v3.1 (Terry) — the titlebar "Ask PDR" menu item opens Help & Support then fires this so the box is
  // focused and ready to type on arrival.
  useEffect(() => {
    const onFocus = () => {
      const el = inputRef.current;
      if (!el) return;
      try { el.scrollIntoView({ block: 'center' }); } catch { /* noop */ }
      el.focus();
      el.select();
    };
    // Fresh open from the titlebar menu: the box mounts AFTER the menu click, so a flag (not just the
    // event, which can fire before this listener exists) makes the focus land reliably — and after the
    // dropdown has restored+released focus from its trigger.
    const w = window as unknown as { __pdrAskFocus?: boolean };
    if (w.__pdrAskFocus) { w.__pdrAskFocus = false; setTimeout(onFocus, 140); }
    window.addEventListener('pdr:ask-pdr-focus', onFocus);
    return () => window.removeEventListener('pdr:ask-pdr-focus', onFocus);
  }, []);

  const cardBody = (r: CompanionResult) => (
    <>
      <p className="font-medium text-foreground text-sm mb-1">{r.entry.q}</p>
      <p className="text-sm text-muted-foreground leading-relaxed">{r.entry.a}</p>
      {onNavigate && r.entry.panel !== 'help-support' && (
        <button
          type="button"
          onClick={() => onNavigate(r.entry.panel, r.entry.section)}
          className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline cursor-pointer"
        >
          Read more in {COMPANION_PANEL_LABEL[r.entry.panel]} <ArrowRight className="w-3 h-3" />
        </button>
      )}
    </>
  );

  return (
    <div className="rounded-xl border border-[#8b5cf6]/50 bg-primary/[0.04] p-4 mb-10" data-testid="companion-search">
      <div className="flex items-center gap-2 mb-2.5">
        <AiSparkle className="w-4 h-4" />
        <h3 className="text-sm font-semibold text-foreground">Ask PDR</h3>
        <span className="text-xs text-muted-foreground">— type a question in your own words</span>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Don't let Enter/Escape bubble to any global handler; Escape clears the box.
            if (e.key === 'Enter' || e.key === 'Escape') e.stopPropagation();
            if (e.key === 'Escape') setQuery('');
          }}
          placeholder="e.g. how do I get my photos in?"
          className="w-full rounded-lg border border-border bg-background pl-9 pr-9 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/50"
          aria-label="Ask PDR a question"
          data-testid="companion-search-input"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground rounded"
            aria-label="Clear"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {!showResults && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setQuery(ex)}
              className="text-xs px-2.5 py-1 rounded-full border border-border bg-secondary/40 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {showResults && (
        <div className="mt-3.5 space-y-2.5">
          {results.length === 0 ? (
            <div className="p-4 bg-secondary/30 border border-border rounded-lg text-sm text-muted-foreground leading-relaxed">
              I couldn&apos;t find that in the built-in help yet. Try rewording it, browse the topics below, or open{' '}
              <span className="font-medium text-foreground">When to Contact Support</span>.
            </div>
          ) : (
            <>
              {outcome.quality === 'weak' && (
                <p className="text-xs text-muted-foreground">Not sure exactly — here are the closest matches:</p>
              )}
              {results.map((r, i) => {
                const best = i === 0 && outcome.quality === 'good';
                if (best) {
                  // The confident top answer wears the AI fuchsia→violet Share-gradient outline + glow.
                  return (
                    <div
                      key={r.entry.id}
                      className="rounded-lg bg-gradient-to-r from-[#c026d3] to-[#f062f5] p-[1.5px] shadow-[0_0_12px_rgba(217,70,239,0.5)]"
                    >
                      <div className="rounded-[6.5px] bg-background px-4 py-3.5">
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <AiSparkle className="w-3.5 h-3.5" />
                          <span className="text-[0.66rem] font-bold uppercase tracking-[0.06em] bg-gradient-to-r from-[#c026d3] to-[#f062f5] bg-clip-text text-transparent">
                            Best answer
                          </span>
                        </div>
                        {cardBody(r)}
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={r.entry.id} className="p-4 rounded-lg border border-border bg-secondary/30">
                    {cardBody(r)}
                  </div>
                );
              })}
              <p className="text-[0.7rem] text-muted-foreground/70 pt-0.5">
                Answers come straight from PDR&apos;s built-in help — nothing leaves your computer.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
