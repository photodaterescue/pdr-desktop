import * as path from 'path';
import * as fs from 'fs';
import { ExifTool } from 'exiftool-vendored';
import { app } from 'electron';
import { fileURLToPath } from 'url';
import {
  initDatabase,
  insertRun,
  insertFiles,
  updateRunFileCount,
  removeRunByReportId,
  getRunByReportId,
  type IndexedFile,
} from './search-database.js';
import type { FixReport, FileChange } from './report-storage.js';
import { initGeocoder, reverseGeocode } from './reverse-geocoder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── ExifTool instance (shared, lazy) ────────────────────────────────────────

let exiftool: ExifTool | null = null;

function getExifToolPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'exiftool', 'exiftool.exe');
  }
  return path.join(__dirname, '..', 'node_modules', 'exiftool-vendored.exe', 'bin', 'exiftool.exe');
}

function getExifTool(): ExifTool {
  if (!exiftool) {
    exiftool = new ExifTool({
      exiftoolPath: getExifToolPath(),
      taskTimeoutMillis: 5000, // 5s per file max
    });
  }
  return exiftool;
}

export async function shutdownIndexerExiftool(): Promise<void> {
  if (exiftool) {
    await exiftool.end();
    exiftool = null;
  }
}

// ─── Progress callback type ─────────────────────────────────────────────────

export interface IndexProgress {
  phase: 'reading-exif' | 'inserting' | 'complete';
  current: number;
  total: number;
  currentFile: string;
}

// ─── Cancellation ────────────────────────────────────────────────────────────

let indexCancelled = false;

export function cancelIndexing(): void {
  indexCancelled = true;
}

// ─── Main indexing function ──────────────────────────────────────────────────

export async function indexFixRun(
  report: FixReport,
  onProgress?: (progress: IndexProgress) => void
): Promise<{ success: boolean; runId?: number; fileCount?: number; error?: string }> {
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
    const records: Omit<IndexedFile, 'id' | 'run_id' | 'indexed_at'>[] = [];

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
        } catch (fileErr) {
          // Single file failure should not abort the entire batch
          console.error(`Failed to build record for ${destFilePath}:`, fileErr);
        }

        // Yield every 50 files so we don't block the event loop
        if (i % 50 === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }
    } finally {
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
  } catch (err) {
    console.error('Indexing failed:', err);
    return { success: false, error: (err as Error).message };
  }
}

// ─── Build a single file record ──────────────────────────────────────────────

async function buildFileRecord(
  et: ExifTool,
  destFilePath: string,
  fileChange: FileChange
): Promise<Omit<IndexedFile, 'id' | 'run_id' | 'indexed_at'>> {
  const ext = path.extname(destFilePath).toLowerCase();
  const filename = path.basename(destFilePath);
  const fileType = isVideoExtension(ext) ? 'video' : 'photo';

  // Base record from PDR data
  const record: Omit<IndexedFile, 'id' | 'run_id' | 'indexed_at'> = {
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
  } catch { /* file may have been moved */ }

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
    if (tags.Make) record.camera_make = String(tags.Make).trim();
    if (tags.Model) record.camera_model = String(tags.Model).trim();
    if (tags.LensModel) record.lens_model = String(tags.LensModel).trim();
    else if ((tags as any).LensInfo) record.lens_model = String((tags as any).LensInfo).trim();

    // Dimensions
    if (tags.ImageWidth && tags.ImageHeight) {
      record.width = Number(tags.ImageWidth);
      record.height = Number(tags.ImageHeight);
      record.megapixels = parseFloat(((record.width * record.height) / 1_000_000).toFixed(1));
    } else if ((tags as any).ExifImageWidth && (tags as any).ExifImageHeight) {
      record.width = Number((tags as any).ExifImageWidth);
      record.height = Number((tags as any).ExifImageHeight);
      record.megapixels = parseFloat(((record.width * record.height) / 1_000_000).toFixed(1));
    }

    // Exposure
    if (tags.ISO) record.iso = Number(tags.ISO);
    if (tags.ShutterSpeed) record.shutter_speed = String(tags.ShutterSpeed);
    else if (tags.ExposureTime) record.shutter_speed = String(tags.ExposureTime);
    if (tags.FNumber) record.aperture = Number(tags.FNumber);
    else if (tags.ApertureValue) record.aperture = Number(tags.ApertureValue);
    if (tags.FocalLength) record.focal_length = Number(tags.FocalLength);

    // Flash
    if (tags.Flash != null) {
      const flashStr = String(tags.Flash).toLowerCase();
      record.flash_fired = flashStr.includes('fired') || flashStr === '1' ? 1 : 0;
    }

    // Scene capture type (Landscape, Portrait, Night, etc.)
    if ((tags as any).SceneCaptureType != null) {
      record.scene_capture_type = String((tags as any).SceneCaptureType).trim();
    }

    // Exposure program (Manual, Aperture Priority, Shutter Priority, Program, etc.)
    if ((tags as any).ExposureProgram != null) {
      record.exposure_program = String((tags as any).ExposureProgram).trim();
    }

    // White balance
    if ((tags as any).WhiteBalance != null) {
      record.white_balance = String((tags as any).WhiteBalance).trim();
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
    if (isScannerDevice(record.camera_make, record.camera_model)) {
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
  } catch (err) {
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

function isVideoExtension(ext: string): boolean {
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
/**
 * Return true if the EXIF `Make` / `Model` strings identify a flatbed scanner,
 * film scanner, or multifunction scan-capable printer. Used to demote the
 * confidence tier so these files land in the Marked bucket for manual review.
 *
 * The patterns are intentionally conservative — we want scanners but NOT
 * camera models that happen to share a brand (e.g. Canon DSLRs). Matching is
 * done on a combination of keywords rather than full-string equality so
 * specific model numbers (HP Scanjet G4050, Epson Perfection V600, etc.)
 * are captured automatically.
 */
function isScannerDevice(make: string | null, model: string | null): boolean {
  const m = `${make || ''} ${model || ''}`.toLowerCase();
  if (!m.trim()) return false;

  // Dedicated scanner product lines
  const scannerPatterns: RegExp[] = [
    /\bscanjet\b/,             // HP Scanjet (flatbed/photo scanners)
    /\bperfection\b/,          // Epson Perfection (flatbed)
    /\bcanoscan\b/,            // Canon CanoScan
    /\bopticfilm\b/,           // Plustek OpticFilm (film scanner)
    /\bopticpro\b/,            // Plustek OpticPro
    /\bcoolscan\b/,            // Nikon Coolscan
    /\bscanmaker\b/,           // Microtek ScanMaker
    /\bscanwit\b/,             // Acer ScanWit
    /\bvuescan\b/,             // VueScan (software, but may appear in EXIF)
    /\bimacon\b/,              // Imacon/Hasselblad film scanners
    /\bflextight\b/,           // Hasselblad Flextight
    /\bpacific image\b/,       // Pacific Image film scanners
    /\bdimage\s*scan\b/,       // Minolta Dimage Scan
  ];
  if (scannerPatterns.some(rx => rx.test(m))) return true;

  // Multifunction printer/scanner combos — match brand + a typical MFP token
  const mfpHints = /\b(officejet|deskjet|envy|laserjet|workforce|expression|pixma|imageclass|mfc|dcp|hl|maxify)\b/;
  if (mfpHints.test(m) && /\b(scan|mfp|all[-\s]?in[-\s]?one|aio)\b/.test(m)) return true;

  // Generic "scanner" anywhere in the Make/Model string is a strong signal.
  if (/\bscanner\b/.test(m)) return true;

  return false;
}

function deriveCameraPosition(lensModel: string | null, cameraModel: string | null): string | null {
  const combined = ((lensModel || '') + ' ' + (cameraModel || '')).toLowerCase();
  if (!combined.trim()) return null;

  // Check for panoramic / pano modes
  if (combined.includes('panoram') || combined.includes('pano')) return 'panoramic';
  // Selfie / front camera
  if (combined.includes('front') || combined.includes('selfie') || combined.includes('facetime')) return 'front';
  // Macro
  if (combined.includes('macro')) return 'macro';
  // Ultra wide / wide angle
  if (combined.includes('ultra wide') || combined.includes('ultrawide') || combined.includes('wide angle') || combined.includes('wide-angle')) return 'wide';
  // Telephoto / zoom
  if (combined.includes('telephoto') || combined.includes('periscope') || combined.includes('zoom')) return 'telephoto';
  // Rear / back camera (generic)
  if (combined.includes('back') || combined.includes('rear') || combined.includes('main camera')) return 'rear';

  return null;
}
