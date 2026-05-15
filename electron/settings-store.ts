import Store from 'electron-store';
import { app } from 'electron';
import * as path from 'path';

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
  aiRefineFromVerified: boolean;

  // Auto-catalogue
  autoSaveCatalogue: boolean;
  showManualReportExports: boolean;

  // People Manager
  matchThreshold: number;
  /** S&D-side match threshold for face matching, independent of PM's
   *  clustering threshold above. Drives the score cutoff inside
   *  refineFromVerifiedFaces (was hardcoded 0.72) so the user can
   *  trade recall for precision without re-clustering everything in
   *  PM. Default 0.72 — same as the previous hardcoded value, so
   *  existing behaviour is unchanged until the slider is touched. */
  aiSearchMatchThreshold: number;
  /** S&D filter mode when the user picks people to search by:
   *    'ai'       — include any face the AI has linked to that person
   *                 (verified + auto-matched via refineFromVerifiedFaces)
   *    'verified' — only photos where the user explicitly confirmed
   *                 the face (face_detections.verified = 1)
   *  Defaults to 'ai' — preserves existing behaviour. */
  aiSearchMatchMode: 'ai' | 'verified';
  /** When true, the People Manager window auto-opens alongside the
   *  main PDR window on launch. Default off — users who rely on PM
   *  daily can opt in once to skip the manual open every session. */
  openPeopleOnStartup: boolean;
  /** Calendar days (YYYY-MM-DD) on which the user has opened People
   *  Manager. Used to decide when to surface the "open PM on startup"
   *  onboarding banner — only show it once adoption is real, not on
   *  a user's first curious click. */
  pmOpenDays: string[];
  /** Once true, the "open PM on startup" onboarding banner is never
   *  shown again regardless of open counts. Set when the user either
   *  enables the setting from the banner or explicitly dismisses it. */
  pmStartupPromptDismissed: boolean;

  /** When true, the analysis pipeline bypasses the >2 GB pre-extract
   *  path and runs every zip through the streaming `unzipper` engine
   *  regardless of size. Used as a release-gate test before deciding
   *  whether the pre-extract path can be retired entirely. Default off
   *  — current production behaviour preserved. Surfaced as a toggle
   *  in Settings → Advanced ("Bypass large-zip pre-extract") so we
   *  can flip it without rebuilding for QA runs against real 50 GB
   *  Google Takeouts. */
  bypassLargeZipPreExtract: boolean;

  /** Auto-index Fixed files for Search & Discovery. When ON (default),
   *  every Fix run that completes is followed by indexFixRun, which
   *  writes rows into the search DB's `indexed_files` table — making
   *  the files visible to S&D, Memories, People Manager, Date Editor
   *  and Trees. When OFF, the user must trigger indexing manually
   *  later (Re-index a folder action — v2.0.6 roadmap).
   *
   *  Replaces the old pre-Fix "Search & Discovery — Make fixed files
   *  searchable?" prompt that asked the user every run. Terry's
   *  framing (2026-05-14): Apple/Lightroom-style defaults — features
   *  just work, opt-out lives two layers deep for the rare power
   *  user. Avoids the previous failure mode where a single misclick
   *  on "No thanks" silently shut off five different surfaces. */
  autoIndexAfterFix: boolean;

  /** ISO timestamp of the most recent successful Download Library DB
   *  (or any other offsite DB backup we surface). Drives the
   *  persistent "Back up DB" pill on the LDM drive row + the
   *  periodic-reminder cadence. null until the user has backed up
   *  at least once. The pill renders as:
   *    - amber + attention when null (never backed up)
   *    - amber when older than 30 days
   *    - subtle green when within 30 days
   *  Updated by handleExportDb on success. */
  lastDbBackupAt: string | null;

  /** ISO timestamp the user dismissed the backup reminder. Reminder
   *  re-surfaces 30 days after this. null when never snoozed.
   *  Snoozing doesn't hide the pill (the pill is the always-visible
   *  affordance) — it only suppresses the post-Fix banner nudge. */
  dbBackupReminderSnoozedAt: string | null;

  /** Persisted Library Drive (destination) path. Sticky across sessions
   *  so users don't have to re-pick it on every launch — and so the
   *  Welcome screen can keep its app cards / Tour / Best Practices
   *  available the moment they return. null until the user picks one
   *  for the first time, or after they explicitly clear it. */
  destinationPath: string | null;

  /** Network-destination upload mode.
   *    'fast'   — stage to local temp, mirror to network with
   *               robocopy /MT:16 (5–10× faster on SMB shares).
   *    'direct' — legacy per-file fs.createReadStream loop. Slower
   *               but byte-for-byte identical to pre-Robocopy code.
   *               Kill switch if a NAS / SMB version doesn't get
   *               along with multi-threaded copies.
   *  Local destinations ignore this setting — they always use the
   *  direct path because fs.copyFile on a local disk is already
   *  syscall-fast and staging would just double the I/O. */
  networkUploadMode: 'fast' | 'direct';

  // User-curated scanner overrides. Each entry defines a per-camera
  // decision that trumps the automatic rule — key is the EXIF Make/Model
  // pair, value is whether that combination should be treated as a scanner
  // (and its photos demoted to Marked) or explicitly not.
  //   isScanner: true  → force-demote regardless of built-in rule
  //   isScanner: false → force-NOT-scanner, even if the built-in rule
  //                      would have demoted (false-positive escape hatch)
  scannerOverrides: ScannerOverride[];
}

export interface ScannerOverride {
  make: string;      // Stored lowercase-trimmed for comparison stability.
  model: string;
  isScanner: boolean;
  addedAt: string;   // ISO timestamp so we can show a history later if useful.
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
  // Auto-index after Fix — Apple-style smart default. ON so every
  // Fix run feeds the search DB; user can opt out in Settings → S&D.
  autoIndexAfterFix: true,
  lastDbBackupAt: null,
  dbBackupReminderSnoozedAt: null,
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

const store = new Store<PDRSettings>({
  name: 'pdr-settings',
  defaults: optimisedDefaults,
  cwd: SETTINGS_DIR,
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
    autoIndexAfterFix: store.get('autoIndexAfterFix', optimisedDefaults.autoIndexAfterFix),
    lastDbBackupAt: store.get('lastDbBackupAt', optimisedDefaults.lastDbBackupAt),
    dbBackupReminderSnoozedAt: store.get('dbBackupReminderSnoozedAt', optimisedDefaults.dbBackupReminderSnoozedAt),
  };
}

// ─── Scanner override helpers ────────────────────────────────────────────────

function normaliseOverrideKey(make: string, model: string): { make: string; model: string } {
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
export function getScannerOverride(make: string | null | undefined, model: string | null | undefined): boolean | null {
  const key = normaliseOverrideKey(make || '', model || '');
  if (!key.make && !key.model) return null;
  const list = store.get('scannerOverrides', []) as ScannerOverride[];
  const hit = list.find(o => o.make === key.make && o.model === key.model);
  return hit ? hit.isScanner : null;
}

/**
 * Add or replace a scanner override for a camera Make/Model pair. Returns
 * the updated list so the renderer can refresh its view.
 */
export function setScannerOverride(make: string, model: string, isScanner: boolean): ScannerOverride[] {
  const key = normaliseOverrideKey(make, model);
  const list = (store.get('scannerOverrides', []) as ScannerOverride[]).filter(
    o => !(o.make === key.make && o.model === key.model)
  );
  list.push({ make: key.make, model: key.model, isScanner, addedAt: new Date().toISOString() });
  store.set('scannerOverrides', list);
  return list;
}

/** Remove any override for a Make/Model pair so the built-in rule decides again. */
export function clearScannerOverride(make: string, model: string): ScannerOverride[] {
  const key = normaliseOverrideKey(make, model);
  const list = (store.get('scannerOverrides', []) as ScannerOverride[]).filter(
    o => !(o.make === key.make && o.model === key.model)
  );
  store.set('scannerOverrides', list);
  return list;
}

export function listScannerOverrides(): ScannerOverride[] {
  return store.get('scannerOverrides', []) as ScannerOverride[];
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