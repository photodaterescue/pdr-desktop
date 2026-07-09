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
  /** v2.0.15 Phase 3c (Terry 2026-06-06) — default mode pre-selected
   *  in the PDR Viewer's Enhance Save panel. 'new' = the safe path
   *  (writes a sibling _E file, original untouched) and is the
   *  default; 'replace' is for power users who want to overwrite
   *  the original in place. The radio in Settings only changes
   *  WHICH button is highlighted on panel open; the user can
   *  always click the other one per-save. */
  viewerEnhanceSaveDefault: 'new' | 'replace';
  /** v2.0.15 Phase 7 (Terry 2026-06-06) — set to true after the user
   *  ticks "Don't show this again" on the AI Enhance slider-reset
   *  warning. Once true, the warning modal is skipped on subsequent
   *  AI presses (sliders still reset — the warning is just hidden). */
  viewerEnhanceAiWarningDismissed: boolean;
  /** v2.1 (Terry 2026-06-08) — Global "Hide captions" privacy toggle.
   *  When true, every PDR surface that displays caption text or
   *  the gold caption badge hides them (Memories tile badges,
   *  Albums tile badges, PDRV caption bar, S&D result captions).
   *  Applies to BOTH photos and videos that have user-added
   *  captions. The captions themselves remain in the DB — this
   *  is purely a render-time switch the user flips when sharing
   *  their screen or showing PDR to family. Default OFF. */
  hideCaptions: boolean;
  /** v2.1 (Terry 2026-06-08) — Global "Hide video transcripts"
   *  privacy toggle. Separate from hideCaptions because Whisper-
   *  generated dialogue transcripts are a different kind of
   *  caption (derived from audio, not user-added). When true,
   *  the PDR Viewer's CC button + caption overlay are suppressed
   *  for videos regardless of per-video CC state. The transcripts
   *  + .vtt sidecars remain on disk. Default OFF. */
  hideVideoTranscripts: boolean;
  /** v2.1 round 27 (Terry 2026-06-08) — caption text size on
   *  videos in PDR Viewer. Three discrete sizes so the user can
   *  match the captions to their viewing distance / vision /
   *  accessibility needs without an awkward pixel slider:
   *    'small'  — 14px (compact, less screen real estate)
   *    'medium' — 18px (default — matches the previous hardcoded value)
   *    'large'  — 24px (high-readability / accessibility)
   *  Live-applied via the settings:changed broadcast so the user
   *  sees the new size immediately without re-opening the video. */
  videoCaptionSize: 'small' | 'medium' | 'large';
  /** v2.0.15 (Terry 2026-06-06 round 3) — whether the PDR Viewer's
   *  slideshow should include videos. Default false because a 30-second
   *  video derails a "browse my photos" rhythm; users who want videos
   *  in the slideshow opt in. When true, the slideshow loads the video
   *  on its tick and pauses auto-advance until the video ends. */
  slideshowIncludeVideos: boolean;

  /** When true, the titlebar's Recycle Bin icon shows a small live
   *  count badge of how many items are sitting in the bin. Default
   *  OFF — the count is always available in the hover tooltip, and
   *  an always-visible number at icon scale reads as clutter for
   *  most users. Power users who want at-a-glance "anything to
   *  empty?" visibility can flip this on in Settings → General. */
  recycleBinShowCountBadge: boolean;
  /** v2.1 (Terry 2026-06-11) — global hotkey for "take a screenshot
   *  straight into the library". Electron accelerator string,
   *  registered system-wide via globalShortcut so it works even when
   *  PDR is minimised or behind other windows (that's the point — the
   *  user is looking at the thing they want to capture, not at PDR).
   *  Default Ctrl+Shift+S (Terry's pick — sits next to the OS's
   *  Win+Shift+S snip muscle-memory). Remappable in Settings →
   *  Capture. When registration fails (another app owns the combo)
   *  we log + surface it in Settings; the title-bar camera button
   *  keeps working regardless. */
  captureHotkey: string;
  /** v2.1 step 2 (Terry 2026-06-11) — what the global capture hotkey
   *  DOES. 'region' (default since round 125 — Terry pressed the
   *  hotkey expecting to select an area; Win+Shift+S muscle-memory
   *  agrees) freezes the screen and opens the click-a-window /
   *  drag-to-select overlay. 'fullscreen' grabs the whole display
   *  under the cursor instantly. The title-bar camera menu always
   *  offers both verbs regardless of this setting. */
  captureHotkeyAction: 'fullscreen' | 'region';
  /** v2.1 round 124 (Terry 2026-06-11) — file format screenshots are
   *  saved in. 'png' (default) is lossless — text and UI stay
   *  razor-sharp, files are larger. 'jpg' is ~5-10× smaller at
   *  quality 92 — right for photo-heavy screens, slight softening
   *  on fine text. Applies to both full-screen and region captures;
   *  recordings (later step) have their own format story (MP4). */
  captureFormat: 'png' | 'jpg';
  /** v2.1 round 125 (Terry 2026-06-11) — include system audio (what
   *  the computer is playing: calls, videos, music) in screen
   *  recordings. Windows captures this natively via desktop loopback
   *  — no virtual audio driver needed. Default ON; flip off for
   *  silent recordings. Microphone capture is a separate later
   *  feature (needs a device picker). */
  captureRecordAudio: boolean;
  /** v2.1 round 126 (Terry 2026-06-12) — recording quality preset.
   *  Drives BOTH the live capture bitrate and the save-time H.264
   *  quality: 'high' = 12 Mbps / crf 19 (crisper, larger, slower
   *  save), 'standard' = 8 Mbps / crf 21 (the round-125 behaviour),
   *  'compact' = 4 Mbps / crf 26 (smallest files, softer fine
   *  detail, fastest save). Applies to recordings started AFTER the
   *  change. */
  captureRecordQuality: 'high' | 'standard' | 'compact' | 'tiny';   // v3.1 (Terry) — + tiny (smallest files)
  /** v2.1 round 128 (Terry 2026-06-12) — camera bubble for screen
   *  recordings (tutorial picture-in-picture). The bubble is a real
   *  always-on-top window on the recorded display, deliberately NOT
   *  content-protected — it appears in the footage because it's on
   *  the screen, no compositing needed. When ON, it fades in when a
   *  recording starts; the widget's Cam button and the cam hotkey
   *  toggle it mid-recording (with fade in/out). Default OFF — no
   *  surprise camera. */
  captureCamEnabled: boolean;
  /** Bubble shape: 'circle' (the tutorial classic — Terry's pick) or
   *  'rectangle' (the usual camera frame). Read when the bubble is
   *  created (recording start / first toggle-on). */
  captureCamShape: 'circle' | 'rectangle';
  /** Camera deviceId ('' = system default camera). Populated from
   *  the device dropdown in Settings → Capture. */
  captureCamDevice: string;
  /** v3.1 (Terry) — camera VIRTUAL BACKGROUND for the bubble (no greenscreen; on-device person
   *  segmentation). type: 'none' | 'blur' | 'gradient' (value = preset id) | 'image' (value = file
   *  path). Picked from the recording bar's Background dropdown; applied live + on bubble start. */
  captureCamBg: { type: string; value?: string };
  /** v3.1 (Terry) — SECOND camera deviceId ('' = auto: the first camera that isn't cam 1's). */
  captureCam2Device: string;
  /** v3.1 (Terry) — bubble size presets (S/M/L), cycled from each bubble's hover ⤢ button. */
  captureCamSize: 's' | 'm' | 'l';
  captureCam2Size: 's' | 'm' | 'l';
  /** Global hotkey that shows/hides the camera bubble — registered
   *  ONLY while a recording is running, so it never squats on the
   *  combo outside recordings. Same remap UI as the screenshot
   *  hotkey. */
  captureCamHotkey: string;
  /** v3.0 round 410 (Terry 2026-06-24) — record the MICROPHONE (voiceover)
   *  alongside system audio. When ON, the recording widget captures the
   *  chosen mic and BLENDS it with the system loopback into one track.
   *  Default OFF. Mirrors the cam device-picker pattern. */
  captureMicEnabled: boolean;
  /** Microphone deviceId ('' = system default mic). Chosen from the Mic
   *  dropdown on the recording bar; persisted for future recordings. */
  captureMicDevice: string;
  /** v3.0 round 411 (Terry 2026-06-24) — CLICK-RIPPLE: draw an expanding ring
   *  wherever you click during a recording (so tutorial viewers can follow the
   *  cursor). A transparent click-through overlay on the recorded display, filmed
   *  like the cam bubble; click positions come from a global mouse hook. Default OFF. */
  captureRippleEnabled: boolean;
  /** v3.0 round 485 (Terry) — AUTO-ZOOM toward clicks: when ON, each click during a
   *  recording opens an automatic zoom moment toward where you clicked (eases in, holds,
   *  eases back out when you pause). Applied at save by the same zoompan stage as manual
   *  zoom — zero live cost. Reuses the click-ripple global mouse hook. Default OFF. */
  captureAutoZoomEnabled: boolean;
  /** v2.1 round 162 (Terry 2026-06-13) — when ON (default), every saved
   *  collage is added to a "PDR Collages" album so they're gathered in one
   *  place. Toggle OFF in Settings → Capture to keep saved collages out of
   *  that album (they still save to the library exactly as before). */
  saveCollagesToAlbum: boolean;
  /** v2.1 round 167 (Terry 2026-06-14) — show the PDR-branded tooltips in the
   *  main app (React IconTooltip). ON by default (helps the learning curve);
   *  turn OFF in Settings → General once you know your way around. v2.1 round
   *  170 — split: this now covers the REST of PDR; the Viewer/Collage editor
   *  has its own showViewerTooltips below. */
  showTooltips: boolean;
  /** v2.1 round 170 (Terry 2026-06-14) — show tooltips inside the Viewer &
   *  Collage editor (the data-pdr-tooltip manager in viewer.html). Split from
   *  showTooltips so the editor tips (which pop while you work) can be turned
   *  off independently of the rest of PDR. ON by default. Lives in the new
   *  Settings → Viewer & Collage category. */
  showViewerTooltips: boolean;
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

  /** ISO timestamp the user dismissed the low-RAM advisory. Surfaced
   *  on Dashboard once when totalmem < 6 GB, then never again unless
   *  cleared. Customers on budget laptops (Pentium / Celeron / 4 GB)
   *  hit out-of-memory failures on 50 GB Takeouts; the advisory tells
   *  them upfront to split the Takeout into smaller pieces in Google's
   *  Takeout settings. v2.0.7 (Kathr 2026-05-16). */
  lowRamAdvisoryDismissedAt: string | null;

  /** ISO timestamp the user dismissed or acted on the unindexed-
   *  libraries banner. v2.0.9 catch-up indexer auto-sets this on
   *  click-to-index so the banner doesn't re-appear next launch.
   *  Cleared automatically by the post-indexer refresh once the
   *  on-disk vs indexed counts re-equalise. */
  unindexedLibrariesDismissedAt: string | null;

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
  // v2.0.15 Phase 3c — default to the safe "new file" path so an
  // accidental click doesn't overwrite the original.
  viewerEnhanceSaveDefault: 'new',
  // v2.0.15 Phase 7 — default false; the warning shows on the FIRST
  // AI Enhance press so the user understands the slider reset, then
  // can dismiss it forever via the don't-show-again checkbox.
  viewerEnhanceAiWarningDismissed: false,
  hideCaptions: false,
  hideVideoTranscripts: false,
  videoCaptionSize: 'medium',
  // v2.0.15 — slideshow skips videos by default. Toggle on for users
  // who want videos in the slideshow (advances when the video ends).
  slideshowIncludeVideos: false,
  recycleBinShowCountBadge: false,
  // v2.1 — screenshot-to-library global hotkey (Settings → Capture).
  captureHotkey: 'Ctrl+Shift+S',
  // v2.1 step 2 — hotkey takes the full screen by default; 'region'
  // opens the drag-to-select overlay instead. Button menu has both.
  // v2.1 round 125 — region default (was fullscreen): Terry pressed
  // the hotkey expecting area-select; matches Win+Shift+S instinct.
  captureHotkeyAction: 'region',
  // v2.1 round 124 — PNG default: lossless, sharp text.
  captureFormat: 'png',
  // v2.1 round 125 — system audio in recordings by default.
  captureRecordAudio: true,
  // v2.1 round 126 — balanced quality/size/save-speed default.
  captureRecordQuality: 'standard',
  // v2.1 round 128 — camera bubble defaults: off until asked for,
  // circle (the tutorial classic), system-default camera.
  captureCamEnabled: false,
  captureCamShape: 'circle',
  captureCamDevice: '',
  captureCamBg: { type: 'none' },
  captureCam2Device: '',
  captureCamSize: 'm',
  captureCam2Size: 'm',
  captureCamHotkey: 'Ctrl+Shift+C',
  // v3.0 round 410 — microphone/voiceover off until asked for, system-default mic.
  captureMicEnabled: false,
  captureMicDevice: '',
  // v3.0 round 411 — click-ripple off until asked for.
  captureRippleEnabled: false,
  // v3.0 round 485 — auto-zoom toward clicks off until asked for.
  captureAutoZoomEnabled: false,
  // v2.1 round 162 — saved collages join a "PDR Collages" album by default.
  saveCollagesToAlbum: true,
  // v2.1 round 167 — tooltips on by default (helps the learning curve).
  showTooltips: true,
  // v2.1 round 170 — Viewer/Collage editor tooltips on by default.
  showViewerTooltips: true,
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
  lowRamAdvisoryDismissedAt: null,
  unindexedLibrariesDismissedAt: null,
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
    viewerEnhanceSaveDefault: store.get('viewerEnhanceSaveDefault', optimisedDefaults.viewerEnhanceSaveDefault),
    viewerEnhanceAiWarningDismissed: store.get('viewerEnhanceAiWarningDismissed', optimisedDefaults.viewerEnhanceAiWarningDismissed),
    hideCaptions: store.get('hideCaptions', optimisedDefaults.hideCaptions),
    hideVideoTranscripts: store.get('hideVideoTranscripts', optimisedDefaults.hideVideoTranscripts),
    videoCaptionSize: store.get('videoCaptionSize', optimisedDefaults.videoCaptionSize),
    slideshowIncludeVideos: store.get('slideshowIncludeVideos', optimisedDefaults.slideshowIncludeVideos),
    recycleBinShowCountBadge: store.get('recycleBinShowCountBadge', optimisedDefaults.recycleBinShowCountBadge),
    captureHotkey: store.get('captureHotkey', optimisedDefaults.captureHotkey),
    captureHotkeyAction: store.get('captureHotkeyAction', optimisedDefaults.captureHotkeyAction),
    captureFormat: store.get('captureFormat', optimisedDefaults.captureFormat),
    captureRecordAudio: store.get('captureRecordAudio', optimisedDefaults.captureRecordAudio),
    captureRecordQuality: store.get('captureRecordQuality', optimisedDefaults.captureRecordQuality),
    captureCamEnabled: store.get('captureCamEnabled', optimisedDefaults.captureCamEnabled),
    captureCamShape: store.get('captureCamShape', optimisedDefaults.captureCamShape),
    captureCamDevice: store.get('captureCamDevice', optimisedDefaults.captureCamDevice),
    captureCamBg: store.get('captureCamBg', optimisedDefaults.captureCamBg),
    captureCam2Device: store.get('captureCam2Device', optimisedDefaults.captureCam2Device),
    captureCamSize: store.get('captureCamSize', optimisedDefaults.captureCamSize),
    captureCam2Size: store.get('captureCam2Size', optimisedDefaults.captureCam2Size),
    captureCamHotkey: store.get('captureCamHotkey', optimisedDefaults.captureCamHotkey),
    captureMicEnabled: store.get('captureMicEnabled', optimisedDefaults.captureMicEnabled),
    captureMicDevice: store.get('captureMicDevice', optimisedDefaults.captureMicDevice),
    captureRippleEnabled: store.get('captureRippleEnabled', optimisedDefaults.captureRippleEnabled),
    captureAutoZoomEnabled: store.get('captureAutoZoomEnabled', optimisedDefaults.captureAutoZoomEnabled),
    saveCollagesToAlbum: store.get('saveCollagesToAlbum', optimisedDefaults.saveCollagesToAlbum),
    showTooltips: store.get('showTooltips', optimisedDefaults.showTooltips),
    showViewerTooltips: store.get('showViewerTooltips', optimisedDefaults.showViewerTooltips),
    pmOpenDays: store.get('pmOpenDays', optimisedDefaults.pmOpenDays),
    pmStartupPromptDismissed: store.get('pmStartupPromptDismissed', optimisedDefaults.pmStartupPromptDismissed),
    scannerOverrides: store.get('scannerOverrides', optimisedDefaults.scannerOverrides),
    networkUploadMode: store.get('networkUploadMode', optimisedDefaults.networkUploadMode),
    bypassLargeZipPreExtract: store.get('bypassLargeZipPreExtract', optimisedDefaults.bypassLargeZipPreExtract),
    destinationPath: store.get('destinationPath', optimisedDefaults.destinationPath),
    autoIndexAfterFix: store.get('autoIndexAfterFix', optimisedDefaults.autoIndexAfterFix),
    lastDbBackupAt: store.get('lastDbBackupAt', optimisedDefaults.lastDbBackupAt),
    dbBackupReminderSnoozedAt: store.get('dbBackupReminderSnoozedAt', optimisedDefaults.dbBackupReminderSnoozedAt),
    lowRamAdvisoryDismissedAt: store.get('lowRamAdvisoryDismissedAt', optimisedDefaults.lowRamAdvisoryDismissedAt),
    unindexedLibrariesDismissedAt: store.get('unindexedLibrariesDismissedAt', optimisedDefaults.unindexedLibrariesDismissedAt),
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

// v2.0.15 (Terry 2026-06-04) — "Reset to Optimised Defaults" is a
// USABILITY reset, never a library-data reset. Before this audit,
// the function below iterated EVERY key in optimisedDefaults and
// wrote the default value back — silently destroying user data the
// "defaults" struct held the seed-value for. Concrete losses
// observed in Terry's session before the audit:
//   • destinationPath → null   — disconnected the active Library Drive
//   • scannerOverrides → []    — wiped every per-camera scanner-or-not
//                                decision the user had curated
//   • pmOpenDays → []          — wiped People Manager startup days
//   • pmStartupPromptDismissed → false — re-surfaced a dismissed prompt
//   • lastDbBackupAt → null    — destroyed backup-history timestamp
//   • *DismissedAt → null      — re-surfaced advisories the user had
//                                acknowledged (low RAM, unindexed
//                                libraries, DB-backup snooze)
// None of those are "defaults" — they're user data or user history.
//
// Fix: an explicit USER_DATA_KEYS denylist that resetToOptimisedDefaults
// skips. Adding a new user-data setting in future requires adding its
// key here at the same time — otherwise the next "Reset to Optimised
// Defaults" click would wipe it. The denylist sits next to the
// function so it's hard to miss when reading the reset path.
const USER_DATA_KEYS = new Set<keyof PDRSettings>([
  'destinationPath',
  'scannerOverrides',
  'pmOpenDays',
  'pmStartupPromptDismissed',
  'lastDbBackupAt',
  'dbBackupReminderSnoozedAt',
  'lowRamAdvisoryDismissedAt',
  'unindexedLibrariesDismissedAt',
]);

export function resetToOptimisedDefaults(): void {
  Object.entries(optimisedDefaults).forEach(([key, value]) => {
    if (USER_DATA_KEYS.has(key as keyof PDRSettings)) return;
    store.set(key as keyof PDRSettings, value);
  });
}