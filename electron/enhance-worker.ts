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
  /** Absolute path to <userData>/ai-models/bgremover/isnet-general-use.onnx (background removal) */
  bgremoverPath: string;
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

interface RemoveBackgroundMessage {
  type: 'remove-background';
  requestId: string;
  sourcePath: string;
  /** Output PNG path (transparent background where the subject isn't). */
  outputPath: string;
  /** Cut-out strength 0-100 (50 = raw mask). >50 cuts harder, <50 keeps more. */
  strength?: number;
}

interface UnloadMessage {
  type: 'unload';
}

type InboundMessage = EnhanceFacesMessage | EnhanceUpscaleMessage | RemoveBackgroundMessage | UnloadMessage;

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
let bgremoverSession: ort.InferenceSession | null = null;

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

async function getBgRemoverSession(): Promise<ort.InferenceSession> {
  if (bgremoverSession) return bgremoverSession;
  if (!fs.existsSync(config.bgremoverPath)) {
    throw new Error(`Background remover model not found at ${config.bgremoverPath}. Install via Settings → AI → Background remover.`);
  }
  log(`Loading background-remover session from ${config.bgremoverPath}...`);
  const t0 = Date.now();
  bgremoverSession = await ort.InferenceSession.create(config.bgremoverPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: cpuThreadCap(),
    interOpNumThreads: 1,
  });
  log(`Background remover loaded in ${Date.now() - t0}ms; inputs=${bgremoverSession.inputNames.join(',')} outputs=${bgremoverSession.outputNames.join(',')}; threads=${cpuThreadCap()}`);
  return bgremoverSession;
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

/** Convert RGB Buffer [H*W*3] uint8 → Float32Array NCHW, normalised the way
 *  IS-Net expects: (pixel/255 − 0.5) / 1.0, i.e. centred to [−0.5, 0.5].
 *  (This is rembg's normalisation for isnet-general-use — NOT ImageNet
 *  mean/std, which produces a much weaker mask.) */
function rgbToNchwIsnet(rgb: Buffer, width: number, height: number): Float32Array {
  const channelSize = width * height;
  const out = new Float32Array(3 * channelSize);
  for (let i = 0; i < channelSize; i++) {
    out[i] = rgb[i * 3] / 255 - 0.5;
    out[i + channelSize] = rgb[i * 3 + 1] / 255 - 0.5;
    out[i + 2 * channelSize] = rgb[i * 3 + 2] / 255 - 0.5;
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

// ─── BiRefNet (background removal) ────────────────────────────────────────────

const BR_SIZE = 1024; // IS-Net input resolution (general-use model)

/** Numerically-stable sigmoid. */
function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

/** Decode an IEEE-754 half-float (uint16 bits) to a JS number. onnxruntime-node
 *  hands fp16 output tensors back as a Uint16Array, so we may need this. */
function halfToFloat(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

// v2.1 round 175 (Terry) — cache the raw IS-Net mask for the LAST photo so the
// Cut-out strength slider can re-tune instantly (no ~9 s ISNet re-run). Single
// entry keyed by source path; replaced when a different photo is processed.
let bgMaskCache: {
  sourcePath: string; maskBuf: Buffer; mw: number; mh: number;
  ex: number; ey: number; ew: number; eh: number;
  srcData: Buffer; srcW: number; srcH: number; srcCh: number;
  outW: number; outH: number;
} | null = null;

// Remap the raw soft mask by the strength slider (0-100, 50 = neutral/raw).
// >50 raises the alpha black point (cut harder — removes the faint halo);
// <50 multiplies low alpha up (keep more — brings back bits the model dropped).
function applyBgStrength(maskBuf: Buffer, strength: number): Buffer {
  if (!(strength >= 0) || strength === 50) return maskBuf;
  const out = Buffer.alloc(maskBuf.length);
  if (strength > 50) {
    const T = Math.round(((strength - 50) / 50) * 200); // black point 0..200
    const denom = (255 - T) || 1;
    for (let i = 0; i < maskBuf.length; i++) { const v = maskBuf[i]; out[i] = v <= T ? 0 : Math.min(255, Math.round((v - T) / denom * 255)); }
  } else {
    const gain = 1 + ((50 - strength) / 50) * 2; // boost 1..3
    for (let i = 0; i < maskBuf.length; i++) { out[i] = Math.min(255, Math.round(maskBuf[i] * gain)); }
  }
  return out;
}

async function removeBackground(msg: RemoveBackgroundMessage): Promise<void> {
  const t0 = Date.now();
  const strength = (typeof msg.strength === 'number') ? msg.strength : 50;
  let c = (bgMaskCache && bgMaskCache.sourcePath === msg.sourcePath) ? bgMaskCache : null;
  const cacheHit = !!c;
  if (!c) {
  post({ type: 'progress', requestId: msg.requestId, phase: 'Loading the model…', percent: 5 });
  const session = await getBgRemoverSession();
  const inputName = session.inputNames[0];

  // Full-resolution source (auto-oriented, alpha stripped). The mask is scaled
  // back up to THIS size, so the cut-out keeps the photo's original detail.
  post({ type: 'progress', requestId: msg.requestId, phase: 'Reading the photo…', percent: 15 });
  let src = await readImageRaw(msg.sourcePath);

  // v2.1 round 234 (Terry) — CAP the source decode. readImageRaw does a full-
  // resolution .raw() decode = W*H*3 bytes, which is UNBOUNDED: a 48 MP phone
  // photo is ~144 MB, and that buffer is then cached in bgMaskCache.srcData AND
  // re-resized for the composite. Under memory pressure (the app had just built
  // a 74k-row sidecar snapshot + pre-warmed People Manager) a full-res bg-remove
  // OOM-crashed the whole collage renderer with nothing logged. round 174 capped
  // only the OUTPUT (OUT_CAP=2000) — the giant raw SOURCE buffer was the real
  // spike. Cap it here, BEFORE the big buffer is built/cached. The model only
  // ever sees BR_SIZE (1024²) and the output is hard-capped at 2000px, so a
  // source above 2000px long-edge can't improve either the mask or the cut-out
  // quality — this never degrades a normal photo (its output was already going
  // to be downscaled to ≤2000 from whatever the source size was).
  const SRC_CAP = 2000;
  const srcLong = Math.max(src.width, src.height);
  if (srcLong > SRC_CAP) {
    const ds = SRC_CAP / srcLong;
    const dw = Math.max(1, Math.round(src.width * ds));
    const dh = Math.max(1, Math.round(src.height * ds));
    const dsData = await sharp(src.data, {
      raw: { width: src.width, height: src.height, channels: src.channels as 1 | 2 | 3 | 4 },
    })
      .resize(dw, dh, { fit: 'fill' })
      .raw()
      .toBuffer();
    log(`removeBackground source capped ${src.width}x${src.height} -> ${dw}x${dh} (cap ${SRC_CAP})`);
    src = { data: dsData, width: dw, height: dh, channels: src.channels };
  }

  // Letterbox a copy into the model's square input — preserve aspect ratio and
  // pad with black, NOT a plain squash. Squashing a non-square photo to 1024²
  // distorts the subject badly and the mask comes back as a vague blob; letter-
  // boxing keeps the subject's true proportions and the mask is crisp.
  post({ type: 'progress', requestId: msg.requestId, phase: 'Finding the subject…', percent: 30 });
  const scale = Math.min(BR_SIZE / src.width, BR_SIZE / src.height);
  const rw = Math.max(1, Math.round(src.width * scale));
  const rh = Math.max(1, Math.round(src.height * scale));
  const padL = Math.floor((BR_SIZE - rw) / 2);
  const padT = Math.floor((BR_SIZE - rh) / 2);
  const inputRgb = await sharp(src.data, {
    raw: { width: src.width, height: src.height, channels: src.channels as 1 | 2 | 3 | 4 },
  })
    .resize(rw, rh)
    .extend({ top: padT, bottom: BR_SIZE - rh - padT, left: padL, right: BR_SIZE - rw - padL, background: { r: 0, g: 0, b: 0 } })
    .raw()
    .toBuffer();

  // IS-Net is a plain fp32 model; feed its centred normalisation as NCHW.
  const inputTensor = new ort.Tensor('float32', rgbToNchwIsnet(inputRgb, BR_SIZE, BR_SIZE), [1, 3, BR_SIZE, BR_SIZE]);
  const result = await session.run({ [inputName]: inputTensor });

  // IS-Net emits several side outputs; the FIRST is the fused final mask
  // (single-channel [1,1,H,W]).
  const ot = result[session.outputNames[0]];
  const od = ot.data as unknown as { [i: number]: number; length: number };
  const isF16 = (ot.type as string) === 'float16';
  const getV = (i: number): number => (isF16 ? halfToFloat(od[i]) : od[i]);
  const dims = ot.dims as readonly number[];
  const mh = dims[dims.length - 2];
  const mw = dims[dims.length - 1];
  const n = mh * mw;

  // Detect raw logits (apply sigmoid) vs already-probabilities (use as-is) so
  // this works no matter how the ONNX export was traced.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const v = getV(i); if (v < lo) lo = v; if (v > hi) hi = v; }
  const needSigmoid = lo < -0.01 || hi > 1.01;

  post({ type: 'progress', requestId: msg.requestId, phase: 'Cutting out the subject…', percent: 70 });
  const maskBuf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const v = needSigmoid ? sigmoid(getV(i)) : getV(i);
    maskBuf[i] = clampToByte(v * 255);
  }
  log(`Background-remover mask ${mw}x${mh}; raw range [${lo.toFixed(3)},${hi.toFixed(3)}] sigmoid=${needSigmoid}`);

  // Map the mask back to the original: crop the letterbox content region out of
  // the square mask, then scale to the source. The mask MUST be re-encoded
  // (PNG) before extract — a chained extract+resize on a RAW pixel buffer
  // mis-maps the pixels in sharp (the cut-out came out scrambled), whereas
  // extracting from a decoded image is correct.
  const ex = Math.round(padL * mw / BR_SIZE), ey = Math.round(padT * mh / BR_SIZE);
  const ew = Math.max(1, Math.round(rw * mw / BR_SIZE)), eh = Math.max(1, Math.round(rh * mh / BR_SIZE));

  // v2.1 round 174 (Terry) — CAP the cut-out resolution. A collage bakes at
  // 2000px and the preview tile is small, so a full-res cut-out is wasteful: a
  // 48 MP phone photo decodes to ~190 MB as an <img>, and several of those in
  // one collage exhausted the renderer's memory — the 2nd/3rd cut-out crashed
  // the collage window (navy screen). 2000px long-edge is ample for both the
  // bake and the preview, and keeps each cut-out a few MB instead of hundreds.
  const OUT_CAP = 2000;
  const longEdge = Math.max(src.width, src.height);
  const outScale = longEdge > OUT_CAP ? OUT_CAP / longEdge : 1;
  const outW = Math.max(1, Math.round(src.width * outScale));
  const outH = Math.max(1, Math.round(src.height * outScale));
  c = bgMaskCache = { sourcePath: msg.sourcePath, maskBuf, mw, mh, ex, ey, ew, eh, srcData: src.data, srcW: src.width, srcH: src.height, srcCh: src.channels, outW, outH };
  }

  // Apply the strength remap to the (cached) raw mask, then build the cut-out.
  // On a cache hit this is the ONLY work — no ISNet — so the slider re-tunes fast.
  post({ type: 'progress', requestId: msg.requestId, phase: cacheHit ? 'Re-tuning the cut-out…' : 'Cutting out the subject…', percent: 70 });
  const effMask = applyBgStrength(c.maskBuf, strength);
  const maskPng = await sharp(effMask, { raw: { width: c.mw, height: c.mh, channels: 1 } }).png().toBuffer();
  const maskFull = await sharp(maskPng)
    .extract({ left: c.ex, top: c.ey, width: Math.min(c.ew, c.mw - c.ex), height: Math.min(c.eh, c.mh - c.ey) })
    .resize(c.outW, c.outH, { fit: 'fill' })
    .toColourspace('b-w')
    .raw()
    .toBuffer();

  // Join the mask as the alpha channel of the (capped) RGB → transparent PNG.
  post({ type: 'progress', requestId: msg.requestId, phase: 'Saving…', percent: 90 });
  const rgbOut = await sharp(c.srcData, { raw: { width: c.srcW, height: c.srcH, channels: c.srcCh as 1 | 2 | 3 | 4 } })
    .resize(c.outW, c.outH, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();
  await sharp(rgbOut, { raw: { width: c.outW, height: c.outH, channels: 3 } })
    .joinChannel(maskFull, { raw: { width: c.outW, height: c.outH, channels: 1 } })
    .png()
    .toFile(msg.outputPath);

  log(`removeBackground done in ${Date.now() - t0}ms; strength=${strength} cacheHit=${cacheHit} ${c.srcW}x${c.srcH} -> ${c.outW}x${c.outH}`);
  post({ type: 'done', requestId: msg.requestId, outputPath: msg.outputPath });
}

// ─── Message router ──────────────────────────────────────────────────────────

parentPort?.on('message', async (msg: InboundMessage) => {
  try {
    if (msg.type === 'enhance-faces') {
      await enhanceFaces(msg);
    } else if (msg.type === 'enhance-upscale') {
      await enhanceUpscale(msg);
    } else if (msg.type === 'remove-background') {
      await removeBackground(msg);
    } else if (msg.type === 'unload') {
      codeformerSession = null;
      realesrganSession = null;
      bgremoverSession = null;
      bgMaskCache = null;
      // Hint GC — node releases ONNX session memory deterministically
      // on the next major GC cycle.
      if (global.gc) try { global.gc(); } catch {}
      log('Sessions unloaded');
    }
  } catch (err) {
    const error = err instanceof Error ? (err.stack || err.message) : String(err);
    log(`ERROR processing ${msg.type}: ${error}`);
    if (msg.type === 'enhance-faces' || msg.type === 'enhance-upscale' || msg.type === 'remove-background') {
      post({ type: 'error', requestId: msg.requestId, error: (err as Error).message || error });
    }
  }
});

log('Worker started; awaiting messages.');
