"use strict";
/* eslint-disable @typescript-eslint/no-var-requires */
// IMPORTANT:
// Preload MUST be CommonJS when run by Electron
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pdr', {
    runAnalysis: (sourcePath, sourceType) => ipcRenderer.invoke('analysis:run', sourcePath, sourceType),
    cancelAnalysis: () => ipcRenderer.invoke('analysis:cancel'),
    onAnalysisProgress: (callback) => {
        ipcRenderer.on('analysis:progress', (_, data) => callback(data));
    },
    removeAnalysisProgressListener: () => {
        ipcRenderer.removeAllListeners('analysis:progress');
    },
    copyFiles: (data) => ipcRenderer.invoke('files:copy', data),
    onCopyProgress: (callback) => {
        ipcRenderer.on('files:copy:progress', (_event, progress) => callback(progress));
    },
    cancelCopyFiles: () => ipcRenderer.invoke('files:copy:cancel'),
    saveReport: (reportData) => ipcRenderer.invoke('report:save', reportData),
    loadReport: (reportId) => ipcRenderer.invoke('report:load', reportId),
    loadLatestReport: () => ipcRenderer.invoke('report:loadLatest'),
    listReports: () => ipcRenderer.invoke('report:list'),
    exportReportCSV: (reportId) => ipcRenderer.invoke('report:exportCSV', reportId),
    exportReportTXT: (reportId) => ipcRenderer.invoke('report:exportTXT', reportId),
    deleteReport: (reportId) => ipcRenderer.invoke('report:delete', reportId),
    setZoom: (zoom) => ipcRenderer.invoke('set-zoom', zoom),
    pickSource: (mode) => ipcRenderer.invoke('source:pick', mode),
    openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
    openZip: () => ipcRenderer.invoke('dialog:openZip'),
    selectDestination: () => ipcRenderer.invoke('select-destination'),
    prescanDestination: (destinationPath) => ipcRenderer.invoke('destination:prescan', destinationPath),
    onDestinationPrescanProgress: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('destination:prescan:progress', handler);
        return () => ipcRenderer.removeListener('destination:prescan:progress', handler);
    },
    getDiskSpace: (directoryPath) => ipcRenderer.invoke('disk:getSpace', directoryPath),
    showMessage: (title, message) => ipcRenderer.invoke('show-message', title, message),
    openDestinationFolder: (folderPath) => ipcRenderer.invoke('shell:openFolder', folderPath),
    playCompletionSound: () => ipcRenderer.invoke('play-completion-sound'),
    flashTaskbar: () => ipcRenderer.invoke('window:flashFrame'),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    settings: {
        get: () => ipcRenderer.invoke('settings:get'),
        set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
        setAll: (settings) => ipcRenderer.invoke('settings:setAll', settings),
        resetToDefaults: () => ipcRenderer.invoke('settings:resetToDefaults'),
    },
    license: {
        getStatus: () => ipcRenderer.invoke('license:getStatus'),
        activate: (key) => ipcRenderer.invoke('license:activate', key),
        refresh: (key) => ipcRenderer.invoke('license:refresh', key),
        deactivate: (key) => ipcRenderer.invoke('license:deactivate', key),
        getMachineId: () => ipcRenderer.invoke('license:getMachineId'),
    },
    updates: {
        check: () => ipcRenderer.invoke('updates:check'),
        getVersion: () => ipcRenderer.invoke('updates:getVersion'),
    },
    storage: {
        classify: (sourcePath) => ipcRenderer.invoke('storage:classify', sourcePath),
        checkSameDrive: (sourcePath, outputPath) => ipcRenderer.invoke('storage:checkSameDrive', sourcePath, outputPath),
    },
    prescan: {
        run: (sourcePath, sourceType, noTimeout = false) => ipcRenderer.invoke('prescan:run', sourcePath, sourceType, noTimeout),
        cancel: () => ipcRenderer.invoke('prescan:cancel'),
        onProgress: (callback) => {
            ipcRenderer.on('prescan:progress', (_, data) => callback(data));
        },
        removeProgressListener: () => {
            ipcRenderer.removeAllListeners('prescan:progress');
        },
    },
});
