#!/usr/bin/env node
// script/extract-png-baseline.mjs
//
// One-shot benchmark extractor for PNG conversion runs.
//
// Pulls every [Convert] line out of PDR's main.log + main.old.log,
// groups them into "runs" (gap >30 min = new run), and writes one
// JSON file per run into bench/png-convert/<date>_<phase>.json. Each
// JSON captures per-file dur/in/out/ratio/mem rows, per-batch
// "Batch done" summaries, aggregate wall-clock + throughput, and run
// metadata (sharp/libvips versions, OS, CPU).
//
// Why: PDR's logs rotate (main.log -> main.old.log -> discarded).
// Without preserving them, we lose the only baseline we can compare
// future conversion-pipeline changes (zlib-ng, libspng, etc.) against.
//
// Created 2026-06-02 by Terry's request — "save it before it goes."

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const LOG_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'Photo Date Rescue', 'logs');
const OUT_DIR = path.join(repoRoot, 'bench', 'png-convert');

// ─── parse helpers ─────────────────────────────────────────────────────────

const TIMESTAMP_RE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d{3})\]/;
const PERFILE_RE = /\[Convert\]\s+#(\d+)\.(\d+)\s+(ok|FAIL)\s+dur=(\d+)ms\s+in=(\d+)KB\s+out=(\d+)KB\s+ratio=([\d.]+)\s+mem=(\d+)MB\s+"([^"]+)"/;
const BATCH_RE = /\[Convert\]\s+Batch done\s+—\s+(\d+)\/(\d+)\s+succeeded,\s+(\d+)\s+failed,\s+in=([\d.]+)MB\s+out=([\d.]+)MB\s+throughput=([\d.]+)MB\/s,\s+child mem rss=(\d+)\s+MB\s+heap=(\d+)\s+MB\s+external=(\d+)\s+MB/;
const DONE_RE = /\[Convert\]\s+Done:\s+(.+)$/;

function parseTimestamp(line) {
  const m = TIMESTAMP_RE.exec(line);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}.${m[3]}`;
  return { iso, ms: Date.parse(`${m[1]}T${m[2]}.${m[3]}Z`) };
}

// ─── ingest log files ──────────────────────────────────────────────────────

function readLogLines() {
  const files = [
    path.join(LOG_DIR, 'main.old.log'),
    path.join(LOG_DIR, 'main.log'),
  ];
  const out = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (line.includes('[Convert]')) out.push({ src: path.basename(f), line });
    }
  }
  return out;
}

function classifyLines(rawLines) {
  const events = [];
  for (const { src, line } of rawLines) {
    const ts = parseTimestamp(line);
    if (!ts) continue;
    const perFile = PERFILE_RE.exec(line);
    if (perFile) {
      events.push({
        kind: 'file',
        src,
        ts,
        batchIdx: Number(perFile[1]),
        fileIdx: Number(perFile[2]),
        ok: perFile[3] === 'ok',
        durMs: Number(perFile[4]),
        inKB: Number(perFile[5]),
        outKB: Number(perFile[6]),
        ratio: Number(perFile[7]),
        memMB: Number(perFile[8]),
        filename: perFile[9],
      });
      continue;
    }
    const batch = BATCH_RE.exec(line);
    if (batch) {
      events.push({
        kind: 'batch',
        src,
        ts,
        succeeded: Number(batch[1]),
        total: Number(batch[2]),
        failed: Number(batch[3]),
        inMB: Number(batch[4]),
        outMB: Number(batch[5]),
        throughputMBps: Number(batch[6]),
        childRssMB: Number(batch[7]),
        heapMB: Number(batch[8]),
        externalMB: Number(batch[9]),
      });
      continue;
    }
    const done = DONE_RE.exec(line);
    if (done) {
      events.push({ kind: 'done', src, ts, filename: done[1] });
      continue;
    }
    // Other [Convert] lines (Batch start, spawn, errors, etc.) — keep
    // raw so we don't lose anything potentially relevant.
    events.push({ kind: 'other', src, ts, raw: line.split('[Convert]').pop().trim() });
  }
  return events;
}

// ─── group into runs ───────────────────────────────────────────────────────

// A "run" = a contiguous burst of [Convert] activity. Gap > 30 min between
// timestamps -> new run. Manual benchmark sessions and Fix-with-conversion
// jobs both look the same in the log, but they're separated by long
// idle gaps.
const RUN_GAP_MS = 30 * 60 * 1000;

function groupIntoRuns(events) {
  events.sort((a, b) => a.ts.ms - b.ts.ms);
  const runs = [];
  let current = null;
  for (const ev of events) {
    if (!current || ev.ts.ms - current.lastMs > RUN_GAP_MS) {
      current = { startMs: ev.ts.ms, lastMs: ev.ts.ms, events: [] };
      runs.push(current);
    }
    current.events.push(ev);
    current.lastMs = ev.ts.ms;
  }
  return runs;
}

// ─── aggregate one run ─────────────────────────────────────────────────────

function aggregate(run) {
  const files = run.events.filter(e => e.kind === 'file');
  const batches = run.events.filter(e => e.kind === 'batch');
  const ok = files.filter(f => f.ok);
  const failed = files.filter(f => !f.ok);
  const durs = ok.map(f => f.durMs).sort((a, b) => a - b);
  const ratios = ok.map(f => f.ratio).sort((a, b) => a - b);
  const mems = ok.map(f => f.memMB).sort((a, b) => a - b);
  const inKBs = ok.map(f => f.inKB);
  const outKBs = ok.map(f => f.outKB);

  const pct = (arr, p) => arr.length === 0 ? null : arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const mean = arr => arr.length === 0 ? null : sum(arr) / arr.length;

  const wallMs = run.lastMs - run.startMs;
  const totalInBytes = sum(inKBs) * 1024;
  const totalOutBytes = sum(outKBs) * 1024;

  return {
    fileCount: files.length,
    okCount: ok.length,
    failedCount: failed.length,
    batchCount: batches.length,
    wallClockMs: wallMs,
    wallClockMinutes: +(wallMs / 60000).toFixed(2),
    totalInputBytes: totalInBytes,
    totalOutputBytes: totalOutBytes,
    totalInputGB: +(totalInBytes / 1e9).toFixed(3),
    totalOutputGB: +(totalOutBytes / 1e9).toFixed(3),
    sizeRatio: totalInBytes === 0 ? null : +(totalOutBytes / totalInBytes).toFixed(3),
    perFileDurMs: {
      min: durs[0] ?? null,
      p50: pct(durs, 0.50),
      p95: pct(durs, 0.95),
      max: durs[durs.length - 1] ?? null,
      mean: +(mean(durs) ?? 0).toFixed(1),
    },
    perFileRatio: {
      min: ratios[0] ?? null,
      p50: pct(ratios, 0.50),
      p95: pct(ratios, 0.95),
      max: ratios[ratios.length - 1] ?? null,
      mean: +(mean(ratios) ?? 0).toFixed(3),
    },
    perFileMemMB: {
      min: mems[0] ?? null,
      p50: pct(mems, 0.50),
      p95: pct(mems, 0.95),
      max: mems[mems.length - 1] ?? null,
    },
    throughputMBps: wallMs === 0 ? null : +(totalOutBytes / 1e6 / (wallMs / 1000)).toFixed(2),
  };
}

// ─── run metadata (sharp/libvips/os/cpu) ───────────────────────────────────

function runMetadata() {
  let sharpVersion = null, libvipsVersion = null;
  try {
    const sharpPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'node_modules', 'sharp', 'package.json'), 'utf8'));
    sharpVersion = sharpPkg.version;
  } catch { /* best-effort */ }
  try {
    // sharp.versions is the canonical source but importing sharp here
    // would spin up libvips. Read the prebuilt manifest as a cheap
    // proxy — it embeds the libvips version in its filename.
    const prebuiltDir = path.join(repoRoot, 'node_modules', 'sharp', 'vendor');
    if (fs.existsSync(prebuiltDir)) {
      const dirs = fs.readdirSync(prebuiltDir);
      libvipsVersion = dirs.find(d => /^\d/.test(d)) ?? null;
    }
  } catch { /* best-effort */ }

  return {
    sharp: sharpVersion,
    libvips: libvipsVersion,
    node: process.version,
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    totalRamGB: +(os.totalmem() / 1e9).toFixed(2),
  };
}

// ─── write run files ───────────────────────────────────────────────────────

function dateTag(ms) {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}${mi}`;
}

function classifyPhase(startIso) {
  // Maps to the roadmap's documented v2.0.15 PNG optimisation timeline:
  //   pre-2026-05-31 = baseline (compressionLevel 6, no EXIF inline, fork-per-batch)
  //   2026-05-31     = compressionLevel 6→1 + EXIF inline shipped (commit 91eb790)
  //   2026-05-30/31  = persistent worker shipped (commit 61d2ab5)
  //   2026-05-31+    = post-optimisation steady state
  const date = startIso.slice(0, 10);
  if (date < '2026-05-31') return 'pre-optimisation';
  if (date <= '2026-06-02') return 'v2.0.15-post-optimisation';
  return 'unknown';
}

const rawLines = readLogLines();
console.log(`Read ${rawLines.length} [Convert] lines from logs.`);
const events = classifyLines(rawLines);
console.log(`Classified ${events.length} events.`);
const runs = groupIntoRuns(events);
console.log(`Grouped into ${runs.length} run(s) (gap > ${RUN_GAP_MS / 60000} min = new run).`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const meta = runMetadata();

const index = [];
for (const run of runs) {
  const agg = aggregate(run);
  // Skip noise runs — anything <10 files is probably a quick test, not a benchmark
  if (agg.fileCount < 10) {
    console.log(`Skipping run @ ${new Date(run.startMs).toISOString()} — only ${agg.fileCount} file(s).`);
    continue;
  }
  const tag = dateTag(run.startMs);
  const phase = classifyPhase(new Date(run.startMs).toISOString());
  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    extractedFrom: ['main.old.log', 'main.log'],
    source: 'PDR main.log [Convert] telemetry',
    runId: tag,
    phase,
    startedAt: new Date(run.startMs).toISOString(),
    endedAt: new Date(run.lastMs).toISOString(),
    metadata: meta,
    aggregate: agg,
    perFile: run.events
      .filter(e => e.kind === 'file')
      .map(e => ({
        ts: e.ts.iso,
        batch: e.batchIdx,
        idx: e.fileIdx,
        ok: e.ok,
        durMs: e.durMs,
        inKB: e.inKB,
        outKB: e.outKB,
        ratio: e.ratio,
        memMB: e.memMB,
        filename: e.filename,
      })),
    perBatch: run.events
      .filter(e => e.kind === 'batch')
      .map(e => ({
        ts: e.ts.iso,
        succeeded: e.succeeded,
        total: e.total,
        failed: e.failed,
        inMB: e.inMB,
        outMB: e.outMB,
        throughputMBps: e.throughputMBps,
        childRssMB: e.childRssMB,
        heapMB: e.heapMB,
        externalMB: e.externalMB,
      })),
  };
  const outPath = path.join(OUT_DIR, `${tag}_${phase}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${outPath} — ${agg.fileCount} files, ${agg.wallClockMinutes} min wall-clock, ${agg.throughputMBps} MB/s.`);
  index.push({
    runId: tag,
    phase,
    file: path.relative(repoRoot, outPath).replace(/\\/g, '/'),
    startedAt: out.startedAt,
    endedAt: out.endedAt,
    fileCount: agg.fileCount,
    wallClockMinutes: agg.wallClockMinutes,
    totalInputGB: agg.totalInputGB,
    totalOutputGB: agg.totalOutputGB,
    sizeRatio: agg.sizeRatio,
    throughputMBps: agg.throughputMBps,
    perFileDurP50ms: agg.perFileDurMs.p50,
    perFileDurP95ms: agg.perFileDurMs.p95,
  });
}

fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  generatedBy: 'script/extract-png-baseline.mjs',
  runs: index,
}, null, 2));
console.log(`Wrote index of ${index.length} run(s).`);
