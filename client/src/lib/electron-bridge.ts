import type { AnalysisProgress, SourceAnalysisResult, ElectronAPI, FixReport, ReportSummary, FileChange, SourceInfo } from '../electron';

export type { FixReport, ReportSummary, FileChange, SourceInfo };

export function isElectron(): boolean {
  return typeof window !== 'undefined' && window.electronAPI !== undefined;
}

export async function openFolderDialog(): Promise<string | null> {
  if (isElectron()) {
    return window.electronAPI!.openFolder();
  }
  return null;
}

export async function openZipDialog(): Promise<string | null> {
  if (isElectron()) {
    return window.electronAPI!.openZip();
  }
  return null;
}

export async function selectDestination(): Promise<string | null> {
  if (isElectron()) {
    return window.electronAPI!.selectDestination();
  }
  return null;
}

export async function getDiskSpace(directoryPath: string): Promise<{ freeBytes: number; totalBytes: number }> {
  if (isElectron()) {
    return window.electronAPI!.getDiskSpace(directoryPath);
  }
  return { freeBytes: 0, totalBytes: 0 };
}

export async function openDestinationFolder(folderPath: string): Promise<void> {
  if (isElectron()) {
    return window.electronAPI!.openDestinationFolder(folderPath);
  }
}

export async function runAnalysis(
  sourcePath: string, 
  sourceType: 'folder' | 'zip' | 'drive'
): Promise<{ success: boolean; data?: SourceAnalysisResult; error?: string }> {
  if (isElectron()) {
    return window.electronAPI!.runAnalysis(sourcePath, sourceType);
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export function onAnalysisProgress(callback: (progress: AnalysisProgress) => void): void {
  if (isElectron()) {
    window.electronAPI!.onAnalysisProgress(callback);
  }
}

export function removeAnalysisProgressListener(): void {
  if (isElectron()) {
    window.electronAPI!.removeAnalysisProgressListener();
  }
}

export async function saveReport(reportData: Omit<FixReport, 'id' | 'timestamp'>): Promise<{ success: boolean; data?: FixReport; error?: string }> {
  if (isElectron()) {
    return window.electronAPI!.saveReport(reportData);
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function loadReport(reportId: string): Promise<{ success: boolean; data?: FixReport | null; error?: string }> {
  if (isElectron()) {
    return window.electronAPI!.loadReport(reportId);
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function loadLatestReport(): Promise<{ success: boolean; data?: FixReport | null; error?: string }> {
  if (isElectron()) {
    return window.electronAPI!.loadLatestReport();
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function listReports(): Promise<{ success: boolean; data?: ReportSummary[]; error?: string }> {
  if (isElectron()) {
    return window.electronAPI!.listReports();
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function exportReportCSV(reportId: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
  if (isElectron()) {
    return window.electronAPI!.exportReportCSV(reportId);
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function exportReportTXT(reportId: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
  if (isElectron()) {
    return window.electronAPI!.exportReportTXT(reportId);
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatBytesToGB(bytes: number): number {
  return bytes / (1024 * 1024 * 1024);
}
