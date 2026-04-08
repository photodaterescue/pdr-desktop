import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, HardDrive, Folder, FolderOpen, FolderPlus, ChevronRight, ChevronLeft, ChevronDown,
  Image, ArrowLeft, ArrowRight, AlertCircle, Loader2, Monitor, ZoomIn, ZoomOut, Pencil,
  FileArchive, LayoutGrid, List, Table2
} from 'lucide-react';
import { Button } from '@/components/ui/custom-button';
import { listDrives, readDirectory, getThumbnail, createDirectory, DriveInfo, DirectoryEntry } from '@/lib/electron-bridge';

interface FolderBrowserModalProps {
  isOpen: boolean;
  onSelect: (path: string) => void;
  onCancel: () => void;
  title?: string;
  mode?: 'folder' | 'source' | 'archives';
  defaultPath?: string;
}

interface TreeNode {
  path: string;
  name: string;
  expanded: boolean;
  children: TreeNode[] | null;
  loading: boolean;
  hasSubfolders?: boolean;
}

export function FolderBrowserModal({ isOpen, onSelect, onCancel, title = 'Select Folder', mode = 'folder', defaultPath }: FolderBrowserModalProps) {
  const mouseDownOnBackdropRef = useRef(false);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
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
  const [selectedFile, setSelectedFile] = useState<string>('');
  const isArchiveMode = mode === 'archives';
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
    setCurrentPath('');
    setEntries([]);
    setSelectedPath('');
    setHistory([]);
    setHistoryIndex(-1);
    setThumbnails({});
    setIsEditingPath(false);
    setSelectedFile('');
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
    if (selectedFile) {
      onSelect(selectedFile);
    } else if (selectedPath) {
      onSelect(selectedPath);
    }
  }, [selectedPath, selectedFile, onSelect]);

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
      navigateTo(newPath);
    } else {
      setError(result.error || 'Failed to create folder');
    }
  }, [newFolderName, currentPath, navigateTo]);

  const handleNewFolderKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') submitNewFolder();
    else if (e.key === 'Escape') setIsCreatingFolder(false);
  }, [submitNewFolder]);

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
            <button
              onClick={goBack}
              disabled={historyIndex <= 0}
              className="p-2 rounded-lg hover:bg-secondary disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              title="Back"
            >
              <ArrowLeft className="w-5 h-5 text-muted-foreground" />
            </button>
            <button
              onClick={goForward}
              disabled={historyIndex >= history.length - 1}
              className="p-2 rounded-lg hover:bg-secondary disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              title="Forward"
            >
              <ArrowRight className="w-5 h-5 text-muted-foreground" />
            </button>
            <button
              onClick={goUp}
              disabled={!currentPath || currentPath.replace(/[\\/]+$/, '').split(/[\\/]/).length <= 1}
              className="p-2 rounded-lg hover:bg-secondary disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              title="Up one level"
            >
              <ChevronLeft className="w-5 h-5 text-muted-foreground" />
            </button>

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
                      <ChevronRight className="w-4 h-4 text-muted-foreground/50 shrink-0" />
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
                  <button
                    onClick={(e) => { e.stopPropagation(); startEditingPath(); }}
                    className="ml-auto p-1 hover:bg-secondary rounded transition-colors shrink-0"
                    title="Edit path"
                  >
                    <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                </>
              )}
            </div>

            {/* New Folder button */}
            {!isArchiveMode && (
              <button
                onClick={startCreatingFolder}
                disabled={!currentPath}
                className="p-2 rounded-lg hover:bg-secondary disabled:opacity-30 disabled:hover:bg-transparent transition-colors shrink-0"
                title="New Folder"
              >
                <FolderPlus className="w-5 h-5 text-muted-foreground" />
              </button>
            )}
          </div>

          {/* Body - Sidebar + Main */}
          <div className="flex flex-1 overflow-hidden">
            {/* Left sidebar - drives and tree */}
            <div className="w-[240px] border-r border-border bg-card/30 overflow-y-auto shrink-0">
              <div className="p-2.5">
                <div className="text-xs uppercase tracking-wider text-muted-foreground font-medium px-2 py-2">
                  Drives
                </div>
                {drives.map(drive => (
                  <DriveItem
                    key={drive.letter}
                    drive={drive}
                    isSelected={currentPath.startsWith(drive.letter)}
                    onClick={() => navigateTo(drive.letter + '\\')}
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
            <div ref={mainPanelRef} className="flex-1 overflow-y-auto bg-background">
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
                <div className="p-4 grid grid-cols-2 gap-3">
                  {drives.map(drive => (
                    <button
                      key={drive.letter}
                      onClick={() => navigateTo(drive.letter + '\\')}
                      className="flex items-center gap-3 p-4 rounded-xl bg-card border border-border hover:border-primary/50 hover:bg-secondary/30 transition-all text-left group"
                    >
                      <div className="p-2.5 rounded-lg bg-secondary group-hover:bg-primary/10 transition-colors">
                        <HardDrive className="w-5 h-5 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-base font-medium text-foreground truncate">
                          {drive.label} ({drive.letter})
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {drive.type}{drive.freeBytes > 0 ? ` \u2022 ${formatSize(drive.freeBytes)} free of ${formatSize(drive.totalBytes)}` : ''}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              ) : entries.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
                  <Folder className="w-9 h-9 text-muted-foreground/30" />
                  <span className="text-base">This folder is empty</span>
                </div>
              ) : (
                <div className="p-2.5">
                  {/* View mode buttons + Thumbnail size slider */}
                  {hasImages && (
                    <div className="flex items-center gap-2.5 px-2 py-2 mb-1 sticky top-0 z-10 bg-background/95 backdrop-blur-sm">
                      <div className="flex items-center border border-border rounded-lg overflow-hidden shrink-0">
                        <button onClick={() => setFileViewMode('grid')} className={`p-1.5 transition-colors ${fileViewMode === 'grid' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`} title="Grid view"><LayoutGrid className="w-3.5 h-3.5" /></button>
                        <button onClick={() => setFileViewMode('list')} className={`p-1.5 transition-colors ${fileViewMode === 'list' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`} title="List view"><List className="w-3.5 h-3.5" /></button>
                        <button onClick={() => setFileViewMode('details')} className={`p-1.5 transition-colors ${fileViewMode === 'details' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`} title="Details view"><Table2 className="w-3.5 h-3.5" /></button>
                      </div>
                      {fileViewMode === 'grid' && (
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

                  {/* Folder entries */}
                  {entries.filter(e => e.isDirectory).map(entry => (
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
                  ))}

                  {/* Archive file entries (ZIP/RAR mode) */}
                  {entries.filter(e => e.isArchive).map(entry => (
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
                      {entries.filter(e => e.isImage).map(entry => (
                        <div
                          key={entry.path}
                          className="flex flex-col items-center gap-1.5 p-2 rounded-lg hover:bg-secondary/30 transition-colors"
                          style={{ width: `${thumbSize + 20}px` }}
                          title={entry.name}
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
                              <Image className="w-6 h-6 text-muted-foreground/40" />
                            )}
                          </div>
                          <span className="text-xs text-muted-foreground truncate w-full text-center leading-tight">
                            {entry.name}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {hasImages && fileViewMode === 'list' && (
                    <div className="mt-1">
                      {entries.filter(e => e.isImage).map(entry => (
                        <div key={entry.path} className="flex items-center gap-3 px-3 py-1.5 rounded-lg hover:bg-secondary/30 transition-colors" title={entry.name}>
                          <Image className="w-4 h-4 text-muted-foreground/50 shrink-0" />
                          <span className="text-sm text-foreground truncate flex-1">{entry.name}</span>
                          {entry.sizeBytes > 0 && (
                            <span className="text-xs text-muted-foreground shrink-0">
                              {entry.sizeBytes < 1024 * 1024
                                ? `${(entry.sizeBytes / 1024).toFixed(0)} KB`
                                : `${(entry.sizeBytes / (1024 * 1024)).toFixed(1)} MB`}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {hasImages && fileViewMode === 'details' && (
                    <div className="mt-1 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-xs text-muted-foreground border-b border-border/50">
                            <th className="text-left py-1.5 px-3 font-medium">Name</th>
                            <th className="text-left py-1.5 px-3 font-medium">Type</th>
                            <th className="text-right py-1.5 px-3 font-medium">Size</th>
                          </tr>
                        </thead>
                        <tbody>
                          {entries.filter(e => e.isImage).map(entry => {
                            const ext = entry.name.split('.').pop()?.toUpperCase() || '';
                            return (
                              <tr key={entry.path} className="border-b border-border/30 hover:bg-secondary/30 transition-colors">
                                <td className="py-1.5 px-3 truncate max-w-[300px]">
                                  <div className="flex items-center gap-2">
                                    <Image className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
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
          <div
            onMouseDown={handleResizeMouseDown}
            className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize z-10"
            style={{
              background: 'linear-gradient(135deg, transparent 50%, hsl(249, 100%, 81%) 50%)',
              borderRadius: '0 0 16px 0',
              opacity: 0.5,
            }}
            title="Drag to resize"
          />
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function DriveItem({ drive, isSelected, onClick }: { drive: DriveInfo; isSelected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${
        isSelected ? 'bg-secondary text-foreground' : 'hover:bg-secondary/50 text-muted-foreground'
      }`}
    >
      <HardDrive className={`w-4 h-4 shrink-0 ${isSelected ? 'text-primary' : ''}`} />
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
            : <Folder className={`w-4 h-4 shrink-0 ${isActive ? 'text-primary' : 'text-foreground/50'}`} />
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
