import * as path from 'path';
import * as fs from 'fs';
import { ExifTool } from 'exiftool-vendored';
import { app } from 'electron';
import { fileURLToPath } from 'url';
import { initDatabase, insertRun, insertFiles, updateRunFileCount, removeRunByReportId, getRunByReportId, findExistingFilePaths, } from './search-database.js';
import { initGeocoder, reverseGeocode } from './reverse-geocoder.js';
import { isScannerDevice } from './scanner-detection.js';
import { getScannerOverride } from './settings-store.js';
import { toLongPath } from './long-path.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// ─── ExifTool instance (shared, lazy) ────────────────────────────────────────
let exiftool = null;
function getExifToolPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'exiftool', 'exiftool.exe');
    }
    return path.join(__dirname, '..', 'node_modules', 'exiftool-vendored.exe', 'bin', 'exiftool.exe');
}
function getExifTool() {
    if (!exiftool) {
        exiftool = new ExifTool({
            exiftoolPath: getExifToolPath(),
            taskTimeoutMillis: 5000, // 5s per file max
        });
    }
    return exiftool;
}
export async function shutdownIndexerExiftool() {
    if (exiftool) {
        await exiftool.end();
        exiftool = null;
    }
}
// ─── Cancellation ────────────────────────────────────────────────────────────
let indexCancelled = false;
export function cancelIndexing() {
    indexCancelled = true;
}
// ─── Main indexing function ──────────────────────────────────────────────────
export async function indexFixRun(report, onProgress) {
    indexCancelled = false;
    try {
        // Init reverse geocoder (loads geodata on first call)
        initGeocoder();
        // Ensure DB is ready
        const dbResult = initDatabase();
        if (!dbResult.success) {
            return { success: false, error: `Database init failed: ${dbResult.error}` };
        }
        // Check if already indexed — if so, remove old data first
        const existingRun = getRunByReportId(report.id);
        if (existingRun) {
            removeRunByReportId(report.id);
        }
        // Create run record
        const sourceLabels = report.sources.map(s => s.label).join(', ');
        const runId = insertRun(report.id, report.destinationPath, sourceLabels);
        // Build list of files to index — only files that were actually copied to destination
        const filesToIndex = report.files.filter(f => f.newFilename);
        const total = filesToIndex.length;
        if (total === 0) {
            updateRunFileCount(runId, 0);
            onProgress?.({ phase: 'complete', current: 0, total: 0, currentFile: '' });
            return { success: true, runId, fileCount: 0 };
        }
        // Read EXIF from each destination file and build records
        const et = getExifTool();
        const records = [];
        try {
            onProgress?.({ phase: 'reading-exif', current: 0, total, currentFile: '' });
            for (let i = 0; i < filesToIndex.length; i++) {
                if (indexCancelled) {
                    // Even if cancelled, insert what we have so far
                    break;
                }
                const fileChange = filesToIndex[i];
                // Resolve actual file path — PDR can organise into subdirectories:
                //   flat:            dest/filename.jpg
                //   year:            dest/2013/filename.jpg
                //   year+month:      dest/2013/07/filename.jpg
                //   year+month+day:  dest/2013/07/15/filename.jpg
                let destFilePath = path.join(report.destinationPath, fileChange.newFilename);
                if (!fs.existsSync(destFilePath)) {
                    const dateMatch = fileChange.newFilename.match(/^(\d{4})-(\d{2})-(\d{2})/);
                    if (dateMatch) {
                        const [, year, month, day] = dateMatch;
                        const candidates = [
                            path.join(report.destinationPath, year, fileChange.newFilename),
                            path.join(report.destinationPath, year, month, fileChange.newFilename),
                            path.join(report.destinationPath, year, month, day, fileChange.newFilename),
                        ];
                        for (const candidate of candidates) {
                            if (fs.existsSync(candidate)) {
                                destFilePath = candidate;
                                break;
                            }
                        }
                    }
                }
                onProgress?.({
                    phase: 'reading-exif',
                    current: i + 1,
                    total,
                    currentFile: fileChange.newFilename,
                });
                try {
                    const record = await buildFileRecord(et, destFilePath, fileChange);
                    records.push(record);
                }
                catch (fileErr) {
                    // Single file failure should not abort the entire batch
                    console.error(`Failed to build record for ${destFilePath}:`, fileErr);
                }
                // Yield every 50 files so we don't block the event loop
                if (i % 50 === 0) {
                    await new Promise(resolve => setImmediate(resolve));
                }
            }
        }
        finally {
            // Always shut down ExifTool after the EXIF-reading phase completes
            // to free the spawned process — don't leave it running between index runs
            await shutdownIndexerExiftool();
        }
        // Batch insert
        onProgress?.({ phase: 'inserting', current: 0, total: records.length, currentFile: '' });
        const inserted = insertFiles(runId, records);
        updateRunFileCount(runId, inserted);
        onProgress?.({ phase: 'complete', current: inserted, total: inserted, currentFile: '' });
        return { success: true, runId, fileCount: inserted };
    }
    catch (err) {
        console.error('Indexing failed:', err);
        return { success: false, error: err.message };
    }
}
// ─── Build a single file record ──────────────────────────────────────────────
async function buildFileRecord(et, destFilePath, fileChange) {
    const ext = path.extname(destFilePath).toLowerCase();
    const filename = path.basename(destFilePath);
    const fileType = isVideoExtension(ext) ? 'video' : 'photo';
    // Base record from PDR data
    const record = {
        file_path: destFilePath,
        filename,
        extension: ext,
        file_type: fileType,
        size_bytes: 0,
        hash: null,
        confidence: fileChange.confidence,
        date_source: fileChange.dateSource || '',
        original_filename: fileChange.originalFilename || '',
        derived_date: null,
        year: null,
        month: null,
        day: null,
        camera_make: null,
        camera_model: null,
        lens_model: null,
        width: null,
        height: null,
        megapixels: null,
        iso: null,
        shutter_speed: null,
        aperture: null,
        focal_length: null,
        flash_fired: null,
        scene_capture_type: null,
        exposure_program: null,
        white_balance: null,
        orientation: null,
        camera_position: null,
        gps_lat: null,
        gps_lon: null,
        gps_alt: null,
        geo_country: null,
        geo_country_code: null,
        geo_city: null,
        exif_read_ok: 0,
    };
    // Get file size
    try {
        const stats = fs.statSync(destFilePath);
        record.size_bytes = stats.size;
    }
    catch { /* file may have been moved */ }
    // Parse derived date from the PDR filename (YYYY-MM-DD_HH-MM-SS pattern)
    const dateMatch = filename.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
    if (dateMatch) {
        const [, y, m, d, hh, mm, ss] = dateMatch;
        record.derived_date = `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
        record.year = parseInt(y, 10);
        record.month = parseInt(m, 10);
        record.day = parseInt(d, 10);
    }
    // Read rich EXIF data from the file
    if (!fs.existsSync(destFilePath)) {
        return record;
    }
    try {
        const tags = await et.read(destFilePath);
        record.exif_read_ok = 1;
        // Camera info
        if (tags.Make)
            record.camera_make = String(tags.Make).trim();
        if (tags.Model)
            record.camera_model = String(tags.Model).trim();
        if (tags.LensModel)
            record.lens_model = String(tags.LensModel).trim();
        else if (tags.LensInfo)
            record.lens_model = String(tags.LensInfo).trim();
        // Dimensions
        if (tags.ImageWidth && tags.ImageHeight) {
            record.width = Number(tags.ImageWidth);
            record.height = Number(tags.ImageHeight);
            record.megapixels = parseFloat(((record.width * record.height) / 1000000).toFixed(1));
        }
        else if (tags.ExifImageWidth && tags.ExifImageHeight) {
            record.width = Number(tags.ExifImageWidth);
            record.height = Number(tags.ExifImageHeight);
            record.megapixels = parseFloat(((record.width * record.height) / 1000000).toFixed(1));
        }
        // Exposure
        if (tags.ISO)
            record.iso = Number(tags.ISO);
        if (tags.ShutterSpeed)
            record.shutter_speed = String(tags.ShutterSpeed);
        else if (tags.ExposureTime)
            record.shutter_speed = String(tags.ExposureTime);
        if (tags.FNumber)
            record.aperture = Number(tags.FNumber);
        else if (tags.ApertureValue)
            record.aperture = Number(tags.ApertureValue);
        if (tags.FocalLength)
            record.focal_length = Number(tags.FocalLength);
        // Flash
        if (tags.Flash != null) {
            const flashStr = String(tags.Flash).toLowerCase();
            record.flash_fired = flashStr.includes('fired') || flashStr === '1' ? 1 : 0;
        }
        // Scene capture type (Landscape, Portrait, Night, etc.)
        if (tags.SceneCaptureType != null) {
            record.scene_capture_type = String(tags.SceneCaptureType).trim();
        }
        // Exposure program (Manual, Aperture Priority, Shutter Priority, Program, etc.)
        if (tags.ExposureProgram != null) {
            record.exposure_program = String(tags.ExposureProgram).trim();
        }
        // White balance
        if (tags.WhiteBalance != null) {
            record.white_balance = String(tags.WhiteBalance).trim();
        }
        // Orientation
        if (tags.Orientation != null) {
            record.orientation = String(tags.Orientation).trim();
        }
        // Camera position — derive from lens model or camera model for smartphones
        record.camera_position = deriveCameraPosition(record.lens_model, record.camera_model);
        // Scanner / multifunction-device demotion. Scanners typically write the
        // scan date into DateTimeOriginal, which PDR would otherwise treat as
        // Confirmed — but the scan date is almost never the actual photo date
        // (e.g. 1995 wedding photo scanned today → Confirmed: today). We flag
        // these as Marked so they surface in the Date Editor for manual review.
        // False positive (same-day scan of a same-day event) is rare; false
        // negative (silent corruption of family photo dates) is common, so we
        // err on the side of review.
        // Software tag: many scanners self-identify here via the scanning app
        // (VueScan, SilverFast, Epson Scan, HP ScanSmart, Canon ScanGear, ...).
        // This often catches scanner output even when Make/Model don't name a
        // known scanner model — effectively a long-tail safety net.
        const softwareTag = tags.Software != null ? String(tags.Software).trim() : null;
        // User override trumps the built-in rule in both directions:
        //   true  → force-demote (even if the rule wouldn't have caught it)
        //   false → force-not-scanner (escape hatch for false positives)
        //   null  → no override, fall through to the built-in detection
        const override = getScannerOverride(record.camera_make, record.camera_model);
        const treatAsScanner = override !== null
            ? override
            : isScannerDevice(record.camera_make, record.camera_model, softwareTag);
        if (treatAsScanner) {
            record.confidence = 'marked';
            record.date_source = record.date_source
                ? `${record.date_source} — scanner`
                : 'Scanner date (likely scan time, not photo date)';
        }
        // GPS + reverse geocoding
        if (tags.GPSLatitude != null && tags.GPSLongitude != null) {
            record.gps_lat = Number(tags.GPSLatitude);
            record.gps_lon = Number(tags.GPSLongitude);
            // Reverse geocode to get country + city
            const geo = reverseGeocode(record.gps_lat, record.gps_lon);
            if (geo) {
                record.geo_country = geo.country;
                record.geo_country_code = geo.countryCode;
                record.geo_city = geo.city;
            }
        }
        if (tags.GPSAltitude != null) {
            record.gps_alt = Number(tags.GPSAltitude);
        }
        // If we don't have a derived date from filename, try EXIF dates
        if (!record.derived_date) {
            const exifDate = tags.DateTimeOriginal ?? tags.CreateDate ?? tags.ModifyDate;
            if (exifDate) {
                const d = exifDate instanceof Date ? exifDate : new Date(String(exifDate));
                if (!isNaN(d.getTime()) && d.getFullYear() > 1970) {
                    record.derived_date = d.toISOString().replace('T', ' ').substring(0, 19);
                    record.year = d.getFullYear();
                    record.month = d.getMonth() + 1;
                    record.day = d.getDate();
                }
            }
        }
    }
    catch (err) {
        // EXIF read failed — not critical, we still have PDR data
        record.exif_read_ok = 0;
    }
    return record;
}
// ─── Helpers ─────────────────────────────────────────────────────────────────
const VIDEO_EXTENSIONS = new Set([
    '.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v',
    '.3gp', '.3g2', '.mts', '.m2ts', '.ts', '.vob',
    '.mpg', '.mpeg', '.asf', '.divx', '.ogv', '.rm', '.rmvb', '.swf',
]);
function isVideoExtension(ext) {
    return VIDEO_EXTENSIONS.has(ext.toLowerCase());
}
/**
 * Derive the camera position/type from lens model and camera model strings.
 * Smartphones embed this info in their EXIF lens/model fields.
 * Examples:
 *   "iPhone 15 Pro back camera 6.765mm f/1.78"  → "rear"
 *   "iPhone 15 Pro front camera 2.69mm f/1.9"   → "front"
 *   "Samsung S24 Ultra - Ultra Wide Camera"       → "wide"
 *   "iPhone 15 Pro back camera 2.22mm f/2.2" (ultrawide) → "wide"
 *   "telephoto" in lens model                     → "telephoto"
 */
function deriveCameraPosition(lensModel, cameraModel) {
    const combined = ((lensModel || '') + ' ' + (cameraModel || '')).toLowerCase();
    if (!combined.trim())
        return null;
    // Check for panoramic / pano modes
    if (combined.includes('panoram') || combined.includes('pano'))
        return 'panoramic';
    // Selfie / front camera
    if (combined.includes('front') || combined.includes('selfie') || combined.includes('facetime'))
        return 'front';
    // Macro
    if (combined.includes('macro'))
        return 'macro';
    // Ultra wide / wide angle
    if (combined.includes('ultra wide') || combined.includes('ultrawide') || combined.includes('wide angle') || combined.includes('wide-angle'))
        return 'wide';
    // Telephoto / zoom
    if (combined.includes('telephoto') || combined.includes('periscope') || combined.includes('zoom'))
        return 'telephoto';
    // Rear / back camera (generic)
    if (combined.includes('back') || combined.includes('rear') || combined.includes('main camera'))
        return 'rear';
    return null;
}
// ─── Rebuild from existing Library Drive(s) ─────────────────────────────────
//
// When PDR's search-index DB has been reset (fresh install, accidental
// deletion, version upgrade) but the customer's Library Drive still
// holds years of fixed photos from previous Run Fix operations, this
// tool walks those drives and rebuilds the index from each file's
// on-disk EXIF + filename. No changes are made to the photo files
// themselves — read-only with respect to the library; only the search
// index DB is modified.
//
// Each provided root path becomes its own indexed_runs entry with a
// synthetic report id ("library-rebuild-…") so the UI groups files
// per library rather than treating them as one monolithic run.
const PHOTO_EXTENSIONS = new Set([
    '.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', '.tiff', '.tif',
    '.bmp', '.webp', '.dng', '.raw', '.cr2', '.cr3', '.nef', '.arw', '.orf',
]);
const MEDIA_EXTENSIONS_FOR_REBUILD = new Set([
    ...PHOTO_EXTENSIONS,
    ...VIDEO_EXTENSIONS,
]);
/**
 * Recursively walk `root` and return every media file found. Skips
 * hidden / system folders (.dotdirs, $RECYCLE.BIN, System Volume
 * Information) so we don't scan trash or NTFS metadata.
 */
function walkMediaFiles(root) {
    const results = [];
    // Apply the Windows extended-length prefix to the root so the entire
    // walk inherits MAX_PATH-bypass capability. Without this, a deeply-
    // nested Google Takeout tree under a long library-drive root would
    // throw inside readdirSync once any sub-path crosses 260 chars on
    // Windows. No-op on macOS/Linux. See long-path.ts.
    const stack = [toLongPath(root)];
    while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const ent of entries) {
            if (ent.name.startsWith('.') || ent.name.startsWith('$'))
                continue;
            if (ent.name === 'System Volume Information')
                continue;
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                stack.push(full);
            }
            else if (ent.isFile()) {
                const ext = path.extname(ent.name).toLowerCase();
                if (MEDIA_EXTENSIONS_FOR_REBUILD.has(ext)) {
                    results.push(full);
                }
            }
        }
    }
    return results;
}
export async function rebuildIndexFromLibraries(rootPaths, onProgress) {
    indexCancelled = false;
    const perRoot = [];
    try {
        initGeocoder();
        const dbResult = initDatabase();
        if (!dbResult.success) {
            return {
                success: false,
                runIds: [],
                totalFiles: 0,
                perRoot,
                error: `Database init failed: ${dbResult.error}`,
            };
        }
        const runIds = [];
        let grandTotal = 0;
        const et = getExifTool();
        try {
            for (let r = 0; r < rootPaths.length; r++) {
                if (indexCancelled)
                    break;
                const rootPath = rootPaths[r];
                if (!fs.existsSync(rootPath)) {
                    perRoot.push({ root: rootPath, runId: null, fileCount: 0 });
                    continue;
                }
                // Phase 1: walk
                onProgress?.({
                    phase: 'walking',
                    rootIndex: r,
                    rootCount: rootPaths.length,
                    rootPath,
                    current: 0,
                    total: 0,
                    currentFile: '',
                });
                const files = walkMediaFiles(rootPath);
                const total = files.length;
                if (total === 0) {
                    perRoot.push({ root: rootPath, runId: null, fileCount: 0 });
                    continue;
                }
                // Create one synthetic run per library so the UI can group + filter
                // by library. Stable id keyed off rootPath so re-running the rebuild
                // wouldn't keep accumulating duplicate runs (existing run is
                // removed first by the caller via clearAllIndexData if desired).
                const reportId = `library-rebuild-${path.basename(rootPath).replace(/[^A-Za-z0-9]+/g, '-')}-${Date.now()}`;
                const sourceLabels = `Library: ${rootPath}`;
                const runId = insertRun(reportId, rootPath, sourceLabels);
                runIds.push(runId);
                // Phase 2: read EXIF + build records
                const records = [];
                for (let i = 0; i < files.length; i++) {
                    if (indexCancelled)
                        break;
                    const filePath = files[i];
                    const filename = path.basename(filePath);
                    onProgress?.({
                        phase: 'reading-exif',
                        rootIndex: r,
                        rootCount: rootPaths.length,
                        rootPath,
                        current: i + 1,
                        total,
                        currentFile: filename,
                    });
                    // Synthetic FileChange — there's no Fix report for these
                    // discovered files, so we hand buildFileRecord sensible
                    // defaults and let its EXIF logic (scanner detection,
                    // derived-date parsing, geocoding, etc.) do the rest.
                    const syntheticChange = {
                        newFilename: filename,
                        originalFilename: '',
                        confidence: 'confirmed',
                        dateSource: 'embedded',
                    };
                    try {
                        const record = await buildFileRecord(et, filePath, syntheticChange);
                        records.push(record);
                    }
                    catch (fileErr) {
                        console.error(`[rebuild] Failed to build record for ${filePath}:`, fileErr);
                    }
                    if (i % 50 === 0) {
                        await new Promise((resolve) => setImmediate(resolve));
                    }
                }
                // Phase 3: insert
                //
                // v2.0.6 data-loss fix — rebuild MUST be non-destructive.
                // The previous behaviour passed every walked file to insertFiles
                // which UPSERTs on file_path, overwriting confidence,
                // original_filename, date_source, and run_id on any pre-existing
                // row. Terry's Parallel Library investigation 2026-05-16: the
                // post-PL rebuild walked the destination tree and silently
                // flipped Recovered → Confirmed and blanked Original Name on
                // master-library rows whose paths happened to live under that
                // tree. The rebuild's intent is "discover files PDR doesn't
                // already know about" — never "re-classify what Fix earlier
                // categorised." So we filter records down to file_paths NOT
                // already in indexed_files, and insert only those. Existing
                // rows are left completely untouched.
                const allPaths = records.map(r => r.file_path);
                const existing = findExistingFilePaths(allPaths);
                const newRecords = records.filter(r => !existing.has(r.file_path));
                const skippedExisting = records.length - newRecords.length;
                onProgress?.({
                    phase: 'inserting',
                    rootIndex: r,
                    rootCount: rootPaths.length,
                    rootPath,
                    current: 0,
                    total: newRecords.length,
                    currentFile: '',
                });
                const inserted = newRecords.length > 0 ? insertFiles(runId, newRecords) : 0;
                updateRunFileCount(runId, inserted);
                grandTotal += inserted;
                perRoot.push({ root: rootPath, runId, fileCount: inserted });
                if (skippedExisting > 0) {
                    console.log(`[rebuild] ${rootPath}: ${inserted} new, ${skippedExisting} already-indexed (preserved)`);
                }
            }
        }
        finally {
            // Free the ExifTool subprocess once all libraries are processed.
            await shutdownIndexerExiftool();
        }
        onProgress?.({
            phase: 'complete',
            rootIndex: rootPaths.length,
            rootCount: rootPaths.length,
            rootPath: '',
            current: grandTotal,
            total: grandTotal,
            currentFile: '',
        });
        return { success: true, runIds, totalFiles: grandTotal, perRoot };
    }
    catch (err) {
        return {
            success: false,
            runIds: [],
            totalFiles: 0,
            perRoot,
            error: err.message,
        };
    }
}
