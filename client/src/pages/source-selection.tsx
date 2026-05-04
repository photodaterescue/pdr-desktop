import { useState } from "react";
import { useLocation } from "wouter";
import { motion, Variants } from "framer-motion";
import { HardDrive, ArrowRight, Info } from "lucide-react";
import { Card } from "@/components/ui/custom-card";
import { isElectron } from "@/lib/electron-bridge";
import { useZoomLevel } from "@/hooks/useZoomLevel";
import { ZoomControls } from "@/components/ZoomControls";

/**
 * Destination-first interim screen.
 *
 * v2.0.0 flips PDR's onboarding so the very first thing a user picks
 * is their Library Drive (the destination), not a source. The
 * rationale is two-fold:
 *   1. Knowing the destination up-front lets PDR target the
 *      pre-extract path at a drive with enough headroom, instead of
 *      defaulting to %TEMP% and risking a 50 GB Takeout filling C:.
 *   2. It mirrors how the user thinks about the job: "I want to
 *      build a library on this drive — what I feed in is just an
 *      ingredient."
 *
 * This screen is intentionally thin — clicking the card simply routes
 * to /workspace?action=pick-destination, which triggers Workspace's
 * existing Library Planner → DDA → Folder Browser sequence. We don't
 * duplicate that flow here.
 */
export default function SourceSelection() {
  const [, setLocation] = useLocation();
  // Per-surface zoom — separate key so this transient screen can't
  // bleed its zoom level into the Workspace / Welcome surfaces.
  const zoom = useZoomLevel('pdr-source-selection-zoom');

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

  const handlePickDestination = () => {
    if (!isElectron()) {
      console.log('Not in Electron environment');
      return;
    }
    // wouter's useHashLocation strips query params, so we can't pass
    // ?action=pick-destination through setLocation. Use sessionStorage
    // for the handoff instead — same pattern as pdr-pending-source.
    sessionStorage.setItem('pdr-pending-action', 'pick-destination');
    setLocation('/workspace');
  };

  return (
    <>
    <ZoomControls
      zoomLevel={zoom.zoomLevel}
      onZoomIn={zoom.zoomIn}
      onZoomOut={zoom.zoomOut}
      onReset={zoom.zoomReset}
      canZoomIn={zoom.canZoomIn}
      canZoomOut={zoom.canZoomOut}
    />
    <div className="h-full bg-background flex flex-col items-center justify-center p-6 relative overflow-auto" style={{ zoom: zoom.zoomLevel / 100 }}>
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0">
        <div className="absolute top-[-10%] right-[-5%] w-[500px] h-[500px] bg-primary/5 rounded-full blur-3xl" />
        <div className="absolute bottom-[-10%] left-[-5%] w-[400px] h-[400px] bg-secondary/40 rounded-full blur-3xl" />
      </div>

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="max-w-[1120px] w-full z-10 flex flex-col items-center text-center"
      >
        <motion.div variants={item} className="mb-8">
          <img src="./assets/pdr-logo_transparent.png" alt="Photo Date Rescue" className="h-16 w-auto mx-auto mb-6" />
          <h1 className="text-2xl md:text-3xl font-semibold text-foreground tracking-tight leading-[1.1] mb-3">
            Pick a Library Drive
          </h1>
          <p className="text-base text-muted-foreground max-w-2xl mx-auto font-light inline-flex items-center justify-center gap-1 flex-wrap">
            For a quick fix, or your forever library — choose where your organised photos and videos will live.
            <PerformanceNudge type="destination" />
          </p>
        </motion.div>

        <motion.div variants={item} className="w-full max-w-md">
          <OptionCard
            icon={<HardDrive className="w-8 h-8 text-primary" />}
            title="Pick Library Drive"
            description="Select an internal disk, external drive, or network folder. PDR will use it for analysis staging and as the home for your fixed library."
            onClick={handlePickDestination}
          />
        </motion.div>

        {/* Escape hatch removed deliberately. The interim only renders
            for users without a sticky destination — there's no
            legitimate reason to skip past it, and letting them do so
            puts them in a Workspace whose chrome is gated on a
            Library Drive being set. Returning users skip this screen
            entirely via the Welcome hero (which routes straight to
            /workspace when destinationPath is set). */}
      </motion.div>
    </div>
    </>
  );
}

function OptionCard({ icon, title, description, onClick }: { icon: React.ReactNode, title: string, description: string, onClick: () => void }) {
  return (
    <Card
      className="flex flex-col items-center text-center p-8 cursor-pointer group h-full justify-between hover:border-primary transition-colors min-h-[280px]"
      onClick={onClick}
    >
      <div className="flex flex-col items-center pt-2">
        <div className="mb-5 p-4 rounded-full bg-secondary text-primary group-hover:scale-110 transition-transform duration-400 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]">
          {icon}
        </div>
        <h3 className="text-lg font-medium text-foreground mb-2">{title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
      </div>
      <div className="mt-4 opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-300">
         <ArrowRight className="w-5 h-5 text-primary" />
      </div>
    </Card>
  );
}

function PerformanceNudge({ type }: { type: 'source' | 'destination' }) {
  const [isVisible, setIsVisible] = useState(false);

  const message = type === 'source'
    ? <>For best performance, connect source drives directly via USB, USB-C, or Ethernet.<br /><br />Wi-Fi and personal cloud storage can be slow or unstable when reading large volumes of files.</>
    : <>For best performance, connect your destination directly.<br /><br />Copying large volumes over Wi-Fi can bottleneck performance — this is a hardware/network limitation, not a PDR issue.</>;

  return (
    <div className="relative inline-flex items-center ml-1">
      <button
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
        onClick={(e) => { e.stopPropagation(); setIsVisible(!isVisible); }}
        className="p-0.5 text-[#9b8bb8] hover:text-[#7b6b98] transition-colors"
        aria-label="Performance tip"
        type="button"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {isVisible && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 p-3 bg-background border border-[#9b8bb8]/30 rounded-lg shadow-lg text-xs text-muted-foreground z-[60] pointer-events-none">
          <div className="font-medium text-foreground mb-1 text-xs">Performance Tip</div>
          {message}
        </div>
      )}
    </div>
  );
}
