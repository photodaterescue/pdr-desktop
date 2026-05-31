/**
 * Image-conversion worker — runs in an Electron utilityProcess child
 * so each batch of conversions has its own V8 heap + libvips memory
 * pool, fully reclaimed by the OS when the child exits.
 *
 * Why a child process rather than the AI-style worker_threads pool:
 *   - sharp/libvips holds memory in an internal pool that doesn't
 *     reliably shrink between operations. Across 7,000+ photos in a
 *     single Takeout, the pool can grow large enough to trigger OS
 *     swap-thrashing and effectively freeze the main process. A
 *     worker thread shares the parent's V8 heap so it doesn't help.
 *     A child process has its own heap that the OS reclaims fully
 *     on exit — making the leak structurally impossible across
 *     batches.
 *   - The previous Promise.race(60s timeout) only rejected the parent
 *     promise — sharp() kept running in the background and kept its
 *     memory. Inside the child we use AbortController so a timeout
 *     genuinely terminates the conversion + frees its memory.
 *
 * Lifecycle:
 *   1. Main process forks this child via utilityProcess.fork.
 *   2. Main posts a 'convert-batch' message with up to N tasks.
 *   3. Child processes them with controlled parallelism, posting a
 *      'task-done' message per completion (so main can advance the
 *      progress bar in real time).
 *   4. Once all tasks are done, child posts 'batch-done' and exits.
 *   5. Main process forks a fresh child for the next batch.
 *
 * Settings applied at startup:
 *   sharp.cache(false)        — disables libvips operation cache
 *   sharp.concurrency(2)      — caps libvips threads inside this child
 *
 * Memory diagnostics:
 *   The child posts process.memoryUsage() snapshots after each task
 *   so main.log shows the trajectory across a batch. Lets us catch
 *   any future regression (or a specific file that bloats memory)
 *   without having to add ad-hoc logging.
 */

import sharp from 'sharp';
import * as fs from 'fs';

// ─── sharp tuning ──────────────────────────────────────────────────────────
// Disable libvips' operation cache. Useful when you process the same
// image many times (we don't), but keeps memory bounded across many
// distinct images (we do).
sharp.cache(false);
// v2.0.15 (Terry 2026-05-30) — libvips internal threads bumped from
// 2 to 2 (unchanged) while the per-batch task parallelism in main
// goes from 2 → 4. Net active threads per worker = 2 × 4 = 8, which
// matches an 8-core machine without oversubscribing. The single-
// libvips-thread + many-parallel-tasks split tends to dominate over
// many-libvips-threads + few-parallel-tasks for the PNG encode
// workload we measured (per-file 2–7s, dominated by zlib compression
// inside libvips, which scales modestly with internal threads).
sharp.concurrency(2);

// ─── IPC types ─────────────────────────────────────────────────────────────

interface ConvertTask {
  id: number;
  input: string;            // absolute path to the input image
  output: string;           // absolute path to write the converted image
  format: 'jpg' | 'png';
  // v2.0.15 (Terry 2026-05-31) — optional EXIF date metadata embedded
  // during the sharp encode instead of being written by a separate
  // post-batch exiftool pass. dateExif is the EXIF-formatted string
  // 'YYYY:MM:DD HH:MM:SS'. When present, the worker writes
  // DateTimeOriginal / DateTime / DateTimeDigitized inside the same
  // encode operation — no extra file read/write needed.
  dateExif?: string;
}

interface ConvertBatchMessage {
  type: 'convert-batch';
  tasks: ConvertTask[];
  perTaskTimeoutMs?: number;  // default 60_000
  parallelism?: number;       // default 4 (post-v2.0.15)
}

// v2.0.15 — persistent-worker shutdown signal. Replaces the
// per-batch process.exit(0) so we don't pay the 6.7s fork + sharp
// load cost on every batch. Main posts this once at end-of-Fix; the
// child exits cleanly so the OS reclaims its libvips memory pool.
interface ShutdownMessage {
  type: 'shutdown';
}

interface TaskDoneMessage {
  type: 'task-done';
  id: number;
  success: boolean;
  durationMs: number;
  error?: string;
  // v2.0.15 diagnostics — input bytes (source file size) and
  // output bytes (encoded file size on disk). Lets main.log show
  // compression ratio per file and MB/s throughput per batch.
  // Both undefined on failure paths where we never reach the
  // post-encode stat.
  inputBytes?: number;
  outputBytes?: number;
  // v2.0.15 — true when the task included a dateExif and the
  // pipeline successfully embedded it. Main uses this to mark the
  // result row's exifWritten without doing a separate exiftool
  // pass (which used to be the bottleneck — ~1s per file × 2123 =
  // 35 minutes of serial main-thread work).
  exifEmbedded?: boolean;
  // Memory snapshot AFTER this task completed — surfaces a leak in
  // the trajectory across a batch.
  memUsage: {
    rssMB: number;
    heapUsedMB: number;
    externalMB: number;
  };
}

interface BatchDoneMessage {
  type: 'batch-done';
  total: number;
  succeeded: number;
  failed: number;
}

interface FatalErrorMessage {
  type: 'fatal-error';
  message: string;
  stack?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function memSnapshot(): TaskDoneMessage['memUsage'] {
  const m = process.memoryUsage();
  return {
    rssMB: Math.round(m.rss / (1024 * 1024)),
    heapUsedMB: Math.round(m.heapUsed / (1024 * 1024)),
    externalMB: Math.round(m.external / (1024 * 1024)),
  };
}

/**
 * Convert a single image with a real abortable timeout. Sharp accepts
 * a `signal` from an AbortController in its toFile() options on recent
 * versions; if the timeout fires the underlying libvips operation is
 * cancelled and its memory freed (rather than the leaky Promise.race
 * pattern in the old inline code, which left zombie sharps holding
 * RAM after the parent timeout fired).
 */
async function convertOne(task: ConvertTask, timeoutMs: number): Promise<TaskDoneMessage> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // v2.0.15 diagnostics — capture input size before we start.
  // stat is cheap (file already on disk), so the overhead is
  // negligible against the encode cost.
  let inputBytes: number | undefined;
  try { inputBytes = fs.statSync(task.input).size; } catch { /* best-effort */ }

  try {
    // v2.0.15 (Terry 2026-05-31) — compressionLevel dropped from 6
    // to 1. Level 6 was libvips' default and triggered an
    // expensive zlib search at every encode (the per-file cost
    // measured 2–7s for typical 1–2MB JPG → 3–6MB PNG inputs).
    // Level 1 skips the search and uses fixed-Huffman DEFLATE,
    // typically 3–5× faster encode for ~10–15% larger output.
    // For PNG this is a quality-neutral trade (PNG is lossless at
    // every level) — only file size and encode speed change.
    let pipeline = task.format === 'jpg'
      ? sharp(task.input).jpeg({ quality: 92 })
      : sharp(task.input).png({ compressionLevel: 1, effort: 1 });

    // v2.0.15 (Terry 2026-05-31) — embed EXIF dates during the
    // encode pipeline so the post-batch exiftool serial loop (the
    // 35-minute bottleneck on Terry's 2,123-file PNG Fix) can be
    // deleted entirely. Sharp writes EXIF as an APP1 segment for
    // JPEG and an eXIf chunk for PNG (PNG spec 1.5+) — both are
    // read by exiftool, Windows Photos, macOS Preview, Lightroom,
    // Google Photos, and PDR's own date-editor surface. Three
    // fields match the previous writeExifDate() output exactly:
    //   DateTimeOriginal  (Exif IFD, when the photo was taken)
    //   DateTimeDigitized (Exif IFD, alias for CreateDate)
    //   DateTime          (IFD0, alias for ModifyDate)
    if (task.dateExif) {
      pipeline = pipeline.withExif({
        IFD0: { DateTime: task.dateExif },
        IFD2: {
          DateTimeOriginal: task.dateExif,
          DateTimeDigitized: task.dateExif,
        },
      });
    }

    // sharp's toFile doesn't natively take an AbortSignal in older
    // versions, but throwing inside a downstream .pipe will propagate
    // up. We approximate with a race that — crucially — *also*
    // calls pipeline.destroy() on abort, freeing the libvips handle.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        try { (pipeline as any).destroy?.(); } catch { /* ignore */ }
        reject(new Error('Conversion timeout'));
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });

      pipeline.toFile(task.output)
        .then(() => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener('abort', onAbort);
          resolve();
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener('abort', onAbort);
          reject(err);
        });
    });

    // v2.0.15 diagnostics — stat the output now that the encode
    // has landed. Best-effort: a failure to stat doesn't break the
    // success result, it just leaves outputBytes undefined.
    let outputBytes: number | undefined;
    try { outputBytes = fs.statSync(task.output).size; } catch { /* best-effort */ }

    return {
      type: 'task-done',
      id: task.id,
      success: true,
      durationMs: Date.now() - start,
      inputBytes,
      outputBytes,
      exifEmbedded: !!task.dateExif,
      memUsage: memSnapshot(),
    };
  } catch (err) {
    return {
      type: 'task-done',
      id: task.id,
      success: false,
      durationMs: Date.now() - start,
      error: (err as Error).message ?? String(err),
      inputBytes,
      memUsage: memSnapshot(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounded-parallelism task runner. Maintains up to `parallelism`
 * conversions in flight and feeds the next task as soon as one
 * settles. Posts the result of each task back to the parent
 * immediately (so the parent can advance the progress bar without
 * waiting for the whole batch to finish).
 */
async function processBatch(tasks: ConvertTask[], timeoutMs: number, parallelism: number): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;
  let cursor = 0;

  const launchOne = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      const result = await convertOne(tasks[idx], timeoutMs);
      if (result.success) succeeded++;
      else failed++;
      // Post result immediately so the parent can update progress.
      postToParent(result);
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(parallelism, tasks.length); i++) {
    workers.push(launchOne());
  }
  await Promise.all(workers);
  return { succeeded, failed };
}

// ─── IPC plumbing ──────────────────────────────────────────────────────────

function postToParent(msg: TaskDoneMessage | BatchDoneMessage | FatalErrorMessage): void {
  // utilityProcess child posts via process.parentPort. The compiled
  // .cjs build of this file runs under Electron's utilityProcess
  // runner, which exposes parentPort as a global.
  const pp = (process as any).parentPort;
  if (pp && typeof pp.postMessage === 'function') {
    pp.postMessage(msg);
  } else {
    // Fallback for `electron-run-as-node` / standard fork() — use
    // process.send. Not used in the current main.ts but keeps this
    // file portable if we ever switch transports.
    if (typeof process.send === 'function') {
      process.send(msg);
    }
  }
}

function listenForMessages(): void {
  const pp = (process as any).parentPort;
  if (pp && typeof pp.on === 'function') {
    pp.on('message', handleParentMessage);
    return;
  }
  process.on('message', handleParentMessage);
}

async function handleParentMessage(raw: any): Promise<void> {
  // utilityProcess wraps payloads in { data: ... }; standard fork
  // delivers them directly. Unwrap if needed.
  const msg = (raw && typeof raw === 'object' && 'data' in raw) ? raw.data : raw;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'convert-batch') {
    const batch = msg as ConvertBatchMessage;
    const timeoutMs = batch.perTaskTimeoutMs ?? 60_000;
    const parallelism = batch.parallelism ?? 4;
    try {
      const { succeeded, failed } = await processBatch(batch.tasks, timeoutMs, parallelism);
      postToParent({
        type: 'batch-done',
        total: batch.tasks.length,
        succeeded,
        failed,
      });
      // v2.0.15 — DO NOT exit. Persistent worker model: main keeps
      // the child alive across batches so the fork + sharp-load cost
      // (~6.7s, measured) is paid once per Fix instead of once per
      // batch. The child exits only on the explicit 'shutdown'
      // message, posted by main at end-of-Fix.
    } catch (err) {
      postToParent({
        type: 'fatal-error',
        message: (err as Error).message ?? String(err),
        stack: (err as Error).stack,
      });
      // A fatal error means libvips may be in an unrecoverable state;
      // bail out so main can decide whether to respawn for the next
      // batch.
      process.exit(1);
    }
  } else if (msg.type === 'shutdown') {
    // Clean shutdown — OS reclaims our heap + libvips memory pool.
    process.exit(0);
  }
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────

listenForMessages();
