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

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDb } from './search-database.js';
import { lookupSidecarByBasename } from './takeout-sidecar-cache.js';
import { writeEnrichmentExif } from './exif-writer.js';
import { generateDateBasedFilename } from './date-extraction-engine.js';
import { toLongPath } from './long-path.js';

// v2.0.13 — streaming SHA-256 of a file. Used by the bothExist
// collision path to decide between deduplicating a content-identical
// pair (delete the _RC source, adopt the _CF target) vs keeping
// both as a genuine distinct-content collision (two different photos
// that happen to share a generated _CF filename).
//
// Why streaming + 64 KB chunks: files can be tens of MB (videos can
// be GB). A full-buffer read blows the heap and hits Node's 2 GiB
// Buffer cap on big videos.
function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// v2.0.13 (Terry 2026-05-26) — image-data-only hash for JPEGs.
//
// The full-file SHA-256 catches photos that are byte-for-byte identical.
// But PDR's own Fix pass writes EXIF (DateTimeOriginal etc) into the
// metadata segment at the head of a JPEG, which CHANGES the bytes but
// leaves the actual image pixels untouched. So a photo that was Fixed
// once and a photo that was Fixed twice from different sources will
// have:
//   - same file size (EXIF block is fixed-length in most cases)
//   - different full-file SHA-256
//   - IDENTICAL image data
//
// Without a pixel-level compare we'd keep both as "distinct collisions"
// even though they're visibly the same photo. Terry caught this on a
// run with 17 such pairs (all .jpg, all same-size, hashes differing
// only in the EXIF region).
//
// Implementation: walk the JPEG segment chain from SOI (FFD8), skip
// each APPn / DQT / DHT / SOFn segment, stop at SOS (FFDA). Hash
// everything from SOS to EOI. EXIF is in APP1 (FFE1) which we skip
// over; image scan data starts at SOS so the hash captures the actual
// pixels.
//
// For non-JPEG formats (PNG/GIF/mp4/...), the metadata layout varies
// and there's no single "scan start" marker. Falls back to full-file
// hash — the byte-identical case still dedups, and the same-size-but-
// different-bytes case stays as a distinct collision (which for non-
// JPEGs is the safer default — GIFs/PNGs don't have EXIF blocks that
// PDR rewrites, so same-size + different-hash there genuinely is
// different content).
function findJpegScanStart(buf: Buffer): number {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return -1;
  let pos = 2;
  while (pos < buf.length - 4) {
    // Skip any 0xFF padding between markers.
    while (pos < buf.length && buf[pos] === 0xff && buf[pos + 1] === 0xff) pos++;
    if (buf[pos] !== 0xff) return -1;
    const marker = buf[pos + 1];
    if (marker === 0xda) return pos;         // SOS — image scan starts here
    if (marker === 0xd9) return -1;          // EOI before SOS — malformed
    // Standalone markers without length fields: RST0..7 (D0..D7), TEM (01).
    // None of these should appear before SOS in a well-formed file, but
    // defensively skip them as 2-byte markers if encountered.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      pos += 2;
      continue;
    }
    if (pos + 4 > buf.length) return -1;
    const segLen = (buf[pos + 2] << 8) | buf[pos + 3];
    if (segLen < 2) return -1;
    pos += 2 + segLen;
  }
  return -1;
}

async function hashImageData(filePath: string): Promise<string> {
  // JPEGs only — for everything else, fall back to full-file hash.
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.jpg' && ext !== '.jpeg' && ext !== '.jfif') {
    return hashFile(filePath);
  }
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(filePath, 'r');
    // 128 KB head is generous — real-world JPEG metadata sits well
    // under 64 KB in 99.9% of cases. Going larger just makes the
    // pathological case (huge thumbnail in APP2) work too.
    const HEAD = 128 * 1024;
    const headBuf = Buffer.alloc(HEAD);
    const { bytesRead } = await fd.read(headBuf, 0, HEAD, 0);
    const head = headBuf.subarray(0, bytesRead);
    const sosOffset = findJpegScanStart(head);
    if (sosOffset < 0) {
      // Couldn't find SOS in the first 128 KB → likely not a normal
      // JPEG, or has a massive ICC profile. Fall back to full-file hash.
      await fd.close();
      fd = null;
      return hashFile(filePath);
    }
    const hash = crypto.createHash('sha256');
    hash.update(head.subarray(sosOffset));
    // Stream the remainder of the file from where the head ended.
    const CHUNK = 64 * 1024;
    const chunk = Buffer.alloc(CHUNK);
    let offset = bytesRead;
    while (true) {
      const { bytesRead: n } = await fd.read(chunk, 0, CHUNK, offset);
      if (n === 0) break;
      hash.update(chunk.subarray(0, n));
      offset += n;
    }
    return hash.digest('hex');
  } finally {
    if (fd) { try { await fd.close(); } catch { /* ignore */ } }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface EnrichmentDryRun {
  totalCandidates: number;        // rows where confidence IN ('recovered', 'marked')
  sidecarMatches: number;         // candidates with a usable sidecar entry
  dateUpgrades: number;           // candidates whose date would actually change
  // v2.0.13 (Terry 2026-05-26) — collision pre-check so the dry-run
  // doesn't promise N upgrades when most of them will collide on
  // disk with a previously-Fixed _CF of a DIFFERENT photo. The run
  // pass already detects this case but the dry-run was blind to it,
  // producing the misleading "47 will upgrade" → "0 upgraded · 47
  // collisions kept" mismatch.
  willCollide: number;            // candidates whose target filename already exists on disk
  exifGpsCandidates: number;      // candidates whose target file is a photo (GPS write reachable)
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
  // v2.0.13 — content-identical duplicates that the engine cleaned up
  // by deleting the older _RC copy because the _CF target was byte-
  // for-byte the same file. Counted SEPARATELY from upgraded so the
  // summary can explain to the user why a duplicate existed in the
  // first place (two different historical Fix runs of the same photo
  // from different sources — the only way for a duplicate to slip
  // past PDR's per-run dedup).
  dedupedDuplicates: number;
  // True collisions: the _RC source and the _CF target both exist
  // on disk AND have different content (different photos that
  // happen to share the same generated filename — same-second
  // multi-camera shots, etc). Kept intact, NOT deleted.
  distinctCollisions: number;
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
    willCollide: 0,
    exifGpsCandidates: 0,
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

    // v2.0.13 collision pre-check (Terry 2026-05-26): simulate the
    // rename to see if the target filename already exists on disk.
    // The run pass will either dedup it (identical bytes) or keep it
    // as a distinct collision — but the user-visible "X will upgrade"
    // count should already account for these so we're not promising
    // upgrades that won't materialise. We can't tell dedup-able from
    // distinct-collision without hashing here (too slow for a
    // dry-run), so the safest move is to subtract ALL would-be
    // collisions from the upgrade count — the actual dedup case
    // gets reported separately in the final summary.
    let wouldCollide = false;
    if (sidecar.photoTakenUnix) {
      const oldExt = path.extname(row.file_path);
      try {
        const probeFilename = generateDateBasedFilename(
          sidecar.photoTakenUnix,
          oldExt,
          'confirmed',
        );
        const oldDir = path.dirname(row.file_path);
        const probePath = path.join(oldDir, probeFilename);
        if (probePath !== row.file_path && fs.existsSync(toLongPath(probePath))) {
          wouldCollide = true;
          out.willCollide++;
        }
      } catch { /* filename probe failure — fall through; run pass will surface the error */ }
    }

    if (sidecar.photoTakenUnix && !wouldCollide) {
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
      // GPS / description / people hints are only realisable if the
      // file actually gets touched. Gating these counters on
      // !wouldCollide means the dry-run doesn't promise "204 GPS
      // coords will land" when actually all 204 collide and zero
      // EXIF writes happen.
      if (sidecar.gpsLat !== null && sidecar.gpsLon !== null) out.gpsAvailable++;
      if (sidecar.description) out.descriptionAvailable++;
      if (sidecar.peopleJson) {
        const cnt = (faceHintProbe.get(row.id) as { c: number }).c;
        if (cnt > 0) out.peopleHintsAvailable++;
      }
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
    dedupedDuplicates: 0,
    distinctCollisions: 0,
    errors: 0,
    elapsedMs: 0,
    cancelled: false,
  };

  // v2.0.13 diagnostic (Terry 2026-05-26) — aggregate case
  // distribution so a post-mortem can see where every row landed.
  // Helps diagnose runs where the headline "X skipped" doesn't
  // make sense given the on-disk state.
  const caseCounts = {
    noLookupName: 0,
    noSidecar: 0,
    noPhotoTakenUnix: 0,
    invalidDate: 0,
    pathUnchanged: 0,
    bothExist_collision: 0,
    neitherExists_sourceMissing: 0,
    renameSucceeded: 0,
    renameFailed: 0,
    driftAdopted: 0,
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
      if (!lookupName) { summary.unchanged++; caseCounts.noLookupName++; continue; }
      const sidecar = lookupSidecarByBasename(lookupName);
      if (!sidecar) {
        summary.unchanged++;
        caseCounts.noSidecar++;
        continue;
      }
      if (!sidecar.photoTakenUnix) {
        summary.unchanged++;
        caseCounts.noPhotoTakenUnix++;
        continue;
      }

      const newDate = new Date(sidecar.photoTakenUnix * 1000);
      if (isNaN(newDate.getTime())) { summary.skipped++; caseCounts.invalidDate++; continue; }

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

      // Collision-drift handling (Terry 2026-05-26):
      //
      // The old logic just checked "does the target filename already
      // exist?" and skipped if so. That caught 192 files in Terry's
      // run on a library where a previous PDR run had already renamed
      // the file to its _CF target on disk but the DB row never
      // caught up — so the DB still says _RC / _MK and points at the
      // OLD path, while the file actually lives at the NEW _CF path
      // already. The old code couldn't tell that apart from a true
      // collision (two different photos with the same target name),
      // so it gave up.
      //
      // Three distinct cases to handle:
      //
      //   - source exists, target doesn't  → normal rename path.
      //   - source missing, target exists  → "collision drift". A
      //     previous run did the rename but the DB row drifted out
      //     of sync. Adopt the on-disk file into the row by skipping
      //     the rename and proceeding straight to EXIF + DB update
      //     (which writes the new file_path / confidence). Counts as
      //     an upgrade, not a skip.
      //   - both exist                     → genuine collision. Two
      //     different photos produce the same generated filename
      //     (rare but possible — same-second multi-camera shots or
      //     album duplicates within a Takeout). Skip + audit.
      //   - both missing                   → source went away
      //     entirely. Skip + audit with source_missing reason.
      let driftAdoption = false;
      if (newPath !== row.file_path) {
        const sourceExists = fs.existsSync(toLongPath(row.file_path));
        const targetExists = fs.existsSync(toLongPath(newPath));

        if (sourceExists && targetExists) {
          // Content-identical dedup (Terry 2026-05-26):
          //
          // The two files at row.file_path and newPath could be:
          //   (a) Byte-identical — same photo Fixed twice from
          //       different sources at different times, slipping past
          //       PDR's per-run dedup because the two runs happened
          //       independently. The _CF copy is the precise-dated
          //       one we want; the _RC copy is a redundant duplicate.
          //   (b) Different content — two genuinely distinct photos
          //       that happen to produce the same generated _CF
          //       filename (same-second multi-camera shots, album
          //       duplicates with re-encoded thumbnails, etc.).
          //
          // SHA-256 both files. If they match → delete the _RC, adopt
          // the _CF into the DB row, count as deduped (NOT skipped).
          // If they differ → keep as distinctCollisions (NOT skipped
          // either — distinct counter so the user sees what's
          // actually going on, not just a meaningless "skipped" bin).
          let identical = false;
          let identicalReason: 'full' | 'imageData' | 'no' = 'no';
          // v2.0.13 diagnostic (Terry 2026-05-26): when the run ends
          // with N collisions kept, the user has no visibility into
          // WHY each pair was kept. Capture per-collision detail here
          // so a post-mortem can see source size vs target size,
          // hash prefixes, and the sidecar date — enough to tell
          // "true distinct content" from "the hash compare is buggy".
          let diagSourceSize = -1;
          let diagTargetSize = -1;
          let diagSourceHashPrefix = '(not hashed)';
          let diagTargetHashPrefix = '(not hashed)';
          let diagSourceImgPrefix = '(not hashed)';
          let diagTargetImgPrefix = '(not hashed)';
          let diagHashErr: string | null = null;
          try {
            // Cheap pre-check: size mismatch → can't be identical.
            const sourceStat = fs.statSync(toLongPath(row.file_path));
            const targetStat = fs.statSync(toLongPath(newPath));
            diagSourceSize = sourceStat.size;
            diagTargetSize = targetStat.size;
            if (sourceStat.size === targetStat.size) {
              const [sourceHash, targetHash] = await Promise.all([
                hashFile(toLongPath(row.file_path)),
                hashFile(toLongPath(newPath)),
              ]);
              diagSourceHashPrefix = sourceHash.slice(0, 16);
              diagTargetHashPrefix = targetHash.slice(0, 16);
              if (sourceHash === targetHash) {
                identical = true;
                identicalReason = 'full';
              } else {
                // Full-file bytes differ but the size matches exactly.
                // For JPEGs this almost always means "same image, PDR
                // wrote different EXIF into the metadata segment on
                // each copy." Fall back to comparing just the image
                // scan data (post-SOS) — that's invariant under EXIF
                // rewrites and proves identical pixels.
                const [sourceImg, targetImg] = await Promise.all([
                  hashImageData(toLongPath(row.file_path)),
                  hashImageData(toLongPath(newPath)),
                ]);
                diagSourceImgPrefix = sourceImg.slice(0, 16);
                diagTargetImgPrefix = targetImg.slice(0, 16);
                if (sourceImg === targetImg) {
                  identical = true;
                  identicalReason = 'imageData';
                }
              }
            }
          } catch (hashErr) {
            // Hashing failed (file vanished mid-run, permission etc.)
            // Treat as distinct so we never delete anything we can't
            // verify is a true duplicate.
            diagHashErr = (hashErr as Error).message;
            console.warn(`[Enrichment] hash compare failed for ${row.file_path}:`, diagHashErr);
          }

          if (identical) {
            // Safe to delete the _RC source. The _CF target is the
            // surviving copy.
            try {
              await fs.promises.unlink(toLongPath(row.file_path));
            } catch (unlinkErr) {
              // Unlink failed (locked, permission). Don't fail the
              // whole enrichment — just keep both copies and audit it.
              summary.distinctCollisions++;
              caseCounts.bothExist_collision++;
              auditStmt.run(
                row.id,
                row.file_path,
                null,
                row.confidence,
                null,
                row.derived_date,
                null,
                null,
                `takeout_sidecar:${sidecar.takeoutGroupId}:dedup_unlink_failed:${(unlinkErr as Error).message}`,
              );
              continue;
            }
            // DB-side dedup: the _CF target almost certainly already
            // has its own row in indexed_files (it was added by a
            // previous Fix run). Updating row A's file_path to point
            // at the _CF would collide on the UNIQUE INDEX on
            // file_path. Instead, MERGE row A into row B (the
            // surviving _CF row): move album_files + face_detections
            // + ai_tags references from A → B (additive, never
            // overrides user data on B), then delete A. Row B
            // already has the correct confidence + derived_date, so
            // there's nothing more to write on the indexed_files
            // side. Audit + continue (the EXIF/face-hint/db-update
            // block that follows is for the rename path, not this
            // already-converged case).
            const targetRow = db.prepare(
              `SELECT id FROM indexed_files WHERE file_path = ?`
            ).get(newPath) as { id: number } | undefined;
            // enrichment_log.file_id has a FOREIGN KEY into
            // indexed_files. After the merge transaction deletes
            // row A, an audit insert with file_id=row.id violates
            // the FK. Use the surviving row B's id instead — that's
            // semantically correct anyway (the audit row records
            // what happened TO the surviving file), and keeps the
            // file_id pointing at a real, live row. For the no-row-B
            // edge case we fall back to row.id (which is still alive
            // after the UPDATE path).
            const auditFileId = targetRow ? targetRow.id : row.id;
            if (targetRow) {
              try {
                const mergeTx = db.transaction((aId: number, bId: number) => {
                  // album_files: composite PK on (album_id, file_id)
                  // makes INSERT OR IGNORE safe — duplicates collapse,
                  // unique memberships move over.
                  db.prepare(`
                    INSERT OR IGNORE INTO album_files (album_id, file_id, added_at)
                    SELECT album_id, ?, added_at FROM album_files WHERE file_id = ?
                  `).run(bId, aId);
                  db.prepare(`DELETE FROM album_files WHERE file_id = ?`).run(aId);
                  // face_detections / ai_tags: no compound uniqueness,
                  // just move file_id pointers. The face / tag rows
                  // themselves are kept verbatim.
                  db.prepare(`UPDATE face_detections SET file_id = ? WHERE file_id = ?`).run(bId, aId);
                  try {
                    db.prepare(`UPDATE ai_tags SET file_id = ? WHERE file_id = ?`).run(bId, aId);
                  } catch { /* ai_tags table may be empty / absent — non-fatal */ }
                  // Drop row A — cascade clears any remaining FK rows.
                  db.prepare(`DELETE FROM indexed_files WHERE id = ?`).run(aId);
                });
                mergeTx(row.id, targetRow.id);
              } catch (mergeErr) {
                // Merge failed mid-transaction. Don't break the run;
                // audit and move on. The on-disk _RC is already
                // deleted; the DB state is inconsistent (row A still
                // points at missing _RC) but will get cleaned up by
                // the next purgeStaleIndexedFiles startup pass.
                summary.errors++;
                auditStmt.run(
                  row.id,
                  row.file_path,
                  newPath,
                  row.confidence,
                  null,
                  row.derived_date,
                  null,
                  null,
                  `takeout_sidecar:${sidecar.takeoutGroupId}:dedup_merge_failed:${(mergeErr as Error).message}`,
                );
              }
            } else {
              // No row B exists in the DB (rare edge case: _CF file
              // sitting on disk but never indexed). Safe to UPDATE
              // row A's file_path to the new path normally.
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
            }
            summary.dedupedDuplicates++;
            summary.upgraded++;
            caseCounts.driftAdopted++;
            auditStmt.run(
              auditFileId,
              row.file_path,
              newPath,
              row.confidence,
              'confirmed',
              row.derived_date,
              newDate.toISOString(),
              null,
              `takeout_sidecar:${sidecar.takeoutGroupId}:dedup_merged_${identicalReason}`,
            );
            continue;
          } else {
            summary.distinctCollisions++;
            caseCounts.bothExist_collision++;
            // v2.0.13 diagnostic — log one line per collision so the
            // post-mortem can see exactly what's being kept.
            // Format chosen to be greppable: prefix + key facts.
            console.log(
              `[Enrichment][collision] id=${row.id} ` +
              `src=${path.basename(row.file_path)} ` +
              `dst=${path.basename(newPath)} ` +
              `srcSize=${diagSourceSize} dstSize=${diagTargetSize} ` +
              `srcHash=${diagSourceHashPrefix} dstHash=${diagTargetHashPrefix} ` +
              `srcImg=${diagSourceImgPrefix} dstImg=${diagTargetImgPrefix} ` +
              `hashErr=${diagHashErr ?? '(none)'} ` +
              `derived_date=${row.derived_date ?? '(null)'} ` +
              `sidecar_unix=${sidecar.photoTakenUnix} ` +
              `sidecar_zip=${sidecar.sourceZip}`
            );
            auditStmt.run(
              row.id,
              row.file_path,
              null,
              row.confidence,
              null,
              row.derived_date,
              null,
              null,
              `takeout_sidecar:${sidecar.takeoutGroupId}:collision_distinct_content`,
            );
            continue;
          }
        } else if (!sourceExists && !targetExists) {
          summary.skipped++;
          caseCounts.neitherExists_sourceMissing++;
          auditStmt.run(
            row.id,
            row.file_path,
            null,
            row.confidence,
            null,
            row.derived_date,
            null,
            null,
            `takeout_sidecar:${sidecar.takeoutGroupId}:source_missing`,
          );
          continue;
        } else if (sourceExists && !targetExists) {
          // Normal case — rename the source on disk.
          try {
            await fs.promises.rename(toLongPath(row.file_path), toLongPath(newPath));
            caseCounts.renameSucceeded++;
          } catch (e) {
            summary.errors++;
            summary.skipped++;
            caseCounts.renameFailed++;
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
        } else {
          // sourceExists=false && targetExists=true → drift adoption.
          // File already at newPath from a previous run; skip the
          // rename, fall through to EXIF + DB update.
          driftAdoption = true;
          caseCounts.driftAdopted++;
        }
      } else {
        // newPath === row.file_path — current filename already matches
        // what the sidecar would produce. No rename needed, but EXIF
        // and DB confidence updates still apply.
        caseCounts.pathUnchanged++;
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
        // Retry with date-only payload if the original write failed —
        // most common failure mode is an unparseable GPS / description
        // value rejecting the whole multi-field call. The date is the
        // headline value so we always want it written, even when the
        // metadata extras fail. Diagnosed 2026-05-26.
        try {
          const dateOnlyRetry = await writeEnrichmentExif(newPath, newDate, {
            gpsLat: null,
            gpsLon: null,
            description: null,
          });
          if (dateOnlyRetry.success && dateOnlyRetry.fieldsWritten.includes('date')) {
            summary.exifDateWrites++;
          }
        } catch { /* date-only retry best-effort */ }
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

      // Audit log row. Records drift-adoption distinctly so a
      // post-mortem can tell what fraction of upgrades came from
      // adopting an existing-on-disk file vs renaming on the spot.
      auditStmt.run(
        row.id,
        row.file_path,
        newPath,
        row.confidence,
        'confirmed',
        row.derived_date,
        newDate.toISOString(),
        exifRes.fieldsWritten.join(',') || null,
        `takeout_sidecar:${sidecar.takeoutGroupId}${driftAdoption ? ':drift_adopted' : ''}`,
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
  // v2.0.13 diagnostic — log the case-distribution so the post-mortem
  // can see exactly where each row landed without the user having to
  // query the enrichment_log table directly.
  console.log(`[Enrichment] case distribution: ${JSON.stringify(caseCounts)}`);

  // v2.0.13 (Terry 2026-05-26) — persist a one-row summary of this
  // run so the LDM "Last enriched X ago" line has something to read.
  // Failure here is non-fatal (we already did the work); just warn.
  try {
    db.prepare(`
      INSERT INTO enrichment_runs (
        inspected, upgraded, deduped_duplicates, distinct_collisions,
        exif_date_writes, exif_gps_writes, exif_desc_writes,
        face_hints_added, errors, elapsed_ms, cancelled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      summary.inspected,
      summary.upgraded,
      summary.dedupedDuplicates,
      summary.distinctCollisions,
      summary.exifDateWrites,
      summary.exifGpsWrites,
      summary.exifDescriptionWrites,
      summary.faceHintsAdded,
      summary.errors,
      summary.elapsedMs,
      summary.cancelled ? 1 : 0,
    );
  } catch (e) {
    console.warn('[Enrichment] failed to persist run summary:', (e as Error).message);
  }
  return summary;
}

// ─── Latest-run accessor for the LDM "Last enriched" line ──────────────────

export interface LatestEnrichmentRun {
  finishedAt: string;
  upgraded: number;
  dedupedDuplicates: number;
  distinctCollisions: number;
  errors: number;
}

export function getLatestEnrichmentRun(): LatestEnrichmentRun | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT finished_at, upgraded, deduped_duplicates, distinct_collisions, errors
    FROM enrichment_runs
    ORDER BY id DESC
    LIMIT 1
  `).get() as
    | {
        finished_at: string;
        upgraded: number;
        deduped_duplicates: number;
        distinct_collisions: number;
        errors: number;
      }
    | undefined;
  if (!row) return null;
  return {
    finishedAt: row.finished_at,
    upgraded: row.upgraded,
    dedupedDuplicates: row.deduped_duplicates,
    distinctCollisions: row.distinct_collisions,
    errors: row.errors,
  };
}
