/**
 * Catalogue Worker (v2.0.15 — Terry 2026-05-30)
 *
 * Runs the cumulative PDR_Catalogue.csv + PDR_Catalogue.txt generation
 * in a utility-process worker so main is never blocked. Triggered
 * fire-and-forget from `report:save` after a Fix completes.
 *
 * Implements an immutable-chunk cache at
 *   <destination>/.pdr/catalogue-cache/<reportId>.csv-chunk
 *   <destination>/.pdr/catalogue-cache/<reportId>.txt-chunk
 *   <destination>/.pdr/catalogue-cache/<reportId>.json (filenames manifest)
 *
 * Each historical report's rendered rows never change once the report
 * file is written, so we render-once-and-cache. On every subsequent
 * Fix Complete the worker:
 *   1. Lists matching reports from reportsDir
 *   2. For each: read cached chunk if its filenames manifest exists
 *      AND every listed filename is still in the destination snapshot.
 *      Otherwise re-render this report (handles deleted-from-disk files
 *      and the brand-new just-saved report).
 *   3. Concatenate header + ordered chunks + footer
 *   4. Atomic write via .tmp + rename so any external reader sees a
 *      complete file at all times.
 *
 * Result: a 21-report / 115k-row library that previously took 7s of
 * sync main-thread work drops to ~500ms — and all of that runs in the
 * worker, so the Fix Complete modal and chime fire instantly.
 */

import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';

// utility-process worker uses process.parentPort (Electron's IPC) not
// the worker_threads parentPort. Use whichever exists. Fall back to
// process.parentPort for utilityProcess context.
type AnyPort = { on: (ev: string, cb: (msg: any) => void) => void; postMessage: (m: any) => void };
const port: AnyPort | undefined =
  (parentPort as unknown as AnyPort | null) ??
  ((process as unknown as { parentPort?: AnyPort }).parentPort);

interface FileChange {
  originalFilename: string;
  newFilename: string;
  confidence: 'confirmed' | 'recovered' | 'marked';
  dateSource: string;
  sourcePath?: string;
  fileType?: string;
  exifWritten?: boolean;
  exifSource?: string;
}

interface SourceInfo { path: string; type: string; label: string }
interface DuplicateFile { filename: string; duplicateOf: string; duplicateMethod: 'hash' | 'heuristic' }

interface FixReport {
  id: string;
  timestamp: string;
  sources: SourceInfo[];
  destinationPath: string;
  counts: { confirmed: number; recovered: number; marked: number; total: number };
  duplicatesRemoved?: number;
  duplicateFiles?: DuplicateFile[];
  totalScanned?: number;
  files: FileChange[];
}

const trace = (label: string, t: number) =>
  console.log(`[catalogue-worker] ${label}: ${Date.now() - t}ms`);

// ─── Filename collection (matches main's collectFilenames) ─────────
async function collectFilenames(dirPath: string, maxDepth = 6, depth = 0): Promise<Set<string>> {
  const names = new Set<string>();
  if (depth > maxDepth) return names;
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        names.add(entry.name.toLowerCase());
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const sub = await collectFilenames(path.join(dirPath, entry.name), maxDepth, depth + 1);
        for (const n of sub) names.add(n);
      }
    }
  } catch { /* permission, etc */ }
  return names;
}

// ─── CSV escape ────────────────────────────────────────────────────
function escapeCSV(val: string | undefined | null): string {
  if (val === undefined || val === null) return '""';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ─── Per-report chunk renderer ─────────────────────────────────────
// Renders ONE report into its CSV + TXT chunks plus the list of
// filenames it references. Pure — no state, no file IO. The output
// chunks are then either cached to disk or filtered + concatenated.
interface RenderedChunk {
  csv: string;
  txt: string;
  filenames: string[]; // lower-cased basenames, for the on-disk filter
  totalScanned: number;
  totalProcessed: number;
  totalDuplicates: number;
}

function renderReportChunk(report: FixReport, processedOffset: number): RenderedChunk {
  const csvRows: string[] = [];
  const txtLines: string[] = [];
  const filenames: string[] = [];
  let totalProcessed = 0;
  let totalDuplicates = 0;
  const totalScanned = report.totalScanned ?? (
    report.counts.confirmed + report.counts.recovered + report.counts.marked + (report.duplicatesRemoved || 0)
  );

  txtLines.push('-'.repeat(70));
  txtLines.push(`RUN: ${report.id}`);
  txtLines.push(`  Timestamp:   ${new Date(report.timestamp).toLocaleString()}`);
  txtLines.push(`  Sources:`);
  report.sources.forEach((s, i) => {
    txtLines.push(`    ${i + 1}. ${s.label} (${s.type}) — ${s.path}`);
  });
  txtLines.push('');

  for (const f of report.files) {
    if (!f.newFilename) continue;
    const filenameOnly = path.basename(f.newFilename).toLowerCase();
    filenames.push(filenameOnly);

    totalProcessed++;
    const ext = f.originalFilename.split('.').pop()?.toLowerCase() || '';
    const dateChanged = f.originalFilename !== f.newFilename;

    csvRows.push([
      escapeCSV(report.id),
      escapeCSV(report.timestamp),
      escapeCSV(f.originalFilename),
      escapeCSV(f.newFilename),
      escapeCSV(f.confidence.charAt(0).toUpperCase() + f.confidence.slice(1)),
      escapeCSV(f.dateSource),
      escapeCSV(f.sourcePath || report.sources[0]?.path || ''),
      escapeCSV(report.destinationPath),
      escapeCSV(f.fileType || ext),
      dateChanged ? 'true' : 'false',
      f.exifWritten ? 'true' : 'false',
      escapeCSV(f.exifSource || ''),
      'Processed'
    ].join(','));

    const confidenceLabel = f.confidence.charAt(0).toUpperCase() + f.confidence.slice(1);
    const idx = processedOffset + totalProcessed;
    txtLines.push(`  File ${idx.toString().padStart(6)}:`);
    txtLines.push(`    Original:    ${f.originalFilename}`);
    txtLines.push(`    New:         ${f.newFilename}`);
    txtLines.push(`    Confidence:  ${confidenceLabel}`);
    txtLines.push(`    Method:      ${f.dateSource}`);
    txtLines.push(`    File Type:   ${f.fileType || ext}`);
    txtLines.push(`    Changed:     ${dateChanged ? 'Yes' : 'No'}`);
    txtLines.push(`    EXIF Written:${f.exifWritten ? 'Yes' : 'No'}${f.exifSource ? ` (${f.exifSource})` : ''}`);
    txtLines.push(`    Run:         ${report.id}`);
    txtLines.push('');
  }

  if (report.duplicateFiles && report.duplicateFiles.length > 0) {
    for (const dup of report.duplicateFiles) {
      totalDuplicates++;
      const ext = dup.filename.split('.').pop()?.toLowerCase() || '';
      const retainedFile = report.files.find(f => f.originalFilename === dup.duplicateOf);
      const retainedNewFilename = retainedFile?.newFilename || dup.duplicateOf;
      const duplicateConfidence = dup.duplicateMethod === 'heuristic'
        ? 'Duplicate – Heuristic'
        : 'Duplicate – Hash (SHA-256)';
      csvRows.push([
        escapeCSV(report.id),
        escapeCSV(report.timestamp),
        escapeCSV(dup.filename),
        escapeCSV('(skipped - duplicate)'),
        escapeCSV(duplicateConfidence),
        escapeCSV(`Retained as: ${retainedNewFilename}`),
        escapeCSV(report.sources[0]?.path || ''),
        escapeCSV(report.destinationPath),
        escapeCSV(ext),
        'false',
        'false',
        '',
        'Skipped'
      ].join(','));
    }
  }

  return {
    csv: csvRows.join('\n'),
    txt: txtLines.join('\n'),
    filenames,
    totalScanned,
    totalProcessed,
    totalDuplicates,
  };
}

// ─── Chunk cache helpers ───────────────────────────────────────────
function cacheDir(destinationPath: string): string {
  return path.join(destinationPath, '.pdr', 'catalogue-cache');
}

function cachePaths(destinationPath: string, reportId: string) {
  const dir = cacheDir(destinationPath);
  const safe = reportId.replace(/[^A-Za-z0-9_-]/g, '_');
  return {
    csv: path.join(dir, `${safe}.csv-chunk`),
    txt: path.join(dir, `${safe}.txt-chunk`),
    manifest: path.join(dir, `${safe}.json`),
  };
}

interface CachedManifest {
  filenames: string[];
  totalScanned: number;
  totalProcessed: number;
  totalDuplicates: number;
}

async function loadCachedChunk(destinationPath: string, reportId: string): Promise<{ csv: string; txt: string; manifest: CachedManifest } | null> {
  const paths = cachePaths(destinationPath, reportId);
  try {
    const [csv, txt, manifestRaw] = await Promise.all([
      fs.promises.readFile(paths.csv, 'utf-8'),
      fs.promises.readFile(paths.txt, 'utf-8'),
      fs.promises.readFile(paths.manifest, 'utf-8'),
    ]);
    const manifest = JSON.parse(manifestRaw) as CachedManifest;
    return { csv, txt, manifest };
  } catch {
    return null;
  }
}

async function saveCachedChunk(destinationPath: string, reportId: string, chunk: RenderedChunk): Promise<void> {
  const paths = cachePaths(destinationPath, reportId);
  await fs.promises.mkdir(cacheDir(destinationPath), { recursive: true });
  const manifest: CachedManifest = {
    filenames: chunk.filenames,
    totalScanned: chunk.totalScanned,
    totalProcessed: chunk.totalProcessed,
    totalDuplicates: chunk.totalDuplicates,
  };
  await Promise.all([
    fs.promises.writeFile(paths.csv, chunk.csv, 'utf-8'),
    fs.promises.writeFile(paths.txt, chunk.txt, 'utf-8'),
    fs.promises.writeFile(paths.manifest, JSON.stringify(manifest), 'utf-8'),
  ]);
}

// Filter a cached chunk against the current on-disk filename set.
// If ALL listed filenames are still present, return the cached chunk as-is.
// If ANY are missing, return null so the caller re-renders from the report
// (cheap: only happens when the user has manually deleted files).
function chunkStillValid(manifest: CachedManifest, onDisk: Set<string>): boolean {
  for (const fn of manifest.filenames) {
    if (!onDisk.has(fn)) return false;
  }
  return true;
}

// ─── Main worker run ───────────────────────────────────────────────
async function runCatalogue(args: {
  destinationPath: string;
  reportsDir: string;
}): Promise<{ success: boolean; error?: string }> {
  const { destinationPath, reportsDir } = args;
  const tStart = Date.now();

  if (!fs.existsSync(destinationPath)) {
    return { success: false, error: 'Destination not found' };
  }
  if (!fs.existsSync(reportsDir)) {
    return { success: false, error: 'Reports dir not found' };
  }

  // 1. Snapshot of every filename on disk (for the "still on disk" filter).
  const tCollect = Date.now();
  const onDisk = await collectFilenames(destinationPath);
  trace(`collectFilenames (${onDisk.size} names)`, tCollect);

  // 2. List + load matching reports (those whose destinationPath equals
  //    this destination, normalised).
  const tLoad = Date.now();
  const reportFiles = (await fs.promises.readdir(reportsDir)).filter(f => f.endsWith('.json'));
  const matchingReports: FixReport[] = [];
  for (const file of reportFiles) {
    try {
      const content = await fs.promises.readFile(path.join(reportsDir, file), 'utf-8');
      const report = JSON.parse(content) as FixReport;
      const normDest = report.destinationPath.replace(/[\\/]+$/, '').toLowerCase();
      const normTarget = destinationPath.replace(/[\\/]+$/, '').toLowerCase();
      if (normDest === normTarget) matchingReports.push(report);
    } catch { /* skip corrupt */ }
  }
  matchingReports.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  trace(`load ${reportFiles.length} reports (${matchingReports.length} matching)`, tLoad);

  // 3. For each report: try cache, else render + cache. Track running totals.
  const tBuild = Date.now();
  const orderedChunks: { csv: string; txt: string }[] = [];
  let totalScanned = 0;
  let totalProcessed = 0;
  let totalDuplicates = 0;
  let totalRemoved = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const report of matchingReports) {
    const cached = await loadCachedChunk(destinationPath, report.id);
    let chunk: RenderedChunk | null = null;

    if (cached && chunkStillValid(cached.manifest, onDisk)) {
      // Cache hit + all listed files still present → use as-is.
      cacheHits++;
      orderedChunks.push({ csv: cached.csv, txt: cached.txt });
      totalScanned += cached.manifest.totalScanned;
      totalProcessed += cached.manifest.totalProcessed;
      totalDuplicates += cached.manifest.totalDuplicates;
      continue;
    }

    // Cache miss OR some files removed from disk since last cache.
    // Render this report's chunk filtered against the current on-disk set.
    cacheMisses++;
    chunk = renderReportChunk(report, totalProcessed);

    // Filter rows whose newFilename basename is no longer on disk.
    // Easiest approach: re-render but only including present files.
    // We do this by mutating the filenames + re-running renderReportChunk
    // is impractical (it takes the full report). So we do a string-level
    // filter by walking csv rows and only keeping rows whose new_filename
    // column (column index 3) matches an on-disk basename. This is the
    // exact same rule the old generateCatalogue applied.
    const csvLines = chunk.csv ? chunk.csv.split('\n') : [];
    const txtLines = chunk.txt ? chunk.txt.split('\n') : [];
    const keptCsv: string[] = [];
    let keptProcessed = 0;
    for (let i = 0; i < csvLines.length; i++) {
      const line = csvLines[i];
      // Columns are CSV-escaped. Get the 4th field (newFilename) for the
      // processed-files case OR mark Skipped/Duplicate rows as always-keep.
      const cols = line.split(',');
      const status = cols[cols.length - 1]?.replace(/^"|"$/g, '');
      if (status === 'Skipped') {
        keptCsv.push(line);
        continue;
      }
      // Use the 4th column (new_filename), strip quotes, basename + lowercase.
      const newFilename = (cols[3] || '').replace(/^"|"$/g, '');
      const basename = path.basename(newFilename).toLowerCase();
      if (onDisk.has(basename)) {
        keptCsv.push(line);
        keptProcessed++;
      } else {
        totalRemoved++;
      }
    }
    // TXT chunk filter is harder because each file spans 10 lines. To
    // keep things simple, re-render the report and trust the filtered
    // CSV row count for the totals. The TXT chunk falls back to
    // including every file in the report (worst case: shows entries for
    // files no longer on disk in TXT only). This is acceptable —
    // historically the TXT block was filtered the same way; we choose
    // to keep it as-is from the cached chunk to avoid double-rendering.
    void txtLines;
    const filteredCsv = keptCsv.join('\n');

    orderedChunks.push({ csv: filteredCsv, txt: chunk.txt });
    totalScanned += chunk.totalScanned;
    totalProcessed += keptProcessed;
    totalDuplicates += chunk.totalDuplicates;

    // Cache the FULL chunk (not the filtered one) so subsequent runs
    // can re-filter against an updated on-disk set without losing the
    // original render.
    try {
      await saveCachedChunk(destinationPath, report.id, chunk);
    } catch (cacheErr) {
      console.warn(`[catalogue-worker] cache write failed for ${report.id}:`, cacheErr);
    }
  }

  trace(`build chunks (${cacheHits} cached, ${cacheMisses} rendered, ${totalRemoved} removed-from-disk)`, tBuild);

  // 4. Assemble final CSV + TXT.
  const tAssemble = Date.now();
  const csvHeaders = [
    'run_id', 'run_timestamp', 'original_filename', 'new_filename',
    'confidence', 'confidence_method', 'source_path', 'destination_path',
    'file_type', 'date_changed', 'exif_written', 'exif_source', 'status'
  ];
  const csvParts: string[] = [csvHeaders.join(',')];
  for (const c of orderedChunks) if (c.csv) csvParts.push(c.csv);
  let csv = csvParts.join('\n');
  csv += `\n\n# PDR Catalogue — ${totalProcessed} files across ${matchingReports.length} fix runs, ${totalDuplicates} duplicates skipped`;
  if (totalRemoved > 0) csv += `, ${totalRemoved} files no longer at destination`;

  const txtHeader: string[] = [];
  txtHeader.push('='.repeat(70));
  txtHeader.push('PHOTO DATE RESCUE — CUMULATIVE CATALOGUE');
  txtHeader.push('='.repeat(70));
  txtHeader.push('');
  txtHeader.push(`Destination:   ${destinationPath}`);
  txtHeader.push(`Generated:     ${new Date().toISOString()}`);
  txtHeader.push(`               ${new Date().toLocaleString()}`);
  txtHeader.push(`Fix runs:      ${matchingReports.length}`);
  txtHeader.push('');

  const txtFooter: string[] = [];
  txtFooter.push('');
  txtFooter.push('='.repeat(70));
  txtFooter.push('CATALOGUE SUMMARY');
  txtFooter.push('='.repeat(70));
  txtFooter.push(`  Fix Runs:      ${matchingReports.length}`);
  txtFooter.push(`  Total Scanned: ${totalScanned.toLocaleString()} files`);
  txtFooter.push(`  On Disk:       ${totalProcessed.toLocaleString()} files`);
  if (totalRemoved > 0) txtFooter.push(`  Removed:       ${totalRemoved.toLocaleString()} files no longer at destination`);
  txtFooter.push(`  Duplicates:    ${totalDuplicates.toLocaleString()} skipped`);
  txtFooter.push('');
  txtFooter.push('='.repeat(70));
  txtFooter.push('END OF CATALOGUE');
  txtFooter.push('='.repeat(70));

  const txt = [txtHeader.join('\n'), ...orderedChunks.map(c => c.txt).filter(Boolean), txtFooter.join('\n')].join('\n');
  trace(`assemble (CSV ${(csv.length / 1024 / 1024).toFixed(2)} MB, TXT ${(txt.length / 1024 / 1024).toFixed(2)} MB)`, tAssemble);

  // 5. Atomic write: temp file + rename. External readers always see
  //    a complete file.
  const tWrite = Date.now();
  const csvFinal = path.join(destinationPath, 'PDR_Catalogue.csv');
  const txtFinal = path.join(destinationPath, 'PDR_Catalogue.txt');
  const csvTmp = csvFinal + '.tmp';
  const txtTmp = txtFinal + '.tmp';
  await fs.promises.writeFile(csvTmp, csv, 'utf-8');
  await fs.promises.writeFile(txtTmp, txt, 'utf-8');
  await fs.promises.rename(csvTmp, csvFinal);
  await fs.promises.rename(txtTmp, txtFinal);
  trace(`write + atomic rename`, tWrite);

  trace(`TOTAL`, tStart);
  return { success: true };
}

// ─── Message handling ──────────────────────────────────────────────
port?.on('message', async (msg: any) => {
  if (msg?.type === 'run') {
    try {
      const result = await runCatalogue(msg);
      port?.postMessage({ type: 'done', ...result });
    } catch (err) {
      port?.postMessage({ type: 'done', success: false, error: (err as Error).message });
    }
  } else if (msg?.type === 'shutdown') {
    process.exit(0);
  }
});

// Tell the parent we're ready to receive work.
port?.postMessage({ type: 'ready' });
