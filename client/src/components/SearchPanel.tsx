import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  X,
  ChevronDown,
  ChevronUp,
  Camera,
  Calendar,
  FileImage,
  FileVideo,
  MapPin,
  Star,
  SlidersHorizontal,
  RotateCcw,
  Loader2,
  ImageIcon,
  Film,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  ArrowUpDown,
  Database,
  Trash2,
  Plus,
  FolderOpen,
  Eye,
  ExternalLink,
  ArrowLeft,
  ArrowRight,
  PanelRightOpen,
  PanelRightClose,
  Maximize2,
  Bookmark,
  Sun,
  Moon,
  LayoutGrid,
  List,
  Table2,
  Info,
  Sparkles,
  Users,
  Tag,
  Brain,
  Scan,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  initSearchDatabase,
  searchFiles,
  getSearchFilterOptions,
  getSearchStats,
  getThumbnail,
  formatBytes,
  isElectron,
  openSearchViewer,
  checkPathsExist,
  listSearchRuns,
  removeSearchRun,
  rebuildSearchIndex,
  indexFixRun as indexFixRunBridge,
  listReports,
  deleteReport,
  listFavouriteFilters,
  saveFavouriteFilter,
  deleteFavouriteFilter,
  onSearchIndexProgress,
  removeSearchIndexProgressListener,
  // AI
  startAiProcessing,
  cancelAi,
  getAiStats,
  getAiFileTags,
  getAiFaces,
  getAiTagOptions as getAiTagOptionsBridge,
  onAiProgress,
  removeAiProgressListener,
  getSettings,
  setSetting,
  type SearchQuery,
  type SearchResult,
  type IndexedFile,
  type FilterOptions,
  type IndexStats,
  type IndexedRun,
  type ReportSummary,
  type FavouriteFilter,
  type AiProgress,
  type AiStats,
  type AiTagRecord,
  type FaceRecord,
} from '@/lib/electron-bridge';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';

// ─── Types ───────────────────────────────────────────────────────────────────

type ViewMode = 'grid' | 'list' | 'details';

interface SearchRibbonProps {
  isIndexing?: boolean;
  indexingProgress?: { current: number; total: number } | null;
  searchDbReady?: boolean;
  zoomLevel?: number;
  isDarkMode?: boolean;
  onToggleDarkMode?: () => void;
  licenseStatusBadge?: React.ReactNode;
  onSearchActiveChange?: (active: boolean) => void;
}

// ─── Main Search Ribbon Component ────────────────────────────────────────────
// This renders as a collapsible ribbon above workspace content.
// When the user searches or applies filters, results appear below the ribbon
// and the workspace content is hidden. Collapsing the ribbon hides results.

export function SearchRibbon({ isIndexing, indexingProgress, searchDbReady: externalDbReady, zoomLevel = 100, isDarkMode, onToggleDarkMode, licenseStatusBadge, onSearchActiveChange }: SearchRibbonProps) {
  // Ribbon state
  const [ribbonExpanded, setRibbonExpanded] = useState(true);
  const [searchActive, setSearchActive] = useState(false); // true when results should show
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [overflowModalGroup, setOverflowModalGroup] = useState<string | null>(null); // which group's overflow modal is open
  const ribbonRef = useRef<HTMLDivElement>(null);

  // Search state
  const [searchText, setSearchText] = useState('');
  const [query, setQuery] = useState<SearchQuery>({ sortBy: 'derived_date', sortDir: 'desc', limit: 60 });
  const [results, setResults] = useState<SearchResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const [stats, setStats] = useState<IndexStats | null>(null);
  const [dbReady, setDbReady] = useState(externalDbReady ?? false);

  // Notify parent when search results are showing/hiding
  useEffect(() => { onSearchActiveChange?.(searchActive); }, [searchActive, onSearchActiveChange]);

  // Filter state
  const [selectedConfidence, setSelectedConfidence] = useState<string[]>([]);
  const [selectedFileType, setSelectedFileType] = useState<string[]>([]);
  const [selectedDateSource, setSelectedDateSource] = useState<string[]>([]);
  const [selectedExtension, setSelectedExtension] = useState<string[]>([]);
  const [selectedCameraMake, setSelectedCameraMake] = useState<string[]>([]);
  const [selectedCameraModel, setSelectedCameraModel] = useState<string[]>([]);
  const [selectedLensModel, setSelectedLensModel] = useState<string[]>([]);
  const [yearFrom, setYearFrom] = useState<number | undefined>(undefined);
  const [yearTo, setYearTo] = useState<number | undefined>(undefined);
  const [monthFrom, setMonthFrom] = useState<number | undefined>(undefined);
  const [monthTo, setMonthTo] = useState<number | undefined>(undefined);
  const [hasGps, setHasGps] = useState<boolean | undefined>(undefined);
  const [selectedCountry, setSelectedCountry] = useState<string[]>([]);
  const [selectedCity, setSelectedCity] = useState<string[]>([]);
  const [isoFrom, setIsoFrom] = useState<number | undefined>(undefined);
  const [isoTo, setIsoTo] = useState<number | undefined>(undefined);
  const [apertureFrom, setApertureFrom] = useState<number | undefined>(undefined);
  const [apertureTo, setApertureTo] = useState<number | undefined>(undefined);
  const [focalLengthFrom, setFocalLengthFrom] = useState<number | undefined>(undefined);
  const [focalLengthTo, setFocalLengthTo] = useState<number | undefined>(undefined);
  const [flashFired, setFlashFired] = useState<boolean | undefined>(undefined);
  const [megapixelsFrom, setMegapixelsFrom] = useState<number | undefined>(undefined);
  const [megapixelsTo, setMegapixelsTo] = useState<number | undefined>(undefined);
  const [sortBy, setSortBy] = useState<SearchQuery['sortBy']>('derived_date');
  const [sortDir, setSortDir] = useState<SearchQuery['sortDir']>('desc');

  // Ribbon customisation — which filter groups appear in the ribbon
  // New scene/shooting filter state
  const [selectedScene, setSelectedScene] = useState<string[]>([]);
  const [selectedExposureProgram, setSelectedExposureProgram] = useState<string[]>([]);
  const [selectedWhiteBalance, setSelectedWhiteBalance] = useState<string[]>([]);
  const [selectedCameraPosition, setSelectedCameraPosition] = useState<string[]>([]);
  const [selectedOrientation, setSelectedOrientation] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [sizeFromMB, setSizeFromMB] = useState<number | undefined>(undefined);
  const [sizeToMB, setSizeToMB] = useState<number | undefined>(undefined);
  const [selectedDestination, setSelectedDestination] = useState<string[]>([]);
  const [destinationAvailability, setDestinationAvailability] = useState<Record<string, boolean>>({});
  const [unavailableFileMessage, setUnavailableFileMessage] = useState<string | null>(null);

  const allFilterGroups = [
    { id: 'confidence', label: 'Confidence' },
    { id: 'type', label: 'File Type' },
    { id: 'dateRange', label: 'Date Range' },
    { id: 'camera', label: 'Camera' },
    { id: 'cameraPosition', label: 'Camera Type' },
    { id: 'lens', label: 'Lens' },
    { id: 'scene', label: 'Scene Mode' },
    { id: 'exposureProgram', label: 'Exposure Program' },
    { id: 'whiteBalance', label: 'White Balance' },
    { id: 'orientation', label: 'Orientation' },
    { id: 'source', label: 'Date Source' },
    { id: 'gps', label: 'Location' },
    { id: 'iso', label: 'ISO' },
    { id: 'aperture', label: 'Aperture' },
    { id: 'focalLength', label: 'Focal Length' },
    { id: 'flash', label: 'Flash' },
    { id: 'megapixels', label: 'Megapixels' },
    { id: 'fileSize', label: 'File Size' },
    { id: 'destination', label: 'Destination' },
  ] as const;

  // ─── Ribbon tabs & categories ────────────────────────────────────────────
  type RibbonTab = 'favourites' | 'filters' | 'camera' | 'exposure' | 'ai';
  const [activeTab, setActiveTab] = useState<RibbonTab>('filters');

  // Which groups belong to which tab
  const tabGroups: Record<Exclude<RibbonTab, 'favourites'>, string[]> = {
    filters: ['confidence', 'type', 'dateRange', 'source', 'gps', 'fileSize', 'destination'],
    camera: ['camera', 'lens', 'cameraPosition', 'scene', 'orientation'],
    exposure: ['iso', 'aperture', 'focalLength', 'flash', 'exposureProgram', 'whiteBalance', 'megapixels'],
    ai: ['aiTags'],
  };

  // Favourite groups — up to 10, persisted to localStorage
  const MAX_FAVOURITE_GROUPS = 10;
  const [favouriteGroups, setFavouriteGroups] = useState<string[]>(() => {
    try { const saved = localStorage.getItem('pdr-ribbon-fav-groups'); if (saved) return JSON.parse(saved); } catch {}
    return [];
  });
  const toggleFavouriteGroup = (groupId: string) => {
    setFavouriteGroups(prev => {
      let next: string[];
      if (prev.includes(groupId)) {
        next = prev.filter(g => g !== groupId);
      } else {
        if (prev.length >= MAX_FAVOURITE_GROUPS) return prev; // at limit
        next = [...prev, groupId];
      }
      localStorage.setItem('pdr-ribbon-fav-groups', JSON.stringify(next));
      return next;
    });
  };
  const isGroupFavourited = (groupId: string) => favouriteGroups.includes(groupId);

  // Helper: get groups visible in the current tab
  const getVisibleGroupsForTab = (tab: RibbonTab): string[] => {
    if (tab === 'favourites') return favouriteGroups;
    return tabGroups[tab] || [];
  };

  // Legacy — keep visibleGroups derived from current tab for rendering
  const visibleGroups = getVisibleGroupsForTab(activeTab);

  const [showCustomise, setShowCustomise] = useState(false);
  const toggleGroupVisibility = (groupId: string) => {
    // In the new tab model, this toggles favourite status
    toggleFavouriteGroup(groupId);
  };

  // Preview / results
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [selectedFile, setSelectedFile] = useState<IndexedFile | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<number>>(new Set());
  const lastClickedIndexRef = useRef<number | null>(null);
  const [showPreviewPanel, setShowPreviewPanel] = useState(true);
  const [showIndexManager, setShowIndexManager] = useState(false);

  // Favourites
  const [favourites, setFavourites] = useState<FavouriteFilter[]>([]);
  const [showSaveFavourite, setShowSaveFavourite] = useState(false);
  const [favouriteName, setFavouriteName] = useState('');

  // AI state
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiProcessing, setAiProcessing] = useState(false);
  const [aiProgress, setAiProgress] = useState<AiProgress | null>(null);
  const [aiStats, setAiStatsState] = useState<AiStats | null>(null);
  const [aiTagOptions, setAiTagOptions] = useState<{ tag: string; count: number }[]>([]);
  const [aiPromptDismissed, setAiPromptDismissed] = useState(() => localStorage.getItem('pdr-ai-prompt-dismissed') === 'true');
  const [selectedAiTags, setSelectedAiTags] = useState<string[]>([]);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);

  // ─── Navigation helpers ──────────────────────────────────────────────────

  const keyboardNavRef = useRef(false);

  // When files are checked, navigation cycles through checked files only
  const getNavigableFiles = useCallback((): IndexedFile[] => {
    if (!results) return [];
    if (selectedFiles.size > 0) {
      return results.files.filter(f => selectedFiles.has(f.id));
    }
    return results.files;
  }, [results, selectedFiles]);

  const navigateFile = useCallback((direction: 'prev' | 'next') => {
    if (!results || !selectedFile) return;
    const navFiles = getNavigableFiles();
    const idx = navFiles.findIndex(f => f.id === selectedFile.id);
    if (idx === -1) {
      // Current file not in navigable set — jump to first
      if (navFiles.length > 0) { keyboardNavRef.current = true; setSelectedFile(navFiles[0]); }
      return;
    }
    const newIdx = direction === 'prev' ? idx - 1 : idx + 1;
    if (newIdx >= 0 && newIdx < navFiles.length) {
      keyboardNavRef.current = true;
      setSelectedFile(navFiles[newIdx]);
    }
  }, [results, selectedFile, getNavigableFiles]);

  const openInExplorer = useCallback(async (filePath: string) => {
    if (isElectron()) {
      const dirPath = filePath.replace(/[/\\][^/\\]+$/, '');
      const { openDestinationFolder } = await import('@/lib/electron-bridge');
      await openDestinationFolder(dirPath);
    }
  }, []);

  // ─── Auto-scroll selected file into view (keyboard nav only) ────────────

  useEffect(() => {
    if (selectedFile && gridContainerRef.current && keyboardNavRef.current) {
      keyboardNavRef.current = false;
      const card = gridContainerRef.current.querySelector(`[data-file-id="${selectedFile.id}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedFile]);

  // ─── Keyboard navigation ─────────────────────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setTimeout(() => searchInputRef.current?.focus(), 50);
        return;
      }
      if (document.activeElement === searchInputRef.current) {
        if (e.key === 'Escape') { searchInputRef.current?.blur(); }
        return;
      }
      if (!searchActive) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); navigateFile('prev'); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); navigateFile('next'); }
      else if (e.key === 'Escape') { setSelectedFile(null); }
      else if (e.key === 'Enter' && selectedFile?.file_type === 'photo') { safeOpenViewer(selectedFile.file_path, selectedFile.filename); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigateFile, selectedFile, searchActive]);

  // ─── DB init ──────────────────────────────────────────────────────────────

  useEffect(() => { if (externalDbReady && !dbReady) setDbReady(true); }, [externalDbReady]);

  useEffect(() => {
    const init = async () => {
      if (!dbReady) {
        const result = await initSearchDatabase();
        if (result.success) setDbReady(true); else return;
      }
      await loadFilterOptions();
      await loadStats();
      await loadFavourites();
    };
    init();
  }, [dbReady]);

  useEffect(() => {
    if (!isIndexing && dbReady) {
      loadFilterOptions(); loadStats(); loadAiData(); if (results) executeSearch();
      // After indexing completes, re-show AI discovery banner if AI is still off
      getSettings().then(s => {
        if (!s.aiEnabled) {
          setAiPromptDismissed(false);
          localStorage.removeItem('pdr-ai-prompt-dismissed');
        }
      });
    }
  }, [isIndexing]);

  // AI init — check settings, load stats, listen for progress
  useEffect(() => {
    getSettings().then(s => setAiEnabled(s.aiEnabled));
    loadAiData();
    onAiProgress((progress) => {
      setAiProgress(progress);
      setAiProcessing(progress.phase !== 'complete' && progress.phase !== 'error');
      if (progress.phase === 'complete') {
        loadAiData();
        loadFilterOptions();
        if (results) executeSearch();
      }
    });
    return () => removeAiProgressListener();
  }, []);

  // Re-check AI enabled setting periodically (picks up changes from Settings modal without restart)
  useEffect(() => {
    const interval = setInterval(() => {
      getSettings().then(s => { if (s.aiEnabled !== aiEnabled) setAiEnabled(s.aiEnabled); });
    }, 2000);
    return () => clearInterval(interval);
  }, [aiEnabled]);

  const loadAiData = async () => {
    const statsRes = await getAiStats();
    if (statsRes.success && statsRes.data) setAiStatsState(statsRes.data);
    const tagsRes = await getAiTagOptionsBridge();
    if (tagsRes.success && tagsRes.data) setAiTagOptions(tagsRes.data);
  };

  const loadFilterOptions = async () => {
    const r = await getSearchFilterOptions();
    if (r.success && r.data) {
      setFilterOptions(r.data);
      // Check destination drive availability
      if (r.data.destinations && r.data.destinations.length > 0) {
        const availability = await checkPathsExist(r.data.destinations);
        setDestinationAvailability(availability);
      }
    }
  };
  const loadStats = async () => { const r = await getSearchStats(); if (r.success && r.data) setStats(r.data); };
  const loadFavourites = async () => { const r = await listFavouriteFilters(); if (r.success && r.data) setFavourites(r.data); };

  // ─── Query / Search ───────────────────────────────────────────────────────

  const buildQuery = useCallback((): SearchQuery => ({
    text: searchText.trim() || undefined,
    confidence: selectedConfidence.length > 0 ? selectedConfidence : undefined,
    fileType: selectedFileType.length > 0 ? selectedFileType : undefined,
    dateSource: selectedDateSource.length > 0 ? selectedDateSource : undefined,
    extension: selectedExtension.length > 0 ? selectedExtension : undefined,
    cameraMake: selectedCameraMake.length > 0 ? selectedCameraMake : undefined,
    cameraModel: selectedCameraModel.length > 0 ? selectedCameraModel : undefined,
    lensModel: selectedLensModel.length > 0 ? selectedLensModel : undefined,
    dateFrom: dateFrom || undefined, dateTo: dateTo || undefined,
    yearFrom, yearTo, monthFrom, monthTo, hasGps,
    country: selectedCountry.length > 0 ? selectedCountry : undefined,
    city: selectedCity.length > 0 ? selectedCity : undefined,
    isoFrom, isoTo, apertureFrom, apertureTo, focalLengthFrom, focalLengthTo,
    flashFired, megapixelsFrom, megapixelsTo,
    sizeFrom: sizeFromMB != null ? Math.round(sizeFromMB * 1024 * 1024) : undefined,
    sizeTo: sizeToMB != null ? Math.round(sizeToMB * 1024 * 1024) : undefined,
    sceneCaptureType: selectedScene.length > 0 ? selectedScene : undefined,
    exposureProgram: selectedExposureProgram.length > 0 ? selectedExposureProgram : undefined,
    whiteBalance: selectedWhiteBalance.length > 0 ? selectedWhiteBalance : undefined,
    cameraPosition: selectedCameraPosition.length > 0 ? selectedCameraPosition : undefined,
    orientation: selectedOrientation.length > 0 ? selectedOrientation : undefined,
    destinationPath: selectedDestination.length > 0 ? selectedDestination : undefined,
    aiTag: selectedAiTags.length > 0 ? selectedAiTags : undefined,
    sortBy, sortDir, limit: 60, offset: 0,
  }), [searchText, selectedConfidence, selectedFileType, selectedDateSource, selectedExtension, selectedCameraMake, selectedCameraModel, selectedLensModel, dateFrom, dateTo, yearFrom, yearTo, monthFrom, monthTo, hasGps, selectedCountry, selectedCity, isoFrom, isoTo, apertureFrom, apertureTo, focalLengthFrom, focalLengthTo, flashFired, megapixelsFrom, megapixelsTo, selectedScene, selectedExposureProgram, selectedWhiteBalance, selectedCameraPosition, selectedOrientation, selectedDestination, selectedAiTags, sortBy, sortDir]);

  const executeSearch = useCallback(async (customQuery?: SearchQuery) => {
    setIsLoading(true);
    const q = customQuery || buildQuery();
    setQuery(q);
    const res = await searchFiles(q);
    if (res.success && res.data) { setResults(res.data); setSelectedFile(null); loadThumbnailsBatch(res.data.files); }
    setIsLoading(false);
    setSearchActive(true);
  }, [buildQuery]);

  const loadMore = async () => {
    if (!results || results.files.length >= results.total) return;
    setIsLoading(true);
    const q = { ...query, offset: results.files.length };
    const res = await searchFiles(q);
    if (res.success && res.data) { setResults({ ...res.data, files: [...results.files, ...res.data.files] }); loadThumbnailsBatch(res.data.files); }
    setIsLoading(false);
  };

  // Wrapper for opening viewer — checks drive availability first
  const safeOpenViewer = async (filePath: string | string[], filename: string | string[]) => {
    const paths = Array.isArray(filePath) ? filePath : [filePath];
    // Check if any file's destination is unavailable
    for (const [destPath, available] of Object.entries(destinationAvailability)) {
      if (!available && paths.some(p => p.startsWith(destPath))) {
        setUnavailableFileMessage(
          `This file's destination drive is not available. Please reconnect the drive or folder and try again.`
        );
        return;
      }
    }
    await openSearchViewer(filePath, filename);
  };

  // Debounced text search
  useEffect(() => {
    if (!dbReady) return;
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => { if (searchText.trim() || hasActiveFilters) executeSearch(); }, 300);
    return () => { if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current); };
  }, [searchText, dbReady]);

  // Re-search on filter change
  useEffect(() => {
    if (!dbReady) return;
    if (searchText.trim() || hasActiveFilters) executeSearch();
    else { setResults(null); setSearchActive(false); }
  }, [selectedConfidence, selectedFileType, selectedDateSource, selectedExtension, selectedCameraMake, selectedCameraModel, selectedLensModel, dateFrom, dateTo, yearFrom, yearTo, monthFrom, monthTo, hasGps, selectedCountry, selectedCity, isoFrom, isoTo, apertureFrom, apertureTo, focalLengthFrom, focalLengthTo, flashFired, megapixelsFrom, megapixelsTo, sizeFromMB, sizeToMB, selectedScene, selectedExposureProgram, selectedWhiteBalance, selectedCameraPosition, selectedOrientation, selectedDestination, selectedAiTags, sortBy, sortDir]);

  const loadThumbnailsBatch = async (files: IndexedFile[]) => {
    const photos = files.filter(f => f.file_type === 'photo' && !thumbnails[f.file_path]);
    // Load thumbnails in parallel batches of 8 for much faster loading
    const batchSize = 8;
    for (let i = 0; i < photos.length; i += batchSize) {
      const batch = photos.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (file) => {
          const r = await getThumbnail(file.file_path, 180);
          return { filePath: file.file_path, r };
        })
      );
      const newThumbs: Record<string, string> = {};
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.r.success && result.value.r.dataUrl) {
          newThumbs[result.value.filePath] = result.value.r.dataUrl;
        }
      }
      if (Object.keys(newThumbs).length > 0) {
        setThumbnails(prev => ({ ...prev, ...newThumbs }));
      }
    }
  };

  const clearFilters = () => {
    setSearchText(''); setSelectedConfidence([]); setSelectedFileType([]); setSelectedDateSource([]);
    setSelectedExtension([]); setSelectedCameraMake([]); setSelectedCameraModel([]); setSelectedLensModel([]);
    setDateFrom(''); setDateTo('');
    setYearFrom(undefined); setYearTo(undefined); setMonthFrom(undefined); setMonthTo(undefined);
    setHasGps(undefined); setSelectedCountry([]); setSelectedCity([]); setIsoFrom(undefined); setIsoTo(undefined);
    setApertureFrom(undefined); setApertureTo(undefined);
    setFocalLengthFrom(undefined); setFocalLengthTo(undefined);
    setFlashFired(undefined); setMegapixelsFrom(undefined); setMegapixelsTo(undefined);
    setSelectedScene([]); setSelectedExposureProgram([]); setSelectedWhiteBalance([]);
    setSelectedCameraPosition([]); setSelectedOrientation([]);
    setSizeFromMB(undefined); setSizeToMB(undefined);
    setSelectedAiTags([]); setSelectedDestination([]);
    setSortBy('derived_date'); setSortDir('desc');
    setResults(null); setSearchActive(false); setSelectedFile(null);
  };

  const hasActiveFilters = selectedConfidence.length > 0 || selectedFileType.length > 0 || selectedDateSource.length > 0 || selectedExtension.length > 0 || selectedCameraMake.length > 0 || selectedCameraModel.length > 0 || selectedLensModel.length > 0 || !!dateFrom || !!dateTo || yearFrom != null || yearTo != null || monthFrom != null || monthTo != null || hasGps != null || selectedCountry.length > 0 || selectedCity.length > 0 || isoFrom != null || isoTo != null || apertureFrom != null || apertureTo != null || focalLengthFrom != null || focalLengthTo != null || flashFired != null || megapixelsFrom != null || megapixelsTo != null || selectedScene.length > 0 || selectedExposureProgram.length > 0 || selectedWhiteBalance.length > 0 || selectedCameraPosition.length > 0 || selectedOrientation.length > 0 || sizeFromMB != null || sizeToMB != null || selectedDestination.length > 0 || selectedAiTags.length > 0;
  const activeFilterCount = [selectedConfidence.length > 0, selectedFileType.length > 0, selectedDateSource.length > 0, selectedExtension.length > 0, selectedCameraMake.length > 0 || selectedCameraModel.length > 0, selectedLensModel.length > 0, !!dateFrom || !!dateTo, yearFrom != null || yearTo != null, monthFrom != null || monthTo != null, hasGps != null, isoFrom != null || isoTo != null, apertureFrom != null || apertureTo != null, focalLengthFrom != null || focalLengthTo != null, flashFired != null, megapixelsFrom != null || megapixelsTo != null, sizeFromMB != null || sizeToMB != null, selectedScene.length > 0, selectedExposureProgram.length > 0, selectedWhiteBalance.length > 0, selectedCameraPosition.length > 0, selectedOrientation.length > 0, selectedDestination.length > 0].filter(Boolean).length;

  const toggleFilter = (current: string[], setter: React.Dispatch<React.SetStateAction<string[]>>, value: string) => {
    setter(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]);
  };

  // ─── Favourites ───────────────────────────────────────────────────────────

  const handleSaveFavourite = async () => {
    if (!favouriteName.trim()) return;
    const q = buildQuery();
    await saveFavouriteFilter(favouriteName.trim(), q);
    setFavouriteName(''); setShowSaveFavourite(false);
    await loadFavourites();
  };

  const applyFavourite = (fav: FavouriteFilter) => {
    try {
      const q: SearchQuery = JSON.parse(fav.query_json);
      setSearchText(q.text || '');
      setSelectedConfidence(q.confidence || []);
      setSelectedFileType(q.fileType || []);
      setSelectedDateSource(q.dateSource || []);
      setSelectedExtension(q.extension || []);
      setSelectedCameraMake(q.cameraMake || []);
      setSelectedCameraModel(q.cameraModel || []);
      setYearFrom(q.yearFrom); setYearTo(q.yearTo);
      setHasGps(q.hasGps);
      setSelectedDestination(q.destinationPath || []);
      setSortBy(q.sortBy || 'derived_date'); setSortDir(q.sortDir || 'desc');
      setRibbonExpanded(true);
    } catch {}
  };

  const handleDeleteFavourite = async (id: number) => {
    await deleteFavouriteFilter(id);
    await loadFavourites();
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* ═══ RIBBON — Word-style, collapsible, high contrast ═══ */}
      {/* Tab bar — OUTSIDE scaling so it stays fixed height */}
      <div className="shrink-0 select-none">
        <div className="flex items-center justify-between ribbon-tab-bar relative">
          {/* Left: category tabs */}
          <div className="flex items-end shrink-0">
            {([
              { key: 'favourites' as RibbonTab, label: 'Favourites', icon: <Star className="w-3 h-3" /> },
              { key: 'filters' as RibbonTab, label: 'Filters' },
              { key: 'camera' as RibbonTab, label: 'Camera' },
              { key: 'exposure' as RibbonTab, label: 'Exposure' },
              ...(aiEnabled ? [{ key: 'ai' as RibbonTab, label: 'AI', icon: <Sparkles className="w-3 h-3" /> }] : []),
            ]).map(tab => (
              <button
                key={tab.key}
                onClick={() => { setActiveTab(tab.key); if (!ribbonExpanded) setRibbonExpanded(true); }}
                className={`px-4 py-1.5 text-xs font-semibold uppercase tracking-wider transition-all flex items-center gap-1.5 relative ${
                  activeTab === tab.key
                    ? 'text-foreground bg-background rounded-t-md -mb-px z-10 border-x border-t ribbon-group-border'
                    : 'text-white/90 border-b-2 border-transparent hover:text-white ribbon-tab-inactive'
                }`}
              >
                {tab.icon}{tab.label}
              </button>
            ))}
          </div>

          {/* Center: title — absolutely centered across full width */}
          <span className="absolute left-0 right-0 text-xs font-semibold text-white/70 uppercase tracking-wider text-center pointer-events-none">Search & Discovery</span>
          <div className="flex-1" />

          {/* Right: status + controls + theme/license */}
          <div className="flex items-center gap-2 pr-3 shrink-0">
            {isIndexing && indexingProgress ? (
              <span className="flex items-center gap-1.5 text-xs text-white font-medium bg-white/15 px-2.5 py-1 rounded-full animate-pulse">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Indexing {indexingProgress.current.toLocaleString()}/{indexingProgress.total.toLocaleString()}
              </span>
            ) : aiProcessing && aiProgress ? (
              <span className="flex items-center gap-1.5 text-xs text-white font-medium bg-purple-500/30 px-2.5 py-1 rounded-full animate-pulse">
                <Brain className="w-3.5 h-3.5 animate-spin" />
                {aiProgress.phase === 'downloading-models' ? 'Downloading AI models...' :
                 aiProgress.phase === 'clustering' ? 'Clustering faces...' :
                 `Analyzing ${aiProgress.current}/${aiProgress.total}`}
                <button onClick={() => cancelAi()} className="ml-1 hover:text-white/90" title="Cancel"><X className="w-3 h-3" /></button>
              </span>
            ) : stats && stats.totalFiles > 0 ? (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-white/80 flex items-center gap-1.5 bg-white/10 px-2.5 py-1 rounded-full">
                  <Database className="w-3.5 h-3.5" />{stats.totalFiles.toLocaleString()} indexed
                </span>
                {aiEnabled && aiStats && aiStats.totalProcessed > 0 && (
                  <span className="text-xs text-white/80 flex items-center gap-1 bg-purple-500/20 px-2 py-1 rounded-full" title={`${aiStats.totalFaces} faces, ${aiStats.totalTags} tags detected`}>
                    <Sparkles className="w-3 h-3" />{aiStats.totalProcessed} analyzed
                  </span>
                )}
                {aiEnabled && aiStats && aiStats.unprocessed > 0 && !aiProcessing && (
                  <button
                    onClick={() => startAiProcessing()}
                    className="text-xs text-white font-medium flex items-center gap-1 bg-purple-500/40 hover:bg-purple-500/60 px-2.5 py-1 rounded-full transition-colors"
                    title={`Analyze ${aiStats.unprocessed} unprocessed photos with AI`}
                  >
                    <Scan className="w-3 h-3" />Analyze {aiStats.unprocessed}
                  </button>
                )}
              </div>
            ) : null}
            <button onClick={() => setShowCustomise(true)} className="p-1 rounded hover:bg-white/20 text-white/70 hover:text-white transition-colors" title="Customise favourite filters">
              <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setRibbonExpanded(!ribbonExpanded)}
              className="p-1 rounded hover:bg-white/20 text-white/70 hover:text-white transition-colors"
              title={ribbonExpanded ? 'Collapse ribbon (Ctrl+F to search)' : 'Expand ribbon'}
            >
              {ribbonExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            {/* Separator before app controls */}
            <div className="w-px h-5 bg-white/30 mx-0.5" />
            {onToggleDarkMode && (
              <button
                onClick={onToggleDarkMode}
                className="flex items-center justify-center w-7 h-7 rounded-full hover:bg-white/20 text-white/70 hover:text-white transition-all"
                title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {isDarkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
            )}
            {licenseStatusBadge}
          </div>
        </div>
      </div>{/* end tab bar wrapper */}

      {/* Ribbon body — counter-scaled for zoom independence */}
      <div className="border-b-2 bg-background select-none ribbon-outer-border shrink-0">
        <AnimatePresence initial={false}>
          {ribbonExpanded && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} style={{ overflow: 'visible' }}>
              <div ref={ribbonRef} className="flex items-stretch px-2 py-1 gap-0 min-h-[80px] bg-gradient-to-b from-background to-secondary/10" style={{ overflow: 'visible' }}>

                {/* ── Favourites empty state ── */}
                {activeTab === 'favourites' && favouriteGroups.length === 0 && (
                  <div className="flex items-center justify-center flex-1 py-4 px-6">
                    <div className="text-center">
                      <Star className="w-6 h-6 text-foreground/20 mx-auto mb-2" />
                      <p className="text-sm text-foreground/50 font-medium">No favourite filters yet</p>
                      <p className="text-xs text-muted-foreground mt-1">Click the <Star className="w-3 h-3 inline text-amber-500" /> star on any filter group in the other tabs to add it here (max {MAX_FAVOURITE_GROUPS})</p>
                    </div>
                  </div>
                )}

                {/* ── Search Group (always visible) ── */}
                <RibbonGroup label="Search">
                  <div className="flex items-center gap-2 flex-1 py-1.5">
                    <div className="relative min-w-[170px] max-w-[280px] flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/40" />
                      <input
                        ref={searchInputRef}
                        type="text"
                        placeholder={dbReady ? 'Search by filename...' : 'Initialising...'}
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        disabled={!dbReady}
                        className={`w-full pl-10 pr-8 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all ${!dbReady ? 'placeholder:text-foreground/50 placeholder:font-medium opacity-80' : 'placeholder:text-muted-foreground disabled:opacity-50'}`}
                      />
                      {searchText && (
                        <button onClick={() => { setSearchText(''); }} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    {!dbReady && !isIndexing && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground shrink-0" />}
                  </div>
                </RibbonGroup>

                {/* Dynamic filter groups based on user's selection */}
                {visibleGroups.includes('confidence') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Confidence" onExpand={() => setOverflowModalGroup('confidence')} groupId="confidence" isFavourited={isGroupFavourited('confidence')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex flex-col gap-0 flex-1 py-0.5">
                        {[
                          { val: 'confirmed', icon: <CheckCircle2 className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />, color: 'text-green-700 dark:text-green-400' },
                          { val: 'recovered', icon: <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />, color: 'text-amber-700 dark:text-amber-400' },
                          { val: 'marked', icon: <HelpCircle className="w-3.5 h-3.5 text-red-500 dark:text-red-400" />, color: 'text-red-600 dark:text-red-400' },
                        ].map(({ val, icon, color }) => {
                          const isActive = selectedConfidence.includes(val);
                          return (
                            <label key={val} className="flex items-center gap-1.5 px-1.5 py-0.5 rounded cursor-pointer hover:bg-secondary/50 transition-colors">
                              <input type="checkbox" checked={isActive} onChange={() => toggleFilter(selectedConfidence, setSelectedConfidence, val)}
                                className="w-3 h-3 rounded border-border text-primary accent-primary cursor-pointer" />
                              {icon}
                              <span className={`text-[11px] font-medium ${isActive ? color : 'text-foreground/70'}`}>{val.charAt(0).toUpperCase() + val.slice(1)}</span>
                            </label>
                          );
                        })}
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('type') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="File Type" onExpand={() => setOverflowModalGroup('type')} groupId="type" isFavourited={isGroupFavourited('type')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex gap-1 flex-1 py-1">
                        {/* Photos — icon + dropdown stacked */}
                        <div className="flex flex-col items-center gap-0.5">
                          <button onClick={() => toggleFilter(selectedFileType, setSelectedFileType, 'photo')}
                            className={`flex flex-col items-center gap-0.5 px-2.5 py-0.5 rounded-md border text-[11px] font-medium transition-all min-w-[50px] ${
                              selectedFileType.includes('photo') ? 'border-primary/50 bg-primary/10 text-primary' : 'border-transparent text-foreground/70 hover:bg-secondary hover:text-foreground'
                            }`}>
                            <FileImage className="w-[16px] h-[16px]" />
                            <span>Photos</span>
                          </button>
                          <FilterDropdown label="▾" active={selectedExtension.some(e => ['.jpg','.jpeg','.png','.gif','.bmp','.tiff','.tif','.heic','.heif','.webp','.raw','.cr2','.nef','.arw','.dng','.orf','.rw2','.pef','.sr2','.raf'].includes(e.toLowerCase()))}
                            activeLabel={selectedExtension.filter(e => ['.jpg','.jpeg','.png','.gif','.bmp','.tiff','.tif','.heic','.heif','.webp','.raw','.cr2','.nef','.arw','.dng','.orf','.rw2','.pef','.sr2','.raf'].includes(e.toLowerCase())).map(e => e.toUpperCase()).join(', ') || undefined}>
                            {filterOptions?.extensions.filter(ext => ['.jpg','.jpeg','.png','.gif','.bmp','.tiff','.tif','.heic','.heif','.webp','.raw','.cr2','.nef','.arw','.dng','.orf','.rw2','.pef','.sr2','.raf'].includes(ext.toLowerCase())).length === 0 && <p className="text-sm text-muted-foreground italic p-2">No photo formats found</p>}
                            <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/50">
                              <span className="text-[10px] font-semibold text-foreground/50 uppercase">Photo Formats</span>
                              <button onClick={() => {
                                const photoExts = filterOptions?.extensions.filter(ext => ['.jpg','.jpeg','.png','.gif','.bmp','.tiff','.tif','.heic','.heif','.webp','.raw','.cr2','.nef','.arw','.dng','.orf','.rw2','.pef','.sr2','.raf'].includes(ext.toLowerCase())) || [];
                                const allSelected = photoExts.every(ext => selectedExtension.includes(ext));
                                if (allSelected) setSelectedExtension(prev => prev.filter(e => !photoExts.includes(e)));
                                else setSelectedExtension(prev => [...new Set([...prev, ...photoExts])]);
                              }} className="text-[10px] text-primary hover:text-primary/80 font-medium">
                                {filterOptions?.extensions.filter(ext => ['.jpg','.jpeg','.png','.gif','.bmp','.tiff','.tif','.heic','.heif','.webp','.raw','.cr2','.nef','.arw','.dng','.orf','.rw2','.pef','.sr2','.raf'].includes(ext.toLowerCase())).every(ext => selectedExtension.includes(ext)) ? 'Deselect All' : 'Select All'}
                              </button>
                            </div>
                            {filterOptions?.extensions.filter(ext => ['.jpg','.jpeg','.png','.gif','.bmp','.tiff','.tif','.heic','.heif','.webp','.raw','.cr2','.nef','.arw','.dng','.orf','.rw2','.pef','.sr2','.raf'].includes(ext.toLowerCase())).map(ext => (
                              <FilterCheckbox key={ext} label={ext.toUpperCase()} checked={selectedExtension.includes(ext)} onChange={() => toggleFilter(selectedExtension, setSelectedExtension, ext)} />
                            ))}
                          </FilterDropdown>
                        </div>
                        {/* Videos — icon + dropdown stacked */}
                        <div className="flex flex-col items-center gap-0.5">
                          <button onClick={() => toggleFilter(selectedFileType, setSelectedFileType, 'video')}
                            className={`flex flex-col items-center gap-0.5 px-2.5 py-0.5 rounded-md border text-[11px] font-medium transition-all min-w-[50px] ${
                              selectedFileType.includes('video') ? 'border-primary/50 bg-primary/10 text-primary' : 'border-transparent text-foreground/70 hover:bg-secondary hover:text-foreground'
                            }`}>
                            <FileVideo className="w-[16px] h-[16px]" />
                            <span>Videos</span>
                          </button>
                          <FilterDropdown label="▾" active={selectedExtension.some(e => ['.mp4','.mov','.avi','.mkv','.wmv','.flv','.webm','.m4v','.3gp','.mpg','.mpeg','.mts','.m2ts'].includes(e.toLowerCase()))}
                            activeLabel={selectedExtension.filter(e => ['.mp4','.mov','.avi','.mkv','.wmv','.flv','.webm','.m4v','.3gp','.mpg','.mpeg','.mts','.m2ts'].includes(e.toLowerCase())).map(e => e.toUpperCase()).join(', ') || undefined}>
                            {filterOptions?.extensions.filter(ext => ['.mp4','.mov','.avi','.mkv','.wmv','.flv','.webm','.m4v','.3gp','.mpg','.mpeg','.mts','.m2ts'].includes(ext.toLowerCase())).length === 0 && <p className="text-sm text-muted-foreground italic p-2">No video formats found</p>}
                            <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/50">
                              <span className="text-[10px] font-semibold text-foreground/50 uppercase">Video Formats</span>
                              <button onClick={() => {
                                const videoExts = filterOptions?.extensions.filter(ext => ['.mp4','.mov','.avi','.mkv','.wmv','.flv','.webm','.m4v','.3gp','.mpg','.mpeg','.mts','.m2ts'].includes(ext.toLowerCase())) || [];
                                const allSelected = videoExts.every(ext => selectedExtension.includes(ext));
                                if (allSelected) setSelectedExtension(prev => prev.filter(e => !videoExts.includes(e)));
                                else setSelectedExtension(prev => [...new Set([...prev, ...videoExts])]);
                              }} className="text-[10px] text-primary hover:text-primary/80 font-medium">
                                {filterOptions?.extensions.filter(ext => ['.mp4','.mov','.avi','.mkv','.wmv','.flv','.webm','.m4v','.3gp','.mpg','.mpeg','.mts','.m2ts'].includes(ext.toLowerCase())).every(ext => selectedExtension.includes(ext)) ? 'Deselect All' : 'Select All'}
                              </button>
                            </div>
                            {filterOptions?.extensions.filter(ext => ['.mp4','.mov','.avi','.mkv','.wmv','.flv','.webm','.m4v','.3gp','.mpg','.mpeg','.mts','.m2ts'].includes(ext.toLowerCase())).map(ext => (
                              <FilterCheckbox key={ext} label={ext.toUpperCase()} checked={selectedExtension.includes(ext)} onChange={() => toggleFilter(selectedExtension, setSelectedExtension, ext)} />
                            ))}
                          </FilterDropdown>
                        </div>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('dateRange') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Date Range" onExpand={() => setOverflowModalGroup('dateRange')} groupId="dateRange" isFavourited={isGroupFavourited('dateRange')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex flex-col gap-0.5 flex-1 py-1">
                        <div className="flex items-center gap-1">
                          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                            className="px-1.5 py-1 rounded-md border border-border bg-background text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 w-[120px]" />
                          {(dateFrom || dateTo) && (
                            <button onClick={() => { setDateFrom(''); setDateTo(''); }} className="p-0.5 rounded text-muted-foreground hover:text-foreground shrink-0"><X className="w-3 h-3" /></button>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                            className="px-1.5 py-1 rounded-md border border-border bg-background text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 w-[120px]" />
                        </div>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {/* Year and Month removed — Date Range covers both */}

                {visibleGroups.includes('camera') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Camera" onExpand={() => setOverflowModalGroup('camera')} groupId="camera" isFavourited={isGroupFavourited('camera')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex items-center gap-1.5 flex-1 py-1">
                        <Camera className="w-[16px] h-[16px] text-foreground/50 shrink-0" />
                        <div className="flex flex-col gap-0.5">
                          <FilterDropdown label="Make" active={selectedCameraMake.length > 0} activeLabel={selectedCameraMake.length > 0 ? selectedCameraMake.join(', ') : undefined}>
                            {filterOptions?.cameraMakes.length === 0 && <p className="text-sm text-muted-foreground italic p-2">No camera data</p>}
                            {filterOptions?.cameraMakes.map(make => (
                              <FilterCheckbox key={make} label={make} checked={selectedCameraMake.includes(make)} onChange={() => toggleFilter(selectedCameraMake, setSelectedCameraMake, make)} />
                            ))}
                          </FilterDropdown>
                          <FilterDropdown label="Model" active={selectedCameraModel.length > 0} activeLabel={selectedCameraModel.length > 0 ? selectedCameraModel.join(', ') : undefined}>
                            {filterOptions?.cameraModels.length === 0 && <p className="text-sm text-muted-foreground italic p-2">No models</p>}
                            {filterOptions?.cameraModels.map(model => (
                              <FilterCheckbox key={model} label={model} checked={selectedCameraModel.includes(model)} onChange={() => toggleFilter(selectedCameraModel, setSelectedCameraModel, model)} />
                            ))}
                          </FilterDropdown>
                        </div>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('lens') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Lens" onExpand={() => setOverflowModalGroup('lens')} groupId="lens" isFavourited={isGroupFavourited('lens')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex items-center gap-1.5 flex-1 py-1.5">
                        <FilterDropdown label="Lens Model" active={selectedLensModel.length > 0} activeLabel={selectedLensModel.length > 0 ? selectedLensModel.join(', ') : undefined}>
                          {(!filterOptions?.lensModels || filterOptions.lensModels.length === 0) && <p className="text-sm text-muted-foreground italic p-2">No lens data</p>}
                          {filterOptions?.lensModels?.map(lens => (
                            <FilterCheckbox key={lens} label={lens} checked={selectedLensModel.includes(lens)} onChange={() => toggleFilter(selectedLensModel, setSelectedLensModel, lens)} />
                          ))}
                        </FilterDropdown>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('cameraPosition') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Camera Type" onExpand={() => setOverflowModalGroup('cameraPosition')} groupId="cameraPosition" isFavourited={isGroupFavourited('cameraPosition')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex items-center gap-1.5 flex-1 py-1.5">
                        <FilterDropdown label="Position" active={selectedCameraPosition.length > 0} activeLabel={selectedCameraPosition.length > 0 ? selectedCameraPosition.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(', ') : undefined}>
                          {(!filterOptions?.cameraPositions || filterOptions.cameraPositions.length === 0) && <p className="text-sm text-muted-foreground italic p-2">No data — re-index to populate</p>}
                          {filterOptions?.cameraPositions?.map(pos => (
                            <FilterCheckbox key={pos} label={pos.charAt(0).toUpperCase() + pos.slice(1)} checked={selectedCameraPosition.includes(pos)} onChange={() => toggleFilter(selectedCameraPosition, setSelectedCameraPosition, pos)} />
                          ))}
                        </FilterDropdown>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('scene') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Scene Mode" onExpand={() => setOverflowModalGroup('scene')} groupId="scene" isFavourited={isGroupFavourited('scene')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex items-center gap-1.5 flex-1 py-1.5">
                        <FilterDropdown label="Scene" active={selectedScene.length > 0} activeLabel={selectedScene.length > 0 ? selectedScene.join(', ') : undefined}>
                          {(!filterOptions?.sceneCaptureTypes || filterOptions.sceneCaptureTypes.length === 0) && <p className="text-sm text-muted-foreground italic p-2">No scene data — re-index to populate</p>}
                          {filterOptions?.sceneCaptureTypes?.map(scene => (
                            <FilterCheckbox key={scene} label={scene} checked={selectedScene.includes(scene)} onChange={() => toggleFilter(selectedScene, setSelectedScene, scene)} />
                          ))}
                        </FilterDropdown>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('exposureProgram') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Exposure" onExpand={() => setOverflowModalGroup('exposureProgram')} groupId="exposureProgram" isFavourited={isGroupFavourited('exposureProgram')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex items-center gap-1.5 flex-1 py-1.5">
                        <FilterDropdown label="Program" active={selectedExposureProgram.length > 0} activeLabel={selectedExposureProgram.length > 0 ? selectedExposureProgram.join(', ') : undefined}>
                          {(!filterOptions?.exposurePrograms || filterOptions.exposurePrograms.length === 0) && <p className="text-sm text-muted-foreground italic p-2">No data — re-index to populate</p>}
                          {filterOptions?.exposurePrograms?.map(prog => (
                            <FilterCheckbox key={prog} label={prog} checked={selectedExposureProgram.includes(prog)} onChange={() => toggleFilter(selectedExposureProgram, setSelectedExposureProgram, prog)} />
                          ))}
                        </FilterDropdown>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('whiteBalance') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="White Balance" onExpand={() => setOverflowModalGroup('whiteBalance')} groupId="whiteBalance" isFavourited={isGroupFavourited('whiteBalance')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex items-center gap-1.5 flex-1 py-1.5">
                        <FilterDropdown label="WB" active={selectedWhiteBalance.length > 0} activeLabel={selectedWhiteBalance.length > 0 ? selectedWhiteBalance.join(', ') : undefined}>
                          {(!filterOptions?.whiteBalances || filterOptions.whiteBalances.length === 0) && <p className="text-sm text-muted-foreground italic p-2">No data — re-index to populate</p>}
                          {filterOptions?.whiteBalances?.map(wb => (
                            <FilterCheckbox key={wb} label={wb} checked={selectedWhiteBalance.includes(wb)} onChange={() => toggleFilter(selectedWhiteBalance, setSelectedWhiteBalance, wb)} />
                          ))}
                        </FilterDropdown>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('orientation') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Orientation" onExpand={() => setOverflowModalGroup('orientation')} groupId="orientation" isFavourited={isGroupFavourited('orientation')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex items-center gap-1.5 flex-1 py-1.5">
                        <FilterDropdown label="Orient." active={selectedOrientation.length > 0} activeLabel={selectedOrientation.length > 0 ? selectedOrientation.join(', ') : undefined}>
                          {(!filterOptions?.orientations || filterOptions.orientations.length === 0) && <p className="text-sm text-muted-foreground italic p-2">No data — re-index to populate</p>}
                          {filterOptions?.orientations?.map(o => (
                            <FilterCheckbox key={o} label={o} checked={selectedOrientation.includes(o)} onChange={() => toggleFilter(selectedOrientation, setSelectedOrientation, o)} />
                          ))}
                        </FilterDropdown>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('source') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Date Source" onExpand={() => setOverflowModalGroup('source')} groupId="source" isFavourited={isGroupFavourited('source')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex items-center gap-1.5 flex-1 py-1.5">
                        <FilterDropdown label="Source" active={selectedDateSource.length > 0} activeLabel={selectedDateSource.length > 0 ? selectedDateSource.join(', ') : undefined}>
                          {filterOptions?.dateSources.length === 0 && <p className="text-sm text-muted-foreground italic p-2">No sources</p>}
                          {filterOptions?.dateSources.map(src => (
                            <FilterCheckbox key={src} label={src} checked={selectedDateSource.includes(src)} onChange={() => toggleFilter(selectedDateSource, setSelectedDateSource, src)} />
                          ))}
                        </FilterDropdown>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {/* Extension merged into File Type group */}

                {visibleGroups.includes('gps') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Location" onExpand={() => setOverflowModalGroup('gps')} groupId="gps" isFavourited={isGroupFavourited('gps')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex items-center gap-1.5 flex-1 py-1">
                        <div className="flex flex-col gap-0.5">
                          <button onClick={() => setHasGps(prev => prev === true ? undefined : true)}
                            className={`flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium transition-all ${hasGps === true ? 'border-primary/50 bg-primary/10 text-primary' : 'border-transparent text-foreground/70 hover:bg-secondary hover:text-foreground'}`}>
                            <MapPin className="w-3.5 h-3.5" />
                            <span>GPS</span>
                          </button>
                          <button onClick={() => setHasGps(prev => prev === false ? undefined : false)}
                            className={`flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium transition-all ${hasGps === false ? 'border-primary/50 bg-primary/10 text-primary' : 'border-transparent text-foreground/70 hover:bg-secondary hover:text-foreground'}`}>
                            <MapPin className="w-3.5 h-3.5 opacity-40" />
                            <span>No GPS</span>
                          </button>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <FilterDropdown label="Country" active={selectedCountry.length > 0} activeLabel={selectedCountry.length > 0 ? selectedCountry.join(', ') : undefined}>
                            {(!filterOptions?.countries || filterOptions.countries.length === 0) && <p className="text-sm text-muted-foreground italic p-2">No location data — re-index to populate</p>}
                            {filterOptions?.countries?.map(c => (
                              <FilterCheckbox key={c} label={c} checked={selectedCountry.includes(c)} onChange={() => toggleFilter(selectedCountry, setSelectedCountry, c)} />
                            ))}
                          </FilterDropdown>
                          <FilterDropdown label="City" active={selectedCity.length > 0} activeLabel={selectedCity.length > 0 ? selectedCity.join(', ') : undefined}>
                            {(!filterOptions?.cities || filterOptions.cities.length === 0) && <p className="text-sm text-muted-foreground italic p-2">No location data — re-index to populate</p>}
                            {filterOptions?.cities?.map(c => (
                              <FilterCheckbox key={c} label={c} checked={selectedCity.includes(c)} onChange={() => toggleFilter(selectedCity, setSelectedCity, c)} />
                            ))}
                          </FilterDropdown>
                        </div>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('iso') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="ISO" onExpand={() => setOverflowModalGroup('iso')} groupId="iso" isFavourited={isGroupFavourited('iso')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex flex-col gap-0.5 flex-1 py-1">
                        <input type="number" placeholder="Min" value={isoFrom ?? ''} onChange={(e) => setIsoFrom(e.target.value ? Number(e.target.value) : undefined)}
                          className="px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 w-[52px]" />
                        <input type="number" placeholder="Max" value={isoTo ?? ''} onChange={(e) => setIsoTo(e.target.value ? Number(e.target.value) : undefined)}
                          className="px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 w-[52px]" />
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('aperture') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Aperture" onExpand={() => setOverflowModalGroup('aperture')} groupId="aperture" isFavourited={isGroupFavourited('aperture')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex flex-col gap-0.5 flex-1 py-1">
                        <span className="text-foreground/50 text-[10px] font-semibold uppercase tracking-wider">f/</span>
                        <input type="number" step="0.1" placeholder="Min" value={apertureFrom ?? ''} onChange={(e) => setApertureFrom(e.target.value ? Number(e.target.value) : undefined)}
                          className="px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 w-[52px]" />
                        <input type="number" step="0.1" placeholder="Max" value={apertureTo ?? ''} onChange={(e) => setApertureTo(e.target.value ? Number(e.target.value) : undefined)}
                          className="px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 w-[52px]" />
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('focalLength') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Focal Length" onExpand={() => setOverflowModalGroup('focalLength')} groupId="focalLength" isFavourited={isGroupFavourited('focalLength')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex flex-col gap-0.5 flex-1 py-1">
                        <span className="text-foreground/50 text-[10px] font-semibold uppercase tracking-wider">mm</span>
                        <input type="number" placeholder="Min" value={focalLengthFrom ?? ''} onChange={(e) => setFocalLengthFrom(e.target.value ? Number(e.target.value) : undefined)}
                          className="px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 w-[52px]" />
                        <input type="number" placeholder="Max" value={focalLengthTo ?? ''} onChange={(e) => setFocalLengthTo(e.target.value ? Number(e.target.value) : undefined)}
                          className="px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 w-[52px]" />
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('flash') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Flash" onExpand={() => setOverflowModalGroup('flash')} groupId="flash" isFavourited={isGroupFavourited('flash')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex items-center gap-1 flex-1 py-1.5">
                        <button onClick={() => setFlashFired(prev => prev === true ? undefined : true)}
                          className={`px-2.5 py-1.5 rounded-md border text-[11px] font-medium transition-all ${flashFired === true ? 'border-primary/50 bg-primary/10 text-primary' : 'border-transparent text-foreground/70 hover:bg-secondary hover:text-foreground'}`}>
                          Fired
                        </button>
                        <button onClick={() => setFlashFired(prev => prev === false ? undefined : false)}
                          className={`px-2.5 py-1.5 rounded-md border text-[11px] font-medium transition-all ${flashFired === false ? 'border-primary/50 bg-primary/10 text-primary' : 'border-transparent text-foreground/70 hover:bg-secondary hover:text-foreground'}`}>
                          No Flash
                        </button>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('megapixels') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Megapixels" onExpand={() => setOverflowModalGroup('megapixels')} groupId="megapixels" isFavourited={isGroupFavourited('megapixels')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex flex-col gap-0.5 flex-1 py-1">
                        <span className="text-foreground/50 text-[10px] font-semibold uppercase tracking-wider">MP</span>
                        <input type="number" step="0.1" placeholder="Min" value={megapixelsFrom ?? ''} onChange={(e) => setMegapixelsFrom(e.target.value ? Number(e.target.value) : undefined)}
                          className="px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 w-[52px]" />
                        <input type="number" step="0.1" placeholder="Max" value={megapixelsTo ?? ''} onChange={(e) => setMegapixelsTo(e.target.value ? Number(e.target.value) : undefined)}
                          className="px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 w-[52px]" />
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('fileSize') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="File Size" onExpand={() => setOverflowModalGroup('fileSize')} groupId="fileSize" isFavourited={isGroupFavourited('fileSize')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex flex-col gap-0.5 flex-1 py-1">
                        <span className="text-foreground/50 text-[10px] font-semibold uppercase tracking-wider">MB</span>
                        <input type="number" step="0.1" placeholder="Min" value={sizeFromMB ?? ''} onChange={(e) => setSizeFromMB(e.target.value ? Number(e.target.value) : undefined)}
                          className="px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 w-[52px]" />
                        <input type="number" step="0.1" placeholder="Max" value={sizeToMB ?? ''} onChange={(e) => setSizeToMB(e.target.value ? Number(e.target.value) : undefined)}
                          className="px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 w-[52px]" />
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {/* ── Destination filter ── */}
                {visibleGroups.includes('destination') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Destination" onExpand={() => setOverflowModalGroup('destination')} groupId="destination" isFavourited={isGroupFavourited('destination')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex items-center gap-1.5 flex-1 py-1.5">
                        <FilterDropdown label="Destination" active={selectedDestination.length > 0} activeLabel={selectedDestination.length > 0 ? `${selectedDestination.length} selected` : undefined}>
                          {(!filterOptions?.destinations || filterOptions.destinations.length === 0) ? (
                            <p className="text-xs text-muted-foreground italic px-3 py-2">No destinations indexed</p>
                          ) : (
                            filterOptions.destinations.map(dest => {
                              const available = destinationAvailability[dest] !== false;
                              return (
                                <FilterCheckbox
                                  key={dest}
                                  label={available ? dest : `${dest}`}
                                  checked={selectedDestination.includes(dest)}
                                  onChange={() => toggleFilter(selectedDestination, setSelectedDestination, dest)}
                                  icon={available
                                    ? <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />
                                    : <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                                  }
                                />
                              );
                            })
                          )}
                        </FilterDropdown>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {/* ── AI Tags filter ── */}
                {visibleGroups.includes('aiTags') && aiTagOptions.length > 0 && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="AI Tags" groupId="aiTags" isFavourited={isGroupFavourited('aiTags')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex flex-col gap-0 flex-1 py-0.5 max-h-[72px] overflow-y-auto pr-1">
                        {aiTagOptions.slice(0, 8).map(({ tag, count }) => {
                          const isActive = selectedAiTags.includes(tag);
                          return (
                            <label key={tag} className="flex items-center gap-1.5 px-1.5 py-0.5 rounded cursor-pointer hover:bg-secondary/50 transition-colors">
                              <input type="checkbox" checked={isActive} onChange={() => toggleFilter(selectedAiTags, setSelectedAiTags, tag)}
                                className="w-3 h-3 rounded border-border text-primary accent-primary cursor-pointer" />
                              <Tag className="w-3 h-3 text-purple-400" />
                              <span className={`text-[11px] font-medium ${isActive ? 'text-purple-500 dark:text-purple-400' : 'text-foreground/70'}`}>{tag}</span>
                              <span className="text-[9px] text-muted-foreground ml-auto">{count}</span>
                            </label>
                          );
                        })}
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {/* AI: Analyze button (shown on AI tab when no tags yet) */}
                {activeTab === 'ai' && aiEnabled && aiTagOptions.length === 0 && !aiProcessing && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Analyze">
                      <div className="flex items-center justify-center flex-1 py-2">
                        <div className="flex flex-col items-center gap-1.5">
                          <button
                            onClick={() => startAiProcessing()}
                            className="flex flex-col items-center gap-1 px-4 py-2 rounded-lg bg-purple-500/10 hover:bg-purple-500/20 text-purple-600 dark:text-purple-400 transition-colors"
                          >
                            <Brain className="w-5 h-5" />
                            <span className="text-[11px] font-semibold">Analyze Photos</span>
                            <span className="text-[9px] text-muted-foreground">Face & scene detection</span>
                          </button>
                          {!aiStats || aiStats.totalProcessed === 0 ? (
                            <span className="text-[9px] text-muted-foreground/70 text-center max-w-[160px]">
                              First run downloads AI models (~300 MB). After that, fully offline.
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {/* AI: Processing progress (shown on AI tab) */}
                {activeTab === 'ai' && aiProcessing && aiProgress && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Progress">
                      <div className="flex flex-col gap-1 flex-1 py-1.5 min-w-[180px]">
                        <div className="flex items-center gap-1.5 text-[11px] text-foreground/70">
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-500" />
                          {aiProgress.phase === 'downloading-models' ? 'Downloading models...' :
                           aiProgress.phase === 'clustering' ? 'Clustering faces...' :
                           `${aiProgress.current} / ${aiProgress.total}`}
                        </div>
                        {aiProgress.total > 0 && (
                          <div className="w-full h-1.5 rounded-full bg-secondary overflow-hidden">
                            <div className="h-full bg-purple-500 rounded-full transition-all" style={{ width: `${Math.round((aiProgress.current / aiProgress.total) * 100)}%` }} />
                          </div>
                        )}
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span>{aiProgress.facesFound} faces</span>
                          <span>{aiProgress.tagsApplied} tags</span>
                        </div>
                        <button onClick={() => cancelAi()} className="text-[10px] text-red-400 hover:text-red-300 transition-colors">Cancel</button>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {/* AI: Stats summary (shown on AI tab after processing) */}
                {activeTab === 'ai' && aiEnabled && aiStats && aiStats.totalProcessed > 0 && !aiProcessing && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="AI Stats">
                      <div className="flex items-center gap-3 flex-1 py-1.5">
                        <div className="flex flex-col items-center">
                          <span className="text-sm font-semibold text-foreground">{aiStats.totalProcessed}</span>
                          <span className="text-[9px] text-muted-foreground uppercase">Analyzed</span>
                        </div>
                        <div className="flex flex-col items-center">
                          <span className="text-sm font-semibold text-purple-500">{aiStats.totalFaces}</span>
                          <span className="text-[9px] text-muted-foreground uppercase">Faces</span>
                        </div>
                        <div className="flex flex-col items-center">
                          <span className="text-sm font-semibold text-purple-500">{aiStats.totalTags}</span>
                          <span className="text-[9px] text-muted-foreground uppercase">Tags</span>
                        </div>
                        <div className="flex flex-col items-center">
                          <span className="text-sm font-semibold text-foreground">{aiStats.totalPersons}</span>
                          <span className="text-[9px] text-muted-foreground uppercase">People</span>
                        </div>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {/* ── Sort (always visible) ── */}
                <RibbonSeparator />
                <RibbonGroup label="Sort">
                  <div className="flex items-center gap-1.5 flex-1 py-1.5">
                    <div className="flex flex-col gap-1">
                      <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SearchQuery['sortBy'])}
                        className="px-2 py-1 rounded-md border border-border bg-background text-[12px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40">
                        <option value="derived_date">Date</option>
                        <option value="filename">Name</option>
                        <option value="size_bytes">Size</option>
                        <option value="confidence">Confidence</option>
                        <option value="camera_model">Camera</option>
                        <option value="iso">ISO</option>
                        <option value="aperture">Aperture</option>
                        <option value="focal_length">Focal Length</option>
                        <option value="megapixels">Megapixels</option>
                      </select>
                      <button onClick={() => setSortDir(prev => prev === 'asc' ? 'desc' : 'asc')}
                        className="px-2 py-1 rounded-md border border-border text-foreground/70 hover:text-foreground hover:border-primary/40 transition-all text-[11px] flex items-center gap-1 justify-center font-medium">
                        <ArrowUpDown className="w-3.5 h-3.5" />
                        {sortDir === 'asc' ? 'Ascending' : 'Descending'}
                      </button>
                    </div>
                  </div>
                </RibbonGroup>

                {/* ── Actions (always visible) ── */}
                <RibbonSeparator />
                <RibbonGroup label="Actions">
                  <div className="flex items-center gap-1 flex-1 py-1.5">
                    {hasActiveFilters && (
                      <button onClick={clearFilters} className="flex flex-col items-center gap-0.5 px-2.5 py-1 rounded-md border border-transparent text-foreground/70 hover:bg-secondary hover:text-foreground transition-all text-[11px] font-medium min-w-[42px]" title="Clear all filters">
                        <RotateCcw className="w-[18px] h-[18px]" />
                        <span>Clear</span>
                      </button>
                    )}
                    {hasActiveFilters && !showSaveFavourite && (
                      <button onClick={() => setShowSaveFavourite(true)}
                        className="flex flex-col items-center gap-0.5 px-2.5 py-1 rounded-md border border-transparent text-foreground/70 hover:bg-secondary hover:text-foreground transition-all text-[11px] font-medium min-w-[42px]" title="Save filters as favourite">
                        <Star className="w-[18px] h-[18px]" />
                        <span>Save</span>
                      </button>
                    )}
                    {hasActiveFilters && showSaveFavourite && (
                      <div className="flex items-center gap-1">
                        <input type="text" placeholder="Name..." value={favouriteName} onChange={(e) => setFavouriteName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleSaveFavourite(); if (e.key === 'Escape') setShowSaveFavourite(false); }}
                          className="px-2 py-1.5 rounded-md border border-primary/40 bg-background text-[12px] text-foreground w-24 focus:outline-none focus:ring-1 focus:ring-primary/40" autoFocus />
                        <button onClick={handleSaveFavourite} className="p-1 rounded text-primary hover:bg-primary/10"><Star className="w-4 h-4" /></button>
                        <button onClick={() => setShowSaveFavourite(false)} className="p-1 rounded text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
                      </div>
                    )}
                    <button onClick={() => setShowIndexManager(true)} className="flex flex-col items-center gap-0.5 px-2.5 py-1 rounded-md border border-transparent text-foreground/70 hover:bg-secondary hover:text-foreground transition-all text-[11px] font-medium min-w-[42px]" title="Manage Index">
                      <Database className="w-[18px] h-[18px]" />
                      <span>Index</span>
                    </button>
                  </div>
                </RibbonGroup>

              </div>

              {/* Saved filter presets strip */}
              {favourites.length > 0 && (
                <div className="px-4 py-1.5 border-t flex items-center gap-2 flex-wrap ribbon-group-border">
                  <Bookmark className="w-4 h-4 text-foreground/40 shrink-0" />
                  <span className="text-[10px] text-foreground/40 font-medium uppercase tracking-wider shrink-0">Saved:</span>
                  {favourites.map(fav => (
                    <button key={fav.id} onClick={() => applyFavourite(fav)} className="group flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-primary/40 bg-primary/5 text-xs text-primary font-medium hover:bg-primary/10 transition-all">
                      <Bookmark className="w-3 h-3 fill-primary" />
                      {fav.name}
                      <X className="w-3 h-3 opacity-0 group-hover:opacity-100 hover:text-red-500" onClick={(e) => { e.stopPropagation(); handleDeleteFavourite(fav.id); }} />
                    </button>
                  ))}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Group Expand Modal — like Word's paragraph dialog */}
      {overflowModalGroup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setOverflowModalGroup(null)}>
          <div className="bg-background border border-border rounded-2xl shadow-2xl p-6 min-w-[340px] max-w-[500px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-foreground">
                {allFilterGroups.find(g => g.id === overflowModalGroup)?.label ?? overflowModalGroup}
              </h3>
              <button onClick={() => setOverflowModalGroup(null)} className="p-1 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              {overflowModalGroup === 'confidence' && (
                <div className="flex flex-wrap gap-2">
                  {['confirmed', 'recovered', 'marked'].map(val => {
                    const isActive = selectedConfidence.includes(val);
                    const activeColors: Record<string, string> = { confirmed: 'text-green-700 border-green-600/50 bg-green-50 dark:text-green-400 dark:bg-green-950/40', recovered: 'text-amber-700 border-amber-500/50 bg-amber-50 dark:text-amber-400 dark:bg-amber-950/40', marked: 'text-red-600 border-red-500/50 bg-red-50 dark:text-red-400 dark:bg-red-950/40' };
                    return (
                      <button key={val} onClick={() => toggleFilter(selectedConfidence, setSelectedConfidence, val)}
                        className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-all ${isActive ? activeColors[val] : 'border-border text-foreground/70 hover:bg-secondary hover:text-foreground'}`}>
                        {val === 'confirmed' && <CheckCircle2 className="w-5 h-5" />}
                        {val === 'recovered' && <AlertTriangle className="w-5 h-5" />}
                        {val === 'marked' && <HelpCircle className="w-5 h-5" />}
                        {val.charAt(0).toUpperCase() + val.slice(1)}
                      </button>
                    );
                  })}
                </div>
              )}
              {overflowModalGroup === 'type' && (
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    {[{ val: 'photo', icon: <ImageIcon className="w-5 h-5" />, label: 'All Photos' }, { val: 'video', icon: <Film className="w-5 h-5" />, label: 'All Videos' }].map(({ val, icon, label }) => (
                      <button key={val} onClick={() => toggleFilter(selectedFileType, setSelectedFileType, val)}
                        className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-all ${selectedFileType.includes(val) ? 'text-primary border-primary/50 bg-primary/10' : 'border-border text-foreground/70 hover:bg-secondary hover:text-foreground'}`}>
                        {icon}{label}
                      </button>
                    ))}
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold text-foreground/50 uppercase tracking-wider mb-2">Photo Formats</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {filterOptions?.extensions.filter(ext => ['.jpg','.jpeg','.png','.gif','.bmp','.tiff','.tif','.heic','.heif','.webp','.raw','.cr2','.nef','.arw','.dng','.orf','.rw2','.pef','.sr2','.raf'].includes(ext.toLowerCase())).map(ext => (
                        <button key={ext} onClick={() => toggleFilter(selectedExtension, setSelectedExtension, ext)} className={`px-3 py-1.5 rounded-md border text-xs transition-all ${selectedExtension.includes(ext) ? 'text-primary border-primary/50 bg-primary/10 font-medium' : 'border-border text-foreground/70 hover:bg-secondary'}`}>{ext.toUpperCase()}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold text-foreground/50 uppercase tracking-wider mb-2">Video Formats</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {filterOptions?.extensions.filter(ext => ['.mp4','.mov','.avi','.mkv','.wmv','.flv','.webm','.m4v','.3gp','.mpg','.mpeg','.mts','.m2ts'].includes(ext.toLowerCase())).map(ext => (
                        <button key={ext} onClick={() => toggleFilter(selectedExtension, setSelectedExtension, ext)} className={`px-3 py-1.5 rounded-md border text-xs transition-all ${selectedExtension.includes(ext) ? 'text-primary border-primary/50 bg-primary/10 font-medium' : 'border-border text-foreground/70 hover:bg-secondary'}`}>{ext.toUpperCase()}</button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {overflowModalGroup === 'dateRange' && (
                <div className="flex flex-col gap-3">
                  <label className="text-sm text-foreground/70 font-medium">From</label>
                  <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  <label className="text-sm text-foreground/70 font-medium">To</label>
                  <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40" />
                </div>
              )}
              {(overflowModalGroup === 'camera' || overflowModalGroup === 'lens' || overflowModalGroup === 'cameraPosition' || overflowModalGroup === 'scene' || overflowModalGroup === 'exposureProgram' || overflowModalGroup === 'whiteBalance' || overflowModalGroup === 'orientation' || overflowModalGroup === 'source') && (
                <div className="text-sm text-foreground/70">
                  {/* These dropdown-based filters work inline — the modal just provides more space */}
                  {overflowModalGroup === 'camera' && filterOptions && (
                    <div className="flex flex-col gap-3">
                      <div>
                        <label className="text-xs font-medium text-foreground/60 uppercase mb-1 block">Make</label>
                        <div className="flex flex-wrap gap-1.5">{(filterOptions.cameraMakes || []).map((m: string) => (
                          <button key={m} onClick={() => toggleFilter(selectedCameraMake, setSelectedCameraMake, m)} className={`px-3 py-1.5 rounded-md border text-xs transition-all ${selectedCameraMake.includes(m) ? 'text-primary border-primary/50 bg-primary/10 font-medium' : 'border-border text-foreground/70 hover:bg-secondary'}`}>{m}</button>
                        ))}</div>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-foreground/60 uppercase mb-1 block">Model</label>
                        <div className="flex flex-wrap gap-1.5">{(filterOptions.cameraModels || []).map((m: string) => (
                          <button key={m} onClick={() => toggleFilter(selectedCameraModel, setSelectedCameraModel, m)} className={`px-3 py-1.5 rounded-md border text-xs transition-all ${selectedCameraModel.includes(m) ? 'text-primary border-primary/50 bg-primary/10 font-medium' : 'border-border text-foreground/70 hover:bg-secondary'}`}>{m}</button>
                        ))}</div>
                      </div>
                    </div>
                  )}
                  {overflowModalGroup === 'lens' && filterOptions && (
                    <div className="flex flex-wrap gap-1.5">{((filterOptions as any).lensModels || []).map((l: string) => (
                      <button key={l} onClick={() => toggleFilter(selectedLensModel, setSelectedLensModel, l)} className={`px-3 py-1.5 rounded-md border text-xs transition-all ${selectedLensModel.includes(l) ? 'text-primary border-primary/50 bg-primary/10 font-medium' : 'border-border text-foreground/70 hover:bg-secondary'}`}>{l}</button>
                    ))}</div>
                  )}
                  {overflowModalGroup === 'cameraPosition' && filterOptions && (
                    <div className="flex flex-wrap gap-2">{((filterOptions as any).cameraPositions || []).map((p: string) => (
                      <button key={p} onClick={() => toggleFilter(selectedCameraPosition, setSelectedCameraPosition, p)} className={`px-3 py-2 rounded-lg border text-sm transition-all ${selectedCameraPosition.includes(p) ? 'text-primary border-primary/50 bg-primary/10 font-medium' : 'border-border text-foreground/70 hover:bg-secondary'}`}>{p.charAt(0).toUpperCase() + p.slice(1)}</button>
                    ))}</div>
                  )}
                  {overflowModalGroup === 'scene' && filterOptions && (
                    <div className="flex flex-wrap gap-2">{((filterOptions as any).sceneCaptureTypes || []).map((s: string) => (
                      <button key={s} onClick={() => toggleFilter(selectedScene, setSelectedScene, s)} className={`px-3 py-2 rounded-lg border text-sm transition-all ${selectedScene.includes(s) ? 'text-primary border-primary/50 bg-primary/10 font-medium' : 'border-border text-foreground/70 hover:bg-secondary'}`}>{s}</button>
                    ))}</div>
                  )}
                  {overflowModalGroup === 'exposureProgram' && filterOptions && (
                    <div className="flex flex-wrap gap-2">{((filterOptions as any).exposurePrograms || []).map((e: string) => (
                      <button key={e} onClick={() => toggleFilter(selectedExposureProgram, setSelectedExposureProgram, e)} className={`px-3 py-2 rounded-lg border text-sm transition-all ${selectedExposureProgram.includes(e) ? 'text-primary border-primary/50 bg-primary/10 font-medium' : 'border-border text-foreground/70 hover:bg-secondary'}`}>{e}</button>
                    ))}</div>
                  )}
                  {overflowModalGroup === 'whiteBalance' && filterOptions && (
                    <div className="flex flex-wrap gap-2">{((filterOptions as any).whiteBalances || []).map((w: string) => (
                      <button key={w} onClick={() => toggleFilter(selectedWhiteBalance, setSelectedWhiteBalance, w)} className={`px-3 py-2 rounded-lg border text-sm transition-all ${selectedWhiteBalance.includes(w) ? 'text-primary border-primary/50 bg-primary/10 font-medium' : 'border-border text-foreground/70 hover:bg-secondary'}`}>{w}</button>
                    ))}</div>
                  )}
                  {overflowModalGroup === 'orientation' && filterOptions && (
                    <div className="flex flex-wrap gap-2">{((filterOptions as any).orientations || []).map((o: string) => (
                      <button key={o} onClick={() => toggleFilter(selectedOrientation, setSelectedOrientation, o)} className={`px-3 py-2 rounded-lg border text-sm transition-all ${selectedOrientation.includes(o) ? 'text-primary border-primary/50 bg-primary/10 font-medium' : 'border-border text-foreground/70 hover:bg-secondary'}`}>{o}</button>
                    ))}</div>
                  )}
                  {overflowModalGroup === 'source' && filterOptions && (
                    <div className="flex flex-wrap gap-2">{(filterOptions.dateSources || []).map((s: string) => (
                      <button key={s} onClick={() => toggleFilter(selectedDateSource, setSelectedDateSource, s)} className={`px-3 py-2 rounded-lg border text-sm transition-all ${selectedDateSource.includes(s) ? 'text-primary border-primary/50 bg-primary/10 font-medium' : 'border-border text-foreground/70 hover:bg-secondary'}`}>{s}</button>
                    ))}</div>
                  )}
                  {/* Extension removed — merged into File Type group */}
                </div>
              )}
              {/* Year and Month modals removed — use Date Range instead */}
              {overflowModalGroup === 'gps' && (
                <div className="flex flex-wrap gap-2">
                  {[{ val: true, label: 'Has GPS' }, { val: false, label: 'No GPS' }].map(({ val, label }) => (
                    <button key={String(val)} onClick={() => setHasGps(hasGps === val ? undefined : val)}
                      className={`px-4 py-2.5 rounded-lg border text-sm font-medium transition-all ${hasGps === val ? 'text-primary border-primary/50 bg-primary/10' : 'border-border text-foreground/70 hover:bg-secondary'}`}>{label}</button>
                  ))}
                </div>
              )}
              {overflowModalGroup === 'iso' && (
                <div className="flex items-center gap-3">
                  <input type="number" placeholder="Min ISO" value={isoFrom ?? ''} onChange={e => setIsoFrom(e.target.value ? Number(e.target.value) : undefined)} className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground w-28 focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  <span className="text-foreground/40">–</span>
                  <input type="number" placeholder="Max ISO" value={isoTo ?? ''} onChange={e => setIsoTo(e.target.value ? Number(e.target.value) : undefined)} className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground w-28 focus:outline-none focus:ring-2 focus:ring-primary/40" />
                </div>
              )}
              {overflowModalGroup === 'aperture' && (
                <div className="flex items-center gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-foreground/60">Min f/</label>
                    <input type="number" step="0.1" placeholder="e.g. 1.4" value={apertureFrom ?? ''} onChange={e => setApertureFrom(e.target.value ? Number(e.target.value) : undefined)} className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground w-28 focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  </div>
                  <span className="text-foreground/40 mt-5">–</span>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-foreground/60">Max f/</label>
                    <input type="number" step="0.1" placeholder="e.g. 22" value={apertureTo ?? ''} onChange={e => setApertureTo(e.target.value ? Number(e.target.value) : undefined)} className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground w-28 focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  </div>
                </div>
              )}
              {overflowModalGroup === 'focalLength' && (
                <div className="flex items-center gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-foreground/60">Min mm</label>
                    <input type="number" placeholder="e.g. 24" value={focalLengthFrom ?? ''} onChange={e => setFocalLengthFrom(e.target.value ? Number(e.target.value) : undefined)} className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground w-28 focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  </div>
                  <span className="text-foreground/40 mt-5">–</span>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-foreground/60">Max mm</label>
                    <input type="number" placeholder="e.g. 200" value={focalLengthTo ?? ''} onChange={e => setFocalLengthTo(e.target.value ? Number(e.target.value) : undefined)} className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground w-28 focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  </div>
                </div>
              )}
              {overflowModalGroup === 'flash' && (
                <div className="flex flex-wrap gap-2">
                  {[{ val: true, label: 'Flash Fired' }, { val: false, label: 'No Flash' }].map(({ val, label }) => (
                    <button key={String(val)} onClick={() => setFlashFired(flashFired === val ? undefined : val)}
                      className={`px-4 py-2.5 rounded-lg border text-sm font-medium transition-all ${flashFired === val ? 'text-primary border-primary/50 bg-primary/10' : 'border-border text-foreground/70 hover:bg-secondary'}`}>{label}</button>
                  ))}
                </div>
              )}
              {overflowModalGroup === 'megapixels' && (
                <div className="flex items-center gap-3">
                  <input type="number" step="0.1" placeholder="Min MP" value={megapixelsFrom ?? ''} onChange={e => setMegapixelsFrom(e.target.value ? Number(e.target.value) : undefined)} className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground w-28 focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  <span className="text-foreground/40">–</span>
                  <input type="number" step="0.1" placeholder="Max MP" value={megapixelsTo ?? ''} onChange={e => setMegapixelsTo(e.target.value ? Number(e.target.value) : undefined)} className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground w-28 focus:outline-none focus:ring-2 focus:ring-primary/40" />
                </div>
              )}
              {overflowModalGroup === 'fileSize' && (
                <div className="flex items-center gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-foreground/60">Min (MB)</label>
                    <input type="number" step="0.1" placeholder="e.g. 1" value={sizeFromMB ?? ''} onChange={e => setSizeFromMB(e.target.value ? Number(e.target.value) : undefined)} className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground w-28 focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  </div>
                  <span className="text-foreground/40 mt-5">–</span>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-foreground/60">Max (MB)</label>
                    <input type="number" step="0.1" placeholder="e.g. 50" value={sizeToMB ?? ''} onChange={e => setSizeToMB(e.target.value ? Number(e.target.value) : undefined)} className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground w-28 focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  </div>
                </div>
              )}
              {overflowModalGroup === 'destination' && (
                <div className="flex flex-wrap gap-2">
                  {(!filterOptions?.destinations || filterOptions.destinations.length === 0) ? (
                    <p className="text-sm text-muted-foreground italic">No destinations indexed</p>
                  ) : (
                    filterOptions.destinations.map(dest => {
                      const available = destinationAvailability[dest] !== false;
                      const isActive = selectedDestination.includes(dest);
                      return (
                        <button key={dest} onClick={() => toggleFilter(selectedDestination, setSelectedDestination, dest)}
                          className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all ${isActive ? 'text-primary border-primary/50 bg-primary/10 font-medium' : 'border-border text-foreground/70 hover:bg-secondary'}`}>
                          {available ? <FolderOpen className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />}
                          {dest}
                          {!available && <span className="text-[10px] text-amber-500 font-medium">(Unavailable)</span>}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
            <div className="mt-4 pt-3 border-t border-border flex justify-end">
              <button onClick={() => setOverflowModalGroup(null)} className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Customise Favourites Modal */}
      {showCustomise && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowCustomise(false)}>
          <div className="bg-background border border-border rounded-2xl shadow-2xl p-6 w-[420px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-foreground">Customise Favourites</h3>
              <button onClick={() => setShowCustomise(false)} className="p-1 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Select up to {MAX_FAVOURITE_GROUPS} filter groups for your Favourites tab. You can also click the <Star className="w-3 h-3 inline text-amber-500" /> star on any filter group label.
            </p>
            <p className="text-xs text-muted-foreground mb-3">{favouriteGroups.length} / {MAX_FAVOURITE_GROUPS} selected</p>
            {/* Group by tab category */}
            {([
              { tab: 'filters', label: 'Filters' },
              { tab: 'camera', label: 'Camera' },
              { tab: 'exposure', label: 'Exposure' },
            ] as { tab: Exclude<RibbonTab, 'favourites'>; label: string }[]).map(cat => (
              <div key={cat.tab} className="mb-3">
                <h4 className="text-xs font-semibold text-foreground/50 uppercase tracking-wider mb-1 px-3">{cat.label}</h4>
                <div className="space-y-0.5">
                  {allFilterGroups.filter(g => tabGroups[cat.tab].includes(g.id)).map(group => (
                    <label key={group.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-secondary/50 cursor-pointer transition-colors">
                      <button onClick={(e) => { e.preventDefault(); toggleFavouriteGroup(group.id); }}
                        className={`transition-colors ${favouriteGroups.includes(group.id) ? 'text-amber-500' : 'text-foreground/20 hover:text-amber-400'}`}
                        disabled={!favouriteGroups.includes(group.id) && favouriteGroups.length >= MAX_FAVOURITE_GROUPS}>
                        <Star className={`w-4 h-4 ${favouriteGroups.includes(group.id) ? 'fill-amber-500' : ''}`} />
                      </button>
                      <span className="text-sm text-foreground font-medium">{group.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <div className="mt-4 pt-3 border-t border-border flex justify-between">
              <button onClick={() => { setFavouriteGroups([]); localStorage.setItem('pdr-ribbon-fav-groups', JSON.stringify([])); }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors">Clear all favourites</button>
              <button onClick={() => setShowCustomise(false)} className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">Done</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ AI DISCOVERY BANNER — shown when AI is off but user has indexed files ═══ */}
      {!aiEnabled && !aiPromptDismissed && stats && stats.totalFiles > 0 && (
        <div className="mx-4 mt-3 mb-1 p-4 rounded-xl border-2 border-violet-300 dark:border-violet-600 bg-gradient-to-r from-violet-50 to-purple-50 dark:from-violet-950/30 dark:to-purple-950/20 flex items-center gap-3 shadow-sm animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="w-10 h-10 rounded-full bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center shrink-0">
            <Sparkles className="w-5 h-5 text-violet-600 dark:text-violet-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-violet-900 dark:text-violet-200">
              AI Photo Analysis available
            </p>
            <p className="text-xs text-violet-700/80 dark:text-violet-300/70 mt-0.5 leading-relaxed">
              Detect faces, identify people, and auto-tag your {stats.totalFiles.toLocaleString()} indexed photos. Everything runs locally on your device — your photos are never uploaded, shared, or sent anywhere. A one-time ~300 MB model download is required, then fully offline. No re-fixing needed.
            </p>
          </div>
          <button
            onClick={async () => {
              setAiEnabled(true);
              await setSetting('aiEnabled', true);
              loadAiData();
            }}
            className="shrink-0 px-5 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold transition-colors flex items-center gap-2 shadow-md"
          >
            <Sparkles className="w-4 h-4" />
            Enable AI
          </button>
          <button
            onClick={() => { setAiPromptDismissed(true); localStorage.setItem('pdr-ai-prompt-dismissed', 'true'); }}
            className="shrink-0 p-1.5 rounded-lg hover:bg-violet-200/50 dark:hover:bg-violet-800/30 text-violet-400 hover:text-violet-600 dark:hover:text-violet-300 transition-colors"
            title="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ═══ Unavailable drive banner ═══ */}
      {unavailableFileMessage && (
        <div className="mx-4 mt-2 flex items-center gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-700 animate-in fade-in slide-in-from-top-2 duration-200">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
          <p className="text-sm text-amber-800 dark:text-amber-200 flex-1">{unavailableFileMessage}</p>
          <button onClick={() => setUnavailableFileMessage(null)} className="p-1 rounded hover:bg-amber-200/50 dark:hover:bg-amber-800/50 transition-colors">
            <X className="w-4 h-4 text-amber-600 dark:text-amber-400" />
          </button>
        </div>
      )}

      {/* ═══ RESULTS AREA (below ribbon, above workspace) ═══ */}
      {searchActive && results && (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Results count bar */}
          <div className="px-4 py-2 border-b border-border flex items-center justify-between shrink-0 bg-secondary/20">
            <span className="text-sm font-semibold text-foreground flex items-center gap-2">
              {results.total.toLocaleString()} {results.total === 1 ? 'result' : 'results'}
              {selectedFiles.size > 0 && (
                <>
                  <span className="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                    {selectedFiles.size} selected
                  </span>
                  <button
                    onClick={() => {
                      const selectedPhotos = results.files.filter(f => selectedFiles.has(f.id) && f.file_type === 'photo');
                      if (selectedPhotos.length > 0) {
                        const filePaths = selectedPhotos.map(f => f.file_path);
                        const fileNames = selectedPhotos.map(f => f.filename);
                        safeOpenViewer(filePaths, fileNames);
                      }
                    }}
                    className="text-xs font-medium text-white bg-primary hover:bg-primary/90 px-3 py-1 rounded-full flex items-center gap-1.5 transition-colors"
                  >
                    <Eye className="w-3 h-3" />
                    Open {results.files.filter(f => selectedFiles.has(f.id) && f.file_type === 'photo').length} in Viewer
                  </button>
                  <button
                    onClick={() => setSelectedFiles(new Set())}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Clear
                  </button>
                </>
              )}
              {isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin inline ml-2 text-primary" />}
            </span>
            <div className="flex items-center gap-3">
              {selectedFile && <span className="text-xs text-muted-foreground font-medium">← → navigate{selectedFiles.size > 0 ? ' checked' : ''} · Enter view · Esc close</span>}
              {/* View mode buttons */}
              <div className="flex items-center border border-border rounded-lg overflow-hidden">
                <button onClick={() => setViewMode('grid')}
                  className={`p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`}
                  title="Large Icons">
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setViewMode('list')}
                  className={`p-1.5 transition-colors border-x border-border ${viewMode === 'list' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`}
                  title="List">
                  <List className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setViewMode('details')}
                  className={`p-1.5 transition-colors ${viewMode === 'details' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`}
                  title="Details">
                  <Table2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <button onClick={() => setShowPreviewPanel(!showPreviewPanel)}
                className={`p-1 rounded-lg transition-colors ${showPreviewPanel ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`}
                title={showPreviewPanel ? 'Hide preview' : 'Show preview'}>
                {showPreviewPanel ? <PanelRightClose className="w-3.5 h-3.5" /> : <PanelRightOpen className="w-3.5 h-3.5" />}
              </button>
              <button onClick={clearFilters} className="px-2 py-0.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-all">
                Close
              </button>
            </div>
          </div>

          {/* Grid/List/Details + Preview */}
          {results.files.length > 0 ? (
            <ResizablePanelGroup direction="horizontal" className="flex-1">
              <ResizablePanel defaultSize={selectedFile && showPreviewPanel ? 65 : 100} minSize={40}>
                <div ref={gridContainerRef} className="h-full overflow-y-auto p-4 select-none">
                  {/* ── Grid View (Large Icons) ── */}
                  {viewMode === 'grid' && (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
                      {results.files.map((file, idx) => (
                        <FileCard key={file.id} file={file} thumbnail={thumbnails[file.file_path]}
                          isSelected={selectedFile?.id === file.id}
                          isMultiSelected={selectedFiles.has(file.id)}
                          onCheckboxClick={() => {
                            // Checkbox click — toggle without needing CTRL
                            const wasChecked = selectedFiles.has(file.id);
                            setSelectedFiles(prev => {
                              const next = new Set(prev);
                              if (next.has(file.id)) next.delete(file.id); else next.add(file.id);
                              return next;
                            });
                            // Show the checked file in detail panel
                            if (!wasChecked) setSelectedFile(file);
                            lastClickedIndexRef.current = idx;
                          }}
                          onClick={(e: React.MouseEvent) => {
                            if (e.ctrlKey || e.metaKey) {
                              // CTRL+click — toggle individual selection
                              const wasChecked = selectedFiles.has(file.id);
                              setSelectedFiles(prev => {
                                const next = new Set(prev);
                                if (next.has(file.id)) next.delete(file.id); else next.add(file.id);
                                return next;
                              });
                              if (!wasChecked) setSelectedFile(file);
                              lastClickedIndexRef.current = idx;
                            } else if (e.shiftKey && lastClickedIndexRef.current !== null) {
                              // Shift+click — range selection
                              e.preventDefault();
                              const start = Math.min(lastClickedIndexRef.current, idx);
                              const end = Math.max(lastClickedIndexRef.current, idx);
                              setSelectedFiles(prev => {
                                const next = new Set(prev);
                                for (let i = start; i <= end; i++) {
                                  if (results.files[i]) next.add(results.files[i].id);
                                }
                                return next;
                              });
                              setSelectedFile(file);
                            } else {
                              // Normal click — single select for detail panel, clear multi-select
                              setSelectedFile(file);
                              setSelectedFiles(new Set());
                              lastClickedIndexRef.current = idx;
                            }
                          }}
                          onDoubleClick={file.file_type === 'photo' ? () => safeOpenViewer(file.file_path, file.filename) : undefined} />
                      ))}
                    </div>
                  )}

                  {/* ── List View ── */}
                  {viewMode === 'list' && (
                    <div className="space-y-0.5">
                      {results.files.map(file => {
                        return (
                          <div key={file.id} data-file-id={file.id}
                            onClick={() => setSelectedFile(file)}
                            onDoubleClick={file.file_type === 'photo' ? () => safeOpenViewer(file.file_path, file.filename) : undefined}
                            className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${selectedFile?.id === file.id ? 'bg-primary/10 border border-primary/30' : 'hover:bg-secondary/50'}`}>
                            <div className="w-10 h-10 rounded-lg bg-secondary/40 overflow-hidden shrink-0 flex items-center justify-center">
                              {thumbnails[file.file_path]
                                ? <img src={thumbnails[file.file_path]} alt="" className="w-full h-full object-cover" />
                                : file.file_type === 'video' ? <Film className="w-5 h-5 text-muted-foreground/40" /> : <ImageIcon className="w-5 h-5 text-muted-foreground/40" />}
                            </div>
                            <span className="text-sm text-foreground truncate flex-1 min-w-0">{file.filename}</span>
                            <span className="text-xs text-muted-foreground shrink-0">{file.derived_date ? new Date(file.derived_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* ── Details View (Table) ── */}
                  {viewMode === 'details' && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border text-left">
                            <th className="py-2 px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-8"></th>
                            <th className="py-2 px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Name</th>
                            <th className="py-2 px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Date</th>
                            <th className="py-2 px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Type</th>
                            <th className="py-2 px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Size</th>
                            <th className="py-2 px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Camera</th>
                            <th className="py-2 px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Confidence</th>
                          </tr>
                        </thead>
                        <tbody>
                          {results.files.map(file => {
                            const confidenceColor = file.confidence === 'confirmed' ? 'text-green-600' : file.confidence === 'recovered' ? 'text-amber-600' : 'text-red-500';
                            return (
                              <tr key={file.id} data-file-id={file.id}
                                onClick={() => setSelectedFile(file)}
                                onDoubleClick={file.file_type === 'photo' ? () => safeOpenViewer(file.file_path, file.filename) : undefined}
                                className={`cursor-pointer transition-colors border-b border-border/50 ${selectedFile?.id === file.id ? 'bg-primary/10' : 'hover:bg-secondary/30'}`}>
                                <td className="py-1.5 px-2">
                                  <div className="w-6 h-6 rounded bg-secondary/40 overflow-hidden flex items-center justify-center">
                                    {thumbnails[file.file_path]
                                      ? <img src={thumbnails[file.file_path]} alt="" className="w-full h-full object-cover" />
                                      : file.file_type === 'video' ? <Film className="w-3 h-3 text-muted-foreground/40" /> : <ImageIcon className="w-3 h-3 text-muted-foreground/40" />}
                                  </div>
                                </td>
                                <td className="py-1.5 px-2 text-foreground truncate max-w-[250px]">{file.filename}</td>
                                <td className="py-1.5 px-2 text-muted-foreground whitespace-nowrap">{file.derived_date ? new Date(file.derived_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</td>
                                <td className="py-1.5 px-2 text-muted-foreground uppercase">{file.extension.replace('.', '')}</td>
                                <td className="py-1.5 px-2 text-muted-foreground whitespace-nowrap">{file.size_bytes ? (file.size_bytes / (1024*1024)).toFixed(1) + ' MB' : '—'}</td>
                                <td className="py-1.5 px-2 text-muted-foreground truncate max-w-[150px]">{[file.camera_make, file.camera_model].filter(Boolean).join(' ') || '—'}</td>
                                <td className={`py-1.5 px-2 font-medium capitalize ${confidenceColor}`}>{file.confidence}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {results.files.length < results.total && (
                    <div className="flex justify-center py-6">
                      <button onClick={loadMore} disabled={isLoading}
                        className="px-5 py-2 rounded-xl border border-border text-sm text-muted-foreground hover:text-foreground hover:border-primary/30 transition-all disabled:opacity-50">
                        {isLoading ? <><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading...</> : `Load more (${results.files.length} of ${results.total.toLocaleString()})`}
                      </button>
                    </div>
                  )}
                </div>
              </ResizablePanel>
              {selectedFile && showPreviewPanel && (() => {
                const navFiles = getNavigableFiles();
                const navIdx = navFiles.findIndex(f => f.id === selectedFile.id);
                const hasPrev = navIdx > 0;
                const hasNext = navIdx < navFiles.length - 1;
                // When checked files exist, "Open in Viewer" opens all checked; otherwise just current
                const viewerFiles = selectedFiles.size > 0
                  ? navFiles.filter(f => f.file_type === 'photo')
                  : [selectedFile];
                return (
                  <>
                    <ResizableHandle withHandle />
                    <ResizablePanel defaultSize={35} minSize={25} maxSize={55}>
                      <FileDetailPanel file={selectedFile} thumbnail={thumbnails[selectedFile.file_path]}
                        onClose={() => setSelectedFile(null)}
                        onPrev={hasPrev ? () => navigateFile('prev') : undefined}
                        onNext={hasNext ? () => navigateFile('next') : undefined}
                        onOpenInExplorer={() => openInExplorer(selectedFile.file_path)}
                        onOpenViewer={() => {
                          if (viewerFiles.length > 1) {
                            safeOpenViewer(viewerFiles.map(f => f.file_path), viewerFiles.map(f => f.filename));
                          } else {
                            safeOpenViewer(selectedFile.file_path, selectedFile.filename);
                          }
                        }}
                        fileIndex={navIdx + 1} totalFiles={navFiles.length}
                        isShowingChecked={selectedFiles.size > 0} />
                    </ResizablePanel>
                  </>
                );
              })()}
            </ResizablePanelGroup>
          ) : (
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="text-center max-w-sm">
                <Search className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
                <h3 className="text-base font-semibold text-foreground mb-1">No matches</h3>
                <p className="text-sm text-muted-foreground">Try adjusting your search or filters.</p>
                <button onClick={clearFilters} className="mt-3 text-sm text-primary hover:text-primary/80 transition-colors">Clear all filters</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Index Manager Modal */}
      {showIndexManager && (
        <IndexManagerModal onClose={() => setShowIndexManager(false)} onRefresh={async () => { await loadFilterOptions(); await loadStats(); if (searchActive) executeSearch(); }} stats={stats} />
      )}
    </>
  );
}

// ─── Ribbon layout helpers ──────────────────────────────────────────────────

function RibbonGroup({ label, children, onExpand, groupId, isFavourited, onToggleFavourite }: {
  label: string; children: React.ReactNode; onExpand?: () => void;
  groupId?: string; isFavourited?: boolean; onToggleFavourite?: (id: string) => void;
}) {
  return (
    <div className="flex flex-col justify-between px-2.5 min-w-0 shrink-0">
      <div className="flex items-center flex-1">{children}</div>
      <div className="flex items-center justify-center gap-1 border-t mt-0.5 pt-0.5 pb-0.5 ribbon-group-border">
        {groupId && onToggleFavourite && (
          <button onClick={() => onToggleFavourite(groupId)}
            className={`p-0 leading-none transition-colors ${isFavourited ? 'text-amber-500 hover:text-amber-400' : 'text-foreground/25 hover:text-amber-400'}`}
            title={isFavourited ? 'Remove from Favourites' : 'Add to Favourites'}>
            <Star className={`w-2.5 h-2.5 ${isFavourited ? 'fill-amber-500' : ''}`} />
          </button>
        )}
        <span className="text-[10px] text-foreground/60 text-center font-semibold uppercase tracking-wider">{label}</span>
        {onExpand && (
          <button onClick={onExpand} className="p-0 leading-none text-foreground/40 hover:text-foreground/70 transition-colors" title={`Open ${label} panel`}>
            <ExternalLink className="w-2.5 h-2.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function RibbonSeparator() {
  return <div className="w-px mx-1 my-1 shrink-0 ribbon-separator" />;
}

// ─── Filter Dropdown ─────────────────────────────────────────────────────────

function FilterDropdown({ label, active, activeLabel, children }: { label: string; active: boolean; activeLabel?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 px-2 py-1 rounded-md border text-[12px] transition-all ${
          active ? 'border-primary/50 bg-primary/10 text-primary font-medium' : 'border-border text-foreground hover:border-primary/30 hover:text-primary'
        }`}>
        {activeLabel ? <span className="max-w-[100px] truncate">{activeLabel}</span> : label}
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 min-w-[200px] bg-background border border-border rounded-xl shadow-lg z-50 p-2 space-y-0.5">
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Filter Checkbox ─────────────────────────────────────────────────────────

function FilterCheckbox({ label, checked, onChange, color, icon }: { label: string; checked: boolean; onChange: () => void; color?: string; icon?: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-primary/5 cursor-pointer transition-colors">
      <input type="checkbox" checked={checked} onChange={onChange} className="w-4 h-4 rounded border-border text-primary focus:ring-primary/30 accent-primary cursor-pointer" />
      {icon && <span className="shrink-0">{icon}</span>}
      <span className={`text-sm flex-1 truncate ${color || 'text-foreground'} ${checked ? 'font-medium' : ''}`}>{label}</span>
    </label>
  );
}

// ─── File Card ───────────────────────────────────────────────────────────────

function FileCard({ file, thumbnail, isSelected, isMultiSelected, onClick, onCheckboxClick, onDoubleClick }: { file: IndexedFile; thumbnail?: string; isSelected: boolean; isMultiSelected?: boolean; onClick: (e: React.MouseEvent) => void; onCheckboxClick?: () => void; onDoubleClick?: () => void }) {
  const highlighted = isSelected || isMultiSelected;
  return (
    <div data-file-id={file.id} onClick={onClick} onDoubleClick={onDoubleClick}
      className={`group rounded-xl border cursor-pointer transition-all duration-200 overflow-hidden ${highlighted ? 'border-primary ring-2 ring-primary/20 shadow-lg' : 'border-border hover:border-primary/40 hover:shadow-md'}`}>
      <div className="aspect-square bg-secondary/30 relative overflow-hidden">
        {thumbnail ? <img src={thumbnail} alt={file.filename} className="w-full h-full object-cover" loading="lazy" draggable={false} /> : (
          <div className="w-full h-full flex items-center justify-center">{file.file_type === 'video' ? <Film className="w-10 h-10 text-muted-foreground/30" /> : <ImageIcon className="w-10 h-10 text-muted-foreground/30" />}</div>
        )}
        {/* Multi-select checkbox — clickable without CTRL */}
        <div
          onClick={(e) => { e.stopPropagation(); onCheckboxClick?.(); }}
          className={`absolute top-2 left-2 w-6 h-6 rounded border-2 flex items-center justify-center transition-all cursor-pointer hover:scale-110 ${
          isMultiSelected
            ? 'bg-primary border-primary text-white'
            : 'border-white/60 bg-black/30 text-transparent opacity-0 group-hover:opacity-100 hover:border-white hover:bg-black/50'
        }`}>
          {isMultiSelected && <svg className="w-3.5 h-3.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 6l3 3 5-5" /></svg>}
        </div>
        {file.file_type === 'video' && <div className="absolute bottom-2 left-2 px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] font-medium flex items-center gap-1"><Film className="w-3 h-3" /> Video</div>}
        {file.file_type === 'photo' && onDoubleClick && !isMultiSelected && (
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
            <div className="p-2 rounded-full bg-black/50 text-white/90"><Maximize2 className="w-4 h-4" /></div>
          </div>
        )}
      </div>
      <div className="p-2.5">
        <p className="text-xs font-medium text-foreground truncate" title={file.filename}>{file.filename}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">{file.derived_date ? formatDate(file.derived_date) : 'No date'}{file.size_bytes > 0 && ` · ${formatBytes(file.size_bytes)}`}</p>
        {file.camera_model && <p className="text-[10px] text-muted-foreground mt-0.5 truncate flex items-center gap-1"><Camera className="w-2.5 h-2.5" /> {file.camera_model}</p>}
      </div>
    </div>
  );
}

// ─── File Detail Panel ───────────────────────────────────────────────────────

function FileDetailPanel({ file, thumbnail, onClose, onPrev, onNext, onOpenInExplorer, onOpenViewer, fileIndex, totalFiles, isShowingChecked }: {
  file: IndexedFile; thumbnail?: string; onClose: () => void; onPrev?: () => void; onNext?: () => void; onOpenInExplorer?: () => void; onOpenViewer?: () => void; fileIndex?: number; totalFiles?: number; isShowingChecked?: boolean;
}) {
  const [fullThumbnail, setFullThumbnail] = useState<string | null>(null);
  const [fileTags, setFileTags] = useState<AiTagRecord[]>([]);
  const [fileFaces, setFileFaces] = useState<FaceRecord[]>([]);

  useEffect(() => {
    const loadFull = async () => { const r = await getThumbnail(file.file_path, 400); if (r.success && r.dataUrl) setFullThumbnail(r.dataUrl); };
    if (file.file_type === 'photo') loadFull();
    // Load AI data for this file
    getAiFileTags(file.id).then(r => { if (r.success && r.data) setFileTags(r.data); else setFileTags([]); });
    getAiFaces(file.id).then(r => { if (r.success && r.data) setFileFaces(r.data); else setFileFaces([]); });
    return () => { setFullThumbnail(null); setFileTags([]); setFileFaces([]); };
  }, [file.file_path, file.id]);

  const confidenceLabel = file.confidence === 'confirmed'
    ? { text: 'Confirmed', color: 'text-green-600 bg-green-50 dark:text-green-400 dark:bg-green-900/30', icon: <CheckCircle2 className="w-3.5 h-3.5" /> }
    : file.confidence === 'recovered'
      ? { text: 'Recovered', color: 'text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-900/30', icon: <AlertTriangle className="w-3.5 h-3.5" /> }
      : { text: 'Marked', color: 'text-red-500 bg-red-50 dark:text-red-400 dark:bg-red-900/30', icon: <HelpCircle className="w-3.5 h-3.5" /> };

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold text-foreground mr-1">Details</h3>
            {fileIndex != null && totalFiles != null && (
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${isShowingChecked ? 'text-primary bg-primary/10' : 'text-muted-foreground'}`}>
                {fileIndex} of {totalFiles.toLocaleString()}{isShowingChecked ? ' checked' : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <button onClick={onPrev} disabled={!onPrev}
              className={`p-1.5 rounded-lg transition-colors ${onPrev ? 'hover:bg-secondary/50 text-muted-foreground hover:text-foreground cursor-pointer' : 'text-muted-foreground/30 cursor-default'}`}
              title="Previous (←)"><ArrowLeft className="w-4 h-4" /></button>
            <button onClick={onNext} disabled={!onNext}
              className={`p-1.5 rounded-lg transition-colors ${onNext ? 'hover:bg-secondary/50 text-muted-foreground hover:text-foreground cursor-pointer' : 'text-muted-foreground/30 cursor-default'}`}
              title="Next (→)"><ArrowRight className="w-4 h-4" /></button>
            {onOpenInExplorer && <button onClick={onOpenInExplorer} className="p-1.5 rounded-lg hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors" title="Open in Explorer"><ExternalLink className="w-4 h-4" /></button>}
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors" title="Close (Esc)"><X className="w-4 h-4" /></button>
          </div>
        </div>
        {/* Preview image with overlay navigation arrows */}
        <div className="rounded-xl overflow-hidden bg-secondary/30 mb-4 aspect-square relative group">
          {(fullThumbnail || thumbnail) ? <img src={fullThumbnail || thumbnail} alt={file.filename} className="w-full h-full object-contain" /> : (
            <div className="w-full h-full flex items-center justify-center">{file.file_type === 'video' ? <Film className="w-16 h-16 text-muted-foreground/20" /> : <ImageIcon className="w-16 h-16 text-muted-foreground/20" />}</div>
          )}
          {/* Overlay prev/next arrows on the image */}
          {onPrev && (
            <button onClick={onPrev} className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/40 hover:bg-black/60 text-white/80 hover:text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all" title="Previous (←)">
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          {onNext && (
            <button onClick={onNext} className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/40 hover:bg-black/60 text-white/80 hover:text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all" title="Next (→)">
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
        {(onOpenViewer || onOpenInExplorer) && (
          <div className="flex gap-2 mb-4">
            {onOpenViewer && file.file_type === 'photo' && (
              <button onClick={onOpenViewer} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-primary/30 text-xs font-medium text-primary hover:bg-primary/5 hover:border-primary/50 transition-all">
                <Eye className="w-3.5 h-3.5" />{isShowingChecked && totalFiles && totalFiles > 1 ? `Open ${totalFiles} in Viewer` : 'Open in Viewer'}
              </button>
            )}
            {onOpenInExplorer && <button onClick={onOpenInExplorer} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:border-primary/30 transition-all"><FolderOpen className="w-3.5 h-3.5" />Show in Folder</button>}
          </div>
        )}
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-background z-10">
            <tr className="border-b border-border">
              <th className="text-left text-[10px] text-muted-foreground uppercase font-semibold py-1.5 pr-3 w-[110px] min-w-[110px] max-w-[110px] border-r border-border/20">Field</th>
              <th className="text-left text-[10px] text-muted-foreground uppercase font-semibold py-1.5 pl-3">Value</th>
            </tr>
          </thead>
          <tbody>
            <DetailRow label="Filename" value={file.filename} />
            <DetailRow label="Original Name" value={file.original_filename || '—'} />
            <DetailRow label="Date" value={file.derived_date ? formatDate(file.derived_date) : '—'} />
            <tr className="border-b border-border/30">
              <td className="py-1.5 pr-3 text-[11px] text-muted-foreground uppercase font-semibold whitespace-nowrap align-top w-[110px] min-w-[110px] max-w-[110px] border-r border-border/20">Confidence</td>
              <td className="py-1.5 pl-3"><span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-xs font-medium ${confidenceLabel.color}`}>{confidenceLabel.icon}{confidenceLabel.text}</span></td>
            </tr>
            <DetailRow label="Date Source" value={file.date_source || '—'} />
            <DetailRow label="Type" value={file.file_type === 'photo' ? 'Photo' : 'Video'} />
            <DetailRow label="Extension" value={file.extension.toUpperCase()} />
            <DetailRow label="Size" value={file.size_bytes > 0 ? formatBytes(file.size_bytes) : '—'} />
            {file.width && file.height && <DetailRow label="Dimensions" value={`${file.width} × ${file.height}${file.megapixels ? ` (${file.megapixels} MP)` : ''}`} />}
          </tbody>
        </table>

        {/* Camera section — collapsed by default */}
        {(file.camera_make || file.camera_model || file.lens_model) && (
          <details className="border-t border-border/50 mt-2">
            <summary className="flex items-center gap-1.5 cursor-pointer py-2 text-[11px] text-muted-foreground uppercase font-semibold hover:text-foreground transition-colors select-none">
              <Camera className="w-3 h-3" /> Camera
            </summary>
            <table className="w-full border-collapse mb-1">
              <tbody>
                {file.camera_make && <DetailRow label="Make" value={file.camera_make} />}
                {file.camera_model && <DetailRow label="Model" value={file.camera_model} />}
                {file.lens_model && <DetailRow label="Lens" value={file.lens_model} />}
              </tbody>
            </table>
          </details>
        )}

        {/* Exposure section — collapsed by default */}
        {(file.iso || file.shutter_speed || file.aperture || file.focal_length) && (
          <details className="border-t border-border/50">
            <summary className="flex items-center gap-1.5 cursor-pointer py-2 text-[11px] text-muted-foreground uppercase font-semibold hover:text-foreground transition-colors select-none">
              Exposure
            </summary>
            <table className="w-full border-collapse mb-1">
              <tbody>
                {file.iso != null && <DetailRow label="ISO" value={String(file.iso)} />}
                {file.shutter_speed && <DetailRow label="Shutter" value={file.shutter_speed} />}
                {file.aperture != null && <DetailRow label="Aperture" value={`f/${file.aperture}`} />}
                {file.focal_length != null && <DetailRow label="Focal Length" value={`${file.focal_length}mm`} />}
                {file.flash_fired != null && <DetailRow label="Flash" value={file.flash_fired ? 'Fired' : 'No flash'} />}
              </tbody>
            </table>
          </details>
        )}

        {/* Location section — collapsed by default */}
        {file.gps_lat != null && file.gps_lon != null && (
          <details className="border-t border-border/50">
            <summary className="flex items-center gap-1.5 cursor-pointer py-2 text-[11px] text-muted-foreground uppercase font-semibold hover:text-foreground transition-colors select-none">
              <MapPin className="w-3 h-3" /> Location
            </summary>
            <table className="w-full border-collapse mb-1">
              <tbody>
                <DetailRow label="Latitude" value={file.gps_lat.toFixed(6)} />
                <DetailRow label="Longitude" value={file.gps_lon.toFixed(6)} />
                {file.gps_alt != null && <DetailRow label="Altitude" value={`${file.gps_alt.toFixed(1)}m`} />}
              </tbody>
            </table>
          </details>
        )}

        {/* AI Tags section */}
        {fileTags.length > 0 && (
          <details className="border-t border-border/50" open>
            <summary className="flex items-center gap-1.5 cursor-pointer py-2 text-[11px] text-muted-foreground uppercase font-semibold hover:text-foreground transition-colors select-none">
              <Sparkles className="w-3 h-3 text-purple-400" /> AI Tags
            </summary>
            <div className="flex flex-wrap gap-1.5 pb-2">
              {fileTags.map((t, i) => (
                <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
                  <Tag className="w-2.5 h-2.5" />{t.tag}
                  <span className="text-[8px] text-purple-400/60">{Math.round(t.confidence * 100)}%</span>
                </span>
              ))}
            </div>
          </details>
        )}

        {/* AI Faces section */}
        {fileFaces.length > 0 && (
          <details className="border-t border-border/50">
            <summary className="flex items-center gap-1.5 cursor-pointer py-2 text-[11px] text-muted-foreground uppercase font-semibold hover:text-foreground transition-colors select-none">
              <Users className="w-3 h-3" /> People ({fileFaces.length})
            </summary>
            <div className="space-y-1 pb-2">
              {fileFaces.map((face, i) => (
                <div key={i} className="flex items-center gap-2 px-1 py-0.5 rounded text-xs">
                  <div className="w-5 h-5 rounded-full bg-purple-500/20 flex items-center justify-center">
                    <Users className="w-3 h-3 text-purple-400" />
                  </div>
                  <span className={face.person_name ? 'text-foreground font-medium' : 'text-muted-foreground italic'}>
                    {face.person_name || 'Unknown person'}
                  </span>
                  <span className="text-[9px] text-muted-foreground ml-auto">{Math.round(face.confidence * 100)}%</span>
                </div>
              ))}
            </div>
          </details>
        )}

        {/* Path — always visible */}
        <div className="border-t border-border/50 pt-2 mt-1">
          <table className="w-full border-collapse">
            <tbody>
              <tr>
                <td className="py-1.5 pr-3 text-[11px] text-muted-foreground uppercase font-semibold whitespace-nowrap align-top w-[110px] min-w-[110px] max-w-[110px] border-r border-border/20">Path</td>
                <td className="py-1.5 pl-3 text-xs text-muted-foreground break-all leading-relaxed">{file.file_path}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Index Manager Modal ─────────────────────────────────────────────────────

function IndexManagerModal({ onClose, onRefresh, stats }: { onClose: () => void; onRefresh: () => void; stats: IndexStats | null }) {
  const [runs, setRuns] = useState<IndexedRun[]>([]);
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [isIndexingRun, setIsIndexingRun] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [selectedReports, setSelectedReports] = useState<Set<string>>(new Set());
  const [confirmDeleteLive, setConfirmDeleteLive] = useState<string[] | null>(null); // report IDs pending confirmation
  const [allowIndexRemoval] = useState(localStorage.getItem('pdr-allow-index-removal') === 'true');
  const [indexProgress, setIndexProgress] = useState<{ phase: string; current: number; total: number; currentFile: string } | null>(null);
  const [indexStartTime, setIndexStartTime] = useState<number | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ currentRun: number; totalRuns: number } | null>(null);

  useEffect(() => { loadData(); }, []);
  const loadData = async () => {
    setIsLoading(true);
    const [runsRes, reportsRes] = await Promise.all([listSearchRuns(), listReports()]);
    if (runsRes.success && runsRes.data) setRuns(runsRes.data);
    if (reportsRes.success && reportsRes.data) setReports(reportsRes.data);
    setIsLoading(false);
    setSelectedReports(new Set());
  };
  const handleRemoveRun = async (runId: number) => { await removeSearchRun(runId); await loadData(); onRefresh(); };

  const startIndexProgressListener = () => {
    setIndexStartTime(Date.now());
    onSearchIndexProgress((progress: any) => {
      setIndexProgress({ phase: progress.phase, current: progress.current, total: progress.total, currentFile: progress.currentFile || '' });
      if (progress.phase === 'complete') {
        setIndexProgress(null);
        setIndexStartTime(null);
      }
    });
  };

  const stopIndexProgressListener = () => {
    removeSearchIndexProgressListener();
    setIndexProgress(null);
    setIndexStartTime(null);
  };

  const handleIndexReport = async (reportId: string) => {
    setIsIndexingRun(reportId);
    startIndexProgressListener();
    await indexFixRunBridge(reportId);
    stopIndexProgressListener();
    setIsIndexingRun(null);
    await loadData();
    onRefresh();
  };

  const [isIndexingBulk, setIsIndexingBulk] = useState(false);
  const handleIndexSelected = async () => {
    const indexableIds = Array.from(selectedReports).filter(id => {
      const r = reports.find(rep => rep.id === id);
      return r && r.destinationExists !== false;
    });
    if (indexableIds.length === 0) return;
    setIsIndexingBulk(true);
    startIndexProgressListener();
    for (let i = 0; i < indexableIds.length; i++) {
      setBulkProgress({ currentRun: i + 1, totalRuns: indexableIds.length });
      setIsIndexingRun(indexableIds[i]);
      await indexFixRunBridge(indexableIds[i]);
    }
    stopIndexProgressListener();
    setBulkProgress(null);
    setIsIndexingRun(null);
    setIsIndexingBulk(false);
    setSelectedReports(new Set());
    await loadData();
    onRefresh();
  };
  const handleDeleteReports = async (reportIds: string[]) => {
    for (const id of reportIds) await deleteReport(id);
    await loadData();
  };
  const handleRebuild = async () => { setIsRebuilding(true); await rebuildSearchIndex(); setRuns([]); setConfirmClear(false); setIsRebuilding(false); onRefresh(); };

  const toggleReportSelection = (id: string) => {
    setSelectedReports(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const requestDeleteSelected = () => {
    const ids = Array.from(selectedReports);
    const liveIds = ids.filter(id => {
      const r = reports.find(rep => rep.id === id);
      return r && r.destinationExists !== false;
    });
    if (liveIds.length > 0) {
      setConfirmDeleteLive(ids);
    } else {
      handleDeleteReports(ids);
    }
  };

  const indexedReportIds = new Set(runs.map(r => r.report_id));
  const unindexedReports = reports.filter(r => !indexedReportIds.has(r.id));

  return (
    <div className="fixed inset-0 bg-black/25 backdrop-blur-[2px] flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-background rounded-2xl shadow-2xl max-w-lg w-full border border-border overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-primary" />
            <h3 className="text-base font-semibold text-foreground">Index Manager</h3>
            <TooltipProvider>
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <div className="cursor-help opacity-40 hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                    <Info className="w-4 h-4 text-muted-foreground" />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start" className="max-w-[360px] p-5 text-sm space-y-3 bg-background text-foreground border border-border shadow-xl rounded-xl">
                  <p className="font-medium">The Index Manager lets you build a searchable index from your completed PDR fix runs, enabling powerful search and filtering across all your dated photos and videos.</p>
                  <div className="border-t border-border pt-3">
                    <p className="font-semibold text-amber-600 dark:text-amber-400 mb-1">Drive not connected</p>
                    <p className="text-muted-foreground leading-relaxed">The drive containing your files is not currently accessible. This could be a USB thumb drive, memory stick, external hard drive, NAS, or a Wi-Fi connected personal cloud device that needs to be reconnected, plugged in, or powered on. Once the drive is available again, the entry will automatically become indexable.</p>
                  </div>
                  <div className="border-t border-border pt-3">
                    <p className="font-semibold text-amber-600 dark:text-amber-400 mb-1">Folder no longer exists</p>
                    <p className="text-muted-foreground leading-relaxed">The drive is connected, but the specific folder cannot be found. This may be because the folder was deleted, renamed, moved to a different location, or reorganised into a different folder structure. If you know where the files are now, you can re-run the fix to generate a new report at the updated location.</p>
                  </div>
                  <div className="border-t border-border pt-3">
                    <p className="font-semibold text-red-500 dark:text-red-400 mb-1">Removing reports</p>
                    <p className="text-muted-foreground leading-relaxed">Removing a report permanently deletes its fix history. The only way to re-index those files is to run the fix again, which for large collections could take considerable time. Reports for missing locations can be safely removed, but be cautious with reports that still have valid paths.</p>
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-6 py-4 max-h-[60vh] overflow-y-auto space-y-5">
          {stats && <div className="grid grid-cols-3 gap-3">
            <StatCard label="Files" value={stats.totalFiles.toLocaleString()} />
            <StatCard label="Photos" value={stats.totalPhotos.toLocaleString()} />
            <StatCard label="Videos" value={stats.totalVideos.toLocaleString()} />
          </div>}

          {/* Indexing progress bar */}
          {(isIndexingRun || isIndexingBulk) && (
            <div className="p-3 rounded-xl border border-primary/30 bg-primary/5">
              <div className="flex items-center gap-2 mb-2">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span className="text-sm font-medium text-foreground">
                  {bulkProgress
                    ? `Indexing run ${bulkProgress.currentRun} of ${bulkProgress.totalRuns}...`
                    : 'Indexing...'}
                </span>
              </div>
              {indexProgress && indexProgress.total > 0 && (
                <>
                  <div className="w-full h-2 rounded-full bg-secondary overflow-hidden mb-1.5">
                    <div
                      className="h-full bg-primary rounded-full transition-all duration-300"
                      style={{ width: `${Math.round((indexProgress.current / indexProgress.total) * 100)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {indexProgress.phase === 'reading-exif' ? 'Reading metadata' : indexProgress.phase === 'inserting' ? 'Saving to index' : indexProgress.phase}
                      {' — '}{indexProgress.current.toLocaleString()} / {indexProgress.total.toLocaleString()} files
                    </span>
                    {indexStartTime && indexProgress.current > 0 && indexProgress.phase === 'reading-exif' && indexProgress.current >= Math.max(10, Math.ceil(indexProgress.total * 0.1)) && (() => {
                      const elapsed = (Date.now() - indexStartTime) / 1000;
                      const rate = indexProgress.current / elapsed;
                      const remaining = rate > 0 ? Math.ceil((indexProgress.total - indexProgress.current) / rate) : 0;
                      if (remaining <= 0) return null;
                      const mins = Math.floor(remaining / 60);
                      const secs = remaining % 60;
                      return <span>{mins > 0 ? `~${mins}m ${secs}s remaining` : `~${secs}s remaining`}</span>;
                    })()}
                  </div>
                </>
              )}
            </div>
          )}

          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Indexed Fixes</h4>
            {isLoading ? <div className="flex items-center gap-2 text-sm text-muted-foreground py-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading...</div>
              : runs.length === 0 ? <p className="text-sm text-muted-foreground py-2">No runs indexed yet.</p>
              : <div className="space-y-2">{runs.map(run => (
                <div key={run.id} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-secondary/20">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{run.destination_path.replace(/\\\\/g, '\\')}</p>
                    <p className="text-xs text-muted-foreground">{run.file_count.toLocaleString()} files · {new Date(run.indexed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}{run.source_labels ? ` · ${run.source_labels}` : ''}</p>
                  </div>
                  {allowIndexRemoval && <button onClick={() => handleRemoveRun(run.id)} className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 text-muted-foreground hover:text-red-500 dark:hover:text-red-400 transition-colors shrink-0" title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>}
                </div>
              ))}</div>}
          </div>
          {unindexedReports.length > 0 && <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Available to Index</h4>
              <div className="flex items-center gap-2">
                {unindexedReports.length > 1 && (
                  <button
                    onClick={() => {
                      if (selectedReports.size === unindexedReports.length) setSelectedReports(new Set());
                      else setSelectedReports(new Set(unindexedReports.map(r => r.id)));
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                    {selectedReports.size === unindexedReports.length ? 'Deselect all' : 'Select all'}
                  </button>
                )}
                {selectedReports.size > 0 && (
                  <>
                    <button onClick={handleIndexSelected} disabled={isIndexingBulk}
                      className="px-2 py-1 rounded-lg border border-primary/30 text-xs font-medium text-primary hover:bg-primary/5 hover:border-primary/50 transition-all disabled:opacity-50">
                      {isIndexingBulk ? <><Loader2 className="w-3 h-3 animate-spin inline mr-1" />Indexing...</> : <>Index {selectedReports.size} selected</>}
                    </button>
                    {allowIndexRemoval && (
                      <button onClick={requestDeleteSelected}
                        className="px-2 py-1 rounded-lg border border-red-200 dark:border-red-800 text-xs font-medium text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 transition-all">
                        Remove {selectedReports.size} selected
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="space-y-2">{unindexedReports.map(report => {
              const exists = report.destinationExists !== false;
              const isSelected = selectedReports.has(report.id);
              return (
                <div key={report.id} className={`flex items-center gap-3 p-3 rounded-xl border bg-background transition-colors ${exists ? 'border-border/50' : 'border-amber-200/50 dark:border-amber-800/30 bg-amber-50/30 dark:bg-amber-900/10'} ${isSelected ? 'ring-1 ring-primary/30' : ''}`}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleReportSelection(report.id)}
                    className="w-3.5 h-3.5 rounded border-border text-primary accent-primary cursor-pointer shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm truncate ${exists ? 'text-foreground' : 'text-muted-foreground'}`}>{report.destinationPath}</p>
                    <p className="text-xs text-muted-foreground">
                      {report.totalFiles.toLocaleString()} files · {new Date(report.timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      {!exists && report.destinationStatus === 'drive-missing' && <span className="ml-1.5 text-amber-600 dark:text-amber-400 font-medium">· Drive not connected</span>}
                      {!exists && report.destinationStatus === 'folder-missing' && <span className="ml-1.5 text-amber-600 dark:text-amber-400 font-medium">· Folder no longer exists</span>}
                      {!exists && !report.destinationStatus && <span className="ml-1.5 text-amber-600 dark:text-amber-400 font-medium">· Location not found</span>}
                    </p>
                  </div>
                  {exists && (
                    <button onClick={() => handleIndexReport(report.id)} disabled={isIndexingRun === report.id || isIndexingBulk}
                      className="px-3 py-1.5 rounded-lg border border-primary/30 text-xs font-medium text-primary hover:bg-primary/5 hover:border-primary/50 transition-all disabled:opacity-50 shrink-0">
                      {isIndexingRun === report.id ? <><Loader2 className="w-3 h-3 animate-spin inline mr-1" />Indexing...</> : <><Plus className="w-3 h-3 inline mr-1" />Index</>}
                    </button>
                  )}
                </div>
              );
            })}</div>

            {/* Confirmation dialog for deleting live reports */}
            {allowIndexRemoval && confirmDeleteLive && (
              <div className="mt-3 p-3 rounded-xl border border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-900/20">
                <p className="text-sm text-red-600 dark:text-red-400 font-medium mb-1">Some selected reports have valid locations</p>
                <p className="text-xs text-muted-foreground mb-3">
                  Removing these reports will permanently delete their fix history. The only way to re-index those files would be to run the fix again, which for large collections could take considerable time. Are you sure?
                </p>
                <div className="flex items-center gap-2">
                  <button onClick={() => { handleDeleteReports(confirmDeleteLive); setConfirmDeleteLive(null); }}
                    className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 transition-all">Remove all {confirmDeleteLive.length} selected</button>
                  <button onClick={() => {
                    // Only delete the ones with missing locations
                    const safeIds = confirmDeleteLive.filter(id => {
                      const r = reports.find(rep => rep.id === id);
                      return r && r.destinationExists === false;
                    });
                    if (safeIds.length > 0) handleDeleteReports(safeIds);
                    setConfirmDeleteLive(null);
                  }}
                    className="px-3 py-1.5 rounded-lg border border-border text-xs text-foreground hover:bg-secondary transition-all">Only remove missing ({confirmDeleteLive.filter(id => { const r = reports.find(rep => rep.id === id); return r && r.destinationExists === false; }).length})</button>
                  <button onClick={() => setConfirmDeleteLive(null)}
                    className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground transition-all">Cancel</button>
                </div>
              </div>
            )}
          </div>}
          {allowIndexRemoval && <div className="border-t border-border pt-4">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Danger Zone</h4>
            {!confirmClear ? (
              <button onClick={() => setConfirmClear(true)} className="px-4 py-2 rounded-xl border border-red-200 dark:border-red-800 text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 hover:border-red-300 dark:hover:border-red-700 transition-all">Clear Entire Index</button>
            ) : (
              <div className="flex items-center gap-3">
                <p className="text-sm text-red-500">Remove all indexed data?</p>
                <button onClick={handleRebuild} disabled={isRebuilding} className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 transition-all disabled:opacity-50 shrink-0">{isRebuilding ? 'Clearing...' : 'Confirm'}</button>
                <button onClick={() => setConfirmClear(false)} className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground transition-all shrink-0">Cancel</button>
              </div>
            )}
          </div>}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return <div className="p-3 rounded-xl border border-border bg-secondary/20 text-center"><p className="text-lg font-semibold text-foreground">{value}</p><p className="text-[10px] text-muted-foreground uppercase font-semibold">{label}</p></div>;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <tr className="border-b border-border/30">
      <td className="py-1.5 pr-3 text-[11px] text-muted-foreground uppercase font-semibold whitespace-nowrap align-top w-[110px] min-w-[110px] max-w-[110px] border-r border-border/20">{label}</td>
      <td className="py-1.5 pl-3 text-sm text-foreground break-words">{value}</td>
    </tr>
  );
}

function formatDate(dateStr: string): string {
  try { const d = new Date(dateStr.replace(' ', 'T')); if (isNaN(d.getTime())) return dateStr; return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return dateStr; }
}
