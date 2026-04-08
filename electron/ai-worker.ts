/**
 * AI Worker — Runs in a worker thread for CPU-intensive ML inference.
 *
 * Uses @huggingface/transformers (Transformers.js) with ONNX Runtime.
 * All processing is local — no data leaves the machine.
 *
 * Tasks:
 * 1. Face detection — detect faces in photos, extract bounding boxes
 * 2. Object/scene tagging — classify photo content using zero-shot CLIP
 */

import { parentPort, workerData } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

// ─── Types ───────────────────────────────────────────────────────────────────

interface WorkerConfig {
  modelsDir: string;
  minFaceConfidence: number;
  minTagConfidence: number;
  enableFaces: boolean;
  enableTags: boolean;
}

interface ProcessFileCommand {
  type: 'process-file';
  fileId: number;
  filePath: string;
}

// ─── Default tag labels for zero-shot classification ─────────────────────────

const DEFAULT_TAGS = [
  // Scenes & settings
  'beach', 'mountain', 'forest', 'lake', 'ocean', 'river', 'waterfall',
  'city', 'street', 'park', 'garden', 'field', 'desert',
  'sunset', 'sunrise', 'night sky', 'snow', 'rain',
  // Events
  'wedding', 'birthday party', 'christmas', 'graduation', 'concert',
  'holiday', 'festival', 'sports event',
  // Activities
  'swimming', 'hiking', 'cycling', 'running', 'dancing',
  'cooking', 'eating', 'playing',
  // People & groups
  'portrait', 'selfie', 'group photo', 'family photo', 'baby', 'children',
  // Animals
  'dog', 'cat', 'bird', 'horse', 'fish',
  // Objects & places
  'car', 'boat', 'airplane', 'train', 'bicycle',
  'building', 'church', 'bridge', 'monument', 'castle',
  'house', 'kitchen', 'living room', 'bedroom', 'restaurant',
  // Nature & things
  'flower', 'tree', 'food', 'drink', 'book',
];

// ─── Pipeline holders ────────────────────────────────────────────────────────

let objectDetector: any = null;
let classifier: any = null;
let featureExtractor: any = null;
let config: WorkerConfig;
let transformersModule: any = null;

// ─── Initialisation ──────────────────────────────────────────────────────────

async function init(): Promise<void> {
  config = workerData as WorkerConfig;

  // Ensure models directory exists
  if (!fs.existsSync(config.modelsDir)) {
    fs.mkdirSync(config.modelsDir, { recursive: true });
  }

  log(`Initialising AI worker (faces: ${config.enableFaces}, tags: ${config.enableTags})`);
  log(`Models directory: ${config.modelsDir}`);

  try {
    // Dynamic import of @huggingface/transformers
    transformersModule = await import('@huggingface/transformers');
    const { env, pipeline } = transformersModule;

    // Configure cache directory
    env.cacheDir = config.modelsDir;
    // Disable remote model fetching warning
    env.allowRemoteModels = true;
    // Use WASM backend (works everywhere)
    env.backends.onnx.wasm.numThreads = 1;

    // Load face detection model
    if (config.enableFaces) {
      log('Loading face detection model...');
      sendModelProgress('face-detection', 0);
      objectDetector = await pipeline('object-detection', 'Xenova/detr-resnet-50', {
        quantized: true,
        progress_callback: (progress: any) => {
          if (progress.status === 'progress') {
            sendModelProgress('face-detection', Math.round((progress.loaded / progress.total) * 100));
          }
        },
      });
      log('Face detection model loaded');
    }

    // Load zero-shot classification model for tagging
    if (config.enableTags) {
      log('Loading image classification model...');
      sendModelProgress('image-classification', 0);
      classifier = await pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32', {
        quantized: true,
        progress_callback: (progress: any) => {
          if (progress.status === 'progress') {
            sendModelProgress('image-classification', Math.round((progress.loaded / progress.total) * 100));
          }
        },
      });
      log('Image classification model loaded');
    }

    parentPort?.postMessage({ type: 'ready' });
  } catch (err) {
    log(`Initialisation error: ${(err as Error).message}`);
    parentPort?.postMessage({ type: 'error', error: (err as Error).message });
  }
}

// ─── File processing ─────────────────────────────────────────────────────────

async function processFile(fileId: number, filePath: string): Promise<void> {
  try {
    // Check file exists
    if (!fs.existsSync(filePath)) {
      parentPort?.postMessage({ type: 'error', fileId, error: 'File not found' });
      return;
    }

    // Read and resize image for model input (224x224 for CLIP, larger for detection)
    const imageBuffer = await sharp(filePath, { failOnError: false })
      .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const faces: Array<{ box_x: number; box_y: number; box_w: number; box_h: number; embedding: number[]; confidence: number }> = [];
    const tags: Array<{ tag: string; confidence: number }> = [];

    // Face detection
    if (config.enableFaces && objectDetector) {
      try {
        const { RawImage } = transformersModule;
        const image = await RawImage.fromBlob(new Blob([imageBuffer]));
        const detections = await objectDetector(image, { threshold: config.minFaceConfidence });

        // Filter for person detections (DETR detects "person", not specifically faces)
        for (const det of detections) {
          if (det.label === 'person' && det.score >= config.minFaceConfidence) {
            const box = det.box;
            // Normalise coordinates to 0-1 range
            faces.push({
              box_x: box.xmin / image.width,
              box_y: box.ymin / image.height,
              box_w: (box.xmax - box.xmin) / image.width,
              box_h: (box.ymax - box.ymin) / image.height,
              embedding: [], // DETR doesn't produce face embeddings — we'll add this with a face-specific model later
              confidence: det.score,
            });
          }
        }
      } catch (err) {
        log(`Face detection error for ${fileId}: ${(err as Error).message}`);
      }
    }

    // Object/scene tagging via CLIP zero-shot classification
    if (config.enableTags && classifier) {
      try {
        const { RawImage } = transformersModule;
        const smallBuffer = await sharp(filePath, { failOnError: false })
          .resize(224, 224, { fit: 'cover' })
          .jpeg({ quality: 80 })
          .toBuffer();

        const image = await RawImage.fromBlob(new Blob([smallBuffer]));
        const results = await classifier(image, DEFAULT_TAGS, {
          hypothesis_template: 'a photo of {}',
        });

        // Filter by confidence threshold, take top 5
        const topTags = results
          .filter((r: any) => r.score >= config.minTagConfidence)
          .slice(0, 5);

        for (const result of topTags) {
          tags.push({ tag: result.label, confidence: result.score });
        }
      } catch (err) {
        log(`Classification error for ${fileId}: ${(err as Error).message}`);
      }
    }

    parentPort?.postMessage({ type: 'result', fileId, faces, tags });
  } catch (err) {
    parentPort?.postMessage({ type: 'error', fileId, error: (err as Error).message });
  }
}

// ─── Message handling ────────────────────────────────────────────────────────

parentPort?.on('message', async (msg: any) => {
  switch (msg.type) {
    case 'process-file':
      await processFile(msg.fileId, msg.filePath);
      break;
    case 'shutdown':
      process.exit(0);
      break;
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(message: string): void {
  parentPort?.postMessage({ type: 'log', message });
}

function sendModelProgress(model: string, percent: number): void {
  parentPort?.postMessage({ type: 'model-progress', model, percent });
}

// Start initialisation
init().catch(err => {
  parentPort?.postMessage({ type: 'error', error: `Init failed: ${(err as Error).message}` });
});
