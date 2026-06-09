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
  /** v2.1 round 25 — diagnostic: number of chunks Whisper returned
   *  BEFORE the hallucination filter. Lets main log "Whisper
   *  returned N chunks, filter rejected all" when the toast says
   *  "no speech" but the video clearly had dialogue. */
  rawChunkCount?: number;
  /** v2.1 round 25 — diagnostic: first 200 chars of the raw
   *  pipeline text (un-filtered). Lets us tell at a glance
   *  whether Whisper hallucinated ("!!!!"), returned garbage in
   *  the wrong language, or just produced empty chunks. */
  rawPreview?: string;
  /** v2.1 round 25 — diagnostic: RMS amplitude of the audio fed
   *  to Whisper. Near-zero ≈ silence (extraction problem); a
   *  healthy speech mix is typically 0.05–0.3. Helps distinguish
   *  audio-extraction failure from Whisper-side recognition
   *  failure. */
  audioRms?: number;
}

interface ErrorOut {
  type: 'error';
  requestId: string;
  error: string;
}

interface LogOut {
  type: 'log';
  message: string;
}

type OutboundMessage = ProgressOut | DoneOut | ErrorOut | LogOut;

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
  // v2.1 round 25 (Terry 2026-06-08) — worker_threads stdout isn't
  // captured by electron-log, so worker log lines were invisible
  // when diagnosing "no speech" results. Pipe through the message
  // channel so main's logger picks them up too. Keep the local
  // console.log so they still appear in the dev console.
  console.log(`[transcribe-worker] ${msg}`);
  try { post({ type: 'log', message: msg }); } catch { /* before parentPort wired */ }
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

  // v2.1 round 42 (Terry 2026-06-08) — switched to Whisper Large-v3
  // Turbo via the onnx-community account. Per ChatGPT's second
  // opinion and the verified ONNX file inventory, this is the
  // proper "YouTube-like captions, offline, local, fast enough
  // for laptops" target:
  //
  //   • Distilled from Large-v3 (4 decoder layers instead of 32)
  //     so it's near-Large accuracy at much lower inference cost.
  //   • Multilingual but excellent on English.
  //   • Published with a full dtype matrix: fp32 / fp16 / int8 /
  //     uint8 / q4 / q4f16 / bnb4 for both encoder and decoder.
  //   • With q4 + q4 the on-disk size is ~720 MB total (encoder
  //     ~405 MB, decoder ~319 MB) — actually SMALLER than the
  //     previous whisper-small.en setup, while being meaningfully
  //     more accurate on noisy consumer audio (phone-recorded
  //     family videos with background TV, music, kids, etc.).
  //   • Inference: ~1-2× realtime on a typical consumer laptop CPU.
  //
  // Repo: onnx-community/whisper-large-v3-turbo (Xenova's old
  // transformers.js Whisper repos merged into the onnx-community
  // org). isCurrentWhisperModelReady() in main.ts checks the
  // matching cache path.
  // v2.1 round 52 (Terry 2026-06-09) — back to Whisper Large-v3
  // Turbo + q4 as the final v2.1 transcription model. small.en
  // was faster (~2× realtime) but the accuracy on Terry's noisy
  // family videos was unusable — "Yerusha hasshah haslor"-class
  // mishearings on every other line. Turbo + q4 is ~5× realtime
  // but the output is near-YouTube quality. The speed/quality
  // trade is the right one for premium PDR.
  //
  // device: 'cpu' forces native onnxruntime-node bindings.
  // GPU acceleration (DirectML execution provider) is on the
  // v2.2 roadmap — would lift this to roughly real-time for
  // users with modern dedicated GPUs.
  pipelineInstance = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-large-v3-turbo', {
    device: 'cpu',
    dtype: {
      encoder_model: 'q4',
      decoder_model_merged: 'q4',
    },
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
    //
    // v2.1 round 24 (Terry 2026-06-08) — loudnorm audio filter. Real-
    // world consumer videos routinely capture dialogue at low levels
    // (phone in pocket, distant subject, road noise mixed in). Feeding
    // raw quiet audio to Whisper-base gives the "!!!!" hallucination
    // every time — the model genuinely can't pick out speech below a
    // certain SNR threshold. EBU R128 loudnorm brings the whole track
    // up to broadcast loudness (I=-16 LUFS) and compresses dynamic
    // range (LRA=11), so the speech bits land in Whisper's sweet
    // spot. Terry 2026-06-08: "there was English conversation being
    // had at good volume and clarity" — but "good to the human ear"
    // ≠ "good for Whisper's tiny acoustic model" without normalising.
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', sourcePath,
      '-vn',                                                  // no video
      '-af', 'loudnorm=I=-16:LRA=11:TP=-1.5',                 // normalise loudness to broadcast level
      '-ac', '1',                                              // mono
      '-ar', '16000',                                          // 16 kHz
      '-acodec', 'pcm_f32le',                                  // float32 little-endian
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
//
// v2.1 round 26 (Terry 2026-06-08) — PROPERLY scan for the 'data'
// chunk instead of hard-coding offset 44. The hard-coded offset
// worked for plain `ffmpeg -i ... -acodec pcm_f32le -f wav`, but
// the moment we added `-af loudnorm` the filter inserts a longer
// header (extra fmt extension fields + a LIST chunk with the
// gain metadata), so the actual audio sample data sits somewhere
// past byte 44 — typically around 80-128 bytes in. Reading from
// 44 fed Whisper a chunk of HEADER bytes interpreted as float32
// samples, which produced NaN amplitudes and the canonical
// silence-hallucination output ("!!!!"). Smoking-gun symptom in
// the worker log: "audio RMS = NaN".
//
// Standard WAV chunk format:
//   bytes 0-3:   'RIFF'
//   bytes 4-7:   file size - 8  (little-endian uint32)
//   bytes 8-11:  'WAVE'
//   then a sequence of chunks, each:
//     bytes 0-3: chunk id (4 ASCII chars, e.g. 'fmt ', 'data', 'LIST')
//     bytes 4-7: chunk size (little-endian uint32, payload length)
//     bytes 8+:  payload
// We scan from byte 12 onwards until we hit 'data', then return
// a view over `dataOffset+8 .. dataOffset+8+dataSize`.
function readWavAsFloat32(wavPath: string): Float32Array {
  const buf = fs.readFileSync(wavPath);
  if (buf.length < 12) throw new Error(`WAV too short: ${buf.length} bytes`);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Not a RIFF file');
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAVE file');
  let cursor = 12;
  while (cursor + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', cursor, cursor + 4);
    const chunkSize = buf.readUInt32LE(cursor + 4);
    if (chunkId === 'data') {
      const dataStart = cursor + 8;
      const dataEnd = Math.min(buf.length, dataStart + chunkSize);
      const dataLen = dataEnd - dataStart;
      const sampleCount = Math.floor(dataLen / 4);
      // Float32Array view over the underlying ArrayBuffer slice. We
      // copy into a fresh ArrayBuffer when alignment isn't 4-byte
      // (rare but possible after Buffer pooling) to keep
      // Float32Array's contract.
      const byteOffset = buf.byteOffset + dataStart;
      if (byteOffset % 4 === 0) {
        return new Float32Array(buf.buffer, byteOffset, sampleCount);
      }
      const copy = Buffer.allocUnsafe(sampleCount * 4);
      buf.copy(copy, 0, dataStart, dataStart + sampleCount * 4);
      return new Float32Array(copy.buffer, copy.byteOffset, sampleCount);
    }
    // Chunks are 2-byte aligned per the RIFF spec — pad the cursor
    // by 1 if chunkSize is odd.
    cursor += 8 + chunkSize + (chunkSize % 2);
  }
  throw new Error(`No 'data' chunk found in ${buf.length}-byte WAV`);
}

// v2.1 round 25 (Terry 2026-06-08) — RMS amplitude check on the
// extracted audio. Lets us distinguish "ffmpeg produced silence"
// (RMS ~0) from "audio is real but Whisper failed" (RMS healthy
// but no segments survived the hallucination filter). A typical
// speech track has RMS in the 0.05–0.3 range; ambient/room tone
// is more like 0.005–0.02; true silence is < 0.001. Sample at
// every 1000th sample to keep the cost negligible on a 2-minute
// clip (~1.9 M samples → ~1.9 K probes).
function computeAudioRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  let count = 0;
  for (let i = 0; i < samples.length; i += 1000) {
    const v = samples[i];
    sumSq += v * v;
    count++;
  }
  return count > 0 ? Math.sqrt(sumSq / count) : 0;
}

// ─── Silero VAD (speech vs everything-else pre-segmentation) ────────────────
//
// v2.1 round 50 (Terry 2026-06-09) — Silero VAD pre-filters the audio
// so Whisper only sees the speech regions. Background music, ambient,
// silence, wind, kids playing, crowd noise — all skipped. For a video
// where talking is, say, 25% of the runtime, Whisper does ~1/4 the
// work, which is the speedup. Speech WITH music underneath still
// counts as speech (because the human voice is detected through it),
// so the user-relevant moments are kept.
//
// Model: onnx-community/silero-vad (fp32 ONNX, ~2 MB). Downloaded on
// first use into <cache>/silero-vad/model.onnx, then loaded directly
// via onnxruntime-node (already a transitive dep of
// @huggingface/transformers v4). Runs in 512-sample (32 ms) windows
// at 16 kHz; produces a per-window speech probability.

let sileroVadSession: any = null;
async function ensureSileroVadModel(cacheDir: string): Promise<string> {
  const dir = path.join(cacheDir, 'silero-vad');
  const modelPath = path.join(dir, 'model.onnx');
  if (fs.existsSync(modelPath)) return modelPath;
  await fs.promises.mkdir(dir, { recursive: true });
  log('Downloading Silero VAD model (~2 MB)...');
  const url = 'https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Silero VAD download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(modelPath, buf);
  log(`Silero VAD downloaded to ${modelPath} (${buf.length} bytes)`);
  return modelPath;
}

async function findSpeechRegions(
  audio: Float32Array,
  cacheDir: string,
  opts: { threshold?: number; minSpeechMs?: number; minSilenceMs?: number; padMs?: number } = {},
): Promise<Array<{ startSec: number; endSec: number }>> {
  // Tunables. Defaults chosen for noisy consumer audio:
  //  • threshold 0.5 — default Silero recommendation
  //  • minSpeechMs 250 — drop fragments shorter than this (sneezes,
  //    door slams that the model occasionally mis-labels as speech)
  //  • minSilenceMs 500 — merge speech regions separated by < this
  //    much silence (so a natural pause doesn't fragment a sentence)
  //  • padMs 200 — extend each region by this much on both sides
  //    so Whisper doesn't get clipped at the boundaries
  const threshold = opts.threshold ?? 0.5;
  const minSpeechMs = opts.minSpeechMs ?? 250;
  const minSilenceMs = opts.minSilenceMs ?? 500;
  const padMs = opts.padMs ?? 200;

  const modelPath = await ensureSileroVadModel(cacheDir);
  const ort = await import('onnxruntime-node');
  if (!sileroVadSession) {
    sileroVadSession = await ort.InferenceSession.create(modelPath);
    log(`Silero VAD ready (inputs: ${sileroVadSession.inputNames.join(', ')})`);
  }

  // The onnx-community silero-vad model uses input names `input`,
  // `state`, `sr`. State shape is [2, 1, 128] float32.
  const windowSize = 512;
  const sampleRate = 16000;
  const sampleRateTensor = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);
  let state = new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);

  const probs: number[] = [];
  for (let i = 0; i + windowSize <= audio.length; i += windowSize) {
    // Fresh Float32Array per chunk — subarray-into-Tensor leaks
    // references in onnxruntime-node's older versions.
    const chunkData = new Float32Array(windowSize);
    chunkData.set(audio.subarray(i, i + windowSize));
    const input = new ort.Tensor('float32', chunkData, [1, windowSize]);
    const out = await sileroVadSession.run({ input, state, sr: sampleRateTensor });
    probs.push(Number((out.output.data as Float32Array)[0]));
    state = out.stateN ?? out.state ?? state;
  }

  // Convert window-level probabilities into speech regions.
  // State machine: open a region on first speech, close after
  // minSilenceWindows consecutive non-speech windows.
  const windowMs = (windowSize / sampleRate) * 1000; // 32 ms per window
  const minSpeechWindows = Math.max(1, Math.ceil(minSpeechMs / windowMs));
  const minSilenceWindows = Math.max(1, Math.ceil(minSilenceMs / windowMs));
  const padWindows = Math.max(0, Math.ceil(padMs / windowMs));

  const regions: Array<{ startWindow: number; endWindow: number }> = [];
  let regionStart = -1;
  let silenceCount = 0;
  for (let i = 0; i < probs.length; i++) {
    const isSpeech = probs[i] >= threshold;
    if (isSpeech) {
      if (regionStart < 0) regionStart = i;
      silenceCount = 0;
    } else if (regionStart >= 0) {
      silenceCount++;
      if (silenceCount >= minSilenceWindows) {
        const endWindow = i - silenceCount + 1;
        if (endWindow - regionStart >= minSpeechWindows) {
          regions.push({ startWindow: regionStart, endWindow });
        }
        regionStart = -1;
        silenceCount = 0;
      }
    }
  }
  if (regionStart >= 0) {
    const endWindow = probs.length - silenceCount;
    if (endWindow - regionStart >= minSpeechWindows) {
      regions.push({ startWindow: regionStart, endWindow });
    }
  }

  return regions.map(r => ({
    startSec: Math.max(0, (r.startWindow - padWindows) * windowSize / sampleRate),
    endSec: Math.min(audio.length / sampleRate, (r.endWindow + padWindows) * windowSize / sampleRate),
  }));
}

// ─── Caption grouping (word-level chunks → displayable segments) ────────────

/**
 * v2.1 round 42 (Terry 2026-06-08) — group Whisper's word-level
 * chunks into displayable caption segments.
 *
 * With `return_timestamps: 'word'` the pipeline emits one chunk per
 * word, each with its own tight [start, end] pair. That's great for
 * accuracy but unreadable as captions — nobody wants captions that
 * flicker on every word boundary. The grouping rule below collapses
 * adjacent words into 2-7 second caption segments using natural
 * break points: long silences, sentence-ending punctuation, and a
 * soft cap on words/duration to stop captions running off the end
 * of the screen.
 *
 * Output shape matches the segment-level schema we already persist
 * (`{ start, end, text }`) so the DB write + viewer overlay code
 * doesn't need to change.
 *
 * Break rules (in order of priority):
 *   1. Big silence gap (>= 0.8s between words) — always a hard break.
 *   2. Sentence-ending punctuation (. ! ?) — natural reading break,
 *      flush after this word.
 *   3. Soft caps: max 10 words OR 5 seconds per segment — readability.
 *   4. End of input — always flush whatever's accumulated.
 */
function groupWordsToCaptions(
  words: Array<{ start: number; end: number; text: string }>,
  opts: { silenceGapSec?: number; maxWords?: number; maxDurationSec?: number } = {},
): Array<{ start: number; end: number; text: string }> {
  const silenceGapSec = opts.silenceGapSec ?? 0.8;
  const maxWords = opts.maxWords ?? 10;
  const maxDurationSec = opts.maxDurationSec ?? 5;
  const out: Array<{ start: number; end: number; text: string }> = [];
  let cur: { start: number; end: number; words: string[] } | null = null;

  const flush = () => {
    if (cur && cur.words.length > 0) {
      // Whisper word tokens are typically space-prefixed (" word") so
      // a plain join collapses to ` word1 word2 word3` — trim and
      // we get the readable form.
      out.push({ start: cur.start, end: cur.end, text: cur.words.join('').trim() });
    }
    cur = null;
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!cur) {
      cur = { start: w.start, end: w.end, words: [w.text] };
      continue;
    }
    const gapSec = w.start - cur.end;
    const wouldExceedDuration = (w.end - cur.start) > maxDurationSec;
    const wouldExceedWords = cur.words.length >= maxWords;
    // Look BACK at the previous word's text for sentence-ending
    // punctuation. We break AFTER that word, not before this one,
    // so the punctuation stays with its sentence.
    const prevText = cur.words[cur.words.length - 1] ?? '';
    const prevEndsSentence = /[.!?][)"'\]]?\s*$/.test(prevText);
    if (gapSec >= silenceGapSec || prevEndsSentence || wouldExceedDuration || wouldExceedWords) {
      flush();
      cur = { start: w.start, end: w.end, words: [w.text] };
      continue;
    }
    cur.end = w.end;
    cur.words.push(w.text);
  }
  flush();
  return out;
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

  // v2.1 round 25 (Terry 2026-06-08) — log the RMS of the audio
  // we're about to hand Whisper. Distinguishes ffmpeg / loudnorm
  // failure (RMS near zero) from Whisper recognition failure (RMS
  // healthy but no usable text). Surfaced in the done message
  // too, so main can log it alongside the "no speech" outcome.
  const audioRms = computeAudioRms(audio);
  log(`audio RMS = ${audioRms.toFixed(4)} (healthy speech ≈ 0.05–0.3, silence < 0.001)`);

  // v2.1 round 51 (Terry 2026-06-09) — VAD DISABLED for this
  // round. On Terry's test (134s audio) Silero VAD split the
  // clip into 36 short regions; per-region Whisper invocation
  // overhead ate the theoretical speedup and the transcript
  // had more errors. Treating the whole clip as one region
  // restores the no-VAD behaviour while keeping the per-region
  // loop infrastructure ready to re-enable later (e.g. with
  // tighter region merging, or only when there's clearly a lot
  // of silence in the audio). findSpeechRegions helper stays
  // in the file for that future round.
  const speechRegions: Array<{ startSec: number; endSec: number }> = [
    { startSec: 0, endSec: audio.length / 16000 },
  ];

  // v2.1 round 23 (Terry 2026-06-08) — heartbeat ticks while the
  // pipeline is running. The HuggingFace ASR pipeline doesn't
  // expose per-chunk progress callbacks, so without this the
  // worker emits 25% before inference and 90% after — user sees
  // "stuck at 25%" for the entire actual transcription. Now ticks
  // every 2 s with a smooth 25→89 ramp based on estimated total
  // time (audio duration × ~1× realtime floor). Ramp asymptotes
  // toward 89% so it never falsely hits 100 before the model
  // genuinely finishes. Clamped at 89 so the final 90 → done jump
  // remains an unambiguous "saving" signal.
  // v2.1 round 26 (Terry 2026-06-08) — heartbeat estimate bumped
  // from 1× realtime to 4.5× to match Whisper-small's actual
  // inference speed on a typical CPU (observed 4.7× realtime in
  // the previous run). At 1× the ramp hit 89% within seconds and
  // then sat there for minutes → looked stuck. At 4.5× the ramp
  // tracks much closer to actual progress, and the message
  // switches to "wrapping up" once we hit the ceiling so the user
  // knows the bar parking at 89% isn't a hang.
  // v2.1 round 50 (Terry 2026-06-09) — estimated time is now based
  // on TOTAL SPEECH duration (post-VAD), not raw audio duration.
  // A 2-minute video with 30s of speech now ramps over ~3min
  // (30s × ~6× realtime) rather than ~12min.
  const totalSpeechSec = speechRegions.reduce((a, r) => a + (r.endSec - r.startSec), 0);
  const inferenceStartTs = Date.now();
  const estimatedSec = Math.max(5, totalSpeechSec * 4.5);
  const heartbeat = setInterval(() => {
    const elapsedSec = (Date.now() - inferenceStartTs) / 1000;
    const ramp = Math.min(0.99, elapsedSec / estimatedSec);
    const pct = Math.min(89, Math.round(25 + ramp * 64));
    const phase = pct >= 89
      ? 'Transcribing audio… (wrapping up)'
      : 'Transcribing audio…';
    post({ type: 'progress', requestId, phase, percent: pct });
  }, 2000);

  try {
    // v2.1 round 52 (Terry 2026-06-09) — Turbo is multilingual,
    // so we pass language + task explicitly. Default to English
    // (Terry's library), allow override via the request.
    const effectiveLanguage = language && language !== 'auto' ? language : 'en';
    // Per-region loop infrastructure is preserved from the VAD work,
    // but with VAD disabled (round 51) there's only one region
    // covering the whole audio — so this loop runs exactly once.
    const allRawChunks: Array<{ timestamp: [number, number]; text: string }> = [];
    const sampleRate = 16000;
    for (let r = 0; r < speechRegions.length; r++) {
      const region = speechRegions[r];
      const sliceStart = Math.floor(region.startSec * sampleRate);
      const sliceEnd = Math.floor(region.endSec * sampleRate);
      const sliceLen = sliceEnd - sliceStart;
      if (sliceLen < sampleRate * 0.2) continue; // skip <200ms regions
      const slice = new Float32Array(sliceLen);
      slice.set(audio.subarray(sliceStart, sliceEnd));

      if (speechRegions.length > 1) {
        post({
          type: 'progress',
          requestId,
          phase: `Transcribing speech region ${r + 1} of ${speechRegions.length}…`,
          percent: Math.min(89, Math.round(25 + (r / Math.max(1, speechRegions.length)) * 64)),
        });
      }

      const result: any = await pipe(slice, {
        language: effectiveLanguage,
        task: 'transcribe',
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
        condition_on_previous_text: false,
        no_speech_threshold: 0.6,
      } as any);

      const chunks = (result?.chunks ?? []) as Array<{ timestamp?: [number | null, number | null]; text?: string }>;
      for (const c of chunks) {
        const localStart = typeof c.timestamp?.[0] === 'number' ? c.timestamp![0]! : 0;
        const localEnd = typeof c.timestamp?.[1] === 'number' ? c.timestamp![1]! : (localStart + 5);
        allRawChunks.push({
          timestamp: [localStart + region.startSec, localEnd + region.startSec],
          text: c.text ?? '',
        });
      }
    }
    clearInterval(heartbeat);

    log(`VAD + Whisper: ${allRawChunks.length} raw chunks across ${speechRegions.length} region(s)`);
    if (allRawChunks.length > 0 && allRawChunks.length <= 10) {
      log(`raw chunks: ${JSON.stringify(allRawChunks.map(c => ({ ts: c.timestamp, text: (c.text ?? '').slice(0, 80) })))}`);
    }

    post({ type: 'progress', requestId, phase: 'Saving transcript…', percent: 90 });

    // v2.1 round 45 + 50 — segment-level post-processing of the
    // (now timeline-corrected) chunks from all regions.
    const segChunks = allRawChunks as Array<{ timestamp?: [number | null, number | null]; text?: string }>;
    const segments: Array<{ start: number; end: number; text: string }> = [];
    for (const c of segChunks) {
      const start = typeof c.timestamp?.[0] === 'number' ? c.timestamp![0]! : 0;
      const end = typeof c.timestamp?.[1] === 'number' ? c.timestamp![1]! : (start + 5);
      const text = (c.text ?? '').trim();
      if (!text) continue;
      const letters = text.replace(/[^\p{L}]/gu, '');
      if (letters.length < 3) continue;
      if (letters.length / text.length < 0.3) continue;
      const tokens = text.toLowerCase().split(/\s+/).filter(t => t.length > 0);
      if (tokens.length >= 6) {
        const unique = new Set(tokens).size;
        if (unique === 1) continue;
      }
      segments.push({ start, end, text });
    }
    const plainText = segments.map(s => s.text).join(' ').trim();
    // v2.1 round 50 (Terry 2026-06-09) — the per-region loop above
    // doesn't have a single `result` to read language/preview off,
    // so derive them from the aggregated state. Language defaults
    // to the requested one since each region was called with it.
    const detectedLanguage = (language && language !== 'auto' ? language : 'en');
    const rawPreview = allRawChunks.map(c => c.text).join('').slice(0, 200);
    const rawChunkCount = allRawChunks.length;

    // Clean up the temp wav.
    try { fs.unlinkSync(wavPath); } catch { /* non-fatal */ }

    log(`transcribed ${durationSeconds.toFixed(1)}s of audio in ${((Date.now() - t0) / 1000).toFixed(1)}s; ${segments.length} segments kept (${rawChunkCount} raw chunks, RMS ${audioRms.toFixed(4)})`);

    post({
      type: 'done',
      requestId,
      segments,
      plainText,
      language: detectedLanguage,
      durationSeconds,
      rawChunkCount,
      rawPreview,
      audioRms,
    });
  } catch (err) {
    clearInterval(heartbeat);
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
