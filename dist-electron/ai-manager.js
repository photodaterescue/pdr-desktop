/**
 * AI Manager — Main-process coordinator for face detection, recognition, and object tagging.
 *
 * Architecture:
 * - Runs AI inference in a background worker thread (not utility process, for simpler IPC)
 * - Uses @huggingface/transformers with ONNX Runtime for local inference
 * - All processing is local — no data leaves the machine
 * - Results stored in SQLite via search-database.ts helpers
 */
import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { getUnprocessedFileIds, getFileById, markAiProcessed, insertFaceDetections, clearUnverifiedFacesForFile, insertAiTags, rebuildAiFts, getAllFaceEmbeddings, updateFaceCluster, clearFaceDataForModelUpgrade, } from './search-database.js';
import { getSettings } from './settings-store.js';
// ─── State ───────────────────────────────────────────────────────────────────
let worker = null;
let isProcessing = false;
let shouldCancel = false;
let isPaused = false;
// Track whether the active run is tags-only so every sendProgress call
// picks up the flag without having to thread it through manually.
let currentRunTagsOnly = false;
let mainWindow = null;
let totalFacesFound = 0;
let totalTagsApplied = 0;
let workerFacesAvailable = false;
let workerTagsAvailable = false;
let powerSaveBlockerId = null;
// Buffer worker log messages so they can be replayed when the renderer connects
const workerLogBuffer = [];
const MAX_LOG_BUFFER = 200;
function bufferAndSendLog(message) {
    console.log(message);
    workerLogBuffer.push(message);
    if (workerLogBuffer.length > MAX_LOG_BUFFER)
        workerLogBuffer.shift();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ai:log', message);
    }
}
/** Replay buffered log messages to the renderer (called when renderer requests them) */
export function replayWorkerLogs() {
    return [...workerLogBuffer];
}
// ─── Public API ──────────────────────────────────────────────────────────────
export function setMainWindow(win) {
    mainWindow = win;
}
export function isAiProcessing() {
    return isProcessing;
}
/**
 * Check whether AI models have been downloaded.
 * Looks for ONNX model files in the cache directory.
 */
export function areModelsDownloaded() {
    // Face models (@vladmandic/human) are bundled — always available
    // Check if CLIP tagging model has been downloaded (ONNX file in cache)
    const modelsDir = path.join(app.getPath('userData'), 'ai-models');
    if (!fs.existsSync(modelsDir))
        return false;
    const findOnnx = (dir) => {
        let count = 0;
        try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory())
                    count += findOnnx(path.join(dir, entry.name));
                else if (entry.name.endsWith('.onnx'))
                    count++;
                if (count >= 1)
                    return count;
            }
        }
        catch { }
        return count;
    };
    return findOnnx(modelsDir) >= 1;
}
/**
 * Start processing all unprocessed photos.
 * Non-blocking — runs in background, sends progress via IPC.
 */
export async function startAiProcessing(opts) {
    if (isProcessing) {
        console.log('[AI] Already processing, ignoring start request');
        return;
    }
    const settings = getSettings();
    if (!settings.aiEnabled) {
        console.log('[AI] AI is disabled in settings');
        return;
    }
    const tagsOnly = opts?.tagsOnly === true;
    // In tagsOnly mode we force the tags leg on regardless of the per-run
    // feature toggle — the user has explicitly asked for re-tagging and
    // we're running against the already-reset tags_processed flag.
    const enableFaces = tagsOnly ? false : settings.aiFaceDetection;
    const enableTags = tagsOnly ? true : settings.aiObjectTagging;
    console.log(`[AI] Settings — enableFaces: ${enableFaces}, enableTags: ${enableTags}, aiEnabled: ${settings.aiEnabled}, tagsOnly: ${tagsOnly}`);
    if (!enableFaces && !enableTags) {
        console.log('[AI] Both face detection and object tagging are disabled');
        return;
    }
    isProcessing = true;
    shouldCancel = false;
    totalFacesFound = 0;
    totalTagsApplied = 0;
    currentRunTagsOnly = tagsOnly;
    // Prevent the system from sleeping while AI processing is running
    if (powerSaveBlockerId === null) {
        powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
        console.log('[AI] Power save blocker started — system will stay awake during processing');
    }
    try {
        // Migrate old DETR face data to new model if needed. Skip when
        // re-tagging only — touching face data would blow away verified
        // assignments users care about.
        if (enableFaces && !tagsOnly) {
            clearFaceDataForModelUpgrade();
        }
        // Get unprocessed file IDs. In tagsOnly mode we query the tags
        // queue even when faces processing would normally take priority.
        const task = tagsOnly ? 'tags' : (enableFaces ? 'faces' : 'tags');
        const fileIds = getUnprocessedFileIds(task, 10000);
        if (fileIds.length === 0) {
            console.log('[AI] No unprocessed files found');
            sendProgress({ phase: 'complete', current: 0, total: 0, currentFile: '', facesFound: 0, tagsApplied: 0 });
            isProcessing = false;
            return;
        }
        console.log(`[AI] Starting processing of ${fileIds.length} files`);
        // Spawn worker
        await ensureWorker(settings);
        // Process each file
        for (let i = 0; i < fileIds.length; i++) {
            if (shouldCancel) {
                console.log('[AI] Processing cancelled');
                break;
            }
            // Wait while paused
            while (isPaused && !shouldCancel) {
                sendProgress({
                    phase: 'paused',
                    current: i,
                    total: fileIds.length,
                    currentFile: 'Paused — click resume to continue',
                    facesFound: totalFacesFound,
                    tagsApplied: totalTagsApplied,
                });
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            if (shouldCancel)
                break;
            const file = getFileById(fileIds[i]);
            if (!file)
                continue;
            sendProgress({
                phase: 'processing',
                current: i + 1,
                total: fileIds.length,
                currentFile: file.filename,
                facesFound: totalFacesFound,
                tagsApplied: totalTagsApplied,
            });
            try {
                const result = await processFileInWorker(file.id, file.file_path);
                bufferAndSendLog(`[AI] File ${file.id} (${file.filename}): result=${result ? 'OK' : 'null'}, faces=${result?.faces?.length ?? 0}, tags=${result?.tags?.length ?? 0}`);
                if (result) {
                    // Wipe any pre-existing UNVERIFIED face rows before inserting
                    // fresh detections — stops re-processing from stacking duplicates.
                    // Skip when re-tagging only — we must never touch face data.
                    if (!tagsOnly) {
                        clearUnverifiedFacesForFile(file.id);
                    }
                    // Store face detections — skipped in tagsOnly mode.
                    if (!tagsOnly && result.faces && result.faces.length > 0) {
                        const faceRecords = result.faces.map(f => ({
                            file_id: file.id,
                            person_id: null,
                            box_x: f.box_x,
                            box_y: f.box_y,
                            box_w: f.box_w,
                            box_h: f.box_h,
                            embedding: f.embedding ? Buffer.from(new Float32Array(f.embedding).buffer) : null,
                            confidence: f.confidence,
                            cluster_id: null,
                        }));
                        insertFaceDetections(faceRecords);
                        totalFacesFound += result.faces.length;
                    }
                    // Store tags
                    if (result.tags && result.tags.length > 0) {
                        const tagRecords = result.tags.map(t => ({
                            file_id: file.id,
                            tag: t.tag,
                            confidence: t.confidence,
                            source: 'ai',
                            model_ver: 'transformers-v1',
                        }));
                        insertAiTags(tagRecords);
                        totalTagsApplied += result.tags.length;
                    }
                    // Mark as processed — only for features that were actually run.
                    if (!tagsOnly && enableFaces && workerFacesAvailable)
                        markAiProcessed(file.id, 'faces', 'human-v1');
                    if (enableTags && workerTagsAvailable)
                        markAiProcessed(file.id, 'tags', 'transformers-v1');
                    // Update AI FTS
                    rebuildAiFts(file.id);
                }
            }
            catch (err) {
                console.error(`[AI] Error processing file ${file.filename}:`, err);
            }
            // Yield to event loop every 5 files
            if (i % 5 === 0) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }
        // Run face clustering after all faces are processed — skip in
        // tagsOnly mode where we didn't touch any face data.
        if (!tagsOnly && enableFaces && totalFacesFound > 0 && !shouldCancel) {
            sendProgress({
                phase: 'clustering',
                current: 0,
                total: 0,
                currentFile: 'Clustering faces...',
                facesFound: totalFacesFound,
                tagsApplied: totalTagsApplied,
            });
            await runFaceClustering();
        }
        sendProgress({
            phase: 'complete',
            current: fileIds.length,
            total: fileIds.length,
            currentFile: '',
            facesFound: totalFacesFound,
            tagsApplied: totalTagsApplied,
        });
    }
    catch (err) {
        console.error('[AI] Processing error:', err);
        sendProgress({
            phase: 'error',
            current: 0,
            total: 0,
            currentFile: err.message,
            facesFound: totalFacesFound,
            tagsApplied: totalTagsApplied,
        });
    }
    finally {
        isProcessing = false;
        shouldCancel = false;
        // Release power save blocker
        if (powerSaveBlockerId !== null) {
            powerSaveBlocker.stop(powerSaveBlockerId);
            powerSaveBlockerId = null;
            console.log('[AI] Power save blocker released — system can sleep again');
        }
    }
}
export function cancelAiProcessing() {
    shouldCancel = true;
    isPaused = false; // Ensure cancel overrides pause
}
export function pauseAiProcessing() {
    if (isProcessing && !isPaused) {
        isPaused = true;
        console.log('[AI] Processing paused by user');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ai:paused', true);
        }
    }
}
export function resumeAiProcessing() {
    if (isProcessing && isPaused) {
        isPaused = false;
        console.log('[AI] Processing resumed by user');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ai:paused', false);
        }
    }
}
export function isAiPaused() {
    return isPaused;
}
export function shutdownAiWorker() {
    if (worker) {
        worker.postMessage({ type: 'shutdown' });
        worker.terminate();
        worker = null;
    }
}
/**
 * Re-run face detection against a single file and merge the result into
 * face_detections. Wired to the per-photo "Re-detect faces" button on
 * the S&D Details panel — gives the user an escape hatch when Human.js
 * missed a face on the first analysis pass (e.g. side profile, partial
 * occlusion, low light, glasses) without forcing them to clear all AI
 * data and re-run the entire library.
 *
 * Behaviour mirrors the bulk pipeline:
 *   • Refuses if a full analysis is already running — same worker.
 *   • Wipes only UNVERIFIED rows for this file before inserting
 *     (verified rows are sacred — never lose a tick).
 *   • Re-runs refineFromVerifiedFaces on completion so any new faces
 *     auto-match against existing named persons in the same click.
 *
 * Returns the new face count for the toast that the renderer will show.
 */
export async function redetectSingleFile(fileId) {
    if (isProcessing) {
        return { ok: false, newFaces: 0, error: 'AI analysis is already running. Wait for it to finish, then try again.' };
    }
    const settings = getSettings();
    if (!settings.aiEnabled) {
        return { ok: false, newFaces: 0, error: 'AI is currently disabled in Settings.' };
    }
    if (!settings.aiFaceDetection) {
        return { ok: false, newFaces: 0, error: 'Face detection is disabled in Settings.' };
    }
    const file = getFileById(fileId);
    if (!file) {
        return { ok: false, newFaces: 0, error: 'File not found in the index.' };
    }
    // Block other AI work while this single-file pass runs. Same flag the
    // bulk pipeline uses, so cancellation / pause semantics stay consistent
    // and the UI gates correctly.
    isProcessing = true;
    try {
        await ensureWorker(settings);
        const result = await processFileInWorker(fileId, file.file_path);
        if (!result) {
            return { ok: false, newFaces: 0, error: 'Worker did not return a result. Check the AI log.' };
        }
        // Replace only unverified detections — verified rows survive.
        clearUnverifiedFacesForFile(fileId);
        let newFaces = 0;
        if (result.faces && result.faces.length > 0) {
            const faceRecords = result.faces.map(f => ({
                file_id: fileId,
                person_id: null,
                box_x: f.box_x,
                box_y: f.box_y,
                box_w: f.box_w,
                box_h: f.box_h,
                embedding: f.embedding ? Buffer.from(new Float32Array(f.embedding).buffer) : null,
                confidence: f.confidence,
                cluster_id: null,
            }));
            insertFaceDetections(faceRecords);
            newFaces = result.faces.length;
        }
        markAiProcessed(fileId, 'faces', 'human-v1');
        rebuildAiFts(fileId);
        // Auto-match the freshly-detected faces against existing named
        // persons so the user gets coloured rings + names without a second
        // click. Threshold honours the same S&D slider the bulk run uses.
        if (newFaces > 0) {
            try {
                const { refineFromVerifiedFaces } = await import('./search-database.js');
                const threshold = settings.aiSearchMatchThreshold ?? 0.72;
                refineFromVerifiedFaces(threshold);
            }
            catch (err) {
                console.warn('[AI] redetect: refine pass failed (faces still saved):', err.message);
            }
        }
        return { ok: true, newFaces };
    }
    catch (err) {
        return { ok: false, newFaces: 0, error: err.message };
    }
    finally {
        isProcessing = false;
    }
}
// ─── Worker management ──────────────────────────────────────────────────────
async function ensureWorker(settings) {
    if (worker)
        return;
    const modelsDir = path.join(app.getPath('userData'), 'ai-models');
    return new Promise((resolve, reject) => {
        const workerPath = app.isPackaged
            ? path.join(process.resourcesPath, 'dist-electron/ai-worker.cjs')
            : path.join(__dirname, 'ai-worker.cjs');
        // Resolve the @vladmandic/human models path
        let humanModelsPath;
        if (app.isPackaged) {
            // In production, models are bundled in extraResources
            humanModelsPath = path.join(process.resourcesPath, 'human-models');
        }
        else {
            // In development, use the models from node_modules
            humanModelsPath = path.join(__dirname, '..', 'node_modules', '@vladmandic', 'human', 'models');
        }
        worker = new Worker(workerPath, {
            workerData: {
                modelsDir,
                minFaceConfidence: settings.aiMinFaceConfidence,
                minTagConfidence: settings.aiMinTagConfidence,
                enableFaces: settings.aiFaceDetection,
                enableTags: settings.aiObjectTagging,
                humanModelsPath,
            },
        });
        const onReady = (msg) => {
            if (msg.type === 'ready') {
                workerFacesAvailable = msg.facesAvailable ?? false;
                workerTagsAvailable = msg.tagsAvailable ?? false;
                bufferAndSendLog(`[AI] Worker ready — face detection: ${workerFacesAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}, tagging: ${workerTagsAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}`);
                resolve();
            }
            else if (msg.type === 'model-progress') {
                sendProgress({
                    phase: 'downloading-models',
                    current: 0,
                    total: 0,
                    currentFile: `Downloading ${msg.model}...`,
                    facesFound: 0,
                    tagsApplied: 0,
                    modelDownloadProgress: { model: msg.model || '', percent: msg.percent || 0 },
                });
            }
            else if (msg.type === 'error') {
                reject(new Error(msg.error || 'Worker initialization failed'));
            }
            else if (msg.type === 'log') {
                bufferAndSendLog(`[AI Worker] ${msg.message}`);
            }
        };
        worker.on('message', onReady);
        worker.on('error', (err) => {
            console.error('[AI] Worker error:', err);
            worker = null;
            reject(err);
        });
        worker.on('exit', (code) => {
            console.log(`[AI] Worker exited with code ${code}`);
            worker = null;
        });
    });
}
function processFileInWorker(fileId, filePath) {
    return new Promise((resolve, reject) => {
        if (!worker) {
            reject(new Error('Worker not running'));
            return;
        }
        const handler = (msg) => {
            if (msg.fileId === fileId) {
                worker?.off('message', handler);
                if (msg.type === 'result')
                    resolve(msg);
                else if (msg.type === 'error') {
                    console.warn(`[AI] File error: ${msg.error}`);
                    resolve(null);
                }
            }
        };
        worker.on('message', handler);
        worker.postMessage({ type: 'process-file', fileId, filePath });
        // Timeout after 60s per file
        setTimeout(() => {
            worker?.off('message', handler);
            resolve(null);
        }, 60000);
    });
}
// ─── Face clustering (DBSCAN-like) ─────────────────────────────────────────
/**
 * Cluster all face embeddings into person groups. The algorithm is
 * O(N²) cosine similarity (every face compared to every cluster
 * centroid + seed), so on 1000+ faces it ran for several seconds
 * synchronously — long enough to block the main process and trigger
 * Windows' "Not Responding" banner on every open BrowserWindow,
 * because input events queue up while main is busy.
 *
 * The fix: yield to the event loop after every CHUNK_SIZE outer-loop
 * iterations using a setImmediate. The total wall time is roughly
 * the same, but main stays responsive to IPC pings and input events
 * between chunks. Now an async function so callers can await it.
 */
export async function runFaceClustering(customThreshold) {
    console.log('[AI] Running face clustering...');
    const faces = getAllFaceEmbeddings();
    if (faces.length === 0)
        return;
    const embeddings = faces
        .filter(f => f.embedding && f.embedding.length > 0)
        .map(f => ({
        id: f.id,
        vec: new Float32Array(f.embedding.buffer, f.embedding.byteOffset, f.embedding.byteLength / 4),
    }));
    if (embeddings.length === 0)
        return;
    const SIMILARITY_THRESHOLD = customThreshold ?? 0.72;
    const SEED_THRESHOLD = Math.max(0.55, SIMILARITY_THRESHOLD - 0.07);
    const visited = new Set();
    let nextClusterId = 1;
    // Yield about every 25 seed iterations so a 1000-face library still
    // pumps event-loop turns ~40 times during the run.
    const CHUNK_SIZE = 25;
    const yieldNow = () => new Promise((r) => setImmediate(r));
    for (let i = 0; i < embeddings.length; i++) {
        if (i > 0 && i % CHUNK_SIZE === 0)
            await yieldNow();
        if (visited.has(i))
            continue;
        visited.add(i);
        const cluster = [i];
        const seed = embeddings[i].vec;
        const dim = seed.length;
        const centroid = new Float32Array(dim);
        for (let d = 0; d < dim; d++)
            centroid[d] = seed[d];
        let changed = true;
        while (changed) {
            changed = false;
            for (let j = 0; j < embeddings.length; j++) {
                if (visited.has(j))
                    continue;
                const simCentroid = cosineSimilarity(centroid, embeddings[j].vec);
                const simSeed = cosineSimilarity(seed, embeddings[j].vec);
                if (simCentroid >= SIMILARITY_THRESHOLD && simSeed >= SEED_THRESHOLD) {
                    visited.add(j);
                    cluster.push(j);
                    const n = cluster.length;
                    for (let d = 0; d < dim; d++) {
                        centroid[d] = centroid[d] * ((n - 1) / n) + embeddings[j].vec[d] / n;
                    }
                    changed = true;
                }
            }
        }
        const clusterId = nextClusterId++;
        for (const idx of cluster) {
            updateFaceCluster(embeddings[idx].id, clusterId);
        }
    }
    console.log(`[AI] Clustering complete: ${nextClusterId - 1} clusters from ${embeddings.length} faces`);
}
function cosineSimilarity(a, b) {
    if (a.length !== b.length)
        return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const mag = Math.sqrt(magA) * Math.sqrt(magB);
    return mag === 0 ? 0 : dot / mag;
}
// ─── Progress IPC ──────────────────────────────────────────────────────────
function sendProgress(progress) {
    // Tag every progress payload with the active run's tagsOnly flag so
    // the renderer can show "Tagging X/Y" vs "Analyzing X/Y" without
    // having to track state on its side.
    const payload = { ...progress, tagsOnly: currentRunTagsOnly };
    // Broadcast to EVERY open renderer window — main, People Manager,
    // Date Editor, etc. — so any window subscribed to `ai:progress`
    // sees the same counter updates. Previously only mainWindow got them,
    // which left the People Manager (where faces actually land) with no
    // visibility into analysis progress.
    for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed())
            continue;
        try {
            win.webContents.send('ai:progress', payload);
        }
        catch { }
    }
}
