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
  counts: {
    confirmed: number;
    recovered: number;
    marked: number;
  };
}

export interface ElectronAPI {
  openFolder: () => Promise<string | null>;
  openZip: () => Promise<string | null>;
  selectDestination: () => Promise<string | null>;
  getDiskSpace: (directoryPath: string) => Promise<{ freeBytes: number; totalBytes: number }>;
  openDestinationFolder: (folderPath: string) => Promise<void>;
  runAnalysis: (sourcePath: string, sourceType: 'folder' | 'zip' | 'drive') => Promise<{
    success: boolean;
    data?: SourceAnalysisResult;
    error?: string;
  }>;
  onAnalysisProgress: (callback: (progress: AnalysisProgress) => void) => void;
  removeAnalysisProgressListener: () => void;
  saveReport: (reportData: Omit<FixReport, 'id' | 'timestamp'>) => Promise<{
    success: boolean;
    data?: FixReport;
    error?: string;
  }>;
  loadReport: (reportId: string) => Promise<{
    success: boolean;
    data?: FixReport | null;
    error?: string;
  }>;
  loadLatestReport: () => Promise<{
    success: boolean;
    data?: FixReport | null;
    error?: string;
  }>;
  listReports: () => Promise<{
    success: boolean;
    data?: ReportSummary[];
    error?: string;
  }>;
  exportReportCSV: (reportId: string) => Promise<{
    success: boolean;
    filePath?: string;
    error?: string;
  }>;
  exportReportTXT: (reportId: string) => Promise<{
    success: boolean;
    filePath?: string;
    error?: string;
  }>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
