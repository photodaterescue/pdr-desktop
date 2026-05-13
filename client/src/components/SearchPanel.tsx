import React, { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { isEditDatesEnabled, EDIT_DATES_RELEASED_SHORTLY_MESSAGE } from '@/lib/feature-flags';
import {
  Search,
  X,
  ChevronDown,
  ChevronUp,
  Camera,
  Clapperboard,
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
  Filter,
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
  User,
  Tag,
  Brain,
  Scan,
  Download,
  Copy,
  Pencil,
  Check,
  CheckSquare,
  UserPlus,
  RefreshCw,
  Pause,
  Play,
  Undo2,
  UserX,
  LayoutList,
  Grid3X3,
  ZoomIn,
  Merge,
  ShieldAlert,
  ChevronLeft,
  ChevronRight,
  CalendarRange,
} from 'lucide-react';
import { BrandedDatePicker } from '@/components/ui/branded-date-picker';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import ParallelStructureModal from '@/components/ParallelStructureModal';
import StaleRunsModal from '@/components/StaleRunsModal';
import { SnapshotStatusBadge } from '@/components/SnapshotStatusBadge';
import {
  initSearchDatabase,
  searchFiles,
  getSearchFilterOptions,
  getSearchStats,
  getThumbnail,
  formatBytes,
  isElectron,
  openSearchViewer,
  prepareVideoForPlayback,
  listScannerOverrides,
  setScannerOverride,
  clearScannerOverride,
  checkPathsExist,
  listSearchRuns,
  removeSearchRun,
  rebuildSearchIndex,
  runSearchCleanup,
  onStaleRuns,
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
  checkAiModelsReady,
  getAiStats,
  getAiFileTags,
  getAiFaces,
  listPersons,
  namePerson,
  unnameFace,
  assignFace,
  getClusterFaces,
  getFaceContext,
  getPersonsCooccurrence,
  deletePersonRecord,
  permanentlyDeletePerson,
  restorePerson,
  listDiscardedPersons,
  renamePerson,
  pauseAi,
  resumeAi,
  getVisualSuggestions,
  getClusterFaceCount,
  getAiTagOptions as getAiTagOptionsBridge,
  onAiProgress,
  removeAiProgressListener,
  getSettings,
  setSetting,
  getFaceCrop,
  reclusterFaces,
  getPersonClusters,
  openPeopleWindow,
  openDateEditor,
  onDateEditorDataChanged,
  onPeopleDataChanged,
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
  refineFromVerified,
  redetectFile,
  type FaceRecord,
  type PersonRecord,
  type PersonCluster,
  type DiscardedPerson,
  type ClusterFacesResult,
} from '@/lib/electron-bridge';
import { useFixInProgress, FIX_BLOCKED_TOOLTIP } from '@/lib/fix-state';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';

// ─── Types ───────────────────────────────────────────────────────────────────

type ViewMode = 'grid' | 'list' | 'details';
// Tile size slider: 0..100 in 10% increments, mapped to min-width px
const TILE_SLIDER_MIN = 0;
const TILE_SLIDER_MAX = 100;
const TILE_SLIDER_STEP = 10;
// 0% → 80px tiles, 100% → 360px tiles (linear interpolation)
const TILE_PX_MIN = 80;
const TILE_PX_MAX = 360;
function tileSliderToPx(slider: number): number {
  const clamped = Math.max(TILE_SLIDER_MIN, Math.min(TILE_SLIDER_MAX, slider));
  return Math.round(TILE_PX_MIN + (TILE_PX_MAX - TILE_PX_MIN) * (clamped / 100));
}

interface SearchRibbonProps {
  isIndexing?: boolean;
  indexingProgress?: { current: number; total: number } | null;
  searchDbReady?: boolean;
  zoomLevel?: number;
  isDarkMode?: boolean;
  onToggleDarkMode?: () => void;
  licenseStatusBadge?: React.ReactNode;
  onSearchActiveChange?: (active: boolean) => void;
  showLibraryManager?: boolean;
  requestClose?: boolean;
  hasSources?: boolean;
  /** When set, S&D is in "pick a background photo for Trees" mode.
   *  Renders a banner across the top of results, intercepts the primary
   *  "Use this photo" action per tile, and on confirm/cancel hands back
   *  control via the two callbacks. */
  pickMode?: {
    kind: 'canvas' | 'card';
    treeId: number;
    treeName: string;
    personId?: number;
    personName?: string;
  } | null;
  onPickCancel?: () => void;
  onPickConfirm?: (filePath: string) => void;
}

// ─── Main Search Ribbon Component ────────────────────────────────────────────
// This renders as a collapsible ribbon above workspace content.
// When the user searches or applies filters, results appear below the ribbon
// and the workspace content is hidden. Collapsing the ribbon hides results.

export function SearchRibbon({ isIndexing, indexingProgress, searchDbReady: externalDbReady, zoomLevel = 100, isDarkMode, onToggleDarkMode, licenseStatusBadge, onSearchActiveChange, showLibraryManager = false, requestClose, hasSources, pickMode, onPickCancel, onPickConfirm }: SearchRibbonProps) {
  // Ribbon state
  const [ribbonExpanded, setRibbonExpanded] = useState(true);
  const [searchActive, setSearchActive] = useState(false); // true when results should show
  // True once the user has explicitly asked to see the whole library via the
  // "Show entire library" button. Resets when the S&D view is closed, so
  // every new session starts in the safer empty state and can never
  // accidentally feed the full library into Edit dates. While this is true,
  // clearing every filter shows all photos; while it's false, clearing every
  // filter shows the empty prompt asking the user to pick a filter.
  const [showAllOverride, setShowAllOverride] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('pdr-sd-view-mode') : null;
    if (saved === 'grid' || saved === 'list' || saved === 'details') return saved;
    return 'grid';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('pdr-sd-view-mode', viewMode);
  }, [viewMode]);

  // Tile size slider — only meaningful in grid view
  const [tileSizeSlider, setTileSizeSlider] = useState<number>(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('pdr-sd-tile-size') : null;
    const n = saved ? parseInt(saved, 10) : 40;
    return isFinite(n) ? Math.max(0, Math.min(100, n)) : 40;
  });
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('pdr-sd-tile-size', String(tileSizeSlider));
  }, [tileSizeSlider]);

  // Selection mode — shows checkboxes on tiles. Off by default.
  const [selectionMode, setSelectionMode] = useState<boolean>(false);

  // Which metadata fields to show in each tile's footer — default: none (pure photos, zero gap)
  const [tileMetaFields, setTileMetaFields] = useState<TileMetaField[]>(() => {
    try {
      const saved = typeof window !== 'undefined' ? localStorage.getItem('pdr-sd-tile-meta') : null;
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('pdr-sd-tile-meta', JSON.stringify(tileMetaFields));
  }, [tileMetaFields]);
  const [showMetaDropdown, setShowMetaDropdown] = useState(false);
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

  // Allow parent to close S&D results (e.g. Dashboard click)
  useEffect(() => {
    if (requestClose && searchActive) {
      setSearchActive(false);
      setResults(null);
      setSelectedFile(null);
      setShowAllOverride(false); // Reset the show-all opt-in on every close.
    }
  }, [requestClose]);

  // When the parent puts us in "pick a Trees background" mode, auto-
  // activate the full-library view so the user lands on a thumbnail
  // grid instead of the empty prompt. Clears the selection on each
  // pick-mode entry so a stale selection doesn't accidentally get
  // confirmed.
  useEffect(() => {
    if (pickMode) {
      setSelectedFile(null);
      setSearchActive(true);
      setShowAllOverride(true);
    }
    // deliberately do NOT restore state on pickMode = null — the parent
    // navigates away (back to Trees) so this component unmounts/hides.
  }, [pickMode]);

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
    { id: 'destination', label: 'Library Drive' },
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
  // Parallel store of the actual file objects for every checked item,
  // keyed by file id. Persists across searches so a user can compose a
  // "Custom selection" by ticking 3 photos in one search, switching the
  // search, ticking 3 more, and end up with 6 files retrievable for
  // "Open in Viewer" or "Show N selected" — even though the current
  // search results don't include the originally-checked files.
  const [selectedFilesMap, setSelectedFilesMap] = useState<Map<number, IndexedFile>>(new Map());
  // When true, the grid renders the union of all checked files across
  // all searches (Custom selection mode) instead of the current search
  // results. The filter ribbon visually deactivates while this mode is
  // on so the user understands the grid is no longer driven by the
  // current filter set. Auto-exits when all selections are cleared.
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  // Helper that updates BOTH the id-only Set (used by hot-path
  // membership checks) and the id→file Map (used for cross-search
  // persistence). Every checkbox / Ctrl+click / Shift+range handler
  // funnels through this so the two stores stay in lock-step.
  const toggleFileSelection = useCallback((file: IndexedFile, intent?: 'add' | 'remove') => {
    const action = intent ?? (selectedFiles.has(file.id) ? 'remove' : 'add');
    setSelectedFiles(prev => {
      const next = new Set(prev);
      if (action === 'add') next.add(file.id); else next.delete(file.id);
      return next;
    });
    setSelectedFilesMap(prev => {
      const next = new Map(prev);
      if (action === 'add') next.set(file.id, file); else next.delete(file.id);
      return next;
    });
  }, [selectedFiles]);
  const [showStructureModal, setShowStructureModal] = useState(false);
  // True whenever any window has a Fix in flight. Parallel Structures
  // shares the copy engine + writes to indexed_files, so concurrent
  // runs would deadlock + corrupt run records. Gate accordingly.
  const fixActive = useFixInProgress();
  const [staleRuns, setStaleRuns] = useState<any[]>([]);
  const [showStaleRunsModal, setShowStaleRunsModal] = useState(false);
  const lastClickedIndexRef = useRef<number | null>(null);
  const [showPreviewPanel, setShowPreviewPanel] = useState(true);
  const [showIndexManager, setShowIndexManager] = useState(false);
  // showPeopleManager state removed — People Manager is now a separate BrowserWindow

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
  const [aiModelsReady, setAiModelsReady] = useState(false);
  const [selectedAiTags, setSelectedAiTags] = useState<string[]>([]);

  // People filter dropdown state
  const [showPeopleDropdown, setShowPeopleDropdown] = useState(false);
  const [selectedPersonIds, setSelectedPersonIds] = useState<number[]>([]);
  // When non-null, multi-mode is active — query uses AND logic across selectedPersonIds
  const [multiModeActive, setMultiModeActive] = useState<boolean>(false);
  // Preview count for the Show button (updates as selections change)
  const [peoplePreviewCount, setPeoplePreviewCount] = useState<number | null>(null);

  // S&D Match: AI vs Verified toggle + threshold slider. These are
  // INDEPENDENT of the PM clustering threshold — the slider here drives
  // the S&D-side refine threshold (so "Improve Facial Recognition"
  // honours it) and the toggle gates person filtering on verified=1
  // when set to 'verified'. Loaded once on mount; persisted on change.
  // Tri-state filter — 'matched' = AI auto-matches only (unverified),
  // 'verified' = manually-confirmed only, 'both' = either. The UI
  // label "AI" maps to 'matched' (per Terry's terminology — "AI
  // suggested" is the unconfirmed case). Default 'both' so users
  // see all of a person's photos out of the box.
  const [aiSearchMatchMode, setAiSearchMatchMode] = useState<'matched' | 'verified' | 'both'>('both');
  const [aiSearchMatchThreshold, setAiSearchMatchThreshold] = useState<number>(0.72);
  useEffect(() => {
    getSettings().then((s) => {
      const mode = (s as any)?.aiSearchMatchMode;
      // Migration: legacy 'ai' value → 'both' (its actual meaning was
      // "any AI link" = matched + verified). New users get 'both'
      // by default. 'matched' (auto-only) is the new third state.
      if (mode === 'ai') setAiSearchMatchMode('both');
      else if (mode === 'matched' || mode === 'verified' || mode === 'both') setAiSearchMatchMode(mode);
      const t = (s as any)?.aiSearchMatchThreshold;
      if (typeof t === 'number' && t >= 0.65 && t <= 0.95) setAiSearchMatchThreshold(t);
    });
  }, []);

  // Update preview count whenever person selection or mode changes
  useEffect(() => {
    if (selectedPersonIds.length === 0) {
      setPeoplePreviewCount(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const result = await searchFiles({
        sortBy: 'date' as any,
        sortDir: 'desc' as any,
        limit: 1,
        offset: 0,
        personId: selectedPersonIds,
        personIdMode: multiModeActive ? 'and' : 'or',
        personMatchMode: aiSearchMatchMode,
        personMatchThreshold: aiSearchMatchThreshold,
      } as any);
      if (!cancelled && result.success && result.data) {
        setPeoplePreviewCount(result.data.total);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedPersonIds, multiModeActive, aiSearchMatchMode, aiSearchMatchThreshold]);

  const [peopleFilterSearch, setPeopleFilterSearch] = useState('');
  const [peopleList, setPeopleList] = useState<PersonRecord[]>([]);
  const [peopleFilterMode, setPeopleFilterMode] = useState<'any' | 'together'>('any');
  const [togetherCounts, setTogetherCounts] = useState<{ id: number; name: string; photo_count: number }[]>([]);
  const [togetherLoading, setTogetherLoading] = useState(false);
  const peopleDropdownRef = useRef<HTMLDivElement>(null);
  const [peopleSortMode, setPeopleSortMode] = useState<'az' | 'freq' | 'recent'>('freq');
  const [faceCountExpanded, setFaceCountExpanded] = useState(false);

  // AI stat dropdown states
  const [showAnalyzedDropdown, setShowAnalyzedDropdown] = useState(false);
  const [showFacesDropdown, setShowFacesDropdown] = useState(false);
  const [showTagsDropdown, setShowTagsDropdown] = useState(false);
  const [tagsFilterSearch, setTagsFilterSearch] = useState('');
  const [selectedTagFilters, setSelectedTagFilters] = useState<string[]>([]);

  // Search suggestions state
  const [showSearchSuggestions, setShowSearchSuggestions] = useState(false);
  // Portal position for the suggestions dropdown. Kept in sync with the
  // search input's bounding rect so the dropdown floats above everything
  // else and can't be clipped by the ribbon's overflow-x scroll container.
  const [searchSuggestionsPos, setSearchSuggestionsPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const recomputeSearchSuggestionsPos = useCallback(() => {
    if (!searchInputRef.current) return;
    const rect = searchInputRef.current.getBoundingClientRect();
    setSearchSuggestionsPos({ left: rect.left, top: rect.bottom + 4, width: rect.width });
  }, []);
  useLayoutEffect(() => {
    if (!showSearchSuggestions) return;
    recomputeSearchSuggestionsPos();
    const handler = () => recomputeSearchSuggestionsPos();
    window.addEventListener('resize', handler);
    window.addEventListener('scroll', handler, true);
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('scroll', handler, true);
    };
  }, [showSearchSuggestions, recomputeSearchSuggestionsPos, searchText]);
  const [searchSuggestionIdx, setSearchSuggestionIdx] = useState(-1);

  const [searchSuggestionPersons, setSearchSuggestionPersons] = useState<PersonRecord[]>([]);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compute operator-aware suggestion list for keyboard navigation
  const currentSuggestions = useMemo(() => {
    if (!searchText.trim()) return { items: [] as Array<{ type: 'person'; name: string; prefix: string; isOperator: boolean } | { type: 'tag'; name: string }>, prefix: '', isOperatorContext: false };
    const opRegex = /(\s*(?:,|\+|&|\band\b)\s*)/gi;
    let lastOpEnd = 0;
    let m: RegExpExecArray | null;
    while ((m = opRegex.exec(searchText)) !== null) {
      lastOpEnd = m.index + m[0].length;
    }
    const prefix = lastOpEnd > 0 ? searchText.slice(0, lastOpEnd) : '';
    const fragment = searchText.slice(lastOpEnd).trim();
    const isOperatorContext = lastOpEnd > 0;
    const matchLower = (isOperatorContext ? fragment : searchText).toLowerCase();
    const peopleMatches = searchSuggestionPersons.filter(p => p.name.toLowerCase().includes(matchLower)).slice(0, 5);
    const tagMatches = !isOperatorContext ? aiTagOptions.filter(t => t.tag.toLowerCase().includes(matchLower)).slice(0, 5) : [];
    const items = [
      ...peopleMatches.map(p => ({ type: 'person' as const, name: p.name, prefix, isOperator: isOperatorContext })),
      ...tagMatches.map(t => ({ type: 'tag' as const, name: t.tag })),
    ];
    return { items, prefix, isOperatorContext };
  }, [searchText, searchSuggestionPersons, aiTagOptions]);
  const gridContainerRef = useRef<HTMLDivElement>(null);

  // ─── Navigation helpers ──────────────────────────────────────────────────

  const keyboardNavRef = useRef(false);

  // When files are checked, navigation cycles through checked files only.
  // If we're in "Show N selected" Custom-selection mode, navigation walks
  // every checked file across all searches (drawn from the persisted
  // file Map), not just the ones in the current search results.
  const getNavigableFiles = useCallback((): IndexedFile[] => {
    if (showSelectedOnly && selectedFilesMap.size > 0) {
      return Array.from(selectedFilesMap.values());
    }
    if (!results) return [];
    if (selectedFiles.size > 0) {
      return results.files.filter(f => selectedFiles.has(f.id));
    }
    return results.files;
  }, [results, selectedFiles, showSelectedOnly, selectedFilesMap]);

  // Files to render in the grid: in Custom-selection mode this is the
  // full union of every checked file across every search the user has
  // composed; otherwise it's the current search results. We keep
  // `results` untouched so toggling the mode off returns the user to
  // exactly where they were.
  const displayFiles: IndexedFile[] = (showSelectedOnly && selectedFilesMap.size > 0)
    ? Array.from(selectedFilesMap.values())
    : (results?.files ?? []);

  // Auto-exit Custom-selection mode whenever the selection drains to
  // zero (otherwise the grid would render empty with no escape hatch).
  useEffect(() => {
    if (showSelectedOnly && selectedFilesMap.size === 0) {
      setShowSelectedOnly(false);
    }
  }, [showSelectedOnly, selectedFilesMap]);

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

  // Listen for stale runs detected on startup
  useEffect(() => {
    const cleanup = onStaleRuns((runs) => {
      if (runs.length > 0) {
        setStaleRuns(runs);
        setShowStaleRunsModal(true);
      }
    });
    return cleanup;
  }, []);

  // Track the previous value of isIndexing so we can detect a true→false
  // transition. Without this guard, the effect below fires on every cold
  // mount of SearchPanel (where isIndexing starts false and dbReady flips
  // true) and clears the user's "dismiss AI banner" preference every
  // session. The intent is "re-show the banner only when an indexing run
  // just completed" — i.e. the transition.
  const prevIsIndexingRef = useRef(isIndexing);
  useEffect(() => {
    const wasIndexing = prevIsIndexingRef.current;
    prevIsIndexingRef.current = isIndexing;
    if (!isIndexing && dbReady) {
      loadFilterOptions(); loadStats(); loadAiData(); if (results) executeSearch();
      // Only re-surface the AI banner when isIndexing genuinely flipped
      // from true to false (i.e. a Fix or initial index just finished).
      // Cold mounts where wasIndexing is already false leave the user's
      // dismissal in place.
      if (wasIndexing) {
        getSettings().then(s => {
          if (!s.aiEnabled) {
            setAiPromptDismissed(false);
            localStorage.removeItem('pdr-ai-prompt-dismissed');
          }
        });
      }
    }
  }, [isIndexing]);

  // AI init — check settings, load stats, check models, listen for progress
  useEffect(() => {
    getSettings().then(s => setAiEnabled(s.aiEnabled));
    checkAiModelsReady().then(ready => setAiModelsReady(ready));
    loadAiData();
    const unsubAiProgress = onAiProgress((progress) => {
      console.log('[AI] Progress:', progress.phase, progress.current, '/', progress.total, progress.currentFile || '');
      setAiProgress(progress);
      setAiProcessing(progress.phase !== 'complete' && progress.phase !== 'error');
      if (progress.phase === 'error') {
        console.error('[AI] Error:', progress.currentFile);
      }
      if (progress.phase === 'processing' && !aiModelsReady) {
        setAiModelsReady(true);
      }
      if (progress.phase === 'complete') {
        setAiModelsReady(true);
        loadAiData();
        loadFilterOptions();
        if (results) executeSearch();
      }
    });
    // Forward main-process AI logs to renderer console
    if ((window as any).pdr?.ai?.onLog) {
      (window as any).pdr.ai.onLog((msg: string) => console.log(msg));
    }
    // Replay any buffered logs from before this component mounted
    if ((window as any).pdr?.ai?.replayLogs) {
      (window as any).pdr.ai.replayLogs().then((result: any) => {
        if (result?.success && result.data?.length > 0) {
          console.log(`--- Replaying ${result.data.length} buffered AI logs ---`);
          for (const msg of result.data) {
            console.log(msg);
          }
          console.log('--- End of buffered logs ---');
        }
      }).catch(() => {});
    }
    return () => { unsubAiProgress(); };
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
    const personsRes = await listPersons();
    if (personsRes.success && personsRes.data) {
      setPeopleList(personsRes.data);
      setSearchSuggestionPersons(personsRes.data);
    }
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

  // Parse search text for people / tag / mixed operator queries.
  //   "Terry + Mel"             → people AND
  //   "Terry, Mel"              → people OR
  //   "beach + sunset"          → tag AND
  //   "beach, sunset"           → tag OR
  //   "Terry + beach"           → person AND tag (intersection)
  //   "Terry, beach"            → person OR tag (union)
  //   "Terry + Mel, beach"      → mixed connectors not supported — bails out
  // Each token must match exactly ONE person or ONE tag (case-insensitive,
  // exact match) or the whole thing bails out to a plain-text search so
  // we never silently swallow typos.
  const parseSearchOperators = useCallback((text: string): {
    personIds: number[];
    tags: string[];
    mode: 'and' | 'or';
    unmatched: string[];
  } | null => {
    // Strip a bare trailing operator so "beach," / "beach +" / "beach and"
    // (user is mid-typing the next token) behave identically to "beach".
    const trimmed = text.trim().replace(/\s*(?:\+|&|,|\band)\s*$/i, '').trim();
    if (!trimmed) return null;
    const andPattern = /\s*(?:\+|&|\band\b)\s*/i;
    const orPattern = /\s*,\s*/;
    const hasAnd = andPattern.test(trimmed);
    const hasOr = orPattern.test(trimmed);
    // Mixed AND+OR is ambiguous — bail so the raw text search runs.
    if (hasAnd && hasOr) return null;
    if (!hasAnd && !hasOr) return null;
    const mode: 'and' | 'or' = hasAnd ? 'and' : 'or';
    const parts = trimmed.split(hasAnd ? andPattern : orPattern).filter(Boolean);
    const personIds: number[] = [];
    const tags: string[] = [];
    const unmatched: string[] = [];
    for (const part of parts) {
      const q = part.trim().toLowerCase();
      if (!q) continue;
      const person = peopleList.find(p => p.name.toLowerCase() === q);
      if (person) { personIds.push(person.id); continue; }
      const tag = aiTagOptions.find(t => t.tag.toLowerCase() === q);
      if (tag) { tags.push(tag.tag); continue; }
      // Keep the unmatched fragment around — buildQuery folds it into
      // the free-text search so a partial match still returns results.
      unmatched.push(part.trim());
    }
    // Need at least one recognised token OR some free text; otherwise we
    // have nothing useful and let the raw text search handle it.
    if (personIds.length + tags.length + unmatched.length === 0) return null;
    // If nothing matched structurally, don't claim an operator parse —
    // the caller will fall back to raw text search on the stem.
    if (personIds.length + tags.length === 0) return null;
    return {
      personIds: Array.from(new Set(personIds)),
      tags: Array.from(new Set(tags)),
      mode,
      unmatched,
    };
  }, [peopleList, aiTagOptions]);

  // Back-compat alias for the sync effect that still thinks in "people
  // operators". Returns null for tag-only or mixed parses, so the
  // people-filter-sync effect below only reacts to pure-people queries.
  const parsePeopleOperators = useCallback((text: string): { personIds: number[]; mode: 'and' | 'or' } | null => {
    const parsed = parseSearchOperators(text);
    if (!parsed) return null;
    if (parsed.tags.length > 0) return null;
    if (parsed.unmatched.length > 0) return null;
    if (parsed.personIds.length < 2) return null;
    return { personIds: parsed.personIds, mode: parsed.mode };
  }, [parseSearchOperators]);

  const buildQuery = useCallback((): SearchQuery => {
    // Try the richer operator parser first (handles people, tags, and
    // person × tag mixes). Falls back to plain text search when the query
    // doesn't match the operator grammar.
    const opParsed = parseSearchOperators(searchText);
    const tagsFromOps = opParsed?.tags ?? [];
    const peopleFromOps = opParsed?.personIds ?? [];
    const unmatchedFromOps = opParsed?.unmatched ?? [];
    // Preserve the existing sidebar-checkbox tag filter alongside anything
    // the operator parser pulled from the search bar. Tag-type sentinels
    // ('__has_faces', '__no_faces') stay on the client side.
    const sidebarTags = selectedAiTags.filter(t => !t.startsWith('__'));
    const combinedTags = Array.from(new Set([...sidebarTags, ...tagsFromOps]));
    // When the operator parse succeeds: any tokens that didn't exact-match a
    // person or tag become free-text fragments, so a partial query like
    // "Mel, beachside" still surfaces results instead of collapsing to 0.
    // When the parse fails: strip a bare trailing operator (",", "+", "&",
    // "and") so mid-typing doesn't wipe out the in-progress search.
    const fallbackText = searchText.replace(/\s*(?:\+|&|,|\band)\s*$/i, '').trim();
    // Single-name resolution: if the search text exactly matches one
    // person's name (case-insensitive, no operators), treat it as a
    // person filter rather than free text. This lets the AI Match
    // Sensitivity slider actually filter results — without this, a
    // single-name search ran via FTS which has no similarity score.
    const singleNamePerson = !opParsed && fallbackText
      ? peopleList.find(p => p.name.toLowerCase() === fallbackText.toLowerCase() && !p.name.startsWith('__'))
      : undefined;
    return ({
    text: opParsed
      ? (unmatchedFromOps.length > 0 ? unmatchedFromOps.join(' ') : undefined)
      : (singleNamePerson ? undefined : (fallbackText || undefined)),
    personId: opParsed
      ? peopleFromOps
      : (singleNamePerson ? [singleNamePerson.id] : undefined),
    personIdMode: opParsed ? opParsed.mode : (singleNamePerson ? 'or' : undefined),
    personMatchMode: aiSearchMatchMode,
    personMatchThreshold: aiSearchMatchThreshold,
    aiTagMode: opParsed && tagsFromOps.length > 1 ? opParsed.mode : undefined,
    // When both people AND tags came from a single OR-mode query, tell the
    // backend to OR the two conditions together ("Mel, beach" = Mel OR
    // beach). All other cases AND the conditions normally.
    textFilterJoin: opParsed && opParsed.mode === 'or' && peopleFromOps.length > 0 && tagsFromOps.length > 0 ? 'or' : undefined,
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
    aiTag: combinedTags.length > 0 ? combinedTags : undefined,
    hasFaces: selectedAiTags.includes('__has_faces') ? true : selectedAiTags.includes('__no_faces') ? false : undefined,
    sortBy, sortDir, limit: 60, offset: 0,
    } as SearchQuery);
  }, [searchText, parseSearchOperators, peopleList, aiSearchMatchMode, aiSearchMatchThreshold, selectedConfidence, selectedFileType, selectedDateSource, selectedExtension, selectedCameraMake, selectedCameraModel, selectedLensModel, dateFrom, dateTo, yearFrom, yearTo, monthFrom, monthTo, hasGps, selectedCountry, selectedCity, isoFrom, isoTo, apertureFrom, apertureTo, focalLengthFrom, focalLengthTo, flashFired, megapixelsFrom, megapixelsTo, selectedScene, selectedExposureProgram, selectedWhiteBalance, selectedCameraPosition, selectedOrientation, selectedDestination, selectedAiTags, sortBy, sortDir]);

  const executeSearch = useCallback(async (customQuery?: SearchQuery, opts?: { silent?: boolean }) => {
    // `silent` keeps the existing results visible during the fetch
    // instead of flashing the loading spinner. Used for background
    // refreshes triggered by people:dataChanged so the screen
    // doesn't flicker when PM finishes a recluster.
    if (!opts?.silent) setIsLoading(true);
    const q = customQuery || buildQuery();
    setQuery(q);
    const res = await searchFiles(q);
    if (res.success && res.data) { setResults(res.data); if (!opts?.silent) setSelectedFile(null); loadThumbnailsBatch(res.data.files); }
    if (!opts?.silent) setIsLoading(false);
    setSearchActive(true);
  }, [buildQuery]);

  // Slider release on the AI Match Sensitivity — auto-runs Improve
  // Recognition silently at the new threshold so the slider just
  // works end-to-end. Improve is non-destructive (only adds new
  // unnamed→person matches, never unlinks). Combined with the live
  // filter via personMatchThreshold in buildQuery, sliding Strict
  // hides low-similarity matches; sliding Loose reveals new ones.
  // Debounced so a single drag doesn't fire multiple Improve runs.
  const sdSliderImproveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSDSliderRelease = async () => {
    if (sdSliderImproveTimerRef.current) clearTimeout(sdSliderImproveTimerRef.current);
    sdSliderImproveTimerRef.current = setTimeout(async () => {
      try {
        await refineFromVerified(aiSearchMatchThreshold);
        // Refresh AI data + re-run the current search silently so
        // newly-matched faces appear in the grid without the user
        // having to do anything else.
        await loadAiData();
        if (searchActive) executeSearchRef.current(undefined, { silent: true });
      } catch {
        /* silent — non-fatal */
      }
    }, 200);
  };

  // Always-current ref to executeSearch so external-event listeners
  // (people:dataChanged, dateEditor:dataChanged) can call the LATEST
  // version instead of a stale closure captured when the listener
  // was first registered. Without this, after the user typed
  // "Merci" then "Mel", the listener would still call an old
  // executeSearch whose buildQuery had "Merci" baked in — so a PM
  // recluster would return Merci's photos even though the user is
  // now searching for Mel.
  const executeSearchRef = useRef(executeSearch);
  useEffect(() => { executeSearchRef.current = executeSearch; }, [executeSearch]);

  // Prevent infinite loop between ribbon ↔ filter sync
  const syncDirectionRef = useRef<'none' | 'textToFilter' | 'filterToText'>('none');

  // Sync ribbon search text → People filter selection.
  //
  // Previously this ONLY ran when the text was a 2+ person operator
  // query ("Terry + Merci"). For everything else (single name like
  // "Merci", free text, empty) it left `selectedPersonIds` alone.
  // That caused a real bug: after typing "Terry + Merci" then
  // changing to just "Merci", `selectedPersonIds` stayed
  // [terry, merci] from the previous query. Then when PM finished
  // a recluster, it fired notifyChange → S&D reloaded peopleList
  // → the filter→text sync at the next effect saw 2+ stale ids
  // and rewrote the search box back to "Terry + Merci".
  //
  // The fix is to keep selectedPersonIds COHERENT with the visible
  // text at all times — clear it when the text isn't a pure
  // people-operator query.
  useEffect(() => {
    if (syncDirectionRef.current === 'filterToText') return;
    const parsed = parsePeopleOperators(searchText);
    syncDirectionRef.current = 'textToFilter';
    if (parsed) {
      setSelectedPersonIds(parsed.personIds);
      setMultiModeActive(parsed.mode === 'and');
      if (parsed.personIds.length > 0) {
        getPersonsCooccurrence(parsed.personIds).then(r => {
          if (r.success && r.data) setTogetherCounts(r.data);
        });
      }
    } else if (selectedPersonIds.length > 0) {
      // Text isn't a 2+ people query but the filter still has
      // stale selections — clear them so the back-sync can't
      // restore them on an unrelated re-render (PM recluster,
      // peopleList refresh, etc).
      setSelectedPersonIds([]);
      setMultiModeActive(false);
      setTogetherCounts([]);
    }
    setTimeout(() => { syncDirectionRef.current = 'none'; }, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText, parsePeopleOperators]);

  // Sync People filter selection → ribbon search text
  // Only runs when the user isn't actively typing in the search input
  useEffect(() => {
    if (syncDirectionRef.current === 'textToFilter') return;
    // Don't overwrite the search box while the user is typing in it
    if (document.activeElement === searchInputRef.current) return;
    if (selectedPersonIds.length === 0) return;
    const names = selectedPersonIds
      .map(id => peopleList.find(p => p.id === id)?.name)
      .filter((n): n is string => !!n);
    if (names.length < 2) return; // Operators only make sense with 2+ names
    const separator = multiModeActive ? ' + ' : ', ';
    const newText = names.join(separator);
    if (newText !== searchText) {
      syncDirectionRef.current = 'filterToText';
      setSearchText(newText);
      setTimeout(() => { syncDirectionRef.current = 'none'; }, 0);
    }
  }, [selectedPersonIds, multiModeActive, peopleList]);

  const loadMore = async () => {
    if (!results || results.files.length >= results.total) return;
    setIsLoading(true);
    const q = { ...query, offset: results.files.length };
    const res = await searchFiles(q);
    if (res.success && res.data) { setResults({ ...res.data, files: [...results.files, ...res.data.files] }); loadThumbnailsBatch(res.data.files); }
    setIsLoading(false);
  };

  // Wrapper for opening viewer — checks drive availability first.
  // startIndex is forwarded so a click on result #14 of 175 lands on
  // the right photo with the rest reachable via viewer arrows.
  const safeOpenViewer = async (filePath: string | string[], filename: string | string[], startIndex?: number) => {
    const paths = Array.isArray(filePath) ? filePath : [filePath];
    for (const [destPath, available] of Object.entries(destinationAvailability)) {
      if (!available && paths.some(p => p.startsWith(destPath))) {
        setUnavailableFileMessage(
          `This file's Library Drive is not available. Please reconnect the drive or folder and try again.`
        );
        return;
      }
    }
    await openSearchViewer(filePath, filename, startIndex);
  };

  // Debounced text search. Mirrors the filter-change effect below so
  // clearing the search bar has the same effect as unchecking every
  // filter: results empty out and the S&D view drops back to its empty-
  // state prompt (unless another filter or showAllOverride keeps it
  // populated).
  useEffect(() => {
    if (!dbReady) return;
    // Show/hide search suggestions based on text
    setShowSearchSuggestions(searchText.trim().length > 0 && document.activeElement === searchInputRef.current);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      if (searchText.trim() || hasActiveFilters) {
        executeSearch();
      } else if (showAllOverride && searchActive) {
        executeSearch();
      } else if (searchActive) {
        setResults(null);
      }
    }, 300);
    return () => { if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current); };
  }, [searchText, dbReady]);

  // Re-search on filter change.
  // Behaviour:
  //   - Any filter active → run the search.
  //   - No filters active + user has opted in to "Show entire library" →
  //     run the unfiltered search (they explicitly asked for it).
  //   - No filters active + no opt-in + S&D currently open → KEEP the view
  //     open but clear the result set. The empty-state panel prompts the
  //     user to either add a filter or tap "Show entire library".
  //   - No filters active + no opt-in + S&D not open → collapse back to
  //     Dashboard.
  useEffect(() => {
    if (!dbReady) return;
    if (searchText.trim() || hasActiveFilters) {
      executeSearch();
    } else if (showAllOverride && searchActive) {
      executeSearch();
    } else if (searchActive) {
      setResults(null);
    } else {
      setResults(null);
      setSearchActive(false);
    }
  }, [selectedConfidence, selectedFileType, selectedDateSource, selectedExtension, selectedCameraMake, selectedCameraModel, selectedLensModel, dateFrom, dateTo, yearFrom, yearTo, monthFrom, monthTo, hasGps, selectedCountry, selectedCity, isoFrom, isoTo, apertureFrom, apertureTo, focalLengthFrom, focalLengthTo, flashFired, megapixelsFrom, megapixelsTo, sizeFromMB, sizeToMB, selectedScene, selectedExposureProgram, selectedWhiteBalance, selectedCameraPosition, selectedOrientation, selectedDestination, selectedAiTags, sortBy, sortDir, showAllOverride]);

  // People window data-changed listener — refresh AI data + re-run
  // the current search when PM modifies clusters. Calls
  // executeSearchRef.current so it always uses the LATEST search
  // closure (with the current searchText / filters), not whatever
  // was captured when the listener registered. The search re-run
  // is `silent: true` so we don't flash the loading spinner on top
  // of already-rendered results — that flash is what produced the
  // "screen flickers when PM recluster finishes" complaint.
  useEffect(() => {
    const unsubscribe = onPeopleDataChanged(async () => {
      await loadAiData();
      if (searchActive) executeSearchRef.current(undefined, { silent: true });
    });
    return unsubscribe;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchActive]);

  // Re-search when the AI match mode or sensitivity slider changes.
  // The slider only affects person-id queries, so guard runs the
  // re-search only when the search has any person involvement —
  // either via the filter (selectedPersonIds) or via a person name
  // typed into the search bar (which buildQuery resolves to
  // personId at search time). Debounced 250ms so dragging doesn't
  // fire one query per tick. Silent so the result grid updates
  // without a loading flash.
  useEffect(() => {
    if (!searchActive) return;
    const hasPersonInQuery = selectedPersonIds.length > 0
      || /\b[a-z]/i.test(searchText.trim()); // any text might resolve to a person
    if (!hasPersonInQuery) return;
    const t = setTimeout(() => {
      executeSearchRef.current(undefined, { silent: true });
    }, 250);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiSearchMatchMode, aiSearchMatchThreshold]);

  // Date Editor data-changed listener — refresh the grid after
  // corrections land. Same ref-based latest-closure pattern as the
  // people listener so we don't run a stale search.
  useEffect(() => {
    const unsubscribe = onDateEditorDataChanged(async () => {
      await loadFilterOptions();
      await loadStats();
      if (searchActive) executeSearchRef.current(undefined, { silent: true });
    });
    return unsubscribe;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchActive]);

  const loadThumbnailsBatch = async (files: IndexedFile[]) => {
    // Both photos and videos now get real thumbnails (videos via ffmpeg frame extraction in main).
    const photos = files.filter(f => (f.file_type === 'photo' || f.file_type === 'video') && !thumbnails[f.file_path]);
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
    setShowAllOverride(false);
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
        <div className="flex items-center justify-between ribbon-tab-bar relative" data-tour="sd-ribbon-tabs">
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
                data-tour={tab.key === 'favourites' ? 'sd-favourites-tab' : tab.key === 'ai' ? 'sd-tags-filter' : undefined}
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
            {/* Indexing pill — takes over the whole status region (it's a
                distinct phase from AI; showing both simultaneously would
                just be noise). */}
            {isIndexing && indexingProgress ? (
              <span className="flex items-center gap-1.5 text-xs text-white font-medium bg-white/15 px-2.5 py-1 rounded-full animate-pulse">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Indexing {indexingProgress.current.toLocaleString()}/{indexingProgress.total.toLocaleString()}
              </span>
            ) : (
              // AI progress pill moved to the global TitleBar — shown
              // there on every view so re-tagging stays visible even
              // when the user is in Trees, Memories, or Dashboard.
              // Here we keep ONLY the S&D-specific stats pills.
              stats && stats.totalFiles > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-white/80 flex items-center gap-1.5 bg-white/10 px-2.5 py-1 rounded-full">
                    <Database className="w-3.5 h-3.5" />{stats.totalFiles.toLocaleString()} in library
                  </span>
                  {aiEnabled && aiStats && aiStats.totalProcessed > 0 && (
                    <IconTooltip label={`${aiStats.totalProcessed} photos analyzed — ${aiStats.totalFaces} faces, ${aiStats.totalTags} tags detected`} side="bottom">
                      <span className="text-xs text-white/80 flex items-center gap-1 bg-purple-500/20 px-2 py-1 rounded-full">
                        <Sparkles className="w-3 h-3" />{aiStats.totalProcessed} photos analyzed
                      </span>
                    </IconTooltip>
                  )}
                </div>
              )
            )}
            {/* Snapshot status — same shared component used in PM
                and Trees so backup freshness is visible everywhere
                the user makes data decisions. dark-toolbar variant
                matches S&D's purple ribbon visual language. */}
            <SnapshotStatusBadge variant="dark-toolbar" className="" size="sm" />
            <IconTooltip label="Customize favorite filters" side="bottom">
              <button onClick={() => setShowCustomise(true)} className="p-1 rounded hover:bg-white/20 text-white/70 hover:text-white transition-colors">
                <SlidersHorizontal className="w-3.5 h-3.5" />
              </button>
            </IconTooltip>
            <IconTooltip label={ribbonExpanded ? 'Collapse ribbon (Ctrl+F to search)' : 'Expand ribbon'} side="bottom">
              <button
                onClick={() => setRibbonExpanded(!ribbonExpanded)}
                className="p-1 rounded hover:bg-white/20 text-white/70 hover:text-white transition-colors"
              >
                {ribbonExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
            </IconTooltip>
            {/* Theme toggle + Licensed badge have moved to the global
                TitleBar so they stay visible on every view, not only S&D.
                The onToggleDarkMode / licenseStatusBadge props remain on the
                component signature for backwards compat but are no longer
                rendered here. */}
          </div>
        </div>
      </div>{/* end tab bar wrapper */}

      {/* Ribbon body — counter-scaled for zoom independence */}
      <div className="border-b-2 bg-background select-none ribbon-outer-border shrink-0 min-w-0 w-full">
        <AnimatePresence initial={false}>
          {ribbonExpanded && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} style={{ overflow: 'visible' }}>
              <div ref={ribbonRef} className="flex items-stretch px-2 py-1 gap-0 h-[110px] bg-gradient-to-b from-background to-secondary/10 ribbon-scroll" style={{ overflowX: 'auto', overflowY: 'visible' }}>

                {/* ── Favourites empty state ── */}
                {activeTab === 'favourites' && favouriteGroups.length === 0 && (
                  <div className="flex items-center justify-center flex-1 py-4 px-6">
                    <div className="text-center">
                      <Star className="w-6 h-6 text-foreground/20 mx-auto mb-2" />
                      <p className="text-sm text-foreground/70 font-medium">No favourite filters yet</p>
                      <p className="text-xs text-muted-foreground mt-1">Click the <Star className="w-3 h-3 inline text-amber-500" /> star on any filter group in the other tabs to add it here (max {MAX_FAVOURITE_GROUPS})</p>
                    </div>
                  </div>
                )}

                {/* ── Search Group (always visible) ── */}
                <RibbonGroup label="Search">
                  <div className="flex items-center gap-2 flex-1 py-1.5">
                    <div className="relative min-w-[170px] max-w-[280px] flex-1" data-tour="sd-search-box">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/70" />
                      <input
                        ref={searchInputRef}
                        type="text"
                        placeholder={dbReady ? 'Search photos, people, tags...' : 'Initialising...'}
                        value={searchText}
                        onChange={(e) => { setSearchText(e.target.value); setSearchSuggestionIdx(-1); }}
                        onFocus={() => { if (searchText.trim().length > 0) setShowSearchSuggestions(true); }}
                        onBlur={() => { setTimeout(() => setShowSearchSuggestions(false), 200); }}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            setShowSearchSuggestions(false);
                            setSearchSuggestionIdx(-1);
                            return;
                          }
                          if (e.key === 'Enter') {
                            // Always close the suggestions dropdown on Enter; search executes automatically.
                            // If a suggestion is highlighted, use it; otherwise accept the typed text.
                            if (showSearchSuggestions && searchSuggestionIdx >= 0 && currentSuggestions.items[searchSuggestionIdx]) {
                              e.preventDefault();
                              const chosen = currentSuggestions.items[searchSuggestionIdx];
                              if (chosen.type === 'person' && chosen.isOperator) {
                                setSearchText(`${chosen.prefix}${chosen.name}`);
                              } else {
                                setSearchText(chosen.name);
                              }
                            }
                            setShowSearchSuggestions(false);
                            setSearchSuggestionIdx(-1);
                            return;
                          }
                          if (!showSearchSuggestions || currentSuggestions.items.length === 0) return;
                          if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            setSearchSuggestionIdx(prev => Math.min(prev + 1, currentSuggestions.items.length - 1));
                          } else if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            setSearchSuggestionIdx(prev => Math.max(prev - 1, -1));
                          }
                        }}
                        disabled={!dbReady}
                        className={`w-full pl-10 pr-8 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all ${!dbReady ? 'placeholder:text-foreground/70 placeholder:font-medium opacity-80' : 'placeholder:text-muted-foreground disabled:opacity-50'}`}
                      />
                      {searchText && (
                        <button onClick={() => { setSearchText(''); setShowSearchSuggestions(false); }} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                          <X className="w-4 h-4" />
                        </button>
                      )}
                      {/* Search suggestions dropdown — portaled to body so it
                          can't be clipped by the ribbon's overflow-x-auto
                          container. Position is tracked via
                          searchSuggestionsPos (see useLayoutEffect up top). */}
                      {showSearchSuggestions && searchText.trim().length > 0 && searchSuggestionsPos && (() => {
                        // Split search text at the last operator so we can suggest the NEXT name after `,` `+` `&` or ` and `
                        const opRegex = /(\s*(?:,|\+|&|\band\b)\s*)/gi;
                        let lastOpEnd = 0;
                        let m: RegExpExecArray | null;
                        const regex = new RegExp(opRegex.source, 'gi');
                        while ((m = regex.exec(searchText)) !== null) {
                          lastOpEnd = m.index + m[0].length;
                        }
                        const prefix = lastOpEnd > 0 ? searchText.slice(0, lastOpEnd) : '';
                        const fragment = searchText.slice(lastOpEnd).trim();
                        const isOperatorContext = lastOpEnd > 0;
                        const matchQuery = isOperatorContext ? fragment : searchText;
                        const matchLower = matchQuery.toLowerCase();
                        // Filter people suggestions
                        const peopleMatches = searchSuggestionPersons.filter(p => p.name.toLowerCase().includes(matchLower));
                        const tagMatches = !isOperatorContext ? aiTagOptions.filter(t => t.tag.toLowerCase().includes(matchLower)) : [];
                        return createPortal(
                        <div
                          style={{ position: 'fixed', left: searchSuggestionsPos.left, top: searchSuggestionsPos.top, width: Math.max(240, searchSuggestionsPos.width), zIndex: 1000 }}
                          className="bg-background border border-border rounded-lg shadow-lg max-h-[320px] overflow-y-auto"
                        >
                          {/* Person matches */}
                          {peopleMatches.length > 0 && (
                            <div className="p-1.5">
                              <p className="px-2 py-1 text-[10px] text-muted-foreground uppercase font-medium">
                                {isOperatorContext ? 'People — click to add' : 'People'}
                              </p>
                              {peopleMatches.slice(0, 5).map((p, pIdx) => {
                                const idx = pIdx;
                                const isHighlighted = idx === searchSuggestionIdx;
                                return (
                                <button key={p.id}
                                  onMouseEnter={() => setSearchSuggestionIdx(idx)}
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    const newText = isOperatorContext ? `${prefix}${p.name}` : p.name;
                                    setSearchText(newText);
                                    setShowSearchSuggestions(false);
                                    setSearchSuggestionIdx(-1);
                                  }}
                                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors text-left ${isHighlighted ? 'bg-purple-100 dark:bg-purple-900/40' : 'hover:bg-purple-50 dark:hover:bg-purple-900/20'}`}>
                                  <Users className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                                  <span className="truncate text-foreground">{p.name}</span>
                                  <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{p.photo_count ?? 0} photos</span>
                                </button>
                                );
                              })}
                            </div>
                          )}
                          {/* Tag matches — only shown when not in operator context */}
                          {tagMatches.length > 0 && (
                            <div className="p-1.5 border-t border-border">
                              <p className="px-2 py-1 text-[10px] text-muted-foreground uppercase font-medium">Tags</p>
                              {tagMatches.slice(0, 5).map((t, tIdx) => {
                                const idx = peopleMatches.slice(0, 5).length + tIdx;
                                const isHighlighted = idx === searchSuggestionIdx;
                                return (
                                <button key={t.tag}
                                  onMouseEnter={() => setSearchSuggestionIdx(idx)}
                                  onMouseDown={(e) => { e.preventDefault(); setSearchText(t.tag); setShowSearchSuggestions(false); setSearchSuggestionIdx(-1); }}
                                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors text-left ${isHighlighted ? 'bg-purple-100 dark:bg-purple-900/40' : 'hover:bg-secondary/50'}`}>
                                  <Tag className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                                  <span className="truncate text-foreground">{t.tag}</span>
                                  <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{t.count} photos</span>
                                </button>
                                );
                              })}
                            </div>
                          )}
                          {/* No matches */}
                          {peopleMatches.length === 0 && tagMatches.length === 0 && (
                            <div className="p-3 text-center text-xs text-muted-foreground">
                              {isOperatorContext
                                ? 'No matching people — keep typing or press Enter'
                                : 'No matching people or tags — press Enter to search all fields'}
                            </div>
                          )}
                        </div>,
                        document.body,
                        );
                      })()}
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
                            <Camera className="w-[16px] h-[16px]" />
                            <span>Photos</span>
                          </button>
                          <FilterDropdown label="▾" active={selectedExtension.some(e => ['.jpg','.jpeg','.png','.gif','.bmp','.tiff','.tif','.heic','.heif','.webp','.raw','.cr2','.nef','.arw','.dng','.orf','.rw2','.pef','.sr2','.raf'].includes(e.toLowerCase()))}
                            activeLabel={selectedExtension.filter(e => ['.jpg','.jpeg','.png','.gif','.bmp','.tiff','.tif','.heic','.heif','.webp','.raw','.cr2','.nef','.arw','.dng','.orf','.rw2','.pef','.sr2','.raf'].includes(e.toLowerCase())).map(e => e.toUpperCase()).join(', ') || undefined}>
                            {filterOptions?.extensions.filter(ext => ['.jpg','.jpeg','.png','.gif','.bmp','.tiff','.tif','.heic','.heif','.webp','.raw','.cr2','.nef','.arw','.dng','.orf','.rw2','.pef','.sr2','.raf'].includes(ext.toLowerCase())).length === 0 && <p className="text-sm text-muted-foreground italic p-2">No photo formats found</p>}
                            <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/50">
                              <span className="text-[10px] font-semibold text-foreground/70 uppercase">Photo Formats</span>
                              <button onClick={() => {
                                const photoExts = filterOptions?.extensions.filter(ext => ['.jpg','.jpeg','.png','.gif','.bmp','.tiff','.tif','.heic','.heif','.webp','.raw','.cr2','.nef','.arw','.dng','.orf','.rw2','.pef','.sr2','.raf'].includes(ext.toLowerCase())) || [];
                                const allSelected = photoExts.every(ext => selectedExtension.includes(ext));
                                if (allSelected) setSelectedExtension(prev => prev.filter(e => !photoExts.includes(e)));
                                else setSelectedExtension(prev => Array.from(new Set([...prev, ...photoExts])));
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
                            <Clapperboard className="w-[16px] h-[16px]" />
                            <span>Videos</span>
                          </button>
                          <FilterDropdown label="▾" active={selectedExtension.some(e => ['.mp4','.mov','.avi','.mkv','.wmv','.flv','.webm','.m4v','.3gp','.mpg','.mpeg','.mts','.m2ts'].includes(e.toLowerCase()))}
                            activeLabel={selectedExtension.filter(e => ['.mp4','.mov','.avi','.mkv','.wmv','.flv','.webm','.m4v','.3gp','.mpg','.mpeg','.mts','.m2ts'].includes(e.toLowerCase())).map(e => e.toUpperCase()).join(', ') || undefined}>
                            {filterOptions?.extensions.filter(ext => ['.mp4','.mov','.avi','.mkv','.wmv','.flv','.webm','.m4v','.3gp','.mpg','.mpeg','.mts','.m2ts'].includes(ext.toLowerCase())).length === 0 && <p className="text-sm text-muted-foreground italic p-2">No video formats found</p>}
                            <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/50">
                              <span className="text-[10px] font-semibold text-foreground/70 uppercase">Video Formats</span>
                              <button onClick={() => {
                                const videoExts = filterOptions?.extensions.filter(ext => ['.mp4','.mov','.avi','.mkv','.wmv','.flv','.webm','.m4v','.3gp','.mpg','.mpeg','.mts','.m2ts'].includes(ext.toLowerCase())) || [];
                                const allSelected = videoExts.every(ext => selectedExtension.includes(ext));
                                if (allSelected) setSelectedExtension(prev => prev.filter(e => !videoExts.includes(e)));
                                else setSelectedExtension(prev => Array.from(new Set([...prev, ...videoExts])));
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
                          <BrandedDatePicker
                            value={dateFrom}
                            onChange={setDateFrom}
                            ariaLabel="From date"
                            placeholder="From"
                          />
                          {(dateFrom || dateTo) && (
                            <button onClick={() => { setDateFrom(''); setDateTo(''); }} className="p-0.5 rounded text-muted-foreground hover:text-foreground shrink-0"><X className="w-3 h-3" /></button>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <BrandedDatePicker
                            value={dateTo}
                            onChange={setDateTo}
                            ariaLabel="To date"
                            placeholder="To"
                          />
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
                        <Camera className="w-[16px] h-[16px] text-foreground/70 shrink-0" />
                        <div className="flex flex-col gap-0.5">
                          <FilterDropdown label="Make" active={selectedCameraMake.length > 0} selectedValues={selectedCameraMake}>
                            {filterOptions?.cameraMakes.length === 0 && <p className="text-sm text-muted-foreground italic p-2">No camera data</p>}
                            {filterOptions?.cameraMakes.map(make => (
                              <FilterCheckbox key={make} label={make} checked={selectedCameraMake.includes(make)} onChange={() => toggleFilter(selectedCameraMake, setSelectedCameraMake, make)} />
                            ))}
                          </FilterDropdown>
                          <FilterDropdown label="Model" active={selectedCameraModel.length > 0} selectedValues={selectedCameraModel}>
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
                        <FilterDropdown label="Lens Model" active={selectedLensModel.length > 0} selectedValues={selectedLensModel}>
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
                        <FilterDropdown label="Position" active={selectedCameraPosition.length > 0} selectedValues={selectedCameraPosition.map(p => p.charAt(0).toUpperCase() + p.slice(1))}>
                          {(!filterOptions?.cameraPositions || filterOptions.cameraPositions.length === 0) && <p className="text-sm text-muted-foreground italic p-2">No data — run a fix to populate</p>}
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
                    {/* Renamed from 'Scene Mode' → 'Camera Mode' to disambiguate
                        from AI-detected scene content (sunset / beach / etc.).
                        The underlying EXIF SceneCaptureType describes which
                        shooting-mode dial the camera was set to (Standard /
                        Landscape / Portrait / Night), not visual content. */}
                    <RibbonGroup label="Camera Mode" onExpand={() => setOverflowModalGroup('scene')} groupId="scene" isFavourited={isGroupFavourited('scene')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex items-center gap-1.5 flex-1 py-1.5">
                        <FilterDropdown label="Mode" active={selectedScene.length > 0} selectedValues={selectedScene}>
                          {(!filterOptions?.sceneCaptureTypes || filterOptions.sceneCaptureTypes.length === 0) && <p className="text-sm text-muted-foreground italic p-2">No camera-mode data — run a fix to populate</p>}
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
                        <FilterDropdown label="Program" active={selectedExposureProgram.length > 0} selectedValues={selectedExposureProgram}>
                          {(!filterOptions?.exposurePrograms || filterOptions.exposurePrograms.length === 0) && <p className="text-sm text-muted-foreground italic p-2">No data — run a fix to populate</p>}
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
                        <FilterDropdown label="WB" active={selectedWhiteBalance.length > 0} selectedValues={selectedWhiteBalance}>
                          {(!filterOptions?.whiteBalances || filterOptions.whiteBalances.length === 0) && <p className="text-sm text-muted-foreground italic p-2">No data — run a fix to populate</p>}
                          {filterOptions?.whiteBalances?.map(wb => (
                            <FilterCheckbox key={wb} label={wb} checked={selectedWhiteBalance.includes(wb)} onChange={() => toggleFilter(selectedWhiteBalance, setSelectedWhiteBalance, wb)} />
                          ))}
                        </FilterDropdown>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('orientation') && (() => {
                  // Build group labels that reflect which raw values actually
                  // appear in the library. Groups with zero matching raws are
                  // hidden entirely rather than showing a dead checkbox.
                  const available = new Set(filterOptions?.orientations || []);
                  const activeGroups = ORIENTATION_GROUPS
                    .map(g => ({ ...g, present: g.raws.filter(r => available.has(r)) }))
                    .filter(g => g.present.length > 0);
                  // Derive selected group labels from raw selections so the
                  // trigger button shows "Portrait" not "6".
                  const selectedGroupLabels = Array.from(new Set(selectedOrientation.map(orientationGroupFor)));
                  const toggleGroup = (groupLabel: string, raws: string[]) => {
                    const allSelected = raws.every(r => selectedOrientation.includes(r));
                    if (allSelected) {
                      setSelectedOrientation(prev => prev.filter(v => !raws.includes(v)));
                    } else {
                      setSelectedOrientation(prev => Array.from(new Set([...prev, ...raws])));
                    }
                  };
                  return (
                    <>
                      <RibbonSeparator />
                      <RibbonGroup label="Orientation" onExpand={() => setOverflowModalGroup('orientation')} groupId="orientation" isFavourited={isGroupFavourited('orientation')} onToggleFavourite={toggleFavouriteGroup}>
                        <div className="flex items-center gap-1.5 flex-1 py-1.5">
                          <FilterDropdown label="Orient." active={selectedOrientation.length > 0} selectedValues={selectedGroupLabels}>
                            {activeGroups.length === 0 && <p className="text-sm text-muted-foreground italic p-2">No orientation data — run a fix to populate</p>}
                            {activeGroups.map(g => {
                              const allSelected = g.present.every(r => selectedOrientation.includes(r));
                              return (
                                <FilterCheckbox
                                  key={g.label}
                                  label={g.label}
                                  checked={allSelected}
                                  onChange={() => toggleGroup(g.label, g.present)}
                                />
                              );
                            })}
                          </FilterDropdown>
                        </div>
                      </RibbonGroup>
                    </>
                  );
                })()}

                {visibleGroups.includes('source') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Date Source" onExpand={() => setOverflowModalGroup('source')} groupId="source" isFavourited={isGroupFavourited('source')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex items-center gap-1.5 flex-1 py-1.5">
                        <FilterDropdown label="Source" active={selectedDateSource.length > 0} selectedValues={selectedDateSource}>
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
                        {/* GPS 3-way toggle: ON / BOTH / OFF (vertical stack) */}
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="text-[9px] text-muted-foreground uppercase tracking-wider font-semibold leading-none">GPS</span>
                          <div className="flex flex-col rounded-md border border-border overflow-hidden bg-background w-[40px]">
                            <IconTooltip label="Only photos with GPS data" side="right">
                              <button
                                onClick={() => setHasGps(true)}
                                className={`px-1.5 py-0.5 text-[9px] font-semibold tracking-wide uppercase transition-colors ${hasGps === true ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary/50'}`}
                              >On</button>
                            </IconTooltip>
                            <IconTooltip label="All photos" side="right">
                              <button
                                onClick={() => setHasGps(undefined)}
                                className={`px-1.5 py-0.5 text-[9px] font-semibold tracking-wide uppercase transition-colors border-y border-border ${hasGps === undefined ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary/50'}`}
                              >Both</button>
                            </IconTooltip>
                            <IconTooltip label="Only photos without GPS data" side="right">
                              <button
                                onClick={() => setHasGps(false)}
                                className={`px-1.5 py-0.5 text-[9px] font-semibold tracking-wide uppercase transition-colors ${hasGps === false ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary/50'}`}
                              >Off</button>
                            </IconTooltip>
                          </div>
                        </div>
                        {/* Country / City dropdowns — matching widths */}
                        <div className="flex flex-col gap-0.5">
                          <div className="[&>div>button]:w-[96px] [&>div>button]:justify-between">
                            <FilterDropdown label="Country" active={selectedCountry.length > 0} selectedValues={selectedCountry}>
                              {(!filterOptions?.countries || filterOptions.countries.length === 0) && <p className="text-sm text-muted-foreground italic p-2">No location data — run a fix to populate</p>}
                              {filterOptions?.countries?.map(c => (
                                <FilterCheckbox key={c} label={c} checked={selectedCountry.includes(c)} onChange={() => toggleFilter(selectedCountry, setSelectedCountry, c)} />
                              ))}
                            </FilterDropdown>
                          </div>
                          <div className="[&>div>button]:w-[96px] [&>div>button]:justify-between">
                            <FilterDropdown label="City" active={selectedCity.length > 0} selectedValues={selectedCity}>
                              {(!filterOptions?.cities || filterOptions.cities.length === 0) && <p className="text-sm text-muted-foreground italic p-2">No location data — run a fix to populate</p>}
                              {filterOptions?.cities?.map(c => (
                                <FilterCheckbox key={c} label={c} checked={selectedCity.includes(c)} onChange={() => toggleFilter(selectedCity, setSelectedCity, c)} />
                              ))}
                            </FilterDropdown>
                          </div>
                        </div>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('iso') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="ISO" onExpand={() => setOverflowModalGroup('iso')} groupId="iso" isFavourited={isGroupFavourited('iso')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex flex-col gap-1 flex-1 py-0.5">
                        <UnitInput placeholder="Min" value={isoFrom} onChange={setIsoFrom} unit="ISO" />
                        <UnitInput placeholder="Max" value={isoTo} onChange={setIsoTo} unit="ISO" />
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('aperture') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Aperture" onExpand={() => setOverflowModalGroup('aperture')} groupId="aperture" isFavourited={isGroupFavourited('aperture')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex flex-col gap-1 flex-1 py-0.5">
                        <UnitInput placeholder="Min" value={apertureFrom} onChange={setApertureFrom} unit="f/" step="0.1" />
                        <UnitInput placeholder="Max" value={apertureTo} onChange={setApertureTo} unit="f/" step="0.1" />
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('focalLength') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Focal Length" onExpand={() => setOverflowModalGroup('focalLength')} groupId="focalLength" isFavourited={isGroupFavourited('focalLength')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex flex-col gap-1 flex-1 py-0.5">
                        <UnitInput placeholder="Min" value={focalLengthFrom} onChange={setFocalLengthFrom} unit="mm" />
                        <UnitInput placeholder="Max" value={focalLengthTo} onChange={setFocalLengthTo} unit="mm" />
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('flash') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Flash" onExpand={() => setOverflowModalGroup('flash')} groupId="flash" isFavourited={isGroupFavourited('flash')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex items-center gap-1.5 flex-1 py-1">
                        {/* Flash 3-way toggle: ON / BOTH / OFF — identical
                            structure to the GPS toggle. The group already
                            shows a FLASH label at the bottom, so no duplicate
                            header above the buttons. */}
                        <div className="flex flex-col items-center gap-0.5">
                          <div className="flex flex-col rounded-md border border-border overflow-hidden bg-background w-[40px]">
                            <IconTooltip label="Only photos where the flash fired" side="right">
                              <button
                                onClick={() => setFlashFired(true)}
                                className={`px-1.5 py-0.5 text-[9px] font-semibold tracking-wide uppercase transition-colors ${flashFired === true ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary/50'}`}
                              >On</button>
                            </IconTooltip>
                            <IconTooltip label="All photos, regardless of flash" side="right">
                              <button
                                onClick={() => setFlashFired(undefined)}
                                className={`px-1.5 py-0.5 text-[9px] font-semibold tracking-wide uppercase transition-colors border-y border-border ${flashFired === undefined ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary/50'}`}
                              >Both</button>
                            </IconTooltip>
                            <IconTooltip label="Only photos where the flash did not fire" side="right">
                              <button
                                onClick={() => setFlashFired(false)}
                                className={`px-1.5 py-0.5 text-[9px] font-semibold tracking-wide uppercase transition-colors ${flashFired === false ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary/50'}`}
                              >Off</button>
                            </IconTooltip>
                          </div>
                        </div>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('megapixels') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Megapixels" onExpand={() => setOverflowModalGroup('megapixels')} groupId="megapixels" isFavourited={isGroupFavourited('megapixels')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex flex-col gap-1 flex-1 py-0.5">
                        <UnitInput placeholder="Min" value={megapixelsFrom} onChange={setMegapixelsFrom} unit="MP" step="0.1" />
                        <UnitInput placeholder="Max" value={megapixelsTo} onChange={setMegapixelsTo} unit="MP" step="0.1" />
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {visibleGroups.includes('fileSize') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="File Size" onExpand={() => setOverflowModalGroup('fileSize')} groupId="fileSize" isFavourited={isGroupFavourited('fileSize')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex flex-col gap-1 flex-1 py-0.5">
                        <UnitInput placeholder="Min" value={sizeFromMB} onChange={setSizeFromMB} unit="MB" step="0.1" />
                        <UnitInput placeholder="Max" value={sizeToMB} onChange={setSizeToMB} unit="MB" step="0.1" />
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {/* ── Destination filter ── */}
                {visibleGroups.includes('destination') && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Library Drive" onExpand={() => setOverflowModalGroup('destination')} groupId="destination" isFavourited={isGroupFavourited('destination')} onToggleFavourite={toggleFavouriteGroup}>
                      <div className="flex items-center gap-1.5 flex-1 py-1.5">
                        <FilterDropdown label="Library Drive" active={selectedDestination.length > 0} activeLabel={selectedDestination.length > 0 ? `${selectedDestination.length} selected` : undefined}>
                          {(!filterOptions?.destinations || filterOptions.destinations.length === 0) ? (
                            <p className="text-xs text-muted-foreground italic px-3 py-2">No Library Drives indexed</p>
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

                {/* AI Filters group removed — functionality merged into AI Stats Tags/Faces dropdowns */}

                {/* AI: Error display */}
                {activeTab === 'ai' && !aiProcessing && aiProgress?.phase === 'error' && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="AI Error">
                      <div className="flex flex-col gap-1 flex-1 py-1.5">
                        <div className="flex items-center gap-1.5 text-[11px] text-red-500">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          <span>AI failed to start</span>
                        </div>
                        <span className="text-[9px] text-muted-foreground break-all">{aiProgress.currentFile}</span>
                        <button onClick={() => { setAiProcessing(true); setAiProgress(null); startAiProcessing(); }} className="text-[10px] text-purple-500 hover:text-purple-400 transition-colors mt-1">Retry</button>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {/* AI: Status info (shown on AI tab when AI enabled but nothing processed yet) */}
                {activeTab === 'ai' && aiEnabled && aiTagOptions.length === 0 && !aiProcessing && aiProgress?.phase !== 'error' && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="AI Status">
                      <div className="flex items-center justify-center flex-1 py-2">
                        <div className="flex flex-col items-center gap-1.5 text-center">
                          {aiModelsReady ? (
                            <>
                              <Brain className="w-5 h-5 text-purple-400" />
                              <span className="text-[11px] text-muted-foreground">AI analysis will start automatically</span>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => { setAiProcessing(true); startAiProcessing(); }}
                                className="flex flex-col items-center gap-1 px-4 py-2 rounded-lg bg-purple-500/10 hover:bg-purple-500/20 text-purple-600 dark:text-purple-400 transition-colors"
                              >
                                <Download className="w-5 h-5" />
                                <span className="text-[11px] font-semibold">Download AI Models</span>
                              </button>
                              <span className="text-[9px] text-muted-foreground/70 max-w-[160px]">
                                One-time ~300 MB download. Requires internet connection. Fully offline after.
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {/* AI: Processing progress (shown on AI tab) */}
                {activeTab === 'ai' && aiProcessing && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Progress">
                      <div className="flex flex-col gap-1 flex-1 py-1.5 min-w-[180px]">
                        <div className="flex items-center gap-1.5 text-[11px] text-foreground/70">
                          {aiProgress?.phase === 'paused' ? (
                            <Pause className="w-3.5 h-3.5 text-amber-500" />
                          ) : (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-500" />
                          )}
                          {!aiProgress ? 'Starting AI — loading models...' :
                           aiProgress.phase === 'downloading-models' ? `Downloading models${aiProgress.modelDownloadProgress ? ` (${aiProgress.modelDownloadProgress.percent}%)` : ''}...` :
                           aiProgress.phase === 'clustering' ? 'Clustering faces...' :
                           aiProgress.phase === 'paused' ? `Paused — ${aiProgress.current} / ${aiProgress.total}` :
                           `${aiProgress.current} / ${aiProgress.total}`}
                        </div>
                        {aiProgress && aiProgress.total > 0 && (
                          <div className="w-full h-1.5 rounded-full bg-secondary overflow-hidden">
                            <div className={`h-full ${aiProgress.phase === 'paused' ? 'bg-amber-500' : 'bg-purple-500'} rounded-full transition-all`} style={{ width: `${Math.round((aiProgress.current / aiProgress.total) * 100)}%` }} />
                          </div>
                        )}
                        {aiProgress && (
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            <span>{aiProgress.facesFound} faces</span>
                            <span>{aiProgress.tagsApplied} tags</span>
                          </div>
                        )}
                        <div className="flex items-center gap-1.5">
                          {aiProgress?.phase === 'paused' ? (
                            <button onClick={() => resumeAi()} className="px-2.5 py-1 rounded-md border border-purple-400/50 bg-purple-50 dark:bg-purple-900/20 hover:bg-purple-100 dark:hover:bg-purple-900/40 text-[10px] text-purple-600 dark:text-purple-400 font-medium transition-colors flex items-center gap-1"><Play className="w-2.5 h-2.5" /> Resume</button>
                          ) : (
                            <button onClick={() => pauseAi()} className="px-2.5 py-1 rounded-md border border-amber-400/50 bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-[10px] text-amber-600 dark:text-amber-400 font-medium transition-colors flex items-center gap-1"><Pause className="w-2.5 h-2.5" /> Pause</button>
                          )}
                          <button onClick={() => cancelAi()} className="px-2.5 py-1 rounded-md border border-red-400/50 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 text-[10px] text-red-600 dark:text-red-400 font-medium transition-colors flex items-center gap-1"><X className="w-2.5 h-2.5" /> Cancel</button>
                        </div>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {/* AI: Stats summary (shown on AI tab after processing) — each stat is a clickable filter */}
                {activeTab === 'ai' && aiEnabled && aiStats && aiStats.totalProcessed > 0 && !aiProcessing && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="AI Stats">
                      <div className="flex items-center gap-1 flex-1 py-1.5">
                        {/* ── Analyzed stat dropdown ── */}
                        <Popover open={showAnalyzedDropdown} onOpenChange={setShowAnalyzedDropdown}>
                          <IconTooltip label="Filter by analysis status" side="bottom">
                            <PopoverTrigger asChild>
                              <button
                                className="flex flex-col items-center px-2 py-0.5 rounded-md hover:bg-secondary/50 transition-colors cursor-pointer"
                              >
                                <span className="text-sm font-semibold text-foreground">{aiStats.totalProcessed}</span>
                                <span className="text-[9px] text-muted-foreground uppercase">Analyzed</span>
                              </button>
                            </PopoverTrigger>
                          </IconTooltip>
                          <PopoverContent side="bottom" align="start" className="w-52 p-1" onOpenAutoFocus={(e) => e.preventDefault()}>
                            {[
                              { label: 'All analyzed', desc: `${aiStats.totalProcessed} photos`, filter: { aiProcessed: 'all' as const } },
                              { label: 'Unprocessed only', desc: `${aiStats.unprocessed} photos`, filter: { aiProcessed: 'unprocessed' as const } },
                              { label: 'With faces', desc: undefined, filter: { hasFaces: true } },
                              { label: 'With tags', desc: undefined, filter: { hasAiTags: true } },
                              { label: 'Both faces & tags', desc: undefined, filter: { aiProcessed: 'both' as const } },
                            ].map((opt) => (
                              <button
                                key={opt.label}
                                onClick={() => {
                                  clearFilters();
                                  executeSearch({ sortBy, sortDir, limit: 60, offset: 0, ...opt.filter } as SearchQuery);
                                  setShowAnalyzedDropdown(false);
                                }}
                                className="w-full flex items-center justify-between px-3 py-2 rounded-md hover:bg-secondary/50 transition-colors text-left"
                              >
                                <span className="text-sm text-foreground">{opt.label}</span>
                                {opt.desc && <span className="text-[10px] text-muted-foreground">{opt.desc}</span>}
                              </button>
                            ))}
                          </PopoverContent>
                        </Popover>

                        {/* ── People stat dropdown (face counts accordion + people filter) ── */}
                        <Popover open={showFacesDropdown} onOpenChange={(open) => {
                          setShowFacesDropdown(open);
                          if (open) { setPeopleFilterSearch(''); setTogetherCounts([]); setFaceCountExpanded(false); }
                        }}>
                          <IconTooltip label="Filter by people & faces" side="bottom">
                            <PopoverTrigger asChild>
                              <button
                                data-tour="sd-people-filter"
                                className={`flex flex-col items-center px-2 py-0.5 rounded-md hover:bg-purple-100/50 dark:hover:bg-purple-900/20 transition-colors cursor-pointer ${selectedPersonIds.length > 0 ? 'ring-2 ring-purple-400/50 bg-purple-50/50 dark:bg-purple-900/20' : ''}`}
                              >
                                <span className="text-sm font-semibold text-purple-500">{aiStats.totalPersons || aiStats.totalFaces}</span>
                                <span className="text-[9px] text-muted-foreground uppercase">People</span>
                              </button>
                            </PopoverTrigger>
                          </IconTooltip>
                          <PopoverContent side="bottom" align="start" className="w-72 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
                            {/* People checkboxes with dynamic co-occurrence counts */}
                            {aiStats.totalPersons > 0 && peopleList.length > 0 && (
                              <>
                                {/* Search + sort row */}
                                <div className="p-2 border-b border-border">
                                  <div className="flex items-center gap-1.5">
                                    <div className="relative flex-1">
                                      <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                                      <input
                                        type="text"
                                        value={peopleFilterSearch}
                                        onChange={(e) => setPeopleFilterSearch(e.target.value)}
                                        placeholder="Search people..."
                                        className="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-purple-400/50"
                                      />
                                    </div>
                                    {/* Sort toggle */}
                                    <IconTooltip label={`Sort by: ${peopleSortMode === 'freq' ? 'Most photos' : peopleSortMode === 'az' ? 'A\u2013Z' : 'Recently added'} (click to change)`} side="bottom">
                                      <button
                                        onClick={() => setPeopleSortMode(prev => prev === 'freq' ? 'az' : prev === 'az' ? 'recent' : 'freq')}
                                        className="shrink-0 flex items-center gap-1 px-2 py-1.5 rounded-md border border-border hover:bg-secondary text-[10px] font-medium text-muted-foreground transition-colors"
                                      >
                                        <ArrowUpDown className="w-3 h-3" />
                                        <span>{peopleSortMode === 'freq' ? 'Most' : peopleSortMode === 'az' ? 'A–Z' : 'New'}</span>
                                      </button>
                                    </IconTooltip>
                                  </div>
                                  <p className="text-[10px] text-muted-foreground mt-1.5 px-1">
                                    {selectedPersonIds.length === 0
                                      ? 'Click a single-column number to include that person'
                                      : multiModeActive
                                        ? 'Showing photos with ALL selected people together'
                                        : 'Showing photos with any selected person · click a multi-column number for shared-only'}
                                  </p>
                                </div>
                                {/* Column header icons — aligned directly above the list columns */}
                                <div className="flex items-center gap-2.5 px-2.5 py-1 border-b border-border/60">
                                  {/* Checkbox spacer */}
                                  <span className="shrink-0 w-4" />
                                  {/* Name column spacer */}
                                  <span className="flex-1" />
                                  <TooltipProvider delayDuration={200}>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className="shrink-0 w-8 flex items-center justify-end text-muted-foreground/70">
                                          <User className="w-3.5 h-3.5" />
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent side="top">Photos with just this person</TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                  <TooltipProvider delayDuration={200}>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className="shrink-0 w-8 flex items-center justify-end text-muted-foreground/70">
                                          <Users className="w-3.5 h-3.5" />
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent side="top">Photos shared with checked people</TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                </div>
                                {/* People list */}
                                <div className="max-h-[240px] overflow-y-auto p-1">
                                  {togetherLoading ? (
                                    <div className="flex items-center justify-center py-4">
                                      <Loader2 className="w-4 h-4 animate-spin text-purple-500" />
                                      <span className="ml-2 text-xs text-muted-foreground">Calculating...</span>
                                    </div>
                                  ) : (() => {
                                    const filtered = peopleList
                                      .filter(p => !peopleFilterSearch || p.name.toLowerCase().includes(peopleFilterSearch.toLowerCase()));
                                    const sorted = [...filtered].sort((a, b) => {
                                      if (peopleSortMode === 'az') return a.name.localeCompare(b.name);
                                      if (peopleSortMode === 'recent') return (b.id ?? 0) - (a.id ?? 0);
                                      // Frequency sort: when people are selected, sort by co-occurrence count (most populous with checked people first)
                                      if (selectedPersonIds.length > 0) {
                                        const aSelected = selectedPersonIds.includes(a.id);
                                        const bSelected = selectedPersonIds.includes(b.id);
                                        // Checked rows float to top, keeping their relative order by total photos
                                        if (aSelected && !bSelected) return -1;
                                        if (!aSelected && bSelected) return 1;
                                        if (aSelected && bSelected) return (b.photo_count ?? 0) - (a.photo_count ?? 0);
                                        // Both unchecked: sort by co-occurrence count descending, then total photos
                                        const aCo = togetherCounts.find(tc => tc.id === a.id)?.photo_count ?? 0;
                                        const bCo = togetherCounts.find(tc => tc.id === b.id)?.photo_count ?? 0;
                                        if (aCo !== bCo) return bCo - aCo;
                                      }
                                      return (b.photo_count ?? 0) - (a.photo_count ?? 0);
                                    });
                                    if (sorted.length === 0) {
                                      return <p className="text-xs text-muted-foreground text-center py-4">No people found</p>;
                                    }
                                    return sorted.map(p => {
                                      const isSelected = selectedPersonIds.includes(p.id);
                                      const coCount = selectedPersonIds.length > 0 && !isSelected
                                        ? togetherCounts.find(tc => tc.id === p.id)?.photo_count
                                        : undefined;
                                      const toggleSingle = async () => {
                                        // Clicking single toggles inclusion in OR set (or disables multi-mode if it was on)
                                        setMultiModeActive(false);
                                        const newIds = isSelected
                                          ? selectedPersonIds.filter(id => id !== p.id)
                                          : [...selectedPersonIds, p.id];
                                        setSelectedPersonIds(newIds);
                                        if (newIds.length > 0) {
                                          const result = await getPersonsCooccurrence(newIds);
                                          if (result.success && result.data) setTogetherCounts(result.data);
                                        } else {
                                          setTogetherCounts([]);
                                        }
                                      };
                                      const toggleMulti = async () => {
                                        // Clicking multi adds this person to the set AND switches to AND mode
                                        const newIds = isSelected ? selectedPersonIds : [...selectedPersonIds, p.id];
                                        setSelectedPersonIds(newIds);
                                        setMultiModeActive(true);
                                        if (newIds.length > 0) {
                                          const result = await getPersonsCooccurrence(newIds);
                                          if (result.success && result.data) setTogetherCounts(result.data);
                                        }
                                      };
                                      return (
                                        <div key={p.id} className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-md transition-colors ${coCount === 0 ? 'opacity-70' : ''}`}>
                                          <span className="text-sm text-foreground flex-1 truncate">{p.name}</span>
                                          {/* Single-person count — click to toggle in OR set */}
                                          <button
                                            onClick={toggleSingle}
                                            className={`shrink-0 w-8 text-right text-[10px] tabular-nums rounded px-1 py-0.5 transition-colors ${
                                              isSelected && !multiModeActive
                                                ? 'ring-2 ring-purple-400/50 bg-purple-50/50 dark:bg-purple-900/20 text-foreground font-semibold'
                                                : 'text-muted-foreground hover:bg-purple-100 dark:hover:bg-purple-900/30 hover:text-foreground'
                                            }`}
                                          >
                                            {p.photo_count ?? 0}
                                          </button>
                                          {/* Multi-person count — click to toggle AND mode, adds person if not already selected */}
                                          {(() => {
                                            const noSelection = selectedPersonIds.length === 0;
                                            return (
                                              <button
                                                onClick={toggleMulti}
                                                disabled={noSelection && !isSelected}
                                                className={`shrink-0 w-8 text-right text-[10px] tabular-nums rounded px-1 py-0.5 transition-colors ${
                                                  isSelected && multiModeActive
                                                    ? 'ring-2 ring-purple-400/50 bg-purple-50/50 dark:bg-purple-900/20 text-foreground font-semibold'
                                                    : noSelection
                                                      ? 'text-muted-foreground cursor-default'
                                                      : 'text-muted-foreground hover:bg-purple-100 dark:hover:bg-purple-900/30 hover:text-foreground'
                                                }`}
                                              >
                                                {isSelected ? `(${selectedPersonIds.length})` : noSelection ? '—' : (coCount ?? 0)}
                                              </button>
                                            );
                                          })()}
                                        </div>
                                      );
                                    });
                                  })()}
                                </div>
                                {/* Footer */}
                                <div className="p-2 border-t border-border flex gap-1.5">
                                  <button
                                    onClick={() => {
                                      if (selectedPersonIds.length > 0) {
                                        clearFilters();
                                        executeSearch({ sortBy, sortDir, limit: 60, offset: 0, personId: selectedPersonIds, personIdMode: multiModeActive ? 'and' : 'or', personMatchMode: aiSearchMatchMode as any } as SearchQuery);
                                      } else {
                                        clearFilters();
                                        executeSearch({ sortBy, sortDir, limit: 60, offset: 0, hasNamedPeople: true } as SearchQuery);
                                      }
                                      setShowFacesDropdown(false);
                                    }}
                                    className="flex-1 px-3 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 text-white text-xs font-medium transition-colors"
                                  >
                                    {selectedPersonIds.length === 0
                                      ? 'Show all people'
                                      : peoplePreviewCount === null
                                        ? 'Calculating...'
                                        : `Show ${peoplePreviewCount.toLocaleString()} ${peoplePreviewCount === 1 ? 'photo' : 'photos'}`}
                                  </button>
                                  {selectedPersonIds.length > 0 && (
                                    <button
                                      onClick={() => { setSelectedPersonIds([]); setTogetherCounts([]); setMultiModeActive(false); }}
                                      className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary text-xs font-medium transition-colors"
                                    >
                                      Clear
                                    </button>
                                  )}
                                </div>
                              </>
                            )}

                            {/* Face Count accordion — collapsed by default */}
                            <div className="border-t border-border">
                              <button
                                onClick={() => setFaceCountExpanded(prev => !prev)}
                                className="w-full flex items-center justify-between px-3 py-2 hover:bg-secondary/50 transition-colors"
                              >
                                <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">Face Count</span>
                                <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${faceCountExpanded ? 'rotate-180' : ''}`} />
                              </button>
                              {faceCountExpanded && (
                                <div className="pb-1 px-1">
                                  {[
                                    { label: 'All with faces', filter: { hasFaces: true } },
                                    { label: '1 face', filter: { faceCountMin: 1, faceCountMax: 1 } },
                                    { label: '2\u20135 faces', filter: { faceCountMin: 2, faceCountMax: 5 } },
                                    { label: '6+ faces', filter: { faceCountMin: 6 } },
                                    { label: 'Unnamed faces only', filter: { hasUnnamedFaces: true } },
                                  ].map((opt) => (
                                    <button
                                      key={opt.label}
                                      onClick={() => {
                                        clearFilters();
                                        executeSearch({ sortBy, sortDir, limit: 60, offset: 0, ...opt.filter } as SearchQuery);
                                        setShowFacesDropdown(false);
                                      }}
                                      className="w-full flex items-center px-3 py-1.5 rounded-md hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-colors text-left"
                                    >
                                      <span className="text-xs text-foreground">{opt.label}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          </PopoverContent>
                        </Popover>

                        {/* ── Tags stat dropdown (multi-select with search) ── */}
                        <Popover open={showTagsDropdown} onOpenChange={(open) => {
                          setShowTagsDropdown(open);
                          if (open) setTagsFilterSearch('');
                        }}>
                          <IconTooltip label="Filter by AI tags" side="bottom">
                            <PopoverTrigger asChild>
                              <button
                                className={`flex flex-col items-center px-2 py-0.5 rounded-md hover:bg-purple-100/50 dark:hover:bg-purple-900/20 transition-colors cursor-pointer ${selectedTagFilters.length > 0 ? 'ring-2 ring-purple-400/50 bg-purple-50/50 dark:bg-purple-900/20' : ''}`}
                              >
                                <span className="text-sm font-semibold text-purple-500">{aiStats.totalTags}</span>
                                <span className="text-[9px] text-muted-foreground uppercase">Tags</span>
                              </button>
                            </PopoverTrigger>
                          </IconTooltip>
                          <PopoverContent side="bottom" align="start" className="w-72 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
                            <div className="p-2 border-b border-border">
                              <div className="relative">
                                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                                <input
                                  type="text"
                                  value={tagsFilterSearch}
                                  onChange={(e) => setTagsFilterSearch(e.target.value)}
                                  placeholder="Search tags..."
                                  className="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-purple-400/50"
                                  autoFocus
                                />
                              </div>
                              <p className="text-[10px] text-muted-foreground mt-1.5 px-1">Photos with any selected tag</p>
                            </div>
                            <div className="max-h-[280px] overflow-y-auto p-1">
                              {(() => {
                                const tagCategories: Record<string, string[]> = {
                                  'Scenes & Nature': ['beach', 'mountain', 'forest', 'lake', 'ocean', 'river', 'waterfall', 'field', 'desert', 'flower', 'tree', 'park', 'garden'],
                                  'Weather & Sky': ['sunset', 'sunrise', 'night sky', 'snow', 'rain'],
                                  'Events': ['wedding', 'birthday party', 'christmas', 'graduation', 'concert', 'holiday', 'festival', 'sports event'],
                                  'Activities': ['swimming', 'hiking', 'cycling', 'running', 'dancing', 'cooking', 'eating', 'playing'],
                                  'People & Groups': ['portrait', 'selfie', 'group photo', 'family photo', 'baby', 'children'],
                                  'Animals': ['dog', 'cat', 'bird', 'horse', 'fish'],
                                  'Vehicles': ['car', 'boat', 'airplane', 'train', 'bicycle'],
                                  'Buildings & Places': ['building', 'church', 'bridge', 'monument', 'castle', 'house', 'kitchen', 'living room', 'bedroom', 'restaurant', 'city', 'street'],
                                  'Objects': ['food', 'drink', 'book'],
                                };
                                const tagCountMap = new Map(aiTagOptions.map(t => [t.tag, t.count]));
                                const filteredTags = aiTagOptions.filter(t => !tagsFilterSearch || t.tag.toLowerCase().includes(tagsFilterSearch.toLowerCase()));
                                const filteredTagSet = new Set(filteredTags.map(t => t.tag));

                                // Categorized tags
                                const categorizedTagSet = new Set<string>();
                                const categoryElements = Object.entries(tagCategories).map(([category, categoryTags]) => {
                                  const matchingTags = categoryTags.filter(t => tagCountMap.has(t) && filteredTagSet.has(t));
                                  if (matchingTags.length === 0) return null;
                                  matchingTags.forEach(t => categorizedTagSet.add(t));
                                  return (
                                    <div key={category}>
                                      <div className="px-2.5 pt-2.5 pb-1 text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">{category}</div>
                                      {matchingTags.map(tag => {
                                        const count = tagCountMap.get(tag) || 0;
                                        return (
                                          <label key={tag} className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-secondary/50 cursor-pointer transition-colors">
                                            <input
                                              type="checkbox"
                                              checked={selectedTagFilters.includes(tag)}
                                              onChange={() => {
                                                setSelectedTagFilters(prev =>
                                                  prev.includes(tag) ? prev.filter(x => x !== tag) : [...prev, tag]
                                                );
                                              }}
                                              className="rounded border-border text-purple-500 focus:ring-purple-400/50"
                                            />
                                            <span className="text-sm text-foreground flex-1 truncate">{tag}</span>
                                            <span className="text-[10px] text-muted-foreground shrink-0">{count}</span>
                                          </label>
                                        );
                                      })}
                                    </div>
                                  );
                                }).filter(Boolean);

                                // Uncategorized tags (ones not in any category)
                                const uncategorized = filteredTags.filter(t => !categorizedTagSet.has(t.tag));
                                return (
                                  <>
                                    {categoryElements}
                                    {uncategorized.length > 0 && (
                                      <div>
                                        <div className="px-2.5 pt-2.5 pb-1 text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">Other</div>
                                        {uncategorized.map(t => (
                                          <label key={t.tag} className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-secondary/50 cursor-pointer transition-colors">
                                            <input
                                              type="checkbox"
                                              checked={selectedTagFilters.includes(t.tag)}
                                              onChange={() => {
                                                setSelectedTagFilters(prev =>
                                                  prev.includes(t.tag) ? prev.filter(x => x !== t.tag) : [...prev, t.tag]
                                                );
                                              }}
                                              className="rounded border-border text-purple-500 focus:ring-purple-400/50"
                                            />
                                            <span className="text-sm text-foreground flex-1 truncate">{t.tag}</span>
                                            <span className="text-[10px] text-muted-foreground shrink-0">{t.count}</span>
                                          </label>
                                        ))}
                                      </div>
                                    )}
                                    {filteredTags.length === 0 && (
                                      <p className="text-xs text-muted-foreground text-center py-4">No tags found</p>
                                    )}
                                  </>
                                );
                              })()}
                            </div>
                            <div className="p-2 border-t border-border flex gap-1.5">
                              <button
                                onClick={() => {
                                  clearFilters();
                                  if (selectedTagFilters.length > 0) {
                                    executeSearch({ sortBy, sortDir, limit: 60, offset: 0, aiTag: selectedTagFilters } as SearchQuery);
                                  } else {
                                    executeSearch({ sortBy, sortDir, limit: 60, offset: 0, hasAiTags: true } as SearchQuery);
                                  }
                                  setShowTagsDropdown(false);
                                }}
                                className="flex-1 px-3 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 text-white text-xs font-medium transition-colors"
                              >
                                {selectedTagFilters.length > 0 ? `Show ${selectedTagFilters.length} tag${selectedTagFilters.length > 1 ? 's' : ''}` : 'Show all tagged'}
                              </button>
                              {selectedTagFilters.length > 0 && (
                                <button
                                  onClick={() => setSelectedTagFilters([])}
                                  className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary text-xs font-medium transition-colors"
                                >
                                  Clear
                                </button>
                              )}
                            </div>
                          </PopoverContent>
                        </Popover>
                        {/* People stat merged into Faces dropdown above */}
                        {aiStats.unprocessed > 0 && (
                          <div className="flex flex-col items-center px-2 py-0.5">
                            <span className="text-sm font-semibold text-amber-500">{aiStats.unprocessed.toLocaleString()}</span>
                            <span className="text-[9px] text-muted-foreground uppercase">Remaining</span>
                          </div>
                        )}
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {/* AI: People Manage button — always visible when faces exist, even during processing */}
                {activeTab === 'ai' && aiEnabled && aiStats && aiStats.totalFaces > 0 && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="People">
                      <div className="flex items-center gap-1 flex-1 py-1.5">
                        <IconTooltip label="View and name face clusters" side="bottom">
                          <button
                            onClick={() => openPeopleWindow()}
                            className="flex flex-col items-center gap-0.5 px-2.5 py-1 rounded-md border border-transparent text-foreground/70 hover:bg-purple-100 dark:hover:bg-purple-900/30 hover:text-purple-600 dark:hover:text-purple-400 transition-all text-[11px] font-medium min-w-[42px]"
                          >
                            <Users className="w-[18px] h-[18px]" />
                            <span>Manage</span>
                          </button>
                        </IconTooltip>
                      </div>
                    </RibbonGroup>

                    {/* S&D Match — independent of PM clustering threshold.
                        Tri-state toggle picks WHICH person-linked
                        faces count as a match: only auto-matched
                        (AI), only manually-confirmed (Verified), or
                        either (Both). Slider drives the score cutoff
                        used by refineFromVerifiedFaces so the user
                        can tighten or loosen auto-matching from this
                        surface. Slider styling matches PM's slider
                        (font sizes, Loose/Strict labels) — see PM
                        for the canonical visual language. */}
                    <RibbonSeparator />
                    <RibbonGroup label="Match">
                      <div className="flex items-center gap-3 flex-1 py-1.5">
                        {/* Tri-state segmented toggle: AI / Verified / Both. */}
                        <div className="flex items-center rounded-md border border-border overflow-hidden bg-background">
                          <IconTooltip label="Only auto-matched faces — photos the AI linked to this person but you haven't yet confirmed" side="bottom">
                            <button
                              onClick={() => {
                                setAiSearchMatchMode('matched');
                                setSetting('aiSearchMatchMode' as any, 'matched');
                              }}
                              className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors ${aiSearchMatchMode === 'matched' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary/50'}`}
                            >AI</button>
                          </IconTooltip>
                          <IconTooltip label="Only manually-confirmed faces — auto-matches excluded" side="bottom">
                            <button
                              onClick={() => {
                                setAiSearchMatchMode('verified');
                                setSetting('aiSearchMatchMode' as any, 'verified');
                              }}
                              className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-wide border-l border-border transition-colors ${aiSearchMatchMode === 'verified' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary/50'}`}
                            >Verified</button>
                          </IconTooltip>
                          <IconTooltip label="Every face linked to this person — verified + auto-matched" side="bottom">
                            <button
                              onClick={() => {
                                setAiSearchMatchMode('both');
                                setSetting('aiSearchMatchMode' as any, 'both');
                              }}
                              className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-wide border-l border-border transition-colors ${aiSearchMatchMode === 'both' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary/50'}`}
                            >Both</button>
                          </IconTooltip>
                        </div>
                        {/* Match Sensitivity slider — structurally
                            identical to PM's slider (same Loose /
                            Strict labels at 11px, same quarterly
                            tick-marks at 25/50/75%, same helper
                            text below). Values are independent of
                            PM's clusterThreshold — they measure
                            different operations. */}
                        <div className="flex flex-col items-center flex-1 max-w-[260px]">
                          <div className="flex items-center gap-2 w-full">
                            <span className="text-[11px] text-muted-foreground whitespace-nowrap">Loose</span>
                            <div className="relative flex-1">
                              <input
                                type="range"
                                min="0.65"
                                max="0.95"
                                step="0.01"
                                value={aiSearchMatchThreshold}
                                onChange={(e) => setAiSearchMatchThreshold(parseFloat(e.target.value))}
                                onMouseUp={() => { setSetting('aiSearchMatchThreshold' as any, aiSearchMatchThreshold); void handleSDSliderRelease(); }}
                                onTouchEnd={() => { setSetting('aiSearchMatchThreshold' as any, aiSearchMatchThreshold); void handleSDSliderRelease(); }}
                                className="w-full h-1 accent-purple-500 cursor-pointer relative z-10"
                              />
                              {/* Quarterly tick marks at 25 / 50 / 75% — same
                                  visual cue PM uses to anchor the slider's
                                  midpoints without a numeric scale. */}
                              <div className="absolute top-1/2 left-0 right-0 flex justify-between px-[2px] pointer-events-none" style={{ transform: 'translateY(-50%)' }}>
                                <div className="w-px h-2 bg-transparent" />
                                <div className="w-px h-2.5 bg-muted-foreground/25" />
                                <div className="w-px h-2.5 bg-muted-foreground/25" />
                                <div className="w-px h-2.5 bg-muted-foreground/25" />
                                <div className="w-px h-2 bg-transparent" />
                              </div>
                            </div>
                            <span className="text-[11px] text-muted-foreground whitespace-nowrap">Strict</span>
                          </div>
                          <p className="text-[10px] text-muted-foreground/85 mt-1 text-center leading-tight">
                            Loose includes more auto-matches in your search. Strict only counts the most-similar matches.
                          </p>
                        </div>
                      </div>
                    </RibbonGroup>
                  </>
                )}

                {/* Date Editor button moved into the results header so it's
                    visible next to the search count and inherits the current
                    S&D filter automatically. */}

                {/* ── Sort (always visible) ── */}
                <RibbonSeparator />
                <RibbonGroup label="Sort">
                  <div className="flex items-center gap-1.5 flex-1 py-1.5" data-tour="sd-sort">
                    <div className="flex items-center rounded-md border border-border bg-background overflow-hidden">
                      <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SearchQuery['sortBy'])}
                        className="px-2 py-1.5 bg-transparent text-[12px] text-foreground focus:outline-none border-none appearance-none cursor-pointer pr-1">
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
                      <IconTooltip label={sortDir === 'asc' ? 'Ascending' : 'Descending'} side="bottom">
                        <button onClick={() => setSortDir(prev => prev === 'asc' ? 'desc' : 'asc')}
                          className="flex flex-col items-center justify-center px-1.5 border-l border-border hover:bg-secondary/60 transition-colors h-full py-0.5">
                          <ChevronUp className={`w-3 h-3 ${sortDir === 'asc' ? 'text-foreground' : 'text-muted-foreground/70'}`} />
                          <ChevronDown className={`w-3 h-3 -mt-1 ${sortDir === 'desc' ? 'text-foreground' : 'text-muted-foreground/70'}`} />
                        </button>
                      </IconTooltip>
                    </div>
                  </div>
                </RibbonGroup>

                {/* ── Actions (only shown when there are active filters or library manager is enabled) ── */}
                {(hasActiveFilters || showLibraryManager) && (
                  <>
                    <RibbonSeparator />
                    <RibbonGroup label="Actions">
                      <div className="flex items-center gap-1 flex-1 py-1.5">
                        {hasActiveFilters && (
                          <IconTooltip label="Clear all filters" side="bottom">
                            <button onClick={clearFilters} className="flex flex-col items-center gap-0.5 px-2.5 py-1 rounded-md border border-transparent text-foreground/70 hover:bg-secondary hover:text-foreground transition-all text-[11px] font-medium min-w-[42px]">
                              <RotateCcw className="w-[18px] h-[18px]" />
                              <span>Clear</span>
                            </button>
                          </IconTooltip>
                        )}
                        {hasActiveFilters && !showSaveFavourite && (
                          <IconTooltip label="Save filters as favourite" side="bottom">
                            <button onClick={() => setShowSaveFavourite(true)}
                              className="flex flex-col items-center gap-0.5 px-2.5 py-1 rounded-md border border-transparent text-foreground/70 hover:bg-secondary hover:text-foreground transition-all text-[11px] font-medium min-w-[42px]">
                              <Star className="w-[18px] h-[18px]" />
                              <span>Save</span>
                            </button>
                          </IconTooltip>
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
                        {showLibraryManager && (
                          <IconTooltip label="Library Manager" side="bottom">
                            <button onClick={() => setShowIndexManager(true)} className="flex flex-col items-center gap-0.5 px-2.5 py-1 rounded-md border border-transparent text-foreground/70 hover:bg-secondary hover:text-foreground transition-all text-[11px] font-medium min-w-[42px]">
                              <Database className="w-[18px] h-[18px]" />
                              <span>Library</span>
                            </button>
                          </IconTooltip>
                        )}
                      </div>
                    </RibbonGroup>
                  </>
                )}

              </div>

              {/* Saved filter presets strip */}
              {favourites.length > 0 && (
                <div className="px-4 py-1.5 border-t flex items-center gap-2 flex-wrap ribbon-group-border">
                  <Bookmark className="w-4 h-4 text-foreground/70 shrink-0" />
                  <span className="text-[10px] text-foreground/70 font-medium uppercase tracking-wider shrink-0">Saved:</span>
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
                    <h4 className="text-xs font-semibold text-foreground/70 uppercase tracking-wider mb-2">Photo Formats</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {filterOptions?.extensions.filter(ext => ['.jpg','.jpeg','.png','.gif','.bmp','.tiff','.tif','.heic','.heif','.webp','.raw','.cr2','.nef','.arw','.dng','.orf','.rw2','.pef','.sr2','.raf'].includes(ext.toLowerCase())).map(ext => (
                        <button key={ext} onClick={() => toggleFilter(selectedExtension, setSelectedExtension, ext)} className={`px-3 py-1.5 rounded-md border text-xs transition-all ${selectedExtension.includes(ext) ? 'text-primary border-primary/50 bg-primary/10 font-medium' : 'border-border text-foreground/70 hover:bg-secondary'}`}>{ext.toUpperCase()}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold text-foreground/70 uppercase tracking-wider mb-2">Video Formats</h4>
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
                  <BrandedDatePicker
                    value={dateFrom}
                    onChange={setDateFrom}
                    ariaLabel="From date"
                    placeholder="dd / mm / yyyy"
                    className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 w-full"
                  />
                  <label className="text-sm text-foreground/70 font-medium">To</label>
                  <BrandedDatePicker
                    value={dateTo}
                    onChange={setDateTo}
                    ariaLabel="To date"
                    placeholder="dd / mm / yyyy"
                    className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 w-full"
                  />
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
                  <span className="text-foreground/70">–</span>
                  <input type="number" placeholder="Max ISO" value={isoTo ?? ''} onChange={e => setIsoTo(e.target.value ? Number(e.target.value) : undefined)} className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground w-28 focus:outline-none focus:ring-2 focus:ring-primary/40" />
                </div>
              )}
              {overflowModalGroup === 'aperture' && (
                <div className="flex items-center gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-foreground/60">Min f/</label>
                    <input type="number" step="0.1" placeholder="e.g. 1.4" value={apertureFrom ?? ''} onChange={e => setApertureFrom(e.target.value ? Number(e.target.value) : undefined)} className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground w-28 focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  </div>
                  <span className="text-foreground/70 mt-5">–</span>
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
                  <span className="text-foreground/70 mt-5">–</span>
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
                  <span className="text-foreground/70">–</span>
                  <input type="number" step="0.1" placeholder="Max MP" value={megapixelsTo ?? ''} onChange={e => setMegapixelsTo(e.target.value ? Number(e.target.value) : undefined)} className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground w-28 focus:outline-none focus:ring-2 focus:ring-primary/40" />
                </div>
              )}
              {overflowModalGroup === 'fileSize' && (
                <div className="flex items-center gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-foreground/60">Min (MB)</label>
                    <input type="number" step="0.1" placeholder="e.g. 1" value={sizeFromMB ?? ''} onChange={e => setSizeFromMB(e.target.value ? Number(e.target.value) : undefined)} className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground w-28 focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  </div>
                  <span className="text-foreground/70 mt-5">–</span>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-foreground/60">Max (MB)</label>
                    <input type="number" step="0.1" placeholder="e.g. 50" value={sizeToMB ?? ''} onChange={e => setSizeToMB(e.target.value ? Number(e.target.value) : undefined)} className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground w-28 focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  </div>
                </div>
              )}
              {overflowModalGroup === 'destination' && (
                <div className="flex flex-wrap gap-2">
                  {(!filterOptions?.destinations || filterOptions.destinations.length === 0) ? (
                    <p className="text-sm text-muted-foreground italic">No destinations in library</p>
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
              <h3 className="text-base font-semibold text-foreground">Customize Favorites</h3>
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
                <h4 className="text-xs font-semibold text-foreground/70 uppercase tracking-wider mb-1 px-3">{cat.label}</h4>
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
              Detect faces, identify people, and auto-tag your library photos with content labels. AI analysis applies to photos only — videos are not processed. Everything runs locally on your device — nothing is ever uploaded. A one-time ~300 MB model download is required, then fully offline.
            </p>
          </div>
          <button
            onClick={async () => {
              setAiEnabled(true);
              await setSetting('aiEnabled', true);
              await loadAiData();
              // Switch to AI tab and expand ribbon so user sees progress
              setActiveTab('ai');
              if (!ribbonExpanded) setRibbonExpanded(true);
              // Start AI processing — will download models on first run
              setAiProcessing(true);
              startAiProcessing();
            }}
            className="shrink-0 px-5 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold transition-colors flex items-center gap-2 shadow-md"
          >
            <Sparkles className="w-4 h-4" />
            Enable AI & Download Models
          </button>
          <IconTooltip label="Dismiss" side="left">
            <button
              onClick={() => { setAiPromptDismissed(true); localStorage.setItem('pdr-ai-prompt-dismissed', 'true'); }}
              className="shrink-0 p-1.5 rounded-lg hover:bg-violet-200/50 dark:hover:bg-violet-800/30 text-violet-400 hover:text-violet-600 dark:hover:text-violet-300 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </IconTooltip>
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

      {/* ═══ EMPTY-FILTER STATE ═══
           Shown whenever the user is in S&D and no search has been
           composed yet (no text, no filters, no results). Replaces the
           previous "Pick a filter" minimalist message with a fuller
           landing pitch that demonstrates what Search & Discovery
           actually unlocks — most users never realise PDR can do this
           level of natural-language + structured search until they
           see the examples spelled out. We deliberately DO NOT offer a
           "Show entire library" escape hatch from this screen — that's
           a foot-gun for Edit dates and other bulk actions. Users must
           pick a real filter so every action targets a set they
           consciously scoped. NOTE: condition deliberately omits
           `searchActive` — initial entry to S&D (before any search
           has been issued) ALSO needs this landing, otherwise the
           workspace's "Your workspace is empty" state from MainContent
           leaks through and reads wrong in the S&D context. */}
      {!results && !hasActiveFilters && !searchText.trim() && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* Two-column grid layout — examples on the left, prereqs +
              Parallel Structures on the right — uses the available
              horizontal space and keeps the whole landing visible
              without scrolling on typical viewports. Falls back to a
              single column on narrow widths so the content stays
              readable when the panel is squeezed. */}
          <div className="max-w-6xl mx-auto px-6 py-6">
            <div className="text-center space-y-2 mb-6">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-blue-500/10 text-blue-500">
                <Sparkles className="w-6 h-6" />
              </div>
              <h2 className="text-xl font-semibold text-foreground font-heading">Search &amp; Discovery</h2>
              <p className="text-xs text-muted-foreground max-w-xl mx-auto leading-relaxed">
                Pick any combination of filters above and PDR finds the matching photos in seconds — across every
                Library Drive you've fixed. Nothing leaves your device.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Left column — example queries */}
              <div className="rounded-xl border border-border bg-background/60 overflow-hidden">
                <div className="px-3 py-2 bg-secondary/40 border-b border-border">
                  <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">A few things you can ask for</p>
                </div>
                <div className="divide-y divide-border/60">
                  <div className="px-3 py-2 flex items-start gap-2">
                    <Users className="w-3.5 h-3.5 mt-0.5 text-pink-500 shrink-0" />
                    <div className="text-xs text-foreground leading-relaxed">
                      <span className="font-medium">"Mum, Dad, and me"</span>
                      <span className="text-muted-foreground"> — every photo with all three of you in the frame</span>
                    </div>
                  </div>
                  <div className="px-3 py-2 flex items-start gap-2">
                    <Users className="w-3.5 h-3.5 mt-0.5 text-pink-500 shrink-0" />
                    <div className="text-xs text-foreground leading-relaxed">
                      <span className="font-medium">"All my college friends"</span>
                      <span className="text-muted-foreground"> — pick the people, get every shot any of them appears in</span>
                    </div>
                  </div>
                  <div className="px-3 py-2 flex items-start gap-2">
                    <Sparkles className="w-3.5 h-3.5 mt-0.5 text-blue-500 shrink-0" />
                    <div className="text-xs text-foreground leading-relaxed">
                      <span className="font-medium">"Photos taken in Thailand"</span>
                      <span className="text-muted-foreground"> — or New York, Paris, anywhere with GPS metadata</span>
                    </div>
                  </div>
                  <div className="px-3 py-2 flex items-start gap-2">
                    <Sparkles className="w-3.5 h-3.5 mt-0.5 text-blue-500 shrink-0" />
                    <div className="text-xs text-foreground leading-relaxed">
                      <span className="font-medium">"Everything from my Sony A7"</span>
                      <span className="text-muted-foreground"> — filter by camera make and model, sub-filter by lens</span>
                    </div>
                  </div>
                  <div className="px-3 py-2 flex items-start gap-2">
                    <CalendarRange className="w-3.5 h-3.5 mt-0.5" style={{ color: '#f8c15c' }} />
                    <div className="text-xs text-foreground leading-relaxed">
                      <span className="font-medium">"Summer 2014 to summer 2016"</span>
                      <span className="text-muted-foreground"> — combine a date range with any other filter</span>
                    </div>
                  </div>
                  <div className="px-3 py-2 flex items-start gap-2">
                    <Tag className="w-3.5 h-3.5 mt-0.5 text-blue-500 shrink-0" />
                    <div className="text-xs text-foreground leading-relaxed">
                      <span className="font-medium">"Photos with dogs at the beach at sunset"</span>
                      <span className="text-muted-foreground"> — AI tags layer on top of everything else</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right column — prerequisites + Parallel Structures */}
              <div className="space-y-4">
                <div className="rounded-xl border border-border bg-background/60 p-3 space-y-2">
                  <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">To get the most out of S&amp;D</p>
                  <ul className="text-xs text-foreground space-y-1.5 leading-relaxed">
                    <li className="flex items-start gap-2">
                      <span className="text-pink-500 mt-1 w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                      <span><span className="font-medium">Name your people in People Manager</span> — searches like "Mum + Dad" only work once you've verified faces and given them names.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-blue-500 mt-1 w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                      <span><span className="font-medium">Keep GPS on in your camera</span> — without location metadata, country/city searches return nothing for those photos.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="mt-1 w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: '#f8c15c' }} />
                      <span><span className="font-medium">Run AI analysis</span> — the AI tags ("dogs", "beach", "sunset") are produced offline by PDR's local model. Once it's done, every word becomes a filter.</span>
                    </li>
                  </ul>
                </div>

                <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <ArrowRight className="w-3.5 h-3.5 text-primary" />
                    <p className="text-xs font-semibold text-foreground">Parallel Libraries — the killer feature</p>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Once you've narrowed down a set — every kids' summer photo, every sunset from a particular trip,
                    your top 200 wedding shots — PDR can spin off a separate Library containing JUST those photos, on
                    a drive of your choice. Branch them off as a private archive, copy them to a memory stick for a
                    relative, or keep them alongside the main library as a curated highlight reel. Originals stay
                    safe in your main Library Drive; the Parallel Library is yours to give, hide, or back up
                    independently.
                  </p>
                </div>

                <p className="text-[11px] text-muted-foreground text-center">
                  PDR doesn't auto-load the whole library — pick any filter so Edit dates and other actions only
                  ever target the set you meant.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Pick-mode banner — always visible while the user is picking a
          Trees background via S&D. Sits above the results area so it
          stays in view while the user explores. Confirm button is
          enabled once a file is selected (single-click on a tile). */}
      {pickMode && (
        <div className="sticky top-0 z-20 border-b-2 border-violet-500/70 bg-violet-50 dark:bg-violet-950/30 px-4 py-2.5 flex items-center gap-3 shrink-0">
          <div className="shrink-0 w-9 h-9 rounded-md bg-violet-500 flex items-center justify-center text-white shadow-sm">
            <ImageIcon className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">
              {pickMode.kind === 'canvas'
                ? <>Pick a photo for the canvas on <span className="text-violet-700 dark:text-violet-300">{pickMode.treeName}</span> — Trees</>
                : <>Pick a photo for <span className="text-violet-700 dark:text-violet-300">{pickMode.personName ?? 'this person'}</span>'s card on <span className="text-violet-700 dark:text-violet-300">{pickMode.treeName}</span> — Trees</>
              }
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {selectedFile
                ? <>Selected: <span className="font-medium text-foreground">{selectedFile.filename}</span> — click the purple button to apply.</>
                : <>Search, filter, then click a photo to select it.</>
              }
            </p>
          </div>
          {selectedFile ? (
            <button
              onClick={() => onPickConfirm?.(selectedFile.file_path)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold shadow-sm transition-colors"
            >
              <Check className="w-4 h-4" />
              {pickMode.kind === 'canvas'
                ? <>Use for canvas on {pickMode.treeName}</>
                : <>Use for {pickMode.personName ?? 'card'} on {pickMode.treeName}</>
              }
            </button>
          ) : (
            <button
              disabled
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-muted text-muted-foreground text-sm font-medium cursor-not-allowed border border-border"
            >
              Select a photo first
            </button>
          )}
          <button
            onClick={() => onPickCancel?.()}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-accent"
          >
            Cancel
          </button>
        </div>
      )}

      {/* ═══ RESULTS AREA (below ribbon, above workspace) ═══ */}
      {searchActive && results && (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Results count bar */}
          <div className="px-4 py-1 border-b border-border flex items-center justify-between shrink-0 bg-secondary/20">
            <span className="text-sm font-semibold text-foreground flex items-center gap-2">
              {results.total.toLocaleString()} {results.total === 1 ? 'result' : 'results'}
              {/* Date Editor button — inherits the current S&D query so the
                  dedicated window operates on exactly these photos. Enabled
                  only while there's something to edit. */}
              {/* Edit Dates button. When release-gated
                  (isEditDatesEnabled() === false in v2.0.0 builds),
                  the click fires a toast instead of opening the
                  Date Editor window — which itself depends on the
                  unfinished UX. Tooltip and visual disabled-state
                  reflect the gate so users see why the button looks
                  greyed. */}
              <IconTooltip label={isEditDatesEnabled() ? "Open these photos in the Date Editor to review and correct their dates" : EDIT_DATES_RELEASED_SHORTLY_MESSAGE} side="bottom">
                <button
                  onClick={() => {
                    if (!isEditDatesEnabled()) { toast.info(EDIT_DATES_RELEASED_SHORTLY_MESSAGE); return; }
                    openDateEditor(query);
                  }}
                  disabled={results.total === 0 || !isEditDatesEnabled()}
                  data-pdr-variant="information"
                  className="ml-1 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  style={{ backgroundColor: '#dbeafe', borderColor: '#3b82f6', color: '#1e3a8a', borderWidth: '1px', borderStyle: 'solid' }}
                >
                  <Calendar className="w-3.5 h-3.5" />
                  {selectedFiles.size > 0
                    ? `Edit dates (${selectedFiles.size} selected)`
                    : `Edit dates (${results.total.toLocaleString()})`}
                </button>
              </IconTooltip>
              {selectedFiles.size > 0 && (
                <>
                  <span className="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                    {selectedFiles.size} selected
                  </span>
                  <button
                    onClick={() => {
                      // Use the cross-search selection Map so checked files
                      // from previous searches still open even when the
                      // current results don't include them.
                      const selectedViewable = Array.from(selectedFilesMap.values())
                        .filter(f => f.file_type === 'photo' || f.file_type === 'video');
                      if (selectedViewable.length > 0) {
                        safeOpenViewer(
                          selectedViewable.map(f => f.file_path),
                          selectedViewable.map(f => f.filename),
                        );
                      }
                    }}
                    className="text-xs font-medium text-white bg-primary hover:bg-primary/90 px-3 py-1 rounded-full flex items-center gap-1.5 transition-colors"
                  >
                    <Eye className="w-3 h-3" />
                    Open {Array.from(selectedFilesMap.values()).filter(f => f.file_type === 'photo' || f.file_type === 'video').length} in Viewer
                  </button>
                  {/* Custom-selection toggle — switches the grid between the
                      current search results and the union of every checked
                      file across all searches. The filter ribbon above
                      visually deactivates while this is on so the user
                      knows the grid is now driven by their selection,
                      not by their filter. */}
                  <IconTooltip
                    label={showSelectedOnly ? 'Show the current search results again' : 'Show ONLY the files you have checked across all searches'}
                    side="top"
                  >
                    <button
                      onClick={() => setShowSelectedOnly(prev => !prev)}
                      className={`text-xs font-medium px-3 py-1 rounded-full flex items-center gap-1.5 transition-colors ${showSelectedOnly ? 'text-white bg-primary hover:bg-primary/90' : 'text-foreground bg-secondary hover:bg-secondary/70 border border-border'}`}
                    >
                      <CheckSquare className="w-3 h-3" />
                      {showSelectedOnly ? 'Show all results' : `Show ${selectedFilesMap.size} selected`}
                    </button>
                  </IconTooltip>
                  <IconTooltip
                    label={fixActive ? FIX_BLOCKED_TOOLTIP + ' — Parallel Libraries use the same copy engine as the Fix.' : 'Mirror the selected files into a Parallel Library'}
                    side="top"
                  >
                    <button
                      onClick={() => {
                        if (fixActive) return;
                        setShowStructureModal(true);
                      }}
                      disabled={fixActive}
                      className="text-xs font-medium text-white bg-purple-500 hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1 rounded-full flex items-center gap-1.5 transition-colors"
                    >
                      <Copy className="w-3 h-3" />
                      Create Parallel Library
                    </button>
                  </IconTooltip>
                  <button
                    onClick={() => { setSelectedFiles(new Set()); setSelectedFilesMap(new Map()); setShowSelectedOnly(false); }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Clear
                  </button>
                </>
              )}
              {isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin inline ml-2 text-primary" />}
            </span>
            <div className="flex items-center gap-3">
              {/* Tile size slider (grid view only) + List + Details */}
              <div className="flex items-center gap-2">
                {/* Grid tile size slider — styled like the People Match slider */}
                <IconTooltip label="Grid view" side="bottom">
                  <button
                    onClick={() => setViewMode('grid')}
                    className={`p-1.5 rounded-lg transition-colors ${viewMode === 'grid' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`}
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                  </button>
                </IconTooltip>
                {viewMode === 'grid' && (
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-border bg-background min-w-[160px]">
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">0%</span>
                    <div className="relative flex-1">
                      <input
                        type="range"
                        min={TILE_SLIDER_MIN}
                        max={TILE_SLIDER_MAX}
                        step={TILE_SLIDER_STEP}
                        value={tileSizeSlider}
                        onChange={(e) => setTileSizeSlider(parseInt(e.target.value, 10))}
                        className="w-full h-1 accent-purple-500 cursor-pointer relative z-10"
                      />
                      {/* Tick marks at 25%, 50%, 75% */}
                      <div className="absolute top-1/2 left-0 right-0 flex justify-between px-[2px] pointer-events-none" style={{ transform: 'translateY(-50%)' }}>
                        <div className="w-px h-2 bg-transparent" />
                        <div className="w-px h-2.5 bg-muted-foreground/25" />
                        <div className="w-px h-2.5 bg-muted-foreground/25" />
                        <div className="w-px h-2.5 bg-muted-foreground/25" />
                        <div className="w-px h-2 bg-transparent" />
                      </div>
                    </div>
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">100%</span>
                  </div>
                )}
                <div className="flex items-center border border-border rounded-lg overflow-hidden">
                  <IconTooltip label="List" side="bottom">
                    <button onClick={() => setViewMode('list')}
                      className={`p-1.5 transition-colors ${viewMode === 'list' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`}>
                      <List className="w-3.5 h-3.5" />
                    </button>
                  </IconTooltip>
                  <IconTooltip label="Details" side="bottom">
                    <button onClick={() => setViewMode('details')}
                      className={`p-1.5 transition-colors border-l border-border ${viewMode === 'details' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`}>
                      <Table2 className="w-3.5 h-3.5" />
                    </button>
                  </IconTooltip>
                </div>
              </div>

              {/* Metadata display dropdown — customise what info appears below each tile */}
              {viewMode === 'grid' && (
                <Popover open={showMetaDropdown} onOpenChange={setShowMetaDropdown}>
                  <IconTooltip label="Choose which details show below each photo" side="bottom">
                    <PopoverTrigger asChild>
                      <button
                        className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg border transition-colors text-xs font-medium ${tileMetaFields.length > 0 ? 'bg-primary/10 text-primary border-primary/30' : 'text-muted-foreground border-border hover:text-foreground hover:bg-secondary/50 hover:border-primary/30'}`}
                      >
                        <Info className="w-3.5 h-3.5" />
                        <span>Add Info{tileMetaFields.length > 0 ? ` (${tileMetaFields.length})` : ''}</span>
                      </button>
                    </PopoverTrigger>
                  </IconTooltip>
                  <PopoverContent className="w-56 p-2" align="end">
                    <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider px-2 pt-1 pb-2">Show below each tile</p>
                    {([
                      { key: 'filename' as TileMetaField, label: 'Filename' },
                      { key: 'date' as TileMetaField, label: 'Date' },
                      { key: 'size' as TileMetaField, label: 'File size' },
                      { key: 'dimensions' as TileMetaField, label: 'Dimensions' },
                      { key: 'confidence' as TileMetaField, label: 'Date confidence' },
                      { key: 'camera' as TileMetaField, label: 'Camera' },
                      { key: 'lens' as TileMetaField, label: 'Lens' },
                      { key: 'iso' as TileMetaField, label: 'ISO' },
                      { key: 'aperture' as TileMetaField, label: 'Aperture' },
                      { key: 'focalLength' as TileMetaField, label: 'Focal length' },
                      { key: 'country' as TileMetaField, label: 'Country' },
                      { key: 'city' as TileMetaField, label: 'City' },
                    ]).map(opt => {
                      const checked = tileMetaFields.includes(opt.key);
                      return (
                        <label key={opt.key} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary/50 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setTileMetaFields(prev => checked ? prev.filter(f => f !== opt.key) : [...prev, opt.key]);
                            }}
                            className="rounded border-border text-purple-500 focus:ring-purple-400/50"
                          />
                          <span className="text-sm text-foreground flex-1">{opt.label}</span>
                        </label>
                      );
                    })}
                    {tileMetaFields.length > 0 && (
                      <button
                        onClick={() => setTileMetaFields([])}
                        className="w-full mt-2 px-3 py-1.5 rounded-md text-xs font-medium border border-border hover:bg-secondary text-muted-foreground transition-colors"
                      >
                        Clear all
                      </button>
                    )}
                  </PopoverContent>
                </Popover>
              )}

              {/* Selection mode toggle — shows checkboxes on tiles for multi-select */}
              <IconTooltip label={selectionMode ? 'Exit selection mode' : 'Enable checkbox selection'} side="bottom">
                <button
                  onClick={() => {
                    setSelectionMode(prev => {
                      const next = !prev;
                      // Leaving selection mode → clear BOTH stores (id Set + file Map)
                      // and exit Custom-selection grid view if it was active.
                      if (!next) {
                        setSelectedFiles(new Set());
                        setSelectedFilesMap(new Map());
                        setShowSelectedOnly(false);
                      }
                      return next;
                    });
                  }}
                  className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg border transition-colors text-xs font-medium ${selectionMode ? 'bg-primary text-primary-foreground border-primary shadow-sm' : 'text-muted-foreground border-border hover:text-foreground hover:bg-secondary/50 hover:border-primary/30'}`}
                >
                  <CheckSquare className="w-3.5 h-3.5" />
                  <span>Select{selectedFiles.size > 0 ? ` (${selectedFiles.size})` : ''}</span>
                </button>
              </IconTooltip>

              <IconTooltip label={showPreviewPanel ? 'Hide preview' : 'Show preview'} side="bottom">
                <button onClick={() => setShowPreviewPanel(!showPreviewPanel)}
                  className={`p-1 rounded-lg transition-colors ${showPreviewPanel ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`}>
                  {showPreviewPanel ? <PanelRightClose className="w-3.5 h-3.5" /> : <PanelRightOpen className="w-3.5 h-3.5" />}
                </button>
              </IconTooltip>
              <button onClick={clearFilters} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm transition-all flex items-center gap-1.5 ml-1 border border-primary/40">
                <ArrowLeft className="w-3.5 h-3.5" />
                {hasSources ? 'Back to Dashboard' : 'Back to Workspace'}
              </button>
            </div>
          </div>

          {/* Grid/List/Details + Preview — rendered whenever EITHER the
              current search produced results OR Custom-selection mode is
              active with at least one selected file. The grid below
              iterates `displayFiles`, which switches between the search
              results and the cross-search selection union depending on
              `showSelectedOnly`. */}
          {displayFiles.length > 0 ? (
            <ResizablePanelGroup direction="horizontal" className="flex-1">
              <ResizablePanel defaultSize={selectedFile && showPreviewPanel ? 65 : 100} minSize={40}>
                <div
                  ref={gridContainerRef}
                  data-tour="sd-results-grid"
                  className="h-full overflow-y-auto p-4 select-none sd-scroll-container"
                  onWheel={(e) => {
                    if (!(e.ctrlKey || e.metaKey)) return;
                    // Only scale tiles when in grid view. List and Details ignore Ctrl+scroll.
                    if (viewMode !== 'grid') return;
                    e.preventDefault();
                    e.stopPropagation();
                    setTileSizeSlider(prev => {
                      // Wheel up (deltaY < 0) = bigger tiles; wheel down = smaller. 10% step.
                      const next = e.deltaY < 0
                        ? Math.min(TILE_SLIDER_MAX, prev + TILE_SLIDER_STEP)
                        : Math.max(TILE_SLIDER_MIN, prev - TILE_SLIDER_STEP);
                      return next;
                    });
                  }}
                >
                  {/* ── Grid View (tile size controlled by slider) ── */}
                  {viewMode === 'grid' && (
                    <div
                      className="grid gap-0"
                      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileSliderToPx(tileSizeSlider)}px, 1fr))` }}
                    >
                      {displayFiles.map((file, idx) => (
                        <FileCard key={file.id} file={file} thumbnail={thumbnails[file.file_path]}
                          metaFields={tileMetaFields}
                          selectionMode={selectionMode}
                          isSelected={selectedFile?.id === file.id}
                          isMultiSelected={selectedFiles.has(file.id)}
                          onCheckboxClick={() => {
                            // Checkbox click — toggle without needing CTRL.
                            // Goes through toggleFileSelection so the cross-search
                            // selection map stays in sync with the id-only set.
                            const wasChecked = selectedFiles.has(file.id);
                            toggleFileSelection(file);
                            if (!wasChecked) setSelectedFile(file);
                            lastClickedIndexRef.current = idx;
                          }}
                          onClick={(e: React.MouseEvent) => {
                            // Ctrl/Shift modifiers only take effect when multi-select is already in progress
                            const multiSelectActive = selectedFiles.size > 0;
                            if ((e.ctrlKey || e.metaKey) && multiSelectActive) {
                              const wasChecked = selectedFiles.has(file.id);
                              toggleFileSelection(file);
                              if (!wasChecked) setSelectedFile(file);
                              lastClickedIndexRef.current = idx;
                            } else if (e.shiftKey && multiSelectActive && lastClickedIndexRef.current !== null) {
                              e.preventDefault();
                              const start = Math.min(lastClickedIndexRef.current, idx);
                              const end = Math.max(lastClickedIndexRef.current, idx);
                              // Range selection — operates on the currently-rendered
                              // grid (displayFiles), so range-clicking inside Custom-
                              // selection mode adds neighbouring already-selected
                              // entries (no-op) but inside a normal search adds
                              // contiguous results.
                              for (let i = start; i <= end; i++) {
                                const f = displayFiles[i];
                                if (f && !selectedFiles.has(f.id)) toggleFileSelection(f, 'add');
                              }
                              setSelectedFile(file);
                            } else {
                              // Plain click — open preview panel. Do not touch multi-select.
                              setSelectedFile(file);
                              lastClickedIndexRef.current = idx;
                            }
                          }}
                          onDoubleClick={file.file_type === 'photo' ? () => safeOpenViewer(displayFiles.map(x => x.file_path), displayFiles.map(x => x.filename), idx) : undefined} />
                      ))}
                    </div>
                  )}

                  {/* ── List View ── */}
                  {viewMode === 'list' && (
                    <div className="space-y-0.5">
                      {displayFiles.map((file, idx) => {
                        return (
                          <div key={file.id} data-file-id={file.id}
                            onClick={() => setSelectedFile(file)}
                            onDoubleClick={file.file_type === 'photo' ? () => safeOpenViewer(displayFiles.map(x => x.file_path), displayFiles.map(x => x.filename), idx) : undefined}
                            className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${selectedFile?.id === file.id ? 'bg-primary/10 border border-primary/30' : 'hover:bg-secondary/50'}`}>
                            <div className="w-10 h-10 rounded-lg bg-secondary/40 overflow-hidden shrink-0 flex items-center justify-center">
                              {thumbnails[file.file_path]
                                ? <img src={thumbnails[file.file_path]} alt="" className="w-full h-full object-cover" />
                                : file.file_type === 'video' ? <Film className="w-5 h-5 text-muted-foreground/70" /> : <ImageIcon className="w-5 h-5 text-muted-foreground/70" />}
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
                          {displayFiles.map((file, idx) => {
                            const confidenceColor = file.confidence === 'confirmed' ? 'text-green-600' : file.confidence === 'corrected' ? 'text-primary' : file.confidence === 'recovered' ? 'text-amber-600' : 'text-red-500';
                            return (
                              <tr key={file.id} data-file-id={file.id}
                                onClick={() => setSelectedFile(file)}
                                onDoubleClick={file.file_type === 'photo' ? () => safeOpenViewer(displayFiles.map(x => x.file_path), displayFiles.map(x => x.filename), idx) : undefined}
                                className={`cursor-pointer transition-colors border-b border-border/50 ${selectedFile?.id === file.id ? 'bg-primary/10' : 'hover:bg-secondary/30'}`}>
                                <td className="py-1.5 px-2">
                                  <div className="w-6 h-6 rounded bg-secondary/40 overflow-hidden flex items-center justify-center">
                                    {thumbnails[file.file_path]
                                      ? <img src={thumbnails[file.file_path]} alt="" className="w-full h-full object-cover" />
                                      : file.file_type === 'video' ? <Film className="w-3 h-3 text-muted-foreground/70" /> : <ImageIcon className="w-3 h-3 text-muted-foreground/70" />}
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
                // Context-sensitive Details-panel "Open in Viewer":
                //   • If the photo being previewed is itself one of the
                //     cross-search-checked files, the button opens the
                //     ENTIRE selection (with the previewed photo as the
                //     viewer's start index). Label reads "Open N in
                //     Viewer". The user is "still inside their
                //     selection" — drilling into one of the picks they
                //     made — so launching the whole set matches intent.
                //   • If the previewed photo is NOT in the selection,
                //     the user has stepped outside their selection to
                //     look at something else. The button opens ONLY
                //     that single photo and reads "Open in Viewer".
                const isPreviewInSelection = selectedFilesMap.has(selectedFile.id);
                const viewerSet = isPreviewInSelection
                  ? Array.from(selectedFilesMap.values()).filter(f => f.file_type === 'photo' || f.file_type === 'video')
                  : null;
                const viewerCount = viewerSet ? viewerSet.length : 1;
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
                          if (viewerSet && viewerSet.length > 0) {
                            const startIdx = Math.max(0, viewerSet.findIndex(f => f.id === selectedFile.id));
                            safeOpenViewer(viewerSet.map(f => f.file_path), viewerSet.map(f => f.filename), startIdx);
                          } else {
                            safeOpenViewer(selectedFile.file_path, selectedFile.filename);
                          }
                        }}
                        fileIndex={navIdx + 1} totalFiles={navFiles.length}
                        isShowingChecked={isPreviewInSelection}
                        viewerCount={viewerCount} />
                    </ResizablePanel>
                  </>
                );
              })()}
            </ResizablePanelGroup>
          ) : (
            // Empty-state mirror of `data-tour="sd-results-grid"` so
            // the S&D tour's "Results" step has a spotlight target
            // even before the user has run a search. The active grid
            // above (line ~3506) carries the same data-tour, so the
            // tour highlights whichever variant is currently rendered.
            <div className="flex-1 flex items-center justify-center p-8" data-tour="sd-results-grid">
              <div className="text-center max-w-sm">
                <Search className="w-8 h-8 text-muted-foreground/70 mx-auto mb-3" />
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
        <IndexManagerModal onClose={() => setShowIndexManager(false)} onRefresh={async () => { await loadFilterOptions(); await loadStats(); if (searchActive) executeSearch(); }} stats={stats} onStaleRunsDetected={(runs) => { setStaleRuns(runs); setShowStaleRunsModal(true); }} />
      )}

      {/* Parallel Structure Modal */}
      <ParallelStructureModal
        isOpen={showStructureModal}
        onClose={() => setShowStructureModal(false)}
        files={results ? results.files.filter(f => selectedFiles.has(f.id)) : []}
        totalResultCount={results?.total || 0}
      />

      {/* Stale Runs Modal — shown when indexed destinations are missing */}
      <StaleRunsModal
        isOpen={showStaleRunsModal}
        onClose={() => setShowStaleRunsModal(false)}
        staleRuns={staleRuns}
        onResolved={async () => { await loadFilterOptions(); await loadStats(); if (searchActive) executeSearch(); }}
      />

      {/* People Manager is now a separate BrowserWindow — opened via openPeopleWindow() */}
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
      {/* Centre the content both vertically and horizontally. The inner
          wrapper divs used by each filter have `flex-1` so they stretch to
          the group width — which means a plain `justify-center` on this
          outer row has no effect on the button inside. The arbitrary-child
          selector `[&>div]:justify-center` pushes horizontal centering INTO
          those stretched inner divs so their trigger button ends up in the
          same column as the footer label. */}
      <div className="flex items-center justify-center flex-1 [&>div]:justify-center">{children}</div>
      <div className="flex items-center justify-center gap-1 border-t mt-0.5 pt-0.5 pb-0.5 ribbon-group-border">
        {groupId && onToggleFavourite && (
          <IconTooltip label={isFavourited ? 'Remove from Favourites' : 'Add to Favourites'} side="top">
            <button onClick={() => onToggleFavourite(groupId)}
              className={`p-0 leading-none transition-colors ${isFavourited ? 'text-amber-500 hover:text-amber-400' : 'text-foreground/25 hover:text-amber-400'}`}>
              <Star className={`w-2.5 h-2.5 ${isFavourited ? 'fill-amber-500' : ''}`} />
            </button>
          </IconTooltip>
        )}
        <span className="text-[10px] text-foreground/60 text-center font-semibold uppercase tracking-wider">{label}</span>
        {onExpand && (
          <IconTooltip label={`Open ${label} panel`} side="top">
            <button onClick={onExpand} className="p-0 leading-none text-foreground/70 hover:text-foreground/70 transition-colors">
              <ExternalLink className="w-2.5 h-2.5" />
            </button>
          </IconTooltip>
        )}
      </div>
    </div>
  );
}

/**
 * Numeric ribbon input with its unit label shown inline on the right. Uses
 * flex rather than absolute positioning so the unit physically can't overlap
 * the input value, regardless of how wide the unit string is (f/, mm, MP,
 * ISO, MB all just work).
 */
function UnitInput({ placeholder, value, onChange, unit, step }: {
  placeholder: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  unit: string;
  step?: string;
}) {
  return (
    <div className="flex items-center rounded-md border border-border bg-background overflow-hidden focus-within:ring-1 focus-within:ring-primary/40 w-[92px]">
      <input
        type="number"
        step={step}
        placeholder={placeholder}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
        className="flex-1 min-w-0 bg-transparent pl-2 py-1 text-xs text-foreground focus:outline-none"
      />
      <span className="px-1.5 text-[10px] text-muted-foreground pointer-events-none select-none whitespace-nowrap">{unit}</span>
    </div>
  );
}

function RibbonSeparator() {
  return <div className="w-px mx-1 my-1 shrink-0 ribbon-separator" />;
}

// ─── Filter Dropdown ─────────────────────────────────────────────────────────

/**
 * Ribbon filter dropdown. Display rules for the trigger button (designed to
 * stay readable at any ribbon width without resorting to mid-word ellipsis):
 *   - 0 selected          → show the fallback `label` (e.g. "Source")
 *   - 1 selected          → show that single value, truncated to max width
 *   - 2+ selected         → show "N selected" (count instead of join)
 * `activeLabel` (legacy prop) is still honoured as an override but new call
 * sites should pass `selectedValues` instead.
 * A `title` attribute on the button always holds the full comma-joined
 * selection so hovering reveals it even when truncated.
 */
function FilterDropdown({
  label,
  active,
  activeLabel,
  selectedValues,
  children,
}: {
  label: string;
  active: boolean;
  activeLabel?: string;
  selectedValues?: string[];
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Popover is rendered into document.body via a portal so it can never be
  // clipped by the ribbon's overflow-x-auto container. Position is kept in
  // sync with the trigger rect via useLayoutEffect + scroll/resize listeners.
  const [popoverPos, setPopoverPos] = useState<{ left: number; top: number } | null>(null);

  const recomputePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    // Horizontally centre under the trigger.
    const left = rect.left + rect.width / 2;
    const top = rect.bottom + 4; // small gap below the trigger
    setPopoverPos({ left, top });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    recomputePosition();
    const handler = () => recomputePosition();
    window.addEventListener('resize', handler);
    window.addEventListener('scroll', handler, true);
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('scroll', handler, true);
    };
  }, [open, recomputePosition]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  let display: string;
  let title: string | undefined;
  if (selectedValues && selectedValues.length > 0) {
    title = selectedValues.join(', ');
    display = selectedValues.length === 1 ? selectedValues[0] : `${selectedValues.length} selected`;
  } else if (activeLabel) {
    // Legacy path — used by filters that already format their own label.
    display = activeLabel;
    title = activeLabel;
  } else {
    display = label;
  }

  return (
    <>
      <IconTooltip label={title ?? ''} side="bottom" disabled={!title}>
        <button
          ref={triggerRef}
          onClick={() => setOpen(!open)}
          className={`flex items-center gap-1 px-2 py-1 rounded-md border text-[12px] transition-all ${
            active ? 'border-primary/50 bg-primary/10 text-primary font-medium' : 'border-border text-foreground hover:border-primary/30 hover:text-primary'
          }`}
        >
          <span className="max-w-[110px] truncate">{display}</span>
          <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </IconTooltip>
      {open && popoverPos && createPortal(
        <div
          ref={popoverRef}
          style={{
            position: 'fixed',
            left: popoverPos.left,
            top: popoverPos.top,
            transform: 'translateX(-50%)',
            zIndex: 1000,
          }}
          className="min-w-[200px] max-h-[60vh] overflow-y-auto bg-background border border-border rounded-xl shadow-lg p-2 space-y-0.5"
        >
          {children}
        </div>,
        document.body,
      )}
    </>
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

// Metadata field keys that users can toggle on for tile footers
type TileMetaField = 'filename' | 'date' | 'size' | 'camera' | 'lens' | 'iso' | 'aperture' | 'focalLength' | 'dimensions' | 'country' | 'city' | 'confidence';

function FileCard({ file, thumbnail, isSelected, isMultiSelected, onClick, onCheckboxClick, onDoubleClick, metaFields, selectionMode }: { file: IndexedFile; thumbnail?: string; isSelected: boolean; isMultiSelected?: boolean; onClick: (e: React.MouseEvent) => void; onCheckboxClick?: () => void; onDoubleClick?: () => void; metaFields?: TileMetaField[]; selectionMode?: boolean }) {
  const highlighted = isSelected || isMultiSelected;
  const fields = metaFields ?? [];
  const hasAnyMeta = fields.length > 0;
  return (
    <div data-file-id={file.id} onClick={onClick} onDoubleClick={onDoubleClick}
      className={`group cursor-pointer transition-all duration-200 overflow-hidden ${hasAnyMeta ? 'rounded-xl border' : ''} ${highlighted ? (hasAnyMeta ? 'border-primary ring-2 ring-primary/20 shadow-lg' : 'ring-2 ring-primary/40') : (hasAnyMeta ? 'border-border hover:border-primary/40 hover:shadow-md' : 'hover:ring-2 hover:ring-primary/30')}`}>
      <div className="aspect-square bg-secondary/30 relative overflow-hidden">
        {thumbnail ? <img src={thumbnail} alt={file.filename} className="w-full h-full object-cover" loading="lazy" draggable={false} /> : (
          <div className="w-full h-full flex items-center justify-center">{file.file_type === 'video' ? <Film className="w-10 h-10 text-muted-foreground/30" /> : <ImageIcon className="w-10 h-10 text-muted-foreground/30" />}</div>
        )}
        {/* Multi-select checkbox — only visible when Selection Mode is active */}
        {(selectionMode || isMultiSelected) && (
          <div
            onClick={(e) => { e.stopPropagation(); onCheckboxClick?.(); }}
            className={`absolute top-2 left-2 w-6 h-6 rounded border-2 flex items-center justify-center transition-all cursor-pointer hover:scale-110 z-10 ${
              isMultiSelected
                ? 'bg-primary border-primary text-white'
                : 'border-white/80 bg-black/40 text-transparent hover:border-white hover:bg-black/60'
            }`}>
            {isMultiSelected && <svg className="w-3.5 h-3.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 6l3 3 5-5" /></svg>}
          </div>
        )}
        {file.file_type === 'video' && <div className="absolute bottom-2 left-2 px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] font-medium flex items-center gap-1"><Film className="w-3 h-3" /> Video</div>}
        {file.file_type === 'photo' && onDoubleClick && !isMultiSelected && (
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
            <div className="p-2 rounded-full bg-black/50 text-white/90"><Maximize2 className="w-4 h-4" /></div>
          </div>
        )}
      </div>
      {hasAnyMeta && (
        <div className="p-2 space-y-0.5">
          {fields.includes('filename') && <IconTooltip label={file.filename} side="top"><p className="text-xs font-medium text-foreground truncate">{file.filename}</p></IconTooltip>}
          {fields.includes('date') && <p className="text-[10px] text-muted-foreground truncate">{file.derived_date ? formatDate(file.derived_date) : 'No date'}</p>}
          {fields.includes('size') && file.size_bytes > 0 && <p className="text-[10px] text-muted-foreground truncate">{formatBytes(file.size_bytes)}</p>}
          {fields.includes('camera') && file.camera_model && <p className="text-[10px] text-muted-foreground truncate flex items-center gap-1"><Camera className="w-2.5 h-2.5 shrink-0" /> {file.camera_model}</p>}
          {fields.includes('lens') && (file as any).lens_model && <p className="text-[10px] text-muted-foreground truncate">{(file as any).lens_model}</p>}
          {fields.includes('iso') && (file as any).iso && <p className="text-[10px] text-muted-foreground truncate">ISO {(file as any).iso}</p>}
          {fields.includes('aperture') && (file as any).aperture && <p className="text-[10px] text-muted-foreground truncate">f/{(file as any).aperture}</p>}
          {fields.includes('focalLength') && (file as any).focal_length && <p className="text-[10px] text-muted-foreground truncate">{(file as any).focal_length}mm</p>}
          {fields.includes('dimensions') && (file as any).width && (file as any).height && <p className="text-[10px] text-muted-foreground truncate">{(file as any).width}×{(file as any).height}</p>}
          {fields.includes('country') && (file as any).country && <p className="text-[10px] text-muted-foreground truncate">{(file as any).country}</p>}
          {fields.includes('city') && (file as any).city && <p className="text-[10px] text-muted-foreground truncate">{(file as any).city}</p>}
          {fields.includes('confidence') && file.confidence_level && <p className="text-[10px] text-muted-foreground truncate capitalize">{file.confidence_level}</p>}
        </div>
      )}
    </div>
  );
}

// ─── Video Speed Picker (YouTube-style) ──────────────────────────────────────

const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

// ─── Orientation groups ─────────────────────────────────────────────────────
// EXIF Orientation tag (0x0112) stores a rotation hint as an integer 0–8.
// PDR's DB holds whatever exiftool returned, so raw values can look like
// "Horizontal (normal)", "Rotate 90 CW", "1", "6", "0" depending on
// extractor version. We normalise those to four user-meaningful groups
// (Landscape / Portrait / Mirrored / Unknown) for the filter UI, while
// the backend query still runs a plain IN-list against the stored raw
// strings.
const ORIENTATION_GROUPS: Array<{ label: 'Landscape' | 'Portrait' | 'Mirrored' | 'Unknown'; raws: string[] }> = [
  { label: 'Landscape', raws: ['1', 'Horizontal (normal)', '3', 'Rotate 180'] },
  { label: 'Portrait',  raws: ['6', 'Rotate 90 CW', '8', 'Rotate 270 CW'] },
  { label: 'Mirrored',  raws: ['2', 'Mirror horizontal', '4', 'Mirror vertical', '5', 'Mirror horizontal and rotate 270 CW', '7', 'Mirror horizontal and rotate 90 CW'] },
  { label: 'Unknown',   raws: ['0', ''] },
];

/** Given a raw orientation string, return the human group label. */
function orientationGroupFor(raw: string): 'Landscape' | 'Portrait' | 'Mirrored' | 'Unknown' {
  for (const g of ORIENTATION_GROUPS) if (g.raws.includes(raw)) return g.label;
  return 'Unknown';
}

function VideoSpeedPicker({ rate, onChange }: { rate: number; onChange: (r: number) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const label = rate === 1 ? '1x' : `${rate}x`;
  return (
    <div ref={ref} className="absolute top-2 right-2 z-20">
      <IconTooltip label="Playback speed" side="bottom">
        <button
          onClick={() => setOpen(v => !v)}
          className="px-2 py-1 rounded bg-black/60 hover:bg-black/80 text-white text-[11px] font-semibold tracking-wide shadow-lg backdrop-blur-sm transition-colors"
        >
          {label}
        </button>
      </IconTooltip>
      {open && (
        <div className="absolute top-full right-0 mt-1 py-1 rounded-md bg-black/90 shadow-xl backdrop-blur-sm min-w-[68px]">
          {PLAYBACK_RATES.map(r => (
            <button
              key={r}
              onClick={() => { onChange(r); setOpen(false); }}
              className={`w-full text-left px-3 py-1 text-[11px] font-medium transition-colors ${r === rate ? 'text-primary bg-white/10' : 'text-white hover:bg-white/10'}`}
            >
              {r === 1 ? 'Normal' : `${r}x`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── File Detail Panel ───────────────────────────────────────────────────────

function FileDetailPanel({ file, thumbnail, onClose, onPrev, onNext, onOpenInExplorer, onOpenViewer, fileIndex, totalFiles, isShowingChecked, viewerCount }: {
  file: IndexedFile; thumbnail?: string; onClose: () => void; onPrev?: () => void; onNext?: () => void; onOpenInExplorer?: () => void; onOpenViewer?: () => void; fileIndex?: number; totalFiles?: number; isShowingChecked?: boolean;
  /** How many photos clicking the "Open in Viewer" button will actually
   *  open. Drives the button label: 1 → "Open in Viewer", N>1 → "Open N
   *  in Viewer". Computed by the parent based on whether the previewed
   *  file is itself in the cross-search selection. */
  viewerCount?: number;
}) {
  const [fullThumbnail, setFullThumbnail] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoPreparing, setVideoPreparing] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [fileTags, setFileTags] = useState<AiTagRecord[]>([]);
  const [fileFaces, setFileFaces] = useState<FaceRecord[]>([]);
  const [editingFaceId, setEditingFaceId] = useState<number | null>(null);
  const [faceNameInput, setFaceNameInput] = useState('');
  const [existingPersons, setExistingPersons] = useState<PersonRecord[]>([]);
  const [showPersonSuggestions, setShowPersonSuggestions] = useState(false);
  const faceNameInputRef = useRef<HTMLInputElement>(null);
  const [faceCrops, setFaceCrops] = useState<Record<number, string>>({});
  const [showFaceOverlays, setShowFaceOverlays] = useState(true);
  const [confirmDeletePerson, setConfirmDeletePerson] = useState<{ personId: number; personName: string; faceId: number; photoCount: number } | null>(null);
  const [nameScopeChoice, setNameScopeChoice] = useState<{ name: string; faceId: number; clusterId: number; clusterPhotoCount: number } | null>(null);
  const [visualSuggs, setVisualSuggs] = useState<{ personId: number; personName: string; similarity: number }[]>([]);
  const [redetecting, setRedetecting] = useState(false);

  // Re-run face detection on this single file. Used by the
  // "Re-detect faces" affordance in the People header (and the
  // empty-state line beneath the photo when Human.js found nothing on
  // the first analysis pass). Verified faces are preserved by the
  // backend — only unverified rows are wiped + replaced — so the user
  // never loses a tick by clicking this. After success we re-pull
  // fileFaces so the UI reflects the new detections immediately.
  const handleRedetect = async () => {
    if (redetecting) return;
    setRedetecting(true);
    try {
      const res = await redetectFile(file.id);
      if (res.ok) {
        const r = await getAiFaces(file.id);
        if (r.success && r.data) setFileFaces(r.data);
        if (res.newFaces === 0) {
          toast.message('No additional faces found.', { description: 'Human.js still didn\'t detect any faces in this photo.' });
        } else if (res.newFaces === 1) {
          toast.success('1 face re-detected', { description: 'Auto-matched against your named people where possible.' });
        } else {
          toast.success(`${res.newFaces} faces re-detected`, { description: 'Auto-matched against your named people where possible.' });
        }
      } else {
        toast.error('Re-detect failed', { description: res.error ?? 'Unknown error.' });
      }
    } finally {
      setRedetecting(false);
    }
  };

  // Helper: handle naming a face — checks cluster size and offers scope choice
  const handleNameFace = async (name: string, face: FaceRecord) => {
    if (face.cluster_id != null) {
      const countResult = await getClusterFaceCount(face.cluster_id);
      if (countResult.success && countResult.data && countResult.data.photoCount > 1) {
        // Show scope choice — this face is in a cluster with multiple photos
        setNameScopeChoice({
          name,
          faceId: face.id,
          clusterId: face.cluster_id,
          clusterPhotoCount: countResult.data.photoCount,
        });
        setEditingFaceId(null);
        setFaceNameInput('');
        setShowPersonSuggestions(false);
        return;
      }
    }
    // Single photo or no cluster — just apply directly
    const result = await namePerson(name, face.cluster_id ?? undefined);
    if (result.success) {
      const r = await getAiFaces(file.id);
      if (r.success && r.data) setFileFaces(r.data);
    }
    setEditingFaceId(null);
    setFaceNameInput('');
    setShowPersonSuggestions(false);
  };

  // Load visual suggestions when editing a face (respects the aiVisualSuggestions setting)
  useEffect(() => {
    if (editingFaceId != null) {
      getSettings().then(s => {
        if (s.aiVisualSuggestions !== false) {
          getVisualSuggestions(editingFaceId).then(r => {
            if (r.success && r.data) setVisualSuggs(r.data);
            else setVisualSuggs([]);
          });
        } else {
          setVisualSuggs([]);
        }
      });
    } else {
      setVisualSuggs([]);
    }
  }, [editingFaceId]);

  useEffect(() => {
    const loadFull = async () => { const r = await getThumbnail(file.file_path, 400); if (r.success && r.dataUrl) setFullThumbnail(r.dataUrl); };
    if (file.file_type === 'photo') loadFull();
    // Videos get a full-size poster from the thumbnail cache and an on-demand
    // transcode if the codec/container isn't natively playable by Chromium.
    let cancelled = false;
    if (file.file_type === 'video') {
      loadFull();
      setVideoUrl(null);
      setVideoError(null);
      setVideoPreparing(true);
      (async () => {
        const r = await prepareVideoForPlayback(file.file_path);
        if (cancelled) return;
        if (r.success && r.playableUrl) { setVideoUrl(r.playableUrl); setVideoError(null); }
        else { setVideoUrl(null); setVideoError(r.error || 'Could not prepare video'); }
        setVideoPreparing(false);
      })();
    }
    // Load AI data for this file
    getAiFileTags(file.id).then(r => { if (r.success && r.data) setFileTags(r.data); else setFileTags([]); });
    getAiFaces(file.id).then(r => {
      if (r.success && r.data) {
        setFileFaces(r.data);
        // Load face crop thumbnails
        const crops: Record<number, string> = {};
        Promise.all(r.data.map(async (face) => {
          const crop = await getFaceCrop(file.file_path, face.box_x, face.box_y, face.box_w, face.box_h, 64);
          if (crop.success && crop.dataUrl) crops[face.id] = crop.dataUrl;
        })).then(() => setFaceCrops(crops));
      } else {
        setFileFaces([]);
      }
    });
    return () => { cancelled = true; setFullThumbnail(null); setFileTags([]); setFileFaces([]); setFaceCrops({}); setVideoUrl(null); setVideoError(null); setVideoPreparing(false); };
  }, [file.file_path, file.id]);

  const confidenceLabel = file.confidence === 'confirmed'
    ? { text: 'Confirmed', color: 'text-green-600 bg-green-50 dark:text-green-400 dark:bg-green-900/30', icon: <CheckCircle2 className="w-3.5 h-3.5" /> }
    : file.confidence === 'corrected'
      ? { text: 'Corrected', color: 'text-primary bg-primary/10', icon: <CheckCircle2 className="w-3.5 h-3.5" /> }
    : file.confidence === 'recovered'
      ? { text: 'Recovered', color: 'text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-900/30', icon: <AlertTriangle className="w-3.5 h-3.5" /> }
      : { text: 'Marked', color: 'text-red-500 bg-red-50 dark:text-red-400 dark:bg-red-900/30', icon: <HelpCircle className="w-3.5 h-3.5" /> };

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="px-4 pb-4" style={{ paddingTop: 0, marginTop: 0 }}>
        {/* Header bar — sticky at the very top with a higher z-index
            than the photo block below. Background opaque so metadata
            sliding up under it doesn't bleed through. The photo
            block is wrapped in the SAME sticky group below this so
            both pieces stay pinned together (no gap appears between
            them as the user scrolls). */}
        <div
          className="flex items-center justify-between py-1 mb-0 border-b border-border/30 bg-background sticky top-0 z-30"
          style={{ marginTop: 0 }}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 className="text-sm font-semibold text-foreground mr-1">Details</h3>
            {fileIndex != null && totalFiles != null && (
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${isShowingChecked ? 'text-primary bg-primary/10' : 'text-muted-foreground'}`}>
                {fileIndex} of {totalFiles.toLocaleString()}{isShowingChecked ? ' checked' : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <IconTooltip label="Previous (←)" side="bottom">
              <button onClick={onPrev} disabled={!onPrev}
                className={`p-1.5 rounded-lg transition-colors ${onPrev ? 'hover:bg-secondary/50 text-muted-foreground hover:text-foreground cursor-pointer' : 'text-muted-foreground/30 cursor-default'}`}><ArrowLeft className="w-4 h-4" /></button>
            </IconTooltip>
            <IconTooltip label="Next (→)" side="bottom">
              <button onClick={onNext} disabled={!onNext}
                className={`p-1.5 rounded-lg transition-colors ${onNext ? 'hover:bg-secondary/50 text-muted-foreground hover:text-foreground cursor-pointer' : 'text-muted-foreground/30 cursor-default'}`}><ArrowRight className="w-4 h-4" /></button>
            </IconTooltip>
            {onOpenInExplorer && (
              <IconTooltip label="Open in Explorer" side="bottom">
                <button onClick={onOpenInExplorer} className="p-1.5 rounded-lg hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors"><ExternalLink className="w-4 h-4" /></button>
              </IconTooltip>
            )}
            <IconTooltip label="Close (Esc)" side="bottom">
              <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors"><X className="w-4 h-4" /></button>
            </IconTooltip>
          </div>
        </div>
        {/* Sticky wrapper — full-width and OPAQUE so metadata scrolling behind it
            doesn't show through the side gaps when the inner photo container is
            narrower than the panel (portrait photos). The actual photo box sits
            inside, centred, with its aspect ratio pinned to the file's
            width/height so the rendered <img> fills it exactly with no
            letterboxing. The face-bounding overlays then map % coords directly
            onto the image with no maths-vs-letterbox mismatch — which is what
            was making boxes appear oversized and offset in S&D while PM (which
            renders crops via getFaceCrop's server-side coord math) showed them
            correctly sized. */}
        <div
          className="sticky z-20 mb-3 bg-background flex items-center justify-center border-b border-border pb-2"
          style={{ minHeight: 0, top: '32px' }}
        >
        <div
          className="rounded-xl overflow-hidden bg-secondary/30 relative group"
          style={{
            maxHeight: '60vh',
            aspectRatio: file.width && file.height ? `${file.width}/${file.height}` : undefined,
            // When aspectRatio is set the height is computed from width × ratio, capped by maxHeight.
            // For portrait photos that would otherwise overflow 60vh, also cap width so the box stays
            // proportional rather than overflowing horizontally and re-introducing letterbox gaps.
            maxWidth: file.width && file.height && file.height > file.width
              ? `calc(60vh * ${file.width / file.height})`
              : '100%',
          }}
        >
          {file.file_type === 'video' ? (
            videoUrl ? (
              <div className="relative">
                <video
                  key={videoUrl}
                  ref={(el) => {
                    videoRef.current = el;
                    if (el) el.playbackRate = playbackRate;
                  }}
                  src={videoUrl}
                  controls
                  preload="metadata"
                  poster={fullThumbnail || thumbnail || undefined}
                  className="w-full h-auto max-h-[60vh] bg-black block"
                  onError={(e) => {
                    const v = e.currentTarget;
                    const err = v.error;
                    console.warn('[inline-video] error src=', v.src, 'code=', err?.code, 'message=', err?.message);
                  }}
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    v.playbackRate = playbackRate;
                    console.log('[inline-video] loaded metadata', v.videoWidth, 'x', v.videoHeight, v.duration + 's');
                  }}
                />
                <VideoSpeedPicker
                  rate={playbackRate}
                  onChange={(r) => {
                    setPlaybackRate(r);
                    if (videoRef.current) videoRef.current.playbackRate = r;
                  }}
                />
              </div>
            ) : (
              <div className="w-full flex flex-col items-center justify-center gap-2 py-16 bg-black/80">
                {(fullThumbnail || thumbnail) && (
                  <img src={fullThumbnail || thumbnail} alt={file.filename} className="absolute inset-0 w-full h-full object-contain opacity-30" />
                )}
                <div className="relative z-10 flex flex-col items-center gap-2 text-white/80">
                  <Film className="w-10 h-10 text-primary/80" />
                  {videoPreparing && <span className="text-xs font-medium">Preparing video…</span>}
                  {videoPreparing && <span className="text-[10px] text-white/60 max-w-[80%] text-center">Older formats are transcoded on first play. Subsequent opens are instant.</span>}
                  {!videoPreparing && videoError && <span className="text-xs text-red-300">{videoError}</span>}
                  {!videoPreparing && videoError && (
                    <button onClick={onOpenInExplorer} className="text-[11px] px-3 py-1 rounded border border-white/30 hover:bg-white/10">Show in Folder</button>
                  )}
                </div>
              </div>
            )
          ) : (fullThumbnail || thumbnail) ? (
            // Parent now has aspect-ratio set to file.width/file.height (when known) and a maxHeight: 60vh +
            // proportional maxWidth, so the image fills the parent exactly with no letterboxing. object-contain
            // is kept as a defensive fallback for the case where width/height are missing on the indexed_files
            // row — in that fallback path the parent's aspect-ratio is undefined, so the parent still sizes
            // around the image and contain prevents distortion.
            <img src={fullThumbnail || thumbnail} alt={file.filename} className="w-full h-full object-contain block" />
          ) : (
            <div className="w-full aspect-square flex items-center justify-center">{file.file_type === 'video' ? <Film className="w-16 h-16 text-muted-foreground/20" /> : <ImageIcon className="w-16 h-16 text-muted-foreground/20" />}</div>
          )}
          {/* Face bounding box overlays — clickable for naming */}
          {showFaceOverlays && fileFaces.length > 0 && (fullThumbnail || thumbnail) && (
            <>
              {fileFaces.map((face) => (
                <div
                  key={`face-overlay-${face.id}`}
                  className="absolute rounded-sm transition-all group/face border-2 border-purple-400/70 z-10"
                  style={{
                    left: `${face.box_x * 100}%`,
                    top: `${face.box_y * 100}%`,
                    width: `${face.box_w * 100}%`,
                    height: `${face.box_h * 100}%`,
                  }}
                  onClick={(e) => {
                    // Name editing moved to the People (N) row below — don't open an editor on top of the image
                    e.stopPropagation();
                  }}
                >
                  {/* Name label shown on hover. Editing happens in the People rows below. */}
                  {false ? (
                    /* Inline editor kept in tree but never rendered */
                    <div className="absolute left-1/2 -translate-x-1/2 w-[160px] z-30"
                      style={{ top: `calc(100% + 4px)` }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl border border-purple-300 dark:border-purple-600 p-1.5">
                        <input
                          ref={faceNameInputRef}
                          type="text"
                          value={faceNameInput}
                          onChange={(e) => {
                            setFaceNameInput(e.target.value);
                            setShowPersonSuggestions(true);
                          }}
                          onFocus={() => setShowPersonSuggestions(true)}
                          onKeyDown={async (e) => {
                            if (e.key === 'Enter' && faceNameInput.trim()) {
                              await handleNameFace(faceNameInput.trim(), face);
                            } else if (e.key === 'Escape') {
                              setEditingFaceId(null);
                              setFaceNameInput('');
                              setShowPersonSuggestions(false);
                            }
                          }}
                          placeholder="Type a name..."
                          className="w-full text-xs bg-transparent border-b border-purple-300 dark:border-purple-600 outline-none text-foreground placeholder:text-muted-foreground/70 pb-0.5"
                          autoFocus
                        />
                        {/* Person suggestions dropdown — shows all existing persons, filtered by input */}
                        {showPersonSuggestions && existingPersons.length > 0 && (
                          <div className="mt-1 max-h-[80px] overflow-y-auto">
                            {existingPersons
                              .filter(p => !faceNameInput || p.name.toLowerCase().includes(faceNameInput.toLowerCase()))
                              .slice(0, 5)
                              .map(p => (
                                <button
                                  key={p.id}
                                  onMouseDown={async (e) => {
                                    e.preventDefault(); // Prevent blur
                                    await handleNameFace(p.name, face);
                                  }}
                                  className="w-full flex items-center gap-1.5 px-1 py-0.5 rounded text-[10px] hover:bg-purple-100/50 dark:hover:bg-purple-900/20 transition-colors text-left"
                                >
                                  <Users className="w-2.5 h-2.5 text-purple-400 shrink-0" />
                                  <span className="text-foreground truncate">{p.name}</span>
                                  {(p as any).photo_count != null && (
                                    <span className="text-[8px] text-muted-foreground ml-auto shrink-0">{(p as any).photo_count}</span>
                                  )}
                                </button>
                              ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    /* Facebook-style: name tooltip appears on hover over the face box (read-only) */
                    <span className="absolute bottom-0 left-0 right-0 flex justify-center opacity-0 group-hover/face:opacity-100 transition-opacity pointer-events-none"
                    >
                      {face.person_name && (
                        <span className="bg-purple-600/90 text-white px-2 py-0.5 rounded-t text-[10px] font-semibold leading-tight shadow-lg inline-block truncate max-w-full">
                          {face.person_name}
                        </span>
                      )}
                    </span>
                  )}
                </div>
              ))}
            </>
          )}
          {/* Face overlay toggle moved to the People header below */}
          {/* Overlay prev/next arrows on the image */}
          {onPrev && (
            <IconTooltip label="Previous (←)" side="right">
              <button onClick={onPrev} className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/40 hover:bg-black/60 text-white/80 hover:text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all">
                <ArrowLeft className="w-4 h-4" />
              </button>
            </IconTooltip>
          )}
          {onNext && (
            <IconTooltip label="Next (→)" side="left">
              <button onClick={onNext} className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/40 hover:bg-black/60 text-white/80 hover:text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all">
                <ArrowRight className="w-4 h-4" />
              </button>
            </IconTooltip>
          )}
        </div>
        </div>
        {(onOpenViewer || onOpenInExplorer) && (
          <div className="flex gap-2 mb-4">
            {onOpenViewer && (file.file_type === 'photo' || file.file_type === 'video') && (
              <button onClick={onOpenViewer} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold shadow-sm hover:bg-primary/90 transition-all">
                <Eye className="w-3.5 h-3.5" />{viewerCount && viewerCount > 1 ? `Open ${viewerCount} in Viewer` : 'Open in Viewer'}
              </button>
            )}
            {onOpenInExplorer && <button onClick={onOpenInExplorer} data-pdr-variant="information" className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-all" style={{ backgroundColor: '#dbeafe', borderColor: '#3b82f6', color: '#1e3a8a', borderWidth: '1px', borderStyle: 'solid' }}><FolderOpen className="w-3.5 h-3.5" />Show in Folder</button>}
          </div>
        )}

        {/* No people detected — empty-state line that gives the user
            a way out when Human.js missed every face on the first
            analysis pass (side profile, low light, glasses). One line,
            no full purple section, so it doesn't push the rest of the
            details panel down for the common case. */}
        {fileFaces.length === 0 && (file.file_type === 'photo' || file.file_type === 'video') && (
          <div className="mb-3 flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-purple-200/40 dark:border-purple-700/30 bg-purple-50/20 dark:bg-purple-950/10">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="w-3.5 h-3.5 text-purple-500/70" />
              No people detected yet.
            </span>
            <IconTooltip
              label="Re-run face detection on this single photo. Useful when Human.js missed a face on the first pass (side profile, partial occlusion, low light)."
              side="left"
            >
              <button
                type="button"
                onClick={handleRedetect}
                disabled={redetecting}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-purple-600 hover:text-purple-700 hover:bg-purple-100/60 dark:hover:bg-purple-900/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <RefreshCw className={`w-3 h-3 ${redetecting ? 'animate-spin' : ''}`} />
                {redetecting ? 'Re-detecting…' : 'Re-detect'}
              </button>
            </IconTooltip>
          </div>
        )}

        {/* AI Faces — positioned right after photo for easy naming */}
        {fileFaces.length > 0 && (
          <div className="mb-3 rounded-lg border border-purple-200/50 dark:border-purple-700/30 bg-purple-50/30 dark:bg-purple-950/10 overflow-hidden">
            <div className="flex items-center justify-between gap-1.5 px-3 py-1.5 text-sm text-purple-600 dark:text-purple-400 uppercase font-semibold border-b border-purple-200/30 dark:border-purple-700/20">
              <span className="flex items-center gap-1.5">
                <Users className="w-4 h-4" /> People ({fileFaces.length})
              </span>
              <div className="flex items-center gap-2">
                {/* Re-detect — even when faces are present, the user
                    might know one is missing (a person partially out of
                    frame, a profile shot Human.js skipped). Same handler
                    as the empty-state line. */}
                <IconTooltip
                  label="Re-run face detection on this photo. Verified faces are preserved; only auto-matches get refreshed."
                  side="bottom"
                >
                  <button
                    type="button"
                    onClick={handleRedetect}
                    disabled={redetecting}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium normal-case text-purple-600 hover:text-purple-700 hover:bg-purple-100/60 dark:hover:bg-purple-900/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <RefreshCw className={`w-3 h-3 ${redetecting ? 'animate-spin' : ''}`} />
                    {redetecting ? 'Re-detecting…' : 'Re-detect'}
                  </button>
                </IconTooltip>
                <span className="w-px h-3 bg-purple-300/40" />
              <IconTooltip label={showFaceOverlays ? 'Hide face boxes on photo' : 'Show face boxes on photo'} side="left">
              <label className="flex items-center gap-2 cursor-pointer normal-case">
                <span className="text-sm text-muted-foreground">Boxes</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={showFaceOverlays}
                  onClick={() => setShowFaceOverlays(prev => !prev)}
                  className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
                    showFaceOverlays ? 'bg-purple-500' : 'bg-muted-foreground/30'
                  }`}
                >
                  <span
                    className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${
                      showFaceOverlays ? 'translate-x-3.5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </label>
              </IconTooltip>
              </div>
            </div>
            <div className="px-2 py-1.5 space-y-1">
              {fileFaces.map((face) => (
                <div key={face.id} className="group">
                  {editingFaceId === face.id ? (
                    /* Inline editing mode */
                    <div className="px-1 py-1.5 rounded-lg bg-purple-50/50 dark:bg-purple-950/20 border border-purple-200/50 dark:border-purple-700/30">
                      <div className="flex items-center gap-2">
                        {faceCrops[face.id] ? (
                          <img src={faceCrops[face.id]} alt="" className="w-8 h-8 rounded-full object-cover shrink-0 border-2 border-purple-400/60" />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-purple-500/30 flex items-center justify-center shrink-0">
                            <UserPlus className="w-4 h-4 text-purple-500" />
                          </div>
                        )}
                        <input
                          ref={faceNameInputRef}
                          type="text"
                          value={faceNameInput}
                          onChange={(e) => {
                            setFaceNameInput(e.target.value);
                            setShowPersonSuggestions(true);
                          }}
                          onFocus={() => setShowPersonSuggestions(true)}
                          onKeyDown={async (e) => {
                            if (e.key === 'Enter' && faceNameInput.trim()) {
                              await handleNameFace(faceNameInput.trim(), face);
                            } else if (e.key === 'Escape') {
                              setEditingFaceId(null);
                              setFaceNameInput('');
                              setShowPersonSuggestions(false);
                            }
                          }}
                          placeholder="Type a name..."
                          className="flex-1 text-xs bg-transparent border-b border-purple-300 dark:border-purple-600 outline-none text-foreground placeholder:text-muted-foreground/70 pb-0.5 min-w-0"
                          autoFocus
                        />
                        <IconTooltip label="Save name" side="top">
                          <button
                            onClick={async () => {
                              if (faceNameInput.trim()) {
                                await handleNameFace(faceNameInput.trim(), face);
                              } else {
                                setEditingFaceId(null);
                                setFaceNameInput('');
                                setShowPersonSuggestions(false);
                              }
                            }}
                            className="p-0.5 rounded hover:bg-purple-200/50 dark:hover:bg-purple-800/30 transition-colors shrink-0"
                          >
                            <Check className="w-3.5 h-3.5 text-purple-500" />
                          </button>
                        </IconTooltip>
                        <IconTooltip label="Cancel" side="top">
                          <button
                            onClick={() => { setEditingFaceId(null); setFaceNameInput(''); setShowPersonSuggestions(false); }}
                            className="p-0.5 rounded hover:bg-secondary transition-colors shrink-0"
                          >
                            <X className="w-3.5 h-3.5 text-muted-foreground" />
                          </button>
                        </IconTooltip>
                      </div>
                      {/* Existing person suggestions — show all when input is empty */}
                      {showPersonSuggestions && existingPersons.length > 0 && (
                        <div className="mt-1.5 border-t border-purple-200/30 dark:border-purple-700/20 pt-1">
                          {existingPersons
                            .filter(p => !faceNameInput || p.name.toLowerCase().includes(faceNameInput.toLowerCase()))
                            .slice(0, 5)
                            .map(p => (
                              <button
                                key={p.id}
                                onClick={async () => {
                                  await handleNameFace(p.name, face);
                                }}
                                className="w-full flex items-center gap-2 px-1 py-1 rounded text-xs hover:bg-purple-100/50 dark:hover:bg-purple-900/20 transition-colors text-left"
                              >
                                <Users className="w-3 h-3 text-purple-400 shrink-0" />
                                <span className="text-foreground">{p.name}</span>
                                {p.photo_count != null && (
                                  <span className="text-[9px] text-muted-foreground ml-auto">{p.photo_count} photos</span>
                                )}
                              </button>
                            ))}
                        </div>
                      )}
                      {/* Visual similarity suggestions */}
                      {visualSuggs.length > 0 && (
                        <div className="mt-1.5 border-t border-purple-200/30 dark:border-purple-700/20 pt-1">
                          <div className="text-[9px] text-muted-foreground uppercase font-semibold mb-0.5 px-1">Looks like...</div>
                          {visualSuggs.map(vs => (
                            <button
                              key={vs.personId}
                              onClick={async () => {
                                await handleNameFace(vs.personName, face);
                              }}
                              className="w-full flex items-center gap-2 px-1 py-1 rounded text-xs hover:bg-purple-100/50 dark:hover:bg-purple-900/20 transition-colors text-left"
                            >
                              <Eye className="w-3 h-3 text-purple-400 shrink-0" />
                              <span className="text-foreground">{vs.personName}</span>
                              <span className="text-[9px] text-purple-400/60 ml-auto shrink-0">{Math.round(vs.similarity * 100)}% match</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    /* Display mode — click pencil to edit, X to remove name */
                    <div className="flex items-center gap-2.5 px-1.5 py-1.5 rounded hover:bg-secondary/30 transition-colors">
                      {faceCrops[face.id] ? (
                        <img src={faceCrops[face.id]} alt="" className="w-11 h-11 rounded-full object-cover shrink-0 border-2 border-purple-400/40" />
                      ) : (
                        <div className="w-11 h-11 rounded-full bg-purple-500/20 flex items-center justify-center shrink-0">
                          <Users className="w-5 h-5 text-purple-400" />
                        </div>
                      )}
                      <span className={face.person_name ? 'text-foreground font-medium flex-1 min-w-0 truncate text-sm' : 'text-muted-foreground italic flex-1 min-w-0 truncate text-sm'}>
                        {face.person_name || 'Unknown person'}
                      </span>
                      <IconTooltip label={face.person_name ? 'Rename person' : 'Name this person'} side="top">
                        <button
                          onClick={() => {
                            setEditingFaceId(face.id);
                            setFaceNameInput(face.person_name || '');
                            listPersons().then(r => { if (r.success && r.data) setExistingPersons(r.data); });
                            setTimeout(() => faceNameInputRef.current?.focus(), 50);
                          }}
                          className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-purple-100 dark:hover:bg-purple-900/30 transition-all shrink-0"
                        >
                          <Pencil className="w-3 h-3 text-purple-400" />
                        </button>
                      </IconTooltip>
                      {face.person_name && face.person_id && (
                        <IconTooltip label="Remove name" side="top">
                          <button
                            onClick={() => {
                              // Get photo count for this person to show in confirmation
                              listPersons().then(r => {
                                const person = r.data?.find(p => p.id === face.person_id);
                                setConfirmDeletePerson({
                                  personId: face.person_id!,
                                  personName: face.person_name!,
                                  faceId: face.id,
                                  photoCount: (person as any)?.photo_count ?? 0,
                                });
                              });
                            }}
                            className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-red-100 dark:hover:bg-red-900/30 transition-all shrink-0"
                          >
                            <Trash2 className="w-3 h-3 text-red-400" />
                          </button>
                        </IconTooltip>
                      )}
                      <span className="text-sm text-muted-foreground shrink-0 ml-2">{Math.round(face.confidence * 100)}%</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Confirmation dialog for removing a person name */}
        {confirmDeletePerson && (
          <div className="mb-3 mr-10 rounded-lg border border-red-300/60 dark:border-red-700/40 bg-red-50/50 dark:bg-red-950/20 p-3">
            <div className="flex items-start gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <div className="text-xs text-foreground">
                <p className="font-semibold mb-1">Remove "{confirmDeletePerson.personName}"?</p>
                {confirmDeletePerson.photoCount > 1 ? (
                  <p className="text-muted-foreground">This name appears in <strong>{confirmDeletePerson.photoCount} photos</strong>. Choose an action:</p>
                ) : (
                  <p className="text-muted-foreground">Choose an action:</p>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-1.5 ml-6">
              <button
                onClick={async () => {
                  await unnameFace(confirmDeletePerson.faceId);
                  const r = await getAiFaces(file.id);
                  if (r.success && r.data) setFileFaces(r.data);
                  setConfirmDeletePerson(null);
                }}
                className="text-left text-[11px] px-2 py-1.5 rounded bg-secondary/50 hover:bg-secondary transition-colors"
              >
                <span className="font-medium">Remove from this photo only</span>
                <span className="text-muted-foreground block">Un-names this face. "{confirmDeletePerson.personName}" stays available for other photos.</span>
              </button>
              {confirmDeletePerson.photoCount > 0 && (
                <button
                  onClick={async () => {
                    await deletePersonRecord(confirmDeletePerson.personId);
                    const r = await getAiFaces(file.id);
                    if (r.success && r.data) setFileFaces(r.data);
                    setConfirmDeletePerson(null);
                  }}
                  className="text-left text-[11px] px-2 py-1.5 rounded bg-red-100/50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors border border-red-200/50 dark:border-red-800/30"
                >
                  <span className="font-medium text-red-600 dark:text-red-400">Delete "{confirmDeletePerson.personName}" everywhere</span>
                  <span className="text-muted-foreground block">Removes the name from {confirmDeletePerson.photoCount} photo{confirmDeletePerson.photoCount !== 1 ? 's' : ''}. Face detections are kept — you can re-name later.</span>
                </button>
              )}
              <button
                onClick={() => setConfirmDeletePerson(null)}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors px-2 py-1"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Naming scope choice — "this photo only" vs "all matching photos" */}
        {nameScopeChoice && (
          <div className="mb-3 mr-10 rounded-lg border border-purple-300/60 dark:border-purple-700/40 bg-purple-50/50 dark:bg-purple-950/20 p-3">
            <div className="flex items-start gap-2 mb-2">
              <Users className="w-4 h-4 text-purple-500 shrink-0 mt-0.5" />
              <div className="text-xs text-foreground">
                <p className="font-semibold mb-1">Name as "{nameScopeChoice.name}"</p>
                <p className="text-muted-foreground">This face appears in <strong>{nameScopeChoice.clusterPhotoCount} photos</strong>. Where should this name be applied?</p>
              </div>
            </div>
            <div className="flex flex-col gap-1.5 ml-6">
              <button
                onClick={async () => {
                  // Name this photo only — assign to single face, not cluster
                  const personId = await namePerson(nameScopeChoice.name);
                  if (personId.success && personId.data) {
                    // Use assignFace for single face only (import needed)
                    const pdr = (window as any).pdr;
                    if (pdr?.ai) await pdr.ai.assignFace(nameScopeChoice.faceId, personId.data.personId);
                  }
                  const r = await getAiFaces(file.id);
                  if (r.success && r.data) setFileFaces(r.data);
                  setNameScopeChoice(null);
                }}
                className="text-left text-[11px] px-2 py-1.5 rounded bg-secondary/50 hover:bg-secondary transition-colors"
              >
                <span className="font-medium">This photo only</span>
                <span className="text-muted-foreground block">Names this face in this photo. Other matching faces remain unnamed.</span>
              </button>
              <button
                onClick={async () => {
                  // Name all matching faces in the cluster
                  const result = await namePerson(nameScopeChoice.name, nameScopeChoice.clusterId);
                  if (result.success) {
                    const r = await getAiFaces(file.id);
                    if (r.success && r.data) setFileFaces(r.data);
                  }
                  setNameScopeChoice(null);
                }}
                className="text-left text-[11px] px-2 py-1.5 rounded bg-purple-100/50 dark:bg-purple-900/20 hover:bg-purple-100 dark:hover:bg-purple-900/30 transition-colors border border-purple-200/50 dark:border-purple-800/30"
              >
                <span className="font-medium text-purple-600 dark:text-purple-400">All {nameScopeChoice.clusterPhotoCount} matching photos</span>
                <span className="text-muted-foreground block">Names this person across all photos where the AI found a matching face.</span>
              </button>
              <button
                onClick={() => setNameScopeChoice(null)}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors px-2 py-1"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="mr-10">
        <table className="w-full border-collapse">
          <thead className="bg-background">
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
            {/* Scanner override — lets the user flag an unknown scanner or
                undo a false-positive. Only offered when we have both Make
                and Model, since that's the override key. */}
            {file.camera_make && file.camera_model && (
              <ScannerOverrideControl
                make={file.camera_make}
                model={file.camera_model}
                currentConfidence={file.confidence}
              />
            )}
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
        </div>{/* end mr-10 wrapper */}
      </div>
    </div>
  );
}

// ─── Index Manager Modal ─────────────────────────────────────────────────────

function IndexManagerModal({ onClose, onRefresh, stats, onStaleRunsDetected }: { onClose: () => void; onRefresh: () => void; stats: IndexStats | null; onStaleRunsDetected?: (runs: any[]) => void }) {
  const [runs, setRuns] = useState<IndexedRun[]>([]);
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [isIndexingRun, setIsIndexingRun] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [selectedReports, setSelectedReports] = useState<Set<string>>(new Set());
  const [confirmDeleteLive, setConfirmDeleteLive] = useState<string[] | null>(null); // report IDs pending confirmation
  const [allowIndexRemoval] = useState(localStorage.getItem('pdr-allow-index-removal') === 'true');
  const [searchableOpen, setSearchableOpen] = useState(true);
  const [readyOpen, setReadyOpen] = useState(true);
  const [missingOpen, setMissingOpen] = useState(false);
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
    // Auto-trigger AI analysis if enabled AND auto-process is on
    const settings = await getSettings();
    if (settings.aiEnabled && settings.aiAutoProcess) {
      const freshStats = await getAiStats();
      if (freshStats.success && freshStats.data && freshStats.data.unprocessed > 0) {
        startAiProcessing();
      }
    }
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
    // Auto-trigger AI analysis if enabled AND auto-process is on
    const bulkSettings = await getSettings();
    if (bulkSettings.aiEnabled && bulkSettings.aiAutoProcess) {
      const freshStats = await getAiStats();
      if (freshStats.success && freshStats.data && freshStats.data.unprocessed > 0) {
        await startAiProcessing();
      }
    }
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

  // Filter out unindexed reports where the destination no longer exists — these are noise
  const indexableReports = unindexedReports.filter(r => r.destinationExists !== false);
  const missingReports = unindexedReports.filter(r => r.destinationExists === false);

  return (
    <div className="fixed inset-0 bg-black/25 backdrop-blur-[2px] flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-background rounded-2xl shadow-2xl w-[560px] border border-border overflow-hidden flex flex-col max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="relative flex items-center justify-center px-6 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-primary" />
            <h3 className="text-base font-semibold text-foreground">Library Manager</h3>
          </div>
          <button onClick={onClose} className="absolute right-4 top-1/2 -translate-y-1/2 p-1 rounded-lg hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors"><X className="w-4 h-4" /></button>
        </div>

        {/* Stats bar */}
        {stats && (
          <div className="px-6 py-3 border-b border-border bg-secondary/20 shrink-0">
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="Files" value={stats.totalFiles.toLocaleString()} />
              <StatCard label="Photos" value={stats.totalPhotos.toLocaleString()} />
              <StatCard label="Videos" value={stats.totalVideos.toLocaleString()} />
            </div>
          </div>
        )}

        {/* Indexing progress bar — always visible when active */}
        {(isIndexingRun || isIndexingBulk) && (
          <div className="px-6 py-3 border-b border-border bg-primary/5 shrink-0">
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

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">

          {/* Auto-index info */}
          <p className="text-xs text-muted-foreground/70 leading-relaxed">
            New fixes are automatically added to your search library. This manager shows what's currently searchable and lets you add older fixes.
          </p>

          {/* ── Section 1: Searchable (indexed) — collapsible ── */}
          <div className="rounded-xl border border-border overflow-hidden">
            <button
              onClick={() => setSearchableOpen(!searchableOpen)}
              className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-secondary/30 transition-colors"
            >
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider">Searchable</h4>
                <span className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded-full">{runs.length}</span>
              </div>
              <div className="flex items-center gap-2">
                {runs.length > 0 && searchableOpen && (
                  <IconTooltip label="Clean up stale entries and duplicates" side="left">
                    <span
                      onClick={async (e) => {
                        e.stopPropagation();
                        const res = await runSearchCleanup();
                        if (res.success) {
                          await loadData();
                          onRefresh();
                          if (res.data?.staleRuns && res.data.staleRuns.length > 0 && onStaleRunsDetected) {
                            onStaleRunsDetected(res.data.staleRuns);
                          }
                        }
                      }}
                      className="text-[10px] font-medium text-primary hover:text-primary/80 transition-colors flex items-center gap-1 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Clean Up
                    </span>
                  </IconTooltip>
                )}
                {searchableOpen ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
              </div>
            </button>

            {searchableOpen && (
              <div className="px-4 pb-3 border-t border-border pt-2">
                {isLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                  </div>
                ) : runs.length === 0 ? (
                  <div className="p-3 rounded-lg border border-dashed border-border text-center">
                    <p className="text-sm text-muted-foreground">No destinations searchable yet</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">Complete a fix or index a report below to get started</p>
                  </div>
                ) : (
                  <div className="space-y-2">{runs.map(run => (
                    <div key={run.id} className="flex items-center gap-3 p-3 rounded-lg border border-border/50 bg-secondary/10">
                      <div className="flex-1 min-w-0">
                        <IconTooltip label={run.destination_path.replace(/\\\\/g, '\\')} side="top"><p className="text-sm font-medium text-foreground truncate">{run.destination_path.replace(/\\\\/g, '\\')}</p></IconTooltip>
                        <p className="text-xs text-muted-foreground">{run.file_count.toLocaleString()} files · {new Date(run.indexed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}{run.source_labels ? ` · ${run.source_labels}` : ''}</p>
                      </div>
                      {allowIndexRemoval && <IconTooltip label="Remove from library" side="left"><button onClick={() => handleRemoveRun(run.id)} className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 text-muted-foreground hover:text-red-500 dark:hover:text-red-400 transition-colors shrink-0"><Trash2 className="w-3.5 h-3.5" /></button></IconTooltip>}
                    </div>
                  ))}</div>
                )}
                {!allowIndexRemoval && runs.length > 0 && (
                  <p className="text-[10px] text-muted-foreground/70 mt-2 flex items-center gap-1">
                    <Info className="w-3 h-3 shrink-0" />
                    To remove a destination from the library, enable removal in the Pro tab under Settings.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ── Section 2: Ready to make searchable — collapsible ── */}
          {indexableReports.length > 0 && (
            <div className="rounded-xl border border-border overflow-hidden">
              <button
                onClick={() => setReadyOpen(!readyOpen)}
                className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-secondary/30 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                  <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider">Ready to make searchable</h4>
                  <span className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded-full">{indexableReports.length}</span>
                </div>
                <div className="flex items-center gap-2">
                  {indexableReports.length > 1 && readyOpen && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        const indexableIds = new Set(indexableReports.map(r => r.id));
                        const allSelected = indexableReports.every(r => selectedReports.has(r.id));
                        if (allSelected) {
                          setSelectedReports(prev => {
                            const next = new Set(prev);
                            indexableIds.forEach(id => next.delete(id));
                            return next;
                          });
                        } else {
                          setSelectedReports(prev => new Set([...Array.from(prev), ...Array.from(indexableIds)]));
                        }
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                      {indexableReports.every(r => selectedReports.has(r.id)) ? 'Deselect all' : 'Select all'}
                    </span>
                  )}
                  {readyOpen ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
                </div>
              </button>

              {readyOpen && (
                <div className="px-4 pb-3 border-t border-border pt-2 space-y-2">
                  {indexableReports.map(report => {
                    const isSelected = selectedReports.has(report.id);
                    return (
                      <div key={report.id} className={`flex items-center gap-3 p-3 rounded-lg border bg-background transition-colors border-border/50 ${isSelected ? 'ring-1 ring-primary/30 bg-primary/5' : ''}`}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleReportSelection(report.id)}
                          className="w-3.5 h-3.5 rounded border-border text-primary accent-primary cursor-pointer shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <IconTooltip label={report.destinationPath} side="top"><p className="text-sm text-foreground truncate">{report.destinationPath}</p></IconTooltip>
                          <p className="text-xs text-muted-foreground">
                            {report.totalFiles.toLocaleString()} files · {new Date(report.timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </p>
                        </div>
                        <button onClick={() => handleIndexReport(report.id)} disabled={isIndexingRun === report.id || isIndexingBulk}
                          className="px-3 py-1.5 rounded-lg border border-primary/30 text-xs font-medium text-primary hover:bg-primary/5 hover:border-primary/50 transition-all disabled:opacity-50 shrink-0">
                          {isIndexingRun === report.id ? <><Loader2 className="w-3 h-3 animate-spin inline mr-1" />Indexing...</> : <><Plus className="w-3 h-3 inline mr-1" />Index</>}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── Section 3: Missing destinations — collapsible, with remove option ── */}
          {missingReports.length > 0 && (
            <div className="rounded-xl border border-amber-200/50 dark:border-amber-800/30 overflow-hidden">
              <button
                onClick={() => setMissingOpen(!missingOpen)}
                className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-amber-50/30 dark:hover:bg-amber-900/10 transition-colors"
              >
                <span className="flex items-center gap-2 text-xs font-semibold text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {missingReports.length} {missingReports.length === 1 ? 'fix has a' : 'fixes have'} missing {missingReports.length === 1 ? 'destination' : 'destinations'}
                </span>
                {missingOpen ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
              </button>
              {missingOpen && (
                <div className="px-4 pb-3 space-y-2 border-t border-amber-200/30 dark:border-amber-800/20 pt-2">
                  {missingReports.map(report => (
                    <div key={report.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-amber-50/30 dark:bg-amber-900/10">
                      <div className="flex-1 min-w-0">
                        <IconTooltip label={report.destinationPath} side="top"><p className="text-sm text-muted-foreground truncate">{report.destinationPath}</p></IconTooltip>
                        <p className="text-xs text-muted-foreground">
                          {report.totalFiles.toLocaleString()} files · {new Date(report.timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                          {report.destinationStatus === 'drive-missing' && <span className="ml-1.5 text-amber-600 dark:text-amber-400 font-medium">· Drive not connected</span>}
                          {report.destinationStatus === 'folder-missing' && <span className="ml-1.5 text-amber-600 dark:text-amber-400 font-medium">· Folder no longer exists</span>}
                          {!report.destinationStatus && <span className="ml-1.5 text-amber-600 dark:text-amber-400 font-medium">· Location not found</span>}
                        </p>
                      </div>
                      <IconTooltip label="Remove this report" side="left">
                        <button
                          onClick={() => handleDeleteReports([report.id])}
                          className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 text-muted-foreground hover:text-red-500 dark:hover:text-red-400 transition-colors shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </IconTooltip>
                    </div>
                  ))}
                  <p className="text-[10px] text-muted-foreground/60 pt-1">
                    Reconnect the drive or check the folder path. These will become indexable once accessible. You can also remove reports you no longer need.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Confirmation dialog for deleting live reports */}
          {allowIndexRemoval && confirmDeleteLive && (
            <div className="p-3 rounded-xl border border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-900/20">
              <p className="text-sm text-red-600 dark:text-red-400 font-medium mb-1">Some selected reports have valid locations</p>
              <p className="text-xs text-muted-foreground mb-3">
                Removing these reports will permanently delete their fix history. The only way to re-index those files would be to run the fix again, which for large collections could take considerable time. Are you sure?
              </p>
              <div className="flex items-center gap-2">
                <button onClick={() => { handleDeleteReports(confirmDeleteLive); setConfirmDeleteLive(null); }}
                  className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 transition-all">Remove all {confirmDeleteLive.length} selected</button>
                <button onClick={() => {
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

          {allowIndexRemoval && <div className="border-t border-border pt-4">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Danger Zone</h4>
            {!confirmClear ? (
              <button onClick={() => setConfirmClear(true)} className="px-4 py-2 rounded-xl border border-red-200 dark:border-red-800 text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 hover:border-red-300 dark:hover:border-red-700 transition-all">Clear Entire Library</button>
            ) : (
              <div className="flex items-center gap-3">
                <p className="text-sm text-red-500">Remove all searchable data?</p>
                <button onClick={handleRebuild} disabled={isRebuilding} className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 transition-all disabled:opacity-50 shrink-0">{isRebuilding ? 'Clearing...' : 'Confirm'}</button>
                <button onClick={() => setConfirmClear(false)} className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground transition-all shrink-0">Cancel</button>
              </div>
            )}
          </div>}
        </div>

        {/* Sticky footer — bulk actions always visible */}
        {selectedReports.size > 0 && (
          <div className="px-6 py-3 border-t border-border bg-primary/5 shrink-0 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{selectedReports.size} selected</span>
            <div className="flex items-center gap-2">
              <button onClick={handleIndexSelected} disabled={isIndexingBulk}
                className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-all disabled:opacity-50">
                {isIndexingBulk ? <><Loader2 className="w-3 h-3 animate-spin inline mr-1" />Indexing...</> : <>Index {selectedReports.size} selected</>}
              </button>
              {allowIndexRemoval && (
                <button onClick={requestDeleteSelected}
                  className="px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-800 text-xs font-medium text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 transition-all">
                  Remove {selectedReports.size} selected
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── People Manager Modal (moved to PeopleManager.tsx as standalone BrowserWindow) ───

function PeopleManagerModal({ onClose, onRefresh }: { onClose: () => void; onRefresh: () => void }) {
  const [activeTab, setActiveTab] = useState<'named' | 'unnamed' | 'unsure' | 'ignored'>('named');
  const [viewMode, setViewMode] = useState<'list' | 'card'>('card');
  const [clusters, setClusters] = useState<PersonCluster[]>([]);
  const [discardedPersons, setDiscardedPersons] = useState<DiscardedPerson[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [faceCropsMap, setFaceCropsMap] = useState<Record<string, string>>({});
  const [editingCluster, setEditingCluster] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [existingPersons, setExistingPersons] = useState<PersonRecord[]>([]);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<{ personId: number; personName: string; photoCount: number } | null>(null);
  const [confirmPermanentDelete, setConfirmPermanentDelete] = useState<{ personId: number; personName: string } | null>(null);
  const [pendingIgnore, setPendingIgnore] = useState<string | null>(null);
  const [pendingUnsure, setPendingUnsure] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [clusterThreshold, setClusterThreshold] = useState(0.72);
  const [isReclustering, setIsReclustering] = useState(false);
  const [showUnverifiedOnly, setShowUnverifiedOnly] = useState(false);

  // Unique key per cluster entry: named clusters keyed by person_id, unnamed by cluster_id
  // This prevents avatar mix-ups when faces from the same original cluster are assigned to different people
  const clusterKey = (c: PersonCluster) => c.person_id ? `p${c.person_id}` : `c${c.cluster_id}`;

  const loadClusters = async () => {
    setIsLoading(true);
    const result = await getPersonClusters();
    if (result.success && result.data) {
      setClusters(result.data);
      const crops: Record<string, string> = {};
      await Promise.all(result.data.map(async (cluster) => {
        const key = clusterKey(cluster);
        if (cluster.representative_file_path && cluster.box_w > 0) {
          const crop = await getFaceCrop(
            cluster.representative_file_path,
            cluster.box_x, cluster.box_y, cluster.box_w, cluster.box_h,
            96
          );
          if (crop.success && crop.dataUrl) {
            crops[key] = crop.dataUrl;
          }
        }
        if (cluster.sample_faces) {
          for (const face of cluster.sample_faces.slice(0, 20)) {
            const crop = await getFaceCrop(face.file_path, face.box_x, face.box_y, face.box_w, face.box_h, 64);
            if (crop.success && crop.dataUrl) crops[face.face_id] = crop.dataUrl;
          }
        }
      }));
      setFaceCropsMap(crops);
    }
    const persons = await listPersons();
    if (persons.success && persons.data) setExistingPersons(persons.data);
    const discarded = await listDiscardedPersons();
    if (discarded.success && discarded.data) setDiscardedPersons(discarded.data);
    setIsLoading(false);
  };

  useEffect(() => { loadClusters(); }, []);

  useEffect(() => {
    if (!isLoading) {
      const named = clusters.filter(c => c.person_name && c.person_name !== '__ignored__' && c.person_name !== '__unsure__');
      const unnamed = clusters.filter(c => !c.person_name);
      if (activeTab === 'named' && named.length === 0 && unnamed.length > 0) {
        setActiveTab('unnamed');
      }
    }
  }, [isLoading, clusters]);

  const handleNameCluster = async (clusterId: number, name: string) => {
    if (!name.trim()) return;
    setEditingCluster(null);
    setNameInput('');
    const result = await namePerson(name.trim(), clusterId);
    if (result.success) { await loadClusters(); onRefresh(); }
  };

  const handleRename = async (personId: number, newName: string) => {
    if (!newName.trim()) return;
    await renamePerson(personId, newName.trim());
    setEditingCluster(null); setNameInput('');
    await loadClusters(); onRefresh();
  };

  const handleDiscardPerson = async (personId: number) => {
    await deletePersonRecord(personId);
    setConfirmDiscard(null);
    await loadClusters(); onRefresh();
  };

  const handleRecluster = async (threshold: number) => {
    setIsReclustering(true);
    await reclusterFaces(threshold);
    await loadClusters();
    onRefresh();
    setIsReclustering(false);
  };

  const handleIgnoreCluster = async (clusterId: number) => {
    await namePerson('__ignored__', clusterId);
    setPendingIgnore(null);
    await loadClusters(); onRefresh();
  };

  const handleUnsureCluster = async (clusterId: number) => {
    await namePerson('__unsure__', clusterId);
    setPendingUnsure(null);
    await loadClusters(); onRefresh();
  };

  const handleRestoreToUnnamed = async (clusterId: number, personId: number | null) => {
    // Unname the cluster's person to move it back to Unnamed
    if (personId) {
      await deletePersonRecord(personId);
      await loadClusters(); onRefresh();
    }
  };

  const handleRestorePerson = async (personId: number) => {
    await restorePerson(personId);
    await loadClusters(); onRefresh();
  };

  const handlePermanentDelete = async (personId: number) => {
    await permanentlyDeletePerson(personId);
    setConfirmPermanentDelete(null);
    await loadClusters(); onRefresh();
  };

  const handleReassignFace = async (faceId: number, newName: string, verified: boolean = true) => {
    if (newName === '__unnamed__') {
      // Move face back to unnamed — clear person_id and verified flag
      await unnameFace(faceId);
      await loadClusters(); onRefresh();
      return;
    }
    // Create or find the target person, then assign this face to them
    const personResult = await namePerson(newName);
    if (personResult.success && personResult.data?.personId) {
      await assignFace(faceId, personResult.data.personId, verified);
      await loadClusters(); onRefresh();
    }
  };

  const namedClusters = clusters.filter(c => c.person_name && c.person_name !== '__ignored__' && c.person_name !== '__unsure__');
  const unnamedClusters = clusters.filter(c => !c.person_name);
  const ignoredClusters = clusters.filter(c => c.person_name === '__ignored__');
  const unsureClusters = clusters.filter(c => c.person_name === '__unsure__');

  // Sort sample faces: unverified first, verified last. Optionally filter out verified.
  const prepareFaces = (cluster: PersonCluster): PersonCluster => {
    if (!cluster.sample_faces) return cluster;
    let faces = [...cluster.sample_faces].sort((a, b) => (a.verified || 0) - (b.verified || 0));
    if (showUnverifiedOnly) faces = faces.filter(f => !f.verified);
    return { ...cluster, sample_faces: faces };
  };

  const filteredNamed = (searchFilter
    ? namedClusters.filter(c => c.person_name?.toLowerCase().includes(searchFilter.toLowerCase()))
    : namedClusters
  ).map(prepareFaces);

  const tabCounts = {
    named: namedClusters.length,
    unnamed: unnamedClusters.length,
    unsure: unsureClusters.length,
    ignored: ignoredClusters.length,
  };

  const pmTabClass = (tab: string) =>
    `flex-1 text-center px-3 py-2.5 text-sm font-medium cursor-pointer transition-all duration-200 border-b-2 ${
      activeTab === tab
        ? 'border-purple-500 text-purple-600 dark:text-purple-400 bg-background'
        : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30 bg-muted/40'
    } ${tab === 'named' ? 'rounded-tl-lg' : ''} ${tab === 'ignored' ? 'rounded-tr-lg' : ''}`;

  return (
    <AnimatePresence>
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
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-purple-500/10 flex items-center justify-center">
                <Users className="w-5 h-5 text-purple-500" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">People</h2>
                <p className="text-[11px] text-muted-foreground">
                  {namedClusters.length} named · {unnamedClusters.length} unnamed
                  {unsureClusters.length > 0 && ` · ${unsureClusters.length} unsure`}
                  {ignoredClusters.length > 0 && ` · ${ignoredClusters.length} ignored`}
                </p>
              </div>
            </div>
            <div className="flex flex-col items-center flex-1 mx-4 max-w-[200px]">
              <span className="text-[9px] text-muted-foreground/70 font-medium uppercase tracking-wider mb-0.5">Match</span>
              <div className="flex items-center gap-2 w-full">
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">Loose</span>
              <input
                type="range"
                min="0.65"
                max="0.95"
                step="0.01"
                value={clusterThreshold}
                onChange={(e) => setClusterThreshold(parseFloat(e.target.value))}
                onMouseUp={() => handleRecluster(clusterThreshold)}
                onTouchEnd={() => handleRecluster(clusterThreshold)}
                className="w-full h-1 accent-purple-500 cursor-pointer"
                disabled={isReclustering}
              />
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">Strict</span>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Tab Bar */}
          <div className="flex border-b border-border mb-0">
            <div className="flex flex-1">
              <button type="button" className={pmTabClass('named')} onClick={() => { setActiveTab('named'); setSearchFilter(''); }}>
                <span className="flex items-center justify-center gap-1.5">
                  Named
                  {tabCounts.named > 0 && <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400">{tabCounts.named}</span>}
                </span>
              </button>
              <div className="w-px bg-border/60 my-2" />
              <button type="button" className={pmTabClass('unnamed')} onClick={() => { setActiveTab('unnamed'); setSearchFilter(''); }}>
                <span className="flex items-center justify-center gap-1.5">
                  Unnamed
                  {tabCounts.unnamed > 0 && <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">{tabCounts.unnamed}</span>}
                </span>
              </button>
              <div className="w-px bg-border/60 my-2" />
              <button type="button" className={pmTabClass('unsure')} onClick={() => { setActiveTab('unsure'); setSearchFilter(''); }}>
                <span className="flex items-center justify-center gap-1.5">
                  Unsure
                  {tabCounts.unsure > 0 && <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">{tabCounts.unsure}</span>}
                </span>
              </button>
              <div className="w-px bg-border/60 my-2" />
              <button type="button" className={pmTabClass('ignored')} onClick={() => { setActiveTab('ignored'); setSearchFilter(''); }}>
                <span className="flex items-center justify-center gap-1.5">
                  Ignored
                  {tabCounts.ignored > 0 && <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-slate-200 dark:bg-slate-700/40 text-slate-500">{tabCounts.ignored}</span>}
                </span>
              </button>
            </div>
            <div className="flex items-center gap-2 pb-1">
              {activeTab === 'named' && (
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    value={searchFilter}
                    onChange={e => setSearchFilter(e.target.value)}
                    placeholder="Filter..."
                    className="pl-8 pr-3 py-1 text-xs rounded-md border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground/70 w-[120px] focus:outline-none focus:ring-1 focus:ring-purple-400/50"
                  />
                  {searchFilter && (
                    <button onClick={() => setSearchFilter('')} className="absolute right-2 top-1/2 -translate-y-1/2">
                      <X className="w-3 h-3 text-muted-foreground hover:text-foreground" />
                    </button>
                  )}
                </div>
              )}
              {activeTab === 'named' && (
                <IconTooltip label={showUnverifiedOnly ? 'Showing unverified only' : 'Show all faces'} side="bottom">
                  <button
                    onClick={() => setShowUnverifiedOnly(!showUnverifiedOnly)}
                    className={`p-1 rounded transition-all ${showUnverifiedOnly ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-500' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    <Eye className="w-3.5 h-3.5" />
                  </button>
                </IconTooltip>
              )}
              {(activeTab === 'named' || activeTab === 'unnamed') && (
                <div className="flex items-center bg-secondary/40 rounded-md p-0.5">
                  <IconTooltip label="Card view" side="bottom">
                    <button
                      onClick={() => setViewMode('card')}
                      className={`p-1 rounded transition-all ${viewMode === 'card' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      <Grid3X3 className="w-3.5 h-3.5" />
                    </button>
                  </IconTooltip>
                  <IconTooltip label="List view" side="bottom">
                    <button
                      onClick={() => setViewMode('list')}
                      className={`p-1 rounded transition-all ${viewMode === 'list' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      <LayoutList className="w-3.5 h-3.5" />
                    </button>
                  </IconTooltip>
                </div>
              )}
            </div>
          </div>

          {/* Scrollable Content */}
          <div className="h-[45vh] overflow-y-auto pr-2 pt-4">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
                <span className="ml-2 text-sm text-muted-foreground">Loading face clusters...</span>
              </div>
            ) : clusters.length === 0 && discardedPersons.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Users className="w-12 h-12 text-muted-foreground/20 mb-3" />
                <h3 className="text-sm font-semibold text-foreground mb-1">No faces detected yet</h3>
                <p className="text-xs text-muted-foreground max-w-xs">
                  Run AI analysis on your photos to detect faces. Similar faces will be automatically grouped together.
                </p>
              </div>
            ) : (
              <>
                {/* Discard confirmation banner (for Named tab) */}
                {confirmDiscard && (
                  <div className="rounded-xl border border-amber-300/60 dark:border-amber-700/40 bg-amber-50/50 dark:bg-amber-950/20 p-4 mb-4">
                    <div className="flex items-start gap-3 mb-3">
                      <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                      <div>
                        <h4 className="text-sm font-semibold text-foreground mb-1">Discard "{confirmDiscard.personName}"?</h4>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          This will remove the name from <strong>{confirmDiscard.photoCount} photo{confirmDiscard.photoCount !== 1 ? 's' : ''}</strong>.
                          Face detections are kept — you can re-name faces later.
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-8">
                      <button onClick={() => handleDiscardPerson(confirmDiscard.personId)} className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-medium transition-colors">
                        Discard
                      </button>
                      <button onClick={() => setConfirmDiscard(null)} className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary text-xs font-medium transition-colors">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* ─── NAMED TAB ─── */}
                {activeTab === 'named' && (
                  <>
                    {filteredNamed.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-12 text-center">
                        <Users className="w-10 h-10 text-muted-foreground/20 mb-3" />
                        <h3 className="text-sm font-medium text-foreground mb-1">
                          {searchFilter ? 'No matches' : 'No named people yet'}
                        </h3>
                        <p className="text-xs text-muted-foreground max-w-xs">
                          {searchFilter ? `No names matching "${searchFilter}".` : 'Switch to the Unnamed tab to start naming detected faces.'}
                        </p>
                      </div>
                    ) : viewMode === 'card' ? (
                      <div className="space-y-2">
                        {filteredNamed.map((cluster) => (
                          <PersonCardRow
                            key={clusterKey(cluster)}
                            cluster={cluster}
                            cropUrl={faceCropsMap[clusterKey(cluster)]}
                            sampleCrops={faceCropsMap}
                            isEditing={editingCluster === clusterKey(cluster)}
                            nameInput={nameInput}
                            onStartEdit={() => { setEditingCluster(clusterKey(cluster)); setNameInput(cluster.person_name || ''); setTimeout(() => nameInputRef.current?.focus(), 50); }}
                            onNameChange={setNameInput}
                            onSubmit={() => cluster.person_id ? handleRename(cluster.person_id, nameInput) : handleNameCluster(cluster.cluster_id, nameInput)}
                            onCancel={() => { setEditingCluster(null); setNameInput(''); }}
                            inputRef={nameInputRef}
                            existingPersons={existingPersons}
                            onSelectPerson={(name) => handleNameCluster(cluster.cluster_id, name)}
                            onDiscard={cluster.person_id ? () => { setConfirmDiscard({ personId: cluster.person_id!, personName: cluster.person_name!, photoCount: cluster.photo_count }); } : undefined}
                            onReassignFace={handleReassignFace}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="space-y-0.5">
                        {filteredNamed.map((cluster) => (
                          <PersonListRow
                            key={clusterKey(cluster)} cluster={cluster} cropUrl={faceCropsMap[clusterKey(cluster)]} sampleCrops={faceCropsMap}
                            isEditing={editingCluster === clusterKey(cluster)} nameInput={nameInput}
                            onStartEdit={() => { setEditingCluster(clusterKey(cluster)); setNameInput(cluster.person_name || ''); setTimeout(() => nameInputRef.current?.focus(), 50); }}
                            onNameChange={setNameInput}
                            onSubmit={() => cluster.person_id ? handleRename(cluster.person_id, nameInput) : handleNameCluster(cluster.cluster_id, nameInput)}
                            onCancel={() => { setEditingCluster(null); setNameInput(''); }}
                            inputRef={nameInputRef}
                            onDiscard={cluster.person_id ? () => { setConfirmDiscard({ personId: cluster.person_id!, personName: cluster.person_name!, photoCount: cluster.photo_count }); } : undefined}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* ─── UNNAMED TAB ─── */}
                {activeTab === 'unnamed' && (
                  <>
                    {unnamedClusters.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-12 text-center">
                        <CheckCircle2 className="w-10 h-10 text-green-400/40 mb-3" />
                        <h3 className="text-sm font-medium text-foreground mb-1">All groups are named</h3>
                        <p className="text-xs text-muted-foreground max-w-xs">Every detected face group has been assigned a name, marked unsure, or ignored.</p>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-start gap-3 p-3 rounded-xl bg-purple-50/50 dark:bg-purple-950/20 border border-purple-200/30 dark:border-purple-800/20 mb-4">
                          <Sparkles className="w-4 h-4 text-purple-500 shrink-0 mt-0.5" />
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            Click a group to name it. Don't recognize someone? Use <strong>Unsure</strong> to revisit later, or <strong>Ignore</strong> to hide them permanently.
                          </p>
                        </div>
                        {viewMode === 'card' ? (
                          <div className="space-y-2">
                            {unnamedClusters.map((cluster) => (
                              <PersonCardRow
                                key={clusterKey(cluster)}
                                cluster={cluster}
                                cropUrl={faceCropsMap[clusterKey(cluster)]}
                                sampleCrops={faceCropsMap}
                                isEditing={editingCluster === clusterKey(cluster)}
                                nameInput={nameInput}
                                onStartEdit={() => { setEditingCluster(clusterKey(cluster)); setNameInput(''); setTimeout(() => nameInputRef.current?.focus(), 50); }}
                                onNameChange={setNameInput}
                                onSubmit={() => handleNameCluster(cluster.cluster_id, nameInput)}
                                onCancel={() => { setEditingCluster(null); setNameInput(''); }}
                                inputRef={nameInputRef}
                                existingPersons={existingPersons}
                                onSelectPerson={(name) => handleNameCluster(cluster.cluster_id, name)}
                                pendingIgnore={pendingIgnore === clusterKey(cluster)}
                                onIgnore={() => setPendingIgnore(clusterKey(cluster))}
                                onConfirmIgnore={() => handleIgnoreCluster(cluster.cluster_id)}
                                onCancelIgnore={() => setPendingIgnore(null)}
                                pendingUnsure={pendingUnsure === clusterKey(cluster)}
                                onUnsure={() => setPendingUnsure(clusterKey(cluster))}
                                onConfirmUnsure={() => handleUnsureCluster(cluster.cluster_id)}
                                onCancelUnsure={() => setPendingUnsure(null)}
                                onReassignFace={handleReassignFace}
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="space-y-0.5">
                            {unnamedClusters.map((cluster) => (
                              <PersonListRow
                                key={clusterKey(cluster)} cluster={cluster} cropUrl={faceCropsMap[clusterKey(cluster)]} sampleCrops={faceCropsMap}
                                isEditing={editingCluster === clusterKey(cluster)} nameInput={nameInput}
                                onStartEdit={() => { setEditingCluster(clusterKey(cluster)); setNameInput(''); setTimeout(() => nameInputRef.current?.focus(), 50); }}
                                onNameChange={setNameInput}
                                onSubmit={() => handleNameCluster(cluster.cluster_id, nameInput)}
                                onCancel={() => { setEditingCluster(null); setNameInput(''); }}
                                inputRef={nameInputRef}
                                pendingIgnore={pendingIgnore === clusterKey(cluster)}
                                onIgnore={() => setPendingIgnore(clusterKey(cluster))}
                                onConfirmIgnore={() => handleIgnoreCluster(cluster.cluster_id)}
                                onCancelIgnore={() => setPendingIgnore(null)}
                                pendingUnsure={pendingUnsure === clusterKey(cluster)}
                                onUnsure={() => setPendingUnsure(clusterKey(cluster))}
                                onConfirmUnsure={() => handleUnsureCluster(cluster.cluster_id)}
                                onCancelUnsure={() => setPendingUnsure(null)}
                              />
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}

                {/* ─── UNSURE TAB ─── */}
                {activeTab === 'unsure' && (
                  <>
                    {unsureClusters.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-12 text-center">
                        <HelpCircle className="w-10 h-10 text-muted-foreground/20 mb-3" />
                        <h3 className="text-sm font-medium text-foreground mb-1">No unsure faces</h3>
                        <p className="text-xs text-muted-foreground max-w-xs">
                          Faces you mark as "Unsure" from the Unnamed tab will appear here so you can revisit them later.
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-start gap-3 p-3 rounded-xl bg-blue-50/50 dark:bg-blue-950/20 border border-blue-200/30 dark:border-blue-800/20 mb-4">
                          <HelpCircle className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            These are faces you weren't sure about. Click to name them, or move them to Ignored if you'll never know.
                          </p>
                        </div>
                        <div className="space-y-2">
                          {unsureClusters.map((cluster) => (
                            <PersonCardRow
                              key={clusterKey(cluster)}
                              cluster={cluster}
                              cropUrl={faceCropsMap[clusterKey(cluster)]}
                              sampleCrops={faceCropsMap}
                              isEditing={editingCluster === clusterKey(cluster)}
                              nameInput={nameInput}
                              onStartEdit={() => { setEditingCluster(clusterKey(cluster)); setNameInput(''); setTimeout(() => nameInputRef.current?.focus(), 50); }}
                              onNameChange={setNameInput}
                              onSubmit={() => handleNameCluster(cluster.cluster_id, nameInput)}
                              onCancel={() => { setEditingCluster(null); setNameInput(''); }}
                              inputRef={nameInputRef}
                              existingPersons={existingPersons}
                              onSelectPerson={(name) => handleNameCluster(cluster.cluster_id, name)}
                              displayName="Unsure"
                              pendingIgnore={pendingIgnore === clusterKey(cluster)}
                              onIgnore={() => setPendingIgnore(clusterKey(cluster))}
                              onConfirmIgnore={() => handleIgnoreCluster(cluster.cluster_id)}
                              onCancelIgnore={() => setPendingIgnore(null)}
                              onRestore={() => handleRestoreToUnnamed(cluster.cluster_id, cluster.person_id)}
                              onReassignFace={handleReassignFace}
                            />
                          ))}
                        </div>
                      </>
                    )}
                  </>
                )}

                {/* ─── IGNORED TAB ─── */}
                {activeTab === 'ignored' && (
                  <>
                    {ignoredClusters.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-12 text-center">
                        <UserX className="w-10 h-10 text-muted-foreground/20 mb-3" />
                        <h3 className="text-sm font-medium text-foreground mb-1">No ignored faces</h3>
                        <p className="text-xs text-muted-foreground max-w-xs">
                          Faces you ignore from the Unnamed tab will appear here. You can restore them or delete permanently.
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-start gap-3 p-3 rounded-xl bg-slate-50/50 dark:bg-slate-900/20 border border-slate-200/30 dark:border-slate-700/20 mb-4">
                          <Info className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            These faces have been ignored. You can restore them back to Unnamed, or delete them permanently.
                          </p>
                        </div>
                        <div className="space-y-2">
                          {ignoredClusters.map((cluster) => (
                            <div key={clusterKey(cluster)} className="flex items-center gap-3 p-4 rounded-xl border border-border hover:border-border/80 transition-all group">
                              {/* Avatar */}
                              {faceCropsMap[clusterKey(cluster)] ? (
                                <img src={faceCropsMap[clusterKey(cluster)]} alt="" className="w-14 h-14 rounded-full object-cover shrink-0 border border-slate-300/50" />
                              ) : (
                                <div className="w-14 h-14 rounded-full bg-slate-500/10 flex items-center justify-center shrink-0">
                                  <UserX className="w-6 h-6 text-slate-400" />
                                </div>
                              )}
                              {/* Info */}
                              <div className="min-w-0 w-[120px] shrink-0">
                                <p className="text-sm font-medium text-muted-foreground italic">Ignored</p>
                                <p className="text-[10px] text-muted-foreground">
                                  {cluster.face_count} {cluster.face_count === 1 ? 'face' : 'faces'} · {cluster.photo_count} {cluster.photo_count === 1 ? 'photo' : 'photos'}
                                </p>
                              </div>
                              {/* Sample thumbnails */}
                              {cluster.sample_faces && cluster.sample_faces.length > 0 && (
                                <div
                                  className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent pb-1"
                                  ref={(el) => {
                                    if (!el) return;
                                    (el as any).__wheelHandler ??= ((e: WheelEvent) => { if (e.deltaY !== 0) { el.scrollLeft += e.deltaY; e.preventDefault(); e.stopPropagation(); } });
                                    el.removeEventListener('wheel', (el as any).__wheelHandler);
                                    el.addEventListener('wheel', (el as any).__wheelHandler, { passive: false });
                                  }}
                                >
                                  {cluster.sample_faces.map(face => (
                                    <div key={face.face_id} className="shrink-0">
                                      {faceCropsMap[face.face_id] ? (
                                        <img src={faceCropsMap[face.face_id]} alt="" className={`w-10 h-10 rounded-full object-cover ${face.verified ? 'border-2 border-orange-400' : 'border border-border/50'}`} />
                                      ) : (
                                        <div className="w-10 h-10 rounded-full bg-secondary" />
                                      )}
                                    </div>
                                  ))}
                                  {cluster.face_count > cluster.sample_faces.length && <span className="text-[10px] text-muted-foreground ml-1 shrink-0">+{cluster.face_count - cluster.sample_faces.length}</span>}
                                </div>
                              )}
                              {/* Actions */}
                              <div className="flex items-center gap-1.5 shrink-0">
                                <IconTooltip label="Move back to Unnamed" side="left">
                                  <button
                                    onClick={() => handleRestoreToUnnamed(cluster.cluster_id, cluster.person_id)}
                                    className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium border border-border bg-background hover:bg-secondary text-foreground transition-colors"
                                  >
                                    <Undo2 className="w-3.5 h-3.5" />
                                    Restore
                                  </button>
                                </IconTooltip>
                                <IconTooltip label="Delete permanently" side="left">
                                  <button
                                    onClick={() => cluster.person_id && setConfirmPermanentDelete({ personId: cluster.person_id, personName: 'Ignored face group' })}
                                    className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium border border-red-300/50 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                    Delete
                                  </button>
                                </IconTooltip>
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    {/* Permanent delete confirmation */}
                    {confirmPermanentDelete && (
                      <div className="rounded-xl border border-red-300/60 dark:border-red-700/40 bg-red-50/50 dark:bg-red-950/20 p-4 mt-4">
                        <div className="flex items-start gap-3 mb-3">
                          <ShieldAlert className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                          <div>
                            <h4 className="text-sm font-semibold text-foreground mb-1">Permanently delete?</h4>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              This will permanently remove this face group and all associated AI data. This action cannot be undone.
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 ml-8">
                          <button onClick={() => handlePermanentDelete(confirmPermanentDelete.personId)} className="px-3 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white text-xs font-medium transition-colors">
                            Permanently delete
                          </button>
                          <button onClick={() => setConfirmPermanentDelete(null)} className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary text-xs font-medium transition-colors">
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div className="mt-6 pt-4 border-t border-border">
            <button onClick={onClose} className="w-full px-4 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">
              Done
            </button>
            <p className="text-center text-xs text-muted-foreground mt-3">
              {namedClusters.length} named · {unnamedClusters.length} unnamed · {unsureClusters.length} unsure · {ignoredClusters.length} ignored
            </p>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

/* ─── Face Grid Modal — paginated grid of all faces, confidence-sorted ──── */

function FaceGridModal({ cluster, cropUrl, existingPersons, onReassignFace, onClose, onRefresh }: {
  cluster: PersonCluster;
  cropUrl?: string;
  existingPersons: PersonRecord[];
  onReassignFace: (faceId: number, newName: string, verified?: boolean) => Promise<void>;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<ClusterFacesResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [faceCrops, setFaceCrops] = useState<Record<number, string>>({});
  const [reassignFaceId, setReassignFaceId] = useState<number | null>(null);
  const [reassignName, setReassignName] = useState('');
  const reassignInputRef = useRef<HTMLInputElement>(null);
  const PER_PAGE = 40;

  const loadPage = async (p: number) => {
    setIsLoading(true);
    const result = await getClusterFaces(cluster.cluster_id, p, PER_PAGE, cluster.person_id ?? undefined);
    if (result.success && result.data) {
      setData(result.data);
      // Load crops for this page
      const crops: Record<number, string> = {};
      await Promise.all(result.data.faces.map(async (face) => {
        const crop = await getFaceCrop(face.file_path, face.box_x, face.box_y, face.box_w, face.box_h, 96);
        if (crop.success && crop.dataUrl) crops[face.face_id] = crop.dataUrl;
      }));
      setFaceCrops(prev => ({ ...prev, ...crops }));
    }
    setIsLoading(false);
  };

  useEffect(() => { loadPage(0); }, []);

  const handleReassign = async (faceId: number, name: string, verified: boolean = true) => {
    if (!name.trim()) return;
    await onReassignFace(faceId, name.trim(), verified);
    setReassignFaceId(null);
    setReassignName('');
    // Reload to reflect the change
    await loadPage(page);
  };

  const reassignSuggestions = (existingPersons || [])
    .filter(p => reassignName.length > 0 && p.name.toLowerCase().includes(reassignName.toLowerCase()) && (p.photo_count ?? 0) > 0)
    .slice(0, 4);

  const confidenceColor = (conf: number) => {
    if (conf >= 0.85) return 'text-green-500';
    if (conf >= 0.6) return 'text-amber-500';
    return 'text-red-500';
  };

  const confidenceLabel = (conf: number) => {
    if (conf >= 0.85) return 'High';
    if (conf >= 0.6) return 'Medium';
    return 'Low';
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 bg-black/[0.35] backdrop-blur-[2px] flex items-center justify-center z-[60] p-4"
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-background rounded-2xl shadow-2xl max-w-3xl w-full p-6"
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              {cropUrl && <img src={cropUrl} alt="" className="w-10 h-10 rounded-full object-cover border-2 border-purple-400/40" />}
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  {cluster.person_name && cluster.person_name !== '__ignored__' && cluster.person_name !== '__unsure__'
                    ? cluster.person_name
                    : 'Unknown person'}
                </h2>
                <p className="text-[11px] text-muted-foreground">
                  {cluster.face_count} faces across {cluster.photo_count} photos · sorted by confidence (lowest first)
                </p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Grid */}
          <div className="h-[55vh] overflow-y-auto pr-2">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
                <span className="ml-2 text-sm text-muted-foreground">Loading faces...</span>
              </div>
            ) : data && data.faces.length > 0 ? (
              <div className="grid grid-cols-8 gap-2">
                {data.faces.map((face) => (
                  <Popover key={face.face_id} open={reassignFaceId === face.face_id} onOpenChange={(open) => { if (!open) { setReassignFaceId(null); setReassignName(''); } }}>
                    <PopoverTrigger asChild>
                      <div
                        className="relative group cursor-pointer"
                        onClick={() => { setReassignFaceId(face.face_id); setReassignName(''); setTimeout(() => reassignInputRef.current?.focus(), 100); }}
                      >
                        {faceCrops[face.face_id] ? (
                          <img src={faceCrops[face.face_id]} alt="" className={`w-full aspect-square rounded-lg object-cover hover:ring-2 hover:ring-purple-400/50 transition-all ${face.verified ? 'border-2 border-orange-400' : 'border border-border/50'}`} />
                        ) : (
                          <div className={`w-full aspect-square rounded-lg bg-secondary flex items-center justify-center ${face.verified ? 'border-2 border-orange-400' : ''}`}>
                            <Users className="w-4 h-4 text-muted-foreground/70" />
                          </div>
                        )}
                        {/* Confidence indicator */}
                        <span className={`absolute bottom-0.5 right-0.5 text-[8px] font-bold px-1 py-0.5 rounded bg-background/80 backdrop-blur-sm ${confidenceColor(face.confidence)}`}>
                          {Math.round(face.confidence * 100)}%
                        </span>
                      </div>
                    </PopoverTrigger>
                    {/* Reassign popover */}
                    <PopoverContent side="top" align="center" className="w-64 p-3 z-[60]" onOpenAutoFocus={(e) => e.preventDefault()} collisionPadding={8}>
                      <div className="space-y-2">
                        {faceCrops[face.face_id] && (
                          <div className="flex justify-center">
                            <img src={faceCrops[face.face_id]} alt="" className="w-16 h-16 rounded-full object-cover border-2 border-purple-400/40" />
                          </div>
                        )}
                        <p className="text-[10px] text-center text-muted-foreground">
                          Confidence: <span className={`font-semibold ${confidenceColor(face.confidence)}`}>{confidenceLabel(face.confidence)} ({Math.round(face.confidence * 100)}%)</span>
                        </p>
                        <p className="text-xs text-muted-foreground text-center">Choose an action for this face</p>
                        <input
                          ref={reassignInputRef}
                          type="text"
                          value={reassignName}
                          onChange={(e) => setReassignName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && reassignName.trim()) handleReassign(face.face_id, reassignName); if (e.key === 'Escape') { setReassignFaceId(null); setReassignName(''); } }}
                          placeholder="Type person name..."
                          className="w-full text-sm px-2.5 py-1.5 rounded-lg border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-purple-400/50"
                          autoFocus
                        />
                        {reassignSuggestions.length > 0 && (
                          <div className="space-y-0.5">
                            {reassignSuggestions.map(p => (
                              <button key={p.id} onClick={() => { setReassignName(p.name); }}
                                className="w-full flex items-center gap-2 px-2 py-1 rounded text-xs hover:bg-purple-100/50 dark:hover:bg-purple-900/20 transition-colors text-left">
                                <Users className="w-3 h-3 text-purple-400 shrink-0" />
                                <span className="truncate">{p.name}</span>
                                <span className="text-[9px] text-muted-foreground ml-auto shrink-0">{p.photo_count}</span>
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="flex gap-1.5">
                          <button onClick={() => handleReassign(face.face_id, reassignName)} disabled={!reassignName.trim()}
                            className="flex-1 px-2 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors">
                            Verify
                          </button>
                          <button onClick={() => { setReassignFaceId(null); setReassignName(''); }}
                            className="px-2 py-1.5 rounded-lg border border-border hover:bg-secondary text-xs font-medium transition-colors">
                            Cancel
                          </button>
                        </div>
                        <div className="flex gap-1.5 pt-1 border-t border-border">
                          <button onClick={() => handleReassign(face.face_id, '__unsure__')}
                            data-pdr-variant="information" className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors" style={{ backgroundColor: '#dbeafe', borderColor: '#3b82f6', color: '#1e3a8a', borderWidth: '1px', borderStyle: 'solid' }}>
                            <HelpCircle className="w-3 h-3" /> Unsure
                          </button>
                          <button onClick={() => handleReassign(face.face_id, '__unnamed__')}
                            data-pdr-variant="caution" className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors" style={{ backgroundColor: '#fde68a', borderColor: '#f59e0b', color: '#78350f', borderWidth: '1px', borderStyle: 'solid' }}>
                            <Users className="w-3 h-3" /> Unnamed
                          </button>
                          <button onClick={() => handleReassign(face.face_id, '__ignored__')}
                            className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-slate-300/50 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/30 text-xs font-medium transition-colors">
                            <UserX className="w-3 h-3" /> Ignore
                          </button>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Users className="w-10 h-10 text-muted-foreground/20 mb-3" />
                <p className="text-sm text-muted-foreground">No faces found</p>
              </div>
            )}
          </div>

          {/* Pagination */}
          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-3 border-t border-border">
              <button
                onClick={() => { const p = Math.max(0, page - 1); setPage(p); loadPage(p); }}
                disabled={page === 0}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border bg-background hover:bg-secondary text-sm font-medium disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" /> Previous
              </button>
              <span className="text-sm text-muted-foreground">
                Page {page + 1} of {data.totalPages} · {data.total} faces
              </span>
              <button
                onClick={() => { const p = Math.min(data.totalPages - 1, page + 1); setPage(p); loadPage(p); }}
                disabled={page >= data.totalPages - 1}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border bg-background hover:bg-secondary text-sm font-medium disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Footer */}
          <div className="mt-4 pt-3 border-t border-border">
            <button onClick={onClose} className="w-full px-4 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">
              Done
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

/* ─── Card Row — name LEFT, scrollable thumbnails RIGHT ─────────────────── */

function PersonCardRow({ cluster, cropUrl, sampleCrops, isEditing, nameInput, onStartEdit, onNameChange, onSubmit, onCancel, inputRef, existingPersons, onSelectPerson, onDiscard, pendingIgnore, onIgnore, onConfirmIgnore, onCancelIgnore, pendingUnsure, onUnsure, onConfirmUnsure, onCancelUnsure, onRestore, displayName, onReassignFace }: {
  cluster: PersonCluster;
  cropUrl?: string;
  sampleCrops: Record<string, string>;
  isEditing: boolean;
  nameInput: string;
  onStartEdit: () => void;
  onNameChange: (name: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  existingPersons?: PersonRecord[];
  onSelectPerson?: (name: string) => void;
  onDiscard?: () => void;
  pendingIgnore?: boolean;
  onIgnore?: () => void;
  onConfirmIgnore?: () => void;
  onCancelIgnore?: () => void;
  pendingUnsure?: boolean;
  onUnsure?: () => void;
  onConfirmUnsure?: () => void;
  onCancelUnsure?: () => void;
  onRestore?: () => void;
  displayName?: string;
  onReassignFace?: (faceId: number, newName: string, verified?: boolean) => Promise<void>;
}) {
  const filteredPersons = (existingPersons || [])
    .filter(p => nameInput.length > 0 && p.name.toLowerCase().includes(nameInput.toLowerCase()) && p.name !== cluster.person_name && (p.photo_count ?? 0) > 0)
    .slice(0, 4);

  // State for reassigning a single face via popover
  const [reassignFaceId, setReassignFaceId] = useState<number | null>(null);
  const [reassignName, setReassignName] = useState('');
  const reassignInputRef = useRef<HTMLInputElement>(null);
  const reassignSuggestions = (existingPersons || [])
    .filter(p => reassignName.length > 0 && p.name.toLowerCase().includes(reassignName.toLowerCase()) && (p.photo_count ?? 0) > 0)
    .slice(0, 4);

  const handleReassign = async (name: string, verified: boolean = true) => {
    if (!name.trim() || !reassignFaceId || !onReassignFace) return;
    await onReassignFace(reassignFaceId, name.trim(), verified);
    setReassignFaceId(null);
    setReassignName('');
  };

  // Keyboard navigation for name suggestion dropdowns
  const [selectedSuggestionIdx, setSelectedSuggestionIdx] = useState(-1);
  const [reassignSuggestionIdx, setReassignSuggestionIdx] = useState(-1);

  // Context crop cache: shows wider area with face box highlighted
  const [contextCrops, setContextCrops] = useState<Record<string, string>>({});
  const loadContextCrop = async (key: string, filePath: string, bx: number, by: number, bw: number, bh: number) => {
    if (contextCrops[key]) return;
    const result = await getFaceContext(filePath, bx, by, bw, bh, 200);
    if (result.success && result.dataUrl) {
      setContextCrops(prev => ({ ...prev, [key]: result.dataUrl! }));
    }
  };

  // "View all faces" grid modal
  const [showFaceGrid, setShowFaceGrid] = useState(false);

  const cardRef = useRef<HTMLDivElement>(null);
  const thumbStripRef = useRef<HTMLDivElement>(null);

  // Capture wheel events on thumbnail strip to scroll horizontally, preventing modal scroll
  useEffect(() => {
    const el = thumbStripRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (e.deltaY !== 0) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
        e.stopPropagation();
      }
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  });

  // Click-outside-to-cancel: when editing, clicking anywhere outside the edit area cancels
  // (hooks must be called before any early returns to satisfy React rules of hooks)
  useEffect(() => {
    if (!isEditing) return;
    const handler = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isEditing, onCancel]);

  // Inline "Are you sure?" for ignore
  if (pendingIgnore) {
    return (
      <div className="rounded-xl border border-slate-300/60 dark:border-slate-600/40 bg-slate-50/30 dark:bg-slate-900/20 p-3">
        <div className="flex items-center gap-3">
          {cropUrl ? (
            <img src={cropUrl} alt="" className="w-10 h-10 rounded-full object-cover shrink-0 border border-slate-300/50 opacity-60" />
          ) : (
            <div className="w-10 h-10 rounded-full bg-slate-500/10 flex items-center justify-center shrink-0">
              <UserX className="w-4 h-4 text-slate-400" />
            </div>
          )}
          <p className="text-sm text-foreground flex-1">Ignore this person?</p>
          <button onClick={onConfirmIgnore} className="px-3 py-1.5 rounded-lg bg-slate-500 hover:bg-slate-600 text-white text-xs font-medium transition-colors">
            Yes, ignore
          </button>
          <button onClick={onCancelIgnore} className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary text-xs font-medium transition-colors">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Inline "Are you sure?" for unsure
  if (pendingUnsure) {
    return (
      <div className="rounded-xl border border-blue-300/60 dark:border-blue-600/40 bg-blue-50/30 dark:bg-blue-900/20 p-3">
        <div className="flex items-center gap-3">
          {cropUrl ? (
            <img src={cropUrl} alt="" className="w-10 h-10 rounded-full object-cover shrink-0 border border-blue-300/50 opacity-60" />
          ) : (
            <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0">
              <HelpCircle className="w-4 h-4 text-blue-400" />
            </div>
          )}
          <p className="text-sm text-foreground flex-1">Move to Unsure?</p>
          <button onClick={onConfirmUnsure} className="px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-xs font-medium transition-colors">
            Yes
          </button>
          <button onClick={onCancelUnsure} className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary text-xs font-medium transition-colors">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const availableSamples = cluster.sample_faces?.length || 0;

  return (
    <TooltipProvider delayDuration={0}>
    <div
      ref={cardRef}
      className={`rounded-xl border transition-all group ${
        isEditing
          ? 'border-purple-400/60 bg-purple-50/30 dark:bg-purple-950/20 shadow-md'
          : 'border-border hover:border-purple-300/50 hover:shadow-sm cursor-pointer'
      }`}
      onClick={!isEditing ? onStartEdit : undefined}
    >
      <div className="p-4">
        <div className="flex items-center gap-3">
          {/* Main face thumbnail — hover shows context with face box */}
          <TooltipProvider delayDuration={500}>
            <Tooltip onOpenChange={(open) => {
              if (open && cluster.representative_file_path) {
                loadContextCrop(`main_${cluster.representative_face_id}`, cluster.representative_file_path, cluster.box_x, cluster.box_y, cluster.box_w, cluster.box_h);
              }
            }}>
              <TooltipTrigger asChild>
                <div className="shrink-0">
                  {cropUrl ? (
                    <img src={cropUrl} alt="" className="w-14 h-14 rounded-full object-cover shrink-0 border-2 border-purple-400/40" />
                  ) : (
                    <div className="w-14 h-14 rounded-full bg-purple-500/15 flex items-center justify-center shrink-0">
                      <Users className="w-6 h-6 text-purple-400" />
                    </div>
                  )}
                </div>
              </TooltipTrigger>
              {cropUrl && (
                <TooltipContent side="right" className="p-0.5 border border-purple-400/30 bg-background shadow-lg rounded-xl">
                  <img src={contextCrops[`main_${cluster.representative_face_id}`] || cropUrl} alt="" className={`${contextCrops[`main_${cluster.representative_face_id}`] ? 'w-[200px] h-[200px] rounded-lg' : 'w-28 h-28 rounded-full'} object-cover`} />
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>

          {/* Name + stats */}
          <div className="min-w-0 w-[120px] shrink-0">
            {isEditing ? (
              <div onClick={(e) => e.stopPropagation()}>
                <form onSubmit={(e) => { e.preventDefault(); if (nameInput.trim()) onSubmit(); }} className="flex items-center gap-1.5">
                  <input
                    ref={inputRef}
                    type="text"
                    value={nameInput}
                    onChange={(e) => { onNameChange(e.target.value); setSelectedSuggestionIdx(-1); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                      if (e.key === 'ArrowDown' && filteredPersons.length > 0) {
                        e.preventDefault();
                        setSelectedSuggestionIdx(prev => Math.min(prev + 1, filteredPersons.length - 1));
                      }
                      if (e.key === 'ArrowUp' && filteredPersons.length > 0) {
                        e.preventDefault();
                        setSelectedSuggestionIdx(prev => Math.max(prev - 1, -1));
                      }
                      if (e.key === 'Enter' && selectedSuggestionIdx >= 0 && filteredPersons[selectedSuggestionIdx]) {
                        e.preventDefault();
                        onSelectPerson?.(filteredPersons[selectedSuggestionIdx].name);
                        setSelectedSuggestionIdx(-1);
                      }
                    }}
                    placeholder="Type a name..."
                    className="flex-1 text-sm bg-transparent border-b-2 border-purple-400 outline-none text-foreground placeholder:text-muted-foreground/70 pb-0.5 min-w-0"
                    autoFocus
                  />
                  <Tooltip><TooltipTrigger asChild>
                    <button type="submit" className="p-1 rounded hover:bg-purple-200/50 dark:hover:bg-purple-800/30">
                      <Check className="w-4 h-4 text-purple-500" />
                    </button>
                  </TooltipTrigger><TooltipContent>Save</TooltipContent></Tooltip>
                  <Tooltip><TooltipTrigger asChild>
                    <button type="button" onClick={onCancel} className="p-1 rounded hover:bg-secondary">
                      <X className="w-4 h-4 text-muted-foreground" />
                    </button>
                  </TooltipTrigger><TooltipContent>Cancel</TooltipContent></Tooltip>
                </form>
                {filteredPersons.length > 0 && (
                  <div className="mt-1.5 space-y-0.5">
                    {filteredPersons.map((p, idx) => (
                      <button key={p.id} onClick={(e) => { e.stopPropagation(); onSelectPerson?.(p.name); }}
                        className={`w-full flex items-center gap-2 px-1.5 py-1 rounded text-xs transition-colors text-left ${idx === selectedSuggestionIdx ? 'bg-purple-200/70 dark:bg-purple-800/40' : 'hover:bg-purple-100/50 dark:hover:bg-purple-900/20'}`}>
                        <Users className="w-3 h-3 text-purple-400 shrink-0" />
                        <span className="truncate">{p.name}</span>
                        {p.photo_count != null && <span className="text-[9px] text-muted-foreground ml-auto shrink-0">{p.photo_count}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                <p className={`text-sm font-medium truncate ${(cluster.person_name && !displayName) ? 'text-foreground' : 'text-muted-foreground italic'}`}>
                  {displayName || cluster.person_name || 'Unknown person'}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {cluster.face_count} {cluster.face_count === 1 ? 'face' : 'faces'} · {cluster.photo_count} {cluster.photo_count === 1 ? 'photo' : 'photos'}
                </p>
              </>
            )}
          </div>

          {/* Sample face thumbnails — scrollable, fills remaining space */}
          {!isEditing && cluster.sample_faces && cluster.sample_faces.length > 0 && (
            <div
              ref={thumbStripRef}
              className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent pb-1"
              onClick={(e) => e.stopPropagation()}
            >
              {cluster.sample_faces.map((face) => (
                <Popover key={face.face_id} open={reassignFaceId === face.face_id} onOpenChange={(open) => { if (!open) { setReassignFaceId(null); setReassignName(''); } }}>
                  <TooltipProvider delayDuration={500}>
                    <Tooltip onOpenChange={(open) => {
                      if (open && face.file_path) {
                        loadContextCrop(`face_${face.face_id}`, face.file_path, face.box_x, face.box_y, face.box_w, face.box_h);
                      }
                    }}>
                      <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                          <div className="shrink-0">
                            {sampleCrops[face.face_id] ? (
                              <img
                                src={sampleCrops[face.face_id]}
                                alt=""
                                className={`w-10 h-10 rounded-full object-cover cursor-pointer hover:ring-2 hover:ring-purple-400/50 transition-all ${face.verified ? 'border-2 border-orange-400' : 'border border-border/50'}`}
                                onClick={(e) => { e.stopPropagation(); setReassignFaceId(face.face_id); setReassignName(''); setTimeout(() => reassignInputRef.current?.focus(), 100); }}
                              />
                            ) : (
                              <div className={`w-10 h-10 rounded-full bg-secondary flex items-center justify-center cursor-pointer ${face.verified ? 'border-2 border-orange-400' : ''}`}>
                                <Users className="w-3.5 h-3.5 text-muted-foreground/70" />
                              </div>
                            )}
                          </div>
                        </PopoverTrigger>
                      </TooltipTrigger>
                      {/* Hover tooltip: context crop with face box highlighted */}
                      {sampleCrops[face.face_id] && reassignFaceId !== face.face_id && (
                        <TooltipContent side="top" className="p-0.5 border border-purple-400/30 bg-background shadow-lg rounded-xl">
                          <img src={contextCrops[`face_${face.face_id}`] || sampleCrops[face.face_id]} alt="" className={`${contextCrops[`face_${face.face_id}`] ? 'w-[200px] h-[200px] rounded-lg' : 'w-20 h-20 rounded-full'} object-cover`} />
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>
                  {/* Click popover: reassign this face */}
                  <PopoverContent side="top" align="center" className="w-64 p-3 z-[60]" onOpenAutoFocus={(e) => e.preventDefault()} collisionPadding={8}>
                    <div className="space-y-2">
                      {sampleCrops[face.face_id] && (
                        <div className="flex justify-center">
                          <img src={sampleCrops[face.face_id]} alt="" className="w-16 h-16 rounded-full object-cover border-2 border-purple-400/40" />
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground text-center">Choose an action for this face</p>
                      <input
                        ref={reassignInputRef}
                        type="text"
                        value={reassignName}
                        onChange={(e) => { setReassignName(e.target.value); setReassignSuggestionIdx(-1); }}
                        onKeyDown={(e) => {
                          if (e.key === 'ArrowDown' && reassignSuggestions.length > 0) {
                            e.preventDefault();
                            setReassignSuggestionIdx(prev => Math.min(prev + 1, reassignSuggestions.length - 1));
                          } else if (e.key === 'ArrowUp' && reassignSuggestions.length > 0) {
                            e.preventDefault();
                            setReassignSuggestionIdx(prev => Math.max(prev - 1, -1));
                          } else if (e.key === 'Enter') {
                            if (reassignSuggestionIdx >= 0 && reassignSuggestions[reassignSuggestionIdx]) {
                              e.preventDefault();
                              setReassignName(reassignSuggestions[reassignSuggestionIdx].name);
                              setReassignSuggestionIdx(-1);
                            } else if (reassignName.trim()) {
                              handleReassign(reassignName);
                            }
                          } else if (e.key === 'Escape') {
                            setReassignFaceId(null); setReassignName('');
                          }
                        }}
                        placeholder="Type person name..."
                        className="w-full text-sm px-2.5 py-1.5 rounded-lg border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-purple-400/50"
                        autoFocus
                      />
                      {reassignSuggestions.length > 0 && (
                        <div className="space-y-0.5">
                          {reassignSuggestions.map((p, idx) => (
                            <button key={p.id} onClick={() => { setReassignName(p.name); setReassignSuggestionIdx(-1); }}
                              className={`w-full flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors text-left ${idx === reassignSuggestionIdx ? 'bg-purple-200/70 dark:bg-purple-800/40' : 'hover:bg-purple-100/50 dark:hover:bg-purple-900/20'}`}>
                              <Users className="w-3 h-3 text-purple-400 shrink-0" />
                              <span className="truncate">{p.name}</span>
                              <span className="text-[9px] text-muted-foreground ml-auto shrink-0">{p.photo_count}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-1.5">
                        <button onClick={() => handleReassign(reassignName)} disabled={!reassignName.trim()}
                          className="flex-1 px-2 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors">
                          Verify
                        </button>
                        <button onClick={() => { setReassignFaceId(null); setReassignName(''); }}
                          className="px-2 py-1.5 rounded-lg border border-border hover:bg-secondary text-xs font-medium transition-colors">
                          Cancel
                        </button>
                      </div>
                      <div className="flex gap-1.5 pt-1 border-t border-border">
                        <button onClick={() => handleReassign('__unsure__')}
                          data-pdr-variant="information" className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors" style={{ backgroundColor: '#dbeafe', borderColor: '#3b82f6', color: '#1e3a8a', borderWidth: '1px', borderStyle: 'solid' }}>
                          <HelpCircle className="w-3 h-3" /> Unsure
                        </button>
                        <button onClick={() => { if (reassignFaceId && onReassignFace) { onReassignFace(reassignFaceId, '__unnamed__'); setReassignFaceId(null); setReassignName(''); } }}
                          data-pdr-variant="caution" className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors" style={{ backgroundColor: '#fde68a', borderColor: '#f59e0b', color: '#78350f', borderWidth: '1px', borderStyle: 'solid' }}>
                          <Users className="w-3 h-3" /> Unnamed
                        </button>
                        <button onClick={() => handleReassign('__ignored__')}
                          className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-slate-300/50 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/30 text-xs font-medium transition-colors">
                          <UserX className="w-3 h-3" /> Ignore
                        </button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              ))}
            </div>
          )}

          {/* Hover action buttons — styled as visible buttons with instant tooltips */}
          {!isEditing && (
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
              {cluster.face_count > 20 && onReassignFace && (
                <Tooltip><TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowFaceGrid(true); }}
                    className="p-1.5 rounded-lg border border-purple-300/50 bg-background hover:bg-purple-50 dark:hover:bg-purple-900/30 transition-colors"
                  >
                    <Grid3X3 className="w-3.5 h-3.5 text-purple-500" />
                  </button>
                </TooltipTrigger><TooltipContent>View all faces</TooltipContent></Tooltip>
              )}
              <Tooltip><TooltipTrigger asChild>
                <button
                  onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
                  className="p-1.5 rounded-lg border border-purple-300/50 bg-background hover:bg-purple-50 dark:hover:bg-purple-900/30 transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5 text-purple-500" />
                </button>
              </TooltipTrigger><TooltipContent>{cluster.person_name && !displayName ? 'Rename' : 'Name this person'}</TooltipContent></Tooltip>
              {onDiscard && (
                <Tooltip><TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDiscard(); }}
                    className="p-1.5 rounded-lg border border-red-300/50 bg-background hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-red-500" />
                  </button>
                </TooltipTrigger><TooltipContent>Discard this person</TooltipContent></Tooltip>
              )}
              {onUnsure && (
                <Tooltip><TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); onUnsure(); }}
                    className="p-1.5 rounded-lg border border-blue-300/50 bg-background hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                  >
                    <HelpCircle className="w-3.5 h-3.5 text-blue-500" />
                  </button>
                </TooltipTrigger><TooltipContent>Can't remember</TooltipContent></Tooltip>
              )}
              {onIgnore && (
                <Tooltip><TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); onIgnore(); }}
                    className="p-1.5 rounded-lg border border-slate-300/50 bg-background hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors"
                  >
                    <UserX className="w-3.5 h-3.5 text-slate-500" />
                  </button>
                </TooltipTrigger><TooltipContent>Ignore</TooltipContent></Tooltip>
              )}
              {onRestore && (
                <Tooltip><TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); onRestore(); }}
                    className="p-1.5 rounded-lg border border-green-300/50 bg-background hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
                  >
                    <Undo2 className="w-3.5 h-3.5 text-green-500" />
                  </button>
                </TooltipTrigger><TooltipContent>Move back to Unnamed</TooltipContent></Tooltip>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
    {/* Face grid modal for viewing all faces */}
    {showFaceGrid && onReassignFace && (
      <FaceGridModal
        cluster={cluster}
        cropUrl={cropUrl}
        existingPersons={existingPersons || []}
        onReassignFace={onReassignFace}
        onClose={() => setShowFaceGrid(false)}
        onRefresh={() => {}}
      />
    )}
    </TooltipProvider>
  );
}

/* ─── List View ─────────────────────────────────────────────────────────── */

function PersonListRow({ cluster, cropUrl, sampleCrops, isEditing, nameInput, onStartEdit, onNameChange, onSubmit, onCancel, inputRef, onDiscard, pendingIgnore, onIgnore, onConfirmIgnore, onCancelIgnore, pendingUnsure, onUnsure, onConfirmUnsure, onCancelUnsure }: {
  cluster: PersonCluster;
  cropUrl?: string;
  sampleCrops: Record<string, string>;
  isEditing: boolean;
  nameInput: string;
  onStartEdit: () => void;
  onNameChange: (name: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onDiscard?: () => void;
  pendingIgnore?: boolean;
  onIgnore?: () => void;
  onConfirmIgnore?: () => void;
  onCancelIgnore?: () => void;
  pendingUnsure?: boolean;
  onUnsure?: () => void;
  onConfirmUnsure?: () => void;
  onCancelUnsure?: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Click-outside-to-cancel rename (hooks must be called before any early returns)
  useEffect(() => {
    if (!isEditing) return;
    const handler = (e: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isEditing, onCancel]);

  // Inline confirm for ignore
  if (pendingIgnore) {
    return (
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-50/30 dark:bg-slate-900/20 border border-slate-300/40">
        {cropUrl ? <img src={cropUrl} alt="" className="w-7 h-7 rounded-full object-cover shrink-0 opacity-60" /> : <div className="w-7 h-7 rounded-full bg-slate-200 shrink-0" />}
        <span className="text-sm text-foreground flex-1">Ignore?</span>
        <button onClick={onConfirmIgnore} className="px-2.5 py-1 rounded-md bg-slate-500 hover:bg-slate-600 text-white text-xs font-medium transition-colors">Yes</button>
        <button onClick={onCancelIgnore} className="px-2.5 py-1 rounded-md border border-border hover:bg-secondary text-xs font-medium transition-colors">No</button>
      </div>
    );
  }
  if (pendingUnsure) {
    return (
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-blue-50/30 dark:bg-blue-900/20 border border-blue-300/40">
        {cropUrl ? <img src={cropUrl} alt="" className="w-7 h-7 rounded-full object-cover shrink-0 opacity-60" /> : <div className="w-7 h-7 rounded-full bg-blue-200 shrink-0" />}
        <span className="text-sm text-foreground flex-1">Mark as unsure?</span>
        <button onClick={onConfirmUnsure} className="px-2.5 py-1 rounded-md bg-blue-500 hover:bg-blue-600 text-white text-xs font-medium transition-colors">Yes</button>
        <button onClick={onCancelUnsure} className="px-2.5 py-1 rounded-md border border-border hover:bg-secondary text-xs font-medium transition-colors">No</button>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={0}>
    <div
      ref={listRef}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all group ${
        isEditing ? 'bg-purple-50/30 dark:bg-purple-950/20 ring-1 ring-purple-400/40' : 'hover:bg-secondary/40 cursor-pointer'
      }`}
      onClick={!isEditing ? onStartEdit : undefined}
    >
      {cropUrl ? (
        <img src={cropUrl} alt="" className="w-9 h-9 rounded-full object-cover shrink-0 border border-purple-400/30" />
      ) : (
        <div className="w-9 h-9 rounded-full bg-purple-500/15 flex items-center justify-center shrink-0">
          <Users className="w-4 h-4 text-purple-400" />
        </div>
      )}

      <div className="flex-1 min-w-0">
        {isEditing ? (
          <form onSubmit={(e) => { e.preventDefault(); if (nameInput.trim()) onSubmit(); }} className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            <input ref={inputRef} type="text" value={nameInput} onChange={(e) => onNameChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }}
              placeholder="Type a name..." className="flex-1 text-sm bg-transparent border-b-2 border-purple-400 outline-none text-foreground placeholder:text-muted-foreground/70 pb-0.5 min-w-0" autoFocus />
            <Tooltip><TooltipTrigger asChild>
              <button type="submit" className="p-1 rounded hover:bg-purple-200/50 dark:hover:bg-purple-800/30"><Check className="w-3.5 h-3.5 text-purple-500" /></button>
            </TooltipTrigger><TooltipContent>Save</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild>
              <button type="button" onClick={onCancel} className="p-1 rounded hover:bg-secondary"><X className="w-3.5 h-3.5 text-muted-foreground" /></button>
            </TooltipTrigger><TooltipContent>Cancel</TooltipContent></Tooltip>
          </form>
        ) : (
          <p className={`text-sm truncate ${cluster.person_name ? 'font-medium text-foreground' : 'text-muted-foreground italic'}`}>
            {cluster.person_name || 'Unknown person'}
          </p>
        )}
      </div>

      {!isEditing && cluster.sample_faces && cluster.sample_faces.length > 0 && (
        <div className="flex items-center gap-0.5 shrink-0">
          {cluster.sample_faces.slice(0, 4).map(face => (
            <div key={face.face_id}>
              {sampleCrops[face.face_id] ? <img src={sampleCrops[face.face_id]} alt="" className={`w-6 h-6 rounded-full object-cover ${face.verified ? 'border-2 border-orange-400' : 'border border-border/40'}`} /> : <div className={`w-6 h-6 rounded-full bg-secondary ${face.verified ? 'border-2 border-orange-400' : ''}`} />}
            </div>
          ))}
        </div>
      )}

      {!isEditing && (
        <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0 w-[80px] text-right">
          {cluster.face_count} in {cluster.photo_count} {cluster.photo_count === 1 ? 'photo' : 'photos'}
        </span>
      )}

      {!isEditing && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all shrink-0">
          <Tooltip><TooltipTrigger asChild>
            <button onClick={(e) => { e.stopPropagation(); onStartEdit(); }} className="p-1 rounded-md border border-purple-300/50 bg-background hover:bg-purple-50 dark:hover:bg-purple-900/30 transition-colors">
              <Pencil className="w-3.5 h-3.5 text-purple-500" />
            </button>
          </TooltipTrigger><TooltipContent>{cluster.person_name ? 'Rename' : 'Name'}</TooltipContent></Tooltip>
          {onDiscard && (
            <Tooltip><TooltipTrigger asChild>
              <button onClick={(e) => { e.stopPropagation(); onDiscard(); }} className="p-1 rounded-md border border-red-300/50 bg-background hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                <Trash2 className="w-3.5 h-3.5 text-red-500" />
              </button>
            </TooltipTrigger><TooltipContent>Discard</TooltipContent></Tooltip>
          )}
          {onUnsure && (
            <Tooltip><TooltipTrigger asChild>
              <button onClick={(e) => { e.stopPropagation(); onUnsure(); }} className="p-1 rounded-md border border-blue-300/50 bg-background hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
                <HelpCircle className="w-3.5 h-3.5 text-blue-500" />
              </button>
            </TooltipTrigger><TooltipContent>Can't remember</TooltipContent></Tooltip>
          )}
          {onIgnore && (
            <Tooltip><TooltipTrigger asChild>
              <button onClick={(e) => { e.stopPropagation(); onIgnore(); }} className="p-1 rounded-md border border-slate-300/50 bg-background hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                <UserX className="w-3.5 h-3.5 text-slate-500" />
              </button>
            </TooltipTrigger><TooltipContent>Ignore</TooltipContent></Tooltip>
          )}
        </div>
      )}
    </div>
    </TooltipProvider>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return <div className="p-3 rounded-xl border border-border bg-secondary/20 text-center"><p className="text-lg font-semibold text-foreground font-heading">{value}</p><p className="text-[10px] text-muted-foreground uppercase font-semibold">{label}</p></div>;
}

/**
 * Small inline control that sits under the Make/Model rows in the Details
 * Camera section. Lets the user flag an unknown scanner / MFP so future
 * indexing runs (and an immediate re-classification of existing files)
 * demote everything with that same Make+Model to the Marked tier — and the
 * reverse: escape-hatch an over-eager detection.
 *
 * The override state is stored in settings, so clicking once here affects
 * every photo in the library that shares this Make+Model pair.
 */
function ScannerOverrideControl({ make, model, currentConfidence }: { make: string; model: string; currentConfidence: string }) {
  const [state, setState] = useState<'loading' | 'on' | 'off' | 'none'>('loading');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listScannerOverrides().then(r => {
      if (cancelled) return;
      const list = r.success && r.data ? r.data : [];
      const hit = list.find(o => o.make === make.toLowerCase().trim() && o.model === model.toLowerCase().trim());
      setState(hit ? (hit.isScanner ? 'on' : 'off') : 'none');
    });
    return () => { cancelled = true; };
  }, [make, model]);

  const apply = async (isScanner: boolean) => {
    setBusy(true);
    setStatus(null);
    const r = await setScannerOverride({ make, model, isScanner });
    setBusy(false);
    if (r.success && r.data) {
      setState(isScanner ? 'on' : 'off');
      setStatus(
        r.data.updated > 0
          ? `Applied — ${r.data.updated.toLocaleString()} ${r.data.updated === 1 ? 'file' : 'files'} re-classified.`
          : 'Applied — no existing files needed changing.'
      );
    } else {
      setStatus('Failed: ' + (r.error || 'unknown'));
    }
  };

  const reset = async () => {
    setBusy(true);
    setStatus(null);
    const r = await clearScannerOverride({ make, model });
    setBusy(false);
    if (r.success) {
      setState('none');
      setStatus('Override cleared — built-in rule will decide going forward.');
    } else {
      setStatus('Failed: ' + (r.error || 'unknown'));
    }
  };

  if (state === 'loading') return null;

  // Messaging adapts to the current state to keep the control self-explanatory.
  const looksLikeScanner = currentConfidence === 'marked' || state === 'on';
  return (
    <div className="mt-2 rounded-md border border-border/60 bg-secondary/20 px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
        <AlertTriangle className="w-3 h-3" /> Scanner override
      </div>
      <p className="text-[11px] text-muted-foreground leading-snug">
        {state === 'on'
          ? `All photos with camera "${make} ${model}" are being treated as scanner output.`
          : state === 'off'
            ? `"${make} ${model}" is explicitly marked as NOT a scanner — built-in rule skipped.`
            : looksLikeScanner
              ? `Think this isn't actually a scanner? Tell PDR to stop demoting its photos.`
              : `Think this is actually a scanner PDR missed? Tell PDR and every photo from this camera will be Marked.`}
      </p>
      <div className="flex items-center gap-1.5 flex-wrap">
        {state !== 'on' && (
          <button
            onClick={() => apply(true)}
            disabled={busy}
            className="text-[11px] font-medium px-2.5 py-1 rounded border border-amber-500/40 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 disabled:opacity-40 transition-colors"
          >
            Mark as scanner
          </button>
        )}
        {state !== 'off' && (
          <button
            onClick={() => apply(false)}
            disabled={busy}
            className="text-[11px] font-medium px-2.5 py-1 rounded border border-emerald-500/40 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-40 transition-colors"
          >
            Not a scanner
          </button>
        )}
        {state !== 'none' && (
          <button
            onClick={reset}
            disabled={busy}
            className="text-[11px] font-medium px-2.5 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:border-primary/30 disabled:opacity-40 transition-colors"
          >
            Clear override
          </button>
        )}
      </div>
      {status && (
        <div className={`text-[10px] ${status.startsWith('Failed') ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
          {status}
        </div>
      )}
    </div>
  );
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
