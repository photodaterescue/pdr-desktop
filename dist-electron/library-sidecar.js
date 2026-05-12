// Library-portable database — sidecar mirror + writer-lock primitives.
//
// One hidden folder lives on the user's library drive at
// <LibraryRoot>\.pdr\ and holds a mirror of everything PDR needs to
// reconnect instantly on another device: the search DB, the
// date-corrections audit log, a small subset of recent snapshots, and
// a single writer-lock file recording which device currently holds
// write access. See the design memo (project_db_in_library.md) for
// the rationale and the multi-device read/write semantics.
//
// This module is pure plumbing — it knows nothing about the UI or the
// renderer. Handlers in main.ts wrap it; the renderer talks to those
// handlers via `window.pdr.library.X` from preload.ts.
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { getDb, closeDatabase } from './search-database.js';
import { getMachineFingerprint } from './license-manager.js';
const SIDECAR_DIRNAME = '.pdr';
const SIDECAR_DB_FILENAME = 'pdr-search.db';
const SIDECAR_LOCK_FILENAME = 'writer.lock';
const SIDECAR_META_FILENAME = 'sidecar-meta.json';
const SIDECAR_AUDIT_FILENAME = 'date-corrections.log.jsonl';
const SIDECAR_BACKUPS_DIRNAME = 'backups';
const LIBRARY_STATE_FILENAME = 'library-state.json';
const LOCK_SCHEMA_VERSION = 1;
// Bump when the DB schema changes in a way that's not backwards-compatible.
// Stored both in the sidecar-meta.json and SQLite's user_version pragma so
// the restore flow can refuse "future" databases written by a newer PDR.
const PDR_DB_SCHEMA_VERSION = 1;
// ─── Path helpers ────────────────────────────────────────────────────────────
export function getSidecarDir(libraryRoot) {
    return path.join(libraryRoot, SIDECAR_DIRNAME);
}
export function getSidecarDbPath(libraryRoot) {
    return path.join(getSidecarDir(libraryRoot), SIDECAR_DB_FILENAME);
}
export function getSidecarLockPath(libraryRoot) {
    return path.join(getSidecarDir(libraryRoot), SIDECAR_LOCK_FILENAME);
}
export function getSidecarMetaPath(libraryRoot) {
    return path.join(getSidecarDir(libraryRoot), SIDECAR_META_FILENAME);
}
export function getSidecarAuditPath(libraryRoot) {
    return path.join(getSidecarDir(libraryRoot), SIDECAR_AUDIT_FILENAME);
}
export function getSidecarBackupsDir(libraryRoot) {
    return path.join(getSidecarDir(libraryRoot), SIDECAR_BACKUPS_DIRNAME);
}
export function getLocalDbPath() {
    return path.join(app.getPath('userData'), 'search-index', 'pdr-search.db');
}
export function getLocalAuditPath() {
    return path.join(app.getPath('userData'), 'date-corrections.log.jsonl');
}
export function getLocalBackupsDir() {
    return path.join(app.getPath('userData'), 'search-index', 'backups');
}
function getLibraryStatePath() {
    return path.join(app.getPath('appData'), 'Photo Date Rescue', LIBRARY_STATE_FILENAME);
}
// ─── Windows hidden-attribute helper ─────────────────────────────────────────
// Dot-prefixed paths aren't hidden in Windows Explorer by default, so we
// also apply attrib +H +S. Failure is non-fatal — the file is still
// usable, just visible. Linux/macOS dot-prefix is already hidden.
function setHidden(targetPath) {
    if (process.platform !== 'win32')
        return;
    if (!fs.existsSync(targetPath))
        return;
    execFile('attrib', ['+H', '+S', targetPath], (err) => {
        if (err) {
            console.warn('[LibSidecar] attrib +H +S failed (non-fatal):', err.message, targetPath);
        }
    });
}
function ensureSidecarDir(libraryRoot) {
    try {
        const dir = getSidecarDir(libraryRoot);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            setHidden(dir);
        }
        return { ok: true };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
}
export function readLibraryState() {
    const p = getLibraryStatePath();
    try {
        if (!fs.existsSync(p))
            return { libraryRoot: null, lastAttachedAt: null };
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            libraryRoot: typeof parsed.libraryRoot === 'string' ? parsed.libraryRoot : null,
            lastAttachedAt: typeof parsed.lastAttachedAt === 'string' ? parsed.lastAttachedAt : null,
        };
    }
    catch (e) {
        console.warn('[LibSidecar] readLibraryState failed:', e.message);
        return { libraryRoot: null, lastAttachedAt: null };
    }
}
export function writeLibraryState(state) {
    const p = getLibraryStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, p);
}
export function readLockFile(libraryRoot) {
    const p = getSidecarLockPath(libraryRoot);
    try {
        if (!fs.existsSync(p))
            return null;
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed.writerDeviceId || !parsed.licenseKeyFingerprint)
            return null;
        return parsed;
    }
    catch (e) {
        console.warn('[LibSidecar] readLockFile failed:', e.message);
        return null;
    }
}
export function writeLockFile(libraryRoot, lock) {
    const ensure = ensureSidecarDir(libraryRoot);
    if (!ensure.ok)
        return ensure;
    try {
        const p = getSidecarLockPath(libraryRoot);
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(lock, null, 2), 'utf8');
        fs.renameSync(tmp, p);
        return { ok: true };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
}
function fingerprintLicenseKey(licenseKey) {
    return crypto.createHash('sha256').update(licenseKey.trim().toUpperCase()).digest('hex').substring(0, 32);
}
export function claimWriter(opts) {
    const lock = {
        schemaVersion: LOCK_SCHEMA_VERSION,
        writerDeviceId: getMachineFingerprint(),
        writerDeviceName: opts.deviceName,
        licenseKeyFingerprint: fingerprintLicenseKey(opts.licenseKey),
        claimedAt: new Date().toISOString(),
    };
    const write = writeLockFile(opts.libraryRoot, lock);
    if (!write.ok)
        return { ok: false, error: write.error };
    return { ok: true, lock };
}
export function isThisDeviceWriter(libraryRoot) {
    const lock = readLockFile(libraryRoot);
    if (!lock)
        return false;
    return lock.writerDeviceId === getMachineFingerprint();
}
export function writeSidecarMeta(libraryRoot, deviceName) {
    const ensure = ensureSidecarDir(libraryRoot);
    if (!ensure.ok)
        return ensure;
    try {
        const meta = {
            schemaVersion: PDR_DB_SCHEMA_VERSION,
            libraryRoot: path.normalize(libraryRoot),
            writtenAt: new Date().toISOString(),
            writerDeviceId: getMachineFingerprint(),
            writerDeviceName: deviceName,
        };
        const p = getSidecarMetaPath(libraryRoot);
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
        fs.renameSync(tmp, p);
        return { ok: true };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
}
export function readSidecarMeta(libraryRoot) {
    try {
        const p = getSidecarMetaPath(libraryRoot);
        if (!fs.existsSync(p))
            return null;
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.schemaVersion !== 'number' || typeof parsed.libraryRoot !== 'string')
            return null;
        return parsed;
    }
    catch (e) {
        console.warn('[LibSidecar] readSidecarMeta failed:', e.message);
        return null;
    }
}
// Rebases absolute file paths in the DB from `oldRoot` to `newRoot`. Uses
// exact-prefix matching (including the path separator) so "D:\Photos" doesn't
// accidentally hit "D:\Photos2". Operates on its own short-lived DB handle —
// caller must ensure the singleton DB is closed first.
function rebaseFilePathsInDb(dbPath, oldRoot, newRoot) {
    const sep = path.sep;
    const oldPrefix = path.normalize(oldRoot).replace(/[\\/]+$/, '') + sep;
    const newPrefix = path.normalize(newRoot).replace(/[\\/]+$/, '') + sep;
    if (oldPrefix === newPrefix) {
        return { ok: true, rowsUpdated: 0 };
    }
    let temp = null;
    try {
        temp = new Database(dbPath);
        let rowsUpdated = 0;
        const tables = [
            { table: 'indexed_files', col: 'file_path' },
            { table: 'indexed_runs', col: 'destination_path' },
        ];
        for (const t of tables) {
            const sql = `
        UPDATE ${t.table}
        SET ${t.col} = ? || SUBSTR(${t.col}, LENGTH(?) + 1)
        WHERE SUBSTR(${t.col}, 1, LENGTH(?)) = ?
      `;
            const info = temp.prepare(sql).run(newPrefix, oldPrefix, oldPrefix, oldPrefix);
            rowsUpdated += info.changes ?? 0;
        }
        return { ok: true, rowsUpdated };
    }
    catch (e) {
        return { ok: false, error: e.message, rowsUpdated: 0 };
    }
    finally {
        try {
            temp?.close();
        }
        catch { }
    }
}
// Reads a DB's user_version pragma without holding a live connection.
// Useful for pre-attach compatibility checks on the sidecar.
function readDbSchemaVersion(dbPath) {
    let temp = null;
    try {
        temp = new Database(dbPath, { readonly: true, fileMustExist: true });
        const result = temp.pragma('user_version', { simple: true });
        return typeof result === 'number' ? result : 0;
    }
    catch {
        return 0;
    }
    finally {
        try {
            temp?.close();
        }
        catch { }
    }
}
function writeDbSchemaVersion(dbPath, version) {
    let temp = null;
    try {
        temp = new Database(dbPath);
        temp.pragma(`user_version = ${version}`);
    }
    finally {
        try {
            temp?.close();
        }
        catch { }
    }
}
// ─── Sidecar DB mirror ───────────────────────────────────────────────────────
// Uses better-sqlite3's online backup API so the copy is consistent
// even while writes are happening. Safer than a raw fs.copy because
// WAL-mode databases need the -wal/-shm files coordinated.
export async function mirrorDbToSidecar(libraryRoot) {
    const ensure = ensureSidecarDir(libraryRoot);
    if (!ensure.ok)
        return ensure;
    const destPath = getSidecarDbPath(libraryRoot);
    const tmpPath = destPath + '.tmp';
    try {
        const db = getDb();
        // better-sqlite3's backup() returns a Promise that resolves when done.
        // Write to a .tmp file first then rename — atomic from the sidecar's
        // perspective, so a half-written DB never sits at the canonical path.
        await db.backup(tmpPath);
        if (fs.existsSync(destPath))
            fs.unlinkSync(destPath);
        fs.renameSync(tmpPath, destPath);
        setHidden(destPath);
        const stat = fs.statSync(destPath);
        return { ok: true, bytes: stat.size };
    }
    catch (e) {
        try {
            if (fs.existsSync(tmpPath))
                fs.unlinkSync(tmpPath);
        }
        catch { }
        return { ok: false, error: e.message };
    }
}
// ─── Sidecar audit-log mirror ────────────────────────────────────────────────
// Straight file copy — the audit log is append-only JSONL so we don't
// need transactional consistency. Small file, fast.
export function mirrorAuditLogToSidecar(libraryRoot) {
    const ensure = ensureSidecarDir(libraryRoot);
    if (!ensure.ok)
        return ensure;
    const src = getLocalAuditPath();
    if (!fs.existsSync(src))
        return { ok: true, bytes: 0 }; // nothing to mirror yet
    const dest = getSidecarAuditPath(libraryRoot);
    const tmp = dest + '.tmp';
    try {
        fs.copyFileSync(src, tmp);
        if (fs.existsSync(dest))
            fs.unlinkSync(dest);
        fs.renameSync(tmp, dest);
        setHidden(dest);
        const stat = fs.statSync(dest);
        return { ok: true, bytes: stat.size };
    }
    catch (e) {
        try {
            if (fs.existsSync(tmp))
                fs.unlinkSync(tmp);
        }
        catch { }
        return { ok: false, error: e.message };
    }
}
// ─── Sidecar snapshot mirror (Recent only) ───────────────────────────────────
// Default policy: mirror the most recent event snapshot + the last 3
// daily snapshots. Gives the user a meaningful rollback window after a
// device-switch recovery without bloating the library footprint.
//
// Snapshot naming convention (per search-database.ts startup snapshot
// + the wider retention scheme described in Settings → Backup):
//   snapshot-auto-launch-<iso-ts>.db
//   snapshot-auto-daily-<iso-ts>.db
//   snapshot-auto-weekly-<iso-ts>.db
//   snapshot-event-<iso-ts>.db
//   snapshot-manual-<name>.db
function pickRecentSnapshots(snapshotFiles) {
    // Sort newest-first by filename (ISO timestamps sort lexically).
    const sorted = [...snapshotFiles].sort().reverse();
    const latestEvent = sorted.find((n) => n.startsWith('snapshot-event-'));
    const dailies = sorted.filter((n) => n.startsWith('snapshot-auto-daily-')).slice(0, 3);
    const out = [];
    if (latestEvent)
        out.push(latestEvent);
    for (const d of dailies)
        if (!out.includes(d))
            out.push(d);
    return out;
}
export function mirrorSnapshotsToSidecar(libraryRoot, mode = 'recent') {
    const ensure = ensureSidecarDir(libraryRoot);
    if (!ensure.ok)
        return { ok: false, error: ensure.error, copied: 0, skipped: 0 };
    if (mode === 'none')
        return { ok: true, copied: 0, skipped: 0 };
    const srcDir = getLocalBackupsDir();
    if (!fs.existsSync(srcDir))
        return { ok: true, copied: 0, skipped: 0 };
    const destDir = getSidecarBackupsDir(libraryRoot);
    try {
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
            setHidden(destDir);
        }
        const allSnapshots = fs.readdirSync(srcDir).filter((n) => n.endsWith('.db'));
        const toMirror = mode === 'all' ? allSnapshots : pickRecentSnapshots(allSnapshots);
        // Build the destination set first so we can prune anything no longer in scope.
        const keepSet = new Set(toMirror);
        let copied = 0;
        let skipped = 0;
        // Copy in (skip if already up-to-date by size+mtime).
        for (const name of toMirror) {
            const src = path.join(srcDir, name);
            const dest = path.join(destDir, name);
            try {
                if (fs.existsSync(dest)) {
                    const sStat = fs.statSync(src);
                    const dStat = fs.statSync(dest);
                    if (sStat.size === dStat.size && sStat.mtimeMs <= dStat.mtimeMs) {
                        skipped += 1;
                        continue;
                    }
                }
                const tmp = dest + '.tmp';
                fs.copyFileSync(src, tmp);
                if (fs.existsSync(dest))
                    fs.unlinkSync(dest);
                fs.renameSync(tmp, dest);
                copied += 1;
            }
            catch (perFileErr) {
                console.warn('[LibSidecar] snapshot copy failed:', name, perFileErr.message);
            }
        }
        // Prune sidecar snapshots that are no longer in the keep set (recent mode rotates).
        for (const existing of fs.readdirSync(destDir)) {
            if (!existing.endsWith('.db'))
                continue;
            if (!keepSet.has(existing)) {
                try {
                    fs.unlinkSync(path.join(destDir, existing));
                }
                catch { }
            }
        }
        return { ok: true, copied, skipped };
    }
    catch (e) {
        return { ok: false, error: e.message, copied: 0, skipped: 0 };
    }
}
export function detectSidecar(libraryRoot) {
    const out = {
        found: false,
        dbExists: false,
        dbSizeBytes: 0,
        lockExists: false,
        lock: null,
        auditExists: false,
        snapshotCount: 0,
    };
    try {
        const dir = getSidecarDir(libraryRoot);
        if (!fs.existsSync(dir))
            return out;
        out.found = true;
        const dbPath = getSidecarDbPath(libraryRoot);
        if (fs.existsSync(dbPath)) {
            out.dbExists = true;
            out.dbSizeBytes = fs.statSync(dbPath).size;
        }
        out.lock = readLockFile(libraryRoot);
        out.lockExists = out.lock !== null;
        out.auditExists = fs.existsSync(getSidecarAuditPath(libraryRoot));
        const backups = getSidecarBackupsDir(libraryRoot);
        if (fs.existsSync(backups)) {
            out.snapshotCount = fs.readdirSync(backups).filter((n) => n.endsWith('.db')).length;
        }
    }
    catch (e) {
        console.warn('[LibSidecar] detectSidecar failed:', e.message);
    }
    return out;
}
export function getLibraryStatus() {
    const state = readLibraryState();
    const thisDeviceId = getMachineFingerprint();
    const out = {
        attached: false,
        libraryRoot: state.libraryRoot,
        thisDeviceId,
        isWriter: false,
        writerDeviceName: null,
        writerDeviceId: null,
        sidecarPresent: false,
        lastAttachedAt: state.lastAttachedAt,
    };
    if (!state.libraryRoot)
        return out;
    out.attached = true;
    const detection = detectSidecar(state.libraryRoot);
    out.sidecarPresent = detection.found;
    if (detection.lock) {
        out.writerDeviceId = detection.lock.writerDeviceId;
        out.writerDeviceName = detection.lock.writerDeviceName;
        out.isWriter = detection.lock.writerDeviceId === thisDeviceId;
    }
    return out;
}
export async function mirrorAllToSidecar(libraryRoot, snapshotMode = 'recent', deviceName) {
    // Stamp the local DB with the current schema version so the user_version
    // pragma rides along in the backup copy. Idempotent if already correct.
    try {
        writeDbSchemaVersion(getLocalDbPath(), PDR_DB_SCHEMA_VERSION);
    }
    catch { }
    const dbResult = await mirrorDbToSidecar(libraryRoot);
    if (!dbResult.ok)
        return { ok: false, error: `DB mirror failed: ${dbResult.error}` };
    const auditResult = mirrorAuditLogToSidecar(libraryRoot);
    if (!auditResult.ok) {
        console.warn('[LibSidecar] audit mirror failed (non-fatal):', auditResult.error);
    }
    const snapResult = mirrorSnapshotsToSidecar(libraryRoot, snapshotMode);
    if (!snapResult.ok) {
        console.warn('[LibSidecar] snapshot mirror failed (non-fatal):', snapResult.error);
    }
    // Best-effort meta write so the sidecar knows its own provenance for
    // future restore-flow path rebasing + schema-compat checks.
    const metaResult = writeSidecarMeta(libraryRoot, deviceName ?? 'Unknown');
    if (!metaResult.ok) {
        console.warn('[LibSidecar] meta write failed (non-fatal):', metaResult.error);
    }
    return {
        ok: true,
        dbBytes: dbResult.bytes,
        auditBytes: auditResult.bytes,
        snapshotsCopied: snapResult.copied,
        snapshotsSkipped: snapResult.skipped,
    };
}
// Attach this folder as our active library. If the sidecar doesn't exist
// yet (first time), we'll create it by mirroring our local DB up. If it
// does exist, we leave it alone and just claim writer (unless another
// device already is — caller decides whether to call takeOverWriter).
export async function attachAsNewLibrary(opts) {
    if (!fs.existsSync(opts.libraryRoot)) {
        return { ok: false, error: `Library path does not exist: ${opts.libraryRoot}` };
    }
    const ensure = ensureSidecarDir(opts.libraryRoot);
    if (!ensure.ok)
        return { ok: false, error: ensure.error };
    // Claim writer first so the lock is in place before we mirror anything.
    const claim = claimWriter({
        libraryRoot: opts.libraryRoot,
        licenseKey: opts.licenseKey,
        deviceName: opts.deviceName,
    });
    if (!claim.ok)
        return { ok: false, error: claim.error };
    // Mirror current local state up to the sidecar.
    const mirror = await mirrorAllToSidecar(opts.libraryRoot, opts.snapshotMode ?? 'recent', opts.deviceName);
    if (!mirror.ok)
        return { ok: false, error: mirror.error };
    writeLibraryState({ libraryRoot: opts.libraryRoot, lastAttachedAt: new Date().toISOString() });
    return { ok: true, status: getLibraryStatus() };
}
// Restore from an existing sidecar onto this device. The fundamental
// "computer stolen / new device / corruption recovery" flow:
//   1. User picks the library folder on the new device.
//   2. We verify the sidecar exists and the schema version is compatible.
//   3. We verify the license-key matches the lock (security gate — same
//      licensee, not a stranger with the drive plugged in).
//   4. We back up whatever local DB exists today, then copy the sidecar DB
//      into the canonical local path.
//   5. If the new library root differs from the one recorded in the meta
//      (e.g. drive letter changed D: → E:), rebase the file_path columns
//      so PDR's photos still resolve.
//   6. Pull the audit log + recent snapshots back down so the device has
//      full undo history and rollback safety from second one.
//   7. Claim writer (rewrite the lock under this device's id) and update
//      the active-library state.
//
// Caller MUST ensure no other DB operations are in flight (no Fix run, no
// active edit). The UI gates this behind a confirmation that says so.
export async function attachFromSidecar(opts) {
    if (!fs.existsSync(opts.libraryRoot)) {
        return { ok: false, error: `Library path does not exist: ${opts.libraryRoot}` };
    }
    const sidecarDbPath = getSidecarDbPath(opts.libraryRoot);
    if (!fs.existsSync(sidecarDbPath)) {
        return { ok: false, error: 'No PDR library data found at this location. Use "Set as new library" instead.' };
    }
    // Schema compatibility: refuse a sidecar written by a future PDR build.
    const sidecarSchemaVersion = readDbSchemaVersion(sidecarDbPath);
    if (sidecarSchemaVersion > PDR_DB_SCHEMA_VERSION) {
        return {
            ok: false,
            error: `This library was created by a newer version of PDR (schema v${sidecarSchemaVersion}, this PDR understands up to v${PDR_DB_SCHEMA_VERSION}). Please update PDR and try again.`,
        };
    }
    // License gate: incoming key must match the existing lock's fingerprint
    // (i.e. you must be the same customer who set this library up). Allows
    // legitimate device switches; blocks "found a drive on the street."
    const existingLock = readLockFile(opts.libraryRoot);
    if (existingLock) {
        const incomingFp = fingerprintLicenseKey(opts.licenseKey);
        if (incomingFp !== existingLock.licenseKeyFingerprint) {
            return { ok: false, error: 'License key does not match this library.' };
        }
    }
    // Back up the current local DB before we overwrite it. Tucked into the
    // existing snapshot backups folder with a distinctive prefix so it's
    // easy to find if a user ever needs to roll back a botched restore.
    const localDbPath = getLocalDbPath();
    const localBackupsDir = getLocalBackupsDir();
    try {
        if (fs.existsSync(localDbPath)) {
            if (!fs.existsSync(localBackupsDir))
                fs.mkdirSync(localBackupsDir, { recursive: true });
            const ts = new Date().toISOString().replace(/[:]/g, '-');
            const backupName = `snapshot-pre-restore-${ts}.db`;
            fs.copyFileSync(localDbPath, path.join(localBackupsDir, backupName));
        }
    }
    catch (e) {
        console.warn('[LibSidecar] pre-restore backup failed (continuing):', e.message);
    }
    // Close the live DB connection before overwriting the file. Next call to
    // getDb() will reopen via initDatabase() and pick up the restored file.
    try {
        closeDatabase();
    }
    catch { }
    // Copy sidecar → local. Use atomic temp+rename so a half-finished copy
    // never sits at the canonical path.
    try {
        if (!fs.existsSync(path.dirname(localDbPath))) {
            fs.mkdirSync(path.dirname(localDbPath), { recursive: true });
        }
        const tmp = localDbPath + '.restore.tmp';
        fs.copyFileSync(sidecarDbPath, tmp);
        if (fs.existsSync(localDbPath))
            fs.unlinkSync(localDbPath);
        fs.renameSync(tmp, localDbPath);
    }
    catch (e) {
        return { ok: false, error: `Could not copy library DB to this device: ${e.message}` };
    }
    // Path rebasing if the library moved. Meta is best-effort — if it's
    // missing, we skip rebasing (paths in DB are absolute; if they happen
    // to still resolve, great; if not, the user can re-scan their library).
    const meta = readSidecarMeta(opts.libraryRoot);
    let pathRebaseRows = 0;
    if (meta && meta.libraryRoot) {
        const oldRoot = path.normalize(meta.libraryRoot);
        const newRoot = path.normalize(opts.libraryRoot);
        if (oldRoot !== newRoot) {
            const rebase = rebaseFilePathsInDb(localDbPath, oldRoot, newRoot);
            if (!rebase.ok) {
                console.warn('[LibSidecar] path rebase failed (non-fatal):', rebase.error);
            }
            else {
                pathRebaseRows = rebase.rowsUpdated;
                console.log(`[LibSidecar] rebased ${pathRebaseRows} path rows from ${oldRoot} → ${newRoot}`);
            }
        }
    }
    // Pull the audit log down too if the sidecar has one.
    try {
        const sidecarAudit = getSidecarAuditPath(opts.libraryRoot);
        const localAudit = getLocalAuditPath();
        if (fs.existsSync(sidecarAudit)) {
            fs.mkdirSync(path.dirname(localAudit), { recursive: true });
            const tmp = localAudit + '.restore.tmp';
            fs.copyFileSync(sidecarAudit, tmp);
            if (fs.existsSync(localAudit))
                fs.unlinkSync(localAudit);
            fs.renameSync(tmp, localAudit);
        }
    }
    catch (e) {
        console.warn('[LibSidecar] audit log restore failed (non-fatal):', e.message);
    }
    // Pull recent snapshots from the sidecar into the local backups folder so
    // the user has rollback safety from second one on the new device.
    try {
        const sidecarBackups = getSidecarBackupsDir(opts.libraryRoot);
        if (fs.existsSync(sidecarBackups)) {
            if (!fs.existsSync(localBackupsDir))
                fs.mkdirSync(localBackupsDir, { recursive: true });
            for (const name of fs.readdirSync(sidecarBackups)) {
                if (!name.endsWith('.db'))
                    continue;
                const src = path.join(sidecarBackups, name);
                const dest = path.join(localBackupsDir, name);
                if (fs.existsSync(dest))
                    continue; // don't clobber locally-newer snapshots
                try {
                    fs.copyFileSync(src, dest);
                }
                catch { }
            }
        }
    }
    catch (e) {
        console.warn('[LibSidecar] snapshot restore failed (non-fatal):', e.message);
    }
    // Claim writer for this device.
    const claim = claimWriter({
        libraryRoot: opts.libraryRoot,
        licenseKey: opts.licenseKey,
        deviceName: opts.deviceName,
    });
    if (!claim.ok)
        return { ok: false, error: claim.error };
    // Refresh sidecar meta now that we're the writer on the new device.
    writeSidecarMeta(opts.libraryRoot, opts.deviceName);
    writeLibraryState({ libraryRoot: opts.libraryRoot, lastAttachedAt: new Date().toISOString() });
    return { ok: true, status: getLibraryStatus() };
}
// Take over writer status from another device. License-key gated — the
// key fingerprint just has to match the existing lock's (i.e. same
// licensee), so a stranger with read-only access can't hijack.
export function takeOverWriter(opts) {
    const existing = readLockFile(opts.libraryRoot);
    if (existing) {
        const incoming = fingerprintLicenseKey(opts.licenseKey);
        if (incoming !== existing.licenseKeyFingerprint) {
            return { ok: false, error: 'License key does not match this library.' };
        }
    }
    const claim = claimWriter({
        libraryRoot: opts.libraryRoot,
        licenseKey: opts.licenseKey,
        deviceName: opts.deviceName,
    });
    if (!claim.ok)
        return { ok: false, error: claim.error };
    writeLibraryState({ libraryRoot: opts.libraryRoot, lastAttachedAt: new Date().toISOString() });
    return { ok: true, status: getLibraryStatus() };
}
export function disconnectLibrary() {
    writeLibraryState({ libraryRoot: null, lastAttachedAt: null });
    return { ok: true };
}
