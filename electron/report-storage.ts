import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export interface FileChange {
  originalFilename: string;
  newFilename: string;
  confidence: 'confirmed' | 'recovered' | 'marked';
  dateSource: string;
  sourcePath?: string;
  fileType?: string;
  dateChanged?: boolean;
  exifWritten?: boolean;
  exifSource?: string;
}

export interface SourceInfo {
  path: string;
  type: 'folder' | 'zip' | 'drive';
  label: string;
}

export interface FixReport {
  id: string;
  timestamp: string;
  sources: SourceInfo[];
  destinationPath: string;
  counts: {
    confirmed: number;
    recovered: number;
    marked: number;
    total: number;
  };
  duplicatesRemoved: number;
  duplicateFiles?: Array<{ filename: string; duplicateOf: string; duplicateMethod?: 'hash' | 'heuristic' }>;
  totalScanned?: number;
  files: FileChange[];
}

export interface ReportSummary {
  id: string;
  timestamp: string;
  destinationPath: string;
  totalFiles: number;
  sourceCount: number;
  counts: {
    confirmed: number;
    recovered: number;
    marked: number;
  };
  duplicatesRemoved?: number;
  totalScanned?: number;
}

function getReportsDirectory(): string {
  const userDataPath = app.getPath('userData');
  const reportsDir = path.join(userDataPath, 'fix-reports');
  
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  
  return reportsDir;
}

function generateReportId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `report-${timestamp}-${random}`;
}

export async function saveReport(report: Omit<FixReport, 'id' | 'timestamp'>): Promise<FixReport> {
  const reportsDir = getReportsDirectory();
  const id = generateReportId();
  const timestamp = new Date().toISOString();
  
  const fullReport: FixReport = {
    id,
    timestamp,
    ...report
  };
  
  const filePath = path.join(reportsDir, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(fullReport, null, 2), 'utf-8');
  
  return fullReport;
}

export async function loadReport(reportId: string): Promise<FixReport | null> {
  const reportsDir = getReportsDirectory();
  const filePath = path.join(reportsDir, `${reportId}.json`);
  
  if (!fs.existsSync(filePath)) {
    return null;
  }
  
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as FixReport;
}

export async function loadLatestReport(): Promise<FixReport | null> {
  const reports = await listReports();
  
  if (reports.length === 0) {
    return null;
  }
  
  const latestSummary = reports[0];
  return loadReport(latestSummary.id);
}

export async function listReports(): Promise<ReportSummary[]> {
  const reportsDir = getReportsDirectory();
  
  if (!fs.existsSync(reportsDir)) {
    return [];
  }
  
  const files = fs.readdirSync(reportsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(reportsDir, f));
  
  const summaries: ReportSummary[] = [];
  
  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const report = JSON.parse(content) as FixReport;
      const totalScanned = report.totalScanned ?? (report.counts.confirmed + report.counts.recovered + report.counts.marked + (report.duplicatesRemoved || 0));
      summaries.push({
        id: report.id,
        timestamp: report.timestamp,
        destinationPath: report.destinationPath,
        totalFiles: report.counts.total,
        sourceCount: report.sources.length,
        counts: {
          confirmed: report.counts.confirmed,
          recovered: report.counts.recovered,
          marked: report.counts.marked
        },
        duplicatesRemoved: report.duplicatesRemoved || 0,
        totalScanned: totalScanned
      });
    } catch (e) {
      console.error(`Error reading report ${filePath}:`, e);
    }
  }
  
  summaries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  
  return summaries;
}

export async function deleteReport(reportId: string): Promise<boolean> {
  const reportsDir = getReportsDirectory();
  const filePath = path.join(reportsDir, `${reportId}.json`);
  
  if (!fs.existsSync(filePath)) {
    return false;
  }
  
  fs.unlinkSync(filePath);
  return true;
}

export function exportReportToCSV(report: FixReport): string {
  const headers = [
    'run_id',
    'run_timestamp',
    'original_filename',
    'new_filename',
    'confidence',
    'confidence_method',
    'source_path',
    'destination_path',
    'file_type',
    'date_changed',
    'exif_written',
    'exif_source',
    'status'
  ];
  
  const escapeCSV = (val: string | undefined | null): string => {
    if (val === undefined || val === null) return '""';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  
  const rows: string[] = [];
  
  // Add processed files
  report.files.forEach(f => {
    const ext = f.originalFilename.split('.').pop()?.toLowerCase() || '';
    const dateChanged = f.originalFilename !== f.newFilename;
    
    rows.push([
      escapeCSV(report.id),
      escapeCSV(report.timestamp),
      escapeCSV(f.originalFilename),
      escapeCSV(f.newFilename),
      escapeCSV(f.confidence.charAt(0).toUpperCase() + f.confidence.slice(1)),
      escapeCSV(f.dateSource),
      escapeCSV(f.sourcePath || report.sources[0]?.path || ''),
      escapeCSV(report.destinationPath),
      escapeCSV(f.fileType || ext),
      dateChanged ? 'true' : 'false',
      f.exifWritten ? 'true' : 'false',
      escapeCSV(f.exifSource || ''),
      'Processed'
    ].join(','));
  });
  
  // Add duplicate files as rows
  if (report.duplicateFiles && report.duplicateFiles.length > 0) {
    report.duplicateFiles.forEach(dup => {
      const ext = dup.filename.split('.').pop()?.toLowerCase() || '';
      const retainedFile = report.files.find(f => f.originalFilename === dup.duplicateOf);
      const retainedNewFilename = retainedFile?.newFilename || dup.duplicateOf;
      const duplicateConfidence = dup.duplicateMethod === 'heuristic' 
        ? 'Duplicate – Heuristic' 
        : 'Duplicate – Hash (SHA-256)';
      rows.push([
        escapeCSV(report.id),
        escapeCSV(report.timestamp),
        escapeCSV(dup.filename),
        escapeCSV('(skipped - duplicate)'),
        escapeCSV(duplicateConfidence),
        escapeCSV(`Retained as: ${retainedNewFilename}`),
        escapeCSV(report.sources[0]?.path || ''),
        escapeCSV(report.destinationPath),
        escapeCSV(ext),
        'false',
        'false',
        '',
        'Skipped'
      ].join(','));
    });
  }
  
  const totalScanned = report.totalScanned ?? (report.counts.confirmed + report.counts.recovered + report.counts.marked + (report.duplicatesRemoved || 0));
  
  let csvContent = [headers.join(','), ...rows].join('\n');
  csvContent += '\n\n# Summary: ' + totalScanned + ' files scanned -> ' + report.counts.total + ' output files, ' + (report.duplicatesRemoved || 0) + ' duplicates skipped';
  
  return csvContent;
}

export function exportReportToTXT(report: FixReport): string {
  const lines: string[] = [];
  const timestamp = new Date(report.timestamp);
  const totalScanned = report.totalScanned ?? (report.counts.confirmed + report.counts.recovered + report.counts.marked + (report.duplicatesRemoved || 0));
  
  lines.push('='.repeat(70));
  lines.push('PHOTO DATE RESCUE — FIX REPORT');
  lines.push('='.repeat(70));
  lines.push('');
  lines.push(`Run ID:        ${report.id}`);
  lines.push(`Timestamp:     ${timestamp.toISOString()}`);
  lines.push(`               ${timestamp.toLocaleString()}`);
  lines.push(`Destination:   ${report.destinationPath}`);
  lines.push('');
  lines.push('-'.repeat(70));
  lines.push('SOURCES');
  lines.push('-'.repeat(70));
  report.sources.forEach((s, i) => {
    lines.push(`  ${i + 1}. ${s.label} (${s.type})`);
    lines.push(`     Path: ${s.path}`);
  });
  lines.push('');
  lines.push('-'.repeat(70));
  lines.push('TOTALS');
  lines.push('-'.repeat(70));
  lines.push(`  Confirmed:     ${report.counts.confirmed.toLocaleString()} files`);
  lines.push(`  Recovered:     ${report.counts.recovered.toLocaleString()} files`);
  lines.push(`  Marked:        ${report.counts.marked.toLocaleString()} files`);
  lines.push(`  Duplicates:    ${(report.duplicatesRemoved || 0).toLocaleString()} skipped`);
  lines.push(`  ─────────────────────────`);
  lines.push(`  Total Scanned: ${totalScanned.toLocaleString()} files`);
  lines.push(`  Output Files:  ${report.counts.total.toLocaleString()} files`);
  lines.push('');
  lines.push('-'.repeat(70));
  lines.push('FILE DETAILS (Processed)');
  lines.push('-'.repeat(70));
  lines.push('');
  
  report.files.forEach((f, index) => {
    const ext = f.originalFilename.split('.').pop()?.toLowerCase() || '';
    const dateChanged = f.originalFilename !== f.newFilename;
    const confidenceLabel = f.confidence.charAt(0).toUpperCase() + f.confidence.slice(1);
    
    lines.push(`  File ${(index + 1).toString().padStart(5)}:`);
    lines.push(`    Original:    ${f.originalFilename}`);
    lines.push(`    New:         ${f.newFilename}`);
    lines.push(`    Confidence:  ${confidenceLabel}`);
    lines.push(`    Method:      ${f.dateSource}`);
    lines.push(`    File Type:   ${f.fileType || ext}`);
    lines.push(`    Changed:     ${dateChanged ? 'Yes' : 'No'}`);
    lines.push(`    EXIF Written:${f.exifWritten ? 'Yes' : 'No'}${f.exifSource ? ` (${f.exifSource})` : ''}`);
    if (f.sourcePath) {
      lines.push(`    Source:      ${f.sourcePath}`);
    }
    lines.push('');
  });
  
  // Add duplicates section if any
  if (report.duplicateFiles && report.duplicateFiles.length > 0) {
    lines.push('-'.repeat(70));
    lines.push('DUPLICATE FILES (Skipped)');
    lines.push('-'.repeat(70));
    lines.push('');
    
    report.duplicateFiles.forEach((dup, index) => {
      const retainedFile = report.files.find(f => f.originalFilename === dup.duplicateOf);
      const retainedNewFilename = retainedFile?.newFilename || dup.duplicateOf;
      const methodLabel = dup.duplicateMethod === 'heuristic' 
        ? 'Heuristic (filename + size)' 
        : 'Hash (SHA-256)';
      lines.push(`  Duplicate ${(index + 1).toString().padStart(5)}:`);
      lines.push(`    Original:    ${dup.filename}`);
      lines.push(`    Retained as: ${retainedNewFilename}`);
      lines.push(`    Method:      ${methodLabel}`);
      lines.push('');
    });
  }
  
  lines.push('='.repeat(70));
  lines.push('END OF REPORT');
  lines.push('='.repeat(70));
  
  return lines.join('\n');
}

export function getExportFilename(report: FixReport, extension: 'csv' | 'txt'): string {
  const date = new Date(report.timestamp);
  const dateStr = date.toISOString().split('T')[0];
  return `PDR_Report_${dateStr}_${report.id}.${extension}`;
}
