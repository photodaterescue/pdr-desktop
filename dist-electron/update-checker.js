import { app } from 'electron';
import pkg from 'electron-updater';
import log from 'electron-log';
const { autoUpdater } = pkg;
let mainWindowRef = null;
let currentState = { kind: 'idle' };
// Sticky for the lifetime of the update cycle. update-available
// carries the mandatory flag; subsequent download-progress and
// update-downloaded events from electron-updater don't include it,
// so we cache it here and propagate it onto every broadcast that
// represents the same update cycle. Reset on the next check.
let currentUpdateMandatory = false;
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
    // v2.0.7 — silent background download enabled.
    //
    // Why this changed: Terry's call 2026-05-17. The previous opt-in
    // model ("user sees 'Update available — Get it now' toast, must
    // click to start the download") left a long tail of customers on
    // older releases — multiple support emails about bugs we'd already
    // fixed in newer versions. Premium subscribers shouldn't be reading
    // PDR's release notes; PDR should just be current.
    //
    // New behaviour: as soon as electron-updater discovers a newer
    // version is available, it starts downloading in the background
    // (no user click required). When the download finishes, the
    // renderer's 'downloaded' toast surfaces a "Restart now / Later"
    // prompt. If the user picks Later, autoInstallOnAppQuit applies
    // the update silently the next time they close PDR. So everyone
    // converges on the latest release within at most one quit cycle
    // after a release lands — usually within the same session.
    //
    // Note this only takes effect once a user is ON v2.0.7+. Customers
    // currently on v2.0.6 still need to click "Get update" once to
    // make the jump (we can't change shipped code retroactively); from
    // v2.0.7 forwards it's all silent.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => {
        log.info('[updater] checking for update');
        // Reset the mandatory cache at the start of each new check cycle
        // so an older mandatory flag doesn't leak into a subsequent
        // non-mandatory update.
        currentUpdateMandatory = false;
        broadcast({ kind: 'checking' });
    });
    autoUpdater.on('update-available', (info) => {
        // electron-updater passes unknown manifest fields through on `info`.
        // We add `mandatory: true` to latest.yml when a release contains
        // changes critical enough to block users from continuing on the
        // old version — the renderer surfaces a non-dismissable "Restart
        // now" modal instead of the soft toast. Default false (soft).
        const mandatory = info.mandatory === true;
        currentUpdateMandatory = mandatory;
        log.info(`[updater] update available: v${info.version}${mandatory ? ' (mandatory)' : ''}`);
        broadcast({
            kind: 'available',
            version: info.version,
            releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
            currentVersion: app.getVersion(),
            mandatory,
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
            mandatory: currentUpdateMandatory,
        });
    });
    autoUpdater.on('update-downloaded', (info) => {
        log.info(`[updater] update downloaded: v${info.version}${currentUpdateMandatory ? ' (mandatory)' : ''}`);
        broadcast({ kind: 'downloaded', version: info.version, mandatory: currentUpdateMandatory });
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
