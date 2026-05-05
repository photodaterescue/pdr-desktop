import { app } from 'electron';
import pkg from 'electron-updater';
import log from 'electron-log';
const { autoUpdater } = pkg;
let mainWindowRef = null;
let currentState = { kind: 'idle' };
function broadcast(state) {
    currentState = state;
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
        mainWindowRef.webContents.send('updates:state', state);
    }
}
export function initAutoUpdater(window) {
    mainWindowRef = window;
    // Pipe electron-updater logging into electron-log so it lands in the
    // same %APPDATA%\Photo Date Rescue\logs\main.log file the rest of the
    // app uses. Crucial when diagnosing "why didn't it update?" reports.
    autoUpdater.logger = log;
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
    }, 10000);
    setInterval(() => {
        void runCheck();
    }, FOUR_HOURS);
}
async function runCheck() {
    try {
        await autoUpdater.checkForUpdates();
    }
    catch (err) {
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
export async function checkForUpdates() {
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
                releaseNotes: typeof result.updateInfo.releaseNotes === 'string'
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
    }
    catch (error) {
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
export async function downloadUpdate() {
    await autoUpdater.downloadUpdate();
}
export function quitAndInstall() {
    autoUpdater.quitAndInstall();
}
export function getUpdateState() {
    return currentState;
}
