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
  X
} from "lucide-react";
import { Button } from "@/components/ui/custom-button";
import { Card } from "@/components/ui/custom-card";
import { Progress } from "@/components/ui/progress";
import { motion } from "framer-motion";

interface Source {
  id: string;
  icon: React.ReactNode;
  label: string;
  type: 'folder' | 'zip' | 'drive';
  path?: string;
  active: boolean;
  confirmed: boolean;
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
  
  const [sources, setSources] = useState<Source[]>([]);

  const [activeSource, setActiveSource] = useState<Source | null>(null);
  const [isAnalysing, setIsAnalysing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress>({ current: 0, total: 1248, currentFile: "" });
  const [isComplete, setIsComplete] = useState(false);
  const [analysisResults, setAnalysisResults] = useState<AnalysisResults>({ fixed: 0, unchanged: 0, skipped: 0 });
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
          confirmed: false
        };

        const updatedSources = sources.map(s => ({ ...s, active: false }));
        setSources([...updatedSources, newSource]);
        setActiveSource(newSource);
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

  const handleSourceClick = (id: string) => {
    const updatedSources = sources.map(s => ({ ...s, active: s.id === id }));
    setSources(updatedSources);
    setActiveSource(updatedSources.find(s => s.id === id) || null);
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
      
      const newSource: Source = {
        id: Date.now().toString(),
        icon,
        label: name,
        type: sourceType,
        path: fullPath,
        active: true,
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
      
      e.target.value = '';
    }
  };

  const handleZipChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      const fileName = file.name;
      const fullPath = `/Users/username/Downloads/${fileName}`;
      
      const newSource: Source = {
        id: Date.now().toString(),
        icon: <FileArchive className="w-4 h-4" />,
        label: fileName,
        type: 'zip',
        path: fullPath,
        active: true,
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

  const handleConfirmPreScan = () => {
    if (pendingSource) {
      setShowPreScanConfirm(false);
      setPreScanStats(null);
      setPendingSource(null);
      // Source is already added to the array
    }
  };

  const handleCancelPreScan = () => {
    if (pendingSource) {
      // Remove the pending source
      setSources(sources.filter(s => s.id !== pendingSource.id));
      setShowPreScanConfirm(false);
      setPreScanStats(null);
      setPendingSource(null);
      setActiveSource(null);
    }
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
        isAnalysing={isAnalysing}
        onAddSource={handleAddSource}
      />
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
      />
      {showPreviewModal && <PreviewModal onClose={() => setShowPreviewModal(false)} />}
      {showResultsModal && <ResultsModal onClose={() => setShowResultsModal(false)} />}
      
      {showPreScanConfirm && pendingSource && preScanStats && (
        <PreScanConfirmationModal 
          source={pendingSource}
          stats={preScanStats}
          onConfirm={handleConfirmPreScan}
          onCancel={handleCancelPreScan}
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

function Sidebar({ sources, onSourceClick, isAnalysing, onAddSource }: { sources: Source[], onSourceClick: (id: string) => void, isAnalysing: boolean, onAddSource: () => void }) {
  return (
    <div className="w-[280px] bg-sidebar border-r border-sidebar-border flex flex-col h-full shrink-0 z-20">
      <div className="px-6 py-8 flex items-center">
        <img src="/Assets/pdr-logo-stacked_transparent.png" alt="Photo Date Rescue" className="h-14 w-auto object-contain" />
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-6">
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-2">Sources</h3>
          <div className="space-y-1">
            {sources.map((source) => (
              <SidebarItem 
                key={source.id} 
                icon={source.icon} 
                label={source.label} 
                active={source.active} 
                onClick={() => onSourceClick(source.id)}
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

        {sources.some(s => s.confirmed) && (
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-2">Analysis</h3>
          <div className="px-3 py-3 bg-secondary/50 rounded-xl border border-border">
            {isAnalysing ? (
              <>
                <div className="text-sm font-medium text-foreground mb-2">Analysing your files</div>
                <Progress value={75} className="h-1.5 bg-background mb-2" />
                <p className="text-xs text-muted-foreground">Your originals are not modified</p>
              </>
            ) : (
              <>
                <div className="text-sm font-medium">Preview Mode</div>
                <Progress value={0} className="h-1.5 bg-background mt-2" />
                <p className="text-xs text-muted-foreground mt-2">Awaiting analysis...</p>
              </>
            )}
          </div>
        </div>
        )}
      </div>

      <div className="p-4 border-t border-sidebar-border space-y-1">
        <SidebarItem icon={<Settings className="w-4 h-4" />} label="Settings" disabled={isAnalysing} />
        <SidebarItem icon={<HelpCircle className="w-4 h-4" />} label="Help & Support" disabled={isAnalysing} />
      </div>
    </div>
  );
}

function SidebarItem({ icon, label, active = false, onClick, disabled = false }: { icon: React.ReactNode, label: string, active?: boolean, onClick?: () => void, disabled?: boolean }) {
  return (
    <button 
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors duration-200 ${
        disabled 
          ? 'text-muted-foreground/50 cursor-not-allowed' 
          : active 
            ? 'bg-secondary text-primary font-medium' 
            : 'text-sidebar-foreground hover:bg-sidebar-accent'
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
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
  onViewResults
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
  onViewResults: () => void
}) {
  if (!activeSource) {
     return <EmptyState onAddFirstSource={onAddAnother} />;
  }

  if (isComplete) {
    return <CompletionState results={analysisResults} onAddAnother={onAddAnother} onViewResults={onViewResults} />;
  }

  if (isAnalysing) {
    return <AnalysingState progress={analysisProgress} />;
  }

  if (!activeSource.confirmed) {
    return (
      <ConfirmationPanel 
        source={activeSource} 
        onConfirm={onConfirm} 
        onRemove={onRemove}
        onChange={onChange}
      />
    );
  }

  return <Dashboard sources={sources} activeSource={activeSource} onStartAnalysis={onStartAnalysis} onPreviewChanges={onPreviewChanges} />;
}

function ConfirmationPanel({ source, onConfirm, onRemove, onChange }: { source: Source, onConfirm: () => void, onRemove: () => void, onChange: () => void }) {
  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#F8F9FC] p-8 items-center justify-center">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-2xl w-full"
      >
        <div className="mb-8 text-center">
           <h2 className="text-2xl font-semibold text-foreground mb-2">Confirm Source Selection</h2>
           <p className="text-muted-foreground">These are example results. Your actual analysis will begin after confirmation.</p>
        </div>

        <Card className="p-8 mb-8">
          <div className="flex items-start gap-6 mb-8 border-b border-border pb-8">
            <div className="p-4 bg-secondary/50 rounded-2xl text-primary">
              <Folder className="w-8 h-8" />
            </div>
            <div>
              <h3 className="text-xl font-medium text-foreground mb-1">{source.label}</h3>
              <p className="text-sm text-muted-foreground font-mono bg-muted px-2 py-1 rounded inline-block">
                {source.path || "/Path/To/Selected/Folder"}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-8 mb-8">
            <div>
              <div className="text-sm text-muted-foreground mb-1">Total Files</div>
              <div className="text-2xl font-semibold text-foreground">1,248</div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Photos / Videos</div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FileImage className="w-4 h-4 text-emerald-500" /> 892
                </div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FileVideo className="w-4 h-4 text-blue-500" /> 356
                </div>
              </div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Date Range</div>
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <CalendarRange className="w-4 h-4 text-primary" />
                2018 — 2024
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-4">
             <div className="flex gap-4">
                <Button variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={onRemove}>
                  <Trash2 className="w-4 h-4 mr-2" /> Remove Source
                </Button>
                <Button variant="ghost" className="text-muted-foreground" onClick={onChange}>
                  <RefreshCw className="w-4 h-4 mr-2" /> Change Source
                </Button>
             </div>
             <Button onClick={onConfirm} className="px-8">
               Confirm & Analyze <ChevronRight className="w-4 h-4 ml-2" />
             </Button>
          </div>
        </Card>
      </motion.div>
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
                onClick={onAddFirstSource}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Skip for now
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function AnalysingState({ progress }: { progress: AnalysisProgress }) {
  const percentComplete = Math.round((progress.current / progress.total) * 100);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#F8F9FC]">
      <header className="h-16 border-b border-border bg-background/50 backdrop-blur-sm flex items-center px-8 shrink-0">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <motion.div animate={{ opacity: [0.6, 1, 0.6] }} transition={{ duration: 1.5, repeat: Infinity }}>
            <div className="w-2 h-2 rounded-full bg-primary" />
          </motion.div>
          <span>Analysing your files</span>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center p-8">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-2xl w-full text-center"
        >
          <div className="mb-8">
            <h2 className="text-3xl font-semibold text-foreground mb-3">Analysing your files</h2>
            <p className="text-muted-foreground mb-6">Your originals are not modified. This usually takes a few minutes.</p>
            
            <Card className="p-8 mb-8">
              <div className="mb-8">
                <div className="flex items-baseline justify-between mb-3">
                  <span className="text-sm text-muted-foreground">Progress</span>
                  <span className="text-2xl font-semibold text-foreground">{progress.current} / {progress.total}</span>
                </div>
                <Progress value={percentComplete} className="h-2 bg-background" />
              </div>

              <div className="text-center">
                <p className="text-sm text-muted-foreground mb-1">Processing</p>
                <motion.p 
                  key={progress.currentFile}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="font-mono text-xs text-foreground truncate"
                >
                  {progress.currentFile}
                </motion.p>
              </div>
            </Card>

            <p className="text-xs text-muted-foreground">Do not close this window during analysis</p>
          </div>
        </motion.div>
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

function PreScanConfirmationModal({ source, stats, onConfirm, onCancel }: { source: Source, stats: PreScanStats, onConfirm: () => void, onCancel: () => void }) {
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
        className="bg-background rounded-2xl shadow-2xl max-w-lg w-full p-8 border border-border"
      >
        <div className="mb-8">
          <h2 className="text-2xl font-semibold text-foreground mb-2">Ready to scan?</h2>
          <p className="text-muted-foreground">Here's what we found in your source</p>
        </div>

        <Card className="p-6 mb-6 bg-gradient-to-br from-primary/5 to-secondary/30 border-primary/20">
          <div className="mb-4">
            <h3 className="text-lg font-medium text-foreground mb-1">{source.label}</h3>
            <p className="text-xs text-muted-foreground font-mono break-all">{source.path}</p>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between py-3 border-b border-border/40">
              <div className="flex items-center gap-3">
                <FileImage className="w-4 h-4 text-primary" />
                <span className="text-sm text-foreground font-medium">Total Files</span>
              </div>
              <span className="text-lg font-semibold text-foreground">{stats.totalFiles.toLocaleString()}</span>
            </div>

            <div className="flex items-center justify-between py-3 border-b border-border/40">
              <div className="flex items-center gap-3">
                <FileImage className="w-4 h-4 text-primary" />
                <span className="text-sm text-foreground font-medium">Photos</span>
              </div>
              <span className="text-lg font-semibold text-foreground">{stats.photoCount.toLocaleString()}</span>
            </div>

            <div className="flex items-center justify-between py-3 border-b border-border/40">
              <div className="flex items-center gap-3">
                <FileVideo className="w-4 h-4 text-primary" />
                <span className="text-sm text-foreground font-medium">Videos</span>
              </div>
              <span className="text-lg font-semibold text-foreground">{stats.videoCount.toLocaleString()}</span>
            </div>

            <div className="flex items-center justify-between py-3 border-b border-border/40">
              <div className="flex items-center gap-3">
                <HelpCircle className="w-4 h-4 text-primary" />
                <span className="text-sm text-foreground font-medium">Estimated Size</span>
              </div>
              <span className="text-lg font-semibold text-foreground">{stats.estimatedSizeGB.toFixed(1)} GB</span>
            </div>

            <div className="flex items-center justify-between py-3">
              <div className="flex items-center gap-3">
                <CalendarRange className="w-4 h-4 text-primary" />
                <span className="text-sm text-foreground font-medium">Date Range</span>
              </div>
              <div className="text-right">
                <div className="text-xs text-muted-foreground">{stats.dateRange.earliest}</div>
                <div className="text-xs text-muted-foreground">to</div>
                <div className="text-xs text-muted-foreground">{stats.dateRange.latest}</div>
              </div>
            </div>
          </div>
        </Card>

        <p className="text-xs text-muted-foreground text-center mb-6">
          You can remove or change this source before analysis begins.
        </p>

        <div className="flex gap-3">
          <Button 
            variant="outline" 
            className="flex-1" 
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button 
            className="flex-1 bg-primary hover:bg-primary/90" 
            onClick={onConfirm}
          >
            Start Analysis
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
