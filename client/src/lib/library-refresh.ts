import { toast } from 'sonner';

// library-refresh — the SINGLE owner of a search-index rebuild for the
// user's PDR Library Drive(s).
//
// v3.0.1 (Terry 2026-07-12). Background: there are two places that can kick
// off the same `search:rebuildFromLibraries` rebuild —
//   1. the Dashboard "One of your libraries isn't fully searchable yet" banner
//      (UnindexedLibrariesCard), and
//   2. the Library Drive Manager per-row "Refresh search index" (LibraryPanel).
// They each used to create their OWN sonner toast and their OWN progress
// subscription, and nothing coordinated them. The rebuild's progress events
// are broadcast to the whole renderer, so whenever both subscriptions were
// alive (e.g. the user tried both buttons, or a banner subscription leaked on
// navigation) BOTH toasts updated from the same events — Terry saw "2 toast
// screens ... freaking out". Worse, the main-process rebuild shares one
// ExifTool subprocess, and the first run to finish shuts it down under the
// second, corrupting it.
//
// The fix: route BOTH entry points through runLibraryRefresh below. A single
// in-flight guard means there is exactly one toast and one rebuild at a time;
// a second call while one is running is politely declined (and the backend has
// its own belt-and-braces single-flight guard too). Callers can observe the
// running state via isLibraryRefreshRunning() + the
// `pdr:libraryRefreshStateChange` window event to reflect it in their UI.

export interface RebuildProgress {
  phase: 'walking' | 'reading-exif' | 'inserting' | 'complete';
  rootIndex: number;
  rootCount: number;
  rootPath: string;
  current: number;
  total: number;
  currentFile: string;
}

let running = false;

export function isLibraryRefreshRunning(): boolean {
  return running;
}

export interface RunLibraryRefreshResult {
  started: boolean;   // true if THIS call owns the running refresh
  declined?: boolean; // true if a refresh was already running, so we didn't start another
}

export interface RunLibraryRefreshOptions {
  // Per-progress callback so a caller can drive its own inline UI (e.g. the
  // LDM per-row "Refreshing N%" pill) off the same events. Receives every
  // progress event of the active rebuild.
  onProgress?: (p: RebuildProgress) => void;
  // Fired once when the refresh ends (success OR failure), so a caller can
  // clear inline state and re-fetch counts.
  onSettled?: () => void;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function emitStateChange(): void {
  try { window.dispatchEvent(new CustomEvent('pdr:libraryRefreshStateChange')); } catch { /* non-DOM env */ }
}

export async function runLibraryRefresh(
  paths: string[],
  opts?: RunLibraryRefreshOptions,
): Promise<RunLibraryRefreshResult> {
  const clean = (paths || []).filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (clean.length === 0) return { started: false };

  // Single-flight: if a refresh already owns the toast, don't spawn a second.
  if (running) {
    toast.info('A library refresh is already running', {
      description: 'It will catch up all outstanding files. You can keep using PDR while it finishes.',
      duration: 5000,
    });
    return { started: false, declined: true };
  }

  const rebuild = (window as any).pdr?.search?.rebuildFromLibraries;
  const subscribe = (window as any).pdr?.search?.onRebuildProgress;
  if (typeof rebuild !== 'function') {
    toast.error('Refresh unavailable', { description: 'The search indexer isn\'t available in this build.' });
    return { started: false };
  }

  running = true;
  emitStateChange();

  const single = clean.length === 1;
  const soleName = single ? baseName(clean[0]) : '';
  const nLibraries = `${clean.length} librar${clean.length === 1 ? 'y' : 'ies'}`;
  const title = single ? `Refreshing "${soleName}"…` : `Refreshing ${nLibraries}…`;
  const toastId = toast.loading(title, { description: 'Starting…' });

  let finished = false;
  const finish = (kind: 'success' | 'error') => {
    if (finished) return;
    finished = true;
    running = false;
    // Success → tell every mounted surface (SearchPanel, MemoriesView,
    // LibraryPanel, the banner) to re-fetch. We deliberately do NOT fire the
    // rebuild-complete data event on failure (nothing changed), but we always
    // fire the state-change event so buttons/visibility recover either way.
    if (kind === 'success') {
      try { window.dispatchEvent(new CustomEvent('pdr:libraryRebuildComplete')); } catch { /* non-DOM */ }
    }
    emitStateChange();
    try { opts?.onSettled?.(); } catch { /* caller cleanup must never break us */ }
  };

  const unsubscribe = typeof subscribe === 'function'
    ? subscribe((p: RebuildProgress) => {
        try { opts?.onProgress?.(p); } catch { /* caller UI must never break the toast */ }
        const rootName = p.rootPath ? baseName(p.rootPath) : soleName;
        const libPrefix = p.rootCount > 1 ? `(library ${p.rootIndex + 1} of ${p.rootCount}) ` : '';
        if (p.phase === 'walking') {
          toast.loading(title, { id: toastId, description: `${libPrefix}Scanning "${rootName}"…` });
        } else if (p.phase === 'reading-exif') {
          toast.loading(title, { id: toastId, description: `${libPrefix}Reading "${rootName}" — ${p.current.toLocaleString()} of ${p.total.toLocaleString()}` });
        } else if (p.phase === 'inserting') {
          toast.loading(title, { id: toastId, description: `${libPrefix}Saving "${rootName}"…` });
        } else if (p.phase === 'complete') {
          // The indexer emits exactly one 'complete' (rootPath='') at the very
          // end, covering all roots.
          toast.success(single ? `Refreshed "${soleName}"` : `Refreshed ${nLibraries}`, {
            id: toastId,
            description: 'Your photos are now searchable in Search & Discovery, Memories, and the Date Editor.',
          });
          finish('success');
        }
      })
    : null;

  try {
    const res = await rebuild(clean);
    if (res && res.success === false) {
      if (res.alreadyRunning) {
        // Backend single-flight tripped (a race the UI guard didn't catch).
        toast.info('A library refresh is already running', { id: toastId, description: 'It will finish shortly.' });
      } else {
        toast.error('Refresh failed', { id: toastId, description: String(res.error ?? 'Unknown error') });
      }
      unsubscribe?.();
      finish('error');
    } else if (!finished) {
      // Resolved success but the 'complete' progress event never arrived (e.g.
      // nothing to do, or the subscription was unavailable) — resolve the toast
      // so it can't hang on "Starting…".
      toast.success(single ? `Refreshed "${soleName}"` : `Refreshed ${nLibraries}`, {
        id: toastId,
        description: 'Your photos are now searchable in Search & Discovery, Memories, and the Date Editor.',
      });
      unsubscribe?.();
      finish('success');
    } else {
      unsubscribe?.();
    }
  } catch (e: any) {
    toast.error('Refresh failed', { id: toastId, description: String(e?.message ?? e) });
    unsubscribe?.();
    finish('error');
  }

  return { started: true };
}
