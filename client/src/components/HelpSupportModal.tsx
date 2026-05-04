import { useEffect } from 'react';
import { X } from 'lucide-react';
import { HelpSupportContent } from './HelpSupportContent';

interface HelpSupportModalProps {
  /** Fires on backdrop click, X click, or Escape keypress. */
  onClose: () => void;
}

/**
 * Welcome-only Help & Support modal.
 *
 * Pre-destination users on the Welcome screen can open this from the
 * floating ? button without being routed through the Workspace shell
 * (whose sidebar would otherwise expose every destination-required
 * feature as an active escape hatch). Same content as the in-Workspace
 * panel — different chrome.
 *
 * Backdrop / shadow / radius copy ReportProblemModal's pattern so the
 * two modals read as the same surface family.
 */
export function HelpSupportModal({ onClose }: HelpSupportModalProps) {
  // Close on Escape — standard modal affordance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-background rounded-xl shadow-2xl border border-border w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-labelledby="help-support-modal-title"
      >
        {/* Header — sticky on its own row so the close button stays
            reachable while the user scrolls through long accordions. */}
        <div className="border-b border-border px-6 py-4 relative shrink-0">
          <h3 id="help-support-modal-title" className="text-base font-semibold text-foreground">
            Help & Support
          </h3>
          <button
            onClick={onClose}
            className="absolute right-3 top-3 p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable content. The HelpSupportContent component
            renders its own internal h2 + description + accordions —
            we keep them so the layout matches the in-Workspace panel
            beat for beat. */}
        <div className="overflow-y-auto px-6 py-6 flex-1 min-h-0">
          {/* No onStartTour — the "Take a Quick Tour" accordion is
              hidden so users can't short-cut into Workspace via the
              tour from a Welcome where no Library Drive is set. */}
          <HelpSupportContent />
        </div>
      </div>
    </div>
  );
}
