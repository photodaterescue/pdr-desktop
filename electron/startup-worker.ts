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
  tempRoots: string[];
  /** Drive-letter prefix of the configured Library Drive, used to
   *  decide whether the PDR_Temp at the temp root is "loose-files-only"
   *  (sub-folders may be active extractions) or full-sweep safe. We
   *  pass the configured-source-paths array so we can mirror the
   *  same logic the workspace's launch sweep used. */
  hasPersistedSources: boolean;
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
    tempBytesRemoved: number;
    tempEntriesRemoved: number;
    tempEntriesLocked: number;
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

// ─── Orphan PDR_Temp sweep ────────────────────────────────────────────────

async function asyncFolderSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await asyncFolderSizeBytes(full);
      } else {
        const stat = await fs.promises.stat(full);
        total += stat.size;
      }
    } catch {
      /* ignore individual stat failures */
    }
  }
  return total;
}

async function sweepTempRoot(root: string, looseFilesOnly: boolean): Promise<{ bytesRemoved: number; entriesRemoved: number; locked: number }> {
  let bytesRemoved = 0;
  let entriesRemoved = 0;
  let locked = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return { bytesRemoved: 0, entriesRemoved: 0, locked: 0 };
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (looseFilesOnly && entry.isDirectory()) continue;
    try {
      if (entry.isDirectory()) {
        bytesRemoved += await asyncFolderSizeBytes(full);
      } else {
        try {
          const stat = await fs.promises.stat(full);
          bytesRemoved += stat.size;
        } catch { /* ignore */ }
      }
      await fs.promises.rm(full, { recursive: true, force: true });
      entriesRemoved++;
    } catch {
      locked++;
    }
  }
  // Remove the now-empty PDR_Temp directory itself when we did a
  // full sweep. Best-effort; if anything's still in it (locked sub-
  // folder, etc.) the rmdir simply fails and we move on.
  if (!looseFilesOnly) {
    try {
      await fs.promises.rmdir(root);
    } catch { /* fine, still has content or already gone */ }
  }
  return { bytesRemoved, entriesRemoved, locked };
}

// ─── Init handler ─────────────────────────────────────────────────────────

parentPort?.on?.('message', async (e: { data: unknown }) => {
  const msg = e.data as InitMessage;
  if (!msg || msg.type !== 'init') return;

  const startedAt = Date.now();
  const dbResult = await runDbCleanup(msg.dbPath);

  let totalBytes = 0;
  let totalEntries = 0;
  let totalLocked = 0;
  postProgress(msg.tempRoots.length > 0 ? 'Cleaning up extracted files…' : 'Almost ready…');
  for (const root of msg.tempRoots) {
    const looseFilesOnly = msg.hasPersistedSources;
    const result = await sweepTempRoot(root, looseFilesOnly);
    totalBytes += result.bytesRemoved;
    totalEntries += result.entriesRemoved;
    totalLocked += result.locked;
  }

  const done: DoneMessage = {
    type: 'done',
    summary: {
      dbStaleRemoved: dbResult.staleRemoved,
      dbDuplicatesRemoved: dbResult.duplicatesRemoved,
      dbOrphanRunsRemoved: dbResult.orphanRunsRemoved,
      dbGhostRunsRemoved: dbResult.ghostRunsRemoved,
      dbTotalChecked: dbResult.totalChecked,
      tempBytesRemoved: totalBytes,
      tempEntriesRemoved: totalEntries,
      tempEntriesLocked: totalLocked,
      elapsedMs: Date.now() - startedAt,
    },
  };
  parentPort?.postMessage?.(done);
});
