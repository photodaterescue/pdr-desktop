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
import {
  getUnprocessedFileIds,
  getFileById,
  markAiProcessed,
  insertFaceDetections,
  clearUnverifiedFacesForFile,
  insertAiTags,
  rebuildAiFts,
  getAllFaceEmbeddings,
  updateFaceCluster,
  updateFaceClustersBatch,
  getAiStats,
  clearAllAiData,
  clearFaceDataForModelUpgrade,
  type FaceDetectionRecord,
  type AiTagRecord,
} from './search-database.js';
import { getSettings } from './settings-store.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AiProgress {
  phase: 'downloading-models' | 'processing' | 'clustering' | 'complete' | 'error' | 'paused';
  current: number;
  total: number;
  currentFile: string;
  facesFound: number;
  tagsApplied: number;
  modelDownloadProgress?: { model: string; percent: number };
  /** True when the current run is tags-only (re-tagging). Drives the
   *  UI label — "Tagging X/Y" vs the generic "Analyzing X/Y". */
  tagsOnly?: boolean;
}

interface WorkerMessage {
  type: 'ready' | 'result' | 'error' | 'model-progress' | 'log';
  fileId?: number;
  faces?: Array<{
    box_x: number; box_y: number; box_w: number; box_h: number;
    embedding: number[];
    confidence: number;
  }>;
  tags?: Array<{ tag: string; confidence: number }>;
  error?: string;
  model?: string;
  percent?: number;
  message?: string;
  facesAvailable?: boolean;
  tagsAvailable?: boolean;
}

interface WorkerCommand {
  type: 'init' | 'process-file' | 'shutdown';
  config?: {
    modelsDir: string;
    minFaceConfidence: number;
    minTagConfidence: number;
    enableFaces: boolean;
    enableTags: boolean;
  };
  fileId?: number;
  filePath?: string;
}

// ─── State ───────────────────────────────────────────────────────────────────

let worker: Worker | null = null;
let isProcessing = false;
let shouldCancel = false;
let isPaused = false;
// Track whether the active run is tags-only so every sendProgress call
// picks up the flag without having to thread it through manually.
let currentRunTagsOnly = false;
let mainWindow: BrowserWindow | null = null;
let totalFacesFound = 0;
let totalTagsApplied = 0;
let workerFacesAvailable = false;
let workerTagsAvailable = false;
let powerSaveBlockerId: number | null = null;

// Buffer worker log messages so they can be replayed when the renderer connects
const workerLogBuffer: string[] = [];
const MAX_LOG_BUFFER = 200;

function bufferAndSendLog(message: string): void {
  console.log(message);
  workerLogBuffer.push(message);
  if (workerLogBuffer.length > MAX_LOG_BUFFER) workerLogBuffer.shift();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ai:log', message);
  }
}

/** Replay buffered log messages to the renderer (called when renderer requests them) */
export function replayWorkerLogs(): string[] {
  return [...workerLogBuffer];
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;
}

export function isAiProcessing(): boolean {
  return isProcessing;
}

/**
 * Check whether AI models have been downloaded.
 * Looks for ONNX model files in the cache directory.
 */
export function areModelsDownloaded(): boolean {
  // Face models (@vladmandic/human) are bundled — always available
  // Check if CLIP tagging model has been downloaded (ONNX file in cache)
  const modelsDir = path.join(app.getPath('userData'), 'ai-models');
  if (!fs.existsSync(modelsDir)) return false;
  const findOnnx = (dir: string): number => {
    let count = 0;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) count += findOnnx(path.join(dir, entry.name));
        else if (entry.name.endsWith('.onnx')) count++;
        if (count >= 1) return count;
      }
    } catch {}
    return count;
  };
  return findOnnx(modelsDir) >= 1;
}

/**
 * Start processing all unprocessed photos.
 * Non-blocking — runs in background, sends progress via IPC.
 */
export async function startAiProcessing(opts?: { tagsOnly?: boolean }): Promise<void> {
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
      if (shouldCancel) break;

      const file = getFileById(fileIds[i]);
      if (!file) continue;

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
            const faceRecords: FaceDetectionRecord[] = result.faces.map(f => ({
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
            const tagRecords: AiTagRecord[] = result.tags.map(t => ({
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
          if (!tagsOnly && enableFaces && workerFacesAvailable) markAiProcessed(file.id, 'faces', 'human-v1');
          if (enableTags && workerTagsAvailable) markAiProcessed(file.id, 'tags', 'transformers-v1');

          // Update AI FTS
          rebuildAiFts(file.id);
        }
      } catch (err) {
        console.error(`[AI] Error processing file ${file.filename}:`, err);
      }

      // Yield to event loop every 5 files
      if (i % 5 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    // Cluster the freshly-detected faces against existing cluster
    // centroids — INCREMENTAL, not full rebuild. Preserves every
    // existing cluster_id so People Manager person↔cluster mappings
    // stay intact across analysis passes (the old full re-cluster
    // would renumber every cluster from 1, which silently churned
    // the "unnamed face" groups even when the user hadn't asked).
    if (!tagsOnly && enableFaces && totalFacesFound > 0 && !shouldCancel) {
      sendProgress({
        phase: 'clustering',
        current: 0,
        total: 0,
        currentFile: 'Clustering faces...',
        facesFound: totalFacesFound,
        tagsApplied: totalTagsApplied,
      });
      await runIncrementalClustering();
    }

    sendProgress({
      phase: 'complete',
      current: fileIds.length,
      total: fileIds.length,
      currentFile: '',
      facesFound: totalFacesFound,
      tagsApplied: totalTagsApplied,
    });
  } catch (err) {
    console.error('[AI] Processing error:', err);
    sendProgress({
      phase: 'error',
      current: 0,
      total: 0,
      currentFile: (err as Error).message,
      facesFound: totalFacesFound,
      tagsApplied: totalTagsApplied,
    });
  } finally {
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

export function cancelAiProcessing(): void {
  shouldCancel = true;
  isPaused = false; // Ensure cancel overrides pause
}

export function pauseAiProcessing(): void {
  if (isProcessing && !isPaused) {
    isPaused = true;
    console.log('[AI] Processing paused by user');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai:paused', true);
    }
  }
}

export function resumeAiProcessing(): void {
  if (isProcessing && isPaused) {
    isPaused = false;
    console.log('[AI] Processing resumed by user');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai:paused', false);
    }
  }
}

export function isAiPaused(): boolean {
  return isPaused;
}

export function shutdownAiWorker(): void {
  if (worker) {
    worker.postMessage({ type: 'shutdown' } as WorkerCommand);
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
export async function redetectSingleFile(
  fileId: number,
): Promise<{ ok: boolean; newFaces: number; error?: string }> {
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
      const faceRecords: FaceDetectionRecord[] = result.faces.map(f => ({
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
        // v2.0.15 (Terry 2026-06-05) — now async + cooperatively yielding.
        await refineFromVerifiedFaces(threshold);
      } catch (err) {
        console.warn('[AI] redetect: refine pass failed (faces still saved):', (err as Error).message);
      }
    }

    return { ok: true, newFaces };
  } catch (err) {
    return { ok: false, newFaces: 0, error: (err as Error).message };
  } finally {
    isProcessing = false;
  }
}

// ─── Worker management ──────────────────────────────────────────────────────

async function ensureWorker(settings: ReturnType<typeof getSettings>): Promise<void> {
  if (worker) return;

  const modelsDir = path.join(app.getPath('userData'), 'ai-models');

  return new Promise((resolve, reject) => {
    // v2.0.13 (Terry 2026-05-27) — ai-worker.cjs is loaded as a
    // worker_threads.Worker (a THREAD in the main process), not via
    // utilityProcess.fork. Worker threads share the main process's
    // asar mount, so the worker CAN live inside app.asar where its
    // `require('sharp')` resolves cleanly via the asar's
    // node_modules. The v2.0.11 packaging bug only applied to
    // utility-process workers (cleanup / extract / conversion /
    // startup) which fork as separate OS processes and need a real
    // filesystem path; those four stay in resources/dist-electron/
    // via extraResources. ai-worker is back inside the asar so
    // sharp / @vladmandic/human / onnxruntime-node resolve normally.
    const workerPath = path.join(__dirname, 'ai-worker.cjs');

    // Resolve the @vladmandic/human models path
    let humanModelsPath: string;
    if (app.isPackaged) {
      // In production, models are bundled in extraResources
      humanModelsPath = path.join(process.resourcesPath, 'human-models');
    } else {
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

    const onReady = (msg: WorkerMessage) => {
      if (msg.type === 'ready') {
        workerFacesAvailable = msg.facesAvailable ?? false;
        workerTagsAvailable = msg.tagsAvailable ?? false;
        bufferAndSendLog(`[AI] Worker ready — face detection: ${workerFacesAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}, tagging: ${workerTagsAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}`);
        resolve();
      } else if (msg.type === 'model-progress') {
        sendProgress({
          phase: 'downloading-models',
          current: 0,
          total: 0,
          currentFile: `Downloading ${msg.model}...`,
          facesFound: 0,
          tagsApplied: 0,
          modelDownloadProgress: { model: msg.model || '', percent: msg.percent || 0 },
        });
      } else if (msg.type === 'error') {
        reject(new Error(msg.error || 'Worker initialization failed'));
      } else if (msg.type === 'log') {
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

function processFileInWorker(fileId: number, filePath: string): Promise<WorkerMessage | null> {
  return new Promise((resolve, reject) => {
    if (!worker) { reject(new Error('Worker not running')); return; }

    const handler = (msg: WorkerMessage) => {
      if (msg.fileId === fileId) {
        worker?.off('message', handler);
        if (msg.type === 'result') resolve(msg);
        else if (msg.type === 'error') { console.warn(`[AI] File error: ${msg.error}`); resolve(null); }
      }
    };

    worker.on('message', handler);
    worker.postMessage({ type: 'process-file', fileId, filePath } as WorkerCommand);

    // Timeout after 60s per file
    setTimeout(() => {
      worker?.off('message', handler);
      resolve(null);
    }, 60000);
  });
}

// ─── Face clustering (delegated to AI worker thread) ───────────────────────
//
// Clustering used to run on main, with time-budgeted setImmediate yields
// to keep main responsive. That wasn't enough on a 36K-face library: even
// 50ms work chunks accumulated enough OS-window-message starvation that
// Windows marked PDR "Not Responding". Now both incremental and full
// clustering run inside the existing AI worker_thread — main stays
// fully responsive, and the worker hands back a single batched update
// that main applies in one DB transaction.

/**
 * INCREMENTAL clustering — assigns only faces with cluster_id IS NULL
 * to either the best matching existing cluster or a brand-new cluster
 * seeded from the face itself. Runs in O(U × K) where U is the
 * unclustered count and K is the existing-cluster count, vs full
 * re-cluster which is O(N²) over EVERY face — a 100×+ speedup on a
 * 36K-face library where 4–5K new faces came in from a Takeout import.
 *
 * Existing cluster_id assignments are preserved, so People Manager
 * person→cluster mappings stay intact. The full runFaceClustering()
 * path destroys all assignments and is reserved for the user-triggered
 * "Re-cluster from scratch" in Settings → AI.
 */
export async function runIncrementalClustering(customThreshold?: number): Promise<void> {
  const faces = getAllFaceEmbeddings();
  if (faces.length === 0) return;
  const validFaces = faces.filter(f => f.embedding && f.embedding.length > 0);
  const clustered = validFaces.filter(f => f.cluster_id !== null);
  const unclustered = validFaces.filter(f => f.cluster_id === null);
  if (unclustered.length === 0) {
    console.log('[AI] Incremental clustering: nothing to do');
    return;
  }

  // Pull the worker dimension from any face's embedding (all have the same)
  const dim = unclustered[0].embedding.byteLength / 4;

  // Build centroids on main (one DB read), packed into flat ArrayBuffers
  // for transferable postMessage to the worker.
  const centroidMap = new Map<number, { sum: Float32Array; count: number }>();
  for (const f of clustered) {
    const vec = new Float32Array(f.embedding.buffer, f.embedding.byteOffset, dim);
    const c = centroidMap.get(f.cluster_id!);
    if (c) {
      for (let d = 0; d < dim; d++) c.sum[d] += vec[d];
      c.count++;
    } else {
      const sum = new Float32Array(dim);
      for (let d = 0; d < dim; d++) sum[d] = vec[d];
      centroidMap.set(f.cluster_id!, { sum, count: 1 });
    }
  }
  const K = centroidMap.size;
  const centroidIds = new Int32Array(K);
  const centroidCounts = new Int32Array(K);
  const centroidsFlat = new Float32Array(K * dim);
  let kIdx = 0;
  let maxClusterId = 0;
  for (const [id, { sum, count }] of centroidMap) {
    centroidIds[kIdx] = id;
    centroidCounts[kIdx] = count;
    for (let d = 0; d < dim; d++) centroidsFlat[kIdx * dim + d] = sum[d] / count;
    if (id > maxClusterId) maxClusterId = id;
    kIdx++;
  }

  const N = unclustered.length;
  const embeddingsFlat = new Float32Array(N * dim);
  const faceIds = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const f = unclustered[i];
    const vec = new Float32Array(f.embedding.buffer, f.embedding.byteOffset, dim);
    for (let d = 0; d < dim; d++) embeddingsFlat[i * dim + d] = vec[d];
    faceIds[i] = f.id;
  }

  console.log(`[AI] Incremental clustering: dispatching ${N} faces against ${K} centroids to AI worker`);

  // Ensure worker is up before dispatching
  const settings = getSettings();
  try {
    await ensureWorker(settings);
  } catch (err) {
    console.error('[AI] Could not start AI worker for clustering:', err);
    return;
  }

  const result = await sendClusteringToWorker({
    type: 'cluster-incremental',
    embeddings: embeddingsFlat.buffer,
    faceIds: faceIds.buffer,
    existingCentroids: centroidsFlat.buffer,
    existingCentroidIds: centroidIds.buffer,
    existingCentroidCounts: centroidCounts.buffer,
    nextClusterId: maxClusterId + 1,
    dim,
    threshold: customThreshold ?? 0.72,
  });
  if (!result) return;

  // Apply assignments in a single transaction
  const assignments = new Int32Array(result.assignments);
  const returnedFaceIds = new Int32Array(result.faceIds);
  const updates: { faceId: number; clusterId: number }[] = [];
  for (let i = 0; i < assignments.length; i++) {
    updates.push({ faceId: returnedFaceIds[i], clusterId: assignments[i] });
  }
  updateFaceClustersBatch(updates);
  console.log(`[AI] Incremental clustering applied: ${updates.length} face assignments written`);
}

/**
 * Send a clustering job to the AI worker and await the result.
 * Resolves with the assignments + faceIds ArrayBuffers, or null on error.
 */
function sendClusteringToWorker(msg: any): Promise<{ assignments: ArrayBuffer; faceIds: ArrayBuffer; nextClusterId: number } | null> {
  return new Promise((resolve) => {
    if (!worker) { resolve(null); return; }

    const handler = (response: any) => {
      if (response?.type === 'cluster-result') {
        worker?.off('message', handler);
        resolve({
          assignments: response.assignments,
          faceIds: response.faceIds,
          nextClusterId: response.nextClusterId,
        });
      } else if (response?.type === 'cluster-error') {
        worker?.off('message', handler);
        console.error('[AI] Worker clustering error:', response.error);
        resolve(null);
      } else if (response?.type === 'cluster-progress') {
        console.log(`[AI] Clustering progress: ${response.current}/${response.total} seeds, ${response.clusters} clusters`);
      }
      // Other message types (log, ready) are handled by other listeners
    };
    worker.on('message', handler);
    worker.postMessage(msg, [msg.embeddings, msg.faceIds].concat(
      msg.existingCentroids ? [msg.existingCentroids, msg.existingCentroidIds, msg.existingCentroidCounts] : []
    ));
  });
}

/** Old in-main implementation kept here for reference of the algorithm —
 *  now superseded by the worker-side equivalent. Marked unused. */
async function _legacyRunIncrementalClustering(customThreshold?: number): Promise<void> {
  const faces = getAllFaceEmbeddings();
  if (faces.length === 0) return;

  const validFaces = faces.filter(f => f.embedding && f.embedding.length > 0);
  const clustered = validFaces.filter(f => f.cluster_id !== null);
  const unclustered = validFaces.filter(f => f.cluster_id === null);

  if (unclustered.length === 0) {
    console.log('[AI] Incremental clustering: nothing to do');
    return;
  }

  console.log(`[AI] Incremental clustering: ${unclustered.length} unclustered face(s) against ${clustered.length} existing assignment(s)`);
  const startedAt = Date.now();

  const SIMILARITY_THRESHOLD = customThreshold ?? 0.72;

  // Build cluster centroids from existing assignments using an online
  // running mean — no need to allocate per-cluster face arrays.
  const centroids = new Map<number, { vec: Float32Array; count: number }>();
  for (const f of clustered) {
    const vec = new Float32Array(f.embedding.buffer, f.embedding.byteOffset, f.embedding.byteLength / 4);
    const existing = centroids.get(f.cluster_id!);
    if (existing) {
      const n = existing.count + 1;
      const dim = vec.length;
      for (let d = 0; d < dim; d++) {
        existing.vec[d] = existing.vec[d] * (existing.count / n) + vec[d] / n;
      }
      existing.count = n;
    } else {
      const copy = new Float32Array(vec.length);
      for (let d = 0; d < vec.length; d++) copy[d] = vec[d];
      centroids.set(f.cluster_id!, { vec: copy, count: 1 });
    }
  }

  let nextClusterId = 1;
  for (const id of centroids.keys()) {
    if (id >= nextClusterId) nextClusterId = id + 1;
  }

  const WORK_BUDGET = 50_000;
  let workSinceYield = 0;
  const yieldNow = () => new Promise<void>((r) => setImmediate(r));

  let assignedExisting = 0;
  let newClustersSeeded = 0;

  for (const face of unclustered) {
    const vec = new Float32Array(face.embedding.buffer, face.embedding.byteOffset, face.embedding.byteLength / 4);
    let bestId: number | null = null;
    let bestSim = SIMILARITY_THRESHOLD;

    for (const [id, c] of centroids) {
      const sim = cosineSimilarity(vec, c.vec);
      workSinceYield++;
      if (sim > bestSim) {
        bestSim = sim;
        bestId = id;
      }
    }

    if (bestId !== null) {
      updateFaceCluster(face.id, bestId);
      assignedExisting++;
      // Update centroid online so subsequent unclustered faces see the
      // refined mean.
      const c = centroids.get(bestId)!;
      const n = c.count + 1;
      const dim = vec.length;
      for (let d = 0; d < dim; d++) {
        c.vec[d] = c.vec[d] * (c.count / n) + vec[d] / n;
      }
      c.count = n;
    } else {
      const newId = nextClusterId++;
      updateFaceCluster(face.id, newId);
      const copy = new Float32Array(vec.length);
      for (let d = 0; d < vec.length; d++) copy[d] = vec[d];
      centroids.set(newId, { vec: copy, count: 1 });
      newClustersSeeded++;
    }

    if (workSinceYield >= WORK_BUDGET) {
      workSinceYield = 0;
      await yieldNow();
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[AI] Incremental clustering done in ${elapsedSec}s: ${assignedExisting} face(s) assigned to existing clusters, ${newClustersSeeded} new cluster(s) seeded`);
}


/**
 * Full O(N²) re-cluster from scratch. Wipes every existing cluster_id
 * and rebuilds. Used only when the user explicitly chooses Re-cluster
 * in Settings → AI. Delegates to the AI worker_thread so main stays
 * responsive throughout — the work is the same shape as before, just
 * off the main process.
 */
export async function runFaceClustering(customThreshold?: number): Promise<void> {
  console.log('[AI] Running full face clustering...');
  const faces = getAllFaceEmbeddings();
  if (faces.length === 0) return;
  const validFaces = faces.filter(f => f.embedding && f.embedding.length > 0);
  if (validFaces.length === 0) return;

  const dim = validFaces[0].embedding.byteLength / 4;
  const N = validFaces.length;
  const embeddingsFlat = new Float32Array(N * dim);
  const faceIds = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const f = validFaces[i];
    const vec = new Float32Array(f.embedding.buffer, f.embedding.byteOffset, dim);
    for (let d = 0; d < dim; d++) embeddingsFlat[i * dim + d] = vec[d];
    faceIds[i] = f.id;
  }

  console.log(`[AI] Dispatching ${N} faces to AI worker for full re-cluster`);
  const settings = getSettings();
  try {
    await ensureWorker(settings);
  } catch (err) {
    console.error('[AI] Could not start AI worker for clustering:', err);
    return;
  }

  const result = await sendClusteringToWorker({
    type: 'cluster-full',
    embeddings: embeddingsFlat.buffer,
    faceIds: faceIds.buffer,
    dim,
    threshold: customThreshold ?? 0.72,
  });
  if (!result) return;

  const assignments = new Int32Array(result.assignments);
  const returnedFaceIds = new Int32Array(result.faceIds);
  const updates: { faceId: number; clusterId: number }[] = [];
  for (let i = 0; i < assignments.length; i++) {
    updates.push({ faceId: returnedFaceIds[i], clusterId: assignments[i] });
  }
  updateFaceClustersBatch(updates);
  console.log(`[AI] Full clustering applied: ${updates.length} face assignments written`);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
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

function sendProgress(progress: AiProgress): void {
  // Tag every progress payload with the active run's tagsOnly flag so
  // the renderer can show "Tagging X/Y" vs "Analyzing X/Y" without
  // having to track state on its side.
  const payload: AiProgress = { ...progress, tagsOnly: currentRunTagsOnly };
  // Broadcast to EVERY open renderer window — main, People Manager,
  // Date Editor, etc. — so any window subscribed to `ai:progress`
  // sees the same counter updates. Previously only mainWindow got them,
  // which left the People Manager (where faces actually land) with no
  // visibility into analysis progress.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try { win.webContents.send('ai:progress', payload); } catch {}
  }
}
