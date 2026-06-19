/* eslint-disable @typescript-eslint/no-var-requires */

// IMPORTANT:
// Preload MUST be CommonJS when run by Electron
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pdr', {
  // v2.0.11 (Terry 2026-05-24) — renderer-side workspace-ready signal.
  // Sent from main.tsx after React commits its first frame so the
  // main process can reveal the workspace BrowserWindow WITHOUT
  // flashing the bare lavender body background first. Fire-and-forget
  // (send, not invoke) since main doesn't need to reply.
  workspaceFirstFrame: () => ipcRenderer.send('workspace:first-frame'),

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

  // v2.0.11 — orphan-source detection on rehydrate. Returns
  // { success, results: Array<{ path, hasExtraction, needsExtraction }> }
  // The renderer drops sources where hasExtraction=false AND
  // needsExtraction=true (zip/rar with the extraction folder gone).
  checkExtractionsForSources: (requests: Array<{ path: string; type: string }>) =>
    ipcRenderer.invoke('analysis:checkExtractionsForSources', requests),

  // Launch-time orphan sweep. Called by the renderer on FIRST mount.
  // Two modes:
  //   - looseFilesOnly:false (default) — sources are empty, full sweep
  //   - looseFilesOnly:true — sources are present, only delete loose
  //     FILES at the root (sub-folders may be active extractions)
  // Returns { success, dirsRemoved, bytesRemoved }.
  sweepOrphanedTempDirsIfEmpty: (opts?: { looseFilesOnly?: boolean }) =>
    ipcRenderer.invoke('analysis:sweepOrphanedTempDirsIfEmpty', opts),

  // Pre-flight library-drive readiness probe. Returns
  // { ready, destinationPath, freeBytes, totalBytes }.
  probeLibraryDrive: () => ipcRenderer.invoke('analysis:probeLibraryDrive'),

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
// Window-move forwarder. Main process emits this when the user
// drags the titlebar (-webkit-app-region: drag swallows mouse
// events at the renderer, so this is the only reliable signal).
// Popovers and dropdowns listen so they close on drag.
onWindowMove: (callback: () => void) => {
  const handler = () => callback();
  ipcRenderer.on('pdr:window-move', handler);
  return () => ipcRenderer.removeListener('pdr:window-move', handler);
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
  // v2.0.13 — multi-select picker for Takeout zips. Returns the array
  // of selected paths wrapped in { success, data }. Empty data array
  // on cancel; non-success only on IPC error.
  openTakeoutZips: () => ipcRenderer.invoke('dialog:openTakeoutZips') as Promise<{ success: boolean; error?: string; data?: string[] }>,

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

// v2.1 round 171 (Terry) — let a custom-title-bar window (viewer/collage)
// pull focus to itself the instant the cursor reaches its title bar, so an
// unfocused window drags on the FIRST title-bar grab instead of needing a
// focus-click first. See the main-process 'window:focus-self' handler.
focusSelf: () => ipcRenderer.send('window:focus-self'),

// v2.1 round 207 (Terry) — window-state bridge for the viewer/collage
// top-center "Restore window" pill. getState seeds the renderer's cached
// isMaximized (primary) + isFullScreen flags on load; exitFullOrRestore
// is the pill's (and Esc's) click target (leaves Electron fullscreen,
// else un-maximizes); onStateChange fires on maximize/unmaximize +
// enter/leave-full-screen (forwarded from main) so the pill's gate stays
// live. Returns an unsubscribe fn, matching the other on* bridges here.
window: {
  getState: () => ipcRenderer.invoke('window:getState') as Promise<{ isFullScreen: boolean; isMaximized: boolean }>,
  exitFullOrRestore: () => ipcRenderer.invoke('window:exitFullOrRestore'),
  onStateChange: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('window:state-changed', handler);
    return () => ipcRenderer.removeListener('window:state-changed', handler);
  },
},

openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (key: string, value: any) => ipcRenderer.invoke('settings:set', key, value),
    setAll: (settings: any) => ipcRenderer.invoke('settings:setAll', settings),
    resetToDefaults: () => ipcRenderer.invoke('settings:resetToDefaults'),
    /** v2.1 (Terry 2026-06-08) — subscribe to settings changes from
     *  any window. Used by the global Hide-captions toggle so
     *  Memories, Albums, PDRV, S&D etc. all re-render when the
     *  user flips it in Settings. Returns an unsubscribe fn. */
    onChanged: (callback: (payload: { key: string; value: any }) => void) => {
      const listener = (_e: any, payload: any) => callback(payload);
      ipcRenderer.on('settings:changed', listener);
      return () => ipcRenderer.removeListener('settings:changed', listener);
    },
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
    // v2.0.15 — list every distinct destinationPath in saved Fix
    // reports (most-recent-first). Renderer uses this on app start
    // to reconcile pdr-saved-destinations, restoring any entries
    // evicted by the historical MAX_SAVED_DESTINATIONS=3 cap.
    listReportDestinations: () => ipcRenderer.invoke('library:listReportDestinations'),
    // v2.0.15 — discover libraries PDR has ever written to but that
    // aren't in the LDM right now. Reads from the indexed_runs SQL
    // table (the cumulative log of every Fix run's destination),
    // returns paths that still exist on disk. The renderer filters
    // out the current Library Drive, already-in-LDM paths, and
    // entries in the ignore list before rendering.
    discoverLegacyLibraries: () => ipcRenderer.invoke('library:discoverLegacyLibraries'),
    // v2.0.15 — drive-scan discovery (Strategies 1 + 2). Walks
    // connected drives looking for PDR_Catalogue.csv files (high
    // confidence — catalogue travels with the library) and folders
    // matching PDR's year-based output structure (medium confidence —
    // looks like a PDR library, might be one). Heavier than
    // discoverLegacyLibraries — this hits the filesystem rather than
    // a SQL table, so the renderer fires it on-demand from a button
    // rather than auto-running on every LDM open.
    scanForLegacyLibraries: (opts?: { driveLetters?: string[] }) =>
      ipcRenderer.invoke('library:scanForLegacyLibraries', opts),
    // Per-path indexed-file count (count + total bytes + last
    // indexed timestamp) for a specific library root. Lets the LDM
    // show accurate per-folder counts on library-root rows instead
    // of the per-drive-letter rollup, which over-attributes when
    // multiple library folders share a drive.
    countFilesAtPath: (rootPath: string) => ipcRenderer.invoke('library:countFilesAtPath', rootPath),
    // v2.0.9 — counts media files (photos + videos) on disk under
    // `rootPath`. Paired with countFilesAtPath so callers can compare
    // "what's on disk" vs "what's in the search DB" and surface the
    // delta as a "this library isn't fully searchable yet" prompt.
    // Returns { onDiskCount: null, reachable: false } when the path
    // doesn't exist (drive unplugged) so the caller can distinguish
    // "0 files on disk" from "drive offline".
    countOnDiskFiles: (rootPath: string) => ipcRenderer.invoke('library:countOnDiskFiles', rootPath),
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
    // v2.0.12 — recovery-gap detector. Returns the gap detail when the
    // sidecar DB on the attached Library Drive materially exceeds the
    // local DB (cascade-delete signature). Returns null when there's
    // nothing to recover. Used by the workspace's CleanupCascadeRecovery
    // banner to surface a one-click restoreFromSidecar offer.
    detectRecoveryGap: () => ipcRenderer.invoke('library:detectRecoveryGap'),
    takeOverWriter: (opts: { libraryRoot: string; licenseKey: string; deviceName: string }) =>
      ipcRenderer.invoke('library:takeOverWriter', opts),
    mirrorNow: (opts?: { snapshotMode?: 'none' | 'recent' | 'all' }) =>
      ipcRenderer.invoke('library:mirrorNow', opts),
    disconnect: () => ipcRenderer.invoke('library:disconnect'),
    // Renderer-side hook: call this after any UI-triggered DB write
    // (People Manager rename / merge, Date Editor apply, Trees save) so
    // the background sidecar-mirror loop picks it up within ~30 seconds.
    bumpDirty: () => ipcRenderer.invoke('library:bumpDirty'),

    // v2.0.15 (Terry 2026-06-06) — Phase 3a. Single-file additions
    // outside the Fix-run path (currently: the Viewer's "Save Enhanced"
    // flow). Renderer views (S&D / Memories / Albums) listen for this
    // so the new file appears live, without a manual rescan.
    onFilesAdded: (callback: (info: { reason: string; mode?: string; sourcePath?: string; newFilePath?: string; fileId?: number }) => void) => {
      const handler = (_event: any, info: any) => callback(info);
      ipcRenderer.on('library:filesAdded', handler);
      return () => ipcRenderer.removeListener('library:filesAdded', handler);
    },
  },

  // v2.1 (Terry 2026-06-11) — Screen capture (screenshot → library).
  // screenshot() may return needsDisplayPick + a display list on
  // multi-monitor setups; the caller shows the picker and re-invokes
  // with displayId. Success/pending toasts are driven by the
  // capture:completed broadcast (covers hotkey captures too).
  capture: {
    screenshot: (opts?: { displayId?: string }) =>
      ipcRenderer.invoke('capture:screenshot', opts ?? {}) as Promise<{
        success: boolean;
        filePath?: string;
        filename?: string;
        fileId?: number | null;
        pending?: boolean;
        needsDisplayPick?: boolean;
        displays?: Array<{ id: string; label: string; width: number; height: number; isPrimary: boolean; thumbnailDataUrl: string }>;
        error?: string;
      }>,
    // v2.1 step 2 — region capture. The invoke resolves AFTER the
    // user finishes (or cancels) the drag-to-select overlay; a
    // cancelled selection resolves { success: false, cancelled: true }
    // and callers stay silent about it.
    region: (opts?: { displayId?: string }) =>
      ipcRenderer.invoke('capture:region', opts ?? {}) as Promise<{
        success: boolean;
        filePath?: string;
        filename?: string;
        fileId?: number | null;
        pending?: boolean;
        cancelled?: boolean;
        needsDisplayPick?: boolean;
        displays?: Array<{ id: string; label: string; width: number; height: number; isPrimary: boolean; thumbnailDataUrl: string }>;
        error?: string;
      }>,
    listDisplays: () => ipcRenderer.invoke('capture:listDisplays'),
    setHotkey: (accelerator: string) =>
      ipcRenderer.invoke('capture:setHotkey', accelerator) as Promise<{
        success: boolean;
        registered?: boolean;
        accelerator?: string;
        error?: string;
      }>,
    onCompleted: (callback: (info: { filePath: string; filename: string; fileId: number | null; pending: boolean; width: number | null; height: number | null }) => void) => {
      const handler = (_event: any, info: any) => callback(info);
      ipcRenderer.on('capture:completed', handler);
      return () => ipcRenderer.removeListener('capture:completed', handler);
    },
    onPendingFlushed: (callback: (info: { count: number }) => void) => {
      const handler = (_event: any, info: any) => callback(info);
      ipcRenderer.on('capture:pendingFlushed', handler);
      return () => ipcRenderer.removeListener('capture:pendingFlushed', handler);
    },
    // v2.1 round 124 — names any known capture tools currently
    // running (Lightshot, Snagit, ShareX, …) so Settings → Capture
    // can explain WHY a hotkey press might never reach PDR (their
    // keyboard hooks consume the combo before WM_HOTKEY fires).
    checkConflicts: () =>
      ipcRenderer.invoke('capture:checkConflicts') as Promise<{ success: boolean; tools?: string[]; error?: string }>,
    // ── Screen recording (v2.1 round 125, step 3) ──
    startRecording: (opts?: { displayId?: string }) =>
      ipcRenderer.invoke('capture:startRecording', opts ?? {}) as Promise<{
        success: boolean;
        alreadyRecording?: boolean;
        needsDisplayPick?: boolean;
        displays?: Array<{ id: string; label: string; width: number; height: number; isPrimary: boolean; thumbnailDataUrl: string }>;
        error?: string;
      }>,
    stopRecording: () => ipcRenderer.invoke('capture:stopRecording') as Promise<{ success: boolean; error?: string }>,
    cancelRecording: () => ipcRenderer.invoke('capture:cancelRecording') as Promise<{ success: boolean }>,
    onRecordingState: (callback: (info: { state: 'idle' | 'recording' | 'processing' }) => void) => {
      const handler = (_event: any, info: any) => callback(info);
      ipcRenderer.on('capture:recordingState', handler);
      return () => ipcRenderer.removeListener('capture:recordingState', handler);
    },
    onRecordError: (callback: (info: { message: string }) => void) => {
      const handler = (_event: any, info: any) => callback(info);
      ipcRenderer.on('capture:recordError', handler);
      return () => ipcRenderer.removeListener('capture:recordError', handler);
    },
    // ── Recording-widget page channels (capture-record-widget.html only) ──
    // The widget hosts the actual recorder engine; these carry the
    // init handshake, main-driven stop/cancel commands, the WebM
    // chunk stream, and the lifecycle reports back to main.
    onRecordInit: (callback: (info: { sourceId: string; audio: boolean; maxWidth: number; maxHeight: number; videoBitsPerSecond?: number; quality?: 'high' | 'standard' | 'compact'; armed?: boolean; region?: { x: number; y: number; width: number; height: number } | null }) => void) => {
      const handler = (_event: any, info: any) => callback(info);
      ipcRenderer.on('capture:record-init', handler);
      return () => ipcRenderer.removeListener('capture:record-init', handler);
    },
    // Round 129 — recorded-region marker page (capture-region-marker.html).
    onRegionMarkerInit: (callback: (info: { rect: { x: number; y: number; width: number; height: number } }) => void) => {
      const handler = (_event: any, info: any) => callback(info);
      ipcRenderer.on('capture:region-marker-init', handler);
      return () => ipcRenderer.removeListener('capture:region-marker-init', handler);
    },
    // Round 126 — mid-recording screenshot of the recorded display.
    recordSnap: () => ipcRenderer.send('capture:record-snap'),
    // Round 127 — quality changed from the recording bar (applies to
    // the save step now + persists for future recordings).
    recordQuality: (info: { quality: 'high' | 'standard' | 'compact' }) =>
      ipcRenderer.send('capture:record-quality', info),
    // Round 127 — Blur flow. The widget asks main to open the area
    // selector on the recorded display; the chosen area comes back on
    // record-do {action:'blur-opened'}; the widget then reports the
    // open/close segment stamps (recording-clock ms) here.
    recordBlurRequest: () => ipcRenderer.send('capture:record-blur-request'),
    recordBlur: (info: { type: 'open' | 'close'; rect?: { x: number; y: number; width: number; height: number }; startMs?: number; endMs?: number }) =>
      ipcRenderer.send('capture:record-blur', info),
    // Round 128 — camera bubble. Widget toggles it; the bubble page
    // (capture-cam.html) receives init/show/hide and reports fades
    // and camera failures.
    recordCamToggle: () => ipcRenderer.send('capture:record-cam-toggle'),
    // Round 130 — re-pick the recorded area from the armed bar.
    recordAreaRequest: () => ipcRenderer.send('capture:record-area-request'),
    // Round 131 — change the recorded screen from the bar's dropdown.
    recordSetScreen: (displayId: string) => ipcRenderer.send('capture:record-set-screen', displayId),
    // Round 130 — the widget measures its own content width and asks
    // main to size the window to fit, so controls never clip however
    // many buttons are shown.
    recordResize: (width: number) => ipcRenderer.send('capture:record-resize', width),
    onCamInit: (callback: (info: { deviceId: string; shape: 'circle' | 'rectangle' }) => void) => {
      const handler = (_event: any, info: any) => callback(info);
      ipcRenderer.on('capture:cam-init', handler);
      return () => ipcRenderer.removeListener('capture:cam-init', handler);
    },
    onCamDo: (callback: (cmd: { action: 'show' | 'hide' }) => void) => {
      const handler = (_event: any, cmd: any) => callback(cmd);
      ipcRenderer.on('capture:cam-do', handler);
      return () => ipcRenderer.removeListener('capture:cam-do', handler);
    },
    camFadedOut: () => ipcRenderer.send('capture:cam-fadedout'),
    camError: (info: { message: string }) => ipcRenderer.send('capture:cam-error', info),
    // ── Recording widget channels (capture-record-widget.html) ──
    // v2.1 round 139 — these (and the region-overlay channels below)
    // were briefly trapped inside the `collage` namespace when round
    // 138 inserted it mid-object; the widget calls them as
    // pdr.capture.record* / pdr.capture.overlay* and they silently
    // resolved to undefined (guarded calls → no chunks sent → empty
    // recordings; region overlay select/cancel dead). Restored to
    // capture where they belong.
    onRecordDo: (callback: (cmd: { action: 'stop' | 'cancel' }) => void) => {
      const handler = (_event: any, cmd: any) => callback(cmd);
      ipcRenderer.on('capture:record-do', handler);
      return () => ipcRenderer.removeListener('capture:record-do', handler);
    },
    recordChunk: (chunk: ArrayBuffer) => ipcRenderer.send('capture:record-chunk', chunk),
    recordStarted: (info: { width: number | null; height: number | null; hasAudio: boolean }) =>
      ipcRenderer.send('capture:record-started', info),
    recordStopped: (info: Record<string, never> | { durationMs?: number }) =>
      ipcRenderer.send('capture:record-stopped', info),
    recordCancelled: () => ipcRenderer.send('capture:record-cancelled'),
    recordError: (info: { message: string }) => ipcRenderer.send('capture:record-error', info),
    // ── Region-overlay page channels (capture-overlay.html only) ──
    // The overlay window loads this same preload; these three are its
    // entire API surface: receive the frozen frame (+ snap-to-window
    // rects), report the chosen rect (display CSS pixels), or report
    // a cancel.
    onOverlayInit: (callback: (info: { imageDataUrl: string; windows?: Array<{ x: number; y: number; width: number; height: number }> }) => void) => {
      const handler = (_event: any, info: any) => callback(info);
      ipcRenderer.on('capture:overlay-init', handler);
      return () => ipcRenderer.removeListener('capture:overlay-init', handler);
    },
    overlaySelect: (rect: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.send('capture:overlay-select', rect),
    overlayCancel: () => ipcRenderer.send('capture:overlay-cancel'),
  },

  // v2.1 round 139 (Terry 2026-06-12) — Collage. The freeform editor
  // lives in PDRV now (opened via search:openViewer with the collage
  // flag); this is just the save-back channel — main composites the
  // full-resolution originals with sharp and lands a _CO file.
  collage: {
    saveLayout: (layout: {
      canvas: { w: number; h: number; bg: string; bgImage?: { path: string; opacity: number; enh?: unknown } };
      items: Array<{ path: string; xFrac: number; yFrac: number; wFrac: number; aspect: number; rot: number; enh?: unknown }>;
    }) =>
      ipcRenderer.invoke('collage:saveLayout', layout) as Promise<{
        success: boolean; filePath?: string; filename?: string; fileId?: number | null; pending?: boolean; error?: string;
      }>,
    // v2.1 round 260 (Terry) — carousel wide: SLICED EXPORT. The carousel is now ONE
    // WIDE collage layout (canvas.w = pageCount*1080, h = 1350). Main bakes it once and
    // crops N slices of exactly 1080×1350, writing slide_01.jpg … slide_NN.jpg into one
    // dedicated subfolder and returning the file list + folder (the renderer reveals the
    // folder rather than opening N files). Signature changed from (layouts[]) → (layout,
    // pageCount); the return shape is unchanged.
    saveCarousel: (layout: unknown, pageCount: number) =>
      ipcRenderer.invoke('collage:saveCarousel', layout, pageCount) as Promise<{
        success: boolean;
        files?: Array<{ filePath: string; filename: string; fileId: number | null }>;
        folderPath?: string; count?: number; pending?: boolean; error?: string;
      }>,
    // v2.1 round 142 (Terry) — the collage editor asks the MAIN window to
    // open the shared photo picker for a background, and listens for the
    // chosen photo coming back.
    // v2.1 round 209 (Terry) — optional `multi` flag: when true the picker stays
    // open while CTRL/⌘ is held so several photos can be added in one session
    // (the "+ Add photos" flow). The delivery purpose stays 'collage-bg' so the
    // existing onBackgroundPicked routing (below) is unchanged; only the start
    // info carries the multi hint, which workspace.tsx reads to enable stay-open.
    pickBackground: (label?: string, multi?: boolean) =>
      ipcRenderer.invoke('photoPick:start', { purpose: 'collage-bg', label: label || '', multi: !!multi }) as Promise<{ success: boolean; error?: string }>,
    onBackgroundPicked: (callback: (filePath: string, remove?: boolean) => void) => {
      // v2.1 round 297 (Terry) — `remove` = the photo was un-ticked in the picker, so the
      // collage drops its tile (toggle-off) instead of adding one.
      const handler = (_event: any, p: any) => { if (p && p.purpose === 'collage-bg' && p.filePath) callback(p.filePath, !!p.remove); };
      ipcRenderer.on('photoPick:picked', handler);
      return () => ipcRenderer.removeListener('photoPick:picked', handler);
    },
    // v2.1 round 299 (Terry) — when Collages is reopened while already open, main focuses the
    // existing window (no reload, so work is kept) and forwards any newly-selected photos here
    // to ADD to the current collage rather than replacing it.
    onExternalAdd: (callback: (files: string[]) => void) => {
      const handler = (_event: any, p: any) => { if (p && Array.isArray(p.files)) callback(p.files); };
      ipcRenderer.on('collage:externalAdd', handler);
      return () => ipcRenderer.removeListener('collage:externalAdd', handler);
    },
    // v2.1 round 162 (Terry) — one-shot back-fill of existing collages into
    // the "PDR Collages" album.
    backfillAlbum: () =>
      ipcRenderer.invoke('collage:backfillAlbum') as Promise<{ success: boolean; albumId?: number | null; total?: number; added?: number; error?: string }>,
  },

  // v2.1 round 142 (Terry) — shared photo-picker mode (main React window
  // side). The main window enters pick mode when 'photoPick:start' fires,
  // delivers the chosen photo, or cancels.
  photoPick: {
    // v2.1 round 209 (Terry) — info now also carries an optional `multi` flag
    // (the add-photos flow sets it) so the main window can offer CTRL-held
    // stay-open multi-add. The handler forwards the whole info object unchanged.
    onStart: (callback: (info: { purpose: string; label: string; multi?: boolean }) => void) => {
      const handler = (_event: any, info: any) => callback(info);
      ipcRenderer.on('photoPick:start', handler);
      return () => ipcRenderer.removeListener('photoPick:start', handler);
    },
    // v2.1 round 210 (Terry) — optional keepOpen: a CTRL-held multi-add delivery.
    // When true, main delivers the photo but does NOT refocus the requester (so
    // the user stays in the picker to keep CTRL-clicking). Default false = finish.
    deliver: (purpose: string, filePath: string, keepOpen?: boolean, remove?: boolean) => ipcRenderer.send('photoPick:deliver', { purpose, filePath, keepOpen: !!keepOpen, remove: !!remove }),
    cancel: () => ipcRenderer.send('photoPick:cancel'),
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
    setMonthlyThumbnail: (args: { year: number; month: number; fileId: number }) => ipcRenderer.invoke('memories:setMonthlyThumbnail', args),
    clearMonthlyThumbnail: (args: { year: number; month: number }) => ipcRenderer.invoke('memories:clearMonthlyThumbnail', args),
    /** v2.1 round 67 (Terry 2026-06-09) — "Pending" rail entry data
     *  layer. pendingCounts is always global (no runIds) so the rail
     *  badge shows the true cross-library backlog; pendingFiles
     *  honours the active library filter so the Pending PAGE matches
     *  the rest of Memories' library scoping. */
    pendingCounts: () => ipcRenderer.invoke('memories:pendingCounts') as Promise<{
      success: boolean;
      data?: { total: number; tentative: number; placeholder: number; unrecorded: number };
      error?: string;
    }>,
    pendingFiles: (args?: { runIds?: number[]; tier?: 'tentative' | 'placeholder' | 'unrecorded' }) => ipcRenderer.invoke('memories:pendingFiles', args ?? {}) as Promise<{
      success: boolean;
      data?: Array<any>;
      error?: string;
    }>,
    /** v2.1 round 71 (Terry 2026-06-09) — commit a user-set date for
     *  one or more Needs-dates files. confidence stays 'marked'; the
     *  file just gains user_set_at + date_source='User-set' and
     *  disappears from the Pending view's WHERE clause. */
    setPendingDate: (args: { fileIds: number[]; isoDateTime: string }) =>
      ipcRenderer.invoke('memories:setPendingDate', args) as Promise<{
        success: boolean;
        data?: { rowsAffected: number };
        error?: string;
      }>,
    /** v2.1 round 90 (Terry 2026-06-10) — restore pre-save date /
     *  source / confidence for a batch of files. Powers the
     *  Needs Dates undo affordance — caller supplies snapshots
     *  captured immediately before the setPendingDate call. */
    restorePendingDates: (args: {
      entries: Array<{
        fileId: number;
        prevDate: string | null;
        prevSource: string | null;
        prevConfidence: string;
      }>;
    }) =>
      ipcRenderer.invoke('memories:restorePendingDates', args) as Promise<{
        success: boolean;
        data?: { rowsAffected: number };
        error?: string;
      }>,
    /** v2.1 round 79 phase A (Terry 2026-06-09) — lazy-hash JUST the
     *  Pending files that don't yet have a hash on record. Cheap
     *  (a few seconds for typical Pending lists). Fired on demand
     *  when the user clicks the "Duplicates only" filter. */
    hashPendingFiles: () =>
      ipcRenderer.invoke('memories:hashPendingFiles') as Promise<{
        success: boolean;
        data?: { hashed: number; failed: number; totalCandidates: number };
        error?: string;
      }>,
    /** v2.1 round 79 phase A — get duplicate clusters within Needs
     *  dates, with a flag per cluster for whether a Confirmed /
     *  Recovered twin exists elsewhere in the library. */
    getPendingDuplicates: () =>
      ipcRenderer.invoke('memories:getPendingDuplicates') as Promise<{
        success: boolean;
        data?: Array<{ hash: string; pendingFileIds: number[]; hasConfirmedTwin: boolean }>;
        error?: string;
      }>,
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

  albums: {
    // v2.0.8 step 3 — Memories Albums tab CRUD.
    list: () => ipcRenderer.invoke('albums:list'),
    create: (title: string) => ipcRenderer.invoke('albums:create', title),
    rename: (albumId: number, newTitle: string) => ipcRenderer.invoke('albums:rename', albumId, newTitle),
    delete: (albumId: number) => ipcRenderer.invoke('albums:delete', albumId),
    listPhotos: (albumId: number) => ipcRenderer.invoke('albums:listPhotos', albumId),
    addPhotos: (albumId: number, fileIds: number[]) => ipcRenderer.invoke('albums:addPhotos', albumId, fileIds),
    removePhotos: (albumId: number, fileIds: number[]) => ipcRenderer.invoke('albums:removePhotos', albumId, fileIds),
    // v2.0.13 — set / clear the album's user-chosen cover photo. Pass
    // fileId=null to revert to the auto-picked first-by-date default.
    setCoverPhoto: (albumId: number, fileId: number | null) => ipcRenderer.invoke('albums:setCoverPhoto', { albumId, fileId }),

    // v2.0.8 — Album group (folder) CRUD. Drives the AlbumsView's
    // hierarchical multi-membership tree.
    groups: {
      list: () => ipcRenderer.invoke('albumGroups:list'),
      listMemberships: () => ipcRenderer.invoke('albumGroups:listMemberships'),
      listAlbumsIn: (groupId: number) => ipcRenderer.invoke('albumGroups:listAlbumsIn', groupId),
      create: (title: string, parentId: number | null) => ipcRenderer.invoke('albumGroups:create', title, parentId),
      rename: (groupId: number, newTitle: string) => ipcRenderer.invoke('albumGroups:rename', groupId, newTitle),
      delete: (groupId: number) => ipcRenderer.invoke('albumGroups:delete', groupId),
      move: (groupId: number, newParentId: number | null) => ipcRenderer.invoke('albumGroups:move', groupId, newParentId),
      reorder: (siblingIds: number[]) => ipcRenderer.invoke('albumGroups:reorder', siblingIds),
      addAlbum: (albumId: number, groupId: number) => ipcRenderer.invoke('albumGroups:addAlbum', albumId, groupId),
      removeAlbum: (albumId: number, groupId: number) => ipcRenderer.invoke('albumGroups:removeAlbum', albumId, groupId),
    },
  },

  takeout: {
    // v2.0.8 step 2b — backfill albums + captions + corrected
    // original_filenames from a Google Takeout ZIP without re-extracting.
    // For users who Fixed their Takeout on v2.0.4–v2.0.7 (before albums
    // existed) and still have the original ZIP on disk.
    backfillFromZip: (zipPath: string) =>
      ipcRenderer.invoke('takeout:backfillFromZip', zipPath) as Promise<{
        success: boolean;
        error?: string;
        stats?: { albumFoldersDetected: number; photosConsidered: number; matchedAgainstLibrary: number; unmatched: number };
        summary?: {
          albumsCreated: number;
          albumsUpdated: number;
          totalFilesLinked: number;
          totalOriginalFilenamesRecovered: number;
          totalCaptionsApplied: number;
          perAlbum: Array<{ externalKey: string; title: string; filesLinked: number; originalFilenamesRecovered: number; captionsApplied: number; unresolvedFiles: number }>;
        } | null;
      }>,

    // v2.0.13 — cross-part Google Takeout sidecar cache.
    //   preScanSidecars: walk a list of Takeout zip files and pull
    //     every JSON sidecar out of each zip's central directory into
    //     the takeout_sidecars table. Photo bytes are NEVER read —
    //     runtime is bound by JSON count (~10 MB across 8 parts),
    //     not Takeout size (~400 GB across 8 parts).
    //   getSidecarSummary: powers the LDM "Takeout metadata" row.
    //   detectGroupId: helper for the source-menu banner — given a
    //     path, returns the export's group id or null.
    //   onPreScanProgress: subscribes to per-zip progress events
    //     emitted during a long pre-scan. Returns an unsubscribe fn.
    preScanSidecars: (zipPaths: string[]) =>
      ipcRenderer.invoke('takeout:preScanSidecars', zipPaths),
    getSidecarSummary: () => ipcRenderer.invoke('takeout:getSidecarSummary'),
    detectGroupId: (zipPath: string) => ipcRenderer.invoke('takeout:detectGroupId', zipPath),
    onPreScanProgress: (
      cb: (p: { zipPath: string; zipIndex: number; zipCount: number; scanned: number; inserted: number }) => void,
    ) => {
      const handler = (_e: unknown, p: { zipPath: string; zipIndex: number; zipCount: number; scanned: number; inserted: number }) => cb(p);
      ipcRenderer.on('takeout:preScanProgress', handler);
      return () => ipcRenderer.removeListener('takeout:preScanProgress', handler);
    },
  },

  // v2.0.13 — Enrichment pass: applies the cached Takeout sidecar
  // metadata to live _RC / _MK rows in indexed_files. Strictly
  // additive — never overrides user-set person_id, never deletes
  // album_files rows, never touches Trees data.
  //   dryRun: cheap pre-flight that returns counts so the modal
  //     can show "X files have improving metadata, run upgrade?"
  //     before the user commits.
  //   run: kicks off the pass. Resolves with the run summary on
  //     completion (or on cancel — summary.cancelled flag set).
  //   cancel: flips a module-level cancellation flag the engine
  //     checks between files.
  //   onProgress: subscribes to per-batch progress events.
  enrich: {
    dryRun: () => ipcRenderer.invoke('enrich:dryRun'),
    run: () => ipcRenderer.invoke('enrich:run'),
    cancel: () => ipcRenderer.invoke('enrich:cancel'),
    getLatestRun: () => ipcRenderer.invoke('enrich:getLatestRun'),
    onProgress: (
      cb: (p: { inspected: number; upgraded: number; unchanged: number; skipped: number; total: number; currentFilename?: string }) => void,
    ) => {
      const handler = (_e: unknown, p: { inspected: number; upgraded: number; unchanged: number; skipped: number; total: number; currentFilename?: string }) => cb(p);
      ipcRenderer.on('enrich:progress', handler);
      return () => ipcRenderer.removeListener('enrich:progress', handler);
    },
  },

  // v2.0.13 per-photo captions — read/write the indexed_files.caption
  // column for a single photo. writeExif=true also writes the value
  // to EXIF ImageDescription + XMP dc:description so it travels with
  // the file when exported.
  captions: {
    get: (fileId: number) => ipcRenderer.invoke('captions:get', fileId),
    getByPath: (filePath: string) => ipcRenderer.invoke('captions:getByPath', filePath),
    set: (fileId: number, caption: string, writeExif?: boolean) =>
      ipcRenderer.invoke('captions:set', { fileId, caption, writeExif }),
    clear: (fileId: number, writeExif?: boolean) =>
      ipcRenderer.invoke('captions:clear', { fileId, writeExif }),
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
    filterCounts: (query: any) => ipcRenderer.invoke('search:filterCounts', query),
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
    openViewer: (filePaths: string[], fileNames: string[], startIndex?: number, collage?: boolean) => ipcRenderer.invoke('search:openViewer', filePaths, fileNames, startIndex, collage),
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
    /** v2.0.14 — viewer asks main for the pending file list on mount.
     *  Replaces the old URL-query-blob approach that stalled the viewer
     *  open for ~60s on year-drilldown click (6,000+ file paths
     *  JSON-stringified into the URL). Returns one-shot — consumed on
     *  read so a stale list can't leak across opens. */
    getPendingFileList: () => ipcRenderer.invoke('viewer:getPendingFileList') as Promise<{ files: string[]; startIndex: number }>,
    /** v2.1 (Terry 2026-06-08) — batched date lookup for the
     *  filmstrip date-pill overlay. Pass the whole file list once
     *  on viewer mount; map indexed_files.derived_date back to
     *  each path. */
    getFileDates: (filePaths: string[]) => ipcRenderer.invoke('viewer:getFileDates', filePaths) as Promise<{ dates: Record<string, string | null> }>,
    // v2.0.15 (Terry 2026-06-06) — bake Enhance panel adjustments into
    // a real JPG. mode='new' creates <original>_E.jpg sibling;
    // mode='replace' overwrites the original. XMP metadata records the
    // enhancement in both paths. See main.ts viewer:saveEnhanced for
    // the full handler.
    // v2.1 (Terry 2026-06-07) — clip trim via ffmpeg -c copy. Writes
    // a `_T` sibling, indexes it, broadcasts library:filesAdded.
    trimVideo: (req: { filePath: string; startSec: number; endSec: number }) =>
      ipcRenderer.invoke('viewer:trimVideo', req) as Promise<{
        success: boolean;
        newFilePath?: string;
        error?: string;
      }>,
    saveEnhanced: (req: {
      filePath: string;
      mode: 'new' | 'replace';
      filterState: { brightness: number; contrast: number; saturation: number; temperature: number; bw?: boolean; colour?: number; tone?: 'none' | 'sepia' | 'vintage'; borderColor?: string; borderWeight?: 'thin' | 'mat' };
      // v2.0.15 Phase 5+ — AI Enhance flows pass the temp AI-output
      // file here so save bakes sliders on top of the AI output.
      sourceOverride?: string;
      enhancementType?: 'manual' | 'codeformer' | 'realesrgan' | 'manual+ai' | 'ai';
      enhancementMethod?: string;
    }) => ipcRenderer.invoke('viewer:saveEnhanced', req) as Promise<{ success: boolean; newFilePath?: string; error?: string }>,

    // v2.0.15 Phase 5+6 (Terry 2026-06-06) — AI Enhance IPC. The
    // viewer fires these, listens for viewer:enhanceProgress to update
    // a progress modal, then routes the returned outputPath through
    // saveEnhanced() above to land the final file in the library.
    enhanceFaces: (req: { filePath: string; fidelity?: number }) =>
      ipcRenderer.invoke('viewer:enhanceFaces', req) as Promise<{
        success: boolean;
        outputPath?: string;
        facesProcessed?: number;
        error?: string;
        requiresInstall?: 'codeformer' | 'realesrgan';
        requiresAnalysis?: boolean;
        fileId?: number;
      }>,
    enhanceWholeImage: (req: { filePath: string; tileSize?: number }) =>
      ipcRenderer.invoke('viewer:enhanceWholeImage', req) as Promise<{
        success: boolean;
        outputPath?: string;
        error?: string;
        requiresInstall?: 'codeformer' | 'realesrgan';
      }>,
    // v2.1 round 173 (Terry 2026-06-14) — Background remover. Returns a temp
    // transparent PNG (subject cut out) the collage uses as a tile's image.
    removeBackground: (req: { filePath: string; strength?: number }) =>
      ipcRenderer.invoke('viewer:removeBackground', req) as Promise<{
        success: boolean;
        outputPath?: string;
        error?: string;
        requiresInstall?: 'bgremover';
      }>,
    // v2.1 round 184 (Terry) — optional bg backdrop the cut-out is composited
    // onto before saving (transparent PNG / flattened colour / a photo).
    saveCutout: (req: {
      tempPath: string;
      originalPath?: string;
      bg?: { type: 'transparent' | 'color' | 'photo'; value: string };
    }) =>
      ipcRenderer.invoke('viewer:saveCutout', req) as Promise<{
        success: boolean;
        filePath?: string;
        filename?: string;
        fileId?: number | null;
        error?: string;
      }>,
    /** v2.1 (Terry 2026-06-07) — cancel any in-flight enhance run by
     *  terminating the underlying worker. */
    cancelEnhance: () =>
      ipcRenderer.invoke('viewer:cancelEnhance') as Promise<{ success: boolean; error?: string }>,
    /** v2.1 (Terry 2026-06-07) — manual-box face enhance. User
     *  drags a rectangle around a face that the auto-detector
     *  missed (e.g. in shadow), optionally with slider filter
     *  baked in so CodeFormer sees the brightened pixels. */
    enhanceFacesManual: (req: {
      filePath: string;
      manualBox: { x: number; y: number; w: number; h: number };
      filter?: { brightness?: number; contrast?: number; saturation?: number; bw?: boolean };
      fidelity?: number;
    }) => ipcRenderer.invoke('viewer:enhanceFacesManual', req) as Promise<{
      success: boolean;
      outputPath?: string;
      facesProcessed?: number;
      error?: string;
      requiresInstall?: 'codeformer' | 'realesrgan';
    }>,
    /** v2.1 round 10 (Terry 2026-06-07) — read face boxes for one
     *  photo. Used by the Boxes toggle in the Enhance panel to
     *  overlay every detected face on the image. */
    getFaceBoxes: (filePath: string) =>
      ipcRenderer.invoke('viewer:getFaceBoxes', filePath) as Promise<{
        success: boolean;
        error?: string;
        boxes: Array<{
          id: number;
          cluster_id: number | null;
          person_id: number | null;
          x: number; y: number; w: number; h: number;
          person_name: string | null;
          person_full_name: string | null;
          is_manual: number;
        }>;
      }>,
    /** v2.1 round 11 (Terry 2026-06-07) — delete a face_detection
     *  row. Allowed only on unnamed faces. */
    deleteFaceBox: (faceId: number) =>
      ipcRenderer.invoke('viewer:deleteFaceBox', faceId) as Promise<{ success: boolean; error?: string }>,
    /** v2.1 round 11 — name a face in-place from PDRV. Creates a
     *  new person if the name doesn't exist; otherwise joins. */
    nameFace: (payload: { faceId: number; clusterId: number | null; name: string }) =>
      ipcRenderer.invoke('viewer:nameFace', payload) as Promise<{ success: boolean; personId?: number; error?: string }>,
    /** v2.1 round 29 (Terry 2026-06-08) — "is the Whisper model
     *  already downloaded?" so the transcribe modal can show the
     *  ~3 GB download warning ONLY the first time, not every
     *  click forever. Returns { ready, modelDir }. */
    isTranscribeModelReady: () =>
      ipcRenderer.invoke('transcribe:isModelReady') as Promise<{ ready: boolean; modelDir: string }>,
    /** v2.1 round 29 — pre-flight time estimate for the confirm
     *  modal. Returns total duration in seconds + ETA seconds at
     *  the medium model's ~6× realtime + per-video overhead.
     *  Skips already-transcribed videos so the estimate matches
     *  what the worker will actually do. */
    estimateTranscribeBatch: (filePaths: string[]) =>
      ipcRenderer.invoke('transcribe:estimateBatch', filePaths) as Promise<{ totalDurationSec: number; etaSec: number; fileCount: number; alreadyDoneCount: number }>,
    /** v2.1 (Terry 2026-06-07) — video transcription. Whisper-medium
     *  local. Idempotent: if a transcript already exists for the
     *  file, returns it; otherwise runs the worker + persists. */
    transcribeVideo: (req: { filePath: string; language?: string }) =>
      ipcRenderer.invoke('viewer:transcribeVideo', req) as Promise<{
        success: boolean;
        existed?: boolean;
        segments?: Array<{ start: number; end: number; text: string }>;
        plainText?: string;
        language?: string | null;
        durationSeconds?: number | null;
        generatedAt?: string;
        model?: string;
        error?: string;
      }>,
    /** v2.1 round 57 (Terry 2026-06-09) — bulk list of file ids
     *  with transcripts. Renderer uses this once on mount to
     *  build a Set<number> for the on-tile "T" badge overlay.
     *  Refreshes when `pdr:transcribeCompleted` fires from the
     *  batch transcribe hook. */
    listTranscribedFileIds: () =>
      ipcRenderer.invoke('transcripts:listFileIds') as Promise<{
        success: boolean;
        ids: number[];
        error?: string;
      }>,
    /** v2.1 — read-only fetch of an existing transcript (no
     *  inference). Returns transcript: null if none. */
    getTranscript: (filePath: string) =>
      ipcRenderer.invoke('viewer:getTranscript', filePath) as Promise<{
        success: boolean;
        transcript: {
          segments: Array<{ start: number; end: number; text: string }>;
          plainText: string;
          language: string | null;
          durationSeconds: number | null;
          generatedAt: string;
          model: string;
        } | null;
        error?: string;
      }>,
    deleteTranscript: (filePath: string) =>
      ipcRenderer.invoke('viewer:deleteTranscript', filePath) as Promise<{ success: boolean; error?: string }>,
    /** Progress events fired by viewer:transcribeVideo while the
     *  worker is running. Returns an unsubscribe fn. */
    onTranscribeProgress: (handler: (info: { phase: string; percent: number }) => void) => {
      const listener = (_e: any, info: any) => handler(info);
      ipcRenderer.on('viewer:transcribeProgress', listener);
      return () => ipcRenderer.removeListener('viewer:transcribeProgress', listener);
    },
    /** v2.1 round 8 (Terry 2026-06-07) — Mark-a-face-only flow.
     *  Inserts a face_detections row at the user-drawn box so PM
     *  picks it up as Unknown person; no AI model invoked.
     *  Returns the new face_id / cluster_id so the renderer can
     *  ask PM to jump straight to it. */
    addManualFaceBox: (req: {
      filePath: string;
      manualBox: { x: number; y: number; w: number; h: number };
    }) => ipcRenderer.invoke('viewer:addManualFaceBox', req) as Promise<{
      success: boolean;
      faceId?: number;
      fileId?: number;
      clusterId?: number;
      error?: string;
    }>,
    onEnhanceProgress: (handler: (info: { kind: 'faces' | 'upscale'; phase: string; percent: number }) => void) => {
      const listener = (_e: any, info: any) => handler(info);
      ipcRenderer.on('viewer:enhanceProgress', listener);
      return () => ipcRenderer.removeListener('viewer:enhanceProgress', listener);
    },
    /** v2.0.14 — broadcast fired by viewer:setRotation. Renderers that
     *  hold cached thumbnails (Memories grid, Albums tiles, viewer
     *  filmstrip) subscribe to drop the stale entry and refetch with
     *  the new rotation. Returns an unsubscribe callback. */
    onRotationChanged: (handler: (data: { filePath: string; rotation: number }) => void) => {
      const listener = (_e: any, data: { filePath: string; rotation: number }) => handler(data);
      ipcRenderer.on('pdr:rotationChanged', listener);
      return () => ipcRenderer.removeListener('pdr:rotationChanged', listener);
    },
  },

  /** Native OS drag from PDR tiles to external apps (WhatsApp, Discord,
   *  email clients, Photoshop, etc.). The renderer intercepts the HTML5
   *  dragstart event with preventDefault, then asks main to hand the
   *  file path(s) over to the OS via webContents.startDrag — same drag
   *  payload the OS sees from File Explorer, so receivers get the
   *  original file from disk, not the cached thumb. */
  drag: {
    start: (files: string[], iconDataUrl?: string) => ipcRenderer.invoke('drag:start', { files, iconDataUrl }),
  },

  // v2.1 round 279 (Terry) — Sharing Phase 2: "Send to Phone" over local Wi-Fi.
  // start() takes the renderer's resolved selection (absolute file paths); main
  // spins up a short-lived LAN server and returns the URL to QR-encode. status()
  // polls the live download count; stop() tears the server down.
  phoneShare: {
    start: (paths: string[]) => ipcRenderer.invoke('phoneShare:start', paths) as Promise<{ success: boolean; data?: { active: boolean; url?: string; ip?: string; port?: number; fileCount?: number; downloads?: number; expiresAt?: number }; error?: string }>,
    stop: () => ipcRenderer.invoke('phoneShare:stop') as Promise<{ success: boolean; error?: string }>,
    status: () => ipcRenderer.invoke('phoneShare:status') as Promise<{ success: boolean; data?: { active: boolean; url?: string; ip?: string; port?: number; fileCount?: number; downloads?: number; expiresAt?: number }; error?: string }>,
  },

  // v2.1 round 280 (Terry) — Sharing Phase 3: Print + Print to PDF. photos()
  // opens the native OS print dialog (any printer + Microsoft Print to PDF);
  // savePdf() prompts for a path and writes a PDF. opts = layout/fit/paper/orientation.
  print: {
    photos: (paths: string[], opts: { layout: string; fit: string; paper: string; orientation: string; color?: string }) =>
      ipcRenderer.invoke('print:photos', paths, opts) as Promise<{ success: boolean; cancelled?: boolean; error?: string }>,
    savePdf: (paths: string[], opts: { layout: string; fit: string; paper: string; orientation: string; color?: string }) =>
      ipcRenderer.invoke('print:savePdf', paths, opts) as Promise<{ success: boolean; cancelled?: boolean; path?: string; error?: string }>,
    // v2.1 round 283 (Terry) — open the PDR Print modal from another window (the
    // Viewer). main focuses the main window + tells its renderer to open the modal,
    // so Viewer print and library print share ONE path: PDR modal -> native dialog.
    requestModal: (paths: string[]) => ipcRenderer.invoke('print:requestModal', paths) as Promise<{ success: boolean; error?: string }>,
    onOpenModal: (cb: (paths: string[]) => void) => { const h = (_e: any, paths: string[]) => cb(paths); ipcRenderer.on('print:openModal', h); return () => ipcRenderer.removeListener('print:openModal', h); },
  },

  // v2.1 round 284 (Terry) — Sharing Phase 4: copy a photo to the clipboard as
  // an image (paste into chats/docs). Local-only.
  clipboard: {
    copyImage: (path: string) => ipcRenderer.invoke('clipboard:copyImage', path) as Promise<{ success: boolean; error?: string }>,
    // v2.1 round 285 (Terry) — copy one or many files (CF_HDROP) so Ctrl+C / Ctrl+V
    // pastes them all in Explorer / email / chat.
    copyFiles: (paths: string[]) => ipcRenderer.invoke('clipboard:copyFiles', paths) as Promise<{ success: boolean; count?: number; error?: string }>,
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
    // v2.0.15 (Terry 2026-06-06) — progress event subscription for
    // PM's Improve Facial Recognition modal. Returns an unsubscribe
    // function. Payload shape matches RefineProgress in search-database.ts.
    onRefineProgress: (cb: (p: unknown) => void) => {
      const handler = (_event: unknown, p: unknown) => cb(p);
      ipcRenderer.on('ai:refineProgress', handler);
      return () => ipcRenderer.removeListener('ai:refineProgress', handler);
    },
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
    clusterNewFaces: (threshold?: number) => ipcRenderer.invoke('ai:clusterNewFaces', threshold),
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
    /** v2.1 round 9 — set/consume a pending focus payload so PM
     *  can jump to + highlight a specific face on open. Renderer
     *  flow: setPendingFocus({fileId, clusterId, faceId}) → open().
     *  PM flow on mount: consumePendingFocus() → if non-null,
     *  scroll to + flash that cluster. */
    setPendingFocus: (payload: { fileId: number; clusterId: number; faceId: number }) =>
      ipcRenderer.invoke('people:setPendingFocus', payload),
    consumePendingFocus: () =>
      ipcRenderer.invoke('people:consumePendingFocus') as Promise<{ focus: { fileId: number; clusterId: number; faceId: number; ts: number } | null }>,
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
  // System memory probe — used by the Dashboard's low-RAM advisory
  // to gate a one-shot guidance card for budget-laptop users.
  system: {
    memoryInfo: () => ipcRenderer.invoke('system:memoryInfo'),
    // Lite Tier 3 (Terry 2026-06-03) — top RAM consumers list, used
    // by the format-card's "See which apps are using your RAM →" link
    // when the Tier 2 RAM-pressure bullets are visible. Read-only.
    topMemoryConsumers: (limit: number = 5) => ipcRenderer.invoke('system:topMemoryConsumers', limit),
  },
  // Reveal an arbitrary file path in Explorer (highlights it inside
  // its folder). Used by ReportProblemModal's success state to
  // re-open the Documents folder showing the diagnostic ZIP if the
  // user accidentally closed the folder window we opened on Send.
  revealInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),

  // PDR Recycle Bin (v2.0.15) — soft-delete with restore + permanent
  // delete via OS Recycle Bin.
  recycle: {
    move: (fileIds: number[]) => ipcRenderer.invoke('recycle:move', fileIds),
    restore: (fileIds: number[]) => ipcRenderer.invoke('recycle:restore', fileIds),
    permanentDelete: (fileIds: number[], skipOsBin?: boolean) => ipcRenderer.invoke('recycle:permanentDelete', fileIds, skipOsBin === true),
    list: () => ipcRenderer.invoke('recycle:list'),
    count: () => ipcRenderer.invoke('recycle:count'),
    onChanged: (callback: (info: { kind: string; count: number }) => void) => {
      const handler = (_event: any, info: { kind: string; count: number }) => callback(info);
      ipcRenderer.on('recycle:changed', handler);
      return () => ipcRenderer.removeListener('recycle:changed', handler);
    },
  },

  // v2.0.15 Phase 4 (Terry 2026-06-06) — AI Photo Enhancement model
  // installer surface. Settings cards call list() on mount, install /
  // uninstall / cancel from button clicks, and subscribe to
  // onStateChanged for live progress updates.
  aiModels: {
    list: () => ipcRenderer.invoke('ai-models:list'),
    install: (key: 'codeformer' | 'realesrgan') => ipcRenderer.invoke('ai-models:install', key),
    cancel: (key: 'codeformer' | 'realesrgan') => ipcRenderer.invoke('ai-models:cancel', key),
    uninstall: (key: 'codeformer' | 'realesrgan') => ipcRenderer.invoke('ai-models:uninstall', key),
    onStateChanged: (callback: (info: { key: string; state: string; progress: { receivedBytes: number; totalBytes: number; percent: number } | null; error?: string }) => void) => {
      const handler = (_event: any, info: any) => callback(info);
      ipcRenderer.on('ai-models:stateChanged', handler);
      return () => ipcRenderer.removeListener('ai-models:stateChanged', handler);
    },
  },

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