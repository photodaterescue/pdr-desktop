/**
 * Cross-part Google Takeout sidecar cache — v2.0.13.
 *
 * Google's multi-part Takeout splits a photo and its JSON sidecar
 * across DIFFERENT zip files. Photo X may sit in takeout-007 while
 * its sidecar lives in takeout-008. PDR analyses one part at a time,
 * so a photo whose sidecar is in a different part loses its precise
 * date and falls back to filename-pattern noon (marked _RC) or
 * filesystem mtime (marked _MK).
 *
 * This module's job: walk every Takeout zip the user has registered,
 * pull out ONLY the *.json / *.supplemental-metadata.json entries
 * (no photo bytes — the zip's central directory tells us which
 * entries to read), parse each, and write the full sidecar payload
 * into `takeout_sidecars`. Runtime is bound by sidecar count
 * (~10 MB across 8 parts), not Takeout size (~400 GB across 8 parts).
 *
 * The analysis engine and the Enrichment pass both read this table
 * to find sidecars by photo basename, independent of which zip the
 * photo actually lives in.
 *
 * Trigger paths:
 *   - User adds a Takeout source → renderer detects the multi-part
 *     filename pattern and offers a banner that fires this scan.
 *   - LDM → Takeout metadata row → "Scan another Takeout part" runs
 *     this on a specific zip the user picks.
 *
 * Additive-only rule (Terry 2026-05-26): this module only inserts
 * sidecar rows. It never mutates indexed_files, album_files,
 * face_detections, or persons. The Enrichment pass — a separate
 * module — applies sidecar data to live rows with explicit
 * "never overwrite user curation" guards.
 */

import fs from 'fs';
import path from 'path';
import unzipper from 'unzipper';
import { getDb } from './search-database.js';
import { toLongPath } from './long-path.js';

// ─── Group-id detection ──────────────────────────────────────────────────────
//
// A Google Takeout export carries a shared timestamp prefix across
// all its parts. Filenames look like:
//   takeout-20260503T203552Z-3-001.zip
//   takeout-20260503T203552Z-3-002.zip
//   ...
//   takeout-20260503T203552Z-3-008.zip
//
// The group id is the "20260503T203552Z" portion — same across all
// parts of the same export, different across separate exports made
// on different days. Lets us mix multiple users' Takeouts safely
// without one export's sidecars masking another's.
//
// Older Takeouts may use "takeout-<timestamp>-<part>.zip" without
// the middle "-3-" segment; the regex accepts both shapes.

const TAKEOUT_NAME_RE =
  /^takeout-([0-9]{8}T[0-9]{6}Z)(?:-\d+)?-(\d+)\.zip$/i;

export function extractTakeoutGroupId(zipPath: string): string | null {
  const base = path.basename(zipPath);
  const m = TAKEOUT_NAME_RE.exec(base);
  return m ? m[1] : null;
}

export function looksLikeTakeoutZip(zipPath: string): boolean {
  return TAKEOUT_NAME_RE.test(path.basename(zipPath));
}

// ─── Sidecar JSON shape ──────────────────────────────────────────────────────
//
// Google's sidecars vary by export vintage, so every field is
// optional. We extract what's useful and stash the raw payload too
// so a future feature can read fields we didn't anticipate today.

interface TakeoutSidecarRecord {
  groupId: string;
  photoBasename: string;
  sourceZip: string;
  photoTakenUnix: number | null;
  creationUnix: number | null;
  gpsLat: number | null;
  gpsLon: number | null;
  description: string | null;
  googleOrigin: string | null;
  favorited: boolean;
  trashed: boolean;
  peopleJson: string | null;
  albumTitlesJson: string | null;
  rawJson: string;
}

// ─── JSON parsing ────────────────────────────────────────────────────────────

interface ParsedSidecar {
  photoTakenUnix: number | null;
  creationUnix: number | null;
  gpsLat: number | null;
  gpsLon: number | null;
  description: string | null;
  googleOrigin: string | null;
  favorited: boolean;
  trashed: boolean;
  peopleJson: string | null;
}

function parseSidecarJson(jsonText: string): ParsedSidecar | null {
  let stripped = jsonText;
  // Strip UTF-8 BOM if a Windows tool re-packaged the JSON.
  if (stripped.charCodeAt(0) === 0xfeff) stripped = stripped.slice(1);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    return null;
  }

  const readUnixSeconds = (v: unknown): number | null => {
    if (!v || typeof v !== 'object') return null;
    const ts = (v as { timestamp?: unknown }).timestamp;
    if (typeof ts === 'string') {
      const n = parseInt(ts, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) return ts;
    return null;
  };

  const readNumber = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return v;
    if (typeof v === 'string') {
      const n = parseFloat(v);
      if (Number.isFinite(n) && n !== 0) return n;
    }
    return null;
  };

  const readString = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;

  const geo = (data.geoData as Record<string, unknown> | undefined) ?? null;
  const geoExif = (data.geoDataExif as Record<string, unknown> | undefined) ?? null;
  // Prefer geoDataExif (the camera's GPS) over geoData (which Google
  // sometimes fills in from a manual location tag).
  const gpsLat = readNumber(geoExif?.latitude) ?? readNumber(geo?.latitude);
  const gpsLon = readNumber(geoExif?.longitude) ?? readNumber(geo?.longitude);

  const people =
    Array.isArray((data as { people?: unknown }).people) && (data.people as unknown[]).length > 0
      ? JSON.stringify(data.people)
      : null;

  return {
    photoTakenUnix: readUnixSeconds(data.photoTakenTime),
    creationUnix: readUnixSeconds(data.creationTime),
    gpsLat,
    gpsLon,
    description: readString(data.description),
    googleOrigin:
      readString((data.googlePhotosOrigin as Record<string, unknown> | undefined)?.fromAppType ?? null) ??
      readString((data as { googlePhotosOrigin?: unknown }).googlePhotosOrigin),
    favorited: (data as { favorited?: unknown }).favorited === true,
    trashed: (data as { trashed?: unknown }).trashed === true,
    peopleJson: people,
  };
}

// ─── Photo basename recovery ─────────────────────────────────────────────────
//
// Sidecar filenames follow predictable patterns, but Google truncates
// the photo portion when the combined name would exceed Windows'
// 47-character cap. Examples:
//
//   "IMG_1234.jpg.supplemental-metadata.json" → "IMG_1234.jpg"
//   "IMG_1234.jpg.json"                       → "IMG_1234.jpg"
//   "verylongphotoname.j.supplemental-metadata.json"  ← truncated
//
// For the truncated case the sidecar's own `title` field carries the
// full photo filename — that's our fallback when the prefix strip
// produces a name that doesn't look like a photo.

const SIDECAR_SUFFIXES = [
  '.supplemental-metadata.json',
  '.supplemental-metadata.j',
  '.json',
];

const PHOTO_EXT_RE = /\.(jpe?g|png|gif|bmp|tiff?|webp|heic|heif|gif|avif|mp4|mov|m4v|3gp|avi|mkv|webm|wmv|flv|mpg|mpeg)$/i;

function deriveBasename(sidecarEntryName: string, parsedTitle: string | null): string | null {
  const base = path.basename(sidecarEntryName);
  for (const suffix of SIDECAR_SUFFIXES) {
    if (base.toLowerCase().endsWith(suffix)) {
      const candidate = base.slice(0, base.length - suffix.length);
      if (PHOTO_EXT_RE.test(candidate)) return candidate;
      break;
    }
  }
  // Truncated case — fall back to the sidecar's `title` field.
  if (parsedTitle && PHOTO_EXT_RE.test(parsedTitle)) return parsedTitle;
  return null;
}

// ─── Per-zip walker ──────────────────────────────────────────────────────────

export interface SidecarScanProgress {
  zipPath: string;
  zipIndex: number;
  zipCount: number;
  scanned: number;
  inserted: number;
}

export interface SidecarScanResult {
  zipPath: string;
  groupId: string | null;
  sidecarsSeen: number;
  sidecarsInserted: number;
  errors: number;
  elapsedMs: number;
}

export async function scanSidecarsFromZip(
  zipPath: string,
  onProgress?: (scanned: number, inserted: number) => void,
): Promise<SidecarScanResult> {
  const startedAt = Date.now();
  const groupId = extractTakeoutGroupId(zipPath);
  const result: SidecarScanResult = {
    zipPath,
    groupId,
    sidecarsSeen: 0,
    sidecarsInserted: 0,
    errors: 0,
    elapsedMs: 0,
  };

  if (!groupId) {
    // Not a recognisable Takeout filename — skip rather than reject.
    // The renderer should be filtering these out, but defensively
    // tolerate non-Takeout zips dropped in by mistake.
    result.elapsedMs = Date.now() - startedAt;
    return result;
  }
  if (!fs.existsSync(zipPath)) {
    result.elapsedMs = Date.now() - startedAt;
    return result;
  }

  // v2.0.13 fix (Terry 2026-05-26): switched from adm-zip to unzipper.
  // adm-zip reads the entire archive into a Node Buffer at open time,
  // which fails hard on Buffer's 2 GiB cap — useless for Takeouts that
  // are 50 GB per part. unzipper streams the central directory only
  // and pulls per-entry contents on demand via .buffer() / .stream(),
  // so it handles a 50 GB zip the same as a 5 MB one. The same library
  // is already used by analysis-engine.ts and extract-worker.ts for
  // the existing big-Takeout extraction path.
  let directory: { files: Array<{ path: string; type: string; buffer: () => Promise<Buffer> }> };
  try {
    directory = await unzipper.Open.file(toLongPath(zipPath)) as { files: Array<{ path: string; type: string; buffer: () => Promise<Buffer> }> };
  } catch (e) {
    console.warn(`[TakeoutSidecar] failed to open zip ${zipPath}:`, (e as Error).message);
    result.errors++;
    result.elapsedMs = Date.now() - startedAt;
    return result;
  }

  const entries = directory.files;
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO takeout_sidecars (
      takeout_group_id, photo_basename, source_zip,
      photo_taken_unix, creation_unix,
      gps_lat, gps_lon,
      description, google_origin,
      favorited, trashed,
      people_json, album_titles_json,
      raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const isSidecarEntry = (name: string): boolean => {
    const lower = name.toLowerCase();
    return (
      lower.endsWith('.supplemental-metadata.json') ||
      lower.endsWith('.supplemental-metadata.j') ||
      (lower.endsWith('.json') && !lower.endsWith('metadata.json') === false)
    ) || lower.endsWith('.json');
  };

  // Batched insertion under one transaction = a few orders of
  // magnitude faster than per-row commits. Yield to the event loop
  // every BATCH entries so the main process stays responsive.
  const BATCH = 200;
  let batch: TakeoutSidecarRecord[] = [];
  const flushBatch = () => {
    if (batch.length === 0) return;
    const tx = db.transaction((rows: TakeoutSidecarRecord[]) => {
      for (const row of rows) {
        try {
          const r = insert.run(
            row.groupId,
            row.photoBasename,
            row.sourceZip,
            row.photoTakenUnix,
            row.creationUnix,
            row.gpsLat,
            row.gpsLon,
            row.description,
            row.googleOrigin,
            row.favorited ? 1 : 0,
            row.trashed ? 1 : 0,
            row.peopleJson,
            row.albumTitlesJson,
            row.rawJson,
          );
          if (r.changes > 0) result.sidecarsInserted++;
        } catch (e) {
          result.errors++;
          console.warn(
            `[TakeoutSidecar] insert failed for ${row.photoBasename}:`,
            (e as Error).message,
          );
        }
      }
    });
    tx(batch);
    batch = [];
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === 'Directory') continue;
    if (!isSidecarEntry(entry.path)) continue;
    result.sidecarsSeen++;

    // Reject the album-level metadata.json files — they describe
    // FOLDER (album) metadata, not per-photo sidecars. The existing
    // takeout-album-importer handles those.
    const lowerName = path.basename(entry.path).toLowerCase();
    if (lowerName === 'metadata.json' || lowerName === 'shared_album_comments.json' || lowerName === 'print-subscriptions.json' || lowerName === 'user-generated-memory-titles.json') {
      continue;
    }

    let content: string;
    try {
      const buf = await entry.buffer();
      content = buf.toString('utf-8');
    } catch (e) {
      result.errors++;
      continue;
    }

    const parsed = parseSidecarJson(content);
    if (!parsed) {
      result.errors++;
      continue;
    }

    // Extract title from the raw JSON for the truncated-name
    // fallback. parseSidecarJson didn't capture this because it's
    // only needed here.
    let titleHint: string | null = null;
    try {
      const data = JSON.parse(content.replace(/^﻿/, '')) as { title?: unknown };
      if (typeof data.title === 'string') titleHint = data.title;
    } catch { /* ignore — parsed succeeded, this is best-effort */ }

    const basename = deriveBasename(entry.path, titleHint);
    if (!basename) {
      // Genuinely couldn't tell which photo this sidecar belongs to.
      // Logged but not counted as an error — the JSON parsed fine,
      // the filename just wasn't decodable.
      continue;
    }

    batch.push({
      groupId,
      photoBasename: basename,
      sourceZip: path.basename(zipPath),
      photoTakenUnix: parsed.photoTakenUnix,
      creationUnix: parsed.creationUnix,
      gpsLat: parsed.gpsLat,
      gpsLon: parsed.gpsLon,
      description: parsed.description,
      googleOrigin: parsed.googleOrigin,
      favorited: parsed.favorited,
      trashed: parsed.trashed,
      peopleJson: parsed.peopleJson,
      albumTitlesJson: null, // album-folder context not available from a flat zip walk; the takeout-album-importer fills this separately
      rawJson: content,
    });

    if (batch.length >= BATCH) {
      flushBatch();
      onProgress?.(result.sidecarsSeen, result.sidecarsInserted);
      // Yield so the splash / Enriching pill stays smooth.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  flushBatch();
  onProgress?.(result.sidecarsSeen, result.sidecarsInserted);
  result.elapsedMs = Date.now() - startedAt;
  return result;
}

// ─── Multi-zip driver ────────────────────────────────────────────────────────

export interface SidecarScanSummary {
  zips: SidecarScanResult[];
  totalSeen: number;
  totalInserted: number;
  totalErrors: number;
  totalElapsedMs: number;
}

export async function scanSidecarsFromZips(
  zipPaths: string[],
  onZipProgress?: (progress: SidecarScanProgress) => void,
): Promise<SidecarScanSummary> {
  const summary: SidecarScanSummary = {
    zips: [],
    totalSeen: 0,
    totalInserted: 0,
    totalErrors: 0,
    totalElapsedMs: 0,
  };
  const runStart = Date.now();
  for (let i = 0; i < zipPaths.length; i++) {
    const zipPath = zipPaths[i];
    const r = await scanSidecarsFromZip(zipPath, (scanned, inserted) => {
      onZipProgress?.({
        zipPath,
        zipIndex: i,
        zipCount: zipPaths.length,
        scanned,
        inserted,
      });
    });
    summary.zips.push(r);
    summary.totalSeen += r.sidecarsSeen;
    summary.totalInserted += r.sidecarsInserted;
    summary.totalErrors += r.errors;
  }
  summary.totalElapsedMs = Date.now() - runStart;
  return summary;
}

// ─── Lookup API for the analysis pipeline ────────────────────────────────────
//
// analysis-engine.ts calls this BEFORE its filename-pattern fallback.
// Returns the best photoTakenTime found across any Takeout group for
// the given photo basename. NULL means "no sidecar evidence anywhere
// in the cache" — analysis carries on with its existing rules.

export interface SidecarLookupResult {
  photoTakenUnix: number | null;
  creationUnix: number | null;
  gpsLat: number | null;
  gpsLon: number | null;
  description: string | null;
  googleOrigin: string | null;
  peopleJson: string | null;
  sourceZip: string;
  takeoutGroupId: string;
}

export function lookupSidecarByBasename(photoBasename: string): SidecarLookupResult | null {
  const db = getDb();
  // Prefer rows that actually carry a photoTakenTime — if multiple
  // sidecars across groups reference the same basename (rare but
  // possible if the user has multiple Takeouts of overlapping photos),
  // take the most recently scanned one with a usable date.
  const row = db.prepare(`
    SELECT
      photo_taken_unix, creation_unix,
      gps_lat, gps_lon,
      description, google_origin,
      people_json,
      source_zip, takeout_group_id
    FROM takeout_sidecars
    WHERE photo_basename = ?
    ORDER BY
      CASE WHEN photo_taken_unix IS NOT NULL THEN 0 ELSE 1 END,
      scanned_at DESC
    LIMIT 1
  `).get(photoBasename) as
    | {
        photo_taken_unix: number | null;
        creation_unix: number | null;
        gps_lat: number | null;
        gps_lon: number | null;
        description: string | null;
        google_origin: string | null;
        people_json: string | null;
        source_zip: string;
        takeout_group_id: string;
      }
    | undefined;
  if (!row) return null;
  return {
    photoTakenUnix: row.photo_taken_unix,
    creationUnix: row.creation_unix,
    gpsLat: row.gps_lat,
    gpsLon: row.gps_lon,
    description: row.description,
    googleOrigin: row.google_origin,
    peopleJson: row.people_json,
    sourceZip: row.source_zip,
    takeoutGroupId: row.takeout_group_id,
  };
}

/**
 * v2.0.14 — snapshot the basename → minimal-payload sidecar map for the
 * analysis worker. Used at orchestrator entry so the worker (which
 * can't open SQLite) gets a structured-clone-safe lookup table in its
 * 'start' message. Same tie-break rule as lookupSidecarByBasename
 * (prefer rows with photo_taken_unix, most recently scanned wins).
 *
 * Keeps payload minimal: just photoTakenUnix + sourceZip — the only
 * fields analysis-engine reads. Other sidecar fields (gps, description,
 * peopleJson) are written elsewhere by Enrichment, not by analysis.
 */
export function snapshotSidecarMapForWorker(): Record<string, { photoTakenUnix: number | null; sourceZip: string }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT photo_basename, photo_taken_unix, source_zip
    FROM (
      SELECT photo_basename, photo_taken_unix, source_zip,
             ROW_NUMBER() OVER (
               PARTITION BY photo_basename
               ORDER BY CASE WHEN photo_taken_unix IS NOT NULL THEN 0 ELSE 1 END,
                        scanned_at DESC
             ) AS rn
      FROM takeout_sidecars
    )
    WHERE rn = 1
  `).all() as Array<{ photo_basename: string; photo_taken_unix: number | null; source_zip: string }>;
  const out: Record<string, { photoTakenUnix: number | null; sourceZip: string }> = {};
  for (const r of rows) {
    out[r.photo_basename] = { photoTakenUnix: r.photo_taken_unix, sourceZip: r.source_zip };
  }
  return out;
}

// ─── LDM summary API ─────────────────────────────────────────────────────────
//
// The Library Drive Manager's Takeout-metadata row needs to show
// "X sidecars scanned across Y zips, last scanned <date>." This is
// what powers that.

export interface SidecarSummary {
  totalSidecars: number;
  groups: Array<{
    groupId: string;
    sidecarCount: number;
    zipCount: number;
    lastScannedAt: string;
  }>;
}

export function getSidecarSummary(): SidecarSummary {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      takeout_group_id AS groupId,
      COUNT(*)         AS sidecarCount,
      COUNT(DISTINCT source_zip) AS zipCount,
      MAX(scanned_at)  AS lastScannedAt
    FROM takeout_sidecars
    GROUP BY takeout_group_id
    ORDER BY MAX(scanned_at) DESC
  `).all() as Array<{
    groupId: string;
    sidecarCount: number;
    zipCount: number;
    lastScannedAt: string;
  }>;
  const totalSidecars = rows.reduce((sum, r) => sum + r.sidecarCount, 0);
  return { totalSidecars, groups: rows };
}
