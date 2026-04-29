import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion, Variants } from "framer-motion";
import { Search, PlayCircle, ShieldCheck, ArrowRight, Check, LayoutDashboard, Sparkles, CalendarClock, Network, Users } from "lucide-react";
import { Button } from "@/components/ui/custom-button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/custom-card";
import { resetTourCompletion } from "@/components/ui/tour-overlay";
import { useZoomLevel } from "@/hooks/useZoomLevel";
import { ZoomControls } from "@/components/ZoomControls";

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
  // Shared zoom with Workspace — same pdr-zoom-level localStorage
  // key, so a zoom choice made on Workspace persists to Welcome too
  // and vice versa. Applied as CSS `zoom` on the content wrapper so
  // the whole screen scales together. Ctrl+wheel is window-scoped
  // via the hook's internal listener.
  const zoom = useZoomLevel();

  useEffect(() => {
    if (skipScreen) {
      navigate("/workspace", { replace: true });
    }
  }, [skipScreen, navigate]);

  // Don't render anything if we're about to skip
  if (skipScreen) {
    return null;
  }

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

    const handleStart = () => {
    navigate("/source-selection");
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
          
          {/* Left Secondary Card */}
          <SecondaryCard 
            icon={<PlayCircle className="w-6 h-6 text-primary" />}
            title="Take a Quick Tour"
            description="See how Photo Date Rescue works in under a minute."
            onClick={() => { resetTourCompletion(); navigate("/workspace?tour=true"); }}
          />

          {/* Primary Main Card */}
          <PrimaryCard
            icon={<Search className="w-10 h-10 text-white" />}
            title="Find Your Photos & Videos"
            description="Add folders, drives, ZIP / RAR archives, or Google Takeout / Apple Photos exports to get started."
            onClick={handleStart}
          />

          {/* Right Secondary Card */}
          <SecondaryCard 
            icon={<ShieldCheck className="w-6 h-6 text-primary" />}
            title="Best Practices"
            description="Tips to keep your originals safe and get the best results."
            onClick={() => navigate("/workspace?panel=best-practices")}
          />

        </motion.div>

        {/* Capability showcase — the five apps inside PDR. Non-
            interactive reassurance for first-time users ("this isn't
            just a renaming tool") and re-discovery for returning
            users. Deliberately quiet styling so it doesn't compete
            with the hero CTAs above. */}
        <motion.div variants={item} className="w-full max-w-[1200px] mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-px flex-1 bg-border/60" />
            <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground font-medium">
              Everything Photo Date Rescue can do
            </p>
            <div className="h-px flex-1 bg-border/60" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <ShowcaseCard
              accent="lavender"
              icon={<LayoutDashboard className="w-5 h-5" />}
              title="Workspace"
              description="Copy, rename, structure and deduplicate your source libraries chronologically."
              onClick={() => navigate("/workspace")}
            />
            <ShowcaseCard
              accent="blue"
              icon={<Sparkles className="w-5 h-5" />}
              title="Search & Discovery"
              description="Find any photo by metadata, AI object tags or facial recognition — and build parallel structures to match."
              onClick={() => navigate("/workspace?view=search")}
            />
            <ShowcaseCard
              accent="amber"
              icon={<CalendarClock className="w-5 h-5" />}
              title="Memories"
              description="Chronologically browse every photo across the libraries you've built."
              onClick={() => navigate("/workspace?view=memories")}
            />
            <ShowcaseCard
              accent="emerald"
              icon={<Network className="w-5 h-5" />}
              title="Trees"
              description="See the people from your photos in family-tree form — a face for every name."
              onClick={() => navigate("/workspace?view=familytree")}
            />
            <ShowcaseCard
              accent="pink"
              icon={<Users className="w-5 h-5" />}
              title="People"
              description="Verify the AI's facial recognition with granular precision — never worry about a misidentified face."
              onClick={async () => {
                const { openPeopleWindow } = await import('@/lib/electron-bridge');
                await openPeopleWindow();
              }}
            />
          </div>
        </motion.div>

        {/* Go to Workspace Link */}
		<motion.div variants={item} className="mb-4 -mt-2">
		  <button
			onClick={() => navigate("/workspace")}
			className="text-muted-foreground/80 hover:text-primary text-sm font-medium flex items-center transition-colors group"
		  >
			Go to Workspace
		  </button>
		</motion.div>


        <motion.div variants={item} className="flex flex-col items-center gap-6">
          <div className="flex items-center space-x-2">
            <Checkbox 
              id="skip" 
              checked={skipScreen}
              onCheckedChange={(checked) => {
                const isChecked = checked === true;
                setSkipScreen(isChecked);
                setSkipWelcomeScreen(isChecked);
              }}
              className="border-muted-foreground/30 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
            />
            <label
              htmlFor="skip"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-muted-foreground"
            >
              Skip this screen next time
            </label>
          </div>
        </motion.div>
      </motion.div>
      </div>
    </div>
    </>
  );
}

function PrimaryCard({ icon, title, description, onClick }: { icon: React.ReactNode, title: string, description: string, onClick: () => void }) {
  return (
    <Card 
      className="flex flex-col items-center text-center p-8 cursor-pointer group w-full max-w-[420px] min-h-[260px] justify-center border-primary/20 hover:border-primary shadow-[0_20px_50px_rgba(169,156,255,0.15)] bg-white relative overflow-hidden"
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
          <Button className="rounded-full px-8">Get Started <ArrowRight className="ml-2 w-4 h-4" /></Button>
        </div>
      </div>
    </Card>
  );
}

function SecondaryCard({ icon, title, description, onClick }: { icon: React.ReactNode, title: string, description: string, onClick: () => void }) {
  return (
    <Card
      className="flex flex-col items-center text-center p-6 cursor-pointer group w-full max-w-[300px] min-h-[200px] justify-center bg-white/60 hover:bg-white transition-colors"
      onClick={onClick}
    >
      <div className="flex flex-col items-center">
        <div className="mb-3 p-3 rounded-full bg-secondary text-primary group-hover:scale-105 transition-transform duration-400">
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
  amber:    { iconBg: '#fde68a', iconFg: '#78350f', topBar: '#f59e0b', hoverBorder: '#d97706' },
  emerald:  { iconBg: '#d1fae5', iconFg: '#065f46', topBar: '#10b981', hoverBorder: '#059669' },
  // Pink, not rose — rose-500 (#f43f5e) was reading red on the bright
  // top bar. Swapped to Tailwind v3 pink-500 (#ec4899) so it's
  // unambiguously pink.
  pink:     { iconBg: '#fce7f3', iconFg: '#831843', topBar: '#ec4899', hoverBorder: '#db2777' },
};

function ShowcaseCard({ accent, icon, title, description, onClick }: { accent: AppAccent; icon: React.ReactNode, title: string, description: string, onClick?: () => void }) {
  const a = APP_ACCENT[accent];
  // Clickable when an onClick is provided. Subtler than the top-row
  // CTAs (no big icon-circle treatment) so the Welcome page doesn't
  // gain a third tier of dominant CTAs — just a quiet "Open →" hint
  // on hover that satisfies the click expectation when users go for
  // these cards directly.
  return (
    <Card
      className={`flex flex-col p-4 h-full bg-white/40 transition-colors relative overflow-hidden text-left ${onClick ? 'cursor-pointer group hover:bg-white/70 hover:shadow-md' : ''}`}
      style={{ borderColor: '#e5e7eb', borderTopWidth: '3px', borderTopColor: a.topBar, borderTopStyle: 'solid' }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
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
        <h4 className="text-sm font-semibold text-foreground text-left leading-tight pt-0.5">{title}</h4>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed text-left">{description}</p>
      {onClick && (
        <span className="mt-auto pt-2 text-[10px] uppercase tracking-wider font-semibold opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: a.topBar }}>
          Open →
        </span>
      )}
    </Card>
  );
}
