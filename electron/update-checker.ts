import { app, BrowserWindow } from 'electron';
import pkg from 'electron-updater';
import log from 'electron-log';

const { autoUpdater } = pkg;

// Auto-update wiring for PDR.
//
// Architecture (Phase A — client only, server lands in Phase B):
//
//   electron-updater queries https://updates.photodaterescue.com/latest.yml
//   on launch and again every 4 h while the app is running. The provider
//   block lives in package.json under build.publish, so the URL changing
//   is a config edit not a code edit.
//
//   We DON'T auto-download. The user sees a toast "Update available — get
//   it now?" and decides; once they accept, electron-updater streams the
//   installer in the background, then prompts "Restart to install" once
//   the file is on disk. autoInstallOnAppQuit=true means if they don't
//   restart immediately the install runs silently when they next quit.
//
//   On dev (app.isPackaged === false) electron-updater is a no-op by
//   default. So this code is dormant during npm run build:electron + npx
//   electron — it only activates in the packaged NSIS build.
//
// State machine published to the renderer over the 'updates:state'
// channel. The UI renders one of these tiles:
//
//   idle           → no toast
//   checking       → no toast (silent)
//   not-available  → no toast (silent)
//   available      → "Update available — Get it now / Later"
//   downloading    → "Downloading update — 45%"
//   downloaded     → "Update ready — Restart now / Later"
//   error          → silent (logged); avoids alarming the user when the
//                    update server is just unreachable

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  mandatory: boolean;
  // Kept for renderer-side compatibility with the old shape, but
  // electron-updater handles the download itself now — the renderer
  // doesn't need this URL.
  downloadUrl: string;
  releaseNotes?: string;
}

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'not-available'; currentVersion: string }
  | { kind: 'available'; version: string; releaseNotes?: string; currentVersion: string }
  | { kind: 'downloading'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

let mainWindowRef: BrowserWindow | null = null;
let currentState: UpdateState = { kind: 'idle' };

function broadcast(state: UpdateState): void {
  currentState = state;
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('updates:state', state);
  }
}

export function initAutoUpdater(window: BrowserWindow): void {
  mainWindowRef = window;

  // Pipe electron-updater logging into electron-log so it lands in the
  // same %APPDATA%\Photo Date Rescue\logs\main.log file the rest of the
  // app uses. Crucial when diagnosing "why didn't it update?" reports.
  autoUpdater.logger = log as unknown as pkg.Logger;
  log.transports.file.level = 'info';

  // We control the lifecycle explicitly — no silent downloads, but if
  // the user has a downloaded update and quits, install it on quit.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    log.info('[updater] checking for update');
    broadcast({ kind: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    log.info(`[updater] update available: v${info.version}`);
    broadcast({
      kind: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      currentVersion: app.getVersion(),
    });
  });

  autoUpdater.on('update-not-available', () => {
    log.info('[updater] no update available');
    broadcast({ kind: 'not-available', currentVersion: app.getVersion() });
  });

  autoUpdater.on('download-progress', (progress) => {
    broadcast({
      kind: 'downloading',
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`[updater] update downloaded: v${info.version}`);
    broadcast({ kind: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    log.error('[updater] error:', err);
    broadcast({ kind: 'error', message: err?.message ?? 'Unknown error' });
  });

  // Initial check 10 s after window paint (give the UI room to settle),
  // then again every 4 h. The 4-h cadence keeps server load trivial
  // (one HEAD/GET per session) while still catching same-day patches.
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  setTimeout(() => {
    void runCheck();
  }, 10_000);
  setInterval(() => {
    void runCheck();
  }, FOUR_HOURS);
}

async function runCheck(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // Errors are emitted via the 'error' event above — this catch is
    // a belt-and-braces no-op so an exception here doesn't crash the
    // setInterval loop.
    log.warn('[updater] checkForUpdates threw', err);
  }
}

// IPC entry point — the renderer can also kick off a check manually
// (e.g. from a "Check for updates" button in Settings / Help). Returns
// the legacy UpdateInfo shape for backward compatibility with the
// existing callsite in App.tsx.
export async function checkForUpdates(): Promise<UpdateInfo> {
  const currentVersion = app.getVersion();

  try {
    const result = await autoUpdater.checkForUpdates();
    if (result && result.updateInfo && result.updateInfo.version !== currentVersion) {
      return {
        currentVersion,
        latestVersion: result.updateInfo.version,
        updateAvailable: true,
        mandatory: false, // Phase D will wire this from latest.yml extraMetadata
        downloadUrl: '',
        releaseNotes:
          typeof result.updateInfo.releaseNotes === 'string'
            ? result.updateInfo.releaseNotes
            : undefined,
      };
    }
    return {
      currentVersion,
      latestVersion: currentVersion,
      updateAvailable: false,
      mandatory: false,
      downloadUrl: '',
    };
  } catch (error) {
    log.warn('[updater] check failed:', error);
    return {
      currentVersion,
      latestVersion: currentVersion,
      updateAvailable: false,
      mandatory: false,
      downloadUrl: '',
    };
  }
}

export async function downloadUpdate(): Promise<void> {
  await autoUpdater.downloadUpdate();
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}

export function getUpdateState(): UpdateState {
  return currentState;
}
