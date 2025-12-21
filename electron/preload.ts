import { contextBridge, ipcRenderer } from 'electron';

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
  sourcePath?: string;
  fileType?: string;
  dateChanged?: boolean;
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

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openZip: () => ipcRenderer.invoke('dialog:openZip'),
  selectDestination: () => ipcRenderer.invoke('dialog:selectDestination'),
  getDiskSpace: (directoryPath: string) => ipcRenderer.invoke('disk:getSpace', directoryPath),
  openDestinationFolder: (folderPath: string) => ipcRenderer.invoke('shell:openFolder', folderPath),
  runAnalysis: (sourcePath: string, sourceType: 'folder' | 'zip' | 'drive') => 
    ipcRenderer.invoke('analysis:run', sourcePath, sourceType),
  onAnalysisProgress: (callback: (progress: AnalysisProgress) => void) => {
    ipcRenderer.on('analysis:progress', (_event, progress) => callback(progress));
  },
  removeAnalysisProgressListener: () => {
    ipcRenderer.removeAllListeners('analysis:progress');
  },
  saveReport: (reportData: Omit<FixReport, 'id' | 'timestamp'>) => 
    ipcRenderer.invoke('report:save', reportData),
  loadReport: (reportId: string) => 
    ipcRenderer.invoke('report:load', reportId),
  loadLatestReport: () => 
    ipcRenderer.invoke('report:loadLatest'),
  listReports: () => 
    ipcRenderer.invoke('report:list'),
  exportReportCSV: (reportId: string) => 
    ipcRenderer.invoke('report:exportCSV', reportId),
  exportReportTXT: (reportId: string) => 
    ipcRenderer.invoke('report:exportTXT', reportId),
});
