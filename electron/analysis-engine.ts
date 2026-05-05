import * as fs from 'fs';
import * as path from 'path';
import * as exifParser from 'exif-parser';
import * as unzipper from 'unzipper';
import * as mimeTypes from 'mime-types';
import {
  extractDateFromFilename,
  extractXmpMetadataFromBuffer,
  extractXmpMetadataFromPath,
  parseGoogleTakeoutJson,
  parseGoogleTakeoutJsonContent,
  findGoogleTakeoutSidecar,
  generateDateBasedFilename,
} from './date-extraction-engine.js';
import { isScannerDevice } from './scanner-detection.js';
import { getScannerOverride } from './settings-store.js';
import { classifySource } from './source-classifier.js';
import * as crypto from 'crypto';

// Yield to event loop to keep UI responsive
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// Analysis cancellation flag
let analysisCancelled = false;

export function cancelAnalysis(): void {
  analysisCancelled = true;
}

// ── Diagnostic logging ──────────────────────────────────────────────
// Used during release-QA runs (e.g. bypass-pre-extract on a 50 GB
// Google Takeout) to surface phase markers, periodic memory
// snapshots, per-large-file timings, skip-and-continue reasons, and
// a final summary. Calls go to:
//   • console.log → main-process stdout, captured by electron-log
//     into %APPDATA%\Photo Date Rescue\logs\main.log.
//   • diagSink (when set) → IPC channel `analysis:diagnostic`,
//     forwarded to the renderer's F12 console for live monitoring.
let diagSink: ((msg: string) => void) | null = null;
function diag(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const line = `[PDR-DIAG ${ts}] ${msg}`;
  // Main-process log (file + terminal in dev)
  console.log(line);
  // Forward to renderer if a sink is set for this analysis
  try { diagSink?.(line); } catch {}
}
function memSnapshotMB(): { rss: number; heapUsed: number; heapTotal: number; external: number } {
  const m = process.memoryUsage();
  const toMB = (b: number) => Math.round(b / (1024 * 1024));
  return {
    rss: toMB(m.rss),
    heapUsed: toMB(m.heapUsed),
    heapTotal: toMB(m.heapTotal),
    external: toMB(m.external),
  };
}
let peakRssMB = 0;
let peakHeapUsedMB = 0;
function recordPeakMem(): void {
  const m = memSnapshotMB();
  if (m.rss > peakRssMB) peakRssMB = m.rss;
  if (m.heapUsed > peakHeapUsedMB) peakHeapUsedMB = m.heapUsed;
}

function calculateFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 }); // 64KB chunks
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function calculateBufferHash(buffer: Buffer): string {
  const hash = crypto.createHash('sha256');
  hash.update(buffer);
  return hash.digest('hex');
}

/**
 * Async chunked variant of calculateBufferHash. Same SHA-256 output
 * as the sync version but feeds the buffer into the hasher in 64 KB
 * slices and yields to the event loop every 8 MB.
 *
 * Why: the sync hash blocks the main thread for ~100-300 ms on a
 * 500 MB buffer (one round of the analysis loop's dedup check on a
 * multi-GB phone video), making the UI stutter every time we hit a
 * large file. The yields keep the event loop alive so progress
 * updates + IPC events keep flowing during the hash. Memory peak
 * unchanged — buffer is still held by the caller, we just slice it.
 *
 * Full disk-streaming hash for the under-500-MB zip path is a
 * bigger refactor (the zip path doesn't materialise files on disk;
 * it streams entries from the open zip). Deferred to v2.1.0.
 */
async function calculateBufferHashAsync(buffer: Buffer): Promise<string> {
  const hash = crypto.createHash('sha256');
  const chunkSize = 64 * 1024;
  const yieldEvery = 8 * 1024 * 1024;
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, buffer.length);
    hash.update(buffer.subarray(i, end));
    if (i > 0 && i % yieldEvery === 0) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  return hash.digest('hex');
}

// Files larger than 500MB use heuristic duplicate detection (filename + size)
const LARGE_FILE_THRESHOLD_BYTES = 500 * 1024 * 1024;
// Files smaller than 5MB skip duplicate detection if hash fails (too small for reliable heuristic)
const MIN_HEURISTIC_SIZE_BYTES = 5 * 1024 * 1024;

export interface AnalysisProgress {
  current: number;
  total: number;
  currentFile: string;
  phase: 'scanning' | 'analyzing' | 'complete';
}

export interface FileAnalysisResult {
  path: string;
  filename: string;
  extension: string;
  type: 'photo' | 'video';
  sizeBytes: number;
  dateConfidence: 'confirmed' | 'recovered' | 'marked';
  dateSource: string;
  derivedDate: string | null;
  originalDate: string | null;
  suggestedFilename: string | null;
  isDuplicate?: boolean;
  duplicateOf?: string;
}

export interface SourceAnalysisResult {
  sourcePath: string;
  sourceType: 'folder' | 'zip' | 'drive';
  sourceLabel: string;
  totalFiles: number;
  photoCount: number;
  videoCount: number;
  totalSizeBytes: number;
  dateRange: {
    earliest: string | null;
    latest: string | null;
  };
  confidenceSummary: {
    confirmed: number;
    recovered: number;
    marked: number;
  };
  duplicatesRemoved: number;
  duplicateFiles: Array<{ filename: string; duplicateOf: string; type: 'photo' | 'video'; duplicateMethod: 'hash' | 'heuristic' }>;
  /** Files the engine tried to process but couldn't — corrupt zip
   *  entries, decompression failures, unreadable bytes. Empty array
   *  on a clean run. Rendered in the "Source added" card so users
   *  see exactly which files didn't make it into the destination. */
  skippedFiles: Array<{ filename: string; reason: string }>;
  files: FileAnalysisResult[];
}

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

function isMediaFile(filename: string): 'photo' | 'video' | null {
  const ext = path.extname(filename).toLowerCase();
  if (PHOTO_EXTENSIONS.has(ext)) return 'photo';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return null;
}

async function extractExifDateFromPath(filePath: string): Promise<Date | null> {
  try {
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await fd.read(buffer, 0, 65536, 0);
      return extractExifDateFromBuffer(buffer.subarray(0, bytesRead));
    } finally {
      await fd.close();
    }
  } catch (error) {
  }
  return null;
}

// Pull EXIF Make/Model/Software strings from the first 64 KiB of a buffer so
// the analysis phase can run its scanner-detection rule before confidence is
// finalised. Software is used for the long-tail scanner detection (VueScan,
// SilverFast, Epson Scan, ScanGear, etc.). Returns nulls on any error (EXIF
// parsing is best-effort).
function extractExifCameraInfoFromBuffer(buffer: Buffer): { make: string | null; model: string | null; software: string | null } {
  try {
    const parser = exifParser.create(buffer);
    const result = parser.parse();
    const make = result.tags?.Make ? String(result.tags.Make).trim() : null;
    const model = result.tags?.Model ? String(result.tags.Model).trim() : null;
    const software = (result.tags as any)?.Software ? String((result.tags as any).Software).trim() : null;
    return { make, model, software };
  } catch {
    return { make: null, model: null, software: null };
  }
}

async function extractExifCameraInfoFromPath(filePath: string): Promise<{ make: string | null; model: string | null; software: string | null }> {
  try {
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await fd.read(buffer, 0, 65536, 0);
      return extractExifCameraInfoFromBuffer(buffer.subarray(0, bytesRead));
    } finally {
      await fd.close();
    }
  } catch {
    return { make: null, model: null, software: null };
  }
}

function extractExifDateFromBuffer(buffer: Buffer): Date | null {
  try {
    const parser = exifParser.create(buffer);
    const result = parser.parse();
    
	const validateTimestamp = (timestamp: number): Date | null => {
	  if (!timestamp || timestamp <= 0) return null;
	  const date = new Date(timestamp * 1000);
	  const year = date.getFullYear();
	  const now = Date.now();
	  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
	  if (year < 1970 || date.getTime() > now + twentyFourHoursMs) return null;
	  return date;
	};
    
    if (result.tags?.DateTimeOriginal) {
      const date = validateTimestamp(result.tags.DateTimeOriginal);
      if (date) return date;
    }
    if (result.tags?.CreateDate) {
      const date = validateTimestamp(result.tags.CreateDate);
      if (date) return date;
    }
    if (result.tags?.ModifyDate) {
      const date = validateTimestamp(result.tags.ModifyDate);
      if (date) return date;
    }
  } catch (error) {
  }
  return null;
}

async function getFileStat(filePath: string): Promise<{ mtime: Date; ctime: Date; size: number } | null> {
  try {
    const stats = await fs.promises.stat(filePath);
    return { mtime: stats.mtime, ctime: stats.ctime, size: stats.size };
  } catch {
    return null;
  }
}

async function analyzeFileFromPath(filePath: string, filename: string, sizeBytes: number): Promise<FileAnalysisResult | null> {
  const mediaType = isMediaFile(filename);
  if (!mediaType) return null;

  const extension = path.extname(filename).toLowerCase();
  let derivedDate: Date | null = null;
  let dateSource = '';
  let dateConfidence: 'confirmed' | 'recovered' | 'marked' = 'marked';
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
      } else {
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
    ? generateDateBasedFilename(
        Math.floor(derivedDate.getTime() / 1000),
        extension,
        dateConfidence
      )
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

async function analyzeFileFromBuffer(
  entryPath: string, 
  filename: string, 
  sizeBytes: number, 
  buffer: Buffer,
  entryTime: Date | null,
  googleTakeoutJsonContent?: string
): Promise<FileAnalysisResult | null> {
  const mediaType = isMediaFile(filename);
  if (!mediaType) return null;

  const extension = path.extname(filename).toLowerCase();
  let derivedDate: Date | null = null;
  let dateSource = '';
  let dateConfidence: 'confirmed' | 'recovered' | 'marked' = 'marked';
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
    ? generateDateBasedFilename(
        Math.floor(derivedDate.getTime() / 1000),
        extension,
        dateConfidence
      )
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

/**
 * Metadata-only date analysis for a zip entry whose buffer we cannot
 * safely load — typically a phone video over ~500 MB where Node's
 * contiguous Buffer allocation becomes unreliable. Mirrors the same
 * date-resolution waterfall as `analyzeFileFromBuffer` but skips the
 * two buffer-dependent steps (EXIF + XMP):
 *
 *   1. Google Takeout JSON sidecar      → `confirmed`
 *   2. (skipped — no buffer for EXIF)
 *   3. (skipped — no buffer for XMP)
 *   4. Filename pattern                  → `recovered`
 *   5. ZIP entry modification time       → `marked`
 *
 * Coverage in practice: phone videos almost always have either a
 * dated Takeout sidecar or a date-bearing filename (`VID_YYYYMMDD…`),
 * so the missing EXIF/XMP signals rarely matter. Scanner-detection is
 * also skipped here — videos virtually never come from scanners, and
 * the rare >500 MB photo from a scanner is acceptable to mis-classify
 * for the safety win of avoiding a Buffer.allocUnsafe RangeError that
 * would crash the analysis loop.
 */
async function analyzeFileMetadataOnly(
  entryPath: string,
  filename: string,
  sizeBytes: number,
  entryTime: Date | null,
  googleTakeoutJsonContent?: string,
): Promise<FileAnalysisResult | null> {
  const mediaType = isMediaFile(filename);
  if (!mediaType) return null;

  const extension = path.extname(filename).toLowerCase();
  let derivedDate: Date | null = null;
  let dateSource = '';
  let dateConfidence: 'confirmed' | 'recovered' | 'marked' = 'marked';

  if (googleTakeoutJsonContent) {
    const takeoutData = parseGoogleTakeoutJsonContent(googleTakeoutJsonContent);
    if (takeoutData?.timestamp) {
      derivedDate = new Date(takeoutData.timestamp * 1000);
      dateSource = 'Google Takeout JSON';
      dateConfidence = 'confirmed';
    }
  }

  if (!derivedDate) {
    const filenameResult = extractDateFromFilename(filename);
    if (filenameResult.timestamp) {
      derivedDate = new Date(filenameResult.timestamp * 1000);
      dateSource = filenameResult.source;
      dateConfidence = 'recovered';
    }
  }

  if (!derivedDate && entryTime) {
    derivedDate = entryTime;
    dateSource = 'ZIP entry modification time (fallback)';
    dateConfidence = 'marked';
  }

  const suggestedFilename = derivedDate && !isNaN(derivedDate.getTime())
    ? generateDateBasedFilename(
        Math.floor(derivedDate.getTime() / 1000),
        extension,
        dateConfidence,
      )
    : null;

  return {
    path: entryPath,
    filename,
    extension,
    type: mediaType,
    sizeBytes,
    dateConfidence,
    dateSource: dateSource || 'No date signal available (large file, no sidecar, no filename pattern, no zip mtime)',
    derivedDate: derivedDate && !isNaN(derivedDate.getTime()) ? derivedDate.toISOString() : null,
    originalDate: null,
    suggestedFilename,
  };
}

async function scanDirectory(
  dirPath: string,
  onProgress?: (count: number) => void
): Promise<Array<{ path: string; filename: string; size: number }>> {
  const results: Array<{ path: string; filename: string; size: number }> = [];
  let fileCounter = 0;
  
  async function walk(currentPath: string) {
    try {
      const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
      // Yield after every directory read to prevent "Not Responding"
      await yieldToEventLoop();
      
      for (const entry of entries) {
        if (analysisCancelled) return;
        const fullPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '__MACOSX') {
            await walk(fullPath);
          }
        } else if (entry.isFile()) {
          const mediaType = isMediaFile(entry.name);
          if (mediaType) {
            try {
              const stats = await fs.promises.stat(fullPath);
              results.push({
                path: fullPath,
                filename: entry.name,
                size: stats.size,
              });
            } catch {
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
    } catch (error) {
    }
  }
  
  await walk(dirPath);
  return results;
}

interface ZipEntry {
  path: string;
  filename: string;
  size: number;
  time: Date | null;
  googleTakeoutJson?: string;
}

/**
 * Scan a zip via unzipper's central-directory reader and return a
 * plan for the analysis loop: every media entry's metadata PLUS its
 * matched Google Takeout JSON sidecar (if any). The media bytes are
 * NOT loaded here — they're streamed one at a time in the analysis
 * loop via the returned `loadBuffer(path)` helper. Also returns a
 * `close()` callback so the caller can release file handles when
 * the run finishes.
 *
 * This is the memory-ceiling fix that enables large Google Takeouts
 * to analyse on machines with modest RAM. Pass 1 (build a JSON map)
 * is kept intact because it's an O(1)-lookup speed win; Pass 2 used
 * to call entry.getData() on every media file up-front, holding ~GB
 * of buffers resident. Now Pass 2 only records metadata, and bytes
 * are pulled per-file during analysis and released immediately after.
 */
interface ZipScanResult {
  entries: ZipEntry[];
  totalRawEntryCount: number;   // EVERY entry including JSON + misc — for honest progress
  loadBuffer: (entryPath: string) => Promise<Buffer>;
  close: () => Promise<void>;
}

async function scanZipFile(zipPath: string): Promise<ZipScanResult> {
  const entries: ZipEntry[] = [];
  const jsonContents: Map<string, string> = new Map();

  diag(`◆ scanZipFile: opening "${path.basename(zipPath)}" — reading central directory`);
  const dirOpenStart = Date.now();

  // unzipper.Open.file reads the central directory only; per-file
  // contents are pulled on demand via file.buffer() or file.stream().
  const directory = await unzipper.Open.file(zipPath);
  const fileByPath = new Map<string, any>();
  for (const f of directory.files) {
    if (f.type === 'Directory') continue;
    fileByPath.set(f.path, f);
  }
  const totalRawEntryCount = fileByPath.size;
  diag(`  central directory ready: ${totalRawEntryCount.toLocaleString()} entries (${Date.now() - dirOpenStart} ms)`);

  // Pass 1 — load JSON sidecars into a map. Kept: small payloads, and
  // O(1) lookup for pass 2 is the real speed win this engine was
  // designed around.
  diag(`◆ Pass 1: loading JSON sidecars`);
  const pass1Start = Date.now();
  let jsonCount = 0;
  let jsonBytes = 0;
  for (const [filePath, file] of fileByPath) {
    if (!filePath.toLowerCase().endsWith('.json')) continue;
    try {
      const buf = await file.buffer();
      jsonContents.set(filePath, buf.toString('utf-8'));
      jsonCount++;
      jsonBytes += buf.length;
    } catch (e) {
      console.error('Failed to read JSON sidecar:', filePath, e);
    }
  }
  recordPeakMem();
  const pass1Mem = memSnapshotMB();
  diag(`  Pass 1 complete: ${jsonCount.toLocaleString()} JSON sidecars, ${(jsonBytes / (1024 * 1024)).toFixed(1)} MB total (${Date.now() - pass1Start} ms) — mem rss=${pass1Mem.rss} MB heapUsed=${pass1Mem.heapUsed} MB`);

  // Pass 2 — record METADATA only for each media entry. No buffers.
  // Buffers are pulled per-entry during analysis via loadBuffer().
  diag(`◆ Pass 2: recording media-entry metadata (no buffers)`);
  const pass2Start = Date.now();
  for (const [filePath, file] of fileByPath) {
    const filename = path.basename(filePath);
    const mediaType = isMediaFile(filename);
    if (!mediaType) continue;

    const time = file.lastModifiedDateTime ? new Date(file.lastModifiedDateTime) : null;

    let googleTakeoutJson: string | undefined;
    const jsonPath1 = filePath + '.json';
    const jsonPath2 = filePath.replace(/\.[^/.]+$/, '.json');
    if (jsonContents.has(jsonPath1)) {
      googleTakeoutJson = jsonContents.get(jsonPath1);
    } else if (jsonContents.has(jsonPath2)) {
      googleTakeoutJson = jsonContents.get(jsonPath2);
    } else {
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
  recordPeakMem();
  const pass2Mem = memSnapshotMB();
  diag(`  Pass 2 complete: ${entries.length.toLocaleString()} media entries (${Date.now() - pass2Start} ms) — mem rss=${pass2Mem.rss} MB heapUsed=${pass2Mem.heapUsed} MB`);

  const loadBuffer = async (entryPath: string): Promise<Buffer> => {
    const file = fileByPath.get(entryPath);
    if (!file) throw new Error(`Zip entry not found: ${entryPath}`);
    // Implemented as our own stream-collect rather than calling
    // unzipper's `file.buffer()` because that helper concatenates
    // chunks inside a stream `finish` listener — when the resulting
    // `Buffer.concat()` throws RangeError (e.g. on a multi-GB phone
    // video that exceeds Node's contiguous Buffer allocation limit),
    // the throw escapes synchronously from a `process.nextTick` and
    // reaches Electron's uncaught-exception handler, popping a
    // crash dialog despite the analysis loop wrapping its calls in
    // a try/catch. Building the same logic ourselves with a Promise
    // executor lets us route Buffer.concat failures into the
    // Promise's reject path, where the awaiter's try/catch can
    // handle it cleanly as a skip-and-continue. Reproduced on a
    // 50 GB Google Takeout containing a 1,388 MB phone video,
    // 04/05/2026.
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      let settled = false;
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
      try {
        const stream = file.stream();
        stream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          totalSize += chunk.length;
        });
        stream.on('end', () => {
          try {
            const result = Buffer.concat(chunks, totalSize);
            settle(() => resolve(result));
          } catch (concatErr) {
            settle(() => reject(concatErr));
          }
        });
        stream.on('error', (streamErr: unknown) => {
          settle(() => reject(streamErr));
        });
      } catch (syncErr) {
        // Belt-and-braces: synchronous throw from file.stream() itself.
        settle(() => reject(syncErr));
      }
    });
  };

  // unzipper keeps the file handle open behind the scenes; calling
  // close here lets us release it as soon as analysis finishes.
  const close = async () => {
    try {
      // unzipper's directory doesn't expose an explicit close on all
      // versions, but most v0.12+ builds do. Best-effort only.
      if (typeof (directory as any).close === 'function') {
        await (directory as any).close();
      }
    } catch { /* ignore */ }
  };

  return { entries, totalRawEntryCount, loadBuffer, close };
}

export async function analyzeSource(
  sourcePath: string,
  sourceType: 'folder' | 'zip' | 'drive',
  onProgress?: (progress: AnalysisProgress) => void,
  onDiagnostic?: (msg: string) => void
): Promise<SourceAnalysisResult> {
  const sourceLabel = path.basename(sourcePath);

  // Reset cancellation flag at start of new analysis
  analysisCancelled = false;

  // Wire up the diagnostic sink for the duration of THIS analysis.
  // Reset on the way out so a subsequent analysis without an
  // onDiagnostic callback doesn't accidentally inherit a stale sink.
  diagSink = onDiagnostic ?? null;
  peakRssMB = 0;
  peakHeapUsedMB = 0;
  const analysisStartedAt = Date.now();
  const initialMem = memSnapshotMB();
  diag(`▶ Analysis START — ${sourceType} "${sourceLabel}" (path=${sourcePath})`);
  diag(`  initial mem: rss=${initialMem.rss} MB, heapUsed=${initialMem.heapUsed} MB / heapTotal=${initialMem.heapTotal} MB, external=${initialMem.external} MB`);
  if (sourceType === 'zip') {
    try {
      const sizeMB = Math.round(fs.statSync(sourcePath).size / (1024 * 1024));
      diag(`  zip size on disk: ${sizeMB} MB`);
    } catch { /* best-effort */ }
  }

  onProgress?.({
    current: 0,
    total: 0,
    currentFile: 'Scanning...',
    phase: 'scanning'
  });

  const analyzedFiles: FileAnalysisResult[] = [];
  let photoCount = 0;
  let videoCount = 0;
  let totalSizeBytes = 0;
  let earliestDate: Date | null = null;
  let latestDate: Date | null = null;
  const confidenceCounts = { confirmed: 0, recovered: 0, marked: 0 };
  
const seenHashes = new Map<string, string>(); // hash -> first filename
const seenHeuristics = new Map<string, string>(); // "filename|size" -> first filename
const duplicateFiles: Array<{ filename: string; duplicateOf: string; type: 'photo' | 'video'; duplicateMethod: 'hash' | 'heuristic' }> = [];
let duplicatesRemoved = 0;
// Skip-and-continue accumulator — per-file failures during zip
// analysis so the UI can show "3 files couldn't be processed" on
// the completion card with reasons.
const skippedFiles: Array<{ filename: string; reason: string }> = [];

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

    diag(`◆ Analysis loop START — ${totalFiles.toLocaleString()} media files to process`);
    const loopStart = Date.now();
    let lastMemSnapshotAt = loopStart;
    const LARGE_FILE_TIMING_THRESHOLD = 100 * 1024 * 1024; // 100 MB
    const MEM_SNAPSHOT_INTERVAL_MS = 2000;

    try {
      for (let i = 0; i < zipEntries.length; i++) {
        if (analysisCancelled) {
          throw new Error('ANALYSIS_CANCELLED');
        }

        const entry = zipEntries[i];

        // Yield every file to keep window responsive (especially for network sources)
        await yieldToEventLoop();

        // Periodic memory snapshot — every ~2 s wall-clock, regardless
        // of how many files have been processed. Lets us spot a slow
        // creep across the loop even when individual files are small.
        const nowTs = Date.now();
        if (nowTs - lastMemSnapshotAt >= MEM_SNAPSHOT_INTERVAL_MS) {
          recordPeakMem();
          const m = memSnapshotMB();
          const pct = totalFiles > 0 ? Math.round(((i + 1) / totalFiles) * 100) : 0;
          diag(`  ⌚ ${i + 1}/${totalFiles} (${pct}%) — rss=${m.rss} MB, heapUsed=${m.heapUsed} MB, peakRss=${peakRssMB} MB, peakHeap=${peakHeapUsedMB} MB`);
          lastMemSnapshotAt = nowTs;
        }

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
        const fileStart = entry.size > LARGE_FILE_TIMING_THRESHOLD ? Date.now() : 0;
        try {
          // Per-file size guard: phone videos and large RAW frames
          // can exceed Node's reliable contiguous Buffer allocation
          // limit. When that happens unzipper's Buffer.concat throws
          // RangeError from a stream `finish` listener, which the
          // older code routed through file.buffer() → escapes the
          // try/catch as an uncaughtException. Even with the safer
          // stream-collect we wired into loadBuffer, allocating a
          // 1.4 GB Buffer on a 16 GB machine is unreliable and slow.
          // For files over LARGE_BUFFER_LOAD_THRESHOLD we skip the
          // buffer entirely and use the metadata-only analysis path
          // (Google JSON sidecar + filename + zip mtime). Phone
          // videos almost always carry a dated sidecar or filename
          // pattern, so the lost EXIF/XMP signal rarely matters in
          // practice.
          const LARGE_BUFFER_LOAD_THRESHOLD = 500 * 1024 * 1024; // 500 MB
          let result: FileAnalysisResult | null;
          if (entry.size > LARGE_BUFFER_LOAD_THRESHOLD) {
            diag(`  ⤳ ${entry.filename} (${(entry.size / (1024 * 1024)).toFixed(0)} MB) — metadata-only path (skipping buffer load)`);
            result = await analyzeFileMetadataOnly(
              entry.path,
              entry.filename,
              entry.size,
              entry.time,
              entry.googleTakeoutJson,
            );
            if (!result) {
              continue;
            }
            // Large files always use heuristic dedup downstream
            // (matches the existing >500 MB branch in this loop) —
            // this comment + the `dedupe-only` shape below let the
            // existing dedup block handle the rest unchanged.
            const heuristicKey = `${entry.filename}|${entry.size}`;
            const existingFile = seenHeuristics.get(heuristicKey);
            if (existingFile) {
              duplicatesRemoved++;
              duplicateFiles.push({ filename: entry.filename, duplicateOf: existingFile, type: result.type, duplicateMethod: 'heuristic' });
              result.isDuplicate = true;
              result.duplicateOf = existingFile;
            } else {
              seenHeuristics.set(heuristicKey, entry.filename);
            }
            analyzedFiles.push(result);
            totalSizeBytes += result.sizeBytes;
            if (result.type === 'photo') photoCount++;
            else if (result.type === 'video') videoCount++;
            confidenceCounts[result.dateConfidence]++;
            if (result.derivedDate) {
              const date = new Date(result.derivedDate);
              if (!isNaN(date.getTime())) {
                if (!earliestDate || date < earliestDate) earliestDate = date;
                if (!latestDate || date > latestDate) latestDate = date;
              }
            }
            // Per-file timing for files over the timing threshold
            if (fileStart > 0) {
              const sizeMB = (entry.size / (1024 * 1024)).toFixed(1);
              diag(`  ⏱ large file (metadata-only): ${entry.filename} (${sizeMB} MB) processed in ${Date.now() - fileStart} ms`);
            }
            continue;
          }

          // Stream the entry's bytes in on demand. This is where the
          // memory ceiling dropped from "sum of all media" to "one
          // file at a time" — the previous engine pre-loaded every
          // buffer during scan, which OOM'd on multi-GB Takeouts.
          const buffer = await scan.loadBuffer(entry.path);

          result = await analyzeFileFromBuffer(entry.path, entry.filename, entry.size, buffer, entry.time, entry.googleTakeoutJson);
          if (!result) {
            continue;
          }

          // Check for duplicate using hash (small files) or heuristic (large files)
          let existingFile: string | undefined;
          let duplicateMethod: 'hash' | 'heuristic' = 'hash';

          if (entry.size > LARGE_FILE_THRESHOLD_BYTES) {
            // Large file: use heuristic (filename + size)
            const heuristicKey = `${entry.filename}|${entry.size}`;
            existingFile = seenHeuristics.get(heuristicKey);
            duplicateMethod = 'heuristic';
            if (!existingFile) {
              seenHeuristics.set(heuristicKey, entry.filename);
            }
          } else {
            // Small/medium file: try hash, fallback to heuristic if it fails.
            // Async chunked variant so the hash of a multi-hundred-MB buffer
            // doesn't block the main thread — keeps progress events + IPC
            // flowing during the hash. Same SHA-256 output as the sync version.
            try {
              const hash = await calculateBufferHashAsync(buffer);
              existingFile = seenHashes.get(hash);
              if (!existingFile) {
                seenHashes.set(hash, entry.filename);
              }
            } catch (hashError) {
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

          if (result.type === 'photo') photoCount++;
          else if (result.type === 'video') videoCount++;

          confidenceCounts[result.dateConfidence]++;

          if (result.derivedDate) {
            const date = new Date(result.derivedDate);
            if (!isNaN(date.getTime())) {
              if (!earliestDate || date < earliestDate) earliestDate = date;
              if (!latestDate || date > latestDate) latestDate = date;
            }
          }
        } catch (err) {
          // Record + continue. Propagate ANALYSIS_CANCELLED so the
          // outer loop's cancel check fires immediately.
          if ((err as Error)?.message === 'ANALYSIS_CANCELLED') throw err;
          const reason = (err as Error)?.message ?? String(err);
          skippedFiles.push({ filename: entry.filename, reason });
          const sizeMB = (entry.size / (1024 * 1024)).toFixed(1);
          diag(`  ⚠ SKIP ${entry.filename} (${sizeMB} MB) — ${reason}`);
          console.warn(`[analysis] skipping ${entry.filename}: ${reason}`);
        }

        // After the iteration completes, log per-file timing for
        // anything over the large-file threshold so we can see if a
        // specific file (e.g. a long phone video) stalls the loop.
        if (fileStart > 0) {
          const sizeMB = (entry.size / (1024 * 1024)).toFixed(1);
          diag(`  ⏱ large file: ${entry.filename} (${sizeMB} MB) processed in ${Date.now() - fileStart} ms`);
        }
      }
    } finally {
      // Always release the zip file handle, even on cancel / error.
      await scan.close();
    }

    if (skippedFiles.length > 0) {
      console.warn(`[analysis] ${skippedFiles.length} file${skippedFiles.length === 1 ? '' : 's'} couldn't be processed:`, skippedFiles.slice(0, 10));
    }
    void totalEntries;

    recordPeakMem();
    const finalMem = memSnapshotMB();
    const elapsedSec = ((Date.now() - loopStart) / 1000).toFixed(1);
    const totalElapsedSec = ((Date.now() - analysisStartedAt) / 1000).toFixed(1);
    diag(`◆ Analysis loop COMPLETE — ${totalFiles.toLocaleString()} processed, ${skippedFiles.length} skipped (${elapsedSec}s loop, ${totalElapsedSec}s total)`);
    diag(`  final mem: rss=${finalMem.rss} MB, heapUsed=${finalMem.heapUsed} MB`);
    diag(`  PEAK mem during analysis: rss=${peakRssMB} MB, heapUsed=${peakHeapUsedMB} MB`);
    diag(`  dedup: ${seenHashes.size} unique hashes, ${seenHeuristics.size} heuristic keys, ${duplicatesRemoved} duplicates flagged`);

    onProgress?.({
      current: totalFiles,
      total: totalFiles,
      currentFile: 'Complete',
      phase: 'complete'
    });
  } else {
    const fileList = await scanDirectory(sourcePath, (count) => {
      onProgress?.({
        current: 0,
        total: 0,
        currentFile: `Preparing... ${count.toLocaleString()} files found`,
        phase: 'scanning'
      });
    });
    const totalFiles = fileList.length;

    // Dedup policy for the folder path (raw folders, drives, AND
    // pre-extracted ZIPs which arrive here as effectiveType='folder'):
    //   • Local source — SHA-256 stream-hash for files < 500 MB,
    //     heuristic (filename + size) for >= 500 MB. Matches the
    //     streaming-zip path's behaviour and PDR's design baseline
    //     ("hash everything except large files where it would tank
    //     performance").
    //   • Network / cloud-sync source — heuristic for everything.
    //     Reading every photo in full over Wi-Fi during analysis
    //     turns a single zip into hours; the user is treated as
    //     having opted into a slower flow by picking that source.
    // The streaming hash uses calculateFileHash (64 KB chunks) so
    // there's no full-file buffer in memory — only a rolling crypto
    // state. seenHashes vs seenHeuristics stay separate so a
    // mid-run mode flip wouldn't false-positive across maps.
    const sourceStorage = classifySource(sourcePath);
    const useHashDedup = sourceStorage.type !== 'network' && sourceStorage.type !== 'cloud-sync';
    diag(`◆ folder-path dedup mode: ${useHashDedup ? 'SHA-256 (<500 MB)' : 'heuristic-only'} — source=${sourceStorage.label}`);

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
        // SHA-256 for local <500 MB files; heuristic for >=500 MB
        // OR for any network/cloud source (see dedup-mode comment
        // above). calculateFileHash streams from disk in 64 KB chunks
        // so memory stays flat. On any hash failure (corrupt file,
        // permission denied) we fall through to heuristic so the
        // file still gets a dedup attempt.
        let existingFile: string | undefined;
        let duplicateMethod: 'hash' | 'heuristic' = 'heuristic';
        if (useHashDedup && file.size < LARGE_FILE_THRESHOLD_BYTES) {
          try {
            const hash = await calculateFileHash(file.path);
            existingFile = seenHashes.get(hash);
            duplicateMethod = 'hash';
            if (!existingFile) {
              seenHashes.set(hash, file.filename);
            }
          } catch {
            // Hash failed — fall back to heuristic for this file
            const heuristicKey = `${file.filename}|${file.size}`;
            existingFile = seenHeuristics.get(heuristicKey);
            duplicateMethod = 'heuristic';
            if (!existingFile) {
              seenHeuristics.set(heuristicKey, file.filename);
            }
          }
        } else {
          const heuristicKey = `${file.filename}|${file.size}`;
          existingFile = seenHeuristics.get(heuristicKey);
          duplicateMethod = 'heuristic';
          if (!existingFile) {
            seenHeuristics.set(heuristicKey, file.filename);
          }
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
        
        if (result.type === 'photo') photoCount++;
        else if (result.type === 'video') videoCount++;
        
        confidenceCounts[result.dateConfidence]++;
        
        if (result.derivedDate) {
          const date = new Date(result.derivedDate);
          if (!isNaN(date.getTime())) {
            if (!earliestDate || date < earliestDate) earliestDate = date;
            if (!latestDate || date > latestDate) latestDate = date;
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

  // Final summary line + release the diagnostic sink. If we threw
  // earlier the sink leaks until the next analyzeSource runs, which
  // is harmless — the next call resets diagSink at its top.
  const totalSec = ((Date.now() - analysisStartedAt) / 1000).toFixed(1);
  diag(`▶ Analysis END — ${analyzedFiles.length.toLocaleString()} files in result, ${duplicatesRemoved} dups, ${(totalSizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB total payload (${totalSec}s)`);
  diagSink = null;

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
    skippedFiles,
    files: analyzedFiles,
  };
}
