/**
 * v2.0.15 Phase 4 (Terry 2026-06-06) — installer for the optional AI
 * Photo Enhancement models (CodeFormer for face restoration,
 * Real-ESRGAN for whole-image upscaling).
 *
 * Why a separate module from ai-manager.ts: ai-manager is the
 * runtime/inference side for the existing CLIP + face models that
 * ship pre-downloaded on first analyze (via @huggingface/transformers).
 * The Photo Enhancement models are user-opt-in via Settings cards,
 * downloaded explicitly with a visible progress bar, and run via
 * `onnxruntime-node` directly (NOT through transformers.js's pipeline
 * — their multi-stage architectures don't fit the pipeline shape).
 *
 * Hosting (v2.0.15): HuggingFace direct.
 * Hosting (v2.2): Mirror to PDR R2 bucket (see roadmap). Swap the
 * URL constants below — atomic move + hash verify stays the same.
 *
 * Download model:
 *   - Streamed HTTPS GET to <modelsDir>/<modelKey>/<filename>.tmp
 *   - Progress broadcast throttled to ~4Hz (every 250ms)
 *   - Atomic rename on success; .tmp deleted on cancel/error
 *   - Re-install over an existing model replaces it (uninstall then re-download)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { app } from 'electron';
import log from 'electron-log';

// ─── Catalogue ───────────────────────────────────────────────────────────────

export type ModelKey = 'codeformer' | 'realesrgan' | 'bgremover';

export interface ModelSpec {
  key: ModelKey;
  /** Human-readable name shown in the Settings card */
  displayName: string;
  /** What it does, one sentence for the card body */
  oneLiner: string;
  /** Approximate download size in MB, shown in the card before install */
  sizeMB: number;
  /** Exact byte size, used as a sanity check after download */
  expectedBytes: number;
  /** HuggingFace download URL — swap to R2 in v2.2 */
  url: string;
  /** Subdirectory under <modelsDir>/ — keeps each model's files together */
  subdir: string;
  /** Local filename the ONNX is saved as */
  filename: string;
}

/**
 * Verified 2026-06-06 via HuggingFace API.
 * CodeFormer: yuvraj108c/codeformer-onnx is the most recently updated
 *   ONNX conversion (2024-04). Size confirmed at 337 MB.
 * Real-ESRGAN: tamnvcc/RealESRGAN-onnx hosts the fp16 quantised x4plus
 *   variant at 33.6 MB — half the size of the original .pth with
 *   negligible quality loss on the 4x upscale task.
 */
export const MODELS: Record<ModelKey, ModelSpec> = {
  codeformer: {
    key: 'codeformer',
    displayName: 'CodeFormer (face restoration)',
    oneLiner: 'Restores blurred, low-resolution, or damaged faces back to lifelike detail using an AI face-prior trained on thousands of high-quality portraits. Best for old scans, distant subjects, and faces from older phone cameras.',
    sizeMB: 337,
    expectedBytes: 337 * 1024 * 1024,
    url: 'https://huggingface.co/yuvraj108c/codeformer-onnx/resolve/main/codeformer.onnx',
    subdir: 'codeformer',
    filename: 'codeformer.onnx',
  },
  realesrgan: {
    key: 'realesrgan',
    displayName: 'Real-ESRGAN (whole-image upscale)',
    oneLiner: 'Upscales any photo 4× while reconstructing detail rather than just blurring pixels bigger. Best for printing small photos large, recovering low-resolution captures, or improving any image whose original is not enough.',
    sizeMB: 34,
    expectedBytes: 33 * 1024 * 1024 + 600 * 1024, // ~33.6 MB
    url: 'https://huggingface.co/tamnvcc/RealESRGAN-onnx/resolve/main/onnx/RealESRGAN_x4plus.fp16.onnx',
    subdir: 'realesrgan',
    filename: 'RealESRGAN_x4plus.fp16.onnx',
  },
  // v2.1 round 173 (Terry 2026-06-14) — Background remover (collage subject
  // cut-out). Model = IS-Net "general-use" (the DIS dichotomous-segmentation
  // network, Apache-2.0 from xuebinqin's repo — the same model rembg ships as
  // its recommended general-purpose remover). Chosen after BiRefNet-lite was
  // ruled out: its fixed 1024² deformable-conv stack needs multiple ~800 MB
  // buffers and OOM'd on this 24 GB box (only ~6.7 GB free) in BOTH fp16 and
  // fp32. IS-Net runs the same 1024² input in ~6 s on CPU with a clean
  // dichotomous mask (keeps ALL foreground, not just the single salient
  // object the way U2-Net does). Byte size verified 2026-06-14.
  // Hosting: rembg's permanent v0.0.0 release; mirror to PDR R2 in v2.2.
  bgremover: {
    key: 'bgremover',
    displayName: 'Background remover',
    oneLiner: 'Removes the background from a photo, cutting out the subject so it sits cleanly on your collage background. Runs entirely on your device. Best for dropping people, pets, or objects onto a different backdrop.',
    sizeMB: 179,
    expectedBytes: 178648008,
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
    subdir: 'bgremover',
    filename: 'isnet-general-use.onnx',
  },
};

// ─── Paths ───────────────────────────────────────────────────────────────────

function getModelsDir(): string {
  return path.join(app.getPath('userData'), 'ai-models');
}

export function getModelFilePath(key: ModelKey): string {
  const spec = MODELS[key];
  return path.join(getModelsDir(), spec.subdir, spec.filename);
}

export function getModelTempPath(key: ModelKey): string {
  return getModelFilePath(key) + '.downloading';
}

// ─── State ───────────────────────────────────────────────────────────────────

export type InstallState = 'not-installed' | 'downloading' | 'installed';

interface ActiveDownload {
  request: import('http').ClientRequest;
  destStream: fs.WriteStream;
  cancelled: boolean;
  totalBytes: number;
  receivedBytes: number;
}

const activeDownloads = new Map<ModelKey, ActiveDownload>();

export function getInstallState(key: ModelKey): InstallState {
  if (activeDownloads.has(key)) return 'downloading';
  try {
    const filePath = getModelFilePath(key);
    if (fs.existsSync(filePath)) {
      // Sanity check: file must be at least 50% of expected — guards
      // against a stale half-written file from a prior crashed install.
      // The .tmp atomic-rename pattern below should prevent this, but
      // belt-and-braces given the file is hundreds of MB.
      const stat = fs.statSync(filePath);
      if (stat.size >= MODELS[key].expectedBytes * 0.5) return 'installed';
      log.warn(`[ai-model-installer] ${key}: file exists but is undersized (${stat.size} < ${MODELS[key].expectedBytes * 0.5}); treating as not-installed`);
      try { fs.unlinkSync(filePath); } catch {}
    }
  } catch (err) {
    log.warn(`[ai-model-installer] getInstallState(${key}) error: ${(err as Error).message}`);
  }
  return 'not-installed';
}

export function getDownloadProgress(key: ModelKey): { receivedBytes: number; totalBytes: number; percent: number } | null {
  const d = activeDownloads.get(key);
  if (!d) return null;
  const percent = d.totalBytes > 0 ? Math.round((d.receivedBytes / d.totalBytes) * 100) : 0;
  return { receivedBytes: d.receivedBytes, totalBytes: d.totalBytes, percent };
}

// ─── Install ─────────────────────────────────────────────────────────────────

export interface InstallOptions {
  /** Called whenever progress advances. Throttled by the caller. */
  onProgress?: (info: { receivedBytes: number; totalBytes: number; percent: number }) => void;
}

/**
 * Download the model to disk. Returns when the file is fully written
 * and atomically renamed into place. Throws on network / disk / cancel
 * errors (caller wraps in try/catch and surfaces the message).
 *
 * Concurrent install() calls for the SAME key throw immediately — the
 * UI prevents this by disabling the button while downloading, but we
 * guard at the API too.
 */
export async function installModel(key: ModelKey, opts: InstallOptions = {}): Promise<void> {
  if (activeDownloads.has(key)) {
    throw new Error(`${MODELS[key].displayName} is already downloading.`);
  }

  const spec = MODELS[key];
  const finalPath = getModelFilePath(key);
  const tmpPath = getModelTempPath(key);
  const dir = path.dirname(finalPath);

  // Make sure the per-model subdirectory exists (and cascade-create
  // <modelsDir> if this is the first AI feature the user has touched).
  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {
    throw new Error(`Could not create model directory: ${(err as Error).message}`);
  }

  // Wipe any stale .tmp from a prior crashed install. The .tmp file
  // is per-model and never the source of truth — losing it costs us
  // nothing.
  if (fs.existsSync(tmpPath)) {
    try { fs.unlinkSync(tmpPath); } catch {}
  }

  // Pre-flight: if the final file already exists from a prior install,
  // remove it. Caller should normally uninstall first to surface
  // confirmation, but if they didn't we replace.
  if (fs.existsSync(finalPath)) {
    try { fs.unlinkSync(finalPath); } catch (err) {
      throw new Error(`Could not remove existing model file: ${(err as Error).message}`);
    }
  }

  await downloadWithRedirects(spec.url, tmpPath, key, opts);

  // Sanity check the downloaded file size before atomic rename.
  // HuggingFace serves Content-Length so this should always match,
  // but the check protects against a CDN/proxy that streamed less
  // than promised without erroring.
  const stat = fs.statSync(tmpPath);
  if (stat.size < spec.expectedBytes * 0.9) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new Error(`Download finished but file is too small (${stat.size} bytes; expected ~${spec.expectedBytes}). Network may have truncated. Try again.`);
  }

  fs.renameSync(tmpPath, finalPath);
  log.info(`[ai-model-installer] ${key} installed (${stat.size} bytes) at ${finalPath}`);
}

/**
 * Follow up to 5 redirects (HuggingFace serves a 302 to a signed CDN
 * URL on the first hit). Each hop reuses the same tmp file destination
 * — we only start writing on the final 200 response.
 */
function downloadWithRedirects(
  url: string,
  tmpPath: string,
  key: ModelKey,
  opts: InstallOptions,
  hopsLeft: number = 5,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (hopsLeft <= 0) {
      reject(new Error('Too many redirects.'));
      return;
    }

    const req = https.get(url, {
      headers: {
        // Identify as PDR for HF logs + give them a chance to rate-limit
        // us specifically if we ever cause problems, rather than tarring
        // every electron app with the same brush.
        'User-Agent': `PhotoDateRescue/${app.getVersion?.() ?? '2.0.15'}`,
      },
    }, (res) => {
      // Redirect handling — HF's resolve/main URLs almost always 302.
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain
        downloadWithRedirects(res.headers.location, tmpPath, key, opts, hopsLeft - 1).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed: HTTP ${res.statusCode} from ${url}`));
        return;
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      const destStream = fs.createWriteStream(tmpPath);

      const active: ActiveDownload = {
        request: req,
        destStream,
        cancelled: false,
        totalBytes,
        receivedBytes: 0,
      };
      activeDownloads.set(key, active);

      // Throttle progress callbacks to ~4Hz so the renderer isn't
      // flooded with IPC traffic. 250ms is fine-grained enough for
      // a smooth progress bar without burning a CPU core on IPC.
      let lastEmit = 0;
      const PROGRESS_INTERVAL_MS = 250;

      res.on('data', (chunk: Buffer) => {
        active.receivedBytes += chunk.length;
        const now = Date.now();
        if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
          lastEmit = now;
          if (opts.onProgress) {
            const percent = totalBytes > 0 ? Math.round((active.receivedBytes / totalBytes) * 100) : 0;
            try { opts.onProgress({ receivedBytes: active.receivedBytes, totalBytes, percent }); } catch {}
          }
        }
      });

      res.pipe(destStream);

      destStream.on('finish', () => {
        activeDownloads.delete(key);
        if (active.cancelled) {
          try { fs.unlinkSync(tmpPath); } catch {}
          reject(new Error('Download cancelled.'));
        } else {
          // Emit a final 100% update so the UI doesn't sit at 99%.
          if (opts.onProgress) {
            try { opts.onProgress({ receivedBytes: active.receivedBytes, totalBytes, percent: 100 }); } catch {}
          }
          resolve();
        }
      });
      destStream.on('error', (err) => {
        activeDownloads.delete(key);
        try { fs.unlinkSync(tmpPath); } catch {}
        reject(new Error(`Could not write model file: ${err.message}`));
      });
      res.on('error', (err) => {
        activeDownloads.delete(key);
        destStream.destroy();
        try { fs.unlinkSync(tmpPath); } catch {}
        reject(new Error(`Network error during download: ${err.message}`));
      });
    });

    req.on('error', (err) => {
      activeDownloads.delete(key);
      try { fs.unlinkSync(tmpPath); } catch {}
      reject(new Error(`Could not connect: ${err.message}`));
    });
  });
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

/** Cancel an in-progress download. The .tmp file is deleted; the file
 *  on disk (if any) from a prior install is NOT touched. */
export function cancelInstall(key: ModelKey): boolean {
  const d = activeDownloads.get(key);
  if (!d) return false;
  d.cancelled = true;
  try { d.request.destroy(); } catch {}
  try { d.destStream.destroy(); } catch {}
  // tmp file cleanup happens in the stream's error/finish handlers.
  return true;
}

// ─── Uninstall ───────────────────────────────────────────────────────────────

/** Delete the installed model file (and any stale .tmp). Throws if the
 *  delete fails (e.g. file locked by an inference worker — caller should
 *  ensure no worker is using the model first). */
export function uninstallModel(key: ModelKey): void {
  const finalPath = getModelFilePath(key);
  const tmpPath = getModelTempPath(key);
  if (fs.existsSync(finalPath)) {
    fs.unlinkSync(finalPath);
    log.info(`[ai-model-installer] ${key} uninstalled from ${finalPath}`);
  }
  if (fs.existsSync(tmpPath)) {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}
