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
import * as path from 'path';
import { app, BrowserWindow } from 'electron';
import {
  getUnprocessedFileIds,
  getFileById,
  markAiProcessed,
  insertFaceDetections,
  insertAiTags,
  rebuildAiFts,
  getAllFaceEmbeddings,
  updateFaceCluster,
  getAiStats,
  clearAllAiData,
  type FaceDetectionRecord,
  type AiTagRecord,
} from './search-database.js';
import { getSettings } from './settings-store.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AiProgress {
  phase: 'downloading-models' | 'processing' | 'clustering' | 'complete' | 'error';
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
let mainWindow: BrowserWindow | null = null;
let totalFacesFound = 0;
let totalTagsApplied = 0;

// ─── Public API ──────────────────────────────────────────────────────────────

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;
}

export function isAiProcessing(): boolean {
  return isProcessing;
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
  if (!enableFaces && !enableTags) {
    console.log('[AI] Both face detection and object tagging are disabled');
    return;
  }

  isProcessing = true;
  shouldCancel = false;
  totalFacesFound = 0;
  totalTagsApplied = 0;

  try {
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
        if (result) {
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

          // Mark as processed
          if (enableFaces) markAiProcessed(file.id, 'faces', 'transformers-v1');
          if (enableTags) markAiProcessed(file.id, 'tags', 'transformers-v1');

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
  }
}

export function cancelAiProcessing(): void {
  shouldCancel = true;
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
      ? path.join(process.resourcesPath, 'dist-electron/ai-worker.js')
      : path.join(__dirname, 'ai-worker.js');

    worker = new Worker(workerPath, {
      workerData: {
        modelsDir,
        minFaceConfidence: settings.aiMinFaceConfidence,
        minTagConfidence: settings.aiMinTagConfidence,
        enableFaces: settings.aiFaceDetection,
        enableTags: settings.aiObjectTagging,
      },
    });

    const onReady = (msg: WorkerMessage) => {
      if (msg.type === 'ready') {
        console.log('[AI] Worker ready');
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
        console.log(`[AI Worker] ${msg.message}`);
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

function runFaceClustering(): void {
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

  // Simple clustering: cosine similarity threshold
  const SIMILARITY_THRESHOLD = 0.55;
  const visited = new Set<number>();
  let nextClusterId = 1;

  for (let i = 0; i < embeddings.length; i++) {
    if (visited.has(i)) continue;
    visited.add(i);

    const cluster = [i];
    const queue = [i];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (let j = 0; j < embeddings.length; j++) {
        if (visited.has(j)) continue;
        const sim = cosineSimilarity(embeddings[current].vec, embeddings[j].vec);
        if (sim >= SIMILARITY_THRESHOLD) {
          visited.add(j);
          cluster.push(j);
          queue.push(j);
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ai:progress', progress);
  }
}
