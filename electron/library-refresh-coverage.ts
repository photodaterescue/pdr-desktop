// DEV-0005 — shared "is this walked file already covered?" logic for a library
// Refresh. Extracted into its own module with ZERO Electron/DB imports so it is
// (a) unit-testable without an Electron runtime and (b) uses the SAME coverage
// definition as the Dashboard "unindexed libraries" banner
// (library:countOnDiskFiles in main.ts).
//
// ── Root cause of DEV-0005 ──────────────────────────────────────────────────
// Symptom (Terry, Version 3.1): the Dashboard banner reports ~45 files missing
// from the index while a Refresh reads thousands as new (e.g. 9,847) and the
// dashboard total balloons (11,941) from transient duplicate rows.
//
// The two code paths used CONFLICTING definitions of "already have this file":
//
//   Banner  (main.ts library:countOnDiskFiles) — a file is COVERED when its
//           (filename, size_bytes) exists ANYWHERE in indexed_files, regardless
//           of drive/path. So a MOVED library (new paths, identical files) is
//           fully covered and only the genuinely-new files are reported.
//
//   Refresh (search-indexer.ts pre-filter) — a file was only skipped when its
//           EXACT file_path was already indexed (findExistingFilePaths). After a
//           library is moved to a new drive, none of the new paths match, so the
//           whole library is EXIF-re-read and re-inserted under new paths; the
//           duplicates are only merged later by consolidateIndexedFilesByFilename-
//           AndSize at startup (hence the transient dashboard inflation).
//
// This module makes Refresh adopt the banner's (filename,size)-anywhere
// coverage definition, so the two agree and a moved library is no longer
// re-read wholesale.
//
// Scope note (for review): this fix SKIPS re-reading files that are covered
// elsewhere; it does not re-point their file_path to the new drive. Re-pointing
// a moved library (updating file_path in place to preserve face/AI attachments
// by row id) is a larger, separate enhancement.

export function coverageKey(filename: string, sizeBytes: number): string {
  return `${filename} ${sizeBytes}`;
}

export interface WalkedCandidate {
  path: string; // absolute file path on disk
  filename: string; // basename of path
  size: number; // size in bytes from fs.stat (-1 if unreadable → treated as new)
}

// Returns the candidates that are GENUINELY NEW: not already indexed by exact
// file_path AND not covered by (filename, size) anywhere in the index.
//
//   existingByPath     — from findExistingFilePaths (exact file_path match)
//   coveredByNameSize  — coverageKey(filename,size) for every indexed row
export function selectGenuinelyNewFiles(
  candidates: WalkedCandidate[],
  existingByPath: Set<string>,
  coveredByNameSize: Set<string>,
): WalkedCandidate[] {
  return candidates.filter(
    (c) =>
      !existingByPath.has(c.path) &&
      !coveredByNameSize.has(coverageKey(c.filename, c.size)),
  );
}
