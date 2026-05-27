/**
 * PDR analysis worker — Electron utilityProcess fork that runs the
 * per-file CPU work of `analyzeSource` (folder/zip walk, EXIF parse,
 * hashing, dedup, scanner detect) off the main browser thread.
 *
 * Why this exists (v2.0.14):
 *   Before this refactor, analyzeSource ran in the main Electron
 *   process. On a 6,000-file library plus the renderer's mount-time
 *   IPCs (AlbumsView's three SQL queries + IntersectionObserver
 *   thumbnail requests), the main thread blocked long enough that
 *   Windows ghosted the renderer as "Not Responding" (white-titlebar
 *   flash for ~5 s). Same architectural fix as cleanup-worker.cjs /
 *   extract-worker.cjs / conversion-worker.cjs — heavy CPU work moves
 *   to its own OS process; main stays free to service the renderer.
 *
 * Lifecycle:
 *   1. Main forks this worker via utilityProcess.fork (typically
 *      pre-forked at app startup so the first Add Source click
 *      doesn't pay the ~200-500 ms spawn cost).
 *   2. Main posts a 'start' message with the source path, type, and
 *      snapshots of the two main-only datasets the worker needs
 *      (scanner overrides + Takeout sidecar map).
 *   3. Worker streams 'progress' / 'diagnostic' / 'fileBatch'
 *      messages back; concludes with 'done' (success) or 'cancelled'
 *      / 'error' on failure.
 *   4. Main kills the worker after 'done' / 'cancelled' / 'error'.
 *
 * Phase A scaffold:
 *   This stub establishes the IPC contract + packaging plumbing
 *   without porting any analysis logic yet. The orchestrator on the
 *   main side will continue to fall back to in-process analyzeSource
 *   until Phase B lands; once Phase B lands the orchestrator forks
 *   this worker instead. Sending a 'start' to this stub today returns
 *   an immediate 'error' so any accidental wiring during development
 *   surfaces loudly rather than silently failing.
 */

// ─── IPC types — main → worker ─────────────────────────────────────────────

interface StartMessage {
  type: 'start';
  sourcePath: string;
  sourceType: 'folder' | 'zip' | 'drive';
  /** Snapshot of `listScannerOverrides()` taken on main at orchestrator
   *  entry, since the worker can't import settings-store. */
  scannerOverrides: Array<{ make: string; model: string; isScanner: boolean }>;
  /** Snapshot of the takeout_sidecars table keyed by photo basename.
   *  Worker does pure Map.get(basename) lookups instead of round-tripping
   *  to main's SQLite handle. */
  sidecarMapByBasename: Record<string, { photoTakenUnix: number | null; sourceZip: string }>;
  largeFileThresholdBytes: number;
  largeBufferLoadThresholdBytes: number;
  minHeuristicSizeBytes: number;
}

interface CancelMessage {
  type: 'cancel';
}

type InboundMessage = StartMessage | CancelMessage;

// ─── IPC types — worker → main ─────────────────────────────────────────────
// Kept in sync with electron/analysis-engine.ts AnalysisProgress shape so
// main can forward straight through to the renderer's analysis:progress
// channel without re-shaping.

interface ProgressMessage {
  type: 'progress';
  current: number;
  total: number;
  currentFile: string;
  phase: 'scanning' | 'analyzing' | 'complete';
}

interface DiagnosticMessage {
  type: 'diagnostic';
  /** A single line of the form `[PDR-DIAG ...]`. Main forwards verbatim
   *  to analysis:diagnostic so F12 receives them unchanged. */
  line: string;
}

interface FileBatchMessage {
  type: 'fileBatch';
  /** Plain JSON shapes — never class instances. Structured-clone-safe. */
  results: unknown[];
  duplicatesInBatch: Array<{ filename: string; duplicateOf: string; type: 'photo' | 'video'; duplicateMethod?: string }>;
  skippedInBatch: Array<{ filename: string; reason: string }>;
}

interface DoneMessage {
  type: 'done';
  totalFiles: number;
  photoCount: number;
  videoCount: number;
  totalSizeBytes: number;
  earliest: string | null;
  latest: string | null;
  confidenceSummary: { confirmed: number; recovered: number; marked: number };
  duplicatesRemoved: number;
  duplicateFiles: Array<{ filename: string; duplicateOf: string; type: 'photo' | 'video'; duplicateMethod?: string }>;
  skippedFiles: Array<{ filename: string; reason: string }>;
  peakRssMB: number;
  peakHeapUsedMB: number;
}

interface CancelledMessage {
  type: 'cancelled';
}

interface ErrorMessage {
  type: 'error';
  message: string;
  code?: string;
}

type OutboundMessage =
  | ProgressMessage
  | DiagnosticMessage
  | FileBatchMessage
  | DoneMessage
  | CancelledMessage
  | ErrorMessage;

// ─── parentPort ────────────────────────────────────────────────────────────

const parentPort = (process as unknown as {
  parentPort: {
    postMessage: (msg: OutboundMessage) => void;
    on: (event: string, listener: (e: { data: InboundMessage }) => void) => void;
  };
}).parentPort;

let cancelled = false;

parentPort.on('message', (e) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (msg.type === 'start') {
    // Phase A: not yet implemented. The main-side orchestrator should
    // still be using its in-process fallback at this point — receiving
    // a 'start' here means the wiring is live ahead of Phase B. Reply
    // loud and clear so it surfaces immediately rather than silently
    // hanging.
    parentPort.postMessage({
      type: 'error',
      message: 'analysis-worker stub: Phase B port not yet landed',
      code: 'ANALYSIS_WORKER_STUB',
    });
    return;
  }
});

console.log('[analysis-worker] stub ready (Phase A — no analysis logic yet)');
