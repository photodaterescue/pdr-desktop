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

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openZip: () => ipcRenderer.invoke('dialog:openZip'),
  selectDestination: () => ipcRenderer.invoke('dialog:selectDestination'),
  runAnalysis: (sourcePath: string, sourceType: 'folder' | 'zip' | 'drive') => 
    ipcRenderer.invoke('analysis:run', sourcePath, sourceType),
  onAnalysisProgress: (callback: (progress: AnalysisProgress) => void) => {
    ipcRenderer.on('analysis:progress', (_event, progress) => callback(progress));
  },
  removeAnalysisProgressListener: () => {
    ipcRenderer.removeAllListeners('analysis:progress');
  },
});
