/**
 * v2.1 (Terry 2026-06-11) — Screen capture manager.
 *
 * Owns the "screenshot straight into the library" surface: the
 * desktopCapturer grab, PDR-window hide/restore choreography, the
 * region-selection overlay, file placement under
 * <LibraryRoot>\PDR Captures\YYYY-MM\, the pending fallback when the
 * Library Drive is disconnected, the global hotkey, and the
 * post-capture broadcasts that drive live view refresh + the renderer
 * toast.
 *
 * Deliberately NOT a Fix scenario (Terry's architectural call): a
 * capture is created inside PDR with an authoritative timestamp and a
 * known format, so it skips the Fix worker / source-add / analysis
 * entirely and lands via indexCapturedFile — the third sibling of the
 * Enhance-save / Clip-trim single-file upserts in search-database.
 *
 * Region flow (step 2) freezes the screen FIRST — the grab happens the
 * moment the user triggers, then a frameless always-on-top overlay
 * shows that frozen frame with a drag-to-select veil (Snipping-Tool
 * style). The crop is taken from the frozen buffer, so what the user
 * framed is exactly what lands in the library, and the overlay itself
 * can never appear in the shot.
 *
 * Windows-only first cut. Screen RECORDING (MediaRecorder → FFmpeg →
 * MP4) joins this module in a later step; stills don't need a renderer
 * media stream at all — desktopCapturer hands the main process a
 * full-resolution NativeImage directly.
 */
import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, nativeImage, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import log from 'electron-log/main.js';
import { toLongPath } from './long-path.js';
import { getLibraryStatus } from './library-sidecar.js';
import { getSettings, setSetting } from './settings-store.js';
import { indexCapturedFile } from './search-database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const esmRequire = createRequire(import.meta.url);

export interface CaptureDisplayInfo {
  id: string;
  label: string;
  width: number;
  height: number;
  isPrimary: boolean;
  thumbnailDataUrl: string;
}

export interface CaptureScreenshotResult {
  success: boolean;
  filePath?: string;
  filename?: string;
  fileId?: number | null;
  /** true when the Library Drive was offline and the PNG went to the
   *  AppData pending folder instead (flushed on reconnect). */
  pending?: boolean;
  /** Region flow only — the user dismissed the overlay (Esc / blur).
   *  Not an error; callers stay silent. */
  cancelled?: boolean;
  /** Button-triggered capture on a multi-monitor setup with no
   *  remembered choice — renderer should show the display picker and
   *  re-invoke with displayId. */
  needsDisplayPick?: boolean;
  displays?: CaptureDisplayInfo[];
  error?: string;
}

interface SelectionRect { x: number; y: number; width: number; height: number }

// Which display the user picked in this session's picker. Hotkey
// captures don't read or write this — they always take the display
// under the cursor (the thing the user is looking at).
let sessionDisplayId: string | null = null;

// Re-entrancy guard — a mashed hotkey must not stack hide/capture/
// restore cycles (or a second overlay) on top of an in-flight one.
// Held for the whole overlay lifetime during region capture, which
// also correctly blocks full-screen hotkey fires mid-selection.
let captureInFlight = false;

const PENDING_DIR_NAME = 'Captures-pending';

function pendingDir(): string {
  return path.join(app.getPath('userData'), PENDING_DIR_NAME);
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch { /* non-fatal */ }
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pad = (n: number) => String(n).padStart(2, '0');

function timestampParts(d: Date) {
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`,
    month: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
    isoLocal: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  };
}

/** Collision-safe target path: base name, then -2, -3, … */
function uniqueCapturePath(dir: string, baseName: string, ext: string): string {
  let candidate = path.join(dir, `${baseName}${ext}`);
  let n = 2;
  while (fs.existsSync(toLongPath(candidate))) {
    candidate = path.join(dir, `${baseName}-${n}${ext}`);
    n++;
    if (n > 999) throw new Error('Too many capture files with this timestamp.');
  }
  return candidate;
}

/** The attached Library Drive root, but only when it's actually
 *  reachable on disk right now (covers the disconnected-USB case). */
function onlineLibraryRoot(): string | null {
  try {
    const status = getLibraryStatus();
    const root = status?.libraryRoot ?? null;
    if (root && fs.existsSync(root)) return root;
  } catch { /* fall through */ }
  return null;
}

/**
 * Best-effort XMP stamp so the PNG is self-describing even outside
 * PDR (and a from-scratch index rebuild re-derives the right story).
 * Mirrors the viewer:saveEnhanced exiftool pattern — failure only
 * costs the embedded metadata, never the capture itself.
 */
async function stampCaptureMetadata(filePath: string, capturedAt: Date, kindLabel: string = 'screenshot'): Promise<void> {
  try {
    const { ExifTool } = await import('exiftool-vendored');
    const exiftoolPath = path.join(__dirname, 'bin', 'exiftool.exe');
    const exiftool = new ExifTool({
      exiftoolPath: fs.existsSync(exiftoolPath) ? exiftoolPath : undefined,
    });
    const { isoLocal } = timestampParts(capturedAt);
    try {
      const tags = {
        'XMP-xmp:CreateDate': isoLocal,
        'XMP-photoshop:DateCreated': isoLocal,
        'XMP-xmp:Label': 'PDR-Capture',
        'XMP-xmpMM:HistoryAction': 'created',
        'XMP-xmpMM:HistorySoftwareAgent': `Photo Date Rescue ${app.getVersion()} (${kindLabel})`,
        'XMP-xmpMM:HistoryWhen': isoLocal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      await exiftool.write(filePath, tags, ['-overwrite_original']);
    } finally {
      try { await exiftool.end(); } catch { /* non-fatal */ }
    }
  } catch (err) {
    log.warn(`[capture] XMP stamp failed (non-fatal): ${(err as Error).message}`);
  }
}

/**
 * All connected displays with small live thumbnails for the picker.
 * Thumbnails at 320px wide are plenty for "which screen is which".
 */
export async function listCaptureDisplays(): Promise<CaptureDisplayInfo[]> {
  // Round 130 (Terry) — the picker must mirror the PHYSICAL desk:
  // his left monitor was showing on the right because
  // getAllDisplays() enumerates in arbitrary order. Windows already
  // knows the arrangement (every display's virtual-desktop origin),
  // so sort by position — left → right, ties top → bottom — and
  // label by POSITION rather than enumeration number. If this still
  // reads backwards for a user, their Windows display arrangement
  // itself is swapped (Settings → System → Display) and fixing it
  // there fixes every app at once.
  const displays = [...screen.getAllDisplays()].sort((a, b) =>
    a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y,
  );
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 320 },
  });
  // Positional fallback for blank display_ids must use Electron's
  // ORIGINAL enumeration order (that's what sources align to).
  const enumOrder = screen.getAllDisplays();
  return displays.map((d, i) => {
    const source =
      sources.find((s) => s.display_id === String(d.id)) ??
      sources[enumOrder.findIndex((e) => e.id === d.id)];
    const positionName =
      displays.length === 2
        ? (i === 0 ? 'Left display' : 'Right display')
        : displays.length === 1
          ? 'Display'
          : `Display ${i + 1} (left to right)`;
    return {
      id: String(d.id),
      label: `${positionName}${d.id === screen.getPrimaryDisplay().id ? ' (primary)' : ''} — ${Math.round(d.bounds.width * d.scaleFactor)}×${Math.round(d.bounds.height * d.scaleFactor)}`,
      width: Math.round(d.bounds.width * d.scaleFactor),
      height: Math.round(d.bounds.height * d.scaleFactor),
      isPrimary: d.id === screen.getPrimaryDisplay().id,
      thumbnailDataUrl: source ? source.thumbnail.toDataURL() : '',
    };
  });
}

/**
 * Round 131 — the desktopCapturer source for one display (its id is
 * what the widget's getUserMedia needs). Thumbnails irrelevant here,
 * so request 1×1. Falls back to the sole source when display_ids are
 * blank (some Windows configs).
 */
async function getDisplaySource(display: Electron.Display): Promise<Electron.DesktopCapturerSource | null> {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  return (
    sources.find((s) => s.display_id === String(display.id)) ??
    (sources.length === 1 ? sources[0] : null)
  );
}

/**
 * Shared display resolution for both capture verbs.
 * - explicit displayId → that display (remembered for the session)
 * - hotkey → display under the cursor, never any UI
 * - button, one display → it; button, several + remembered → that;
 *   otherwise null = caller should return needsDisplayPick.
 */
function resolveTargetDisplay(opts: { displayId?: string; trigger: 'button' | 'hotkey' }):
  | { display: Electron.Display }
  | { error: string }
  | { pick: true } {
  const displays = screen.getAllDisplays();
  if (opts.displayId) {
    const display = displays.find((d) => String(d.id) === String(opts.displayId));
    if (!display) return { error: 'That display is no longer connected.' };
    sessionDisplayId = String(display.id);
    return { display };
  }
  if (opts.trigger === 'hotkey') {
    return { display: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) };
  }
  if (displays.length === 1) return { display: displays[0] };
  if (sessionDisplayId) {
    const remembered = displays.find((d) => String(d.id) === sessionDisplayId);
    if (remembered) return { display: remembered };
  }
  return { pick: true };
}

/**
 * Hide PDR's windows and grab the target display at native
 * resolution. The caller gets back a `restore()` it MUST invoke
 * (idempotent) — the full-screen verb restores immediately after the
 * grab; the region verb defers restore until the overlay window is
 * actually SHOWING, so PDR pops back exactly once behind the overlay
 * instead of flashing in and out before it (Terry's "few quick
 * flashes of windows changing" report, round 124).
 *
 * When `includeWindows` is set, the on-screen window rectangles are
 * enumerated IN THE SAME FROZEN MOMENT (PDR still hidden) so the
 * overlay's click-a-window snapping matches the frozen pixels
 * exactly. On a failed grab the windows are restored here before
 * returning null.
 */
async function grabDisplayPng(
  target: Electron.Display,
  opts?: { includeWindows?: boolean; hideWindows?: boolean },
): Promise<{ buffer: Buffer; width: number; height: number; windows: SelectionRect[]; restore: () => void } | null> {
  const toRestore: Array<{ win: BrowserWindow; focused: boolean }> = [];
  // hideWindows false = "grab the screen exactly as it stands" — used
  // by the mid-recording Snap button, where hiding PDR would put a
  // visible blip INTO the recording (round 126).
  if (opts?.hideWindows !== false) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.isVisible() && !win.isMinimized()) {
        toRestore.push({ win, focused: win.isFocused() });
      }
    }
  }
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const { win, focused } of toRestore) {
      if (win.isDestroyed()) continue;
      // showInactive for windows that weren't focused — restoring
      // a background PDR must not steal focus from the user's app.
      try { focused ? win.show() : win.showInactive(); } catch { /* non-fatal */ }
    }
  };
  try {
    for (const { win } of toRestore) {
      try { win.hide(); } catch { /* non-fatal */ }
    }
    if (toRestore.length > 0) {
      // Give the compositor a beat to actually drop the windows
      // from screen before we shoot.
      await sleep(280);
    }

    // Ask for the display's native pixel size — desktopCapturer
    // scales the "thumbnail" to fit the requested box, so requesting
    // bounds × scaleFactor returns a pixel-perfect full-res frame.
    const nativeW = Math.round(target.bounds.width * target.scaleFactor);
    const nativeH = Math.round(target.bounds.height * target.scaleFactor);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: nativeW, height: nativeH },
    });
    const source =
      sources.find((s) => s.display_id === String(target.id)) ??
      (sources.length === 1 ? sources[0] : undefined);
    if (!source || source.thumbnail.isEmpty()) {
      restore();
      return null;
    }
    const size = source.thumbnail.getSize();
    const windows = opts?.includeWindows ? enumerateWindowRectsForDisplay(target) : [];
    return { buffer: source.thumbnail.toPNG(), width: size.width, height: size.height, windows, restore };
  } catch (err) {
    restore();
    throw err;
  }
}

// ─── Snap-to-window enumeration (Win32 via koffi) ────────────────────────────

// Lazily-initialised Win32 bindings. koffi struct/proto names are
// process-global, so these MUST be defined exactly once. Any failure
// (koffi prebuilt missing, exotic Windows build) just disables
// snap-to-window — free-drag selection is unaffected.
interface WinApi {
  koffi: any;
  enumProto: any;
  EnumWindows: any;
  IsWindowVisible: any;
  IsIconic: any;
  GetWindowRect: any;
  DwmRect: any;
  DwmU32: any;
}
let winApi: WinApi | null = null;
let winApiFailed = false;

function initWinApi(): WinApi | null {
  if (winApi || winApiFailed) return winApi;
  try {
    const koffi = esmRequire('koffi');
    const user32 = koffi.load('user32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    koffi.struct('PdrRect', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    const enumProto = koffi.proto('bool PdrEnumWindowsProc(void *hwnd, intptr_t lParam)');
    winApi = {
      koffi,
      enumProto,
      EnumWindows: user32.func('bool __stdcall EnumWindows(PdrEnumWindowsProc *cb, intptr_t lParam)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *hwnd)'),
      IsIconic: user32.func('bool __stdcall IsIconic(void *hwnd)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ PdrRect *rect)'),
      // Same symbol declared twice with different out-param shapes —
      // DwmGetWindowAttribute is attribute-polymorphic (RECT for
      // EXTENDED_FRAME_BOUNDS(9), uint32 for CLOAKED(14)).
      DwmRect: dwmapi.func('long __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t attr, _Out_ PdrRect *pv, uint32_t cb)'),
      DwmU32: dwmapi.func('long __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t attr, _Out_ uint32_t *pv, uint32_t cb)'),
    };
  } catch (err) {
    winApiFailed = true;
    log.warn(`[capture] Win32 bindings unavailable — snap-to-window disabled (non-fatal): ${(err as Error).message}`);
  }
  return winApi;
}

/**
 * Top-down z-ordered rectangles of every real on-screen window
 * intersecting the target display, in the display's CSS pixels.
 * Called while PDR's own windows are hidden, so they self-exclude
 * via IsWindowVisible. Cloaked UWP ghosts are skipped; rects use
 * DWM extended frame bounds (no drop-shadow padding) with a
 * GetWindowRect fallback.
 */
function enumerateWindowRectsForDisplay(display: Electron.Display): SelectionRect[] {
  const api = initWinApi();
  if (!api) return [];
  const out: SelectionRect[] = [];
  const sf = display.scaleFactor || 1;
  const disp = {
    x: Math.round(display.bounds.x * sf),
    y: Math.round(display.bounds.y * sf),
    w: Math.round(display.bounds.width * sf),
    h: Math.round(display.bounds.height * sf),
  };
  try {
    const cb = api.koffi.register((hwnd: unknown) => {
      try {
        if (out.length >= 64) return false; // plenty — stop walking
        if (!api.IsWindowVisible(hwnd) || api.IsIconic(hwnd)) return true;
        const cloaked = [0];
        try {
          if (api.DwmU32(hwnd, 14, cloaked, 4) === 0 && cloaked[0] !== 0) return true;
        } catch { /* treat as not cloaked */ }
        const rect = { left: 0, top: 0, right: 0, bottom: 0 };
        let got = false;
        try { got = api.DwmRect(hwnd, 9, rect, 16) === 0; } catch { got = false; }
        if (!got || rect.right <= rect.left) {
          try { got = !!api.GetWindowRect(hwnd, rect); } catch { got = false; }
        }
        if (!got) return true;
        if (rect.right - rect.left < 48 || rect.bottom - rect.top < 48) return true;
        // Visible intersection with the target display only.
        const ix = Math.max(rect.left, disp.x);
        const iy = Math.max(rect.top, disp.y);
        const ix2 = Math.min(rect.right, disp.x + disp.w);
        const iy2 = Math.min(rect.bottom, disp.y + disp.h);
        if (ix2 - ix < 24 || iy2 - iy < 24) return true;
        out.push({
          x: Math.max(0, Math.round((ix - disp.x) / sf)),
          y: Math.max(0, Math.round((iy - disp.y) / sf)),
          width: Math.round((ix2 - ix) / sf),
          height: Math.round((iy2 - iy) / sf),
        });
      } catch { /* skip this window */ }
      return true;
    }, api.koffi.pointer(api.enumProto));
    try {
      api.EnumWindows(cb, 0);
    } finally {
      try { api.koffi.unregister(cb); } catch { /* non-fatal */ }
    }
  } catch (err) {
    log.warn(`[capture] window enumeration failed — snap-to-window disabled this capture: ${(err as Error).message}`);
    return [];
  }
  return out;
}

/**
 * Shared tail of every screenshot verb: place the PNG (library or
 * pending), stamp XMP, index, broadcast, log. The capture timestamp
 * is the FROZEN moment (when the grab happened), not when the user
 * finished dragging a region.
 */
async function persistCapture(
  pngBuffer: Buffer,
  capturedAt: Date,
  imgWidth: number | null,
  imgHeight: number | null,
  kind: 'screenshot' | 'region',
): Promise<CaptureScreenshotResult> {
  const { date, time, month } = timestampParts(capturedAt);
  const libRoot = onlineLibraryRoot();
  const destDir = libRoot
    ? path.join(libRoot, 'PDR Captures', month)
    : pendingDir();
  fs.mkdirSync(toLongPath(destDir), { recursive: true });

  // v2.1 round 124 (Terry 2026-06-11) — Settings → Capture format
  // choice. PNG (default) writes the grab verbatim; JPG re-encodes at
  // quality 92 for ~5-10× smaller files. A failed conversion falls
  // back to PNG rather than losing the capture.
  const format = (() => {
    try { return getSettings().captureFormat || 'png'; } catch { return 'png'; }
  })();
  let outBuffer = pngBuffer;
  let outExt = '.png';
  if (format === 'jpg') {
    try {
      const sharp = (await import('sharp')).default;
      outBuffer = await sharp(pngBuffer).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
      outExt = '.jpg';
    } catch (convErr) {
      log.warn(`[capture] JPG conversion failed — saving PNG instead (non-fatal): ${(convErr as Error).message}`);
      outBuffer = pngBuffer;
      outExt = '.png';
    }
  }

  // _SS suffix per Terry round 124 — two letters, matching the
  // _CF/_RC/_MK/_E family (recordings will be _SR). The rebuild
  // indexer's suffix reader knows _SS → confirmed + PDR-Capture.
  const outPath = uniqueCapturePath(destDir, `${date}_${time}_SS`, outExt);
  fs.writeFileSync(toLongPath(outPath), outBuffer);
  const filename = path.basename(outPath);

  // Self-describing metadata inside the PNG (best-effort).
  await stampCaptureMetadata(outPath, capturedAt);

  let fileId: number | null = null;
  if (libRoot) {
    try {
      fileId = await indexCapturedFile(outPath, libRoot, capturedAt, imgWidth, imgHeight, 'photo');
      if (fileId != null) {
        broadcast('library:filesAdded', { reason: 'capture', newFilePath: outPath, fileId });
      }
    } catch (idxErr) {
      log.warn(`[capture] index pass failed (file still saved): ${(idxErr as Error).message}`);
    }
    log.info(`[capture] ${kind} ${filename} (${imgWidth}×${imgHeight}) → library${fileId != null ? ` (file id ${fileId})` : ' (NOT indexed)'}`);
  } else {
    log.info(`[capture] ${kind} ${filename} → pending (Library Drive offline); will flush on reconnect`);
  }

  broadcast('capture:completed', {
    kind: 'screenshot',
    filePath: outPath,
    filename,
    fileId,
    pending: !libRoot,
    width: imgWidth,
    height: imgHeight,
  });

  return { success: true, filePath: outPath, filename, fileId, pending: !libRoot };
}

/**
 * Take a full-screen screenshot and land it in the library.
 */
export async function captureScreenshot(opts: {
  displayId?: string;
  trigger: 'button' | 'hotkey';
}): Promise<CaptureScreenshotResult> {
  if (captureInFlight) {
    return { success: false, error: 'A capture is already in progress.' };
  }
  captureInFlight = true;
  try {
    // Older pending captures ride along on the next capture attempt —
    // cheap eventual-consistency retry without a watcher. Fire and
    // forget; a slow flush must not delay THIS capture.
    void flushPendingCaptures().catch((err) =>
      log.warn(`[capture] inline pending flush failed (non-fatal): ${(err as Error).message}`),
    );

    const resolved = resolveTargetDisplay(opts);
    if ('error' in resolved) return { success: false, error: resolved.error };
    if ('pick' in resolved) {
      return { success: false, needsDisplayPick: true, displays: await listCaptureDisplays() };
    }

    const capturedAt = new Date();
    const grab = await grabDisplayPng(resolved.display);
    if (!grab) return { success: false, error: 'Could not capture the screen.' };
    // Full-screen verb: windows come back immediately — the slower
    // disk/exiftool/index work happens behind a visible app.
    grab.restore();

    return await persistCapture(grab.buffer, capturedAt, grab.width, grab.height, 'screenshot');
  } catch (err) {
    log.warn(`[capture] screenshot failed: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  } finally {
    captureInFlight = false;
  }
}

// ─── v2.1 round 303→306 (Terry) — collage "Take screenshot" = PREPARE → REGION ──
// Evolution: 303 grabbed a whole window (wrong — wanted just a picture in it); 304
// switched to a region grab but froze the CURRENT screen, so you couldn't first get
// to the right window/tab; 306 (Terry's pick) splits it in two — PREPARE then CAPTURE:
//   1) PREPARE — minimise the collage window + float a small "Capture region" bar so
//      the user can freely switch to the exact window and tab they want.
//   2) CAPTURE — on the bar's button, freeze that screen + run the SAME region overlay
//      as the title-bar Capture region (drag a box, click-a-window snap), crop, and add
//      the crop to the collage. The crop is a collage ingredient (NOT added to Library).
let prepBarWindow: BrowserWindow | null = null;
let prepResolve: ((go: boolean) => void) | null = null;
let prepMinimized: BrowserWindow | null = null;   // the collage window we minimised, to restore after

function closePrepBar(): void {
  if (prepBarWindow && !prepBarWindow.isDestroyed()) { try { prepBarWindow.close(); } catch { /* non-fatal */ } }
  prepBarWindow = null;
}
function restorePrepWindow(): void {
  // v2.1 round 312 (Terry) — Capture OR Cancel must both bring the collage straight back to the
  // FRONT. show()+focus() alone can leave it un-hidden but occluded (Windows blocks a background
  // app from taking the foreground), so use the always-on-top flip — set topmost, show/focus,
  // then drop topmost — which forces it above other windows without needing foreground rights.
  if (prepMinimized && !prepMinimized.isDestroyed()) {
    const w = prepMinimized;
    try {
      if (w.isMinimized()) w.restore();
      w.show();
      w.setAlwaysOnTop(true);
      w.focus();
      w.setAlwaysOnTop(false);
    } catch { /* non-fatal */ }
  }
  prepMinimized = null;
}

// v2.1 round 313 (Terry) — SHARED region-capture flow, used by BOTH the collage chevron and the
// title-bar "Capture region" (Terry: the title-bar one should match the collage one — no separate
// "which screen?" step). Hide the calling window so the user can navigate, float the prep bar,
// then the LIVE per-monitor overlay → drag/adjust → grab the chosen display → crop. Returns the
// cropped PNG + dims (or cancelled/error); callers persist it differently (collage tile vs Library).
async function regionCaptureWithPrep(
  callingWin: BrowserWindow | null,
): Promise<{ buffer: Buffer; width: number; height: number } | { cancelled: true } | { error: string }> {
  if (captureInFlight || prepBarWindow) return { error: 'A screenshot is already being set up.' };
  // ── PHASE 1: PREPARE ── hide the calling window so the user can navigate, then wait for
  // Capture/Cancel on the floating bar. HIDE (not minimise) — minimize/restore left it stuck on
  // Cancel; hide/show + the always-on-top flip reliably brings it back (round 312).
  prepMinimized = callingWin && !callingWin.isDestroyed() ? callingWin : null;
  if (prepMinimized) { try { prepMinimized.hide(); } catch { /* non-fatal */ } }
  const go = await new Promise<boolean>((resolve) => {
    prepResolve = resolve;
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const W = 470, H = 70;
    const bx = Math.round(disp.bounds.x + (disp.bounds.width - W) / 2);
    const by = Math.round(disp.bounds.y + disp.bounds.height - H - 56);
    const bar = new BrowserWindow({
      x: bx, y: by, width: W, height: H, frame: false, transparent: true, resizable: false,
      movable: true, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'capture-mini-preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    prepBarWindow = bar;
    try { bar.setAlwaysOnTop(true, 'screen-saver'); } catch { /* non-fatal */ }
    bar.once('closed', () => { const r = prepResolve; prepResolve = null; prepBarWindow = null; if (r) r(false); });
    bar.webContents.once('did-finish-load', () => { if (!bar.isDestroyed()) bar.showInactive(); });
    void bar.loadFile(path.join(__dirname, '../dist/public/capture-prep-bar.html'));
  });
  closePrepBar();
  if (!go) { restorePrepWindow(); return { cancelled: true }; }
  // ── PHASE 2: CAPTURE ── live per-monitor overlay (round 311 — one window PER screen, so the
  // 2nd monitor works and there's no "which screen?" step) → drag/adjust → grab + crop.
  captureInFlight = true;
  try {
    await sleep(160);   // let the prep bar fully disappear first
    const picked = await openMultiDisplayOverlay({ adjustable: true });
    if (!picked) { restorePrepWindow(); return { cancelled: true }; }
    const { rect, display } = picked;
    const grab = await grabDisplayPng(display, { hideWindows: false });
    if (!grab) { restorePrepWindow(); return { error: 'Could not capture the screen.' }; }
    grab.restore();
    const scaleX = grab.width / display.bounds.width, scaleY = grab.height / display.bounds.height;
    const x = Math.max(0, Math.min(grab.width - 1, Math.round(rect.x * scaleX)));
    const y = Math.max(0, Math.min(grab.height - 1, Math.round(rect.y * scaleY)));
    const width = Math.max(1, Math.min(grab.width - x, Math.round(rect.width * scaleX)));
    const height = Math.max(1, Math.min(grab.height - y, Math.round(rect.height * scaleY)));
    const cropped = nativeImage.createFromBuffer(grab.buffer).crop({ x, y, width, height });
    if (cropped.isEmpty()) { restorePrepWindow(); return { error: 'The selected area was empty.' }; }
    restorePrepWindow();   // bring the calling window back to the front
    return { buffer: cropped.toPNG(), width, height };
  } catch (err) {
    restorePrepWindow();
    log.warn(`[capture] region capture failed: ${(err as Error).message}`);
    return { error: (err as Error).message };
  } finally {
    captureInFlight = false;
  }
}

export async function captureCollageRegion(
  callingWin: BrowserWindow | null,
): Promise<{ success: boolean; filePath?: string; cancelled?: boolean; error?: string }> {
  const r = await regionCaptureWithPrep(callingWin);
  if ('cancelled' in r) return { success: false, cancelled: true };
  if ('error' in r) return { success: false, error: r.error };
  // Persist as a collage ingredient (not the Library).
  const dir = path.join(app.getPath('userData'), 'collage-captures');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* non-fatal */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `Screenshot_${stamp}.png`);
  fs.writeFileSync(toLongPath(filePath), r.buffer);
  return { success: true, filePath };
}

ipcMain.handle('collage:captureRegion', async (event) => {
  return await captureCollageRegion(BrowserWindow.fromWebContents(event.sender) || null);
});
// Floating prep-bar buttons resolve PHASE 1.
ipcMain.on('collage:prepCapture', () => { const r = prepResolve; prepResolve = null; if (r) r(true); });
ipcMain.on('collage:prepCancel', () => { const r = prepResolve; prepResolve = null; if (r) r(false); });

// ─── Region selection overlay ────────────────────────────────────────────────

let overlayWindow: BrowserWindow | null = null;
let overlayResolve: ((rect: SelectionRect | null) => void) | null = null;

// v2.1 round 311 (Terry) — MULTI-DISPLAY region capture: one overlay window PER monitor.
// Round 310's single window spanning all monitors didn't work — Terry couldn't select on his
// 2nd screen and the capture hung (a transparent window spanning displays is unreliable on
// Windows, esp. mixed VGA/DVI). Each window is single-screen; whichever one the user draws on
// wins, and the rect comes back in that display's own CSS pixels.
let multiOverlayWins: Array<{ win: BrowserWindow; display: Electron.Display }> = [];
let multiOverlayResolve: ((r: { rect: SelectionRect; display: Electron.Display } | null) => void) | null = null;

/** Resolve the pending overlay promise exactly once and tear the
 *  overlay window down. null = cancelled (Esc / blur / closed). */
function finishOverlay(rect: SelectionRect | null): void {
  const resolve = overlayResolve;
  overlayResolve = null;
  const win = overlayWindow;
  overlayWindow = null;
  if (win && !win.isDestroyed()) {
    try { win.close(); } catch { /* non-fatal */ }
  }
  if (resolve) resolve(rect);
}

/** Resolve the multi-display overlay once and close EVERY per-monitor window. */
function finishMultiOverlay(result: { rect: SelectionRect; display: Electron.Display } | null): void {
  const resolve = multiOverlayResolve;
  multiOverlayResolve = null;
  const wins = multiOverlayWins;
  multiOverlayWins = [];
  for (const w of wins) { if (!w.win.isDestroyed()) { try { w.win.close(); } catch { /* non-fatal */ } } }
  if (resolve) resolve(result);
}

// Selection events from the overlay page. Registered once at module
// load; the sender check pins them to the live overlay so a stale or
// spoofed renderer can't complete someone else's selection.
ipcMain.on('capture:overlay-select', (event, rect: SelectionRect) => {
  if (overlayWindow && !overlayWindow.isDestroyed() && event.sender === overlayWindow.webContents) {
    finishOverlay(rect && rect.width >= 1 && rect.height >= 1 ? rect : null);
    return;
  }
  const m = multiOverlayWins.find((w) => !w.win.isDestroyed() && w.win.webContents === event.sender);
  if (m && rect && rect.width >= 1 && rect.height >= 1) finishMultiOverlay({ rect, display: m.display });
});
ipcMain.on('capture:overlay-cancel', (event) => {
  if (overlayWindow && !overlayWindow.isDestroyed() && event.sender === overlayWindow.webContents) {
    finishOverlay(null);
    return;
  }
  if (multiOverlayWins.some((w) => !w.win.isDestroyed() && w.win.webContents === event.sender)) finishMultiOverlay(null);
});

/**
 * Open a LIVE region overlay on EVERY display (one window each) and resolve with the rect +
 * the display it was drawn on. No blur-cancel (the windows cover every screen, so moving the
 * cursor between them would otherwise self-cancel); Esc on any window cancels them all.
 */
function openMultiDisplayOverlay(opts: { adjustable?: boolean }): Promise<{ rect: SelectionRect; display: Electron.Display } | null> {
  return new Promise((resolve) => {
    multiOverlayResolve = resolve;
    multiOverlayWins = [];
    const displays = screen.getAllDisplays();
    const cursorDisp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    displays.forEach((d) => {
      const win = new BrowserWindow({
        x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
        frame: false, show: false, transparent: true, backgroundColor: '#00000000',
        resizable: false, movable: false, minimizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
        webPreferences: { preload: path.join(__dirname, 'capture-mini-preload.js'), contextIsolation: true, nodeIntegration: false },
      });
      try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* non-fatal */ }
      try { win.setContentProtection(true); } catch { /* non-fatal */ }
      win.setMenu(null);
      const localWindows = enumerateWindowRectsForDisplay(d);
      multiOverlayWins.push({ win, display: d });
      win.webContents.once('did-finish-load', () => {
        if (win.isDestroyed()) return;
        win.webContents.send('capture:overlay-init', { live: true, adjustable: opts.adjustable === true, windows: localWindows });
        if (d.id === cursorDisp.id) { win.show(); win.focus(); } else { win.showInactive(); }
      });
      // If a window is closed externally and they're ALL gone with nothing selected, cancel.
      win.on('closed', () => {
        if (multiOverlayResolve && multiOverlayWins.every((w) => w.win.isDestroyed())) finishMultiOverlay(null);
      });
      void win.loadFile(path.join(__dirname, '../dist/public/capture-overlay.html'));
    });
  });
}

/**
 * Frameless always-on-top window covering the target display, showing
 * the frozen frame with the drag-to-select veil. Resolves with the
 * selection rect in the display's CSS pixels, or null on cancel.
 */
function openRegionOverlay(
  display: Electron.Display,
  frozenDataUrl: string | null,
  windows: SelectionRect[],
  onShown?: () => void,
  opts?: { live?: boolean; adjustable?: boolean },
): Promise<SelectionRect | null> {
  // Round 131 (Terry) — LIVE mode: a transparent dimming veil over
  // the real desktop instead of a pasted frozen screenshot. The
  // frozen-image overlay showed the captured taskbar on TOP of the
  // real Windows taskbar — "two taskbars", disorienting. Recording
  // area-selection doesn't need a frozen frame (the recording grabs
  // live later), so it uses live mode; screenshot region capture
  // still freezes (it must capture that exact instant).
  const live = opts?.live === true;
  return new Promise<SelectionRect | null>((resolve) => {
    overlayResolve = resolve;
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: live,
      backgroundColor: live ? '#00000000' : '#000000',
      webPreferences: {
        preload: path.join(__dirname, 'capture-mini-preload.js'),   // round 312 — tiny preload, loads instantly
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    overlayWindow = win;
    // screen-saver level floats above fullscreen apps and the taskbar.
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* non-fatal */ }
    // Round 127 — excluded from capture. Matters for the mid-recording
    // Blur selector (the overlay must never leak into the footage if
    // the recorder is still draining); harmless for the screenshot
    // flow, whose grab happens before this window exists.
    try { win.setContentProtection(true); } catch { /* non-fatal */ }
    win.setMenu(null);

    win.on('closed', () => {
      // Covers external closes (e.g. Alt+F4) — finishOverlay no-ops
      // when the selection already resolved.
      if (overlayResolve) {
        const r = overlayResolve;
        overlayResolve = null;
        overlayWindow = null;
        r(null);
      }
    });

    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      win.webContents.send('capture:overlay-init', { imageDataUrl: frozenDataUrl, windows, live, adjustable: opts?.adjustable === true });
      win.show();
      win.focus();
      // PDR's hidden windows restore NOW, underneath the overlay —
      // one clean transition instead of the flash-in-flash-out Terry
      // reported (round 124).
      try { onShown?.(); } catch { /* non-fatal */ }
      // Blur = the user clicked away / alt-tabbed — treat as cancel so
      // a topmost overlay can never get stranded behind their work.
      // Attached AFTER show+focus settles so the show itself can't
      // trip it.
      setTimeout(() => {
        if (!win.isDestroyed()) win.on('blur', () => finishOverlay(null));
      }, 300);
    });

    void win.loadFile(path.join(__dirname, '../dist/public/capture-overlay.html'));
  });
}

/**
 * Region screenshot to the Library. v2.1 round 313 (Terry) — now uses the SAME flow as the
 * collage chevron: hide PDR so you can navigate, a floating "Capture region" bar, then a LIVE
 * per-monitor overlay (every screen at once — no "which screen?" picker) with Lightshot-style
 * adjustable handles. Only the destination differs from the collage (the Library, via
 * persistCapture). The old frozen-frame + display-picker path is gone.
 */
export async function captureRegion(_opts: {
  displayId?: string;
  trigger: 'button' | 'hotkey';
}): Promise<CaptureScreenshotResult> {
  void flushPendingCaptures().catch((err) =>
    log.warn(`[capture] inline pending flush failed (non-fatal): ${(err as Error).message}`),
  );
  // Hide the focused PDR window during the prep step (the title-bar button → the main window;
  // a hotkey fired over a non-PDR window → null, so nothing of ours to hide).
  const r = await regionCaptureWithPrep(BrowserWindow.getFocusedWindow());
  if ('cancelled' in r) { log.info('[capture] region selection cancelled'); return { success: false, cancelled: true }; }
  if ('error' in r) return { success: false, error: r.error };
  return await persistCapture(r.buffer, new Date(), r.width, r.height, 'region');
}

/**
 * Move any captures stranded in the AppData pending folder into the
 * (now reconnected) library, index them, and announce. Capture time
 * comes back out of the filename — the same YYYY-MM-DD_HH-MM-SS
 * pattern the indexer itself parses. Called at startup (deferred) and
 * opportunistically before every new capture.
 */
export async function flushPendingCaptures(): Promise<number> {
  const dir = pendingDir();
  if (!fs.existsSync(dir)) return 0;
  const libRoot = onlineLibraryRoot();
  if (!libRoot) return 0;

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => /\.(png|mp4)$/i.test(f));
  } catch {
    return 0;
  }
  if (entries.length === 0) return 0;

  let flushed = 0;
  for (const name of entries) {
    try {
      const srcPath = path.join(dir, name);
      // Recover the capture moment from the filename; fall back to
      // the file's mtime for anything hand-renamed in the meantime.
      const m = name.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
      const capturedAt = m
        ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
        : fs.statSync(srcPath).mtime;

      const { month } = timestampParts(capturedAt);
      const destDir = path.join(libRoot, 'PDR Captures', month);
      fs.mkdirSync(toLongPath(destDir), { recursive: true });
      const ext = path.extname(name).toLowerCase();
      const destPath = uniqueCapturePath(destDir, path.basename(name, ext), ext);
      try {
        fs.renameSync(toLongPath(srcPath), toLongPath(destPath));
      } catch {
        // Cross-volume move (AppData on C:, library on D:) — copy + delete.
        fs.copyFileSync(toLongPath(srcPath), toLongPath(destPath));
        fs.unlinkSync(toLongPath(srcPath));
      }

      // Dimensions best-effort from the file itself.
      let width: number | null = null;
      let height: number | null = null;
      try {
        const sharp = (await import('sharp')).default;
        const meta = await sharp(destPath, { failOnError: false }).metadata();
        width = meta.width ?? null;
        height = meta.height ?? null;
      } catch { /* keep nulls */ }

      const fileType = ext === '.mp4' ? 'video' : 'photo';
      const fileId = await indexCapturedFile(destPath, libRoot, capturedAt, width, height, fileType);
      if (fileId != null) {
        broadcast('library:filesAdded', { reason: 'capture', newFilePath: destPath, fileId });
      }
      flushed++;
      log.info(`[capture] flushed pending ${name} → ${destPath}${fileId != null ? ` (file id ${fileId})` : ''}`);
    } catch (err) {
      log.warn(`[capture] pending flush of ${name} failed (left in place): ${(err as Error).message}`);
    }
  }

  if (flushed > 0) {
    broadcast('capture:pendingFlushed', { count: flushed });
  }
  return flushed;
}

// ─── Collage (v2.1 round 138, Terry 2026-06-12) ──────────────────────────────
//
// v2.1 round 139 (Terry 2026-06-12) - the old grid-collage composer
// window (collage.html + createCollage + collage:open/create/close) was
// retired here. "Create collage" now opens the chosen photos straight
// into PDRV's freeform editor (search:openViewer with the collage flag);
// the editor sends a layout to collage:saveLayout below, which composites
// the full-resolution originals with sharp.

// v2.1 round 139 (Terry) — save a FREEFORM collage the PDRV editor
// laid out. The renderer sends a resolution-independent layout (each
// photo's fractional position/size/rotation on the canvas); we
// composite the FULL-RESOLUTION originals here with sharp (not the
// on-screen thumbnails — premium quality, and it sidesteps the
// canvas-taint the pdr-file:// protocol would cause if we rendered
// the export in the renderer). Lands as a born-in-PDR _CO file and
// indexes it like a capture, so the user can then enhance it with
// the normal Looks / Frames / sliders.
// v2.1 round 140 (Terry) — per-tile enhancement. Each collage photo can
// carry its own Enhance state (the same set PDRV's side panel exposes),
// so one tile can be high-contrast + red-framed while another is B&W.
interface CollageEnhance {
  brightness?: number; contrast?: number; saturation?: number; temperature?: number;
  colour?: number; // v2.1 round 152 — 0..100, 100 = full colour, 0 = B&W
  flipH?: boolean; flipV?: boolean; // v2.1 round 155 — mirror / flip
  tone?: 'none' | 'sepia' | 'vintage'; borderColor?: string; borderWeight?: 'thin' | 'mat'; borderPct?: number;
  opacity?: number; // v2.1 round 143 — per-tile transparency (0.1–1)
  blend?: number; // v2.1 round 150 — edge feather %, 0–100 (0 = crisp)
  corners?: number[]; // v2.1 round 164 — curved corners [tl,tr,br,bl], 0–1 of half the short side
  vignette?: number; // v2.1 round 294 — PER-PHOTO vignette 0..100
  vignetteShape?: string; // v2.1 round 294 — vignette shape (ellipse/heart/star/…)
  grain?: number; // v2.1 round 294 — PER-PHOTO film grain 0..150
}
// v2.1 round 164 (Terry) — CURVED CORNERS + Blend, in one rounded-rect
// signed-distance mask. corners = [tl,tr,br,bl] (0–1 of half the short side);
// blend 0–100 widens the feather band inward from the rounded boundary so the
// (rounded) edge melts away with no straight rectangle edge left. The formula
// is IDENTICAL to the live preview (viewer.html applyShapeMask) so the saved
// file matches the editor. dest-in keeps any existing alpha (frame / fade).
async function roundedFeatherMask(sharp: any, buf: Buffer, w: number, h: number, corners?: number[], blend?: number): Promise<Buffer> {
  const b = Math.max(0, Math.min(100, blend || 0));
  const c = Array.isArray(corners) ? corners : [0, 0, 0, 0];
  const hasCorner = c.some((v) => (v || 0) > 0.001);
  if ((b <= 0 && !hasCorner) || w < 2 || h < 2) return buf;
  const minD = Math.min(w, h);
  const radii = [c[0], c[1], c[2], c[3]].map((v) => Math.max(0, Math.min(1, v || 0)) * minD / 2);
  const featherPx = Math.max(0.75, (b / 100) * 0.45 * minD);
  const cx = w / 2, cy = h / 2;
  const mask = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const py = y + 0.5;
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const r = (px < cx) ? (py < cy ? radii[0] : radii[3]) : (py < cy ? radii[1] : radii[2]);
      const qx = Math.abs(px - cx) - (cx - r);
      const qy = Math.abs(py - cy) - (cy - r);
      const sdf = Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
      mask[(y * w + x) * 4 + 3] = Math.round(Math.max(0, Math.min(1, -sdf / featherPx)) * 255);
    }
  }
  const maskPng = await sharp(mask, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  return await sharp(buf).ensureAlpha().composite([{ input: maskPng, blend: 'dest-in' }]).png().toBuffer();
}
interface CollageLayout {
  // v2.1 round 142 (Terry) — bgImage: an optional library photo used as
  // the canvas backdrop, faded over the solid bg colour at `opacity`
  // (same idea as the Trees canvas background).
  // v2.1 round 235 (Terry) — gradient: an optional GRADIENT backdrop (phase 1 of
  // "Background textures"). Mutually exclusive with transparent + bgImage (the
  // editor clears those when a gradient is chosen). Rasterized to an SVG at W×H and
  // composited as the BOTTOM layer, matching the editor's CSS gradient preview.
  //   kind  — 'linear' | 'radial' | 'mesh'
  //   angle — CSS linear-gradient angle in degrees (0 = to top, 90 = to right); linear only
  //   stops — [{ color:'#rrggbb', pos:0..100 }, ...]  (linear/radial)
  // v2.1 round 239 (Terry) — MESH: a base colour + several soft colour "blobs"
  //   (radial-gradient circles fading to transparent), the standard CSS mesh look.
  //   base  — '#rrggbb' painted first; blobs — [{ color, x, y, r }] with x/y the blob
  //   centre and r the falloff radius, all in % of the canvas. Baked by
  //   buildCollageMeshSvg (base rect + one radial per blob, same stacking as the CSS).
  // v2.1 round 238 (Terry) — vignette/grain: WHOLE-COLLAGE finishing treatments
  // (0..100; absent/0 = off), composited as the TOP layer over the finished collage
  // (tiles + bg + text), independent of the bg kind. See buildCollageVignetteSvg /
  // buildCollageGrainSvg + the composite block in collage:saveLayout.
  // v2.1 round 244 (Terry) — `texture`: an optional close-up MATERIAL SURFACE backdrop
  // (brick face / wood grain / concrete / leather / marble / …). Mutually exclusive with
  // gradient + transparent + bgImage (the editor clears those when a texture is chosen).
  // Baked from the SAME full-canvas feTurbulence surface SVG the editor previews
  // (buildCollageTextureSvg, mirroring the renderer's COLLAGE_TEXTURES) at W×H and
  // composited as the BOTTOM layer.
  canvas: { w: number; h: number; bg: string; transparent?: boolean; bgImage?: { path: string; opacity: number; enh?: CollageEnhance }; gradient?: { kind: 'linear' | 'radial' | 'mesh'; angle?: number; stops?: Array<{ color: string; pos: number }>; base?: string; blobs?: Array<{ color: string; x: number; y: number; r: number }> }; texture?: { id: string }; vignette?: number; vignetteShape?: string; grain?: number };
  // v2.1 round 263 (Terry) — bg-tile: `coverFill` marks a tile that reads as a
  // BACKGROUND — the photo is cover-fit into its box (the box = whole canvas at
  // the locked full-canvas default, or the user's resized rectangle once unlocked)
  // rather than the box being shaped to the photo. `aspect` for a coverFill item is
  // the BOX aspect (the renderer sends effectiveAspect = box aspect), so the bake
  // sizes the tile to wFrac×(wFrac/aspect) and resizes the source with fit:'cover'
  // (no crop/zoom). Mutually exclusive per saved layout with canvas.bgImage (legacy).
  items: Array<{ path: string; bgRemoved?: boolean; coverFill?: boolean; xFrac: number; yFrac: number; wFrac: number; aspect: number; rot: number; zoom?: number; panX?: number; panY?: number; enh?: CollageEnhance; crop?: { l: number; t: number; r: number; b: number } }>;
  // v2.1 round 185 (Text #1) — text layers rendered to transparent PNGs in the
  // renderer (the SAME canvas render that drives the on-screen preview), so the
  // text lands at the same relative position + size here and sharp never renders
  // text (no font dependency). pngBase64 is a data URL (or bare base64); xFrac/
  // yFrac are the layer CENTRE in canvas fractions; rot in degrees.
  texts?: Array<{ pngBase64: string; xFrac: number; yFrac: number; rot: number }>;
}
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return { r: 255, g: 255, b: 255 };
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
// v2.1 round 266 (Terry) — oversized tiles: a collage/carousel tile may be LARGER
// than the page (Canva-style), so the bake's wFrac ceiling rises from 1 to 4× the
// (wide) canvas width. Content is still clipped to each page by the final extract;
// the PAD below is bounded by each tile's real OFF-PAGE OVERHANG (not its full 4×
// extent) so the composite base never balloons. Must match viewer.html's client
// resize ceiling (Phase 3).
const TILE_WFRAC_MAX = 4;
// v2.1 round 266 (Terry) — oversized tiles travel off-page, so the box TOP-LEFT
// fraction is clamped to a WIDE window (not [0,1]) — far enough that a tile up to
// TILE_WFRAC_MAX× can sit fully above/left/below/right of the page yet still
// composite at its true position. The final per-tile safety clamp (~L1527) keeps the
// placed bbox inside the PAD-expanded base. Used by BOTH the PAD pre-scan and the
// composite loop so cx/cy agree exactly. (clamp01 is still used for crop rects etc.)
const clampTileX = (n: number) => (Number.isFinite(n) ? Math.max(-TILE_WFRAC_MAX, Math.min(1 + TILE_WFRAC_MAX, n)) : 0);
const clampTileY = (n: number) => (Number.isFinite(n) ? Math.max(-TILE_WFRAC_MAX, Math.min(1 + TILE_WFRAC_MAX, n)) : 0);
// v2.1 round 266 (Terry) — OOM BACKSTOP. wFrac is a fraction of the WHOLE wide
// carousel canvas, so TILE_WFRAC_MAX× on a 10-page strip (W≈10800) could be a
// ~43000px raster (multi-GB) and crash the bake at toBuffer(). This is a pure
// crash-guard, NOT a feature: it is a guaranteed no-op for every realistic
// "bigger than the pages" size (a 2× tile on the 6-page panorama = 12960px, well
// under the cap) and only clamps genuinely pathological rasters (>16000px in a
// dimension, i.e. wFrac beyond ~1.5× the entire multi-page strip). At those
// extreme sizes the tile is shrunk to the cap (a small position shift), which is
// always preferable to losing the user's save to an out-of-memory crash.
const MAX_TILE_PX = 16000;
const capTilePx = (n: number) => Math.min(n, MAX_TILE_PX);

// v2.1 round 237 (Terry) — CSS colour-HINT (midpoint) sampling. A bare percentage
// token between two colour stops in a CSS gradient — `c0 0%, H%, c1 100%` — is NOT
// the linear midpoint: it's the point where the two colours mix 50/50, with a
// NON-LINEAR power ease either side of it. A 2-stop SVG <linearGradient> can't
// reproduce that curve, so the bake must SAMPLE the eased colour at many positions
// and emit them as explicit stops. This returns an array of { off:0..1, color } for
// ONE hinted segment between (a, posA) and (b, posB) with the hint at absolute
// position `hintPos` (all positions on the SAME 0..1 scale as the segment ends).
//
// CSS midpoint formula (per the spec / every browser): within the segment, let the
// hint's fractional position be H = (hintPos − posA)/(posB − posA), clamped to
// (0,1). For a sample at segment-fraction x∈[0,1], the colour-mix weight is
//   t = x ^ (ln 0.5 / ln H)
// so that at x = H, t = 0.5 (the colours are exactly half-mixed at the hint), and
// the ease is faster on one side than the other. We mix in sRGB (what CSS does for
// these legacy hex gradients), matching the on-screen preview.
function sampleCssHintSegment(
  a: { r: number; g: number; b: number }, posA: number,
  b: { r: number; g: number; b: number }, posB: number,
  hintPos: number,
  samples: number,
): Array<{ off: number; color: string }> {
  const span = posB - posA;
  // Degenerate segment → just the two endpoints.
  if (!(Math.abs(span) > 1e-6)) {
    return [{ off: posA, color: rgbToHex(a) }, { off: posB, color: rgbToHex(b) }];
  }
  let H = (hintPos - posA) / span;
  H = Math.max(0.001, Math.min(0.999, H));
  // Exponent so that x^exp == 0.5 at x == H.
  const exp = Math.log(0.5) / Math.log(H);
  const out: Array<{ off: number; color: string }> = [];
  const N = Math.max(2, samples);
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);                 // 0..1 across the segment
    const t = Math.pow(x, exp);            // eased mix weight
    const r = Math.round(a.r + (b.r - a.r) * t);
    const g = Math.round(a.g + (b.g - a.g) * t);
    const bl = Math.round(a.b + (b.b - a.b) * t);
    out.push({ off: posA + span * x, color: rgbToHex({ r, g, b: bl }) });
  }
  return out;
}
function rgbToHex(c: { r: number; g: number; b: number }): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + h(c.r) + h(c.g) + h(c.b);
}

// v2.1 round 235 (Terry) — build an SVG that reproduces the editor's CSS gradient
// at the OUTPUT resolution, so the baked background matches the preview exactly.
//
// CSS-angle ↔ SVG-vector mapping (the tricky bit — they differ):
//   • CSS `linear-gradient(Adeg, …)`: 0deg points to the TOP, increasing CLOCKWISE
//     (90deg = right, 180deg = bottom). The gradient line passes through the box
//     centre; CSS sizes it so the 0% / 100% stops sit on the lines through the two
//     corners the gradient line is perpendicular to (the "magic" gradient-line
//     length L = |W·sinθ| + |H·cosθ|). To match this on a NON-SQUARE canvas we must
//     work in pixel space (gradientUnits="userSpaceOnUse"), NOT objectBoundingBox
//     (which would skew the visual angle by the aspect ratio).
//     Direction unit vector for CSS angle θ: dir = (sinθ, −cosθ) — note the −cos,
//     because SVG/CSS y grows DOWNWARD while CSS angle 0deg points up. Endpoints:
//       start(0%) = centre − dir·(L/2),  end(100%) = centre + dir·(L/2).
//   • CSS `radial-gradient(circle at center, …)` defaults to farthest-corner: a
//     circle centred on the box with radius = distance centre→farthest corner =
//     hypot(W/2, H/2). SVG radialGradient with userSpaceOnUse cx/cy/r does the same.
function buildCollageGradientSvg(
  W: number,
  H: number,
  gradient: { kind: 'linear' | 'radial'; angle?: number; stops: Array<{ color: string; pos: number }> },
): string {
  // Sanitize stops (valid hex + clamped pos), sorted by position.
  const stops = (gradient.stops || [])
    .map((s) => ({
      color: /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(s.color || '')) ? String(s.color) : '#ffffff',
      pos: Math.max(0, Math.min(100, Number(s.pos) || 0)),
    }))
    .sort((a, b) => a.pos - b.pos);
  if (stops.length < 2) {
    const only = stops[0] ? stops[0].color : '#ffffff';
    stops.length = 0;
    stops.push({ color: only, pos: 0 }, { color: only, pos: 100 });
  }
  const stopTags = stops
    .map((s) => `<stop offset="${s.pos}%" stop-color="${s.color}"/>`)
    .join('');

  let defs: string;
  if (gradient.kind === 'radial') {
    const cx = W / 2, cy = H / 2;
    const r = Math.hypot(W / 2, H / 2);   // farthest-corner radius
    defs = `<radialGradient id="g" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}">${stopTags}</radialGradient>`;
  } else {
    const theta = ((Number.isFinite(gradient.angle) ? (gradient.angle as number) : 135) * Math.PI) / 180;
    const dx = Math.sin(theta);
    const dy = -Math.cos(theta);   // CSS 0deg = up; SVG y grows down → negate cos
    const L = Math.abs(W * Math.sin(theta)) + Math.abs(H * Math.cos(theta));
    const cx = W / 2, cy = H / 2;
    const x1 = cx - (dx * L) / 2, y1 = cy - (dy * L) / 2;
    const x2 = cx + (dx * L) / 2, y2 = cy + (dy * L) / 2;
    defs = `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stopTags}</linearGradient>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${defs}</defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`;
}

// v2.1 round 239 (Terry) — MESH gradient bake. Reproduces the editor's CSS mesh
// (collageMeshCss): a base-colour rect, then one radial per "blob" stacked over it.
// Two things must match the browser exactly:
//  • STACKING ORDER. The CSS stacks blobs as background-image layers with the FIRST
//    blob ON TOP (CSS paints the first layer topmost), base underneath. SVG paint
//    order is the reverse (later elements draw on top), so we paint the base rect
//    first, then the blobs in REVERSE array order — last blob first … first blob last
//    → the first blob lands on top, matching the CSS.
//  • RADIUS SEMANTICS. Each blob is `radial-gradient(circle at x% y%, color 0%,
//    transparent r%)`. There, `r%` is a COLOUR-STOP position, not the gradient size:
//    the gradient defaults to `circle farthest-corner` (radius = distance from the
//    centre to the FARTHEST canvas corner), the colour sits at 0%, and it fades to
//    transparent at r% of that radius, staying transparent beyond (last-stop hold).
//    So the SVG radialGradient uses r = farthest-corner distance (userSpaceOnUse px),
//    with the opaque stop at 0% and the transparent stop at r% — SVG's default pad
//    spread holds it transparent past r%, exactly like the CSS. The centre (x%,y%) is
//    taken against W×H. Blobs use normal source-over alpha, like the browser layers.
function buildCollageMeshSvg(
  W: number,
  H: number,
  mesh: { base?: string; blobs?: Array<{ color: string; x: number; y: number; r: number }> },
): string {
  const okHex = (c: string) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(c || ''));
  const base = okHex(mesh.base || '') ? String(mesh.base) : '#1a1a2e';
  const blobs = (Array.isArray(mesh.blobs) ? mesh.blobs : [])
    .map((bl) => ({
      color: okHex(bl.color) ? String(bl.color) : '#ffffff',
      x: Math.max(-50, Math.min(150, Number(bl.x) || 0)),
      y: Math.max(-50, Math.min(150, Number(bl.y) || 0)),
      r: Math.max(5, Math.min(150, Number(bl.r) || 60)),
    }));
  // REVERSE so the first blob (CSS-topmost) is painted last (SVG-topmost).
  const ordered = blobs.slice().reverse();
  let defs = '';
  let rects = '';
  ordered.forEach((bl, i) => {
    const cx = (bl.x / 100) * W;
    const cy = (bl.y / 100) * H;
    // farthest-corner extent: max distance from the centre to any of the 4 corners.
    const far = Math.max(
      Math.hypot(cx - 0, cy - 0),
      Math.hypot(cx - W, cy - 0),
      Math.hypot(cx - 0, cy - H),
      Math.hypot(cx - W, cy - H),
    );
    // Transparent colour-stop offset within that radius (CSS `transparent r%`),
    // clamped just under 100% so the gradient is well-defined.
    const stopPct = Math.max(1, Math.min(100, bl.r));
    const id = `m${i}`;
    defs +=
      `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${far}">` +
      `<stop offset="0%" stop-color="${bl.color}" stop-opacity="1"/>` +
      `<stop offset="${stopPct}%" stop-color="${bl.color}" stop-opacity="0"/>` +
      `</radialGradient>`;
    rects += `<rect width="${W}" height="${H}" fill="url(#${id})"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${defs}</defs>` +
    `<rect width="${W}" height="${H}" fill="${base}"/>${rects}</svg>`;
}

// v2.1 round 244 (Terry) — CLOSE-UP MATERIAL SURFACE bake (REDO of round 242's zoomed-
// out geometric patterns). This table + helpers are a VERBATIM mirror of the renderer's
// COLLAGE_TEXTURES (viewer.html): each entry is a material whose full-canvas SURFACE is
// driven by feTurbulence (fractal/Perlin noise) mapped through feColorMatrix to the
// material colour + light/dark RELIEF (lighter = raised, darker = pits). NO lighting
// filters (feDiffuseLighting/feSpecularLighting DON'T render in librsvg). The surface
// SVG uses a FIXED 1000×1000 viewBox with preserveAspectRatio="none", so feTurbulence's
// per-user-unit baseFrequency yields the SAME noise scale + appearance whether rendered
// at on-screen px (editor preview) or output px (this bake) — only the outer width/height
// differ, the noise coordinate space does not, so saved == preview. The INNER markup
// (collageTextureSurfaceInner) is byte-identical to viewer.html's; any change here MUST
// be mirrored there and vice-versa.
type CollageTextureGrain = { freq: string; oct: number; seed: number; op: number; amp: number };
type CollageTextureEntry = { id: string; base: string; freq: string; oct: number; seed: number; type: string; amp: number | number[]; grain?: CollageTextureGrain };
const COLLAGE_TEXTURES: CollageTextureEntry[] = [
  { id: 'brick',    base: '#a8553a', freq: '0.022', oct: 4, seed: 11, type: 'fractalNoise', amp: [0.62, 0.42, 0.34], grain: { freq: '0.09', oct: 2, seed: 12, op: 0.18, amp: 0.5 } },
  { id: 'wood',     base: '#a9763f', freq: '0.006 0.05', oct: 5, seed: 7,  type: 'fractalNoise', amp: [0.5, 0.36, 0.22], grain: { freq: '0.012 0.16', oct: 2, seed: 8, op: 0.22, amp: 0.45 } },
  { id: 'woodchip', base: '#d8c9a6', freq: '0.045', oct: 3, seed: 21, type: 'turbulence',   amp: [0.45, 0.42, 0.34], grain: { freq: '0.16', oct: 2, seed: 22, op: 0.22, amp: 0.5 } },
  { id: 'concrete', base: '#9a9a98', freq: '0.05', oct: 5, seed: 31, type: 'fractalNoise', amp: [0.34, 0.34, 0.34], grain: { freq: '0.28', oct: 2, seed: 32, op: 0.16, amp: 0.45 } },
  { id: 'linen',    base: '#d9d2c2', freq: '0.10 0.11', oct: 2, seed: 41, type: 'turbulence',   amp: [0.26, 0.26, 0.24], grain: { freq: '0.35', oct: 1, seed: 42, op: 0.14, amp: 0.4 } },
  { id: 'paper',    base: '#efe9dc', freq: '0.16', oct: 3, seed: 51, type: 'fractalNoise', amp: [0.14, 0.14, 0.13], grain: { freq: '0.5', oct: 1, seed: 52, op: 0.12, amp: 0.35 } },
  { id: 'leather',  base: '#7c4f33', freq: '0.06', oct: 3, seed: 61, type: 'turbulence',   amp: [0.5, 0.36, 0.26], grain: { freq: '0.2', oct: 2, seed: 62, op: 0.2, amp: 0.5 } },
  { id: 'marble',   base: '#e6e3dc', freq: '0.006 0.03', oct: 6, seed: 71, type: 'fractalNoise', amp: [0.3, 0.3, 0.32], grain: { freq: '0.3', oct: 1, seed: 72, op: 0.1, amp: 0.3 } },
  { id: 'slate',    base: '#6f767c', freq: '0.04', oct: 5, seed: 81, type: 'fractalNoise', amp: [0.4, 0.42, 0.46], grain: { freq: '0.24', oct: 2, seed: 82, op: 0.18, amp: 0.5 } },
  { id: 'sand',     base: '#d8c08a', freq: '0.14', oct: 3, seed: 91, type: 'turbulence',   amp: [0.3, 0.26, 0.18], grain: { freq: '0.5', oct: 2, seed: 92, op: 0.18, amp: 0.45 } },
];
// v2.1 round 244 (Terry) — "#rrggbb" → [r,g,b] 0..1 (mirror of viewer.html collageHexRgb01).
function collageHexRgb01(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''));
  if (!m) return [0.5, 0.5, 0.5];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
// v2.1 round 244 (Terry) — one turbulence→colour-matrix <filter> (mirror of viewer.html
// collageSurfaceFilter). out_c = base_c + (lum−0.5)·amp_c per channel; alpha forced opaque.
function collageSurfaceFilter(id: string, freq: string, oct: number, seed: number, type: string, baseArr: number[], ampArr: number[]): string {
  function row(b: number, a: number) {
    const k = (0.3333 * a).toFixed(5);
    return k + ' ' + k + ' ' + k + ' 0 ' + (b - 0.5 * a).toFixed(5);
  }
  const matrix = row(baseArr[0], ampArr[0]) + '  ' + row(baseArr[1], ampArr[1]) + '  ' +
    row(baseArr[2], ampArr[2]) + '  0 0 0 0 1';
  return '<filter id="' + id + '" x="0" y="0" width="100%" height="100%" ' +
    'filterUnits="objectBoundingBox" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">' +
    '<feTurbulence type="' + type + '" baseFrequency="' + freq + '" numOctaves="' + oct +
    '" seed="' + seed + '" stitchTiles="stitch" result="t"/>' +
    '<feColorMatrix in="t" type="matrix" values="' + matrix + '"/>' +
    '</filter>';
}
// v2.1 round 244 (Terry) — INNER markup of a material surface (mirror of viewer.html
// collageTextureSurfaceInner): filter defs + base rect + relief rect + optional grain
// rect, in the FIXED 1000×1000 user-unit space. Byte-identical to the renderer's output.
function collageTextureSurfaceInner(entry: CollageTextureEntry): string {
  const base = collageHexRgb01(entry.base);
  const amp = Array.isArray(entry.amp) ? entry.amp : [entry.amp, entry.amp, entry.amp];
  let defs = collageSurfaceFilter('sr', entry.freq, entry.oct, entry.seed, entry.type || 'fractalNoise', base, amp);
  let out = '<defs>' + defs;
  const grain = entry.grain;
  if (grain) {
    defs += collageSurfaceFilter('sg', grain.freq, grain.oct, grain.seed, 'fractalNoise', [0.5, 0.5, 0.5], [grain.amp, grain.amp, grain.amp]);
    out = '<defs>' + defs;
  }
  out += '</defs>';
  out += '<rect x="0" y="0" width="1000" height="1000" fill="' + entry.base + '"/>';
  out += '<rect x="0" y="0" width="1000" height="1000" filter="url(#sr)"/>';
  if (grain) out += '<rect x="0" y="0" width="1000" height="1000" filter="url(#sg)" opacity="' + grain.op + '"/>';
  return out;
}
// v2.1 round 244 (Terry) — build the full-canvas material-surface SVG at W×H, with the
// FIXED 1000×1000 viewBox + preserveAspectRatio="none" so the feTurbulence noise scale
// matches the editor preview exactly (the editor's collageTextureSurfaceSvg with the same
// inner markup). Returns '' for an unknown id (caller skips the layer).
function buildCollageTextureSvg(W: number, H: number, id: string): string {
  const entry = COLLAGE_TEXTURES.find((t) => t.id === id);
  if (!entry) return '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 1000 1000" preserveAspectRatio="none">` +
    collageTextureSurfaceInner(entry) + `</svg>`;
}

// v2.1 round 238 (Terry) — VIGNETTE finishing layer. Reproduces the editor's CSS
// `radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,a) 100%)` at the
// output W×H so the baked edge-darkening matches the preview. The CSS ellipse uses
// the default `farthest-corner` extent: an ellipse keeping the box aspect, sized so
// it passes through the corners. In objectBoundingBox units (each axis scaled to the
// box) that ellipse has radius 1/√2 ≈ 0.7071 on both axes from the centre — so
// cx/cy 0.5, r 0.7071 gives exactly the farthest-corner ellipse on any aspect. The
// 55% transparent core + the slider-scaled edge alpha mirror applyCollageTreatments.
// v2.1 round 240 (Terry) — VIGNETTE SHAPE geometry, mirrored from viewer.html
// (collageVignetteShapeMarkup) so the bake reproduces the preview shape-for-shape. Each
// shape is normalized into a 100×100 box, centred, clearing a similar portion of the
// canvas as the classic ellipse. The mask below renders these in box space with
// preserveAspectRatio="none" so the box stretches to the canvas aspect — exactly like the
// preview's CSS mask + the original radial-gradient ellipse.
function collageVignetteShapeMarkup(shape: string, fill: string): string {
  const f = `fill="${fill}"`;
  switch (shape) {
    case 'circle':
      return `<circle cx="50" cy="50" r="39" ${f}/>`;
    case 'heart':
      return `<path ${f} d="M50 88 C18 66 8 48 8 33 C8 20 18 13 28 13 C37 13 45 19 50 28 C55 19 63 13 72 13 C82 13 92 20 92 33 C92 48 82 66 50 88 Z"/>`;
    case 'hearts': {
      const heart = (cx: number, cy: number, s: number): string =>
        `<path ${f} d="` +
        `M${cx} ${cy + 0.78 * s}` +
        ` C${cx - 0.92 * s} ${cy + 0.18 * s} ${cx - 1.0 * s} ${cy - 0.30 * s} ${cx - 1.0 * s} ${cy - 0.52 * s}` +
        ` C${cx - 1.0 * s} ${cy - 0.86 * s} ${cx - 0.55 * s} ${cy - 1.0 * s} ${cx - 0.28 * s} ${cy - 0.78 * s}` +
        ` C${cx - 0.12 * s} ${cy - 0.64 * s} ${cx} ${cy - 0.46 * s} ${cx} ${cy - 0.40 * s}` +
        ` C${cx} ${cy - 0.46 * s} ${cx + 0.12 * s} ${cy - 0.64 * s} ${cx + 0.28 * s} ${cy - 0.78 * s}` +
        ` C${cx + 0.55 * s} ${cy - 1.0 * s} ${cx + 1.0 * s} ${cy - 0.86 * s} ${cx + 1.0 * s} ${cy - 0.52 * s}` +
        ` C${cx + 1.0 * s} ${cy - 0.30 * s} ${cx + 0.92 * s} ${cy + 0.18 * s} ${cx} ${cy + 0.78 * s}` +
        ` Z"/>`;
      return heart(35, 42, 26) + heart(65, 56, 26);
    }
    case 'balloon':
      return `<path ${f} d="M50 8 C71 8 84 25 84 43 C84 64 64 79 54 88 L57 95 C58 97 56 99 53 99 L47 99 C44 99 42 97 43 95 L46 88 C36 79 16 64 16 43 C16 25 29 8 50 8 Z"/>`;
    case 'star':
      return `<path ${f} d="M50 6 L61.8 36.6 L94.5 38.8 L69 59.4 L77.3 91.5 L50 73.5 L22.7 91.5 L31 59.4 L5.5 38.8 L38.2 36.6 Z"/>`;
    case 'ellipse':
    default:
      return `<ellipse cx="50" cy="50" rx="45" ry="45" ${f}/>`;
  }
}

// v2.1 round 240 (Terry) — the vignette bake. ELLIPSE (default) returns the EXACT original
// radial-gradient SVG so its output is byte-for-byte unchanged. Any other shape paints a
// solid black rect (at the slider-scaled 0..0.85 alpha) masked by a BLURRED shape so the
// dark shows OUTSIDE the shape and feathers softly to clear inside — matching the preview's
// rgba-black layer + CSS shape mask. The mask is rendered in the same 100×100 box space
// with preserveAspectRatio="none" (and stdDev=5 in box units) as the preview, so feather +
// coverage register across the canvas aspect.
function buildCollageVignetteSvg(W: number, H: number, intensity: number, shape?: string): string {
  const v = Math.max(0, Math.min(100, intensity || 0));
  const a = ((v / 100) * 0.85).toFixed(3);   // matches the preview's 0..0.85 edge alpha
  const sh = shape || 'ellipse';
  if (sh === 'ellipse') {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<defs><radialGradient id="v" cx="0.5" cy="0.5" r="0.7071">` +
      `<stop offset="55%" stop-color="#000000" stop-opacity="0"/>` +
      `<stop offset="100%" stop-color="#000000" stop-opacity="${a}"/>` +
      `</radialGradient></defs>` +
      `<rect width="${W}" height="${H}" fill="url(#v)"/></svg>`
    );
  }
  // White field with a blurred dark hole in the shape → as a luminance mask, this keeps
  // the black rect OUTSIDE the shape and softly clears it inside.
  const hole = collageVignetteShapeMarkup(sh, '#000000');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 100 100" preserveAspectRatio="none">` +
    `<defs><filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="5"/></filter>` +
    `<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">` +
    `<rect width="100" height="100" fill="#ffffff"/>` +
    `<g filter="url(#b)">${hole}</g>` +
    `</mask></defs>` +
    `<rect width="100" height="100" fill="#000000" fill-opacity="${a}" mask="url(#m)"/></svg>`
  );
}

// v2.1 round 238 (Terry) — GRAIN finishing layer. A monochrome film-grain texture via
// SVG feTurbulence (fractalNoise), rasterized by sharp at the output W×H and composited
// with blend 'overlay' (matching the preview's mix-blend-mode:overlay) so it darkens
// shadows + lightens highlights subtly, leaving mid-greys neutral — only the texture
// shows. baseFrequency is kept close to the preview's grain feel (the preview tiles a
// 160px noise tile at 0.9; here we render full-frame at a fine frequency for an
// equivalent subtle grain at print sizes — grain is texture, not registration-critical).
// The whole layer's opacity scales 0..0.5 with the slider, exactly like the preview.
function buildCollageGrainSvg(W: number, H: number, intensity: number): string {
  // v2.1 round 325 (Terry) — grain scale back to 0-100 but the effect DOUBLED (op coefficient
  // 0.5 -> 1.0) so 100 → 1.0; matches the doubled preview (applyCollageTreatments).
  const g = Math.max(0, Math.min(100, intensity || 0));
  const op = ((g / 100) * 1.0).toFixed(3);
  // fractalNoise → collapse to GREY centred on ~0.5 (average the noise channels into
  // R=G=B) with FULL alpha. Mid-grey 0.5 under 'overlay' is a no-op, so lighter noise
  // LIGHTENS and darker noise DARKENS — proper filmic grain that pushes both ways
  // (not just a brighten). The rect's opacity carries the slider-scaled strength.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<filter id="n" x="0" y="0" width="100%" height="100%">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="2" stitchTiles="stitch" result="t"/>` +
    `<feColorMatrix in="t" type="matrix" values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 0 1" result="g"/>` +
    // v2.1 round 326 (Terry) — double again via CONTRAST (opacity already maxes at 1.0); matches collageGrainDataUri.
    `<feComponentTransfer in="g"><feFuncR type="linear" slope="2" intercept="-0.5"/><feFuncG type="linear" slope="2" intercept="-0.5"/><feFuncB type="linear" slope="2" intercept="-0.5"/></feComponentTransfer>` +
    `</filter>` +
    `<rect width="${W}" height="${H}" filter="url(#n)" opacity="${op}"/></svg>`
  );
}

// Build a sharp pipeline for ONE collage tile: source → EXIF-rotate →
// resize to the tile box → the photo's own Enhance bake (mirrors
// viewer:saveEnhanced exactly) → optional frame. Returned un-toBuffer'd
// so the caller can read the result dims. The placement rotation is
// applied by the caller afterwards.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildCollageTilePipeline(sharp: any, srcLong: string, iw: number, ih: number, enh?: CollageEnhance, cropRect?: { left: number; top: number; width: number; height: number }, coverPos: string = 'attention', keepAlpha: boolean = false) {
  // v2.1 round 173 (Terry) — keepAlpha = the source is a background-removed
  // cut-out (transparent PNG). sharp's .linear() applies to EVERY channel,
  // which would scale the alpha and bring the removed background back; so for
  // cut-outs the contrast + temperature ops use per-channel arrays that leave
  // the alpha (4th channel) untouched. modulate / greyscale / flip / recomb
  // already preserve alpha.
  let p = sharp(srcLong, { failOnError: false }).rotate();
  // v2.1 round 145 (Terry) — crop: extract the user's rect (in oriented
  // px) BEFORE resizing to the tile box.
  if (cropRect && cropRect.width > 1 && cropRect.height > 1) {
    p = p.extract({ left: Math.max(0, cropRect.left), top: Math.max(0, cropRect.top), width: cropRect.width, height: cropRect.height });
  }
  // v2.1 round 160 (Terry) — coverPos: tiles use 'attention' (a smart crop,
  // moot in practice since the box aspect matches the photo). The BACKGROUND
  // passes 'centre' so the bake matches the editor's CSS background-position:
  // center — sharp's default 'attention' was cropping the bg to a different
  // region, so the saved background looked shifted vs the editor.
  // v2.1 round 161 (Terry) — FRAME = MATTE. Resize the photo to the INNER box
  // (tile minus the frame) and extend the frame back out to iw×ih below, so a
  // framed tile keeps its footprint and the photo sits fully INSIDE the frame.
  // Previously we resized to iw×ih then extended the frame OUTSIDE, which grew
  // the tile and made the on-screen preview clip the photo's outer edge —
  // Terry: "the frame is eating up the photo image". Frame % matches the
  // editor preview (applyFilterToEl): mat 8%, thin 3.5% of the short side.
  const _bc = enh ? (enh.borderColor || '').trim() : '';
  const _hasFrame = !!_bc && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(_bc);
  const _framePx = _hasFrame ? Math.max(3, Math.round(Math.min(iw, ih) * (typeof enh!.borderPct === 'number' ? enh!.borderPct : (enh!.borderWeight === 'mat' ? 0.08 : 0.035)))) : 0;
  p = p.resize(Math.max(2, iw - _framePx * 2), Math.max(2, ih - _framePx * 2), { fit: 'cover', position: coverPos });
  if (enh) {
    const b = (enh.brightness ?? 100) / 100;
    const c = (enh.contrast ?? 100) / 100;
    // v2.1 round 152 (Terry) — Colour slider (100 = colour, 0 = B&W) is a
    // master desaturation that multiplies the Saturation slider.
    const s = ((enh.saturation ?? 100) / 100) * ((enh.colour ?? 50) / 50);
    const t = enh.temperature ?? 0;
    const bw = s <= 0.001;
    const tone = enh.tone ?? 'none';
    if (b !== 1 || (s !== 1 && !bw)) p = p.modulate({ brightness: b, ...(bw ? {} : { saturation: s }) });
    if (c !== 1) {
      const slope = c, off = 128 * (1 - slope);
      p = keepAlpha ? p.linear([slope, slope, slope, 1], [off, off, off, 0]) : p.linear(slope, off);
    }
    if (t !== 0 && tone === 'none') {
      const tt = t / 50;
      // Temperature is a diagonal recomb (R up, B down) = a per-channel multiply,
      // so for cut-outs we use the alpha-safe per-channel linear instead.
      p = keepAlpha
        ? p.linear([1 + 0.30 * tt, 1, 1 - 0.30 * tt, 1], [0, 0, 0, 0])
        : p.recomb([[1 + 0.30 * tt, 0, 0], [0, 1, 0], [0, 0, 1 - 0.30 * tt]]);
    }
    if (tone === 'sepia') p = p.recomb([[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]]);
    else if (tone === 'vintage') p = p.recomb([[0.696, 0.385, 0.095], [0.175, 0.843, 0.084], [0.136, 0.267, 0.566]]);
    if (bw) p = p.greyscale();
    // v2.1 round 155 (Terry) — Mirror = .flop() (left↔right), Flip = .flip()
    // (top↕bottom). After the crop/resize/enhance, before the frame, so the
    // frame stays square around the transformed image.
    if (enh.flipH) p = p.flop();
    if (enh.flipV) p = p.flip();
    // v2.1 round 161 (Terry) — extend the matte frame back out to iw×ih
    // (width computed above as _framePx). Footprint preserved; photo inside.
    if (_hasFrame) {
      p = p.extend({ top: _framePx, bottom: _framePx, left: _framePx, right: _framePx, background: _bc });
    }
  }
  return p;
}

// v2.1 round 258 (Terry) — carousel P4: extracted the layout→final-image-Buffer
// bake out of collage:saveLayout so a carousel can bake N pages with the SAME
// compositing pipeline. Pure function of `layout`; the single-collage handler and
// the per-slide carousel loop both call it, then do their own write/index/album.
// Throws (not returns) on empty / unreadable so callers' try/catch turns the SAME
// message strings into { success:false, error } — single-save stays byte-identical.
async function bakeCollageLayout(layout: CollageLayout): Promise<Buffer> {
  if (!layout || !layout.canvas || !Array.isArray(layout.items) || layout.items.length === 0) {
    throw new Error('Nothing to save — the collage is empty.');
  }
  {
    const sharp = (await import('sharp')).default;
    // v2.1 round 260 (Terry) — carousel wide: a carousel bakes ONE wide canvas
    // (width = pageCount*1080, up to 10*1080 = 10800) that the saveCarousel handler
    // then slices into N pages of exactly 1080×1350. So the W ceiling rises from
    // 2400 to 11000 to admit the wide strip; H stays ≤ 2400. CRITICAL: the wide W
    // must end up EXACTLY layout.canvas.w (= N*1080) so the slice boundaries fall on
    // clean 1080 multiples — the 11000 ceiling is comfortably above 10800 and never
    // clamps a valid carousel below N*1080. Single-collage saves pass normal sizes
    // (≤ 2400), so the raised ceiling is a no-op for them.
    const W = Math.max(600, Math.min(11000, Math.round(layout.canvas.w || 2000)));
    const H = Math.max(450, Math.min(2400, Math.round(layout.canvas.h || 1500)));
    const bg = hexToRgb(layout.canvas.bg || '#ffffff');
    // v2.1 round 177 (Terry) — transparent background: the removed areas (and
    // any canvas not covered by a tile) stay see-through, and the collage is
    // saved as a PNG instead of a flattened JPEG. Mutually exclusive with a
    // background photo (the UI clears one when you pick the other).
    const transparent = !!layout.canvas.transparent;
    // Generous padding so a rotated / dragged-to-the-edge tile never
    // overflows the composite base (sharp errors if an input extends
    // past the base bounds).
    // v2.1 round 260 (Terry) — carousel wide: PAD must be TILE-bounded, not
    // canvas-bounded. The old `0.8·W` was fine when W ≤ 2400 (PAD ≤ 1920), but on a
    // 10800-wide carousel it became ~8640px → a 28080-wide ×4-channel base ≈ 350 MB,
    // which OOMs sharp. The padding only needs to cover the LARGEST single tile when
    // rotated 45° about an on-canvas centre — independent of how wide the canvas is.
    //
    // v2.1 round 266 (Terry) — oversized tiles (≤ TILE_WFRAC_MAX× the canvas) can now
    // exceed the page, so round-260's "bound PAD by the LARGEST tile extent" would
    // re-introduce the OOM it cured: a 4× tile's full extent on a wide canvas is huge.
    // PAD only needs to cover how far a tile sticks OUT past the visible page rect
    // [0,W]×[0,H] — its OFF-PAGE OVERHANG. Any tile pixels beyond [0,W]×[0,H] are cut
    // by the final extract anyway; the base just has to physically contain each placed
    // tile's bbox (sharp throws if an input overruns the base, and the final safety
    // clamp ~L1527 would otherwise SHIFT an off-page tile back in, corrupting its
    // position — so PAD must equal the real overhang for legitimately off-page tiles).
    // For each tile: rotated half-extents hw,hh about centre (cx,cy); overhang on each
    // side = how far [cx-hw,cx+hw]×[cy-hh,cy+hh] exceeds [0,W]×[0,H]. A tile fully
    // on-page contributes 0 → a centred-but-oversized tile still only pads by its real
    // spill, never by the wide W. Half-extents are inflated 8% (FRAME_SLOP) so a frame
    // grown tile — whose true rotW/rotH the pre-scan can't see — still fits.
    const FRAME_SLOP = 1.08;
    let maxOverhangPx = 0;
    for (const it of layout.items) {
      if (!it) continue;
      const _aspect = Number.isFinite(it.aspect) && it.aspect > 0.01 ? it.aspect : 1;
      const _wFrac = Math.max(0.02, Math.min(TILE_WFRAC_MAX, it.wFrac || 0.3));
      const _iw = capTilePx(Math.max(2, Math.round(_wFrac * W)));
      const _ih = capTilePx(Math.max(2, Math.round(_iw / _aspect)));
      // Rotated bbox dims: rW = iw·|cos|+ih·|sin|, rH = iw·|sin|+ih·|cos|.
      const _rad = (((it.rot || 0) % 360) * Math.PI) / 180;
      const _c = Math.abs(Math.cos(_rad)), _s = Math.abs(Math.sin(_rad));
      const _hw = ((_iw * _c + _ih * _s) / 2) * FRAME_SLOP;
      const _hh = ((_iw * _s + _ih * _c) / 2) * FRAME_SLOP;
      // Box centre in page px (matches cx/cy used at composite time below).
      const _cx = clampTileX(it.xFrac) * W + _iw / 2;
      const _cy = clampTileY(it.yFrac) * H + _ih / 2;
      const _over = Math.max(
        _hw - _cx,            // spill past the LEFT edge (x=0)
        (_cx + _hw) - W,      // spill past the RIGHT edge (x=W)
        _hh - _cy,            // spill past the TOP edge (y=0)
        (_cy + _hh) - H,      // spill past the BOTTOM edge (y=H)
        0,
      );
      if (_over > maxOverhangPx) maxOverhangPx = _over;
    }
    // Floor preserves round-260's small rotation/rounding margin for the no-overhang
    // (on-page) case; +64 absolute slop covers feather/round-corner growth + rounding.
    const PAD = Math.ceil(maxOverhangPx) + 64 + Math.min(256, Math.round(H * 0.1));
    const baseW = W + PAD * 2;
    const baseH = H + PAD * 2;

    // v2.1 round 238 (Terry) — `blend` is optional (default 'over'); the grain
    // finishing layer uses 'overlay' to match the preview's mix-blend-mode. The
    // literals are all members of sharp's Blend union, so this stays assignable to
    // .composite()'s OverlayOptions[].
    const composites: Array<{ input: Buffer; left: number; top: number; blend?: 'over' | 'overlay' | 'soft-light' }> = [];
    for (const item of layout.items) {
      if (!item || !item.path || !fs.existsSync(toLongPath(item.path))) continue;
      try {
        const aspect = Number.isFinite(item.aspect) && item.aspect > 0.01 ? item.aspect : 1;
        // v2.1 round 266 (Terry) — oversized tiles: ceiling 1 → TILE_WFRAC_MAX, and the
        // box top-left clamps from [0,1] to the wide clampTileX/Y window so an off-page
        // tile composites at its TRUE position (was forced on-page). MUST mirror the PAD
        // pre-scan above exactly or the overhang estimate undersizes the base.
        const wFrac = Math.max(0.02, Math.min(TILE_WFRAC_MAX, item.wFrac || 0.3));
        const xFrac = clampTileX(item.xFrac);
        const yFrac = clampTileY(item.yFrac);
        const iw = capTilePx(Math.max(2, Math.round(wFrac * W)));
        const ih = capTilePx(Math.max(2, Math.round(iw / aspect)));
        // v2.1 round 263 (Terry) — bg-tile: a coverFill tile is a BACKGROUND fill —
        // the box (iw×ih above, computed from wFrac + the BOX aspect the renderer sent)
        // is covered by the photo via fit:'cover', with NO crop and NO zoom/pan (a
        // backdrop has none). For the locked full-canvas default wFrac=1 + box aspect =
        // canvas aspect, so iw=W, ih=H. Skipping crop/zoom below keeps the bake matching
        // the editor's genuine objectFit:'cover'. Centre position (not 'attention') so the
        // saved fill matches the editor's object-position:center.
        const isCover = !!item.coverFill;
        // v2.1 round 145 (Terry) — crop: convert the fractional rect to
        // oriented pixels (swap dims for EXIF 90/270) for sharp .extract.
        let cropRect: { left: number; top: number; width: number; height: number } | undefined;
        const cr = item.crop;
        if (!isCover && cr && (cr.l > 0.001 || cr.t > 0.001 || cr.r < 0.999 || cr.b < 0.999)) {
          try {
            const meta = await sharp(toLongPath(item.path), { failOnError: false }).metadata();
            let ow = meta.width || 0, oh = meta.height || 0;
            if (meta.orientation && meta.orientation >= 5) { const tmp = ow; ow = oh; oh = tmp; }
            const cl = clamp01(cr.l), ct = clamp01(cr.t), crr = clamp01(cr.r), cbb = clamp01(cr.b);
            if (ow > 0 && oh > 0 && crr > cl && cbb > ct) {
              cropRect = {
                left: Math.round(cl * ow), top: Math.round(ct * oh),
                width: Math.max(1, Math.min(ow - Math.round(cl * ow), Math.round((crr - cl) * ow))),
                height: Math.max(1, Math.min(oh - Math.round(ct * oh), Math.round((cbb - ct) * oh))),
              };
            }
          } catch { /* crop best-effort; fall back to full image */ }
        }
        // v2.1 round 168 (Terry) — Ctrl+scroll photo zoom (1–2×): magnify the
        // centre of the visible region by insetting the extract rect to its
        // centre 1/zoom (defaulting to the full photo when there's no crop).
        // One extract → resize, so the saved file matches the editor preview.
        const _zoom = Math.max(1, Math.min(2, item.zoom || 1));
        if (!isCover && _zoom > 1) {
          let region = cropRect;
          if (!region) {
            try {
              const meta = await sharp(toLongPath(item.path), { failOnError: false }).metadata();
              let ow = meta.width || 0, oh = meta.height || 0;
              if (meta.orientation && meta.orientation >= 5) { const tmp = ow; ow = oh; oh = tmp; }
              if (ow > 0 && oh > 0) region = { left: 0, top: 0, width: ow, height: oh };
            } catch { /* zoom best-effort */ }
          }
          if (region) {
            const insetX = region.width * (1 - 1 / _zoom) / 2;
            const insetY = region.height * (1 - 1 / _zoom) / 2;
            // v2.1 round 169 (Terry) — pan shift: panX/panY (−1..1) move the
            // extract within the slack (±inset), matching the editor's pan.
            const panShiftX = Math.max(-1, Math.min(1, item.panX || 0)) * insetX;
            const panShiftY = Math.max(-1, Math.min(1, item.panY || 0)) * insetY;
            cropRect = {
              left: Math.round(region.left + insetX + panShiftX),
              top: Math.round(region.top + insetY + panShiftY),
              width: Math.max(1, Math.round(region.width / _zoom)),
              height: Math.max(1, Math.round(region.height / _zoom)),
            };
          }
        }
        // Bake the tile (crop + resize + its own Enhance state + frame).
        // The result may be larger than iw×ih if a frame was added, so
        // read its real dims back.
        const baked = await buildCollageTilePipeline(sharp, toLongPath(item.path), iw, ih, item.enh, cropRect, isCover ? 'centre' : 'attention', !!item.bgRemoved)
          .png()
          .toBuffer({ resolveWithObject: true });
        let tile = baked.data;
        let rotW = baked.info.width, rotH = baked.info.height;
        // v2.1 round 150 (Terry) — Blend: feather the (framed) tile's edges
        // BEFORE rotation, so the soft band aligns with the tile rectangle.
        // v2.1 round 164 (Terry) — round corners + feather the (framed) tile's
        // edges BEFORE rotation, so the shape aligns with the tile rectangle.
        // No-op when neither corners nor blend are set.
        if (item.enh) {
          tile = await roundedFeatherMask(sharp, tile, rotW, rotH, item.enh.corners, item.enh.blend);
        }
        // v2.1 round 294 (Terry) — PER-PHOTO vignette + grain: composite the same SVGs the
        // whole-collage finish uses, but sized to THIS tile, then re-clip to the tile's own
        // alpha so a rounded / cut-out tile keeps its shape (no black corners). Mirrors the
        // editor's per-tile .ct-vig / .ct-grain overlays. Before rotation so it turns with the photo.
        if (item.enh) {
          const tvig = Math.max(0, Math.min(100, Number(item.enh.vignette) || 0));
          const tgrain = Math.max(0, Math.min(150, Number(item.enh.grain) || 0));
          if (tvig > 0 || tgrain > 0) {
            try {
              const tLayers: Array<{ input: Buffer; blend: 'over' | 'overlay' }> = [];
              if (tvig > 0) tLayers.push({ input: await sharp(Buffer.from(buildCollageVignetteSvg(rotW, rotH, tvig, String(item.enh.vignetteShape || 'ellipse')))).png().toBuffer(), blend: 'over' });
              if (tgrain > 0) tLayers.push({ input: await sharp(Buffer.from(buildCollageGrainSvg(rotW, rotH, tgrain))).png().toBuffer(), blend: 'overlay' });
              if (tLayers.length) {
                const tileAlpha = tile;   // the shaped tile carries the correct alpha
                const shaded = await sharp(tile).ensureAlpha().composite(tLayers).png().toBuffer();
                tile = await sharp(shaded).composite([{ input: tileAlpha, blend: 'dest-in' }]).png().toBuffer();
              }
            } catch (vgErr) {
              log.warn(`[collage] per-tile vignette/grain skipped (non-fatal): ${(vgErr as Error).message}`);
            }
          }
        }
        const rot = ((item.rot || 0) % 360 + 360) % 360;
        if (rot > 0.1 && rot < 359.9) {
          const rotated = await sharp(tile)
            .rotate(rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer({ resolveWithObject: true });
          tile = rotated.data;
          rotW = rotated.info.width;
          rotH = rotated.info.height;
        }
        // v2.1 round 143 (Terry) — per-tile transparency. Multiply the
        // tile's alpha by `opacity` via a dest-in composite with a
        // uniform-alpha layer (Porter-Duff dest-in = dest × src.alpha),
        // so it works whether or not the tile already has alpha (frame /
        // rotation). Skipped when opaque.
        const op = item.enh && item.enh.opacity != null ? Math.max(0.1, Math.min(1, item.enh.opacity)) : 1;
        if (op < 1) {
          const mask = await sharp({ create: { width: rotW, height: rotH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: op } } }).png().toBuffer();
          tile = await sharp(tile).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
        }
        // Centre on the unframed box centre — a frame grows the tile
        // symmetrically, so the centre is unchanged.
        const cx = xFrac * W + iw / 2;
        const cy = yFrac * H + ih / 2;
        let left = Math.round(cx - rotW / 2) + PAD;
        let top = Math.round(cy - rotH / 2) + PAD;
        // Final safety clamp so the tile always sits within the base.
        left = Math.max(0, Math.min(baseW - rotW, left));
        top = Math.max(0, Math.min(baseH - rotH, top));
        composites.push({ input: tile, left, top });
      } catch (cellErr) {
        log.warn(`[collage] skipped a photo (${item.path}): ${(cellErr as Error).message}`);
      }
    }
    if (composites.length === 0) throw new Error('None of the photos could be read.');

    // v2.1 round 235 (Terry) — optional GRADIENT background (phase 1 of "Background
    // textures"). Rasterize the gradient SVG at the OUTPUT W×H via sharp and prepend
    // it as the BOTTOM layer (under the tiles), matching the editor's CSS gradient
    // preview (see buildCollageGradientSvg for the CSS-angle↔SVG-vector mapping).
    // Mutually exclusive with transparent + a bg photo (the editor clears those when
    // a gradient is chosen), so it can't double-composite with the bg-photo below.
    const gradient = transparent ? undefined : layout.canvas.gradient;
    // v2.1 round 239 (Terry) — MESH is base+blobs (no stops); route it to the mesh
    // bake. Linear/radial still use buildCollageGradientSvg (stops-based). Either way
    // the rasterized SVG is prepended as the BOTTOM layer (under the tiles).
    if (gradient && gradient.kind === 'mesh' && Array.isArray(gradient.blobs) && gradient.blobs.length >= 1) {
      try {
        const svg = buildCollageMeshSvg(W, H, gradient);
        const gradBuf = await sharp(Buffer.from(svg)).png().toBuffer();
        composites.unshift({ input: gradBuf, left: PAD, top: PAD });
      } catch (gradErr) {
        log.warn(`[collage] mesh background skipped (non-fatal): ${(gradErr as Error).message}`);
      }
    } else if (gradient && Array.isArray(gradient.stops) && gradient.stops.length >= 1) {
      try {
        // buildCollageGradientSvg takes the stops-based shape; the wider union's
        // optional stops are guaranteed present in this branch.
        const svg = buildCollageGradientSvg(W, H, { kind: gradient.kind === 'radial' ? 'radial' : 'linear', angle: gradient.angle, stops: gradient.stops });
        const gradBuf = await sharp(Buffer.from(svg)).png().toBuffer();
        composites.unshift({ input: gradBuf, left: PAD, top: PAD });
      } catch (gradErr) {
        log.warn(`[collage] gradient background skipped (non-fatal): ${(gradErr as Error).message}`);
      }
    }

    // v2.1 round 244 (Terry) — optional close-up MATERIAL SURFACE background. Rasterize
    // the full-canvas feTurbulence surface SVG at the OUTPUT W×H via sharp and prepend it
    // as the BOTTOM layer (under the tiles), matching the editor's full-canvas preview
    // (fixed 1000×1000 viewBox → identical noise scale). Mutually exclusive with gradient
    // + transparent + a bg photo (the editor clears those when a texture is chosen), so it
    // can't double-composite. The surface rect is opaque,
    // so it fully covers the base bg colour underneath.
    const texture = transparent ? undefined : layout.canvas.texture;
    if (texture && texture.id) {
      try {
        const svg = buildCollageTextureSvg(W, H, texture.id);
        if (svg) {
          const texBuf = await sharp(Buffer.from(svg)).png().toBuffer();
          composites.unshift({ input: texBuf, left: PAD, top: PAD });
        }
      } catch (texErr) {
        log.warn(`[collage] texture background skipped (non-fatal): ${(texErr as Error).message}`);
      }
    }

    // v2.1 round 142 (Terry) — optional background PHOTO, faded over the
    // solid colour at `opacity`. Prepended (bottom layer) so the tiles
    // sit on top. Resized cover to the canvas, alpha set to opacity so
    // the solid bg colour shows through underneath (the "Fade" slider).
    const bgImage = transparent ? undefined : layout.canvas.bgImage;
    if (bgImage && bgImage.path && fs.existsSync(toLongPath(bgImage.path))) {
      try {
        const op = Math.max(0, Math.min(1, Number.isFinite(bgImage.opacity) ? bgImage.opacity : 0.4));
        // v2.1 round 149 (Terry) — the background is enhanceable now: bake
        // its own Look/levels through the SAME tile pipeline (no crop, no
        // frame — borderColor is always '' for a background), then apply the
        // Fade via the alpha exactly as before.
        // v2.1 round 160 (Terry) — 'centre' so the saved background matches
        // the editor's centered cover (was 'attention' → shifted on save).
        const bgPipe = bgImage.enh
          ? buildCollageTilePipeline(sharp, toLongPath(bgImage.path), W, H, bgImage.enh, undefined, 'centre')
          : sharp(toLongPath(bgImage.path), { failOnError: false }).rotate().resize(W, H, { fit: 'cover', position: 'centre' });
        let bgBuf = await bgPipe
          .removeAlpha()      // drop any source alpha so the fade is uniform
          .ensureAlpha(op)    // whole image at `opacity` → bg colour shows through
          .png()
          .toBuffer();
        // v2.1 round 150 — Blend on the background = vignette its edges to
        // the base colour at the canvas border.
        const bgEnh2 = (bgImage.enh || {}) as CollageEnhance;
        bgBuf = await roundedFeatherMask(sharp, bgBuf, W, H, bgEnh2.corners, bgEnh2.blend);
        composites.unshift({ input: bgBuf, left: PAD, top: PAD });
      } catch (bgErr) {
        log.warn(`[collage] background image skipped (non-fatal): ${(bgErr as Error).message}`);
      }
    }

    // v2.1 round 185 (Text #1) — composite the text layers ON TOP of the tiles
    // (and background). Each pngBase64 is a transparent PNG already rendered at
    // the OUTPUT short side by the renderer's renderTextToCanvas, so it lands at
    // the same relative position + size as the on-screen preview. We only decode
    // + place it (optionally rotating about its centre). Anchored CENTRE at
    // xFrac/yFrac, in the SAME +PAD coordinate system as the tiles, then clamped
    // to the padded base. The generous PAD means the clamp effectively never
    // fires (a centre-on-canvas layer can't reach a negative origin); if a future
    // huge layer did, it clamps to the base edge rather than erroring.
    if (Array.isArray(layout.texts)) {
      for (const t of layout.texts) {
        if (!t || !t.pngBase64) continue;
        try {
          const b64 = t.pngBase64.replace(/^data:image\/png;base64,/, '');
          let textBuf = Buffer.from(b64, 'base64');
          let textW = 0, textH = 0;
          const rot = ((t.rot || 0) % 360 + 360) % 360;
          if (rot > 0.1 && rot < 359.9) {
            const rotated = await sharp(textBuf)
              .rotate(rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
              .png()
              .toBuffer({ resolveWithObject: true });
            textBuf = rotated.data;
            textW = rotated.info.width;
            textH = rotated.info.height;
          } else {
            const meta = await sharp(textBuf).metadata();
            textW = meta.width || 0;
            textH = meta.height || 0;
          }
          if (textW < 1 || textH < 1) continue;
          const cx = clamp01(t.xFrac) * W;
          const cy = clamp01(t.yFrac) * H;
          let left = Math.round(cx - textW / 2) + PAD;
          let top = Math.round(cy - textH / 2) + PAD;
          left = Math.max(0, Math.min(baseW - textW, left));
          top = Math.max(0, Math.min(baseH - textH, top));
          composites.push({ input: textBuf, left, top });
        } catch (txtErr) {
          log.warn(`[collage] text layer skipped (non-fatal): ${(txtErr as Error).message}`);
        }
      }
    }

    // v2.1 round 238 (Terry) — WHOLE-COLLAGE finishing treatments (Vignette + Grain),
    // composited as the TOP layer over the finished collage (tiles + bg + text), AFTER
    // everything else, so they're whole-image finishes independent of the bg kind —
    // matching the editor's canvas overlays (z above the tiles + text). Both span the
    // visible W×H at +PAD so they register exactly with the extracted output. 0 = skip.
    const vignette = Math.max(0, Math.min(100, Number(layout.canvas.vignette) || 0));
    if (vignette > 0) {
      try {
        const vigBuf = await sharp(Buffer.from(buildCollageVignetteSvg(W, H, vignette, String(layout.canvas.vignetteShape || 'ellipse')))).png().toBuffer();
        composites.push({ input: vigBuf, left: PAD, top: PAD });
      } catch (vigErr) {
        log.warn(`[collage] vignette skipped (non-fatal): ${(vigErr as Error).message}`);
      }
    }
    // v2.1 round 325 (Terry) — grain 0-100 (doubled effect); bake matches the preview.
    const grain = Math.max(0, Math.min(100, Number(layout.canvas.grain) || 0));
    if (grain > 0) {
      try {
        const grainBuf = await sharp(Buffer.from(buildCollageGrainSvg(W, H, grain))).png().toBuffer();
        // 'overlay' blend matches the preview's mix-blend-mode:overlay (the SVG already
        // carries the slider-scaled opacity on its rect).
        composites.push({ input: grainBuf, left: PAD, top: PAD, blend: 'overlay' });
      } catch (grainErr) {
        log.warn(`[collage] grain skipped (non-fatal): ${(grainErr as Error).message}`);
      }
    }

    // Two pipelines, deliberately: sharp applies .composite() at the
    // END of a pipeline, AFTER .extract(). Chaining composite→extract in
    // one call would crop the still-empty padded base first, then drop
    // the +PAD-offset tiles off the small canvas (a blank background was
    // the symptom). So composite onto the padded base → buffer, then
    // extract the centre region in a fresh pipeline.
    const paddedBuf = await sharp({
      create: { width: baseW, height: baseH, channels: 4, background: transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : { ...bg, alpha: 1 } },
    })
      .composite(composites)
      .png()
      .toBuffer();
    // Transparent → keep the alpha + save PNG; otherwise flatten onto the bg
    // colour + save JPEG (smaller, no needless alpha).
    const collageBuf = transparent
      ? await sharp(paddedBuf).extract({ left: PAD, top: PAD, width: W, height: H }).png().toBuffer()
      : await sharp(paddedBuf).extract({ left: PAD, top: PAD, width: W, height: H }).flatten({ background: bg }).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    log.info(`[collage] baked composite (${composites.length} photos, ${W}×${H})`);
    return collageBuf;
  }
}

ipcMain.handle('collage:saveLayout', async (_event, layout: CollageLayout) => {
  try {
    // v2.1 round 258 (Terry) — carousel P4: bake via the shared helper, then the
    // unchanged write/index/album tail. W/H/transparent are pure fns of the canvas
    // (same clamp as inside the bake), so recomputing them here is exact.
    const collageBuf = await bakeCollageLayout(layout);
    const W = Math.max(600, Math.min(2400, Math.round(layout.canvas.w || 2000)));
    const H = Math.max(450, Math.min(2400, Math.round(layout.canvas.h || 1500)));
    const transparent = !!layout.canvas.transparent;

    const capturedAt = new Date();
    const { date, time, month } = timestampParts(capturedAt);
    const libRoot = onlineLibraryRoot();
    const destDir = libRoot ? path.join(libRoot, 'PDR Captures', month) : pendingDir();
    fs.mkdirSync(toLongPath(destDir), { recursive: true });
    const outPath = uniqueCapturePath(destDir, `${date}_${time}_CO`, transparent ? '.png' : '.jpg');
    fs.writeFileSync(toLongPath(outPath), collageBuf);
    const filename = path.basename(outPath);
    await stampCaptureMetadata(outPath, capturedAt, 'collage');

    let fileId: number | null = null;
    if (libRoot) {
      try {
        fileId = await indexCapturedFile(outPath, libRoot, capturedAt, W, H, 'photo');
        if (fileId != null) broadcast('library:filesAdded', { reason: 'collage', newFilePath: outPath, fileId });
        // v2.1 round 161 (Terry) — every saved collage joins a "PDR Collages"
        // album (created on first save), so they're all gathered in one place
        // in the Albums view. Non-fatal: a failure here never blocks the save.
        // v2.1 round 162 (Terry) — gated on Settings → Capture toggle (default on).
        const wantCollagesAlbum = (() => { try { return getSettings().saveCollagesToAlbum !== false; } catch { return true; } })();
        if (fileId != null && wantCollagesAlbum) {
          try {
            const { listAlbums, createUserAlbum, addPhotosToAlbum } = await import('./search-database.js');
            const ALBUM_TITLE = 'PDR Collages';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const existing = (listAlbums() as any[]).find((a) => (a && a.title || '').toLowerCase() === ALBUM_TITLE.toLowerCase());
            const albumId = existing ? existing.id : createUserAlbum(ALBUM_TITLE);
            if (albumId != null) addPhotosToAlbum(albumId, [fileId]);
          } catch (albErr) {
            log.warn(`[collage] add to "PDR Collages" album failed (non-fatal): ${(albErr as Error).message}`);
          }
        }
      } catch (idxErr) {
        log.warn(`[collage] composite index pass failed (file saved): ${(idxErr as Error).message}`);
      }
    }
    log.info(`[collage] saved freeform composite ${filename} (${W}×${H})${fileId != null ? ` → id ${fileId}` : libRoot ? '' : ' → pending'}`);
    return { success: true, filePath: outPath, filename, fileId, pending: !libRoot };
  } catch (err) {
    log.warn(`[collage] saveLayout failed: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  }
});

// v2.1 round 260 (Terry) — carousel wide: SLICED EXPORT. The carousel is now ONE
// WIDE canvas (layout.canvas.w = pageCount*1080, h = 1350). We bake it ONCE through
// the shared pipeline (bakeCollageLayout) — so a spanning gradient / background / tile
// is rendered continuously across the whole strip — then crop N slices of EXACTLY
// 1080×1350 from the single baked buffer. Bake-once+extract (vs N separate bakes) is
// chosen so the seams between slides are pixel-continuous: any cross-page element is
// composited in one coordinate system and only cut afterwards, leaving no resize /
// rounding mismatch at the 1080 boundaries.
//
// Each slice is written into ONE dedicated subfolder `PDR Captures/<month>/
// Carousel_<YYYYMMDD_HHmmss>/` as slide_01.jpg … slide_NN.jpg (slide_NN.png when the
// canvas is transparent), then stamped + indexed (each at 1080×1350) + added to the
// "PDR Carousels" album (same Settings gate as the single save, separate album) — the
// index/album tail is the SAME as the per-slide loop it replaces. v2.1 round 273 (Terry):
// carousels get their OWN "PDR Carousels" album (single collages stay in "PDR Collages").
// Returns the file list + folder so the
// renderer reveals the folder (a single Viewer open is wrong for N files). Shape
// unchanged: { success, files, folderPath, count, pending }.
const CAROUSEL_SLICE_W = 1080;
const CAROUSEL_SLICE_H = 1350;
ipcMain.handle('collage:saveCarousel', async (_event, layout: CollageLayout, pageCount: number) => {
  try {
    const n = Math.max(1, Math.round(Number(pageCount) || 0));
    if (!layout || !layout.canvas || !Array.isArray(layout.items) || layout.items.length === 0) {
      return { success: false, error: 'Nothing to save — the carousel is empty.' };
    }
    // Bake the WHOLE wide canvas once. bakeCollageLayout throws on empty/unreadable,
    // turning the same message strings into { success:false, error } via the catch.
    const wideBuf = await bakeCollageLayout(layout);
    const sharp = (await import('sharp')).default;
    // The wide bake width MUST equal pageCount*1080 so the crops land on clean 1080
    // boundaries (bakeCollageLayout's W ceiling is 11000, above 10*1080, so it never
    // clamps a valid carousel below N*1080). Read the real baked dims back and assert
    // every slice fits — never extract past the buffer (sharp would throw).
    const wideMeta = await sharp(wideBuf).metadata();
    const wideWidth = wideMeta.width || 0;
    const wideHeight = wideMeta.height || 0;
    const transparent = !!(layout.canvas && layout.canvas.transparent);

    const capturedAt = new Date();
    const { month } = timestampParts(capturedAt);
    const stamp = `${capturedAt.getFullYear()}${pad(capturedAt.getMonth() + 1)}${pad(capturedAt.getDate())}_${pad(capturedAt.getHours())}${pad(capturedAt.getMinutes())}${pad(capturedAt.getSeconds())}`;
    const libRoot = onlineLibraryRoot();
    const baseDir = libRoot ? path.join(libRoot, 'PDR Captures', month) : pendingDir();
    const folderPath = path.join(baseDir, `Carousel_${stamp}`);
    fs.mkdirSync(toLongPath(folderPath), { recursive: true });

    // Album helpers imported once (not per slide). Same Settings gate + lookup/create
    // pattern as the single save, but carousel slides land in their OWN "PDR Carousels"
    // album (kept separate from single collages' "PDR Collages").
    // v2.1 round 273 (Terry) — route carousels into "PDR Carousels" (was "PDR Collages").
    const wantCollagesAlbum = (() => { try { return getSettings().saveCollagesToAlbum !== false; } catch { return true; } })();
    let albumId: number | null = null;
    let addPhotosToAlbum: ((id: number, ids: number[]) => unknown) | null = null;
    if (libRoot && wantCollagesAlbum) {
      try {
        const sdb = await import('./search-database.js');
        const ALBUM_TITLE = 'PDR Carousels'; // v2.1 round 273 (Terry)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existing = (sdb.listAlbums() as any[]).find((a) => (a && a.title || '').toLowerCase() === ALBUM_TITLE.toLowerCase());
        albumId = existing ? existing.id : sdb.createUserAlbum(ALBUM_TITLE);
        addPhotosToAlbum = sdb.addPhotosToAlbum;
      } catch (albErr) {
        log.warn(`[collage] carousel "PDR Carousels" album prep failed (non-fatal): ${(albErr as Error).message}`); // v2.1 round 273 (Terry)
      }
    }

    const files: Array<{ filePath: string; filename: string; fileId: number | null }> = [];
    for (let i = 0; i < n; i++) {
      const left = i * CAROUSEL_SLICE_W;
      // Slice-accuracy guard: the crop must sit wholly inside the baked buffer.
      // If the bake came back narrower than expected (clamp / unexpected dims),
      // stop rather than ask sharp to extract past the edge (which throws).
      if (left + CAROUSEL_SLICE_W > wideWidth || CAROUSEL_SLICE_H > wideHeight) {
        log.warn(`[collage] carousel slice ${i + 1} out of bounds (left ${left}+${CAROUSEL_SLICE_W} > wide ${wideWidth}×${wideHeight}) — stopping`);
        break;
      }
      let buf: Buffer;
      try {
        // Each slice is EXACTLY 1080×1350. PNG when transparent (keep alpha),
        // else mozjpeg q92 — matching the single-collage encoder choice.
        const slice = sharp(wideBuf).extract({ left, top: 0, width: CAROUSEL_SLICE_W, height: CAROUSEL_SLICE_H });
        buf = transparent
          ? await slice.png().toBuffer()
          : await slice.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
      } catch (sliceErr) {
        log.warn(`[collage] carousel slice ${i + 1} extract failed (${(sliceErr as Error).message})`);
        continue;
      }
      const filename = `slide_${String(i + 1).padStart(2, '0')}${transparent ? '.png' : '.jpg'}`;
      const outPath = path.join(folderPath, filename);
      fs.writeFileSync(toLongPath(outPath), buf);
      await stampCaptureMetadata(outPath, capturedAt, 'collage');

      let fileId: number | null = null;
      if (libRoot) {
        try {
          // Each slide is indexed at its true 1080×1350 (not the wide canvas dims).
          fileId = await indexCapturedFile(outPath, libRoot, capturedAt, CAROUSEL_SLICE_W, CAROUSEL_SLICE_H, 'photo');
          if (fileId != null) broadcast('library:filesAdded', { reason: 'collage', newFilePath: outPath, fileId });
          if (fileId != null && albumId != null && addPhotosToAlbum) {
            try { addPhotosToAlbum(albumId, [fileId]); }
            catch (albErr) { log.warn(`[collage] carousel slide ${i + 1} album-add failed (non-fatal): ${(albErr as Error).message}`); }
          }
        } catch (idxErr) {
          log.warn(`[collage] carousel slide ${i + 1} index pass failed (file saved): ${(idxErr as Error).message}`);
        }
      }
      files.push({ filePath: outPath, filename, fileId });
    }

    if (files.length === 0) {
      return { success: false, error: 'None of the slides could be saved.' };
    }
    log.info(`[collage] saved carousel — ${files.length}/${n} slide(s) sliced from ${wideWidth}×${wideHeight} → ${folderPath}${libRoot ? '' : ' (pending)'}`);
    return { success: true, files, folderPath, count: files.length, pending: !libRoot };
  } catch (err) {
    log.warn(`[collage] saveCarousel failed: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  }
});

// v2.1 round 182 (Terry) — save the single-photo Viewer's background cut-out as a
// new transparent PNG in the library. The temp file is ALREADY a transparent PNG
// (the bg-remover worker's output) — copy its bytes verbatim (no re-encode/flatten)
// into PDR Captures and index it, mirroring the tail of collage:saveLayout. Unlike
// collages it does NOT join the "PDR Collages" album.
ipcMain.handle(
  'viewer:saveCutout',
  async (
    _event,
    req: {
      tempPath: string;
      originalPath?: string;
      // v2.1 round 184 (Terry) — the backdrop the cut-out is placed on.
      bg?: { type: 'transparent' | 'color' | 'photo'; value: string };
    },
  ) => {
    try {
      if (!req || !req.tempPath || !fs.existsSync(toLongPath(req.tempPath))) {
        return { success: false, error: 'Cut-out not found.' };
      }
      const sharp = (await import('sharp')).default;
      const capturedAt = new Date();
      const { date, time, month } = timestampParts(capturedAt);
      const libRoot = onlineLibraryRoot();
      const destDir = libRoot ? path.join(libRoot, 'PDR Captures', month) : pendingDir();
      fs.mkdirSync(toLongPath(destDir), { recursive: true });
      const base = req.originalPath
        ? `${path.basename(req.originalPath, path.extname(req.originalPath))}_BG`
        : `${date}_${time}_BG`;

      // v2.1 round 184 (Terry) — compose the cut-out onto the chosen backdrop:
      //  • transparent / missing → keep today's behaviour: the temp PNG verbatim.
      //  • colour → flatten the transparent areas to the colour → JPEG.
      //  • photo  → cover-fit the backdrop photo to the cut-out's pixel size,
      //    composite the cut-out over it → JPEG.
      const bgType = req.bg?.type;
      let outBuf: Buffer;
      let ext: '.png' | '.jpg';
      if (bgType === 'color') {
        outBuf = await sharp(toLongPath(req.tempPath))
          .flatten({ background: hexToRgb(req.bg?.value || '#ffffff') })
          .jpeg({ quality: 92 })
          .toBuffer();
        ext = '.jpg';
      } else if (bgType === 'photo' && req.bg?.value && fs.existsSync(toLongPath(req.bg.value))) {
        const cutMeta = await sharp(toLongPath(req.tempPath)).metadata();
        const cutW = cutMeta.width ?? 0;
        const cutH = cutMeta.height ?? 0;
        if (cutW > 0 && cutH > 0) {
          const bgBuf = await sharp(toLongPath(req.bg.value))
            .resize(cutW, cutH, { fit: 'cover', position: 'attention' })
            .toBuffer();
          outBuf = await sharp(bgBuf)
            .composite([{ input: toLongPath(req.tempPath) }])
            .jpeg({ quality: 92 })
            .toBuffer();
          ext = '.jpg';
        } else {
          // Degenerate cut-out size — fall back to the verbatim transparent PNG.
          outBuf = fs.readFileSync(toLongPath(req.tempPath));
          ext = '.png';
        }
      } else {
        // transparent / missing → verbatim transparent PNG (unchanged behaviour).
        outBuf = fs.readFileSync(toLongPath(req.tempPath));
        ext = '.png';
      }

      const outPath = uniqueCapturePath(destDir, base, ext);
      fs.writeFileSync(toLongPath(outPath), outBuf);
      const filename = path.basename(outPath);
      await stampCaptureMetadata(outPath, capturedAt, 'cutout');

      let fileId: number | null = null;
      if (libRoot) {
        try {
          const meta = await sharp(outBuf).metadata();
          fileId = await indexCapturedFile(outPath, libRoot, capturedAt, meta.width ?? null, meta.height ?? null, 'photo');
          if (fileId != null) broadcast('library:filesAdded', { reason: 'cutout', newFilePath: outPath, fileId });
        } catch (idxErr) {
          log.warn(`[cutout] index pass failed (file saved): ${(idxErr as Error).message}`);
        }
      }
      log.info(`[cutout] saved ${ext === '.jpg' ? 'composite JPEG' : 'transparent PNG'} ${filename}${fileId != null ? ` → id ${fileId}` : libRoot ? '' : ' → pending'}`);
      return { success: true, filePath: outPath, filename, fileId, pending: !libRoot };
    } catch (err) {
      log.warn(`[cutout] saveCutout failed: ${(err as Error).message}`);
      return { success: false, error: (err as Error).message };
    }
  },
);

// ─── Global hotkey ───────────────────────────────────────────────────────────

let currentAccelerator: string | null = null;

/**
 * (Re-)register the screenshot hotkey from settings. Always
 * unregisters the previous accelerator first, so this doubles as the
 * "user remapped it in Settings → Capture" handler. What the hotkey
 * DOES (full screen vs region overlay) is read from settings at fire
 * time, so flipping the Settings → Capture action radio needs no
 * re-registration. Registration can legitimately fail when another
 * app owns the combo — the title-bar button is unaffected, so we log
 * + report rather than throw.
 */
export function registerCaptureHotkey(): { registered: boolean; accelerator: string } {
  const accelerator = (() => {
    try { return getSettings().captureHotkey || 'Ctrl+Shift+S'; } catch { return 'Ctrl+Shift+S'; }
  })();
  if (currentAccelerator) {
    try { globalShortcut.unregister(currentAccelerator); } catch { /* non-fatal */ }
    currentAccelerator = null;
  }
  let registered = false;
  try {
    registered = globalShortcut.register(accelerator, () => {
      const action = (() => {
        try { return getSettings().captureHotkeyAction || 'fullscreen'; } catch { return 'fullscreen'; }
      })();
      const fire = action === 'region' ? captureRegion : captureScreenshot;
      void fire({ trigger: 'hotkey' }).catch((err) =>
        log.warn(`[capture] hotkey capture failed: ${(err as Error).message}`),
      );
    });
  } catch (err) {
    log.warn(`[capture] hotkey registration threw: ${(err as Error).message}`);
  }
  if (registered) currentAccelerator = accelerator;
  log.info(`[capture] global hotkey ${accelerator} ${registered ? 'registered' : 'NOT registered (likely in use by another app)'}`);
  return { registered, accelerator };
}

export function unregisterCaptureHotkey(): void {
  if (currentAccelerator) {
    try { globalShortcut.unregister(currentAccelerator); } catch { /* non-fatal */ }
    currentAccelerator = null;
  }
}

// ─── Conflicting capture-tool detection ──────────────────────────────────────

// v2.1 round 124 (Terry 2026-06-11) — Terry's Ctrl+Shift+S presses
// never reached PDR despite successful RegisterHotKey: Lightshot was
// running and its keyboard HOOK consumed the combo before Windows
// generated WM_HOTKEY (hooks always outrank hotkey registrations).
// Windows can't tell us who ate a keystroke, but we CAN name the
// known capture tools currently running so Settings → Capture turns
// "the hotkey does nothing" from a mystery into a guided fix.
const KNOWN_CAPTURE_TOOLS: Array<{ match: RegExp; label: string }> = [
  { match: /lightshot/i, label: 'Lightshot' },
  { match: /sharex/i, label: 'ShareX' },
  { match: /greenshot/i, label: 'Greenshot' },
  { match: /snagit|snagpriv/i, label: 'Snagit' },
  { match: /picpick/i, label: 'PicPick' },
  { match: /screenpresso/i, label: 'Screenpresso' },
  { match: /flameshot/i, label: 'Flameshot' },
  // Round 125 — not a capture tool, but it's the tool that actually
  // ate Terry's hotkey (its own capture feature showed the red
  // corner UI). Any shortcut-hooking utility belongs on this list.
  { match: /mousewithoutborders/i, label: 'Mouse Without Borders' },
];

export function checkConflictingCaptureTools(): string[] {
  try {
    const out = execSync('tasklist /fo csv /nh', { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const found: string[] = [];
    for (const tool of KNOWN_CAPTURE_TOOLS) {
      if (tool.match.test(out)) found.push(tool.label);
    }
    return found;
  } catch {
    return [];
  }
}

// ─── Screen recording (step 3) ───────────────────────────────────────────────
//
// The recording ENGINE lives in the floating widget's renderer — a
// small frameless always-on-top window (content-protected, so it
// never appears in the recording itself) that owns getUserMedia +
// MediaRecorder and streams WebM chunks to main over IPC. Main
// appends them to a temp .webm as they arrive (no renderer memory
// growth on long recordings), then on stop pipes the WebM through
// the bundled FFmpeg → H.264/AAC MP4 with +faststart (PDRV scrubbing
// needs the moov atom up front) and lands it via the same
// persist/index/broadcast pipeline as screenshots — filename suffix
// _SR, fileType 'video'.
//
// PDR's own windows are deliberately NOT hidden or minimised when a
// recording starts — recording is a session the user orchestrates
// (they may well be recording PDR itself), unlike the instantaneous
// screenshot where "get PDR out of the shot" is almost always right.

// Round 129 (Terry) — recording is TWO-STAGE. Clicking record first
// ESTABLISHES what's being recorded (screen via the picker, then the
// area via the freeze-frame selector: click a window, drag a region,
// or Enter for the whole screen). That arms the bar in a pre-record
// state — the user can set up the cam, change quality, make a cup of
// tea — and NOTHING is captured until they press Record on the bar.
// 'armed' is that waiting state; the temp file, the stream, and the
// filename timestamp are all created at the actual Record press.
let recordingState: 'idle' | 'armed' | 'recording' | 'processing' = 'idle';
let recordWidget: BrowserWindow | null = null;
let recordTempPath: string | null = null;
let recordStream: fs.WriteStream | null = null;
let recordStartedAt: Date | null = null;
let recordDisplay: Electron.Display | null = null;
let recordQuality: 'high' | 'standard' | 'compact' = 'standard';
let recordMeta: { width: number | null; height: number | null; hasAudio: boolean } = { width: null, height: null, hasAudio: false };
// Round 129 — region recording: the chosen area in VIDEO pixels
// (null = whole screen). The capture itself is always full-screen;
// FFmpeg crops at save time (same zero-live-cost pattern as blur).
let recordRegionCrop: SelectionRect | null = null;
// The same region in display CSS pixels — what the on-screen marker
// draws, and what the armed-stage Area re-pick replaces.
let recordRegionCssRect: SelectionRect | null = null;
// Click-through, content-protected outline marking the recorded
// region on screen — the USER sees the boundary, the footage doesn't.
let regionMarkerWindow: BrowserWindow | null = null;

/** Map an overlay selection (display CSS px) to a video-pixel crop;
 *  a selection covering (effectively) the whole display means no
 *  crop at all. */
function computeRegionCrop(areaRect: SelectionRect, display: Electron.Display, grabW: number, grabH: number): SelectionRect | null {
  const coversAll =
    areaRect.x <= 2 && areaRect.y <= 2 &&
    areaRect.width >= display.bounds.width - 4 &&
    areaRect.height >= display.bounds.height - 4;
  if (coversAll) return null;
  const scaleX = grabW / display.bounds.width;
  const scaleY = grabH / display.bounds.height;
  const even = (n: number) => Math.max(0, 2 * Math.floor(n / 2));
  const x = even(areaRect.x * scaleX);
  const y = even(areaRect.y * scaleY);
  let width = even(areaRect.width * scaleX);
  let height = even(areaRect.height * scaleY);
  width = Math.max(64, Math.min(width, even(grabW) - x));
  height = Math.max(64, Math.min(height, even(grabH) - y));
  return { x, y, width, height };
}

// Quality presets (round 126): live capture bitrate + save-time crf.
const RECORD_QUALITY = {
  high: { bitsPerSecond: 12_000_000, crf: '19' },
  standard: { bitsPerSecond: 8_000_000, crf: '21' },
  compact: { bitsPerSecond: 4_000_000, crf: '26' },
} as const;

// Round 127 — blur segments for the active recording. Rects are in
// VIDEO pixels; start/end are recording-clock milliseconds stamped by
// the widget (its clock excludes paused time, so stamps taken while
// paused line up exactly with the output timeline). endMs null =
// still blurring (closed automatically at stop). Mirrored to a
// sidecar JSON next to the temp WebM after every change so a crash
// mid-recording can NEVER save sensitive content unblurred — the
// startup orphan recovery reads it back.
interface BlurSegment { x: number; y: number; width: number; height: number; startMs: number; endMs: number | null }
let recordBlurSegments: BlurSegment[] = [];

// Round 128 — camera bubble (tutorial picture-in-picture). A real
// transparent always-on-top window on the recorded display that is
// deliberately NOT content-protected: it's on screen, so the
// recording captures it — no compositing. camVisible tracks the
// faded state; the window survives hidden so toggling back is
// instant (the camera stream stays warm).
let camWindow: BrowserWindow | null = null;
let camVisible = false;
let camHotkeyAccelerator: string | null = null;

function blurSidecarPath(webmPath: string): string {
  return webmPath.replace(/\.webm$/i, '.blur.json');
}

function persistBlurSidecar(): void {
  if (!recordTempPath) return;
  try {
    // Round 129 — the sidecar now carries the region crop too, so a
    // crash mid-region-recording can't recover the FULL screen
    // (which would leak everything around the chosen area).
    fs.writeFileSync(
      toLongPath(blurSidecarPath(recordTempPath)),
      JSON.stringify({ crop: recordRegionCrop, segments: recordBlurSegments }),
    );
  } catch (err) {
    log.warn(`[capture] blur sidecar write failed (non-fatal): ${(err as Error).message}`);
  }
}

function recordTempDir(): string {
  return path.join(app.getPath('userData'), 'Captures-temp');
}

function broadcastRecordingState(): void {
  broadcast('capture:recordingState', { state: recordingState });
}

// Lazy ffmpeg path — same ffmpeg-static resolution main.ts uses for
// thumbnails + HEVC transcodes (asarUnpack'd in packaged builds).
let ffmpegPathCached: string | null | undefined;
function ffmpegPath(): string | null {
  if (ffmpegPathCached !== undefined) return ffmpegPathCached;
  try {
    const p = esmRequire('ffmpeg-static') as string;
    ffmpegPathCached = p && fs.existsSync(p) ? p : null;
  } catch {
    ffmpegPathCached = null;
  }
  return ffmpegPathCached;
}

function teardownRecording(opts: { discardTemp: boolean }): void {
  closeCamBubble();
  closeRegionMarker();
  unregisterCamHotkey();
  recordRegionCrop = null;
  recordRegionCssRect = null;
  if (recordWidget && !recordWidget.isDestroyed()) {
    try { recordWidget.close(); } catch { /* non-fatal */ }
  }
  recordWidget = null;
  if (recordStream) {
    try { recordStream.end(); } catch { /* non-fatal */ }
    recordStream = null;
  }
  if (opts.discardTemp && recordTempPath) {
    const p = recordTempPath;
    // Give the stream a beat to flush before unlinking.
    setTimeout(() => {
      try { fs.unlinkSync(toLongPath(p)); } catch { /* non-fatal */ }
      try { fs.unlinkSync(toLongPath(blurSidecarPath(p))); } catch { /* non-fatal */ }
    }, 500);
  }
  recordBlurSegments = [];
  recordTempPath = null;
  recordStartedAt = null;
  recordDisplay = null;
  recordingState = 'idle';
  broadcastRecordingState();
}

export interface StartRecordingResult {
  success: boolean;
  alreadyRecording?: boolean;
  /** Round 129 — the user pressed Esc at the area-selection stage;
   *  nothing was set up. Callers stay silent. */
  cancelled?: boolean;
  needsDisplayPick?: boolean;
  displays?: CaptureDisplayInfo[];
  error?: string;
}

export async function startRecording(opts: { displayId?: string; trigger: 'button' }): Promise<StartRecordingResult> {
  if (recordingState !== 'idle') {
    return {
      success: false,
      alreadyRecording: true,
      error: recordingState === 'processing'
        ? 'Still saving your previous recording — one moment.'
        : recordingState === 'armed'
          ? 'A recording is already set up — press Record on the bar, or close it first.'
          : 'A recording is already in progress.',
    };
  }
  try {
    // Round 131 (Terry) — MENU FIRST. Clicking record no longer gates
    // on a screen picker or an immediate area-freeze (both were
    // disorienting: you couldn't arrange windows first, and the
    // frozen frame showed a second taskbar). Instead the bar opens
    // straight away, ARMED, targeting a sensible default; WHICH
    // screen and WHICH area are now choices ON the bar (Screen
    // dropdown + Area button), changeable freely before you press
    // Record. Default display = explicit pick, else PRIMARY (fresh
    // each time — never silently the last session's screen).
    const allDisplays = screen.getAllDisplays();
    const display = opts.displayId
      ? (allDisplays.find((d) => String(d.id) === String(opts.displayId)) ?? screen.getPrimaryDisplay())
      : screen.getPrimaryDisplay();

    const source = await getDisplaySource(display);
    if (!source) return { success: false, error: 'Could not access the screen for recording.' };

    // ARMED — nothing recorded yet, full screen by default (Area
    // button sets a region). Temp file + timestamps are created when
    // the user presses Record (capture:record-started).
    recordStartedAt = null;
    recordTempPath = null;
    recordDisplay = display;
    recordRegionCrop = null;
    recordRegionCssRect = null;
    recordMeta = { width: null, height: null, hasAudio: false };
    const screenList = await listCaptureDisplays();

    const recordAudio = (() => {
      try { return getSettings().captureRecordAudio !== false; } catch { return true; }
    })();
    recordQuality = (() => {
      try { return (getSettings().captureRecordQuality as 'high' | 'standard' | 'compact') || 'standard'; } catch { return 'standard'; }
    })();

    const widget = new BrowserWindow({
      // Round 130 — generous initial width so nothing clips on the
      // first paint; the widget then measures its real content and
      // asks main to size the window exactly (capture:record-resize),
      // so the bar can never clip however many controls are shown.
      width: 780,
      height: 64,
      x: display.bounds.x + display.bounds.width - 804,
      y: display.bounds.y + display.bounds.height - 120,
      frame: false,
      show: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#16161a',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    recordWidget = widget;
    try { widget.setAlwaysOnTop(true, 'screen-saver'); } catch { /* non-fatal */ }
    // WDA_EXCLUDEFROMCAPTURE — the widget stays visible to the user
    // but never appears in the recording (Win10 2004+).
    try { widget.setContentProtection(true); } catch { /* non-fatal */ }
    widget.setMenu(null);

    widget.on('closed', () => {
      // External close (Alt+F4 on the widget) while armed or
      // recording — treat as cancel; the engine died with the
      // renderer.
      if (recordWidget === widget && (recordingState === 'recording' || recordingState === 'armed')) {
        log.info('[capture] recording widget closed externally — discarding');
        recordWidget = null;
        teardownRecording({ discardTemp: true });
      }
    });

    widget.webContents.once('did-finish-load', () => {
      if (widget.isDestroyed()) return;
      widget.webContents.send('capture:record-init', {
        sourceId: source.id,
        audio: recordAudio,
        maxWidth: Math.round(display.bounds.width * display.scaleFactor),
        maxHeight: Math.round(display.bounds.height * display.scaleFactor),
        videoBitsPerSecond: RECORD_QUALITY[recordQuality].bitsPerSecond,
        quality: recordQuality,
        // Round 129 — the bar opens ARMED: engine idle until the
        // user presses its Record button.
        armed: true,
        region: recordRegionCrop,
        // Round 131 — screen picker lives on the bar now.
        screens: screenList.map((s) => ({ id: s.id, label: s.label })),
        currentScreenId: String(display.id),
      });
      // showInactive — setting up a recording must not steal focus
      // from whatever the user is about to record.
      widget.showInactive();
    });
    void widget.loadFile(path.join(__dirname, '../dist/public/capture-record-widget.html'));

    recordingState = 'armed';
    broadcastRecordingState();
    // Round 128 — camera bubble: auto-start when enabled in Settings;
    // the per-recording cam hotkey toggles it either way. Both work
    // during the armed stage too, so the user can frame themselves
    // before pressing Record.
    const camEnabled = (() => {
      try { return getSettings().captureCamEnabled === true; } catch { return false; }
    })();
    if (camEnabled) createCamBubble(display);
    registerCamHotkey();
    log.info(`[capture] recording ARMED on display ${display.id} (audio: ${recordAudio ? 'system' : 'off'}, cam: ${camEnabled ? 'on' : 'off'}, full screen) — waiting for Record`);
    return { success: true };
  } catch (err) {
    log.warn(`[capture] startRecording failed: ${(err as Error).message}`);
    teardownRecording({ discardTemp: true });
    return { success: false, error: (err as Error).message };
  }
}

/** Ask the widget's recorder to stop (it flushes and reports back on
 *  capture:record-stopped, which runs the finalize pipeline). */
export function stopRecording(): { success: boolean; error?: string } {
  if (recordingState !== 'recording' || !recordWidget || recordWidget.isDestroyed()) {
    return { success: false, error: 'No recording in progress.' };
  }
  try { recordWidget.webContents.send('capture:record-do', { action: 'stop' }); } catch { /* non-fatal */ }
  return { success: true };
}

export function cancelRecording(): { success: boolean } {
  if ((recordingState === 'recording' || recordingState === 'armed') && recordWidget && !recordWidget.isDestroyed()) {
    try { recordWidget.webContents.send('capture:record-do', { action: 'cancel' }); } catch { /* non-fatal */ }
    // The widget replies on capture:record-cancelled; belt-and-braces
    // teardown happens there. If the widget is wedged, the closed
    // handler covers it.
    return { success: true };
  }
  return { success: false };
}

/**
 * WebM → H.264/AAC MP4 with +faststart. Returns the mp4 path, or
 * null when FFmpeg is unavailable / fails (caller falls back to
 * keeping the WebM — Chromium plays VP9 natively, so the recording
 * is still viewable in PDRV; losing the user's recording is the only
 * unacceptable outcome).
 */
/**
 * Round 127 — turn the recorded blur segments into an FFmpeg
 * filter_complex chain. Per segment: split the frame, crop the
 * region, box-blur it hard, overlay it back at the same spot — but
 * only between the segment's start and end on the output timeline
 * (`enable='between(t,a,b)'`). Chained so any number of sequential
 * segments compose. Pure save-time work: recording itself never
 * touches a pixel.
 */
/**
 * Compose the save-time video filter chain: an optional region crop
 * first (round 129 — region recording captures full-screen and crops
 * here), then the blur segments (coords shifted into the cropped
 * space; segments falling outside the region are dropped).
 */
function buildVideoFilter(segments: BlurSegment[], regionCrop: SelectionRect | null): { filter: string; outLabel: string } | null {
  const parts: string[] = [];
  let cur = '0:v';
  if (regionCrop) {
    parts.push(`[${cur}]crop=${regionCrop.width}:${regionCrop.height}:${regionCrop.x}:${regionCrop.y}[vc]`);
    cur = 'vc';
  }
  const adjusted = segments
    .map((s) => {
      if (!regionCrop) return s;
      const x1 = Math.max(s.x, regionCrop.x);
      const y1 = Math.max(s.y, regionCrop.y);
      const x2 = Math.min(s.x + s.width, regionCrop.x + regionCrop.width);
      const y2 = Math.min(s.y + s.height, regionCrop.y + regionCrop.height);
      if (x2 - x1 < 4 || y2 - y1 < 4) return null; // outside the region
      const even = (n: number) => Math.max(0, 2 * Math.floor(n / 2));
      return { ...s, x: even(x1 - regionCrop.x), y: even(y1 - regionCrop.y), width: even(x2 - x1), height: even(y2 - y1) };
    })
    .filter((s): s is BlurSegment => s !== null);
  adjusted.forEach((s, i) => {
    const start = (s.startMs / 1000).toFixed(3);
    // Open segment (never unblurred) runs to end-of-clip.
    const end = s.endMs === null ? '999999' : (s.endMs / 1000).toFixed(3);
    parts.push(`[${cur}]split=2[a${i}][b${i}]`);
    parts.push(`[b${i}]crop=${s.width}:${s.height}:${s.x}:${s.y},boxblur=10[bb${i}]`);
    parts.push(`[a${i}][bb${i}]overlay=${s.x}:${s.y}:enable='between(t,${start},${end})'[v${i}]`);
    cur = `v${i}`;
  });
  if (parts.length === 0) return null;
  return { filter: parts.join(';'), outLabel: cur };
}

async function transcodeWebmToMp4(webmPath: string, crf: string = '21', blurSegments: BlurSegment[] = [], regionCrop: SelectionRect | null = null): Promise<string | null> {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) {
    log.warn('[capture] ffmpeg unavailable — keeping WebM recording as-is');
    return null;
  }
  const outPath = webmPath.replace(/\.webm$/i, '.mp4');
  // ffmpeg can't open \\?\-prefixed paths (see extractVideoFrame).
  const src = webmPath.replace(/^\\\\\?\\/, '');
  const dst = outPath.replace(/^\\\\\?\\/, '');
  // ultrafast preset: verification on Terry's machine showed
  // veryfast took ~2 min for a 6-second 1080p clip on an older CPU —
  // the encode time scales with recording length, so a long recording
  // would feel broken. ultrafast roughly halves it; for screen
  // content (flat regions, text) the quality difference is
  // negligible. crf comes from the quality preset (round 126).
  const segments = blurSegments.filter((s) => s.width >= 2 && s.height >= 2);
  const built = buildVideoFilter(segments, regionCrop);
  const videoArgs = built
    ? ['-filter_complex', built.filter, '-map', `[${built.outLabel}]`, '-map', '0:a?']
    : [];
  if (built) {
    log.info(`[capture] save-time filters: ${regionCrop ? `region crop ${regionCrop.width}×${regionCrop.height}` : 'no crop'}${segments.length > 0 ? ` + ${segments.length} blur segment(s)` : ''}`);
  }
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', src,
    ...videoArgs,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', crf, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    '-y', dst,
  ];
  const { spawn } = await import('child_process');
  return new Promise<string | null>((resolve) => {
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBuf.length < 4096) stderrBuf += chunk.toString('utf8');
    });
    proc.on('error', (err) => {
      log.warn(`[capture] ffmpeg spawn failed: ${err.message}`);
      resolve(null);
    });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) {
        resolve(outPath);
      } else {
        log.warn(`[capture] ffmpeg transcode failed (code ${code}): ${stderrBuf.trim().slice(0, 500)}`);
        resolve(null);
      }
    });
  });
}

/**
 * Shared tail for recordings — mirrors persistCapture but for an
 * already-encoded video file: place under PDR Captures (or pending),
 * stamp XMP, index as fileType 'video', broadcast. The capture
 * timestamp is the recording START.
 */
async function persistRecording(
  videoPath: string,
  startedAt: Date,
  width: number | null,
  height: number | null,
): Promise<CaptureScreenshotResult> {
  const { date, time, month } = timestampParts(startedAt);
  const libRoot = onlineLibraryRoot();
  const destDir = libRoot ? path.join(libRoot, 'PDR Captures', month) : pendingDir();
  fs.mkdirSync(toLongPath(destDir), { recursive: true });
  const ext = path.extname(videoPath).toLowerCase() || '.mp4';
  const outPath = uniqueCapturePath(destDir, `${date}_${time}_SR`, ext);
  try {
    fs.renameSync(toLongPath(videoPath), toLongPath(outPath));
  } catch {
    fs.copyFileSync(toLongPath(videoPath), toLongPath(outPath));
    try { fs.unlinkSync(toLongPath(videoPath)); } catch { /* non-fatal */ }
  }
  const filename = path.basename(outPath);

  await stampCaptureMetadata(outPath, startedAt, 'screen recording');

  let fileId: number | null = null;
  if (libRoot) {
    try {
      fileId = await indexCapturedFile(outPath, libRoot, startedAt, width, height, 'video');
      if (fileId != null) {
        broadcast('library:filesAdded', { reason: 'capture', newFilePath: outPath, fileId });
      }
    } catch (idxErr) {
      log.warn(`[capture] recording index pass failed (file still saved): ${(idxErr as Error).message}`);
    }
    log.info(`[capture] recording ${filename} (${width}×${height}) → library${fileId != null ? ` (file id ${fileId})` : ' (NOT indexed)'}`);
  } else {
    log.info(`[capture] recording ${filename} → pending (Library Drive offline); will flush on reconnect`);
  }

  broadcast('capture:completed', {
    kind: 'recording',
    filePath: outPath,
    filename,
    fileId,
    pending: !libRoot,
    width,
    height,
  });
  return { success: true, filePath: outPath, filename, fileId, pending: !libRoot };
}

async function finalizeRecording(): Promise<void> {
  const webmPath = recordTempPath;
  const startedAt = recordStartedAt ?? new Date();
  const meta = recordMeta;
  const blurSegments = recordBlurSegments;
  recordBlurSegments = [];
  const regionCrop = recordRegionCrop;
  recordRegionCrop = null;
  recordRegionCssRect = null;
  closeCamBubble();
  closeRegionMarker();
  unregisterCamHotkey();
  // Close the widget + stream, keep the temp file.
  if (recordWidget && !recordWidget.isDestroyed()) {
    try { recordWidget.close(); } catch { /* non-fatal */ }
  }
  recordWidget = null;
  recordingState = 'processing';
  broadcastRecordingState();
  if (recordStream) {
    const stream = recordStream;
    recordStream = null;
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }
  recordTempPath = null;
  recordStartedAt = null;
  recordDisplay = null;

  try {
    if (!webmPath || !fs.existsSync(toLongPath(webmPath)) || fs.statSync(toLongPath(webmPath)).size === 0) {
      log.warn('[capture] recording produced no data — nothing to save');
      return;
    }
    const mp4Path = await transcodeWebmToMp4(webmPath, RECORD_QUALITY[recordQuality].crf, blurSegments, regionCrop);
    if (mp4Path) {
      try { fs.unlinkSync(toLongPath(webmPath)); } catch { /* non-fatal */ }
      try { fs.unlinkSync(toLongPath(blurSidecarPath(webmPath))); } catch { /* non-fatal */ }
      await persistRecording(mp4Path, startedAt, regionCrop?.width ?? meta.width, regionCrop?.height ?? meta.height);
    } else {
      // FFmpeg unavailable/failed — persist the WebM itself rather
      // than lose the recording. NOTE: blur segments can only be
      // applied by the transcode; if any exist, warn loudly rather
      // than ship sensitive content silently unblurred.
      if (blurSegments.length > 0) {
        log.warn(`[capture] transcode failed with ${blurSegments.length} blur segment(s) pending — the saved WebM is NOT blurred`);
        broadcast('capture:recordError', { message: 'The recording was saved, but the blur could not be applied to it.' });
      }
      try { fs.unlinkSync(toLongPath(blurSidecarPath(webmPath))); } catch { /* non-fatal */ }
      await persistRecording(webmPath, startedAt, meta.width, meta.height);
    }
  } catch (err) {
    log.warn(`[capture] recording finalize failed: ${(err as Error).message}`);
    broadcast('capture:recordError', { message: (err as Error).message });
  } finally {
    recordingState = 'idle';
    broadcastRecordingState();
  }
}

// Widget → main channels. Sender-pinned to the live widget.
ipcMain.on('capture:record-chunk', (event, chunk: ArrayBuffer | Uint8Array) => {
  if (recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents && recordStream) {
    try { recordStream.write(Buffer.from(chunk as ArrayBuffer)); } catch { /* non-fatal */ }
  }
});
ipcMain.on('capture:record-started', (event, info: { width?: number; height?: number; hasAudio?: boolean }) => {
  if (recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents) {
    recordMeta = { width: info?.width ?? null, height: info?.height ?? null, hasAudio: !!info?.hasAudio };
    // Round 129 — THIS is the moment recording truly begins (the
    // user pressed Record on the armed bar). The temp file, the
    // stream, and the filename timestamp are all born here, so a
    // recording armed at 9:00 but started at 9:07 is dated 9:07.
    // IPC ordering guarantees this handler runs before the first
    // chunk arrives (the widget reports started before recorder.start).
    if (recordingState === 'armed') {
      recordStartedAt = new Date();
      const { date, time } = timestampParts(recordStartedAt);
      fs.mkdirSync(toLongPath(recordTempDir()), { recursive: true });
      recordTempPath = path.join(recordTempDir(), `rec-${date}_${time}.webm`);
      recordStream = fs.createWriteStream(toLongPath(recordTempPath));
      // Region recordings get their sidecar immediately so crash
      // recovery knows the crop even with zero blur segments.
      if (recordRegionCrop) persistBlurSidecar();
      recordingState = 'recording';
      broadcastRecordingState();
    }
    log.info(`[capture] recorder running ${recordMeta.width}×${recordMeta.height}, audio: ${recordMeta.hasAudio ? 'yes' : 'no'}`);
  }
});
ipcMain.on('capture:record-stopped', (event) => {
  if (recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents) {
    void finalizeRecording();
  }
});
ipcMain.on('capture:record-cancelled', (event) => {
  if (recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents) {
    log.info('[capture] recording cancelled by user — discarded');
    teardownRecording({ discardTemp: true });
  }
});
ipcMain.on('capture:record-error', (event, info: { message?: string }) => {
  if (recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents) {
    log.warn(`[capture] recorder error: ${info?.message ?? 'unknown'}`);
    broadcast('capture:recordError', { message: info?.message ?? 'Recording failed.' });
    teardownRecording({ discardTemp: true });
  }
});
// Round 126 — Snap button on the widget: a still of the recorded
// display, taken mid-recording WITHOUT hiding PDR's windows (a
// hide/restore would blip INSIDE the recording; what's on screen is
// by definition what the user is recording). The widget itself is
// content-protected, so it appears in neither the recording nor the
// snap. Lands through the normal screenshot pipeline → toast →
// indexed → S&D Captures.
ipcMain.on('capture:record-snap', (event) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  const display = recordDisplay;
  if (!display || recordingState !== 'recording') return;
  void (async () => {
    try {
      const capturedAt = new Date();
      const grab = await grabDisplayPng(display, { hideWindows: false });
      if (!grab) {
        log.warn('[capture] mid-recording snap failed: could not grab display');
        return;
      }
      grab.restore(); // no-op (nothing hidden) — keeps the contract
      // Round 129 — region recordings snap the REGION, not the whole
      // screen: the still should match what's being recorded.
      let buffer = grab.buffer;
      let w: number | null = grab.width;
      let h: number | null = grab.height;
      if (recordRegionCrop) {
        const cropped = nativeImage.createFromBuffer(grab.buffer).crop(recordRegionCrop);
        if (!cropped.isEmpty()) {
          buffer = cropped.toPNG();
          w = recordRegionCrop.width;
          h = recordRegionCrop.height;
        }
      }
      await persistCapture(buffer, capturedAt, w, h, 'screenshot');
    } catch (err) {
      log.warn(`[capture] mid-recording snap failed: ${(err as Error).message}`);
    }
  })();
});

// Round 127 — quality changed from the recording bar. Applies to the
// SAVE step of the in-flight recording (the capture bitrate was fixed
// at start) and persists as the setting for future ones; the
// settings:changed broadcast keeps the Settings → Capture radio live.
ipcMain.on('capture:record-quality', (event, info: { quality?: 'high' | 'standard' | 'compact' }) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  const q = info?.quality;
  if (q !== 'high' && q !== 'standard' && q !== 'compact') return;
  recordQuality = q;
  try { setSetting('captureRecordQuality', q); } catch { /* non-fatal */ }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try { win.webContents.send('settings:changed', { key: 'captureRecordQuality', value: q }); } catch { /* non-fatal */ }
  }
  log.info(`[capture] recording quality → ${q} (save-time; persisted for future recordings)`);
});

// Round 127 — Blur. The widget auto-pauses, then asks for the area
// selector. We freeze the recorded display exactly as it stands (no
// window hiding — the footage must match) and reuse the region
// overlay, snap-to-window included. The chosen rect goes back to the
// widget in VIDEO pixels; the widget stamps the recording-clock
// start/end on its open/close reports below.
ipcMain.on('capture:record-blur-request', (event) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  const display = recordDisplay;
  const widget = recordWidget;
  const replyRect = (rect: { x: number; y: number; width: number; height: number } | null) => {
    if (widget && !widget.isDestroyed()) {
      try { widget.webContents.send('capture:record-do', { action: 'blur-opened', rect }); } catch { /* non-fatal */ }
    }
  };
  if (!display || recordingState !== 'recording' || captureInFlight) {
    replyRect(null);
    return;
  }
  captureInFlight = true; // blocks hotkey screenshots while selecting
  void (async () => {
    try {
      const grab = await grabDisplayPng(display, { hideWindows: false, includeWindows: true });
      if (!grab) { replyRect(null); return; }
      grab.restore(); // no-op — nothing hidden
      const dataUrl = `data:image/png;base64,${grab.buffer.toString('base64')}`;
      const rect = await openRegionOverlay(display, dataUrl, grab.windows);
      if (!rect) { replyRect(null); return; }
      // Display CSS px → video px, rounded to even values (chroma-
      // subsampled H.264 prefers even crop geometry) and clamped.
      const vw = recordMeta.width ?? Math.round(display.bounds.width * display.scaleFactor);
      const vh = recordMeta.height ?? Math.round(display.bounds.height * display.scaleFactor);
      const scaleX = vw / display.bounds.width;
      const scaleY = vh / display.bounds.height;
      const even = (n: number) => Math.max(0, 2 * Math.floor(n / 2));
      let x = even(rect.x * scaleX);
      let y = even(rect.y * scaleY);
      let width = even(rect.width * scaleX);
      let height = even(rect.height * scaleY);
      width = Math.max(2, Math.min(width, even(vw) - x));
      height = Math.max(2, Math.min(height, even(vh) - y));
      replyRect({ x, y, width, height });
    } catch (err) {
      log.warn(`[capture] blur selection failed: ${(err as Error).message}`);
      replyRect(null);
    } finally {
      captureInFlight = false;
    }
  })();
});

// ─── Round 129: region marker ────────────────────────────────────────────────

/**
 * A click-through, content-protected, transparent window covering the
 * recorded display that draws a border around the recorded region —
 * the user always sees what's in frame; the footage never does.
 * rect is in display CSS pixels (the overlay selection, pre-scale).
 */
function createRegionMarker(display: Electron.Display, rect: SelectionRect): void {
  closeRegionMarker();
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    show: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  regionMarkerWindow = win;
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* non-fatal */ }
  try { win.setContentProtection(true); } catch { /* non-fatal */ }
  try { win.setIgnoreMouseEvents(true); } catch { /* non-fatal */ }
  win.setMenu(null);
  win.on('closed', () => {
    if (regionMarkerWindow === win) regionMarkerWindow = null;
  });
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('capture:region-marker-init', { rect });
    win.showInactive();
  });
  void win.loadFile(path.join(__dirname, '../dist/public/capture-region-marker.html'));
}

function closeRegionMarker(): void {
  if (regionMarkerWindow && !regionMarkerWindow.isDestroyed()) {
    try { regionMarkerWindow.close(); } catch { /* non-fatal */ }
  }
  regionMarkerWindow = null;
}

// ─── Round 128: camera bubble ────────────────────────────────────────────────

function notifyWidgetCamState(): void {
  if (recordWidget && !recordWidget.isDestroyed()) {
    try { recordWidget.webContents.send('capture:record-do', { action: 'cam-state', visible: camVisible }); } catch { /* non-fatal */ }
  }
}

function createCamBubble(display: Electron.Display): void {
  if (camWindow && !camWindow.isDestroyed()) return;
  const shape = (() => {
    try { return (getSettings().captureCamShape as 'circle' | 'rectangle') || 'circle'; } catch { return 'circle'; }
  })();
  const deviceId = (() => {
    try { return getSettings().captureCamDevice || ''; } catch { return ''; }
  })();
  // Content size + 12px for the inset margin the page reserves.
  const width = shape === 'circle' ? 232 : 302;
  const height = shape === 'circle' ? 232 : 192;
  const win = new BrowserWindow({
    width,
    height,
    // Bottom-LEFT corner — the recording bar owns bottom-right.
    x: display.bounds.x + 24,
    y: display.bounds.y + display.bounds.height - height - 56,
    frame: false,
    show: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  camWindow = win;
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* non-fatal */ }
  // NO setContentProtection here — the bubble must appear in the
  // footage; that's its entire purpose.
  win.setMenu(null);
  win.on('closed', () => {
    if (camWindow === win) {
      camWindow = null;
      camVisible = false;
      notifyWidgetCamState();
    }
  });
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('capture:cam-init', { deviceId, shape });
    win.showInactive();
    camVisible = true;
    notifyWidgetCamState();
  });
  void win.loadFile(path.join(__dirname, '../dist/public/capture-cam.html'));
}

/** Show/hide the bubble with the page-side fade. Creates it on first
 *  toggle if the recording started without one. */
function toggleCamBubble(): void {
  // Armed counts too (round 129) — the user frames their camera
  // BEFORE pressing Record.
  if ((recordingState !== 'recording' && recordingState !== 'armed') || !recordDisplay) return;
  if (!camWindow || camWindow.isDestroyed()) {
    createCamBubble(recordDisplay);
    return;
  }
  if (camVisible) {
    try { camWindow.webContents.send('capture:cam-do', { action: 'hide' }); } catch { /* non-fatal */ }
    camVisible = false;
    notifyWidgetCamState();
    // The window itself hides when the page reports the fade done
    // (capture:cam-fadedout) so the footage records the fade.
  } else {
    try { camWindow.showInactive(); } catch { /* non-fatal */ }
    try { camWindow.webContents.send('capture:cam-do', { action: 'show' }); } catch { /* non-fatal */ }
    camVisible = true;
    notifyWidgetCamState();
  }
}

function closeCamBubble(): void {
  if (camWindow && !camWindow.isDestroyed()) {
    try { camWindow.close(); } catch { /* non-fatal */ }
  }
  camWindow = null;
  camVisible = false;
}

function registerCamHotkey(): void {
  const accelerator = (() => {
    try { return getSettings().captureCamHotkey || 'Ctrl+Shift+C'; } catch { return 'Ctrl+Shift+C'; }
  })();
  try {
    const ok = globalShortcut.register(accelerator, () => toggleCamBubble());
    camHotkeyAccelerator = ok ? accelerator : null;
    log.info(`[capture] cam hotkey ${accelerator} ${ok ? 'registered for this recording' : 'NOT registered (in use elsewhere)'}`);
  } catch (err) {
    camHotkeyAccelerator = null;
    log.warn(`[capture] cam hotkey registration threw: ${(err as Error).message}`);
  }
}

function unregisterCamHotkey(): void {
  if (camHotkeyAccelerator) {
    try { globalShortcut.unregister(camHotkeyAccelerator); } catch { /* non-fatal */ }
    camHotkeyAccelerator = null;
  }
}

// Round 130 (Terry) — re-pick the recorded area from the ARMED bar.
// His exact scenario: pick the screen while PDR is fullscreen, arm
// with Enter, alt-tab to arrange the windows he actually wants to
// record (nothing cancels — only the selector overlay is modal),
// then press Area on the bar for a FRESH freeze of the screen as it
// now stands. Esc in the re-pick keeps the previous area rather than
// abandoning the setup.
ipcMain.on('capture:record-area-request', (event) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  const display = recordDisplay;
  const widget = recordWidget;
  const reply = () => {
    if (widget && !widget.isDestroyed()) {
      try { widget.webContents.send('capture:record-do', { action: 'area-set', region: recordRegionCrop }); } catch { /* non-fatal */ }
    }
  };
  if (!display || recordingState !== 'armed' || captureInFlight) {
    reply();
    return;
  }
  captureInFlight = true;
  // Hide the stale outline while re-picking so it can't confuse the
  // new selection.
  closeRegionMarker();
  void (async () => {
    try {
      // Round 131 — LIVE veil (no frozen grab): the user already
      // arranged their windows before clicking Area, so we just need
      // the rectangle over the live desktop. Native pixel size for
      // the crop scale = the display's CSS bounds × scaleFactor (the
      // recording captures at that native resolution).
      const windows = enumerateWindowRectsForDisplay(display);
      const nativeW = Math.round(display.bounds.width * display.scaleFactor);
      const nativeH = Math.round(display.bounds.height * display.scaleFactor);
      const rect = await openRegionOverlay(display, null, windows, undefined, { live: true });
      if (rect) {
        recordRegionCrop = computeRegionCrop(rect, display, nativeW, nativeH);
        recordRegionCssRect = recordRegionCrop ? rect : null;
        if (recordRegionCrop && recordRegionCssRect) createRegionMarker(display, recordRegionCssRect);
        log.info(`[capture] recording area set: ${recordRegionCrop ? `${recordRegionCrop.width}×${recordRegionCrop.height}` : 'full screen'}`);
      } else if (recordRegionCssRect) {
        // Esc kept the previous area — restore its outline.
        createRegionMarker(display, recordRegionCssRect);
      }
      reply();
    } catch (err) {
      log.warn(`[capture] area pick failed: ${(err as Error).message}`);
      reply();
    } finally {
      captureInFlight = false;
    }
  })();
});

// Round 131 — change the recorded screen from the bar's Screen
// dropdown (Terry: pick the screen AFTER seeing the menu, and never
// silently assume last time's). Resets the region to full (a region
// on the old screen doesn't map to the new one), moves the bar + cam
// to the new display, and hands the widget the new source id so the
// engine records the right screen when Record is pressed.
ipcMain.on('capture:record-set-screen', (event, displayId: string) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  if (recordingState !== 'armed') return;
  const display = screen.getAllDisplays().find((d) => String(d.id) === String(displayId));
  if (!display) return;
  recordDisplay = display;
  recordRegionCrop = null;
  recordRegionCssRect = null;
  closeRegionMarker();
  // Move the bar to the newly-targeted display (bottom-right); the
  // self-sizer will re-anchor width on its next tick.
  try {
    const b = recordWidget.getBounds();
    recordWidget.setBounds({
      x: display.bounds.x + display.bounds.width - b.width - 24,
      y: display.bounds.y + display.bounds.height - b.height - 56,
      width: b.width,
      height: b.height,
    });
  } catch { /* non-fatal */ }
  // Re-home the camera bubble if it's up.
  if (camWindow && !camWindow.isDestroyed()) {
    const wasVisible = camVisible;
    closeCamBubble();
    createCamBubble(display);
    if (!wasVisible) { /* it will show on init; toggle off shortly after if needed */ }
  }
  void (async () => {
    const source = await getDisplaySource(display);
    if (recordWidget && !recordWidget.isDestroyed()) {
      try {
        recordWidget.webContents.send('capture:record-do', {
          action: 'screen-set',
          sourceId: source?.id ?? null,
          maxWidth: Math.round(display.bounds.width * display.scaleFactor),
          maxHeight: Math.round(display.bounds.height * display.scaleFactor),
          screenId: String(display.id),
        });
      } catch { /* non-fatal */ }
    }
    log.info(`[capture] recorded screen changed to display ${display.id}`);
  })();
});

// Round 130 — the widget measures its own content and asks for a
// window width that fits every visible control, anchored to the
// recorded display's bottom-right. Future-proofs the bar against
// clipping no matter how many buttons appear (the bug where Record
// fell off the right edge after Area was added).
ipcMain.on('capture:record-resize', (event, width: number) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  const display = recordDisplay ?? screen.getPrimaryDisplay();
  const target = Math.round(Math.max(280, Math.min(width || 0, display.bounds.width - 48)));
  try {
    const cur = recordWidget.getBounds();
    if (Math.abs(cur.width - target) < 2) return; // already there
    // Keep the right edge anchored to the display's right margin.
    const right = display.bounds.x + display.bounds.width - 24;
    recordWidget.setBounds({ x: right - target, y: cur.y, width: target, height: cur.height });
  } catch { /* non-fatal */ }
});

ipcMain.on('capture:record-cam-toggle', (event) => {
  if (recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents) {
    toggleCamBubble();
  }
});
ipcMain.on('capture:cam-fadedout', (event) => {
  if (camWindow && !camWindow.isDestroyed() && event.sender === camWindow.webContents && !camVisible) {
    try { camWindow.hide(); } catch { /* non-fatal */ }
  }
});
ipcMain.on('capture:cam-error', (event, info: { message?: string }) => {
  if (camWindow && !camWindow.isDestroyed() && event.sender === camWindow.webContents) {
    log.warn(`[capture] camera bubble failed: ${info?.message ?? 'unknown'}`);
    broadcast('capture:recordError', { message: 'The camera couldn\'t start — check Windows camera privacy settings. The recording itself is unaffected.' });
    closeCamBubble();
    notifyWidgetCamState();
  }
});

ipcMain.on('capture:record-blur', (event, info: { type?: 'open' | 'close'; rect?: { x: number; y: number; width: number; height: number }; startMs?: number; endMs?: number }) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  if (info?.type === 'open' && info.rect && typeof info.startMs === 'number') {
    recordBlurSegments.push({
      x: info.rect.x, y: info.rect.y, width: info.rect.width, height: info.rect.height,
      startMs: Math.max(0, info.startMs), endMs: null,
    });
    persistBlurSidecar();
    log.info(`[capture] blur ON at ${(info.startMs / 1000).toFixed(1)}s (${info.rect.width}×${info.rect.height} @ ${info.rect.x},${info.rect.y})`);
  } else if (info?.type === 'close' && typeof info.endMs === 'number') {
    const open = [...recordBlurSegments].reverse().find((s) => s.endMs === null);
    if (open) {
      open.endMs = Math.max(open.startMs, info.endMs);
      persistBlurSidecar();
      log.info(`[capture] blur OFF at ${(info.endMs / 1000).toFixed(1)}s`);
    }
  }
});

/** App-quit safety: flush the temp WebM so the startup orphan
 *  recovery can transcode + index it on next launch. */
export function flushRecordingOnQuit(): void {
  if (recordStream) {
    try { recordStream.end(); } catch { /* non-fatal */ }
    recordStream = null;
  }
}

/**
 * Startup recovery — any rec-*.webm left in Captures-temp means a
 * recording was live when PDR quit or crashed. Transcode + land it
 * rather than silently losing the user's one-shot moment. The start
 * timestamp comes back out of the temp filename.
 */
export async function recoverOrphanRecordings(): Promise<number> {
  const dir = recordTempDir();
  if (!fs.existsSync(dir)) return 0;
  if (recordingState !== 'idle') return 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => /^rec-.*\.webm$/i.test(f));
  } catch {
    return 0;
  }
  let recovered = 0;
  for (const name of entries) {
    try {
      const full = path.join(dir, name);
      if (fs.statSync(toLongPath(full)).size === 0) {
        try { fs.unlinkSync(toLongPath(full)); } catch { /* non-fatal */ }
        continue;
      }
      const m = name.match(/^rec-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
      const startedAt = m
        ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
        : fs.statSync(toLongPath(full)).mtime;
      // Round 127 — re-apply any blur the user had set before the
      // crash/quit; the sidecar JSON travels with the temp WebM
      // precisely so sensitive content never resurfaces unblurred.
      let blurSegments: BlurSegment[] = [];
      let crop: SelectionRect | null = null;
      try {
        const sidecar = blurSidecarPath(full);
        if (fs.existsSync(toLongPath(sidecar))) {
          const parsed = JSON.parse(fs.readFileSync(toLongPath(sidecar), 'utf8'));
          if (Array.isArray(parsed)) {
            blurSegments = parsed; // pre-round-129 shape
          } else if (parsed && typeof parsed === 'object') {
            if (Array.isArray(parsed.segments)) blurSegments = parsed.segments;
            if (parsed.crop && typeof parsed.crop.width === 'number') crop = parsed.crop;
          }
        }
      } catch { /* recover without blur/crop metadata */ }
      const mp4Path = await transcodeWebmToMp4(full, '21', blurSegments, crop);
      if (mp4Path) {
        try { fs.unlinkSync(toLongPath(full)); } catch { /* non-fatal */ }
        try { fs.unlinkSync(toLongPath(blurSidecarPath(full))); } catch { /* non-fatal */ }
        await persistRecording(mp4Path, startedAt, crop?.width ?? null, crop?.height ?? null);
      } else {
        if (blurSegments.length > 0) {
          log.warn(`[capture] orphan recovery: transcode failed with ${blurSegments.length} blur segment(s) — recovered WebM is NOT blurred`);
        }
        try { fs.unlinkSync(toLongPath(blurSidecarPath(full))); } catch { /* non-fatal */ }
        await persistRecording(full, startedAt, null, null);
      }
      recovered++;
      log.info(`[capture] recovered orphaned recording ${name}`);
    } catch (err) {
      log.warn(`[capture] orphan recording recovery failed for ${name} (left in place): ${(err as Error).message}`);
    }
  }
  return recovered;
}
