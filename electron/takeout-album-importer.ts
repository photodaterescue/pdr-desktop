/**
 * Takeout album importer (v2.0.8).
 *
 * Two halves, designed to share the same album-and-caption import logic:
 *
 *   • Fix-path enrichment — runs DURING `files:copy` while PDR_Temp still
 *     holds the extracted Takeout folder. Walks each successful result, looks
 *     for a sibling `*.supplemental-metadata.json` (or fallback `.json`) and a
 *     parent folder containing `metadata.json` (Google's marker for an album).
 *     Caches the metadata.json title per folder so we don't re-parse it for
 *     every photo in the same album. Result: a `PendingTakeoutEnrichment`
 *     blob keyed on the Fix's destination path, stashed in main.ts's
 *     `pendingTakeoutEnrichments` map until indexing creates the file_ids.
 *
 *   • Post-index album write — runs in `search:indexRun` after `indexFixRun`
 *     has inserted the indexed_files rows. Resolves each enrichment entry's
 *     destPath → file_id, upserts the albums by external_album_key, links
 *     album_files via INSERT OR IGNORE, and writes back caption +
 *     corrected original_filename to indexed_files. Per-album detection log
 *     line: `Album: "X" → N files linked, original_filenames recovered: M/N,
 *     captions: K/N` — designed for Terry to sanity-check by eye against a
 *     real Takeout, no DB queries needed.
 *
 * The same `importTakeoutAlbumsFromEnrichment` function will be reused by the
 * backfill flow (v2.0.8 second half) which constructs the enrichment by
 * streaming sidecar JSONs out of an original Takeout ZIP without re-extracting
 * the 50 GB payload. Different file-access strategy, same import logic.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as unzipper from 'unzipper';
import { parseGoogleTakeoutJson, parseGoogleTakeoutJsonContent } from './date-extraction-engine.cjs';
import {
  upsertTakeoutAlbum,
  linkAlbumFile,
  applyTakeoutSidecarMetadata,
  findFileIdByPathInRun,
  findFileIdByOriginalNameAndSize,
  findFileIdByOriginalNameAndDate,
} from './search-database.js';

/**
 * Convert a unix-seconds timestamp to PDR's canonical derived_date format
 * ('YYYY-MM-DD HH:MM:SS' in LOCAL time, matching what buildFileRecord
 * stores when it parses the PDR-renamed output filename). Local time is
 * the right choice here: PDR's renamer applies the same UTC→local
 * conversion at Fix-time, so the sidecar timestamp converted via the
 * SAME rules produces the SAME string. Returns null when the input is
 * not a positive number.
 */
function takeoutTimestampToDerivedDate(unixSeconds: number | null): string | null {
  if (!unixSeconds || unixSeconds <= 0) return null;
  const d = new Date(unixSeconds * 1000);
  if (isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * One per Fix-output file that landed in a Takeout album folder. Captured at
 * Fix-time while sidecars still exist on disk; consumed post-index to write
 * the DB rows.
 */
export interface TakeoutFileEnrichment {
  /** Destination path (where the file landed after Fix). Used to resolve the
   *  freshly inserted indexed_files.id post-index. Set by the Fix-path
   *  gather; left as the empty string by the ZIP-backfill path which
   *  resolves the id ahead of time and puts it in `resolvedFileId`. */
  destPath: string;
  /** Pre-resolved indexed_files.id when known at gather time. Used by the
   *  backfill (ZIP-streaming) path where matching happens against existing
   *  rows via (original_filename, size_bytes) before the enrichment is
   *  handed to the importer. When set, the importer uses this directly and
   *  skips the run-scoped destPath lookup. */
  resolvedFileId?: number;
  /** Album folder name (== external_album_key). Stable across Takeout
   *  re-exports of the same Google Photos album. */
  albumExternalKey: string;
  /** Album display title from the folder's metadata.json (preserves emoji,
   *  apostrophes, accents — not always the same as the folder name). */
  albumTitle: string;
  /** Original device-given filename per the sidecar, or null when no sidecar
   *  was found. Used to override original_filename when Google mangled the
   *  on-disk name with `(1)` / `(2)` / truncation. */
  sidecarTitle: string | null;
  /** Google Photos description (caption), or null when not present. */
  sidecarDescription: string | null;
}

/**
 * Result of scanning a Fix's source files. Keyed in main.ts by the Fix's
 * destinationPath so search:indexRun can find it after indexing completes.
 */
export interface PendingTakeoutEnrichment {
  /** When this enrichment was gathered (for cache-staleness checks; the map
   *  is in-memory so this only matters for diagnostics). */
  gatheredAt: number;
  files: TakeoutFileEnrichment[];
}

/** Per-album outcome line shown in the log. */
export interface AlbumImportResult {
  externalKey: string;
  title: string;
  filesLinked: number;
  originalFilenamesRecovered: number;
  captionsApplied: number;
  unresolvedFiles: number;
}

export interface TakeoutImportSummary {
  albumsCreated: number;
  albumsUpdated: number;
  totalFilesLinked: number;
  totalOriginalFilenamesRecovered: number;
  totalCaptionsApplied: number;
  perAlbum: AlbumImportResult[];
}

// ─── Folder cache for the Fix-path enrichment ────────────────────────────────

interface AlbumFolderInfo {
  /** Album title from metadata.json — null means "scanned, not an album". */
  title: string | null;
  /** Map of photo basename → sidecar basename for sibling lookup. */
  sidecarMap: Map<string, string>;
}

/**
 * Read a folder once: detect metadata.json, build the photo→sidecar map.
 * Returns null on read errors so a single bad folder doesn't poison the run.
 */
function readAlbumFolder(folderPath: string): AlbumFolderInfo | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(folderPath);
  } catch {
    return null;
  }

  const entrySet = new Set(entries);
  const hasMetadataJson = entrySet.has('metadata.json');

  let title: string | null = null;
  if (hasMetadataJson) {
    try {
      const raw = fs.readFileSync(path.join(folderPath, 'metadata.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      const candidate = typeof parsed?.title === 'string' ? parsed.title.trim() : '';
      // Fall back to folder basename if metadata.json lacks a title (rare but
      // observed in older Takeout exports). The folder name is what becomes
      // the external_album_key either way, so the display title only needs
      // to be human-readable.
      title = candidate || path.basename(folderPath);
    } catch {
      title = path.basename(folderPath);
    }
  }

  // Map sidecars even when the folder isn't an album — caller may still want
  // per-file metadata (e.g. for year-bucket folders Google also writes
  // sidecars in). For v2.0.8 we only consume sidecars within album folders,
  // but the cost of building the map is trivial and keeps the cache uniform.
  const sidecarMap = new Map<string, string>();
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    if (lower === 'metadata.json' || !lower.endsWith('.json')) continue;

    if (lower.endsWith('.supplemental-metadata.json')) {
      const photoBase = entry.slice(0, -'.supplemental-metadata.json'.length);
      if (entrySet.has(photoBase)) sidecarMap.set(photoBase, entry);
      continue;
    }

    // Plain *.json fallback — older Takeout exports used this shape. Try
    // <photo>.json first (full filename + .json), then strip-extension match.
    const stripped = entry.slice(0, -5); // remove ".json"
    if (entrySet.has(stripped)) {
      sidecarMap.set(stripped, entry);
      continue;
    }
    const strippedLower = stripped.toLowerCase();
    for (const candidate of entries) {
      if (candidate === entry) continue;
      const candidateLower = candidate.toLowerCase();
      if (candidateLower.endsWith('.json')) continue;
      const candidateBaseLower = candidateLower.replace(/\.[^.]+$/, '');
      if (candidateBaseLower === strippedLower) {
        sidecarMap.set(candidate, entry);
        break;
      }
    }
  }

  return { title, sidecarMap };
}

// ─── Fix-path enrichment gathering ───────────────────────────────────────────

interface FixCopyResultLike {
  success: boolean;
  sourcePath: string;
  destPath: string;
  finalFilename?: string;
}

/**
 * Walk the successful results of a Fix copy operation, looking for files that
 * came from Google Photos album folders. Reads sidecar JSON for each found
 * file. Returns null when nothing Takeout-shaped was found, so callers can
 * skip storing an empty enrichment.
 *
 * Safe to call with a mixed source list — non-Takeout files (regular folders,
 * single ZIPs without album structure) are silently ignored. Failures on
 * individual folders/sidecars are swallowed so one bad file never aborts the
 * gather.
 */
export function gatherTakeoutEnrichmentFromFixResults(
  results: FixCopyResultLike[],
): PendingTakeoutEnrichment | null {
  const folderCache = new Map<string, AlbumFolderInfo | null>();
  const enrichment: TakeoutFileEnrichment[] = [];

  for (const result of results) {
    if (!result.success || !result.sourcePath || !result.destPath) continue;

    const folder = path.dirname(result.sourcePath);
    if (!folderCache.has(folder)) {
      folderCache.set(folder, readAlbumFolder(folder));
    }
    const folderInfo = folderCache.get(folder);
    if (!folderInfo || folderInfo.title === null) continue; // Not an album

    const photoBase = path.basename(result.sourcePath);
    const sidecarBase = folderInfo.sidecarMap.get(photoBase);

    let sidecarTitle: string | null = null;
    let sidecarDescription: string | null = null;
    if (sidecarBase) {
      try {
        const sidecarData = parseGoogleTakeoutJson(path.join(folder, sidecarBase));
        if (sidecarData) {
          sidecarTitle = sidecarData.title?.trim() || null;
          sidecarDescription = sidecarData.description?.trim() || null;
        }
      } catch {
        // Bad sidecar — fall through with nulls; album linkage still happens.
      }
    }

    enrichment.push({
      destPath: result.destPath,
      albumExternalKey: path.basename(folder),
      albumTitle: folderInfo.title,
      sidecarTitle,
      sidecarDescription,
    });
  }

  if (enrichment.length === 0) return null;
  return { gatheredAt: Date.now(), files: enrichment };
}

// ─── Backfill: ZIP-streaming enrichment ──────────────────────────────────────

const MEDIA_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tif', '.tiff', '.webp', '.heic', '.heif',
  '.mp4', '.mov', '.avi', '.mkv', '.m4v', '.3gp', '.webm',
]);

export interface BackfillStats {
  albumFoldersDetected: number;
  photosConsidered: number;
  matchedAgainstLibrary: number;
  unmatched: number;
}

/**
 * Build a PendingTakeoutEnrichment by streaming a Google Takeout ZIP — no
 * extraction, no PDR_Temp involvement. Walks the ZIP's central directory,
 * identifies album folders (those containing `metadata.json` at root),
 * decompresses individual sidecar JSON entries on the fly (small files, cheap),
 * matches each photo against existing indexed_files rows by
 * (original_filename, size_bytes) using the canonical sidecar title where
 * present and the on-disk ZIP filename as the fallback.
 *
 * Designed for the customer who's already Fixed their Takeout on v2.0.4–v2.0.7
 * and wants the albums + captions + corrected original_filenames retro-applied
 * without re-running the 50 GB Fix. Photo BYTES are never read — only the
 * tiny `metadata.json` and `*.supplemental-metadata.json` entries — so
 * runtime is bound by sidecar count, not Takeout size.
 *
 * Returns null when no album folders are detected in the ZIP. `stats` carries
 * the counts the caller can surface in a result toast.
 */
export async function gatherTakeoutEnrichmentFromZip(
  zipPath: string,
): Promise<{ enrichment: PendingTakeoutEnrichment | null; stats: BackfillStats }> {
  const stats: BackfillStats = {
    albumFoldersDetected: 0,
    photosConsidered: 0,
    matchedAgainstLibrary: 0,
    unmatched: 0,
  };

  const directory = await unzipper.Open.file(zipPath);

  // Group ZIP entries by their parent folder path. The ZIP spec mandates
  // forward slashes, and real Google Takeouts (built on Linux) follow that.
  // But Windows tools that re-zip a Takeout — including PowerShell's
  // Compress-Archive on PS 5.1 — write backslash-separated entry paths in
  // violation of the spec. Normalising up front means both formats work.
  const normaliseSeparators = (p: string) => p.replace(/\\/g, '/');
  const basenameOf = (e: unzipper.File) => path.posix.basename(normaliseSeparators(e.path));
  const byFolder = new Map<string, unzipper.File[]>();
  for (const entry of directory.files) {
    if (entry.type === 'Directory') continue;
    const entryPath = normaliseSeparators(entry.path);
    const folder = path.posix.dirname(entryPath);
    const arr = byFolder.get(folder);
    if (arr) arr.push(entry);
    else byFolder.set(folder, [entry]);
  }

  const fileEnrichments: TakeoutFileEnrichment[] = [];

  for (const [folder, entries] of byFolder) {
    const metadataEntry = entries.find(e => basenameOf(e) === 'metadata.json');
    if (!metadataEntry) continue; // Not an album folder — skip.

    // Read the folder's metadata.json to get the album's display title.
    let albumTitle = path.posix.basename(folder);
    try {
      const buf = await metadataEntry.buffer();
      let text = buf.toString('utf-8');
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      const parsed = JSON.parse(text);
      if (typeof parsed?.title === 'string' && parsed.title.trim()) {
        albumTitle = parsed.title.trim();
      }
    } catch {
      // Bad metadata.json — keep folder-basename fallback for the title.
    }

    const externalKey = path.posix.basename(folder);
    stats.albumFoldersDetected++;

    // Index sidecars in this folder by the photo basename they belong to.
    // Mirrors the FS-path readAlbumFolder logic so behaviour is identical
    // across the two access strategies.
    const sidecarByPhoto = new Map<string, unzipper.File>();
    const entryNames = new Set(entries.map(e => basenameOf(e)));
    for (const e of entries) {
      const name = basenameOf(e);
      const lower = name.toLowerCase();
      if (lower === 'metadata.json' || !lower.endsWith('.json')) continue;

      if (lower.endsWith('.supplemental-metadata.json')) {
        const photoBase = name.slice(0, -'.supplemental-metadata.json'.length);
        if (entryNames.has(photoBase)) sidecarByPhoto.set(photoBase, e);
        continue;
      }
      const stripped = name.slice(0, -5);
      if (entryNames.has(stripped)) {
        sidecarByPhoto.set(stripped, e);
      }
    }

    // For each photo entry in this album folder, try to match it back to an
    // existing indexed_files row. The sidecar's `title` is the canonical
    // original filename (Google preserves the device name there even when
    // the on-disk ZIP entry was mangled). Matching strategy:
    //   1. Preferred — (original_filename, derived_date) where the date
    //      comes from sidecar photoTakenTime. Date is invariant under
    //      PDR's Fix pipeline (Fix writes EXIF, growing the file size,
    //      but never changes the taken-date), so this works for any
    //      Confirmed-or-Recovered file.
    //   2. Fallback — (original_filename, size_bytes) for files PDR
    //      Marked (no derived date stored) where the on-disk size
    //      still matches the ZIP's uncompressed size. Catches the no-
    //      sidecar case.
    // We try each candidate name (sidecar.title, then ZIP entry name)
    // against the date matcher first, then against the size matcher.
    for (const e of entries) {
      const name = basenameOf(e);
      const lower = name.toLowerCase();
      if (lower === 'metadata.json' || lower.endsWith('.json')) continue;
      const ext = path.extname(lower);
      if (!MEDIA_EXTENSIONS.has(ext)) continue;

      stats.photosConsidered++;

      const sidecarEntry = sidecarByPhoto.get(name);
      let sidecarTitle: string | null = null;
      let sidecarDescription: string | null = null;
      let sidecarDerivedDate: string | null = null;
      if (sidecarEntry) {
        try {
          const buf = await sidecarEntry.buffer();
          const text = buf.toString('utf-8');
          const data = parseGoogleTakeoutJsonContent(text);
          if (data) {
            sidecarTitle = data.title?.trim() || null;
            sidecarDescription = data.description?.trim() || null;
            sidecarDerivedDate = takeoutTimestampToDerivedDate(data.timestamp);
          }
        } catch {
          // Bad sidecar — fall through; we can still try matching by ZIP name + size.
        }
      }

      const sizeBytes = e.uncompressedSize ?? 0;
      const candidateNames = [sidecarTitle, name].filter((s): s is string => !!s);
      let resolvedFileId: number | undefined;
      if (sidecarDerivedDate) {
        for (const candidate of candidateNames) {
          const id = findFileIdByOriginalNameAndDate(candidate, sidecarDerivedDate);
          if (id) { resolvedFileId = id; break; }
        }
      }
      if (!resolvedFileId) {
        for (const candidate of candidateNames) {
          const id = findFileIdByOriginalNameAndSize(candidate, sizeBytes);
          if (id) { resolvedFileId = id; break; }
        }
      }

      if (!resolvedFileId) {
        stats.unmatched++;
        continue;
      }

      stats.matchedAgainstLibrary++;
      fileEnrichments.push({
        destPath: '', // Unused — resolvedFileId takes precedence in the importer.
        resolvedFileId,
        albumExternalKey: externalKey,
        albumTitle,
        sidecarTitle,
        sidecarDescription,
      });
    }
  }

  const enrichment = fileEnrichments.length > 0
    ? { gatheredAt: Date.now(), files: fileEnrichments }
    : null;
  return { enrichment, stats };
}

// ─── Post-index album write ──────────────────────────────────────────────────

/**
 * Apply a pending enrichment after the indexer has inserted rows for `runId`.
 * Groups files by album, upserts the album rows, links memberships, applies
 * caption + corrected original_filename. Emits the per-album detection log
 * line that Terry uses to eyeball correctness against a real Takeout.
 *
 * Logs through `logger` (defaults to console.log with a `[Takeout]` prefix)
 * so the lines land in main.log without needing a child logger.
 */
export function importTakeoutAlbumsFromEnrichment(
  enrichment: PendingTakeoutEnrichment,
  /** runId is consulted only when an enrichment entry lacks resolvedFileId
   *  (the Fix-path case). Backfill enrichments pre-resolve every file_id at
   *  gather time and pass -1 here; the run-scoped lookup is then skipped. */
  runId: number,
  logger: (line: string) => void = (line) => console.log(`[Takeout] ${line}`),
): TakeoutImportSummary {
  const grouped = new Map<string, { title: string; files: TakeoutFileEnrichment[] }>();
  for (const f of enrichment.files) {
    const existing = grouped.get(f.albumExternalKey);
    if (existing) existing.files.push(f);
    else grouped.set(f.albumExternalKey, { title: f.albumTitle, files: [f] });
  }

  const summary: TakeoutImportSummary = {
    albumsCreated: 0,
    albumsUpdated: 0,
    totalFilesLinked: 0,
    totalOriginalFilenamesRecovered: 0,
    totalCaptionsApplied: 0,
    perAlbum: [],
  };

  for (const [externalKey, group] of grouped) {
    const albumId = upsertTakeoutAlbum(externalKey, group.title);

    let filesLinked = 0;
    let originalFilenamesRecovered = 0;
    let captionsApplied = 0;
    let unresolvedFiles = 0;

    for (const file of group.files) {
      const fileId = file.resolvedFileId ?? (runId >= 0 ? findFileIdByPathInRun(runId, file.destPath) : undefined);
      if (!fileId) {
        unresolvedFiles++;
        continue;
      }

      const linked = linkAlbumFile(albumId, fileId);
      if (linked) filesLinked++;

      const applied = applyTakeoutSidecarMetadata(fileId, file.sidecarTitle, file.sidecarDescription);
      if (applied.originalFilenameUpdated) originalFilenamesRecovered++;
      if (applied.captionSet) captionsApplied++;
    }

    const totalForAlbum = group.files.length;
    logger(
      `Album: ${JSON.stringify(group.title)} → ${filesLinked} files linked, ` +
      `original_filenames recovered: ${originalFilenamesRecovered}/${totalForAlbum}, ` +
      `captions: ${captionsApplied}/${totalForAlbum}` +
      (unresolvedFiles > 0 ? ` (${unresolvedFiles} unresolved — not yet indexed)` : '')
    );

    summary.perAlbum.push({
      externalKey,
      title: group.title,
      filesLinked,
      originalFilenamesRecovered,
      captionsApplied,
      unresolvedFiles,
    });
    summary.totalFilesLinked += filesLinked;
    summary.totalOriginalFilenamesRecovered += originalFilenamesRecovered;
    summary.totalCaptionsApplied += captionsApplied;
  }

  // Created vs updated isn't tracked at upsert-time (the helper doesn't
  // surface it); albumsCreated stays 0 and the per-album lines above are the
  // canonical detection signal. If we ever need create/update split, it's a
  // one-line change in upsertTakeoutAlbum to return the flag.
  summary.albumsCreated = summary.perAlbum.length;

  logger(
    `Import complete: ${summary.albumsCreated} album(s), ` +
    `${summary.totalFilesLinked} file(s) linked, ` +
    `${summary.totalOriginalFilenamesRecovered} original filename(s) recovered, ` +
    `${summary.totalCaptionsApplied} caption(s) applied.`
  );

  return summary;
}
