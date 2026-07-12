import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import {
  X,
  FolderOpen,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  HardDrive,
  Pencil,
  Eye,
  Plug,
  PlugZap,
  RotateCcw,
  Wifi,
  WifiOff,
  RefreshCw,
  ExternalLink,
  Database,
  Images,
  Sparkles,
  MoreHorizontal,
  Copy,
  Download,
  Trash2,
  History,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { runLibraryRefresh, isLibraryRefreshRunning } from '@/lib/library-refresh';
import { TakeoutMetadataSection } from './TakeoutMetadataSection';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useLicense } from '@/contexts/LicenseContext';
import { promptConfirm } from '@/components/trees/promptConfirm';

// LibraryPanel — the user-facing surface for the library-portable DB
// feature. Visual vocabulary intentionally mirrors ManageDevicesModal
// (gradient header, motion'd icon tile, license-key verification
// sub-step) so the two modals feel like siblings.
//
// Flows it owns:
//   - View current library status (connected path, sync status, writer
//     device, this device's read/write role)
//   - Connect to a library: pick a folder → detect sidecar → branch
//     (Restore from existing OR Set as new) → license-key gate where
//     needed → processing → success
//   - Take over writing (if currently read-only): license-key verify →
//     processing → success
//   - Disconnect this device from the library

interface LibraryStatus {
  attached: boolean;
  libraryRoot: string | null;
  thisDeviceId: string;
  isWriter: boolean;
  writerDeviceName: string | null;
  writerDeviceId: string | null;
  sidecarPresent: boolean;
  lastAttachedAt: string | null;
}

interface SidecarDetection {
  found: boolean;
  dbExists: boolean;
  dbSizeBytes: number;
  lockExists: boolean;
  lock: any | null;
  auditExists: boolean;
  snapshotCount: number;
}

interface DriveTypeInfo {
  driveType: 'fixed' | 'removable' | 'network' | 'unknown';
  isSafeForLibrary: boolean;
  reason: string;
}

// Full drive identity block — shape returned by library:getDriveDetails.
// One IPC = one PowerShell exec, so the renderer doesn't fan out N
// calls per field. Used by the LDM's primary drive card.
interface DriveDetails {
  path: string;
  letter: string | null;
  volumeLabel: string | null;
  fileSystem: string | null;
  driveTypeLabel: string;
  driveTypeCode: number | null;
  totalBytes: number;
  freeBytes: number;
  online: boolean;
  isSafeForLibrary: boolean;
  safetyReason: string;
  // Drive interface (USB / SATA / NVMe / SCSI / SD / etc) — used as a
  // "drive speed" hint so users can pick a fast drive without
  // benchmarking. Comes from Get-Disk's BusType property.
  busType?: string | null;
  // HDD / SSD / Unspecified — when "SSD" plus busType "NVMe" we know
  // this is a top-tier drive.
  mediaType?: string | null;
}

// One row in the "Drives in your library" section — every drive the
// search DB has indexed photos from. Returned by
// library:listIndexedDrives. The DB's GROUP BY drive-letter feeds the
// indexed* fields; the Win32 LogicalDisk lookup adds label, size,
// free, online. Drives that are currently offline still appear here
// because the user's library knows about them — they just need to be
// plugged back in.
interface IndexedDrive {
  kind: 'letter' | 'unc';
  path: string;
  letter: string | null;
  volumeLabel: string | null;
  driveTypeLabel: string;
  driveTypeCode: number | null;
  totalBytes: number;
  freeBytes: number;
  online: boolean;
  indexedFileCount: number;
  indexedBytes: number;
  lastIndexedAt: string | null;
  // v2.0.11 — on-disk media-file count for this row's library root.
  // Populated by a parallel countOnDiskFiles probe alongside the main
  // drives fetch. Drives the per-row "Index" pill when the count
  // exceeds indexedFileCount by more than the 5 % slack used by the
  // Dashboard banner. null when the path isn't reachable (USB
  // unplugged etc.) — pill stays hidden in that case.
  onDiskCount?: number | null;
}

type Step =
  | 'status'
  | 'set-up-confirmation'
  | 'picker-loading'
  | 'detected-existing'
  | 'detected-empty'
  | 'drive-unsafe'
  | 'verify-key'
  | 'processing'
  | 'success'
  | 'error';

type PendingAction =
  | { kind: 'attachFromSidecar'; libraryRoot: string }
  | { kind: 'attachAsNew'; libraryRoot: string }
  | { kind: 'takeOverWriter' };

interface LibraryPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

function formatBytes(n: number): string {
  if (!n || n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  // 1 decimal place for GB (e.g. 54.6 GB, not 54.62 GB) — keeps the
  // numbers easy to scan at a glance without the extra precision the
  // user doesn't need.
  if (n < 1024 * 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  // TB threshold so a 2 TB drive doesn't render as "2048 GB". Same
  // 1-decimal rule.
  return `${(n / 1024 / 1024 / 1024 / 1024).toFixed(1)} TB`;
}

// Human-friendly relative time for last-indexed / last-seen labels.
// "12 minutes ago" / "3 hours ago" / "yesterday" / "5 days ago" /
// "2 weeks ago" / "3 months ago". Premium pattern — calendar-precise
// timestamps belong in the audit log; for at-a-glance UI we want the
// shape of "recent vs not recent", not exact seconds.
function formatRelativeTime(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  const then = new Date(isoString).getTime();
  if (!Number.isFinite(then)) return '—';
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'just now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? '1 month ago' : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

// Match an arbitrary file/folder path back to its drive-letter prefix
// (e.g. "L:\1. Photos\..." → "L:"), so renderManagement can find the
// currently-configured Library Drive's entry in the indexedDrives list.
// Returns null for UNC / non-letter paths — those go to the "Network /
// mounted" bucket in listIndexedDrives, which we'll match separately.
function deriveDriveLetter(absPath: string): string | null {
  const m = absPath.match(/^([A-Za-z]):/);
  return m ? `${m[1].toUpperCase()}:` : null;
}

export function LibraryPanel({ isOpen, onClose }: LibraryPanelProps) {
  const { storedLicenseKey } = useLicense();
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [step, setStep] = useState<Step>('status');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [pendingDetection, setPendingDetection] = useState<SidecarDetection | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string>('');
  // Auto-suggest: when the user already has a destination drive set and it's
  // external/network, surface it as a one-click "use this as my Library Drive"
  // option on the status screen instead of forcing the folder-picker dance.
  const [suggestedPath, setSuggestedPath] = useState<string | null>(null);
  const [suggestedDriveInfo, setSuggestedDriveInfo] = useState<DriveTypeInfo | null>(null);
  // Stores the "this drive is internal, pick something external" reason when
  // the user picks an unsafe folder. Drives the drive-unsafe step.
  const [unsafeReason, setUnsafeReason] = useState<string | null>(null);
  // Online status of the current Library Drive — null = not yet checked,
  // true = reachable on disk, false = drive isn't there. Drives the
  // status pill on the management view ("Connected" vs "Offline"). The
  // panel re-checks on every open and after any action so the user sees
  // the live state, not a stale one.
  const [destinationOnline, setDestinationOnline] = useState<boolean | null>(null);
  // Full identity block for the current Library Drive — volume label,
  // file system, drive type, total/free bytes. One PowerShell call
  // (library:getDriveDetails) per refresh, parallelised with the
  // drive-type detect via Promise.all in refreshDriveDetails.
  const [driveDetails, setDriveDetails] = useState<DriveDetails | null>(null);
  // The "drives in your library" list — every drive the search DB has
  // indexed photos from. Stays in sync via refreshIndexedDrives, which
  // runs on panel open and after any library-mutating action.
  const [indexedDrives, setIndexedDrives] = useState<IndexedDrive[]>([]);
  // Saved Destinations — folder paths the user has previously used
  // as Library Drives. Terry's framing: the LDM should reflect the
  // user's actual libraries, NOT every drive on the PC. We read
  // these from localStorage (the same key FolderBrowserModal writes
  // to when a destination is picked) so the list matches "Saved
  // Destinations" exactly. Each entry is then enriched with online
  // state + drive details via getDriveDetails.
  const [savedDestinations, setSavedDestinations] = useState<string[]>([]);
  const [savedDestinationDetails, setSavedDestinationDetails] = useState<Record<string, DriveDetails | null>>({});
  // Per-path indexed-file counts. Keyed by the library-root path
  // (currentPath + every savedDestination). When present, the LDM
  // shows ACCURATE per-folder photo counts on those rows instead of
  // the per-drive-letter rollup that over-attributes when multiple
  // libraries share a drive. Terry's report 2026-05-16: two folders
  // on D: both showed 99 photos / 272.4 MB because the count was
  // per-letter, not per-path. Driven by the new
  // library:countFilesAtPath IPC. null entry = fetch pending or
  // failed; row falls back to the per-letter rollup gracefully.
  type PathCount = { indexedFileCount: number; indexedBytes: number; lastIndexedAt: string | null };
  const [pathCounts, setPathCounts] = useState<Record<string, PathCount | null>>({});
  // v2.0.11 — on-disk media-file count per library root. Probed in
  // parallel with pathCounts; powers the per-row "Index" pill that
  // surfaces when the on-disk count exceeds the indexed count by
  // more than the 5 % slack the Dashboard banner uses. null when the
  // path isn't reachable (USB unplugged, network share offline) —
  // the pill stays hidden in that case to avoid prompting users to
  // index something we can't even read.
  const [onDiskCounts, setOnDiskCounts] = useState<Record<string, number | null>>({});
  // v3.0.1 (Terry 2026-07-12) — on-disk files NOT indexed ANYWHERE (by filename
  // + size), per root. This, not onDisk−indexed, is the real "needs refresh"
  // count: a test/backup drive whose photos are already indexed under the real
  // library de-dupes to that drive, so its rows drop from ITS path but the
  // photos stay searchable — those must not show a "+N to refresh" pill.
  const [uncoveredCounts, setUncoveredCounts] = useState<Record<string, number | null>>({});
  // Per-path indexing state — set when a per-row Index pill is
  // clicked. Disables the pill + shows progress until the
  // rebuildProgress subscription fires its terminal 'complete' event.
  const [indexingPaths, setIndexingPaths] = useState<Set<string>>(new Set());
  // Per-path live progress from the rebuildProgress subscription —
  // drives the pill label so the user sees percentage / phase
  // directly on the row, not just in the toast. Cleared on
  // completion.
  type IndexingProgress = { phase: 'walking' | 'reading-exif' | 'inserting'; current: number; total: number };
  const [indexingProgress, setIndexingProgress] = useState<Record<string, IndexingProgress>>({});
  // v2.0.15 (Terry 2026-06-04) — Library-history discovery. Surfaces
  // libraries PDR has ever written to (according to the SQL
  // indexed_runs table) that aren't already in the LDM list. Each
  // entry includes the path, last-seen timestamp, total file count
  // across all Fix runs to that path, and how many runs landed
  // there. Filtered in the renderer against the current LDM list
  // plus the ignore list so only actionable rows survive.
  interface DiscoveredLibrary {
    path: string;
    lastIndexedAt: string;
    /** Only present for SQL-source rows. CSV/folder-pattern rows omit
     *  these because they don't have run-level data. */
    totalFileCount?: number;
    runCount?: number;
    /** Provenance — drives the small badge on each discovered card.
     *  'sql-runs'      = canonical, found in indexed_runs (highest confidence)
     *  'catalogue-csv' = PDR_Catalogue.csv file found on disk (high confidence)
     *  'folder-pattern'= folder structure looks like a PDR library (medium) */
    source: 'sql-runs' | 'catalogue-csv' | 'folder-pattern';
    /** v2.0.15 hotfix — actual current on-disk file count from the
     *  scan IPC (capped at 50). Only present on scan-source rows
     *  (catalogue-csv / folder-pattern). SQL-source rows omit this
     *  because they already show totalFileCount in their subline.
     *  Empty libraries (count === 0) are dropped before reaching the
     *  renderer, so when this field is present it's always > 0. */
    currentFileCount?: number;
    currentFileCountCapped?: boolean;
  }
  const [discoveredLegacyLibraries, setDiscoveredLegacyLibraries] = useState<DiscoveredLibrary[]>([]);
  // Drive-scan state — separate from the auto-running SQL discovery
  // because the filesystem walk is heavier and runs on demand from
  // the "Scan drives for more" button.
  const [isScanningDrives, setIsScanningDrives] = useState(false);
  // Refresh affordance. Spinner state for the refresh icon button so the
  // user gets visual feedback when they manually trigger a re-fetch
  // (slow on network drives where PowerShell takes a few seconds).
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Per-row spinner for the "Open in File Explorer" buttons in the
  // indexed-drives list. Keyed by path so multiple rows can show their
  // own spinner without clobbering each other.
  const [explorerOpening, setExplorerOpening] = useState<string | null>(null);
  // Inline status for "Sync now" so the user sees confirmation that
  // the mirror operation actually fired rather than nothing happening.
  const [syncingNow, setSyncingNow] = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; message: string } | null>(null);
  // True until the initial refreshAll on isOpen completes. Without this
  // flag, the dispatcher renders renderSetupWizard for ~100-300ms while
  // the IPCs are in flight (status / suggestedPath / driveDetails /
  // indexedDrives all still null), then switches to renderManagement
  // once data arrives — a visible flicker that reads as "two modals
  // appeared for a moment". Gating the dispatch on this flag avoids
  // showing either face until we know which one is correct.
  const [initialDataLoaded, setInitialDataLoaded] = useState(false);

  // Backup-state for the persistent "Back up DB" pill on the current
  // Library Drive row. lastDbBackupAt is the canonical timestamp of
  // the user's most recent Download Library DB success — null when
  // they've never backed up. The pill renders an amber/red call to
  // action against null and >30-day-old timestamps, a subtle green
  // "Backed up Xd ago" otherwise. Clicking the pill opens the small
  // explainer modal below. Backup flow is just handleExportDb +
  // settings.set('lastDbBackupAt', new Date().toISOString()) on
  // success — no new IPC surface area needed.
  const [lastDbBackupAt, setLastDbBackupAt] = useState<string | null>(null);
  const [showBackupExplainer, setShowBackupExplainer] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);

  // Pick-mode (v2.0.6). When set, the LDM is being opened as a folder
  // picker for some OTHER feature (Parallel Library, etc.) rather than
  // as the active-Library-Drive manager. In pick mode:
  //   • Clicking a drive radio dispatches `pdr:libraryDrivePicked`
  //     with { caller, path } and closes the LDM — no
  //     inspectAndRoute / attach action.
  //   • The "Set up a separate library anyway" link still works but
  //     SKIPS the Library Planner / DDA (the caller is picking a
  //     destination folder, not setting up a new library DB).
  //   • Reset on close so a follow-up normal-mode open isn't poisoned.
  // null = normal mode (manage the active Library Drive).
  const [pickMode, setPickMode] = useState<{ caller: string } | null>(null);

  const refreshStatus = async () => {
    try {
      const res = await (window as any).pdr?.library?.status();
      if (res?.success) setStatus(res.data as LibraryStatus);
    } catch (e) {
      console.warn('[LibraryPanel] status refresh failed:', e);
    }
  };

  const refreshSuggestion = async () => {
    try {
      // pdr.settings.get() returns the raw settings object (NOT a
      // { success, data } wrapper — that's only the convention for
      // operations that can fail). destinationPath is the field that
      // (in the user's mental model) IS their Library Drive.
      const settings = await (window as any).pdr?.settings?.get();
      const destPath = (settings && typeof settings.destinationPath === 'string') ? settings.destinationPath : undefined;
      if (!destPath) {
        setSuggestedPath(null);
        setSuggestedDriveInfo(null);
        setDestinationOnline(null);
        return;
      }
      setSuggestedPath(destPath);
      // Drive type + online status — fired in parallel because they
      // touch disjoint state and the panel is happier rendering once
      // both arrive together rather than flashing through partial
      // states (Connected → drive-type → ...).
      const [driveRes, onlineRes] = await Promise.all([
        (window as any).pdr?.library?.detectDriveType(destPath),
        (window as any).pdr?.library?.checkDestinationOnline(),
      ]);
      if (driveRes?.success) {
        setSuggestedDriveInfo(driveRes.data as DriveTypeInfo);
      } else {
        setSuggestedDriveInfo(null);
      }
      if (onlineRes?.success && typeof onlineRes.data?.online === 'boolean') {
        setDestinationOnline(onlineRes.data.online);
      } else {
        setDestinationOnline(null);
      }
    } catch (e) {
      console.warn('[LibraryPanel] suggestion refresh failed:', e);
    }
  };

  // Full drive identity for the current Library Drive (volume label,
  // file system, type, capacity). Pulls from library:getDriveDetails,
  // which is the single PowerShell exec that fetches everything in one
  // round-trip. No-op if there's no destinationPath set yet.
  //
  // Path resolution order: status.libraryRoot (the live sidecar-attach
  // path — most authoritative) → settings.destinationPath (legacy
  // fallback). The previous order trusted settings.destinationPath as
  // the source of truth, which caused the "H: shows Offline despite
  // being connected" bug when attachAsNew updated the live attach but
  // settings.destinationPath was still pointing at the old drive.
  const refreshDriveDetails = async (pathOverride?: string) => {
    try {
      let destPath: string | undefined;
      if (pathOverride) {
        destPath = pathOverride;
      } else {
        const [statusRes, settings] = await Promise.all([
          (window as any).pdr?.library?.status?.(),
          (window as any).pdr?.settings?.get?.(),
        ]);
        const libRoot = statusRes?.success && statusRes.data?.libraryRoot
          ? statusRes.data.libraryRoot
          : null;
        destPath = libRoot
          ?? (settings && typeof settings.destinationPath === 'string' ? settings.destinationPath : undefined);
      }
      if (!destPath) {
        setDriveDetails(null);
        return;
      }
      const res = await (window as any).pdr?.library?.getDriveDetails(destPath);
      if (res?.success) setDriveDetails(res.data as DriveDetails);
      else setDriveDetails(null);
    } catch (e) {
      console.warn('[LibraryPanel] drive-details refresh failed:', e);
    }
  };

  // The "drives in your library" list. Every drive the search DB has
  // indexed photos from, with per-drive counts, sizes, online status,
  // and volume labels. Empty list is a valid state (fresh install, no
  // indexed runs yet).
  const refreshIndexedDrives = async () => {
    try {
      const res = await (window as any).pdr?.library?.listIndexedDrives();
      if (res?.success && Array.isArray(res.data?.drives)) {
        setIndexedDrives(res.data.drives as IndexedDrive[]);
      } else {
        setIndexedDrives([]);
      }
    } catch (e) {
      console.warn('[LibraryPanel] indexed-drives refresh failed:', e);
    }
  };

  // Saved Destinations — read from localStorage (the same store
  // FolderBrowserModal writes to when a destination is picked). Then
  // enrich each path with driveDetails (online + capacity + FS) via
  // parallel getDriveDetails calls so the LDM rows show live state
  // without each row firing its own IPC on hover.
  const SAVED_DESTINATIONS_KEY = 'pdr-saved-destinations';
  // Load the last-DB-backup timestamp from settings. Drives the
  // persistent Back-up-DB pill state on the current Library Drive row.
  const refreshLastDbBackupAt = async () => {
    try {
      const settings = await (window as any).pdr?.settings?.get?.();
      setLastDbBackupAt(settings?.lastDbBackupAt ?? null);
    } catch (e) {
      console.warn('[LibraryPanel] lastDbBackupAt fetch failed:', e);
    }
  };

  // Refresh per-path indexed-file counts. Called after status +
  // savedDestinations are known so we have the right set of paths to
  // query. Each query is parallel + per-path failure-tolerant: a
  // failed lookup leaves a `null` entry, which the row renderer
  // treats as "fall back to per-letter rollup".
  const refreshPathCounts = async (paths: string[]) => {
    const uniquePaths = Array.from(new Set(paths.filter(p => typeof p === 'string' && p.length > 0)));
    if (uniquePaths.length === 0) {
      setPathCounts({});
      return;
    }
    try {
      const entries = await Promise.all(uniquePaths.map(async (p) => {
        try {
          const res = await (window as any).pdr?.library?.countFilesAtPath?.(p);
          if (res?.success && res.data) {
            return [p, res.data as PathCount] as const;
          }
          return [p, null] as const;
        } catch {
          return [p, null] as const;
        }
      }));
      const map: Record<string, PathCount | null> = {};
      entries.forEach(([p, c]) => { map[p] = c; });
      setPathCounts(map);
    } catch (e) {
      console.warn('[LibraryPanel] pathCounts refresh failed:', e);
    }
  };

  // v2.0.11 — sibling of refreshPathCounts that walks the filesystem
  // to count actual media files under each library root. Parallel +
  // per-path failure-tolerant. Powers the per-row "Index" pill.
  // Slower than pathCounts (filesystem walk vs single SQL query) so
  // it runs in the background after the main row data lands —
  // pills appear progressively as each path's probe resolves.
  const refreshOnDiskCounts = async (paths: string[]) => {
    const uniquePaths = Array.from(new Set(paths.filter(p => typeof p === 'string' && p.length > 0)));
    if (uniquePaths.length === 0) {
      setOnDiskCounts({});
      setUncoveredCounts({});
      return;
    }
    try {
      const entries = await Promise.all(uniquePaths.map(async (p) => {
        try {
          const res = await (window as any).pdr?.library?.countOnDiskFiles?.(p);
          if (res?.success && res.data?.reachable) {
            // uncoveredCount = on-disk files not indexed anywhere (by filename+size)
            return [p, (res.data.onDiskCount as number) ?? 0, (res.data.uncoveredCount as number) ?? 0] as const;
          }
          return [p, null, null] as const;
        } catch {
          return [p, null, null] as const;
        }
      }));
      const map: Record<string, number | null> = {};
      const umap: Record<string, number | null> = {};
      entries.forEach(([p, c, u]) => { map[p] = c; umap[p] = u; });
      setOnDiskCounts(map);
      setUncoveredCounts(umap);
    } catch (e) {
      console.warn('[LibraryPanel] onDiskCounts refresh failed:', e);
    }
  };

  // v2.0.15 hotfix #3 (Terry 2026-06-04) — drive-scan results are
  // now PERSISTED to localStorage under this key so they survive the
  // LDM closing + reopening. Without this Terry would run a multi-
  // minute scan, navigate away to S&D to look around while it ran,
  // then come back to find the discovered list empty because the
  // LibraryPanel component unmounted on LDM close. The cache stores
  // RAW scan results — filtering against savedDestinations + ignored
  // list happens at render time, so an Add-to-LDM action naturally
  // removes the card without needing to mutate the cache.
  const SCAN_CACHE_KEY = 'pdr-discovered-scan-cache';

  // v2.0.15 (Terry 2026-06-04) — Library-history discovery. Asks main
  // for every distinct destination_path in indexed_runs that still
  // exists on disk, then filters out:
  //   • the current Library Drive (already represented)
  //   • paths already in pdr-saved-destinations (already in the LDM)
  //   • paths in pdr-ignored-destinations (user has explicitly
  //     removed them and doesn't want them re-suggested)
  // What's left is the set of "you've written here before, want to
  // add it back?" candidates.
  const refreshDiscoveredLegacyLibraries = async () => {
    try {
      const res = await (window as any).pdr?.library?.discoverLegacyLibraries?.();
      if (!res?.success || !Array.isArray(res?.data?.libraries)) {
        setDiscoveredLegacyLibraries([]);
        return;
      }
      const all: DiscoveredLibrary[] = res.data.libraries;
      const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
      // Fetch the current Library Drive freshly via IPC rather than
      // reading the React `status` state — refreshAll fires this
      // discovery refresh from within its own continuation, and
      // setStatus() (from refreshStatus earlier in the Promise.all)
      // is an async React update that may not have flushed yet when
      // this filter runs. A fresh IPC is cheap and makes the function
      // self-contained — callable from anywhere without worrying
      // about React state freshness.
      let currentLibraryNorm: string | null = null;
      try {
        const sres = await (window as any).pdr?.library?.status?.();
        const root = sres?.success ? ((sres.data as LibraryStatus)?.libraryRoot ?? null) : null;
        if (root) currentLibraryNorm = norm(root);
      } catch { /* no current library — proceed with no current-LD filter */ }
      // Read savedDestinations from localStorage directly for the same
      // reason — the React state might lag behind a fresh localStorage
      // write done elsewhere in this session (e.g. user just added a
      // discovered library, then opened the LDM again before the state
      // round-trip completed).
      let savedNorms: Set<string> = new Set();
      try {
        const raw = localStorage.getItem('pdr-saved-destinations');
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) {
          savedNorms = new Set(
            parsed
              .filter((p: unknown): p is string => typeof p === 'string')
              .map(norm)
          );
        }
      } catch { /* corrupted savedDestinations — treat as empty */ }
      // Read the ignore list directly here (rather than threading it
      // through state) so a removal performed earlier in this same
      // session is honoured immediately on the next refresh, without
      // requiring a re-render dependency.
      let ignoredNorms: Set<string> = new Set();
      try {
        const raw = localStorage.getItem('pdr-ignored-destinations');
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) {
          ignoredNorms = new Set(
            parsed
              .filter((p: unknown): p is string => typeof p === 'string')
              .map(norm)
          );
        }
      } catch { /* corrupted ignore list — treat as empty */ }
      const sqlFiltered: DiscoveredLibrary[] = all
        .filter(lib => {
          const n = norm(lib.path);
          if (currentLibraryNorm && n === currentLibraryNorm) return false;
          if (savedNorms.has(n)) return false;
          if (ignoredNorms.has(n)) return false;
          return true;
        })
        .map(lib => ({ ...lib, source: 'sql-runs' as const }));

      // v2.0.15 hotfix #3 — restore any cached scan results from
      // localStorage (the user ran a drive scan in a previous LDM
      // session, then closed LDM). Filter them against the SAME live
      // state checks so paths the user has since added or ignored
      // don't reappear. Dedupe by normalised path so SQL rows always
      // beat scan rows on conflicts (SQL data is richer — has Fix
      // count + file count).
      let cachedScan: DiscoveredLibrary[] = [];
      try {
        const rawCache = localStorage.getItem(SCAN_CACHE_KEY);
        if (rawCache) {
          const parsed = JSON.parse(rawCache);
          if (parsed && Array.isArray(parsed.candidates)) {
            const sqlPaths = new Set(sqlFiltered.map(r => norm(r.path)));
            cachedScan = parsed.candidates
              // v2.0.15 hotfix #4 — only catalogue-csv entries are
              // valid now. Any 'folder-pattern' entries from a pre-
              // hotfix-4 cache are silently dropped so old false-
              // positive rows don't reappear after the strategy was
              // removed.
              .filter((c: any): c is { path: string; source: 'catalogue-csv'; lastSeenAt: string; currentFileCount: number; currentFileCountCapped: boolean } =>
                c && typeof c.path === 'string'
                  && c.source === 'catalogue-csv'
                  && typeof c.lastSeenAt === 'string'
                  && typeof c.currentFileCount === 'number'
              )
              .filter(c => {
                const n = norm(c.path);
                if (currentLibraryNorm && n === currentLibraryNorm) return false;
                if (savedNorms.has(n)) return false;
                if (ignoredNorms.has(n)) return false;
                if (sqlPaths.has(n)) return false;
                return true;
              })
              .map(c => ({
                path: c.path,
                lastIndexedAt: c.lastSeenAt,
                source: c.source,
                currentFileCount: c.currentFileCount,
                currentFileCountCapped: c.currentFileCountCapped,
              }));
          }
        }
      } catch (e) {
        console.warn('[LibraryPanel] scan cache read failed:', e);
      }

      setDiscoveredLegacyLibraries([...sqlFiltered, ...cachedScan]);
    } catch (e) {
      console.warn('[LibraryPanel] refreshDiscoveredLegacyLibraries failed:', e);
      setDiscoveredLegacyLibraries([]);
    }
  };

  // v2.0.15 — drive-scan discovery (Strategies 1 + 2). Heavier than
  // the SQL discovery above (walks each connected drive's filesystem
  // looking for PDR_Catalogue.csv files and folders that match PDR's
  // year-based output structure), so it runs only when the user
  // clicks the "Scan drives for more" button — not automatically on
  // every LDM open.
  //
  // Results are MERGED into the existing discoveredLegacyLibraries
  // list rather than replacing it, and deduped by normalised path so
  // a library found by both SQL and CSV doesn't appear twice. The
  // SQL-source row wins the dedup race (kept as-is, scan result
  // discarded) because the SQL row has authoritative file count +
  // run count from indexed_runs that the CSV/folder-pattern paths
  // don't have.
  const handleScanDrivesForLegacyLibraries = async () => {
    if (isScanningDrives) return;
    setIsScanningDrives(true);
    const toastId = toast.loading('Scanning drives for legacy libraries…', {
      description: 'Looking for PDR catalog files and PDR-style folder structures across your connected drives. This may take a minute on large external drives — your scan results will be saved here so you can close the Library Drive Manager and come back to them.',
    });
    try {
      const res = await (window as any).pdr?.library?.scanForLegacyLibraries?.();
      if (!res?.success || !Array.isArray(res?.data?.candidates)) {
        toast.error('Scan failed', { id: toastId, description: res?.error ?? 'Unknown error' });
        return;
      }
      const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
      // Fresh status + LDM + ignore-list reads, same approach as the
      // SQL discovery — avoids stale React state.
      let currentLibraryNorm: string | null = null;
      try {
        const sres = await (window as any).pdr?.library?.status?.();
        const root = sres?.success ? ((sres.data as LibraryStatus)?.libraryRoot ?? null) : null;
        if (root) currentLibraryNorm = norm(root);
      } catch { /* ignore */ }
      let savedNorms: Set<string> = new Set();
      try {
        const raw = localStorage.getItem('pdr-saved-destinations');
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) {
          savedNorms = new Set(parsed.filter((p: unknown): p is string => typeof p === 'string').map(norm));
        }
      } catch { /* ignore */ }
      let ignoredNorms: Set<string> = new Set();
      try {
        const raw = localStorage.getItem('pdr-ignored-destinations');
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) {
          ignoredNorms = new Set(parsed.filter((p: unknown): p is string => typeof p === 'string').map(norm));
        }
      } catch { /* ignore */ }

      type ScanCandidate = {
        path: string;
        source: 'catalogue-csv' | 'folder-pattern';
        lastSeenAt: string;
        destinationCount?: number;
        currentFileCount: number;
        currentFileCountCapped: boolean;
      };
      const candidates: ScanCandidate[] = res.data.candidates;

      // v2.0.15 hotfix #3 — persist raw scan results so they survive
      // LDM close + reopen. Filtering against the user's live state
      // (current LD, savedDestinations, ignored) happens at render
      // time, so we cache the unfiltered set; that way an Add-to-LDM
      // or Ignore action just updates the relevant list and the
      // render filter naturally removes the row, no cache mutation
      // needed. Overwrites the previous cache (new scan replaces).
      try {
        localStorage.setItem(SCAN_CACHE_KEY, JSON.stringify({
          runAt: new Date().toISOString(),
          candidates,
        }));
      } catch (e) {
        console.warn('[LibraryPanel] scan cache write failed:', e);
        // Non-fatal — the in-session state below still works; only
        // the close-and-come-back persistence is affected.
      }

      // v2.0.15 hotfix #3 — count filterable candidates OUTSIDE the
      // setState callback so the success toast still fires even if
      // LDM was closed mid-scan (React doesn't run setState updaters
      // for unmounted components; toasts inside would never appear).
      // The cache write has already happened above so the persistence
      // path is safe regardless of mount state.
      const visibleCount = candidates.filter(c => {
        const n = norm(c.path);
        if (currentLibraryNorm && n === currentLibraryNorm) return false;
        if (savedNorms.has(n)) return false;
        if (ignoredNorms.has(n)) return false;
        return true;
      }).length;

      if (visibleCount === 0) {
        toast.success('Scan complete — no new libraries found', {
          id: toastId,
          description: 'PDR already knows about every library on your connected drives.',
          duration: 8000,
        });
      } else {
        toast.success(`Scan complete — ${visibleCount} librar${visibleCount === 1 ? 'y' : 'ies'} found`, {
          id: toastId,
          description: 'Open the Library Drive Manager → Discovered libraries to add or ignore each one. Your results are saved.',
          duration: 10000,
        });
      }

      // Re-trigger the discovered-list refresh so the cards render
      // immediately. refreshDiscoveredLegacyLibraries reads from the
      // freshly-written cache + applies all live filters, so we get
      // the same end state as the previous inline merge but with a
      // single source of truth. setState on an unmounted component
      // is a no-op + console warning, never a crash.
      await refreshDiscoveredLegacyLibraries();
    } catch (e) {
      console.warn('[LibraryPanel] handleScanDrivesForLegacyLibraries failed:', e);
      toast.error('Scan failed', { id: toastId, description: String((e as Error)?.message ?? e) });
    } finally {
      setIsScanningDrives(false);
    }
  };

  // v2.0.15 — accept a discovered library and add it to the LDM.
  // Companion to refreshDiscoveredLegacyLibraries above. Idempotent:
  // writing a path that's already in savedDestinations leaves the
  // list unchanged. After write we refresh both savedDestinations
  // (so the new row appears in the main drives list) AND the
  // discovered list (so the card disappears from the discovered
  // section).
  const handleAddDiscoveredToLDM = async (targetPath: string) => {
    // v2.0.15 (Terry 2026-06-04) — OPTIMISTIC UI. Previously this
    // function awaited refreshSavedDestinations (which fans out
    // parallel getDriveDetails IPCs) BEFORE updating the discovered
    // list, so the user saw a perceptible "did anything happen?" gap
    // between click and feedback. Now the discovered card vanishes
    // immediately, the success toast fires immediately, and the
    // localStorage + refresh work runs in the background. The main
    // drives list will populate the new row a few hundred ms later
    // when refreshSavedDestinations finishes — which is fine, the
    // user already has confirmation that the action took effect.
    const SAVED_DESTINATIONS_KEY = 'pdr-saved-destinations';
    const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
    const targetNorm = norm(targetPath);
    const rootName = targetPath.split(/[\\/]/).filter(Boolean).pop() ?? targetPath;

    // Snapshot for rollback if the background work fails.
    const snapshot = discoveredLegacyLibraries;

    // Optimistic UI: card vanishes now.
    setDiscoveredLegacyLibraries(prev => prev.filter(lib => norm(lib.path) !== targetNorm));
    // Optimistic toast — duration bumped to 8s (Terry's request) so
    // the confirmation stays readable while he reviews the LDM
    // change.
    toast.success(`Added "${rootName}" to the Library Drive Manager`, {
      description: 'It now appears in your drives list. Set it as your Library Drive any time.',
      duration: 8000,
    });

    // Background writes + refresh.
    try {
      const raw = localStorage.getItem(SAVED_DESTINATIONS_KEY);
      let existing: string[] = [];
      try {
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) existing = parsed.filter((p): p is string => typeof p === 'string');
      } catch { /* corrupted — start fresh */ }
      if (!existing.some(p => norm(p) === targetNorm)) {
        existing.unshift(targetPath); // newest first, matches App.tsx reconcile
        localStorage.setItem(SAVED_DESTINATIONS_KEY, JSON.stringify(existing));
      }
      await refreshSavedDestinations();
    } catch (e) {
      console.warn('[LibraryPanel] handleAddDiscoveredToLDM failed:', e);
      toast.error("Couldn't add to the list", { description: String((e as Error)?.message ?? e) });
      // Rollback the optimistic card removal so the user can retry.
      setDiscoveredLegacyLibraries(snapshot);
    }
  };

  // v2.0.15 — ignore a discovered library so it stops appearing in
  // the discovered section. Writes to the SAME ignore list used by
  // handleRemoveSavedDestination + App.tsx's start-up reconcile so
  // the rule "removed paths stay removed across restarts" extends
  // naturally to discovered paths too.
  const handleIgnoreDiscovered = async (targetPath: string) => {
    const IGNORED_DESTINATIONS_KEY = 'pdr-ignored-destinations';
    try {
      const raw = localStorage.getItem(IGNORED_DESTINATIONS_KEY);
      let ignored: string[] = [];
      try {
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) ignored = parsed.filter((p): p is string => typeof p === 'string');
      } catch { /* corrupted — start fresh */ }
      const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
      if (!ignored.some(p => norm(p) === norm(targetPath))) {
        ignored.push(targetPath);
        localStorage.setItem(IGNORED_DESTINATIONS_KEY, JSON.stringify(ignored));
      }
      await refreshDiscoveredLegacyLibraries();
    } catch (e) {
      console.warn('[LibraryPanel] handleIgnoreDiscovered failed:', e);
    }
  };

  const refreshSavedDestinations = async () => {
    try {
      const raw = localStorage.getItem(SAVED_DESTINATIONS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      const list: string[] = Array.isArray(parsed)
        ? parsed.filter((p): p is string => typeof p === 'string' && p.length > 0)
        : [];
      setSavedDestinations(list);
      // Parallel-fetch details for each path. Errors are per-path:
      // a single failure doesn't poison the whole map.
      const detailEntries = await Promise.all(list.map(async (p) => {
        try {
          const res = await (window as any).pdr?.library?.getDriveDetails?.(p);
          return [p, res?.success ? (res.data as DriveDetails) : null] as const;
        } catch {
          return [p, null] as const;
        }
      }));
      const detailMap: Record<string, DriveDetails | null> = {};
      detailEntries.forEach(([p, d]) => { detailMap[p] = d; });
      setSavedDestinationDetails(detailMap);
    } catch (e) {
      console.warn('[LibraryPanel] saved-destinations refresh failed:', e);
    }
  };

  // Refresh-all — fan out every status/data fetch in parallel. The
  // user-facing "Refresh" icon button drives this directly so the
  // panel feels responsive (spinner stays on while the slowest call
  // — usually PowerShell on a sleepy USB drive — completes).
  const refreshAll = async () => {
    setIsRefreshing(true);
    try {
      // First pass: fetch status + saved-destinations (needed to know
      // which paths to query for per-path counts) in parallel with
      // the other independent fetches.
      await Promise.all([
        refreshLastDbBackupAt(),
        refreshStatus(),
        refreshSuggestion(),
        refreshDriveDetails(),
        refreshIndexedDrives(),
        refreshSavedDestinations(),
      ]);
      // Second pass: per-path indexed-file counts for every library-
      // root row (currentPath + savedDestinations). Read fresh from
      // state via the underlying sources so we don't rely on stale
      // local state references after the awaited fetches.
      const currentRoot = (() => {
        try {
          const raw = localStorage.getItem(SAVED_DESTINATIONS_KEY);
          const parsed = raw ? JSON.parse(raw) : [];
          const list: string[] = Array.isArray(parsed)
            ? parsed.filter((p): p is string => typeof p === 'string' && p.length > 0)
            : [];
          return list;
        } catch { return [] as string[]; }
      })();
      // Pull the live status snapshot's libraryRoot too so the
      // currentPath row gets its own count even when it isn't in
      // savedDestinations.
      let attachedRoot: string | null = null;
      try {
        const sres = await (window as any).pdr?.library?.status?.();
        if (sres?.success) attachedRoot = (sres.data as LibraryStatus)?.libraryRoot ?? null;
      } catch {}
      const paths = [...(attachedRoot ? [attachedRoot] : []), ...currentRoot];
      await refreshPathCounts(paths);
      // Background-fetch on-disk counts so the per-row "Index" pill
      // can render whenever there's a gap. Intentionally NOT awaited
      // here — the LDM stays interactive while the filesystem walks
      // run in parallel; pills appear progressively as each path's
      // probe resolves.
      void refreshOnDiskCounts(paths);
      // v2.0.15 — discovered legacy libraries. Runs AFTER status +
      // savedDestinations resolve because the filter depends on
      // both (current Library Drive must be known to exclude it,
      // savedDestinations must be known to skip already-in-LDM
      // paths). Cheap — single SQL GROUP BY against indexed_runs
      // followed by per-path fs.existsSync; doesn't block the user.
      void refreshDiscoveredLegacyLibraries();
    } finally {
      setIsRefreshing(false);
      setInitialDataLoaded(true);
    }
  };

  useEffect(() => {
    if (isOpen) {
      // Reset the loaded flag every open so the dispatcher gates on
      // fresh data, not whatever was cached from the last session.
      setInitialDataLoaded(false);
      // Initial fetches — fired in parallel so the management view
      // doesn't flash through half-rendered states.
      void refreshAll();
      setStep('status');
      setPendingAction(null);
      setPendingDetection(null);
      setKeyInput('');
      setKeyError(null);
      setErrorMsg(null);
      setUnsafeReason(null);
      setSyncResult(null);
    }
  }, [isOpen]);

  // Catch-up indexer (v2.0.9) finished — re-fetch the per-row file
  // counts so an LDM that's currently open updates its "X photos"
  // figures immediately. Without this the LDM keeps showing the
  // pre-index counts until next open. Mirrors SearchPanel + Memories
  // listeners on the same event.
  useEffect(() => {
    if (!isOpen) return;
    const handler = () => { void refreshAll(); };
    window.addEventListener('pdr:libraryRebuildComplete', handler);
    return () => window.removeEventListener('pdr:libraryRebuildComplete', handler);
  }, [isOpen]);

  // Receive picker results from workspace. When the LDM's Select
  // radio fires `pdr:pickLibraryDriveFolder`, workspace opens the
  // in-app FolderBrowserModal; on select it dispatches
  // `pdr:libraryDriveFolderPicked` with the chosen path. We then run
  // the same inspectAndRoute flow as before to detect sidecar /
  // empty / unsafe and route to the right next step.
  useEffect(() => {
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent<{ path?: string }>).detail;
      if (!detail?.path || !isOpen) return;
      void inspectAndRoute(detail.path);
    };
    window.addEventListener('pdr:libraryDriveFolderPicked', handler as EventListener);
    return () => window.removeEventListener('pdr:libraryDriveFolderPicked', handler as EventListener);
  }, [isOpen]);

  // Auto-sync mismatch useEffect REMOVED (2026-05-15). It was overwriting
  // a freshly-set destinationPath with a stale status.libraryRoot —
  // e.g. Terry ran Fix to D:\1. Photos\1. PDR Library Drive, which
  // correctly set destinationPath there, but a leftover H:\ libraryRoot
  // from an earlier buggy radio-click attach was then being copied OVER
  // the new D: destinationPath when LDM next opened. The bug it was
  // originally guarding against (attachAsNew not syncing destinationPath)
  // is now handled at the source — runPendingAction explicitly calls
  // settings.set('destinationPath', libraryRoot) when attach succeeds,
  // so settings.destinationPath and status.libraryRoot are kept in sync
  // by deliberate user action, not by guesswork.

  const handleClose = () => {
    setStep('status');
    setPendingAction(null);
    setPendingDetection(null);
    setKeyInput('');
    setKeyError(null);
    setErrorMsg(null);
    // Always clear pickMode on close so a normal-mode reopen isn't
    // poisoned by a caller from a previous pick-mode session.
    setPickMode(null);
    onClose();
  };

  // Pick-mode entry point. External callers (e.g. Parallel Library's
  // Browse button) dispatch `pdr:openLibraryPanelForPick` with detail
  // identifying the caller. The LDM opens in pick-mode: clicking a
  // drive returns its path to the caller instead of attaching it as
  // the active Library Drive. caller name is echoed back in the
  // `pdr:libraryDrivePicked` dispatch so multiple potential callers
  // can each filter for their own pick event.
  useEffect(() => {
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent<{ caller?: string }>).detail ?? {};
      setPickMode({ caller: detail.caller || 'unknown' });
    };
    window.addEventListener('pdr:openLibraryPanelForPick', handler as EventListener);
    return () => window.removeEventListener('pdr:openLibraryPanelForPick', handler as EventListener);
  }, []);

  // Inspect a path: detect whether a sidecar already exists there →
  // branch to restore vs. set-as-new. We used to BLOCK on internal
  // drives (route to a drive-unsafe step), but the introduction of
  // Library DB mirroring + the Download Library DB action means the
  // user no longer has to use an external drive for portability —
  // they can keep an offsite copy of the DB instead. So the drive-
  // type rule is now ADVISORY: we surface the reason in the next
  // step (via unsafeReason state) so the user sees the trade-off, but
  // we don't refuse the choice.
  const inspectAndRoute = async (path: string) => {
    setStep('picker-loading');
    try {
      const driveRes = await (window as any).pdr?.library?.detectDriveType(path);
      if (driveRes?.success) {
        const info = driveRes.data as DriveTypeInfo;
        // Save the reason so the detected-empty / detected-existing
        // steps can show an inline advisory about the trade-off (and
        // remind the user about the Download Library DB safeguard),
        // but don't block.
        setUnsafeReason(info.isSafeForLibrary ? null : info.reason);
      } else {
        setUnsafeReason(null);
      }
      const res = await (window as any).pdr?.library?.detectSidecar(path);
      if (!res?.success) {
        setErrorMsg(res?.error || 'Could not inspect that folder.');
        setStep('error');
        return;
      }
      const detection = res.data as SidecarDetection;
      setPendingDetection(detection);
      // AppData-wins model (2026-05-15). The user already has a
      // library attached AND is using the LDM to switch — that means
      // their AppData DB is the source of truth, not whatever stale
      // sidecar might happen to sit at the target location. Always
      // route to attachAsNew so the new sidecar is overwritten FROM
      // AppData (and the old sidecar gets cleaned up by the backend).
      // The detected-existing / attachFromSidecar path is only valid
      // for fresh-install restore — where the user has NO attached
      // library AND is restoring from a sidecar — and that flow has
      // its own entry point elsewhere in the wizard.
      const userHasAttachedLibrary = !!status?.attached;
      if (detection.dbExists && !userHasAttachedLibrary) {
        // True bootstrap/restore: empty AppData + sidecar at target.
        setPendingAction({ kind: 'attachFromSidecar', libraryRoot: path });
        setStep('detected-existing');
      } else {
        // Normal LDM switch (or first attach to an empty location):
        // AppData wins. attachAsNew will mirror AppData → new sidecar
        // and delete the old sidecar.
        setPendingAction({ kind: 'attachAsNew', libraryRoot: path });
        setStep('detected-empty');
      }
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStep('error');
    }
  };

  // "Set up a new library on another drive" — gates on whether the
  // user already has a configured Library Drive. If so, route through
  // the set-up-confirmation step first so they read what they're
  // walking away from (current path + photo count) before the SLD
  // picker opens. First-time users with no existing library skip the
  // confirmation and go straight to the picker.
  //
  // Premium UX rationale (Terry, 2026-05-14): clicking the Advanced
  // link without acknowledging the existing library makes an
  // accidental parallel library trivially easy. Saying "you already
  // have a library at D:\1. Photos\..." raises the friction in
  // proportion to the consequence.
  const handleConnectClick = () => {
    const hasExistingLibrary = !!(status?.attached && status.libraryRoot) || !!suggestedPath;
    if (hasExistingLibrary) {
      setStep('set-up-confirmation');
    } else {
      window.dispatchEvent(new CustomEvent('pdr:pickLibraryDriveFolder', { detail: {} }));
    }
  };

  const handleUseSuggestedPath = async () => {
    if (!suggestedPath) return;
    await inspectAndRoute(suggestedPath);
  };

  const handleTakeOverClick = () => {
    setPendingAction({ kind: 'takeOverWriter' });
    setKeyInput('');
    setKeyError(null);
    setStep('verify-key');
  };

  // Force a one-off mirror to the sidecar. Only callable when this
  // device is the writer (the IPC silently no-ops otherwise — readers
  // can't write the mirror by design). Inline status feedback so the
  // user sees confirmation that something happened.
  const handleSyncNow = async () => {
    setSyncingNow(true);
    setSyncResult(null);
    try {
      const res = await (window as any).pdr?.library?.mirrorNow?.();
      if (res?.success) {
        setSyncResult({ ok: true, message: 'Library Drive synced.' });
        // Re-fetch status so the user sees the updated last-sync time.
        await refreshAll();
      } else {
        setSyncResult({ ok: false, message: res?.error || 'Sync failed.' });
      }
    } catch (e) {
      setSyncResult({ ok: false, message: (e as Error).message });
    } finally {
      setSyncingNow(false);
    }
  };

  // Export the Library DB to a user-chosen location. Premium safeguard
  // (Terry's framing): now that we mirror the DB to a sidecar AND let
  // users export it manually, the user doesn't need an external drive
  // to keep their library recoverable — they can keep the DB file
  // somewhere else (email, cloud, second drive). Inline status via
  // syncResult (reusing the existing pill below the actions row).
  const handleExportDb = async () => {
    setSyncResult(null);
    setIsBackingUp(true);
    try {
      const res = await (window as any).pdr?.library?.exportDb?.();
      if (res?.success && res.data?.path) {
        setSyncResult({ ok: true, message: `Library DB saved to ${res.data.path}` });
        // Record the backup timestamp + clear any snooze so the
        // pill on the drive row immediately reflects the success
        // (state flips to "Backed up just now" / subtle green).
        try {
          const now = new Date().toISOString();
          await (window as any).pdr?.settings?.set?.('lastDbBackupAt', now);
          await (window as any).pdr?.settings?.set?.('dbBackupReminderSnoozedAt', null);
          setLastDbBackupAt(now);
        } catch (e) {
          console.warn('[LibraryPanel] lastDbBackupAt write failed (non-fatal):', e);
        }
      } else if (res?.error && res.error !== 'cancelled') {
        setSyncResult({ ok: false, message: res.error });
      }
    } catch (e) {
      setSyncResult({ ok: false, message: (e as Error).message });
    } finally {
      setIsBackingUp(false);
    }
  };

  // v2.0.11 — refresh a single library row's search index. Sister of
  // the Dashboard banner's "Refresh now" action, but scoped to one
  // path so the user can pick which library to back-fill without
  // having to refresh all stale ones in a single batch. Uses the
  // same search:rebuildFromLibraries IPC + rebuildProgress
  // subscription as the banner; toast follows the user across
  // views. On success the on-disk count is refreshed so the pill
  // disappears (or shrinks) without a manual reload.
  //
  // v2.0.15 verb-rename — was handleIndexLibrary. The user-facing
  // verb is now "Refresh" everywhere (replacing "Index" / "Catalogue")
  // because "Index" reads as IT jargon and "Catalogue" collides with
  // PDR_Catalogue.csv. Internal variables (indexingPaths, search
  // index DB concept) keep the noun "index" — only the user-facing
  // verb changed.
  const handleRefreshLibrary = async (targetPath: string) => {
    if (indexingPaths.has(targetPath)) return;   // this row is already refreshing
    // v3.0.1 (Terry 2026-07-12) — route through the SINGLE shared refresh owner
    // (client/src/lib/library-refresh.ts) so the LDM and the Dashboard "isn't
    // fully searchable" banner can no longer EACH spawn their own progress
    // toast + rebuild. Two concurrent rebuilds also fought over the one
    // ExifTool subprocess (the first to finish killed it under the second) —
    // that's what "2 toast screens ... freaking out" was. If a refresh is
    // already running (from either surface), don't start a second; just say so.
    if (isLibraryRefreshRunning()) {
      toast.info('A library refresh is already running', {
        description: 'Please wait for it to finish, then refresh this library.',
        duration: 5000,
      });
      return;
    }
    setIndexingPaths(prev => new Set(prev).add(targetPath));
    // The shared owner drives the toast; onProgress feeds THIS row's inline
    // "Refreshing N%" pill, and onSettled clears the pill + re-probes counts.
    await runLibraryRefresh([targetPath], {
      onProgress: (p) => {
        if (p.phase === 'complete') return;            // terminal (rootPath=''): handled by onSettled
        if (p.rootPath !== targetPath) return;          // ignore other roots' events
        // Capture the narrowed phase in a const — the narrowing from the early
        // return above doesn't carry into the nested setState closure otherwise.
        const phase = p.phase, current = p.current, total = p.total;
        setIndexingProgress(prev => ({ ...prev, [targetPath]: { phase, current, total } }));
      },
      onSettled: () => {
        setIndexingPaths(prev => { const next = new Set(prev); next.delete(targetPath); return next; });
        setIndexingProgress(prev => { const next = { ...prev }; delete next[targetPath]; return next; });
        void refreshOnDiskCounts([targetPath]);
        void refreshPathCounts([targetPath]);
      },
    });
  };

  // v2.0.15 (Terry 2026-06-04) — remove a saved destination from the
  // LDM list. Companion to the per-row "Remove from list" kebab item.
  //
  // Two stores have to agree for a removal to actually stick:
  //   1. pdr-saved-destinations — the LDM list itself.
  //   2. pdr-ignored-destinations — a persistent ignore list so the
  //      App.tsx start-up reconcile (which re-adds destinations from
  //      saved Fix reports) doesn't bring the path back next launch.
  //      Without (2) the user would remove a path, restart PDR, and
  //      watch it reappear from a Fix report — silent and confusing.
  //
  // Files on disk + indexed search data are NOT touched — this is a
  // list-membership change, not a deletion. The confirmation makes
  // that clear so the user knows they can re-add the folder/drive
  // any time by picking it again.
  const handleRemoveSavedDestination = async (targetPath: string) => {
    const SAVED_DESTINATIONS_KEY = 'pdr-saved-destinations';
    const IGNORED_DESTINATIONS_KEY = 'pdr-ignored-destinations';
    const rootName = targetPath.split(/[\\/]/).filter(Boolean).pop() ?? targetPath;
    const ok = await promptConfirm({
      eyebrow: 'REMOVE FROM LIBRARY DRIVE MANAGER',
      title: `Remove "${rootName}" from the list?`,
      message: (
        <>
          This only changes which libraries appear in this manager. Your files on disk are untouched, the photos remain searchable in <strong className="text-foreground">Search &amp; Discovery</strong>, <strong className="text-foreground">Memories</strong> and the <strong className="text-foreground">Date Editor</strong>, and your reports history is unchanged. Re-add the library any time by picking the folder/drive again.
        </>
      ),
      confirmLabel: 'Remove from list',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;

    // v2.0.15 (Terry 2026-06-04) — OPTIMISTIC UI. Mirror of the
    // Add-to-LDM treatment. The savedDestinations state drives the
    // main drives list; updating it directly here makes the row
    // vanish immediately. localStorage writes + refresh fan-out
    // happens in the background.
    const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
    const targetNorm = norm(targetPath);
    const snapshot = savedDestinations;

    // Optimistic UI: row disappears now.
    setSavedDestinations(prev => prev.filter(p => norm(p) !== targetNorm));
    // Optimistic toast — 8s duration to match the Add-to-LDM toast.
    toast.success(`"${rootName}" removed from the list`, {
      description: 'Files on disk are untouched. Pick the folder/drive again any time to re-add it.',
      duration: 8000,
    });

    try {
      // (1) Strip from the saved-destinations list.
      const rawSaved = localStorage.getItem(SAVED_DESTINATIONS_KEY);
      let saved: string[] = [];
      try {
        const parsed = rawSaved ? JSON.parse(rawSaved) : [];
        if (Array.isArray(parsed)) saved = parsed.filter((p): p is string => typeof p === 'string');
      } catch { /* corrupted — treat as empty */ }
      const filtered = saved.filter(p => norm(p) !== targetNorm);
      localStorage.setItem(SAVED_DESTINATIONS_KEY, JSON.stringify(filtered));

      // (2) Add to the ignore list so App.tsx's start-up reconcile
      // doesn't re-restore this path from saved Fix reports.
      const rawIgnored = localStorage.getItem(IGNORED_DESTINATIONS_KEY);
      let ignored: string[] = [];
      try {
        const parsed = rawIgnored ? JSON.parse(rawIgnored) : [];
        if (Array.isArray(parsed)) ignored = parsed.filter((p): p is string => typeof p === 'string');
      } catch { /* corrupted — treat as empty */ }
      if (!ignored.some(p => norm(p) === targetNorm)) {
        ignored.push(targetPath);
        localStorage.setItem(IGNORED_DESTINATIONS_KEY, JSON.stringify(ignored));
      }

      // Background refresh — picks up the localStorage change and
      // re-fetches per-path drive details for the remaining rows.
      await refreshSavedDestinations();
    } catch (e) {
      console.warn('[LibraryPanel] handleRemoveSavedDestination failed:', e);
      toast.error('Couldn\'t remove from list', { description: String((e as Error)?.message ?? e) });
      // Rollback the optimistic row removal.
      setSavedDestinations(snapshot);
    }
  };

  // Copy a drive path to the clipboard. Used by the per-row kebab menu
  // (the "..." dropdown). Quiet success — the menu closes on click,
  // which is feedback enough that the action fired.
  const handleCopyPath = async (targetPath: string) => {
    try {
      await navigator.clipboard.writeText(targetPath);
    } catch (e) {
      console.warn('[LibraryPanel] copy path failed:', e);
    }
  };

  // Open a path in the OS file manager (Explorer on Windows). Per-row
  // spinner via explorerOpening so multiple "Open" buttons in the
  // indexed-drives list can each track their own state independently.
  const handleOpenInExplorer = async (targetPath: string) => {
    setExplorerOpening(targetPath);
    try {
      await (window as any).pdr?.library?.openInExplorer?.(targetPath);
    } catch (e) {
      console.warn('[LibraryPanel] openInExplorer failed:', e);
    } finally {
      // Brief hold so the icon spinner doesn't blink — shell.openPath is
      // fast and would otherwise show no feedback at all.
      setTimeout(() => setExplorerOpening(null), 200);
    }
  };

  const handleDisconnect = async () => {
    setStep('processing');
    setErrorMsg(null);
    try {
      const res = await (window as any).pdr?.library?.disconnect();
      if (res?.success) {
        setSuccessMsg('This device is no longer linked to a library.');
        setStep('success');
        await refreshStatus();
      } else {
        setErrorMsg(res?.error || 'Could not disconnect.');
        setStep('error');
      }
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStep('error');
    }
  };

  const runPendingAction = async () => {
    if (!pendingAction || !storedLicenseKey) return;
    setStep('processing');
    setErrorMsg(null);
    try {
      const deviceName = (status?.thisDeviceId?.slice(0, 8) || 'this') + '-device';
      let res: any;
      if (pendingAction.kind === 'attachAsNew') {
        res = await (window as any).pdr?.library?.attachAsNew({
          libraryRoot: pendingAction.libraryRoot,
          licenseKey: storedLicenseKey,
          deviceName,
        });
        if (res?.success) setSuccessMsg('Library set up. PDR will keep a hidden mirror on this drive so any device can reconnect instantly.');
      } else if (pendingAction.kind === 'attachFromSidecar') {
        res = await (window as any).pdr?.library?.attachFromSidecar({
          libraryRoot: pendingAction.libraryRoot,
          licenseKey: storedLicenseKey,
          deviceName,
        });
        if (res?.success) setSuccessMsg('Library restored. All your faces, names, dates and trees are back. Restart PDR to refresh views.');
      } else if (pendingAction.kind === 'takeOverWriter') {
        if (!status?.libraryRoot) {
          setErrorMsg('No library attached.');
          setStep('error');
          return;
        }
        res = await (window as any).pdr?.library?.takeOverWriter({
          libraryRoot: status.libraryRoot,
          licenseKey: storedLicenseKey,
          deviceName,
        });
        if (res?.success) setSuccessMsg('This device is now the writer for the library.');
      }
      if (res?.success) {
        // Keep destinationPath in sync with the new library root so
        // every part of the app — the offline banner, the row Offline
        // pill, the home-screen "set and ready" copy, Fix runs — uses
        // the same path. Without this, attachAsNew updates the library
        // sidecar to H: but settings.destinationPath stays at the old
        // value, and the panel ends up showing the new drive with a
        // stale "Offline" pill because checkDestinationOnline still
        // points at the old destination.
        if (pendingAction.kind === 'attachAsNew' || pendingAction.kind === 'attachFromSidecar') {
          try {
            await (window as any).pdr?.settings?.set?.('destinationPath', pendingAction.libraryRoot);
          } catch {
            // Best-effort — the library is attached either way; the
            // banner just won't auto-clear until the next workspace
            // mount.
          }
          // Tell the workspace its banner state may be stale — let
          // it re-check destinationOnline and clear the banner if the
          // new drive is reachable.
          window.dispatchEvent(new CustomEvent('pdr:libraryDriveChanged'));
        }
        setStep('success');
        await refreshAll();
      } else {
        setErrorMsg(res?.error || 'Action failed.');
        setStep('error');
      }
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStep('error');
    }
  };

  const handleConfirmKey = () => {
    if (!storedLicenseKey) return;
    if (keyInput.trim().toUpperCase() !== storedLicenseKey.trim().toUpperCase()) {
      setKeyError('That key does not match the license on this device.');
      return;
    }
    setKeyError(null);
    void runPendingAction();
  };

  if (!isOpen) return null;

  // ─── Renderers ───────────────────────────────────────────────────────────
  const renderHeader = (title: string, subtitle?: React.ReactNode, palette: 'primary' | 'rose' | 'emerald' = 'primary', subtitleAlign: 'center' | 'left' | 'justify' = 'center') => {
    const subtitleAlignClass = subtitleAlign === 'left' ? 'text-left' : subtitleAlign === 'justify' ? 'text-justify' : '';
    const gradient = palette === 'rose'
      ? 'from-rose-100 via-rose-50 to-transparent dark:from-rose-950/40 dark:via-rose-950/20'
      : palette === 'emerald'
      ? 'from-emerald-100 via-emerald-50 to-transparent dark:from-emerald-950/40 dark:via-emerald-950/20'
      : 'from-primary/15 via-primary/5 to-transparent';
    const iconWrap = palette === 'rose'
      ? 'from-rose-200 to-rose-50 border-rose-300/60 shadow-rose-500/10 dark:from-rose-700 dark:to-rose-900'
      : palette === 'emerald'
      ? 'from-emerald-200 to-emerald-50 border-emerald-300/60 shadow-emerald-500/10 dark:from-emerald-700 dark:to-emerald-900'
      : 'from-primary/20 to-primary/5 border-primary/20 shadow-primary/10';
    const iconColor = palette === 'rose'
      ? 'text-rose-600 dark:text-rose-400'
      : palette === 'emerald'
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-primary';
    const Icon = palette === 'rose' ? AlertTriangle : palette === 'emerald' ? CheckCircle2 : HardDrive;
    return (
      <div className={`relative bg-gradient-to-br ${gradient} px-6 pt-8 pb-6`}>
        <button onClick={handleClose} className="absolute top-4 right-4 p-2 hover:bg-secondary/50 rounded-full transition-colors" aria-label="Close">
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
        <div className="flex flex-col items-center text-center">
          <motion.div initial={{ scale: 0, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} transition={{ delay: 0.1, type: 'spring', stiffness: 200 }} className={`w-16 h-16 bg-gradient-to-br ${iconWrap} rounded-2xl flex items-center justify-center mb-4 border shadow-lg`}>
            <Icon className={`w-8 h-8 ${iconColor}`} />
          </motion.div>
          <h2 className="text-h1 text-foreground mb-2">{title}</h2>
          {subtitle && <p className={`text-body-muted max-w-sm ${subtitleAlignClass}`}>{subtitle}</p>}
        </div>
      </div>
    );
  };

  // renderStatus — dispatcher. Two faces:
  //
  //   1. Management face (renderManagement): when the user has a Library
  //      Drive configured — either via the legacy destinationPath OR via
  //      the new sidecar-attached flow. This is the default state when
  //      the panel opens for anyone past first-time setup. Shows the
  //      current drive, its online/safe-for-library status, and the
  //      actions you can take on it (change / take over writing /
  //      advanced: set up new / disconnect).
  //
  //   2. Setup wizard face (renderSetupWizard): only shown to truly
  //      fresh installs with neither destinationPath nor sidecar
  //      attachment. The wizard explains what works as a Library Drive
  //      and pushes the big "Connect external drive or NAS" CTA.
  //
  // The previous version conflated both into one renderStatus, with the
  // wizard framing ("Set up your Library Database") shown even to users
  // who already had a destinationPath set — they just hadn't done the
  // sidecar attachment yet. Terry caught this: a configured user
  // shouldn't see a setup wizard, they should see a management view.
  const renderStatus = () => {
    // Wait until the first refreshAll completes before deciding which
    // face to show. Without this gate, the dispatcher renders the
    // setup wizard for ~100-300ms while async data is in flight, then
    // switches to management once status/suggestedPath populate — a
    // visible flash that reads as "another modal appeared briefly".
    if (!initialDataLoaded) return renderInitialLoading();
    const hasLibraryDrive = !!status?.attached || !!suggestedPath;
    return hasLibraryDrive ? renderManagement() : renderSetupWizard();
  };

  // Compact header for the management view. Premium management surfaces
  // (System Preferences, Time Machine, Storage Sense) use a tight
  // left-aligned title with controls on the right — not a wizard-style
  // gradient header with a giant centered icon tile. That big header is
  // still right for the other steps (setup wizard, verify-key, success,
  // error) where it sets the emotional tone; the management view is the
  // user's daily-driver dashboard and should feel utilitarian.
  //
  // Layout: small drive icon (inline, lavender) + h1 title left, Refresh
  // icon button + X close right. Both icons use IconTooltip per
  // STYLE_GUIDE. Border-b separates the header from the scrollable body.
  const renderManagementHeader = () => {
    // Status pill inline with the title — Option A from Terry's
    // review. Replaces the big "Library Drive is offline" health card
    // that used to sit at the top of the body and duplicated the
    // modal title. Healthy state shows no pill (clean header); any
    // amber / slate state shows a small pill with shortLabel + a
    // tooltip carrying the detail copy the card used to display.
    const health = initialDataLoaded ? computeHealth() : null;
    const showPill = !!health && health.tone !== 'emerald';
    const pillClass = !health
      ? ''
      : health.tone === 'amber'
      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
      : health.tone === 'slate'
      ? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
      : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300';
    return (
      <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20 rounded-lg flex items-center justify-center shrink-0">
            <HardDrive className="w-4 h-4 text-primary" />
          </div>
          <h2 className="text-h1 text-foreground truncate">Library Drive Manager</h2>
          {showPill && health && (
            <IconTooltip label={health.detail ?? health.title} side="bottom">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-label cursor-help shrink-0 ${pillClass}`}>
                {health.icon}
                {health.shortLabel}
              </span>
            </IconTooltip>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <IconTooltip label="Refresh library status" side="bottom">
            <button
              onClick={refreshAll}
              disabled={isRefreshing}
              className="p-2 hover:bg-secondary/50 rounded-full text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              aria-label="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
          </IconTooltip>
          <button
            onClick={handleClose}
            className="p-2 hover:bg-secondary/50 rounded-full text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  };

  // Compute the headline health state for the library — the single
  // verdict the user sees BEFORE reading the per-drive details. Priority
  // order picks the most severe condition first so we never tell the
  // user "Library is healthy" when there's an offline drive lurking.
  // Returns:
  //   tone — emerald (success) / amber (caution) / slate (information)
  //   icon — matches the tone
  //   title — short headline, e.g. "Library is healthy"
  //   detail — optional one-line elaboration
  type HealthTone = 'emerald' | 'amber' | 'slate';
  // shortLabel = 1-2 word pill text for the title-bar status indicator
  // (Option A from Terry's review — drop the big health card and put
  // the state in a pill next to the modal title). detail = the longer
  // explanatory copy, surfaced via tooltip on the pill so users who
  // want the context can hover.
  const computeHealth = (): { tone: HealthTone; icon: React.ReactNode; title: string; shortLabel: string; detail?: string } => {
    const attached = !!status?.attached;
    const isWriter = !!status?.isWriter;
    const driveSafe = driveDetails?.isSafeForLibrary ?? suggestedDriveInfo?.isSafeForLibrary ?? true;
    const online = destinationOnline;
    // Offline Library Drive — most pressing user-actionable signal.
    if (suggestedPath && online === false) {
      return {
        tone: 'amber',
        icon: <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />,
        title: 'Library Drive is offline',
        shortLabel: 'Offline',
        detail: attached
          ? 'Your library backup is safe — reconnect the drive to make changes.'
          : 'Reconnect the drive to manage your library.',
      };
    }
    // Internal drives are NOT a problem state any more — with sidecar
    // mirroring + the Download Library DB action, the user can keep
    // their library on internal storage (fast for Fix) and back up
    // the DB to an offsite location. The previous amber treatment
    // penalised users for picking the same drive we recommend for
    // Fix performance — friction without value. The per-row Internal
    // pill (slate, neutral) and tooltip still surface the fact;
    // there's no title-bar warning for internal-only state.
    // Backup not set up — destinationPath exists but no sidecar
    // attachment. Half-configured state.
    if (suggestedPath && !attached) {
      return {
        tone: 'amber',
        icon: <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />,
        title: 'Library backup not set up',
        shortLabel: 'Backup off',
        detail: 'Without it, PDR can\'t restore your face tags, names, dates, and trees on another device.',
      };
    }
    // Read-only — attached but another device holds the writer lock.
    if (attached && !isWriter) {
      return {
        tone: 'slate',
        icon: <Eye className="w-3.5 h-3.5 text-slate-600 dark:text-slate-400" />,
        title: 'Read-only on this device',
        shortLabel: 'Read-only',
        detail: status?.writerDeviceName
          ? `${status.writerDeviceName} is the writer for this library.`
          : 'Another device is the writer for this library.',
      };
    }
    // Healthy — attached + writer + online + safe drive.
    if (attached && isWriter) {
      return {
        tone: 'emerald',
        icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />,
        title: 'Library is healthy',
        shortLabel: 'Healthy',
        detail: 'This device is the writer · Library backup is active.',
      };
    }
    // Fallback — no Library Drive at all (this branch is normally
    // routed to renderSetupWizard, but defensive in case).
    return {
      tone: 'slate',
      icon: <HardDrive className="w-3.5 h-3.5 text-slate-600 dark:text-slate-400" />,
      title: 'No Library Drive set',
      shortLabel: 'Not set',
      detail: 'Pick a drive to start using PDR\'s portability features.',
    };
  };

  // Premium skeleton while the initial data fetch is in flight. The
  // earlier loading state was a small centered spinner with "Reading
  // library status..." — Terry's feedback: "part of me wonders if it
  // will ever load." A spinner alone communicates "I'm working" but
  // doesn't communicate "specific data will appear right here," so
  // the user has nothing to anchor their patience to.
  //
  // The skeleton mirrors the real drive table layout exactly — same
  // summary line, same column header, same row grid — with pulsing
  // bars in place of values. When the real data arrives, rows fill
  // in where their placeholders sit, with no shift. The structural
  // chrome stays put so the modal doesn't pop.
  // Initial-load state. The first version of this was a fake-table
  // skeleton with three blank rows — Terry's critique was right:
  // we don't actually KNOW how many drives the user has until the
  // listIndexedDrives IPC returns, so pretending there will be
  // three of them implies information we don't have, and the empty
  // outlines just made the wait feel longer rather than informative.
  // A single calm centered message is the more honest and more
  // premium answer when the row count is genuinely unknown.
  const renderInitialLoading = () => (
    <>
      {renderManagementHeader()}
      <div className="px-6 py-16 flex flex-col items-center justify-center gap-4">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
        <div className="text-center space-y-1.5">
          <p className="text-h2 text-foreground">One moment — identifying your drives</p>
          <p className="text-body-muted">PDR is checking which drives are connected and how much of your library lives on each. This usually takes a second or two.</p>
        </div>
      </div>
    </>
  );

  // Management view — current Library Drive + status + actions.
  const renderManagement = () => {
    const attached = !!status?.attached;
    const isWriter = !!status?.isWriter;
    // libraryRoot (sidecar-attached) wins over suggestedPath (legacy
    // destinationPath) when both exist — they should agree in practice
    // but the attached one is the authoritative library reference.
    const currentPath = status?.libraryRoot ?? suggestedPath;
    const driveSafe = driveDetails?.isSafeForLibrary ?? suggestedDriveInfo?.isSafeForLibrary ?? true;
    // Match the current Library Drive against the indexedDrives list so
    // we can surface the photo count / total bytes on this specific
    // drive. Falls back to null when the user hasn't indexed anything
    // on the Library Drive yet (e.g. fresh library, sources elsewhere).
    const currentDriveLetter = currentPath ? deriveDriveLetter(currentPath) : null;
    const thisDriveIndexed = currentDriveLetter
      ? indexedDrives.find(d => d.letter === currentDriveLetter) ?? null
      : null;
    // Summary stats — scale of the library at a glance. Sum across
    // EVERY indexed drive for total photos / bytes. Drive count =
    // unique drives the library knows about, including the current
    // Library Drive even if nothing's indexed on it yet.
    const totalPhotos = indexedDrives.reduce((s, d) => s + d.indexedFileCount, 0);
    const totalBytes = indexedDrives.reduce((s, d) => s + d.indexedBytes, 0);
    const driveCount = indexedDrives.length + (currentDriveLetter && !thisDriveIndexed ? 1 : 0);

    // Health verdict — surfaced via the status pill in
    // renderManagementHeader (Option A from Terry's review). The big
    // amber card that used to sit at the top of the body is gone —
    // it duplicated the modal title's "Library Drive" framing and
    // visually dominated the modal for what's really a 1-2 word state.
    const health = computeHealth();

    // ── Unified drive list. Current Library Drive comes first (badged),
    // then every other indexed drive. Per-row data is enriched from
    // driveDetails (current) or the IndexedDrive entry (others). This
    // is the structural change Terry called for: stop treating the
    // current Library Drive as a separate isolated card, treat it as
    // the first row in a list of every drive the library knows about.
    type UnifiedDriveRow = {
      key: string;
      isCurrentLibraryDrive: boolean;
      path: string;
      letter: string | null;
      volumeLabel: string | null;
      driveTypeLabel: string;
      fileSystem: string | null;
      totalBytes: number;
      freeBytes: number;
      online: boolean;
      isSafeForLibrary: boolean;
      indexedFileCount: number;
      indexedBytes: number;
      lastIndexedAt: string | null;
      // Drive-speed metadata (BusType + MediaType from Get-Disk). Used
      // to render a small "USB" / "NVMe" / "SATA SSD" hint in the
      // Capacity cell so users can pick a fast drive without
      // benchmarking. Optional — null when WMI lookup couldn't map
      // the drive letter to a physical disk.
      busType: string | null;
      mediaType: string | null;
      // v2.0.11 — on-disk media-file count for this row's library
      // root, populated by the background refreshOnDiskCounts probe.
      // Drives the per-row "Index" pill when it exceeds
      // indexedFileCount by more than the 5 % slack. null when the
      // probe hasn't completed yet OR the path isn't reachable.
      onDiskCount: number | null;
      // v3.0.1 (Terry 2026-07-12) — on-disk files not indexed ANYWHERE
      // (by filename+size). Drives the pill instead of onDisk−indexed, so a
      // test/backup drive already covered by the real library doesn't nag.
      uncoveredCount: number | null;
    };
    const allDrives: UnifiedDriveRow[] = [];
    if (currentPath) {
      allDrives.push({
        key: currentPath,
        isCurrentLibraryDrive: true,
        path: currentPath,
        letter: currentDriveLetter,
        volumeLabel: driveDetails?.volumeLabel ?? thisDriveIndexed?.volumeLabel ?? null,
        driveTypeLabel: (driveDetails?.driveTypeLabel && driveDetails.driveTypeLabel !== 'unknown')
          ? driveDetails.driveTypeLabel
          : (thisDriveIndexed?.driveTypeLabel ?? 'Drive'),
        fileSystem: driveDetails?.fileSystem ?? null,
        totalBytes: driveDetails?.totalBytes ?? thisDriveIndexed?.totalBytes ?? 0,
        freeBytes: driveDetails?.freeBytes ?? thisDriveIndexed?.freeBytes ?? 0,
        // For the current Library Drive row, prefer driveDetails.online
        // (which checks fs.existsSync(libraryRoot) directly) over
        // destinationOnline (which reads settings.destinationPath).
        // The two can disagree when status.libraryRoot was updated by
        // attachAsNew but settings.destinationPath wasn't — the row
        // then incorrectly shows Offline for a drive that's actually
        // connected.
        online: driveDetails?.online ?? destinationOnline === true,
        isSafeForLibrary: driveSafe,
        // Prefer the per-path count (accurate for this specific
        // library folder) over the per-drive-letter rollup (which
        // over-attributes when multiple libraries share a drive).
        // Falls back to the rollup if the path-count fetch hasn't
        // landed yet or failed.
        indexedFileCount: pathCounts[currentPath]?.indexedFileCount ?? thisDriveIndexed?.indexedFileCount ?? 0,
        indexedBytes: pathCounts[currentPath]?.indexedBytes ?? thisDriveIndexed?.indexedBytes ?? 0,
        lastIndexedAt: pathCounts[currentPath]?.lastIndexedAt ?? thisDriveIndexed?.lastIndexedAt ?? null,
        busType: driveDetails?.busType ?? null,
        mediaType: driveDetails?.mediaType ?? null,
        onDiskCount: onDiskCounts[currentPath] ?? null,
        uncoveredCount: uncoveredCounts[currentPath] ?? null,
      });
    }
    // Compute the set of drive letters already covered by a registered
    // library root (currentPath + savedDestinations). When a drive
    // has at least one library root on it, the bare drive-letter
    // rollup row is redundant — every file the rollup would count is
    // already attributed to the library row. Without this filter,
    // running a Fix that wrote files to "D:\1. Photos\PDR Library
    // Drive" produced TWO D:\ rows: the library row plus a bare D:\
    // row from listIndexedDrives, each showing the same 92 photos
    // (Terry's "duplicate drive" complaint). Library-root rows are
    // always more meaningful than letter rollups, so they win.
    const lettersWithLibraryRoot = new Set<string>();
    if (currentDriveLetter) lettersWithLibraryRoot.add(currentDriveLetter);
    savedDestinations.forEach((p) => {
      // Skip bare drive roots when collecting letters — those don't
      // count as "registered library roots" for this purpose; they're
      // the stale state we're trying to suppress further down.
      if (/^[A-Za-z]:[\\/]?$/.test(p)) return;
      const l = deriveDriveLetter(p);
      if (l) lettersWithLibraryRoot.add(l);
    });

    indexedDrives.forEach((d) => {
      if (d.letter && lettersWithLibraryRoot.has(d.letter)) return;
      allDrives.push({
        key: d.path,
        isCurrentLibraryDrive: false,
        path: d.path,
        letter: d.letter,
        volumeLabel: d.volumeLabel,
        driveTypeLabel: d.driveTypeLabel,
        fileSystem: null,
        totalBytes: d.totalBytes,
        freeBytes: d.freeBytes,
        online: d.online,
        // driveTypeCode 3 = Win32 Fixed disk = internal. Anything else
        // (Removable / Network) is safe-for-library by PDR's rule.
        isSafeForLibrary: d.driveTypeCode !== 3,
        indexedFileCount: d.indexedFileCount,
        indexedBytes: d.indexedBytes,
        lastIndexedAt: d.lastIndexedAt,
        // listIndexedDrives doesn't fetch BusType/MediaType (that's a
        // getDriveDetails-only query). Leaves null; the row's
        // Capacity cell shows file-system without the speed badge.
        busType: null,
        mediaType: null,
        onDiskCount: onDiskCounts[d.path] ?? null,
        uncoveredCount: uncoveredCounts[d.path] ?? null,
      });
    });

    // Merge Saved Destinations — folders the user has previously
    // picked as a Library Drive. Replaces the "every connected drive"
    // merge from the previous version (which showed C: / G: System
    // Reserved / etc. that the user never used). Each saved
    // destination becomes its own row with the FULL folder path —
    // the library is the folder, not the drive root. Photo counts
    // are looked up by drive letter (approximation: a saved
    // destination on D: shows D:'s indexed total, even if multiple
    // libraries share the drive). Premium follow-up: per-path
    // SUBSTR(file_path,…) counts for exact attribution.
    const alreadyListedPaths = new Set(allDrives.map(d => d.path.replace(/[\\/]+$/, '').toLowerCase()));
    savedDestinations.forEach((savedPath) => {
      // Skip bare drive roots ("D:\" / "D:") — these are leftover
      // state from someone picking a bare drive as a destination, not
      // a real library folder. If kept they appear as a phantom row
      // next to any actual library root on the same drive (Terry's
      // "D:\ duplicate" complaint). A library folder is always a
      // specific path inside the drive, never the drive itself.
      if (/^[A-Za-z]:[\\/]?$/.test(savedPath)) return;
      const normalised = savedPath.replace(/[\\/]+$/, '').toLowerCase();
      if (alreadyListedPaths.has(normalised)) return;
      const details = savedDestinationDetails[savedPath] ?? null;
      const letter = details?.letter ?? deriveDriveLetter(savedPath);
      const driveIndexed = letter ? indexedDrives.find(d => d.letter === letter) : null;
      allDrives.push({
        key: savedPath,
        isCurrentLibraryDrive: false,
        path: savedPath,
        letter,
        volumeLabel: details?.volumeLabel ?? null,
        driveTypeLabel: details?.driveTypeLabel && details.driveTypeLabel !== 'unknown'
          ? details.driveTypeLabel
          : 'Drive',
        fileSystem: details?.fileSystem ?? null,
        totalBytes: details?.totalBytes ?? 0,
        freeBytes: details?.freeBytes ?? 0,
        online: details?.online ?? false,
        isSafeForLibrary: details?.isSafeForLibrary ?? true,
        // Per-path indexed count (v2.0.6 — Terry's report: two
        // folders on D: both showed 99 photos because the rollup
        // was per-letter). Falls back to the per-letter rollup if
        // the path-count fetch is still in flight or failed.
        indexedFileCount: pathCounts[savedPath]?.indexedFileCount ?? driveIndexed?.indexedFileCount ?? 0,
        indexedBytes: pathCounts[savedPath]?.indexedBytes ?? driveIndexed?.indexedBytes ?? 0,
        lastIndexedAt: pathCounts[savedPath]?.lastIndexedAt ?? driveIndexed?.lastIndexedAt ?? null,
        busType: details?.busType ?? null,
        mediaType: details?.mediaType ?? null,
        onDiskCount: onDiskCounts[savedPath] ?? null,
        uncoveredCount: uncoveredCounts[savedPath] ?? null,
      });
    });

    // ── Master Library detection. If a non-current drive holds the
    // overwhelming majority of the user's indexed photos, surface it
    // as the recommended Library Drive. Terry's framing: "the drive
    // that's had all the majority of files added to it should really
    // be the CTA." This makes PDR actively help the user pick the
    // right drive instead of leaving them to figure it out.
    //
    // Heuristic: most-indexed drive (excluding current Library Drive)
    // qualifies if it has > 60% of total indexed photos AND at least
    // 100 files. Below that threshold, the user's library is too
    // evenly spread to make a confident recommendation.
    const masterDrive: UnifiedDriveRow | null = (() => {
      const candidates = allDrives.filter(d => !d.isCurrentLibraryDrive && d.indexedFileCount > 0);
      if (candidates.length === 0) return null;
      const top = candidates.reduce((best, d) => d.indexedFileCount > best.indexedFileCount ? d : best, candidates[0]);
      if (top.indexedFileCount < 100) return null;
      if (totalPhotos > 0 && top.indexedFileCount / totalPhotos < 0.6) return null;
      return top;
    })();

    // ── Reorder so the recommended Master Library row appears FIRST.
    // Terry's call: the drive PDR is recommending should be the most
    // visible — pulled to the top of the list rather than buried
    // alphabetically below the current Library Drive.
    const orderedDrives: UnifiedDriveRow[] = masterDrive
      ? [masterDrive, ...allDrives.filter(d => d.key !== masterDrive.key)]
      : allDrives;

    return (
      <>
        {renderManagementHeader()}
        {/* Body — flex-1 fills the modal's min-h-[600px] floor, with
            internal scroll for tall content. The verdict-card that
            used to sit at the top is gone (Option A); the status pill
            in renderManagementHeader carries that signal now. */}
        <div className="px-6 pb-6 pt-4 space-y-4 overflow-y-auto flex-1 min-h-0">
          {/* ── Summary stats — scale at a glance. */}
          {(totalPhotos > 0 || driveCount > 0) && (
            <div className="px-1">
              <p className="text-body text-foreground">
                <span className="font-medium">{totalPhotos.toLocaleString()}</span> photos
                {totalBytes > 0 && <span> · {formatBytes(totalBytes)}</span>}
                {driveCount > 0 && <span> · {driveCount} {driveCount === 1 ? 'drive' : 'drives'}</span>}
              </p>
              {attached && status?.lastAttachedAt && (
                <p className="text-caption mt-0.5">Last synced {formatRelativeTime(status.lastAttachedAt)}</p>
              )}
            </div>
          )}

          {/* ── Drives in your library — UNIFIED list. The current
                Library Drive is the first row (badged in lavender);
                every other indexed drive follows. Each row is compact
                horizontally — identity + meta + status pills on the
                left, contextual action button(s) on the right. Per-row
                actions replace the abstract "Change Library Drive"
                button that confused Terry — clicking "Set as Library
                Drive" on a specific row is the unambiguous answer to
                "which drive do you want?". */}
          <section>
            <p className="text-caption uppercase tracking-wider mb-2">Drives in your library</p>
            {allDrives.length === 0 ? (
              <div className="rounded-xl border border-border bg-secondary/10 p-3">
                <p className="text-body-muted">No drives have been indexed yet. Run Fix on a folder to start building your library.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {/* Master Library recommendation banner — shown when a
                    non-current drive holds the overwhelming majority
                    of the user's indexed photos. PDR doing the work of
                    pointing the user at the obvious choice rather than
                    making them figure it out from the row data. */}
                {masterDrive && (
                  <div className="rounded-lg border border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-950/20 p-2.5 mb-2 flex items-start gap-2">
                    <Sparkles className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                    <p className="text-body-muted">
                      {/* v2.0.15 (Terry 2026-06-04) — show the actual
                          library FOLDER path, not just the drive letter.
                          The previous `masterDrive.letter ?? path` line
                          collapsed any folder-on-D: row into a bare "D:",
                          which read as "your entire D drive is your
                          master library" — actively misleading when the
                          user has multiple library folders on D: and
                          only one of them is the actual master. With
                          the full path, the recommendation points at
                          the specific folder PDR thinks is the master.
                          Bare-letter rows (no library folder on the
                          drive) still render fine because `.path` is
                          "D:\" for those — same visual result as
                          before in that case. */}
                      <span className="text-foreground font-medium">{masterDrive.path}</span>
                      {masterDrive.volumeLabel && <span> ({masterDrive.volumeLabel})</span>}
                      {' '}looks to be your master library — most of your photos live here. Set it as your Library Drive to enable backup.
                    </p>
                  </div>
                )}

                {/* Column header row — Letter + Name collapsed into a
                    single Path column (Terry's call: the library IS
                    the folder, so show its full path). Select stays
                    centred above the radio. */}
                <div className="grid grid-cols-[minmax(12rem,2fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_3rem_2rem] gap-3 px-3 pb-1 text-caption uppercase tracking-wider">
                  <div>Path</div>
                  <div>Status</div>
                  <div>Files</div>
                  <div>Capacity</div>
                  <div className="text-center">Select</div>
                  <div></div>
                </div>

                {/* Drive rows wrapped in RadioGroup — the Select column
                    uses the RadioGroupItem primitive (one per row)
                    instead of a "Set as Library Drive" button. Radio
                    is the correct semantic: ONE drive can be the
                    Library Drive at a time, the current one shows as
                    filled, clicking an empty one triggers the inspect-
                    and-route workflow. The RadioGroup value reflects
                    the current Library Drive; clicking a different
                    item fires onValueChange. We keep RadioGroup as a
                    controlled component so the visual selection
                    doesn't change until the inspect-and-route flow
                    completes and the panel re-refreshes. */}
                <RadioGroup
                  // Use the row's FULL PATH as the unique key, not
                  // the drive letter. Different library folders on
                  // the same drive (D:\1. Photos\1. PDR Library
                  // Drive vs D:\1. Photos\Test) shared the same
                  // letter "D:" — both rows then rendered as checked
                  // because RadioGroup picks all items matching the
                  // current value. Terry's report 2026-05-15: "I
                  // just tried swapping my LD to a different folder
                  // in the D drive, and now it's showing both as
                  // selected in the LDM." Full path is unique per
                  // row, so only one matches at a time. In pick mode
                  // no row is pre-selected (no "current" yet).
                  value={pickMode ? '' : (allDrives.find(d => d.isCurrentLibraryDrive)?.path ?? '')}
                  onValueChange={(value) => {
                    const target = orderedDrives.find(d => d.path === value);
                    if (!target) return;

                    // Pick-mode path (v2.0.6) — caller wants a folder
                    // path, not an attach action. Dispatch the picked
                    // path back to whoever opened the LDM in this
                    // mode and close. Skip inspectAndRoute entirely.
                    if (pickMode) {
                      window.dispatchEvent(new CustomEvent('pdr:libraryDrivePicked', {
                        detail: { caller: pickMode.caller, path: target.path },
                      }));
                      setPickMode(null);
                      handleClose();
                      return;
                    }

                    if (target.isCurrentLibraryDrive) return;

                    // Two paths from here:
                    //
                    // 1) The target row IS already a specific library
                    //    folder (e.g. "D:\1. Photos\1. PDR Library
                    //    Drive" — the saved destinations and the
                    //    current library always have specific paths).
                    //    In that case the user has already told us
                    //    where they want the library to live; opening
                    //    the picker would force them to re-pick the
                    //    same path they already selected, which makes
                    //    no sense (Terry's complaint: "it's available
                    //    for me to select in the LDM, but it just
                    //    doesn't select it"). Attach directly via
                    //    inspectAndRoute — same flow as if they'd
                    //    picked it through the folder browser.
                    //
                    // 2) The target row is a bare drive-letter rollup
                    //    (e.g. "H:\" — the listIndexedDrives signal
                    //    that a drive holds indexed photos but isn't
                    //    a registered library yet). We DON'T attach
                    //    to "H:\" itself because the bare drive root
                    //    is rarely what the user actually wants —
                    //    they want a specific folder inside it. Open
                    //    PDR's in-app FolderBrowserModal so they can
                    //    pick that folder.
                    const isBareDriveRoot = /^[A-Za-z]:[\\/]?$/.test(target.path);
                    if (!isBareDriveRoot) {
                      void inspectAndRoute(target.path);
                      return;
                    }

                    // The LDM modal is portalled and doesn't have the
                    // FolderBrowserModal mounted inside it, so we
                    // dispatch a CustomEvent that workspace.tsx
                    // listens for. Workspace opens the picker; on
                    // select it dispatches `pdr:libraryDriveFolderPicked`
                    // back, which we handle in the useEffect below.
                    window.dispatchEvent(new CustomEvent('pdr:pickLibraryDriveFolder', { detail: { defaultPath: target.path } }));
                  }}
                  className="contents"
                >
                {/* Truncating cells use the IconTooltip Radix primitive
                    everywhere — matching the rest of the app's tooltip
                    treatment, not the native browser bubble. */}
                {orderedDrives.map((drive) => {
                  const canOpenInExplorer = drive.online && drive.letter !== null;
                  const isMaster = masterDrive?.key === drive.key;
                  const nameCellFull = drive.volumeLabel ? `"${drive.volumeLabel}"` : 'No volume label';
                  const filesCellFull = [
                    `${drive.indexedFileCount.toLocaleString()} photos`,
                    drive.indexedBytes > 0 ? formatBytes(drive.indexedBytes) : null,
                    drive.lastIndexedAt ? formatRelativeTime(drive.lastIndexedAt) : null,
                  ].filter(Boolean).join(' · ');
                  const capacityCellFull = [
                    drive.driveTypeLabel,
                    drive.totalBytes > 0 ? `${formatBytes(drive.freeBytes)} free of ${formatBytes(drive.totalBytes)}` : null,
                    drive.fileSystem,
                  ].filter(Boolean).join(' · ');
                  // Contextual "Open" tooltip label — the current
                  // Library Drive gets the framing the user is most
                  // likely thinking ("open MY library drive"), others
                  // get a generic phrasing.
                  const openTooltipLabel = drive.isCurrentLibraryDrive
                    ? 'Open Library Drive location'
                    : 'Open drive location';
                  return (
                    <div
                      key={drive.key}
                      className={`grid grid-cols-[minmax(12rem,2fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_3rem_2rem] gap-3 items-center rounded-xl border p-3 ${
                        drive.isCurrentLibraryDrive
                          // Selected Library Drive — bumped from the
                          // barely-visible bg-primary/[0.04] (4%) to
                          // bg-primary/10 (10%) with a stronger
                          // border, matching the level of visibility
                          // the master-library emerald highlight used
                          // to have. Terry: the previous version was
                          // too subtle for the "this is the chosen
                          // one" cue.
                          ? 'border-primary/60 bg-primary/10'
                          : isMaster
                          ? 'border-emerald-300/60 bg-emerald-50/40 dark:bg-emerald-950/10 dark:border-emerald-900/40'
                          : 'border-border bg-secondary/10'
                      }`}
                    >
                      {/* Col 1 — Path. Single column replacing the old
                          Letter + Name pair. The full folder path is
                          the library's identity. Clickable when the
                          path exists on disk — opens File Explorer at
                          that folder. IconTooltip surfaces the full
                          path on hover when the cell truncates. */}
                      <div className="min-w-0">
                        {canOpenInExplorer ? (
                          <IconTooltip label={drive.path} side="top">
                            <button
                              onClick={() => handleOpenInExplorer(drive.path)}
                              disabled={explorerOpening === drive.path}
                              className="group inline-flex items-center gap-1 max-w-full text-body text-foreground hover:text-primary hover:underline underline-offset-2 transition-colors disabled:opacity-50 cursor-pointer"
                              aria-label={openTooltipLabel}
                            >
                              <span className="truncate text-mono">{drive.path}</span>
                              {explorerOpening === drive.path ? (
                                <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                              ) : (
                                <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                              )}
                            </button>
                          </IconTooltip>
                        ) : (
                          <IconTooltip label={drive.path} side="top">
                            <p className="text-mono text-foreground truncate cursor-help">{drive.path}</p>
                          </IconTooltip>
                        )}
                        {drive.volumeLabel && (
                          <p className="text-caption truncate">"{drive.volumeLabel}"</p>
                        )}
                      </div>

                      {/* Col 2 — Status pills */}
                      <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                        {drive.online ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 text-label">
                            <Wifi className="w-3 h-3" /> Connected
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 text-label">
                            <WifiOff className="w-3 h-3" /> Offline
                          </span>
                        )}
                        {/* Only show Internal pill when the drive is
                            ONLINE — when offline, we can't actually
                            verify the drive type (WMI lookup fails),
                            so the "Internal" classification was
                            misleading on USB drives Terry had
                            previously used (when offline, WMI's null
                            response was being treated as confirmed
                            internal). Better: silence on offline.
                            When online and confirmed internal, show
                            the pill. */}
                        {drive.online && !drive.isSafeForLibrary && (
                          <IconTooltip
                            label="On this PC's internal drive. Internal drives are fast and fine for your Library Drive — just download your Library DB regularly so you have an offsite backup."
                            side="top"
                          >
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 text-label cursor-help">
                              <HardDrive className="w-3 h-3" /> Internal
                            </span>
                          </IconTooltip>
                        )}
                        {drive.isCurrentLibraryDrive && attached && !isWriter && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 text-label">
                            <Eye className="w-3 h-3" /> Read-only
                          </span>
                        )}
                        {/* Persistent DB-backup pill. Only renders on the
                            CURRENT Library Drive row — that's the only
                            drive whose sidecar mirrors AppData, so it's
                            the only one with a DB to back up offsite.
                            Three visual states keyed off lastDbBackupAt:
                              - null                    → amber "Back up DB"
                              - older than 30 days      → amber "Backed up Xd ago"
                              - within 30 days          → green  "Backed up Xd ago"
                            Click opens the explainer modal which has the
                            "Back up now" CTA (calls handleExportDb) and
                            a "Snooze 30 days" link. Pill itself is
                            always visible — it's the always-on surface
                            Terry's Option 1 calls for. */}
                        {drive.isCurrentLibraryDrive && (() => {
                          const ms = lastDbBackupAt ? Date.now() - new Date(lastDbBackupAt).getTime() : null;
                          const days = ms !== null ? Math.floor(ms / 86400000) : null;
                          const isStale = days === null || days > 30;
                          const label = days === null
                            ? 'Back up DB'
                            : days === 0
                              ? 'Backed up today'
                              : days === 1
                                ? 'Backed up yesterday'
                                : `Backed up ${days}d ago`;
                          const pillClass = isStale
                            ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 hover:bg-amber-200/80 dark:hover:bg-amber-900/60'
                            : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 hover:bg-emerald-200/80 dark:hover:bg-emerald-900/60';
                          const tooltip = isStale
                            ? 'Click to learn why this matters and back up now'
                            : 'Library DB is backed up. Click to back up again or learn more.';
                          return (
                            <IconTooltip label={tooltip} side="top">
                              <button
                                type="button"
                                onClick={() => setShowBackupExplainer(true)}
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-label whitespace-nowrap transition-colors cursor-pointer ${pillClass}`}
                                data-testid="pill-db-backup"
                              >
                                <Download className="w-3 h-3" /> {label}
                              </button>
                            </IconTooltip>
                          );
                        })()}
                        {/* v2.0.11 — per-row Index pill.
                            Surfaces when this library's on-disk count
                            exceeds its indexed count by more than the
                            5 % slack (same threshold as the Dashboard
                            banner). The information IS the affordance —
                            the gap is the thing the user needs to
                            know about, AND the trigger to fix it.
                            When fully indexed, no pill (zero chrome).
                            During a refresh, becomes a disabled
                            "Refreshing…" pill with the same loading
                            visual language as the rest of PDR's pills.
                            Click fires the per-library rebuild via
                            handleRefreshLibrary; toast follows the user
                            across views via the existing
                            rebuildProgress subscription. */}
                        {(() => {
                          if (drive.onDiskCount === null) return null;
                          const isIndexing = indexingPaths.has(drive.path);
                          // v3.0.1 (Terry 2026-07-12) — the pill counts files not indexed
                          // ANYWHERE (uncoveredCount), not this path's onDisk−indexed gap, so a
                          // test/backup drive whose photos are already searchable via the real
                          // library (they de-dupe to that drive) no longer nags "+N to refresh".
                          // Falls back to the raw gap only until the uncovered probe lands.
                          const gap = drive.uncoveredCount ?? Math.max(0, drive.onDiskCount - drive.indexedFileCount);
                          if (!isIndexing && gap <= 10) return null;
                          // Live progress label. The pill renders the
                          // phase + percentage so the user sees how
                          // far the indexer's got without having to
                          // chase the toast around. Falls back to a
                          // plain "Indexing…" until the first progress
                          // event lands.
                          const progress = indexingProgress[drive.path];
                          let label: string;
                          if (isIndexing) {
                            if (progress?.phase === 'walking') {
                              label = 'Scanning…';
                            } else if (progress?.phase === 'reading-exif' && progress.total > 0) {
                              const pct = Math.min(99, Math.floor((progress.current / progress.total) * 100));
                              label = `Refreshing ${pct}%`;
                            } else if (progress?.phase === 'inserting') {
                              label = 'Saving…';
                            } else {
                              label = 'Refreshing…';
                            }
                          } else {
                            label = `+${gap.toLocaleString()} to refresh`;
                          }
                          const tooltip = isIndexing
                            ? progress?.phase === 'reading-exif' && progress.total > 0
                              ? `Reading ${progress.current.toLocaleString()} of ${progress.total.toLocaleString()} files. The pill clears when finished.`
                              : 'Refresh in progress — the pill clears when finished.'
                            : `${gap.toLocaleString()} photo${gap === 1 ? '' : 's'} on disk that aren't in the search index yet. Click to refresh — updates PDR's view of this library.`;
                          return (
                            <IconTooltip label={tooltip} side="top">
                              <button
                                type="button"
                                onClick={() => handleRefreshLibrary(drive.path)}
                                disabled={isIndexing}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-label transition-colors cursor-pointer bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 hover:bg-amber-200/80 dark:hover:bg-amber-900/60 disabled:opacity-60 disabled:cursor-default"
                                data-testid="pill-index-library"
                              >
                                <Database className="w-3 h-3" /> {label}
                              </button>
                            </IconTooltip>
                          );
                        })()}
                      </div>

                      {/* Col 4 — Files: stacked photo count + size +
                          last-indexed. No IconTooltip wrapper or
                          cursor-help — Terry's call: the cell already
                          shows three lines plainly; the row-level
                          tooltip + native "?" cursor was visual noise. */}
                      <div className="min-w-0">
                        <p className="text-body text-foreground truncate">
                          {drive.indexedFileCount.toLocaleString()} photos
                        </p>
                        {drive.indexedBytes > 0 && (
                          <p className="text-body-muted truncate">{formatBytes(drive.indexedBytes)}</p>
                        )}
                        {drive.lastIndexedAt && (
                          <p className="text-caption truncate">{formatRelativeTime(drive.lastIndexedAt)}</p>
                        )}
                      </div>

                      {/* Col 5 — Capacity: stacked free + total + FS +
                          drive-speed badge (BusType · MediaType). The
                          speed line is the new premium hint — users
                          see "NVMe SSD" / "USB SSD" / "SATA HDD" so
                          they can pick a fast drive without having to
                          benchmark. No IconTooltip wrapper or cursor-
                          help. */}
                      <div className="min-w-0">
                        {drive.totalBytes > 0 ? (
                          <>
                            <p className="text-body text-foreground truncate">
                              {formatBytes(drive.freeBytes)} free
                            </p>
                            <p className="text-body-muted truncate">
                              {formatBytes(drive.totalBytes)} total
                            </p>
                            {(drive.fileSystem || drive.busType) && (
                              <p className="text-caption truncate">
                                {drive.fileSystem}
                                {drive.fileSystem && (drive.busType || drive.mediaType) && <span> · </span>}
                                {drive.busType}
                                {drive.busType && drive.mediaType && drive.mediaType !== 'Unspecified' && <span> </span>}
                                {drive.mediaType && drive.mediaType !== 'Unspecified' && drive.mediaType}
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="text-body-muted">—</p>
                        )}
                      </div>

                      {/* Col 6 — Select. Radio centred horizontally
                          inside the column so it sits directly under
                          the centred "SELECT" header. When the row is
                          the current Library Drive AND the library is
                          in an amber state (offline / internal / no
                          backup), wrap the radio in a span with an
                          amber ring — so the user reads "yes you
                          picked this one, but it's not happy" without
                          us touching the RadioGroupItem primitive. */}
                      <div className="flex items-center justify-center">
                        <IconTooltip
                          label={drive.isCurrentLibraryDrive ? 'Current Library Drive' : 'Set as Library Drive'}
                          side="left"
                        >
                          <span className={drive.isCurrentLibraryDrive && health.tone === 'amber' ? 'inline-flex rounded-full ring-2 ring-amber-400 ring-offset-2 ring-offset-background' : 'inline-flex'}>
                            <RadioGroupItem
                              // Full path as the unique value — two
                              // library folders on the same drive
                              // share a letter but always have
                              // unique paths. See the RadioGroup
                              // value comment above for the bug
                              // history.
                              value={drive.path}
                              disabled={!drive.online && !drive.isCurrentLibraryDrive}
                              aria-label={pickMode ? 'Pick this drive' : (drive.isCurrentLibraryDrive ? 'Current Library Drive' : 'Set as Library Drive')}
                            />
                          </span>
                        </IconTooltip>
                      </div>

                      {/* Col 7 — Kebab menu (⋯) for per-row actions
                          (Option D). DropdownMenu primitive from
                          ui/dropdown-menu.tsx. Currently hosts Open in
                          File Explorer + Copy path; designed to scale
                          to more actions later (Eject, Verify
                          integrity, View audit log). The menu
                          intentionally duplicates Open-in-Explorer
                          even though Option A's clickable letter does
                          the same — two discovery paths for the same
                          action is fine, and not all users know the
                          letter is clickable. */}
                      <div className="flex items-center justify-end">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              className="p-1.5 hover:bg-secondary/60 rounded-md text-muted-foreground hover:text-foreground transition-colors shrink-0"
                              aria-label="More drive actions"
                            >
                              <MoreHorizontal className="w-4 h-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => handleOpenInExplorer(drive.path)}
                              disabled={!drive.online || drive.letter === null}
                            >
                              <ExternalLink />
                              {drive.isCurrentLibraryDrive ? 'Open Library Drive location' : 'Open drive location'}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleCopyPath(drive.path)}>
                              <Copy />
                              Copy drive path
                            </DropdownMenuItem>
                            {/* v2.0.15 (Terry 2026-06-04) — per-row
                                Refresh, always available regardless of
                                whether there's an apparent on-disk vs
                                indexed gap. Covers the case where a
                                user has added files to the library via
                                Explorer/Finder and wants PDR's view to
                                catch up immediately, without waiting
                                for the conditional "+N to refresh"
                                pill to appear. Same handler the pill
                                uses — toast follows the user. Disabled
                                when offline (no point firing a rebuild
                                against an unreachable root) or while
                                this row's refresh is already running. */}
                            <DropdownMenuItem
                              onClick={() => handleRefreshLibrary(drive.path)}
                              disabled={!drive.online || indexingPaths.has(drive.path)}
                            >
                              <RefreshCw />
                              {indexingPaths.has(drive.path) ? 'Refreshing…' : 'Refresh search index'}
                            </DropdownMenuItem>
                            {/* Download Library DB — shown on every row.
                                There's only one DB (the user's library
                                metadata), and gating it to "only the
                                current Library Drive row" surprises
                                users who open the menu from a different
                                row and expect the action to be there. */}
                            <DropdownMenuItem onClick={handleExportDb}>
                              <Download />
                              Download Library DB
                            </DropdownMenuItem>
                            {/* v2.0.15 (Terry 2026-06-04) — Remove from
                                list. Only shown for user-added rows
                                (those present in pdr-saved-destinations
                                and NOT the current Library Drive). The
                                current Library Drive must be switched
                                or disconnected first via its dedicated
                                flow — removing it inline from a kebab
                                would be too easy to misclick. Separator
                                above so the destructive action sits in
                                its own region. */}
                            {!drive.isCurrentLibraryDrive && savedDestinations.some(p =>
                              p.replace(/[\\/]+$/, '').toLowerCase() === drive.path.replace(/[\\/]+$/, '').toLowerCase()
                            ) && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() => handleRemoveSavedDestination(drive.path)}
                                  className="text-rose-600 dark:text-rose-400 focus:text-rose-700 focus:bg-rose-50 dark:focus:bg-rose-950/30"
                                >
                                  <Trash2 />
                                  Remove from list
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  );
                })}
                </RadioGroup>
              </div>
            )}
          </section>

          {/* ── Discovered libraries (v2.0.15 — Terry 2026-06-04).
                Surfaces libraries PDR has ever Fixed photos to (from
                the SQL indexed_runs table) that aren't already in the
                LDM and haven't been explicitly ignored. Useful when
                old libraries dropped off the LDM list — e.g. when
                the user migrated from one drive to a larger one and
                their original library folder was source-only at the
                time (so it never lived in pdr-saved-destinations).
                The DB has been quietly remembering every destination
                all along; this section just exposes that memory.
                Hidden entirely when there are zero candidates so the
                LDM stays clean for users with nothing to discover. */}
          {/* Section always renders so the "Scan drives" button is
              reachable even when the SQL discovery returned zero
              candidates — letting users discover libraries that
              predate the indexed_runs table or live on a drive PDR
              has never written to from this install. */}
          <section>
            <p className="text-caption uppercase tracking-wider mb-2">Discovered libraries</p>
            {discoveredLegacyLibraries.length > 0 ? (
              // v2.0.15 (Terry 2026-06-04) — explicit explanation of
              // where these candidates came from. Terry's framing:
              // "Reports History" is the user-facing surface, so cross-
              // referencing against it makes the discovery feel like
              // PDR is filling a known gap, not surfacing random
              // folders. Two discovery paths (Fix history auto, drive-
              // scan manual) named so the user understands which row
              // came from where via the per-card badge.
              <p className="text-body-muted mb-3">
                Drive locations PDR has previously run Fixes to that no longer appear in your Reports History (the ribbon at the bottom of the Dashboard). Found from your Fix history records (auto), and from <code>PDR_Catalogue.csv</code> files PDR finds on your drives when you click <em>Scan drives for more</em>. Add what you still want; ignore the rest.
              </p>
            ) : (
              <p className="text-body-muted mb-3">
                No previously-Fixed libraries are missing from Reports History on this install. Click below to also scan your connected drives for <code>PDR_Catalogue.csv</code> files &mdash; useful if you&apos;ve reinstalled PDR, migrated from another machine, or manually cleaned up old reports.
              </p>
            )}
            <div className="space-y-2">
              {discoveredLegacyLibraries.map(lib => {
                const sourceBadge = (() => {
                  switch (lib.source) {
                    case 'sql-runs':
                      return { label: 'From your Fix history', tone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' };
                    case 'catalogue-csv':
                      return { label: 'PDR catalog found on disk', tone: 'bg-primary/15 text-primary' };
                    case 'folder-pattern':
                      return { label: 'Folder structure looks like PDR', tone: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300' };
                  }
                })();
                const subline = (() => {
                  if (lib.source === 'sql-runs' && typeof lib.runCount === 'number' && typeof lib.totalFileCount === 'number') {
                    return `Last Fix ${formatRelativeTime(lib.lastIndexedAt)} · ${lib.runCount} Fix run${lib.runCount === 1 ? '' : 's'} · ${lib.totalFileCount.toLocaleString()} file${lib.totalFileCount === 1 ? '' : 's'}`;
                  }
                  // v2.0.15 hotfix — scan-source rows now carry an
                  // actual on-disk file count (capped at 50). Empties
                  // were dropped at scan time, so when this field is
                  // present it's always > 0.
                  const fileCountLabel = (typeof lib.currentFileCount === 'number')
                    ? `${lib.currentFileCount}${lib.currentFileCountCapped ? '+' : ''} file${lib.currentFileCount === 1 ? '' : 's'} on disk`
                    : null;
                  if (lib.source === 'catalogue-csv') {
                    const base = `Catalog last updated ${formatRelativeTime(lib.lastIndexedAt)}`;
                    return fileCountLabel ? `${base} · ${fileCountLabel}` : base;
                  }
                  const base = `Folder last modified ${formatRelativeTime(lib.lastIndexedAt)}`;
                  return fileCountLabel ? `${base} · ${fileCountLabel}` : base;
                })();
                return (
                  <div key={lib.path} className="rounded-lg border border-border bg-secondary/10 p-3 flex items-start gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                      <History className="w-4 h-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-body text-foreground font-medium truncate" title={lib.path}>{lib.path}</p>
                      <p className="text-caption mt-0.5">{subline}</p>
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-label mt-1.5 ${sourceBadge.tone}`}>
                        {sourceBadge.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {/* v2.0.15 hotfix #2 — Terry's request: he often
                          wants to open discovered folders in Explorer
                          to inspect or delete them personally. Reuses
                          the existing handleOpenInExplorer handler +
                          ExternalLink icon for visual consistency with
                          the main LDM rows' kebab "Open drive location"
                          item. Wrapped in IconTooltip per the style
                          guide (never freehand a pill). */}
                      <IconTooltip label="Open folder in File Explorer" side="top">
                        <button
                          type="button"
                          onClick={() => handleOpenInExplorer(lib.path)}
                          className="p-1.5 hover:bg-secondary/60 rounded-md text-muted-foreground hover:text-foreground transition-colors shrink-0"
                          aria-label="Open folder in File Explorer"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </button>
                      </IconTooltip>
                      <Button onClick={() => handleAddDiscoveredToLDM(lib.path)} variant="primary" size="sm">
                        Add to list
                      </Button>
                      <Button onClick={() => handleIgnoreDiscovered(lib.path)} variant="link" size="sm">
                        Ignore
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Drive-scan trigger — fires Strategies 1+2 on demand.
                Sits below the existing list so the cheaper SQL
                discovery's results are always visible first, with
                the scan acting as a "go deeper" option for users
                who don't see what they expected. */}
            <div className="mt-3 flex items-center gap-2">
              <Button
                onClick={handleScanDrivesForLegacyLibraries}
                variant="secondary"
                size="sm"
                disabled={isScanningDrives}
              >
                {isScanningDrives ? (
                  <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Scanning drives&hellip;</>
                ) : (
                  <><HardDrive className="w-3.5 h-3.5 mr-1.5" /> Scan drives for more</>
                )}
              </Button>
              <p className="text-caption">Looks for PDR catalog files and PDR-style folder structures across all connected drives. Can take a minute on large external drives.</p>
            </div>
          </section>


          {/* ── Library Drive actions — Take over writing only.
                "Sync now" was removed (2026-05-15) — the background
                30-second auto-mirror runs invisibly and there's no
                realistic flow where the user needs to force a mirror
                manually. handleSyncNow + the syncingNow state are
                retained as dead code in case we resurrect a labelled
                version later; harmless either way.
                Only meaningful when sidecar-attached; hidden otherwise
                so the surface stays clean for the common single-device
                case. */}
          {attached && !isWriter && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleTakeOverClick} variant="secondary" className="h-9 px-3">
                <Pencil className="w-3.5 h-3.5 mr-2" />
                Take over writing
              </Button>
            </div>
          )}

          {/* syncResult is now driven only by handleExportDb's
              success/failure path ("Library DB saved to..."), kept
              as inline confirmation when the Download Library DB
              kebab action runs from this surface. */}
          {syncResult && (
            <p className={`text-body-muted ${syncResult.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}`}>
              {syncResult.message}
            </p>
          )}

          {/* ── Takeout metadata — v2.0.13 permanent home for the
                cross-part sidecar cache. Lets the user (a) see what's
                already been scanned, (b) add more Takeout parts later
                if Google split their export across many ZIPs, and
                (c) run the Enrichment pass that retroactively upgrades
                _RC / _MK files in the library using the cache. Mounts
                here so users who dismissed the source-menu banner
                still have a discoverable entry point. */}
          <TakeoutMetadataSection />

          {/* ── Advanced — discouraged-option pattern (link variant +
                text-muted-foreground override per STYLE_GUIDE.md). */}
          {/* Advanced section — visible in BOTH modes.
              Normal mode: clicking opens Library Planner → DDA →
              folder picker → attach as a new Library Drive.
              Pick-mode (caller=parallel-library etc.): clicking
              opens a folder picker and dispatches the picked path
              back via pdr:libraryDrivePicked, no library setup
              wizard, no attach. The user needs this link in pick-
              mode for the legitimate case where they want the PL
              on a drive that isn't already in the LDM list. */}
          <div className="pt-2 border-t border-border space-y-1.5">
            <p className="text-caption uppercase tracking-wider">Advanced</p>
            <div className="flex flex-col items-start">
              <Button
                onClick={() => {
                  if (pickMode) {
                    // Open a folder picker directly; on select,
                    // dispatch back to the caller and close. Reuses
                    // the existing pdr:pickLibraryDriveFolder event
                    // that workspace.tsx already listens for to open
                    // the FolderBrowserModal. But that event's
                    // existing callback dispatches
                    // pdr:libraryDriveFolderPicked which the LDM
                    // intercepts for inspectAndRoute — NOT what we
                    // want in pick-mode. So we listen for that event
                    // once, intercept it, and convert it into our
                    // pick-mode dispatch instead.
                    const onePick = (evt: Event) => {
                      const detail = (evt as CustomEvent<{ path?: string }>).detail ?? {};
                      window.removeEventListener('pdr:libraryDriveFolderPicked', onePick as EventListener);
                      if (typeof detail.path === 'string' && detail.path.length > 0 && pickMode) {
                        window.dispatchEvent(new CustomEvent('pdr:libraryDrivePicked', {
                          detail: { caller: pickMode.caller, path: detail.path },
                        }));
                      }
                      setPickMode(null);
                      handleClose();
                    };
                    window.addEventListener('pdr:libraryDriveFolderPicked', onePick as EventListener);
                    window.dispatchEvent(new CustomEvent('pdr:pickLibraryDriveFolder', { detail: {} }));
                    return;
                  }
                  handleConnectClick();
                }}
                variant="link"
                className="px-0 h-auto text-muted-foreground hover:text-foreground"
              >
                {pickMode ? 'Pick a different folder' : 'Set up a new library on another drive'}
              </Button>
              {/* "Disconnect this device from the library" was removed
                  per Terry's note. To stop using a library, the user
                  switches to a different Library Drive via the radios
                  in the list — a normal action with a clear destination,
                  not an abstract "disconnect" with no follow-on state. */}
            </div>
          </div>
        </div>
      </>
    );
  };

  // Setup wizard — true first-time-setup face. Only shown when there's
  // no destinationPath AND no sidecar attachment. Keeps the eligibility
  // explainer + "Connect external drive or NAS" CTA from the original
  // panel; the management view above takes over once anything is
  // configured.
  const renderSetupWizard = () => {
    return (
      <>
        {renderHeader(
          'Set up your Library Database',
          'Save your face tags, names, Trees, date corrections and Search & Discovery work to a separate drive — so a new PC can pick up exactly where this one left off.',
        )}
        <div className="px-6 pb-6 pt-2 space-y-3">
          <div className="rounded-xl border border-border bg-secondary/30 p-3 space-y-2">
            <div className="flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <p className="text-body text-foreground"><span className="font-medium">External drive</span> — USB stick, SSD, HDD, SD card, Thunderbolt, USB-C, FireWire, eSATA</p>
            </div>
            <div className="flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <p className="text-body text-foreground"><span className="font-medium">NAS</span> — or any mapped network share</p>
            </div>
            <div className="flex items-start gap-2.5">
              <XCircle className="w-4 h-4 text-rose-500 dark:text-rose-400 shrink-0 mt-0.5" />
              <p className="text-body text-muted-foreground"><span className="font-medium text-foreground">Internal drives</span> — they'd go with your PC if it's lost or stolen</p>
            </div>
          </div>
          <Button onClick={handleConnectClick} variant="primary" className="w-full h-11">
            <Plug className="w-4 h-4 mr-2" />
            Connect external drive or NAS
          </Button>
        </div>
      </>
    );
  };

  const renderDetectedExisting = () => (
    <>
      {renderHeader('Existing PDR library found', 'Restore everything on this device — faces, names, dates, family trees, and your recent backup history. Your local data will be replaced; we keep a safety copy first.', 'emerald')}
      <div className="px-6 pb-6 pt-2 space-y-3">
        {pendingDetection && (
          <div className="rounded-xl border border-border bg-background/60 p-3 text-caption space-y-1">
            <div>Database: <span className="text-foreground">{formatBytes(pendingDetection.dbSizeBytes)}</span></div>
            <div>Recent snapshots in library: <span className="text-foreground">{pendingDetection.snapshotCount}</span></div>
            <div>Edit history: <span className="text-foreground">{pendingDetection.auditExists ? 'present' : 'not present'}</span></div>
            {pendingDetection.lock && (
              <div>Last writer: <span className="text-foreground">{pendingDetection.lock.writerDeviceName}</span></div>
            )}
          </div>
        )}
        <Button onClick={() => { setKeyInput(''); setKeyError(null); setStep('verify-key'); }} variant="caution" className="w-full h-12">
          <RotateCcw className="w-4 h-4 mr-2" /> Restore from this library
        </Button>
        <Button onClick={() => setStep('status')} variant="secondary" className="w-full">Cancel</Button>
      </div>
    </>
  );

  // renderDetectedEmpty — the user picked a drive that doesn't have a
  // .pdr sidecar yet. The previous copy ("Set up a new library here?
  // No existing PDR library data on this folder") was misleading
  // because it implied PDR was creating a new library, which made
  // renderSetUpConfirmation — gating surface that recommends Parallel
  // Library FIRST instead of letting the user dive into a separate
  // library setup. Terry's framing: Parallel Library handles the
  // common case (some photos at a different physical location) far
  // more cheaply than a separate library; create a separate library
  // only for genuinely independent collections. Running out of
  // storage is NOT a valid reason — the Library DB spans drives, so
  // photos can live across multiple physical drives in one library.
  const renderSetUpConfirmation = () => {
    return (
      <>
        {renderHeader('Set up an additional library?', null, 'primary', 'center')}
        <div className="px-6 pb-6 pt-2 space-y-3">
          <p className="text-body-muted">
            Most people don't need a second library. If you want some of your photos in a different physical location, use <span className="text-foreground font-medium">Parallel Library</span> instead — using the wizard, your selected photos in Search &amp; Discovery are copied automatically to the new location, and your library DB tracks them across drives.
          </p>
          <div className="rounded-xl border border-border bg-secondary/20 p-3">
            <p className="text-label uppercase tracking-wider mb-1.5">A separate library makes sense when</p>
            <ul className="space-y-1 list-disc pl-5">
              <li className="text-body-muted">You're organizing someone else's photos on this PC (e.g. a relative's)</li>
              <li className="text-body-muted">You want a fully independent collection that doesn't mix with yours in PDR's views</li>
            </ul>
            <p className="text-caption mt-2">Running out of storage isn't a reason — the Library DB spans drives, so one library's photos can live on multiple drives via Parallel Library.</p>
          </div>
          <Button
            onClick={() => {
              setStep('status');
              window.dispatchEvent(new CustomEvent('pdr:openParallelLibrary'));
              onClose();
            }}
            variant="primary"
            className="w-full h-11"
          >
            Use Parallel Library
          </Button>
          <Button
            onClick={() => setStep('status')}
            variant="secondary"
            className="w-full"
          >
            Cancel
          </Button>
          <Button
            // Set up a separate library — routes through Library
            // Planner → DDA → LDM-bound folder picker (v2.0.6). The
            // planner is the natural sizing step when starting a NEW
            // library: each library can have different collection
            // sizes / drive needs. workspace.tsx listens for
            // pdr:openLibraryPlanner, sets plannerForNewLibrary, opens
            // the chain. We close the panel so the planner has the
            // full screen (it's portalled at z-50 same as LDM, so
            // staying open would stack confusingly).
            onClick={() => {
              setStep('status');
              onClose();
              window.dispatchEvent(new CustomEvent('pdr:openLibraryPlanner'));
            }}
            variant="link"
            className="w-full text-muted-foreground hover:text-foreground"
          >
            Set up a separate library anyway
          </Button>
        </div>
      </>
    );
  };

  // users think they'd lose their existing work. In reality the
  // user's library DB lives at %APPDATA% and contains all their
  // photos/tags/trees regardless of which drive they back up to —
  // this step is just choosing where the BACKUP MIRROR lives.
  //
  // New copy reframes the action accurately: "back up your existing
  // library here", with the photo count to prove nothing's lost.
  const renderDetectedEmpty = () => {
    const targetPath = pendingAction && 'libraryRoot' in pendingAction ? pendingAction.libraryRoot : '';
    return (
      <>
        {/* Title-only header — the body has scannable bullet rows
            instead of a prose subtitle. */}
        {renderHeader('Switch your Library Drive?', undefined, 'primary', 'left')}
        <div className="px-6 pb-6 pt-2 space-y-3">
          {/* Two-line at-a-glance summary. The DB-backup advisory
              that previously lived here was removed in v2.0.5 —
              the Switch confirmation should focus on the switch
              decision, not bolt on an unrelated maintenance reminder
              the user has to dismiss to proceed. Per Terry's
              "Option 1" resolution (2026-05-15), the DB-backup
              advice gets its own permanent surface on the drive
              row in v2.0.6 (persistent pill + expandable explainer
              + periodic reminder), where it lives full-time rather
              than vanishing after one confirmation. */}
          <div className="space-y-2 px-1">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-1 shrink-0" />
              <p className="text-body text-foreground">
                Future fixes save to <span className="font-mono">{targetPath}</span>
              </p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-1 shrink-0" />
              <p className="text-body text-foreground">
                Past fixes on other Library Drives stay where they are
              </p>
            </div>
          </div>

          <Button onClick={runPendingAction} variant="primary" className="w-full h-12">
            <Plug className="w-4 h-4 mr-2" /> Switch to this drive
          </Button>
          <Button onClick={() => setStep('status')} variant="secondary" className="w-full">Cancel</Button>
        </div>
      </>
    );
  };

  const renderVerifyKey = () => (
    <>
      {renderHeader('Confirm with your license key', 'Enter your PDR license key to authorise this action. The same key gates every device-level change.', 'rose')}
      <div className="px-6 pb-6 pt-2 space-y-4">
        <div>
          <label className="block text-label text-foreground mb-2">License key</label>
          <input
            type="text"
            value={keyInput}
            onChange={(e) => { setKeyInput(e.target.value); setKeyError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmKey(); }}
            placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
            className="w-full px-4 py-3 rounded-lg border border-border bg-background text-foreground font-mono text-center tracking-wider focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            autoFocus
          />
          {keyError && (
            <div className="flex items-start gap-2 mt-3 p-3 bg-rose-50 dark:bg-rose-950/30 rounded-lg border border-rose-200 dark:border-rose-800">
              <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 flex-shrink-0 mt-0.5" />
              <p className="text-body text-rose-800 dark:text-rose-300">{keyError}</p>
            </div>
          )}
        </div>
        <Button onClick={handleConfirmKey} disabled={!keyInput.trim()} variant="primary" className="w-full h-12">
          Continue
        </Button>
        <Button onClick={() => setStep(pendingAction?.kind === 'takeOverWriter' ? 'status' : (pendingDetection?.dbExists ? 'detected-existing' : 'detected-empty'))} variant="secondary" className="w-full">Go back</Button>
      </div>
    </>
  );

  const renderProcessing = () => (
    <div className="px-6 py-12 flex flex-col items-center text-center gap-4">
      <Loader2 className="w-10 h-10 text-primary animate-spin" />
      <p className="text-h2 text-foreground">Working...</p>
    </div>
  );

  const renderSuccess = () => (
    <>
      {renderHeader('Done', successMsg, 'emerald')}
      {/* v2.0.15 (Terry 2026-06-05) — split the single "Close" button
          into two explicit next-step options so the user isn't dropped
          back to the workspace when they were mid-task in the LDM. The
          previous "Close" both ended the modal AND silently returned to
          PDR. Terry: "I was expecting to stay on LDM, because I never
          asked to leave... but I can see how perhaps most users will
          want to go back onto PDR apps after changing." Two buttons,
          primary first matches the more common intent (most users
          finish here and want to use their library), secondary
          underneath for power users / multi-library work. */}
      <div className="px-6 pb-6 pt-2 space-y-3">
        <Button onClick={handleClose} variant="primary" className="w-full h-12">Back to Workspace</Button>
        <Button onClick={() => setStep('status')} variant="secondary" className="w-full h-12">Back to libraries</Button>
      </div>
    </>
  );

  const renderError = () => (
    <>
      {renderHeader('Something went wrong', errorMsg ?? undefined, 'rose')}
      <div className="px-6 pb-6 pt-2 space-y-3">
        <Button onClick={() => setStep('status')} variant="secondary" className="w-full h-12">Back to library</Button>
      </div>
    </>
  );

  const renderDriveUnsafe = () => (
    <>
      {renderHeader('Pick a different drive', unsafeReason ?? 'This drive is not suitable for a Library Drive.', 'rose')}
      <div className="px-6 pb-6 pt-2 space-y-3">
        <Button onClick={handleConnectClick} variant="primary" className="w-full h-12">
          <Plug className="w-4 h-4 mr-2" /> Pick another drive
        </Button>
        <Button onClick={() => setStep('status')} variant="secondary" className="w-full h-12">Cancel</Button>
      </div>
    </>
  );

  // Portal to document.body so the panel escapes the TitleBar's
  // stacking context. LibraryStatusButton (the title-bar pill that hosts
  // this panel) is a descendant of TitleBar, whose root div is
  // `z-50 relative` — that combination creates a CSS stacking context,
  // and every descendant's z-index becomes relative to that context, not
  // the document. The offline modal lives outside TitleBar (rendered
  // inside workspace.tsx) at the document level z-50, so it would win
  // any stacking battle with LibraryPanel-inside-TitleBar regardless of
  // what z-index LibraryPanel sets internally.
  //
  // createPortal re-parents the panel's DOM to document.body, lifting it
  // out of the TitleBar's stacking context entirely. From there, z-50
  // is sufficient — the portal's DOM is appended to body AFTER #root,
  // so at equal z-50 the panel stacks above z-50 modals inside the
  // React tree by DOM order. Critically, this keeps the panel at the
  // SAME z-50 as Radix tooltips (TooltipContent uses z-50 by default),
  // so tooltips inside the panel render ABOVE it on hover instead of
  // being clipped underneath — the bug we hit at zIndex 55.
  // Backup explainer — the modal-over-modal that opens when the user
  // clicks the persistent "Back up DB" pill on the current Library
  // Drive row. Renders ON TOP of the LDM (does NOT replace it), so
  // dismissing returns the user to exactly where they were. Premium
  // pattern Terry has been asking for ("shouldn't this have been a
  // modal over the LDM?"). Contains the full DB explainer + a Back-
  // up-now CTA (calls handleExportDb, which now records the
  // timestamp on success) + a Snooze link.
  const renderBackupExplainer = () => {
    const days = lastDbBackupAt ? Math.floor((Date.now() - new Date(lastDbBackupAt).getTime()) / 86400000) : null;
    const stateLabel = days === null
      ? 'You haven\'t backed up your library DB yet.'
      : days === 0
        ? 'Backed up earlier today.'
        : days === 1
          ? 'Backed up yesterday.'
          : `Backed up ${days} days ago.`;
    const handleSnooze = async () => {
      try {
        await (window as any).pdr?.settings?.set?.('dbBackupReminderSnoozedAt', new Date().toISOString());
      } catch {}
      setShowBackupExplainer(false);
    };
    return (
      <div className="absolute inset-0 bg-black/[0.35] flex items-center justify-center p-6 z-10" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowBackupExplainer(false); }}>
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.15 }}
          className="w-full max-w-md bg-background rounded-2xl shadow-2xl overflow-hidden border border-border"
        >
          {renderHeader('Back up your library DB', stateLabel, 'primary', 'left')}
          <div className="px-6 pb-6 pt-2 space-y-3">
            <div className="space-y-2.5 text-body-muted">
              <p>
                Your library DB is a single file holding every face, person, AI tag, date verdict, and Trees entry PDR has built up. Without it, your photos are just photos — every face, name, and tag disappears.
              </p>
              <p>
                PDR mirrors the DB to your Library Drive automatically, so a separate offsite backup is the safety net for when this PC fails, is lost, or is stolen. Save the file somewhere off this PC — cloud storage, email, or another drive.
              </p>
            </div>
            <Button
              onClick={async () => { await handleExportDb(); setShowBackupExplainer(false); }}
              variant="primary"
              className="w-full h-12"
              disabled={isBackingUp}
            >
              <Download className="w-4 h-4 mr-2" />
              {isBackingUp ? 'Saving...' : 'Back up now'}
            </Button>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={handleSnooze}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                data-testid="link-snooze-backup"
              >
                Snooze 30 days
              </button>
              <Button onClick={() => setShowBackupExplainer(false)} variant="secondary" size="sm">Close</Button>
            </div>
          </div>
        </motion.div>
      </div>
    );
  };

  return createPortal(
    <div className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center p-4 z-50" onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        // Modal sizing per step. The management view needs a wide
        // canvas for the 6-column drive table; everything else
        // (loading state, attach confirmations, processing, error,
        // success) is short content that should look like a compact
        // confirmation, not a giant empty box. Earlier the modal
        // forced min-h-[600px] + max-w-4xl across all steps, which
        // made the loading state and confirmations feel oversized
        // (Terry: "this is too big" + "a lot of empty space"). The
        // modal now sizes per step.
        className={`relative w-full ${step === 'status' ? 'max-w-4xl' : 'max-w-md'} max-h-[85vh] bg-background rounded-2xl shadow-2xl overflow-hidden border border-border flex flex-col`}
      >
        {step === 'status' && renderStatus()}
        {step === 'set-up-confirmation' && renderSetUpConfirmation()}
        {step === 'picker-loading' && renderProcessing()}
        {step === 'detected-existing' && renderDetectedExisting()}
        {step === 'detected-empty' && renderDetectedEmpty()}
        {step === 'drive-unsafe' && renderDriveUnsafe()}
        {step === 'verify-key' && renderVerifyKey()}
        {step === 'processing' && renderProcessing()}
        {step === 'success' && renderSuccess()}
        {step === 'error' && renderError()}

        {/* Backup explainer overlays the LDM (renderStatus) when the
            user clicks the "Back up DB" pill. Stays inside the same
            motion.div so the LDM is dimmed behind it; closing returns
            the user to the LDM exactly where they were. Only mounted
            on top of step === 'status' since that's the only step
            where the pill is rendered. */}
        {showBackupExplainer && step === 'status' && renderBackupExplainer()}
      </motion.div>
    </div>,
    document.body,
  );
}
