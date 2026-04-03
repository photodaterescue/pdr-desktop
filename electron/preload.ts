/* eslint-disable @typescript-eslint/no-var-requires */

// IMPORTANT:
// Preload MUST be CommonJS when run by Electron
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pdr', {
  runAnalysis: (sourcePath: string, sourceType: 'folder' | 'zip' | 'drive') =>
  ipcRenderer.invoke('analysis:run', sourcePath, sourceType),

  cancelAnalysis: () => ipcRenderer.invoke('analysis:cancel'),

  onAnalysisProgress: (callback: (progress: any) => void) => {
  ipcRenderer.on('analysis:progress', (_: any, data: any) => callback(data));
},

removeAnalysisProgressListener: () => {
  ipcRenderer.removeAllListeners('analysis:progress');
},

copyFiles: (data: { files: Array<{ sourcePath: string; newFilename: string; sourceType: 'folder' | 'zip' }>; destinationPath: string; zipPaths?: Record<string, string> }) => ipcRenderer.invoke('files:copy', data),
onCopyProgress: (callback: (progress: { current: number; total: number }) => void) => {
  ipcRenderer.on('files:copy:progress', (_event: any, progress: any) => callback(progress));
},
cancelCopyFiles: () => ipcRenderer.invoke('files:copy:cancel'),

  saveReport: (reportData: any) =>
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
  deleteReport: (reportId: string) => ipcRenderer.invoke('report:delete', reportId),
  
  setZoom: (zoom: number) => ipcRenderer.invoke('set-zoom', zoom),
  
  pickSource: (mode: 'folder' | 'zip') => ipcRenderer.invoke('source:pick', mode),
  
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
openZip: () => ipcRenderer.invoke('dialog:openZip'),

selectDestination: () => ipcRenderer.invoke('select-destination'),

    prescanDestination: (destinationPath: string) => 
      ipcRenderer.invoke('destination:prescan', destinationPath),
    
    onDestinationPrescanProgress: (callback: (data: { scanned: number }) => void) => {
      const handler = (_event: any, data: { scanned: number }) => callback(data);
      ipcRenderer.on('destination:prescan:progress', handler);
      return () => ipcRenderer.removeListener('destination:prescan:progress', handler);
    },

getDiskSpace: (directoryPath: string) => ipcRenderer.invoke('disk:getSpace', directoryPath),

showMessage: (title: string, message: string) => ipcRenderer.invoke('show-message', title, message),

openDestinationFolder: (folderPath: string) => ipcRenderer.invoke('shell:openFolder', folderPath),

playCompletionSound: () => ipcRenderer.invoke('play-completion-sound'),

flashTaskbar: () => ipcRenderer.invoke('window:flashFrame'),

openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (key: string, value: any) => ipcRenderer.invoke('settings:set', key, value),
    setAll: (settings: any) => ipcRenderer.invoke('settings:setAll', settings),
    resetToDefaults: () => ipcRenderer.invoke('settings:resetToDefaults'),
  },
  
    license: {
    getStatus: () => ipcRenderer.invoke('license:getStatus'),
    activate: (key: string) => ipcRenderer.invoke('license:activate', key),
    refresh: (key: string) => ipcRenderer.invoke('license:refresh', key),
    deactivate: (key: string) => ipcRenderer.invoke('license:deactivate', key),
    getMachineId: () => ipcRenderer.invoke('license:getMachineId'),
  },
  
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
    getVersion: () => ipcRenderer.invoke('updates:getVersion'),
  },
  
  storage: {
    classify: (sourcePath: string) => ipcRenderer.invoke('storage:classify', sourcePath),
    checkSameDrive: (sourcePath: string, outputPath: string) => ipcRenderer.invoke('storage:checkSameDrive', sourcePath, outputPath),
  },
  
  prescan: {
    run: (sourcePath: string, sourceType: 'folder' | 'zip', noTimeout: boolean = false) => ipcRenderer.invoke('prescan:run', sourcePath, sourceType, noTimeout),
    cancel: () => ipcRenderer.invoke('prescan:cancel'),
    onProgress: (callback: (progress: any) => void) => {
      ipcRenderer.on('prescan:progress', (_: any, data: any) => callback(data));
    },
    removeProgressListener: () => {
      ipcRenderer.removeAllListeners('prescan:progress');
    },
  },
});