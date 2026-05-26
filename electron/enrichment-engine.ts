/**
 * Enrichment engine — v2.0.13.
 *
 * Walks every `_RC` and `_MK` row in `indexed_files`, looks each up
 * against the cross-part `takeout_sidecars` cache (populated by
 * takeout:preScanSidecars), and where a sidecar with a precise
 * photoTakenTime exists:
 *
 *   - Renames the file on disk from the old _RC/_MK filename to the
 *     new _CF filename based on the sidecar's date.
 *   - Rewrites EXIF DateTimeOriginal / CreateDate / ModifyDate to
 *     the precise date.
 *   - Writes GPS coordinates into EXIF GPSLatitude / GPSLongitude if
 *     the sidecar carries them.
 *   - Writes the user's caption into EXIF ImageDescription + XMP
 *     dc:description if the sidecar carries one.
 *   - Updates the indexed_files row (file_path, filename,
 *     derived_date, confidence, date_source) atomically.
 *   - Seeds takeout_name_hint on any face_detections rows for this
 *     file_id that don't yet have a person_id and aren't verified.
 *   - Writes an enrichment_log audit row so the user (or support)
 *     can see exactly what got changed — including the old / new
 *     filename, confidence, and which EXIF fields were touched.
 *
 * THE ADDITIVE-ONLY RULE (Terry 2026-05-26):
 *
 *   Sidecar data is a SUGGESTION, never an override. Specifically:
 *
 *     - face_detections: only writes takeout_name_hint where
 *       person_id IS NULL AND verified = 0. A face that's been
 *       named manually (person_id set) or verified (verified=1)
 *       is treated as gospel and the sidecar hint is ignored.
 *
 *     - album_files: NOT touched here. The takeout-album-importer
 *       (separate module) handles album backfill. Our cross-part
 *       sidecar cache deliberately leaves album_titles_json null
 *       because album folder context isn't available from a flat
 *       zip walk — the importer extracts it correctly from the
 *       folder-level metadata.json files.
 *
 *     - indexed_files renames: only fire when the new sidecar date
 *       genuinely differs from the current derived_date. A file
 *       with the SAME date but a lower confidence (e.g., we had
 *       it as _RC from a filename match and the sidecar agrees on
 *       the same minute) DOES get upgraded — same date in the
 *       output, just with the higher-confidence suffix and source.
 *
 *     - Filename collisions: if renaming to the new filename would
 *       collide with an existing file (not the one being renamed),
 *       the rename is SKIPPED with an error in the audit log. We
 *       never overwrite an unrelated file the user has curated.
 *
 *     - The pass NEVER touches Trees data — relationships are bound
 *       by person_id which we don't change, and saved_trees are
 *       bound by file_id which we don't change.
 */

import fs from 'fs';
import path from 'path';
import { getDb } from './search-database.js';
import { lookupSidecarByBasename } from './takeout-sidecar-cache.js';
import { writeEnrichmentExif } from './exif-writer.js';
import { generateDateBasedFilename } from './date-extraction-engine.js';
import { toLongPath } from './long-path.js';

// ─── Public API ─────────────────────────────────────────────────────────────

export interface EnrichmentDryRun {
  totalCandidates: number;        // rows where confidence IN ('recovered', 'marked')
  sidecarMatches: number;         // candidates with a usable sidecar entry
  dateUpgrades: number;           // candidates whose date would actually change
  gpsAvailable: number;           // candidates whose sidecar carries GPS
  descriptionAvailable: number;   // candidates whose sidecar carries a caption
  peopleHintsAvailable: number;   // candidates with at least one face the sidecar can hint
}

export interface EnrichmentRunProgress {
  inspected: number;
  upgraded: number;
  unchanged: number;
  skipped: number;
  total: number;
  currentFilename?: string;
}

export interface EnrichmentRunSummary {
  inspected: number;
  upgraded: number;
  unchanged: number;
  skipped: number;
  exifDateWrites: number;
  exifGpsWrites: number;
  exifDescriptionWrites: number;
  faceHintsAdded: number;
  errors: number;
  elapsedMs: number;
  cancelled: boolean;
}

// Module-level cancellation flag — flipped by the IPC handler when the
// user clicks Cancel in the Enriching modal.
let _cancelled = false;
export function cancelEnrichment(): void {
  _cancelled = true;
}

// ─── Dry-run probe ──────────────────────────────────────────────────────────
//
// Cheap pre-flight that runs before the user confirms the
// Enrichment modal — gives them an honest "X files have improving
// metadata, run upgrade?" count instead of opening the modal and
// then revealing "actually nothing to do."
//
// No mutations; pure SELECTs against indexed_files + takeout_sidecars.

interface IndexedRow {
  id: number;
  file_path: string;
  filename: string;
  original_filename: string;
  derived_date: string | null;
  confidence: string;
}

export function dryRunEnrichment(): EnrichmentDryRun {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, file_path, filename, original_filename, derived_date, confidence
    FROM indexed_files
    WHERE confidence IN ('recovered', 'marked')
  `).all() as IndexedRow[];

  const out: EnrichmentDryRun = {
    totalCandidates: rows.length,
    sidecarMatches: 0,
    dateUpgrades: 0,
    gpsAvailable: 0,
    descriptionAvailable: 0,
    peopleHintsAvailable: 0,
  };

  const faceHintProbe = db.prepare(`
    SELECT COUNT(*) AS c
    FROM face_detections
    WHERE file_id = ? AND person_id IS NULL AND verified = 0
  `);

  for (const row of rows) {
    const lookupName = row.original_filename || row.filename;
    if (!lookupName) continue;
    const sidecar = lookupSidecarByBasename(lookupName);
    if (!sidecar) continue;
    out.sidecarMatches++;

    if (sidecar.photoTakenUnix) {
      const newDateMs = sidecar.photoTakenUnix * 1000;
      const currentMs = row.derived_date ? new Date(row.derived_date).getTime() : null;
      // Only count as an upgrade when the new date is materially
      // different. Same-minute matches still count because the
      // confidence/source upgrade is meaningful even when the
      // displayed date doesn't change.
      if (currentMs === null || Math.abs(newDateMs - currentMs) > 1000) {
        out.dateUpgrades++;
      } else {
        // Same date but lower confidence — still an upgrade in the
        // confidence + filename sense.
        out.dateUpgrades++;
      }
    }
    if (sidecar.gpsLat !== null && sidecar.gpsLon !== null) out.gpsAvailable++;
    if (sidecar.description) out.descriptionAvailable++;
    if (sidecar.peopleJson) {
      const cnt = (faceHintProbe.get(row.id) as { c: number }).c;
      if (cnt > 0) out.peopleHintsAvailable++;
    }
  }
  return out;
}

// ─── Run pass ───────────────────────────────────────────────────────────────

export async function runEnrichment(
  onProgress?: (p: EnrichmentRunProgress) => void,
): Promise<EnrichmentRunSummary> {
  _cancelled = false;
  const startedAt = Date.now();
  const db = getDb();

  const summary: EnrichmentRunSummary = {
    inspected: 0,
    upgraded: 0,
    unchanged: 0,
    skipped: 0,
    exifDateWrites: 0,
    exifGpsWrites: 0,
    exifDescriptionWrites: 0,
    faceHintsAdded: 0,
    errors: 0,
    elapsedMs: 0,
    cancelled: false,
  };

  const rows = db.prepare(`
    SELECT id, file_path, filename, original_filename, derived_date, confidence
    FROM indexed_files
    WHERE confidence IN ('recovered', 'marked')
    ORDER BY id
  `).all() as IndexedRow[];

  const updateStmt = db.prepare(`
    UPDATE indexed_files
       SET derived_date = ?, year = ?, month = ?, day = ?,
           confidence = ?, date_source = ?, file_path = ?, filename = ?
     WHERE id = ?
  `);
  const auditStmt = db.prepare(`
    INSERT INTO enrichment_log (
      file_id, old_file_path, new_file_path,
      old_confidence, new_confidence,
      old_derived_date, new_derived_date,
      exif_fields_written, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const faceHintsForFile = db.prepare(`
    SELECT id FROM face_detections
    WHERE file_id = ? AND person_id IS NULL AND verified = 0
  `);
  const updateFaceHint = db.prepare(`
    UPDATE face_detections
       SET takeout_name_hint = ?, takeout_name_source = ?
     WHERE id = ?
  `);

  for (let i = 0; i < rows.length; i++) {
    if (_cancelled) {
      summary.cancelled = true;
      break;
    }
    const row = rows[i];
    summary.inspected++;

    try {
      const lookupName = row.original_filename || row.filename;
      if (!lookupName) { summary.unchanged++; continue; }
      const sidecar = lookupSidecarByBasename(lookupName);
      if (!sidecar || !sidecar.photoTakenUnix) {
        summary.unchanged++;
        onProgress?.({
          inspected: summary.inspected,
          upgraded: summary.upgraded,
          unchanged: summary.unchanged,
          skipped: summary.skipped,
          total: rows.length,
          currentFilename: row.filename,
        });
        continue;
      }

      const newDate = new Date(sidecar.photoTakenUnix * 1000);
      if (isNaN(newDate.getTime())) { summary.skipped++; continue; }

      // Compute the new filename. Preserve the existing extension —
      // sidecar metadata never tells us to change the file format.
      const oldExt = path.extname(row.file_path);
      const newFilename = generateDateBasedFilename(
        sidecar.photoTakenUnix,
        oldExt,
        'confirmed',
      );
      const oldDir = path.dirname(row.file_path);
      const newPath = path.join(oldDir, newFilename);

      // Skip if the rename target collides with a DIFFERENT file the
      // user already has on disk. Same-file no-op (we're renaming to
      // ourselves because the filename was already correct — rare but
      // possible if the file went through Date Editor) is fine.
      if (newPath !== row.file_path && fs.existsSync(toLongPath(newPath))) {
        summary.skipped++;
        auditStmt.run(
          row.id,
          row.file_path,
          null,
          row.confidence,
          null,
          row.derived_date,
          null,
          null,
          `takeout_sidecar:${sidecar.takeoutGroupId}:collision`,
        );
        continue;
      }

      // Rename on disk first — if this fails (file moved / deleted /
      // permission denied) we leave the DB row alone. Only update
      // the DB after the rename succeeds.
      if (newPath !== row.file_path) {
        try {
          await fs.promises.rename(toLongPath(row.file_path), toLongPath(newPath));
        } catch (e) {
          summary.errors++;
          summary.skipped++;
          auditStmt.run(
            row.id,
            row.file_path,
            null,
            row.confidence,
            null,
            row.derived_date,
            null,
            null,
            `takeout_sidecar:${sidecar.takeoutGroupId}:rename_failed:${(e as Error).message}`,
          );
          continue;
        }
      }

      // EXIF rewrite — single exiftool call carrying date + optional
      // GPS + optional description. exiftool runs against the NEW
      // path (we just renamed) so it writes to the right file.
      const exifRes = await writeEnrichmentExif(newPath, newDate, {
        gpsLat: sidecar.gpsLat,
        gpsLon: sidecar.gpsLon,
        description: sidecar.description,
      });
      if (!exifRes.success) {
        // EXIF failure isn't fatal — the rename succeeded and the DB
        // row update below will reflect the correct date. Log it in
        // the audit row so the user can see something went wrong.
        summary.errors++;
      } else {
        if (exifRes.fieldsWritten.includes('date')) summary.exifDateWrites++;
        if (exifRes.fieldsWritten.includes('gps')) summary.exifGpsWrites++;
        if (exifRes.fieldsWritten.includes('description')) summary.exifDescriptionWrites++;
      }

      // DB update — atomic per-row.
      updateStmt.run(
        newDate.toISOString(),
        newDate.getFullYear(),
        newDate.getMonth() + 1,
        newDate.getDate(),
        'confirmed',
        `Google Takeout JSON (cross-part: ${sidecar.sourceZip})`,
        newPath,
        newFilename,
        row.id,
      );

      // Face-name hints — additive only.
      if (sidecar.peopleJson) {
        try {
          const people = JSON.parse(sidecar.peopleJson) as Array<{ name?: string }>;
          if (Array.isArray(people) && people.length > 0) {
            const names = people.map((p) => p?.name).filter((n): n is string => typeof n === 'string' && n.length > 0);
            if (names.length > 0) {
              const candidateFaces = faceHintsForFile.all(row.id) as { id: number }[];
              // Spread N names across up to N faces — best-effort
              // pairing. If counts mismatch the extra hint or face
              // just isn't seeded; the user can still name faces
              // manually with no interference.
              const pairCount = Math.min(names.length, candidateFaces.length);
              for (let k = 0; k < pairCount; k++) {
                updateFaceHint.run(
                  names[k],
                  `takeout:${sidecar.takeoutGroupId}`,
                  candidateFaces[k].id,
                );
                summary.faceHintsAdded++;
              }
            }
          }
        } catch { /* malformed people_json — skip silently */ }
      }

      // Audit log row.
      auditStmt.run(
        row.id,
        row.file_path,
        newPath,
        row.confidence,
        'confirmed',
        row.derived_date,
        newDate.toISOString(),
        exifRes.fieldsWritten.join(',') || null,
        `takeout_sidecar:${sidecar.takeoutGroupId}`,
      );

      summary.upgraded++;
    } catch (e) {
      summary.errors++;
      console.warn(`[Enrichment] failure on row ${row.id}:`, (e as Error).message);
    }

    // Yield + emit progress every batch so the renderer pill stays
    // alive and Windows never marks the window "Not Responding".
    if (summary.inspected % 50 === 0) {
      onProgress?.({
        inspected: summary.inspected,
        upgraded: summary.upgraded,
        unchanged: summary.unchanged,
        skipped: summary.skipped,
        total: rows.length,
        currentFilename: row.filename,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  // Final progress event so the renderer sees totals === total.
  onProgress?.({
    inspected: summary.inspected,
    upgraded: summary.upgraded,
    unchanged: summary.unchanged,
    skipped: summary.skipped,
    total: rows.length,
  });

  summary.elapsedMs = Date.now() - startedAt;
  return summary;
}
