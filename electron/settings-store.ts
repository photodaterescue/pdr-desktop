import Store from 'electron-store';

export interface PDRSettings {
  // Duplicate handling
  skipDuplicates: boolean;
  thoroughDuplicateMatching: boolean;
  
  // EXIF writing master toggle
  writeExif: boolean;
  
  // EXIF writing scoped options (only apply when writeExif is true)
  exifWriteConfirmed: boolean;
  exifWriteRecovered: boolean;
  exifWriteMarked: boolean;
  
  // Storage performance tips
  showStoragePerformanceTips: boolean;

  // Source persistence
  rememberSources: boolean;
  clearSourcesAfterFix: boolean;

  // AI Photo Analysis
  aiEnabled: boolean;
  aiFaceDetection: boolean;
  aiObjectTagging: boolean;
  aiAutoProcess: boolean;
  aiMinFaceConfidence: number;
  aiMinTagConfidence: number;
  aiVisualSuggestions: boolean;

  // Auto-catalogue
  autoSaveCatalogue: boolean;
  showManualReportExports: boolean;

  // People Manager
  matchThreshold: number;
}

// Optimised defaults - safe configuration for most users
export const optimisedDefaults: PDRSettings = {
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
  // Auto-catalogue — cumulative CSV/TXT at destination root
  autoSaveCatalogue: true,
  showManualReportExports: false,
  matchThreshold: 0.72,
};

const store = new Store<PDRSettings>({
  name: 'pdr-settings',
  defaults: optimisedDefaults,
});

export function getSettings(): PDRSettings {
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
    autoSaveCatalogue: store.get('autoSaveCatalogue', optimisedDefaults.autoSaveCatalogue),
    showManualReportExports: store.get('showManualReportExports', optimisedDefaults.showManualReportExports),
    matchThreshold: store.get('matchThreshold', optimisedDefaults.matchThreshold),
  };
}

export function setSetting<K extends keyof PDRSettings>(key: K, value: PDRSettings[K]): void {
  store.set(key, value);
}

export function setSettings(settings: Partial<PDRSettings>): void {
  Object.entries(settings).forEach(([key, value]) => {
    store.set(key as keyof PDRSettings, value);
  });
}

export function resetCriticalSettings(): void {
  store.set('skipDuplicates', true);
}

export function resetToOptimisedDefaults(): void {
  Object.entries(optimisedDefaults).forEach(([key, value]) => {
    store.set(key as keyof PDRSettings, value);
  });
}