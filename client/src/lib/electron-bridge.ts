import type { AnalysisProgress, SourceAnalysisResult, ElectronAPI, FixReport, ReportSummary, FileChange, SourceInfo } from '../electron';

export type { FixReport, ReportSummary, FileChange, SourceInfo };

export function isElectron(): boolean {
  return typeof window !== 'undefined' && (window as any).pdr !== undefined;
}

/** Send a log line to the main-process log file (survives app exit,
 *  visible even when DevTools are disabled in production). Safe to
 *  call from non-Electron contexts — becomes a no-op. */
export function logToFile(level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: unknown): void {
  if (!isElectron()) return;
  try { (window as any).pdr?.log?.({ level, message, data }); } catch {}
}

/** Return the absolute path of the persistent main-process log file.
 *  `reveal === true` also opens the folder in the OS file explorer. */
export async function getLogFilePath(reveal: boolean = false): Promise<{ path: string } | null> {
  if (!isElectron()) return null;
  try { return await (window as any).pdr?.getLogFilePath?.(reveal); } catch { return null; }
}

/** Build a one-click support bundle: opens the user's mail client
 *  with a pre-filled message (system info + recent log tail inline)
 *  AND reveals the log file in Explorer so the user can drag it in
 *  as an attachment. Returns the log file path so the calling UI can
 *  display it. */
export async function reportProblem(payload: { description: string; userEmail?: string }): Promise<{ success: boolean; logFilePath?: string; error?: string }> {
  if (!isElectron()) return { success: false, error: 'Not running in Electron' };
  try { return await (window as any).pdr?.reportProblem?.(payload); }
  catch (err) { return { success: false, error: (err as Error).message }; }
}

// Install a one-time console bridge — mirror every console.error and
// console.warn from the renderer into the persistent log file so we
// don't need users to open DevTools to get useful bug reports. Keeps
// the original console behaviour intact (for dev).
if (isElectron() && typeof window !== 'undefined' && !(window as any).__pdrConsoleBridged) {
  (window as any).__pdrConsoleBridged = true;
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    origError(...args);
    try { logToFile('error', args.map(a => typeof a === 'string' ? a : safeStringify(a)).join(' ')); } catch {}
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    try { logToFile('warn', args.map(a => typeof a === 'string' ? a : safeStringify(a)).join(' ')); } catch {}
  };
  // Uncaught exceptions + unhandled promise rejections — the most
  // common crash signatures, previously lost because DevTools was off.
  window.addEventListener('error', (e) => {
    logToFile('error', `window.error: ${e.message}`, { filename: e.filename, lineno: e.lineno, colno: e.colno, stack: e.error?.stack });
  });
  window.addEventListener('unhandledrejection', (e) => {
    logToFile('error', `unhandledrejection: ${String(e.reason?.message ?? e.reason)}`, { stack: e.reason?.stack });
  });
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
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

/** Diagnostic stream from the analysis pipeline — phase markers,
 *  memory snapshots, per-large-file timings, skip-and-continue
 *  reasons, final summary. Renderer just console.logs the strings
 *  so they surface in F12 alongside other front-end logging during
 *  a 50 GB Takeout test run. */
export function onAnalysisDiagnostic(callback: (msg: string) => void): void {
  if (isElectron() && typeof (window as any).pdr?.onAnalysisDiagnostic === 'function') {
    (window as any).pdr.onAnalysisDiagnostic(callback);
  }
}

export function removeAnalysisDiagnosticListener(): void {
  if (isElectron() && typeof (window as any).pdr?.removeAnalysisDiagnosticListener === 'function') {
    (window as any).pdr.removeAnalysisDiagnosticListener();
  }
}

/** Best-effort cleanup of the extracted temp dir associated with a
 *  source (large zip / RAR). Called when the user removes a source
 *  from the source menu so their disk doesn't carry a 50 GB
 *  extraction it no longer needs. Safe to call even when there's
 *  nothing to clean — returns `{ success: true, cleaned: 0 }`. */
export async function cleanupTempDirForSource(sourcePath: string): Promise<{ success: boolean; cleaned: number }> {
  if (isElectron() && typeof (window as any).pdr?.cleanupTempDirForSource === 'function') {
    return await (window as any).pdr.cleanupTempDirForSource(sourcePath);
  }
  return { success: false, cleaned: 0 };
}

export async function saveReport(reportData: Omit<FixReport, 'id' | 'timestamp'>): Promise<{ success: boolean; data?: FixReport; error?: string }> {
  if (isElectron()) {
    return (window as any).pdr.saveReport(reportData);
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function copyFiles(data: {
  files: Array<{ sourcePath: string; newFilename: string; sourceType: 'folder' | 'zip'; derivedDate?: string | null; dateConfidence?: string; dateSource?: string; isDuplicate?: boolean; duplicateOf?: string; originSourcePath?: string }>;
  destinationPath: string;
  zipPaths?: Record<string, string>;
  folderStructure?: 'year' | 'year-month' | 'year-month-day';
  settings?: {
    skipDuplicates?: boolean;
    thoroughDuplicateMatching?: boolean;
    writeExif?: boolean;
    exifWriteConfirmed?: boolean;
    exifWriteRecovered?: boolean;
    exifWriteMarked?: boolean;
  };
  existingDestinationHashes?: Record<string, string>;
  existingDestinationHeuristics?: Record<string, string>;
  photoFormat?: 'original' | 'png' | 'jpg';
}): Promise<{ success: boolean; copied?: number; failed?: number; error?: string; skippedExisting?: number; duplicatesRemoved?: number; duplicateFiles?: Array<{ filename: string; duplicateOf: string }>; results?: Array<{ success: boolean; sourcePath?: string; exifWritten?: boolean; exifSource?: string }> }> {
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

/** Phase notifications from the network-destination staging path.
 *  'staging' = writing to local temp folder. 'mirror' = robocopy is
 *  pushing the staged tree to the network destination. UI uses these
 *  to swap the progress label so the bar doesn't appear frozen at
 *  100% during the network push. No-op outside Electron. */
export function onCopyPhase(callback: (phase: { phase: 'staging' | 'mirror'; message: string }) => void): void {
  if (isElectron() && (window as any).pdr?.onCopyPhase) {
    (window as any).pdr.onCopyPhase(callback);
  }
}

/** Per-file ticks from robocopy during the mirror phase. */
export function onCopyMirrorProgress(callback: (progress: { filesMirrored: number; totalToMirror: number }) => void): void {
  if (isElectron() && (window as any).pdr?.onCopyMirrorProgress) {
    (window as any).pdr.onCopyMirrorProgress(callback);
  }
}

export async function cancelCopyFiles(): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.cancelCopyFiles) {
    return (window as any).pdr.cancelCopyFiles();
  }
  return { success: false };
}

export async function setFixInProgress(inProgress: boolean): Promise<void> {
  if (isElectron() && (window as any).pdr?.setFixInProgress) {
    await (window as any).pdr.setFixInProgress(inProgress);
  }
}

/** Pull the current fix-in-progress flag from the main process.
 *  Used by windows that open mid-fix (e.g. PM launched while a fix
 *  is running) to gate mutating actions on first render rather
 *  than waiting for the next state-change broadcast. */
export async function getFixInProgress(): Promise<boolean> {
  if (isElectron() && (window as any).pdr?.getFixInProgress) {
    try { return !!(await (window as any).pdr.getFixInProgress()); } catch { return false; }
  }
  return false;
}

/** Subscribe to cross-window fix-state changes. Main process
 *  broadcasts whenever any window calls setFixInProgress. Returns
 *  an unsubscribe fn (no-op outside Electron). */
export function onFixStateChanged(callback: (state: { inProgress: boolean }) => void): () => void {
  if (isElectron() && (window as any).pdr?.onFixStateChanged) {
    return (window as any).pdr.onFixStateChanged(callback);
  }
  return () => {};
}

/** Fix progress payload broadcast cross-window so PM (separate
 *  window) can render a real chip with numbers instead of just a
 *  boolean. */
export interface FixProgressPayload {
  phase: 'prescan' | 'staging' | 'mirror' | 'applying' | null;
  processed: number;
  total: number;
  progressPct: number;
  mirrorDone: number;
  mirrorTotal: number;
  prescanCount: number;
  elapsed: number;
  isPrescanning: boolean;
}

export async function broadcastFixProgress(payload: FixProgressPayload): Promise<void> {
  if (isElectron() && (window as any).pdr?.broadcastFixProgress) {
    try { await (window as any).pdr.broadcastFixProgress(payload); } catch { /* non-fatal */ }
  }
}

export async function getFixProgress(): Promise<FixProgressPayload | null> {
  if (isElectron() && (window as any).pdr?.getFixProgress) {
    try { return (await (window as any).pdr.getFixProgress()) ?? null; } catch { return null; }
  }
  return null;
}

export function onFixProgress(callback: (payload: FixProgressPayload) => void): () => void {
  if (isElectron() && (window as any).pdr?.onFixProgress) {
    return (window as any).pdr.onFixProgress(callback);
  }
  return () => {};
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

export async function exportReportCSV(reportId: string, folderPath?: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
  if (isElectron()) {
    return (window as any).pdr.exportReportCSV(reportId, folderPath);
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function exportReportTXT(reportId: string, folderPath?: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
  if (isElectron()) {
    return (window as any).pdr.exportReportTXT(reportId, folderPath);
  }
  return { success: false, error: 'Not running in Electron environment' };
}

export async function getDefaultExportPath(reportId: string): Promise<{ success: boolean; path: string }> {
  if (isElectron()) {
    return (window as any).pdr.getDefaultExportPath(reportId);
  }
  return { success: false, path: '' };
}

export async function regenerateCatalogue(destinationPath: string): Promise<{ success: boolean; error?: string }> {
  if (isElectron()) {
    return (window as any).pdr.regenerateCatalogue(destinationPath);
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
export interface PDRSettings {
  skipDuplicates: boolean;
  thoroughDuplicateMatching?: boolean;
  writeExif: boolean;
  exifWriteConfirmed: boolean;
  exifWriteRecovered: boolean;
  exifWriteMarked: boolean;
  showStoragePerformanceTips: boolean;
  rememberSources: boolean;
  clearSourcesAfterFix: boolean;
  // AI Photo Analysis
  aiEnabled: boolean;
  aiFaceDetection: boolean;
  aiObjectTagging: boolean;
  aiAutoProcess: boolean;
  aiMinFaceConfidence: number;
  aiMinTagConfidence: number;
  aiVisualSuggestions: boolean;
  // Auto-catalogue
  autoSaveCatalogue: boolean;
  showManualReportExports: boolean;
  // Face matching
  matchThreshold: number;
}

const defaultSettings: PDRSettings = {
  skipDuplicates: true,
  writeExif: false,
  exifWriteConfirmed: true,
  exifWriteRecovered: true,
  exifWriteMarked: false,
  showStoragePerformanceTips: true,
  rememberSources: true,
  clearSourcesAfterFix: true,
  aiEnabled: false,
  aiFaceDetection: true,
  aiObjectTagging: true,
  aiAutoProcess: true,
  aiMinFaceConfidence: 0.7,
  aiMinTagConfidence: 0.3,
  aiVisualSuggestions: true,
  autoSaveCatalogue: true,
  showManualReportExports: false,
  matchThreshold: 0.72,
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

// Folder browser types and functions
export interface DriveInfo {
  letter: string;
  label: string;
  type: string;
  totalBytes: number;
  freeBytes: number;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isImage: boolean;
  isArchive: boolean;
  sizeBytes: number;
  hasSubfolders: boolean;
  /** Unix ms epoch — mtimeMs from fs.stat. 0 if stat failed. */
  modifiedAt: number;
}

export async function listDrives(): Promise<DriveInfo[]> {
  if (isElectron() && (window as any).pdr?.browser) {
    return (window as any).pdr.browser.listDrives();
  }
  return [];
}

export async function readDirectory(dirPath: string, fileFilter?: string): Promise<{ success: boolean; items: DirectoryEntry[]; error?: string }> {
  if (isElectron() && (window as any).pdr?.browser) {
    return (window as any).pdr.browser.readDirectory(dirPath, fileFilter);
  }
  return { success: false, items: [], error: 'Not running in Electron' };
}

export async function createDirectory(dirPath: string): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.browser) {
    return (window as any).pdr.browser.createDirectory(dirPath);
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function getThumbnail(filePath: string, size: number): Promise<{ success: boolean; dataUrl: string }> {
  if (isElectron() && (window as any).pdr?.browser) {
    return (window as any).pdr.browser.thumbnail(filePath, size);
  }
  return { success: false, dataUrl: '' };
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

// ─── Search & Discovery types and functions ──────────────────────────────────

export interface SearchQuery {
  text?: string;
  confidence?: string[];
  fileType?: string[];
  dateSource?: string[];
  yearFrom?: number;
  yearTo?: number;
  monthFrom?: number;
  monthTo?: number;
  cameraMake?: string[];
  cameraModel?: string[];
  lensModel?: string[];
  hasGps?: boolean;
  country?: string[];
  city?: string[];
  runId?: number;
  destinationPath?: string[];
  extension?: string[];
  dateFrom?: string;
  dateTo?: string;
  isoFrom?: number;
  isoTo?: number;
  apertureFrom?: number;
  apertureTo?: number;
  focalLengthFrom?: number;
  focalLengthTo?: number;
  flashFired?: boolean;
  megapixelsFrom?: number;
  megapixelsTo?: number;
  sizeFrom?: number;
  sizeTo?: number;
  sceneCaptureType?: string[];
  exposureProgram?: string[];
  whiteBalance?: string[];
  cameraPosition?: string[];
  orientation?: string[];
  // AI filters
  personId?: number[];
  personIdMode?: 'and' | 'or';
  /** Tri-state filter for the AI ribbon's Matched / Verified / Both
   *  toggle. 'matched' = only auto-matched faces (verified=0),
   *  'verified' = only manually-confirmed (verified=1), 'both' =
   *  either. Backend takes precedence over the legacy
   *  personVerifiedOnly boolean when set. */
  personMatchMode?: 'matched' | 'verified' | 'both';
  /** Cosine similarity floor for auto-matched faces — drives the
   *  S&D Match Sensitivity slider. 0.65–0.95 typical range. */
  personMatchThreshold?: number;
  personVerifiedOnly?: boolean;
  aiTag?: string[];
  aiTagMode?: 'and' | 'or';
  // Determines whether personId + aiTag conditions AND together (default,
  // intersection — photos must have both) or OR together (union — photos
  // that match either). OR is used when the search bar mixes a person and
  // a tag with a comma operator.
  textFilterJoin?: 'and' | 'or';
  hasFaces?: boolean;
  hasUnnamedFaces?: boolean;
  hasAiTags?: boolean;
  hasNamedPeople?: boolean;
  aiProcessed?: 'all' | 'unprocessed' | 'faces_only' | 'tags_only' | 'both';
  faceCountMin?: number;
  faceCountMax?: number;
  personTogetherIds?: number[];
  sortBy?: 'derived_date' | 'filename' | 'size_bytes' | 'confidence' | 'camera_model';
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface IndexedFile {
  id: number;
  run_id: number;
  file_path: string;
  filename: string;
  extension: string;
  file_type: string;
  size_bytes: number;
  hash: string | null;
  confidence: string;
  date_source: string;
  original_filename: string;
  derived_date: string | null;
  year: number | null;
  month: number | null;
  day: number | null;
  camera_make: string | null;
  camera_model: string | null;
  lens_model: string | null;
  width: number | null;
  height: number | null;
  megapixels: number | null;
  iso: number | null;
  shutter_speed: string | null;
  aperture: number | null;
  focal_length: number | null;
  flash_fired: number | null;
  gps_lat: number | null;
  gps_lon: number | null;
  gps_alt: number | null;
  geo_country: string | null;
  geo_country_code: string | null;
  geo_city: string | null;
  exif_read_ok: number;
  indexed_at: string;
}

export interface SearchResult {
  files: IndexedFile[];
  total: number;
  limit: number;
  offset: number;
}

export interface FilterOptions {
  confidences: string[];
  fileTypes: string[];
  dateSources: string[];
  years: number[];
  cameraMakes: string[];
  cameraModels: string[];
  extensions: string[];
  lensModels?: string[];
  sceneCaptureTypes?: string[];
  exposurePrograms?: string[];
  whiteBalances?: string[];
  cameraPositions?: string[];
  orientations?: string[];
  countries?: string[];
  cities?: string[];
  destinations: string[];
  runs: Array<{ id: number; report_id: string; destination_path: string; indexed_at: string; file_count: number }>;
}

export interface IndexStats {
  totalFiles: number;
  totalRuns: number;
  totalPhotos: number;
  totalVideos: number;
  totalSizeBytes: number;
  oldestDate: string | null;
  newestDate: string | null;
  dbSizeBytes: number;
}

export interface IndexProgress {
  phase: 'reading-exif' | 'inserting' | 'complete';
  current: number;
  total: number;
  currentFile: string;
}

export interface IndexedRun {
  id: number;
  report_id: string;
  destination_path: string;
  indexed_at: string;
  file_count: number;
  source_labels: string;
}

export interface FavouriteFilter {
  id: number;
  name: string;
  query_json: string;
  created_at: string;
}

// Search database init
export async function initSearchDatabase(): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.search) {
    return (window as any).pdr.search.init();
  }
  return { success: false, error: 'Not running in Electron' };
}

// Index a fix run by report ID
export async function indexFixRun(reportId: string): Promise<{ success: boolean; runId?: number; fileCount?: number; error?: string }> {
  if (isElectron() && (window as any).pdr?.search) {
    return (window as any).pdr.search.indexRun(reportId);
  }
  return { success: false, error: 'Not running in Electron' };
}

// Cancel ongoing indexing
export async function cancelSearchIndexing(): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.search) {
    return (window as any).pdr.search.cancelIndex();
  }
  return { success: false };
}

// Remove an indexed run
export async function removeSearchRun(runId: number): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.search) {
    return (window as any).pdr.search.removeRun(runId);
  }
  return { success: false, error: 'Not running in Electron' };
}

// Remove an indexed run by report ID
export async function removeSearchRunByReport(reportId: string): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.search) {
    return (window as any).pdr.search.removeRunByReport(reportId);
  }
  return { success: false, error: 'Not running in Electron' };
}

// List all indexed runs
export async function listSearchRuns(): Promise<{ success: boolean; data?: IndexedRun[]; error?: string }> {
  if (isElectron() && (window as any).pdr?.search) {
    return (window as any).pdr.search.listRuns();
  }
  return { success: false, error: 'Not running in Electron' };
}

// Search files
export async function searchFiles(query: SearchQuery): Promise<{ success: boolean; data?: SearchResult; error?: string }> {
  if (isElectron() && (window as any).pdr?.search) {
    return (window as any).pdr.search.query(query);
  }
  return { success: false, error: 'Not running in Electron' };
}

// Get filter options for dropdowns
export async function getSearchFilterOptions(): Promise<{ success: boolean; data?: FilterOptions; error?: string }> {
  if (isElectron() && (window as any).pdr?.search) {
    return (window as any).pdr.search.filterOptions();
  }
  return { success: false, error: 'Not running in Electron' };
}

// Get index statistics
export async function getSearchStats(): Promise<{ success: boolean; data?: IndexStats; error?: string }> {
  if (isElectron() && (window as any).pdr?.search) {
    return (window as any).pdr.search.stats();
  }
  return { success: false, error: 'Not running in Electron' };
}

// Rebuild entire index (clear all data)
export async function rebuildSearchIndex(): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.search) {
    return (window as any).pdr.search.rebuildIndex();
  }
  return { success: false, error: 'Not running in Electron' };
}

// Run database cleanup (remove duplicate files, stale files — returns stale runs for user decision)
export async function runSearchCleanup(): Promise<{ success: boolean; data?: { staleRuns: any[]; duplicatesRemoved: number; staleRemoved: number; totalChecked: number }; error?: string }> {
  if (isElectron() && (window as any).pdr?.search) {
    return (window as any).pdr.search.cleanup();
  }
  return { success: false, error: 'Not running in Electron' };
}

// Relocate an indexed run to a new destination path
export async function relocateSearchRun(runId: number, newPath: string): Promise<{ success: boolean; data?: { filesUpdated: number }; error?: string }> {
  if (isElectron() && (window as any).pdr?.search) {
    return (window as any).pdr.search.relocateRun(runId, newPath);
  }
  return { success: false, error: 'Not running in Electron' };
}

// Listen for stale runs detected on startup
export function onStaleRuns(callback: (runs: IndexedRun[]) => void): () => void {
  if (isElectron() && (window as any).pdr?.search?.onStaleRuns) {
    return (window as any).pdr.search.onStaleRuns(callback);
  }
  return () => {};
}

// Index progress listener
export function onSearchIndexProgress(callback: (progress: IndexProgress) => void): void {
  if (isElectron() && (window as any).pdr?.search) {
    (window as any).pdr.search.onIndexProgress(callback);
  }
}

export function removeSearchIndexProgressListener(): void {
  if (isElectron() && (window as any).pdr?.search) {
    (window as any).pdr.search.removeIndexProgressListener();
  }
}

// Favourite filters
export async function listFavouriteFilters(): Promise<{ success: boolean; data?: FavouriteFilter[]; error?: string }> {
  if (isElectron() && (window as any).pdr?.search) {
    return (window as any).pdr.search.favourites.list();
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function saveFavouriteFilter(name: string, query: SearchQuery): Promise<{ success: boolean; data?: FavouriteFilter; error?: string }> {
  if (isElectron() && (window as any).pdr?.search) {
    return (window as any).pdr.search.favourites.save(name, query);
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function deleteFavouriteFilter(id: number): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.search) {
    return (window as any).pdr.search.favourites.delete(id);
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function renameFavouriteFilter(id: number, name: string): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.search) {
    return (window as any).pdr.search.favourites.rename(id, name);
  }
  return { success: false, error: 'Not running in Electron' };
}

// Open detached viewer window — supports single or multiple files
// Check if destination paths exist (drive availability)
export async function checkPathsExist(paths: string[]): Promise<Record<string, boolean>> {
  if (isElectron() && (window as any).pdr?.search) {
    const result = await (window as any).pdr.search.checkPathsExist(paths);
    if (result.success) return result.data;
  }
  return {};
}

export async function prepareVideoForPlayback(filePath: string): Promise<{ success: boolean; playableUrl?: string; error?: string }> {
  if (isElectron() && (window as any).pdr?.video?.prepare) {
    return (window as any).pdr.video.prepare(filePath);
  }
  return { success: false, error: 'Not running in Electron' };
}

// ─── Date editor ─────────────────────────────────────────────────────────────

export interface DateSuggestion {
  id: string;
  iso: string;
  label: string;
  reason: string;
  source: 'neighbour' | 'sequence' | 'folder' | 'faces' | 'gps' | 'filename';
  confidence: number;
}

export interface ApplyDateResult {
  success: boolean;
  applied: Array<{
    fileId: number;
    oldPath: string;
    newPath: string;
    oldDate: string | null;
    newDate: string;
    exifWritten: boolean;
    renamed: boolean;
    error?: string;
  }>;
  errors: Array<{ fileId: number; error: string }>;
}

export async function getDateSuggestions(fileId: number): Promise<{ success: boolean; data?: DateSuggestion[]; error?: string }> {
  if (isElectron() && (window as any).pdr?.date?.getSuggestions) {
    return (window as any).pdr.date.getSuggestions(fileId);
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function applyDateCorrection(opts: {
  fileIds: number[];
  date: string | Record<number, string>;
  writeExif: boolean;
  renameFile: boolean;
  reason?: string;
}): Promise<{ success: boolean; data?: ApplyDateResult; error?: string }> {
  if (isElectron() && (window as any).pdr?.date?.apply) {
    return (window as any).pdr.date.apply(opts);
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function undoLastDateCorrection(): Promise<{ success: boolean; undone?: any; error?: string }> {
  if (isElectron() && (window as any).pdr?.date?.undo) {
    return (window as any).pdr.date.undo();
  }
  return { success: false, error: 'Not running in Electron' };
}

// ─── Scanner overrides ─────────────────────────────────────────────────────

export interface ScannerOverride {
  make: string;
  model: string;
  isScanner: boolean;
  addedAt: string;
}

export async function listScannerOverrides(): Promise<{ success: boolean; data?: ScannerOverride[]; error?: string }> {
  if (isElectron() && (window as any).pdr?.scannerOverride?.list) {
    return (window as any).pdr.scannerOverride.list();
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function setScannerOverride(args: { make: string; model: string; isScanner: boolean }): Promise<{ success: boolean; data?: { list: ScannerOverride[]; updated: number }; error?: string }> {
  if (isElectron() && (window as any).pdr?.scannerOverride?.set) {
    return (window as any).pdr.scannerOverride.set(args);
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function clearScannerOverride(args: { make: string; model: string }): Promise<{ success: boolean; data?: { list: ScannerOverride[] }; error?: string }> {
  if (isElectron() && (window as any).pdr?.scannerOverride?.clear) {
    return (window as any).pdr.scannerOverride.clear(args);
  }
  return { success: false, error: 'Not running in Electron' };
}

// ─── Memories ──────────────────────────────────────────────────────────────

export interface MemoriesYearBucket {
  year: number;
  month: number;
  photoCount: number;
  videoCount: number;
  sampleFilePath: string | null;
  sampleFileId: number | null;
}

export interface MemoriesOnThisDayItem {
  id: number;
  file_path: string;
  filename: string;
  file_type: string;
  derived_date: string | null;
  year: number | null;
}

export async function getMemoriesYearMonthBuckets(runIds?: number[]): Promise<{ success: boolean; data?: MemoriesYearBucket[]; error?: string }> {
  if (isElectron() && (window as any).pdr?.memories) {
    return (window as any).pdr.memories.yearMonthBuckets(runIds);
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function getMemoriesOnThisDay(args: { month: number; day: number; runIds?: number[]; limit?: number }): Promise<{ success: boolean; data?: MemoriesOnThisDayItem[]; error?: string }> {
  if (isElectron() && (window as any).pdr?.memories) {
    return (window as any).pdr.memories.onThisDay(args);
  }
  return { success: false, error: 'Not running in Electron' };
}

// `month` and `day` are optional — omit either to widen the drill-down.
// e.g. { year: 2005 } returns the whole year; { year, month } returns
// the whole month; { year, month, day } the original single-day query.
export async function getMemoriesDayFiles(args: { year: number; month?: number | null; day?: number | null; runIds?: number[] }): Promise<{ success: boolean; data?: IndexedFile[]; error?: string }> {
  if (isElectron() && (window as any).pdr?.memories) {
    return (window as any).pdr.memories.dayFiles(args);
  }
  return { success: false, error: 'Not running in Electron' };
}

// ═══════════════════════════════════════════════════════════════
// Trees v1 — family relationship renderer wrappers
// ═══════════════════════════════════════════════════════════════

export type RelationshipType = 'parent_of' | 'spouse_of' | 'sibling_of' | 'associated_with';

export type AssociationKind =
  | 'friend' | 'close_friend' | 'best_friend' | 'acquaintance' | 'neighbour'
  | 'colleague' | 'classmate' | 'teammate' | 'roommate'
  | 'mentor' | 'mentee' | 'manager' | 'client'
  | 'ex_partner'
  | 'other';

export interface RelationshipFlags {
  biological?: boolean;
  step?: boolean;
  adopted?: boolean;
  in_law?: boolean;
  half?: boolean;
  kind?: AssociationKind;
  label?: string;
  ended?: boolean;
  /** On spouse_of edges only: true if the couple are/were specifically
   *  MARRIED (not just unmarried partners). Default semantics for
   *  pre-existing spouse_of records (where this is undefined) is
   *  "ambiguous — could be either"; new code that asks the user
   *  always sets it to a definite true/false. Used by Trees prompts
   *  to use the right noun ("spouse" vs "partner") in copy. */
  married?: boolean;
}

export interface RelationshipRecord {
  id: number;
  person_a_id: number;
  person_b_id: number;
  type: RelationshipType;
  since: string | null;
  until: string | null;
  flags: RelationshipFlags | null;
  confidence: number;
  source: 'user' | 'suggested';
  note: string | null;
  created_at: string;
  updated_at: string;
}

export async function addRelationship(args: {
  personAId: number;
  personBId: number;
  type: RelationshipType;
  since?: string | null;
  until?: string | null;
  flags?: RelationshipFlags | null;
  confidence?: number;
  source?: 'user' | 'suggested';
  note?: string | null;
}): Promise<{ success: boolean; data?: RelationshipRecord; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.addRelationship(args);
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function updateRelationship(id: number, patch: Partial<Omit<RelationshipRecord, 'id' | 'created_at' | 'updated_at' | 'person_a_id' | 'person_b_id' | 'type'>>): Promise<{ success: boolean; data?: RelationshipRecord; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.updateRelationship({ id, patch });
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function removeRelationship(id: number): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.removeRelationship(id);
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function listRelationshipsForPerson(personId: number): Promise<{ success: boolean; data?: RelationshipRecord[]; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.listRelationshipsForPerson(personId);
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function listAllRelationships(): Promise<{ success: boolean; data?: RelationshipRecord[]; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.listAllRelationships();
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function updatePersonLifeEvents(personId: number, patch: { birthDate?: string | null; deathDate?: string | null; deceasedMarker?: string | null }): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.updatePersonLifeEvents({ personId, patch });
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function setPersonCardBackground(personId: number, dataUrl: string | null): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.setPersonCardBackground({ personId, dataUrl });
  }
  return { success: false, error: 'Not running in Electron' };
}

export type PersonGender = 'male' | 'female' | 'non_binary' | 'prefer_not_to_say' | 'unknown' | null;

export async function setPersonGender(personId: number, gender: PersonGender): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.setPersonGender({ personId, gender });
  }
  return { success: false, error: 'Not running in Electron' };
}

// Trees v1 — family graph types (shared with trees-layout.ts).

export interface FamilyGraphNode {
  personId: number;
  /** Short name (the same value as `persons.name`). Always set. */
  name: string;
  /** Optional long-form name (`persons.full_name`). Used by the
   *  Trees card label when present; falls back to `name` when null. */
  fullName: string | null;
  avatarData: string | null;
  representativeFaceId: number | null;
  representativeFaceFilePath: string | null;
  representativeFaceBox: { x: number; y: number; w: number; h: number } | null;
  birthDate: string | null;
  deathDate: string | null;
  deceasedMarker: string | null;
  /** Optional per-card background image (data URL). */
  cardBackground: string | null;
  /** 'male' | 'female' | 'non_binary' | 'prefer_not_to_say' | 'unknown' | null */
  gender: string | null;
  hopsFromFocus: number;
  photoCount: number;
  /** Total parent_of count in the full DB — not limited to the
   *  currently-fetched hop window. */
  totalParentCount: number;
  /** Total parent_of count where this person is the PARENT — used
   *  by Trees to know whether descendants extend beyond the
   *  current Generations setting. */
  totalChildCount: number;
  /** True for placeholder intermediate nodes (ghost rendered in Trees). */
  isPlaceholder: boolean;
}

export interface FamilyGraphEdge {
  id: number | null;
  aId: number;
  bId: number;
  type: 'parent_of' | 'spouse_of' | 'sibling_of' | 'associated_with';
  since: string | null;
  until: string | null;
  flags: RelationshipFlags | null;
  derived: boolean;
}

export interface FamilyGraph {
  focusPersonId: number;
  nodes: FamilyGraphNode[];
  edges: FamilyGraphEdge[];
}

export async function getFamilyGraph(focusPersonId: number, maxHops: number = 3): Promise<{ success: boolean; data?: FamilyGraph; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.getFamilyGraph({ focusPersonId, maxHops });
  }
  return { success: false, error: 'Not running in Electron' };
}

export interface PersonCooccurrenceSuggestion {
  personAId: number;
  personBId: number;
  personAName: string;
  personBName: string;
  sharedPhotoCount: number;
  alreadyRelated: boolean;
}

export async function getPersonCooccurrenceStats(limit: number = 25, minSharedPhotos: number = 20): Promise<{ success: boolean; data?: PersonCooccurrenceSuggestion[]; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.getCooccurrenceStats({ limit, minSharedPhotos });
  }
  return { success: false, error: 'Not running in Electron' };
}

export interface PartnerSuggestionScore {
  id: number;
  name: string;
  score: number;
  shared_photo_count: number;
}

export async function getPartnerSuggestionScores(anchorId: number): Promise<{ success: boolean; data?: PartnerSuggestionScore[]; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.getPartnerSuggestionScores(anchorId);
  }
  return { success: false, error: 'Not running in Electron' };
}

export interface SavedTreeRecord {
  id: number;
  name: string;
  focusPersonId: number | null;
  stepsEnabled: boolean;
  stepsDepth: number;
  generationsEnabled: boolean;
  ancestorsDepth: number;
  descendantsDepth: number;
  backgroundImage: string | null;
  backgroundOpacity: number;
  treeContrast: number;
  hiddenAncestorPersonIds: number[];
  excludedSuggestionPersonIds: number[];
  simplifyHalfLabels: boolean;
  useGenderedLabels: boolean;
  hideGenderMarker: boolean;
  lastOpenedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SavedTreeSettings {
  name: string;
  focusPersonId: number | null;
  stepsEnabled: boolean;
  stepsDepth: number;
  generationsEnabled: boolean;
  ancestorsDepth: number;
  descendantsDepth: number;
}

export async function listSavedTrees(): Promise<{ success: boolean; data?: SavedTreeRecord[]; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.savedList();
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function createSavedTree(args: SavedTreeSettings): Promise<{ success: boolean; data?: SavedTreeRecord; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.savedCreate(args);
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function updateSavedTree(id: number, patch: Partial<SavedTreeSettings & { backgroundImage: string | null; backgroundOpacity: number; treeContrast: number; hiddenAncestorPersonIds: number[]; excludedSuggestionPersonIds: number[]; simplifyHalfLabels: boolean; useGenderedLabels: boolean; hideGenderMarker: boolean; markOpened: boolean }>): Promise<{ success: boolean; data?: SavedTreeRecord; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.savedUpdate({ id, patch });
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function deleteSavedTree(id: number): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.savedDelete(id);
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function toggleHiddenAncestor(treeId: number, personId: number): Promise<{ success: boolean; nowHidden?: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.toggleHiddenAncestor({ treeId, personId });
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function undoGraphOperation(): Promise<{ success: boolean; description?: string; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.undo();
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function redoGraphOperation(): Promise<{ success: boolean; description?: string; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.redo();
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function getGraphHistoryCounts(): Promise<{ success: boolean; data?: { canUndo: number; canRedo: number }; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.historyCounts();
  }
  return { success: false, error: 'Not running in Electron' };
}

export interface GraphHistoryEntry {
  id: number;
  description: string;
  createdAt: string;
  undone: boolean;
}

export async function listGraphHistoryEntries(limit?: number): Promise<{ success: boolean; data?: GraphHistoryEntry[]; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.historyList(limit);
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function revertToGraphHistoryEntry(targetId: number): Promise<{ success: boolean; undoneCount?: number; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.historyRevert(targetId);
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function createPlaceholderPerson(): Promise<{ success: boolean; data?: number; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.createPlaceholderPerson();
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function createNamedPerson(name: string): Promise<{ success: boolean; data?: number; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.createNamedPerson(name);
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function namePlaceholder(personId: number, name: string): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.namePlaceholder({ personId, name });
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function mergePlaceholderIntoPerson(placeholderId: number, targetPersonId: number): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.mergePlaceholder({ placeholderId, targetPersonId });
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function removePlaceholder(placeholderId: number): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.trees) {
    return (window as any).pdr.trees.removePlaceholder(placeholderId);
  }
  return { success: false, error: 'Not running in Electron' };
}

export interface QuickAccessPaths {
  desktop: string | null;
  downloads: string | null;
  documents: string | null;
  pictures: string | null;
  videos: string | null;
  music: string | null;
  home: string | null;
}

export async function getQuickAccessPaths(): Promise<QuickAccessPaths> {
  if (isElectron() && (window as any).pdr?.quickAccessPaths) {
    return (window as any).pdr.quickAccessPaths();
  }
  return { desktop: null, downloads: null, documents: null, pictures: null, videos: null, music: null, home: null };
}

// Open the standalone Date Editor window.
export async function openDateEditor(seedQuery?: SearchQuery): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.dateEditor?.open) {
    return (window as any).pdr.dateEditor.open(seedQuery);
  }
  return { success: false, error: 'Not running in Electron' };
}

// Subscribe to "data changed" notifications from the Date Editor window so
// the main window can refresh its search results when corrections land.
export function onDateEditorDataChanged(callback: () => void): () => void {
  if (isElectron() && (window as any).pdr?.dateEditor?.onDataChanged) {
    return (window as any).pdr.dateEditor.onDataChanged(callback);
  }
  return () => {};
}

/**
 * Open the PDR Viewer.
 *
 * - Single file: pass `filePath` as a string. Arrows are hidden.
 * - Multiple siblings: pass arrays. The viewer's left/right arrows
 *   navigate between them, and the optional `startIndex` controls
 *   which one opens first (e.g. user clicked photo #14 of 175 in a
 *   grid — pass index 13 so they land on the right one with the rest
 *   reachable from arrows).
 */
export async function openSearchViewer(filePath: string | string[], filename: string | string[], startIndex?: number): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.search) {
    const paths = Array.isArray(filePath) ? filePath : [filePath];
    const names = Array.isArray(filename) ? filename : [filename];
    return (window as any).pdr.search.openViewer(paths, names, startIndex);
  }
  return { success: false, error: 'Not running in Electron' };
}

// ─── AI Recognition ────────────────────────────────────────────────────────

export interface AiProgress {
  phase: 'downloading-models' | 'processing' | 'clustering' | 'paused' | 'complete' | 'error';
  current: number;
  total: number;
  currentFile: string;
  facesFound: number;
  tagsApplied: number;
  modelDownloadProgress?: { model: string; percent: number };
  /** True when the current run is tags-only re-tagging. */
  tagsOnly?: boolean;
}

export interface PersonRecord {
  id: number;
  /** Short name. Required. Shown in PM rows + S&D filter chips. */
  name: string;
  /** Optional long-form name. Shown on Trees cards. Falls back to
   *  `name` when null. */
  full_name?: string | null;
  avatar_data: string | null;
  photo_count?: number;
  created_at: string;
  updated_at: string;
}

export interface AiTagRecord {
  id: number;
  file_id: number;
  tag: string;
  confidence: number;
  source: string;
  model_ver: string | null;
}

export interface FaceRecord {
  id: number;
  file_id: number;
  person_id: number | null;
  person_name?: string;
  box_x: number;
  box_y: number;
  box_w: number;
  box_h: number;
  confidence: number;
  cluster_id: number | null;
}

export interface AiStats {
  totalProcessed: number;
  totalFaces: number;
  totalPersons: number;
  totalTags: number;
  unprocessed: number;
}

export async function startAiProcessing(): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.start();
  }
  return { success: false, error: 'Not running in Electron' };
}

export async function cancelAi(): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.cancel();
  }
  return { success: false };
}

export async function pauseAi(): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.pause();
  }
  return { success: false };
}

export async function resumeAi(): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.resume();
  }
  return { success: false };
}

export async function getVisualSuggestions(faceId: number): Promise<{ success: boolean; data?: { personId: number; personName: string; similarity: number }[] }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.visualSuggestions(faceId);
  }
  return { success: false };
}

export async function getClusterFaceCount(clusterId: number, personId?: number): Promise<{ success: boolean; data?: { faceCount: number; photoCount: number } }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.clusterFaceCount(clusterId, personId);
  }
  return { success: false };
}

export async function checkAiModelsReady(): Promise<boolean> {
  if (isElectron() && (window as any).pdr?.ai?.modelsReady) {
    const result = await (window as any).pdr.ai.modelsReady();
    return result?.data === true;
  }
  return false;
}

export async function getAiStatus(): Promise<{ success: boolean; data?: { isProcessing: boolean } }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.status();
  }
  return { success: false };
}

export async function getAiStats(): Promise<{ success: boolean; data?: AiStats }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.stats();
  }
  return { success: false };
}

export async function listPersons(): Promise<{ success: boolean; data?: PersonRecord[] }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.listPersons();
  }
  return { success: false };
}

export async function namePerson(name: string, clusterId?: number, avatarData?: string, fullName?: string | null): Promise<{ success: boolean; data?: { personId: number } }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.namePerson(name, clusterId, avatarData, fullName);
  }
  return { success: false };
}

export async function unnameFace(faceId: number): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.unnameFace(faceId);
  }
  return { success: false };
}

export async function refineFromVerified(similarityThreshold?: number, personFilter?: number): Promise<{
  success: boolean;
  data?: {
    personsProcessed: number;
    newMatches: number;
    perPerson: { personId: number; personName: string; verifiedCount: number; matched: number }[];
  };
  error?: string;
}> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.refineFromVerified(similarityThreshold, personFilter);
  }
  return { success: false };
}

export async function importXmpFaces(): Promise<{
  success: boolean;
  data?: {
    filesScanned: number;
    sidecarsFound: number;
    facesImported: number;
    personsCreated: number;
    filesSkipped: number;
  };
  error?: string;
}> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.importXmpFaces();
  }
  return { success: false };
}

export async function assignFace(faceId: number, personId: number, verified: boolean = false): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.assignFace(faceId, personId, verified);
  }
  return { success: false };
}

export async function batchVerifyPersons(personIds: number[]): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.batchVerify(personIds);
  }
  return { success: false };
}

export interface ClusterFacesResult {
  faces: { face_id: number; file_id: number; file_path: string; box_x: number; box_y: number; box_w: number; box_h: number; confidence: number; verified: number; match_similarity: number | null }[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

export async function getPersonsCooccurrence(selectedPersonIds: number[]): Promise<{ success: boolean; data?: { id: number; name: string; photo_count: number; avatar_data: string | null }[] }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.personsCooccurrence(selectedPersonIds);
  }
  return { success: false };
}

export async function getClusterFaces(
  clusterId: number,
  page: number = 0,
  perPage: number = 40,
  personId?: number,
  sortMode?: 'chronological' | 'confidence-asc',
): Promise<{ success: boolean; data?: ClusterFacesResult }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.clusterFaces(clusterId, page, perPage, personId, sortMode);
  }
  return { success: false };
}

export async function renamePerson(personId: number, newName: string, newFullName?: string | null): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.renamePerson(personId, newName, newFullName);
  }
  return { success: false };
}

export async function setRepresentativeFace(personId: number, faceId: number): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.setRepresentativeFace(personId, faceId);
  }
  return { success: false };
}

export async function mergePersons(targetPersonId: number, sourcePersonId: number): Promise<{ success: boolean; data?: { facesReassigned: number } }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.mergePersons(targetPersonId, sourcePersonId);
  }
  return { success: false };
}

export async function deletePersonRecord(personId: number): Promise<{ success: boolean; data?: { facesUnlinked: number; photosAffected: number; personName: string } }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.deletePerson(personId);
  }
  return { success: false };
}

export async function permanentlyDeletePerson(personId: number): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.permanentlyDeletePerson(personId);
  }
  return { success: false };
}

/**
 * "Send back to Unnamed" — unlinks every face from the person, drops
 * the person record entirely. Faces become Unnamed clusters with
 * verified=0. Used by PM's row-trash flow. Distinct from
 * `deletePersonRecord` which soft-deletes (sets discarded_at, faces
 * stay attached + verified) — that path is still used by the Trees
 * Recycle Bin.
 *
 * Returns an `undoToken` capturing the prior state. Pass it to
 * `restoreUnnamedPerson` to undo the action exactly — recreates
 * the person record, re-links faces with their prior verified
 * flags. Drives the Undo button on the post-action toast.
 */
export interface UnnameUndoToken {
  person: { name: string; full_name: string | null; avatar_data: string | null; representative_face_id: number | null };
  faces: Array<{ faceId: number; wasVerified: number }>;
  treeFocusIds: number[];
}
export async function unnamePersonAndDelete(personId: number): Promise<{ success: boolean; data?: { facesUnnamed: number; photosAffected: number; personName: string; undoToken: UnnameUndoToken | null }; error?: string }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.unnamePersonAndDelete(personId);
  }
  return { success: false };
}
export async function restoreUnnamedPerson(token: UnnameUndoToken): Promise<{ success: boolean; data?: { personId: number; facesRestored: number }; error?: string }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.restoreUnnamedPerson(token);
  }
  return { success: false };
}

export async function restorePerson(personId: number): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.restorePerson(personId);
  }
  return { success: false };
}

export interface DiscardedPerson {
  id: number;
  name: string;
  avatar_data: string | null;
  discarded_at: string;
  created_at: string;
}

export async function listDiscardedPersons(): Promise<{ success: boolean; data?: DiscardedPerson[] }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.listDiscardedPersons();
  }
  return { success: false };
}

export async function getAiFaces(fileId: number): Promise<{ success: boolean; data?: FaceRecord[] }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.getFaces(fileId);
  }
  return { success: false };
}

export async function getAiFileTags(fileId: number): Promise<{ success: boolean; data?: AiTagRecord[] }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.getTags(fileId);
  }
  return { success: false };
}

export async function getAiTagOptions(): Promise<{ success: boolean; data?: { tag: string; count: number }[] }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.tagOptions();
  }
  return { success: false };
}

export async function clearAllAiData(): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.clearAll();
  }
  return { success: false };
}

export async function resetTagAnalysis(): Promise<{ success: boolean; data?: { filesQueued: number }; error?: string }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.resetTagAnalysis();
  }
  return { success: false, error: 'Not running in Electron' };
}

export interface DbBackup {
  path: string;
  filename: string;
  sizeBytes: number;
  mtime: string;
  kind: 'rolling' | 'pre-reanalyze' | 'manual' | 'auto-event';
  label: string | null;
}

/** List every restorable snapshot. Newest first. Returns auto-launch
 *  ('rolling'), auto-event (taken before risky ops), and manual
 *  snapshots. Pre-reanalyze legacy is auto-cleaned on first call. */
export async function listBackups(): Promise<{ success: boolean; data?: DbBackup[]; error?: string }> {
  if (isElectron() && (window as any).pdr?.ai?.listBackups) {
    return (window as any).pdr.ai.listBackups();
  }
  return { success: false, error: 'Not running in Electron' };
}

/** Replace the live DB with the contents of the chosen snapshot. The
 *  caller MUST confirm with the user first — this is irreversible
 *  beyond what other backups are still on disk. */
export async function restoreFromBackup(snapshotPath: string): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.ai?.restoreFromBackup) {
    return (window as any).pdr.ai.restoreFromBackup(snapshotPath);
  }
  return { success: false, error: 'Not running in Electron' };
}

/** Take a snapshot of the live DB right now. `kind: 'manual'` for
 *  user-initiated, `'auto-event'` for code paths that fire one
 *  before a risky op (Improve Recognition, row removal, etc).
 *  Optional label is shown in Settings → Backup so the user knows
 *  what each one was for. Best-effort: failures are non-fatal. */
export async function takeSnapshot(kind: 'manual' | 'auto-event', label?: string): Promise<{ success: boolean; path?: string; error?: string }> {
  if (isElectron() && (window as any).pdr?.ai?.takeSnapshot) {
    return (window as any).pdr.ai.takeSnapshot(kind, label);
  }
  return { success: false, error: 'Not running in Electron' };
}

/** Delete a single snapshot file. Used by the Settings → Backup
 *  housekeeping button on manual snapshots. */
export async function deleteSnapshot(snapshotPath: string): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.ai?.deleteSnapshot) {
    return (window as any).pdr.ai.deleteSnapshot(snapshotPath);
  }
  return { success: false, error: 'Not running in Electron' };
}

/** Save a snapshot file at a user-chosen location (USB drive,
 *  Dropbox folder, etc). Opens a native save dialog. */
export async function exportSnapshotZip(snapshotPath: string): Promise<{ success: boolean; path?: string; error?: string }> {
  if (isElectron() && (window as any).pdr?.ai?.exportSnapshotZip) {
    return (window as any).pdr.ai.exportSnapshotZip(snapshotPath);
  }
  return { success: false, error: 'Not running in Electron' };
}

export interface PersonCluster {
  cluster_id: number;
  person_id: number | null;
  /** Short name (`persons.name`). Shown in PM rows and S&D chips. */
  person_name: string | null;
  /** Optional long-form name (`persons.full_name`). Shown on Trees
   *  cards. Null when the user hasn't provided one — UI falls back
   *  to the short name. */
  person_full_name: string | null;
  face_count: number;
  photo_count: number;
  representative_face_id: number;
  representative_file_id: number;
  representative_file_path: string;
  box_x: number;
  box_y: number;
  box_w: number;
  box_h: number;
  sample_faces: {
    face_id: number;
    file_id: number;
    file_path: string;
    /** Photo derived_date — used to sort the strip chronologically.
     *  NULL when the photo had no extractable date. */
    derived_date: string | null;
    box_x: number;
    box_y: number;
    box_w: number;
    box_h: number;
    confidence: number;
    verified: number;
    /** Cosine similarity score from the auto-match (set by
     *  refineFromVerifiedFaces or backfilled on schema migration).
     *  NULL for verified faces and pre-backfill legacy data. Used
     *  by PM's match-strictness filter. */
    match_similarity: number | null;
  }[];
}

export async function getPersonClusters(): Promise<{ success: boolean; data?: PersonCluster[] }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.personClusters();
  }
  return { success: false };
}

/** Pre-warm the main-process getPersonClusters cache without waiting
 *  for a result. Call this from the main PDR window on idle so when
 *  the user opens People Manager the cluster list returns instantly
 *  from memory instead of cold-querying the DB. */
export async function prewarmPersonClusters(): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.ai?.prewarmPersonClusters) {
    return (window as any).pdr.ai.prewarmPersonClusters();
  }
  return { success: false };
}

/** Records that the user has opened People Manager. Used to decide
 *  when to surface the "open on startup" onboarding banner. Returns
 *  the counts + whether the user has already enabled / dismissed. */
export async function recordPmOpen(): Promise<{
  success: boolean;
  sessionCount?: number;
  distinctDays?: number;
  dismissed?: boolean;
  alreadyEnabled?: boolean;
}> {
  if (isElectron() && (window as any).pdr?.ai?.recordPmOpen) {
    return (window as any).pdr.ai.recordPmOpen();
  }
  return { success: false };
}

/** Permanently dismisses the "open on startup" onboarding banner. */
export async function dismissPmStartupPrompt(): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.ai?.dismissPmStartupPrompt) {
    return (window as any).pdr.ai.dismissPmStartupPrompt();
  }
  return { success: false };
}

export async function getFaceCrop(filePath: string, boxX: number, boxY: number, boxW: number, boxH: number, size: number = 96): Promise<{ success: boolean; dataUrl?: string }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.faceCrop(filePath, boxX, boxY, boxW, boxH, size);
  }
  return { success: false };
}

/**
 * Batch face-crop fetch. One IPC round-trip + one sharp decode per
 * unique file_path, returning a face_id → dataUrl map. Use this in
 * place of N separate getFaceCrop calls when you have many faces to
 * load — the FaceGridModal does this for its 40-face page.
 */
export async function getFaceCropBatch(
  requests: { face_id: number; file_path: string; box_x: number; box_y: number; box_w: number; box_h: number }[],
  size: number = 96,
): Promise<{ success: boolean; crops?: Record<number, string> }> {
  if (isElectron() && (window as any).pdr?.ai?.faceCropBatch) {
    return (window as any).pdr.ai.faceCropBatch(requests, size);
  }
  return { success: false };
}

/**
 * Per-person avatar fetch — resolves persons.representative_face_id
 * (with a highest-confidence fallback when none set) into a face-crop
 * dataUrl. Used by Trees confirmation prompts so the avatar can be
 * shown even for people who aren't in the currently-rendered graph
 * (e.g. the child of a +child quick-add, before its parent_of edge
 * has been written).
 */
export async function getPersonFaceCrop(personId: number, size: number = 96): Promise<{ success: boolean; dataUrl?: string }> {
  if (isElectron() && (window as any).pdr?.ai?.getPersonFaceCrop) {
    return (window as any).pdr.ai.getPersonFaceCrop(personId, size);
  }
  return { success: false };
}

/**
 * Subscribe to viewer-window navigation events. Each time the user
 * advances/rewinds in the photo viewer, the handler is called with
 * the new index + filePath. Returns an unsubscribe function.
 *
 * Use case: PM's FaceGridModal mirrors the viewer's current photo by
 * shifting its selected face to whichever face's file_path matches
 * the viewer's current file.
 */
export function onViewerIndex(handler: (data: { index: number; filePath: string }) => void): () => void {
  if (isElectron() && (window as any).pdr?.search?.onViewerIndex) {
    return (window as any).pdr.search.onViewerIndex(handler);
  }
  return () => {};
}

export async function reclusterFaces(threshold: number): Promise<{ success: boolean; error?: string }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.recluster(threshold);
  }
  return { success: false };
}

export async function getFaceContext(filePath: string, boxX: number, boxY: number, boxW: number, boxH: number, size: number = 240): Promise<{ success: boolean; dataUrl?: string }> {
  if (isElectron() && (window as any).pdr?.ai) {
    return (window as any).pdr.ai.faceContext(filePath, boxX, boxY, boxW, boxH, size);
  }
  return { success: false };
}

/** Fetch the small slice of indexed_files metadata that the People
 *  Manager hover preview needs to overlay (filename + derived date +
 *  geo country + geo city). Lookup keyed by file_path. */
export interface FileMetaSlice {
  filename: string;
  derived_date: string | null;
  geo_country: string | null;
  geo_city: string | null;
}
export async function getFileMetaByPath(filePath: string): Promise<{ success: boolean; data?: FileMetaSlice; error?: string }> {
  if (isElectron() && (window as any).pdr?.search) {
    return (window as any).pdr.search.getFileMetaByPath(filePath);
  }
  return { success: false };
}

/** Subscribe to AI progress events. Returns an unsubscribe function —
 *  call it on component unmount so you don't clobber other subscribers. */
export function onAiProgress(callback: (progress: AiProgress) => void): () => void {
  if (isElectron() && (window as any).pdr?.ai) {
    const unsub = (window as any).pdr.ai.onProgress(callback);
    return typeof unsub === 'function' ? unsub : () => {};
  }
  return () => {};
}

/** @deprecated Use the unsubscribe function returned by onAiProgress.
 *  This wipes every renderer's listener on ai:progress, not just yours. */
export function removeAiProgressListener(): void {
  if (isElectron() && (window as any).pdr?.ai) {
    (window as any).pdr.ai.removeProgressListener();
  }
}

// ─── People Window ──────────────────────────────────────────────────────────

export async function openPeopleWindow(): Promise<void> {
  if (isElectron() && (window as any).pdr?.people) {
    return (window as any).pdr.people.open();
  }
}

export function onPeopleDataChanged(callback: () => void): () => void {
  if (isElectron() && (window as any).pdr?.people?.onDataChanged) {
    return (window as any).pdr.people.onDataChanged(callback);
  }
  return () => {};
}

// ─── Parallel Structure ──────────────────────────────────────────────────────

export interface StructureCopyRequest {
  files: Array<{
    sourcePath: string;
    filename: string;
    derivedDate: string | null;
    sizeBytes: number;
  }>;
  destinationPath: string;
  folderStructure: 'year' | 'year-month' | 'year-month-day';
  mode: 'copy' | 'move';
  skipDuplicates: boolean;
}

export interface StructureCopyResult {
  success: boolean;
  copied: number;
  failed: number;
  skipped: number;
  movedAndDeleted?: number;
  cancelled?: boolean;
  error?: string;
  results?: Array<{
    success: boolean;
    sourcePath: string;
    destPath: string;
    error?: string;
    originalDeleted?: boolean;
  }>;
}

export interface StructureProgress {
  current: number;
  total: number;
  currentFile: string;
  phase: 'copying' | 'verifying' | 'deleting' | 'complete';
}

export async function copyToStructure(data: StructureCopyRequest): Promise<StructureCopyResult> {
  if (isElectron() && (window as any).pdr?.structure) {
    return (window as any).pdr.structure.copyToStructure(data);
  }
  return { success: false, copied: 0, failed: 0, skipped: 0, error: 'Not in Electron' };
}

export async function cancelStructureCopy(): Promise<{ success: boolean }> {
  if (isElectron() && (window as any).pdr?.structure) {
    return (window as any).pdr.structure.cancel();
  }
  return { success: false };
}

export function onStructureProgress(callback: (progress: StructureProgress) => void): () => void {
  if (isElectron() && (window as any).pdr?.structure) {
    (window as any).pdr.structure.onProgress(callback);
    return () => (window as any).pdr.structure.removeProgressListener();
  }
  return () => {};
}

export async function getDiskSpaceBridge(directoryPath: string): Promise<{ success: boolean; data?: { free: number; total: number } }> {
  if (isElectron() && (window as any).pdr?.getDiskSpace) {
    try {
      const result = await (window as any).pdr.getDiskSpace(directoryPath);
      return { success: true, data: result };
    } catch {
      return { success: false };
    }
  }
  return { success: false };
}