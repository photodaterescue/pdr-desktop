import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export interface FileChange {
  originalFilename: string;
  newFilename: string;
  confidence: 'confirmed' | 'recovered' | 'marked';
  dateSource: string;
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
  files: FileChange[];
}

export interface ReportSummary {
  id: string;
  timestamp: string;
  destinationPath: string;
  totalFiles: number;
  sourceCount: number;
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
      summaries.push({
        id: report.id,
        timestamp: report.timestamp,
        destinationPath: report.destinationPath,
        totalFiles: report.counts.total,
        sourceCount: report.sources.length
      });
    } catch (e) {
      console.error(`Error reading report ${filePath}:`, e);
    }
  }
  
  summaries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  
  return summaries;
}

export function exportReportToCSV(report: FixReport): string {
  const headers = ['Original Filename', 'New Filename', 'Confidence', 'Date Source'];
  const rows = report.files.map(f => [
    `"${f.originalFilename.replace(/"/g, '""')}"`,
    `"${f.newFilename.replace(/"/g, '""')}"`,
    f.confidence,
    `"${f.dateSource.replace(/"/g, '""')}"`
  ].join(','));
  
  return [headers.join(','), ...rows].join('\n');
}

export function exportReportToTXT(report: FixReport): string {
  const lines: string[] = [];
  
  lines.push('='.repeat(60));
  lines.push('FIX REPORT');
  lines.push('='.repeat(60));
  lines.push('');
  lines.push(`Report ID: ${report.id}`);
  lines.push(`Generated: ${new Date(report.timestamp).toLocaleString()}`);
  lines.push(`Destination: ${report.destinationPath}`);
  lines.push('');
  lines.push('-'.repeat(40));
  lines.push('SOURCES');
  lines.push('-'.repeat(40));
  report.sources.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.label} (${s.type})`);
    lines.push(`   ${s.path}`);
  });
  lines.push('');
  lines.push('-'.repeat(40));
  lines.push('SUMMARY');
  lines.push('-'.repeat(40));
  lines.push(`Confirmed: ${report.counts.confirmed}`);
  lines.push(`Recovered: ${report.counts.recovered}`);
  lines.push(`Marked: ${report.counts.marked}`);
  lines.push(`Total: ${report.counts.total}`);
  lines.push('');
  lines.push('-'.repeat(40));
  lines.push('FILE CHANGES');
  lines.push('-'.repeat(40));
  
  report.files.forEach(f => {
    lines.push(`[${f.confidence.toUpperCase()}] ${f.originalFilename}`);
    lines.push(`  -> ${f.newFilename}`);
    lines.push(`  Source: ${f.dateSource}`);
    lines.push('');
  });
  
  return lines.join('\n');
}
