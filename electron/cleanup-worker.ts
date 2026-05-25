/**
 * PDR cleanup worker — runs in an Electron utilityProcess so the
 * recursive deletion of a 50 GB extracted Takeout doesn't block the
 * main browser thread. Without this, fs.rmSync(tempDir, { recursive,
 * force }) holds the main thread for 10–20 seconds while NTFS unlinks
 * thousands of files, ghosting the window as "Not Responding".
 *
 * Why this exists (Terry 2026-05-25):
 *   The post-fix cleanup flow ran inside the analysis:cleanupTempDir-
 *   ForSource IPC, calling cleanupTempDir which used fs.rmSync. That
 *   was the residual freeze after Fix-complete + Add Source: the main
 *   process was deleting 50 GB while the renderer was already trying
 *   to open the folder browser. Off-process keeps the main browser
 *   thread completely free.
 *
 * Lifecycle:
 *   1. Main forks ONE worker at app startup via preforkCleanupWorker.
 *   2. The worker stays alive across many delete requests (different
 *      from extract-worker which is one-shot per extraction).
 *   3. Main posts { type: 'delete', id, path } to request a delete.
 *      Worker replies with { type: 'done', id, ok, reason? }.
 *   4. id ties replies to their request so multiple in-flight deletes
 *      don't get tangled (rare in practice but safe by design).
 *   5. If the worker exits unexpectedly, main spawns a fresh one.
 */

import * as fs from 'fs';

interface DeleteMessage {
  type: 'delete';
  id: number;
  path: string;
}

interface DoneMessage {
  type: 'done';
  id: number;
  ok: boolean;
  reason?: string;
}

const parentPort = (process as unknown as {
  parentPort: {
    postMessage: (msg: DoneMessage) => void;
    on: (event: string, listener: (e: { data: DeleteMessage }) => void) => void;
  };
}).parentPort;

parentPort.on('message', async (e: { data: DeleteMessage }) => {
  const msg = e.data;
  if (!msg || msg.type !== 'delete' || typeof msg.path !== 'string' || typeof msg.id !== 'number') {
    return;
  }
  try {
    // fs.promises.rm with { recursive: true, force: true } walks the
    // tree asynchronously. Each file unlink + dir rmdir is its own
    // async op, yielding to the event loop between operations. On a
    // 50 GB Takeout this still takes 10–20s wall-clock — but it's all
    // in the worker process, so the main browser thread is unaffected.
    if (fs.existsSync(msg.path)) {
      await fs.promises.rm(msg.path, { recursive: true, force: true });
    }
    parentPort.postMessage({ type: 'done', id: msg.id, ok: true });
  } catch (err) {
    parentPort.postMessage({
      type: 'done',
      id: msg.id,
      ok: false,
      reason: (err as Error).message,
    });
  }
});
