import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { motion, Variants } from "framer-motion";
import { HardDrive, PlayCircle, ShieldCheck, ArrowRight, Check, LayoutDashboard, Sparkles, CalendarClock, Network, Users, HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/custom-button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/custom-card";
import { resetTourCompletion } from "@/components/ui/tour-overlay";
import { useZoomLevel } from "@/hooks/useZoomLevel";
import { ZoomControls } from "@/components/ZoomControls";
import { getSettings, isElectron, prewarmDrives } from "@/lib/electron-bridge";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { HelpSupportModal } from "@/components/HelpSupportModal";
import { isTreesEnabled, TREES_RELEASED_SHORTLY_MESSAGE } from "@/lib/feature-flags";

const SKIP_WELCOME_KEY = 'pdr-skip-welcome';

function getSkipWelcomeScreen(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(SKIP_WELCOME_KEY) === 'true';
}

function setSkipWelcomeScreen(skip: boolean): void {
  if (typeof window !== 'undefined') {
    if (skip) {
      localStorage.setItem(SKIP_WELCOME_KEY, 'true');
    } else {
      localStorage.removeItem(SKIP_WELCOME_KEY);
    }
  }
}

export default function Home() {
  const navigate = useNavigate();
  const [skipScreen, setSkipScreen] = useState(getSkipWelcomeScreen());
  // Per-surface zoom — Welcome has its own pdr-welcome-zoom key so
  // a zoom choice made on Workspace, People Manager, source-selection,
  // etc. doesn't silently change the Welcome screen the next time
  // the user lands here. Applied as CSS `zoom` on the content wrapper
  // so the whole screen scales together. Ctrl+wheel is window-scoped
  // via the hook's internal listener.
  const zoom = useZoomLevel('pdr-welcome-zoom');

  // Sticky destination — rehydrated from electron-store on mount.
  // `null` until the user has picked one for the first time. Drives
  // the locked / unlocked state of every secondary CTA on this page.
  // We use a sentinel (`undefined`) for "still loading" so we don't
  // render the locked state for a split-second on returning users.
  const [destinationPath, setDestinationPath] = useState<string | null | undefined>(undefined);

  // One-shot pulse on the hero card. Fires when a locked card is
  // clicked so the user sees where to go without having to read a
  // scolding chip. Reset to `false` after the animation runs once.
  const [heroPulse, setHeroPulse] = useState(false);

  // Help & Support modal — opened by the floating ? button. Lives on
  // Welcome rather than routing into /workspace?panel=help-support so
  // the user isn't dragged through the Workspace shell (whose sidebar
  // would otherwise expose every destination-required feature as an
  // active escape hatch).
  const [showHelpModal, setShowHelpModal] = useState(false);
  const heroPulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (skipScreen) {
      navigate("/workspace", { replace: true });
    }
  }, [skipScreen, navigate]);

  // Load sticky destination from electron-store. In a non-Electron
  // (web preview) environment this resolves to defaults — destination
  // stays null and the locked state shows, which is the correct
  // first-time-user experience.
  useEffect(() => {
    let cancelled = false;
    getSettings().then((settings) => {
      if (!cancelled) {
        setDestinationPath(settings.destinationPath ?? null);
      }
    }).catch(() => {
      if (!cancelled) setDestinationPath(null);
    });
    return () => { cancelled = true; };
  }, []);

  // Pre-warm the drive list so by the time the user reaches the
  // destination Folder Browser (or Add Source picker inside Workspace)
  // the IPC round-trip is already done. Fire-and-forget; the cache
  // lives in electron-bridge and lasts for the lifetime of the
  // renderer.
  useEffect(() => {
    prewarmDrives();
  }, []);

  useEffect(() => {
    return () => {
      if (heroPulseTimer.current) clearTimeout(heroPulseTimer.current);
    };
  }, []);

  // Don't render anything if we're about to skip
  if (skipScreen) {
    return null;
  }

  const hasDestination = !!destinationPath;
  // While settings are still loading, render in the destination-set
  // state (cards unlocked) — this avoids a "flash of locked" for
  // returning users on every launch. First-time users (settings load
  // returns null) see the locked state once settings resolve.
  const stillLoading = destinationPath === undefined;
  const cardsLocked = !stillLoading && !hasDestination;

  const triggerHeroPulse = () => {
    if (heroPulseTimer.current) clearTimeout(heroPulseTimer.current);
    setHeroPulse(true);
    heroPulseTimer.current = setTimeout(() => setHeroPulse(false), 1400);
  };

  const container: Variants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
        delayChildren: 0.2
      }
    }
  };

  const item: Variants = {
    hidden: { opacity: 0, y: 20 },
    show: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.55,
        ease: [0.25, 0.46, 0.45, 0.94]
      }
    }
  };

  // Hero card behaviour pivots on whether a sticky destination exists.
  // No destination → user is funneled to the destination-pick interim
  // (which itself routes back into Workspace's Library Planner → DDA
  // → Folder Browser sequence).
  // Destination set → hero card just lands the user in Workspace.
  const handleHero = () => {
    if (hasDestination) {
      navigate("/workspace");
    } else {
      navigate("/source-selection");
    }
  };

  // Locked secondary handlers — when destination isn't set yet, all
  // these CTAs fall through to a hero-pulse hint instead of routing.
  // This keeps the cards inviting (they're never inert) without
  // letting users blunder into a Workspace where every panel is
  // gated.
  const handleTour = () => {
    if (cardsLocked) { triggerHeroPulse(); return; }
    resetTourCompletion();
    navigate("/workspace?tour=true");
  };
  const handleBestPractices = () => {
    if (cardsLocked) { triggerHeroPulse(); return; }
    navigate("/workspace?panel=best-practices");
  };
  const handleAppCard = (action: () => void) => () => {
    if (cardsLocked) { triggerHeroPulse(); return; }
    action();
  };

  return (
    <>
    {/* Zoom control pill — rendered OUTSIDE the zoom wrapper so the
        controls themselves don't scale with the content. Matches the
        Workspace placement (bottom-right) for consistency. */}
    <ZoomControls
      zoomLevel={zoom.zoomLevel}
      onZoomIn={zoom.zoomIn}
      onZoomOut={zoom.zoomOut}
      onReset={zoom.zoomReset}
      canZoomIn={zoom.canZoomIn}
      canZoomOut={zoom.canZoomOut}
    />
    {/* Outer wrapper scrolls. Inner flex column is `min-h-full` so it
    // still vertically-centres when there's room, but once content
    // exceeds the viewport (narrow / short windows) it grows from the
    // TOP rather than getting centred with the top cropped. py-12
    // guarantees clearance above the logo on the smallest heights so
    // it never appears half-off-screen. */}
    <div className="h-full bg-background relative overflow-auto" style={{ zoom: zoom.zoomLevel / 100 }}>
      {/* Background decoration */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0">
        <div className="absolute top-[-10%] right-[-5%] w-[500px] h-[500px] bg-primary/5 rounded-full blur-3xl" />
        <div className="absolute bottom-[-10%] left-[-5%] w-[400px] h-[400px] bg-secondary/40 rounded-full blur-3xl" />
      </div>

      <div className="min-h-full flex flex-col items-center justify-center px-6 py-8 relative z-10">
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="max-w-[1200px] w-full z-10 flex flex-col items-center text-center"
      >
        <motion.div variants={item} className="mb-8">
          <img src="./assets/pdr-logo_transparent.png" alt="Photo Date Rescue" className="h-20 w-auto mx-auto mb-6" />
          <h1 className="text-[2rem] md:text-[2.6rem] font-semibold text-foreground tracking-tight leading-[1.1] mb-3">
            Welcome to Photo Date Rescue
          </h1>
          <p className="text-[1.05rem] text-muted-foreground max-w-2xl mx-auto font-light">
            A safe, calm place to restore and organise your photo memories.
          </p>
          <p className="text-[0.9rem] text-muted-foreground/70 max-w-2xl mx-auto font-light mt-1.5">
            Runs entirely on your own machine — no cloud, no upload, no account.
          </p>
        </motion.div>

        <motion.div variants={item} className="flex flex-col lg:flex-row items-center justify-center gap-6 w-full mb-8">

          {/* Left Secondary Card — Tour */}
          <SecondaryCard
            icon={<PlayCircle className="w-6 h-6 text-primary" />}
            title="Take a Quick Tour"
            description="See how Photo Date Rescue works in under a minute."
            locked={cardsLocked}
            onClick={handleTour}
          />

          {/* Primary Main Card — flips between destination-pick and
              "continue" depending on whether a Library Drive has been
              chosen yet. */}
          <PrimaryCard
            icon={<HardDrive className="w-10 h-10 text-white" />}
            title={hasDestination ? "Continue in your Workspace" : "Pick a Library Drive"}
            description={hasDestination
              ? "Pick up where you left off — your Library Drive is set and ready."
              : "For a quick fix, or your forever library — choose where your organised photos and videos will live."}
            ctaLabel={hasDestination ? "Open Workspace" : "Get Started"}
            onClick={handleHero}
            pulse={heroPulse}
          />

          {/* Right Secondary Card — Best Practices */}
          <SecondaryCard
            icon={<ShieldCheck className="w-6 h-6 text-primary" />}
            title="Best Practices"
            description="Tips to keep your originals safe and get the best results."
            locked={cardsLocked}
            onClick={handleBestPractices}
          />

        </motion.div>

        {/* Capability showcase — the five apps inside PDR. Quietened
            into a "preview" state when no destination is set, so the
            user sees what's coming without being able to short-circuit
            past the Library Drive step. One ambient line above the
            row carries the locked-state message — saves five
            individual chips shouting from each card. */}
        <motion.div variants={item} className="w-full max-w-[1200px] mb-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="h-px flex-1 bg-border/60" />
            <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground font-medium">
              Everything Photo Date Rescue can do
            </p>
            <div className="h-px flex-1 bg-border/60" />
          </div>
          {cardsLocked && (
            <p className="text-xs text-muted-foreground/80 mb-3 font-light">
              These open once you've set a Library Drive.
            </p>
          )}
          {!cardsLocked && <div className="mb-3" />}
          <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 ${cardsLocked ? 'opacity-60' : ''}`}>
            <ShowcaseCard
              accent="lavender"
              icon={<LayoutDashboard className="w-5 h-5" />}
              title="Workspace"
              description="Copy, rename, structure and deduplicate your source libraries chronologically."
              locked={cardsLocked}
              onClick={handleAppCard(() => navigate("/workspace"))}
            />
            <ShowcaseCard
              accent="blue"
              icon={<Sparkles className="w-5 h-5" />}
              title="Search & Discovery"
              description="Find any photo by metadata, AI object tags or facial recognition — and build parallel structures to match."
              locked={cardsLocked}
              onClick={handleAppCard(() => navigate("/workspace?view=search"))}
            />
            <ShowcaseCard
              accent="amber"
              icon={<CalendarClock className="w-5 h-5" />}
              title="Memories"
              description="Chronologically browse every photo across the libraries you've built."
              locked={cardsLocked}
              onClick={handleAppCard(() => navigate("/workspace?view=memories"))}
            />
            <ShowcaseCard
              accent="emerald"
              icon={<Network className="w-5 h-5" />}
              title="Trees"
              description="See the people from your photos in family-tree form — a face for every name."
              locked={cardsLocked}
              releasedShortly={!isTreesEnabled()}
              onClick={isTreesEnabled() ? handleAppCard(() => navigate("/workspace?view=familytree")) : undefined}
            />
            <ShowcaseCard
              accent="pink"
              icon={<Users className="w-5 h-5" />}
              title="People"
              description="Verify the AI's facial recognition with granular precision — never worry about a misidentified face."
              locked={cardsLocked}
              onClick={handleAppCard(async () => {
                const { openPeopleWindow } = await import('@/lib/electron-bridge');
                await openPeopleWindow();
              })}
            />
          </div>
        </motion.div>

        {/* Go to Workspace Link — quiet escape hatch. Fully disabled
            while no destination is set so users can't bypass the
            Library Drive step from here. We collapse it (h-0,
            invisible) rather than removing it so the rest of the
            page doesn't reflow as the destination loads, and so the
            visual rhythm of the page stays the same once it lights
            up. */}
		<motion.div variants={item} className={`mb-4 -mt-2 ${cardsLocked ? 'pointer-events-none opacity-30' : ''}`}>
		  <button
			onClick={cardsLocked ? undefined : () => navigate("/workspace")}
			disabled={cardsLocked}
			className={`text-sm font-medium flex items-center transition-colors group ${cardsLocked ? 'text-muted-foreground/40 cursor-not-allowed' : 'text-muted-foreground hover:text-primary'}`}
		  >
			Go to Workspace
		  </button>
		</motion.div>


        {/* Bottom row: 3-column grid so the Skip checkbox stays
            optically centred while the Help & Support ? sits at the
            right edge of content (under the People card, on the same
            vertical level as the checkbox). Avoids a viewport-fixed
            position that collides with the zoom pill. */}
        <motion.div variants={item} className="grid w-full max-w-[1200px] grid-cols-3 items-center gap-4">
          <div /> {/* left spacer for symmetry */}
          <div className="flex items-center justify-center space-x-2">
            <Checkbox
              id="skip"
              checked={skipScreen}
              disabled={cardsLocked}
              onCheckedChange={(checked) => {
                if (cardsLocked) return;
                const isChecked = checked === true;
                setSkipScreen(isChecked);
                setSkipWelcomeScreen(isChecked);
              }}
              className="border-muted-foreground/30 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground disabled:opacity-40"
            />
            <label
              htmlFor="skip"
              className={`text-sm font-medium leading-none ${cardsLocked ? 'text-muted-foreground/40 cursor-not-allowed' : 'text-muted-foreground'}`}
            >
              Skip this screen next time
            </label>
          </div>
          <div className="flex justify-end">
            <IconTooltip label="Help & Support" side="left">
              <button
                onClick={() => setShowHelpModal(true)}
                className="flex items-center justify-center w-9 h-9 rounded-full bg-background/90 backdrop-blur-sm border border-border/30 text-muted-foreground hover:text-foreground hover:bg-primary/10 shadow-md hover:shadow-lg hover:-translate-y-0.5 opacity-80 hover:opacity-100 transition-all duration-300 ease-out"
                aria-label="Help & Support"
              >
                <HelpCircle className="w-4 h-4" />
              </button>
            </IconTooltip>
          </div>
        </motion.div>
      </motion.div>
      </div>
    </div>

    {/* Help & Support modal — opened by the floating ? button. Lives
        on Welcome (rather than routing into the Workspace's help-
        support panel) so pre-destination users aren't dragged through
        the Workspace shell and its sidebar. Same accordion content
        either way — different chrome. */}
    {showHelpModal && (
      <HelpSupportModal
        onClose={() => setShowHelpModal(false)}
      />
    )}
    </>
  );
}

function PrimaryCard({ icon, title, description, ctaLabel, onClick, pulse }: { icon: React.ReactNode, title: string, description: string, ctaLabel: string, onClick: () => void, pulse?: boolean }) {
  return (
    <Card
      className={`flex flex-col items-center text-center p-8 cursor-pointer group w-full max-w-[420px] min-h-[260px] justify-center border-primary/20 hover:border-primary shadow-[0_20px_50px_rgba(169,156,255,0.15)] bg-white relative overflow-hidden ${pulse ? 'ring-4 ring-primary/40 ring-offset-2 ring-offset-background' : ''}`}
      style={pulse ? { animation: 'outline-pulse 1.4s ease-in-out 1' } : undefined}
      onClick={onClick}
    >
      {/* Subtle background gradient for primary card */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent to-secondary/30 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

      <div className="flex flex-col items-center relative z-10">
        <div className="mb-5 p-5 rounded-full bg-primary text-white shadow-lg shadow-primary/30 group-hover:scale-110 group-hover:rotate-3 transition-all duration-400 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]">
          {icon}
        </div>
        <h3 className="text-2xl font-semibold text-foreground mb-2">{title}</h3>
        <p className="text-base text-muted-foreground leading-relaxed max-w-[280px] mx-auto">{description}</p>

        <div className="mt-5 opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-400 delay-100">
          <Button className="rounded-full px-8">{ctaLabel} <ArrowRight className="ml-2 w-4 h-4" /></Button>
        </div>
      </div>
    </Card>
  );
}

function SecondaryCard({ icon, title, description, onClick, locked }: { icon: React.ReactNode, title: string, description: string, onClick: () => void, locked?: boolean }) {
  return (
    <Card
      className={`flex flex-col items-center text-center p-6 group w-full max-w-[300px] min-h-[200px] justify-center transition-colors ${locked ? 'bg-white/40 cursor-default opacity-60' : 'bg-white/60 hover:bg-white cursor-pointer'}`}
      onClick={onClick}
    >
      <div className="flex flex-col items-center">
        <div className={`mb-3 p-3 rounded-full bg-secondary text-primary transition-transform duration-400 ${locked ? '' : 'group-hover:scale-105'}`}>
          {icon}
        </div>
        <h3 className="text-lg font-medium text-foreground mb-2">{title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
      </div>
    </Card>
  );
}

/**
 * Quiet, non-interactive showcase tile for the "Everything PDR can
 * do" row. Advertises a feature without pretending to be a launcher
 * — the user is still funneled through the main CTA above. Cursor
 * stays default; no click handler. A subtle hover lift + tinted
 * border only, so returning users can linger without feeling like
 * they're missing an action.
 */
// Per-app accent palette. Each Welcome card carries the colour
// associated with its app — same colour the sidebar item for that app
// uses, so the user builds a visual association across the app.
// Values picked from Tailwind v3 defaults (see
// feedback_tailwind_v4_pale_palette: v4's oklch tokens read too pale
// on the light background, so we use explicit hex throughout).
type AppAccent = 'lavender' | 'blue' | 'amber' | 'emerald' | 'pink';
const APP_ACCENT: Record<AppAccent, { iconBg: string; iconFg: string; topBar: string; hoverBorder: string }> = {
  lavender: { iconBg: '#ede9fe', iconFg: '#6d28d9', topBar: '#a99cff', hoverBorder: '#8b5cf6' },
  blue:     { iconBg: '#dbeafe', iconFg: '#1e40af', topBar: '#3b82f6', hoverBorder: '#2563eb' },
  amber:    { iconBg: '#fef3c7', iconFg: '#78350f', topBar: '#f8c15c', hoverBorder: '#eab14c' },
  emerald:  { iconBg: '#d1fae5', iconFg: '#065f46', topBar: '#10b981', hoverBorder: '#059669' },
  // Pink, not rose — rose-500 (#f43f5e) was reading red on the bright
  // top bar. Swapped to Tailwind v3 pink-500 (#ec4899) so it's
  // unambiguously pink.
  pink:     { iconBg: '#fce7f3', iconFg: '#831843', topBar: '#ec4899', hoverBorder: '#db2777' },
};

function ShowcaseCard({ accent, icon, title, description, onClick, locked, releasedShortly }: { accent: AppAccent; icon: React.ReactNode, title: string, description: string, onClick?: () => void, locked?: boolean, releasedShortly?: boolean }) {
  const a = APP_ACCENT[accent];
  // Clickable when an onClick is provided AND the feature isn't
  // release-gated. `locked` (no destination) and `releasedShortly`
  // (Trees / Edit Dates held back from v2.0.0) both suppress hover
  // affordances and the "Open →" hint, but they communicate slightly
  // different states: `locked` = "set up the Library Drive first",
  // `releasedShortly` = "this feature ships in a future release".
  // The latter wins visually because it represents a fundamental
  // unavailability, not a user-correctable state.
  const interactive = !!onClick && !locked && !releasedShortly;
  return (
    <Card
      className={`flex flex-col p-4 h-full bg-white/40 transition-colors relative overflow-hidden text-left ${interactive ? 'cursor-pointer group hover:bg-white/70 hover:shadow-md' : 'cursor-default'}`}
      style={{ borderColor: '#e5e7eb', borderTopWidth: '3px', borderTopColor: a.topBar, borderTopStyle: 'solid' }}
      onClick={interactive ? onClick : undefined}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick!(); } } : undefined}
      aria-label={releasedShortly ? `${title} — released shortly` : undefined}
    >
      {/* Icon + title row.
          • items-start so the icon stays anchored to the FIRST line of
            the title when the title wraps (Search & Discovery), instead
            of vertically-centering between two wrapped lines and
            visually drifting downward.
          • min-h on the title block keeps the description's vertical
            position consistent across all five cards regardless of
            whether the title is one or two lines. */}
      <div className="flex items-start gap-2.5 mb-2 min-h-[3.5rem]">
        <div className="p-1.5 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: a.iconBg, color: a.iconFg }}>
          {icon}
        </div>
        <div className="flex flex-col gap-1 min-w-0">
          <h4 className="text-sm font-semibold text-foreground text-left leading-tight pt-0.5">{title}</h4>
          {releasedShortly && (
            <span className="inline-flex self-start text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-1 ring-amber-500/30">
              Released shortly
            </span>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed text-left">{description}</p>
      {interactive && (
        <span className="mt-auto pt-2 text-[10px] uppercase tracking-wider font-semibold opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: a.topBar }}>
          Open →
        </span>
      )}
    </Card>
  );
}
