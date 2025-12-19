import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('electronAPI', {
    openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
    openZip: () => ipcRenderer.invoke('dialog:openZip'),
    selectDestination: () => ipcRenderer.invoke('dialog:selectDestination'),
    runAnalysis: (sourcePath, sourceType) => ipcRenderer.invoke('analysis:run', sourcePath, sourceType),
    onAnalysisProgress: (callback) => {
        ipcRenderer.on('analysis:progress', (_event, progress) => callback(progress));
    },
    removeAnalysisProgressListener: () => {
        ipcRenderer.removeAllListeners('analysis:progress');
    },
});
