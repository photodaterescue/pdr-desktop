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
  ArrowLeftRight,
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
import { SnapshotStatusBadge } from './SnapshotStatusBadge';
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
  unnamePersonAndDelete,
  restoreUnnamedPerson,
  type UnnameUndoToken,
  takeSnapshot,
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
  onPeopleDataChanged,
  type AiProgress,
} from '@/lib/electron-bridge';
import { useFixInProgress, FIX_BLOCKED_TOOLTIP } from '@/lib/fix-state';
import { FixStatusChip } from './FixStatusChip';

// ─── Notify main window that data changed ─────────────────────────────────
function notifyChange() {
  if ((window as any).pdr?.people?.notifyChange) {
    (window as any).pdr.people.notifyChange();
  }
}

// ─── Main People Manager (standalone page, not modal) ─────────────────────
export default function PeopleManager() {
  // True whenever ANY window has a Fix in flight. Drives the
  // disabled state on AI-engine-heavy actions (Recluster, Improve
  // Recognition, XMP import) so they can't compete with the Fix
  // for CPU + face_detections writes. Cross-window via the main
  // process broadcast, so PM reflects fix state even when the Fix
  // was kicked off from the main window.
  const fixActive = useFixInProgress();
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
  // Whenever the user switches tabs, drop any in-flight face selection
  // and the right-side action panel. Otherwise the panel keeps showing
  // the previous tab's selection — confusing, and worse, the verify
  // button would still act on faces that aren't visible anymore.
  useEffect(() => {
    setGlobalSelectedFaces(new Set());
    setGlobalReassignFaceId(null);
    setGlobalReassignName('');
    setGlobalReassignFullName('');
    setPanelSuggestionIdx(-1);
    setHoveredFaceId(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // confirmDiscard payload now also carries verifiedCount (drives the
  // ≥50 high-stakes typed-name gate) and sampleFaceCrops (the face
  // thumbnails shown in the modal as a visceral preview of what's
  // about to be unnamed).
  const [confirmDiscard, setConfirmDiscard] = useState<{ personId: number; personName: string; photoCount: number; verifiedCount: number; sampleFaceCrops: string[]; selectedFaceIds: number[] | null } | null>(null);
  const [confirmPermanentDelete, setConfirmPermanentDelete] = useState<{ personId: number; personName: string } | null>(null);
  const [pendingIgnore, setPendingIgnore] = useState<string | null>(null);
  const [pendingUnsure, setPendingUnsure] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem('pdr-pm-search') ?? '';
  });
  // Match strictness — 0.65 (Loose) to 0.95 (Strict). Same range
  // as S&D's slider so the two surfaces produce identical results
  // for any given threshold (both filter `face_detections` by
  // `verified=1 OR match_similarity >= threshold`). Default 0.72
  // is a reasonable middle ground.
  const [clusterThreshold, setClusterThreshold] = useState(0.72);
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
  // Direction of the chronological sort on Named rows. Default is
  // oldest-first (matches the backend's order). Newest-first
  // reverses the sample_faces array client-side at render time —
  // useful when the user wants recent photos prominently visible
  // without scrolling.
  const [namedSortNewestFirst, setNamedSortNewestFirst] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('pdr-pm-named-sort-newest') === 'true';
  });
  // "Matched" = auto-matched but unverified faces (assigned to a
  // person via Improve Recognition or initial clustering, but the
  // user hasn't clicked Verify yet). Default ON so users see what
  // needs attention; OFF hides them so the row reads cleanly as a
  // verified-only row.
  const [showMatched, setShowMatched] = useState(() => {
    if (typeof window === 'undefined') return true;
    const stored = localStorage.getItem('pdr-pm-show-matched');
    return stored == null ? true : stored === 'true';
  });
  useEffect(() => {
    try { localStorage.setItem('pdr-pm-search', searchFilter); } catch {}
  }, [searchFilter]);
  useEffect(() => {
    try { localStorage.setItem('pdr-pm-unverified-only', String(showUnverifiedOnly)); } catch {}
  }, [showUnverifiedOnly]);
  useEffect(() => {
    try { localStorage.setItem('pdr-pm-named-sort-newest', String(namedSortNewestFirst)); } catch {}
  }, [namedSortNewestFirst]);
  useEffect(() => {
    try { localStorage.setItem('pdr-pm-show-matched', String(showMatched)); } catch {}
  }, [showMatched]);

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
  // Optional full name captured when verifying / assigning faces — only
  // applied when creating a brand-new person, or filling in a missing
  // full_name on an existing person (upsertPerson uses COALESCE so
  // existing full names never get overwritten silently).
  const [globalReassignFullName, setGlobalReassignFullName] = useState('');
  const [panelSuggestionIdx, setPanelSuggestionIdx] = useState(-1);
  // Full-name disambiguation:
  //   • fullNameUserEdited — true once the user types in the Full name field,
  //     so we stop auto-filling on top of their input.
  //   • globalReassignPersonId — locked when the user picks a candidate from
  //     the disambiguation dropdown (multiple persons share the short name).
  //     Bypasses upsertPerson's name-only match so the right Terry wins.
  //   • fullNameCandidates — ranked list of persons sharing the typed short
  //     name, sorted by face similarity (highest first).
  const [fullNameUserEdited, setFullNameUserEdited] = useState(false);
  const [globalReassignPersonId, setGlobalReassignPersonId] = useState<number | null>(null);
  const [fullNameCandidates, setFullNameCandidates] = useState<{ person: PersonRecord; similarity: number | null }[]>([]);
  // Single hovered face across ALL cluster rows. Each per-face Tooltip
  // is controlled by this — guarantees only one enlarged preview is
  // ever visible, even if the user's cursor crosses overlapping
  // thumbnails before the previous tooltip's mouse-leave fires.
  const [hoveredFaceId, setHoveredFaceId] = useState<number | null>(null);
  // 20-second targeted-undo for row removal. The token returned by
  // unnamePersonAndDelete captures every face's prior verified
  // flag + the person record, so restoreUnnamedPerson rebuilds
  // the row exactly as it was. After the timer expires the undo
  // is gone — Settings → Backup is the deeper fallback.
  const [undoSnapshot, setUndoSnapshot] = useState<{
    token: UnnameUndoToken;
    personName: string;
    facesUnnamed: number;
    startedAt: number;
  } | null>(null);
  // Re-render every 250ms while the undo banner is showing so the
  // countdown ring + seconds-remaining label stay live.
  const [undoTick, setUndoTick] = useState(0);
  useEffect(() => {
    if (!undoSnapshot) return;
    const tick = () => setUndoTick(t => t + 1);
    const interval = setInterval(tick, 250);
    // Auto-dismiss at the 20-second mark.
    const expiry = setTimeout(() => setUndoSnapshot(null), 20_000);
    return () => { clearInterval(interval); clearTimeout(expiry); };
  }, [undoSnapshot?.startedAt]);
  // Suppress unused-var TS noise when we haven't ticked yet.
  void undoTick;
  // ── Full-name auto-fill + disambiguation ─────────────────────────
  // When the user types a short name in the verify panel, look up
  // matching persons. Behaviour:
  //   • 0 matches → leave full name blank (creating a new person).
  //   • 1 match  → auto-fill full name from that person (so user
  //     doesn't retype Colin Peter Clapson every time they verify
  //     a face into Colin's row). Only fills if the user hasn't
  //     manually typed in the field.
  //   • 2+ matches → blank the full name AND populate
  //     fullNameCandidates with similarity-ranked entries; UI
  //     renders a dropdown so the user picks the right Terry.
  // Visual similarity is fetched once per face via getVisualSuggestions
  // and used to sort the dropdown — the most-likely match floats up.
  useEffect(() => {
    // Reset edited flag when the verify panel closes.
    if (!globalReassignFaceId) {
      setFullNameUserEdited(false);
      setGlobalReassignPersonId(null);
      setFullNameCandidates([]);
      return;
    }
    // Resolve the effective short name (typed > implicit).
    const typed = globalReassignName.trim();
    let effectiveShort = typed;
    if (!effectiveShort) {
      const targets = Array.from(globalSelectedFaces);
      const targetClusters = targets.map(fid => clusters.find(c => c.sample_faces?.some(f => f.face_id === fid)));
      const allSameNamed = targetClusters.length > 0
        && targetClusters.every(c => c && c.person_name && !c.person_name.startsWith('__') && c.person_id === targetClusters[0]?.person_id);
      effectiveShort = allSameNamed ? (targetClusters[0]?.person_name || '') : '';
    }
    if (!effectiveShort) {
      setFullNameCandidates([]);
      setGlobalReassignPersonId(null);
      return;
    }
    const matches = existingPersons.filter(p =>
      p.name.toLowerCase() === effectiveShort.toLowerCase() && !p.name.startsWith('__')
    );
    if (matches.length === 0) {
      setFullNameCandidates([]);
      setGlobalReassignPersonId(null);
      return;
    }
    if (matches.length === 1) {
      setFullNameCandidates([]);
      setGlobalReassignPersonId(matches[0].id);
      // Auto-fill full name only if user hasn't edited the field.
      if (!fullNameUserEdited) {
        const fn = matches[0].full_name?.trim() || '';
        setGlobalReassignFullName(fn);
      }
      return;
    }
    // Multiple persons share the short name — disambiguate.
    if (!fullNameUserEdited) {
      setGlobalReassignFullName('');
    }
    setGlobalReassignPersonId(null);
    // Rank by visual similarity using the first selected face.
    const firstFaceId = Array.from(globalSelectedFaces)[0];
    if (firstFaceId == null) {
      setFullNameCandidates(matches.map(p => ({ person: p, similarity: null })));
      return;
    }
    let cancelled = false;
    getVisualSuggestions(firstFaceId).then(r => {
      if (cancelled) return;
      const simMap = new Map<number, number>();
      if (r.success && r.data) for (const s of r.data) simMap.set(s.personId, s.similarity);
      const ranked = matches
        .map(p => ({ person: p, similarity: simMap.get(p.id) ?? null }))
        .sort((a, b) => (b.similarity ?? -1) - (a.similarity ?? -1));
      setFullNameCandidates(ranked);
    }).catch(() => {
      if (!cancelled) setFullNameCandidates(matches.map(p => ({ person: p, similarity: null })));
    });
    return () => { cancelled = true; };
    // existingPersons reference is stable per load; clusters drives implicit
    // fallback when typed is blank.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalReassignFaceId, globalReassignName, existingPersons, globalSelectedFaces, fullNameUserEdited]);
  // Improve-recognition prompt — appears as a chip after a Verify
  // operation, offering one-click refinement for the just-verified
  // person (Vote D from the FR redesign discussion). Auto-fades
  // after 15s if the user doesn't click.
  const [improvePrompt, setImprovePrompt] = useState<{ personId: number; personName: string } | null>(null);
  const improveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-row improve in-flight tracker so the row's spinner shows on
  // the right button (and the global ribbon button stays idle if a
  // user kicks off a row-level improve).
  const [improvingPersonId, setImprovingPersonId] = useState<number | null>(null);
  // In-app result toast — replaces window.alert() AND replaces a
  // previous blocking modal that required an OK click. Auto-fades
  // after ~6s so users see results immediately without an extra
  // dismissal step. Errors stay until manually dismissed since they
  // typically need attention.
  const [resultModal, setResultModal] = useState<{ title: string; body: string; tone: 'success' | 'info' | 'error' } | null>(null);
  const resultModalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Wrapper that auto-fades success/info toasts after 6s; errors
  // require manual dismissal.
  const showResult = useCallback((r: { title: string; body: string; tone: 'success' | 'info' | 'error' }) => {
    if (resultModalTimerRef.current) clearTimeout(resultModalTimerRef.current);
    setResultModal(r);
    if (r.tone !== 'error') {
      resultModalTimerRef.current = setTimeout(() => setResultModal(null), 6_000);
    }
  }, []);

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

  // Subscribe to the cross-window "people data changed" tick. The
  // main window's Settings → People → Re-cluster fires this once
  // immediately and again 5 seconds later (settle pause), so PM
  // reloads its row counts WITHOUT the user having to click the
  // header Refresh button. Same channel that SearchPanel uses, just
  // wired to loadClusters instead of executeSearch. The handler
  // ref pattern isn't needed here because loadClusters is a stable
  // closure over component state — it always reads the latest DB.
  useEffect(() => {
    const unsubscribe = onPeopleDataChanged(() => {
      // Fire and forget — loadClusters manages its own loading state.
      loadClusters();
    });
    return unsubscribe;
  }, []);

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

  // PM-side row removal — sends every face back to Unnamed
  // (verified flag cleared) and deletes the person record. Single
  // bulk SQL transaction in the backend (`unnamePersonAndDelete`).
  // Returns an undoToken that the 20s Undo banner uses to fully
  // reverse the action via `restoreUnnamedPerson`.
  const handleDiscardPerson = async (personId: number) => {
    const target = clusters.find(c => c.person_id === personId);
    const personName = target?.person_name ?? '';
    // Pre-event auto-snapshot — non-blocking insurance even beyond
    // the 20s Undo window. Settings → Backup will show this with
    // the label "Before sending {name} to Unnamed" so the user
    // knows what it's for if they need to roll back later.
    void takeSnapshot('auto-event', `Before sending ${personName} to Unnamed`);
    const r = await unnamePersonAndDelete(personId);
    setConfirmDiscard(null);
    await loadClusters();
    notifyChange();
    if (r.success && r.data) {
      // Show the 20-second Undo banner with countdown. Stores the
      // undo token in state so clicking Undo can call
      // restoreUnnamedPerson(token) — exact reversal, all face
      // verified flags + person record + tree focus references
      // restored to the snapshot taken inside the IPC handler.
      if (r.data.undoToken) {
        setUndoSnapshot({
          token: r.data.undoToken,
          personName,
          facesUnnamed: r.data.facesUnnamed,
          startedAt: Date.now(),
        });
      }
    }
  };

  const handleUndoUnname = async () => {
    if (!undoSnapshot) return;
    const r = await restoreUnnamedPerson(undoSnapshot.token);
    setUndoSnapshot(null);
    if (r.success) {
      await loadClusters();
      notifyChange();
      showResult({
        title: `${undoSnapshot.personName} restored`,
        body: `${r.data?.facesRestored ?? 0} face${(r.data?.facesRestored ?? 0) === 1 ? ' is' : 's are'} back under ${undoSnapshot.personName}, with their previous verified status intact.`,
        tone: 'success',
      });
    } else {
      showResult({ title: 'Undo failed', body: r.error || 'Unknown error.', tone: 'error' });
    }
  };

  // Run Improve Facial Recognition for a SINGLE person. Used by the
  // per-row sparkle button and the post-verify chip prompt.
  const handleImproveOne = async (personId: number, personName: string) => {
    setImprovingPersonId(personId);
    // Pre-event snapshot — Improve assigns possibly many faces to
    // this person and there's no per-face undo. The auto-event
    // snapshot lets the user roll back later via Settings → Backup
    // if a single bad match poisons the row.
    void takeSnapshot('auto-event', `Before Improve Recognition · ${personName}`);
    try {
      const result = await refineFromVerified(clusterThreshold, personId);
      if (result.success && result.data) {
        await loadClusters();
        notifyChange();
        const matched = result.data.newMatches;
        if (matched > 0) {
          showResult({
            title: `Recognition improved for ${personName}`,
            body: `${matched} new face${matched === 1 ? '' : 's'} matched and added. They appear under ${personName} as unverified — review them and click each to verify, or run Improve again after a few more verifies to find more.`,
            tone: 'success',
          });
        } else {
          showResult({
            title: `No new matches for ${personName}`,
            body: `Verify a few more faces and try again — the more verified examples, the better the matching.`,
            tone: 'info',
          });
        }
      } else {
        showResult({ title: 'Improve failed', body: result.error || 'Unknown error.', tone: 'error' });
      }
    } finally {
      setImprovingPersonId(null);
    }
  };

  // Selection-aware trash branch — unlink JUST the selected faces from
  // the person (sends them to Unnamed) without touching the rest of
  // the row. The full person remains Named with their other photos.
  const handleUnlinkSelectedFaces = async (faceIds: number[]) => {
    for (const id of faceIds) await unnameFace(id);
    setConfirmDiscard(null);
    setGlobalSelectedFaces(new Set());
    await loadClusters(); notifyChange();
  };

  // Per-row "Verify N" pill — happy-path one-click verify of the
  // selected faces AS the row's person. Shortcuts the right-side
  // verify panel entirely so users don't have to hunt for the
  // (correct) action that's already implicit in the selection.
  // The reassign call uses verified=true and the cluster's existing
  // person_name; namePerson is a no-op insert on existing names so
  // the COALESCE on full_name doesn't disturb anything.
  const handleVerifySelectedFaces = async (faceIds: number[], personName: string) => {
    for (let i = 0; i < faceIds.length; i++) {
      const isLast = i === faceIds.length - 1;
      await handleReassignFace(faceIds[i], personName, true, !isLast);
    }
    setGlobalSelectedFaces(new Set());
    setGlobalReassignFaceId(null);
    setGlobalReassignName('');
    setGlobalReassignFullName('');
  };

  // Slider release on the Match slider — auto-runs Improve at the
  // new threshold so the user sees the slider WORK end-to-end without
  // pressing extra buttons. Improve is non-destructive (only adds
  // unnamed→person matches above threshold, never unlinks). Combined
  // with the live filter on drag, sliding Strict hides low-similarity
  // matches and sliding Loose reveals new ones at the new threshold.
  // Re-clustering (the destructive operation) stays on the explicit
  // Refresh button per Terry's earlier preference.
  const sliderImproveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSliderRelease = async () => {
    if (sliderImproveTimerRef.current) clearTimeout(sliderImproveTimerRef.current);
    sliderImproveTimerRef.current = setTimeout(async () => {
      // Background-Improve indicator reuses isRefining so the
      // existing UI hint surfaces. Silent: no result modal — user
      // sees the rows update directly.
      setIsRefining(true);
      try {
        await refineFromVerified(clusterThreshold);
        await loadClusters();
        notifyChange();
      } finally {
        setIsRefining(false);
      }
    }, 200);
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

  const handleReassignFace = async (faceId: number, newName: string, verified: boolean = true, skipReload: boolean = false, newFullName?: string | null, targetPersonId?: number | null) => {
    if (newName === '__unnamed__') {
      await unnameFace(faceId);
      if (!skipReload) { await loadClusters(); notifyChange(); }
      return;
    }
    // When the caller resolved a specific personId (e.g. user picked
    // a candidate from the disambiguation dropdown when two persons
    // share the same short name), bypass namePerson — upsertPerson
    // matches on `name` only and would otherwise return the FIRST
    // Terry, not necessarily the right one. assignFace + the picked
    // id is the only safe path. We still want any newFullName to land
    // on the picked person, so apply it via renamePerson when needed.
    let personId: number | undefined;
    if (targetPersonId != null) {
      personId = targetPersonId;
      if (newFullName !== undefined && newFullName !== null && newFullName.trim() !== '') {
        // COALESCE-style: only fills when target's full_name is blank.
        const target = (existingPersons || []).find(p => p.id === targetPersonId);
        if (target && (!target.full_name || target.full_name.trim() === '')) {
          try { await renamePerson(targetPersonId, newName, newFullName); } catch { /* non-fatal */ }
        }
      }
    } else {
      // newFullName is forwarded to namePerson → upsertPerson, which uses
      // COALESCE so existing full_names are never overwritten by an empty
      // verify panel. Safe for both new-person and existing-person flows.
      const personResult = await namePerson(newName, undefined, undefined, newFullName);
      if (personResult.success && personResult.data?.personId) personId = personResult.data.personId;
    }
    if (personId) {
      await assignFace(faceId, personId, verified);
      // Improve-recognition chip prompt — Vote D from the FR redesign.
      // Fires only when this was the LAST face in a batch (skipReload
      // is false on the final iteration), avoiding chip-spam during
      // multi-face Verify. Only shown for real-named persons (not the
      // internal __unsure__/__ignored__ markers) and only when the
      // assignment was an actual verify (not an unname/unsure/ignore).
      if (!skipReload && verified && !newName.startsWith('__')) {
        if (improveTimerRef.current) clearTimeout(improveTimerRef.current);
        setImprovePrompt({ personId, personName: newName });
        improveTimerRef.current = setTimeout(() => setImprovePrompt(null), 15_000);
      }
      if (!skipReload) { await loadClusters(); notifyChange(); }
    }
  };

  const handleSetRepresentative = async (personId: number, faceId: number) => {
    await setRepresentativeFace(personId, faceId);
    await loadClusters(); notifyChange();
  };

  // Memoised so each tab's cluster list is a stable reference across
  // unrelated re-renders (hover state, modal toggles, etc). Without
  // these, every render produced new `clusters.filter(...)` arrays,
  // which propagated through the downstream useMemo dep chain and
  // forced every PersonCardRow to re-render on every hover. Major
  // hit on Unnamed where there can be 100+ clusters.
  const namedClusters = useMemo(
    () => clusters.filter(c => c.person_name && c.person_name !== '__ignored__' && c.person_name !== '__unsure__'),
    [clusters],
  );
  const unnamedClustersRaw = useMemo(() => clusters.filter(c => !c.person_name), [clusters]);
  const ignoredClusters = useMemo(() => clusters.filter(c => c.person_name === '__ignored__'), [clusters]);
  const unsureClusters = useMemo(() => clusters.filter(c => c.person_name === '__unsure__'), [clusters]);

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
    let faces = cluster.sample_faces;
    const isRealNamed = cluster.person_id && cluster.person_name && !cluster.person_name.startsWith('__');
    // Match-strictness filter — same algorithm as S&D's slider.
    // Verified faces (verified=1) always show. Auto-matched faces
    // show only if their stored match_similarity >= the slider's
    // threshold. NULL match_similarity is treated as bypass so
    // pre-backfill legacy auto-matches stay visible (they get
    // scored on next launch anyway).
    if (isRealNamed) {
      faces = faces.filter(f => {
        if (f.verified) return true;
        const sim = (f as any).match_similarity;
        if (sim == null) return true;
        return sim >= clusterThreshold;
      });
    }
    if (isRealNamed) {
      // Two-phase ordering on real Named rows:
      //   1. Backend already returns chronological ASC for these.
      //   2. We split into matched (unverified) + verified groups.
      //      Matched stays at the FRONT regardless of sort direction
      //      so the "what needs my attention" set is always the
      //      first thing the user sees. JS Array.sort is stable so
      //      chronological order WITHIN each group is preserved.
      //   3. If user toggled newest-first, reverse each group
      //      independently (whole-array reverse would push matched
      //      to the back, which the user explicitly doesn't want).
      const matched = faces.filter(f => !f.verified);
      const verified = faces.filter(f => f.verified);
      const m = namedSortNewestFirst ? [...matched].reverse() : matched;
      const v = namedSortNewestFirst ? [...verified].reverse() : verified;
      faces = [...m, ...v];
    }
    // Filters apply on top of ordering. showMatched=false hides the
    // unverified faces; showUnverifiedOnly=true hides the verified
    // ones. Both can technically be set, in which case nothing
    // shows — that's user input, we don't second-guess it.
    if (!showMatched) faces = faces.filter(f => f.verified);
    if (showUnverifiedOnly) faces = faces.filter(f => !f.verified);
    return { ...cluster, sample_faces: faces };
  };

  // Memoised so prepareFaces doesn't re-run on every render. Without
  // this, hovering a face thumbnail (which flips globalHoveredFaceId
  // state) re-runs prepareFaces across ALL clusters every time —
  // noticeably sluggish on Unnamed where there can be 100+ clusters.
  const filteredNamed = useMemo(() => (searchFilter
    ? namedClusters.filter(c => c.person_name?.toLowerCase().includes(searchFilter.toLowerCase()))
    : namedClusters
  ).map(prepareFaces),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [namedClusters, searchFilter, showUnverifiedOnly, showMatched, namedSortNewestFirst, clusterThreshold]);

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
      {/* Custom-frame spacer — matches the 32px lavender title bar
          that Electron paints over the top of the content via
          titleBarOverlay. Marked WebkitAppRegion:'drag' so users
          can drag the window from the bar (consistent with main
          PDR). The OS-rendered window controls live at the right
          edge of this region; their hit area is automatically
          excluded from drag by Electron. */}
      <div
        className="shrink-0 bg-primary"
        style={{ height: 32, WebkitAppRegion: 'drag' } as React.CSSProperties}
      />
      <MainAliveBanner />

      {/* Cross-window Fix status chip — passive (no Open button)
          because PM can't restore the main window's modal. Lives
          inside the title bar (top-1.5) for consistency with the
          main PDR window. */}
      <FixStatusChip />

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
              <TooltipContent side="bottom">Refresh — reload from the database</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* Improve Facial Recognition button — Named tab only.
              Removed the Settings → AI gate per Topic-1/3 redesign:
              the button now runs immediately on click. The "Only
              activate after you're sure all people have the correct
              photos verified" tooltip was actively misleading users
              (the algorithm only needs 1 verified face per named
              person; auto-matches are excluded from training, so it
              can never poison itself). */}
          {activeTab === 'named' && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={async () => {
                    if (fixActive) return;
                    setIsRefining(true);
                    // Pre-event snapshot — global Improve runs across
                    // every named person; rollback insurance for the
                    // user if any single match drifts off-target.
                    void takeSnapshot('auto-event', 'Before Improve Recognition (all named)');
                    try {
                      const result = await refineFromVerified(clusterThreshold);
                      if (result.success && result.data) {
                        await loadClusters();
                        notifyChange();
                        showResult({
                          title: 'Recognition improved',
                          body: `${result.data.newMatches} new face${result.data.newMatches === 1 ? '' : 's'} matched across ${result.data.personsProcessed} ${result.data.personsProcessed === 1 ? 'person' : 'people'}. New matches appear unverified under their assigned person — review and verify them to keep refining accuracy.`,
                          tone: 'success',
                        });
                      } else {
                        showResult({ title: 'Refinement failed', body: result.error || 'Unknown error.', tone: 'error' });
                      }
                    } finally {
                      setIsRefining(false);
                    }
                  }}
                  disabled={isRefining || fixActive}
                  data-pdr-variant="caution"
                  className={`ml-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${isRefining || fixActive ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                  style={{ backgroundColor: '#fde68a', borderColor: '#f59e0b', color: '#78350f', borderWidth: '1px', borderStyle: 'solid' }}
                >
                  {isRefining ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Improving...</>
                  ) : (
                    <><Sparkles className="w-3.5 h-3.5" /> Improve Facial Recognition</>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[320px]">
                {fixActive
                  ? FIX_BLOCKED_TOOLTIP + ' — this competes with the Fix for CPU and face data writes.'
                  : 'Uses your verified faces (1+ per named person) to auto-assign matching unnamed faces. Re-run any time you verify more — auto-matches are excluded from training so they can\'t poison results.'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          )}

          {/* Import from Lightroom XMP sidecars — HIDDEN for v2.
              Per Terry's request, this lands as an incremental
              update. The button, IPC, bridge, parser, and importer
              code all stay in place — flip the `false &&` below to
              `activeTab === 'named' &&` to re-enable. Also
              outstanding before re-enable: dedup against existing
              persons by full_name (current code creates duplicates
              when LR has "Terry Clapson" and PDR has "Terry"). */}
          {false && (
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
                        showResult({
                          title: 'Lightroom XMP import complete',
                          body: `${d.filesScanned} file${d.filesScanned === 1 ? '' : 's'} scanned\n${d.sidecarsFound} sidecar${d.sidecarsFound === 1 ? '' : 's'} found\n${d.facesImported} face${d.facesImported === 1 ? '' : 's'} imported across ${d.personsCreated} ${d.personsCreated === 1 ? 'person' : 'people'}\n${d.filesSkipped} file${d.filesSkipped === 1 ? '' : 's'} skipped (already had face data)`,
                          tone: 'success',
                        });
                      } else {
                        showResult({ title: 'XMP import failed', body: result.error || 'Unknown error.', tone: 'error' });
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
          )}

          {/* Snapshot status badge — shared component used in PM,
              S&D, and Trees. Click → Settings → Backup tab. */}
          <SnapshotStatusBadge />
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
                min="0.65"
                max="0.95"
                step="0.01"
                value={clusterThreshold}
                onChange={(e) => {
                  // Slider drag = pure filter. Updates threshold
                  // state so prepareFaces re-filters the visible
                  // thumbnails against `match_similarity`. No
                  // backend call — feels instant.
                  const v = parseFloat(e.target.value);
                  setClusterThreshold(v);
                }}
                onMouseUp={() => { void setSetting('matchThreshold', clusterThreshold); void handleSliderRelease(); }}
                onTouchEnd={() => { void setSetting('matchThreshold', clusterThreshold); void handleSliderRelease(); }}
                className="w-full h-1 accent-purple-500 cursor-pointer relative z-10"
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
          <p className="text-[10px] text-muted-foreground/85 mt-1 text-center leading-tight">
            Loose includes more auto-matches in each row. Strict only counts the most-similar matches.
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
                className="pl-8 pr-3 py-1 text-sm rounded-md border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground/70 w-[120px] focus:outline-none focus:ring-1 focus:ring-purple-400/50"
              />
              {searchFilter && (
                <button onClick={() => setSearchFilter('')} className="absolute right-2 top-1/2 -translate-y-1/2">
                  <X className="w-3 h-3 text-muted-foreground hover:text-foreground" />
                </button>
              )}
            </div>
          )}
          {activeTab === 'named' && (
            <IconTooltip label={showUnverifiedOnly ? 'Showing unverified only — click to show all' : 'Showing all — click to show only unverified'} side="bottom">
              <button
                onClick={() => setShowUnverifiedOnly(!showUnverifiedOnly)}
                className={`px-1.5 py-1 rounded transition-all border ${showUnverifiedOnly ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-500 border-orange-300/60' : 'text-muted-foreground hover:text-foreground border-border/70 hover:border-purple-400/40'}`}
              >
                <Eye className="w-3.5 h-3.5" />
              </button>
            </IconTooltip>
          )}
          {/* Show / hide matched (auto-matched but unverified) faces.
              Default ON so the "what needs my attention" set is
              visible; OFF lets users see only verified faces for a
              clean, finished view of a row. Sparkles icon mirrors
              the Improve Recognition icon so the visual language
              connects "matched" with "AI-assigned, awaiting verify". */}
          {activeTab === 'named' && (
            <IconTooltip label={showMatched ? 'Showing matched (auto-assigned, unverified) faces — click to hide' : 'Hiding matched faces — click to show' } side="bottom">
              <button
                onClick={() => setShowMatched(v => !v)}
                className={`px-1.5 py-1 rounded transition-all border ${showMatched ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-500 border-purple-300/60' : 'text-muted-foreground hover:text-foreground border-border/70 hover:border-purple-400/40'}`}
              >
                <Sparkles className="w-3.5 h-3.5" />
              </button>
            </IconTooltip>
          )}
          {/* Sort direction toggle — Named tab only. Backend always
              returns oldest-first; we reverse client-side when the
              user wants newest first. Left↔right arrows match the
              spatial mental model (the strip orders left to right
              in time). Outline matches the other toolbar toggles
              so the button doesn't blend into the background. */}
          {activeTab === 'named' && (
            <IconTooltip label={namedSortNewestFirst ? 'Newest left, oldest right — click to flip' : 'Oldest left, newest right — click to flip'} side="bottom">
              <button
                onClick={() => setNamedSortNewestFirst(v => !v)}
                className={`px-1.5 py-1 rounded transition-all border flex items-center gap-1 ${namedSortNewestFirst ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-500 border-purple-300/60' : 'text-muted-foreground hover:text-foreground border-border/70 hover:border-purple-400/40'}`}
              >
                <ArrowLeftRight className="w-3.5 h-3.5" />
                <span className="text-[10px] font-semibold tabular-nums">{namedSortNewestFirst ? 'NEW' : 'OLD'}</span>
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
            {/* Discard / Remove-Selected modal — centered, blocking,
                with a typed-name confirmation gate for the whole-row
                path so a stray click can't undo verification work.
                Selected-faces path stays simpler (the work that's at
                risk is bounded — just the N selected). */}
            {confirmDiscard && (
              <DiscardConfirmModal
                personName={confirmDiscard.personName}
                photoCount={confirmDiscard.photoCount}
                verifiedCount={confirmDiscard.verifiedCount}
                sampleFaceCrops={confirmDiscard.sampleFaceCrops}
                selectedFaceIds={confirmDiscard.selectedFaceIds}
                onCancel={() => setConfirmDiscard(null)}
                onConfirm={() => {
                  if (confirmDiscard.selectedFaceIds && confirmDiscard.selectedFaceIds.length > 0) {
                    handleUnlinkSelectedFaces(confirmDiscard.selectedFaceIds);
                  } else {
                    handleDiscardPerson(confirmDiscard.personId);
                  }
                }}
              />
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
                        onDiscard={cluster.person_id ? () => {
                          // Trash button is now always whole-row — sends
                          // every face back to Unnamed. The "Remove N
                          // selected" path moved to a separate amber
                          // pill so the icon's action is unambiguous.
                          const verified = (cluster.sample_faces ?? []).filter(f => f.verified).length;
                          const crops = (cluster.sample_faces ?? []).map(f => faceCropsMap[f.face_id]).filter(Boolean).slice(0, 10);
                          setConfirmDiscard({
                            personId: cluster.person_id!,
                            personName: cluster.person_name!,
                            photoCount: cluster.photo_count,
                            verifiedCount: verified,
                            sampleFaceCrops: crops,
                            selectedFaceIds: null,
                          });
                        } : undefined}
                        onVerifySelected={cluster.person_id && cluster.person_name && !cluster.person_name.startsWith('__') ? (faceIds) => handleVerifySelectedFaces(faceIds, cluster.person_name!) : undefined}
                        onRemoveSelected={cluster.person_id ? (faceIds) => {
                          // Selected-faces path: thumbnails for ONLY the
                          // selected faces give a precise visual preview.
                          const idSet = new Set(faceIds);
                          const crops = (cluster.sample_faces ?? []).filter(f => idSet.has(f.face_id)).map(f => faceCropsMap[f.face_id]).filter(Boolean).slice(0, 10);
                          const verified = (cluster.sample_faces ?? []).filter(f => idSet.has(f.face_id) && f.verified).length;
                          setConfirmDiscard({
                            personId: cluster.person_id!,
                            personName: cluster.person_name!,
                            photoCount: cluster.photo_count,
                            verifiedCount: verified,
                            sampleFaceCrops: crops,
                            selectedFaceIds: faceIds,
                          });
                        } : undefined}
                        onReassignFace={handleReassignFace}
                        onSetRepresentative={cluster.person_id ? (faceId) => handleSetRepresentative(cluster.person_id!, faceId) : undefined}
                        globalSelectedFaces={globalSelectedFaces}
                        onGlobalSelectionChange={setGlobalSelectedFaces}
                        globalReassignFaceId={globalReassignFaceId}
                        onGlobalReassignChange={(id, name) => { setGlobalReassignFaceId(id); setGlobalReassignName(name); }}
                        globalReassignName={globalReassignName}
                        onGlobalReassignNameChange={setGlobalReassignName}
                        globalHoveredFaceId={hoveredFaceId}
                        onHoveredFaceChange={setHoveredFaceId}
                        onImproveOne={cluster.person_id && cluster.person_name ? () => handleImproveOne(cluster.person_id!, cluster.person_name!) : undefined}
                        isImprovingOne={improvingPersonId === cluster.person_id}
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
                        onDiscard={cluster.person_id ? () => {
                          // Trash button is now always whole-row — sends
                          // every face back to Unnamed. The "Remove N
                          // selected" path moved to a separate amber
                          // pill so the icon's action is unambiguous.
                          const verified = (cluster.sample_faces ?? []).filter(f => f.verified).length;
                          const crops = (cluster.sample_faces ?? []).map(f => faceCropsMap[f.face_id]).filter(Boolean).slice(0, 10);
                          setConfirmDiscard({
                            personId: cluster.person_id!,
                            personName: cluster.person_name!,
                            photoCount: cluster.photo_count,
                            verifiedCount: verified,
                            sampleFaceCrops: crops,
                            selectedFaceIds: null,
                          });
                        } : undefined}
                        onVerifySelected={cluster.person_id && cluster.person_name && !cluster.person_name.startsWith('__') ? (faceIds) => handleVerifySelectedFaces(faceIds, cluster.person_name!) : undefined}
                        onRemoveSelected={cluster.person_id ? (faceIds) => {
                          // Selected-faces path: thumbnails for ONLY the
                          // selected faces give a precise visual preview.
                          const idSet = new Set(faceIds);
                          const crops = (cluster.sample_faces ?? []).filter(f => idSet.has(f.face_id)).map(f => faceCropsMap[f.face_id]).filter(Boolean).slice(0, 10);
                          const verified = (cluster.sample_faces ?? []).filter(f => idSet.has(f.face_id) && f.verified).length;
                          setConfirmDiscard({
                            personId: cluster.person_id!,
                            personName: cluster.person_name!,
                            photoCount: cluster.photo_count,
                            verifiedCount: verified,
                            sampleFaceCrops: crops,
                            selectedFaceIds: faceIds,
                          });
                        } : undefined}
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
                        Click face thumbnails to select them, then assign to an existing person (or create a new one) using the panel on the right. Don't recognise someone? Mark <strong>Unsure</strong> to revisit later, or <strong>Ignore</strong> to hide them permanently.
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
                            <IconTooltip label="Drag to reorder" side="left">
                              <div
                                draggable
                                onDragStart={(e) => handleClusterDragStart(e, ck)}
                                onDragEnd={handleClusterDragEnd}
                                className="absolute left-0 top-0 bottom-0 -translate-x-2 w-5 flex items-center justify-center cursor-grab active:cursor-grabbing transition-colors text-muted-foreground/60 hover:text-purple-500 hover:bg-purple-50 dark:hover:bg-purple-950/30 rounded-l-md z-10"
                              >
                                <svg width="12" height="20" viewBox="0 0 12 20" fill="currentColor">
                                  <circle cx="3.5" cy="4" r="1.4" /><circle cx="8.5" cy="4" r="1.4" />
                                  <circle cx="3.5" cy="10" r="1.4" /><circle cx="8.5" cy="10" r="1.4" />
                                  <circle cx="3.5" cy="16" r="1.4" /><circle cx="8.5" cy="16" r="1.4" />
                                </svg>
                              </div>
                            </IconTooltip>
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
                        globalHoveredFaceId={hoveredFaceId}
                        onHoveredFaceChange={setHoveredFaceId}
                        onImproveOne={cluster.person_id && cluster.person_name ? () => handleImproveOne(cluster.person_id!, cluster.person_name!) : undefined}
                        isImprovingOne={improvingPersonId === cluster.person_id}
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
                            <IconTooltip label="Drag to reorder" side="left">
                              <div
                                draggable
                                onDragStart={(e) => handleClusterDragStart(e, ck)}
                                onDragEnd={handleClusterDragEnd}
                                className="absolute left-0 top-0 bottom-0 -translate-x-2 w-5 flex items-center justify-center cursor-grab active:cursor-grabbing transition-colors text-muted-foreground/60 hover:text-purple-500 hover:bg-purple-50 dark:hover:bg-purple-950/30 rounded-l z-10"
                              >
                                <svg width="12" height="18" viewBox="0 0 12 18" fill="currentColor">
                                  <circle cx="3.5" cy="4" r="1.4" /><circle cx="8.5" cy="4" r="1.4" />
                                  <circle cx="3.5" cy="9" r="1.4" /><circle cx="8.5" cy="9" r="1.4" />
                                  <circle cx="3.5" cy="14" r="1.4" /><circle cx="8.5" cy="14" r="1.4" />
                                </svg>
                              </div>
                            </IconTooltip>
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
                        globalHoveredFaceId={hoveredFaceId}
                        onHoveredFaceChange={setHoveredFaceId}
                        onImproveOne={cluster.person_id && cluster.person_name ? () => handleImproveOne(cluster.person_id!, cluster.person_name!) : undefined}
                        isImprovingOne={improvingPersonId === cluster.person_id}
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
                        globalHoveredFaceId={hoveredFaceId}
                        onHoveredFaceChange={setHoveredFaceId}
                        onImproveOne={cluster.person_id && cluster.person_name ? () => handleImproveOne(cluster.person_id!, cluster.person_name!) : undefined}
                        isImprovingOne={improvingPersonId === cluster.person_id}
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

      {/* ── Side panel — fixed action modal for face assignment ──
          When the user has selected ≥1 face, we pulse the panel's
          left border so the eye is drawn to the right-hand CTA. The
          panel is otherwise easy to overlook on a wide screen. */}
      {globalReassignFaceId !== null && (
        <div className={`w-[280px] shrink-0 border-l bg-background p-4 overflow-y-auto transition-colors ${
          globalSelectedFaces.size > 0
            ? 'border-l-2 border-purple-400/70 shadow-[inset_4px_0_0_0_rgba(168,85,247,0.25)] animate-pulse-soft'
            : 'border-border'
        }`}>
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
            {(() => {
              // Compute implicit name HERE so both the prompt copy
              // and the input placeholder can show "Verify as Mel"
              // without the user having to type. Same logic as the
              // Verify-button effectiveName fallback further down.
              const targets = Array.from(globalSelectedFaces);
              const targetClusters = targets.map(fid => clusters.find(c => c.sample_faces?.some(f => f.face_id === fid)));
              const allSameNamedCluster = targetClusters.length > 0
                && targetClusters.every(c => c && c.person_name && !c.person_name.startsWith('__') && c.person_id === targetClusters[0]?.person_id);
              const panelImplicitName = allSameNamedCluster ? (targetClusters[0]?.person_name || '') : '';
              return (
                <>
                  {globalSelectedFaces.size <= 1 && (
                    <p className="text-sm text-muted-foreground text-center">
                      {panelImplicitName ? <>Verify as <strong className="text-foreground">{panelImplicitName}</strong>?</> : 'Choose an action for this face'}
                    </p>
                  )}
                  {globalSelectedFaces.size > 1 && panelImplicitName && (
                    <p className="text-xs text-muted-foreground/85 text-center -mt-0.5">
                      All from <strong className="text-foreground">{panelImplicitName}</strong>'s row
                    </p>
                  )}
                </>
              );
            })()}
            <div className="relative">
              {(() => {
                const typed = globalReassignName.trim().toLowerCase();
                // Recompute panelImplicitName here too — IIFE scope
                // doesn't share with the block above.
                const panelTargets = Array.from(globalSelectedFaces);
                const panelTargetClusters = panelTargets.map(fid => clusters.find(c => c.sample_faces?.some(f => f.face_id === fid)));
                const panelAllSameNamed = panelTargetClusters.length > 0
                  && panelTargetClusters.every(c => c && c.person_name && !c.person_name.startsWith('__') && c.person_id === panelTargetClusters[0]?.person_id);
                const panelImplicitName = panelAllSameNamed ? (panelTargetClusters[0]?.person_name || '') : '';
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
                      onChange={(e) => {
                        setGlobalReassignName(e.target.value);
                        setPanelSuggestionIdx(-1);
                        // Short name changed → resume auto-fill of full
                        // name (user hasn't yet locked it in for this
                        // new candidate).
                        setFullNameUserEdited(false);
                      }}
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
                          // Empty full name → null (don't pass empty
                          // string through; namePerson treats null as
                          // "leave alone" for existing persons).
                          const fullToUse = globalReassignFullName.trim() ? globalReassignFullName.trim() : null;
                          const lockedPersonId = globalReassignPersonId;
                          (async () => {
                            for (let i = 0; i < targets.length; i++) {
                              const isLast = i === targets.length - 1;
                              await handleReassignFace(targets[i], nameToUse, true, !isLast, fullToUse, lockedPersonId);
                            }
                            setGlobalReassignFaceId(null);
                            setGlobalReassignName(''); setGlobalReassignFullName('');
                            setGlobalSelectedFaces(new Set());
                            setPanelSuggestionIdx(-1);
                          })();
                        } else if (e.key === 'Escape') {
                          setGlobalReassignFaceId(null);
                          setGlobalReassignName(''); setGlobalReassignFullName('');
                          setGlobalSelectedFaces(new Set());
                          setPanelSuggestionIdx(-1);
                        }
                      }}
                      placeholder={panelImplicitName ? `Verify as ${panelImplicitName}` : 'Type person name...'}
                      className="w-full text-base px-2.5 py-1.5 rounded-lg border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-purple-400/50"
                      autoFocus
                      spellCheck={false}
                      autoCorrect="off"
                      autoCapitalize="words"
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
            {/* Optional full-name input — only fills in when creating a
                new person or when the existing person has no full_name
                yet (upsertPerson uses COALESCE). Leaving blank is the
                normal case when assigning faces to an existing person. */}
            {(() => {
              // Resolve the implicit FULL name the same way we resolved
              // the short name above — from the cluster that owns all
              // selected faces. Surfacing it as the placeholder removes
              // any ambiguity about who's about to be verified.
              //
              // BUT: once the user types a SHORT name that diverges
              // from the implicit cluster's name, the implicit
              // attribution is broken — they're explicitly assigning
              // these faces to a different person. Drop the implicit
              // full-name placeholder in that case so it doesn't
              // mislead them into thinking the wrong full name will
              // be saved.
              const fullTargets = Array.from(globalSelectedFaces);
              const fullTargetClusters = fullTargets.map(fid => clusters.find(c => c.sample_faces?.some(f => f.face_id === fid)));
              const fullAllSameNamed = fullTargetClusters.length > 0
                && fullTargetClusters.every(c => c && c.person_name && !c.person_name.startsWith('__') && c.person_id === fullTargetClusters[0]?.person_id);
              const implicitShortName = fullAllSameNamed ? (fullTargetClusters[0]?.person_name || '') : '';
              const implicitFullName = fullAllSameNamed ? (fullTargetClusters[0]?.person_full_name || '') : '';
              const typedShort = globalReassignName.trim();
              const userDiverged = typedShort.length > 0 && typedShort.toLowerCase() !== implicitShortName.toLowerCase();
              const fullPlaceholder = (!userDiverged && implicitFullName) ? implicitFullName : 'Full name — optional';
              return (
            <div className="relative">
            <input
              type="text"
              value={globalReassignFullName}
              onChange={(e) => { setGlobalReassignFullName(e.target.value); setFullNameUserEdited(true); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const nameToUse = globalReassignName.trim();
                  if (!nameToUse) return;
                  const targets = Array.from(globalSelectedFaces);
                  if (targets.length === 0) return;
                  const fullToUse = globalReassignFullName.trim() ? globalReassignFullName.trim() : null;
                  const lockedPersonId = globalReassignPersonId;
                  (async () => {
                    for (let i = 0; i < targets.length; i++) {
                      const isLast = i === targets.length - 1;
                      await handleReassignFace(targets[i], nameToUse, true, !isLast, fullToUse, lockedPersonId);
                    }
                    setGlobalReassignFaceId(null);
                    setGlobalReassignName(''); setGlobalReassignFullName('');
                    setGlobalSelectedFaces(new Set());
                  })();
                } else if (e.key === 'Escape') {
                  setGlobalReassignFaceId(null);
                  setGlobalReassignName(''); setGlobalReassignFullName('');
                  setGlobalSelectedFaces(new Set());
                }
              }}
              placeholder={fullPlaceholder}
              className="w-full text-sm px-2.5 py-1.5 rounded-lg border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-purple-400/50"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="words"
            />
            {/* Disambiguation dropdown — shown when 2+ persons share
                the typed short name. Sorted by face similarity so the
                most-likely candidate is at the top. Picking one locks
                globalReassignPersonId so handleReassignFace targets
                the right person even though the short name is
                ambiguous. */}
            {fullNameCandidates.length > 1 && (
              <div className="mt-1 rounded-lg border border-amber-300/60 bg-amber-50/40 dark:bg-amber-950/20 overflow-hidden">
                <div className="px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400/85 border-b border-amber-300/40">
                  Multiple {globalReassignName.trim() || implicitShortName}s — pick one
                </div>
                {fullNameCandidates.map(({ person, similarity }) => {
                  const isPicked = globalReassignPersonId === person.id;
                  const simPct = similarity != null ? Math.round(similarity * 100) : null;
                  const simTone = simPct == null ? '' : simPct >= 75 ? 'text-emerald-600 dark:text-emerald-400' : simPct >= 60 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground';
                  return (
                    <button
                      key={person.id}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setGlobalReassignPersonId(person.id);
                        setGlobalReassignFullName(person.full_name?.trim() || '');
                        setFullNameUserEdited(false);
                      }}
                      className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-sm text-left transition-colors ${isPicked ? 'bg-purple-200/70 dark:bg-purple-800/40' : 'hover:bg-purple-100/50 dark:hover:bg-purple-900/20'}`}
                    >
                      <span className="truncate flex-1">
                        {person.full_name?.trim() || <span className="italic text-muted-foreground">(no full name)</span>}
                      </span>
                      {simPct != null && (
                        <span className={`text-[10px] font-medium tabular-nums ${simTone}`}>{simPct}%</span>
                      )}
                      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{person.photo_count ?? 0}</span>
                    </button>
                  );
                })}
              </div>
            )}
            </div>
              );
            })()}
            <p className="text-[10px] text-muted-foreground/85 -mt-1 px-0.5">Shown on Tree cards. Leave blank to fall back to short name.</p>
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
                      const fullToUse = globalReassignFullName.trim() ? globalReassignFullName.trim() : null;
                      const lockedPersonId = globalReassignPersonId;
                      (async () => {
                        for (let i = 0; i < t.length; i++) {
                          const isLast = i === t.length - 1;
                          await handleReassignFace(t[i], effectiveName, true, !isLast, fullToUse, lockedPersonId);
                        }
                        setGlobalReassignFaceId(null);
                        setGlobalReassignName(''); setGlobalReassignFullName('');
                        setGlobalSelectedFaces(new Set());
                      })();
                    }}
                    disabled={!effectiveName}
                    className={`flex-1 px-2 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors ${
                      globalSelectedFaces.size > 0 && !!effectiveName ? 'animate-pulse-cta ring-2 ring-purple-300/60 ring-offset-1 ring-offset-background' : ''
                    }`}
                  >
                    Verify{globalSelectedFaces.size > 1 ? ` (${globalSelectedFaces.size})` : ''}
                  </button>
                  <button
                    onClick={() => { setGlobalReassignFaceId(null); setGlobalReassignName(''); setGlobalReassignFullName(''); setGlobalSelectedFaces(new Set()); }}
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
                  setGlobalReassignFaceId(null); setGlobalReassignName(''); setGlobalReassignFullName(''); setGlobalSelectedFaces(new Set());
                  (async () => { for (let i = 0; i < targets.length; i++) await handleReassignFace(targets[i], '__unsure__', false, i < targets.length - 1); })();
                }} className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-blue-300/50 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-sm font-medium transition-colors">
                  <HelpCircle className="w-3 h-3" /> Unsure
                </button>
              )}
              {activeTab !== 'unnamed' && (
                <button onClick={() => {
                  const targets = Array.from(globalSelectedFaces);
                  if (targets.length === 0) return;
                  setGlobalReassignFaceId(null); setGlobalReassignName(''); setGlobalReassignFullName(''); setGlobalSelectedFaces(new Set());
                  (async () => { for (let i = 0; i < targets.length; i++) await handleReassignFace(targets[i], '__unnamed__', false, i < targets.length - 1); })();
                }} className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-amber-300/50 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 text-sm font-medium transition-colors">
                  <Users className="w-3 h-3" /> Unnamed
                </button>
              )}
              {activeTab !== 'ignored' && (
                <button onClick={() => {
                  const targets = Array.from(globalSelectedFaces);
                  if (targets.length === 0) return;
                  setGlobalReassignFaceId(null); setGlobalReassignName(''); setGlobalReassignFullName(''); setGlobalSelectedFaces(new Set());
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
                    setGlobalReassignFaceId(null); setGlobalReassignName(''); setGlobalReassignFullName(''); setGlobalSelectedFaces(new Set());
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

      {/* ── Result feedback ── Success/info show as a non-blocking
          bottom-right toast that auto-fades after 6s — the user sees
          the cluster rows update immediately and doesn't need to
          dismiss anything. Errors fall back to a centred modal with
          an OK button since they typically need attention. */}
      {resultModal && resultModal.tone !== 'error' && (
        <div className="fixed bottom-6 right-6 z-[95] w-[380px] max-w-[90vw] rounded-xl bg-background border border-border shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-200">
          <div className="flex items-start gap-3 px-4 py-3">
            <div className={`mt-0.5 ${resultModal.tone === 'success' ? 'text-purple-500' : 'text-foreground'}`}>
              {resultModal.tone === 'success' ? <Sparkles className="w-4 h-4" /> : <Info className="w-4 h-4" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-foreground mb-0.5">{resultModal.title}</div>
              <div className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">{resultModal.body}</div>
            </div>
            <button
              onClick={() => { if (resultModalTimerRef.current) clearTimeout(resultModalTimerRef.current); setResultModal(null); }}
              className="p-0.5 rounded hover:bg-accent shrink-0 -mt-0.5 -mr-0.5"
              aria-label="Dismiss"
            >
              <X className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
        </div>
      )}
      {resultModal && resultModal.tone === 'error' && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) setResultModal(null); }}>
          <div className="w-[440px] max-w-[90vw] rounded-xl bg-background border border-border shadow-2xl flex flex-col">
            <div className="flex items-center gap-2 px-5 py-3 border-b border-border text-red-600 dark:text-red-400">
              <AlertTriangle className="w-4 h-4" />
              <h3 className="text-base font-semibold">{resultModal.title}</h3>
            </div>
            <div className="px-5 py-4 text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
              {resultModal.body}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
              <button
                onClick={() => setResultModal(null)}
                className="px-4 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 text-white text-sm font-medium transition-colors"
                autoFocus
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Post-verify Improve Recognition chip ── Vote D from the
          FR redesign. Appears after a successful verify, offers
          one-click refinement scoped to that one person. Auto-fades
          after 15s if ignored. Floats top-centre so it doesn't
          collide with the bottom-anchored Undo toast. */}
      {improvePrompt && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[95] flex items-center gap-3 px-4 py-2 rounded-full bg-purple-500 text-white shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200">
          <Sparkles className="w-4 h-4" />
          <span className="text-sm">
            Improve recognition for <strong>{improvePrompt.personName}</strong> now?
          </span>
          <button
            onClick={async () => {
              const p = improvePrompt;
              if (improveTimerRef.current) clearTimeout(improveTimerRef.current);
              setImprovePrompt(null);
              await handleImproveOne(p.personId, p.personName);
            }}
            className="px-2.5 py-1 rounded-full bg-white text-purple-600 text-xs font-semibold hover:bg-purple-50 transition-colors"
          >
            Improve
          </button>
          <button onClick={() => { if (improveTimerRef.current) clearTimeout(improveTimerRef.current); setImprovePrompt(null); }} className="p-0.5 rounded hover:bg-white/15">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* ── 20s Undo banner with countdown ──
          Visible after a row is sent to Unnamed. Shows a circular
          countdown ring + seconds-remaining so the user knows how
          long they have left before the only fallback becomes
          Settings → Backup. Reverses the action exactly via the
          captured undo token — all verified flags restored. */}
      {undoSnapshot && (() => {
        const elapsed = Date.now() - undoSnapshot.startedAt;
        const remainingMs = Math.max(0, 20_000 - elapsed);
        const remainingSec = Math.ceil(remainingMs / 1000);
        const progress = remainingMs / 20_000; // 1 → 0
        // Stroke-dasharray countdown on a 16-radius circle.
        const circumference = 2 * Math.PI * 14;
        return (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[95] flex items-center gap-3 px-4 py-2.5 rounded-xl bg-foreground text-background shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-200 max-w-[92vw]">
            {/* Countdown ring */}
            <div className="relative w-9 h-9 shrink-0">
              <svg className="absolute inset-0 -rotate-90" viewBox="0 0 32 32" width="36" height="36">
                <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
                <circle
                  cx="16" cy="16" r="14" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={circumference * (1 - progress)}
                  style={{ transition: 'stroke-dashoffset 250ms linear' }}
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold tabular-nums">
                {remainingSec}s
              </div>
            </div>
            <div className="text-sm leading-tight pr-1">
              <div>
                Sent <strong>{undoSnapshot.personName}</strong> to Unnamed.
              </div>
              <div className="text-[11px] opacity-70 mt-0.5">
                After this expires, Settings → Backup is the fallback.
              </div>
            </div>
            <button
              onClick={handleUndoUnname}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-purple-500 hover:bg-purple-600 text-white text-xs font-medium transition-colors"
            >
              <Undo2 className="w-3 h-3" /> Undo
            </button>
            <button onClick={() => setUndoSnapshot(null)} className="p-0.5 rounded hover:bg-background/15" aria-label="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })()}

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

/* ─── Discard / Remove-Selected confirm modal ────────────────────────────
   Premium-style: minimal text, visual face thumbnails to make the
   consequence visceral, no typed-name gate for low-stakes (under
   the HIGH_STAKES_THRESHOLD verified faces). Above that threshold,
   the typed-name gate kicks in for a deliberate-action signal.
   Pairs with a 20-second Undo banner that fully reverses the
   action via the captured undo token. */

const HIGH_STAKES_THRESHOLD = 50;

function DiscardConfirmModal({ personName, photoCount, verifiedCount, selectedFaceIds, sampleFaceCrops, onCancel, onConfirm }: {
  personName: string;
  photoCount: number;
  verifiedCount: number;
  selectedFaceIds: number[] | null;
  /** Up to 8 face thumbnails to show in the modal — visual cue
   *  for what's about to be unnamed. */
  sampleFaceCrops: string[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isWholeRow = !selectedFaceIds || selectedFaceIds.length === 0;
  const isHighStakes = isWholeRow && verifiedCount >= HIGH_STAKES_THRESHOLD;
  const [typed, setTyped] = useState('');
  const isMatch = typed.trim().toLowerCase() === personName.trim().toLowerCase();
  const canConfirm = !isHighStakes || isMatch;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && canConfirm) onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canConfirm, onCancel, onConfirm]);
  // Header = single clear sentence. Apple convention: question form,
  // proper noun in quotes only when ambiguous. We drop the quotes
  // for brevity and rely on bold for emphasis.
  const headline = isWholeRow
    ? `Send ${personName} back to Unnamed?`
    : `Remove ${selectedFaceIds!.length} face${selectedFaceIds!.length === 1 ? '' : 's'} from ${personName}?`;
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="w-[460px] max-w-[90vw] rounded-xl bg-background border border-border shadow-2xl flex flex-col overflow-hidden">
        {/* Header — icon + single sentence, no separator line below
            so the visual flow continues into the thumbnail strip. */}
        <div className="flex items-start gap-3 px-5 pt-5 pb-3">
          <div className="w-8 h-8 rounded-full bg-amber-500/15 flex items-center justify-center shrink-0 mt-0.5">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
          </div>
          <h3 className="text-base font-semibold text-foreground leading-snug">{headline}</h3>
        </div>

        {/* Visual strip — what's about to be unnamed. Up to 10
            thumbnails; if the row has more, show "+N more" badge.
            10 chosen because it fits the modal width comfortably
            with a 1.5px gap and avoids clipping. */}
        {sampleFaceCrops.length > 0 && (
          <div className="px-5 pb-3 flex items-center gap-1.5 overflow-hidden">
            {sampleFaceCrops.slice(0, 10).map((src, i) => (
              <img key={i} src={src} alt="" className="w-8 h-8 rounded-full object-cover border border-border shrink-0" />
            ))}
            {photoCount > 10 && (
              <span className="text-xs text-muted-foreground ml-1">+{photoCount - 10} more</span>
            )}
          </div>
        )}

        {/* Body: two short paragraphs — what's at risk + why it's safe. */}
        <div className="px-5 pb-3 text-sm text-muted-foreground leading-relaxed space-y-2.5">
          {isWholeRow ? (
            <>
              <p>
                <strong className="text-foreground">What's at risk:</strong> the {verifiedCount > 0 ? `${verifiedCount} verified ` : ''}face{verifiedCount === 1 ? '' : 's'} on this row {verifiedCount > 0 ? 'lose their verified status' : 'are unlinked'}. The {photoCount} photo{photoCount === 1 ? '' : 's'} appear in Unnamed where you can re-assign or re-verify {photoCount === 1 ? 'it' : 'them'}.
              </p>
              <p>
                <strong className="text-foreground">Why it's safe:</strong> the photo files on your drives are never affected, and the next 20 seconds give you a one-click Undo. After that, Settings → Backup can roll the database back to an earlier launch.
              </p>
            </>
          ) : (
            <p>
              The {selectedFaceIds!.length} selected face{selectedFaceIds!.length === 1 ? ' is' : 's are'} unlinked from <strong className="text-foreground">{personName}</strong> and sent back to Unnamed. The rest of the row stays Named. Photos themselves are never affected, and you have 20 seconds to Undo.
            </p>
          )}
        </div>

        {/* High-stakes typed-name gate — only for ≥50 verified faces.
            Below that, a clear button is enough premium-feel friction. */}
        {isHighStakes && (
          <div className="px-5 pb-3">
            <label className="text-[11px] uppercase tracking-wider text-muted-foreground/85 block mb-1.5">
              {verifiedCount} verified — type <strong className="text-foreground normal-case tracking-normal">{personName}</strong> to confirm
            </label>
            <input
              autoFocus
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              spellCheck={false}
              autoCorrect="off"
              className={`w-full px-2.5 py-1.5 rounded-lg border bg-secondary/30 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-purple-400/50 transition-colors ${
                typed.length > 0 && !isMatch ? 'border-red-300/70 focus:ring-red-400/50' : 'border-border'
              }`}
              placeholder={personName}
            />
          </div>
        )}

        {/* Action row: Cancel left (Apple convention prominence on
            "stay safe"), destructive on the right. */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 bg-muted/30 border-t border-border">
          <button
            onClick={onCancel}
            autoFocus={!isHighStakes}
            className="px-3.5 py-1.5 rounded-lg border border-border hover:bg-secondary text-sm font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className="px-3.5 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
          >
            {isWholeRow ? 'Send to Unnamed' : `Remove ${selectedFaceIds!.length}`}
          </button>
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
  const PER_PAGE = 40;

  // Multi-select on the grid. Convention matches the rest of PM
  // (Lightroom / Apple Photos style):
  //   - plain click       → replace selection with this one face
  //   - Ctrl / Cmd+click  → toggle this face in/out of selection
  //   - Shift+click       → range select from last anchor to here
  // The side action panel pulls its options from this set, mirroring
  // the main view's right-hand verify panel (same implicit-name
  // placeholders, same Verify/Cancel/Unsure/Unnamed/Ignore buttons).
  const [selectedFaceIds, setSelectedFaceIds] = useState<Set<number>>(new Set());
  const [lastSelectedIdx, setLastSelectedIdx] = useState<number | null>(null);
  const [reassignName, setReassignName] = useState('');
  const [reassignFullName, setReassignFullName] = useState('');

  // Same ring-colour helper as PersonCardRow — was previously a free
  // reference here, which threw ReferenceError at runtime ("blank
  // screen on View all photos") because `verifiedBorder` only exists
  // in PersonCardRow's closure. Mirroring it locally fixes the crash.
  const verifiedBorder = (() => {
    if (!cluster.person_name) return 'border-2 border-amber-400/70'; // Unnamed
    if (cluster.person_name === '__unsure__') return 'border-2 border-blue-400/70';
    if (cluster.person_name === '__ignored__') return 'border-2 border-[#76899F]/70';
    if (cluster.person_name.startsWith('__')) return '';
    return 'border-2 border-purple-400/70'; // Named (real name)
  })();

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

  // Apply an action to ALL currently-selected faces. Wraps multiple
  // single-face calls so onReassignFace's existing contract still
  // holds. After success: clears selection + reloads the page so
  // newly-verified faces re-render with their purple ring.
  const handleBatchAction = async (name: string, verified: boolean) => {
    const ids = Array.from(selectedFaceIds);
    if (ids.length === 0 || !name.trim()) return;
    for (const id of ids) await onReassignFace(id, name.trim(), verified);
    setSelectedFaceIds(new Set());
    setReassignName('');
    setReassignFullName('');
    await loadPage(page);
  };

  // Implicit name = the cluster's own name. Pre-populates placeholder
  // so the user doesn't have to type "Mel" to verify Mel's own faces.
  const isClusterNamed = !!cluster.person_name && !cluster.person_name.startsWith('__');
  const implicitShortName = isClusterNamed ? cluster.person_name! : '';
  const implicitFullName = isClusterNamed ? (cluster.person_full_name || '') : '';
  const typedShort = reassignName.trim();
  const userDiverged = typedShort.length > 0 && typedShort.toLowerCase() !== implicitShortName.toLowerCase();
  const effectiveShortName = typedShort || implicitShortName;

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
          className="bg-background rounded-2xl shadow-2xl max-w-5xl w-full flex flex-col max-h-[90vh] overflow-hidden"
        >
          {/* Header — Short + Full name + face count. Mirrors the
              row's identity at the top so the user always knows
              which person they're managing. */}
          <div className="flex items-start justify-between p-5 border-b border-border">
            <div className="flex items-center gap-3 min-w-0">
              {cropUrl && <img src={cropUrl} alt="" className="w-12 h-12 rounded-full object-cover border-2 border-purple-400/40 shrink-0" />}
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-foreground truncate">
                  {isClusterNamed ? cluster.person_name : 'Unknown person'}
                </h2>
                {cluster.person_full_name && cluster.person_full_name !== cluster.person_name && (
                  <p className="text-sm text-muted-foreground truncate">{cluster.person_full_name}</p>
                )}
                <p className="text-xs text-muted-foreground/85 mt-0.5">
                  {cluster.face_count} face{cluster.face_count === 1 ? '' : 's'} across {cluster.photo_count} photo{cluster.photo_count === 1 ? '' : 's'} · sorted by confidence (lowest first)
                </p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors shrink-0">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Two-column body: face grid (left) + action panel (right).
              The action panel mirrors the main view's right-side
              verify panel — same implicit-name placeholders, same
              Verify/Cancel/Unsure/Unnamed/Ignore buttons, same
              Set-as-main-photo affordance. Visual consistency is
              the point: users learn the panel once and it works
              everywhere. */}
          <div className="flex flex-1 min-h-0">
            {/* Grid + pagination — left column */}
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="flex-1 overflow-y-auto p-5">
                {isLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
                    <span className="ml-2 text-base text-muted-foreground">Loading faces...</span>
                  </div>
                ) : data && data.faces.length > 0 ? (
                  <div className="grid grid-cols-7 gap-2">
                    {data.faces.map((face, faceIdx) => {
                      const isSelected = selectedFaceIds.has(face.face_id);
                      return (
                        <button
                          key={face.face_id}
                          type="button"
                          onClick={(e) => {
                            // Mirror PM's standard selection convention:
                            //   plain click = replace selection
                            //   Ctrl/Cmd-click = toggle this face
                            //   Shift-click = range select from anchor
                            if (e.ctrlKey || e.metaKey) {
                              setSelectedFaceIds(prev => {
                                const next = new Set(prev);
                                if (next.has(face.face_id)) next.delete(face.face_id);
                                else next.add(face.face_id);
                                return next;
                              });
                              setLastSelectedIdx(faceIdx);
                            } else if (e.shiftKey && lastSelectedIdx !== null && data) {
                              const start = Math.min(lastSelectedIdx, faceIdx);
                              const end = Math.max(lastSelectedIdx, faceIdx);
                              setSelectedFaceIds(prev => {
                                const next = new Set(prev);
                                for (let i = start; i <= end; i++) {
                                  if (data.faces[i]) next.add(data.faces[i].face_id);
                                }
                                return next;
                              });
                            } else {
                              // Plain click — replace selection. If
                              // they clicked the only-selected face,
                              // toggle it off (matches deselect-via-
                              // re-click expectation).
                              setSelectedFaceIds(prev => {
                                if (prev.size === 1 && prev.has(face.face_id)) return new Set();
                                return new Set([face.face_id]);
                              });
                              setLastSelectedIdx(faceIdx);
                            }
                          }}
                          className="relative group text-left"
                        >
                          {faceCrops[face.face_id] ? (
                            <img src={faceCrops[face.face_id]} alt="" className={`w-full aspect-square rounded-lg object-cover transition-all ${
                              isSelected ? 'ring-2 ring-green-500 ring-offset-2 ring-offset-background'
                              : face.verified ? `${verifiedBorder} hover:ring-2 hover:ring-purple-400/50`
                              : 'border border-border/50 hover:ring-2 hover:ring-purple-400/50'
                            }`} />
                          ) : (
                            <div className={`w-full aspect-square rounded-lg bg-secondary flex items-center justify-center ${
                              isSelected ? 'ring-2 ring-green-500 ring-offset-2 ring-offset-background'
                              : face.verified ? verifiedBorder : ''
                            }`}>
                              <Users className="w-4 h-4 text-muted-foreground/70" />
                            </div>
                          )}
                          {isSelected && (
                            <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-green-500 flex items-center justify-center shadow-sm">
                              <Check className="w-3 h-3 text-white" />
                            </div>
                          )}
                          <span className={`absolute bottom-0.5 right-0.5 text-[8px] font-bold px-1 py-0.5 rounded bg-background/80 backdrop-blur-sm ${confidenceColor(face.confidence)}`}>
                            {Math.round(face.confidence * 100)}%
                          </span>
                        </button>
                      );
                    })}
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
                <div className="flex items-center justify-between p-4 border-t border-border">
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
            </div>

            {/* Action panel — right column. Mirrors the main view's
                right-hand verify panel layout for muscle-memory
                consistency. */}
            <div className={`w-[280px] shrink-0 border-l flex flex-col p-4 transition-colors ${
              selectedFaceIds.size > 0 ? 'border-l-2 border-purple-400/70' : 'border-border'
            }`}>
              {selectedFaceIds.size === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center text-sm text-muted-foreground/85 px-2">
                  <Users className="w-8 h-8 text-muted-foreground/30 mb-3" />
                  <p>Click a face on the left to act on it.</p>
                  <p className="text-xs text-muted-foreground/60 mt-2">
                    You can select more than one to act on them in batch.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="bg-green-500 text-white text-sm font-medium text-center py-1 px-3 rounded-md">
                    {selectedFaceIds.size} face{selectedFaceIds.size === 1 ? '' : 's'} selected
                  </div>
                  {/* Confidence summary for selected faces — useful
                      because the popover used to show a single
                      face's confidence; here we surface the range. */}
                  {(() => {
                    const sel = (data?.faces ?? []).filter(f => selectedFaceIds.has(f.face_id));
                    if (sel.length === 0) return null;
                    const min = Math.min(...sel.map(f => f.confidence));
                    const max = Math.max(...sel.map(f => f.confidence));
                    const label = sel.length === 1
                      ? `Confidence: ${confidenceLabel(min)} (${Math.round(min * 100)}%)`
                      : `Confidence: ${Math.round(min * 100)}% – ${Math.round(max * 100)}%`;
                    return (
                      <p className={`text-[11px] text-center font-medium ${confidenceColor(max)}`}>
                        {label}
                      </p>
                    );
                  })()}
                  {/* First selected face thumbnail — visual anchor */}
                  {(() => {
                    const firstId = Array.from(selectedFaceIds)[0];
                    const crop = firstId != null ? faceCrops[firstId] : null;
                    return crop ? (
                      <div className="flex justify-center">
                        <img src={crop} alt="" className="w-16 h-16 rounded-full object-cover border-2 border-purple-400/40" />
                      </div>
                    ) : null;
                  })()}
                  {isClusterNamed && (
                    <p className="text-xs text-muted-foreground/85 text-center -mt-0.5">
                      All from <strong className="text-foreground">{cluster.person_name}</strong>'s row
                    </p>
                  )}
                  <input
                    type="text"
                    value={reassignName}
                    onChange={(e) => setReassignName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && effectiveShortName) {
                        e.preventDefault();
                        handleBatchAction(effectiveShortName, true);
                      }
                      if (e.key === 'Escape') {
                        setSelectedFaceIds(new Set());
                        setReassignName('');
                        setReassignFullName('');
                      }
                    }}
                    placeholder={implicitShortName ? `Verify as ${implicitShortName}` : 'Type person name...'}
                    className="w-full text-base px-2.5 py-1.5 rounded-lg border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-purple-400/50"
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="words"
                    autoFocus
                  />
                  <input
                    type="text"
                    value={reassignFullName}
                    onChange={(e) => setReassignFullName(e.target.value)}
                    placeholder={(!userDiverged && implicitFullName) ? implicitFullName : 'Full name — optional'}
                    className="w-full text-sm px-2.5 py-1.5 rounded-lg border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-purple-400/50"
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="words"
                  />
                  <p className="text-[10px] text-muted-foreground/85 -mt-1 px-0.5">Shown on Tree cards. Leave blank to fall back to short name.</p>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => handleBatchAction(effectiveShortName, true)}
                      disabled={!effectiveShortName}
                      className={`flex-1 px-2 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors ${
                        effectiveShortName ? 'animate-pulse-cta ring-2 ring-purple-300/60 ring-offset-1 ring-offset-background' : ''
                      }`}
                    >
                      Verify{selectedFaceIds.size > 1 ? ` (${selectedFaceIds.size})` : ''}
                    </button>
                    <button
                      onClick={() => { setSelectedFaceIds(new Set()); setReassignName(''); setReassignFullName(''); }}
                      className="px-2 py-1.5 rounded-lg border border-border hover:bg-secondary text-sm font-medium transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                  <div className="flex gap-1.5 pt-1 border-t border-border">
                    <button
                      onClick={() => handleBatchAction('__unsure__', false)}
                      className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-blue-300/50 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-sm font-medium transition-colors"
                    >
                      <HelpCircle className="w-3 h-3" /> Unsure
                    </button>
                    <button
                      onClick={() => handleBatchAction('__unnamed__', false)}
                      className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-amber-300/50 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 text-sm font-medium transition-colors"
                    >
                      <Users className="w-3 h-3" /> Unnamed
                    </button>
                    <button
                      onClick={() => handleBatchAction('__ignored__', false)}
                      className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-slate-300/50 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/30 text-sm font-medium transition-colors"
                    >
                      <UserX className="w-3 h-3" /> Ignore
                    </button>
                  </div>
                  {/* Set-as-main-photo: only when single-selected
                      and the cluster is a real Named person. */}
                  {onSetRepresentative && cluster.person_id && selectedFaceIds.size === 1 && (
                    <button
                      onClick={async () => {
                        const id = Array.from(selectedFaceIds)[0];
                        await onSetRepresentative(id);
                        setSelectedFaceIds(new Set());
                      }}
                      className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-green-500 hover:bg-green-600 text-white text-sm font-medium transition-colors"
                    >
                      <ImageIcon className="w-3 h-3" /> Set as main photo
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="p-4 border-t border-border">
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

function PersonCardRow({ cluster, cropUrl, sampleCrops, isEditing, nameInput, fullNameInput, onStartEdit, onNameChange, onFullNameChange, onSubmit, onCancel, inputRef, fullInputRef, existingPersons, onSelectPerson, onDiscard, onRemoveSelected, onVerifySelected, onImproveOne, isImprovingOne, pendingIgnore, onIgnore, onConfirmIgnore, onCancelIgnore, pendingUnsure, onUnsure, onConfirmUnsure, onCancelUnsure, onRestore, displayName, onReassignFace, onSetRepresentative, globalSelectedFaces, onGlobalSelectionChange, globalReassignFaceId, onGlobalReassignChange, globalReassignName, onGlobalReassignNameChange, globalHoveredFaceId, onHoveredFaceChange, currentTab, rowIndex, onVisible }: {
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
  /** Selection-aware action — fires when the user wants to unlink
   *  ONLY the faces selected on this row (sends them to Unnamed,
   *  rest of the row stays Named). Lives on a separate "Remove N"
   *  pill button so the trash icon's action stays unambiguous. */
  onRemoveSelected?: (faceIds: number[]) => void;
  /** Selection-aware action — verifies the selected faces AS this
   *  person (cluster.person_name). One-click happy-path that lets
   *  users skip the right-side panel entirely. Hidden for
   *  __unsure__ / __ignored__ rows where "verify" makes no
   *  semantic sense. */
  onVerifySelected?: (faceIds: number[]) => void;
  /** Per-row Improve Facial Recognition. Runs refinement scoped to
   *  THIS person only — clicking from row 1 won't affect rows 2..N. */
  onImproveOne?: () => Promise<void>;
  /** True while THIS row's per-row Improve is running. Spinner-state. */
  isImprovingOne?: boolean;
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
  /** Globally-hovered face id (shared across all rows). Used to drive
   *  the per-face enlarged preview Tooltip in controlled mode so only
   *  one preview can be visible at a time, regardless of how fast the
   *  cursor crosses thumbnails. The setter is React's setState type
   *  so we can use functional updates to avoid stale-closure races. */
  globalHoveredFaceId: number | null;
  onHoveredFaceChange: React.Dispatch<React.SetStateAction<number | null>>;
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
                  {/* Tiny visible labels disambiguate the two inputs even
                      when both are filled — placeholders disappear once
                      a value is typed, leaving no in-input cue. */}
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground/85 -mb-1">Short name</label>
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
                      className="flex-1 text-base bg-transparent border-b-2 border-purple-400 outline-none text-foreground placeholder:text-muted-foreground/70 pb-0.5 min-w-0"
                      autoFocus
                      spellCheck={false}
                      autoCorrect="off"
                      autoCapitalize="words"
                    />
                    <button type="submit" disabled={!nameInput.trim()} className="px-3 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors whitespace-nowrap">
                      Save
                    </button>
                  </div>
                  {/* Optional full name. Shown on Trees cards; PM and
                      S&D keep using the short name above. Empty =
                      Trees falls back to the short name. */}
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground/85 -mb-1 mt-1">Full name <span className="lowercase tracking-normal text-muted-foreground/70">— optional, shown on Trees</span></label>
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
                    className="text-sm bg-transparent border-b border-border outline-none text-foreground/80 placeholder:text-muted-foreground/70 pb-0.5"
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="words"
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
                  <IconTooltip label={cluster.person_full_name} side="top">
                    <p className="text-[11px] text-muted-foreground/70 truncate">
                      {cluster.person_full_name}
                    </p>
                  </IconTooltip>
                )}
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {/* Photo count reflects what's actually VISIBLE
                      after the match-strictness filter, not the raw
                      DB row count. Otherwise users see "2 photos"
                      with only 1 thumbnail showing — confusing
                      contradiction. The filter is applied earlier
                      in `prepareFaces` so cluster.sample_faces is
                      already the post-filter set. */}
                  {(() => {
                    const visibleFaces = cluster.sample_faces ?? [];
                    const visiblePhotoCount = new Set(visibleFaces.map(f => f.file_id)).size;
                    return <>{visiblePhotoCount} {visiblePhotoCount === 1 ? 'photo' : 'photos'}</>;
                  })()}
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
                // pl-2 gives the leftmost thumbnail's `-top-1 -left-1`
                // numbered badge room to render without being clipped
                // by the strip's horizontal-overflow boundary. Without
                // it, every row's "1" badge gets sliced off on the
                // left edge.
                className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent py-1 pl-2"
                onClick={(e) => e.stopPropagation()}
                // Warm the hi-res context crop cache for every face in
                // this row the moment the cursor enters the strip. By
                // the time the user lands on a specific thumbnail, the
                // 200×200 image is already (or nearly) in cache so the
                // hover preview appears instantly instead of after a
                // multi-second decode. loadContextCrop dedups, so this
                // is safe to fire on every mouseenter — repeated
                // entries just no-op once cached.
                onMouseEnter={() => {
                  const faces = cluster.sample_faces || [];
                  for (const f of faces) {
                    if (f.file_path) {
                      // Fire-and-forget; loadContextCrop is async + dedups.
                      void loadContextCrop(`face_${f.face_id}`, f.file_path, f.box_x, f.box_y, f.box_w, f.box_h);
                    }
                  }
                }}
                // Belt-and-braces: clear any tooltip whose face was in
                // THIS row when the cursor exits the strip entirely.
                // Catches Radix edge-cases where pointer-leave doesn't
                // fire (scrollbar drag, fast cursor exits, focus loss).
                onMouseLeave={() => {
                  const ids = new Set(cluster.sample_faces?.map(f => f.face_id) ?? []);
                  onHoveredFaceChange((prev) => prev != null && ids.has(prev) ? null : prev);
                }}
              >
                {cluster.sample_faces.map((face, faceIdx) => (
                    // Controlled tooltip: open is driven by the parent's
                    // globalHoveredFaceId. Hovering thumb B sets state to
                    // B.face_id, which closes A's tooltip immediately
                    // (its open prop flips to false). The functional
                    // updater on close avoids a stale-closure race when
                    // events fire in B-open → A-close order, which was
                    // the cause of the "preview stuck open after mouse
                    // moves away" bug. No per-face TooltipProvider —
                    // the row-level one at line ~2271 covers this scope
                    // already.
                      <Tooltip
                        key={face.face_id}
                        open={globalHoveredFaceId === face.face_id}
                        onOpenChange={(open) => {
                          if (open && face.file_path) {
                            loadContextCrop(`face_${face.face_id}`, face.file_path, face.box_x, face.box_y, face.box_w, face.box_h);
                          }
                          if (open) {
                            onHoveredFaceChange(face.face_id);
                          } else {
                            // Functional updater — only clear if THIS
                            // face is still the recorded hover. Avoids
                            // stomping on a newer face that just opened.
                            onHoveredFaceChange((prev) => prev === face.face_id ? null : prev);
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
                                  <Users className="w-3.5 h-3.5 text-muted-foreground/70" />
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
                        {/* Always render TooltipContent — even before the
                            hi-res context crop has loaded, the user gets
                            an instant scaled-up small thumb plus a
                            shimmer overlay. Previously the content was
                            gated on contextCrops[key] so the user saw
                            NOTHING during the cold-cache fetch (and
                            "sometimes none at all" if the fetch lost the
                            race / silently failed). avoidCollisions
                            stays default-true so Radix flips to bottom
                            for top-row clusters automatically. */}
                        {(sampleCrops[face.face_id] || contextCrops[`face_${face.face_id}`] || face.file_path) && (
                          <TooltipContent side="top" sideOffset={6} collisionPadding={12} className="p-1.5 border border-purple-400/30 bg-background shadow-lg rounded-xl z-[80] max-w-[260px]">
                            {(() => {
                              const ctx = contextCrops[`face_${face.face_id}`];
                              const small = sampleCrops[face.face_id];
                              const src = ctx || small;
                              if (!src) {
                                return (
                                  <div className="w-[200px] h-[200px] rounded-lg bg-secondary animate-pulse flex items-center justify-center">
                                    <Loader2 className="w-5 h-5 text-muted-foreground/60 animate-spin" />
                                  </div>
                                );
                              }
                              return (
                                <div className="relative">
                                  <img
                                    src={src}
                                    alt=""
                                    className={`w-[200px] h-[200px] object-cover cursor-zoom-in ${ctx ? 'rounded-lg' : 'rounded-lg blur-[1px] opacity-95'}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (face.file_path) {
                                        const meta = contextMeta[`face_${face.face_id}`];
                                        openSearchViewer(face.file_path, meta?.filename || face.file_path.split(/[\\/]/).pop() || '');
                                      }
                                    }}
                                  />
                                  {!ctx && (
                                    <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/55 text-white text-[9px] flex items-center gap-1">
                                      <Loader2 className="w-2.5 h-2.5 animate-spin" /> Loading hi-res…
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                            {/* Metadata strip — filename, date, location.
                                Renders as soon as metadata is available,
                                independent of the hi-res image fetch. */}
                            {(() => {
                              const meta = contextMeta[`face_${face.face_id}`];
                              if (!meta) return null;
                              const place = [meta.geo_city, meta.geo_country].filter(Boolean).join(', ');
                              return (
                                <div className="mt-1.5 px-1 pb-0.5 space-y-0.5 text-[10px]">
                                  <div className="font-medium text-foreground/90 truncate">{meta.filename || '—'}</div>
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

          {/* ── Single right-side action column ── Vertical layout
              so multi-face actions (Verify N / Remove N) stack and
              don't blow out the row's horizontal budget. Order:
              Verify N (purple, primary) on top, Remove N (amber)
              below. Hover-only tool icons (View all, Improve,
              Discard, Unsure, Ignore, Restore) sit in a compact
              horizontal row beneath, sharing the same column width
              and only showing on row hover. Width-fixed so rows
              don't visually shift left/right as selection changes.
              Verify pill hides on __unsure__ / __ignored__ rows
              where "verify" makes no semantic sense. */}
          {!isEditing && (() => {
            const ownedFaceIds = (cluster.sample_faces ?? []).map(f => f.face_id);
            const selectedHere = ownedFaceIds.filter(id => globalSelectedFaces.has(id));
            const hasSelection = selectedHere.length > 0;
            const showVerify = hasSelection && onVerifySelected && cluster.person_name && !cluster.person_name.startsWith('__');
            const showRemove = hasSelection && !!onRemoveSelected;
            return (
              <div className="flex flex-col items-end gap-1 shrink-0 w-[96px]">
                {showVerify && (
                  <IconTooltip label={`Verify ${selectedHere.length} selected face${selectedHere.length === 1 ? '' : 's'} as ${cluster.person_name}`} side="left">
                    <button
                      onClick={(e) => { e.stopPropagation(); onVerifySelected!(selectedHere); }}
                      className="w-full px-2 py-1 rounded-lg bg-purple-500 hover:bg-purple-600 text-white text-xs font-medium transition-colors shadow-sm"
                    >
                      Verify {selectedHere.length}
                    </button>
                  </IconTooltip>
                )}
                {showRemove && (
                  <IconTooltip label={`Unlink the ${selectedHere.length} selected face${selectedHere.length === 1 ? '' : 's'} from this person — sends to Unnamed`} side="left">
                    <button
                      onClick={(e) => { e.stopPropagation(); onRemoveSelected!(selectedHere); }}
                      className="w-full px-2 py-1 rounded-lg border border-amber-300/60 bg-amber-50/40 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 hover:bg-amber-100/60 dark:hover:bg-amber-900/30 text-xs font-medium transition-colors"
                    >
                      Remove {selectedHere.length}
                    </button>
                  </IconTooltip>
                )}
                {/* Hover-only icon row — sits below the pills (or as
                    the only action group when no selection). */}
                <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-all">
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
                  {onImproveOne && cluster.person_name && !cluster.person_name.startsWith('__') && (
                    <Tooltip><TooltipTrigger asChild>
                      <button
                        onClick={(e) => { e.stopPropagation(); onImproveOne(); }}
                        disabled={isImprovingOne}
                        className={`p-1.5 rounded-lg border border-purple-300/50 bg-background hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-colors ${isImprovingOne ? 'opacity-60 cursor-wait' : ''}`}
                      >
                        {isImprovingOne ? <Loader2 className="w-3.5 h-3.5 text-purple-500 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 text-purple-500" />}
                      </button>
                    </TooltipTrigger><TooltipContent>Improve recognition for {cluster.person_name}</TooltipContent></Tooltip>
                  )}
                  {onDiscard && (
                    <Tooltip><TooltipTrigger asChild>
                      <button
                        onClick={(e) => { e.stopPropagation(); onDiscard(); }}
                        className="p-1.5 rounded-lg border border-red-300/50 bg-background hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5 text-red-500" />
                      </button>
                    </TooltipTrigger><TooltipContent>Send entire row to Recycle Bin</TooltipContent></Tooltip>
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
              </div>
            );
          })()}
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
            {/* Tiny labels disambiguate the two inputs even when both
                are filled — placeholders disappear once typed into. */}
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground/85">Short name</label>
            <div className="flex items-center gap-1.5">
              <input ref={inputRef} type="text" value={nameInput} onChange={(e) => onNameChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }}
                placeholder="Name (short) — e.g. Terry" className="flex-1 text-base bg-transparent border-b-2 border-purple-400 outline-none text-foreground placeholder:text-muted-foreground/70 pb-0.5 min-w-0" autoFocus
                spellCheck={false} autoCorrect="off" autoCapitalize="words" />
              <Tooltip><TooltipTrigger asChild>
                <button type="submit" className="p-1 rounded hover:bg-purple-200/50 dark:hover:bg-purple-800/30"><Check className="w-3.5 h-3.5 text-purple-500" /></button>
              </TooltipTrigger><TooltipContent>Save</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild>
                <button type="button" onClick={onCancel} className="p-1 rounded hover:bg-secondary"><X className="w-3.5 h-3.5 text-muted-foreground" /></button>
              </TooltipTrigger><TooltipContent>Cancel</TooltipContent></Tooltip>
            </div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground/85 mt-1">Full name <span className="lowercase tracking-normal text-muted-foreground/70">— optional, shown on Trees</span></label>
            <input ref={fullInputRef} type="text" value={fullNameInput} onChange={(e) => onFullNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                if (e.key === 'Enter') { e.preventDefault(); if (nameInput.trim()) onSubmit(); }
              }}
              placeholder="Name (full) — optional, used in Trees" className="text-sm bg-transparent border-b border-border outline-none text-foreground/80 placeholder:text-muted-foreground/70 pb-0.5"
              spellCheck={false} autoCorrect="off" autoCapitalize="words" />
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
