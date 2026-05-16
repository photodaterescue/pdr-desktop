/* eslint-disable @typescript-eslint/no-var-requires */

// IMPORTANT:
// Preload MUST be CommonJS when run by Electron
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pdr', {
  runAnalysis: (sourcePath: string, sourceType: 'folder' | 'zip' | 'drive', tempDirOverride?: string) =>
  ipcRenderer.invoke('analysis:run', sourcePath, sourceType, tempDirOverride),

  getFileSize: (filePath: string) => ipcRenderer.invoke('file:getSize', filePath),

  fingerprintFolder: (dirPath: string) => ipcRenderer.invoke('folder:fingerprint', dirPath),

  cancelAnalysis: () => ipcRenderer.invoke('analysis:cancel'),

  // Best-effort cleanup of any extracted temp dir associated with a
  // source the user is removing from the source menu. Returns
  // { success, cleaned } where cleaned is the number of temp
  // directories actually deleted.
  cleanupTempDirForSource: (sourcePath: string) =>
    ipcRenderer.invoke('analysis:cleanupTempDirForSource', sourcePath),

  onAnalysisProgress: (callback: (progress: any) => void) => {
  ipcRenderer.on('analysis:progress', (_: any, data: any) => callback(data));
},

removeAnalysisProgressListener: () => {
  ipcRenderer.removeAllListeners('analysis:progress');
},

// Diagnostic stream — release-testing telemetry from the analysis
// pipeline (phase markers, periodic memory snapshots, per-large-file
// timings, skip-and-continue warnings, final summary). Renderer
// just console.logs these so they land in F12 alongside any other
// front-end logging during a 50 GB Takeout test run.
onAnalysisDiagnostic: (callback: (msg: string) => void) => {
  ipcRenderer.on('analysis:diagnostic', (_: any, msg: string) => callback(msg));
},

removeAnalysisDiagnosticListener: () => {
  ipcRenderer.removeAllListeners('analysis:diagnostic');
},

copyFiles: (data: { files: Array<{ sourcePath: string; newFilename: string; sourceType: 'folder' | 'zip' }>; destinationPath: string; zipPaths?: Record<string, string>; photoFormat?: 'original' | 'png' | 'jpg' }) => ipcRenderer.invoke('files:copy', data),
onCopyProgress: (callback: (progress: { current: number; total: number }) => void) => {
  ipcRenderer.on('files:copy:progress', (_event: any, progress: any) => callback(progress));
},
// Phase events from the network-staging path: 'staging' fires when
// PDR detects a network destination and starts writing locally; 'mirror'
// fires when robocopy starts pushing the local staging tree to the
// network. Lets the renderer swap the progress label so the user
// understands why the bar may sit at 100% briefly while the
// network upload finishes.
onCopyPhase: (callback: (phase: { phase: 'staging' | 'mirror'; message: string }) => void) => {
  ipcRenderer.on('files:copy:phase', (_event: any, p: any) => callback(p));
},
onCopyMirrorProgress: (callback: (progress: { filesMirrored: number; totalToMirror: number }) => void) => {
  ipcRenderer.on('files:copy:mirror-progress', (_event: any, p: any) => callback(p));
},
cancelCopyFiles: () => ipcRenderer.invoke('files:copy:cancel'),
setFixInProgress: (inProgress: boolean) => ipcRenderer.invoke('fix:setInProgress', inProgress),
// Cold-start query for windows that open mid-fix (e.g. PM
// launched while a fix is running) — lets them gate their
// mutating actions immediately rather than waiting for the
// next state-change broadcast.
getFixInProgress: () => ipcRenderer.invoke('fix:getInProgress'),
// Cross-window subscription to fix-state changes. Fires from
// the main process whenever setFixInProgress is called by any
// window. Returns an unsubscribe fn.
onFixStateChanged: (callback: (state: { inProgress: boolean }) => void) => {
  const handler = (_event: any, state: any) => callback(state);
  ipcRenderer.on('fix:stateChanged', handler);
  return () => ipcRenderer.removeListener('fix:stateChanged', handler);
},
// Cross-window progress broadcast. Lets PM (separate window)
// render a real chip with phase/processed/total instead of just
// "Fix in progress". Sent by whichever window owns the active
// fix (currently always the main window).
broadcastFixProgress: (payload: any) => ipcRenderer.invoke('fix:broadcastProgress', payload),
getFixProgress: () => ipcRenderer.invoke('fix:getProgress'),
onFixProgress: (callback: (payload: any) => void) => {
  const handler = (_event: any, payload: any) => callback(payload);
  ipcRenderer.on('fix:progressBroadcast', handler);
  return () => ipcRenderer.removeListener('fix:progressBroadcast', handler);
},

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
  
  openFolder: (defaultPath?: string) => ipcRenderer.invoke('dialog:openFolder', defaultPath),
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

  // Library-portable DB (v2.0.5 foundation). One hidden folder on the
  // user's library drive mirrors the search DB + audit log + recent
  // snapshots + a writer-lock file. Lets users reconnect instantly on a
  // new device, with single-writer/multi-reader semantics.
  library: {
    status: () => ipcRenderer.invoke('library:status'),
    detectSidecar: (libraryRoot: string) => ipcRenderer.invoke('library:detectSidecar', libraryRoot),
    detectDriveType: (libraryRoot: string) => ipcRenderer.invoke('library:detectDriveType', libraryRoot),
    // Full premium-LDM identity block for a drive: letter, volume label,
    // file system (NTFS/exFAT/...), drive-type label, total/free bytes,
    // online flag, isSafeForLibrary. One IPC = one PowerShell exec so the
    // renderer doesn't fan out N calls per drive for N fields.
    getDriveDetails: (libraryRoot: string) => ipcRenderer.invoke('library:getDriveDetails', libraryRoot),
    // The "drives in your library" list — every drive the search DB has
    // indexed photos from, with per-drive counts, sizes, online status,
    // volume labels. Premium LDM shows the WHOLE library shape, not just
    // the one sidecar-host drive.
    listIndexedDrives: () => ipcRenderer.invoke('library:listIndexedDrives'),
    // Per-path indexed-file count (count + total bytes + last
    // indexed timestamp) for a specific library root. Lets the LDM
    // show accurate per-folder counts on library-root rows instead
    // of the per-drive-letter rollup, which over-attributes when
    // multiple library folders share a drive.
    countFilesAtPath: (rootPath: string) => ipcRenderer.invoke('library:countFilesAtPath', rootPath),
    // Open a path in the OS file manager (Explorer on Windows, Finder on
    // macOS). Used by per-drive "Open in File Explorer" entries in LDM.
    openInExplorer: (targetPath: string) => ipcRenderer.invoke('library:openInExplorer', targetPath),
    // Export the search DB to a user-chosen path — premium portability
    // safeguard. Lets the user keep an offsite copy of their library DB
    // (face tags, names, dates, trees) so they don't have to use an
    // external Library Drive purely for portability.
    exportDb: () => ipcRenderer.invoke('library:exportDb'),
    // Quick fs.existsSync check on the persisted destinationPath —
    // used by the renderer on Workspace mount to surface the
    // "Library Drive isn't connected" modal proactively, before any
    // IPC that touches the drive fails cryptically.
    checkDestinationOnline: () => ipcRenderer.invoke('library:checkDestinationOnline'),
    attachAsNew: (opts: { libraryRoot: string; licenseKey: string; deviceName: string; snapshotMode?: 'none' | 'recent' | 'all' }) =>
      ipcRenderer.invoke('library:attachAsNew', opts),
    attachFromSidecar: (opts: { libraryRoot: string; licenseKey: string; deviceName: string }) =>
      ipcRenderer.invoke('library:attachFromSidecar', opts),
    takeOverWriter: (opts: { libraryRoot: string; licenseKey: string; deviceName: string }) =>
      ipcRenderer.invoke('library:takeOverWriter', opts),
    mirrorNow: (opts?: { snapshotMode?: 'none' | 'recent' | 'all' }) =>
      ipcRenderer.invoke('library:mirrorNow', opts),
    disconnect: () => ipcRenderer.invoke('library:disconnect'),
    // Renderer-side hook: call this after any UI-triggered DB write
    // (People Manager rename / merge, Date Editor apply, Trees save) so
    // the background sidecar-mirror loop picks it up within ~30 seconds.
    bumpDirty: () => ipcRenderer.invoke('library:bumpDirty'),
  },

  // Free Trial file counter — read / increment the Cloudflare
  // KV-backed tally. Renderer reads it for the workspace banner and
  // pre-fix gate; main.ts auto-increments after each successful Fix
  // (wired into files:copy in the next phase).
  usage: {
    get: (licenseKey: string) =>
      ipcRenderer.invoke('usage:get', licenseKey) as Promise<
        { success: true; used: number; limit: number } | { success: false; error: string }
      >,
    increment: (licenseKey: string, count: number) =>
      ipcRenderer.invoke('usage:increment', licenseKey, count) as Promise<
        { success: true; used: number; limit: number } | { success: false; error: string }
      >,
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
    onState: (callback: (state: any) => void) => {
      const handler = (_event: any, state: any) => callback(state);
      ipcRenderer.on('updates:state', handler);
      return () => ipcRenderer.removeListener('updates:state', handler);
    },
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

  video: {
    prepare: (filePath: string) => ipcRenderer.invoke('video:prepare', filePath),
  },

  date: {
    getSuggestions: (fileId: number) => ipcRenderer.invoke('date:getSuggestions', fileId),
    apply: (opts: any) => ipcRenderer.invoke('date:apply', opts),
    undo: () => ipcRenderer.invoke('date:undo'),
    auditLog: (limit?: number) => ipcRenderer.invoke('date:auditLog', limit),
  },

  scannerOverride: {
    list: () => ipcRenderer.invoke('scannerOverride:list'),
    set: (args: { make: string; model: string; isScanner: boolean }) => ipcRenderer.invoke('scannerOverride:set', args),
    clear: (args: { make: string; model: string }) => ipcRenderer.invoke('scannerOverride:clear', args),
  },

  memories: {
    yearMonthBuckets: (runIds?: number[]) => ipcRenderer.invoke('memories:yearMonthBuckets', runIds),
    onThisDay: (args: { month: number; day: number; runIds?: number[]; limit?: number }) => ipcRenderer.invoke('memories:onThisDay', args),
    dayFiles: (args: { year: number; month?: number | null; day?: number | null; runIds?: number[] }) => ipcRenderer.invoke('memories:dayFiles', args),
  },

  trees: {
    addRelationship: (args: {
      personAId: number;
      personBId: number;
      type: 'parent_of' | 'spouse_of' | 'sibling_of' | 'associated_with';
      since?: string | null;
      until?: string | null;
      flags?: Record<string, unknown> | null;
      confidence?: number;
      source?: 'user' | 'suggested';
      note?: string | null;
    }) => ipcRenderer.invoke('trees:addRelationship', args),
    updateRelationship: (args: { id: number; patch: Record<string, unknown> }) => ipcRenderer.invoke('trees:updateRelationship', args),
    removeRelationship: (id: number) => ipcRenderer.invoke('trees:removeRelationship', id),
    listRelationshipsForPerson: (personId: number) => ipcRenderer.invoke('trees:listRelationshipsForPerson', personId),
    listAllRelationships: () => ipcRenderer.invoke('trees:listAllRelationships'),
    updatePersonLifeEvents: (args: { personId: number; patch: { birthDate?: string | null; deathDate?: string | null; deceasedMarker?: string | null } }) => ipcRenderer.invoke('trees:updatePersonLifeEvents', args),
    setPersonCardBackground: (args: { personId: number; dataUrl: string | null }) => ipcRenderer.invoke('trees:setPersonCardBackground', args),
    setPersonGender: (args: { personId: number; gender: string | null }) => ipcRenderer.invoke('trees:setPersonGender', args),
    getFamilyGraph: (args: { focusPersonId: number; maxHops?: number }) => ipcRenderer.invoke('trees:getFamilyGraph', args),
    getCooccurrenceStats: (args: { limit?: number; minSharedPhotos?: number }) => ipcRenderer.invoke('trees:getCooccurrenceStats', args),
    getPartnerSuggestionScores: (anchorId: number) => ipcRenderer.invoke('trees:getPartnerSuggestionScores', anchorId),
    savedList: () => ipcRenderer.invoke('trees:savedList'),
    savedGet: (id: number) => ipcRenderer.invoke('trees:savedGet', id),
    savedCreate: (args: any) => ipcRenderer.invoke('trees:savedCreate', args),
    savedUpdate: (args: { id: number; patch: any }) => ipcRenderer.invoke('trees:savedUpdate', args),
    savedDelete: (id: number) => ipcRenderer.invoke('trees:savedDelete', id),
    toggleHiddenAncestor: (args: { treeId: number; personId: number }) => ipcRenderer.invoke('trees:toggleHiddenAncestor', args),
    undo: () => ipcRenderer.invoke('trees:undo'),
    redo: () => ipcRenderer.invoke('trees:redo'),
    historyCounts: () => ipcRenderer.invoke('trees:historyCounts'),
    historyList: (limit?: number) => ipcRenderer.invoke('trees:historyList', limit),
    historyRevert: (targetId: number) => ipcRenderer.invoke('trees:historyRevert', targetId),
    createPlaceholderPerson: () => ipcRenderer.invoke('trees:createPlaceholderPerson'),
    createNamedPerson: (name: string) => ipcRenderer.invoke('trees:createNamedPerson', name),
    namePlaceholder: (args: { personId: number; name: string }) => ipcRenderer.invoke('trees:namePlaceholder', args),
    mergePlaceholder: (args: { placeholderId: number; targetPersonId: number }) => ipcRenderer.invoke('trees:mergePlaceholder', args),
    removePlaceholder: (id: number) => ipcRenderer.invoke('trees:removePlaceholder', id),
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
    rebuildFromLibraries: (rootPaths: string[]) => ipcRenderer.invoke('search:rebuildFromLibraries', rootPaths),
    onRebuildProgress: (callback: (progress: any) => void) => {
      const handler = (_: any, data: any) => callback(data);
      ipcRenderer.on('search:rebuildProgress', handler);
      return () => ipcRenderer.removeListener('search:rebuildProgress', handler);
    },
    cleanup: () => ipcRenderer.invoke('search:cleanup'),
    relocateRun: (runId: number, newPath: string) => ipcRenderer.invoke('search:relocateRun', runId, newPath),
    getFileMetaByPath: (filePath: string) => ipcRenderer.invoke('search:getFileMetaByPath', filePath),
    onStaleRuns: (callback: (runs: any[]) => void) => {
      const handler = (_event: any, runs: any[]) => callback(runs);
      ipcRenderer.on('search:staleRuns', handler);
      return () => ipcRenderer.removeListener('search:staleRuns', handler);
    },
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
    openViewer: (filePaths: string[], fileNames: string[], startIndex?: number) => ipcRenderer.invoke('search:openViewer', filePaths, fileNames, startIndex),
    checkPathsExist: (paths: string[]) => ipcRenderer.invoke('search:checkPathsExist', paths),
    /** Sent by the viewer window each time the user navigates to a
     *  different photo. Other renderers (PM's FaceGridModal) can
     *  subscribe via onViewerIndex to mirror the selection. */
    notifyViewerIndex: (index: number, filePath: string) => ipcRenderer.send('search:viewerIndexChange', index, filePath),
    onViewerIndex: (handler: (data: { index: number; filePath: string }) => void) => {
      const listener = (_e: any, data: { index: number; filePath: string }) => handler(data);
      ipcRenderer.on('search:viewerIndex', listener);
      return () => ipcRenderer.removeListener('search:viewerIndex', listener);
    },
  },

  /** Viewer rotation — read/write the user-applied rotation for a
   *  given file_path. Used by the PDR Viewer to make rotation
   *  sticky across sessions; never touches the original file. */
  viewer: {
    getRotation: (filePath: string) => ipcRenderer.invoke('viewer:getRotation', filePath),
    setRotation: (filePath: string, rotation: number) => ipcRenderer.invoke('viewer:setRotation', filePath, rotation),
  },

  ai: {
    start: () => ipcRenderer.invoke('ai:start'),
    cancel: () => ipcRenderer.invoke('ai:cancel'),
    pause: () => ipcRenderer.invoke('ai:pause'),
    resume: () => ipcRenderer.invoke('ai:resume'),
    status: () => ipcRenderer.invoke('ai:status'),
    stats: () => ipcRenderer.invoke('ai:stats'),
    listPersons: () => ipcRenderer.invoke('ai:listPersons'),
    namePerson: (name: string, clusterId?: number, avatarData?: string, fullName?: string | null) => ipcRenderer.invoke('ai:namePerson', name, clusterId, avatarData, fullName),
    assignFace: (faceId: number, personId: number, verified?: boolean) => ipcRenderer.invoke('ai:assignFace', faceId, personId, verified ?? false),
    batchVerify: (personIds: number[]) => ipcRenderer.invoke('ai:batchVerify', personIds),
    unnameFace: (faceId: number) => ipcRenderer.invoke('ai:unnameFace', faceId),
    refineFromVerified: (similarityThreshold?: number, personFilter?: number) => ipcRenderer.invoke('ai:refineFromVerified', similarityThreshold, personFilter),
    importXmpFaces: () => ipcRenderer.invoke('ai:importXmpFaces'),
    renamePerson: (personId: number, newName: string, newFullName?: string | null) => ipcRenderer.invoke('ai:renamePerson', personId, newName, newFullName),
    setRepresentativeFace: (personId: number, faceId: number) => ipcRenderer.invoke('ai:setRepresentativeFace', personId, faceId),
    mergePersons: (targetPersonId: number, sourcePersonId: number) => ipcRenderer.invoke('ai:mergePersons', targetPersonId, sourcePersonId),
    deletePerson: (personId: number) => ipcRenderer.invoke('ai:deletePerson', personId),
    permanentlyDeletePerson: (personId: number) => ipcRenderer.invoke('ai:permanentlyDeletePerson', personId),
    unnamePersonAndDelete: (personId: number) => ipcRenderer.invoke('ai:unnamePersonAndDelete', personId),
    restoreUnnamedPerson: (token: any) => ipcRenderer.invoke('ai:restoreUnnamedPerson', token),
    restorePerson: (personId: number) => ipcRenderer.invoke('ai:restorePerson', personId),
    listDiscardedPersons: () => ipcRenderer.invoke('ai:listDiscardedPersons'),
    getPersonInfo: (personId: number) => ipcRenderer.invoke('ai:getPersonInfo', personId),
    visualSuggestions: (faceId: number) => ipcRenderer.invoke('ai:visualSuggestions', faceId),
    clusterFaceCount: (clusterId: number, personId?: number) => ipcRenderer.invoke('ai:clusterFaceCount', clusterId, personId),
    getFaces: (fileId: number) => ipcRenderer.invoke('ai:getFaces', fileId),
    redetectFile: (fileId: number) => ipcRenderer.invoke('ai:redetectFile', fileId),
    getTags: (fileId: number) => ipcRenderer.invoke('ai:getTags', fileId),
    tagOptions: () => ipcRenderer.invoke('ai:tagOptions'),
    clearAll: () => ipcRenderer.invoke('ai:clearAll'),
    resetTagAnalysis: () => ipcRenderer.invoke('ai:resetTagAnalysis'),
    listBackups: () => ipcRenderer.invoke('db:listBackups'),
    restoreFromBackup: (snapshotPath: string) => ipcRenderer.invoke('db:restoreFromBackup', snapshotPath),
    takeSnapshot: (kind: 'manual' | 'auto-event', label?: string) => ipcRenderer.invoke('db:takeSnapshot', kind, label),
    deleteSnapshot: (snapshotPath: string) => ipcRenderer.invoke('db:deleteSnapshot', snapshotPath),
    exportSnapshotZip: (snapshotPath: string) => ipcRenderer.invoke('db:exportSnapshotZip', snapshotPath),
    personClusters: () => ipcRenderer.invoke('ai:personClusters'),
    prewarmPersonClusters: () => ipcRenderer.invoke('ai:prewarmPersonClusters'),
    recordPmOpen: () => ipcRenderer.invoke('pm:recordOpen'),
    dismissPmStartupPrompt: () => ipcRenderer.invoke('pm:dismissStartupPrompt'),
    personsCooccurrence: (selectedPersonIds: number[]) => ipcRenderer.invoke('ai:personsCooccurrence', selectedPersonIds),
    clusterFaces: (clusterId: number, page?: number, perPage?: number, personId?: number, sortMode?: 'chronological' | 'confidence-asc') => ipcRenderer.invoke('ai:clusterFaces', clusterId, page, perPage, personId, sortMode),
    recluster: (threshold: number) => ipcRenderer.invoke('ai:recluster', threshold),
    faceCrop: (filePath: string, boxX: number, boxY: number, boxW: number, boxH: number, size?: number) =>
      ipcRenderer.invoke('ai:faceCrop', filePath, boxX, boxY, boxW, boxH, size),
    faceCropBatch: (
      requests: { face_id: number; file_path: string; box_x: number; box_y: number; box_w: number; box_h: number }[],
      size?: number,
    ) => ipcRenderer.invoke('ai:faceCropBatch', requests, size),
    getPersonFaceCrop: (personId: number, size?: number) =>
      ipcRenderer.invoke('ai:getPersonFaceCrop', personId, size),
    faceContext: (filePath: string, boxX: number, boxY: number, boxW: number, boxH: number, size?: number) =>
      ipcRenderer.invoke('ai:faceContext', filePath, boxX, boxY, boxW, boxH, size),
    modelsReady: () => ipcRenderer.invoke('ai:modelsReady'),
    onProgress: (callback: (progress: any) => void) => {
      // Per-handler registration so multiple renderer components can
      // subscribe simultaneously (e.g. TitleBar + SearchPanel). The
      // returned function removes ONLY this handler — the shared
      // channel keeps firing for the others.
      const handler = (_: any, data: any) => callback(data);
      ipcRenderer.on('ai:progress', handler);
      return () => ipcRenderer.removeListener('ai:progress', handler);
    },
    removeProgressListener: () => {
      // DEPRECATED: nukes every renderer's listener on this channel.
      // Prefer the unsubscribe function returned by onProgress().
      ipcRenderer.removeAllListeners('ai:progress');
    },
    onLog: (callback: (msg: string) => void) => {
      ipcRenderer.on('ai:log', (_: any, msg: string) => callback(msg));
    },
    replayLogs: () => ipcRenderer.invoke('ai:replayLogs'),
  },

  openSettings: (tab?: string) => ipcRenderer.invoke('app:openSettings', tab),
  onOpenSettings: (callback: (event: any, tab: string) => void) => {
    ipcRenderer.on('app:openSettings', callback);
    return () => ipcRenderer.removeListener('app:openSettings', callback);
  },

  people: {
    open: () => ipcRenderer.invoke('people:open'),
    notifyChange: () => ipcRenderer.invoke('people:changed'),
    onThemeChange: (callback: (isDark: boolean) => void) => {
      const handler = (_event: any, isDark: boolean) => callback(isDark);
      ipcRenderer.on('people:themeChange', handler);
      return () => ipcRenderer.removeListener('people:themeChange', handler);
    },
    onDataChanged: (callback: () => void) => {
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
  log: (payload: { level?: 'info' | 'warn' | 'error' | 'debug'; message?: string; data?: unknown }) =>
    ipcRenderer.invoke('app:log', payload),
  getLogFilePath: (reveal?: boolean) => ipcRenderer.invoke('app:logFilePath', { reveal }),
  reportProblem: (payload: { description?: string; userEmail?: string }) =>
    ipcRenderer.invoke('app:reportProblem', payload),
  // Reveal an arbitrary file path in Explorer (highlights it inside
  // its folder). Used by ReportProblemModal's success state to
  // re-open the Documents folder showing the diagnostic ZIP if the
  // user accidentally closed the folder window we opened on Send.
  revealInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),

  dateEditor: {
    open: (seedQuery?: any) => ipcRenderer.invoke('dateEditor:open', seedQuery),
    onThemeChange: (callback: (isDark: boolean) => void) => {
      const handler = (_event: any, isDark: boolean) => callback(isDark);
      ipcRenderer.on('dateEditor:themeChange', handler);
      return () => ipcRenderer.removeListener('dateEditor:themeChange', handler);
    },
    onDataChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('dateEditor:dataChanged', handler);
      return () => ipcRenderer.removeListener('dateEditor:dataChanged', handler);
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

  structure: {
    copyToStructure: (data: any) => ipcRenderer.invoke('structure:copy', data),
    cancel: () => ipcRenderer.invoke('structure:copy:cancel'),
    onProgress: (callback: (progress: any) => void) => {
      ipcRenderer.on('structure:copy:progress', (_: any, data: any) => callback(data));
    },
    removeProgressListener: () => {
      ipcRenderer.removeAllListeners('structure:copy:progress');
    },
  },
});