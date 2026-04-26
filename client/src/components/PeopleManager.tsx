import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  X,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  Trash2,
  Eye,
  Users,
  Tag,
  Sparkles,
  Pencil,
  Check,
  UserX,
  LayoutList,
  Grid3X3,
  Undo2,
  ShieldAlert,
  ChevronLeft,
  ChevronRight,
  Info,
  ImageIcon,
  Download,
  RefreshCw,
  Sparkle,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { Popover, PopoverTrigger, PopoverContent, PopoverAnchor } from '@/components/ui/popover';
import { MainAliveBanner } from './MainAliveBanner';
import {
  getPersonClusters,
  listPersons,
  namePerson,
  unnameFace,
  assignFace,
  setRepresentativeFace,
  getClusterFaces,
  getFaceCrop,
  getFaceContext,
  getFileMetaByPath,
  openSearchViewer,
  type FileMetaSlice,
  deletePersonRecord,
  permanentlyDeletePerson,
  restorePerson,
  listDiscardedPersons,
  renamePerson,
  reclusterFaces,
  getSettings,
  setSetting,
  type PersonCluster,
  type PersonRecord,
  type DiscardedPerson,
  type ClusterFacesResult,
  getVisualSuggestions,
  refineFromVerified,
  importXmpFaces,
  onAiProgress,
  removeAiProgressListener,
  recordPmOpen,
  dismissPmStartupPrompt,
  type AiProgress,
} from '@/lib/electron-bridge';

// ─── Notify main window that data changed ─────────────────────────────────
function notifyChange() {
  if ((window as any).pdr?.people?.notifyChange) {
    (window as any).pdr.people.notifyChange();
  }
}

// ─── Main People Manager (standalone page, not modal) ─────────────────────
export default function PeopleManager() {
  // Persisted tab + view-mode selections — reopening PM drops the
  // user back on whatever tab/view they were using last, rather than
  // always starting on Named / Card. Zero cost beyond the initial
  // localStorage read.
  const [activeTab, setActiveTab] = useState<'named' | 'unnamed' | 'unsure' | 'ignored'>(() => {
    if (typeof window === 'undefined') return 'named';
    const saved = localStorage.getItem('pdr-pm-active-tab');
    return saved === 'unnamed' || saved === 'unsure' || saved === 'ignored' || saved === 'named' ? saved : 'named';
  });
  const [viewMode, setViewMode] = useState<'list' | 'card'>(() => {
    if (typeof window === 'undefined') return 'card';
    const saved = localStorage.getItem('pdr-pm-view-mode');
    return saved === 'list' ? 'list' : 'card';
  });
  useEffect(() => {
    try { localStorage.setItem('pdr-pm-active-tab', activeTab); } catch {}
  }, [activeTab]);
  useEffect(() => {
    try { localStorage.setItem('pdr-pm-view-mode', viewMode); } catch {}
  }, [viewMode]);
  const [zoomLevel, setZoomLevel] = useState(() => {
    const saved = localStorage.getItem('pdr-people-zoom');
    return saved ? parseInt(saved, 10) : 100;
  });
  const [clusters, setClusters] = useState<PersonCluster[]>([]);
  // AI processing indicator — surfaces the same "Analyzing N/M" the main
  // window shows, so the user can see analysis progress from inside the
  // People Manager without flipping windows.
  const [aiProgress, setAiProgress] = useState<AiProgress | null>(null);
  const [discardedPersons, setDiscardedPersons] = useState<DiscardedPerson[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [faceCropsMap, setFaceCropsMap] = useState<Record<string, string>>({});
  const [editingCluster, setEditingCluster] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  /** Optional long-form name input — sits alongside the short-name
   *  input when the user is editing a cluster. Empty string means
   *  "no full name on file" (Trees will fall back to the short
   *  name); we send null in that case so the DB stores NULL rather
   *  than an empty string. */
  const [fullNameInput, setFullNameInput] = useState('');
  const fullNameInputRef = useRef<HTMLInputElement>(null);
  const [existingPersons, setExistingPersons] = useState<PersonRecord[]>([]);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<{ personId: number; personName: string; photoCount: number } | null>(null);
  const [confirmPermanentDelete, setConfirmPermanentDelete] = useState<{ personId: number; personName: string } | null>(null);
  const [pendingIgnore, setPendingIgnore] = useState<string | null>(null);
  const [pendingUnsure, setPendingUnsure] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem('pdr-pm-search') ?? '';
  });
  const [clusterThreshold, setClusterThreshold] = useState(0.70);
  const [isReclustering, setIsReclustering] = useState(false);
  /** Threshold the in-flight recluster was kicked off with. We use this
   *  to (a) detect that the user has moved the slider since, so a new
   *  recluster supersedes the old, and (b) discard a loadClusters
   *  result that was queued under a now-stale threshold — that's the
   *  bug where a 1018-row count from a 60-seconds-ago recluster
   *  suddenly appears after a tab switch. */
  const reclusterTokenRef = useRef<number>(0);
  const pendingThresholdRef = useRef<number | null>(null);
  /** Debounce timer for keyboard / programmatic slider changes —
   *  onChange fires per arrow-key press but onMouseUp doesn't, so we
   *  schedule the recluster ourselves with a short tail-delay. */
  const reclusterDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const [showUnverifiedOnly, setShowUnverifiedOnly] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('pdr-pm-unverified-only') === 'true';
  });
  useEffect(() => {
    try { localStorage.setItem('pdr-pm-search', searchFilter); } catch {}
  }, [searchFilter]);
  useEffect(() => {
    try { localStorage.setItem('pdr-pm-unverified-only', String(showUnverifiedOnly)); } catch {}
  }, [showUnverifiedOnly]);

  // Scroll-position restore. Each tab keeps its own scrollTop so
  // switching between Named and Unnamed keeps your place in each.
  // Values are written with a small debounce so rapid scroll events
  // don't hammer localStorage.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollRestoredForLoadRef = useRef(false);
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try { localStorage.setItem(`pdr-pm-scroll-${activeTab}`, String(el.scrollTop)); } catch {}
      }, 150);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      el.removeEventListener('scroll', onScroll);
    };
  }, [activeTab]);
  // Restore scroll AFTER the cluster data has populated (otherwise
  // there's nothing to scroll through yet and the scrollTop reverts).
  useEffect(() => {
    if (isLoading || scrollRestoredForLoadRef.current) return;
    scrollRestoredForLoadRef.current = true;
    const el = scrollContainerRef.current;
    if (!el) return;
    const saved = localStorage.getItem(`pdr-pm-scroll-${activeTab}`);
    if (saved) {
      const y = parseInt(saved, 10);
      if (!Number.isNaN(y)) {
        // Delay one frame so the list has laid out.
        requestAnimationFrame(() => { el.scrollTop = y; });
      }
    }
  }, [isLoading, activeTab]);
  // Reset the "already restored" latch when the tab changes so the
  // scroll-restore effect re-runs for the newly-active tab.
  useEffect(() => {
    scrollRestoredForLoadRef.current = false;
  }, [activeTab]);

  // Cross-row face selection state (shared across all PersonCardRow instances)
  const [globalSelectedFaces, setGlobalSelectedFaces] = useState<Set<number>>(new Set());
  const [globalReassignFaceId, setGlobalReassignFaceId] = useState<number | null>(null);
  const [globalReassignName, setGlobalReassignName] = useState('');
  const [panelSuggestionIdx, setPanelSuggestionIdx] = useState(-1);

  // Refinement feature state
  const [aiRefineEnabled, setAiRefineEnabled] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const [isImportingXmp, setIsImportingXmp] = useState(false);

  // "Open PM on startup" onboarding banner state. We wait until the
  // user has used PM enough to understand its value — 3+ distinct
  // calendar days OR 3+ opens in one session — before asking them to
  // change their startup preference. Once they enable it or dismiss
  // it, pmStartupPromptDismissed in settings keeps it away forever.
  const [showStartupPrompt, setShowStartupPrompt] = useState(false);

  // Load saved threshold from settings on mount
  useEffect(() => {
    (async () => {
      const settings = await getSettings();
      if (settings?.matchThreshold != null) {
        setClusterThreshold(settings.matchThreshold);
      }
      setAiRefineEnabled(!!(settings as any)?.aiRefineFromVerified);
    })();
  }, []);

  const clusterKey = (c: PersonCluster) => {
    // Special categories share one person_id, so use cluster_id to keep them separate
    if (c.person_name === '__ignored__' || c.person_name === '__unsure__') return `c${c.cluster_id}`;
    return c.person_id ? `p${c.person_id}` : `c${c.cluster_id}`;
  };

  const loadClusters = async () => {
    setIsLoading(true);
    // Render the cluster list AS SOON AS the DB queries return. Face
    // thumbnails are fetched in two waves:
    //   1. Foreground: per-cluster when the row enters the viewport.
    //      Visible rows get priority and populate within ~1–2s.
    //   2. Background: idle-callback-driven pass over ALL other
    //      clusters, so by the time the user scrolls, rows are
    //      already fully populated and appear instantly. Both waves
    //      go through ensureClusterCrops which dedups atomically, so
    //      they can race without double-fetching.
    const [clustersRes, personsRes, discardedRes] = await Promise.all([
      getPersonClusters(),
      listPersons(),
      listDiscardedPersons(),
    ]);
    if (clustersRes.success && clustersRes.data) setClusters(clustersRes.data);
    if (personsRes.success && personsRes.data) setExistingPersons(personsRes.data);
    if (discardedRes.success && discardedRes.data) setDiscardedPersons(discardedRes.data);
    setIsLoading(false);
    // Reset the per-open "I've fetched this cluster" dedup tracker so a
    // refresh re-populates rows that come back into view.
    fetchedClusterKeysRef.current.clear();
    // Bump the load id so any still-running background loop from a
    // previous load bails out instead of fighting for I/O.
    const myLoadId = ++loadIdRef.current;

    // Background idle fetch: process every remaining cluster in
    // interleaved order, one at a time, yielding to the browser
    // between clusters so user scrolls, clicks, and edits stay
    // responsive.
    //
    // Interleave matters: getPersonClusters returns named first then
    // unnamed, so a naive queue processes all 10 named → all 157
    // unnamed in order. If the user switches to Unnamed after a few
    // seconds, they'd see blank rows until the loop got that far.
    // Round-robin instead: named[0], unnamed[0], special[0], named[1],
    // unnamed[1], … so every tab's top clusters populate early.
    if (clustersRes.success && clustersRes.data) {
      const all = clustersRes.data;
      const named = all.filter(c => c.person_name && c.person_name !== '__ignored__' && c.person_name !== '__unsure__');
      const unnamed = all.filter(c => !c.person_name);
      const special = all.filter(c => c.person_name === '__ignored__' || c.person_name === '__unsure__');
      const queue: typeof all = [];
      const maxLen = Math.max(named.length, unnamed.length, special.length);
      for (let i = 0; i < maxLen; i++) {
        if (named[i]) queue.push(named[i]);
        if (unnamed[i]) queue.push(unnamed[i]);
        if (special[i]) queue.push(special[i]);
      }
      const idle: (cb: () => void) => void = (window as any).requestIdleCallback
        ? (cb) => (window as any).requestIdleCallback(cb, { timeout: 2000 })
        : (cb) => setTimeout(cb, 100);
      const processNext = () => {
        if (loadIdRef.current !== myLoadId) return; // cancelled by re-load
        if (queue.length === 0) return;
        idle(async () => {
          if (loadIdRef.current !== myLoadId) return;
          // Pull 2 clusters per idle slot and fetch concurrently —
          // doubles background throughput without starving the main
          // thread, since each ensureClusterCrops is already mostly
          // waiting on IPC + sharp, not CPU.
          const batch = [queue.shift(), queue.shift()].filter(Boolean) as typeof all;
          await Promise.all(batch.map(c => ensureClusterCrops(c)));
          processNext();
        });
      };
      processNext();
    }
  };

  /** Per-cluster thumbnail fetcher. Fires when a row enters the
   *  viewport (IntersectionObserver in PersonCardRow / PersonListRow).
   *  Idempotent: subsequent calls for the same cluster are no-ops, and
   *  faces already in faceCropsMap are skipped so the second scroll-in
   *  costs nothing. Small local worker pool so we don't try to open
   *  25 file handles in parallel for a single row. */
  const fetchedClusterKeysRef = useRef<Set<string>>(new Set());
  // Monotonic counter bumped per loadClusters() call so the background
  // idle loop from an earlier load can detect it's been superseded and
  // bail out — prevents stale loops from competing with a fresh load's
  // workers after a refresh / AI-complete re-load.
  const loadIdRef = useRef<number>(0);
  const ensureClusterCrops = async (cluster: PersonCluster) => {
    const key = clusterKey(cluster);
    if (fetchedClusterKeysRef.current.has(key)) return;
    fetchedClusterKeysRef.current.add(key);
    const faces = cluster.sample_faces ?? [];
    if (faces.length === 0) return;
    const todo = faces.filter(f => !faceCropsMap[f.face_id]);
    if (todo.length === 0) return;
    const CONCURRENCY = 4;
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const i = next++;
        const face = todo[i];
        const crop = await getFaceCrop(face.file_path, face.box_x, face.box_y, face.box_w, face.box_h, 64);
        if (crop.success && crop.dataUrl) {
          setFaceCropsMap(prev => ({ ...prev, [face.face_id]: crop.dataUrl! }));
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  };

  useEffect(() => { loadClusters(); }, []);

  // Onboarding: record this open and decide whether to surface the
  // "launch PM on startup" banner. Thresholds: 3+ distinct calendar
  // days OR 3+ opens in one session. Skipped entirely if the user
  // already enabled the setting or dismissed the prompt.
  useEffect(() => {
    (async () => {
      const r = await recordPmOpen();
      if (!r.success) return;
      if (r.alreadyEnabled || r.dismissed) return;
      if ((r.distinctDays ?? 0) >= 3 || (r.sessionCount ?? 0) >= 3) {
        setShowStartupPrompt(true);
      }
    })();
  }, []);

  // Subscribe to AI progress so the header badge updates in real-time
  // while files are being analysed. Auto-refresh the cluster list when
  // processing hits 'complete' so freshly-found faces appear without
  // the user having to close and reopen the window.
  useEffect(() => {
    onAiProgress((p) => {
      setAiProgress(p);
      if (p.phase === 'complete') {
        loadClusters();
      }
    });
    return () => removeAiProgressListener();
  }, []);

  useEffect(() => {
    if (!isLoading) {
      const named = clusters.filter(c => c.person_name && c.person_name !== '__ignored__' && c.person_name !== '__unsure__');
      const unnamed = clusters.filter(c => !c.person_name);
      if (activeTab === 'named' && named.length === 0 && unnamed.length > 0) {
        setActiveTab('unnamed');
      }
    }
  }, [isLoading, clusters]);

  // Ctrl+scroll zoom
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setZoomLevel(prev => {
          const next = Math.max(60, Math.min(150, prev + (e.deltaY < 0 ? 5 : -5)));
          localStorage.setItem('pdr-people-zoom', String(next));
          return next;
        });
      }
    };
    window.addEventListener('wheel', handler, { passive: false });
    return () => window.removeEventListener('wheel', handler);
  }, []);

  const handleNameCluster = async (clusterId: number, name: string, fullName?: string) => {
    if (!name.trim()) return;
    setEditingCluster(null);
    setNameInput('');
    setFullNameInput('');
    // Empty full-name input → null in the DB so Trees falls back to
    // the short name. Trim before saving so trailing whitespace
    // doesn't get stored.
    const fn = fullName !== undefined ? (fullName.trim() || null) : undefined;
    const result = await namePerson(name.trim(), clusterId, undefined, fn);
    if (result.success) { await loadClusters(); notifyChange(); }
  };

  const handleRename = async (personId: number, newName: string, newFullName?: string) => {
    if (!newName.trim()) return;
    const fn = newFullName !== undefined ? (newFullName.trim() || null) : undefined;
    await renamePerson(personId, newName.trim(), fn);
    setEditingCluster(null); setNameInput(''); setFullNameInput('');
    await loadClusters(); notifyChange();
  };

  const handleDiscardPerson = async (personId: number) => {
    await deletePersonRecord(personId);
    setConfirmDiscard(null);
    await loadClusters(); notifyChange();
  };

  const handleRecluster = async (threshold: number) => {
    // Cancel-on-restart: bump the token so any in-flight recluster
    // result becomes stale and won't be applied. The actual backend
    // call can't be aborted (no IPC abort plumbed), so we let it run
    // to completion but discard its loadClusters() output.
    const myToken = ++reclusterTokenRef.current;
    pendingThresholdRef.current = threshold;
    setIsReclustering(true);
    await setSetting('matchThreshold', threshold);
    await reclusterFaces(threshold);
    // If a newer recluster has started since we kicked off, ignore
    // our results — the newer call will refresh the cluster list with
    // its own (correct) data.
    if (reclusterTokenRef.current !== myToken) return;
    await loadClusters();
    if (reclusterTokenRef.current !== myToken) return;
    notifyChange();
    pendingThresholdRef.current = null;
    setIsReclustering(false);
  };

  /** Schedule a recluster for the current slider value, debounced so
   *  rapid keyboard input (arrow keys, scroll wheel) doesn't fire one
   *  recluster per tick. Also wired into onChange so keyboard input
   *  works the same as mouse-up — the previous version only triggered
   *  on onMouseUp / onTouchEnd, leaving keyboard sliders silently
   *  doing nothing. */
  const scheduleRecluster = (threshold: number) => {
    if (reclusterDebounceRef.current) clearTimeout(reclusterDebounceRef.current);
    reclusterDebounceRef.current = setTimeout(() => {
      reclusterDebounceRef.current = null;
      handleRecluster(threshold);
    }, 400);
  };

  const handleIgnoreCluster = async (clusterId: number) => {
    await namePerson('__ignored__', clusterId);
    setPendingIgnore(null);
    await loadClusters(); notifyChange();
  };

  const handleUnsureCluster = async (clusterId: number) => {
    await namePerson('__unsure__', clusterId);
    setPendingUnsure(null);
    await loadClusters(); notifyChange();
  };

  const handleRestoreToUnnamed = async (clusterId: number, personId: number | null) => {
    if (personId) {
      await deletePersonRecord(personId);
      await loadClusters(); notifyChange();
    }
  };

  const handleRestorePerson = async (personId: number) => {
    await restorePerson(personId);
    await loadClusters(); notifyChange();
  };

  const handlePermanentDelete = async (personId: number) => {
    await permanentlyDeletePerson(personId);
    setConfirmPermanentDelete(null);
    await loadClusters(); notifyChange();
  };

  const handleReassignFace = async (faceId: number, newName: string, verified: boolean = true, skipReload: boolean = false) => {
    if (newName === '__unnamed__') {
      await unnameFace(faceId);
      if (!skipReload) { await loadClusters(); notifyChange(); }
      return;
    }
    const personResult = await namePerson(newName);
    if (personResult.success && personResult.data?.personId) {
      await assignFace(faceId, personResult.data.personId, verified);
      if (!skipReload) { await loadClusters(); notifyChange(); }
    }
  };

  const handleSetRepresentative = async (personId: number, faceId: number) => {
    await setRepresentativeFace(personId, faceId);
    await loadClusters(); notifyChange();
  };

  const namedClusters = clusters.filter(c => c.person_name && c.person_name !== '__ignored__' && c.person_name !== '__unsure__');
  const unnamedClustersRaw = clusters.filter(c => !c.person_name);
  const ignoredClusters = clusters.filter(c => c.person_name === '__ignored__');
  const unsureClusters = clusters.filter(c => c.person_name === '__unsure__');

  // ── Drag-to-reorder for the Unnamed tab ────────────────────────────
  // The user often has multiple unnamed clusters that turn out to be
  // the same person. Letting them drag those rows next to each other
  // makes the verify-and-merge flow a lot less click-heavy. Order is
  // persisted in localStorage by clusterKey so it survives PM open/
  // close — but a fresh detection / new clusters slot in at the end
  // (Infinity rank for unranked entries).
  const CLUSTER_ORDER_KEY = 'pdr-pm-cluster-order';
  const [clusterOrder, setClusterOrder] = useState<Record<string, number>>(() => {
    if (typeof window === 'undefined') return {};
    try { return JSON.parse(localStorage.getItem(CLUSTER_ORDER_KEY) || '{}'); } catch { return {}; }
  });
  const [draggedClusterKey, setDraggedClusterKey] = useState<string | null>(null);
  const [dragOverClusterKey, setDragOverClusterKey] = useState<string | null>(null);

  const persistClusterOrder = (next: Record<string, number>) => {
    setClusterOrder(next);
    try { localStorage.setItem(CLUSTER_ORDER_KEY, JSON.stringify(next)); } catch { /* quota — ignore */ }
  };

  const unnamedClusters = useMemo(() => {
    const arr = [...unnamedClustersRaw];
    arr.sort((a, b) => {
      const oa = clusterOrder[clusterKey(a)] ?? Number.POSITIVE_INFINITY;
      const ob = clusterOrder[clusterKey(b)] ?? Number.POSITIVE_INFINITY;
      if (oa !== ob) return oa - ob;
      return 0; // stable for unranked → keep backend order (largest cluster first)
    });
    return arr;
  }, [unnamedClustersRaw, clusterOrder]);

  const handleClusterDragStart = (e: React.DragEvent, key: string) => {
    e.dataTransfer.effectAllowed = 'move';
    // Use a CLONE of the row as the drag image, not the row itself.
    // The browser captures the drag image asynchronously, so by the
    // time it samples the source element, our React state update has
    // already faded it (opacity-30) and the dragged preview ends up
    // looking like a ghost. The clone is a snapshot of the row as it
    // was BEFORE the state update — proper drop-shadow card that
    // visibly follows the cursor.
    const parent = (e.currentTarget as HTMLElement).closest('[data-cluster-row]') as HTMLElement | null;
    if (parent) {
      const clone = parent.cloneNode(true) as HTMLElement;
      clone.style.position = 'absolute';
      clone.style.top = '-9999px';
      clone.style.left = '-9999px';
      clone.style.width = `${parent.offsetWidth}px`;
      clone.style.opacity = '0.95';
      clone.style.boxShadow = '0 12px 28px rgba(168, 85, 247, 0.35), 0 4px 12px rgba(0,0,0,0.2)';
      clone.style.borderRadius = '12px';
      clone.style.background = 'var(--background, white)';
      clone.style.transform = 'rotate(-1deg)';
      clone.style.pointerEvents = 'none';
      // Strip any leftover state classes from the clone so it doesn't
      // inherit a "being dragged" appearance.
      clone.classList.remove('opacity-30', 'opacity-40', 'scale-[0.98]', 'ring-1', 'ring-purple-500/50');
      document.body.appendChild(clone);
      e.dataTransfer.setDragImage(clone, 20, 20);
      // Remove the clone after the browser has had a chance to
      // snapshot it. setTimeout(0) is enough on every modern engine.
      setTimeout(() => { try { clone.remove(); } catch {} }, 0);
    }
    setDraggedClusterKey(key);
  };
  const handleClusterDragOver = (e: React.DragEvent, key: string) => {
    if (!draggedClusterKey || draggedClusterKey === key) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverClusterKey !== key) setDragOverClusterKey(key);
  };
  const handleClusterDragLeave = (key: string) => {
    if (dragOverClusterKey === key) setDragOverClusterKey(null);
  };
  const handleClusterDrop = (e: React.DragEvent, targetKey: string) => {
    e.preventDefault();
    setDragOverClusterKey(null);
    if (!draggedClusterKey || draggedClusterKey === targetKey) {
      setDraggedClusterKey(null);
      return;
    }
    const currentList = unnamedClusters.map(clusterKey);
    const fromIdx = currentList.indexOf(draggedClusterKey);
    const toIdx = currentList.indexOf(targetKey);
    if (fromIdx === -1 || toIdx === -1) { setDraggedClusterKey(null); return; }
    const reordered = [...currentList];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    const next: Record<string, number> = {};
    reordered.forEach((k, i) => { next[k] = i; });
    persistClusterOrder(next);
    setDraggedClusterKey(null);
  };
  const handleClusterDragEnd = () => {
    setDraggedClusterKey(null);
    setDragOverClusterKey(null);
  };

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
    `flex-1 text-center px-3 py-2.5 text-base font-medium cursor-pointer transition-all duration-200 border-b-2 ${
      activeTab === tab
        ? 'border-purple-500 text-purple-600 dark:text-purple-400 bg-background'
        : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30 bg-muted/40'
    } ${tab === 'named' ? 'rounded-tl-lg' : ''} ${tab === 'ignored' ? 'rounded-tr-lg' : ''}`;

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <MainAliveBanner />

      {/* Header — below the title bar */}
      <div className="flex items-center justify-between px-6 pt-4 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-purple-500/10 flex items-center justify-center">
            <Users className="w-4 h-4 text-purple-500" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">People Manager</h2>

          {/* AI analysis progress — mirrors the main window's "Analyzing
              N/M" indicator so progress is visible while you're looking
              at People Manager (the very place the results land). */}
          {aiProgress && aiProgress.phase === 'processing' && aiProgress.total > 0 && (
            <IconTooltip label={`Analysing ${aiProgress.currentFile || ''}`} side="bottom">
              <div
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-violet-500/10 border border-violet-400/40 text-sm text-violet-700 dark:text-violet-300"
              >
                <Sparkle className="w-3 h-3 animate-pulse" />
                <span>Analysing {aiProgress.current}/{aiProgress.total}</span>
              </div>
            </IconTooltip>
          )}

          {/* Refresh — re-queries clusters without closing/reopening the
              window. Useful after AI finishes, after editing from another
              window, or when something feels out of sync. */}
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => loadClusters()}
                  className="inline-flex items-center justify-center w-7 h-7 rounded-lg hover:bg-accent transition-colors"
                  aria-label="Refresh"
                >
                  <RefreshCw className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Refresh — reload clusters from the database</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* Improve Facial Recognition button */}
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={async () => {
                    if (!aiRefineEnabled) {
                      if ((window as any).pdr?.openSettings) {
                        (window as any).pdr.openSettings('people');
                      } else {
                        window.opener?.postMessage({ type: 'pdr:openSettings', tab: 'people' }, '*');
                      }
                      return;
                    }
                    setIsRefining(true);
                    try {
                      const result = await refineFromVerified(clusterThreshold);
                      if (result.success && result.data) {
                        await loadClusters();
                        notifyChange();
                        alert(`All verified photos have been analysed and assisted in refining the facial recognition matching.\n\n${result.data.newMatches} new face(s) were matched across ${result.data.personsProcessed} people.`);
                      } else {
                        alert('Refinement failed: ' + (result.error || 'unknown error'));
                      }
                    } finally {
                      setIsRefining(false);
                    }
                  }}
                  disabled={isRefining}
                  className={`ml-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border ${
                    aiRefineEnabled
                      ? 'bg-purple-500 hover:bg-purple-600 text-white border-purple-600 shadow-sm'
                      : 'bg-background text-muted-foreground border-border/70 hover:border-purple-400/50 hover:text-foreground hover:bg-purple-50/30 dark:hover:bg-purple-900/10'
                  } ${isRefining ? 'opacity-60 cursor-wait' : 'cursor-pointer'}`}
                >
                  {isRefining ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Improving...</>
                  ) : (
                    <><Sparkles className="w-3.5 h-3.5" /> Improve Facial Recognition</>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {aiRefineEnabled
                  ? 'Uses your verified faces to refine matching across all unnamed faces. Most populous people processed first.'
                  : 'Enable this in Settings → AI. Only activate after you\'re sure all people have the correct photos verified.'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* Import from Lightroom XMP sidecars */}
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={async () => {
                    if (isImportingXmp) return;
                    setIsImportingXmp(true);
                    try {
                      const result = await importXmpFaces();
                      if (result.success && result.data) {
                        await loadClusters();
                        notifyChange();
                        const d = result.data;
                        alert(`Lightroom XMP import complete.\n\n` +
                          `${d.filesScanned} file${d.filesScanned === 1 ? '' : 's'} scanned\n` +
                          `${d.sidecarsFound} sidecar${d.sidecarsFound === 1 ? '' : 's'} found\n` +
                          `${d.facesImported} face${d.facesImported === 1 ? '' : 's'} imported across ${d.personsCreated} ${d.personsCreated === 1 ? 'person' : 'people'}\n` +
                          `${d.filesSkipped} file${d.filesSkipped === 1 ? '' : 's'} skipped (already had face data)`);
                      } else {
                        alert('XMP import failed: ' + (result.error || 'unknown error'));
                      }
                    } finally {
                      setIsImportingXmp(false);
                    }
                  }}
                  disabled={isImportingXmp}
                  className={`ml-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border bg-background text-muted-foreground border-border/70 hover:border-purple-400/50 hover:text-foreground hover:bg-purple-50/30 dark:hover:bg-purple-900/10 ${isImportingXmp ? 'opacity-60 cursor-wait' : 'cursor-pointer'}`}
                >
                  {isImportingXmp ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Importing...</>
                  ) : (
                    <><Download className="w-3.5 h-3.5" /> Import from Lightroom</>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[320px]">
                Scans your indexed photos for Lightroom-style .xmp sidecars and imports any face regions as Named (but unverified) faces — you confirm each one with the Verify button to earn the purple ring. This prevents third-party naming mistakes from polluting your verified-face pool. Skips photos that already have face data.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        <div className="flex flex-col items-center flex-1 mx-4 max-w-[260px]">
          <div className="flex items-center gap-2 mb-0.5 h-[14px]">
            <span className="text-xs text-foreground/60 font-semibold uppercase tracking-wider">Match</span>
            {isReclustering && (
              <span className="inline-flex items-center gap-1 text-[11px] text-purple-500">
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                Reclustering…
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 w-full">
            <span className="text-[11px] text-muted-foreground whitespace-nowrap">Loose</span>
            <div className="relative flex-1">
              <input
                type="range"
                min="0.55"
                max="0.90"
                step="0.01"
                value={clusterThreshold}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setClusterThreshold(v);
                  // Schedule a debounced recluster so keyboard /
                  // programmatic changes also fire the backend pass.
                  // Mouse-up / touch-end below short-circuits the
                  // wait by triggering immediately.
                  scheduleRecluster(v);
                }}
                onMouseUp={() => {
                  if (reclusterDebounceRef.current) {
                    clearTimeout(reclusterDebounceRef.current);
                    reclusterDebounceRef.current = null;
                  }
                  handleRecluster(clusterThreshold);
                }}
                onTouchEnd={() => {
                  if (reclusterDebounceRef.current) {
                    clearTimeout(reclusterDebounceRef.current);
                    reclusterDebounceRef.current = null;
                  }
                  handleRecluster(clusterThreshold);
                }}
                className="w-full h-1 accent-purple-500 cursor-pointer relative z-10"
                title={`Match strictness: ${Math.round(((clusterThreshold - 0.55) / 0.35) * 100)}%`}
              />
              {/* Tick marks at 25%, 50%, 75% */}
              <div className="absolute top-1/2 left-0 right-0 flex justify-between px-[2px] pointer-events-none" style={{ transform: 'translateY(-50%)' }}>
                <div className="w-px h-2 bg-transparent" /> {/* 0% spacer */}
                <div className="w-px h-2.5 bg-muted-foreground/25" /> {/* 25% */}
                <div className="w-px h-2.5 bg-muted-foreground/25" /> {/* 50% */}
                <div className="w-px h-2.5 bg-muted-foreground/25" /> {/* 75% */}
                <div className="w-px h-2 bg-transparent" /> {/* 100% spacer */}
              </div>
            </div>
            <span className="text-[11px] text-muted-foreground whitespace-nowrap">Strict</span>
          </div>
          <p className="text-[10px] text-muted-foreground/70 mt-1 text-center leading-tight">
            Loose merges more faces into one person. Strict keeps similar faces in separate groups.
          </p>
        </div>
      </div>

      {/* Onboarding banner — surfaces after real adoption (3+ calendar
          days OR 3+ opens this session). Informational, non-blocking:
          users can enable the setting inline or dismiss it forever. */}
      {showStartupPrompt && (
        <div className="mx-6 mb-3 px-3.5 py-2.5 rounded-lg border border-purple-300/50 dark:border-purple-500/30 bg-purple-50/60 dark:bg-purple-900/15 flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-purple-500/15 flex items-center justify-center shrink-0">
            <Sparkles className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground">Using People Manager a lot?</div>
            <div className="text-xs text-muted-foreground mt-0.5">You can have it launch with PDR automatically.</div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={async () => {
                await setSetting('openPeopleOnStartup' as any, true);
                await dismissPmStartupPrompt();
                setShowStartupPrompt(false);
              }}
              className="px-3 py-1 rounded-md text-xs font-medium bg-purple-500 hover:bg-purple-600 text-white border border-purple-600 transition-colors"
            >
              Enable
            </button>
            <button
              type="button"
              onClick={async () => {
                await dismissPmStartupPrompt();
                setShowStartupPrompt(false);
              }}
              className="px-2.5 py-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {/* Tab Bar — count pills get a coloured filled background and
          slightly bolder text so they read clearly against the muted
          tab strip behind them, including for the empty / 0 case. */}
      <div className="flex border-b border-border mx-6 mb-0">
        <div className="flex flex-1">
          <button type="button" className={pmTabClass('named')} onClick={() => { setActiveTab('named'); setSearchFilter(''); }}>
            <span className="flex items-center justify-center gap-1.5">
              Named
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-purple-500/15 text-purple-600 dark:text-purple-300 ring-1 ring-purple-500/30">{tabCounts.named}</span>
            </span>
          </button>
          <div className="w-px bg-border/60 my-2" />
          <button type="button" className={pmTabClass('unnamed')} onClick={() => { setActiveTab('unnamed'); setSearchFilter(''); }}>
            <span className="flex items-center justify-center gap-1.5">
              Unnamed
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-1 ring-amber-500/30">{tabCounts.unnamed}</span>
            </span>
          </button>
          <div className="w-px bg-border/60 my-2" />
          <button type="button" className={pmTabClass('unsure')} onClick={() => { setActiveTab('unsure'); setSearchFilter(''); }}>
            <span className="flex items-center justify-center gap-1.5">
              Unsure
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-500/15 text-blue-700 dark:text-blue-300 ring-1 ring-blue-500/30">{tabCounts.unsure}</span>
            </span>
          </button>
          <div className="w-px bg-border/60 my-2" />
          <button type="button" className={pmTabClass('ignored')} onClick={() => { setActiveTab('ignored'); setSearchFilter(''); }}>
            <span className="flex items-center justify-center gap-1.5">
              Ignored
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-500/20 text-slate-700 dark:text-slate-300 ring-1 ring-slate-500/30">{tabCounts.ignored}</span>
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
                className="pl-8 pr-3 py-1 text-sm rounded-md border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground/50 w-[120px] focus:outline-none focus:ring-1 focus:ring-purple-400/50"
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

      {/* Main content area — scrollable content + optional side panel */}
      <div className="flex-1 flex overflow-hidden">
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-6 pt-4 pb-6" style={{ zoom: `${zoomLevel}%` }}>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
            <span className="ml-2 text-base text-muted-foreground">Loading face clusters...</span>
          </div>
        ) : clusters.length === 0 && discardedPersons.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Users className="w-12 h-12 text-muted-foreground/20 mb-3" />
            <h3 className="text-base font-semibold text-foreground mb-1">No faces detected yet</h3>
            <p className="text-sm text-muted-foreground max-w-xs">
              Run AI analysis on your photos to detect faces. Similar faces will be automatically grouped together.
            </p>
          </div>
        ) : (
          <>
            {/* Discard confirmation banner */}
            {confirmDiscard && (
              <div className="rounded-xl border border-amber-300/60 dark:border-amber-700/40 bg-amber-50/50 dark:bg-amber-950/20 p-4 mb-4">
                <div className="flex items-start gap-3 mb-3">
                  <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <h4 className="text-base font-semibold text-foreground mb-1">Discard "{confirmDiscard.personName}"?</h4>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      This will remove the name from <strong>{confirmDiscard.photoCount} photo{confirmDiscard.photoCount !== 1 ? 's' : ''}</strong> and send {confirmDiscard.photoCount === 1 ? 'it' : 'them'} to the Unnamed tab.
                      Face detections are kept — you can re-name faces later.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-8">
                  <button onClick={() => handleDiscardPerson(confirmDiscard.personId)} className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium transition-colors">
                    Discard
                  </button>
                  <button onClick={() => setConfirmDiscard(null)} className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary text-sm font-medium transition-colors">
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
                    <h3 className="text-base font-medium text-foreground mb-1">
                      {searchFilter ? 'No matches' : 'No named people yet'}
                    </h3>
                    <p className="text-sm text-muted-foreground max-w-xs">
                      {searchFilter ? `No names matching "${searchFilter}".` : 'Switch to the Unnamed tab to start naming detected faces.'}
                    </p>
                  </div>
                ) : viewMode === 'card' ? (
                  <div className="space-y-2">
                    {filteredNamed.map((cluster, idx) => (
                      <PersonCardRow
                        rowIndex={idx}
                        key={clusterKey(cluster)} onVisible={() => ensureClusterCrops(cluster)}
                        cluster={cluster}
                        cropUrl={faceCropsMap[clusterKey(cluster)]}
                        sampleCrops={faceCropsMap}
                        isEditing={editingCluster === clusterKey(cluster)}
                        nameInput={nameInput}
                        fullNameInput={fullNameInput}
                        onStartEdit={() => { setEditingCluster(clusterKey(cluster)); setNameInput(cluster.person_name || ''); setFullNameInput(cluster.person_full_name || ''); setTimeout(() => nameInputRef.current?.focus(), 50); }}
                        onNameChange={setNameInput}
                        onFullNameChange={setFullNameInput}
                        onSubmit={() => cluster.person_id ? handleRename(cluster.person_id, nameInput, fullNameInput) : handleNameCluster(cluster.cluster_id, nameInput, fullNameInput)}
                        onCancel={() => { setEditingCluster(null); setNameInput(''); setFullNameInput(''); }}
                        inputRef={nameInputRef}
                        fullInputRef={fullNameInputRef}
                        existingPersons={existingPersons}
                        onSelectPerson={(name) => handleNameCluster(cluster.cluster_id, name)}
                        onDiscard={cluster.person_id ? () => { setConfirmDiscard({ personId: cluster.person_id!, personName: cluster.person_name!, photoCount: cluster.photo_count }); } : undefined}
                        onReassignFace={handleReassignFace}
                        onSetRepresentative={cluster.person_id ? (faceId) => handleSetRepresentative(cluster.person_id!, faceId) : undefined}
                        globalSelectedFaces={globalSelectedFaces}
                        onGlobalSelectionChange={setGlobalSelectedFaces}
                        globalReassignFaceId={globalReassignFaceId}
                        onGlobalReassignChange={(id, name) => { setGlobalReassignFaceId(id); setGlobalReassignName(name); }}
                        globalReassignName={globalReassignName}
                        onGlobalReassignNameChange={setGlobalReassignName}
                        currentTab={activeTab}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {filteredNamed.map((cluster, idx) => (
                      <PersonListRow
                        key={clusterKey(cluster)} onVisible={() => ensureClusterCrops(cluster)} cluster={cluster} cropUrl={faceCropsMap[clusterKey(cluster)]} sampleCrops={faceCropsMap}
                        isEditing={editingCluster === clusterKey(cluster)} nameInput={nameInput}
                        fullNameInput={fullNameInput}
                        onStartEdit={() => { setEditingCluster(clusterKey(cluster)); setNameInput(cluster.person_name || ''); setFullNameInput(cluster.person_full_name || ''); setTimeout(() => nameInputRef.current?.focus(), 50); }}
                        onNameChange={setNameInput}
                        onFullNameChange={setFullNameInput}
                        onSubmit={() => cluster.person_id ? handleRename(cluster.person_id, nameInput, fullNameInput) : handleNameCluster(cluster.cluster_id, nameInput, fullNameInput)}
                        onCancel={() => { setEditingCluster(null); setNameInput(''); setFullNameInput(''); }}
                        inputRef={nameInputRef}
                        fullInputRef={fullNameInputRef}
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
                    <h3 className="text-base font-medium text-foreground mb-1">All groups are named</h3>
                    <p className="text-sm text-muted-foreground max-w-xs">Every detected face group has been assigned a name, marked unsure, or ignored.</p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start gap-3 p-3 rounded-xl bg-purple-50/50 dark:bg-purple-950/20 border border-purple-200/30 dark:border-purple-800/20 mb-4">
                      <Sparkles className="w-4 h-4 text-purple-500 shrink-0 mt-0.5" />
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        Click a group to name it. Don't recognise someone? Use <strong>Unsure</strong> to revisit later, or <strong>Ignore</strong> to hide them permanently.
                      </p>
                    </div>
                    {viewMode === 'card' ? (
                      <div className="space-y-2">
                        {unnamedClusters.map((cluster, idx) => {
                          const ck = clusterKey(cluster);
                          const isBeingDragged = draggedClusterKey === ck;
                          const isDropTarget = dragOverClusterKey === ck && draggedClusterKey !== null && draggedClusterKey !== ck;
                          return (
                          <div
                            key={ck}
                            data-cluster-row
                            onDragOver={(e) => handleClusterDragOver(e, ck)}
                            onDragLeave={() => handleClusterDragLeave(ck)}
                            onDrop={(e) => handleClusterDrop(e, ck)}
                            className={`relative transition-all duration-150 ${isBeingDragged ? 'opacity-25 scale-[0.97] border-2 border-dashed border-purple-400/70 rounded-xl' : ''}`}
                          >
                            {/* Insertion-line drop indicator — appears above
                                the row that's currently being hovered, like
                                a file-explorer drag. Clearer than a ring
                                because it shows exactly where the dragged
                                row will land. */}
                            {isDropTarget && (
                              <div className="absolute left-0 right-0 -top-1 h-1 bg-purple-500 rounded-full shadow-[0_0_6px_rgba(168,85,247,0.6)] z-20 pointer-events-none" />
                            )}
                            {/* Drag handle — visible-by-default vertical
                                grip strip on the left edge. Big enough to
                                grab without aiming, purple-tinted on hover
                                so the affordance reads clearly. Only the
                                handle is draggable so clicks on thumbnails
                                / name fields keep working. The drag
                                preview is set to the parent row in
                                handleClusterDragStart. */}
                            <div
                              draggable
                              onDragStart={(e) => handleClusterDragStart(e, ck)}
                              onDragEnd={handleClusterDragEnd}
                              className="absolute left-0 top-0 bottom-0 -translate-x-2 w-5 flex items-center justify-center cursor-grab active:cursor-grabbing transition-colors text-muted-foreground/60 hover:text-purple-500 hover:bg-purple-50 dark:hover:bg-purple-950/30 rounded-l-md z-10"
                              title="Drag to reorder"
                            >
                              <svg width="12" height="20" viewBox="0 0 12 20" fill="currentColor">
                                <circle cx="3.5" cy="4" r="1.4" /><circle cx="8.5" cy="4" r="1.4" />
                                <circle cx="3.5" cy="10" r="1.4" /><circle cx="8.5" cy="10" r="1.4" />
                                <circle cx="3.5" cy="16" r="1.4" /><circle cx="8.5" cy="16" r="1.4" />
                              </svg>
                            </div>
                          <PersonCardRow
                            rowIndex={idx}
                            onVisible={() => ensureClusterCrops(cluster)}
                            cluster={cluster}
                            cropUrl={faceCropsMap[clusterKey(cluster)]}
                            sampleCrops={faceCropsMap}
                            isEditing={editingCluster === clusterKey(cluster)}
                            nameInput={nameInput}
                            fullNameInput={fullNameInput}
                            onStartEdit={() => { setEditingCluster(clusterKey(cluster)); setNameInput(''); setFullNameInput(''); setTimeout(() => nameInputRef.current?.focus(), 50); }}
                            onNameChange={setNameInput}
                            onFullNameChange={setFullNameInput}
                            onSubmit={() => handleNameCluster(cluster.cluster_id, nameInput, fullNameInput)}
                            onCancel={() => { setEditingCluster(null); setNameInput(''); setFullNameInput(''); }}
                            inputRef={nameInputRef}
                            fullInputRef={fullNameInputRef}
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
                            globalSelectedFaces={globalSelectedFaces}
                            onGlobalSelectionChange={setGlobalSelectedFaces}
                            globalReassignFaceId={globalReassignFaceId}
                            onGlobalReassignChange={(id, name) => { setGlobalReassignFaceId(id); setGlobalReassignName(name); }}
                            globalReassignName={globalReassignName}
                            onGlobalReassignNameChange={setGlobalReassignName}
                            currentTab={activeTab}
                          />
                          </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="space-y-0.5">
                        {unnamedClusters.map((cluster) => {
                          const ck = clusterKey(cluster);
                          const isBeingDragged = draggedClusterKey === ck;
                          const isDropTarget = dragOverClusterKey === ck && draggedClusterKey !== null && draggedClusterKey !== ck;
                          return (
                          <div
                            key={ck}
                            data-cluster-row
                            onDragOver={(e) => handleClusterDragOver(e, ck)}
                            onDragLeave={() => handleClusterDragLeave(ck)}
                            onDrop={(e) => handleClusterDrop(e, ck)}
                            className={`relative transition-all duration-150 ${isBeingDragged ? 'opacity-25 scale-[0.97] border-2 border-dashed border-purple-400/70 rounded' : ''}`}
                          >
                            {isDropTarget && (
                              <div className="absolute left-0 right-0 -top-0.5 h-1 bg-purple-500 rounded-full shadow-[0_0_6px_rgba(168,85,247,0.6)] z-20 pointer-events-none" />
                            )}
                            <div
                              draggable
                              onDragStart={(e) => handleClusterDragStart(e, ck)}
                              onDragEnd={handleClusterDragEnd}
                              className="absolute left-0 top-0 bottom-0 -translate-x-2 w-5 flex items-center justify-center cursor-grab active:cursor-grabbing transition-colors text-muted-foreground/60 hover:text-purple-500 hover:bg-purple-50 dark:hover:bg-purple-950/30 rounded-l z-10"
                              title="Drag to reorder"
                            >
                              <svg width="12" height="18" viewBox="0 0 12 18" fill="currentColor">
                                <circle cx="3.5" cy="4" r="1.4" /><circle cx="8.5" cy="4" r="1.4" />
                                <circle cx="3.5" cy="9" r="1.4" /><circle cx="8.5" cy="9" r="1.4" />
                                <circle cx="3.5" cy="14" r="1.4" /><circle cx="8.5" cy="14" r="1.4" />
                              </svg>
                            </div>
                          <PersonListRow
                            onVisible={() => ensureClusterCrops(cluster)} cluster={cluster} cropUrl={faceCropsMap[clusterKey(cluster)]} sampleCrops={faceCropsMap}
                            isEditing={editingCluster === clusterKey(cluster)} nameInput={nameInput}
                            fullNameInput={fullNameInput}
                            onStartEdit={() => { setEditingCluster(clusterKey(cluster)); setNameInput(''); setFullNameInput(''); setTimeout(() => nameInputRef.current?.focus(), 50); }}
                            onNameChange={setNameInput}
                            onFullNameChange={setFullNameInput}
                            onSubmit={() => handleNameCluster(cluster.cluster_id, nameInput, fullNameInput)}
                            onCancel={() => { setEditingCluster(null); setNameInput(''); setFullNameInput(''); }}
                            inputRef={nameInputRef}
                            fullInputRef={fullNameInputRef}
                            pendingIgnore={pendingIgnore === clusterKey(cluster)}
                            onIgnore={() => setPendingIgnore(clusterKey(cluster))}
                            onConfirmIgnore={() => handleIgnoreCluster(cluster.cluster_id)}
                            onCancelIgnore={() => setPendingIgnore(null)}
                            pendingUnsure={pendingUnsure === clusterKey(cluster)}
                            onUnsure={() => setPendingUnsure(clusterKey(cluster))}
                            onConfirmUnsure={() => handleUnsureCluster(cluster.cluster_id)}
                            onCancelUnsure={() => setPendingUnsure(null)}
                          />
                          </div>
                          );
                        })}
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
                    <h3 className="text-base font-medium text-foreground mb-1">No unsure faces</h3>
                    <p className="text-sm text-muted-foreground max-w-xs">
                      Faces you mark as "Unsure" from the Unnamed tab will appear here so you can revisit them later.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start gap-3 p-3 rounded-xl bg-blue-50/50 dark:bg-blue-950/20 border border-blue-200/30 dark:border-blue-800/20 mb-4">
                      <HelpCircle className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        These are faces you weren't sure about. Click to name them, or move them to Ignored if you'll never know.
                      </p>
                    </div>
                    <div className="space-y-2">
                      {unsureClusters.map((cluster, idx) => (
                        <PersonCardRow
                          rowIndex={idx}
                          key={clusterKey(cluster)} onVisible={() => ensureClusterCrops(cluster)}
                          cluster={cluster}
                          cropUrl={faceCropsMap[clusterKey(cluster)]}
                          sampleCrops={faceCropsMap}
                          isEditing={editingCluster === clusterKey(cluster)}
                          nameInput={nameInput}
                          fullNameInput={fullNameInput}
                          onStartEdit={() => { setEditingCluster(clusterKey(cluster)); setNameInput(''); setFullNameInput(''); setTimeout(() => nameInputRef.current?.focus(), 50); }}
                          onNameChange={setNameInput}
                          onFullNameChange={setFullNameInput}
                          onSubmit={() => handleNameCluster(cluster.cluster_id, nameInput, fullNameInput)}
                          onCancel={() => { setEditingCluster(null); setNameInput(''); setFullNameInput(''); }}
                          inputRef={nameInputRef}
                          fullInputRef={fullNameInputRef}
                          existingPersons={existingPersons}
                          onSelectPerson={(name) => handleNameCluster(cluster.cluster_id, name)}
                          pendingIgnore={pendingIgnore === clusterKey(cluster)}
                          onIgnore={() => setPendingIgnore(clusterKey(cluster))}
                          onConfirmIgnore={() => handleIgnoreCluster(cluster.cluster_id)}
                          onCancelIgnore={() => setPendingIgnore(null)}
                          onRestore={() => handleRestoreToUnnamed(cluster.cluster_id, cluster.person_id)}
                          onReassignFace={handleReassignFace}
                          globalSelectedFaces={globalSelectedFaces}
                          onGlobalSelectionChange={setGlobalSelectedFaces}
                          globalReassignFaceId={globalReassignFaceId}
                          onGlobalReassignChange={(id, name) => { setGlobalReassignFaceId(id); setGlobalReassignName(name); }}
                          globalReassignName={globalReassignName}
                          onGlobalReassignNameChange={setGlobalReassignName}
                          currentTab={activeTab}
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
                    <h3 className="text-base font-medium text-foreground mb-1">No ignored faces</h3>
                    <p className="text-sm text-muted-foreground max-w-xs">
                      Faces you ignore from the Unnamed tab will appear here. You can restore them or delete permanently.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start gap-3 p-3 rounded-xl bg-slate-50/50 dark:bg-slate-900/20 border border-slate-200/30 dark:border-slate-700/20 mb-4">
                      <Info className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        These faces have been ignored. You can restore them back to Unnamed, or delete them permanently.
                      </p>
                    </div>
                    <div className="space-y-2">
                      {ignoredClusters.map((cluster, idx) => (
                        <PersonCardRow
                          rowIndex={idx}
                          key={clusterKey(cluster)} onVisible={() => ensureClusterCrops(cluster)}
                          cluster={cluster}
                          cropUrl={faceCropsMap[clusterKey(cluster)]}
                          sampleCrops={faceCropsMap}
                          isEditing={editingCluster === clusterKey(cluster)}
                          nameInput={nameInput}
                          fullNameInput={fullNameInput}
                          onStartEdit={() => { setEditingCluster(clusterKey(cluster)); setNameInput(''); setFullNameInput(''); setTimeout(() => nameInputRef.current?.focus(), 50); }}
                          onNameChange={setNameInput}
                          onFullNameChange={setFullNameInput}
                          onSubmit={() => handleNameCluster(cluster.cluster_id, nameInput, fullNameInput)}
                          onCancel={() => { setEditingCluster(null); setNameInput(''); setFullNameInput(''); }}
                          inputRef={nameInputRef}
                          fullInputRef={fullNameInputRef}
                          existingPersons={existingPersons}
                          onSelectPerson={(name) => handleNameCluster(cluster.cluster_id, name)}
                          onRestore={() => handleRestoreToUnnamed(cluster.cluster_id, cluster.person_id)}
                          onDiscard={cluster.person_id ? () => setConfirmPermanentDelete({ personId: cluster.person_id!, personName: 'Ignored face group' }) : undefined}
                          onReassignFace={handleReassignFace}
                          globalSelectedFaces={globalSelectedFaces}
                          onGlobalSelectionChange={setGlobalSelectedFaces}
                          globalReassignFaceId={globalReassignFaceId}
                          onGlobalReassignChange={(id, name) => { setGlobalReassignFaceId(id); setGlobalReassignName(name); }}
                          globalReassignName={globalReassignName}
                          onGlobalReassignNameChange={setGlobalReassignName}
                          currentTab={activeTab}
                        />
                      ))}
                    </div>
                  </>
                )}

                {confirmPermanentDelete && (
                  <div className="rounded-xl border border-red-300/60 dark:border-red-700/40 bg-red-50/50 dark:bg-red-950/20 p-4 mt-4">
                    <div className="flex items-start gap-3 mb-3">
                      <ShieldAlert className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                      <div>
                        <h4 className="text-base font-semibold text-foreground mb-1">Permanently delete?</h4>
                        <p className="text-sm text-muted-foreground leading-relaxed">
                          This will permanently remove this face group and all associated AI data. This action cannot be undone.
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-8">
                      <button onClick={() => handlePermanentDelete(confirmPermanentDelete.personId)} className="px-3 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white text-sm font-medium transition-colors">
                        Permanently delete
                      </button>
                      <button onClick={() => setConfirmPermanentDelete(null)} className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary text-sm font-medium transition-colors">
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

      {/* ── Side panel — fixed action modal for face assignment ── */}
      {globalReassignFaceId !== null && (
        <div className="w-[280px] shrink-0 border-l border-border bg-background p-4 overflow-y-auto">
          <div className="space-y-2">
            {globalSelectedFaces.size > 1 && (
              <div className="bg-green-500 text-white text-sm font-medium text-center py-1 px-3 rounded-md">
                {globalSelectedFaces.size} faces selected
              </div>
            )}
            {faceCropsMap[globalReassignFaceId] && (
              <div className="flex justify-center">
                <img src={faceCropsMap[globalReassignFaceId]} alt="" className="w-16 h-16 rounded-full object-cover border-2 border-purple-400/40" />
              </div>
            )}
            {globalSelectedFaces.size <= 1 && (
              <p className="text-sm text-muted-foreground text-center">Choose an action for this face</p>
            )}
            <div className="relative">
              {(() => {
                const typed = globalReassignName.trim().toLowerCase();
                const panelSuggestions = typed.length > 0
                  ? existingPersons.filter(p => {
                      const name = p.name.toLowerCase();
                      // Hide suggestion if user has typed the exact full name
                      if (name === typed) return false;
                      // Filter out internal markers but INCLUDE people with 0
                      // photos — those are family members added in Trees who
                      // don't have photos yet; they must still be pickable or
                      // the user would create a duplicate when assigning faces.
                      if (name.startsWith('__')) return false;
                      return name.includes(typed);
                    })
                    .sort((a, b) => (b.photo_count ?? 0) - (a.photo_count ?? 0))
                    .slice(0, 8)
                  : [];
                return (
                  <>
                    <input
                      type="text"
                      value={globalReassignName}
                      onChange={(e) => { setGlobalReassignName(e.target.value); setPanelSuggestionIdx(-1); }}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowDown' && panelSuggestions.length > 0) {
                          e.preventDefault();
                          setPanelSuggestionIdx(prev => Math.min(prev + 1, panelSuggestions.length - 1));
                        } else if (e.key === 'ArrowUp' && panelSuggestions.length > 0) {
                          e.preventDefault();
                          setPanelSuggestionIdx(prev => Math.max(prev - 1, -1));
                        } else if (e.key === 'Enter') {
                          e.preventDefault();
                          let nameToUse = globalReassignName.trim();
                          if (panelSuggestionIdx >= 0 && panelSuggestions[panelSuggestionIdx]) {
                            nameToUse = panelSuggestions[panelSuggestionIdx].name;
                            setGlobalReassignName(nameToUse);
                            setPanelSuggestionIdx(-1);
                          }
                          if (!nameToUse) return;
                          const targets = Array.from(globalSelectedFaces);
                          if (targets.length === 0) return;
                          (async () => {
                            for (let i = 0; i < targets.length; i++) {
                              const isLast = i === targets.length - 1;
                              await handleReassignFace(targets[i], nameToUse, true, !isLast);
                            }
                            setGlobalReassignFaceId(null);
                            setGlobalReassignName('');
                            setGlobalSelectedFaces(new Set());
                            setPanelSuggestionIdx(-1);
                          })();
                        } else if (e.key === 'Escape') {
                          setGlobalReassignFaceId(null);
                          setGlobalReassignName('');
                          setGlobalSelectedFaces(new Set());
                          setPanelSuggestionIdx(-1);
                        }
                      }}
                      placeholder="Type person name..."
                      className="w-full text-base px-2.5 py-1.5 rounded-lg border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-purple-400/50"
                      autoFocus
                    />
                    {panelSuggestions.length > 0 && (
                      <div className="absolute left-0 right-0 top-full mt-1 rounded-lg border border-border bg-background shadow-lg z-10 py-0.5">
                        {panelSuggestions.map((p, idx) => (
                          <button key={p.id} onMouseDown={(e) => { e.preventDefault(); setGlobalReassignName(p.name); setPanelSuggestionIdx(-1); }}
                            className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-sm transition-colors text-left ${idx === panelSuggestionIdx ? 'bg-purple-200/70 dark:bg-purple-800/40' : 'hover:bg-purple-100/50 dark:hover:bg-purple-900/20'}`}>
                            <span className="truncate">{p.name}</span>
                            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{p.photo_count}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
            {(() => {
              // Determine implicit name: if all selected faces belong to the same Named cluster, use its name
              const targets = Array.from(globalSelectedFaces);
              const targetClusters = targets.map(fid => clusters.find(c => c.sample_faces?.some(f => f.face_id === fid)));
              const allSameNamedCluster = targetClusters.length > 0
                && targetClusters.every(c => c && c.person_name && !c.person_name.startsWith('__') && c.person_id === targetClusters[0]?.person_id);
              const implicitName = allSameNamedCluster ? (targetClusters[0]?.person_name || '') : '';
              const effectiveName = globalReassignName.trim() || implicitName;
              return (
                <div className="flex gap-1.5">
                  <button
                    onClick={() => {
                      const t = Array.from(globalSelectedFaces);
                      if (t.length === 0 || !effectiveName) return;
                      (async () => {
                        for (let i = 0; i < t.length; i++) {
                          const isLast = i === t.length - 1;
                          await handleReassignFace(t[i], effectiveName, true, !isLast);
                        }
                        setGlobalReassignFaceId(null);
                        setGlobalReassignName('');
                        setGlobalSelectedFaces(new Set());
                      })();
                    }}
                    disabled={!effectiveName}
                    className="flex-1 px-2 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
                  >
                    Verify{globalSelectedFaces.size > 1 ? ` (${globalSelectedFaces.size})` : ''}
                  </button>
                  <button
                    onClick={() => { setGlobalReassignFaceId(null); setGlobalReassignName(''); setGlobalSelectedFaces(new Set()); }}
                    className="px-2 py-1.5 rounded-lg border border-border hover:bg-secondary text-sm font-medium transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              );
            })()}
            <div className="flex gap-1.5 pt-1 border-t border-border">
              {activeTab !== 'unsure' && (
                <button onClick={() => {
                  const targets = Array.from(globalSelectedFaces);
                  if (targets.length === 0) return;
                  setGlobalReassignFaceId(null); setGlobalReassignName(''); setGlobalSelectedFaces(new Set());
                  (async () => { for (let i = 0; i < targets.length; i++) await handleReassignFace(targets[i], '__unsure__', false, i < targets.length - 1); })();
                }} className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-blue-300/50 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-sm font-medium transition-colors">
                  <HelpCircle className="w-3 h-3" /> Unsure
                </button>
              )}
              {activeTab !== 'unnamed' && (
                <button onClick={() => {
                  const targets = Array.from(globalSelectedFaces);
                  if (targets.length === 0) return;
                  setGlobalReassignFaceId(null); setGlobalReassignName(''); setGlobalSelectedFaces(new Set());
                  (async () => { for (let i = 0; i < targets.length; i++) await handleReassignFace(targets[i], '__unnamed__', false, i < targets.length - 1); })();
                }} className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-amber-300/50 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 text-sm font-medium transition-colors">
                  <Users className="w-3 h-3" /> Unnamed
                </button>
              )}
              {activeTab !== 'ignored' && (
                <button onClick={() => {
                  const targets = Array.from(globalSelectedFaces);
                  if (targets.length === 0) return;
                  setGlobalReassignFaceId(null); setGlobalReassignName(''); setGlobalSelectedFaces(new Set());
                  (async () => { for (let i = 0; i < targets.length; i++) await handleReassignFace(targets[i], '__ignored__', false, i < targets.length - 1); })();
                }} className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-slate-300/50 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/30 text-sm font-medium transition-colors">
                  <UserX className="w-3 h-3" /> Ignore
                </button>
              )}
            </div>
            {/* Set as main photo — only in Named tab with 1 face selected */}
            {activeTab === 'named' && globalSelectedFaces.size === 1 && (() => {
              // Find the cluster that owns this face
              const faceId = Array.from(globalSelectedFaces)[0];
              const ownerCluster = clusters.find(c => c.sample_faces?.some(f => f.face_id === faceId));
              if (!ownerCluster?.person_id) return null;
              return (
                <button
                  onClick={async () => {
                    await handleSetRepresentative(ownerCluster.person_id!, faceId);
                    setGlobalReassignFaceId(null); setGlobalReassignName(''); setGlobalSelectedFaces(new Set());
                  }}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-green-500 hover:bg-green-600 text-white text-sm font-medium transition-colors"
                >
                  <ImageIcon className="w-3 h-3" /> Set as main photo
                </button>
              );
            })()}
          </div>
        </div>
      )}
      </div>{/* end flex wrapper */}

      {/* Footer status bar */}
      <div className="px-6 py-3 border-t border-border bg-muted/30 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {namedClusters.length} named · {unnamedClusters.length} unnamed · {unsureClusters.length} unsure · {ignoredClusters.length} ignored
          {isReclustering && <span className="ml-2 text-purple-500"><Loader2 className="w-3 h-3 animate-spin inline-block" /> Reclustering...</span>}
        </p>
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <button onClick={() => { const z = Math.max(60, zoomLevel - 10); setZoomLevel(z); localStorage.setItem('pdr-people-zoom', String(z)); }} className="p-0.5 hover:text-foreground transition-colors">−</button>
          <span className="w-8 text-center">{zoomLevel}%</span>
          <button onClick={() => { const z = Math.min(150, zoomLevel + 10); setZoomLevel(z); localStorage.setItem('pdr-people-zoom', String(z)); }} className="p-0.5 hover:text-foreground transition-colors">+</button>
        </div>
      </div>
    </div>
  );
}

/* ─── Face Grid Modal — paginated grid of all faces, confidence-sorted ──── */

function FaceGridModal({ cluster, cropUrl, existingPersons, onReassignFace, onSetRepresentative, onClose }: {
  cluster: PersonCluster;
  cropUrl?: string;
  existingPersons: PersonRecord[];
  onReassignFace: (faceId: number, newName: string, verified?: boolean) => Promise<void>;
  onSetRepresentative?: (faceId: number) => Promise<void>;
  onClose: () => void;
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
    await loadPage(page);
  };

  // Visual similarity suggestions — loaded when popover opens
  const [visualSugs, setVisualSugs] = useState<{ personId: number; personName: string; similarity: number }[]>([]);
  const [visualSugsLoading, setVisualSugsLoading] = useState(false);

  useEffect(() => {
    if (reassignFaceId == null) { setVisualSugs([]); return; }
    let cancelled = false;
    setVisualSugsLoading(true);
    getVisualSuggestions(reassignFaceId).then(r => {
      if (!cancelled && r.success && r.data) setVisualSugs(r.data);
      if (!cancelled) setVisualSugsLoading(false);
    });
    return () => { cancelled = true; };
  }, [reassignFaceId]);

  const [reassignInputFocused, setReassignInputFocused] = useState(false);

  const reassignSuggestions = (() => {
    if (!reassignInputFocused) return [];
    const typed = reassignName.trim().toLowerCase();
    if (typed.length === 0) {
      return visualSugs
        .filter(v => v.similarity >= 0.70)
        .map(v => {
          const match = (existingPersons || []).find(p => p.id === v.personId);
          return { id: v.personId, name: v.personName, photo_count: match?.photo_count ?? 0 };
        });
    }
    const textMatches = (existingPersons || [])
      // Include photo-less named people (e.g. family added in Trees) so
      // re-assigning a face to them doesn't create a duplicate record.
      .filter(p => p.name.toLowerCase().includes(typed) && !p.name.startsWith('__'))
      .slice(0, 8);
    const visualMap = new Map(visualSugs.map(v => [v.personId, v.similarity]));
    return textMatches
      .map(p => ({ ...p, similarity: visualMap.get(p.id) ?? 0 }))
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .map(({ similarity, ...rest }) => rest)
      .slice(0, 5);
  })();

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
                <p className="text-xs text-muted-foreground">
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
                <span className="ml-2 text-base text-muted-foreground">Loading faces...</span>
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
                          <img src={faceCrops[face.face_id]} alt="" className={`w-full aspect-square rounded-lg object-cover hover:ring-2 hover:ring-purple-400/50 transition-all ${face.verified ? verifiedBorder : 'border border-border/50'}`} />
                        ) : (
                          <div className={`w-full aspect-square rounded-lg bg-secondary flex items-center justify-center ${face.verified ? verifiedBorder : ''}`}>
                            <Users className="w-4 h-4 text-muted-foreground/40" />
                          </div>
                        )}
                        <span className={`absolute bottom-0.5 right-0.5 text-[8px] font-bold px-1 py-0.5 rounded bg-background/80 backdrop-blur-sm ${confidenceColor(face.confidence)}`}>
                          {Math.round(face.confidence * 100)}%
                        </span>
                      </div>
                    </PopoverTrigger>
                    <PopoverContent side="top" align="center" className="min-w-[250px] max-w-[320px] w-auto p-3 z-[60]" onOpenAutoFocus={(e) => e.preventDefault()} collisionPadding={8}>
                      <div className="space-y-2">
                        {faceCrops[face.face_id] && (
                          <div className="flex justify-center">
                            <img src={faceCrops[face.face_id]} alt="" className="w-16 h-16 rounded-full object-cover border-2 border-purple-400/40" />
                          </div>
                        )}
                        <p className="text-[11px] text-center text-muted-foreground">
                          Confidence: <span className={`font-semibold ${confidenceColor(face.confidence)}`}>{confidenceLabel(face.confidence)} ({Math.round(face.confidence * 100)}%)</span>
                        </p>
                        <p className="text-sm text-muted-foreground text-center">Choose an action for this face</p>
                        <div className="relative">
                        <input
                          ref={reassignInputRef}
                          type="text"
                          value={reassignName}
                          onChange={(e) => setReassignName(e.target.value)}
                          onFocus={() => setReassignInputFocused(true)}
                          onBlur={() => setTimeout(() => setReassignInputFocused(false), 150)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && reassignName.trim()) handleReassign(face.face_id, reassignName); if (e.key === 'Escape') { setReassignFaceId(null); setReassignName(''); } }}
                          placeholder="Type person name..."
                          className="w-full text-base px-2.5 py-1.5 rounded-lg border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-purple-400/50"
                          autoFocus
                        />
                        {reassignSuggestions.length > 0 && (
                          <div className="absolute left-0 right-0 top-full mt-1 rounded-lg border border-border bg-background shadow-lg z-10 py-0.5">
                            {reassignSuggestions.map(p => (
                              <button key={p.id} onMouseDown={(e) => { e.preventDefault(); setReassignName(p.name); setReassignInputFocused(false); }}
                                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-purple-100/50 dark:hover:bg-purple-900/20 transition-colors text-left">
                                <span className="truncate">{p.name}</span>
                                <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{p.photo_count}</span>
                              </button>
                            ))}
                          </div>
                        )}
                        </div>
                        <div className="flex gap-1.5">
                          <button onClick={() => handleReassign(face.face_id, reassignName)} disabled={!reassignName.trim()}
                            className="flex-1 px-2 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors">
                            Verify
                          </button>
                          <button onClick={() => { setReassignFaceId(null); setReassignName(''); }}
                            className="px-2 py-1.5 rounded-lg border border-border hover:bg-secondary text-sm font-medium transition-colors">
                            Cancel
                          </button>
                        </div>
                        <div className="flex gap-1.5 pt-1 border-t border-border">
                          <button onClick={() => handleReassign(face.face_id, '__unsure__', false)}
                            className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-blue-300/50 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-sm font-medium transition-colors">
                            <HelpCircle className="w-3 h-3" /> Unsure
                          </button>
                          <button onClick={() => handleReassign(face.face_id, '__unnamed__', false)}
                            className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-amber-300/50 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 text-sm font-medium transition-colors">
                            <Users className="w-3 h-3" /> Unnamed
                          </button>
                          <button onClick={() => handleReassign(face.face_id, '__ignored__', false)}
                            className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-slate-300/50 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/30 text-sm font-medium transition-colors">
                            <UserX className="w-3 h-3" /> Ignore
                          </button>
                        </div>
                        {onSetRepresentative && cluster.person_id && (
                          <button onClick={async () => { await onSetRepresentative(face.face_id); setReassignFaceId(null); setReassignName(''); }}
                            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-green-300/50 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 text-sm font-medium transition-colors">
                            <ImageIcon className="w-3 h-3" /> Set as main photo
                          </button>
                        )}
                      </div>
                    </PopoverContent>
                  </Popover>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Users className="w-10 h-10 text-muted-foreground/20 mb-3" />
                <p className="text-base text-muted-foreground">No faces found</p>
              </div>
            )}
          </div>

          {/* Pagination */}
          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-3 border-t border-border">
              <button
                onClick={() => { const p = Math.max(0, page - 1); setPage(p); loadPage(p); }}
                disabled={page === 0}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border bg-background hover:bg-secondary text-base font-medium disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" /> Previous
              </button>
              <span className="text-base text-muted-foreground">
                Page {page + 1} of {data.totalPages} · {data.total} faces
              </span>
              <button
                onClick={() => { const p = Math.min(data.totalPages - 1, page + 1); setPage(p); loadPage(p); }}
                disabled={page >= data.totalPages - 1}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border bg-background hover:bg-secondary text-base font-medium disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Footer */}
          <div className="mt-4 pt-3 border-t border-border">
            <button onClick={onClose} className="w-full px-4 py-2.5 rounded-lg bg-primary text-primary-foreground text-base font-medium hover:bg-primary/90 transition-colors">
              Done
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

/* ─── Card Row — name LEFT, scrollable thumbnails RIGHT ─────────────────── */

function PersonCardRow({ cluster, cropUrl, sampleCrops, isEditing, nameInput, fullNameInput, onStartEdit, onNameChange, onFullNameChange, onSubmit, onCancel, inputRef, fullInputRef, existingPersons, onSelectPerson, onDiscard, pendingIgnore, onIgnore, onConfirmIgnore, onCancelIgnore, pendingUnsure, onUnsure, onConfirmUnsure, onCancelUnsure, onRestore, displayName, onReassignFace, onSetRepresentative, globalSelectedFaces, onGlobalSelectionChange, globalReassignFaceId, onGlobalReassignChange, globalReassignName, onGlobalReassignNameChange, currentTab, rowIndex, onVisible }: {
  cluster: PersonCluster;
  cropUrl?: string;
  sampleCrops: Record<string, string>;
  isEditing: boolean;
  nameInput: string;
  /** Optional long-form name input. Edited alongside the short name
   *  when the user is renaming a cluster. Empty = no full name on
   *  file (Trees falls back to short). */
  fullNameInput: string;
  onStartEdit: () => void;
  onNameChange: (name: string) => void;
  onFullNameChange: (name: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  fullInputRef: React.RefObject<HTMLInputElement | null>;
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
  onReassignFace?: (faceId: number, newName: string, verified?: boolean, skipReload?: boolean) => Promise<void>;
  onSetRepresentative?: (faceId: number) => Promise<void>;
  // Cross-row selection props
  globalSelectedFaces: Set<number>;
  onGlobalSelectionChange: (faces: Set<number>) => void;
  globalReassignFaceId: number | null;
  onGlobalReassignChange: (faceId: number | null, name: string) => void;
  globalReassignName: string;
  onGlobalReassignNameChange: (name: string) => void;
  currentTab?: 'named' | 'unnamed' | 'unsure' | 'ignored';
  rowIndex?: number;
  /** Fired the first time this row's DOM element becomes visible
   *  within the scroll viewport. Used by the parent to request face-
   *  thumbnail crops lazily — off-screen rows never pay the I/O cost
   *  until scrolled to. Safe to call repeatedly; the parent's
   *  ensureClusterCrops already dedups. */
  onVisible?: () => void;
}) {
  // Ring colour for verified faces based on which category the cluster belongs to
  const getVerifiedBorderClass = (): string => {
    if (!cluster.person_name) return 'border-2 border-amber-400/70'; // Unnamed
    if (cluster.person_name === '__unsure__') return 'border-2 border-blue-400/70';
    if (cluster.person_name === '__ignored__') return 'border-2 border-[#76899F]/70';
    if (cluster.person_name.startsWith('__')) return '';
    return 'border-2 border-purple-400/70'; // Named (real name)
  };
  const verifiedBorder = getVerifiedBorderClass();

  const filteredPersons = (existingPersons || [])
    // Allow photo-less named people (Trees additions) in suggestions too,
    // or renaming a cluster onto a Trees-added person would always make a
    // duplicate record.
    .filter(p => nameInput.length > 0 && p.name.toLowerCase().includes(nameInput.toLowerCase()) && p.name !== cluster.person_name && !p.name.startsWith('__'))
    .slice(0, 6);

  // Use global selection state (shared across rows)
  const reassignFaceId = globalReassignFaceId;
  const setReassignFaceId = (id: number | null) => onGlobalReassignChange(id, id == null ? '' : globalReassignName);
  const reassignName = globalReassignName;
  const setReassignName = (name: string) => onGlobalReassignNameChange(name);
  const selectedFaces = globalSelectedFaces;
  const setSelectedFaces = (update: Set<number> | ((prev: Set<number>) => Set<number>)) => {
    if (typeof update === 'function') {
      onGlobalSelectionChange(update(globalSelectedFaces));
    } else {
      onGlobalSelectionChange(update);
    }
  };
  const reassignInputRef = useRef<HTMLInputElement>(null);

  // Visual similarity suggestions — loaded when popover opens
  const [visualSugs, setVisualSugs] = useState<{ personId: number; personName: string; similarity: number }[]>([]);
  const [visualSugsLoading, setVisualSugsLoading] = useState(false);

  useEffect(() => {
    if (reassignFaceId == null) { setVisualSugs([]); return; }
    let cancelled = false;
    setVisualSugsLoading(true);
    getVisualSuggestions(reassignFaceId).then(r => {
      if (!cancelled && r.success && r.data) setVisualSugs(r.data);
      if (!cancelled) setVisualSugsLoading(false);
    });
    return () => { cancelled = true; };
  }, [reassignFaceId]);

  const [reassignInputFocused, setReassignInputFocused] = useState(false);

  // Combine visual + text suggestions: visual first (sorted by similarity), text filter when typing
  const reassignSuggestions = (() => {
    if (!reassignInputFocused) return [];
    const typed = reassignName.trim().toLowerCase();
    if (typed.length === 0) {
      // Show visual suggestions >= 70% similarity, sorted by highest match
      return visualSugs
        .filter(v => v.similarity >= 0.70)
        .map(v => {
          const match = (existingPersons || []).find(p => p.id === v.personId);
          return {
            id: v.personId,
            name: v.personName,
            photo_count: match?.photo_count ?? 0,
          };
        });
    }
    // Text-based filtering, boosted by visual similarity
    const textMatches = (existingPersons || [])
      // Include photo-less named people (e.g. family added in Trees) so
      // re-assigning a face to them doesn't create a duplicate record.
      .filter(p => p.name.toLowerCase().includes(typed) && !p.name.startsWith('__'))
      .slice(0, 8);
    const visualMap = new Map(visualSugs.map(v => [v.personId, v.similarity]));
    return textMatches
      .map(p => ({ ...p, similarity: visualMap.get(p.id) ?? 0 }))
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .map(({ similarity, ...rest }) => rest)
      .slice(0, 5);
  })();

  // Face-level multi-select (selectedFaces and setSelectedFaces are aliases to global props above)
  const [lastSelectedFaceIdx, setLastSelectedFaceIdx] = useState<number | null>(null);
  const [showSelectionPrompt, setShowSelectionPrompt] = useState(false);

  const handleFaceClick = (faceId: number, faceIdx: number, e: React.MouseEvent) => {
    const faces = cluster.sample_faces || [];
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+click — toggle this face in/out of selection, keep popover on anchor face
      setSelectedFaces(prev => {
        const next = new Set(prev);
        if (next.has(faceId)) next.delete(faceId); else next.add(faceId);
        return next;
      });
      setLastSelectedFaceIdx(faceIdx);
      // If no popover is open yet, open one on this face
      if (reassignFaceId === null) {
        onGlobalReassignChange(faceId, '');
        setTimeout(() => reassignInputRef.current?.focus(), 100);
      }
    } else if (e.shiftKey && lastSelectedFaceIdx !== null) {
      // Shift+click — range select within this row
      const start = Math.min(lastSelectedFaceIdx, faceIdx);
      const end = Math.max(lastSelectedFaceIdx, faceIdx);
      setSelectedFaces(prev => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) {
          if (faces[i]) next.add(faces[i].face_id);
        }
        return next;
      });
      // If no popover is open yet, open one on the first selected face
      if (reassignFaceId === null) {
        onGlobalReassignChange(faceId, '');
        setTimeout(() => reassignInputRef.current?.focus(), 100);
      }
    } else {
      // Normal click — select this face, open popover (clears previous selection)
      const newSelection = new Set<number>();
      newSelection.add(faceId);
      setSelectedFaces(newSelection);
      setLastSelectedFaceIdx(faceIdx);
      setShowSelectionPrompt(false);
      onGlobalReassignChange(faceId, '');
      // Pre-load the context crop so tooltip is ready when user hovers
      const clickedFace = faces.find(f => f.face_id === faceId);
      if (clickedFace?.file_path) {
        loadContextCrop(`face_${faceId}`, clickedFace.file_path, clickedFace.box_x, clickedFace.box_y, clickedFace.box_w, clickedFace.box_h);
      }
      setTimeout(() => reassignInputRef.current?.focus(), 100);
    }
  };

  const clearSelection = () => {
    onGlobalSelectionChange(new Set());
    setLastSelectedFaceIdx(null);
    setShowSelectionPrompt(false);
  };

  // Get all face IDs that this action should apply to (uses global selection)
  const getTargetFaceIds = (): number[] => {
    return Array.from(globalSelectedFaces);
  };

  const handleReassign = async (name: string, verified: boolean = true) => {
    if (!name.trim() || !onReassignFace) return;
    const targets = getTargetFaceIds();
    if (targets.length === 0) return;
    // Close modal and clear selection first to prevent interference
    setReassignFaceId(null);
    setReassignName('');
    clearSelection();
    // Process all faces — skip reload for all except the last
    for (let i = 0; i < targets.length; i++) {
      const isLast = i === targets.length - 1;
      await onReassignFace(targets[i], name.trim(), verified, !isLast);
    }
  };

  const [selectedSuggestionIdx, setSelectedSuggestionIdx] = useState(-1);
  const [reassignSuggestionIdx, setReassignSuggestionIdx] = useState(-1);

  const [contextCrops, setContextCrops] = useState<Record<string, string>>({});
  /** Metadata cache for the PM hover preview overlay — filename,
   *  derived date, country, city. Keyed identically to contextCrops
   *  so a single hover request can populate both in parallel. */
  const [contextMeta, setContextMeta] = useState<Record<string, FileMetaSlice>>({});
  const loadContextCrop = async (key: string, filePath: string, bx: number, by: number, bw: number, bh: number) => {
    // Fetch image + metadata in parallel; cache both keyed identically.
    const tasks: Promise<unknown>[] = [];
    if (!contextCrops[key]) {
      tasks.push((async () => {
        const result = await getFaceContext(filePath, bx, by, bw, bh, 200);
        if (result.success && result.dataUrl) {
          setContextCrops(prev => ({ ...prev, [key]: result.dataUrl! }));
        }
      })());
    }
    if (!contextMeta[key]) {
      tasks.push((async () => {
        const result = await getFileMetaByPath(filePath);
        if (result.success && result.data) {
          setContextMeta(prev => ({ ...prev, [key]: result.data! }));
        }
      })());
    }
    await Promise.all(tasks);
  };

  /** Render the human-readable date for the PM hover overlay. We only
   *  care about Y-M-D — the time component would just be visual noise
   *  in a small overlay. Fall back gracefully to "—" if the row has
   *  no derived date (early-import or recovered-failed files). */
  const formatHoverDate = (s: string | null | undefined): string => {
    if (!s) return '—';
    // derived_date can be 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS'
    const ymd = s.slice(0, 10);
    const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return ymd;
    const [, y, mo, d] = m;
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${parseInt(d, 10)} ${months[parseInt(mo, 10) - 1] || mo} ${y}`;
  };

  const [showFaceGrid, setShowFaceGrid] = useState(false);
  const [scrollPosition, setScrollPosition] = useState(0); // index of first visible thumbnail

  const cardRef = useRef<HTMLDivElement>(null);

  // Lazy-fetch trigger — fire onVisible the first time this row's DOM
  // element enters (or is about to enter) the viewport. Latest-ref
  // pattern so the handler identity doesn't recreate the observer on
  // every parent render. rootMargin of 200px prefetches just before
  // the row scrolls into actual view so thumbnails are ready by the
  // time the user's eye lands on the row. The parent's
  // ensureClusterCrops dedups, so repeated triggers are harmless.
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          onVisibleRef.current?.();
        }
      }
    }, { rootMargin: '200px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const thumbStripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = thumbStripRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      // Only intercept vertical scroll for horizontal thumb scrolling when there's overflow to scroll
      const hasHorizontalOverflow = el.scrollWidth > el.clientWidth;
      if (e.deltaY !== 0 && hasHorizontalOverflow) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
        e.stopPropagation();
      }
    };
    el.addEventListener('wheel', handler, { passive: false });
    // Track scroll position to show "X of Y" counter
    const scrollHandler = () => {
      const thumbWidth = 46; // w-10 (40px) + gap (6px)
      const visibleIdx = Math.round(el.scrollLeft / thumbWidth);
      setScrollPosition(visibleIdx);
    };
    el.addEventListener('scroll', scrollHandler, { passive: true });
    return () => { el.removeEventListener('wheel', handler); el.removeEventListener('scroll', scrollHandler); };
  });

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
          <p className="text-base text-foreground flex-1">Ignore this person?</p>
          <button onClick={onConfirmIgnore} className="px-3 py-1.5 rounded-lg bg-slate-500 hover:bg-slate-600 text-white text-sm font-medium transition-colors">
            Yes, ignore
          </button>
          <button onClick={onCancelIgnore} className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary text-sm font-medium transition-colors">
            Cancel
          </button>
        </div>
      </div>
    );
  }

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
          <p className="text-base text-foreground flex-1">Move to Unsure?</p>
          <button onClick={onConfirmUnsure} className="px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium transition-colors">
            Yes
          </button>
          <button onClick={onCancelUnsure} className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary text-sm font-medium transition-colors">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={0}>
    <div
      ref={cardRef}
      className={`rounded-xl border transition-all group ${
        isEditing
          ? 'border-purple-400/60 bg-purple-50/30 dark:bg-purple-950/20 shadow-md'
          : 'border-border hover:border-purple-300/50 hover:shadow-sm'
      }`}
    >
      <div className="p-4">
        <div className="flex items-center gap-3">
          {/* Row number */}
          {rowIndex != null && (
            <span className={`text-sm font-bold shrink-0 w-5 text-center ${
              cluster.person_name === '__ignored__' ? 'text-[#76899F]'
              : cluster.person_name === '__unsure__' ? 'text-blue-600'
              : !cluster.person_name ? 'text-amber-600'
              : 'text-purple-600'
            }`}>{rowIndex + 1}</span>
          )}
          {/* Main face thumbnail — uses user-chosen rep for Named, else first sample face */}
          <TooltipProvider delayDuration={0}>
            <Tooltip onOpenChange={(open) => {
              const isNamed = cluster.person_name && !cluster.person_name.startsWith('__');
              const repFace = isNamed ? cluster.sample_faces?.find(f => f.face_id === cluster.representative_face_id) : null;
              const displayFace = repFace || cluster.sample_faces?.[0];
              if (open && displayFace?.file_path) {
                loadContextCrop(`main_${displayFace.face_id}`, displayFace.file_path, displayFace.box_x, displayFace.box_y, displayFace.box_w, displayFace.box_h);
              }
            }}>
              <TooltipTrigger asChild>
                <div className={`shrink-0 ${(!isEditing && cluster.person_name && !cluster.person_name.startsWith('__')) ? 'cursor-pointer' : ''}`} onClick={() => { if (!isEditing && cluster.person_name && !cluster.person_name.startsWith('__')) onStartEdit(); }}>
                  {(() => {
                    // For Named clusters, prefer user-chosen representative if set
                    const isNamed = cluster.person_name && !cluster.person_name.startsWith('__');
                    const repFaceId = isNamed ? cluster.representative_face_id : null;
                    const firstFaceId = cluster.sample_faces?.[0]?.face_id;
                    const displayFaceId = (repFaceId && sampleCrops[repFaceId]) ? repFaceId : firstFaceId;
                    const mainCrop = displayFaceId ? sampleCrops[displayFaceId] : cropUrl;
                    return mainCrop ? (
                    <img src={mainCrop} alt="" className={`w-14 h-14 rounded-full object-cover shrink-0 border-2 ${
                      cluster.person_name === '__ignored__' ? 'border-[#76899F]'
                      : cluster.person_name === '__unsure__' ? 'border-blue-400'
                      : !cluster.person_name ? 'border-amber-400'
                      : cluster.person_name.startsWith('__') ? 'border-purple-400/40'
                      : 'border-indigo-500'
                    }`} />
                    ) : (
                    <div className="w-14 h-14 rounded-full bg-purple-500/15 flex items-center justify-center shrink-0">
                      <Users className="w-6 h-6 text-purple-400" />
                    </div>
                    );
                  })()}
                </div>
              </TooltipTrigger>
              {(cropUrl || cluster.sample_faces?.[0]) && (
                <TooltipContent side="right" className="p-0.5 border border-purple-400/30 bg-background shadow-lg rounded-xl z-[70]">
                  {(() => {
                    const isNamed = cluster.person_name && !cluster.person_name.startsWith('__');
                    const repFace = isNamed ? cluster.sample_faces?.find(f => f.face_id === cluster.representative_face_id) : null;
                    const displayFace = repFace || cluster.sample_faces?.[0];
                    const displayFaceId = displayFace?.face_id;
                    const contextKey = displayFaceId ? `main_${displayFaceId}` : '';
                    const contextImg = contextKey ? contextCrops[contextKey] : null;
                    const fallback = displayFaceId ? sampleCrops[displayFaceId] : cropUrl;
                    return <img src={contextImg || fallback} alt="" className={`${contextImg ? 'w-[200px] h-[200px] rounded-lg' : 'w-28 h-28 rounded-full'} object-cover`} />;
                  })()}
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>

          {/* Name + stats — clicking this area opens rename (only for named persons) */}
          <div
            className={`min-w-0 ${isEditing ? 'flex-1' : `w-[120px] shrink-0 ${cluster.person_name && !cluster.person_name.startsWith('__') ? 'cursor-pointer' : ''}`}`}
            onClick={() => { if (!isEditing && cluster.person_name && !cluster.person_name.startsWith('__')) onStartEdit(); }}
          >
            {isEditing ? (
              <div onClick={(e) => e.stopPropagation()}>
                <form onSubmit={(e) => { e.preventDefault(); if (nameInput.trim()) onSubmit(); }} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-3">
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
                      placeholder="Name (short) — e.g. Terry"
                      className="flex-1 text-base bg-transparent border-b-2 border-purple-400 outline-none text-foreground placeholder:text-muted-foreground/50 pb-0.5 min-w-0"
                      autoFocus
                    />
                    <button type="submit" disabled={!nameInput.trim()} className="px-3 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors whitespace-nowrap">
                      Save
                    </button>
                  </div>
                  {/* Optional full name. Shown on Trees cards; PM and
                      S&D keep using the short name above. Empty =
                      Trees falls back to the short name. */}
                  <input
                    ref={fullInputRef}
                    type="text"
                    value={fullNameInput}
                    onChange={(e) => onFullNameChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                      if (e.key === 'Enter') { e.preventDefault(); if (nameInput.trim()) onSubmit(); }
                    }}
                    placeholder="Name (full) — e.g. Terry John Filmer Clapson (optional)"
                    className="text-sm bg-transparent border-b border-border outline-none text-foreground/80 placeholder:text-muted-foreground/40 pb-0.5"
                  />
                </form>
                {filteredPersons.length > 0 && (
                  <div className="mt-1.5 space-y-0.5">
                    {filteredPersons.map((p, idx) => (
                      <button key={p.id} onClick={(e) => { e.stopPropagation(); onSelectPerson?.(p.name); }}
                        className={`w-full flex items-center gap-2 px-1.5 py-1 rounded text-sm transition-colors text-left ${idx === selectedSuggestionIdx ? 'bg-purple-200/70 dark:bg-purple-800/40' : 'hover:bg-purple-100/50 dark:hover:bg-purple-900/20'}`}>
                        <Users className="w-3 h-3 text-purple-400 shrink-0" />
                        <span className="truncate">{p.name}</span>
                        {p.photo_count != null && <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{p.photo_count}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                <p className={`text-base font-medium truncate ${(cluster.person_name && !cluster.person_name.startsWith('__') && !displayName) ? 'text-foreground' : 'text-muted-foreground italic'}`}>
                  {displayName || (cluster.person_name && !cluster.person_name.startsWith('__') ? cluster.person_name : 'Unknown person')}
                </p>
                {/* Full name hint — shown only when set, so user can
                    see at a glance which clusters already have a
                    long-form name on file (used by Trees) without
                    cluttering rows that don't. */}
                {cluster.person_full_name && cluster.person_full_name !== cluster.person_name && (
                  <p className="text-[11px] text-muted-foreground/70 truncate" title={cluster.person_full_name}>
                    {cluster.person_full_name}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {cluster.photo_count} {cluster.photo_count === 1 ? 'photo' : 'photos'}
                  {currentTab === 'named' && cluster.sample_faces && (() => {
                    const verifiedCount = cluster.sample_faces.filter(f => f.verified).length;
                    const totalCount = cluster.sample_faces.length;
                    return verifiedCount > 0 ? <span className="text-purple-500 ml-1">· {verifiedCount}/{totalCount} verified</span> : null;
                  })()}
                </p>
              </>
            )}
          </div>

          {/* Sample face thumbnails */}
          {!isEditing && cluster.sample_faces && cluster.sample_faces.length > 0 && (
            <div className="flex flex-col flex-1 min-w-0">
              <div
                ref={thumbStripRef}
                className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent py-1"
                onClick={(e) => e.stopPropagation()}
              >
                {cluster.sample_faces.map((face, faceIdx) => (
                    <TooltipProvider key={face.face_id} delayDuration={0}>
                      <Tooltip onOpenChange={(open) => {
                        if (open && face.file_path) {
                          loadContextCrop(`face_${face.face_id}`, face.file_path, face.box_x, face.box_y, face.box_w, face.box_h);
                        }
                      }}>
                        <TooltipTrigger asChild>
                            <div
                              className="shrink-0 relative"
                              data-face-thumb="true"
                              onClick={(e) => { e.stopPropagation(); handleFaceClick(face.face_id, faceIdx, e); }}
                            >
                              {sampleCrops[face.face_id] ? (
                                <img
                                  src={sampleCrops[face.face_id]}
                                  alt=""
                                  className={`w-10 h-10 rounded-full object-cover cursor-pointer transition-all ${
                                    selectedFaces.has(face.face_id)
                                      ? 'ring-2 ring-green-500 ring-offset-1 ring-offset-background'
                                      : face.verified ? `${verifiedBorder} hover:ring-2 hover:ring-purple-400/50` : 'border border-border/50 hover:ring-2 hover:ring-purple-400/50'
                                  }`}
                                />
                              ) : (
                                <div className={`w-10 h-10 rounded-full bg-secondary flex items-center justify-center cursor-pointer ${
                                  selectedFaces.has(face.face_id)
                                    ? 'ring-2 ring-green-500 ring-offset-1 ring-offset-background'
                                    : face.verified ? verifiedBorder : ''
                                }`}>
                                  <Users className="w-3.5 h-3.5 text-muted-foreground/40" />
                                </div>
                              )}
                              {selectedFaces.has(face.face_id) && (
                                <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-green-500 flex items-center justify-center shadow-sm">
                                  <Check className="w-2.5 h-2.5 text-white" />
                                </div>
                              )}
                              <div className={`absolute -top-1 -left-1 w-4 h-4 rounded-full flex items-center justify-center shadow-sm ${
                                face.verified && cluster.person_name && !cluster.person_name.startsWith('__') ? 'bg-purple-400/80' : 'bg-muted-foreground/50'
                              }`}>
                                <span className="text-[8px] font-bold text-white">{faceIdx + 1}</span>
                              </div>
                            </div>
                        </TooltipTrigger>
                        {contextCrops[`face_${face.face_id}`] && (
                          <TooltipContent side="top" avoidCollisions={false} className="p-1.5 border border-purple-400/30 bg-background shadow-lg rounded-xl z-[80] max-w-[260px]">
                            {/* Click the enlarged photo to open it in
                                the full viewer — useful when a small
                                head + box still leaves the user
                                unsure who the person is. */}
                            <img
                              src={contextCrops[`face_${face.face_id}`]}
                              alt=""
                              className="w-[200px] h-[200px] rounded-lg object-cover cursor-zoom-in"
                              title="Click to open in viewer"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (face.file_path) {
                                  const meta = contextMeta[`face_${face.face_id}`];
                                  openSearchViewer(face.file_path, meta?.filename || face.file_path.split(/[\\/]/).pop() || '');
                                }
                              }}
                            />
                            {/* Metadata strip — filename, date, location.
                                Displayed only for the enlarged hover so
                                the small thumbnail row stays uncluttered.
                                Helps the user place the photo in space
                                and time when figuring out who's in it. */}
                            {(() => {
                              const meta = contextMeta[`face_${face.face_id}`];
                              if (!meta) return null;
                              const place = [meta.geo_city, meta.geo_country].filter(Boolean).join(', ');
                              return (
                                <div className="mt-1.5 px-1 pb-0.5 space-y-0.5 text-[10px]">
                                  <div className="font-medium text-foreground/90 truncate" title={meta.filename}>{meta.filename || '—'}</div>
                                  <div className="flex items-center gap-2 text-muted-foreground">
                                    <span>{formatHoverDate(meta.derived_date)}</span>
                                    {place && <span className="truncate">· {place}</span>}
                                  </div>
                                </div>
                              );
                            })()}
                          </TooltipContent>
                        )}
                      </Tooltip>
                    </TooltipProvider>
                ))}
              </div>
              {/* Scroll position counter */}
              {cluster.sample_faces && cluster.sample_faces.length > 6 && (
                <div className="text-[10px] text-muted-foreground/60 text-right pr-1 mt-0.5">
                  {Math.min(scrollPosition + 1, cluster.sample_faces.length)}–{Math.min(scrollPosition + Math.floor((thumbStripRef.current?.clientWidth || 300) / 46), cluster.sample_faces.length)} of {cluster.sample_faces.length}
                </div>
              )}

            </div>
          )}

          {/* Hover action buttons */}
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
              {onDiscard && (
                <Tooltip><TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDiscard(); }}
                    className="p-1.5 rounded-lg border border-red-300/50 bg-background hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-red-500" />
                  </button>
                </TooltipTrigger><TooltipContent>Send to Unnamed</TooltipContent></Tooltip>
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
    {showFaceGrid && onReassignFace && (
      <FaceGridModal
        cluster={cluster}
        cropUrl={cropUrl}
        existingPersons={existingPersons || []}
        onReassignFace={onReassignFace}
        onSetRepresentative={onSetRepresentative}
        onClose={() => setShowFaceGrid(false)}
      />
    )}
    </TooltipProvider>
  );
}

/* ─── List View ─────────────────────────────────────────────────────────── */

function PersonListRow({ cluster, cropUrl, sampleCrops, isEditing, nameInput, fullNameInput, onStartEdit, onNameChange, onFullNameChange, onSubmit, onCancel, inputRef, fullInputRef, onDiscard, pendingIgnore, onIgnore, onConfirmIgnore, onCancelIgnore, pendingUnsure, onUnsure, onConfirmUnsure, onCancelUnsure, onVisible }: {
  cluster: PersonCluster;
  cropUrl?: string;
  sampleCrops: Record<string, string>;
  isEditing: boolean;
  nameInput: string;
  fullNameInput: string;
  onStartEdit: () => void;
  onNameChange: (name: string) => void;
  onFullNameChange: (name: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  fullInputRef: React.RefObject<HTMLInputElement | null>;
  onDiscard?: () => void;
  pendingIgnore?: boolean;
  onIgnore?: () => void;
  onConfirmIgnore?: () => void;
  onCancelIgnore?: () => void;
  pendingUnsure?: boolean;
  onUnsure?: () => void;
  onConfirmUnsure?: () => void;
  onCancelUnsure?: () => void;
  /** Fired when this row first becomes visible — same contract as
   *  PersonCardRow so the parent can lazy-fetch crops. */
  onVisible?: () => void;
}) {
  const getVerifiedBorderClass = (): string => {
    if (!cluster.person_name) return 'border-2 border-amber-400/70';
    if (cluster.person_name === '__unsure__') return 'border-2 border-blue-400/70';
    if (cluster.person_name === '__ignored__') return 'border-2 border-[#76899F]/70';
    if (cluster.person_name.startsWith('__')) return '';
    return 'border-[3px] border-purple-500';
  };
  const verifiedBorder = getVerifiedBorderClass();

  const listRef = useRef<HTMLDivElement>(null);

  // Lazy-fetch trigger — same pattern as PersonCardRow. See there for
  // commentary on the latest-ref approach.
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          onVisibleRef.current?.();
        }
      }
    }, { rootMargin: '200px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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

  if (pendingIgnore) {
    return (
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-50/30 dark:bg-slate-900/20 border border-slate-300/40">
        {cropUrl ? <img src={cropUrl} alt="" className="w-7 h-7 rounded-full object-cover shrink-0 opacity-60" /> : <div className="w-7 h-7 rounded-full bg-slate-200 shrink-0" />}
        <span className="text-base text-foreground flex-1">Ignore?</span>
        <button onClick={onConfirmIgnore} className="px-2.5 py-1 rounded-md bg-slate-500 hover:bg-slate-600 text-white text-sm font-medium transition-colors">Yes</button>
        <button onClick={onCancelIgnore} className="px-2.5 py-1 rounded-md border border-border hover:bg-secondary text-sm font-medium transition-colors">No</button>
      </div>
    );
  }
  if (pendingUnsure) {
    return (
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-blue-50/30 dark:bg-blue-900/20 border border-blue-300/40">
        {cropUrl ? <img src={cropUrl} alt="" className="w-7 h-7 rounded-full object-cover shrink-0 opacity-60" /> : <div className="w-7 h-7 rounded-full bg-blue-200 shrink-0" />}
        <span className="text-base text-foreground flex-1">Mark as unsure?</span>
        <button onClick={onConfirmUnsure} className="px-2.5 py-1 rounded-md bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium transition-colors">Yes</button>
        <button onClick={onCancelUnsure} className="px-2.5 py-1 rounded-md border border-border hover:bg-secondary text-sm font-medium transition-colors">No</button>
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
      onClick={(e) => {
        if (isEditing) return;
        onStartEdit();
      }}
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
          <form onSubmit={(e) => { e.preventDefault(); if (nameInput.trim()) onSubmit(); }} className="flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-1.5">
              <input ref={inputRef} type="text" value={nameInput} onChange={(e) => onNameChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }}
                placeholder="Name (short) — e.g. Terry" className="flex-1 text-base bg-transparent border-b-2 border-purple-400 outline-none text-foreground placeholder:text-muted-foreground/50 pb-0.5 min-w-0" autoFocus />
              <Tooltip><TooltipTrigger asChild>
                <button type="submit" className="p-1 rounded hover:bg-purple-200/50 dark:hover:bg-purple-800/30"><Check className="w-3.5 h-3.5 text-purple-500" /></button>
              </TooltipTrigger><TooltipContent>Save</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild>
                <button type="button" onClick={onCancel} className="p-1 rounded hover:bg-secondary"><X className="w-3.5 h-3.5 text-muted-foreground" /></button>
              </TooltipTrigger><TooltipContent>Cancel</TooltipContent></Tooltip>
            </div>
            <input ref={fullInputRef} type="text" value={fullNameInput} onChange={(e) => onFullNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                if (e.key === 'Enter') { e.preventDefault(); if (nameInput.trim()) onSubmit(); }
              }}
              placeholder="Name (full) — optional, used in Trees" className="text-sm bg-transparent border-b border-border outline-none text-foreground/80 placeholder:text-muted-foreground/40 pb-0.5" />
          </form>
        ) : (
          <p className={`text-base truncate ${cluster.person_name ? 'font-medium text-foreground' : 'text-muted-foreground italic'}`}>
            {cluster.person_name || 'Unknown person'}
          </p>
        )}
      </div>

      {!isEditing && cluster.sample_faces && cluster.sample_faces.length > 0 && (
        <div className="flex items-center gap-0.5 shrink-0">
          {cluster.sample_faces.slice(0, 4).map(face => (
            <div key={face.face_id}>
              {sampleCrops[face.face_id] ? <img src={sampleCrops[face.face_id]} alt="" className={`w-6 h-6 rounded-full object-cover ${face.verified ? verifiedBorder : 'border border-border/40'}`} /> : <div className={`w-6 h-6 rounded-full bg-secondary ${face.verified ? verifiedBorder : ''}`} />}
            </div>
          ))}
        </div>
      )}

      {!isEditing && (
        <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0 w-[80px] text-right">
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
