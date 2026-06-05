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

// v2.0.15 (Terry 2026-06-05) — module-resolution fix for packaged
// builds. In packaged Electron, this worker lives at
// resources/dist-electron/startup-worker.cjs (extraResources), but
// native modules like better-sqlite3 live at
// resources/app.asar.unpacked/node_modules/better-sqlite3/. main.ts's
// workerEnv() sets NODE_PATH on the spawned process to bridge that
// gap, but Node's module resolver caches NODE_PATH-derived search
// paths at PROCESS STARTUP — env-var changes done by the parent
// process via utilityProcess.fork({env: ...}) take effect on
// process.env but DON'T re-trigger the resolver's path cache.
// Module._initPaths() forces a re-read, populating the search paths
// from the current NODE_PATH so 'better-sqlite3' can resolve.
// Without this call, the worker crashes with "Cannot find module
// 'better-sqlite3'" at exit code 1 within ~1.2s of fork — verified
// in main.log from packaged installs prior to this fix.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ModuleInit = require('module') as { _initPaths?: () => void };
ModuleInit._initPaths?.();

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

// ─── IPC types ─────────────────────────────────────────────────────────────

interface InitMessage {
  type: 'init';
  dbPath: string;
  // v2.0.12 — when the user has a Library Drive attached, the worker
  // takes a fresh DB snapshot to <libraryRoot>/.pdr/pdr-search.db BEFORE
  // running any cleanup. If the cleanup misbehaves (the v2.0.10 cascade-
  // delete kind), the sidecar holds the pre-cleanup state and the
  // workspace's CleanupCascadeRecoveryCard can offer a one-click restore.
  // null when no library is attached yet — cleanup still proceeds in
  // that case (we just don't get the defense-in-depth backup).
  libraryRoot: string | null;
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
    // v2.0.12 — true when we successfully wrote the pre-cleanup snapshot
    // to <libraryRoot>/.pdr/pdr-search.db. Surfaced in the main-process
    // log so post-mortem investigations can see whether the safety net
    // was in place for a given startup.
    snapshotTaken: boolean;
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

// v2.0.12 — pre-cleanup defence in depth. Before we touch a single row,
// snapshot the local DB to the Library Drive's sidecar location. If the
// cleanup misbehaves (the v2.0.10 cascade-delete pattern was a category
// of bug we now know exists), the user has a fresh backup waiting at
// <libraryRoot>/.pdr/pdr-search.db that the workspace's recovery banner
// can offer to restore from.
//
// Returns true if a snapshot landed; false on any failure (missing
// drive, permission denied, disk full). Cleanup proceeds either way —
// we never block tidying just because the sidecar drive happens to be
// disconnected, because that would make the app feel locked-up to the
// majority of users for whom there's no actual cascade risk.
async function snapshotToSidecarPreCleanup(dbPath: string, libraryRoot: string): Promise<boolean> {
  try {
    const sidecarDir = path.join(libraryRoot, '.pdr');
    const sidecarDbPath = path.join(sidecarDir, 'pdr-search.db');
    if (!fs.existsSync(sidecarDir)) {
      fs.mkdirSync(sidecarDir, { recursive: true });
    }
    // better-sqlite3's backup() is the right copy primitive — it handles
    // any in-progress WAL frames, produces a consistent snapshot, and
    // is faster than a raw file copy on large DBs. Open the source
    // read-only so a stuck writer lock from a crashed prior session
    // doesn't block the snapshot.
    const sourceDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    const tmpPath = sidecarDbPath + '.precleanup.tmp';
    try {
      await sourceDb.backup(tmpPath);
    } finally {
      try { sourceDb.close(); } catch { /* best-effort */ }
    }
    // Atomic rename — readers of the canonical sidecar path never see a
    // half-written file. Important because the renderer's recovery
    // banner opens this path read-only on workspace mount.
    if (fs.existsSync(sidecarDbPath)) fs.unlinkSync(sidecarDbPath);
    fs.renameSync(tmpPath, sidecarDbPath);
    return true;
  } catch (err) {
    postProgress(`(skipped backup: ${(err as Error).message.split('\n')[0]})`);
    return false;
  }
}

async function runDbCleanup(dbPath: string, libraryRoot: string | null): Promise<{
  staleRemoved: number;
  duplicatesRemoved: number;
  orphanRunsRemoved: number;
  ghostRunsRemoved: number;
  totalChecked: number;
  snapshotTaken: boolean;
}> {
  // Open the DB read-write. If the file doesn't exist yet (first
  // launch ever), short-circuit — there's nothing to clean up.
  if (!fs.existsSync(dbPath)) {
    return { staleRemoved: 0, duplicatesRemoved: 0, orphanRunsRemoved: 0, ghostRunsRemoved: 0, totalChecked: 0, snapshotTaken: false };
  }

  // v2.0.12 — pre-cleanup sidecar snapshot. Runs BEFORE we open the
  // write connection below, so the snapshot is taken against the
  // pristine on-disk file, not a connection that's about to mutate.
  let snapshotTaken = false;
  if (libraryRoot && fs.existsSync(libraryRoot)) {
    postProgress('Backing up your library…');
    snapshotTaken = await snapshotToSidecarPreCleanup(dbPath, libraryRoot);
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

    return { staleRemoved, duplicatesRemoved, orphanRunsRemoved, ghostRunsRemoved, totalChecked, snapshotTaken };
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
  const dbResult = await runDbCleanup(msg.dbPath, msg.libraryRoot ?? null);

  const done: DoneMessage = {
    type: 'done',
    summary: {
      dbStaleRemoved: dbResult.staleRemoved,
      dbDuplicatesRemoved: dbResult.duplicatesRemoved,
      dbOrphanRunsRemoved: dbResult.orphanRunsRemoved,
      dbGhostRunsRemoved: dbResult.ghostRunsRemoved,
      dbTotalChecked: dbResult.totalChecked,
      snapshotTaken: dbResult.snapshotTaken,
      elapsedMs: Date.now() - startedAt,
    },
  };
  parentPort?.postMessage?.(done);
});
