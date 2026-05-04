import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, HardDrive, Folder, FolderOpen, FolderPlus, ChevronRight, ChevronLeft, ChevronDown,
  Image, ArrowLeft, ArrowRight, AlertCircle, Loader2, Monitor, ZoomIn, ZoomOut, Pencil,
  FileArchive, LayoutGrid, List, Table2, CheckCircle2, AlertTriangle, Info, Zap, Wifi, ExternalLink,
  FileText, Download, Music, Film, User
} from 'lucide-react';
import { Button } from '@/components/ui/custom-button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { listDrives, readDirectory, getThumbnail, createDirectory, getQuickAccessPaths, DriveInfo, DirectoryEntry, QuickAccessPaths } from '@/lib/electron-bridge';

// Drive scoring for colour coding (mirrors DestinationAdvisorModal logic)
type DriveRating = 'good' | 'warning' | 'poor';
function rateDrive(drive: DriveInfo, requiredGB?: number | null): { rating: DriveRating; badge: string | null; isSystemDrive: boolean } {
  const freeGB = drive.freeBytes / (1024 * 1024 * 1024);
  const totalGB = drive.totalBytes / (1024 * 1024 * 1024);
  const isSystemDrive = drive.letter.toUpperCase().startsWith('C');

  // Poor: CD/DVD, no space, system drive (always red)
  if (drive.type === 'CD/DVD') return { rating: 'poor', badge: 'Not suitable', isSystemDrive };
  if (totalGB < 16) return { rating: 'poor', badge: 'Too small', isSystemDrive };
  if (isSystemDrive) return { rating: 'poor', badge: 'System drive', isSystemDrive };
  if (freeGB < 10) return { rating: 'poor', badge: 'Low space', isSystemDrive };

  // Network drives: always warning (slow & reliability concerns)
  if (drive.type === 'Network') return { rating: 'warning', badge: 'Network — slow', isSystemDrive };

  // If user has stated a collection size, check if this drive can hold it
  if (requiredGB && requiredGB > 0) {
    // Total capacity too small for the collection (even if currently empty)
    if (totalGB < requiredGB * 0.8) return { rating: 'poor', badge: 'Too small for library', isSystemDrive };
    // Not enough free space to hold the collection
    if (freeGB < requiredGB * 0.5) return { rating: 'poor', badge: 'Not enough space', isSystemDrive };
    if (freeGB < requiredGB) return { rating: 'warning', badge: 'May not fit library', isSystemDrive };
    // Drive has enough free space but is tight (less than 10% headroom after collection)
    if (freeGB < requiredGB * 1.1) return { rating: 'warning', badge: 'Tight fit', isSystemDrive };
  }

  // Warning: low-ish space or removable
  if (freeGB < 50) return { rating: 'warning', badge: 'Low space', isSystemDrive };
  if (drive.type === 'Removable') return { rating: 'warning', badge: 'External', isSystemDrive };

  // Good
  return { rating: 'good', badge: null, isSystemDrive };
}

// Drive-rating chrome maps to the success / caution / destructive
// chip palette so the rows feel consistent with status pills used
// elsewhere (Required-X-GB pill, etc.). bg-color/15 + ring-color/30
// matches the existing soft-pill convention used for tab counts in
// PM and the Required-X-GB pill in the destination card.
const ratingStyles = {
  good: 'border-transparent ring-1 ring-emerald-500/30 hover:ring-emerald-500/60 bg-emerald-500/10',
  warning: 'border-transparent ring-1 ring-amber-500/30 hover:ring-amber-500/60 bg-amber-500/10',
  poor: 'border-transparent ring-1 ring-rose-500/30 hover:ring-rose-500/60 bg-rose-500/10',
};
const ratingDotStyles = {
  good: 'bg-emerald-500',
  warning: 'bg-amber-500',
  poor: 'bg-red-500',
};

interface FolderBrowserModalProps {
  isOpen: boolean;
  onSelect: (path: string) => void;
  onCancel: () => void;
  title?: string;
  mode?: 'folder' | 'source' | 'archives';
  defaultPath?: string;
  onOpenDriveAdvisor?: () => void;
  plannedCollectionSizeGB?: number | null;
  enableSavedLocations?: boolean;
  showDriveRatings?: boolean;
}

const SAVED_DESTINATIONS_KEY = 'pdr-saved-destinations';
const MAX_SAVED_DESTINATIONS = 3;

function loadSavedDestinations(): string[] {
  try {
    const raw = localStorage.getItem(SAVED_DESTINATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_SAVED_DESTINATIONS) : [];
  } catch { return []; }
}

function saveDestionationToRecents(path: string) {
  const existing = loadSavedDestinations();
  // Move to front if already saved, otherwise prepend
  const filtered = existing.filter(p => p.toLowerCase() !== path.toLowerCase());
  const updated = [path, ...filtered].slice(0, MAX_SAVED_DESTINATIONS);
  localStorage.setItem(SAVED_DESTINATIONS_KEY, JSON.stringify(updated));
}

function removeFromSavedDestinations(path: string) {
  const existing = loadSavedDestinations();
  const updated = existing.filter(p => p.toLowerCase() !== path.toLowerCase());
  localStorage.setItem(SAVED_DESTINATIONS_KEY, JSON.stringify(updated));
}

interface TreeNode {
  path: string;
  name: string;
  expanded: boolean;
  children: TreeNode[] | null;
  loading: boolean;
  hasSubfolders?: boolean;
}

export function FolderBrowserModal({ isOpen, onSelect, onCancel, title = 'Select Folder', mode = 'folder', defaultPath, onOpenDriveAdvisor, plannedCollectionSizeGB, enableSavedLocations, showDriveRatings = false }: FolderBrowserModalProps) {
  const mouseDownOnBackdropRef = useRef(false);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [quickAccess, setQuickAccess] = useState<QuickAccessPaths | null>(null);
  const [quickAccessOpen, setQuickAccessOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState<string>('');
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [thumbSize, setThumbSize] = useState(64);
  const [fileViewMode, setFileViewMode] = useState<'grid' | 'list' | 'details'>('grid');
  const [sortBy, setSortBy] = useState<'name' | 'date' | 'size'>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Sort entries respecting the current sortBy / sortDir. Folders always
  // come first so the user's navigation flow isn't disrupted.
  const sortEntries = useCallback((list: DirectoryEntry[]) => {
    const folders = list.filter(e => e.isDirectory);
    const files = list.filter(e => !e.isDirectory);
    const cmp = (a: DirectoryEntry, b: DirectoryEntry) => {
      let d = 0;
      if (sortBy === 'name') d = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      else if (sortBy === 'date') d = (a.modifiedAt || 0) - (b.modifiedAt || 0);
      else if (sortBy === 'size') d = (a.sizeBytes || 0) - (b.sizeBytes || 0);
      return sortDir === 'asc' ? d : -d;
    };
    folders.sort(cmp);
    files.sort(cmp);
    return [...folders, ...files];
  }, [sortBy, sortDir]);

  const sortedEntries = sortEntries(entries);

  // Clicking a Details-view column header toggles sort direction if already
  // sorted by that column, otherwise switches to that column starting
  // ascending. Same UX as Windows File Explorer / macOS Finder.
  const handleHeaderSort = useCallback((col: 'name' | 'date' | 'size') => {
    if (sortBy === col) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(col);
      setSortDir('asc');
    }
  }, [sortBy]);

  // Chevron icon for the active-sort column header.
  const sortIndicator = (col: 'name' | 'date' | 'size') =>
    sortBy !== col ? null : (
      <ChevronDown className={`inline w-3 h-3 ml-1 -mt-0.5 ${sortDir === 'desc' ? '' : 'rotate-180'}`} />
    );
  const [selectedFile, setSelectedFile] = useState<string>('');
  const isArchiveMode = mode === 'archives';
  const [driveWarning, setDriveWarning] = useState<{ reasons: string[]; suggestions: string[]; path: string } | null>(null);
  const [savedDestinations, setSavedDestinations] = useState<string[]>([]);
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [editPathValue, setEditPathValue] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const [modalSize, setModalSize] = useState({ width: 900, height: 620 });
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);
  const pendingDefaultPathRef = useRef<string | null>(null);
  const mainPanelRef = useRef<HTMLDivElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  // Load drives on mount (with retry for race conditions)
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const loadDrives = async (attempt = 0) => {
      try {
        const driveList = await listDrives();
        if (cancelled) return;
        if ((!driveList || driveList.length === 0) && attempt < 2) {
          // Retry after a short delay if no drives returned (IPC race)
          setTimeout(() => { if (!cancelled) loadDrives(attempt + 1); }, 500);
          return;
        }
        setDrives(driveList);
        setTreeNodes(driveList.map(d => ({
          path: d.letter + '\\',
          name: `${d.label} (${d.letter})`,
          expanded: false,
          children: null,
          loading: false,
          hasSubfolders: true,
        })));
      } catch (err) {
        // Retry on error (e.g., IPC not ready yet)
        if (!cancelled && attempt < 2) {
          setTimeout(() => { if (!cancelled) loadDrives(attempt + 1); }, 500);
        }
      }
    };
    loadDrives();
    // Quick Access folders — Desktop / Downloads / Documents / Pictures etc.
    getQuickAccessPaths().then((qa) => { if (!cancelled) setQuickAccess(qa); });
    setCurrentPath('');
    setEntries([]);
    setSelectedPath('');
    setHistory([]);
    setHistoryIndex(-1);
    setThumbnails({});
    setIsEditingPath(false);
    setSelectedFile('');
    setDriveWarning(null);
    if (enableSavedLocations) {
      setSavedDestinations(loadSavedDestinations());
    }
    // Navigate to defaultPath after a tick (so navigateTo is available)
    if (defaultPath) {
      pendingDefaultPathRef.current = defaultPath;
    }
    return () => { cancelled = true; };
  }, [isOpen]);

  // Load thumbnails when entries change — parallel batches with progressive rendering
  useEffect(() => {
    const imageEntries = entries.filter(e => e.isImage);
    if (imageEntries.length === 0) return;

    let cancelled = false;
    const loadThumbnails = async () => {
      const toLoad = imageEntries.filter(e => !thumbnails[e.path]);
      const batchSize = 12;
      for (let i = 0; i < toLoad.length; i += batchSize) {
        if (cancelled) break;
        const batch = toLoad.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(async (entry) => {
            const result = await getThumbnail(entry.path, thumbSize);
            return { path: entry.path, result };
          })
        );
        if (cancelled) break;
        const newThumbs: Record<string, string> = {};
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.result.success) {
            newThumbs[r.value.path] = r.value.result.dataUrl;
          }
        }
        if (Object.keys(newThumbs).length > 0) {
          setThumbnails(prev => ({ ...prev, ...newThumbs }));
        }
      }
    };
    loadThumbnails();
    return () => { cancelled = true; };
  }, [entries, thumbSize]);

  const navigateTo = useCallback(async (dirPath: string, addToHistory = true) => {
    setLoading(true);
    setError(null);
    setThumbnails({});
    setSelectedFile('');
    const fileFilter = isArchiveMode ? 'archives' : mode === 'source' ? 'source' : undefined;
    const result = await readDirectory(dirPath, fileFilter);
    setLoading(false);

    if (result.success) {
      setEntries(result.items);
      setCurrentPath(dirPath);
      setSelectedPath(dirPath);

      if (addToHistory) {
        const newHistory = [...history.slice(0, historyIndex + 1), dirPath];
        setHistory(newHistory);
        setHistoryIndex(newHistory.length - 1);
      }
    } else {
      setError(result.error || 'Failed to read directory');
    }

    if (mainPanelRef.current) {
      mainPanelRef.current.scrollTop = 0;
    }
  }, [history, historyIndex]);

  // Navigate to default path once drives have loaded and navigateTo is available
  useEffect(() => {
    if (isOpen && pendingDefaultPathRef.current && drives.length > 0) {
      const defaultDir = pendingDefaultPathRef.current;
      pendingDefaultPathRef.current = null;
      navigateTo(defaultDir);
    }
  }, [isOpen, drives, navigateTo]);

  const goBack = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      navigateTo(history[newIndex], false);
    }
  }, [history, historyIndex, navigateTo]);

  const goForward = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      navigateTo(history[newIndex], false);
    }
  }, [history, historyIndex, navigateTo]);

  const goUp = useCallback(() => {
    if (!currentPath) return;
    const parts = currentPath.replace(/[\\/]+$/, '').split(/[\\/]/);
    if (parts.length > 1) {
      const parent = parts.slice(0, -1).join('\\');
      const parentPath = parent.length === 2 && parent[1] === ':' ? parent + '\\' : parent;
      navigateTo(parentPath);
    }
  }, [currentPath, navigateTo]);

  const startEditingPath = useCallback(() => {
    setIsEditingPath(true);
    setEditPathValue(currentPath);
    setTimeout(() => pathInputRef.current?.focus(), 50);
  }, [currentPath]);

  const submitEditPath = useCallback(() => {
    setIsEditingPath(false);
    const trimmed = editPathValue.trim();
    if (trimmed && trimmed !== currentPath) {
      navigateTo(trimmed);
    }
  }, [editPathValue, currentPath, navigateTo]);

  const handlePathKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      submitEditPath();
    } else if (e.key === 'Escape') {
      setIsEditingPath(false);
    }
  }, [submitEditPath]);

  const toggleTreeNode = useCallback(async (nodePath: string, nodeList: TreeNode[]): Promise<TreeNode[]> => {
    const result: TreeNode[] = [];
    for (const node of nodeList) {
      if (node.path === nodePath) {
        if (node.expanded) {
          result.push({ ...node, expanded: false });
        } else {
          if (node.children === null) {
            const updated = { ...node, loading: true, expanded: true };
            result.push(updated);
            const dirResult = await readDirectory(nodePath);
            if (dirResult.success) {
              updated.children = dirResult.items
                .filter(item => item.isDirectory)
                .map(item => ({
                  path: item.path,
                  name: item.name,
                  expanded: false,
                  children: null as TreeNode[] | null,
                  loading: false,
                  hasSubfolders: item.hasSubfolders,
                }));
            } else {
              updated.children = [];
            }
            updated.loading = false;
          } else {
            result.push({ ...node, expanded: true });
          }
        }
      } else if (node.children) {
        const updatedChildren = await toggleTreeNode(nodePath, node.children);
        result.push({ ...node, children: updatedChildren });
      } else {
        result.push(node);
      }
    }
    return result;
  }, []);

  const handleTreeToggle = useCallback(async (nodePath: string) => {
    const updated = await toggleTreeNode(nodePath, treeNodes);
    setTreeNodes(updated);
  }, [treeNodes, toggleTreeNode]);

  const handleTreeSelect = useCallback((nodePath: string) => {
    navigateTo(nodePath);
  }, [navigateTo]);

  const handleEntryClick = useCallback((entry: DirectoryEntry) => {
    if (entry.isDirectory) {
      navigateTo(entry.path);
    } else if (entry.isArchive) {
      setSelectedFile(entry.path);
    }
  }, [navigateTo]);

  // Determine what's selected: archive file takes priority, then folder
  const hasArchiveSelected = !!selectedFile;
  const effectiveSelection = hasArchiveSelected ? selectedFile : selectedPath;

  const handleEntryDoubleClick = useCallback((entry: DirectoryEntry) => {
    if (entry.isArchive) {
      onSelect(entry.path);
    }
  }, [onSelect]);

  const handleConfirm = useCallback(() => {
    const pathToConfirm = selectedFile || selectedPath;
    if (!pathToConfirm) return;

    // Only check drive suitability for folder mode with a planned collection size
    if (!selectedFile && plannedCollectionSizeGB && plannedCollectionSizeGB > 0) {
      const driveLetter = pathToConfirm.substring(0, 2).toUpperCase();
      const drive = drives.find(d => d.letter.toUpperCase() === driveLetter.replace(':', '') + ':' || d.letter.toUpperCase() + ':' === driveLetter);
      // Also try matching just the letter
      const matchedDrive = drive || drives.find(d => pathToConfirm.toUpperCase().startsWith(d.letter.toUpperCase()));

      if (matchedDrive) {
        const freeGB = matchedDrive.freeBytes / (1024 * 1024 * 1024);
        const isSystemDrive = matchedDrive.letter.toUpperCase().startsWith('C');
        const isNetwork = matchedDrive.type === 'Network';
        const reasons: string[] = [];
        const suggestions: string[] = [];

        if (freeGB < plannedCollectionSizeGB) {
          const shortfall = plannedCollectionSizeGB - freeGB;
          reasons.push(`This drive has ${freeGB.toFixed(0)} GB free, but your estimated library needs ${plannedCollectionSizeGB >= 1000 ? `${(plannedCollectionSizeGB / 1024).toFixed(1)} TB` : `${plannedCollectionSizeGB.toFixed(0)} GB`}  — you're short by approximately ${shortfall >= 1000 ? `${(shortfall / 1024).toFixed(1)} TB` : `${shortfall.toFixed(0)} GB`}.`);
        }
        if (isSystemDrive) {
          reasons.push('This is your system drive (C:). Storing a large library here risks filling your boot drive, which can cause system instability, crashes, and failed Windows updates.');
        }
        if (isNetwork) {
          reasons.push('This is a network drive. Processing large photo libraries over WiFi or network connections can be unreliable, significantly slower, and prone to interruptions.');
        }

        if (reasons.length > 0) {
          // Generate intelligent suggestions based on the shortfall
          const neededTB = plannedCollectionSizeGB / 1024;
          if (neededTB <= 1) {
            suggestions.push('A 1 TB external SSD with USB-C or USB 3.1/3.2 would comfortably hold your library with excellent speed. An NVMe M.2 internal SSD is even faster if your PC has a spare slot.');
          } else if (neededTB <= 2) {
            suggestions.push('A 2 TB external SSD (USB-C/Thunderbolt) or internal NVMe/SATA SSD would give you room for your library with space to grow.');
          } else if (neededTB <= 4) {
            suggestions.push('A 4 TB external SSD or internal SATA/NVMe drive would handle your library well. For external, choose USB 3.1+ or Thunderbolt over basic USB 3.0.');
          } else {
            suggestions.push('For a library this size, consider a large internal NVMe/SATA drive, a Thunderbolt external drive, or a multi-bay NAS connected via Ethernet (not Wi-Fi).');
          }

          if (isSystemDrive && !isNetwork) {
            suggestions.push('Any dedicated drive — even a basic external SSD — is safer than your system drive for photo storage.');
          }

          // Check if better drives exist
          const betterDrives = drives.filter(d =>
            !d.letter.toUpperCase().startsWith('C') &&
            d.type !== 'Network' &&
            d.type !== 'CD/DVD' &&
            (d.freeBytes / (1024 * 1024 * 1024)) >= plannedCollectionSizeGB
          );
          if (betterDrives.length > 0) {
            const best = betterDrives[0];
            suggestions.push(`Drive ${best.letter} (${best.label}) has ${(best.freeBytes / (1024 * 1024 * 1024)).toFixed(0)} GB free and would be a better fit.`);
          }

          suggestions.push('Visit the PDR Guides section on our website for drive recommendations and setup advice.');

          setDriveWarning({ reasons, suggestions, path: pathToConfirm });
          return;
        }
      }
    }

    if (enableSavedLocations && !selectedFile) {
      saveDestionationToRecents(pathToConfirm);
    }
    onSelect(pathToConfirm);
  }, [selectedPath, selectedFile, onSelect, plannedCollectionSizeGB, drives, enableSavedLocations]);

  const startCreatingFolder = useCallback(() => {
    if (!currentPath) return;
    setIsCreatingFolder(true);
    setNewFolderName('New Folder');
    setTimeout(() => {
      newFolderInputRef.current?.focus();
      newFolderInputRef.current?.select();
    }, 50);
  }, [currentPath]);

  const submitNewFolder = useCallback(async () => {
    const name = newFolderName.trim();
    setIsCreatingFolder(false);
    if (!name || !currentPath) return;
    const newPath = currentPath.replace(/[\\/]+$/, '') + '\\' + name;
    const result = await createDirectory(newPath);
    if (result.success) {
      // Re-read the CURRENT directory rather than navigating INTO
      // the new folder. The previous behaviour landed the user in
      // an empty subfolder with no visual confirmation that the
      // create succeeded — looked broken. Now the new folder
      // appears as an entry in the current listing, the user can
      // see it landed, and they pick it (or another) themselves.
      navigateTo(currentPath, false);
    } else {
      setError(result.error || 'Failed to create folder');
    }
  }, [newFolderName, currentPath, navigateTo]);

  const handleNewFolderKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') submitNewFolder();
    else if (e.key === 'Escape') setIsCreatingFolder(false);
  }, [submitNewFolder]);

  // Re-read the current directory whenever PDR regains focus or
  // the modal becomes visible — catches folders the user created
  // (or deleted) in File Explorer while the modal was open. Without
  // this, external changes are invisible until the user manually
  // navigates away and back. mode='source' modals shouldn't refresh
  // mid-listing because they may already have selected files; we
  // only refresh when the user is purely picking a destination
  // (no selectedFile yet).
  useEffect(() => {
    if (!isOpen) return;
    const refresh = () => {
      if (!currentPath || isCreatingFolder || selectedFile) return;
      // Quietly re-read current dir; addToHistory=false so this
      // doesn't pollute the back/forward stack.
      navigateTo(currentPath, false);
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // navigateTo intentionally omitted — re-creating the listener
    // every navigation would thrash the focus subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, currentPath, isCreatingFolder, selectedFile]);

  // Right-click context menu on the main panel — opens a small
  // floating menu with a "New folder" entry. Matches the muscle
  // memory from File Explorer where right-click on empty space is
  // the natural way to create a folder. Position is the click
  // coordinates in viewport space.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener('click', dismiss);
    window.addEventListener('keydown', dismiss);
    return () => {
      window.removeEventListener('click', dismiss);
      window.removeEventListener('keydown', dismiss);
    };
  }, [contextMenu]);
  const handleMainPanelContextMenu = useCallback((e: React.MouseEvent) => {
    if (isArchiveMode) return;
    if (!currentPath) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, [isArchiveMode, currentPath]);

  // Resize handling
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startW: modalSize.width,
      startH: modalSize.height,
    };
  }, [modalSize]);

  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeRef.current) return;
      const { startX, startY, startW, startH } = resizeRef.current;
      const newW = Math.max(600, Math.min(window.innerWidth - 40, startW + (e.clientX - startX) * 2));
      const newH = Math.max(400, Math.min(window.innerHeight - 40, startH + (e.clientY - startY) * 2));
      setModalSize({ width: newW, height: newH });
    };
    const handleMouseUp = () => {
      setIsResizing(false);
      resizeRef.current = null;
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  // Breadcrumb segments
  const breadcrumbs = currentPath
    ? currentPath.split(/[\\/]/).filter(Boolean).reduce<Array<{ label: string; path: string }>>((acc, segment, i) => {
        const prevPath = i === 0 ? '' : acc[i - 1].path;
        const isUNC = currentPath.startsWith('\\\\');
        let thisPath: string;
        if (isUNC && i === 0) {
          thisPath = '\\\\' + segment;
        } else if (isUNC && i === 1) {
          thisPath = acc[0].path + '\\' + segment;
        } else if (i === 0) {
          thisPath = segment + '\\';
        } else {
          thisPath = prevPath + '\\' + segment;
        }
        acc.push({ label: segment, path: thisPath });
        return acc;
      }, [])
    : [];

  const formatSize = (bytes: number) => {
    if (!bytes || bytes <= 0) return '';
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1000) return `${(gb / 1024).toFixed(1)} TB`;
    return `${gb.toFixed(0)} GB`;
  };

  const hasImages = entries.some(e => e.isImage);

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/[0.3] backdrop-blur-[3px] flex items-center justify-center z-50 p-4"
        onMouseDown={(e) => { mouseDownOnBackdropRef.current = e.target === e.currentTarget; }}
        onClick={(e) => { if (e.target === e.currentTarget && mouseDownOnBackdropRef.current) onCancel(); }}
        style={isResizing ? { cursor: 'nwse-resize' } : undefined}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0, y: 10 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ type: "spring", duration: 0.5, bounce: 0.3 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-background rounded-2xl shadow-2xl border border-border overflow-hidden flex flex-col relative"
          style={{ width: `${modalSize.width}px`, height: `${modalSize.height}px`, maxWidth: '95vw', maxHeight: '95vh' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-secondary">
                <FolderOpen className="w-5 h-5 text-primary" />
              </div>
              <h2 className="text-lg font-semibold text-foreground">{title}</h2>
            </div>
            <button
              onClick={onCancel}
              className="p-2 hover:bg-secondary/50 rounded-full transition-colors"
            >
              <X className="w-5 h-5 text-muted-foreground" />
            </button>
          </div>

          {/* Toolbar - Navigation + Breadcrumbs/Path input */}
          <div className="flex items-center gap-2 px-5 py-2.5 border-b border-border bg-card/50">
            <IconTooltip label="Back" side="bottom">
              <button
                onClick={goBack}
                disabled={historyIndex <= 0}
                className="p-2 rounded-lg hover:bg-secondary disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              >
                <ArrowLeft className="w-5 h-5 text-muted-foreground" />
              </button>
            </IconTooltip>
            <IconTooltip label="Forward" side="bottom">
              <button
                onClick={goForward}
                disabled={historyIndex >= history.length - 1}
                className="p-2 rounded-lg hover:bg-secondary disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              >
                <ArrowRight className="w-5 h-5 text-muted-foreground" />
              </button>
            </IconTooltip>
            <IconTooltip label="Up one level" side="bottom">
              <button
                onClick={goUp}
                disabled={!currentPath || currentPath.replace(/[\\/]+$/, '').split(/[\\/]/).length <= 1}
                className="p-2 rounded-lg hover:bg-secondary disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              >
                <ChevronLeft className="w-5 h-5 text-muted-foreground" />
              </button>
            </IconTooltip>

            {/* Breadcrumbs / Path input */}
            <div
              className="flex-1 flex items-center gap-1 overflow-x-auto min-w-0 px-3 py-1.5 rounded-lg bg-background border border-border cursor-text"
              onClick={() => { if (!isEditingPath) startEditingPath(); }}
            >
              {isEditingPath ? (
                <input
                  ref={pathInputRef}
                  type="text"
                  value={editPathValue}
                  onChange={(e) => setEditPathValue(e.target.value)}
                  onKeyDown={handlePathKeyDown}
                  onBlur={submitEditPath}
                  className="w-full text-sm text-foreground bg-transparent outline-none font-mono"
                  placeholder="Type or paste a path (e.g. \\\\MyCloud\\Photos)"
                />
              ) : !currentPath ? (
                <span className="text-sm text-muted-foreground px-1 flex items-center gap-2">
                  <Pencil className="w-3.5 h-3.5" />
                  Click to type a path, or select a drive below
                </span>
              ) : (
                <>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setCurrentPath('');
                      setEntries([]);
                      setSelectedPath('');
                    }}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0 flex items-center gap-1"
                  >
                    <Monitor className="w-4 h-4" />
                    This PC
                  </button>
                  {breadcrumbs.map((crumb, i) => (
                    <React.Fragment key={crumb.path}>
                      <ChevronRight className="w-4 h-4 text-muted-foreground/70 shrink-0" />
                      <button
                        onClick={(e) => { e.stopPropagation(); navigateTo(crumb.path); }}
                        className={`text-sm shrink-0 transition-colors px-1.5 py-0.5 rounded ${
                          i === breadcrumbs.length - 1
                            ? 'text-foreground font-medium bg-secondary/60'
                            : 'text-muted-foreground hover:text-foreground hover:bg-secondary/80 hover:underline'
                        }`}
                      >
                        {crumb.label}
                      </button>
                    </React.Fragment>
                  ))}
                  <IconTooltip label="Edit path" side="left">
                    <button
                      onClick={(e) => { e.stopPropagation(); startEditingPath(); }}
                      className="ml-auto p-1 hover:bg-secondary rounded transition-colors shrink-0"
                    >
                      <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                    </button>
                  </IconTooltip>
                </>
              )}
            </div>

            {/* New Folder button */}
            {!isArchiveMode && (
              <IconTooltip label="New Folder" side="bottom">
                <button
                  onClick={startCreatingFolder}
                  disabled={!currentPath}
                  className="p-2 rounded-lg hover:bg-secondary disabled:opacity-30 disabled:hover:bg-transparent transition-colors shrink-0"
                >
                  <FolderPlus className="w-5 h-5 text-muted-foreground" />
                </button>
              </IconTooltip>
            )}
          </div>

          {/* Body - Sidebar + Main */}
          <div className="flex flex-1 overflow-hidden">
            {/* Left sidebar - drives and tree */}
            <div className="w-[240px] border-r border-border bg-card/30 overflow-y-auto shrink-0">
              <div className="p-2.5">
                {/* Quick Access — collapsible accordion, closed by default.
                    Matches the File Explorer sidebar pattern where less
                    frequently used sections are hidden until clicked. */}
                {quickAccess && (quickAccess.desktop || quickAccess.downloads || quickAccess.documents || quickAccess.pictures) && (
                  <>
                    <button
                      onClick={() => setQuickAccessOpen(v => !v)}
                      className="w-full flex items-center justify-between gap-2 px-2 py-2 text-xs uppercase tracking-wider text-muted-foreground font-medium hover:text-foreground transition-colors"
                    >
                      <span>Quick Access</span>
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${quickAccessOpen ? '' : '-rotate-90'}`} />
                    </button>
                    {quickAccessOpen && (
                      <div className="space-y-0.5">
                        {quickAccess.desktop && (
                          <QuickAccessItem icon={Monitor} label="Desktop" path={quickAccess.desktop}
                            isSelected={currentPath === quickAccess.desktop} onClick={() => navigateTo(quickAccess.desktop!)} />
                        )}
                        {quickAccess.downloads && (
                          <QuickAccessItem icon={Download} label="Downloads" path={quickAccess.downloads}
                            isSelected={currentPath === quickAccess.downloads} onClick={() => navigateTo(quickAccess.downloads!)} />
                        )}
                        {quickAccess.documents && (
                          <QuickAccessItem icon={FileText} label="Documents" path={quickAccess.documents}
                            isSelected={currentPath === quickAccess.documents} onClick={() => navigateTo(quickAccess.documents!)} />
                        )}
                        {quickAccess.pictures && (
                          <QuickAccessItem icon={Image} label="Pictures" path={quickAccess.pictures}
                            isSelected={currentPath === quickAccess.pictures} onClick={() => navigateTo(quickAccess.pictures!)} />
                        )}
                        {quickAccess.videos && (
                          <QuickAccessItem icon={Film} label="Videos" path={quickAccess.videos}
                            isSelected={currentPath === quickAccess.videos} onClick={() => navigateTo(quickAccess.videos!)} />
                        )}
                        {quickAccess.music && (
                          <QuickAccessItem icon={Music} label="Music" path={quickAccess.music}
                            isSelected={currentPath === quickAccess.music} onClick={() => navigateTo(quickAccess.music!)} />
                        )}
                      </div>
                    )}
                    <div className="border-t border-border my-2" />
                  </>
                )}

                <div className="text-xs uppercase tracking-wider text-muted-foreground font-medium px-2 py-2">
                  Drives
                </div>
                {drives.map(drive => (
                  <DriveItem
                    key={drive.letter}
                    drive={drive}
                    isSelected={currentPath.startsWith(drive.letter)}
                    onClick={() => navigateTo(drive.letter + '\\')}
                    requiredGB={plannedCollectionSizeGB}
                    showRating={showDriveRatings}
                  />
                ))}

                {treeNodes.some(n => n.expanded) && (
                  <>
                    <div className="border-t border-border my-2" />
                    <div className="text-xs uppercase tracking-wider text-muted-foreground font-medium px-2 py-2">
                      Folders
                    </div>
                    {treeNodes.map(node => (
                      <TreeNodeItem
                        key={node.path}
                        node={node}
                        depth={0}
                        currentPath={currentPath}
                        onToggle={handleTreeToggle}
                        onSelect={handleTreeSelect}
                      />
                    ))}
                  </>
                )}
              </div>
            </div>

            {/* Main content area */}
            <div ref={mainPanelRef} className="flex-1 overflow-y-auto bg-background" onContextMenu={handleMainPanelContextMenu}>
              {loading ? (
                <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
                  <Loader2 className="w-7 h-7 animate-spin text-primary" />
                  <span className="text-base">Loading...</span>
                </div>
              ) : error ? (
                <div className="flex flex-col items-center justify-center h-full gap-3 px-8 text-center">
                  <div className="p-3 rounded-full bg-destructive/10">
                    <AlertCircle className="w-7 h-7 text-destructive" />
                  </div>
                  <p className="text-base text-muted-foreground">{error}</p>
                  <Button variant="outline" size="sm" onClick={goBack}>
                    Go Back
                  </Button>
                </div>
              ) : !currentPath ? (
                <div className="p-4 space-y-3">
                  {/* Saved destinations — quick-pick for previously used locations */}
                  {enableSavedLocations && savedDestinations.length > 0 && (
                    <div>
                      <div className="text-xs uppercase tracking-wider text-muted-foreground font-medium px-1 mb-2">
                        Saved Destinations
                      </div>
                      <div className="space-y-1.5 mb-3">
                        {savedDestinations.map(dest => {
                          const driveLetter = dest.substring(0, 1).toUpperCase();
                          const matchedDrive = drives.find(d => d.letter.toUpperCase().startsWith(driveLetter));
                          const folderName = dest.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dest;
                          return (
                            <div
                              key={dest}
                              className="flex items-center gap-3 p-3 rounded-xl bg-card border border-primary hover:bg-primary/10 transition-all group cursor-pointer"
                              onClick={() => {
                                setSelectedPath(dest);
                                navigateTo(dest);
                              }}
                            >
                              <div className="p-2 rounded-lg bg-primary/10 shrink-0">
                                <FolderOpen className="w-4 h-4 text-primary" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium text-foreground truncate">{folderName}</div>
                                <div className="text-xs text-muted-foreground font-mono truncate">{dest}</div>
                              </div>
                              {matchedDrive && (
                                <span className="text-[10px] text-muted-foreground shrink-0">
                                  {(matchedDrive.freeBytes / (1024 * 1024 * 1024)).toFixed(0)} GB free
                                </span>
                              )}
                              <IconTooltip label="Remove saved destination" side="left">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeFromSavedDestinations(dest);
                                    setSavedDestinations(prev => prev.filter(p => p.toLowerCase() !== dest.toLowerCase()));
                                  }}
                                  className="p-1 opacity-0 group-hover:opacity-100 hover:bg-secondary rounded transition-all shrink-0"
                                >
                                  <X className="w-3 h-3 text-muted-foreground" />
                                </button>
                              </IconTooltip>
                            </div>
                          );
                        })}
                      </div>
                      <div className="text-xs uppercase tracking-wider text-muted-foreground font-medium px-1 mb-2">
                        All Drives
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                  {drives.map(drive => {
                    const driveRating = showDriveRatings ? rateDrive(drive, plannedCollectionSizeGB) : null;
                    return (
                      <button
                        key={drive.letter}
                        onClick={() => navigateTo(drive.letter + '\\')}
                        className={`flex items-center gap-3 p-4 rounded-xl bg-card border-2 transition-all text-left group ${
                          driveRating ? ratingStyles[driveRating.rating] : 'border-border hover:border-primary/40 hover:bg-primary/5'
                        }`}
                      >
                        <div className="p-2.5 rounded-lg bg-secondary group-hover:bg-primary/10 transition-colors relative">
                          <HardDrive className="w-5 h-5 text-primary" />
                          {driveRating && (
                            <div className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${ratingDotStyles[driveRating.rating]}`} />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-base font-medium text-foreground truncate">
                              {drive.label} ({drive.letter})
                            </span>
                            {driveRating?.badge && (
                              <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ring-1 ${
                                driveRating.rating === 'good' ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/15 ring-emerald-500/30' :
                                driveRating.rating === 'warning' ? 'text-amber-700 dark:text-amber-300 bg-amber-500/15 ring-amber-500/30' :
                                'text-rose-700 dark:text-rose-300 bg-rose-500/15 ring-rose-500/30'
                              }`}>
                                {driveRating.badge}
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {drive.type}{drive.freeBytes > 0 ? ` \u2022 ${formatSize(drive.freeBytes)} free of ${formatSize(drive.totalBytes)}` : ''}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                  {/* Drive Advisor link */}
                  {onOpenDriveAdvisor && (
                    <button
                      onClick={onOpenDriveAdvisor}
                      className="flex items-center gap-3 p-4 rounded-xl bg-primary/5 border-2 border-dashed border-primary/30 hover:border-primary/50 hover:bg-primary/10 transition-all text-left group col-span-2"
                    >
                      <div className="p-2.5 rounded-lg bg-primary/10">
                        <Info className="w-5 h-5 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-primary">Not sure which drive? Open Drive Advisor</div>
                        <div className="text-xs text-muted-foreground">Get personalised guidance on which drive is best for your library</div>
                      </div>
                    </button>
                  )}
                  </div>
                </div>
              ) : (entries.length === 0 && !isCreatingFolder) ? (
                // "This folder is empty" message replaces the file list
                // ONLY when there's nothing to show AND the user isn't
                // mid-create. Without the `&& !isCreatingFolder` guard,
                // clicking New Folder inside an empty directory swapped
                // setIsCreatingFolder to true but this branch still won —
                // so the input never rendered (it lives in the populated
                // branch below) and the button looked broken. Reproduced
                // by Terry on D:\2. PDR Testing\ on a fresh 2 TB drive,
                // 03/05/2026.
                <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
                  <Folder className="w-9 h-9 text-muted-foreground/30" />
                  <span className="text-base">This folder is empty</span>
                </div>
              ) : (
                <div className="p-2.5">
                  {/* View mode + sort toolbar — visible whenever the folder is
                      not empty, so the toggle works on plain folders too, not
                      just folders that contain images. */}
                  {entries.length > 0 && (
                    <div className="flex items-center gap-2.5 px-2 py-2 mb-1 sticky top-0 z-10 bg-background/95 backdrop-blur-sm">
                      <div className="flex items-center border border-border rounded-lg overflow-hidden shrink-0">
                        <IconTooltip label="Grid view" side="bottom"><button onClick={() => setFileViewMode('grid')} className={`p-1.5 transition-colors ${fileViewMode === 'grid' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`}><LayoutGrid className="w-3.5 h-3.5" /></button></IconTooltip>
                        <IconTooltip label="List view" side="bottom"><button onClick={() => setFileViewMode('list')} className={`p-1.5 transition-colors ${fileViewMode === 'list' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`}><List className="w-3.5 h-3.5" /></button></IconTooltip>
                        <IconTooltip label="Details view" side="bottom"><button onClick={() => setFileViewMode('details')} className={`p-1.5 transition-colors ${fileViewMode === 'details' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`}><Table2 className="w-3.5 h-3.5" /></button></IconTooltip>
                      </div>
                      {/* Sort is driven by clicking the column headers in the
                          Details view, matching the File Explorer pattern. */}
                      {fileViewMode === 'grid' && hasImages && (
                        <>
                          <ZoomOut className="w-4 h-4 text-muted-foreground shrink-0" />
                          <input
                            type="range"
                            min={32}
                            max={180}
                            value={thumbSize}
                            onChange={(e) => setThumbSize(parseInt(e.target.value))}
                            className="flex-1 h-1 cursor-pointer"
                            style={{ accentColor: 'hsl(249, 100%, 81%)' }}
                          />
                          <ZoomIn className="w-4 h-4 text-muted-foreground shrink-0" />
                          <span className="text-xs text-muted-foreground w-10 text-right">{thumbSize}px</span>
                        </>
                      )}
                    </div>
                  )}

                  {/* New folder inline input */}
                  {isCreatingFolder && (
                    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-primary/5 border border-primary/30">
                      <FolderPlus className="w-5 h-5 text-primary shrink-0" />
                      <input
                        ref={newFolderInputRef}
                        type="text"
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        onKeyDown={handleNewFolderKeyDown}
                        onBlur={submitNewFolder}
                        className="flex-1 text-base text-foreground bg-transparent outline-none border-b border-primary/40 pb-0.5"
                        placeholder="Folder name"
                      />
                    </div>
                  )}

                  {/* Folder entries — respect the view toggle + sort order. */}
                  {fileViewMode === 'details' ? (
                    (sortedEntries.filter(e => e.isDirectory).length > 0 || quickAccess) && (
                      <div className="mb-2 overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-xs text-muted-foreground border-b border-border/50 select-none">
                              <IconTooltip label="Click to sort by name" side="bottom">
                                <th
                                  onClick={() => handleHeaderSort('name')}
                                  className="text-left py-1.5 px-3 font-medium cursor-pointer hover:text-foreground transition-colors"
                                >
                                  Name{sortIndicator('name')}
                                </th>
                              </IconTooltip>
                              <IconTooltip label="Click to sort by modified date" side="bottom">
                                <th
                                  onClick={() => handleHeaderSort('date')}
                                  className="text-left py-1.5 px-3 font-medium cursor-pointer hover:text-foreground transition-colors"
                                >
                                  Modified{sortIndicator('date')}
                                </th>
                              </IconTooltip>
                              <th className="text-left py-1.5 px-3 font-medium">Type</th>
                            </tr>
                          </thead>
                          <tbody>
                            {/* Quick Access shortcut rows — appear at the top of
                                the Details view so shortcuts are reachable
                                without opening the sidebar accordion. */}
                            {quickAccess && ([
                              quickAccess.desktop && { icon: Monitor, label: 'Desktop', path: quickAccess.desktop },
                              quickAccess.downloads && { icon: Download, label: 'Downloads', path: quickAccess.downloads },
                              quickAccess.documents && { icon: FileText, label: 'Documents', path: quickAccess.documents },
                              quickAccess.pictures && { icon: Image, label: 'Pictures', path: quickAccess.pictures },
                              quickAccess.videos && { icon: Film, label: 'Videos', path: quickAccess.videos },
                              quickAccess.music && { icon: Music, label: 'Music', path: quickAccess.music },
                            ].filter(Boolean) as Array<{ icon: any; label: string; path: string }>).map(({ icon: Ico, label, path: p }) => (
                              <tr
                                key={'qa-' + p}
                                onClick={() => navigateTo(p)}
                                className="border-b border-border/30 hover:bg-primary/5 transition-colors cursor-pointer"
                              >
                                <td className="py-1.5 px-3 max-w-[320px]">
                                  <div className="flex items-center gap-2 truncate">
                                    <Ico className="w-4 h-4 text-primary shrink-0" />
                                    <span className="truncate text-foreground">{label}</span>
                                  </div>
                                </td>
                                <td className="py-1.5 px-3 text-muted-foreground whitespace-nowrap">—</td>
                                <td className="py-1.5 px-3 text-primary text-[11px] font-medium uppercase tracking-wide">Quick Access</td>
                              </tr>
                            ))}
                            {sortedEntries.filter(e => e.isDirectory).map(entry => (
                              <tr
                                key={entry.path}
                                onClick={() => handleEntryClick(entry)}
                                className="border-b border-border/30 hover:bg-secondary/30 transition-colors cursor-pointer"
                              >
                                <td className="py-1.5 px-3 max-w-[320px]">
                                  <div className="flex items-center gap-2 truncate">
                                    {entry.hasSubfolders ? <FolderOpen className="w-4 h-4 text-primary shrink-0" /> : <Folder className="w-4 h-4 text-primary/60 shrink-0" />}
                                    <span className="truncate text-foreground">{entry.name}</span>
                                  </div>
                                </td>
                                <td className="py-1.5 px-3 text-muted-foreground whitespace-nowrap">
                                  {entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                                </td>
                                <td className="py-1.5 px-3 text-muted-foreground">Folder</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  ) : fileViewMode === 'list' ? (
                    sortedEntries.filter(e => e.isDirectory).map(entry => (
                      <button
                        key={entry.path}
                        onClick={() => handleEntryClick(entry)}
                        className="w-full flex items-center gap-3 px-3 py-1.5 rounded-lg text-left transition-colors hover:bg-secondary/50 cursor-pointer"
                      >
                        {entry.hasSubfolders
                          ? <FolderOpen className="w-4 h-4 text-primary shrink-0" />
                          : <Folder className="w-4 h-4 text-primary/60 shrink-0" />
                        }
                        <span className="text-sm text-foreground truncate flex-1">{entry.name}</span>
                        {entry.modifiedAt > 0 && (
                          <span className="text-[11px] text-muted-foreground shrink-0 whitespace-nowrap">
                            {new Date(entry.modifiedAt).toLocaleDateString()}
                          </span>
                        )}
                      </button>
                    ))
                  ) : (
                    sortedEntries.filter(e => e.isDirectory).map(entry => (
                      <button
                        key={entry.path}
                        onClick={() => handleEntryClick(entry)}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors hover:bg-secondary/50 cursor-pointer"
                      >
                        {entry.hasSubfolders
                          ? <FolderOpen className="w-5 h-5 text-primary shrink-0" />
                          : <Folder className="w-5 h-5 text-primary/60 shrink-0" />
                        }
                        <span className="text-base text-foreground truncate">{entry.name}</span>
                      </button>
                    ))
                  )}

                  {/* Archive file entries (ZIP/RAR mode) */}
                  {sortedEntries.filter(e => e.isArchive).map(entry => (
                    <button
                      key={entry.path}
                      onClick={() => handleEntryClick(entry)}
                      onDoubleClick={() => handleEntryDoubleClick(entry)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors cursor-pointer ${
                        selectedFile === entry.path
                          ? 'bg-primary/10 border border-primary/30'
                          : 'hover:bg-secondary/50'
                      }`}
                    >
                      <FileArchive className={`w-5 h-5 shrink-0 ${selectedFile === entry.path ? 'text-primary' : 'text-muted-foreground'}`} />
                      <span className="text-base text-foreground truncate flex-1">{entry.name}</span>
                      {entry.sizeBytes > 0 && (
                        <span className="text-sm text-muted-foreground shrink-0">
                          {entry.sizeBytes < 1024 * 1024
                            ? `${(entry.sizeBytes / 1024).toFixed(0)} KB`
                            : entry.sizeBytes < 1024 * 1024 * 1024
                            ? `${(entry.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                            : `${(entry.sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
                          }
                        </span>
                      )}
                    </button>
                  ))}

                  {/* Image entries */}
                  {hasImages && fileViewMode === 'grid' && (
                    <div className="flex flex-wrap gap-2.5 mt-1 px-1">
                      {sortedEntries.filter(e => e.isImage).map(entry => (
                        <IconTooltip key={entry.path} label={entry.name} side="top">
                          <div
                            className="flex flex-col items-center gap-1.5 p-2 rounded-lg hover:bg-secondary/30 transition-colors"
                            style={{ width: `${thumbSize + 20}px` }}
                          >
                            <div
                              className="rounded-lg overflow-hidden bg-muted/50 border border-border/50 flex items-center justify-center"
                              style={{ width: `${thumbSize}px`, height: `${thumbSize}px` }}
                            >
                              {thumbnails[entry.path] ? (
                                <img
                                  src={thumbnails[entry.path]}
                                  alt={entry.name}
                                  className="object-cover w-full h-full"
                                />
                              ) : (
                                <Image className="w-6 h-6 text-muted-foreground/70" />
                              )}
                            </div>
                            <span className="text-xs text-muted-foreground truncate w-full text-center leading-tight">
                              {entry.name}
                            </span>
                          </div>
                        </IconTooltip>
                      ))}
                    </div>
                  )}
                  {hasImages && fileViewMode === 'list' && (
                    <div className="mt-1">
                      {sortedEntries.filter(e => e.isImage).map(entry => (
                        <IconTooltip key={entry.path} label={entry.name} side="top">
                          <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg hover:bg-secondary/30 transition-colors">
                            <Image className="w-4 h-4 text-muted-foreground/70 shrink-0" />
                            <span className="text-sm text-foreground truncate flex-1">{entry.name}</span>
                            {entry.sizeBytes > 0 && (
                              <span className="text-xs text-muted-foreground shrink-0">
                                {entry.sizeBytes < 1024 * 1024
                                  ? `${(entry.sizeBytes / 1024).toFixed(0)} KB`
                                  : `${(entry.sizeBytes / (1024 * 1024)).toFixed(1)} MB`}
                              </span>
                            )}
                          </div>
                        </IconTooltip>
                      ))}
                    </div>
                  )}
                  {hasImages && fileViewMode === 'details' && (
                    <div className="mt-1 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-xs text-muted-foreground border-b border-border/50 select-none">
                            <IconTooltip label="Click to sort by name" side="bottom">
                              <th
                                onClick={() => handleHeaderSort('name')}
                                className="text-left py-1.5 px-3 font-medium cursor-pointer hover:text-foreground transition-colors"
                              >
                                Name{sortIndicator('name')}
                              </th>
                            </IconTooltip>
                            <th className="text-left py-1.5 px-3 font-medium">Type</th>
                            <IconTooltip label="Click to sort by size" side="bottom">
                              <th
                                onClick={() => handleHeaderSort('size')}
                                className="text-right py-1.5 px-3 font-medium cursor-pointer hover:text-foreground transition-colors"
                              >
                                Size{sortIndicator('size')}
                              </th>
                            </IconTooltip>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedEntries.filter(e => e.isImage).map(entry => {
                            const ext = entry.name.split('.').pop()?.toUpperCase() || '';
                            return (
                              <tr key={entry.path} className="border-b border-border/30 hover:bg-secondary/30 transition-colors">
                                <td className="py-1.5 px-3 truncate max-w-[300px]">
                                  <div className="flex items-center gap-2">
                                    <Image className="w-3.5 h-3.5 text-muted-foreground/70 shrink-0" />
                                    <span className="truncate">{entry.name}</span>
                                  </div>
                                </td>
                                <td className="py-1.5 px-3 text-muted-foreground">{ext}</td>
                                <td className="py-1.5 px-3 text-right text-muted-foreground">
                                  {entry.sizeBytes > 0
                                    ? entry.sizeBytes < 1024 * 1024
                                      ? `${(entry.sizeBytes / 1024).toFixed(0)} KB`
                                      : `${(entry.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                                    : '—'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-3.5 border-t border-border bg-card">
            <div className="flex-1 min-w-0 mr-4">
              {effectiveSelection ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground shrink-0">Selected:</span>
                  <span className="text-sm font-mono text-foreground bg-muted px-2.5 py-1 rounded truncate">
                    {effectiveSelection}
                  </span>
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">
                  {mode === 'folder' ? 'No folder selected' : 'Browse to a folder or archive to add as a source'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2.5 shrink-0">
              <Button variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button onClick={handleConfirm} disabled={!effectiveSelection}>
                {hasArchiveSelected ? 'Add Archive' : mode === 'folder' ? 'Select This Folder' : 'Add Source'}
              </Button>
            </div>
          </div>

          {/* Resize handle */}
          <IconTooltip label="Drag to resize" side="top">
            <div
              onMouseDown={handleResizeMouseDown}
              className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize z-10"
              style={{
                background: 'linear-gradient(135deg, transparent 50%, hsl(249, 100%, 81%) 50%)',
                borderRadius: '0 0 16px 0',
                opacity: 0.5,
              }}
            />
          </IconTooltip>

          {/* Right-click context menu — File Explorer-style "New
              folder" entry. Floating, dismissed on any click or
              key. Positioned at the click coords. */}
          {contextMenu && (
            <div
              className="fixed z-[200] min-w-[180px] rounded-lg border border-border bg-popover shadow-lg py-1 text-sm"
              style={{ top: contextMenu.y, left: contextMenu.x }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => { setContextMenu(null); startCreatingFolder(); }}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-secondary text-foreground"
              >
                <FolderPlus className="w-4 h-4 text-muted-foreground" />
                <span>New folder</span>
              </button>
              <button
                onClick={() => { setContextMenu(null); if (currentPath) navigateTo(currentPath, false); }}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-secondary text-foreground"
              >
                <ChevronRight className="w-4 h-4 text-muted-foreground rotate-90" />
                <span>Refresh</span>
              </button>
            </div>
          )}

          {/* Drive suitability warning overlay */}
          <AnimatePresence>
            {driveWarning && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 bg-black/40 backdrop-blur-[2px] flex items-center justify-center z-20 rounded-2xl"
              >
                <motion.div
                  initial={{ scale: 0.95, opacity: 0, y: 8 }}
                  animate={{ scale: 1, opacity: 1, y: 0 }}
                  exit={{ scale: 0.95, opacity: 0 }}
                  transition={{ type: "spring", duration: 0.4, bounce: 0.2 }}
                  className="bg-background rounded-xl border border-border shadow-2xl mx-6 max-w-[480px] w-full overflow-hidden"
                >
                  {/* Warning header */}
                  <div className="flex items-center gap-3 px-5 py-4 border-b border-border bg-amber-50/50 dark:bg-amber-950/20">
                    <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-900/40">
                      <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">
                        {/* Check if ANY non-system, non-network drive has enough space */}
                        {drives.filter(d =>
                          !d.letter.toUpperCase().startsWith('C') &&
                          d.type !== 'Network' &&
                          d.type !== 'CD/DVD' &&
                          plannedCollectionSizeGB &&
                          (d.freeBytes / (1024 * 1024 * 1024)) >= plannedCollectionSizeGB
                        ).length === 0
                          ? 'No connected drives are suitable for your library'
                          : 'This drive may not be suitable'}
                      </h3>
                      <p className="text-xs text-foreground/60 mt-0.5">Based on your library plan, we've identified some concerns</p>
                    </div>
                  </div>

                  <div className="px-5 py-4 space-y-4 max-h-[50vh] overflow-y-auto">
                    {/* Reasons */}
                    <div className="space-y-2.5">
                      {driveWarning.reasons.map((reason, i) => (
                        <div key={i} className="flex gap-2.5 text-sm">
                          <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                          <p className="text-foreground/80 leading-relaxed">{reason}</p>
                        </div>
                      ))}
                    </div>

                    {/* Suggestions */}
                    <div className="bg-secondary/50 rounded-lg p-4 space-y-2.5">
                      <p className="text-xs font-semibold text-foreground/70 uppercase tracking-wider">What we'd suggest</p>
                      {driveWarning.suggestions.map((suggestion, i) => {
                        const isGuideLink = suggestion.includes('PDR Guides');
                        return (
                          <div key={i} className="flex gap-2.5 text-sm">
                            {isGuideLink ? (
                              <ExternalLink className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                            ) : (
                              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                            )}
                            {isGuideLink ? (
                              <p className="text-foreground/80 leading-relaxed">
                                <button
                                  onClick={() => window.open('https://www.photodaterescue.com/guides/tools-recommendations', '_blank')}
                                  className="text-primary hover:text-primary/80 underline underline-offset-2 transition-colors"
                                >
                                  Visit our Guides section
                                </button>
                                {' '}for drive recommendations and setup advice tailored to photo libraries.
                              </p>
                            ) : (
                              <p className="text-foreground/80 leading-relaxed">{suggestion}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-between px-5 py-3.5 border-t border-border bg-card">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDriveWarning(null)}
                      className="gap-1.5"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" />
                      Choose a different drive
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const path = driveWarning.path;
                        setDriveWarning(null);
                        if (enableSavedLocations) saveDestionationToRecents(path);
                        onSelect(path);
                      }}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      Use this drive anyway
                    </Button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function QuickAccessItem({ icon: Icon, label, path, isSelected, onClick }: { icon: any; label: string; path: string; isSelected: boolean; onClick: () => void }) {
  return (
    <IconTooltip label={path} side="right">
      <button
        onClick={onClick}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors ${
          isSelected ? 'bg-primary/10 text-primary' : 'text-foreground/80 hover:bg-secondary/50 hover:text-foreground'
        }`}
      >
        <Icon className="w-4 h-4 shrink-0" />
        <span className="text-sm font-medium truncate">{label}</span>
      </button>
    </IconTooltip>
  );
}

function DriveItem({ drive, isSelected, onClick, requiredGB, showRating }: { drive: DriveInfo; isSelected: boolean; onClick: () => void; requiredGB?: number | null; showRating?: boolean }) {
  const driveRating = showRating ? rateDrive(drive, requiredGB) : null;
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${
        isSelected ? 'bg-secondary text-foreground' : 'hover:bg-secondary/50 text-muted-foreground'
      }`}
    >
      <div className="relative shrink-0">
        <HardDrive className={`w-4 h-4 ${isSelected ? 'text-primary' : ''}`} />
        {driveRating && (
          <div className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${ratingDotStyles[driveRating.rating]}`} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{drive.label} ({drive.letter})</div>
      </div>
    </button>
  );
}

function TreeNodeItem({ node, depth, currentPath, onToggle, onSelect }: {
  node: TreeNode;
  depth: number;
  currentPath: string;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const isActive = currentPath === node.path;

  return (
    <>
      <div
        className={`flex items-center gap-1 py-1.5 px-1 rounded-lg cursor-pointer transition-colors ${
          isActive ? 'bg-secondary text-foreground' : 'hover:bg-secondary/40 text-muted-foreground'
        }`}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        <button
          onClick={(e) => { e.stopPropagation(); onToggle(node.path); }}
          className="p-0.5 shrink-0"
        >
          {node.loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : node.expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </button>
        <button
          onClick={() => onSelect(node.path)}
          className="flex items-center gap-2 min-w-0 flex-1 text-left"
        >
          {node.hasSubfolders
            ? <FolderOpen className={`w-4 h-4 shrink-0 ${isActive ? 'text-primary' : 'text-foreground/70'}`} />
            : <Folder className={`w-4 h-4 shrink-0 ${isActive ? 'text-primary' : 'text-foreground/70'}`} />
          }
          <span className="text-sm truncate">{node.name}</span>
        </button>
      </div>
      {node.expanded && node.children && node.children.map(child => (
        <TreeNodeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          currentPath={currentPath}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}
