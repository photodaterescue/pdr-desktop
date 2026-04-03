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
