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
export async function startAiProcessing(): Promise<void> {
  if (isProcessing) {
    console.log('[AI] Already processing, ignoring start request');
    return;
  }

  const settings = getSettings();
  if (!settings.aiEnabled) {
    console.log('[AI] AI is disabled in settings');
    return;
  }

  const enableFaces = settings.aiFaceDetection;
  const enableTags = settings.aiObjectTagging;
  console.log(`[AI] Settings — enableFaces: ${enableFaces}, enableTags: ${enableTags}, aiEnabled: ${settings.aiEnabled}`);
  if (!enableFaces && !enableTags) {
    console.log('[AI] Both face detection and object tagging are disabled');
    return;
  }

  isProcessing = true;
  shouldCancel = false;
  totalFacesFound = 0;
  totalTagsApplied = 0;

  // Prevent the system from sleeping while AI processing is running
  if (powerSaveBlockerId === null) {
    powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    console.log('[AI] Power save blocker started — system will stay awake during processing');
  }

  try {
    // Migrate old DETR face data to new model if needed
    if (enableFaces) {
      clearFaceDataForModelUpgrade();
    }

    // Get unprocessed file IDs
    const task = enableFaces ? 'faces' : 'tags';
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
          // Wipe any pre-existing UNVERIFIED face rows for this file
          // before inserting fresh detections — stops re-processing
          // from stacking duplicate rows. User-verified assignments
          // (verified=1) are kept.
          clearUnverifiedFacesForFile(file.id);
          // Store face detections
          if (result.faces && result.faces.length > 0) {
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

          // Mark as processed — only for features that are actually working
          if (enableFaces && workerFacesAvailable) markAiProcessed(file.id, 'faces', 'human-v1');
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

    // Run face clustering after all faces are processed
    if (enableFaces && totalFacesFound > 0 && !shouldCancel) {
      sendProgress({
        phase: 'clustering',
        current: 0,
        total: 0,
        currentFile: 'Clustering faces...',
        facesFound: totalFacesFound,
        tagsApplied: totalTagsApplied,
      });
      runFaceClustering();
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

// ─── Worker management ──────────────────────────────────────────────────────

async function ensureWorker(settings: ReturnType<typeof getSettings>): Promise<void> {
  if (worker) return;

  const modelsDir = path.join(app.getPath('userData'), 'ai-models');

  return new Promise((resolve, reject) => {
    const workerPath = app.isPackaged
      ? path.join(process.resourcesPath, 'dist-electron/ai-worker.cjs')
      : path.join(__dirname, 'ai-worker.cjs');

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

// ─── Face clustering (DBSCAN-like) ─────────────────────────────────────────

export function runFaceClustering(customThreshold?: number): void {
  console.log('[AI] Running face clustering...');
  const faces = getAllFaceEmbeddings();
  if (faces.length === 0) return;

  // Convert BLOB embeddings to float32 arrays
  const embeddings: { id: number; vec: Float32Array }[] = faces
    .filter(f => f.embedding && f.embedding.length > 0)
    .map(f => ({
      id: f.id,
      vec: new Float32Array(f.embedding.buffer, f.embedding.byteOffset, f.embedding.byteLength / 4),
    }));

  if (embeddings.length === 0) return;

  // Centroid-linkage clustering with seed anchor: each new face must be similar
  // to both the cluster centroid AND the seed face. This prevents centroid drift
  // from gradually pulling in unrelated people.
  const SIMILARITY_THRESHOLD = customThreshold ?? 0.72;
  const SEED_THRESHOLD = Math.max(0.55, SIMILARITY_THRESHOLD - 0.07); // slightly below centroid threshold
  const visited = new Set<number>();
  let nextClusterId = 1;

  for (let i = 0; i < embeddings.length; i++) {
    if (visited.has(i)) continue;
    visited.add(i);

    const cluster = [i];
    const seed = embeddings[i].vec; // anchor — never changes
    const dim = seed.length;
    const centroid = new Float32Array(dim);
    for (let d = 0; d < dim; d++) centroid[d] = seed[d];

    // Iteratively add faces that match both centroid and seed
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < embeddings.length; j++) {
        if (visited.has(j)) continue;
        const simCentroid = cosineSimilarity(centroid, embeddings[j].vec);
        const simSeed = cosineSimilarity(seed, embeddings[j].vec);
        if (simCentroid >= SIMILARITY_THRESHOLD && simSeed >= SEED_THRESHOLD) {
          visited.add(j);
          cluster.push(j);
          // Update centroid incrementally
          const n = cluster.length;
          for (let d = 0; d < dim; d++) {
            centroid[d] = centroid[d] * ((n - 1) / n) + embeddings[j].vec[d] / n;
          }
          changed = true;
        }
      }
    }

    // Assign cluster ID to all faces in this cluster
    const clusterId = nextClusterId++;
    for (const idx of cluster) {
      updateFaceCluster(embeddings[idx].id, clusterId);
    }
  }

  console.log(`[AI] Clustering complete: ${nextClusterId - 1} clusters from ${embeddings.length} faces`);
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
  // Broadcast to EVERY open renderer window — main, People Manager,
  // Date Editor, etc. — so any window subscribed to `ai:progress`
  // sees the same counter updates. Previously only mainWindow got them,
  // which left the People Manager (where faces actually land) with no
  // visibility into analysis progress.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try { win.webContents.send('ai:progress', progress); } catch {}
  }
}
