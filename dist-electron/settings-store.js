import Store from 'electron-store';
import { app } from 'electron';
import * as path from 'path';
// Optimised defaults - safe configuration for most users
export const optimisedDefaults = {
    skipDuplicates: true,
    thoroughDuplicateMatching: false,
    writeExif: true,
    exifWriteConfirmed: true,
    exifWriteRecovered: true,
    exifWriteMarked: false,
    showStoragePerformanceTips: true,
    rememberSources: true,
    clearSourcesAfterFix: true,
    // AI defaults — disabled until user opts in
    aiEnabled: false,
    aiFaceDetection: true,
    aiObjectTagging: true,
    aiAutoProcess: true,
    aiMinFaceConfidence: 0.7,
    aiMinTagConfidence: 0.3,
    aiVisualSuggestions: true,
    aiRefineFromVerified: false,
    // Auto-catalogue — cumulative CSV/TXT at destination root
    autoSaveCatalogue: true,
    showManualReportExports: false,
    matchThreshold: 0.72,
    aiSearchMatchThreshold: 0.72,
    aiSearchMatchMode: 'ai',
    openPeopleOnStartup: false,
    pmOpenDays: [],
    pmStartupPromptDismissed: false,
    scannerOverrides: [],
    networkUploadMode: 'fast',
    bypassLargeZipPreExtract: false,
    destinationPath: null,
};
// Pin the settings file path explicitly to %APPDATA%\Photo Date Rescue\
// (the productName-based folder customers see in packaged builds)
// instead of relying on Electron's runtime app-name resolution.
//
// Why this matters: settings-store.ts is imported from main.ts ABOVE
// the `app.setName('Photo Date Rescue')` call (because ES-module
// imports are hoisted and run before any code in the importing file).
// At Store-construction time, app.getName() therefore returns
// whatever Electron resolved as the default — which in dev mode
// flips between "Electron" (Electron's hard fallback) and
// "photo-date-rescue" (the lowercase npm `name` field) depending on
// context. The Store's userData path locks in at construction, so
// without this override the settings file lands in DIFFERENT folders
// across launches and the user's destinationPath / scanner overrides
// / pmOpenDays appear to "vanish" between sessions.
//
// app.getPath('appData') resolves to the OS-level Roaming/AppData
// directory (Windows: %APPDATA%, macOS: ~/Library/Application
// Support, Linux: ~/.config) — independent of app-name resolution
// and safe to call before `app.ready`. Joining 'Photo Date Rescue'
// gives us the same path the packaged installer uses, so dev mode
// and production share one settings file.
const SETTINGS_DIR = path.join(app.getPath('appData'), 'Photo Date Rescue');
const store = new Store({
    name: 'pdr-settings',
    defaults: optimisedDefaults,
    cwd: SETTINGS_DIR,
});
export function getSettings() {
    return {
        skipDuplicates: store.get('skipDuplicates', optimisedDefaults.skipDuplicates),
        thoroughDuplicateMatching: store.get('thoroughDuplicateMatching', optimisedDefaults.thoroughDuplicateMatching),
        writeExif: store.get('writeExif', optimisedDefaults.writeExif),
        exifWriteConfirmed: store.get('exifWriteConfirmed', optimisedDefaults.exifWriteConfirmed),
        exifWriteRecovered: store.get('exifWriteRecovered', optimisedDefaults.exifWriteRecovered),
        exifWriteMarked: store.get('exifWriteMarked', optimisedDefaults.exifWriteMarked),
        showStoragePerformanceTips: store.get('showStoragePerformanceTips', optimisedDefaults.showStoragePerformanceTips),
        rememberSources: store.get('rememberSources', optimisedDefaults.rememberSources),
        clearSourcesAfterFix: store.get('clearSourcesAfterFix', optimisedDefaults.clearSourcesAfterFix),
        aiEnabled: store.get('aiEnabled', optimisedDefaults.aiEnabled),
        aiFaceDetection: store.get('aiFaceDetection', optimisedDefaults.aiFaceDetection),
        aiObjectTagging: store.get('aiObjectTagging', optimisedDefaults.aiObjectTagging),
        aiAutoProcess: store.get('aiAutoProcess', optimisedDefaults.aiAutoProcess),
        aiMinFaceConfidence: store.get('aiMinFaceConfidence', optimisedDefaults.aiMinFaceConfidence),
        aiMinTagConfidence: store.get('aiMinTagConfidence', optimisedDefaults.aiMinTagConfidence),
        aiVisualSuggestions: store.get('aiVisualSuggestions', optimisedDefaults.aiVisualSuggestions),
        aiRefineFromVerified: store.get('aiRefineFromVerified', optimisedDefaults.aiRefineFromVerified),
        autoSaveCatalogue: store.get('autoSaveCatalogue', optimisedDefaults.autoSaveCatalogue),
        showManualReportExports: store.get('showManualReportExports', optimisedDefaults.showManualReportExports),
        matchThreshold: store.get('matchThreshold', optimisedDefaults.matchThreshold),
        aiSearchMatchThreshold: store.get('aiSearchMatchThreshold', optimisedDefaults.aiSearchMatchThreshold),
        aiSearchMatchMode: store.get('aiSearchMatchMode', optimisedDefaults.aiSearchMatchMode),
        openPeopleOnStartup: store.get('openPeopleOnStartup', optimisedDefaults.openPeopleOnStartup),
        pmOpenDays: store.get('pmOpenDays', optimisedDefaults.pmOpenDays),
        pmStartupPromptDismissed: store.get('pmStartupPromptDismissed', optimisedDefaults.pmStartupPromptDismissed),
        scannerOverrides: store.get('scannerOverrides', optimisedDefaults.scannerOverrides),
        networkUploadMode: store.get('networkUploadMode', optimisedDefaults.networkUploadMode),
        bypassLargeZipPreExtract: store.get('bypassLargeZipPreExtract', optimisedDefaults.bypassLargeZipPreExtract),
        destinationPath: store.get('destinationPath', optimisedDefaults.destinationPath),
    };
}
// ─── Scanner override helpers ────────────────────────────────────────────────
function normaliseOverrideKey(make, model) {
    return {
        make: (make || '').trim().toLowerCase(),
        model: (model || '').trim().toLowerCase(),
    };
}
/**
 * Look up a user-set scanner override for a given camera Make/Model.
 * Returns true/false/null — null means "no override, let the built-in rule
 * decide". This is imported by the scanner-detection pipeline so overrides
 * sit in front of the regex rules without duplicating the lookup logic.
 */
export function getScannerOverride(make, model) {
    const key = normaliseOverrideKey(make || '', model || '');
    if (!key.make && !key.model)
        return null;
    const list = store.get('scannerOverrides', []);
    const hit = list.find(o => o.make === key.make && o.model === key.model);
    return hit ? hit.isScanner : null;
}
/**
 * Add or replace a scanner override for a camera Make/Model pair. Returns
 * the updated list so the renderer can refresh its view.
 */
export function setScannerOverride(make, model, isScanner) {
    const key = normaliseOverrideKey(make, model);
    const list = store.get('scannerOverrides', []).filter(o => !(o.make === key.make && o.model === key.model));
    list.push({ make: key.make, model: key.model, isScanner, addedAt: new Date().toISOString() });
    store.set('scannerOverrides', list);
    return list;
}
/** Remove any override for a Make/Model pair so the built-in rule decides again. */
export function clearScannerOverride(make, model) {
    const key = normaliseOverrideKey(make, model);
    const list = store.get('scannerOverrides', []).filter(o => !(o.make === key.make && o.model === key.model));
    store.set('scannerOverrides', list);
    return list;
}
export function listScannerOverrides() {
    return store.get('scannerOverrides', []);
}
export function setSetting(key, value) {
    store.set(key, value);
}
export function setSettings(settings) {
    Object.entries(settings).forEach(([key, value]) => {
        store.set(key, value);
    });
}
export function resetCriticalSettings() {
    store.set('skipDuplicates', true);
}
export function resetToOptimisedDefaults() {
    Object.entries(optimisedDefaults).forEach(([key, value]) => {
        store.set(key, value);
    });
}
