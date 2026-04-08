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
setFixInProgress: (inProgress: boolean) => ipcRenderer.invoke('fix:setInProgress', inProgress),

  saveReport: (reportData: any) =>
    ipcRenderer.invoke('report:save', reportData),

  loadReport: (reportId: string) =>
    ipcRenderer.invoke('report:load', reportId),

  loadLatestReport: () =>
    ipcRenderer.invoke('report:loadLatest'),

  listReports: () =>
    ipcRenderer.invoke('report:list'),

  exportReportCSV: (reportId: string, folderPath?: string) =>
    ipcRenderer.invoke('report:exportCSV', reportId, folderPath),
  exportReportTXT: (reportId: string, folderPath?: string) =>
    ipcRenderer.invoke('report:exportTXT', reportId, folderPath),
  getDefaultExportPath: (reportId: string) =>
    ipcRenderer.invoke('report:getDefaultExportPath', reportId),
  regenerateCatalogue: (destinationPath: string) =>
    ipcRenderer.invoke('report:regenerateCatalogue', destinationPath),
  deleteReport: (reportId: string) => ipcRenderer.invoke('report:delete', reportId),
  
  setZoom: (zoom: number) => ipcRenderer.invoke('set-zoom', zoom),
  setTitleBarColor: (isDark: boolean) => ipcRenderer.invoke('set-title-bar-color', isDark),
  
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
  
  browser: {
    listDrives: () => ipcRenderer.invoke('browser:listDrives'),
    readDirectory: (dirPath: string, fileFilter?: string) => ipcRenderer.invoke('browser:readDirectory', dirPath, fileFilter),
    createDirectory: (dirPath: string) => ipcRenderer.invoke('browser:createDirectory', dirPath),
    thumbnail: (filePath: string, size: number) => ipcRenderer.invoke('browser:thumbnail', filePath, size),
  },

  search: {
    init: () => ipcRenderer.invoke('search:init'),
    indexRun: (reportId: string) => ipcRenderer.invoke('search:indexRun', reportId),
    cancelIndex: () => ipcRenderer.invoke('search:cancelIndex'),
    removeRun: (runId: number) => ipcRenderer.invoke('search:removeRun', runId),
    removeRunByReport: (reportId: string) => ipcRenderer.invoke('search:removeRunByReport', reportId),
    listRuns: () => ipcRenderer.invoke('search:listRuns'),
    query: (query: any) => ipcRenderer.invoke('search:query', query),
    filterOptions: () => ipcRenderer.invoke('search:filterOptions'),
    stats: () => ipcRenderer.invoke('search:stats'),
    rebuildIndex: () => ipcRenderer.invoke('search:rebuildIndex'),
    onIndexProgress: (callback: (progress: any) => void) => {
      ipcRenderer.on('search:indexProgress', (_: any, data: any) => callback(data));
    },
    removeIndexProgressListener: () => {
      ipcRenderer.removeAllListeners('search:indexProgress');
    },
    favourites: {
      list: () => ipcRenderer.invoke('search:favourites:list'),
      save: (name: string, query: any) => ipcRenderer.invoke('search:favourites:save', name, query),
      delete: (id: number) => ipcRenderer.invoke('search:favourites:delete', id),
      rename: (id: number, name: string) => ipcRenderer.invoke('search:favourites:rename', id, name),
    },
    openViewer: (filePaths: string[], fileNames: string[]) => ipcRenderer.invoke('search:openViewer', filePaths, fileNames),
    checkPathsExist: (paths: string[]) => ipcRenderer.invoke('search:checkPathsExist', paths),
  },

  ai: {
    start: () => ipcRenderer.invoke('ai:start'),
    cancel: () => ipcRenderer.invoke('ai:cancel'),
    status: () => ipcRenderer.invoke('ai:status'),
    stats: () => ipcRenderer.invoke('ai:stats'),
    listPersons: () => ipcRenderer.invoke('ai:listPersons'),
    namePerson: (name: string, clusterId?: number, avatarData?: string) => ipcRenderer.invoke('ai:namePerson', name, clusterId, avatarData),
    assignFace: (faceId: number, personId: number) => ipcRenderer.invoke('ai:assignFace', faceId, personId),
    getFaces: (fileId: number) => ipcRenderer.invoke('ai:getFaces', fileId),
    getTags: (fileId: number) => ipcRenderer.invoke('ai:getTags', fileId),
    tagOptions: () => ipcRenderer.invoke('ai:tagOptions'),
    clearAll: () => ipcRenderer.invoke('ai:clearAll'),
    onProgress: (callback: (progress: any) => void) => {
      ipcRenderer.on('ai:progress', (_: any, data: any) => callback(data));
    },
    removeProgressListener: () => {
      ipcRenderer.removeAllListeners('ai:progress');
    },
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