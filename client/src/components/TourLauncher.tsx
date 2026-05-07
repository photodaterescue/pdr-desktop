import { useState } from 'react';
import { HelpCircle, BookOpen, ChevronRight } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import type { TourStep, TourMeta } from '@/components/ui/tour-overlay';

/**
 * One menu item shown in the launcher popover. `primary: true` items
 * appear above the divider with a solid coloured book icon — usually
 * the "Quick Tour for [current view]" entry. Non-primary items
 * (Getting Started, Best Practices, Help & Support) sit below.
 *
 * `meta` carries the brand colour + display name for tour items.
 * When supplied, the popover renders the book icon in that accent
 * and the host window receives the meta alongside the steps so the
 * TourOverlay tints itself the same colour.
 */
export interface TourMenuItem {
  id: string;
  label: string;
  description?: string;
  primary?: boolean;
  steps?: TourStep[];           // present → starts a tour
  meta?: TourMeta;               // brand name + accent for tour items
  icon?: React.ReactNode;        // custom leading icon (overrides the default book icon)
  onClick?: () => void;          // alternative: arbitrary action (open Help panel etc.)
}

interface TourLauncherProps {
  /** Items shown in the popover, top-down. */
  items: TourMenuItem[];
  /**
   * Called when the user clicks an item that has `steps`. The hosting
   * window should set its tour state from these steps and open its
   * TourOverlay. Items with `onClick` instead of `steps` invoke that
   * callback directly without going through this prop. The optional
   * `meta` argument carries the brand metadata so the host can pass
   * it straight through to TourOverlay.
   */
  onStartTour: (steps: TourStep[], meta?: TourMeta) => void;
  /**
   * Override the trigger styling. Default is the round 28×28 button
   * used in the TitleBar. `bare` strips the background hover so the
   * button can sit inside a darker surface (e.g. PeopleManager
   * header) without a hard pill.
   */
  triggerStyle?: 'titlebar' | 'bare';
  /**
   * Optional className override for the trigger button — useful for
   * positioning inside a flex parent without wrapping in another div.
   */
  className?: string;
  /**
   * Brand accent for the trigger button itself. When supplied (e.g.
   * the active view's accent), the button's background pill takes
   * this colour so the launcher visually identifies the current
   * app the same way the sidebar / Welcome card / tour overlay do.
   * Falls back to the default trigger styling when omitted.
   */
  triggerAccent?: string;
}

/**
 * Global "?" launcher — drops a help icon that, when clicked, opens
 * a popover listing the relevant Quick Tour for the current app
 * plus any additional guidance entry points the host wants to surface.
 *
 * Lives in the TitleBar of the main window (Workspace / Home / etc.)
 * and is also embedded in the Date Editor and People Manager windows
 * so users have one consistent affordance ("?" top-right) regardless
 * of which PDR window is active.
 */
export function TourLauncher({ items, onStartTour, triggerStyle = 'titlebar', className, triggerAccent }: TourLauncherProps) {
  const [open, setOpen] = useState(false);

  // Trigger styles. When triggerAccent is supplied the button takes the
  // brand-coloured pill; otherwise it falls back to the standard
  // titlebar/bare styling. White icon on a tinted pill mirrors the
  // primary CTA convention (text-primary-foreground = white on lavender).
  const baseClasses = 'flex items-center justify-center w-7 h-7 rounded-full transition-all';
  const triggerClasses = triggerAccent
    ? `${baseClasses} text-white hover:opacity-90`
    : triggerStyle === 'titlebar'
      ? `${baseClasses} hover:bg-white/20 text-white/80 hover:text-white`
      : `${baseClasses} hover:bg-secondary text-muted-foreground hover:text-foreground`;
  const triggerStyleObj = triggerAccent ? { backgroundColor: triggerAccent } : undefined;

  const handleItemClick = (item: TourMenuItem) => {
    setOpen(false);
    if (item.steps) {
      onStartTour(item.steps, item.meta);
    } else if (item.onClick) {
      item.onClick();
    }
  };

  // Split items into "primary" (Quick Tour for current view) and the
  // rest so we can render a divider between them. If there are no
  // primary items, everything renders as one block.
  const primaryItems = items.filter(i => i.primary);
  const otherItems = items.filter(i => !i.primary);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <IconTooltip label="Tours & guidance" side="bottom">
        <PopoverTrigger asChild>
          <button
            type="button"
            className={className ?? triggerClasses}
            style={triggerStyleObj}
            data-testid="tour-launcher-trigger"
            aria-label="Tours and guidance"
          >
            <HelpCircle className="w-3.5 h-3.5" />
          </button>
        </PopoverTrigger>
      </IconTooltip>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-72 p-1.5"
        data-testid="tour-launcher-popover"
      >
        <div className="px-2.5 py-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Tours & guidance</p>
        </div>
        {primaryItems.length > 0 && (
          <div className="space-y-0.5">
            {primaryItems.map(item => {
              const itemAccent = item.meta?.accent;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleItemClick(item)}
                  className="w-full flex items-start gap-3 px-2.5 py-2 rounded-md hover:bg-secondary transition-colors text-left group"
                  data-testid={`tour-launcher-${item.id}`}
                >
                  <BookOpen
                    className="w-4 h-4 mt-0.5 shrink-0"
                    style={itemAccent ? { color: itemAccent } : undefined}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">{item.label}</div>
                    {item.description && (
                      <div className="text-xs text-muted-foreground truncate">{item.description}</div>
                    )}
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50 group-hover:text-foreground/70 transition-colors mt-1 shrink-0" />
                </button>
              );
            })}
          </div>
        )}
        {primaryItems.length > 0 && otherItems.length > 0 && (
          <div className="my-1 border-t border-border" />
        )}
        {otherItems.length > 0 && (
          <div className="space-y-0.5">
            {otherItems.map(item => {
              const itemAccent = item.meta?.accent;
              // Icon precedence: custom item.icon (e.g. sidebar PNG for
              // Getting Started / Best Practices / etc.) > default
              // BookOpen tinted with the tour accent (for tour items
              // without a custom icon) > muted BookOpen fallback. Wrap
              // the slot in a fixed-width box so labels line up
              // regardless of which icon kind a row has.
              const iconNode = item.icon
                ? <span className="w-4 h-4 shrink-0 flex items-center justify-center">{item.icon}</span>
                : item.steps
                  ? <BookOpen
                      className="w-3.5 h-3.5 shrink-0"
                      style={itemAccent ? { color: itemAccent } : { color: 'var(--muted-foreground)' }}
                    />
                  : null;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleItemClick(item)}
                  className="w-full flex items-center gap-3 px-2.5 py-2 rounded-md hover:bg-secondary transition-colors text-left"
                  data-testid={`tour-launcher-${item.id}`}
                >
                  {iconNode}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-foreground truncate">{item.label}</div>
                    {item.description && (
                      <div className="text-xs text-muted-foreground truncate">{item.description}</div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
