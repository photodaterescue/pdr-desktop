"use strict";
/**
 * PDR extract worker — runs in an Electron utilityProcess so the
 * heavy "read 50 GB zip's central directory + extract 18k+ entries"
 * work happens off the main browser thread. Without this the per-
 * entry mkdir + the initial central-directory parse can monopolise
 * the main thread for long enough that Windows ghosts the workspace
 * as "Not Responding" while the user is staring at the Analyzing
 * modal.
 *
 * Why this exists (Terry 2026-05-24):
 *   The 50 GB Takeout test reproduced the freeze at the START of
 *   the analyse step — unzipper.Open.file parses the entire central
 *   directory synchronously after the initial async read, and the
 *   per-entry fs.mkdirSync calls add up across 18k+ entries even
 *   though each one is fast. Moving the whole extraction out of the
 *   main process keeps Chromium's message pump running so drag /
 *   resize / repaint stay smooth throughout.
 *
 * Lifecycle:
 *   1. Main process forks this worker via utilityProcess.fork.
 *   2. Main posts an 'extract' message with { zipPath, tempDir }.
 *   3. Worker creates the temp dir, opens the zip, streams each
 *      entry to disk, posts 'progress' messages periodically, and
 *      posts a final 'done' message when finished (or 'error' /
 *      'cancelled' on failure / cancel).
 *   4. Main process kills the worker after 'done' / 'error' /
 *      'cancelled'.
 *   5. Cancellation: main posts a 'cancel' message; worker sets an
 *      internal flag the per-entry loop checks every iteration.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const unzipper_1 = __importDefault(require("unzipper"));
// ─── Inline toLongPath ─────────────────────────────────────────────────────
// Duplicated from electron/long-path.ts so this worker doesn't need to
// import from the main electron module set. Keep behaviour identical.
function toLongPath(p) {
    if (process.platform !== 'win32')
        return p;
    if (!p)
        return p;
    if (p.startsWith('\\\\?\\'))
        return p;
    const normalised = p.replace(/\//g, '\\');
    if (normalised.startsWith('\\\\')) {
        return '\\\\?\\UNC\\' + normalised.slice(2);
    }
    if (/^[A-Za-z]:\\/.test(normalised)) {
        return '\\\\?\\' + normalised;
    }
    return p;
}
const parentPort = process.parentPort;
// Internal cancel flag — flipped when main posts {type:'cancel'}. The
// per-entry loop checks this every iteration and exits cleanly.
let cancelled = false;
// ─── Extraction ────────────────────────────────────────────────────────────
async function runExtract(zipPath, tempDir) {
    // Long-path prefix once up-front so the recursive mkdir + per-entry
    // writes inherit the extended-length capability. Without this, a
    // Takeout zip with Google's deeply-nested shared-album folders can
    // silently fail mid-way through extraction with UNKNOWN: read.
    const tempDirLong = toLongPath(tempDir);
    fs.mkdirSync(tempDirLong, { recursive: true });
    parentPort.postMessage({ type: 'progress', current: 0, total: 0, message: 'Unpacking ZIP archive...' });
    const directory = await unzipper_1.default.Open.file(toLongPath(zipPath));
    const totalEntries = directory.files.length;
    let extracted = 0;
    for (const file of directory.files) {
        if (cancelled) {
            parentPort.postMessage({ type: 'cancelled' });
            return;
        }
        if (file.type === 'Directory')
            continue;
        const outputPath = path.join(tempDirLong, file.path);
        const outputDir = path.dirname(outputPath);
        fs.mkdirSync(outputDir, { recursive: true });
        try {
            await new Promise((resolve, reject) => {
                const writeStream = fs.createWriteStream(outputPath);
                const readStream = file.stream();
                const onErr = (err) => {
                    readStream.removeListener('error', onErr);
                    writeStream.removeListener('error', onErr);
                    reject(err);
                };
                readStream.on('error', onErr);
                writeStream.on('error', onErr);
                readStream.pipe(writeStream).on('finish', resolve);
            });
        }
        catch (err) {
            const msg = err.message || String(err);
            // Same zlib-corruption detection as the in-main version. The
            // renderer's error handler keys on code === 'ZIP_READ_CORRUPTED'.
            const isZlibCorruption = /too many length or distance symbols/i.test(msg) ||
                /invalid distance too far back/i.test(msg) ||
                /invalid block type/i.test(msg) ||
                /invalid stored block lengths/i.test(msg) ||
                /invalid literal\/lengths set/i.test(msg) ||
                /invalid distances set/i.test(msg) ||
                /unexpected end of file/i.test(msg);
            if (isZlibCorruption) {
                parentPort.postMessage({
                    type: 'error',
                    message: 'PDR couldn\'t read this ZIP. The file appears to be corrupted, OR the connection to the source drive is unreliable (common with network drives or slow USB connections). Try copying the ZIP to a local drive on this PC first, then add it as a source.',
                    code: 'ZIP_READ_CORRUPTED',
                    details: { zlibErrorMessage: msg, failedAtEntry: file.path },
                });
            }
            else {
                parentPort.postMessage({
                    type: 'error',
                    message: msg,
                    details: { failedAtEntry: file.path },
                });
            }
            return;
        }
        extracted++;
        if (extracted % 50 === 0) {
            parentPort.postMessage({
                type: 'progress',
                current: extracted,
                total: totalEntries,
                message: `Unpacking... ${extracted.toLocaleString()} of ${totalEntries.toLocaleString()} entries`,
            });
            await new Promise((resolve) => setImmediate(resolve));
        }
    }
    parentPort.postMessage({
        type: 'progress',
        current: extracted,
        total: totalEntries,
        message: `Unpacked ${extracted.toLocaleString()} entries`,
    });
    parentPort.postMessage({ type: 'done', totalEntries, extracted });
}
// ─── Message handler ──────────────────────────────────────────────────────
parentPort.on('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object')
        return;
    if (msg.type === 'cancel') {
        cancelled = true;
        return;
    }
    if (msg.type === 'extract') {
        runExtract(msg.zipPath, msg.tempDir).catch((err) => {
            parentPort.postMessage({
                type: 'error',
                message: err?.message ?? String(err),
            });
        });
    }
});
