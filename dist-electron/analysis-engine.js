import * as fs from 'fs';
import * as path from 'path';
import * as exifParser from 'exif-parser';
import * as unzipper from 'unzipper';
import { extractDateFromFilename, extractXmpMetadataFromBuffer, extractXmpMetadataFromPath, parseGoogleTakeoutJson, parseGoogleTakeoutJsonContent, findGoogleTakeoutSidecar, generateDateBasedFilename, } from './date-extraction-engine.js';
import { isScannerDevice } from './scanner-detection.js';
import { getScannerOverride } from './settings-store.js';
import * as crypto from 'crypto';
// Yield to event loop to keep UI responsive
function yieldToEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}
// Analysis cancellation flag
let analysisCancelled = false;
export function cancelAnalysis() {
    analysisCancelled = true;
}
function calculateFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 }); // 64KB chunks
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}
function calculateBufferHash(buffer) {
    const hash = crypto.createHash('sha256');
    hash.update(buffer);
    return hash.digest('hex');
}
// Files larger than 500MB use heuristic duplicate detection (filename + size)
const LARGE_FILE_THRESHOLD_BYTES = 500 * 1024 * 1024;
// Files smaller than 5MB skip duplicate detection if hash fails (too small for reliable heuristic)
const MIN_HEURISTIC_SIZE_BYTES = 5 * 1024 * 1024;
const PHOTO_EXTENSIONS = new Set([
    '.jpg', '.jpeg', '.jfif', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp',
    '.heic', '.heif', '.avif', '.jp2', '.j2k',
    '.raw', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.rw2', '.pef',
    '.sr2', '.srf', '.raf', '.3fr', '.rwl', '.x3f', '.dcr', '.kdc', '.mrw', '.erf',
    '.ico', '.svg', '.psd',
]);
const VIDEO_EXTENSIONS = new Set([
    '.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v',
    '.3gp', '.3g2', '.mts', '.m2ts', '.ts', '.vob',
    '.mpg', '.mpeg', '.asf', '.divx', '.ogv', '.rm', '.rmvb', '.swf',
]);
function isMediaFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    if (PHOTO_EXTENSIONS.has(ext))
        return 'photo';
    if (VIDEO_EXTENSIONS.has(ext))
        return 'video';
    return null;
}
async function extractExifDateFromPath(filePath) {
    try {
        const fd = await fs.promises.open(filePath, 'r');
        try {
            const buffer = Buffer.alloc(65536);
            const { bytesRead } = await fd.read(buffer, 0, 65536, 0);
            return extractExifDateFromBuffer(buffer.subarray(0, bytesRead));
        }
        finally {
            await fd.close();
        }
    }
    catch (error) {
    }
    return null;
}
// Pull EXIF Make/Model/Software strings from the first 64 KiB of a buffer so
// the analysis phase can run its scanner-detection rule before confidence is
// finalised. Software is used for the long-tail scanner detection (VueScan,
// SilverFast, Epson Scan, ScanGear, etc.). Returns nulls on any error (EXIF
// parsing is best-effort).
function extractExifCameraInfoFromBuffer(buffer) {
    try {
        const parser = exifParser.create(buffer);
        const result = parser.parse();
        const make = result.tags?.Make ? String(result.tags.Make).trim() : null;
        const model = result.tags?.Model ? String(result.tags.Model).trim() : null;
        const software = result.tags?.Software ? String(result.tags.Software).trim() : null;
        return { make, model, software };
    }
    catch {
        return { make: null, model: null, software: null };
    }
}
async function extractExifCameraInfoFromPath(filePath) {
    try {
        const fd = await fs.promises.open(filePath, 'r');
        try {
            const buffer = Buffer.alloc(65536);
            const { bytesRead } = await fd.read(buffer, 0, 65536, 0);
            return extractExifCameraInfoFromBuffer(buffer.subarray(0, bytesRead));
        }
        finally {
            await fd.close();
        }
    }
    catch {
        return { make: null, model: null, software: null };
    }
}
function extractExifDateFromBuffer(buffer) {
    try {
        const parser = exifParser.create(buffer);
        const result = parser.parse();
        const validateTimestamp = (timestamp) => {
            if (!timestamp || timestamp <= 0)
                return null;
            const date = new Date(timestamp * 1000);
            const year = date.getFullYear();
            const now = Date.now();
            const twentyFourHoursMs = 24 * 60 * 60 * 1000;
            if (year < 1970 || date.getTime() > now + twentyFourHoursMs)
                return null;
            return date;
        };
        if (result.tags?.DateTimeOriginal) {
            const date = validateTimestamp(result.tags.DateTimeOriginal);
            if (date)
                return date;
        }
        if (result.tags?.CreateDate) {
            const date = validateTimestamp(result.tags.CreateDate);
            if (date)
                return date;
        }
        if (result.tags?.ModifyDate) {
            const date = validateTimestamp(result.tags.ModifyDate);
            if (date)
                return date;
        }
    }
    catch (error) {
    }
    return null;
}
async function getFileStat(filePath) {
    try {
        const stats = await fs.promises.stat(filePath);
        return { mtime: stats.mtime, ctime: stats.ctime, size: stats.size };
    }
    catch {
        return null;
    }
}
async function analyzeFileFromPath(filePath, filename, sizeBytes) {
    const mediaType = isMediaFile(filename);
    if (!mediaType)
        return null;
    const extension = path.extname(filename).toLowerCase();
    let derivedDate = null;
    let dateSource = '';
    let dateConfidence = 'marked';
    let isWhatsApp = false;
    const sidecarPath = await findGoogleTakeoutSidecar(filePath);
    if (sidecarPath) {
        const takeoutData = parseGoogleTakeoutJson(sidecarPath);
        if (takeoutData?.timestamp) {
            derivedDate = new Date(takeoutData.timestamp * 1000);
            dateSource = 'Google Takeout JSON';
            dateConfidence = 'confirmed';
        }
    }
    if (!derivedDate) {
        const exifDate = await extractExifDateFromPath(filePath);
        if (exifDate) {
            derivedDate = exifDate;
            dateSource = 'EXIF DateTimeOriginal';
            dateConfidence = 'confirmed';
        }
    }
    if (!derivedDate) {
        const xmpData = await extractXmpMetadataFromPath(filePath);
        if (xmpData?.timestamp) {
            derivedDate = new Date(xmpData.timestamp * 1000);
            dateSource = 'XMP metadata';
            dateConfidence = 'confirmed';
        }
    }
    if (!derivedDate) {
        const filenameResult = extractDateFromFilename(filename);
        if (filenameResult.timestamp) {
            derivedDate = new Date(filenameResult.timestamp * 1000);
            dateSource = filenameResult.source;
            dateConfidence = 'recovered';
            isWhatsApp = filenameResult.isWhatsApp;
        }
    }
    if (!derivedDate) {
        const stats = await getFileStat(filePath);
        if (stats) {
            derivedDate = stats.mtime;
            if (stats.mtime < stats.ctime) {
                dateSource = 'Preserved file timestamp';
                dateConfidence = 'recovered';
            }
            else {
                dateSource = 'File modification time';
                dateConfidence = 'marked';
            }
        }
    }
    // Scanner / multifunction-printer demotion — applied before we emit the
    // filename so the suffix (_MK) is baked into the fix output rather than
    // relying on a later re-classification in the search indexer.
    if (dateConfidence !== 'marked') {
        const { make, model, software } = await extractExifCameraInfoFromPath(filePath);
        const override = getScannerOverride(make, model);
        const treatAsScanner = override !== null ? override : isScannerDevice(make, model, software);
        if (treatAsScanner) {
            dateConfidence = 'marked';
            dateSource = dateSource ? `${dateSource} — scanner (likely scan time, not photo date)` : 'Scanner date (likely scan time, not photo date)';
        }
    }
    const suggestedFilename = derivedDate && !isNaN(derivedDate.getTime())
        ? generateDateBasedFilename(Math.floor(derivedDate.getTime() / 1000), extension, dateConfidence)
        : null;
    return {
        path: filePath,
        filename,
        extension,
        type: mediaType,
        sizeBytes,
        dateConfidence,
        dateSource,
        derivedDate: derivedDate && !isNaN(derivedDate.getTime()) ? derivedDate.toISOString() : null,
        originalDate: null,
        suggestedFilename,
    };
}
async function analyzeFileFromBuffer(entryPath, filename, sizeBytes, buffer, entryTime, googleTakeoutJsonContent) {
    const mediaType = isMediaFile(filename);
    if (!mediaType)
        return null;
    const extension = path.extname(filename).toLowerCase();
    let derivedDate = null;
    let dateSource = '';
    let dateConfidence = 'marked';
    let isWhatsApp = false;
    if (googleTakeoutJsonContent) {
        const takeoutData = parseGoogleTakeoutJsonContent(googleTakeoutJsonContent);
        if (takeoutData?.timestamp) {
            derivedDate = new Date(takeoutData.timestamp * 1000);
            dateSource = 'Google Takeout JSON';
            dateConfidence = 'confirmed';
        }
    }
    if (!derivedDate) {
        const exifDate = extractExifDateFromBuffer(buffer);
        if (exifDate) {
            derivedDate = exifDate;
            dateSource = 'EXIF DateTimeOriginal';
            dateConfidence = 'confirmed';
        }
    }
    if (!derivedDate) {
        const xmpData = extractXmpMetadataFromBuffer(buffer);
        if (xmpData?.timestamp) {
            derivedDate = new Date(xmpData.timestamp * 1000);
            dateSource = 'XMP metadata';
            dateConfidence = 'confirmed';
        }
    }
    if (!derivedDate) {
        const filenameResult = extractDateFromFilename(filename);
        if (filenameResult.timestamp) {
            derivedDate = new Date(filenameResult.timestamp * 1000);
            dateSource = filenameResult.source;
            dateConfidence = 'recovered';
            isWhatsApp = filenameResult.isWhatsApp;
        }
    }
    if (!derivedDate && entryTime) {
        derivedDate = entryTime;
        dateSource = 'ZIP entry modification time (fallback)';
        dateConfidence = 'marked';
    }
    // Scanner / multifunction-printer demotion — mirrors the path-based
    // analyzer so ZIP-archive imports are classified consistently.
    if (dateConfidence !== 'marked') {
        const { make, model, software } = extractExifCameraInfoFromBuffer(buffer);
        const override = getScannerOverride(make, model);
        const treatAsScanner = override !== null ? override : isScannerDevice(make, model, software);
        if (treatAsScanner) {
            dateConfidence = 'marked';
            dateSource = dateSource ? `${dateSource} — scanner (likely scan time, not photo date)` : 'Scanner date (likely scan time, not photo date)';
        }
    }
    const suggestedFilename = derivedDate && !isNaN(derivedDate.getTime())
        ? generateDateBasedFilename(Math.floor(derivedDate.getTime() / 1000), extension, dateConfidence)
        : null;
    return {
        path: entryPath,
        filename,
        extension,
        type: mediaType,
        sizeBytes,
        dateConfidence,
        dateSource,
        derivedDate: derivedDate && !isNaN(derivedDate.getTime()) ? derivedDate.toISOString() : null,
        originalDate: null,
        suggestedFilename,
    };
}
async function scanDirectory(dirPath, onProgress) {
    const results = [];
    let fileCounter = 0;
    async function walk(currentPath) {
        try {
            const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
            // Yield after every directory read to prevent "Not Responding"
            await yieldToEventLoop();
            for (const entry of entries) {
                if (analysisCancelled)
                    return;
                const fullPath = path.join(currentPath, entry.name);
                if (entry.isDirectory()) {
                    if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '__MACOSX') {
                        await walk(fullPath);
                    }
                }
                else if (entry.isFile()) {
                    const mediaType = isMediaFile(entry.name);
                    if (mediaType) {
                        try {
                            const stats = await fs.promises.stat(fullPath);
                            results.push({
                                path: fullPath,
                                filename: entry.name,
                                size: stats.size,
                            });
                        }
                        catch {
                            results.push({
                                path: fullPath,
                                filename: entry.name,
                                size: 0,
                            });
                        }
                        fileCounter++;
                        if (fileCounter % 10 === 0) {
                            onProgress?.(fileCounter);
                            await yieldToEventLoop();
                        }
                    }
                }
            }
        }
        catch (error) {
        }
    }
    await walk(dirPath);
    return results;
}
async function scanZipFile(zipPath) {
    const entries = [];
    const jsonContents = new Map();
    // unzipper.Open.file reads the central directory only; per-file
    // contents are pulled on demand via file.buffer() or file.stream().
    const directory = await unzipper.Open.file(zipPath);
    const fileByPath = new Map();
    for (const f of directory.files) {
        if (f.type === 'Directory')
            continue;
        fileByPath.set(f.path, f);
    }
    const totalRawEntryCount = fileByPath.size;
    // Pass 1 — load JSON sidecars into a map. Kept: small payloads, and
    // O(1) lookup for pass 2 is the real speed win this engine was
    // designed around.
    for (const [filePath, file] of fileByPath) {
        if (!filePath.toLowerCase().endsWith('.json'))
            continue;
        try {
            const buf = await file.buffer();
            jsonContents.set(filePath, buf.toString('utf-8'));
        }
        catch (e) {
            console.error('Failed to read JSON sidecar:', filePath, e);
        }
    }
    // Pass 2 — record METADATA only for each media entry. No buffers.
    // Buffers are pulled per-entry during analysis via loadBuffer().
    for (const [filePath, file] of fileByPath) {
        const filename = path.basename(filePath);
        const mediaType = isMediaFile(filename);
        if (!mediaType)
            continue;
        const time = file.lastModifiedDateTime ? new Date(file.lastModifiedDateTime) : null;
        let googleTakeoutJson;
        const jsonPath1 = filePath + '.json';
        const jsonPath2 = filePath.replace(/\.[^/.]+$/, '.json');
        if (jsonContents.has(jsonPath1)) {
            googleTakeoutJson = jsonContents.get(jsonPath1);
        }
        else if (jsonContents.has(jsonPath2)) {
            googleTakeoutJson = jsonContents.get(jsonPath2);
        }
        else {
            for (const [jsonKey, jsonValue] of jsonContents) {
                if (jsonKey.startsWith(filePath + '.') && jsonKey.endsWith('.json')) {
                    googleTakeoutJson = jsonValue;
                    break;
                }
            }
        }
        entries.push({
            path: filePath,
            filename,
            size: file.uncompressedSize,
            time,
            googleTakeoutJson,
        });
    }
    const loadBuffer = async (entryPath) => {
        const file = fileByPath.get(entryPath);
        if (!file)
            throw new Error(`Zip entry not found: ${entryPath}`);
        return await file.buffer();
    };
    // unzipper keeps the file handle open behind the scenes; calling
    // close here lets us release it as soon as analysis finishes.
    const close = async () => {
        try {
            // unzipper's directory doesn't expose an explicit close on all
            // versions, but most v0.12+ builds do. Best-effort only.
            if (typeof directory.close === 'function') {
                await directory.close();
            }
        }
        catch { /* ignore */ }
    };
    return { entries, totalRawEntryCount, loadBuffer, close };
}
export async function analyzeSource(sourcePath, sourceType, onProgress) {
    const sourceLabel = path.basename(sourcePath);
    // Reset cancellation flag at start of new analysis
    analysisCancelled = false;
    onProgress?.({
        current: 0,
        total: 0,
        currentFile: 'Scanning...',
        phase: 'scanning'
    });
    const analyzedFiles = [];
    let photoCount = 0;
    let videoCount = 0;
    let totalSizeBytes = 0;
    let earliestDate = null;
    let latestDate = null;
    const confidenceCounts = { confirmed: 0, recovered: 0, marked: 0 };
    const seenHashes = new Map(); // hash -> first filename
    const seenHeuristics = new Map(); // "filename|size" -> first filename
    const duplicateFiles = [];
    let duplicatesRemoved = 0;
    if (sourceType === 'zip') {
        const scan = await scanZipFile(sourcePath);
        const zipEntries = scan.entries;
        // Honest progress denominator: total entries (media + JSON + misc)
        // rather than media count only. The old bar showed "33%" when we
        // were actually 2/3 through the zip's payload — lying about the
        // work done. Use the full entry count as the denominator, and
        // advance by 1 per media file processed.
        const totalFiles = zipEntries.length;
        const totalEntries = scan.totalRawEntryCount;
        // Files we touch but fail on — reported at end so users see "3
        // files couldn't be processed" instead of one bad entry killing
        // the whole run.
        const failedEntries = [];
        try {
            for (let i = 0; i < zipEntries.length; i++) {
                if (analysisCancelled) {
                    throw new Error('ANALYSIS_CANCELLED');
                }
                const entry = zipEntries[i];
                // Yield every file to keep window responsive (especially for network sources)
                await yieldToEventLoop();
                onProgress?.({
                    current: i + 1,
                    total: totalFiles,
                    currentFile: entry.filename,
                    phase: 'analyzing'
                });
                // Per-entry work wrapped in try/catch so one unreadable file
                // doesn't kill the whole analysis. Memory for this buffer is
                // scoped to the try block — it's released as soon as the
                // iteration ends, so we never hold more than one file at a
                // time in RAM.
                try {
                    // Stream the entry's bytes in on demand. This is where the
                    // memory ceiling dropped from "sum of all media" to "one
                    // file at a time" — the previous engine pre-loaded every
                    // buffer during scan, which OOM'd on multi-GB Takeouts.
                    const buffer = await scan.loadBuffer(entry.path);
                    const result = await analyzeFileFromBuffer(entry.path, entry.filename, entry.size, buffer, entry.time, entry.googleTakeoutJson);
                    if (!result) {
                        continue;
                    }
                    // Check for duplicate using hash (small files) or heuristic (large files)
                    let existingFile;
                    let duplicateMethod = 'hash';
                    if (entry.size > LARGE_FILE_THRESHOLD_BYTES) {
                        // Large file: use heuristic (filename + size)
                        const heuristicKey = `${entry.filename}|${entry.size}`;
                        existingFile = seenHeuristics.get(heuristicKey);
                        duplicateMethod = 'heuristic';
                        if (!existingFile) {
                            seenHeuristics.set(heuristicKey, entry.filename);
                        }
                    }
                    else {
                        // Small/medium file: try hash, fallback to heuristic if it fails
                        try {
                            const hash = calculateBufferHash(buffer);
                            existingFile = seenHashes.get(hash);
                            if (!existingFile) {
                                seenHashes.set(hash, entry.filename);
                            }
                        }
                        catch (hashError) {
                            // Hash failed - use heuristic fallback for files >= 5MB, skip for smaller
                            if (entry.size >= MIN_HEURISTIC_SIZE_BYTES) {
                                const heuristicKey = `${entry.filename}|${entry.size}`;
                                existingFile = seenHeuristics.get(heuristicKey);
                                duplicateMethod = 'heuristic';
                                if (!existingFile) {
                                    seenHeuristics.set(heuristicKey, entry.filename);
                                }
                            }
                            // Files < 5MB: skip duplicate detection entirely (existingFile stays undefined)
                        }
                    }
                    if (existingFile) {
                        // It's a duplicate - flag it but still add to output
                        duplicatesRemoved++;
                        duplicateFiles.push({ filename: entry.filename, duplicateOf: existingFile, type: result.type, duplicateMethod });
                        result.isDuplicate = true;
                        result.duplicateOf = existingFile;
                    }
                    // Always add to output (duplicates are flagged, copy phase decides)
                    analyzedFiles.push(result);
                    totalSizeBytes += result.sizeBytes;
                    if (result.type === 'photo')
                        photoCount++;
                    else if (result.type === 'video')
                        videoCount++;
                    confidenceCounts[result.dateConfidence]++;
                    if (result.derivedDate) {
                        const date = new Date(result.derivedDate);
                        if (!isNaN(date.getTime())) {
                            if (!earliestDate || date < earliestDate)
                                earliestDate = date;
                            if (!latestDate || date > latestDate)
                                latestDate = date;
                        }
                    }
                }
                catch (err) {
                    // Record + continue. Propagate ANALYSIS_CANCELLED so the
                    // outer loop's cancel check fires immediately.
                    if (err?.message === 'ANALYSIS_CANCELLED')
                        throw err;
                    const reason = err?.message ?? String(err);
                    failedEntries.push({ filename: entry.filename, reason });
                    console.warn(`[analysis] skipping ${entry.filename}: ${reason}`);
                }
            }
        }
        finally {
            // Always release the zip file handle, even on cancel / error.
            await scan.close();
        }
        if (failedEntries.length > 0) {
            console.warn(`[analysis] ${failedEntries.length} file${failedEntries.length === 1 ? '' : 's'} couldn't be processed:`, failedEntries.slice(0, 10));
        }
        // Expose the skipped list on the result so the UI can surface it
        // to the user (quiet is worse than "we skipped N files" here).
        globalThis.__pdrLastSkipped = failedEntries;
        void totalEntries;
        onProgress?.({
            current: totalFiles,
            total: totalFiles,
            currentFile: 'Complete',
            phase: 'complete'
        });
    }
    else {
        const fileList = await scanDirectory(sourcePath, (count) => {
            onProgress?.({
                current: 0,
                total: 0,
                currentFile: `Preparing... ${count.toLocaleString()} files found`,
                phase: 'scanning'
            });
        });
        const totalFiles = fileList.length;
        for (let i = 0; i < fileList.length; i++) {
            if (analysisCancelled) {
                throw new Error('ANALYSIS_CANCELLED');
            }
            const file = fileList[i];
            // Yield every file to keep window responsive (especially for network sources)
            await yieldToEventLoop();
            onProgress?.({
                current: i + 1,
                total: totalFiles,
                currentFile: file.filename,
                phase: 'analyzing'
            });
            const result = await analyzeFileFromPath(file.path, file.filename, file.size);
            if (result) {
                // Check for duplicate using hash (small files) or heuristic (large files)
                let existingFile;
                let duplicateMethod = 'hash';
                // Use heuristic (filename + size) for analysis-phase duplicate detection
                // Avoids reading entire files over network; definitive hash check happens at copy time
                const heuristicKey = `${file.filename}|${file.size}`;
                existingFile = seenHeuristics.get(heuristicKey);
                duplicateMethod = 'heuristic';
                if (!existingFile) {
                    seenHeuristics.set(heuristicKey, file.filename);
                }
                if (existingFile) {
                    // It's a duplicate - flag it but still add to output
                    duplicatesRemoved++;
                    duplicateFiles.push({ filename: file.filename, duplicateOf: existingFile, type: result.type, duplicateMethod });
                    result.isDuplicate = true;
                    result.duplicateOf = existingFile;
                }
                // Always add to output (duplicates are flagged, copy phase decides)
                analyzedFiles.push(result);
                totalSizeBytes += result.sizeBytes;
                if (result.type === 'photo')
                    photoCount++;
                else if (result.type === 'video')
                    videoCount++;
                confidenceCounts[result.dateConfidence]++;
                if (result.derivedDate) {
                    const date = new Date(result.derivedDate);
                    if (!isNaN(date.getTime())) {
                        if (!earliestDate || date < earliestDate)
                            earliestDate = date;
                        if (!latestDate || date > latestDate)
                            latestDate = date;
                    }
                }
            }
        }
        onProgress?.({
            current: totalFiles,
            total: totalFiles,
            currentFile: 'Complete',
            phase: 'complete'
        });
    }
    return {
        sourcePath,
        sourceType,
        sourceLabel,
        totalFiles: analyzedFiles.length,
        photoCount,
        videoCount,
        totalSizeBytes,
        dateRange: {
            earliest: earliestDate?.toISOString() || null,
            latest: latestDate?.toISOString() || null,
        },
        confidenceSummary: confidenceCounts,
        duplicatesRemoved,
        duplicateFiles,
        files: analyzedFiles,
    };
}
