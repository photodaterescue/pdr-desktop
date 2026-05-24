/**
 * PDR startup worker — runs in an Electron utilityProcess so the
 * heavy "scan 26k DB rows + walk 50 GB of PDR_Temp + delete orphans"
 * work happens on a SEPARATE process. The main browser process stays
 * unblocked, so the splash window's drag/resize stay smooth and
 * Windows never marks the app "Not Responding" during startup.
 *
 * Why this exists (Terry 2026-05-24):
 *   Earlier startup attempts kept the cleanup on the main process,
 *   chunked with setImmediate yields. That helps but isn't enough —
 *   even brief blocking calls (fs.existsSync, a single big DELETE)
 *   add up to the OS observing message-pump gaps that ghost the
 *   window. The only way to guarantee the splash stays interactive
 *   throughout is to move the work off-process entirely.
 *
 * Lifecycle:
 *   1. Main process forks this worker via utilityProcess.fork.
 *   2. Worker waits for an 'init' message from the parent that carries:
 *        - dbPath: absolute path to pdr-search.db (main passes the
 *          path because app.getPath('userData') isn't available in
 *          utility processes).
 *        - tempRoots: array of PDR_Temp directories to sweep.
 *   3. Worker opens its own better-sqlite3 connection, runs cleanup
 *      (purge stale + ghost runs + orphan runs + duplicate runs),
 *      then walks each tempRoot recursively deleting orphan
 *      extractions. Progress messages are posted as it goes so the
 *      splash can show a status line.
 *   4. When everything's done, worker posts {type:'done', summary}
 *      and exits cleanly. Main process closes the splash + reveals
 *      the workspace.
 *
 * Multi-process DB access:
 *   better-sqlite3 uses SQLite's file-level locking; multiple
 *   processes can open the same DB file safely. During this worker's
 *   run, the main process hasn't yet opened its DB connection
 *   (see main.ts startup sequence), so there's no contention.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

// ─── IPC types ─────────────────────────────────────────────────────────────

interface InitMessage {
  type: 'init';
  dbPath: string;
}

interface ProgressMessage {
  type: 'progress';
  text: string;
}

interface DoneMessage {
  type: 'done';
  summary: {
    dbStaleRemoved: number;
    dbDuplicatesRemoved: number;
    dbOrphanRunsRemoved: number;
    dbGhostRunsRemoved: number;
    dbTotalChecked: number;
    elapsedMs: number;
  };
}

// process.parentPort is the utilityProcess messaging channel — same
// shape as MessagePort.
const parentPort = (process as unknown as { parentPort: { postMessage: (msg: unknown) => void; on: (event: string, listener: (e: { data: unknown }) => void) => void } }).parentPort;

function postProgress(text: string): void {
  const msg: ProgressMessage = { type: 'progress', text };
  parentPort?.postMessage?.(msg);
}

// ─── DB cleanup (mirrors search-database.ts's runDatabaseCleanup) ──────────
//
// We reimplement here rather than importing search-database.ts because
// that module uses Electron's app.getPath() which isn't available in a
// utilityProcess. The queries themselves are simple — fewer deps =
// smaller blast radius if something goes wrong in the worker.

interface IndexedRunRow {
  id: number;
  destination_path: string;
}

async function runDbCleanup(dbPath: string): Promise<{
  staleRemoved: number;
  duplicatesRemoved: number;
  orphanRunsRemoved: number;
  ghostRunsRemoved: number;
  totalChecked: number;
}> {
  // Open the DB read-write. If the file doesn't exist yet (first
  // launch ever), short-circuit — there's nothing to clean up.
  if (!fs.existsSync(dbPath)) {
    return { staleRemoved: 0, duplicatesRemoved: 0, orphanRunsRemoved: 0, ghostRunsRemoved: 0, totalChecked: 0 };
  }
  const db = new Database(dbPath);
  // WAL for less locking contention if the main process opens its
  // own connection while this worker is mid-cleanup. Idempotent.
  try { db.pragma('journal_mode = WAL'); } catch { /* best-effort */ }

  try {
    let duplicatesRemoved = 0;
    let staleRemoved = 0;
    let totalChecked = 0;
    let orphanRunsRemoved = 0;
    let ghostRunsRemoved = 0;

    // Step 1: dedupe indexed_files by file_path (keep newest by id)
    postProgress('Tidying duplicates…');
    try {
      const result = db.prepare(`
        DELETE FROM indexed_files
        WHERE id NOT IN (
          SELECT MAX(id) FROM indexed_files GROUP BY file_path
        )
      `).run();
      duplicatesRemoved = result.changes;
    } catch (err) {
      // Table missing on fresh install — fine, nothing to dedupe.
    }

    // Step 2: stale-file check — fs.existsSync × every indexed_files
    // row. This is the loop that used to monopolise the main thread;
    // here in the worker we can afford to do it in one pass because
    // the main process is unaffected.
    postProgress('Verifying your library…');
    try {
      const rows = db.prepare(`SELECT id, file_path FROM indexed_files`).all() as { id: number; file_path: string }[];
      totalChecked = rows.length;
      const staleIds: number[] = [];
      // Batch yields not strictly needed in the worker (it's its own
      // process), but we still chunk so a huge DB doesn't hold the
      // worker's heap pinned at peak the entire time.
      const SCAN_BATCH = 1000;
      for (let i = 0; i < rows.length; i += SCAN_BATCH) {
        const end = Math.min(i + SCAN_BATCH, rows.length);
        for (let j = i; j < end; j++) {
          if (!fs.existsSync(rows[j].file_path)) {
            staleIds.push(rows[j].id);
          }
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (staleIds.length > 0) {
        const DEL_BATCH = 500;
        for (let i = 0; i < staleIds.length; i += DEL_BATCH) {
          const batch = staleIds.slice(i, i + DEL_BATCH);
          const placeholders = batch.map(() => '?').join(',');
          db.prepare(`DELETE FROM indexed_files WHERE id IN (${placeholders})`).run(...batch);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        staleRemoved = staleIds.length;
      }
    } catch (err) {
      // Table missing on fresh install.
    }

    // Step 3: orphan runs (no remaining indexed_files)
    try {
      const result = db.prepare(`
        DELETE FROM indexed_runs
        WHERE id NOT IN (SELECT DISTINCT run_id FROM indexed_files)
      `).run();
      orphanRunsRemoved = result.changes;
    } catch { /* table missing */ }

    // Step 4: ghost runs — destination folder gone AND no live files.
    // Auto-remove. Don't bother surfacing the prompt-user case from
    // here; if it happens after first launch on this build, the
    // renderer-side stale-runs check can pick it up.
    try {
      const runs = db.prepare(`SELECT id, destination_path FROM indexed_runs`).all() as IndexedRunRow[];
      const autoRemoveIds: number[] = [];
      for (const run of runs) {
        if (!fs.existsSync(run.destination_path)) {
          const files = db.prepare(
            `SELECT file_path FROM indexed_files WHERE run_id = ? LIMIT 100`
          ).all(run.id) as { file_path: string }[];
          const hasLive = files.some((f) => fs.existsSync(f.file_path));
          if (!hasLive) {
            autoRemoveIds.push(run.id);
          }
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (autoRemoveIds.length > 0) {
        const deleteStmt = db.prepare(`DELETE FROM indexed_runs WHERE id = ?`);
        const tx = db.transaction(() => {
          for (const id of autoRemoveIds) deleteStmt.run(id);
        });
        tx();
        ghostRunsRemoved = autoRemoveIds.length;
      }
    } catch { /* table missing */ }

    return { staleRemoved, duplicatesRemoved, orphanRunsRemoved, ghostRunsRemoved, totalChecked };
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}

// ─── Init handler ─────────────────────────────────────────────────────────
//
// The startup worker handles DB cleanup only. The PDR_Temp orphan
// sweep was moved BACK to the renderer (workspace.tsx) so it has
// access to the persisted source paths via localStorage and can
// correctly distinguish "orphan, delete" from "extraction associated
// with a persisted source, keep". The main thread is no longer the
// contention point because the splash window is now its own process
// — the renderer-side sweep can run while the splash stays smooth.

parentPort?.on?.('message', async (e: { data: unknown }) => {
  const msg = e.data as InitMessage;
  if (!msg || msg.type !== 'init') return;

  const startedAt = Date.now();
  const dbResult = await runDbCleanup(msg.dbPath);

  const done: DoneMessage = {
    type: 'done',
    summary: {
      dbStaleRemoved: dbResult.staleRemoved,
      dbDuplicatesRemoved: dbResult.duplicatesRemoved,
      dbOrphanRunsRemoved: dbResult.orphanRunsRemoved,
      dbGhostRunsRemoved: dbResult.ghostRunsRemoved,
      dbTotalChecked: dbResult.totalChecked,
      elapsedMs: Date.now() - startedAt,
    },
  };
  parentPort?.postMessage?.(done);
});
