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
  pipelineInstance = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-large-v3-turbo', {
    // q4 quantisation on BOTH encoder and decoder. The encoder is
    // where audio gets converted into the acoustic feature
    // representation; the decoder is the autoregressive text
    // generator. q4 weights cut memory bandwidth by 4× vs fp32
    // — that's the largest single contributor to CPU inference
    // speed. Modest quality cost (~1-3% on benchmarks) vs the
    // ~6-8× speed gain.
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
  const inferenceStartTs = Date.now();
  // v2.1 round 30 — distil-medium.en + q8 decoder runs at roughly
  // 1.5-2× realtime on CPU. Set the ramp denominator to 2× so the
  // bar tracks closely without finishing early.
  const estimatedSec = Math.max(5, durationSeconds * 2.0);
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
    // return_timestamps: true → pipeline returns { text, chunks: [{timestamp: [start, end], text}] }
    // chunk_length_s: 30 → standard Whisper window (one inference per 30s chunk)
    // v2.1 round 30 — distil-medium.en is English-only by design,
    // so we don't need (and the model doesn't accept) a language
    // parameter. Same `return_timestamps: true` so the segment
    // timestamps drive the caption overlay; chunk/stride match the
    // canonical Whisper settings. condition_on_previous_text=false
    // still reduces phrase-loop hallucinations across chunks.
    // v2.1 round 42 (Terry 2026-06-08) — request WORD-level
    // timestamps instead of segment-level. Word-level timing is
    // typically accurate to ±0.2-0.4s (vs ±1-3s for segment-level)
    // — directly fixes the caption-drift problem Terry reported
    // ("captions arrive maybe 8 seconds before anyone is talking").
    // The pipeline returns chunks of shape { timestamp: [start,
    // end], text: ' word' } at word granularity; we then re-group
    // them into displayable caption segments in groupWordsToCaptions
    // below.
    //
    // Large-v3 Turbo is multilingual, so we can (and should) pass
    // language back in. Default to English if the caller didn't
    // specify (matches Terry's library).
    const effectiveLanguage = language && language !== 'auto' ? language : 'en';
    const result: any = await pipe(audio, {
      language: effectiveLanguage,
      task: 'transcribe',
      return_timestamps: 'word',
      // chunk_length_s 20s + stride 10s is the tuning ChatGPT
      // recommended for cleaner boundary stitching on long
      // recordings. Smaller chunks = more frequent timestamp
      // resets; bigger stride = more context overlap between
      // chunks for the model to disambiguate.
      chunk_length_s: 20,
      stride_length_s: 10,
      condition_on_previous_text: false,
      no_speech_threshold: 0.6,
    } as any);
    clearInterval(heartbeat);

    // v2.1 round 23 — dump raw Whisper output to the log BEFORE
    // filtering so we can see exactly what the model returned when
    // a "no speech" result is unexpected (Terry's case: a video
    // with clear dialogue came back empty). With this we can tell
    // whether the model itself returned nothing, whether it
    // returned garbage that got filtered, or whether the pipeline
    // call errored silently.
    log(`raw pipeline result: text=${JSON.stringify((result?.text ?? '').slice(0, 200))} chunks.length=${(result?.chunks ?? []).length}`);
    const rawChunks = (result?.chunks ?? []) as Array<{ timestamp?: [number | null, number | null]; text?: string }>;
    if (rawChunks.length > 0 && rawChunks.length <= 10) {
      log(`raw chunks: ${JSON.stringify(rawChunks.map(c => ({ ts: c.timestamp, text: (c.text ?? '').slice(0, 80) })))}`);
    }

    post({ type: 'progress', requestId, phase: 'Saving transcript…', percent: 90 });

    // v2.1 round 42 (Terry 2026-06-08) — with word-level timestamps,
    // each chunk is a single word. Step 1: normalise into a clean
    // word array (skip empty / un-timed). Step 2: filter the
    // hallucinated-silence words at WORD level (a "!" emitted as a
    // single word with letters.length < 3 still gets dropped; pure
    // single-character runs of "you you you" still get caught at
    // the group level after assembly). Step 3: group adjacent
    // words into displayable caption segments via
    // groupWordsToCaptions.
    const wordChunks = (result?.chunks ?? []) as Array<{ timestamp?: [number | null, number | null]; text?: string }>;
    const words: Array<{ start: number; end: number; text: string }> = [];
    for (const c of wordChunks) {
      const start = typeof c.timestamp?.[0] === 'number' ? c.timestamp![0]! : null;
      const end = typeof c.timestamp?.[1] === 'number' ? c.timestamp![1]! : null;
      const text = c.text ?? '';
      if (start === null || end === null) continue;
      if (!text.trim()) continue;
      words.push({ start, end, text });
    }
    const provisionalSegments = groupWordsToCaptions(words);
    // Per-segment garbage filter — same heuristics as before, just
    // applied AFTER grouping so the rules act on the final caption
    // form the user would actually see.
    const segments: Array<{ start: number; end: number; text: string }> = [];
    for (const seg of provisionalSegments) {
      const text = seg.text.trim();
      if (!text) continue;
      const letters = text.replace(/[^\p{L}]/gu, '');
      if (letters.length < 3) continue;
      if (letters.length / text.length < 0.3) continue;
      const tokens = text.toLowerCase().split(/\s+/).filter(t => t.length > 0);
      if (tokens.length >= 6) {
        const unique = new Set(tokens).size;
        if (unique === 1) continue; // pure single-token loop
      }
      segments.push({ start: seg.start, end: seg.end, text });
    }
    const plainText = segments.map(s => s.text).join(' ').trim();
    const detectedLanguage = (result?.language ?? language ?? 'en').toString();
    const rawPreview = (result?.text ?? '').toString().slice(0, 200);
    const rawChunkCount = rawChunks.length;

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
