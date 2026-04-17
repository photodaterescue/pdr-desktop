import Store from 'electron-store';
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
};
const store = new Store({
    name: 'pdr-settings',
    defaults: optimisedDefaults,
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
    };
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
