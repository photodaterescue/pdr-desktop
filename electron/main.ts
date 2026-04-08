import { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { execSync, execFile } from 'child_process';
import sharp from 'sharp';
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
  shutdownAiWorker,
  isAiProcessing,
  setMainWindow as setAiMainWindow,
} from './ai-manager.js';
import {
  listPersons,
  upsertPerson,
  assignPersonToCluster,
  assignPersonToFace,
  getFacesForFile,
  getAiTagsForFile,
  getAiTagOptions,
  getAiStats,
  clearAllAiData,
  rebuildAiFts,
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

// Streaming copy for large files - yields during copy
async function streamCopyFile(src: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(src, { highWaterMark: 64 * 1024 });
    const writeStream = fs.createWriteStream(dest);
    
    readStream.on('error', reject);
    writeStream.on('error', reject);
    writeStream.on('finish', resolve);
    
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

	// Register main window with AI manager for progress IPC
	setAiMainWindow(mainWindow);

	// Zoom is handled purely via CSS transform on the content area — keep Electron at 1.0
	mainWindow!.webContents.on('did-finish-load', () => {
	  mainWindow!.webContents.setZoomFactor(1.0);
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
      // Close viewer window if open
      if (viewerWindow && !viewerWindow.isDestroyed()) {
        viewerWindow.destroy();
        viewerWindow = null;
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
    const url = new URL(request.url);
    // Decode the path — pdr-file://C:/Users/... or pdr-file:///C:/Users/...
    let filePath = decodeURI(url.pathname);
    // Remove leading slash on Windows paths (e.g., /C:/Users → C:/Users)
    if (process.platform === 'win32' && filePath.startsWith('/')) {
      filePath = filePath.substring(1);
    }
    return net.fetch('file:///' + filePath);
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
    // Close viewer window if still open
    if (viewerWindow && !viewerWindow.isDestroyed()) {
      viewerWindow.destroy();
      viewerWindow = null;
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
    title: 'Select Destination Folder',
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
    title: 'Select Destination Folder',
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
    await shell.openPath(folderPath);
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
      const driveLetter = path.parse(directoryPath).root;
      const output = execSync(`wmic logicaldisk where "DeviceID='${driveLetter.replace('\\', '')}'" get FreeSpace,Size /format:csv`, { encoding: 'utf8' });
      const lines = output.trim().split('\n').filter(l => l.trim());
      if (lines.length >= 2) {
        const parts = lines[1].split(',');
        return {
          freeBytes: parseInt(parts[1], 10),
          totalBytes: parseInt(parts[2], 10),
        };
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

    // Use sharp for robust thumbnail generation (handles TIF, large files, RAW formats)
    try {
      jpegBuffer = await sharp(filePath, { failOnError: false })
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch {
      // Sharp failed — fall back to nativeImage
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
    const items: Array<{ name: string; path: string; isDirectory: boolean; isImage: boolean; isArchive: boolean; sizeBytes: number; hasSubfolders: boolean }> = [];
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

      if (fileFilter === 'archives') {
        // In archive mode: show folders + archive files only
        if (isDir || isArchive) {
          let sizeBytes = 0;
          if (isArchive) {
            try { sizeBytes = (await fs.promises.stat(fullPath)).size; } catch {}
          }
          items.push({ name: entry.name, path: fullPath, isDirectory: isDir, isImage: false, isArchive, sizeBytes, hasSubfolders });
        }
      } else if (fileFilter === 'source') {
        // Source mode: show folders + images + archives
        if (isDir || isImage || isArchive) {
          let sizeBytes = 0;
          if (isArchive || isImage) {
            try { sizeBytes = (await fs.promises.stat(fullPath)).size; } catch {}
          }
          items.push({ name: entry.name, path: fullPath, isDirectory: isDir, isImage, isArchive, sizeBytes, hasSubfolders });
        }
      } else {
        // Default mode: show folders + image files
        if (isDir || isImage) {
          items.push({ name: entry.name, path: fullPath, isDirectory: isDir, isImage, isArchive: false, sizeBytes: 0, hasSubfolders });
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

function calculateFileHashSync(filePath: string): string | null {
  try {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const bufferSize = 64 * 1024;
    const buffer = Buffer.alloc(bufferSize);
    let bytesRead: number;
    
    while ((bytesRead = fs.readSync(fd, buffer, 0, bufferSize, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
    
    fs.closeSync(fd);
    return hash.digest('hex');
  } catch {
    return null;
  }
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
    const settings = getSettings();
    const useHash = settings.thoroughDuplicateMatching;
    
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
              // Hash mode: compute SHA-256
              const hash = calculateFileHashSync(fullPath);
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
}) => {
  const { files, destinationPath, zipPaths = {} } = data;
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
    
	for (let i = 0; i < files.length; i++) {
	  const file = files[i];
	  
	  // Yield every file to keep window responsive
	  await yieldToEventLoop();
	  
	  // Send progress every file
	  if (mainWindow) {
	    mainWindow.webContents.send('files:copy:progress', { current: i + 1, total: files.length });
	  }
	  
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
          continue;
        }
      }
      
      // GLOBAL duplicate check at write-time (ignores analysis isDuplicate flag)
      if (skipDuplicates) {
        let existingFile: string | undefined;
        let duplicateMethod: 'hash' | 'heuristic' = 'hash';
        const forceHash = data.settings?.thoroughDuplicateMatching ?? false;
        
        // Smart per-source logic: local sources use hash, network/cloud use heuristic
        // Settings toggle overrides: when ON, forces hash for everything
        let useHashForThisFile = forceHash;
        if (!forceHash) {
          // Determine source type from originSourcePath or sourcePath
          const sourcePathToClassify = file.originSourcePath || file.sourcePath;
          try {
            const classification = classifySource(sourcePathToClassify);
            // Local sources (internal, usb, direct-attached) → hash
            // Network/cloud sources (network, cloud) → heuristic
            useHashForThisFile = classification.type !== 'network' && classification.type !== 'cloud-sync';
          } catch {
            // If classification fails, default to heuristic (safer/faster)
            useHashForThisFile = false;
          }
        }
        
        if (!useHashForThisFile) {
          // HEURISTIC MODE: match by original filename + file size
          // Much faster — no need to read file contents
          const heuristicKey = `${path.basename(file.sourcePath)}|${fileSize}`;
          existingFile = writtenHeuristics.get(heuristicKey);
          duplicateMethod = 'heuristic';
          if (!existingFile) {
            writtenHeuristics.set(heuristicKey, file.newFilename);
          }
        } else if (fileSize > LARGE_FILE_THRESHOLD) {
          // HASH MODE but file too large: heuristic fallback
          const heuristicKey = `${path.basename(file.sourcePath)}|${fileSize}`;
          existingFile = writtenHeuristics.get(heuristicKey);
          duplicateMethod = 'heuristic';
          if (!existingFile) {
            writtenHeuristics.set(heuristicKey, file.newFilename);
          }
        } else {
          // HASH MODE: compute SHA-256 hash
          try {
            let hash: string;
            if (fileBuffer) {
              hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
            } else {
              // Read file for hashing (async streaming)
              hash = await new Promise<string>((resolve, reject) => {
                const hashObj = crypto.createHash('sha256');
                const stream = fs.createReadStream(file.sourcePath, { highWaterMark: 64 * 1024 });
                stream.on('data', (chunk) => hashObj.update(chunk));
                stream.on('end', () => resolve(hashObj.digest('hex')));
                stream.on('error', reject);
              });
            }
            
            existingFile = writtenHashes.get(hash);
            if (!existingFile) {
              writtenHashes.set(hash, file.newFilename);
            }
          } catch (hashError) {
            // Hash failed - fallback to heuristic for files >= 5MB
            if (fileSize >= MIN_HEURISTIC_SIZE) {
              const heuristicKey = `${path.basename(file.sourcePath)}|${fileSize}`;
              existingFile = writtenHeuristics.get(heuristicKey);
              duplicateMethod = 'heuristic';
              if (!existingFile) {
                writtenHeuristics.set(heuristicKey, file.newFilename);
              }
            }
          }
        }
        
        if (existingFile) {
          const wasExisting = existingFile.startsWith('[existing] ');
          duplicatesRemoved++;
          duplicateFiles.push({ 
            filename: path.basename(file.sourcePath), 
            duplicateOf: existingFile.replace('[existing] ', ''),
            duplicateMethod,
            wasExisting
          });
          continue; // Skip writing this file
        }
      }
      
      // Read file buffer for folder files (if not already loaded for hash)
      if (!fileBuffer && file.sourceType !== 'zip') {
        // We'll use copyFileSync below, no need to load buffer
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
        continue;
      }
      
      let counter = 1;
      while (usedFilenames.has(path.join(subfolderPath, finalFilename).toLowerCase()) || 
             fs.existsSync(path.join(targetDir, finalFilename))) {
        finalFilename = `${baseName}_${String(counter).padStart(3, '0')}${ext}`;
        counter++;
      }
      usedFilenames.add(path.join(subfolderPath, finalFilename).toLowerCase());
      
      const destPath = path.join(targetDir, finalFilename);
      
      try {
        if (file.sourceType === 'zip' && fileBuffer) {
          fs.writeFileSync(destPath, fileBuffer);
        } else if (file.sourceType === 'zip') {
          results.push({ success: false, sourcePath: file.sourcePath, destPath, finalFilename, error: 'Entry not found in zip' });
          continue;
        } else {
          await streamCopyFile(file.sourcePath, destPath);
        }
        
        // Attempt EXIF write if enabled
        let exifWritten = false;
        let exifSource: string | undefined;
        let exifError: string | undefined;
        
        if (data.settings?.writeExif && file.derivedDate && file.dateConfidence) {
          const derivedDate = new Date(file.derivedDate);
          const exifResult = await writeExifDate(
            destPath,
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
        
        results.push({ 
          success: true, 
          sourcePath: file.sourcePath, 
          destPath, 
          finalFilename,
          exifWritten,
          exifSource,
          exifError
        });
      } catch (err) {
        results.push({ success: false, sourcePath: file.sourcePath, destPath, finalFilename, error: (err as Error).message });
      }
      
    }
    
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

// ─── Search & Discovery IPC handlers ─────────────────────────────────────────

ipcMain.handle('search:init', async () => {
  return initDatabase();
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
      },
    });

    const viewerHtml = app.isPackaged
      ? path.join(process.resourcesPath, 'dist/public/viewer.html')
      : path.join(__dirname, '../dist/public/viewer.html');

    viewerWindow.loadFile(viewerHtml, { query: { files: filesParam } });

    viewerWindow.on('closed', () => {
      viewerWindow = null;
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
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

ipcMain.handle('ai:cancel', async () => {
  cancelAiProcessing();
  return { success: true };
});

ipcMain.handle('ai:status', async () => {
  return { success: true, data: { isProcessing: isAiProcessing() } };
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

ipcMain.handle('ai:assignFace', async (_event, faceId: number, personId: number) => {
  try {
    assignPersonToFace(faceId, personId);
    return { success: true };
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

// Shutdown AI worker on app quit
app.on('before-quit', () => {
  shutdownAiWorker();
});
