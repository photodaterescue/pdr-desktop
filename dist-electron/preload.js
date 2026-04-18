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
    setFixInProgress: (inProgress) => ipcRenderer.invoke('fix:setInProgress', inProgress),
    saveReport: (reportData) => ipcRenderer.invoke('report:save', reportData),
    loadReport: (reportId) => ipcRenderer.invoke('report:load', reportId),
    loadLatestReport: () => ipcRenderer.invoke('report:loadLatest'),
    listReports: () => ipcRenderer.invoke('report:list'),
    exportReportCSV: (reportId, folderPath) => ipcRenderer.invoke('report:exportCSV', reportId, folderPath),
    exportReportTXT: (reportId, folderPath) => ipcRenderer.invoke('report:exportTXT', reportId, folderPath),
    getDefaultExportPath: (reportId) => ipcRenderer.invoke('report:getDefaultExportPath', reportId),
    regenerateCatalogue: (destinationPath) => ipcRenderer.invoke('report:regenerateCatalogue', destinationPath),
    deleteReport: (reportId) => ipcRenderer.invoke('report:delete', reportId),
    setZoom: (zoom) => ipcRenderer.invoke('set-zoom', zoom),
    setTitleBarColor: (isDark) => ipcRenderer.invoke('set-title-bar-color', isDark),
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
    browser: {
        listDrives: () => ipcRenderer.invoke('browser:listDrives'),
        readDirectory: (dirPath, fileFilter) => ipcRenderer.invoke('browser:readDirectory', dirPath, fileFilter),
        createDirectory: (dirPath) => ipcRenderer.invoke('browser:createDirectory', dirPath),
        thumbnail: (filePath, size) => ipcRenderer.invoke('browser:thumbnail', filePath, size),
    },
    search: {
        init: () => ipcRenderer.invoke('search:init'),
        indexRun: (reportId) => ipcRenderer.invoke('search:indexRun', reportId),
        cancelIndex: () => ipcRenderer.invoke('search:cancelIndex'),
        removeRun: (runId) => ipcRenderer.invoke('search:removeRun', runId),
        removeRunByReport: (reportId) => ipcRenderer.invoke('search:removeRunByReport', reportId),
        listRuns: () => ipcRenderer.invoke('search:listRuns'),
        query: (query) => ipcRenderer.invoke('search:query', query),
        filterOptions: () => ipcRenderer.invoke('search:filterOptions'),
        stats: () => ipcRenderer.invoke('search:stats'),
        rebuildIndex: () => ipcRenderer.invoke('search:rebuildIndex'),
        cleanup: () => ipcRenderer.invoke('search:cleanup'),
        relocateRun: (runId, newPath) => ipcRenderer.invoke('search:relocateRun', runId, newPath),
        onStaleRuns: (callback) => {
            const handler = (_event, runs) => callback(runs);
            ipcRenderer.on('search:staleRuns', handler);
            return () => ipcRenderer.removeListener('search:staleRuns', handler);
        },
        onIndexProgress: (callback) => {
            ipcRenderer.on('search:indexProgress', (_, data) => callback(data));
        },
        removeIndexProgressListener: () => {
            ipcRenderer.removeAllListeners('search:indexProgress');
        },
        favourites: {
            list: () => ipcRenderer.invoke('search:favourites:list'),
            save: (name, query) => ipcRenderer.invoke('search:favourites:save', name, query),
            delete: (id) => ipcRenderer.invoke('search:favourites:delete', id),
            rename: (id, name) => ipcRenderer.invoke('search:favourites:rename', id, name),
        },
        openViewer: (filePaths, fileNames) => ipcRenderer.invoke('search:openViewer', filePaths, fileNames),
        checkPathsExist: (paths) => ipcRenderer.invoke('search:checkPathsExist', paths),
    },
    ai: {
        start: () => ipcRenderer.invoke('ai:start'),
        cancel: () => ipcRenderer.invoke('ai:cancel'),
        pause: () => ipcRenderer.invoke('ai:pause'),
        resume: () => ipcRenderer.invoke('ai:resume'),
        status: () => ipcRenderer.invoke('ai:status'),
        stats: () => ipcRenderer.invoke('ai:stats'),
        listPersons: () => ipcRenderer.invoke('ai:listPersons'),
        namePerson: (name, clusterId, avatarData) => ipcRenderer.invoke('ai:namePerson', name, clusterId, avatarData),
        assignFace: (faceId, personId, verified) => ipcRenderer.invoke('ai:assignFace', faceId, personId, verified ?? false),
        batchVerify: (personIds) => ipcRenderer.invoke('ai:batchVerify', personIds),
        unnameFace: (faceId) => ipcRenderer.invoke('ai:unnameFace', faceId),
        refineFromVerified: (similarityThreshold) => ipcRenderer.invoke('ai:refineFromVerified', similarityThreshold),
        importXmpFaces: () => ipcRenderer.invoke('ai:importXmpFaces'),
        renamePerson: (personId, newName) => ipcRenderer.invoke('ai:renamePerson', personId, newName),
        setRepresentativeFace: (personId, faceId) => ipcRenderer.invoke('ai:setRepresentativeFace', personId, faceId),
        mergePersons: (targetPersonId, sourcePersonId) => ipcRenderer.invoke('ai:mergePersons', targetPersonId, sourcePersonId),
        deletePerson: (personId) => ipcRenderer.invoke('ai:deletePerson', personId),
        permanentlyDeletePerson: (personId) => ipcRenderer.invoke('ai:permanentlyDeletePerson', personId),
        restorePerson: (personId) => ipcRenderer.invoke('ai:restorePerson', personId),
        listDiscardedPersons: () => ipcRenderer.invoke('ai:listDiscardedPersons'),
        getPersonInfo: (personId) => ipcRenderer.invoke('ai:getPersonInfo', personId),
        visualSuggestions: (faceId) => ipcRenderer.invoke('ai:visualSuggestions', faceId),
        clusterFaceCount: (clusterId, personId) => ipcRenderer.invoke('ai:clusterFaceCount', clusterId, personId),
        getFaces: (fileId) => ipcRenderer.invoke('ai:getFaces', fileId),
        getTags: (fileId) => ipcRenderer.invoke('ai:getTags', fileId),
        tagOptions: () => ipcRenderer.invoke('ai:tagOptions'),
        clearAll: () => ipcRenderer.invoke('ai:clearAll'),
        personClusters: () => ipcRenderer.invoke('ai:personClusters'),
        personsCooccurrence: (selectedPersonIds) => ipcRenderer.invoke('ai:personsCooccurrence', selectedPersonIds),
        clusterFaces: (clusterId, page, perPage, personId) => ipcRenderer.invoke('ai:clusterFaces', clusterId, page, perPage, personId),
        recluster: (threshold) => ipcRenderer.invoke('ai:recluster', threshold),
        faceCrop: (filePath, boxX, boxY, boxW, boxH, size) => ipcRenderer.invoke('ai:faceCrop', filePath, boxX, boxY, boxW, boxH, size),
        faceContext: (filePath, boxX, boxY, boxW, boxH, size) => ipcRenderer.invoke('ai:faceContext', filePath, boxX, boxY, boxW, boxH, size),
        modelsReady: () => ipcRenderer.invoke('ai:modelsReady'),
        onProgress: (callback) => {
            ipcRenderer.on('ai:progress', (_, data) => callback(data));
        },
        removeProgressListener: () => {
            ipcRenderer.removeAllListeners('ai:progress');
        },
        onLog: (callback) => {
            ipcRenderer.on('ai:log', (_, msg) => callback(msg));
        },
        replayLogs: () => ipcRenderer.invoke('ai:replayLogs'),
    },
    openSettings: (tab) => ipcRenderer.invoke('app:openSettings', tab),
    onOpenSettings: (callback) => {
        ipcRenderer.on('app:openSettings', callback);
        return () => ipcRenderer.removeListener('app:openSettings', callback);
    },
    people: {
        open: () => ipcRenderer.invoke('people:open'),
        notifyChange: () => ipcRenderer.invoke('people:changed'),
        onThemeChange: (callback) => {
            const handler = (_event, isDark) => callback(isDark);
            ipcRenderer.on('people:themeChange', handler);
            return () => ipcRenderer.removeListener('people:themeChange', handler);
        },
        onDataChanged: (callback) => {
            const handler = () => callback();
            ipcRenderer.on('people:dataChanged', handler);
            return () => ipcRenderer.removeListener('people:dataChanged', handler);
        },
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
    structure: {
        copyToStructure: (data) => ipcRenderer.invoke('structure:copy', data),
        cancel: () => ipcRenderer.invoke('structure:copy:cancel'),
        onProgress: (callback) => {
            ipcRenderer.on('structure:copy:progress', (_, data) => callback(data));
        },
        removeProgressListener: () => {
            ipcRenderer.removeAllListeners('structure:copy:progress');
        },
    },
});
