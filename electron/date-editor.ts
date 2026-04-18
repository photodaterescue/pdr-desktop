// Manual date editor — suggestion engine + apply pipeline.
//
// This module powers the "fix the date" workflow for Marked (low-confidence)
// photos. It produces ranked suggestions from the surrounding context
// (neighbour photos, sequential filenames, folder median, face co-appearances,
// GPS proximity) and, on apply, writes EXIF via exiftool, optionally renames
// the file using PDR's standard date-based template, updates the SQLite
// index, and writes to an append-only audit log so every manual edit is
// reversible.

import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import {
  getFileById,
  updateFileDate,
  getDateNeighbours,
  getSequentialFilenameNeighbours,
  getFolderMedianDate,
  getMedianDateForPersons,
  getMedianDateForGpsRadius,
  getFacesForFile,
} from './search-database.js';
import { writeExifDate } from './exif-writer.js';
import { getSettings } from './settings-store.js';

export interface DateSuggestion {
  /** Stable id so the UI can key on it. */
  id: string;
  /** Suggested ISO datetime (in local wallclock). */
  iso: string;
  /** Short label shown in the chip. */
  label: string;
  /** Longer explanation shown under the chip. */
  reason: string;
  /** "source of signal" badge — used for colour coding. */
  source: 'neighbour' | 'sequence' | 'folder' | 'faces' | 'gps' | 'filename';
  /** 0..1 ranked. Higher = more confident. */
  confidence: number;
}

function midpointIso(a: string, b: string): string {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return new Date(Math.round((ta + tb) / 2)).toISOString();
}

function formatLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Try to extract a datetime from a filename pattern like
 * 2005-03-02_11-33-42 or 20050302_113342. Returns null if no match.
 */
function extractDateFromFilename(filename: string): string | null {
  const patterns: RegExp[] = [
    // 2005-03-02_11-33-42 or 2005-03-02 11-33-42 or 2005-03-02T11:33:42
    /(\d{4})[-_]?(\d{2})[-_]?(\d{2})[ T_]?(\d{2})[-_:]?(\d{2})[-_:]?(\d{2})/,
    // 20050302_113342
    /(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/,
  ];
  for (const rx of patterns) {
    const m = filename.match(rx);
    if (m) {
      const [, yy, mo, dd, hh, mi, ss] = m.map((x) => parseInt(x, 10)) as unknown as number[];
      const d = new Date(yy, mo - 1, dd, hh, mi, ss);
      if (!isNaN(d.getTime()) && d.getFullYear() >= 1971 && d.getFullYear() <= new Date().getFullYear() + 1) {
        return d.toISOString();
      }
    }
  }
  return null;
}

export function getDateSuggestionsForFile(fileId: number): DateSuggestion[] {
  const file = getFileById(fileId);
  if (!file) return [];
  const out: DateSuggestion[] = [];

  // 1) Folder neighbours (Confirmed/Recovered before/after in time).
  const neigh = getDateNeighbours(fileId);
  if (neigh.before && neigh.after) {
    const iso = midpointIso(neigh.before.derived_date, neigh.after.derived_date);
    out.push({
      id: 'neighbour-between',
      iso,
      label: formatLocal(iso),
      reason: `Between ${neigh.before.filename} (${formatLocal(neigh.before.derived_date)}) and ${neigh.after.filename} (${formatLocal(neigh.after.derived_date)})`,
      source: 'neighbour',
      confidence: 0.95,
    });
  } else if (neigh.before) {
    out.push({
      id: 'neighbour-before',
      iso: neigh.before.derived_date,
      label: formatLocal(neigh.before.derived_date),
      reason: `Same folder as ${neigh.before.filename}`,
      source: 'neighbour',
      confidence: 0.6,
    });
  } else if (neigh.after) {
    out.push({
      id: 'neighbour-after',
      iso: neigh.after.derived_date,
      label: formatLocal(neigh.after.derived_date),
      reason: `Same folder as ${neigh.after.filename}`,
      source: 'neighbour',
      confidence: 0.6,
    });
  }

  // 2) Sequential filenames (MOV00920 → MOV00924 → MOV00927).
  const seq = getSequentialFilenameNeighbours(fileId);
  if (seq.before && seq.after && seq.selfSeqNum != null) {
    const t0 = new Date(seq.before.derived_date).getTime();
    const t1 = new Date(seq.after.derived_date).getTime();
    const frac = (seq.selfSeqNum - seq.before.seqNum) / Math.max(1, seq.after.seqNum - seq.before.seqNum);
    const iso = new Date(Math.round(t0 + (t1 - t0) * frac)).toISOString();
    out.push({
      id: 'sequence-interp',
      iso,
      label: formatLocal(iso),
      reason: `Filename #${seq.selfSeqNum} sits between #${seq.before.seqNum} (${formatLocal(seq.before.derived_date)}) and #${seq.after.seqNum} (${formatLocal(seq.after.derived_date)})`,
      source: 'sequence',
      confidence: 0.98,
    });
  }

  // 3) Date embedded directly in the filename (e.g. 2005-03-02_11-33-42).
  const fromFilename = extractDateFromFilename(file.filename) ?? extractDateFromFilename(file.original_filename || '');
  if (fromFilename) {
    out.push({
      id: 'filename-pattern',
      iso: fromFilename,
      label: formatLocal(fromFilename),
      reason: `Filename contains timestamp pattern`,
      source: 'filename',
      confidence: 0.9,
    });
  }

  // 4) Faces co-appearance — median date of other photos with the same named
  //    people (only named clusters, not speculative unnamed ones).
  try {
    const faces = getFacesForFile(fileId);
    const personIds = Array.from(new Set(faces.map((f: any) => f.person_id).filter((x: any) => x != null))) as number[];
    if (personIds.length > 0) {
      const median = getMedianDateForPersons(personIds);
      if (median) {
        out.push({
          id: 'faces-median',
          iso: median,
          label: formatLocal(median),
          reason: `Median date of other photos with the same ${personIds.length === 1 ? 'person' : 'people'}`,
          source: 'faces',
          confidence: 0.55,
        });
      }
    }
  } catch { /* face data may not exist */ }

  // 5) GPS — median date of photos within ~1km.
  if (file.gps_lat != null && file.gps_lon != null) {
    const median = getMedianDateForGpsRadius(file.gps_lat, file.gps_lon, 1);
    if (median) {
      out.push({
        id: 'gps-median',
        iso: median,
        label: formatLocal(median),
        reason: `Median date of Confirmed photos within ~1km`,
        source: 'gps',
        confidence: 0.7,
      });
    }
  }

  // 6) Folder median — weakest, but useful as a last fallback.
  const folderMedian = getFolderMedianDate(fileId);
  if (folderMedian) {
    out.push({
      id: 'folder-median',
      iso: folderMedian,
      label: formatLocal(folderMedian),
      reason: `Median date of Confirmed/Recovered photos in the same folder`,
      source: 'folder',
      confidence: 0.4,
    });
  }

  // Deduplicate suggestions that produced the same ISO (keep the highest
  // confidence one), then sort by confidence descending.
  const byIso = new Map<string, DateSuggestion>();
  for (const s of out) {
    const key = s.iso.substring(0, 16); // bucket by minute
    const existing = byIso.get(key);
    if (!existing || s.confidence > existing.confidence) byIso.set(key, s);
  }
  return Array.from(byIso.values()).sort((a, b) => b.confidence - a.confidence);
}

// ─── Apply pipeline ──────────────────────────────────────────────────────────

export interface ApplyDateOptions {
  fileIds: number[];
  /** ISO datetime to set — or a per-file map keyed by fileId. */
  date: string | Record<number, string>;
  /** Write EXIF tags via exiftool? */
  writeExif: boolean;
  /** Rename the file on disk using `<YYYY-MM-DD_HH-MM-SS>_CORR<ext>` pattern? */
  renameFile: boolean;
  /** Optional human-readable reason for the audit log. */
  reason?: string;
}

export interface ApplyDateResult {
  success: boolean;
  applied: Array<{
    fileId: number;
    oldPath: string;
    newPath: string;
    oldDate: string | null;
    newDate: string;
    exifWritten: boolean;
    renamed: boolean;
    error?: string;
  }>;
  errors: Array<{ fileId: number; error: string }>;
}

function fmtFilenameStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

const AUDIT_LOG = path.join(app.getPath('userData'), 'date-corrections.log.jsonl');

function appendAudit(entry: Record<string, any>) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true });
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.warn('[date-editor] audit log write failed:', (e as Error).message);
  }
}

export async function applyDateCorrection(opts: ApplyDateOptions): Promise<ApplyDateResult> {
  const result: ApplyDateResult = { success: true, applied: [], errors: [] };
  const settings = getSettings();

  for (const fileId of opts.fileIds) {
    const file = getFileById(fileId);
    if (!file) { result.errors.push({ fileId, error: 'File not found in index' }); continue; }
    if (!fs.existsSync(file.file_path)) { result.errors.push({ fileId, error: 'File missing on disk' }); continue; }

    const isoStr = typeof opts.date === 'string' ? opts.date : opts.date[fileId];
    if (!isoStr) { result.errors.push({ fileId, error: 'No date supplied' }); continue; }
    const date = new Date(isoStr);
    if (isNaN(date.getTime())) { result.errors.push({ fileId, error: 'Invalid date' }); continue; }

    let exifWritten = false;
    let exifError: string | undefined;
    if (opts.writeExif) {
      // Manual corrections should always write EXIF regardless of the
      // confidence-tier toggles, so we pass an override settings block.
      const write = await writeExifDate(file.file_path, date, 'confirmed', 'user-corrected', {
        writeExif: true,
        exifWriteConfirmed: true,
        exifWriteRecovered: true,
        exifWriteMarked: true,
      });
      exifWritten = write.written;
      if (!write.success) exifError = write.error;
    }

    // Optional rename — sits alongside the source with a new datestamped name.
    let newPath = file.file_path;
    let renamed = false;
    if (opts.renameFile) {
      try {
        const dir = path.dirname(file.file_path);
        const ext = path.extname(file.file_path);
        const base = `${fmtFilenameStamp(date)}_CORR${ext}`;
        let candidate = path.join(dir, base);
        // Avoid collisions: _CORR, _CORR_2, _CORR_3, ...
        let i = 2;
        while (fs.existsSync(candidate) && candidate !== file.file_path) {
          candidate = path.join(dir, `${fmtFilenameStamp(date)}_CORR_${i}${ext}`);
          i++;
        }
        if (candidate !== file.file_path) {
          fs.renameSync(file.file_path, candidate);
          newPath = candidate;
          renamed = true;
        }
      } catch (e) {
        result.errors.push({ fileId, error: 'Rename failed: ' + (e as Error).message });
      }
    }

    // Update the SQLite index with the new date + (possibly) new path.
    updateFileDate(fileId, date, 'corrected', 'user-corrected', renamed ? newPath : undefined);

    const record = {
      fileId,
      oldPath: file.file_path,
      newPath,
      oldDate: file.derived_date,
      newDate: date.toISOString(),
      exifWritten,
      renamed,
      ...(exifError ? { error: exifError } : {}),
    };
    result.applied.push(record);

    appendAudit({
      action: 'apply',
      reason: opts.reason || '',
      ...record,
    });
  }

  if (result.errors.length > 0) result.success = result.applied.length > 0;
  return result;
}

/** Read the last N audit entries (newest first). */
export function getRecentAuditEntries(limit = 20): any[] {
  try {
    if (!fs.existsSync(AUDIT_LOG)) return [];
    const lines = fs.readFileSync(AUDIT_LOG, 'utf8').trim().split('\n').filter(Boolean);
    const tail = lines.slice(-limit).reverse();
    return tail.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * Undo the most recent apply, reversing the on-disk rename (if any) and
 * restoring the previous DB state. Only the last `applied` record in the audit
 * log is undone — repeated calls step back one at a time.
 */
export async function undoLastDateCorrection(): Promise<{ success: boolean; undone?: any; error?: string }> {
  try {
    if (!fs.existsSync(AUDIT_LOG)) return { success: false, error: 'No audit log' };
    const lines = fs.readFileSync(AUDIT_LOG, 'utf8').trim().split('\n').filter(Boolean);
    // Walk backwards to find the last entry that hasn't been undone.
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: any;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      if (entry.action !== 'apply' || entry.undone) continue;
      const file = getFileById(entry.fileId);
      if (!file) return { success: false, error: 'File no longer in index' };

      // Revert rename if needed.
      if (entry.renamed && entry.newPath !== entry.oldPath) {
        try {
          if (fs.existsSync(entry.newPath) && !fs.existsSync(entry.oldPath)) {
            fs.renameSync(entry.newPath, entry.oldPath);
          }
        } catch (e) {
          return { success: false, error: 'Failed to undo rename: ' + (e as Error).message };
        }
      }

      // Restore previous date / confidence / date_source. We don't know what
      // the original confidence was with full fidelity, so we reset to
      // "marked" with date_source "undone" — the next index run will
      // re-derive properly.
      if (entry.oldDate) {
        updateFileDate(entry.fileId, new Date(entry.oldDate), 'marked', 'undone', entry.renamed ? entry.oldPath : undefined);
      }

      // Mark the audit line as undone by writing a new line that references it.
      appendAudit({ action: 'undo', undidIndex: i, fileId: entry.fileId });

      // Rewrite the original line with undone:true so it won't be undone again.
      lines[i] = JSON.stringify({ ...entry, undone: true });
      fs.writeFileSync(AUDIT_LOG, lines.join('\n') + '\n');

      return { success: true, undone: entry };
    }
    return { success: false, error: 'Nothing to undo' };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}
