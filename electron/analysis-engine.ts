import * as fs from 'fs';
import * as path from 'path';
import * as exifParser from 'exif-parser';
import AdmZip from 'adm-zip';
import * as mimeTypes from 'mime-types';
import {
  extractDateFromFilename,
  extractXmpMetadataFromBuffer,
  extractXmpMetadataFromPath,
  parseGoogleTakeoutJson,
  parseGoogleTakeoutJsonContent,
  findGoogleTakeoutSidecar,
  generateDateBasedFilename,
} from './date-extraction-engine';

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
  files: FileAnalysisResult[];
}

const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp', '.heic', '.heif', '.raw', '.cr2', '.nef', '.arw', '.dng']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp', '.mts', '.m2ts']);

function isMediaFile(filename: string): 'photo' | 'video' | null {
  const ext = path.extname(filename).toLowerCase();
  if (PHOTO_EXTENSIONS.has(ext)) return 'photo';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return null;
}

function extractExifDateFromPath(filePath: string): Date | null {
  try {
    const buffer = fs.readFileSync(filePath);
    return extractExifDateFromBuffer(buffer);
  } catch (error) {
  }
  return null;
}

function extractExifDateFromBuffer(buffer: Buffer): Date | null {
  try {
    const parser = exifParser.create(buffer);
    const result = parser.parse();
    
    if (result.tags?.DateTimeOriginal) {
      return new Date(result.tags.DateTimeOriginal * 1000);
    }
    if (result.tags?.CreateDate) {
      return new Date(result.tags.CreateDate * 1000);
    }
    if (result.tags?.ModifyDate) {
      return new Date(result.tags.ModifyDate * 1000);
    }
  } catch (error) {
  }
  return null;
}

function getFileStat(filePath: string): { mtime: Date; size: number } | null {
  try {
    const stats = fs.statSync(filePath);
    return { mtime: stats.mtime, size: stats.size };
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

  const sidecarPath = findGoogleTakeoutSidecar(filePath);
  if (sidecarPath) {
    const takeoutData = parseGoogleTakeoutJson(sidecarPath);
    if (takeoutData?.timestamp) {
      derivedDate = new Date(takeoutData.timestamp * 1000);
      dateSource = 'Google Takeout JSON';
      dateConfidence = 'confirmed';
    }
  }

  if (!derivedDate) {
    const exifDate = extractExifDateFromPath(filePath);
    if (exifDate) {
      derivedDate = exifDate;
      dateSource = 'EXIF DateTimeOriginal';
      dateConfidence = 'confirmed';
    }
  }

  if (!derivedDate) {
    const xmpData = extractXmpMetadataFromPath(filePath);
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
    const stats = getFileStat(filePath);
    if (stats) {
      derivedDate = stats.mtime;
      dateSource = 'File modification time (fallback)';
      dateConfidence = 'marked';
    }
  }

  const suggestedFilename = derivedDate 
    ? generateDateBasedFilename(
        Math.floor(derivedDate.getTime() / 1000),
        extension,
        isWhatsApp,
        dateConfidence === 'recovered'
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
    derivedDate: derivedDate?.toISOString() || null,
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

  const suggestedFilename = derivedDate 
    ? generateDateBasedFilename(
        Math.floor(derivedDate.getTime() / 1000),
        extension,
        isWhatsApp,
        dateConfidence === 'recovered'
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
    derivedDate: derivedDate?.toISOString() || null,
    originalDate: null,
    suggestedFilename,
  };
}

function scanDirectory(dirPath: string): Array<{ path: string; filename: string; size: number }> {
  const results: Array<{ path: string; filename: string; size: number }> = [];
  
  function walk(currentPath: string) {
    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '__MACOSX') {
            walk(fullPath);
          }
        } else if (entry.isFile()) {
          const mediaType = isMediaFile(entry.name);
          if (mediaType) {
            const stats = getFileStat(fullPath);
            results.push({
              path: fullPath,
              filename: entry.name,
              size: stats?.size || 0,
            });
          }
        }
      }
    } catch (error) {
    }
  }
  
  walk(dirPath);
  return results;
}

interface ZipEntry {
  path: string;
  filename: string;
  size: number;
  buffer: Buffer;
  time: Date | null;
  googleTakeoutJson?: string;
}

function scanZipFile(zipPath: string): ZipEntry[] {
  const results: ZipEntry[] = [];
  const jsonContents: Map<string, string> = new Map();
  
  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    
    for (const entry of entries) {
      if (!entry.isDirectory && entry.entryName.toLowerCase().endsWith('.json')) {
        try {
          const content = entry.getData().toString('utf-8');
          jsonContents.set(entry.entryName, content);
        } catch (e) {
        }
      }
    }
    
    for (const entry of entries) {
      if (!entry.isDirectory) {
        const filename = path.basename(entry.entryName);
        const mediaType = isMediaFile(filename);
        if (mediaType) {
          const time = entry.header.time ? new Date(entry.header.time) : null;
          
          let googleTakeoutJson: string | undefined;
          const jsonPath1 = entry.entryName + '.json';
          const jsonPath2 = entry.entryName.replace(/\.[^/.]+$/, '.json');
          
          if (jsonContents.has(jsonPath1)) {
            googleTakeoutJson = jsonContents.get(jsonPath1);
          } else if (jsonContents.has(jsonPath2)) {
            googleTakeoutJson = jsonContents.get(jsonPath2);
          }
          
          results.push({
            path: entry.entryName,
            filename,
            size: entry.header.size,
            buffer: entry.getData(),
            time,
            googleTakeoutJson,
          });
        }
      }
    }
  } catch (error) {
  }
  
  return results;
}

export async function analyzeSource(
  sourcePath: string, 
  sourceType: 'folder' | 'zip' | 'drive',
  onProgress?: (progress: AnalysisProgress) => void
): Promise<SourceAnalysisResult> {
  const sourceLabel = path.basename(sourcePath);
  
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

  if (sourceType === 'zip') {
    const zipEntries = scanZipFile(sourcePath);
    const totalFiles = zipEntries.length;

    for (let i = 0; i < zipEntries.length; i++) {
      const entry = zipEntries[i];
      
      onProgress?.({
        current: i + 1,
        total: totalFiles,
        currentFile: entry.filename,
        phase: 'analyzing'
      });

      const result = await analyzeFileFromBuffer(entry.path, entry.filename, entry.size, entry.buffer, entry.time, entry.googleTakeoutJson);
      if (result) {
        analyzedFiles.push(result);
        totalSizeBytes += result.sizeBytes;
        
        if (result.type === 'photo') photoCount++;
        else if (result.type === 'video') videoCount++;
        
        confidenceCounts[result.dateConfidence]++;
        
        if (result.derivedDate) {
          const date = new Date(result.derivedDate);
          if (!earliestDate || date < earliestDate) earliestDate = date;
          if (!latestDate || date > latestDate) latestDate = date;
        }
      }
    }

    onProgress?.({
      current: totalFiles,
      total: totalFiles,
      currentFile: 'Complete',
      phase: 'complete'
    });
  } else {
    const fileList = scanDirectory(sourcePath);
    const totalFiles = fileList.length;

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      
      onProgress?.({
        current: i + 1,
        total: totalFiles,
        currentFile: file.filename,
        phase: 'analyzing'
      });

      const result = await analyzeFileFromPath(file.path, file.filename, file.size);
      if (result) {
        analyzedFiles.push(result);
        totalSizeBytes += result.sizeBytes;
        
        if (result.type === 'photo') photoCount++;
        else if (result.type === 'video') videoCount++;
        
        confidenceCounts[result.dateConfidence]++;
        
        if (result.derivedDate) {
          const date = new Date(result.derivedDate);
          if (!earliestDate || date < earliestDate) earliestDate = date;
          if (!latestDate || date > latestDate) latestDate = date;
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
    files: analyzedFiles,
  };
}
