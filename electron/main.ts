import { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net, nativeImage, utilityProcess, screen, nativeTheme } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { execSync, execFile } from 'child_process';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import sharp from 'sharp';
import log from 'electron-log/main.js';

// Raise V8's old-generation heap ceiling from the default ~1.5 GB to
// 4 GB. Belt-and-braces against memory pressure on users with less
// RAM headroom than the developer machine — specifically covers the
// edge where a large Google Takeout zip's analysis spikes memory and
// the default heap trips before the OS swap kicks in. The zip engine
// was rewritten to stream one entry at a time so this ceiling should
// rarely be approached, but raising it removes a fragile cliff for
// the handful of paths (sharp thumbnailing, clustering buffers) that
// still allocate larger transient arrays.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

// Pin the app name BEFORE electron-log resolves its file path. In
// production the packaged `productName` from package.json takes
// effect automatically, but in development `npx electron` reports
// the app as "Electron", which would dump the log into
// %APPDATA%\Electron\logs — inconsistent with what users see and
// what support docs reference.
app.setName('Photo Date Rescue');

// Also pin `userData` explicitly. Electron resolves `app.getPath('userData')`
// at import time using the lower-cased package.json `name` field
// (`photo-date-rescue`), and `app.setName` above does NOT retroactively
// migrate that path — so the search-index DB, ai-models, license,
// thumbnails, fix-reports and Local Storage all silently end up in
// `%APPDATA%\photo-date-rescue\` while `setName`-aware consumers
// (logs, settings-store) write to `%APPDATA%\Photo Date Rescue\`.
// That split-brain behaviour was the cause of the "PM shows zero
// faces after a Fix" bug — the running app's DB path drifted away
// from where the user's prior AI work lived. Calling `setPath` here,
// before any module that uses `getPath('userData')` is invoked,
// forces every consumer onto the canonical capital-S folder for
// dev (npx electron) and packaged builds alike.
app.setPath('userData', path.join(app.getPath('appData'), 'Photo Date Rescue'));

// ───────── Persistent log file ─────────
// Every console.log / warn / error from the main process is mirrored
// into %APPDATA%\photo-date-rescue\logs\main.log (Windows) — with
// daily-rotation archives so the file doesn't grow forever. Renderer
// processes send their console output here too via the forwarder
// wired to `contextBridge` in preload.ts.
//
// We ship DevTools disabled in production, so these files are the
// only forensic trail we have for crashes users report. The location
// is surfaced back to the renderer through `ipc('app:logFilePath')`
// so a future "Report a problem" button can bundle it straight into
// a support email. Until that button lands, users / support can grab
// it manually from:
//
//   %APPDATA%\photo-date-rescue\logs\main.log
//
// Rotation: file caps at 5 MB; older chunks roll to `main.old.log`
// so total disk footprint stays bounded at ~10 MB.
log.transports.file.level = 'info';
log.transports.file.maxSize = 5 * 1024 * 1024;
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
// Console transport: only write to stdout when it's an attached TTY.
// In dev launches piped through a harness/IDE, stdout can disappear
// while Electron keeps running (Electron is windowed; doesn't follow
// the launcher's lifecycle). Subsequent console writes throw EPIPE,
// which cascades through electron-log's own ErrorHandler — it tries
// to log the error via the same broken pipe and infinitely recurses.
// In production (NSIS-launched .exe) there's no console at all so
// the console transport is dead weight anyway. Either way the file
// transport (under %APPDATA%\Photo Date Rescue\logs\) keeps full
// log fidelity and is the canonical source for diagnostics.
log.transports.console.level = process.stdout.isTTY ? 'debug' : false;
// electron-log reads the app name at import time, so app.setName()
// above doesn't retroactively move the file. Pin an explicit path
// under %APPDATA%\Photo Date Rescue\logs regardless of whether we're
// running dev (npx electron, app name = "Electron") or a packaged
// build. Mirrors what the support docs will tell users.
log.transports.file.resolvePathFn = (vars) => path.join(
  app.getPath('appData'),
  'Photo Date Rescue',
  'logs',
  vars.fileName ?? 'main.log',
);
// Route stdlib console calls through electron-log so every existing
// console.log/warn/error in the codebase is captured without having
// to touch the call sites.
Object.assign(console, log.functions);

// ───────── One-time license cache migration ─────────
// Pre-f85827a builds (every PDR before v2.0.0) resolved userData via
// the lowercase package.json `name`, landing under %APPDATA%\Electron
// in dev launches and other split-brain paths. license.json followed,
// so users upgrading from those builds saw an empty cache at the new
// canonical path → were prompted to re-Activate → consumed a fresh
// LS instance slot. With LS's 3-slot per-license default, three such
// upgrades exhausted the user's slots.
//
// Runs after Object.assign (so audit log lines actually reach
// main.log) but BEFORE license-manager.ts is imported below — its
// loadCache reads the canonical path, so we need the file in place
// first. If the canonical path has no license.json but a legacy path
// does, copy across and delete the legacy original. Best-effort:
// failures are logged but never thrown — a missing migration just
// leaves the user at the cached state they'd otherwise hit anyway
// (Activate prompt).
(function migrateLegacyLicenseCache() {
  // Two known legacy paths from pre-f85827a builds:
  //   1. %APPDATA%\Electron\license.json
  //      Dev launches (`npx electron .`) before app.setName/setPath
  //      took effect — Electron's default app name was used.
  //   2. %APPDATA%\photo-date-rescue\license.json
  //      Installed builds where setName fired but setPath did not,
  //      so userData defaulted to package.json's lowercase `name`.
  const canonical = path.join(app.getPath('appData'), 'Photo Date Rescue', 'license.json');
  const legacyPaths = [
    path.join(app.getPath('appData'), 'Electron', 'license.json'),
    path.join(app.getPath('appData'), 'photo-date-rescue', 'license.json'),
  ];

  try {
    if (fs.existsSync(canonical)) {
      // Canonical wins. Sweep any stale legacy copies so a future
      // canonical wipe (corruption, manual delete) can't accidentally
      // resurrect a stale lsInstanceId pointing at a dead LS slot.
      for (const legacy of legacyPaths) {
        if (fs.existsSync(legacy)) {
          try {
            fs.unlinkSync(legacy);
            console.log(`[license-migration] cleaned up stale ${legacy}`);
          } catch (cleanupErr) {
            console.error(`[license-migration] cleanup of ${legacy} failed:`, cleanupErr);
          }
        }
      }
      return;
    }

    // Canonical missing — try to migrate from a legacy path. First
    // match wins; the other (if also present) gets cleaned up after.
    const legacy = legacyPaths.find(p => fs.existsSync(p));
    if (!legacy) return; // nothing to migrate

    // Ensure canonical directory exists (first launch may not have created it yet).
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.copyFileSync(legacy, canonical);
    fs.unlinkSync(legacy);
    console.log(`[license-migration] copied ${legacy} → ${canonical} and deleted source`);

    // Also clean up the OTHER legacy path if it's still sitting around,
    // so we don't leave a footprint that could re-migrate next launch.
    for (const other of legacyPaths) {
      if (other !== legacy && fs.existsSync(other)) {
        try {
          fs.unlinkSync(other);
          console.log(`[license-migration] cleaned up additional stale ${other}`);
        } catch (cleanupErr) {
          console.error(`[license-migration] cleanup of ${other} failed:`, cleanupErr);
        }
      }
    }
  } catch (err) {
    // Don't throw — at worst the user sees an Activate prompt, which
    // is exactly what they would have seen without this migration.
    console.error('[license-migration] failed:', err);
  }
})();

// Catch every uncaughtException + unhandledRejection in the main
// process, write it to the log file via electron-log, but DON'T
// surface a "JavaScript error in main process" modal to the user.
//
// The trigger that prompted this: in dev (`npx electron .`), if the
// parent shell that captured stdout is killed while Electron keeps
// running (which it does — Electron is a windowed process, not a
// child of the launcher shell), every subsequent console.log →
// log.transports.console → process.stdout.write throws EPIPE: broken
// pipe. Without a global handler that becomes an unhandled exception,
// which Electron's default behaviour shows as a blocking JS-error
// dialog. Production .exe installs have no parent shell so EPIPE
// doesn't fire there — but defending against unhandled exceptions
// across the board is better than a per-symptom fix.
//
// `showDialog: false` is the critical piece — without it, electron-log
// honours its default of popping a dialog before writing to file.
// We want silent → log file → user keeps working.
log.errorHandler.startCatching({ showDialog: false });
// ffmpeg-static is a CommonJS module; createRequire lets us require it from ESM.
const esmRequire = createRequire(import.meta.url);
let ffmpegPath: string | null = null;
try {
  ffmpegPath = esmRequire('ffmpeg-static');
  if (ffmpegPath && !fs.existsSync(ffmpegPath)) ffmpegPath = null;
} catch { ffmpegPath = null; }
console.log('[ffmpeg] path =', ffmpegPath);

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.3gp', '.mpg', '.mpeg']);

// v2.0.15 (Terry 2026-06-05) — session-level FAILURE COUNTER for video
// thumbnail extraction. Without this, every scroll past a known-bad
// HEVC clip in S&D / Memories re-spawns the 4-attempt ffmpeg cascade;
// on a library with hundreds of unsupported clips in a 6,996-video
// S&D result set, the scroll-induced subprocess storm crashed the
// renderer.
//
// Counter (not boolean) because the FIRST cascade run was prone to
// transient OS-side kills during the storm itself — a legitimate file
// could get poisoned after one bad-luck run, then stay missing until
// the next session. With a counter we tolerate transient failures and
// only give up after `VIDEO_THUMB_GIVE_UP_AFTER` consecutive misses
// from the SAME file. A successful extract resets the counter to 0.
const VIDEO_THUMB_FAILURE_COUNT = new Map<string, number>();
const VIDEO_THUMB_GIVE_UP_AFTER = 3;

// v2.0.15 (Terry 2026-06-05) — hard cap on a single ffmpeg subprocess
// per attempt. The "no stderr — likely killed / crashed" log lines
// were typically OS-side process kills (Windows kills children when
// the parent renderer hits memory pressure). A 5s deadline matches
// the longest legitimate extract time we've seen on slow USB drives
// and prevents a single hung ffmpeg from holding a slot in the
// (forthcoming) concurrency limiter.
const FFMPEG_ATTEMPT_TIMEOUT_MS = 5_000;

/**
 * Extract a single frame from a video using ffmpeg-static. Returns a JPEG buffer
 * suitable for piping into sharp. Seeks ~1s into the video to skip the usual
 * black/fade-in frame. Falls back to frame 0 if the video is shorter than 1s.
 */
async function extractVideoFrame(videoPath: string, seekSec = 1): Promise<Buffer | null> {
  if (!ffmpegPath) return null;
  return new Promise<Buffer | null>((resolve) => {
    const tmp = path.join(os.tmpdir(), `pdr-vthumb-${crypto.randomBytes(6).toString('hex')}.jpg`);
    // ffmpeg's mov/mp4/mkv demuxers on Windows can't open paths via the
    // `\\?\` extended-length prefix — they bail with "Invalid argument"
    // and exit 127. Callers routinely pass us prefixed paths (toLongPath
    // is applied indiscriminately upstream). Strip the prefix before
    // handing the path to ffmpeg; paths > 260 chars are an ffmpeg
    // limitation we can't dodge from this side anyway.
    const ffmpegSrc = fromLongPath(videoPath);
    // -ss before -i is a fast seek; -frames:v 1 takes a single frame; -y overwrites
    const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(seekSec), '-i', ffmpegSrc, '-frames:v', '1', '-q:v', '3', '-y', tmp];
    const proc = spawn(ffmpegPath!, args, { windowsHide: true });
    // v2.0.15 (Terry 2026-05-31) — capture stderr so we can surface
    // the actual ffmpeg failure reason when extraction fails (instead
    // of the previous blind "no frame extracted" log). Critical for
    // diagnosing OnePlus / Samsung Motion Photo HEVC variants that
    // bundled ffmpeg-static currently can't decode for thumbnails.
    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      // Cap at ~4KB so a chatty error doesn't fill main.log.
      if (stderrBuf.length < 4096) {
        stderrBuf += chunk.toString('utf8');
      }
    });
    let finished = false;
    let timedOut = false;
    // v2.0.15 — kill the subprocess if it runs past the deadline.
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* best-effort */ }
    }, FFMPEG_ATTEMPT_TIMEOUT_MS);
    const done = async (ok: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      try {
        if (ok && fs.existsSync(tmp)) {
          const buf = await fs.promises.readFile(tmp);
          fs.promises.unlink(tmp).catch(() => {});
          resolve(buf);
          return;
        }
      } catch {}
      fs.promises.unlink(tmp).catch(() => {});
      // Log the real ffmpeg error if we have one — single line, file +
      // seek position prefixed so the cascade's 2 attempts are
      // distinguishable in main.log. Empty stderr means ffmpeg
      // crashed before printing anything; we still log a marker line.
      const trimmed = stderrBuf.trim().replace(/\s+/g, ' ');
      const tag = timedOut ? ` <killed after ${FFMPEG_ATTEMPT_TIMEOUT_MS}ms>` : '';
      if (trimmed) {
        log.warn(`[ffmpeg] extract failed seek=${seekSec}s file="${path.basename(ffmpegSrc)}"${tag}: ${trimmed.slice(0, 500)}`);
      } else {
        log.warn(`[ffmpeg] extract failed seek=${seekSec}s file="${path.basename(ffmpegSrc)}"${tag}: <no stderr — likely killed / crashed>`);
      }
      resolve(null);
    };
    proc.on('error', () => done(false));
    proc.on('close', (code) => done(code === 0));
    // Safety timeout so hangs don't pile up
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} done(false); }, 15000);
  });
}

// Let sharp use default thread pool (number of CPU cores) for fast encoding
import { analyzeSource, cancelAnalysis, isAnalysisCancelled, configureDeps as configureAnalysisDeps, AnalysisProgress, SourceAnalysisResult } from './analysis-engine.cjs';
import AdmZip from 'adm-zip';
import * as unzipper from 'unzipper';
import crypto from 'crypto';
import { saveReport, loadReport, loadLatestReport, listReports, deleteReport, exportReportToCSV, exportReportToTXT, getExportFilename, writeCatalogue, FixReport } from './report-storage.js';
import { toLongPath, fromLongPath } from './long-path.js';
import { getSettings, setSetting, setSettings, PDRSettings, resetCriticalSettings, resetToOptimisedDefaults, getScannerOverride, listScannerOverrides } from './settings-store.js';
import { writeExifDate, shutdownExiftool } from './exif-writer.js';
import {
  getLicenseStatus,
  activateLicense,
  refreshLicense,
  deactivateLicense,
  clearCache as clearLicenseCache,
  getMachineFingerprint
} from './license-manager.js';
import {
  getUsage as getUsageFromWorker,
  incrementUsage as incrementUsageOnWorker,
  FREE_TRIAL_FILE_LIMIT,
} from './usage-tracker.js';
import {
  checkForUpdates,
  initAutoUpdater,
  downloadUpdate,
  quitAndInstall,
  getUpdateState,
} from './update-checker.js';
import { classifySource, checkSameDriveWarning } from './source-classifier.cjs';
import {
  extractTakeoutGroupId,
  getSidecarSummary,
  scanSidecarsFromZips,
  lookupSidecarByBasename,
  snapshotSidecarMapForWorker,
  warmSidecarSnapshotCache,
} from './takeout-sidecar-cache.js';

// v2.0.14 — wire the real settings-store + DB lookups into the now-
// shared (CJS) analysis-engine module. Main process runs analysis
// in-process for now (Phase B will swap this for a utility-process
// worker fork below). The worker has its own analysis-engine instance
// and configures it with snapshot-backed lookups, so this assignment
// doesn't leak across processes.
configureAnalysisDeps({
  getScannerOverride,
  lookupSidecarByBasename: (basename) => {
    const r = lookupSidecarByBasename(basename);
    if (!r) return null;
    return { photoTakenUnix: r.photoTakenUnix, sourceZip: r.sourceZip };
  },
});
import {
  cancelEnrichment,
  dryRunEnrichment,
  getLatestEnrichmentRun,
  runEnrichment,
} from './enrichment-engine.js';
import {
  initDatabase,
  closeDatabase,
  searchFiles,
  getFilterOptions,
  getFilterCounts,
  getIndexStats,
  clearAllIndexData,
  removeRun,
  removeRunByReportId,
  listRuns,
  getMemoriesYearMonthBuckets,
  setMonthlyThumbnailOverride,
  clearMonthlyThumbnailOverride,
  getMemoriesOnThisDay,
  getMemoriesDayFiles,
  saveFavouriteFilter,
  listFavouriteFilters,
  deleteFavouriteFilter,
  renameFavouriteFilter,
  // getDb — direct DB handle for ad-hoc aggregation queries that don't
  // fit the existing typed helpers (e.g. library:listIndexedDrives, which
  // GROUP BYs over the drive-letter prefix of file_path). Used sparingly.
  getDb,
  getUserRotation,
  type SearchQuery,
} from './search-database.js';
import { indexFixRun, cancelIndexing, shutdownIndexerExiftool, rebuildIndexFromLibraries, walkMediaFiles, type IndexProgress, type RebuildProgress } from './search-indexer.js';
import { loadReport as loadReportForIndex } from './report-storage.js';
import {
  gatherTakeoutEnrichmentFromFixResults,
  gatherTakeoutEnrichmentFromZip,
  importTakeoutAlbumsFromEnrichment,
  type PendingTakeoutEnrichment,
  type BackfillStats,
  type TakeoutImportSummary,
} from './takeout-album-importer.js';
import {
  startAiProcessing,
  cancelAiProcessing,
  pauseAiProcessing,
  resumeAiProcessing,
  isAiPaused,
  shutdownAiWorker,
  isAiProcessing,
  areModelsDownloaded,
  setMainWindow as setAiMainWindow,
  runFaceClustering,
  runIncrementalClustering,
  redetectSingleFile,
} from './ai-manager.js';
import {
  listPersons,
  upsertPerson,
  assignPersonToCluster,
  assignPersonToFace,
  unnameFace,
  renamePerson,
  mergePersons,
  deletePerson,
  permanentlyDeletePerson,
  unnamePersonAndDelete,
  restoreUnnamedPerson,
  restorePerson,
  listDiscardedPersons,
  getPersonById,
  getVisualSuggestions,
  getClusterFaceCount,
  getFacesForFile,
  getAiTagsForFile,
  getAiTagOptions,
  getAiStats,
  clearAllAiData,
  resetAllTagAnalysis,
  getUnprocessedFileIds,
  getUnclusteredFaceCount,
  moveFilesToRecycleBin,
  restoreFilesFromRecycleBin,
  deleteIndexedFiles,
  listRecycleBin,
  getRecycleBinCount,
  listSavedTrees,
  getSavedTree,
  createSavedTree,
  updateSavedTree,
  deleteSavedTree,
  toggleHiddenAncestor,
  undoLastGraphOperation,
  redoGraphOperation,
  getGraphHistoryCounts,
  listGraphHistoryEntries,
  revertToGraphHistoryEntry,
  rebuildAiFts,
  getPersonClusters,
  getClusterFaces,
  getPersonsWithCooccurrence,
  cleanupOrphanedPersons,
  runDatabaseCleanup,
  relocateRun,
  addRelationship,
  updateRelationship,
  removeRelationship,
  listRelationshipsForPerson,
  listAllRelationships,
  updatePersonLifeEvents,
  setPersonCardBackground,
  setPersonGender,
  getFamilyGraph,
  getPersonCooccurrenceStats,
  getPartnerSuggestionScores,
  createPlaceholderPerson,
  createNamedPerson,
  namePlaceholder,
  mergePlaceholderIntoPerson,
  removePlaceholder,
  type RelationshipRecord,
  type RelationshipType,
  type RelationshipFlags,
} from './search-database.js';

import {
  attachAsNewLibrary,
  attachFromSidecar,
  detectDriveType,
  detectRecoveryGap,
  detectSidecar,
  disconnectLibrary,
  getLibraryStatus,
  markDbDirty,
  mirrorAllToSidecar,
  setBackgroundMirrorDeviceName,
  startBackgroundMirror,
  takeOverWriter,
} from './library-sidecar.js';

// Update checking — see electron/update-checker.ts for the full state
// machine. The renderer subscribes to push events on the
// 'updates:state' channel and can trigger lifecycle transitions
// (download, install) via these IPC handlers.
ipcMain.handle('updates:check', async () => {
  return await checkForUpdates();
});

ipcMain.handle('updates:getVersion', () => {
  return app.getVersion();
});

ipcMain.handle('updates:download', async () => {
  await downloadUpdate();
});

ipcMain.handle('updates:install', () => {
  quitAndInstall();
});

ipcMain.handle('updates:getState', () => {
  return getUpdateState();
});


// Storage classification
ipcMain.handle('storage:classify', async (_event, sourcePath: string) => {
  return classifySource(sourcePath);
});

ipcMain.handle('storage:checkSameDrive', async (_event, sourcePath: string, outputPath: string) => {
  return checkSameDriveWarning(sourcePath, outputPath);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

// v2.0.15 (Terry 2026-05-31) — utilityProcess workers live OUTSIDE
// the asar archive (in resources/dist-electron/, declared via
// electron-builder's extraResources). Their require('better-sqlite3')
// chain walks Node's standard module-resolution path UP from the
// worker file's location — but in a packaged install those parent
// dirs (resources/dist-electron/node_modules/, resources/node_modules/)
// don't exist. electron-builder unpacks native modules to
// resources/app.asar.unpacked/node_modules/, but that path isn't on
// the worker's default search list.
//
// Setting NODE_PATH adds it as a secondary lookup root, so a worker's
// `require('better-sqlite3')` finds the unpacked .node binary. In
// dev (app.isPackaged === false), workers resolve normally against
// the workspace's node_modules and NODE_PATH is left untouched.
//
// MUST be passed to EVERY utilityProcess.fork call site, otherwise
// that worker silently fails on first DB access with
//   Error: Cannot find module 'better-sqlite3'
// — the exact regression that broke v2.0.15 packaging the first time.
function workerEnv(): NodeJS.ProcessEnv {
  if (!app.isPackaged) return process.env as NodeJS.ProcessEnv;
  const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');
  const existing = process.env.NODE_PATH || '';
  return {
    ...process.env,
    NODE_PATH: existing ? `${existing}${path.delimiter}${unpacked}` : unpacked,
  } as NodeJS.ProcessEnv;
}

// Yield to event loop to keep UI responsive
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Hard-disable browser-style navigation on every PDR BrowserWindow.
 *
 * PDR is a desktop app — Alt+Left, Alt+Right and the side mouse
 * buttons should never navigate anywhere. They're a relic of
 * Electron's webview heritage. Without this hardening:
 *   • Alt+Left / Alt+Right → BrowserWindow history navigation
 *   • Mouse side button (back) → 'browser-backward' app command
 *   • Mouse side button (forward) → 'browser-forward' app command
 * In real-world testing, an accidental side-mouse-button click
 * during a Fix navigated PDR away from the in-progress modal,
 * which is unacceptable. This helper closes every avenue:
 *   1. before-input-event preventDefault on Alt+Arrow keys
 *   2. app-command preventDefault on browser-backward/forward
 *   3. will-navigate preventDefault to block any navigation attempt
 *   4. clearHistory() after load so there's nothing to navigate to
 *      even if a gesture slips through.
 *
 * Apply to every BrowserWindow PDR creates — main, People Manager,
 * Date Editor, Viewer.
 */
function hardenWindowAgainstNavigation(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.alt && (input.key === 'ArrowLeft' || input.key === 'ArrowRight')) {
      event.preventDefault();
    }
  });
  win.on('app-command', (event, command) => {
    if (command === 'browser-backward' || command === 'browser-forward') {
      event.preventDefault();
    }
  });
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  win.webContents.on('did-finish-load', () => {
    try { win.webContents.clearHistory(); } catch { /* ignore */ }
  });
}

// Mirror a local staging folder onto a (typically network) destination
// using Windows' native robocopy with /MT:16 multi-threading. We
// stage every file locally during the per-file loop (fast disk I/O,
// rename + EXIF write happen here) and then call this once at the
// end to push the whole tree to the slow target. /MT:16 has been
// measured at 5–10× faster than Node's single-stream pipe loop on
// network destinations because it parallelises the per-file
// network round-trips that sequential code can't overlap.
//
// /E    — copy subdirs including empty ones (recreates our subfolder layout)
// /MT:16 — 16 multi-threaded copy workers
// /R:2 /W:5 — retry twice with 5s wait (default is 1M retries × 30s
//             which would deadlock on a transient SMB hiccup)
// /NP /NDL /NJH /NJS — quieter output (no per-file %, no dir listing,
//                      no header, no summary). We still parse the
//                      filename lines that remain to push progress
//                      events.
//
// Robocopy exit codes are bitmasks: 0–7 are success states (files
// copied, extras detected, mismatches, etc.). 8+ indicates a real
// failure. We treat 0–7 as success and surface 8+ verbatim.
function runRobocopyMirror(
  stagingDir: string,
  realDest: string,
  onFileCopied: () => void,
  abortSignal: { cancelled: boolean }
): Promise<{ success: boolean; exitCode: number; stderr?: string }> {
  return new Promise((resolve) => {
    const args = [stagingDir, realDest, '/E', '/MT:16', '/R:2', '/W:5', '/NP', '/NDL', '/NJH', '/NJS'];
    const child = spawn('robocopy', args, { windowsHide: true });
    let stderrBuf = '';
    let leftover = '';
    const checkAbort = setInterval(() => {
      if (abortSignal.cancelled && !child.killed) {
        try { child.kill(); } catch { /* already dead */ }
      }
    }, 250);
    child.stdout?.on('data', (chunk: Buffer) => {
      // Robocopy emits one line per file. Split on newlines and
      // count non-empty entries that look like file paths.
      const text = leftover + chunk.toString('utf8');
      const lines = text.split(/\r?\n/);
      leftover = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        // File rows usually have either a size or a "New File" marker.
        // Heuristic: a line containing a backslash AND not starting with
        // a stat-summary token is treated as a per-file event.
        if (trimmed && /[\\/]/.test(trimmed) && !/^Total|^Bytes|^Speed|^Ended|^Started/i.test(trimmed)) {
          onFileCopied();
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      clearInterval(checkAbort);
      const exitCode = code ?? -1;
      const success = exitCode >= 0 && exitCode <= 7;
      resolve({ success, exitCode, stderr: stderrBuf || undefined });
    });
    child.on('error', (err) => {
      clearInterval(checkAbort);
      resolve({ success: false, exitCode: -1, stderr: err.message });
    });
  });
}

// Streaming copy that optionally computes hash during copy (single read from disk)
async function streamCopyFile(src: string, dest: string, computeHash = false): Promise<string | null> {
  // Long-path-safe wrappers on BOTH ends. The Fix-copy phase frequently
  // hits long-path territory: source can be a deep Takeout entry under
  // PDR_Temp, destination is the year-folder structure under the user's
  // library drive which itself may sit under a deeply-nested path. Either
  // end exceeding MAX_PATH (260 chars on Windows without the prefix) fails
  // here with `UNKNOWN: unknown error, read` — see Jane's case 2026-05-16.
  // No-op on macOS/Linux.
  const srcLong = toLongPath(src);
  const destLong = toLongPath(dest);

  // v2.0.15 (Terry 2026-06-01) — OS-NATIVE COPY FAST PATH.
  // When we don't need to compute a hash during the copy (the common
  // case: skipDuplicates off, OR heuristic dedup, OR a file larger
  // than LARGE_FILE_THRESHOLD where we always heuristic), let the OS
  // do the copy via fs.promises.copyFile. On Windows that routes
  // through libuv → CopyFileExW which is a single kernel-level
  // syscall — much faster than the user-mode stream copy below
  // which sends bytes through 64 KB chunks (3 125 chunks for a 200
  // MB video × ~3 ms syscall round-trip ≈ 10 s of pure scheduling
  // overhead). Measured locally: stream copy ran VIDEO0057 (~200 MB)
  // at 12.5 MB/s; fs.copyFile takes it through the kernel zero-copy
  // path at the full drive write speed (typically 200–500 MB/s on
  // SSD). Stream path retained below for the hash branch — we still
  // need the byte stream there to compute SHA-256 inline without a
  // second I/O pass.
  if (!computeHash) {
    await fs.promises.copyFile(srcLong, destLong);
    return null;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      readStream.destroy();
      writeStream.destroy();
      reject(new Error(`Copy timeout: ${path.basename(src)}`));
    }, 120000); // 2 min timeout per file
    const readStream = fs.createReadStream(srcLong, { highWaterMark: 64 * 1024 });
    const writeStream = fs.createWriteStream(destLong);
    const hashObj = computeHash ? crypto.createHash('sha256') : null;

    readStream.on('data', (chunk) => { if (hashObj) hashObj.update(chunk); });
    readStream.on('error', (err) => { clearTimeout(timer); reject(err); });
    writeStream.on('error', (err) => { clearTimeout(timer); reject(err); });
    writeStream.on('finish', () => { clearTimeout(timer); resolve(hashObj ? hashObj.digest('hex') : null); });

    readStream.pipe(writeStream);
  });
}

// ─── v2.0.11 startup sequence: splash window + utilityProcess + hidden
// workspace window, coordinated by maybeFinishStartup().
//
// Terry 2026-05-24: the chunked-cleanup approach still froze the
// startup because too many things competed on the main browser
// thread. The only architecture that delivers "splash interactive
// throughout, workspace appears ready-to-use" is the loading-screen
// pattern from premium native apps:
//
//   1. createSplashWindow() — small BrowserWindow with its own
//      renderer process. Stays interactive (drag/resize) regardless
//      of what the rest of the app is doing because its renderer
//      is idle.
//   2. spawnStartupWorker() — utilityProcess that runs the heavy
//      cleanup (DB stale-file walk, orphan-sweep on PDR_Temp). Its
//      own process = main browser thread stays unblocked = message
//      pump always responsive.
//   3. createWindow() — workspace BrowserWindow with show: false.
//      Mounts in the background while the splash is up. Doesn't
//      reveal until BOTH the renderer's ready-to-show fires AND the
//      worker has posted 'done' AND the splash min-time has elapsed.
//
// maybeFinishStartup() is the gate. Each of the three signals
// (splashMinElapsed, workerDone, workspaceReadyToShow) calls it; it
// only swaps when all three are true.
let splashWindow: BrowserWindow | null = null;
let startupWorker: Electron.UtilityProcess | null = null;
let workerDone = false;
let workspaceReadyToShow = false;
let splashMinElapsed = false;
let startupSwapped = false;

const SPLASH_MIN_MS = 3000;
const SPLASH_HARD_MAX_MS = 60000;

// v2.0.15 (Terry 2026-06-05) — boot timeline logs. Terry's report
// that packaged builds show a 6-second purple flash needed a way to
// see exactly where time is being spent. Each log line records the
// elapsed ms since app launch so reading the timeline is mechanical:
// subtract one timestamp from the next, find the long gaps.
const BOOT_T0 = Date.now();
const bootElapsed = () => Date.now() - BOOT_T0;
const bootLog = (msg: string) => log.info(`[Boot +${bootElapsed()}ms] ${msg}`);
bootLog('main process started');

function createSplashWindow(): void {
  bootLog('createSplashWindow() called');
  splashWindow = new BrowserWindow({
    width: 600,
    height: 400,
    minWidth: 400,
    minHeight: 280,
    frame: false,
    resizable: true,
    movable: true,
    show: true,
    backgroundColor: '#a99cff',
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'assets', 'pdr-logo_transparent.png')
      : path.join(__dirname, '../client/public/assets/pdr-logo_transparent.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const splashHtml = path.join(__dirname, '../dist/public/splash.html');
  bootLog(`splash loadFile path: ${splashHtml}`);
  bootLog(`splash path exists: ${fs.existsSync(splashHtml)}`);
  // v2.0.15 (Terry 2026-06-05) — diagnostic listeners to catch why
  // splash.html load fails in packaged builds (ERR_FAILED -2). The
  // generic catch on loadFile loses information; these event listeners
  // surface the actual reason (renderer crash, navigation failure with
  // specific Chromium error code, etc).
  splashWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    bootLog(`splash did-fail-load: code=${errorCode} desc="${errorDescription}" url=${validatedURL}`);
  });
  splashWindow.webContents.on('render-process-gone', (_event, details) => {
    bootLog(`splash render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });
  splashWindow.webContents.on('unresponsive', () => {
    bootLog('splash webContents UNRESPONSIVE');
  });
  splashWindow.webContents.on('did-finish-load', () => {
    bootLog('splash webContents did-finish-load fired (splash HTML loaded successfully)');
  });
  splashWindow.on('closed', () => {
    bootLog('splash window CLOSED event fired');
  });
  splashWindow.loadFile(splashHtml).catch((err) => {
    log.warn(`[Startup] splash loadFile failed: ${(err as Error).message}`);
    bootLog(`splash loadFile catch: ${(err as Error).message}`);
  });
  splashWindow.center();

  // Min-time floor — even on a fast machine with nothing to clean up,
  // the splash should hold for a beat so it never feels rushed.
  setTimeout(() => {
    splashMinElapsed = true;
    bootLog('splashMinElapsed = true (3s floor reached)');
    maybeFinishStartup();
  }, SPLASH_MIN_MS);

  // Hard ceiling — if the worker hangs (e.g. corrupt DB, locked
  // filesystem), don't trap the user behind the splash forever.
  setTimeout(() => {
    if (!startupSwapped) {
      log.warn(`[Startup] Hard timeout ${SPLASH_HARD_MAX_MS}ms — forcing swap (worker may still be running)`);
      workerDone = true;
      maybeFinishStartup();
    }
  }, SPLASH_HARD_MAX_MS);
}

function spawnStartupWorker(): void {
  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, 'dist-electron/startup-worker.cjs')
    : path.join(__dirname, 'startup-worker.cjs');

  // Resolve runtime config the worker needs. app.getPath() isn't
  // available inside a utilityProcess, so we pass the paths in
  // explicitly via the 'init' message. Worker now only does DB
  // cleanup; the PDR_Temp orphan-sweep moved back to the renderer
  // (workspace.tsx) so it can use the persisted source paths from
  // localStorage to distinguish orphans from active extractions.
  const dbPath = path.join(app.getPath('userData'), 'search-index', 'pdr-search.db');

  try {
    startupWorker = utilityProcess.fork(workerPath, [], {
      serviceName: 'PDR Startup Worker',
      stdio: 'pipe',
      env: workerEnv(),
    });
  } catch (err) {
    log.warn(`[Startup Worker] fork failed (skipping cleanup): ${(err as Error).message}`);
    workerDone = true;
    maybeFinishStartup();
    return;
  }

  startupWorker.stdout?.on('data', (chunk: Buffer) => {
    log.info(`[startup-worker stdout] ${chunk.toString().trim()}`);
  });
  startupWorker.stderr?.on('data', (chunk: Buffer) => {
    log.warn(`[startup-worker stderr] ${chunk.toString().trim()}`);
  });

  startupWorker.on('message', (msg: unknown) => {
    const m = msg as { type?: string; text?: string; summary?: unknown };
    if (m?.type === 'progress') {
      try { splashWindow?.webContents.send('splash:status', m.text); } catch { /* best-effort */ }
    } else if (m?.type === 'done') {
      log.info(`[Startup Worker] done — ${JSON.stringify(m.summary)}`);
      workerDone = true;
      bootLog('workerDone = true (startup-worker reported done)');
      try { startupWorker?.kill(); } catch { /* best-effort */ }
      startupWorker = null;
      maybeFinishStartup();
    }
  });

  startupWorker.on('exit', (code) => {
    log.info(`[Startup Worker] exited code=${code}`);
    if (!workerDone) {
      workerDone = true;
      maybeFinishStartup();
    }
  });

  // v2.0.12 — pass the currently-attached Library Drive root so the
  // worker can snapshot the local DB to <libraryRoot>/.pdr/pdr-search.db
  // BEFORE running any cleanup. If a cleanup misbehaves (the v2.0.10
  // cascade-delete category of bug), the recovery banner on the
  // workspace can offer a one-click restore from that snapshot.
  // libraryRoot is null when nothing's attached yet — the worker just
  // skips the snapshot in that case and runs cleanup as normal.
  let libraryRoot: string | null = null;
  try {
    const libStatus = getLibraryStatus();
    libraryRoot = libStatus.attached ? libStatus.libraryRoot : null;
  } catch (e) {
    log.warn(`[Startup Worker] could not read library status (continuing without snapshot): ${(e as Error).message}`);
  }

  startupWorker.postMessage({
    type: 'init',
    dbPath,
    libraryRoot,
  });
}

// v2.0.11 (Terry 2026-05-24) — renderer-side ready signal. Sent from
// client/src/main.tsx after React has committed its first frame AND
// the browser has painted it (double-RAF). Replaces the use of the
// BrowserWindow's ready-to-show event as the workspace-ready signal,
// which fired too early (on body-background paint, before React).
ipcMain.on('workspace:first-frame', () => {
  if (workspaceReadyToShow) return;
  workspaceReadyToShow = true;
  bootLog('workspaceReadyToShow = true (renderer fired workspace:first-frame IPC)');
  maybeFinishStartup();
});

function maybeFinishStartup(): void {
  if (startupSwapped) return;
  if (!splashMinElapsed) { bootLog('maybeFinishStartup: waiting on splashMinElapsed'); return; }
  if (!workspaceReadyToShow) { bootLog('maybeFinishStartup: waiting on workspaceReadyToShow'); return; }
  // v2.0.15 (Terry 2026-06-05) — workerDone REMOVED from the gate
  // set. Previously the worker had to complete its DB walk + sidecar
  // snapshot (~17s on a 74k-row library, scaling linearly with
  // library size — minutes for huge libraries) before the window
  // could show. The worker's actual job (sidecar snapshot for
  // recovery + cleanup queries) doesn't need to block the user from
  // seeing the workspace — it runs in a separate utility process so
  // it can't affect main-thread responsiveness, and the snapshot
  // uses atomic .tmp + rename so a mid-write quit doesn't corrupt
  // the existing sidecar. Worker keeps running in the background;
  // workerDone flag and 'done' message still fire (used for logging
  // and the [Boot] timeline), they're just not gating the show.
  bootLog('maybeFinishStartup: gates passed (splashMinElapsed + workspaceReadyToShow) — showing mainWindow; worker continues in background');
  startupSwapped = true;

  // v2.0.11 (Terry 2026-05-24) — splash-to-workspace position handoff.
  // The user can drag/resize the splash while it's up; the workspace
  // should appear WHERE THEY MOVED IT, not at the workspace's default
  // centered position. This makes the swap feel like one window
  // changing content rather than two separate windows.
  //
  // Strategy: center the workspace on the same display the splash is
  // currently on, then nudge so the workspace's center matches the
  // splash's center (clamped to that display's work area so the
  // window never lands partly off-screen). Multi-monitor safe via
  // screen.getDisplayMatching.
  // v2.0.15 (Terry 2026-06-05) — show mainWindow FIRST, then close
  // splash with a brief overlap. We tried close-first-then-show, but
  // the OS leaves one or two frames with no PDR window visible (Terry
  // saw a "black-grey" gap). We tried no-overlap show-first, but the
  // 500ms post-show splash overlap exposed mainWindow's off-white bg
  // AROUND the splash card (Terry's "off-white wall" screenshot).
  //
  // The actual fix is the home.tsx side, not the order: with
  // document.fonts.ready + double-RAF + 150ms compositor barrier,
  // Welcome is GENUINELY painted in the offscreen buffer by the time
  // workspaceFirstFrame fires. So when mainWindow.show() runs, the
  // area around the splash card is Welcome content (logo, cards, body
  // text) — not blank off-white. The splash dismisses on top of an
  // already-fully-rendered Welcome, which is the smooth handoff we
  // always wanted.
  //
  // Order:
  //   1) Position mainWindow over splash's centre (handoff).
  //   2) Show mainWindow → Welcome instantly visible behind splash.
  //   3) Brief overlap (120ms) so the OS has time to composite the
  //      mainWindow frame before we yank the splash away — covers
  //      compositor latency on slower hardware.
  //   4) Close splash → just Welcome visible. No gap, no flash.
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      if (splashWindow && !splashWindow.isDestroyed()) {
        const splashBounds = splashWindow.getBounds();
        const splashCenterX = splashBounds.x + Math.floor(splashBounds.width / 2);
        const splashCenterY = splashBounds.y + Math.floor(splashBounds.height / 2);
        const display = screen.getDisplayMatching(splashBounds);
        const wsBounds = mainWindow.getBounds();
        // Workspace top-left so its centre matches the splash's centre.
        let x = splashCenterX - Math.floor(wsBounds.width / 2);
        let y = splashCenterY - Math.floor(wsBounds.height / 2);
        // Clamp to the display's work area so the title bar always
        // ends up draggable on screen.
        const wa = display.workArea;
        x = Math.max(wa.x, Math.min(x, wa.x + wa.width - wsBounds.width));
        y = Math.max(wa.y, Math.min(y, wa.y + wa.height - wsBounds.height));
        mainWindow.setBounds({ x, y, width: wsBounds.width, height: wsBounds.height });
      }
    } catch (err) {
      log.warn(`[Startup] splash-to-workspace position handoff failed (non-fatal): ${(err as Error).message}`);
    }
    // v2.0.15 (Terry 2026-06-05) — "disable that fucking blank
    // window" fix. The blank Terry kept seeing is mainWindow's
    // background colour after show() but before Chromium has
    // composed Welcome onto the visible window surface. Earlier
    // attempts (paintWhenInitiallyHidden, fonts.ready, double-RAF,
    // 150ms barrier) reduced the gap but didn't eliminate it: a
    // hidden window's renderer is throttled by Chromium, so paint-
    // WhenInitiallyHidden has limited effect.
    //
    // Two-stage reveal:
    //   1) Show mainWindow at OPACITY 0 — Chromium now has a visible
    //      window surface to paint to, renderer un-throttles, paint-
    //      WhenInitiallyHidden + visible-surface rendering both
    //      proceed. User sees nothing change (splash still on top of
    //      an invisible mainWindow).
    //   2) 1500ms warmup — Welcome paints onto the visible-but-
    //      invisible mainWindow. Generous wait to absorb cold-launch
    //      variance.
    //   3) Same-tick: setOpacity(1) on mainWindow + close splash.
    //      mainWindow becomes visible WITH Welcome already on screen.
    //      Splash disappears. No off-white flash, no blank, no gap.
    if (splashWindow && !splashWindow.isDestroyed()) {
      try { splashWindow.setAlwaysOnTop(true); } catch { /* best-effort */ }
    }
    try { mainWindow.setOpacity(0); } catch { /* best-effort */ }
    bootLog('mainWindow.show() called at opacity 0 (1500ms warmup begins)');
    mainWindow.show();
    const splashToClose = splashWindow;
    splashWindow = null;
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.setOpacity(1); } catch { /* best-effort */ }
      }
      if (splashToClose && !splashToClose.isDestroyed()) {
        try { splashToClose.close(); } catch { /* best-effort */ }
      }
      bootLog('mainWindow opacity → 1 + splash closed (1500ms warmup complete)');
    }, 1500);
  }
}

function createWindow() {
  bootLog('createWindow() called — instantiating mainWindow');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 700,
    // v2.0.11 — show: false, revealed by maybeFinishStartup() once
    // the splash min-time has elapsed AND the startup worker has
    // posted 'done' AND the renderer has fired ready-to-show. See
    // the comment block above the splash/worker helpers for the full
    // architecture rationale.
    show: false,
    // v2.0.15 (Terry 2026-06-05) — paintWhenInitiallyHidden tells
    // Chromium to render the page content even while the window is
    // hidden (show:false), so by the time mainWindow.show() fires,
    // the Welcome content is already composited in Chromium's
    // offscreen buffer and appears on screen INSTANTLY — no
    // intermediate flash of the backgroundColor, no awkward
    // "splash dismissed but WS not ready yet" blank gap. Other PDR
    // windows (peopleWindow, viewerWindow) already use this flag;
    // mainWindow was the outlier. Terry's call: "the splash for the
    // length of time the white-grey screen is shown if anything is
    // needed... this changing one screen which has the logo and
    // wording on just to show another blank screen just to then
    // show the WS is fucking nonsense."
    paintWhenInitiallyHidden: true,
    // v2.0.15 (Terry 2026-06-05) — off-white to match the Welcome /
    // Workspace BODY background (CSS --background: HSL 240 27% 97%
    // in light mode). The two-stage lavender→off-white experiment
    // was wrong: Terry said no purple at all. With paintWhenInitially-
    // Hidden above, this should rarely be visible — it's a fallback
    // for OS-side repaint flashes (maximize, restore, window resize)
    // where matching the body colour makes the flash invisible against
    // the page underneath. The boot-time "gap" is solved by gating
    // mainWindow.show() on Welcome being genuinely painted (see the
    // pushed-back signal in home.tsx) — NOT by colouring the
    // background to look like the splash.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a2e' : '#f6f6fb',
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'hiddenInset',
    thickFrame: true,
    ...(process.platform === 'win32' ? {
      titleBarOverlay: {
        color: '#a99cff',       // Primary lavender — matches ribbon tab bar
        symbolColor: '#ffffff',  // White window controls
        height: 32,
      },
    } : {}),
	icon: app.isPackaged
	  ? path.join(process.resourcesPath, 'assets', 'pdr-logo_transparent.png')
	  : path.join(__dirname, '../client/public/assets/pdr-logo_transparent.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: 1.0,
    },
  });
  hardenWindowAgainstNavigation(mainWindow);

  // v2.0.11 (Terry 2026-05-24) — DON'T trigger workspaceReadyToShow
  // from ready-to-show. Chromium fires that event the moment it paints
  // the first frame of the document — but the first frame is just the
  // bare HTML body (lavender background) with React not yet mounted.
  // Showing the window at that point flashed a single lavender frame
  // before the workspace UI rendered on top (Terry called it "the old
  // splash trying to load for a split second").
  //
  // Trigger now fires when the renderer sends 'workspace:first-frame'
  // via IPC — see the ipcMain.on handler below + client/src/main.tsx
  // which sends the signal after React's first commit + paint. By the
  // time the splash dismisses and the workspace shows, the workspace
  // UI is already painted in Chromium's offscreen buffer — no flash.
  // SPLASH_HARD_MAX_MS is the global safety net if the IPC never fires.

	bootLog('mainWindow.loadFile(index.html) called');
	mainWindow.loadFile(path.join(__dirname, '../dist/public/index.html'));
	mainWindow.webContents.once('did-finish-load', () => bootLog('mainWindow webContents did-finish-load fired'));

	// Surface renderer [inline-video] / [video] console messages in main log.
	mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
	  if (
	    message.includes('[inline-video]') ||
	    message.includes('[video]') ||
	    message.includes('[pdr-file]') ||
	    message.includes('[Welcome]') ||
	    message.includes('[Boot]')
	  ) {
	    console.log(`[main-renderer] ${sourceId}:${line} ${message}`);
	  }
	});

	// Register main window with AI manager for progress IPC
	setAiMainWindow(mainWindow);

	// Zoom is handled purely via CSS transform on the content area — keep Electron at 1.0
	mainWindow!.webContents.on('did-finish-load', () => {
	  mainWindow!.webContents.setZoomFactor(1.0);

	  // Pre-warm the People Manager window in the background. We wait
	  // ~4 seconds after the main window finishes loading so the user's
	  // first impression isn't slowed down by an extra renderer
	  // boot. By the time most users have decided which folder to add
	  // as a source, PM is already invisibly mounted and ready — when
	  // they later click the People icon it shows instantly. RAM cost
	  // is ~150 MB while PDR is open; the speed payoff for power users
	  // (especially after auto-process AI runs) outweighs it.
	  setTimeout(() => {
	    try { prewarmPeopleWindow(); } catch { /* best-effort */ }
	  }, 4000);

	  // Auto-start AI processing on launch if enabled AND models already downloaded.
	  // Picks up wherever processing left off last time the app was closed —
	  // including a Re-analyze tags run in progress. If only tags are pending
	  // (faces already done), kick off a tagsOnly pass so the queue actually
	  // drains; the plain startAiProcessing() call only looks at the faces
	  // queue when face detection is enabled and would exit as a no-op.
	  const settings = getSettings();
	  console.log(`[AI] Launch check: aiEnabled=${settings.aiEnabled}, modelsReady=${areModelsDownloaded()}`);
	  if (settings.aiEnabled && areModelsDownloaded()) {
	    setTimeout(async () => {
	      try {
	        const pendingFaces = getUnprocessedFileIds('faces', 1).length;
	        const pendingTags = getUnprocessedFileIds('tags', 1).length;
	        const unclusteredFaces = getUnclusteredFaceCount();
	        console.log(`[AI] Auto-start check: pendingFaces=${pendingFaces > 0}, pendingTags=${pendingTags > 0}, unclusteredFaces=${unclusteredFaces}`);
	        if (pendingFaces > 0) {
	          console.log('[AI] Auto-starting AI processing (faces pending)...');
	          await startAiProcessing();
	        } else if (pendingTags > 0) {
	          console.log('[AI] Auto-starting tags-only processing (resuming previous re-analyze)...');
	          await startAiProcessing({ tagsOnly: true });
	        } else if (unclusteredFaces > 0) {
	          // Detection finished but clustering was interrupted (user
	          // quit PDR mid-cluster on a large Takeout import).
	          //
	          // Auto-resume is DISABLED here: even with time-budgeted
	          // yielding, running clustering on the main process can
	          // starve OS window-message handling enough that Windows
	          // marks the window "Not Responding" — a reputation-grade
	          // bug. Until clustering moves off main entirely (utility
	          // process or worker_thread), the user must trigger it
	          // manually from Settings → AI → Re-cluster.
	          console.log(`[AI] Skipping auto-resume — ${unclusteredFaces} face(s) still need clustering; user can trigger via Settings → AI`);
	        } else {
	          console.log('[AI] Nothing pending, no auto-start needed');
	        }
	        console.log('[AI] Auto-start completed or in progress');
	      } catch (err) {
	        console.error('[AI] Auto-start FAILED:', err);
	      }
	    }, 3000);
	  } else if (settings.aiEnabled && !areModelsDownloaded()) {
	    console.log('[AI] AI enabled but models not downloaded — waiting for user to trigger download');
	  }
	});

	// Block Electron's native zoom shortcuts — our renderer handles zoom via IPC.
	// DevTools access removed entirely (Terry 2026-05-21): the F12 /
	// Ctrl+Shift+I shortcut handler was previously gated behind
	// !app.isPackaged so dev builds could still inspect, but defense-in-
	// depth wins here — the main-process log file is the canonical
	// debugging surface and the renderer's error-listener bridge already
	// forwards uncaught exceptions + unhandled rejections into it. Nothing
	// in production should ever need DevTools.
	mainWindow!.webContents.on('before-input-event', (_event, input) => {
	  if (input.control && (input.key === '=' || input.key === '+' || input.key === '-' || input.key === '0')) {
	    _event.preventDefault();
	  }
	});


  // Track whether a fix operation is in progress
  let fixInProgress = false;

  ipcMain.handle('fix:setInProgress', (_event, inProgress: boolean) => {
    fixInProgress = inProgress;
    // Broadcast to every renderer window — main, PM, Date Editor —
    // so any surface can disable its mutating actions while a fix
    // is in flight without each window having to track state
    // independently. Listeners subscribe via the 'fix:stateChanged'
    // channel exposed in preload.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send('fix:stateChanged', { inProgress }); } catch { /* non-fatal */ }
    }
  });

  // Cold-start query — when a window opens (e.g. PM mid-fix) it
  // can pull the current state instead of waiting for the next
  // change event. Returns the live flag.
  ipcMain.handle('fix:getInProgress', () => fixInProgress);

  // Cross-window progress broadcast. The window running the Fix
  // (main) calls 'fix:broadcastProgress' on every state change;
  // we cache the latest payload + fan it out to every BrowserWindow
  // so PM (separate window) can render its own chip with real
  // numbers instead of just a boolean. lastFixProgress survives
  // until the next broadcast or until inProgress flips false.
  let lastFixProgress: any = null;
  ipcMain.handle('fix:broadcastProgress', (_event, payload: any) => {
    lastFixProgress = payload;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send('fix:progressBroadcast', payload); } catch { /* non-fatal */ }
    }
  });
  ipcMain.handle('fix:getProgress', () => lastFixProgress);

  mainWindow.on('close', (e) => {
    if (fixInProgress && mainWindow) {
      e.preventDefault();
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Keep Running', 'Close Anyway'],
        defaultId: 0,
        cancelId: 0,
        title: 'Fix in Progress',
        message: 'PDR is currently copying and renaming your files.',
        detail: 'Closing now may leave your files in an incomplete state. Are you sure you want to close?',
      }).then(({ response }) => {
        if (response === 1) {
          fixInProgress = false;
          preScanCancelled = true;
          copyFilesCancelled = true;
          mainWindow?.destroy();
        }
      });
    } else {
      // Cancel any running operations before window closes
      preScanCancelled = true;
      copyFilesCancelled = true;
      // Child windows are independent top-level windows (not OS children of
      // mainWindow), so we must explicitly destroy them here — otherwise they
      // would keep the app alive after the user closes PDR.
      if (viewerWindow && !viewerWindow.isDestroyed()) {
        viewerWindow.destroy();
        viewerWindow = null;
      }
      if (peopleWindow && !peopleWindow.isDestroyed()) {
        peopleWindow.destroy();
        peopleWindow = null;
      }
      if (dateEditorWindow && !dateEditorWindow.isDestroyed()) {
        dateEditorWindow.destroy();
        dateEditorWindow = null;
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Forward window-move events to the renderer so popovers /
  // dropdowns can close when the user drags the titlebar.
  // `-webkit-app-region: drag` swallows mouse events in the
  // renderer, so the only reliable signal that the user has
  // interacted with the titlebar drag region is the OS-level
  // window 'move' event. Coalesced to once per ~50ms to avoid
  // flooding the renderer during a long drag.
  let lastMoveAt = 0;
  mainWindow.on('move', () => {
    const now = Date.now();
    if (now - lastMoveAt < 50) return;
    lastMoveAt = now;
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pdr:window-move');
      }
    } catch { /* renderer might be unloaded — ignore */ }
  });
}

const LARGE_ZIP_THRESHOLD = 2 * 1024 * 1024 * 1024; // 2 GiB

// --- RAR extraction helpers ---

function getUnrarPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'UnRAR.exe');
  }
  return path.join(__dirname, 'bin', 'UnRAR.exe');
}

function isRarFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.rar';
}

function generateRarTempDirName(rarPath: string): string {
  const hash = crypto.createHash('md5').update(rarPath).digest('hex').substring(0, 8);
  const baseName = path.basename(rarPath, path.extname(rarPath));
  // Resolve relative to the *current* PDR_Temp root (destination drive
  // when set; %TEMP% otherwise). See comment on getCurrentPdrTempRoot.
  return path.join(getCurrentPdrTempRoot(), `${baseName}_${hash}`);
}

async function extractRar(
  rarPath: string,
  tempDir: string,
  onProgress?: (message: string, current?: number, total?: number) => void
): Promise<void> {
  // Create the temp root with the extended-length prefix so deeply-
  // nested RAR contents don't trip MAX_PATH inside Node's mkdir binding.
  // Note: the prefix is intentionally NOT passed to UnRAR.exe below —
  // external Windows binaries vary in how they handle `\\?\` argv
  // entries, and UnRAR has its own long-path support via -ap (apply
  // path) which is the safer route if we ever need to extend this.
  fs.mkdirSync(toLongPath(tempDir), { recursive: true });

  onProgress?.('Unpacking RAR archive...', 0, 0);

  const unrarPath = getUnrarPath();

  return new Promise<void>((resolve, reject) => {
    const args = ['x', '-o+', '-y', rarPath, tempDir + path.sep];
    let cancelPollTimer: NodeJS.Timeout | null = null;
    let cancelled = false;

    const child = execFile(unrarPath, args, { maxBuffer: 50 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (cancelPollTimer) {
        clearInterval(cancelPollTimer);
        cancelPollTimer = null;
      }
      if (cancelled) {
        reject(new Error('ANALYSIS_CANCELLED'));
        return;
      }
      if (error) {
        reject(new Error(`UnRAR extraction failed: ${error.message}\n${stderr}`));
      } else {
        onProgress?.('RAR archive unpacked', 0, 0);
        resolve();
      }
    });

    // Poll the cancel flag while UnRAR.exe runs as a single external
    // process — there's no per-entry loop inside Node for us to
    // intersperse a check into, so a 250 ms timer is the cheapest way
    // to make Cancel actually stop the extraction within a quarter of
    // a second. SIGTERM lets UnRAR.exe clean up; the callback above
    // observes the `cancelled` flag and rejects with ANALYSIS_CANCELLED
    // so the catch block in analysis:run reaps the partial tempDir.
    cancelPollTimer = setInterval(() => {
      if (isAnalysisCancelled() && !cancelled) {
        cancelled = true;
        try { child.kill('SIGTERM'); } catch { /* already exited */ }
      }
    }, 250);

    let lineCount = 0;
    child.stdout?.on('data', (data: string) => {
      const lines = data.toString().split('\n').filter((l: string) => l.trim());
      lineCount += lines.length;
      if (lineCount % 50 === 0) {
        onProgress?.(`Unpacking... ${lineCount} entries extracted`, 0, 0);
      }
    });
  });
}


// --- Large ZIP auto-extraction helpers ---

const PDR_TEMP_ROOT = path.join(app.getPath('temp'), 'PDR_Temp');

/**
 * Compute the *current* PDR_Temp root for the active Library Drive.
 *
 * v1.0.x extracted ZIP/RAR sources into %TEMP%\PDR_Temp\ — fine for
 * small archives but a disaster for multi-Takeout sessions where the
 * 50 GB extracted payload would silently fill the user's C: drive.
 * v2.0.0 changed extraction to use the destination drive instead
 * (path.join(destinationPath, 'PDR_Temp')) — same code at the
 * extraction site, but the temp-name + cleanup helpers below
 * historically still hard-coded PDR_TEMP_ROOT (= %TEMP%). Result: a
 * three-way bug where (1) per-source cleanup on Source-Remove looked
 * for the temp dir in %TEMP% (always missed it on v2 builds),
 * (2) startup orphan-sweep only looked at %TEMP% (never touched the
 * destination's PDR_Temp), and (3) leftovers piled up across
 * sessions until the destination drive was 50+ GB heavier than it
 * needed to be.
 *
 * This helper unifies the lookup. Returns the destination's
 * PDR_Temp when one is set; falls back to %TEMP% only when no
 * destination has been chosen yet (first-launch / pre-onboarding).
 */
function getCurrentPdrTempRoot(): string {
  try {
    const dest = getSettings().destinationPath;
    if (dest && typeof dest === 'string' && dest.length > 0) {
      return path.join(dest, 'PDR_Temp');
    }
  } catch { /* settings unreadable — fall through */ }
  return PDR_TEMP_ROOT;
}

// Synchronous disk-space probe for the volume containing `dir`. Used
// by the pre-extract resolver to decide whether the destination drive
// or %TEMP% has enough headroom for the extracted zip. Falls back to
// PowerShell on Windows (the same one disk:getSpace uses) and `df`
// on POSIX. Returns null on any failure — callers treat that as
// "unknown, prefer the other candidate".
function getDiskSpaceForDirSync(dir: string): { freeBytes: number; totalBytes: number } | null {
  try {
    if (process.platform === 'win32') {
      const driveLetter = path.parse(dir).root.replace('\\', '').replace(':', '');
      if (!driveLetter) return null;
      try {
        const psCmd = `powershell -NoProfile -Command "(Get-PSDrive -Name '${driveLetter}' -PSProvider FileSystem | Select-Object Free,Used,@{N='Total';E={$_.Free+$_.Used}}) | ConvertTo-Json"`;
        const out = execSync(psCmd, { encoding: 'utf8', timeout: 10000 });
        const info = JSON.parse(out.trim());
        if (info && info.Free != null && info.Total != null) {
          return { freeBytes: Number(info.Free), totalBytes: Number(info.Total) };
        }
      } catch { /* fall through to wmic */ }
      try {
        const out = execSync(`wmic logicaldisk where "DeviceID='${driveLetter}:'" get FreeSpace,Size /format:csv`, { encoding: 'utf8' });
        const lines = out.trim().split('\n').filter(l => l.trim());
        if (lines.length >= 2) {
          const parts = lines[1].split(',');
          const freeBytes = parseInt(parts[1], 10);
          const totalBytes = parseInt(parts[2], 10);
          if (!isNaN(freeBytes) && !isNaN(totalBytes)) {
            return { freeBytes, totalBytes };
          }
        }
      } catch { /* fall through */ }
      return null;
    }
    // POSIX
    const out = execSync(`df -k "${dir}"`, { encoding: 'utf8' });
    const lines = out.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const totalKB = parseInt(parts[1], 10);
      const availKB = parseInt(parts[3], 10);
      if (!isNaN(availKB) && !isNaN(totalKB)) {
        return { freeBytes: availKB * 1024, totalBytes: totalKB * 1024 };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// v2.0.11 — async sibling of getDiskSpaceForDirSync. The sync version
// spawns PowerShell (or wmic) and blocks the main thread for the
// 200–800 ms each probe takes, which froze the title-bar overlay
// during source-add (Terry 2026-05-23: "Not Responding" + lavender
// → white during the few seconds between Add Source and the
// pre-extract decision). This version uses execFile + promisify so
// the subprocess runs on libuv's worker pool and main stays free to
// service window messages. Same return shape + same null-on-failure
// semantics as the sync version.
async function getDiskSpaceForDir(dir: string): Promise<{ freeBytes: number; totalBytes: number } | null> {
  try {
    if (process.platform === 'win32') {
      const driveLetter = path.parse(dir).root.replace('\\', '').replace(':', '');
      if (!driveLetter) return null;
      const execFileAsync = (await import('util')).promisify(execFile);
      try {
        const { stdout } = await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-Command',
          `(Get-PSDrive -Name '${driveLetter}' -PSProvider FileSystem | Select-Object Free,Used,@{N='Total';E={$_.Free+$_.Used}}) | ConvertTo-Json`,
        ], { timeout: 10000, maxBuffer: 1024 * 1024 });
        const info = JSON.parse(stdout.trim());
        if (info && info.Free != null && info.Total != null) {
          return { freeBytes: Number(info.Free), totalBytes: Number(info.Total) };
        }
      } catch { /* fall through to wmic */ }
      try {
        const { stdout } = await execFileAsync('wmic', [
          'logicaldisk',
          'where',
          `DeviceID='${driveLetter}:'`,
          'get',
          'FreeSpace,Size',
          '/format:csv',
        ], { timeout: 10000, maxBuffer: 1024 * 1024 });
        const lines = stdout.trim().split('\n').filter((l: string) => l.trim());
        if (lines.length >= 2) {
          const parts = lines[1].split(',');
          const freeBytes = parseInt(parts[1], 10);
          const totalBytes = parseInt(parts[2], 10);
          if (!isNaN(freeBytes) && !isNaN(totalBytes)) {
            return { freeBytes, totalBytes };
          }
        }
      } catch { /* fall through */ }
      return null;
    }
    // POSIX
    const execFileAsync = (await import('util')).promisify(execFile);
    const { stdout } = await execFileAsync('df', ['-k', dir], { timeout: 10000, maxBuffer: 1024 * 1024 });
    const lines = stdout.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const totalKB = parseInt(parts[1], 10);
      const availKB = parseInt(parts[3], 10);
      if (!isNaN(availKB) && !isNaN(totalKB)) {
        return { freeBytes: availKB * 1024, totalBytes: totalKB * 1024 };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Cheap classifier — true iff `dir` lives on a local volume (not a
// UNC path or a Windows mapped network drive). Mirrors the renderer
// classifier's first two checks so we don't drag the whole module in
// here. Pre-extract should never target a network drive: the I/O
// cost of streaming a 50 GB zip's bytes back over Wi-Fi turns a
// 30-min job into hours, AND tools like robocopy can't safely point
// at a network temp dir.
function isLocalDir(dir: string | null | undefined): boolean {
  if (!dir) return false;
  const norm = path.normalize(dir);
  // UNC paths are network by definition.
  if (norm.startsWith('\\\\')) return false;
  // Mapped network drive on Windows. Best-effort — any failure is
  // treated as "not network" so we don't accidentally bounce a
  // perfectly local pick.
  if (process.platform === 'win32') {
    try {
      const driveMatch = norm.match(/^([A-Za-z]):/);
      if (driveMatch) {
        const out = execSync(`net use ${driveMatch[1]}: 2>nul`, { encoding: 'utf8', timeout: 3000 });
        if (/Remote name/i.test(out) || /\\\\/.test(out)) return false;
      }
    } catch { /* not a mapped drive — local */ }
  }
  return true;
}

/**
 * Pre-extract directory resolver.
 *
 * For zips above LARGE_ZIP_THRESHOLD we need somewhere to unpack the
 * full archive. The choice matters because (a) extraction can take
 * tens of GB of disk and (b) the picked drive becomes the source of
 * every per-file read during the analysis loop that follows, so a
 * slow pick blows the analysis time out. Order of preference:
 *   1. The user's Library Drive (destinationPath) if it's local AND
 *      has enough headroom for BOTH extraction AND the post-Fix copy.
 *      Same physical disk as the eventual fix output → no cross-drive
 *      copy on completion, fastest analysis.
 *   2. %TEMP% (PDR_TEMP_ROOT) if it has enough headroom for the
 *      extraction AND the destination drive has separate headroom for
 *      the post-Fix copy. This is the historic default; works fine
 *      when C: is roomy.
 *   3. Failure case → caller surfaces a smart-prompt to the user
 *      asking them to pick a different temp location.
 *
 * Disk-space math (Terry's analysis 2026-05-15, customer report
 * Elaine):
 *   - Extraction puts the unpacked archive in `<root>/PDR_Temp/`,
 *     consuming ≈ zipSize × 1.2 (the inflation typical when an
 *     already-compressed format like JPEG/MP4 is wrapped in a zip).
 *   - Fix THEN copies the same files into the year-folder structure
 *     on the destination drive, consuming another ≈ zipSize × 1.0.
 *   - When both live on the SAME drive (option 1), peak usage during
 *     the Fix window is zipSize × 2.2.
 *   - When extraction goes to %TEMP% on a different drive (option 2),
 *     %TEMP% peaks at zipSize × 1.2; the destination drive peaks at
 *     zipSize × 1.0 — but BOTH must have room.
 *
 * The previous version of this resolver (pre-2.0.6) only reserved
 * zipSize × 1.2 + 1 GB on the destination drive. A 50 GB Takeout
 * passed the check on a destination with 75 GB free, then the Fix
 * copy ran out of room half-way through — the failure Elaine hit.
 *
 * Headroom is now drive-size-aware: max(MIN_HEADROOM, total × 5%)
 * capped at MAX_HEADROOM. This protects small partitions from being
 * filled to the brim AND avoids wasting massive over-allocation on
 * very large drives.
 */
const EXTRACTION_INFLATION = 1.2;            // PDR_Temp size ÷ zip size
const POST_FIX_COPY_FACTOR = 1.0;            // year-folder size ÷ zip size
const MIN_HEADROOM_BYTES = 5 * 1024 * 1024 * 1024;   // 5 GB
const MAX_HEADROOM_BYTES = 20 * 1024 * 1024 * 1024;  // 20 GB cap
const HEADROOM_DRIVE_PCT = 0.05;             // 5% of drive total

function computeHeadroomBytes(totalBytes: number | null): number {
  if (totalBytes == null || !Number.isFinite(totalBytes) || totalBytes <= 0) {
    return MIN_HEADROOM_BYTES;
  }
  const pctBased = Math.ceil(totalBytes * HEADROOM_DRIVE_PCT);
  return Math.max(MIN_HEADROOM_BYTES, Math.min(pctBased, MAX_HEADROOM_BYTES));
}

interface PreExtractDecision {
  ok: true;
  baseDir: string;
  tempDir: string;
  chosenLabel: string; // for diagnostic logging
  destinationFreeBytes: number | null;
  tempFreeBytes: number | null;
}

interface PreExtractRefusal {
  ok: false;
  /** Structured error code so callers can branch on the failure mode
   *  without parsing strings. Currently:
   *    - 'LIBRARY_DRIVE_UNREACHABLE' — destinationPath is set + classified
   *      local, but `getDiskSpaceForDirSync` returned null (USB drive
   *      unplugged, in sleep state, PowerShell probe failed, etc.).
   *      Silent fallback to %TEMP% used to disguise this; we now refuse
   *      with a clear message so the user reconnects the drive.
   *    - 'NO_SPACE' — both options checked and rejected on free-space.
   */
  errorCode: 'LIBRARY_DRIVE_UNREACHABLE' | 'NO_SPACE';
  neededBytes: number;
  destinationPath: string | null;
  destinationLocal: boolean;
  destinationFreeBytes: number | null;
  tempFreeBytes: number | null;
}

async function pickPreExtractDir(
  zipPath: string,
  destinationPath: string | null,
): Promise<PreExtractDecision | PreExtractRefusal> {
  // v2.0.11 — every fs / disk-space op below runs ASYNC. Previously
  // this function used fs.statSync + getDiskSpaceForDirSync (which
  // spawns PowerShell or wmic synchronously) + fs.mkdirSync + fs.rmSync.
  // On the main process those sync ops blocked window-message handling
  // for the ~1-3 seconds the probes took, freezing the title-bar
  // overlay (Terry 2026-05-23: "Not Responding" + lavender → white
  // during source-add). Async versions run on libuv's worker pool so
  // main stays responsive throughout.
  const zipStat = await fs.promises.stat(zipPath).catch(() => null);
  const zipSize = zipStat?.size ?? 0;
  const extractionBytes = Math.ceil(zipSize * EXTRACTION_INFLATION);
  const copyBytes = Math.ceil(zipSize * POST_FIX_COPY_FACTOR);

  // Wake the destination drive via a benign mkdir BEFORE probing free
  // space. Forces Windows to wake the drive from any sleep / low-power
  // state — the root cause of Jane's silent-fallback-to-%TEMP% case
  // (USB Library Drive on H: returned null on the disk-space probe
  // even though H: had 1.4 TB free; pre-v2.0.8 silently routed her
  // Takeouts to C:).
  //
  // Uses a hidden .pdr-wake folder rather than PDR_Temp itself — same
  // pattern as probeLibraryDrive — so the wake-up is decoupled from
  // extraction state. PDR_Temp is created later when the extraction
  // actually starts; .pdr-wake exists only for the moment the probe
  // needs the drive awake, and is cleaned up immediately after.
  // Idempotent via recursive:true. If the drive's still asleep after
  // mkdir we retry once with a 1.5s delay below.
  const destLocal = isLocalDir(destinationPath);
  let wakeDir: string | null = null;
  if (destinationPath !== null && destLocal) {
    wakeDir = path.join(destinationPath, '.pdr-wake');
    try {
      await fs.promises.mkdir(wakeDir, { recursive: true });
    } catch (err) {
      log.warn(`[wake-drive] mkdir wake failed on ${destinationPath}: ${(err as Error).message}`);
    }
  }

  // v2.0.11 (Terry 2026-05-25) — parallelise the two disk-space
  // probes via Promise.all. They're independent (destination and
  // %TEMP% are different drives), so running them sequentially was
  // doubling the wait. Each PowerShell exec is 5-7s on a typical
  // Windows machine; in parallel total time = max(t1, t2) instead
  // of t1+t2. The destination chain still does wake-retry-rmdir
  // around its probe — that's all wrapped in the destinationChain
  // promise below.
  const destinationChain = (async (): Promise<{ freeBytes: number; totalBytes: number } | null> => {
    if (!(destinationPath && destLocal)) return null;
    let space = await getDiskSpaceForDir(destinationPath);
    if (space === null) {
      // Drive may still be spinning up from the mkdir wake; retry once.
      await new Promise(resolve => setTimeout(resolve, 1500));
      space = await getDiskSpaceForDir(destinationPath);
      if (space !== null) {
        log.info(`[wake-drive] ${destinationPath} probe succeeded on retry after 1.5s delay`);
      }
    }
    // Probe is done — clean up the wake folder. PDR_Temp will be
    // created later if the extraction actually proceeds; .pdr-wake
    // was only needed for the moment the drive needed to be spun up.
    if (wakeDir) {
      try { await fs.promises.rm(wakeDir, { recursive: true, force: true }); }
      catch { /* best-effort cleanup */ }
    }
    return space;
  })();
  const tempChain = getDiskSpaceForDir(PDR_TEMP_ROOT);

  const [destSpace, tempSpace] = await Promise.all([destinationChain, tempChain]);
  const destFree = destSpace?.freeBytes ?? null;
  const destTotal = destSpace?.totalBytes ?? null;
  const tempFree = tempSpace?.freeBytes ?? null;
  const tempTotal = tempSpace?.totalBytes ?? null;

  const destHeadroom = computeHeadroomBytes(destTotal);
  const tempHeadroom = computeHeadroomBytes(tempTotal);

  const sameDriveNeeded = extractionBytes + copyBytes + destHeadroom;
  const tempNeeded = extractionBytes + tempHeadroom;
  const destNeededForCopy = copyBytes + destHeadroom;

  // Diagnostic line — one structured log entry per call with every
  // input + the final decision (or refusal reason). v2.0.8 addition
  // following Jane's silent-fallback case (USB Library Drive on H:
  // routed her Takeouts to %TEMP% even though H: had 1.4 TB free, and
  // the pre-v2.0.8 log line just said "→ %TEMP%" with no clue why).
  // Bytes printed as GB to keep the line readable; nulls preserved
  // explicitly so we can tell "probe failed" from "0 bytes".
  const gb = (b: number | null): string => b == null ? 'null' : `${(b / (1024 ** 3)).toFixed(2)}GB`;
  const baseDiag =
    `zipSize=${gb(zipSize)} destinationPath=${JSON.stringify(destinationPath)} ` +
    `destLocal=${destLocal} destFree=${gb(destFree)} destTotal=${gb(destTotal)} ` +
    `tempFree=${gb(tempFree)} tempTotal=${gb(tempTotal)} ` +
    `sameDriveNeeded=${gb(sameDriveNeeded)} tempNeeded=${gb(tempNeeded)} destNeededForCopy=${gb(destNeededForCopy)}`;

  // ── LIBRARY_DRIVE_UNREACHABLE — destinationPath is set and we
  // think it's a local drive, but the disk-space probe returned null.
  // Strongly implies the drive isn't currently mounted (USB unplugged,
  // sleep state, NTFS metadata read failed, etc.). Pre-v2.0.8 we'd
  // silently fall through to %TEMP%, the extraction would run, the
  // post-fix copy would fail when it actually tried to write to the
  // unreachable destination — confusing error far downstream. Refusing
  // up-front with a structured code lets the renderer surface a clean
  // "Reconnect your Library Drive" modal. Terry 2026-05-19 (Jane).
  if (destinationPath !== null && destLocal && destSpace === null) {
    log.warn(`[Pre-extract] REFUSED zip="${path.basename(zipPath)}" reason="LIBRARY_DRIVE_UNREACHABLE" ${baseDiag}`);
    return {
      ok: false,
      errorCode: 'LIBRARY_DRIVE_UNREACHABLE',
      neededBytes: sameDriveNeeded,
      destinationPath,
      destinationLocal: destLocal,
      destinationFreeBytes: destFree,
      tempFreeBytes: tempFree,
    };
  }

  // ── Option 1: extract into the destination drive (same physical
  // drive as the year-folder output). Combined need: extraction +
  // copy + headroom. This is the path Elaine's case was missing.
  if (destinationPath && destLocal && destFree != null && destFree >= sameDriveNeeded) {
    const baseDir = path.join(destinationPath, 'PDR_Temp');
    log.info(`[Pre-extract] zip="${path.basename(zipPath)}" → destination drive (${destinationPath}) ${baseDiag}`);
    return {
      ok: true,
      baseDir,
      tempDir: path.join(baseDir, path.basename(generateTempDirName(zipPath))),
      chosenLabel: `destination drive (${destinationPath})`,
      destinationFreeBytes: destFree,
      tempFreeBytes: null,
    };
  }
  // Option 1 skipped — record exactly which input failed it so the
  // log makes the silent-degrade case diagnosable.
  let option1Skipped: string;
  if (destinationPath == null) option1Skipped = 'destinationPath null (no library drive picked)';
  else if (!destLocal) option1Skipped = 'destLocal false (library drive classified as network)';
  else if (destFree == null) option1Skipped = 'destFree null (disk-space probe failed)';
  else if (destFree < sameDriveNeeded) option1Skipped = `destFree ${gb(destFree)} < sameDriveNeeded ${gb(sameDriveNeeded)}`;
  else option1Skipped = 'unknown (logic gap)';

  // ── Option 2: extract into %TEMP% (system drive), copy across to
  // the destination during the Fix. BOTH drives need to fit their
  // respective portion. Previously the destination side was not
  // checked at all — a roomy C: could pass the temp check while the
  // destination ran out half-way through the copy.
  const tempHasRoom = tempFree != null && tempFree >= tempNeeded;
  const destHasRoom = destFree != null && destFree >= destNeededForCopy;
  // If there's no destination at all, the "post-fix copy" check is
  // moot — caller is in a pre-destination-pick flow.
  const destCheckPasses = destinationPath == null || !destLocal || destHasRoom;
  if (tempHasRoom && destCheckPasses) {
    // Build the tempDir explicitly under PDR_TEMP_ROOT (C:\...\Temp\PDR_Temp).
    // We can NOT call generateTempDirName(zipPath) directly here because it
    // routes through getCurrentPdrTempRoot(), which prefers the destination
    // drive whenever one is set — so the returned path would silently land
    // back on the destination drive instead of %TEMP%. That defeats the
    // entire purpose of this fallback (extract on C: when the library drive
    // is too tight) AND it means the space check that ran above measured
    // C:'s free bytes while the actual extraction would have run on the
    // destination drive. Same pattern as Option 1: take just the basename
    // (zip-name + hash segment) and join with our chosen root.
    const tempName = path.basename(generateTempDirName(zipPath));
    log.info(`[Pre-extract] zip="${path.basename(zipPath)}" → %TEMP% (PDR_TEMP_ROOT) option1Skipped="${option1Skipped}" ${baseDiag}`);
    return {
      ok: true,
      baseDir: PDR_TEMP_ROOT,
      tempDir: path.join(PDR_TEMP_ROOT, tempName),
      chosenLabel: '%TEMP% (PDR_TEMP_ROOT)',
      destinationFreeBytes: destFree,
      tempFreeBytes: tempFree,
    };
  }

  // Refusal — surface the combined "worst case" need so the smart-
  // prompt picker shows the user a realistic number rather than the
  // old extraction-only figure. neededBytes is the same-drive need;
  // callers comparing against destFree see whether they're short by
  // a little or a lot.
  let option2Skipped: string;
  if (!tempHasRoom) option2Skipped = tempFree == null ? 'tempFree null' : `tempFree ${gb(tempFree)} < tempNeeded ${gb(tempNeeded)}`;
  else if (!destCheckPasses) option2Skipped = `destination needs ${gb(destNeededForCopy)} for post-fix copy but only ${gb(destFree)} free`;
  else option2Skipped = 'unknown (logic gap)';
  log.warn(`[Pre-extract] REFUSED zip="${path.basename(zipPath)}" reason="NO_SPACE" option1Skipped="${option1Skipped}" option2Skipped="${option2Skipped}" ${baseDiag}`);
  return {
    ok: false,
    errorCode: 'NO_SPACE',
    neededBytes: sameDriveNeeded,
    destinationPath,
    destinationLocal: destLocal,
    destinationFreeBytes: destFree,
    tempFreeBytes: tempFree,
  };
}

// One-large-zip-at-a-time guard. While a >2 GB zip is being
// extracted to a temp dir, any other analysis:run call that would
// also trigger pre-extract is refused at the IPC layer. Without this,
// two concurrent 50 GB extractions can fill a 100 GB drive in
// minutes — exactly the disk-fill catastrophe Jane reported. Cleared
// in the IPC handler's finally block.
let largeExtractInFlight: { zipPath: string; tempDir: string; startedAt: number } | null = null;

function cleanupOrphanedTempDirs(): void {
  // Sweep BOTH locations:
  //   (a) the current destination drive's PDR_Temp — the v2.0.0 home for
  //       extracted ZIP/RAR sources. Reads destinationPath from
  //       electron-store; nothing to do if no destination has ever
  //       been set.
  //   (b) %TEMP%\PDR_Temp — the v1.0.x location, kept as a fallback
  //       sweep so customers upgrading from v1 also get any leftover
  //       %TEMP% extractions reaped.
  // Either or both may not exist on disk; readdir failures are
  // swallowed silently so a single missing/locked dir can't fail
  // the whole sweep.
  const roots = new Set<string>();
  roots.add(PDR_TEMP_ROOT); // legacy / fallback
  try {
    const currentRoot = getCurrentPdrTempRoot();
    if (currentRoot) roots.add(currentRoot);
  } catch { /* settings unreadable — destination root just won't be added */ }

  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      const entries = fs.readdirSync(root);
      for (const entry of entries) {
        const fullPath = path.join(root, entry);
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors for locked files — they get
          // another chance on next startup.
        }
      }
      // Remove the now-empty root itself if we cleaned everything.
      try {
        const remaining = fs.readdirSync(root);
        if (remaining.length === 0) {
          fs.rmdirSync(root);
        }
      } catch { /* root no longer exists / not empty / locked — ignore */ }
    } catch {
      // readdir failed — bucket missing or perms issue; skip this root.
    }
  }
}

/**
 * Cap the total disk used by pre-extracted source archives across the
 * Library Drive's PDR_Temp + the legacy %TEMP% PDR_Temp.
 *
 * Why: without a cap, a user who adds 8 × 50 GB Google Takeouts in
 * one session and then closes PDR without running a fix would leave
 * 400 GB sitting on their library drive — the "where did all my
 * space go?" disaster scenario. The cap enforces a fix-then-add
 * workflow most users follow naturally: extract one big Takeout,
 * fix it (which cleans the extraction up automatically), add the
 * next one.
 *
 * Sized for one full 50 GB Google Takeout chunk (the default Google
 * Takeout split size) plus a small headroom for a second source if
 * the user wants to stack a tiny one alongside. Users who want
 * different behaviour can run their fix to free space.
 *
 * Folders + ZIPs ≤ 2 GiB don't extract (the streaming engine reads
 * them in-place), so they don't count toward this cap.
 */
const EXTRACTION_CAP_BYTES = 55 * 1024 * 1024 * 1024; // 55 GiB

/**
 * Recursive directory size — sum bytes of every file under `dir`.
 * Best-effort: skips entries we can't stat (permission errors, race
 * with cleanup, etc.) so a single locked file doesn't blow up the
 * whole sum.
 */
function folderSizeBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          total += folderSizeBytes(full);
        } else {
          total += fs.statSync(full).size;
        }
      } catch { /* skip unstattable entries */ }
    }
  } catch { /* skip unreadable dir */ }
  return total;
}

/**
 * Total disk used by pre-extracted sources right now. Walks both the
 * current Library Drive's PDR_Temp and the legacy %TEMP% PDR_Temp so
 * v1.0.x leftovers also count toward the cap.
 *
 * Called on every analysis:run for a source that will pre-extract
 * (large ZIP / RAR), so this needs to be fast enough that adding a
 * source doesn't hang the UI for many seconds. On SSD a 50 GB
 * extracted Takeout (~30k files) walks in 1-2 s; on HDD up to 5-10 s.
 * Acceptable for an add-source operation that already involves a
 * file dialog + analysis pipeline kick-off.
 */
function getPendingExtractionBytes(): number {
  const roots = new Set<string>();
  roots.add(PDR_TEMP_ROOT);
  try {
    const currentRoot = getCurrentPdrTempRoot();
    if (currentRoot) roots.add(currentRoot);
  } catch { /* settings unreadable — only the legacy root counts */ }

  let total = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    total += folderSizeBytes(root);
  }
  return total;
}

// v2.0.11 — returns structured success/failure so callers can surface
// EBUSY ("Windows Search Indexer / preview pane / AV holds a file
// handle") to the user rather than swallowing it. Pre-v2.0.11 this
// returned void and only the main.log saw the failure; the renderer
// thought cleanup had succeeded and showed no indication to the user.
// v2.0.11 (Terry 2026-05-25) — long-running cleanup worker (pool of 1).
// Recursive deletion of a 50 GB extracted Takeout via fs.rmSync was
// the residual freeze at Fix-complete → Add Source: the main process
// blocked for 10–20s while NTFS unlinked thousands of files. Moving
// the delete off-process keeps the main browser thread free.
//
// Unlike the extract-worker (one-shot per extraction), this worker
// stays alive across many delete requests. Pre-forked at app start
// (see preforkCleanupWorker below); replaced if it exits unexpectedly.
let cleanupWorker: Electron.UtilityProcess | null = null;
let cleanupRequestSeq = 0;
const cleanupPending = new Map<number, { resolve: (r: { ok: boolean; reason?: string }) => void }>();

function preforkCleanupWorker(): void {
  if (cleanupWorker) return;
  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, 'dist-electron/cleanup-worker.cjs')
    : path.join(__dirname, 'cleanup-worker.cjs');
  const startedAt = Date.now();
  try {
    const w = utilityProcess.fork(workerPath, [], {
      serviceName: 'PDR Cleanup Worker',
      stdio: 'pipe',
      env: workerEnv(),
    });
    w.stdout?.on('data', (chunk: Buffer) => {
      log.info(`[cleanup-worker stdout] ${chunk.toString().trim()}`);
    });
    w.stderr?.on('data', (chunk: Buffer) => {
      log.warn(`[cleanup-worker stderr] ${chunk.toString().trim()}`);
    });
    w.on('message', (msg: unknown) => {
      const m = msg as { type?: string; id?: number; ok?: boolean; reason?: string };
      if (m?.type === 'done' && typeof m.id === 'number') {
        const pending = cleanupPending.get(m.id);
        if (pending) {
          cleanupPending.delete(m.id);
          pending.resolve({ ok: !!m.ok, reason: m.reason });
        }
      }
    });
    w.on('exit', (code) => {
      log.info(`[cleanup-worker] exited code=${code}`);
      if (cleanupWorker === w) cleanupWorker = null;
      // Resolve any pending requests as failures so callers don't hang.
      for (const [id, pending] of cleanupPending) {
        pending.resolve({ ok: false, reason: `cleanup-worker exited (code=${code})` });
        cleanupPending.delete(id);
      }
      // Auto-respawn so the next cleanup has a worker available.
      setTimeout(() => { try { preforkCleanupWorker(); } catch { /* best-effort */ } }, 500);
    });
    cleanupWorker = w;
    log.info(`[cleanup-worker prewarm] ready in ${Date.now() - startedAt}ms`);
  } catch (err) {
    log.warn(`[cleanup-worker prewarm] fork failed (non-fatal): ${(err as Error).message}`);
  }
}

// v2.0.11 (Terry 2026-05-25) — async now (was sync), delegates the
// actual recursive delete to the cleanup-worker so the main thread
// doesn't block on multi-gigabyte unlinks. Same return contract as
// before so callers don't need to change their result-handling.
//
// Falls back to in-main fs.promises.rm if the worker isn't available
// (e.g. fork failed at startup) — still async, still better than
// fs.rmSync, just runs on this process.
async function cleanupTempDir(tempDir: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    if (!fs.existsSync(tempDir)) {
      log.info(`[temp-cleanup] no-op (already gone): ${tempDir}`);
      return { ok: true };
    }
  } catch { /* fall through */ }

  if (cleanupWorker) {
    const id = ++cleanupRequestSeq;
    const result = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      cleanupPending.set(id, { resolve });
      try {
        cleanupWorker!.postMessage({ type: 'delete', id, path: tempDir });
      } catch (postErr) {
        cleanupPending.delete(id);
        resolve({ ok: false, reason: (postErr as Error).message });
      }
    });
    if (result.ok) {
      log.info(`[temp-cleanup] removed ${tempDir}`);
    } else {
      log.warn(`[temp-cleanup] failed to remove ${tempDir}: ${result.reason ?? 'unknown'}`);
    }
    return result;
  }

  // Worker unavailable — async in-main fallback.
  try {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    log.info(`[temp-cleanup] removed ${tempDir} (in-main fallback)`);
    return { ok: true };
  } catch (err) {
    const reason = (err as Error).message;
    log.warn(`[temp-cleanup] failed to remove ${tempDir} (in-main fallback): ${reason}`);
    return { ok: false, reason };
  }
}

function getZipFileSize(zipPath: string): number {
  try {
    const stats = fs.statSync(zipPath);
    return stats.size;
  } catch {
    return 0;
  }
}

function generateTempDirName(zipPath: string): string {
  const hash = crypto.createHash('md5').update(zipPath).digest('hex').substring(0, 8);
  const baseName = path.basename(zipPath, '.zip');
  // Resolve relative to the *current* PDR_Temp root (destination drive
  // when set; %TEMP% otherwise). See comment on getCurrentPdrTempRoot.
  return path.join(getCurrentPdrTempRoot(), `${baseName}_${hash}`);
}

async function extractLargeZip(
  zipPath: string,
  tempDir: string,
  onProgress?: (message: string, current?: number, total?: number) => void
): Promise<void> {
  // Prefix the temp-dir root once up-front so the recursive mkdir and the
  // subsequent per-entry writes all carry the extended-length prefix.
  // Without this, a Takeout zip with deeply-nested folders (Google's
  // shared-album naming convention can push individual entry paths past
  // 200 chars before we even add the PDR_Temp root prefix) silently fails
  // partway through extraction with `UNKNOWN: unknown error, read` —
  // Jane's case 2026-05-16.
  const tempDirLong = toLongPath(tempDir);
  fs.mkdirSync(tempDirLong, { recursive: true });

  onProgress?.('Unpacking ZIP archive...', 0, 0);

  const directory = await unzipper.Open.file(toLongPath(zipPath));
  const totalEntries = directory.files.length;
  let extracted = 0;

  for (const file of directory.files) {
    if (file.type === 'Directory') continue;

    // Honour the analysis-cancel flag set by the user clicking Cancel
    // on the extraction progress modal. Without this check the loop
    // happily extracts all ~7,000 files of a 50 GB Takeout AFTER the
    // user has hit Cancel — and surfaces a misleading "Source added"
    // success modal half an hour later. Throwing ANALYSIS_CANCELLED
    // lets the catch block in analysis:run clean up the partial
    // tempDir and return { success: false, cancelled: true } so the
    // renderer can drop the success path entirely.
    if (isAnalysisCancelled()) {
      throw new Error('ANALYSIS_CANCELLED');
    }

    // Build the per-entry paths off the long-prefixed temp root so every
    // mkdir + write inherits the extended-length capability.
    const outputPath = path.join(tempDirLong, file.path);
    const outputDir = path.dirname(outputPath);

    fs.mkdirSync(outputDir, { recursive: true });

    try {
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(outputPath);
        const readStream = file.stream();
        // Both streams can emit errors at different points in the
        // pipeline. The DEFLATE decompressor (zlib) lives inside
        // readStream — when the ZIP's compressed payload is corrupt
        // OR the read from the source returned garbage bytes (common
        // on flaky network shares + slow USB drives), zlib emits
        // errors like "too many length or distance symbols" or
        // "invalid distance too far back" here. Surfacing the raw
        // message ("Unhandled Error: too many length or distance
        // symbols") to a non-technical user is unhelpful — Kathr
        // 2026-05-14 spent a week hitting it without knowing what to
        // do. Re-throw as a structured error the renderer can
        // recognise and translate to plain English.
        const onErr = (err: Error) => {
          readStream.removeListener('error', onErr);
          writeStream.removeListener('error', onErr);
          reject(err);
        };
        readStream.on('error', onErr);
        writeStream.on('error', onErr);
        readStream.pipe(writeStream).on('finish', resolve);
      });
    } catch (err) {
      const msg = (err as Error).message || String(err);
      // Zlib failure patterns — Node's zlib binding surfaces a handful
      // of specific strings for DEFLATE-stream corruption. Catch them
      // all and re-throw as ZIP_READ_CORRUPTED so the renderer can
      // show the friendly two-option message (either the file is
      // genuinely corrupt OR the connection to the source drive is
      // unreliable).
      const isZlibCorruption =
        /too many length or distance symbols/i.test(msg) ||
        /invalid distance too far back/i.test(msg) ||
        /invalid block type/i.test(msg) ||
        /invalid stored block lengths/i.test(msg) ||
        /invalid literal\/lengths set/i.test(msg) ||
        /invalid distances set/i.test(msg) ||
        /unexpected end of file/i.test(msg);
      if (isZlibCorruption) {
        throw Object.assign(new Error(
          'PDR couldn\'t read this ZIP. The file appears to be corrupted, OR the connection to the source drive is unreliable (common with network drives or slow USB connections). Try copying the ZIP to a local drive on this PC first, then add it as a source.'
        ), {
          code: 'ZIP_READ_CORRUPTED',
          zlibErrorMessage: msg,
          failedAtEntry: file.path,
        });
      }
      throw err;
    }

    extracted++;
    if (extracted % 50 === 0) {
      onProgress?.(
        `Unpacking... ${extracted.toLocaleString()} of ${totalEntries.toLocaleString()} entries`,
        extracted,
        totalEntries
      );
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  onProgress?.(`Unpacked ${extracted.toLocaleString()} entries`, extracted, totalEntries);
}

// v2.0.11 (Terry 2026-05-25) — pre-warmed extract-worker pool of 1.
// Forking a utilityProcess on Windows costs 200–500 ms (process
// spawn + Node + Electron preamble before our script runs). Paying
// that cost during the user's Add Source click is the bulk of the
// residual "Not Responding" flash Terry observed at analyse-start.
// Pre-forking at app start (and again immediately after each use)
// moves the cost off the user's critical path entirely.
let prewarmedExtractWorker: Electron.UtilityProcess | null = null;

function preforkExtractWorker(): void {
  if (prewarmedExtractWorker) return; // already have one ready
  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, 'dist-electron/extract-worker.cjs')
    : path.join(__dirname, 'extract-worker.cjs');
  const startedAt = Date.now();
  try {
    const w = utilityProcess.fork(workerPath, [], {
      serviceName: 'PDR Extract Worker (pre-warm)',
      stdio: 'pipe',
      env: workerEnv(),
    });
    // If the pre-warmed worker exits before we hand it a job, clear
    // the slot so the next runExtractInWorker() falls back to a fresh
    // on-demand fork instead of using a dead handle.
    w.on('exit', (code) => {
      if (prewarmedExtractWorker === w) {
        prewarmedExtractWorker = null;
        log.info(`[extract-worker prewarm] worker exited (code=${code}) before being claimed`);
      }
    });
    // v2.0.15 (Terry 2026-06-05) — was swallowing stderr during prewarm.
    // When workers crashed during prewarm (packaged-build module resolution
    // failure), we got the exit log but no clue WHY. Now we log every
    // stderr line with a [prewarm] prefix so the actual error lands in
    // main.log. Once a job claims this worker, runExtractInWorker re-
    // attaches its own listeners and the prewarm ones still fire harmlessly.
    w.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) log.info(`[extract-worker prewarm stdout] ${text}`);
    });
    w.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) log.warn(`[extract-worker prewarm stderr] ${text}`);
    });
    prewarmedExtractWorker = w;
    log.info(`[extract-worker prewarm] ready in ${Date.now() - startedAt}ms`);
  } catch (err) {
    log.warn(`[extract-worker prewarm] fork failed (non-fatal): ${(err as Error).message}`);
  }
}

// v2.0.11 (Terry 2026-05-24) — utilityProcess wrapper around
// extractLargeZip. Forks electron/extract-worker.cjs, posts the
// {zipPath, tempDir} init, forwards progress messages to onProgress,
// resolves on 'done', rejects on 'error', polls isAnalysisCancelled()
// every 250ms and posts {type:'cancel'} when the user clicks Cancel.
//
// Why utilityProcess instead of leaving extraction on the main thread:
// the 18k+ per-entry fs.mkdirSync calls plus unzipper's synchronous
// central-directory parse (for a 50 GB / 18k-entry Takeout) add up
// to enough sync time that Windows ghosts the workspace as "Not
// Responding" during the analyse step. Off-process keeps the main
// browser thread unblocked throughout — drag, repaint, and IPC
// responses stay smooth.
function runExtractInWorker(
  zipPath: string,
  tempDir: string,
  onProgress?: (message: string, current?: number, total?: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // v2.0.11 (Terry 2026-05-25) — claim the pre-warmed extract worker
    // if one is available. The pre-warm is forked at app start (see
    // preforkExtractWorker() below) so the 200–500 ms utilityProcess
    // spawn cost is paid up front, not during the user's Add Source
    // click. Fall back to a fresh on-demand fork if the pre-warm is
    // missing (e.g. lost to a prior crash, or this is the very first
    // launch before the prewarm fired).
    const t0 = Date.now();
    let worker: Electron.UtilityProcess | null = prewarmedExtractWorker;
    prewarmedExtractWorker = null;
    let usedPrewarm = false;
    if (worker) {
      usedPrewarm = true;
      log.info(`[extract-worker] using pre-warmed worker (claim took ${Date.now() - t0}ms)`);
    } else {
      const workerPath = app.isPackaged
        ? path.join(process.resourcesPath, 'dist-electron/extract-worker.cjs')
        : path.join(__dirname, 'extract-worker.cjs');
      try {
        worker = utilityProcess.fork(workerPath, [], {
          serviceName: 'PDR Extract Worker',
          stdio: 'pipe',
          env: workerEnv(),
        });
        log.info(`[extract-worker] forked on-demand (no pre-warm available, fork took ${Date.now() - t0}ms)`);
      } catch (err) {
        reject(err);
        return;
      }
    }

    // Replace the pre-warm in the background so the NEXT Add Source
    // also gets a pre-warmed worker. Fire-and-forget — the user's
    // current extraction doesn't wait on this.
    if (usedPrewarm) {
      setTimeout(() => { try { preforkExtractWorker(); } catch { /* best-effort */ } }, 100);
    }

    worker.stdout?.on('data', (chunk: Buffer) => {
      log.info(`[extract-worker stdout] ${chunk.toString().trim()}`);
    });
    worker.stderr?.on('data', (chunk: Buffer) => {
      log.warn(`[extract-worker stderr] ${chunk.toString().trim()}`);
    });

    // Poll the in-main analysis-cancel flag and forward as a cancel
    // message to the worker. Done as a poll rather than wiring a
    // dedicated IPC because the cancel flag is set from many places
    // (renderer's analysis:cancel IPC, app quit handlers, source-
    // remove cleanup) and the flag pattern already aggregates them.
    const cancelPoller = setInterval(() => {
      if (isAnalysisCancelled() && worker) {
        try { worker.postMessage({ type: 'cancel' }); } catch { /* worker may be exiting */ }
      }
    }, 250);

    const finish = (resolveErr: Error | null) => {
      clearInterval(cancelPoller);
      try { worker?.kill(); } catch { /* best-effort */ }
      worker = null;
      if (resolveErr) reject(resolveErr);
      else resolve();
    };

    worker.on('message', (msg: unknown) => {
      const m = msg as { type?: string; current?: number; total?: number; message?: string; code?: string; details?: Record<string, unknown> };
      if (m?.type === 'progress') {
        onProgress?.(m.message ?? 'Unpacking...', m.current, m.total);
      } else if (m?.type === 'done') {
        finish(null);
      } else if (m?.type === 'cancelled') {
        finish(new Error('ANALYSIS_CANCELLED'));
      } else if (m?.type === 'error') {
        const err = new Error(m.message ?? 'Extraction failed');
        if (m.code) (err as Error & { code?: string }).code = m.code;
        if (m.details) Object.assign(err, m.details);
        finish(err);
      }
    });

    worker.on('exit', (code) => {
      // If the worker exited without posting 'done' / 'error' /
      // 'cancelled', synthesise a failure so the awaiting caller
      // doesn't hang.
      log.info(`[extract-worker] exited code=${code}`);
      clearInterval(cancelPoller);
      // Resolve/reject is idempotent — if we already finished above,
      // this is a no-op. Otherwise treat as crash.
      // (Promise can't be checked from outside, so just reject;
      // the JS engine ignores a second resolve/reject.)
      reject(new Error(`extract-worker exited unexpectedly (code=${code})`));
    });

    worker.postMessage({ type: 'extract', zipPath, tempDir });
  });
}

// v2.0.14 (Terry 2026-05-27) — pre-warmed analysis-worker pool of 1.
// Same rationale as preforkExtractWorker — the utilityProcess fork
// cost (200-500 ms on Windows) is paid up front so the user's Add
// Source click doesn't eat it during the analysis spin-up.
let prewarmedAnalysisWorker: Electron.UtilityProcess | null = null;

function preforkAnalysisWorker(): void {
  if (prewarmedAnalysisWorker) return;
  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, 'dist-electron/analysis-worker.cjs')
    : path.join(__dirname, 'analysis-worker.cjs');
  const startedAt = Date.now();
  try {
    const w = utilityProcess.fork(workerPath, [], {
      serviceName: 'PDR Analysis Worker (pre-warm)',
      stdio: 'pipe',
      env: workerEnv(),
      // v2.0.15 (Terry 2026-06-01) — bump V8 heap to 4 GB. Default
      // ~1.5 GB was crashing the worker (native exit code=1, no JS
      // exception caught) on Terry's 7 GB HTC One_M8 source —
      // folder walk + per-file EXIF parse over thousands of files
      // pushed past the default ceiling. 4 GB matches the practical
      // ceiling for a 32-bit-pointer V8 process and covers the
      // largest libraries we've seen in the field.
      execArgv: ['--max-old-space-size=4096'],
    });
    w.on('exit', (code) => {
      if (prewarmedAnalysisWorker === w) {
        prewarmedAnalysisWorker = null;
        log.info(`[analysis-worker prewarm] worker exited (code=${code}) before being claimed`);
      }
    });
    // v2.0.15 (Terry 2026-06-05) — was swallowing stderr during prewarm.
    // When workers crashed during prewarm (packaged-build module resolution
    // failure), we got the exit log but no clue WHY. Now we log every
    // stderr line with a [prewarm] prefix so the actual error lands in
    // main.log. Once a job claims this worker, runAnalysisInWorker re-
    // attaches its own listeners and the prewarm ones still fire harmlessly.
    w.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) log.info(`[analysis-worker prewarm stdout] ${text}`);
    });
    w.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) log.warn(`[analysis-worker prewarm stderr] ${text}`);
    });
    prewarmedAnalysisWorker = w;
    log.info(`[analysis-worker prewarm] ready in ${Date.now() - startedAt}ms`);
  } catch (err) {
    log.warn(`[analysis-worker prewarm] fork failed (non-fatal): ${(err as Error).message}`);
  }
}

// v2.0.14 — utilityProcess wrapper around analyzeSource. Forks
// electron/analysis-worker.cjs, snapshots the main-only deps the
// worker can't access (scanner overrides + Takeout sidecar map),
// posts 'start', forwards 'progress' / 'diagnostic' messages to the
// caller's callbacks, resolves on 'done', rejects on 'error' /
// 'cancelled'. Polls isAnalysisCancelled() every 250ms (same pattern
// as runExtractInWorker) so the existing cancel API keeps working
// unchanged.
function runAnalysisInWorker(
  sourcePath: string,
  sourceType: 'folder' | 'zip' | 'drive',
  onProgress: (progress: AnalysisProgress) => void,
  onDiagnostic: (line: string) => void,
): Promise<SourceAnalysisResult> {
  return new Promise<SourceAnalysisResult>((resolve, reject) => {
    const t0 = Date.now();
    let worker: Electron.UtilityProcess | null = prewarmedAnalysisWorker;
    prewarmedAnalysisWorker = null;
    let usedPrewarm = false;
    if (worker) {
      usedPrewarm = true;
      log.info(`[analysis-worker] using pre-warmed worker (claim took ${Date.now() - t0}ms)`);
    } else {
      const workerPath = app.isPackaged
        ? path.join(process.resourcesPath, 'dist-electron/analysis-worker.cjs')
        : path.join(__dirname, 'analysis-worker.cjs');
      try {
        worker = utilityProcess.fork(workerPath, [], {
          serviceName: 'PDR Analysis Worker',
          stdio: 'pipe',
          env: workerEnv(),
          // v2.0.15 — see preforkAnalysisWorker for the heap-bump
          // rationale. Same flag here so on-demand forks also get
          // the 4 GB ceiling.
          execArgv: ['--max-old-space-size=4096'],
        });
        log.info(`[analysis-worker] forked on-demand (no pre-warm, fork took ${Date.now() - t0}ms)`);
      } catch (err) {
        reject(err);
        return;
      }
    }

    // Replace the pre-warm in the background for the next Add Source.
    if (usedPrewarm) {
      setTimeout(() => { try { preforkAnalysisWorker(); } catch { /* best-effort */ } }, 100);
    }

    worker.stdout?.on('data', (chunk: Buffer) => {
      log.info(`[analysis-worker stdout] ${chunk.toString().trim()}`);
    });
    worker.stderr?.on('data', (chunk: Buffer) => {
      log.warn(`[analysis-worker stderr] ${chunk.toString().trim()}`);
    });

    // Same cancel-flag poll pattern as runExtractInWorker.
    const cancelPoller = setInterval(() => {
      if (isAnalysisCancelled() && worker) {
        try { worker.postMessage({ type: 'cancel' }); } catch { /* worker may be exiting */ }
      }
    }, 250);

    let settled = false;
    const finish = (err: Error | null, result?: SourceAnalysisResult) => {
      if (settled) return;
      settled = true;
      clearInterval(cancelPoller);
      try { worker?.kill(); } catch { /* best-effort */ }
      worker = null;
      if (err) reject(err);
      else resolve(result!);
    };

    worker.on('message', (msg: unknown) => {
      const m = msg as { type?: string; progress?: AnalysisProgress; line?: string; result?: SourceAnalysisResult; message?: string; code?: string };
      if (m?.type === 'progress' && m.progress) {
        onProgress(m.progress);
      } else if (m?.type === 'diagnostic' && m.line) {
        onDiagnostic(m.line);
      } else if (m?.type === 'done' && m.result) {
        finish(null, m.result);
      } else if (m?.type === 'cancelled') {
        finish(new Error('ANALYSIS_CANCELLED'));
      } else if (m?.type === 'error') {
        const err = new Error(m.message ?? 'Analysis failed');
        if (m.code) (err as Error & { code?: string }).code = m.code;
        finish(err);
      }
    });

    worker.on('exit', (code) => {
      log.info(`[analysis-worker] exited code=${code}`);
      if (!settled) finish(new Error(`analysis-worker exited unexpectedly (code=${code})`));
    });

    // Snapshot the main-only datasets the worker can't access, then
    // ship them in the start message. Both are small in practice
    // (scanner overrides: typically <10 rows; sidecar map: 50 KB
    // for Terry's 267-row case). If they ever grow pathologically,
    // switch to per-lookup IPC RPC.
    const overrides = listScannerOverrides();
    const sidecarMap = snapshotSidecarMapForWorker();
    const sidecarCount = Object.keys(sidecarMap).length;
    log.info(`[analysis-worker] start snapshot: ${overrides.length} scanner overrides, ${sidecarCount} sidecar rows`);

    worker.postMessage({
      type: 'start',
      sourcePath,
      sourceType,
      scannerOverrides: overrides.map(o => ({ make: o.make, model: o.model, isScanner: o.isScanner })),
      sidecarMapByBasename: sidecarMap,
    });
  });
}

// Track active temp dirs so we can clean up on cancel/quit
const activeTempDirs = new Set<string>();

// ─── Takeout enrichment rendezvous (v2.0.8) ─────────────────────────────────
// Captured in files:copy while PDR_Temp still holds the Takeout sidecars,
// consumed by search:indexRun once indexed_files rows exist. Keyed by the
// Fix's destination path because that's the only stable identifier shared
// between the two handlers — the report id isn't generated until after
// files:copy returns. In-memory by design: if the renderer never triggers
// indexing (rare; e.g. user quits between Fix and Index), the enrichment is
// lost but the backfill flow against the original ZIP is the recovery path.
const pendingTakeoutEnrichments = new Map<string, PendingTakeoutEnrichment>();

// Register custom protocol for serving local files to viewer
// v2.0.15 (Terry 2026-06-05) — added 'pdr-face' for PM face thumbnails
// and hover-preview context crops. Renderer uses <img src="pdr-face://thumb/?fp=...&size=64">
// instead of base64-over-IPC dataUrls. Browser handles the fetch +
// caching natively; main only sees a request when the disk cache is
// cold. Same disk-cache mechanism as ai:faceCrop and ai:faceContext —
// just delivered as a real HTTP response so img tags work normally.
protocol.registerSchemesAsPrivileged([
  { scheme: 'pdr-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'pdr-face', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Single-instance lock — only one PDR may run on a machine at a time.
//
// Why this matters: PDR opens a SQLite database for the Trees /
// search index, and SQLite uses file-level locking. If two PDR
// processes start, only the first wins the lock; the second runs in
// degraded mode where Tree data appears missing and the most-
// recently-added source vanishes from the source menu — a class of
// bugs Terry has flagged repeatedly under "Tree empty / sources
// missing." Single-instance lock prevents the second process from
// existing in the first place: if a user double-clicks the icon
// while PDR is already running, we focus the existing window and
// quit the new process before any of its initialisation has run.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another PDR is already running. Quit this process now — before
  // BrowserWindow, SQLite, or any IPC handlers spin up.
  app.quit();
} else {
  app.on('second-instance', () => {
    // The other PDR (this one) got launched again — focus our
    // existing main window so the user sees something happen rather
    // than wondering why their double-click did nothing.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  // Surface the log file path at startup so users hitting crashes can
  // find the file without digging through %APPDATA%. Also makes it
  // trivial to copy the path from the log itself if the user already
  // has an older copy open.
  try {
    const logPath = log.transports.file.getFile().path;
    log.info(`[log] file: ${logPath}`);
    log.info(`[log] app version ${app.getVersion()} starting on ${process.platform} ${os.release()}`);
  } catch {}

  // v2.0.15 (Terry 2026-06-01) — DISABLE WINDOWS GHOSTING.
  // Windows ghosts (paints a white "Not Responding" overlay) on any
  // window whose process hasn't pumped messages for ~5 s. PDR's own
  // busy stretches are handled by the heartbeat in files:copy, but
  // EXTERNAL OS load — clipboard paste into another Electron app,
  // antivirus scan, disk contention from File Explorer — can still
  // stall PDR's message pump briefly and trigger the ghost. Calling
  // user32!DisableProcessWindowsGhosting() once at startup turns the
  // overlay off process-wide so PDR never visually flashes "Not
  // Responding" regardless of the cause. The trade-off — the OS no
  // longer signals genuine hangs through the ghost — is covered by
  // the renderer's stuck-indicator (Fix modal surfaces a "PDR is
  // taking a while…" notice if heartbeat gaps exceed 10 s).
  if (process.platform === 'win32') {
    try {
      // Use the existing esmRequire (defined above for CJS modules
      // that need to load from this ESM-compiled file). Lazy +
      // try/catch'd so a missing prebuilt binary doesn't tank startup.
      const koffi = esmRequire('koffi');
      const user32 = koffi.load('user32.dll');
      const disableGhosting = user32.func('void DisableProcessWindowsGhosting()');
      disableGhosting();
      log.info('[ghost] DisableProcessWindowsGhosting() called — title-bar ghost overlay suppressed for this process');
    } catch (err) {
      log.warn(`[ghost] DisableProcessWindowsGhosting unavailable (non-fatal): ${(err as Error).message}`);
    }
  }

  // Library-portable DB: kick off the background sidecar-mirror loop
  // and seed the device name with the OS hostname so any mirror written
  // before the renderer has a chance to set a friendlier name still
  // labels this device sensibly.
  try {
    setBackgroundMirrorDeviceName(os.hostname() || 'Unknown');
    startBackgroundMirror();
  } catch (e) {
    console.warn('[Startup] background mirror init failed (non-fatal):', (e as Error).message);
  }

  // v2.0.11 — ONE-SHOT LDM-STATE SYNC.
  //
  // For users in the divergent state (libraryRoot set, but
  // settings.destinationPath null or different) — this catches them on
  // first launch of v2.0.11 and pulls settings.destinationPath into
  // sync with libraryRoot. Without this, existing affected users would
  // have to manually re-attach via LDM before source-add would route
  // to the right drive (because writeLibraryState only fires on attach
  // actions going forward).
  //
  // libraryRoot wins because LDM uses it as the source of truth.
  // The sync is a no-op when they already match.
  try {
    const status = getLibraryStatus();
    const settingsDest = (() => { try { return getSettings()?.destinationPath ?? null; } catch { return null; } })();
    const libRoot = status?.libraryRoot ?? null;
    if (libRoot !== settingsDest) {
      log.info(`[Startup] LDM-state sync: libraryRoot=${JSON.stringify(libRoot)} vs settings.destinationPath=${JSON.stringify(settingsDest)} — syncing to libraryRoot`);
      setSettings({ destinationPath: libRoot });
    }
  } catch (e) {
    log.warn(`[Startup] LDM-state sync failed (non-fatal): ${(e as Error).message}`);
  }

  // Handle pdr-file:// protocol — serves local files to the viewer window
  protocol.handle('pdr-file', async (request) => {
    // New canonical form: pdr-file://local/?f=<urlencoded-path>
    // (Query params are never host-parsed, so the drive-letter colon survives.)
    // Legacy form: pdr-file://[/[/]]<path> — still handled for compat.
    let raw = '';
    try {
      const u = new URL(request.url);
      const f = u.searchParams.get('f');
      if (f) {
        raw = f;
      } else {
        // Legacy: strip the scheme + leading slashes from the path component.
        let p = u.pathname;
        while (p.startsWith('/')) p = p.substring(1);
        raw = decodeURI(p);
      }
    } catch {
      raw = request.url.replace(/^pdr-file:\/\//i, '');
      while (raw.startsWith('/')) raw = raw.substring(1);
      try { raw = decodeURI(raw); } catch {}
    }

    const fileUrl = 'file:///' + encodeURI(raw);
    if (process.env.PDR_DEBUG_PROTOCOL) {
      console.log('[pdr-file] request =', request.url, '→ fetch', fileUrl);
    }

    // HEIC / HEIF: Chromium can't decode HEVC-payload HEIC files
    // natively. The PDR Viewer (and any other surface that loads the
    // raw file via pdr-file://) would get a broken-image icon if we
    // served the original bytes. Convert on the fly to JPEG via
    // pure-JS heic-convert and return that instead. Same library
    // browser:thumbnail uses for HEIC thumbnails. Larger files take
    // a couple of seconds the first time; subsequent fetches of the
    // same file in the same session are served from Chromium's
    // memory cache. Terry 2026-05-20: "do it... so it can be seen
    // throughout PDR... not just S&D".
    const lowerExt = (() => {
      const i = raw.lastIndexOf('.');
      return i >= 0 ? raw.slice(i).toLowerCase() : '';
    })();
    if (lowerExt === '.heic' || lowerExt === '.heif') {
      try {
        const heicConvert = (await import('heic-convert')).default;
        const inputBuffer = await fs.promises.readFile(toLongPath(raw));
        const jpeg = await heicConvert({
          buffer: inputBuffer,
          format: 'JPEG',
          quality: 0.9,
        });
        return new Response(Buffer.from(jpeg), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        });
      } catch (e) {
        console.warn('[pdr-file] HEIC decode failed for', raw, (e as Error).message);
        // Fall through to the regular fetch so Chromium can show
        // its broken-image fallback rather than hanging.
      }
    }

    // v2.0.15 (Terry 2026-06-01) — RANGE-AWARE FILE SERVING.
    // Was: `net.fetch(file://...)` with forwarded headers. Despite
    // the old comment claiming Range support, Electron's net.fetch
    // does NOT honour Range requests on file:// URLs — it returns
    // the full file with 200 every time. That broke HTML5 <video>
    // seek: Chromium needs a 206 Partial Content response to a
    // Range request before it will let the user drag the timeline.
    // Without it, the scrubber bar paints (because duration is in
    // the metadata) but dragging it does nothing.
    //
    // Now: parse the Range header ourselves, read only the requested
    // byte slice with fs.createReadStream({start, end}), and return
    // a 206 with proper Content-Range + Accept-Ranges headers.
    // Falls back to a 200 with Accept-Ranges:bytes when no Range
    // header is present (first request, or non-video fetches).
    try {
      const fsPath = toLongPath(raw);
      const stats = await fs.promises.stat(fsPath);
      const fileSize = stats.size;
      const rangeHeader = request.headers.get('range') || request.headers.get('Range');

      // Best-effort MIME detection — Chromium needs the right type
      // on the response or it refuses to treat the body as seekable
      // video. Falls through to application/octet-stream for unknown
      // extensions so a misnamed file at least downloads.
      const ext = lowerExt;
      const mime =
        ext === '.mp4' ? 'video/mp4' :
        ext === '.m4v' ? 'video/mp4' :
        ext === '.mov' ? 'video/quicktime' :
        ext === '.mkv' ? 'video/x-matroska' :
        ext === '.webm' ? 'video/webm' :
        ext === '.avi' ? 'video/x-msvideo' :
        ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
        ext === '.png' ? 'image/png' :
        ext === '.gif' ? 'image/gif' :
        ext === '.webp' ? 'image/webp' :
        'application/octet-stream';

      const { Readable } = await import('node:stream');

      if (rangeHeader) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
        if (match) {
          let start = parseInt(match[1], 10);
          let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
          if (isNaN(start) || start < 0) start = 0;
          if (isNaN(end) || end >= fileSize) end = fileSize - 1;
          if (start > end) {
            return new Response(null, {
              status: 416,
              headers: { 'Content-Range': `bytes */${fileSize}` },
            });
          }
          const chunkSize = end - start + 1;
          const nodeStream = fs.createReadStream(fsPath, { start, end });
          const webStream = Readable.toWeb(nodeStream) as ReadableStream;
          return new Response(webStream, {
            status: 206,
            headers: {
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(chunkSize),
              'Content-Type': mime,
              'Cache-Control': 'no-cache',
            },
          });
        }
      }

      // No (or malformed) Range header — serve the whole file but
      // advertise Accept-Ranges so Chromium knows to use Range on
      // subsequent seek attempts.
      const nodeStream = fs.createReadStream(fsPath);
      const webStream = Readable.toWeb(nodeStream) as ReadableStream;
      return new Response(webStream, {
        status: 200,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Length': String(fileSize),
          'Content-Type': mime,
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      console.warn('[pdr-file] serve failed for', raw, (err as Error).message);
      // Last-resort fallback to the previous behaviour so a broken
      // serve path doesn't worsen the UX — at least the file might
      // still load even if it can't be seeked.
      return net.fetch(fileUrl, { headers: request.headers, method: request.method });
    }
  });

  // v2.0.15 (Terry 2026-06-05) — pdr-face:// protocol.
  // Renderer uses <img src="pdr-face://thumb/?fp=...&bx=...&by=...&bw=...&bh=...&size=64">
  // (or mode=context for hover previews). Browser handles fetching +
  // caching natively, so PM rows don't pay per-face base64-over-IPC
  // overhead and main process doesn't get asked again once Chromium
  // has the image in its memory cache. Same disk-cache mechanism as
  // ai:faceCrop and ai:faceContext (content-addressed by sha1 of
  // filePath + box coords + size) — adds a per-mode suffix so thumb
  // and context crops don't collide on the same key.
  //
  // Modes:
  //   thumb   — tight square crop (matches ai:faceCrop), default 96px
  //   context — wider crop with neutral letterbox bg (matches
  //             ai:faceContext minus the SVG indicator overlay),
  //             default 240px
  protocol.handle('pdr-face', async (request) => {
    try {
      const url = new URL(request.url);
      const mode = (url.hostname || 'thumb').toLowerCase();
      const fp = url.searchParams.get('fp') ?? '';
      const bx = parseFloat(url.searchParams.get('bx') ?? '');
      const by = parseFloat(url.searchParams.get('by') ?? '');
      const bw = parseFloat(url.searchParams.get('bw') ?? '');
      const bh = parseFloat(url.searchParams.get('bh') ?? '');
      const size = parseInt(url.searchParams.get('size') ?? '96', 10);
      if (!fp || !isFinite(bx) || !isFinite(by) || !isFinite(bw) || !isFinite(bh) || !isFinite(size)) {
        return new Response('Bad request', { status: 400 });
      }
      if (mode !== 'thumb' && mode !== 'context') {
        return new Response('Unknown mode (use thumb or context)', { status: 400 });
      }

      // Cache key includes mode suffix so thumb vs context don't collide.
      // The sha1 part is shared with ai:faceCrop's existing disk cache
      // (mode=thumb), so a thumb already generated by the old code
      // path is hit here too — no double work after migration.
      const baseKey = faceCropCacheKey(fp, bx, by, bw, bh, size);
      const cacheFile = mode === 'thumb'
        ? baseKey                              // backward-compatible with ai:faceCrop's cache
        : baseKey.replace(/\.jpg$/, `.${mode}.jpg`);
      const cachePath = path.join(faceCropCacheDir, cacheFile);
      const cachePathLong = toLongPath(cachePath);

      // Cache hit → serve from disk
      try {
        if (fs.existsSync(cachePathLong)) {
          const buf = await fs.promises.readFile(cachePathLong);
          return new Response(buf, {
            status: 200,
            headers: {
              'Content-Type': 'image/jpeg',
              'Cache-Control': 'public, max-age=31536000, immutable',
            },
          });
        }
      } catch { /* fall through to fresh render */ }

      // Cache miss → generate via sharp
      const sharp = (await import('sharp')).default;
      const filePathLong = toLongPath(fp);
      const metadata = await sharp(filePathLong, { failOnError: false }).rotate().metadata();
      if (!metadata.width || !metadata.height) {
        return new Response('Could not read image', { status: 500 });
      }
      const imgW = metadata.width;
      const imgH = metadata.height;

      let buffer: Buffer;

      if (mode === 'thumb') {
        // Tight square crop with 25% padding around the face box.
        // Identical math to ai:faceCrop above — keep them in sync.
        let px = Math.round(bx * imgW);
        let py = Math.round(by * imgH);
        let pw = Math.round(bw * imgW);
        let ph = Math.round(bh * imgH);
        const padding = Math.round(Math.max(pw, ph) * 0.25);
        const sideLen = Math.max(pw, ph) + padding * 2;
        const cx = px + pw / 2;
        const cy = py + ph / 2;
        px = Math.max(0, Math.round(cx - sideLen / 2));
        py = Math.max(0, Math.round(cy - sideLen / 2));
        pw = Math.min(sideLen, imgW - px);
        ph = Math.min(sideLen, imgH - py);
        if (pw <= 0 || ph <= 0) return new Response('Invalid crop', { status: 500 });
        buffer = await sharp(filePathLong, { failOnError: false })
          .rotate()
          .extract({ left: px, top: py, width: pw, height: ph })
          .resize(size, size, { fit: 'cover' })
          .jpeg({ quality: 85 })
          .toBuffer();
      } else {
        // Wider crop with neutral letterbox background. Identical math
        // to ai:faceContext's crop step, minus the SVG indicator
        // overlay (the hover preview no longer needs the overlay —
        // the user has already clicked the thumbnail itself).
        const faceX = Math.round(bx * imgW);
        const faceY = Math.round(by * imgH);
        const faceW = Math.round(bw * imgW);
        const faceH = Math.round(bh * imgH);
        const expand = 1.5;
        const contextSide = Math.round(Math.max(faceW, faceH) * (1 + expand * 2));
        const cx = faceX + faceW / 2;
        const cy = faceY + faceH / 2;
        let cropX = Math.max(0, Math.round(cx - contextSide / 2));
        let cropY = Math.max(0, Math.round(cy - contextSide / 2));
        const cropW = Math.min(contextSide, imgW - cropX);
        const cropH = Math.min(contextSide, imgH - cropY);
        if (cropW <= 0 || cropH <= 0) return new Response('Invalid crop', { status: 500 });
        buffer = await sharp(filePathLong, { failOnError: false })
          .rotate()
          .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
          .resize(size, size, { fit: 'contain', background: { r: 245, g: 243, b: 250, alpha: 1 } })
          .jpeg({ quality: 85 })
          .toBuffer();
      }

      // Persist to cache for next time (best-effort).
      fs.promises.writeFile(cachePathLong, buffer).catch(err =>
        console.warn(`[pdr-face] cache write failed: ${(err as Error).message}`),
      );

      return new Response(buffer, {
        status: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch (err) {
      console.warn('[pdr-face] handler error:', (err as Error).message);
      return new Response((err as Error).message, { status: 500 });
    }
  });

  // Remove default Electron menus — custom title bar replaces them
  Menu.setApplicationMenu(null);

  // v2.0.11 — three-stage startup sequence (see helpers above for
  // the full architecture rationale):
  //   1. Splash window appears IMMEDIATELY in its own process so the
  //      user always sees a polished, interactive surface from frame
  //      one (drag, resize, no white shell, no Not Responding).
  //   2. Startup worker forks as a utilityProcess and runs DB
  //      cleanup + orphan-sweep on PDR_Temp without ever touching the
  //      main browser thread.
  //   3. Workspace window is created with show: false. Its renderer
  //      mounts in parallel with the worker's cleanup. Both must
  //      finish before maybeFinishStartup() swaps the splash for the
  //      workspace.
  createSplashWindow();
  spawnStartupWorker();
  createWindow();

  // v2.0.11 (Terry 2026-05-25) — pre-fork the extract-worker so its
  // 200–500 ms spawn cost is paid HERE, during app startup, instead
  // of during the user's Add Source click. Deferred behind setTimeout
  // so the splash + workspace renderers are first in the queue and
  // get the main-thread time they need to render.
  setTimeout(() => preforkExtractWorker(), 1500);
  // v2.0.11 (Terry 2026-05-25) — same pre-warm strategy for the
  // cleanup-worker so post-fix temp deletion of 50 GB extractions
  // doesn't have to pay the fork cost in addition to the delete time.
  setTimeout(() => preforkCleanupWorker(), 1500);
  // v2.0.14 (Terry 2026-05-27) — same pre-warm strategy for the
  // analysis-worker so the user's Add Source click triggers the
  // analysis instantly instead of after a 200-500 ms fork delay.
  setTimeout(() => preforkAnalysisWorker(), 1500);
  // v2.0.15 (Terry 2026-06-01) — pre-warm the Takeout sidecar
  // snapshot too. The first Add Source after launch used to block
  // the main thread for ~6 s while it ran the snapshot SQL over the
  // 74k-row takeout_sidecars table + iterated the result into a JS
  // object — long enough for Windows to ghost the title bar white
  // (the "Not Responding" threshold is 5 s). Running it here, off
  // the click path, means the cost is paid while the user is still
  // reading the dashboard. Subsequent Add Sources hit the cache.
  setTimeout(() => {
    try { warmSidecarSnapshotCache(); } catch { /* best-effort */ }
  }, 3000);

  // Wire electron-updater after the main window exists so the updater
  // can broadcast state events to the renderer over webContents.send.
  // initAutoUpdater is a no-op in dev (app.isPackaged === false) — the
  // packaged NSIS build is what actually checks updates.photodaterescue.com.
  if (mainWindow) {
    initAutoUpdater(mainWindow);
  }

  resetCriticalSettings();
  // NOTE: cleanupOrphanedTempDirs() intentionally NOT called on
  // startup — the v2.0.0 design persists pre-extracted Takeouts
  // across sessions so users can restart PDR (or recover from a
  // crash) without losing the 40-minute extraction. Orphan cleanup
  // happens at the moments where it's safe + intended:
  //   • when the user removes a source (analysis:cleanupTempDirForSource)
  //   • when a fix completes successfully (post-copy cleanup)
  // The startup sweep was an aggressive safety net for v1.0.x where
  // every restart re-analysed anyway; in v2.0.0 it actively destroys
  // user state. The 55 GB pre-extract cap (see EXTRACTION_CAP_BYTES)
  // bounds disk usage, replacing what the sweep used to accomplish.
  //
  // The cleanupOrphanedTempDirs function itself stays in the file so
  // a future "Clean up extracted temp files" Settings button can
  // call it on user demand.

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Close child windows if still open
    if (viewerWindow && !viewerWindow.isDestroyed()) {
      viewerWindow.destroy();
      viewerWindow = null;
    }
    if (peopleWindow && !peopleWindow.isDestroyed()) {
      peopleWindow.destroy();
      peopleWindow = null;
    }
    shutdownAiWorker();
    app.quit();
  }
});

app.on('before-quit', async () => {
  // Cancel any running operations to allow clean shutdown
  preScanCancelled = true;
  copyFilesCancelled = true;

  // NOTE: activeTempDirs cleanup intentionally NOT done here —
  // see the same reasoning as the disabled startup sweep above.
  // v2.0.0 persists pre-extracted Takeouts across quit/relaunch
  // so users don't lose 40-minute extractions to a graceful close.
  // Cleanup happens on source-remove and post-fix; the 55 GB cap
  // keeps disk usage bounded. activeTempDirs is in-memory so it
  // resets on next launch, which is fine — the on-disk state is
  // the source of truth for the cap calculation.

  await shutdownExiftool();
  await shutdownIndexerExiftool();
  closeDatabase();
});

ipcMain.handle('dialog:openFolder', async (_event, defaultPath?: string) => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: typeof defaultPath === 'string' && defaultPath.length > 0 ? defaultPath : 'C:\\'
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle('dialog:openZip', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [{ name: 'ZIP/RAR Archives', extensions: ['zip', 'rar'] }],
    defaultPath: 'C:\\'
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

// v2.0.13 — multi-select picker for Takeout zips. Returns the array
// of selected paths (empty array on cancel) wrapped in the standard
// { success, data } envelope so the renderer can distinguish "user
// closed the dialog" from "IPC failure".
//
// Distinct from dialog:openZip (single file, source-add flow) because
// users dragging in a multi-part Takeout will normally want to add
// 4-8 zips in one go from the LDM Takeout metadata row.
ipcMain.handle('dialog:openTakeoutZips', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Google Takeout ZIPs', extensions: ['zip'] }],
      title: 'Select Google Takeout zip(s)',
    });
    if (result.canceled) return { success: true, data: [] as string[] };
    return { success: true, data: result.filePaths };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('source:pick', async (_event, mode: 'folder' | 'zip') => {
  let result;
  
  if (mode === 'folder') {
    result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
	  defaultPath: 'C:\\'
    });
  } else {
    result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: 'ZIP/RAR Archives', extensions: ['zip', 'rar'] }],
      defaultPath: 'C:\\'
    });
  }
  
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  
  const selectedPath = result.filePaths[0];
  const label = path.basename(selectedPath);
  
  return {
    path: selectedPath,
    type: mode,
    label: label
  };
});

ipcMain.handle('dialog:selectDestination', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Destination',
    defaultPath: 'C:\\'
  });
  
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  
  return result.filePaths[0];
});

ipcMain.handle('select-destination', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select Destination',
    defaultPath: 'C:\\'
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('show-message', async (event, title: string, message: string) => {
  await dialog.showMessageBox({
    type: 'info',
    title: title,
    message: message,
    buttons: ['OK']
  });
});

ipcMain.handle('shell:openFolder', async (_event, folderPath: string) => {
  try {
    const normalizedPath = path.normalize(folderPath);
    await shell.openPath(normalizedPath);
  } catch (error) {
    console.error('Error opening folder:', error);
  }
});

// Reveal an arbitrary path in Explorer — used by the Report-a-Problem
// success state to re-open the Documents folder showing the diagnostic
// ZIP (in case the user accidentally closed the folder window we
// opened on Send). showItemInFolder highlights the file inside the
// folder; openPath would just open the folder generically.
ipcMain.handle('shell:showItemInFolder', async (_event, filePath: string) => {
  try {
    shell.showItemInFolder(path.normalize(filePath));
  } catch (error) {
    console.error('Error revealing path:', error);
  }
});

ipcMain.handle('shell:openExternal', async (_event, url: string) => {
  try {
    await shell.openExternal(url);
  } catch (error) {
    console.error('Error opening external URL:', error);
  }
});

// ─── PDR Recycle Bin (v2.0.15) ─────────────────────────────────────────────
//
// Two-stage delete: Move to Recycle Bin is a reversible soft delete
// (sets in_recycle_bin = 1, file stays on disk). Permanent Delete from
// the Recycle Bin view calls shell.trashItem so the OS Recycle Bin is
// the actual final stop — that way the user has two layers of safety
// before anything leaves their disk.

ipcMain.handle('recycle:move', async (_event, fileIds: number[]) => {
  try {
    const updated = moveFilesToRecycleBin(fileIds ?? []);
    // Broadcast so any open view re-fetches and the moved items disappear.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('recycle:changed', { kind: 'move', count: updated });
    }
    return { success: true, count: updated };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('recycle:restore', async (_event, fileIds: number[]) => {
  try {
    const updated = restoreFilesFromRecycleBin(fileIds ?? []);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('recycle:changed', { kind: 'restore', count: updated });
    }
    return { success: true, count: updated };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('recycle:permanentDelete', async (_event, fileIds: number[], skipOsBin: boolean = false) => {
  if (!fileIds || fileIds.length === 0) return { success: true, removed: 0, failed: [] };
  try {
    // Resolve file paths first — once we delete from the index they're gone.
    const { getDb } = await import('./search-database.js');
    const database = getDb();
    const placeholders = fileIds.map(() => '?').join(',');
    const rows = database
      .prepare(`SELECT id, file_path FROM indexed_files WHERE id IN (${placeholders})`)
      .all(...fileIds) as { id: number; file_path: string }[];

    const failed: { id: number; error: string }[] = [];
    const trashedIds: number[] = [];
    // v2.0.15 (Terry 2026-05-30) — skipOsBin=true takes the file
    // straight to fs.unlink, bypassing the OS Recycle Bin. The OS
    // bin keeps a full byte-for-byte copy until emptied so it
    // doesn't free disk space; users emptying PDR's own bin to
    // reclaim space need the true-delete path, not a copy shuffle.
    console.log(`[recycle:permanentDelete] processing ${rows.length} file(s) — skipOsBin=${skipOsBin}`);
    for (const row of rows) {
      try {
        // Strip Windows long-path prefix (\\?\) before calling
        // shell.trashItem. Electron's shell.trashItem on Windows uses
        // IFileOperation, which chokes on the long-path prefix and
        // throws "Failed to move item to trash" with no further
        // detail. The PDR analysis pipeline writes \\?\-prefixed
        // paths into the DB for files on long-pathed library drives;
        // normalising the prefix off here lets trashItem accept them.
        // The fs.existsSync check accepts either form so it stays
        // accurate. fs.promises.unlink also handles either form.
        const normalised = row.file_path.replace(/^\\\\\?\\/, '');
        if (!fs.existsSync(normalised)) {
          console.log(`[recycle:permanentDelete] file already gone, dropping index row only: ${normalised}`);
          trashedIds.push(row.id);
          continue;
        }
        if (skipOsBin) {
          await fs.promises.unlink(normalised);
        } else {
          await shell.trashItem(normalised);
        }
        trashedIds.push(row.id);
      } catch (e) {
        const msg = (e as Error).message || String(e);
        console.error(`[recycle:permanentDelete] failed for id=${row.id} path=${row.file_path}: ${msg}`);
        failed.push({ id: row.id, error: msg });
      }
    }
    const removed = deleteIndexedFiles(trashedIds);
    console.log(`[recycle:permanentDelete] done — removed=${removed}, failed=${failed.length}, skipOsBin=${skipOsBin}`);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('recycle:changed', { kind: 'permanentDelete', count: removed });
    }
    return { success: true, removed, failed };
  } catch (err) {
    console.error('[recycle:permanentDelete] handler error:', err);
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('recycle:list', async () => {
  try {
    return { success: true, data: listRecycleBin() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('recycle:count', async () => {
  try {
    return { success: true, count: getRecycleBinCount() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('window:flashFrame', async () => {
  if (mainWindow) {
    mainWindow.flashFrame(true);
    
    // Stop flashing when window gets focus
    const stopFlash = () => {
      mainWindow?.flashFrame(false);
      mainWindow?.removeListener('focus', stopFlash);
    };
    mainWindow.on('focus', stopFlash);
  }
});

ipcMain.handle('disk:getSpace', async (_event, directoryPath: string) => {
  try {
    // ── Path 1: fs.statfsSync (Node 18.15+) ──────────────────────────
    // Cross-platform, filesystem-level free/total bytes. CRITICALLY,
    // statfs works for UNC paths on Windows (`\\server\share\…`) — the
    // PowerShell `Get-PSDrive` path below does NOT, because parsing
    // `\\server\share\` as a "drive letter" produces garbage that PS
    // can't query. Customer Kathr 2026-05-15: every disk-info probe
    // for her UNC library (`\\KATDADDY\E Kats Drive`) failed for this
    // exact reason, leaving her LDM unable to show free space and
    // her "change library drive" flow hanging.
    //
    // statfs returns block-level numbers (bsize × bfree / blocks); we
    // multiply through to bytes. Works for letter drives, UNC paths,
    // and mounted volumes alike. Fall through to legacy PS / wmic
    // paths only on statfs failure (very old Node, EACCES on certain
    // network mounts, etc).
    try {
      const stat = fs.statfsSync(toLongPath(directoryPath));
      if (stat && typeof stat.bsize === 'number' && typeof stat.bfree === 'number' && typeof stat.blocks === 'number') {
        return {
          freeBytes: stat.bsize * stat.bfree,
          totalBytes: stat.bsize * stat.blocks,
        };
      }
    } catch (statfsErr) {
      // Fall through to legacy paths below — don't surface the error.
    }

    if (process.platform === 'darwin' || process.platform === 'linux') {
      const output = execSync(`df -k "${directoryPath}"`, { encoding: 'utf8' });
      const lines = output.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        const availableKB = parseInt(parts[3], 10);
        const totalKB = parseInt(parts[1], 10);
        return {
          freeBytes: availableKB * 1024,
          totalBytes: totalKB * 1024,
        };
      }
    } else if (process.platform === 'win32') {
      // UNC paths can't be queried by drive letter — skip the PS/wmic
      // letter-based path entirely. statfs above is the primary route
      // for UNC; if even that failed we have no good answer and
      // returning zeros lets the caller render a friendly "free space
      // unavailable for network drives" hint rather than hanging.
      if (directoryPath.startsWith('\\\\')) {
        console.warn('[Disk] statfs failed for UNC path; returning 0/0:', directoryPath);
        return { freeBytes: 0, totalBytes: 0 };
      }
      const driveLetter = path.parse(directoryPath).root.replace('\\', '');
      // Use PowerShell (always available) instead of wmic (deprecated/removed in newer Windows 11)
      try {
        const psCmd = `powershell -NoProfile -Command "(Get-PSDrive -Name '${driveLetter.replace(':', '')}' -PSProvider FileSystem | Select-Object Free,Used,@{N='Total';E={$_.Free+$_.Used}}) | ConvertTo-Json"`;
        const psOutput = execSync(psCmd, { encoding: 'utf8', timeout: 10000 });
        const driveInfo = JSON.parse(psOutput.trim());
        if (driveInfo && driveInfo.Free != null && driveInfo.Total != null) {
          return {
            freeBytes: driveInfo.Free,
            totalBytes: driveInfo.Total,
          };
        }
      } catch {
        // PowerShell failed — fall back to wmic for older Windows versions
        try {
          const output = execSync(`wmic logicaldisk where "DeviceID='${driveLetter}'" get FreeSpace,Size /format:csv`, { encoding: 'utf8' });
          const lines = output.trim().split('\n').filter(l => l.trim());
          if (lines.length >= 2) {
            const parts = lines[1].split(',');
            return {
              freeBytes: parseInt(parts[1], 10),
              totalBytes: parseInt(parts[2], 10),
            };
          }
        } catch {
          console.error('[Disk] Both PowerShell and wmic failed for drive', driveLetter);
        }
      }
    }
    return { freeBytes: 0, totalBytes: 0 };
  } catch (error) {
    console.error('Error getting disk space:', error);
    return { freeBytes: 0, totalBytes: 0 };
  }
});

// ── Custom Folder Browser IPC handlers ──

const IMAGE_EXTENSIONS_BROWSER = new Set([
  '.jpg', '.jpeg', '.jfif', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp',
  '.heic', '.heif', '.avif', '.jp2', '.j2k', '.svg', '.ico', '.psd',
  '.raw', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.rw2', '.pef',
  '.sr2', '.srf', '.raf', '.3fr', '.rwl', '.x3f', '.dcr', '.kdc', '.mrw', '.erf',
]);

ipcMain.handle('browser:listDrives', async () => {
  // v2.0.15 (Terry 2026-05-30) — PowerShell-FIRST with always-on
  // Node fallback. The PowerShell route gives rich data (volume
  // label, total/free bytes, type discrimination) but on a busy
  // system (AV scan, PDR doing analysis + AI + indexing) it can
  // exceed the 10s timeout and the user ends up staring at an
  // empty drives panel. The fallback walks A-Z with fs.statSync,
  // which is instant + native, so the user ALWAYS sees their
  // drives — just without free-space / volume labels.
  const walkDriveLetters = (): Array<{ letter: string; label: string; type: string; totalBytes: number; freeBytes: number }> => {
    if (process.platform !== 'win32') return [];
    const drives: Array<{ letter: string; label: string; type: string; totalBytes: number; freeBytes: number }> = [];
    for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
      const letter = String.fromCharCode(code) + ':';
      try {
        // statSync(`${letter}\\`) throws if the drive doesn't exist
        // or isn't mounted. Cheap: no subprocess, no IPC, no waiting.
        fs.statSync(`${letter}\\`);
        drives.push({
          letter,
          label: 'Drive',
          type: 'Drive',
          totalBytes: 0,
          freeBytes: 0,
        });
      } catch { /* not mounted — skip */ }
    }
    return drives;
  };

  try {
    if (process.platform === 'win32') {
      let output: string;
      try {
        output = await new Promise<string>((resolve, reject) => {
          execFile('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,DriveType,Size,FreeSpace | ConvertTo-Csv -NoTypeInformation`
          ], { encoding: 'utf8', timeout: 10000 }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          });
        });
      } catch (psErr) {
        // PowerShell timed out / failed (busy system, AV interference,
        // missing PS, etc.). Fall back to the drive-letter walk so the
        // user still sees their drives in the picker.
        console.warn('[listDrives] PowerShell route failed; falling back to fs.statSync drive-letter walk:', psErr);
        return walkDriveLetters();
      }

      const lines = output.trim().split('\n').filter(l => l.trim());
      if (lines.length < 2) return walkDriveLetters();
      // Parse CSV: header line + data lines
      const parsed = lines.slice(1).map(line => {
        // CSV values may be quoted
        const parts = line.split(',').map(p => p.replace(/^"|"$/g, '').trim());
        const deviceId = parts[0] || '';
        const volumeName = parts[1] || '';
        const driveType = parseInt(parts[2], 10);
        const size = parseInt(parts[3], 10) || 0;
        const freeSpace = parseInt(parts[4], 10) || 0;
        const typeLabel = driveType === 2 ? 'Removable' : driveType === 3 ? 'Local Disk' : driveType === 4 ? 'Network' : driveType === 5 ? 'CD/DVD' : 'Drive';
        return {
          letter: deviceId,
          label: volumeName || typeLabel,
          type: typeLabel,
          totalBytes: size,
          freeBytes: freeSpace,
          driveType,
        };
      }).filter(d => {
        if (!d.letter) return false;
        // v2.0.11 — hide non-storage devices that Windows still assigns
        // a drive letter to. Caught by Techtime with Timmy 2026-05-24:
        // a wireless keyboard receiver showed up in the Pick Library
        // Drive picker because its tiny onboard chip is enumerated as
        // removable storage. Same pattern catches empty SD card reader
        // slots and any other dongles whose embedded firmware happens
        // to look like a FAT volume.
        //
        // CD/DVD drives: always hide (read-only optical media is never
        // a viable Library Drive).
        if (d.driveType === 5) return false;
        // Removable drives smaller than 1 GB: hide. Real removable
        // storage (USB sticks, SD cards) has been 4 GB+ for over a
        // decade — anything sub-1-GB on a removable bus is a peripheral
        // dongle / empty slot, never a real drive a user would pick.
        // totalBytes === 0 also caught here (empty card-reader slots).
        if (d.driveType === 2 && d.totalBytes < 1024 * 1024 * 1024) return false;
        return true;
      }).map(({ driveType: _dt, ...rest }) => rest);
      // If parsing produced nothing usable (header-only or all filtered
      // out), fall back rather than show an empty list.
      return parsed.length > 0 ? parsed : walkDriveLetters();
    }
    return [];
  } catch (error) {
    console.error('[listDrives] unexpected error; falling back to fs.statSync drive-letter walk:', error);
    return walkDriveLetters();
  }
});

// Thumbnail cache directory
const thumbCacheDir = path.join(app.getPath('userData'), 'thumb-cache');
fs.mkdirSync(thumbCacheDir, { recursive: true });

// ─── Face-crop cache directory ──────────────────────────────────────────────
// Pre-rendered ~96 px square JPGs of every detected face, keyed by the
// SHA-1 of (file_path + bounding-box coords + requested size). The cache
// is what makes People Manager / Trees / S&D's face thumbnails open
// instantly after the first time a face has been seen, and — critically
// — keeps the user's named/verified face data visually intact even when
// the user has deleted or moved the original photos. v1 read every
// face's region from the original file on every render (sharp.extract +
// resize per face), which made PM stutter on libraries with thousands
// of faces and broke entirely once the originals were gone. The cache
// is content-addressed so the same crop is shared across surfaces and
// across runs; a re-detection that produces different box coords just
// writes a new entry under a new key.
const faceCropCacheDir = path.join(app.getPath('userData'), 'face-crops');
fs.mkdirSync(faceCropCacheDir, { recursive: true });

// ─── Video transcoding cache ────────────────────────────────────────────────
// Chromium cannot natively play MPEG-1/2 (.mpg), most .avi/.wmv/.flv variants,
// or anything outside H.264/H.265/VP8/VP9/AV1 in MP4/WebM/MKV containers.
// For those we transcode on-demand to H.264 + AAC MP4 via ffmpeg-static and
// cache the result under userData, so the second open is instant.
const videoCacheDir = path.join(app.getPath('userData'), 'video-cache');
fs.mkdirSync(videoCacheDir, { recursive: true });

// Extensions that Chromium will almost certainly refuse. We transcode these
// up-front rather than waiting for the <video> element to emit an error.
const TRANSCODE_EXTS = new Set(['.mpg', '.mpeg', '.avi', '.wmv', '.flv', '.3gp', '.m2ts', '.mts', '.vob', '.rm', '.rmvb', '.asf', '.mpe', '.mpv']);

// Containers whose ext alone doesn't tell us if Chromium can play them —
// these may hold H.264 (Chromium-fine) OR HEVC (Electron 39's Chromium has
// no HEVC decoder, plays sound-only over a black frame). Probe the codec
// before deciding. OnePlus / Samsung / iPhone motion-photo .mp4 side-files
// are HEVC and trip this path.
const MAYBE_HEVC_EXTS = new Set(['.mp4', '.m4v', '.mov', '.mkv']);

// Track in-flight transcodes so concurrent calls de-dupe to the same promise.
const transcodeInFlight = new Map<string, Promise<{ success: boolean; cachePath?: string; error?: string }>>();

// In-memory cache of probed video codec keyed by `path:size:mtimeMs`. Cleared
// on app restart. Saves ~50ms per repeat play of the same file.
const probedCodecCache = new Map<string, string | null>();

async function transcodeVideoToMp4(sourcePath: string, cachePath: string): Promise<{ success: boolean; cachePath?: string; error?: string }> {
  if (!ffmpegPath) return { success: false, error: 'ffmpeg binary not found' };
  return new Promise((resolve) => {
    // Write to a .part file first so a crashed transcode doesn't leave a half-written cache entry.
    const partPath = cachePath + '.part';
    try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch {}
    // Same long-path caveat as extractVideoFrame — see comment there.
    const ffmpegSrc = fromLongPath(sourcePath);
    // -f mp4 is REQUIRED because the .part extension means ffmpeg can't
    // infer the container from the filename.
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', ffmpegSrc,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-f', 'mp4',
      '-y', partPath,
    ];
    const proc = spawn(ffmpegPath!, args, { windowsHide: true });
    let stderr = '';
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    let finished = false;
    const done = (ok: boolean, err?: string) => {
      if (finished) return;
      finished = true;
      if (ok) {
        try {
          fs.renameSync(partPath, cachePath);
          resolve({ success: true, cachePath });
          return;
        } catch (e) {
          resolve({ success: false, error: (e as Error).message });
          return;
        }
      }
      try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch {}
      resolve({ success: false, error: err || stderr || 'ffmpeg failed' });
    };
    proc.on('error', (e) => done(false, e.message));
    proc.on('close', (code) => done(code === 0));
  });
}

// Probe the first video stream's codec by running ffmpeg with no output —
// ffmpeg-static doesn't bundle ffprobe, but `ffmpeg -i FILE` prints the
// stream summary to stderr regardless, and we can grep for `Video: <codec>`.
// Returns lowercase codec name ('hevc', 'h264', …) or null on failure.
async function probeVideoCodec(videoPath: string): Promise<string | null> {
  if (!ffmpegPath) return null;
  return new Promise<string | null>((resolve) => {
    const ffmpegSrc = fromLongPath(videoPath);
    const proc = spawn(ffmpegPath!, ['-hide_banner', '-i', ffmpegSrc], { windowsHide: true });
    let stderr = '';
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    let settled = false;
    const finish = (codec: string | null) => { if (!settled) { settled = true; resolve(codec); } };
    proc.on('error', () => finish(null));
    // `ffmpeg -i FILE` with no output spec exits 1 — but the stream info
    // is still on stderr, so we parse on close regardless of exit code.
    proc.on('close', () => {
      const m = stderr.match(/Video:\s+([A-Za-z0-9_]+)/);
      finish(m ? m[1].toLowerCase() : null);
    });
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} finish(null); }, 5000);
  });
}

ipcMain.handle('video:prepare', async (_event, filePath: string): Promise<{ success: boolean; playableUrl?: string; cachePath?: string; error?: string }> => {
  try {
    if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };
    const ext = path.extname(filePath).toLowerCase();

    // Normalised pdr-file:// URL the renderer uses for direct playback.
    // Chromium's URL parser mangles 'C:' drive letters even with three slashes
    // because pdr-file is registered as a 'standard' scheme — it tries to
    // parse the path as host:port and silently drops the colon. We dodge that
    // by putting the path in a query parameter, which is never host-parsed.
    const toPdrUrl = (p: string) => 'pdr-file://local/?f=' + encodeURIComponent(p.replace(/\\/g, '/'));

    // Derive a deterministic cache key from absolute path + mtime + size so the
    // cache auto-invalidates if the source is replaced. (Computed up front so
    // we can short-circuit on an existing cached transcode for HEVC clips
    // without paying the ffmpeg-probe cost.)
    const stat = await fs.promises.stat(filePath);
    const keySrc = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    const cacheKey = crypto.createHash('md5').update(keySrc).digest('hex');
    const cachePath = path.join(videoCacheDir, `${cacheKey}.mp4`);

    // Three classes of input:
    //   1. Hopeless extension (.mpg/.avi/…) — always transcode.
    //   2. Probably-OK extension (.mp4/.mov/.m4v/.mkv) — probe the codec; HEVC
    //      needs transcoding (Chromium can't decode it under Electron 39),
    //      H.264/VP9/AV1 plays directly.
    //   3. Anything else (.webm/.3gp/…) — play directly.
    let needsTranscode = TRANSCODE_EXTS.has(ext);
    if (!needsTranscode && MAYBE_HEVC_EXTS.has(ext)) {
      // If we already transcoded this file in a previous session, the cache
      // file's existence is itself a record that transcoding was needed —
      // skip the probe and reuse it.
      if (fs.existsSync(cachePath)) {
        return { success: true, playableUrl: toPdrUrl(cachePath), cachePath };
      }
      let codec = probedCodecCache.get(keySrc);
      if (codec === undefined) {
        codec = await probeVideoCodec(filePath);
        probedCodecCache.set(keySrc, codec);
      }
      if (codec === 'hevc' || codec === 'h265') needsTranscode = true;
    }

    if (!needsTranscode) {
      return { success: true, playableUrl: toPdrUrl(filePath) };
    }

    if (fs.existsSync(cachePath)) {
      return { success: true, playableUrl: toPdrUrl(cachePath), cachePath };
    }

    // De-dupe concurrent transcodes of the same file.
    let pending = transcodeInFlight.get(cachePath);
    if (!pending) {
      pending = transcodeVideoToMp4(filePath, cachePath);
      transcodeInFlight.set(cachePath, pending);
      pending.finally(() => { transcodeInFlight.delete(cachePath); });
    }
    const result = await pending;
    if (!result.success || !result.cachePath) return { success: false, error: result.error };
    return { success: true, playableUrl: toPdrUrl(result.cachePath), cachePath: result.cachePath };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
});

ipcMain.handle('browser:thumbnail', async (_event, filePath: string, size: number) => {
  try {
    // v2.0.14 (Terry 2026-05-28) — fold user_rotation into the cache
    // key so a rotated photo doesn't keep serving the pre-rotation
    // thumb from disk cache forever. The viewer's rotate buttons
    // already persist rotation to indexed_files.user_rotation; we
    // now apply it in the sharp pipeline below as well, AND broadcast
    // pdr:rotationChanged from setRotation so any open thumbnail
    // surface (Memories grid, Albums tiles, viewer filmstrip) can
    // refetch with the new key.
    const userRotation = (() => {
      try { return getUserRotation(filePath); } catch { return 0; }
    })();
    // Check disk cache first. Long-path-wrap the cache path defensively
    // even though the userData/thumb-cache root is normally short — the
    // hash-derived filename is short, so the prefix only matters if the
    // user's userData path itself is unusually long.
    const cacheKey = crypto.createHash('md5').update(`${filePath}:${size}:r${userRotation}`).digest('hex');
    const cachePath = path.join(thumbCacheDir, `${cacheKey}.jpg`);
    const cachePathLong = toLongPath(cachePath);
    // Long-path-wrap the source path too: deep library trees on Windows
    // routinely push individual photo paths past the 260-char MAX_PATH
    // boundary, and sharp / fs read through to Win32 APIs that respect
    // the `\\?\` prefix. See long-path.ts.
    const filePathLong = toLongPath(filePath);

    if (fs.existsSync(cachePathLong)) {
      const cached = await fs.promises.readFile(cachePathLong);
      return { success: true, dataUrl: `data:image/jpeg;base64,${cached.toString('base64')}` };
    }

    // Check file exists
    if (!fs.existsSync(filePathLong)) {
      return { success: false, dataUrl: '' };
    }

    let jpegBuffer: Buffer | null = null;
    const ext = path.extname(filePath).toLowerCase();

    // HEIC / HEIF: sharp on Windows can't decode the HEVC pixel
    // payload (libheif ships without the HEVC plugin under the
    // standard LGPL distribution because HEVC is patent-encumbered).
    // Decode via pure-JS heic-convert FIRST and hand the resulting
    // JPEG bytes to sharp for resize. Slower than native libheif
    // (~200–400ms per first thumbnail) but the result is cached on
    // disk after this run, so every subsequent open of the same
    // photo is instant. Terry 2026-05-20: "do it... so it can be
    // seen throughout PDR... not just S&D".
    if (ext === '.heic' || ext === '.heif') {
      try {
        const heicConvert = (await import('heic-convert')).default;
        const inputBuffer = await fs.promises.readFile(filePathLong);
        const converted = await heicConvert({
          buffer: inputBuffer,
          format: 'JPEG',
          quality: 0.85,
        });
        jpegBuffer = await sharp(Buffer.from(converted), { failOnError: false })
          .rotate()
          .resize(size, size, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
      } catch (e) {
        console.warn('[heic] decode failed for', filePath, (e as Error).message);
      }
    }

    // Video: extract a frame via ffmpeg-static, then resize through sharp.
    if (!jpegBuffer && VIDEO_EXTS.has(ext)) {
      // v2.0.15 (Terry 2026-06-05) — failure-counter short-circuit. If
      // this file has failed extraction N times in a row this session
      // (VIDEO_THUMB_GIVE_UP_AFTER), skip the cascade — the result
      // will be the same and the storm of pointless ffmpeg subprocess
      // spawns is what crashed Terry's renderer scrolling 6,996 videos
      // in S&D filtered to Videos-only. Counter rather than boolean
      // because the initial-storm runs were prone to transient OS-side
      // kills; a legitimate file could otherwise get poisoned after
      // one unlucky run and stay missing until the next session.
      const priorFailures = VIDEO_THUMB_FAILURE_COUNT.get(filePathLong) ?? 0;
      if (priorFailures >= VIDEO_THUMB_GIVE_UP_AFTER) {
        // Fall through to the next thumbnail source (sharp / nativeImage
        // fallback below) — they'll also fail but at least don't churn.
      } else {
        try {
          // Cascade of seek positions for short clips and codecs that
          // dislike a 1s pre-seek. v2.0.13 (Terry 2026-05-27) — 0s and
          // 2s were added specifically because Samsung Motion-Photo
          // .mp4 side-files (2-3 s HEVC) couldn't seek to 1s but the
          // embedded photo frame is at frame 0 (seek=0s) or near the
          // end (seek=2s). v2.0.15 (Terry 2026-06-05) — RESTORED the
          // full 4-attempt cascade after a brief experiment with 2
          // attempts re-broke Motion Photo thumbnails. The renderer-
          // crash storm that motivated the trim is now prevented by
          // VIDEO_THUMB_FAILURE_COUNT (caps total attempts at N per
          // file per session — no subprocess multiplication across
          // scroll-bys).
          let frame = await extractVideoFrame(filePathLong, 1);
          if (!frame) frame = await extractVideoFrame(filePathLong, 0);
          if (!frame) frame = await extractVideoFrame(filePathLong, 0.5);
          if (!frame) frame = await extractVideoFrame(filePathLong, 2);
          if (frame) {
            jpegBuffer = await sharp(frame, { failOnError: false })
              .resize(size, size, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toBuffer();
            // v2.0.15 — reset the failure count on success so a single
            // bad-luck run earlier doesn't keep counting against the file.
            VIDEO_THUMB_FAILURE_COUNT.delete(filePathLong);
          } else {
            // v2.0.15 — increment the failure count; subsequent visits
            // stop trying once VIDEO_THUMB_GIVE_UP_AFTER is reached.
            const next = priorFailures + 1;
            VIDEO_THUMB_FAILURE_COUNT.set(filePathLong, next);
            console.warn(`[ffmpeg] no frame extracted for ${filePath} (tried 1s, 0s, 0.5s, 2s — failure ${next}/${VIDEO_THUMB_GIVE_UP_AFTER})`);
          }
        } catch (e) {
          const next = priorFailures + 1;
          VIDEO_THUMB_FAILURE_COUNT.set(filePathLong, next);
          console.warn(`[ffmpeg] frame→sharp failed for ${filePath} (failure ${next}/${VIDEO_THUMB_GIVE_UP_AFTER}): ${(e as Error).message}`);
        }
      }
    }

    // Use sharp for robust thumbnail generation (handles TIF, large files, RAW formats).
    // .rotate() applies EXIF auto-rotation. Without it, sharp re-encodes
    // pixels in storage order and strips the EXIF flag — so the resulting
    // JPEG displays sideways for any phone shot taken in portrait. That
    // also breaks face-box overlays in the grid: detection now stores box
    // coords in rotated space, so an un-rotated thumbnail puts the box on
    // the wrong region of the same photo.
    if (!jpegBuffer) {
      try {
        jpegBuffer = await sharp(filePathLong, { failOnError: false })
          .rotate()
          .resize(size, size, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
      } catch {
        // Sharp failed — fall back to nativeImage
      }
    }

    // Fallback: nativeImage (good for standard JPEG/PNG/BMP)
    if (!jpegBuffer) {
      const img = nativeImage.createFromPath(filePathLong);
      if (!img.isEmpty()) {
        // For BMP and other formats sharp can't handle, convert via nativeImage → PNG → sharp
        if (ext === '.bmp') {
          try {
            const pngBuf = img.toPNG();
            jpegBuffer = await sharp(pngBuf)
              .resize(size, size, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toBuffer();
          } catch {
            // Final fallback: direct JPEG from nativeImage
          }
        }
        if (!jpegBuffer) {
          const origSize = img.getSize();
          const scale = Math.min(size / origSize.width, size / origSize.height, 1);
          const newWidth = Math.round(origSize.width * scale);
          const newHeight = Math.round(origSize.height * scale);
          const resized = img.resize({ width: newWidth, height: newHeight, quality: 'good' });
          jpegBuffer = Buffer.from(resized.toJPEG(80));
        }
      }
    }

    if (!jpegBuffer) {
      return { success: false, dataUrl: '' };
    }

    // v2.0.14 — apply user_rotation as a post-process on the resized
    // buffer. Done here rather than chained into each format-specific
    // pipeline above so HEIC, video frames, sharp-decoded images, and
    // nativeImage fallbacks all pick it up uniformly. Skipped when
    // userRotation === 0 so the no-rotation path stays a single sharp
    // chain. The cache key includes userRotation so this stays sticky
    // across opens.
    if (userRotation > 0) {
      try {
        jpegBuffer = await sharp(jpegBuffer).rotate(userRotation).jpeg({ quality: 80 }).toBuffer();
      } catch (e) {
        console.warn('[thumb] user rotation apply failed for', filePath, (e as Error).message);
      }
    }

    // Save to disk cache (fire and forget). Long-path-wrap so cache
    // writes don't fail on unusually-long userData paths.
    fs.promises.writeFile(cachePathLong, jpegBuffer).catch(() => {});

    return { success: true, dataUrl: `data:image/jpeg;base64,${jpegBuffer.toString('base64')}` };
  } catch {
    return { success: false, dataUrl: '' };
  }
});

const ARCHIVE_EXTENSIONS = new Set(['.zip', '.rar']);

ipcMain.handle('browser:readDirectory', async (_event, dirPath: string, fileFilter?: string) => {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const items: Array<{ name: string; path: string; isDirectory: boolean; isImage: boolean; isArchive: boolean; sizeBytes: number; hasSubfolders: boolean; modifiedAt: number }> = [];
    for (const entry of entries) {
      // Skip hidden/system files
      if (entry.name.startsWith('.') || entry.name.startsWith('$')) continue;
      const fullPath = path.join(dirPath, entry.name);
      const isDir = entry.isDirectory();
      const ext = path.extname(entry.name).toLowerCase();
      const isImage = !isDir && IMAGE_EXTENSIONS_BROWSER.has(ext);
      const isArchive = !isDir && ARCHIVE_EXTENSIONS.has(ext);

      // Quick peek: does this folder contain subfolders?
      let hasSubfolders = false;
      if (isDir) {
        try {
          const children = await fs.promises.readdir(fullPath, { withFileTypes: true });
          hasSubfolders = children.some(c => c.isDirectory() && !c.name.startsWith('.') && !c.name.startsWith('$'));
        } catch {
          // Access denied or other error — just leave as false
        }
      }

      // Modified-date stat: one fs.stat per entry. Needed for sort-by-date.
      // Wrapped in try so an inaccessible item doesn't abort the whole listing.
      let modifiedAt = 0;
      let sizeBytes = 0;
      try {
        const st = await fs.promises.stat(fullPath);
        modifiedAt = st.mtimeMs;
        sizeBytes = st.size;
      } catch { /* leave zero */ }

      if (fileFilter === 'archives') {
        // In archive mode: show folders + archive files only
        if (isDir || isArchive) {
          items.push({ name: entry.name, path: fullPath, isDirectory: isDir, isImage: false, isArchive, sizeBytes: isArchive ? sizeBytes : 0, hasSubfolders, modifiedAt });
        }
      } else if (fileFilter === 'source') {
        // Source mode: show folders + images + archives
        if (isDir || isImage || isArchive) {
          items.push({ name: entry.name, path: fullPath, isDirectory: isDir, isImage, isArchive, sizeBytes: (isArchive || isImage) ? sizeBytes : 0, hasSubfolders, modifiedAt });
        }
      } else {
        // Default mode: show folders + image files
        if (isDir || isImage) {
          items.push({ name: entry.name, path: fullPath, isDirectory: isDir, isImage, isArchive: false, sizeBytes: isImage ? sizeBytes : 0, hasSubfolders, modifiedAt });
        }
      }
    }
    // Folders first, then files, both alphabetical
    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return { success: true, items };
  } catch (error: any) {
    return { success: false, items: [], error: error.code === 'EPERM' || error.code === 'EACCES' ? 'Access denied — you don\'t have permission to view this folder.' : `Unable to read this folder: ${error.message}` };
  }
});

ipcMain.handle('browser:createDirectory', async (_event, dirPath: string) => {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

const PHOTO_EXTENSIONS_PRESCAN = new Set([
  '.jpg', '.jpeg', '.jfif', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp',
  '.heic', '.heif', '.avif', '.jp2', '.j2k',
  '.raw', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.rw2', '.pef',
  '.sr2', '.srf', '.raf', '.3fr', '.rwl', '.x3f', '.dcr', '.kdc', '.mrw', '.erf',
  '.ico', '.svg', '.psd',
]);
const VIDEO_EXTENSIONS_PRESCAN = new Set([
  '.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v',
  '.3gp', '.3g2', '.mts', '.m2ts', '.ts', '.vob',
  '.mpg', '.mpeg', '.asf', '.divx', '.ogv', '.rm', '.rmvb', '.swf',
]);

function isMediaFileForPreScan(filename: string): 'photo' | 'video' | null {
  const ext = path.extname(filename).toLowerCase();
  if (PHOTO_EXTENSIONS_PRESCAN.has(ext)) return 'photo';
  if (VIDEO_EXTENSIONS_PRESCAN.has(ext)) return 'video';
  return null;
}

let preScanCancelled = false;

ipcMain.handle('prescan:cancel', async () => {
  preScanCancelled = true;
  return { success: true };
});

ipcMain.handle('prescan:run', async (_event, sourcePath: string, sourceType: 'folder' | 'zip', noTimeout: boolean = false) => {
  preScanCancelled = false;
  
  try {
    let fileCount = 0;
    let photoCount = 0;
    let videoCount = 0;
    let totalBytes = 0;
    const startTime = Date.now();
    const TIMEOUT_MS = noTimeout ? Infinity : 20000;
    let timedOut = false;
    
    const sendProgress = () => {
      mainWindow?.webContents.send('prescan:progress', {
        fileCount,
        photoCount,
        videoCount,
        totalBytes,
        timedOut,
        elapsed: Date.now() - startTime
      });
    };
    
    if (sourceType === 'zip') {
      const zip = new AdmZip(sourcePath);
      const entries = zip.getEntries();
      
      for (const entry of entries) {
        if (preScanCancelled) {
          return { success: false, cancelled: true };
        }
        
        if (!entry.isDirectory) {
          const mediaType = isMediaFileForPreScan(entry.entryName);
          if (mediaType) {
            fileCount++;
            totalBytes += entry.header.size;
            if (mediaType === 'photo') photoCount++;
            else videoCount++;
            
            if (fileCount % 100 === 0) {
              sendProgress();
              await new Promise(resolve => setImmediate(resolve));
            }
          }
        }
      }
    } else {
      const scanDirectory = async (dirPath: string): Promise<void> => {
        if (preScanCancelled) return;
        if (timedOut) return;
        
        // Check timeout at directory entry
        if (Date.now() - startTime > TIMEOUT_MS) {
          timedOut = true;
          sendProgress();
          return;
        }
        
        let entries: fs.Dirent[];
        try {
          // Use async readdir to avoid blocking
          entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        } catch (err) {
          return;
        }
        
        // Yield after directory read to keep UI responsive
        await new Promise(resolve => setImmediate(resolve));
        
        for (const entry of entries) {
          if (preScanCancelled) return;
          if (timedOut) return;
          
          if (Date.now() - startTime > TIMEOUT_MS) {
            timedOut = true;
            sendProgress();
            return;
          }
          
          const fullPath = path.join(dirPath, entry.name);
          
          if (entry.isDirectory()) {
            await scanDirectory(fullPath);
          } else {
            const mediaType = isMediaFileForPreScan(entry.name);
            if (mediaType) {
              fileCount++;
              if (mediaType === 'photo') photoCount++;
              else videoCount++;
              
              try {
                // Use async stat to avoid blocking
                const stats = await fs.promises.stat(fullPath);
                totalBytes += stats.size;
              } catch (err) {
              }
              
              // Yield every 20 files for better UI responsiveness
              if (fileCount % 20 === 0) {
                sendProgress();
                await new Promise(resolve => setImmediate(resolve));
              }
            }
          }
        }
      };
      
      await scanDirectory(sourcePath);
    }
    
    sendProgress();
    
    // Calculate scan speed for time estimates
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    const filesPerSecond = elapsedSeconds > 0 ? fileCount / elapsedSeconds : 0;
    
    return {
      success: true,
      cancelled: preScanCancelled,
      timedOut,
      data: {
        fileCount,
        photoCount,
        videoCount,
        totalBytes,
        scanSpeed: filesPerSecond,
        scanDuration: elapsedSeconds
      }
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

  ipcMain.handle('report:delete', async (_event, reportId: string) => {
    try {
      const success = await deleteReport(reportId);
      return { success };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('analysis:cancel', async () => {
  cancelAnalysis();
  return { success: true };
});

// Source-removal cleanup hook. Called by the renderer when the user
// removes a source from the source menu (or replaces one via Change
// Source). For sources that triggered a pre-extract during analyse
// — large zips and all RARs — this deletes the extracted temp
// directory immediately instead of letting it linger until app
// quit. Without this the user could remove a source they'd already
// analysed but not fixed, and its 50 GB extraction would still sit
// on the C: drive until next launch.
//
// Implementation: temp-dir names are deterministic from the source
// path (md5 of the path + the basename), so we recompute both
// possible names (zip-style and rar-style) and clean any that
// match. Best-effort — never fails the IPC call even if the dir is
// already gone.
// v2.0.11 — orphan-source detection. The renderer calls this on
// Workspace mount with the rehydrated source list. For each archive-
// type source (zip / rar), we check whether its deterministic
// extraction folder still exists. If neither candidate folder exists,
// the source row is an orphan (extraction was deleted or moved) and
// the renderer drops it from localStorage with a toast.
//
// Folder / drive sources are NOT extraction-backed, so they're
// reported as present regardless. A disconnected SOURCE drive (the
// drive holding the original .zip) is also reported as present
// because Fix actually copies from the extraction on the Library
// Drive — not from the original .zip — so an unreachable source
// drive is fine as long as the extraction is there.
ipcMain.handle('analysis:checkExtractionsForSources', async (_event, requests: Array<{ path: string; type: string }>) => {
  if (!Array.isArray(requests)) return { success: false, results: [] };
  const results: Array<{ path: string; hasExtraction: boolean; needsExtraction: boolean }> = [];
  for (const req of requests) {
    if (!req || typeof req.path !== 'string' || req.path.length === 0) {
      results.push({ path: req?.path ?? '', hasExtraction: true, needsExtraction: false });
      continue;
    }
    // v2.0.11 (Terry 2026-05-25) — folder sources: if the source path
    // itself is gone (user moved or deleted the folder outside PDR),
    // treat the row as orphan and drop it on next mount. Same end
    // result as a missing extraction — the source can't be Fixed,
    // there's no good reason to keep it in the menu. User can re-add.
    //
    // Drive sources are deliberately NOT checked here: unplugging an
    // external drive is common + temporary; dropping the row would
    // be too aggressive. The user can manually remove a stale drive
    // row from the Source Menu if they want.
    if (req.type === 'folder') {
      const folderExists = fs.existsSync(req.path);
      results.push({ path: req.path, hasExtraction: folderExists, needsExtraction: !folderExists });
      continue;
    }
    if (req.type !== 'zip' && req.type !== 'rar') {
      results.push({ path: req.path, hasExtraction: true, needsExtraction: false });
      continue;
    }
    // v2.0.11 (Terry 2026-05-25) — check BOTH possible temp roots so a
    // source whose extraction landed on the C: fallback isn't mis-
    // identified as orphan just because the active root is now the
    // Library Drive. Same rationale as cleanupTempDirForSource above.
    const baseName = path.basename(req.path, path.extname(req.path));
    const hashFor = (() => {
      try { return crypto.createHash('md5').update(req.path).digest('hex').substring(0, 8); } catch { return null; }
    })();
    const roots: string[] = [];
    try { roots.push(getCurrentPdrTempRoot()); } catch { /* fall through */ }
    if (!roots.includes(PDR_TEMP_ROOT)) roots.push(PDR_TEMP_ROOT);
    const candidates: string[] = [];
    if (hashFor) {
      const folderName = `${baseName}_${hashFor}`;
      for (const root of roots) candidates.push(path.join(root, folderName));
    }
    try { if (!candidates.includes(generateTempDirName(req.path))) candidates.push(generateTempDirName(req.path)); } catch { /* malformed */ }
    try { if (!candidates.includes(generateRarTempDirName(req.path))) candidates.push(generateRarTempDirName(req.path)); } catch { /* malformed */ }
    let found = false;
    for (const td of candidates) {
      if (activeTempDirs.has(td) || fs.existsSync(td)) { found = true; break; }
    }
    results.push({ path: req.path, hasExtraction: found, needsExtraction: true });
  }
  return { success: true, results };
});

ipcMain.handle('analysis:cleanupTempDirForSource', async (_event, sourcePath: string) => {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    return { success: false, cleaned: 0 };
  }

  // v2.0.11 — if the source we're cleaning is currently mid-extraction,
  // signal the analysis worker to abort BEFORE we wipe the temp folder.
  // Without this, removing a source mid-extract would race the still-
  // running worker writing more files into the folder we just cleaned,
  // leaving an orphan partial folder behind. Cancellation propagates via
  // the cancelAnalysis() flag the engine checks at each iteration; the
  // worker exits cleanly within a step or two. The in-flight slot is
  // also cleared so the LARGE_EXTRACT_IN_FLIGHT gate doesn't keep
  // blocking the next add. Terry's stress test 2026-05-23: removed a
  // 50 GB Takeout mid-extract, the visible source vanished but the
  // worker kept going + the slot stayed claimed, blocking the next add.
  if (largeExtractInFlight && largeExtractInFlight.zipPath === sourcePath) {
    log.info(`[Source remove] cancelling in-flight extraction for ${sourcePath}`);
    try { cancelAnalysis(); } catch (err) {
      log.warn(`[Source remove] cancelAnalysis() failed (non-fatal): ${(err as Error).message}`);
    }
    largeExtractInFlight = null;
  }

  // v2.0.11 — track actual successes vs failures so the renderer can
  // tell the user when a temp dir was LOCKED (Windows Search Indexer,
  // preview pane, AV scanner, etc.) and couldn't be deleted. The old
  // code incremented `cleaned` regardless of cleanupTempDir's actual
  // outcome, which meant the IPC always reported success even when a
  // 50 GB orphan was left on disk. Now: count successes only, return
  // an array of `failedPaths` with reasons so the renderer can toast
  // a clear "still locked — close any open Explorer windows + retry"
  // message instead of silently lying.
  let cleaned = 0;
  // v2.0.11 — sum bytes removed so the renderer can show a single
  // "Reclaimed X GB" toast after a Clear-Sources bulk cleanup (or the
  // sidebar's bulk remove). Measured BEFORE the delete; size probe
  // failures are swallowed and contribute 0 — never blocks the clean.
  let bytesRemoved = 0;
  const failedPaths: Array<{ path: string; reason: string }> = [];

  // v2.0.11 (Terry 2026-05-25) — check BOTH possible temp roots, not
  // just the one PDR currently considers active. An extraction can
  // land on either:
  //   - <LibraryDrive>\PDR_Temp     (preferred when the Lib Drive has
  //                                  enough headroom at extract-time)
  //   - %TEMP%\PDR_Temp             (C: fallback when the Lib Drive
  //                                  doesn't, or when no Lib Drive
  //                                  was configured at extract-time)
  // The active root at CURRENT moment may differ from where this
  // source's extraction actually landed — generateTempDirName /
  // generateRarTempDirName use the current root, so the candidate
  // list they produce is incomplete. Build the full cross-product
  // here so the cleanup hits the extraction wherever it lives.
  const baseName = path.basename(sourcePath, path.extname(sourcePath));
  const hashFor = (() => {
    try { return crypto.createHash('md5').update(sourcePath).digest('hex').substring(0, 8); } catch { return null; }
  })();
  const roots: string[] = [];
  try { roots.push(getCurrentPdrTempRoot()); } catch { /* fall through */ }
  if (!roots.includes(PDR_TEMP_ROOT)) roots.push(PDR_TEMP_ROOT);
  const candidates: string[] = [];
  if (hashFor) {
    const folderName = `${baseName}_${hashFor}`;
    for (const root of roots) {
      candidates.push(path.join(root, folderName));
    }
  }
  // Also include whatever generateTempDirName / generateRarTempDirName
  // produce against the current root (covers any divergence between
  // the inline reconstruction above and the canonical helpers).
  try { if (!candidates.includes(generateTempDirName(sourcePath))) candidates.push(generateTempDirName(sourcePath)); } catch { /* malformed */ }
  try { if (!candidates.includes(generateRarTempDirName(sourcePath))) candidates.push(generateRarTempDirName(sourcePath)); } catch { /* malformed */ }

  for (const td of candidates) {
    if (activeTempDirs.has(td)) {
      let sizeBytes = 0;
      try { sizeBytes = await asyncFolderSizeBytes(td); } catch { /* ignore */ }
      const result = await cleanupTempDir(td);
      if (result.ok) {
        activeTempDirs.delete(td);
        cleaned++;
        bytesRemoved += sizeBytes;
      } else {
        failedPaths.push({ path: td, reason: result.reason ?? 'unknown' });
      }
    } else if (fs.existsSync(td)) {
      // Edge case: dir exists but isn't tracked (e.g. left over from
      // a prior session that didn't clean up cleanly). Reap it
      // anyway so the user gets the disk space back.
      let sizeBytes = 0;
      try { sizeBytes = await asyncFolderSizeBytes(td); } catch { /* ignore */ }
      const result = await cleanupTempDir(td);
      if (result.ok) {
        cleaned++;
        bytesRemoved += sizeBytes;
      } else {
        failedPaths.push({ path: td, reason: result.reason ?? 'unknown' });
      }
    }
  }
  if (cleaned > 0) {
    console.log(`[Source remove] Cleaned up ${cleaned} extracted temp dir${cleaned === 1 ? '' : 's'} for source: ${sourcePath} — freed ${(bytesRemoved / (1024 ** 3)).toFixed(2)} GB`);
  }
  if (failedPaths.length > 0) {
    log.warn(`[Source remove] ${failedPaths.length} temp dir(s) failed to remove for ${sourcePath}: ${failedPaths.map(f => f.path).join(', ')}`);
  }
  return { success: true, cleaned, bytesRemoved, failedPaths };
});

// Workspace-empty orphan sweep. Called by the renderer on mount when
// the source list is empty (localStorage.pdr-sources has 0 entries).
// Logic: if the user's workspace is empty, anything sitting in
// PDR_Temp is by definition an orphan — there's no source row that
// could ever reconcile it. The most common cause is a Takeout pre-
// extraction that crashed mid-way (Jane 2026-05-21: ~21.5 GB of
// orphaned extract from a May 18 crash, blocked her next Takeout
// from being added because the 55 GB cap counted the orphans).
//
// Sweeps BOTH potential roots:
//   - PDR_TEMP_ROOT (=%TEMP%\PDR_Temp), the legacy / fallback path
//   - getCurrentPdrTempRoot() (=<destinationDrive>\PDR_Temp), the
//     v2.0.0 default for extracted ZIP/RAR sources
//
// Safety: the renderer only calls this when sources.length === 0
// AND it's the first mount, so we can't race with an in-flight
// extraction (which would have already added a source row by the
// time it pre-extracts).
// Pre-flight library-drive readiness check. Called by the renderer on
// Workspace mount. Wakes the configured library drive (mkdir on its
// PDR_Temp directory) then probes for free space. Returns
// { ready, destinationPath, freeBytes, totalBytes }. The renderer
// surfaces a banner if !ready so the user knows to wake / reconnect
// the drive BEFORE trying to add a source — Jane 2026-05-21's silent-
// fallback case caught at the entry point instead of mid-workflow.
//
// Non-blocking by design: if no destinationPath is set, or the drive
// has never been configured, returns ready=true with destinationPath=null
// (nothing to check). Terry 2026-05-21: "we don't want the app to stop
// working just because an old library doesn't answer back."
ipcMain.handle('analysis:probeLibraryDrive', async () => {
  // Same precedence as the analysis:run handler and LibraryPanel:
  // libraryRoot (live attach) wins over settings.destinationPath
  // (legacy persisted) when they diverge.
  let destinationPath: string | null = null;
  try {
    const status = getLibraryStatus();
    if (status?.libraryRoot && typeof status.libraryRoot === 'string') {
      destinationPath = status.libraryRoot;
    }
  } catch { /* status unreadable — fall through */ }
  if (!destinationPath) {
    try { destinationPath = getSettings()?.destinationPath ?? null; } catch { /* settings unreadable */ }
  }
  if (!destinationPath) {
    return { ready: true, destinationPath: null, freeBytes: null, totalBytes: null };
  }
  if (!isLocalDir(destinationPath)) {
    return { ready: true, destinationPath, freeBytes: null, totalBytes: null };
  }
  // Wake the drive via mkdir, then probe. We deliberately use a
  // hidden `.pdr-wake` folder rather than PDR_Temp so the launch-time
  // orphan-sweep (which permanently deletes PDR_Temp when the
  // workspace is empty) doesn't end up in a race with this probe
  // recreating PDR_Temp behind it. The wake folder is cleaned up
  // immediately after the probe completes — it's purely a wake-up
  // signal, not a persistent artefact.
  const wakeDir = path.join(destinationPath, '.pdr-wake');
  try {
    fs.mkdirSync(wakeDir, { recursive: true });
  } catch (err) {
    log.warn(`[probe-library] mkdir wake failed on ${destinationPath}: ${(err as Error).message}`);
  }
  let space = getDiskSpaceForDirSync(destinationPath);
  if (space === null) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    space = getDiskSpaceForDirSync(destinationPath);
    if (space !== null) {
      log.info(`[probe-library] ${destinationPath} probe succeeded on retry after 1.5s delay`);
    }
  }
  // Clean up the wake folder — we don't need a persistent artefact on
  // the user's drive just because we probed.
  try {
    fs.rmSync(wakeDir, { recursive: true, force: true });
  } catch { /* best-effort cleanup */ }

  const ready = space !== null;
  if (!ready) {
    log.warn(`[probe-library] ${destinationPath} probe failed both attempts — drive likely asleep or unplugged`);
  }
  return {
    ready,
    destinationPath,
    freeBytes: space?.freeBytes ?? null,
    totalBytes: space?.totalBytes ?? null,
  };
});

ipcMain.handle('analysis:sweepOrphanedTempDirsIfEmpty', async (_event, opts?: { looseFilesOnly?: boolean; keepPaths?: string[] }) => {
  // Three modes (latest one is the v2.0.11 default from the renderer):
  //   smart (keepPaths provided) — full sweep, but preserve any sub-
  //           folder whose name matches a deterministic temp-dir name
  //           derived from one of the user's persisted source paths.
  //           This deletes loose files AND orphan sub-folders, while
  //           leaving in-flight extractions belonging to current
  //           Source Menu entries untouched. Terry 2026-05-24's
  //           "C: orphan still there" symptom — the previous
  //           looseFilesOnly mode skipped ALL sub-folders even when
  //           we knew which ones were orphan.
  //   full  — workspace was empty at launch, so everything in PDR_Temp
  //           is an orphan. Delete files AND sub-folders.
  //   looseFilesOnly — legacy fallback for callers that haven't been
  //           upgraded to pass keepPaths. Skips ALL sub-folders.
  //
  // ALL filesystem work below is async (fs.promises.*). The previous
  // sync version blocked the main process for several seconds while
  // deleting tens of thousands of files, which left the title-bar
  // overlay unresponsive and the window non-draggable. Async I/O runs
  // on libuv's worker pool so the main thread stays responsive to
  // window messages throughout.
  const looseFilesOnly = !!opts?.looseFilesOnly;
  const keepPaths = Array.isArray(opts?.keepPaths) ? opts!.keepPaths! : [];
  // Build the set of basenames we should preserve (matching against
  // the entry name inside PDR_Temp). Each persisted source path maps
  // to BOTH a zip-style and a rar-style temp-dir candidate; we keep
  // either if it matches an on-disk entry.
  const keepNames = new Set<string>();
  for (const p of keepPaths) {
    if (typeof p !== 'string' || p.length === 0) continue;
    try { keepNames.add(path.basename(generateTempDirName(p))); } catch { /* malformed */ }
    try { keepNames.add(path.basename(generateRarTempDirName(p))); } catch { /* malformed */ }
  }
  const mode = keepNames.size > 0
    ? `smart (keeping ${keepNames.size} extractions)`
    : looseFilesOnly ? 'loose-files-only' : 'full';

  const roots = new Set<string>();
  roots.add(PDR_TEMP_ROOT);
  try {
    const currentRoot = getCurrentPdrTempRoot();
    if (currentRoot) roots.add(currentRoot);
  } catch { /* settings unreadable — only %TEMP% root counts */ }

  log.info(`[orphan-sweep] invoked — mode=${mode}, roots: ${Array.from(roots).join(', ')}`);

  let dirsRemoved = 0;
  let bytesRemoved = 0;
  // v2.0.11 — accumulate failures so the renderer can surface them
  // via toast on launch. Previously the sweep silently swallowed
  // EBUSY errors (Windows Search Indexer / preview pane / AV holds
  // a file handle) and the user only discovered the persistent
  // orphan later via a cap-refused source-add. Terry's case
  // 2026-05-23: 49.9 GB orphan from yesterday survived two sweep
  // attempts because an MP4 file inside was locked.
  const failedPaths: Array<{ path: string; reason: string }> = [];
  for (const root of roots) {
    try {
      await fs.promises.access(root);
    } catch {
      log.info(`[orphan-sweep] root does not exist, skipping: ${root}`);
      continue;
    }
    let entries: import('fs').Dirent[] = [];
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch (err) {
      log.warn(`[orphan-sweep] failed to read ${root}: ${(err as Error).message}`);
      continue;
    }
    log.info(`[orphan-sweep] ${root} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} to inspect`);
    let rootRemoved = 0;
    let rootSkipped = 0;
    let rootBytes = 0;
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      // Smart mode: keep entries whose names match a known extraction
      // for a persisted source. Loose files (no extension match) get
      // deleted; orphan sub-folders get deleted. Only "this is an
      // active extraction I know about" entries are preserved.
      if (entry.isDirectory() && keepNames.has(entry.name)) {
        rootSkipped++;
        continue;
      }
      // Legacy loose-files-only mode (no keepPaths supplied): skip
      // every directory unconditionally.
      if (keepNames.size === 0 && looseFilesOnly && entry.isDirectory()) {
        rootSkipped++;
        continue;
      }
      try {
        // Measure size before removal so we can report bytes freed.
        // Best-effort — a stat failure doesn't block the delete.
        if (entry.isDirectory()) {
          rootBytes += await asyncFolderSizeBytes(full);
        } else {
          try { rootBytes += (await fs.promises.stat(full)).size; } catch { /* ignore */ }
        }
        await fs.promises.rm(full, { recursive: true, force: true });
        dirsRemoved++;
        rootRemoved++;
      } catch (err) {
        const reason = (err as Error).message;
        log.warn(`[orphan-sweep] failed to remove ${full}: ${reason}`);
        failedPaths.push({ path: full, reason });
      }
    }
    bytesRemoved += rootBytes;
    const skippedSuffix = rootSkipped > 0 ? ` (skipped ${rootSkipped} active extraction${rootSkipped === 1 ? '' : 's'})` : '';
    log.info(`[orphan-sweep] ${root} — removed ${rootRemoved}/${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${skippedSuffix}, freed ${(rootBytes / (1024 ** 3)).toFixed(2)} GB`);

    // Remove the now-empty PDR_Temp folder itself ONLY when we kept
    // nothing inside it. If any active extraction (or legacy loose-
    // files-only sub-folder) remains, leave the parent in place.
    if (rootSkipped === 0) {
      try {
        await fs.promises.rm(root, { recursive: true, force: true });
        log.info(`[orphan-sweep] ${root} — removed PDR_Temp folder itself`);
      } catch (err) {
        const reason = (err as Error).message;
        log.warn(`[orphan-sweep] failed to remove PDR_Temp root ${root}: ${reason}`);
        // Only count the root failure if nothing inside also failed
        // (would be a duplicate signal otherwise — the inner-file
        // failure is the actionable thing).
        if (!failedPaths.some(f => f.path.startsWith(root))) {
          failedPaths.push({ path: root, reason });
        }
      }
    }
  }
  log.info(`[orphan-sweep] done — ${dirsRemoved} entr${dirsRemoved === 1 ? 'y' : 'ies'} removed total, ${(bytesRemoved / (1024 ** 3)).toFixed(2)} GB freed, ${failedPaths.length} locked`);
  return { success: true, dirsRemoved, bytesRemoved, failedPaths };
});

/**
 * Async sibling of folderSizeBytes — same recursive byte-sum, but
 * uses fs.promises so we don't block the main thread when measuring
 * a multi-GB PDR_Temp tree before deletion.
 */
async function asyncFolderSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: import('fs').Dirent[] = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await asyncFolderSizeBytes(full);
      } else {
        total += (await fs.promises.stat(full)).size;
      }
    } catch { /* skip unstatable entries */ }
  }
  return total;
}

ipcMain.handle('analysis:run', async (_event, sourcePath: string, sourceType: 'folder' | 'zip' | 'drive', tempDirOverride?: string) => {
  // v2.0.11 (Terry 2026-05-25) — timing markers so the residual ~2s
  // "Not Responding" flash at analyse-start can be diagnosed from the
  // log. Each phase stamped against the IPC entry time so we can see
  // which step is dominant: pre-extract decision, worker claim, the
  // extract itself, analyzeSource, etc.
  const __runT0 = Date.now();
  const __stamp = (label: string) => log.info(`[analysis:run timing] ${label} +${Date.now() - __runT0}ms`);
  __stamp('IPC entry');
  let tempDir: string | null = null;
  let claimedExtractInFlight = false;

  // Effective Library Drive path — same precedence the LibraryPanel
  // uses for its "active drive" display:
  //   1. getLibraryStatus().libraryRoot   (live attach state — most
  //      authoritative; updated by attachAsNew / attachFromSidecar)
  //   2. getSettings().destinationPath    (legacy, persisted setting)
  // These two can diverge when an LDM action updates the live attach
  // but doesn't sync settings.destinationPath. Terry's case 2026-05-22:
  // LDM showed D:\... as active but settings.destinationPath was null,
  // so source-add saw "no Library Drive" and refused with NO_TEMP_SPACE
  // against the C: fallback. Reading libraryRoot first closes the gap.
  const resolveEffectiveDestination = (): string | null => {
    try {
      const status = getLibraryStatus();
      if (status?.libraryRoot && typeof status.libraryRoot === 'string') {
        return status.libraryRoot;
      }
    } catch { /* status unreadable — fall through */ }
    try {
      return getSettings()?.destinationPath ?? null;
    } catch { return null; }
  };

  // Drive-details diagnostic — logged on EVERY source-add regardless
  // of outcome (success OR failure), so we always have the full
  // drive picture for support tickets. Terry 2026-05-21: "Drive
  // details are integral to our analysis."
  //
  // v2.0.11 (Terry 2026-05-25) — DEFERRED via setImmediate. The
  // getDiskSpaceForDirSync helper runs PowerShell via execSync with
  // a 10 s timeout per call. Three calls (source + destination +
  // %TEMP%) easily add up to 10+ seconds of main-thread block when
  // a drive is sleeping. This was the dominant cost in Terry's
  // 11.8 s analyse-start freeze (logged via the timing markers).
  // The diagnostic block is purely informational — its results
  // aren't consumed by the rest of analysis:run — so deferring it
  // off the critical path is a free win. The log line still
  // appears, just slightly later.
  setImmediate(async () => {
    try {
      const settingsForDiag = (() => { try { return getSettings(); } catch { return null; } })();
      const statusForDiag = (() => { try { return getLibraryStatus(); } catch { return null; } })();
      const destPathForDiag = resolveEffectiveDestination();
      const gbDiag = (b: number | null | undefined): string =>
        (b == null) ? 'null' : `${(b / (1024 ** 3)).toFixed(2)}GB`;
      const driveOf = (p: string | null): string => {
        if (!p || p.length < 2 || p[1] !== ':') return 'unknown';
        return p.substring(0, 2).toUpperCase();
      };
      const srcLocal = isLocalDir(sourcePath);
      const destLocalDiag = isLocalDir(destPathForDiag);
      // v2.0.11 (Terry 2026-05-25) — async + parallel. Was three
      // execSync PowerShell calls (10 s timeout each); even after
      // deferring via setImmediate, those sync execs blocked the
      // main thread during the user's analyse-start window. Now
      // each probe uses the async getDiskSpaceForDir and all three
      // run concurrently via Promise.all — total time = max instead
      // of sum, AND each await yields to the event loop so the OS
      // message pump runs throughout.
      const [srcSpace, destSpaceDiag, tempSpaceDiag] = await Promise.all([
        srcLocal ? getDiskSpaceForDir(sourcePath) : Promise.resolve(null),
        (destPathForDiag && destLocalDiag) ? getDiskSpaceForDir(destPathForDiag) : Promise.resolve(null),
        getDiskSpaceForDir(PDR_TEMP_ROOT),
      ]);
      log.info(
        `[source-add] sourcePath=${JSON.stringify(sourcePath)} sourceType=${sourceType} ` +
        `srcDrive=${driveOf(sourcePath)} srcLocal=${srcLocal} ` +
        `srcFree=${gbDiag(srcSpace?.freeBytes)} srcTotal=${gbDiag(srcSpace?.totalBytes)} ` +
        `destPath=${JSON.stringify(destPathForDiag)} destDrive=${driveOf(destPathForDiag)} ` +
        `destLocal=${destLocalDiag} ` +
        `destFree=${gbDiag(destSpaceDiag?.freeBytes)} destTotal=${gbDiag(destSpaceDiag?.totalBytes)} ` +
        `tempDrive=${driveOf(PDR_TEMP_ROOT)} ` +
        `tempFree=${gbDiag(tempSpaceDiag?.freeBytes)} tempTotal=${gbDiag(tempSpaceDiag?.totalBytes)} ` +
        `libRoot=${JSON.stringify(statusForDiag?.libraryRoot ?? null)} ` +
        `settingsDest=${JSON.stringify(settingsForDiag?.destinationPath ?? null)}`
      );
    } catch (logErr) {
      log.warn(`[source-add] drive-detail logging failed: ${(logErr as Error).message}`);
    }
  });

  try {
    // Destination-online precheck. v2.0.x bug Terry reproduced
    // 2026-05-13: PDR remembers the Library Drive path in settings
    // across sessions, but never verifies the drive is actually
    // mounted before kicking off operations that write to it.
    // Result: if the user opens PDR with their Library Drive
    // unplugged (or with a path remembered from a previous USB
    // that's gone), analysis:run proceeds, eventually calls
    // fs.mkdirSync('<missing-drive>:\\...\\PDR_Temp\\...') and
    // surfaces a cryptic 'ENOENT: no such file or directory, mkdir
    // ...takeout-...' that confused Jane for days. Catch it here
    // with a clean structured error code so the renderer can drive
    // a calm modal ("Library Drive isn't connected — Retry / Change
    // Library Drive") instead of leaking the raw ENOENT.
    try {
      const destinationPath = resolveEffectiveDestination();
      // NO_LIBRARY_DRIVE precheck — v2.0.11 hotfix.
      //
      // Pre-v2.0.11, if no Library Drive was configured (both
      // libraryRoot AND settings.destinationPath null), source-add
      // silently routed the extraction to %TEMP% on C: as a "fallback".
      // This was a disaster for users whose library config had been
      // lost (the cascade bug, a failed re-attach, etc.) — they'd
      // think their library was attached (the LDM display might still
      // show their drive listed), but PDR would silently extract
      // tens of GB to C:, the analyse step would fail with no
      // destination to write to, the source would disappear from the
      // menu without explanation, and the user would have no idea
      // what went wrong. Jane chased this for two weeks.
      //
      // Now: refuse source-add outright when no Library Drive is
      // configured. Renderer surfaces a clear modal pointing the user
      // to LDM to attach one. Genuine first-time-user flow still
      // works because the Welcome → Library Planner → DDA path attaches
      // a Library Drive BEFORE the user ever reaches a state where
      // they could add a source.
      if (!destinationPath) {
        throw Object.assign(
          new Error("No Library Drive is set. Open Library Drive Manager to attach one before adding sources."),
          { code: 'NO_LIBRARY_DRIVE' },
        );
      }
      if (destinationPath && !fs.existsSync(destinationPath)) {
        throw Object.assign(
          new Error(`Library Drive at ${destinationPath} isn't connected.`),
          { code: 'DESTINATION_OFFLINE', destinationPath },
        );
      }
    } catch (precheckErr: any) {
      if (precheckErr?.code === 'DESTINATION_OFFLINE' || precheckErr?.code === 'NO_LIBRARY_DRIVE') {
        throw precheckErr;
      }
      // Anything else in the precheck (settings read failure, etc.)
      // we swallow and let the regular flow proceed — defensive
      // belt rather than a hard gate.
    }

    // Hard one-large-zip-at-a-time gate. Two concurrent pre-extracts
    // can flood a single drive in minutes; this refuses the second
    // one at the IPC layer so the renderer can show a friendly
    // "wait for the current job to finish" prompt instead of a
    // disk-full crash. Smaller (<2 GB) zips, folders, and drives go
    // through the streaming path and aren't gated.
    const isLargeZip = sourceType === 'zip' && !isRarFile(sourcePath)
      && getZipFileSize(sourcePath) > LARGE_ZIP_THRESHOLD
      && !((() => { try { return getSettings().bypassLargeZipPreExtract === true; } catch { return false; } })());
    if (isLargeZip && largeExtractInFlight && largeExtractInFlight.zipPath !== sourcePath) {
      throw Object.assign(
        new Error(`Another large zip is currently being unpacked. Wait for "${path.basename(largeExtractInFlight.zipPath)}" to finish before starting "${path.basename(sourcePath)}".`),
        { code: 'LARGE_EXTRACT_IN_FLIGHT', currentZip: path.basename(largeExtractInFlight.zipPath), startedAt: largeExtractInFlight.startedAt },
      );
    }

    // 55 GiB pre-extract cap — bounds the total disk PDR can consume
    // with un-fixed extracted sources. Triggers when adding ANOTHER
    // large ZIP or any RAR (both pre-extract paths) would push the
    // sum past EXTRACTION_CAP_BYTES. Folders and small (< 2 GiB)
    // ZIPs don't extract, so they bypass this gate entirely.
    //
    // Skipped when tempDirOverride is supplied — that's the smart-
    // prompt fallback path where the user has already explicitly
    // picked a different drive and accepted that it has the space.
    const willPreExtract = (isLargeZip || (sourceType === 'zip' && isRarFile(sourcePath))) && !tempDirOverride;
    if (willPreExtract) {
      const pendingBytes = getPendingExtractionBytes();
      const incomingBytes = getZipFileSize(sourcePath);
      if (pendingBytes + incomingBytes > EXTRACTION_CAP_BYTES) {
        const fmtGB = (n: number) => (n / (1024 * 1024 * 1024)).toFixed(1);
        // v2.0.11 — include the actual PDR_Temp path the cap is measuring
        // against so the user knows where to look if they want to
        // investigate or manually free space. Pre-v2.0.11 the message
        // just dumped numbers ("Currently using 49.9 GB") with no way
        // for the user to find or act on the files. Terry's stress
        // test 2026-05-23: the missing path was the reason he had to
        // hunt through Explorer to figure out where his 49.9 GB was
        // sitting.
        const tempRoots: string[] = [];
        try {
          const currentRoot = getCurrentPdrTempRoot();
          if (currentRoot) tempRoots.push(currentRoot);
        } catch { /* settings unreadable */ }
        // Always mention the %TEMP% fallback too in case files are
        // also there from a previous library-drive-offline session.
        if (!tempRoots.some(r => path.normalize(r).toLowerCase() === path.normalize(PDR_TEMP_ROOT).toLowerCase())) {
          tempRoots.push(PDR_TEMP_ROOT);
        }
        const pathHint = tempRoots.length === 1
          ? `Extracted files are in ${tempRoots[0]}.`
          : `Extracted files live in: ${tempRoots.map(r => `"${r}"`).join(' and ')}.`;
        throw Object.assign(
          new Error(
            `PDR keeps up to ${fmtGB(EXTRACTION_CAP_BYTES)} GB of extracted source archives at once. ` +
            `Currently using ${fmtGB(pendingBytes)} GB; this source would add ${fmtGB(incomingBytes)} GB. ` +
            `${pathHint} ` +
            `Run the fix on what you've already added to free space, then come back to add more.`,
          ),
          {
            code: 'EXTRACTION_CAP_REACHED',
            pendingBytes,
            incomingBytes,
            capBytes: EXTRACTION_CAP_BYTES,
            tempRoots,
          },
        );
      }
    }

    let effectivePath = sourcePath;
    let effectiveType = sourceType;

    // Auto-extract RAR archives (always) or large ZIPs (>2 GB)
    if (sourceType === 'zip' && isRarFile(sourcePath)) {
      tempDir = generateRarTempDirName(sourcePath);
      activeTempDirs.add(tempDir);

      mainWindow?.webContents.send('analysis:progress', {
        current: 0,
        total: 0,
        currentFile: 'Unpacking RAR archive — this may take a moment for large files. Your originals are untouched.',
        phase: 'scanning'
      });

      await extractRar(sourcePath, tempDir, (message, current, total) => {
        mainWindow?.webContents.send('analysis:progress', {
          current: current || 0,
          total: total || 0,
          currentFile: message,
          phase: 'scanning'
        });
      });

      effectivePath = tempDir;
      effectiveType = 'folder';
    } else if (isLargeZip) {
      // Pick a temp location BEFORE we mark the extract as in-flight,
      // so a refusal doesn't poison the gate for the next call.
      // tempDirOverride lets the renderer's smart-prompt modal hand
      // back a user-picked drive after a previous attempt failed
      // with NO_TEMP_SPACE — when supplied, we trust it and skip the
      // resolver (which would otherwise refuse for the same reason).
      let chosenTempDir: string;
      let chosenLabel: string;
      if (tempDirOverride) {
        const baseDir = path.join(tempDirOverride, 'PDR_Temp');
        chosenTempDir = path.join(baseDir, path.basename(generateTempDirName(sourcePath)));
        chosenLabel = `user-picked temp dir (${tempDirOverride})`;
      } else {
        __stamp('before pickPreExtractDir');
        const decision = await pickPreExtractDir(sourcePath, resolveEffectiveDestination());
        __stamp('after pickPreExtractDir');
        if (!decision.ok) {
          // Surface a structured error so the renderer can drive a
          // smart-prompt modal. Two refusal modes:
          //   - LIBRARY_DRIVE_UNREACHABLE — Library Drive is set but
          //     PDR can't reach it (USB unplugged, sleep state, NTFS
          //     probe failed). Renderer shows a "reconnect your
          //     Library Drive" modal naming the path. Added v2.0.8
          //     after Jane's silent-fallback case where PDR routed
          //     to %TEMP% with no message because the disk-space
          //     probe on her USB Seagate returned null.
          //   - NO_SPACE — both temp + destination options checked
          //     and neither had enough room. Renderer shows the
          //     existing smart-prompt picker so the user can pick a
          //     different temp drive.
          if (decision.errorCode === 'LIBRARY_DRIVE_UNREACHABLE') {
            // Reuse the existing DESTINATION_OFFLINE IPC code so the
            // renderer's LibraryOfflineModal handler picks this up —
            // same user experience as the upstream fs.existsSync
            // precheck. The pre-extract diagnostic log line still
            // names the specific check that fired
            // (reason="LIBRARY_DRIVE_UNREACHABLE") so future debugging
            // can distinguish the two failure modes.
            throw Object.assign(
              new Error(`PDR can't reach your Library Drive (${decision.destinationPath}). Reconnect it before adding sources.`),
              {
                code: 'DESTINATION_OFFLINE',
                destinationPath: decision.destinationPath,
                zipPath: sourcePath,
              },
            );
          }
          throw Object.assign(
            new Error('Not enough disk space to unpack this zip safely.'),
            {
              code: 'NO_TEMP_SPACE',
              neededBytes: decision.neededBytes,
              destinationPath: decision.destinationPath,
              destinationLocal: decision.destinationLocal,
              destinationFreeBytes: decision.destinationFreeBytes,
              tempFreeBytes: decision.tempFreeBytes,
              zipPath: sourcePath,
            },
          );
        }
        chosenTempDir = decision.tempDir;
        chosenLabel = decision.chosenLabel;
      }

      tempDir = chosenTempDir;
      activeTempDirs.add(tempDir);
      largeExtractInFlight = { zipPath: sourcePath, tempDir, startedAt: Date.now() };
      claimedExtractInFlight = true;

      // (Detailed [Pre-extract] log line is now emitted inside
      // pickPreExtractDir itself, including all decision inputs.
      // Duplicate console.log removed — v2.0.8.)

      // Notify renderer about the extraction
      mainWindow?.webContents.send('analysis:progress', {
        current: 0,
        total: 0,
        currentFile: 'This Google Takeout is large — PDR is unpacking it temporarily so it can analyse your photos safely. Originals are untouched.',
        phase: 'scanning'
      });

      // v2.0.11 (Terry 2026-05-24) — large-zip extraction runs in a
      // utilityProcess (electron/extract-worker.ts) so the main
      // browser thread can't be blocked by the 18k+ per-entry
      // mkdirSync + unzipper's central-directory parse. Was the
      // source of "Not Responding" at the start of a 50 GB Takeout
      // analyse. Worker streams progress messages back, we forward
      // them to the renderer, and we await the done signal before
      // continuing to analyzeSource. Same cancellation contract:
      // analysis:cancel sets isAnalysisCancelled() which we poll
      // here and post a 'cancel' message to the worker.
      __stamp('before runExtractInWorker');
      await runExtractInWorker(sourcePath, tempDir, (message, current, total) => {
        mainWindow?.webContents.send('analysis:progress', {
          current: current || 0,
          total: total || 0,
          currentFile: message,
          phase: 'scanning'
        });
      });

      // Analyse the extracted folder instead of the ZIP
      effectivePath = tempDir;
      effectiveType = 'folder';
    }
    
    __stamp('before analyzeSource');
    // v2.0.14 (Terry 2026-05-27) — runs analyzeSource in a utility-
    // process worker so the heavy per-file CPU work doesn't block the
    // main browser thread. Renderer-facing IPC contract unchanged —
    // progress + diagnostic still arrive on the same channels.
    const results = await runAnalysisInWorker(
      effectivePath,
      effectiveType,
      (progress) => {
        mainWindow?.webContents.send('analysis:progress', progress);
      },
      (msg) => {
        mainWindow?.webContents.send('analysis:diagnostic', msg);
      },
    );
    
    // Preserve original source path in the results so copy phase knows where to find the ZIP
    if (tempDir) {
      results.sourcePath = sourcePath;
      results.sourceType = 'zip';
      (results as any)._extractedTempDir = tempDir;
    }
    
    // NOTE: Do NOT clean up temp dir here — the extracted files are needed
    // during the copy/fix phase. Cleanup happens in `files:copy` on
    // successful completion (right before the success return), and as
    // a safety net at app quit (`before-quit`) and at next app startup
    // (`cleanupOrphanedTempDirs`). Without the post-copy cleanup, a user
    // analysing + fixing 8 sequential 50 GB Google Takeouts in one
    // session would accumulate ~400 GB of extracted payload on their
    // C: drive — which can fill modest drives and was the disaster
    // scenario flagged in customer crash reports.
    
    return { success: true, data: results };
  } catch (error: any) {
    // Clean up temp dir on failure (fire-and-forget — error return is
    // what the caller cares about; the deletion happens in the worker).
    if (tempDir) {
      void cleanupTempDir(tempDir).catch(() => { /* best-effort */ });
      activeTempDirs.delete(tempDir);
    }

    if ((error as Error).message === 'ANALYSIS_CANCELLED') {
      return { success: false, cancelled: true, error: 'Analysis cancelled by user' };
    }

    // Pass structured codes through to the renderer so it can route
    // to the right modal (NO_TEMP_SPACE → smart-prompt picker,
    // LARGE_EXTRACT_IN_FLIGHT → "wait for current job" modal).
    if (error && typeof error === 'object' && error.code) {
      return {
        success: false,
        error: (error as Error).message,
        code: error.code,
        details: {
          neededBytes: error.neededBytes,
          destinationPath: error.destinationPath,
          destinationLocal: error.destinationLocal,
          destinationFreeBytes: error.destinationFreeBytes,
          tempFreeBytes: error.tempFreeBytes,
          zipPath: error.zipPath,
          currentZip: error.currentZip,
          startedAt: error.startedAt,
        },
      };
    }
    return { success: false, error: (error as Error).message };
  } finally {
    // Release the one-large-zip gate even if extraction failed —
    // otherwise a single failed extract permanently blocks all future
    // pre-extracts in the session.
    if (claimedExtractInFlight) {
      largeExtractInFlight = null;
    }
  }
});

function calculateFileHashAsync(filePath: string, timeoutMs = 30000): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[Hash] Timeout hashing ${path.basename(filePath)} after ${timeoutMs}ms`);
      stream.destroy();
      resolve(null);
    }, timeoutMs);
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => { clearTimeout(timer); resolve(hash.digest('hex')); });
    stream.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

function calculateBufferHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

ipcMain.handle('report:save', async (_event, reportData: Omit<FixReport, 'id' | 'timestamp'>) => {
  // v2.0.15 (Terry 2026-05-30) — fix-end freeze diagnostics. Times
  // each phase so we can pinpoint what's blocking main between Fix
  // Complete modal appearing and the chime/toast firing. Grep
  // main.log for [fix-end-trace] to read the timeline.
  const t0 = Date.now();
  const trace = (label: string, since: number) => console.log(`[fix-end-trace] ${label}: ${Date.now() - since}ms`);
  try {
    const tSave = Date.now();
    const savedReport = await saveReport(reportData);
    trace('saveReport', tSave);

    // Auto-catalogue: write cumulative PDR_Catalogue.csv/txt to
    // destination root. v2.0.15 (Terry 2026-05-30) — fire-and-forget
    // via the catalogue-worker utility process. The renderer no
    // longer waits for this; the chime + Fix Complete modal fire
    // instantly. Worker uses per-report chunk caching so subsequent
    // Fixes regenerate only the new chunk (~500ms vs 7s).
    const settings = getSettings();
    if (settings.autoSaveCatalogue && savedReport.destinationPath) {
      void spawnCatalogueWorker(savedReport.destinationPath).catch((err) => {
        console.error('[Catalogue] worker spawn failed (non-fatal):', err);
      });
    } else {
      console.log('[Catalogue] Skipped — setting off or no destination');
    }

    trace('report:save TOTAL', t0);
    return { success: true, data: savedReport };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

// v2.0.15 (Terry 2026-05-30) — spawn the catalogue-worker utility
// process and forget. Returns once the worker is dispatched (not when
// it finishes), so the calling IPC handler can return immediately and
// the Fix Complete modal renders without blocking on minutes of CSV
// building.
async function spawnCatalogueWorker(destinationPath: string): Promise<void> {
  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, 'dist-electron/catalogue-worker.cjs')
    : path.join(__dirname, 'catalogue-worker.cjs');
  if (!fs.existsSync(workerPath)) {
    console.warn('[Catalogue] worker file missing — skipping background catalogue regen');
    return;
  }
  // v2.0.15 (Terry 2026-05-31) — path was 'pdr-reports' which the
  // catalogue worker logged as 'Reports dir not found' after every
  // Fix. Real reports live in 'fix-reports' (see
  // report-storage.ts:getReportsDirectory). One-line typo fix —
  // catalogues are now regenerated correctly post-Fix.
  const reportsDir = path.join(app.getPath('userData'), 'fix-reports');
  const tSpawn = Date.now();
  let w: Electron.UtilityProcess;
  try {
    w = utilityProcess.fork(workerPath, [], {
      serviceName: 'PDR Catalogue Worker',
      stdio: 'pipe',
      env: workerEnv(),
    });
  } catch (forkErr) {
    console.error('[Catalogue] worker fork failed:', forkErr);
    return;
  }
  w.stdout?.on('data', (chunk: Buffer) => log.info(`[catalogue-worker stdout] ${chunk.toString().trim()}`));
  w.stderr?.on('data', (chunk: Buffer) => log.warn(`[catalogue-worker stderr] ${chunk.toString().trim()}`));
  w.on('message', (msg: unknown) => {
    const m = msg as { type?: string; success?: boolean; error?: string };
    if (m?.type === 'ready') {
      w.postMessage({ type: 'run', destinationPath, reportsDir });
    } else if (m?.type === 'done') {
      log.info(`[Catalogue] worker done in ${Date.now() - tSpawn}ms — success=${m.success}${m.error ? `, error=${m.error}` : ''}`);
      try { w.kill(); } catch { /* best-effort */ }
    }
  });
  w.on('exit', (code) => {
    log.info(`[Catalogue] worker exited code=${code}`);
  });
}

// Scan destination for existing files and their hashes (for cross-run duplicate detection)
ipcMain.handle('destination:prescan', async (_event, destinationPath: string) => {
  try {
    console.log(`[Prescan] Starting destination prescan: ${destinationPath}`);
    const prescanStart = Date.now();
    const settings = getSettings();
    // v2.0.13 (Terry 2026-05-26) — asymmetry fix. Pre-v2.0.13 this read
    // `useHash = settings.thoroughDuplicateMatching` directly, which
    // disagreed with the copy loop's "hash unless network/cloud" rule
    // a few hundred lines below. With the toggle OFF (the default) the
    // copy loop hashed every file it copied but the prescan only built
    // heuristic entries — so the hash comparisons had nothing to match
    // against and cross-run hash dedup silently didn't work for anyone
    // who hadn't enabled the toggle.
    //
    // The right policy is "hash unless reading from a slow source":
    //   - Toggle ON  → force hash everywhere (power-user)
    //   - Toggle OFF → hash if destination is local; heuristic if it's
    //                  a network share or cloud-sync folder (where the
    //                  per-file read cost would dominate).
    //
    // This matches the copy-loop rule applied to whichever side is
    // being read (source there, destination here).
    // v2.0.15 (Terry 2026-05-31) — layered dedup model.
    //   1. Source-side hash: still computed in-stream during the
    //      copy loop (zero extra I/O, see streamCopyFile). Locks
    //      every new file's identity into the index DB at the
    //      moment it lands. Foundational, never disabled.
    //   2. Destination side, file IS in index DB: use cached hash
    //      from DB (instant — zero file I/O). Handled by the DB
    //      pre-load below.
    //   3. Destination side, file NOT in index DB: fall back to
    //      filename+size HEURISTIC instead of re-hashing from disk.
    //      Library files were already SHA-256'd when first added,
    //      so re-hashing them every prescan was busy-work that
    //      caused 80+ second prescan stalls when the destination
    //      had hundreds of un-indexed files (Terry hit this with
    //      Photo Format test folders he'd never indexed).
    //   thoroughDuplicateMatching ON keeps the old "hash everything
    //   in the destination from disk" behaviour for power users
    //   who want maximum dedup accuracy at the cost of speed.
    const forceHash = settings.thoroughDuplicateMatching ?? false;
    const useHash = forceHash;
    console.log(`[Prescan] thoroughDuplicateMatching=${forceHash} → useHash=${useHash} (DB pre-load always uses cached hashes; fs-scan ${useHash ? 'hashes new files' : 'falls back to filename+size heuristic'})`);
    
    const existingHashes = new Map<string, string>(); // hash -> filename
    const existingHeuristics = new Map<string, string>(); // "filename|size" -> filename
    let totalFiles = 0;
    let fsScannedCount = 0; // v2.0.15 — only counts FS-walked files (not DB-loaded). Drives the renderer's "X files checked" progress text so the user doesn't see "72,750 checked" for what was really a 42-file walk.
    let dbServed = 0;
    let fsHashed = 0;

    const LARGE_FILE_THRESHOLD = 500 * 1024 * 1024;

    // v2.0.15 (Terry 2026-05-30) — PERFORMANCE FIX. Previously the
    // prescan re-hashed every file in the destination on disk —
    // 72k files / 245 GB → ~2.5 hours on a typical HDD. Most of
    // those files were already in indexed_files with stored hash +
    // size, so we pull from the DB first and only fall back to the
    // filesystem for files the DB doesn't know about.
    //
    // The DB hash is populated during fix-phase copies (where every
    // file is hashed at write time), so any file ever processed by
    // a Fix is already in there. Files indexed via the catchup
    // index pass (which doesn't hash) fall through to the
    // filesystem path, get hashed once, and we cache the result by
    // updating the index row so the next prescan is also fast.
    let seenPaths = new Set<string>();
    try {
      const { getDb } = await import('./search-database.js');
      const database = getDb();
      // LIKE matches both forward + backslash paths; both UNIX-style
      // and Windows-style live under the destinationPath prefix in
      // practice because path.join always uses the platform separator
      // when paths are written via the Node.js fs APIs.
      // SQLite LIKE: % is wildcard, backslashes are literal — pass the
      // destinationPath as-is and only append the trailing separator +
      // wildcard. My earlier .replace(/\\/g,'\\\\') was DOUBLE-escaping
      // backslashes and matching zero rows, so every prescan fell
      // through to the slow filesystem path. Fix: literal match.
      const dbStart = Date.now();
      const likePrefix = destinationPath.endsWith('\\') || destinationPath.endsWith('/')
        ? destinationPath
        : destinationPath + path.sep;
      const rows = database
        .prepare(`SELECT file_path, filename, size_bytes, hash FROM indexed_files WHERE file_path LIKE ?`)
        .all(likePrefix + '%') as { file_path: string; filename: string; size_bytes: number; hash: string | null }[];
      for (const row of rows) {
        seenPaths.add(row.file_path);
        totalFiles++;
        if (row.hash) {
          existingHashes.set(row.hash, row.filename);
          dbServed++;
        } else if (row.filename && row.size_bytes > 0) {
          existingHeuristics.set(`${row.filename}|${row.size_bytes}`, row.filename);
        }
      }
      console.log(`[Prescan] DB pre-load: ${rows.length} row(s) (${dbServed} with hash) in ${((Date.now() - dbStart) / 1000).toFixed(2)}s — filesystem scan will only cover gaps`);
    } catch (dbErr) {
      console.warn('[Prescan] DB pre-load failed, falling back to full filesystem scan:', dbErr);
      seenPaths = new Set();
    }

    const scanDir = async (dirPath: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.isFile()) {
          // Already in DB? Skip — we used the cached hash/size above.
          if (seenPaths.has(fullPath)) continue;
          const ext = path.extname(entry.name).toLowerCase();
          const isMedia = PHOTO_EXTENSIONS_PRESCAN.has(ext) || VIDEO_EXTENSIONS_PRESCAN.has(ext);
          if (!isMedia) continue;

          totalFiles++;

          try {
            const stats = await fs.promises.stat(fullPath);

            if (!useHash) {
              // Heuristic mode: just filename + size (fast)
              const heuristicKey = `${entry.name}|${stats.size}`;
              existingHeuristics.set(heuristicKey, entry.name);
            } else if (stats.size > LARGE_FILE_THRESHOLD) {
              // Hash mode but file too large: heuristic fallback
              const heuristicKey = `${entry.name}|${stats.size}`;
              existingHeuristics.set(heuristicKey, entry.name);
            } else {
              // Hash mode: compute SHA-256 (async with timeout)
              const hash = await calculateFileHashAsync(fullPath);
              if (hash) {
                existingHashes.set(hash, entry.name);
                fsHashed++;
              }
            }
          } catch {
            // Skip files we can't stat
          }

          // Yield every 50 files. Progress event reports fsScannedCount
          // (NOT totalFiles) so the renderer's "X files checked" only
          // ticks for the genuinely-new files we're hashing — not the
          // tens of thousands the DB pre-load already covered. Without
          // this, a Fix adding 42 new files showed "72,750 checked"
          // and looked like a full filesystem scan.
          fsScannedCount++;
          if (totalFiles % 50 === 0) {
            await yieldToEventLoop();
            mainWindow?.webContents.send('destination:prescan:progress', { scanned: fsScannedCount });
          }
        }
      }
    };

    if (fs.existsSync(destinationPath)) {
      await scanDir(destinationPath);
    }

    console.log(`[Prescan] Complete: ${totalFiles} files (${dbServed} DB-served + ${fsHashed} fs-hashed) in ${((Date.now() - prescanStart) / 1000).toFixed(1)}s (${existingHashes.size} hashes, ${existingHeuristics.size} heuristics)`);
    return {
      success: true,
      data: {
        totalFiles,
        hashes: Object.fromEntries(existingHashes),
        heuristics: Object.fromEntries(existingHeuristics)
      }
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

let copyFilesCancelled = false;

ipcMain.handle('files:copy:cancel', async () => {
  copyFilesCancelled = true;
  return { success: true };
});

// Lightweight file-size probe used by the renderer to decide whether
// a soon-to-be-added source is a "large zip" before triggering
// analysis. The source-add guard refuses a 2nd large zip in the
// source list at this point so the user gets a clear "process this
// one first" modal instead of silently queueing concurrent
// extractions. fs.statSync is fine here — paths are local in every
// realistic flow.
ipcMain.handle('file:getSize', async (_event, filePath: string) => {
  try {
    return { success: true, sizeBytes: fs.statSync(filePath).size };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

// Fast folder fingerprint — recursive count + summed bytes for
// media files only. Used by the source-add gate to detect "same
// content on different drives" duplicates. Mirrors the engine's
// isMediaFile() logic so the count matches what analysis would
// report — including non-media files (Thumbs.db, .DS_Store, JSON
// sidecars, etc.) made a 12-media folder fingerprint as 13 files
// and the cross-drive dup check missed legitimate matches.
//
// Bails after 60 s to keep an accidentally-pointed-at-a-100k-folder
// from hanging the renderer waiting for a result. The dup-warning
// modal is non-blocking — a timeout is treated the same as "no
// match" and the source is added normally.
const FINGERPRINT_MEDIA_EXTS = new Set([
  // Photos — must mirror analysis-engine.ts PHOTO_EXTENSIONS
  '.jpg', '.jpeg', '.jfif', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp',
  '.heic', '.heif', '.avif', '.jp2', '.j2k',
  '.raw', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.rw2', '.pef',
  '.sr2', '.srf', '.raf', '.3fr', '.rwl', '.x3f', '.dcr', '.kdc', '.mrw', '.erf',
  '.ico', '.svg', '.psd',
  // Videos — must mirror analysis-engine.ts VIDEO_EXTENSIONS
  '.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v',
  '.3gp', '.3g2', '.mts', '.m2ts', '.ts', '.vob',
  '.mpg', '.mpeg', '.asf', '.divx', '.ogv', '.rm', '.rmvb', '.swf',
]);

ipcMain.handle('folder:fingerprint', async (_event, dirPath: string) => {
  const startedAt = Date.now();
  const TIMEOUT_MS = 60000;
  let fileCount = 0;
  let totalBytes = 0;
  let timedOut = false;

  const walk = (dir: string): void => {
    if (timedOut) return;
    if (Date.now() - startedAt > TIMEOUT_MS) {
      timedOut = true;
      return;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip silently, the user picked it not us
    }
    for (const e of entries) {
      if (timedOut) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        // Filter to media files only — match the engine's count.
        const ext = path.extname(e.name).toLowerCase();
        if (!FINGERPRINT_MEDIA_EXTS.has(ext)) continue;
        try {
          totalBytes += fs.statSync(full).size;
          fileCount++;
        } catch {
          // unreadable file — skip
        }
      }
    }
  };

  try {
    walk(dirPath);
    return { success: true, fileCount, totalBytes, timedOut };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('files:copy', async (_event, data: {
  files: Array<{
    sourcePath: string;
    newFilename: string;
    sourceType: 'folder' | 'zip';
    derivedDate?: string;
    dateConfidence?: 'confirmed' | 'recovered' | 'marked';
    dateSource?: string;
    isDuplicate?: boolean;
    duplicateOf?: string;
    originSourcePath?: string;
    // v2.0.15 — analysis-known source size, used by the progress
    // reporter to advance the bar by bytes instead of file count.
    // Optional so callers that didn't supply it (legacy code paths)
    // fall back to file-count progress without breaking.
    sizeBytes?: number;
  }>;
  destinationPath: string;
  zipPaths?: Record<string, string>;
  folderStructure?: 'year' | 'year-month' | 'year-month-day';
  settings?: {
    skipDuplicates: boolean;
    thoroughDuplicateMatching: boolean;
    writeExif: boolean;
    exifWriteConfirmed: boolean;
    exifWriteRecovered: boolean;
    exifWriteMarked: boolean;
  };
  existingDestinationHashes?: Record<string, string>;
  existingDestinationHeuristics?: Record<string, string>;
  photoFormat?: 'original' | 'png' | 'jpg';
}) => {
  const { destinationPath, zipPaths = {}, photoFormat = 'original' } = data;
  // v2.0.15 (Terry 2026-06-01) — SORT FILES BY SIZE DESCENDING.
  // Default alphabetical order clustered all the big videos at the
  // end of the run (HTC One filenames: IMAG*.jpg first, VIDEO*.mp4
  // last). With 4-wide parallel copy, four big videos ended up in
  // flight together and no log/progress event fired for 15-20 s
  // while libuv worked — long enough for Windows to ghost the title
  // bar white. Starting biggest files first means the slow files are
  // running THROUGHOUT the Fix alongside continuously-completing
  // small photos, so the main thread always has a near-term file
  // completion to log/emit progress for. As a side effect this also
  // smooths the tail latency that made the bar appear stuck at ~86%
  // near the end. Sorts a shallow copy so we don't mutate the
  // caller's array. Files without sizeBytes (legacy path) sort to
  // the end of the queue.
  const files = [...data.files].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
  console.log(`[Fix] Starting copy: ${files.length} files to ${destinationPath}, format=${photoFormat} (sorted by size DESC)`);
  copyFilesCancelled = false;

  // ── Network destination → stage-then-mirror via robocopy ──
  // For network destinations (UNC paths and mapped network drives),
  // every fs.createReadStream → fs.createWriteStream cycle pays one
  // synchronous network round-trip per file. We side-step that by
  // writing the per-file loop's output to a local staging folder
  // (fast disk I/O, full rename + EXIF + dedupe logic unchanged) and
  // then mirroring the whole staging tree to the real destination
  // with a single robocopy /MT:16 invocation. Local destinations
  // skip staging entirely — fs.copyFile is already syscall-fast on
  // local drives and staging would just double the disk I/O. If
  // staging mkdir fails for any reason we silently fall back to the
  // current direct-copy path so the worst case is "no speedup, same
  // behavior as today".
  let useStaging = false;
  let stagingPath: string | null = null;
  let writeRoot = destinationPath;
  // Hoisted out of the try block so the finally clause can read it
  // — finally needs to know whether the mirror step asked to keep
  // staging around for manual recovery.
  let preserveStagingForRecovery = false;
  // v2.0.15 (Terry 2026-05-30) — persistent conversion worker
  // handle, hoisted to handler scope so the finally clause can shut
  // it down on error / cancellation paths (otherwise a Fix that
  // bails mid-conversion leaks a utilityProcess + its libvips
  // memory pool). The ensure* helper that spawns it lives inside
  // the try block since it's only called from flushConversions.
  let persistentConvertChild: Electron.UtilityProcess | null = null;

  // v2.0.15 (Terry 2026-06-02) — benchmark accumulator. Captures every
  // per-file conversion timing + every per-batch summary the worker
  // emits, then writes a human-readable summary.txt + machine-readable
  // per-file.csv at end-of-Fix. Replaces the rotating main.log as the
  // permanent home of conversion telemetry. main.log's per-file
  // [Convert] lines are trimmed in shipped builds (commit 948bd44) —
  // this file gets the full detail unconditionally so we never have
  // to scramble to capture a benchmark before logs rotate.
  const conversionBenchmark = {
    startedAtMs: 0,
    sourceFolders: new Set<string>(),
    perFile: [] as Array<{
      ts: string;
      batch: number;
      id: number;
      ok: boolean;
      durMs: number;
      inKB: number | null;
      outKB: number | null;
      ratio: number | null;
      memMB: number | null;
      filename: string;
      error: string | null;
    }>,
    perBatch: [] as Array<{
      ts: string;
      batch: number;
      succeeded: number;
      failed: number;
      total: number;
      wallMs: number;
      inMB: number;
      outMB: number;
      throughputMBps: number | null;
      childRssMB: number | null;
    }>,
  };

  const writeConversionBenchmark = async (): Promise<void> => {
    if (conversionBenchmark.perFile.length === 0) return; // nothing to write
    try {
      const endedAtMs = Date.now();
      const wallMs = endedAtMs - conversionBenchmark.startedAtMs;
      const startedIso = new Date(conversionBenchmark.startedAtMs).toISOString();
      const endedIso = new Date(endedAtMs).toISOString();
      const tag = startedIso.replace(/[:.]/g, '-').replace('Z', '');

      const okFiles = conversionBenchmark.perFile.filter(f => f.ok);
      const failedFiles = conversionBenchmark.perFile.filter(f => !f.ok);
      const sumIn = okFiles.reduce((a, b) => a + (b.inKB ?? 0), 0);
      const sumOut = okFiles.reduce((a, b) => a + (b.outKB ?? 0), 0);
      const durs = okFiles.map(f => f.durMs).sort((a, b) => a - b);
      const ratios = okFiles.map(f => f.ratio ?? 0).filter(r => r > 0).sort((a, b) => a - b);
      const mems = okFiles.map(f => f.memMB ?? 0).filter(m => m > 0).sort((a, b) => a - b);
      const pct = (arr: number[], p: number) =>
        arr.length === 0 ? null : arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];

      const totalInBytes = sumIn * 1024;
      const totalOutBytes = sumOut * 1024;
      const throughputMBps = wallMs > 0 ? +(totalOutBytes / 1e6 / (wallMs / 1000)).toFixed(2) : null;

      // Active optimisations — track each PNG-encode tweak so the
      // summary file caption matches what was actually running on
      // disk for this run. Manual list (no introspection in worker).
      const optimisations = [
        'compressionLevel=1',
        'effort=1',
        'EXIF inline (.withExif)',
        'persistent worker (no per-batch fork)',
        // VIPS_FOREIGN_PNG_FILTER_NONE is set in conversion-worker.ts.
        // Reflect it here when toggling.
        process.env.VIPS_FOREIGN_PNG_FILTER_NONE === '1' ? 'VIPS_FOREIGN_PNG_FILTER_NONE' : null,
      ].filter(Boolean) as string[];

      const cpuModel = (os.cpus()[0]?.model ?? 'unknown').trim();
      const totalRamGB = (os.totalmem() / 1e9).toFixed(2);

      // Build the human-readable summary.
      const summary = [
        '═══════════════════════════════════════════════════════════',
        '  PDR Conversion Benchmark',
        '═══════════════════════════════════════════════════════════',
        '',
        `Started:        ${startedIso}`,
        `Ended:          ${endedIso}`,
        `Wall-clock:     ${(wallMs / 60000).toFixed(2)} min  (${(wallMs / 1000).toFixed(1)} s)`,
        '',
        `Files OK:       ${okFiles.length}`,
        `Files failed:   ${failedFiles.length}`,
        `Batches:        ${conversionBenchmark.perBatch.length}`,
        '',
        `Input total:    ${(totalInBytes / 1e9).toFixed(3)} GB`,
        `Output total:   ${(totalOutBytes / 1e9).toFixed(3)} GB`,
        `Size ratio:     ${totalInBytes === 0 ? 'n/a' : (totalOutBytes / totalInBytes).toFixed(3)}`,
        `Throughput:     ${throughputMBps ?? 'n/a'} MB/s`,
        '',
        `Per-file dur (ms):  p50=${pct(durs, 0.5) ?? 'n/a'}  p95=${pct(durs, 0.95) ?? 'n/a'}  max=${durs[durs.length - 1] ?? 'n/a'}`,
        `Per-file ratio:     p50=${pct(ratios, 0.5) ?? 'n/a'}  p95=${pct(ratios, 0.95) ?? 'n/a'}  max=${ratios[ratios.length - 1] ?? 'n/a'}`,
        `Per-file mem (MB):  p50=${pct(mems, 0.5) ?? 'n/a'}  p95=${pct(mems, 0.95) ?? 'n/a'}  peak=${mems[mems.length - 1] ?? 'n/a'}`,
        '',
        `Sources:        ${conversionBenchmark.sourceFolders.size > 0 ? Array.from(conversionBenchmark.sourceFolders).join(', ') : '(not recorded — older Fix path)'}`,
        `Destination:    ${destinationPath}`,
        '',
        `Optimisations active:`,
        ...optimisations.map(o => `  • ${o}`),
        '',
        `Machine:        ${cpuModel}  ·  ${os.cpus().length} cores  ·  ${totalRamGB} GB RAM`,
        `OS:             ${os.platform()} ${os.release()}  (${os.arch()})`,
        `Node:           ${process.version}`,
        '',
        '───────────────────────────────────────────────────────────',
        'Per-file timings: see per-file.csv next to this file.',
        'Per-batch totals: see per-batch.csv next to this file.',
        '───────────────────────────────────────────────────────────',
        '',
      ].join('\r\n');

      // CSV builders — Excel-friendly, one row per file / batch.
      const perFileCsv = [
        'timestamp,batch,id,ok,duration_ms,input_kb,output_kb,ratio,mem_mb,filename,error',
        ...conversionBenchmark.perFile.map(f =>
          [
            f.ts,
            f.batch,
            f.id,
            f.ok ? 'true' : 'false',
            f.durMs,
            f.inKB ?? '',
            f.outKB ?? '',
            f.ratio ?? '',
            f.memMB ?? '',
            `"${(f.filename ?? '').replace(/"/g, '""')}"`,
            f.error ? `"${f.error.replace(/"/g, '""')}"` : '',
          ].join(',')
        ),
      ].join('\r\n');

      const perBatchCsv = [
        'timestamp,batch,succeeded,failed,total,wall_ms,input_mb,output_mb,throughput_mbps,child_rss_mb',
        ...conversionBenchmark.perBatch.map(b =>
          [
            b.ts,
            b.batch,
            b.succeeded,
            b.failed,
            b.total,
            b.wallMs,
            b.inMB.toFixed(2),
            b.outMB.toFixed(2),
            b.throughputMBps ?? '',
            b.childRssMB ?? '',
          ].join(',')
        ),
      ].join('\r\n');

      // Write to userData/benchmarks/<tag>/ and (when available) mirror
      // into <libraryRoot>/.pdr/benchmarks/<tag>/ so the trail travels
      // with the library, like the sidecar DB.
      const userDataDir = path.join(app.getPath('userData'), 'benchmarks', `conversion-${tag}`);
      await fs.promises.mkdir(userDataDir, { recursive: true });
      const writeAll = async (dir: string) => {
        await fs.promises.writeFile(path.join(dir, 'summary.txt'), summary, 'utf8');
        await fs.promises.writeFile(path.join(dir, 'per-file.csv'), perFileCsv, 'utf8');
        await fs.promises.writeFile(path.join(dir, 'per-batch.csv'), perBatchCsv, 'utf8');
      };
      await writeAll(userDataDir);
      log.info(`[Convert] Benchmark saved: ${userDataDir}`);

      try {
        const libStatus = getLibraryStatus();
        const libRoot = libStatus.attached ? libStatus.libraryRoot : null;
        if (libRoot) {
          const libDir = path.join(libRoot, '.pdr', 'benchmarks', `conversion-${tag}`);
          await fs.promises.mkdir(libDir, { recursive: true });
          await writeAll(libDir);
          log.info(`[Convert] Benchmark mirrored to library: ${libDir}`);
        }
      } catch (mirrorErr) {
        // Mirror failure is non-fatal — the userData copy is the
        // authoritative one. Just log so we know if it's a recurring
        // problem (e.g. library drive disconnected).
        log.warn(`[Convert] Benchmark mirror to library failed: ${(mirrorErr as Error).message}`);
      }
    } catch (err) {
      log.warn(`[Convert] Failed to write benchmark: ${(err as Error).message}`);
    }
  };

  const shutdownPersistentConvertChild = async (): Promise<void> => {
    const child = persistentConvertChild;
    // Write the benchmark before tearing the worker down. Safe even
    // if no conversion ran — the function short-circuits on empty
    // accumulator.
    await writeConversionBenchmark();
    if (!child) return;
    await new Promise<void>((resolve) => {
      // Guard against a worker that already died — resolve
      // immediately rather than hanging.
      let settled = false;
      const onExit = () => { if (settled) return; settled = true; resolve(); };
      child.once('exit', onExit);
      try {
        child.postMessage({ type: 'shutdown' });
      } catch {
        // Already dead — fire the resolve manually.
        if (!settled) { settled = true; resolve(); }
      }
    });
    persistentConvertChild = null;
  };
  // Honour the user's network-upload-mode setting. 'direct' is the
  // legacy kill switch — even on network destinations, force the
  // old per-file fs.createReadStream loop. Used as the A/B baseline
  // and as a rescue option for SMB versions that fight robocopy.
  const networkUploadMode = (() => {
    try { return getSettings().networkUploadMode || 'fast'; } catch { return 'fast'; }
  })();
  console.log(`[Fix] Network upload mode: ${networkUploadMode === 'fast' ? 'FAST (robocopy /MT:16 staging)' : 'LEGACY (fs.createReadStream per-file loop)'}`);
  if (process.platform === 'win32' && networkUploadMode === 'fast') {
    try {
      const destClass = classifySource(destinationPath);
      if (destClass.type === 'network') {
        const candidate = path.join(os.tmpdir(), `pdr-stage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        try {
          fs.mkdirSync(candidate, { recursive: true });
          stagingPath = candidate;
          writeRoot = candidate;
          useStaging = true;
          console.log(`[Fix] Network destination detected (${destClass.label}). Staging via: ${candidate}`);
          if (mainWindow) {
            mainWindow.webContents.send('files:copy:phase', {
              phase: 'staging',
              message: 'Preparing files locally before network upload…',
            });
          }
        } catch (mkErr) {
          console.warn(`[Fix] Staging mkdir failed; falling back to direct copy:`, mkErr);
        }
      }
    } catch (clsErr) {
      console.warn(`[Fix] classifySource failed for destination; assuming local:`, clsErr);
    }
  }

  const results: Array<{ 
    success: boolean; 
    sourcePath: string; 
    destPath: string; 
    finalFilename: string; 
    error?: string;
    exifWritten?: boolean;
    exifSource?: string;
    exifError?: string;
  }> = [];
  const zipCache: Record<string, AdmZip> = {};
  const usedFilenames = new Set<string>();
  
  // GLOBAL write-time deduplication registry (supersedes analysis flags)
  const writtenHashes = new Map<string, string>(); // hash -> first written filename
  const writtenHeuristics = new Map<string, string>(); // "filename|size" -> first written filename
  const LARGE_FILE_THRESHOLD = 500 * 1024 * 1024;
  const MIN_HEURISTIC_SIZE = 5 * 1024 * 1024;
  
  // Pre-populate with existing destination files (cross-run duplicate prevention)
  const existingHashes = data.existingDestinationHashes || {};
  const existingHeuristics = data.existingDestinationHeuristics || {};
  for (const [hash, filename] of Object.entries(existingHashes)) {
    writtenHashes.set(hash, `[existing] ${filename}`);
  }
  for (const [key, filename] of Object.entries(existingHeuristics)) {
    writtenHeuristics.set(key, `[existing] ${filename}`);
  }
  
  const duplicateFiles: Array<{ filename: string; duplicateOf: string; duplicateMethod: 'hash' | 'heuristic'; wasExisting?: boolean }> = [];
  let duplicatesRemoved = 0;
  let skippedExisting = 0;

  // v2.0.15 — hoisted out of the try block so the finally clause can
  // clear it on error / cancellation paths too. Started inside the
  // try block once the copy loop's prerequisites exist; remains null
  // on the abort-before-loop paths.
  let heartbeatTimer: NodeJS.Timeout | null = null;

  try {
    // mkdir BOTH the real destination (so robocopy has a parent
    // when mirroring) AND, when staging, the writeRoot is already
    // mkdir'd above. recursive:true is a no-op when the dir exists.
    // Long-path wrappers so library-drive roots embedded under
    // deeply-nested paths don't trip MAX_PATH on Windows.
    if (!fs.existsSync(toLongPath(destinationPath))) {
      fs.mkdirSync(toLongPath(destinationPath), { recursive: true });
    }
    if (useStaging && writeRoot !== destinationPath && !fs.existsSync(toLongPath(writeRoot))) {
      fs.mkdirSync(toLongPath(writeRoot), { recursive: true });
    }

    // Snapshot pre-existing files at the REAL destination (not the
    // staging dir) so cross-run dedupe + collision resolution work
    // correctly even when this run is staging.
    //
    // v2.0.15 (Terry 2026-05-30) — PERFORMANCE FIX. Previously this
    // ALWAYS walked the destination filesystem recursively to build
    // the preExistingFiles set, even though the prescan IPC that
    // ran moments earlier ALREADY walked the same tree. On a 72k
    // file destination that was an 18-second gap between "Applying
    // Fixes" appearing and the first file actually being processed.
    //
    // Now we pull from indexed_files first (DB hit = ms). The DB
    // has file_path for every file ever Fix-processed or catchup-
    // indexed into this destination, so the relative-path set is
    // built without touching disk. Fall back to the filesystem
    // walk if the DB returns zero rows (first-ever Fix on an empty
    // index).
    const preExistingFiles = new Set<string>();
    const fixScanStart = Date.now();
    try {
      const { getDb } = await import('./search-database.js');
      const database = getDb();
      const likePrefix = destinationPath.endsWith('\\') || destinationPath.endsWith('/')
        ? destinationPath
        : destinationPath + path.sep;
      const rows = database
        .prepare(`SELECT file_path FROM indexed_files WHERE file_path LIKE ?`)
        .all(likePrefix + '%') as { file_path: string }[];
      for (const row of rows) {
        const rel = path.relative(destinationPath, row.file_path).toLowerCase();
        if (rel && !rel.startsWith('..')) preExistingFiles.add(rel);
      }
      console.log(`[Fix] DB pre-scan: ${preExistingFiles.size} existing relative paths from ${rows.length} indexed rows in ${((Date.now() - fixScanStart) / 1000).toFixed(2)}s`);
    } catch (dbErr) {
      console.warn('[Fix] DB pre-scan failed:', dbErr);
    }
    // Fall back to filesystem walk only if the DB had nothing to
    // contribute (first-ever Fix into a destination PDR doesn't yet
    // know about). Identical to the legacy behaviour in that case.
    if (preExistingFiles.size === 0) {
      const scanForExisting = async (dirPath: string, relativePath: string = ''): Promise<void> => {
        try {
          const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              await scanForExisting(path.join(dirPath, entry.name), path.join(relativePath, entry.name));
            } else if (entry.isFile()) {
              preExistingFiles.add(path.join(relativePath, entry.name).toLowerCase());
            }
          }
        } catch {}
      };
      await scanForExisting(destinationPath);
      console.log(`[Fix] Destination filesystem scan complete: ${preExistingFiles.size} existing files found in ${((Date.now() - fixScanStart) / 1000).toFixed(2)}s`);
    }

    // Helper: does a relative path collide with a file at the REAL
    // destination? When staging, fs.existsSync would probe the empty
    // staging tree (wrong answer); use the snapshot instead. When
    // not staging, keep behavior identical to pre-staging code by
    // hitting the live filesystem.
    const realDestFileExists = (relPath: string): boolean => {
      if (useStaging) {
        return preExistingFiles.has(relPath.toLowerCase());
      }
      return fs.existsSync(path.join(destinationPath, relPath));
    };

    // Cache source classifications to avoid running 'net use' subprocess per file
    const sourceClassificationCache = new Map<string, ReturnType<typeof classifySource>>();
    const getSourceClassification = (sourcePath: string) => {
      if (!sourceClassificationCache.has(sourcePath)) {
        try {
          sourceClassificationCache.set(sourcePath, classifySource(sourcePath));
        } catch {
          sourceClassificationCache.set(sourcePath, { type: 'unknown', speed: 'medium', label: 'Unknown', description: '', isOptimal: false });
        }
      }
      return sourceClassificationCache.get(sourcePath)!;
    };

    // Queue for PNG/JPG conversions. Conversions are processed in
    // batches by a forked utilityProcess child so each batch's
    // libvips memory pool is fully reclaimed by the OS when the
    // child exits — the v2.0.0 inline path leaked memory across
    // 7,000+ conversions in a single Takeout, eventually freezing
    // the main process via OS swap-thrashing.
    //
    // Batch size is bigger than the inline version's 6 because the
    // fork overhead (~100 ms per child) dominates if we fork
    // dozens of times per Takeout. 50 amortises forking while still
    // capping the worst-case memory growth per child to a level
    // even small machines can handle. Sharp's internal concurrency
    // is capped at 2 inside the child (see conversion-worker.ts),
    // so a single child has at most 2 in-flight decode/encode
    // buffers regardless of the batch size.
    const CONVERSION_BATCH_SIZE = 50;
    const pendingConversions: Array<{
      sourceInput: string | Buffer;
      convertedPath: string;
      format: 'jpg' | 'png';
      fileIndex: number;
      destPath: string;
      subfolderPath: string;
      file: typeof files[0];
      finalFilename: string;
      // v2.0.15 — EXIF date string to embed during sharp encode in
      // the worker (replaces the serial post-batch exiftool loop
      // that was the 35-min main-thread bottleneck on Terry's
      // 2,123-file PNG Fix). Computed at queue time so the caller's
      // settings + per-file confidence gate run on the main thread
      // once; the worker just embeds the string into the encoded
      // file. Empty/undefined means no EXIF write requested.
      dateExif?: string;
      // The "Confirmed (Google Takeout JSON)" style label we'd have
      // returned from writeExifDate, used to mark the results row.
      exifSourceLabel?: string;
    }> = [];

    // Track actual completed files for accurate progress
    let completedFiles = 0;

    // v2.0.15 (Terry 2026-06-01) — byte-based progress. A 100 KB photo
    // and a 200 MB video both used to be "1/829" in file-count math,
    // so the % would stick at ~98% for half a minute while the
    // trailing big video files copied. Byte progress moves smoothly
    // across the same wall-clock time because the bar advances in
    // proportion to data actually transferred. totalCopyBytes is the
    // sum of every file's analysis-known sizeBytes; bytesDone
    // increments in the same places completedFiles increments.
    // Falls back to 0 if no sizes are supplied (legacy / IPC mismatch)
    // and the renderer's progress code uses file-count math instead.
    const totalCopyBytes = data.files.reduce(
      (sum, f) => sum + (typeof f.sizeBytes === 'number' && f.sizeBytes > 0 ? f.sizeBytes : 0),
      0,
    );
    let bytesDone = 0;
    /** Helper — adds size to bytesDone for whichever file just landed.
     *  Called immediately before the existing `webContents.send`. */
    const advanceBytes = (file: { sizeBytes?: number } | undefined): void => {
      if (file && typeof file.sizeBytes === 'number' && file.sizeBytes > 0) {
        bytesDone += file.sizeBytes;
      }
    };
    /** Helper — the progress payload all the send sites use. Kept in
     *  one place so the contract stays consistent across the 8 emit
     *  points in this handler.
     *
     *  v2.0.15 (Terry 2026-06-01) — reverted to committed-bytes-only.
     *  An in-flight estimator was tried (filesInProgressMeta +
     *  per-file rate × elapsed) but the first completed file is
     *  cache-aided and finishes in ~6 s; the rate computed from that
     *  one sample was 5–10× higher than steady-state, so the bar
     *  shot to ~31 % in the first 11 s while reality was at ~7 %.
     *  Reverted to honest committed bytes — the bar moves in steps
     *  as files complete, which is mathematically truthful. Visual
     *  smoothness comes from (a) the heartbeat keeping the message
     *  pump warm and (b) the size-DESC sort spreading big files
     *  across the run. If the bar plateaus during a big-video gap,
     *  the renderer's stuck-indicator surfaces an explicit "still
     *  working" notice. */
    const progressPayload = () => ({
      current: completedFiles,
      total: data.files.length,
      bytesDone,
      totalBytes: totalCopyBytes,
    });

    // v2.0.15 (Terry 2026-06-01) — PARALLEL COPY POOL.
    // Was a serial for-loop where each file's streamCopyFile + EXIF
    // write blocked the next file. A single 200 MB video copy could
    // sit on the main thread for 10–16 s with no event-loop ticks,
    // long enough for Windows to ghost the title bar white. With a
    // 4-wide pool, fast small photos and slow big videos overlap so
    // the end-of-Fix wall clock drops AND the OS keeps getting
    // window messages.
    //
    // Layout: the SYNC PREP per file (cancellation check, stat,
    // heuristic dedup, mkdir, filename-collision loop) stays in the
    // sequential for-loop body so the shared maps + sets
    // (usedFilenames, writtenHeuristics, preExistingFiles) don't
    // race. Once a unique destination filename is reserved, the
    // ASYNC HEAVY work — streamCopyFile, hash-dedup post-check, EXIF
    // write, results.push, progress emit — is wrapped in an IIFE
    // and launched into a pool capped at COPY_CONCURRENCY.
    //
    // Why the shared mutations are safe: JavaScript runs the IIFE
    // synchronously up to its first `await`, so Map.get + Map.set
    // pairs (writtenHashes) and Array.push (results, duplicateFiles)
    // can't interleave between different IIFEs. The only state the
    // IIFE TOUCHES that another IIFE could also touch is
    // writtenHashes, and its single-shot get-then-set is atomic from
    // the event-loop's perspective. Worst case: two identical files
    // copy in parallel, both complete near-simultaneously, whichever
    // post-checks first wins the hash slot; the loser unlinks its
    // just-written file. That's the same outcome as serial order.
    const COPY_CONCURRENCY = 4;
    const inFlightCopies = new Set<Promise<void>>();
    const waitForCopySlot = async (): Promise<void> => {
      while (inFlightCopies.size >= COPY_CONCURRENCY) {
        // Promise.race resolves the moment any in-flight copy
        // settles; we then re-check the size to allow for multiple
        // settling on the same tick.
        await Promise.race([...inFlightCopies]);
      }
    };

    // v2.0.15 (Terry 2026-06-01) — PROGRESS HEARTBEAT.
    // When 4 big videos are in flight at once and each takes 15–30 s
    // to complete, no progress event fires for the whole wait —
    // Windows ghosts the title bar white after 5 s of no message-pump
    // activity (seen as the "86 % freeze" symptom on Terry's HTC
    // source, confirmed in main.log as a 19.6 s log gap between
    // 12:25:44 and 12:26:03). This timer fires a duplicate progress
    // event every second while ANY copy is in flight, keeping the
    // renderer + Windows DWM aware that the process is alive. The
    // bytesDone / completedFiles numbers don't change between real
    // file completions; the event is just a liveness signal. Stored
    // on the hoisted `heartbeatTimer` so the finally clause can also
    // clear it on error / cancellation paths.
    heartbeatTimer = setInterval(() => {
      if (inFlightCopies.size > 0 && mainWindow) {
        mainWindow.webContents.send('files:copy:progress', progressPayload());
      }
    }, 1000);


    // v2.0.15 (Terry 2026-05-30) — conversion-speed telemetry. The
    // photo-format gate is now open in release builds, so we need
    // hard numbers to optimise against: total wall-clock spent in
    // conversion, number of batches, number of files converted, and
    // an average ms/file figure. Each [Convert] line in main.log is
    // searchable; the aggregate '[Convert] Phase complete' line below
    // is what we'll grep for after a real Fix to see whether the
    // utilityProcess fork is genuinely fast enough.
    let convertTotalWallMs = 0;
    let convertBatchCount = 0;
    let convertFilesProcessed = 0;
    const convertPhaseStartedAt = Date.now();

    // v2.0.15 (Terry 2026-05-30) — persistent conversion worker. The
    // pre-v2.0.15 implementation forked a fresh child per batch and
    // exited it after batch-done so the OS would reclaim its libvips
    // memory pool. Measured 6,763ms fork+sharp-load+first-decode
    // latency × 43 batches on a 2,123-file Fix = ~5 minutes wasted
    // on cold starts alone. The persistent model pays that cost once
    // per Fix instead of once per batch, and we still reclaim the
    // libvips pool via an explicit 'shutdown' message at end-of-Fix.
    // Memory across the run is observable in the per-file mem= line
    // so a future regression would surface immediately.
    // (persistentConvertChild + shutdownPersistentConvertChild are
    // hoisted to handler scope so the finally clause can clean up
    // on error / cancellation paths.)
    let persistentConvertChildLifetimeBatches = 0;
    const ensurePersistentConvertChild = (): Electron.UtilityProcess => {
      if (persistentConvertChild) return persistentConvertChild;
      const workerPath = app.isPackaged
        ? path.join(process.resourcesPath, 'dist-electron/conversion-worker.cjs')
        : path.join(__dirname, 'conversion-worker.cjs');
      const child = utilityProcess.fork(workerPath, [], {
        // serviceName surfaces in Task Manager so the user (and
        // support) can see "PDR Image Conversion" rather than a
        // generic Electron Helper.
        serviceName: 'PDR Image Conversion',
        stdio: 'pipe',
        env: workerEnv(),
      });
      // Forward stdout/stderr to main.log once per worker lifetime.
      child.stdout?.on('data', (chunk: Buffer) => {
        log.info(`[conversion-worker stdout] ${chunk.toString().trim()}`);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        log.warn(`[conversion-worker stderr] ${chunk.toString().trim()}`);
      });
      child.on('exit', (code) => {
        log.info(`[Convert] Persistent worker exited code=${code} after ${persistentConvertChildLifetimeBatches} batch(es)`);
        persistentConvertChild = null;
      });
      persistentConvertChild = child;
      log.info(`[Convert] Persistent worker spawned (pid pending)`);
      return child;
    };

    // Flush pending conversions to the persistent child. The child
    // receives the batch, runs sharp at parallelism=4 (post-v2.0.15;
    // measured to balance CPU oversubscription against per-task
    // throughput on the PNG encode workload), posts task-done
    // messages as each completes (so the progress bar advances live),
    // then posts batch-done. The child stays alive for the next
    // batch — main calls shutdownPersistentConvertChild() once after
    // the final flush at end-of-Fix.
    const flushConversions = async () => {
      if (pendingConversions.length === 0) return;
      const batch = pendingConversions.splice(0, pendingConversions.length);
      const batchStartedAt = Date.now();
      convertBatchCount++;
      const batchIndex = convertBatchCount; // closed-over for per-file logs below
      // v2.0.15 (Terry 2026-05-31) — per-batch "Flushing" log
      // disabled for shipped builds. Was diagnostic during the
      // perf-testing pass; for end users ~43 of these lines per
      // 2,123-file Fix is pure noise in main.log. Re-enable when
      // actively investigating a regression.
      // console.log(`[Convert] Flushing batch #${batchIndex} of ${batch.length} conversions to persistent worker`);

      // Map task input to a string path. Buffers (small in-memory
      // zip extracts) get spilled to a temp file first; the child
      // only deals with file paths.
      const tmpInputs: string[] = [];
      const childTasks = await Promise.all(batch.map(async (task, id) => {
        let inputPath: string;
        if (typeof task.sourceInput === 'string') {
          inputPath = task.sourceInput;
        } else {
          const tmpName = path.join(
            app.getPath('temp'),
            `pdr-convert-${Date.now()}-${id}-${Math.random().toString(36).slice(2, 8)}`,
          );
          await fs.promises.writeFile(tmpName, task.sourceInput);
          tmpInputs.push(tmpName);
          inputPath = tmpName;
        }
        return {
          id,
          input: inputPath,
          output: task.convertedPath,
          format: task.format,
          // v2.0.15 — embed EXIF in-pipeline. See queue-push site
          // above for the gating logic. Undefined = no embed.
          dateExif: task.dateExif,
        };
      }));

      const child = ensurePersistentConvertChild();
      persistentConvertChildLifetimeBatches++;

      // Per-task results keyed by id, populated as the child posts
      // 'task-done' messages. The 'batch-done' message tells us when
      // every task has been posted (succeeded or failed).
      const childResults = new Map<number, {
        success: boolean;
        durationMs: number;
        error?: string;
        inputBytes?: number;
        outputBytes?: number;
        memUsage: { rssMB: number; heapUsedMB: number; externalMB: number };
      }>();

      let lastMemSnapshot: { rssMB: number; heapUsedMB: number; externalMB: number } | null = null;
      // v2.0.15 diagnostics — first-task latency. On batch #1 this
      // captures the fork + sharp module load + first decode cost.
      // On batch #2+ (persistent worker), it captures just the
      // first decode — should drop to ~hundreds of ms instead of
      // the ~6.7s we measured pre-persistent.
      let firstTaskAt: number | null = null;
      // Batch totals for the throughput line on batch-done.
      let batchInputBytes = 0;
      let batchOutputBytes = 0;

      const postAt = Date.now();
      await new Promise<void>((resolve, reject) => {
        let resolved = false;
        const settleResolve = () => {
          if (resolved) return;
          resolved = true;
          child.off('message', onMessage);
          child.off('exit', onUnexpectedExit);
          resolve();
        };
        const settleReject = (err: Error) => {
          if (resolved) return;
          resolved = true;
          child.off('message', onMessage);
          child.off('exit', onUnexpectedExit);
          reject(err);
        };
        const onMessage = (msg: any) => {
          if (!msg || typeof msg !== 'object') return;
          if (msg.type === 'task-done') {
            childResults.set(msg.id, {
              success: msg.success,
              durationMs: msg.durationMs,
              error: msg.error,
              inputBytes: msg.inputBytes,
              outputBytes: msg.outputBytes,
              memUsage: msg.memUsage,
            });
            lastMemSnapshot = msg.memUsage;
            if (typeof msg.inputBytes === 'number') batchInputBytes += msg.inputBytes;
            if (typeof msg.outputBytes === 'number') batchOutputBytes += msg.outputBytes;
            // First-task latency landed — disabled for shipped
            // builds. Useful only when actively diagnosing cold-
            // start regressions. firstTaskAt is still set so the
            // log can be re-enabled with one line.
            if (firstTaskAt === null) {
              firstTaskAt = Date.now();
              // log.info(`[Convert] Batch #${batchIndex} first-task latency: ${firstTaskAt - postAt}ms (post-message → first task-done; batch #1 includes fork + sharp load)`);
            }
            // v2.0.15 diagnostics — per-file rich log so a slow
            // outlier or a giant input doesn't get buried in the
            // batch average. Format kept on one line for grep-ability.
            const t = batch[msg.id];
            const filename = t ? path.basename(t.convertedPath) : `id=${msg.id}`;
            const inKB = typeof msg.inputBytes === 'number' ? Math.round(msg.inputBytes / 1024) : null;
            const outKB = typeof msg.outputBytes === 'number' ? Math.round(msg.outputBytes / 1024) : null;
            const ratio = (inKB && outKB) ? (outKB / inKB).toFixed(2) : 'n/a';
            const memStr = msg.memUsage ? `mem=${msg.memUsage.rssMB}MB` : '';
            const status = msg.success ? 'ok' : `FAIL(${msg.error ?? 'unknown'})`;
            // v2.0.15 — per-file rich log now only fires on
            // FAILURE. The ~2,123 success lines per Fix were
            // diagnostic noise. Failure lines are kept (as warn)
            // because support genuinely needs to know which file
            // broke if a user reports a conversion problem.
            if (!msg.success) {
              log.warn(`[Convert]   #${batchIndex}.${msg.id} ${status} dur=${msg.durationMs}ms in=${inKB ?? '?'}KB out=${outKB ?? '?'}KB ratio=${ratio} ${memStr} "${filename}"`);
            }
            // v2.0.15 (Terry 2026-06-02) — push the per-file row into
            // the conversionBenchmark accumulator so it gets written
            // to disk at end-of-Fix. Replaces the old reliance on
            // main.log's [Convert] lines (which were trimmed in
            // shipped builds and rotated daily).
            if (conversionBenchmark.startedAtMs === 0) {
              conversionBenchmark.startedAtMs = Date.now() - msg.durationMs;
            }
            conversionBenchmark.perFile.push({
              ts: new Date().toISOString(),
              batch: batchIndex,
              id: msg.id,
              ok: !!msg.success,
              durMs: msg.durationMs,
              inKB,
              outKB,
              ratio: (inKB && outKB) ? +(outKB / inKB).toFixed(3) : null,
              memMB: msg.memUsage?.rssMB ?? null,
              filename,
              error: msg.success ? null : (msg.error ?? 'unknown'),
            });
            const srcPath = (t?.file as any)?.sourcePath;
            if (typeof srcPath === 'string' && srcPath) {
              // Bucket by parent folder, not full file path — otherwise
              // the Sources: field in summary.txt becomes a 375-entry
              // list. path.dirname collapses every file in a flat
              // source to one entry; for nested sources it gives one
              // entry per leaf folder (still useful).
              conversionBenchmark.sourceFolders.add(path.dirname(srcPath));
            }
            // Advance the progress bar live as each task lands.
            advanceBytes(t?.file);
            completedFiles++;
            if (mainWindow) {
              mainWindow.webContents.send('files:copy:progress', progressPayload());
            }
          } else if (msg.type === 'batch-done') {
            // v2.0.15 — throughput per batch. wall-clock is the
            // batch's effective serial time; MB/s lets us compare
            // the converter against the raw drive write speed.
            const wallMs = Date.now() - batchStartedAt;
            const inMB = batchInputBytes / (1024 * 1024);
            const outMB = batchOutputBytes / (1024 * 1024);
            const throughputMBs = wallMs > 0 ? (inMB / (wallMs / 1000)).toFixed(2) : 'n/a';
            // v2.0.15 — per-batch "Batch done" with throughput +
            // memory disabled for shipped builds. The end-of-Fix
            // phase-complete line is the headline summary we keep.
            // log.info(`[Convert] Batch done — ${msg.succeeded}/${msg.total} succeeded, ${msg.failed} failed, in=${inMB.toFixed(1)}MB out=${outMB.toFixed(1)}MB throughput=${throughputMBs}MB/s${lastMemSnapshot ? `, child mem rss=${lastMemSnapshot.rssMB} MB heap=${lastMemSnapshot.heapUsedMB} MB external=${lastMemSnapshot.externalMB} MB` : ''}`);
            // v2.0.15 (Terry 2026-06-02) — push per-batch row into
            // the benchmark accumulator.
            conversionBenchmark.perBatch.push({
              ts: new Date().toISOString(),
              batch: batchIndex,
              succeeded: msg.succeeded,
              failed: msg.failed,
              total: msg.total,
              wallMs,
              inMB: +inMB.toFixed(2),
              outMB: +outMB.toFixed(2),
              throughputMBps: wallMs > 0 ? +(inMB / (wallMs / 1000)).toFixed(2) : null,
              childRssMB: lastMemSnapshot?.rssMB ?? null,
            });
            // Persistent worker — resolve immediately on batch-done.
            // No exit to wait for; the child stays alive for the
            // next batch.
            settleResolve();
          } else if (msg.type === 'fatal-error') {
            log.error(`[Convert] Worker fatal: ${msg.message}`);
            settleReject(new Error(`Conversion worker fatal: ${msg.message}`));
          }
        };
        const onUnexpectedExit = (code: number) => {
          // If the child dies mid-batch the batch-done message will
          // never arrive — reject so the surrounding flow doesn't
          // hang the whole Fix waiting forever.
          log.error(`[Convert] Persistent worker died mid-batch (code=${code}); failing batch #${batchIndex}`);
          settleReject(new Error(`Conversion worker died mid-batch (code=${code})`));
        };
        child.on('message', onMessage);
        child.once('exit', onUnexpectedExit);
        child.postMessage({
          type: 'convert-batch',
          tasks: childTasks,
          perTaskTimeoutMs: 60_000,
          // v2.0.15 — bumped from 2 → 4 tasks in parallel. Per-task
          // sharp.concurrency stays at 2, so total active libvips
          // threads = 8, matching a typical 8-core machine without
          // oversubscribing.
          parallelism: 4,
        });
      });

      // Clean up any spilled-buffer temp files we created.
      for (const tmp of tmpInputs) {
        try { await fs.promises.unlink(tmp); } catch { /* best-effort */ }
      }

      // Now process the child's results in the parent: EXIF write +
      // push to the overall results array. Same logic as the old
      // inline path, just sourced from childResults instead of an
      // in-process Promise.allSettled.
      const batchResults: Array<{ status: 'fulfilled' | 'rejected'; reason?: { message: string } }> = batch.map((_t, b) => {
        const r = childResults.get(b);
        if (!r) {
          return { status: 'rejected', reason: { message: 'Worker did not return a result for this task' } };
        }
        if (r.success) {
          return { status: 'fulfilled' };
        }
        return { status: 'rejected', reason: { message: r.error ?? 'Unknown conversion error' } };
      });

      // v2.0.15 (Terry 2026-05-31) — EXIF is now embedded by the
      // worker during the sharp encode pipeline. The previous post-
      // batch serial exiftool loop was the 35-min main-thread
      // bottleneck on Terry's 2,123-file PNG Fix (~1s per file ×
      // 2,123). This loop is now a fast no-IO result-mark.
      for (let b = 0; b < batch.length; b++) {
        const task = batch[b];
        const result = batchResults[b];
        if (result.status === 'fulfilled') {
          // v2.0.15 — per-file "Done" log disabled for shipped
          // builds; redundant with the per-file rich log (which
          // now also only fires on failure). Saves another ~2,123
          // lines per Fix.
          // console.log(`[Convert] Done: ${path.basename(task.convertedPath)}`);

          const targetExt = task.format === 'jpg' ? '.jpg' : '.png';
          task.file.newFilename = task.finalFilename.replace(/\.[^.]+$/, targetExt);
          usedFilenames.delete(path.join(task.subfolderPath, path.basename(task.destPath)).toLowerCase());
          usedFilenames.add(path.join(task.subfolderPath, task.file.newFilename).toLowerCase());

          // EXIF was either embedded in-pipeline by the worker (if
          // dateExif was set) or intentionally skipped (writeExif
          // off / confidence-gated). Either way the result row is
          // accurate without doing any further I/O here.
          results.push({
            success: true,
            sourcePath: task.file.sourcePath,
            destPath: task.convertedPath,
            finalFilename: task.file.newFilename,
            exifWritten: !!task.dateExif,
            exifSource: task.exifSourceLabel,
            exifError: undefined,
          });
        } else {
          console.warn(`[Convert] Failed: ${path.basename(task.destPath)}:`, result.reason);
          results.push({
            success: false,
            sourcePath: task.file.sourcePath,
            destPath: task.destPath,
            finalFilename: task.finalFilename,
            error: result.reason?.message || 'Conversion failed'
          });
        }
        // NOTE: progress is advanced in the child message handler
        // (per 'task-done'), so no completedFiles++ here. The user
        // sees the progress bar move in real time as each conversion
        // lands rather than in batch-sized jumps.
      }

      const batchWallMs = Date.now() - batchStartedAt;
      const succeeded = batchResults.filter(r => r.status === 'fulfilled').length;
      convertTotalWallMs += batchWallMs;
      convertFilesProcessed += batch.length;
      const avgPerFile = batch.length > 0 ? Math.round(batchWallMs / batch.length) : 0;
      // v2.0.15 — per-batch wall-clock log disabled for shipped
      // builds; the end-of-Fix phase-complete summary carries the
      // headline avg ms/file we actually look at.
      // console.log(`[Convert] Batch #${convertBatchCount} wall-clock ${batchWallMs}ms — ${succeeded}/${batch.length} ok, avg ${avgPerFile}ms/file`);

      await yieldToEventLoop();
    };

	for (let i = 0; i < files.length; i++) {
	  const file = files[i];

	  // Yield every file to keep window responsive
	  await yieldToEventLoop();

	  const fileStartTime = Date.now();
	  console.log(`[Fix] Processing file ${i + 1}/${files.length}: ${path.basename(file.sourcePath)}`);

	  // Check for cancellation
	  if (copyFilesCancelled) {
	    return { success: true, cancelled: true, results, copied: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, duplicatesRemoved, duplicateFiles, skippedExisting };
	  }
	  
      const skipDuplicates = data.settings?.skipDuplicates ?? true;
      
      // Get file content (needed for hash and writing)
      let fileBuffer: Buffer | null = null;
      let fileSize = 0;
      
      if (file.sourceType === 'zip') {
        const zipPath = zipPaths[file.sourcePath] || Object.keys(zipPaths)[0];
        if (!zipCache[zipPath]) {
          zipCache[zipPath] = new AdmZip(zipPath);
        }
        const zip = zipCache[zipPath];
        const entryName = file.sourcePath.replace(/^zip:\/\/[^/]+\//, '');
        const entry = zip.getEntry(entryName);
        if (entry) {
          fileBuffer = entry.getData();
          fileSize = fileBuffer.length;
        }
      } else {
        try {
          const stats = await fs.promises.stat(file.sourcePath);
          fileSize = stats.size;
        } catch {
          results.push({ success: false, sourcePath: file.sourcePath, destPath: '', finalFilename: file.newFilename, error: 'File not found' });
          advanceBytes(file);
          completedFiles++;
          if (mainWindow) mainWindow.webContents.send('files:copy:progress', progressPayload());
          continue;
        }
      }
      
      // Pre-copy duplicate check: heuristic mode (filename + size, no file read needed)
      // Hash-based duplicate check happens DURING copy to avoid reading the file twice
      let useHashForThisFile = false;
      if (skipDuplicates) {
        const forceHash = data.settings?.thoroughDuplicateMatching ?? false;
        useHashForThisFile = forceHash;
        if (!forceHash) {
          const sourcePathToClassify = file.originSourcePath || file.sourcePath;
          const classification = getSourceClassification(sourcePathToClassify);
          useHashForThisFile = classification.type !== 'network' && classification.type !== 'cloud-sync';
        }

        // For non-hash mode or large files, do heuristic check now (instant, no I/O)
        if (!useHashForThisFile || fileSize > LARGE_FILE_THRESHOLD) {
          const heuristicKey = `${path.basename(file.sourcePath)}|${fileSize}`;
          const existingFile = writtenHeuristics.get(heuristicKey);
          if (existingFile) {
            const wasExisting = existingFile.startsWith('[existing] ');
            duplicatesRemoved++;
            duplicateFiles.push({
              filename: path.basename(file.sourcePath),
              duplicateOf: existingFile.replace('[existing] ', ''),
              duplicateMethod: 'heuristic',
              wasExisting
            });
            advanceBytes(file);
            completedFiles++;
            if (mainWindow) mainWindow.webContents.send('files:copy:progress', progressPayload());
            continue; // Skip — duplicate found via heuristic
          }
          writtenHeuristics.set(heuristicKey, file.newFilename);
          useHashForThisFile = false; // Already handled
        }
      }

      // Collision handling: generate unique filename
      let finalFilename = file.newFilename;
      const ext = path.extname(finalFilename);
      const baseName = path.basename(finalFilename, ext);
      
      // Build subfolder path based on folderStructure setting
      let subfolderPath = '';
      if (data.folderStructure && file.derivedDate) {
        const date = new Date(file.derivedDate);
        const year = date.getFullYear().toString();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        
        if (data.folderStructure === 'year') {
          subfolderPath = year;
        } else if (data.folderStructure === 'year-month') {
          subfolderPath = path.join(year, month);
        } else if (data.folderStructure === 'year-month-day') {
          subfolderPath = path.join(year, month, day);
        }
      }
      
      // targetDir is where the per-file write actually lands. When
      // staging this is staging/<subfolderPath>; otherwise it's the
      // real destination/<subfolderPath>. Robocopy will recreate the
      // same subfolder layout at the real destination at the end.
      const targetDir = subfolderPath ? path.join(writeRoot, subfolderPath) : writeRoot;

      // Ensure target directory exists (cheap mkdir on local staging
      // disk when staging; same as before otherwise). Wrap with the
      // extended-length prefix so Fix copies into deeply-nested year-
      // folder paths under a long library-drive root don't fail with
      // MAX_PATH (260-char) errors on Windows. See long-path.ts.
      await fs.promises.mkdir(toLongPath(targetDir), { recursive: true });
      
      // Cross-run duplicate: if exact target filename existed BEFORE this run, skip it
      if (skipDuplicates && preExistingFiles.has(path.join(subfolderPath, finalFilename).toLowerCase())) {
        skippedExisting++;
        duplicateFiles.push({ 
          filename: path.basename(file.sourcePath), 
          duplicateOf: file.newFilename,
          duplicateMethod: 'heuristic',
          wasExisting: true
        });
        usedFilenames.add(path.join(subfolderPath, finalFilename).toLowerCase());
        advanceBytes(file);
        completedFiles++;
        if (mainWindow) mainWindow.webContents.send('files:copy:progress', progressPayload());
        continue;
      }

      // When converting formats, also check for collisions against the target extension
      // e.g., IMG_001.jpg and IMG_001.tif would both become IMG_001.png
      const willConvert = photoFormat !== 'original' && (() => {
        const srcExt = path.extname(finalFilename).toLowerCase();
        const photoExts = new Set(['.jpg','.jpeg','.png','.bmp','.tiff','.tif','.webp','.heic','.heif','.gif','.avif']);
        const targetExt = photoFormat === 'jpg' ? '.jpg' : '.png';
        return photoExts.has(srcExt) && srcExt !== targetExt && !(srcExt === '.jpeg' && targetExt === '.jpg');
      })();
      const convertedExt = willConvert ? (photoFormat === 'jpg' ? '.jpg' : '.png') : null;

      // v2.0.15 (Terry 2026-05-31) — infinite-loop fix. The
      // converted-ext collision checks (Cond C + D below) used the
      // pre-loop `baseName + convertedExt`, which never changes as
      // the loop appends _001, _002, ... to `finalFilename`. Once
      // any earlier file in the run reserved `<base>.<convExt>`
      // (via the post-loop usedFilenames.add at line 5557 below),
      // EVERY subsequent file with the same derived date+CF stem
      // entered an infinite loop and froze the main thread.
      // Reproduced deterministically on Terry's 2,123-file PNG Fix
      // at file 196 (IMG_20160103_185837~2.jpg) — a near-duplicate
      // sharing EXIF date with file 195, hence the same derived
      // destination stem. The fix recomputes the converted-ext stem
      // from the CURRENT finalFilename each iteration so it advances
      // with the counter and the loop terminates.
      let counter = 1;
      const convertedFilenameFor = (fn: string) => convertedExt ? fn.replace(/\.[^.]+$/, convertedExt) : fn;
      while (usedFilenames.has(path.join(subfolderPath, finalFilename).toLowerCase()) ||
             realDestFileExists(path.join(subfolderPath, finalFilename)) ||
             (convertedExt && usedFilenames.has(path.join(subfolderPath, convertedFilenameFor(finalFilename)).toLowerCase())) ||
             (convertedExt && counter === 1 && realDestFileExists(path.join(subfolderPath, convertedFilenameFor(finalFilename))))) {
        finalFilename = `${baseName}_${String(counter).padStart(3, '0')}${ext}`;
        counter++;
        // Belt-and-braces — even with the per-iteration stem fix
        // above, never let this loop run away. 10 000 iterations
        // is unimaginable for a real Fix; if we hit it, something
        // upstream is broken and we'd rather log + bail than
        // freeze the main thread.
        if (counter > 10_000) {
          log.error(`[Fix] Filename-collision loop runaway for ${file.sourcePath} (baseName=${baseName}); bailing out at counter=${counter}`);
          break;
        }
      }
      usedFilenames.add(path.join(subfolderPath, finalFilename).toLowerCase());
      // Also reserve the converted filename to prevent future collisions
      if (convertedExt) {
        const convertedName = finalFilename.replace(/\.[^.]+$/, convertedExt);
        usedFilenames.add(path.join(subfolderPath, convertedName).toLowerCase());
      }
      
      const destPath = path.join(targetDir, finalFilename);
      
      // SYNC outer try wraps the conversion-enqueue and zip-error
      // branches only. The real-copy branch hands off to the parallel
      // pool (see the IIFE further down) — that path has its own
      // try/catch inside the IIFE.
      try {
        // Determine the source data for this file
        const isZipWithBuffer = file.sourceType === 'zip' && fileBuffer;
        const isZipWithoutBuffer = file.sourceType === 'zip' && !fileBuffer;

        if (isZipWithoutBuffer) {
          results.push({ success: false, sourcePath: file.sourcePath, destPath, finalFilename, error: 'Entry not found in zip' });
          advanceBytes(file);
          completedFiles++;
          if (mainWindow) mainWindow.webContents.send('files:copy:progress', progressPayload());
          continue;
        }

        // If converting format, go directly from source → converted destination
        if (willConvert) {
          const targetExt = photoFormat === 'jpg' ? '.jpg' : '.png';
          const convertedPath = destPath.replace(/\.[^.]+$/, targetExt);
          // v2.0.15 — per-file "Queuing" log disabled for shipped
          // builds; pre-existing diagnostic that produced ~2,123
          // lines per Fix without supporting any user-facing
          // debugging story.
          // console.log(`[Convert] Queuing ${path.basename(file.sourcePath)} → ${path.basename(convertedPath)}`);

          // v2.0.15 (Terry 2026-05-31) — pre-compute the EXIF date
          // string + source-label on the main thread (cheap), then
          // hand them to the worker so the encode pipeline can
          // embed them directly. Mirrors the gating logic that used
          // to live inside writeExifDate(): only embed if the master
          // writeExif setting is on AND the per-confidence sub-toggle
          // for this file's confidence level is on. Invalid dates
          // (pre-1971 / future) get skipped here for safety.
          let dateExifStr: string | undefined;
          let exifSourceLabel: string | undefined;
          if (
            data.settings?.writeExif &&
            file.derivedDate &&
            file.dateConfidence &&
            (
              (file.dateConfidence === 'confirmed' && (data.settings.exifWriteConfirmed ?? true)) ||
              (file.dateConfidence === 'recovered' && (data.settings.exifWriteRecovered ?? true)) ||
              (file.dateConfidence === 'marked' && (data.settings.exifWriteMarked ?? false))
            )
          ) {
            const d = new Date(file.derivedDate);
            const year = d.getFullYear();
            const validDate = !isNaN(d.getTime()) && year >= 1971 && d.getTime() <= Date.now() + 24 * 60 * 60 * 1000;
            if (validDate) {
              const pad = (n: number) => String(n).padStart(2, '0');
              dateExifStr = `${year}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
              const conf = file.dateConfidence;
              exifSourceLabel = `${conf.charAt(0).toUpperCase() + conf.slice(1)} (${file.dateSource || 'Unknown'})`;
            }
          }

          const sourceInput = isZipWithBuffer ? fileBuffer! : file.sourcePath;
          pendingConversions.push({
            sourceInput,
            convertedPath,
            format: photoFormat as 'jpg' | 'png',
            fileIndex: i,
            destPath,
            subfolderPath,
            file,
            finalFilename,
            dateExif: dateExifStr,
            exifSourceLabel,
          });

          // Flush when batch is full
          if (pendingConversions.length >= CONVERSION_BATCH_SIZE) {
            await flushConversions();
          }

          // Skip EXIF and results for now — handled after loop for converted files
          continue;
        }

        // ─── Non-conversion path — launch into the parallel copy pool ─
        // Everything from here to the end of this iteration runs
        // CONCURRENTLY with up to 3 other in-flight copies. The
        // sequential for-loop continues issuing the next file as
        // soon as a slot opens.
        await waitForCopySlot();

        // Capture the per-iteration state the IIFE needs. JS closures
        // capture by reference, so plain identifier captures of
        // `file`, `destPath`, `finalFilename`, etc. are fine — each
        // for-iteration creates its own `const` bindings.
        const indexForLog = i + 1;
        const fileForCopy = file;
        const destPathForCopy = destPath;
        const finalFilenameForCopy = finalFilename;
        const subfolderPathForCopy = subfolderPath;
        const useHashForCopy = useHashForThisFile;
        const isZipBufferCopy = isZipWithBuffer;
        const skipDuplicatesForCopy = skipDuplicates;

        const copyWork: Promise<void> = (async () => {
          const copyStartedAt = Date.now();
          let currentDestPath = destPathForCopy;
          let currentFinalFilename = finalFilenameForCopy;
          try {
            // ── Copy + hash ──────────────────────────────────────────
            let copyHash: string | null = null;
            if (isZipBufferCopy) {
              // v2.0.15 — switched from fs.writeFileSync (blocking) to
              // fs.promises.writeFile so the pool's parallelism
              // actually parallelises the in-memory ZIP-buffer branch
              // too. Rare path in practice; most ZIPs get extracted
              // up front by extract-worker and arrive as folder files.
              if (skipDuplicatesForCopy && useHashForCopy) {
                copyHash = crypto.createHash('sha256').update(fileBuffer!).digest('hex');
              }
              await fs.promises.writeFile(currentDestPath, fileBuffer!);
            } else {
              copyHash = await streamCopyFile(fileForCopy.sourcePath, currentDestPath, skipDuplicatesForCopy && useHashForCopy);
            }

            // ── Hash-based duplicate post-check ──────────────────────
            // Map.get + Map.set are sync — no event-loop yield
            // between the check and the reserve, so a second IIFE
            // running the same hash through here will SEE the first
            // one's set() call (whichever lands first).
            if (skipDuplicatesForCopy && useHashForCopy && copyHash) {
              const existingFile = writtenHashes.get(copyHash);
              if (existingFile) {
                try { await fs.promises.unlink(currentDestPath); } catch {}
                const wasExisting = existingFile.startsWith('[existing] ');
                duplicatesRemoved++;
                duplicateFiles.push({
                  filename: path.basename(fileForCopy.sourcePath),
                  duplicateOf: existingFile.replace('[existing] ', ''),
                  duplicateMethod: 'hash',
                  wasExisting,
                });
                advanceBytes(fileForCopy);
                completedFiles++;
                if (mainWindow) mainWindow.webContents.send('files:copy:progress', progressPayload());
                return;
              }
              writtenHashes.set(copyHash, fileForCopy.newFilename);
            }

            console.log(`[Fix] File ${indexForLog} copy+hash took ${Date.now() - copyStartedAt}ms`);

            // ── Extension normalisation (.jpeg → .jpg, .tiff → .tif) ─
            if (photoFormat === 'original') {
              const srcExt = path.extname(currentDestPath).toLowerCase();
              const normMap: Record<string, string> = { '.jpeg': '.jpg', '.tiff': '.tif' };
              if (normMap[srcExt]) {
                const normPath = currentDestPath.replace(/\.[^.]+$/, normMap[srcExt]);
                try {
                  await fs.promises.rename(currentDestPath, normPath);
                  const newFinal = currentFinalFilename.replace(/\.[^.]+$/, normMap[srcExt]);
                  usedFilenames.delete(path.join(subfolderPathForCopy, path.basename(currentDestPath)).toLowerCase());
                  usedFilenames.add(path.join(subfolderPathForCopy, newFinal).toLowerCase());
                  currentDestPath = normPath;
                  currentFinalFilename = newFinal;
                } catch { /* normalisation is best-effort */ }
              }
            }

            // ── EXIF write ───────────────────────────────────────────
            let exifWritten = false;
            let exifSource: string | undefined;
            let exifError: string | undefined;
            if (data.settings?.writeExif && fileForCopy.derivedDate && fileForCopy.dateConfidence) {
              const derivedDate = new Date(fileForCopy.derivedDate);
              const exifResult = await writeExifDate(
                currentDestPath,
                derivedDate,
                fileForCopy.dateConfidence,
                fileForCopy.dateSource || 'Unknown',
                {
                  writeExif: data.settings.writeExif,
                  exifWriteConfirmed: data.settings.exifWriteConfirmed ?? true,
                  exifWriteRecovered: data.settings.exifWriteRecovered ?? true,
                  exifWriteMarked: data.settings.exifWriteMarked ?? false,
                }
              );
              exifWritten = exifResult.written;
              exifSource = exifResult.source;
              if (!exifResult.success) {
                exifError = exifResult.error;
              }
            }

            console.log(`[Fix] File ${indexForLog} total took ${Date.now() - copyStartedAt}ms (exif=${exifWritten})`);
            results.push({
              success: true,
              sourcePath: fileForCopy.sourcePath,
              destPath: currentDestPath,
              finalFilename: currentFinalFilename,
              exifWritten,
              exifSource,
              exifError,
            });
            advanceBytes(fileForCopy);
            completedFiles++;
            if (mainWindow) {
              mainWindow.webContents.send('files:copy:progress', progressPayload());
            }
          } catch (err) {
            results.push({
              success: false,
              sourcePath: fileForCopy.sourcePath,
              destPath: currentDestPath,
              finalFilename: currentFinalFilename,
              error: (err as Error).message,
            });
            advanceBytes(fileForCopy);
            completedFiles++;
            if (mainWindow) {
              mainWindow.webContents.send('files:copy:progress', progressPayload());
            }
          }
        })();

        inFlightCopies.add(copyWork);
        copyWork.finally(() => { inFlightCopies.delete(copyWork); });
      } catch (err) {
        // Errors from the sync-prep + conversion-enqueue + ZIP-error
        // branches above (the parallel-pool branch handles its own
        // errors inside the IIFE).
        results.push({ success: false, sourcePath: file.sourcePath, destPath, finalFilename, error: (err as Error).message });
        advanceBytes(file);
        completedFiles++;
        if (mainWindow) {
          mainWindow.webContents.send('files:copy:progress', progressPayload());
        }
      }

    }

    // v2.0.15 — DRAIN THE PARALLEL COPY POOL before any post-loop
    // work (conversion flush, network mirror, audit log). All file
    // results need to land in `results` first so flushConversions
    // and the report writers see the complete picture.
    if (inFlightCopies.size > 0) {
      log.info(`[Fix] Draining copy pool — ${inFlightCopies.size} files still in flight`);
      await Promise.all([...inFlightCopies]);
      log.info(`[Fix] Copy pool drained`);
    }

    // v2.0.15 — stop the liveness heartbeat now that nothing's
    // running in the pool. The finally clause clears it again as a
    // safety net if any earlier error skipped this happy path.
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }

    // Flush any remaining queued conversions (EXIF is written inside flushConversions)
    await flushConversions();

    // v2.0.15 — shut the persistent conversion worker down so the OS
    // reclaims its libvips memory pool. Best-effort: if the worker
    // already died (fatal-error, OOM, kill), the helper resolves
    // immediately. Wrapped in try/catch so a shutdown hiccup never
    // breaks the Fix's success path.
    try { await shutdownPersistentConvertChild(); } catch (e) { log.warn(`[Convert] shutdown raised: ${(e as Error).message}`); }

    // v2.0.15 — aggregate conversion telemetry. Logged unconditionally
    // even when 0 conversions happened (originals-only Fix) so we can
    // tell apart "no convert phase" from "convert phase silently
    // broken". Wall-clock totals are the sum of the per-batch wall
    // clocks; phase-elapsed is the gap from the first batch flush to
    // the last (includes time spent queuing between flushes).
    const convertPhaseElapsed = Date.now() - convertPhaseStartedAt;
    const avgOverall = convertFilesProcessed > 0 ? Math.round(convertTotalWallMs / convertFilesProcessed) : 0;
    console.log(`[Convert] Phase complete — batches=${convertBatchCount}, files=${convertFilesProcessed}, wall=${convertTotalWallMs}ms, phase-elapsed=${convertPhaseElapsed}ms, avg=${avgOverall}ms/file`);

    // ── Mirror staging → real destination ──────────────────────────
    // If we wrote to staging, push the whole tree to the real
    // network destination now. Robocopy /MT:16 parallelises the
    // network round-trips that the per-file loop intentionally
    // avoided. After mirror succeeds, rewrite each result's destPath
    // from staging → real destination so the renderer / database
    // store the path the user actually sees on their drive.
    //
    // preserveStagingForRecovery (declared above the try) flips ON
    // if the mirror step fails — the finally block reads it and
    // skips cleanup so the user has a local copy to retry / rescue
    // from. Otherwise staging is always cleaned up.
    if (useStaging && stagingPath) {
      // Skip mirror if user cancelled mid-staging — no point pushing
      // a half-staged tree. Cleanup happens in finally.
      if (copyFilesCancelled) {
        console.log(`[Fix] User cancelled before mirror — skipping robocopy.`);
      } else {
        if (mainWindow) {
          mainWindow.webContents.send('files:copy:phase', {
            phase: 'mirror',
            message: 'Uploading staged files to network destination via robocopy /MT:16…',
          });
        }
        const successCount = results.filter(r => r.success).length;
        let mirroredCount = 0;
        const mirrorAbort = { cancelled: false };
        const cancelPoll = setInterval(() => {
          if (copyFilesCancelled) mirrorAbort.cancelled = true;
        }, 250);
        const mirrorResult = await runRobocopyMirror(
          stagingPath,
          destinationPath,
          () => {
            mirroredCount++;
            if (mainWindow) {
              mainWindow.webContents.send('files:copy:mirror-progress', {
                filesMirrored: mirroredCount,
                totalToMirror: successCount,
              });
            }
          },
          mirrorAbort
        );
        clearInterval(cancelPoll);

        if (!mirrorResult.success) {
          // Mirror failed. Flag staging for preservation so the
          // finally block doesn't wipe it, then surface the path
          // so the user can retry / rescue manually.
          preserveStagingForRecovery = true;
          console.error(`[Fix] Robocopy mirror failed (exit ${mirrorResult.exitCode}):`, mirrorResult.stderr);
          return {
            success: false,
            error: `Network upload failed (robocopy exit code ${mirrorResult.exitCode}). ${mirrorResult.stderr ? mirrorResult.stderr + '. ' : ''}Your files have been prepared locally at ${stagingPath} — you can retry the network step manually or copy from there. PDR has not modified anything at the destination.`,
            results,
            copied: 0,
            failed: results.length,
            duplicatesRemoved,
            duplicateFiles,
            skippedExisting,
          };
        }

        console.log(`[Fix] Robocopy mirror complete (exit ${mirrorResult.exitCode}, ${mirroredCount} files reported).`);

        // Rewrite result destPaths from staging → real destination
        // so downstream consumers (run records, renderer toasts,
        // open-folder action) see the path the user actually has.
        for (const r of results) {
          if (r.destPath && r.destPath.startsWith(stagingPath)) {
            r.destPath = path.join(destinationPath, path.relative(stagingPath, r.destPath));
          }
        }
      }
    }

    // ── Takeout enrichment gather (v2.0.8) ────────────────────────
    // MUST run before the temp-dir cleanup below: we need PDR_Temp's
    // sidecars + per-folder metadata.json to still be on disk. Stashes
    // the result in pendingTakeoutEnrichments keyed by destinationPath
    // so search:indexRun can finish the album write after indexed_files
    // rows exist. Wrapped in try/catch — a parse failure here must
    // never block a successful Fix completion.
    try {
      const enrichment = gatherTakeoutEnrichmentFromFixResults(results);
      if (enrichment) {
        pendingTakeoutEnrichments.set(destinationPath, enrichment);
        console.log(
          `[Takeout] Gathered enrichment for ${enrichment.files.length} file(s) ` +
          `across Takeout album folders (dest: ${destinationPath}).`
        );
      }
    } catch (enrichErr) {
      console.warn(`[Takeout] Enrichment gather failed (continuing):`, enrichErr);
    }

    // ── Post-copy temp-dir cleanup ────────────────────────────────
    // For every active temp extraction dir whose contents WERE the
    // source of files we just copied, delete it now. This frees the
    // per-Takeout extracted payload (~50 GB for a max-size Google
    // Takeout) immediately on successful completion, instead of
    // letting it accumulate until app quit.
    //
    // Safety:
    //  • Only runs on a successful return path. The cancelled exit at
    //    the start of the loop (and the catch block below) both skip
    //    this, so the user can still retry against the still-extracted
    //    files if a copy was interrupted or errored.
    //  • Only deletes a temp dir if at least one file in THIS copy
    //    operation was sourced from inside it — so a user who
    //    analysed two zips but only fixed one keeps the other zip's
    //    extraction intact for its own future fix run.
    //  • cleanupTempDir() is best-effort and won't throw if a file is
    //    locked — the existing before-quit + startup-orphan sweeps
    //    are the safety net for the rare locked-file case.
    // v2.0.11 (revised) — DO NOT delete the extracted temp dirs here.
    // The Fix Complete modal then asks the user "Clear sources?" — if
    // they pick Keep Sources, the source row stays in the menu and is
    // expected to remain functional (re-analyze, extra Fix, etc.).
    // Earlier v2.0.11 wiped the temp dir the moment Fix succeeded,
    // which broke the Keep-Sources path (source row alive but its
    // backing extraction gone — Terry caught this 2026-05-23).
    // Cleanup now happens via the existing user-driven paths:
    //   • Clear Sources modal → pdr-clear-sources event → reapTempDirsForSources
    //   • Manual remove from Source Menu → analysis:cleanupTempDirForSource
    //   • App quit / launch orphan sweep → catch-all safety net
    // Disk space comes back when the user explicitly says they're done
    // with the source, not as a hidden side effect of a successful Fix.

    return { success: true, results, copied: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, duplicatesRemoved, duplicateFiles, skippedExisting };
  } catch (error) {
    return { success: false, error: (error as Error).message, results, duplicatesRemoved, duplicateFiles };
  } finally {
    // v2.0.15 — safety net: if the Fix bailed before reaching the
    // post-loop shutdown call, the persistent conversion worker is
    // still alive. Kill it here so we don't leak a child process
    // (and its libvips memory) past the Fix's lifetime. No-op when
    // the worker was never spawned (originals-only Fix) or was
    // already cleanly shut down on the happy path.
    try { await shutdownPersistentConvertChild(); } catch { /* best-effort */ }

    // v2.0.15 — same safety net for the progress-heartbeat timer.
    // If we threw before reaching the post-drain clearInterval, the
    // 1Hz timer would otherwise fire forever (holding mainWindow
    // + inFlightCopies refs, preventing GC of either).
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }

    // Clean up staging dir on the way out — success, cancellation,
    // or thrown error. Skipped only when the mirror step flipped
    // preserveStagingForRecovery ON so the user can salvage the
    // local copy after a failed network push. Wrapped in try/catch
    // so a missing dir never masks the real return value.
    if (useStaging && stagingPath && !preserveStagingForRecovery) {
      try {
        await fs.promises.rm(stagingPath, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.warn(`[Fix] Failed to clean up staging dir ${stagingPath}:`, cleanupErr);
      }
    } else if (useStaging && stagingPath && preserveStagingForRecovery) {
      console.log(`[Fix] Staging dir preserved for manual recovery: ${stagingPath}`);
    }
  }
});

ipcMain.handle('play-completion-sound', async () => {
  try {
	const soundPath = app.isPackaged
	  ? path.join(process.resourcesPath, 'assets', 'pdr_success_bell.wav')
	  : path.join(__dirname, '../client/public/assets/pdr_success_bell.wav');
    
    // Use PowerShell to play the sound on Windows
    if (process.platform === 'win32') {
      const { exec } = await import('child_process');
      exec(`powershell -c "(New-Object Media.SoundPlayer '${soundPath.replace(/'/g, "''")}').PlaySync()"`);
    } else {
      shell.beep();
    }
  } catch (error) {
    console.error('Error playing completion sound:', error);
    shell.beep();
  }
});

ipcMain.handle('report:load', async (_event, reportId: string) => {
  try {
    const report = await loadReport(reportId);
    return { success: true, data: report };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('report:loadLatest', async () => {
  try {
    const report = await loadLatestReport();
    return { success: true, data: report };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('report:list', async () => {
  try {
    const reports = await listReports();
    return { success: true, data: reports };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('report:exportCSV', async (_event, reportId: string, folderPath?: string) => {
  try {
    const report = await loadReport(reportId);
    if (!report) {
      return { success: false, error: 'Report not found' };
    }
    const csv = exportReportToCSV(report);
    const defaultFilename = getExportFilename(report, 'csv');

    if (folderPath) {
      // New mode: save directly to specified folder (from FolderBrowserModal)
      const filePath = path.join(folderPath, defaultFilename);
      fs.writeFileSync(filePath, csv, 'utf-8');
      return { success: true, filePath };
    }

    // Legacy fallback: native dialog
    const defaultDir = report.destinationPath || app.getPath('documents');
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export Report as CSV',
      defaultPath: path.join(defaultDir, defaultFilename),
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    });

    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, csv, 'utf-8');
      return { success: true, filePath: result.filePath };
    }
    return { success: false, error: 'Export cancelled' };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('report:exportTXT', async (_event, reportId: string, folderPath?: string) => {
  try {
    const report = await loadReport(reportId);
    if (!report) {
      return { success: false, error: 'Report not found' };
    }
    const txt = exportReportToTXT(report);
    const defaultFilename = getExportFilename(report, 'txt');

    if (folderPath) {
      // New mode: save directly to specified folder (from FolderBrowserModal)
      const filePath = path.join(folderPath, defaultFilename);
      fs.writeFileSync(filePath, txt, 'utf-8');
      return { success: true, filePath };
    }

    // Legacy fallback: native dialog
    const defaultDir = report.destinationPath || app.getPath('documents');
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export Report as TXT',
      defaultPath: path.join(defaultDir, defaultFilename),
      filters: [{ name: 'Text Files', extensions: ['txt'] }]
    });

    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, txt, 'utf-8');
      return { success: true, filePath: result.filePath };
    }
    return { success: false, error: 'Export cancelled' };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

// Regenerate the catalogue on demand for a given destination
ipcMain.handle('report:regenerateCatalogue', async (_event, destinationPath: string) => {
  try {
    const settings = getSettings();
    if (!settings.autoSaveCatalogue) {
      return { success: false, error: 'Auto-catalogue is disabled' };
    }
    // Skip silently if the destination folder no longer exists. Users
    // delete or rename old test/Fix folders all the time, and the
    // Reports History modal triggers this handler once per distinct
    // destination on every open. Without this guard, missing dests
    // each emit a renderer warning AND kick off a sharp pipeline that
    // dispatches dozens of file-not-found requests, which together
    // produce the `net::ERR_FAILED` storm that was making Memories
    // and PM feel frozen for 5–8 minutes after launch. Returning a
    // neutral { success: true, skipped: true } keeps the renderer's
    // log clean and means valid destinations still regen normally.
    if (!fs.existsSync(destinationPath)) {
      return { success: true, skipped: true, reason: 'destination-missing' };
    }
    const result = await writeCatalogue(destinationPath);
    return result;
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

// Get the default export folder for manual report exports (Documents folder)
ipcMain.handle('report:getDefaultExportPath', async (_event, reportId: string) => {
  try {
    return { success: true, path: app.getPath('documents') };
  } catch {
    return { success: false, path: '' };
  }
});

ipcMain.handle('set-zoom', (_event, zoomFactor: number) => {
  if (mainWindow) {
    mainWindow.webContents.setZoomFactor(zoomFactor);
  }
});

ipcMain.handle('set-title-bar-color', (_event, isDark: boolean) => {
  if (mainWindow && process.platform === 'win32') {
    mainWindow.setTitleBarOverlay({
      color: isDark ? '#2d2453' : '#a99cff',
      symbolColor: '#ffffff',
    });
  }
  // Sync theme to People window if open
  if (peopleWindow && !peopleWindow.isDestroyed()) {
    peopleWindow.webContents.send('people:themeChange', isDark);
  }
});

// Settings IPC handlers
ipcMain.handle('settings:get', async () => {
  return getSettings();
});

ipcMain.handle('settings:set', async (_event, key: keyof PDRSettings, value: PDRSettings[keyof PDRSettings]) => {
  setSetting(key, value);
  return { success: true };
});

ipcMain.handle('settings:setAll', async (_event, settings: Partial<PDRSettings>) => {
  setSettings(settings);
  return { success: true };
});

ipcMain.handle('settings:resetToDefaults', async () => {
  const { resetToOptimisedDefaults } = await import('./settings-store.js');
  resetToOptimisedDefaults();
  return { success: true };
});

// ─── v2.0.15 Phase 5+6 (Terry 2026-06-06) — Enhance worker manager.
// Lazy-spawns electron/enhance-worker.cjs on first AI enhance request,
// keeps it alive across photos. Worker holds the loaded ONNX sessions
// (~400 MB resident when both models in use) so subsequent presses
// don't pay the ~500ms-1s model-load cost.
//
// Pattern matches ai-manager.ts's ensureWorker(): single Worker
// thread, lazy-spawned, persistent until app exit (Free AI memory
// action planned for v2.0.16 polish to allow manual unload).

let enhanceWorker: import('worker_threads').Worker | null = null;
const enhancePending = new Map<string, {
  resolve: (info: { outputPath: string; facesProcessed?: number }) => void;
  reject: (err: Error) => void;
  onProgress?: (phase: string, percent: number) => void;
}>();

async function ensureEnhanceWorker(): Promise<import('worker_threads').Worker> {
  if (enhanceWorker) return enhanceWorker;

  const { Worker } = await import('worker_threads');
  const workerPath = path.join(__dirname, 'enhance-worker.cjs');
  const userData = app.getPath('userData');
  const codeformerPath = path.join(userData, 'ai-models', 'codeformer', 'codeformer.onnx');
  const realesrganPath = path.join(userData, 'ai-models', 'realesrgan', 'RealESRGAN_x4plus.fp16.onnx');

  enhanceWorker = new Worker(workerPath, {
    workerData: { codeformerPath, realesrganPath },
  });

  enhanceWorker.on('message', (msg: any) => {
    if (!msg || !msg.requestId) return;
    const pending = enhancePending.get(msg.requestId);
    if (!pending) return;
    if (msg.type === 'progress') {
      pending.onProgress?.(msg.phase, msg.percent);
    } else if (msg.type === 'done') {
      enhancePending.delete(msg.requestId);
      pending.resolve({ outputPath: msg.outputPath, facesProcessed: msg.facesProcessed });
    } else if (msg.type === 'error') {
      enhancePending.delete(msg.requestId);
      pending.reject(new Error(msg.error || 'Enhance worker failed'));
    }
  });

  enhanceWorker.on('error', (err) => {
    log.error(`[enhance-worker] worker error: ${err.message}`);
    // Reject every pending request, then drop the worker so the next
    // request lazy-spawns a fresh one.
    for (const [, pending] of enhancePending) pending.reject(err);
    enhancePending.clear();
    try { enhanceWorker?.terminate(); } catch {}
    enhanceWorker = null;
  });

  enhanceWorker.on('exit', (code) => {
    log.info(`[enhance-worker] worker exited code=${code}`);
    if (code !== 0) {
      for (const [, pending] of enhancePending) pending.reject(new Error(`enhance-worker exited code=${code}`));
      enhancePending.clear();
    }
    enhanceWorker = null;
  });

  return enhanceWorker;
}

ipcMain.handle('viewer:enhanceFaces', async (event, req: { filePath: string; fidelity?: number }) => {
  try {
    if (!req?.filePath || !fs.existsSync(req.filePath)) {
      return { success: false, error: 'Source file not found.' };
    }

    // Verify CodeFormer model is installed.
    const installer = await import('./ai-model-installer.js');
    if (installer.getInstallState('codeformer') !== 'installed') {
      return { success: false, error: 'CodeFormer is not installed.', requiresInstall: 'codeformer' };
    }

    // Look up cached face_detections for this file from search-database.
    const db = (await import('./search-database.js')).getDb();
    const fileRow = db
      .prepare(`SELECT id FROM indexed_files WHERE file_path = ? LIMIT 1`)
      .get(req.filePath) as { id: number } | undefined;

    if (!fileRow) {
      return { success: false, error: 'This photo is not in the library index. Add it via a Fix run first.' };
    }

    const faceRows = db
      .prepare(`SELECT box_x AS x, box_y AS y, box_width AS w, box_height AS h FROM face_detections WHERE file_id = ?`)
      .all(fileRow.id) as Array<{ x: number; y: number; w: number; h: number }>;

    if (!faceRows || faceRows.length === 0) {
      return {
        success: false,
        error: 'No faces detected on this photo yet.',
        requiresAnalysis: true,
        fileId: fileRow.id,
      };
    }

    // Output to a temp file. Caller (viewer) decides whether to save
    // it permanently via viewer:saveEnhanced with sourceOverride set
    // to this path.
    const tmpDir = path.join(app.getPath('temp'), 'pdr-enhance');
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
    const requestId = `cf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const outputPath = path.join(tmpDir, `${requestId}.jpg`);

    const worker = await ensureEnhanceWorker();

    return await new Promise((resolve) => {
      enhancePending.set(requestId, {
        resolve: (info) => resolve({
          success: true,
          outputPath: info.outputPath,
          facesProcessed: info.facesProcessed ?? 0,
        }),
        reject: (err) => resolve({ success: false, error: err.message }),
        onProgress: (phase, percent) => {
          try { event.sender.send('viewer:enhanceProgress', { kind: 'faces', phase, percent }); } catch {}
        },
      });

      worker.postMessage({
        type: 'enhance-faces',
        requestId,
        sourcePath: req.filePath,
        outputPath,
        faceBoxes: faceRows,
        fidelity: typeof req.fidelity === 'number' ? req.fidelity : 0.5,
      });
    });
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('viewer:enhanceWholeImage', async (event, req: { filePath: string; tileSize?: number }) => {
  try {
    if (!req?.filePath || !fs.existsSync(req.filePath)) {
      return { success: false, error: 'Source file not found.' };
    }
    const installer = await import('./ai-model-installer.js');
    if (installer.getInstallState('realesrgan') !== 'installed') {
      return { success: false, error: 'Real-ESRGAN is not installed.', requiresInstall: 'realesrgan' };
    }

    const tmpDir = path.join(app.getPath('temp'), 'pdr-enhance');
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
    const requestId = `re-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const outputPath = path.join(tmpDir, `${requestId}.jpg`);

    const worker = await ensureEnhanceWorker();

    return await new Promise((resolve) => {
      enhancePending.set(requestId, {
        resolve: (info) => resolve({ success: true, outputPath: info.outputPath }),
        reject: (err) => resolve({ success: false, error: err.message }),
        onProgress: (phase, percent) => {
          try { event.sender.send('viewer:enhanceProgress', { kind: 'upscale', phase, percent }); } catch {}
        },
      });
      worker.postMessage({
        type: 'enhance-upscale',
        requestId,
        sourcePath: req.filePath,
        outputPath,
        tileSize: req.tileSize ?? 256,
      });
    });
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─── v2.0.15 Phase 4 (Terry 2026-06-06) — AI Photo Enhancement model installer
// IPC. Settings → AI → Photo Enhancement cards call these.
//
// State events: every state change broadcasts on 'ai-models:stateChanged'
// so multiple Settings windows / surfaces stay in sync without polling.

ipcMain.handle('ai-models:list', async () => {
  const { MODELS, getInstallState, getDownloadProgress } = await import('./ai-model-installer.js');
  const out: Record<string, any> = {};
  for (const key of Object.keys(MODELS) as Array<keyof typeof MODELS>) {
    out[key] = {
      spec: MODELS[key],
      state: getInstallState(key),
      progress: getDownloadProgress(key),
    };
  }
  return { success: true, models: out };
});

ipcMain.handle('ai-models:install', async (_event, key: 'codeformer' | 'realesrgan') => {
  try {
    const installer = await import('./ai-model-installer.js');
    if (!installer.MODELS[key]) {
      return { success: false, error: `Unknown model key: ${key}` };
    }
    // Broadcast start immediately so the card flips to "Downloading 0%"
    // without waiting for the first progress tick.
    try {
      mainWindow?.webContents.send('ai-models:stateChanged', {
        key, state: 'downloading', progress: { receivedBytes: 0, totalBytes: 0, percent: 0 },
      });
    } catch { /* non-fatal */ }

    await installer.installModel(key, {
      onProgress: (info) => {
        try {
          mainWindow?.webContents.send('ai-models:stateChanged', {
            key, state: 'downloading', progress: info,
          });
        } catch { /* non-fatal */ }
      },
    });

    // Final broadcast — flip to 'installed'. UI uses this to enable
    // the corresponding Viewer Enhance AI buttons.
    try {
      mainWindow?.webContents.send('ai-models:stateChanged', {
        key, state: 'installed', progress: null,
      });
    } catch { /* non-fatal */ }

    return { success: true };
  } catch (err) {
    // Broadcast back to not-installed so the card resets out of
    // the downloading state into something the user can retry.
    try {
      mainWindow?.webContents.send('ai-models:stateChanged', {
        key, state: 'not-installed', progress: null, error: (err as Error).message,
      });
    } catch { /* non-fatal */ }
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai-models:cancel', async (_event, key: 'codeformer' | 'realesrgan') => {
  const { cancelInstall } = await import('./ai-model-installer.js');
  const cancelled = cancelInstall(key);
  return { success: true, cancelled };
});

ipcMain.handle('ai-models:uninstall', async (_event, key: 'codeformer' | 'realesrgan') => {
  try {
    const { uninstallModel } = await import('./ai-model-installer.js');
    uninstallModel(key);
    try {
      mainWindow?.webContents.send('ai-models:stateChanged', {
        key, state: 'not-installed', progress: null,
      });
    } catch { /* non-fatal */ }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// License IPC handlers
ipcMain.handle('license:getStatus', async () => {
  return await getLicenseStatus();
});

ipcMain.handle('license:activate', async (_event, licenseKey: string) => {
  return await activateLicense(licenseKey);
});

ipcMain.handle('license:refresh', async (_event, licenseKey: string) => {
  return await refreshLicense(licenseKey);
});

ipcMain.handle('license:deactivate', async (_event, licenseKey: string) => {
  return await deactivateLicense(licenseKey);
});

ipcMain.handle('license:getMachineId', async () => {
  return getMachineFingerprint();
});

// Free Trial usage counter — read / increment the Cloudflare-Worker-
// backed file-fix tally for the supplied license key. Both handlers
// catch + return tagged results rather than throwing across the IPC
// boundary, so renderer callers can render a "couldn't reach the
// usage server" message instead of seeing an opaque IPC rejection.
ipcMain.handle('usage:get', async (_event, licenseKey: string) => {
  try {
    const used = await getUsageFromWorker(licenseKey);
    return { success: true as const, used, limit: FREE_TRIAL_FILE_LIMIT };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[usage:get] worker call failed:', message);
    return { success: false as const, error: message };
  }
});

ipcMain.handle('usage:increment', async (_event, licenseKey: string, count: number) => {
  try {
    const used = await incrementUsageOnWorker(licenseKey, count);
    return { success: true as const, used, limit: FREE_TRIAL_FILE_LIMIT };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[usage:increment] worker call failed:', message);
    return { success: false as const, error: message };
  }
});

// Lightweight liveness ping used by the child-window heartbeat so each window
// can surface a banner when main goes dark (hang, not a clean crash — a crash
// would take the renderer down too).
ipcMain.handle('app:ping', async () => ({ alive: true, t: Date.now() }));

// Expose the on-disk path of the log file so a "Report a problem"
// feature (or a curious user) can grab it. Opens the folder in
// Explorer when the `reveal` flag is passed.
ipcMain.handle('app:logFilePath', async (_e, args?: { reveal?: boolean }) => {
  const filePath = log.transports.file.getFile().path;
  if (args?.reveal) {
    try { shell.showItemInFolder(filePath); } catch {}
  }
  return { path: filePath };
});

// Renderer → main log forwarder. Anything the React side hands us
// here is written to the same main.log file (prefixed so the origin
// is obvious), keeping every log line in one place instead of split
// between DevTools console (which doesn't exist in production) and
// the main-process file. Invoked from the preload bridge.
ipcMain.handle('app:log', (_e, payload: { level?: 'info' | 'warn' | 'error' | 'debug'; message?: string; data?: unknown }) => {
  const level = payload?.level ?? 'info';
  const msg = String(payload?.message ?? '');
  const data = payload?.data;
  const write = log[level] ?? log.info;
  if (data !== undefined) write(`[renderer] ${msg}`, data);
  else write(`[renderer] ${msg}`);
});

/**
 * Report a Problem — one-click support bundle.
 *
 * Composes a pre-filled email to the support address AND reveals the
 * main.log file in Explorer so the user can drag it into the email
 * as an attachment. mailto: URIs don't support attachments natively,
 * so the reveal-in-folder trick is the most reliable cross-Windows
 * workaround. The email body embeds system info + the last ~200 log
 * lines inline (capped to fit under the ~2000-char mailto limit) so
 * even if the user hits Send without attaching, we still get useful
 * context.
 *
 * Input: { description, userEmail? } — the user's optional note +
 *        return address from the modal.
 * Returns: { success, logFilePath } — log path is returned so the
 *          UI can offer a "Copy path" or "Open folder" button too.
 */
// ─── system:memoryInfo ────────────────────────────────────────────
// Lightweight memory probe for the renderer's low-RAM advisory.
// Returns total + currently-free RAM in bytes plus convenient GB
// floats. Used by the Dashboard's LowRamAdvisoryCard to gate a
// one-shot guidance message for budget-laptop users (Kathr 2026-05-16
// hit OOM-class failures on a Pentium N4200 / 4 GB DDR3 laptop with
// 50 GB Takeouts) — "PDR works best with 8 GB+ RAM. On this PC,
// splitting your Takeout into smaller pieces helps."
ipcMain.handle('system:memoryInfo', async () => {
  try {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    return {
      success: true,
      data: {
        totalBytes,
        freeBytes,
        totalGB: Number((totalBytes / (1024 ** 3)).toFixed(1)),
        freeGB: Number((freeBytes / (1024 ** 3)).toFixed(1)),
      },
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─── system:topMemoryConsumers ────────────────────────────────────
// Lite Tier 3 (Terry 2026-06-03) — read-only "what's using my RAM?"
// list. Surfaces when the Tier 2 RAM-pressure bullets are visible in
// the format-dropdown card, behind a "See which apps are using your
// RAM →" link. Returns the top N processes by working-set size, with
// PDR's own electron processes filtered out (showing the user "Photo
// Date Rescue: 230 MB" isn't actionable — they can't close us). NOT a
// kill switch — read-only, premium-feel respect for user agency. They
// pick what to close in Task Manager themselves.
ipcMain.handle('system:topMemoryConsumers', async (_e, limit: number = 5) => {
  try {
    if (process.platform !== 'win32') {
      return { success: true, data: [] };
    }
    const execFileAsync = (await import('util')).promisify(execFile);
    // PowerShell: enumerate processes, group by name (Chrome / Electron
    // spawn many child processes — group so the user sees one "Chrome
    // (53 procs, 3.4 GB)" line instead of 53 separate Chrome rows),
    // sort by total memory desc, take top N. ConvertTo-Json so the
    // renderer can parse cleanly.
    //
    // v2.0.15 fix (Terry 2026-06-03): the previous version's
    // `Measure-Object WorkingSet64 -Sum` was binding `WorkingSet64`
    // positionally as `-InputObject` rather than `-Property`, so the
    // sum came back null and the whole pipeline returned empty.
    // Explicit `-Property` flag fixes it; `;` separator between the
    // two statements inside `ForEach-Object { ... }` is needed because
    // we collapse onto one line.
    const topN = Math.max(1, Math.min(20, limit + 4));
    const ps =
      "Get-Process | Group-Object -Property ProcessName | ForEach-Object { " +
      "  $sum = ($_.Group | Measure-Object -Property WorkingSet64 -Sum).Sum; " +
      "  [PSCustomObject]@{ name = $_.Name; memMB = [math]::Round($sum / 1MB, 0); procCount = $_.Count } " +
      "} | Where-Object { $_.memMB -gt 0 } " +
      "| Sort-Object memMB -Descending " +
      `| Select-Object -First ${topN} ` +
      "| ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 8000, maxBuffer: 256 * 1024 }
    );
    const parsed = JSON.parse(stdout.trim() || '[]');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    // v2.0.15 (Terry 2026-06-03) — exclude OS-essential processes
    // from the list shown to the user. svchost / Memory Compression
    // / lsass / dwm / etc. ARE often huge memory consumers, but
    // suggesting users close them would be dangerous — these run
    // Windows itself, killing them is destructive. Filter so the
    // UI only ever shows apps the user CAN safely close. Maintained
    // as a denylist of well-known Windows process names; anything
    // not on it (genuine user apps like Chrome, Photoshop, etc.)
    // passes through.
    const SYSTEM_PROCESSES = new Set([
      'electron', 'photo date rescue',                     // PDR itself
      'system', 'registry', 'idle', 'secure system',       // kernel-level
      'memory compression',                                 // OS memory mgr
      'smss', 'csrss', 'wininit', 'winlogon', 'lsass', 'lsm', 'services',
      'svchost', 'spoolsv', 'searchindexer', 'searchprotocolhost',
      'searchapp', 'searchhost', 'searchui', 'startmenuexperiencehost',
      'shellexperiencehost', 'sihost', 'taskhostw', 'fontdrvhost',
      'wmiprvse', 'wudfhost', 'unsecapp', 'dllhost', 'audiodg',
      'conhost', 'dwm', 'ctfmon', 'runtimebroker', 'backgroundtaskhost',
      'taskmgr', 'msdtc', 'wmiapsrv',
      'msmpeng', 'mpdefendercoreservice', 'antimalwareserviceexecutable',
      'nissrv', 'nvcontainer', 'nvidiawebhelper', 'nvtelemetry',
      'amddvr', 'amduiservice', 'realtekaudioservice', 'rtkauduservice64',
      'igfxhk', 'igfxext', 'igfxtray', 'igfxcuiservice',
    ]);
    const filtered = rows
      .filter((r: any) => {
        const n = String(r?.name ?? '').toLowerCase();
        return !SYSTEM_PROCESSES.has(n);
      })
      .slice(0, limit)
      .map((r: any) => ({
        name: String(r.name),
        memMB: Number(r.memMB),
        procCount: Number(r.procCount),
      }));
    // v2.0.15 (Terry 2026-06-03) — also return current system memory
    // snapshot so the modal can show context: total, free, and the
    // "below 30% free" gap (the same threshold used by the callout
    // visibility check). Lets the modal say "free 2.3 GB more to
    // hit the optimal zone" instead of just showing a list.
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const targetFreeBytes = totalBytes * 0.30;
    const gapBytes = Math.max(0, targetFreeBytes - freeBytes);
    return {
      success: true,
      data: filtered,
      memory: {
        totalGB: Number((totalBytes / (1024 ** 3)).toFixed(1)),
        freeGB: Number((freeBytes / (1024 ** 3)).toFixed(1)),
        targetFreeGB: Number((targetFreeBytes / (1024 ** 3)).toFixed(1)),
        freeUpGB: Number((gapBytes / (1024 ** 3)).toFixed(1)),
        freePct: Math.round((freeBytes / totalBytes) * 100),
      },
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('app:reportProblem', async (_e, payload: { description?: string; userEmail?: string }) => {
  try {
    const supportEmail = 'admin@photodaterescue.com';
    const description = (payload?.description ?? '').trim();
    const userEmail = (payload?.userEmail ?? '').trim();
    const logFilePath = log.transports.file.getFile().path;

    // Collect system info for the body.
    const totalMemGB = (os.totalmem() / (1024 ** 3)).toFixed(1);
    const freeMemGB = (os.freemem() / (1024 ** 3)).toFixed(1);
    const info = [
      `App version: ${app.getVersion()}`,
      `Platform: ${process.platform} ${os.release()} (${os.arch()})`,
      `RAM: ${totalMemGB} GB total / ${freeMemGB} GB free`,
      `CPU: ${os.cpus()[0]?.model ?? 'unknown'} × ${os.cpus().length}`,
      `Log file: ${logFilePath}`,
    ].join('\n');

    // Tail of the log — last ~200 lines or 1500 chars, whichever's smaller.
    // Keeps the mailto URL under the typical ~2000-char limit.
    let logTail = '';
    try {
      const raw = fs.readFileSync(logFilePath, 'utf8');
      const lines = raw.split(/\r?\n/);
      logTail = lines.slice(-200).join('\n').slice(-1500);
    } catch {}

    // Licence state — captured (without the key itself) so support
    // can tell at a glance whether the user is licensed, in grace,
    // offline-only, etc. without having to dig through the log.
    let licenceSummary = '(license state unavailable)';
    try {
      const status = await getLicenseStatus();
      licenceSummary = [
        `status: ${status.status}`,
        `isValid: ${status.isValid}`,
        `plan: ${status.plan ?? 'n/a'}`,
        `canUsePremiumFeatures: ${status.canUsePremiumFeatures}`,
        `isOfflineGrace: ${status.isOfflineGrace}`,
        `daysUntilGraceExpires: ${status.daysUntilGraceExpires ?? 'n/a'}`,
        `customerEmail: ${status.customerEmail ?? 'n/a'}`,
      ].join('\n');
    } catch (licErr) {
      licenceSummary = `(error fetching license: ${(licErr as Error).message})`;
    }

    // Bundle main.log + main.old.log + system-info.txt into a single
    // .zip in the user's Documents folder. Users can drag this one
    // file into the email instead of fishing through %APPDATA% for
    // the raw log — much higher chance of actually getting attached.
    const documentsPath = app.getPath('documents');
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15); // YYYYMMDDTHHMMSS
    const zipFilename = `pdr-diagnostic-${stamp}.zip`;
    const zipPath = path.join(documentsPath, zipFilename);

    let zipCreated = false;
    try {
      const zip = new AdmZip();
      // main.log (current rotation)
      if (fs.existsSync(logFilePath)) {
        zip.addLocalFile(logFilePath);
      }
      // main.old.log (previous rotation chunk) — present only after
      // the log file has rolled over once.
      const oldLogPath = logFilePath.replace(/main\.log$/i, 'main.old.log');
      if (fs.existsSync(oldLogPath)) {
        zip.addLocalFile(oldLogPath);
      }
      // System info as a sidecar text file inside the zip so support
      // doesn't have to read the email body to see version/RAM/etc.
      const sysinfoBody = [
        '─── system info ───',
        info,
        '',
        '─── license state ───',
        licenceSummary,
        '',
        '─── user description ───',
        description || '(blank)',
        userEmail ? `Return address: ${userEmail}` : '',
      ].filter(Boolean).join('\n');
      zip.addFile('system-info.txt', Buffer.from(sysinfoBody, 'utf8'));
      zip.writeZip(zipPath);
      zipCreated = true;
    } catch (zipErr) {
      log.warn('[report] zip creation failed, falling back to log-reveal:', zipErr);
    }

    const body = [
      description || '(user left description blank)',
      '',
      '─── system info ───',
      info,
      userEmail ? `Return address: ${userEmail}` : '',
      '',
      '─── license state ───',
      licenceSummary,
      '',
      '─── recent log (last 200 lines) ───',
      logTail || '(log file unreadable)',
      '',
      zipCreated
        ? `─── please attach the diagnostic ZIP from the folder that just opened ───\n${zipPath}`
        : `─── please attach the full log from the folder that just opened ───\n${logFilePath}`,
    ].filter(Boolean).join('\n');

    const subject = 'Photo Date Rescue — support request';
    const mailto = `mailto:${supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    // Open default mail client AND reveal the artefact (zip if we
    // created one, raw log if not) in Explorer. Users drag the
    // file into the email manually — mailto: can't attach.
    await shell.openExternal(mailto);
    try {
      shell.showItemInFolder(zipCreated ? zipPath : logFilePath);
    } catch {}

    log.info(`[report] opened mailto for support request (description ${description.length} chars; zip=${zipCreated ? zipPath : 'none'})`);
    return {
      success: true,
      logFilePath,
      diagnosticZipPath: zipCreated ? zipPath : null,
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Resolve the user's well-known Quick Access folders so the Add Source
// browser can surface them in its sidebar. Electron's app.getPath() already
// knows the correct localised paths on all platforms.
ipcMain.handle('app:quickAccessPaths', async () => {
  const safe = (key: string): string | null => {
    try { return app.getPath(key as any); } catch { return null; }
  };
  return {
    desktop: safe('desktop'),
    downloads: safe('downloads'),
    documents: safe('documents'),
    pictures: safe('pictures'),
    videos: safe('videos'),
    music: safe('music'),
    home: safe('home'),
  };
});

// ─── Date editor IPC handlers ───────────────────────────────────────────────

ipcMain.handle('date:getSuggestions', async (_event, fileId: number) => {
  try {
    const { getDateSuggestionsForFile } = await import('./date-editor.js');
    return { success: true, data: getDateSuggestionsForFile(fileId) };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
});

ipcMain.handle('date:apply', async (_event, opts: any) => {
  try {
    const { applyDateCorrection } = await import('./date-editor.js');
    const result = await applyDateCorrection(opts);
    return { success: result.success, data: result };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
});

ipcMain.handle('date:undo', async () => {
  try {
    const { undoLastDateCorrection } = await import('./date-editor.js');
    return await undoLastDateCorrection();
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
});

ipcMain.handle('date:auditLog', async (_event, limit: number = 20) => {
  try {
    const { getRecentAuditEntries } = await import('./date-editor.js');
    return { success: true, data: getRecentAuditEntries(limit) };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
});

// ─── Scanner override IPC handlers ──────────────────────────────────────────

/**
 * Re-classify every indexed file that matches the given camera Make/Model
 * after the user has flipped its scanner override. For 'isScanner = true':
 * demote matching Confirmed / Recovered files to Marked and annotate
 * date_source. For 'isScanner = false': restore files that were previously
 * Marked via the scanner rule (date_source contains 'scanner') back to
 * Confirmed so the user's "no, this is a real camera" intent takes effect.
 */
function reclassifyFilesForOverride(make: string, model: string, isScanner: boolean): { updated: number } {
  const db = getDbForReclassify();
  if (!db) return { updated: 0 };
  const mk = make.trim();
  const md = model.trim();
  if (!mk && !md) return { updated: 0 };

  // Case-insensitive equality match on camera_make + camera_model.
  if (isScanner) {
    const r = db.prepare(`
      UPDATE indexed_files
         SET confidence = 'marked',
             date_source = CASE
               WHEN date_source LIKE '%scanner%' THEN date_source
               WHEN date_source IS NULL OR date_source = '' THEN 'Scanner date (user override)'
               ELSE date_source || ' — scanner (user override)'
             END
       WHERE LOWER(IFNULL(camera_make, '')) = LOWER(?)
         AND LOWER(IFNULL(camera_model, '')) = LOWER(?)
         AND confidence != 'marked'
    `).run(mk, md);
    return { updated: r.changes };
  }
  // Restore: undo only rows that were auto-demoted (date_source mentions
  // 'scanner'). Leave Recovered/Confirmed alone. We set back to 'confirmed'
  // which is the usual EXIF-derived tier these files came from.
  const r = db.prepare(`
    UPDATE indexed_files
       SET confidence = 'confirmed',
           date_source = REPLACE(REPLACE(REPLACE(date_source, ' — scanner (user override)', ''), ' — scanner (likely scan time, not photo date)', ''), 'Scanner date (user override)', '')
     WHERE LOWER(IFNULL(camera_make, '')) = LOWER(?)
       AND LOWER(IFNULL(camera_model, '')) = LOWER(?)
       AND confidence = 'marked'
       AND date_source LIKE '%scanner%'
  `).run(mk, md);
  return { updated: r.changes };
}

function getDbForReclassify() {
  try {
    // getDb is exported from search-database but not imported at top-level
    // here; lazy-require to avoid a circular at startup.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require('./search-database.js');
    return m.getDb ? m.getDb() : null;
  } catch { return null; }
}

ipcMain.handle('scannerOverride:list', async () => {
  try {
    const { listScannerOverrides } = await import('./settings-store.js');
    return { success: true, data: listScannerOverrides() };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
});

ipcMain.handle('scannerOverride:set', async (_event, args: { make: string; model: string; isScanner: boolean }) => {
  try {
    const { setScannerOverride } = await import('./settings-store.js');
    const list = setScannerOverride(args.make, args.model, args.isScanner);
    const { updated } = reclassifyFilesForOverride(args.make, args.model, args.isScanner);
    // Nudge the main window so S&D / Dashboard counts refresh.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dateEditor:dataChanged');
    }
    return { success: true, data: { list, updated } };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
});

ipcMain.handle('scannerOverride:clear', async (_event, args: { make: string; model: string }) => {
  try {
    const { clearScannerOverride } = await import('./settings-store.js');
    const list = clearScannerOverride(args.make, args.model);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dateEditor:dataChanged');
    }
    return { success: true, data: { list } };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
});

// ─── Search & Discovery IPC handlers ─────────────────────────────────────────

ipcMain.handle('search:init', async () => {
  const result = initDatabase();
  // v2.0.11 — runDatabaseCleanup no longer runs here. The startup
  // worker (utilityProcess, see createSplashWindow / spawnStartupWorker
  // above) handles all the DB stale-file + orphan-run cleanup BEFORE
  // the workspace renderer mounts. By the time this IPC fires the DB
  // is already clean. Running it again here would be wasted work +
  // contention with the main thread.
  return result;
});

ipcMain.handle('search:indexRun', async (_event, reportId: string) => {
  try {
    const report = await loadReportForIndex(reportId);
    if (!report) {
      return { success: false, error: 'Report not found' };
    }

    const result = await indexFixRun(report, (progress: IndexProgress) => {
      mainWindow?.webContents.send('search:indexProgress', progress);
    });

    // ── Takeout albums + caption + original-filename write ──────────
    // Consume the enrichment gathered during files:copy. Runs only when
    // indexing succeeded and produced a runId (otherwise the file_ids
    // we'd be linking to don't exist). Wrapped in try/catch — a failure
    // in album-write must never poison the indexing result the caller
    // is waiting on; the user still has a fully Fixed-and-indexed run
    // and can retry album import later via the backfill flow.
    if (result.success && result.runId !== undefined) {
      const enrichment = pendingTakeoutEnrichments.get(report.destinationPath);
      if (enrichment) {
        pendingTakeoutEnrichments.delete(report.destinationPath);
        try {
          importTakeoutAlbumsFromEnrichment(enrichment, result.runId);
        } catch (albumErr) {
          console.warn(`[Takeout] Album import after indexing failed (continuing):`, albumErr);
        }
      }
    }

    markDbDirty();
    return result;
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:cancelIndex', async () => {
  cancelIndexing();
  return { success: true };
});

// v2.0.8 step 2b — Backfill albums from an original Takeout ZIP.
// For customers who Fixed their Takeout on v2.0.4–v2.0.7 (before albums
// were a feature) and still have the original 50 GB ZIP sitting on disk.
// Streams the ZIP's central directory + sidecar JSONs only — no photo
// bytes, no extraction to PDR_Temp. Matches each photo against existing
// indexed_files rows by (original_filename, size_bytes), writes albums +
// captions + filename corrections through the same importer the Fix path
// uses post-indexing. Same per-album log lines for sanity-checking.
// v2.0.8 step 3 — Album CRUD + listing IPC. Used by the Memories Albums
// tab (renderer-side AlbumsView). Read paths are sync DB calls so the
// promise resolves immediately; mutations bump `updated_at` on the album
// so the list re-sorts on the next list call.
ipcMain.handle('albums:list', async () => {
  try {
    const { listAlbums } = await import('./search-database.js');
    return { success: true, data: listAlbums() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('albums:create', async (_event, title: string) => {
  try {
    const { createUserAlbum } = await import('./search-database.js');
    if (typeof title !== 'string') return { success: false, error: 'Title required.' };
    const id = createUserAlbum(title);
    markDbDirty();
    return { success: true, id };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('albums:rename', async (_event, albumId: number, newTitle: string) => {
  try {
    const { renameAlbum } = await import('./search-database.js');
    const r = renameAlbum(albumId, newTitle);
    if (r.success) markDbDirty();
    return r;
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('albums:delete', async (_event, albumId: number) => {
  try {
    const { deleteAlbum } = await import('./search-database.js');
    const r = deleteAlbum(albumId);
    if (r.success) markDbDirty();
    return r;
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('albums:listPhotos', async (_event, albumId: number) => {
  try {
    const { listAlbumPhotos } = await import('./search-database.js');
    return { success: true, data: listAlbumPhotos(albumId) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('albums:addPhotos', async (_event, albumId: number, fileIds: number[]) => {
  try {
    const { addPhotosToAlbum } = await import('./search-database.js');
    const inserted = addPhotosToAlbum(albumId, Array.isArray(fileIds) ? fileIds : []);
    markDbDirty();
    return { success: true, inserted };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('albums:removePhotos', async (_event, albumId: number, fileIds: number[]) => {
  try {
    const { removePhotosFromAlbum } = await import('./search-database.js');
    const removed = removePhotosFromAlbum(albumId, Array.isArray(fileIds) ? fileIds : []);
    markDbDirty();
    return { success: true, removed };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// v2.0.13 (Terry 2026-05-26) — user-chosen album cover photo.
// Mirrors the "Set as monthly thumbnail" affordance on the By-Date
// surface: right-click any photo inside an album and pick "Set as
// album thumbnail" to override the auto-picked first-by-date cover.
// Writes albums.cover_file_id (the schema column already existed from
// v2.0.8 — it was just never exposed via IPC). Pass fileId=null to
// revert to the default first-photo behaviour.
ipcMain.handle('albums:setCoverPhoto', async (_event, args: { albumId: number; fileId: number | null }) => {
  try {
    const { albumId, fileId } = args;
    const db = getDb();
    // Guard: if a non-null fileId is provided, verify the photo
    // actually belongs to this album. Setting an external photo as
    // cover would break the album-list query's join and would
    // surprise users when removing the photo from the library.
    if (fileId !== null) {
      const row = db.prepare(
        `SELECT 1 FROM album_files WHERE album_id = ? AND file_id = ? LIMIT 1`
      ).get(albumId, fileId);
      if (!row) return { success: false, error: 'That photo is not in this album.' };
    }
    db.prepare(`UPDATE albums SET cover_file_id = ?, updated_at = datetime('now') WHERE id = ?`).run(fileId, albumId);
    markDbDirty();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// v2.0.8 — Album group (folder) CRUD + tree listing IPC. Drives the
// AlbumsView's hierarchical multi-membership tree.
ipcMain.handle('albumGroups:list', async () => {
  try {
    const { listAlbumGroups } = await import('./search-database.js');
    return { success: true, data: listAlbumGroups() };
  } catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('albumGroups:listMemberships', async () => {
  try {
    const { listAlbumGroupMemberships } = await import('./search-database.js');
    return { success: true, data: listAlbumGroupMemberships() };
  } catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('albumGroups:listAlbumsIn', async (_event, groupId: number) => {
  try {
    const { listAlbumsInGroup } = await import('./search-database.js');
    return { success: true, data: listAlbumsInGroup(groupId) };
  } catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('albumGroups:create', async (_event, title: string, parentId: number | null) => {
  try {
    const { createUserAlbumGroup } = await import('./search-database.js');
    const r = createUserAlbumGroup(title, parentId ?? null);
    if (r.success) markDbDirty();
    return r;
  } catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('albumGroups:rename', async (_event, groupId: number, newTitle: string) => {
  try {
    const { renameAlbumGroup } = await import('./search-database.js');
    const r = renameAlbumGroup(groupId, newTitle);
    if (r.success) markDbDirty();
    return r;
  } catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('albumGroups:delete', async (_event, groupId: number) => {
  try {
    const { deleteAlbumGroup } = await import('./search-database.js');
    const r = deleteAlbumGroup(groupId);
    if (r.success) markDbDirty();
    return r;
  } catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('albumGroups:move', async (_event, groupId: number, newParentId: number | null) => {
  try {
    const { moveAlbumGroup } = await import('./search-database.js');
    const r = moveAlbumGroup(groupId, newParentId ?? null);
    if (r.success) markDbDirty();
    return r;
  } catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('albumGroups:reorder', async (_event, siblingIds: number[]) => {
  try {
    const { reorderAlbumGroups } = await import('./search-database.js');
    const r = reorderAlbumGroups(Array.isArray(siblingIds) ? siblingIds : []);
    if (r.success) markDbDirty();
    return r;
  } catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('albumGroups:addAlbum', async (_event, albumId: number, groupId: number) => {
  try {
    const { addAlbumToGroup } = await import('./search-database.js');
    const r = addAlbumToGroup(albumId, groupId);
    if (r.success) markDbDirty();
    return r;
  } catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('albumGroups:removeAlbum', async (_event, albumId: number, groupId: number) => {
  try {
    const { removeAlbumFromGroup } = await import('./search-database.js');
    const r = removeAlbumFromGroup(albumId, groupId);
    if (r.success) markDbDirty();
    return r;
  } catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('takeout:backfillFromZip', async (_event, zipPath: string) => {
  try {
    if (typeof zipPath !== 'string' || !zipPath) {
      return { success: false, error: 'No ZIP path provided.' };
    }
    if (!fs.existsSync(zipPath)) {
      return { success: false, error: `ZIP not found: ${zipPath}` };
    }
    console.log(`[Takeout] Backfill starting against ZIP: ${zipPath}`);
    const { enrichment, stats } = await gatherTakeoutEnrichmentFromZip(zipPath);
    console.log(
      `[Takeout] Backfill scan complete — ` +
      `albumFolders=${stats.albumFoldersDetected}, ` +
      `photosConsidered=${stats.photosConsidered}, ` +
      `matched=${stats.matchedAgainstLibrary}, ` +
      `unmatched=${stats.unmatched}`
    );

    let summary: TakeoutImportSummary | null = null;
    if (enrichment) {
      // runId = -1 — backfill enrichments pre-resolve every file_id at
      // gather time so the importer's run-scoped lookup is bypassed.
      summary = importTakeoutAlbumsFromEnrichment(enrichment, -1);
      markDbDirty();
      // Auto-link the newly created albums to the Google Photos auto
      // source group so they appear in the AlbumsView tree, not just
      // the all-albums grid. Without this, the tree only refreshed on
      // next launch (when initDatabase re-ran the seed). Terry
      // 2026-05-21: "it's not updated the Google Photos albums in the
      // tree... even after pressing the refresh."
      try {
        const { reconcileAutoSourceMemberships } = await import('./search-database.js');
        const newlyLinked = reconcileAutoSourceMemberships();
        if (newlyLinked > 0) {
          console.log(`[Takeout] Linked ${newlyLinked} album(s) to their auto source group.`);
        }
      } catch (linkErr) {
        console.warn('[Takeout] Auto-membership reconcile failed:', (linkErr as Error).message);
      }
    } else {
      console.log(`[Takeout] Backfill: no album folders matched against the existing library — nothing to write.`);
    }

    return { success: true, stats, summary };
  } catch (err) {
    console.error(`[Takeout] Backfill failed:`, err);
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:removeRun', async (_event, runId: number) => {
  try {
    removeRun(runId);
    markDbDirty();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:removeRunByReport', async (_event, reportId: string) => {
  try {
    removeRunByReportId(reportId);
    markDbDirty();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:listRuns', async () => {
  try {
    return { success: true, data: listRuns() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:query', async (_event, query: SearchQuery) => {
  try {
    const result = searchFiles(query);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:filterOptions', async () => {
  try {
    return { success: true, data: getFilterOptions() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:filterCounts', async (_event, query: SearchQuery) => {
  try {
    return { success: true, data: getFilterCounts(query) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:stats', async () => {
  try {
    return { success: true, data: getIndexStats() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─── Memories IPC handlers ──────────────────────────────────────────────────

ipcMain.handle('memories:yearMonthBuckets', async (_event, runIds?: number[]) => {
  try {
    return { success: true, data: getMemoriesYearMonthBuckets(runIds) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('memories:onThisDay', async (_event, args: { month: number; day: number; runIds?: number[]; limit?: number }) => {
  try {
    return { success: true, data: getMemoriesOnThisDay(args.month, args.day, args.runIds, args.limit ?? 50) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// `month` and `day` are optional so the same channel powers all three
// drill-down granularities (year / month / day). The renderer omits
// the field entirely when widening the range — the backend treats
// missing values as "no constraint at this level".
ipcMain.handle('memories:dayFiles', async (_event, args: { year: number; month?: number | null; day?: number | null; runIds?: number[] }) => {
  try {
    return { success: true, data: getMemoriesDayFiles(args.year, args.month ?? null, args.day ?? null, args.runIds) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Set a user-chosen monthly thumbnail. Right-click a photo in the
// month drilldown → "Set as monthly thumbnail" pipes through here.
// The month-bucket query then prefers this file over the default
// lowest-id pick when rendering the year/month tile grid.
ipcMain.handle('memories:setMonthlyThumbnail', async (_event, args: { year: number; month: number; fileId: number }) => {
  try {
    setMonthlyThumbnailOverride(args.year, args.month, args.fileId);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Clear a previously-set monthly thumbnail override. After clearing,
// the bucket grid reverts to the default lowest-id pick for that month.
ipcMain.handle('memories:clearMonthlyThumbnail', async (_event, args: { year: number; month: number }) => {
  try {
    clearMonthlyThumbnailOverride(args.year, args.month);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ═══════════════════════════════════════════════════════════════
// Trees v1 — family relationship IPC handlers
// ═══════════════════════════════════════════════════════════════

ipcMain.handle('trees:addRelationship', async (_event, args: {
  personAId: number;
  personBId: number;
  type: RelationshipType;
  since?: string | null;
  until?: string | null;
  flags?: RelationshipFlags | null;
  confidence?: number;
  source?: 'user' | 'suggested';
  note?: string | null;
}) => {
  try {
    const result = addRelationship(args);
    if ('error' in result) return { success: false, error: result.error };
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('trees:updateRelationship', async (_event, args: { id: number; patch: Partial<Omit<RelationshipRecord, 'id' | 'created_at' | 'updated_at' | 'person_a_id' | 'person_b_id' | 'type'>> }) => {
  try {
    const result = updateRelationship(args.id, args.patch);
    if ('error' in result) return { success: false, error: result.error };
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('trees:removeRelationship', async (_event, id: number) => {
  try {
    return removeRelationship(id);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('trees:listRelationshipsForPerson', async (_event, personId: number) => {
  try {
    return { success: true, data: listRelationshipsForPerson(personId) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('trees:listAllRelationships', async () => {
  try {
    return { success: true, data: listAllRelationships() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('trees:updatePersonLifeEvents', async (_event, args: { personId: number; patch: { birthDate?: string | null; deathDate?: string | null; deceasedMarker?: string | null } }) => {
  try {
    return updatePersonLifeEvents(args.personId, args.patch);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('trees:setPersonCardBackground', async (_event, args: { personId: number; dataUrl: string | null }) => {
  try {
    return setPersonCardBackground(args.personId, args.dataUrl);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('trees:setPersonGender', async (_event, args: { personId: number; gender: string | null }) => {
  try {
    return setPersonGender(args.personId, args.gender);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('trees:getFamilyGraph', async (_event, args: { focusPersonId: number; maxHops?: number }) => {
  try {
    return { success: true, data: getFamilyGraph(args.focusPersonId, args.maxHops ?? 3) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('trees:getCooccurrenceStats', async (_event, args: { limit?: number; minSharedPhotos?: number }) => {
  try {
    return { success: true, data: getPersonCooccurrenceStats(args.limit ?? 25, args.minSharedPhotos ?? 20) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('trees:getPartnerSuggestionScores', async (_event, anchorId: number) => {
  try {
    return { success: true, data: getPartnerSuggestionScores(anchorId) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('trees:savedList', async () => {
  try { return { success: true, data: listSavedTrees() }; }
  catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('trees:savedGet', async (_event, id: number) => {
  try { return { success: true, data: getSavedTree(id) }; }
  catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('trees:savedCreate', async (_event, args: Parameters<typeof createSavedTree>[0]) => {
  try { return createSavedTree(args); }
  catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('trees:savedUpdate', async (_event, args: { id: number; patch: Parameters<typeof updateSavedTree>[1] }) => {
  try { return updateSavedTree(args.id, args.patch); }
  catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('trees:savedDelete', async (_event, id: number) => {
  try { return deleteSavedTree(id); }
  catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('trees:toggleHiddenAncestor', async (_event, args: { treeId: number; personId: number }) => {
  try { return toggleHiddenAncestor(args.treeId, args.personId); }
  catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('trees:undo', async () => {
  try { return undoLastGraphOperation(); }
  catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('trees:redo', async () => {
  try { return redoGraphOperation(); }
  catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('trees:historyCounts', async () => {
  try { return { success: true, data: getGraphHistoryCounts() }; }
  catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('trees:historyList', async (_event, limit?: number) => {
  try { return { success: true, data: listGraphHistoryEntries(limit ?? 500) }; }
  catch (err) { return { success: false, error: (err as Error).message }; }
});

ipcMain.handle('trees:historyRevert', async (_event, targetId: number) => {
  try { return revertToGraphHistoryEntry(targetId); }
  catch (err) { return { success: false, undoneCount: 0, error: (err as Error).message }; }
});

ipcMain.handle('trees:createPlaceholderPerson', async () => {
  try {
    return { success: true, data: createPlaceholderPerson() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('trees:createNamedPerson', async (_event, name: string) => {
  try {
    return createNamedPerson(name);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('trees:namePlaceholder', async (_event, args: { personId: number; name: string }) => {
  try {
    return namePlaceholder(args.personId, args.name);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('trees:mergePlaceholder', async (_event, args: { placeholderId: number; targetPersonId: number }) => {
  try {
    return mergePlaceholderIntoPerson(args.placeholderId, args.targetPersonId);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('trees:removePlaceholder', async (_event, id: number) => {
  try {
    return removePlaceholder(id);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:rebuildIndex', async () => {
  try {
    clearAllIndexData();
    markDbDirty();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Rebuild the search index from existing PDR Library Drive(s). Used when
// the search-index DB has been reset but the customer's library still
// holds years of fixed photos — we walk those drives and re-extract
// metadata from EXIF + filename. Read-only with respect to the photo
// files themselves.
ipcMain.handle('search:rebuildFromLibraries', async (event, rootPaths: string[]) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await rebuildIndexFromLibraries(rootPaths, (progress: RebuildProgress) => {
      win?.webContents.send('search:rebuildProgress', progress);
    });
    markDbDirty();
    return result;
  } catch (err) {
    return { success: false, error: (err as Error).message, runIds: [], totalFiles: 0, perRoot: [] };
  }
});

ipcMain.handle('search:cleanup', async () => {
  try {
    const result = runDatabaseCleanup();
    markDbDirty();
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:relocateRun', async (_event, runId: number, newPath: string) => {
  try {
    const updated = relocateRun(runId, newPath);
    markDbDirty();
    return { success: true, data: { filesUpdated: updated } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Favourite filters
ipcMain.handle('search:favourites:list', async () => {
  try {
    return { success: true, data: listFavouriteFilters() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:favourites:save', async (_event, name: string, query: SearchQuery) => {
  try {
    const fav = saveFavouriteFilter(name, query);
    markDbDirty();
    return { success: true, data: fav };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:favourites:delete', async (_event, id: number) => {
  try {
    deleteFavouriteFilter(id);
    markDbDirty();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:favourites:rename', async (_event, id: number, name: string) => {
  try {
    renameFavouriteFilter(id, name);
    markDbDirty();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Detached viewer window
// Check if paths exist (for destination drive availability)
ipcMain.handle('search:checkPathsExist', async (_event, paths: string[]) => {
  const result: Record<string, boolean> = {};
  for (const p of paths) {
    try {
      result[p] = fs.existsSync(p);
    } catch {
      result[p] = false;
    }
  }
  return { success: true, data: result };
});

// ═══ Library (portable DB sidecar) ════════════════════════════════════════════
// Foundation slice for the v2.0.5 library-portable database feature. See
// electron/library-sidecar.ts for the actual logic and the design memo
// at memory/project_db_in_library.md for the multi-device semantics.
// The renderer talks to these via window.pdr.library.X (preload.ts).

ipcMain.handle('library:status', async () => {
  try {
    return { success: true, data: getLibraryStatus() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('library:detectSidecar', async (_event, libraryRoot: string) => {
  try {
    return { success: true, data: detectSidecar(libraryRoot) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Proactive precheck called by the renderer on Workspace mount: does
// the user's currently-configured Library Drive resolve on disk right
// now? If not, the renderer drives the calm "Library Drive isn't
// connected" modal instead of waiting for the next analysis:run to
// fail. destinationPath of null is not an error — it just means the
// user hasn't picked a Library Drive yet (first-run state).
ipcMain.handle('library:checkDestinationOnline', async () => {
  try {
    const destinationPath = (() => { try { return getSettings()?.destinationPath ?? null; } catch { return null; } })();
    if (!destinationPath) {
      return { success: true, data: { online: true, destinationPath: null } };
    }
    return {
      success: true,
      data: {
        online: fs.existsSync(destinationPath),
        destinationPath,
      },
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('library:detectDriveType', async (_event, libraryRoot: string) => {
  try {
    if (!libraryRoot) return { success: false, error: 'libraryRoot is required' };
    return { success: true, data: detectDriveType(libraryRoot) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─── library:getDriveDetails ────────────────────────────────────────────────
// Full premium-LDM identity block for a path's drive. Returns letter,
// volume label, file system, drive-type label, total/free bytes, online,
// and the existing isSafeForLibrary flag. Uses PowerShell
// Get-CimInstance Win32_LogicalDisk + Get-Volume to gather everything in
// a single async exec (the browser:listDrives handler above proves the
// pattern works on every supported Windows version).
//
// Returns nulls for fields PowerShell couldn't resolve so the renderer
// can render "Volume: —" or hide rows gracefully rather than throwing.
ipcMain.handle('library:getDriveDetails', async (_event, libraryRoot: string) => {
  try {
    if (!libraryRoot) return { success: false, error: 'libraryRoot is required' };
    const letter = (libraryRoot.match(/^([A-Za-z]):/) || [])[1];
    if (!letter) {
      // Non-letter paths (UNC \\server\share, mounted volumes) — return
      // what we can without the WMI lookup. detectDriveType still works
      // for these via its own UNC-aware branch. v2.0.7: use fs.statfs
      // to fetch real free/total bytes for UNC paths instead of leaving
      // them as 0/0 (Kathr 2026-05-15 — her LDM couldn't show capacity
      // because Win32_LogicalDisk doesn't enumerate UNC shares).
      const driveTypeInfo = detectDriveType(libraryRoot);
      let totalBytes = 0;
      let freeBytes = 0;
      try {
        const st = fs.statfsSync(toLongPath(libraryRoot));
        if (st && typeof st.bsize === 'number') {
          totalBytes = st.bsize * st.blocks;
          freeBytes = st.bsize * st.bfree;
        }
      } catch {
        // Network share unreachable / auth pending — leave zeros and
        // let the LDM render a friendly "free space unavailable" note.
      }
      const isUnc = libraryRoot.startsWith('\\\\');
      return {
        success: true,
        data: {
          path: libraryRoot,
          letter: null,
          volumeLabel: null,
          fileSystem: null,
          driveTypeLabel: isUnc ? 'Network share' : driveTypeInfo.driveType,
          driveTypeCode: isUnc ? 4 : null, // 4 = Network in Win32_LogicalDisk DriveType
          totalBytes,
          freeBytes,
          online: fs.existsSync(toLongPath(libraryRoot)),
          isSafeForLibrary: driveTypeInfo.isSafeForLibrary,
          safetyReason: driveTypeInfo.reason,
          // Surface that this is a network share so the renderer can
          // show a calm "Network drive — operations may be slower over
          // SMB; Windows may prompt for credentials" advisory. Real
          // remediation (auth, credential prompt) is the user's job in
          // File Explorer; we just label it honestly.
          isNetworkShare: isUnc,
        },
      };
    }

    const driveLetter = letter.toUpperCase();
    const deviceId = `${driveLetter}:`;
    let volumeLabel: string | null = null;
    let fileSystem: string | null = null;
    let driveTypeCode: number | null = null;
    let totalBytes = 0;
    let freeBytes = 0;
    // Drive interface + media type — surfaced in LDM as a "drive speed"
    // hint (NVMe / SATA / USB / spinning rust). Populated alongside the
    // capacity in the same PowerShell exec to avoid a second round-trip.
    let busType: string | null = null;
    let mediaType: string | null = null;

    // Robust number parser — PowerShell's ConvertTo-Json sometimes
    // serialises int64 values as STRINGS instead of JSON numbers
    // (varies by PowerShell version and value range). The previous
    // strict `typeof === 'number'` check rejected string-serialised
    // sizes and silently fell back to 0, leaving the LDM Capacity
    // column blank for every row. Accept both forms.
    const parseSizeValue = (v: unknown): number => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      }
      return 0;
    };

    if (process.platform === 'win32') {
      // Reuse the EXACT PowerShell pattern that browser:listDrives
      // uses — no -Filter, no embedded quotes, CSV output. That
      // pattern is proven working in production; my previous attempts
      // with -Filter "DeviceID='X:'" kept failing in Node's execFile
      // (works in an interactive PS shell, but the argv escaping
      // through Node + powershell.exe -Command breaks the embedded-
      // quote filter, producing empty stdout and "Unexpected end of
      // JSON input"). The fix: query all drives, filter in JS.
      try {
        const csv = await new Promise<string>((resolve, reject) => {
          execFile('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,DriveType,Size,FreeSpace | ConvertTo-Csv -NoTypeInformation`
          ], { encoding: 'utf8', timeout: 8000 }, (error, stdout, stderr) => {
            if (error) {
              const detail = stderr ? `\nstderr: ${String(stderr).slice(0, 500)}` : '';
              reject(new Error(`${(error as Error).message}${detail}`));
            } else {
              resolve(stdout);
            }
          });
        });
        const lines = csv.trim().split('\n').filter(l => l.trim());
        // Skip the CSV header line, parse the rest into rows. Trim
        // each part BEFORE stripping the outer quotes — Windows CSV
        // lines end with \r and the previous order (strip-then-trim)
        // left a trailing " character on the FreeSpace column when
        // its \r came after the closing quote, which then made
        // Number() return NaN and the cell show "0 B free".
        for (const line of lines.slice(1)) {
          const parts = line.split(',').map(p => p.trim().replace(/^"|"$/g, '').trim());
          if (parts[0]?.toUpperCase() === deviceId.toUpperCase()) {
            volumeLabel = parts[1] && parts[1].trim() ? parts[1].trim() : null;
            const dt = parseInt(parts[2], 10);
            driveTypeCode = Number.isFinite(dt) ? dt : null;
            totalBytes = parseSizeValue(parts[3]);
            freeBytes = parseSizeValue(parts[4]);
            break;
          }
        }
      } catch (e) {
        log.warn(`[library:getDriveDetails] CIM lookup failed for ${deviceId}:`, (e as Error).message);
      }

      // Separate, optional second query for FileSystem + BusType +
      // MediaType (drive-speed metadata). Get-Volume / Get-Disk are
      // Storage-module cmdlets that may not auto-load in every
      // PowerShell version; failure here just blanks those fields
      // — the capacity is already populated above.
      try {
        const psScript = [
          `$r = @{FileSystem=$null; BusType=$null; MediaType=$null}`,
          `try { $v = Get-Volume -DriveLetter '${driveLetter}' -ErrorAction Stop; if ($v) { $r.FileSystem = $v.FileSystem } } catch {}`,
          `try { $disk = Get-Partition -DriveLetter '${driveLetter}' -ErrorAction Stop | Get-Disk -ErrorAction Stop; if ($disk) { $r.BusType = $disk.BusType; $r.MediaType = $disk.MediaType } } catch {}`,
          `$r | ConvertTo-Json -Compress`,
        ].join('; ');
        const output = await new Promise<string>((resolve, reject) => {
          execFile('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command', psScript,
          ], { encoding: 'utf8', timeout: 6000 }, (error, stdout, stderr) => {
            if (error) {
              const detail = stderr ? `\nstderr: ${String(stderr).slice(0, 500)}` : '';
              reject(new Error(`${(error as Error).message}${detail}`));
            } else {
              resolve(stdout);
            }
          });
        });
        const parsed = JSON.parse(output.trim());
        fileSystem = (parsed.FileSystem && String(parsed.FileSystem).trim()) ? String(parsed.FileSystem).trim() : fileSystem;
        busType = (parsed.BusType && String(parsed.BusType).trim()) ? String(parsed.BusType).trim() : null;
        mediaType = (parsed.MediaType && String(parsed.MediaType).trim()) ? String(parsed.MediaType).trim() : null;
      } catch (e) {
        log.warn(`[library:getDriveDetails] FS/Disk metadata lookup failed for ${deviceId}:`, (e as Error).message);
      }
    }

    // Drive-type label — map the Win32 DriveType code to a human label
    // closer to what a non-technical user expects. Falls back to the
    // detectDriveType reason if WMI didn't return a code.
    const driveTypeInfo = detectDriveType(libraryRoot);
    const driveTypeLabel = (() => {
      if (driveTypeCode === 2) return 'Removable drive';
      if (driveTypeCode === 3) return 'Internal drive';
      if (driveTypeCode === 4) return 'Network drive';
      if (driveTypeCode === 5) return 'CD/DVD';
      return driveTypeInfo.driveType;
    })();

    return {
      success: true,
      data: {
        path: libraryRoot,
        letter: deviceId,
        volumeLabel,
        fileSystem,
        driveTypeLabel,
        driveTypeCode,
        totalBytes,
        freeBytes,
        online: fs.existsSync(libraryRoot),
        isSafeForLibrary: driveTypeInfo.isSafeForLibrary,
        safetyReason: driveTypeInfo.reason,
        busType,
        mediaType,
      },
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─── library:listIndexedDrives ──────────────────────────────────────────────
// The "drives in your library" section of LDM. Premium LDM shows the
// user the WHOLE shape of their library, not just the one drive that
// hosts the sidecar backup — Terry's framing: "the Library DB indexes
// across all your drives, LDM should reflect that".
//
// Strategy: GROUP BY the first two characters of file_path (the drive
// letter, e.g. "L:") in the search DB's files table. Each row becomes
// a "drive in your library" entry with:
//   - drive letter
//   - photo / video count indexed from that drive
//   - total bytes indexed from that drive
//   - last-indexed timestamp (most recent indexed_at)
//   - online status (fs.existsSync on the drive root)
//   - volume label (PowerShell lookup, parallel for performance)
// Non-letter paths (UNC, mounted volumes) are bucketed under a single
// "Network / mounted" row for now — those are rare enough not to need
// per-share breakdown in v2.0.5.
// v2.0.15 (Terry 2026-05-31) — list every distinct destinationPath
// recorded in saved Fix reports, sorted most-recent-first by the
// report file's mtime. Used by the renderer to silently reconcile
// the LDM's pdr-saved-destinations localStorage list on app start:
// any destination the user has ever fixed to but that's missing
// from the cap-bounded localStorage list (e.g. evicted by the old
// MAX_SAVED_DESTINATIONS=3 cap) gets restored. Failure-tolerant —
// a corrupt or unreadable report file is skipped, not fatal.
ipcMain.handle('library:listReportDestinations', async () => {
  try {
    const reportsDir = path.join(app.getPath('userData'), 'fix-reports');
    if (!fs.existsSync(reportsDir)) return { success: true, data: { paths: [] as string[] } };
    const entries = await fs.promises.readdir(reportsDir, { withFileTypes: true });
    const candidates: { path: string; mtimeMs: number }[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = path.join(reportsDir, entry.name);
      try {
        const [stat, raw] = await Promise.all([
          fs.promises.stat(filePath),
          fs.promises.readFile(filePath, 'utf-8'),
        ]);
        const parsed = JSON.parse(raw) as { destinationPath?: string };
        const dest = (parsed.destinationPath || '').trim();
        if (dest) candidates.push({ path: dest, mtimeMs: stat.mtimeMs });
      } catch {
        // Skip unreadable / corrupt report; reconcile is best-effort.
      }
    }
    // Sort newest-first by mtime so the most-recent destination
    // ends up at the front of the merged list in the renderer.
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    // Dedupe by normalised path (case-insensitive, trailing-sep
    // stripped) while keeping the first occurrence (newest).
    const seen = new Set<string>();
    const uniquePaths: string[] = [];
    for (const c of candidates) {
      const norm = c.path.replace(/[\\/]+$/, '').toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      uniquePaths.push(c.path);
    }
    return { success: true, data: { paths: uniquePaths } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─── library:discoverLegacyLibraries ────────────────────────────────────────
// v2.0.15 (Terry 2026-06-04) — Library-history discovery.
//
// Reads every distinct destination_path PDR has ever written to from
// the indexed_runs table (which is the cumulative log of every Fix
// run's destination, surviving even when the renderer-side
// pdr-saved-destinations list got capped at 3 in old versions).
// Returns rows for paths that:
//   (1) STILL EXIST ON DISK — fs.existsSync proves the folder is
//       reachable, so the user can actually act on it.
//   (2) AREN'T ALREADY in the LDM — comparison happens in the
//       renderer because the LDM list lives in localStorage and
//       isn't visible to main.
//
// The renderer receives the full set and applies its own filters
// (current Library Drive + already-saved + ignore list) on top.
// This split keeps the SQL side simple and lets the renderer's
// filter logic share a single source of truth with the rest of
// the LDM rendering.
//
// Why indexed_runs vs reading PDR_Catalogue.csv directly: indexed_runs
// is canonical (set at Fix time, never re-derived), is queryable in
// O(rows) with SQL, and survives CSV-file deletion or library
// relocation. The CSV is a derived view of the same data.
ipcMain.handle('library:discoverLegacyLibraries', async () => {
  try {
    const db = getDb();
    // GROUP BY destination_path to collapse multiple Fix runs to the
    // same library into one row, summing their file counts and taking
    // the latest indexed_at as "last seen". COALESCE on file_count
    // because the column is NOT NULL DEFAULT 0 but old rows may be 0.
    const rows = db.prepare(`
      SELECT
        destination_path,
        MAX(indexed_at) AS last_indexed_at,
        SUM(COALESCE(file_count, 0)) AS total_file_count,
        COUNT(*) AS run_count
      FROM indexed_runs
      WHERE destination_path IS NOT NULL AND destination_path != ''
      GROUP BY destination_path
      ORDER BY last_indexed_at DESC
    `).all() as Array<{
      destination_path: string;
      last_indexed_at: string;
      total_file_count: number;
      run_count: number;
    }>;

    // Reachability check — only return paths that still exist on
    // disk so the renderer can offer a real "Add to LDM" CTA. Paths
    // whose drive is currently unplugged are filtered out here; if
    // the user plugs the drive back in and re-opens the LDM, they'll
    // appear next time. Honest UX > "discovered but unreachable"
    // ghost rows.
    const discovered = rows
      .filter(r => {
        try {
          return fs.existsSync(r.destination_path);
        } catch {
          return false;
        }
      })
      .map(r => ({
        path: r.destination_path,
        lastIndexedAt: r.last_indexed_at,
        totalFileCount: r.total_file_count,
        runCount: r.run_count,
      }));

    return { success: true, data: { libraries: discovered } };
  } catch (err) {
    log.error('[library:discoverLegacyLibraries] failed:', (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
});

// ─── library:scanForLegacyLibraries ─────────────────────────────────────────
// v2.0.15 (Terry 2026-06-04) — drive-scan discovery (Strategies 1 + 2
// from Terry's three-strategy proposal). Complements
// library:discoverLegacyLibraries (which reads indexed_runs, the SQL
// log of every Fix run inside PDR's search-index DB). This handler
// scans the filesystem itself, picking up libraries the SQL log
// can't see:
//
//   Strategy 1 (high confidence) — find PDR_Catalogue.csv files
//   anywhere on connected drives, then extract distinct
//   destination_path values from each. Catches libraries that exist
//   on disk but whose indexed_runs rows are gone (PDR reinstalled,
//   different machine, AppData reset, etc.). The catalogue file
//   travels with the library when copied/moved, so a CSV at
//   X:\OldPhotos\PDR_Catalogue.csv is a near-100% signal that
//   X:\OldPhotos was once a PDR library.
//
//   Strategy 2 (medium confidence, opportunistic) — find folders
//   matching PDR's year-based output structure: a folder whose
//   IMMEDIATE children include 2+ year folders (/^\d{4}$/), where
//   at least one year folder contains a year-month subfolder
//   (/^\d{4}-\d{2}/). This is the structure PDR creates by default;
//   matching it without a catalogue file present is weaker signal
//   (Lightroom and manual organisers also produce this) but worth
//   surfacing as "this looks like a PDR library, was it one?"
//
// Walk constraints — keep the scan bounded:
//   • Depth cap of 6 levels (libraries are typically 2–4 deep)
//   • Skip OS-system folders ($RECYCLE.BIN, System Volume Information,
//     Windows, Program Files, ProgramData, AppData, node_modules, .git)
//   • Skip hidden folders (names starting with .)
//   • Skip folders the walker can't read (permission errors swallowed)
//
// Returns an array of candidate library paths, each with provenance
// (which strategy found it) and a "lastSeenAt" mtime for sorting.
// Caller deduplicates by normalised path against the SQL discovery
// results and the user's existing LDM list.
const LEGACY_SCAN_DEPTH_CAP = 6;
const LEGACY_SCAN_SKIP_NAMES = new Set([
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'appdata',
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'recovery',
  'msocache',
  'perflogs',
  '$windows.~bt',
  '$windows.~ws',
]);

interface LegacyScanCandidate {
  path: string;
  /** v2.0.15 hotfix #4 — only 'catalogue-csv' now exists. Strategy 2
   *  (folder-pattern) was dropped because it produced random year-
   *  folder false positives that weren't cross-referenced against any
   *  catalogue. Catalogue file presence is the only authoritative
   *  signal — if PDR didn't write a catalogue there, it's not a PDR
   *  library. */
  source: 'catalogue-csv';
  /** mtime of the catalogue CSV. ISO string, sorted newest-first
   *  by caller. */
  lastSeenAt: string;
  /** Number of distinct destinations the CSV reveals — helpful when
   *  one catalogue references multiple historical destinations
   *  (Terry's H-drive case). */
  destinationCount?: number;
  /** Actual on-disk media-file count, capped at LEGACY_FILE_COUNT_CAP.
   *  Candidates with 0 files are dropped before results are returned. */
  currentFileCount: number;
  /** True when currentFileCount hit the cap — renderer shows "50+"
   *  instead of "50" so users don't misread the cap as the actual size. */
  currentFileCountCapped: boolean;
}

/** Cap on the per-candidate file count walk. 50 is enough to
 *  distinguish "empty" from "few" from "many" without walking a
 *  10k-file library. Folders with > 50 files render as "50+ files"
 *  on the card. */
const LEGACY_FILE_COUNT_CAP = 50;

/** Quick media-file counter with early exit. Walks the folder tree
 *  depth-first, counts files matching PHOTO_EXTENSIONS_PRESCAN /
 *  VIDEO_EXTENSIONS_PRESCAN, returns as soon as the cap is reached.
 *  Skips the same OS-system + hidden folders as the main scan walk
 *  so e.g. a Windows folder doesn't get probed for media files. */
async function countMediaFilesQuick(
  rootPath: string,
  cap: number,
  depth = 0,
  depthCap = 6
): Promise<number> {
  if (depth > depthCap) return 0;
  let count = 0;
  let entries: { name: string; isDirectory: boolean; isFile: boolean }[] = [];
  try {
    const dirents = await fs.promises.readdir(rootPath, { withFileTypes: true });
    entries = dirents.map(d => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
    }));
  } catch {
    return 0; // permission denied / unreadable — treat as empty
  }
  // Files first — cheaper than recursing.
  for (const e of entries) {
    if (!e.isFile) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (PHOTO_EXTENSIONS_PRESCAN.has(ext) || VIDEO_EXTENSIONS_PRESCAN.has(ext)) {
      count++;
      if (count >= cap) return count;
    }
  }
  for (const e of entries) {
    if (!e.isDirectory) continue;
    if (e.name.startsWith('.')) continue;
    if (LEGACY_SCAN_SKIP_NAMES.has(e.name.toLowerCase())) continue;
    const childCount = await countMediaFilesQuick(
      path.join(rootPath, e.name),
      cap - count,
      depth + 1,
      depthCap
    );
    count += childCount;
    if (count >= cap) return count;
  }
  return count;
}

/** Parse PDR_Catalogue.csv and return distinct destination_path values.
 *  Stops reading after MAX_CSV_BYTES to avoid pathological reads on
 *  a 500 MB catalogue (worst case for a power user with millions of
 *  rows). The destination_path column is constant per Fix run, so
 *  we only need to sample enough rows to find all distinct values
 *  — a single Fix run with 1M files contributes 1 unique value. */
async function extractDestinationsFromCatalogue(csvPath: string): Promise<string[]> {
  const MAX_CSV_BYTES = 32 * 1024 * 1024; // 32 MB hard cap
  try {
    const stat = await fs.promises.stat(csvPath);
    const readSize = Math.min(stat.size, MAX_CSV_BYTES);
    const fd = await fs.promises.open(csvPath, 'r');
    try {
      const buf = Buffer.alloc(readSize);
      await fd.read(buf, 0, readSize, 0);
      const text = buf.toString('utf-8');
      const lines = text.split(/\r?\n/);
      if (lines.length === 0) return [];
      // Header parse — find destination_path column index. Catalogue
      // worker schema (line 401 of electron/catalogue-worker.ts):
      //   confidence, confidence_method, source_path, destination_path, ...
      const header = lines[0].split(',').map(c => c.trim().toLowerCase());
      const idx = header.indexOf('destination_path');
      if (idx === -1) return [];
      const distinct = new Set<string>();
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        // Simple CSV split — destination_path values shouldn't contain
        // commas in practice (Windows paths use \). If a future field
        // ever requires quote-escaping, swap in a real CSV parser.
        const cells = line.split(',');
        if (cells.length <= idx) continue;
        const raw = cells[idx].trim();
        if (!raw) continue;
        distinct.add(raw);
        // Early-out — once we've seen 50 distinct destinations from a
        // single CSV we've almost certainly covered the user's history;
        // continuing would just re-add duplicates.
        if (distinct.size >= 50) break;
      }
      return Array.from(distinct);
    } finally {
      await fd.close();
    }
  } catch (err) {
    log.warn(`[scanForLegacyLibraries] CSV parse failed for ${csvPath}:`, (err as Error).message);
    return [];
  }
}

/** Recursive walk. Skips hidden + system folders, depth-capped. Calls
 *  the visitor for each directory it enters; the visitor returns
 *  whether to descend into that directory's children. */
async function walkForLegacyLibraries(
  rootPath: string,
  depth: number,
  visitDir: (dirPath: string, entries: { name: string; isDirectory: boolean; isFile: boolean }[]) => Promise<boolean>
): Promise<void> {
  if (depth > LEGACY_SCAN_DEPTH_CAP) return;
  let entries: { name: string; isDirectory: boolean; isFile: boolean }[] = [];
  try {
    const dirents = await fs.promises.readdir(rootPath, { withFileTypes: true });
    entries = dirents.map(d => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
    }));
  } catch {
    return; // permission denied / unreadable — skip silently
  }
  const shouldRecurse = await visitDir(rootPath, entries);
  if (!shouldRecurse) return;
  for (const e of entries) {
    if (!e.isDirectory) continue;
    if (e.name.startsWith('.')) continue;
    if (LEGACY_SCAN_SKIP_NAMES.has(e.name.toLowerCase())) continue;
    const childPath = path.join(rootPath, e.name);
    await walkForLegacyLibraries(childPath, depth + 1, visitDir);
  }
}

/** List the connected logical drive letters on Windows. Returns
 *  bare-root paths like 'C:\\', 'D:\\'. Falls back to a smaller set
 *  if the PowerShell call fails. */
async function listConnectedDriveRoots(): Promise<string[]> {
  try {
    const { execSync } = await import('child_process');
    const out = execSync(
      'powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | Select-Object -ExpandProperty Root"',
      { encoding: 'utf-8', timeout: 5000 }
    );
    const roots = out.split(/\r?\n/).map(s => s.trim()).filter(s => /^[A-Z]:\\?$/i.test(s));
    return roots.length > 0 ? roots : ['C:\\'];
  } catch {
    return ['C:\\'];
  }
}

ipcMain.handle('library:scanForLegacyLibraries', async (_event, opts?: { driveLetters?: string[] }) => {
  try {
    const roots = opts?.driveLetters && opts.driveLetters.length > 0
      ? opts.driveLetters
      : await listConnectedDriveRoots();
    const candidates = new Map<string, LegacyScanCandidate>();
    const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();

    // To check parent-folder candidacy in Strategy 2, we need to look
    // at folder entries DURING the walk (when we're sitting on a
    // potential library root, before descending). The visitor returns
    // false to prune (don't descend further into a candidate — the
    // year folders are leaves for discovery purposes; we don't want
    // YYYY-MM folders also flagged).
    for (const root of roots) {
      await walkForLegacyLibraries(root, 0, async (dirPath, entries) => {
        // Strategy 1 — catalogue file in this directory?
        const catalogueEntry = entries.find(e => e.isFile && e.name === 'PDR_Catalogue.csv');
        if (catalogueEntry) {
          const csvPath = path.join(dirPath, catalogueEntry.name);
          try {
            const stat = await fs.promises.stat(csvPath);
            const destinations = await extractDestinationsFromCatalogue(csvPath);
            // The folder itself IS a discovered library (catalogue
            // lives at the library root), plus every distinct
            // destination_path referenced inside the CSV.
            const norms = new Set<string>();
            const seed = async (libPath: string) => {
              const n = norm(libPath);
              if (norms.has(n)) return;
              norms.add(n);
              if (candidates.has(n)) return; // already discovered via another strategy
              // v2.0.15 hotfix — count files on disk NOW (capped) to
              // filter empties before they reach the renderer. CSV-
              // referenced destinations might point at folders that
              // were emptied / deleted since the Fix run.
              const fileCount = await countMediaFilesQuick(libPath, LEGACY_FILE_COUNT_CAP);
              if (fileCount === 0) return; // empty — drop, don't return
              candidates.set(n, {
                path: libPath,
                source: 'catalogue-csv',
                lastSeenAt: stat.mtime.toISOString(),
                destinationCount: destinations.length,
                currentFileCount: fileCount,
                currentFileCountCapped: fileCount >= LEGACY_FILE_COUNT_CAP,
              });
            };
            await seed(dirPath);
            for (const d of destinations) await seed(d);
          } catch (err) {
            log.warn(`[scanForLegacyLibraries] stat/parse failed for ${csvPath}:`, (err as Error).message);
          }
          // Don't descend further from a catalogue-confirmed library —
          // its year subfolders are part of the library, not separate
          // candidates.
          return false;
        }
        // v2.0.15 hotfix #4 (Terry 2026-06-04) — Strategy 2 (folder-
        // pattern detection) DROPPED. Terry's pushback: any folder
        // not mentioned somewhere in a PDR catalogue CSV shouldn't be
        // surfaced as a "discovered library" — that's guessing, not
        // cross-referencing. Folder-pattern was producing too many
        // false positives even with the PDR-naming-convention tighten
        // (any year-folder tree that happened to contain one PDR-
        // renamed file would still surface). The catalogue file is
        // the authoritative signal: if PDR didn't write a catalogue
        // there, it's not a PDR library, full stop.
        //
        // Not a catalogue location — keep walking children.
        return true;
      });
    }

    // Filter to candidates that still exist (defensive — the walk
    // already only visits reachable paths) and dedupe.
    const result = Array.from(candidates.values())
      .filter(c => {
        try { return fs.existsSync(c.path); } catch { return false; }
      })
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

    return { success: true, data: { candidates: result } };
  } catch (err) {
    log.error('[scanForLegacyLibraries] failed:', (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('library:listIndexedDrives', async () => {
  try {
    const db = getDb();
    // Two passes: drive-letter paths (UPPER(SUBSTR) for case-insensitive
    // grouping since Windows is case-insensitive on drive letters but
    // SQLite isn't by default), then UNC / network paths.
    // Table is `indexed_files` (not `files` — easy mistake when looking
    // at the IndexedFile interface). 9000+ rows in Terry's DB returned
    // nothing on the first cut because the query targeted the wrong
    // table — confirmed by the search-database.ts CREATE TABLE line.
    const letterRows = db.prepare(`
      SELECT
        UPPER(SUBSTR(file_path, 1, 2)) AS drive,
        COUNT(*) AS file_count,
        COALESCE(SUM(size_bytes), 0) AS total_bytes,
        MAX(indexed_at) AS last_indexed
      FROM indexed_files
      WHERE file_path GLOB '[A-Za-z]:*'
      GROUP BY drive
      ORDER BY drive
    `).all() as Array<{ drive: string; file_count: number; total_bytes: number; last_indexed: string | null }>;

    const uncRows = db.prepare(`
      SELECT
        COUNT(*) AS file_count,
        COALESCE(SUM(size_bytes), 0) AS total_bytes,
        MAX(indexed_at) AS last_indexed
      FROM indexed_files
      WHERE file_path LIKE '\\\\%'
    `).all() as Array<{ file_count: number; total_bytes: number; last_indexed: string | null }>;

    // Resolve labels for letter drives in parallel — PowerShell calls
    // are the slowest part of this handler, so parallelising keeps the
    // total wall time at ~1× single-drive lookup latency even with many
    // drives. PowerShell never blocks on missing drives (it just
    // returns null fields), so we don't need a separate online check.
    const letterDrives = await Promise.all(letterRows.map(async (row) => {
      const driveId = row.drive; // e.g. "L:"
      const driveLetter = driveId[0];
      const drivePath = `${driveId}\\`;
      let volumeLabel: string | null = null;
      let driveTypeCode: number | null = null;
      let totalBytes = 0;
      let freeBytes = 0;
      if (process.platform === 'win32') {
        try {
          const output = await new Promise<string>((resolve, reject) => {
            execFile('powershell.exe', [
              '-NoProfile', '-NonInteractive', '-Command',
              `$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${driveId}'"; ` +
              `@{VolumeName=$d.VolumeName; DriveType=[int]$d.DriveType; Size=[int64]$d.Size; FreeSpace=[int64]$d.FreeSpace} | ConvertTo-Json -Compress`
            ], { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
              if (error) reject(error);
              else resolve(stdout);
            });
          });
          const parsed = JSON.parse(output.trim());
          volumeLabel = (parsed.VolumeName && String(parsed.VolumeName).trim()) ? String(parsed.VolumeName).trim() : null;
          driveTypeCode = typeof parsed.DriveType === 'number' ? parsed.DriveType : null;
          totalBytes = typeof parsed.Size === 'number' ? parsed.Size : 0;
          freeBytes = typeof parsed.FreeSpace === 'number' ? parsed.FreeSpace : 0;
        } catch {
          // Drive offline / not present → leave all fields null; the
          // renderer will show "Offline" pill based on the online flag.
        }
      }
      const driveTypeLabel = driveTypeCode === 2 ? 'Removable drive'
        : driveTypeCode === 3 ? 'Internal drive'
        : driveTypeCode === 4 ? 'Network drive'
        : driveTypeCode === 5 ? 'CD/DVD'
        : 'Drive';
      return {
        kind: 'letter' as const,
        path: drivePath,
        letter: driveId,
        volumeLabel,
        driveTypeLabel,
        driveTypeCode,
        totalBytes,
        freeBytes,
        online: fs.existsSync(drivePath),
        indexedFileCount: row.file_count,
        indexedBytes: row.total_bytes,
        lastIndexedAt: row.last_indexed,
      };
    }));

    const uncDrives = uncRows
      .filter(r => r.file_count > 0)
      .map(r => ({
        kind: 'unc' as const,
        path: '\\\\',
        letter: null,
        volumeLabel: 'Network / mounted shares',
        driveTypeLabel: 'Network',
        driveTypeCode: 4,
        totalBytes: 0,
        freeBytes: 0,
        online: true, // can't cheaply verify reachability of every share — assume online
        indexedFileCount: r.file_count,
        indexedBytes: r.total_bytes,
        lastIndexedAt: r.last_indexed,
      }));

    return { success: true, data: { drives: [...letterDrives, ...uncDrives] } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─── library:countFilesAtPath ────────────────────────────────────────────────
// Per-path indexed-file count. Returns the count + total size + last
// indexed timestamp for every row in `indexed_files` whose file_path
// starts with the given rootPath. Used by the LDM to show ACCURATE
// per-folder counts for library-root rows (currentPath +
// savedDestinations) instead of the over-attributing per-drive-letter
// rollup that `listIndexedDrives` returns.
//
// Terry's report 2026-05-16: with two libraries on the same drive
// (D:\1. Photos\1. PDR Library Drive and D:\1. Photos\Test), the LDM
// showed identical 99-photos / 272.4 MB counts for BOTH rows because
// the underlying query was per-drive-letter. The fix is per-path
// counts. The roll-up still has its place (for bare drive-letter
// rows that aren't a library root), but library-root rows now get
// their own real count.
//
// Path-prefix match: the LIKE pattern is `<normalised root>%` with a
// trailing separator added if missing, so D:\1. Photos\Test doesn't
// also match D:\1. Photos\Test2. SQL LIKE wildcards in the path are
// escaped with a backslash and an ESCAPE clause.
ipcMain.handle('library:countFilesAtPath', async (_event, rootPath: unknown) => {
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    log.warn('[library:countFilesAtPath] invalid rootPath:', rootPath);
    return { success: false, error: 'rootPath is required' };
  }
  try {
    const db = getDb();
    // Normalise: strip trailing separator, then add a single one so
    // the LIKE prefix can't match a sibling whose name starts with
    // the same characters.
    let prefix = rootPath.replace(/[\\/]+$/, '');
    // Escape SQL LIKE wildcards (% and _) and the escape char itself.
    prefix = prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    // Add the separator + wildcard. Match on either \\ or / so we
    // handle both Windows and POSIX-style paths from the DB.
    const likePatternWin = `${prefix}\\\\%`;
    const likePatternPosix = `${prefix.replace(/\\\\/g, '/')}/%`;
    // Also match the prefix itself (in case the path is stored
    // without a trailing separator and IS exactly a single file's
    // parent dir — rare, but defensive).
    const row = db.prepare(`
      SELECT
        COUNT(*) AS file_count,
        COALESCE(SUM(size_bytes), 0) AS total_bytes,
        MAX(indexed_at) AS last_indexed
      FROM indexed_files
      WHERE file_path LIKE ? ESCAPE '\\'
         OR file_path LIKE ? ESCAPE '\\'
    `).get(likePatternWin, likePatternPosix) as { file_count: number; total_bytes: number; last_indexed: string | null };
    log.info(`[library:countFilesAtPath] rootPath=${JSON.stringify(rootPath)} count=${row.file_count} bytes=${row.total_bytes}`);
    return {
      success: true,
      data: {
        indexedFileCount: row.file_count,
        indexedBytes: row.total_bytes,
        lastIndexedAt: row.last_indexed,
      },
    };
  } catch (err) {
    log.error('[library:countFilesAtPath] failed:', (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
});

// ─── library:countOnDiskFiles ───────────────────────────────────────────────
// v2.0.9 — recursively walks `rootPath` and returns the number of media
// files (photo + video extensions) found on disk. Used by the
// Unindexed-Libraries Dashboard banner + the LDM "X unindexed" pill to
// compare against indexedFileCount (from library:countFilesAtPath) and
// surface libraries whose contents predate v2.0.5's auto-index-by-default
// or were explicitly opted out. Skips hidden / system folders the same
// way the rebuild indexer does (.dotdirs, $RECYCLE.BIN, System Volume
// Information), so the count matches what a re-index would actually
// insert.
ipcMain.handle('library:countOnDiskFiles', async (_event, rootPath: unknown) => {
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    log.warn('[library:countOnDiskFiles] invalid rootPath:', rootPath);
    return { success: false, error: 'rootPath is required' };
  }
  try {
    // Reachability guard — if the drive isn't mounted right now the
    // walker would just return 0 and the caller would interpret that
    // as "fully indexed, no banner needed", masking the real state.
    // Return a distinct flag instead so the caller can hide the row
    // from comparisons until the drive comes back.
    if (!fs.existsSync(rootPath)) {
      return { success: true, data: { onDiskCount: null, reachable: false } };
    }
    const files = walkMediaFiles(rootPath);
    log.info(`[library:countOnDiskFiles] rootPath=${JSON.stringify(rootPath)} onDiskCount=${files.length}`);
    return { success: true, data: { onDiskCount: files.length, reachable: true } };
  } catch (err) {
    log.error('[library:countOnDiskFiles] failed:', (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
});

// ─── library:exportDb ───────────────────────────────────────────────────────
// Premium safeguard introduced when we softened the "must be external
// drive" rule for the Library Drive: the user can now keep a portable
// copy of the search DB anywhere (email, cloud, second drive), so they
// don't need to choose an external Library Drive purely for portability.
//
// Flow: ask the user where to save via the native save dialog, flush
// any in-flight WAL writes with a full checkpoint, then copy
// pdr-search.db to the chosen path. fs.copyFileSync is safe once we've
// checkpointed — WAL mode means the .db file plus the .wal file
// together represent the current state, and a checkpoint merges them
// into the .db so a single-file copy is consistent.
ipcMain.handle('library:exportDb', async () => {
  try {
    const browserWindow = BrowserWindow.getFocusedWindow();
    if (!browserWindow) return { success: false, error: 'No active window' };

    const today = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(browserWindow, {
      title: 'Download Library DB',
      defaultPath: `pdr-library-${today}.db`,
      filters: [{ name: 'SQLite Database', extensions: ['db'] }],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, error: 'cancelled' };
    }

    // Flush WAL into the main DB file so the copy is fully consistent.
    try {
      const db = getDb();
      db.pragma('wal_checkpoint(FULL)');
    } catch (e) {
      log.warn('[library:exportDb] wal_checkpoint failed (continuing with copy):', (e as Error).message);
    }

    const sourceDbPath = path.join(app.getPath('userData'), 'search-index', 'pdr-search.db');
    if (!fs.existsSync(sourceDbPath)) {
      return { success: false, error: 'Library DB not found on this device.' };
    }
    fs.copyFileSync(sourceDbPath, result.filePath);
    return { success: true, data: { path: result.filePath } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─── v2.0.13 takeout sidecar pre-scan ──────────────────────────────────────
//
// Walks a list of multi-part Google Takeout zips, pulls every JSON
// sidecar out of each zip's central directory (no photo bytes read),
// and writes them to the takeout_sidecars table. The analysis engine
// and the Enrichment pass both consult that table so a photo finds
// its sidecar regardless of which zip in the export the JSON lives
// in. Closes the 267-file dedup miss Terry diagnosed 2026-05-25.

ipcMain.handle('takeout:preScanSidecars', async (_event, zipPaths: string[]) => {
  try {
    if (!Array.isArray(zipPaths) || zipPaths.length === 0) {
      return { success: false, error: 'zipPaths must be a non-empty array' };
    }
    const summary = await scanSidecarsFromZips(zipPaths, (progress) => {
      try {
        mainWindow?.webContents.send('takeout:preScanProgress', progress);
      } catch { /* best-effort */ }
    });
    return { success: true, data: summary };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('takeout:getSidecarSummary', async () => {
  try {
    return { success: true, data: getSidecarSummary() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Helper for the renderer's source-menu banner: given a path,
// return the Takeout group id if the filename matches the
// multi-part Takeout naming pattern, else null.
ipcMain.handle('takeout:detectGroupId', async (_event, zipPath: string) => {
  try {
    return { success: true, data: extractTakeoutGroupId(zipPath) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─── v2.0.13 Enrichment pass ──────────────────────────────────────────────
//
// Reads the takeout_sidecars cache + indexed_files, renames _RC and
// _MK files whose sidecars carry a precise photoTakenTime to _CF,
// rewrites EXIF date / GPS / description, seeds face-name hints
// additively, writes an enrichment_log audit row per change.
// Strictly additive — never touches Trees data, never overrides a
// user-set person_id, never deletes album_files rows. See the
// enrichment-engine.ts header for the full additive-only rule.

ipcMain.handle('enrich:dryRun', async () => {
  try {
    log.info('[enrich:dryRun] starting');
    const result = dryRunEnrichment();
    log.info(`[enrich:dryRun] success — ${JSON.stringify(result)}`);
    return { success: true, data: result };
  } catch (err) {
    log.error('[enrich:dryRun] FAILED:', (err as Error).message, (err as Error).stack);
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('enrich:run', async () => {
  try {
    const summary = await runEnrichment((p) => {
      try {
        mainWindow?.webContents.send('enrich:progress', p);
      } catch { /* best-effort */ }
    });
    return { success: true, data: summary };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('enrich:getLatestRun', async () => {
  try {
    return { success: true, data: getLatestEnrichmentRun() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('enrich:cancel', async () => {
  try {
    cancelEnrichment();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─── captions:* (v2.0.13) ───────────────────────────────────────────────────
//
// Per-photo user-applied captions. Stored on indexed_files.caption
// (column added in v2.0.8 for Takeout import). v2.0.13 adds direct
// per-photo right-click editing in Albums / By Date / Search & Discovery
// plus optional EXIF write-through (ImageDescription + XMP dc:description)
// so the caption travels with the file when it leaves PDR's library.
//
// Additive-only rule: the caption column is independent of any auto-
// enrichment. Setting an empty/null caption is treated as "clear it",
// not "leave alone". Writing EXIF is opt-in per call; if the user
// hasn't asked for it, the caption only lives in the DB.

ipcMain.handle('captions:get', async (_event, fileId: number) => {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT caption FROM indexed_files WHERE id = ?`).get(fileId) as { caption: string | null } | undefined;
    return { success: true, data: row?.caption ?? null };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// v2.0.13 — viewer-friendly lookup. The standalone viewer window
// only knows file paths (not indexed_files ids) since it's loaded
// with a flat list of paths via openSearchViewer. This lets it
// resolve the caption without having to know the DB schema.
ipcMain.handle('captions:getByPath', async (_event, filePath: string) => {
  try {
    if (typeof filePath !== 'string' || !filePath) return { success: true, data: null };
    const db = getDb();
    const row = db.prepare(`SELECT caption FROM indexed_files WHERE file_path = ? LIMIT 1`).get(filePath) as { caption: string | null } | undefined;
    return { success: true, data: row?.caption ?? null };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// v2.0.13 (Terry 2026-05-27) — DB write is synchronous and fast;
// the EXIF write is async but goes through exiftool-vendored's
// single subprocess, which serialises against any other exiftool
// caller (the analysis indexer in particular). Awaiting the EXIF
// write inside the IPC handler can stall the IPC promise for
// several seconds when exiftool is busy, which Windows interprets
// as "Not Responding" and paints the title bar white.
//
// Decoupling: update the DB synchronously and return success, then
// schedule the EXIF write on the next tick. Failures are logged but
// don't surface back to the user — the DB caption is what powers
// every PDR surface, and the EXIF write is the "travels with the
// file when exported" bonus. A future polish could write a small
// pending-writes table for retry; for now, the practical impact of
// the rare EXIF-write failure is "caption is in PDR but not in the
// file's metadata" — recoverable by editing the caption again later.
function scheduleCaptionExifWrite(filePath: string, description: string | '') {
  setImmediate(async () => {
    try {
      if (!fs.existsSync(filePath)) return;
      const { writeEnrichmentExif } = await import('./exif-writer.js');
      const stat = fs.statSync(filePath);
      await writeEnrichmentExif(filePath, stat.mtime, {
        gpsLat: null,
        gpsLon: null,
        description,
      });
    } catch (exifErr) {
      log.warn('[captions] background EXIF write failed:', (exifErr as Error).message);
    }
  });
}

ipcMain.handle('captions:set', async (_event, args: { fileId: number; caption: string; writeExif?: boolean }) => {
  try {
    const { fileId, caption, writeExif } = args;
    const db = getDb();
    const trimmed = (caption ?? '').trim();
    const value = trimmed.length === 0 ? null : trimmed;
    const row = db.prepare(`SELECT file_path FROM indexed_files WHERE id = ?`).get(fileId) as { file_path: string } | undefined;
    if (!row) return { success: false, error: 'File not found in index.' };
    db.prepare(`UPDATE indexed_files SET caption = ? WHERE id = ?`).run(value, fileId);
    if (writeExif && value) {
      scheduleCaptionExifWrite(row.file_path, value);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('captions:clear', async (_event, args: { fileId: number; writeExif?: boolean }) => {
  try {
    const { fileId, writeExif } = args;
    const db = getDb();
    const row = db.prepare(`SELECT file_path FROM indexed_files WHERE id = ?`).get(fileId) as { file_path: string } | undefined;
    if (!row) return { success: false, error: 'File not found in index.' };
    db.prepare(`UPDATE indexed_files SET caption = NULL WHERE id = ?`).run(fileId);
    if (writeExif) {
      scheduleCaptionExifWrite(row.file_path, '');
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─── library:openInExplorer ─────────────────────────────────────────────────
// Thin wrapper over Electron's shell.openPath. Used by the LDM's "Open
// in File Explorer" buttons. shell.openPath returns an empty string on
// success or an error message on failure (Electron API contract), which
// we surface in the standard { success, error } envelope.
ipcMain.handle('library:openInExplorer', async (_event, targetPath: string) => {
  try {
    if (!targetPath) return { success: false, error: 'targetPath is required' };
    if (!fs.existsSync(targetPath)) {
      return { success: false, error: 'Path does not exist on disk.' };
    }
    const errMsg = await shell.openPath(targetPath);
    if (errMsg) return { success: false, error: errMsg };
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('library:attachAsNew', async (_event, opts: { libraryRoot: string; licenseKey: string; deviceName: string; snapshotMode?: 'none' | 'recent' | 'all' }) => {
  try {
    if (!opts?.libraryRoot || !opts?.licenseKey || !opts?.deviceName) {
      return { success: false, error: 'libraryRoot, licenseKey and deviceName are required' };
    }
    const result = await attachAsNewLibrary(opts);
    return result.ok ? { success: true, data: result.status } : { success: false, error: result.error };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('library:attachFromSidecar', async (_event, opts: { libraryRoot: string; licenseKey: string; deviceName: string }) => {
  try {
    if (!opts?.libraryRoot || !opts?.licenseKey || !opts?.deviceName) {
      return { success: false, error: 'libraryRoot, licenseKey and deviceName are required' };
    }
    const result = await attachFromSidecar(opts);
    return result.ok ? { success: true, data: result.status } : { success: false, error: result.error };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// v2.0.12 — recovery-gap detector. Renderer calls this on workspace
// mount; if the sidecar on the attached Library Drive shows a cascade
// signature (materially more indexed_files + indexed_runs than the
// local DB), the workspace surfaces a banner offering a one-click
// attachFromSidecar restore. Returns null when there's nothing to
// recover; the renderer hides the banner in that case.
ipcMain.handle('library:detectRecoveryGap', async () => {
  try {
    const status = getLibraryStatus();
    if (!status.attached || !status.libraryRoot) {
      return { success: true, data: null };
    }
    const gap = detectRecoveryGap(status.libraryRoot);
    return { success: true, data: gap };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('library:takeOverWriter', async (_event, opts: { libraryRoot: string; licenseKey: string; deviceName: string }) => {
  try {
    if (!opts?.libraryRoot || !opts?.licenseKey || !opts?.deviceName) {
      return { success: false, error: 'libraryRoot, licenseKey and deviceName are required' };
    }
    const result = takeOverWriter(opts);
    return result.ok ? { success: true, data: result.status } : { success: false, error: result.error };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('library:mirrorNow', async (_event, opts?: { snapshotMode?: 'none' | 'recent' | 'all' }) => {
  try {
    const status = getLibraryStatus();
    if (!status.attached || !status.libraryRoot) {
      return { success: false, error: 'No library attached' };
    }
    if (!status.isWriter) {
      return { success: false, error: 'This device is read-only on the current library' };
    }
    const result = await mirrorAllToSidecar(status.libraryRoot, opts?.snapshotMode ?? 'recent');
    return result.ok ? { success: true, data: result } : { success: false, error: result.error };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('library:disconnect', async () => {
  try {
    disconnectLibrary();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Generic "mark the local DB dirty" hook for renderer-side writes that
// don't pass through one of the search:* IPC handlers (e.g. People
// Manager rename / merge, Date Editor apply, Trees save). The renderer
// calls this after a successful write; the background mirror loop will
// flush within ~30 seconds.
ipcMain.handle('library:bumpDirty', async () => {
  try {
    markDbDirty();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

let viewerWindow: BrowserWindow | null = null;

// Rapid-click guard. The viewer's loadFile is asynchronous and
// passes a JSON-encoded file list in the URL query string — for
// Memories — By Date buckets with thousands of files that payload
// can take a few hundred ms to ship + parse. If a second
// search:openViewer call lands while the first loadFile is still in
// flight, Electron aborts the in-flight load and logs the alarming
// "Failed to load URL" error visible in the main log. The page
// eventually loads (the latest loadFile wins) but the noise looked
// like a real failure to Terry 2026-05-20 ("It kept freaking out
// and freezing... looked like it was going to crash"). This lock
// ignores duplicate calls until the active load resolves (via
// did-finish-load or did-fail-load), then accepts again. Lifetime
// is per-handler-invocation — never persists across viewer windows.
let viewerLoadInFlight = false;
// v2.0.14 (Terry 2026-05-28) — the previous shape of search:openViewer
// stuffed every file path into a URL query string. On a year drilldown
// with 6,000+ photos the URL hit ~1 MB; Chromium's URL parser and the
// viewer's JSON.parse round trip turned a viewer open into a ~60s
// freeze before the first pixel rendered. Pass the file list via main-
// process state instead — the viewer fetches it once on mount via the
// viewer:getPendingFileList IPC. Cleared after consumption so a stale
// list can't leak across opens.
let viewerPendingFiles: { files: string[]; startIndex: number } | null = null;
ipcMain.handle('viewer:getPendingFileList', () => {
  const payload = viewerPendingFiles;
  viewerPendingFiles = null;
  return payload ?? { files: [], startIndex: 0 };
});

ipcMain.handle('search:openViewer', async (_event, filePaths: string[], fileNames: string[], startIndex?: number) => {
  // Skip if a previous open is mid-flight. Returns success:true on
  // purpose — the caller doesn't need to retry; the previous load
  // will resolve and the viewer will appear with its file set. A
  // distinct error code would propagate as a toast in some callers
  // and look like a real failure.
  if (viewerLoadInFlight) {
    return { success: true, deduped: true };
  }
  try {
    viewerLoadInFlight = true;
    // Clamp the start index defensively so a bad caller can't open
    // the viewer at a non-existent slot.
    const start = (typeof startIndex === 'number' && startIndex >= 0 && startIndex < filePaths.length) ? startIndex : 0;
    // v2.0.14 — stash the file list in main state; the viewer fetches
    // it via viewer:getPendingFileList instead of parsing a URL with
    // a 6,000-element JSON blob in it.
    viewerPendingFiles = { files: filePaths, startIndex: start };
    const title = filePaths.length === 1
      ? fileNames[0] + ' — PDR Viewer'
      : `${start + 1} of ${filePaths.length} — PDR Viewer`;

    // Release the load lock as soon as the viewer's webContents
    // reports finished — succeed or fail. Attached once per
    // handler invocation (cleaned up by the .once method itself
    // when it fires). Wrapped in a small helper so both branches
    // (reuse + create-new) can share the same lifecycle.
    const releaseOn = (win: BrowserWindow) => {
      const release = () => { viewerLoadInFlight = false; };
      win.webContents.once('did-finish-load', release);
      win.webContents.once('did-fail-load', release);
      // Belt-and-braces — if neither event fires for some reason
      // (window destroyed mid-load, etc.), don't strand the lock
      // forever. 5 seconds is well beyond any realistic load.
      setTimeout(release, 5000);
    };

    // If viewer already open, reuse it
    if (viewerWindow && !viewerWindow.isDestroyed()) {
      // Same __dirname-relative pattern the main + people + date-
      // editor windows use. In packaged builds `__dirname` is
      // inside `app.asar/dist-electron`, so joining `../dist/public`
      // resolves to `app.asar/dist/public/...` and Electron's asar
      // loader handles it. The earlier `process.resourcesPath`
      // branch resolved to `resources/dist/public/` (outside asar),
      // which doesn't exist in our packaged layout — viewer.html
      // wasn't loading in the live v2.0.8 build. v2.0.9 hotfix.
      const viewerHtml = path.join(__dirname, '../dist/public/viewer.html');
      releaseOn(viewerWindow);
      viewerWindow.loadFile(viewerHtml);
      viewerWindow.setTitle(title);
      viewerWindow.focus();
      return { success: true };
    }

    viewerWindow = new BrowserWindow({
      width: 1000,
      height: 750,
      minWidth: 500,
      minHeight: 400,
      backgroundColor: '#1a1a2e',
      title,
      icon: app.isPackaged
        ? path.join(process.resourcesPath, 'assets', 'pdr-logo_transparent.png')
        : path.join(__dirname, '../client/public/assets/pdr-logo_transparent.png'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    hardenWindowAgainstNavigation(viewerWindow);

    // Same `__dirname`-relative pattern the reuse branch above and
    // the main / people / date-editor windows use. The earlier
    // v2.0.9 fix patched the REUSE branch but missed THIS one (the
    // create-new-viewer-window branch — runs on the very first
    // viewer open per launch). In packaged builds `__dirname` is
    // inside `app.asar/dist-electron`, so joining `../dist/public`
    // resolves to `app.asar/dist/public/viewer.html` and Electron's
    // asar loader handles it. `process.resourcesPath/dist/public/...`
    // sits OUTSIDE asar and doesn't exist in our packaged layout —
    // which is exactly what broke the viewer in v2.0.8 for every
    // first-time user.
    const viewerHtml = path.join(__dirname, '../dist/public/viewer.html');

    releaseOn(viewerWindow);
    viewerWindow.loadFile(viewerHtml);

    // Log renderer console messages to the main process so we can diagnose
    // preload / prepare failures that wouldn't otherwise be visible.
    viewerWindow.webContents.on('console-message', (_e, _level, message, line, sourceId) => {
      console.log(`[viewer] ${sourceId}:${line} ${message}`);
    });

    viewerWindow.on('closed', () => {
      viewerWindow = null;
    });

    return { success: true };
  } catch (err) {
    // Release the lock on early failure so the user can retry
    // (otherwise the very next click would deduplicate against the
    // lock that's still set from the failed call).
    viewerLoadInFlight = false;
    return { success: false, error: (err as Error).message };
  }
});

// Viewer broadcasts its current index after each navigation. Other
// renderers (PM's FaceGridModal) subscribe so their selection ring
// can track the viewer's photo. Send only to NON-sender windows so
// the viewer doesn't receive its own broadcast.
ipcMain.on('search:viewerIndexChange', (event, index: number, filePath: string) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (win.webContents.id === event.sender.id) continue;
    try { win.webContents.send('search:viewerIndex', { index, filePath }); } catch {}
  }
});

// ═══ People Manager Window ═══════════════════════════════════════════════════
//
// Two-stage open flow:
//
//   1. PRE-WARM (background, after main window paints): we create the PM
//      BrowserWindow with `show: false` so the renderer process boots,
//      mounts <PeopleManager>, fetches the cluster list (already cached by
//      prewarmPersonClusters), and pre-loads face crops — all invisibly.
//
//   2. OPEN (user clicks the People sidebar icon or S&D Manage): we just
//      `.show()` + `.focus()` the warm window. From the user's perspective
//      PM appears instantly because every expensive load has already
//      happened in the background while they were browsing folders.
//
//   - If the user clicks before pre-warm has fired (cold path), we fall
//     back to creating a window with `show: true` immediately — same
//     behaviour as before this change.
//   - If the user closes PM, the window is destroyed; the next click
//     creates fresh (we don't auto-re-warm — the user opted out).

let peopleWindow: BrowserWindow | null = null;
let peopleWindowIsWarm = false; // true while window exists but never been shown

function createPeopleWindow(opts: { show: boolean }): BrowserWindow {
  // Detect dark mode synchronously from a cached value if main window is
  // available; otherwise default light. Pre-warm fires a few seconds after
  // mainWindow loads so the cached classList is reliable by then.
  const isDark = !!mainWindow && !mainWindow.isDestroyed()
    ? false  // overridden below via async query when opts.show=true
    : false;

  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 700,
    minHeight: 500,
    show: opts.show,
    // paintWhenInitiallyHidden lets the renderer actually do its layout +
    // network even though the window is hidden. Without this, Electron may
    // suspend painting and our pre-warm becomes useless.
    paintWhenInitiallyHidden: true,
    backgroundColor: isDark ? '#1a1a2e' : '#f6f6fb',
    title: 'People Manager — Photo Date Rescue',
    // Custom-frame title bar to match the main PDR window. Lets the
    // Fix-status chip sit IN the title bar (consistent with the main
    // window) rather than below it. titleBarOverlay gives us native
    // OS window controls (min / max / close) at the top-right with
    // PDR's lavender theming, so we don't have to reinvent them.
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'hiddenInset',
    ...(process.platform === 'win32' ? {
      titleBarOverlay: {
        color: '#a99cff',
        symbolColor: '#ffffff',
        height: 32,
      },
    } : {}),
    // Independent top-level window. We deliberately do NOT set
    // `skipTaskbar: true` on Windows: that flag also excludes the window
    // from Alt-Tab and makes minimised windows impossible to restore (no
    // taskbar icon to click). The extra taskbar icon is the accepted price
    // for Alt-Tab working and the user being able to un-minimise.
    // The main window's 'close' handler explicitly destroys this window so
    // it never outlives the app.
    roundedCorners: true,
    thickFrame: true,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'assets', 'pdr-logo_transparent.png')
      : path.join(__dirname, '../client/public/assets/pdr-logo_transparent.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: 1.0,
    },
  });
  hardenWindowAgainstNavigation(win);

  const peoplePage = path.join(__dirname, '../dist/public/people.html');
  // Best-effort dark-mode query — for the warm path we won't have the
  // result before loadFile, so the renderer also reads the live value
  // from document on its own. The query string is just a hint.
  mainWindow?.webContents.executeJavaScript(
    'document.documentElement.classList.contains("dark")'
  ).then((dark: boolean) => {
    win.loadFile(peoplePage, { query: { dark: dark ? '1' : '0' } });
  }).catch(() => {
    win.loadFile(peoplePage, { query: { dark: '0' } });
  });

  win.on('closed', () => {
    if (peopleWindow === win) {
      peopleWindow = null;
      peopleWindowIsWarm = false;
    }
  });

  return win;
}

/**
 * Pre-warm the PM window in the background. Safe to call multiple times —
 * it's a no-op if a window already exists. Called a short delay after the
 * main window paints so initial app launch isn't slowed down.
 */
function prewarmPeopleWindow(): void {
  if (peopleWindow && !peopleWindow.isDestroyed()) return;
  try {
    peopleWindow = createPeopleWindow({ show: false });
    peopleWindowIsWarm = true;
    console.log('[PM] Pre-warmed People Manager window in the background');
  } catch (err) {
    console.warn('[PM] Pre-warm failed (will fall back to cold open):', (err as Error).message);
    peopleWindow = null;
    peopleWindowIsWarm = false;
  }
}

ipcMain.handle('people:open', async () => {
  try {
    // Warm path: window already exists. Show + focus instantly.
    if (peopleWindow && !peopleWindow.isDestroyed()) {
      if (!peopleWindow.isVisible()) peopleWindow.show();
      peopleWindow.focus();
      peopleWindowIsWarm = false; // it's been shown — no longer "warm" in the pre-load sense
      return { success: true };
    }

    // Cold path: pre-warm hadn't fired yet (user clicked very fast).
    // Build the window normally and show it.
    peopleWindow = createPeopleWindow({ show: true });
    peopleWindowIsWarm = false;
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Broadcast a "people data changed" tick to EVERY open renderer
// window — main, People Manager, Date Editor, etc. Originally this
// only targeted mainWindow because the trigger was always the PM
// window telling main "I just renamed a person, re-query S&D". But
// the reverse direction is now in play too: workspace.tsx fires
// notifyChange after a re-cluster, and PM (a separate window) needs
// to receive the same broadcast so it reloads its row counts. By
// fanning out to every BrowserWindow we keep PM, SearchPanel, and
// any future subscribers in sync regardless of who triggered the
// change. isDestroyed() guards a torn-down window from throwing.
ipcMain.handle('people:changed', async () => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try { win.webContents.send('people:dataChanged'); } catch { /* non-fatal */ }
  }
  return { success: true };
});

// ─── Date Editor window ───────────────────────────────────────────────────────

let dateEditorWindow: BrowserWindow | null = null;

ipcMain.handle('dateEditor:open', async (_event, seedQuery?: any) => {
  try {
    // URL-encode the seed query so the Date Editor renderer can restore
    // exactly the main window's current S&D filter. Capped at ~16 KiB to
    // defend against pathological filter strings.
    const seedParam = seedQuery
      ? (() => {
          try {
            const s = JSON.stringify(seedQuery);
            return s.length <= 16 * 1024 ? s : '';
          } catch { return ''; }
        })()
      : '';

    if (dateEditorWindow && !dateEditorWindow.isDestroyed()) {
      // Window already open — reload it with the new seed query so the user
      // sees the photos matching whatever they've just filtered to.
      const isDark = await mainWindow?.webContents.executeJavaScript(
        'document.documentElement.classList.contains("dark")'
      ).catch(() => false) ?? false;
      const dateEditorPage = path.join(__dirname, '../dist/public/date-editor.html');
      dateEditorWindow.loadFile(dateEditorPage, {
        query: { dark: isDark ? '1' : '0', ...(seedParam ? { seed: seedParam } : {}) },
      });
      dateEditorWindow.focus();
      return { success: true };
    }

    const isDark = await mainWindow?.webContents.executeJavaScript(
      'document.documentElement.classList.contains("dark")'
    ).catch(() => false) ?? false;

    dateEditorWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 560,
      backgroundColor: isDark ? '#1a1a2e' : '#f6f6fb',
      title: 'Date Editor — Photo Date Rescue',
      // See peopleWindow above: independent top-level window, no skipTaskbar
      // so Alt-Tab works and the user can restore a minimised window.
      // Custom-frame title bar matches the main PDR window so the
      // Fix-status chip can sit IN the title bar consistently across
      // every PDR window. titleBarOverlay renders the native OS
      // window controls in PDR's lavender theme.
      titleBarStyle: process.platform === 'win32' ? 'hidden' : 'hiddenInset',
      ...(process.platform === 'win32' ? {
        titleBarOverlay: {
          color: '#a99cff',
          symbolColor: '#ffffff',
          height: 32,
        },
      } : {}),
      roundedCorners: true,
      thickFrame: true,
      icon: app.isPackaged
        ? path.join(process.resourcesPath, 'assets', 'pdr-logo_transparent.png')
        : path.join(__dirname, '../client/public/assets/pdr-logo_transparent.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        zoomFactor: 1.0,
      },
    });
    hardenWindowAgainstNavigation(dateEditorWindow);

    const dateEditorPage = path.join(__dirname, '../dist/public/date-editor.html');
    dateEditorWindow.loadFile(dateEditorPage, {
      query: { dark: isDark ? '1' : '0', ...(seedParam ? { seed: seedParam } : {}) },
    });

    dateEditorWindow.on('closed', () => {
      dateEditorWindow = null;
      // Any corrections landed while the window was open — nudge the main
      // window so the grid / filters re-fetch.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dateEditor:dataChanged');
      }
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Open settings page in main window with a specific tab active
ipcMain.handle('app:openSettings', async (_event, tab?: string) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    mainWindow.webContents.send('app:openSettings', tab ?? 'general');
  }
  return { success: true };
});

// ═══ AI Recognition IPC Handlers ═══════════════════════════════════════════

ipcMain.handle('ai:start', async () => {
  try {
    startAiProcessing(); // non-blocking — fires and returns
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:modelsReady', async () => {
  return { success: true, data: areModelsDownloaded() };
});

ipcMain.handle('ai:cancel', async () => {
  cancelAiProcessing();
  return { success: true };
});

ipcMain.handle('ai:pause', async () => {
  pauseAiProcessing();
  return { success: true };
});

ipcMain.handle('ai:resume', async () => {
  resumeAiProcessing();
  return { success: true };
});

ipcMain.handle('ai:status', async () => {
  return { success: true, data: { isProcessing: isAiProcessing(), isPaused: isAiPaused() } };
});

ipcMain.handle('ai:replayLogs', async () => {
  const { replayWorkerLogs } = await import('./ai-manager.js');
  return { success: true, data: replayWorkerLogs() };
});

ipcMain.handle('ai:stats', async () => {
  try {
    const stats = getAiStats();
    return { success: true, data: stats };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:listPersons', async () => {
  try {
    return { success: true, data: listPersons() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:personsCooccurrence', async (_event, selectedPersonIds: number[]) => {
  try {
    return { success: true, data: getPersonsWithCooccurrence(selectedPersonIds) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:namePerson', async (_event, name: string, clusterId?: number, avatarData?: string, fullName?: string | null) => {
  try {
    // upsertPerson takes care of writing full_name when provided, or
    // populating it on an existing row that doesn't have one yet.
    // Older callers omit fullName entirely — that's still supported,
    // they just keep the legacy short-name-only behaviour.
    const personId = upsertPerson(name, avatarData, fullName);
    if (clusterId != null) {
      assignPersonToCluster(clusterId, personId);
      // Rebuild FTS for all files in the cluster
      const { getDb } = await import('./search-database.js');
      const database = getDb();
      const files = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE cluster_id = ?`).all(clusterId) as { file_id: number }[];
      for (const f of files) rebuildAiFts(f.file_id);
    }
    invalidatePersonClustersCache();
    return { success: true, data: { personId } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:assignFace', async (_event, faceId: number, personId: number, verified: boolean = false) => {
  try {
    assignPersonToFace(faceId, personId, verified);
    // Rebuild FTS for the affected file so search reflects the reassignment
    const { getDb } = await import('./search-database.js');
    const database = getDb();
    const face = database.prepare(`SELECT file_id FROM face_detections WHERE id = ?`).get(faceId) as { file_id: number } | undefined;
    if (face) rebuildAiFts(face.file_id);
    invalidatePersonClustersCache();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:batchVerify', async (_event, personIds: number[]) => {
  try {
    const { getDb } = await import('./search-database.js');
    const database = getDb();
    const stmt = database.prepare('UPDATE face_detections SET verified = 1 WHERE person_id = ? AND verified = 0');
    const fileStmt = database.prepare('SELECT DISTINCT file_id FROM face_detections WHERE person_id = ?');
    const affectedFiles = new Set<number>();
    for (const personId of personIds) {
      stmt.run(personId);
      const files = fileStmt.all(personId) as { file_id: number }[];
      for (const f of files) affectedFiles.add(f.file_id);
    }
    for (const fileId of affectedFiles) rebuildAiFts(fileId);
    invalidatePersonClustersCache();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:importXmpFaces', async () => {
  try {
    const { importXmpFacesForAllFiles } = await import('./xmp-face-import.js');
    const result = importXmpFacesForAllFiles();
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:refineFromVerified', async (_event, similarityThreshold?: number, personFilter?: number) => {
  try {
    const { refineFromVerifiedFaces, getDb } = await import('./search-database.js');
    // Caller may override (e.g. PM slider during a manual refine) but
    // when omitted we honour the user's S&D Match slider value so the
    // two surfaces stay in sync for the auto-refine path.
    const threshold = similarityThreshold ?? getSettings().aiSearchMatchThreshold ?? 0.72;
    // personFilter restricts refinement to a single named person — used
    // by per-row "Improve" buttons and the post-verify chip prompt.
    // v2.0.15 (Terry 2026-06-05) — refineFromVerifiedFaces is now async
    // with cooperative yields so main can answer IPC during the
    // tens-of-millions-of-multiplications inner loop. Await is needed.
    //
    // v2.0.15 (Terry 2026-06-06) — onProgress relays each progress
    // event to the PM window (which is where the Improve modal
    // lives). Channel name 'ai:refineProgress'; payload is the full
    // RefineProgress object from search-database.ts. The send loop
    // tries peopleWindow first (the PM is its own BrowserWindow) and
    // falls back to mainWindow so progress also lands somewhere
    // useful if Improve is ever fired from the main workspace.
    const result = await refineFromVerifiedFaces(threshold, personFilter, (progress) => {
      const target = (peopleWindow && !peopleWindow.isDestroyed()) ? peopleWindow : mainWindow;
      if (target && !target.isDestroyed()) {
        try { target.webContents.send('ai:refineProgress', progress); } catch { /* best-effort */ }
      }
    });
    // Rebuild FTS for all files whose faces were newly assigned
    const database = getDb();
    const personIds = result.perPerson.filter(p => p.matched > 0).map(p => p.personId);
    if (personIds.length > 0) {
      const placeholders = personIds.map(() => '?').join(',');
      const files = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE person_id IN (${placeholders})`).all(...personIds) as { file_id: number }[];
      // v2.0.15 (Terry 2026-06-05) — yield every 200 rebuilds so the
      // post-refine FTS pass doesn't also block main for the matched-
      // file count (potentially thousands of files for a heavy
      // Improve run). Same pattern as the inner refine loops.
      // v2.0.15 (Terry 2026-06-06) — also emit a 'finalising' progress
      // beat per chunk so the modal bar shows the FTS rebuild phase
      // isn't stalled (it's not negligible for large match runs).
      const target = (peopleWindow && !peopleWindow.isDestroyed()) ? peopleWindow : mainWindow;
      for (let i = 0; i < files.length; i++) {
        if (i > 0 && i % 200 === 0) {
          await new Promise<void>((r) => setImmediate(r));
          if (target && !target.isDestroyed()) {
            try { target.webContents.send('ai:refineProgress', { phase: 'finalising', personIndex: 0, personsTotal: 0, personName: '', itemIndex: i, itemsTotal: files.length, matchedSoFar: result.newMatches }); } catch {}
          }
        }
        rebuildAiFts(files[i].file_id);
      }
    }
    // Was missing — every other mutation IPC invalidates the cache.
    // Without this, the Improve flow's loadClusters() comes back with
    // stale data that excludes the just-matched faces, and the user
    // has to hit Refresh manually before they see the new auto-
    // matches under their named person. This is the cause of the
    // "Owen + 5 only after refresh" report.
    invalidatePersonClustersCache();
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:unnameFace', async (_event, faceId: number) => {
  try {
    unnameFace(faceId);
    invalidatePersonClustersCache();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:renamePerson', async (_event, personId: number, newName: string, newFullName?: string | null) => {
  try {
    // newFullName: undefined = leave existing full_name alone (legacy
    // callers); null or '' = clear it; non-empty string = write it.
    renamePerson(personId, newName, newFullName);
    // Rebuild FTS for all affected files
    const { getDb } = await import('./search-database.js');
    const database = getDb();
    const files = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE person_id = ?`).all(personId) as { file_id: number }[];
    for (const f of files) rebuildAiFts(f.file_id);
    invalidatePersonClustersCache();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:setRepresentativeFace', async (_event, personId: number, faceId: number) => {
  try {
    const { setPersonRepresentativeFace } = await import('./search-database.js');
    setPersonRepresentativeFace(personId, faceId);
    invalidatePersonClustersCache();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:mergePersons', async (_event, targetPersonId: number, sourcePersonId: number) => {
  try {
    const facesReassigned = mergePersons(targetPersonId, sourcePersonId);
    // Rebuild FTS for all affected files
    const { getDb } = await import('./search-database.js');
    const database = getDb();
    const files = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE person_id = ?`).all(targetPersonId) as { file_id: number }[];
    for (const f of files) rebuildAiFts(f.file_id);
    invalidatePersonClustersCache();
    return { success: true, data: { facesReassigned } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:deletePerson', async (_event, personId: number) => {
  try {
    // Get the person info first for the response
    const person = getPersonById(personId);
    if (!person) return { success: false, error: 'Person not found' };
    // Get affected file IDs before deletion (for FTS rebuild)
    const { getDb } = await import('./search-database.js');
    const database = getDb();
    const affectedFiles = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE person_id = ?`).all(personId) as { file_id: number }[];
    // Delete the person
    const result = deletePerson(personId);
    // Rebuild FTS for affected files
    for (const f of affectedFiles) rebuildAiFts(f.file_id);
    invalidatePersonClustersCache();
    return { success: true, data: { ...result, personName: person.name } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:getPersonInfo', async (_event, personId: number) => {
  try {
    const person = getPersonById(personId);
    return { success: true, data: person };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:permanentlyDeletePerson', async (_event, personId: number) => {
  try {
    // Check if this is a special marker person (__ignored__ / __unsure__)
    const person = getPersonById(personId);
    if (person && (person.name === '__ignored__' || person.name === '__unsure__')) {
      // Delete the face detection records entirely and clean up
      const { deleteFacesByPerson } = await import('./search-database.js');
      deleteFacesByPerson(personId);
      return { success: true };
    }
    // Normal flow: only delete discarded persons
    const success = permanentlyDeletePerson(personId);
    return { success };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:unnamePersonAndDelete', async (_event, personId: number) => {
  try {
    const person = getPersonById(personId);
    if (!person) return { success: false, error: 'Person not found' };
    const { getDb } = await import('./search-database.js');
    const database = getDb();
    // Capture affected file IDs BEFORE the unname so FTS can be
    // rebuilt for them — once person_id flips to NULL the join is
    // gone and we can't enumerate the affected photos any more.
    const affectedFiles = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE person_id = ?`).all(personId) as { file_id: number }[];
    const result = unnamePersonAndDelete(personId);
    for (const f of affectedFiles) rebuildAiFts(f.file_id);
    invalidatePersonClustersCache();
    return { success: true, data: { ...result, personName: person.name } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:restoreUnnamedPerson', async (_event, token: any) => {
  try {
    const result = restoreUnnamedPerson(token);
    // Same FTS rebuild dance — every restored face needs its file's
    // search index rebuilt so the name reappears in S&D results.
    const { getDb } = await import('./search-database.js');
    const database = getDb();
    const fileIds = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE person_id = ?`).all(result.personId) as { file_id: number }[];
    for (const f of fileIds) rebuildAiFts(f.file_id);
    invalidatePersonClustersCache();
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:restorePerson', async (_event, personId: number) => {
  try {
    const success = restorePerson(personId);
    // Was missing — every other mutation IPC invalidates the cache.
    // Without this, the Undo toast's loadClusters() call hits a stale
    // cached result that still excludes the restored person, and the
    // user has to manually press Refresh to see the row come back.
    invalidatePersonClustersCache();
    return { success };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:listDiscardedPersons', async () => {
  try {
    return { success: true, data: listDiscardedPersons() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:visualSuggestions', async (_event, faceId: number) => {
  try {
    return { success: true, data: getVisualSuggestions(faceId) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:clusterFaceCount', async (_event, clusterId: number, personId?: number) => {
  try {
    return { success: true, data: getClusterFaceCount(clusterId, personId) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:getFaces', async (_event, fileId: number) => {
  try {
    return { success: true, data: getFacesForFile(fileId) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Re-run face detection on a single file. Wired to the per-photo
// "Re-detect faces" button on the S&D Details panel — useful when
// Human.js missed a face on the first analysis pass.
ipcMain.handle('ai:redetectFile', async (_event, fileId: number) => {
  try {
    const result = await redetectSingleFile(fileId);
    // Invalidate the person clusters cache so PM picks up any newly
    // auto-matched faces without a manual refresh.
    if (result.ok && result.newFaces > 0) {
      invalidatePersonClustersCache();
    }
    return result;
  } catch (err) {
    return { ok: false, newFaces: 0, error: (err as Error).message };
  }
});

ipcMain.handle('ai:getTags', async (_event, fileId: number) => {
  try {
    return { success: true, data: getAiTagsForFile(fileId) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:tagOptions', async () => {
  try {
    return { success: true, data: getAiTagOptions() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:clearAll', async () => {
  try {
    clearAllAiData();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:resetTagAnalysis', async () => {
  try {
    const data = resetAllTagAnalysis();
    // Kick off tags-only processing right away so the header progress
    // indicator starts ticking. Non-blocking — the main thread returns
    // immediately and the worker chews through files in the background.
    startAiProcessing({ tagsOnly: true });
    return { success: true, data };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Re-analyze faces was intentionally removed — see
// memory/feedback_face_reanalyze_design.md. End users have hours of
// emotional investment in their People Manager verifications and we
// don't ship a button that can wipe that. Recovery for mass mis-naming
// goes through Restore from backup. Future model upgrades are tested
// by the dev locally and shipped as an updated build.

ipcMain.handle('db:listBackups', async () => {
  try {
    const { listDbBackups } = await import('./search-database.js');
    return { success: true, data: listDbBackups() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('db:restoreFromBackup', async (_event, snapshotPath: string) => {
  try {
    const { restoreDbFromBackup } = await import('./search-database.js');
    const r = restoreDbFromBackup(snapshotPath);
    invalidatePersonClustersCache();
    return r.restored ? { success: true } : { success: false, error: r.error };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('db:takeSnapshot', async (_event, kind: 'manual' | 'auto-event', label?: string) => {
  try {
    const { takeSnapshot } = await import('./search-database.js');
    return takeSnapshot(kind, label);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('db:deleteSnapshot', async (_event, snapshotPath: string) => {
  try {
    const { deleteSnapshot } = await import('./search-database.js');
    return deleteSnapshot(snapshotPath);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('db:exportSnapshotZip', async (_event, snapshotPath: string) => {
  // Save a snapshot file as a portable .db copy at a user-chosen
  // location (we don't actually zip a single file — adds ~zero space
  // benefit for SQLite. Naming kept as "exportSnapshotZip" for the
  // bridge stability; copies as .db).
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    if (!fs.existsSync(snapshotPath)) return { success: false, error: 'Snapshot not found' };
    const { dialog } = await import('electron');
    const baseName = path.basename(snapshotPath);
    const result = await dialog.showSaveDialog({
      title: 'Export PDR snapshot',
      defaultPath: baseName,
      filters: [{ name: 'PDR snapshot', extensions: ['db'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, error: 'Cancelled' };
    fs.copyFileSync(snapshotPath, result.filePath);
    return { success: true, path: result.filePath };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// PM open-count: session-scoped counter that resets each PDR launch.
// Used alongside settings.pmOpenDays to decide when to show the "open
// PM on startup" onboarding banner — we wait until adoption is real
// (3+ distinct calendar days OR 3+ opens in one session) before
// asking the user to change their startup preference.
let pmOpenSessionCount = 0;
ipcMain.handle('pm:recordOpen', async () => {
  pmOpenSessionCount += 1;
  const today = new Date().toISOString().slice(0, 10);
  const settings = getSettings();
  const existingDays = Array.isArray(settings.pmOpenDays) ? settings.pmOpenDays : [];
  const daysSet = new Set(existingDays);
  if (!daysSet.has(today)) {
    daysSet.add(today);
    setSetting('pmOpenDays', Array.from(daysSet));
  }
  return {
    success: true,
    sessionCount: pmOpenSessionCount,
    distinctDays: daysSet.size,
    dismissed: !!settings.pmStartupPromptDismissed,
    alreadyEnabled: !!settings.openPeopleOnStartup,
  };
});
ipcMain.handle('pm:dismissStartupPrompt', async () => {
  setSetting('pmStartupPromptDismissed', true);
  return { success: true };
});

// Main-process cache for getPersonClusters results. Pre-warming from
// the main PDR window (see ai:prewarmPersonClusters) fills this while
// PM is closed; when the user opens PM the cluster list comes back
// instantly from memory instead of waiting for the full query chain
// every time. Cache lives for the lifetime of the main process and is
// invalidated explicitly by any IPC handler that mutates cluster
// state (namePerson, assignFace, discardPerson, etc.).
let cachedPersonClusters: ReturnType<typeof getPersonClusters> | null = null;
let cachedPersonClustersAt = 0;
const PERSON_CLUSTERS_TTL_MS = 30_000;
function invalidatePersonClustersCache() {
  cachedPersonClusters = null;
  cachedPersonClustersAt = 0;
}
function computePersonClustersFresh() {
  cleanupOrphanedPersons();
  const data = getPersonClusters();
  cachedPersonClusters = data;
  cachedPersonClustersAt = Date.now();
  return data;
}

ipcMain.handle('ai:personClusters', async () => {
  try {
    // Use cached value if fresh. The cache is invalidated by every
    // mutation handler below, so a fresh value here is safe even when
    // the DB has changed since last fetch.
    const age = Date.now() - cachedPersonClustersAt;
    if (cachedPersonClusters && age < PERSON_CLUSTERS_TTL_MS) {
      return { success: true, data: cachedPersonClusters };
    }
    return { success: true, data: computePersonClustersFresh() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Pre-warm handler — called from the main PDR window when it's idle,
// so PM opens with a hot cache. Same code path as ai:personClusters
// but always forces a fresh fetch to keep the cache from going
// stale due to mutations we might have missed.
ipcMain.handle('ai:prewarmPersonClusters', async () => {
  try {
    computePersonClustersFresh();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:clusterFaces', async (_event, clusterId: number, page: number = 0, perPage: number = 40, personId?: number, sortMode?: 'chronological' | 'confidence-asc') => {
  try {
    return { success: true, data: getClusterFaces(clusterId, page, perPage, personId, sortMode) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

/**
 * Cluster only NEW faces (cluster_id IS NULL) against existing
 * clusters. Preserves People Manager person→cluster assignments —
 * unlike ai:recluster which rebuilds from scratch. Runs in the AI
 * worker_thread so main stays responsive.
 */
ipcMain.handle('ai:clusterNewFaces', async (_event, threshold?: number) => {
  try {
    await runIncrementalClustering(threshold);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:recluster', async (_event, threshold: number) => {
  try {
    await runFaceClustering(threshold);
    const { getDb } = await import('./search-database.js');
    const database = getDb();

    // ── STEP 1: Find core cluster for each named person ──
    // For each person_id, find which new cluster_id holds the most of their
    // named faces (including verified). That cluster is the "core".
    const allNamedFaces = database.prepare(`
      SELECT id, cluster_id, person_id, verified FROM face_detections WHERE person_id IS NOT NULL
    `).all() as { id: number; cluster_id: number; person_id: number; verified: number }[];

    // Group by person_id → cluster_id → face IDs
    const personClusters = new Map<number, Map<number, number[]>>();
    for (const f of allNamedFaces) {
      if (!personClusters.has(f.person_id)) personClusters.set(f.person_id, new Map());
      const clusterMap = personClusters.get(f.person_id)!;
      if (!clusterMap.has(f.cluster_id)) clusterMap.set(f.cluster_id, []);
      clusterMap.get(f.cluster_id)!.push(f.id);
    }

    // Determine core cluster for each person (the one with the most faces)
    const personCoreCluster = new Map<number, number>(); // person_id → core cluster_id
    const resetStmt = database.prepare('UPDATE face_detections SET person_id = NULL, verified = 0 WHERE id = ?');
    for (const [personId, clusterMap] of personClusters) {
      let maxCount = 0;
      let coreClusterId = 0;
      for (const [clusterId, faceIds] of clusterMap) {
        if (faceIds.length > maxCount) { maxCount = faceIds.length; coreClusterId = clusterId; }
      }
      personCoreCluster.set(personId, coreClusterId);

      // Split: reset person_id on unverified faces NOT in the core cluster
      for (const [clusterId, faceIds] of clusterMap) {
        if (clusterId !== coreClusterId) {
          for (const faceId of faceIds) {
            // Only unname unverified faces — verified stay locked
            const face = allNamedFaces.find(f => f.id === faceId);
            if (face && !face.verified) {
              resetStmt.run(faceId);
            }
          }
        }
      }
    }

    // ── STEP 2: Re-merge — assign unnamed faces in a core cluster back to the person ──
    // When going from strict to loose, faces that were previously split off may now be
    // back in the same cluster as a named person. Re-assign them.
    const assignStmt = database.prepare('UPDATE face_detections SET person_id = ? WHERE id = ? AND person_id IS NULL');
    for (const [personId, coreClusterId] of personCoreCluster) {
      // Find all unnamed, unverified faces in this person's core cluster
      const unnamedInCore = database.prepare(`
        SELECT id FROM face_detections WHERE cluster_id = ? AND person_id IS NULL
      `).all(coreClusterId) as { id: number }[];
      for (const { id } of unnamedInCore) {
        assignStmt.run(personId, id);
      }
    }

    // Recompute match_similarity for any auto-matched face that no
    // longer has a stored score (re-cluster's re-merge step assigns
    // person_id without setting match_similarity). Without this, the
    // PM/S&D similarity sliders have nothing to filter on for newly-
    // re-merged faces — they'd silently bypass the gate via the
    // `match_similarity IS NULL` branch.
    try {
      const { backfillMatchSimilarity } = await import('./search-database.js');
      backfillMatchSimilarity(database);
    } catch (bfErr) {
      console.warn('[recluster] match_similarity refresh failed (non-fatal):', bfErr);
    }

    const faceFileIds = database.prepare('SELECT DISTINCT file_id FROM face_detections').all() as { file_id: number }[];
    for (const { file_id } of faceFileIds) rebuildAiFts(file_id);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

/**
 * Batch face-crop fetch. Decodes each unique source file ONCE with
 * sharp and extracts every requested face crop from that single
 * decode, then returns a face_id → dataUrl map. The single-shot
 * ai:faceCrop handler decoded the source file per face — for the
 * FaceGridModal that meant 50 sharp.metadata() + sharp.extract()
 * passes for a person whose faces are all in just 47 photos. This
 * version cuts that to 47 decodes (often much fewer when faces share
 * a photo) and runs the per-file work concurrently.
 */
/**
 * Single-shot avatar fetch for a person. Resolves the
 * representative_face_id (or falls back to the highest-confidence
 * face for the person), then returns a square face-crop dataUrl. Used
 * by Trees prompt modals to render avatars without a separate graph
 * fetch — covers the case where the target person isn't in the
 * currently-rendered graph yet (e.g. a child being added before the
 * parent_of write has happened).
 */
ipcMain.handle('ai:getPersonFaceCrop', async (_event, personId: number, size: number = 96) => {
  try {
    const { getDb } = await import('./search-database.js');
    const db = getDb();
    // Prefer the user-chosen representative face; fall back to the
    // highest-confidence detection for the person if none set / the
    // chosen face has been deleted.
    const row = db.prepare(`
      SELECT f.file_path, fd.box_x, fd.box_y, fd.box_w, fd.box_h
      FROM face_detections fd
      JOIN indexed_files f ON f.id = fd.file_id
      WHERE fd.id = (
        SELECT COALESCE(
          p.representative_face_id,
          (SELECT id FROM face_detections WHERE person_id = p.id ORDER BY confidence DESC LIMIT 1)
        )
        FROM persons p
        WHERE p.id = ?
      )
    `).get(personId) as { file_path: string; box_x: number; box_y: number; box_w: number; box_h: number } | undefined;
    if (!row) return { success: false };
    const sharp = (await import('sharp')).default;
    const metadata = await sharp(row.file_path, { failOnError: false }).rotate().metadata();
    if (!metadata.width || !metadata.height) return { success: false };
    const imgW = metadata.width;
    const imgH = metadata.height;
    let px = Math.round(row.box_x * imgW);
    let py = Math.round(row.box_y * imgH);
    let pw = Math.round(row.box_w * imgW);
    let ph = Math.round(row.box_h * imgH);
    const padding = Math.round(Math.max(pw, ph) * 0.25);
    const sideLen = Math.max(pw, ph) + padding * 2;
    const cx = px + pw / 2;
    const cy = py + ph / 2;
    px = Math.round(cx - sideLen / 2);
    py = Math.round(cy - sideLen / 2);
    pw = sideLen;
    ph = sideLen;
    px = Math.max(0, px);
    py = Math.max(0, py);
    pw = Math.min(pw, imgW - px);
    ph = Math.min(ph, imgH - py);
    if (pw <= 0 || ph <= 0) return { success: false };
    const buffer = await sharp(row.file_path, { failOnError: false })
      .rotate()
      .extract({ left: px, top: py, width: pw, height: ph })
      .resize(size, size, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { success: true, dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}` };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:faceCropBatch', async (
  _event,
  requests: { face_id: number; file_path: string; box_x: number; box_y: number; box_w: number; box_h: number }[],
  size: number = 96,
) => {
  try {
    const result: Record<number, string> = {};
    // Cache-first pass — read every request from the on-disk JPG cache.
    // Anything that hits avoids the sharp pipeline AND survives even if
    // the original photo has been deleted by the user. Long-path wrap
    // for cache reads — see long-path.ts.
    const stillNeeded: typeof requests = [];
    await Promise.all(requests.map(async (r) => {
      const cachePath = path.join(faceCropCacheDir, faceCropCacheKey(r.file_path, r.box_x, r.box_y, r.box_w, r.box_h, size));
      const cachePathLong = toLongPath(cachePath);
      try {
        if (fs.existsSync(cachePathLong)) {
          const buf = await fs.promises.readFile(cachePathLong);
          result[r.face_id] = `data:image/jpeg;base64,${buf.toString('base64')}`;
          return;
        }
      } catch { /* fall through to fresh render */ }
      stillNeeded.push(r);
    }));

    if (stillNeeded.length === 0) return { success: true, crops: result };

    const sharp = (await import('sharp')).default;
    const byFile = new Map<string, typeof stillNeeded>();
    for (const r of stillNeeded) {
      if (!byFile.has(r.file_path)) byFile.set(r.file_path, []);
      byFile.get(r.file_path)!.push(r);
    }
    // Cap concurrency so we don't queue 50+ sharp pipelines at once
    // on a slow disk (network drive especially). 4 in flight is a
    // reasonable balance — sharp itself uses libvips threading
    // internally for each pipeline.
    const fileEntries = Array.from(byFile.entries());
    const CONCURRENCY = 4;
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const next = async (): Promise<void> => {
      while (cursor < fileEntries.length) {
        const i = cursor++;
        const [filePath, faces] = fileEntries[i];
        // Long-path wrap for sharp source-read. See long-path.ts.
        const filePathLong = toLongPath(filePath);
        try {
          const metadata = await sharp(filePathLong, { failOnError: false }).rotate().metadata();
          if (!metadata.width || !metadata.height) continue;
          const imgW = metadata.width;
          const imgH = metadata.height;
          for (const f of faces) {
            try {
              let px = Math.round(f.box_x * imgW);
              let py = Math.round(f.box_y * imgH);
              let pw = Math.round(f.box_w * imgW);
              let ph = Math.round(f.box_h * imgH);
              const padding = Math.round(Math.max(pw, ph) * 0.25);
              const sideLen = Math.max(pw, ph) + padding * 2;
              const cx = px + pw / 2;
              const cy = py + ph / 2;
              px = Math.round(cx - sideLen / 2);
              py = Math.round(cy - sideLen / 2);
              pw = sideLen;
              ph = sideLen;
              px = Math.max(0, px);
              py = Math.max(0, py);
              pw = Math.min(pw, imgW - px);
              ph = Math.min(ph, imgH - py);
              if (pw <= 0 || ph <= 0) continue;
              const buffer = await sharp(filePathLong, { failOnError: false })
                .rotate()
                .extract({ left: px, top: py, width: pw, height: ph })
                .resize(size, size, { fit: 'cover' })
                .jpeg({ quality: 85 })
                .toBuffer();
              result[f.face_id] = `data:image/jpeg;base64,${buffer.toString('base64')}`;
              // Persist to the on-disk cache so future requests for
              // this exact crop bypass sharp altogether — and survive
              // deletion of the original. Best-effort write.
              const cachePath = path.join(faceCropCacheDir, faceCropCacheKey(filePath, f.box_x, f.box_y, f.box_w, f.box_h, size));
              fs.promises.writeFile(toLongPath(cachePath), buffer).catch(err =>
                console.warn('[face-crop] cache write failed:', (err as Error).message)
              );
            } catch { /* per-face failure is non-fatal */ }
          }
        } catch { /* per-file failure is non-fatal */ }
      }
    };
    for (let i = 0; i < CONCURRENCY; i++) workers.push(next());
    await Promise.all(workers);
    return { success: true, crops: result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

/**
 * Compute the cache filename for a face crop. Content-addressed by the
 * tuple that uniquely identifies a crop — same face from the same photo
 * always lands at the same cache key, regardless of which person it's
 * currently assigned to or how many times PM has asked for it.
 */
function faceCropCacheKey(filePath: string, boxX: number, boxY: number, boxW: number, boxH: number, size: number): string {
  const h = crypto.createHash('sha1');
  h.update(filePath); h.update('|');
  // Quantise floats so tiny coord differences from re-detection don't
  // miss the cache; 5 decimal places is ~sub-pixel on a 4K image.
  h.update(boxX.toFixed(5)); h.update('|');
  h.update(boxY.toFixed(5)); h.update('|');
  h.update(boxW.toFixed(5)); h.update('|');
  h.update(boxH.toFixed(5)); h.update('|');
  h.update(String(size));
  return h.digest('hex') + '.jpg';
}

ipcMain.handle('ai:faceCrop', async (_event, filePath: string, boxX: number, boxY: number, boxW: number, boxH: number, size: number = 96) => {
  // Content-addressed cache: if we've already rendered this exact crop
  // before, serve the JPG from disk and skip the (expensive) re-decode +
  // sharp.extract pipeline. Also covers the "user deleted the original
  // photo" case — once a face is in the cache, PM keeps showing the
  // thumbnail forever, so the user's manual naming/verification work
  // doesn't visually disappear when they tidy their library.
  const cachePath = path.join(faceCropCacheDir, faceCropCacheKey(filePath, boxX, boxY, boxW, boxH, size));
  // Long-path wrappers for BOTH the cache path (defensive) and the
  // source path (deep library trees on Windows routinely push photo
  // paths past 260 chars; sharp passes through to Win32 file APIs that
  // honour the `\\?\` prefix). See long-path.ts.
  const cachePathLong = toLongPath(cachePath);
  const filePathLong = toLongPath(filePath);
  try {
    if (fs.existsSync(cachePathLong)) {
      const buffer = await fs.promises.readFile(cachePathLong);
      return { success: true, dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}` };
    }
  } catch { /* fall through to fresh render */ }

  // Cache miss → render from the original file.
  try {
    const sharp = (await import('sharp')).default;
    // .rotate() applies EXIF auto-rotation. Must be present here AND when
    // extracting so width/height match the rotated pixel buffer that the
    // detector saw — otherwise normalised box coords (which were computed
    // in rotated space by ai-worker.ts) extract from the wrong region.
    const metadata = await sharp(filePathLong, { failOnError: false }).rotate().metadata();
    if (!metadata.width || !metadata.height) return { success: false, error: 'Could not read image' };

    const imgW = metadata.width;
    const imgH = metadata.height;

    // Convert normalised coords to pixels
    let px = Math.round(boxX * imgW);
    let py = Math.round(boxY * imgH);
    let pw = Math.round(boxW * imgW);
    let ph = Math.round(boxH * imgH);

    // Expand crop area slightly and make it square for nicer thumbnails
    const padding = Math.round(Math.max(pw, ph) * 0.25);
    const sideLen = Math.max(pw, ph) + padding * 2;
    const cx = px + pw / 2;
    const cy = py + ph / 2;
    px = Math.round(cx - sideLen / 2);
    py = Math.round(cy - sideLen / 2);
    pw = sideLen;
    ph = sideLen;

    // Clamp to image bounds
    px = Math.max(0, px);
    py = Math.max(0, py);
    pw = Math.min(pw, imgW - px);
    ph = Math.min(ph, imgH - py);

    if (pw <= 0 || ph <= 0) return { success: false, error: 'Invalid crop area' };

    const buffer = await sharp(filePathLong, { failOnError: false })
      .rotate()
      .extract({ left: px, top: py, width: pw, height: ph })
      .resize(size, size, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Persist to the cache for next time. Best-effort — if the write
    // fails (disk full, permission denied) we still return the freshly
    // rendered crop so the current request succeeds.
    fs.promises.writeFile(cachePathLong, buffer).catch(err =>
      console.warn('[face-crop] cache write failed:', (err as Error).message)
    );

    const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
    return { success: true, dataUrl };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

/**
 * Fetch the small slice of indexed_files metadata that the People
 * Manager hover preview wants to overlay on the enlarged photo:
 * filename, derived date, geo country, geo city. Keyed by file_path
 * because the PM already passes file_path around with each face;
 * adding a file_id to the face wire format would be a wider change.
 */
ipcMain.handle('search:getFileMetaByPath', async (_event, filePath: string) => {
  try {
    const { getDb } = await import('./search-database.js');
    const db = getDb();
    const row = db.prepare(`
      SELECT filename, derived_date, geo_country, geo_city
      FROM indexed_files
      WHERE file_path = ?
      LIMIT 1
    `).get(filePath) as { filename: string; derived_date: string | null; geo_country: string | null; geo_city: string | null } | undefined;
    if (!row) return { success: false, error: 'File not in index' };
    return { success: true, data: row };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─── Viewer rotation persistence ────────────────────────────────────────────
// Stored in indexed_files.user_rotation as 0/90/180/270. The PDR Viewer
// reads it on load and applies a CSS transform on top of EXIF auto-rotation,
// then writes back here whenever the user clicks the rotate buttons. This
// keeps "I rotated this photo so it's the right way up" sticky across
// sessions without ever touching the original file on disk.
ipcMain.handle('viewer:getRotation', async (_event, filePath: string) => {
  try {
    const { getUserRotation } = await import('./search-database.js');
    return { success: true, rotation: getUserRotation(filePath) };
  } catch (err) {
    return { success: false, error: (err as Error).message, rotation: 0 };
  }
});

// v2.0.15 (Terry 2026-05-28) — native OS drag from PDR tiles to
// external apps (WhatsApp, Discord, mail, Photoshop). The renderer
// preventDefaults the browser's HTML5 drag and asks main to start
// the OS-level drag via webContents.startDrag. Receivers see the
// ORIGINAL file from disk, identical drag payload to File Explorer.
//
// Item shape: pass BOTH `file` (the primary, required by Electron's
// runtime even when files is set) AND `files` (the multi-file array).
// Earlier attempts that passed just `files` caused startDrag to no-op
// silently — the native side couldn't construct the drag payload
// without the primary path.
ipcMain.handle('drag:start', (event, args: { files: string[]; iconDataUrl?: string }) => {
  try {
    if (!args?.files || args.files.length === 0) return { success: false, error: 'No files supplied' };
    let icon = nativeImage.createEmpty();
    if (args.iconDataUrl) {
      try {
        const fromUrl = nativeImage.createFromDataURL(args.iconDataUrl);
        if (!fromUrl.isEmpty()) icon = fromUrl;
      } catch { /* fall back to empty icon */ }
    }
    event.sender.startDrag({ file: args.files[0], files: args.files, icon });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('viewer:setRotation', async (_event, filePath: string, rotation: number) => {
  try {
    const { setUserRotation } = await import('./search-database.js');
    const result = setUserRotation(filePath, rotation);
    // v2.0.14 (Terry 2026-05-28) — broadcast to every renderer so any
    // mounted thumbnail surface (Memories grid, Albums tiles, viewer
    // filmstrip) can drop its stale cache entry and refetch. Without
    // this the user rotates a photo in the viewer, returns to the
    // grid, and stares at the pre-rotation thumb until they navigate
    // away + back. The disk thumb-cache key already includes
    // user_rotation so the refetch hits a fresh entry.
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        try { w.webContents.send('pdr:rotationChanged', { filePath, rotation }); } catch { /* per-window failures non-fatal */ }
      }
    }
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// v2.0.15 (Terry 2026-06-06) — viewer:saveEnhanced
// Bakes the CSS-filter-equivalent adjustments from the PDR Viewer
// Enhance panel into a real JPG using sharp, optionally writes it
// as a new "_E" sibling OR replaces the original, and records the
// enhancement in XMP metadata so S&D / PDR's indexer can surface it
// regardless of filename. See project_ai_enhancement_plan.md for the
// full design context.
//
// Filter-to-sharp mapping:
//   brightness 0..200 → modulate({ brightness: v/100 })
//   contrast   0..200 → linear(slope=v/100, offset=128*(1 - v/100))
//   saturation 0..200 → modulate({ saturation: v/100 })  (ignored when bw)
//   bw         true   → greyscale()
//   temperature -50..+50 → tint() with warm/cool shift
//
// XMP metadata written via exiftool:
//   XMP-xmp:Label         = "PDR-Enhanced-manual" (or "ai" / "manual+ai" later)
//   XMP-xmp:MetadataDate  = ISO timestamp of the save
//   Software is NOT overwritten — original camera/app info preserved.
//
// New-file path: <original>_E.jpg next to the original, auto-suffixed
// with _2/_3/... if there's a collision. After write, the new file is
// queued for indexing so it appears in S&D / Memories / Trees immediately.
//
// Replace path: writes back to the original filename via the same atomic
// temp+rename pattern. Filename does NOT change.
interface SaveEnhancedRequest {
  filePath: string;
  mode: 'new' | 'replace';
  filterState: {
    brightness: number;   // 0..200, default 100
    contrast: number;     // 0..200, default 100
    saturation: number;   // 0..200, default 100
    temperature: number;  // -50..+50, default 0
    bw: boolean;          // default false
  };
  // v2.0.15 Phase 5+ — When set, the sharp pipeline reads from this
  // path instead of req.filePath. Used by the AI Enhance flows
  // (CodeFormer / Real-ESRGAN) so save bakes the manual sliders on
  // top of the AI output (a temp JPEG), not the original. The output
  // path / _E filename / index inheritance still derive from
  // req.filePath (the user's original library file).
  sourceOverride?: string;
  // 'manual' for slider-only saves; AI flows pass 'codeformer' /
  // 'realesrgan' / 'manual+ai' depending on what produced the
  // enhancement. The S&D "Enhanced only" chip filter and Phase 5+
  // manual/AI split popover read this column.
  enhancementType?: 'manual' | 'codeformer' | 'realesrgan' | 'manual+ai' | 'ai';
  enhancementMethod?: string; // free-form, e.g. 'manual', 'codeformer-w0.5', 'realesrgan-x4'
}

// v2.1 (Terry 2026-06-07) — viewer:trimVideo. Trims a video to a
// user-selected in/out range and writes the result as a sibling
// file with a `_T` suffix. Uses ffmpeg `-c copy` for a fast remux
// (no re-encode) — finishes in ~1-2s even for long videos. Note:
// `-c copy` only cuts on keyframes; small edge-of-frame slop is
// possible at the in-point but usually unnoticeable. For pixel-
// perfect cuts we'd need re-encode; not bothering for v1.
//
// Output naming: `<basename>_T<ext>` next to the original; `_T_2`,
// `_T_3`, … on collisions so prior clips aren't overwritten.
//
// After the file lands on disk, indexTrimmedClip stamps it in the
// search DB (inheriting date/EXIF/GPS from the source, setting
// clip_of_file_id so the parent link is queryable). library:filesAdded
// then fires so S&D / Memories pick up the new clip live.

interface TrimVideoRequest {
  filePath: string;
  /** Start time in seconds (inclusive). */
  startSec: number;
  /** End time in seconds (exclusive). */
  endSec: number;
}

ipcMain.handle('viewer:trimVideo', async (_event, req: TrimVideoRequest) => {
  try {
    if (!req?.filePath || !fs.existsSync(req.filePath)) {
      return { success: false, error: 'Source file not found.' };
    }
    if (typeof req.startSec !== 'number' || typeof req.endSec !== 'number' || req.endSec <= req.startSec) {
      return { success: false, error: 'Invalid trim range.' };
    }
    if (!ffmpegPath) {
      return { success: false, error: 'ffmpeg not available — cannot trim.' };
    }

    // Compute output path: <basename>_T<ext>, collision-bumped.
    const dir = path.dirname(req.filePath);
    const ext = path.extname(req.filePath);
    const baseNoExt = path.basename(req.filePath, ext);
    let outPath = path.join(dir, `${baseNoExt}_T${ext}`);
    let n = 2;
    while (fs.existsSync(toLongPath(outPath))) {
      outPath = path.join(dir, `${baseNoExt}_T_${n}${ext}`);
      n++;
      if (n > 999) return { success: false, error: 'Too many existing trimmed clips.' };
    }

    const ffmpegSrc = fromLongPath(req.filePath);
    const partPath = outPath + '.part';
    try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch {}

    // v2.1 (Terry 2026-06-07) — explicit -f format flag is REQUIRED
    // because the .part suffix prevents ffmpeg from inferring the
    // container from the output extension. Map common extensions to
    // ffmpeg format names; fall back to mp4 for anything unknown
    // (works for the vast majority of phone-camera footage).
    const sourceExtForFmt = path.extname(req.filePath).toLowerCase();
    const ffmpegFmtMap: Record<string, string> = {
      '.mp4': 'mp4', '.m4v': 'mp4',
      '.mov': 'mov',
      '.mkv': 'matroska',
      '.webm': 'webm',
      '.avi': 'avi',
      '.wmv': 'asf',
      '.flv': 'flv',
      '.3gp': '3gp', '.3g2': '3g2',
      '.mpg': 'mpeg', '.mpeg': 'mpeg',
    };
    const fmtFlag = ffmpegFmtMap[sourceExtForFmt] || 'mp4';

    // ffmpeg args: -ss BEFORE -i for fast input seeking on `-c copy`,
    // -to for end (absolute time, not duration), -c copy for fast
    // remux, -avoid_negative_ts make_zero to prevent timestamp
    // issues at the cut point, -f to force the container format
    // since the .part output extension hides the real type from
    // ffmpeg's inference.
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(req.startSec),
      '-to', String(req.endSec),
      '-i', ffmpegSrc,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-f', fmtFlag,
      '-y', partPath,
    ];

    const runFfmpeg = (): Promise<{ ok: boolean; err?: string }> => new Promise((resolve) => {
      const proc = spawn(ffmpegPath!, args, { windowsHide: true });
      let stderr = '';
      proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('error', (e) => resolve({ ok: false, err: e.message }));
      proc.on('close', (code) => resolve({ ok: code === 0, err: code === 0 ? undefined : (stderr || ('ffmpeg exit ' + code)) }));
    });

    const r = await runFfmpeg();
    if (!r.ok) {
      try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch {}
      return { success: false, error: r.err || 'ffmpeg failed' };
    }

    try { fs.renameSync(partPath, outPath); } catch (e) {
      return { success: false, error: 'Could not finalise output: ' + (e as Error).message };
    }

    // Index the new clip into the search DB so S&D / Memories pick
    // it up. Same pattern as Phase 3a Enhance save.
    try {
      const { indexTrimmedClip } = await import('./search-database.js');
      const newId = await indexTrimmedClip(req.filePath, outPath);
      if (newId == null) {
        log.warn(`[viewer:trimVideo] source row not in library index (${req.filePath}); clip written but not indexed`);
      } else {
        try {
          mainWindow?.webContents.send('library:filesAdded', {
            reason: 'trimmed',
            sourcePath: req.filePath,
            newFilePath: outPath,
            fileId: newId,
          });
        } catch { /* non-fatal */ }
      }
    } catch (idxErr) {
      log.warn(`[viewer:trimVideo] index pass failed (clip still saved): ${(idxErr as Error).message}`);
    }

    return { success: true, newFilePath: outPath };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('viewer:saveEnhanced', async (_event, req: SaveEnhancedRequest) => {
  try {
    if (!req?.filePath || !fs.existsSync(req.filePath)) {
      return { success: false, error: 'Source file not found.' };
    }
    if (req.mode !== 'new' && req.mode !== 'replace') {
      return { success: false, error: 'mode must be "new" or "replace".' };
    }
    const fs2 = await import('node:fs/promises');
    const sharp = (await import('sharp')).default;
    const filePathLong = toLongPath(req.filePath);
    const fs2Stat = await fs2.stat(filePathLong).catch(() => null);
    if (!fs2Stat || !fs2Stat.isFile()) {
      return { success: false, error: 'Source file not found.' };
    }

    // Resolve output path. New-file path appends _E before the extension;
    // collisions get _E_2, _E_3, ... so an existing _E.jpg from a prior
    // save isn't overwritten.
    const dir = path.dirname(req.filePath);
    const ext = path.extname(req.filePath);
    const baseNoExt = path.basename(req.filePath, ext);
    // Force JPG output regardless of source extension. The Enhance flow
    // produces an enhanced photo; PNG/TIFF inputs become JPG to keep file
    // size sane. Original is unchanged (only relevant in 'new' mode;
    // 'replace' inherits the source extension below).
    const outExtNew = '.jpg';
    let outPath: string;
    if (req.mode === 'new') {
      let candidate = path.join(dir, `${baseNoExt}_E${outExtNew}`);
      let n = 2;
      while (fs.existsSync(toLongPath(candidate))) {
        candidate = path.join(dir, `${baseNoExt}_E_${n}${outExtNew}`);
        n++;
        if (n > 999) {
          return { success: false, error: 'Too many existing enhanced copies.' };
        }
      }
      outPath = candidate;
    } else {
      // Replace original — keep the existing filename + extension.
      outPath = req.filePath;
    }
    const outPathLong = toLongPath(outPath);
    const tmpPath = outPath + '.pdr-enh.tmp';
    const tmpPathLong = toLongPath(tmpPath);

    // Build the sharp pipeline.
    const fs2State = req.filterState;
    const brightnessF = (fs2State.brightness ?? 100) / 100;   // 1.0 = neutral
    const contrastF   = (fs2State.contrast ?? 100) / 100;     // 1.0 = neutral
    const saturationF = (fs2State.saturation ?? 100) / 100;   // 1.0 = neutral
    const temperature = fs2State.temperature ?? 0;
    const bw = !!fs2State.bw;

    // v2.0.15 Phase 5+ — if sourceOverride is set (AI Enhance flows),
    // bake the manual sliders on top of the AI output temp file
    // instead of the user's original. The output destination + _E
    // filename still derive from req.filePath, so the AI-enhanced
    // file lands next to the original in the user's library.
    const pipelineSource = req.sourceOverride && fs.existsSync(req.sourceOverride)
      ? toLongPath(req.sourceOverride)
      : filePathLong;
    let pipeline = sharp(pipelineSource, { failOnError: false }).rotate();

    // Brightness + saturation via modulate. modulate({ brightness })
    // multiplies pixel values; brightness=1 is neutral. saturation
    // ignored when bw=true (greyscale() handles it).
    if (brightnessF !== 1 || (saturationF !== 1 && !bw)) {
      pipeline = pipeline.modulate({
        brightness: brightnessF,
        ...(bw ? {} : { saturation: saturationF }),
      });
    }

    // Contrast via linear. linear(slope, intercept) computes
    // output = slope * input + intercept. To centre contrast on
    // mid-grey (128), intercept = 128 * (1 - slope).
    if (contrastF !== 1) {
      const slope = contrastF;
      const offset = 128 * (1 - slope);
      pipeline = pipeline.linear(slope, offset);
    }

    // v2.0.15 (Terry 2026-06-06) — Temperature via .recomb() (per-
    // channel multiplier matrix), NOT .tint(). Sharp's tint() makes
    // the image MONOCHROME (single-color tinted), which is what
    // produced the "saved file came out B&W" bug Terry hit — any
    // non-zero Temperature value was effectively desaturating the
    // output. recomb([[r,g,b],[r,g,b],[r,g,b]]) applies a 3×3 colour
    // matrix; the diagonal-only form below scales each channel
    // independently, preserving the image's saturation while shifting
    // the colour balance toward warm (more R, less B) or cool (less
    // R, more B). 0.15 magnitude per channel = subtle but visible at
    // ±50 slider position.
    if (temperature !== 0) {
      const t = temperature / 50; // -1..+1
      const rGain = 1 + 0.15 * t;
      const bGain = 1 - 0.15 * t;
      pipeline = pipeline.recomb([
        [rGain, 0,     0    ],
        [0,     1,     0    ],
        [0,     0,     bGain],
      ]);
    }

    if (bw) {
      pipeline = pipeline.greyscale();
    }

    // .withMetadata() preserves the source's EXIF/IPTC/XMP so we don't
    // lose camera info, capture date, GPS, etc. We then write the
    // PDR-Enhanced XMP fields via exiftool after the sharp write
    // (sharp doesn't write custom XMP fields directly).
    pipeline = pipeline.withMetadata();

    // Output: JPEG quality 92 — high quality without being absurd file
    // size. mozjpeg=true uses sharp's better encoder when available.
    await pipeline
      .jpeg({ quality: 92, mozjpeg: true })
      .toFile(tmpPathLong);

    // Atomic move into place.
    try { if (fs.existsSync(outPathLong) && req.mode === 'replace') fs.unlinkSync(outPathLong); } catch {}
    fs.renameSync(tmpPathLong, outPathLong);

    // Write PDR-Enhanced XMP metadata via exiftool. Best-effort — if
    // exiftool fails, the file is still successfully saved; only the
    // discoverability via S&D filter chips is affected.
    try {
      const { ExifTool } = await import('exiftool-vendored');
      const exiftoolPath = path.join(__dirname, 'bin', 'exiftool.exe');
      const exiftool = new ExifTool({
        exiftoolPath: fs.existsSync(exiftoolPath) ? exiftoolPath : undefined,
      });
      const enhancementType = req.enhancementType ?? 'manual';
      const enhancementMethod = req.enhancementMethod ?? enhancementType;
      try {
        // exiftool-vendored's WriteTags type doesn't enumerate every
        // possible XMP namespace tag — custom XMP fields require the
        // loose cast pattern PDR already uses in exif-writer.ts.
        const tags = {
          'XMP-xmp:Label': `PDR-Enhanced-${enhancementType}`,
          'XMP-xmp:MetadataDate': new Date().toISOString(),
          // History gives standards-aware readers (Lightroom, Bridge)
          // a clean log entry without overwriting any existing one.
          'XMP-xmpMM:HistoryAction': 'enhanced',
          'XMP-xmpMM:HistorySoftwareAgent': `Photo Date Rescue 2.0.15 (${enhancementMethod})`,
          'XMP-xmpMM:HistoryWhen': new Date().toISOString(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        await exiftool.write(outPath, tags, ['-overwrite_original']);
      } finally {
        try { await exiftool.end(); } catch {}
      }
    } catch (xmpErr) {
      log.warn(`[viewer:saveEnhanced] XMP write failed (non-fatal): ${(xmpErr as Error).message}`);
    }

    // v2.0.15 Phase 3a (Terry 2026-06-06) — single-file indexing so
    // the new _E sibling shows up in S&D / Memories without a manual
    // refresh. indexEnhancedSibling inherits the source's run_id +
    // date + EXIF + GPS (it's the same photo, enhanced), recomputes
    // size + hash from disk, and upserts via insertFiles. Replace
    // mode also goes through this path because the file's bytes
    // changed — size_bytes and hash need to be refreshed in the row
    // even though file_path is unchanged.
    try {
      const { indexEnhancedSibling } = await import('./search-database.js');
      // Pass the enhancementType through so the upserted row's
      // enhancement_type column reflects manual vs codeformer vs
      // realesrgan vs combined. The S&D "Enhanced" filter chip
      // reads this. Default is 'manual' inside the helper.
      const newId = await indexEnhancedSibling(
        req.filePath,
        outPath,
        req.enhancementType ?? 'manual',
      );
      if (newId == null) {
        log.warn(`[viewer:saveEnhanced] source row not in library index (${req.filePath}); _E file written but not indexed`);
      } else {
        // Broadcast so S&D / Memories / Albums can re-fetch and the
        // new file appears live. Same pattern as recycle:changed.
        try {
          mainWindow?.webContents.send('library:filesAdded', {
            reason: 'enhanced',
            mode: req.mode,
            sourcePath: req.filePath,
            newFilePath: outPath,
            fileId: newId,
          });
        } catch { /* non-fatal */ }
      }
    } catch (idxErr) {
      log.warn(`[viewer:saveEnhanced] index pass failed (file still saved): ${(idxErr as Error).message}`);
    }

    return { success: true, newFilePath: outPath };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:faceContext', async (_event, filePath: string, boxX: number, boxY: number, boxW: number, boxH: number, size: number = 240) => {
  try {
    const sharp = (await import('sharp')).default;
    // EXIF auto-rotate so we work in the same coordinate space as the
    // detector — see ai:faceCrop above for the long-form rationale.
    const metadata = await sharp(filePath, { failOnError: false }).rotate().metadata();
    if (!metadata.width || !metadata.height) return { success: false, error: 'Could not read image' };

    const imgW = metadata.width;
    const imgH = metadata.height;

    // Convert normalised coords to pixels
    const faceX = Math.round(boxX * imgW);
    const faceY = Math.round(boxY * imgH);
    const faceW = Math.round(boxW * imgW);
    const faceH = Math.round(boxH * imgH);

    // Create a wider crop area (3x the face size) for context
    const expand = 1.5;
    const contextW = Math.round(Math.max(faceW, faceH) * (1 + expand * 2));
    const cx = faceX + faceW / 2;
    const cy = faceY + faceH / 2;
    let cropX = Math.round(cx - contextW / 2);
    let cropY = Math.round(cy - contextW / 2);
    let cropW = contextW;
    let cropH = contextW;

    // Clamp to image bounds
    cropX = Math.max(0, cropX);
    cropY = Math.max(0, cropY);
    cropW = Math.min(cropW, imgW - cropX);
    cropH = Math.min(cropH, imgH - cropY);
    if (cropW <= 0 || cropH <= 0) return { success: false, error: 'Invalid crop' };

    // Calculate face box position relative to the crop, scaled to output.
    //
    // CRITICAL: the resize below uses `fit: 'contain'` so the image
    // letterboxes inside the size×size output — preserving aspect
    // ratio without cropping. The box scale must match: we use
    // `scale = size / max(cropW, cropH)` (fit-inside) and offset the
    // box by half the letterbox padding on each axis. With `fit:
    // 'cover'` (the previous behaviour) the axis-min was stretched
    // to fill and the other axis was cropped, but our SVG math used
    // the fit-inside scale — net effect was the box landed several
    // dozen pixels off the face whenever the crop was non-square
    // (which is most photos, especially when the face sits near an
    // image edge). S&D didn't have this bug because the browser
    // applies normalised coords directly to the rendered image.
    const relX = faceX - cropX;
    const relY = faceY - cropY;
    const scale = size / Math.max(cropW, cropH);
    // Letterbox offset: with fit:contain, sharp centres the image,
    // so we need to push the box by the same amount sharp pushes
    // the pixels.
    const padX = Math.round((size - cropW * scale) / 2);
    const padY = Math.round((size - cropH * scale) / 2);
    const boxPx = {
      x: Math.round(relX * scale) + padX,
      y: Math.round(relY * scale) + padY,
      w: Math.round(faceW * scale),
      h: Math.round(faceH * scale),
    };

    // Create the crop (fit:contain preserves aspect; soft neutral
    // background fills the letterbox bars so the preview doesn't
    // look broken on portrait/landscape source crops).
    const cropped = await sharp(filePath, { failOnError: false })
      .rotate()
      .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
      .resize(size, size, { fit: 'contain', background: { r: 245, g: 243, b: 250, alpha: 1 } })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Draw a face indicator box using SVG overlay
    const strokeW = 4;
    const svgBox = Buffer.from(`<svg width="${size}" height="${size}">
      <rect x="${boxPx.x}" y="${boxPx.y}" width="${boxPx.w}" height="${boxPx.h}"
            fill="none" stroke="#a855f7" stroke-width="${strokeW}" rx="3" opacity="0.9"/>
    </svg>`);

    const final = await sharp(cropped)
      .composite([{ input: svgBox, top: 0, left: 0 }])
      .jpeg({ quality: 85 })
      .toBuffer();

    const dataUrl = `data:image/jpeg;base64,${final.toString('base64')}`;
    return { success: true, dataUrl };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ═══ Parallel Structure IPC Handlers ═════════════════════════════════════════

let structureCopyCancelled = false;

ipcMain.handle('structure:copy:cancel', async () => {
  structureCopyCancelled = true;
  return { success: true };
});

ipcMain.handle('structure:copy', async (_event, data: {
  files: Array<{
    sourcePath: string;
    filename: string;
    derivedDate: string | null;
    sizeBytes: number;
  }>;
  destinationPath: string;
  folderStructure: 'year' | 'year-month' | 'year-month-day';
  mode: 'copy' | 'move';
  skipDuplicates: boolean;
}) => {
  structureCopyCancelled = false;
  const { files, destinationPath, folderStructure, mode, skipDuplicates } = data;
  const results: Array<{ success: boolean; sourcePath: string; destPath: string; error?: string; originalDeleted?: boolean }> = [];
  let copied = 0, failed = 0, skipped = 0, movedAndDeleted = 0;
  const usedFilenames = new Set<string>();
  const writtenHashes = new Map<string, string>(); // hash → destPath

  // Scan pre-existing files at destination to skip duplicates
  const preExisting = new Set<string>();
  if (skipDuplicates) {
    try {
      const scanDir = async (dir: string, base: string) => {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            preExisting.add(path.join(base, entry.name).toLowerCase());
          } else if (entry.isDirectory()) {
            await scanDir(path.join(dir, entry.name), path.join(base, entry.name));
          }
        }
      };
      if (fs.existsSync(destinationPath)) await scanDir(destinationPath, '');
    } catch (err) {
      console.error('[Structure] Error scanning destination:', (err as Error).message);
    }
  }

  for (let i = 0; i < files.length; i++) {
    if (structureCopyCancelled) {
      return { success: true, results, copied, failed, skipped, movedAndDeleted, cancelled: true };
    }

    const file = files[i];
    await yieldToEventLoop();

    try {
      // Build subfolder from derived date
      let subfolderPath = '';
      if (file.derivedDate) {
        const date = new Date(file.derivedDate);
        const year = date.getFullYear().toString();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');

        if (folderStructure === 'year') subfolderPath = year;
        else if (folderStructure === 'year-month') subfolderPath = path.join(year, month);
        else if (folderStructure === 'year-month-day') subfolderPath = path.join(year, month, day);
      } else {
        subfolderPath = 'Undated';
      }

      const targetDir = path.join(destinationPath, subfolderPath);
      await fs.promises.mkdir(toLongPath(targetDir), { recursive: true });

      let finalFilename = file.filename;
      const ext = path.extname(finalFilename);
      const baseName = path.basename(finalFilename, ext);

      // Skip pre-existing files by name
      if (skipDuplicates && preExisting.has(path.join(subfolderPath, finalFilename).toLowerCase())) {
        skipped++;
        results.push({ success: true, sourcePath: file.sourcePath, destPath: '', error: 'Skipped: already exists at destination' });
        mainWindow?.webContents.send('structure:copy:progress', { current: i + 1, total: files.length, currentFile: file.filename, phase: 'copying' });
        continue;
      }

      // Handle filename collisions
      let counter = 1;
      while (usedFilenames.has(path.join(subfolderPath, finalFilename).toLowerCase()) ||
             fs.existsSync(path.join(targetDir, finalFilename))) {
        finalFilename = `${baseName}_${String(counter).padStart(3, '0')}${ext}`;
        counter++;
      }
      usedFilenames.add(path.join(subfolderPath, finalFilename).toLowerCase());

      const destPath = path.join(targetDir, finalFilename);

      // Check source exists
      if (!fs.existsSync(file.sourcePath)) {
        failed++;
        results.push({ success: false, sourcePath: file.sourcePath, destPath, error: 'Source file not found' });
        mainWindow?.webContents.send('structure:copy:progress', { current: i + 1, total: files.length, currentFile: file.filename, phase: 'copying' });
        continue;
      }

      // Copy with hash verification
      mainWindow?.webContents.send('structure:copy:progress', { current: i + 1, total: files.length, currentFile: file.filename, phase: 'copying' });
      const hash = await streamCopyFile(file.sourcePath, destPath, true) as string;

      // Content-based dedup check
      if (skipDuplicates && hash && writtenHashes.has(hash)) {
        // Same content already written — remove this copy and skip
        await fs.promises.unlink(destPath);
        skipped++;
        results.push({ success: true, sourcePath: file.sourcePath, destPath: '', error: `Skipped: duplicate of ${path.basename(writtenHashes.get(hash)!)}` });
        mainWindow?.webContents.send('structure:copy:progress', { current: i + 1, total: files.length, currentFile: file.filename, phase: 'copying' });
        continue;
      }

      if (hash) writtenHashes.set(hash, destPath);

      // For move mode: verify hash match then delete original
      if (mode === 'move') {
        mainWindow?.webContents.send('structure:copy:progress', { current: i + 1, total: files.length, currentFile: file.filename, phase: 'verifying' });
        // Verify by reading the destination file hash
        const verifyHash = await streamCopyFile(destPath, destPath + '.verify_tmp', true) as string;
        await fs.promises.unlink(destPath + '.verify_tmp'); // Remove the verify temp file

        if (hash === verifyHash) {
          mainWindow?.webContents.send('structure:copy:progress', { current: i + 1, total: files.length, currentFile: file.filename, phase: 'deleting' });
          await fs.promises.unlink(file.sourcePath);
          movedAndDeleted++;
          results.push({ success: true, sourcePath: file.sourcePath, destPath, originalDeleted: true });
        } else {
          // Hash mismatch — keep both files, report error
          results.push({ success: true, sourcePath: file.sourcePath, destPath, error: 'Copy verified but hash mismatch — original preserved', originalDeleted: false });
        }
      } else {
        results.push({ success: true, sourcePath: file.sourcePath, destPath });
      }

      copied++;
    } catch (err) {
      failed++;
      results.push({ success: false, sourcePath: file.sourcePath, destPath: '', error: (err as Error).message });
    }

    mainWindow?.webContents.send('structure:copy:progress', { current: i + 1, total: files.length, currentFile: file.filename, phase: 'copying' });
  }

  mainWindow?.webContents.send('structure:copy:progress', { current: files.length, total: files.length, currentFile: '', phase: 'complete' });
  console.log(`[Structure] Complete: ${copied} copied, ${skipped} skipped, ${failed} failed${mode === 'move' ? `, ${movedAndDeleted} originals deleted` : ''}`);
  return { success: true, results, copied, failed, skipped, movedAndDeleted, cancelled: false };
});

// Shutdown AI worker on app quit
app.on('before-quit', () => {
  shutdownAiWorker();
  // v2.0.14 — kill the pre-warmed analysis-worker too so it doesn't
  // outlive PDR's window. The other prewarmed workers (extract,
  // cleanup) have their own lifecycle that handles this; analysis was
  // added in v2.0.14 so its cleanup goes here.
  try { prewarmedAnalysisWorker?.kill(); } catch { /* best-effort */ }
  prewarmedAnalysisWorker = null;
});
