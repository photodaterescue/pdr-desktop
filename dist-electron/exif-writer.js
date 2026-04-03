import { ExifTool } from 'exiftool-vendored';
import { app } from 'electron';
import * as path from 'path';
// Create ExifTool instance with correct path for packaged/dev
function getExifToolPath() {
    if (app.isPackaged) {
        // Production: use bundled ExifTool from resources
        return path.join(process.resourcesPath, 'exiftool', 'exiftool.exe');
    }
    else {
        // Development: use from node_modules
        return path.join(__dirname, '..', 'node_modules', 'exiftool-vendored.exe', 'bin', 'exiftool.exe');
    }
}
// Create ExifTool instance with explicit path
const exiftool = new ExifTool({ exiftoolPath: getExifToolPath() });
const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.tiff', '.tif', '.heic', '.heif', '.webp', '.dng', '.cr2', '.nef', '.arw'];
function isPhotoFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return PHOTO_EXTENSIONS.includes(ext);
}
function isValidDate(date) {
    if (!(date instanceof Date) || isNaN(date.getTime()))
        return false;
    const year = date.getFullYear();
    if (year < 1971)
        return false;
    if (date.getTime() > Date.now() + 24 * 60 * 60 * 1000)
        return false;
    return true;
}
export async function writeExifDate(filePath, date, confidence, dateSource, settings) {
    if (!settings.writeExif) {
        return { success: true, written: false };
    }
    const shouldWrite = (confidence === 'confirmed' && settings.exifWriteConfirmed) ||
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
        const pad = (n) => String(n).padStart(2, '0');
        const exifDateStr = `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        console.log(`[EXIF] Attempting write: ${filePath}`);
        console.log(`[EXIF] Date: ${exifDateStr}, Confidence: ${confidence}, Source: ${dateSource}`);
        const EXIF_TIMEOUT_MS = 15000;
        const writePromise = exiftool.write(filePath, {
            DateTimeOriginal: exifDateStr,
            CreateDate: exifDateStr,
            ModifyDate: exifDateStr,
        }, ['-overwrite_original']);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error(`EXIF write timed out after ${EXIF_TIMEOUT_MS / 1000}s`)), EXIF_TIMEOUT_MS));
        await Promise.race([writePromise, timeoutPromise]);
        console.log(`[EXIF] SUCCESS: ${filePath}`);
        return {
            success: true,
            written: true,
            source: `${confidence.charAt(0).toUpperCase() + confidence.slice(1)} (${dateSource})`
        };
    }
    catch (error) {
        console.error(`[EXIF] FAILED: ${filePath}`, error.message);
        return {
            success: false,
            written: false,
            error: error.message
        };
    }
}
export async function shutdownExiftool() {
    await exiftool.end();
}
