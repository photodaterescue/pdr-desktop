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
  LayoutGrid
} from "lucide-react";
import { Button } from "@/components/ui/custom-button";
import { Card } from "@/components/ui/custom-card";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { motion } from "framer-motion";

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
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const folderOrDriveInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const [showSourceTypeSelector, setShowSourceTypeSelector] = useState(false);
  
  const [sources, setSources] = useState<Source[]>(() => {
    // Try to load from localStorage
    const saved = localStorage.getItem('pdr-sources');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Rehydrate icons based on type
        return parsed.map((s: any) => ({
          ...s,
          icon: s.type === 'zip' ? <FileArchive className="w-4 h-4" /> : 
                s.type === 'drive' ? <HardDrive className="w-4 h-4" /> : 
                <Folder className="w-4 h-4" />
        }));
      } catch (e) {
        console.error("Failed to parse saved sources", e);
      }
    }
    
    // Default mock data if no saved data
    return [
    {
      id: "mock-1",
      icon: <Folder className="w-4 h-4" />,
      label: "My Vacation Photos",
      type: "folder",
      path: "/Users/username/Pictures/My Vacation Photos",
      active: false,
      selected: true,
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
      selected: true,
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

  // Save sources to localStorage whenever they change
  useEffect(() => {
    // Create a version without the icon property (React Node) for storage
    const sourcesToSave = sources.map(({ icon, ...rest }) => rest);
    localStorage.setItem('pdr-sources', JSON.stringify(sourcesToSave));
  }, [sources]);

  const [activeSource, setActiveSource] = useState<Source | null>(null);
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [isAnalysing, setIsAnalysing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress>({ current: 0, total: 1248, currentFile: "" });
  const [isComplete, setIsComplete] = useState(false);
  const [analysisResults, setAnalysisResults] = useState<AnalysisResults>({ fixed: 0, unchanged: 0, skipped: 0 });
  const [activePanel, setActivePanel] = useState<'getting-started' | 'best-practices' | 'what-next' | null>(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [showResultsModal, setShowResultsModal] = useState(false);
  const [showPreScanConfirm, setShowPreScanConfirm] = useState(false);
  const [preScanStats, setPreScanStats] = useState<PreScanStats | null>(null);
  const [pendingSource, setPendingSource] = useState<Source | null>(null);

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
          icon,
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
      }
    }
  }, [searchString]);

  useEffect(() => {
    if (!isAnalysing || isComplete) return;

    const fileNames = [
      "IMG_2024_Vacation_01.jpg",
      "DSC_9921.jpg",
      "PHOTO_20180512.png",
      "video_backup_001.mp4",
      "Screenshot_20220301.png"
    ];

    const interval = setInterval(() => {
      setAnalysisProgress(prev => {
        const next = prev.current + 1;
        const randomFile = fileNames[Math.floor(Math.random() * fileNames.length)];
        
        if (next >= prev.total) {
          setAnalysisResults({
            fixed: Math.floor(prev.total * 0.65),
            unchanged: Math.floor(prev.total * 0.28),
            skipped: Math.floor(prev.total * 0.07)
          });
          setIsComplete(true);
          return prev;
        }
        
        return { ...prev, current: next, currentFile: randomFile };
      });
    }, 50);

    return () => clearInterval(interval);
  }, [isAnalysing, isComplete]);

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
    // Show source type selector to pick a new source
    setShowSourceTypeSelector(true);
  };

  const handleStartAnalysis = () => {
    setIsAnalysing(true);
  };

  const handleAddSource = () => {
    setShowSourceTypeSelector(true);
  };

  const handleSelectSourceType = (type: 'folderOrDrive' | 'zip') => {
    setShowSourceTypeSelector(false);
    // Trigger file picker immediately after closing modal
    setTimeout(() => {
      if (type === 'folderOrDrive') {
        folderOrDriveInputRef.current?.click();
      } else if (type === 'zip') {
        zipInputRef.current?.click();
      }
    }, 0);
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
        isAnalysing={isAnalysing}
        onAddSource={handleAddSource}
        activePanel={activePanel}
        onPanelChange={(panel) => setActivePanel(panel as 'getting-started' | 'best-practices' | 'what-next' | null)}
        onDashboardClick={() => {
          setActivePanel(null);
          const updatedSources = sources.map(s => ({ ...s, active: false }));
          setSources(updatedSources);
          setActiveSource(null);
        }}
      />
      {activePanel ? (
        <PanelPlaceholder panelType={activePanel} />
      ) : (
        <MainContent 
          sources={sources}
          activeSource={activeSource} 
          onConfirm={handleConfirmSource}
          onRemove={handleRemoveSource}
          onChange={handleChangeSource}
          isAnalysing={isAnalysing}
          analysisProgress={analysisProgress}
          isComplete={isComplete}
          analysisResults={analysisResults}
          onStartAnalysis={handleStartAnalysis}
          onAddAnother={handleAddAnother}
          onPreviewChanges={() => setShowPreviewModal(true)}
          onViewResults={() => setShowResultsModal(true)}
          onAddFolder={handleTriggerFolderPicker}
          onAddZip={handleTriggerZipPicker}
        />
      )}
      {showPreviewModal && <PreviewModal onClose={() => setShowPreviewModal(false)} />}
      {showResultsModal && <ResultsModal onClose={() => setShowResultsModal(false)} />}
      
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-96 p-6">
            <h2 className="text-xl font-semibold text-foreground mb-4">Select Source Type</h2>
            <div className="space-y-3">
              <button
                onClick={() => handleSelectSourceType('folderOrDrive')}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary hover:bg-secondary/30 transition-colors text-left"
              >
                <Folder className="w-5 h-5 text-primary" />
                <div>
                  <div className="font-medium text-foreground">Add Folder or Drive</div>
                  <div className="text-xs text-muted-foreground">Select a folder or scan a drive</div>
                </div>
              </button>
              <button
                onClick={() => handleSelectSourceType('zip')}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary hover:bg-secondary/30 transition-colors text-left"
              >
                <FileArchive className="w-5 h-5 text-primary" />
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

function Sidebar({ sources, onSourceClick, onSelectAll, isAnalysing, onAddSource, activePanel, onPanelChange, onDashboardClick }: { sources: Source[], onSourceClick: (id: string, shiftKey: boolean) => void, onSelectAll: (checked: boolean) => void, isAnalysing: boolean, onAddSource: () => void, activePanel: string | null, onPanelChange: (panel: string | null) => void, onDashboardClick: () => void }) {
  const allSelected = sources.length > 0 && sources.every(s => s.selected);
  const someSelected = sources.some(s => s.selected) && !allSelected;

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

      <div className="px-6 py-8 flex items-center">
        <img src="/Assets/pdr-logo-stacked_transparent.png" alt="Photo Date Rescue" className="h-14 w-auto object-contain" />
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-6">
        {/* DASHBOARD LINK */}
        <div>
          <SidebarItem 
            icon={<LayoutGrid className="w-4 h-4" />} 
            label="Workspace" 
            onClick={() => onDashboardClick()}
            active={activePanel === null && !sources.some(s => s.active)}
            selectable={false}
            disabled={isAnalysing}
          />
        </div>

        {/* SOURCES SECTION */}
        <div>
          <div className="flex items-center justify-between mb-3 px-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Sources</h3>
            {sources.length > 0 && !isAnalysing && (
              <div className="flex items-center gap-2">
                <Checkbox 
                  id="select-all"
                  checked={allSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={(checked) => onSelectAll(checked === true)}
                  disabled={isAnalysing}
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
                disabled={isAnalysing}
              />
            ))}
          </div>
          <Button 
            variant="ghost" 
            className="w-full mt-2 justify-start px-2 text-muted-foreground hover:text-primary"
            disabled={isAnalysing}
            onClick={onAddSource}
          >
            <Plus className="w-4 h-4 mr-2" /> Add Source
          </Button>
        </div>

        {/* ANALYSIS SECTION */}
        {(isAnalysing || sources.some(s => s.confirmed)) && (
        <div className="pt-2 border-t border-sidebar-border">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-2">Analysis</h3>
          
          {isAnalysing ? (
            <div className="mx-2 p-3 bg-secondary/50 rounded-xl border border-border">
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm font-medium text-foreground">Scanning...</span>
                <span className="text-xs font-medium text-primary">84%</span>
              </div>
              <Progress value={84} className="h-1.5 bg-background mb-2" />
              <p className="text-[10px] text-muted-foreground truncate">Processing DSC_9921.jpg</p>
            </div>
          ) : (
             <div className="px-3 py-3 bg-secondary/50 rounded-xl border border-border mx-2">
                <div className="text-sm font-medium">Preview Mode</div>
                <Progress value={0} className="h-1.5 bg-background mt-2" />
                <p className="text-xs text-muted-foreground mt-2">Awaiting analysis...</p>
             </div>
          )}
        </div>
        )}

        {/* EDUCATION SECTION */}
        <div className="pt-2 border-t border-sidebar-border">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-2">Guidance</h3>
          <div className="space-y-1">
            <SidebarItem icon={<AlertCircle className="w-4 h-4" />} label="Getting Started" onClick={() => onPanelChange('getting-started')} active={activePanel === 'getting-started'} disabled={isAnalysing} />
            <SidebarItem icon={<CheckCircle2 className="w-4 h-4" />} label="Best Practices" onClick={() => onPanelChange('best-practices')} active={activePanel === 'best-practices'} disabled={isAnalysing} />
            <SidebarItem icon={<RefreshCw className="w-4 h-4" />} label="What Happens Next" onClick={() => onPanelChange('what-next')} active={activePanel === 'what-next'} disabled={isAnalysing} />
          </div>
        </div>
      </div>

      {/* UTILITY SECTION - BOTTOM */}
      <div className="p-4 border-t border-sidebar-border space-y-1">
        <SidebarItem icon={<Settings className="w-4 h-4" />} label="Settings" disabled={isAnalysing} />
        <SidebarItem icon={<HelpCircle className="w-4 h-4" />} label="Help & Support" disabled={isAnalysing} />
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
            ? 'text-primary font-medium bg-sidebar-accent/50' 
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
  onConfirm, 
  onRemove, 
  onChange,
  isAnalysing,
  analysisProgress,
  isComplete,
  analysisResults,
  onStartAnalysis,
  onAddAnother,
  onPreviewChanges,
  onViewResults,
  onAddFolder,
  onAddZip
}: { 
  sources: Source[],
  activeSource: Source | null,
  onConfirm: () => void,
  onRemove: () => void,
  onChange: () => void,
  isAnalysing: boolean,
  analysisProgress: AnalysisProgress,
  isComplete: boolean,
  analysisResults: AnalysisResults,
  onStartAnalysis: () => void,
  onAddAnother: () => void,
  onPreviewChanges: () => void,
  onViewResults: () => void,
  onAddFolder: () => void,
  onAddZip: () => void
}) {
  // Show Empty State only if no sources exist at all
  if (sources.length === 0) {
     return <EmptyState onAddFirstSource={onAddAnother} />;
  }

  if (isComplete) {
    return <CompletionState results={analysisResults} onAddAnother={onAddAnother} onViewResults={onViewResults} />;
  }

  if (isAnalysing) {
    return <AnalysingState progress={analysisProgress} />;
  }

  // Unified Dashboard Panel for pre-analysis state (handles both single and multi-source)
  return (
    <DashboardPanel 
      sources={sources}
      activeSource={activeSource} 
      onConfirm={onStartAnalysis} // Direct to analysis from dashboard
      onRemove={onRemove}
      onChange={onChange}
      onAddFolder={onAddFolder}
      onAddZip={onAddZip}
    />
  );
}

function DashboardPanel({ sources, activeSource, onConfirm, onRemove, onChange, onAddFolder, onAddZip }: { sources: Source[], activeSource: Source | null, onConfirm: () => void, onRemove: () => void, onChange: () => void, onAddFolder: () => void, onAddZip: () => void }) {
  // Use selected sources for aggregation
  const selectedSources = sources.filter(s => s.selected && s.confirmed);
  const hasSelection = selectedSources.length > 0;

  // Mock stats generator based on SELECTED sources
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
    const totalFiles = selectedSources.reduce((acc, s) => acc + (s.stats?.totalFiles || 0), 0);
    const photos = selectedSources.reduce((acc, s) => acc + (s.stats?.photoCount || 0), 0);
    const videos = selectedSources.reduce((acc, s) => acc + (s.stats?.videoCount || 0), 0);
    const sizeGB = selectedSources.reduce((acc, s) => acc + (s.stats?.estimatedSizeGB || 0), 0);

    return {
      label: "Combined Analysis",
      path: `${selectedSources.length} sources selected`,
      totalFiles,
      photos,
      videos,
      sizeGB,
      dateRange: "2018 — 2024",
      sourceCount: selectedSources.length
    };
  };

  const stats = getStats();

  // Mock confidence stats based on aggregated totals
  const highConf = Math.floor(stats.photos * 0.65);
  const medConf = Math.floor(stats.photos * 0.25);
  const lowConf = Math.floor(stats.photos * 0.10);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#F8F9FC]">
      <div className="flex-1 flex flex-col items-center justify-center p-8 overflow-y-auto">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-2xl w-full"
      >
        <div className="mb-8 text-center">
           <h2 className="text-2xl font-semibold text-foreground mb-2">Workspace</h2>
           <p className="text-muted-foreground">Review your sources and start analysis</p>
        </div>

        {/* Confidence Summary Section */}
        {hasSelection && (
          <section className="mb-8 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-100">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-foreground">Confidence Summary (Estimate)</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <ConfidenceCard 
                level="High" 
                count={highConf} 
                description="Strong agreement between EXIF and filename."
                color="text-emerald-600"
                bgColor="bg-emerald-50"
                borderColor="border-emerald-100"
                icon={<CheckCircle2 className="w-5 h-5" />}
                isActive={false}
              />
              <ConfidenceCard 
                level="Medium" 
                count={medConf} 
                description="Partial metadata found, some heuristics used."
                color="text-amber-600"
                bgColor="bg-amber-50"
                borderColor="border-amber-100"
                icon={<AlertTriangle className="w-5 h-5" />}
                isActive={false}
              />
              <ConfidenceCard 
                level="Low" 
                count={lowConf} 
                description="No reliable date found. Review recommended."
                color="text-rose-600"
                bgColor="bg-rose-50"
                borderColor="border-rose-100"
                icon={<AlertCircle className="w-5 h-5" />}
                isActive={false}
              />
            </div>
          </section>
        )}

        <div className="flex justify-center gap-4 mb-8">
           <Button variant="outline" size="sm" onClick={onAddFolder} className="gap-2 text-muted-foreground hover:text-foreground">
             <Plus className="w-4 h-4" /> Add Folder / Drive
           </Button>
           <Button variant="outline" size="sm" onClick={onAddZip} className="gap-2 text-muted-foreground hover:text-foreground">
             <FileArchive className="w-4 h-4" /> Add ZIP Archive
           </Button>
        </div>

        <Card className="p-8 mb-8">
          <div className="flex items-start gap-6 mb-8 border-b border-border pb-8">
            <div className="p-4 bg-secondary/50 rounded-2xl text-primary">
              <LayoutGrid className="w-8 h-8" />
            </div>
            <div>
              <h3 className="text-xl font-medium text-foreground mb-1">{stats.label}</h3>
              <p className="text-sm text-muted-foreground font-mono bg-muted px-2 py-1 rounded inline-block">
                {stats.path}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-8">
            <div>
              <div className="text-sm text-muted-foreground mb-1">Sources</div>
              <div className="text-2xl font-semibold text-foreground">{stats.sourceCount}</div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Total Photos</div>
              <div className="flex items-center gap-2 text-lg font-semibold text-emerald-600">
                <FileImage className="w-4 h-4" /> {stats.photos.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Total Videos</div>
              <div className="flex items-center gap-2 text-lg font-semibold text-blue-600">
                <FileVideo className="w-4 h-4" /> {stats.videos.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Total Size</div>
              <div className="text-2xl font-semibold text-foreground">{stats.sizeGB.toFixed(1)} GB</div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-4">
             <div className="flex gap-4">
               {/* Actions hidden for aggregate view as requested, mainly confirmation here */}
             </div>
             <Button onClick={onConfirm} disabled={!hasSelection} className="px-8 shadow-lg shadow-primary/20">
               Confirm & Analyze <ChevronRight className="w-4 h-4 ml-2" />
             </Button>
          </div>
        </Card>

        {/* Preview Section */}
        <section className="pt-4 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-200">
            <h2 className="text-lg font-semibold text-foreground mb-4">Output Preview</h2>
            <Card className="flex flex-col md:flex-row items-center gap-6 p-6">
              <div className="p-4 bg-secondary/50 rounded-full">
                <HardDrive className="w-6 h-6 text-primary" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-medium mb-1">Destination Drive</h3>
                <p className="text-sm text-muted-foreground mb-2">/Volumes/Photos_Backup/Restored_2024</p>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">2.4 TB Free</span>
                  <span className="text-xs text-muted-foreground">Required: {stats.sizeGB.toFixed(1)} GB</span>
                </div>
              </div>
              <Button variant="outline">Change Destination</Button>
            </Card>
        </section>
      </motion.div>
      </div>
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
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#F8F9FC]">
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
                <h2 className="text-2xl font-semibold text-foreground mb-1">Confidence Summary</h2>
                <p className="text-sm text-muted-foreground">{stats.label}</p>
              </div>
              <Button variant="outline" size="sm">View Detailed Report</Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <ConfidenceCard 
                level="High" 
                count={stats.highConfidence} 
                description="Strong agreement between EXIF and filename."
                color="text-emerald-600"
                bgColor="bg-emerald-50"
                borderColor="border-emerald-100"
                icon={<CheckCircle2 className="w-5 h-5" />}
                isActive={filter === "High"}
                onClick={() => toggleFilter("High")}
              />
              <ConfidenceCard 
                level="Medium" 
                count={stats.mediumConfidence} 
                description="Partial metadata found, some heuristics used."
                color="text-amber-600"
                bgColor="bg-amber-50"
                borderColor="border-amber-100"
                icon={<AlertTriangle className="w-5 h-5" />}
                isActive={filter === "Medium"}
                onClick={() => toggleFilter("Medium")}
              />
              <ConfidenceCard 
                level="Low" 
                count={stats.lowConfidence} 
                description="No reliable date found. Review recommended."
                color="text-rose-600"
                bgColor="bg-rose-50"
                borderColor="border-rose-100"
                icon={<AlertCircle className="w-5 h-5" />}
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

          <section className="pt-4">
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
             <span className="font-medium text-foreground">{stats.totalFiles}</span> files ready to process
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
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#F8F9FC]">
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
              <img src="/Assets/pdr-logo_transparent.png" alt="Photo Date Rescue" className="h-20 w-auto mx-auto" />
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
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#F8F9FC]">
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-5xl mx-auto space-y-8">
          
          <section>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-2xl font-semibold text-foreground mb-1">Confidence Summary</h2>
                <p className="text-sm text-muted-foreground">Based on metadata signals found in {progress.current.toLocaleString()} files.</p>
              </div>
              <Button variant="outline" size="sm" disabled>View Detailed Report</Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <ConfidenceCard 
                level="High" 
                count={highConf} 
                description="Strong agreement between EXIF and filename."
                color="text-emerald-600"
                bgColor="bg-emerald-50"
                borderColor="border-emerald-100"
                icon={<CheckCircle2 className="w-5 h-5" />}
                isActive={false}
              />
              <ConfidenceCard 
                level="Medium" 
                count={medConf} 
                description="Partial metadata found, some heuristics used."
                color="text-amber-600"
                bgColor="bg-amber-50"
                borderColor="border-amber-100"
                icon={<AlertTriangle className="w-5 h-5" />}
                isActive={false}
              />
              <ConfidenceCard 
                level="Low" 
                count={lowConf} 
                description="No reliable date found. Review recommended."
                color="text-rose-600"
                bgColor="bg-rose-50"
                borderColor="border-rose-100"
                icon={<AlertCircle className="w-5 h-5" />}
                isActive={false}
              />
            </div>
          </section>

          <section className="pt-4">
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

function CompletionState({ results, onAddAnother, onViewResults }: { results: AnalysisResults, onAddAnother: () => void, onViewResults: () => void }) {
  const total = results.fixed + results.unchanged + results.skipped;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#F8F9FC]">
      <header className="h-16 border-b border-border bg-background/50 backdrop-blur-sm flex items-center px-8 shrink-0">
        <div className="flex items-center gap-2 text-sm text-foreground font-medium">
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          <span>Analysis Complete</span>
        </div>
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
          : 'bg-background border border-border text-foreground hover:border-primary/50'
      }`}
    >
      {icon && <span className="w-4 h-4">{icon}</span>}
      {label}
    </motion.button>
  );
}

function ConfidenceCard({ level, count, description, color, bgColor, borderColor, icon, isActive, onClick }: any) {
  return (
    <div onClick={onClick} className="relative group cursor-pointer outline-none">
       {isActive && (
         <motion.div 
            layoutId="active-ring"
            className="absolute -inset-[2px] rounded-[20px] border-2 border-primary bg-transparent pointer-events-none z-10"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
         />
       )}
      <Card className={`border ${borderColor} hover:border-opacity-100 transition-all duration-300 ${isActive ? 'bg-white shadow-md scale-[1.01]' : 'hover:scale-[1.01]'}`}>
        <div className="flex justify-between items-start mb-4">
          <div className={`p-2 rounded-lg ${bgColor} ${color}`}>
            {icon}
          </div>
          <span className={`text-xs font-semibold uppercase tracking-wider ${color} bg-opacity-10 px-2 py-1 rounded-full ${bgColor}`}>
            {level} Confidence
          </span>
        </div>
        <div className="text-4xl font-bold text-foreground mb-2">{count}</div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </Card>
    </div>
  );
}

function PreviewModal({ onClose }: { onClose: () => void }) {
  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
    >
      <motion.div 
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-background rounded-2xl shadow-2xl max-w-md w-full p-8"
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-foreground">Preview Changes</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <Card className="p-6 mb-6 bg-secondary/30 border-primary/20">
          <p className="text-muted-foreground text-center">Preview will be available after analysis is complete.</p>
        </Card>

        <div className="text-sm text-muted-foreground space-y-3 mb-6">
          <p>Once analysis finishes, you'll see:</p>
          <ul className="space-y-2 ml-4">
            <li>• Example filename changes</li>
            <li>• Before / After comparisons</li>
            <li>• Counts per confidence tier</li>
          </ul>
        </div>

        <Button onClick={onClose} className="w-full">Got it</Button>
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
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
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
  const content = {
    'getting-started': {
      title: 'Getting Started',
      description: 'Learn how Photo Date Rescue works and the steps involved in restoring your photo and video metadata.'
    },
    'best-practices': {
      title: 'Best Practices',
      description: 'Discover expert-recommended workflows for organizing and preparing your photo library for analysis.'
    },
    'what-next': {
      title: 'What Happens Next',
      description: 'Understand what the analysis will do, what it will not do, and what to expect from the restoration process.'
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
        className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
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
              <span className="font-medium text-foreground">{source.label}</span> has been added to your workspace.
            </p>
          </div>

          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider text-center mb-4">What would you like to do next?</p>
            
            <Button 
              className="w-full bg-primary hover:bg-primary/90 h-11" 
              onClick={onAddToWorkspace}
            >
              Go to Workspace
            </Button>
            
            <div className="grid grid-cols-2 gap-3">
              <Button 
                variant="outline" 
                onClick={onAddFolder}
                className="h-11"
              >
                <Plus className="w-4 h-4 mr-2" /> Add Folder
              </Button>
              <Button 
                variant="outline" 
                onClick={onAddZip}
                className="h-11"
              >
                <FileArchive className="w-4 h-4 mr-2" /> Add ZIP
              </Button>
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
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
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

        {/* Add more sources section - kept as shortcuts */}
        <div className="mb-6">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Add another source:</p>
          <div className="grid grid-cols-2 gap-2">
             <Button variant="outline" size="sm" onClick={onAddFolder} className="gap-2 text-xs h-9">
               <Plus className="w-3.5 h-3.5" /> Folder / Drive
             </Button>
             <Button variant="outline" size="sm" onClick={onAddZip} className="gap-2 text-xs h-9">
               <FileArchive className="w-3.5 h-3.5" /> ZIP Archive
             </Button>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex gap-3">
            <Button 
              className="flex-1 bg-primary hover:bg-primary/90" 
              onClick={() => setStep('success')}
              data-testid="button-add-to-workspace"
            >
              Add to workspace
            </Button>
            <Button 
              variant="outline" 
              className="flex-1" 
              onClick={onChangeSource}
              data-testid="button-change-source"
            >
              Change source
            </Button>
          </div>
          <Button 
            variant="ghost" 
            className="w-full text-muted-foreground hover:text-foreground" 
            onClick={onCancel}
            data-testid="button-cancel-source"
          >
            Cancel
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
