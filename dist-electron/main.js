import { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net, nativeImage } from 'electron';
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
log.transports.file.resolvePathFn = (vars) => path.join(app.getPath('appData'), 'Photo Date Rescue', 'logs', vars.fileName ?? 'main.log');
// Route stdlib console calls through electron-log so every existing
// console.log/warn/error in the codebase is captured without having
// to touch the call sites.
Object.assign(console, log.functions);
// ffmpeg-static is a CommonJS module; createRequire lets us require it from ESM.
const esmRequire = createRequire(import.meta.url);
let ffmpegPath = null;
try {
    ffmpegPath = esmRequire('ffmpeg-static');
    if (ffmpegPath && !fs.existsSync(ffmpegPath))
        ffmpegPath = null;
}
catch {
    ffmpegPath = null;
}
console.log('[ffmpeg] path =', ffmpegPath);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.3gp', '.mpg', '.mpeg']);
/**
 * Extract a single frame from a video using ffmpeg-static. Returns a JPEG buffer
 * suitable for piping into sharp. Seeks ~1s into the video to skip the usual
 * black/fade-in frame. Falls back to frame 0 if the video is shorter than 1s.
 */
async function extractVideoFrame(videoPath, seekSec = 1) {
    if (!ffmpegPath)
        return null;
    return new Promise((resolve) => {
        const tmp = path.join(os.tmpdir(), `pdr-vthumb-${crypto.randomBytes(6).toString('hex')}.jpg`);
        // -ss before -i is a fast seek; -frames:v 1 takes a single frame; -y overwrites
        const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(seekSec), '-i', videoPath, '-frames:v', '1', '-q:v', '3', '-y', tmp];
        const proc = spawn(ffmpegPath, args, { windowsHide: true });
        let finished = false;
        const done = async (ok) => {
            if (finished)
                return;
            finished = true;
            try {
                if (ok && fs.existsSync(tmp)) {
                    const buf = await fs.promises.readFile(tmp);
                    fs.promises.unlink(tmp).catch(() => { });
                    resolve(buf);
                    return;
                }
            }
            catch { }
            fs.promises.unlink(tmp).catch(() => { });
            resolve(null);
        };
        proc.on('error', () => done(false));
        proc.on('close', (code) => done(code === 0));
        // Safety timeout so hangs don't pile up
        setTimeout(() => { try {
            proc.kill('SIGKILL');
        }
        catch { } done(false); }, 15000);
    });
}
// Let sharp use default thread pool (number of CPU cores) for fast encoding
import { analyzeSource, cancelAnalysis } from './analysis-engine.js';
import AdmZip from 'adm-zip';
import * as unzipper from 'unzipper';
import crypto from 'crypto';
import { saveReport, loadReport, loadLatestReport, listReports, deleteReport, exportReportToCSV, exportReportToTXT, getExportFilename, writeCatalogue } from './report-storage.js';
import { getSettings, setSetting, setSettings, resetCriticalSettings } from './settings-store.js';
import { writeExifDate, shutdownExiftool } from './exif-writer.js';
import { getLicenseStatus, activateLicense, refreshLicense, deactivateLicense, getMachineFingerprint } from './license-manager.js';
import { checkForUpdates } from './update-checker.js';
import { classifySource, checkSameDriveWarning } from './source-classifier.js';
import { initDatabase, closeDatabase, searchFiles, getFilterOptions, getIndexStats, clearAllIndexData, removeRun, removeRunByReportId, listRuns, getMemoriesYearMonthBuckets, getMemoriesOnThisDay, getMemoriesDayFiles, saveFavouriteFilter, listFavouriteFilters, deleteFavouriteFilter, renameFavouriteFilter, } from './search-database.js';
import { indexFixRun, cancelIndexing, shutdownIndexerExiftool } from './search-indexer.js';
import { loadReport as loadReportForIndex } from './report-storage.js';
import { startAiProcessing, cancelAiProcessing, pauseAiProcessing, resumeAiProcessing, isAiPaused, shutdownAiWorker, isAiProcessing, areModelsDownloaded, setMainWindow as setAiMainWindow, runFaceClustering, } from './ai-manager.js';
import { listPersons, upsertPerson, assignPersonToCluster, assignPersonToFace, unnameFace, renamePerson, mergePersons, deletePerson, permanentlyDeletePerson, unnamePersonAndDelete, restoreUnnamedPerson, restorePerson, listDiscardedPersons, getPersonById, getVisualSuggestions, getClusterFaceCount, getFacesForFile, getAiTagsForFile, getAiTagOptions, getAiStats, clearAllAiData, resetAllTagAnalysis, getUnprocessedFileIds, listSavedTrees, getSavedTree, createSavedTree, updateSavedTree, deleteSavedTree, toggleHiddenAncestor, undoLastGraphOperation, redoGraphOperation, getGraphHistoryCounts, listGraphHistoryEntries, revertToGraphHistoryEntry, rebuildAiFts, getPersonClusters, getClusterFaces, getPersonsWithCooccurrence, cleanupOrphanedPersons, runDatabaseCleanup, relocateRun, addRelationship, updateRelationship, removeRelationship, listRelationshipsForPerson, listAllRelationships, updatePersonLifeEvents, setPersonCardBackground, setPersonGender, getFamilyGraph, getPersonCooccurrenceStats, getPartnerSuggestionScores, createPlaceholderPerson, createNamedPerson, namePlaceholder, mergePlaceholderIntoPerson, removePlaceholder, } from './search-database.js';
// Update checking
ipcMain.handle('updates:check', async () => {
    return await checkForUpdates();
});
ipcMain.handle('updates:getVersion', () => {
    return app.getVersion();
});
// Storage classification
ipcMain.handle('storage:classify', async (_event, sourcePath) => {
    return classifySource(sourcePath);
});
ipcMain.handle('storage:checkSameDrive', async (_event, sourcePath, outputPath) => {
    return checkSameDriveWarning(sourcePath, outputPath);
});
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let mainWindow = null;
// Yield to event loop to keep UI responsive
function yieldToEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
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
function runRobocopyMirror(stagingDir, realDest, onFileCopied, abortSignal) {
    return new Promise((resolve) => {
        const args = [stagingDir, realDest, '/E', '/MT:16', '/R:2', '/W:5', '/NP', '/NDL', '/NJH', '/NJS'];
        const child = spawn('robocopy', args, { windowsHide: true });
        let stderrBuf = '';
        let leftover = '';
        const checkAbort = setInterval(() => {
            if (abortSignal.cancelled && !child.killed) {
                try {
                    child.kill();
                }
                catch { /* already dead */ }
            }
        }, 250);
        child.stdout?.on('data', (chunk) => {
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
        child.stderr?.on('data', (chunk) => {
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
async function streamCopyFile(src, dest, computeHash = false) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            readStream.destroy();
            writeStream.destroy();
            reject(new Error(`Copy timeout: ${path.basename(src)}`));
        }, 120000); // 2 min timeout per file
        const readStream = fs.createReadStream(src, { highWaterMark: 64 * 1024 });
        const writeStream = fs.createWriteStream(dest);
        const hashObj = computeHash ? crypto.createHash('sha256') : null;
        readStream.on('data', (chunk) => { if (hashObj)
            hashObj.update(chunk); });
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
                color: '#a99cff', // Primary lavender — matches ribbon tab bar
                symbolColor: '#ffffff', // White window controls
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
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.setZoomFactor(1.0);
        // Pre-warm the People Manager window in the background. We wait
        // ~4 seconds after the main window finishes loading so the user's
        // first impression isn't slowed down by an extra renderer
        // boot. By the time most users have decided which folder to add
        // as a source, PM is already invisibly mounted and ready — when
        // they later click the People icon it shows instantly. RAM cost
        // is ~150 MB while PDR is open; the speed payoff for power users
        // (especially after auto-process AI runs) outweighs it.
        setTimeout(() => {
            try {
                prewarmPeopleWindow();
            }
            catch { /* best-effort */ }
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
                    }
                    else if (pendingTags > 0) {
                        console.log('[AI] Auto-starting tags-only processing (resuming previous re-analyze)...');
                        await startAiProcessing({ tagsOnly: true });
                    }
                    else {
                        console.log('[AI] Nothing pending, no auto-start needed');
                    }
                    console.log('[AI] Auto-start completed or in progress');
                }
                catch (err) {
                    console.error('[AI] Auto-start FAILED:', err);
                }
            }, 3000);
        }
        else if (settings.aiEnabled && !areModelsDownloaded()) {
            console.log('[AI] AI enabled but models not downloaded — waiting for user to trigger download');
        }
    });
    // Block Electron's native zoom shortcuts — our renderer handles zoom via IPC
    // Allow F12 and Ctrl+Shift+I to open DevTools
    mainWindow.webContents.on('before-input-event', (_event, input) => {
        if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
            mainWindow?.webContents.toggleDevTools();
            return;
        }
        if (input.control && (input.key === '=' || input.key === '+' || input.key === '-' || input.key === '0')) {
            _event.preventDefault();
        }
    });
    // Track whether a fix operation is in progress
    let fixInProgress = false;
    ipcMain.handle('fix:setInProgress', (_event, inProgress) => {
        fixInProgress = inProgress;
    });
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
        }
        else {
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
function getUnrarPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'bin', 'UnRAR.exe');
    }
    return path.join(__dirname, 'bin', 'UnRAR.exe');
}
function isRarFile(filePath) {
    return path.extname(filePath).toLowerCase() === '.rar';
}
function generateRarTempDirName(rarPath) {
    const hash = crypto.createHash('md5').update(rarPath).digest('hex').substring(0, 8);
    const baseName = path.basename(rarPath, path.extname(rarPath));
    return path.join(PDR_TEMP_ROOT, `${baseName}_${hash}`);
}
async function extractRar(rarPath, tempDir, onProgress) {
    fs.mkdirSync(tempDir, { recursive: true });
    onProgress?.('Unpacking RAR archive...', 0, 0);
    const unrarPath = getUnrarPath();
    return new Promise((resolve, reject) => {
        const args = ['x', '-o+', '-y', rarPath, tempDir + path.sep];
        const child = execFile(unrarPath, args, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`UnRAR extraction failed: ${error.message}\n${stderr}`));
            }
            else {
                onProgress?.('RAR archive unpacked', 0, 0);
                resolve();
            }
        });
        let lineCount = 0;
        child.stdout?.on('data', (data) => {
            const lines = data.toString().split('\n').filter((l) => l.trim());
            lineCount += lines.length;
            if (lineCount % 50 === 0) {
                onProgress?.(`Unpacking... ${lineCount} entries extracted`, 0, 0);
            }
        });
    });
}
// --- Large ZIP auto-extraction helpers ---
const PDR_TEMP_ROOT = path.join(app.getPath('temp'), 'PDR_Temp');
function cleanupOrphanedTempDirs() {
    try {
        if (fs.existsSync(PDR_TEMP_ROOT)) {
            const entries = fs.readdirSync(PDR_TEMP_ROOT);
            for (const entry of entries) {
                const fullPath = path.join(PDR_TEMP_ROOT, entry);
                try {
                    fs.rmSync(fullPath, { recursive: true, force: true });
                }
                catch {
                    // Ignore cleanup errors for locked files
                }
            }
            // Remove root if empty
            try {
                const remaining = fs.readdirSync(PDR_TEMP_ROOT);
                if (remaining.length === 0) {
                    fs.rmdirSync(PDR_TEMP_ROOT);
                }
            }
            catch { }
        }
    }
    catch {
        // Ignore cleanup errors on startup
    }
}
function cleanupTempDir(tempDir) {
    try {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
    catch {
        // Best-effort cleanup
    }
}
function getZipFileSize(zipPath) {
    try {
        const stats = fs.statSync(zipPath);
        return stats.size;
    }
    catch {
        return 0;
    }
}
function generateTempDirName(zipPath) {
    const hash = crypto.createHash('md5').update(zipPath).digest('hex').substring(0, 8);
    const baseName = path.basename(zipPath, '.zip');
    return path.join(PDR_TEMP_ROOT, `${baseName}_${hash}`);
}
async function extractLargeZip(zipPath, tempDir, onProgress) {
    fs.mkdirSync(tempDir, { recursive: true });
    onProgress?.('Unpacking ZIP archive...', 0, 0);
    const directory = await unzipper.Open.file(zipPath);
    const totalEntries = directory.files.length;
    let extracted = 0;
    for (const file of directory.files) {
        if (file.type === 'Directory')
            continue;
        const outputPath = path.join(tempDir, file.path);
        const outputDir = path.dirname(outputPath);
        fs.mkdirSync(outputDir, { recursive: true });
        await new Promise((resolve, reject) => {
            file.stream()
                .pipe(fs.createWriteStream(outputPath))
                .on('finish', resolve)
                .on('error', reject);
        });
        extracted++;
        if (extracted % 50 === 0) {
            onProgress?.(`Unpacking... ${extracted.toLocaleString()} of ${totalEntries.toLocaleString()} entries`, extracted, totalEntries);
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    onProgress?.(`Unpacked ${extracted.toLocaleString()} entries`, extracted, totalEntries);
}
// Track active temp dirs so we can clean up on cancel/quit
const activeTempDirs = new Set();
// Register custom protocol for serving local files to viewer
protocol.registerSchemesAsPrivileged([
    { scheme: 'pdr-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);
app.whenReady().then(() => {
    // Surface the log file path at startup so users hitting crashes can
    // find the file without digging through %APPDATA%. Also makes it
    // trivial to copy the path from the log itself if the user already
    // has an older copy open.
    try {
        const logPath = log.transports.file.getFile().path;
        log.info(`[log] file: ${logPath}`);
        log.info(`[log] app version ${app.getVersion()} starting on ${process.platform} ${os.release()}`);
    }
    catch { }
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
            }
            else {
                // Legacy: strip the scheme + leading slashes from the path component.
                let p = u.pathname;
                while (p.startsWith('/'))
                    p = p.substring(1);
                raw = decodeURI(p);
            }
        }
        catch {
            raw = request.url.replace(/^pdr-file:\/\//i, '');
            while (raw.startsWith('/'))
                raw = raw.substring(1);
            try {
                raw = decodeURI(raw);
            }
            catch { }
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
    resetCriticalSettings();
    cleanupOrphanedTempDirs();
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
    // Clean up any active temp extraction directories
    for (const tempDir of activeTempDirs) {
        cleanupTempDir(tempDir);
    }
    activeTempDirs.clear();
    await shutdownExiftool();
    await shutdownIndexerExiftool();
    closeDatabase();
});
ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        defaultPath: 'C:\\'
    });
    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }
    return result.filePaths[0];
});
ipcMain.handle('dialog:openZip', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'ZIP/RAR Archives', extensions: ['zip', 'rar'] }],
        defaultPath: 'C:\\'
    });
    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }
    return result.filePaths[0];
});
ipcMain.handle('source:pick', async (_event, mode) => {
    let result;
    if (mode === 'folder') {
        result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory'],
            defaultPath: 'C:\\'
        });
    }
    else {
        result = await dialog.showOpenDialog(mainWindow, {
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
    const result = await dialog.showOpenDialog(mainWindow, {
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
ipcMain.handle('show-message', async (event, title, message) => {
    await dialog.showMessageBox({
        type: 'info',
        title: title,
        message: message,
        buttons: ['OK']
    });
});
ipcMain.handle('shell:openFolder', async (_event, folderPath) => {
    try {
        const normalizedPath = path.normalize(folderPath);
        await shell.openPath(normalizedPath);
    }
    catch (error) {
        console.error('Error opening folder:', error);
    }
});
ipcMain.handle('shell:openExternal', async (_event, url) => {
    try {
        await shell.openExternal(url);
    }
    catch (error) {
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
ipcMain.handle('disk:getSpace', async (_event, directoryPath) => {
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
        }
        else if (process.platform === 'win32') {
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
            }
            catch {
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
                }
                catch {
                    console.error('[Disk] Both PowerShell and wmic failed for drive', driveLetter);
                }
            }
        }
        return { freeBytes: 0, totalBytes: 0 };
    }
    catch (error) {
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
            const output = await new Promise((resolve, reject) => {
                execFile('powershell.exe', [
                    '-NoProfile', '-NonInteractive', '-Command',
                    `Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,DriveType,Size,FreeSpace | ConvertTo-Csv -NoTypeInformation`
                ], { encoding: 'utf8', timeout: 10000 }, (error, stdout) => {
                    if (error)
                        reject(error);
                    else
                        resolve(stdout);
                });
            });
            const lines = output.trim().split('\n').filter(l => l.trim());
            if (lines.length < 2)
                return [];
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
    }
    catch (error) {
        console.error('Error listing drives:', error);
        return [];
    }
});
// Thumbnail cache directory
const thumbCacheDir = path.join(app.getPath('userData'), 'thumb-cache');
fs.mkdirSync(thumbCacheDir, { recursive: true });
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
const transcodeInFlight = new Map();
async function transcodeVideoToMp4(sourcePath, cachePath) {
    if (!ffmpegPath)
        return { success: false, error: 'ffmpeg binary not found' };
    return new Promise((resolve) => {
        // Write to a .part file first so a crashed transcode doesn't leave a half-written cache entry.
        const partPath = cachePath + '.part';
        try {
            if (fs.existsSync(partPath))
                fs.unlinkSync(partPath);
        }
        catch { }
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
        const proc = spawn(ffmpegPath, args, { windowsHide: true });
        let stderr = '';
        proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
        let finished = false;
        const done = (ok, err) => {
            if (finished)
                return;
            finished = true;
            if (ok) {
                try {
                    fs.renameSync(partPath, cachePath);
                    resolve({ success: true, cachePath });
                    return;
                }
                catch (e) {
                    resolve({ success: false, error: e.message });
                    return;
                }
            }
            try {
                if (fs.existsSync(partPath))
                    fs.unlinkSync(partPath);
            }
            catch { }
            resolve({ success: false, error: err || stderr || 'ffmpeg failed' });
        };
        proc.on('error', (e) => done(false, e.message));
        proc.on('close', (code) => done(code === 0));
    });
}
ipcMain.handle('video:prepare', async (_event, filePath) => {
    try {
        if (!fs.existsSync(filePath))
            return { success: false, error: 'File not found' };
        const ext = path.extname(filePath).toLowerCase();
        // Normalised pdr-file:// URL the renderer uses for direct playback.
        // Chromium's URL parser mangles 'C:' drive letters even with three slashes
        // because pdr-file is registered as a 'standard' scheme — it tries to
        // parse the path as host:port and silently drops the colon. We dodge that
        // by putting the path in a query parameter, which is never host-parsed.
        const toPdrUrl = (p) => 'pdr-file://local/?f=' + encodeURIComponent(p.replace(/\\/g, '/'));
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
        if (!result.success || !result.cachePath)
            return { success: false, error: result.error };
        return { success: true, playableUrl: toPdrUrl(result.cachePath), cachePath: result.cachePath };
    }
    catch (e) {
        return { success: false, error: e.message };
    }
});
ipcMain.handle('browser:thumbnail', async (_event, filePath, size) => {
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
        let jpegBuffer = null;
        const ext = path.extname(filePath).toLowerCase();
        // Video: extract a frame via ffmpeg-static, then resize through sharp.
        if (VIDEO_EXTS.has(ext)) {
            try {
                // Try 1s in first; short clips / MPEG-1 files may fail that seek, so retry at 0.
                let frame = await extractVideoFrame(filePath, 1);
                if (!frame)
                    frame = await extractVideoFrame(filePath, 0);
                if (frame) {
                    jpegBuffer = await sharp(frame, { failOnError: false })
                        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
                        .jpeg({ quality: 80 })
                        .toBuffer();
                }
                else {
                    console.warn('[ffmpeg] no frame extracted for', filePath);
                }
            }
            catch (e) {
                console.warn('[ffmpeg] frame→sharp failed for', filePath, e.message);
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
            }
            catch {
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
                    }
                    catch {
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
        fs.promises.writeFile(cachePath, jpegBuffer).catch(() => { });
        return { success: true, dataUrl: `data:image/jpeg;base64,${jpegBuffer.toString('base64')}` };
    }
    catch {
        return { success: false, dataUrl: '' };
    }
});
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.rar']);
ipcMain.handle('browser:readDirectory', async (_event, dirPath, fileFilter) => {
    try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        const items = [];
        for (const entry of entries) {
            // Skip hidden/system files
            if (entry.name.startsWith('.') || entry.name.startsWith('$'))
                continue;
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
                }
                catch {
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
            }
            catch { /* leave zero */ }
            if (fileFilter === 'archives') {
                // In archive mode: show folders + archive files only
                if (isDir || isArchive) {
                    items.push({ name: entry.name, path: fullPath, isDirectory: isDir, isImage: false, isArchive, sizeBytes: isArchive ? sizeBytes : 0, hasSubfolders, modifiedAt });
                }
            }
            else if (fileFilter === 'source') {
                // Source mode: show folders + images + archives
                if (isDir || isImage || isArchive) {
                    items.push({ name: entry.name, path: fullPath, isDirectory: isDir, isImage, isArchive, sizeBytes: (isArchive || isImage) ? sizeBytes : 0, hasSubfolders, modifiedAt });
                }
            }
            else {
                // Default mode: show folders + image files
                if (isDir || isImage) {
                    items.push({ name: entry.name, path: fullPath, isDirectory: isDir, isImage, isArchive: false, sizeBytes: isImage ? sizeBytes : 0, hasSubfolders, modifiedAt });
                }
            }
        }
        // Folders first, then files, both alphabetical
        items.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory)
                return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        return { success: true, items };
    }
    catch (error) {
        return { success: false, items: [], error: error.code === 'EPERM' || error.code === 'EACCES' ? 'Access denied — you don\'t have permission to view this folder.' : `Unable to read this folder: ${error.message}` };
    }
});
ipcMain.handle('browser:createDirectory', async (_event, dirPath) => {
    try {
        fs.mkdirSync(dirPath, { recursive: true });
        return { success: true };
    }
    catch (error) {
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
function isMediaFileForPreScan(filename) {
    const ext = path.extname(filename).toLowerCase();
    if (PHOTO_EXTENSIONS_PRESCAN.has(ext))
        return 'photo';
    if (VIDEO_EXTENSIONS_PRESCAN.has(ext))
        return 'video';
    return null;
}
let preScanCancelled = false;
ipcMain.handle('prescan:cancel', async () => {
    preScanCancelled = true;
    return { success: true };
});
ipcMain.handle('prescan:run', async (_event, sourcePath, sourceType, noTimeout = false) => {
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
                        if (mediaType === 'photo')
                            photoCount++;
                        else
                            videoCount++;
                        if (fileCount % 100 === 0) {
                            sendProgress();
                            await new Promise(resolve => setImmediate(resolve));
                        }
                    }
                }
            }
        }
        else {
            const scanDirectory = async (dirPath) => {
                if (preScanCancelled)
                    return;
                if (timedOut)
                    return;
                // Check timeout at directory entry
                if (Date.now() - startTime > TIMEOUT_MS) {
                    timedOut = true;
                    sendProgress();
                    return;
                }
                let entries;
                try {
                    // Use async readdir to avoid blocking
                    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
                }
                catch (err) {
                    return;
                }
                // Yield after directory read to keep UI responsive
                await new Promise(resolve => setImmediate(resolve));
                for (const entry of entries) {
                    if (preScanCancelled)
                        return;
                    if (timedOut)
                        return;
                    if (Date.now() - startTime > TIMEOUT_MS) {
                        timedOut = true;
                        sendProgress();
                        return;
                    }
                    const fullPath = path.join(dirPath, entry.name);
                    if (entry.isDirectory()) {
                        await scanDirectory(fullPath);
                    }
                    else {
                        const mediaType = isMediaFileForPreScan(entry.name);
                        if (mediaType) {
                            fileCount++;
                            if (mediaType === 'photo')
                                photoCount++;
                            else
                                videoCount++;
                            try {
                                // Use async stat to avoid blocking
                                const stats = await fs.promises.stat(fullPath);
                                totalBytes += stats.size;
                            }
                            catch (err) {
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
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
ipcMain.handle('report:delete', async (_event, reportId) => {
    try {
        const success = await deleteReport(reportId);
        return { success };
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
ipcMain.handle('analysis:cancel', async () => {
    cancelAnalysis();
    return { success: true };
});
ipcMain.handle('analysis:run', async (_event, sourcePath, sourceType) => {
    let tempDir = null;
    try {
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
        }
        else if (sourceType === 'zip' && getZipFileSize(sourcePath) > LARGE_ZIP_THRESHOLD) {
            tempDir = generateTempDirName(sourcePath);
            activeTempDirs.add(tempDir);
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
        const results = await analyzeSource(effectivePath, effectiveType, (progress) => {
            mainWindow?.webContents.send('analysis:progress', progress);
        });
        // Preserve original source path in the results so copy phase knows where to find the ZIP
        if (tempDir) {
            results.sourcePath = sourcePath;
            results.sourceType = 'zip';
            results._extractedTempDir = tempDir;
        }
        // NOTE: Do NOT clean up temp dir here — the extracted files are needed
        // during the copy/fix phase. Cleanup happens in files:copy or on app quit.
        return { success: true, data: results };
    }
    catch (error) {
        // Clean up temp dir on failure
        if (tempDir) {
            cleanupTempDir(tempDir);
            activeTempDirs.delete(tempDir);
        }
        if (error.message === 'ANALYSIS_CANCELLED') {
            return { success: false, cancelled: true, error: 'Analysis cancelled by user' };
        }
        return { success: false, error: error.message };
    }
});
function calculateFileHashAsync(filePath, timeoutMs = 30000) {
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
function calculateBufferHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}
ipcMain.handle('report:save', async (_event, reportData) => {
    try {
        const savedReport = await saveReport(reportData);
        // Auto-catalogue: write cumulative PDR_Catalogue.csv/txt to destination root
        const settings = getSettings();
        console.log('[Catalogue] autoSaveCatalogue:', settings.autoSaveCatalogue, 'destinationPath:', savedReport.destinationPath);
        if (settings.autoSaveCatalogue && savedReport.destinationPath) {
            try {
                const catResult = await writeCatalogue(savedReport.destinationPath);
                console.log('[Catalogue] Write result:', catResult);
            }
            catch (catErr) {
                console.error('[Catalogue] Write failed (non-fatal):', catErr);
            }
        }
        else {
            console.log('[Catalogue] Skipped — setting off or no destination');
        }
        return { success: true, data: savedReport };
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
// Scan destination for existing files and their hashes (for cross-run duplicate detection)
ipcMain.handle('destination:prescan', async (_event, destinationPath) => {
    try {
        console.log(`[Prescan] Starting destination prescan: ${destinationPath}`);
        const prescanStart = Date.now();
        const settings = getSettings();
        const useHash = settings.thoroughDuplicateMatching;
        console.log(`[Prescan] thoroughDuplicateMatching=${useHash}`);
        const existingHashes = new Map(); // hash -> filename
        const existingHeuristics = new Map(); // "filename|size" -> filename
        let totalFiles = 0;
        const LARGE_FILE_THRESHOLD = 500 * 1024 * 1024;
        const scanDir = async (dirPath) => {
            let entries;
            try {
                entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    await scanDir(fullPath);
                }
                else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    const isMedia = PHOTO_EXTENSIONS_PRESCAN.has(ext) || VIDEO_EXTENSIONS_PRESCAN.has(ext);
                    if (!isMedia)
                        continue;
                    totalFiles++;
                    try {
                        const stats = await fs.promises.stat(fullPath);
                        if (!useHash) {
                            // Heuristic mode: just filename + size (fast)
                            const heuristicKey = `${entry.name}|${stats.size}`;
                            existingHeuristics.set(heuristicKey, entry.name);
                        }
                        else if (stats.size > LARGE_FILE_THRESHOLD) {
                            // Hash mode but file too large: heuristic fallback
                            const heuristicKey = `${entry.name}|${stats.size}`;
                            existingHeuristics.set(heuristicKey, entry.name);
                        }
                        else {
                            // Hash mode: compute SHA-256 (async with timeout)
                            const hash = await calculateFileHashAsync(fullPath);
                            if (hash) {
                                existingHashes.set(hash, entry.name);
                            }
                        }
                    }
                    catch {
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
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
let copyFilesCancelled = false;
ipcMain.handle('files:copy:cancel', async () => {
    copyFilesCancelled = true;
    return { success: true };
});
ipcMain.handle('files:copy', async (_event, data) => {
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
    let stagingPath = null;
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
        try {
            return getSettings().networkUploadMode || 'fast';
        }
        catch {
            return 'fast';
        }
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
                }
                catch (mkErr) {
                    console.warn(`[Fix] Staging mkdir failed; falling back to direct copy:`, mkErr);
                }
            }
        }
        catch (clsErr) {
            console.warn(`[Fix] classifySource failed for destination; assuming local:`, clsErr);
        }
    }
    const results = [];
    const zipCache = {};
    const usedFilenames = new Set();
    // GLOBAL write-time deduplication registry (supersedes analysis flags)
    const writtenHashes = new Map(); // hash -> first written filename
    const writtenHeuristics = new Map(); // "filename|size" -> first written filename
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
    const duplicateFiles = [];
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
        const preExistingFiles = new Set();
        const scanForExisting = async (dirPath, relativePath = '') => {
            try {
                const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        await scanForExisting(path.join(dirPath, entry.name), path.join(relativePath, entry.name));
                    }
                    else if (entry.isFile()) {
                        preExistingFiles.add(path.join(relativePath, entry.name).toLowerCase());
                    }
                }
            }
            catch { }
        };
        await scanForExisting(destinationPath);
        console.log(`[Fix] Destination scan complete: ${preExistingFiles.size} existing files found`);
        // Helper: does a relative path collide with a file at the REAL
        // destination? When staging, fs.existsSync would probe the empty
        // staging tree (wrong answer); use the snapshot instead. When
        // not staging, keep behavior identical to pre-staging code by
        // hitting the live filesystem.
        const realDestFileExists = (relPath) => {
            if (useStaging) {
                return preExistingFiles.has(relPath.toLowerCase());
            }
            return fs.existsSync(path.join(destinationPath, relPath));
        };
        // Cache source classifications to avoid running 'net use' subprocess per file
        const sourceClassificationCache = new Map();
        const getSourceClassification = (sourcePath) => {
            if (!sourceClassificationCache.has(sourcePath)) {
                try {
                    sourceClassificationCache.set(sourcePath, classifySource(sourcePath));
                }
                catch {
                    sourceClassificationCache.set(sourcePath, { type: 'unknown', speed: 'medium', label: 'Unknown', description: '', isOptimal: false });
                }
            }
            return sourceClassificationCache.get(sourcePath);
        };
        // Queue for parallel PNG/JPG conversions
        const CONVERSION_BATCH_SIZE = 6;
        const pendingConversions = [];
        // Track actual completed files for accurate progress
        let completedFiles = 0;
        // Flush pending conversions in parallel batches
        const flushConversions = async () => {
            if (pendingConversions.length === 0)
                return;
            const batch = pendingConversions.splice(0, pendingConversions.length);
            console.log(`[Convert] Flushing batch of ${batch.length} conversions in parallel`);
            const batchResults = await Promise.allSettled(batch.map(async (task) => {
                const conversionPromise = task.format === 'jpg'
                    ? sharp(task.sourceInput).jpeg({ quality: 92 }).toFile(task.convertedPath)
                    : sharp(task.sourceInput).png({ compressionLevel: 6, effort: 1 }).toFile(task.convertedPath);
                await Promise.race([
                    conversionPromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Conversion timeout')), 60000))
                ]);
            }));
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
                    let exifSource;
                    let exifError;
                    if (data.settings?.writeExif && task.file.derivedDate && task.file.dateConfidence) {
                        const derivedDate = new Date(task.file.derivedDate);
                        const exifResult = await writeExifDate(task.convertedPath, derivedDate, task.file.dateConfidence, task.file.dateSource || 'Unknown', {
                            writeExif: data.settings.writeExif,
                            exifWriteConfirmed: data.settings.exifWriteConfirmed ?? true,
                            exifWriteRecovered: data.settings.exifWriteRecovered ?? true,
                            exifWriteMarked: data.settings.exifWriteMarked ?? false,
                        });
                        exifWritten = exifResult.written;
                        exifSource = exifResult.source;
                        if (!exifResult.success)
                            exifError = exifResult.error;
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
                }
                else {
                    console.warn(`[Convert] Failed: ${path.basename(task.destPath)}:`, result.reason);
                    results.push({
                        success: false,
                        sourcePath: task.file.sourcePath,
                        destPath: task.destPath,
                        finalFilename: task.finalFilename,
                        error: result.reason?.message || 'Conversion failed'
                    });
                }
                // Update progress for each completed conversion
                completedFiles++;
                if (mainWindow) {
                    mainWindow.webContents.send('files:copy:progress', { current: completedFiles, total: files.length });
                }
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
            let fileBuffer = null;
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
            }
            else {
                try {
                    const stats = await fs.promises.stat(file.sourcePath);
                    fileSize = stats.size;
                }
                catch {
                    results.push({ success: false, sourcePath: file.sourcePath, destPath: '', finalFilename: file.newFilename, error: 'File not found' });
                    completedFiles++;
                    if (mainWindow)
                        mainWindow.webContents.send('files:copy:progress', { current: completedFiles, total: files.length });
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
                        if (mainWindow)
                            mainWindow.webContents.send('files:copy:progress', { current: completedFiles, total: files.length });
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
                }
                else if (data.folderStructure === 'year-month') {
                    subfolderPath = path.join(year, month);
                }
                else if (data.folderStructure === 'year-month-day') {
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
                if (mainWindow)
                    mainWindow.webContents.send('files:copy:progress', { current: completedFiles, total: files.length });
                continue;
            }
            // When converting formats, also check for collisions against the target extension
            // e.g., IMG_001.jpg and IMG_001.tif would both become IMG_001.png
            const willConvert = photoFormat !== 'original' && (() => {
                const srcExt = path.extname(finalFilename).toLowerCase();
                const photoExts = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp', '.heic', '.heif', '.gif', '.avif']);
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
                    if (mainWindow)
                        mainWindow.webContents.send('files:copy:progress', { current: completedFiles, total: files.length });
                    continue;
                }
                // If converting format, go directly from source → converted destination
                if (willConvert) {
                    const targetExt = photoFormat === 'jpg' ? '.jpg' : '.png';
                    const convertedPath = destPath.replace(/\.[^.]+$/, targetExt);
                    console.log(`[Convert] Queuing ${path.basename(file.sourcePath)} → ${path.basename(convertedPath)}`);
                    const sourceInput = isZipWithBuffer ? fileBuffer : file.sourcePath;
                    pendingConversions.push({
                        sourceInput,
                        convertedPath,
                        format: photoFormat,
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
                }
                else {
                    // No conversion needed — straight copy (compute hash during copy if needed)
                    let copyHash = null;
                    if (isZipWithBuffer) {
                        if (skipDuplicates && useHashForThisFile) {
                            copyHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
                        }
                        fs.writeFileSync(destPath, fileBuffer);
                    }
                    else {
                        copyHash = await streamCopyFile(file.sourcePath, destPath, skipDuplicates && useHashForThisFile);
                    }
                    // Post-copy hash-based duplicate check (hash was computed during copy, zero extra I/O)
                    if (skipDuplicates && useHashForThisFile && copyHash) {
                        const existingFile = writtenHashes.get(copyHash);
                        if (existingFile) {
                            // Duplicate found — remove the just-written file
                            try {
                                await fs.promises.unlink(destPath);
                            }
                            catch { }
                            const wasExisting = existingFile.startsWith('[existing] ');
                            duplicatesRemoved++;
                            duplicateFiles.push({
                                filename: path.basename(file.sourcePath),
                                duplicateOf: existingFile.replace('[existing] ', ''),
                                duplicateMethod: 'hash',
                                wasExisting
                            });
                            completedFiles++;
                            if (mainWindow)
                                mainWindow.webContents.send('files:copy:progress', { current: completedFiles, total: files.length });
                            continue;
                        }
                        writtenHashes.set(copyHash, file.newFilename);
                    }
                }
                console.log(`[Fix] File ${i + 1} copy+hash took ${Date.now() - fileStartTime}ms`);
                // Normalise extension (.jpeg → .jpg, .tiff → .tif) even if no format conversion
                if (photoFormat === 'original') {
                    const srcExt = path.extname(destPath).toLowerCase();
                    const normMap = { '.jpeg': '.jpg', '.tiff': '.tif' };
                    if (normMap[srcExt]) {
                        const normPath = destPath.replace(/\.[^.]+$/, normMap[srcExt]);
                        try {
                            await fs.promises.rename(destPath, normPath);
                            finalFilename = finalFilename.replace(/\.[^.]+$/, normMap[srcExt]);
                            usedFilenames.delete(path.join(subfolderPath, path.basename(destPath)).toLowerCase());
                            usedFilenames.add(path.join(subfolderPath, finalFilename).toLowerCase());
                            Object.defineProperty(file, '_convertedPath', { value: normPath });
                        }
                        catch { }
                    }
                }
                // Resolve actual destPath for EXIF and results
                const actualDestPath = file._convertedPath || destPath;
                // Attempt EXIF write if enabled
                let exifWritten = false;
                let exifSource;
                let exifError;
                if (data.settings?.writeExif && file.derivedDate && file.dateConfidence) {
                    const derivedDate = new Date(file.derivedDate);
                    const exifResult = await writeExifDate(actualDestPath, derivedDate, file.dateConfidence, file.dateSource || 'Unknown', {
                        writeExif: data.settings.writeExif,
                        exifWriteConfirmed: data.settings.exifWriteConfirmed ?? true,
                        exifWriteRecovered: data.settings.exifWriteRecovered ?? true,
                        exifWriteMarked: data.settings.exifWriteMarked ?? false,
                    });
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
            }
            catch (err) {
                results.push({ success: false, sourcePath: file.sourcePath, destPath, finalFilename, error: err.message });
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
            }
            else {
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
                    if (copyFilesCancelled)
                        mirrorAbort.cancelled = true;
                }, 250);
                const mirrorResult = await runRobocopyMirror(stagingPath, destinationPath, () => {
                    mirroredCount++;
                    if (mainWindow) {
                        mainWindow.webContents.send('files:copy:mirror-progress', {
                            filesMirrored: mirroredCount,
                            totalToMirror: successCount,
                        });
                    }
                }, mirrorAbort);
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
        return { success: true, results, copied: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, duplicatesRemoved, duplicateFiles, skippedExisting };
    }
    catch (error) {
        return { success: false, error: error.message, results, duplicatesRemoved, duplicateFiles };
    }
    finally {
        // Clean up staging dir on the way out — success, cancellation,
        // or thrown error. Skipped only when the mirror step flipped
        // preserveStagingForRecovery ON so the user can salvage the
        // local copy after a failed network push. Wrapped in try/catch
        // so a missing dir never masks the real return value.
        if (useStaging && stagingPath && !preserveStagingForRecovery) {
            try {
                await fs.promises.rm(stagingPath, { recursive: true, force: true });
            }
            catch (cleanupErr) {
                console.warn(`[Fix] Failed to clean up staging dir ${stagingPath}:`, cleanupErr);
            }
        }
        else if (useStaging && stagingPath && preserveStagingForRecovery) {
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
        }
        else {
            shell.beep();
        }
    }
    catch (error) {
        console.error('Error playing completion sound:', error);
        shell.beep();
    }
});
ipcMain.handle('report:load', async (_event, reportId) => {
    try {
        const report = await loadReport(reportId);
        return { success: true, data: report };
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
ipcMain.handle('report:loadLatest', async () => {
    try {
        const report = await loadLatestReport();
        return { success: true, data: report };
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
ipcMain.handle('report:list', async () => {
    try {
        const reports = await listReports();
        return { success: true, data: reports };
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
ipcMain.handle('report:exportCSV', async (_event, reportId, folderPath) => {
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
        const result = await dialog.showSaveDialog(mainWindow, {
            title: 'Export Report as CSV',
            defaultPath: path.join(defaultDir, defaultFilename),
            filters: [{ name: 'CSV Files', extensions: ['csv'] }]
        });
        if (!result.canceled && result.filePath) {
            fs.writeFileSync(result.filePath, csv, 'utf-8');
            return { success: true, filePath: result.filePath };
        }
        return { success: false, error: 'Export cancelled' };
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
ipcMain.handle('report:exportTXT', async (_event, reportId, folderPath) => {
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
        const result = await dialog.showSaveDialog(mainWindow, {
            title: 'Export Report as TXT',
            defaultPath: path.join(defaultDir, defaultFilename),
            filters: [{ name: 'Text Files', extensions: ['txt'] }]
        });
        if (!result.canceled && result.filePath) {
            fs.writeFileSync(result.filePath, txt, 'utf-8');
            return { success: true, filePath: result.filePath };
        }
        return { success: false, error: 'Export cancelled' };
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
// Regenerate the catalogue on demand for a given destination
ipcMain.handle('report:regenerateCatalogue', async (_event, destinationPath) => {
    try {
        const settings = getSettings();
        if (!settings.autoSaveCatalogue) {
            return { success: false, error: 'Auto-catalogue is disabled' };
        }
        const result = await writeCatalogue(destinationPath);
        return result;
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
// Get the default export folder for manual report exports (Documents folder)
ipcMain.handle('report:getDefaultExportPath', async (_event, reportId) => {
    try {
        return { success: true, path: app.getPath('documents') };
    }
    catch {
        return { success: false, path: '' };
    }
});
ipcMain.handle('set-zoom', (_event, zoomFactor) => {
    if (mainWindow) {
        mainWindow.webContents.setZoomFactor(zoomFactor);
    }
});
ipcMain.handle('set-title-bar-color', (_event, isDark) => {
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
ipcMain.handle('settings:set', async (_event, key, value) => {
    setSetting(key, value);
    return { success: true };
});
ipcMain.handle('settings:setAll', async (_event, settings) => {
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
ipcMain.handle('license:activate', async (_event, licenseKey) => {
    return await activateLicense(licenseKey);
});
ipcMain.handle('license:refresh', async (_event, licenseKey) => {
    return await refreshLicense(licenseKey);
});
ipcMain.handle('license:deactivate', async (_event, licenseKey) => {
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
ipcMain.handle('app:logFilePath', async (_e, args) => {
    const filePath = log.transports.file.getFile().path;
    if (args?.reveal) {
        try {
            shell.showItemInFolder(filePath);
        }
        catch { }
    }
    return { path: filePath };
});
// Renderer → main log forwarder. Anything the React side hands us
// here is written to the same main.log file (prefixed so the origin
// is obvious), keeping every log line in one place instead of split
// between DevTools console (which doesn't exist in production) and
// the main-process file. Invoked from the preload bridge.
ipcMain.handle('app:log', (_e, payload) => {
    const level = payload?.level ?? 'info';
    const msg = String(payload?.message ?? '');
    const data = payload?.data;
    const write = log[level] ?? log.info;
    if (data !== undefined)
        write(`[renderer] ${msg}`, data);
    else
        write(`[renderer] ${msg}`);
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
ipcMain.handle('app:reportProblem', async (_e, payload) => {
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
        }
        catch { }
        const body = [
            description || '(user left description blank)',
            '',
            '─── system info ───',
            info,
            userEmail ? `Return address: ${userEmail}` : '',
            '',
            '─── recent log (last 200 lines) ───',
            logTail || '(log file unreadable)',
            '',
            '─── please attach the full log from the folder that just opened ───',
            logFilePath,
        ].filter(Boolean).join('\n');
        const subject = 'Photo Date Rescue — support request';
        const mailto = `mailto:${supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        // Open default mail client AND reveal log in Explorer. Users then
        // drag the log into the email manually — mailto can't attach.
        await shell.openExternal(mailto);
        try {
            shell.showItemInFolder(logFilePath);
        }
        catch { }
        log.info(`[report] opened mailto for support request (description ${description.length} chars)`);
        return { success: true, logFilePath };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
// Resolve the user's well-known Quick Access folders so the Add Source
// browser can surface them in its sidebar. Electron's app.getPath() already
// knows the correct localised paths on all platforms.
ipcMain.handle('app:quickAccessPaths', async () => {
    const safe = (key) => {
        try {
            return app.getPath(key);
        }
        catch {
            return null;
        }
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
ipcMain.handle('date:getSuggestions', async (_event, fileId) => {
    try {
        const { getDateSuggestionsForFile } = await import('./date-editor.js');
        return { success: true, data: getDateSuggestionsForFile(fileId) };
    }
    catch (e) {
        return { success: false, error: e.message };
    }
});
ipcMain.handle('date:apply', async (_event, opts) => {
    try {
        const { applyDateCorrection } = await import('./date-editor.js');
        const result = await applyDateCorrection(opts);
        return { success: result.success, data: result };
    }
    catch (e) {
        return { success: false, error: e.message };
    }
});
ipcMain.handle('date:undo', async () => {
    try {
        const { undoLastDateCorrection } = await import('./date-editor.js');
        return await undoLastDateCorrection();
    }
    catch (e) {
        return { success: false, error: e.message };
    }
});
ipcMain.handle('date:auditLog', async (_event, limit = 20) => {
    try {
        const { getRecentAuditEntries } = await import('./date-editor.js');
        return { success: true, data: getRecentAuditEntries(limit) };
    }
    catch (e) {
        return { success: false, error: e.message };
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
function reclassifyFilesForOverride(make, model, isScanner) {
    const db = getDbForReclassify();
    if (!db)
        return { updated: 0 };
    const mk = make.trim();
    const md = model.trim();
    if (!mk && !md)
        return { updated: 0 };
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
    }
    catch {
        return null;
    }
}
ipcMain.handle('scannerOverride:list', async () => {
    try {
        const { listScannerOverrides } = await import('./settings-store.js');
        return { success: true, data: listScannerOverrides() };
    }
    catch (e) {
        return { success: false, error: e.message };
    }
});
ipcMain.handle('scannerOverride:set', async (_event, args) => {
    try {
        const { setScannerOverride } = await import('./settings-store.js');
        const list = setScannerOverride(args.make, args.model, args.isScanner);
        const { updated } = reclassifyFilesForOverride(args.make, args.model, args.isScanner);
        // Nudge the main window so S&D / Dashboard counts refresh.
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('dateEditor:dataChanged');
        }
        return { success: true, data: { list, updated } };
    }
    catch (e) {
        return { success: false, error: e.message };
    }
});
ipcMain.handle('scannerOverride:clear', async (_event, args) => {
    try {
        const { clearScannerOverride } = await import('./settings-store.js');
        const list = clearScannerOverride(args.make, args.model);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('dateEditor:dataChanged');
        }
        return { success: true, data: { list } };
    }
    catch (e) {
        return { success: false, error: e.message };
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
        }
        catch (err) {
            console.error('[Startup Cleanup] Error:', err.message);
        }
    }
    return result;
});
ipcMain.handle('search:indexRun', async (_event, reportId) => {
    try {
        const report = await loadReportForIndex(reportId);
        if (!report) {
            return { success: false, error: 'Report not found' };
        }
        const result = await indexFixRun(report, (progress) => {
            mainWindow?.webContents.send('search:indexProgress', progress);
        });
        return result;
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('search:cancelIndex', async () => {
    cancelIndexing();
    return { success: true };
});
ipcMain.handle('search:removeRun', async (_event, runId) => {
    try {
        removeRun(runId);
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('search:removeRunByReport', async (_event, reportId) => {
    try {
        removeRunByReportId(reportId);
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('search:listRuns', async () => {
    try {
        return { success: true, data: listRuns() };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('search:query', async (_event, query) => {
    try {
        const result = searchFiles(query);
        return { success: true, data: result };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('search:filterOptions', async () => {
    try {
        return { success: true, data: getFilterOptions() };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('search:stats', async () => {
    try {
        return { success: true, data: getIndexStats() };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
// ─── Memories IPC handlers ──────────────────────────────────────────────────
ipcMain.handle('memories:yearMonthBuckets', async (_event, runIds) => {
    try {
        return { success: true, data: getMemoriesYearMonthBuckets(runIds) };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('memories:onThisDay', async (_event, args) => {
    try {
        return { success: true, data: getMemoriesOnThisDay(args.month, args.day, args.runIds, args.limit ?? 50) };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
// `month` and `day` are optional so the same channel powers all three
// drill-down granularities (year / month / day). The renderer omits
// the field entirely when widening the range — the backend treats
// missing values as "no constraint at this level".
ipcMain.handle('memories:dayFiles', async (_event, args) => {
    try {
        return { success: true, data: getMemoriesDayFiles(args.year, args.month ?? null, args.day ?? null, args.runIds) };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
// ═══════════════════════════════════════════════════════════════
// Trees v1 — family relationship IPC handlers
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('trees:addRelationship', async (_event, args) => {
    try {
        const result = addRelationship(args);
        if ('error' in result)
            return { success: false, error: result.error };
        return { success: true, data: result };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:updateRelationship', async (_event, args) => {
    try {
        const result = updateRelationship(args.id, args.patch);
        if ('error' in result)
            return { success: false, error: result.error };
        return { success: true, data: result };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:removeRelationship', async (_event, id) => {
    try {
        return removeRelationship(id);
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:listRelationshipsForPerson', async (_event, personId) => {
    try {
        return { success: true, data: listRelationshipsForPerson(personId) };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:listAllRelationships', async () => {
    try {
        return { success: true, data: listAllRelationships() };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:updatePersonLifeEvents', async (_event, args) => {
    try {
        return updatePersonLifeEvents(args.personId, args.patch);
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:setPersonCardBackground', async (_event, args) => {
    try {
        return setPersonCardBackground(args.personId, args.dataUrl);
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:setPersonGender', async (_event, args) => {
    try {
        return setPersonGender(args.personId, args.gender);
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:getFamilyGraph', async (_event, args) => {
    try {
        return { success: true, data: getFamilyGraph(args.focusPersonId, args.maxHops ?? 3) };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:getCooccurrenceStats', async (_event, args) => {
    try {
        return { success: true, data: getPersonCooccurrenceStats(args.limit ?? 25, args.minSharedPhotos ?? 20) };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:getPartnerSuggestionScores', async (_event, anchorId) => {
    try {
        return { success: true, data: getPartnerSuggestionScores(anchorId) };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:savedList', async () => {
    try {
        return { success: true, data: listSavedTrees() };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:savedGet', async (_event, id) => {
    try {
        return { success: true, data: getSavedTree(id) };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:savedCreate', async (_event, args) => {
    try {
        return createSavedTree(args);
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:savedUpdate', async (_event, args) => {
    try {
        return updateSavedTree(args.id, args.patch);
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:savedDelete', async (_event, id) => {
    try {
        return deleteSavedTree(id);
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:toggleHiddenAncestor', async (_event, args) => {
    try {
        return toggleHiddenAncestor(args.treeId, args.personId);
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:undo', async () => {
    try {
        return undoLastGraphOperation();
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:redo', async () => {
    try {
        return redoGraphOperation();
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:historyCounts', async () => {
    try {
        return { success: true, data: getGraphHistoryCounts() };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:historyList', async (_event, limit) => {
    try {
        return { success: true, data: listGraphHistoryEntries(limit ?? 500) };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:historyRevert', async (_event, targetId) => {
    try {
        return revertToGraphHistoryEntry(targetId);
    }
    catch (err) {
        return { success: false, undoneCount: 0, error: err.message };
    }
});
ipcMain.handle('trees:createPlaceholderPerson', async () => {
    try {
        return { success: true, data: createPlaceholderPerson() };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:createNamedPerson', async (_event, name) => {
    try {
        return createNamedPerson(name);
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:namePlaceholder', async (_event, args) => {
    try {
        return namePlaceholder(args.personId, args.name);
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:mergePlaceholder', async (_event, args) => {
    try {
        return mergePlaceholderIntoPerson(args.placeholderId, args.targetPersonId);
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('trees:removePlaceholder', async (_event, id) => {
    try {
        return removePlaceholder(id);
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('search:rebuildIndex', async () => {
    try {
        clearAllIndexData();
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('search:cleanup', async () => {
    try {
        const result = runDatabaseCleanup();
        return { success: true, data: result };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('search:relocateRun', async (_event, runId, newPath) => {
    try {
        const updated = relocateRun(runId, newPath);
        return { success: true, data: { filesUpdated: updated } };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
// Favourite filters
ipcMain.handle('search:favourites:list', async () => {
    try {
        return { success: true, data: listFavouriteFilters() };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('search:favourites:save', async (_event, name, query) => {
    try {
        const fav = saveFavouriteFilter(name, query);
        return { success: true, data: fav };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('search:favourites:delete', async (_event, id) => {
    try {
        deleteFavouriteFilter(id);
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('search:favourites:rename', async (_event, id, name) => {
    try {
        renameFavouriteFilter(id, name);
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
// Detached viewer window
// Check if paths exist (for destination drive availability)
ipcMain.handle('search:checkPathsExist', async (_event, paths) => {
    const result = {};
    for (const p of paths) {
        try {
            result[p] = fs.existsSync(p);
        }
        catch {
            result[p] = false;
        }
    }
    return { success: true, data: result };
});
let viewerWindow = null;
ipcMain.handle('search:openViewer', async (_event, filePaths, fileNames, startIndex) => {
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
    }
    catch (err) {
        return { success: false, error: err.message };
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
let peopleWindow = null;
let peopleWindowIsWarm = false; // true while window exists but never been shown
function createPeopleWindow(opts) {
    // Detect dark mode synchronously from a cached value if main window is
    // available; otherwise default light. Pre-warm fires a few seconds after
    // mainWindow loads so the cached classList is reliable by then.
    const isDark = !!mainWindow && !mainWindow.isDestroyed()
        ? false // overridden below via async query when opts.show=true
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
    const peoplePage = path.join(__dirname, '../dist/public/people.html');
    // Best-effort dark-mode query — for the warm path we won't have the
    // result before loadFile, so the renderer also reads the live value
    // from document on its own. The query string is just a hint.
    mainWindow?.webContents.executeJavaScript('document.documentElement.classList.contains("dark")').then((dark) => {
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
function prewarmPeopleWindow() {
    if (peopleWindow && !peopleWindow.isDestroyed())
        return;
    try {
        peopleWindow = createPeopleWindow({ show: false });
        peopleWindowIsWarm = true;
        console.log('[PM] Pre-warmed People Manager window in the background');
    }
    catch (err) {
        console.warn('[PM] Pre-warm failed (will fall back to cold open):', err.message);
        peopleWindow = null;
        peopleWindowIsWarm = false;
    }
}
ipcMain.handle('people:open', async () => {
    try {
        // Warm path: window already exists. Show + focus instantly.
        if (peopleWindow && !peopleWindow.isDestroyed()) {
            if (!peopleWindow.isVisible())
                peopleWindow.show();
            peopleWindow.focus();
            peopleWindowIsWarm = false; // it's been shown — no longer "warm" in the pre-load sense
            return { success: true };
        }
        // Cold path: pre-warm hadn't fired yet (user clicked very fast).
        // Build the window normally and show it.
        peopleWindow = createPeopleWindow({ show: true });
        peopleWindowIsWarm = false;
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
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
        if (win.isDestroyed())
            continue;
        try {
            win.webContents.send('people:dataChanged');
        }
        catch { /* non-fatal */ }
    }
    return { success: true };
});
// ─── Date Editor window ───────────────────────────────────────────────────────
let dateEditorWindow = null;
ipcMain.handle('dateEditor:open', async (_event, seedQuery) => {
    try {
        // URL-encode the seed query so the Date Editor renderer can restore
        // exactly the main window's current S&D filter. Capped at ~16 KiB to
        // defend against pathological filter strings.
        const seedParam = seedQuery
            ? (() => {
                try {
                    const s = JSON.stringify(seedQuery);
                    return s.length <= 16 * 1024 ? s : '';
                }
                catch {
                    return '';
                }
            })()
            : '';
        if (dateEditorWindow && !dateEditorWindow.isDestroyed()) {
            // Window already open — reload it with the new seed query so the user
            // sees the photos matching whatever they've just filtered to.
            const isDark = await mainWindow?.webContents.executeJavaScript('document.documentElement.classList.contains("dark")').catch(() => false) ?? false;
            const dateEditorPage = path.join(__dirname, '../dist/public/date-editor.html');
            dateEditorWindow.loadFile(dateEditorPage, {
                query: { dark: isDark ? '1' : '0', ...(seedParam ? { seed: seedParam } : {}) },
            });
            dateEditorWindow.focus();
            return { success: true };
        }
        const isDark = await mainWindow?.webContents.executeJavaScript('document.documentElement.classList.contains("dark")').catch(() => false) ?? false;
        dateEditorWindow = new BrowserWindow({
            width: 1280,
            height: 820,
            minWidth: 900,
            minHeight: 560,
            backgroundColor: isDark ? '#1a1a2e' : '#f6f6fb',
            title: 'Date Editor — Photo Date Rescue',
            // See peopleWindow above: independent top-level window, no skipTaskbar
            // so Alt-Tab works and the user can restore a minimised window.
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
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
// Open settings page in main window with a specific tab active
ipcMain.handle('app:openSettings', async (_event, tab) => {
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
    }
    catch (err) {
        return { success: false, error: err.message };
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
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:listPersons', async () => {
    try {
        return { success: true, data: listPersons() };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:personsCooccurrence', async (_event, selectedPersonIds) => {
    try {
        return { success: true, data: getPersonsWithCooccurrence(selectedPersonIds) };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:namePerson', async (_event, name, clusterId, avatarData, fullName) => {
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
            const files = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE cluster_id = ?`).all(clusterId);
            for (const f of files)
                rebuildAiFts(f.file_id);
        }
        invalidatePersonClustersCache();
        return { success: true, data: { personId } };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:assignFace', async (_event, faceId, personId, verified = false) => {
    try {
        assignPersonToFace(faceId, personId, verified);
        // Rebuild FTS for the affected file so search reflects the reassignment
        const { getDb } = await import('./search-database.js');
        const database = getDb();
        const face = database.prepare(`SELECT file_id FROM face_detections WHERE id = ?`).get(faceId);
        if (face)
            rebuildAiFts(face.file_id);
        invalidatePersonClustersCache();
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:batchVerify', async (_event, personIds) => {
    try {
        const { getDb } = await import('./search-database.js');
        const database = getDb();
        const stmt = database.prepare('UPDATE face_detections SET verified = 1 WHERE person_id = ? AND verified = 0');
        const fileStmt = database.prepare('SELECT DISTINCT file_id FROM face_detections WHERE person_id = ?');
        const affectedFiles = new Set();
        for (const personId of personIds) {
            stmt.run(personId);
            const files = fileStmt.all(personId);
            for (const f of files)
                affectedFiles.add(f.file_id);
        }
        for (const fileId of affectedFiles)
            rebuildAiFts(fileId);
        invalidatePersonClustersCache();
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:importXmpFaces', async () => {
    try {
        const { importXmpFacesForAllFiles } = await import('./xmp-face-import.js');
        const result = importXmpFacesForAllFiles();
        return { success: true, data: result };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:refineFromVerified', async (_event, similarityThreshold, personFilter) => {
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
            const files = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE person_id IN (${placeholders})`).all(...personIds);
            for (const f of files)
                rebuildAiFts(f.file_id);
        }
        // Was missing — every other mutation IPC invalidates the cache.
        // Without this, the Improve flow's loadClusters() comes back with
        // stale data that excludes the just-matched faces, and the user
        // has to hit Refresh manually before they see the new auto-
        // matches under their named person. This is the cause of the
        // "Owen + 5 only after refresh" report.
        invalidatePersonClustersCache();
        return { success: true, data: result };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:unnameFace', async (_event, faceId) => {
    try {
        unnameFace(faceId);
        invalidatePersonClustersCache();
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:renamePerson', async (_event, personId, newName, newFullName) => {
    try {
        // newFullName: undefined = leave existing full_name alone (legacy
        // callers); null or '' = clear it; non-empty string = write it.
        renamePerson(personId, newName, newFullName);
        // Rebuild FTS for all affected files
        const { getDb } = await import('./search-database.js');
        const database = getDb();
        const files = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE person_id = ?`).all(personId);
        for (const f of files)
            rebuildAiFts(f.file_id);
        invalidatePersonClustersCache();
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:setRepresentativeFace', async (_event, personId, faceId) => {
    try {
        const { setPersonRepresentativeFace } = await import('./search-database.js');
        setPersonRepresentativeFace(personId, faceId);
        invalidatePersonClustersCache();
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:mergePersons', async (_event, targetPersonId, sourcePersonId) => {
    try {
        const facesReassigned = mergePersons(targetPersonId, sourcePersonId);
        // Rebuild FTS for all affected files
        const { getDb } = await import('./search-database.js');
        const database = getDb();
        const files = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE person_id = ?`).all(targetPersonId);
        for (const f of files)
            rebuildAiFts(f.file_id);
        invalidatePersonClustersCache();
        return { success: true, data: { facesReassigned } };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:deletePerson', async (_event, personId) => {
    try {
        // Get the person info first for the response
        const person = getPersonById(personId);
        if (!person)
            return { success: false, error: 'Person not found' };
        // Get affected file IDs before deletion (for FTS rebuild)
        const { getDb } = await import('./search-database.js');
        const database = getDb();
        const affectedFiles = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE person_id = ?`).all(personId);
        // Delete the person
        const result = deletePerson(personId);
        // Rebuild FTS for affected files
        for (const f of affectedFiles)
            rebuildAiFts(f.file_id);
        invalidatePersonClustersCache();
        return { success: true, data: { ...result, personName: person.name } };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:getPersonInfo', async (_event, personId) => {
    try {
        const person = getPersonById(personId);
        return { success: true, data: person };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:permanentlyDeletePerson', async (_event, personId) => {
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
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:unnamePersonAndDelete', async (_event, personId) => {
    try {
        const person = getPersonById(personId);
        if (!person)
            return { success: false, error: 'Person not found' };
        const { getDb } = await import('./search-database.js');
        const database = getDb();
        // Capture affected file IDs BEFORE the unname so FTS can be
        // rebuilt for them — once person_id flips to NULL the join is
        // gone and we can't enumerate the affected photos any more.
        const affectedFiles = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE person_id = ?`).all(personId);
        const result = unnamePersonAndDelete(personId);
        for (const f of affectedFiles)
            rebuildAiFts(f.file_id);
        invalidatePersonClustersCache();
        return { success: true, data: { ...result, personName: person.name } };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:restoreUnnamedPerson', async (_event, token) => {
    try {
        const result = restoreUnnamedPerson(token);
        // Same FTS rebuild dance — every restored face needs its file's
        // search index rebuilt so the name reappears in S&D results.
        const { getDb } = await import('./search-database.js');
        const database = getDb();
        const fileIds = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE person_id = ?`).all(result.personId);
        for (const f of fileIds)
            rebuildAiFts(f.file_id);
        invalidatePersonClustersCache();
        return { success: true, data: result };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:restorePerson', async (_event, personId) => {
    try {
        const success = restorePerson(personId);
        // Was missing — every other mutation IPC invalidates the cache.
        // Without this, the Undo toast's loadClusters() call hits a stale
        // cached result that still excludes the restored person, and the
        // user has to manually press Refresh to see the row come back.
        invalidatePersonClustersCache();
        return { success };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:listDiscardedPersons', async () => {
    try {
        return { success: true, data: listDiscardedPersons() };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:visualSuggestions', async (_event, faceId) => {
    try {
        return { success: true, data: getVisualSuggestions(faceId) };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:clusterFaceCount', async (_event, clusterId, personId) => {
    try {
        return { success: true, data: getClusterFaceCount(clusterId, personId) };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:getFaces', async (_event, fileId) => {
    try {
        return { success: true, data: getFacesForFile(fileId) };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:getTags', async (_event, fileId) => {
    try {
        return { success: true, data: getAiTagsForFile(fileId) };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:tagOptions', async () => {
    try {
        return { success: true, data: getAiTagOptions() };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:clearAll', async () => {
    try {
        clearAllAiData();
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
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
    }
    catch (err) {
        return { success: false, error: err.message };
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
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('db:restoreFromBackup', async (_event, snapshotPath) => {
    try {
        const { restoreDbFromBackup } = await import('./search-database.js');
        const r = restoreDbFromBackup(snapshotPath);
        invalidatePersonClustersCache();
        return r.restored ? { success: true } : { success: false, error: r.error };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('db:takeSnapshot', async (_event, kind, label) => {
    try {
        const { takeSnapshot } = await import('./search-database.js');
        return takeSnapshot(kind, label);
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('db:deleteSnapshot', async (_event, snapshotPath) => {
    try {
        const { deleteSnapshot } = await import('./search-database.js');
        return deleteSnapshot(snapshotPath);
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('db:exportSnapshotZip', async (_event, snapshotPath) => {
    // Save a snapshot file as a portable .db copy at a user-chosen
    // location (we don't actually zip a single file — adds ~zero space
    // benefit for SQLite. Naming kept as "exportSnapshotZip" for the
    // bridge stability; copies as .db).
    try {
        const fs = await import('node:fs');
        const path = await import('node:path');
        if (!fs.existsSync(snapshotPath))
            return { success: false, error: 'Snapshot not found' };
        const { dialog } = await import('electron');
        const baseName = path.basename(snapshotPath);
        const result = await dialog.showSaveDialog({
            title: 'Export PDR snapshot',
            defaultPath: baseName,
            filters: [{ name: 'PDR snapshot', extensions: ['db'] }],
        });
        if (result.canceled || !result.filePath)
            return { success: false, error: 'Cancelled' };
        fs.copyFileSync(snapshotPath, result.filePath);
        return { success: true, path: result.filePath };
    }
    catch (err) {
        return { success: false, error: err.message };
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
let cachedPersonClusters = null;
let cachedPersonClustersAt = 0;
const PERSON_CLUSTERS_TTL_MS = 30000;
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
    }
    catch (err) {
        return { success: false, error: err.message };
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
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:clusterFaces', async (_event, clusterId, page = 0, perPage = 40, personId) => {
    try {
        return { success: true, data: getClusterFaces(clusterId, page, perPage, personId) };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:recluster', async (_event, threshold) => {
    try {
        await runFaceClustering(threshold);
        const { getDb } = await import('./search-database.js');
        const database = getDb();
        // ── STEP 1: Find core cluster for each named person ──
        // For each person_id, find which new cluster_id holds the most of their
        // named faces (including verified). That cluster is the "core".
        const allNamedFaces = database.prepare(`
      SELECT id, cluster_id, person_id, verified FROM face_detections WHERE person_id IS NOT NULL
    `).all();
        // Group by person_id → cluster_id → face IDs
        const personClusters = new Map();
        for (const f of allNamedFaces) {
            if (!personClusters.has(f.person_id))
                personClusters.set(f.person_id, new Map());
            const clusterMap = personClusters.get(f.person_id);
            if (!clusterMap.has(f.cluster_id))
                clusterMap.set(f.cluster_id, []);
            clusterMap.get(f.cluster_id).push(f.id);
        }
        // Determine core cluster for each person (the one with the most faces)
        const personCoreCluster = new Map(); // person_id → core cluster_id
        const resetStmt = database.prepare('UPDATE face_detections SET person_id = NULL, verified = 0 WHERE id = ?');
        for (const [personId, clusterMap] of personClusters) {
            let maxCount = 0;
            let coreClusterId = 0;
            for (const [clusterId, faceIds] of clusterMap) {
                if (faceIds.length > maxCount) {
                    maxCount = faceIds.length;
                    coreClusterId = clusterId;
                }
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
      `).all(coreClusterId);
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
        }
        catch (bfErr) {
            console.warn('[recluster] match_similarity refresh failed (non-fatal):', bfErr);
        }
        const faceFileIds = database.prepare('SELECT DISTINCT file_id FROM face_detections').all();
        for (const { file_id } of faceFileIds)
            rebuildAiFts(file_id);
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:faceCrop', async (_event, filePath, boxX, boxY, boxW, boxH, size = 96) => {
    try {
        const sharp = (await import('sharp')).default;
        // .rotate() applies EXIF auto-rotation. Must be present here AND when
        // extracting so width/height match the rotated pixel buffer that the
        // detector saw — otherwise normalised box coords (which were computed
        // in rotated space by ai-worker.ts) extract from the wrong region.
        const metadata = await sharp(filePath, { failOnError: false }).rotate().metadata();
        if (!metadata.width || !metadata.height)
            return { success: false, error: 'Could not read image' };
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
        if (pw <= 0 || ph <= 0)
            return { success: false, error: 'Invalid crop area' };
        const buffer = await sharp(filePath, { failOnError: false })
            .rotate()
            .extract({ left: px, top: py, width: pw, height: ph })
            .resize(size, size, { fit: 'cover' })
            .jpeg({ quality: 85 })
            .toBuffer();
        const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
        return { success: true, dataUrl };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
/**
 * Fetch the small slice of indexed_files metadata that the People
 * Manager hover preview wants to overlay on the enlarged photo:
 * filename, derived date, geo country, geo city. Keyed by file_path
 * because the PM already passes file_path around with each face;
 * adding a file_id to the face wire format would be a wider change.
 */
ipcMain.handle('search:getFileMetaByPath', async (_event, filePath) => {
    try {
        const { getDb } = await import('./search-database.js');
        const db = getDb();
        const row = db.prepare(`
      SELECT filename, derived_date, geo_country, geo_city
      FROM indexed_files
      WHERE file_path = ?
      LIMIT 1
    `).get(filePath);
        if (!row)
            return { success: false, error: 'File not in index' };
        return { success: true, data: row };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('ai:faceContext', async (_event, filePath, boxX, boxY, boxW, boxH, size = 240) => {
    try {
        const sharp = (await import('sharp')).default;
        // EXIF auto-rotate so we work in the same coordinate space as the
        // detector — see ai:faceCrop above for the long-form rationale.
        const metadata = await sharp(filePath, { failOnError: false }).rotate().metadata();
        if (!metadata.width || !metadata.height)
            return { success: false, error: 'Could not read image' };
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
        if (cropW <= 0 || cropH <= 0)
            return { success: false, error: 'Invalid crop' };
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
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
// ═══ Parallel Structure IPC Handlers ═════════════════════════════════════════
let structureCopyCancelled = false;
ipcMain.handle('structure:copy:cancel', async () => {
    structureCopyCancelled = true;
    return { success: true };
});
ipcMain.handle('structure:copy', async (_event, data) => {
    structureCopyCancelled = false;
    const { files, destinationPath, folderStructure, mode, skipDuplicates } = data;
    const results = [];
    let copied = 0, failed = 0, skipped = 0, movedAndDeleted = 0;
    const usedFilenames = new Set();
    const writtenHashes = new Map(); // hash → destPath
    // Scan pre-existing files at destination to skip duplicates
    const preExisting = new Set();
    if (skipDuplicates) {
        try {
            const scanDir = async (dir, base) => {
                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isFile()) {
                        preExisting.add(path.join(base, entry.name).toLowerCase());
                    }
                    else if (entry.isDirectory()) {
                        await scanDir(path.join(dir, entry.name), path.join(base, entry.name));
                    }
                }
            };
            if (fs.existsSync(destinationPath))
                await scanDir(destinationPath, '');
        }
        catch (err) {
            console.error('[Structure] Error scanning destination:', err.message);
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
                if (folderStructure === 'year')
                    subfolderPath = year;
                else if (folderStructure === 'year-month')
                    subfolderPath = path.join(year, month);
                else if (folderStructure === 'year-month-day')
                    subfolderPath = path.join(year, month, day);
            }
            else {
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
            const hash = await streamCopyFile(file.sourcePath, destPath, true);
            // Content-based dedup check
            if (skipDuplicates && hash && writtenHashes.has(hash)) {
                // Same content already written — remove this copy and skip
                await fs.promises.unlink(destPath);
                skipped++;
                results.push({ success: true, sourcePath: file.sourcePath, destPath: '', error: `Skipped: duplicate of ${path.basename(writtenHashes.get(hash))}` });
                mainWindow?.webContents.send('structure:copy:progress', { current: i + 1, total: files.length, currentFile: file.filename, phase: 'copying' });
                continue;
            }
            if (hash)
                writtenHashes.set(hash, destPath);
            // For move mode: verify hash match then delete original
            if (mode === 'move') {
                mainWindow?.webContents.send('structure:copy:progress', { current: i + 1, total: files.length, currentFile: file.filename, phase: 'verifying' });
                // Verify by reading the destination file hash
                const verifyHash = await streamCopyFile(destPath, destPath + '.verify_tmp', true);
                await fs.promises.unlink(destPath + '.verify_tmp'); // Remove the verify temp file
                if (hash === verifyHash) {
                    mainWindow?.webContents.send('structure:copy:progress', { current: i + 1, total: files.length, currentFile: file.filename, phase: 'deleting' });
                    await fs.promises.unlink(file.sourcePath);
                    movedAndDeleted++;
                    results.push({ success: true, sourcePath: file.sourcePath, destPath, originalDeleted: true });
                }
                else {
                    // Hash mismatch — keep both files, report error
                    results.push({ success: true, sourcePath: file.sourcePath, destPath, error: 'Copy verified but hash mismatch — original preserved', originalDeleted: false });
                }
            }
            else {
                results.push({ success: true, sourcePath: file.sourcePath, destPath });
            }
            copied++;
        }
        catch (err) {
            failed++;
            results.push({ success: false, sourcePath: file.sourcePath, destPath: '', error: err.message });
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
