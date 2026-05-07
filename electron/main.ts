import { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net, nativeImage, utilityProcess } from 'electron';
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
log.transports.console.level = 'debug';
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
// ffmpeg-static is a CommonJS module; createRequire lets us require it from ESM.
const esmRequire = createRequire(import.meta.url);
let ffmpegPath: string | null = null;
try {
  ffmpegPath = esmRequire('ffmpeg-static');
  if (ffmpegPath && !fs.existsSync(ffmpegPath)) ffmpegPath = null;
} catch { ffmpegPath = null; }
console.log('[ffmpeg] path =', ffmpegPath);

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.3gp', '.mpg', '.mpeg']);

/**
 * Extract a single frame from a video using ffmpeg-static. Returns a JPEG buffer
 * suitable for piping into sharp. Seeks ~1s into the video to skip the usual
 * black/fade-in frame. Falls back to frame 0 if the video is shorter than 1s.
 */
async function extractVideoFrame(videoPath: string, seekSec = 1): Promise<Buffer | null> {
  if (!ffmpegPath) return null;
  return new Promise<Buffer | null>((resolve) => {
    const tmp = path.join(os.tmpdir(), `pdr-vthumb-${crypto.randomBytes(6).toString('hex')}.jpg`);
    // -ss before -i is a fast seek; -frames:v 1 takes a single frame; -y overwrites
    const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(seekSec), '-i', videoPath, '-frames:v', '1', '-q:v', '3', '-y', tmp];
    const proc = spawn(ffmpegPath!, args, { windowsHide: true });
    let finished = false;
    const done = async (ok: boolean) => {
      if (finished) return;
      finished = true;
      try {
        if (ok && fs.existsSync(tmp)) {
          const buf = await fs.promises.readFile(tmp);
          fs.promises.unlink(tmp).catch(() => {});
          resolve(buf);
          return;
        }
      } catch {}
      fs.promises.unlink(tmp).catch(() => {});
      resolve(null);
    };
    proc.on('error', () => done(false));
    proc.on('close', (code) => done(code === 0));
    // Safety timeout so hangs don't pile up
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} done(false); }, 15000);
  });
}

// Let sharp use default thread pool (number of CPU cores) for fast encoding
import { analyzeSource, cancelAnalysis } from './analysis-engine.js';
import AdmZip from 'adm-zip';
import * as unzipper from 'unzipper';
import crypto from 'crypto';
import { saveReport, loadReport, loadLatestReport, listReports, deleteReport, exportReportToCSV, exportReportToTXT, getExportFilename, writeCatalogue, FixReport } from './report-storage.js';
import { getSettings, setSetting, setSettings, PDRSettings, resetCriticalSettings, resetToOptimisedDefaults } from './settings-store.js';
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
  checkForUpdates,
  initAutoUpdater,
  downloadUpdate,
  quitAndInstall,
  getUpdateState,
} from './update-checker.js';
import { classifySource, checkSameDriveWarning } from './source-classifier.js';
import {
  initDatabase,
  closeDatabase,
  searchFiles,
  getFilterOptions,
  getIndexStats,
  clearAllIndexData,
  removeRun,
  removeRunByReportId,
  listRuns,
  getMemoriesYearMonthBuckets,
  getMemoriesOnThisDay,
  getMemoriesDayFiles,
  saveFavouriteFilter,
  listFavouriteFilters,
  deleteFavouriteFilter,
  renameFavouriteFilter,
  type SearchQuery,
} from './search-database.js';
import { indexFixRun, cancelIndexing, shutdownIndexerExiftool, type IndexProgress } from './search-indexer.js';
import { loadReport as loadReportForIndex } from './report-storage.js';
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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      readStream.destroy();
      writeStream.destroy();
      reject(new Error(`Copy timeout: ${path.basename(src)}`));
    }, 120000); // 2 min timeout per file
    const readStream = fs.createReadStream(src, { highWaterMark: 64 * 1024 });
    const writeStream = fs.createWriteStream(dest);
    const hashObj = computeHash ? crypto.createHash('sha256') : null;

    readStream.on('data', (chunk) => { if (hashObj) hashObj.update(chunk); });
    readStream.on('error', (err) => { clearTimeout(timer); reject(err); });
    writeStream.on('error', (err) => { clearTimeout(timer); reject(err); });
    writeStream.on('finish', () => { clearTimeout(timer); resolve(hashObj ? hashObj.digest('hex') : null); });

    readStream.pipe(writeStream);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#f6f6fb',
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

	mainWindow.loadFile(path.join(__dirname, '../dist/public/index.html'));

	// Surface renderer [inline-video] / [video] console messages in main log.
	mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
	  if (message.includes('[inline-video]') || message.includes('[video]') || message.includes('[pdr-file]')) {
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
	        console.log(`[AI] Auto-start check: pendingFaces=${pendingFaces > 0}, pendingTags=${pendingTags > 0}`);
	        if (pendingFaces > 0) {
	          console.log('[AI] Auto-starting AI processing (faces pending)...');
	          await startAiProcessing();
	        } else if (pendingTags > 0) {
	          console.log('[AI] Auto-starting tags-only processing (resuming previous re-analyze)...');
	          await startAiProcessing({ tagsOnly: true });
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
	// DevTools (F12 / Ctrl+Shift+I) is dev-only so packaged builds can't be
	// opened up + inspected by end users. !app.isPackaged means: enabled when
	// running via `npx electron dist-electron/main.js` (dev), disabled in the
	// installed NSIS build that ships to customers.
	mainWindow!.webContents.on('before-input-event', (_event, input) => {
	  if (!app.isPackaged && (input.key === 'F12' || (input.control && input.shift && input.key === 'I'))) {
	    mainWindow?.webContents.toggleDevTools();
	    return;
	  }
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
  fs.mkdirSync(tempDir, { recursive: true });

  onProgress?.('Unpacking RAR archive...', 0, 0);

  const unrarPath = getUnrarPath();

  return new Promise<void>((resolve, reject) => {
    const args = ['x', '-o+', '-y', rarPath, tempDir + path.sep];
    const child = execFile(unrarPath, args, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`UnRAR extraction failed: ${error.message}\n${stderr}`));
      } else {
        onProgress?.('RAR archive unpacked', 0, 0);
        resolve();
      }
    });

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
 *      has enough headroom. Same physical disk as the eventual fix
 *      output → no cross-drive copy on completion, fastest analysis.
 *   2. %TEMP% (PDR_TEMP_ROOT) if it has enough headroom. This is the
 *      historic default; works fine when C: is roomy.
 *   3. Failure case → caller surfaces a smart-prompt to the user
 *      asking them to pick a different temp location.
 *
 * Required headroom = zipSize × 1.2 + 1 GB safety margin. The 1.2x
 * accounts for the small inflation typical when an already-compressed
 * format (JPEG/MP4) is wrapped in a zip; the 1 GB safety prevents a
 * picker that's "just enough" from completely filling the drive and
 * tripping every other process on the system.
 */
const PRE_EXTRACT_HEADROOM_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB
const PRE_EXTRACT_INFLATION = 1.2;

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
  neededBytes: number;
  destinationPath: string | null;
  destinationLocal: boolean;
  destinationFreeBytes: number | null;
  tempFreeBytes: number | null;
}

function pickPreExtractDir(
  zipPath: string,
  destinationPath: string | null,
): PreExtractDecision | PreExtractRefusal {
  const zipSize = getZipFileSize(zipPath);
  const neededBytes = Math.ceil(zipSize * PRE_EXTRACT_INFLATION) + PRE_EXTRACT_HEADROOM_BYTES;

  const destLocal = isLocalDir(destinationPath);
  let destFree: number | null = null;
  if (destinationPath && destLocal) {
    const space = getDiskSpaceForDirSync(destinationPath);
    if (space) destFree = space.freeBytes;
  }

  // Prefer the destination drive when it qualifies.
  if (destinationPath && destLocal && destFree != null && destFree >= neededBytes) {
    const baseDir = path.join(destinationPath, 'PDR_Temp');
    return {
      ok: true,
      baseDir,
      tempDir: path.join(baseDir, path.basename(generateTempDirName(zipPath))),
      chosenLabel: `destination drive (${destinationPath})`,
      destinationFreeBytes: destFree,
      tempFreeBytes: null,
    };
  }

  // Fall back to %TEMP%.
  const tempSpace = getDiskSpaceForDirSync(PDR_TEMP_ROOT);
  const tempFree = tempSpace?.freeBytes ?? null;
  if (tempFree != null && tempFree >= neededBytes) {
    return {
      ok: true,
      baseDir: PDR_TEMP_ROOT,
      tempDir: generateTempDirName(zipPath),
      chosenLabel: '%TEMP% (PDR_TEMP_ROOT)',
      destinationFreeBytes: destFree,
      tempFreeBytes: tempFree,
    };
  }

  return {
    ok: false,
    neededBytes,
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

function cleanupTempDir(tempDir: string): void {
  // Log success + failure to main.log so post-fix cleanup behaviour
  // is visible in support diagnostics. v1.0.x silently swallowed
  // failures, which made it impossible to tell from a user's log
  // whether the cleanup hook had fired (path-match worked, dir
  // deleted) or hadn't (path-match skipped this dir entirely).
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      log.info(`[temp-cleanup] removed ${tempDir}`);
    } else {
      log.info(`[temp-cleanup] no-op (already gone): ${tempDir}`);
    }
  } catch (err) {
    // Best-effort: a locked file (Explorer window open, antivirus
    // scanning, etc.) shouldn't fail the user's fix or block the
    // app from quitting. Subsequent cleanup attempts (next quit /
    // next startup orphan-sweep) get another chance.
    log.warn(`[temp-cleanup] failed to remove ${tempDir}:`, err);
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
  fs.mkdirSync(tempDir, { recursive: true });
  
  onProgress?.('Unpacking ZIP archive...', 0, 0);
  
  const directory = await unzipper.Open.file(zipPath);
  const totalEntries = directory.files.length;
  let extracted = 0;
  
  for (const file of directory.files) {
    if (file.type === 'Directory') continue;
    
    const outputPath = path.join(tempDir, file.path);
    const outputDir = path.dirname(outputPath);
    
    fs.mkdirSync(outputDir, { recursive: true });
    
    await new Promise<void>((resolve, reject) => {
      file.stream()
        .pipe(fs.createWriteStream(outputPath))
        .on('finish', resolve)
        .on('error', reject);
    });
    
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

// Track active temp dirs so we can clean up on cancel/quit
const activeTempDirs = new Set<string>();

// Register custom protocol for serving local files to viewer
protocol.registerSchemesAsPrivileged([
  { scheme: 'pdr-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
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

  // Handle pdr-file:// protocol — serves local files to the viewer window
  protocol.handle('pdr-file', (request) => {
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
    // Forward Range headers so the <video> element can seek properly.
    return net.fetch(fileUrl, {
      headers: request.headers,
      method: request.method,
    });
  });

  // Remove default Electron menus — custom title bar replaces them
  Menu.setApplicationMenu(null);

  createWindow();

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

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    defaultPath: 'C:\\'
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
  try {
    if (process.platform === 'win32') {
      // Use PowerShell asynchronously instead of wmic (which is deprecated and blocks the main process)
      const output = await new Promise<string>((resolve, reject) => {
        execFile('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          `Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,DriveType,Size,FreeSpace | ConvertTo-Csv -NoTypeInformation`
        ], { encoding: 'utf8', timeout: 10000 }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      });
      const lines = output.trim().split('\n').filter(l => l.trim());
      if (lines.length < 2) return [];
      // Parse CSV: header line + data lines
      return lines.slice(1).map(line => {
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
        };
      }).filter(d => d.letter);
    }
    return [];
  } catch (error) {
    console.error('Error listing drives:', error);
    return [];
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

// Track in-flight transcodes so concurrent calls de-dupe to the same promise.
const transcodeInFlight = new Map<string, Promise<{ success: boolean; cachePath?: string; error?: string }>>();

async function transcodeVideoToMp4(sourcePath: string, cachePath: string): Promise<{ success: boolean; cachePath?: string; error?: string }> {
  if (!ffmpegPath) return { success: false, error: 'ffmpeg binary not found' };
  return new Promise((resolve) => {
    // Write to a .part file first so a crashed transcode doesn't leave a half-written cache entry.
    const partPath = cachePath + '.part';
    try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch {}
    // -f mp4 is REQUIRED because the .part extension means ffmpeg can't
    // infer the container from the filename.
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', sourcePath,
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

    // Extensions Chromium handles natively — no transcode needed.
    if (!TRANSCODE_EXTS.has(ext)) {
      return { success: true, playableUrl: toPdrUrl(filePath) };
    }

    // Derive a deterministic cache key from absolute path + mtime + size so the
    // cache auto-invalidates if the source is replaced.
    const stat = await fs.promises.stat(filePath);
    const keySrc = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    const cacheKey = crypto.createHash('md5').update(keySrc).digest('hex');
    const cachePath = path.join(videoCacheDir, `${cacheKey}.mp4`);

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
    // Check disk cache first
    const cacheKey = crypto.createHash('md5').update(`${filePath}:${size}`).digest('hex');
    const cachePath = path.join(thumbCacheDir, `${cacheKey}.jpg`);

    if (fs.existsSync(cachePath)) {
      const cached = await fs.promises.readFile(cachePath);
      return { success: true, dataUrl: `data:image/jpeg;base64,${cached.toString('base64')}` };
    }

    // Check file exists
    if (!fs.existsSync(filePath)) {
      return { success: false, dataUrl: '' };
    }

    let jpegBuffer: Buffer | null = null;
    const ext = path.extname(filePath).toLowerCase();

    // Video: extract a frame via ffmpeg-static, then resize through sharp.
    if (VIDEO_EXTS.has(ext)) {
      try {
        // Try 1s in first; short clips / MPEG-1 files may fail that seek, so retry at 0.
        let frame = await extractVideoFrame(filePath, 1);
        if (!frame) frame = await extractVideoFrame(filePath, 0);
        if (frame) {
          jpegBuffer = await sharp(frame, { failOnError: false })
            .resize(size, size, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();
        } else {
          console.warn('[ffmpeg] no frame extracted for', filePath);
        }
      } catch (e) {
        console.warn('[ffmpeg] frame→sharp failed for', filePath, (e as Error).message);
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
        jpegBuffer = await sharp(filePath, { failOnError: false })
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
      const img = nativeImage.createFromPath(filePath);
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

    // Save to disk cache (fire and forget)
    fs.promises.writeFile(cachePath, jpegBuffer).catch(() => {});

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
ipcMain.handle('analysis:cleanupTempDirForSource', async (_event, sourcePath: string) => {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    return { success: false, cleaned: 0 };
  }
  let cleaned = 0;
  // Compute both candidate temp-dir names (zip and rar style).
  // Either or both may exist depending on what kind of source it
  // was; the inverse one will simply not match anything.
  const candidates: string[] = [];
  try { candidates.push(generateTempDirName(sourcePath)); } catch { /* malformed path */ }
  try { candidates.push(generateRarTempDirName(sourcePath)); } catch { /* malformed path */ }
  for (const td of candidates) {
    if (activeTempDirs.has(td)) {
      cleanupTempDir(td);
      activeTempDirs.delete(td);
      cleaned++;
    } else if (fs.existsSync(td)) {
      // Edge case: dir exists but isn't tracked (e.g. left over from
      // a prior session that didn't clean up cleanly). Reap it
      // anyway so the user gets the disk space back.
      cleanupTempDir(td);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[Source remove] Cleaned up ${cleaned} extracted temp dir${cleaned === 1 ? '' : 's'} for source: ${sourcePath}`);
  }
  return { success: true, cleaned };
});
  
ipcMain.handle('analysis:run', async (_event, sourcePath: string, sourceType: 'folder' | 'zip' | 'drive', tempDirOverride?: string) => {
  let tempDir: string | null = null;
  let claimedExtractInFlight = false;

  try {
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
        throw Object.assign(
          new Error(
            `PDR keeps up to ${fmtGB(EXTRACTION_CAP_BYTES)} GB of extracted source archives at once. ` +
            `Currently using ${fmtGB(pendingBytes)} GB; this source would add ${fmtGB(incomingBytes)} GB. ` +
            `Run the fix on what you've already added to free space, then come back to add more.`,
          ),
          {
            code: 'EXTRACTION_CAP_REACHED',
            pendingBytes,
            incomingBytes,
            capBytes: EXTRACTION_CAP_BYTES,
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
        const settings = (() => { try { return getSettings(); } catch { return null; } })();
        const decision = pickPreExtractDir(sourcePath, settings?.destinationPath ?? null);
        if (!decision.ok) {
          // Surface a structured error so the renderer can drive a
          // smart-prompt modal asking the user to pick a different
          // temp drive. Re-invoking analysis:run with a
          // tempDirOverride bypasses this branch.
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

      console.log(`[Pre-extract] zip="${path.basename(sourcePath)}" → ${chosenLabel}`);

      // Notify renderer about the extraction
      mainWindow?.webContents.send('analysis:progress', {
        current: 0,
        total: 0,
        currentFile: 'This Google Takeout is large — PDR is unpacking it temporarily so it can analyse your photos safely. Originals are untouched.',
        phase: 'scanning'
      });

      await extractLargeZip(sourcePath, tempDir, (message, current, total) => {
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
    
    const results = await analyzeSource(
      effectivePath,
      effectiveType,
      (progress) => {
        mainWindow?.webContents.send('analysis:progress', progress);
      },
      // Diagnostic sink — forwards [PDR-DIAG ...] lines to the renderer
      // so they show up in F12 console alongside whatever else the
      // renderer is logging. Kept off the progress channel so the
      // progress UI's existing payload contract isn't muddied.
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
    // Clean up temp dir on failure
    if (tempDir) {
      cleanupTempDir(tempDir);
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
  try {
    const savedReport = await saveReport(reportData);

    // Auto-catalogue: write cumulative PDR_Catalogue.csv/txt to destination root
    const settings = getSettings();
    console.log('[Catalogue] autoSaveCatalogue:', settings.autoSaveCatalogue, 'destinationPath:', savedReport.destinationPath);
    if (settings.autoSaveCatalogue && savedReport.destinationPath) {
      try {
        const catResult = await writeCatalogue(savedReport.destinationPath);
        console.log('[Catalogue] Write result:', catResult);
      } catch (catErr) {
        console.error('[Catalogue] Write failed (non-fatal):', catErr);
      }
    } else {
      console.log('[Catalogue] Skipped — setting off or no destination');
    }

    return { success: true, data: savedReport };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

// Scan destination for existing files and their hashes (for cross-run duplicate detection)
ipcMain.handle('destination:prescan', async (_event, destinationPath: string) => {
  try {
    console.log(`[Prescan] Starting destination prescan: ${destinationPath}`);
    const prescanStart = Date.now();
    const settings = getSettings();
    const useHash = settings.thoroughDuplicateMatching;
    console.log(`[Prescan] thoroughDuplicateMatching=${useHash}`);
    
    const existingHashes = new Map<string, string>(); // hash -> filename
    const existingHeuristics = new Map<string, string>(); // "filename|size" -> filename
    let totalFiles = 0;
    
    const LARGE_FILE_THRESHOLD = 500 * 1024 * 1024;
    
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
              }
            }
          } catch {
            // Skip files we can't stat
          }
          
          // Yield every 50 files
          if (totalFiles % 50 === 0) {
            await yieldToEventLoop();
            mainWindow?.webContents.send('destination:prescan:progress', { scanned: totalFiles });
          }
        }
      }
    };
    
    if (fs.existsSync(destinationPath)) {
      await scanDir(destinationPath);
    }

    console.log(`[Prescan] Complete: ${totalFiles} files scanned in ${((Date.now() - prescanStart) / 1000).toFixed(1)}s (${existingHashes.size} hashes, ${existingHeuristics.size} heuristics)`);
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
  const { files, destinationPath, zipPaths = {}, photoFormat = 'original' } = data;
  console.log(`[Fix] Starting copy: ${files.length} files to ${destinationPath}, format=${photoFormat}`);
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
  
  try {
    // mkdir BOTH the real destination (so robocopy has a parent
    // when mirroring) AND, when staging, the writeRoot is already
    // mkdir'd above. recursive:true is a no-op when the dir exists.
    if (!fs.existsSync(destinationPath)) {
      fs.mkdirSync(destinationPath, { recursive: true });
    }
    if (useStaging && writeRoot !== destinationPath && !fs.existsSync(writeRoot)) {
      fs.mkdirSync(writeRoot, { recursive: true });
    }

    // Snapshot pre-existing files at the REAL destination (not the
    // staging dir) so cross-run dedupe + collision resolution work
    // correctly even when this run is staging.
    const preExistingFiles = new Set<string>();
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
    console.log(`[Fix] Destination scan complete: ${preExistingFiles.size} existing files found`);

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
    }> = [];

    // Track actual completed files for accurate progress
    let completedFiles = 0;

    // Flush pending conversions via a freshly-forked child process.
    // The child receives the batch, runs sharp with controlled
    // parallelism, posts task-done messages back as each completes
    // (so the parent advances its progress bar in real time), then
    // exits cleanly. OS reclaims its heap + libvips pool on exit.
    const flushConversions = async () => {
      if (pendingConversions.length === 0) return;
      const batch = pendingConversions.splice(0, pendingConversions.length);
      console.log(`[Convert] Flushing batch of ${batch.length} conversions to a child process`);

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
        };
      }));

      // Resolve worker path. Production: bundled in extraResources/dist-electron.
      // Dev: alongside main.js inside dist-electron/.
      const workerPath = app.isPackaged
        ? path.join(process.resourcesPath, 'dist-electron/conversion-worker.cjs')
        : path.join(__dirname, 'conversion-worker.cjs');

      const child = utilityProcess.fork(workerPath, [], {
        // serviceName surfaces in Task Manager so the user (and
        // support) can see "PDR Image Conversion" rather than a
        // generic Electron Helper.
        serviceName: 'PDR Image Conversion',
        stdio: 'pipe',
      });

      // Forward child stdout/stderr to main.log so any sharp /
      // libvips warnings surface in support diagnostics rather
      // than being swallowed.
      child.stdout?.on('data', (chunk: Buffer) => {
        log.info(`[conversion-worker stdout] ${chunk.toString().trim()}`);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        log.warn(`[conversion-worker stderr] ${chunk.toString().trim()}`);
      });

      // Per-task results keyed by id, populated as the child posts
      // 'task-done' messages. The 'batch-done' message tells us when
      // every task has been posted (succeeded or failed).
      const childResults = new Map<number, {
        success: boolean;
        durationMs: number;
        error?: string;
        memUsage: { rssMB: number; heapUsedMB: number; externalMB: number };
      }>();

      let lastMemSnapshot: { rssMB: number; heapUsedMB: number; externalMB: number } | null = null;

      await new Promise<void>((resolve, reject) => {
        const onMessage = (msg: any) => {
          if (!msg || typeof msg !== 'object') return;
          if (msg.type === 'task-done') {
            childResults.set(msg.id, {
              success: msg.success,
              durationMs: msg.durationMs,
              error: msg.error,
              memUsage: msg.memUsage,
            });
            lastMemSnapshot = msg.memUsage;
            // Advance the progress bar live as each task lands.
            completedFiles++;
            if (mainWindow) {
              mainWindow.webContents.send('files:copy:progress', { current: completedFiles, total: files.length });
            }
          } else if (msg.type === 'batch-done') {
            log.info(`[Convert] Batch done — ${msg.succeeded}/${msg.total} succeeded, ${msg.failed} failed${lastMemSnapshot ? `, child mem rss=${lastMemSnapshot.rssMB} MB heap=${lastMemSnapshot.heapUsedMB} MB external=${lastMemSnapshot.externalMB} MB` : ''}`);
            // Don't resolve here — wait for 'exit' so we know the
            // child has actually freed its memory before we move on.
          } else if (msg.type === 'fatal-error') {
            log.error(`[Convert] Worker fatal: ${msg.message}`);
          }
        };
        child.on('message', onMessage);
        child.on('exit', (code) => {
          if (code !== 0) {
            log.warn(`[Convert] Worker exited with code ${code}`);
          }
          resolve();
        });
        child.postMessage({
          type: 'convert-batch',
          tasks: childTasks,
          perTaskTimeoutMs: 60_000,
          parallelism: 2,
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

      // Process results + EXIF + push to results
      for (let b = 0; b < batch.length; b++) {
        const task = batch[b];
        const result = batchResults[b];
        if (result.status === 'fulfilled') {
          console.log(`[Convert] Done: ${path.basename(task.convertedPath)}`);

          const targetExt = task.format === 'jpg' ? '.jpg' : '.png';
          task.file.newFilename = task.finalFilename.replace(/\.[^.]+$/, targetExt);
          usedFilenames.delete(path.join(task.subfolderPath, path.basename(task.destPath)).toLowerCase());
          usedFilenames.add(path.join(task.subfolderPath, task.file.newFilename).toLowerCase());

          // EXIF write immediately after writing to disk
          let exifWritten = false;
          let exifSource: string | undefined;
          let exifError: string | undefined;
          if (data.settings?.writeExif && task.file.derivedDate && task.file.dateConfidence) {
            const derivedDate = new Date(task.file.derivedDate);
            const exifResult = await writeExifDate(
              task.convertedPath,
              derivedDate,
              task.file.dateConfidence,
              task.file.dateSource || 'Unknown',
              {
                writeExif: data.settings.writeExif,
                exifWriteConfirmed: data.settings.exifWriteConfirmed ?? true,
                exifWriteRecovered: data.settings.exifWriteRecovered ?? true,
                exifWriteMarked: data.settings.exifWriteMarked ?? false,
              }
            );
            exifWritten = exifResult.written;
            exifSource = exifResult.source;
            if (!exifResult.success) exifError = exifResult.error;
          }

          results.push({
            success: true,
            sourcePath: task.file.sourcePath,
            destPath: task.convertedPath,
            finalFilename: task.file.newFilename,
            exifWritten,
            exifSource,
            exifError
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
          completedFiles++;
          if (mainWindow) mainWindow.webContents.send('files:copy:progress', { current: completedFiles, total: files.length });
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
            completedFiles++;
            if (mainWindow) mainWindow.webContents.send('files:copy:progress', { current: completedFiles, total: files.length });
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
      // disk when staging; same as before otherwise).
      await fs.promises.mkdir(targetDir, { recursive: true });
      
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
        completedFiles++;
        if (mainWindow) mainWindow.webContents.send('files:copy:progress', { current: completedFiles, total: files.length });
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

      let counter = 1;
      while (usedFilenames.has(path.join(subfolderPath, finalFilename).toLowerCase()) ||
             realDestFileExists(path.join(subfolderPath, finalFilename)) ||
             (convertedExt && usedFilenames.has(path.join(subfolderPath, baseName + convertedExt).toLowerCase())) ||
             (convertedExt && counter === 1 && realDestFileExists(path.join(subfolderPath, baseName + convertedExt)))) {
        finalFilename = `${baseName}_${String(counter).padStart(3, '0')}${ext}`;
        counter++;
      }
      usedFilenames.add(path.join(subfolderPath, finalFilename).toLowerCase());
      // Also reserve the converted filename to prevent future collisions
      if (convertedExt) {
        const convertedName = finalFilename.replace(/\.[^.]+$/, convertedExt);
        usedFilenames.add(path.join(subfolderPath, convertedName).toLowerCase());
      }
      
      const destPath = path.join(targetDir, finalFilename);
      
      try {
        // Determine the source data for this file
        const isZipWithBuffer = file.sourceType === 'zip' && fileBuffer;
        const isZipWithoutBuffer = file.sourceType === 'zip' && !fileBuffer;

        if (isZipWithoutBuffer) {
          results.push({ success: false, sourcePath: file.sourcePath, destPath, finalFilename, error: 'Entry not found in zip' });
          completedFiles++;
          if (mainWindow) mainWindow.webContents.send('files:copy:progress', { current: completedFiles, total: files.length });
          continue;
        }

        // If converting format, go directly from source → converted destination
        if (willConvert) {
          const targetExt = photoFormat === 'jpg' ? '.jpg' : '.png';
          const convertedPath = destPath.replace(/\.[^.]+$/, targetExt);
          console.log(`[Convert] Queuing ${path.basename(file.sourcePath)} → ${path.basename(convertedPath)}`);

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
          });

          // Flush when batch is full
          if (pendingConversions.length >= CONVERSION_BATCH_SIZE) {
            await flushConversions();
          }

          // Skip EXIF and results for now — handled after loop for converted files
          continue;
        } else {
          // No conversion needed — straight copy (compute hash during copy if needed)
          let copyHash: string | null = null;
          if (isZipWithBuffer) {
            if (skipDuplicates && useHashForThisFile) {
              copyHash = crypto.createHash('sha256').update(fileBuffer!).digest('hex');
            }
            fs.writeFileSync(destPath, fileBuffer!);
          } else {
            copyHash = await streamCopyFile(file.sourcePath, destPath, skipDuplicates && useHashForThisFile);
          }

          // Post-copy hash-based duplicate check (hash was computed during copy, zero extra I/O)
          if (skipDuplicates && useHashForThisFile && copyHash) {
            const existingFile = writtenHashes.get(copyHash);
            if (existingFile) {
              // Duplicate found — remove the just-written file
              try { await fs.promises.unlink(destPath); } catch {}
              const wasExisting = existingFile.startsWith('[existing] ');
              duplicatesRemoved++;
              duplicateFiles.push({
                filename: path.basename(file.sourcePath),
                duplicateOf: existingFile.replace('[existing] ', ''),
                duplicateMethod: 'hash',
                wasExisting
              });
              completedFiles++;
              if (mainWindow) mainWindow.webContents.send('files:copy:progress', { current: completedFiles, total: files.length });
              continue;
            }
            writtenHashes.set(copyHash, file.newFilename);
          }
        }

        console.log(`[Fix] File ${i + 1} copy+hash took ${Date.now() - fileStartTime}ms`);

        // Normalise extension (.jpeg → .jpg, .tiff → .tif) even if no format conversion
        if (photoFormat === 'original') {
          const srcExt = path.extname(destPath).toLowerCase();
          const normMap: Record<string, string> = { '.jpeg': '.jpg', '.tiff': '.tif' };
          if (normMap[srcExt]) {
            const normPath = destPath.replace(/\.[^.]+$/, normMap[srcExt]);
            try {
              await fs.promises.rename(destPath, normPath);
              finalFilename = finalFilename.replace(/\.[^.]+$/, normMap[srcExt]);
              usedFilenames.delete(path.join(subfolderPath, path.basename(destPath)).toLowerCase());
              usedFilenames.add(path.join(subfolderPath, finalFilename).toLowerCase());
              Object.defineProperty(file, '_convertedPath', { value: normPath });
            } catch {}
          }
        }

        // Resolve actual destPath for EXIF and results
        const actualDestPath = (file as any)._convertedPath || destPath;

        // Attempt EXIF write if enabled
        let exifWritten = false;
        let exifSource: string | undefined;
        let exifError: string | undefined;
        
        if (data.settings?.writeExif && file.derivedDate && file.dateConfidence) {
          const derivedDate = new Date(file.derivedDate);
          const exifResult = await writeExifDate(
            actualDestPath,
            derivedDate,
            file.dateConfidence,
            file.dateSource || 'Unknown',
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
        
        console.log(`[Fix] File ${i + 1} total took ${Date.now() - fileStartTime}ms (exif=${exifWritten})`);
        results.push({
          success: true,
          sourcePath: file.sourcePath,
          destPath: actualDestPath,
          finalFilename,
          exifWritten,
          exifSource,
          exifError
        });
        // Update progress for non-converted files
        completedFiles++;
        if (mainWindow) {
          mainWindow.webContents.send('files:copy:progress', { current: completedFiles, total: files.length });
        }
      } catch (err) {
        results.push({ success: false, sourcePath: file.sourcePath, destPath, finalFilename, error: (err as Error).message });
        completedFiles++;
        if (mainWindow) {
          mainWindow.webContents.send('files:copy:progress', { current: completedFiles, total: files.length });
        }
      }
      
    }

    // Flush any remaining queued conversions (EXIF is written inside flushConversions)
    await flushConversions();

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
    try {
      const usedTempDirs = new Set<string>();
      for (const tempDir of activeTempDirs) {
        const tempDirPrefix = tempDir + path.sep;
        for (const file of files) {
          const sp = file.sourcePath;
          if (sp === tempDir || (typeof sp === 'string' && sp.startsWith(tempDirPrefix))) {
            usedTempDirs.add(tempDir);
            break;
          }
        }
      }
      for (const tempDir of usedTempDirs) {
        console.log(`[Fix] Cleaning up extracted temp dir after successful copy: ${tempDir}`);
        cleanupTempDir(tempDir);
        activeTempDirs.delete(tempDir);
      }
    } catch (cleanupErr) {
      // Best-effort — never block the success return on a cleanup
      // glitch. Worst case: temp dir lingers until app quit.
      console.warn(`[Fix] Post-copy temp-dir cleanup encountered an error (continuing):`, cleanupErr);
    }

    return { success: true, results, copied: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, duplicatesRemoved, duplicateFiles, skippedExisting };
  } catch (error) {
    return { success: false, error: (error as Error).message, results, duplicatesRemoved, duplicateFiles };
  } finally {
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
    let licenceSummary = '(licence state unavailable)';
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
      licenceSummary = `(error fetching licence: ${(licErr as Error).message})`;
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
        '─── licence state ───',
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
      '─── licence state ───',
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
  // Run data integrity cleanup after database is ready
  if (result.success) {
    try {
      const cleanup = runDatabaseCleanup();
      if (cleanup.duplicateRunsRemoved > 0 || cleanup.duplicatesRemoved > 0 || cleanup.staleRemoved > 0 || cleanup.orphanRunsRemoved > 0 || cleanup.ghostRunsRemoved > 0) {
        console.log(`[Startup Cleanup] Removed: ${cleanup.duplicateRunsRemoved} duplicate runs, ${cleanup.ghostRunsRemoved} ghost runs, ${cleanup.orphanRunsRemoved} orphan runs, ${cleanup.duplicatesRemoved} duplicate files, ${cleanup.staleRemoved} stale files (checked ${cleanup.totalChecked} total)`);
      }
      // Send stale runs to renderer for user decision (relocate/reconnect/remove)
      if (cleanup.staleRuns.length > 0) {
        console.log(`[Startup] ${cleanup.staleRuns.length} indexed run(s) have missing destination folders — prompting user`);
        // Delay slightly to ensure window is ready
        setTimeout(() => {
          mainWindow?.webContents.send('search:staleRuns', cleanup.staleRuns);
        }, 2000);
      }
    } catch (err) {
      console.error('[Startup Cleanup] Error:', (err as Error).message);
    }
  }
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

    return result;
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:cancelIndex', async () => {
  cancelIndexing();
  return { success: true };
});

ipcMain.handle('search:removeRun', async (_event, runId: number) => {
  try {
    removeRun(runId);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:removeRunByReport', async (_event, reportId: string) => {
  try {
    removeRunByReportId(reportId);
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
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:cleanup', async () => {
  try {
    const result = runDatabaseCleanup();
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:relocateRun', async (_event, runId: number, newPath: string) => {
  try {
    const updated = relocateRun(runId, newPath);
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
    return { success: true, data: fav };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:favourites:delete', async (_event, id: number) => {
  try {
    deleteFavouriteFilter(id);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('search:favourites:rename', async (_event, id: number, name: string) => {
  try {
    renameFavouriteFilter(id, name);
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

let viewerWindow: BrowserWindow | null = null;

ipcMain.handle('search:openViewer', async (_event, filePaths: string[], fileNames: string[], startIndex?: number) => {
  try {
    // Support single or multiple files — pass as JSON-encoded array in query param
    const filesParam = JSON.stringify(filePaths);
    // Clamp the start index defensively so a bad caller can't open
    // the viewer at a non-existent slot.
    const start = (typeof startIndex === 'number' && startIndex >= 0 && startIndex < filePaths.length) ? startIndex : 0;
    const title = filePaths.length === 1
      ? fileNames[0] + ' — PDR Viewer'
      : `${start + 1} of ${filePaths.length} — PDR Viewer`;

    // If viewer already open, reuse it
    if (viewerWindow && !viewerWindow.isDestroyed()) {
      const viewerHtml = app.isPackaged
        ? path.join(process.resourcesPath, 'dist/public/viewer.html')
        : path.join(__dirname, '../dist/public/viewer.html');
      viewerWindow.loadFile(viewerHtml, { query: { files: filesParam, start: String(start) } });
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

    const viewerHtml = app.isPackaged
      ? path.join(process.resourcesPath, 'dist/public/viewer.html')
      : path.join(__dirname, '../dist/public/viewer.html');

    viewerWindow.loadFile(viewerHtml, { query: { files: filesParam, start: String(start) } });

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
    const result = refineFromVerifiedFaces(threshold, personFilter);
    // Rebuild FTS for all files whose faces were newly assigned
    const database = getDb();
    const personIds = result.perPerson.filter(p => p.matched > 0).map(p => p.personId);
    if (personIds.length > 0) {
      const placeholders = personIds.map(() => '?').join(',');
      const files = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE person_id IN (${placeholders})`).all(...personIds) as { file_id: number }[];
      for (const f of files) rebuildAiFts(f.file_id);
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
    // the original photo has been deleted by the user.
    const stillNeeded: typeof requests = [];
    await Promise.all(requests.map(async (r) => {
      const cachePath = path.join(faceCropCacheDir, faceCropCacheKey(r.file_path, r.box_x, r.box_y, r.box_w, r.box_h, size));
      try {
        if (fs.existsSync(cachePath)) {
          const buf = await fs.promises.readFile(cachePath);
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
        try {
          const metadata = await sharp(filePath, { failOnError: false }).rotate().metadata();
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
              const buffer = await sharp(filePath, { failOnError: false })
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
              fs.promises.writeFile(cachePath, buffer).catch(err =>
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
  try {
    if (fs.existsSync(cachePath)) {
      const buffer = await fs.promises.readFile(cachePath);
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
    const metadata = await sharp(filePath, { failOnError: false }).rotate().metadata();
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

    const buffer = await sharp(filePath, { failOnError: false })
      .rotate()
      .extract({ left: px, top: py, width: pw, height: ph })
      .resize(size, size, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Persist to the cache for next time. Best-effort — if the write
    // fails (disk full, permission denied) we still return the freshly
    // rendered crop so the current request succeeds.
    fs.promises.writeFile(cachePath, buffer).catch(err =>
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

ipcMain.handle('viewer:setRotation', async (_event, filePath: string, rotation: number) => {
  try {
    const { setUserRotation } = await import('./search-database.js');
    return { success: true, ...setUserRotation(filePath, rotation) };
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
      await fs.promises.mkdir(targetDir, { recursive: true });

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
});
