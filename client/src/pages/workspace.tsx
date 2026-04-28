import React, { useState, useEffect, useRef } from "react";
import ReactDOM from "react-dom";
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
  ChevronLeft,
  Pin,
  Menu,
  ChevronDown,
  Plus,
  Play,
  Trash2,
  RefreshCw,
  Download,
  FileImage,
  FileVideo,
  CalendarRange,
  FolderOpen,
  Eye,
  X,
  LayoutGrid,
  ArrowRight,
  ArrowLeft,
  Loader2,
  Info,
  Sparkles,
  Users,
  Tag,
  Shield,
  ShieldCheck,
  Wrench,
  Sun,
  Moon,
  FileText,
  Star,
  ExternalLink,
  PlayCircle,
  Copy,
  ZoomIn,
  ZoomOut,
  Search,
  Network,
  Lock
} from "lucide-react";
import { toast } from "sonner";
import { promptConfirm } from "@/components/trees/promptConfirm";
import { Button } from "@/components/ui/custom-button";
import { Card } from "@/components/ui/custom-card";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { motion, AnimatePresence } from "framer-motion";
import { 
  isElectron, 
  openFolderDialog, 
  openZipDialog, 
  runAnalysis, 
  onAnalysisProgress, 
  removeAnalysisProgressListener,
  getSettings,
  setSetting,
  classifyStorage,
  resetSettingsToDefaults,
  PDRSettings,
  formatBytesToGB,
  PreScanResult,
  openPeopleWindow,
  resetTagAnalysis,
  listBackups,
  restoreFromBackup,
  takeSnapshot as takeSnapshotBridge,
  reclusterFaces as reclusterFacesBridge,
  deleteSnapshot as deleteSnapshotBridge,
  exportSnapshotZip as exportSnapshotZipBridge,
  type DbBackup,
  prewarmPersonClusters
} from "@/lib/electron-bridge";
import { useFixInProgress, FIX_BLOCKED_TOOLTIP } from "@/lib/fix-state";
import { NetworkScanModal } from "@/components/NetworkScanModal";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { LicenseModal, LicenseStatusBadge } from "@/components/LicenseModal";
import { LicenseRequiredModal } from "@/components/LicenseRequiredModal";
import { FeatureTeaserModal, type TeaserFeature } from "@/components/FeatureTeaserModal";
import { FolderBrowserModal } from "@/components/FolderBrowserModal";
import DestinationAdvisorModal from "@/components/DestinationAdvisorModal";
import LibraryPlannerModal, { type LibraryPlannerAnswers } from "@/components/LibraryPlannerModal";
import { SearchRibbon } from "@/components/SearchPanel";
import MemoriesView from "@/components/MemoriesView";
import { TreesView } from "@/components/trees/TreesView";
import { ReportProblemModal } from "@/components/ReportProblemModal";
import { useLicense } from "@/contexts/LicenseContext";
import { TourOverlay, TOUR_STEPS, SD_TOUR_STEPS, hasTourBeenCompleted, resetTourCompletion } from "@/components/ui/tour-overlay";
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
  confidenceSummary?: { confirmed: number; recovered: number; marked: number };
  duplicatesRemoved?: number;
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
  /** Files the engine couldn't process (corrupt zip entries, etc.).
   *  Rendered as a warning callout on the "Source added" card so the
   *  user knows which files didn't make it through analysis before
   *  they run the fix. Empty/undefined on a clean run. */
  skippedFiles?: Array<{ filename: string; reason: string }>;
}

export default function Workspace() {
	const [zoomLevel, setZoomLevel] = useState<number>(() => {
  const saved = localStorage.getItem("pdr-zoom-level");
  return saved ? Number(saved) : 100;
});
const MIN_ZOOM = 60;
const MAX_ZOOM = 150;
const ZOOM_STEP = 5;

const applyZoom = (newZoom: number) => {
  setZoomLevel(newZoom);
  localStorage.setItem("pdr-zoom-level", String(newZoom));
  // Zoom is CSS-only on the content area — no Electron setZoomFactor needed
};

const handleZoomIn = () => {
  applyZoom(Math.min(MAX_ZOOM, zoomLevel + ZOOM_STEP));
};

const handleZoomOut = () => {
  applyZoom(Math.max(MIN_ZOOM, zoomLevel - ZOOM_STEP));
};

const handleZoomReset = () => {
  applyZoom(100);
};

// Ctrl+scroll wheel zoom (like browsers and Word) — scoped to the
// Dashboard / Workspace view only. S&D has its own tile-size cycling that
// owns Ctrl+wheel inside its area, so this listener is effectively a no-op
// there because the S&D panel intercepts the event first.
useEffect(() => {
  const handleWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoomLevel(prev => {
      const newZoom = e.deltaY < 0
        ? Math.min(MAX_ZOOM, prev + ZOOM_STEP)
        : Math.max(MIN_ZOOM, prev - ZOOM_STEP);
      if (newZoom !== prev) {
        localStorage.setItem('pdr-zoom-level', String(newZoom));
      }
      return newZoom;
    });
  };
  window.addEventListener('wheel', handleWheel, { passive: false });
  return () => window.removeEventListener('wheel', handleWheel);
}, []);

// People Manager pre-warm. The main-process cache for
// getPersonClusters is refreshed in the background while PDR is open,
// so by the time the user clicks the People Manager button, the
// cluster list is already warm in memory and comes back from the
// first IPC call near-instantly (instead of running the full query
// chain from cold). Fires on mount via requestIdleCallback, then
// repeats every 60s to stay ahead of user mutations that invalidate
// the cache.
useEffect(() => {
  const idle: (cb: () => void) => void = (window as any).requestIdleCallback
    ? (cb) => (window as any).requestIdleCallback(cb, { timeout: 3000 })
    : (cb) => setTimeout(cb, 500);
  let cancelled = false;
  const fire = () => {
    if (cancelled) return;
    idle(() => {
      if (cancelled) return;
      prewarmPersonClusters().catch(() => { /* best-effort; ignore */ });
    });
  };
  fire();
  const interval = setInterval(fire, 60_000);
  return () => { cancelled = true; clearInterval(interval); };
}, []);

// Auto-open People Manager on startup when the user has opted in via
// Settings. Fires once per PDR launch, gated by a session-local
// sessionStorage flag so hot-reloads or route changes during
// development don't re-open the window. Delayed slightly so the main
// window is visible first — avoids a flash of two simultaneously
// appearing windows that feels chaotic.
useEffect(() => {
  const key = 'pdr-people-autoopen-fired';
  if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(key)) return;
  let cancelled = false;
  const timer = setTimeout(async () => {
    if (cancelled) return;
    try {
      const settings = await getSettings();
      if ((settings as any)?.openPeopleOnStartup) {
        try { sessionStorage.setItem(key, '1'); } catch {}
        openPeopleWindow();
      }
    } catch { /* best-effort */ }
  }, 600);
  return () => { cancelled = true; clearTimeout(timer); };
}, []);

  const [location, setLocation] = useLocation();
  // For HashRouter, query params are inside the hash (e.g., #/workspace?tour=true)
  const hashParts = window.location.hash.split('?');
  const searchString = hashParts.length > 1 ? '?' + hashParts[1] : '';
  const searchParams = new URLSearchParams(searchString);
  const folderOrDriveInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const [showSourceTypeSelector, setShowSourceTypeSelector] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ message: 'Preparing analysis...', percent: 0 });
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [lastAnalysisElapsed, setLastAnalysisElapsed] = useState<number | null>(null);
  const analysisStartTimeRef = useRef<number>(0);
  
  const [sources, setSources] = useState<Source[]>(() => {
    // Try localStorage first (persists across sessions), then sessionStorage (legacy fallback)
    const saved = localStorage.getItem("pdr-sources") || sessionStorage.getItem("pdr-sources");
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
    return [];
  });

  // On mount: check rememberSources setting — if OFF, clear persisted sources
  useEffect(() => {
    getSettings().then((settings) => {
      if (!settings.rememberSources) {
        setSources([]);
        localStorage.removeItem("pdr-sources");
        localStorage.removeItem("pdr-source-analysis-results");
        setDestinationPath(null);
        setDestinationFreeGB(0);
        setDestinationTotalGB(0);
      }
    });
  }, []);

  useEffect(() => {
    // Persist sources to localStorage (survives app restarts)
    const serializableSources = sources.map(s => {
      const { icon, ...rest } = s;
      return rest;
    });
    localStorage.setItem("pdr-sources", JSON.stringify(serializableSources));
    // Clean up legacy sessionStorage
    sessionStorage.removeItem("pdr-sources");
  }, [sources]);

  // Listen for reports history event from EmptyState
  useEffect(() => {
    const handleOpenReports = () => setShowReportsList(true);
    window.addEventListener('open-reports-history', handleOpenReports);
    return () => window.removeEventListener('open-reports-history', handleOpenReports);
  }, []);

  // Listen for clear sources event from post-fix prompt
  useEffect(() => {
    const handleClearSources = () => {
      setSources([]);
      localStorage.removeItem("pdr-sources");
      localStorage.removeItem("pdr-source-analysis-results");
      setHasCompletedFix(false);
      pendingSourceClearRef.current = false;
      setDestinationPath(null);
      setDestinationFreeGB(0);
      setDestinationTotalGB(0);
    };
    window.addEventListener('pdr-clear-sources', handleClearSources);
    return () => window.removeEventListener('pdr-clear-sources', handleClearSources);
  }, []);

  const [activeSource, setActiveSource] = useState<Source | null>(null);
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [showCompletionScreen, setShowCompletionScreen] = useState(false);
  const [analysisResults, setAnalysisResults] = useState<AnalysisResults>({ fixed: 0, unchanged: 0, skipped: 0 });
  const [activePanel, setActivePanel] = useState<'getting-started' | 'best-practices' | 'what-next' | 'help-support' | 'about-pdr' | 'search' | null>(null);
  // Top-level "view" currently occupying the main content area. Dashboard is
  // the default (the existing workspace/dashboard hybrid); other options are
  // separate destinations in the sidebar.
  const [activeView, setActiveView] = useState<'dashboard' | 'search' | 'memories' | 'familytree'>('dashboard');
  const [showReportProblem, setShowReportProblem] = useState(false);
  /** Non-null while the user is picking a background image for Trees
   *  via the S&D view. SearchRibbon reads this to show a pick-mode
   *  banner + confirm button; on confirm/cancel we switch back to the
   *  Trees view and clear the pending request. */
  const [pendingBackgroundPick, setPendingBackgroundPick] = useState<{
    kind: 'canvas' | 'card';
    treeId: number;
    treeName: string;
    personId?: number;
    personName?: string;
  } | null>(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [showResultsModal, setShowResultsModal] = useState(false);
  const [showPreScanConfirm, setShowPreScanConfirm] = useState(false);
  const [preScanStats, setPreScanStats] = useState<PreScanStats | null>(null);
  const [pendingSource, setPendingSource] = useState<Source | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress>({ current: 0, total: 0, currentFile: '' });
  const [sourceAnalysisResults, setSourceAnalysisResults] = useState<Record<string, SourceAnalysisResult>>({});

  // On mount: restore cached analysis results from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("pdr-source-analysis-results");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
          setSourceAnalysisResults(parsed);
        }
      } catch (e) {
        console.error("Failed to parse cached analysis results", e);
        localStorage.removeItem("pdr-source-analysis-results");
      }
    }
  }, []);

  // Persist analysis results to localStorage (so Run Fix works after restart)
  useEffect(() => {
    if (Object.keys(sourceAnalysisResults).length > 0) {
      localStorage.setItem("pdr-source-analysis-results", JSON.stringify(sourceAnalysisResults));
    } else {
      localStorage.removeItem("pdr-source-analysis-results");
    }
  }, [sourceAnalysisResults]);

const [showLicenseRequired, setShowLicenseRequired] = useState(false);
const [teaserFeature, setTeaserFeature] = useState<TeaserFeature | null>(null);
const { isLicensed } = useLicense();

const handleLicenseRequired = () => {
  setShowLicenseRequired(true);
};

const handleFeatureLocked = (feature: TeaserFeature) => {
  setTeaserFeature(feature);
};

const handleActivateLicense = () => {
  setShowLicenseRequired(false);
  setTeaserFeature(null);
  setShowLicenseModal(true);
};
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [initialSettingsTab, setInitialSettingsTab] = useState<'general' | 'workspace' | 'sd' | 'people' | 'ai' | 'backup'>('general');

  // PM is always hosted as a separate BrowserWindow. The window is
  // pre-warmed in the background by the main process a few seconds
  // after launch (electron/main.ts → prewarmPeopleWindow), so the
  // sidebar click feels instant — the renderer is already mounted,
  // cluster data is already cached, face crops are already loaded.
  const handleOpenPeople = () => {
    openPeopleWindow();
  };

  // Listen for open-settings events from other windows (e.g., People window)
  useEffect(() => {
    const handler = (_event: any, tab: string) => {
      const validTab = (tab === 'general' || tab === 'workspace' || tab === 'sd' || tab === 'people' || tab === 'ai' || tab === 'backup') ? tab : 'general';
      setInitialSettingsTab(validTab as any);
      setShowSettingsModal(true);
    };
    if ((window as any).pdr?.onOpenSettings) {
      return (window as any).pdr.onOpenSettings(handler);
    }
  }, []);
  const [showLicenseModal, setShowLicenseModal] = useState(false);
  const [showReportsList, setShowReportsList] = useState(false);
  const [showPostFixReport, setShowPostFixReport] = useState(false);
  const [showSlowStorageWarning, setShowSlowStorageWarning] = useState(false);
  const [pendingSlowStoragePath, setPendingSlowStoragePath] = useState<{ path: string; type: 'folder' | 'zip' | 'drive'; storageInfo: { label: string; description: string } } | null>(null);
  const [showNetworkScanModal, setShowNetworkScanModal] = useState(false);
  const [networkScanInfo, setNetworkScanInfo] = useState<{ path: string; type: 'folder' | 'zip'; label: string } | null>(null);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
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
  const [playSound, setPlaySound] = useState(() => {
    const saved = localStorage.getItem('pdr-completion-sound');
    return saved !== 'false'; // Default to true
  });

  // Persistent states that should survive panel navigation
  const [destinationPath, setDestinationPath] = useState<string | null>(null);
  const [destinationFreeGB, setDestinationFreeGB] = useState<number>(0);
  const [destinationTotalGB, setDestinationTotalGB] = useState<number>(0);
  const [hasCompletedFix, setHasCompletedFix] = useState(false);
  const [savedReportId, setSavedReportId] = useState<string | null>(null);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexingProgress, setIndexingProgress] = useState<{ current: number; total: number } | null>(null);
  const [searchDbReady, setSearchDbReady] = useState(false);
  const [searchResultsActive, setSearchResultsActive] = useState(false);
  const [requestSearchClose, setRequestSearchClose] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [showDestBrowser, setShowDestBrowser] = useState(false);
  const [folderBrowserCallback, setFolderBrowserCallback] = useState<((path: string) => void) | null>(null);

  // Auto-index: track which report IDs have already been indexed to avoid re-indexing
  const autoIndexedReportsRef = useRef<Set<string>>(new Set());
  // Whether the current fix run should be added to Search & Discovery
  const addToSDRef = useRef<boolean>(false);

  // Auto-index effect: reacts to savedReportId changes — only indexes if user opted in via S&D prompt
  useEffect(() => {
    if (!savedReportId) return;
    if (autoIndexedReportsRef.current.has(savedReportId)) return;
    autoIndexedReportsRef.current.add(savedReportId);
    // Respect the user's S&D preference — skip indexing if they declined
    if (!addToSDRef.current) {
      console.log('[PDR] Skipping auto-index — user declined S&D for this run');
      return;
    }

    const runAutoIndex = async () => {
      try {
        const { initSearchDatabase, indexFixRun, onSearchIndexProgress, removeSearchIndexProgressListener, startAiProcessing, getAiStats } = await import('@/lib/electron-bridge');
        const initResult = await initSearchDatabase();
        if (!initResult.success) {
          toast.error('Search index unavailable', {
            description: initResult.error || 'Could not initialise search database. You can manually index from the Library Manager.',
            duration: 8000,
          });
          return;
        }
        setIsIndexing(true);
        toast.info('Indexing files for Search & Discovery...', { duration: 3000 });
        onSearchIndexProgress(async (progress: any) => {
          setIndexingProgress({ current: progress.current, total: progress.total });
          if (progress.phase === 'complete') {
            setIsIndexing(false);
            setIndexingProgress(null);
            removeSearchIndexProgressListener();
            toast.success('Files indexed for Search & Discovery', {
              description: `${progress.total.toLocaleString()} files are now searchable.`,
              duration: 4000,
            });
            // Auto-trigger AI tagging if enabled
            try {
              const settings = await getSettings();
              if (settings.aiObjectTagging) {
                const aiStats = await getAiStats();
                if (aiStats.success && aiStats.data && aiStats.data.unprocessed > 0) {
                  console.log('[PDR] Auto-triggering AI tagging for', aiStats.data.unprocessed, 'unprocessed files');
                  startAiProcessing();
                }
              }
            } catch (aiErr) {
              console.warn('[PDR] AI auto-tag check failed:', aiErr);
            }
          }
        });
        // Small delay to ensure report file is fully written to disk
        await new Promise(resolve => setTimeout(resolve, 500));
        const indexResult = await indexFixRun(savedReportId);
        if (!indexResult.success) {
          toast.error('Auto-indexing failed', {
            description: indexResult.error || 'You can manually index from the Library Manager.',
            duration: 8000,
          });
          setIsIndexing(false);
          setIndexingProgress(null);
          removeSearchIndexProgressListener();
        }
      } catch (err) {
        toast.error('Auto-indexing error', {
          description: `${(err as Error).message}. You can manually index from the Library Manager.`,
          duration: 8000,
        });
        setIsIndexing(false);
        setIndexingProgress(null);
      }
    };

    runAutoIndex();
  }, [savedReportId]);

  // Clear sources after fix completes (when clearSourcesAfterFix setting is ON)
  // Deferred: we mark it pending and only actually clear when the user starts a new action
  // (adding a source), NOT while the post-fix dashboard/reports chain is still visible.
  const clearedForReportRef = useRef<Set<string>>(new Set());
  const pendingSourceClearRef = useRef(false);
  useEffect(() => {
    if (!savedReportId) return;
    if (clearedForReportRef.current.has(savedReportId)) return;
    clearedForReportRef.current.add(savedReportId);

    getSettings().then((settings) => {
      if (settings.clearSourcesAfterFix) {
        pendingSourceClearRef.current = true;
      }
    });
  }, [savedReportId]);

  const toggleDarkMode = () => {
    const newValue = !isDarkMode;
    setIsDarkMode(newValue);
    if (newValue) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('pdr-dark-mode', newValue ? 'true' : 'false');
    // Update native title bar colour to match
    (window as any).pdr?.setTitleBarColor(newValue);
  };

  useEffect(() => {
    const savedDarkMode = localStorage.getItem('pdr-dark-mode');
    if (savedDarkMode === 'true') {
      document.documentElement.classList.add('dark');
      setIsDarkMode(true);
      (window as any).pdr?.setTitleBarColor(true);
    }
  }, []);

  // Listen for the license-badge click event fired by the global TitleBar.
  useEffect(() => {
    const handler = () => setShowLicenseModal(true);
    window.addEventListener('pdr:openLicenseModal', handler);
    return () => window.removeEventListener('pdr:openLicenseModal', handler);
  }, []);

  // Background search database init — non-blocking, no UI wait
  useEffect(() => {
    const initDb = async () => {
      try {
        const { initSearchDatabase } = await import('@/lib/electron-bridge');
        const result = await initSearchDatabase();
        if (result.success) setSearchDbReady(true);
      } catch {
        // Silent fail — search will init lazily when opened
      }
    };
    initDb();
  }, []);


  useEffect(() => {
    const params = searchParams;
	
	    // Check for pending source from source-selection page (sessionStorage method)
    const pendingSourceRaw = sessionStorage.getItem('pdr-pending-source');
    if (pendingSourceRaw) {
      sessionStorage.removeItem('pdr-pending-source');
      try {
        const pendingData = JSON.parse(pendingSourceRaw);
        const pendingPath = pendingData.path;
        const pendingType = pendingData.type;
        const exists = sources.some(s => s.path && s.path.toLowerCase() === pendingPath.toLowerCase());
        if (!exists) {
          handleElectronSourceSelected(pendingPath, pendingType);
          return;
        }
      } catch (e) {
        // Failed to parse, continue with URL params check
      }
    }
    
    // Handle tour param - only show if not already completed (first-time users)
    // For explicit replays from Help & Support, resetTourCompletion is called first
    const tourParam = params.get("tour");
    if (tourParam === "true" && !hasTourBeenCompleted()) {
      setShowTour(true);
      setLocation('/workspace');
      return;
    } else if (tourParam === "true") {
      // Already completed, just clear the param
      setLocation('/workspace');
      return;
    }
    
    const panelParam = params.get("panel") as 'getting-started' | 'best-practices' | 'what-next' | 'help-support' | null;
    if (panelParam) {
      setActivePanel(panelParam);
      // Clear URL param after setting panel
      setLocation('/workspace');
      return;
    }
    
    const type = params.get("type") as 'folder' | 'zip' | 'drive';
    const name = params.get("name");
    const path = params.get("path");

    if (type && name && path) {
      const decodedPath = decodeURIComponent(path);
      const exists = sources.some(s => s.path && s.path.toLowerCase() === decodedPath.toLowerCase());
      if (!exists) {
        // Start analysis first, then clear URL params
        handleElectronSourceSelected(decodedPath, type);
        setLocation('/workspace');
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchString, setLocation]);

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
        } else if (source.confidenceSummary) {
          // Use persisted confidence data (e.g. after app restart)
          confirmed += source.confidenceSummary.confirmed;
          recovered += source.confidenceSummary.recovered;
          marked += source.confidenceSummary.marked;
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
    setSourceAnalysisResults(prev => {
      const updated = { ...prev };
      delete updated[activeSource.id];
      return updated;
    });
    setIsComplete(false);
    if (updatedSources.length > 0) {
      updatedSources[0].active = true;
      setActiveSource(updatedSources[0]);
    } else {
      setActiveSource(null);
      // Clear destination when all sources are removed
      setDestinationPath(null);
      setDestinationFreeGB(0);
      setDestinationTotalGB(0);
    }
  };

    const handleChangeSource = () => {
    if (!activeSource) return;
    const updatedSources = sources.filter(s => s.id !== activeSource.id);
    setSources(updatedSources);
    setSourceAnalysisResults(prev => {
      const updated = { ...prev };
      delete updated[activeSource.id];
      return updated;
    });
    setActiveSource(null);
    setIsComplete(false);
    setShowSourceTypeSelector(true);
    // Clear destination when all sources are removed
    if (updatedSources.length === 0) {
      setDestinationPath(null);
      setDestinationFreeGB(0);
      setDestinationTotalGB(0);
    }
  };


  const handleAddSource = () => {
    // If sources are pending clear from a previous fix, clear them now
    if (pendingSourceClearRef.current) {
      pendingSourceClearRef.current = false;
      setSources([]);
      localStorage.removeItem("pdr-sources");
      setSourceAnalysisResults({});
      setHasCompletedFix(false);
      setDestinationPath(null);
      setDestinationFreeGB(0);
      setDestinationTotalGB(0);
    }
    if (isElectron()) {
      // Open unified source browser — handles both folders and archives
      setFolderBrowserCallback(() => (path: string) => {
        handleUnifiedSourceSelected(path);
      });
      setShowFolderBrowser(true);
    } else {
      setShowSourceTypeSelector(true);
    }
  };

const handleSelectSourceType = async (type: 'folderOrDrive' | 'zip') => {
  setShowSourceTypeSelector(false);
  setTimeout(() => {
    if (type === 'folderOrDrive') {
      folderOrDriveInputRef.current?.click();
    } else if (type === 'zip') {
      zipInputRef.current?.click();
    }
  }, 0);
};
  
  const handleElectronSourceSelected = async (sourcePath: string, sourceType: 'folder' | 'zip' | 'drive', skipStorageCheck: boolean = false) => {
  // Check storage speed BEFORE scanning (for sources from interim screen)
  if (sourceType !== 'zip' && !skipStorageCheck) {
    try {
      const settings = await getSettings();
      if (settings.showStoragePerformanceTips) {
        const storageResult = await classifyStorage(sourcePath);
        if (storageResult && !storageResult.isOptimal) {
          setNetworkScanInfo({
            path: sourcePath,
            type: 'folder',
            label: storageResult.label
          });
          setShowNetworkScanModal(true);
          return;
        }
      }
    } catch (e) {
      // If storage check fails, proceed anyway
    }
  }
  
  // Show scanning overlay immediately
  setIsScanning(true);
  setScanProgress({ message: 'Preparing analysis...', percent: 0 });
  analysisStartTimeRef.current = Date.now();

  const isDuplicate = sources.some(s =>
    s.path && s.path.toLowerCase() === sourcePath.toLowerCase()
  );
    if (isDuplicate) {
  setIsScanning(false);
  if (window.pdr?.showMessage) {
    await window.pdr.showMessage('Duplicate Source', 'You already have this source in your Sources Menu.');
  } else {
    toast.error('You already have this source in your Sources Menu');
  }
  return;
}
    
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
    
    let lastPercent = 0;
    onAnalysisProgress((progress) => {
      if (progress.total === 0 && progress.current === 0) {
        // Enumeration phase - show file count, no percentage
        setAnalysisProgress({
          current: 0,
          total: 0,
          currentFile: progress.currentFile
        });
        setScanProgress({ 
          message: progress.currentFile, 
          percent: 0 
        });
        return;
      }
      
      const percent = Math.round((progress.current / progress.total) * 100);
      
      // Extraction phase (scanning with known total) — show real progress bar
      if (progress.phase === 'scanning' && progress.total > 0) {
        setAnalysisProgress({
          current: progress.current,
          total: progress.total,
          currentFile: progress.currentFile
        });
        setScanProgress({ 
          message: progress.currentFile, 
          percent: percent 
        });
        return;
      }
      
      // Analysis phase
      if (percent >= lastPercent) {
        lastPercent = percent;
        setAnalysisProgress({
          current: progress.current,
          total: progress.total,
          currentFile: progress.currentFile
        });
        setScanProgress({ 
          message: `Analyzing ${progress.current.toLocaleString()} of ${progress.total.toLocaleString()} files...`, 
          percent: percent 
        });
      }
    });
    
    let result;
    try {
      result = await runAnalysis(sourcePath, finalType);
      } catch (error) {
        removeAnalysisProgressListener();
        setIsAnalyzing(false);
        setIsScanning(false);
        toast.error('Analysis failed unexpectedly. Please try again.');
        return;
      }
    
    removeAnalysisProgressListener();
    setIsAnalyzing(false);
    setIsScanning(false);
    
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
        },
        // Forward any entries the engine couldn't process so the
        // Source added card can surface them to the user.
        skippedFiles: (analysisData as any).skippedFiles ?? [],
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
        stats,
        confidenceSummary: analysisData.confidenceSummary,
        duplicatesRemoved: analysisData.duplicatesRemoved || 0,
      };
      
      setSourceAnalysisResults(prev => ({ ...prev, [newSource.id]: analysisData }));
      
      const updatedSources = sources.map(s => ({ ...s, active: false }));
      setSources([...updatedSources, newSource]);
      setActiveSource(newSource);
      setPendingSource(newSource);
      setPreScanStats(stats);
      setLastAnalysisElapsed(Math.floor((Date.now() - analysisStartTimeRef.current) / 1000));
      setShowPreScanConfirm(true);
      
      toast.success(`Analyzed ${analysisData.totalFiles.toLocaleString()} files`);
      
      // Play completion sound and flash taskbar if enabled
      const soundEnabled = localStorage.getItem('pdr-completion-sound') !== 'false';
		if (soundEnabled) {
		  const { playCompletionSound, flashTaskbar } = await import('@/lib/electron-bridge');
		  await playCompletionSound();
		  await flashTaskbar();
		}
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
    // This is a fallback for non-Electron - should not be used in production
    toast.error('Source analysis requires the desktop application');
    e.target.value = '';
  };

  const handleZipChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // This is a fallback for non-Electron - should not be used in production
    toast.error('Source analysis requires the desktop application');
    e.target.value = '';
  };

  const handleAddAnother = () => {
    handleAddSource();
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
    setActivePanel(null);
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

const handleFolderBrowserSourceSelected = async (selectedPath: string) => {
    setShowFolderBrowser(false);
    setFolderBrowserCallback(null);

    // Check license first
    if (!isLicensed) {
      setShowLicenseRequired(true);
      return;
    }

    // Check storage speed BEFORE scanning (wrapped in try-catch)
    try {
      const settings = await getSettings();
      if (settings.showStoragePerformanceTips) {
        const storageResult = await classifyStorage(selectedPath);
        if (storageResult && !storageResult.isOptimal) {
          setNetworkScanInfo({
            path: selectedPath,
            type: 'folder',
            label: storageResult.label
          });
          setShowNetworkScanModal(true);
          return;
        }
      }
    } catch (e) {
      // If storage check fails, proceed anyway
    }

    await handleElectronSourceSelected(selectedPath, 'folder');
  };

  // Unified source handler — detects archive vs folder from the selected path
  const handleUnifiedSourceSelected = async (selectedPath: string) => {
    setShowFolderBrowser(false);
    setFolderBrowserCallback(null);

    const ext = selectedPath.toLowerCase().split('.').pop() || '';
    const isArchive = ext === 'zip' || ext === 'rar';

    if (isArchive) {
      // Route through archive handler (license check + storage check + type detection)
      await handleZipBrowserSelect(selectedPath);
    } else {
      // Route through folder handler (license check + storage check)
      await handleFolderBrowserSourceSelected(selectedPath);
    }
  };

const handleTriggerFolderPicker = async () => {
  if (isElectron()) {
    setFolderBrowserCallback(() => (path: string) => {
      handleUnifiedSourceSelected(path);
    });
    setShowFolderBrowser(true);
  } else {
    folderOrDriveInputRef.current?.click();
  }
};

const [showZipBrowser, setShowZipBrowser] = useState(false);

const handleTriggerZipPicker = () => {
  if (isElectron()) {
    // Use unified browser
    setFolderBrowserCallback(() => (path: string) => {
      handleUnifiedSourceSelected(path);
    });
    setShowFolderBrowser(true);
  } else {
    zipInputRef.current?.click();
  }
};

const handleZipBrowserSelect = async (selectedPath: string) => {
  setShowZipBrowser(false);

  // Check license first
  if (!isLicensed) {
    setShowLicenseRequired(true);
    return;
  }

  // Skip storage check for RAR files (they extract to local temp folder)
  const isRar = selectedPath.toLowerCase().endsWith('.rar');

  // Check storage speed BEFORE scanning (wrapped in try-catch)
  if (!isRar) {
    try {
      const settings = await getSettings();
      if (settings.showStoragePerformanceTips) {
        const storageResult = await classifyStorage(selectedPath);
        if (storageResult && !storageResult.isOptimal) {
          setNetworkScanInfo({
            path: selectedPath,
            type: 'zip',
            label: storageResult.label
          });
          setShowNetworkScanModal(true);
          return;
        }
      }
    } catch (e) {
      // If storage check fails, proceed anyway
    }
  }

  await handleElectronSourceSelected(selectedPath, 'zip');
};

const handleSlowStorageContinue = async () => {
  setShowSlowStorageWarning(false);
  if (pendingSlowStoragePath) {
    await handleElectronSourceSelected(pendingSlowStoragePath.path, pendingSlowStoragePath.type);
    setPendingSlowStoragePath(null);
  }
};

const handleSlowStorageCancel = () => {
  setShowSlowStorageWarning(false);
  setPendingSlowStoragePath(null);
};

const handleNetworkScanComplete = async (result: PreScanResult) => {
  setShowNetworkScanModal(false);
  if (networkScanInfo) {
    await handleElectronSourceSelected(networkScanInfo.path, networkScanInfo.type, true);
    setNetworkScanInfo(null);
  }
};

const handleNetworkScanCancel = () => {
  setShowNetworkScanModal(false);
  setNetworkScanInfo(null);
};

const handleNetworkScanProceedWithoutSize = async () => {
  setShowNetworkScanModal(false);
  if (networkScanInfo) {
    await handleElectronSourceSelected(networkScanInfo.path, networkScanInfo.type, true);
    setNetworkScanInfo(null);
  }
};

const handleCancelAnalysis = () => {
  setShowCancelConfirm(true);
};

const handleConfirmCancelAnalysis = async () => {
  setShowCancelConfirm(false);
  // Call IPC to cancel analysis if available
  if (window.pdr?.cancelAnalysis) {
    await window.pdr.cancelAnalysis();
  }
  setIsScanning(false);
  setIsAnalyzing(false);
  removeAnalysisProgressListener();
};

const handleDismissCancelConfirm = () => {
  setShowCancelConfirm(false);
};

// Auto-dismiss cancel confirmation if analysis completes while dialog is showing
useEffect(() => {
  if (showCancelConfirm && !isAnalyzing && !isScanning) {
    setShowCancelConfirm(false);
  }
}, [isAnalyzing, isScanning, showCancelConfirm]);

const isTourPreview = showTour && sources.length === 0;

const tourPlaceholderSource: Source = {
  id: 'tour-example',
  icon: <Folder className="w-4 h-4" />,
  label: 'Example Source',
  type: 'folder',
  path: 'C:/Users/Photos/Family',
  active: true,
  selected: true,
  confirmed: true,
  stats: {
    totalFiles: 1348,
    photoCount: 1206,
    videoCount: 142,
    estimatedSizeGB: 8.4,
    dateRange: { earliest: 'Jan 15, 2019', latest: 'Dec 28, 2024' }
  }
};

const tourPlaceholderAnalysisResults: Record<string, SourceAnalysisResult> = {
  'tour-example': {
    totalFiles: 1348,
    photoCount: 1206,
    videoCount: 142,
    totalSizeBytes: 9019431321,
    duplicatesRemoved: 3,
    duplicateFiles: [],
    dateRange: { earliest: '2019-01-15T10:30:00Z', latest: '2024-12-28T16:45:00Z' },
    confidenceSummary: { confirmed: 1247, recovered: 89, marked: 12 },
    files: [
      ...Array.from({ length: 1247 }, (_, i) => ({
        name: `photo_${i + 1}.jpg`, type: 'photo' as const, size: 4500000,
        dateConfidence: 'confirmed' as const, dateSource: 'EXIF DateTimeOriginal',
        suggestedDate: '2023-06-15T14:30:00Z', suggestedFilename: `2023-06-15_14-30-00_CF.jpg`,
        originalPath: `C:/Users/Photos/Family/photo_${i + 1}.jpg`
      })),
      ...Array.from({ length: 89 }, (_, i) => ({
        name: `IMG_${i + 1}.jpg`, type: 'photo' as const, size: 3800000,
        dateConfidence: 'recovered' as const, dateSource: 'Filename pattern',
        suggestedDate: '2022-03-10T09:15:00Z', suggestedFilename: `2022-03-10_09-15-00_RC.jpg`,
        originalPath: `C:/Users/Photos/Family/IMG_${i + 1}.jpg`
      })),
      ...Array.from({ length: 12 }, (_, i) => ({
        name: `file_${i + 1}.jpg`, type: 'photo' as const, size: 3200000,
        dateConfidence: 'marked' as const, dateSource: 'File modification time',
        suggestedDate: '2021-11-20T18:00:00Z', suggestedFilename: `2021-11-20_18-00-00_MK.jpg`,
        originalPath: `C:/Users/Photos/Family/file_${i + 1}.jpg`
      }))
    ]
  } as unknown as SourceAnalysisResult
};

return (
  <>
    {/* Portal anchor for the Fix-in-progress chip. Lives at the very
        top of the workspace render tree, OUTSIDE the zoomable
        wrapper that gets display:none-hidden when the user is on
        Memories / Trees. The FixProgressModal uses createPortal to
        mount its compact chip here, so the chip stays visible no
        matter which view is active. */}
    <div id="pdr-fix-chip-portal" />

    {/* Zoom controls — vertical pill at bottom-right. Only affects the
        Dashboard / Workspace zoomable content (via CSS `zoom` on that
        container). S&D has its own independent tile-size zoom. Hidden
        while S&D results own the main area and while non-zoomable views
        (Memories, Trees) are active, to avoid the impression of
        controlling something you're not looking at. */}
    {activeView === 'dashboard' && !searchResultsActive && (
      <div className="fixed right-5 bottom-24 z-40 flex flex-col items-center gap-1 bg-background/90 backdrop-blur-sm border border-border/30 rounded-xl p-1.5 shadow-md opacity-80 hover:opacity-100 hover:shadow-lg hover:-translate-y-0.5 transition-all duration-300 ease-out">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleZoomIn}
                disabled={zoomLevel >= MAX_ZOOM}
                className="flex items-center justify-center w-7 h-7 rounded-lg bg-secondary/50 hover:bg-primary/15 text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-all duration-200"
                data-testid="button-zoom-in"
                aria-label="Zoom in"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">
              <p>Zoom in</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleZoomReset}
                className="flex items-center justify-center w-7 h-5 text-[10px] font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-all duration-200"
                data-testid="button-zoom-reset"
                aria-label="Reset zoom to 100%"
              >
                {zoomLevel}%
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">
              <p>Reset to 100%</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleZoomOut}
                disabled={zoomLevel <= MIN_ZOOM}
                className="flex items-center justify-center w-7 h-7 rounded-lg bg-secondary/50 hover:bg-primary/15 text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-all duration-200"
                data-testid="button-zoom-out"
                aria-label="Zoom out"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">
              <p>Zoom out</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    )}

    {/* Main workspace layout */}
    <div className="flex flex-col h-full bg-background overflow-hidden font-sans">
      <div className="flex flex-1 overflow-hidden">

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
		  sources={isTourPreview ? [tourPlaceholderSource] : sources} 
		  onSourceClick={handleSourceClick} 
		  onSelectAll={handleSelectAll}
		  isComplete={isTourPreview ? true : isComplete}
		  onAddSource={handleAddSource}
		  onStartTour={() => { resetTourCompletion(); setShowTour(true); }}
		  onRemoveSource={() => {
			const selectedIds = sources.filter(s => s.selected).map(s => s.id);
			const updatedSources = sources.filter(s => !s.selected);
			setSources(updatedSources);
			setActiveSource(null);
			
			// Clean up analysis results for removed sources
			setSourceAnalysisResults(prev => {
			  const updated = { ...prev };
			  selectedIds.forEach(id => delete updated[id]);
			  return updated;
			});
		  }}
		  activePanel={activePanel}
		  onPanelChange={(panel) => setActivePanel(panel as 'getting-started' | 'best-practices' | 'what-next' | 'help-support' | 'about-pdr' | null)}
		  onDashboardClick={() => {
			setActivePanel(null);
			setActiveView('dashboard');
			const updatedSources = sources.map(s => ({ ...s, active: false }));
			setSources(updatedSources);
			setActiveSource(null);
			// Close S&D search results if active
			if (searchResultsActive) {
			  setRequestSearchClose(true);
			  setTimeout(() => setRequestSearchClose(false), 100);
			}
		  }}
		  activeView={activeView}
		  onViewChange={(view) => {
			setActivePanel(null);
			setActiveView(view);
			// Leaving the S&D view — close its results so the sidebar doesn't
			// stay in the "search-active" collapsed state.
			if (view !== 'search' && searchResultsActive) {
			  setRequestSearchClose(true);
			  setTimeout(() => setRequestSearchClose(false), 100);
			}
		  }}
		  onSettingsClick={() => setShowSettingsModal(true)}
		  isLicensed={isLicensed}
		  onLicenseRequired={handleLicenseRequired}
		  onFeatureLocked={handleFeatureLocked}
		  onNavigateToBestPractices={() => setActivePanel('best-practices')}
		  searchResultsActive={searchResultsActive}
		  onOpenPeople={handleOpenPeople}
		/>
      {/* Right-side content area: ribbon + panels */}
      <div className="flex-1 flex flex-col h-full min-w-0">
        {/* Search Ribbon — only visible inside the S&D view. Kept mounted
            (display: none when hidden) so filter state is preserved between
            view switches. Loses pin/colour state otherwise would be lost if
            the user bounces through Dashboard → Memories → back to S&D. */}
        <div
          className={`relative z-30 flex flex-col min-w-0 ${activeView === 'search' ? (searchResultsActive ? 'flex-1 overflow-hidden' : 'shrink-0') : ''}`}
          style={{
            overflow: activeView === 'search' ? (searchResultsActive ? undefined : 'visible') : 'hidden',
            display: activeView === 'search' ? 'flex' : 'none',
          }}
        >
          <SearchRibbon
            isIndexing={isIndexing}
            indexingProgress={indexingProgress}
            searchDbReady={searchDbReady}
            zoomLevel={100}
            isDarkMode={isDarkMode}
            onToggleDarkMode={toggleDarkMode}
            licenseStatusBadge={<LicenseStatusBadge onClick={() => setShowLicenseModal(true)} />}
            onSearchActiveChange={setSearchResultsActive}
            requestClose={requestSearchClose}
            hasSources={sources.length > 0}
            showLibraryManager={localStorage.getItem('pdr-show-library-manager') === 'true'}
            pickMode={pendingBackgroundPick}
            onPickCancel={() => {
              setPendingBackgroundPick(null);
              setActiveView('familytree');
            }}
            onPickConfirm={async (filePath: string) => {
              if (!pendingBackgroundPick) return;
              const { getThumbnail, updateSavedTree, setPersonCardBackground } = await import('@/lib/electron-bridge');
              const thumb = await getThumbnail(filePath, 1600);
              if (!thumb.success || !thumb.dataUrl) return;
              if (pendingBackgroundPick.kind === 'canvas') {
                await updateSavedTree(pendingBackgroundPick.treeId, { backgroundImage: thumb.dataUrl });
              } else if (pendingBackgroundPick.kind === 'card' && pendingBackgroundPick.personId != null) {
                await setPersonCardBackground(pendingBackgroundPick.personId, thumb.dataUrl);
              }
              setPendingBackgroundPick(null);
              setActiveView('familytree');
            }}
          />
        </div>

        {/* Zoomable content area — only this part scales, hidden when S&D
            results are actively showing OR when a non-dashboard view owns
            the main area (Memories, Family Tree). CSS zoom applies only to
            Dashboard / Workspace content so S&D is never affected. */}
        <div
          className={`flex-1 overflow-auto relative ${(activeView === 'search' && searchResultsActive) || activeView === 'memories' || activeView === 'familytree' ? 'hidden' : ''}`}
          style={{ zoom: zoomLevel / 100 }}
        >
        {/* MainContent is now ALWAYS mounted (just visually hidden
            when an info panel takes over) so any in-flight Fix
            keeps its state — the FixProgressModal and its IPC
            callbacks live inside DashboardPanel, and unmounting
            mid-fix would break the progress tracking + lose the
            completion screen. The PanelPlaceholder simply overlays
            on top when activePanel is set. */}
        <div style={{ display: activePanel ? 'none' : undefined }}>
          <MainContent
            sources={isTourPreview ? [tourPlaceholderSource] : sources}
            activeSource={activeSource}
            onRemove={handleRemoveSource}
            onChange={handleChangeSource}
            isComplete={isTourPreview ? true : isComplete}
            analysisResults={isTourPreview ? { fixed: 1336, unchanged: 12, skipped: 0 } : analysisResults}
            sourceAnalysisResults={isTourPreview ? tourPlaceholderAnalysisResults : sourceAnalysisResults}
            onAddAnother={handleAddAnother}
            onPreviewChanges={() => setShowPreviewModal(true)}
            onViewResults={() => setShowResultsModal(true)}
            onAddFolder={handleTriggerFolderPicker}
            onAddZip={handleTriggerZipPicker}
            showCompletionScreen={showCompletionScreen}
            onDismissCompletion={() => setShowCompletionScreen(false)}
            onNavigateToBestPractices={() => setActivePanel('best-practices')}
            destinationPath={destinationPath}
            setDestinationPath={setDestinationPath}
            destinationFreeGB={destinationFreeGB}
            setDestinationFreeGB={setDestinationFreeGB}
            destinationTotalGB={destinationTotalGB}
            setDestinationTotalGB={setDestinationTotalGB}
            hasCompletedFix={hasCompletedFix}
            setHasCompletedFix={setHasCompletedFix}
            savedReportId={savedReportId}
            setSavedReportId={setSavedReportId}
            addToSDRef={addToSDRef}
            isLicensed={isLicensed}
            onActivateLicense={handleActivateLicense}
            zoomLevel={zoomLevel}
          />
        </div>
        {activePanel && (
          <PanelPlaceholder
            panelType={activePanel}
            onBackToWorkspace={() => setActivePanel(null)}
            onNavigateToPanel={(panel) => setActivePanel(panel as 'getting-started' | 'best-practices' | 'what-next' | 'help-support')}
            onStartTour={() => { setActivePanel(null); resetTourCompletion(); setShowTour(true); }}
            onReportProblem={() => setShowReportProblem(true)}
          />
        )}
        </div>{/* close zoomable content wrapper */}

        {/* Memories view */}
        {activeView === 'memories' && <MemoriesView />}

        {/* Trees view — family graph explorer (v1). Deliberately not called
            'Family Tree' because later versions will handle friend groups,
            work colleagues, and any other relationships — not just kin. */}
        {activeView === 'familytree' && (
          <TreesView
            onRequestCanvasBackgroundPick={({ treeId, treeName }) => {
              setPendingBackgroundPick({ kind: 'canvas', treeId, treeName });
              setActiveView('search');
            }}
            onRequestCardBackgroundPick={({ treeId, treeName, personId, personName }) => {
              setPendingBackgroundPick({ kind: 'card', treeId, treeName, personId, personName });
              setActiveView('search');
            }}
          />
        )}

      </div>
      </div>{/* close inner flex row */}
	  {isScanning && <ScanningOverlay message={scanProgress.message} percent={scanProgress.percent} onCancel={handleCancelAnalysis} showCancelConfirm={showCancelConfirm} onConfirmCancel={handleConfirmCancelAnalysis} onDismissCancel={handleDismissCancelConfirm} />}
      {showPreviewModal && <PreviewModal onClose={() => setShowPreviewModal(false)} results={analysisResults} fileResults={sourceAnalysisResults} />}
      {showResultsModal && <ResultsModal onClose={() => setShowResultsModal(false)} />}
      {showLicenseModal && <LicenseModal onClose={() => setShowLicenseModal(false)} />}
		<LicenseRequiredModal
		  isOpen={showLicenseRequired}
		  onClose={() => setShowLicenseRequired(false)}
		  onActivate={handleActivateLicense}
		  feature="add sources"
		/>
		<FeatureTeaserModal
		  feature={teaserFeature}
		  onClose={() => setTeaserFeature(null)}
		  onActivate={handleActivateLicense}
		/>
      {/* Custom Folder Browser for source selection */}
      <FolderBrowserModal
        isOpen={showFolderBrowser}
        onSelect={(path) => {
          setShowFolderBrowser(false);
          if (folderBrowserCallback) {
            folderBrowserCallback(path);
            setFolderBrowserCallback(null);
          }
        }}
        onCancel={() => { setShowFolderBrowser(false); setFolderBrowserCallback(null); }}
        title="Add Source"
        mode="source"
      />

      {showReportProblem && (
        <ReportProblemModal onClose={() => setShowReportProblem(false)} />
      )}

      {showSettingsModal && (
		<SettingsModal
		  initialTab={initialSettingsTab}
		  onClose={() => setShowSettingsModal(false)}
		  folderStructure={folderStructure}
		  onFolderStructureChange={(value) => {
			setFolderStructure(value);
			localStorage.setItem('pdr-folder-structure', value);
		  }}
		  playSound={playSound}
		  onPlaySoundChange={(value) => {
			setPlaySound(value);
			localStorage.setItem('pdr-completion-sound', value ? 'true' : 'false');
		  }}
		/>
      )}
	        
		{showReportsList && (
		  <ReportsListModal 
			onClose={() => setShowReportsList(false)}
			onViewReport={(reportId) => {
			  setSelectedReportId(reportId);
			  setShowReportsList(false);
			  setShowPostFixReport(true);
			}}
		  />
		)}

		{showPostFixReport && (
		  <PostFixReportModal 
			onClose={() => {
			  setShowPostFixReport(false);
			  setSelectedReportId(null);
			}}
			results={analysisResults}
			destinationPath={destinationPath}
			fileResults={sourceAnalysisResults}
			savedReportId={selectedReportId}
			onBackToReports={() => {
			  setShowPostFixReport(false);
			  setSelectedReportId(null);
			  setShowReportsList(true);
			}}
			onNavigateToBestPractices={() => setActivePanel('best-practices')}
		  />
		)}
      
      {/* Theme toggle and license badge are now in the ribbon tab bar */}
      
      {showPreScanConfirm && pendingSource && preScanStats && (
		<SourceAddedModal 
		  source={pendingSource}
		  stats={preScanStats}
		  analysisElapsed={lastAnalysisElapsed}
		  onAddToWorkspace={handleAddToWorkspace}
		  onChangeSource={handleChangeSourceFromModal}
		  onCancel={handleCancelSourceSelection}
		  onAddFolder={() => { handleAddToWorkspace(); handleTriggerFolderPicker(); }}
		  onAddZip={() => { handleAddToWorkspace(); handleTriggerZipPicker(); }}
		  isLicensed={isLicensed}
		  onLicenseRequired={handleLicenseRequired}
		/>
      )}

      
      {showSourceTypeSelector && (
        <div className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50">
          <Card className="w-96 p-6">
            <h2 className="text-xl font-semibold text-foreground mb-4 text-center">Select Source Type</h2>
            <div className="space-y-3">
              <button
                onClick={() => handleSelectSourceType('folderOrDrive')}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary hover:bg-secondary/30 transition-colors text-left"
              >
                <img src="./assets//pdr-folder.png" className="w-5 h-5 object-contain" alt="Folder" />
                <div>
                  <div className="font-medium text-foreground">Add Folder or Drive</div>
                  <div className="text-xs text-muted-foreground">Select a folder or scan a drive</div>
                </div>
              </button>
              <button
                onClick={() => handleSelectSourceType('zip')}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary hover:bg-secondary/30 transition-colors text-left"
              >
                <img src="./assets//pdr-zip.png" className="w-5 h-5 object-contain" alt="ZIP/RAR" />
                <div>
                  <div className="font-medium text-foreground">Add ZIP/RAR Archive</div>
                  <div className="text-xs text-muted-foreground">Import a .zip or .rar file</div>
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

      {/* Network Scan Modal */}
      {showNetworkScanModal && networkScanInfo && (
        <NetworkScanModal
          sourcePath={networkScanInfo.path}
          sourceType={networkScanInfo.type}
          storageLabel={networkScanInfo.label}
          sourceName={networkScanInfo.path.split(/[/\\]/).pop() || 'Selected Source'}
          onComplete={handleNetworkScanComplete}
          onCancel={handleNetworkScanCancel}
          onProceedWithoutSize={handleNetworkScanProceedWithoutSize}
        />
      )}
      
      <TourOverlay
        steps={searchResultsActive ? SD_TOUR_STEPS : TOUR_STEPS}
        isOpen={showTour}
        onClose={() => setShowTour(false)}
        onComplete={() => setShowTour(false)}
      />
    </div>
  </>
  );
}


type ActiveView = 'dashboard' | 'search' | 'memories' | 'familytree';

function Sidebar({ sources, onSourceClick, onSelectAll, isComplete, onAddSource, onRemoveSource, activePanel, onPanelChange, onDashboardClick, onSettingsClick, onStartTour, isLicensed, onLicenseRequired, onFeatureLocked, onNavigateToBestPractices, searchResultsActive, activeView, onViewChange, onOpenPeople }: { sources: Source[], onSourceClick: (id: string, shiftKey: boolean) => void, onSelectAll: (checked: boolean) => void, isComplete: boolean, onAddSource: () => void, onRemoveSource: () => void, activePanel: string | null, onPanelChange: (panel: string | null) => void, onDashboardClick: () => void, onSettingsClick: () => void, onStartTour: () => void, isLicensed: boolean, onLicenseRequired: () => void, onFeatureLocked: (feature: TeaserFeature) => void, onNavigateToBestPractices?: () => void, searchResultsActive?: boolean, activeView?: ActiveView, onViewChange?: (view: ActiveView) => void, onOpenPeople: () => void }) {
  const allSelected = sources.length > 0 && sources.every(s => s.selected);
  const someSelected = sources.some(s => s.selected) && !allSelected;
  const hasSelectedSources = sources.some(s => s.selected);

  // Gate Add Source / Remove during a Fix — adding sources mid-fix
  // would kick off a fresh analysis IPC that competes with the fix
  // engine for CPU + the same analysis worker, and removing sources
  // could change what's queued in flight. Sourced from the
  // cross-window broadcast so any window's fix flips the gate.
  const fixActive = useFixInProgress();

  // Default sidebar width bumped +10% (280 → 308) so Add Source /
  // Remove don't look squashed out of the gate. User can still drag
  // the resize handle to whatever they prefer — this only sets the
  // initial value for a fresh session.
  const [width, setWidth] = useState(308);
  const [isResizing, setIsResizing] = useState(false);

  // Pin state — user's EXPLICIT pin intent, only changed by the pin
  // button. 'auto' = follow searchResultsActive + view, 'open' =
  // always open, 'closed' = always collapsed.
  const [pinState, setPinState] = useState<'auto' | 'open' | 'closed'>('auto');
  const setPinStatePersisted = (state: 'auto' | 'open' | 'closed') => {
    setPinState(state);
  };

  // Session-local "temporarily expanded" flag set by the menu button
  // in the collapsed sidebar. The menu button used to flip pinState
  // to 'open', which silently pinned the sidebar. That was wrong —
  // the pin should only flip when the user ACTUALLY clicks the pin.
  // Instead the menu button just expands for the current view, and
  // we reset the flag whenever the active view changes so the
  // expansion doesn't bleed into views that auto-collapse.
  const [tempExpanded, setTempExpanded] = useState(false);
  useEffect(() => { setTempExpanded(false); }, [activeView, searchResultsActive]);
  // Clean up any stale persisted key from previous versions
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.removeItem('pdr-sidebar-pin');
  }, []);
  // Compute collapsed state. In 'auto' mode the sidebar collapses when
  // S&D results are showing OR when a full-canvas view (Trees,
  // Memories) owns the main area — all three benefit from every
  // horizontal pixel for content.
  const collapsed = pinState === 'closed'
    ? true
    : pinState === 'open'
    ? false
    : tempExpanded
    ? false
    : (!!searchResultsActive
       || activeView === 'familytree'
       || activeView === 'memories'
       || activeView === 'search');

  // Section-collapse state for Views / Tools / Guidance. Session-only so
  // the sidebar always opens fully expanded in a fresh session. User can
  // override via the chevron on each section header.
  const [viewsCollapsed, setViewsCollapsed] = useState(false);
  const [toolsCollapsed, setToolsCollapsed] = useState(false);
  const [guidanceCollapsed, setGuidanceCollapsed] = useState(false);
  const [appCollapsed, setAppCollapsed] = useState(false);
  const [userOverrode, setUserOverrode] = useState<{ views: boolean; tools: boolean; guidance: boolean; app: boolean }>({ views: false, tools: false, guidance: false, app: false });

  // Reset the user-override flags whenever a NEW source is added.
  // Without this, expanding a section manually latches forever —
  // adding more sources afterwards would no longer collapse it, the
  // list overflows, and the Add Source button gets pushed off-screen
  // behind a scrollbar. Adding a source is a strong signal that the
  // user wants more Source-menu room, so we re-enable auto-fold to
  // let the pressure algorithm below decide again.
  const lastSourceCountRef = useRef(sources.length);
  useEffect(() => {
    if (sources.length > lastSourceCountRef.current) {
      setUserOverrode({ views: false, tools: false, guidance: false, app: false });
    }
    lastSourceCountRef.current = sources.length;
  }, [sources.length]);

  // Auto-collapse the lower sidebar sections under height pressure so
  // the Source Menu always has room for its contents WITHOUT forcing
  // the user to scroll. Two inputs drive this:
  //   • Window height — short displays fold sections earlier.
  //   • Source count — each new source adds a row to the top list;
  //     once the list grows past the comfortable fit for the current
  //     height we fold lower sections pre-emptively to make room.
  //
  // Fold priority, least-important first: App → Guidance → Tools →
  // Views. Views is the primary navigation so it folds last. Source
  // Menu has its own min-height so it can't be squeezed to zero.
  //
  // Respects user-override: once the user manually opens a section
  // we stop auto-folding it for the session.
  useEffect(() => {
    const autoAdjust = () => {
      const h = window.innerHeight;
      const n = sources.length;

      // Each source row ~32 px. Estimate how many rows fit before we'd
      // need the scrollbar with each lower section expanded — fold the
      // next section before that threshold.
      // Rough source-count thresholds at 900 px window height, scaled
      // by (h / 900) so taller windows tolerate more sources before
      // any folding, shorter windows fold sooner.
      const scale = Math.max(0.6, Math.min(1.4, h / 900));
      const foldAppAt       = Math.round(3 * scale);
      const foldGuidanceAt  = Math.round(5 * scale);
      const foldToolsAt     = Math.round(7 * scale);
      const foldViewsAt     = Math.round(10 * scale);

      if (!userOverrode.app)      setAppCollapsed(h < 900 || n >= foldAppAt);
      if (!userOverrode.guidance) setGuidanceCollapsed(h < 820 || n >= foldGuidanceAt);
      if (!userOverrode.tools)    setToolsCollapsed(h < 740 || n >= foldToolsAt);
      if (!userOverrode.views)    setViewsCollapsed(n >= foldViewsAt);
    };
    autoAdjust();
    window.addEventListener('resize', autoAdjust);
    return () => window.removeEventListener('resize', autoAdjust);
  }, [userOverrode, sources.length]);
  const effectiveWidth = collapsed ? 48 : width;

  // Sync sidebar width to CSS custom property so TitleBar can track it
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-width', `${effectiveWidth}px`);
  }, [effectiveWidth]);

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

  if (collapsed) {
    // Helper: gate a click on the licence state for the items that
    // live behind the paywall. Matches the expanded sidebar's gating
    // so the user's experience doesn't change based on sidebar width.
    const gateLocked = (feature: TeaserFeature, onClickIfOk: () => void) => () => {
      if (!isLicensed) { onFeatureLocked(feature); return; }
      onClickIfOk();
    };
    const iconBtn = (
      title: string,
      icon: React.ReactNode,
      onClick: () => void,
      locked: boolean = false,
      active: boolean = false,
    ) => (
      <IconTooltip label={title + (locked ? ' (Premium feature)' : '')} side="right">
        <button
          onClick={onClick}
          className={`w-9 h-9 flex items-center justify-center transition-colors relative ${
            active
              // Active app: solid amber-tinted rounded square (rounded-md
              // is a proper square with softened edges; previously this
              // used ring-2 which read as a circle because of how the
              // stroke wrapped the small icon at this size).
              ? 'bg-amber-500/20 border border-amber-500/60 rounded-md text-foreground'
              : 'hover:bg-secondary/60 rounded-lg text-muted-foreground hover:text-foreground'
          }`}
        >
          {icon}
          {locked && <Lock className="absolute top-0.5 right-0.5 w-2 h-2 text-muted-foreground/60" />}
        </button>
      </IconTooltip>
    );
    // Active-app resolution: activePanel (guidance pages) wins over
    // activeView (main canvas views) because opening a panel overlays
    // the canvas. Dashboard/Workspace is active only when no panel is
    // open and the active view is 'dashboard'.
    const isActiveView = (v: string) => activePanel == null && activeView === v;
    const isActivePanel = (p: string) => activePanel === p;
    const divider = <div className="w-7 border-t-2 border-border my-1.5" />;
    return (
      <div
        data-tour="sd-sidebar-collapse"
        className="bg-sidebar border-r flex flex-col h-full shrink-0 z-20 relative sidebar-container items-center py-3 gap-1 sidebar-animated overflow-y-auto"
        style={{ width: '48px' }}
      >
        {/* Expand button — must ALWAYS expand the sidebar, including
            when the user previously hit the chevron to collapse
            (pinState === 'closed'). Without this reset, clicking the
            burger did nothing because 'closed' beats tempExpanded in
            the collapse logic. Sets pinState back to 'auto' (undoes
            an explicit collapse) AND flips tempExpanded so auto-
            collapse views (Memories/Trees/S&D) still open. The pin
            button remains the only way to ACTIVATE 'open' — this
            button only ever moves pinState towards auto. */}
        <IconTooltip label="Show Source Menu" side="right">
          <button
            onClick={() => {
              if (pinState === 'closed') setPinStatePersisted('auto');
              setTempExpanded(true);
            }}
            className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Menu className="w-4 h-4" />
          </button>
        </IconTooltip>

        {divider}

        {/* VIEWS (Dashboard, S&D, Memories, Trees) + TOOLS (People
            Manager) — same order as the expanded sidebar so the icon
            positions stay stable when the user collapses/expands. */}
        {iconBtn(
          sources.length > 0 ? 'Dashboard' : 'Workspace',
          <img src="./assets//pdr-workspace.png" className="w-4 h-4 object-contain" alt="" />,
          gateLocked('dashboard', () => onDashboardClick()),
          sources.length > 0 && !isLicensed,
          isActiveView('dashboard'),
        )}
        {iconBtn(
          'Search & Discovery',
          <Search className="w-4 h-4 opacity-70" />,
          gateLocked('search-discovery', () => onViewChange?.('search')),
          !isLicensed,
          isActiveView('search'),
        )}
        {iconBtn(
          'Memories',
          <CalendarRange className="w-4 h-4 opacity-70" />,
          gateLocked('memories', () => onViewChange?.('memories')),
          !isLicensed,
          isActiveView('memories'),
        )}
        {iconBtn(
          'Trees',
          <Network className="w-4 h-4 opacity-70" />,
          gateLocked('trees', () => onViewChange?.('familytree')),
          !isLicensed,
          isActiveView('familytree'),
        )}
        {iconBtn(
          'People Manager',
          <Users className="w-4 h-4 text-purple-500" />,
          gateLocked('people-manager', () => onOpenPeople()),
          !isLicensed,
          // People Manager opens in a separate window (or toggles the
          // docked drawer). We don't track drawer state here, so no
          // active-highlight state is surfaced to the icon button.
        )}

        {/* Flex spacer — pushes Guidance + App groups to the bottom of
            the sidebar so they're not visually bunched up against the
            primary Apps / Tools at the top. Mirrors the expanded
            sidebar's feel where Settings / About / Help sit at the
            bottom of the column. */}
        <div className="flex-1" />

        {divider}

        {/* GUIDANCE */}
        {iconBtn('Quick Tour', <PlayCircle className="w-4 h-4 opacity-70" />, onStartTour)}
        {iconBtn(
          'Getting Started',
          <img src="./assets//pdr-getting-started.png" className="w-4 h-4 object-contain" alt="" />,
          () => onPanelChange('getting-started'),
          false,
          isActivePanel('getting-started'),
        )}
        {iconBtn(
          'Best Practices',
          <img src="./assets//pdr-best-practices.png" className="w-4 h-4 object-contain" alt="" />,
          () => onPanelChange('best-practices'),
          false,
          isActivePanel('best-practices'),
        )}
        {iconBtn(
          'What Happens Next',
          <img src="./assets//pdr-what-happens-next.png" className="w-4 h-4 object-contain" alt="" />,
          () => onPanelChange('what-next'),
          false,
          isActivePanel('what-next'),
        )}

        {divider}

        {/* APP */}
        {iconBtn(
          'Settings',
          <img src="./assets//pdr-settings.png" className="w-4 h-4 object-contain" alt="" />,
          onSettingsClick,
        )}
        {iconBtn(
          'About PDR',
          <Info className="w-4 h-4 opacity-60" />,
          () => onPanelChange('about-pdr'),
          false,
          isActivePanel('about-pdr'),
        )}
        {iconBtn(
          'Help & Support',
          <img src="./assets//pdr-help&support.png" className="w-4 h-4 object-contain" alt="" />,
          () => onPanelChange('help-support'),
          false,
          isActivePanel('help-support'),
        )}
      </div>
    );
  }

  return (
    <div
      className="bg-sidebar border-r flex flex-col h-full shrink-0 z-20 relative sidebar-container sidebar-animated"
      style={{ width: `${width}px` }}
    >
      {/* Pin / collapse controls — icons sized up from 3.5 to 4, padding
          bumped from 1 to 1.5, and unpinned state promoted from 60% to
          90% muted-foreground so they read more strongly at a glance.
          Also adds a soft border so the click target is visible even
          against similar-shade backgrounds. */}
      <div className="absolute top-2 right-2 z-30 flex items-center gap-1">
        <IconTooltip label={pinState === 'open' ? 'Pinned open — click to unpin (follow S&D)' : 'Pin sidebar open (stay open during S&D)'} side="bottom">
          <button
            onClick={() => setPinStatePersisted(pinState === 'open' ? 'auto' : 'open')}
            className={`p-1.5 rounded-md border transition-colors ${
              pinState === 'open'
                ? 'bg-primary/15 text-primary border-primary/50 ring-1 ring-primary/40'
                : 'text-muted-foreground border-border/60 hover:bg-secondary/60 hover:text-foreground hover:border-border'
            }`}
          >
            <Pin className="w-4 h-4" />
          </button>
        </IconTooltip>
        <IconTooltip label="Collapse sidebar" side="bottom">
          <button
            onClick={() => setPinStatePersisted('closed')}
            className="p-1.5 rounded-md border border-border/60 text-muted-foreground hover:bg-secondary/60 hover:text-foreground hover:border-border transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </IconTooltip>
      </div>

      <div 
        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors z-50 group"
        onMouseDown={(e) => {
          e.preventDefault();
          setIsResizing(true);
        }}
      >
        <div className="absolute right-0 top-0 bottom-0 w-4 -mr-2 bg-transparent group-hover:bg-primary/10 transition-colors" />
      </div>

      <div className="px-6 py-6 flex justify-center cursor-pointer" onClick={() => onDashboardClick()}>
        <div className="flex flex-col items-center">
          <img src="./assets//pdr-logo_transparent.png" alt="Photo Date Rescue" className="h-10 w-auto object-contain" />
          <span className="text-foreground font-bold text-sm tracking-widest mt-1.5">PDR</span>
        </div>
      </div>

      <div className="flex-1 min-h-[180px] overflow-y-auto px-4 py-2 space-y-6">
        {/* MENU / SOURCES SECTION — sits at the top of the sidebar directly
            below the PDR logo. Header renames to 'Source Menu' once the user
            adds sources, otherwise it reads 'Menu' to match the fact that
            only the Add Source / Remove controls are visible. */}
        <div data-tour="sources-panel">
          <div className="flex items-center justify-between mb-3 px-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              {sources.length > 0 ? 'Source Menu' : 'Menu'}
            </h3>
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
            <IconTooltip
              label={fixActive ? FIX_BLOCKED_TOOLTIP + ' — analysing a new source mid-fix would compete with the engine.' : 'Add a folder, drive or zip as a source for PDR'}
              side="top"
            >
              <Button
                size="sm"
                className="flex-1 justify-center gap-2 shadow-md shadow-primary/20 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={onAddSource}
                disabled={fixActive}
                data-tour="add-source"
                style={isLicensed && sources.length === 0 && !fixActive ? { animation: 'outline-pulse 2s ease-in-out infinite' } : undefined}
              >
                <img src="./assets//pdr-add-source.png" className="w-4 h-4 object-contain brightness-200" alt="Add Source" /> Add Source
              </Button>
            </IconTooltip>
            <PerformanceNudge type="source" onNavigateToBestPractices={onNavigateToBestPractices} />
            <IconTooltip
              label={fixActive ? FIX_BLOCKED_TOOLTIP : 'Remove the selected source(s) from your library'}
              side="top"
            >
              <Button
                variant="outline"
                size="sm"
                className="flex-1 justify-center gap-2 text-muted-foreground hover:text-foreground border-primary/50 hover:border-primary/70 hover:bg-primary/5 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!hasSelectedSources || fixActive}
                onClick={onRemoveSource}
              >
                <img src="./assets//pdr-remove.png" className="w-4 h-4 object-contain" alt="Remove" /> Remove
              </Button>
            </IconTooltip>
          </div>
        </div>
      </div>

      {/* VIEWS + TOOLS — static section anchored just above Guidance, so
          it stays visible regardless of how many sources the user adds. The
          scrollable Sources area above it grows to fill any free space
          between Add Source and this block, giving the user a natural
          "drop zone" of breathing room for source entries to populate. */}
      <div className="pt-2 border-t pb-2 px-4 space-y-4 sidebar-divider">
        <div>
          <SectionHeader
            label="Views"
            collapsed={viewsCollapsed}
            onToggle={() => { setViewsCollapsed((v) => !v); setUserOverrode((u) => ({ ...u, views: true })); }}
          />
          {!viewsCollapsed && (
            <div className="space-y-1">
              <SidebarItem
                icon={<img src="./assets//pdr-workspace.png" className="w-4 h-4 object-contain" alt="Workspace" />}
                label={sources.length > 0 ? "Dashboard" : "Workspace"}
                onClick={() => {
                  if (sources.length > 0 && !isLicensed) { onFeatureLocked('dashboard'); return; }
                  onDashboardClick();
                }}
                active={activeView === 'dashboard' && activePanel === null && !sources.some(s => s.active)}
                selectable={false}
                locked={sources.length > 0 && !isLicensed}
              />
              <SidebarItem
                icon={<Search className="w-4 h-4 opacity-70" />}
                label="Search & Discovery"
                onClick={() => {
                  if (!isLicensed) { onFeatureLocked('search-discovery'); return; }
                  onViewChange?.('search');
                }}
                active={activeView === 'search'}
                selectable={false}
                locked={!isLicensed}
              />
              <SidebarItem
                icon={<CalendarRange className="w-4 h-4 opacity-70" />}
                label="Memories"
                onClick={() => {
                  if (!isLicensed) { onFeatureLocked('memories'); return; }
                  onViewChange?.('memories');
                }}
                active={activeView === 'memories'}
                selectable={false}
                locked={!isLicensed}
              />
              <SidebarItem
                icon={<Network className="w-4 h-4 opacity-70" />}
                label="Trees"
                onClick={() => {
                  if (!isLicensed) { onFeatureLocked('trees'); return; }
                  onViewChange?.('familytree');
                }}
                active={activeView === 'familytree'}
                selectable={false}
                locked={!isLicensed}
              />
            </div>
          )}
        </div>
        <div>
          <SectionHeader
            label="Tools"
            collapsed={toolsCollapsed}
            onToggle={() => { setToolsCollapsed((v) => !v); setUserOverrode((u) => ({ ...u, tools: true })); }}
          />
          {!toolsCollapsed && (
            <div className="space-y-1">
              <SidebarItem
                icon={<span className="w-4 h-4 rounded-md bg-purple-500/15 flex items-center justify-center"><Users className="w-3 h-3 text-purple-500" /></span>}
                label="People Manager"
                onClick={() => {
                  if (!isLicensed) { onFeatureLocked('people-manager'); return; }
                  onOpenPeople();
                }}
                selectable={false}
                locked={!isLicensed}
              />
            </div>
          )}
        </div>
      </div>

      {/* EDUCATION SECTION */}
      <div className="pt-2 border-t pb-2 sidebar-divider" data-tour="guides-panel">
        <div className="px-4">
          <SectionHeader
            label="Guidance"
            collapsed={guidanceCollapsed}
            onToggle={() => {
              setGuidanceCollapsed((v) => !v);
              setUserOverrode((u) => ({ ...u, guidance: true }));
            }}
          />
        </div>
        {!guidanceCollapsed && (
          <div className="space-y-1 px-4">
            <SidebarItem icon={<PlayCircle className="w-4 h-4 opacity-60" />} label="Quick Tour" onClick={onStartTour} />
            <SidebarItem icon={<img src="./assets//pdr-getting-started.png" className="w-4 h-4 object-contain" alt="Getting Started" />} label="Getting Started" onClick={() => onPanelChange('getting-started')} active={activePanel === 'getting-started'} />
            <SidebarItem icon={<img src="./assets//pdr-best-practices.png" className="w-4 h-4 object-contain" alt="Best Practices" />} label="Best Practices" onClick={() => onPanelChange('best-practices')} active={activePanel === 'best-practices'} />
            <SidebarItem icon={<img src="./assets//pdr-what-happens-next.png" className="w-4 h-4 object-contain" alt="What Happens Next" />} label="What Happens Next" onClick={() => onPanelChange('what-next')} active={activePanel === 'what-next'} />
          </div>
        )}
      </div>

      {/* APP SECTION - BOTTOM (Settings / About / Help) — collapsible to
          match Views / Tools / Guidance. */}
      <div className="border-t px-4 pt-2 pb-3 sidebar-divider">
        <SectionHeader
          label="App"
          collapsed={appCollapsed}
          onToggle={() => { setAppCollapsed((v) => !v); setUserOverrode((u) => ({ ...u, app: true })); }}
        />
        {!appCollapsed && (
          <div className="space-y-1">
            <SidebarItem icon={<img src="./assets//pdr-settings.png" className="w-4 h-4 object-contain" alt="Settings" />} label="Settings" onClick={onSettingsClick} />
            <SidebarItem icon={<Info className="w-4 h-4 opacity-60" />} label="About PDR" onClick={() => onPanelChange('about-pdr')} active={activePanel === 'about-pdr'} />
            <SidebarItem icon={<img src="./assets//pdr-help&support.png" className="w-4 h-4 object-contain" alt="Help & Support" />} label="Help & Support" onClick={() => onPanelChange('help-support')} active={activePanel === 'help-support'} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Clickable section header used by Views / Tools / Guidance in the sidebar.
 * Renders the uppercase-tracking label + a chevron that rotates when the
 * section expands, so users can tuck away sections they don't use often and
 * give the main list room to breathe on short screens.
 */
function SectionHeader({ label, collapsed, onToggle }: { label: string; collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between px-2 py-1 mb-1 rounded text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:text-foreground hover:bg-primary/5 transition-colors"
    >
      <span>{label}</span>
      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
    </button>
  );
}

function SidebarItem({ icon, label, active = false, selected = false, selectable = false, onClick, disabled = false, locked = false }: { icon: React.ReactNode, label: string, active?: boolean, selected?: boolean, selectable?: boolean, onClick?: (e?: React.MouseEvent) => void, disabled?: boolean, locked?: boolean }) {
  const content = (
    <div
      className={`group w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all duration-200 cursor-pointer ${
        disabled
          ? 'text-muted-foreground/50 cursor-not-allowed'
          : active
            ? 'text-secondary-foreground font-medium bg-sidebar-accent/50 hover:bg-primary/15'
            : 'text-sidebar-foreground hover:bg-primary/10 hover:text-foreground'
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
      <div className="flex items-center gap-2 overflow-hidden pointer-events-none flex-1">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      {locked && (
        <Lock className="w-3 h-3 text-muted-foreground/50 group-hover:text-primary transition-colors flex-shrink-0 pointer-events-none" />
      )}
    </div>
  );

  if (locked) {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>{content}</TooltipTrigger>
          <TooltipContent side="right">
            <p>Premium feature — click for details</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return content;
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
  onDismissCompletion,
  onNavigateToBestPractices,
  destinationPath,
  setDestinationPath,
  destinationFreeGB,
  setDestinationFreeGB,
  destinationTotalGB,
  setDestinationTotalGB,
  hasCompletedFix,
  setHasCompletedFix,
  savedReportId,
  setSavedReportId,
  addToSDRef,
  isLicensed,
  onActivateLicense,
  zoomLevel = 100
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
  onDismissCompletion: () => void,
  onNavigateToBestPractices?: () => void,
  destinationPath: string | null,
  setDestinationPath: (path: string | null) => void,
  destinationFreeGB: number,
  setDestinationFreeGB: (gb: number) => void,
  destinationTotalGB: number,
  setDestinationTotalGB: (gb: number) => void,
  hasCompletedFix: boolean,
  setHasCompletedFix: (value: boolean) => void,
  savedReportId: string | null,
  setSavedReportId: (id: string | null) => void,
  addToSDRef: React.MutableRefObject<boolean>,
  isLicensed: boolean,
  onActivateLicense: () => void,
  zoomLevel?: number
}) {
  // Show Empty State only if no sources exist at all
  if (sources.length === 0) {
     return <EmptyState
       onAddFirstSource={onAddAnother}
       isLicensed={isLicensed}
       onActivateLicense={onActivateLicense}
       onNavigateToBestPractices={onNavigateToBestPractices}
       hasCompletedFix={hasCompletedFix || !!savedReportId}
       savedReportId={savedReportId}
       onViewReport={() => {
         const event = new CustomEvent('open-reports-history');
         window.dispatchEvent(event);
       }}
     />;
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
      onNavigateToBestPractices={onNavigateToBestPractices}
      destinationPath={destinationPath}
      setDestinationPath={setDestinationPath}
      destinationFreeGB={destinationFreeGB}
      setDestinationFreeGB={setDestinationFreeGB}
      destinationTotalGB={destinationTotalGB}
      setDestinationTotalGB={setDestinationTotalGB}
      hasCompletedFix={hasCompletedFix}
      setHasCompletedFix={setHasCompletedFix}
      savedReportId={savedReportId}
      setSavedReportId={setSavedReportId}
      addToSDRef={addToSDRef}
      zoomLevel={zoomLevel}
    />
  );
}

function DashboardPanel({
  sources, activeSource, onRemove, onChange, onAddFolder, onAddZip, isComplete = false, results, onViewResults, fileResults, onNavigateToBestPractices,
  destinationPath, setDestinationPath, destinationFreeGB, setDestinationFreeGB, destinationTotalGB, setDestinationTotalGB,
  hasCompletedFix, setHasCompletedFix, savedReportId, setSavedReportId, addToSDRef, zoomLevel = 100
}: {
  sources: Source[], activeSource: Source | null, onRemove: () => void, onChange: () => void, onAddFolder: () => void, onAddZip: () => void,
  isComplete?: boolean, results?: AnalysisResults, onViewResults?: () => void, fileResults?: Record<string, SourceAnalysisResult>, onNavigateToBestPractices?: () => void,
  destinationPath: string | null, setDestinationPath: (path: string | null) => void,
  destinationFreeGB: number, setDestinationFreeGB: (gb: number) => void,
  destinationTotalGB: number, setDestinationTotalGB: (gb: number) => void,
  hasCompletedFix: boolean, setHasCompletedFix: (value: boolean) => void,
  savedReportId: string | null, setSavedReportId: (id: string | null) => void,
  addToSDRef: React.MutableRefObject<boolean>,
  zoomLevel?: number
}) {
  // Use selected sources for aggregation
  const selectedSources = sources.filter(s => s.selected);
  const hasSelection = selectedSources.length > 0;
  // True whenever any window has a Fix in flight — used to gate the
  // Run Fix button so a second concurrent fix can't be kicked off.
  // useFixInProgress reads via IPC + subscribes to broadcasts, so
  // this stays accurate even if the original Fix was started from
  // a different window or session.
  const fixActive = useFixInProgress();
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [showFixModal, setShowFixModal] = useState(false);
  const [showSDPrompt, setShowSDPrompt] = useState(false);
  const [addToSDThisRun, setAddToSDThisRun] = useState(false);
  const [showPostFixReport, setShowPostFixReport] = useState(false);
  const [showReportsList, setShowReportsList] = useState(false);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [includePhotos, setIncludePhotos] = useState(true);
  const [includeVideos, setIncludeVideos] = useState(true);
  const [reportSavedMessage, setReportSavedMessage] = useState(false);
  const [showDestBrowser, setShowDestBrowser] = useState(false);
  const [showDestAdvisor, setShowDestAdvisor] = useState(false);
  const [showLibraryPlanner, setShowLibraryPlanner] = useState(false);
  const [libraryPlannerAnswers, setLibraryPlannerAnswers] = useState<LibraryPlannerAnswers | null>(() => {
    // Restore from localStorage if previously completed
    const saved = localStorage.getItem('pdr-library-planner-size');
    const multi = localStorage.getItem('pdr-library-planner-multi');
    if (saved && multi) {
      return {
        collectionSizeGB: parseInt(saved, 10),
        multipleSourcesPlanned: multi as 'yes' | 'no' | 'not-sure',
      };
    }
    return null;
  });
  const [photoFormat, setPhotoFormat] = useState<'original' | 'png' | 'jpg'>('original');
  const [photoFormatOpen, setPhotoFormatOpen] = useState(false);
  const photoFormatBtnRef = React.useRef<HTMLButtonElement>(null);

  // Post-fix flow tracking: true from when fix completes until the clear prompt is answered
  const [postFixFlowActive, setPostFixFlowActive] = useState(false);
  const [showClearSourcesPrompt, setShowClearSourcesPrompt] = useState(false);

  const handleChangeDestination = () => {
    if (isElectron()) {
      // First ever destination selection: Library Planner → DDA → Folder Browser
      // Subsequent selections: straight to folder browser
      const plannerDone = localStorage.getItem('pdr-library-planner-complete') === 'true';
      const skipAdvisor = localStorage.getItem('pdr-skip-dest-advisor') === 'true';

      if (!destinationPath && !plannerDone) {
        // First time ever — show the planner first
        setShowLibraryPlanner(true);
      } else if (!destinationPath && !skipAdvisor) {
        // Planner done but first destination selection — show DDA
        setShowDestAdvisor(true);
      } else {
        setShowDestBrowser(true);
      }
    } else {
      setDestinationPath('/Volumes/Photos_Backup/Restored_2024');
      setDestinationFreeGB(2400);
      setDestinationTotalGB(4000);
    }
  };

  const handleDestBrowserSelect = async (selectedPath: string) => {
    setShowDestBrowser(false);
    const { getDiskSpace } = await import('@/lib/electron-bridge');
    setDestinationPath(selectedPath);
    const diskInfo = await getDiskSpace(selectedPath);
    setDestinationFreeGB(diskInfo.freeBytes / (1024 * 1024 * 1024));
    setDestinationTotalGB(diskInfo.totalBytes / (1024 * 1024 * 1024));
  };

  // When all post-fix modals close and we're in the post-fix flow, show the clear prompt
  useEffect(() => {
    if (postFixFlowActive && !showFixModal && !showReportsList && !showPostFixReport) {
      setShowClearSourcesPrompt(true);
      setPostFixFlowActive(false);
    }
  }, [postFixFlowActive, showFixModal, showReportsList, showPostFixReport]);

  const handleOpenDestination = async () => {
    if (destinationPath) {
      const { openDestinationFolder } = await import('@/lib/electron-bridge');
      await openDestinationFolder(destinationPath);
    }
  };

  // Stats generator based on SELECTED sources and file type filters
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
    
    // Estimate output size based on included file types AND format conversion
    // Use per-file data from analysis results for accurate format-aware estimation
    let estimatedBytes = 0;
    const PNG_EXPANSION = 1.6; // JPG→PNG typically expands ~1.1-1.5x; using 1.6 to avoid underestimating
    const JPG_COMPRESSION = 0.2; // PNG→JPG typically shrinks to ~20%

    for (const source of selectedSources) {
      const analysisData = fileResults?.[source.id];
      if (analysisData?.files) {
        for (const file of analysisData.files) {
          if (file.type === 'photo' && !includePhotos) continue;
          if (file.type === 'video' && !includeVideos) continue;

          if (file.type === 'video' || photoFormat === 'original') {
            // Videos are never converted; originals stay as-is
            estimatedBytes += file.sizeBytes;
          } else if (photoFormat === 'png') {
            const ext = file.extension?.toLowerCase() || '';
            if (ext === '.png') {
              estimatedBytes += file.sizeBytes; // Already PNG — no change
            } else {
              estimatedBytes += file.sizeBytes * PNG_EXPANSION;
            }
          } else if (photoFormat === 'jpg') {
            const ext = file.extension?.toLowerCase() || '';
            if (ext === '.jpg' || ext === '.jpeg') {
              estimatedBytes += file.sizeBytes; // Already JPG — no change
            } else if (ext === '.png') {
              estimatedBytes += file.sizeBytes * JPG_COMPRESSION;
            } else {
              estimatedBytes += file.sizeBytes; // Other formats → JPG, roughly similar
            }
          }
        }
      } else {
        // Fallback: no per-file data, use proportional estimate
        const srcSizeGB = source.stats?.estimatedSizeGB || 0;
        const pCount = source.stats?.photoCount || 0;
        const vCount = source.stats?.videoCount || 0;
        const pRatio = pCount / (pCount + vCount || 1);
        const vRatio = vCount / (pCount + vCount || 1);
        const photoGB = includePhotos ? srcSizeGB * pRatio : 0;
        const videoGB = includeVideos ? srcSizeGB * vRatio : 0;
        const formatMultiplier = photoFormat === 'png' ? PNG_EXPANSION : photoFormat === 'jpg' ? JPG_COMPRESSION : 1;
        estimatedBytes += (photoGB * formatMultiplier + videoGB) * 1024 * 1024 * 1024;
      }
    }
    const sizeGB = estimatedBytes / (1024 * 1024 * 1024);

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

  // Get real confidence stats from analysis results, filtered by includePhotos/includeVideos
  let highConf = 0;
  let medConf = 0;
  let lowConf = 0;
  let duplicatesCount = 0;
  
  for (const source of selectedSources) {
    const realResult = fileResults?.[source.id];
    if (realResult?.files) {
      for (const file of realResult.files) {
        // Apply the same photo/video filters as Combined Analysis
        const isPhoto = file.type === 'photo';
        const isVideo = file.type === 'video';
        if ((isPhoto && !includePhotos) || (isVideo && !includeVideos)) {
          continue; // Skip files that don't match current filters
        }

        // Count by confidence level
        if (file.dateConfidence === 'confirmed') {
          highConf++;
        } else if (file.dateConfidence === 'recovered') {
          medConf++;
        } else if (file.dateConfidence === 'marked') {
          lowConf++;
        }
      }
      // Duplicates must also respect photo/video filters
      if (realResult?.duplicateFiles) {
        for (const dup of realResult.duplicateFiles) {
          const isPhoto = dup.type === 'photo';
          const isVideo = dup.type === 'video';
          if ((isPhoto && !includePhotos) || (isVideo && !includeVideos)) {
            continue;
          }
          duplicatesCount++;
        }
      }
    } else if (source.confidenceSummary) {
      // Fallback: use persisted confidence summary (e.g. after app restart)
      highConf += source.confidenceSummary.confirmed;
      medConf += source.confidenceSummary.recovered;
      lowConf += source.confidenceSummary.marked;
      duplicatesCount += source.duplicatesRemoved || 0;
    }
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-background relative">
      <div className="flex-1 flex flex-col items-center justify-start p-8 overflow-y-auto pb-24">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-4xl w-full pt-4"
      >
        <div className="mb-8 text-center">
           <h2 className="text-2xl font-semibold text-foreground mb-2">Dashboard</h2>
           <p className="text-muted-foreground">{isComplete ? 'Analysis complete — review results and run your fix' : 'Review your sources and start analysis'}</p>
        </div>

        {/* Confidence Summary Section */}
        {hasSelection && (
          <section className="mb-8 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-100" data-tour="confidence-cards">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-foreground font-heading">Source Analysis</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
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
                onNavigateToBestPractices={onNavigateToBestPractices}
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
                onNavigateToBestPractices={onNavigateToBestPractices}
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
                onNavigateToBestPractices={onNavigateToBestPractices}
              />
			  <ConfidenceCard 
                level="Duplicates" 
                count={duplicatesCount} 
                percentage={0}
                description="Hash-matched duplicates safely skipped."
                color="text-amber-600"
                bgColor="bg-amber-50"
                borderColor="border-amber-200"
                icon={<Copy className="w-5 h-5" />}
                tooltip="Exact duplicate files detected by content hash (SHA-256). These are excluded from the output to avoid redundancy."
                isActive={false}
                onNavigateToBestPractices={onNavigateToBestPractices}
              />
            </div>
          </section>
        )}

        <Card className="p-6 mb-2" data-tour="combined-analysis">
          <div className="flex items-start justify-between gap-6 mb-5 border-b border-border pb-5">
            <div className="flex items-start gap-6">
              <div className="p-4 bg-secondary/50 rounded-2xl text-primary">
                <img src="./assets//pdr-combined-analysis.png" className="w-8 h-8 object-contain" alt="Combined Analysis" />
              </div>
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <h3 className="text-xl font-semibold text-foreground">{stats.label}</h3>
                  {isComplete && (
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-100/50 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200/50 dark:border-emerald-700/50">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span className="text-xs font-medium">Analysis complete</span>
                    </div>
                  )}
                  <Button size="sm" onClick={onAddFolder} className="gap-2 shadow-md shadow-primary/20 ml-auto">
                    <img src="./assets//pdr-add-source.png" className="w-4 h-4 object-contain brightness-200" alt="Add Source" /> Add Source
                  </Button>
                </div>
                <div className="flex items-center gap-1">
                  <p className="text-sm text-muted-foreground font-mono bg-muted px-2 py-1 rounded inline-block">
                    {stats.path}
                  </p>
                  <PerformanceNudge type="path" onNavigateToBestPractices={onNavigateToBestPractices} />
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <label className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium cursor-pointer transition-all duration-150 select-none ${
                includePhotos
                  ? 'border-emerald-300/60 bg-emerald-50/40 text-emerald-700 dark:border-emerald-600/40 dark:bg-emerald-900/20 dark:text-emerald-300'
                  : 'border-border bg-muted/30 text-muted-foreground'
              }`}>
                <Checkbox
                  checked={includePhotos}
                  onCheckedChange={(checked) => setIncludePhotos(checked === true)}
                  data-testid="checkbox-include-photos"
                  className="w-3.5 h-3.5"
                />
                Photos
              </label>
              <label className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium cursor-pointer transition-all duration-150 select-none ${
                includeVideos
                  ? 'border-emerald-300/60 bg-emerald-50/40 text-emerald-700 dark:border-emerald-600/40 dark:bg-emerald-900/20 dark:text-emerald-300'
                  : 'border-border bg-muted/30 text-muted-foreground'
              }`}>
                <Checkbox
                  checked={includeVideos}
                  onCheckedChange={(checked) => setIncludeVideos(checked === true)}
                  data-testid="checkbox-include-videos"
                  className="w-3.5 h-3.5"
                />
                Videos
              </label>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div>
              <div className="text-sm text-muted-foreground mb-1">Sources</div>
              <div className="text-2xl font-semibold text-secondary-foreground font-heading" style={{ filter: "saturate(1.075)" }}>{stats.sourceCount.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Photos</div>
              <div className="flex items-center gap-2 text-2xl font-semibold text-secondary-foreground font-heading" style={{ filter: "saturate(1.075)" }}>
                <FileImage className="w-4 h-4" /> {stats.photos.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Videos</div>
              <div className="flex items-center gap-2 text-2xl font-semibold text-secondary-foreground font-heading" style={{ filter: "saturate(1.075)" }}>
                <FileVideo className="w-4 h-4" /> {stats.videos.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Total Size</div>
              <div className="text-2xl font-semibold text-secondary-foreground font-heading" style={{ filter: "saturate(1.075)" }}>{stats.sizeGB.toFixed(1)} GB</div>
            </div>
          </div>

        </Card>

        {/* Preview Section */}
        <section className="pt-0 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-200">
            <h2 className="text-lg font-semibold text-foreground mb-4">Output</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-tour="destination">
              {/* Left: Destination Drive */}
              <Card className="flex flex-col p-5">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <Button
                    size="sm"
                    onClick={handleChangeDestination}
                    className="justify-center gap-2 shadow-md shadow-primary/20"
                    data-testid="button-change-destination"
                    style={!destinationPath ? { animation: 'outline-pulse 2s ease-in-out infinite' } : undefined}
                  >
                    <img src="./assets//pdr-destination-drive.png" className="w-4 h-4 object-contain brightness-200" alt="Destination" />
                    {destinationPath ? 'Change Destination' : 'Select Destination'}
                  </Button>
                  {destinationPath && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleOpenDestination}
                      className="gap-1.5 border-emerald-400/60 text-emerald-600 hover:bg-emerald-50 hover:border-emerald-500 dark:text-emerald-400 dark:hover:bg-emerald-950/30 dark:border-emerald-600/40 shrink-0"
                      data-testid="button-open-destination-card"
                    >
                      <FolderOpen className="w-3.5 h-3.5" /> Open
                    </Button>
                  )}
                  <IconTooltip label="Destination Advisor — recommendations and guidance" side="top">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowDestAdvisor(true)}
                      className="gap-1.5 border-primary/30 text-primary hover:bg-primary/5 shrink-0"
                    >
                      <Info className="w-3.5 h-3.5" /> {destinationPath ? 'DA' : 'Drive Advisor'}
                    </Button>
                  </IconTooltip>
                </div>
                <div className="flex-1">
                  {destinationPath ? (
                    <>
                      <div className="flex items-center gap-1 mb-1.5">
                        <IconTooltip label={destinationPath} side="top"><p className="text-sm text-muted-foreground font-mono bg-muted px-2 py-1 rounded truncate max-w-full">{destinationPath}</p></IconTooltip>
                        <IconTooltip label="Clear destination" side="top">
                          <button
                            onClick={() => { setDestinationPath(null); setDestinationFreeGB(0); setDestinationTotalGB(0); }}
                            className="p-1 text-muted-foreground/50 hover:text-rose-500 transition-colors shrink-0"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </IconTooltip>
                      </div>
                      {/* Visual space bar */}
                      {destinationTotalGB > 0 && (
                        <div className="mb-2">
                          <div className="w-full h-2.5 rounded-full bg-secondary overflow-hidden">
                            {(() => {
                              const usedGB = destinationTotalGB - destinationFreeGB;
                              const usedPercent = Math.round((usedGB / destinationTotalGB) * 100);
                              const requiredPercent = Math.min(100 - usedPercent, Math.round((stats.sizeGB / destinationTotalGB) * 100));
                              return (
                                <>
                                  <div className="h-full flex">
                                    <div className="h-full bg-muted-foreground/30 rounded-l-full" style={{ width: `${usedPercent}%` }} />
                                    <div className={`h-full ${destinationFreeGB >= stats.sizeGB ? 'bg-primary/60' : 'bg-rose-500/60'}`} style={{ width: `${requiredPercent}%` }} />
                                  </div>
                                </>
                              );
                            })()}
                          </div>
                          <div className="flex items-center justify-between mt-1 text-[10px] text-muted-foreground">
                            <span>{(destinationTotalGB - destinationFreeGB).toFixed(1)} GB used</span>
                            <span>{destinationFreeGB >= 1000 ? `${(destinationFreeGB / 1000).toFixed(1)} TB` : `${destinationFreeGB.toFixed(1)} GB`} free of {destinationTotalGB >= 1000 ? `${(destinationTotalGB / 1000).toFixed(1)} TB` : `${destinationTotalGB.toFixed(0)} GB`}</span>
                          </div>
                        </div>
                      )}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${destinationFreeGB >= stats.sizeGB ? 'text-emerald-600 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-900/30' : 'text-rose-600 bg-rose-50 dark:text-rose-400 dark:bg-rose-900/30'}`}>
                          Required: {stats.sizeGB.toFixed(1)} GB
                        </span>
                        {destinationFreeGB < stats.sizeGB && (
                          <span className="text-xs text-rose-600 dark:text-rose-400 font-medium">Insufficient space</span>
                        )}
                      </div>
                      {destinationFreeGB >= stats.sizeGB && stats.sizeGB > 0 && (
                        <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-1.5">
                          {(destinationFreeGB - stats.sizeGB) >= 1000
                            ? `${((destinationFreeGB - stats.sizeGB) / 1000).toFixed(1)} TB`
                            : `${(destinationFreeGB - stats.sizeGB).toFixed(1)} GB`
                          } free after this fix
                        </p>
                      )}
                      {/* Review library plan link */}
                      <button
                        onClick={() => setShowLibraryPlanner(true)}
                        className="text-[10px] text-primary/60 hover:text-primary transition-colors mt-1.5 flex items-center gap-1"
                      >
                        <Settings className="w-2.5 h-2.5" />
                        {libraryPlannerAnswers ? 'Review library plan' : 'Plan your library'}
                      </button>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">Choose the location where your new library structure will go.</p>
                  )}
                </div>
              </Card>

              {/* Right: Photo Format */}
              <Card className="flex flex-col p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex-1">
                    <Button
                      ref={photoFormatBtnRef}
                      size="sm"
                      onClick={() => setPhotoFormatOpen(!photoFormatOpen)}
                      className="w-full justify-center gap-2 shadow-md shadow-primary/20"
                    >
                      <FileImage className="w-4 h-4 brightness-200" />
                      {photoFormat === 'original' ? 'Select Photo Format' : photoFormat === 'png' ? 'PNG Selected' : 'JPG Selected'}
                      <ChevronDown className={`w-3.5 h-3.5 brightness-200 transition-transform duration-200 ${photoFormatOpen ? 'rotate-180' : ''}`} />
                    </Button>
                    {photoFormatOpen && ReactDOM.createPortal(
                      <>
                        <div className="fixed inset-0 z-[9998]" onClick={() => setPhotoFormatOpen(false)} />
                        <div
                          className="fixed bg-background border border-border rounded-lg shadow-lg z-[9999] overflow-hidden"
                          style={(() => {
                            const rect = photoFormatBtnRef.current?.getBoundingClientRect();
                            if (!rect) return {};
                            const dropdownH = 3 * 44; // 3 options ~44px each
                            const spaceBelow = window.innerHeight - rect.bottom - 8;
                            if (spaceBelow >= dropdownH) {
                              return { top: rect.bottom + 4, left: rect.left, width: rect.width };
                            }
                            return { bottom: window.innerHeight - rect.top + 4, left: rect.left, width: rect.width };
                          })()}
                        >
                          {([
                            { value: 'original' as const, label: 'Keep Originals', desc: 'No conversion' },
                            { value: 'png' as const, label: 'PNG', desc: 'Highest quality, lossless' },
                            { value: 'jpg' as const, label: 'JPG', desc: 'Reduced file size, universal' },
                          ]).map(opt => {
                            // Compute estimated output size for this format option
                            const estGB = (() => {
                              if (stats.photos === 0 && stats.videos === 0) return 0;
                              let bytes = 0;
                              const PNG_X = 1.6, JPG_X = 0.2;
                              for (const source of selectedSources) {
                                const ad = fileResults?.[source.id];
                                if (ad?.files) {
                                  for (const f of ad.files) {
                                    if (f.type === 'photo' && !includePhotos) continue;
                                    if (f.type === 'video' && !includeVideos) continue;
                                    if (f.type === 'video' || opt.value === 'original') { bytes += f.sizeBytes; continue; }
                                    const ext = f.extension?.toLowerCase() || '';
                                    if (opt.value === 'png') {
                                      bytes += ext === '.png' ? f.sizeBytes : f.sizeBytes * PNG_X;
                                    } else {
                                      bytes += (ext === '.jpg' || ext === '.jpeg') ? f.sizeBytes : ext === '.png' ? f.sizeBytes * JPG_X : f.sizeBytes;
                                    }
                                  }
                                }
                              }
                              return bytes / (1024 * 1024 * 1024);
                            })();
                            const sizeLabel = estGB >= 1 ? `~${estGB.toFixed(1)} GB` : estGB > 0 ? `~${(estGB * 1024).toFixed(0)} MB` : '';
                            return (
                            <button
                              key={opt.value}
                              onClick={() => { setPhotoFormat(opt.value); setPhotoFormatOpen(false); }}
                              className={`w-full text-left px-3 py-2.5 text-sm hover:bg-primary/5 transition-colors flex items-center justify-between ${photoFormat === opt.value ? 'bg-primary/10 text-primary font-medium' : 'text-foreground'}`}
                            >
                              <span>{opt.label}</span>
                              <span className="text-xs text-muted-foreground">{opt.desc}{sizeLabel ? ` · ${sizeLabel}` : ''}</span>
                            </button>
                            );
                          })}
                        </div>
                      </>,
                      document.body
                    )}
                  </div>
                  <CardInfoTooltip onNavigateToBestPractices={onNavigateToBestPractices}>
                    <p><strong className="text-foreground">PNG</strong> preserves every pixel with zero loss — ideal for photos you may want to edit, print, or archive long-term. Files will be larger.</p>
                    <p className="mt-1.5"><strong className="text-foreground">JPG</strong> compresses photos to a fraction of the size with virtually no visible difference. The most widely supported format across all devices and apps.</p>
                    <p className="mt-1.5 text-muted-foreground/70 italic">Files already in your chosen format will not be re-converted.</p>
                  </CardInfoTooltip>
                </div>
                <p className="text-xs text-muted-foreground">
                  {photoFormat === 'original' && 'Default: files stay in their current format. Extensions are normalised (.jpeg → .jpg).'}
                  {photoFormat === 'png' && 'All photos converted to PNG. Lossless quality, larger files.'}
                  {photoFormat === 'jpg' && 'All photos converted to JPG. Smaller files, virtually identical quality.'}
                </p>
              </Card>
            </div>
        </section>
      </motion.div>
      </div>

      {/* Sticky Bottom Action Bar for Complete State */}
      {isComplete && (
        <motion.div
          initial={{ y: 100 }}
          animate={{ y: 0 }}
          className="absolute bottom-0 left-0 right-0 bg-background border-t border-border p-4 shadow-[0_-4px_20px_-5px_rgba(0,0,0,0.1)] z-20"
          style={{ zoom: 100 / zoomLevel }}
        >
          <div className="max-w-5xl mx-auto flex items-center justify-between">
             <div className="text-sm font-medium text-muted-foreground">
                <span className="text-foreground font-bold font-heading">{stats.totalFiles.toLocaleString()}</span> files ready to process
                {!destinationPath && <span className="ml-2 text-amber-600 dark:text-amber-400">— Select a destination to continue</span>}
                {destinationPath && destinationFreeGB < stats.sizeGB && <span className="ml-2 text-rose-600 dark:text-rose-400">— Insufficient space on destination</span>}
             </div>
             <div className="flex items-center gap-4">
               <Button 
                 onClick={() => setShowReportsList(true)} 
                 variant="outline"
                 className="border-muted-foreground/30 hover:bg-secondary hover:border-muted-foreground/50"
                 data-testid="button-view-reports"
                 data-tour="reports-history"
               >
                 <FileText className="w-4 h-4 mr-2" /> Reports History
               </Button>
               <IconTooltip
                 label={fixActive ? 'One Fix at a time — wait for the current run to finish before starting another' : 'Apply all pending fixes to your library'}
                 side="top"
               >
                 <Button
                   onClick={() => {
                     // Hard-block a second concurrent Fix. The chip
                     // is visible top-right while one is running so
                     // the user always knows.
                     if (fixActive) {
                       toast.error('One Fix at a time. Wait for the current run to finish.');
                       return;
                     }
                     const pref = localStorage.getItem('pdr-auto-add-to-sd') || 'ask';
                     if (pref === 'always') {
                       setAddToSDThisRun(true);
                       addToSDRef.current = true;
                       setShowFixModal(true);
                     } else {
                       // 'ask' — show the pre-fix S&D prompt
                       setShowSDPrompt(true);
                     }
                   }}
                   variant="outline"
                   disabled={!destinationPath || destinationFreeGB < stats.sizeGB || fixActive}
                   className="border-2 border-secondary-foreground bg-secondary/5 hover:bg-secondary/20 text-secondary-foreground px-8 shadow-[0_4px_14px_0_rgba(107,90,255,0.3)] hover:shadow-[0_6px_20px_rgba(107,90,255,0.4)] transition-all duration-300 font-bold font-heading h-11 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
                   data-testid="button-run-fix"
                   data-tour="apply-fixes"
                 >
                   <Wrench className="w-5 h-5 mr-2 stroke-[2.5]" />
                   {fixActive ? 'Fix in progress…' : 'Run Fix'}
                 </Button>
               </IconTooltip>
             </div>
          </div>
        </motion.div>
      )}

      {/* Counter-zoom wrapper: these modals use fixed positioning but are inside the
          zoomable content div, so CSS zoom from the parent distorts their size.
          We counter-scale them back to 100% so they match the Add Source modal. */}
      <div style={{ zoom: 100 / zoomLevel }}>
      {showPreviewModal && <PreviewModal onClose={() => setShowPreviewModal(false)} results={results} />}
      {/* Library Planner — shown on first destination selection or when user reviews their plan */}
      <LibraryPlannerModal
        isOpen={showLibraryPlanner}
        previousAnswers={libraryPlannerAnswers}
        onComplete={(answers) => {
          const isReview = !!destinationPath;
          setLibraryPlannerAnswers(answers);
          setShowLibraryPlanner(false);
          // If reviewing (destination already set), just close — don't re-trigger the flow
          if (isReview) return;
          // First-time flow continues to DDA (unless skipped)
          const skipAdvisor = localStorage.getItem('pdr-skip-dest-advisor') === 'true';
          if (!skipAdvisor) {
            setShowDestAdvisor(true);
          } else {
            setShowDestBrowser(true);
          }
        }}
        onSkip={() => {
          const isReview = !!destinationPath;
          setShowLibraryPlanner(false);
          if (isReview) return;
          const skipAdvisor = localStorage.getItem('pdr-skip-dest-advisor') === 'true';
          if (!skipAdvisor) {
            setShowDestAdvisor(true);
          } else {
            setShowDestBrowser(true);
          }
        }}
      />
      {/* Destination Drive Advisor — shown before first destination selection */}
      <DestinationAdvisorModal
        isOpen={showDestAdvisor}
        onClose={() => setShowDestAdvisor(false)}
        onContinue={() => { setShowDestAdvisor(false); setShowDestBrowser(true); }}
        currentSourceSizeGB={stats.sizeGB}
        plannedCollectionSizeGB={libraryPlannerAnswers?.collectionSizeGB ?? null}
      />
      {/* Custom Folder Browser for destination selection */}
      <FolderBrowserModal
        isOpen={showDestBrowser}
        onSelect={handleDestBrowserSelect}
        onCancel={() => setShowDestBrowser(false)}
        title="Select Destination"
        mode="folder"
        onOpenDriveAdvisor={() => { setShowDestBrowser(false); setShowDestAdvisor(true); }}
        plannedCollectionSizeGB={libraryPlannerAnswers?.collectionSizeGB ?? null}
        enableSavedLocations
        showDriveRatings
      />
      {/* Pre-fix S&D prompt — shown when user clicks Run Fix and preference is 'ask' */}
      {showSDPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="bg-card border border-border rounded-xl shadow-2xl w-[440px] p-6"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <Search className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-bold font-heading">Search & Discovery</h3>
                <p className="text-xs text-muted-foreground">Make fixed files searchable</p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mb-5">
              Would you like the output of this fix to be added to Search & Discovery? This lets you search, filter, and browse your files after the fix completes.
            </p>
            <div className="flex flex-col gap-2">
              <Button
                onClick={() => {
                  setAddToSDThisRun(true);
                  addToSDRef.current = true;
                  setShowSDPrompt(false);
                  setShowFixModal(true);
                }}
                className="w-full justify-start h-11"
              >
                <CheckCircle2 className="w-4 h-4 mr-2" /> Yes, one time only
              </Button>
              <Button
                onClick={() => {
                  setAddToSDThisRun(true);
                  addToSDRef.current = true;
                  localStorage.setItem('pdr-auto-add-to-sd', 'always');
                  setShowSDPrompt(false);
                  setShowFixModal(true);
                }}
                variant="outline"
                className="w-full justify-start h-11"
              >
                <Sparkles className="w-4 h-4 mr-2" /> Yes, and always add for future fixes
              </Button>
              <Button
                onClick={() => {
                  setAddToSDThisRun(false);
                  addToSDRef.current = false;
                  setShowSDPrompt(false);
                  setShowFixModal(true);
                }}
                variant="ghost"
                className="w-full justify-start h-11 text-muted-foreground"
              >
                <X className="w-4 h-4 mr-2" /> No thanks
              </Button>
            </div>
          </motion.div>
        </div>
      )}
      {showFixModal && <FixProgressModal
        onClose={() => { setShowFixModal(false); setHasCompletedFix(true); setPostFixFlowActive(true); }}
        totalFiles={stats.totalFiles}
        destinationPath={destinationPath}
        sources={selectedSources}
        fileResults={fileResults}
        onViewReport={() => {
          setShowFixModal(false);
          setShowReportsList(true);
          setHasCompletedFix(true);
          setPostFixFlowActive(true);
        }}
        onReportSaved={(reportId) => {
          console.log('[PDR] Report saved, ID:', reportId, '— starting auto-index...');
          setSavedReportId(reportId);
          setReportSavedMessage(true);
          setTimeout(() => setReportSavedMessage(false), 5000);
        }}
        includePhotos={includePhotos}
        includeVideos={includeVideos}
        photoFormat={photoFormat}
      />}
      {showPostFixReport && <PostFixReportModal 
        onClose={() => setShowPostFixReport(false)} 
        results={results}
        destinationPath={destinationPath}
        fileResults={fileResults}
        savedReportId={selectedReportId || savedReportId}
        onBackToReports={() => {
          setShowPostFixReport(false);
          setSelectedReportId(null);
          setShowReportsList(true);
        }}
        onNavigateToBestPractices={onNavigateToBestPractices}
      />}
      
      {showReportsList && <ReportsListModal 
        onClose={() => setShowReportsList(false)}
        onViewReport={(reportId) => {
          setSelectedReportId(reportId);
          setShowReportsList(false);
          setShowPostFixReport(true);
        }}
      />}
      
      <AnimatePresence>
        {reportSavedMessage && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 px-4 py-2 rounded-lg shadow-lg text-sm flex items-center gap-2 z-50"
          >
            <CheckCircle2 className="w-4 h-4" />
            This report is saved and can be exported later from Reports.
          </motion.div>
        )}
      </AnimatePresence>

      {/* Post-fix "Clear sources?" prompt */}
      {showClearSourcesPrompt && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
          onClick={() => { setShowClearSourcesPrompt(false); }}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            className="bg-background rounded-2xl shadow-2xl max-w-sm w-full p-6 text-center border border-border"
          >
            <div className="w-14 h-14 bg-emerald-50 dark:bg-emerald-950/30 rounded-full flex items-center justify-center mx-auto mb-4 border border-emerald-200 dark:border-emerald-700">
              <CheckCircle2 className="w-7 h-7 text-emerald-600 dark:text-emerald-400" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">Your fix is complete</h3>
            <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
              Would you like to clear your sources and start fresh?
            </p>
            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1 border-border hover:bg-secondary"
                onClick={() => {
                  setShowClearSourcesPrompt(false);
                }}
              >
                Keep Sources
              </Button>
              <Button
                className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white"
                onClick={() => {
                  setShowClearSourcesPrompt(false);
                  setHasCompletedFix(false);
                  // Clear sources — use the parent's pending clear mechanism
                  // by dispatching a custom event the parent listens for
                  window.dispatchEvent(new CustomEvent('pdr-clear-sources'));
                }}
              >
                Clear Sources
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}

      </div>{/* close counter-zoom wrapper */}
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
                <h2 className="text-2xl font-semibold text-foreground mb-1">Source Analysis</h2>
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
                <h3 className="text-lg font-medium mb-1">Destination</h3>
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

function EmptyState({ onAddFirstSource, isLicensed, onActivateLicense, onNavigateToBestPractices, hasCompletedFix, savedReportId, onViewReport }: {
  onAddFirstSource: () => void;
  isLicensed: boolean;
  onActivateLicense: () => void;
  onNavigateToBestPractices?: () => void;
  hasCompletedFix?: boolean;
  savedReportId?: string | null;
  onViewReport?: () => void;
}) {
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
              {hasCompletedFix ? (
                <div className="flex items-center justify-center">
                  <CheckCircle2 className="w-16 h-16 text-green-500" />
                </div>
              ) : (
              <>
                <img src="./assets//pdr-logo_transparent.png" alt="Photo Date Rescue" className="h-20 w-auto mx-auto dark:hidden" />
                <div className="hidden dark:flex flex-col items-center">
                  <img src="./assets//pdr-logo-stacked_transparent_dark_v2.png" alt="Photo Date Rescue" className="h-16 w-auto object-contain" />
                  <span className="text-foreground font-semibold text-lg tracking-wide mt-1">PDR</span>
                </div>
              </>
              )}
            </motion.div>

            <h1 className="text-4xl font-semibold text-foreground mb-4">
              {hasCompletedFix ? 'Fix complete' : 'Your workspace is empty'}
            </h1>

            {hasCompletedFix ? (
              // Post-fix state — warm, encouraging, with clear next steps
              <>
                <p className="text-lg text-muted-foreground mb-8 leading-relaxed">
                  Your files have been rescued and saved. You can view the report, start a new fix, or explore your library in Search & Discovery.
                </p>

                <div className="flex flex-col gap-4 justify-center items-center">
                  <div className="flex gap-3">
                    <Button
                      size="lg"
                      className="px-8 h-12 text-base shadow-lg shadow-primary/25"
                      onClick={onAddFirstSource}
                      style={{ animation: 'outline-pulse 2s ease-in-out infinite' }}
                    >
                      <Plus className="w-5 h-5 mr-2" />
                      Start New Fix
                    </Button>
                    <Button
                      size="lg"
                      variant="outline"
                      className="px-8 h-12 text-base border-2 border-primary/40 hover:border-primary hover:bg-primary/5"
                      onClick={onViewReport}
                    >
                      <FileText className="w-5 h-5 mr-2" />
                      Reports History
                    </Button>
                  </div>
                </div>
              </>
            ) : isLicensed ? (
              // Licensed user - show Add Source CTA
              <>
                <p className="text-lg text-muted-foreground mb-8 leading-relaxed inline-flex items-center justify-center gap-1 flex-wrap">
                  Add your photos and videos from any local folder, NAS, network drive, ZIP/RAR archive, or external drive to get started. Cloud storage must be downloaded first.
                  <PerformanceNudge type="source" onNavigateToBestPractices={onNavigateToBestPractices} />
                </p>

                <div className="flex flex-col gap-4 justify-center items-center">
                  <Button
                    size="lg"
                    className="px-12 h-12 text-base shadow-lg shadow-primary/25"
                    onClick={onAddFirstSource}
                    style={{ animation: 'outline-pulse 2s ease-in-out infinite' }}
                  >
                    Add Your First Source
                  </Button>
                  <button
                    onClick={() => {}}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Explore the Workspace
                  </button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      const event = new CustomEvent('open-reports-history');
                      window.dispatchEvent(event);
                    }}
                    className="border-muted-foreground/30 hover:bg-secondary hover:border-muted-foreground/50 mt-4"
                  >
                    <FileText className="w-4 h-4 mr-2" /> View Reports History
                  </Button>
                </div>
              </>
            ) : (
              // Unlicensed user - show Activate CTA
              <>
                <p className="text-lg text-muted-foreground mb-8 leading-relaxed">
                  Ready to rescue your photos? Activate your license to get started.
                </p>
                
                <div className="flex flex-col gap-4 justify-center items-center">
                  <Button 
                    size="lg" 
                    className="px-12 h-12 text-base shadow-lg shadow-primary/25 gap-2"
                    onClick={onActivateLicense}
                  >
                    <Sparkles className="w-5 h-5" />
                    Activate License
                  </Button>
                  
                  <p className="text-sm text-muted-foreground max-w-md leading-relaxed mb-4">
                    Already used Photo Date Rescue before? You can still access your past reports.
                  </p>
                  
                  <Button 
                    variant="outline"
                    onClick={() => {
                      const event = new CustomEvent('open-reports-history');
                      window.dispatchEvent(event);
                    }}
                    className="border-muted-foreground/30 hover:bg-secondary hover:border-muted-foreground/50"
                  >
                    <FileText className="w-4 h-4 mr-2" /> View Reports History
                  </Button>
                </div>
              </>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function ScanningOverlay({ message, percent, onCancel, showCancelConfirm, onConfirmCancel, onDismissCancel }: { 
  message: string; 
  percent?: number; 
  onCancel?: () => void;
  showCancelConfirm?: boolean;
  onConfirmCancel?: () => void;
  onDismissCancel?: () => void;
}) {
  const [elapsed, setElapsed] = React.useState(0);
  const startTimeRef = React.useRef(Date.now());
  const lastPercentRef = React.useRef(0);
  const lastPercentTimeRef = React.useRef(Date.now());

  React.useEffect(() => {
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  React.useEffect(() => {
    if (percent !== undefined && percent > lastPercentRef.current) {
      lastPercentRef.current = percent;
      lastPercentTimeRef.current = Date.now();
    }
  }, [percent]);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const estimatedRemaining = React.useMemo(() => {
    if (!percent || percent < 3) return null;
    const elapsedMs = Date.now() - startTimeRef.current;
    const totalEstMs = (elapsedMs / percent) * 100;
    const remainMs = totalEstMs - elapsedMs;
    return Math.max(0, Math.round(remainMs / 1000));
  }, [percent, elapsed]);

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
        <div className="mb-8">
          <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-6 relative">
            {showCancelConfirm ? (
              <img src="./assets/pdr-logo_transparent.png" className="w-10 h-10 object-contain" alt="PDR" />
            ) : (
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            )}
          </div>
          <h2 className="text-2xl font-semibold text-foreground mb-2">
            {showCancelConfirm ? 'Cancel Analysis?' : 'Analyzing...'}
          </h2>
          <p className="text-muted-foreground">
            {showCancelConfirm ? 'Analysis is still running in the background' : 'Reading metadata from your files'}
          </p>
        </div>

        <div className="space-y-2 mb-6">
          <div className="flex justify-between text-sm font-medium">
            <span>{percent !== undefined && percent > 0 
              ? (message.includes('Unpacking') || message.includes('Unpacked') ? 'Unpacking...' : 'Processing...') 
              : 'Preparing...'}</span>
            <span>{percent !== undefined && percent > 0 ? `${percent}%` : ''}</span>
          </div>
          {percent !== undefined && percent > 0 ? (
            <Progress value={percent} className="h-2" />
          ) : (
            <div className="w-full h-2 bg-secondary rounded-full overflow-hidden">
              <div className="h-full bg-primary/50 animate-pulse" style={{ width: '100%' }} />
            </div>
          )}
          <p className="text-xs text-muted-foreground text-left pt-1">
            {message}
          </p>
          <div className="flex justify-between text-xs text-muted-foreground pt-2">
            <span>Elapsed: {formatTime(elapsed)}</span>
            {estimatedRemaining !== null && percent !== undefined && percent >= 3 ? (
              <span>~{formatTime(estimatedRemaining)} remaining</span>
            ) : percent !== undefined && percent > 0 && percent < 3 ? (
              <span className="text-muted-foreground/60">Estimating time...</span>
            ) : null}
          </div>
          {elapsed > 15 && (
            <p className="text-xs text-muted-foreground mt-1.5 italic">
              Tip: Close other apps and avoid running intensive tasks on your PC to speed this up.
            </p>
          )}
        </div>

        {!showCancelConfirm ? (
          onCancel && (
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground hover:text-foreground border-muted-foreground/30 hover:border-muted-foreground/50"
              onClick={onCancel}
            >
              Cancel
            </Button>
          )
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl p-4 text-left space-y-3"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
              <div>
                <h4 className="text-sm font-semibold text-foreground">Stop this analysis?</h4>
                <p className="text-xs text-muted-foreground mt-1">
                  Any progress will be lost and you'll need to re-analyse this source. Large libraries or network sources can take time — closing other apps may help speed things up.
                </p>
                <p className="text-xs text-muted-foreground italic mt-1.5">
                  Tip: You can open another PDR window from your Start Menu if needed.
                </p>
              </div>
            </div>
            <div className="flex gap-3 pt-1">
              <Button 
                variant="outline" 
                size="sm"
                className="flex-1 border-muted-foreground/30" 
                onClick={onDismissCancel}
              >
                Continue Analysis
              </Button>
              <Button
                size="sm"
                className="flex-1 bg-amber-500 hover:bg-amber-600 text-white"
                onClick={onConfirmCancel}
              >
                Yes, Cancel
              </Button>
            </div>
          </motion.div>
        )}
      </motion.div>
    </motion.div>
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
                <h2 className="text-2xl font-semibold text-foreground mb-1">Source Analysis</h2>
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
                <h3 className="text-lg font-medium mb-1">Destination</h3>
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
                  <span className="text-2xl font-semibold text-emerald-600 font-heading">{results.fixed}</span>
                </div>
                <div className="flex items-center justify-between px-4 py-3 bg-background/50 rounded-lg">
                  <span className="text-muted-foreground">Files unchanged</span>
                  <span className="text-2xl font-semibold text-foreground font-heading">{results.unchanged}</span>
                </div>
                <div className="flex items-center justify-between px-4 py-3 bg-background/50 rounded-lg">
                  <span className="text-muted-foreground">Files skipped</span>
                  <span className="text-2xl font-semibold text-amber-600 font-heading">{results.skipped}</span>
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

function ConfidenceCard({ level, count, percentage, description, color, bgColor, borderColor, icon, isActive, onClick, tooltip, onNavigateToBestPractices }: any) {
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
                  <TooltipContent side="top" className="max-w-[280px] p-3 text-sm">
                    <p>
                      {tooltip}{' '}
                      {onNavigateToBestPractices && (
                        <>
                          Learn more in{' '}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onNavigateToBestPractices();
                            }}
                            className="font-bold text-foreground hover:underline cursor-pointer"
                          >
                            Best Practices
                          </button>
                          .
                        </>
                      )}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
        <div className="flex items-baseline gap-2 mb-2">
          <div className="text-4xl font-bold text-foreground font-heading">{count.toLocaleString()}</div>
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
  
  const realFiles = Object.values(fileResults || {}).flatMap(source => source.files || []);
  const allFiles = realFiles;
  
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
        <div className="p-6 border-b border-border relative bg-background text-center">
          <h2 className="text-xl font-semibold text-foreground">Preview Changes</h2>
          <p className="text-sm text-muted-foreground">
            {allFiles.length.toLocaleString()} files analyzed — review proposed renames before applying
          </p>
          <button onClick={onClose} className="absolute right-4 top-1/2 -translate-y-1/2 p-2 hover:bg-secondary rounded-full transition-colors">
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
                      <IconTooltip label={file.filename} side="top">
                        <div className="font-mono text-muted-foreground truncate text-xs">
                          {file.filename}
                        </div>
                      </IconTooltip>
                      <ArrowRight className={`w-4 h-4 flex-shrink-0 ${willRename ? 'text-emerald-500' : 'text-muted-foreground/30'}`} />
                      <IconTooltip label={file.suggestedFilename || file.filename} side="top">
                        <div
                          className={`font-mono truncate text-xs ${willRename ? getConfidenceColor(file.dateConfidence) + ' font-medium' : 'text-muted-foreground'}`}
                        >
                          {file.suggestedFilename || file.filename}
                        </div>
                      </IconTooltip>
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

const REVIEW_PROMPT_STORAGE_KEY = 'pdr-review-prompt-dismissed';
const TRUSTPILOT_URL = 'https://www.trustpilot.com/review/photodaterescue.com';

function ReviewPromptAccordion({ 
  confirmedCount, 
  recoveredCount, 
  markedCount,
  totalFiles,
  onDismiss 
}: { 
  confirmedCount: number;
  recoveredCount: number;
  markedCount: number;
  totalFiles: number;
  onDismiss: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [permanentlyDismissed, setPermanentlyDismissed] = useState(false);
  const [dontAskAgainChecked, setDontAskAgainChecked] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);
  const [animationPhase, setAnimationPhase] = useState<'gold' | 'trace' | 'static'>('gold');
  const [animationComplete, setAnimationComplete] = useState(false);
  const [userHasInteracted, setUserHasInteracted] = useState(false);
  
  useEffect(() => {
    const stored = localStorage.getItem(REVIEW_PROMPT_STORAGE_KEY);
    if (stored === 'permanent') {
      setPermanentlyDismissed(true);
    }
  }, []);
  
  useEffect(() => {
    const goldTimer = setTimeout(() => {
      setAnimationPhase('trace');
    }, 15500);
    
    const traceTimer = setTimeout(() => {
      setAnimationPhase('static');
    }, 22000);
    
    const animationDoneTimer = setTimeout(() => {
      setAnimationComplete(true);
    }, 23000);
    
    return () => {
      clearTimeout(goldTimer);
      clearTimeout(traceTimer);
      clearTimeout(animationDoneTimer);
    };
  }, []);
  
  useEffect(() => {
    if (animationComplete && isExpanded && !userHasInteracted) {
      const collapseTimer = setTimeout(() => {
        setIsExpanded(false);
      }, 2000);
      return () => clearTimeout(collapseTimer);
    }
  }, [animationComplete, isExpanded, userHasInteracted]);
  
  useEffect(() => {
    if (dontAskAgainChecked) {
      localStorage.setItem(REVIEW_PROMPT_STORAGE_KEY, 'permanent');
    } else {
      localStorage.removeItem(REVIEW_PROMPT_STORAGE_KEY);
    }
  }, [dontAskAgainChecked]);
  
  const actualTotal = confirmedCount + recoveredCount + markedCount;
  const successRate = actualTotal > 0 ? (confirmedCount + recoveredCount) / actualTotal : 0;
  const successPercent = Math.round(successRate * 100);
  const shouldShow = successRate >= 0.88 && !permanentlyDismissed && !dismissed;
  
  if (!shouldShow) return null;
  
const handleLeaveReview = async () => {
  try {
    const { openExternalUrl } = await import('@/lib/electron-bridge');
    await openExternalUrl(TRUSTPILOT_URL);
  } catch (error) {
    // Fallback for non-Electron environment
    window.open(TRUSTPILOT_URL, '_blank', 'noopener,noreferrer');
  }
  setUserHasInteracted(true);
  setIsExpanded(false);
};
  
  const handleToggle = () => {
    setUserHasInteracted(true);
    setIsExpanded(!isExpanded);
  };
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ delay: 0.5, duration: 0.3 }}
      className="mt-6 relative"
    >
      {animationPhase === 'gold' && (
        <div className="absolute -inset-[1px] rounded-xl overflow-hidden pointer-events-none">
          <div 
            className="absolute inset-0"
            style={{
              background: 'conic-gradient(from 0deg, transparent 0deg, rgba(212, 175, 55, 0.5) 20deg, rgba(212, 175, 55, 0.8) 60deg, rgba(212, 175, 55, 0.95) 90deg, rgba(212, 175, 55, 0.8) 120deg, rgba(212, 175, 55, 0.5) 160deg, transparent 180deg)',
              animation: 'reviewGoldSpin 15s linear forwards',
              animationDelay: '0.5s',
            }}
          />
        </div>
      )}
      
      {animationPhase === 'trace' && (
        <div className="absolute inset-0 rounded-xl pointer-events-none overflow-hidden">
          <svg className="absolute inset-0 w-full h-full" style={{ transform: 'scale(1.01)' }}>
            <rect
              x="1"
              y="1"
              width="calc(100% - 2px)"
              height="calc(100% - 2px)"
              rx="12"
              ry="12"
              fill="none"
              stroke="hsl(262, 83%, 68%)"
              strokeWidth="2.5"
              strokeDasharray="1000"
              strokeDashoffset="1000"
              style={{
                animation: 'reviewOutlineTrace 6s ease-out forwards',
              }}
            />
          </svg>
        </div>
      )}
      
      <style>{`
        @keyframes reviewGoldSpin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(1440deg); }
        }
        @keyframes reviewOutlineTrace {
          0% { stroke-dashoffset: 1000; }
          100% { stroke-dashoffset: 0; }
        }
        @keyframes reviewCtaGlow {
          0%, 100% { box-shadow: 0 0 0 0 rgba(212, 175, 55, 0); }
          50% { box-shadow: 0 0 16px 3px rgba(212, 175, 55, 0.5); }
        }
      `}</style>
      
      <div className={`relative rounded-xl transition-all duration-500 overflow-hidden ${
        animationPhase === 'static' 
          ? 'border-2 border-primary/50' 
          : 'border border-primary/30'
      }`}>
        <button
          onClick={handleToggle}
          className="w-full flex items-center justify-between p-4 bg-gradient-to-r from-amber-50/90 to-primary/10 dark:from-amber-950/40 dark:to-primary/15 hover:from-amber-50 hover:to-primary/15 dark:hover:from-amber-950/50 dark:hover:to-primary/20 transition-colors text-left"
          data-testid="button-review-accordion-toggle"
        >
          <div className="flex items-center gap-3">
            <div className="p-1.5 bg-amber-100 dark:bg-amber-900/60 rounded-lg shrink-0 shadow-sm">
              <Star className="w-4 h-4 text-amber-500 dark:text-amber-400" fill="currentColor" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                {isExpanded ? 'Share your experience' : 'Leave a review?'}
              </span>
              <span className="inline-flex items-center px-2.5 py-1 text-xs font-semibold rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700 shadow-sm">
                {successPercent}% success
              </span>
            </div>
          </div>
          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`} />
        </button>
        
        <motion.div
          initial={false}
          animate={{ 
            height: isExpanded ? 'auto' : 0,
            opacity: isExpanded ? 1 : 0
          }}
          transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
          className="overflow-hidden"
        >
          <div className="p-4 pt-0 bg-gradient-to-r from-amber-50/50 to-primary/5 dark:from-amber-950/20 dark:to-primary/10">
            <div className="pt-3 border-t border-primary/10">
              <p className="text-sm text-foreground mb-1">
                This was a strong result for this library.
              </p>
              <p className="text-xs text-muted-foreground mb-4">
                If you have a moment, a quick review helps others decide if PDR is right for them.
              </p>
              
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={handleLeaveReview}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 dark:from-amber-600 dark:to-amber-700 dark:hover:from-amber-500 dark:hover:to-amber-600 text-white shadow-md hover:shadow-lg transition-all duration-200"
                  style={{ animation: animationPhase === 'static' ? 'reviewCtaGlow 3s ease-in-out infinite' : 'none' }}
                  data-testid="button-leave-review"
                >
                  <Star className="w-4 h-4" fill="currentColor" />
                  Leave a Review
                  <ExternalLink className="w-3.5 h-3.5 opacity-70" />
                </button>
                
                <label className="inline-flex items-center gap-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                  <input
                    type="checkbox"
                    checked={dontAskAgainChecked}
                    onChange={(e) => setDontAskAgainChecked(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-muted-foreground/30 text-primary focus:ring-primary/30 cursor-pointer"
                    data-testid="checkbox-dont-ask-again"
                  />
                  Don't ask again
                </label>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}

function CardInfoTooltip({ onNavigateToBestPractices, children }: { onNavigateToBestPractices?: () => void; children: React.ReactNode }) {
  const [isVisible, setIsVisible] = React.useState(false);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);
  const hideTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = () => { clearTimeout(hideTimer.current); setIsVisible(true); };
  const hide = () => { hideTimer.current = setTimeout(() => setIsVisible(false), 250); };

  React.useEffect(() => {
    if (isVisible && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const w = 288;
      setPos({ top: rect.top - 8, left: Math.max(8, Math.min(rect.right - w, window.innerWidth - w - 8)) });
    }
  }, [isVisible]);

  return (
    <>
      <button ref={btnRef} onMouseEnter={show} onMouseLeave={hide} onClick={(e) => { e.stopPropagation(); setIsVisible(!isVisible); }}
        className="p-0.5 text-[#9b8bb8] hover:text-[#7b6b98] transition-colors" type="button">
        <Info className="w-3.5 h-3.5" />
      </button>
      {isVisible && pos && ReactDOM.createPortal(
        <div className="fixed w-72 p-3 bg-background border border-[#9b8bb8]/30 rounded-lg shadow-lg text-xs text-muted-foreground z-[9999]"
          style={{ bottom: `${window.innerHeight - pos.top}px`, left: pos.left }}
          onMouseEnter={show} onMouseLeave={hide}
        >
          {children}
          {onNavigateToBestPractices && (
            <div className="mt-2 pt-2 border-t border-[#9b8bb8]/20">
              <button onClick={(e) => { e.stopPropagation(); setIsVisible(false); onNavigateToBestPractices(); }}
                className="font-bold text-foreground hover:underline cursor-pointer text-xs">
                Best Practices
              </button>
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  );
}

function PerformanceNudge({ type, onNavigateToBestPractices }: { type: 'source' | 'destination' | 'path'; onNavigateToBestPractices?: () => void }) {
  const [isVisible, setIsVisible] = React.useState(false);
  const hideTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const message = type === 'source'
    ? <>If your network drive or cloud storage doesn't appear when browsing, try pasting the full path directly into the file picker.<br /><br />For example: <strong>\\MyCloud\Photos\2022</strong><br /><br />This is the most reliable way to access files on a NAS, home cloud, or shared network drive.</>
    : type === 'destination'
    ? <>For best performance, connect your destination directly.<br /><br />Copying large volumes over Wi-Fi can bottleneck performance — this is a hardware/network limitation, not a PDR issue.</>
    : <>For best results, save your sources (folders and ZIPs) close to the root of your drive.<br /><br />For example, <strong>C:\Photos</strong> rather than <strong>C:\Users\Name\Documents\Backups\Old\Photos</strong>. Shorter paths help PDR read date information more reliably.</>;

  const showTooltip = () => {
    if (hideTimeoutRef.current) { clearTimeout(hideTimeoutRef.current); hideTimeoutRef.current = null; }
    setIsVisible(true);
  };

  const scheduleHide = () => {
    hideTimeoutRef.current = setTimeout(() => setIsVisible(false), 250);
  };

  React.useEffect(() => {
    return () => { if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current); };
  }, []);

  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const [tooltipPos, setTooltipPos] = React.useState<{ top: number; left: number } | null>(null);

  React.useEffect(() => {
    if (isVisible && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const tooltipW = 288; // w-72
      if (type === 'source') {
        // Open below, aligned left but clamped to viewport
        setTooltipPos({ top: rect.bottom + 8, left: Math.max(8, Math.min(rect.left, window.innerWidth - tooltipW - 8)) });
      } else if (type === 'destination') {
        // Open above, aligned right
        setTooltipPos({ top: rect.top - 8, left: Math.max(8, Math.min(rect.right - tooltipW, window.innerWidth - tooltipW - 8)) });
      } else {
        // Open above, aligned left
        setTooltipPos({ top: rect.top - 8, left: Math.max(8, Math.min(rect.left, window.innerWidth - tooltipW - 8)) });
      }
    }
  }, [isVisible, type]);

  return (
    <div className="relative inline-flex items-center ml-1">
      <button
        ref={buttonRef}
        onMouseEnter={showTooltip}
        onMouseLeave={scheduleHide}
        onClick={(e) => { e.stopPropagation(); setIsVisible(!isVisible); }}
        className="p-0.5 text-[#9b8bb8] hover:text-[#7b6b98] transition-colors"
        aria-label="Performance tip"
        type="button"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {isVisible && tooltipPos && ReactDOM.createPortal(
        <div
          className="fixed w-72 p-3 bg-background border border-[#9b8bb8]/30 rounded-lg shadow-lg text-xs text-muted-foreground z-[9999] overflow-hidden"
          style={{
            overflowWrap: 'break-word',
            wordBreak: 'break-word',
            top: type === 'source' ? tooltipPos.top : undefined,
            bottom: type !== 'source' ? `${window.innerHeight - tooltipPos.top}px` : undefined,
            left: tooltipPos.left,
          }}
          onMouseEnter={showTooltip}
          onMouseLeave={scheduleHide}
        >
          <div className="font-medium text-foreground mb-1 text-xs">Performance Tip</div>
          <div>{message}</div>
          {onNavigateToBestPractices && (
            <div className="mt-2 pt-2 border-t border-[#9b8bb8]/20">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsVisible(false);
                  onNavigateToBestPractices();
                }}
                className="font-bold text-foreground hover:underline cursor-pointer text-xs"
              >
                Best Practices
              </button>
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

function FixProgressModal({ onClose, totalFiles, destinationPath, sources, fileResults, onViewReport, onReportSaved, includePhotos, includeVideos, photoFormat }: {
  onClose: () => void,
  totalFiles: number,
  destinationPath: string | null,
  sources?: Source[],
  fileResults?: Record<string, SourceAnalysisResult>,
  onViewReport: () => void,
  onReportSaved?: (reportId: string) => void,
  includePhotos: boolean,
  includeVideos: boolean,
  photoFormat: 'original' | 'png' | 'jpg'
}) {
  const [progress, setProgress] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const [processed, setProcessed] = useState(0);
  const [isElectronEnv, setIsElectronEnv] = useState(false);
  const [reportSaved, setReportSaved] = useState(false);
  const [skippedExisting, setSkippedExisting] = useState(0);
  const [showCancelFixConfirm, setShowCancelFixConfirm] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [showMasterLibMsg, setShowMasterLibMsg] = useState(() => {
    return localStorage.getItem('pdr-master-lib-dismissed') !== 'true';
  });
  const masterLibCountedRef = React.useRef(false);
  const [elapsed, setElapsed] = useState(0);
  const [totalTime, setTotalTime] = useState(0);
  const [isPrescanning, setIsPrescanning] = useState(true);
  const [prescanCount, setPrescanCount] = useState(0);
  // Network-destination staging phase. 'staging' = local writes,
  // 'mirror' = robocopy /MT:16 pushing to the network share. Drives
  // the status text so users understand why the % bar may briefly
  // sit at 100% during the network upload.
  const [copyPhase, setCopyPhase] = useState<'staging' | 'mirror' | null>(null);
  const [mirrorFilesDone, setMirrorFilesDone] = useState(0);
  const [mirrorFilesTotal, setMirrorFilesTotal] = useState(0);
  // When true, the full-screen takeover collapses to a compact chip
  // pinned top-right so the user can navigate to PM / Trees / S&D /
  // Memories / Edit Dates while the fix continues running. The
  // component stays mounted either way — the IPC callbacks keep
  // firing, state keeps updating, the chip just shows a condensed
  // view. Click the chip to restore the full modal. Auto-resets
  // when the fix completes (so the completion screen can't be
  // missed).
  const [fixMinimized, setFixMinimized] = useState(false);
  const startTimeRef = React.useRef(Date.now());
  const fixSnapshotRef = React.useRef<{
    // Display counts
    totalScanned: number;
    confirmed: number;
    recovered: number;
    marked: number;
    duplicatesRemoved: number;
    skippedExisting: number;
    duplicateFiles: Array<{ filename: string; duplicateOf: string; duplicateMethod?: 'hash' | 'heuristic' }>;
    // Full report data for persistence
    reportData: {
      sources: Array<{ path: string; type: 'folder' | 'zip' | 'drive'; label: string }>;
      destinationPath: string;
      counts: { confirmed: number; recovered: number; marked: number; total: number };
      duplicatesRemoved: number;
      duplicateFiles: Array<{ filename: string; duplicateOf: string; duplicateMethod?: 'hash' | 'heuristic' }>;
      totalScanned: number;
      files: Array<{ originalFilename: string; newFilename: string; confidence: 'confirmed' | 'recovered' | 'marked'; dateSource: string; sourcePath?: string; exifWritten?: boolean; exifSource?: string }>;
    };
  } | null>(null);

    const handleCancelFix = async () => {
    setIsCancelling(true);
    const { cancelCopyFiles, setFixInProgress } = await import('@/lib/electron-bridge');
    await cancelCopyFiles();
    await setFixInProgress(false);
    onClose();
  };
  
  useEffect(() => {
    import('@/lib/electron-bridge').then(({ isElectron }) => {
      setIsElectronEnv(isElectron());
    });
  }, []);

  // Increment master library message seen count when fix completes
  useEffect(() => {
    if (!isComplete || masterLibCountedRef.current) return;
    masterLibCountedRef.current = true;
    const count = parseInt(localStorage.getItem('pdr-master-lib-seen-count') || '0', 10);
    localStorage.setItem('pdr-master-lib-seen-count', String(count + 1));
  }, [isComplete]);
  
  useEffect(() => {
    if (isComplete) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [isComplete]);

  // Listen for the App-level FixStatusChip's "Open" click — the
  // chip dispatches a 'pdr:fix:restore' window event, we flip
  // fixMinimized back to false so the full modal reappears.
  useEffect(() => {
    const handler = () => setFixMinimized(false);
    window.addEventListener('pdr:fix:restore', handler);
    return () => window.removeEventListener('pdr:fix:restore', handler);
  }, []);

  // Broadcast progress cross-window so PM (separate window) renders
  // a real chip. THROTTLED to once per ~250ms — without throttling,
  // a 391-file fix kicks off ~500+ IPC round-trips for progress
  // updates alone, which we measured adding ~30-60s to total run
  // time on slow links. 250ms is fine for a chip — the human eye
  // doesn't perceive sub-quarter-second updates anyway.
  const lastBroadcastRef = useRef(0);
  useEffect(() => {
    if (isComplete) return;
    const now = Date.now();
    // Always allow phase transitions through — they're rare and
    // important to show immediately.
    const phase: 'prescan' | 'staging' | 'mirror' | 'applying' | null = isPrescanning
      ? 'prescan'
      : copyPhase === 'mirror'
        ? 'mirror'
        : copyPhase === 'staging'
          ? 'staging'
          : 'applying';
    if (now - lastBroadcastRef.current < 250) return;
    lastBroadcastRef.current = now;
    import('@/lib/electron-bridge').then(({ broadcastFixProgress }) => {
      void broadcastFixProgress({
        phase,
        processed,
        total: totalFiles,
        progressPct: Math.round(progress),
        mirrorDone: mirrorFilesDone,
        mirrorTotal: mirrorFilesTotal,
        prescanCount,
        elapsed,
        isPrescanning,
      });
    }).catch(() => { /* non-fatal */ });
  }, [isComplete, isPrescanning, copyPhase, processed, totalFiles, progress, mirrorFilesDone, mirrorFilesTotal, prescanCount, elapsed]);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const estimatedRemaining = React.useMemo(() => {
    if (progress < 3) return null;
    const elapsedMs = Date.now() - startTimeRef.current;
    const totalEstMs = (elapsedMs / progress) * 100;
    const remainMs = totalEstMs - elapsedMs;
    return Math.max(0, Math.round(remainMs / 1000));
  }, [progress, elapsed]);

  const copyStartedRef = React.useRef(false);
  useEffect(() => {
    if (isComplete || !destinationPath || copyStartedRef.current) return;
    copyStartedRef.current = true;

    const copyFilesAsync = async () => {
      const { copyFiles, onCopyProgress, onCopyPhase, onCopyMirrorProgress, isElectron, setFixInProgress } = await import('@/lib/electron-bridge');

      // Notify main process that a fix is in progress (protects against accidental close)
      await setFixInProgress(true);
      
      if (!isElectron()) {
        // Fake progress for non-Electron
        const interval = setInterval(() => {
          setProgress(prev => {
            const next = prev + 2;
            if (next >= 100) {
              setIsComplete(true);
			  setShowCancelFixConfirm(false);
              return 100;
            }
            return next;
          });
          setProcessed(prev => Math.min(prev + Math.ceil(totalFiles / 50), totalFiles));
        }, 50);
        return () => clearInterval(interval);
      }
      
      // Build file list for copying (using Set to prevent duplicates)
      const filesToCopy: Array<{ sourcePath: string; newFilename: string; sourceType: 'folder' | 'zip'; derivedDate?: string | null; dateConfidence?: string; dateSource?: string; isDuplicate?: boolean; duplicateOf?: string; originSourcePath?: string }> = [];
      const zipPaths: Record<string, string> = {};
      const addedPaths = new Set<string>();
      
      console.log('[Fix] fileResults keys:', Object.keys(fileResults || {}));
      console.log('[Fix] sources:', sources?.map(s => ({ id: s.id, path: s.path, selected: s.selected })));
      Object.entries(fileResults || {}).forEach(([sourceKey, sourceData]) => {
        const source = sources?.find(s => s.id === sourceKey || s.path === sourceData.sourcePath);
        console.log(`[Fix] sourceKey=${sourceKey}, sourcePath=${sourceData.sourcePath}, matched=${!!source}, selected=${source?.selected}, files=${sourceData.files?.length}`);
        // Skip sources that are not selected
        if (!source?.selected) return;
        const sourceType = source?.type || 'folder';
        
        if (sourceType === 'zip' && sourceData.sourcePath) {
          zipPaths[sourceData.sourcePath] = sourceData.sourcePath;
        }
        
        sourceData.files.forEach(file => {
          // Skip if we've already added this file (prevent duplicates)
          if (addedPaths.has(file.path)) return;
          
          // Filter by Photos/Videos toggles
          if (file.type === 'photo' && !includePhotos) return;
          if (file.type === 'video' && !includeVideos) return;
          
          addedPaths.add(file.path);
          
          filesToCopy.push({
            sourcePath: file.path,
            newFilename: file.suggestedFilename || file.filename,
            sourceType: (sourceType === 'zip' && (sourceData as any)._extractedTempDir) ? 'folder' : (sourceType === 'zip' ? 'zip' : 'folder'),
            derivedDate: file.derivedDate,
            dateConfidence: file.dateConfidence,
            dateSource: file.dateSource,
            isDuplicate: file.isDuplicate,
            duplicateOf: file.duplicateOf,
            originSourcePath: sourceData.sourcePath
          });
        });
    });

      console.log(`[Fix] filesToCopy: ${filesToCopy.length} files`);
      if (filesToCopy.length === 0) {
        console.warn('[Fix] WARNING: No files to copy! Check source matching above.');
      }

      // Listen for progress updates
      onCopyProgress((prog) => {
        setProcessed(prog.current);
        setProgress(Math.round((prog.current / prog.total) * 100));
      });
      // Phase + mirror-progress listeners — only fire when the
      // backend chose the network-staging path. Outside Electron or
      // for local destinations these are silent and copyPhase stays
      // null (UI behaves exactly as before).
      onCopyPhase((p) => {
        setCopyPhase(p.phase);
      });
      onCopyMirrorProgress((p) => {
        setMirrorFilesDone(p.filesMirrored);
        setMirrorFilesTotal(p.totalToMirror);
      });

      // Fetch current settings
      const { getSettings, prescanDestination, onDestinationPrescanProgress } = await import('@/lib/electron-bridge');
      const settings = await getSettings();

      // Pre-scan destination for existing files (cross-run duplicate prevention)
      let existingDestinationHashes: Record<string, string> | undefined;
      let existingDestinationHeuristics: Record<string, string> | undefined;
      if (settings.skipDuplicates) {
        setIsPrescanning(true);
        // Listen for prescan progress
        const removePrescanListener = onDestinationPrescanProgress((data) => {
          setPrescanCount(data.scanned);
        });
        const prescanResult = await prescanDestination(destinationPath);
        removePrescanListener?.();
        if (prescanResult.success && prescanResult.data) {
          existingDestinationHashes = prescanResult.data.hashes;
          existingDestinationHeuristics = prescanResult.data.heuristics;
        }
      }
      setIsPrescanning(false);
      
      // Actually copy files
      const folderStructure = localStorage.getItem('pdr-folder-structure') as 'year' | 'year-month' | 'year-month-day' || 'year';
      const result = await copyFiles({
        files: filesToCopy,
        destinationPath: destinationPath,
        zipPaths,
        folderStructure,
        settings: {
          skipDuplicates: settings.skipDuplicates,
          thoroughDuplicateMatching: settings.thoroughDuplicateMatching,
          writeExif: settings.writeExif,
          exifWriteConfirmed: settings.exifWriteConfirmed,
          exifWriteRecovered: settings.exifWriteRecovered,
          exifWriteMarked: settings.exifWriteMarked
        },
        existingDestinationHashes,
        existingDestinationHeuristics,
        photoFormat,
      });
      
      console.log(`[Fix] Copy result:`, { success: result.success, copied: result.copied, failed: result.failed, duplicatesRemoved: result.duplicatesRemoved, skippedExisting: result.skippedExisting, resultsCount: result.results?.length });

      setProgress(100);
      setProcessed(totalFiles);
      // Build complete snapshot ONCE - this is the single source of truth
      const writeDuplicatesRemoved = result.duplicatesRemoved || 0;
      const writeDuplicateFiles = result.duplicateFiles || [];
      const writeSkippedExisting = result.skippedExisting || 0;
      
      // Build EXIF result lookup from copy results
      const exifResultMap = new Map<string, { exifWritten: boolean; exifSource?: string }>();
      if (result.results) {
        for (const r of result.results) {
          if (r.success && r.sourcePath) {
            exifResultMap.set(r.sourcePath, {
              exifWritten: r.exifWritten || false,
              exifSource: r.exifSource
            });
          }
        }
      }
      
      // Build source info
      const sourceInfos = (sources || []).filter(s => s.path).map(s => ({
        path: s.path!,
        type: s.type,
        label: s.label
      }));
      
      // Build file list and counts in one pass
      const allFiles: Array<{ originalFilename: string; newFilename: string; confidence: 'confirmed' | 'recovered' | 'marked'; dateSource: string; sourcePath?: string; exifWritten?: boolean; exifSource?: string }> = [];
      let confirmedCount = 0;
      let recoveredCount = 0;
      let markedCount = 0;
      
      Object.values(fileResults || {}).forEach((sourceData, index) => {
        // Get source key to check selection
        const sourceKeys = Object.keys(fileResults || {});
        const sourceKey = sourceKeys[index];
        const source = sources?.find(s => s.id === sourceKey || s.path === sourceData.sourcePath);
        if (!source?.selected) return;
        
        (sourceData.files || []).forEach(file => {
          if (file.isDuplicate) return;
          if (file.type === 'photo' && !includePhotos) return;
          if (file.type === 'video' && !includeVideos) return;
          
          // Count by confidence
          if (file.dateConfidence === 'confirmed') confirmedCount++;
          else if (file.dateConfidence === 'recovered') recoveredCount++;
          else markedCount++;
          
          // Build file record with EXIF result from copy operation
          const exifResult = exifResultMap.get(file.path);
          allFiles.push({
            originalFilename: file.filename,
            newFilename: file.suggestedFilename || file.filename,
            confidence: file.dateConfidence,
            dateSource: file.dateSource,
            sourcePath: sourceData.sourcePath || '',
            exifWritten: exifResult?.exifWritten || false,
            exifSource: exifResult?.exifSource
          });
        });
      });
      
      // Set complete snapshot BEFORE triggering re-render
      fixSnapshotRef.current = {
        totalScanned: totalFiles,
        confirmed: confirmedCount,
        recovered: recoveredCount,
        marked: markedCount,
        duplicatesRemoved: writeDuplicatesRemoved,
        skippedExisting: writeSkippedExisting,
        duplicateFiles: writeDuplicateFiles,
        reportData: {
          sources: sourceInfos,
          destinationPath: destinationPath,
          counts: {
            confirmed: confirmedCount,
            recovered: recoveredCount,
            marked: markedCount,
            total: allFiles.length
          },
          duplicatesRemoved: writeDuplicatesRemoved,
          duplicateFiles: writeDuplicateFiles,
          totalScanned: totalFiles,
          files: allFiles
        }
      };
      
      setSkippedExisting(writeSkippedExisting);
      setTotalTime(Math.floor((Date.now() - startTimeRef.current) / 1000));
      setIsComplete(true);

      // Clear fix-in-progress flag (allows window close again)
      await setFixInProgress(false);

      // Play completion sound if enabled
      const soundEnabled = localStorage.getItem('pdr-completion-sound') !== 'false';
		if (soundEnabled) {
		  const { playCompletionSound, flashTaskbar } = await import('@/lib/electron-bridge');
		  await playCompletionSound();
		  await flashTaskbar();
		}

      if (!result.success) {
        console.error('File copy failed:', result.error);
      }
    };
    
    copyFilesAsync();
  }, [destinationPath, fileResults, sources, totalFiles, isComplete]);

  useEffect(() => {
    if (isComplete) setProcessed(totalFiles);
  }, [isComplete, totalFiles]);

  useEffect(() => {
    if (isComplete && !reportSaved && destinationPath && fixSnapshotRef.current) {
      setReportSaved(true);
      
      const saveReportAsync = async () => {
        const { saveReport, isElectron } = await import('@/lib/electron-bridge');
        
        // Use the pre-built snapshot - no recomputation
        const reportData = fixSnapshotRef.current!.reportData;

        if (isElectron()) {
          const result = await saveReport(reportData);
          if (result.success && result.data && onReportSaved) {
            onReportSaved(result.data.id);
          }
        } else if (onReportSaved) {
          onReportSaved(`report-${Date.now()}`);
        }
      };
      
      saveReportAsync();
    }
  }, [isComplete, reportSaved, destinationPath, onReportSaved]);

  const handleOpenDestination = async () => {
    if (destinationPath && isElectronEnv) {
      const { openDestinationFolder } = await import('@/lib/electron-bridge');
      await openDestinationFolder(destinationPath);
    }
  };

    // Use snapshot values for consistency
  const confirmedCount = fixSnapshotRef.current?.confirmed ?? 0;
  const recoveredCount = fixSnapshotRef.current?.recovered ?? 0;
  const markedCount = fixSnapshotRef.current?.marked ?? 0;
  
  // When minimised, render NOTHING from this component — the
  // App-level FixStatusChip is the single source of truth for
  // the chip across every PDR surface (Home, Source Selection,
  // Workspace, PM, Date Editor, Viewer). Clicking that chip's
  // "Open" button dispatches a 'pdr:fix:restore' window event
  // which we listen for below to flip back to the full modal.
  if (!isComplete && fixMinimized) {
    return null;
  }

  // Full modal — also portalled so the completion screen pops up
  // even when the user is on Memories / Trees / S&D / Edit Dates
  // (where the modal's natural parent is display:none-hidden).
  // Without this, isComplete=true would re-render the modal but
  // the user would never see it until they navigated back to
  // Dashboard manually. Same anchor as the chip.
  const fullModalPortalTarget = typeof document !== 'undefined' ? document.getElementById('pdr-fix-chip-portal') : null;
  const fullModalNode = (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="bg-background rounded-2xl shadow-2xl max-w-md w-full p-8 text-center border border-border relative"
      >
        {/* "Work in background" — pulsing primary-tinted pill at the
            top of the modal so users discover the escape hatch
            instead of staring at a frozen progress bar. Hidden on
            the completion screen because the user explicitly needs
            to acknowledge that with View Report / Close / Open
            Destination. animate-pulse-cta is the same attention-
            grabbing pulse used on PM's Verify CTA. */}
        {!isComplete && (
          <button
            type="button"
            onClick={() => setFixMinimized(true)}
            className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1.5 rounded-full text-[12px] font-semibold text-white bg-amber-500 shadow-lg ring-2 ring-amber-300/60 hover:bg-amber-600 transition-colors flex items-center gap-1.5 animate-pulse-cta whitespace-nowrap"
            data-testid="button-minimize-fix"
            title="Hide this view and keep working in PDR while the fix runs"
          >
            <ChevronDown className="w-3.5 h-3.5" />
            Work in background
          </button>
        )}
        {!isComplete ? (
          <>
            <div className="mb-8">
              <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-6 relative">
                 <Loader2 className="w-8 h-8 text-primary animate-spin" />
              </div>
              <h2 className="text-2xl font-semibold text-foreground mb-2">
                {isPrescanning ? 'Preparing...' : copyPhase === 'mirror' ? 'Uploading to network…' : 'Applying Fixes...'}
              </h2>
              <p className="text-muted-foreground">
                {isPrescanning
                  ? 'Scanning destination for existing files'
                  : copyPhase === 'mirror'
                    ? 'Pushing prepared files to your network drive via robocopy /MT:16'
                    : copyPhase === 'staging'
                      ? 'Preparing files locally before network upload'
                      : 'Copying, renaming and organizing your files'}
              </p>
            </div>

            <div className="space-y-2 mb-6">
              <div className="flex justify-between text-sm font-medium">
                <span>{copyPhase === 'mirror' ? 'Uploading…' : 'Processing...'}</span>
                <span>{Math.round(progress)}%</span>
              </div>
              <Progress value={progress} className="h-2" />
              <p className="text-xs text-muted-foreground text-left pt-1">
                {isPrescanning
                  ? `Scanning destination${prescanCount > 0 ? ` (${prescanCount.toLocaleString()} files checked)` : ''}...`
                  : copyPhase === 'mirror'
                    ? `Network upload in progress${mirrorFilesTotal > 0 ? ` · ${mirrorFilesDone.toLocaleString()} of ${mirrorFilesTotal.toLocaleString()} files mirrored` : ''}…`
                    : `${processed} of ${totalFiles} files processed`
                }
              </p>
              <div className="flex justify-between text-xs text-muted-foreground pt-2">
                <span>Elapsed: {formatTime(elapsed)}</span>
                {estimatedRemaining !== null && progress >= 3 && (
                  <span>~{formatTime(estimatedRemaining)} remaining</span>
                )}
              </div>
            </div>
            
            {!showCancelFixConfirm ? (
              <Button
                variant="outline"
                size="sm"
                className="text-muted-foreground hover:text-foreground border-muted-foreground/30 hover:border-muted-foreground/50"
                onClick={() => setShowCancelFixConfirm(true)}
                data-testid="button-cancel-fix"
              >
                Cancel
              </Button>
            ) : (
              <div className="bg-muted/50 border border-border rounded-xl p-4 text-left space-y-3">
                <h4 className="text-sm font-semibold text-foreground">Cancel Fix?</h4>
                <p className="text-xs text-muted-foreground">
                  Files already copied will remain at your destination, but remaining files won't be processed. These operations can take time with large sources or slow connections. Closing other apps may help.
                </p>
                <p className="text-xs text-muted-foreground italic">
                   Start Menu if needed.
                </p>
                <div className="flex gap-3">
                  <Button 
                    variant="outline" 
                    size="sm"
                    className="flex-1" 
                    onClick={() => setShowCancelFixConfirm(false)}
                  >
                    Continue Fix
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1 bg-amber-500 hover:bg-amber-600 text-white"
                    onClick={handleCancelFix}
                    disabled={isCancelling}
                  >
                    {isCancelling ? 'Cancelling...' : 'Yes, Cancel'}
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="relative mb-6">
              <motion.div 
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring" }}
                className="w-20 h-20 bg-emerald-50 dark:bg-emerald-950/30 rounded-full flex items-center justify-center mx-auto border border-emerald-200 dark:border-emerald-700"
              >
                <CheckCircle2 className="w-10 h-10 text-emerald-600 dark:text-emerald-400" />
              </motion.div>
              {(() => {
				  const c = fixSnapshotRef.current?.confirmed ?? 0;
				  const r = fixSnapshotRef.current?.recovered ?? 0;
				  const m = fixSnapshotRef.current?.marked ?? 0;
				  const actualTotal = c + r + m;
				  const successRate = actualTotal > 0 ? (c + r) / actualTotal : 0;
				  return successRate >= 0.88;
				})() && (
				  <motion.div
					initial={{ opacity: 0, y: 5 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ delay: 0.3, duration: 0.3 }}
					className="absolute -bottom-2 left-1/2 -translate-x-1/2 flex flex-col items-center"
				  >
					<span className="inline-flex items-center px-2.5 py-1 text-xs font-semibold rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700 shadow-sm">
					  {Math.round((((fixSnapshotRef.current?.confirmed ?? 0) + (fixSnapshotRef.current?.recovered ?? 0)) / ((fixSnapshotRef.current?.confirmed ?? 0) + (fixSnapshotRef.current?.recovered ?? 0) + (fixSnapshotRef.current?.marked ?? 0))) * 100)}% success
					</span>
                  <span className="text-[10px] text-muted-foreground mt-0.5">Confirmed + Recovered</span>
                </motion.div>
              )}
            </div>
            
            <h2 className="text-2xl font-semibold text-foreground mb-2">Fix Complete</h2>
            <p className="text-muted-foreground mb-1">
              {(fixSnapshotRef.current?.totalScanned ?? 0).toLocaleString()} files scanned → {((fixSnapshotRef.current?.confirmed ?? 0) + (fixSnapshotRef.current?.recovered ?? 0) + (fixSnapshotRef.current?.marked ?? 0)).toLocaleString()} output files
            </p>
            {totalTime > 0 && (
              <p className="text-xs text-muted-foreground mb-1">
                Completed in {formatTime(totalTime)}
              </p>
            )}
            {photoFormat !== 'original' && (() => {
              // Estimate output size for the report
              let srcBytes = 0, outBytes = 0;
              const PNG_X = 1.6, JPG_X = 0.2;
              const sourceIds = new Set((sources || []).map(s => s.id));
              Object.entries(fileResults || {}).forEach(([sourceId, sd]) => {
                if (!sourceIds.has(sourceId)) return; // Only count selected sources
                sd.files?.forEach((f) => {
                  if (f.type === 'photo' && !includePhotos) return;
                  if (f.type === 'video' && !includeVideos) return;
                  srcBytes += f.sizeBytes;
                  if (f.type === 'video') { outBytes += f.sizeBytes; return; }
                  const ext = f.extension?.toLowerCase() || '';
                  if (photoFormat === 'png') {
                    outBytes += ext === '.png' ? f.sizeBytes : f.sizeBytes * PNG_X;
                  } else {
                    outBytes += (ext === '.jpg' || ext === '.jpeg') ? f.sizeBytes : ext === '.png' ? f.sizeBytes * JPG_X : f.sizeBytes;
                  }
                });
              });
              const srcGB = srcBytes / (1024*1024*1024);
              const outGB = outBytes / (1024*1024*1024);
              const fmtSize = (gb: number) => gb >= 1 ? `${gb.toFixed(1)} GB` : `${(gb * 1024).toFixed(0)} MB`;
              return (
                <>
                  <p className="text-xs text-muted-foreground mb-1">
                    Estimated output: {fmtSize(outGB)}{outGB > srcGB * 1.5 ? ` (source: ${fmtSize(srcGB)})` : ''}
                    {photoFormat === 'png' && ' · PNG conversion increases file sizes'}
                  </p>
                  <p className="text-xs text-muted-foreground/60 mb-1">
                    Conversion speed depends on your hardware — faster CPUs will significantly reduce this time.
                  </p>
                </>
              );
            })()}
            <div className="mb-6" />
            
			<div className={`grid ${(fixSnapshotRef.current?.skippedExisting ?? 0) > 0 ? 'grid-cols-5' : 'grid-cols-4'} gap-3 mb-6 p-4 bg-muted/50 rounded-xl`}>
			  <div className="text-center">
				<div className="text-lg font-semibold text-emerald-600 dark:text-emerald-400 font-heading">{(fixSnapshotRef.current?.confirmed ?? 0).toLocaleString()}</div>
				<div className="text-xs text-muted-foreground">Confirmed</div>
			  </div>
			  <div className="text-center">
				<div className="text-lg font-semibold text-indigo-600 dark:text-indigo-400 font-heading">{(fixSnapshotRef.current?.recovered ?? 0).toLocaleString()}</div>
				<div className="text-xs text-muted-foreground">Recovered</div>
			  </div>
			  <div className="text-center">
				<div className="text-lg font-semibold text-slate-600 dark:text-slate-400 font-heading">{(fixSnapshotRef.current?.marked ?? 0).toLocaleString()}</div>
				<div className="text-xs text-muted-foreground">Marked</div>
			  </div>
			  <div className="text-center">
				<div className="text-lg font-semibold text-amber-600 dark:text-amber-400 font-heading">{(fixSnapshotRef.current?.duplicatesRemoved ?? 0).toLocaleString()}</div>
				<div className="text-xs text-muted-foreground">Duplicates</div>
			  </div>
			  {(fixSnapshotRef.current?.skippedExisting ?? 0) > 0 && (
				<div className="text-center">
				  <div className="text-lg font-semibold text-[#9b8bb8] font-heading">{(fixSnapshotRef.current?.skippedExisting ?? 0).toLocaleString()}</div>
				  <div className="text-xs text-muted-foreground">Already in Output</div>
				</div>
			  )}
			</div>
            
            {/* Destination permanence warning — shown first 3 times without dismiss option, then dismissable */}
            {showMasterLibMsg && (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 mb-4">
                <div className="flex items-start gap-2.5">
                  <Shield className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 mb-0.5">Your destination is now your master library</p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Moving, renaming, or deleting this folder will break Search & Discovery indexing and AI analysis.
                      Use the same destination for all future fixes to build a single, organised library.
                    </p>
                    {parseInt(localStorage.getItem('pdr-master-lib-seen-count') || '0', 10) >= 3 && (
                      <button
                        onClick={() => {
                          localStorage.setItem('pdr-master-lib-dismissed', 'true');
                          setShowMasterLibMsg(false);
                        }}
                        className="text-[10px] text-amber-600/60 dark:text-amber-400/60 hover:text-amber-600 dark:hover:text-amber-400 mt-1.5 underline transition-colors"
                      >
                        Don't show this again
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-3">
              <Button
                onClick={onViewReport}
                className="w-full bg-emerald-500 hover:bg-emerald-600 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white"
                size="lg"
                data-testid="button-view-report"
              >
                <FileText className="w-4 h-4 mr-2" /> View Report
              </Button>
              <div className="grid grid-cols-2 gap-3">
                <Button 
                  variant="outline" 
                  onClick={onClose} 
                  size="lg" 
                  className="border-muted-foreground/30 hover:bg-secondary hover:border-muted-foreground/50"
                  data-testid="button-close-fix"
                >
                  Close
                </Button>
                <Button 
                  variant="outline"
                  onClick={handleOpenDestination} 
                  size="lg"
                  disabled={!destinationPath}
                  className="border-emerald-500 text-emerald-600 hover:bg-emerald-50 hover:border-emerald-600 dark:text-emerald-400 dark:hover:bg-emerald-950/30 dark:hover:border-emerald-400 transition-all duration-300 ease-linear"
                  data-testid="button-open-destination"
                >
                  <FolderOpen className="w-4 h-4 mr-2" /> Open Destination
                </Button>
              </div>
            </div>
            
            <AnimatePresence>
              <ReviewPromptAccordion
				  confirmedCount={confirmedCount}
				  recoveredCount={recoveredCount}
				  markedCount={markedCount}
				  totalFiles={totalFiles}
				  onDismiss={() => {}}
				/>
            </AnimatePresence>
          </>
        )}
      </motion.div>
    </motion.div>
  );
  return fullModalPortalTarget ? ReactDOM.createPortal(fullModalNode, fullModalPortalTarget) : fullModalNode;
}

function ReportsListModal({ onClose, onViewReport }: {
  onClose: () => void,
  onViewReport: (reportId: string) => void 
}) {
  const [reports, setReports] = useState<Array<{
    id: string;
    timestamp: string;
    destinationPath: string;
    totalFiles: number;
    sourceCount: number;
    counts: { confirmed: number; recovered: number; marked: number };
    duplicatesRemoved?: number;
    totalScanned?: number;
  }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<{ id: string; type: string } | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [allowReportRemoval] = useState(
    localStorage.getItem('pdr-allow-report-removal') === 'true'
  );
  const [showManualExports, setShowManualExports] = useState(false);
  // Export folder browser state
  const [showExportBrowser, setShowExportBrowser] = useState(false);
  const [pendingExport, setPendingExport] = useState<{ reportId: string; format: 'csv' | 'txt' } | null>(null);
  const [exportBrowserDefaultPath, setExportBrowserDefaultPath] = useState('');

  useEffect(() => {
    const loadReports = async () => {
      const { listReports, isElectron, getSettings, regenerateCatalogue } = await import('@/lib/electron-bridge');

      if (isElectron()) {
        const result = await listReports();
        if (result.success && result.data) {
          setReports(result.data);
          // Silently regenerate catalogues for all unique destinations
          const settings = await getSettings();
          if (settings.autoSaveCatalogue) {
            const destinations = new Set(result.data.map(r => r.destinationPath));
            for (const dest of Array.from(destinations)) {
              regenerateCatalogue(dest).then(res => {
                  if (!res.success) console.warn('[Catalogue] Regen failed for', dest, res.error);
                  else console.log('[Catalogue] Regenerated for', dest);
                }).catch(err => console.warn('[Catalogue] Regen error for', dest, err));
            }
          }
        }
        const settings = await getSettings();
        setShowManualExports(settings.showManualReportExports);
      } else {
        setReports([
          {
            id: 'demo-report-1',
            timestamp: new Date().toISOString(),
            destinationPath: '/Users/demo/Photos/Fixed',
            totalFiles: 1248,
            sourceCount: 2,
            counts: { confirmed: 812, recovered: 311, marked: 125 }
          },
          {
            id: 'demo-report-2',
            timestamp: new Date(Date.now() - 86400000).toISOString(),
            destinationPath: '/Users/demo/Pictures/Organized',
            totalFiles: 456,
            sourceCount: 1,
            counts: { confirmed: 298, recovered: 112, marked: 46 }
          }
        ]);
      }
      setIsLoading(false);
    };

    loadReports();
  }, []);

  const handleExport = async (reportId: string, format: 'csv' | 'txt') => {
    const { getDefaultExportPath, isElectron } = await import('@/lib/electron-bridge');

    if (!isElectron()) {
      toast.info('Export is available in the desktop app', {
        description: 'Download the Photo Date Rescue desktop app to export reports.'
      });
      return;
    }

    // Get default path (destination root) and open folder browser
    const pathResult = await getDefaultExportPath(reportId);
    setExportBrowserDefaultPath(pathResult.path || '');
    setPendingExport({ reportId, format });
    setShowExportBrowser(true);
  };

  const handleExportToFolder = async (folderPath: string) => {
    setShowExportBrowser(false);
    if (!pendingExport) return;

    setExportingId(pendingExport.reportId);
    const { exportReportCSV, exportReportTXT } = await import('@/lib/electron-bridge');

    const result = pendingExport.format === 'csv'
      ? await exportReportCSV(pendingExport.reportId, folderPath)
      : await exportReportTXT(pendingExport.reportId, folderPath);

    if (result.success) {
      setExportSuccess({ id: pendingExport.reportId, type: pendingExport.format.toUpperCase() });
      setTimeout(() => setExportSuccess(null), 3000);
    } else if (result.error) {
      toast.error('Export failed', { description: result.error });
    }
    setExportingId(null);
    setPendingExport(null);
  };

  const handleDelete = async (reportId: string) => {
    setDeletingId(reportId);
    const { deleteReport, isElectron } = await import('@/lib/electron-bridge');
    
    if (!isElectron()) {
      toast.info('Delete is available in the desktop app');
      setDeletingId(null);
      setDeleteConfirmId(null);
      return;
    }
    
    const result = await deleteReport(reportId);
    
    if (result.success) {
      setReports(prev => prev.filter(r => r.id !== reportId));
      toast.success('Report deleted');
    } else {
      toast.error('Failed to delete report', { description: result.error });
    }
    setDeletingId(null);
    setDeleteConfirmId(null);
  };
  
  const formatDate = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const truncatePath = (path: string, maxLength = 40) => {
    if (path.length <= maxLength) return path;
    const parts = path.split('/');
    if (parts.length <= 2) return path.slice(0, maxLength - 3) + '...';
    return parts[0] + '/.../' + parts.slice(-2).join('/');
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
        className="bg-background rounded-2xl shadow-2xl max-w-3xl w-full max-h-[80vh] flex flex-col border border-border"
      >
        <div className="p-6 border-b border-border relative shrink-0 text-center">
          <div className="flex items-center justify-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center">
              <FileText className="w-5 h-5 text-primary" />
            </div>
            <div className="text-center">
              <h2 className="text-xl font-semibold text-foreground">Reports History</h2>
              <p className="text-sm text-muted-foreground">{reports.length} report{reports.length !== 1 ? 's' : ''} saved</p>
            </div>
          </div>
          <button onClick={onClose} className="absolute right-4 top-1/2 -translate-y-1/2 p-2 hover:bg-secondary rounded-full transition-colors" data-testid="button-close-reports-list">
            <X className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
            </div>
          ) : reports.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center px-6">
              <FileText className="w-12 h-12 text-muted-foreground/40 mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">No reports yet</h3>
              <p className="text-muted-foreground text-sm max-w-sm mb-2">
                Run your first Fix to generate a report history.
              </p>
              <p className="text-muted-foreground/70 text-xs max-w-sm">
                Reports are saved automatically after each Fix and can be viewed or exported anytime.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {reports.map((report, index) => (
                <div 
                  key={report.id} 
                  className={`p-4 hover:bg-secondary/30 transition-colors ${index === 0 ? 'bg-primary/10 border-l-4 border-l-primary ring-1 ring-primary/20' : ''}`}
                  data-testid={`report-row-${report.id}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-foreground">
                          {formatDate(report.timestamp)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {report.sourceCount} source{report.sourceCount !== 1 ? 's' : ''}
                        </span>
                      </div>
                      
                      <IconTooltip label={report.destinationPath} side="top">
                        <div className="text-sm text-muted-foreground mb-2 truncate">
                          <FolderOpen className="w-3.5 h-3.5 inline mr-1.5 opacity-60" />
                          {truncatePath(report.destinationPath)}
                        </div>
                      </IconTooltip>
                      
                      <div className="flex items-center gap-4 text-xs">
                        <span className="font-medium text-foreground">
                          {(report.totalScanned ?? (report.totalFiles + (report.duplicatesRemoved || 0))).toLocaleString()} scanned → {report.totalFiles.toLocaleString()} output
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                          <span className="text-muted-foreground">{report.counts.confirmed.toLocaleString()} Confirmed</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
                          <span className="text-muted-foreground">{report.counts.recovered.toLocaleString()} Recovered</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-slate-400"></span>
                          <span className="text-muted-foreground">{report.counts.marked.toLocaleString()} Marked</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                          <span className="text-muted-foreground">{(report.duplicatesRemoved ?? 0).toLocaleString()} Duplicates</span>
                        </span>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2 shrink-0">
                      {exportSuccess?.id === report.id && (
                        <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {exportSuccess.type} exported
                        </span>
                      )}

                      {showManualExports && (
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleExport(report.id, 'csv')}
                            disabled={exportingId === report.id}
                            className="h-8 px-3 text-xs border-muted-foreground/30 hover:bg-secondary hover:border-muted-foreground/50"
                            data-testid={`button-export-csv-${report.id}`}
                          >
                            CSV
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleExport(report.id, 'txt')}
                            disabled={exportingId === report.id}
                            className="h-8 px-3 text-xs border-muted-foreground/30 hover:bg-secondary hover:border-muted-foreground/50"
                            data-testid={`button-export-txt-${report.id}`}
                          >
                            TXT
                          </Button>
                        </div>
                      )}
                      
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onViewReport(report.id)}
                        className="h-8"
                        data-testid={`button-view-report-${report.id}`}
                      >
                        Report Summary
                      </Button>
                      
                      {allowReportRemoval && (
                        deleteConfirmId === report.id ? (
                          <div className="flex items-center gap-1 ml-2">
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => handleDelete(report.id)}
                              disabled={deletingId === report.id}
                              className="h-8 px-2 text-xs"
                              data-testid={`button-confirm-delete-${report.id}`}
                            >
                              {deletingId === report.id ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Yes'}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setDeleteConfirmId(null)}
                              className="h-8 px-2 text-xs"
                              data-testid={`button-cancel-delete-${report.id}`}
                            >
                              No
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeleteConfirmId(report.id)}
                            className="h-8 px-2 text-muted-foreground hover:text-destructive ml-1"
                            data-testid={`button-delete-${report.id}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        )
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        
        <div className="p-4 border-t border-border shrink-0">
          <Button 
            variant="outline" 
            onClick={onClose}
            className="border-muted-foreground/30 hover:bg-secondary hover:border-muted-foreground/50"
            data-testid="button-back-to-workspace"
          >
            <ArrowLeft className="w-4 h-4 mr-2" /> Back to Workspace
          </Button>
        </div>
      </motion.div>
      {/* Folder browser for report export location */}
      <FolderBrowserModal
        isOpen={showExportBrowser}
        onSelect={(path) => handleExportToFolder(path)}
        onCancel={() => { setShowExportBrowser(false); setPendingExport(null); }}
        title={`Save ${pendingExport?.format.toUpperCase() || ''} Report`}
        mode="folder"
        defaultPath={exportBrowserDefaultPath}
      />
    </motion.div>
  );
}

function PostFixReportModal({ onClose, results, destinationPath: propDestinationPath, fileResults, savedReportId, onBackToReports, onNavigateToBestPractices }: { 
  onClose: () => void, 
  results?: AnalysisResults,
  destinationPath: string | null,
  fileResults?: Record<string, SourceAnalysisResult>,
  savedReportId?: string | null,
  onBackToReports?: () => void,
  onNavigateToBestPractices?: () => void
}) {
  const [filterConfidence, setFilterConfidence] = useState<'all' | 'confirmed' | 'recovered' | 'marked'>('all');
  const [isElectronEnv, setIsElectronEnv] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasScrolled, setHasScrolled] = useState(false);
  const [previewDismissed, setPreviewDismissed] = useState(false);
  const [loadedReport, setLoadedReport] = useState<{
    destinationPath: string;
    files: Array<{ originalFilename: string; newFilename: string; confidence: 'confirmed' | 'recovered' | 'marked'; dateSource: string }>;
    counts: { confirmed: number; recovered: number; marked: number; total: number };
    duplicatesRemoved: number;
    totalScanned?: number;
  } | null>(null);
  const [isLoadingReport, setIsLoadingReport] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState<{ type: string } | null>(null);
  const [showExportBrowser2, setShowExportBrowser2] = useState(false);
  const [pendingExport2, setPendingExport2] = useState<{ format: 'csv' | 'txt' } | null>(null);
  const [exportBrowserDefaultPath2, setExportBrowserDefaultPath2] = useState('');
  const [showManualExports, setShowManualExports] = useState(false);
  const ITEMS_PER_PAGE = 100;

  useEffect(() => {
    import('@/lib/electron-bridge').then(({ isElectron, getSettings }) => {
      setIsElectronEnv(isElectron());
      if (isElectron()) {
        getSettings().then(settings => {
          setShowManualExports(settings.showManualReportExports);
        });
      }
    });
  }, []);
  
  useEffect(() => {
    if (savedReportId) {
      setLoadedReport(null);
      setIsLoadingReport(true);
      import('@/lib/electron-bridge').then(async ({ loadReport, isElectron }) => {
        if (isElectron()) {
          try {
            const result = await loadReport(savedReportId);
            if (result.success && result.data) {
              setLoadedReport({
                destinationPath: result.data.destinationPath,
                files: result.data.files,
                counts: result.data.counts,
                duplicatesRemoved: result.data.duplicatesRemoved || 0,
                totalScanned: result.data.totalScanned
              });
            }
          } catch (err) {
            console.error('Failed to load report:', err);
          }
        }
        setIsLoadingReport(false);
      });
    }
  }, [savedReportId]);
  
  // Reset page when filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [filterConfidence]);
  
  // Handle scroll to fade preview banner
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setHasScrolled(e.currentTarget.scrollTop > 20);
  };

  const destinationPath = loadedReport?.destinationPath || propDestinationPath;
  
  const handleOpenDestination = async () => {
    if (destinationPath && isElectronEnv) {
      const { openDestinationFolder } = await import('@/lib/electron-bridge');
      await openDestinationFolder(destinationPath);
    }
  };

  const handleExport = async (format: 'csv' | 'txt') => {
    if (!savedReportId) {
      toast.error('No report available to export');
      return;
    }

    const { getDefaultExportPath, isElectron } = await import('@/lib/electron-bridge');

    if (!isElectron()) {
      toast.info('Export is available in the desktop app', {
        description: 'Download the Photo Date Rescue desktop app to export reports.'
      });
      return;
    }

    const pathResult = await getDefaultExportPath(savedReportId);
    setExportBrowserDefaultPath2(pathResult.path || '');
    setPendingExport2({ format });
    setShowExportBrowser2(true);
  };

  const handleExportToFolder2 = async (folderPath: string) => {
    setShowExportBrowser2(false);
    if (!pendingExport2 || !savedReportId) return;

    setIsExporting(true);
    const { exportReportCSV, exportReportTXT } = await import('@/lib/electron-bridge');

    const result = pendingExport2.format === 'csv'
      ? await exportReportCSV(savedReportId, folderPath)
      : await exportReportTXT(savedReportId, folderPath);

    if (result.success) {
      setExportSuccess({ type: pendingExport2.format.toUpperCase() });
      setTimeout(() => setExportSuccess(null), 3000);
    } else if (result.error) {
      toast.error('Export failed', { description: result.error });
    }
    setIsExporting(false);
    setPendingExport2(null);
  };

  // Extract real file data from loaded report or analysis results
  const reportFiles = loadedReport?.files.map(f => ({
    filename: f.originalFilename,
    newFilename: f.newFilename,
    dateConfidence: f.confidence,
    dateSource: f.dateSource
  })) || [];
  
  const analysisFiles = Object.values(fileResults || {}).flatMap(source => 
    (source.files || [])
      .filter(file => !file.isDuplicate)
      .map(file => ({
        filename: file.filename,
        newFilename: file.suggestedFilename || file.filename,
        dateConfidence: file.dateConfidence,
        dateSource: file.dateSource
      }))
  );

    // Priority: loaded report > analysis results
  const hasLoadedReport = reportFiles.length > 0;
  const hasAnalysisData = analysisFiles.length > 0;
  const allFiles = hasLoadedReport ? reportFiles : analysisFiles;
  const hasRealData = hasLoadedReport || hasAnalysisData;
  
  const duplicatesRemoved = loadedReport?.duplicatesRemoved
    ?? Object.values(fileResults || {}).reduce((sum, source) => sum + (source.duplicatesRemoved || 0), 0);
	
  const duplicatesRemovedDisplay = savedReportId ? loadedReport?.duplicatesRemoved ?? 0 : duplicatesRemoved;
  
  // Calculate totals from loaded report, results, or file list
  const totalFiles = loadedReport?.counts.total 
    || (results?.fixed ? results.fixed + results.unchanged + (results.skipped || 0) : allFiles.length);
  
  const filteredFiles = allFiles.filter(file => 
    filterConfidence === 'all' || file.dateConfidence === filterConfidence
  );
  
  // Pagination
  const totalPages = Math.ceil(filteredFiles.length / ITEMS_PER_PAGE);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const paginatedFiles = filteredFiles.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  
  // Calculate confidence counts from loaded report or actual data
  const confidenceCounts = loadedReport?.counts 
    ? {
        confirmed: loadedReport.counts.confirmed,
        recovered: loadedReport.counts.recovered,
        marked: loadedReport.counts.marked
      }
    : hasRealData 
      ? {
          confirmed: allFiles.filter(f => f.dateConfidence === 'confirmed').length,
          recovered: allFiles.filter(f => f.dateConfidence === 'recovered').length,
          marked: allFiles.filter(f => f.dateConfidence === 'marked').length
        }
            : {
          confirmed: 0,
          recovered: 0,
          marked: 0
        };
  
  const getConfidenceBadge = (confidence: 'confirmed' | 'recovered' | 'marked') => {
    const styles = {
      confirmed: "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-700",
      recovered: "bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400 border-indigo-200 dark:border-indigo-700",
      marked: "bg-slate-50 dark:bg-slate-900/30 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700"
    };
    const labels = { confirmed: "Confirmed", recovered: "Recovered", marked: "Marked" };
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${styles[confidence]}`}>
        {labels[confidence]}
      </span>
    );
  };
  
  if (isLoadingReport) {
    return (
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
      >
        <div className="bg-background rounded-2xl shadow-2xl p-8 text-center">
          <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Loading report...</p>
        </div>
      </motion.div>
    );
  }

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
        <div className="p-6 border-b border-border relative shrink-0 text-center">
          <div className="flex items-center justify-center gap-3">
            <div className="w-10 h-10 bg-emerald-50 dark:bg-emerald-950/30 rounded-full flex items-center justify-center border border-emerald-200 dark:border-emerald-700">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="text-center">
              <h2 className="text-xl font-semibold text-foreground">Report Summary</h2>
              <p className="text-sm text-muted-foreground">
                {(loadedReport?.totalScanned ?? totalFiles).toLocaleString()} files scanned → {totalFiles.toLocaleString()} output files
              </p>
            </div>
          </div>
          <button onClick={onClose} className="absolute right-4 top-1/2 -translate-y-1/2 p-2 hover:bg-secondary rounded-full transition-colors">
            <X className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>
        
        <div className="p-6 space-y-6 overflow-y-auto flex-1" onScroll={handleScroll}>
          <AnimatePresence>
            {!hasRealData && !previewDismissed && (
              <motion.div 
                initial={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                transition={{ duration: 0.3, ease: "easeOut" }}
                className={`flex items-center gap-2 px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50 rounded-lg text-sm text-amber-700 dark:text-amber-300 transition-opacity duration-300 ${hasScrolled ? 'opacity-40' : 'opacity-100'}`}
              >
                <Info className="w-4 h-4 shrink-0" />
                <span className="flex-1">Showing a preview of the results. The full report is saved and can be viewed or exported anytime from Reports History.</span>
                <button 
                  onClick={() => setPreviewDismissed(true)}
                  className="text-amber-500 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-200 p-0.5"
                  aria-label="Dismiss notice"
                >
                  <X className="w-4 h-4" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
          
          <div className="grid grid-cols-4 gap-4">
            <div className="p-4 bg-emerald-50 dark:bg-emerald-950/30 rounded-xl border border-emerald-200 dark:border-emerald-700 text-center relative">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="absolute top-2 right-2 p-1 rounded-full hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors">
                    <Info className="w-3.5 h-3.5 text-emerald-400 dark:text-emerald-500" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-sm">
                  Date taken directly from information saved by the camera, app, or backup at the time the photo or video was created.
                </TooltipContent>
              </Tooltip>
              <div className="text-2xl font-semibold text-emerald-600 dark:text-emerald-400 font-heading">{confidenceCounts.confirmed.toLocaleString()}</div>
              <div className="text-sm text-emerald-600 dark:text-emerald-400">Confirmed</div>
              <div className="text-xs text-muted-foreground mt-1">EXIF / Takeout metadata</div>
            </div>
            <div className="p-4 bg-indigo-50 dark:bg-indigo-950/30 rounded-xl border border-indigo-200 dark:border-indigo-700 text-center relative">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="absolute top-2 right-2 p-1 rounded-full hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors">
                    <Info className="w-3.5 h-3.5 text-indigo-400 dark:text-indigo-500" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-sm">
                  Date inferred from recognised filename formats (such as WhatsApp, camera, or backup naming patterns) using consistent, reliable structures.
                </TooltipContent>
              </Tooltip>
              <div className="text-2xl font-semibold text-indigo-600 dark:text-indigo-400 font-heading">{confidenceCounts.recovered.toLocaleString()}</div>
              <div className="text-sm text-indigo-600 dark:text-indigo-400">Recovered</div>
              <div className="text-xs text-muted-foreground mt-1">Filename patterns</div>
            </div>
            <div className="p-4 bg-slate-50 dark:bg-slate-900/30 rounded-xl border border-slate-200 dark:border-slate-700 text-center relative">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="absolute top-2 right-2 p-1 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800/50 transition-colors">
                    <Info className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-sm">
                  No reliable date could be found. The file will still be safely renamed using a fallback date to avoid conflicts.
                </TooltipContent>
              </Tooltip>
              <div className="text-2xl font-semibold text-slate-600 dark:text-slate-400 font-heading">{confidenceCounts.marked.toLocaleString()}</div>
              <div className="text-sm text-slate-600 dark:text-slate-400">Marked</div>
              <div className="text-xs text-muted-foreground mt-1">Fallback date used</div>
            </div>
            <div className="p-4 bg-amber-50 dark:bg-amber-950/30 rounded-xl border border-amber-200 dark:border-amber-700 text-center relative">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="absolute top-2 right-2 p-1 rounded-full hover:bg-amber-100 dark:hover:bg-amber-900/50 transition-colors">
                    <Info className="w-3.5 h-3.5 text-amber-400 dark:text-amber-500" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-sm">
                  Exact duplicate files detected by content hash (SHA-256). These are excluded from the output to avoid redundancy.
                </TooltipContent>
              </Tooltip>
              <div className="text-2xl font-semibold text-amber-600 dark:text-amber-400 font-heading">{(loadedReport?.duplicatesRemoved || 0).toLocaleString()}</div>
              <div className="text-sm text-amber-600 dark:text-amber-400">Duplicates</div>
              <div className="text-xs text-muted-foreground mt-1">Hash-matched removed</div>
            </div>
          </div>
          
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setFilterConfidence('all')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium cursor-pointer ${
                filterConfidence === 'all' 
                  ? 'bg-primary text-primary-foreground' 
                  : 'bg-secondary text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              All ({totalFiles.toLocaleString()})
            </button>
            <button
              onClick={() => setFilterConfidence('confirmed')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium cursor-pointer ${
                filterConfidence === 'confirmed' 
                  ? 'bg-emerald-500 text-white' 
                  : 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 hover:ring-1 hover:ring-emerald-300 dark:hover:bg-emerald-900/50 dark:hover:ring-emerald-700'
              }`}
            >
              Confirmed ({confidenceCounts.confirmed.toLocaleString()})
            </button>
            <button
              onClick={() => setFilterConfidence('recovered')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium cursor-pointer ${
                filterConfidence === 'recovered' 
                  ? 'bg-indigo-500 text-white' 
                  : 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 hover:ring-1 hover:ring-indigo-300 dark:hover:bg-indigo-900/50 dark:hover:ring-indigo-700'
              }`}
            >
              Recovered ({confidenceCounts.recovered.toLocaleString()})
            </button>
            <button
              onClick={() => setFilterConfidence('marked')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium cursor-pointer ${
                filterConfidence === 'marked' 
                  ? 'bg-slate-500 text-white' 
                  : 'bg-slate-50 dark:bg-slate-900/30 text-slate-600 dark:text-slate-400 hover:bg-slate-100 hover:ring-1 hover:ring-slate-300 dark:hover:bg-slate-800/50 dark:hover:ring-slate-600'
              }`}
            >
              Marked ({confidenceCounts.marked.toLocaleString()})
            </button>
          </div>
          
          <div className="space-y-2">
            <div className="flex items-center justify-between px-4 py-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {filteredFiles.length > 0 
                  ? `Showing first ${Math.min(ITEMS_PER_PAGE, filteredFiles.length)} results`
                  : 'No files match this filter'}
              </div>
              {totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="h-8 px-3"
                  >
                    Previous
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {currentPage} of {totalPages.toLocaleString()}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="h-8 px-3"
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
            <div className="grid grid-cols-[minmax(0,2fr)_24px_minmax(0,2fr)_100px] gap-2 px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider border-b border-border" style={{ tableLayout: 'fixed' }}>
              <span className="text-left">Original Filename</span>
              <span></span>
              <span className="text-left">New Filename</span>
              <span className="text-left">Confidence</span>
            </div>
            <div className="space-y-1 min-h-[300px] max-h-[300px] overflow-y-auto">
              {paginatedFiles.length > 0 ? (
                paginatedFiles.map((file, index) => (
                  <div 
                    key={startIndex + index}
                    className="grid grid-cols-[minmax(0,2fr)_24px_minmax(0,2fr)_100px] gap-2 items-center px-4 py-3 bg-muted/30 dark:bg-muted/10 rounded-lg hover:bg-muted/50 dark:hover:bg-muted/20 transition-colors"
                    style={{ tableLayout: 'fixed' }}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-sm text-muted-foreground font-mono text-left overflow-hidden text-ellipsis whitespace-nowrap block">{file.filename}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-md font-mono text-xs break-all">
                        {file.filename}
                      </TooltipContent>
                    </Tooltip>
                    <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-sm text-foreground font-mono text-left overflow-hidden text-ellipsis whitespace-nowrap block">{file.newFilename}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-md font-mono text-xs break-all">
                        {file.newFilename}
                      </TooltipContent>
                    </Tooltip>
                    <div className="flex flex-col items-start gap-1 flex-shrink-0">
                      {getConfidenceBadge(file.dateConfidence)}
                      <span className="text-xs text-muted-foreground">{file.dateSource}</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                  No files match this filter
                </div>
              )}
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
              <span><strong>Marked:</strong> No reliable date found — fallback date used</span>
            </div>
          </div>
        </div>

        <div className="p-6 border-t border-border bg-background shrink-0">
          <div className="flex gap-3 justify-between">
            <div>
              {onBackToReports && (
                <Button 
                  variant="outline" 
                  onClick={onBackToReports}
                  className="border-muted-foreground/30 hover:bg-secondary hover:border-muted-foreground/50"
                  data-testid="button-back-to-reports"
                >
                  <ArrowLeft className="w-4 h-4 mr-2" /> Back to Reports History
                </Button>
              )}
            </div>
            <div className="flex items-center gap-3">
              {savedReportId && showManualExports && (
                <>
                  {exportSuccess && (
                    <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {exportSuccess.type} exported
                    </span>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground italic hidden sm:inline">Auto-catalogue is active at your destination</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleExport('csv')}
                      disabled={isExporting}
                      className="h-8 px-3 text-xs border-muted-foreground/30 hover:bg-secondary hover:border-muted-foreground/50"
                      data-testid="button-export-csv-modal"
                    >
                      CSV
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleExport('txt')}
                      disabled={isExporting}
                      className="h-8 px-3 text-xs border-muted-foreground/30 hover:bg-secondary hover:border-muted-foreground/50"
                      data-testid="button-export-txt-modal"
                    >
                      TXT
                    </Button>
                  </div>
                </>
              )}
              <Button 
                variant="outline" 
                onClick={onClose} 
                className="border-muted-foreground/30 hover:bg-secondary hover:border-muted-foreground/50"
                data-testid="button-close-report"
              >
                Done
              </Button>
              <Button 
                variant="outline"
                onClick={handleOpenDestination}
                disabled={!destinationPath}
                className="border-emerald-500 text-emerald-600 hover:bg-emerald-50 hover:border-emerald-600 dark:text-emerald-400 dark:hover:bg-emerald-950/30 dark:hover:border-emerald-400 transition-all duration-300 ease-linear"
                data-testid="button-report-open-destination"
              >
                <FolderOpen className="w-4 h-4 mr-2" /> Open Destination
              </Button>
            </div>
          </div>
        </div>
      </motion.div>
      {/* Folder browser for report export location */}
      <FolderBrowserModal
        isOpen={showExportBrowser2}
        onSelect={(path) => handleExportToFolder2(path)}
        onCancel={() => { setShowExportBrowser2(false); setPendingExport2(null); }}
        title={`Save ${pendingExport2?.format.toUpperCase() || ''} Report`}
        mode="folder"
        defaultPath={exportBrowserDefaultPath2}
      />
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
        <div className="relative mb-6 text-center">
          <h2 className="text-xl font-semibold text-foreground">Analysis Results</h2>
          <button onClick={onClose} className="absolute right-0 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-medium text-foreground mb-4">Confidence Summary</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-4 bg-emerald-50 rounded-lg border border-emerald-100">
                <span className="text-sm font-medium text-emerald-900">High Confidence</span>
                <span className="text-lg font-semibold text-emerald-600 font-heading">892 files</span>
              </div>
              <div className="flex items-center justify-between p-4 bg-amber-50 rounded-lg border border-amber-100">
                <span className="text-sm font-medium text-amber-900">Medium Confidence</span>
                <span className="text-lg font-semibold text-amber-600 font-heading">312 files</span>
              </div>
              <div className="flex items-center justify-between p-4 bg-rose-50 rounded-lg border border-rose-100">
                <span className="text-sm font-medium text-rose-900">Low Confidence</span>
                <span className="text-lg font-semibold text-rose-600 font-heading">44 files</span>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-medium text-foreground mb-4">File Outcomes</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
                <span className="text-sm font-medium text-foreground">Files Fixed</span>
                <span className="text-lg font-semibold text-emerald-600 font-heading">810</span>
              </div>
              <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
                <span className="text-sm font-medium text-foreground">Files Unchanged</span>
                <span className="text-lg font-semibold text-foreground font-heading">349</span>
              </div>
              <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
                <span className="text-sm font-medium text-foreground">Files Skipped</span>
                <span className="text-lg font-semibold text-amber-600 font-heading">89</span>
              </div>
            </div>
          </div>
        </div>

        <Button onClick={onClose} className="w-full mt-6">Close</Button>
      </motion.div>
    </motion.div>
  );
}

function PanelPlaceholder({ panelType, onBackToWorkspace, onNavigateToPanel, onStartTour, onReportProblem }: { panelType: string, onBackToWorkspace: () => void, onNavigateToPanel?: (panel: string) => void, onStartTour?: () => void, onReportProblem?: () => void }) {
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  
  React.useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [panelType]);

  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.1';
  const [updateStatus, setUpdateStatus] = React.useState<'idle' | 'checking' | 'up-to-date' | 'update-available' | 'error'>('idle');
  const [latestVersion, setLatestVersion] = React.useState<string | null>(null);
  const [releaseNotes, setReleaseNotes] = React.useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = React.useState<string | null>(null);

  const checkForUpdates = async () => {
    setUpdateStatus('checking');
    try {
      const response = await fetch('https://www.photodaterescue.com/api/version.json', { cache: 'no-store' });
      const data = await response.json();
      const isNewer = (remote: string, local: string) => {
        const r = remote.split('.').map(Number);
        const l = local.split('.').map(Number);
        for (let i = 0; i < Math.max(r.length, l.length); i++) {
          if ((r[i] || 0) > (l[i] || 0)) return true;
          if ((r[i] || 0) < (l[i] || 0)) return false;
        }
        return false;
      };
      if (data.version && isNewer(data.version, appVersion)) {
        setLatestVersion(data.version);
        setReleaseNotes(data.releaseNotes || null);
        setDownloadUrl(data.downloadUrl || null);
        setUpdateStatus('update-available');
      } else {
        setUpdateStatus('up-to-date');
      }
    } catch {
      setUpdateStatus('error');
    }
  };

  if (panelType === 'getting-started') {
    return (
      <div ref={scrollContainerRef} className="flex-1 flex flex-col h-full overflow-y-auto bg-background">
        <div className="flex-1 flex flex-col items-center px-8 pt-12 pb-20">
          <div className="w-full max-w-[940px]">
            <Button 
              variant="outline" 
              onClick={onBackToWorkspace}
              className="mb-6 text-muted-foreground hover:text-foreground"
              data-testid="button-back-to-workspace-top"
            >
              <ChevronRight className="w-4 h-4 mr-1 rotate-180" /> Back to Workspace
            </Button>
            <h2 className="text-2xl font-semibold text-foreground mb-3">Getting Started</h2>
            <p className="text-muted-foreground mb-10">Everything you need to run your first clean, safe fix — in minutes.</p>
          
            <div className="space-y-10">
              {/* What PDR Does */}
              <section>
                <h3 className="text-lg font-medium text-foreground mb-4">What Photo Date Rescue Does</h3>
                <div className="space-y-3 text-sm text-muted-foreground leading-relaxed">
                  <p>Photo Date Rescue restores correct dates to photos and videos by analysing trusted metadata, structured filename patterns, and fallback rules — without ever modifying your originals.</p>
                  <p>It's designed to handle messy, real-world libraries safely and predictably, even at large scale.</p>
                </div>
              </section>

              {/* Your First Fix */}
              <section>
                <h3 className="text-lg font-medium text-foreground mb-4">Your First Fix (5 Simple Steps)</h3>
                <div className="space-y-4">
                  <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                    <p className="font-medium text-foreground mb-1">Add a Source</p>
                    <p className="text-sm text-muted-foreground">Choose a folder, ZIP archive, or drive that contains the photos or videos you want to fix.</p>
                  </div>
                  <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                    <p className="font-medium text-foreground mb-1">Tick the Checkbox</p>
                    <p className="text-sm text-muted-foreground">Only checked Sources are included — this is how you tell PDR exactly what to analyse.</p>
                  </div>
                  <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                    <p className="font-medium text-foreground mb-1">Review the Source Analysis</p>
                    <p className="text-sm text-muted-foreground">Check how many files are Confirmed, Recovered, or Marked before running the fix.</p>
                  </div>
                  <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                    <p className="font-medium text-foreground mb-1">Choose a Destination</p>
                    <p className="text-sm text-muted-foreground">Select a dedicated output folder where the cleaned library will be written.</p>
                  </div>
                  <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                    <p className="font-medium text-foreground mb-1">Run Fix</p>
                    <p className="text-sm text-muted-foreground">PDR analyses your Sources, applies its confidence system, and writes corrected files to the Destination.</p>
                    <p className="text-xs text-muted-foreground mt-2">Nothing is overwritten — output is always written separately.</p>
                  </div>
                </div>
              </section>

              {/* What Happens After */}
              <section>
                <h3 className="text-lg font-medium text-foreground mb-4">What Happens After You Run Fix</h3>
                <div className="space-y-2">
                  <div className="flex items-center gap-3 p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-700 rounded-lg">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <p className="text-sm text-foreground">A clean, organised output folder is created</p>
                  </div>
                  <div className="flex items-center gap-3 p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-700 rounded-lg">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <p className="text-sm text-foreground">Original files remain untouched</p>
                  </div>
                  <div className="flex items-center gap-3 p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-700 rounded-lg">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <p className="text-sm text-foreground">A permanent Fix Report is saved</p>
                  </div>
                  <div className="flex items-center gap-3 p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-700 rounded-lg">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <p className="text-sm text-foreground">You can review, export, or audit the results at any time</p>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mt-4 font-medium">Nothing is hidden. Nothing is guessed without being labelled.</p>
              </section>

              {/* Confidence at a Glance */}
              <section>
                <h3 className="text-lg font-medium text-foreground mb-4">Confidence at a Glance</h3>
                <div className="space-y-3">
                  <div className="p-4 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-700 rounded-lg">
                    <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300 mb-1">Confirmed</p>
                    <p className="text-sm text-muted-foreground">Real capture or backup metadata found (highest trust)</p>
                  </div>
                  <div className="p-4 bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-700 rounded-lg">
                    <p className="text-sm font-medium text-indigo-700 dark:text-indigo-300 mb-1">Recovered</p>
                    <p className="text-sm text-muted-foreground">Date reconstructed from consistent filename patterns</p>
                  </div>
                  <div className="p-4 bg-slate-100 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-600 rounded-lg">
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Marked</p>
                    <p className="text-sm text-muted-foreground">No reliable date found; fallback rules used (review recommended)</p>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mt-4">Use this summary as your guide before and after each fix.</p>
              </section>

              {/* Where to Go Next */}
              <section>
                <h3 className="text-lg font-medium text-foreground mb-4">Where to Go Next</h3>
                <div className="space-y-3">
                  <button 
                    onClick={() => onNavigateToPanel?.('best-practices')}
                    className="w-full p-4 bg-secondary/30 border border-border rounded-lg text-left hover:bg-secondary/50 transition-colors"
                  >
                    <p className="font-medium text-foreground mb-1">Best Practices</p>
                    <p className="text-sm text-muted-foreground">Learn how to get the cleanest, most predictable results</p>
                  </button>
                  <button 
                    onClick={() => onNavigateToPanel?.('best-practices')}
                    className="w-full p-4 bg-secondary/30 border border-border rounded-lg text-left hover:bg-secondary/50 transition-colors"
                  >
                    <p className="font-medium text-foreground mb-1">Reports</p>
                    <p className="text-sm text-muted-foreground">Understand exactly what changed and why</p>
                  </button>
                  <button 
                    onClick={() => onNavigateToPanel?.('what-next')}
                    className="w-full p-4 bg-secondary/30 border border-border rounded-lg text-left hover:bg-secondary/50 transition-colors"
                  >
                    <p className="font-medium text-foreground mb-1">What Happens Next</p>
                    <p className="text-sm text-muted-foreground">Tips for follow-up runs, reviews, and long-term use</p>
                  </button>
                </div>
              </section>

              {/* Tip */}
              <section>
                <div className="p-6 bg-primary/5 border border-primary/10 rounded-xl">
                  <p className="text-sm font-medium text-foreground mb-2">Tip</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Start small for your first run. <span className="font-semibold text-foreground">One Source. One Destination.</span> One clean result — then scale with confidence.
                  </p>
                </div>
              </section>
            </div>
            
            <div className="mt-12 pt-8 border-t border-border">
              <Button 
                variant="outline" 
                onClick={onBackToWorkspace}
                className="text-muted-foreground hover:text-foreground"
                data-testid="button-back-to-workspace-bottom"
              >
                <ChevronRight className="w-4 h-4 mr-1 rotate-180" /> Back to Workspace
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (panelType === 'best-practices') {
    return (
      <div ref={scrollContainerRef} className="flex-1 flex flex-col h-full overflow-y-auto bg-background">
        <div className="flex-1 flex flex-col items-center px-8 pt-12 pb-20">
          <div className="w-full max-w-[940px]">
            <Button 
              variant="outline" 
              onClick={onBackToWorkspace}
              className="mb-6 text-muted-foreground hover:text-foreground"
              data-testid="button-back-to-workspace-top"
            >
              <ChevronRight className="w-4 h-4 mr-1 rotate-180" /> Back to Workspace
            </Button>
            <h2 className="text-2xl font-semibold text-foreground mb-3">Best Practices</h2>
            <p className="text-muted-foreground mb-10">Everything you need to get clean, predictable results</p>
          
            <div className="space-y-10">
              {/* Core Orientation Section - Always Visible */}
              <div className="p-6 bg-primary/5 border border-primary/10 rounded-xl">
                <p className="text-sm text-muted-foreground leading-relaxed">
                  PDR works best when you treat your input as a set of <span className="font-medium text-foreground">Sources</span> and your output as a single <span className="font-medium text-foreground">Destination</span>. 
                  That structure is what makes it fast, scalable, and safe — even with huge, messy libraries.
                </p>
                <p className="text-sm text-foreground font-medium mt-3">The goal: tell PDR exactly what to include, and exactly where fixed files should go, with no surprises.</p>
              </div>

              {/* Mental Model Section - Always Visible */}
              <section>
                <h3 className="text-lg font-medium text-foreground mb-4">The Mental Model</h3>
                <div className="space-y-4 text-sm text-muted-foreground leading-relaxed">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="p-4 bg-secondary/50 rounded-lg text-center">
                      <p className="font-medium text-foreground">Sources</p>
                      <p className="text-xs text-muted-foreground mt-1">what PDR reads</p>
                    </div>
                    <div className="p-4 bg-secondary/50 rounded-lg text-center">
                      <p className="font-medium text-foreground">Combined Analysis</p>
                      <p className="text-xs text-muted-foreground mt-1">what PDR understands</p>
                    </div>
                    <div className="p-4 bg-secondary/50 rounded-lg text-center">
                      <p className="font-medium text-foreground">Destination</p>
                      <p className="text-xs text-muted-foreground mt-1">what PDR writes</p>
                    </div>
                  </div>
                  <p>When you hit <span className="font-medium text-foreground">Run Fix</span>, you're saying: "Analyze these Sources together, apply PDR's rules and confidence system, and write the corrected result to this Destination."</p>
                  <p>Originals stay intact. Output is consistent. Reporting is saved. You can export and audit anytime.</p>
                </div>
              </section>

              {/* Source Types - Always Visible */}
              <section>
                <h3 className="text-lg font-medium text-foreground mb-4">Source Types at a Glance</h3>
                <div className="space-y-3">
                  <div className="p-4 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-700 rounded-lg">
                    <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300 mb-1">Folders</p>
                    <p className="text-sm text-muted-foreground">Recommended for most photo libraries. PDR scans cleanly with fewer edge cases.</p>
                  </div>
                  <div className="p-4 bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-700 rounded-lg">
                    <p className="text-sm font-medium text-indigo-700 dark:text-indigo-300 mb-1">ZIP Archives</p>
                    <p className="text-sm text-muted-foreground">Ideal for exports like Google Takeout or WhatsApp backups. No extraction required.</p>
                  </div>
                  <div className="p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-700 rounded-lg">
                    <p className="text-sm font-medium text-amber-700 dark:text-amber-300 mb-1">Drives</p>
                    <p className="text-sm text-muted-foreground">Useful when your library spans multiple folders on one disk. Think in folders even when using drives.</p>
                  </div>
                </div>
              </section>

              {/* Source Analysis Cards - Always Visible */}
              <section>
                <h3 className="text-lg font-medium text-foreground mb-4">Understanding Source Analysis Cards</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-700 rounded-lg">
                    <p className="font-medium text-emerald-700 dark:text-emerald-300 text-sm">Confirmed</p>
                    <p className="text-xs text-muted-foreground mt-1">Real capture/backup metadata found. Highest trust.</p>
                  </div>
                  <div className="p-3 bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-700 rounded-lg">
                    <p className="font-medium text-indigo-700 dark:text-indigo-300 text-sm">Recovered</p>
                    <p className="text-xs text-muted-foreground mt-1">Date recovered from consistent filename patterns.</p>
                  </div>
                  <div className="p-3 bg-slate-100 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-600 rounded-lg">
                    <p className="font-medium text-slate-700 dark:text-slate-300 text-sm">Marked</p>
                    <p className="text-xs text-muted-foreground mt-1">No reliable date found. Fallback rules used.</p>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mt-4">If Marked is high, consider running smaller grouped jobs to isolate what's happening.</p>
              </section>

              {/* Expandable Accordion Sections */}
              <div className="pt-6 border-t border-border">
                <h3 className="text-lg font-medium text-foreground mb-4">Detailed Guidance</h3>
                <Accordion type="multiple" className="space-y-3">
                  
                  {/* Detailed Source Selection */}
                  <AccordionItem value="source-selection" className="border border-primary/20 dark:border-primary/30 rounded-lg px-4 bg-secondary/30 hover:bg-secondary/50 hover:border-primary/40 transition-all duration-200">
                    <AccordionTrigger className="text-foreground font-medium hover:no-underline">
                      Detailed Source Selection
                    </AccordionTrigger>
                    <AccordionContent className="pt-2 pb-4">
                      <div className="space-y-6 text-sm text-muted-foreground leading-relaxed">
                        <div>
                          <p className="font-medium text-foreground mb-2">Checkbox Rules</p>
                          <p className="mb-3">PDR's checkbox system is your "truth filter". It decides what will be scanned and fixed.</p>
                          <div className="p-4 bg-secondary/50 rounded-lg mb-4">
                            <p className="font-medium text-foreground mb-2">Core rule: Only tick what you want included</p>
                            <ul className="list-disc ml-5 space-y-1">
                              <li><span className="font-medium text-foreground">Checked Source</span> = included in Combined Analysis</li>
                              <li><span className="font-medium text-foreground">Unchecked Source</span> = ignored entirely</li>
                            </ul>
                          </div>
                        </div>

                        <div>
                          <p className="font-medium text-foreground mb-2">Recommended Workflow</p>
                          <ul className="list-disc ml-5 space-y-1">
                            <li>Start with one Source</li>
                            <li>Run analysis</li>
                            <li>Check the Source Analysis</li>
                            <li>Add Sources gradually if needed</li>
                          </ul>
                        </div>

                        <div className="p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-700 rounded-lg">
                          <p className="font-medium text-amber-700 dark:text-amber-300 mb-2">"Select All" — when to use it (and when not to)</p>
                          <p className="mb-2">Use Select All only if every Source listed is meant to be part of the job and you're confident there's no overlap or junk.</p>
                          <p>Avoid Select All if your list includes old backups + newer backups, multiple Takeouts from different years, or prior output folders.</p>
                        </div>

                        <div>
                          <p className="font-medium text-foreground mb-2">Destination Best Practices</p>
                          <p className="mb-2">Pick a destination that is:</p>
                          <ul className="list-disc ml-5 space-y-1">
                            <li>Empty (or dedicated to this run)</li>
                            <li>Not inside any Source</li>
                            <li>Clearly named, like: <span className="font-mono text-foreground bg-muted px-1.5 py-0.5 rounded text-xs">Restored_2024</span> or <span className="font-mono text-foreground bg-muted px-1.5 py-0.5 rounded text-xs">PDR_Fixed_Output</span></li>
                          </ul>
                        </div>

                        <div>
                          <p className="font-medium text-foreground mb-2">Workflow Checklist</p>
                          <div className="space-y-2">
                            <div className="flex items-center gap-3 p-2 bg-secondary/30 rounded-lg">
                              <div className="w-2 h-2 rounded-full bg-primary shrink-0" />
                              <p className="text-sm">Add one Source and confirm it's correct</p>
                            </div>
                            <div className="flex items-center gap-3 p-2 bg-secondary/30 rounded-lg">
                              <div className="w-2 h-2 rounded-full bg-primary shrink-0" />
                              <p className="text-sm">Tick the checkbox and check Combined Analysis numbers</p>
                            </div>
                            <div className="flex items-center gap-3 p-2 bg-secondary/30 rounded-lg">
                              <div className="w-2 h-2 rounded-full bg-primary shrink-0" />
                              <p className="text-sm">Select Destination (dedicated output folder)</p>
                            </div>
                            <div className="flex items-center gap-3 p-2 bg-secondary/30 rounded-lg">
                              <div className="w-2 h-2 rounded-full bg-primary shrink-0" />
                              <p className="text-sm">Run Fix, view Report, use Reports History later</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  {/* Common Source Mistakes */}
                  <AccordionItem value="source-mistakes" className="border border-primary/20 dark:border-primary/30 rounded-lg px-4 bg-secondary/30 hover:bg-secondary/50 hover:border-primary/40 transition-all duration-200">
                    <AccordionTrigger className="text-foreground font-medium hover:no-underline">
                      Common Source Mistakes
                    </AccordionTrigger>
                    <AccordionContent className="pt-2 pb-4">
                      <div className="space-y-4">
                        <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                          <p className="font-medium text-foreground mb-2">Selecting both the ZIP and the extracted folder</p>
                          <p className="text-sm text-muted-foreground mb-2">Example: You include Takeout.zip AND Takeout/ (already extracted). Result: you've included the same files twice.</p>
                          <p className="text-xs text-muted-foreground font-medium">Best practice: Pick one — ZIP or extracted folder — never both.</p>
                        </div>

                        <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                          <p className="font-medium text-foreground mb-2">Including your previous output as a source</p>
                          <p className="text-sm text-muted-foreground mb-2">Example: Source: Restored_2024/ (which was created by a prior run). Result: recursion, duplicates, and confusion.</p>
                          <p className="text-xs text-muted-foreground font-medium">Best practice: Never include "Fixed" / "Restored" output folders as Sources.</p>
                        </div>

                        <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                          <p className="font-medium text-foreground mb-2">Mixing unrelated libraries in the same fix run</p>
                          <p className="text-sm text-muted-foreground mb-2">Example: iPhone photos + WhatsApp backups + old camera dumps + meme folder. PDR can still handle it — but your report becomes harder to interpret.</p>
                          <p className="text-xs text-muted-foreground font-medium">Best practice: Group Sources by purpose (e.g., "Google Takeout rescue", "WhatsApp library", "Camera uploads / DCIM").</p>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  {/* Reports */}
                  <AccordionItem value="reports" className="border border-primary/20 dark:border-primary/30 rounded-lg px-4 bg-secondary/30 hover:bg-secondary/50 hover:border-primary/40 transition-all duration-200">
                    <AccordionTrigger className="text-foreground font-medium hover:no-underline">
                      Reports: Your Audit Trail
                    </AccordionTrigger>
                    <AccordionContent className="pt-2 pb-4">
                      <div className="space-y-6 text-sm text-muted-foreground leading-relaxed">
                        <div className="p-4 bg-primary/5 border border-primary/10 rounded-lg">
                          <p>PDR's reports aren't just "logs" — they are <span className="font-medium text-foreground">proof, protection, and power</span>. They let you trust what happened, understand why, and come back months later knowing exactly how your library was transformed.</p>
                        </div>

                        <div>
                          <p className="font-medium text-foreground mb-2">What a Fix Report Contains</p>
                          <p className="mb-2">Every Run Fix creates a permanent snapshot of:</p>
                          <ul className="list-disc ml-5 space-y-1">
                            <li>What was processed and how dates were determined</li>
                            <li>What was renamed and what was excluded</li>
                            <li>Confidence level for each decision</li>
                          </ul>
                          <p className="mt-2 font-medium text-foreground">Think of it as a receipt for your memories.</p>
                        </div>

                        <div>
                          <p className="font-medium text-foreground mb-2">The File Table</p>
                          <p className="mb-2">Shows individual file transformations:</p>
                          <div className="p-3 bg-secondary/30 rounded-lg">
                            <div className="flex items-center gap-2 text-sm font-mono">
                              <span>IMG_2040115_143022.jpg</span>
                              <span className="text-primary">→</span>
                              <span className="font-medium text-foreground">2024-01-15_14-30-22.jpg</span>
                            </div>
                          </div>
                          <p className="mt-2">Suddenly: photos are sortable, timelines make sense, and chaos becomes history.</p>
                        </div>

                        <div>
                          <p className="font-medium text-foreground mb-2">Finding Old Files</p>
                          <p className="mb-2">Reports are incredibly valuable after the fix:</p>
                          <ul className="list-disc ml-5 space-y-1">
                            <li>Remember a photo by its old filename? The report tells you what it became.</li>
                            <li>Locate a video renamed years ago? Search the exported CSV or TXT.</li>
                            <li>Compare against an older backup? The report gives you a clean mapping.</li>
                          </ul>
                        </div>

                        <div>
                          <p className="font-medium text-foreground mb-2">Reports History</p>
                          <p className="mb-2">Each report entry shows run date, number of sources, total files, confidence breakdown, and destination path. From here you can reopen any report, export it again, or compare runs over time.</p>
                        </div>

                        <div>
                          <p className="font-medium text-foreground mb-2">Export Formats</p>
                          <div className="grid grid-cols-2 gap-3">
                            <div className="p-3 bg-secondary/30 rounded-lg">
                              <p className="font-medium text-foreground text-sm">CSV</p>
                              <p className="text-xs mt-1">Excel, sorting, filtering, professional use</p>
                            </div>
                            <div className="p-3 bg-secondary/30 rounded-lg">
                              <p className="font-medium text-foreground text-sm">TXT</p>
                              <p className="text-xs mt-1">Archiving, sharing, long-term records</p>
                            </div>
                          </div>
                        </div>

                        <div>
                          <p className="font-medium text-foreground mb-2">Report Best Practices</p>
                          <ul className="list-disc ml-5 space-y-1">
                            <li>Always keep your reports — even if the fix "looks right"</li>
                            <li>Export CSV for search/cross-reference needs</li>
                            <li>Export TXT for permanent, readable records</li>
                            <li>Use Reports History instead of rerunning fixes to check something</li>
                            <li>Treat reports as part of your archive, not temporary output</li>
                          </ul>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  {/* Duplicate Handling */}
                  <AccordionItem value="duplicates" className="border border-primary/20 dark:border-primary/30 rounded-lg px-4 bg-secondary/30 hover:bg-secondary/50 hover:border-primary/40 transition-all duration-200">
                    <AccordionTrigger className="text-foreground font-medium hover:no-underline">
                      Duplicate Handling
                    </AccordionTrigger>
                    <AccordionContent className="pt-2 pb-4">
                      <div className="space-y-6 text-sm text-muted-foreground leading-relaxed">
                        <div>
                          <p className="font-medium text-foreground mb-2">Only true duplicates are treated as duplicates</p>
                          <p>Photo Date Rescue only considers files to be duplicates when they are exact copies of one another. PDR compares the actual contents of each file, not just the information attached to it. This confirms that two files are genuinely identical — pixel for pixel, byte for byte.</p>
                        </div>
                        
                        <div>
                          <p className="font-medium text-foreground mb-2">Why metadata isn't used for duplicate removal</p>
                          <p className="mb-2">Many files contain extra information that describes them:</p>
                          <ul className="list-disc ml-5 space-y-1 mb-2">
                            <li><span className="font-medium text-foreground">EXIF</span> (camera and capture details)</li>
                            <li><span className="font-medium text-foreground">XMP</span> (sidecar or embedded metadata)</li>
                            <li><span className="font-medium text-foreground">JSON</span> (Google Takeout and other backups)</li>
                            <li>Filenames, timestamps, and folder structure</li>
                          </ul>
                          <p>While useful for restoring dates, metadata is not reliable for duplication. It can be missing, edited, regenerated, or copied between files. Two different photos can share identical metadata. For this reason, metadata is never used to decide whether a file is a duplicate.</p>
                        </div>
                        
                        <div>
                          <p className="font-medium text-foreground mb-2">What happens when duplicates are found</p>
                          <ul className="list-disc ml-5 space-y-1">
                            <li>One copy is included in the output</li>
                            <li>Additional identical copies are excluded from the result</li>
                            <li>Original files are never deleted or modified</li>
                          </ul>
                          <p className="mt-2">This ensures a clean output without risking accidental data loss.</p>
                        </div>
                        
                        <div>
                          <p className="font-medium text-foreground mb-2">The result</p>
                          <p>By relying on the most reliable method available and avoiding metadata-based guesswork, Photo Date Rescue ensures that only genuinely identical files are treated as duplicates — nothing more, nothing less.</p>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                </Accordion>
              </div>

              {/* Closing Statement */}
              <section className="pt-6">
                <div className="p-6 bg-primary/5 border border-primary/10 rounded-xl">
                  <p className="font-medium text-foreground mb-2">The Bottom Line</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Most tools either blindly rename stuff, or require a huge amount of manual organization first. PDR is different: it handles chaos without lying about certainty, keeps your originals safe, gives you visibility and audit trails, and scales from "my phone dump is a mess" to "multi-TB library rescue".
                  </p>
                  <p className="text-sm font-medium text-foreground mt-3">It's not just fixing filenames — it's restoring trust in your timeline.</p>
                </div>
              </section>
            </div>
            
            <div className="mt-12 pt-8 border-t border-border">
              <Button 
                variant="outline" 
                onClick={onBackToWorkspace}
                className="text-muted-foreground hover:text-foreground"
                data-testid="button-back-to-workspace-bottom"
              >
                <ChevronRight className="w-4 h-4 mr-1 rotate-180" /> Back to Workspace
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  
  if (panelType === 'what-next') {
    return (
      <div ref={scrollContainerRef} className="flex-1 flex flex-col h-full overflow-y-auto bg-background">
        <div className="flex-1 flex flex-col items-center px-8 pt-12 pb-20">
          <div className="w-full max-w-[940px]">
            <Button 
              variant="outline" 
              onClick={onBackToWorkspace}
              className="mb-6 text-muted-foreground hover:text-foreground"
              data-testid="button-back-to-workspace-top"
            >
              <ChevronRight className="w-4 h-4 mr-1 rotate-180" /> Back to Workspace
            </Button>
            <h2 className="text-2xl font-semibold text-foreground mb-10">What Happens Next</h2>
          
            <div className="space-y-12">
              <section>
                <div className="flex items-start gap-3 mb-4">
                  <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-semibold shrink-0">1</div>
                  <h3 className="text-lg font-medium text-foreground">Add your sources</h3>
                </div>
                <div className="ml-10 space-y-3 text-sm text-muted-foreground leading-relaxed">
                  <p>Start by adding the folders, drives, or ZIP/RAR archives that contain your photos and videos.</p>
                  <p className="font-medium text-foreground">How to add sources:</p>
                  <ul className="list-disc ml-5 space-y-1.5">
                    <li>Click <span className="font-medium text-foreground">Add Source</span> to browse your drives and folders</li>
                    <li>Select a <span className="font-medium text-foreground">folder or drive</span> to scan, or select a <span className="font-medium text-foreground">ZIP/RAR file</span> to import</li>
                  </ul>
                  <p>Each source is added one at a time, but you can keep adding as many as you like. Photo Date Rescue then analyses all selected sources together in a single, consistent run.</p>
                </div>
              </section>

              <section>
                <div className="flex items-start gap-3 mb-4">
                  <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-semibold shrink-0">2</div>
                  <h3 className="text-lg font-medium text-foreground">Review the Source Analysis</h3>
                </div>
                <div className="ml-10 space-y-3 text-sm text-muted-foreground leading-relaxed">
                  <p>Once your sources are added, analysis runs automatically — there's nothing you need to do at this stage.</p>
                  <p>The Source Analysis shows how your files were categorised:</p>
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
                    <li><span className="font-medium text-foreground">Choose a destination</span> – Select or confirm the destination where the fixed files will be written.</li>
                    <li><span className="font-medium text-foreground">Select your sources</span> – In the left-hand list, make sure the sources you want to process are checked. You can include or exclude any source at this stage.</li>
                    <li><span className="font-medium text-foreground">Confirm file types</span> – In Combined Analysis, choose whether to include Photos, Videos, or both for this run.</li>
                    <li><span className="font-medium text-foreground">Check available space</span> – Review the storage indicator to ensure the destination has enough capacity. The Free amount (shown in green) should exceed the Required size shown alongside it.</li>
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
            
            <div className="mt-12 pt-8 border-t border-border">
              <Button 
                variant="outline" 
                onClick={onBackToWorkspace}
                className="text-muted-foreground hover:text-foreground"
                data-testid="button-back-to-workspace-bottom"
              >
                <ChevronRight className="w-4 h-4 mr-1 rotate-180" /> Back to Workspace
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (panelType === 'about-pdr') {
    return (
      <div ref={scrollContainerRef} className="flex-1 flex flex-col h-full overflow-y-auto bg-background">
        <div className="flex-1 flex flex-col items-center px-8 pt-12 pb-20">
          <div className="w-full max-w-[940px]">
            <Button 
              variant="outline" 
              onClick={onBackToWorkspace}
              className="mb-6 text-muted-foreground hover:text-foreground"
              data-testid="button-back-to-workspace-top"
            >
              <ChevronRight className="w-4 h-4 mr-1 rotate-180" /> Back to Workspace
            </Button>

            <div className="flex items-center gap-4 mb-10">
              <img src="./assets//pdr-logo_transparent.png" alt="Photo Date Rescue" className="h-16 w-auto object-contain" />
              <div>
                <h2 className="text-2xl font-semibold text-foreground">Photo Date Rescue</h2>
                <p className="text-sm text-muted-foreground">Version {appVersion}</p>
              </div>
            </div>

            <div className="space-y-8">
              <section>
                <h3 className="text-lg font-medium text-foreground mb-3">About</h3>
                <div className="text-sm text-muted-foreground leading-relaxed space-y-3">
                  <p>Photo Date Rescue repairs, normalises, and organises photo and video dates from any source — whether that's a Google Takeout export, an iCloud download, a phone backup, or a folder of mixed files.</p>
                  <p>Every file is analysed for date clues from metadata, filenames, and folder structure. Files are then renamed with confidence-based suffixes so you always know how each date was determined.</p>
                  <ul className="list-disc ml-5 space-y-1.5">
                    <li>Removes duplicates from output automatically</li>
                    <li>Never deletes originals — copies are always made to a new location</li>
                    <li>Allows EXIF date to be written to each photo file</li>
                  </ul>
                </div>
              </section>

              <section>
                <h3 className="text-lg font-medium text-foreground mb-3">Details</h3>
                <div className="space-y-2">
                  <div className="flex items-center justify-between p-3 rounded-lg border border-border">
                    <span className="text-sm text-muted-foreground">Version</span>
                    <span className="text-sm font-medium text-foreground">{appVersion}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 rounded-lg border border-border">
                    <span className="text-sm text-muted-foreground">Developer</span>
                    <span className="text-sm font-medium text-foreground">Photo Date Rescue Ltd</span>
                  </div>
                  <div className="flex items-center justify-between p-3 rounded-lg border border-border">
                    <span className="text-sm text-muted-foreground">Website</span>
                    <button 
                      onClick={async () => {
                        const { openExternalUrl } = await import('@/lib/electron-bridge');
                        await openExternalUrl('https://www.photodaterescue.com');
                      }}
                      className="text-sm font-medium text-primary hover:underline cursor-pointer bg-transparent border-none p-0"
                    >
                      photodaterescue.com
                    </button>
                  </div>
                </div>
              </section>

              <section>
                <h3 className="text-lg font-medium text-foreground mb-3">Version History</h3>

                <div className="mb-4">
                  {updateStatus === 'idle' && (
                    <Button 
                      variant="outline"
                      onClick={checkForUpdates}
                      className="gap-2 border-primary/30 hover:border-primary/50 hover:bg-primary/5"
                      data-testid="button-check-updates"
                    >
                      <RefreshCw className="w-4 h-4" /> Check for Updates
                    </Button>
                  )}
                  {updateStatus === 'checking' && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <RefreshCw className="w-4 h-4 animate-spin" /> Checking for updates...
                    </div>
                  )}
                  {updateStatus === 'up-to-date' && (
                    <div className="flex items-center gap-2 text-sm text-emerald-600">
                      <CheckCircle2 className="w-4 h-4" /> You're running the latest version.
                    </div>
                  )}
                  {updateStatus === 'error' && (
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">Couldn't check for updates. Please try again later or visit the website.</p>
                      <Button 
                        variant="outline"
                        onClick={checkForUpdates}
                        className="gap-2 border-primary/30 hover:border-primary/50 hover:bg-primary/5"
                      >
                        <RefreshCw className="w-4 h-4" /> Try Again
                      </Button>
                    </div>
                  )}
                </div>

                <Accordion type="multiple" defaultValue={updateStatus === 'update-available' && latestVersion ? [`ver-${latestVersion}`] : ["ver-1.0.1"]} className="space-y-2">
                  
                  {updateStatus === 'update-available' && latestVersion && (
                    <AccordionItem value={`ver-${latestVersion}`} className="border border-primary/30 rounded-lg px-4 bg-primary/5">
                      <AccordionTrigger className="text-foreground font-medium hover:no-underline">
                        <div className="flex items-center gap-2">
                          <Sparkles className="w-4 h-4 text-primary" />
                          <span>v{latestVersion}</span>
                          <span className="text-xs font-normal text-primary ml-1">— Available for download</span>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent className="pt-2 pb-4">
                        <div className="space-y-3">
                          {releaseNotes && (
                            <p className="text-sm text-muted-foreground">{releaseNotes}</p>
                          )}
                          {downloadUrl && (
                            <Button 
                              variant="outline"
                              onClick={async () => {
                                const { openExternalUrl } = await import('@/lib/electron-bridge');
                                await openExternalUrl(downloadUrl);
                              }}
                              className="gap-2 border-primary/30 hover:border-primary/50 hover:bg-primary/5"
                              data-testid="button-download-update"
                            >
                              <Download className="w-4 h-4" /> Download Update
                            </Button>
                          )}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  )}

                  <AccordionItem value="ver-1.0.1" className="border border-border rounded-lg px-4">
                    <AccordionTrigger className="text-foreground font-medium hover:no-underline">
                      <div className="flex items-center gap-2">
                        <span>v1.0.1</span>
                        {appVersion === '1.0.1' && (
                          <span className="text-xs font-normal text-emerald-600 ml-1">— Current version</span>
                        )}
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="pt-2 pb-4">
                      <ul className="list-disc ml-5 space-y-1.5 text-sm text-muted-foreground">
                        <li>Fixed Google Takeout archives larger than 2 GB not extracting correctly</li>
                        <li>Added RAR archive support for Apple Photos exports and other RAR sources</li>
                        <li>Added "About PDR" panel with version history and update checking</li>
                        <li>Version number now shown in Settings</li>
                        <li>Improved performance guidance tooltips for network and cloud drives</li>
                      </ul>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="ver-1.0.0" className="border border-border rounded-lg px-4">
                    <AccordionTrigger className="text-foreground font-medium hover:no-underline">
                      <div className="flex items-center gap-2">
                        <span>v1.0.0</span>
                        {appVersion === '1.0.0' && (
                          <span className="text-xs font-normal text-emerald-600 ml-1">— Current version</span>
                        )}
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="pt-2 pb-4">
                      <p className="text-sm text-muted-foreground">Initial release of Photo Date Rescue.</p>
                    </AccordionContent>
                  </AccordionItem>

                </Accordion>
              </section>
            </div>
            
            <div className="mt-12 pt-8 border-t border-border">
              <Button 
                variant="outline" 
                onClick={onBackToWorkspace}
                className="text-muted-foreground hover:text-foreground"
                data-testid="button-back-to-workspace-bottom"
              >
                <ChevronRight className="w-4 h-4 mr-1 rotate-180" /> Back to Workspace
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  
  if (panelType === 'help-support') {
    return (
      <div ref={scrollContainerRef} className="flex-1 flex flex-col h-full overflow-y-auto bg-background">
        <div className="flex-1 flex flex-col items-center px-8 pt-12 pb-20">
          <div className="w-full max-w-[940px]">
            <Button 
              variant="outline" 
              onClick={onBackToWorkspace}
              className="mb-6 text-muted-foreground hover:text-foreground"
              data-testid="button-back-to-workspace-top"
            >
              <ChevronRight className="w-4 h-4 mr-1 rotate-180" /> Back to Workspace
            </Button>
            <h2 className="text-2xl font-semibold text-foreground mb-3">Help & Support</h2>
            <p className="text-muted-foreground mb-10">Everything you need to use Photo Date Rescue confidently — without guesswork, fear, or unnecessary emails.</p>
          
            <div className="space-y-6">
              <Accordion type="multiple" defaultValue={["start-here"]} className="space-y-3">
                
                {/* Start Here - Expanded by default */}
                <AccordionItem value="start-here" className="border border-border rounded-lg px-4">
                  <AccordionTrigger className="text-foreground font-medium hover:no-underline">
                    Start Here (Recommended)
                  </AccordionTrigger>
                  <AccordionContent className="pt-2 pb-4">
                    <div className="space-y-4 text-sm text-muted-foreground leading-relaxed">
                      <p>If you're unsure about what to select, why files were marked, or how to plan a clean fix, start with the Guides. They answer most questions faster than email support.</p>
                      
                      <div className="p-4 bg-primary/5 border border-primary/10 rounded-lg">
                        <p className="font-medium text-foreground mb-2">Guides: Getting Your Photos In and Out</p>
                      <button 
                        onClick={async () => {
                          const { openExternalUrl } = await import('@/lib/electron-bridge');
                          await openExternalUrl('https://www.photodaterescue.com/#guides');
                        }}
                        className="text-primary hover:underline text-sm cursor-pointer bg-transparent border-none p-0 text-left"
                      >
                        photodaterescue.com/guides →
                      </button>
                      </div>
                      
                      <div>
                        <p className="font-medium text-foreground mb-2">These guides help you:</p>
                        <ul className="list-disc ml-5 space-y-1">
                          <li>Plan large fixes safely</li>
                          <li>Avoid duplicate scans</li>
                          <li>Understand what metadata survives exports</li>
                          <li>Get the best possible results on the first run</li>
                        </ul>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* Replay Tour */}
                <AccordionItem value="replay-tour" className="border border-border rounded-lg px-4">
                  <AccordionTrigger className="text-foreground font-medium hover:no-underline">
                    Take a Quick Tour
                  </AccordionTrigger>
                  <AccordionContent className="pt-2 pb-4">
                    <div className="space-y-4 text-sm text-muted-foreground leading-relaxed">
                      <p>Need a refresher? Walk through the key areas of Photo Date Rescue with a guided tour. It takes less than a minute.</p>
                      
                      <Button 
                        variant="outline" 
                        onClick={onStartTour}
                        className="gap-2 border-primary/30 hover:border-primary/50 hover:bg-primary/5"
                        data-testid="button-replay-tour"
                      >
                        <PlayCircle className="w-4 h-4" /> Start Tour
                      </Button>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* Guides by Topic */}
                <AccordionItem value="guides-topic" className="border border-border rounded-lg px-4">
                  <AccordionTrigger className="text-foreground font-medium hover:no-underline">
                    Guides by Topic
                  </AccordionTrigger>
                  <AccordionContent className="pt-2 pb-4">
                    <div className="space-y-4 text-sm text-muted-foreground leading-relaxed">
                      <p>Use these if your photos came from specific places:</p>
                      
                      <div className="space-y-3">
                        <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                          <p className="font-medium text-foreground mb-1">Cloud Services</p>
                          <p className="text-sm text-muted-foreground mb-2">Google Photos, iCloud, OneDrive, Dropbox</p>
                        <button 
                          onClick={async () => {
                            const { openExternalUrl } = await import('@/lib/electron-bridge');
                            await openExternalUrl('https://www.photodaterescue.com/guides/cloud-services');
                          }}
                          className="text-primary hover:underline text-xs cursor-pointer bg-transparent border-none p-0 text-left"
                        >
                          View guide →
                        </button>
                        </div>
                        
                        <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                          <p className="font-medium text-foreground mb-1">Social & Messaging Apps</p>
                          <p className="text-sm text-muted-foreground mb-2">WhatsApp, Messenger, Telegram, Signal, Snapchat</p>
                        <button 
                          onClick={async () => {
                            const { openExternalUrl } = await import('@/lib/electron-bridge');
                            await openExternalUrl('https://www.photodaterescue.com/guides/social-apps');
                          }}
                          className="text-primary hover:underline text-xs cursor-pointer bg-transparent border-none p-0 text-left"
                        >
                          View guide →
                        </button>
                        </div>
                        
                        <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                          <p className="font-medium text-foreground mb-1">Hardware & Devices</p>
                          <p className="text-sm text-muted-foreground mb-2">Phones, cameras, scanners, external drives</p>
                        <button 
                          onClick={async () => {
                            const { openExternalUrl } = await import('@/lib/electron-bridge');
                            await openExternalUrl('https://www.photodaterescue.com/guides/hardware-devices');
                          }}
                          className="text-primary hover:underline text-xs cursor-pointer bg-transparent border-none p-0 text-left"
                        >
                          View guide →
                        </button>
                        </div>
                      </div>
                      
                      <div>
                        <p className="font-medium text-foreground mb-2">Each guide explains:</p>
                        <ul className="list-disc ml-5 space-y-1">
                          <li>How to export correctly</li>
                          <li>What date data is preserved or lost</li>
                          <li>How PDR reconstructs timelines safely</li>
                          <li>Common mistakes to avoid</li>
                        </ul>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* Understanding Your Results */}
                <AccordionItem value="understanding-results" className="border border-border rounded-lg px-4">
                  <AccordionTrigger className="text-foreground font-medium hover:no-underline">
                    Understanding Your Results
                  </AccordionTrigger>
                  <AccordionContent className="pt-2 pb-4">
                    <div className="space-y-4 text-sm text-muted-foreground leading-relaxed">
                      <p>After you run Fix, PDR shows you exactly what happened.</p>
                      
                      <div>
                        <p className="font-medium text-foreground mb-3">Confidence labels</p>
                        <div className="space-y-2">
                          <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-700 rounded-lg">
                            <p className="font-medium text-emerald-700 dark:text-emerald-300 text-sm">Confirmed</p>
                            <p className="text-xs text-muted-foreground mt-1">Date taken from authoritative metadata</p>
                          </div>
                          <div className="p-3 bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-700 rounded-lg">
                            <p className="font-medium text-indigo-700 dark:text-indigo-300 text-sm">Recovered</p>
                            <p className="text-xs text-muted-foreground mt-1">Date reconstructed from reliable filename patterns</p>
                          </div>
                          <div className="p-3 bg-slate-100 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-600 rounded-lg">
                            <p className="font-medium text-slate-700 dark:text-slate-300 text-sm">Marked</p>
                            <p className="text-xs text-muted-foreground mt-1">No usable date found; safe fallback rules applied</p>
                          </div>
                        </div>
                      </div>
                      
                      <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                        <p className="text-sm"><span className="font-medium text-foreground">Nothing is hidden.</span> Nothing is silently guessed.</p>
                        <p className="text-sm mt-2">Use <span className="font-medium text-foreground">Reports History</span> to review or export what happened at any time.</p>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* Common Questions (FAQ) */}
                <AccordionItem value="faq" className="border border-border rounded-lg px-4">
                  <AccordionTrigger className="text-foreground font-medium hover:no-underline">
                    Common Questions
                  </AccordionTrigger>
                  <AccordionContent className="pt-2 pb-4">
                    <div className="space-y-3">
                      <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                        <p className="font-medium text-foreground text-sm mb-1">Will this overwrite or damage my original files?</p>
                        <p className="text-sm text-muted-foreground">No. Originals are never modified. All changes are written to a new destination you choose.</p>
                      </div>
                      
                      <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                        <p className="font-medium text-foreground text-sm mb-1">Why are some files marked "Marked"?</p>
                        <p className="text-sm text-muted-foreground">Because no reliable date survived export or transfer. PDR labels this clearly instead of pretending certainty.</p>
                      </div>
                      
                      <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                        <p className="font-medium text-foreground text-sm mb-1">Why don't all files have the same confidence level?</p>
                        <p className="text-sm text-muted-foreground">Different apps and devices preserve metadata differently. PDR reflects reality instead of smoothing it over.</p>
                      </div>
                      
                      <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                        <p className="font-medium text-foreground text-sm mb-1">What happens if I run Fix more than once?</p>
                        <p className="text-sm text-muted-foreground">Each run creates its own output and report. Nothing is merged or overwritten automatically.</p>
                      </div>
                      
                      <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                        <p className="font-medium text-foreground text-sm mb-1">Can I stop a Fix once it starts?</p>
                        <p className="text-sm text-muted-foreground">Yes. Partial output remains safe and usable. Completed work is still recorded in Reports History.</p>
                      </div>
                      
                      <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                        <p className="font-medium text-foreground text-sm mb-1">Why don't reports change when I add more files later?</p>
                        <p className="text-sm text-muted-foreground">Reports are snapshots of a specific Fix run. This preserves traceability and avoids confusion.</p>
                      </div>
                      
                      <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                        <p className="font-medium text-foreground text-sm mb-1">Why don't I see every duplicate listed?</p>
                        <p className="text-sm text-muted-foreground">Exact duplicates are removed from output, not deleted. PDR keeps the best version and explains the method used.</p>
                      </div>
                      
                      <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                        <p className="font-medium text-foreground text-sm mb-1">Can I use PDR on very large libraries?</p>
                        <p className="text-sm text-muted-foreground">Yes — it's designed for scale. Reports and UI remain usable even with large runs.</p>
                      </div>
                      
                      <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                        <p className="font-medium text-foreground text-sm mb-1">Is this safe to use with cloud backups?</p>
                        <p className="text-sm text-muted-foreground">Yes — if you follow the Guides. Cloud services often strip metadata, and the Guides explain how to avoid issues.</p>
                      </div>
                      
                      <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                        <p className="font-medium text-foreground text-sm mb-1">Why does PDR feel stricter than other tools?</p>
                        <p className="text-sm text-muted-foreground">Because it's deterministic and auditable. Everything can be reviewed later.</p>
                      </div>
                      
                      <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                        <p className="font-medium text-foreground text-sm mb-1">What if something doesn't look right?</p>
                        <p className="text-sm text-muted-foreground">Check Source Analysis, Confidence tooltips, and Reports History. If it still doesn't make sense, then contact support.</p>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* When to Contact Support */}
                <AccordionItem value="contact-support" className="border border-border rounded-lg px-4">
                  <AccordionTrigger className="text-foreground font-medium hover:no-underline">
                    When to Contact Support
                  </AccordionTrigger>
                  <AccordionContent className="pt-2 pb-4">
                    <div className="space-y-4 text-sm text-muted-foreground leading-relaxed">
                      <p className="font-medium text-foreground">Please contact support only if:</p>
                      <ul className="list-disc ml-5 space-y-1">
                        <li>The app fails to launch</li>
                        <li>A Fix crashes or stops unexpectedly</li>
                        <li>A license issue prevents use</li>
                      </ul>
                      
                      <div className="pt-4 border-t border-border mt-4">
                        <p className="text-xs text-muted-foreground mb-3">
                          For setup questions, planning advice, or interpretation of results, please use the Guides first — they're faster and more detailed than email.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {onReportProblem && (
                            <button
                              onClick={onReportProblem}
                              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg border border-border bg-secondary/30 text-foreground hover:bg-secondary/50 transition-colors cursor-pointer"
                            >
                              <AlertTriangle className="w-4 h-4 text-amber-500" />
                              Report a problem (recommended)
                            </button>
                          )}
                          <button
                            onClick={async () => {
                              const { openExternalUrl } = await import('@/lib/electron-bridge');
                              await openExternalUrl('https://www.photodaterescue.com/support?source=app');
                            }}
                            className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium rounded-lg border border-border bg-secondary/30 text-foreground hover:bg-secondary/50 transition-colors cursor-pointer"
                          >
                            Contact Support (web form)
                          </button>
                        </div>
                        {onReportProblem && (
                          <p className="text-xs text-muted-foreground mt-2">
                            The in-app <strong className="text-foreground font-semibold">Report a problem</strong> option pre-fills a support email with your system info and log file — the fastest way for us to diagnose an issue.
                          </p>
                        )}
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

              </Accordion>

              {/* Why This Exists - Closing callout */}
              <section className="pt-4">
                <div className="p-6 bg-primary/5 border border-primary/10 rounded-xl">
                  <p className="font-medium text-foreground mb-2">Why This Exists</p>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                    Photo Date Rescue isn't just a renaming tool. It's a system for restoring trust in your timeline.
                  </p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    The Help & Guides exist so you can fix once, correctly — avoid rework, preserve your archive long-term, and stay in control of your data.
                  </p>
                </div>
              </section>
            </div>
            
            <div className="mt-12 pt-8 border-t border-border">
              <Button 
                variant="outline" 
                onClick={onBackToWorkspace}
                className="text-muted-foreground hover:text-foreground"
                data-testid="button-back-to-workspace-bottom"
              >
                <ChevronRight className="w-4 h-4 mr-1 rotate-180" /> Back to Workspace
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Fallback
  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-background">
      <div className="flex-1 flex flex-col items-center px-8 pt-12 pb-20">
        <div className="w-full max-w-[940px]">
          <Button 
            variant="outline" 
            onClick={onBackToWorkspace}
            className="mb-6 text-muted-foreground hover:text-foreground"
            data-testid="button-back-to-workspace-top"
          >
            <ChevronRight className="w-4 h-4 mr-1 rotate-180" /> Back to Workspace
          </Button>
          <h2 className="text-2xl font-semibold text-foreground mb-10">Page Not Found</h2>
          
          <Card className="p-6 bg-secondary/20 border-primary/10">
            <p className="text-sm text-muted-foreground">The requested page could not be found.</p>
          </Card>
          
          <div className="mt-12 pt-8 border-t border-border">
            <Button 
              variant="outline" 
              onClick={onBackToWorkspace}
              className="text-muted-foreground hover:text-foreground"
              data-testid="button-back-to-workspace-bottom"
            >
              <ChevronRight className="w-4 h-4 mr-1 rotate-180" /> Back to Workspace
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SourceAddedModal({ source, stats, analysisElapsed, onAddToWorkspace, onChangeSource, onCancel, onAddFolder, onAddZip, isLicensed, onLicenseRequired }: { source: Source, stats: PreScanStats, analysisElapsed?: number | null, onAddToWorkspace: () => void, onChangeSource: () => void, onCancel: () => void, onAddFolder: () => void, onAddZip: () => void, isLicensed: boolean, onLicenseRequired: () => void }) {
  const [step, setStep] = useState<'review' | 'success'>('review');
  const [storageInfo, setStorageInfo] = useState<{ label: string; description: string; isOptimal: boolean } | null>(null);
  const [showStorageTips, setShowStorageTips] = useState(true);

  const formatElapsed = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  useEffect(() => {
    // Load setting and classify storage
    getSettings().then(settings => {
      setShowStorageTips(settings.showStoragePerformanceTips);
    });
    
    if (source?.path) {
      classifyStorage(source.path).then(result => {
        if (result) {
          setStorageInfo({
            label: result.label,
            description: result.description,
            isOptimal: result.isOptimal
          });
        }
      });
    }
  }, [source?.path]);

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
            
            <div className="flex justify-center">
			<Button
			  onClick={() => isLicensed ? onAddFolder() : onLicenseRequired()}
			  className="h-11 bg-primary hover:bg-primary/90 px-8"
			>
			  <Plus className="w-4 h-4 mr-2" /> Add Another Source
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
            {analysisElapsed != null && analysisElapsed > 0 && (
              <div className="flex items-center justify-between pt-1">
                <span className="text-muted-foreground">Analysis completed in {formatElapsed(analysisElapsed)}</span>
              </div>
            )}
          </div>
          
          {/* Storage Performance Indicator */}
          {showStorageTips && storageInfo && (
            <div className={`mt-3 pt-3 border-t border-border/40 flex items-center gap-2 text-xs ${
              storageInfo.isOptimal ? 'text-emerald-600' : 'text-amber-600'
            }`}>
              {storageInfo.isOptimal ? (
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              )}
              <span>{storageInfo.description}</span>
            </div>
          )}

          {/* Skipped files — shown only when the engine hit per-file
              errors during analysis (corrupt zip entries, unreadable
              bytes). Prior behaviour was to die on the first bad file;
              the new engine continues and reports them here so the
              user knows exactly what didn't make it through. */}
          {stats.skippedFiles && stats.skippedFiles.length > 0 && (
            <SkippedFilesCallout skippedFiles={stats.skippedFiles} />
          )}
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

/**
 * Warning callout rendered on the Source added card when the analysis
 * engine couldn't process one or more files. Collapses to a count by
 * default; expanding reveals the per-file reason list.
 *
 * Amber styling because it's an advisory, not an error — the rest of
 * the analysis still ran correctly and the user can proceed to Fix;
 * they just need to know which files won't be copied to the
 * destination.
 */
function SkippedFilesCallout({ skippedFiles }: { skippedFiles: Array<{ filename: string; reason: string }> }) {
  const [expanded, setExpanded] = useState(false);
  const n = skippedFiles.length;
  return (
    <div className="mt-3 pt-3 border-t border-border/40">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 transition-colors"
      >
        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span className="flex-1 text-left">
          <span className="font-medium">
            {n === 1
              ? "1 file couldn't be processed"
              : `${n.toLocaleString()} files couldn't be processed`}
          </span>
          <span className="text-muted-foreground ml-1">
            · {expanded ? 'hide details' : 'show details'}
          </span>
          <span className="block text-muted-foreground font-normal mt-0.5">
            These files will not be copied to your destination. The rest of your source analysed normally.
          </span>
        </span>
      </button>
      {expanded && (
        <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <ul className="space-y-1.5 text-[11px]">
            {skippedFiles.slice(0, 50).map((f, i) => (
              <li key={`${f.filename}-${i}`} className="flex flex-col">
                <span className="font-mono text-foreground break-all">{f.filename}</span>
                <span className="text-muted-foreground italic">{f.reason}</span>
              </li>
            ))}
            {skippedFiles.length > 50 && (
              <li className="text-muted-foreground italic pt-1">
                …and {(skippedFiles.length - 50).toLocaleString()} more (see main.log for the full list)
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

const SKIP_WELCOME_KEY = 'pdr-skip-welcome';

export function getSkipWelcomeScreen(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(SKIP_WELCOME_KEY) === 'true';
}

export function setSkipWelcomeScreen(skip: boolean): void {
  if (typeof window !== 'undefined') {
    if (skip) {
      localStorage.setItem(SKIP_WELCOME_KEY, 'true');
    } else {
      localStorage.removeItem(SKIP_WELCOME_KEY);
    }
  }
}

function SettingsModal({ initialTab, onClose, folderStructure, onFolderStructureChange, playSound, onPlaySoundChange }: {
  initialTab?: 'general' | 'workspace' | 'sd' | 'people' | 'ai' | 'backup',
  onClose: () => void,
  folderStructure: 'year' | 'year-month' | 'year-month-day',
  onFolderStructureChange: (value: 'year' | 'year-month' | 'year-month-day') => void,
  playSound: boolean,
  onPlaySoundChange: (value: boolean) => void
}) {
  // Gate destructive engine operations (Re-cluster) when a Fix is
  // running anywhere — same broadcast-driven flag the rest of PDR
  // uses to keep mutations off the AI engine while it's busy.
  const fixActive = useFixInProgress();
  const [showWelcome, setShowWelcome] = useState(!getSkipWelcomeScreen());
  // Appearance — mirrors TitleBar's dark/light toggle so users who
  // miss the small moon/sun icon up top can find the toggle in
  // Settings → General. Source of truth is the `dark` class on
  // documentElement (synced via MutationObserver).
  const [appearanceDark, setAppearanceDark] = useState<boolean>(() => {
    if (typeof document === 'undefined') return false;
    return document.documentElement.classList.contains('dark');
  });
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setAppearanceDark(document.documentElement.classList.contains('dark'));
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  const setAppearance = (dark: boolean) => {
    if (dark) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
    try { localStorage.setItem('pdr-dark-mode', dark ? 'true' : 'false'); } catch {}
    (window as any).pdr?.setTitleBarColor?.(dark);
  };
  const [allowReportRemoval, setAllowReportRemoval] = useState(
    localStorage.getItem('pdr-allow-report-removal') === 'true'
  );
  const [allowIndexRemoval, setAllowIndexRemoval] = useState(
    localStorage.getItem('pdr-allow-index-removal') === 'true'
  );
  const [allowTreeRemoval, setAllowTreeRemoval] = useState(
    localStorage.getItem('pdr-allow-tree-removal') === 'true'
  );
  const [showLibraryManager, setShowLibraryManager] = useState(
    localStorage.getItem('pdr-show-library-manager') === 'true'
  );
  const [autoAddToSD, setAutoAddToSD] = useState<'ask' | 'always'>(
    (localStorage.getItem('pdr-auto-add-to-sd') as 'ask' | 'always') === 'always' ? 'always' : 'ask'
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  
    // Advanced settings state
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [thoroughDuplicateMatching, setThoroughDuplicateMatching] = useState(false);
  const [writeExif, setWriteExif] = useState(false);
  const [exifWriteConfirmed, setExifWriteConfirmed] = useState(true);
  const [exifWriteRecovered, setExifWriteRecovered] = useState(true);
  const [exifWriteMarked, setExifWriteMarked] = useState(false);
  const [showStoragePerformanceTips, setShowStoragePerformanceTips] = useState(true);
  const [rememberSources, setRememberSources] = useState(true);
  const [clearSourcesAfterFix, setClearSourcesAfterFix] = useState(true);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiFaceDetection, setAiFaceDetection] = useState(true);
  const [aiObjectTagging, setAiObjectTagging] = useState(true);
  const [aiAutoProcess, setAiAutoProcess] = useState(true);
  const [aiVisualSuggestions, setAiVisualSuggestions] = useState(true);
  const [aiRefineFromVerified, setAiRefineFromVerified] = useState(false);
  const [autoSaveCatalogue, setAutoSaveCatalogue] = useState(true);
  const [showManualReportExports, setShowManualReportExports] = useState(false);
  const [openPeopleOnStartup, setOpenPeopleOnStartup] = useState(false);
  // Network upload mode: 'fast' = robocopy /MT:16 staging, 'direct'
  // = legacy fs.createReadStream loop. A/B baseline + kill switch.
  const [networkUploadMode, setNetworkUploadMode] = useState<'fast' | 'direct'>('fast');

  // Load settings on mount
  useEffect(() => {
    getSettings().then((settings) => {
      setSkipDuplicates(settings.skipDuplicates);
      setThoroughDuplicateMatching(settings.thoroughDuplicateMatching ?? false);
      setWriteExif(settings.writeExif);
      setExifWriteConfirmed(settings.exifWriteConfirmed);
      setExifWriteRecovered(settings.exifWriteRecovered);
      setExifWriteMarked(settings.exifWriteMarked);
      setShowStoragePerformanceTips(settings.showStoragePerformanceTips);
      setRememberSources(settings.rememberSources);
      setClearSourcesAfterFix(settings.clearSourcesAfterFix);
      setAiEnabled(settings.aiEnabled);
      setAiFaceDetection(settings.aiFaceDetection);
      setAiObjectTagging(settings.aiObjectTagging);
      setAiAutoProcess(settings.aiAutoProcess);
      setAiVisualSuggestions(settings.aiVisualSuggestions ?? true);
      setAiRefineFromVerified((settings as any).aiRefineFromVerified ?? false);
      setAutoSaveCatalogue(settings.autoSaveCatalogue);
      setShowManualReportExports(settings.showManualReportExports);
      setOpenPeopleOnStartup((settings as any).openPeopleOnStartup ?? false);
      setNetworkUploadMode(((settings as any).networkUploadMode as 'fast' | 'direct') ?? 'fast');
    });
  }, []);

  const handleNetworkUploadModeChange = (mode: 'fast' | 'direct') => {
    setNetworkUploadMode(mode);
    setSetting('networkUploadMode' as any, mode);
  };

  const handleSkipDuplicatesToggle = (checked: boolean) => {
    setSkipDuplicates(checked);
    setSetting('skipDuplicates', checked);
  };

  const handleThoroughDuplicateMatchingToggle = (checked: boolean) => {
    setThoroughDuplicateMatching(checked);
    setSetting('thoroughDuplicateMatching', checked);
  };

  const handleWriteExifToggle = (checked: boolean) => {
    setWriteExif(checked);
    setSetting('writeExif', checked);
  };

  const handleExifWriteConfirmedToggle = (checked: boolean) => {
    setExifWriteConfirmed(checked);
    setSetting('exifWriteConfirmed', checked);
  };

  const handleExifWriteRecoveredToggle = (checked: boolean) => {
    setExifWriteRecovered(checked);
    setSetting('exifWriteRecovered', checked);
  };

  const handleExifWriteMarkedToggle = (checked: boolean) => {
    setExifWriteMarked(checked);
    setSetting('exifWriteMarked', checked);
  };
  
  const handleStoragePerformanceTipsToggle = (checked: boolean) => {
    setShowStoragePerformanceTips(checked);
    setSetting('showStoragePerformanceTips', checked);
  };

  const handleRememberSourcesToggle = (checked: boolean) => {
    setRememberSources(checked);
    setSetting('rememberSources', checked);
    if (!checked) {
      // When turning off, clear any persisted sources immediately
      localStorage.removeItem("pdr-sources");
      localStorage.removeItem("pdr-source-analysis-results");
    }
  };

  const handleClearSourcesAfterFixToggle = (checked: boolean) => {
    setClearSourcesAfterFix(checked);
    setSetting('clearSourcesAfterFix', checked);
  };

  const handleAiEnabledToggle = (checked: boolean) => {
    setAiEnabled(checked);
    setSetting('aiEnabled', checked);
  };
  const handleAiFaceDetectionToggle = (checked: boolean) => {
    setAiFaceDetection(checked);
    setSetting('aiFaceDetection', checked);
  };
  const handleAiObjectTaggingToggle = (checked: boolean) => {
    setAiObjectTagging(checked);
    setSetting('aiObjectTagging', checked);
  };
  const handleAiAutoProcessToggle = (checked: boolean) => {
    setAiAutoProcess(checked);
    setSetting('aiAutoProcess', checked);
  };
  const handleAiVisualSuggestionsToggle = (checked: boolean) => {
    setAiVisualSuggestions(checked);
    setSetting('aiVisualSuggestions', checked);
  };
  const handleAiRefineFromVerifiedToggle = (checked: boolean) => {
    setAiRefineFromVerified(checked);
    setSetting('aiRefineFromVerified' as any, checked);
  };
  const handleOpenPeopleOnStartupToggle = (checked: boolean) => {
    setOpenPeopleOnStartup(checked);
    setSetting('openPeopleOnStartup' as any, checked);
  };

  const handleAutoSaveCatalogueToggle = (checked: boolean) => {
    setAutoSaveCatalogue(checked);
    setSetting('autoSaveCatalogue', checked);
  };

  const handleShowManualReportExportsToggle = (checked: boolean) => {
    setShowManualReportExports(checked);
    setSetting('showManualReportExports', checked);
  };

  const handleReportRemovalToggle = (checked: boolean) => {
    setAllowReportRemoval(checked);
    if (checked) {
      localStorage.setItem('pdr-allow-report-removal', 'true');
    } else {
      localStorage.removeItem('pdr-allow-report-removal');
    }
  };

  const handleTreeRemovalToggle = (checked: boolean) => {
    setAllowTreeRemoval(checked);
    if (checked) localStorage.setItem('pdr-allow-tree-removal', 'true');
    else localStorage.removeItem('pdr-allow-tree-removal');
  };

  const handleIndexRemovalToggle = (checked: boolean) => {
    setAllowIndexRemoval(checked);
    if (checked) {
      localStorage.setItem('pdr-allow-index-removal', 'true');
    } else {
      localStorage.removeItem('pdr-allow-index-removal');
    }
  };

  const handleShowLibraryManagerToggle = (checked: boolean) => {
    setShowLibraryManager(checked);
    if (checked) {
      localStorage.setItem('pdr-show-library-manager', 'true');
    } else {
      localStorage.removeItem('pdr-show-library-manager');
    }
  };

  const handleAutoAddToSDChange = (value: 'ask' | 'always') => {
    setAutoAddToSD(value);
    localStorage.setItem('pdr-auto-add-to-sd', value);
  };

  const handleWelcomeToggle = (checked: boolean) => {
    setShowWelcome(checked);
    setSkipWelcomeScreen(!checked);
  };
  
  const handleResetToDefaults = async () => {
    await resetSettingsToDefaults();
    setSkipDuplicates(true);
    setThoroughDuplicateMatching(false);
    setWriteExif(true);
    setExifWriteConfirmed(true);
    setExifWriteRecovered(true);
    setExifWriteMarked(false);
    setShowStoragePerformanceTips(true);
    setAllowReportRemoval(false);
    setAllowIndexRemoval(false);
    setShowWelcome(true);
    setSkipWelcomeScreen(false);
    onFolderStructureChange('year');
    onPlaySoundChange(true);
    setAiEnabled(false);
    setAiFaceDetection(true);
    setAiObjectTagging(true);
    setAiAutoProcess(true);
    setAutoSaveCatalogue(true);
    setShowManualReportExports(false);
    localStorage.removeItem('pdr-allow-report-removal');
    localStorage.removeItem('pdr-allow-index-removal');
    localStorage.removeItem('pdr-show-library-manager');
    localStorage.removeItem('pdr-master-lib-dismissed');
    localStorage.removeItem('pdr-master-lib-seen-count');
    localStorage.removeItem('pdr-library-planner-complete');
    localStorage.removeItem('pdr-library-planner-size');
    localStorage.removeItem('pdr-library-planner-multi');
    localStorage.setItem('pdr-auto-add-to-sd', 'ask');
    localStorage.removeItem('pdr-saved-destinations');
    setShowLibraryManager(false);
    setAutoAddToSD('ask');
  };

  const [settingsTab, setSettingsTab] = useState<'general' | 'workspace' | 'sd' | 'people' | 'ai' | 'backup'>(initialTab ?? 'general');
  const [folderStructureOpen, setFolderStructureOpen] = useState(false);

  // Backup list — fetched on demand when the user expands the Restore
  // section so we don't pay a stat()-of-the-backup-dir cost every time
  // Settings opens.
  const [backupsExpanded, setBackupsExpanded] = useState(false);
  const [backups, setBackups] = useState<DbBackup[] | null>(null);
  const [backupsLoading, setBackupsLoading] = useState(false);
  // Manual-snapshot label modal — replaces the broken window.prompt()
  // that Electron's renderer blocks. Open: input visible. Save:
  // calls takeSnapshotBridge('manual', label) then refreshes list.
  const [manualSnapshotOpen, setManualSnapshotOpen] = useState(false);
  const [manualSnapshotLabel, setManualSnapshotLabel] = useState('');
  const [manualSnapshotSaving, setManualSnapshotSaving] = useState(false);
  // Re-cluster modal — destructive operation, deliberately gated
  // behind a confirmation with a snapshot-first toggle (default ON
  // so a one-click rollback is always available if the recluster
  // produces a worse grouping).
  const [reclusterModalOpen, setReclusterModalOpen] = useState(false);
  const [reclusterThreshold, setReclusterThreshold] = useState<number>(0.72);
  const [reclusterSnapshotFirst, setReclusterSnapshotFirst] = useState(true);
  const [reclusterRunning, setReclusterRunning] = useState(false);
  // Live elapsed-seconds counter while the recluster job is in
  // flight. Re-cluster takes ~30–60s on typical libraries with no
  // backend progress events to plumb through, so we show an honest
  // wall-clock instead of a fake percentage. Resets on each run.
  const [reclusterElapsed, setReclusterElapsed] = useState(0);
  // Holds the outcome of the most recent run so the modal can
  // surface a green-check "Done — PM refreshed" panel that the user
  // dismisses themselves. Previously the modal closed in finally{}
  // the moment the IPC resolved, which left the user wondering
  // whether anything had updated.
  const [reclusterResult, setReclusterResult] = useState<{ success: boolean; error?: string; durationSec: number; snapshotTook?: boolean } | null>(null);
  // Sync threshold from settings on modal open so the user sees the
  // value PM was last using.
  useEffect(() => {
    if (!reclusterModalOpen) return;
    getSettings().then((s) => {
      const t = (s as any)?.matchThreshold;
      if (typeof t === 'number') setReclusterThreshold(t);
    }).catch(() => {});
  }, [reclusterModalOpen]);
  // Tick the elapsed counter every second while running.
  useEffect(() => {
    if (!reclusterRunning) return;
    setReclusterElapsed(0);
    const startedAt = Date.now();
    const id = setInterval(() => setReclusterElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [reclusterRunning]);
  const refreshBackups = async () => {
    setBackupsLoading(true);
    try {
      const r = await listBackups();
      if (r.success && r.data) setBackups(r.data);
    } finally {
      setBackupsLoading(false);
    }
  };

  const options = [
    { value: 'year' as const, label: 'Year', example: '2024/' },
    { value: 'year-month' as const, label: 'Year / Month', example: '2024/03/' },
    { value: 'year-month-day' as const, label: 'Year / Month / Day', example: '2024/03/15/' },
  ];

  // Settings tab classes — compact since we now host 6 tabs in a 2xl
  // modal. Padding/font slightly tighter than before so all six fit
  // without horizontal scrolling at typical zoom levels.
  const tabClass = (tab: string) =>
    `flex-1 px-2 py-2 text-xs font-medium cursor-pointer transition-all duration-200 border-b-2 whitespace-nowrap ${
      settingsTab === tab
        ? 'border-primary text-primary bg-background'
        : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30 bg-muted/40'
    } ${tab === 'general' ? 'rounded-tl-lg' : ''} ${tab === 'backup' ? 'rounded-tr-lg' : ''}`;

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
        className="bg-background rounded-2xl shadow-2xl max-w-2xl w-full p-6"
      >
        <div className="relative mb-5 text-center">
          <div className="flex items-center justify-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Settings className="w-5 h-5 text-primary" />
            </div>
            <h2 className="text-xl font-semibold text-foreground">Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="absolute right-0 top-1/2 -translate-y-1/2 p-2 hover:bg-secondary rounded-full transition-colors"
            data-testid="button-close-settings"
          >
            <X className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>

        {/* ===== TAB BAR =====
            Six tabs, one per app area. Order roughly mirrors a user's
            journey through PDR: General settings, then Workspace
            (where they spend most of their time fixing), then the
            search/discovery / people / AI tooling, then Backup as the
            recovery escape hatch. */}
        <div className="flex border-b border-border mb-0">
          <button type="button" className={tabClass('general')} onClick={() => setSettingsTab('general')} data-testid="tab-general">
            General
          </button>
          <button type="button" className={tabClass('workspace')} onClick={() => setSettingsTab('workspace')} data-testid="tab-workspace">
            Workspace
          </button>
          <button type="button" className={tabClass('sd')} onClick={() => setSettingsTab('sd')} data-testid="tab-sd">
            S&amp;D
          </button>
          <button type="button" className={tabClass('people')} onClick={() => setSettingsTab('people')} data-testid="tab-people">
            People
          </button>
          <button type="button" className={tabClass('ai')} onClick={() => setSettingsTab('ai')} data-testid="tab-ai">
            <span className="flex items-center justify-center gap-1">
              AI
              <Sparkles className="w-3 h-3" />
            </span>
          </button>
          <button type="button" className={tabClass('backup')} onClick={() => setSettingsTab('backup')} data-testid="tab-backup">
            Backup
          </button>
        </div>

        <div className="space-y-5 h-[45vh] overflow-y-auto pr-2 pt-5">

          {/* ═══════════════════════════════════════════════════════════════
              GENERAL TAB
              ═══════════════════════════════════════════════════════════════ */}
          {settingsTab === 'general' && (
            <>
              {/* General — true cross-app preferences only. Folder
                  structure, sources, fix-engine behaviour all moved
                  to the Workspace tab where they belong. */}

              {/* Appearance — light/dark mode. Mirrors the small
                  moon/sun icon in the TitleBar but in a place users
                  routinely visit. Premium feel: segmented control
                  with icons rather than a plain checkbox. */}
              <div>
                <div className="flex items-center justify-between p-3 rounded-lg border border-border">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">Appearance</span>
                    <span className="text-xs text-muted-foreground">Light or dark interface — affects every PDR window.</span>
                  </div>
                  <div className="inline-flex items-center rounded-lg border border-border bg-secondary/30 p-0.5">
                    <button
                      type="button"
                      onClick={() => setAppearance(false)}
                      className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                        !appearanceDark ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                      }`}
                      aria-pressed={!appearanceDark}
                    >
                      <Sun className="w-3.5 h-3.5" />
                      Light
                    </button>
                    <button
                      type="button"
                      onClick={() => setAppearance(true)}
                      className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                        appearanceDark ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                      }`}
                      aria-pressed={appearanceDark}
                    >
                      <Moon className="w-3.5 h-3.5" />
                      Dark
                    </button>
                  </div>
                </div>
              </div>

              {/* Notifications */}
              <div className="pt-4 border-t border-border">
                <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">Play completion sound</span>
                    <span className="text-xs text-muted-foreground">Play a sound and flash taskbar when fixes complete</span>
                  </div>
                  <Checkbox
                    checked={playSound}
                    onCheckedChange={(checked) => onPlaySoundChange(!!checked)}
                    data-testid="checkbox-completion-sound"
                  />
                </label>
              </div>

              {/* Welcome Screen */}
              <div className="pt-4 border-t border-border">
                <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">Show Welcome Screen on launch</span>
                    <span className="text-xs text-muted-foreground">Display the onboarding screen when the app starts</span>
                  </div>
                  <Checkbox
                    checked={showWelcome}
                    onCheckedChange={(checked) => handleWelcomeToggle(!!checked)}
                    data-testid="checkbox-show-welcome"
                  />
                </label>
              </div>
            </>
          )}

          {/* ═══════════════════════════════════════════════════════════════
              WORKSPACE TAB
              Everything that affects the Workspace / Dashboard area:
              folder layout of the destination, source management,
              duplicate handling, EXIF writing, catalogue output.
              ═══════════════════════════════════════════════════════════════ */}
          {settingsTab === 'workspace' && (
            <>
              {/* Folder Structure — collapsible (moved from General) */}
              <div>
                <button
                  type="button"
                  onClick={() => setFolderStructureOpen(!folderStructureOpen)}
                  className="w-full flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors"
                  data-testid="button-toggle-folder-structure"
                >
                  <div className="flex flex-col text-left">
                    <span className="text-sm font-medium text-foreground">Folder Structure</span>
                    <span className="text-xs text-muted-foreground">
                      {options.find(o => o.value === folderStructure)?.label} <span className="font-mono ml-1 text-muted-foreground/70">{options.find(o => o.value === folderStructure)?.example}</span>
                    </span>
                  </div>
                  <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${folderStructureOpen ? 'rotate-180' : ''}`} />
                </button>
                {folderStructureOpen && (
                  <div className="mt-2 ml-1 space-y-2 animate-in fade-in slide-in-from-top-2 duration-200">
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
                )}
              </div>

              {/* Sources (moved from General) */}
              <div className="pt-4 border-t border-border">
                <label className="block text-sm font-medium text-foreground mb-3">Sources</label>
                <div className="space-y-2">
                  <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-foreground">Remember sources between sessions</span>
                      <span className="text-xs text-muted-foreground">Keep your added sources if the app restarts or crashes</span>
                    </div>
                    <Checkbox
                      checked={rememberSources}
                      onCheckedChange={(checked) => handleRememberSourcesToggle(!!checked)}
                      data-testid="checkbox-remember-sources"
                    />
                  </label>
                  <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-foreground">Clear sources after fix</span>
                      <span className="text-xs text-muted-foreground">Automatically remove sources from the sidebar after a fix completes</span>
                    </div>
                    <Checkbox
                      checked={clearSourcesAfterFix}
                      onCheckedChange={(checked) => handleClearSourcesAfterFixToggle(!!checked)}
                      data-testid="checkbox-clear-sources-after-fix"
                    />
                  </label>
                </div>
              </div>

              {/* Network upload mode — A/B baseline + kill switch.
                  Only matters for network destinations; local copies
                  always use the direct path. */}
              <div className="pt-4 border-t border-border">
                <label className="block text-sm font-medium text-foreground mb-1">Network upload mode</label>
                <p className="text-xs text-muted-foreground mb-3">
                  How PDR copies files to a network destination (UNC paths or mapped network drives). Local destinations always use Direct.
                </p>
                <div className="space-y-2">
                  <label
                    className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors ${
                      networkUploadMode === 'fast' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-secondary/50'
                    }`}
                    data-testid="option-network-upload-fast"
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="radio"
                        name="networkUploadMode"
                        value="fast"
                        checked={networkUploadMode === 'fast'}
                        onChange={() => handleNetworkUploadModeChange('fast')}
                        className="w-4 h-4 text-primary focus:ring-primary"
                      />
                      <div className="flex flex-col">
                        <span className="text-sm font-medium text-foreground">Fast <span className="text-xs font-normal text-muted-foreground">(recommended)</span></span>
                        <span className="text-xs text-muted-foreground">Stages files locally, then mirrors to the network with robocopy /MT:16. Typically 3–5× faster on SMB shares (measured on a WD MyCloud over Wi-Fi; wired connections can land higher).</span>
                      </div>
                    </div>
                  </label>
                  <label
                    className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors ${
                      networkUploadMode === 'direct' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-secondary/50'
                    }`}
                    data-testid="option-network-upload-direct"
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="radio"
                        name="networkUploadMode"
                        value="direct"
                        checked={networkUploadMode === 'direct'}
                        onChange={() => handleNetworkUploadModeChange('direct')}
                        className="w-4 h-4 text-primary focus:ring-primary"
                      />
                      <div className="flex flex-col">
                        <span className="text-sm font-medium text-foreground">Legacy</span>
                        <span className="text-xs text-muted-foreground">Per-file streaming copy — the way PDR worked before Fast shipped. Slower, but byte-for-byte identical to the pre-Robocopy code path. Keep as a kill switch if Fast misbehaves on your NAS.</span>
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              {/* Duplicate Handling — standard */}
              <div className="pt-4 border-t border-border">
                <label className="block text-sm font-medium text-foreground mb-3">
                  Duplicate Handling
                </label>
                <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">Skip duplicate files (recommended)</span>
                    <span className="text-xs text-muted-foreground">Duplicate files are detected and skipped during Run Fix</span>
                  </div>
                  <Checkbox
                    checked={skipDuplicates}
                    onCheckedChange={(checked) => handleSkipDuplicatesToggle(!!checked)}
                    data-testid="checkbox-skip-duplicates"
                  />
                </label>
              </div>

              {/* Storage Performance — standard */}
              <div className="pt-4 border-t border-border">
                <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">Show storage performance tips</span>
                    <span className="text-xs text-muted-foreground">Display helpful messages about storage speed when selecting sources</span>
                  </div>
                  <Checkbox
                    checked={showStoragePerformanceTips}
                    onCheckedChange={(checked) => handleStoragePerformanceTipsToggle(!!checked)}
                    data-testid="checkbox-storage-tips"
                  />
                </label>
              </div>

              {/* ===== ADVANCED (collapsible) ===== */}
              <div className="pt-4 border-t border-border">
                <button
                  type="button"
                  onClick={() => setAdvancedOpen(!advancedOpen)}
                  className={`w-full flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-all duration-200 ${
                    advancedOpen
                      ? 'border-amber-300 dark:border-amber-700 bg-amber-50/50 dark:bg-amber-950/30'
                      : 'border-border hover:border-amber-300/50 hover:bg-amber-50/30 dark:hover:border-amber-700/50 dark:hover:bg-amber-950/20'
                  }`}
                  data-testid="button-toggle-advanced"
                >
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500 dark:text-amber-400" />
                    <span className="text-sm font-medium text-foreground">Advanced</span>
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-700/50">
                      ADVANCED
                    </span>
                  </div>
                  <ChevronDown
                    className={`w-4 h-4 text-amber-500 dark:text-amber-400 transition-transform duration-200 ${advancedOpen ? 'rotate-180' : ''}`}
                  />
                </button>

                {advancedOpen && (
                  <div className="mt-3 p-4 rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50/30 dark:bg-amber-950/20 animate-in fade-in slide-in-from-top-2 duration-200">
                    <div className="flex items-start gap-2 mb-4 pb-3 border-b border-amber-200/50 dark:border-amber-800/30">
                      <Info className="w-4 h-4 text-amber-500 dark:text-amber-400 mt-0.5 shrink-0" />
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        Defaults are optimal for most users — change only if needed.
                      </p>
                    </div>
                    <div className="space-y-4">
                      {/* Thorough duplicate matching */}
                      {skipDuplicates && (
                        <label className="flex items-center justify-between p-3 rounded-lg border border-amber-200 dark:border-amber-700/50 bg-amber-50/50 dark:bg-amber-950/20 cursor-pointer transition-colors animate-in fade-in slide-in-from-top-2 duration-200">
                          <div className="flex flex-col">
                            <span className="text-sm font-medium text-amber-700 dark:text-amber-300">Thorough duplicate matching</span>
                            <span className="text-xs text-muted-foreground">Use SHA-256 file hash instead of filename + size. More accurate but significantly slower on network/cloud drives.</span>
                          </div>
                          <Checkbox
                            checked={thoroughDuplicateMatching}
                            onCheckedChange={(checked) => handleThoroughDuplicateMatchingToggle(!!checked)}
                            data-testid="checkbox-thorough-duplicates"
                          />
                        </label>
                      )}

                      {/* EXIF Date Writing */}
                      <div className="pt-3 border-t border-amber-200/50 dark:border-amber-800/30">
                        <label className="block text-sm font-medium text-foreground mb-3">EXIF Date Writing</label>
                        <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors mb-2">
                          <div className="flex flex-col">
                            <span className="text-sm font-medium text-foreground">Write dates to photo metadata (EXIF)</span>
                            <span className="text-xs text-muted-foreground">Populate EXIF date fields when copying photos</span>
                          </div>
                          <Checkbox
                            checked={writeExif}
                            onCheckedChange={(checked) => handleWriteExifToggle(!!checked)}
                            data-testid="checkbox-write-exif"
                          />
                        </label>
                        {writeExif && (
                          <div className="ml-4 space-y-2 animate-in fade-in slide-in-from-top-2 duration-200">
                            <label className="flex items-center justify-between p-3 rounded-lg border border-emerald-200 dark:border-emerald-700/50 bg-emerald-50/50 dark:bg-emerald-950/20 cursor-pointer transition-colors">
                              <div className="flex flex-col">
                                <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300">Confirmed files</span>
                                <span className="text-xs text-muted-foreground">Normalise metadata using the trusted EXIF/Takeout date</span>
                              </div>
                              <Checkbox
                                checked={exifWriteConfirmed}
                                onCheckedChange={(checked) => handleExifWriteConfirmedToggle(!!checked)}
                                data-testid="checkbox-exif-confirmed"
                              />
                            </label>
                            <label className="flex items-center justify-between p-3 rounded-lg border border-indigo-200 dark:border-indigo-700/50 bg-indigo-50/50 dark:bg-indigo-950/20 cursor-pointer transition-colors">
                              <div className="flex flex-col">
                                <span className="text-sm font-medium text-indigo-700 dark:text-indigo-300">Recovered files (recommended)</span>
                                <span className="text-xs text-muted-foreground">Populate EXIF with the date recovered from filename patterns</span>
                              </div>
                              <Checkbox
                                checked={exifWriteRecovered}
                                onCheckedChange={(checked) => handleExifWriteRecoveredToggle(!!checked)}
                                data-testid="checkbox-exif-recovered"
                              />
                            </label>
                            <label className="flex items-center justify-between p-3 rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50/50 dark:bg-slate-900/20 cursor-pointer transition-colors">
                              <div className="flex flex-col">
                                <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Marked files (advanced)</span>
                                <span className="text-xs text-muted-foreground">Populate EXIF with fallback date — use with caution</span>
                              </div>
                              <Checkbox
                                checked={exifWriteMarked}
                                onCheckedChange={(checked) => handleExifWriteMarkedToggle(!!checked)}
                                data-testid="checkbox-exif-marked"
                              />
                            </label>
                          </div>
                        )}
                      </div>

                      {/* Report Management */}
                      <div className="pt-3 border-t border-amber-200/50 dark:border-amber-800/30">
                        <label className="block text-sm font-medium text-foreground mb-3">Data Management</label>
                        <div className="space-y-2">
                          <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors">
                            <div className="flex flex-col">
                              <span className="text-sm font-medium text-foreground">Allow Report Removal</span>
                              <span className="text-xs text-muted-foreground">Enable deleting saved reports from history</span>
                            </div>
                            <Checkbox
                              checked={allowReportRemoval}
                              onCheckedChange={(checked) => handleReportRemovalToggle(!!checked)}
                              data-testid="checkbox-allow-report-removal"
                            />
                          </label>
                          <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors">
                            <div className="flex flex-col">
                              <span className="text-sm font-medium text-foreground">Show CSV/TXT export buttons</span>
                              <span className="text-xs text-muted-foreground">Manual exports for standalone reports (auditing, sharing). The auto-catalogue already maintains a complete record.</span>
                            </div>
                            <Checkbox
                              checked={showManualReportExports}
                              onCheckedChange={(checked) => handleShowManualReportExportsToggle(!!checked)}
                              data-testid="checkbox-show-manual-exports"
                            />
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Catalogue (moved from Pro — fix-engine output behaviour) */}
              <div className="pt-4 border-t border-border">
                <label className="block text-sm font-medium text-foreground mb-1">
                  Catalogue
                </label>
                <p className="text-xs text-muted-foreground mb-3">
                  Automatically save a cumulative record of all fixed files to your destination.
                </p>
                <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">Save catalogue after each fix</span>
                    <span className="text-xs text-muted-foreground">Write PDR_Catalogue.csv and .txt to your destination — updates dynamically</span>
                  </div>
                  <Checkbox
                    checked={autoSaveCatalogue}
                    onCheckedChange={(checked) => handleAutoSaveCatalogueToggle(!!checked)}
                    data-testid="checkbox-auto-save-catalogue"
                  />
                </label>
              </div>
            </>
          )}

          {/* ═══════════════════════════════════════════════════════════════
              SEARCH & DISCOVERY TAB
              How fixed files reach the search index, and what the
              Library Manager surfaces for power-user index management.
              ═══════════════════════════════════════════════════════════════ */}
          {settingsTab === 'sd' && (
            <>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Search & Discovery</label>
                <p className="text-xs text-muted-foreground mb-3">Control how fixed files are added to your search library and what management tools are surfaced.</p>
                <div className="space-y-2">
                  <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-foreground">Always add fixes to Search & Discovery</span>
                      <span className="text-xs text-muted-foreground">Skip the prompt and automatically index every fix. When off, you'll be asked each time.</span>
                    </div>
                    <Checkbox
                      checked={autoAddToSD === 'always'}
                      onCheckedChange={(checked) => handleAutoAddToSDChange(checked ? 'always' : 'ask')}
                    />
                  </label>
                  <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-foreground">Show Library Manager</span>
                      <span className="text-xs text-muted-foreground">Show the Library Manager button in Search & Discovery for advanced index management.</span>
                    </div>
                    <Checkbox
                      checked={showLibraryManager}
                      onCheckedChange={(checked) => handleShowLibraryManagerToggle(!!checked)}
                    />
                  </label>
                  <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-foreground">Allow Index Removal</span>
                      <span className="text-xs text-muted-foreground">Enable removing destinations from the search library. Re-indexing requires running the fix again.</span>
                    </div>
                    <Checkbox
                      checked={allowIndexRemoval}
                      onCheckedChange={(checked) => handleIndexRemovalToggle(!!checked)}
                      data-testid="checkbox-allow-index-removal"
                    />
                  </label>
                </div>
              </div>
            </>
          )}

          {/* ═══════════════════════════════════════════════════════════════
              PEOPLE & TREES TAB
              People Manager hosting + face-recognition refinements +
              tree management. Face Detection master toggle stays on
              the AI tab; the per-feature refinements live here next
              to the apps that consume them.
              ═══════════════════════════════════════════════════════════════ */}
          {settingsTab === 'people' && (
            <>
              {/* People Manager — single setting, the launch-on-start
                  preference. Hosting mode used to be configurable
                  (window vs docked panel) but the docked panel idea
                  didn't pay for the screen real estate it cost; PM is
                  now always a separate window, pre-warmed in the
                  background so opening it feels instant regardless. */}
              <div className="space-y-3">
                <label className="block text-sm font-medium text-foreground mb-1">People Manager</label>
                <p className="text-xs text-muted-foreground mb-3">PM opens in its own window. PDR pre-loads it in the background a few seconds after launch so the icon click feels instant.</p>
                <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">Open People Manager on startup</span>
                    <span className="text-xs text-muted-foreground">Show the People Manager window automatically whenever PDR opens, instead of waiting for you to click the icon.</span>
                  </div>
                  <Checkbox
                    checked={openPeopleOnStartup}
                    onCheckedChange={(checked) => handleOpenPeopleOnStartupToggle(!!checked)}
                    data-testid="checkbox-open-people-on-startup"
                  />
                </label>
              </div>

              {/* Face recognition refinements — only meaningful when AI
                  is enabled in the AI tab. We still render them but
                  show a hint when the master toggle is off so the user
                  knows where to flip it. */}
              <div className="pt-4 border-t border-border">
                <label className="block text-sm font-medium text-foreground mb-1">Face recognition</label>
                <p className="text-xs text-muted-foreground mb-3">How PDR detects, refines, and suggests people. Requires AI to be enabled in the AI tab.</p>
                <div className="space-y-2">
                  <label className="flex items-center justify-between p-3 rounded-lg border border-violet-200 dark:border-violet-700/50 bg-violet-50/50 dark:bg-violet-950/20 cursor-pointer transition-colors">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-violet-700 dark:text-violet-300">Face Detection</span>
                      <span className="text-xs text-muted-foreground">Detect and cluster faces to identify people in photos</span>
                    </div>
                    <Checkbox
                      checked={aiFaceDetection}
                      onCheckedChange={(checked) => handleAiFaceDetectionToggle(!!checked)}
                      data-testid="checkbox-ai-face-detection"
                    />
                  </label>
                  <label className="flex items-center justify-between p-3 rounded-lg border border-violet-200 dark:border-violet-700/50 bg-violet-50/50 dark:bg-violet-950/20 cursor-pointer transition-colors">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-violet-700 dark:text-violet-300">Visual face suggestions</span>
                      <span className="text-xs text-muted-foreground">When naming a face, suggest visually similar people from your library</span>
                    </div>
                    <Checkbox
                      checked={aiVisualSuggestions}
                      onCheckedChange={(checked) => handleAiVisualSuggestionsToggle(!!checked)}
                      data-testid="checkbox-ai-visual-suggestions"
                    />
                  </label>
                  {/* The "Improve facial recognition" toggle was here.
                      Removed in the PM redesign — the button is now
                      always live in PM (no Settings gate) and the
                      tooltip "Only turn this on once you're sure the
                      verified faces are correct" was actively wrong:
                      auto-matched faces are excluded from training,
                      and the algorithm only needs ≥1 verified face
                      per named person. The aiRefineFromVerified
                      setting still exists in the store for backwards
                      compatibility but is never read. */}
                </div>
              </div>

              {/* Advanced — re-cluster unnamed groups. This is the
                  destructive operation that used to live behind PM's
                  Refresh button. Moved here per Apple/Adobe convention:
                  rare destructive admin operations don't sit one click
                  away from the everyday workflow. PM's Refresh now
                  just reloads (non-destructive); this is the explicit,
                  deliberate path for re-tuning the unnamed-cluster
                  topology. */}
              <div className="pt-4 border-t border-border">
                <label className="block text-sm font-medium text-foreground mb-1">Advanced</label>
                <p className="text-xs text-muted-foreground mb-3">Power-user operations on the face-recognition pipeline.</p>
                <div className="rounded-lg border border-amber-200 dark:border-amber-700/40 bg-amber-50/40 dark:bg-amber-950/15 p-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground mb-0.5">Re-cluster unnamed groups</div>
                      <div className="text-xs text-muted-foreground leading-relaxed">
                        Re-evaluates how unverified faces group together at your current Match strictness. Verified faces are untouched. Auto-matched faces may shift between groups — Improve Recognition can re-find any that get unlinked. Photos themselves are never affected. Most users never need this; it's here for when you've done a lot of naming and want PDR to redraw the unnamed-cluster boundaries.
                      </div>
                    </div>
                    <IconTooltip
                      label={fixActive ? FIX_BLOCKED_TOOLTIP + ' — re-clustering competes with the Fix for CPU and face data.' : 'Re-cluster unnamed groups at your current Match strictness'}
                      side="top"
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-amber-300 text-amber-700 hover:bg-amber-100/60 dark:hover:bg-amber-950/30 shrink-0 disabled:opacity-50"
                        onClick={() => setReclusterModalOpen(true)}
                        disabled={fixActive}
                      >
                        Re-cluster…
                      </Button>
                    </IconTooltip>
                  </div>
                </div>
              </div>

              {/* Trees */}
              <div className="pt-4 border-t border-border">
                <label className="block text-sm font-medium text-foreground mb-1">Trees</label>
                <p className="text-xs text-muted-foreground mb-3">Family-tree management.</p>
                <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">Allow Tree Removal</span>
                    <span className="text-xs text-muted-foreground">Show the Remove button for saved trees in the Manage Trees modal. Off by default to prevent accidental deletion — turning on treats deletion as a deliberate, two-step action.</span>
                  </div>
                  <Checkbox
                    checked={allowTreeRemoval}
                    onCheckedChange={(checked) => handleTreeRemovalToggle(!!checked)}
                  />
                </label>
              </div>
            </>
          )}

          {/* ═══════════════════════════════════════════════════════════════
              AI TAB — master toggles + tag-side controls
              ═══════════════════════════════════════════════════════════════ */}
          {settingsTab === 'ai' && (
            <>
              {/* AI Photo Analysis */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  AI Photo Analysis
                </label>
                <p className="text-xs text-muted-foreground mb-3">
                  Use on-device AI to detect faces and tag content in your photos. Videos are not included — AI analysis applies to photos only. All processing happens locally — nothing is ever uploaded.
                </p>
                <div className="space-y-2">
                  <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors">
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-violet-500" />
                        <span className="text-sm font-medium text-foreground">Enable AI Analysis</span>
                      </div>
                      <span className="text-xs text-muted-foreground ml-6">Unlock face recognition and object tagging in Search (photos only)</span>
                    </div>
                    <Checkbox
                      checked={aiEnabled}
                      onCheckedChange={(checked) => handleAiEnabledToggle(!!checked)}
                      data-testid="checkbox-ai-enabled"
                    />
                  </label>

                  {aiEnabled && (
                    <div className="ml-4 space-y-2 animate-in fade-in slide-in-from-top-2 duration-200">
                      {/* Face Detection sub-toggle is on the People tab,
                          alongside the rest of the face refinements
                          (visual suggestions, refine-from-verified).
                          Tag and run-control toggles live here. */}
                      <label className="flex items-center justify-between p-3 rounded-lg border border-violet-200 dark:border-violet-700/50 bg-violet-50/50 dark:bg-violet-950/20 cursor-pointer transition-colors">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-violet-700 dark:text-violet-300">Object & Scene Tagging</span>
                          <span className="text-xs text-muted-foreground">Auto-tag photos with content labels (sunset, beach, pet, etc.)</span>
                        </div>
                        <Checkbox
                          checked={aiObjectTagging}
                          onCheckedChange={(checked) => handleAiObjectTaggingToggle(!!checked)}
                          data-testid="checkbox-ai-object-tagging"
                        />
                      </label>
                      <label className="flex items-center justify-between p-3 rounded-lg border border-violet-200 dark:border-violet-700/50 bg-violet-50/50 dark:bg-violet-950/20 cursor-pointer transition-colors">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-violet-700 dark:text-violet-300">Auto-process new photos</span>
                          <span className="text-xs text-muted-foreground">Automatically analyze photos when new files are added to the library</span>
                        </div>
                        <Checkbox
                          checked={aiAutoProcess}
                          onCheckedChange={(checked) => handleAiAutoProcessToggle(!!checked)}
                          data-testid="checkbox-ai-auto-process"
                        />
                      </label>
                    </div>
                  )}
                </div>

                <div className="flex items-start gap-2 p-3 mt-3 rounded-lg bg-violet-50/30 dark:bg-violet-950/10 border border-violet-100 dark:border-violet-800/30">
                  <ShieldCheck className="w-4 h-4 text-violet-500 mt-0.5 shrink-0" />
                  <p className="text-xs text-violet-700 dark:text-violet-300">
                    <strong>Privacy:</strong> AI models run entirely on your device — your photos are never uploaded, shared, or sent anywhere. AI analysis applies to photos only (not videos). A one-time download (~300 MB) is required the first time you analyze. After that, everything works fully offline.
                  </p>
                </div>
              </div>

              {/* Re-analyze AI Tags — kept on the AI tab since this is
                  an AI processing operation. Faces / people / trees
                  are preserved (this only wipes tags). */}
              <div className="pt-4 border-t border-border">
                <div className="flex items-center justify-between p-3 rounded-lg border border-border">
                  <div className="flex flex-col pr-3">
                    <span className="text-sm font-medium text-foreground">Re-analyze AI Tags</span>
                    <span className="text-xs text-muted-foreground">Wipe every photo's AI tags and queue them for re-tagging against the current label set. Use after tag list changes. Faces, people, and relationships are preserved.</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      const ok = await promptConfirm({
                        title: 'Re-analyze AI tags?',
                        message: 'This wipes existing AI tags and queues every photo for re-tagging against the current label set. Faces, people, and relationships are preserved. The re-analysis runs in the background and may take a while for large libraries.',
                        confirmLabel: 'Re-analyze',
                        cancelLabel: 'Cancel',
                      });
                      if (!ok) return;
                      const r = await resetTagAnalysis();
                      if (r.success) {
                        await promptConfirm({
                          title: 'Re-tagging started',
                          message: `${r.data?.filesQueued ?? 0} photos have been queued for re-tagging. You can watch progress in the title bar at the top right — it shows "Analyzing X/Y" while the indexer works through the queue. Feel free to carry on using the app; re-tagging runs in the background.`,
                          confirmLabel: 'Got it',
                          hideCancel: true,
                        });
                      } else {
                        await promptConfirm({
                          title: 'Could not reset tags',
                          message: r.error ?? 'Unknown error',
                          confirmLabel: 'OK',
                          hideCancel: true,
                          danger: true,
                        });
                      }
                    }}
                  >
                    Re-analyze
                  </Button>
                </div>
              </div>
            </>
          )}

          {/* ═══════════════════════════════════════════════════════════════
              BACKUP TAB
              The dedicated home for Restore from backup. Lifted out
              of the old Pro/AI tab so it's discoverable in its own
              right — recovery shouldn't be hidden behind an AI label.
              ═══════════════════════════════════════════════════════════════ */}
          {settingsTab === 'backup' && (
            <>
              <div className="space-y-4">
                {/* Headline disclaimer — Apple/Adobe-style "what this
                    is and what it isn't" up front. Bumped to the
                    same visual weight as a primary callout (left
                    border accent + larger headline + bigger icon)
                    so the "this isn't a photo backup" point lands
                    before users start clicking around. */}
                <div className="rounded-lg border-l-4 border-l-blue-500 border border-blue-200 dark:border-blue-700/40 bg-blue-50/70 dark:bg-blue-950/25 p-4">
                  <div className="flex items-start gap-3">
                    <Info className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
                    <div className="text-sm leading-relaxed text-foreground space-y-2">
                      <p className="font-semibold">
                        This is a backup of PDR's database, not your photos.
                      </p>
                      <p className="text-foreground/85">
                        Snapshots cover your verified people, named clusters, AI tags, family trees, and fix-run history.
                      </p>
                      <p className="text-muted-foreground">
                        Your photo and video files always live on the drive (or library) you pointed PDR at — PDR never copies, moves, or deletes them. For the files themselves, use a Windows backup tool such as File History, OneDrive sync, an external drive, or a third-party tool like Backblaze.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Manual snapshot — premium "save now" button. The
                    user can name it for memorable rollback later. */}
                <div className="rounded-lg border border-border p-3 flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground mb-0.5">Take a snapshot now</div>
                    <div className="text-xs text-muted-foreground leading-relaxed">
                      Useful before a risky session (importing a big library, mass-renaming, etc.). Manual snapshots are kept until you delete them.
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-purple-300 text-purple-700 hover:bg-purple-50 dark:hover:bg-purple-950/30 shrink-0"
                    onClick={() => {
                      // Open the inline label modal — Electron blocks
                      // window.prompt() in the renderer (security model)
                      // so we use a PDR-styled input modal instead.
                      setManualSnapshotLabel('');
                      setManualSnapshotOpen(true);
                    }}
                  >
                    Save snapshot
                  </Button>
                </div>

                {/* Restore from snapshot — main panel. */}
                <div className="rounded-lg border border-border overflow-hidden">
                  <button
                    type="button"
                    onClick={async () => {
                      const next = !backupsExpanded;
                      setBackupsExpanded(next);
                      if (next && backups === null) await refreshBackups();
                    }}
                    className="w-full flex items-center justify-between p-3 hover:bg-secondary/40 transition-colors"
                  >
                    <div className="flex flex-col items-start text-left pr-3 min-w-0">
                      <span className="text-sm font-medium text-foreground">Restore from snapshot</span>
                      <span className="text-xs text-muted-foreground text-left">Roll PDR back to an earlier saved copy of its database. Click to see the snapshots available.</span>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">{backupsExpanded ? '▾' : '▸'}</span>
                  </button>
                  {backupsExpanded && (
                    <div className="border-t border-border p-3 space-y-2">
                      {/* Plain-English explainer — kept inside the expanded
                          panel so the collapsed header stays terse. */}
                      <div className="text-[11px] text-muted-foreground space-y-1 mb-2">
                        <p><strong className="text-foreground/80">What gets restored:</strong> the PDR database — your libraries, named people, AI tags, family trees, and fix-run history.</p>
                        <p><strong className="text-foreground/80">What's NOT touched:</strong> the actual photo files on your drives.</p>
                        <p><strong className="text-foreground/80">Snapshot kinds:</strong> automatic (taken on every launch — last 5 plus 7 daily plus 4 weekly), event (taken before risky operations like Improve Recognition or row removal — last 10), and manual (saved by you, kept until you delete them).</p>
                      </div>
                      {backupsLoading && <div className="text-xs text-muted-foreground italic">Loading…</div>}
                      {!backupsLoading && backups && backups.length === 0 && (
                        <div className="text-xs text-muted-foreground italic">No snapshots yet — they appear here automatically after the first app launch.</div>
                      )}
                      {!backupsLoading && backups && backups.map((b) => {
                        const ts = new Date(b.mtime);
                        const tsLabel = ts.toLocaleString();
                        const sizeMb = (b.sizeBytes / (1024 * 1024)).toFixed(1);
                        const kindLabel =
                          b.kind === 'manual' ? 'Manual snapshot'
                          : b.kind === 'auto-event' ? 'Event snapshot'
                          : 'Snapshot';
                        const kindBadgeColor =
                          b.kind === 'manual' ? 'bg-purple-500/15 text-purple-700 dark:text-purple-300 ring-purple-500/30'
                          : b.kind === 'auto-event' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30'
                          : 'bg-slate-500/15 text-slate-700 dark:text-slate-300 ring-slate-500/30';
                        return (
                          <div key={b.path} className="flex items-center justify-between gap-3 p-2 rounded-md bg-secondary/30">
                            <div className="flex flex-col min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-semibold ring-1 ${kindBadgeColor}`}>{kindLabel}</span>
                                {b.label && <span className="text-xs text-foreground truncate">{b.label}</span>}
                              </div>
                              <span className="text-[11px] text-muted-foreground truncate">
                                {tsLabel} · {sizeMb} MB
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <IconTooltip label="Save snapshot file to a folder of your choice" side="top">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="border-border text-foreground hover:bg-secondary hover:border-purple-300"
                                  onClick={async () => {
                                    const r = await exportSnapshotZipBridge(b.path);
                                    if (r.success) toast.success('Snapshot exported');
                                    else if (r.error !== 'Cancelled') toast.error('Export failed: ' + (r.error || 'unknown error'));
                                  }}
                                >
                                  Export
                                </Button>
                              </IconTooltip>
                              {b.kind === 'manual' && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="border-red-200 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20 hover:border-red-300"
                                  onClick={async () => {
                                    const ok = await promptConfirm({
                                      title: 'Delete this snapshot?',
                                      message: `Removes this manual snapshot from disk. Other snapshots are not affected. The actual photo files on your drives are never touched.`,
                                      confirmLabel: 'Delete',
                                      cancelLabel: 'Cancel',
                                      danger: true,
                                    });
                                    if (!ok) return;
                                    const r = await deleteSnapshotBridge(b.path);
                                    if (r.success) {
                                      await refreshBackups();
                                      toast.success('Snapshot deleted');
                                    } else toast.error('Delete failed: ' + (r.error || 'unknown error'));
                                  }}
                                >
                                  Delete
                                </Button>
                              )}
                              <Button
                                variant="outline"
                                size="sm"
                                className="border-amber-300 text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950/30"
                                onClick={async () => {
                                  const ok = await promptConfirm({
                                    title: 'Restore this snapshot?',
                                    message: `This replaces the entire live database with the contents of ${b.filename} (taken ${tsLabel}). Anything you've added or changed since then will be lost — face verifications, named people, AI tags, family tree edits, library changes, new fixed-run history. Original photo files on your drives are not affected. Please relaunch PDR after the restore so every window picks up the new state cleanly.`,
                                    confirmLabel: 'Restore',
                                    cancelLabel: 'Cancel',
                                    danger: true,
                                  });
                                  if (!ok) return;
                                  const r = await restoreFromBackup(b.path);
                                  if (r.success) {
                                    await promptConfirm({
                                      title: 'Restored',
                                      message: 'The database has been restored from the snapshot. Please relaunch PDR so every window picks up the new state cleanly.',
                                      confirmLabel: 'OK',
                                      hideCancel: true,
                                    });
                                  } else {
                                    await promptConfirm({
                                      title: 'Restore failed',
                                      message: r.error ?? 'Unknown error',
                                      confirmLabel: 'OK',
                                      hideCancel: true,
                                      danger: true,
                                    });
                                  }
                                }}
                              >
                                Restore
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Manual snapshot label modal — replaces window.prompt
                  (Electron's renderer blocks it). PDR-styled,
                  dismissable, supports Enter to save / Escape to
                  cancel. The label is purely cosmetic — the snapshot
                  always saves regardless of whether the user types
                  one. */}
              {manualSnapshotOpen && (
                <div
                  className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
                  onMouseDown={(e) => { if (e.target === e.currentTarget) setManualSnapshotOpen(false); }}
                >
                  <div className="w-[440px] max-w-[90vw] rounded-xl bg-background border border-border shadow-2xl flex flex-col overflow-hidden">
                    <div className="px-5 pt-5 pb-3">
                      <h3 className="text-base font-semibold text-foreground mb-1">Save snapshot</h3>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Give this snapshot a name so you can recognise it later (optional). Examples: <em className="text-foreground/80">Before Lightroom import</em>, <em className="text-foreground/80">Pre-holiday backup</em>.
                      </p>
                    </div>
                    <div className="px-5 pb-3">
                      <input
                        autoFocus
                        type="text"
                        value={manualSnapshotLabel}
                        onChange={(e) => setManualSnapshotLabel(e.target.value)}
                        onKeyDown={async (e) => {
                          if (e.key === 'Escape') { setManualSnapshotOpen(false); }
                          if (e.key === 'Enter' && !manualSnapshotSaving) {
                            setManualSnapshotSaving(true);
                            const r = await takeSnapshotBridge('manual', manualSnapshotLabel.trim() || undefined);
                            setManualSnapshotSaving(false);
                            setManualSnapshotOpen(false);
                            if (r.success) { await refreshBackups(); toast.success('Snapshot saved'); }
                            else toast.error('Snapshot failed: ' + (r.error || 'unknown error'));
                          }
                        }}
                        spellCheck={false}
                        autoCorrect="off"
                        className="w-full px-2.5 py-1.5 rounded-lg border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-purple-400/50"
                        placeholder="Optional name…"
                        maxLength={60}
                      />
                    </div>
                    <div className="flex items-center justify-end gap-2 px-5 py-3 bg-muted/30 border-t border-border">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setManualSnapshotOpen(false)}
                        disabled={manualSnapshotSaving}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        className="bg-purple-500 hover:bg-purple-600 text-white"
                        disabled={manualSnapshotSaving}
                        onClick={async () => {
                          setManualSnapshotSaving(true);
                          const r = await takeSnapshotBridge('manual', manualSnapshotLabel.trim() || undefined);
                          setManualSnapshotSaving(false);
                          setManualSnapshotOpen(false);
                          if (r.success) { await refreshBackups(); toast.success('Snapshot saved'); }
                          else toast.error('Snapshot failed: ' + (r.error || 'unknown error'));
                        }}
                      >
                        {manualSnapshotSaving ? 'Saving…' : 'Save snapshot'}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Re-cluster confirmation modal — destructive operation
              gated behind explicit confirmation. Default snapshot-
              first ON so a one-click rollback is always available
              via Settings → Backup if the new clustering is worse. */}
          {reclusterModalOpen && (
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
              onMouseDown={(e) => {
                if (e.target !== e.currentTarget) return;
                // Block backdrop dismissal while running so the user
                // can't accidentally lose sight of the in-flight job.
                if (reclusterRunning) return;
                setReclusterModalOpen(false);
                setReclusterResult(null);
              }}
            >
              <div className="w-[480px] max-w-[90vw] rounded-xl bg-background border border-border shadow-2xl flex flex-col overflow-hidden">
                {/* Header swaps based on phase: confirm → working → done. */}
                <div className="flex items-start gap-3 px-5 pt-5 pb-3">
                  {reclusterResult?.success ? (
                    <div className="w-8 h-8 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0 mt-0.5">
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    </div>
                  ) : reclusterResult && !reclusterResult.success ? (
                    <div className="w-8 h-8 rounded-full bg-rose-500/15 flex items-center justify-center shrink-0 mt-0.5">
                      <AlertTriangle className="w-4 h-4 text-rose-500" />
                    </div>
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-amber-500/15 flex items-center justify-center shrink-0 mt-0.5">
                      <AlertTriangle className="w-4 h-4 text-amber-500" />
                    </div>
                  )}
                  <h3 className="text-base font-semibold text-foreground leading-snug">
                    {reclusterResult?.success ? 'Re-cluster complete' : reclusterResult ? 'Re-cluster failed' : 'Re-cluster unnamed groups?'}
                  </h3>
                </div>

                {/* IDLE: explanation + slider + snapshot toggle. */}
                {!reclusterRunning && !reclusterResult && (
                  <>
                    <div className="px-5 pb-3 text-sm text-muted-foreground leading-relaxed space-y-2.5">
                      <p>
                        PDR will re-evaluate how unverified faces group together at the chosen Match strictness. <strong className="text-foreground">Verified faces are never affected.</strong> Auto-matched faces may shift between groups or unlink — Improve Recognition can re-find any that get unlinked. The actual photo files on your drives are never touched.
                      </p>
                      <p className="text-xs text-muted-foreground/85">
                        Most users never need to do this. PM's slider already auto-runs Improve on release, which handles the typical "find more matches" need without re-clustering.
                      </p>
                    </div>
                    <div className="px-5 pb-3 space-y-2">
                      <label className="text-[11px] uppercase tracking-wider text-muted-foreground/85 block">Match strictness for the re-cluster</label>
                      <div className="flex items-center gap-2 w-full">
                        <span className="text-[11px] text-muted-foreground whitespace-nowrap">Loose</span>
                        <input
                          type="range"
                          min="0.65"
                          max="0.95"
                          step="0.01"
                          value={reclusterThreshold}
                          onChange={(e) => setReclusterThreshold(parseFloat(e.target.value))}
                          className="flex-1 h-1 accent-purple-500 cursor-pointer"
                        />
                        <span className="text-[11px] text-muted-foreground whitespace-nowrap">Strict</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground/85 text-center leading-tight">
                        Loose makes larger groups. Strict makes tighter, more conservative groups.
                      </p>
                    </div>
                    <div className="px-5 pb-3">
                      <label className="flex items-center gap-2.5 p-2.5 rounded-lg border border-border hover:bg-secondary/30 cursor-pointer">
                        <Checkbox
                          checked={reclusterSnapshotFirst}
                          onCheckedChange={(checked) => setReclusterSnapshotFirst(!!checked)}
                        />
                        <div className="flex-1">
                          <div className="text-sm text-foreground">Take a snapshot first</div>
                          <div className="text-[11px] text-muted-foreground">One-click rollback via Settings → Backup if the new clustering is worse than the current one.</div>
                        </div>
                      </label>
                    </div>
                  </>
                )}

                {/* RUNNING: indeterminate stripe + elapsed timer. Modal
                    stays open through the whole job so the user
                    always sees that we're still working. */}
                {reclusterRunning && (
                  <div className="px-5 pb-4 pt-1 space-y-3">
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      Re-evaluating how unverified faces group together. Please don't close PDR while this is running. <strong className="text-foreground">Verified faces remain safe.</strong>
                    </p>
                    <div className="h-1.5 rounded-full bg-amber-100 dark:bg-amber-950/40 overflow-hidden relative">
                      <div className="absolute inset-y-0 w-1/3 bg-amber-500/80 rounded-full animate-recluster-stripe" />
                    </div>
                    <div className="flex items-center justify-between text-[12px] text-muted-foreground tabular-nums">
                      <span>Working…</span>
                      <span className="font-medium text-foreground">{Math.floor(reclusterElapsed / 60)}:{String(reclusterElapsed % 60).padStart(2, '0')} elapsed</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground/85 leading-tight">
                      Typically 30–90 seconds depending on library size. People Manager will refresh automatically when finished.
                    </p>
                  </div>
                )}

                {/* DONE: success or failure summary + dismiss. */}
                {!reclusterRunning && reclusterResult && (
                  <div className="px-5 pb-4 pt-1 space-y-2">
                    {reclusterResult.success ? (
                      <>
                        <p className="text-sm text-foreground leading-relaxed">
                          Unverified faces have been re-evaluated at the chosen strictness.
                        </p>
                        <ul className="text-[12px] text-muted-foreground space-y-1 pl-1">
                          <li>· People Manager refreshed automatically</li>
                          {reclusterResult.snapshotTook && <li>· Snapshot saved — restore via <span className="text-foreground">Settings → Backup</span> if needed</li>}
                          <li>· Took {Math.floor(reclusterResult.durationSec / 60)}:{String(reclusterResult.durationSec % 60).padStart(2, '0')}</li>
                        </ul>
                      </>
                    ) : (
                      <>
                        <p className="text-sm text-foreground leading-relaxed">
                          The re-cluster job didn't finish. Nothing in your library has been changed beyond the snapshot (if you took one).
                        </p>
                        <p className="text-[12px] text-rose-600 dark:text-rose-400 break-words">
                          {reclusterResult.error || 'Unknown error'}
                        </p>
                      </>
                    )}
                  </div>
                )}

                {/* Footer button row — adapts to phase. */}
                <div className="flex items-center justify-end gap-2 px-5 py-3 bg-muted/30 border-t border-border">
                  {!reclusterRunning && !reclusterResult && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => { setReclusterModalOpen(false); setReclusterResult(null); }}>Cancel</Button>
                      <Button
                        size="sm"
                        className="bg-amber-500 hover:bg-amber-600 text-white"
                        onClick={async () => {
                          setReclusterRunning(true);
                          setReclusterResult(null);
                          const t0 = Date.now();
                          let snapshotTook = false;
                          let r: { success: boolean; error?: string } = { success: false };
                          try {
                            if (reclusterSnapshotFirst) {
                              try {
                                const snapRes = await takeSnapshotBridge('auto-event', `Before re-cluster · ${Math.round(((reclusterThreshold - 0.65) / 0.30) * 100)}%`);
                                if (snapRes?.success) snapshotTook = true;
                              } catch { /* snapshot is opportunistic — keep going */ }
                            }
                            r = await reclusterFacesBridge(reclusterThreshold);
                          } catch (e) {
                            r = { success: false, error: (e as Error)?.message || 'Unexpected error' };
                          }
                          const durationSec = Math.max(1, Math.floor((Date.now() - t0) / 1000));
                          if (r.success) {
                            toast.success(`Re-cluster complete · ${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, '0')}`);
                          } else {
                            toast.error('Re-cluster failed: ' + (r.error || 'unknown error'));
                          }
                          // Flip to the Done panel immediately so the
                          // user sees the outcome the moment the IPC
                          // resolves — no extra wait staring at a
                          // spinner.
                          setReclusterResult({ success: !!r.success, error: r.error, durationSec, snapshotTook });
                          setReclusterRunning(false);
                          // THEN, with the Done panel already on
                          // screen, defer the PM reload by 5 seconds.
                          // This gives the database engine plus any
                          // tail-end FTS rebuild work room to settle
                          // before PM re-queries — the user reported
                          // earlier reloads landing too early and
                          // missing the new row counts. Single fire,
                          // no double-tap, no immediate refresh.
                          if (r.success) {
                            setTimeout(() => {
                              try { (window as any)?.pdr?.people?.notifyChange?.(); } catch { /* non-fatal */ }
                            }, 5000);
                          }
                        }}
                      >
                        Re-cluster
                      </Button>
                    </>
                  )}
                  {reclusterRunning && (
                    <Button size="sm" disabled className="bg-amber-500 text-white opacity-90 cursor-not-allowed">
                      Re-clustering… {Math.floor(reclusterElapsed / 60)}:{String(reclusterElapsed % 60).padStart(2, '0')}
                    </Button>
                  )}
                  {!reclusterRunning && reclusterResult && (
                    <Button
                      size="sm"
                      className={reclusterResult.success ? 'bg-emerald-500 hover:bg-emerald-600 text-white' : ''}
                      variant={reclusterResult.success ? 'default' : 'outline'}
                      onClick={() => { setReclusterModalOpen(false); setReclusterResult(null); }}
                    >
                      Done
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 pt-4 border-t border-border space-y-3">
          <Button
            onClick={onClose}
            className="w-full"
            data-testid="button-save-settings"
          >
            Done
          </Button>
          <button
            onClick={handleResetToDefaults}
            className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors py-2"
            data-testid="button-reset-defaults"
          >
            Reset to Optimised Defaults
          </button>
          <p className="text-center text-xs text-muted-foreground mt-4">
            Photo Date Rescue v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.1'}
          </p>
        </div>
      </motion.div>
    </motion.div>
  );
}
