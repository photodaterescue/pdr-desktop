/**
 * v2.0.15 Phase 5+6 (Terry 2026-06-06) — Photo Enhancement worker.
 *
 * Runs CodeFormer (face restoration) and Real-ESRGAN (whole-image
 * upscale) inference off the main thread, so a single Enhance press
 * doesn't freeze the UI for the 1-3s the inference takes.
 *
 * Pattern matches `ai-worker.ts` (worker_threads.Worker, parentPort,
 * workerData) — NOT utilityProcess. worker_threads fits the AI use
 * case better here: smaller spawn cost, shared memory for the
 * onnxruntime-node native addon, simpler lifecycle than a fork.
 *
 * Models are loaded lazily on first request and stay resident across
 * subsequent Enhance presses. The worker can be killed (and respawned
 * fresh) from main to release the ~400 MB of ONNX session memory —
 * see `enhance-worker-manager.ts`. Free-AI-memory action in Settings
 * planned for v2.0.16 polish.
 *
 * Face detection is NOT performed in this worker — it relies on the
 * existing `face_detections` rows from ai-worker's analysis. The
 * caller (main IPC handler) is responsible for ensuring those exist
 * before sending an `enhance-faces` message. This avoids duplicating
 * @vladmandic/human + TensorFlow loading in two workers.
 *
 * Output is written to a temp JPEG file (path passed in by main).
 * Main reads it back and either streams it to the Viewer for preview
 * or routes it through the existing `viewer:saveEnhanced` flow for
 * the user's chosen save location.
 */

import { parentPort, workerData } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

// ─── Types ───────────────────────────────────────────────────────────────────

interface WorkerConfig {
  /** Absolute path to <userData>/ai-models/codeformer/codeformer.onnx */
  codeformerPath: string;
  /** Absolute path to <userData>/ai-models/realesrgan/RealESRGAN_x4plus.fp16.onnx */
  realesrganPath: string;
}

/** Normalised face box in 0-1 image coords (matches face_detections rows). */
interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface EnhanceFacesMessage {
  type: 'enhance-faces';
  requestId: string;
  sourcePath: string;
  outputPath: string;
  /** Existing face boxes from face_detections — caller's responsibility. */
  faceBoxes: FaceBox[];
  /** CodeFormer fidelity weight, 0-1. 0.5 = balanced; <0.5 leans realistic, >0.5 leans faithful. */
  fidelity: number;
}

interface EnhanceUpscaleMessage {
  type: 'enhance-upscale';
  requestId: string;
  sourcePath: string;
  outputPath: string;
  /** Tile size for chunked inference. Default 256 (model's native tile). */
  tileSize?: number;
}

interface UnloadMessage {
  type: 'unload';
}

type InboundMessage = EnhanceFacesMessage | EnhanceUpscaleMessage | UnloadMessage;

interface ProgressMessage {
  type: 'progress';
  requestId: string;
  phase: string;
  percent: number;
}

interface DoneMessage {
  type: 'done';
  requestId: string;
  outputPath: string;
  facesProcessed?: number;
}

interface ErrorMessage {
  type: 'error';
  requestId: string;
  error: string;
}

type OutboundMessage = ProgressMessage | DoneMessage | ErrorMessage;

// ─── Configuration ───────────────────────────────────────────────────────────

const config: WorkerConfig = workerData as WorkerConfig;

let codeformerSession: ort.InferenceSession | null = null;
let realesrganSession: ort.InferenceSession | null = null;

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[enhance-worker] ${msg}`);
}

function post(msg: OutboundMessage): void {
  try { parentPort?.postMessage(msg); } catch { /* parent dead */ }
}

// ─── Session loaders ─────────────────────────────────────────────────────────

async function getCodeFormerSession(): Promise<ort.InferenceSession> {
  if (codeformerSession) return codeformerSession;
  if (!fs.existsSync(config.codeformerPath)) {
    throw new Error(`CodeFormer model not found at ${config.codeformerPath}. Install via Settings → AI → Photo Enhancement.`);
  }
  log(`Loading CodeFormer session from ${config.codeformerPath}...`);
  const t0 = Date.now();
  codeformerSession = await ort.InferenceSession.create(config.codeformerPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    // v2.1 (Terry 2026-06-07) — cap ONNX worker threads to leave
    // the OS + other apps breathing room. Default behaviour
    // saturates all cores per inference, which crushed Terry's
    // PC during Upscale and killed Chrome. Half-cores keeps PDR
    // responsive without dramatically extending run time.
    intraOpNumThreads: cpuThreadCap(),
    interOpNumThreads: 1,
  });
  log(`CodeFormer loaded in ${Date.now() - t0}ms; inputs=${codeformerSession.inputNames.join(',')} outputs=${codeformerSession.outputNames.join(',')}; threads=${cpuThreadCap()}`);
  return codeformerSession;
}

async function getRealesrganSession(): Promise<ort.InferenceSession> {
  if (realesrganSession) return realesrganSession;
  if (!fs.existsSync(config.realesrganPath)) {
    throw new Error(`Real-ESRGAN model not found at ${config.realesrganPath}. Install via Settings → AI → Photo Enhancement.`);
  }
  log(`Loading Real-ESRGAN session from ${config.realesrganPath}...`);
  const t0 = Date.now();
  realesrganSession = await ort.InferenceSession.create(config.realesrganPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: cpuThreadCap(),
    interOpNumThreads: 1,
  });
  log(`Real-ESRGAN loaded in ${Date.now() - t0}ms; inputs=${realesrganSession.inputNames.join(',')} outputs=${realesrganSession.outputNames.join(',')}; threads=${cpuThreadCap()}`);
  return realesrganSession;
}

// v2.1 — cap thread count to half the available cores (floor),
// minimum 2. On Terry's 8-core box this becomes 4; on a 16-core
// it'd be 8. Trade-off: each inference takes ~1.6x as long but
// the OS keeps half its cores available for Chrome / Explorer /
// PDR's main thread so the desktop doesn't lock up.
function cpuThreadCap(): number {
  const cores = require('os').cpus().length;
  return Math.max(2, Math.floor(cores / 2));
}

// ─── Image helpers (sharp-based) ─────────────────────────────────────────────

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

async function readImageRaw(filePath: string): Promise<RawImage> {
  const { data, info } = await sharp(filePath, { failOnError: false })
    .rotate() // auto-orient via EXIF — same convention as the rest of PDR
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** Convert RGB Buffer [H*W*3] uint8 → Float32Array NCHW [-1, 1]. */
function rgbToNchwTensorNeg1to1(rgb: Buffer, width: number, height: number): Float32Array {
  const channelSize = width * height;
  const out = new Float32Array(3 * channelSize);
  // sharp emits RGB interleaved; CodeFormer expects NCHW.
  for (let i = 0; i < channelSize; i++) {
    out[i] = rgb[i * 3] / 127.5 - 1;                  // R
    out[i + channelSize] = rgb[i * 3 + 1] / 127.5 - 1; // G
    out[i + 2 * channelSize] = rgb[i * 3 + 2] / 127.5 - 1; // B
  }
  return out;
}

/** Convert RGB Buffer [H*W*3] uint8 → Float32Array NCHW [0, 1]. */
function rgbToNchwTensor0to1(rgb: Buffer, width: number, height: number): Float32Array {
  const channelSize = width * height;
  const out = new Float32Array(3 * channelSize);
  for (let i = 0; i < channelSize; i++) {
    out[i] = rgb[i * 3] / 255;
    out[i + channelSize] = rgb[i * 3 + 1] / 255;
    out[i + 2 * channelSize] = rgb[i * 3 + 2] / 255;
  }
  return out;
}

/** Convert Float32Array NCHW [-1, 1] → RGB Buffer [H*W*3] uint8. */
function nchwTensorToRgbNeg1to1(t: Float32Array, width: number, height: number): Buffer {
  const channelSize = width * height;
  const out = Buffer.alloc(channelSize * 3);
  for (let i = 0; i < channelSize; i++) {
    out[i * 3] = clampToByte((t[i] + 1) * 127.5);
    out[i * 3 + 1] = clampToByte((t[i + channelSize] + 1) * 127.5);
    out[i * 3 + 2] = clampToByte((t[i + 2 * channelSize] + 1) * 127.5);
  }
  return out;
}

/** Convert Float32Array NCHW [0, 1] → RGB Buffer [H*W*3] uint8. */
function nchwTensorToRgb0to1(t: Float32Array, width: number, height: number): Buffer {
  const channelSize = width * height;
  const out = Buffer.alloc(channelSize * 3);
  for (let i = 0; i < channelSize; i++) {
    out[i * 3] = clampToByte(t[i] * 255);
    out[i * 3 + 1] = clampToByte(t[i + channelSize] * 255);
    out[i * 3 + 2] = clampToByte(t[i + 2 * channelSize] * 255);
  }
  return out;
}

function clampToByte(v: number): number {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return Math.round(v);
}

// ─── CodeFormer (face restoration) ───────────────────────────────────────────

const CF_SIZE = 512;
/** Padding around each detected face box, as fraction of max(box w, h).
 *  Gives CodeFormer some context — hair, ears, neck — which improves
 *  restoration quality + lets the composite blend mask reach into a
 *  larger area for seamless paste-back. */
const FACE_CROP_PADDING = 0.35;

async function runCodeFormerOnFace(
  faceRgb: Buffer, // 512*512*3 uint8 RGB
  fidelity: number,
): Promise<Buffer> {
  const session = await getCodeFormerSession();
  const inputName = session.inputNames[0]; // typically 'x'
  const fidelityInputName = session.inputNames[1]; // typically 'w' — may not exist on some exports

  const inputTensor = new ort.Tensor(
    'float32',
    rgbToNchwTensorNeg1to1(faceRgb, CF_SIZE, CF_SIZE),
    [1, 3, CF_SIZE, CF_SIZE],
  );

  const feeds: Record<string, ort.Tensor> = { [inputName]: inputTensor };

  // Most CodeFormer ONNX exports take a fidelity weight as a second
  // input. Some don't — fall back gracefully if the model has only one
  // input (single-w build).
  if (fidelityInputName) {
    feeds[fidelityInputName] = new ort.Tensor('float64', new Float64Array([Math.max(0, Math.min(1, fidelity))]), []);
  }

  const result = await session.run(feeds);
  const outputName = session.outputNames[0];
  const out = result[outputName];
  const data = out.data as Float32Array;

  return nchwTensorToRgbNeg1to1(data, CF_SIZE, CF_SIZE);
}

async function enhanceFaces(msg: EnhanceFacesMessage): Promise<void> {
  const t0 = Date.now();
  post({ type: 'progress', requestId: msg.requestId, phase: 'Loading model…', percent: 5 });

  // Pre-warm the session before doing any expensive image work so
  // "Loading model…" sticks on the user's screen during the actual
  // load (rather than flashing past).
  await getCodeFormerSession();

  post({ type: 'progress', requestId: msg.requestId, phase: 'Reading photo…', percent: 15 });
  const src = await readImageRaw(msg.sourcePath);
  log(`source: ${src.width}x${src.height}, ${msg.faceBoxes.length} face(s)`);

  // Start with the source as a sharp pipeline. Each face composites
  // a restored crop on top via sharp's composite() with a feathered
  // alpha mask.
  let resultPipeline = sharp(msg.sourcePath, { failOnError: false }).rotate().removeAlpha().jpeg({ quality: 92, mozjpeg: true });

  // Accumulate composites — collected and applied in one composite()
  // call at the end so sharp does a single re-encode pass.
  const composites: sharp.OverlayOptions[] = [];

  const numFaces = msg.faceBoxes.length;
  for (let i = 0; i < numFaces; i++) {
    const box = msg.faceBoxes[i];

    // Convert normalised coords to pixels.
    const fx = Math.round(box.x * src.width);
    const fy = Math.round(box.y * src.height);
    const fw = Math.round(box.w * src.width);
    const fh = Math.round(box.h * src.height);
    const pad = Math.round(Math.max(fw, fh) * FACE_CROP_PADDING);

    let cropX = fx - pad;
    let cropY = fy - pad;
    let cropW = fw + pad * 2;
    let cropH = fh + pad * 2;

    // Clamp to image bounds.
    if (cropX < 0) { cropW += cropX; cropX = 0; }
    if (cropY < 0) { cropH += cropY; cropY = 0; }
    if (cropX + cropW > src.width) cropW = src.width - cropX;
    if (cropY + cropH > src.height) cropH = src.height - cropY;
    if (cropW < 32 || cropH < 32) {
      log(`Skipping face ${i + 1}: crop too small (${cropW}x${cropH})`);
      continue;
    }

    post({
      type: 'progress',
      requestId: msg.requestId,
      phase: `Restoring face ${i + 1} of ${numFaces}…`,
      percent: 20 + Math.round((i / Math.max(1, numFaces)) * 70),
    });

    // Crop + resize to 512x512 for CodeFormer.
    const faceCrop = await sharp(msg.sourcePath, { failOnError: false })
      .rotate()
      .removeAlpha()
      .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
      .resize(CF_SIZE, CF_SIZE, { fit: 'fill' })
      .raw()
      .toBuffer();

    // Run CodeFormer.
    const restored = await runCodeFormerOnFace(faceCrop, msg.fidelity);

    // Restored 512x512 → resize back to the original crop dimensions.
    const restoredFullSize = await sharp(restored, {
      raw: { width: CF_SIZE, height: CF_SIZE, channels: 3 },
    })
      .resize(cropW, cropH, { fit: 'fill' })
      .png()
      .toBuffer();

    // Feathered alpha mask — a black-edged white ellipse the size of
    // the crop, blurred to soft edges. Composited onto the restored
    // crop so the paste-back fades into the source instead of showing
    // a hard rectangular seam.
    const featherRadius = Math.max(4, Math.round(Math.min(cropW, cropH) * 0.06));
    const maskSvg = `<svg width="${cropW}" height="${cropH}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="black"/>
  <ellipse cx="${cropW / 2}" cy="${cropH / 2}" rx="${cropW / 2 - featherRadius}" ry="${cropH / 2 - featherRadius}" fill="white"/>
</svg>`;
    // v2.1 round 6 (Terry 2026-06-07) — BUG FIX. Was calling
    // .toBuffer() without .raw() so sharp returned PNG-encoded
    // bytes (~85k for this crop), then joinChannel with the raw
    // option below tried to interpret them as 561k raw bytes
    // (width × height × 1 channel) and threw VipsImage: memory
    // area too small. Force greyscale + raw output so the buffer
    // matches the {raw: {channels:1}} declaration.
    const mask = await sharp(Buffer.from(maskSvg))
      .blur(featherRadius)
      .greyscale()
      .raw()
      .toBuffer();

    // Apply mask as alpha to the restored face crop.
    const restoredWithAlpha = await sharp(restoredFullSize)
      .ensureAlpha()
      .joinChannel(mask, { raw: { width: cropW, height: cropH, channels: 1 } } as any)
      .png()
      .toBuffer();

    composites.push({ input: restoredWithAlpha, left: cropX, top: cropY, blend: 'over' });
  }

  post({ type: 'progress', requestId: msg.requestId, phase: 'Compositing…', percent: 92 });

  // Apply all face composites in one pass — sharp re-encodes once.
  if (composites.length > 0) {
    resultPipeline = sharp(msg.sourcePath, { failOnError: false })
      .rotate()
      .removeAlpha()
      .composite(composites)
      .jpeg({ quality: 92, mozjpeg: true });
  }

  await resultPipeline.toFile(msg.outputPath);

  log(`enhanceFaces done in ${Date.now() - t0}ms; ${composites.length} face(s) composited`);
  post({
    type: 'done',
    requestId: msg.requestId,
    outputPath: msg.outputPath,
    facesProcessed: composites.length,
  });
}

// ─── Real-ESRGAN (Phase 6 — whole-image upscale) ─────────────────────────────

async function enhanceUpscale(msg: EnhanceUpscaleMessage): Promise<void> {
  const t0 = Date.now();
  const tileSize = msg.tileSize ?? 256;

  post({ type: 'progress', requestId: msg.requestId, phase: 'Loading model…', percent: 5 });
  const session = await getRealesrganSession();
  const inputName = session.inputNames[0];

  post({ type: 'progress', requestId: msg.requestId, phase: 'Reading photo…', percent: 10 });
  const src = await readImageRaw(msg.sourcePath);
  log(`upscale source: ${src.width}x${src.height}, tile=${tileSize}`);

  // Real-ESRGAN x4 outputs 4x the input resolution.
  const SCALE = 4;
  const outW = src.width * SCALE;
  const outH = src.height * SCALE;

  // Output buffer — interleaved RGB at output resolution.
  const outBuf = Buffer.alloc(outW * outH * 3);

  // Tile the input. 16-pixel overlap between tiles, blended via simple
  // linear ramp at the seams to avoid visible tile boundaries.
  const OVERLAP = 16;
  const innerStride = tileSize - OVERLAP * 2;
  const tilesX = Math.ceil(src.width / innerStride);
  const tilesY = Math.ceil(src.height / innerStride);
  const totalTiles = tilesX * tilesY;
  let tilesDone = 0;

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      // Source tile bounds (with overlap padding).
      let sx = tx * innerStride - OVERLAP;
      let sy = ty * innerStride - OVERLAP;
      const sw = tileSize;
      const sh = tileSize;
      // Edge clamp — for tiles that fall off the right/bottom edge,
      // shrink them so we don't extract past the image.
      const clampedX = Math.max(0, sx);
      const clampedY = Math.max(0, sy);
      const clampedW = Math.min(src.width - clampedX, sw - (clampedX - sx));
      const clampedH = Math.min(src.height - clampedY, sh - (clampedY - sy));
      if (clampedW < 1 || clampedH < 1) continue;

      // Pad to model tile size via sharp's extend (mirror edge).
      const tileRgb = await sharp(src.data, {
        raw: { width: src.width, height: src.height, channels: src.channels as 1 | 2 | 3 | 4 },
      })
        .extract({ left: clampedX, top: clampedY, width: clampedW, height: clampedH })
        .resize(tileSize, tileSize, { fit: 'fill' })
        .raw()
        .toBuffer();

      // fp16 ONNX expects float16 inputs ideally, but onnxruntime-node
      // accepts float32 input for float16 models (auto-cast internally).
      // Real-ESRGAN inputs are [0, 1] normalized RGB NCHW.
      const inputTensor = new ort.Tensor(
        'float32',
        rgbToNchwTensor0to1(tileRgb, tileSize, tileSize),
        [1, 3, tileSize, tileSize],
      );

      const result = await session.run({ [inputName]: inputTensor });
      const outputName = session.outputNames[0];
      const out = result[outputName];
      const outData = out.data as Float32Array;

      // Output tile is tileSize*SCALE x tileSize*SCALE.
      const outTileW = tileSize * SCALE;
      const outTileH = tileSize * SCALE;
      const outTileRgb = nchwTensorToRgb0to1(outData, outTileW, outTileH);

      // Resize back to clamped*SCALE in case input was extended.
      const clampedOutW = clampedW * SCALE;
      const clampedOutH = clampedH * SCALE;
      const outTileResized = await sharp(outTileRgb, {
        raw: { width: outTileW, height: outTileH, channels: 3 },
      })
        .resize(clampedOutW, clampedOutH, { fit: 'fill' })
        .raw()
        .toBuffer();

      // Paste into outBuf at the correct output position. Simple
      // overwrite — overlap blending would need per-tile weight masks
      // for proper feathering; for v1 we accept any visible seams
      // (rare with 16px overlap at 4x).
      const destX = clampedX * SCALE;
      const destY = clampedY * SCALE;
      for (let y = 0; y < clampedOutH; y++) {
        const srcRow = y * clampedOutW * 3;
        const dstRow = ((destY + y) * outW + destX) * 3;
        outTileResized.copy(outBuf, dstRow, srcRow, srcRow + clampedOutW * 3);
      }

      tilesDone++;
      post({
        type: 'progress',
        requestId: msg.requestId,
        phase: `Upscaling tile ${tilesDone} of ${totalTiles}…`,
        percent: 15 + Math.round((tilesDone / totalTiles) * 75),
      });
      // v2.1 (Terry 2026-06-07) — yield to the worker event loop
      // between tiles. Without this, the tight tile loop monopolises
      // the worker thread and the cancel-via-terminate signal from
      // main has to wait for the next ONNX inference to finish.
      // setImmediate hands control back to libuv briefly, which is
      // enough for terminate() to take effect promptly.
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  post({ type: 'progress', requestId: msg.requestId, phase: 'Saving…', percent: 92 });
  await sharp(outBuf, {
    raw: { width: outW, height: outH, channels: 3 },
  })
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(msg.outputPath);

  log(`enhanceUpscale done in ${Date.now() - t0}ms; ${tilesDone} tiles processed`);
  post({ type: 'done', requestId: msg.requestId, outputPath: msg.outputPath });
}

// ─── Message router ──────────────────────────────────────────────────────────

parentPort?.on('message', async (msg: InboundMessage) => {
  try {
    if (msg.type === 'enhance-faces') {
      await enhanceFaces(msg);
    } else if (msg.type === 'enhance-upscale') {
      await enhanceUpscale(msg);
    } else if (msg.type === 'unload') {
      codeformerSession = null;
      realesrganSession = null;
      // Hint GC — node releases ONNX session memory deterministically
      // on the next major GC cycle.
      if (global.gc) try { global.gc(); } catch {}
      log('Sessions unloaded');
    }
  } catch (err) {
    const error = err instanceof Error ? (err.stack || err.message) : String(err);
    log(`ERROR processing ${msg.type}: ${error}`);
    if (msg.type === 'enhance-faces' || msg.type === 'enhance-upscale') {
      post({ type: 'error', requestId: msg.requestId, error: (err as Error).message || error });
    }
  }
});

log('Worker started; awaiting messages.');
