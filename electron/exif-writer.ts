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