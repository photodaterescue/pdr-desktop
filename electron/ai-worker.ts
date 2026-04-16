/**
 * AI Worker — Runs in a worker thread for CPU-intensive ML inference.
 *
 * Uses:
 * 1. @vladmandic/human — Face detection, landmark detection, and 128-dim face embeddings
 *    (loaded via the node-wasm build with CPU backend for maximum compatibility)
 * 2. @huggingface/transformers (Transformers.js) — Zero-shot CLIP image classification for object/scene tagging
 *
 * All processing is local — no data leaves the machine.
 */

import { parentPort, workerData } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import Module from 'module';
import sharp from 'sharp';

// ─── Require interceptor ──────────────────────────────────────────────────────
// human.node-wasm.js does a top-level require("@tensorflow/tfjs-backend-wasm")
// which can throw in Electron's worker thread context when WASM binaries can't be
// located. We intercept this to return an empty module instead of crashing.
// The CPU backend is used anyway, so the WASM backend is never actually needed.

const _origRequire = (Module as any).prototype.require;
(Module as any).prototype.require = function interceptedRequire(id: string, ...args: any[]) {
  try {
    return _origRequire.apply(this, [id, ...args]);
  } catch (err) {
    // If @tensorflow/tfjs-backend-wasm fails (e.g. can't find .wasm files), return empty shim
    if (id === '@tensorflow/tfjs-backend-wasm' || id.includes('tfjs-backend-wasm')) {
      console.warn(`[AI Worker] Shimmed failed require("${id}"): ${(err as Error).message}`);
      return {};
    }
    throw err;
  }
};

// ─── Patch fetch for file:// URLs ───────────────────────────────────────────
// Node.js fetch() doesn't support file:// URLs, but @vladmandic/human uses fetch()
// to load model JSON/binary files. This patch intercepts file:// URLs and reads
// them from disk using fs.readFileSync.

const originalFetch = globalThis.fetch;
globalThis.fetch = async function patchedFetch(url: any, options?: any): Promise<Response> {
  const urlStr = typeof url === 'string' ? url : url.toString();
  if (urlStr.startsWith('file://')) {
    const filePath = decodeURIComponent(urlStr.replace('file:///', '').replace('file://', ''));
    try {
      const data = fs.readFileSync(filePath);
      return new Response(data, {
        status: 200,
        headers: { 'content-type': filePath.endsWith('.json') ? 'application/json' : 'application/octet-stream' },
      });
    } catch (err) {
      return new Response(null, { status: 404, statusText: (err as Error).message });
    }
  }
  return originalFetch(url, options);
} as typeof fetch;

// ─── Types ───────────────────────────────────────────────────────────────────

interface WorkerConfig {
  modelsDir: string;
  minFaceConfidence: number;
  minTagConfidence: number;
  enableFaces: boolean;
  enableTags: boolean;
  humanModelsPath: string; // Path to @vladmandic/human models directory
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

let humanInstance: any = null;
let classifier: any = null;
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
    // Load face detection model using @vladmandic/human
    if (config.enableFaces) {
     try {
      log('Loading face recognition model (@vladmandic/human)...');
      sendModelProgress('face-detection', 0);

      // Step 1: Register CPU backend for TensorFlow.js
      log('Step 1: Loading @tensorflow/tfjs-core...');
      let tf: any;
      try {
        tf = require('@tensorflow/tfjs-core');
        log(`  tfjs-core loaded OK (version: ${tf.version_core || 'unknown'})`);
      } catch (e) {
        log(`  FAILED to load tfjs-core: ${(e as Error).message}`);
        throw e;
      }

      log('Step 2: Loading @tensorflow/tfjs-backend-cpu...');
      try {
        require('@tensorflow/tfjs-backend-cpu');
        log(`  tfjs-backend-cpu loaded OK`);
      } catch (e) {
        log(`  FAILED to load tfjs-backend-cpu: ${(e as Error).message}`);
        throw e;
      }

      log('Step 3: Setting TF.js backend to cpu...');
      try {
        await tf.setBackend('cpu');
        await tf.ready();
        log(`  TF.js backend set to: ${tf.getBackend()}`);
        log(`  Available backends: ${Object.keys(tf.engine().registryFactory).join(', ')}`);
      } catch (e) {
        log(`  FAILED to set CPU backend: ${(e as Error).message}`);
        throw e;
      }

      // Step 4: Load Human library
      // human.node-wasm.js requires @tensorflow/tfjs-backend-wasm at load time.
      // Pre-load the wasm module so it doesn't throw, even though we use CPU backend.
      log('Step 4: Pre-loading @tensorflow/tfjs-backend-wasm...');
      try {
        require('@tensorflow/tfjs-backend-wasm');
        log('  tfjs-backend-wasm loaded OK');
      } catch (e) {
        log(`  WARNING: tfjs-backend-wasm failed to load: ${(e as Error).message}`);
        log('  This may prevent Human from loading — will try anyway');
      }

      log('Step 5: Loading @tensorflow/tfjs-converter...');
      try {
        require('@tensorflow/tfjs-converter');
        log('  tfjs-converter loaded OK');
      } catch (e) {
        log(`  WARNING: tfjs-converter failed to load: ${(e as Error).message}`);
      }

      log('Step 6: Resolving Human library path...');
      const humanDistDir = path.resolve(config.humanModelsPath, '..', 'dist');
      let humanWasmBuildPath: string;
      if (fs.existsSync(path.join(humanDistDir, 'human.node-wasm.js'))) {
        humanWasmBuildPath = path.join(humanDistDir, 'human.node-wasm.js');
      } else {
        // Fallback: try require.resolve
        const humanMainPath = require.resolve('@vladmandic/human');
        humanWasmBuildPath = humanMainPath.replace('human.node.js', 'human.node-wasm.js');
      }
      log(`  Human path: ${humanWasmBuildPath}`);
      log(`  File exists: ${fs.existsSync(humanWasmBuildPath)}`);

      log('Step 7: Loading Human module...');
      let H: any;
      try {
        H = require(humanWasmBuildPath);
        log(`  Human module loaded OK, keys: ${Object.keys(H).join(', ')}`);
      } catch (e) {
        log(`  FAILED to load Human: ${(e as Error).message}`);
        log(`  Stack: ${(e as Error).stack?.split('\n').slice(0, 5).join(' | ')}`);
        throw e;
      }
      const Human = H.default || H.Human || H;
      log(`  Human constructor type: ${typeof Human}, version: ${Human?.version || 'unknown'}`);

      // Convert models path to file:// URL for fetch-based loading
      const modelsUrl = 'file:///' + config.humanModelsPath.replace(/\\/g, '/') + '/';
      log(`Step 8: Loading face models from: ${modelsUrl}`);

      // Verify model files exist
      for (const modelFile of ['blazeface.json', 'blazeface.bin', 'faceres.json', 'faceres.bin']) {
        const modelFilePath = path.join(config.humanModelsPath, modelFile);
        const exists = fs.existsSync(modelFilePath);
        log(`  ${modelFile}: ${exists ? 'EXISTS' : 'MISSING!'}`);
      }

      const humanConfig: any = {
        modelBasePath: modelsUrl,
        backend: 'cpu',
        debug: false,
        async: true,
        // Only enable face pipeline — disable everything else for performance
        face: {
          enabled: true,
          detector: {
            enabled: true,
            modelPath: 'blazeface.json',
            rotation: false,
            maxDetected: 50,
            minConfidence: config.minFaceConfidence,
            iouThreshold: 0.3,
          },
          mesh: {
            enabled: false, // Not needed for embeddings — saves processing time
          },
          description: {
            enabled: true,
            modelPath: 'faceres.json',
            // This gives us 128-dim face embeddings (descriptor)
          },
          iris: { enabled: false },
          emotion: { enabled: false },
          antispoof: { enabled: false },
          liveness: { enabled: false },
        },
        body: { enabled: false },
        hand: { enabled: false },
        object: { enabled: false },
        gesture: { enabled: false },
        segmentation: { enabled: false },
      };

      humanInstance = new Human(humanConfig);
      log('Step 9: Loading Human models (this may take a moment)...');
      await humanInstance.load();
      log('Face recognition model loaded successfully (@vladmandic/human)');
      sendModelProgress('face-detection', 100);
     } catch (faceErr) {
      log(`Face model init FAILED: ${(faceErr as Error).message}`);
      log(`Stack trace: ${(faceErr as Error).stack?.split('\n').slice(0, 5).join(' | ')}`);
      log(`Face detection will be disabled for this session`);
      humanInstance = null;
     }
    } else {
      log('Face detection is DISABLED in settings (config.enableFaces = false)');
    }

    // Load zero-shot classification model for tagging
    if (config.enableTags) {
      log('Loading image classification model...');
      sendModelProgress('image-classification', 0);

      // Dynamic import of @huggingface/transformers
      transformersModule = await import('@huggingface/transformers');
      const { env, pipeline } = transformersModule;

      // Configure cache directory
      env.cacheDir = config.modelsDir;
      env.allowRemoteModels = true;
      env.backends.onnx.wasm.numThreads = 1;

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

    parentPort?.postMessage({
      type: 'ready',
      facesAvailable: humanInstance !== null,
      tagsAvailable: classifier !== null,
    });
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

    const faces: Array<{ box_x: number; box_y: number; box_w: number; box_h: number; embedding: number[]; confidence: number }> = [];
    const tags: Array<{ tag: string; confidence: number }> = [];

    // Face detection using @vladmandic/human
    if (config.enableFaces && humanInstance) {
      try {
        // Resize image to manageable size and get both JPEG buffer and dimensions
        const resized = sharp(filePath, { failOnError: false })
          .resize(640, 640, { fit: 'inside', withoutEnlargement: true });
        const metadata = await resized.toBuffer({ resolveWithObject: true });
        const imgWidth = metadata.info.width;
        const imgHeight = metadata.info.height;

        // Convert to raw tensor for Human: [height, width, 3] RGB
        const { data: rawData } = await sharp(filePath, { failOnError: false })
          .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });

        // Create a proper TF.js tensor — Human works best with tensors
        const tf = require('@tensorflow/tfjs-core');
        const inputTensor = tf.tensor3d(
          new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength),
          [imgHeight, imgWidth, 3],
          'int32'
        );

        // Run face detection with a 120-second timeout (CPU backend is slow on first call)
        const detectPromise = humanInstance.detect(inputTensor);
        const timeoutPromise = new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('Face detection timed out after 120s')), 120000)
        );
        let result: any;
        try {
          result = await Promise.race([detectPromise, timeoutPromise]);
        } finally {
          // Always dispose the tensor to prevent memory leaks
          inputTensor.dispose();
        }

        // Log detect() result for every file
        const faceCount = result?.face?.length ?? 0;
        const faceScores = result?.face?.map((f: any) => f.score?.toFixed(3)) ?? [];
        log(`File ${fileId}: ${faceCount} face(s) detected${faceCount > 0 ? ` scores=[${faceScores.join(', ')}]` : ''}`);

        if (result && result.face) {
          for (const face of result.face) {
            if (face.score >= config.minFaceConfidence) {
              // face.box is [x, y, width, height] in pixels
              const [fx, fy, fw, fh] = face.box;
              // Normalise to 0-1 range relative to the resized image dimensions
              const normX = fx / imgWidth;
              const normY = fy / imgHeight;
              const normW = fw / imgWidth;
              const normH = fh / imgHeight;

              // face.embedding is a 128-dim Float32Array (face descriptor)
              const embedding = face.embedding
                ? Array.from(face.embedding as Float32Array)
                : [];

              faces.push({
                box_x: Math.max(0, normX),
                box_y: Math.max(0, normY),
                box_w: Math.min(1 - normX, normW),
                box_h: Math.min(1 - normY, normH),
                embedding,
                confidence: face.score,
              });
            }
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
