import { useState } from "react";
import { useLocation } from "wouter";
import { motion, Variants } from "framer-motion";
import { FolderPlus, ArrowRight, Info } from "lucide-react";
import { Card } from "@/components/ui/custom-card";
import { openZipDialog, isElectron } from "@/lib/electron-bridge";
import { useLicense } from "@/contexts/LicenseContext";
import { LicenseRequiredModal } from "@/components/LicenseRequiredModal";
import { LicenseModal } from "@/components/LicenseModal";
import { FolderBrowserModal } from "@/components/FolderBrowserModal";

export default function SourceSelection() {
  const [, setLocation] = useLocation();
  const { isLicensed, isLoading } = useLicense();
  const [showLicenseRequired, setShowLicenseRequired] = useState(false);
  const [showLicenseModal, setShowLicenseModal] = useState(false);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [pendingPath, setPendingPath] = useState<{ path: string; type: 'folder' | 'drive' | 'zip'; name: string } | null>(null);

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

  const inferSourceType = (path: string): 'folder' | 'drive' => {
    const isDriveRoot = /^[A-Z]:[\\/]?$/.test(path);
    return isDriveRoot ? 'drive' : 'folder';
  };

  const proceedToWorkspace = (path: string, type: 'folder' | 'drive' | 'zip', name: string) => {
    // Store pending source in sessionStorage for workspace to pick up
    sessionStorage.setItem('pdr-pending-source', JSON.stringify({ path, type, name }));
    setLocation('/workspace');
  };

  const handleAddSource = () => {
    if (!isElectron()) {
      console.log('Not in Electron environment');
      return;
    }
    setShowFolderBrowser(true);
  };

  const handleUnifiedSourceSelect = (selectedPath: string) => {
    setShowFolderBrowser(false);
    const ext = selectedPath.toLowerCase().split('.').pop() || '';
    const isArchive = ext === 'zip' || ext === 'rar';

    if (isArchive) {
      const fileName = selectedPath.split(/[/\\]/).pop() || "Selected Archive";
      if (!isLicensed) {
        setPendingPath({ path: selectedPath, type: 'zip', name: fileName });
        setShowLicenseRequired(true);
        return;
      }
      proceedToWorkspace(selectedPath, 'zip', fileName);
    } else {
      const folderName = selectedPath.split(/[/\\]/).pop() || "Selected Folder";
      const sourceType = inferSourceType(selectedPath);
      if (!isLicensed) {
        setPendingPath({ path: selectedPath, type: sourceType, name: folderName });
        setShowLicenseRequired(true);
        return;
      }
      proceedToWorkspace(selectedPath, sourceType, folderName);
    }
  };

  const handleActivateLicense = () => {
    setShowLicenseRequired(false);
    setShowLicenseModal(true);
  };

  const handleLicenseModalClose = () => {
    setShowLicenseModal(false);
    // If license was activated and we have a pending path, proceed
    if (isLicensed && pendingPath) {
      proceedToWorkspace(pendingPath.path, pendingPath.type, pendingPath.name);
      setPendingPath(null);
    }
  };

  return (
    <div className="h-full bg-background flex flex-col items-center justify-center p-6 relative overflow-auto">
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
            Find Your Photos & Videos
          </h1>
          <p className="text-base text-muted-foreground max-w-2xl mx-auto font-light inline-flex items-center justify-center gap-1 flex-wrap">
            Choose where your photos and videos are located. You can add more sources later.
            <PerformanceNudge type="source" />
          </p>
        </motion.div>

        <motion.div variants={item} className="w-full max-w-md">
          <OptionCard
            icon={<FolderPlus className="w-8 h-8 text-primary" />}
            title="Add Source"
            description="Select a folder, drive, or ZIP/RAR archive containing your photos and videos."
            onClick={handleAddSource}
          />
        </motion.div>

        <motion.div variants={item} className="mt-10">
          <button
            onClick={() => setLocation('/workspace')}
            className="px-8 py-2.5 rounded-lg border border-border bg-background/50 hover:bg-secondary/30 text-foreground font-medium text-sm transition-all duration-300 hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:ring-offset-2 focus:ring-offset-background"
          >
            Go to Workspace
          </button>
        </motion.div>
      </motion.div>

      {/* Unified Source Browser */}
      <FolderBrowserModal
        isOpen={showFolderBrowser}
        onSelect={handleUnifiedSourceSelect}
        onCancel={() => setShowFolderBrowser(false)}
        title="Add Source"
        mode="source"
      />

      {/* License Required Modal */}
      <LicenseRequiredModal
        isOpen={showLicenseRequired}
        onClose={() => {
          setShowLicenseRequired(false);
          setPendingPath(null);
        }}
        onActivate={handleActivateLicense}
        feature="add sources"
      />

      {/* License Activation Modal */}
      {showLicenseModal && (
        <LicenseModal onClose={handleLicenseModalClose} />
      )}
    </div>
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