/**
 * v2.1 (Terry 2026-06-07) — Video transcription worker.
 *
 * Whisper-base via @huggingface/transformers (already a project dep),
 * running off the main thread so a transcribe press doesn't freeze
 * the UI for the seconds-to-minutes the inference takes.
 *
 * Flow per request:
 *   1. ffmpeg extracts audio from the source video → 16 kHz mono
 *      Float32 PCM in a temp file (Whisper's expected input format).
 *   2. Whisper pipeline (loaded lazily on first request, kept
 *      resident across subsequent requests) transcribes the audio.
 *      Returns timestamped chunks [{start, end, text}].
 *   3. Worker posts the chunks back; main IPC writes them to the
 *      video_transcripts DB row + a .vtt sidecar next to the video.
 *
 * Model: Xenova/whisper-base (multilingual, ~150 MB ONNX). Downloaded
 * on first use into <userData>/whisper-cache; subsequent calls hit
 * the disk cache. CPU-bound at roughly 0.5-2× realtime depending on
 * machine and audio length.
 *
 * Progress reporting: phase strings + percentage match the pattern
 * the renderer's enhance-progress modal uses, so the UI can reuse
 * the same modal component without specialising for transcription.
 */

import { parentPort, workerData } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

interface WorkerConfig {
  /** <userData>/whisper-cache — where @huggingface/transformers
   *  drops the model files on first download. Reused across all
   *  subsequent transcribe runs in this process and across
   *  app launches. */
  cacheDir: string;
  /** Absolute path to the ffmpeg binary (ffmpeg-static). */
  ffmpegPath: string;
}

interface TranscribeMessage {
  type: 'transcribe';
  requestId: string;
  /** Absolute path to the source video file. */
  sourcePath: string;
  /** Optional language hint (ISO 639-1, e.g. 'en'). Default 'auto'. */
  language?: string;
}

type InboundMessage = TranscribeMessage;

interface ProgressOut {
  type: 'progress';
  requestId: string;
  phase: string;
  percent: number;
}

interface DoneOut {
  type: 'done';
  requestId: string;
  segments: Array<{ start: number; end: number; text: string }>;
  plainText: string;
  language: string;
  durationSeconds: number;
}

interface ErrorOut {
  type: 'error';
  requestId: string;
  error: string;
}

type OutboundMessage = ProgressOut | DoneOut | ErrorOut;

const config = workerData as WorkerConfig;

// Set the Transformers.js cache directory BEFORE importing the
// library so the model downloads land in our chosen location
// rather than ~/.cache/huggingface/hub/.
process.env.TRANSFORMERS_CACHE = config.cacheDir;
process.env.HF_HOME = config.cacheDir;
try { fs.mkdirSync(config.cacheDir, { recursive: true }); } catch { /* exists */ }

function post(msg: OutboundMessage) {
  parentPort?.postMessage(msg);
}

function log(msg: string) {
  console.log(`[transcribe-worker] ${msg}`);
}

// ─── Whisper pipeline (lazy + resident) ──────────────────────────────────────

let pipelineInstance: any = null;
async function getWhisperPipeline(requestId: string): Promise<any> {
  if (pipelineInstance) return pipelineInstance;
  log('Loading Whisper pipeline (first run — may download model ~150 MB)...');
  const t0 = Date.now();

  // Dynamic import so the worker module loads even if the heavy
  // dep can't initialise (we surface a clean error per request
  // rather than crashing at worker spawn).
  const { pipeline, env } = await import('@huggingface/transformers');
  // Explicitly pin the cache dir on the env config too (some
  // transformers versions ignore the env var alone).
  env.cacheDir = config.cacheDir;
  env.allowLocalModels = true;

  pipelineInstance = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
    progress_callback: (info: any) => {
      // info has shape { status: 'progress' | 'downloading' | ..., progress?: 0-100, file?: 'encoder_model.onnx', ... }
      if (info?.status === 'progress' && typeof info.progress === 'number') {
        post({
          type: 'progress',
          requestId,
          phase: `Downloading model: ${info.file || ''}`,
          percent: Math.min(15, Math.round(info.progress * 0.15)), // download takes up first 15% of the bar
        });
      }
    },
  } as any);
  log(`Whisper pipeline ready in ${Date.now() - t0} ms`);
  return pipelineInstance;
}

// ─── Audio extraction (ffmpeg → 16 kHz mono Float32 PCM) ─────────────────────

function extractAudio(sourcePath: string, outPath: string): Promise<{ durationSeconds: number }> {
  return new Promise((resolve, reject) => {
    // 16 kHz mono Float32 PCM raw — Whisper's canonical input format.
    // We write as WAV (-f wav) instead of raw so we can read it back
    // with header parsing instead of a separate sample-rate / channel
    // metadata channel.
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', sourcePath,
      '-vn',                            // no video
      '-ac', '1',                       // mono
      '-ar', '16000',                   // 16 kHz
      '-acodec', 'pcm_f32le',          // float32 little-endian
      '-f', 'wav',
      '-y', outPath,
    ];
    const proc = spawn(config.ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited code=${code}: ${stderr}`));
        return;
      }
      // Probe duration from the output WAV header. WAV format:
      //   bytes 0-3:   'RIFF'
      //   bytes 4-7:   file size - 8
      //   bytes 8-11:  'WAVE'
      //   ... fmt + data chunks ...
      // For float32 mono 16kHz: bytes-per-sample = 4, samples = data_chunk_size / 4,
      // duration = samples / 16000.
      // Defensive: probe the file size, subtract 44 (standard WAV header), divide
      // by sample size. If the file's been written but is much smaller than
      // expected for a long video, the fallback duration is still useful for the
      // progress estimate.
      try {
        const st = fs.statSync(outPath);
        const audioBytes = Math.max(0, st.size - 44);
        const durationSeconds = audioBytes / 4 / 16000;
        resolve({ durationSeconds });
      } catch (probeErr) {
        reject(new Error(`output WAV missing or unreadable: ${(probeErr as Error).message}`));
      }
    });
  });
}

// Read the WAV body into a Float32Array for Whisper's pipeline.
function readWavAsFloat32(wavPath: string): Float32Array {
  const buf = fs.readFileSync(wavPath);
  // Skip standard 44-byte WAV header. (Sharp/precise: scan for the
  // 'data' chunk marker if header size varies; for our ffmpeg-
  // generated WAVs the header is always exactly 44 bytes.)
  const offset = 44;
  const sampleCount = (buf.length - offset) / 4;
  return new Float32Array(buf.buffer, buf.byteOffset + offset, sampleCount);
}

// ─── Main transcribe handler ─────────────────────────────────────────────────

async function transcribe(msg: TranscribeMessage): Promise<void> {
  const { requestId, sourcePath, language } = msg;
  const t0 = Date.now();

  post({ type: 'progress', requestId, phase: 'Extracting audio…', percent: 5 });

  const tmpDir = path.join(os.tmpdir(), 'pdr-transcribe');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* exists */ }
  const wavPath = path.join(tmpDir, `${requestId}.wav`);

  let durationSeconds = 0;
  try {
    const r = await extractAudio(sourcePath, wavPath);
    durationSeconds = r.durationSeconds;
    log(`extracted ${durationSeconds.toFixed(1)}s of audio to ${wavPath}`);
  } catch (err) {
    post({ type: 'error', requestId, error: (err as Error).message });
    return;
  }

  post({ type: 'progress', requestId, phase: 'Loading Whisper…', percent: 15 });

  let pipe: any;
  try {
    pipe = await getWhisperPipeline(requestId);
  } catch (err) {
    post({ type: 'error', requestId, error: `Whisper pipeline init failed: ${(err as Error).message}` });
    return;
  }

  post({ type: 'progress', requestId, phase: 'Transcribing audio…', percent: 25 });

  let audio: Float32Array;
  try {
    audio = readWavAsFloat32(wavPath);
  } catch (err) {
    post({ type: 'error', requestId, error: `Audio read failed: ${(err as Error).message}` });
    return;
  }

  try {
    // return_timestamps: true → pipeline returns { text, chunks: [{timestamp: [start, end], text}] }
    // chunk_length_s: 30 → standard Whisper window (one inference per 30s chunk)
    // Pipeline has no native progress callback per chunk; we estimate
    // by emitting periodic ticks while we wait. Simple: just emit a
    // final 90% before save.
    const result: any = await pipe(audio, {
      language: language && language !== 'auto' ? language : undefined,
      task: 'transcribe',
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    post({ type: 'progress', requestId, phase: 'Saving transcript…', percent: 90 });

    // Normalise the pipeline's output shape into our schema.
    const segments: Array<{ start: number; end: number; text: string }> = [];
    const chunks = (result?.chunks ?? []) as Array<{ timestamp?: [number | null, number | null]; text?: string }>;
    for (const c of chunks) {
      const start = typeof c.timestamp?.[0] === 'number' ? c.timestamp![0]! : 0;
      const end = typeof c.timestamp?.[1] === 'number' ? c.timestamp![1]! : (start + 5);
      const text = (c.text ?? '').trim();
      if (!text) continue;
      // v2.1 round 22 (Terry 2026-06-08) — filter out Whisper's
      // hallucinated-silence garbage. When fed non-speech audio
      // (music, background noise, ambient room tone) Whisper
      // tends to return chunks like "!!!!!!!" or "...........",
      // or "you" / " you you you you" repeated. Terry hit this
      // on a 2-minute video that produced one segment of ~100
      // exclamation marks. Heuristic: require at least 30% real
      // letters (so any text where punctuation dominates gets
      // tossed) AND at least 3 letters total. Multi-language safe
      // via \p{L} unicode letter class.
      const letters = text.replace(/[^\p{L}]/gu, '');
      if (letters.length < 3) continue;
      if (letters.length / text.length < 0.3) continue;
      // Also drop the lone-token repeat artefact ("you you you you").
      const tokens = text.toLowerCase().split(/\s+/).filter(t => t.length > 0);
      if (tokens.length > 3) {
        const unique = new Set(tokens).size;
        if (unique <= 2) continue; // 4+ tokens but only 1-2 distinct
      }
      segments.push({ start, end, text });
    }
    const plainText = segments.map(s => s.text).join(' ').trim();
    const detectedLanguage = (result?.language ?? language ?? 'en').toString();

    // Clean up the temp wav.
    try { fs.unlinkSync(wavPath); } catch { /* non-fatal */ }

    log(`transcribed ${durationSeconds.toFixed(1)}s of audio in ${((Date.now() - t0) / 1000).toFixed(1)}s; ${segments.length} segments`);

    post({
      type: 'done',
      requestId,
      segments,
      plainText,
      language: detectedLanguage,
      durationSeconds,
    });
  } catch (err) {
    post({ type: 'error', requestId, error: `Whisper inference failed: ${(err as Error).message}` });
  }
}

// ─── Worker entry ────────────────────────────────────────────────────────────

parentPort?.on('message', async (msg: InboundMessage) => {
  try {
    if (msg.type === 'transcribe') {
      await transcribe(msg);
    } else {
      post({ type: 'error', requestId: (msg as any).requestId ?? 'unknown', error: `Unknown message type: ${(msg as any).type}` });
    }
  } catch (err) {
    post({ type: 'error', requestId: (msg as any).requestId ?? 'unknown', error: (err as Error).message });
  }
});

log('worker ready');
