import { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { execSync, execFile } from 'child_process';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import sharp from 'sharp';
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
import { checkForUpdates } from './update-checker.js';
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
  rebuildAiFts,
  getPersonClusters,
  getClusterFaces,
  getPersonsWithCooccurrence,
  cleanupOrphanedPersons,
  runDatabaseCleanup,
  relocateRun,
} from './search-database.js';

// Update checking
ipcMain.handle('updates:check', async () => {
  return await checkForUpdates();
});

ipcMain.handle('updates:getVersion', () => {
  return app.getVersion();
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

	  // Auto-start AI processing on launch if enabled AND models already downloaded
	  const settings = getSettings();
	  console.log(`[AI] Launch check: aiEnabled=${settings.aiEnabled}, modelsReady=${areModelsDownloaded()}`);
	  if (settings.aiEnabled && areModelsDownloaded()) {
	    setTimeout(async () => {
	      try {
	        console.log('[AI] Auto-starting AI processing (models already downloaded)...');
	        await startAiProcessing();
	        console.log('[AI] Auto-start completed or in progress');
	      } catch (err) {
	        console.error('[AI] Auto-start FAILED:', err);
	      }
	    }, 3000);
	  } else if (settings.aiEnabled && !areModelsDownloaded()) {
	    console.log('[AI] AI enabled but models not downloaded — waiting for user to trigger download');
	  }
	});

	// Block Electron's native zoom shortcuts — our renderer handles zoom via IPC
	// Allow F12 and Ctrl+Shift+I to open DevTools
	mainWindow!.webContents.on('before-input-event', (_event, input) => {
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

  ipcMain.handle('fix:setInProgress', (_event, inProgress: boolean) => {
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
  return path.join(PDR_TEMP_ROOT, `${baseName}_${hash}`);
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

function cleanupOrphanedTempDirs(): void {
  try {
    if (fs.existsSync(PDR_TEMP_ROOT)) {
      const entries = fs.readdirSync(PDR_TEMP_ROOT);
      for (const entry of entries) {
        const fullPath = path.join(PDR_TEMP_ROOT, entry);
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors for locked files
        }
      }
      // Remove root if empty
      try {
        const remaining = fs.readdirSync(PDR_TEMP_ROOT);
        if (remaining.length === 0) {
          fs.rmdirSync(PDR_TEMP_ROOT);
        }
      } catch {}
    }
  } catch {
    // Ignore cleanup errors on startup
  }
}

function cleanupTempDir(tempDir: string): void {
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup
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
  return path.join(PDR_TEMP_ROOT, `${baseName}_${hash}`);
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

app.whenReady().then(() => {
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

    // Use sharp for robust thumbnail generation (handles TIF, large files, RAW formats)
    if (!jpegBuffer) {
      try {
        jpegBuffer = await sharp(filePath, { failOnError: false })
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
  
ipcMain.handle('analysis:run', async (_event, sourcePath: string, sourceType: 'folder' | 'zip' | 'drive') => {
  let tempDir: string | null = null;
  
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
    } else if (sourceType === 'zip' && getZipFileSize(sourcePath) > LARGE_ZIP_THRESHOLD) {
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
      (results as any)._extractedTempDir = tempDir;
    }
    
    // NOTE: Do NOT clean up temp dir here — the extracted files are needed
    // during the copy/fix phase. Cleanup happens in files:copy or on app quit.
    
    return { success: true, data: results };
  } catch (error) {
    // Clean up temp dir on failure
    if (tempDir) {
      cleanupTempDir(tempDir);
      activeTempDirs.delete(tempDir);
    }
    
    if ((error as Error).message === 'ANALYSIS_CANCELLED') {
      return { success: false, cancelled: true, error: 'Analysis cancelled by user' };
    }
    return { success: false, error: (error as Error).message };
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
    if (!fs.existsSync(destinationPath)) {
      fs.mkdirSync(destinationPath, { recursive: true });
    }
    
    // Snapshot pre-existing files at destination before this run writes anything
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

    // Queue for parallel PNG/JPG conversions
    const CONVERSION_BATCH_SIZE = 6;
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

    // Flush pending conversions in parallel batches
    const flushConversions = async () => {
      if (pendingConversions.length === 0) return;
      const batch = pendingConversions.splice(0, pendingConversions.length);
      console.log(`[Convert] Flushing batch of ${batch.length} conversions in parallel`);

      const batchResults = await Promise.allSettled(
        batch.map(async (task) => {
          const conversionPromise = task.format === 'jpg'
            ? sharp(task.sourceInput).jpeg({ quality: 92 }).toFile(task.convertedPath)
            : sharp(task.sourceInput).png({ compressionLevel: 6, effort: 1 }).toFile(task.convertedPath);
          await Promise.race([
            conversionPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Conversion timeout')), 60000))
          ]);
        })
      );

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
          console.warn(`[Convert] Failed: ${path.basename(task.destPath)}:`, (result as PromiseRejectedResult).reason);
          results.push({
            success: false,
            sourcePath: task.file.sourcePath,
            destPath: task.destPath,
            finalFilename: task.finalFilename,
            error: (result as PromiseRejectedResult).reason?.message || 'Conversion failed'
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
      
      const targetDir = subfolderPath ? path.join(destinationPath, subfolderPath) : destinationPath;
      
      // Ensure target directory exists
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
             fs.existsSync(path.join(targetDir, finalFilename)) ||
             (convertedExt && usedFilenames.has(path.join(subfolderPath, baseName + convertedExt).toLowerCase())) ||
             (convertedExt && counter === 1 && fs.existsSync(path.join(targetDir, baseName + convertedExt)))) {
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

    return { success: true, results, copied: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, duplicatesRemoved, duplicateFiles, skippedExisting };
  } catch (error) {
    return { success: false, error: (error as Error).message, results, duplicatesRemoved, duplicateFiles };
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

ipcMain.handle('search:openViewer', async (_event, filePaths: string[], fileNames: string[]) => {
  try {
    // Support single or multiple files — pass as JSON-encoded array in query param
    const filesParam = JSON.stringify(filePaths);
    const title = filePaths.length === 1
      ? fileNames[0] + ' — PDR Viewer'
      : `${filePaths.length} photos — PDR Viewer`;

    // If viewer already open, reuse it
    if (viewerWindow && !viewerWindow.isDestroyed()) {
      const viewerHtml = app.isPackaged
        ? path.join(process.resourcesPath, 'dist/public/viewer.html')
        : path.join(__dirname, '../dist/public/viewer.html');
      viewerWindow.loadFile(viewerHtml, { query: { files: filesParam } });
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

    viewerWindow.loadFile(viewerHtml, { query: { files: filesParam } });

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

// ═══ People Manager Window ═══════════════════════════════════════════════════

let peopleWindow: BrowserWindow | null = null;

ipcMain.handle('people:open', async () => {
  try {
    // If already open, focus it
    if (peopleWindow && !peopleWindow.isDestroyed()) {
      peopleWindow.focus();
      return { success: true };
    }

    // Detect dark mode from main window's document class
    const isDark = await mainWindow?.webContents.executeJavaScript(
      'document.documentElement.classList.contains("dark")'
    ).catch(() => false) ?? false;

    peopleWindow = new BrowserWindow({
      width: 1120,
      height: 780,
      minWidth: 700,
      minHeight: 500,
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

    peopleWindow.loadFile(peoplePage, {
      query: { dark: isDark ? '1' : '0' },
    });

    peopleWindow.on('closed', () => {
      peopleWindow = null;
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// People window notifies main window that data changed
ipcMain.handle('people:changed', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('people:dataChanged');
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

ipcMain.handle('ai:namePerson', async (_event, name: string, clusterId?: number, avatarData?: string) => {
  try {
    const personId = upsertPerson(name, avatarData);
    if (clusterId != null) {
      assignPersonToCluster(clusterId, personId);
      // Rebuild FTS for all files in the cluster
      const { getDb } = await import('./search-database.js');
      const database = getDb();
      const files = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE cluster_id = ?`).all(clusterId) as { file_id: number }[];
      for (const f of files) rebuildAiFts(f.file_id);
    }
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

ipcMain.handle('ai:refineFromVerified', async (_event, similarityThreshold?: number) => {
  try {
    const { refineFromVerifiedFaces, getDb } = await import('./search-database.js');
    const result = refineFromVerifiedFaces(similarityThreshold ?? 0.72);
    // Rebuild FTS for all files whose faces were newly assigned
    const database = getDb();
    const personIds = result.perPerson.filter(p => p.matched > 0).map(p => p.personId);
    if (personIds.length > 0) {
      const placeholders = personIds.map(() => '?').join(',');
      const files = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE person_id IN (${placeholders})`).all(...personIds) as { file_id: number }[];
      for (const f of files) rebuildAiFts(f.file_id);
    }
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:unnameFace', async (_event, faceId: number) => {
  try {
    unnameFace(faceId);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:renamePerson', async (_event, personId: number, newName: string) => {
  try {
    renamePerson(personId, newName);
    // Rebuild FTS for all affected files
    const { getDb } = await import('./search-database.js');
    const database = getDb();
    const files = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE person_id = ?`).all(personId) as { file_id: number }[];
    for (const f of files) rebuildAiFts(f.file_id);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:setRepresentativeFace', async (_event, personId: number, faceId: number) => {
  try {
    const { setPersonRepresentativeFace } = await import('./search-database.js');
    setPersonRepresentativeFace(personId, faceId);
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

ipcMain.handle('ai:restorePerson', async (_event, personId: number) => {
  try {
    const success = restorePerson(personId);
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

ipcMain.handle('ai:personClusters', async () => {
  try {
    cleanupOrphanedPersons();
    return { success: true, data: getPersonClusters() };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:clusterFaces', async (_event, clusterId: number, page: number = 0, perPage: number = 40, personId?: number) => {
  try {
    return { success: true, data: getClusterFaces(clusterId, page, perPage, personId) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:recluster', async (_event, threshold: number) => {
  try {
    runFaceClustering(threshold);
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

    const faceFileIds = database.prepare('SELECT DISTINCT file_id FROM face_detections').all() as { file_id: number }[];
    for (const { file_id } of faceFileIds) rebuildAiFts(file_id);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:faceCrop', async (_event, filePath: string, boxX: number, boxY: number, boxW: number, boxH: number, size: number = 96) => {
  try {
    const sharp = (await import('sharp')).default;
    const metadata = await sharp(filePath, { failOnError: false }).metadata();
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
      .extract({ left: px, top: py, width: pw, height: ph })
      .resize(size, size, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer();

    const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
    return { success: true, dataUrl };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('ai:faceContext', async (_event, filePath: string, boxX: number, boxY: number, boxW: number, boxH: number, size: number = 240) => {
  try {
    const sharp = (await import('sharp')).default;
    const metadata = await sharp(filePath, { failOnError: false }).metadata();
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

    // Calculate face box position relative to the crop
    const relX = faceX - cropX;
    const relY = faceY - cropY;

    // Scale factor from crop to output size
    const scale = size / Math.max(cropW, cropH);
    const boxPx = { x: Math.round(relX * scale), y: Math.round(relY * scale), w: Math.round(faceW * scale), h: Math.round(faceH * scale) };

    // Create the crop
    const cropped = await sharp(filePath, { failOnError: false })
      .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
      .resize(size, size, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Draw a face indicator box using SVG overlay
    const strokeW = 2;
    const svgBox = Buffer.from(`<svg width="${size}" height="${size}">
      <rect x="${boxPx.x}" y="${boxPx.y}" width="${boxPx.w}" height="${boxPx.h}"
            fill="none" stroke="#a855f7" stroke-width="${strokeW}" rx="3" opacity="0.85"/>
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
