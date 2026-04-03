import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { execSync, execFile } from 'child_process';
import { analyzeSource, cancelAnalysis } from './analysis-engine.js';
import AdmZip from 'adm-zip';
import * as unzipper from 'unzipper';
import crypto from 'crypto';
import { saveReport, loadReport, loadLatestReport, listReports, deleteReport, exportReportToCSV, exportReportToTXT, getExportFilename } from './report-storage.js';
import { getSettings, setSetting, setSettings, resetCriticalSettings } from './settings-store.js';
import { writeExifDate, shutdownExiftool } from './exif-writer.js';
import { getLicenseStatus, activateLicense, refreshLicense, deactivateLicense, getMachineFingerprint } from './license-manager.js';
import { checkForUpdates } from './update-checker.js';
import { classifySource, checkSameDriveWarning } from './source-classifier.js';
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
// Streaming copy for large files - yields during copy
async function streamCopyFile(src, dest) {
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
        titleBarStyle: 'hiddenInset',
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
    if (!app.isPackaged) {
        mainWindow.loadURL('http://localhost:5000');
        mainWindow.webContents.openDevTools();
    }
    else {
        mainWindow.loadFile(path.join(__dirname, '../dist/public/index.html'));
    }
    // Apply zoom AFTER the renderer finishes loading
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.setZoomFactor(0.8);
    });
    mainWindow.on('close', () => {
        // Cancel any running operations before window closes
        preScanCancelled = true;
        copyFilesCancelled = true;
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
app.whenReady().then(() => {
    // Remove default Electron menus in production
    if (app.isPackaged) {
        Menu.setApplicationMenu(null);
    }
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
        await shell.openPath(folderPath);
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
    }
    catch (error) {
        console.error('Error getting disk space:', error);
        return { freeBytes: 0, totalBytes: 0 };
    }
});
const PHOTO_EXTENSIONS_PRESCAN = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp', '.heic', '.heif', '.raw', '.cr2', '.nef', '.arw', '.dng']);
const VIDEO_EXTENSIONS_PRESCAN = new Set(['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp', '.mts', '.m2ts']);
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
function calculateFileHashSync(filePath) {
    try {
        const hash = crypto.createHash('sha256');
        const fd = fs.openSync(filePath, 'r');
        const bufferSize = 64 * 1024;
        const buffer = Buffer.alloc(bufferSize);
        let bytesRead;
        while ((bytesRead = fs.readSync(fd, buffer, 0, bufferSize, null)) > 0) {
            hash.update(buffer.subarray(0, bytesRead));
        }
        fs.closeSync(fd);
        return hash.digest('hex');
    }
    catch {
        return null;
    }
}
function calculateBufferHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}
ipcMain.handle('report:save', async (_event, reportData) => {
    try {
        const savedReport = await saveReport(reportData);
        return { success: true, data: savedReport };
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
// Scan destination for existing files and their hashes (for cross-run duplicate detection)
ipcMain.handle('destination:prescan', async (_event, destinationPath) => {
    try {
        const settings = getSettings();
        const useHash = settings.thoroughDuplicateMatching;
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
                            // Hash mode: compute SHA-256
                            const hash = calculateFileHashSync(fullPath);
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
    const { files, destinationPath, zipPaths = {} } = data;
    copyFilesCancelled = false;
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
        if (!fs.existsSync(destinationPath)) {
            fs.mkdirSync(destinationPath, { recursive: true });
        }
        // Snapshot pre-existing files at destination before this run writes anything
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
                    continue;
                }
            }
            // GLOBAL duplicate check at write-time (ignores analysis isDuplicate flag)
            if (skipDuplicates) {
                let existingFile;
                let duplicateMethod = 'hash';
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
                    }
                    catch {
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
                }
                else if (fileSize > LARGE_FILE_THRESHOLD) {
                    // HASH MODE but file too large: heuristic fallback
                    const heuristicKey = `${path.basename(file.sourcePath)}|${fileSize}`;
                    existingFile = writtenHeuristics.get(heuristicKey);
                    duplicateMethod = 'heuristic';
                    if (!existingFile) {
                        writtenHeuristics.set(heuristicKey, file.newFilename);
                    }
                }
                else {
                    // HASH MODE: compute SHA-256 hash
                    try {
                        let hash;
                        if (fileBuffer) {
                            hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
                        }
                        else {
                            // Read file for hashing (async streaming)
                            hash = await new Promise((resolve, reject) => {
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
                    }
                    catch (hashError) {
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
                }
                else if (data.folderStructure === 'year-month') {
                    subfolderPath = path.join(year, month);
                }
                else if (data.folderStructure === 'year-month-day') {
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
                }
                else if (file.sourceType === 'zip') {
                    results.push({ success: false, sourcePath: file.sourcePath, destPath, finalFilename, error: 'Entry not found in zip' });
                    continue;
                }
                else {
                    await streamCopyFile(file.sourcePath, destPath);
                }
                // Attempt EXIF write if enabled
                let exifWritten = false;
                let exifSource;
                let exifError;
                if (data.settings?.writeExif && file.derivedDate && file.dateConfidence) {
                    const derivedDate = new Date(file.derivedDate);
                    const exifResult = await writeExifDate(destPath, derivedDate, file.dateConfidence, file.dateSource || 'Unknown', {
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
                results.push({
                    success: true,
                    sourcePath: file.sourcePath,
                    destPath,
                    finalFilename,
                    exifWritten,
                    exifSource,
                    exifError
                });
            }
            catch (err) {
                results.push({ success: false, sourcePath: file.sourcePath, destPath, finalFilename, error: err.message });
            }
        }
        return { success: true, results, copied: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, duplicatesRemoved, duplicateFiles, skippedExisting };
    }
    catch (error) {
        return { success: false, error: error.message, results, duplicatesRemoved, duplicateFiles };
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
ipcMain.handle('report:exportCSV', async (_event, reportId) => {
    try {
        const report = await loadReport(reportId);
        if (!report) {
            return { success: false, error: 'Report not found' };
        }
        const csv = exportReportToCSV(report);
        const defaultFilename = getExportFilename(report, 'csv');
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
ipcMain.handle('report:exportTXT', async (_event, reportId) => {
    try {
        const report = await loadReport(reportId);
        if (!report) {
            return { success: false, error: 'Report not found' };
        }
        const txt = exportReportToTXT(report);
        const defaultFilename = getExportFilename(report, 'txt');
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
ipcMain.handle('set-zoom', (_event, zoomFactor) => {
    if (mainWindow) {
        mainWindow.webContents.setZoomFactor(zoomFactor);
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
