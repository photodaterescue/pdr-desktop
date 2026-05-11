"use strict";
/* eslint-disable @typescript-eslint/no-var-requires */
// IMPORTANT:
// Preload MUST be CommonJS when run by Electron
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pdr', {
    runAnalysis: (sourcePath, sourceType, tempDirOverride) => ipcRenderer.invoke('analysis:run', sourcePath, sourceType, tempDirOverride),
    getFileSize: (filePath) => ipcRenderer.invoke('file:getSize', filePath),
    fingerprintFolder: (dirPath) => ipcRenderer.invoke('folder:fingerprint', dirPath),
    cancelAnalysis: () => ipcRenderer.invoke('analysis:cancel'),
    // Best-effort cleanup of any extracted temp dir associated with a
    // source the user is removing from the source menu. Returns
    // { success, cleaned } where cleaned is the number of temp
    // directories actually deleted.
    cleanupTempDirForSource: (sourcePath) => ipcRenderer.invoke('analysis:cleanupTempDirForSource', sourcePath),
    onAnalysisProgress: (callback) => {
        ipcRenderer.on('analysis:progress', (_, data) => callback(data));
    },
    removeAnalysisProgressListener: () => {
        ipcRenderer.removeAllListeners('analysis:progress');
    },
    // Diagnostic stream — release-testing telemetry from the analysis
    // pipeline (phase markers, periodic memory snapshots, per-large-file
    // timings, skip-and-continue warnings, final summary). Renderer
    // just console.logs these so they land in F12 alongside any other
    // front-end logging during a 50 GB Takeout test run.
    onAnalysisDiagnostic: (callback) => {
        ipcRenderer.on('analysis:diagnostic', (_, msg) => callback(msg));
    },
    removeAnalysisDiagnosticListener: () => {
        ipcRenderer.removeAllListeners('analysis:diagnostic');
    },
    copyFiles: (data) => ipcRenderer.invoke('files:copy', data),
    onCopyProgress: (callback) => {
        ipcRenderer.on('files:copy:progress', (_event, progress) => callback(progress));
    },
    // Phase events from the network-staging path: 'staging' fires when
    // PDR detects a network destination and starts writing locally; 'mirror'
    // fires when robocopy starts pushing the local staging tree to the
    // network. Lets the renderer swap the progress label so the user
    // understands why the bar may sit at 100% briefly while the
    // network upload finishes.
    onCopyPhase: (callback) => {
        ipcRenderer.on('files:copy:phase', (_event, p) => callback(p));
    },
    onCopyMirrorProgress: (callback) => {
        ipcRenderer.on('files:copy:mirror-progress', (_event, p) => callback(p));
    },
    cancelCopyFiles: () => ipcRenderer.invoke('files:copy:cancel'),
    setFixInProgress: (inProgress) => ipcRenderer.invoke('fix:setInProgress', inProgress),
    // Cold-start query for windows that open mid-fix (e.g. PM
    // launched while a fix is running) — lets them gate their
    // mutating actions immediately rather than waiting for the
    // next state-change broadcast.
    getFixInProgress: () => ipcRenderer.invoke('fix:getInProgress'),
    // Cross-window subscription to fix-state changes. Fires from
    // the main process whenever setFixInProgress is called by any
    // window. Returns an unsubscribe fn.
    onFixStateChanged: (callback) => {
        const handler = (_event, state) => callback(state);
        ipcRenderer.on('fix:stateChanged', handler);
        return () => ipcRenderer.removeListener('fix:stateChanged', handler);
    },
    // Cross-window progress broadcast. Lets PM (separate window)
    // render a real chip with phase/processed/total instead of just
    // "Fix in progress". Sent by whichever window owns the active
    // fix (currently always the main window).
    broadcastFixProgress: (payload) => ipcRenderer.invoke('fix:broadcastProgress', payload),
    getFixProgress: () => ipcRenderer.invoke('fix:getProgress'),
    onFixProgress: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on('fix:progressBroadcast', handler);
        return () => ipcRenderer.removeListener('fix:progressBroadcast', handler);
    },
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
    // Free Trial file counter — read / increment the Cloudflare
    // KV-backed tally. Renderer reads it for the workspace banner and
    // pre-fix gate; main.ts auto-increments after each successful Fix
    // (wired into files:copy in the next phase).
    usage: {
        get: (licenseKey) => ipcRenderer.invoke('usage:get', licenseKey),
        increment: (licenseKey, count) => ipcRenderer.invoke('usage:increment', licenseKey, count),
    },
    updates: {
        check: () => ipcRenderer.invoke('updates:check'),
        getVersion: () => ipcRenderer.invoke('updates:getVersion'),
        // Auto-update lifecycle: trigger the download once the user
        // accepts the "Update available" toast, then trigger the install
        // (quitAndInstall) once the file is on disk.
        download: () => ipcRenderer.invoke('updates:download'),
        install: () => ipcRenderer.invoke('updates:install'),
        getState: () => ipcRenderer.invoke('updates:getState'),
        // Push-channel subscription: main process emits state-machine
        // transitions on this channel as electron-updater fires events.
        // Renderer keeps a single source of truth in component state and
        // re-renders when this fires.
        onState: (callback) => {
            const handler = (_event, state) => callback(state);
            ipcRenderer.on('updates:state', handler);
            return () => ipcRenderer.removeListener('updates:state', handler);
        },
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
    video: {
        prepare: (filePath) => ipcRenderer.invoke('video:prepare', filePath),
    },
    date: {
        getSuggestions: (fileId) => ipcRenderer.invoke('date:getSuggestions', fileId),
        apply: (opts) => ipcRenderer.invoke('date:apply', opts),
        undo: () => ipcRenderer.invoke('date:undo'),
        auditLog: (limit) => ipcRenderer.invoke('date:auditLog', limit),
    },
    scannerOverride: {
        list: () => ipcRenderer.invoke('scannerOverride:list'),
        set: (args) => ipcRenderer.invoke('scannerOverride:set', args),
        clear: (args) => ipcRenderer.invoke('scannerOverride:clear', args),
    },
    memories: {
        yearMonthBuckets: (runIds) => ipcRenderer.invoke('memories:yearMonthBuckets', runIds),
        onThisDay: (args) => ipcRenderer.invoke('memories:onThisDay', args),
        dayFiles: (args) => ipcRenderer.invoke('memories:dayFiles', args),
    },
    trees: {
        addRelationship: (args) => ipcRenderer.invoke('trees:addRelationship', args),
        updateRelationship: (args) => ipcRenderer.invoke('trees:updateRelationship', args),
        removeRelationship: (id) => ipcRenderer.invoke('trees:removeRelationship', id),
        listRelationshipsForPerson: (personId) => ipcRenderer.invoke('trees:listRelationshipsForPerson', personId),
        listAllRelationships: () => ipcRenderer.invoke('trees:listAllRelationships'),
        updatePersonLifeEvents: (args) => ipcRenderer.invoke('trees:updatePersonLifeEvents', args),
        setPersonCardBackground: (args) => ipcRenderer.invoke('trees:setPersonCardBackground', args),
        setPersonGender: (args) => ipcRenderer.invoke('trees:setPersonGender', args),
        getFamilyGraph: (args) => ipcRenderer.invoke('trees:getFamilyGraph', args),
        getCooccurrenceStats: (args) => ipcRenderer.invoke('trees:getCooccurrenceStats', args),
        getPartnerSuggestionScores: (anchorId) => ipcRenderer.invoke('trees:getPartnerSuggestionScores', anchorId),
        savedList: () => ipcRenderer.invoke('trees:savedList'),
        savedGet: (id) => ipcRenderer.invoke('trees:savedGet', id),
        savedCreate: (args) => ipcRenderer.invoke('trees:savedCreate', args),
        savedUpdate: (args) => ipcRenderer.invoke('trees:savedUpdate', args),
        savedDelete: (id) => ipcRenderer.invoke('trees:savedDelete', id),
        toggleHiddenAncestor: (args) => ipcRenderer.invoke('trees:toggleHiddenAncestor', args),
        undo: () => ipcRenderer.invoke('trees:undo'),
        redo: () => ipcRenderer.invoke('trees:redo'),
        historyCounts: () => ipcRenderer.invoke('trees:historyCounts'),
        historyList: (limit) => ipcRenderer.invoke('trees:historyList', limit),
        historyRevert: (targetId) => ipcRenderer.invoke('trees:historyRevert', targetId),
        createPlaceholderPerson: () => ipcRenderer.invoke('trees:createPlaceholderPerson'),
        createNamedPerson: (name) => ipcRenderer.invoke('trees:createNamedPerson', name),
        namePlaceholder: (args) => ipcRenderer.invoke('trees:namePlaceholder', args),
        mergePlaceholder: (args) => ipcRenderer.invoke('trees:mergePlaceholder', args),
        removePlaceholder: (id) => ipcRenderer.invoke('trees:removePlaceholder', id),
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
        rebuildFromLibraries: (rootPaths) => ipcRenderer.invoke('search:rebuildFromLibraries', rootPaths),
        onRebuildProgress: (callback) => {
            const handler = (_, data) => callback(data);
            ipcRenderer.on('search:rebuildProgress', handler);
            return () => ipcRenderer.removeListener('search:rebuildProgress', handler);
        },
        cleanup: () => ipcRenderer.invoke('search:cleanup'),
        relocateRun: (runId, newPath) => ipcRenderer.invoke('search:relocateRun', runId, newPath),
        getFileMetaByPath: (filePath) => ipcRenderer.invoke('search:getFileMetaByPath', filePath),
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
        openViewer: (filePaths, fileNames, startIndex) => ipcRenderer.invoke('search:openViewer', filePaths, fileNames, startIndex),
        checkPathsExist: (paths) => ipcRenderer.invoke('search:checkPathsExist', paths),
        /** Sent by the viewer window each time the user navigates to a
         *  different photo. Other renderers (PM's FaceGridModal) can
         *  subscribe via onViewerIndex to mirror the selection. */
        notifyViewerIndex: (index, filePath) => ipcRenderer.send('search:viewerIndexChange', index, filePath),
        onViewerIndex: (handler) => {
            const listener = (_e, data) => handler(data);
            ipcRenderer.on('search:viewerIndex', listener);
            return () => ipcRenderer.removeListener('search:viewerIndex', listener);
        },
    },
    /** Viewer rotation — read/write the user-applied rotation for a
     *  given file_path. Used by the PDR Viewer to make rotation
     *  sticky across sessions; never touches the original file. */
    viewer: {
        getRotation: (filePath) => ipcRenderer.invoke('viewer:getRotation', filePath),
        setRotation: (filePath, rotation) => ipcRenderer.invoke('viewer:setRotation', filePath, rotation),
    },
    ai: {
        start: () => ipcRenderer.invoke('ai:start'),
        cancel: () => ipcRenderer.invoke('ai:cancel'),
        pause: () => ipcRenderer.invoke('ai:pause'),
        resume: () => ipcRenderer.invoke('ai:resume'),
        status: () => ipcRenderer.invoke('ai:status'),
        stats: () => ipcRenderer.invoke('ai:stats'),
        listPersons: () => ipcRenderer.invoke('ai:listPersons'),
        namePerson: (name, clusterId, avatarData, fullName) => ipcRenderer.invoke('ai:namePerson', name, clusterId, avatarData, fullName),
        assignFace: (faceId, personId, verified) => ipcRenderer.invoke('ai:assignFace', faceId, personId, verified ?? false),
        batchVerify: (personIds) => ipcRenderer.invoke('ai:batchVerify', personIds),
        unnameFace: (faceId) => ipcRenderer.invoke('ai:unnameFace', faceId),
        refineFromVerified: (similarityThreshold, personFilter) => ipcRenderer.invoke('ai:refineFromVerified', similarityThreshold, personFilter),
        importXmpFaces: () => ipcRenderer.invoke('ai:importXmpFaces'),
        renamePerson: (personId, newName, newFullName) => ipcRenderer.invoke('ai:renamePerson', personId, newName, newFullName),
        setRepresentativeFace: (personId, faceId) => ipcRenderer.invoke('ai:setRepresentativeFace', personId, faceId),
        mergePersons: (targetPersonId, sourcePersonId) => ipcRenderer.invoke('ai:mergePersons', targetPersonId, sourcePersonId),
        deletePerson: (personId) => ipcRenderer.invoke('ai:deletePerson', personId),
        permanentlyDeletePerson: (personId) => ipcRenderer.invoke('ai:permanentlyDeletePerson', personId),
        unnamePersonAndDelete: (personId) => ipcRenderer.invoke('ai:unnamePersonAndDelete', personId),
        restoreUnnamedPerson: (token) => ipcRenderer.invoke('ai:restoreUnnamedPerson', token),
        restorePerson: (personId) => ipcRenderer.invoke('ai:restorePerson', personId),
        listDiscardedPersons: () => ipcRenderer.invoke('ai:listDiscardedPersons'),
        getPersonInfo: (personId) => ipcRenderer.invoke('ai:getPersonInfo', personId),
        visualSuggestions: (faceId) => ipcRenderer.invoke('ai:visualSuggestions', faceId),
        clusterFaceCount: (clusterId, personId) => ipcRenderer.invoke('ai:clusterFaceCount', clusterId, personId),
        getFaces: (fileId) => ipcRenderer.invoke('ai:getFaces', fileId),
        redetectFile: (fileId) => ipcRenderer.invoke('ai:redetectFile', fileId),
        getTags: (fileId) => ipcRenderer.invoke('ai:getTags', fileId),
        tagOptions: () => ipcRenderer.invoke('ai:tagOptions'),
        clearAll: () => ipcRenderer.invoke('ai:clearAll'),
        resetTagAnalysis: () => ipcRenderer.invoke('ai:resetTagAnalysis'),
        listBackups: () => ipcRenderer.invoke('db:listBackups'),
        restoreFromBackup: (snapshotPath) => ipcRenderer.invoke('db:restoreFromBackup', snapshotPath),
        takeSnapshot: (kind, label) => ipcRenderer.invoke('db:takeSnapshot', kind, label),
        deleteSnapshot: (snapshotPath) => ipcRenderer.invoke('db:deleteSnapshot', snapshotPath),
        exportSnapshotZip: (snapshotPath) => ipcRenderer.invoke('db:exportSnapshotZip', snapshotPath),
        personClusters: () => ipcRenderer.invoke('ai:personClusters'),
        prewarmPersonClusters: () => ipcRenderer.invoke('ai:prewarmPersonClusters'),
        recordPmOpen: () => ipcRenderer.invoke('pm:recordOpen'),
        dismissPmStartupPrompt: () => ipcRenderer.invoke('pm:dismissStartupPrompt'),
        personsCooccurrence: (selectedPersonIds) => ipcRenderer.invoke('ai:personsCooccurrence', selectedPersonIds),
        clusterFaces: (clusterId, page, perPage, personId, sortMode) => ipcRenderer.invoke('ai:clusterFaces', clusterId, page, perPage, personId, sortMode),
        recluster: (threshold) => ipcRenderer.invoke('ai:recluster', threshold),
        faceCrop: (filePath, boxX, boxY, boxW, boxH, size) => ipcRenderer.invoke('ai:faceCrop', filePath, boxX, boxY, boxW, boxH, size),
        faceCropBatch: (requests, size) => ipcRenderer.invoke('ai:faceCropBatch', requests, size),
        getPersonFaceCrop: (personId, size) => ipcRenderer.invoke('ai:getPersonFaceCrop', personId, size),
        faceContext: (filePath, boxX, boxY, boxW, boxH, size) => ipcRenderer.invoke('ai:faceContext', filePath, boxX, boxY, boxW, boxH, size),
        modelsReady: () => ipcRenderer.invoke('ai:modelsReady'),
        onProgress: (callback) => {
            // Per-handler registration so multiple renderer components can
            // subscribe simultaneously (e.g. TitleBar + SearchPanel). The
            // returned function removes ONLY this handler — the shared
            // channel keeps firing for the others.
            const handler = (_, data) => callback(data);
            ipcRenderer.on('ai:progress', handler);
            return () => ipcRenderer.removeListener('ai:progress', handler);
        },
        removeProgressListener: () => {
            // DEPRECATED: nukes every renderer's listener on this channel.
            // Prefer the unsubscribe function returned by onProgress().
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
    ping: () => ipcRenderer.invoke('app:ping'),
    quickAccessPaths: () => ipcRenderer.invoke('app:quickAccessPaths'),
    // Logging bridge — renderer code can push any structured event into
    // the main-process log file (which is the only persistent log in
    // production, DevTools being disabled). `getLogFilePath` lets a
    // future "Report a problem" button attach the file to a support
    // email without the user having to hunt for %APPDATA%.
    log: (payload) => ipcRenderer.invoke('app:log', payload),
    getLogFilePath: (reveal) => ipcRenderer.invoke('app:logFilePath', { reveal }),
    reportProblem: (payload) => ipcRenderer.invoke('app:reportProblem', payload),
    // Reveal an arbitrary file path in Explorer (highlights it inside
    // its folder). Used by ReportProblemModal's success state to
    // re-open the Documents folder showing the diagnostic ZIP if the
    // user accidentally closed the folder window we opened on Send.
    revealInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
    dateEditor: {
        open: (seedQuery) => ipcRenderer.invoke('dateEditor:open', seedQuery),
        onThemeChange: (callback) => {
            const handler = (_event, isDark) => callback(isDark);
            ipcRenderer.on('dateEditor:themeChange', handler);
            return () => ipcRenderer.removeListener('dateEditor:themeChange', handler);
        },
        onDataChanged: (callback) => {
            const handler = () => callback();
            ipcRenderer.on('dateEditor:dataChanged', handler);
            return () => ipcRenderer.removeListener('dateEditor:dataChanged', handler);
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
