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

export interface ElectronAPI {
  openFolder: () => Promise<string | null>;
  openZip: () => Promise<string | null>;
  selectDestination: () => Promise<string | null>;
  getDiskSpace: (directoryPath: string) => Promise<{ freeBytes: number; totalBytes: number }>;
  runAnalysis: (sourcePath: string, sourceType: 'folder' | 'zip' | 'drive') => Promise<{
    success: boolean;
    data?: SourceAnalysisResult;
    error?: string;
  }>;
  onAnalysisProgress: (callback: (progress: AnalysisProgress) => void) => void;
  removeAnalysisProgressListener: () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
