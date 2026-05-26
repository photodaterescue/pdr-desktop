import { ExifTool } from 'exiftool-vendored';
import { app } from 'electron';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create ExifTool instance with correct path for packaged/dev
function getExifToolPath(): string {
  if (app.isPackaged) {
    // Production: use bundled ExifTool from resources
    return path.join(process.resourcesPath, 'exiftool', 'exiftool.exe');
  } else {
    // Development: use from node_modules
    return path.join(__dirname, '..', 'node_modules', 'exiftool-vendored.exe', 'bin', 'exiftool.exe');
  }
}

// Create ExifTool instance with explicit path
const exiftool = new ExifTool({ exiftoolPath: getExifToolPath() });

export interface ExifWriteResult {
  success: boolean;
  written: boolean;
  source?: string;
  error?: string;
}

const PHOTO_EXTENSIONS = [
  '.jpg', '.jpeg', '.jfif', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp',
  '.heic', '.heif', '.avif', '.jp2', '.j2k',
  '.raw', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.rw2', '.pef',
  '.sr2', '.srf', '.raf', '.3fr', '.rwl', '.x3f', '.dcr', '.kdc', '.mrw', '.erf',
  '.psd',
];

function isPhotoFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return PHOTO_EXTENSIONS.includes(ext);
}

function isValidDate(date: Date): boolean {
  if (!(date instanceof Date) || isNaN(date.getTime())) return false;
  const year = date.getFullYear();
  if (year < 1971) return false;
  if (date.getTime() > Date.now() + 24 * 60 * 60 * 1000) return false;
  return true;
}

// v2.0.13 — full enrichment EXIF write. Writes date (the original
// behaviour) plus optional GPS coordinates and description in a
// single exiftool invocation so a 9 800-file enrichment pass doesn't
// fork the exiftool subprocess three times per file.
//
// Returns a list of which EXIF fields actually landed so the
// enrichment_log audit row can record exactly what was changed.
//
// All non-date fields are skipped when their value is null/undefined,
// so callers can pass through the sidecar payload as-is without
// having to gate each field at the call site.
export interface EnrichmentExifWriteResult {
  success: boolean;
  fieldsWritten: ('date' | 'gps' | 'description')[];
  error?: string;
}

export async function writeEnrichmentExif(
  filePath: string,
  date: Date,
  options: {
    gpsLat: number | null;
    gpsLon: number | null;
    description: string | null;
  },
): Promise<EnrichmentExifWriteResult> {
  if (!isPhotoFile(filePath)) {
    // Video / other non-photo file — exiftool can write metadata to
    // mp4/mov but the field semantics differ and PDR's existing
    // photo-only restriction holds. Skip silently with success.
    return { success: true, fieldsWritten: [] };
  }
  if (!isValidDate(date)) {
    return {
      success: false,
      fieldsWritten: [],
      error: 'Invalid date - skipped EXIF write to prevent data corruption',
    };
  }
  try {
    const pad = (n: number) => String(n).padStart(2, '0');
    const exifDateStr = `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

    const payload: Record<string, string | number> = {
      DateTimeOriginal: exifDateStr,
      CreateDate: exifDateStr,
      ModifyDate: exifDateStr,
    };
    const fieldsWritten: ('date' | 'gps' | 'description')[] = ['date'];

    if (typeof options.gpsLat === 'number' && typeof options.gpsLon === 'number' &&
        Number.isFinite(options.gpsLat) && Number.isFinite(options.gpsLon)) {
      payload.GPSLatitude = options.gpsLat;
      payload.GPSLatitudeRef = options.gpsLat >= 0 ? 'N' : 'S';
      payload.GPSLongitude = options.gpsLon;
      payload.GPSLongitudeRef = options.gpsLon >= 0 ? 'E' : 'W';
      fieldsWritten.push('gps');
    }
    if (typeof options.description === 'string' && options.description.length > 0) {
      payload.ImageDescription = options.description;
      // XMP-dc:description is what most modern viewers actually read.
      // Setting both keeps PDR's outputs consistent across EXIF + XMP.
      payload['XMP-dc:description'] = options.description;
      fieldsWritten.push('description');
    }

    const EXIF_TIMEOUT_MS = 15_000;
    const writePromise = exiftool.write(filePath, payload, ['-overwrite_original']);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`EXIF write timed out after ${EXIF_TIMEOUT_MS / 1000}s`)), EXIF_TIMEOUT_MS),
    );
    await Promise.race([writePromise, timeoutPromise]);
    return { success: true, fieldsWritten };
  } catch (error) {
    return {
      success: false,
      fieldsWritten: [],
      error: (error as Error).message,
    };
  }
}

export async function writeExifDate(
  filePath: string,
  date: Date,
  confidence: 'confirmed' | 'recovered' | 'marked',
  dateSource: string,
  settings: {
    writeExif: boolean;
    exifWriteConfirmed: boolean;
    exifWriteRecovered: boolean;
    exifWriteMarked: boolean;
  }
): Promise<ExifWriteResult> {
  if (!settings.writeExif) {
    return { success: true, written: false };
  }
  
  const shouldWrite = 
    (confidence === 'confirmed' && settings.exifWriteConfirmed) ||
    (confidence === 'recovered' && settings.exifWriteRecovered) ||
    (confidence === 'marked' && settings.exifWriteMarked);
  
  if (!shouldWrite) {
    return { success: true, written: false };
  }
  
  if (!isPhotoFile(filePath)) {
    return { success: true, written: false };
  }
  
  if (!isValidDate(date)) {
    return { 
      success: false, 
      written: false, 
      error: 'Invalid date - skipped EXIF write to prevent data corruption' 
    };
  }
  
  try {
    const pad = (n: number) => String(n).padStart(2, '0');
    const exifDateStr = `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    
    console.log(`[EXIF] Attempting write: ${filePath}`);
    console.log(`[EXIF] Date: ${exifDateStr}, Confidence: ${confidence}, Source: ${dateSource}`);
    
    const EXIF_TIMEOUT_MS = 15000;
    const writePromise = exiftool.write(filePath, {
      DateTimeOriginal: exifDateStr,
      CreateDate: exifDateStr,
      ModifyDate: exifDateStr,
    }, ['-overwrite_original']);
    
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`EXIF write timed out after ${EXIF_TIMEOUT_MS / 1000}s`)), EXIF_TIMEOUT_MS)
    );
    
    await Promise.race([writePromise, timeoutPromise]);
    
    console.log(`[EXIF] SUCCESS: ${filePath}`);
    
    return { 
      success: true, 
      written: true, 
      source: `${confidence.charAt(0).toUpperCase() + confidence.slice(1)} (${dateSource})` 
    };
  } catch (error) {
    console.error(`[EXIF] FAILED: ${filePath}`, (error as Error).message);
    return { 
      success: false, 
      written: false, 
      error: (error as Error).message 
    };
  }
}

export async function shutdownExiftool(): Promise<void> {
  await exiftool.end();
}