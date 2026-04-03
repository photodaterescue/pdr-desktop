import { app } from 'electron';
import https from 'https';
import http from 'http';
const VERSION_CHECK_URL = 'https://www.photodaterescue.com/api/version.json';
function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                }
                catch (e) {
                    reject(new Error('Invalid JSON response'));
                }
            });
        }).on('error', reject);
    });
}
function compareVersions(current, latest) {
    const currentParts = current.split('.').map(Number);
    const latestParts = latest.split('.').map(Number);
    for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
        const c = currentParts[i] || 0;
        const l = latestParts[i] || 0;
        if (l > c)
            return true;
        if (l < c)
            return false;
    }
    return false;
}
export async function checkForUpdates() {
    const currentVersion = app.getVersion();
    try {
        const response = await fetchJSON(VERSION_CHECK_URL);
        const updateAvailable = compareVersions(currentVersion, response.version);
        return {
            currentVersion,
            latestVersion: response.version,
            updateAvailable,
            mandatory: response.mandatory || false,
            downloadUrl: response.downloadUrl,
            releaseNotes: response.releaseNotes,
        };
    }
    catch (error) {
        console.error('Update check failed:', error);
        return {
            currentVersion,
            latestVersion: currentVersion,
            updateAvailable: false,
            mandatory: false,
            downloadUrl: '',
        };
    }
}
