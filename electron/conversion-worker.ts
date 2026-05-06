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

// ─── sharp tuning ──────────────────────────────────────────────────────────
// Disable libvips' operation cache. Useful when you process the same
// image many times (we don't), but keeps memory bounded across many
// distinct images (we do).
sharp.cache(false);
// Cap libvips' internal worker threads at 2. Combined with the per-
// child batching in main, this keeps the per-child memory ceiling
// predictable: at most 2 in-flight decode/encode buffers + their
// metadata, regardless of how many tasks the batch contains.
sharp.concurrency(2);

// ─── IPC types ─────────────────────────────────────────────────────────────

interface ConvertTask {
  id: number;
  input: string;            // absolute path to the input image
  output: string;           // absolute path to write the converted image
  format: 'jpg' | 'png';
}

interface ConvertBatchMessage {
  type: 'convert-batch';
  tasks: ConvertTask[];
  perTaskTimeoutMs?: number;  // default 60_000
  parallelism?: number;       // default 2 (matches sharp.concurrency)
}

interface TaskDoneMessage {
  type: 'task-done';
  id: number;
  success: boolean;
  durationMs: number;
  error?: string;
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

  try {
    const pipeline = task.format === 'jpg'
      ? sharp(task.input).jpeg({ quality: 92 })
      : sharp(task.input).png({ compressionLevel: 6, effort: 1 });

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

    return {
      type: 'task-done',
      id: task.id,
      success: true,
      durationMs: Date.now() - start,
      memUsage: memSnapshot(),
    };
  } catch (err) {
    return {
      type: 'task-done',
      id: task.id,
      success: false,
      durationMs: Date.now() - start,
      error: (err as Error).message ?? String(err),
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
    const parallelism = batch.parallelism ?? 2;
    try {
      const { succeeded, failed } = await processBatch(batch.tasks, timeoutMs, parallelism);
      postToParent({
        type: 'batch-done',
        total: batch.tasks.length,
        succeeded,
        failed,
      });
    } catch (err) {
      postToParent({
        type: 'fatal-error',
        message: (err as Error).message ?? String(err),
        stack: (err as Error).stack,
      });
    } finally {
      // Exit so the OS reclaims our heap + libvips memory pool.
      // Parent will fork a fresh child for the next batch.
      process.exit(0);
    }
  }
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────

listenForMessages();
