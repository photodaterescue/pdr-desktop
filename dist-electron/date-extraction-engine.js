/**
 * Photo Date Rescue - Date Extraction Engine
 *
 * Pure date-derivation and filename logic extracted from the webapp engine.
 * No web framework dependencies - works standalone in Electron main process.
 *
 * Priority order for date extraction:
 * 1. Google Takeout JSON sidecar (photoTakenTime/creationTime)
 * 2. EXIF DateTimeOriginal
 * 3. XMP metadata (CreateDate, DateTimeOriginal, DateCreated)
 * 4. Filename patterns (various formats including WhatsApp)
 * 5. File modification time (fallback)
 */
import * as fs from 'fs';
import * as path from 'path';
// ============================================================================
// Filename Date Patterns
// ============================================================================
const WA_PATTERN = /(?:IMG|VID)[-_](\d{4})(\d{2})(\d{2})[-_]WA\d+/i;
const FILENAME_DATE_PATTERNS = [
    {
        pattern: /(\d{4})[-_]?(\d{2})[-_]?(\d{2})[-_]?(\d{2})[-_]?(\d{2})[-_]?(\d{2})/,
        extract: (m) => {
            const [, year, month, day, hour, min, sec] = m.map(Number);
            if (isValidDate(year, month, day)) {
                return new Date(year, month - 1, day, hour, min, sec);
            }
            return null;
        },
        source: 'Filename (full datetime)',
    },
    {
        pattern: /(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/,
        extract: (m) => {
            const [, year, month, day, hour, min, sec] = m.map(Number);
            if (isValidDate(year, month, day)) {
                return new Date(year, month - 1, day, hour, min, sec);
            }
            return null;
        },
        source: 'Filename (compact datetime)',
    },
    {
        pattern: /IMG[-_](\d{4})(\d{2})(\d{2})[-_](\d{2})(\d{2})(\d{2})/i,
        extract: (m) => {
            const [, year, month, day, hour, min, sec] = m.map(Number);
            if (isValidDate(year, month, day)) {
                return new Date(year, month - 1, day, hour, min, sec);
            }
            return null;
        },
        source: 'Filename (IMG datetime)',
    },
    {
        pattern: /VID[-_](\d{4})(\d{2})(\d{2})[-_](\d{2})(\d{2})(\d{2})/i,
        extract: (m) => {
            const [, year, month, day, hour, min, sec] = m.map(Number);
            if (isValidDate(year, month, day)) {
                return new Date(year, month - 1, day, hour, min, sec);
            }
            return null;
        },
        source: 'Filename (VID datetime)',
    },
    {
        pattern: /Screenshot[-_ ](\d{4})[-_](\d{2})[-_](\d{2})[-_ ](\d{2})[-_](\d{2})[-_](\d{2})/i,
        extract: (m) => {
            const [, year, month, day, hour, min, sec] = m.map(Number);
            if (isValidDate(year, month, day)) {
                return new Date(year, month - 1, day, hour, min, sec);
            }
            return null;
        },
        source: 'Filename (Screenshot)',
    },
    {
        pattern: /IMG[-_](\d{4})(\d{2})(\d{2})[-_]\d+/i,
        extract: (m) => {
            const [, year, month, day] = m.map(Number);
            if (isValidDate(year, month, day)) {
                return new Date(year, month - 1, day, 12, 0, 0);
            }
            return null;
        },
        source: 'Filename (IMG date only)',
    },
    {
        pattern: /(\d{4})[-_](\d{2})[-_](\d{2})/,
        extract: (m) => {
            const [, year, month, day] = m.map(Number);
            if (isValidDate(year, month, day)) {
                return new Date(year, month - 1, day, 12, 0, 0);
            }
            return null;
        },
        source: 'Filename (date with separators)',
    },
    {
        pattern: /(\d{4})(\d{2})(\d{2})/,
        extract: (m) => {
            const [, year, month, day] = m.map(Number);
            if (isValidDate(year, month, day)) {
                return new Date(year, month - 1, day, 12, 0, 0);
            }
            return null;
        },
        source: 'Filename (compact date)',
    },
];
function isValidDate(year, month, day) {
    return year >= 1970 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}
// ============================================================================
// WhatsApp Detection
// ============================================================================
export function extractWhatsAppDate(filename) {
    const match = WA_PATTERN.exec(filename);
    if (match) {
        const [, yearStr, monthStr, dayStr] = match;
        const year = parseInt(yearStr, 10);
        const month = parseInt(monthStr, 10);
        const day = parseInt(dayStr, 10);
        if (isValidDate(year, month, day)) {
            const dt = new Date(year, month - 1, day, 12, 0, 0);
            return { timestamp: Math.floor(dt.getTime() / 1000), isWhatsApp: true };
        }
    }
    return null;
}
// ============================================================================
// Generic Filename Date Extraction
// ============================================================================
export function extractDateFromFilename(filename) {
    const waResult = extractWhatsAppDate(filename);
    if (waResult) {
        return { timestamp: waResult.timestamp, source: 'WhatsApp filename', isWhatsApp: true };
    }
    for (const { pattern, extract, source } of FILENAME_DATE_PATTERNS) {
        const match = filename.match(pattern);
        if (match) {
            const date = extract(match);
            if (date && !isNaN(date.getTime())) {
                return { timestamp: Math.floor(date.getTime() / 1000), source, isWhatsApp: false };
            }
        }
    }
    return { timestamp: null, source: 'No pattern matched', isWhatsApp: false };
}
// ============================================================================
// XMP Metadata Extraction
// ============================================================================
export function extractXmpMetadataFromBuffer(buffer) {
    try {
        const xmpStart = buffer.indexOf('<x:xmpmeta');
        const xmpEnd = buffer.indexOf('</x:xmpmeta>');
        if (xmpStart !== -1 && xmpEnd !== -1) {
            const xmpData = buffer.slice(xmpStart, xmpEnd + 12);
            const xmpStr = xmpData.toString('utf-8');
            const datePatterns = [
                /xmp:CreateDate[=>"\s]+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/,
                /exif:DateTimeOriginal[=>"\s]+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/,
                /photoshop:DateCreated[=>"\s]+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/,
            ];
            for (const pattern of datePatterns) {
                const match = xmpStr.match(pattern);
                if (match) {
                    const dateStr = match[1].substring(0, 19);
                    const dt = new Date(dateStr.replace('T', ' '));
                    if (!isNaN(dt.getTime())) {
                        return { timestamp: Math.floor(dt.getTime() / 1000), orientation: null };
                    }
                }
            }
            const orientationMatch = xmpStr.match(/tiff:Orientation[=>"\s]+(\d+)/);
            const orientation = orientationMatch ? parseInt(orientationMatch[1], 10) : null;
            return { timestamp: null, orientation };
        }
        return null;
    }
    catch (error) {
        return null;
    }
}
export async function extractXmpMetadataFromPath(filePath) {
    try {
        const fd = await fs.promises.open(filePath, 'r');
        try {
            const buffer = Buffer.alloc(262144);
            const { bytesRead } = await fd.read(buffer, 0, 262144, 0);
            return extractXmpMetadataFromBuffer(buffer.subarray(0, bytesRead));
        }
        finally {
            await fd.close();
        }
    }
    catch (error) {
        return null;
    }
}
// ============================================================================
// Google Takeout JSON Parsing
// ============================================================================
export function parseGoogleTakeoutJson(jsonPath) {
    try {
        const content = fs.readFileSync(jsonPath, 'utf-8');
        const data = JSON.parse(content);
        let timestamp = null;
        if (data.photoTakenTime?.timestamp) {
            timestamp = parseInt(data.photoTakenTime.timestamp, 10);
        }
        else if (data.creationTime?.timestamp) {
            timestamp = parseInt(data.creationTime.timestamp, 10);
        }
        return {
            timestamp,
            title: data.title,
            description: data.description,
            geoData: data.geoData ? {
                latitude: data.geoData.latitude,
                longitude: data.geoData.longitude,
            } : undefined,
        };
    }
    catch (error) {
        return null;
    }
}
export function parseGoogleTakeoutJsonContent(jsonContent) {
    try {
        const data = JSON.parse(jsonContent);
        let timestamp = null;
        if (data.photoTakenTime?.timestamp) {
            timestamp = parseInt(data.photoTakenTime.timestamp, 10);
        }
        else if (data.creationTime?.timestamp) {
            timestamp = parseInt(data.creationTime.timestamp, 10);
        }
        return {
            timestamp,
            title: data.title,
            description: data.description,
            geoData: data.geoData ? {
                latitude: data.geoData.latitude,
                longitude: data.geoData.longitude,
            } : undefined,
        };
    }
    catch (error) {
        return null;
    }
}
// ============================================================================
// Sidecar JSON Detection
// ============================================================================
export async function findGoogleTakeoutSidecar(imagePath) {
    const jsonPath1 = imagePath + '.json';
    try {
        await fs.promises.access(jsonPath1);
        return jsonPath1;
    }
    catch { }
    const dir = path.dirname(imagePath);
    const baseName = path.basename(imagePath, path.extname(imagePath));
    const jsonPath2 = path.join(dir, baseName + '.json');
    try {
        await fs.promises.access(jsonPath2);
        return jsonPath2;
    }
    catch { }
    const fullFilename = path.basename(imagePath);
    try {
        const dirEntries = await fs.promises.readdir(dir);
        for (const entry of dirEntries) {
            if (entry.startsWith(fullFilename) && entry.endsWith('.json') && entry !== fullFilename) {
                return path.join(dir, entry);
            }
        }
    }
    catch { }
    return null;
}
export function detectSourceType(files) {
    let hasJsonFiles = false;
    let hasPhotos = false;
    const photoExtensions = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', '.bmp', '.webp']);
    for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (ext === '.json') {
            hasJsonFiles = true;
        }
        if (photoExtensions.has(ext)) {
            hasPhotos = true;
        }
        if (hasJsonFiles && hasPhotos) {
            return 'google_takeout';
        }
    }
    if (hasPhotos) {
        return 'apple_photos';
    }
    return 'unknown';
}
// ============================================================================
// Filename Generation
// ============================================================================
export function generateDateBasedFilename(timestamp, extension, confidence) {
    const dt = new Date(timestamp * 1000);
    const year = dt.getFullYear();
    const month = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    const hours = String(dt.getHours()).padStart(2, '0');
    const minutes = String(dt.getMinutes()).padStart(2, '0');
    const seconds = String(dt.getSeconds()).padStart(2, '0');
    const confidenceSuffix = confidence === 'confirmed' ? '_CF'
        : confidence === 'recovered' ? '_RC'
            : '_MK';
    return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}${confidenceSuffix}${extension}`;
}
export async function extractDateFromFile(filePath, filename, exifTimestamp, options = {}) {
    const { checkGoogleTakeout = true, useMtimeFallback = true } = options;
    if (checkGoogleTakeout) {
        const sidecarPath = await findGoogleTakeoutSidecar(filePath);
        if (sidecarPath) {
            const takeoutData = parseGoogleTakeoutJson(sidecarPath);
            if (takeoutData?.timestamp) {
                return {
                    timestamp: takeoutData.timestamp,
                    source: 'Google Takeout JSON',
                    confidence: 'confirmed',
                    isWhatsApp: false,
                };
            }
        }
    }
    if (exifTimestamp) {
        return {
            timestamp: exifTimestamp,
            source: 'EXIF DateTimeOriginal',
            confidence: 'confirmed',
            isWhatsApp: false,
        };
    }
    const xmpData = await extractXmpMetadataFromPath(filePath);
    if (xmpData?.timestamp) {
        return {
            timestamp: xmpData.timestamp,
            source: 'XMP metadata',
            confidence: 'confirmed',
            isWhatsApp: false,
        };
    }
    const filenameResult = extractDateFromFilename(filename);
    if (filenameResult.timestamp) {
        return {
            timestamp: filenameResult.timestamp,
            source: filenameResult.source,
            confidence: 'recovered',
            isWhatsApp: filenameResult.isWhatsApp,
        };
    }
    if (useMtimeFallback) {
        try {
            const stats = fs.statSync(filePath);
            return {
                timestamp: Math.floor(stats.mtime.getTime() / 1000),
                source: 'File modification time (fallback)',
                confidence: 'marked',
                isWhatsApp: false,
            };
        }
        catch (error) {
        }
    }
    return {
        timestamp: null,
        source: 'No date found',
        confidence: 'marked',
        isWhatsApp: false,
    };
}
export function extractDateFromBuffer(filename, exifTimestamp, xmpBuffer, entryTimestamp, googleTakeoutJsonContent) {
    if (googleTakeoutJsonContent) {
        const takeoutData = parseGoogleTakeoutJsonContent(googleTakeoutJsonContent);
        if (takeoutData?.timestamp) {
            return {
                timestamp: takeoutData.timestamp,
                source: 'Google Takeout JSON',
                confidence: 'confirmed',
                isWhatsApp: false,
            };
        }
    }
    if (exifTimestamp) {
        return {
            timestamp: exifTimestamp,
            source: 'EXIF DateTimeOriginal',
            confidence: 'confirmed',
            isWhatsApp: false,
        };
    }
    if (xmpBuffer) {
        const xmpData = extractXmpMetadataFromBuffer(xmpBuffer);
        if (xmpData?.timestamp) {
            return {
                timestamp: xmpData.timestamp,
                source: 'XMP metadata',
                confidence: 'confirmed',
                isWhatsApp: false,
            };
        }
    }
    const filenameResult = extractDateFromFilename(filename);
    if (filenameResult.timestamp) {
        return {
            timestamp: filenameResult.timestamp,
            source: filenameResult.source,
            confidence: 'recovered',
            isWhatsApp: filenameResult.isWhatsApp,
        };
    }
    if (entryTimestamp) {
        return {
            timestamp: entryTimestamp,
            source: 'Archive entry timestamp (fallback)',
            confidence: 'marked',
            isWhatsApp: false,
        };
    }
    return {
        timestamp: null,
        source: 'No date found',
        confidence: 'marked',
        isWhatsApp: false,
    };
}
