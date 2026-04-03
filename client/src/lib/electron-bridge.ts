import type { AnalysisProgress, SourceAnalysisResult, ElectronAPI, FixReport, ReportSummary, FileChange, SourceInfo } from '../electron';

export type { FixReport, ReportSummary, FileChange, SourceInfo };

export function isElectron(): boolean {
  return typeof window !== 'undefined' && (window as any).pdr !== undefined;
}

export async function openFolderDialog(): Promise<string | null> {
  if (isElectron()) {
    return (window as any).pdr.openFolder();
  }
  return null;
}

export async function openZipDialog(): Promise<string | null> {
  if (isElectron()) {
    return (window as any).pdr.openZip();
  }
  return null;
}

export async function selectDestination(): Promise<string | null> {
  if (isElectron()) {
    return (window as any).pdr.selectDestination();
  }
  return null;
}

export async function prescanDestination(destinationPath: string): Promise<{
  success: boolean;
  data?: {
    totalFiles: number;
    hashes: Record<string, string>;
    heuristics: Record<string, string>;
  };
  error?: string;
}> {
  if (isElectron() && (window as any).pdr?.prescanDestination) {
    return (window as any).pdr.prescanDestination(destinationPath);
  }
  return { success: false, error: 'Not running in Electron' };
}

export function onDestinationPrescanProgress(callback: (data: { scanned: number }) => void): () => void {
  if (isElectron() && (window as any).pdr?.onDestinationPrescanProgress) {
    return (window as any).pdr.onDestinationPrescanProgress(callback);
  }
  return () => {};
}

export async function getDiskSpace(directoryPath: string): Promise<{ freeBytes: number; totalBytes: number }> {
  if (isElectron()) {
    return (window as any).pdr.getDiskSpace(directoryPath);
  }
  return { freeBytes: 0, totalBytes: 0 };
}

export async function openDestinationFolder(folderPath: string): Promise<void> {
  if (isElectron()) {
    return (window as any).pdr.openDestinationFolder(folderPath);
  }
}

export async function runAnalysis(
  sourcePath: string, 
  sourceType: 'folder' | 'zip' | 'drive'
): Promise<{ success: boolean; data?: SourceAnalysisResult; error?: string }> {
  if (isElectron()) {
    return (window as any).pdr.runAnalysis(sourcePath, sourceType);
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export function onAnalysisProgress(callback: (progress: AnalysisProgress) => void): void {
  if (isElectron()) {
    (window as any).pdr.onAnalysisProgress(callback);
  }
}

export function removeAnalysisProgressListener(): void {
  if (isElectron()) {
    (window as any).pdr.removeAnalysisProgressListener();
  }
}

export async function saveReport(reportData: Omit<FixReport, 'id' | 'timestamp'>): Promise<{ success: boolean; data?: FixReport; error?: string }> {
  if (isElectron()) {
    return (window as any).pdr.saveReport(reportData);
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function copyFiles(data: {
  files: Array<{ sourcePath: string; newFilename: string; sourceType: 'folder' | 'zip' }>;
  destinationPath: string;
  zipPaths?: Record<string, string>;
  existingDestinationHashes?: Record<string, string>;
  existingDestinationHeuristics?: Record<string, string>;
}): Promise<{ success: boolean; copied?: number; failed?: number; error?: string; skippedExisting?: number }> {
  if (isElectron()) {
    return (window as any).pdr.copyFiles(data);
  }
  return { success: false, error: 'Not in Electron environment' };
}

export function onCopyProgress(callback: (progress: { current: number; total: number }) => void): void {
  if (isElectron()) {
    (window as any).pdr.onCopyProgress(callback);
  }
}

export async function cancelCopyFiles(): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.cancelCopyFiles) {
    return (window as any).pdr.cancelCopyFiles();
  }
  return { success: false };
}

export async function playCompletionSound(): Promise<void> {
  if (isElectron() && (window as any).pdr?.playCompletionSound) {
    try {
      await (window as any).pdr.playCompletionSound();
    } catch (e) {
      console.log('Could not play completion sound');
    }
  }
}

export async function flashTaskbar(): Promise<void> {
  if (isElectron() && (window as any).pdr?.flashTaskbar) {
    await (window as any).pdr.flashTaskbar();
  }
}

export async function loadReport(reportId: string): Promise<{ success: boolean; data?: FixReport | null; error?: string }> {
  if (isElectron()) {
    return (window as any).pdr.loadReport(reportId);
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function loadLatestReport(): Promise<{ success: boolean; data?: FixReport | null; error?: string }> {
  if (isElectron()) {
    return (window as any).pdr.loadLatestReport();
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function listReports(): Promise<{ success: boolean; data?: ReportSummary[]; error?: string }> {
  if (isElectron()) {
    return (window as any).pdr.listReports();
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function exportReportCSV(reportId: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
  if (isElectron()) {
    return (window as any).pdr.exportReportCSV(reportId);
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function exportReportTXT(reportId: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
  if (isElectron()) {
    return (window as any).pdr.exportReportTXT(reportId);
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function deleteReport(reportId: string): Promise<{ success: boolean; error?: string }> {
  if (isElectron()) {
    return (window as any).pdr.deleteReport(reportId);
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

// Settings types and functions
const defaultSettings: PDRSettings = {
  skipDuplicates: true,
  writeExif: false,
  exifWriteConfirmed: true,
  exifWriteRecovered: true,
  exifWriteMarked: false,
  showStoragePerformanceTips: true,
};

export async function getSettings(): Promise<PDRSettings> {
  if (isElectron()) {
    return (window as any).pdr.settings.get();
  }
  // Fallback: return defaults when not in Electron
  return defaultSettings;
}

export async function setSetting<K extends keyof PDRSettings>(key: K, value: PDRSettings[K]): Promise<{ success: boolean }> {
  if (isElectron()) {
    return (window as any).pdr.settings.set(key, value);
  }
  return { success: false };
}

export async function setSettings(settings: Partial<PDRSettings>): Promise<{ success: boolean }> {
  if (isElectron()) {
    return (window as any).pdr.settings.setAll(settings);
  }
  return { success: false };
}

export async function resetSettingsToDefaults(): Promise<{ success: boolean }> {
  if (isElectron()) {
    return (window as any).pdr.settings.resetToDefaults();
  }
  return { success: false };
}

export function formatBytesToGB(bytes: number): number {
  return bytes / (1024 * 1024 * 1024);
}

export async function openExternalUrl(url: string): Promise<void> {
  if (isElectron() && (window as any).pdr?.openExternal) {
    try {
      await (window as any).pdr.openExternal(url);
    } catch (e) {
      console.error('Could not open external URL:', e);
    }
  }
}

// License types and functions
export interface LicenseStatus {
  isValid: boolean;
  status: 'active' | 'inactive' | 'expired' | 'invalid' | 'none';
  plan: 'monthly' | 'yearly' | 'lifetime' | null;
  canUsePremiumFeatures: boolean;
  isOfflineGrace: boolean;
  daysUntilGraceExpires: number | null;
  customerEmail: string | null;
}

export async function getLicenseStatus(): Promise<LicenseStatus> {
  if (isElectron() && (window as any).pdr?.license) {
    return (window as any).pdr.license.getStatus();
  }
  return {
    isValid: false,
    status: 'none',
    plan: null,
    canUsePremiumFeatures: false,
    isOfflineGrace: false,
    daysUntilGraceExpires: null,
    customerEmail: null,
  };
}

export async function activateLicense(licenseKey: string): Promise<{ success: boolean; error?: string; status?: LicenseStatus }> {
  if (isElectron() && (window as any).pdr?.license) {
    return (window as any).pdr.license.activate(licenseKey);
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function refreshLicense(licenseKey: string): Promise<{ success: boolean; error?: string; status?: LicenseStatus }> {
  if (isElectron() && (window as any).pdr?.license) {
    return (window as any).pdr.license.refresh(licenseKey);
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function deactivateLicense(licenseKey: string): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.license) {
    return (window as any).pdr.license.deactivate(licenseKey);
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function getMachineId(): Promise<string> {
  if (isElectron() && (window as any).pdr?.license) {
    return (window as any).pdr.license.getMachineId();
  }
  return 'unknown';
}

// Update checking types and functions
export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  mandatory: boolean;
  downloadUrl: string;
  releaseNotes?: string;
}

export async function checkForUpdates(): Promise<UpdateInfo> {
  if (isElectron() && (window as any).pdr?.updates) {
    return (window as any).pdr.updates.check();
  }
  return {
    currentVersion: '0.0.0',
    latestVersion: '0.0.0',
    updateAvailable: false,
    mandatory: false,
    downloadUrl: '',
  };
}

export async function getAppVersion(): Promise<string> {
  if (isElectron() && (window as any).pdr?.updates) {
    return (window as any).pdr.updates.getVersion();
  }
  return '0.0.0';
}

// Storage classification types and functions
export interface StorageClassification {
  type: 'local-ssd' | 'local-hdd' | 'network' | 'cloud-sync' | 'unknown';
  speed: 'fast' | 'medium' | 'slow';
  label: string;
  description: string;
  isOptimal: boolean;
}

export interface SameDriveWarning {
  showWarning: boolean;
  message: string;
}

export async function classifyStorage(sourcePath: string): Promise<StorageClassification | null> {
  if (isElectron() && (window as any).pdr?.storage) {
    return (window as any).pdr.storage.classify(sourcePath);
  }
  return null;
}

export async function checkSameDriveWarning(sourcePath: string, outputPath: string): Promise<SameDriveWarning | null> {
  if (isElectron() && (window as any).pdr?.storage) {
    return (window as any).pdr.storage.checkSameDrive(sourcePath, outputPath);
  }
  return null;
}

// Pre-scan types and functions
export interface PreScanProgress {
  fileCount: number;
  photoCount: number;
  videoCount: number;
  totalBytes: number;
  timedOut: boolean;
  elapsed: number;
}

export interface PreScanResult {
  success: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
  error?: string;
  data?: {
    fileCount: number;
    photoCount: number;
    videoCount: number;
    totalBytes: number;
  };
}

export async function runPreScan(
  sourcePath: string, 
  sourceType: 'folder' | 'zip',
  noTimeout: boolean = false
): Promise<PreScanResult> {
  if (isElectron() && (window as any).pdr?.prescan) {
    return (window as any).pdr.prescan.run(sourcePath, sourceType, noTimeout);
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function cancelPreScan(): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.prescan) {
    return (window as any).pdr.prescan.cancel();
  }
  return { success: false };
}

export function onPreScanProgress(callback: (progress: PreScanProgress) => void): void {
  if (isElectron() && (window as any).pdr?.prescan) {
    (window as any).pdr.prescan.onProgress(callback);
  }
}

export function removePreScanProgressListener(): void {
  if (isElectron() && (window as any).pdr?.prescan) {
    (window as any).pdr.prescan.removeProgressListener();
  }
}