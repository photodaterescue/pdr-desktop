/**
 * PDR analysis worker — Electron utilityProcess fork that runs the
 * per-file CPU work of `analyzeSource` (folder/zip walk, EXIF parse,
 * hashing, dedup, scanner detect) off the main browser thread.
 *
 * Why this exists (v2.0.14, Terry 2026-05-27):
 *   Before this refactor, analyzeSource ran in the main Electron
 *   process. On a 6,000-file library plus the renderer's mount-time
 *   IPCs (AlbumsView's three SQL queries + IntersectionObserver
 *   thumbnail requests), the main thread blocked long enough that
 *   Windows ghosted the renderer as "Not Responding" (white-titlebar
 *   flash for ~5 s) and thumbnails arrived seconds late. Same
 *   architectural fix as cleanup-worker.cjs / extract-worker.cjs /
 *   conversion-worker.cjs — heavy CPU work moves to its own OS
 *   process; main stays free to service the renderer.
 *
 * Lifecycle:
 *   1. Main forks this worker via utilityProcess.fork (typically
 *      pre-forked at app startup so the first Add Source click
 *      doesn't pay the ~200-500 ms spawn cost).
 *   2. Main posts a 'start' message with sourcePath/sourceType and
 *      snapshots of the two main-only datasets the worker needs
 *      (scanner overrides + Takeout sidecar map). The worker
 *      configures the shared analysis-engine module with snapshot-
 *      backed lookups so the same per-file logic runs unchanged.
 *   3. Worker streams 'progress' / 'diagnostic' messages back; when
 *      the analyzeSource Promise resolves, posts the full
 *      SourceAnalysisResult as a single 'done' message. Plain JSON
 *      shape, structured-clone-safe.
 *   4. Cancellation: main posts a 'cancel' message; worker calls
 *      cancelAnalysis() on its analysis-engine instance, which flips
 *      the engine's internal flag the per-file loops poll.
 *   5. Main kills the worker after 'done' / 'cancelled' / 'error'.
 *
 * Why analysis-engine itself moved to CJS:
 *   utilityProcess workers can't require ESM modules, so analysis-
 *   engine.ts compiles via tsconfig.worker.json (CommonJS) and main
 *   imports it via the `.cjs` extension with a `.d.cts` shim for
 *   TypeScript types. date-extraction-engine, scanner-detection, and
 *   source-classifier follow the same pattern — all four are shared
 *   between main + worker, no duplication.
 */

import {
  analyzeSource,
  cancelAnalysis,
  configureDeps,
  AnalysisProgress,
  SourceAnalysisResult,
} from './analysis-engine.cjs';

// ─── IPC types — main → worker ─────────────────────────────────────────────

interface StartMessage {
  type: 'start';
  sourcePath: string;
  sourceType: 'folder' | 'zip' | 'drive';
  /** Snapshot of `listScannerOverrides()` taken on main at orchestrator
   *  entry. The worker can't import settings-store (electron-store) so
   *  the data arrives by value. */
  scannerOverrides: Array<{ make: string; model: string; isScanner: boolean }>;
  /** Snapshot of the takeout_sidecars table keyed by photo basename.
   *  Worker does pure Map.get(basename) lookups. */
  sidecarMapByBasename: Record<string, { photoTakenUnix: number | null; sourceZip: string }>;
}

interface CancelMessage {
  type: 'cancel';
}

type InboundMessage = StartMessage | CancelMessage;

// ─── IPC types — worker → main ─────────────────────────────────────────────

interface ProgressMessage {
  type: 'progress';
  progress: AnalysisProgress;
}

interface DiagnosticMessage {
  type: 'diagnostic';
  line: string;
}

interface DoneMessage {
  type: 'done';
  result: SourceAnalysisResult;
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

let started = false;

parentPort.on('message', (e) => {
  const msg = e.data;

  if (msg.type === 'cancel') {
    // The worker shares one analysis-engine module instance. Flipping
    // its cancel flag stops the per-file loops at their next check.
    // analyzeSource throws ANALYSIS_CANCELLED which our catch below
    // translates to a 'cancelled' IPC message. The pending fork is
    // killed by main after that.
    cancelAnalysis();
    return;
  }

  if (msg.type === 'start') {
    if (started) {
      parentPort.postMessage({
        type: 'error',
        message: 'analysis-worker received a second start before completing the first',
        code: 'WORKER_BUSY',
      });
      return;
    }
    started = true;

    // Build the two snapshot-backed lookup functions. Scanner overrides
    // are a short array (single-digit rows typical) so a linear scan is
    // fine. Sidecar map is keyed by basename so direct lookup is O(1).
    const scannerOverrideMap = new Map<string, boolean>();
    for (const ov of msg.scannerOverrides) {
      const key = `${(ov.make ?? '').toLowerCase()}|${(ov.model ?? '').toLowerCase()}`;
      scannerOverrideMap.set(key, ov.isScanner);
    }
    const sidecarMap = msg.sidecarMapByBasename;

    configureDeps({
      getScannerOverride: (make, model) => {
        const key = `${(make ?? '').toLowerCase()}|${(model ?? '').toLowerCase()}`;
        return scannerOverrideMap.has(key) ? scannerOverrideMap.get(key)! : null;
      },
      lookupSidecarByBasename: (basename) => sidecarMap[basename] ?? null,
    });

    // Run the analysis. analyzeSource is identical to the in-process
    // version — same code, just executing in a separate OS process. The
    // result is plain JSON (already structured-clone-safe today), so
    // posting it whole in 'done' is fine.
    analyzeSource(
      msg.sourcePath,
      msg.sourceType,
      (progress) => {
        parentPort.postMessage({ type: 'progress', progress });
      },
      (line) => {
        parentPort.postMessage({ type: 'diagnostic', line });
      },
    )
      .then((result) => {
        parentPort.postMessage({ type: 'done', result });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'ANALYSIS_CANCELLED') {
          parentPort.postMessage({ type: 'cancelled' });
        } else {
          parentPort.postMessage({ type: 'error', message });
        }
      });
    return;
  }
});

console.log('[analysis-worker] ready');
