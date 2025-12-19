import { useState, useEffect, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import { 
  Folder, 
  FileArchive, 
  HardDrive, 
  Settings, 
  HelpCircle, 
  AlertCircle, 
  CheckCircle2, 
  AlertTriangle,
  ChevronRight,
  Plus,
  Play,
  Trash2,
  RefreshCw,
  FileImage,
  FileVideo,
  CalendarRange,
  FolderOpen,
  Eye,
  X,
  LayoutGrid,
  ArrowRight,
  Loader2,
  Info,
  Sparkles,
  Tag,
  ShieldCheck,
  Wrench,
  Sun,
  Moon,
  FileText
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/custom-button";
import { Card } from "@/components/ui/custom-card";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { motion } from "framer-motion";
import { 
  isElectron, 
  openFolderDialog, 
  openZipDialog, 
  runAnalysis, 
  onAnalysisProgress, 
  removeAnalysisProgressListener,
  formatBytesToGB 
} from "@/lib/electron-bridge";
import { LicenseModal, LicenseStatusBadge } from "@/components/LicenseModal";
import type { SourceAnalysisResult } from "../electron";

interface Source {
  id: string;
  icon: React.ReactNode;
  label: string;
  type: 'folder' | 'zip' | 'drive';
  path?: string;
  active: boolean;
  selected: boolean;
  confirmed: boolean;
  stats?: PreScanStats;
}

interface AnalysisProgress {
  current: number;
  total: number;
  currentFile: string;
}

interface AnalysisResults {
  fixed: number;
  unchanged: number;
  skipped: number;
}

interface PreScanStats {
  totalFiles: number;
  photoCount: number;
  videoCount: number;
  estimatedSizeGB: number;
  dateRange: {
    earliest: string;
    latest: string;
  };
}

export default function Workspace() {
  const [location, setLocation] = useLocation();
  const searchString = useSearch();
  const folderOrDriveInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const [showSourceTypeSelector, setShowSourceTypeSelector] = useState(false);
  
  const [sources, setSources] = useState<Source[]>(() => {
    const saved = sessionStorage.getItem("pdr-sources");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return parsed.map((s: any) => ({
          ...s,
          active: false,
          icon: s.type === 'zip' ? <FileArchive className="w-4 h-4" /> : s.type === 'drive' ? <HardDrive className="w-4 h-4" /> : <Folder className="w-4 h-4" />
        }));
      } catch (e) {
        console.error("Failed to parse sources", e);
      }
    }
    return [
    {
      id: "mock-1",
      icon: <Folder className="w-4 h-4" />,
      label: "My Vacation Photos",
      type: "folder",
      path: "/Users/username/Pictures/My Vacation Photos",
      active: false,
      selected: false,
      confirmed: true,
      stats: {
        totalFiles: 1248,
        photoCount: 892,
        videoCount: 356,
        estimatedSizeGB: 4.2,
        dateRange: { earliest: "Jan 12, 2023", latest: "Aug 15, 2023" }
      }
    },
    {
      id: "mock-2",
      icon: <FileArchive className="w-4 h-4" />,
      label: "Old Backup 2018.zip",
      type: "zip",
      path: "/Users/username/Downloads/Old Backup 2018.zip",
      active: false,
      selected: false,
      confirmed: true,
      stats: {
        totalFiles: 562,
        photoCount: 500,
        videoCount: 62,
        estimatedSizeGB: 1.8,
        dateRange: { earliest: "Mar 01, 2018", latest: "Dec 31, 2018" }
      }
    },
    {
      id: "mock-3",
      icon: <Folder className="w-4 h-4" />,
      label: "Camera Uploads",
      type: "folder",
      path: "/Users/username/Pictures/Camera Uploads",
      active: false,
      selected: false,
      confirmed: true,
      stats: {
        totalFiles: 2105,
        photoCount: 2000,
        videoCount: 105,
        estimatedSizeGB: 8.5,
        dateRange: { earliest: "Jun 10, 2020", latest: "Nov 22, 2024" }
      }
    }
  ]});

  useEffect(() => {
    // Create a version of sources that is safe for JSON stringify (remove React components)
    const serializableSources = sources.map(s => {
      const { icon, ...rest } = s;
      return rest;
    });
    sessionStorage.setItem("pdr-sources", JSON.stringify(serializableSources));
  }, [sources]);

  const [activeSource, setActiveSource] = useState<Source | null>(null);
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [showCompletionScreen, setShowCompletionScreen] = useState(false);
  const [analysisResults, setAnalysisResults] = useState<AnalysisResults>({ fixed: 0, unchanged: 0, skipped: 0 });
  const [activePanel, setActivePanel] = useState<'getting-started' | 'best-practices' | 'what-next' | null>(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [showResultsModal, setShowResultsModal] = useState(false);
  const [showPreScanConfirm, setShowPreScanConfirm] = useState(false);
  const [preScanStats, setPreScanStats] = useState<PreScanStats | null>(null);
  const [pendingSource, setPendingSource] = useState<Source | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress>({ current: 0, total: 0, currentFile: '' });
  const [sourceAnalysisResults, setSourceAnalysisResults] = useState<Record<string, SourceAnalysisResult>>({});
  const [showLicenseModal, setShowLicenseModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return document.documentElement.classList.contains('dark');
    }
    return false;
  });
  const [folderStructure, setFolderStructure] = useState<'year' | 'year-month' | 'year-month-day'>(() => {
    const saved = localStorage.getItem('pdr-folder-structure');
    return (saved as 'year' | 'year-month' | 'year-month-day') || 'year';
  });

  const toggleDarkMode = () => {
    const newValue = !isDarkMode;
    setIsDarkMode(newValue);
    if (newValue) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('pdr-dark-mode', newValue ? 'true' : 'false');
  };

  useEffect(() => {
    const savedDarkMode = localStorage.getItem('pdr-dark-mode');
    if (savedDarkMode === 'true') {
      document.documentElement.classList.add('dark');
      setIsDarkMode(true);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(searchString);
    const type = params.get("type") as 'folder' | 'zip' | 'drive';
    const name = params.get("name");
    const path = params.get("path");

    if (type && name) {
      const exists = sources.some(s => s.label === name);
      if (!exists) {
        let icon = <Folder className="w-4 h-4" />;
        if (type === 'zip') icon = <FileArchive className="w-4 h-4" />;
        if (type === 'drive') icon = <HardDrive className="w-4 h-4" />;

        const newSource: Source = {
          id: Date.now().toString(),
          icon: type === 'drive' ? <img src="/Assets/pdr-drive.png" className="w-4 h-4 object-contain" alt="Drive" /> : icon,
          label: name,
          type,
          path: path || undefined,
          active: true,
          selected: true,
          confirmed: false
        };

        const updatedSources = sources.map(s => ({ ...s, active: false }));
        setSources([...updatedSources, newSource]);
        setActiveSource(newSource);
        setPendingSource(newSource);
        
        // Generate fresh pre-scan stats live
        const stats = generatePreScanStats();
        setPreScanStats(stats);
        setShowPreScanConfirm(true);
        
        // Clear URL params to prevent re-triggering modal on refresh
        setLocation(location);
      }
    }
  }, [searchString, sources, location, setLocation]);

  // Auto-analyze when sources change
  useEffect(() => {
    const selectedSources = sources.filter(s => s.selected);
    
    if (selectedSources.length > 0) {
      let confirmed = 0;
      let recovered = 0;
      let marked = 0;
      
      for (const source of selectedSources) {
        const realResult = sourceAnalysisResults[source.id];
        if (realResult) {
          confirmed += realResult.confidenceSummary.confirmed;
          recovered += realResult.confidenceSummary.recovered;
          marked += realResult.confidenceSummary.marked;
        } else if (source.stats) {
          const total = source.stats.totalFiles;
          confirmed += Math.floor(total * 0.65);
          recovered += Math.floor(total * 0.28);
          marked += Math.floor(total * 0.07);
        }
      }
      
      setAnalysisResults({
         fixed: confirmed + recovered,
         unchanged: marked,
         skipped: 0
      });
      setIsComplete(true);
    } else {
      setIsComplete(false);
      setAnalysisResults({ fixed: 0, unchanged: 0, skipped: 0 });
    }
  }, [sources, sourceAnalysisResults]);

  const handleSourceClick = (id: string, shiftKey: boolean = false) => {
    let updatedSources = [...sources];
    
    if (shiftKey && lastSelectedId) {
      const lastIndex = sources.findIndex(s => s.id === lastSelectedId);
      const currentIndex = sources.findIndex(s => s.id === id);
      
      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        
        // Determine target state based on the clicked item's new state (inverse of current)
        // actually, standard behavior is to set all in range to the state of the *last* clicked item?
        // Usually shift-click selects the range. If the item was unselected, it selects it and the range.
        // Let's assume we want to select the range.
        
        // Wait, standard file system behavior:
        // Click A (selected)
        // Shift+Click C -> Selects A, B, C.
        
        // If A is unselected:
        // Click A (selected)
        // Shift+Click C -> Selects A, B, C.
        
        // So we should force select the range.
        updatedSources = sources.map((s, index) => {
          if (index >= start && index <= end) {
            return { ...s, selected: true };
          }
          return s;
        });
      }
    } else {
      // Toggle selection normally
      updatedSources = sources.map(s => s.id === id ? { ...s, selected: !s.selected } : s);
    }

    setSources(updatedSources);
    setLastSelectedId(id);
    // Also set as active for detail view if needed, but for now just toggle selection
    setActiveSource(updatedSources.find(s => s.id === id) || null);
  };

  const handleSelectAll = (checked: boolean) => {
    const updatedSources = sources.map(s => ({ ...s, selected: checked }));
    setSources(updatedSources);
  };

  const handleConfirmSource = () => {
    if (!activeSource) return;
    const updatedSources = sources.map(s => s.id === activeSource.id ? { ...s, confirmed: true } : s);
    setSources(updatedSources);
    setActiveSource({ ...activeSource, confirmed: true });
  };

  const handleRemoveSource = () => {
    if (!activeSource) return;
    const updatedSources = sources.filter(s => s.id !== activeSource.id);
    setSources(updatedSources);
    setIsComplete(false); // Reset analysis on source change
    if (updatedSources.length > 0) {
      updatedSources[0].active = true;
      setActiveSource(updatedSources[0]);
    } else {
      setActiveSource(null);
      // Stay on dashboard and show empty state
    }
  };

  const handleChangeSource = () => {
    if (!activeSource) return;
    // Remove current unconfirmed source
    const updatedSources = sources.filter(s => s.id !== activeSource.id);
    setSources(updatedSources);
    setActiveSource(null);
    setIsComplete(false); // Reset analysis on source change
    // Show source type selector to pick a new source
    setShowSourceTypeSelector(true);
  };


  const handleAddSource = () => {
    setShowSourceTypeSelector(true);
  };

  const handleSelectSourceType = async (type: 'folderOrDrive' | 'zip') => {
    setShowSourceTypeSelector(false);
    
    if (isElectron()) {
      let selectedPath: string | null = null;
      
      if (type === 'folderOrDrive') {
        selectedPath = await openFolderDialog();
      } else if (type === 'zip') {
        selectedPath = await openZipDialog();
      }
      
      if (selectedPath) {
        await handleElectronSourceSelected(selectedPath, type === 'zip' ? 'zip' : 'folder');
      }
    } else {
      setTimeout(() => {
        if (type === 'folderOrDrive') {
          folderOrDriveInputRef.current?.click();
        } else if (type === 'zip') {
          zipInputRef.current?.click();
        }
      }, 0);
    }
  };
  
  const handleElectronSourceSelected = async (sourcePath: string, sourceType: 'folder' | 'zip' | 'drive') => {
    const pathParts = sourcePath.split(/[/\\]/);
    const name = pathParts[pathParts.length - 1] || "Selected Source";
    const inferredType = inferSourceType(sourcePath);
    const finalType = sourceType === 'zip' ? 'zip' : inferredType;
    
    const icon = finalType === 'zip' 
      ? <FileArchive className="w-4 h-4" /> 
      : finalType === 'drive' 
        ? <HardDrive className="w-4 h-4" /> 
        : <Folder className="w-4 h-4" />;
    
    setIsAnalyzing(true);
    setAnalysisProgress({ current: 0, total: 0, currentFile: 'Starting analysis...' });
    
    onAnalysisProgress((progress) => {
      setAnalysisProgress({
        current: progress.current,
        total: progress.total,
        currentFile: progress.currentFile
      });
    });
    
    const result = await runAnalysis(sourcePath, finalType);
    
    removeAnalysisProgressListener();
    setIsAnalyzing(false);
    
    if (result.success && result.data) {
      const analysisData = result.data;
      const stats: PreScanStats = {
        totalFiles: analysisData.totalFiles,
        photoCount: analysisData.photoCount,
        videoCount: analysisData.videoCount,
        estimatedSizeGB: formatBytesToGB(analysisData.totalSizeBytes),
        dateRange: {
          earliest: analysisData.dateRange.earliest 
            ? new Date(analysisData.dateRange.earliest).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
            : 'Unknown',
          latest: analysisData.dateRange.latest
            ? new Date(analysisData.dateRange.latest).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
            : 'Unknown'
        }
      };
      
      const newSource: Source = {
        id: Date.now().toString(),
        icon,
        label: name,
        type: finalType,
        path: sourcePath,
        active: true,
        selected: true,
        confirmed: false,
        stats
      };
      
      setSourceAnalysisResults(prev => ({ ...prev, [newSource.id]: analysisData }));
      
      const updatedSources = sources.map(s => ({ ...s, active: false }));
      setSources([...updatedSources, newSource]);
      setActiveSource(newSource);
      setPendingSource(newSource);
      setPreScanStats(stats);
      setShowPreScanConfirm(true);
      
      toast.success(`Analyzed ${analysisData.totalFiles.toLocaleString()} files`);
    } else {
      toast.error(result.error || 'Failed to analyze source');
    }
  };

  const inferSourceType = (path: string): 'folder' | 'drive' => {
    // Infer if path is a drive root or a folder
    const isDriveRoot = /^[A-Z]:\/$/.test(path) || path === 'D:/' || path === 'C:/' || path === 'D:\\' || path === 'C:\\';
    return isDriveRoot ? 'drive' : 'folder';
  };

  const handleFolderOrDriveChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const path = e.target.files[0].webkitRelativePath || e.target.files[0].name;
      const name = path.split('/')[0] || "Selected Folder";
      const fullPath = `/Users/username/Pictures/${name}`;
      
      // Infer source type based on path
      const sourceType = inferSourceType(fullPath);
      const icon = sourceType === 'drive' ? <HardDrive className="w-4 h-4" /> : <Folder className="w-4 h-4" />;
      
      // Generate fresh pre-scan stats live
      const stats = generatePreScanStats();
      
      const newSource: Source = {
        id: Date.now().toString(),
        icon,
        label: name,
        type: sourceType,
        path: fullPath,
        active: true,
        selected: true,
        confirmed: false,
        stats: stats
      };

      const updatedSources = sources.map(s => ({ ...s, active: false }));
      setSources([...updatedSources, newSource]);
      setActiveSource(newSource);
      setPendingSource(newSource);
      
      setPreScanStats(stats);
      setShowPreScanConfirm(true);
      setIsComplete(false); // Reset analysis on source change
      
      e.target.value = '';
    }
  };

  const handleZipChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      const fileName = file.name;
      const fullPath = `/Users/username/Downloads/${fileName}`;
      
      // Generate fresh pre-scan stats live
      const stats = generatePreScanStats();

      const newSource: Source = {
        id: Date.now().toString(),
        icon: <FileArchive className="w-4 h-4" />,
        label: fileName,
        type: 'zip',
        path: fullPath,
        active: true,
        selected: true,
        confirmed: false,
        stats: stats
      };

      const updatedSources = sources.map(s => ({ ...s, active: false }));
      setSources([...updatedSources, newSource]);
      setActiveSource(newSource);
      setPendingSource(newSource);
      
      setPreScanStats(stats);
      setShowPreScanConfirm(true);
      setIsComplete(false); // Reset analysis on source change
      
      e.target.value = '';
    }
  };

  const handleAddAnother = () => {
    setShowSourceTypeSelector(true);
  };

  const generatePreScanStats = (): PreScanStats => {
    const totalFiles = Math.floor(Math.random() * 5000) + 500;
    const photoCount = Math.floor(totalFiles * (Math.random() * 0.4 + 0.4));
    const videoCount = Math.floor(totalFiles * (Math.random() * 0.3 + 0.1));
    const estimatedSizeGB = parseFloat((Math.random() * 150 + 10).toFixed(2));
    
    const earliest = new Date(2018 + Math.floor(Math.random() * 4), Math.floor(Math.random() * 12), Math.floor(Math.random() * 28) + 1);
    const latest = new Date(2024, Math.floor(Math.random() * 12), Math.floor(Math.random() * 28) + 1);
    
    return {
      totalFiles,
      photoCount,
      videoCount,
      estimatedSizeGB,
      dateRange: {
        earliest: earliest.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
        latest: latest.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      }
    };
  };

  const handleAddToWorkspace = () => {
    // Confirm the pending source
    if (pendingSource) {
      const updatedSources = sources.map(s => s.id === pendingSource.id ? { ...s, confirmed: true } : s);
      setSources(updatedSources);
    }
    
    // Just close the modal, source is already added
    setShowPreScanConfirm(false);
    setPreScanStats(null);
    setPendingSource(null);
  };

  const handleChangeSourceFromModal = () => {
    if (pendingSource) {
      // Remove the pending source
      setSources(sources.filter(s => s.id !== pendingSource.id));
      setShowPreScanConfirm(false);
      setPreScanStats(null);
      setPendingSource(null);
      setActiveSource(null);
      
      // Reopen OS picker
      setTimeout(() => {
        // Show source type selector first
        setShowSourceTypeSelector(true);
      }, 0);
    }
  };

  const handleCancelSourceSelection = () => {
    // Remove the pending source and close modal
    if (pendingSource) {
      setSources(sources.filter(s => s.id !== pendingSource.id));
      setShowPreScanConfirm(false);
      setPreScanStats(null);
      setPendingSource(null);
      setActiveSource(null);
    }
  };

  const handleTriggerFolderPicker = () => {
    folderOrDriveInputRef.current?.click();
  };

  const handleTriggerZipPicker = () => {
    zipInputRef.current?.click();
  };

  return (
    <div className="flex h-screen bg-background overflow-hidden font-sans">
      <input
        type="file"
        ref={folderOrDriveInputRef}
        className="hidden"
        onChange={handleFolderOrDriveChange}
        // @ts-expect-error - webkitdirectory is standard in modern browsers but missing in types
        webkitdirectory=""
        directory=""
        multiple
      />

      <input
        type="file"
        ref={zipInputRef}
        className="hidden"
        onChange={handleZipChange}
        accept=".zip"
      />
      <Sidebar 
        sources={sources} 
        onSourceClick={handleSourceClick} 
        onSelectAll={handleSelectAll}
        isComplete={isComplete}
        onAddSource={handleAddSource}
        onRemoveSource={() => {
          // Remove all selected sources
          const updatedSources = sources.filter(s => !s.selected);
          setSources(updatedSources);
          setIsComplete(false); // Reset analysis on source change
          setActiveSource(null);
          // If no sources left, maybe redirect? Handled by MainContent if empty
        }}
        activePanel={activePanel}
        onPanelChange={(panel) => setActivePanel(panel as 'getting-started' | 'best-practices' | 'what-next' | null)}
        onDashboardClick={() => {
          setActivePanel(null);
          const updatedSources = sources.map(s => ({ ...s, active: false }));
          setSources(updatedSources);
          setActiveSource(null);
        }}
        onSettingsClick={() => setShowSettingsModal(true)}
      />
      {activePanel ? (
        <PanelPlaceholder panelType={activePanel} />
      ) : (
        <MainContent 
          sources={sources}
          activeSource={activeSource} 
          onRemove={handleRemoveSource}
          onChange={handleChangeSource}
          isComplete={isComplete}
          analysisResults={analysisResults}
          sourceAnalysisResults={sourceAnalysisResults}
          onAddAnother={handleAddAnother}
          onPreviewChanges={() => setShowPreviewModal(true)}
          onViewResults={() => setShowResultsModal(true)}
          onAddFolder={handleTriggerFolderPicker}
          onAddZip={handleTriggerZipPicker}
          showCompletionScreen={showCompletionScreen}
          onDismissCompletion={() => setShowCompletionScreen(false)}
        />
      )}
      {showPreviewModal && <PreviewModal onClose={() => setShowPreviewModal(false)} results={analysisResults} fileResults={sourceAnalysisResults} />}
      {showResultsModal && <ResultsModal onClose={() => setShowResultsModal(false)} />}
      {showLicenseModal && <LicenseModal onClose={() => setShowLicenseModal(false)} />}
      {showSettingsModal && (
        <SettingsModal 
          onClose={() => setShowSettingsModal(false)} 
          folderStructure={folderStructure}
          onFolderStructureChange={(value) => {
            setFolderStructure(value);
            localStorage.setItem('pdr-folder-structure', value);
          }}
        />
      )}
      
      {/* Fixed controls in top-right corner */}
      <div className="fixed top-4 right-4 z-40 flex items-center gap-2">
        <button
          onClick={toggleDarkMode}
          className="flex items-center justify-center w-8 h-8 rounded-full bg-secondary hover:bg-secondary/80 text-muted-foreground transition-colors"
          data-testid="button-toggle-dark-mode"
        >
          {isDarkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
        <LicenseStatusBadge onClick={() => setShowLicenseModal(true)} />
      </div>
      
      {showPreScanConfirm && pendingSource && preScanStats && (
        <SourceAddedModal 
          source={pendingSource}
          stats={preScanStats}
          onAddToWorkspace={handleAddToWorkspace}
          onChangeSource={handleChangeSourceFromModal}
          onCancel={handleCancelSourceSelection}
          onAddFolder={() => { handleAddToWorkspace(); handleTriggerFolderPicker(); }}
          onAddZip={() => { handleAddToWorkspace(); handleTriggerZipPicker(); }}
        />
      )}

      
      {showSourceTypeSelector && (
        <div className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50">
          <Card className="w-96 p-6">
            <h2 className="text-xl font-semibold text-foreground mb-4">Select Source Type</h2>
            <div className="space-y-3">
              <button
                onClick={() => handleSelectSourceType('folderOrDrive')}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary hover:bg-secondary/30 transition-colors text-left"
              >
                <img src="/Assets/pdr-folder.png" className="w-5 h-5 object-contain" alt="Folder" />
                <div>
                  <div className="font-medium text-foreground">Add Folder or Drive</div>
                  <div className="text-xs text-muted-foreground">Select a folder or scan a drive</div>
                </div>
              </button>
              <button
                onClick={() => handleSelectSourceType('zip')}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary hover:bg-secondary/30 transition-colors text-left"
              >
                <img src="/Assets/pdr-zip.png" className="w-5 h-5 object-contain" alt="ZIP" />
                <div>
                  <div className="font-medium text-foreground">Add ZIP Archive</div>
                  <div className="text-xs text-muted-foreground">Import a .zip file</div>
                </div>
              </button>
            </div>
            <Button
              variant="ghost"
              className="w-full mt-4"
              onClick={() => setShowSourceTypeSelector(false)}
            >
              Cancel
            </Button>
          </Card>
        </div>
      )}
    </div>
  );
}

function Sidebar({ sources, onSourceClick, onSelectAll, isComplete, onAddSource, onRemoveSource, activePanel, onPanelChange, onDashboardClick, onSettingsClick }: { sources: Source[], onSourceClick: (id: string, shiftKey: boolean) => void, onSelectAll: (checked: boolean) => void, isComplete: boolean, onAddSource: () => void, onRemoveSource: () => void, activePanel: string | null, onPanelChange: (panel: string | null) => void, onDashboardClick: () => void, onSettingsClick: () => void }) {
  const allSelected = sources.length > 0 && sources.every(s => s.selected);
  const someSelected = sources.some(s => s.selected) && !allSelected;
  const hasSelectedSources = sources.some(s => s.selected);

  const [width, setWidth] = useState(280);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const newWidth = Math.max(200, Math.min(600, e.clientX));
      setWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.cursor = 'default';
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'default'; // Ensure cursor reset on cleanup
    };
  }, [isResizing]);

  return (
    <div 
      className="bg-sidebar border-r border-sidebar-border flex flex-col h-full shrink-0 z-20 relative transition-none"
      style={{ width: `${width}px` }}
    >
      <div 
        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors z-50 group"
        onMouseDown={(e) => {
          e.preventDefault();
          setIsResizing(true);
        }}
      >
        <div className="absolute right-0 top-0 bottom-0 w-4 -mr-2 bg-transparent group-hover:bg-primary/10 transition-colors" />
      </div>

      <div className="px-6 py-8 flex items-center cursor-pointer" onClick={() => onDashboardClick()}>
        <>
          <img src="/Assets/pdr-logo-stacked_transparent.png" alt="Photo Date Rescue" className="h-14 w-auto object-contain dark:hidden" />
          <div className="hidden dark:flex flex-col items-center">
            <img src="/Assets/pdr-logo-stacked_transparent_dark_v2.png" alt="Photo Date Rescue" className="h-10 w-auto object-contain" />
            <span className="text-foreground font-semibold text-sm tracking-wide mt-1">PDR</span>
          </div>
        </>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-6">
        {/* DASHBOARD LINK */}
        <div>
          <SidebarItem 
            icon={<img src="/Assets/pdr-workspace.png" className="w-4 h-4 object-contain" alt="Workspace" />} 
            label="Workspace" 
            onClick={() => onDashboardClick()}
            active={activePanel === null && !sources.some(s => s.active)}
            selectable={false}
          />
        </div>

        {/* SOURCES SECTION */}
        <div>
          <div className="flex items-center justify-between mb-3 px-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Sources</h3>
            {sources.length > 0 && (
              <div className="flex items-center gap-2">
                <Checkbox 
                  id="select-all"
                  checked={allSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={(checked) => onSelectAll(checked === true)}
                  className="w-3.5 h-3.5 border-muted-foreground/50 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                />
                <label 
                  htmlFor="select-all" 
                  className="text-[10px] uppercase font-semibold text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors"
                >
                  Select All
                </label>
              </div>
            )}
          </div>
          <div className="space-y-1">
            {sources.map((source) => (
              <SidebarItem 
                key={source.id} 
                icon={source.icon} 
                label={source.label} 
                active={false} 
                selected={source.selected}
                selectable={true}
                onClick={(e) => onSourceClick(source.id, e?.shiftKey ?? false)}
              />
            ))}
          </div>
          <div className="flex gap-2 mt-2 px-2">
            <Button 
              variant="outline" 
              size="sm"
              className="flex-1 justify-center gap-2 text-muted-foreground hover:text-foreground border-primary/30 hover:border-primary/50 hover:bg-primary/5"
              onClick={onAddSource}
            >
              <img src="/Assets/pdr-add-source.png" className="w-4 h-4 object-contain" alt="Add Source" /> Source
            </Button>
            <Button 
              variant="outline"
              size="sm" 
              className="flex-1 justify-center gap-2 text-muted-foreground hover:text-foreground border-primary/30 hover:border-primary/50 hover:bg-primary/5"
              disabled={!hasSelectedSources}
              onClick={onRemoveSource}
            >
              <img src="/Assets/pdr-remove.png" className="w-4 h-4 object-contain" alt="Remove" /> Remove
            </Button>
          </div>
        </div>
      </div>

      {/* EDUCATION SECTION */}
      <div className="pt-2 border-t border-sidebar-border/0 pb-2">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-6">Guidance</h3>
        <div className="space-y-1 px-4">
          <SidebarItem icon={<img src="/Assets/pdr-getting-started.png" className="w-4 h-4 object-contain" alt="Getting Started" />} label="Getting Started" onClick={() => onPanelChange('getting-started')} active={activePanel === 'getting-started'} />
          <SidebarItem icon={<img src="/Assets/pdr-best-practices.png" className="w-4 h-4 object-contain" alt="Best Practices" />} label="Best Practices" onClick={() => onPanelChange('best-practices')} active={activePanel === 'best-practices'} />
          <SidebarItem icon={<img src="/Assets/pdr-what-happens-next.png" className="w-4 h-4 object-contain" alt="What Happens Next" />} label="What Happens Next" onClick={() => onPanelChange('what-next')} active={activePanel === 'what-next'} />
        </div>
      </div>

      {/* UTILITY SECTION - BOTTOM */}
      <div className="p-4 border-t border-sidebar-border space-y-1">
        <SidebarItem icon={<img src="/Assets/pdr-settings.png" className="w-4 h-4 object-contain" alt="Settings" />} label="Settings" onClick={onSettingsClick} />
        <SidebarItem icon={<img src="/Assets/pdr-help&support.png" className="w-4 h-4 object-contain" alt="Help & Support" />} label="Help & Support" />
      </div>
    </div>
  );
}

function SidebarItem({ icon, label, active = false, selected = false, selectable = false, onClick, disabled = false }: { icon: React.ReactNode, label: string, active?: boolean, selected?: boolean, selectable?: boolean, onClick?: (e?: React.MouseEvent) => void, disabled?: boolean }) {
  return (
    <div 
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors duration-200 cursor-pointer ${
        disabled 
          ? 'text-muted-foreground/50 cursor-not-allowed' 
          : active 
            ? 'text-secondary-foreground font-medium bg-sidebar-accent/50' 
            : 'text-sidebar-foreground hover:bg-sidebar-accent'
      }`}
      onClick={(e) => !disabled && onClick && onClick(e)}
    >
      {selectable && (
        <div className="flex items-center justify-center" onClick={(e) => {
          e.stopPropagation();
          if (!disabled && onClick) onClick(e);
        }}>
          <Checkbox 
            checked={selected} 
            onCheckedChange={() => {}} // Checkbox change is handled by parent div click or explicit handler if needed
            disabled={disabled}
            className="mr-1 w-4 h-4 border-muted-foreground/50 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
          />
        </div>
      )}
      <div className="flex items-center gap-2 overflow-hidden pointer-events-none">
        {icon}
        <span className="truncate">{label}</span>
      </div>
    </div>
  );
}

function MainContent({ 
  sources,
  activeSource, 
  onRemove, 
  onChange,
  isComplete,
  analysisResults,
  sourceAnalysisResults,
  onAddAnother,
  onPreviewChanges,
  onViewResults,
  onAddFolder,
  onAddZip,
  showCompletionScreen,
  onDismissCompletion
}: { 
  sources: Source[],
  activeSource: Source | null,
  onRemove: () => void,
  onChange: () => void,
  isComplete: boolean,
  analysisResults: AnalysisResults,
  sourceAnalysisResults?: Record<string, SourceAnalysisResult>,
  onAddAnother: () => void,
  onPreviewChanges: () => void,
  onViewResults: () => void,
  onAddFolder: () => void,
  onAddZip: () => void,
  showCompletionScreen: boolean,
  onDismissCompletion: () => void
}) {
  // Show Empty State only if no sources exist at all
  if (sources.length === 0) {
     return <EmptyState onAddFirstSource={onAddAnother} />;
  }

  // NOTE: Previous CompletionState component logic is now merged into DashboardPanel
  // to keep the Workspace view active after analysis.

  if (isComplete && showCompletionScreen) {
    return (
      <CompletionState 
        results={analysisResults} 
        onAddAnother={() => {
          onDismissCompletion();
          onAddAnother();
        }} 
        onViewResults={onViewResults}
        onBackToWorkspace={onDismissCompletion}
      />
    );
  }

  // Unified Dashboard Panel for pre-analysis AND post-analysis state
  return (
    <DashboardPanel 
      sources={sources}
      activeSource={activeSource} 
      onRemove={onRemove}
      onChange={onChange}
      onAddFolder={onAddFolder}
      onAddZip={onAddZip}
      isComplete={isComplete}
      results={analysisResults}
      onViewResults={onViewResults}
      fileResults={sourceAnalysisResults}
    />
  );
}

function DashboardPanel({ sources, activeSource, onRemove, onChange, onAddFolder, onAddZip, isComplete = false, results, onViewResults, fileResults }: { sources: Source[], activeSource: Source | null, onRemove: () => void, onChange: () => void, onAddFolder: () => void, onAddZip: () => void, isComplete?: boolean, results?: AnalysisResults, onViewResults?: () => void, fileResults?: Record<string, SourceAnalysisResult> }) {
  // Use selected sources for aggregation
  const selectedSources = sources.filter(s => s.selected && s.confirmed);
  const hasSelection = selectedSources.length > 0;
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [showFixModal, setShowFixModal] = useState(false);
  const [showPostFixReport, setShowPostFixReport] = useState(false);
  const [includePhotos, setIncludePhotos] = useState(true);
  const [includeVideos, setIncludeVideos] = useState(true);
  
  const [destinationPath, setDestinationPath] = useState<string | null>(null);
  const [destinationFreeGB, setDestinationFreeGB] = useState<number>(0);
  const [destinationTotalGB, setDestinationTotalGB] = useState<number>(0);
  
  const handleChangeDestination = async () => {
    const { selectDestination, getDiskSpace, isElectron } = await import('@/lib/electron-bridge');
    
    if (isElectron()) {
      const path = await selectDestination();
      if (path) {
        setDestinationPath(path);
        const diskInfo = await getDiskSpace(path);
        setDestinationFreeGB(diskInfo.freeBytes / (1024 * 1024 * 1024));
        setDestinationTotalGB(diskInfo.totalBytes / (1024 * 1024 * 1024));
      }
    } else {
      setDestinationPath('/Volumes/Photos_Backup/Restored_2024');
      setDestinationFreeGB(2400);
      setDestinationTotalGB(4000);
    }
  };

  // Mock stats generator based on SELECTED sources and file type filters
  const getStats = () => {
    if (!hasSelection) {
      return {
        label: "No Sources Selected",
        path: "Select sources from the sidebar",
        totalFiles: 0,
        photos: 0,
        videos: 0,
        sizeGB: 0,
        dateRange: "-",
        sourceCount: 0
      };
    }

    // Aggregate stats
    const allPhotos = selectedSources.reduce((acc, s) => acc + (s.stats?.photoCount || 0), 0);
    const allVideos = selectedSources.reduce((acc, s) => acc + (s.stats?.videoCount || 0), 0);
    const totalSizeGB = selectedSources.reduce((acc, s) => acc + (s.stats?.estimatedSizeGB || 0), 0);
    
    // Apply file type filters
    const photos = includePhotos ? allPhotos : 0;
    const videos = includeVideos ? allVideos : 0;
    const totalFiles = photos + videos;
    
    // Estimate size proportionally based on included file types
    const photoRatio = allPhotos / (allPhotos + allVideos || 1);
    const videoRatio = allVideos / (allPhotos + allVideos || 1);
    const sizeGB = (includePhotos ? totalSizeGB * photoRatio : 0) + (includeVideos ? totalSizeGB * videoRatio : 0);

    return {
      label: "Combined Analysis",
      path: `${selectedSources.length} ${selectedSources.length === 1 ? 'source' : 'sources'} selected`,
      totalFiles,
      photos,
      videos,
      sizeGB,
      dateRange: "2018 — 2024",
      sourceCount: selectedSources.length
    };
  };

  const stats = getStats();

  // Mock confidence stats based on filtered totals
  const totalMediaFiles = stats.photos + stats.videos;
  const highConf = Math.floor(totalMediaFiles * 0.65);
  const medConf = Math.floor(totalMediaFiles * 0.25);
  const lowConf = Math.floor(totalMediaFiles * 0.10);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-background relative">
      <div className="flex-1 flex flex-col items-center justify-start p-8 overflow-y-auto pb-24">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-4xl w-full pt-4"
      >
        <div className="mb-8 text-center">
           <h2 className="text-2xl font-semibold text-foreground mb-2">Workspace</h2>
           <p className="text-muted-foreground">Review your sources and start analysis</p>
        </div>

        {/* Confidence Summary Section */}
        {hasSelection && (
          <section className="mb-8 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-100">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-foreground">Date Summary</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <ConfidenceCard 
                level="Confirmed" 
                count={highConf} 
                percentage={Math.round((highConf / (highConf + medConf + lowConf)) * 100) || 0}
                description="Date confirmed from embedded photo metadata."
                color="text-emerald-600"
                bgColor="bg-emerald-50"
                borderColor="border-emerald-200"
                icon={<ShieldCheck className="w-5 h-5" />}
                tooltip="Date taken directly from information saved by the camera, app, or backup at the time the photo or video was created."
                isActive={false}
              />
              <ConfidenceCard 
                level="Recovered" 
                count={medConf} 
                percentage={Math.round((medConf / (highConf + medConf + lowConf)) * 100) || 0}
                description="Date recovered from structured filename patterns."
                color="text-indigo-600"
                bgColor="bg-indigo-50"
                borderColor="border-indigo-200"
                icon={<Sparkles className="w-5 h-5" />}
                tooltip="Date inferred from recognised filename formats (such as WhatsApp, camera, or backup naming patterns) using consistent, reliable structures."
                isActive={false}
              />
              <ConfidenceCard 
                level="Marked" 
                count={lowConf} 
                percentage={Math.round((lowConf / (highConf + medConf + lowConf)) * 100) || 0}
                description="No reliable date found — file will be renamed using fallback rules."
                color="text-slate-600"
                bgColor="bg-slate-100"
                borderColor="border-slate-200"
                icon={<Tag className="w-5 h-5" />}
                tooltip="No reliable date could be found. The file will still be safely renamed using a fallback date to avoid conflicts."
                isActive={false}
              />
            </div>
          </section>
        )}

        <Card className="p-6 mb-2">
          <div className="flex items-start justify-between gap-6 mb-8 border-b border-border pb-8">
            <div className="flex items-start gap-6">
              <div className="p-4 bg-secondary/50 rounded-2xl text-primary">
                <img src="/Assets/pdr-combined-analysis.png" className="w-8 h-8 object-contain" alt="Combined Analysis" />
              </div>
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <h3 className="text-xl font-medium text-foreground">{stats.label}</h3>
                  {isComplete && (
                    <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-100/50 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200/50 dark:border-emerald-700/50">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                      </span>
                      <span className="text-xs font-medium">Analysis Ready</span>
                    </div>
                  )}
                </div>
                <p className="text-sm text-muted-foreground font-mono bg-muted px-2 py-1 rounded inline-block">
                  {stats.path}
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-6">
              <div 
                className={`flex flex-col items-center gap-6 px-5 py-3 rounded-full border transition-colors duration-150 ${
                  includePhotos 
                    ? 'border-emerald-300/60 bg-emerald-50/30 dark:border-emerald-600/40 dark:bg-emerald-900/20' 
                    : 'border-primary/20 bg-primary/5 dark:border-primary/30 dark:bg-primary/10'
                } focus-within:border-emerald-400/80 focus-within:bg-emerald-50/50 dark:focus-within:border-emerald-500/60 dark:focus-within:bg-emerald-900/30`}
              >
                <span className="text-xs font-medium text-muted-foreground">Photos</span>
                <Checkbox 
                  checked={includePhotos} 
                  onCheckedChange={(checked) => setIncludePhotos(checked === true)}
                  data-testid="checkbox-include-photos"
                  className="w-5 h-5"
                />
              </div>
              <div 
                className={`flex flex-col items-center gap-6 px-5 py-3 rounded-full border transition-colors duration-150 ${
                  includeVideos 
                    ? 'border-emerald-300/60 bg-emerald-50/30 dark:border-emerald-600/40 dark:bg-emerald-900/20' 
                    : 'border-primary/20 bg-primary/5 dark:border-primary/30 dark:bg-primary/10'
                } focus-within:border-emerald-400/80 focus-within:bg-emerald-50/50 dark:focus-within:border-emerald-500/60 dark:focus-within:bg-emerald-900/30`}
              >
                <span className="text-xs font-medium text-muted-foreground">Videos</span>
                <Checkbox 
                  checked={includeVideos} 
                  onCheckedChange={(checked) => setIncludeVideos(checked === true)}
                  data-testid="checkbox-include-videos"
                  className="w-5 h-5"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-8">
            <div>
              <div className="text-sm text-muted-foreground mb-1">Sources</div>
              <div className="text-2xl font-semibold text-secondary-foreground" style={{ filter: "saturate(1.075)" }}>{stats.sourceCount.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Total Photos</div>
              <div className="flex items-center gap-2 text-lg font-semibold text-secondary-foreground" style={{ filter: "saturate(1.075)" }}>
                <FileImage className="w-4 h-4" /> {stats.photos.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Total Videos</div>
              <div className="flex items-center gap-2 text-lg font-semibold text-secondary-foreground" style={{ filter: "saturate(1.075)" }}>
                <FileVideo className="w-4 h-4" /> {stats.videos.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Total Size</div>
              <div className="text-2xl font-semibold text-secondary-foreground" style={{ filter: "saturate(1.075)" }}>{stats.sizeGB.toFixed(1)} GB</div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-4">
             <div className="flex gap-4">
               <Button variant="outline" size="sm" onClick={onAddFolder} className="gap-2 text-muted-foreground hover:text-foreground border-primary/30 hover:border-primary/50 hover:bg-primary/5">
                 <img src="/Assets/pdr-folder.png" className="w-4 h-4 object-contain" alt="Folder" /> Add Folder / Drive
               </Button>
               <Button variant="outline" size="sm" onClick={onAddZip} className="gap-2 text-muted-foreground hover:text-foreground border-primary/30 hover:border-primary/50 hover:bg-primary/5">
                 <img src="/Assets/pdr-zip.png" className="w-4 h-4 object-contain" alt="ZIP" /> Add ZIP Archive
               </Button>
             </div>
             {/* Only show "Analysis complete" if complete */}
             {isComplete && (
               <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-100/50 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200/50 dark:border-emerald-700/50">
                  <CheckCircle2 className="w-4 h-4" />
                  <span className="text-xs font-medium">Analysis complete</span>
               </div>
             )}
          </div>
        </Card>

        {/* Preview Section */}
        <section className="pt-0 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-200">
            <h2 className="text-lg font-semibold text-foreground mb-4">Output Preview</h2>
            <Card className="flex flex-col md:flex-row items-center gap-6 p-5">
              <div className="p-4 bg-secondary/50 rounded-full">
                <img src="/Assets/pdr-destination-drive.png" className="w-6 h-6 object-contain" alt="Destination Drive" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-medium mb-1">Destination Drive</h3>
                {destinationPath ? (
                  <>
                    <p className="text-sm text-muted-foreground font-mono bg-muted px-2 py-1 rounded inline-block mb-2">{destinationPath}</p>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${destinationFreeGB >= stats.sizeGB ? 'text-emerald-600 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-900/30' : 'text-rose-600 bg-rose-50 dark:text-rose-400 dark:bg-rose-900/30'}`}>
                        {destinationFreeGB >= 1000 ? `${(destinationFreeGB / 1000).toFixed(1)} TB` : `${destinationFreeGB.toFixed(1)} GB`} Free
                      </span>
                      <span className="text-xs text-muted-foreground">Required: {stats.sizeGB.toFixed(1)} GB</span>
                      {destinationFreeGB < stats.sizeGB && (
                        <span className="text-xs text-rose-600 dark:text-rose-400 font-medium">Insufficient space</span>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No destination selected. Click "Change Destination" to choose where to save fixed files.</p>
                )}
              </div>
              <Button variant="outline" onClick={handleChangeDestination} data-testid="button-change-destination">Change Destination</Button>
            </Card>
        </section>
      </motion.div>
      </div>

      {/* Sticky Bottom Action Bar for Complete State */}
      {isComplete && (
        <motion.div 
          initial={{ y: 100 }}
          animate={{ y: 0 }}
          className="absolute bottom-0 left-0 right-0 bg-background border-t border-border p-4 shadow-[0_-4px_20px_-5px_rgba(0,0,0,0.1)] z-20"
        >
          <div className="max-w-5xl mx-auto flex items-center justify-between">
             <div className="text-sm font-medium text-muted-foreground">
                <span className="text-foreground font-bold">{(results?.fixed ? results.fixed + results.unchanged + (results.skipped || 0) : stats.totalFiles).toLocaleString()}</span> files ready to process
                {!destinationPath && <span className="ml-2 text-amber-600 dark:text-amber-400">— Select a destination to continue</span>}
                {destinationPath && destinationFreeGB < stats.sizeGB && <span className="ml-2 text-rose-600 dark:text-rose-400">— Insufficient space on destination</span>}
             </div>
             <div className="flex items-center gap-4">
               <Button 
                 onClick={() => setShowFixModal(true)} 
                 variant="outline" 
                 disabled={!destinationPath || destinationFreeGB < stats.sizeGB}
                 className="border-2 border-secondary-foreground bg-secondary/5 hover:bg-secondary/20 text-secondary-foreground px-8 shadow-[0_4px_14px_0_rgba(107,90,255,0.3)] hover:shadow-[0_6px_20px_rgba(107,90,255,0.4)] transition-all duration-300 font-bold h-11 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
                 data-testid="button-run-fix"
               >
                 <Wrench className="w-5 h-5 mr-2 stroke-[2.5]" /> Run Fix
               </Button>
             </div>
          </div>
        </motion.div>
      )}

      {showPreviewModal && <PreviewModal onClose={() => setShowPreviewModal(false)} results={results} />}
      {showFixModal && <FixProgressModal 
        onClose={() => setShowFixModal(false)} 
        totalFiles={results?.fixed ? results.fixed + results.unchanged + (results.skipped || 0) : 1248} 
        destinationPath={destinationPath}
        onViewReport={() => {
          setShowFixModal(false);
          setShowPostFixReport(true);
        }}
      />}
      {showPostFixReport && <PostFixReportModal 
        onClose={() => setShowPostFixReport(false)} 
        results={results}
        destinationPath={destinationPath}
        fileResults={fileResults}
      />}
    </div>
  );
}

function Dashboard({ sources, activeSource, onStartAnalysis, onPreviewChanges }: { sources: Source[], activeSource: Source, onStartAnalysis: () => void, onPreviewChanges: () => void }) {
  const [filter, setFilter] = useState<"High" | "Medium" | "Low" | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);

  const confirmedSources = sources.filter(s => s.confirmed);
  
  // Get stats based on selection
  const getStats = () => {
    if (selectedSourceId === null) {
      // Combined stats
      return {
        totalFiles: 1248 * confirmedSources.length,
        photos: 892 * confirmedSources.length,
        videos: 356 * confirmedSources.length,
        dateRange: "2018 — 2024",
        highConfidence: 892 * confirmedSources.length,
        mediumConfidence: 312 * confirmedSources.length,
        lowConfidence: 44 * confirmedSources.length,
        label: "Combined Analysis (All Sources)"
      };
    } else {
      // Per-source stats
      return {
        totalFiles: 1248,
        photos: 892,
        videos: 356,
        dateRange: "2018 — 2024",
        highConfidence: 892,
        mediumConfidence: 312,
        lowConfidence: 44,
        label: `Analysis (${confirmedSources.find(s => s.id === selectedSourceId)?.label || 'Source'})`
      };
    }
  };

  const stats = getStats();

  const toggleFilter = (level: "High" | "Medium" | "Low") => {
    setFilter(current => current === level ? null : level);
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-background">
      <header className="h-16 border-b border-border bg-background/50 backdrop-blur-sm flex items-center justify-between px-8 shrink-0">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Workspace</span>
          <ChevronRight className="w-4 h-4" />
          <span className="text-foreground font-medium">{selectedSourceId === null ? "All Sources" : confirmedSources.find(s => s.id === selectedSourceId)?.label}</span>
        </div>
        <div className="flex items-center gap-4">
           <span className="text-sm text-muted-foreground">Last saved: Just now</span>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-5xl mx-auto space-y-8">
          
          <section>
            <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">Preview – example results</span>
            </div>

            {/* Source Chips */}
            <div className="flex items-center gap-3 mb-6 pb-6 border-b border-border overflow-x-auto">
              <SourceChip 
                label="All Sources" 
                isActive={selectedSourceId === null}
                onClick={() => setSelectedSourceId(null)}
              />
              {confirmedSources.map(source => (
                <SourceChip 
                  key={source.id}
                  icon={source.icon}
                  label={source.label} 
                  isActive={selectedSourceId === source.id}
                  onClick={() => setSelectedSourceId(source.id)}
                />
              ))}
            </div>

            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-2xl font-semibold text-foreground mb-1">Date Summary</h2>
                <p className="text-sm text-muted-foreground">{stats.label}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <ConfidenceCard 
                level="Confirmed" 
                count={stats.highConfidence} 
                percentage={Math.round((stats.highConfidence / (stats.highConfidence + stats.mediumConfidence + stats.lowConfidence)) * 100) || 0}
                description="Date confirmed from embedded photo metadata."
                color="text-emerald-600"
                bgColor="bg-emerald-50"
                borderColor="border-emerald-200"
                icon={<ShieldCheck className="w-5 h-5" />}
                tooltip="Date taken directly from information saved by the camera, app, or backup at the time the photo or video was created."
                isActive={filter === "High"}
                onClick={() => toggleFilter("High")}
              />
              <ConfidenceCard 
                level="Recovered" 
                count={stats.mediumConfidence} 
                percentage={Math.round((stats.mediumConfidence / (stats.highConfidence + stats.mediumConfidence + stats.lowConfidence)) * 100) || 0}
                description="Date recovered from structured filename patterns."
                color="text-indigo-600"
                bgColor="bg-indigo-50"
                borderColor="border-indigo-200"
                icon={<Sparkles className="w-5 h-5" />}
                tooltip="Date inferred from recognised filename formats (such as WhatsApp, camera, or backup naming patterns) using consistent, reliable structures."
                isActive={filter === "Medium"}
                onClick={() => toggleFilter("Medium")}
              />
              <ConfidenceCard 
                level="Marked" 
                count={stats.lowConfidence} 
                percentage={Math.round((stats.lowConfidence / (stats.highConfidence + stats.mediumConfidence + stats.lowConfidence)) * 100) || 0}
                description="No reliable date found — file will be renamed using fallback rules."
                color="text-slate-600"
                bgColor="bg-slate-100"
                borderColor="border-slate-200"
                icon={<Tag className="w-5 h-5" />}
                tooltip="No reliable date could be found. The file will still be safely renamed using a fallback date to avoid conflicts."
                isActive={filter === "Low"}
                onClick={() => toggleFilter("Low")}
              />
            </div>
            {filter && (
              <div className="mt-4 p-4 bg-background border border-border rounded-lg text-sm text-muted-foreground flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
                 <div className={`w-2 h-2 rounded-full ${filter === 'High' ? 'bg-emerald-500' : filter === 'Medium' ? 'bg-amber-500' : 'bg-rose-500'}`} />
                 Filtering for <strong>{filter} Confidence</strong> files.
              </div>
            )}
          </section>

          <section className="pt-1">
            <h2 className="text-2xl font-semibold text-foreground mb-6">Output Selection</h2>
            <Card className="flex flex-col md:flex-row items-center gap-6 p-6">
              <div className="p-4 bg-secondary/50 rounded-full">
                <HardDrive className="w-6 h-6 text-primary" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-medium mb-1">Destination Drive</h3>
                <p className="text-sm text-muted-foreground mb-2">/Volumes/Photos_Backup/Restored_2024</p>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">2.4 TB Free</span>
                  <span className="text-xs text-muted-foreground">Required: 4.2 GB</span>
                </div>
              </div>
              <Button variant="outline">Change Destination</Button>
            </Card>
          </section>

        </div>
      </div>

      <div className="h-20 bg-background border-t border-border flex items-center justify-between px-8 shrink-0 z-10 shadow-[0_-4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center gap-4">
           <div className="text-sm text-muted-foreground">
             <span className="font-medium text-foreground">{stats.totalFiles.toLocaleString()}</span> files ready to process
           </div>
        </div>
        <div className="flex items-center gap-4">
          <Button variant="outline" size="lg" onClick={onPreviewChanges}>Preview Changes</Button>
          <Button size="lg" className="px-8 shadow-lg shadow-primary/25" onClick={onStartAnalysis}>
            <Play className="w-4 h-4 mr-2 fill-current" /> Apply Fixes
          </Button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onAddFirstSource }: { onAddFirstSource: () => void }) {
  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-background">
      <div className="flex-1 flex items-center justify-center p-8">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-2xl w-full text-center"
        >
          <div className="mb-12">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.1, type: "spring", stiffness: 80 }}
              className="mb-8"
            >
              <>
                <img src="/Assets/pdr-logo_transparent.png" alt="Photo Date Rescue" className="h-20 w-auto mx-auto dark:hidden" />
                <div className="hidden dark:flex flex-col items-center">
                  <img src="/Assets/pdr-logo-stacked_transparent_dark_v2.png" alt="Photo Date Rescue" className="h-16 w-auto object-contain" />
                  <span className="text-foreground font-semibold text-lg tracking-wide mt-1">PDR</span>
                </div>
              </>
            </motion.div>
            
            <h1 className="text-4xl font-semibold text-foreground mb-4">Your workspace is empty</h1>
            <p className="text-lg text-muted-foreground mb-8 leading-relaxed">
              Add a folder, ZIP archive, or drive to begin analysing your photos and videos.
            </p>
            
            <div className="flex flex-col gap-3 justify-center items-center">
              <Button 
                size="lg" 
                className="px-12 h-12 text-base shadow-lg shadow-primary/25"
                onClick={onAddFirstSource}
              >
                Add Your First Source
              </Button>
              <button
                onClick={() => {}}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Explore the dashboard
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function AnalysingState({ progress }: { progress: AnalysisProgress }) {
  // Use progress to simulate confidence counts growing
  const percentComplete = Math.min(100, Math.round((progress.current / progress.total) * 100));
  
  // Simulated live stats
  const highConf = Math.floor(892 * (percentComplete / 100));
  const medConf = Math.floor(312 * (percentComplete / 100));
  const lowConf = Math.floor(44 * (percentComplete / 100));

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-background">
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-5xl mx-auto space-y-8">
          
          <section>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-2xl font-semibold text-foreground mb-1">Date Summary</h2>
                <p className="text-sm text-muted-foreground">Based on metadata signals found in {progress.current.toLocaleString()} files.</p>
              </div>
              <Button variant="outline" size="sm" disabled>View Detailed Report</Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <ConfidenceCard 
                level="Confirmed" 
                count={highConf} 
                percentage={Math.round((highConf / (highConf + medConf + lowConf)) * 100) || 0}
                description="Date confirmed from embedded photo metadata."
                color="text-emerald-600"
                bgColor="bg-emerald-50"
                borderColor="border-emerald-200"
                icon={<ShieldCheck className="w-5 h-5" />}
                tooltip="Date taken directly from information saved by the camera, app, or backup at the time the photo or video was created."
                isActive={false}
              />
              <ConfidenceCard 
                level="Recovered" 
                count={medConf} 
                percentage={Math.round((medConf / (highConf + medConf + lowConf)) * 100) || 0}
                description="Date recovered from structured filename patterns."
                color="text-indigo-600"
                bgColor="bg-indigo-50"
                borderColor="border-indigo-200"
                icon={<Sparkles className="w-5 h-5" />}
                tooltip="Date inferred from recognised filename formats (such as WhatsApp, camera, or backup naming patterns) using consistent, reliable structures."
                isActive={false}
              />
              <ConfidenceCard 
                level="Marked" 
                count={lowConf} 
                percentage={Math.round((lowConf / (highConf + medConf + lowConf)) * 100) || 0}
                description="No reliable date found — file will be renamed using fallback rules."
                color="text-slate-600"
                bgColor="bg-slate-100"
                borderColor="border-slate-200"
                icon={<Tag className="w-5 h-5" />}
                tooltip="No reliable date could be found. The file will still be safely renamed using a fallback date to avoid conflicts."
                isActive={false}
              />
            </div>
          </section>

          <section className="pt-1">
            <h2 className="text-2xl font-semibold text-foreground mb-6">Output Selection</h2>
            <Card className="flex flex-col md:flex-row items-center gap-6 p-6">
              <div className="p-4 bg-secondary/50 rounded-full">
                <HardDrive className="w-6 h-6 text-primary" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-medium mb-1">Destination Drive</h3>
                <p className="text-sm text-muted-foreground mb-2">/Volumes/Photos_Backup/Restored_2024</p>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">2.4 TB Free</span>
                  <span className="text-xs text-muted-foreground">Required: 4.2 GB</span>
                </div>
              </div>
              <Button variant="outline">Change Destination</Button>
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}

function CompletionState({ results, onAddAnother, onViewResults, onBackToWorkspace }: { results: AnalysisResults, onAddAnother: () => void, onViewResults: () => void, onBackToWorkspace: () => void }) {
  const total = results.fixed + results.unchanged + results.skipped;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-background">
      <header className="h-16 border-b border-border bg-background/50 backdrop-blur-sm flex items-center justify-between px-8 shrink-0">
        <div className="flex items-center gap-2 text-sm text-foreground font-medium">
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          <span>Analysis Complete</span>
        </div>
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={onBackToWorkspace}
          className="text-muted-foreground hover:text-foreground"
        >
          Back to workspace
        </Button>
      </header>

      <div className="flex-1 flex items-center justify-center p-8">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-2xl w-full text-center"
        >
          <div className="mb-8">
            <motion.div 
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.2, type: "spring", stiffness: 100 }}
              className="mb-6 flex justify-center"
            >
              <div className="p-4 bg-emerald-50 rounded-full">
                <CheckCircle2 className="w-12 h-12 text-emerald-500" />
              </div>
            </motion.div>
            
            <h2 className="text-3xl font-semibold text-foreground mb-3">All done!</h2>
            <p className="text-muted-foreground mb-8">Your photos and videos have been analysed and organised.</p>
            
            <Card className="p-8 mb-8">
              <div className="space-y-6">
                <div className="flex items-center justify-between px-4 py-3 bg-background/50 rounded-lg">
                  <span className="text-muted-foreground">Files fixed</span>
                  <span className="text-2xl font-semibold text-emerald-600">{results.fixed}</span>
                </div>
                <div className="flex items-center justify-between px-4 py-3 bg-background/50 rounded-lg">
                  <span className="text-muted-foreground">Files unchanged</span>
                  <span className="text-2xl font-semibold text-foreground">{results.unchanged}</span>
                </div>
                <div className="flex items-center justify-between px-4 py-3 bg-background/50 rounded-lg">
                  <span className="text-muted-foreground">Files skipped</span>
                  <span className="text-2xl font-semibold text-amber-600">{results.skipped}</span>
                </div>
              </div>
            </Card>

            <div className="flex items-center gap-4 justify-center">
              <Button variant="outline" size="lg" onClick={onViewResults}>
                <Eye className="w-4 h-4 mr-2" /> View Results
              </Button>
              <Button size="lg" className="px-8 shadow-lg shadow-primary/25">
                <FolderOpen className="w-4 h-4 mr-2" /> Open Destination
              </Button>
              <Button variant="outline" size="lg" onClick={onAddAnother}>
                <Plus className="w-4 h-4 mr-2" /> Add Another Source
              </Button>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function SourceChip({ icon, label, isActive, onClick }: { icon?: React.ReactNode, label: string, isActive: boolean, onClick: () => void }) {
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      className={`flex items-center gap-2 px-4 py-2 rounded-full font-medium text-sm transition-all duration-200 shrink-0 ${
        isActive
          ? 'bg-primary text-white shadow-lg shadow-primary/30'
          : 'bg-primary/5 border border-primary/20 text-foreground hover:bg-primary/10 hover:border-primary/40'
      }`}
    >
      {icon && <span className="w-4 h-4">{icon}</span>}
      {label}
    </motion.button>
  );
}

function ConfidenceCard({ level, count, percentage, description, color, bgColor, borderColor, icon, isActive, onClick, tooltip }: any) {
  return (
    <div onClick={onClick} className="relative group cursor-pointer outline-none h-full">
       {isActive && (
         <motion.div 
            layoutId="active-ring"
            className="absolute -inset-[2px] rounded-[20px] border-2 border-primary bg-transparent pointer-events-none z-10"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
         />
       )}
      <Card className={`border ${borderColor} hover:border-opacity-100 transition-all duration-300 h-full flex flex-col ${isActive ? 'bg-white shadow-md scale-[1.01]' : 'hover:scale-[1.01]'}`}>
        <div className="flex justify-between items-start mb-4">
          <div className={`p-2 rounded-lg ${bgColor} ${color}`}>
            {icon}
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs font-semibold uppercase tracking-wider ${color} bg-opacity-10 px-2 py-1 rounded-full ${bgColor}`}>
              {level}
            </span>
            {tooltip && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="cursor-help opacity-40 hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                      <Info className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-[250px] p-3 text-sm">
                    <p>{tooltip}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
        <div className="flex items-baseline gap-2 mb-2">
          <div className="text-4xl font-bold text-foreground">{count.toLocaleString()}</div>
          <div className="text-lg font-medium text-muted-foreground">({percentage}%)</div>
        </div>
        <p className="text-sm text-muted-foreground mt-auto">{description}</p>
      </Card>
    </div>
  );
}

function PreviewModal({ onClose, results, fileResults }: { 
  onClose: () => void, 
  results?: AnalysisResults,
  fileResults?: Record<string, SourceAnalysisResult>
}) {
  const [filterConfidence, setFilterConfidence] = useState<'all' | 'confirmed' | 'recovered' | 'marked'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  
  const mockFileData = [
    { filename: "IMG_20240115_143022.jpg", suggestedFilename: "2024-01-15_14-30-22.jpg", dateConfidence: "confirmed" as const, dateSource: "EXIF DateTimeOriginal", path: "", extension: ".jpg", type: "photo" as const, sizeBytes: 2500000, derivedDate: "2024-01-15T14:30:22.000Z", originalDate: null },
    { filename: "DSC_9921.jpg", suggestedFilename: "2023-08-12_09-15-00.jpg", dateConfidence: "confirmed" as const, dateSource: "EXIF DateTimeOriginal", path: "", extension: ".jpg", type: "photo" as const, sizeBytes: 3200000, derivedDate: "2023-08-12T09:15:00.000Z", originalDate: null },
    { filename: "IMG-20180512-WA0042.jpg", suggestedFilename: "2018-05-12_12-00-00_WA_FN.jpg", dateConfidence: "recovered" as const, dateSource: "WhatsApp filename", path: "", extension: ".jpg", type: "photo" as const, sizeBytes: 1800000, derivedDate: "2018-05-12T12:00:00.000Z", originalDate: null },
    { filename: "VID_20200610_164530.mp4", suggestedFilename: "2020-06-10_16-45-30.mp4", dateConfidence: "recovered" as const, dateSource: "Filename (VID datetime)", path: "", extension: ".mp4", type: "video" as const, sizeBytes: 45000000, derivedDate: "2020-06-10T16:45:30.000Z", originalDate: null },
    { filename: "Screenshot_2022-03-01_10-00-00.png", suggestedFilename: "2022-03-01_10-00-00_FN.png", dateConfidence: "recovered" as const, dateSource: "Filename (Screenshot)", path: "", extension: ".png", type: "photo" as const, sizeBytes: 850000, derivedDate: "2022-03-01T10:00:00.000Z", originalDate: null },
    { filename: "vacation_photo.jpg", suggestedFilename: "2024-12-19_08-30-15.jpg", dateConfidence: "marked" as const, dateSource: "File modification time (fallback)", path: "", extension: ".jpg", type: "photo" as const, sizeBytes: 2100000, derivedDate: "2024-12-19T08:30:15.000Z", originalDate: null },
    { filename: "birthday_party.mp4", suggestedFilename: "2023-06-22_19-45-00.mp4", dateConfidence: "marked" as const, dateSource: "File modification time (fallback)", path: "", extension: ".mp4", type: "video" as const, sizeBytes: 120000000, derivedDate: "2023-06-22T19:45:00.000Z", originalDate: null },
    { filename: "photo_2021_summer.jpg", suggestedFilename: "2021-07-15_12-00-00_FN.jpg", dateConfidence: "recovered" as const, dateSource: "Filename (date with separators)", path: "", extension: ".jpg", type: "photo" as const, sizeBytes: 1950000, derivedDate: "2021-07-15T12:00:00.000Z", originalDate: null },
    { filename: "IMG_1234.HEIC", suggestedFilename: "2022-11-28_14-22-33.heic", dateConfidence: "confirmed" as const, dateSource: "EXIF DateTimeOriginal", path: "", extension: ".heic", type: "photo" as const, sizeBytes: 4200000, derivedDate: "2022-11-28T14:22:33.000Z", originalDate: null },
    { filename: "sunset_beach.jpg", suggestedFilename: "2024-08-05_18-45-00.jpg", dateConfidence: "confirmed" as const, dateSource: "Google Takeout JSON", path: "", extension: ".jpg", type: "photo" as const, sizeBytes: 3800000, derivedDate: "2024-08-05T18:45:00.000Z", originalDate: null },
  ];
  
  const realFiles = Object.values(fileResults || {}).flatMap(source => source.files || []);
  const allFiles = realFiles.length > 0 ? realFiles : mockFileData;
  
  const filteredFiles = allFiles.filter(file => {
    const matchesConfidence = filterConfidence === 'all' || file.dateConfidence === filterConfidence;
    const matchesSearch = searchTerm === '' || 
      file.filename.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (file.suggestedFilename?.toLowerCase().includes(searchTerm.toLowerCase()));
    return matchesConfidence && matchesSearch;
  });

  const confidenceCounts = {
    confirmed: allFiles.filter(f => f.dateConfidence === 'confirmed').length,
    recovered: allFiles.filter(f => f.dateConfidence === 'recovered').length,
    marked: allFiles.filter(f => f.dateConfidence === 'marked').length,
  };

  const getConfidenceBadge = (confidence: string) => {
    switch (confidence) {
      case 'confirmed':
        return <span className="ml-2 text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-medium">Confirmed</span>;
      case 'recovered':
        return <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">Recovered</span>;
      case 'marked':
        return <span className="ml-2 text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">Fallback</span>;
      default:
        return null;
    }
  };

  const getConfidenceColor = (confidence: string) => {
    switch (confidence) {
      case 'confirmed': return 'text-emerald-600';
      case 'recovered': return 'text-blue-600';
      case 'marked': return 'text-amber-600';
      default: return 'text-muted-foreground';
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
    >
      <motion.div 
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-background rounded-2xl shadow-2xl max-w-4xl w-full max-h-[85vh] overflow-hidden flex flex-col"
      >
        <div className="p-6 border-b border-border flex items-center justify-between bg-background">
          <div>
            <h2 className="text-xl font-semibold text-foreground">Preview Changes</h2>
            <p className="text-sm text-muted-foreground">
              {allFiles.length.toLocaleString()} files analyzed - Review proposed renames before applying
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-secondary rounded-full transition-colors">
            <X className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>
        
        <div className="p-6 space-y-6 overflow-y-auto flex-1">
          {/* Confidence Filter Tabs */}
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setFilterConfidence('all')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                filterConfidence === 'all' 
                  ? 'bg-primary text-primary-foreground' 
                  : 'bg-secondary text-muted-foreground hover:text-foreground'
              }`}
            >
              All ({allFiles.length.toLocaleString()})
            </button>
            <button
              onClick={() => setFilterConfidence('confirmed')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                filterConfidence === 'confirmed' 
                  ? 'bg-emerald-600 text-white' 
                  : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
              }`}
            >
              Confirmed ({confidenceCounts.confirmed.toLocaleString()})
            </button>
            <button
              onClick={() => setFilterConfidence('recovered')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                filterConfidence === 'recovered' 
                  ? 'bg-blue-600 text-white' 
                  : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
              }`}
            >
              Recovered ({confidenceCounts.recovered.toLocaleString()})
            </button>
            <button
              onClick={() => setFilterConfidence('marked')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                filterConfidence === 'marked' 
                  ? 'bg-amber-600 text-white' 
                  : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
              }`}
            >
              Fallback ({confidenceCounts.marked.toLocaleString()})
            </button>
          </div>

          {/* Search */}
          <div className="relative">
            <input
              type="text"
              placeholder="Search filenames..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-4 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              data-testid="input-search-files"
            />
            {searchTerm && (
              <button 
                onClick={() => setSearchTerm('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* File List */}
          <div className="border border-border rounded-xl overflow-hidden">
            <div className="grid grid-cols-[1fr,auto,1fr,auto] gap-4 p-3 bg-secondary/50 text-xs font-medium text-muted-foreground border-b border-border">
              <div>Original Filename</div>
              <div></div>
              <div>Proposed Filename</div>
              <div>Confidence</div>
            </div>
            <div className="divide-y divide-border max-h-[400px] overflow-y-auto">
              {filteredFiles.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  {allFiles.length === 0 
                    ? "No files analyzed yet. Add a source and run analysis."
                    : "No files match the current filter."}
                </div>
              ) : (
                filteredFiles.slice(0, 100).map((file, i) => {
                  const willRename = file.suggestedFilename && file.suggestedFilename !== file.filename;
                  return (
                    <div 
                      key={i} 
                      className="grid grid-cols-[1fr,auto,1fr,auto] gap-4 p-3 text-sm hover:bg-secondary/20 transition-colors items-center"
                      data-testid={`row-file-${i}`}
                    >
                      <div className="font-mono text-muted-foreground truncate text-xs" title={file.filename}>
                        {file.filename}
                      </div>
                      <ArrowRight className={`w-4 h-4 flex-shrink-0 ${willRename ? 'text-emerald-500' : 'text-muted-foreground/30'}`} />
                      <div 
                        className={`font-mono truncate text-xs ${willRename ? getConfidenceColor(file.dateConfidence) + ' font-medium' : 'text-muted-foreground'}`}
                        title={file.suggestedFilename || file.filename}
                      >
                        {file.suggestedFilename || file.filename}
                      </div>
                      <div className="flex-shrink-0">
                        {getConfidenceBadge(file.dateConfidence)}
                      </div>
                    </div>
                  );
                })
              )}
              {filteredFiles.length > 100 && (
                <div className="p-3 text-center text-sm text-muted-foreground bg-secondary/30">
                  Showing first 100 of {filteredFiles.length.toLocaleString()} files
                </div>
              )}
            </div>
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-emerald-500"></span>
              <span><strong>Confirmed:</strong> Date from EXIF, XMP, or Google Takeout</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-blue-500"></span>
              <span><strong>Recovered:</strong> Date extracted from filename pattern</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-amber-500"></span>
              <span><strong>Fallback:</strong> Using file modification time</span>
            </div>
          </div>
        </div>

        <div className="p-6 border-t border-border bg-background">
          <Button onClick={onClose} className="w-full" size="lg">Close Preview</Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function FixProgressModal({ onClose, totalFiles, destinationPath, onViewReport }: { onClose: () => void, totalFiles: number, destinationPath: string | null, onViewReport: () => void }) {
  const [progress, setProgress] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const [processed, setProcessed] = useState(0);
  const [isElectronEnv, setIsElectronEnv] = useState(false);

  useEffect(() => {
    import('@/lib/electron-bridge').then(({ isElectron }) => {
      setIsElectronEnv(isElectron());
    });
  }, []);

  useEffect(() => {
    if (isComplete) return;
    
    const interval = setInterval(() => {
      setProgress(prev => {
        const next = prev + 1;
        if (next >= 100) {
          setIsComplete(true);
          return 100;
        }
        return next;
      });
      setProcessed(prev => Math.min(Math.floor((progress / 100) * totalFiles), totalFiles));
    }, 50);
    
    return () => clearInterval(interval);
  }, [isComplete, progress, totalFiles]);

  useEffect(() => {
    if (isComplete) setProcessed(totalFiles);
  }, [isComplete, totalFiles]);

  const handleOpenDestination = async () => {
    if (destinationPath && isElectronEnv) {
      const { openDestinationFolder } = await import('@/lib/electron-bridge');
      await openDestinationFolder(destinationPath);
    }
  };

  const confirmedCount = Math.floor(totalFiles * 0.65);
  const recoveredCount = Math.floor(totalFiles * 0.25);
  const markedCount = totalFiles - confirmedCount - recoveredCount;

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
    >
      <motion.div 
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="bg-background rounded-2xl shadow-2xl max-w-md w-full p-8 text-center border border-border"
      >
        {!isComplete ? (
          <>
            <div className="mb-8">
              <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-6 relative">
                 <Loader2 className="w-8 h-8 text-primary animate-spin" />
              </div>
              <h2 className="text-2xl font-semibold text-foreground mb-2">Applying Fixes...</h2>
              <p className="text-muted-foreground">Renaming and organizing your files</p>
            </div>

            <div className="space-y-2 mb-8">
              <div className="flex justify-between text-sm font-medium">
                <span>Processing...</span>
                <span>{Math.round(progress)}%</span>
              </div>
              <Progress value={progress} className="h-2" />
              <p className="text-xs text-muted-foreground text-left pt-1">
                {processed} of {totalFiles} files processed
              </p>
            </div>
          </>
        ) : (
          <>
            <motion.div 
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring" }}
              className="w-20 h-20 bg-emerald-100/50 dark:bg-emerald-900/30 rounded-full flex items-center justify-center mx-auto mb-6 border border-emerald-200/50 dark:border-emerald-700/50"
            >
              <CheckCircle2 className="w-10 h-10 text-emerald-600 dark:text-emerald-400" />
            </motion.div>
            
            <h2 className="text-2xl font-semibold text-foreground mb-2">Fix Complete</h2>
            <p className="text-muted-foreground mb-6">All {totalFiles.toLocaleString()} files have been successfully processed.</p>
            
            <div className="grid grid-cols-3 gap-3 mb-6 p-4 bg-muted/50 rounded-xl">
              <div className="text-center">
                <div className="text-lg font-semibold text-emerald-600 dark:text-emerald-400">{confirmedCount.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">Confirmed</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-semibold text-indigo-600 dark:text-indigo-400">{recoveredCount.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">Recovered</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-semibold text-slate-600 dark:text-slate-400">{markedCount.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">Marked</div>
              </div>
            </div>
            
            <div className="space-y-3">
              <Button 
                onClick={onViewReport} 
                className="w-full bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-700 dark:hover:bg-emerald-600" 
                size="lg"
                data-testid="button-view-report"
              >
                <FileText className="w-4 h-4 mr-2" /> View Report
              </Button>
              <div className="grid grid-cols-2 gap-3">
                <Button variant="outline" onClick={onClose} size="lg" data-testid="button-close-fix">
                  Close
                </Button>
                <Button 
                  variant="outline" 
                  onClick={handleOpenDestination} 
                  size="lg"
                  disabled={!destinationPath || !isElectronEnv}
                  title={!isElectronEnv ? "Available in desktop app" : undefined}
                  data-testid="button-open-destination"
                >
                  <FolderOpen className="w-4 h-4 mr-2" /> Open Destination
                </Button>
              </div>
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}

function PostFixReportModal({ onClose, results, destinationPath, fileResults }: { 
  onClose: () => void, 
  results?: AnalysisResults,
  destinationPath: string | null,
  fileResults?: Record<string, SourceAnalysisResult>
}) {
  const [filterConfidence, setFilterConfidence] = useState<'all' | 'confirmed' | 'recovered' | 'marked'>('all');
  const [isElectronEnv, setIsElectronEnv] = useState(false);
  
  useEffect(() => {
    import('@/lib/electron-bridge').then(({ isElectron }) => {
      setIsElectronEnv(isElectron());
    });
  }, []);

  const handleOpenDestination = async () => {
    if (destinationPath && isElectronEnv) {
      const { openDestinationFolder } = await import('@/lib/electron-bridge');
      await openDestinationFolder(destinationPath);
    }
  };

  // Extract real file data from analysis results when available
  const realFiles = Object.values(fileResults || {}).flatMap(source => 
    (source.files || []).map(file => ({
      filename: file.filename,
      newFilename: file.suggestedFilename || file.filename,
      dateConfidence: file.dateConfidence,
      dateSource: file.dateSource
    }))
  );

  // Fallback mock data for preview mode when no real analysis data exists
  const mockFileData = [
    { filename: "IMG_20240115_143022.jpg", newFilename: "2024-01-15_14-30-22.jpg", dateConfidence: "confirmed" as const, dateSource: "EXIF DateTimeOriginal" },
    { filename: "DSC_9921.jpg", newFilename: "2023-08-12_09-15-00.jpg", dateConfidence: "confirmed" as const, dateSource: "EXIF DateTimeOriginal" },
    { filename: "IMG-20180512-WA0042.jpg", newFilename: "2018-05-12_12-00-00_WA_FN.jpg", dateConfidence: "recovered" as const, dateSource: "WhatsApp filename" },
    { filename: "VID_20200610_164530.mp4", newFilename: "2020-06-10_16-45-30.mp4", dateConfidence: "recovered" as const, dateSource: "Filename (VID datetime)" },
    { filename: "Screenshot_2022-03-01_10-00-00.png", newFilename: "2022-03-01_10-00-00_FN.png", dateConfidence: "recovered" as const, dateSource: "Filename (Screenshot)" },
    { filename: "vacation_photo.jpg", newFilename: "2024-12-19_08-30-15.jpg", dateConfidence: "marked" as const, dateSource: "File modification time (fallback)" },
    { filename: "birthday_party.mp4", newFilename: "2023-06-22_19-45-00.mp4", dateConfidence: "marked" as const, dateSource: "File modification time (fallback)" },
    { filename: "photo_2021_summer.jpg", newFilename: "2021-07-15_12-00-00_FN.jpg", dateConfidence: "recovered" as const, dateSource: "Filename (date with separators)" },
    { filename: "IMG_1234.HEIC", newFilename: "2022-11-28_14-22-33.heic", dateConfidence: "confirmed" as const, dateSource: "EXIF DateTimeOriginal" },
    { filename: "sunset_beach.jpg", newFilename: "2024-08-05_18-45-00.jpg", dateConfidence: "confirmed" as const, dateSource: "Google Takeout JSON" },
  ];
  
  // Use real data when available, otherwise use mock data for UI preview
  const hasRealData = realFiles.length > 0;
  const allFiles = hasRealData ? realFiles : mockFileData;
  
  // Calculate totals from real results or derive from file list
  const totalFiles = results?.fixed 
    ? results.fixed + results.unchanged + (results.skipped || 0) 
    : allFiles.length;
  
  const filteredFiles = allFiles.filter(file => 
    filterConfidence === 'all' || file.dateConfidence === filterConfidence
  );
  
  // Calculate confidence counts from actual data
  const confidenceCounts = hasRealData 
    ? {
        confirmed: allFiles.filter(f => f.dateConfidence === 'confirmed').length,
        recovered: allFiles.filter(f => f.dateConfidence === 'recovered').length,
        marked: allFiles.filter(f => f.dateConfidence === 'marked').length
      }
    : {
        confirmed: Math.floor(totalFiles * 0.65),
        recovered: Math.floor(totalFiles * 0.25),
        marked: totalFiles - Math.floor(totalFiles * 0.65) - Math.floor(totalFiles * 0.25)
      };
  
  const getConfidenceBadge = (confidence: 'confirmed' | 'recovered' | 'marked') => {
    const styles = {
      confirmed: "bg-emerald-100/50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200/50 dark:border-emerald-700/50",
      recovered: "bg-indigo-100/50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 border-indigo-200/50 dark:border-indigo-700/50",
      marked: "bg-slate-100/50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-400 border-slate-200/50 dark:border-slate-700/50"
    };
    const labels = { confirmed: "Confirmed", recovered: "Recovered", marked: "Marked" };
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${styles[confidence]}`}>
        {labels[confidence]}
      </span>
    );
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
    >
      <motion.div 
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-background rounded-2xl shadow-2xl max-w-4xl w-full max-h-[85vh] flex flex-col border border-border"
      >
        <div className="p-6 border-b border-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-100/50 dark:bg-emerald-900/30 rounded-full flex items-center justify-center border border-emerald-200/50 dark:border-emerald-700/50">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-foreground">Fix Report</h2>
              <p className="text-sm text-muted-foreground">{totalFiles.toLocaleString()} files processed successfully</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-secondary rounded-full transition-colors">
            <X className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>
        
        <div className="p-6 space-y-6 overflow-y-auto flex-1">
          {!hasRealData && (
            <div className="flex items-center gap-2 px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50 rounded-lg text-sm text-amber-700 dark:text-amber-300">
              <Info className="w-4 h-4 shrink-0" />
              <span>Showing sample data for preview. Actual results will appear when running in desktop app.</span>
            </div>
          )}
          
          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 bg-emerald-100/50 dark:bg-emerald-900/30 rounded-xl border border-emerald-200/50 dark:border-emerald-700/50 text-center">
              <div className="text-2xl font-semibold text-emerald-700 dark:text-emerald-300">{confidenceCounts.confirmed.toLocaleString()}</div>
              <div className="text-sm text-emerald-600 dark:text-emerald-400">Confirmed</div>
              <div className="text-xs text-muted-foreground mt-1">EXIF / Takeout metadata</div>
            </div>
            <div className="p-4 bg-indigo-100/50 dark:bg-indigo-900/30 rounded-xl border border-indigo-200/50 dark:border-indigo-700/50 text-center">
              <div className="text-2xl font-semibold text-indigo-700 dark:text-indigo-300">{confidenceCounts.recovered.toLocaleString()}</div>
              <div className="text-sm text-indigo-600 dark:text-indigo-400">Recovered</div>
              <div className="text-xs text-muted-foreground mt-1">Filename patterns</div>
            </div>
            <div className="p-4 bg-slate-100/50 dark:bg-slate-800/50 rounded-xl border border-slate-200/50 dark:border-slate-700/50 text-center">
              <div className="text-2xl font-semibold text-slate-600 dark:text-slate-400">{confidenceCounts.marked.toLocaleString()}</div>
              <div className="text-sm text-slate-500 dark:text-slate-400">Marked</div>
              <div className="text-xs text-muted-foreground mt-1">Fallback date used</div>
            </div>
          </div>

          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setFilterConfidence('all')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                filterConfidence === 'all' 
                  ? 'bg-primary text-primary-foreground' 
                  : 'bg-secondary text-muted-foreground hover:text-foreground'
              }`}
            >
              All ({totalFiles.toLocaleString()})
            </button>
            <button
              onClick={() => setFilterConfidence('confirmed')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                filterConfidence === 'confirmed' 
                  ? 'bg-emerald-600 dark:bg-emerald-700 text-white' 
                  : 'bg-emerald-100/50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-200/50 dark:hover:bg-emerald-900/50'
              }`}
            >
              Confirmed ({confidenceCounts.confirmed.toLocaleString()})
            </button>
            <button
              onClick={() => setFilterConfidence('recovered')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                filterConfidence === 'recovered' 
                  ? 'bg-indigo-600 dark:bg-indigo-700 text-white' 
                  : 'bg-indigo-100/50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-200/50 dark:hover:bg-indigo-900/50'
              }`}
            >
              Recovered ({confidenceCounts.recovered.toLocaleString()})
            </button>
            <button
              onClick={() => setFilterConfidence('marked')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                filterConfidence === 'marked' 
                  ? 'bg-slate-600 dark:bg-slate-700 text-white' 
                  : 'bg-slate-100/50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-400 hover:bg-slate-200/50 dark:hover:bg-slate-700/50'
              }`}
            >
              Marked ({confidenceCounts.marked.toLocaleString()})
            </button>
          </div>
          
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_auto_1fr_auto] gap-4 px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              <span>Original Filename</span>
              <span></span>
              <span>New Filename</span>
              <span>Confidence</span>
            </div>
            <div className="space-y-1 max-h-[300px] overflow-y-auto">
              {filteredFiles.map((file, index) => (
                <div 
                  key={index}
                  className="grid grid-cols-[1fr_auto_1fr_auto] gap-4 items-center px-4 py-3 bg-muted/30 dark:bg-muted/10 rounded-lg hover:bg-muted/50 dark:hover:bg-muted/20 transition-colors"
                >
                  <span className="text-sm text-muted-foreground font-mono truncate">{file.filename}</span>
                  <ArrowRight className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm text-foreground font-mono truncate">{file.newFilename}</span>
                  <div className="flex flex-col items-end gap-1">
                    {getConfidenceBadge(file.dateConfidence)}
                    <span className="text-xs text-muted-foreground">{file.dateSource}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground pt-4 border-t border-border">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-emerald-500"></span>
              <span><strong>Confirmed:</strong> Date from EXIF, XMP, or Google Takeout</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-indigo-500"></span>
              <span><strong>Recovered:</strong> Date extracted from filename pattern</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-slate-400 dark:bg-slate-500"></span>
              <span><strong>Marked:</strong> Using file modification time as fallback</span>
            </div>
          </div>
        </div>

        <div className="p-6 border-t border-border bg-background shrink-0">
          <div className="flex gap-3 justify-end">
            <Button 
              variant="outline" 
              onClick={handleOpenDestination}
              disabled={!destinationPath || !isElectronEnv}
              title={!isElectronEnv ? "Available in desktop app" : undefined}
              data-testid="button-report-open-destination"
            >
              <FolderOpen className="w-4 h-4 mr-2" /> Open Destination
            </Button>
            <Button onClick={onClose} size="lg" data-testid="button-close-report">
              Done
            </Button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function ResultsModal({ onClose }: { onClose: () => void }) {
  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
    >
      <motion.div 
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-background rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-y-auto p-8"
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-foreground">Analysis Results</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-medium text-foreground mb-4">Confidence Summary</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-4 bg-emerald-50 rounded-lg border border-emerald-100">
                <span className="text-sm font-medium text-emerald-900">High Confidence</span>
                <span className="text-lg font-semibold text-emerald-600">892 files</span>
              </div>
              <div className="flex items-center justify-between p-4 bg-amber-50 rounded-lg border border-amber-100">
                <span className="text-sm font-medium text-amber-900">Medium Confidence</span>
                <span className="text-lg font-semibold text-amber-600">312 files</span>
              </div>
              <div className="flex items-center justify-between p-4 bg-rose-50 rounded-lg border border-rose-100">
                <span className="text-sm font-medium text-rose-900">Low Confidence</span>
                <span className="text-lg font-semibold text-rose-600">44 files</span>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-medium text-foreground mb-4">File Outcomes</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
                <span className="text-sm font-medium text-foreground">Files Fixed</span>
                <span className="text-lg font-semibold text-emerald-600">810</span>
              </div>
              <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
                <span className="text-sm font-medium text-foreground">Files Unchanged</span>
                <span className="text-lg font-semibold text-foreground">349</span>
              </div>
              <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
                <span className="text-sm font-medium text-foreground">Files Skipped</span>
                <span className="text-lg font-semibold text-amber-600">89</span>
              </div>
            </div>
          </div>
        </div>

        <Button onClick={onClose} className="w-full mt-6">Close</Button>
      </motion.div>
    </motion.div>
  );
}

function PanelPlaceholder({ panelType }: { panelType: string }) {
  if (panelType === 'what-next') {
    return (
      <div className="flex-1 flex flex-col h-full overflow-y-auto bg-background">
        <div className="flex-1 flex flex-col items-center px-8 pt-12 pb-20">
          <div className="w-full max-w-[940px]">
            <h2 className="text-2xl font-semibold text-foreground mb-10">What Happens Next</h2>
          
            <div className="space-y-12">
              <section>
                <div className="flex items-start gap-3 mb-4">
                  <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-semibold shrink-0">1</div>
                  <h3 className="text-lg font-medium text-foreground">Add your sources</h3>
                </div>
                <div className="ml-10 space-y-3 text-sm text-muted-foreground leading-relaxed">
                  <p>Start by adding the folders or ZIP archives that contain your photos and videos.</p>
                  <p className="font-medium text-foreground">Choose the correct option:</p>
                  <ul className="list-disc ml-5 space-y-1.5">
                    <li><span className="font-medium text-foreground">Add Folder / Drive</span> — for folders or entire drives</li>
                    <li><span className="font-medium text-foreground">Add ZIP Archive</span> — for ZIP files (ZIPs won't appear in the folder picker)</li>
                  </ul>
                  <p>Each source is added one at a time, but you can keep adding as many as you like. The file picker will reopen after each selection until you're finished — Photo Date Rescue then analyses all selected sources together in a single, consistent run.</p>
                </div>
              </section>

              <section>
                <div className="flex items-start gap-3 mb-4">
                  <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-semibold shrink-0">2</div>
                  <h3 className="text-lg font-medium text-foreground">Review the Date Summary</h3>
                </div>
                <div className="ml-10 space-y-3 text-sm text-muted-foreground leading-relaxed">
                  <p>Once your sources are added, analysis runs automatically — there's nothing you need to do at this stage.</p>
                  <p>The Date Summary shows how your files were categorised:</p>
                  <ul className="list-disc ml-5 space-y-1.5">
                    <li><span className="font-medium text-foreground">Confirmed</span> — dates taken from embedded metadata</li>
                    <li><span className="font-medium text-foreground">Recovered</span> — dates inferred from structured filenames</li>
                    <li><span className="font-medium text-foreground">Marked</span> — files with no reliable date, safely handled using fallback rules</li>
                  </ul>
                  <p>You can hover over the info icon on each card to see more detail about how that category works. This is purely informational — Photo Date Rescue is already prepared to process all files safely and consistently.</p>
                </div>
              </section>

              <section>
                <div className="flex items-start gap-3 mb-4">
                  <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-semibold shrink-0">3</div>
                  <h3 className="text-lg font-medium text-foreground">Confirm scope and destination</h3>
                </div>
                <div className="ml-10 space-y-3 text-sm text-muted-foreground leading-relaxed">
                  <p>Before running the fix, take a moment to confirm the following — in order:</p>
                  <ul className="list-disc ml-5 space-y-2.5">
                    <li><span className="font-medium text-foreground">Choose a destination</span> – Select or confirm the destination drive where the fixed files will be written.</li>
                    <li><span className="font-medium text-foreground">Select your sources</span> – In the left-hand list, make sure the sources you want to process are checked. You can include or exclude any source at this stage.</li>
                    <li><span className="font-medium text-foreground">Confirm file types</span> – In Combined Analysis, choose whether to include Photos, Videos, or both for this run.</li>
                    <li><span className="font-medium text-foreground">Check available space</span> – Review the storage indicator to ensure the destination drive has enough capacity. The Free amount (shown in green) should exceed the Required size shown alongside it.</li>
                  </ul>
                  <p>Once these are confirmed, you're ready to run the fix.</p>
                </div>
              </section>

              <section>
                <div className="flex items-start gap-3 mb-4">
                  <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-semibold shrink-0">4</div>
                  <h3 className="text-lg font-medium text-foreground">Run the fix</h3>
                </div>
                <div className="ml-10 space-y-3 text-sm text-muted-foreground leading-relaxed">
                  <p>When everything looks right, click <span className="font-medium text-foreground">Run Fix</span>.</p>
                  <p>Photo Date Rescue will:</p>
                  <ul className="list-disc ml-5 space-y-1.5">
                    <li>Apply the correct date logic to every file</li>
                    <li>Rename files safely and consistently</li>
                    <li>Preserve chronological order across all sources</li>
                  </ul>
                  <p>When finished, you'll be able to review exactly what changed.</p>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const content = {
    'getting-started': {
      title: 'Getting Started',
      description: 'Learn how Photo Date Rescue works and the steps involved in restoring your photo and video metadata.'
    },
    'best-practices': {
      title: 'Best Practices',
      description: 'Discover expert-recommended workflows for organizing and preparing your photo library for analysis.'
    }
  };

  const panel = content[panelType as keyof typeof content] || { title: '', description: '' };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center max-w-sm">
          <h2 className="text-2xl font-semibold text-foreground mb-3">{panel.title}</h2>
          <p className="text-muted-foreground mb-6">{panel.description}</p>
          <Card className="p-6 bg-secondary/20 border-primary/10">
            <p className="text-sm text-muted-foreground">Content coming soon</p>
          </Card>
        </div>
      </div>
    </div>
  );
}

function SourceAddedModal({ source, stats, onAddToWorkspace, onChangeSource, onCancel, onAddFolder, onAddZip }: { source: Source, stats: PreScanStats, onAddToWorkspace: () => void, onChangeSource: () => void, onCancel: () => void, onAddFolder: () => void, onAddZip: () => void }) {
  const [step, setStep] = useState<'review' | 'success'>('review');

  if (step === 'success') {
    return (
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
      >
        <motion.div 
          initial={{ scale: 0.95, opacity: 0, y: 10 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          className="bg-background rounded-2xl shadow-2xl max-w-md w-full p-6 border border-border"
        >
          <div className="flex flex-col items-center text-center mb-8">
            <div className="w-16 h-16 bg-emerald-50 rounded-full flex items-center justify-center mb-4">
              <CheckCircle2 className="w-8 h-8 text-emerald-500" />
            </div>
            <h2 className="text-xl font-semibold text-foreground mb-2">Source added</h2>
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">{source.label}</span> added to your workspace.
            </p>
          </div>

          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground text-center mb-4">Next steps</p>
            
            <div className="grid grid-cols-2 gap-3">
              <Button 
                onClick={onAddFolder}
                className="h-11 bg-primary hover:bg-primary/90"
              >
                <Plus className="w-4 h-4 mr-2" /> Add Folder / Drive
              </Button>
              <Button 
                variant="outline" 
                onClick={onAddZip}
                className="h-11"
              >
                <FileArchive className="w-4 h-4 mr-2" /> Add ZIP Archive
              </Button>
            </div>

            <div className="flex justify-center mt-2">
              <button 
                className="text-sm text-muted-foreground hover:text-foreground hover:underline py-2" 
                onClick={onAddToWorkspace}
                data-testid="button-return-to-workspace-success"
              >
                Back to workspace
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    );
  }

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onCancel}
      className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
    >
      <motion.div 
        initial={{ scale: 0.95, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.95, opacity: 0, y: 10 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-background rounded-2xl shadow-2xl max-w-md w-full p-6 border border-border"
      >
        <div className="mb-6">
          <h2 className="text-xl font-semibold text-foreground mb-1">Source added</h2>
          <p className="text-sm text-muted-foreground">Ready to add to workspace</p>
        </div>

        <Card className="p-4 mb-6 bg-gradient-to-br from-primary/5 to-secondary/30 border-primary/20">
          <div className="mb-3">
            <h3 className="text-base font-medium text-foreground mb-1">{source.label}</h3>
            <p className="text-xs text-muted-foreground font-mono break-all">{source.path}</p>
          </div>

          <div className="pt-3 border-t border-border/40 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{stats.totalFiles.toLocaleString()} files</span>
              <span className="text-foreground font-medium">{stats.estimatedSizeGB.toFixed(1)} GB</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{stats.photoCount.toLocaleString()} photos, {stats.videoCount.toLocaleString()} videos</span>
            </div>
          </div>
        </Card>

        <div className="space-y-2">
          <div className="flex gap-3">
            <Button 
              className="flex-1 bg-primary hover:bg-primary/90" 
              onClick={() => setStep('success')}
              data-testid="button-keep-source"
            >
              Keep Source
            </Button>
            <Button 
              variant="outline" 
              className="flex-1" 
              onClick={onChangeSource}
              data-testid="button-change-source"
            >
              Change Source
            </Button>
          </div>
          <div className="flex justify-center mt-2">
            <button 
              className="text-sm text-muted-foreground hover:text-foreground hover:underline py-2" 
              onClick={onCancel}
              data-testid="button-return-to-workspace"
            >
              Back to workspace
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function SettingsModal({ onClose, folderStructure, onFolderStructureChange }: { 
  onClose: () => void, 
  folderStructure: 'year' | 'year-month' | 'year-month-day',
  onFolderStructureChange: (value: 'year' | 'year-month' | 'year-month-day') => void 
}) {
  const options = [
    { value: 'year' as const, label: 'Year', example: '2024/' },
    { value: 'year-month' as const, label: 'Year / Month', example: '2024/03/' },
    { value: 'year-month-day' as const, label: 'Year / Month / Day', example: '2024/03/15/' },
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-background rounded-2xl shadow-2xl max-w-md w-full p-6"
      >
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Settings className="w-5 h-5 text-primary" />
            </div>
            <h2 className="text-xl font-semibold text-foreground">Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-secondary rounded-full transition-colors"
            data-testid="button-close-settings"
          >
            <X className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>

        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-foreground mb-3">
              Folder Structure
            </label>
            <p className="text-xs text-muted-foreground mb-4">
              Choose how files are organized in the destination folder.
            </p>
            
            <div className="space-y-2">
              {options.map((option) => (
                <label
                  key={option.value}
                  className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors ${
                    folderStructure === option.value 
                      ? 'border-primary bg-primary/5' 
                      : 'border-border hover:border-primary/50 hover:bg-secondary/50'
                  }`}
                  data-testid={`option-folder-${option.value}`}
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="radio"
                      name="folderStructure"
                      value={option.value}
                      checked={folderStructure === option.value}
                      onChange={() => onFolderStructureChange(option.value)}
                      className="w-4 h-4 text-primary focus:ring-primary"
                    />
                    <span className="text-sm font-medium text-foreground">{option.label}</span>
                  </div>
                  <span className="text-xs text-muted-foreground font-mono">{option.example}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-6 pt-4 border-t border-border">
          <Button
            onClick={onClose}
            className="w-full"
            data-testid="button-save-settings"
          >
            Done
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
