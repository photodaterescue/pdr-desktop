"use strict";
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
const worker_threads_1 = require("worker_threads");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const module_1 = __importDefault(require("module"));
const sharp_1 = __importDefault(require("sharp"));
// ─── Require interceptor ──────────────────────────────────────────────────────
// human.node-wasm.js does a top-level require("@tensorflow/tfjs-backend-wasm")
// which can throw in Electron's worker thread context when WASM binaries can't be
// located. We intercept this to return an empty module instead of crashing.
// The CPU backend is used anyway, so the WASM backend is never actually needed.
const _origRequire = module_1.default.prototype.require;
module_1.default.prototype.require = function interceptedRequire(id, ...args) {
    try {
        return _origRequire.apply(this, [id, ...args]);
    }
    catch (err) {
        // If @tensorflow/tfjs-backend-wasm fails (e.g. can't find .wasm files), return empty shim
        if (id === '@tensorflow/tfjs-backend-wasm' || id.includes('tfjs-backend-wasm')) {
            console.warn(`[AI Worker] Shimmed failed require("${id}"): ${err.message}`);
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
globalThis.fetch = async function patchedFetch(url, options) {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.startsWith('file://')) {
        const filePath = decodeURIComponent(urlStr.replace('file:///', '').replace('file://', ''));
        try {
            const data = fs.readFileSync(filePath);
            return new Response(data, {
                status: 200,
                headers: { 'content-type': filePath.endsWith('.json') ? 'application/json' : 'application/octet-stream' },
            });
        }
        catch (err) {
            return new Response(null, { status: 404, statusText: err.message });
        }
    }
    return originalFetch(url, options);
};
// ─── Default tag labels for zero-shot classification ─────────────────────────
const DEFAULT_TAGS = [
    // Scenes & settings
    'beach', 'mountain', 'forest', 'lake', 'ocean', 'river', 'waterfall',
    'city', 'street', 'park', 'garden', 'field', 'desert', 'meadow',
    'countryside', 'farm', 'vineyard', 'cliff', 'cave', 'island', 'harbor',
    'sunset', 'sunrise', 'night sky', 'snow', 'rain', 'fog', 'storm', 'rainbow',
    // Events — life milestones
    'wedding', 'bride', 'groom', 'bouquet', 'wedding dress', 'tuxedo',
    'ceremony', 'reception', 'gown', 'altar', 'chapel', 'married', 'newlywed',
    'engagement', 'proposal', 'honeymoon',
    'birthday party', 'birthday cake', 'candles',
    'christmas', 'christmas tree', 'ornaments',
    'halloween', 'pumpkin', 'costume',
    'thanksgiving', 'easter',
    'new year', 'fireworks',
    'graduation', 'diploma',
    'baby shower', 'christening', 'baptism',
    'funeral',
    'anniversary',
    // Events — gatherings
    'concert', 'festival', 'sports event', 'parade', 'carnival', 'fair',
    'conference', 'meeting', 'lecture',
    'party', 'gathering', 'reunion', 'family photo', 'group photo',
    // Couple / affection cues
    'couple', 'kiss', 'hug', 'embrace', 'holding hands', 'romantic', 'dating',
    // Activities
    'swimming', 'hiking', 'cycling', 'running', 'dancing', 'skiing',
    'snowboarding', 'surfing', 'sailing', 'fishing', 'camping', 'climbing',
    'cooking', 'eating', 'playing', 'reading', 'writing', 'painting',
    'shopping', 'travel', 'driving',
    // People & groups
    'portrait', 'selfie', 'baby', 'toddler', 'child', 'children',
    'teenager', 'adult', 'elderly', 'family',
    'pregnancy', 'newborn',
    // Animals
    'dog', 'cat', 'bird', 'horse', 'fish', 'rabbit', 'cow', 'sheep', 'pet',
    // Vehicles
    'car', 'boat', 'airplane', 'train', 'bicycle', 'motorcycle', 'bus', 'truck',
    // Places & buildings
    'building', 'church', 'bridge', 'monument', 'castle', 'skyscraper', 'tower',
    'house', 'kitchen', 'living room', 'bedroom', 'bathroom', 'garage', 'backyard',
    'restaurant', 'cafe', 'bar', 'pub', 'hotel', 'office', 'classroom', 'stage',
    'hospital', 'museum', 'library', 'store', 'market', 'stadium', 'airport',
    'gym', 'pool', 'playground',
    // Nature & things
    'flower', 'flowers', 'tree', 'trees', 'grass', 'leaves',
    'food', 'drink', 'cake', 'pizza', 'coffee', 'wine', 'beer', 'cocktail',
    'dinner', 'lunch', 'breakfast', 'picnic', 'barbecue',
    'book', 'phone', 'camera', 'laptop', 'gift', 'balloons',
];
// ─── Pipeline holders ────────────────────────────────────────────────────────
let humanInstance = null;
let classifier = null;
let config;
let transformersModule = null;
// ─── Initialisation ──────────────────────────────────────────────────────────
async function init() {
    config = worker_threads_1.workerData;
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
                let tf;
                try {
                    tf = require('@tensorflow/tfjs-core');
                    log(`  tfjs-core loaded OK (version: ${tf.version_core || 'unknown'})`);
                }
                catch (e) {
                    log(`  FAILED to load tfjs-core: ${e.message}`);
                    throw e;
                }
                log('Step 2: Loading @tensorflow/tfjs-backend-cpu...');
                try {
                    require('@tensorflow/tfjs-backend-cpu');
                    log(`  tfjs-backend-cpu loaded OK`);
                }
                catch (e) {
                    log(`  FAILED to load tfjs-backend-cpu: ${e.message}`);
                    throw e;
                }
                log('Step 3: Setting TF.js backend to cpu...');
                try {
                    await tf.setBackend('cpu');
                    await tf.ready();
                    log(`  TF.js backend set to: ${tf.getBackend()}`);
                    log(`  Available backends: ${Object.keys(tf.engine().registryFactory).join(', ')}`);
                }
                catch (e) {
                    log(`  FAILED to set CPU backend: ${e.message}`);
                    throw e;
                }
                // Step 4: Load Human library
                // human.node-wasm.js requires @tensorflow/tfjs-backend-wasm at load time.
                // Pre-load the wasm module so it doesn't throw, even though we use CPU backend.
                log('Step 4: Pre-loading @tensorflow/tfjs-backend-wasm...');
                try {
                    require('@tensorflow/tfjs-backend-wasm');
                    log('  tfjs-backend-wasm loaded OK');
                }
                catch (e) {
                    log(`  WARNING: tfjs-backend-wasm failed to load: ${e.message}`);
                    log('  This may prevent Human from loading — will try anyway');
                }
                log('Step 5: Loading @tensorflow/tfjs-converter...');
                try {
                    require('@tensorflow/tfjs-converter');
                    log('  tfjs-converter loaded OK');
                }
                catch (e) {
                    log(`  WARNING: tfjs-converter failed to load: ${e.message}`);
                }
                log('Step 6: Resolving Human library path...');
                const humanDistDir = path.resolve(config.humanModelsPath, '..', 'dist');
                let humanWasmBuildPath;
                if (fs.existsSync(path.join(humanDistDir, 'human.node-wasm.js'))) {
                    humanWasmBuildPath = path.join(humanDistDir, 'human.node-wasm.js');
                }
                else {
                    // Fallback: try require.resolve
                    const humanMainPath = require.resolve('@vladmandic/human');
                    humanWasmBuildPath = humanMainPath.replace('human.node.js', 'human.node-wasm.js');
                }
                log(`  Human path: ${humanWasmBuildPath}`);
                log(`  File exists: ${fs.existsSync(humanWasmBuildPath)}`);
                log('Step 7: Loading Human module...');
                let H;
                try {
                    H = require(humanWasmBuildPath);
                    log(`  Human module loaded OK, keys: ${Object.keys(H).join(', ')}`);
                }
                catch (e) {
                    log(`  FAILED to load Human: ${e.message}`);
                    log(`  Stack: ${e.stack?.split('\n').slice(0, 5).join(' | ')}`);
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
                const humanConfig = {
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
                            // square=true: pad the input image to a square BEFORE the
                            // detector resizes it to 256×256, instead of letting Human
                            // distort the aspect ratio. Without this, a portrait phone
                            // photo gets squashed into a wide square and the detector
                            // sees stretched faces — which both hurts detection
                            // accuracy AND skews where the box lands when the result
                            // is mapped back. See blazeface.ts:60-69.
                            square: true,
                            // scale=1.0: keep the detector's reported face box tight
                            // to the actual face. Default is 1.4, which is designed
                            // for the face-mesh network (it needs padding for
                            // landmarks). We have mesh disabled, so the 40% padding
                            // just produces enormous purple boxes that cover the
                            // user's chest. See blazeface.ts:117 + facemeshutil.ts:59.
                            scale: 1.0,
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
            }
            catch (faceErr) {
                log(`Face model init FAILED: ${faceErr.message}`);
                log(`Stack trace: ${faceErr.stack?.split('\n').slice(0, 5).join(' | ')}`);
                log(`Face detection will be disabled for this session`);
                humanInstance = null;
            }
        }
        else {
            log('Face detection is DISABLED in settings (config.enableFaces = false)');
        }
        // Load zero-shot classification model for tagging
        if (config.enableTags) {
            log('Loading image classification model...');
            sendModelProgress('image-classification', 0);
            // Dynamic import of @huggingface/transformers
            transformersModule = await Promise.resolve().then(() => __importStar(require('@huggingface/transformers')));
            const { env, pipeline } = transformersModule;
            // Configure cache directory
            env.cacheDir = config.modelsDir;
            env.allowRemoteModels = true;
            env.backends.onnx.wasm.numThreads = 1;
            classifier = await pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32', {
                quantized: true,
                progress_callback: (progress) => {
                    if (progress.status === 'progress') {
                        sendModelProgress('image-classification', Math.round((progress.loaded / progress.total) * 100));
                    }
                },
            });
            log('Image classification model loaded');
        }
        worker_threads_1.parentPort?.postMessage({
            type: 'ready',
            facesAvailable: humanInstance !== null,
            tagsAvailable: classifier !== null,
        });
    }
    catch (err) {
        log(`Initialisation error: ${err.message}`);
        worker_threads_1.parentPort?.postMessage({ type: 'error', error: err.message });
    }
}
// ─── File processing ─────────────────────────────────────────────────────────
async function processFile(fileId, filePath) {
    try {
        // Check file exists
        if (!fs.existsSync(filePath)) {
            worker_threads_1.parentPort?.postMessage({ type: 'error', fileId, error: 'File not found' });
            return;
        }
        const faces = [];
        const tags = [];
        // Face detection using @vladmandic/human
        if (config.enableFaces && humanInstance) {
            try {
                // Resize image to manageable size and get both JPEG buffer and dimensions.
                //
                // CRITICAL: `.rotate()` (no args) applies EXIF auto-rotation. Without
                // this, sharp processes pixels in storage order — so a portrait photo
                // shot on a phone (stored as landscape with an "Orientation: 6" flag)
                // gets analysed as landscape, while the browser auto-rotates the
                // <img> back to portrait. Box coords stored in storage-orientation
                // space then render in the wrong place on the rotated display, and
                // worse, face embeddings are computed from sideways faces — Human.js
                // expects upright faces, so the descriptors are garbage and clusters
                // bundle people together that don't actually look alike.
                const resized = (0, sharp_1.default)(filePath, { failOnError: false })
                    .rotate()
                    .resize(640, 640, { fit: 'inside', withoutEnlargement: true });
                const metadata = await resized.toBuffer({ resolveWithObject: true });
                const imgWidth = metadata.info.width;
                const imgHeight = metadata.info.height;
                // Convert to raw tensor for Human: [height, width, 3] RGB
                const { data: rawData } = await (0, sharp_1.default)(filePath, { failOnError: false })
                    .rotate()
                    .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
                    .removeAlpha()
                    .raw()
                    .toBuffer({ resolveWithObject: true });
                // Create a proper TF.js tensor — Human works best with tensors
                const tf = require('@tensorflow/tfjs-core');
                const inputTensor = tf.tensor3d(new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength), [imgHeight, imgWidth, 3], 'int32');
                // Run face detection with a 120-second timeout (CPU backend is slow on first call)
                const detectPromise = humanInstance.detect(inputTensor);
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Face detection timed out after 120s')), 120000));
                let result;
                try {
                    result = await Promise.race([detectPromise, timeoutPromise]);
                }
                finally {
                    // Always dispose the tensor to prevent memory leaks
                    inputTensor.dispose();
                }
                // Log detect() result for every file
                const faceCount = result?.face?.length ?? 0;
                const faceScores = result?.face?.map((f) => f.score?.toFixed(3)) ?? [];
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
                                ? Array.from(face.embedding)
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
            }
            catch (err) {
                log(`Face detection error for ${fileId}: ${err.message}`);
            }
        }
        // Object/scene tagging via CLIP zero-shot classification
        if (config.enableTags && classifier) {
            try {
                const { RawImage } = transformersModule;
                const smallBuffer = await (0, sharp_1.default)(filePath, { failOnError: false })
                    .resize(224, 224, { fit: 'cover' })
                    .jpeg({ quality: 80 })
                    .toBuffer();
                const image = await RawImage.fromBlob(new Blob([smallBuffer]));
                const results = await classifier(image, DEFAULT_TAGS, {
                    hypothesis_template: 'a photo of {}',
                });
                // Filter by confidence threshold, take top 10. Richer scenes
                // like weddings legitimately have many relevant tags (bride,
                // groom, bouquet, ceremony, gown, flowers…) — the old top-5
                // cap was dropping signal on exactly those high-value photos.
                const topTags = results
                    .filter((r) => r.score >= config.minTagConfidence)
                    .slice(0, 10);
                for (const result of topTags) {
                    tags.push({ tag: result.label, confidence: result.score });
                }
            }
            catch (err) {
                log(`Classification error for ${fileId}: ${err.message}`);
            }
        }
        worker_threads_1.parentPort?.postMessage({ type: 'result', fileId, faces, tags });
    }
    catch (err) {
        worker_threads_1.parentPort?.postMessage({ type: 'error', fileId, error: err.message });
    }
}
// ─── Message handling ────────────────────────────────────────────────────────
worker_threads_1.parentPort?.on('message', async (msg) => {
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
function log(message) {
    worker_threads_1.parentPort?.postMessage({ type: 'log', message });
}
function sendModelProgress(model, percent) {
    worker_threads_1.parentPort?.postMessage({ type: 'model-progress', model, percent });
}
// Start initialisation
init().catch(err => {
    worker_threads_1.parentPort?.postMessage({ type: 'error', error: `Init failed: ${err.message}` });
});
