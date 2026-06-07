import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IndexedRun {
  id: number;
  report_id: string;
  destination_path: string;
  indexed_at: string;
  file_count: number;
  source_labels: string;
}

export interface IndexedFile {
  id: number;
  run_id: number;
  // File identity
  file_path: string;
  filename: string;
  extension: string;
  file_type: string; // 'photo' | 'video'
  size_bytes: number;
  hash: string | null;
  // PDR data
  confidence: string; // 'confirmed' | 'recovered' | 'marked'
  date_source: string;
  original_filename: string;
  // Parsed date components
  derived_date: string | null;
  year: number | null;
  month: number | null;
  day: number | null;
  // Device / capture metadata
  camera_make: string | null;
  camera_model: string | null;
  lens_model: string | null;
  width: number | null;
  height: number | null;
  megapixels: number | null;
  iso: number | null;
  shutter_speed: string | null;
  aperture: number | null;
  focal_length: number | null;
  flash_fired: number | null; // 0/1
  // Scene / shooting metadata
  scene_capture_type: string | null; // 'Standard' | 'Landscape' | 'Portrait' | 'Night' etc.
  exposure_program: string | null;   // 'Manual' | 'Aperture Priority' | 'Shutter Priority' etc.
  white_balance: string | null;      // 'Auto' | 'Manual' | 'Daylight' etc.
  orientation: string | null;        // 'Horizontal' | 'Rotate 90 CW' etc.
  camera_position: string | null;    // 'rear' | 'front' | 'wide' | 'telephoto' | 'macro' | 'panoramic' | null
  // GPS
  gps_lat: number | null;
  gps_lon: number | null;
  gps_alt: number | null;
  // Reverse-geocoded location
  geo_country: string | null;
  geo_country_code: string | null;
  geo_city: string | null;
  // Indexer metadata
  exif_read_ok: number; // 0/1
  indexed_at: string;
  // v2.0.13 — user-applied caption (also populated from Google Takeout
  // sidecar.description during Fix / Enrichment). Editable per-photo
  // via the right-click "Caption…" item in Albums / By Date / S&D.
  // Optional in the type so the indexer's insert payload doesn't have
  // to declare it for every newly-indexed row (DB default is NULL).
  caption?: string | null;
  // v2.0.15 Phase 3b — Viewer Enhance marker. See migration in
  // initSearchDatabase for the value taxonomy. NULL for ordinary
  // photos; populated only when the file came from "Save Enhanced".
  enhancement_type?: string | null;
  // v2.1 — clip-trim parent reference. See migration above.
  clip_of_file_id?: number | null;
}

export interface SearchQuery {
  text?: string;
  confidence?: string[];
  fileType?: string[];
  dateSource?: string[];
  // Date range — full start/end date strings 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS'
  dateFrom?: string;
  dateTo?: string;
  // Legacy year/month (still supported)
  yearFrom?: number;
  yearTo?: number;
  monthFrom?: number;
  monthTo?: number;
  cameraMake?: string[];
  cameraModel?: string[];
  lensModel?: string[];
  hasGps?: boolean;
  country?: string[];
  city?: string[];
  runId?: number;
  destinationPath?: string[];
  extension?: string[];
  isoFrom?: number;
  isoTo?: number;
  apertureFrom?: number;
  apertureTo?: number;
  focalLengthFrom?: number;
  focalLengthTo?: number;
  flashFired?: boolean;
  megapixelsFrom?: number;
  megapixelsTo?: number;
  sizeFrom?: number;
  sizeTo?: number;
  // Scene / shooting filters
  sceneCaptureType?: string[];
  exposureProgram?: string[];
  whiteBalance?: string[];
  cameraPosition?: string[];
  orientation?: string[];
  // AI filters
  personId?: number[];
  personIdMode?: 'and' | 'or';
  /** When true, the person filter only matches photos where the user
   *  has explicitly confirmed the face (face_detections.verified = 1)
   *  — auto-matched faces from refineFromVerifiedFaces are excluded.
   *  Legacy boolean kept for backwards-compat; new code should use
   *  `personMatchMode` below which supports the 'matched' state too. */
  personVerifiedOnly?: boolean;
  /** Tri-state filter for the S&D AI ribbon's Matched / Verified /
   *  Both toggle:
   *    - 'matched'   = only auto-matched faces (verified = 0)
   *    - 'verified'  = only manually-confirmed (verified = 1)
   *    - 'both'      = either (no filter)
   *  When set, takes precedence over `personVerifiedOnly`. */
  personMatchMode?: 'matched' | 'verified' | 'both';
  /** Cosine similarity floor for AUTO-MATCHED faces (the score
   *  refineFromVerifiedFaces stored when the face was matched).
   *  Drives the S&D Match Sensitivity slider — moving the slider
   *  filters auto-matches live without re-running refinement.
   *  Verified faces (verified=1) are never gated by this. */
  personMatchThreshold?: number;
  // Tag mode mirrors personIdMode: 'or' (default) = any tag; 'and' = every
  // tag must be present on the file.
  aiTagMode?: 'and' | 'or';
  // How the personId and aiTag conditions relate to each other when BOTH
  // are present. Defaults to 'and' (photos must match BOTH the person and
  // the tag filter — the existing behaviour). 'or' yields a union so the
  // ribbon search bar can express "Mel OR beach" queries when the user
  // combines a person and a tag with a comma.
  textFilterJoin?: 'and' | 'or';
  aiTag?: string[];
  hasFaces?: boolean;
  hasUnnamedFaces?: boolean;
  hasAiTags?: boolean;
  hasNamedPeople?: boolean;
  /** v2.0.14 — restrict to files whose `caption` is non-empty.
   *  Powers the gold "Captioned only" chip in S&D's header,
   *  mirrored from AlbumsView / MemoriesView drilldown. */
  hasCaption?: boolean;
  /** v2.0.15 Phase 3b (Terry 2026-06-06) — restrict to files where
   *  `enhancement_type IS NOT NULL`. Powers the S&D "Enhanced" chip.
   *  Filename suffix (_E) is the user-visible marker; the actual
   *  filter reads the indexed_files column so reliability isn't
   *  coupled to whether the user has renamed the file later. */
  isEnhanced?: boolean;
  aiProcessed?: 'all' | 'unprocessed' | 'faces_only' | 'tags_only' | 'both';
  faceCountMin?: number;
  faceCountMax?: number;
  personTogetherIds?: number[];
  /** v2.0.8 step 5 — restrict results to photos that are members of
   *  one of these albums. Empty/undefined = no album filter.
   *  Multi-select uses IN — photos in ANY of the listed albums. */
  albumIds?: number[];
  /** v2.0.15 (Terry 2026-06-01) — pile filter from Memories' "Send
   *  to S&D" action. When set to a non-empty array, restricts the
   *  result set to exactly these indexed_files.id values via
   *  `f.id IN (...)`. Distinct from a normal filter — UI clears all
   *  other filters when the pile is active so the user sees the
   *  hand-picked set as-is. */
  fileIds?: number[];
  sortBy?: 'derived_date' | 'filename' | 'size_bytes' | 'confidence' | 'camera_model' | 'iso' | 'aperture' | 'focal_length' | 'megapixels';
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  files: IndexedFile[];
  total: number;
  limit: number;
  offset: number;
}

export interface FilterOptions {
  confidences: string[];
  fileTypes: string[];
  lensModels: string[];
  dateSources: string[];
  years: number[];
  cameraMakes: string[];
  cameraModels: string[];
  extensions: string[];
  sceneCaptureTypes: string[];
  exposurePrograms: string[];
  whiteBalances: string[];
  cameraPositions: string[];
  orientations: string[];
  countries: string[];
  cities: string[];
  destinations: string[];
  runs: Array<{ id: number; report_id: string; destination_path: string; indexed_at: string; file_count: number }>;
  /** Per-option file counts. Keys match the corresponding string[]
   *  values above (e.g. counts.country['Italy'] = 243). Empty-string
   *  / NULL rows are aggregated into the "(No X)" sentinel label
   *  where one exists (country / city / make / model / lens). */
  counts: {
    confidence: Record<string, number>;
    fileType: Record<string, number>;
    dateSource: Record<string, number>;
    cameraMake: Record<string, number>;
    cameraModel: Record<string, number>;
    lensModel: Record<string, number>;
    extension: Record<string, number>;
    sceneCaptureType: Record<string, number>;
    exposureProgram: Record<string, number>;
    whiteBalance: Record<string, number>;
    cameraPosition: Record<string, number>;
    orientation: Record<string, number>;
    country: Record<string, number>;
    city: Record<string, number>;
    destination: Record<string, number>;
  };
}

export interface IndexStats {
  totalFiles: number;
  totalRuns: number;
  totalPhotos: number;
  totalVideos: number;
  totalSizeBytes: number;
  oldestDate: string | null;
  newestDate: string | null;
  dbSizeBytes: number;
}

export interface FavouriteFilter {
  id: number;
  name: string;
  query_json: string;
  created_at: string;
}

// ─── Database singleton ──────────────────────────────────────────────────────

let db: Database.Database | null = null;

function getDbPath(): string {
  const dir = path.join(app.getPath('userData'), 'search-index');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'pdr-search.db');
}

export function initDatabase(): { success: boolean; error?: string } {
  try {
    if (db) return { success: true };

    const dbPath = getDbPath();

    // ─── Pre-open snapshot ─────────────────────────────────────
    // Take an auto-launch snapshot before we open the live DB. We
    // use the new typed naming scheme (snapshot-auto-launch-<ts>.db)
    // and the granular-retention pruner runs first so older
    // snapshots get demoted to daily/weekly buckets instead of
    // dropping off a hard 5-launch cliff.
    try {
      if (fs.existsSync(dbPath)) {
        const backupDir = path.join(path.dirname(dbPath), 'backups');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        // Promote / prune existing auto-launch snapshots into the
        // 5-launch + 7-day + 4-week tiers.
        try { pruneAutoSnapshots(); } catch {}
        // Take the new launch snapshot.
        const ts = new Date().toISOString().replace(/[:]/g, '-');
        const dst = path.join(backupDir, `snapshot-auto-launch-${ts}.db`);
        fs.copyFileSync(dbPath, dst);
      }
    } catch (backupErr) {
      console.warn('[DB] Startup snapshot failed (non-fatal):', backupErr);
    }

    db = new Database(dbPath);

    // Performance pragmas
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000'); // 64MB cache
    db.pragma('foreign_keys = ON');

    // Create schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS indexed_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id     TEXT    NOT NULL UNIQUE,
        destination_path TEXT NOT NULL,
        indexed_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        file_count    INTEGER NOT NULL DEFAULT 0,
        source_labels TEXT    NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS indexed_files (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id            INTEGER NOT NULL REFERENCES indexed_runs(id) ON DELETE CASCADE,
        -- File identity
        file_path         TEXT    NOT NULL,
        filename          TEXT    NOT NULL,
        extension         TEXT    NOT NULL,
        file_type         TEXT    NOT NULL,
        size_bytes        INTEGER NOT NULL DEFAULT 0,
        hash              TEXT,
        -- PDR data
        confidence        TEXT    NOT NULL,
        date_source       TEXT    NOT NULL DEFAULT '',
        original_filename TEXT    NOT NULL DEFAULT '',
        -- Parsed date components
        derived_date      TEXT,
        year              INTEGER,
        month             INTEGER,
        day               INTEGER,
        -- Device / capture metadata
        camera_make       TEXT,
        camera_model      TEXT,
        lens_model        TEXT,
        width             INTEGER,
        height            INTEGER,
        megapixels        REAL,
        iso               INTEGER,
        shutter_speed     TEXT,
        aperture          REAL,
        focal_length      REAL,
        flash_fired       INTEGER,
        -- Scene / shooting metadata
        scene_capture_type TEXT,
        exposure_program  TEXT,
        white_balance     TEXT,
        orientation       TEXT,
        camera_position   TEXT,
        -- GPS
        gps_lat           REAL,
        gps_lon           REAL,
        gps_alt           REAL,
        -- Reverse-geocoded location
        geo_country       TEXT,
        geo_country_code  TEXT,
        geo_city          TEXT,
        -- Indexer metadata
        exif_read_ok      INTEGER NOT NULL DEFAULT 0,
        indexed_at        TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      -- Full-text search on filename and original_filename
      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
        filename,
        original_filename,
        content='indexed_files',
        content_rowid='id'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS files_fts_insert AFTER INSERT ON indexed_files BEGIN
        INSERT INTO files_fts(rowid, filename, original_filename) VALUES (new.id, new.filename, new.original_filename);
      END;

      CREATE TRIGGER IF NOT EXISTS files_fts_delete AFTER DELETE ON indexed_files BEGIN
        INSERT INTO files_fts(files_fts, rowid, filename, original_filename) VALUES ('delete', old.id, old.filename, old.original_filename);
      END;

      CREATE TRIGGER IF NOT EXISTS files_fts_update AFTER UPDATE ON indexed_files BEGIN
        INSERT INTO files_fts(files_fts, rowid, filename, original_filename) VALUES ('delete', old.id, old.filename, old.original_filename);
        INSERT INTO files_fts(rowid, filename, original_filename) VALUES (new.id, new.filename, new.original_filename);
      END;

      -- Favourite saved filters
      CREATE TABLE IF NOT EXISTS favourite_filters (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        query_json  TEXT    NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      -- Indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_files_run       ON indexed_files(run_id);
      CREATE INDEX IF NOT EXISTS idx_files_confidence ON indexed_files(confidence);
      CREATE INDEX IF NOT EXISTS idx_files_type       ON indexed_files(file_type);
      CREATE INDEX IF NOT EXISTS idx_files_year       ON indexed_files(year);
      CREATE INDEX IF NOT EXISTS idx_files_camera     ON indexed_files(camera_make, camera_model);
      CREATE INDEX IF NOT EXISTS idx_files_ext        ON indexed_files(extension);
      CREATE INDEX IF NOT EXISTS idx_files_date       ON indexed_files(derived_date);
      CREATE INDEX IF NOT EXISTS idx_files_path       ON indexed_files(file_path);
      CREATE INDEX IF NOT EXISTS idx_files_scene      ON indexed_files(scene_capture_type);
      CREATE INDEX IF NOT EXISTS idx_files_position   ON indexed_files(camera_position);
      CREATE INDEX IF NOT EXISTS idx_files_country    ON indexed_files(geo_country);
      CREATE INDEX IF NOT EXISTS idx_files_city       ON indexed_files(geo_city);
      -- Hash + (original_filename, size_bytes) + (original_filename,
      -- derived_date) lookups: used by the Takeout backfill flow to
      -- match sidecar entries back to existing indexed_files rows when
      -- re-running album import against a ZIP on a library that's
      -- already been Fixed. The derived_date variant is the primary
      -- key because PDR's Fix writes EXIF (changing file size) but
      -- never changes the taken-date — so date is invariant across
      -- the Fix pipeline while size is not.
      CREATE INDEX IF NOT EXISTS idx_files_hash       ON indexed_files(hash);
      CREATE INDEX IF NOT EXISTS idx_files_origname_size ON indexed_files(original_filename, size_bytes);
      CREATE INDEX IF NOT EXISTS idx_files_origname_date ON indexed_files(original_filename, derived_date);

      -- ═══ AI Recognition Tables ═══

      -- Tracks which files have been processed by AI
      CREATE TABLE IF NOT EXISTS ai_processing_status (
        file_id          INTEGER PRIMARY KEY REFERENCES indexed_files(id) ON DELETE CASCADE,
        face_processed   INTEGER NOT NULL DEFAULT 0,
        face_model_ver   TEXT,
        tags_processed   INTEGER NOT NULL DEFAULT 0,
        tags_model_ver   TEXT,
        processed_at     TEXT
      );

      -- Detected faces with bounding boxes and embeddings
      CREATE TABLE IF NOT EXISTS face_detections (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id         INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
        person_id       INTEGER REFERENCES persons(id) ON DELETE SET NULL,
        box_x           REAL NOT NULL,
        box_y           REAL NOT NULL,
        box_w           REAL NOT NULL,
        box_h           REAL NOT NULL,
        embedding       BLOB,
        confidence      REAL NOT NULL,
        cluster_id      INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_face_file    ON face_detections(file_id);
      CREATE INDEX IF NOT EXISTS idx_face_person  ON face_detections(person_id);
      CREATE INDEX IF NOT EXISTS idx_face_cluster ON face_detections(cluster_id);

      -- Named people (user assigns names to face clusters)
      CREATE TABLE IF NOT EXISTS persons (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        avatar_data     TEXT,
        discarded_at    TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- AI-generated tags (object/scene classification)
      CREATE TABLE IF NOT EXISTS ai_tags (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id         INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
        tag             TEXT NOT NULL,
        confidence      REAL NOT NULL,
        source          TEXT NOT NULL DEFAULT 'ai',
        model_ver       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tag_file       ON ai_tags(file_id);
      CREATE INDEX IF NOT EXISTS idx_tag_name       ON ai_tags(tag);
      CREATE INDEX IF NOT EXISTS idx_tag_confidence ON ai_tags(confidence);

      -- FTS5 for AI-generated content (tags + person names), searchable alongside filenames
      CREATE VIRTUAL TABLE IF NOT EXISTS files_ai_fts USING fts5(
        ai_tags,
        person_names,
        content='',
        content_rowid='rowid'
      );

      -- ═══ Albums (v2.0.8) ═══
      -- Albums are virtual groupings of files. A photo lives in one
      -- row of indexed_files but can belong to many albums via the
      -- album_files join table.
      --
      -- source values (no CHECK constraint — kept open so future sources
      --   like 'apple_photos_imported' can land without a schema migration):
      --     'user_created'      — created in PDR's UI
      --     'takeout_imported'  — auto-created from a Google Photos Takeout
      --
      -- external_album_key — for Takeout imports, the original Google folder
      -- name (e.g. "Italy 2019"). Stays stable across PDR-side renames.
      -- NULL for user_created albums. The partial unique index below
      -- guarantees that a second Takeout import with the same folder
      -- name merges into the existing album rather than creating a
      -- duplicate — and ONLY collides with other takeout_imported rows,
      -- so a user's hand-curated "Italy 2019" can never silently absorb
      -- Google's photos.
      --
      -- cover_file_id — optional manual pick (manual-pick UI lands in
      -- v2.0.9). When NULL, callers fall back to the first album_file
      -- by photo's taken-date at render time. ON DELETE SET NULL so a
      -- deleted cover photo doesn't break the album.
      CREATE TABLE IF NOT EXISTS albums (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        title               TEXT    NOT NULL,
        description         TEXT,
        cover_file_id       INTEGER REFERENCES indexed_files(id) ON DELETE SET NULL,
        external_album_key  TEXT,
        source              TEXT    NOT NULL DEFAULT 'user_created',
        created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_albums_source ON albums(source);
      -- Cross-Takeout dedupe key: same external_album_key within
      -- takeout_imported rows can only exist once. User-created albums
      -- (external_album_key IS NULL) are unaffected.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_external_key
        ON albums(external_album_key)
        WHERE external_album_key IS NOT NULL AND source = 'takeout_imported';

      -- Junction table — photos in albums. Composite primary key
      -- doubles as the UNIQUE(album_id, file_id) constraint so re-running
      -- the Takeout importer on the same source can use INSERT OR IGNORE
      -- and stay idempotent.
      --
      -- No 'position' column in v2.0.8 — order is taken-date at query
      -- time (ORDER BY indexed_files.derived_date, indexed_files.id).
      -- Manual reorder lands in v2.0.9 with a 'position INTEGER' ALTER.
      CREATE TABLE IF NOT EXISTS album_files (
        album_id   INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
        file_id    INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
        added_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (album_id, file_id)
      );
      CREATE INDEX IF NOT EXISTS idx_album_files_file ON album_files(file_id);

      -- ═══ Album organisation (v2.0.8 hierarchical multi-membership groups) ═══
      -- Hierarchical tagging layer over the flat albums table. Lets the
      -- user drop the same album into multiple folders without
      -- duplicating it, while every album also carries an immutable
      -- "auto" membership in its source group (e.g. "Google Photos
      -- Takeout", "Created here") so the source identity is never lost.
      --
      -- parent_id NULL = root-level (visible at the top of the tree).
      -- App-layer enforces a max depth of 3 levels (root, sub, album)
      -- via createUserAlbumGroup. The schema itself doesn't cap it so
      -- system-managed reorganisation can repair edge cases without
      -- fighting a CHECK constraint.
      --
      -- source_kind:
      --   'auto' = system-managed group, one per distinct albums.source
      --            value. Auto-created on migration + on every new
      --            source import. Title / icon / palette baked in from
      --            ALBUM_SOURCE_PROFILES (see below). NOT user-editable,
      --            NOT deletable, parent_id always NULL.
      --   'user' = user-created folder. Fully editable; nestable up to
      --            the depth cap; deletable (cascades to memberships).
      --
      -- source_key: for 'auto' groups, the matching albums.source value.
      --             NULL for 'user' groups. The partial unique index
      --             below guarantees one auto group per source.
      --
      -- icon_key + palette_key: render hints consumed by the renderer's
      -- AlbumSourceProfile helper. Stored as string keys so new sources
      -- can be added without a column type change.
      CREATE TABLE IF NOT EXISTS album_groups (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        title        TEXT    NOT NULL,
        parent_id    INTEGER REFERENCES album_groups(id) ON DELETE CASCADE,
        source_kind  TEXT    NOT NULL DEFAULT 'user',
        source_key   TEXT,
        icon_key     TEXT,
        palette_key  TEXT,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_album_groups_parent ON album_groups(parent_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_album_groups_auto_source
        ON album_groups(source_key)
        WHERE source_kind = 'auto' AND source_key IS NOT NULL;

      -- Many-to-many: an album can live in many groups simultaneously.
      -- is_auto flags the system-managed source membership; UI refuses
      -- to remove those. Composite PK gives idempotent INSERT OR IGNORE
      -- semantics so the auto-seed migration below can run on every
      -- startup without growing duplicates.
      CREATE TABLE IF NOT EXISTS album_group_memberships (
        album_id   INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
        group_id   INTEGER NOT NULL REFERENCES album_groups(id) ON DELETE CASCADE,
        is_auto    INTEGER NOT NULL DEFAULT 0,
        added_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (album_id, group_id)
      );
      CREATE INDEX IF NOT EXISTS idx_album_group_memberships_group ON album_group_memberships(group_id);

      -- ═══ v2.0.13: Cross-part Google Takeout sidecar cache ═══
      --
      -- Google's multi-part Takeout exports split the same photo and
      -- its JSON sidecar across DIFFERENT zip files. Photo X might be
      -- in takeout-007 while its sidecar lives in takeout-008. PDR
      -- analyses one part at a time, so a photo whose sidecar is in
      -- a different part gets a degraded date (filename pattern or
      -- mtime, marked _RC or _MK) when it should have had a precise
      -- _CF date from photoTakenTime.
      --
      -- This table holds the FULL contents of every JSON sidecar
      -- found across every Takeout part the user has registered.
      -- Populated by takeout:preScanSidecars which walks each zip's
      -- central directory and reads only the JSON entries (no photo
      -- bytes touched — minutes, not hours, for an 8-part Takeout).
      --
      -- The analysis pipeline consults this table BEFORE falling
      -- back to the filename-pattern rule, so a photo finds its
      -- sidecar regardless of which zip it lives in.
      --
      -- The Enrichment pass also reads this to retroactively upgrade
      -- _RC and _MK files whose sidecars arrived in later parts —
      -- additive only (see additive-only rule below).
      CREATE TABLE IF NOT EXISTS takeout_sidecars (
        -- Group key: the shared timestamp prefix of a multi-part
        -- export (e.g. "20260503T203552Z" from "takeout-20260503T203552Z-3-008.zip").
        -- Two separate Takeout exports made on different days don't
        -- mix metadata even if a photo appears in both.
        takeout_group_id    TEXT    NOT NULL,
        -- The photo filename the sidecar references — extracted from
        -- the sidecar's own filename ("IMG-20170118-WA0007.jpeg" from
        -- "IMG-20170118-WA0007.jpeg.supplemental-metadata.json"), with
        -- a fallback to the JSON's "title" field if the sidecar name
        -- was truncated by Google's 47-character cap.
        photo_basename      TEXT    NOT NULL,
        -- Which zip the sidecar came out of, for audit / debugging.
        source_zip          TEXT    NOT NULL,
        -- Precise photo-taken timestamp (the one we actually want).
        -- NULL if Google didn't record one for this photo.
        photo_taken_unix    INTEGER,
        -- Upload-to-Google timestamp. Fallback when photoTakenTime
        -- is missing — still better than filename-pattern noon.
        creation_unix       INTEGER,
        -- GPS coordinates if Google captured them (camera GPS or
        -- user-tagged location). NULL when absent.
        gps_lat             REAL,
        gps_lon             REAL,
        -- User-typed caption / description from Google Photos.
        description         TEXT,
        -- Origin tag — "googlePhotosOrigin" field, e.g. "mobileUpload",
        -- "fromPartnerSharing", "scan", "screenshot". Useful for the
        -- scanner-demotion path we already have in date-extraction.
        google_origin       TEXT,
        -- Flags. Stored as 0/1 so SQLite booleans work cleanly.
        favorited           INTEGER NOT NULL DEFAULT 0,
        trashed             INTEGER NOT NULL DEFAULT 0,
        -- People + albums kept as JSON arrays — schema-stable as
        -- Google adds new fields, and the consumer side (Enrichment
        -- pass + face_detections seeding) does its own parsing.
        people_json         TEXT,
        album_titles_json   TEXT,
        -- Raw sidecar verbatim. Bytes-cheap insurance — if Google
        -- adds a new field tomorrow, we don't need a schema
        -- migration to capture it for old scans.
        raw_json            TEXT    NOT NULL,
        scanned_at          TEXT    NOT NULL DEFAULT (datetime('now')),
        -- One sidecar row per (group, photo). INSERT OR IGNORE is
        -- safe so re-running the pre-scan after adding more parts
        -- doesn't bloat the table; only new (group, photo) combos
        -- land.
        PRIMARY KEY (takeout_group_id, photo_basename)
      );
      -- Lookups: most queries are by basename across all groups
      -- (analysis-time lookup) or by group (LDM "what's been
      -- scanned" panel). Index both.
      CREATE INDEX IF NOT EXISTS idx_takeout_sidecars_basename
        ON takeout_sidecars(photo_basename);
      CREATE INDEX IF NOT EXISTS idx_takeout_sidecars_group
        ON takeout_sidecars(takeout_group_id);

      -- ═══ v2.0.13: Enrichment audit log ═══
      --
      -- One row per change applied by the Enrichment pass. Lets the
      -- user (or support) see exactly what got upgraded and roll
      -- back if needed. Cheaper than a full undo stack — the entries
      -- record before/after dates + flags, which is enough to
      -- reconstruct the rename if anyone ever asks for it.
      CREATE TABLE IF NOT EXISTS enrichment_log (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id             INTEGER REFERENCES indexed_files(id) ON DELETE CASCADE,
        run_at              TEXT    NOT NULL DEFAULT (datetime('now')),
        old_file_path       TEXT,
        new_file_path       TEXT,
        old_confidence      TEXT,
        new_confidence      TEXT,
        old_derived_date    TEXT,
        new_derived_date    TEXT,
        -- What kinds of metadata the upgrade wrote into EXIF.
        -- Comma-separated subset of: 'date', 'gps', 'description'.
        exif_fields_written TEXT,
        -- Why we changed it — e.g. "takeout_sidecar:20260503T203552Z".
        source              TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_enrichment_log_file ON enrichment_log(file_id);
      CREATE INDEX IF NOT EXISTS idx_enrichment_log_run_at ON enrichment_log(run_at);

      -- v2.0.13 (Terry 2026-05-26) — one row per Enrichment pass.
      -- Powers the "Last enriched X ago — N files upgraded" line in
      -- the Library Drive Manager so the user can see at a glance
      -- when they last ran the pass without opening the modal. Kept
      -- separate from enrichment_log because that table has one row
      -- PER CHANGE — useful for audit detail, not for a "show me the
      -- last run" summary. enrichment_runs has one row PER RUN.
      CREATE TABLE IF NOT EXISTS enrichment_runs (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        finished_at          TEXT    NOT NULL DEFAULT (datetime('now')),
        inspected            INTEGER NOT NULL DEFAULT 0,
        upgraded             INTEGER NOT NULL DEFAULT 0,
        deduped_duplicates   INTEGER NOT NULL DEFAULT 0,
        distinct_collisions  INTEGER NOT NULL DEFAULT 0,
        exif_date_writes     INTEGER NOT NULL DEFAULT 0,
        exif_gps_writes      INTEGER NOT NULL DEFAULT 0,
        exif_desc_writes     INTEGER NOT NULL DEFAULT 0,
        face_hints_added     INTEGER NOT NULL DEFAULT 0,
        errors               INTEGER NOT NULL DEFAULT 0,
        elapsed_ms           INTEGER NOT NULL DEFAULT 0,
        cancelled            INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_enrichment_runs_finished_at ON enrichment_runs(finished_at);
    `);

    // Auto-seed source groups + memberships. Idempotent so every startup
    // reconciles: any new `albums.source` value that doesn't yet have an
    // auto group gets one; any album without its auto source membership
    // gets it linked. Runs after the CREATE TABLE block above so the
    // tables exist; only writes when there's something missing so the
    // happy path is two cheap SELECTs.
    try {
      const ALBUM_SOURCE_PROFILES: Record<string, { title: string; icon_key: string; palette_key: string }> = {
        user_created:     { title: 'PDR',                   icon_key: 'home',      palette_key: 'violet'   },
        takeout_imported: { title: 'Google Photos',         icon_key: 'sparkles',  palette_key: 'red'      },
        // Future sources (apple_photos, icloud, onedrive, google_drive,
        // dropbox, amazon_photos) will be added to this table as their
        // importers land. Any source value not in this table falls back
        // to a neutral cloud icon + sky palette in the renderer.
      };
      const distinctSources = db.prepare(
        `SELECT DISTINCT source FROM albums WHERE source IS NOT NULL AND source != ''`
      ).all() as { source: string }[];
      const groupInsert = db.prepare(
        `INSERT OR IGNORE INTO album_groups (title, source_kind, source_key, icon_key, palette_key, parent_id)
           VALUES (?, 'auto', ?, ?, ?, NULL)`
      );
      for (const { source } of distinctSources) {
        const profile = ALBUM_SOURCE_PROFILES[source]
          ?? { title: source, icon_key: 'cloud', palette_key: 'sky' };
        groupInsert.run(profile.title, source, profile.icon_key, profile.palette_key);
      }
      // Link every existing album to its source's auto group. INSERT OR
      // IGNORE skips albums that already have the membership, so this is
      // cheap on warm startups.
      db.exec(`
        INSERT OR IGNORE INTO album_group_memberships (album_id, group_id, is_auto)
        SELECT a.id, g.id, 1
          FROM albums a
          JOIN album_groups g
            ON g.source_kind = 'auto' AND g.source_key = a.source
      `);
      // 2026-05-18 rename — the user_created auto group was originally
      // titled "Created here". Terry's call: shorter, brand-anchored
      // "PDR" reads better and matches the source-name convention of
      // every other auto group. Existing DBs get migrated in-place;
      // new DBs get the right title from the seed above. Title-equality
      // guard ensures we don't clobber a user who's manually edited
      // their own (unlikely — auto groups aren't renamable in the UI,
      // but defensive). Same for the icon_key bump from pencil → home,
      // see the v2.0.8 polish round where the PencilLine icon was
      // misread as a "click to rename" affordance.
      db.exec(`
        UPDATE album_groups
           SET title    = 'PDR',
               icon_key = 'home',
               updated_at = datetime('now')
         WHERE source_kind = 'auto'
           AND source_key  = 'user_created'
           AND title       = 'Created here'
      `);
      // Same trim for the Takeout group — Terry 2026-05-18: "We don't
      // need to have the word Takeout do we? It's only important to
      // know where it came from, not the method." Title-equality
      // guard means a user who somehow customised it gets to keep
      // their choice.
      db.exec(`
        UPDATE album_groups
           SET title    = 'Google Photos',
               updated_at = datetime('now')
         WHERE source_kind = 'auto'
           AND source_key  = 'takeout_imported'
           AND title       = 'Google Photos Takeout'
      `);
    } catch (seedErr) {
      console.error('[DB] Album-groups auto-seed failed:', seedErr);
    }

    // Migrate existing databases — add new columns if missing
    const cols = db.prepare(`PRAGMA table_info(indexed_files)`).all() as { name: string }[];
    const colNames = new Set(cols.map(c => c.name));
    const newCols = [
      { name: 'scene_capture_type', type: 'TEXT' },
      { name: 'exposure_program', type: 'TEXT' },
      { name: 'white_balance', type: 'TEXT' },
      { name: 'orientation', type: 'TEXT' },
      { name: 'camera_position', type: 'TEXT' },
      { name: 'geo_country', type: 'TEXT' },
      { name: 'geo_country_code', type: 'TEXT' },
      { name: 'geo_city', type: 'TEXT' },
      // User-applied rotation, in degrees (0/90/180/270). Stored
      // alongside the photo metadata so the PDR Viewer can re-apply
      // the rotation the user picked the next time they open the
      // same file. Independent of EXIF orientation — that's already
      // honoured by the renderer; this is the user's manual override
      // on top of whatever the camera wrote.
      { name: 'user_rotation', type: 'INTEGER NOT NULL DEFAULT 0' },
      // Per-photo caption (v2.0.8). Populated from Google Takeout's
      // sidecar JSON description field during Fix or backfill. Lives on
      // indexed_files (per-photo) rather than album_files (per-membership)
      // because the same photo in three albums has one caption. Not
      // currently in the files_fts FTS5 index — caption search lands in
      // v2.0.9 alongside the FTS rebuild.
      { name: 'caption', type: 'TEXT' },
      // v2.0.15 — PDR Recycle Bin (Terry 2026-05-28). Soft-delete
      // marker: when set to 1, the file is hidden from every view
      // (Memories, Albums, S&D) but the underlying photo file and
      // index row stay intact, so Restore is one click. Timestamp
      // when moved to the bin, in ISO 8601 — used for "Recently
      // deleted" sort and any future auto-empty policy.
      { name: 'in_recycle_bin', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'recycled_at', type: 'TEXT' },
      // v2.0.15 Phase 3b (Terry 2026-06-06) — PDR Viewer Enhance
      // marker. NULL for ordinary photos; populated when the file
      // came from the Viewer's "Save Enhanced" flow.
      //   'manual'      = sliders only (current default in v2.0.15)
      //   'codeformer'  = AI face restoration (Phase 5)
      //   'realesrgan'  = AI upscaling (Phase 6)
      //   'manual+ai'   = sliders + AI in one save (Phase 7)
      // The S&D "Enhanced" filter chip filters on IS NOT NULL; the
      // manual/AI split popover (deferred to Phase 5+) reads the
      // exact value to filter further.
      { name: 'enhancement_type', type: 'TEXT' },
      // v2.1 (Terry 2026-06-07) — Clip-trim parent reference. NULL
      // for ordinary files; set to the originating indexed_files.id
      // when this row represents a clip produced by the Viewer's
      // Trim flow. Lets "show original" actions jump back from a
      // clip to its parent, and powers a future "Clips only" S&D
      // filter chip.
      { name: 'clip_of_file_id', type: 'INTEGER' },
    ];
    for (const col of newCols) {
      if (!colNames.has(col.name)) {
        db.exec(`ALTER TABLE indexed_files ADD COLUMN ${col.name} ${col.type}`);
      }
    }

    // Migrate persons table — add discarded_at column if missing
    const personCols = db.prepare(`PRAGMA table_info(persons)`).all() as { name: string }[];
    const personColNames = new Set(personCols.map(c => c.name));
    if (!personColNames.has('discarded_at')) {
      try { db.exec(`ALTER TABLE persons ADD COLUMN discarded_at TEXT`); } catch {}
    }

    // Migrate persons — add representative_face_id if missing (user-chosen avatar)
    if (!personColNames.has('representative_face_id')) {
      try { db.exec(`ALTER TABLE persons ADD COLUMN representative_face_id INTEGER`); } catch {}
    }

    // Migrate face_detections — add verified column if missing
    const faceCols = db.prepare(`PRAGMA table_info(face_detections)`).all() as { name: string }[];
    const faceColNames = new Set(faceCols.map(c => c.name));
    if (!faceColNames.has('verified')) {
      try { db.exec(`ALTER TABLE face_detections ADD COLUMN verified INTEGER NOT NULL DEFAULT 0`); } catch {}
    }
    // Store the cosine similarity score chosen by refineFromVerifiedFaces
    // when auto-matching a face to a person. Lets the S&D Match
    // slider filter results live at search time without re-running
    // the (expensive) refinement. NULL = either pre-refinement
    // legacy data or a manually-verified face (verified=1 is its
    // own signal). Only auto-matched faces (verified=0 + person_id
    // != NULL) carry a score.
    if (!faceColNames.has('match_similarity')) {
      try { db.exec(`ALTER TABLE face_detections ADD COLUMN match_similarity REAL`); } catch {}
    }

    // v2.0.13 — Takeout people-hint seeds. Google's Takeout JSON
    // sidecars sometimes include a `people` array — names Google
    // associated with a photo (via Google Photos face groups + manual
    // tags). The Enrichment pass writes those names here as a SEED
    // candidate for PDR's People Manager, NEVER as an override.
    //
    // The additive-only rule (Terry 2026-05-26): if face_detections
    // already has a person_id set OR the face has been verified by
    // the user, the takeout_name_hint is IGNORED. The hint exists
    // only to help PDR's existing face-clustering pipeline suggest
    // names for clusters that don't yet have one. The user always
    // wins.
    //
    // takeout_name_source records which Takeout group the hint came
    // from, so re-running the Enrichment after adding more parts
    // can refresh hints without polluting them with stale data.
    if (!faceColNames.has('takeout_name_hint')) {
      try { db.exec(`ALTER TABLE face_detections ADD COLUMN takeout_name_hint TEXT`); } catch {}
    }
    if (!faceColNames.has('takeout_name_source')) {
      try { db.exec(`ALTER TABLE face_detections ADD COLUMN takeout_name_source TEXT`); } catch {}
    }

    // v2.1 round 9 (Terry 2026-06-07) — one-shot backfill for the
    // brief Mark-a-face bug (between 8427918 and 7cb724f) that
    // inserted manual face_detection rows with cluster_id = NULL.
    // PM's getPersonClusters filters those out, so the faces were
    // invisible. The fix in 7cb724f assigns a fresh unique
    // cluster_id at insert time, but pre-existing NULL rows from
    // the broken window stay invisible without this. UPDATE
    // assigns each affected row a unique cluster_id (max + id) so
    // they form singleton clusters that PM picks up. Idempotent —
    // any subsequent launch finds zero matching rows and runs as
    // a no-op. Filter on `embedding IS NULL` so we ONLY touch
    // manual marks (auto-detected faces always have embeddings).
    try {
      const before = db.prepare(`SELECT COUNT(*) AS n FROM face_detections WHERE cluster_id IS NULL AND embedding IS NULL`).get() as { n: number };
      if (before.n > 0) {
        const r = db.prepare(`
          UPDATE face_detections
          SET cluster_id = (SELECT COALESCE(MAX(cluster_id), 0) FROM face_detections) + id
          WHERE cluster_id IS NULL AND embedding IS NULL
        `).run();
        console.log(`[search-db] Backfilled ${r.changes} manual face_detection row(s) with fresh cluster_ids (was invisible to PM)`);
      }
    } catch (e) {
      console.warn('[search-db] Manual face_detection backfill failed (non-fatal):', (e as Error).message);
    }

    // Trees v1 — relationship edges between persons.
    // Stored types:
    //   parent_of     — A is parent of B (with optional biological/step/adopted/in_law flags)
    //   spouse_of     — A and B are (or were) spouses/long-term partners. until date → ex.
    //   sibling_of    — A and B are siblings (can be stored directly, no shared-parent prereq)
    //   associated_with — non-family connection. flags.kind carries the specific label:
    //                     'friend' | 'close_friend' | 'acquaintance' | 'neighbour'
    //                     'colleague' | 'classmate' | 'teammate' | 'roommate'
    //                     'mentor' | 'mentee' | 'client' | 'manager'
    //                     'ex_partner' (ex-gf / ex-bf / ex-fiancé / short-term)
    //                     'other' (free-form; uses flags.label for the display name)
    //                  flags.ended = true marks historical ties (ex-colleague, ex-neighbour).
    db.exec(`
      CREATE TABLE IF NOT EXISTS relationships (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        person_a_id  INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        person_b_id  INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        type         TEXT NOT NULL CHECK(type IN ('parent_of', 'spouse_of', 'sibling_of', 'associated_with')),
        since        TEXT,
        until        TEXT,
        flags        TEXT,               -- JSON: { biological?, step?, adopted?, in_law?, half?, kind?, label?, ended? }
        confidence   REAL NOT NULL DEFAULT 1.0,
        source       TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'suggested'
        note         TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rel_a_type ON relationships(person_a_id, type);
      CREATE INDEX IF NOT EXISTS idx_rel_b_type ON relationships(person_b_id, type);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_unique ON relationships(person_a_id, person_b_id, type);
    `);

    // Migrate older relationships tables that were created with a CHECK
    // constraint predating the current type set. SQLite doesn't let us
    // alter a CHECK in place, so copy-swap the table if needed.
    try {
      const schemaRow = db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='relationships'`
      ).get() as { sql: string } | undefined;
      if (schemaRow && !schemaRow.sql.includes("'associated_with'")) {
        console.warn('[DB] Migrating relationships table to include associated_with type…');
        db.exec(`
          BEGIN;
          CREATE TABLE relationships_new (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            person_a_id  INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
            person_b_id  INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
            type         TEXT NOT NULL CHECK(type IN ('parent_of', 'spouse_of', 'sibling_of', 'associated_with')),
            since        TEXT,
            until        TEXT,
            flags        TEXT,
            confidence   REAL NOT NULL DEFAULT 1.0,
            source       TEXT NOT NULL DEFAULT 'user',
            note         TEXT,
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO relationships_new SELECT * FROM relationships;
          DROP TABLE relationships;
          ALTER TABLE relationships_new RENAME TO relationships;
          CREATE INDEX IF NOT EXISTS idx_rel_a_type ON relationships(person_a_id, type);
          CREATE INDEX IF NOT EXISTS idx_rel_b_type ON relationships(person_b_id, type);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_unique ON relationships(person_a_id, person_b_id, type);
          COMMIT;
        `);
      }
    } catch (migErr) {
      console.error('[DB] Relationships migration failed:', migErr);
    }

    // v2.0.15 (Terry 2026-05-31) — one-shot demotion of EXIF-laundered
    // rows. The rebuildIndexFromLibraries regression (now fixed via
    // filename-suffix preservation) had been silently promoting rows
    // whose PDR-renamed filename ends in _MK (PDR marked it because
    // no real date was found) to confidence='confirmed' on every
    // re-index. Terry's library had 199+ such files. This migration
    // walks indexed_files, identifies rows whose CURRENT filename
    // suffix is _MK but DB confidence is NOT 'marked', and demotes
    // them back. Idempotent — the UPDATE only touches matching rows,
    // so running twice is a no-op on the second pass.
    //
    // Matches PDR's rename convention since v2.0.x:
    //   <date>_<CF|RC|MK>(_NNN)?.<ext>
    // The regex covers the bare suffix and the disambiguation-counter
    // form (e.g. 2026-05-04_02-36-50_MK_001.jpg).
    try {
      const tDemote = Date.now();
      const demoteRes = db.prepare(`
        UPDATE indexed_files
        SET confidence = 'marked',
            date_source = 'unknown'
        WHERE confidence != 'marked'
          AND (
            filename LIKE '%\\_MK.%' ESCAPE '\\'
            OR filename LIKE '%\\_MK\\_%' ESCAPE '\\'
          )
      `).run();
      if (demoteRes.changes > 0) {
        console.log(`[DB] Demoted ${demoteRes.changes} laundered _MK row(s) back to confidence='marked' (${Date.now() - tDemote}ms)`);
      }
    } catch (demoteErr) {
      console.warn('[DB] Laundered-MK demotion migration failed (non-fatal):', demoteErr);
    }

    // Graph history — every relationship mutation (add / update / remove)
    // is logged with a reversible payload so the user can undo/redo
    // across sessions. Entries include a `forward` op (the mutation
    // that happened) and `inverse` op (what would undo it). The
    // `undone` flag tracks the undo/redo cursor: undone=1 means this
    // op has been undone; a redo flips it back to 0. Creating a NEW op
    // after an undo purges all undone entries — user branched.
    db.exec(`
      CREATE TABLE IF NOT EXISTS graph_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        kind        TEXT NOT NULL,
        forward     TEXT NOT NULL,
        inverse     TEXT NOT NULL,
        description TEXT,
        undone      INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_graph_history_created ON graph_history(created_at);
      CREATE INDEX IF NOT EXISTS idx_graph_history_undone ON graph_history(undone, id);
    `);

    // Saved trees — named view presets. Each captures a focus person +
    // filter state (Steps on/off + depth, Generations on/off + ↑/↓ depths).
    // Auto-saved as the user tweaks controls. Max 5 enforced at the
    // application layer (see listSavedTrees / saveTreeAs).
    db.exec(`
      CREATE TABLE IF NOT EXISTS saved_trees (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        name                 TEXT NOT NULL,
        focus_person_id      INTEGER REFERENCES persons(id) ON DELETE SET NULL,
        steps_enabled        INTEGER NOT NULL DEFAULT 1,
        steps_depth          INTEGER NOT NULL DEFAULT 3,
        generations_enabled  INTEGER NOT NULL DEFAULT 0,
        ancestors_depth      INTEGER NOT NULL DEFAULT 2,
        descendants_depth    INTEGER NOT NULL DEFAULT 2,
        last_opened_at       TEXT,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Per-tree canvas background image (data URL). Optional. Rendered
    // faded behind the family graph on each saved tree's canvas.
    const savedTreeCols = db.prepare(`PRAGMA table_info(saved_trees)`).all() as { name: string }[];
    const savedTreeColNames = new Set(savedTreeCols.map(c => c.name));
    if (!savedTreeColNames.has('background_image')) {
      try { db.exec(`ALTER TABLE saved_trees ADD COLUMN background_image TEXT`); } catch {}
    }
    if (!savedTreeColNames.has('background_opacity')) {
      try { db.exec(`ALTER TABLE saved_trees ADD COLUMN background_opacity REAL NOT NULL DEFAULT 0.15`); } catch {}
    }
    if (!savedTreeColNames.has('tree_contrast')) {
      // 0 → flat, 1 → maximum boost (stronger card shadow / darker borders
      // / halo around nodes). Lets the user keep cards legible on busy
      // background images.
      try { db.exec(`ALTER TABLE saved_trees ADD COLUMN tree_contrast REAL NOT NULL DEFAULT 0.3`); } catch {}
    }
    if (!savedTreeColNames.has('hidden_ancestor_person_ids')) {
      // JSON array of person IDs whose ancestry should be hidden from
      // this tree's view. Used when the user wants to suppress a
      // partner's family line without removing the partnership edge.
      try { db.exec(`ALTER TABLE saved_trees ADD COLUMN hidden_ancestor_person_ids TEXT NOT NULL DEFAULT '[]'`); } catch {}
    }
    if (!savedTreeColNames.has('use_gendered_labels')) {
      // When ON, relationship labels beneath card names render in
      // gendered form (Mother/Father/Sister/Brother/…) when the person
      // has a gender set. When OFF, labels stay neutral (Parent/
      // Sibling/…). Default ON so tree reads naturally once the user
      // starts filling in genders.
      try { db.exec(`ALTER TABLE saved_trees ADD COLUMN use_gendered_labels INTEGER NOT NULL DEFAULT 1`); } catch {}
    }
    if (!savedTreeColNames.has('hide_gender_marker')) {
      // When ON, the Mars/Venus/Combined symbol in the top-right of
      // each card is suppressed even for people whose gender is set.
      // Default OFF so the marker appears automatically as soon as the
      // user records a gender.
      try { db.exec(`ALTER TABLE saved_trees ADD COLUMN hide_gender_marker INTEGER NOT NULL DEFAULT 0`); } catch {}
    }
    if (!savedTreeColNames.has('excluded_suggestion_person_ids')) {
      // JSON array of person IDs the user has manually flagged as "not
      // part of this family" so they stop appearing as quick-add
      // suggestions. Hiding is reversible via the picker's review list.
      // Stored per tree so a person who's irrelevant to the Clapson
      // family can still be a valid candidate on a different tree.
      try { db.exec(`ALTER TABLE saved_trees ADD COLUMN excluded_suggestion_person_ids TEXT NOT NULL DEFAULT '[]'`); } catch {}
    }
    if (!savedTreeColNames.has('simplify_half_labels')) {
      // When ON, half-sibling relationships render as plain
      // Brother / Sister / Sibling rather than Half-brother /
      // Half-sister / Half-sibling. Terry's option for users who
      // prefer the everyday term over the technically-accurate one.
      // Data model isn't touched; only the rendered label changes.
      try { db.exec(`ALTER TABLE saved_trees ADD COLUMN simplify_half_labels INTEGER NOT NULL DEFAULT 0`); } catch {}
    }

    // Memories — user-selected monthly thumbnail overrides. Right-click
    // any photo in the month drilldown → "Set as monthly thumbnail" and
    // the bucket grid will show that photo instead of the default
    // (lowest-id) sample. One row per (year, month); a re-set overwrites.
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories_month_thumbs (
        year     INTEGER NOT NULL,
        month    INTEGER NOT NULL,
        file_id  INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (year, month)
      );
    `);

    // Persons life-event + marker columns for Trees.
    if (!personColNames.has('birth_date')) {
      try { db.exec(`ALTER TABLE persons ADD COLUMN birth_date TEXT`); } catch {}
    }
    if (!personColNames.has('death_date')) {
      try { db.exec(`ALTER TABLE persons ADD COLUMN death_date TEXT`); } catch {}
    }
    if (!personColNames.has('deceased_marker')) {
      // Icon drawn over the avatar when death_date is set.
      // Default: 'bluebell' (English bluebell). User-editable in v1.1.
      try { db.exec(`ALTER TABLE persons ADD COLUMN deceased_marker TEXT DEFAULT 'bluebell'`); } catch {}
    }
    if (!personColNames.has('is_placeholder')) {
      // Placeholder persons bridge skip-generation relationships
      // (grandparent, aunt/uncle, cousin) when the intermediate person
      // isn't yet named. They're hidden from People Manager and render
      // as ghost nodes in Trees until the user names or merges them.
      try { db.exec(`ALTER TABLE persons ADD COLUMN is_placeholder INTEGER NOT NULL DEFAULT 0`); } catch {}
    }
    if (!personColNames.has('card_background')) {
      // Optional per-person card background (data URL). Rendered faded
      // behind the card content in Trees. Independent of avatar.
      try { db.exec(`ALTER TABLE persons ADD COLUMN card_background TEXT`); } catch {}
    }
    if (!personColNames.has('gender')) {
      // One of: 'male' | 'female' | 'non_binary' | 'prefer_not_to_say'
      //       | 'unknown' | NULL. Drives gendered relationship labels
      // (Mother/Father/…) and the Mars/Venus/Combined symbol on the
      // card when the tree has gender markers enabled. NULL = not yet
      // set; no symbol, neutral labels.
      try { db.exec(`ALTER TABLE persons ADD COLUMN gender TEXT`); } catch {}
    }

    // Optional long-form name. Sits OUTSIDE the gender guard above
    // because gender shipped first — by the time full_name was
    // added, every existing DB already had `gender`, so a nested
    // gate would never fire. Standalone `if (!has('full_name'))`
    // ensures the migration runs once per DB regardless of which
    // earlier columns are already present.
    //
    // The existing `name` column is the SHORT form ("Terry" /
    // "Terry Clapson") shown in PM rows and S&D filter chips.
    // `full_name` is the OPTIONAL longer form ("Terry John Filmer
    // Clapson") shown on Trees cards where historical /
    // genealogical detail matters. NULL = no separate full name on
    // file; Trees falls back to `name`.
    if (!personColNames.has('full_name')) {
      try { db.exec(`ALTER TABLE persons ADD COLUMN full_name TEXT`); } catch {}
    }

    // Normalise any legacy double-backslash destination paths
    db.exec(`UPDATE indexed_runs SET destination_path = REPLACE(destination_path, '\\\\', '\\') WHERE destination_path LIKE '%\\\\%'`);

    // Clean up orphaned indexed_files rows left from runs deleted before foreign_keys was enabled
    db.exec(`DELETE FROM indexed_files WHERE run_id NOT IN (SELECT id FROM indexed_runs)`);
    // Clean up orphaned AI data for files that no longer exist
    db.exec(`DELETE FROM ai_processing_status WHERE file_id NOT IN (SELECT id FROM indexed_files)`);
    db.exec(`DELETE FROM face_detections WHERE file_id NOT IN (SELECT id FROM indexed_files)`);
    db.exec(`DELETE FROM ai_tags WHERE file_id NOT IN (SELECT id FROM indexed_files)`);
    // Clean up "Set as main photo" overrides whose underlying face row
    // was just deleted above (or by any past re-detection run that
    // happened before this safeguard existed). Catches the historic
    // breakage Terry hit where his chosen main photo silently changed.
    db.exec(`
      UPDATE persons
      SET representative_face_id = NULL
      WHERE representative_face_id IS NOT NULL
        AND representative_face_id NOT IN (SELECT id FROM face_detections)
    `);

    // FTS5 integrity check — contentless virtual tables can drift out of
    // sync with their source tables if rows are deleted directly. If the
    // index is corrupt, rebuild it from ai_tags + face_detections.
    // Runs once at init; per-file rebuilds self-heal too.
    try {
      if (!checkAiFtsIntegrity()) {
        console.warn('[FTS] files_ai_fts integrity check failed at startup; repairing…');
        repairAiFts();
      }
    } catch (ftsErr) {
      console.error('[FTS] Integrity check threw unexpectedly:', ftsErr);
    }

    // Consolidate any legacy duplicate indexed_files rows BEFORE the
    // UNIQUE index below is created (otherwise the index creation
    // would fail on the duplicate file_paths). This preserves every
    // verified face_detection, every ai_tag, every ai_processing_status
    // by moving them onto the surviving (winner) row first.
    try {
      consolidateIndexedFilesDuplicates();
    } catch (consErr) {
      console.error('[DB] file_path duplicate consolidation failed:', consErr);
    }

    // ALSO consolidate rows whose CONTENT is identical (same hash) but
    // which live at different file_paths. Happens when the same photo
    // exists in the source AND destination, or in multiple destination
    // folders from different fix runs. Same safe merge: all downstream
    // data moves onto the winner before losers are dropped.
    try {
      consolidateIndexedFilesByHash();
    } catch (consErr) {
      console.error('[DB] hash-based duplicate consolidation failed:', consErr);
    }

    // AND consolidate by (filename, size_bytes) — the hash column is not
    // populated by the current indexer, so hash-based dedup misses real
    // content duplicates. Filename+size is the strongest signal we can
    // actually run on existing rows. Same safe merge strategy.
    try {
      consolidateIndexedFilesByFilenameAndSize();
    } catch (consErr) {
      console.error('[DB] filename+size duplicate consolidation failed:', consErr);
    }

    // Face-detection dedup: if AI re-processing ever ran without
    // clearing the previous detections, the same face row can exist
    // multiple times for the same photo. Collapse identical groups,
    // preferring verified rows.
    try {
      deduplicateFaceDetections();
    } catch (fdErr) {
      console.error('[DB] face_detections dedup failed:', fdErr);
    }

    // Guarantee one indexed_files row per file_path going forward.
    // Paired with the INSERT ... ON CONFLICT(file_path) DO UPDATE in
    // insertFiles(), re-running a fix on the same source can never
    // produce duplicate rows again.
    try {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_indexed_files_file_path ON indexed_files(file_path)`);
    } catch (idxErr) {
      console.error('[DB] Could not create unique index on indexed_files.file_path:', idxErr);
    }

    // Backfill match_similarity for legacy auto-matched faces.
    // Without this, the S&D Match Sensitivity slider has nothing
    // to filter on for data that was matched before the column
    // existed (NULL → treated as bypass-the-gate). One-shot fill
    // on launch: cheap (<1s for typical libraries) and idempotent
    // (skipped on subsequent launches because the rows now have
    // scores). Works directly off existing person_id assignments
    // without re-running the matching algorithm or destabilising
    // the user's data.
    try {
      const legacyCount = (db.prepare(
        `SELECT COUNT(*) as cnt FROM face_detections WHERE person_id IS NOT NULL AND verified = 0 AND match_similarity IS NULL AND embedding IS NOT NULL`,
      ).get() as { cnt: number }).cnt;
      if (legacyCount > 0) {
        backfillMatchSimilarity(db);
      }
    } catch (backfillErr) {
      console.warn('[DB] match_similarity backfill failed (non-fatal):', backfillErr);
    }

    // ─── Long-path prefix cleanup (v2.0.9) ─────────────────────────
    // Rows inserted by the catch-up indexer before the v2.0.9 fix
    // carry a leading \\?\ Windows extended-length prefix on
    // file_path (or \\?\UNC\ for UNC paths). The prefix was needed
    // internally by walkMediaFiles so readdirSync could descend into
    // 260+ char trees, but it leaked into the DB write — and every
    // downstream consumer queries with the canonical (un-prefixed)
    // form, so the rows are invisible to:
    //   • the LDM per-library count (LIKE 'D:\…%')
    //   • the Dashboard banner gap check
    //   • the rebuild dedup (findExistingFilePaths) — which then
    //     caused a SECOND, prefixed copy of every Fix-indexed file
    //     to be inserted on the catch-up run.
    //
    // This migration:
    //   1. Reparents AI / album / cover-photo references off any
    //      prefixed row whose clean twin already exists, then drops
    //      the prefixed duplicate. UPDATE OR IGNORE handles the rare
    //      case where the clean row already has its own entry in a
    //      uniqueness-constrained child table (the dup's child is
    //      then CASCADE-deleted along with its parent — no data
    //      loss in practice because both children describe the same
    //      physical file).
    //   2. Strips the prefix off any remaining prefixed rows (those
    //      whose clean form doesn't yet exist) so they become
    //      countable by the LDM + banner queries.
    //
    // Idempotent — once all rows are clean, both phases no-op.
    // Wrapped in a single transaction so a mid-cleanup crash leaves
    // the DB in its pre-migration state, not a half-stripped mess.
    try {
      const prefixedCount = (db.prepare(
        `SELECT COUNT(*) AS cnt FROM indexed_files WHERE file_path LIKE '\\\\?\\%'`,
      ).get() as { cnt: number }).cnt;
      if (prefixedCount > 0) {
        console.warn(`[DB] long-path migration: cleaning ${prefixedCount} prefixed indexed_files rows…`);
        db.exec(`
          BEGIN;

          -- Pair every prefixed row with its clean twin (if one exists).
          CREATE TEMP TABLE _lp_pairs AS
          SELECT
            prefixed.id AS prefixed_id,
            clean.id    AS clean_id
          FROM indexed_files prefixed
          JOIN indexed_files clean ON clean.file_path = (
            CASE
              WHEN substr(prefixed.file_path, 1, 8) = '\\\\?\\UNC\\'
                THEN '\\\\' || substr(prefixed.file_path, 9)
              WHEN substr(prefixed.file_path, 1, 4) = '\\\\?\\'
                THEN substr(prefixed.file_path, 5)
              ELSE prefixed.file_path
            END
          ) AND clean.id != prefixed.id
          WHERE prefixed.file_path LIKE '\\\\?\\%';

          -- Reparent dependent rows from prefixed -> clean. OR IGNORE
          -- skips any row whose target would collide with a pre-existing
          -- entry on the clean row (e.g. duplicate ai_processing_status,
          -- duplicate album membership).
          UPDATE OR IGNORE face_detections SET file_id = (
            SELECT clean_id FROM _lp_pairs WHERE prefixed_id = face_detections.file_id
          )
          WHERE file_id IN (SELECT prefixed_id FROM _lp_pairs);

          UPDATE OR IGNORE ai_tags SET file_id = (
            SELECT clean_id FROM _lp_pairs WHERE prefixed_id = ai_tags.file_id
          )
          WHERE file_id IN (SELECT prefixed_id FROM _lp_pairs);

          UPDATE OR IGNORE ai_processing_status SET file_id = (
            SELECT clean_id FROM _lp_pairs WHERE prefixed_id = ai_processing_status.file_id
          )
          WHERE file_id IN (SELECT prefixed_id FROM _lp_pairs);

          UPDATE OR IGNORE album_files SET file_id = (
            SELECT clean_id FROM _lp_pairs WHERE prefixed_id = album_files.file_id
          )
          WHERE file_id IN (SELECT prefixed_id FROM _lp_pairs);

          UPDATE albums SET cover_file_id = (
            SELECT clean_id FROM _lp_pairs WHERE prefixed_id = albums.cover_file_id
          )
          WHERE cover_file_id IN (SELECT prefixed_id FROM _lp_pairs);

          -- Drop the prefixed duplicates. CASCADE on the FK columns mops
          -- up anything that couldn't be reparented above.
          DELETE FROM indexed_files
          WHERE id IN (SELECT prefixed_id FROM _lp_pairs);

          DROP TABLE _lp_pairs;

          -- Strip the prefix off rows that have no clean twin.
          UPDATE indexed_files
          SET file_path = CASE
            WHEN substr(file_path, 1, 8) = '\\\\?\\UNC\\' THEN '\\\\' || substr(file_path, 9)
            WHEN substr(file_path, 1, 4) = '\\\\?\\'      THEN substr(file_path, 5)
            ELSE file_path
          END
          WHERE file_path LIKE '\\\\?\\%';

          COMMIT;
        `);
        const remaining = (db.prepare(
          `SELECT COUNT(*) AS cnt FROM indexed_files WHERE file_path LIKE '\\\\?\\%'`,
        ).get() as { cnt: number }).cnt;
        console.warn(`[DB] long-path migration done — ${prefixedCount - remaining} rows cleaned, ${remaining} prefixed rows remain (should be 0)`);
      }
    } catch (lpErr) {
      console.error('[DB] long-path migration failed (non-fatal — DB left in pre-migration state):', lpErr);
    }

    return { success: true };
  } catch (err) {
    console.error('Failed to initialise search database:', err);
    return { success: false, error: (err as Error).message };
  }
}

/**
 * One-shot backfill of `match_similarity` for legacy auto-matched
 * faces. For every (face, person) pair where the face is linked to
 * a person but has no stored similarity (verified = 0, person_id
 * NOT NULL, match_similarity IS NULL), compute the cosine similarity
 * against the person's verified embeddings and store the max.
 *
 * Doesn't change person assignments — only fills in the score so
 * the S&D Match Sensitivity slider has something to filter on.
 *
 * Runs once after the schema migration adds the column. Subsequent
 * launches skip this entirely (the count check returns 0).
 */
export function backfillMatchSimilarity(database: Database.Database): void {
  // Pre-compute, per person, the list of verified embeddings (vector
  // + magnitude) so we don't reload the same data per face.
  const personIds = (database.prepare(
    `SELECT DISTINCT person_id FROM face_detections WHERE person_id IS NOT NULL AND verified = 0 AND match_similarity IS NULL AND embedding IS NOT NULL`,
  ).all() as Array<{ person_id: number }>).map(r => r.person_id);
  if (personIds.length === 0) return;

  const updateStmt = database.prepare(`UPDATE face_detections SET match_similarity = ? WHERE id = ?`);
  const verifiedStmt = database.prepare(`SELECT embedding FROM face_detections WHERE person_id = ? AND verified = 1 AND embedding IS NOT NULL`);
  const unfilledStmt = database.prepare(`SELECT id, embedding FROM face_detections WHERE person_id = ? AND verified = 0 AND match_similarity IS NULL AND embedding IS NOT NULL`);

  const tx = database.transaction(() => {
    let totalFilled = 0;
    for (const personId of personIds) {
      const verifiedRows = verifiedStmt.all(personId) as Array<{ embedding: Buffer }>;
      if (verifiedRows.length === 0) continue;
      // Pre-compute normalised vectors + magnitudes once per person.
      const firstVec = new Float32Array(verifiedRows[0].embedding.buffer, verifiedRows[0].embedding.byteOffset, verifiedRows[0].embedding.byteLength / 4);
      const dim = firstVec.length;
      const verifiedVecs: Float32Array[] = [];
      const verifiedMags: number[] = [];
      for (const vr of verifiedRows) {
        const v = new Float32Array(vr.embedding.buffer, vr.embedding.byteOffset, vr.embedding.byteLength / 4);
        let m = 0;
        for (let i = 0; i < dim; i++) m += v[i] * v[i];
        verifiedVecs.push(v);
        verifiedMags.push(Math.sqrt(m));
      }
      // Magnitude floor + top-K-average — same algorithm as
      // refineFromVerified above (see that function for the long-form
      // rationale on why max-of-verified was replaced).
      const sortedMags = [...verifiedMags].sort((a, b) => a - b);
      const medianMag = sortedMags.length ? sortedMags[Math.floor(sortedMags.length / 2)] : 0;
      const magnitudeFloor = medianMag * 0.6;
      const refVecs: Float32Array[] = [];
      const refMags: number[] = [];
      for (let k = 0; k < verifiedVecs.length; k++) {
        if (verifiedMags[k] >= magnitudeFloor) {
          refVecs.push(verifiedVecs[k]);
          refMags.push(verifiedMags[k]);
        }
      }
      const fallbackToFull = refVecs.length === 0;
      const useVecs = fallbackToFull ? verifiedVecs : refVecs;
      const useMags = fallbackToFull ? verifiedMags : refMags;
      const TOP_K = Math.min(5, useVecs.length);

      const unfilled = unfilledStmt.all(personId) as Array<{ id: number; embedding: Buffer }>;
      for (const row of unfilled) {
        const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
        let magB = 0;
        for (let i = 0; i < dim; i++) magB += vec[i] * vec[i];
        const magBSqrt = Math.sqrt(magB);
        const sims: number[] = [];
        for (let k = 0; k < useVecs.length; k++) {
          const va = useVecs[k];
          let dot = 0;
          for (let i = 0; i < dim; i++) dot += va[i] * vec[i];
          const denom = useMags[k] * magBSqrt;
          sims.push(denom === 0 ? 0 : dot / denom);
        }
        sims.sort((a, b) => b - a);
        let topKSum = 0;
        for (let k = 0; k < TOP_K; k++) topKSum += sims[k];
        const topKAvg = TOP_K > 0 ? topKSum / TOP_K : 0;
        updateStmt.run(topKAvg, row.id);
        totalFilled++;
      }
    }
    console.log(`[DB] Backfilled match_similarity for ${totalFilled} legacy auto-match${totalFilled === 1 ? '' : 'es'} across ${personIds.length} ${personIds.length === 1 ? 'person' : 'people'}`);
  });
  tx();
}

export function getDb(): Database.Database {
  if (!db) {
    const result = initDatabase();
    if (!result.success) {
      throw new Error(`Database not initialized: ${result.error}`);
    }
  }
  return db!;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ─── Run management ──────────────────────────────────────────────────────────

export function insertRun(reportId: string, destinationPath: string, sourceLabels: string): number {
  const database = getDb();
  // Normalise path: resolve double backslashes and trailing slashes
  const normalised = destinationPath.replace(/\\\\/g, '\\').replace(/\\$/, '');
  const stmt = database.prepare(
    `INSERT INTO indexed_runs (report_id, destination_path, source_labels) VALUES (?, ?, ?)`
  );
  const result = stmt.run(reportId, normalised, sourceLabels);
  return result.lastInsertRowid as number;
}

export function updateRunFileCount(runId: number, count: number): void {
  const database = getDb();
  database.prepare(`UPDATE indexed_runs SET file_count = ? WHERE id = ?`).run(count, runId);
}

export function removeRun(runId: number): void {
  const database = getDb();
  // CASCADE will delete indexed_files rows; FTS triggers will clean up FTS table
  database.prepare(`DELETE FROM indexed_runs WHERE id = ?`).run(runId);
}

export function removeRunByReportId(reportId: string): void {
  const database = getDb();
  database.prepare(`DELETE FROM indexed_runs WHERE report_id = ?`).run(reportId);
}

export function getRun(runId: number): IndexedRun | undefined {
  const database = getDb();
  return database.prepare(`SELECT * FROM indexed_runs WHERE id = ?`).get(runId) as IndexedRun | undefined;
}

export function getRunByReportId(reportId: string): IndexedRun | undefined {
  const database = getDb();
  return database.prepare(`SELECT * FROM indexed_runs WHERE report_id = ?`).get(reportId) as IndexedRun | undefined;
}

export function listRuns(): IndexedRun[] {
  const database = getDb();
  return database.prepare(`SELECT * FROM indexed_runs ORDER BY indexed_at DESC`).all() as IndexedRun[];
}

/**
 * Return the subset of the supplied file_paths that ALREADY have a row in
 * indexed_files. Used by the passive rebuild path to skip files the DB
 * already knows about, so a re-walk never overwrites their classification
 * or original_filename via the insertFiles UPSERT (v2.0.6 data-loss fix —
 * Parallel Library's post-copy rebuild was flipping master-library rows
 * from Recovered → Confirmed and blanking Original Names when the
 * destination overlapped an indexed tree). Path comparison is case-
 * insensitive on Windows but we leave it case-sensitive here because the
 * DB stores paths exactly as they were inserted and a same-machine
 * re-walk yields the same casing.
 */
export function findExistingFilePaths(filePaths: string[]): Set<string> {
  if (filePaths.length === 0) return new Set();
  const database = getDb();
  const existing = new Set<string>();
  // SQLite has a ~999-parameter limit per statement — chunk to be safe.
  const BATCH = 500;
  const stmt = (n: number) =>
    database.prepare(
      `SELECT file_path FROM indexed_files WHERE file_path IN (${Array(n).fill('?').join(',')})`,
    );
  for (let i = 0; i < filePaths.length; i += BATCH) {
    const chunk = filePaths.slice(i, i + BATCH);
    const rows = stmt(chunk.length).all(...chunk) as { file_path: string }[];
    for (const r of rows) existing.add(r.file_path);
  }
  return existing;
}

// ─── File insertion (batch) ──────────────────────────────────────────────────

/**
 * Insert (or upsert) files into the library index.
 *
 * Critical: the UNIQUE INDEX on `file_path` means re-indexing the same
 * destination file no longer creates a duplicate indexed_files row. On
 * conflict we UPDATE the existing row in place — preserving its `id`,
 * so `face_detections.file_id`, `ai_tags.file_id`, and every verified
 * face stays attached. The EXIF fields are refreshed from the new run,
 * but the row's identity (and downstream user work) is untouched.
 *
 * This replaces the old plain-INSERT behaviour that was responsible
 * for duplicate photos in People Manager and the cascade-wipe of
 * verified faces when purgeDuplicateIndexedFiles ran.
 */
export function insertFiles(runId: number, files: Omit<IndexedFile, 'id' | 'run_id' | 'indexed_at'>[]): number {
  const database = getDb();

  const stmt = database.prepare(`
    INSERT INTO indexed_files (
      run_id, file_path, filename, extension, file_type, size_bytes, hash,
      confidence, date_source, original_filename,
      derived_date, year, month, day,
      camera_make, camera_model, lens_model,
      width, height, megapixels,
      iso, shutter_speed, aperture, focal_length, flash_fired,
      scene_capture_type, exposure_program, white_balance, orientation, camera_position,
      gps_lat, gps_lon, gps_alt,
      geo_country, geo_country_code, geo_city,
      exif_read_ok
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?
    )
    ON CONFLICT(file_path) DO UPDATE SET
      run_id = excluded.run_id,
      filename = excluded.filename,
      extension = excluded.extension,
      file_type = excluded.file_type,
      size_bytes = excluded.size_bytes,
      hash = excluded.hash,
      confidence = excluded.confidence,
      date_source = excluded.date_source,
      original_filename = excluded.original_filename,
      derived_date = excluded.derived_date,
      year = excluded.year,
      month = excluded.month,
      day = excluded.day,
      camera_make = excluded.camera_make,
      camera_model = excluded.camera_model,
      lens_model = excluded.lens_model,
      width = excluded.width,
      height = excluded.height,
      megapixels = excluded.megapixels,
      iso = excluded.iso,
      shutter_speed = excluded.shutter_speed,
      aperture = excluded.aperture,
      focal_length = excluded.focal_length,
      flash_fired = excluded.flash_fired,
      scene_capture_type = excluded.scene_capture_type,
      exposure_program = excluded.exposure_program,
      white_balance = excluded.white_balance,
      orientation = excluded.orientation,
      camera_position = excluded.camera_position,
      gps_lat = excluded.gps_lat,
      gps_lon = excluded.gps_lon,
      gps_alt = excluded.gps_alt,
      geo_country = excluded.geo_country,
      geo_country_code = excluded.geo_country_code,
      geo_city = excluded.geo_city,
      exif_read_ok = excluded.exif_read_ok,
      indexed_at = datetime('now')
  `);

  const upsertMany = database.transaction((rows: typeof files) => {
    let count = 0;
    for (const f of rows) {
      stmt.run(
        runId, f.file_path, f.filename, f.extension, f.file_type, f.size_bytes, f.hash ?? null,
        f.confidence, f.date_source, f.original_filename,
        f.derived_date ?? null, f.year ?? null, f.month ?? null, f.day ?? null,
        f.camera_make ?? null, f.camera_model ?? null, f.lens_model ?? null,
        f.width ?? null, f.height ?? null, f.megapixels ?? null,
        f.iso ?? null, f.shutter_speed ?? null, f.aperture ?? null, f.focal_length ?? null, f.flash_fired ?? null,
        f.scene_capture_type ?? null, f.exposure_program ?? null, f.white_balance ?? null, f.orientation ?? null, f.camera_position ?? null,
        f.gps_lat ?? null, f.gps_lon ?? null, f.gps_alt ?? null,
        f.geo_country ?? null, f.geo_country_code ?? null, f.geo_city ?? null,
        f.exif_read_ok
      );
      count++;
    }
    return count;
  });

  return upsertMany(files);
}

// ─── Single-file upsert (Enhance save) ───────────────────────────────────────

/**
 * v2.0.15 (Terry 2026-06-06) — single-file upsert for the PDR Viewer's
 * "Save Enhanced" flow (Phase 3a).
 *
 * The new _E sibling is the same photo as its source — same capture
 * date, same camera, same GPS — only the pixels differ (sliders baked
 * in by sharp). So we inherit nearly the entire source row and only
 * recompute the few fields that genuinely change: size_bytes + hash
 * (new bytes on disk) and width/height/megapixels (in case orientation
 * fixed up dimensions during the sharp .rotate() pass).
 *
 * Why inherit run_id from the source row: every indexed_files row
 * points at an indexed_runs entry, and runs are the unit of "what
 * library scan brought this file in". The _E sibling logically
 * belongs to the same scan — there's no separate ENHANCE-RUN concept
 * in PDR, and creating a new run per save would balloon the runs
 * table for no benefit (and break run-scoped queries like "files
 * from the last Fix" by treating Enhance saves as their own runs).
 *
 * Returns the indexed_files.id of the upserted row, or null if the
 * source row can't be found (e.g. the source wasn't in the library
 * index yet — caller decides whether to surface that to the user).
 */
export async function indexEnhancedSibling(
  sourcePath: string,
  newPath: string,
  enhancementType: string = 'manual',
): Promise<number | null> {
  const database = getDb();

  // Look up the source row to inherit run_id + date + EXIF + GPS.
  // file_path is the unique key, so this is a single-row lookup.
  const sourceRow = database
    .prepare(`SELECT * FROM indexed_files WHERE file_path = ? LIMIT 1`)
    .get(sourcePath) as IndexedFile | undefined;

  if (!sourceRow) {
    // Source isn't indexed — the caller saved an Enhanced sibling to
    // a file the library doesn't know about. Without a source row we
    // have no run_id to attach to (NOT NULL with REFERENCES), and
    // fabricating a run for one orphan file is wrong. Return null and
    // let the caller log / surface — most likely path here is a user
    // opening a file outside their library directly in the viewer.
    return null;
  }

  // Fresh size + content hash from the new file. Use a streaming sha256
  // (same algorithm enrichment-engine uses for indexed_files.hash) so
  // duplicate-detection treats _E files consistently with the rest of
  // the library.
  const stat = await fs.promises.stat(newPath);
  const sizeBytes = stat.size;
  const newHash = await new Promise<string>((resolve, reject) => {
    // v2.1 (Terry 2026-06-07) — top-level `import * as crypto` instead
    // of `require('crypto')`. The require() form blew up at runtime
    // with "require is not defined" because search-database compiles
    // to ESM in the dev build, silently breaking BOTH Enhance and
    // Trim indexing (logged as "[viewer:*] index pass failed: require
    // is not defined") for the entire week the bug was live.
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(newPath, { highWaterMark: 64 * 1024 });
    stream.on('data', (chunk: string | Buffer) => h.update(chunk));
    stream.on('end', () => resolve(h.digest('hex')));
    stream.on('error', reject);
  });

  // New dimensions — the sharp .rotate() pass may have permuted width
  // and height if the source had a non-trivial EXIF orientation. Best-
  // effort: if dimension extraction fails, fall back to the source row.
  let width: number | null = sourceRow.width;
  let height: number | null = sourceRow.height;
  let megapixels: number | null = sourceRow.megapixels;
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(newPath, { failOnError: false }).metadata();
    if (meta.width && meta.height) {
      width = meta.width;
      height = meta.height;
      megapixels = Math.round((meta.width * meta.height) / 100_000) / 10;
    }
  } catch {
    // keep source dimensions
  }

  const newFilename = path.basename(newPath);
  const newExt = path.extname(newPath).toLowerCase().replace(/^\./, '');

  // Build the upsert payload by inheriting from the source, overriding
  // only the fields that genuinely change for the _E sibling.
  const payload: Omit<IndexedFile, 'id' | 'run_id' | 'indexed_at'> = {
    file_path: newPath,
    filename: newFilename,
    extension: newExt,
    file_type: sourceRow.file_type,
    size_bytes: sizeBytes,
    hash: newHash,
    confidence: sourceRow.confidence,
    date_source: sourceRow.date_source,
    original_filename: sourceRow.original_filename,
    derived_date: sourceRow.derived_date,
    year: sourceRow.year,
    month: sourceRow.month,
    day: sourceRow.day,
    camera_make: sourceRow.camera_make,
    camera_model: sourceRow.camera_model,
    lens_model: sourceRow.lens_model,
    width,
    height,
    megapixels,
    iso: sourceRow.iso,
    shutter_speed: sourceRow.shutter_speed,
    aperture: sourceRow.aperture,
    focal_length: sourceRow.focal_length,
    flash_fired: sourceRow.flash_fired,
    scene_capture_type: sourceRow.scene_capture_type,
    exposure_program: sourceRow.exposure_program,
    white_balance: sourceRow.white_balance,
    orientation: sourceRow.orientation,
    camera_position: sourceRow.camera_position,
    gps_lat: sourceRow.gps_lat,
    gps_lon: sourceRow.gps_lon,
    gps_alt: sourceRow.gps_alt,
    geo_country: sourceRow.geo_country,
    geo_country_code: sourceRow.geo_country_code,
    geo_city: sourceRow.geo_city,
    exif_read_ok: sourceRow.exif_read_ok,
  };

  insertFiles(sourceRow.run_id, [payload]);

  // Look up the just-inserted (or upserted) row's id so callers can
  // reference it for downstream linking (album membership, etc.).
  const idRow = database
    .prepare(`SELECT id FROM indexed_files WHERE file_path = ? LIMIT 1`)
    .get(newPath) as { id: number } | undefined;

  // v2.0.15 Phase 3b — stamp enhancement_type on the upserted row so
  // the S&D "Enhanced" filter chip can pick it up. Kept out of
  // insertFiles itself (which is the bulk Fix-run path) because the
  // field is only ever set by this single-file Enhance path; no
  // reason to bloat the bulk INSERT with a column that's NULL for
  // every other call site.
  if (idRow?.id != null) {
    database
      .prepare(`UPDATE indexed_files SET enhancement_type = ? WHERE id = ?`)
      .run(enhancementType, idRow.id);
  }

  return idRow?.id ?? null;
}

// ─── Single-file upsert (Clip trim) ──────────────────────────────────────────

/**
 * v2.1 (Terry 2026-06-07) — single-file upsert for the PDR Viewer's
 * "Trim clip" flow. Mirrors indexEnhancedSibling but sets
 * clip_of_file_id instead of enhancement_type, so the new row knows
 * which original it was clipped from.
 *
 * The clip inherits the parent's date / camera / GPS / run_id (it
 * IS the same recording, just shorter — same capture moment, same
 * location). Size + hash are recomputed from the new file on disk.
 * Width/height are inherited (ffmpeg -c copy preserves resolution).
 * Duration recomputed by the indexer on next walk if needed — for
 * v1 we don't try to update derived-date timestamps based on the
 * clip's in/out time, since the user typically wants the clip to
 * sort alongside the original.
 */
export async function indexTrimmedClip(
  sourcePath: string,
  newPath: string,
): Promise<number | null> {
  const database = getDb();

  const sourceRow = database
    .prepare(`SELECT * FROM indexed_files WHERE file_path = ? LIMIT 1`)
    .get(sourcePath) as IndexedFile | undefined;

  if (!sourceRow) return null;

  const stat = await fs.promises.stat(newPath);
  const sizeBytes = stat.size;
  const newHash = await new Promise<string>((resolve, reject) => {
    // v2.1 (Terry 2026-06-07) — top-level `import * as crypto` instead
    // of `require('crypto')`. The require() form blew up at runtime
    // with "require is not defined" because search-database compiles
    // to ESM in the dev build, silently breaking BOTH Enhance and
    // Trim indexing (logged as "[viewer:*] index pass failed: require
    // is not defined") for the entire week the bug was live.
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(newPath, { highWaterMark: 64 * 1024 });
    stream.on('data', (chunk: string | Buffer) => h.update(chunk));
    stream.on('end', () => resolve(h.digest('hex')));
    stream.on('error', reject);
  });

  const newFilename = path.basename(newPath);
  const newExt = path.extname(newPath).toLowerCase().replace(/^\./, '');

  const payload: Omit<IndexedFile, 'id' | 'run_id' | 'indexed_at'> = {
    file_path: newPath,
    filename: newFilename,
    extension: newExt,
    file_type: 'video',
    size_bytes: sizeBytes,
    hash: newHash,
    confidence: sourceRow.confidence,
    date_source: sourceRow.date_source,
    original_filename: sourceRow.original_filename,
    derived_date: sourceRow.derived_date,
    year: sourceRow.year,
    month: sourceRow.month,
    day: sourceRow.day,
    camera_make: sourceRow.camera_make,
    camera_model: sourceRow.camera_model,
    lens_model: sourceRow.lens_model,
    width: sourceRow.width,
    height: sourceRow.height,
    megapixels: sourceRow.megapixels,
    iso: sourceRow.iso,
    shutter_speed: sourceRow.shutter_speed,
    aperture: sourceRow.aperture,
    focal_length: sourceRow.focal_length,
    flash_fired: sourceRow.flash_fired,
    scene_capture_type: sourceRow.scene_capture_type,
    exposure_program: sourceRow.exposure_program,
    white_balance: sourceRow.white_balance,
    orientation: sourceRow.orientation,
    camera_position: sourceRow.camera_position,
    gps_lat: sourceRow.gps_lat,
    gps_lon: sourceRow.gps_lon,
    gps_alt: sourceRow.gps_alt,
    geo_country: sourceRow.geo_country,
    geo_country_code: sourceRow.geo_country_code,
    geo_city: sourceRow.geo_city,
    exif_read_ok: sourceRow.exif_read_ok,
  };

  insertFiles(sourceRow.run_id, [payload]);

  const idRow = database
    .prepare(`SELECT id FROM indexed_files WHERE file_path = ? LIMIT 1`)
    .get(newPath) as { id: number } | undefined;

  // Stamp the parent-reference column so the clip knows its origin.
  if (idRow?.id != null) {
    database
      .prepare(`UPDATE indexed_files SET clip_of_file_id = ? WHERE id = ?`)
      .run(sourceRow.id, idRow.id);
  }

  return idRow?.id ?? null;
}

/**
 * Merge one group of duplicate indexed_files rows onto a single winner.
 * Transfers face_detections (including verified faces), ai_tags (with
 * dedup), and ai_processing_status (OR-ing the flags) onto the winner
 * BEFORE deleting loser rows, so the ON DELETE CASCADE has nothing
 * left to wipe. Shared helper used by both file_path- and hash-based
 * consolidation paths.
 */
function mergeIndexedFilesIntoWinner(database: Database.Database, winnerId: number, loserIds: number[]): number {
  if (loserIds.length === 0) return 0;
  const moveFacesStmt = database.prepare(`UPDATE face_detections SET file_id = ? WHERE file_id = ?`);
  const copyTagsStmt = database.prepare(`
    INSERT OR IGNORE INTO ai_tags (file_id, tag, confidence, source, model_ver)
    SELECT ?, tag, confidence, source, model_ver FROM ai_tags WHERE file_id = ?
  `);
  const delTagsStmt = database.prepare(`DELETE FROM ai_tags WHERE file_id = ?`);
  const getStatusStmt = database.prepare(`SELECT * FROM ai_processing_status WHERE file_id = ?`);
  const mergeStatusStmt = database.prepare(`
    UPDATE ai_processing_status
    SET face_processed = CASE WHEN face_processed = 1 OR ? = 1 THEN 1 ELSE 0 END,
        tags_processed = CASE WHEN tags_processed = 1 OR ? = 1 THEN 1 ELSE 0 END,
        face_model_ver = COALESCE(face_model_ver, ?),
        tags_model_ver = COALESCE(tags_model_ver, ?)
    WHERE file_id = ?
  `);
  const moveStatusStmt = database.prepare(`UPDATE ai_processing_status SET file_id = ? WHERE file_id = ?`);
  const delStatusStmt = database.prepare(`DELETE FROM ai_processing_status WHERE file_id = ?`);
  // ─── Album / cover handling (v2.0.9 hotfix) ────────────────────
  // Albums (v2.0.8) added a new dependent table — album_files —
  // that wasn't taught to this merge routine. When the consolidator
  // ran on (clean, prefixed-catch-up) pairs from the v2.0.9
  // walkMediaFiles bug, it picked the higher-id prefixed row as
  // winner and deleted the lower-id clean row WITHOUT moving its
  // album memberships first. The FK cascade on album_files.file_id
  // then silently wiped 19 user-curated entries (Chiang Mai 1st
  // time + Amie Halloween 2017 v1) before Terry could see what
  // was happening. Same hole would have hit albums.cover_file_id
  // (SET NULL on delete — a manually-chosen cover would silently
  // revert to the auto-pick). Fix: copy album_files to the winner
  // (INSERT OR IGNORE for the rare case where the user added the
  // same physical photo to the same album via two different
  // duplicate rows) before deleting the loser, and re-point any
  // album.cover_file_id from loser → winner.
  const copyAlbumFilesStmt = database.prepare(`
    INSERT OR IGNORE INTO album_files (album_id, file_id, added_at)
    SELECT album_id, ?, added_at FROM album_files WHERE file_id = ?
  `);
  const delAlbumFilesStmt = database.prepare(`DELETE FROM album_files WHERE file_id = ?`);
  const movCoverStmt = database.prepare(`UPDATE albums SET cover_file_id = ? WHERE cover_file_id = ?`);
  const delFileStmt = database.prepare(`DELETE FROM indexed_files WHERE id = ?`);

  let removed = 0;
  for (const loserId of loserIds) {
    moveFacesStmt.run(winnerId, loserId);
    copyTagsStmt.run(winnerId, loserId);
    delTagsStmt.run(loserId);
    const loserStatus = getStatusStmt.get(loserId) as any;
    if (loserStatus) {
      const winnerStatus = getStatusStmt.get(winnerId) as any;
      if (winnerStatus) {
        mergeStatusStmt.run(
          loserStatus.face_processed ?? 0,
          loserStatus.tags_processed ?? 0,
          loserStatus.face_model_ver ?? null,
          loserStatus.tags_model_ver ?? null,
          winnerId
        );
        delStatusStmt.run(loserId);
      } else {
        moveStatusStmt.run(winnerId, loserId);
      }
    }
    // Copy album memberships before the cascade deletes them. Then
    // wipe the loser's rows explicitly so the subsequent file
    // delete doesn't leave dangling duplicates.
    copyAlbumFilesStmt.run(winnerId, loserId);
    delAlbumFilesStmt.run(loserId);
    // Re-point any album that used the loser as its cover photo
    // onto the winner — the user picked that physical photo as the
    // cover, and the winner row IS that physical photo post-merge.
    movCoverStmt.run(winnerId, loserId);
    delFileStmt.run(loserId);
    removed++;
  }
  return removed;
}

/**
 * Consolidate rows that share the SAME CONTENT HASH but live at
 * different paths. This catches the case where the same photo exists
 * at multiple locations (source + destination, or two destinations
 * from different fix runs), producing visually-duplicate entries in
 * People Manager. Each duplicate group collapses onto the highest-id
 * row, preserving every face_detection / ai_tag / ai_processing_status.
 *
 * Only runs when `hash` is a non-empty string. Rows with null/empty
 * hash are left alone (we can't prove they're duplicates).
 */
export function consolidateIndexedFilesByHash(): { groupsMerged: number; rowsRemoved: number } {
  const database = getDb();
  const groups = database.prepare(`
    SELECT hash, MAX(id) AS winner_id
    FROM indexed_files
    WHERE hash IS NOT NULL AND hash != ''
    GROUP BY hash
    HAVING COUNT(*) > 1
  `).all() as { hash: string; winner_id: number }[];

  if (groups.length === 0) return { groupsMerged: 0, rowsRemoved: 0 };

  let rowsRemoved = 0;
  const tx = database.transaction(() => {
    const loserStmt = database.prepare(
      `SELECT id FROM indexed_files WHERE hash = ? AND id != ?`
    );
    for (const group of groups) {
      const losers = (loserStmt.all(group.hash, group.winner_id) as { id: number }[]).map(r => r.id);
      rowsRemoved += mergeIndexedFilesIntoWinner(database, group.winner_id, losers);
    }
  });
  tx();

  console.warn(`[DB] Consolidated ${groups.length} same-content duplicate group(s); merged downstream data, dropped ${rowsRemoved} redundant row(s)`);
  return { groupsMerged: groups.length, rowsRemoved };
}

/**
 * Consolidate rows that share the same (filename, size_bytes). The
 * `hash` column on indexed_files is populated during fix-phase copies
 * but NOT by the current indexer — so hash-based dedup misses most
 * real duplicates. Filename + byte size is a strong enough signal for
 * duplicate detection in practice (the same photo rarely shares both
 * with a different picture), and it's what we can actually run on
 * the existing data.
 */
export function consolidateIndexedFilesByFilenameAndSize(): { groupsMerged: number; rowsRemoved: number } {
  const database = getDb();
  const groups = database.prepare(`
    SELECT filename, size_bytes, MAX(id) AS winner_id
    FROM indexed_files
    WHERE filename != '' AND size_bytes > 0
    GROUP BY filename, size_bytes
    HAVING COUNT(*) > 1
  `).all() as { filename: string; size_bytes: number; winner_id: number }[];

  if (groups.length === 0) {
    console.log('[DB] No filename+size duplicates found.');
    return { groupsMerged: 0, rowsRemoved: 0 };
  }

  let rowsRemoved = 0;
  const tx = database.transaction(() => {
    const loserStmt = database.prepare(
      `SELECT id FROM indexed_files WHERE filename = ? AND size_bytes = ? AND id != ?`
    );
    for (const group of groups) {
      const losers = (loserStmt.all(group.filename, group.size_bytes, group.winner_id) as { id: number }[]).map(r => r.id);
      rowsRemoved += mergeIndexedFilesIntoWinner(database, group.winner_id, losers);
    }
  });
  tx();

  console.warn(`[DB] Consolidated ${groups.length} filename+size duplicate group(s); merged downstream data, dropped ${rowsRemoved} redundant row(s)`);
  return { groupsMerged: groups.length, rowsRemoved };
}

/**
 * One-time consolidation of legacy duplicate indexed_files rows.
 *
 * Before the upsert was introduced, re-indexing the same destination
 * produced multiple indexed_files rows for the same file_path. This
 * routine merges each duplicate group onto a winner (MAX(id)) by
 * transferring all downstream data — face_detections (including
 * verified faces), ai_tags, and ai_processing_status — onto the
 * winner BEFORE dropping loser rows. Nothing user-entered is lost.
 *
 * Safe to call multiple times; does nothing if no duplicates remain.
 */
export function consolidateIndexedFilesDuplicates(): { groupsMerged: number; rowsRemoved: number } {
  const database = getDb();
  const groups = database.prepare(`
    SELECT file_path, MAX(id) AS winner_id
    FROM indexed_files
    GROUP BY file_path
    HAVING COUNT(*) > 1
  `).all() as { file_path: string; winner_id: number }[];

  if (groups.length === 0) return { groupsMerged: 0, rowsRemoved: 0 };

  let rowsRemoved = 0;
  const tx = database.transaction(() => {
    const loserStmt = database.prepare(
      `SELECT id FROM indexed_files WHERE file_path = ? AND id != ?`
    );
    for (const group of groups) {
      const losers = (loserStmt.all(group.file_path, group.winner_id) as { id: number }[]).map(r => r.id);
      rowsRemoved += mergeIndexedFilesIntoWinner(database, group.winner_id, losers);
    }
  });
  tx();

  console.warn(`[DB] Consolidated ${groups.length} duplicate file_path group(s); merged downstream data, dropped ${rowsRemoved} redundant row(s)`);
  return { groupsMerged: groups.length, rowsRemoved };
}

// ─── Search / Query ──────────────────────────────────────────────────────────

export function searchFiles(query: SearchQuery): SearchResult {
  const database = getDb();

  // v2.0.15 — recycled files never appear in S&D results. Bin
  // visibility is exclusively the Recycle Bin view's job.
  const conditions: string[] = ['(f.in_recycle_bin IS NULL OR f.in_recycle_bin = 0)'];
  const params: any[] = [];

  // Full-text search — queries filename FTS, AI tags FTS, and direct AI tag match
  if (query.text && query.text.trim()) {
    const rawText = query.text.trim().replace(/['"]/g, '');
    const searchTerm = rawText.split(/\s+/).map(t => `"${t}"*`).join(' ');
    const likePattern = `%${rawText.toLowerCase()}%`;
    conditions.push(`f.id IN (
      SELECT rowid FROM files_fts WHERE files_fts MATCH ?
      UNION
      SELECT rowid FROM files_ai_fts WHERE files_ai_fts MATCH ?
      UNION
      SELECT file_id FROM ai_tags WHERE LOWER(tag) LIKE ?
      UNION
      SELECT fd.file_id FROM face_detections fd JOIN persons p ON fd.person_id = p.id WHERE LOWER(p.name) LIKE ? AND p.discarded_at IS NULL
    )`);
    params.push(searchTerm, searchTerm, likePattern, likePattern);
  }

  // Confidence filter
  if (query.confidence && query.confidence.length > 0) {
    conditions.push(`f.confidence IN (${query.confidence.map(() => '?').join(',')})`);
    params.push(...query.confidence);
  }

  // File type filter
  if (query.fileType && query.fileType.length > 0) {
    conditions.push(`f.file_type IN (${query.fileType.map(() => '?').join(',')})`);
    params.push(...query.fileType);
  }

  // Date source filter
  if (query.dateSource && query.dateSource.length > 0) {
    conditions.push(`f.date_source IN (${query.dateSource.map(() => '?').join(',')})`);
    params.push(...query.dateSource);
  }

  // Full date range (start/end date strings)
  if (query.dateFrom) {
    conditions.push(`f.derived_date >= ?`);
    params.push(query.dateFrom);
  }
  if (query.dateTo) {
    // Add time to end of day if only date provided
    const endDate = query.dateTo.length <= 10 ? query.dateTo + ' 23:59:59' : query.dateTo;
    conditions.push(`f.derived_date <= ?`);
    params.push(endDate);
  }

  // Year range (legacy, still supported)
  if (query.yearFrom != null) {
    conditions.push(`f.year >= ?`);
    params.push(query.yearFrom);
  }
  if (query.yearTo != null) {
    conditions.push(`f.year <= ?`);
    params.push(query.yearTo);
  }

  // Month range
  if (query.monthFrom != null) {
    conditions.push(`f.month >= ?`);
    params.push(query.monthFrom);
  }
  if (query.monthTo != null) {
    conditions.push(`f.month <= ?`);
    params.push(query.monthTo);
  }

  // Sentinel-aware multi-select helper. When the user has ticked
  // the "(No X)" entry in the filter dropdown, treat that value as
  // "match NULL or empty string" for the column AND OR it with any
  // real values that were also selected. Centralised so country /
  // city / make / model / lens / album-source all share the logic.
  const sentinelAwareIn = (column: string, values: string[], nullSentinel: string): string | null => {
    const realValues = values.filter(v => v !== nullSentinel);
    const includeNull = values.includes(nullSentinel);
    const clauses: string[] = [];
    if (realValues.length > 0) {
      clauses.push(`${column} IN (${realValues.map(() => '?').join(',')})`);
      params.push(...realValues);
    }
    if (includeNull) {
      clauses.push(`(${column} IS NULL OR ${column} = '')`);
    }
    if (clauses.length === 0) return null;
    return clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`;
  };

  // Camera make
  if (query.cameraMake && query.cameraMake.length > 0) {
    const clause = sentinelAwareIn('f.camera_make', query.cameraMake, NO_CAMERA_MAKE_LABEL);
    if (clause) conditions.push(clause);
  }

  // Camera model
  if (query.cameraModel && query.cameraModel.length > 0) {
    const clause = sentinelAwareIn('f.camera_model', query.cameraModel, NO_CAMERA_MODEL_LABEL);
    if (clause) conditions.push(clause);
  }

  // GPS filter
  if (query.hasGps === true) {
    conditions.push(`f.gps_lat IS NOT NULL AND f.gps_lon IS NOT NULL`);
  } else if (query.hasGps === false) {
    conditions.push(`(f.gps_lat IS NULL OR f.gps_lon IS NULL)`);
  }

  // Country filter (sentinel-aware: "(No location)" → IS NULL)
  if (query.country && query.country.length > 0) {
    const clause = sentinelAwareIn('f.geo_country', query.country, NO_LOCATION_LABEL);
    if (clause) conditions.push(clause);
  }

  // City filter (sentinel-aware: "(No location)" → IS NULL)
  if (query.city && query.city.length > 0) {
    const clause = sentinelAwareIn('f.geo_city', query.city, NO_LOCATION_LABEL);
    if (clause) conditions.push(clause);
  }

  // Run filter
  if (query.runId != null) {
    conditions.push(`f.run_id = ?`);
    params.push(query.runId);
  }

  // Destination filter (normalise to handle legacy double-backslash entries)
  if (query.destinationPath && query.destinationPath.length > 0) {
    const normPaths = query.destinationPath.flatMap(p => {
      const norm = p.replace(/\\\\/g, '\\').replace(/\\$/, '');
      // Match both normalised and original double-backslash variants
      const dbl = norm.replace(/\\/g, '\\\\');
      return norm === dbl ? [norm] : [norm, dbl];
    });
    conditions.push(`f.run_id IN (SELECT id FROM indexed_runs WHERE destination_path IN (${normPaths.map(() => '?').join(',')}))`);
    params.push(...normPaths);
  }

  // Extension filter
  if (query.extension && query.extension.length > 0) {
    conditions.push(`f.extension IN (${query.extension.map(() => '?').join(',')})`);
    params.push(...query.extension);
  }

  // Lens model (sentinel-aware: "(No lens)" → IS NULL)
  if (query.lensModel && query.lensModel.length > 0) {
    const clause = sentinelAwareIn('f.lens_model', query.lensModel, NO_LENS_LABEL);
    if (clause) conditions.push(clause);
  }

  // ISO range
  if (query.isoFrom != null) { conditions.push(`f.iso >= ?`); params.push(query.isoFrom); }
  if (query.isoTo != null) { conditions.push(`f.iso <= ?`); params.push(query.isoTo); }

  // Aperture range
  if (query.apertureFrom != null) { conditions.push(`f.aperture >= ?`); params.push(query.apertureFrom); }
  if (query.apertureTo != null) { conditions.push(`f.aperture <= ?`); params.push(query.apertureTo); }

  // Focal length range
  if (query.focalLengthFrom != null) { conditions.push(`f.focal_length >= ?`); params.push(query.focalLengthFrom); }
  if (query.focalLengthTo != null) { conditions.push(`f.focal_length <= ?`); params.push(query.focalLengthTo); }

  // Flash fired
  if (query.flashFired === true) { conditions.push(`f.flash_fired = 1`); }
  else if (query.flashFired === false) { conditions.push(`f.flash_fired = 0`); }

  // Megapixels range
  if (query.megapixelsFrom != null) { conditions.push(`f.megapixels >= ?`); params.push(query.megapixelsFrom); }
  if (query.megapixelsTo != null) { conditions.push(`f.megapixels <= ?`); params.push(query.megapixelsTo); }

  // File size range (bytes)
  if (query.sizeFrom != null) { conditions.push(`f.size_bytes >= ?`); params.push(query.sizeFrom); }
  if (query.sizeTo != null) { conditions.push(`f.size_bytes <= ?`); params.push(query.sizeTo); }

  // Scene capture type
  if (query.sceneCaptureType && query.sceneCaptureType.length > 0) {
    conditions.push(`f.scene_capture_type IN (${query.sceneCaptureType.map(() => '?').join(',')})`);
    params.push(...query.sceneCaptureType);
  }

  // Exposure program
  if (query.exposureProgram && query.exposureProgram.length > 0) {
    conditions.push(`f.exposure_program IN (${query.exposureProgram.map(() => '?').join(',')})`);
    params.push(...query.exposureProgram);
  }

  // White balance
  if (query.whiteBalance && query.whiteBalance.length > 0) {
    conditions.push(`f.white_balance IN (${query.whiteBalance.map(() => '?').join(',')})`);
    params.push(...query.whiteBalance);
  }

  // Camera position (rear, front, wide, telephoto, macro, panoramic)
  if (query.cameraPosition && query.cameraPosition.length > 0) {
    conditions.push(`f.camera_position IN (${query.cameraPosition.map(() => '?').join(',')})`);
    params.push(...query.cameraPosition);
  }

  // Orientation
  if (query.orientation && query.orientation.length > 0) {
    conditions.push(`f.orientation IN (${query.orientation.map(() => '?').join(',')})`);
    params.push(...query.orientation);
  }

  // Album filter (v2.0.8 step 5) — restrict to photos that are
  // members of any of the listed albums via album_files. Uses IN
  // semantics: a photo matches if it's in ANY of the selected
  // albums (multi-select union). Empty/missing list = no constraint.
  if (query.albumIds && query.albumIds.length > 0) {
    conditions.push(
      `f.id IN (SELECT file_id FROM album_files WHERE album_id IN (${query.albumIds.map(() => '?').join(',')}))`
    );
    params.push(...query.albumIds);
  }

  // v2.0.15 (Terry 2026-06-01) — pile filter from Memories'
  // "Send to S&D" action. Restricts the result set to exactly the
  // listed indexed_files.id values. Renderer clears other filters
  // when the pile is active so this is the lone non-sort constraint.
  // SQLite's IN-list size is bounded by SQLITE_MAX_VARIABLE_NUMBER
  // (32766 in modern builds) — Terry's library would have to send a
  // list bigger than that for this to overflow; the UI multi-select
  // could realistically reach a few hundred at most.
  if (query.fileIds && query.fileIds.length > 0) {
    conditions.push(`f.id IN (${query.fileIds.map(() => '?').join(',')})`);
    params.push(...query.fileIds);
  }

  // AI: Person + Tag filters. Rendered as two SQL fragments first so we
  // can decide at the end whether to AND them into separate conditions
  // (default) or OR them into a single compound condition (used when the
  // user types "Mel, beach" — they want photos that match either).
  const personFragment = (() => {
    if (!query.personId || query.personId.length === 0) return null;
    const ph = query.personId.map(() => '?').join(',');
    // S&D AI ribbon Matched / Verified / Both toggle:
    //   matched  → fd.verified = 0  (auto-only, never confirmed)
    //   verified → fd.verified = 1  (manually-confirmed only)
    //   both     → no clause        (everything attached to the person)
    // Falls back to the legacy `personVerifiedOnly` boolean so old
    // saved-favourite filters still work without migration.
    const mode = query.personMatchMode
      ?? (query.personVerifiedOnly ? 'verified' : 'both');
    const verifiedClause =
      mode === 'verified' ? ' AND fd.verified = 1'
      : mode === 'matched' ? ' AND fd.verified = 0'
      : '';
    // Live similarity floor from the S&D Match Sensitivity slider.
    // Only applies to auto-matched faces (verified=0); verified
    // faces are user-confirmed truth and bypass the gate. NULL
    // scores (legacy data from before the migration) are also
    // bypassed so old auto-matches don't suddenly disappear.
    const simThreshold = typeof query.personMatchThreshold === 'number' ? query.personMatchThreshold : null;
    const similarityClause = simThreshold !== null && mode !== 'verified'
      ? ` AND (fd.verified = 1 OR fd.match_similarity IS NULL OR fd.match_similarity >= ${Number(simThreshold)})`
      : '';
    if (query.personIdMode === 'and' && query.personId.length > 1) {
      return {
        sql: `f.id IN (SELECT fd.file_id FROM face_detections fd WHERE fd.person_id IN (${ph})${verifiedClause}${similarityClause} GROUP BY fd.file_id HAVING COUNT(DISTINCT fd.person_id) = ?)`,
        params: [...query.personId, query.personId.length],
      };
    }
    return {
      sql: `f.id IN (SELECT fd.file_id FROM face_detections fd WHERE fd.person_id IN (${ph})${verifiedClause}${similarityClause})`,
      params: [...query.personId],
    };
  })();

  const tagFragment = (() => {
    if (!query.aiTag || query.aiTag.length === 0) return null;
    if (query.aiTagMode === 'and' && query.aiTag.length > 1) {
      // Every tag must be present on the file — one subquery per tag,
      // AND'd together, so f.id appears in the tag table for all of them.
      const parts = query.aiTag.map(() => 'f.id IN (SELECT file_id FROM ai_tags WHERE tag = ?)');
      return { sql: `(${parts.join(' AND ')})`, params: [...query.aiTag] };
    }
    const ph = query.aiTag.map(() => '?').join(',');
    return {
      sql: `f.id IN (SELECT file_id FROM ai_tags WHERE tag IN (${ph}))`,
      params: [...query.aiTag],
    };
  })();

  if (personFragment && tagFragment && query.textFilterJoin === 'or') {
    // "Mel, beach" style: a photo matches if either the person or the tag
    // condition matches. Wrap them in a single parenthesised OR so the
    // outer AND-ing of other conditions still works as expected.
    conditions.push(`(${personFragment.sql} OR ${tagFragment.sql})`);
    params.push(...personFragment.params, ...tagFragment.params);
  } else {
    if (personFragment) {
      conditions.push(personFragment.sql);
      params.push(...personFragment.params);
    }
    if (tagFragment) {
      conditions.push(tagFragment.sql);
      params.push(...tagFragment.params);
    }
  }

  // AI: Has faces
  if (query.hasFaces === true) {
    conditions.push(`f.id IN (SELECT file_id FROM face_detections)`);
  } else if (query.hasFaces === false) {
    conditions.push(`f.id NOT IN (SELECT file_id FROM face_detections)`);
  }

  // AI: Has unnamed faces
  if (query.hasUnnamedFaces === true) {
    conditions.push(`f.id IN (SELECT file_id FROM face_detections WHERE person_id IS NULL)`);
  }

  // AI: Has AI tags
  if (query.hasAiTags === true) {
    conditions.push(`f.id IN (SELECT file_id FROM ai_tags)`);
  }

  // AI: Has named people (at least one face with a person assigned)
  if (query.hasNamedPeople === true) {
    conditions.push(`f.id IN (SELECT file_id FROM face_detections WHERE person_id IS NOT NULL)`);
  }

  // v2.0.14 — Captioned only. caption is stored on indexed_files itself
  // (column added in v2.0.8 for Takeout backfill, opened up for user
  // editing in v2.0.13), so this is a plain column predicate — no
  // sub-query needed.
  if (query.hasCaption === true) {
    conditions.push(`f.caption IS NOT NULL AND f.caption != ''`);
  }

  // v2.0.15 Phase 3b — Enhanced only. enhancement_type is NULL for every
  // ordinary photo and 'manual' / 'codeformer' / 'realesrgan' / etc.
  // for files saved through the PDR Viewer Enhance panel. Plain column
  // predicate, same pattern as Captioned.
  if (query.isEnhanced === true) {
    conditions.push(`f.enhancement_type IS NOT NULL`);
  }

  // AI: Processed filter (analyzed status)
  if (query.aiProcessed) {
    switch (query.aiProcessed) {
      case 'all':
        conditions.push(`f.id IN (SELECT file_id FROM ai_processing_status)`);
        break;
      case 'unprocessed':
        conditions.push(`f.id NOT IN (SELECT file_id FROM ai_processing_status)`);
        conditions.push(`f.file_type = 'photo'`);
        break;
      case 'faces_only':
        conditions.push(`f.id IN (SELECT file_id FROM face_detections)`);
        conditions.push(`f.id NOT IN (SELECT file_id FROM ai_tags)`);
        break;
      case 'tags_only':
        conditions.push(`f.id NOT IN (SELECT file_id FROM face_detections)`);
        conditions.push(`f.id IN (SELECT file_id FROM ai_tags)`);
        break;
      case 'both':
        conditions.push(`f.id IN (SELECT file_id FROM face_detections)`);
        conditions.push(`f.id IN (SELECT file_id FROM ai_tags)`);
        break;
    }
  }

  // AI: Face count range
  if (query.faceCountMin !== undefined || query.faceCountMax !== undefined) {
    const min = query.faceCountMin ?? 0;
    const max = query.faceCountMax ?? 999999;
    conditions.push(`f.id IN (SELECT file_id FROM face_detections GROUP BY file_id HAVING COUNT(*) >= ? AND COUNT(*) <= ?)`);
    params.push(min, max);
  }

  // AI: Person together (AND logic — photos containing ALL selected persons)
  if (query.personTogetherIds && query.personTogetherIds.length > 0) {
    const placeholders = query.personTogetherIds.map(() => '?').join(',');
    conditions.push(`f.id IN (SELECT fd.file_id FROM face_detections fd WHERE fd.person_id IN (${placeholders}) GROUP BY fd.file_id HAVING COUNT(DISTINCT fd.person_id) = ?)`);
    params.push(...query.personTogetherIds, query.personTogetherIds.length);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Sort
  const validSortColumns = ['derived_date', 'filename', 'size_bytes', 'confidence', 'camera_model', 'iso', 'aperture', 'focal_length', 'megapixels'];
  const sortBy = query.sortBy && validSortColumns.includes(query.sortBy) ? query.sortBy : 'derived_date';
  const sortDir = query.sortDir === 'asc' ? 'ASC' : 'DESC';

  // Pagination
  const limit = Math.min(query.limit ?? 100, 500);
  const offset = query.offset ?? 0;

  // Deduplicate: keep only the most recent entry per file_path (highest id)
  const dedupeClause = `AND f.id = (SELECT MAX(f2.id) FROM indexed_files f2 WHERE f2.file_path = f.file_path)`;
  const whereDeduped = where ? `${where} ${dedupeClause}` : `WHERE 1=1 ${dedupeClause}`;

  // Count total (deduplicated)
  const countSql = `SELECT COUNT(*) as total FROM indexed_files f ${whereDeduped}`;
  const totalRow = database.prepare(countSql).get(...params) as { total: number };

  // Fetch page (deduplicated)
  const selectSql = `SELECT f.* FROM indexed_files f ${whereDeduped} ORDER BY f.${sortBy} ${sortDir} LIMIT ? OFFSET ?`;
  const files = database.prepare(selectSql).all(...params, limit, offset) as IndexedFile[];

  return {
    files,
    total: totalRow.total,
    limit,
    offset,
  };
}

// ─── Filter options (for dropdowns) ──────────────────────────────────────────

export function getFilterOptions(): FilterOptions {
  const database = getDb();

  // GROUP BY-with-count helper. Skips NULL and empty string by default
  // (matches the previous DISTINCT behaviour where applicable). Returns
  // both the sorted list of values AND a Record<value, count> map so
  // the filter UI can show "Italy (243)" style labels (Terry 2026-05-19:
  // "aren't you able to have the numbers of files for each location?").
  type Row = { v: string | null; c: number };
  const groupBy = (column: string, includeNullAsLabel?: string): { values: string[]; counts: Record<string, number> } => {
    const rows = database.prepare(`SELECT ${column} AS v, COUNT(*) AS c FROM indexed_files GROUP BY ${column}`).all() as Row[];
    const counts: Record<string, number> = {};
    const values: string[] = [];
    let nullCount = 0;
    for (const r of rows) {
      if (r.v === null || r.v === '') { nullCount += Number(r.c); continue; }
      counts[r.v] = Number(r.c);
      values.push(r.v);
    }
    values.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    // "(No location)" / "(No camera)" entry — only added if we have a
    // label AND at least one NULL row. Sentinel value is the LABEL
    // itself; backend treats it as a NULL check in searchFiles. Goes
    // to the TOP of the returned values per Terry's request: "there
    // should also be a field for no location (which should probably
    // go at the top, as the list can get quite long)."
    if (includeNullAsLabel && nullCount > 0) {
      values.unshift(includeNullAsLabel);
      counts[includeNullAsLabel] = nullCount;
    }
    return { values, counts };
  };
  const groupByNumeric = (column: string): { values: number[]; counts: Record<string, number> } => {
    const rows = database.prepare(`SELECT ${column} AS v, COUNT(*) AS c FROM indexed_files WHERE ${column} IS NOT NULL GROUP BY ${column} ORDER BY ${column}`).all() as Array<{ v: number; c: number }>;
    const counts: Record<string, number> = {};
    const values: number[] = [];
    for (const r of rows) {
      counts[String(r.v)] = Number(r.c);
      values.push(r.v);
    }
    return { values, counts };
  };

  const confidence = groupBy('confidence');
  const fileType = groupBy('file_type');
  const dateSource = groupBy('date_source');
  const yearGroup = groupByNumeric('year');
  const cameraMake = groupBy('camera_make', NO_CAMERA_MAKE_LABEL);
  const cameraModel = groupBy('camera_model', NO_CAMERA_MODEL_LABEL);
  const lensModel = groupBy('lens_model', NO_LENS_LABEL);
  const extension = groupBy('extension');
  const sceneCaptureType = groupBy('scene_capture_type');
  const exposureProgram = groupBy('exposure_program');
  const whiteBalance = groupBy('white_balance');
  const cameraPosition = groupBy('camera_position');
  const orientation = groupBy('orientation');
  const country = groupBy('geo_country', NO_LOCATION_LABEL);
  const city = groupBy('geo_city', NO_LOCATION_LABEL);

  // Library Drive counts — files per destination_path, joining
  // indexed_runs to indexed_files via run_id. LEFT JOIN so runs
  // with zero files still appear in the list (count=0).
  const destinationRows = database.prepare(`
    SELECT r.destination_path AS v, COUNT(f.id) AS c
      FROM indexed_runs r
      LEFT JOIN indexed_files f ON f.run_id = r.id
     GROUP BY r.destination_path
     ORDER BY r.destination_path
  `).all() as Array<{ v: string; c: number }>;
  // Normalise destination paths (handles legacy double-backslash) and
  // accumulate counts onto the normalised form.
  const destinationCounts: Record<string, number> = {};
  for (const row of destinationRows) {
    const norm = row.v.replace(/\\\\/g, '\\').replace(/\\$/, '');
    destinationCounts[norm] = (destinationCounts[norm] ?? 0) + Number(row.c);
  }
  const destinations = Object.keys(destinationCounts).sort();

  const runs = database.prepare(`SELECT id, report_id, destination_path, indexed_at, file_count FROM indexed_runs ORDER BY indexed_at DESC`).all() as FilterOptions['runs'];

  return {
    confidences: confidence.values,
    fileTypes: fileType.values,
    lensModels: lensModel.values,
    dateSources: dateSource.values,
    years: yearGroup.values,
    cameraMakes: cameraMake.values,
    cameraModels: cameraModel.values,
    extensions: extension.values,
    sceneCaptureTypes: sceneCaptureType.values,
    exposurePrograms: exposureProgram.values,
    whiteBalances: whiteBalance.values,
    cameraPositions: cameraPosition.values,
    orientations: orientation.values,
    countries: country.values,
    cities: city.values,
    destinations,
    runs,
    counts: {
      confidence: confidence.counts,
      fileType: fileType.counts,
      dateSource: dateSource.counts,
      cameraMake: cameraMake.counts,
      cameraModel: cameraModel.counts,
      lensModel: lensModel.counts,
      extension: extension.counts,
      sceneCaptureType: sceneCaptureType.counts,
      exposureProgram: exposureProgram.counts,
      whiteBalance: whiteBalance.counts,
      cameraPosition: cameraPosition.counts,
      orientation: orientation.counts,
      country: country.counts,
      city: city.counts,
      destination: destinationCounts,
    },
  };
}

// Sentinel labels for the "(No X)" entries. Frontend renders them as
// the top item in their dropdown; backend matches them as NULL/empty
// in searchFiles via these literal strings.
export const NO_LOCATION_LABEL = '(No location)';
export const NO_CAMERA_MAKE_LABEL = '(No camera make)';
export const NO_CAMERA_MODEL_LABEL = '(No camera model)';
export const NO_LENS_LABEL = '(No lens)';

export type ContextualCountDimension =
  | 'confidence' | 'fileType' | 'dateSource' | 'cameraMake' | 'cameraModel' | 'lensModel'
  | 'extension' | 'sceneCaptureType' | 'exposureProgram' | 'whiteBalance'
  | 'cameraPosition' | 'orientation' | 'country' | 'city' | 'destination' | 'album';

export type ContextualCounts = Partial<Record<ContextualCountDimension, Record<string, number>>>;

/**
 * Contextual / faceted counts. For each filter dimension D, this
 * applies every active filter EXCEPT D's own and counts photos
 * grouped by D's column. "Leave-one-out" semantics — so a user
 * who has Country=Italy selected sees City counts reflecting
 * "Italian cities" (and ticking another city ADDS, doesn't replace),
 * but the Country dropdown still shows other countries with their
 * counts so the user can add them.
 *
 * Frontend uses these to (a) replace the static counts on each
 * checkbox and (b) HIDE 0-count options (except for ones the user
 * has explicitly selected — those stay visible so they can untick
 * them).
 *
 * Performance: one GROUP BY per dimension, 15ish per call. On 9k
 * rows it's sub-100ms; for very large libraries every column used
 * for filtering should have an index (most do already).
 */
export function getFilterCounts(query: SearchQuery): ContextualCounts {
  const db = getDb();

  // Re-builds the WHERE clause from the SearchQuery, omitting the
  // dimension named in `skip`. Mirrors searchFiles' condition logic
  // for the multi-select / range / sentinel-aware dimensions. AI/
  // person filters are intentionally omitted from this MVP — when
  // those become contextual-count drivers they can be added here.
  const buildConditions = (skip: ContextualCountDimension | null): { conditions: string[]; params: any[] } => {
    const conditions: string[] = [];
    const params: any[] = [];

    if (query.text && query.text.trim()) {
      const rawText = query.text.trim().replace(/['"]/g, '');
      const searchTerm = rawText.split(/\s+/).map(t => `"${t}"*`).join(' ');
      const likePattern = `%${rawText.toLowerCase()}%`;
      conditions.push(`f.id IN (
        SELECT rowid FROM files_fts WHERE files_fts MATCH ?
        UNION
        SELECT rowid FROM files_ai_fts WHERE files_ai_fts MATCH ?
        UNION
        SELECT file_id FROM ai_tags WHERE LOWER(tag) LIKE ?
        UNION
        SELECT fd.file_id FROM face_detections fd JOIN persons p ON fd.person_id = p.id WHERE LOWER(p.name) LIKE ? AND p.discarded_at IS NULL
      )`);
      params.push(searchTerm, searchTerm, likePattern, likePattern);
    }
    const sentinelClause = (column: string, values: string[], nullSentinel: string): string | null => {
      const realValues = values.filter(v => v !== nullSentinel);
      const includeNull = values.includes(nullSentinel);
      const clauses: string[] = [];
      if (realValues.length > 0) {
        clauses.push(`${column} IN (${realValues.map(() => '?').join(',')})`);
        params.push(...realValues);
      }
      if (includeNull) clauses.push(`(${column} IS NULL OR ${column} = '')`);
      if (clauses.length === 0) return null;
      return clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`;
    };

    if (skip !== 'confidence' && query.confidence?.length) {
      conditions.push(`f.confidence IN (${query.confidence.map(() => '?').join(',')})`); params.push(...query.confidence);
    }
    if (skip !== 'fileType' && query.fileType?.length) {
      conditions.push(`f.file_type IN (${query.fileType.map(() => '?').join(',')})`); params.push(...query.fileType);
    }
    if (skip !== 'dateSource' && query.dateSource?.length) {
      conditions.push(`f.date_source IN (${query.dateSource.map(() => '?').join(',')})`); params.push(...query.dateSource);
    }
    if (query.dateFrom) { conditions.push(`f.derived_date >= ?`); params.push(query.dateFrom); }
    if (query.dateTo) {
      const endDate = query.dateTo.length <= 10 ? query.dateTo + ' 23:59:59' : query.dateTo;
      conditions.push(`f.derived_date <= ?`); params.push(endDate);
    }
    if (query.yearFrom != null) { conditions.push(`f.year >= ?`); params.push(query.yearFrom); }
    if (query.yearTo != null) { conditions.push(`f.year <= ?`); params.push(query.yearTo); }
    if (query.monthFrom != null) { conditions.push(`f.month >= ?`); params.push(query.monthFrom); }
    if (query.monthTo != null) { conditions.push(`f.month <= ?`); params.push(query.monthTo); }
    if (skip !== 'cameraMake' && query.cameraMake?.length) {
      const c = sentinelClause('f.camera_make', query.cameraMake, NO_CAMERA_MAKE_LABEL); if (c) conditions.push(c);
    }
    if (skip !== 'cameraModel' && query.cameraModel?.length) {
      const c = sentinelClause('f.camera_model', query.cameraModel, NO_CAMERA_MODEL_LABEL); if (c) conditions.push(c);
    }
    if (query.hasGps === true) conditions.push(`f.gps_lat IS NOT NULL AND f.gps_lon IS NOT NULL`);
    else if (query.hasGps === false) conditions.push(`(f.gps_lat IS NULL OR f.gps_lon IS NULL)`);
    if (query.hasCaption === true) conditions.push(`f.caption IS NOT NULL AND f.caption != ''`);
    if (skip !== 'country' && query.country?.length) {
      const c = sentinelClause('f.geo_country', query.country, NO_LOCATION_LABEL); if (c) conditions.push(c);
    }
    if (skip !== 'city' && query.city?.length) {
      const c = sentinelClause('f.geo_city', query.city, NO_LOCATION_LABEL); if (c) conditions.push(c);
    }
    if (skip !== 'destination' && query.destinationPath?.length) {
      const normPaths = query.destinationPath.flatMap(p => {
        const norm = p.replace(/\\\\/g, '\\').replace(/\\$/, '');
        const dbl = norm.replace(/\\/g, '\\\\');
        return norm === dbl ? [norm] : [norm, dbl];
      });
      conditions.push(`f.run_id IN (SELECT id FROM indexed_runs WHERE destination_path IN (${normPaths.map(() => '?').join(',')}))`);
      params.push(...normPaths);
    }
    if (skip !== 'extension' && query.extension?.length) {
      conditions.push(`f.extension IN (${query.extension.map(() => '?').join(',')})`); params.push(...query.extension);
    }
    if (skip !== 'lensModel' && query.lensModel?.length) {
      const c = sentinelClause('f.lens_model', query.lensModel, NO_LENS_LABEL); if (c) conditions.push(c);
    }
    if (query.isoFrom != null) { conditions.push(`f.iso >= ?`); params.push(query.isoFrom); }
    if (query.isoTo != null) { conditions.push(`f.iso <= ?`); params.push(query.isoTo); }
    if (query.apertureFrom != null) { conditions.push(`f.aperture >= ?`); params.push(query.apertureFrom); }
    if (query.apertureTo != null) { conditions.push(`f.aperture <= ?`); params.push(query.apertureTo); }
    if (query.focalLengthFrom != null) { conditions.push(`f.focal_length >= ?`); params.push(query.focalLengthFrom); }
    if (query.focalLengthTo != null) { conditions.push(`f.focal_length <= ?`); params.push(query.focalLengthTo); }
    if (query.flashFired === true) conditions.push(`f.flash_fired = 1`);
    else if (query.flashFired === false) conditions.push(`f.flash_fired = 0`);
    if (query.megapixelsFrom != null) { conditions.push(`f.megapixels >= ?`); params.push(query.megapixelsFrom); }
    if (query.megapixelsTo != null) { conditions.push(`f.megapixels <= ?`); params.push(query.megapixelsTo); }
    if (query.sizeFrom != null) { conditions.push(`f.size_bytes >= ?`); params.push(query.sizeFrom); }
    if (query.sizeTo != null) { conditions.push(`f.size_bytes <= ?`); params.push(query.sizeTo); }
    if (skip !== 'sceneCaptureType' && query.sceneCaptureType?.length) {
      conditions.push(`f.scene_capture_type IN (${query.sceneCaptureType.map(() => '?').join(',')})`); params.push(...query.sceneCaptureType);
    }
    if (skip !== 'exposureProgram' && query.exposureProgram?.length) {
      conditions.push(`f.exposure_program IN (${query.exposureProgram.map(() => '?').join(',')})`); params.push(...query.exposureProgram);
    }
    if (skip !== 'whiteBalance' && query.whiteBalance?.length) {
      conditions.push(`f.white_balance IN (${query.whiteBalance.map(() => '?').join(',')})`); params.push(...query.whiteBalance);
    }
    if (skip !== 'cameraPosition' && query.cameraPosition?.length) {
      conditions.push(`f.camera_position IN (${query.cameraPosition.map(() => '?').join(',')})`); params.push(...query.cameraPosition);
    }
    if (skip !== 'orientation' && query.orientation?.length) {
      conditions.push(`f.orientation IN (${query.orientation.map(() => '?').join(',')})`); params.push(...query.orientation);
    }
    if (skip !== 'album' && query.albumIds?.length) {
      conditions.push(`f.id IN (SELECT file_id FROM album_files WHERE album_id IN (${query.albumIds.map(() => '?').join(',')}))`);
      params.push(...query.albumIds);
    }
    return { conditions, params };
  };

  const countByColumn = (dim: ContextualCountDimension, column: string, nullLabel?: string): Record<string, number> => {
    const { conditions, params } = buildConditions(dim);
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT ${column} AS v, COUNT(*) AS c FROM indexed_files f ${whereSql} GROUP BY ${column}`).all(...params) as Array<{ v: string | null; c: number }>;
    const map: Record<string, number> = {};
    let nullCount = 0;
    for (const r of rows) {
      if (r.v === null || r.v === '') { nullCount += Number(r.c); continue; }
      map[r.v] = Number(r.c);
    }
    if (nullLabel && nullCount > 0) map[nullLabel] = nullCount;
    return map;
  };

  const result: ContextualCounts = {};
  result.confidence = countByColumn('confidence', 'f.confidence');
  result.fileType = countByColumn('fileType', 'f.file_type');
  result.dateSource = countByColumn('dateSource', 'f.date_source');
  result.cameraMake = countByColumn('cameraMake', 'f.camera_make', NO_CAMERA_MAKE_LABEL);
  result.cameraModel = countByColumn('cameraModel', 'f.camera_model', NO_CAMERA_MODEL_LABEL);
  result.lensModel = countByColumn('lensModel', 'f.lens_model', NO_LENS_LABEL);
  result.extension = countByColumn('extension', 'f.extension');
  result.sceneCaptureType = countByColumn('sceneCaptureType', 'f.scene_capture_type');
  result.exposureProgram = countByColumn('exposureProgram', 'f.exposure_program');
  result.whiteBalance = countByColumn('whiteBalance', 'f.white_balance');
  result.cameraPosition = countByColumn('cameraPosition', 'f.camera_position');
  result.orientation = countByColumn('orientation', 'f.orientation');
  result.country = countByColumn('country', 'f.geo_country', NO_LOCATION_LABEL);
  result.city = countByColumn('city', 'f.geo_city', NO_LOCATION_LABEL);

  // Destination — JOIN to indexed_runs and normalise paths.
  {
    const { conditions, params } = buildConditions('destination');
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT r.destination_path AS v, COUNT(f.id) AS c
        FROM indexed_files f
        JOIN indexed_runs r ON r.id = f.run_id
        ${whereSql}
       GROUP BY r.destination_path
    `).all(...params) as Array<{ v: string; c: number }>;
    const map: Record<string, number> = {};
    for (const row of rows) {
      const norm = row.v.replace(/\\\\/g, '\\').replace(/\\$/, '');
      map[norm] = (map[norm] ?? 0) + Number(row.c);
    }
    result.destination = map;
  }

  // Album — JOIN to album_files. Result is keyed by album_id as a
  // string (Record<string, number>) so it round-trips through JSON
  // cleanly; frontend looks up via `counts.album[String(albumId)]`.
  {
    const { conditions, params } = buildConditions('album');
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT af.album_id AS v, COUNT(*) AS c
        FROM indexed_files f
        JOIN album_files af ON af.file_id = f.id
        ${whereSql}
       GROUP BY af.album_id
    `).all(...params) as Array<{ v: number; c: number }>;
    const map: Record<string, number> = {};
    for (const r of rows) map[String(r.v)] = Number(r.c);
    result.album = map;
  }

  return result;
}

// ─── Index stats ─────────────────────────────────────────────────────────────

export function getIndexStats(): IndexStats {
  const database = getDb();
  const dbPath = getDbPath();

  // Deduplicate: count each unique file_path only once (most recent entry)
  const row = database.prepare(`
    SELECT
      COUNT(*)                     as totalFiles,
      SUM(CASE WHEN file_type = 'photo' THEN 1 ELSE 0 END) as totalPhotos,
      SUM(CASE WHEN file_type = 'video' THEN 1 ELSE 0 END) as totalVideos,
      COALESCE(SUM(size_bytes), 0) as totalSizeBytes,
      MIN(derived_date)            as oldestDate,
      MAX(derived_date)            as newestDate
    FROM indexed_files f
    WHERE f.id = (SELECT MAX(f2.id) FROM indexed_files f2 WHERE f2.file_path = f.file_path)
  `).get() as any;

  const runCount = (database.prepare(`SELECT COUNT(*) as cnt FROM indexed_runs`).get() as { cnt: number }).cnt;

  let dbSizeBytes = 0;
  try {
    dbSizeBytes = fs.statSync(dbPath).size;
  } catch { /* ignore */ }

  return {
    totalFiles: row.totalFiles ?? 0,
    totalRuns: runCount,
    totalPhotos: row.totalPhotos ?? 0,
    totalVideos: row.totalVideos ?? 0,
    totalSizeBytes: row.totalSizeBytes ?? 0,
    oldestDate: row.oldestDate ?? null,
    newestDate: row.newestDate ?? null,
    dbSizeBytes,
  };
}

// ─── Rebuild index (drop all and re-index) ───────────────────────────────────

export function clearAllIndexData(): void {
  const database = getDb();
  database.exec(`
    DELETE FROM indexed_files;
    DELETE FROM indexed_runs;
    DELETE FROM files_fts;
    DELETE FROM favourite_filters;
  `);
  database.pragma('wal_checkpoint(TRUNCATE)');
}

// ─── Favourite filters ──────────────────────────────────────────────────────

export function saveFavouriteFilter(name: string, query: SearchQuery): FavouriteFilter {
  const database = getDb();
  const queryJson = JSON.stringify(query);
  const stmt = database.prepare(`INSERT INTO favourite_filters (name, query_json) VALUES (?, ?)`);
  const result = stmt.run(name, queryJson);
  return {
    id: result.lastInsertRowid as number,
    name,
    query_json: queryJson,
    created_at: new Date().toISOString(),
  };
}

export function listFavouriteFilters(): FavouriteFilter[] {
  const database = getDb();
  return database.prepare(`SELECT * FROM favourite_filters ORDER BY created_at DESC`).all() as FavouriteFilter[];
}

export function deleteFavouriteFilter(id: number): void {
  const database = getDb();
  database.prepare(`DELETE FROM favourite_filters WHERE id = ?`).run(id);
}

export function renameFavouriteFilter(id: number, name: string): void {
  const database = getDb();
  database.prepare(`UPDATE favourite_filters SET name = ? WHERE id = ?`).run(name, id);
}

// ─── AI Recognition helpers ────────────────────────────────────────────────

export interface FaceDetectionRecord {
  id?: number;
  file_id: number;
  person_id: number | null;
  box_x: number;
  box_y: number;
  box_w: number;
  box_h: number;
  embedding: Buffer | null;
  confidence: number;
  cluster_id: number | null;
}

export interface PersonRecord {
  id: number;
  /** Short name. Required. Shown in PM rows and S&D filter chips.
   *  E.g. "Terry" or "Terry Clapson". */
  name: string;
  /** Optional long-form name shown on Trees cards where
   *  historical / genealogical detail matters. E.g. "Terry John
   *  Filmer Clapson". Trees falls back to `name` when null. */
  full_name?: string | null;
  avatar_data: string | null;
  /** Total count of photos any face detection links to this person —
   *  includes AI-suggested faces the user hasn't confirmed yet. */
  photo_count?: number;
  /** Photos where the linking face has been user-verified. This is the
   *  "real work invested" metric; the Trees People-list modal shows
   *  this number, not the total, so deletions reflect true cost. */
  verified_photo_count?: number;
  created_at: string;
  updated_at: string;
}

export interface AiTagRecord {
  id?: number;
  file_id: number;
  tag: string;
  confidence: number;
  source: string;
  model_ver: string | null;
}

/** Get file IDs that haven't been processed by AI yet */
export function getUnprocessedFileIds(task: 'faces' | 'tags', limit = 100): number[] {
  const database = getDb();
  const col = task === 'faces' ? 'face_processed' : 'tags_processed';
  const rows = database.prepare(`
    SELECT f.id FROM indexed_files f
    LEFT JOIN ai_processing_status s ON f.id = s.file_id
    WHERE f.file_type = 'photo' AND (s.file_id IS NULL OR s.${col} = 0)
      AND f.id = (SELECT MAX(f2.id) FROM indexed_files f2 WHERE f2.file_path = f.file_path)
    ORDER BY f.derived_date DESC
    LIMIT ?
  `).all(limit) as { id: number }[];
  return rows.map(r => r.id);
}

/** Get file path by ID */
export function getFileById(fileId: number): IndexedFile | undefined {
  const database = getDb();
  return database.prepare(`SELECT * FROM indexed_files WHERE id = ?`).get(fileId) as IndexedFile | undefined;
}

/** Mark a file as AI-processed */
export function markAiProcessed(fileId: number, task: 'faces' | 'tags', modelVer: string): void {
  const database = getDb();
  const col = task === 'faces' ? 'face_processed' : 'tags_processed';
  const verCol = task === 'faces' ? 'face_model_ver' : 'tags_model_ver';
  database.prepare(`
    INSERT INTO ai_processing_status (file_id, ${col}, ${verCol}, processed_at)
    VALUES (?, 1, ?, datetime('now'))
    ON CONFLICT(file_id) DO UPDATE SET ${col} = 1, ${verCol} = ?, processed_at = datetime('now')
  `).run(fileId, modelVer, modelVer);
}

/**
 * Clear every UNVERIFIED face_detection row for a file before a
 * re-detection run. Preserves verified=1 rows so user-confirmed face
 * assignments survive a re-process. Without this, re-processing a file
 * (e.g. after the "reset face-processed but 0 detections" logic kicks
 * in) accumulates duplicate face rows — the same face appears multiple
 * times in People Manager for the same photo.
 */
export function clearUnverifiedFacesForFile(fileId: number): number {
  const database = getDb();
  const result = database.prepare(`DELETE FROM face_detections WHERE file_id = ? AND verified = 0`).run(fileId);
  // If any of the rows we just dropped was a person's chosen main
  // photo, the override is now a dangling pointer — clear it so the
  // renderer doesn't silently fall back to a different photo.
  if (result.changes > 0) clearOrphanedRepresentativeFaces();
  return result.changes;
}

/**
 * One-time consolidation that removes duplicate face_detection rows
 * accumulated before `clearUnverifiedFacesForFile` was wired in.
 *
 * Duplicate = same (file_id, box coords, person_id). When a group of
 * identical rows exists we keep the ONE with (a) verified=1 if any,
 * (b) highest confidence, (c) lowest id — and drop the rest.
 */
export function deduplicateFaceDetections(): number {
  const database = getDb();
  const result = database.prepare(`
    DELETE FROM face_detections
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY file_id, box_x, box_y, box_w, box_h, COALESCE(person_id, -1)
          ORDER BY verified DESC, confidence DESC, id ASC
        ) AS rn
        FROM face_detections
      ) WHERE rn = 1
    )
  `).run();
  if (result.changes > 0) {
    console.warn(`[DB] Removed ${result.changes} duplicate face_detection row(s)`);
    // A dedup pass can drop a row that was somebody's chosen main
    // photo. Clear any override that no longer points at a real face.
    clearOrphanedRepresentativeFaces();
  }
  return result.changes;
}

/** Insert face detections for a file */
export function insertFaceDetections(faces: FaceDetectionRecord[]): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO face_detections (file_id, person_id, box_x, box_y, box_w, box_h, embedding, confidence, cluster_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = database.transaction((items: FaceDetectionRecord[]) => {
    for (const f of items) {
      stmt.run(f.file_id, f.person_id, f.box_x, f.box_y, f.box_w, f.box_h, f.embedding, f.confidence, f.cluster_id);
    }
  });
  insertMany(faces);
}

/** Insert AI tags for a file (replaces any existing tags for the same file) */
export function insertAiTags(tags: AiTagRecord[]): void {
  const database = getDb();
  const deleteStmt = database.prepare(`DELETE FROM ai_tags WHERE file_id = ?`);
  const insertStmt = database.prepare(`
    INSERT INTO ai_tags (file_id, tag, confidence, source, model_ver)
    VALUES (?, ?, ?, ?, ?)
  `);
  const replaceAll = database.transaction((items: AiTagRecord[]) => {
    // Delete existing tags for this file first to avoid duplicates
    if (items.length > 0) {
      deleteStmt.run(items[0].file_id);
    }
    for (const t of items) {
      insertStmt.run(t.file_id, t.tag, t.confidence, t.source, t.model_ver);
    }
  });
  replaceAll(tags);
}

/** Check whether the contentless files_ai_fts virtual table is internally
 *  consistent. Uses FTS5's built-in integrity-check command. Returns
 *  true for healthy, false for corrupt (so caller can trigger repair). */
export function checkAiFtsIntegrity(): boolean {
  const database = getDb();
  try {
    database.prepare(`INSERT INTO files_ai_fts(files_ai_fts) VALUES('integrity-check')`).run();
    return true;
  } catch (err) {
    const msg = (err as Error).message.toLowerCase();
    if (msg.includes('malformed') || msg.includes('corrupt')) return false;
    throw err;
  }
}

/** Drop and rebuild the files_ai_fts virtual table from the live source
 *  tables (ai_tags + face_detections × persons). Because the FTS5 table
 *  is contentless, nothing is lost — it's just a search accelerator
 *  that is fully recomputable from the base data. */
export function repairAiFts(): { rebuilt: number } {
  const database = getDb();
  console.warn('[FTS Repair] Dropping and rebuilding files_ai_fts…');
  database.exec(`DROP TABLE IF EXISTS files_ai_fts`);
  database.exec(`
    CREATE VIRTUAL TABLE files_ai_fts USING fts5(
      ai_tags,
      person_names,
      content='',
      content_rowid='rowid'
    );
  `);

  // Every file that has at least one tag or a named face is a candidate.
  const fileRows = database.prepare(`
    SELECT id FROM indexed_files
    WHERE id IN (SELECT file_id FROM ai_tags)
       OR id IN (SELECT file_id FROM face_detections WHERE person_id IS NOT NULL)
  `).all() as { id: number }[];

  const tagStmt = database.prepare(`SELECT tag FROM ai_tags WHERE file_id = ?`);
  const personStmt = database.prepare(`
    SELECT DISTINCT p.name FROM face_detections fd
    JOIN persons p ON fd.person_id = p.id
    WHERE fd.file_id = ? AND p.discarded_at IS NULL
  `);
  const insertStmt = database.prepare(`INSERT INTO files_ai_fts(rowid, ai_tags, person_names) VALUES (?, ?, ?)`);

  let rebuilt = 0;
  const tx = database.transaction(() => {
    for (const r of fileRows) {
      const tags = (tagStmt.all(r.id) as { tag: string }[]).map(t => t.tag).join(' ');
      const persons = (personStmt.all(r.id) as { name: string }[]).map(p => p.name).join(' ');
      if (tags || persons) {
        insertStmt.run(r.id, tags, persons);
        rebuilt++;
      }
    }
  });
  tx();

  console.warn(`[FTS Repair] Rebuilt files_ai_fts with ${rebuilt} entries.`);
  return { rebuilt };
}

/** Rebuild AI FTS entry for a specific file. Self-heals if the underlying
 *  virtual table is corrupt: on SQLITE_CORRUPT_VTAB, kicks off a full
 *  repair and retries once. */
export function rebuildAiFts(fileId: number): void {
  try {
    rebuildAiFtsInner(fileId);
  } catch (err) {
    const msg = (err as Error).message.toLowerCase();
    if (msg.includes('malformed') || msg.includes('corrupt')) {
      console.warn('[FTS] Corruption detected during per-file rebuild; repairing index…');
      repairAiFts();
      // Retry once on the freshly-rebuilt table.
      rebuildAiFtsInner(fileId);
    } else {
      throw err;
    }
  }
}

function rebuildAiFtsInner(fileId: number): void {
  const database = getDb();
  // Gather all tags for this file
  const tags = (database.prepare(`SELECT tag FROM ai_tags WHERE file_id = ?`).all(fileId) as { tag: string }[])
    .map(r => r.tag).join(' ');
  // Gather all person names for faces in this file
  const persons = (database.prepare(`
    SELECT DISTINCT p.name FROM face_detections fd
    JOIN persons p ON fd.person_id = p.id
    WHERE fd.file_id = ? AND p.discarded_at IS NULL
  `).all(fileId) as { name: string }[])
    .map(r => r.name).join(' ');

  // Delete existing entry, then insert
  database.prepare(`INSERT INTO files_ai_fts(files_ai_fts, rowid, ai_tags, person_names) VALUES ('delete', ?, '', '')`).run(fileId);
  if (tags || persons) {
    database.prepare(`INSERT INTO files_ai_fts(rowid, ai_tags, person_names) VALUES (?, ?, ?)`).run(fileId, tags, persons);
  }
}

/** Get all face detections for a file. Discarded persons' names are
 *  hidden (person_name comes back NULL) so the viewer UI doesn't show
 *  names of people the user has deleted; the face record itself stays
 *  intact so restorePerson brings the name back. */
export function getFacesForFile(fileId: number): (FaceDetectionRecord & { person_name?: string })[] {
  const database = getDb();
  return database.prepare(`
    SELECT fd.*,
           CASE WHEN p.discarded_at IS NULL THEN p.name ELSE NULL END as person_name
    FROM face_detections fd
    LEFT JOIN persons p ON fd.person_id = p.id
    WHERE fd.file_id = ?
  `).all(fileId) as any[];
}

/** Get all AI tags for a file */
export function getAiTagsForFile(fileId: number): AiTagRecord[] {
  const database = getDb();
  return database.prepare(`SELECT * FROM ai_tags WHERE file_id = ? ORDER BY confidence DESC`).all(fileId) as AiTagRecord[];
}

/** List all active (non-discarded) persons with photo counts. Returns
 *  TWO counts per person: photo_count = every photo any face links them
 *  to (including unverified AI guesses), and verified_photo_count =
 *  only photos where the face has been user-confirmed. The Trees
 *  People-list modal shows verified_photo_count since that's the
 *  measure of real work invested in this person. */
export function listPersons(): PersonRecord[] {
  const database = getDb();
  return database.prepare(`
    SELECT
      p.*,
      COUNT(DISTINCT fd.file_id) as photo_count,
      COUNT(DISTINCT CASE WHEN fd.verified = 1 THEN fd.file_id END) as verified_photo_count
    FROM persons p
    LEFT JOIN face_detections fd ON fd.person_id = p.id
    WHERE p.discarded_at IS NULL
      AND p.name != '__ignored__'
      AND p.name != '__unsure__'
      AND COALESCE(p.is_placeholder, 0) = 0
    GROUP BY p.id
    ORDER BY photo_count DESC
  `).all() as PersonRecord[];
}

/**
 * Get persons with co-occurrence counts: given a set of already-selected person IDs,
 * return all other persons with the count of photos they share with ALL selected persons.
 * If no persons selected, returns the regular photo_count for each person.
 */
export function getPersonsWithCooccurrence(selectedPersonIds: number[]): { id: number; name: string; photo_count: number; avatar_data: string | null }[] {
  const database = getDb();
  if (selectedPersonIds.length === 0) {
    return listPersons().map(p => ({ id: p.id, name: p.name, photo_count: p.photo_count ?? 0, avatar_data: p.avatar_data }));
  }
  // Find file_ids that contain ALL selected persons
  // Then for each remaining person, count how many of those files they also appear in
  const placeholders = selectedPersonIds.map(() => '?').join(',');
  const query = `
    WITH shared_files AS (
      SELECT fd.file_id
      FROM face_detections fd
      WHERE fd.person_id IN (${placeholders})
      GROUP BY fd.file_id
      HAVING COUNT(DISTINCT fd.person_id) = ${selectedPersonIds.length}
    )
    SELECT p.id, p.name, p.avatar_data,
      COUNT(DISTINCT fd.file_id) as photo_count
    FROM persons p
    INNER JOIN face_detections fd ON fd.person_id = p.id
    INNER JOIN shared_files sf ON fd.file_id = sf.file_id
    WHERE p.discarded_at IS NULL
      AND p.name != '__ignored__'
      AND p.name != '__unsure__'
      AND p.id NOT IN (${placeholders})
    GROUP BY p.id
    ORDER BY photo_count DESC
  `;
  return database.prepare(query).all(...selectedPersonIds, ...selectedPersonIds) as any[];
}

/** Remove person records that have no face detections pointing to them
 *  AND are not serving any Trees-level purpose. A person with zero face
 *  detections might still be:
 *    · a named family member added in Trees who simply has no photos yet
 *      (common for older generations predating digital photography)
 *    · a placeholder ghost bridging a skip-generation relationship
 *    · the target of a relationship edge (parent_of, spouse_of, etc.)
 *  Any of those cases must NOT be deleted, or the Trees graph collapses
 *  via ON DELETE CASCADE on `relationships`. */
export function cleanupOrphanedPersons(): number {
  const database = getDb();
  const result = database.prepare(`
    DELETE FROM persons
    WHERE id NOT IN (SELECT DISTINCT person_id FROM face_detections WHERE person_id IS NOT NULL)
      AND discarded_at IS NULL
      AND COALESCE(is_placeholder, 0) = 0
      AND id NOT IN (SELECT person_a_id FROM relationships)
      AND id NOT IN (SELECT person_b_id FROM relationships)
  `).run();
  if (result.changes > 0) {
    console.log(`[AI] Cleaned up ${result.changes} orphaned person record(s) with no face detections and no Trees presence`);
  }
  return result.changes;
}

/** Create or get a person by name */
export function upsertPerson(name: string, avatarData?: string, fullName?: string | null): number {
  const database = getDb();
  const existing = database.prepare(`SELECT id FROM persons WHERE name = ? COLLATE NOCASE`).get(name) as { id: number } | undefined;
  if (existing) {
    // Clear discarded_at in case this person was previously discarded.
    // If the caller passed a full_name and the existing row doesn't
    // have one, populate it — handy for "I'm naming this cluster
    // again with a richer full name" without losing existing data.
    database.prepare(`UPDATE persons SET discarded_at = NULL WHERE id = ? AND discarded_at IS NOT NULL`).run(existing.id);
    if (fullName !== undefined && fullName !== null && fullName.trim() !== '') {
      database.prepare(`UPDATE persons SET full_name = COALESCE(full_name, ?) WHERE id = ?`).run(fullName.trim(), existing.id);
    }
    return existing.id;
  }
  const trimmedFull = (fullName !== undefined && fullName !== null && fullName.trim() !== '') ? fullName.trim() : null;
  const result = database.prepare(`INSERT INTO persons (name, avatar_data, full_name) VALUES (?, ?, ?)`).run(name, avatarData ?? null, trimmedFull);
  return result.lastInsertRowid as number;
}

/** Assign a person to a face detection (and all faces in the same cluster) */
export function assignPersonToCluster(clusterId: number, personId: number): void {
  const database = getDb();
  database.prepare(`UPDATE face_detections SET person_id = ? WHERE cluster_id = ?`).run(personId, clusterId);
}

/** Assign a person to a single face detection */
export function assignPersonToFace(faceId: number, personId: number, verified: boolean = false): void {
  const database = getDb();
  if (verified) {
    database.prepare(`UPDATE face_detections SET person_id = ?, verified = 1 WHERE id = ?`).run(personId, faceId);
  } else {
    database.prepare(`UPDATE face_detections SET person_id = ? WHERE id = ?`).run(personId, faceId);
  }
}

export function setPersonRepresentativeFace(personId: number, faceId: number): void {
  const database = getDb();
  database.prepare(`UPDATE persons SET representative_face_id = ? WHERE id = ?`).run(faceId, personId);
}

/**
 * Clear `persons.representative_face_id` on any person whose chosen
 * face row has been physically deleted (re-detection rebuilt the
 * face_detections table, dedup removed a duplicate, or the source file
 * was unindexed). Without this, the renderer silently falls back to
 * the highest-confidence face — which is exactly what the user thought
 * they had OVERRIDDEN by clicking "Set as main photo".
 *
 * Deliberately ignores the case where the face row still exists but
 * has been reassigned to a different person — that's the user's own
 * action (reassign-out / unlink) and the fallback is the right
 * behaviour there.
 *
 * Returns the number of stale overrides cleared.
 */
export function clearOrphanedRepresentativeFaces(): number {
  const database = getDb();
  const result = database.prepare(`
    UPDATE persons
    SET representative_face_id = NULL
    WHERE representative_face_id IS NOT NULL
      AND representative_face_id NOT IN (SELECT id FROM face_detections)
  `).run();
  return result.changes;
}

export function verifyFace(faceId: number): void {
  const database = getDb();
  database.prepare(`UPDATE face_detections SET verified = 1 WHERE id = ?`).run(faceId);
}

/** Get all faces for a person or unnamed cluster, paginated, sorted by confidence ASC (lowest first) */
export function getClusterFaces(
  clusterId: number,
  page: number = 0,
  perPage: number = 40,
  personId?: number,
  sortMode: 'chronological' | 'confidence-asc' = 'confidence-asc',
): { faces: { face_id: number; file_id: number; file_path: string; box_x: number; box_y: number; box_w: number; box_h: number; confidence: number; verified: number; match_similarity: number | null }[]; total: number; page: number; perPage: number; totalPages: number } {
  const database = getDb();
  // Sort clauses mirror what getPersonClusters' getOrderedSampleFaces
  // does for the row thumbnails — same data, same order. NULL-date
  // faces go to the end in chronological mode so a missing date
  // doesn't masquerade as the oldest. Confidence ASC is the tiebreaker.
  const orderClause = sortMode === 'chronological'
    ? `ORDER BY (f.derived_date IS NULL) ASC, f.derived_date ASC, fd.confidence ASC`
    : `ORDER BY fd.confidence ASC`;
  // match_similarity distinguishes manually-verified faces (NULL,
  // verified=1) from auto-matched faces (set, verified=0). The UI
  // uses it to draw a different ring colour for each — so users can
  // tell at a glance which faces still need review.
  if (personId) {
    const total = (database.prepare(`SELECT COUNT(*) as cnt FROM face_detections WHERE person_id = ?`).get(personId) as any).cnt;
    const faces = database.prepare(`
      SELECT fd.id as face_id, fd.file_id, f.file_path, fd.box_x, fd.box_y, fd.box_w, fd.box_h, fd.confidence, fd.verified, fd.match_similarity
      FROM face_detections fd
      INNER JOIN indexed_files f ON fd.file_id = f.id
      WHERE fd.person_id = ?
      ${orderClause}
      LIMIT ? OFFSET ?
    `).all(personId, perPage, page * perPage) as any[];
    return { faces, total, page, perPage, totalPages: Math.ceil(total / perPage) };
  }
  // For unnamed clusters: only show faces with no person_id
  const total = (database.prepare(`SELECT COUNT(*) as cnt FROM face_detections WHERE cluster_id = ? AND person_id IS NULL`).get(clusterId) as any).cnt;
  const faces = database.prepare(`
    SELECT fd.id as face_id, fd.file_id, f.file_path, fd.box_x, fd.box_y, fd.box_w, fd.box_h, fd.confidence, fd.verified, fd.match_similarity
    FROM face_detections fd
    INNER JOIN indexed_files f ON fd.file_id = f.id
    WHERE fd.cluster_id = ? AND fd.person_id IS NULL
    ${orderClause}
    LIMIT ? OFFSET ?
  `).all(clusterId, perPage, page * perPage) as any[];
  return { faces, total, page, perPage, totalPages: Math.ceil(total / perPage) };
}

/** Get count of faces for a person or unnamed cluster */
export function getClusterFaceCount(clusterId: number, personId?: number): { faceCount: number; photoCount: number } {
  const database = getDb();
  if (personId) {
    const result = database.prepare(`
      SELECT COUNT(*) as face_count, COUNT(DISTINCT file_id) as photo_count
      FROM face_detections WHERE person_id = ?
    `).get(personId) as { face_count: number; photo_count: number };
    return { faceCount: result.face_count, photoCount: result.photo_count };
  }
  const result = database.prepare(`
    SELECT COUNT(*) as face_count, COUNT(DISTINCT file_id) as photo_count
    FROM face_detections WHERE cluster_id = ? AND person_id IS NULL
  `).get(clusterId) as { face_count: number; photo_count: number };
  return { faceCount: result.face_count, photoCount: result.photo_count };
}

/**
 * Get visual similarity suggestions for a face — compare its embedding against
 * all named faces and return ranked matches by cosine similarity.
 */
export function getVisualSuggestions(faceId: number, limit = 5): { personId: number; personName: string; similarity: number }[] {
  const database = getDb();

  // Get the target face's embedding
  const targetFace = database.prepare(`SELECT embedding FROM face_detections WHERE id = ?`).get(faceId) as { embedding: Buffer } | undefined;
  if (!targetFace?.embedding) return [];

  const targetVec = new Float32Array(targetFace.embedding.buffer, targetFace.embedding.byteOffset, targetFace.embedding.byteLength / 4);

  // Get all named faces with embeddings (one representative per person for speed)
  const namedFaces = database.prepare(`
    SELECT fd.embedding, p.id as person_id, p.name as person_name
    FROM face_detections fd
    JOIN persons p ON fd.person_id = p.id
    WHERE fd.embedding IS NOT NULL AND fd.id != ? AND p.discarded_at IS NULL
  `).all(faceId) as { embedding: Buffer; person_id: number; person_name: string }[];

  if (namedFaces.length === 0) return [];

  // Calculate cosine similarity for each and aggregate by person (best match per person)
  const personBest = new Map<number, { personName: string; similarity: number }>();

  for (const nf of namedFaces) {
    const vec = new Float32Array(nf.embedding.buffer, nf.embedding.byteOffset, nf.embedding.byteLength / 4);
    if (vec.length !== targetVec.length) continue;

    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < vec.length; i++) {
      dot += targetVec[i] * vec[i];
      magA += targetVec[i] * targetVec[i];
      magB += vec[i] * vec[i];
    }
    const mag = Math.sqrt(magA) * Math.sqrt(magB);
    const sim = mag === 0 ? 0 : dot / mag;

    const existing = personBest.get(nf.person_id);
    if (!existing || sim > existing.similarity) {
      personBest.set(nf.person_id, { personName: nf.person_name, similarity: sim });
    }
  }

  // Sort by similarity descending, return top matches above a minimum threshold
  return Array.from(personBest.entries())
    .map(([personId, { personName, similarity }]) => ({ personId, personName, similarity }))
    .filter(s => s.similarity > 0.35) // Only show if there's meaningful similarity
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

/** Remove the person name from a single face detection (un-name it) */
export function unnameFace(faceId: number): void {
  const database = getDb();
  database.prepare(`UPDATE face_detections SET person_id = NULL, verified = 0 WHERE id = ?`).run(faceId);
}

/** Rename a person — updates the name everywhere it appears */
export function renamePerson(personId: number, newName: string, newFullName?: string | null): void {
  const database = getDb();
  // Check if the new short name already exists as a different person
  const existing = database.prepare(`SELECT id FROM persons WHERE name = ? COLLATE NOCASE AND id != ?`).get(newName, personId) as { id: number } | undefined;
  if (existing) {
    // Merge into the existing person with that name. Full name on
    // the source row is dropped — the merge winner keeps its own
    // existing full_name. (If the user wants to switch to the new
    // full_name they can edit the merged row afterwards.)
    mergePersons(existing.id, personId);
  } else if (newFullName !== undefined) {
    // Caller passed a full_name — write it (NULL allowed → "no full
    // name on file", Trees falls back to the short name).
    const trimmed = newFullName === null ? null : (newFullName.trim() || null);
    database.prepare(`UPDATE persons SET name = ?, full_name = ? WHERE id = ?`).run(newName, trimmed, personId);
  } else {
    // Legacy callers that only update the short name — leave
    // full_name untouched so older code paths keep working.
    database.prepare(`UPDATE persons SET name = ? WHERE id = ?`).run(newName, personId);
  }
}

/**
 * Merge sourcePersonId into targetPersonId.
 * All faces assigned to source get reassigned to target, then source is deleted.
 * Returns the number of faces reassigned.
 */
export function mergePersons(targetPersonId: number, sourcePersonId: number): number {
  const database = getDb();
  const result = database.prepare(`UPDATE face_detections SET person_id = ? WHERE person_id = ?`).run(targetPersonId, sourcePersonId);
  database.prepare(`DELETE FROM persons WHERE id = ?`).run(sourcePersonId);
  return result.changes;
}

/**
 * Soft-delete (discard) a person — marks the person as discarded while
 * KEEPING their face-detection links intact. Queries that surface
 * persons (family graph, relationship lists, search, FTS) filter out
 * rows where discarded_at IS NOT NULL, so the person effectively
 * disappears from every UI. But the underlying face links survive, so
 * restorePerson() brings back every photo tag cleanly — critical for
 * the "I accidentally deleted grandma" recovery story.
 *
 * Previously this function also UPDATE'd face_detections.person_id = NULL
 * which meant discard was irreversible in practice (restoring the name
 * didn't bring back the photo tags). That's now fixed.
 *
 * Also nulls saved_trees.focus_person_id for any tree pointing at the
 * discarded person — otherwise the tree would try to render around a
 * ghost focus. The focus can be re-assigned after restore.
 */
export function discardPerson(personId: number): { facesUnlinked: number; photosAffected: number } {
  const database = getDb();
  const photosAffected = (database.prepare(
    `SELECT COUNT(DISTINCT file_id) as cnt FROM face_detections WHERE person_id = ?`
  ).get(personId) as { cnt: number }).cnt;
  const tx = database.transaction(() => {
    // Clear focus on any saved tree that was centred on this person —
    // a discarded person can't be a valid focus. Trees become focus-less
    // until the user either picks a new focus or restores this one.
    database.prepare(`UPDATE saved_trees SET focus_person_id = NULL WHERE focus_person_id = ?`).run(personId);
    database.prepare(`UPDATE persons SET discarded_at = datetime('now') WHERE id = ?`).run(personId);
  });
  tx();
  // facesUnlinked is preserved as 0 in the return signature for API
  // compatibility — callers that logged this count now always see 0
  // because face links are preserved. photosAffected still reflects
  // how many photos visually lose this person's tag from all UI.
  return { facesUnlinked: 0, photosAffected };
}

/**
 * Permanently delete a discarded person — removes the person record entirely.
 * Only works on persons that have already been discarded.
 */
export function permanentlyDeletePerson(personId: number): boolean {
  const database = getDb();
  const result = database.prepare(`DELETE FROM persons WHERE id = ? AND discarded_at IS NOT NULL`).run(personId);
  return result.changes > 0;
}

/**
 * "Send back to Unnamed" — the PM-side row removal action.
 *
 * Unlinks every face from the person (sets `person_id = NULL` and
 * `verified = 0` so they appear as fresh Unnamed clusters), clears
 * any saved-tree focus pointing at the person, then permanently
 * deletes the person record (no soft-delete / Recycle Bin).
 *
 * Captures + returns an `undoToken` containing the full prior state
 * (person record, face IDs, prior verified flags, prior tree focus
 * references). Pass it back to `restoreUnnamedPerson` to undo the
 * action exactly — re-creates the person, re-links all faces with
 * their prior verified status, restores any tree focus references.
 *
 * Distinct from `discardPerson` which preserves face links + the
 * `verified=1` flag and only sets `discarded_at`. That soft-delete
 * model still drives the Trees Recycle Bin.
 */
export interface UnnameUndoToken {
  person: { name: string; full_name: string | null; avatar_data: string | null; representative_face_id: number | null };
  // Each face's prior link + verified flag, so undo can restore both.
  faces: Array<{ faceId: number; wasVerified: number }>;
  // Tree focus refs we cleared — restore them on undo.
  treeFocusIds: number[];
}

export function unnamePersonAndDelete(personId: number): { facesUnnamed: number; photosAffected: number; undoToken: UnnameUndoToken | null } {
  const database = getDb();
  const personRow = database.prepare(`SELECT name, full_name, avatar_data, representative_face_id FROM persons WHERE id = ?`).get(personId) as { name: string; full_name: string | null; avatar_data: string | null; representative_face_id: number | null } | undefined;
  if (!personRow) return { facesUnnamed: 0, photosAffected: 0, undoToken: null };
  const photosAffected = (database.prepare(
    `SELECT COUNT(DISTINCT file_id) as cnt FROM face_detections WHERE person_id = ?`
  ).get(personId) as { cnt: number }).cnt;
  // Capture state for undo BEFORE we mutate anything.
  const facesBefore = database.prepare(`SELECT id as faceId, verified as wasVerified FROM face_detections WHERE person_id = ?`).all(personId) as Array<{ faceId: number; wasVerified: number }>;
  const treesBefore = database.prepare(`SELECT id FROM saved_trees WHERE focus_person_id = ?`).all(personId) as Array<{ id: number }>;
  const undoToken: UnnameUndoToken = {
    person: personRow,
    faces: facesBefore,
    treeFocusIds: treesBefore.map(t => t.id),
  };
  let facesUnnamed = 0;
  const tx = database.transaction(() => {
    database.prepare(`UPDATE saved_trees SET focus_person_id = NULL WHERE focus_person_id = ?`).run(personId);
    const r = database.prepare(`UPDATE face_detections SET person_id = NULL, verified = 0 WHERE person_id = ?`).run(personId);
    facesUnnamed = r.changes;
    database.prepare(`DELETE FROM persons WHERE id = ?`).run(personId);
  });
  tx();
  return { facesUnnamed, photosAffected, undoToken };
}

/**
 * Reverse a recent `unnamePersonAndDelete` using the token it
 * returned. Recreates the person record, re-links every face with
 * its prior verified flag, and restores any saved-tree focus
 * references. Returns the new personId so callers can refresh UI
 * state pointing at the resurrected person.
 */
export function restoreUnnamedPerson(token: UnnameUndoToken): { personId: number; facesRestored: number } {
  const database = getDb();
  let newPersonId = 0;
  let facesRestored = 0;
  const tx = database.transaction(() => {
    const result = database.prepare(`INSERT INTO persons (name, full_name, avatar_data, representative_face_id) VALUES (?, ?, ?, ?)`).run(
      token.person.name,
      token.person.full_name,
      token.person.avatar_data,
      token.person.representative_face_id,
    );
    newPersonId = result.lastInsertRowid as number;
    const updateFaceVerified = database.prepare(`UPDATE face_detections SET person_id = ?, verified = ? WHERE id = ?`);
    for (const f of token.faces) {
      updateFaceVerified.run(newPersonId, f.wasVerified, f.faceId);
      facesRestored++;
    }
    if (token.treeFocusIds.length > 0) {
      const updateTreeFocus = database.prepare(`UPDATE saved_trees SET focus_person_id = ? WHERE id = ?`);
      for (const tid of token.treeFocusIds) updateTreeFocus.run(newPersonId, tid);
    }
  });
  tx();
  return { personId: newPersonId, facesRestored };
}

/**
 * Delete face detections for a specific person by their person_id.
 * Used for permanently removing ignored/unsure faces — deletes the actual face records
 * and the person record if no faces remain.
 */
export function deleteFacesByPerson(personId: number): { facesDeleted: number } {
  const database = getDb();
  // Get affected file IDs before deleting (for FTS rebuild)
  const affectedFiles = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE person_id = ?`).all(personId) as { file_id: number }[];
  // Delete face detection records
  const result = database.prepare(`DELETE FROM face_detections WHERE person_id = ?`).run(personId);
  // Clean up the person record if no faces remain
  const remaining = (database.prepare(`SELECT COUNT(*) as cnt FROM face_detections WHERE person_id = ?`).get(personId) as { cnt: number }).cnt;
  if (remaining === 0) {
    database.prepare(`DELETE FROM persons WHERE id = ?`).run(personId);
  }
  return { facesDeleted: result.changes };
}

/**
 * Restore a discarded person — clears the discarded_at timestamp.
 * Note: faces must be re-assigned manually since they were unlinked on discard.
 */
export function restorePerson(personId: number): boolean {
  const database = getDb();
  const result = database.prepare(`UPDATE persons SET discarded_at = NULL WHERE id = ?`).run(personId);
  return result.changes > 0;
}

/** List discarded persons */
export function listDiscardedPersons(): PersonRecord[] {
  const database = getDb();
  return database.prepare(`
    SELECT p.*, 0 as photo_count
    FROM persons p
    WHERE p.discarded_at IS NOT NULL
    ORDER BY p.discarded_at DESC
  `).all() as PersonRecord[];
}

/**
 * Legacy alias — soft-deletes (discards) a person.
 */
export function deletePerson(personId: number): { facesUnlinked: number; photosAffected: number } {
  return discardPerson(personId);
}

/** Get a person by ID. Returns null for soft-deleted (discarded) persons
 *  — regular UI shouldn't surface them. The Recycle Bin flow queries
 *  listDiscardedPersons() directly when it needs them. */
export function getPersonById(personId: number): PersonRecord | null {
  const database = getDb();
  const row = database.prepare(`
    SELECT p.*, COUNT(DISTINCT fd.file_id) as photo_count
    FROM persons p
    LEFT JOIN face_detections fd ON fd.person_id = p.id
    WHERE p.id = ? AND p.discarded_at IS NULL
    GROUP BY p.id
  `).get(personId) as PersonRecord | undefined;
  return row ?? null;
}

/** Get all face embeddings for clustering */
export function getAllFaceEmbeddings(): { id: number; file_id: number; embedding: Buffer; cluster_id: number | null }[] {
  const database = getDb();
  return database.prepare(`SELECT id, file_id, embedding, cluster_id FROM face_detections WHERE embedding IS NOT NULL`).all() as any[];
}

// ─── PDR Recycle Bin (v2.0.15) ─────────────────────────────────────────────
//
// Soft-delete model: setting `in_recycle_bin = 1` hides a row from every
// user-facing query without touching the file on disk or the index row.
// Restore is a one-statement undo. Permanent delete (separate IPC) sends
// the file to the OS Trash via shell.trashItem() and then removes the
// row + sidecar bits.

export interface RecycleBinEntry {
  id: number;
  file_path: string;
  filename: string;
  file_type: string;
  derived_date: string | null;
  recycled_at: string | null;
  caption: string | null;
}

/** Move a batch of files into the Recycle Bin. Idempotent. */
export function moveFilesToRecycleBin(fileIds: number[]): number {
  if (fileIds.length === 0) return 0;
  const database = getDb();
  const now = new Date().toISOString();
  const stmt = database.prepare(
    `UPDATE indexed_files SET in_recycle_bin = 1, recycled_at = ? WHERE id = ? AND (in_recycle_bin IS NULL OR in_recycle_bin = 0)`
  );
  let updated = 0;
  const tx = database.transaction((ids: number[]) => {
    for (const id of ids) {
      const r = stmt.run(now, id);
      updated += r.changes;
    }
  });
  tx(fileIds);
  return updated;
}

/** Restore files from the Recycle Bin. Idempotent. */
export function restoreFilesFromRecycleBin(fileIds: number[]): number {
  if (fileIds.length === 0) return 0;
  const database = getDb();
  const stmt = database.prepare(
    `UPDATE indexed_files SET in_recycle_bin = 0, recycled_at = NULL WHERE id = ? AND in_recycle_bin = 1`
  );
  let updated = 0;
  const tx = database.transaction((ids: number[]) => {
    for (const id of ids) {
      const r = stmt.run(id);
      updated += r.changes;
    }
  });
  tx(fileIds);
  return updated;
}

/** Remove index rows for the given files. Cascades to album_files,
 *  face_detections, ai_tags (via FKs / explicit deletes). Used by
 *  Permanent Delete after shell.trashItem succeeds. */
export function deleteIndexedFiles(fileIds: number[]): number {
  if (fileIds.length === 0) return 0;
  const database = getDb();
  const delFile = database.prepare(`DELETE FROM indexed_files WHERE id = ?`);
  const delAlbumLinks = database.prepare(`DELETE FROM album_files WHERE file_id = ?`);
  const delFaces = database.prepare(`DELETE FROM face_detections WHERE file_id = ?`);
  const delTags = database.prepare(`DELETE FROM ai_tags WHERE file_id = ?`);
  let removed = 0;
  const tx = database.transaction((ids: number[]) => {
    for (const id of ids) {
      delAlbumLinks.run(id);
      delFaces.run(id);
      delTags.run(id);
      const r = delFile.run(id);
      removed += r.changes;
    }
  });
  tx(fileIds);
  return removed;
}

/** List everything in the Recycle Bin, most-recently-recycled first. */
export function listRecycleBin(limit: number = 5000): RecycleBinEntry[] {
  const database = getDb();
  return database.prepare(
    `SELECT id, file_path, filename, file_type, derived_date, recycled_at, caption
     FROM indexed_files
     WHERE in_recycle_bin = 1
     ORDER BY recycled_at DESC NULLS LAST, id DESC
     LIMIT ?`
  ).all(limit) as RecycleBinEntry[];
}

/** Quick count of recycled items — used by the tab badge. */
export function getRecycleBinCount(): number {
  const database = getDb();
  const row = database.prepare(`SELECT COUNT(*) as n FROM indexed_files WHERE in_recycle_bin = 1`).get() as { n: number };
  return row?.n ?? 0;
}

/**
 * Count faces that have an embedding but no cluster assignment yet.
 * Used at startup to detect a clustering pass that was interrupted
 * (e.g. user quit PDR mid-cluster on a large Takeout import) so we
 * can resume it automatically rather than leaving faces stranded
 * until the user triggers Re-cluster manually.
 */
export function getUnclusteredFaceCount(): number {
  const database = getDb();
  const row = database
    .prepare(`SELECT COUNT(*) as n FROM face_detections WHERE embedding IS NOT NULL AND cluster_id IS NULL`)
    .get() as { n: number };
  return row?.n ?? 0;
}

/**
 * Refine facial recognition by computing per-person average embeddings
 * from verified faces, then matching unnamed faces against those averages.
 *
 * Processes persons in descending order of verified face count (most populous first).
 * Returns stats about what was done.
 */
// v2.0.15 (Terry 2026-06-05) — async + cooperative yielding. This
// function does up to (verified faces × unnamed faces × top-K × 512)
// dot-product operations on JavaScript's single thread — for Terry's
// library that's 2 800 verified Terry faces × 12 000 unnamed faces × 5
// top-K × 512 dim ≈ tens of millions of multiplications, plus DB
// writes. Previously this blocked the main process for 30-60 seconds,
// which made PM's heartbeat ping time out and the "PDR has stopped
// responding" banner fire mid-Improve. Now each outer loop yields via
// setImmediate so the Electron message pump can answer pings (and
// other IPC) between chunks of work. The total work is unchanged —
// only the latency-to-respond changes.
//
// v2.0.15 (Terry 2026-06-06) — yields are now TIME-BASED, not
// iteration-count-based. The old YIELD_EVERY=200 worked out to
// 50-200ms between yields depending on hardware, which is way longer
// than the ~16ms a smooth window drag needs — Terry hit obvious lag
// trying to reposition PM mid-Improve. With YIELD_AFTER_MS=10, main
// gives up the thread at most every 10ms regardless of iteration cost,
// so drag stays at 60fps and tooltip/render responsiveness is
// preserved throughout. Progress event coupling: emit once per yield
// (still gives smooth bar updates without flooding IPC).
const YIELD_AFTER_MS = 10;
const yieldToEventLoop = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

// v2.0.15 (Terry 2026-06-06) — progress callback signature for PM's
// "Improving facial recognition" modal. Called from inside the two
// inner loops (existing-auto-match re-test and unnamed-faces matching)
// every YIELD_EVERY iterations, plus once at "start" and once at
// "done" so the modal can show "Person X / Y" if multiple persons are
// being refined plus per-person inner progress.
export interface RefineProgress {
  phase: 'start' | 'person-start' | 'retest' | 'match' | 'person-done' | 'done';
  personIndex: number;     // 0-based, current person being refined
  personsTotal: number;    // total persons in this run
  personName: string;      // name of current person (empty for 'start' / 'done')
  itemIndex: number;       // current iteration within the active inner loop (retest or match)
  itemsTotal: number;      // total iterations for the active inner loop
  matchedSoFar: number;    // cumulative new matches across all persons in this run
}

export async function refineFromVerifiedFaces(
  similarityThreshold: number = 0.72,
  personFilter?: number,
  onProgress?: (p: RefineProgress) => void,
): Promise<{
  personsProcessed: number;
  newMatches: number;
  perPerson: { personId: number; personName: string; verifiedCount: number; matched: number }[];
}> {
  const database = getDb();

  // Get all real named persons with their verified face counts, most populous first.
  // When personFilter is provided, restrict to that single person — used by the
  // per-row "Improve" button and the post-verify chip prompt so users can run
  // refinement for just the person they were working on instead of all-at-once.
  const persons = personFilter != null
    ? database.prepare(`
        SELECT p.id, p.name, COUNT(fd.id) as verified_count
        FROM persons p
        INNER JOIN face_detections fd ON fd.person_id = p.id AND fd.verified = 1 AND fd.embedding IS NOT NULL
        WHERE p.discarded_at IS NULL
          AND p.id = ?
          AND p.name NOT IN ('__ignored__', '__unsure__')
        GROUP BY p.id
        HAVING verified_count > 0
      `).all(personFilter) as { id: number; name: string; verified_count: number }[]
    : database.prepare(`
        SELECT p.id, p.name, COUNT(fd.id) as verified_count
        FROM persons p
        INNER JOIN face_detections fd ON fd.person_id = p.id AND fd.verified = 1 AND fd.embedding IS NOT NULL
        WHERE p.discarded_at IS NULL
          AND p.name NOT IN ('__ignored__', '__unsure__')
        GROUP BY p.id
        HAVING verified_count > 0
        ORDER BY verified_count DESC
      `).all() as { id: number; name: string; verified_count: number }[];

  const perPerson: { personId: number; personName: string; verifiedCount: number; matched: number }[] = [];
  let totalNewMatches = 0;

  // v2.0.15 — emit 'start' progress so the modal can render before
  // the (possibly slow) per-person SQL queries fire.
  try { onProgress?.({ phase: 'start', personIndex: 0, personsTotal: persons.length, personName: '', itemIndex: 0, itemsTotal: 0, matchedSoFar: 0 }); } catch { /* progress is best-effort */ }

  for (let personIdx = 0; personIdx < persons.length; personIdx++) {
    const person = persons[personIdx];
    try { onProgress?.({ phase: 'person-start', personIndex: personIdx, personsTotal: persons.length, personName: person.name, itemIndex: 0, itemsTotal: 0, matchedSoFar: totalNewMatches }); } catch {}
    // Get verified embeddings for this person
    const verifiedRows = database.prepare(`
      SELECT embedding FROM face_detections
      WHERE person_id = ? AND verified = 1 AND embedding IS NOT NULL
    `).all(person.id) as { embedding: Buffer }[];

    if (verifiedRows.length === 0) {
      perPerson.push({ personId: person.id, personName: person.name, verifiedCount: 0, matched: 0 });
      continue;
    }

    // Top-K-average matching (was: max-of-verified, was-was: average-of-embeddings).
    // The previous max-of-verified approach was fragile: a single weak
    // verified embedding (low magnitude — usually from a small / blurry /
    // poorly-lit face the model couldn't characterise well) acted as a
    // magnet for any other weak embedding from any unrelated face. The
    // result was unrelated people (a black man, a baby, a Christmas elf)
    // getting auto-attached to Mel because each shared a single noisy
    // verified embedding. Diagnosis: low-magnitude vectors cluster near
    // the origin in cosine-similarity space and score artificially high
    // against each other regardless of who they actually depict.
    //
    // Top-K-average requires a candidate face to look like SEVERAL of
    // the person's verified faces, not just one. A weak attractor in
    // the verified set can't dominate because it's only one of K
    // contributors to the average. K is small (5) so the algorithm is
    // still tolerant of age spread, lighting variation, and other
    // legitimate within-person variation — a recent Mel photo only
    // needs to look like ~5 of her many verified photos to match.
    //
    // Additionally, we filter the verified set by magnitude so the
    // worst weak-embedding outliers are excluded from the matching
    // reference altogether — they stay verified for the record, just
    // not eligible as match candidates. The cutoff is set as a
    // fraction of the verified set's median magnitude so it
    // self-calibrates per person.
    const firstVec = new Float32Array(verifiedRows[0].embedding.buffer, verifiedRows[0].embedding.byteOffset, verifiedRows[0].embedding.byteLength / 4);
    const dim = firstVec.length;
    // Pre-compute normalised vectors + magnitudes for each verified
    // face so the per-unnamed-face inner loop is just a dot product.
    const verifiedVecs: Float32Array[] = [];
    const verifiedMags: number[] = [];
    for (const row of verifiedRows) {
      const v = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      let m = 0;
      for (let i = 0; i < dim; i++) m += v[i] * v[i];
      verifiedVecs.push(v);
      verifiedMags.push(Math.sqrt(m));
    }
    // Magnitude-based outlier filter: drop verified embeddings whose
    // magnitude is below 60 % of the median. Empirically (see deep
    // investigation in commit history) the worst attractors had
    // magnitudes ~5-7 against a typical median of ~12, and weak
    // embeddings in that range were responsible for the majority of
    // bogus auto-matches in real-world data.
    const sortedMags = [...verifiedMags].sort((a, b) => a - b);
    const medianMag = sortedMags.length ? sortedMags[Math.floor(sortedMags.length / 2)] : 0;
    const magnitudeFloor = medianMag * 0.6;
    const eligibleVecs: Float32Array[] = [];
    const eligibleMags: number[] = [];
    for (let k = 0; k < verifiedVecs.length; k++) {
      if (verifiedMags[k] >= magnitudeFloor) {
        eligibleVecs.push(verifiedVecs[k]);
        eligibleMags.push(verifiedMags[k]);
      }
    }
    // Fall back to the full set if filtering removed everything (small
    // verified sets shouldn't be left with zero candidates).
    const refVecs = eligibleVecs.length > 0 ? eligibleVecs : verifiedVecs;
    const refMags = eligibleVecs.length > 0 ? eligibleMags : verifiedMags;
    // K = 5 by default, but never larger than the eligible set
    // (otherwise top-K would just be the average of everything which
    // over-corrects on small verified sets).
    const TOP_K = Math.min(5, refVecs.length);

    // (The unnamed pool is fetched LATER, after the existing-auto-
    // match re-test step, because that step may un-assign rows back
    // into the unnamed pool. Fetching now and looping over a stale
    // list would miss those newly-un-assigned candidates.)

    let matchedForThisPerson = 0;
    // We now store the actual similarity score on the face row so
    // the S&D Match slider can filter live at search time. That
    // means we can't early-break the inner loop — we need the
    // full max similarity across all verified faces (the early
    // break was an optimisation that's now incompatible with
    // accurate per-face scores). Cost is bounded — typically a
    // few hundred dot products per unnamed face per named person.
    const assignStmt = database.prepare(`UPDATE face_detections SET person_id = ?, match_similarity = ? WHERE id = ?`);
    const unassignStmt = database.prepare(`UPDATE face_detections SET person_id = NULL, match_similarity = NULL WHERE id = ?`);

    // ─── Re-test existing unverified auto-matches ─────────────────────
    // Improve Facial Recognition now ALSO retroactively cleans up
    // bogus auto-matches that were assigned under an older / looser
    // algorithm. We pull every unverified face currently attached to
    // this person and re-score it with the new top-K-average +
    // magnitude-floor algorithm. Any face that doesn't pass the
    // current threshold is un-assigned (person_id → NULL) and made
    // available for fresh matching against other people in the
    // unnamed-faces loop below. Verified faces are NEVER touched;
    // they remain the user's ground truth regardless of algorithm
    // changes. This gives the user immediate cleanup of historical
    // bogus matches with no new UI surface — clicking the existing
    // Improve button does both add new and clean up old.
    const existingAutoMatches = database.prepare(
      `SELECT id, embedding FROM face_detections WHERE person_id = ? AND verified = 0 AND embedding IS NOT NULL`,
    ).all(person.id) as Array<{ id: number; embedding: Buffer }>;
    let unassignedCount = 0;
    let existingIdx = 0;
    let existingLastYield = performance.now();
    for (const row of existingAutoMatches) {
      // v2.0.15 (Terry 2026-06-06) — TIME-based yield. If we've held
      // the thread for ≥ YIELD_AFTER_MS since the last yield, give it
      // back so drag / IPC / tooltip render stay smooth. Old iteration-
      // count basis (every 200 rows) had unpredictable timing across
      // hardware; this is consistent at "no more than YIELD_AFTER_MS
      // hold". Progress event piggybacks on the same yield.
      if (existingIdx > 0 && performance.now() - existingLastYield >= YIELD_AFTER_MS) {
        await yieldToEventLoop();
        existingLastYield = performance.now();
        try { onProgress?.({ phase: 'retest', personIndex: personIdx, personsTotal: persons.length, personName: person.name, itemIndex: existingIdx, itemsTotal: existingAutoMatches.length, matchedSoFar: totalNewMatches }); } catch {}
      }
      existingIdx++;
      const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      let magB = 0;
      for (let i = 0; i < dim; i++) magB += vec[i] * vec[i];
      const magBSqrt = Math.sqrt(magB);
      // Weak candidate → un-assign immediately (it shouldn't be
      // attached to anyone under the new rules).
      if (magBSqrt < magnitudeFloor) {
        unassignStmt.run(row.id);
        unassignedCount++;
        continue;
      }
      const sims: number[] = [];
      for (let k = 0; k < refVecs.length; k++) {
        const va = refVecs[k];
        let dot = 0;
        for (let i = 0; i < dim; i++) dot += va[i] * vec[i];
        const denom = refMags[k] * magBSqrt;
        sims.push(denom === 0 ? 0 : dot / denom);
      }
      sims.sort((a, b) => b - a);
      let topKSum = 0;
      for (let k = 0; k < TOP_K; k++) topKSum += sims[k];
      const topKAvg = TOP_K > 0 ? topKSum / TOP_K : 0;
      if (topKAvg < similarityThreshold) {
        // No longer matches — un-assign so the candidate either
        // attaches to a different named person below, or returns
        // to the unnamed pool.
        unassignStmt.run(row.id);
        unassignedCount++;
      } else {
        // Still matches — refresh the stored similarity score so
        // S&D's Match slider reflects the new metric.
        assignStmt.run(person.id, topKAvg, row.id);
      }
    }
    if (unassignedCount > 0) {
      console.log(`[AI] Improve: re-tested ${existingAutoMatches.length} existing auto-match(es) for ${person.name}, un-assigned ${unassignedCount} that no longer pass the new algorithm`);
    }

    // Re-fetch the unnamed pool because we may have just added rows
    // to it via the un-assign step above.
    const unnamedRefreshed = database.prepare(`
      SELECT id, embedding FROM face_detections
      WHERE person_id IS NULL AND embedding IS NOT NULL
    `).all() as { id: number; embedding: Buffer }[];

    let unnamedIdx = 0;
    let unnamedLastYield = performance.now();
    for (const row of unnamedRefreshed) {
      // v2.0.15 (Terry 2026-06-06) — TIME-based yield (10ms). Biggest
      // CPU loop in PDR (12 000+ unnamed faces for Terry's library)
      // so frequent yields are critical for keeping window drag, IPC,
      // and tooltip render smooth during Improve. Progress event
      // emits at the same cadence so the modal bar updates smoothly
      // without flooding the IPC channel.
      if (unnamedIdx > 0 && performance.now() - unnamedLastYield >= YIELD_AFTER_MS) {
        await yieldToEventLoop();
        unnamedLastYield = performance.now();
        try { onProgress?.({ phase: 'match', personIndex: personIdx, personsTotal: persons.length, personName: person.name, itemIndex: unnamedIdx, itemsTotal: unnamedRefreshed.length, matchedSoFar: totalNewMatches + matchedForThisPerson }); } catch {}
      }
      unnamedIdx++;
      const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      let magB = 0;
      for (let i = 0; i < dim; i++) magB += vec[i] * vec[i];
      const magBSqrt = Math.sqrt(magB);
      // Skip candidate faces with weak embeddings — same magnitude
      // floor as the verified set. A weak candidate scored against
      // anything tends to produce false positives in the noise zone.
      if (magBSqrt < magnitudeFloor) continue;

      // Compute similarity against every ELIGIBLE verified face,
      // collect into an array so we can take the top-K average.
      const sims: number[] = [];
      for (let k = 0; k < refVecs.length; k++) {
        const va = refVecs[k];
        let dot = 0;
        for (let i = 0; i < dim; i++) dot += va[i] * vec[i];
        const denom = refMags[k] * magBSqrt;
        sims.push(denom === 0 ? 0 : dot / denom);
      }
      // Top-K average — sort descending, average the K highest.
      sims.sort((a, b) => b - a);
      let topKSum = 0;
      for (let k = 0; k < TOP_K; k++) topKSum += sims[k];
      const topKAvg = topKSum / TOP_K;
      if (topKAvg >= similarityThreshold) {
        // Persist the top-K-average score (not the max) so the S&D
        // Match slider's filtering reflects the same metric the
        // matcher used to make the assignment.
        assignStmt.run(person.id, topKAvg, row.id);
        matchedForThisPerson++;
      }
    }

    totalNewMatches += matchedForThisPerson;
    perPerson.push({
      personId: person.id,
      personName: person.name,
      verifiedCount: verifiedRows.length,
      matched: matchedForThisPerson,
    });
    try { onProgress?.({ phase: 'person-done', personIndex: personIdx, personsTotal: persons.length, personName: person.name, itemIndex: unnamedRefreshed.length, itemsTotal: unnamedRefreshed.length, matchedSoFar: totalNewMatches }); } catch {}
  }

  try { onProgress?.({ phase: 'done', personIndex: persons.length, personsTotal: persons.length, personName: '', itemIndex: 0, itemsTotal: 0, matchedSoFar: totalNewMatches }); } catch {}

  return {
    personsProcessed: persons.length,
    newMatches: totalNewMatches,
    perPerson,
  };
}

/** Update cluster assignments */
export function updateFaceCluster(faceId: number, clusterId: number): void {
  const database = getDb();
  database.prepare(`UPDATE face_detections SET cluster_id = ? WHERE id = ?`).run(clusterId, faceId);
}

/**
 * Apply a batch of cluster assignments in a single transaction. Used
 * when clustering runs in the AI worker_thread and main applies the
 * results in bulk — far faster than N separate UPDATE statements and
 * keeps the DB lock window tight enough that it doesn't show up as
 * a "Not Responding" pause on the main thread.
 */
export function updateFaceClustersBatch(updates: { faceId: number; clusterId: number }[]): void {
  if (updates.length === 0) return;
  const database = getDb();
  const stmt = database.prepare(`UPDATE face_detections SET cluster_id = ? WHERE id = ?`);
  const tx = database.transaction((rows: { faceId: number; clusterId: number }[]) => {
    for (const row of rows) stmt.run(row.clusterId, row.faceId);
  });
  tx(updates);
}

/** Get all face clusters with representative face data for the People management view */
export function getPersonClusters(): { cluster_id: number; person_id: number | null; person_name: string | null; person_full_name: string | null; face_count: number; photo_count: number; representative_face_id: number; representative_file_id: number; representative_file_path: string; box_x: number; box_y: number; box_w: number; box_h: number; sample_faces: { face_id: number; file_id: number; file_path: string; derived_date: string | null; box_x: number; box_y: number; box_w: number; box_h: number; confidence: number; verified: number }[] }[] {
  const database = getDb();

  // Named clusters: group by person_id (so individually reassigned faces appear under their new person)
  // For special categories (__ignored__, __unsure__), group by cluster_id to keep original clusters separate
  const realNamedClusters = database.prepare(`
    SELECT
      fd.cluster_id,
      p.id as person_id,
      p.name as person_name,
      p.full_name as person_full_name,
      COUNT(fd.id) as face_count,
      COUNT(DISTINCT fd.file_id) as photo_count,
      MIN(fd.id) as representative_face_id
    FROM face_detections fd
    INNER JOIN persons p ON fd.person_id = p.id
    WHERE fd.cluster_id IS NOT NULL AND fd.person_id IS NOT NULL AND p.discarded_at IS NULL
      AND p.name NOT IN ('__ignored__', '__unsure__')
    GROUP BY fd.person_id
    ORDER BY face_count DESC
  `).all() as any[];

  // Special category clusters (__ignored__, __unsure__): group by cluster_id AND person_id
  // so only faces actually assigned to the special person appear (not faces from same cluster assigned to real names)
  const specialClusters = database.prepare(`
    SELECT
      fd.cluster_id,
      p.id as person_id,
      p.name as person_name,
      p.full_name as person_full_name,
      COUNT(fd.id) as face_count,
      COUNT(DISTINCT fd.file_id) as photo_count,
      MIN(fd.id) as representative_face_id
    FROM face_detections fd
    INNER JOIN persons p ON fd.person_id = p.id
    WHERE fd.cluster_id IS NOT NULL AND fd.person_id IS NOT NULL AND p.discarded_at IS NULL
      AND p.name IN ('__ignored__', '__unsure__')
    GROUP BY fd.cluster_id, fd.person_id
    ORDER BY face_count DESC
  `).all() as any[];

  const namedClusters = [...realNamedClusters, ...specialClusters];

  // Unnamed clusters: faces with no person assigned, grouped by cluster_id
  const unnamedClusters = database.prepare(`
    SELECT
      fd.cluster_id,
      NULL as person_id,
      NULL as person_name,
      COUNT(fd.id) as face_count,
      COUNT(DISTINCT fd.file_id) as photo_count,
      MIN(fd.id) as representative_face_id
    FROM face_detections fd
    WHERE fd.cluster_id IS NOT NULL AND fd.person_id IS NULL
    GROUP BY fd.cluster_id
    ORDER BY face_count DESC
  `).all() as any[];

  const clusters = [...namedClusters, ...unnamedClusters];

  // Before: for every cluster we ran 1–2 tiny queries (rep + samples),
  // meaning a library with 200 clusters issued 200–400 round-trips
  // here. Now we fetch EVERY face in every cluster in one batch query,
  // plus one batch query for user-chosen representative overrides, and
  // resolve rep / samples in JS. That takes the N+1 pattern down to
  // a constant 5 queries regardless of cluster count.
  // Also pulls derived_date so the per-cluster sample strip can be
  // sorted chronologically (left = oldest, right = newest). PDR's
  // identity is date-sorting, so the face strip should respect the
  // same ordering — makes it intuitive to scan a person's life
  // through time. Faces with NULL derived_date go to the end.
  const allClusterFaces = database.prepare(`
    SELECT
      fd.id as face_id,
      fd.person_id,
      fd.cluster_id,
      fd.file_id,
      f.file_path,
      f.derived_date,
      fd.box_x, fd.box_y, fd.box_w, fd.box_h,
      fd.confidence,
      fd.verified,
      fd.match_similarity
    FROM face_detections fd
    INNER JOIN indexed_files f ON fd.file_id = f.id
    LEFT JOIN persons p ON fd.person_id = p.id
    WHERE fd.cluster_id IS NOT NULL
      AND (fd.person_id IS NULL OR p.discarded_at IS NULL)
    ORDER BY fd.confidence DESC
  `).all() as Array<{
    face_id: number; person_id: number | null; cluster_id: number;
    file_id: number; file_path: string;
    derived_date: string | null;
    box_x: number; box_y: number; box_w: number; box_h: number;
    confidence: number; verified: number;
    match_similarity: number | null;
  }>;

  // Index the faces three ways matching the three grouping schemes:
  // by person_id (named), by cluster_id+person_id (special), by
  // cluster_id (unnamed). Since the SELECT is ordered by confidence
  // DESC, faces[0] is always the highest-confidence (= representative)
  // candidate for the group.
  const facesByPerson = new Map<number, typeof allClusterFaces>();
  const facesByClusterPerson = new Map<string, typeof allClusterFaces>();
  const facesByCluster = new Map<number, typeof allClusterFaces>();
  for (const f of allClusterFaces) {
    if (f.person_id != null) {
      if (!facesByPerson.has(f.person_id)) facesByPerson.set(f.person_id, []);
      facesByPerson.get(f.person_id)!.push(f);
      const k = `${f.cluster_id}_${f.person_id}`;
      if (!facesByClusterPerson.has(k)) facesByClusterPerson.set(k, []);
      facesByClusterPerson.get(k)!.push(f);
    } else {
      if (!facesByCluster.has(f.cluster_id)) facesByCluster.set(f.cluster_id, []);
      facesByCluster.get(f.cluster_id)!.push(f);
    }
  }

  // User-chosen representative face overrides: one batch fetch keyed
  // by the named-person IDs we're about to render. A value of NULL
  // means "use automatic pick (highest confidence)".
  const namedPersonIds = realNamedClusters.map(c => c.person_id).filter((id): id is number => id != null);
  const repOverrides = new Map<number, number | null>();
  if (namedPersonIds.length > 0) {
    const placeholders = namedPersonIds.map(() => '?').join(',');
    const rows = database.prepare(
      `SELECT id, representative_face_id FROM persons WHERE id IN (${placeholders})`
    ).all(...namedPersonIds) as Array<{ id: number; representative_face_id: number | null }>;
    for (const r of rows) repOverrides.set(r.id, r.representative_face_id);
  }

  return clusters.map((c: any) => {
    const isNamed = c.person_id != null;
    const isSpecial = isNamed && (c.person_name === '__ignored__' || c.person_name === '__unsure__');
    const faces = isSpecial
      ? (facesByClusterPerson.get(`${c.cluster_id}_${c.person_id}`) ?? [])
      : isNamed
        ? (facesByPerson.get(c.person_id) ?? [])
        : (facesByCluster.get(c.cluster_id) ?? []);

    // Rep selection precedence for named persons:
    //   1. User-chosen override (`persons.representative_face_id`)
    //      — wins outright if that face is still in the group.
    //   2. Highest-confidence VERIFIED face — auto-pick falls back
    //      only to faces the user has explicitly verified, so the
    //      thumbnail is never an AI-suggested match that "looks
    //      similar" but is actually someone else.
    //   3. Highest-confidence face overall (current behaviour) —
    //      last-resort fallback for freshly-named clusters where
    //      nothing has been verified yet, so the row still has a
    //      thumbnail rather than collapsing to a monogram.
    //
    // For unnamed / __unsure__ / __ignored__ clusters we keep the
    // confidence-only pick — verification status only matters once
    // a name has been attached, and most faces in those tabs are
    // unverified by definition.
    let rep: typeof allClusterFaces[number] | undefined = faces[0];
    if (isNamed && !isSpecial) {
      const overrideId = repOverrides.get(c.person_id as number);
      if (overrideId != null) {
        const chosen = faces.find(f => f.face_id === overrideId);
        if (chosen) rep = chosen;
      } else {
        // faces is already sorted DESC by confidence, so the first
        // verified entry is the highest-confidence verified face.
        const verifiedRep = faces.find(f => f.verified === 1);
        if (verifiedRep) rep = verifiedRep;
      }
    }

    // Samples ordering depends on cluster type:
    //   - Real Named persons → CHRONOLOGICAL (oldest left, newest
    //     right) — these are verified, the user is reviewing a
    //     life-history view, and PDR's identity is date-sorting.
    //   - Unnamed / Unsure / Ignored → confidence ASC (lowest first)
    //     — these are still being identified; the user is doing
    //     visual-similarity review and uncertain matches should be
    //     surfaced first. The clustering already groups by
    //     similarity; within a cluster, "least confident first"
    //     focuses the user's attention on the calls that need it.
    //
    // NULL-date faces in chronological mode go to the end so a
    // missing-date face doesn't masquerade as the oldest. Ties on
    // the same date fall back to confidence-ascending for deterministic
    // tiebreaks.
    const isRealNamed = isNamed && !isSpecial;
    const samples = isRealNamed
      ? [...faces].sort((a, b) => {
          const aHas = !!a.derived_date;
          const bHas = !!b.derived_date;
          if (aHas && !bHas) return -1;
          if (!aHas && bHas) return 1;
          if (aHas && bHas) {
            if (a.derived_date! < b.derived_date!) return -1;
            if (a.derived_date! > b.derived_date!) return 1;
          }
          return a.confidence - b.confidence;
        })
      : [...faces].reverse(); // confidence ASC (DB returned DESC)

    return {
      cluster_id: c.cluster_id,
      person_id: c.person_id,
      person_name: c.person_name,
      person_full_name: c.person_full_name ?? null,
      face_count: c.face_count,
      photo_count: c.photo_count,
      representative_face_id: rep?.face_id ?? c.representative_face_id,
      representative_file_id: rep?.file_id ?? 0,
      representative_file_path: rep?.file_path ?? '',
      box_x: rep?.box_x ?? 0,
      box_y: rep?.box_y ?? 0,
      box_w: rep?.box_w ?? 0,
      box_h: rep?.box_h ?? 0,
      sample_faces: samples,
    };
  });
}

/** Get distinct AI tags with counts for filter options (only for current/valid files) */
export function getAiTagOptions(): { tag: string; count: number }[] {
  const database = getDb();
  return database.prepare(`
    SELECT t.tag, COUNT(DISTINCT t.file_id) as count
    FROM ai_tags t
    INNER JOIN indexed_files f ON t.file_id = f.id
    WHERE t.confidence >= 0.3
      AND f.id = (SELECT MAX(f2.id) FROM indexed_files f2 WHERE f2.file_path = f.file_path)
    GROUP BY t.tag
    ORDER BY count DESC
  `).all() as any[];
}

/** Get AI processing stats (scoped to current/valid files only) */
export function getAiStats(): { totalProcessed: number; totalFaces: number; totalPersons: number; totalTags: number; unprocessed: number } {
  const database = getDb();
  // Only count AI data for files that are the latest per path (not stale duplicates)
  const processed = (database.prepare(`
    SELECT COUNT(*) as cnt FROM ai_processing_status s
    INNER JOIN indexed_files f ON s.file_id = f.id
    WHERE (s.face_processed = 1 OR s.tags_processed = 1)
      AND f.id = (SELECT MAX(f2.id) FROM indexed_files f2 WHERE f2.file_path = f.file_path)
  `).get() as any).cnt;
  const faces = (database.prepare(`
    SELECT COUNT(*) as cnt FROM face_detections fd
    INNER JOIN indexed_files f ON fd.file_id = f.id
    WHERE f.id = (SELECT MAX(f2.id) FROM indexed_files f2 WHERE f2.file_path = f.file_path)
  `).get() as any).cnt;
  const persons = (database.prepare(`SELECT COUNT(*) as cnt FROM persons WHERE discarded_at IS NULL AND name != '__ignored__' AND name != '__unsure__'`).get() as any).cnt;
  const tags = (database.prepare(`
    SELECT COUNT(DISTINCT t.tag) as cnt FROM ai_tags t
    INNER JOIN indexed_files f ON t.file_id = f.id
    WHERE f.id = (SELECT MAX(f2.id) FROM indexed_files f2 WHERE f2.file_path = f.file_path)
  `).get() as any).cnt;
  const totalPhotos = (database.prepare(`SELECT COUNT(*) as cnt FROM indexed_files f WHERE f.file_type = 'photo' AND f.id = (SELECT MAX(f2.id) FROM indexed_files f2 WHERE f2.file_path = f.file_path)`).get() as any).cnt;
  return { totalProcessed: processed, totalFaces: faces, totalPersons: persons, totalTags: tags, unprocessed: Math.max(0, totalPhotos - processed) };
}

/** Clear old face data from a previous model so faces get re-processed */
export function clearFaceDataForModelUpgrade(): void {
  const database = getDb();
  // Check if any faces were processed with the old model (transformers-v1 = DETR)
  const oldFaces = database.prepare(
    `SELECT COUNT(*) as cnt FROM ai_processing_status WHERE face_processed = 1 AND (face_model_ver = 'transformers-v1' OR face_model_ver IS NULL)`
  ).get() as { cnt: number };
  if (oldFaces.cnt > 0) {
    console.log(`[AI] Clearing ${oldFaces.cnt} old DETR face detections for model upgrade to @vladmandic/human`);
    database.exec(`
      DELETE FROM face_detections;
      DELETE FROM persons;
      UPDATE ai_processing_status SET face_processed = 0, face_model_ver = NULL WHERE face_processed = 1 AND (face_model_ver = 'transformers-v1' OR face_model_ver IS NULL);
    `);
    // Rebuild FTS for affected files
    const affectedFiles = database.prepare(`SELECT file_id FROM ai_processing_status WHERE face_processed = 0`).all() as { file_id: number }[];
    for (const f of affectedFiles) {
      rebuildAiFts(f.file_id);
    }
  }

  // NOTE: previous builds also reset any file marked `face_processed=1`
  // that had zero detections, on the assumption that meant the model had
  // failed to load. That logic was WRONG — a photo legitimately having
  // zero faces (landscape, empty scene, text) is a valid result, not a
  // failure. Resetting those caused the entire library to be re-analysed
  // on every launch, which users saw as the "10–15 minute freeze".
  // We no longer reset based on "0 faces". A photo is re-analysed only
  // if explicitly requested (e.g. model upgrade) or was never analysed.
}

/** Reset ONLY the AI tags + their processing status so the indexer
 *  re-runs classification against the current label set. Preserves
 *  face_detections, persons, verified face-to-person assignments, and
 *  all relationships — nothing visible to the user is lost. Use after
 *  expanding the DEFAULT_TAGS list or improving the tagger. */
export function resetAllTagAnalysis(): { filesQueued: number } {
  const database = getDb();
  database.exec(`
    DELETE FROM ai_tags;
    UPDATE ai_processing_status SET tags_processed = 0, tags_model_ver = NULL;
  `);
  const row = database.prepare(`
    SELECT COUNT(*) AS cnt FROM indexed_files WHERE file_type = 'photo'
  `).get() as { cnt: number };
  // FTS rows hold stale tag text — rebuild them as the indexer re-runs,
  // but for now wipe the AI FTS content so search doesn't return old tags.
  try { database.exec(`DELETE FROM files_ai_fts`); } catch {}
  return { filesQueued: row.cnt };
}

/**
 * Snapshot system — three kinds, all stored in <userdata>/backups/ as
 * raw .db copies:
 *
 *   - 'auto-launch'   created on every PDR launch by initDatabase().
 *                     Last 5 kept rotating (backup-0..4).
 *   - 'auto-event'    created automatically before any risky operation
 *                     (Improve Recognition, row removal, bulk verifies,
 *                     Lightroom import when re-enabled). Last 10 kept.
 *   - 'manual'        created when the user clicks "Take a snapshot now"
 *                     in Settings → Backup. Optional name. Never
 *                     auto-evicted — user manages these explicitly.
 *
 * Plus granular retention on auto-launch snapshots: in addition to the
 * rolling 5, we keep ONE per day for 7 days and ONE per week for 4
 * weeks. Total ~16 files in the worst case (~100 MB on disk for a
 * library with thousands of tagged faces). The older snapshots are
 * auto-promoted on each launch — see `pruneAutoSnapshots`.
 *
 * Filenames encode kind + ISO timestamp + optional label so the
 * directory is self-describing if the user opens it manually.
 */

export type SnapshotKind = 'auto-launch' | 'auto-event' | 'manual';

export interface Snapshot {
  path: string;
  filename: string;
  sizeBytes: number;
  mtime: string;
  kind: SnapshotKind;
  /** Human-readable label for tagged events ("Before Improve Recognition")
   *  or user-supplied for manual snapshots ("Pre-holiday backup"). */
  label: string | null;
}

const BACKUP_DIR_NAME = 'backups';
function getBackupDir(): string {
  const dbPath = getDbPath();
  const dir = path.join(path.dirname(dbPath), BACKUP_DIR_NAME);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Filename → kind + label parsing. New filenames look like:
 *    snapshot-auto-launch-2026-04-27T12-00-00.000Z.db
 *    snapshot-auto-event-2026-04-27T12-00-00.000Z__Before-Improve-Recognition.db
 *    snapshot-manual-2026-04-27T12-00-00.000Z__Pre-holiday-backup.db
 *  Legacy 'pdr-search.backup-{0..4}.db' files map to auto-launch (no label). */
function parseSnapshotName(name: string): { kind: SnapshotKind; label: string | null } | null {
  if (!name.endsWith('.db')) return null;
  if (/^pdr-search\.backup-\d+\.db$/.test(name)) return { kind: 'auto-launch', label: null };
  const m = /^snapshot-(auto-launch|auto-event|manual)-[^_]+(?:__(.+))?\.db$/.exec(name);
  if (!m) return null;
  const kind = m[1] as SnapshotKind;
  const label = m[2] ? m[2].replace(/-/g, ' ') : null;
  return { kind, label };
}

/** Generate a new snapshot filename. Slugifies label so it's safe on
 *  every filesystem (Windows balks at colons + most Unix shells dislike
 *  spaces). */
function makeSnapshotFilename(kind: SnapshotKind, label?: string): string {
  const ts = new Date().toISOString().replace(/[:]/g, '-');
  const slug = label ? `__${label.trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}` : '';
  return `snapshot-${kind}-${ts}${slug}.db`;
}

/**
 * Take a snapshot of the live DB right now. Used by tagged-event
 * triggers (auto-event) and the manual "Take snapshot now" button.
 * Cheap — just a file copy at the OS level, no SQLite traffic. Errors
 * are non-fatal: if the copy fails (disk full, permission), we log
 * and the calling action proceeds without a snapshot. The user is
 * never blocked by backup machinery.
 */
export function takeSnapshot(kind: SnapshotKind, label?: string): { success: boolean; path?: string; error?: string } {
  try {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) return { success: false, error: 'Live DB not found' };
    // Checkpoint so any uncommitted WAL frames land in the main DB
    // file before we copy it (otherwise the snapshot can lag).
    try { db?.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    const dir = getBackupDir();
    const name = makeSnapshotFilename(kind, label);
    const dst = path.join(dir, name);
    fs.copyFileSync(dbPath, dst);
    if (kind === 'auto-event') pruneAutoEvent();
    return { success: true, path: dst };
  } catch (err) {
    console.warn('[snapshot] take failed:', err);
    return { success: false, error: (err as Error).message };
  }
}

/** Keep the most recent 10 auto-event snapshots; delete older ones. */
function pruneAutoEvent(): void {
  const dir = getBackupDir();
  const events: Array<{ path: string; mtime: number }> = [];
  for (const name of fs.readdirSync(dir)) {
    const parsed = parseSnapshotName(name);
    if (parsed?.kind !== 'auto-event') continue;
    try { events.push({ path: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }); } catch {}
  }
  events.sort((a, b) => b.mtime - a.mtime);
  for (const e of events.slice(10)) {
    try { fs.unlinkSync(e.path); } catch {}
  }
}

/**
 * Granular retention promotion for auto-launch snapshots. Run on
 * each PDR launch right after `initDatabase`'s rolling rotation
 * happens, BEFORE the new launch snapshot is taken. Strategy:
 *   - Last 5 launches: kept by initDatabase's existing rotation.
 *   - Daily: keep ONE snapshot per calendar day, last 7 days.
 *   - Weekly: keep ONE snapshot per ISO-week, last 4 weeks.
 *
 * We don't COPY anything here — we promote existing rolling snapshots
 * by RENAMING them with a label so they survive the next rotation.
 * Older snapshots that fall outside all three windows get deleted.
 */
export function pruneAutoSnapshots(): void {
  const dir = getBackupDir();
  const all: Array<{ path: string; filename: string; mtime: Date; parsed: ReturnType<typeof parseSnapshotName> }> = [];
  for (const name of fs.readdirSync(dir)) {
    const parsed = parseSnapshotName(name);
    if (parsed?.kind !== 'auto-launch') continue;
    try {
      all.push({ path: path.join(dir, name), filename: name, mtime: fs.statSync(path.join(dir, name)).mtime, parsed });
    } catch {}
  }
  all.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  // Buckets: per-calendar-day (last 7) and per-ISO-week (last 4).
  const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const weekKey = (d: Date) => {
    // ISO week-of-year: Monday-start. Good enough for retention buckets.
    const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = (tmp.getUTCDay() + 6) % 7;
    tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
    const week1 = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 4));
    const w = 1 + Math.round(((tmp.getTime() - week1.getTime()) / 86_400_000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
    return `${tmp.getUTCFullYear()}-W${w}`;
  };

  const now = new Date();
  const daysAgo = (d: Date) => Math.floor((now.getTime() - d.getTime()) / 86_400_000);

  const keptDailyByDay = new Map<string, typeof all[number]>();
  const keptWeeklyByWeek = new Map<string, typeof all[number]>();
  const rollingFive = all.slice(0, 5); // keep first 5 newest as rolling

  for (const entry of all) {
    if (rollingFive.includes(entry)) continue;
    const age = daysAgo(entry.mtime);
    if (age <= 7) {
      const k = dayKey(entry.mtime);
      if (!keptDailyByDay.has(k)) keptDailyByDay.set(k, entry);
    }
    if (age <= 28) {
      const k = weekKey(entry.mtime);
      if (!keptWeeklyByWeek.has(k)) keptWeeklyByWeek.set(k, entry);
    }
  }

  const keep = new Set<string>([
    ...rollingFive.map(e => e.path),
    ...Array.from(keptDailyByDay.values()).map(e => e.path),
    ...Array.from(keptWeeklyByWeek.values()).map(e => e.path),
  ]);

  for (const entry of all) {
    if (!keep.has(entry.path)) {
      try { fs.unlinkSync(entry.path); } catch {}
    }
  }
}

/**
 * Enumerate all snapshots available for restore. Returns newest first
 * so the UI list reads naturally. The caller can group by `kind` or
 * filter — we don't pre-segment here.
 *
 * Legacy `pdr-search.backup-{0..4}.db` files are surfaced as
 * 'auto-launch' kind so users with old PDR data can still restore.
 *
 * Pre-reanalyze snapshots from an earlier PDR build (the user-facing
 * Re-analyze action that triggered them was removed) are NOT
 * surfaced — v2 has no users with these. Any legacy files with that
 * naming pattern are deleted on first call so they don't drift.
 */
export function listSnapshots(): Snapshot[] {
  const dir = getBackupDir();
  if (!fs.existsSync(dir)) return [];
  const entries: Snapshot[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.db')) continue;
    if (name.includes('pre-reanalyze')) {
      // Legacy from an old PDR build — not relevant to v2 users.
      try { fs.unlinkSync(path.join(dir, name)); } catch {}
      continue;
    }
    const parsed = parseSnapshotName(name);
    if (!parsed) continue;
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    entries.push({
      path: full,
      filename: name,
      sizeBytes: stat.size,
      mtime: stat.mtime.toISOString(),
      kind: parsed.kind,
      label: parsed.label,
    });
  }
  entries.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return entries;
}

/** Backwards-compatible wrapper for callers that still want the old
 *  shape. Just maps to the new typed list. New code should use
 *  `listSnapshots()` directly. */
export function listDbBackups(): Array<{ path: string; filename: string; sizeBytes: number; mtime: string; kind: 'rolling' | 'pre-reanalyze' | 'manual' | 'auto-event'; label: string | null }> {
  return listSnapshots().map(s => ({
    path: s.path,
    filename: s.filename,
    sizeBytes: s.sizeBytes,
    mtime: s.mtime,
    kind: s.kind === 'auto-launch' ? 'rolling' : s.kind,
    label: s.label,
  }));
}

/** Delete a single snapshot by path. Used by manual snapshot
 *  housekeeping in Settings → Backup. */
export function deleteSnapshot(snapshotPath: string): { success: boolean; error?: string } {
  try {
    if (!fs.existsSync(snapshotPath)) return { success: false, error: 'Snapshot file not found' };
    fs.unlinkSync(snapshotPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Restore the live DB from a backup snapshot. The caller is expected to
 * confirm with the user first — this is destructive and replaces every
 * row in the live DB. Closes the current DB connection, copies the
 * snapshot over the live file, and re-opens. Caller should reload UI
 * state after a successful restore so any cached cluster lists / face
 * crops are flushed.
 */
export function restoreDbFromBackup(snapshotPath: string): { restored: boolean; error?: string } {
  if (!fs.existsSync(snapshotPath)) return { restored: false, error: 'Snapshot file not found' };
  const dbPath = getDbPath();
  try {
    closeDatabase();
    // Belt-and-braces: also nuke the WAL/SHM sidecars so SQLite doesn't
    // try to replay journal pages from the OLD DB onto the freshly-copied
    // backup. Without this, the restored content can be silently rolled
    // forward by stale WAL frames.
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      try { if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar); } catch {}
    }
    fs.copyFileSync(snapshotPath, dbPath);
    initDatabase();
    return { restored: true };
  } catch (err) {
    return { restored: false, error: (err as Error).message };
  }
}

/** Clear all AI data (faces, tags, processing status) */
export function clearAllAiData(): void {
  const database = getDb();
  database.exec(`
    DELETE FROM face_detections;
    DELETE FROM persons;
    DELETE FROM ai_tags;
    DELETE FROM ai_processing_status;
    DELETE FROM files_ai_fts;
  `);
}

/** Also clear AI data when clearing all index data */
export function clearAllIndexAndAiData(): void {
  clearAllAiData();
  clearAllIndexData();
}

// ─── Data integrity / cleanup ───────────────────────────────────────────────

/**
 * NEUTERED 2026-05-23 (v2.0.11) — DATA-INTEGRITY HOTFIX.
 *
 * This function previously deleted any indexed_runs row that wasn't
 * MAX(id) per destination_path, treating "two runs to the same
 * Library Drive" as duplicates. CASCADE-delete then wiped all the
 * indexed_files rows belonging to the deleted runs, taking their
 * face_detections, ai_tags, and album_files with them.
 *
 * The premise was wrong. Multiple Fix runs to the same Library Drive
 * are ADDITIVE, not duplicate — every Fix appends new files to the
 * same library. So this function silently shed thousands of real
 * photo records on every launch for users with active libraries.
 *
 * Terry's case 2026-05-22: library went from 13,817 photos in the DB
 * down to 3,719 in a single launch because purgeDuplicateRuns saw
 * two indexed_runs rows pointing at D:\1. Photos\1. PDR Library Drive
 * and cascade-deleted the older one's 10,098 file rows. Jane's case
 * 2026-05-22 was the same bug fired across multiple launches over
 * weeks — her DB ended up empty.
 *
 * Files on disk were untouched both times. The catch-up indexer in
 * v2.0.9 rebuilds the file rows from disk. Downstream associations
 * (faces, AI tags, album memberships) are gone for the cascaded rows
 * and require re-running AI / re-importing Takeout albums.
 *
 * The legitimate "zombie run from a deleted-and-recreated destination"
 * case this was originally written for is covered by purgeStaleIndexedFiles
 * (Step 3 of runDatabaseCleanup) — it removes file rows for files that
 * no longer exist on disk, which is the correct behaviour when a
 * folder has been deleted. We don't need to delete the run records
 * themselves, and doing so is destructive in the additive case.
 *
 * Kept as an exported function (returning 0) so the call site in
 * runDatabaseCleanup stays stable without a wider refactor.
 */
export function purgeDuplicateRuns(): number {
  console.log(`[DB Cleanup] purgeDuplicateRuns is a no-op since v2.0.11 (was cascade-deleting real photo rows). See function comment for the full story.`);
  return 0;
}

/**
 * Purge duplicate indexed_files rows — keeps only the latest (MAX id) per file_path.
 * Also removes AI data that references the deleted duplicates (via CASCADE).
 * Returns the number of rows removed.
 */
export function purgeDuplicateIndexedFiles(): number {
  // Retired destructive behaviour: this used to DELETE duplicate rows
  // outright, which cascaded through face_detections and wiped verified
  // faces. It now delegates to consolidateIndexedFilesDuplicates() which
  // moves all downstream data onto the winner row BEFORE removing the
  // losers — preserving every verification and AI tag.
  const result = consolidateIndexedFilesDuplicates();
  console.log(`[DB Cleanup] Consolidated ${result.groupsMerged} duplicate group(s) safely; removed ${result.rowsRemoved} redundant row(s)`);
  return result.rowsRemoved;
}

/**
 * Remove indexed_files where the file no longer exists on disk.
 * Returns { removed: number, checked: number }.
 */
// v2.0.11 — async + chunked. Previously this was a synchronous
// for-loop calling fs.existsSync on every indexed_files row (26k+ on
// Terry's library). Each existsSync is a blocking syscall on the main
// thread, so 26k of them = 6-15 seconds of pure main-thread block.
// During that block, Chromium's main browser thread (= Electron's
// main process) can't pump its message loop, can't respond to OS
// WM_NCHITTEST drag messages, can't repaint. Windows ghosts the
// title bar white as "Not Responding" after ~5 s. Terry 2026-05-24
// reproduced this with a 50 GB orphan staging set in PDR_Temp.
//
// Fix: chunk the existsSync loop into batches of 500, yield via
// setImmediate between batches. Each batch is ~150 ms of work; the
// message pump runs between batches so window drag, IPC responses,
// and repaints stay responsive. Total cleanup time is the same; what
// changes is that the main thread is no longer monopolised.
export async function purgeStaleIndexedFiles(): Promise<{ removed: number; checked: number }> {
  const database = getDb();
  const rows = database.prepare(`SELECT id, file_path FROM indexed_files`).all() as { id: number; file_path: string }[];
  const staleIds: number[] = [];

  const SCAN_BATCH = 500;
  for (let i = 0; i < rows.length; i += SCAN_BATCH) {
    const end = Math.min(i + SCAN_BATCH, rows.length);
    for (let j = i; j < end; j++) {
      if (!fs.existsSync(rows[j].file_path)) {
        staleIds.push(rows[j].id);
      }
    }
    // Yield to the event loop so the main thread can service OS
    // messages and IPCs between batches. Without this, Windows
    // marks the window Not Responding within ~5 s.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  if (staleIds.length > 0) {
    // Delete in batches of 500 to avoid SQLite variable limits
    const batchSize = 500;
    for (let i = 0; i < staleIds.length; i += batchSize) {
      const batch = staleIds.slice(i, i + batchSize);
      const placeholders = batch.map(() => '?').join(',');
      database.prepare(`DELETE FROM indexed_files WHERE id IN (${placeholders})`).run(...batch);
      // Yield between DELETE batches too — better-sqlite3 is
      // synchronous, so a multi-batch delete with no yield can
      // re-monopolise the thread.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  console.log(`[DB Cleanup] Checked ${rows.length} files, removed ${staleIds.length} stale entries`);
  return { removed: staleIds.length, checked: rows.length };
}

/**
 * Remove orphaned indexed_runs that have zero remaining indexed_files.
 * Returns the number of orphan runs removed.
 */
export function purgeOrphanRuns(): number {
  const database = getDb();
  const result = database.prepare(`
    DELETE FROM indexed_runs
    WHERE id NOT IN (SELECT DISTINCT run_id FROM indexed_files)
  `).run();
  if (result.changes > 0) {
    console.log(`[DB Cleanup] Removed ${result.changes} orphan run(s) with zero files`);
  }
  return result.changes;
}

/**
 * Directly remove indexed_runs whose destination folder no longer exists on disk.
 * This is the "belt and suspenders" approach — rather than relying on stale file
 * cleanup to eventually orphan these runs, we check the destination path directly.
 * CASCADE will clean up associated indexed_files, AI data, etc.
 * Returns { autoRemoved: number, promptUser: IndexedRun[] }.
 *   - autoRemoved: runs where folder AND all files are gone (safe to auto-delete)
 *   - promptUser: runs where folder is gone but some files may still exist elsewhere
 */
// v2.0.11 — async + yielding (see purgeStaleIndexedFiles for the full
// rationale). Same main-thread-blocking concern: fs.existsSync inside
// a for-loop, plus a nested .some() with another fs.existsSync per run.
// Yields between runs so the main process stays responsive.
export async function purgeGhostRuns(): Promise<{ autoRemoved: number; promptUser: IndexedRun[] }> {
  const database = getDb();
  const runs = database.prepare(`SELECT * FROM indexed_runs`).all() as IndexedRun[];
  const autoRemoveIds: number[] = [];
  const promptUser: IndexedRun[] = [];

  for (const run of runs) {
    if (!fs.existsSync(run.destination_path)) {
      // Check if ANY files from this run still exist on disk
      const files = database.prepare(
        `SELECT file_path FROM indexed_files WHERE run_id = ? LIMIT 100`
      ).all(run.id) as { file_path: string }[];

      const hasLiveFiles = files.some(f => fs.existsSync(f.file_path));

      if (hasLiveFiles) {
        // Folder gone but files exist somewhere — user may want to Relocate
        promptUser.push(run);
      } else {
        // Folder AND files are all gone — nothing to preserve, auto-delete
        autoRemoveIds.push(run.id);
      }
    }
    // Yield between runs so the main process can service other work.
    // indexed_runs is typically small (<100 rows) but each run can
    // trigger up to 101 existsSync calls via the .some() above, so
    // yielding here matters when destination paths are unreachable.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  if (autoRemoveIds.length > 0) {
    const deleteStmt = database.prepare(`DELETE FROM indexed_runs WHERE id = ?`);
    const deleteTx = database.transaction(() => {
      for (const id of autoRemoveIds) {
        deleteStmt.run(id);
      }
    });
    deleteTx();
    console.log(`[DB Cleanup] Auto-removed ${autoRemoveIds.length} ghost run(s) — destination folder and all files gone`);
  }

  if (promptUser.length > 0) {
    console.log(`[DB] ${promptUser.length} run(s) have missing destination but some files still exist — prompting user`);
  }

  return { autoRemoved: autoRemoveIds.length, promptUser };
}

/**
 * Relocate an indexed run to a new destination path.
 * Updates the run's destination_path and all associated indexed_files' file_path values.
 * Returns the number of file paths updated.
 */
/**
 * Update the stored date for a file (used by the manual date editor).
 * Sets derived_date + year/month/day + confidence + date_source atomically,
 * and optionally updates the file_path if the file was renamed on disk.
 */
export function updateFileDate(
  fileId: number,
  date: Date,
  confidence: 'confirmed' | 'recovered' | 'marked' | 'corrected',
  dateSource: string,
  newFilePath?: string
): void {
  const database = getDb();
  const iso = date.toISOString();
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (newFilePath) {
    const filename = newFilePath.split(/[\\/]/).pop() || '';
    database.prepare(`
      UPDATE indexed_files
         SET derived_date = ?, year = ?, month = ?, day = ?,
             confidence = ?, date_source = ?, file_path = ?, filename = ?
       WHERE id = ?
    `).run(iso, year, month, day, confidence, dateSource, newFilePath, filename, fileId);
  } else {
    database.prepare(`
      UPDATE indexed_files
         SET derived_date = ?, year = ?, month = ?, day = ?,
             confidence = ?, date_source = ?
       WHERE id = ?
    `).run(iso, year, month, day, confidence, dateSource, fileId);
  }
}

/**
 * Return files that sit immediately before and after the given file in
 * derived-date order, restricted to Confirmed/Recovered neighbours that share
 * the same parent folder. Used by the date-suggestion engine for interpolation.
 */
export function getDateNeighbours(fileId: number): {
  before?: { id: number; filename: string; derived_date: string; confidence: string };
  after?: { id: number; filename: string; derived_date: string; confidence: string };
} {
  const database = getDb();
  const self = database.prepare(`SELECT file_path, derived_date, run_id FROM indexed_files WHERE id = ?`).get(fileId) as { file_path: string; derived_date: string | null; run_id: number } | undefined;
  if (!self) return {};
  const folder = self.file_path.replace(/[\\/][^\\/]*$/, '');
  const before = database.prepare(`
    SELECT id, filename, derived_date, confidence FROM indexed_files
    WHERE id != ? AND confidence IN ('confirmed','recovered','corrected') AND derived_date IS NOT NULL
      AND substr(file_path, 1, ?) = ?
    ORDER BY derived_date DESC LIMIT 1
  `).get(fileId, folder.length, folder) as any;
  const after = database.prepare(`
    SELECT id, filename, derived_date, confidence FROM indexed_files
    WHERE id != ? AND confidence IN ('confirmed','recovered','corrected') AND derived_date IS NOT NULL
      AND substr(file_path, 1, ?) = ?
    ORDER BY derived_date ASC LIMIT 1
  `).get(fileId, folder.length, folder) as any;
  return { before: before || undefined, after: after || undefined };
}

/**
 * Return Confirmed/Recovered/Corrected files in the same folder whose filename
 * shares the given numeric prefix (e.g. MOV00920, MOV00927 for MOV00924).
 * Used for sequential-filename interpolation.
 */
export function getSequentialFilenameNeighbours(fileId: number): {
  before?: { id: number; filename: string; derived_date: string; seqNum: number };
  after?: { id: number; filename: string; derived_date: string; seqNum: number };
  selfSeqNum?: number;
} {
  const database = getDb();
  const self = database.prepare(`SELECT file_path, filename FROM indexed_files WHERE id = ?`).get(fileId) as { file_path: string; filename: string } | undefined;
  if (!self) return {};
  const match = self.filename.match(/^(.*?)(\d{3,})(\.[^.]+)?$/);
  if (!match) return {};
  const [, prefix, numStr] = match;
  const selfSeqNum = parseInt(numStr, 10);
  const folder = self.file_path.replace(/[\\/][^\\/]*$/, '');
  const rows = database.prepare(`
    SELECT id, filename, derived_date FROM indexed_files
    WHERE confidence IN ('confirmed','recovered','corrected') AND derived_date IS NOT NULL
      AND filename LIKE ?
      AND substr(file_path, 1, ?) = ?
  `).all(prefix + '%', folder.length, folder) as { id: number; filename: string; derived_date: string }[];
  let before: { id: number; filename: string; derived_date: string; seqNum: number } | undefined;
  let after: { id: number; filename: string; derived_date: string; seqNum: number } | undefined;
  for (const row of rows) {
    const m = row.filename.match(/^.*?(\d{3,})/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n < selfSeqNum && (!before || n > before.seqNum)) before = { ...row, seqNum: n };
    if (n > selfSeqNum && (!after || n < after.seqNum)) after = { ...row, seqNum: n };
  }
  return { before, after, selfSeqNum };
}

/**
 * Return the median Confirmed/Recovered date of files in the same folder.
 */
export function getFolderMedianDate(fileId: number): string | null {
  const database = getDb();
  const self = database.prepare(`SELECT file_path FROM indexed_files WHERE id = ?`).get(fileId) as { file_path: string } | undefined;
  if (!self) return null;
  const folder = self.file_path.replace(/[\\/][^\\/]*$/, '');
  const rows = database.prepare(`
    SELECT derived_date FROM indexed_files
    WHERE confidence IN ('confirmed','recovered','corrected') AND derived_date IS NOT NULL
      AND substr(file_path, 1, ?) = ?
    ORDER BY derived_date
  `).all(folder.length, folder) as { derived_date: string }[];
  if (rows.length === 0) return null;
  return rows[Math.floor(rows.length / 2)].derived_date;
}

/**
 * Return the median date of Confirmed/Recovered photos that contain one or
 * more of the given person IDs. Used for face-based date inference.
 */
export function getMedianDateForPersons(personIds: number[]): string | null {
  if (personIds.length === 0) return null;
  const database = getDb();
  const placeholders = personIds.map(() => '?').join(',');
  const rows = database.prepare(`
    SELECT DISTINCT f.id, f.derived_date FROM indexed_files f
    JOIN face_detections fd ON fd.file_id = f.id
    WHERE fd.person_id IN (${placeholders})
      AND f.confidence IN ('confirmed','recovered','corrected')
      AND f.derived_date IS NOT NULL
    ORDER BY f.derived_date
  `).all(...personIds) as { id: number; derived_date: string }[];
  if (rows.length === 0) return null;
  return rows[Math.floor(rows.length / 2)].derived_date;
}

/**
 * Return the median date of Confirmed/Recovered photos whose GPS coordinates
 * fall within ~approxKm of the given lat/lon.
 */
export function getMedianDateForGpsRadius(lat: number, lon: number, approxKm: number = 1): string | null {
  const database = getDb();
  // Rough degree offsets (good enough for a few km at any latitude).
  const dLat = approxKm / 111;
  const dLon = approxKm / (111 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  const rows = database.prepare(`
    SELECT derived_date FROM indexed_files
    WHERE confidence IN ('confirmed','recovered','corrected') AND derived_date IS NOT NULL
      AND gps_lat BETWEEN ? AND ? AND gps_lon BETWEEN ? AND ?
    ORDER BY derived_date
  `).all(lat - dLat, lat + dLat, lon - dLon, lon + dLon) as { derived_date: string }[];
  if (rows.length === 0) return null;
  return rows[Math.floor(rows.length / 2)].derived_date;
}

export function relocateRun(runId: number, newDestinationPath: string): number {
  const database = getDb();
  const run = database.prepare(`SELECT * FROM indexed_runs WHERE id = ?`).get(runId) as IndexedRun | undefined;
  if (!run) throw new Error(`Run #${runId} not found`);

  const oldPath = run.destination_path;
  // Normalise both paths for consistent replacement
  const oldNorm = oldPath.replace(/\\/g, '/');
  const newNorm = newDestinationPath.replace(/\\/g, '/');

  // Update the run's destination path
  database.prepare(`UPDATE indexed_runs SET destination_path = ? WHERE id = ?`).run(newDestinationPath, runId);

  // Update all file paths: replace the old destination prefix with the new one
  const files = database.prepare(`SELECT id, file_path FROM indexed_files WHERE run_id = ?`).all(runId) as { id: number; file_path: string }[];
  const updateStmt = database.prepare(`UPDATE indexed_files SET file_path = ? WHERE id = ?`);

  let updated = 0;
  const updateTx = database.transaction(() => {
    for (const file of files) {
      const fileNorm = file.file_path.replace(/\\/g, '/');
      if (fileNorm.startsWith(oldNorm)) {
        const newFilePath = newDestinationPath + file.file_path.substring(oldPath.length);
        updateStmt.run(newFilePath, file.id);
        updated++;
      }
    }
  });
  updateTx();

  console.log(`[DB] Relocated run #${runId}: ${oldPath} → ${newDestinationPath} (${updated} file paths updated)`);
  return updated;
}

/**
 * Read the user-applied rotation (in degrees, 0/90/180/270) for a
 * photo by file_path. Returns 0 when the file isn't in the index or
 * has never been rotated. Cheap — single indexed lookup against the
 * file_path UNIQUE INDEX.
 */
export function getUserRotation(filePath: string): number {
  const database = getDb();
  const row = database
    .prepare(`SELECT user_rotation FROM indexed_files WHERE file_path = ? LIMIT 1`)
    .get(filePath) as { user_rotation: number | null } | undefined;
  if (!row) return 0;
  return ((row.user_rotation ?? 0) % 360 + 360) % 360;
}

/**
 * Persist the user-applied rotation for a photo. The viewer calls this
 * after every rotate-button click so re-opening the same file in any
 * surface (Memories grid, S&D thumbnail, Viewer) shows the photo the
 * way the user last left it. Normalised to 0/90/180/270.
 */
export function setUserRotation(filePath: string, rotation: number): { changed: boolean } {
  const database = getDb();
  const normalised = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  const result = database
    .prepare(`UPDATE indexed_files SET user_rotation = ? WHERE file_path = ?`)
    .run(normalised, filePath);
  return { changed: result.changes > 0 };
}

/**
 * Full database cleanup — executed on every startup to keep the index healthy.
 *
 * Cleanup order (each step feeds the next):
 *   1. Purge duplicate runs (same destination_path → keep newest)
 *   2. Purge duplicate files (same file_path → keep newest)
 *   3. Purge stale files (file no longer exists on disk)
 *   4. Purge orphan runs (runs with zero remaining files)
 *   5. Purge ghost runs (destination folder gone AND all files gone → auto-delete)
 *      Runs where folder is gone but files exist → returned for StaleRunsModal
 *
 * Returns cleanup stats + any runs needing user attention.
 */
// ─── Memories queries ───────────────────────────────────────────────────────
// Aggregates that power the Memories view (year/month/day timeline + "On
// This Day"). Kept as raw SQL aggregates so we never load more rows than we
// need — a library of 100k photos summarises into ~30 years × 12 months ≈
// 360 rows for the main timeline, and <10 rows for On This Day.

export interface MemoriesYearBucket {
  year: number;
  month: number;
  photoCount: number;
  videoCount: number;
  // One representative file path + id so the grid can show a sample thumb.
  sampleFilePath: string | null;
  sampleFileId: number | null;
}

export interface MemoriesOnThisDayItem {
  id: number;
  file_path: string;
  filename: string;
  file_type: string;
  derived_date: string | null;
  year: number | null;
}

/**
 * Helper: build the SQL fragment + parameters for a run_id IN (...) clause
 * from an optional list. Empty / undefined → no filter, covers all runs.
 */
function runIdsClause(runIds: number[] | undefined, alias = ''): { sql: string; params: number[] } {
  if (!runIds || runIds.length === 0) return { sql: '', params: [] };
  const col = alias ? `${alias}.run_id` : 'run_id';
  return { sql: `AND ${col} IN (${runIds.map(() => '?').join(',')})`, params: runIds };
}

/**
 * Photos-per-month aggregate across every year in the library, optionally
 * scoped to a set of indexed_runs. Multiple run IDs are OR-combined so the
 * UI can group runs that share the same logical library (same source
 * labels, two destinations, etc.) into a single selection.
 */
export function getMemoriesYearMonthBuckets(runIds?: number[]): MemoriesYearBucket[] {
  const database = getDb();
  const outer = runIdsClause(runIds);
  const inner = runIdsClause(runIds, 'f2');
  const override = runIdsClause(runIds, 'f3');
  // COALESCE: if the user has chosen an override thumbnail for (year,
  // month) AND that file still exists in indexed_files AND still
  // matches the current run-id scope, use it. Otherwise fall through
  // to the default lowest-id pick. The override join also requires
  // year/month to match (defensive — handles the edge case where a
  // photo's date is later corrected, moving it to a different bucket).
  const rows = database.prepare(`
    SELECT
      year,
      month,
      SUM(CASE WHEN file_type = 'photo' THEN 1 ELSE 0 END) AS photoCount,
      SUM(CASE WHEN file_type = 'video' THEN 1 ELSE 0 END) AS videoCount,
      COALESCE(
        (SELECT f3.file_path FROM memories_month_thumbs o
           JOIN indexed_files f3 ON f3.id = o.file_id
           WHERE o.year = f.year AND o.month = f.month
             AND f3.year = f.year AND f3.month = f.month ${override.sql}),
        (SELECT f2.file_path FROM indexed_files f2
           WHERE f2.year = f.year AND f2.month = f.month ${inner.sql}
           ORDER BY f2.id ASC LIMIT 1)
      ) AS sampleFilePath,
      COALESCE(
        (SELECT f3.id FROM memories_month_thumbs o
           JOIN indexed_files f3 ON f3.id = o.file_id
           WHERE o.year = f.year AND o.month = f.month
             AND f3.year = f.year AND f3.month = f.month ${override.sql}),
        (SELECT f2.id FROM indexed_files f2
           WHERE f2.year = f.year AND f2.month = f.month ${inner.sql}
           ORDER BY f2.id ASC LIMIT 1)
      ) AS sampleFileId
    FROM indexed_files f
    WHERE year IS NOT NULL AND month IS NOT NULL
      AND (f.in_recycle_bin IS NULL OR f.in_recycle_bin = 0)
      ${outer.sql}
    GROUP BY year, month
    ORDER BY year DESC, month DESC
  `).all(
    ...override.params, ...inner.params,
    ...override.params, ...inner.params,
    ...outer.params,
  ) as MemoriesYearBucket[];
  return rows;
}

/**
 * Set a user-chosen monthly thumbnail. Overwrites any prior choice for
 * the same (year, month) pair. The file must already exist in
 * indexed_files; foreign-key constraint ensures we don't carry a
 * dangling override forward.
 */
export function setMonthlyThumbnailOverride(year: number, month: number, fileId: number): void {
  const database = getDb();
  database.prepare(`
    INSERT INTO memories_month_thumbs (year, month, file_id, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(year, month) DO UPDATE SET
      file_id = excluded.file_id,
      updated_at = excluded.updated_at
  `).run(year, month, fileId);
}

/**
 * Clear the user-chosen monthly thumbnail for (year, month). Subsequent
 * getMemoriesYearMonthBuckets calls revert to the default lowest-id pick.
 */
export function clearMonthlyThumbnailOverride(year: number, month: number): void {
  const database = getDb();
  database.prepare(`DELETE FROM memories_month_thumbs WHERE year = ? AND month = ?`).run(year, month);
}

/**
 * Files taken on the same month/day as today across every previous year.
 * Powers the "On This Day" row at the top of Memories.
 */
export function getMemoriesOnThisDay(month: number, day: number, runIds?: number[], limit: number = 50): MemoriesOnThisDayItem[] {
  const database = getDb();
  const clause = runIdsClause(runIds);
  const params: any[] = [month, day, ...clause.params, limit];
  return database.prepare(`
    SELECT id, file_path, filename, file_type, derived_date, year
    FROM indexed_files
    WHERE month = ? AND day = ? ${clause.sql}
      AND derived_date IS NOT NULL
      AND (in_recycle_bin IS NULL OR in_recycle_bin = 0)
    ORDER BY year DESC, derived_date DESC
    LIMIT ?
  `).all(...params) as MemoriesOnThisDayItem[];
}

/**
 * Fetch every file taken on a specific calendar date, optionally scoped to a
 * set of runs. Used for the day-drill-down grid.
 */
/**
 * Fetch indexed files inside a date range, drilled down by year, month
 * and/or day. Each level is independently optional so the same function
 * powers all three Memories drill-downs:
 *
 *   { year }                    → whole year
 *   { year, month }             → whole month (e.g. "February 2005")
 *   { year, month, day }        → single day (the original behaviour)
 *
 * Originally this function was day-only, which was why clicking a month
 * tile in Memories was opening just the 1st of the month. Making month
 * and day optional fixed that without needing a parallel code path.
 */
export function getMemoriesDayFiles(year: number, month?: number | null, day?: number | null, runIds?: number[]): IndexedFile[] {
  const database = getDb();
  const clause = runIdsClause(runIds);
  // v2.0.15 — hide files that are sitting in the PDR Recycle Bin.
  // They reappear if the user restores them from the Recycle Bin view.
  const conditions: string[] = ['year = ?', '(in_recycle_bin IS NULL OR in_recycle_bin = 0)'];
  const params: any[] = [year];
  if (month != null) { conditions.push('month = ?'); params.push(month); }
  if (day != null)   { conditions.push('day = ?');   params.push(day); }
  const whereSql = conditions.join(' AND ') + (clause.sql ? ' ' + clause.sql : '');
  params.push(...clause.params);
  // v2.0.14 (Terry 2026-05-28) — newest first, consistent with the
  // year timeline and with what every premium photo app does (Apple
  // Photos, Google Photos, Lightroom, Mylio): top = most recent at
  // every scale. Tie-break on id DESC so two photos taken in the same
  // second still show in a stable order with the newer-imported
  // record on top.
  return database.prepare(`
    SELECT * FROM indexed_files
    WHERE ${whereSql}
    ORDER BY derived_date DESC, id DESC
  `).all(...params) as IndexedFile[];
}

// v2.0.11 — async because purgeStaleIndexedFiles and purgeGhostRuns
// now yield between batches (see those functions for rationale). The
// SQL-only steps (purgeDuplicateRuns no-op, purgeDuplicateIndexedFiles,
// purgeOrphanRuns) stay synchronous — they're single SQL statements
// that better-sqlite3 finishes in ms, no yielding needed.
export async function runDatabaseCleanup(): Promise<{
  staleRuns: IndexedRun[];
  duplicateRunsRemoved: number;
  duplicatesRemoved: number;
  staleRemoved: number;
  totalChecked: number;
  orphanRunsRemoved: number;
  ghostRunsRemoved: number;
}> {
  // Step 1: Remove duplicate runs for the same destination_path (keeps newest)
  const dupeRuns = purgeDuplicateRuns();

  // Step 2: Remove duplicate file entries (same file_path across runs, keeps newest)
  const dupes = purgeDuplicateIndexedFiles();

  // Step 3: Remove file entries where the actual file no longer exists on disk
  //   (async + chunked to keep the main thread responsive)
  const stale = await purgeStaleIndexedFiles();

  // Step 4: Remove runs that now have zero files (orphaned by steps 2-3)
  const orphans = purgeOrphanRuns();

  // Step 5: Direct ghost-run cleanup — destination folder doesn't exist
  //   Auto-removes runs where folder AND all files are gone (nothing to preserve)
  //   Returns runs for StaleRunsModal where folder is gone but files may be relocatable
  //   (async + yielding to keep the main thread responsive)
  const ghosts = await purgeGhostRuns();

  return {
    staleRuns: ghosts.promptUser,
    duplicateRunsRemoved: dupeRuns,
    duplicatesRemoved: dupes,
    staleRemoved: stale.removed,
    totalChecked: stale.checked,
    orphanRunsRemoved: orphans,
    ghostRunsRemoved: ghosts.autoRemoved,
  };
}

// ═══════════════════════════════════════════════════════════════
// Trees v1 — family relationship CRUD
// ═══════════════════════════════════════════════════════════════

export type RelationshipType = 'parent_of' | 'spouse_of' | 'sibling_of' | 'associated_with';

/** Kinds of non-family associations carried in flags.kind for associated_with rows. */
export type AssociationKind =
  | 'friend' | 'close_friend' | 'best_friend' | 'acquaintance' | 'neighbour'
  | 'colleague' | 'classmate' | 'teammate' | 'roommate'
  | 'mentor' | 'mentee' | 'manager' | 'client'
  | 'ex_partner'
  | 'other';

export interface RelationshipFlags {
  biological?: boolean;
  step?: boolean;
  adopted?: boolean;
  in_law?: boolean;
  /** sibling_of: true when the two people share only one parent (half-sibling). */
  half?: boolean;
  /** associated_with: what kind of non-family tie this is. */
  kind?: AssociationKind;
  /** associated_with + kind='other': free-form label the user typed. */
  label?: string;
  /** Marks historical ties: ex-colleague, ex-neighbour, etc. */
  ended?: boolean;
}

export interface RelationshipRecord {
  id: number;
  person_a_id: number;
  person_b_id: number;
  type: RelationshipType;
  since: string | null;
  until: string | null;
  flags: RelationshipFlags | null;
  confidence: number;
  source: 'user' | 'suggested';
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface RelationshipRow {
  id: number;
  person_a_id: number;
  person_b_id: number;
  type: RelationshipType;
  since: string | null;
  until: string | null;
  flags: string | null;
  confidence: number;
  source: 'user' | 'suggested';
  note: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRelationship(row: RelationshipRow): RelationshipRecord {
  let flags: RelationshipFlags | null = null;
  if (row.flags) {
    try { flags = JSON.parse(row.flags) as RelationshipFlags; } catch { flags = null; }
  }
  return {
    id: row.id,
    person_a_id: row.person_a_id,
    person_b_id: row.person_b_id,
    type: row.type,
    since: row.since,
    until: row.until,
    flags,
    confidence: row.confidence,
    source: row.source,
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Add a new family relationship between two people. Enforces that a
 *  parent_of edge always has A as the parent, B as the child. */
export function addRelationship(params: {
  personAId: number;
  personBId: number;
  type: RelationshipType;
  since?: string | null;
  until?: string | null;
  flags?: RelationshipFlags | null;
  confidence?: number;
  source?: 'user' | 'suggested';
  note?: string | null;
}): RelationshipRecord | { error: string } {
  if (params.personAId === params.personBId) {
    return { error: 'A person cannot have a relationship with themself.' };
  }
  const db = getDb();
  // Existence check — foreign keys may be enforced, but give a cleaner error.
  const aExists = db.prepare(`SELECT id FROM persons WHERE id = ?`).get(params.personAId);
  const bExists = db.prepare(`SELECT id FROM persons WHERE id = ?`).get(params.personBId);
  if (!aExists || !bExists) {
    return { error: 'One or both persons do not exist.' };
  }
  try {
    const info = db.prepare(`
      INSERT INTO relationships
        (person_a_id, person_b_id, type, since, until, flags, confidence, source, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.personAId,
      params.personBId,
      params.type,
      params.since ?? null,
      params.until ?? null,
      params.flags ? JSON.stringify(params.flags) : null,
      params.confidence ?? 1.0,
      params.source ?? 'user',
      params.note ?? null,
    );
    const row = db.prepare(`SELECT * FROM relationships WHERE id = ?`).get(info.lastInsertRowid) as RelationshipRow;
    // Log history. Inverse of add is remove (by composite key so the
    // log survives subsequent id churn from other add/remove cycles).
    const personName = (pid: number) => {
      const r = db.prepare(`SELECT name FROM persons WHERE id = ?`).get(pid) as { name?: string } | undefined;
      return r?.name || `#${pid}`;
    };
    logGraphHistory(
      'add_relationship',
      { kind: 'add', personAId: params.personAId, personBId: params.personBId, type: params.type, since: params.since, until: params.until, flags: params.flags, confidence: params.confidence, source: params.source, note: params.note },
      { kind: 'remove', personAId: params.personAId, personBId: params.personBId, type: params.type },
      `Added ${params.type.replace('_of', '')} link ${personName(params.personAId)} ↔ ${personName(params.personBId)}`,
    );
    return rowToRelationship(row);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('UNIQUE')) {
      return { error: 'That relationship already exists.' };
    }
    return { error: msg };
  }
}

/** Update any mutable field of a relationship. Missing fields are left alone. */
export function updateRelationship(id: number, patch: Partial<Omit<RelationshipRecord, 'id' | 'created_at' | 'updated_at' | 'person_a_id' | 'person_b_id' | 'type'>>): RelationshipRecord | { error: string } {
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM relationships WHERE id = ?`).get(id) as RelationshipRow | undefined;
  if (!existing) return { error: 'Relationship not found.' };
  const sets: string[] = [];
  const vals: any[] = [];
  if (patch.since !== undefined) { sets.push('since = ?'); vals.push(patch.since); }
  if (patch.until !== undefined) { sets.push('until = ?'); vals.push(patch.until); }
  if (patch.flags !== undefined) { sets.push('flags = ?'); vals.push(patch.flags ? JSON.stringify(patch.flags) : null); }
  if (patch.confidence !== undefined) { sets.push('confidence = ?'); vals.push(patch.confidence); }
  if (patch.source !== undefined) { sets.push('source = ?'); vals.push(patch.source); }
  if (patch.note !== undefined) { sets.push('note = ?'); vals.push(patch.note); }
  if (sets.length === 0) return rowToRelationship(existing);
  sets.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE relationships SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  const row = db.prepare(`SELECT * FROM relationships WHERE id = ?`).get(id) as RelationshipRow;
  // Log. Forward patch is what was just applied; inverse patch rewinds
  // to the previous values of the same fields.
  const previousPatch: any = {};
  const forwardPatch: any = {};
  if (patch.since !== undefined)      { previousPatch.since      = existing.since;      forwardPatch.since      = patch.since; }
  if (patch.until !== undefined)      { previousPatch.until      = existing.until;      forwardPatch.until      = patch.until; }
  if (patch.flags !== undefined)      { previousPatch.flags      = existing.flags ? JSON.parse(existing.flags) : null; forwardPatch.flags = patch.flags; }
  if (patch.confidence !== undefined) { previousPatch.confidence = existing.confidence; forwardPatch.confidence = patch.confidence; }
  if (patch.source !== undefined)     { previousPatch.source     = existing.source;     forwardPatch.source     = patch.source; }
  if (patch.note !== undefined)       { previousPatch.note       = existing.note;       forwardPatch.note       = patch.note; }
  logGraphHistory(
    'update_relationship',
    { kind: 'update', personAId: existing.person_a_id, personBId: existing.person_b_id, type: existing.type, patch: forwardPatch },
    { kind: 'update', personAId: existing.person_a_id, personBId: existing.person_b_id, type: existing.type, patch: previousPatch },
    `Updated ${existing.type.replace('_of', '')} link`,
  );
  return rowToRelationship(row);
}

/** Delete a relationship by ID. */
export function removeRelationship(id: number): { success: boolean; error?: string } {
  const db = getDb();
  // Snapshot the row BEFORE deletion so we can log an inverse that
  // recreates it exactly (type, since/until, flags, etc.).
  const existing = db.prepare(`SELECT * FROM relationships WHERE id = ?`).get(id) as RelationshipRow | undefined;
  const info = db.prepare(`DELETE FROM relationships WHERE id = ?`).run(id);
  if (info.changes > 0 && existing) {
    const personName = (otherId: number) => {
      const row = db.prepare(`SELECT name FROM persons WHERE id = ?`).get(otherId) as { name?: string } | undefined;
      return row?.name || `#${otherId}`;
    };
    logGraphHistory(
      'remove_relationship',
      { kind: 'remove', id: existing.id },
      {
        kind: 'add',
        personAId: existing.person_a_id,
        personBId: existing.person_b_id,
        type: existing.type,
        since: existing.since,
        until: existing.until,
        flags: existing.flags ? JSON.parse(existing.flags) : null,
        confidence: existing.confidence,
        source: existing.source,
        note: existing.note,
      },
      `Removed ${existing.type.replace('_of', '')} link ${personName(existing.person_a_id)} ↔ ${personName(existing.person_b_id)}`,
    );
  }
  return info.changes > 0 ? { success: true } : { success: false, error: 'Relationship not found.' };
}

// ═══════════════════════════════════════════════════════════════
// Graph history — persistent undo / redo
// ═══════════════════════════════════════════════════════════════

/** A reversible graph operation. `add` creates a relationship with the
 *  stored payload; `remove` deletes a relationship found by its
 *  composite key (personA, personB, type) — never by raw id, because
 *  ids change across add/remove cycles; `update` re-applies or rolls
 *  back a patch on a relationship found by composite key. */
type HistoryOp =
  | { kind: 'add';    personAId: number; personBId: number; type: RelationshipType; since?: string | null; until?: string | null; flags?: RelationshipFlags | null; confidence?: number | null; source?: string | null; note?: string | null }
  | { kind: 'remove'; id?: number; personAId?: number; personBId?: number; type?: RelationshipType }
  | { kind: 'update'; personAId: number; personBId: number; type: RelationshipType; patch: Partial<RelationshipRecord> }
  /** Add a person to a tree's hidden_ancestor_person_ids list.
   *  Inverse is tree_show_ancestor. Applied idempotently — re-running
   *  a hide on someone already hidden is a no-op, so redo after a
   *  manual restore doesn't double-insert. */
  | { kind: 'tree_hide_ancestor'; treeId: number; personId: number }
  /** Remove a person from a tree's hidden_ancestor_person_ids list. */
  | { kind: 'tree_show_ancestor'; treeId: number; personId: number }
  /** Assign (or clear, via null) a person's gender. Inverse flips the
   *  value back to what it was before. */
  | { kind: 'person_gender_set'; personId: number; gender: string | null };

function logGraphHistory(kind: string, forward: HistoryOp, inverse: HistoryOp, description: string) {
  const db = getDb();
  // Any NEW operation truncates the redo stack (user took a new branch).
  db.prepare(`DELETE FROM graph_history WHERE undone = 1`).run();
  db.prepare(`
    INSERT INTO graph_history (kind, forward, inverse, description, undone)
    VALUES (?, ?, ?, ?, 0)
  `).run(kind, JSON.stringify(forward), JSON.stringify(inverse), description);
}

/** Apply an op directly (bypassing history logging so undo/redo don't
 *  clutter the log with their own operations). */
function applyGraphOp(op: HistoryOp): { success: boolean; error?: string } {
  const db = getDb();
  if (op.kind === 'add') {
    try {
      db.prepare(`
        INSERT INTO relationships (person_a_id, person_b_id, type, since, until, flags, confidence, source, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        op.personAId,
        op.personBId,
        op.type,
        op.since ?? null,
        op.until ?? null,
        op.flags ? JSON.stringify(op.flags) : null,
        op.confidence ?? 1.0,
        op.source ?? 'user',
        op.note ?? null,
      );
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
  if (op.kind === 'remove') {
    // Prefer composite key for resilience across id churn.
    if (op.personAId != null && op.personBId != null && op.type) {
      const info = db.prepare(`DELETE FROM relationships WHERE person_a_id = ? AND person_b_id = ? AND type = ?`)
        .run(op.personAId, op.personBId, op.type);
      return { success: info.changes > 0 };
    }
    if (op.id != null) {
      const info = db.prepare(`DELETE FROM relationships WHERE id = ?`).run(op.id);
      return { success: info.changes > 0 };
    }
    return { success: false, error: 'remove op missing id/composite key' };
  }
  if (op.kind === 'update') {
    const sets: string[] = [];
    const vals: any[] = [];
    const p = op.patch;
    if (p.since !== undefined)      { sets.push('since = ?');      vals.push(p.since); }
    if (p.until !== undefined)      { sets.push('until = ?');      vals.push(p.until); }
    if (p.flags !== undefined)      { sets.push('flags = ?');      vals.push(p.flags ? JSON.stringify(p.flags) : null); }
    if (p.confidence !== undefined) { sets.push('confidence = ?'); vals.push(p.confidence); }
    if (p.source !== undefined)     { sets.push('source = ?');     vals.push(p.source); }
    if (p.note !== undefined)       { sets.push('note = ?');       vals.push(p.note); }
    if (sets.length === 0) return { success: true };
    sets.push(`updated_at = datetime('now')`);
    const info = db.prepare(`
      UPDATE relationships SET ${sets.join(', ')}
      WHERE person_a_id = ? AND person_b_id = ? AND type = ?
    `).run(...vals, op.personAId, op.personBId, op.type);
    return { success: info.changes > 0 };
  }
  if (op.kind === 'person_gender_set') {
    const exists = db.prepare(`SELECT id FROM persons WHERE id = ?`).get(op.personId);
    if (!exists) return { success: false, error: 'Person not found.' };
    db.prepare(`UPDATE persons SET gender = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(op.gender, op.personId);
    return { success: true };
  }
  if (op.kind === 'tree_hide_ancestor' || op.kind === 'tree_show_ancestor') {
    // Read-modify-write the JSON array on saved_trees. Idempotent:
    // hiding someone already hidden (or showing someone already shown)
    // succeeds silently, which keeps redo safe after manual restores.
    const row = db.prepare(`SELECT hidden_ancestor_person_ids FROM saved_trees WHERE id = ?`).get(op.treeId) as { hidden_ancestor_person_ids: string | null } | undefined;
    if (!row) return { success: false, error: 'Tree not found.' };
    let list: number[] = [];
    try {
      const parsed = row.hidden_ancestor_person_ids ? JSON.parse(row.hidden_ancestor_person_ids) : [];
      if (Array.isArray(parsed)) list = parsed.filter(n => typeof n === 'number');
    } catch {}
    if (op.kind === 'tree_hide_ancestor') {
      if (!list.includes(op.personId)) list.push(op.personId);
    } else {
      list = list.filter(n => n !== op.personId);
    }
    db.prepare(`UPDATE saved_trees SET hidden_ancestor_person_ids = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(list), op.treeId);
    return { success: true };
  }
  return { success: false, error: 'unknown op kind' };
}

/** Pop the most recent non-undone entry, apply its inverse, mark undone. */
export function undoLastGraphOperation(): { success: boolean; description?: string; error?: string } {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM graph_history
    WHERE undone = 0
    ORDER BY id DESC
    LIMIT 1
  `).get() as { id: number; kind: string; forward: string; inverse: string; description: string } | undefined;
  if (!row) return { success: false, error: 'Nothing to undo.' };
  const inverse = JSON.parse(row.inverse) as HistoryOp;
  const r = applyGraphOp(inverse);
  if (!r.success) return { success: false, error: r.error ?? 'Undo failed.' };
  db.prepare(`UPDATE graph_history SET undone = 1 WHERE id = ?`).run(row.id);
  return { success: true, description: row.description };
}

/** Re-apply the most recently undone entry's forward. */
export function redoGraphOperation(): { success: boolean; description?: string; error?: string } {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM graph_history
    WHERE undone = 1
    ORDER BY id DESC
    LIMIT 1
  `).get() as { id: number; kind: string; forward: string; inverse: string; description: string } | undefined;
  if (!row) return { success: false, error: 'Nothing to redo.' };
  const forward = JSON.parse(row.forward) as HistoryOp;
  const r = applyGraphOp(forward);
  if (!r.success) return { success: false, error: r.error ?? 'Redo failed.' };
  db.prepare(`UPDATE graph_history SET undone = 0 WHERE id = ?`).run(row.id);
  return { success: true, description: row.description };
}

/** Counts for enabling/disabling the UI buttons. */
export function getGraphHistoryCounts(): { canUndo: number; canRedo: number } {
  const db = getDb();
  const u = (db.prepare(`SELECT COUNT(*) AS cnt FROM graph_history WHERE undone = 0`).get() as { cnt: number }).cnt;
  const r = (db.prepare(`SELECT COUNT(*) AS cnt FROM graph_history WHERE undone = 1`).get() as { cnt: number }).cnt;
  return { canUndo: u, canRedo: r };
}

export interface GraphHistoryEntry {
  id: number;
  description: string;
  createdAt: string;
  undone: boolean;
}

/** Every entry in the graph history table, most recent first. Used by
 *  the History panel in Manage Trees so the user can revert to any
 *  past point, not just step back one Ctrl+Z at a time. */
export function listGraphHistoryEntries(limit: number = 500): GraphHistoryEntry[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, description, created_at, undone
    FROM graph_history
    ORDER BY id DESC
    LIMIT ?
  `).all(limit) as { id: number; description: string; created_at: string; undone: number }[];
  return rows.map(r => ({
    id: r.id,
    description: r.description,
    createdAt: r.created_at,
    undone: r.undone === 1,
  }));
}

/** Roll back to the state immediately after entry `targetId` happened:
 *  undo every non-undone entry with id > targetId. Returns the count
 *  of ops actually rewound. Does NOT undo entry targetId itself — if
 *  the user wanted the state BEFORE that entry they should pick the
 *  entry just prior. */
export function revertToGraphHistoryEntry(targetId: number): { success: boolean; undoneCount: number; error?: string } {
  const db = getDb();
  const target = db.prepare(`SELECT id FROM graph_history WHERE id = ?`).get(targetId);
  if (!target) return { success: false, undoneCount: 0, error: 'History entry not found.' };
  let total = 0;
  // Undo-latest-first is exactly what undoLastGraphOperation does, so
  // we repeat-call until no non-undone entry with id > targetId remains.
  for (;;) {
    const pending = db.prepare(`
      SELECT COUNT(*) AS cnt FROM graph_history WHERE id > ? AND undone = 0
    `).get(targetId) as { cnt: number };
    if (pending.cnt === 0) break;
    const r = undoLastGraphOperation();
    if (!r.success) return { success: false, undoneCount: total, error: r.error ?? 'Undo failed mid-revert.' };
    total++;
    if (total > 10000) break; // hard safety
  }
  return { success: true, undoneCount: total };
}

/** All relationships touching a person (as either endpoint). */
export function listRelationshipsForPerson(personId: number): RelationshipRecord[] {
  const db = getDb();
  // Exclude relationships where either endpoint has been soft-deleted.
  // Without this, a discarded person's edges would still surface in the
  // edit-relationships list, in sibling auto-inheritance, etc. —
  // ghost edges pointing at someone the user thinks they've deleted.
  const rows = db.prepare(`
    SELECT r.* FROM relationships r
    JOIN persons a ON a.id = r.person_a_id
    JOIN persons b ON b.id = r.person_b_id
    WHERE (r.person_a_id = ? OR r.person_b_id = ?)
      AND a.discarded_at IS NULL
      AND b.discarded_at IS NULL
    ORDER BY r.type, r.since
  `).all(personId, personId) as RelationshipRow[];
  return rows.map(rowToRelationship);
}

/** Every relationship in the database. Used for full-tree rendering. */
export function listAllRelationships(): RelationshipRecord[] {
  const db = getDb();
  // Same soft-delete filter — the full-tree render must not show edges
  // leading to discarded persons, otherwise the tree would paint ghost
  // cards for deleted people.
  const rows = db.prepare(`
    SELECT r.* FROM relationships r
    JOIN persons a ON a.id = r.person_a_id
    JOIN persons b ON b.id = r.person_b_id
    WHERE a.discarded_at IS NULL
      AND b.discarded_at IS NULL
    ORDER BY r.id
  `).all() as RelationshipRow[];
  return rows.map(rowToRelationship);
}

/** Update a person's life-event fields: birth_date, death_date, deceased_marker. */
export function updatePersonLifeEvents(personId: number, patch: { birthDate?: string | null; deathDate?: string | null; deceasedMarker?: string | null }): { success: boolean; error?: string } {
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM persons WHERE id = ?`).get(personId);
  if (!existing) return { success: false, error: 'Person not found.' };
  const sets: string[] = [];
  const vals: any[] = [];
  if (patch.birthDate !== undefined) { sets.push('birth_date = ?'); vals.push(patch.birthDate); }
  if (patch.deathDate !== undefined) { sets.push('death_date = ?'); vals.push(patch.deathDate); }
  if (patch.deceasedMarker !== undefined) { sets.push('deceased_marker = ?'); vals.push(patch.deceasedMarker); }
  if (sets.length === 0) return { success: true };
  sets.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE persons SET ${sets.join(', ')} WHERE id = ?`).run(...vals, personId);
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════
// Trees v1 — family graph traversal
// ═══════════════════════════════════════════════════════════════

export interface FamilyGraphNode {
  personId: number;
  /** Short name (`persons.name`). Always set. */
  name: string;
  /** Optional long-form name (`persons.full_name`). Trees uses this
   *  on the card label when present; falls back to `name` otherwise. */
  fullName: string | null;
  avatarData: string | null;
  representativeFaceId: number | null;
  /** File path + face-box coords so the renderer can call getFaceCrop()
   *  to produce an avatar thumbnail. Null if no representative face set
   *  or the referenced face has been deleted. */
  representativeFaceFilePath: string | null;
  representativeFaceBox: { x: number; y: number; w: number; h: number } | null;
  birthDate: string | null;
  deathDate: string | null;
  deceasedMarker: string | null;
  /** Optional per-card background image (data URL). Rendered faded. */
  cardBackground: string | null;
  /** One of: 'male' | 'female' | 'non_binary' | 'prefer_not_to_say'
   *  | 'unknown' | null. null = not yet set. Drives gendered labels +
   *  the top-right symbol on the card. */
  gender: string | null;
  hopsFromFocus: number;
  photoCount: number;
  /** Total parent_of edges in the FULL DB where this person is the
   *  child — NOT limited to parents inside the fetched hop window.
   *  Lets the client suppress ghost placeholders when real parents
   *  exist but sit beyond Steps, and gate the +parent chip. */
  totalParentCount: number;
  /** Total parent_of edges in the FULL DB where this person is the
   *  PARENT — used by the renderer to paint a v chevron below
   *  anyone whose descendants extend past the current Generations
   *  setting. */
  totalChildCount: number;
  /** True for placeholder nodes bridging skip-generation relationships
   *  (grandparent, aunt/uncle, cousin) where the intermediate person
   *  isn't yet named. The renderer styles these as ghost circles. */
  isPlaceholder: boolean;
}

export interface FamilyGraphEdge {
  /** Relationship table ID, or null when the edge is derived (siblings). */
  id: number | null;
  aId: number;
  bId: number;
  type: 'parent_of' | 'spouse_of' | 'sibling_of' | 'associated_with';
  since: string | null;
  until: string | null;
  flags: RelationshipFlags | null;
  /** True for sibling_of edges inferred from shared parents. */
  derived: boolean;
}

export interface FamilyGraph {
  focusPersonId: number;
  nodes: FamilyGraphNode[];
  edges: FamilyGraphEdge[];
}

interface PersonRow {
  id: number;
  name: string;
  avatar_data: string | null;
  representative_face_id: number | null;
  birth_date: string | null;
  death_date: string | null;
  deceased_marker: string | null;
  card_background: string | null;
  gender: string | null;
  is_placeholder: number;
}

/** BFS from a focus person through parent_of and spouse_of edges, returning
 *  every person reachable within `maxHops` and all edges between them,
 *  plus derived sibling_of edges for any pair sharing a parent.
 *
 *  maxHops defaults to 3 (grandparents, aunts/uncles, nieces/nephews). */
export function getFamilyGraph(focusPersonId: number, maxHops: number = 3): FamilyGraph {
  const db = getDb();

  // Pre-verify focus exists — return empty graph otherwise so callers
  // don't need to special-case an "unknown person" error.
  const focusRow = db.prepare(`SELECT id FROM persons WHERE id = ? AND discarded_at IS NULL`).get(focusPersonId);
  if (!focusRow) {
    return { focusPersonId, nodes: [], edges: [] };
  }

  // BFS. Visited map stores hop distance so the renderer can tier nodes.
  const visited = new Map<number, number>();
  visited.set(focusPersonId, 0);
  const queue: number[] = [focusPersonId];
  const collectedEdges: RelationshipRecord[] = [];
  const seenEdgeIds = new Set<number>();

  // All relationship queries below filter BOTH endpoints against
  // discarded_at. Without this, a soft-deleted person's edges still
  // show up in the fetched graph — they'd render as ghost cards on
  // the canvas (or worse, as real cards with stale names/photos from
  // before the delete). Matching filter pattern used by
  // listRelationshipsForPerson / listAllRelationships.
  const neighbourStmt = db.prepare(`
    SELECT r.* FROM relationships r
    JOIN persons a ON a.id = r.person_a_id
    JOIN persons b ON b.id = r.person_b_id
    WHERE (r.person_a_id = ? OR r.person_b_id = ?)
      AND a.discarded_at IS NULL
      AND b.discarded_at IS NULL
  `);
  /** Other children of a given parent — used to treat derived siblings
   *  as 1-hop neighbours. Without this step, "my brother" reads as
   *  hop 2 via the shared parent intermediate, which contradicts the
   *  user's intuition (a sibling is 1 step away). We include the path
   *  through parents for stored info but ALSO jump across siblings in
   *  the distance metric. */
  const otherChildrenStmt = db.prepare(`
    SELECT r.person_b_id FROM relationships r
    JOIN persons b ON b.id = r.person_b_id
    WHERE r.type = 'parent_of' AND r.person_a_id = ? AND r.person_b_id <> ?
      AND b.discarded_at IS NULL
  `);
  /** Other parents of a given child — used to treat co-parents as
   *  1-hop neighbours of each other (same trick as the sibling
   *  collapse above, but for partners-via-shared-children rather
   *  than siblings-via-shared-parents). Reasoning: someone who
   *  shares a child with `current` is functionally `current`'s
   *  partner regardless of whether a spouse_of edge exists in the
   *  DB. Without this step, an unmarried co-parent (or an ex whose
   *  spouse_of was never recorded) reads as hop+2 via the child,
   *  which falsely puts them BEYOND the Steps cap when the child
   *  is right at the cap. Terry's case: Ian is a hop-3 cousin and
   *  Sam is the mother of two of his daughters but has no spouse_of
   *  edge to him; without this collapse Sam lands at hop 5, which
   *  exceeds Steps=4 and she vanishes from the tree even though
   *  she's clearly Ian's partner-of-record. */
  const otherParentsStmt = db.prepare(`
    SELECT r.person_a_id FROM relationships r
    JOIN persons a ON a.id = r.person_a_id
    WHERE r.type = 'parent_of' AND r.person_b_id = ? AND r.person_a_id <> ?
      AND a.discarded_at IS NULL
  `);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentHops = visited.get(current)!;
    if (currentHops >= maxHops) continue;
    const rows = neighbourStmt.all(current, current) as RelationshipRow[];
    for (const row of rows) {
      const other = row.person_a_id === current ? row.person_b_id : row.person_a_id;
      if (!seenEdgeIds.has(row.id)) {
        seenEdgeIds.add(row.id);
        collectedEdges.push(rowToRelationship(row));
      }
      if (!visited.has(other)) {
        visited.set(other, currentHops + 1);
        queue.push(other);
      }
    }
    // Derived-sibling 1-hop expansion: for every parent_of row that
    // makes `current` a child, jump straight to that parent's OTHER
    // children and mark them as hop+1 (not hop+2 via the parent). Only
    // affects distance — the edges themselves aren't added here; the
    // derived sibling_of edges are synthesised later in this function.
    for (const row of rows) {
      if (row.type !== 'parent_of') continue;
      if (row.person_b_id !== current) continue; // only parent_of rows where current is child
      const siblings = otherChildrenStmt.all(row.person_a_id, current) as { person_b_id: number }[];
      for (const s of siblings) {
        if (visited.has(s.person_b_id)) continue;
        visited.set(s.person_b_id, currentHops + 1);
        queue.push(s.person_b_id);
      }
    }
    // Co-parent 1-hop collapse — symmetric to the sibling collapse
    // above, but in the partner direction. For every parent_of row
    // that makes `current` a parent (current is person_a), jump
    // sideways to any OTHER parent of the same child and mark them
    // hop+1. This treats co-parents as partner-equivalent in distance
    // even when no spouse_of edge has been recorded between them —
    // which matches user intuition (someone you share a child with is
    // your partner, recorded marriage or not).
    for (const row of rows) {
      if (row.type !== 'parent_of') continue;
      if (row.person_a_id !== current) continue; // only parent_of rows where current is parent
      const coparents = otherParentsStmt.all(row.person_b_id, current) as { person_a_id: number }[];
      for (const p of coparents) {
        if (visited.has(p.person_a_id)) continue;
        visited.set(p.person_a_id, currentHops + 1);
        queue.push(p.person_a_id);
      }
    }
  }

  // Boundary-edge sweep. The BFS above stops extending from nodes at
  // the max-hop boundary, so edges between two boundary nodes were
  // never walked. Example: with maxHops=3, if A and B are both at hop
  // 3, the edge (A parent_of B) is silently dropped — which made the
  // augmenter then mistake a real parent for a missing slot and
  // paint a ghost. Here we re-sweep the relationships table for any
  // row whose BOTH endpoints already sit in `visited`, and add any
  // we haven't seen yet.
  if (visited.size > 0) {
    const visitedIds = Array.from(visited.keys());
    const qs = visitedIds.map(() => '?').join(',');
    const boundary = db.prepare(`
      SELECT r.* FROM relationships r
      JOIN persons a ON a.id = r.person_a_id
      JOIN persons b ON b.id = r.person_b_id
      WHERE r.person_a_id IN (${qs}) AND r.person_b_id IN (${qs})
        AND a.discarded_at IS NULL
        AND b.discarded_at IS NULL
    `).all(...visitedIds, ...visitedIds) as RelationshipRow[];
    for (const row of boundary) {
      if (seenEdgeIds.has(row.id)) continue;
      seenEdgeIds.add(row.id);
      collectedEdges.push(rowToRelationship(row));
    }
  }

  // Deliberately NO family-overflow past maxHops. An earlier revision
  // auto-added direct family (parents / partners / siblings) of
  // boundary people at hop+1 for convenience, but that produced nodes
  // whose per-card step badge exceeded the Steps setting — a direct
  // visual contradiction. "Steps: N" now means exactly that: nothing
  // past hop N. Users who want to see a partner's family bump Steps
  // by one.

  // Pull person details for every reachable node, plus photo counts.
  const ids = Array.from(visited.keys());
  const placeholders = ids.map(() => '?').join(',');
  const personRows = db.prepare(`
    SELECT id, name, full_name, avatar_data, representative_face_id,
           birth_date, death_date, deceased_marker, card_background,
           gender,
           COALESCE(is_placeholder, 0) AS is_placeholder
    FROM persons
    WHERE id IN (${placeholders}) AND discarded_at IS NULL
  `).all(...ids) as PersonRow[];

  const photoCountRows = db.prepare(`
    SELECT person_id, COUNT(DISTINCT file_id) AS photo_count
    FROM face_detections
    WHERE person_id IN (${placeholders})
    GROUP BY person_id
  `).all(...ids) as { person_id: number; photo_count: number }[];
  const photoCountByPerson = new Map<number, number>();
  for (const r of photoCountRows) photoCountByPerson.set(r.person_id, r.photo_count);

  // TRUE total parent_of count per person — queried against the whole
  // relationships table, NOT just the edges that fell inside the
  // fetched hop window. Clients use this to suppress ghost slots
  // above people whose real parents live beyond Steps, and to hide
  // the +parent chip on anyone who already has two parents in the
  // DB (even if only one is currently visible).
  // Placeholder parents are excluded from this count — those rows are
  // auto-created when the user marks two people as siblings (so the
  // sibling link can derive from a shared-parent relationship), not
  // because the user actually entered a parent. Counting them here
  // would falsely fire the "expand ancestry" chevron above someone
  // whose only "missing" parents are these placeholders, which is
  // exactly the visual debris Terry asked us to remove.
  const totalParentCountRows = db.prepare(`
    SELECT r.person_b_id AS child_id, COUNT(*) AS cnt
    FROM relationships r
    JOIN persons a ON a.id = r.person_a_id
    WHERE r.type = 'parent_of' AND r.person_b_id IN (${placeholders})
      AND a.discarded_at IS NULL
      AND COALESCE(a.is_placeholder, 0) = 0
    GROUP BY r.person_b_id
  `).all(...ids) as { child_id: number; cnt: number }[];
  const totalParentCountByPerson = new Map<number, number>();
  for (const r of totalParentCountRows) totalParentCountByPerson.set(r.child_id, r.cnt);

  // True total CHILD count per person — same idea as the parent
  // count above but inverted. Trees uses this to know whether a
  // person has descendants beyond what the current Generations
  // setting reveals, so the renderer can paint a v chevron beneath
  // them inviting the user to expand downward. Placeholder children
  // are excluded for the same reason as the parent count above.
  const totalChildCountRows = db.prepare(`
    SELECT r.person_a_id AS parent_id, COUNT(*) AS cnt
    FROM relationships r
    JOIN persons b ON b.id = r.person_b_id
    WHERE r.type = 'parent_of' AND r.person_a_id IN (${placeholders})
      AND b.discarded_at IS NULL
      AND COALESCE(b.is_placeholder, 0) = 0
    GROUP BY r.person_a_id
  `).all(...ids) as { parent_id: number; cnt: number }[];
  const totalChildCountByPerson = new Map<number, number>();
  for (const r of totalChildCountRows) totalChildCountByPerson.set(r.parent_id, r.cnt);

  // Face thumbnail coords per person — prefer the user-chosen representative
  // face; fall back to any face for that person so a new cluster still
  // gets an avatar until the user picks one in People Manager.
  const faceCoordRows = db.prepare(`
    SELECT fd.id AS face_id, fd.person_id, fd.file_id,
           fd.box_x, fd.box_y, fd.box_w, fd.box_h,
           f.file_path
    FROM face_detections fd
    JOIN indexed_files f ON fd.file_id = f.id
    WHERE fd.person_id IN (${placeholders})
    ORDER BY fd.person_id, fd.confidence DESC
  `).all(...ids) as {
    face_id: number; person_id: number; file_id: number;
    box_x: number; box_y: number; box_w: number; box_h: number;
    file_path: string;
  }[];
  const faceByFaceId = new Map<number, typeof faceCoordRows[0]>();
  const firstFaceByPerson = new Map<number, typeof faceCoordRows[0]>();
  for (const f of faceCoordRows) {
    faceByFaceId.set(f.face_id, f);
    if (!firstFaceByPerson.has(f.person_id)) firstFaceByPerson.set(f.person_id, f);
  }

  const nodes: FamilyGraphNode[] = personRows.map(row => {
    let face: typeof faceCoordRows[0] | undefined;
    if (row.representative_face_id != null) face = faceByFaceId.get(row.representative_face_id);
    if (!face) face = firstFaceByPerson.get(row.id);
    return {
      personId: row.id,
      name: row.name,
      fullName: (row as any).full_name ?? null,
      avatarData: row.avatar_data,
      representativeFaceId: row.representative_face_id,
      representativeFaceFilePath: face ? face.file_path : null,
      representativeFaceBox: face ? { x: face.box_x, y: face.box_y, w: face.box_w, h: face.box_h } : null,
      birthDate: row.birth_date,
      deathDate: row.death_date,
      deceasedMarker: row.deceased_marker,
      cardBackground: row.card_background,
      gender: row.gender,
      hopsFromFocus: visited.get(row.id) ?? maxHops,
      photoCount: photoCountByPerson.get(row.id) ?? 0,
      totalParentCount: totalParentCountByPerson.get(row.id) ?? 0,
      totalChildCount: totalChildCountByPerson.get(row.id) ?? 0,
      isPlaceholder: row.is_placeholder === 1,
    };
  });

  // Build stored edges: every collected relationship whose both endpoints
  // are in the visible node set.
  const nodeIdSet = new Set(nodes.map(n => n.personId));
  const edges: FamilyGraphEdge[] = collectedEdges
    .filter(r => nodeIdSet.has(r.person_a_id) && nodeIdSet.has(r.person_b_id))
    .map(r => ({
      id: r.id,
      aId: r.person_a_id,
      bId: r.person_b_id,
      type: r.type,
      since: r.since,
      until: r.until,
      flags: r.flags,
      derived: false,
    }));

  // Pre-record pairs that already have a STORED sibling_of edge so we
  // don't double-emit derived sibling edges over the top of them.
  const siblingPairs = new Set<string>();
  for (const r of collectedEdges) {
    if (r.type !== 'sibling_of') continue;
    const lo = Math.min(r.person_a_id, r.person_b_id);
    const hi = Math.max(r.person_a_id, r.person_b_id);
    siblingPairs.add(`${lo}:${hi}`);
  }

  // Derive sibling_of: if two different people share at least one parent
  // AND both appear in the visible node set AND there's no stored sibling
  // edge between them already, emit one derived edge for the canvas.
  const parentsByChild = new Map<number, Set<number>>();
  for (const r of collectedEdges) {
    if (r.type !== 'parent_of') continue;
    // person_a_id = parent, person_b_id = child
    const child = r.person_b_id;
    const parent = r.person_a_id;
    if (!parentsByChild.has(child)) parentsByChild.set(child, new Set());
    parentsByChild.get(child)!.add(parent);
  }
  const childIds = Array.from(parentsByChild.keys());
  for (let i = 0; i < childIds.length; i++) {
    for (let j = i + 1; j < childIds.length; j++) {
      const a = childIds[i];
      const b = childIds[j];
      if (!nodeIdSet.has(a) || !nodeIdSet.has(b)) continue;
      const pa = parentsByChild.get(a)!;
      const pb = parentsByChild.get(b)!;
      let shared = false;
      for (const parent of pa) { if (pb.has(parent)) { shared = true; break; } }
      if (!shared) continue;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (siblingPairs.has(key)) continue;
      siblingPairs.add(key);
      edges.push({
        id: null,
        aId: Math.min(a, b),
        bId: Math.max(a, b),
        type: 'sibling_of',
        since: null,
        until: null,
        flags: null,
        derived: true,
      });
    }
  }

  return { focusPersonId, nodes, edges };
}

// ═══════════════════════════════════════════════════════════════
// Trees v1 — co-occurrence suggestions (for later chip)
// ═══════════════════════════════════════════════════════════════

export interface PersonCooccurrenceSuggestion {
  personAId: number;
  personBId: number;
  personAName: string;
  personBName: string;
  sharedPhotoCount: number;
  /** True if an existing relationship between A and B already exists. */
  alreadyRelated: boolean;
}

/** Pairs of persons who appear in many of the same photos together. The
 *  UI layer decides whether to suggest "spouse", "parent", "sibling" etc.
 *  — we just surface strong pairs. */
export function getPersonCooccurrenceStats(limit: number = 25, minSharedPhotos: number = 20): PersonCooccurrenceSuggestion[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      pA.id   AS a_id,  pA.name AS a_name,
      pB.id   AS b_id,  pB.name AS b_name,
      COUNT(DISTINCT fdA.file_id) AS shared
    FROM face_detections fdA
    JOIN face_detections fdB
      ON fdA.file_id = fdB.file_id
     AND fdA.person_id < fdB.person_id
    JOIN persons pA ON fdA.person_id = pA.id
    JOIN persons pB ON fdB.person_id = pB.id
    WHERE pA.discarded_at IS NULL
      AND pB.discarded_at IS NULL
    GROUP BY pA.id, pB.id
    HAVING shared >= ?
    ORDER BY shared DESC
    LIMIT ?
  `).all(minSharedPhotos, limit) as { a_id: number; a_name: string; b_id: number; b_name: string; shared: number }[];

  if (rows.length === 0) return [];

  const pairIds = rows.map(r => `${r.a_id}:${r.b_id}`);
  // Any existing relationship between these pairs (either direction).
  const existing = db.prepare(`
    SELECT person_a_id, person_b_id FROM relationships
  `).all() as { person_a_id: number; person_b_id: number }[];
  const relatedSet = new Set<string>();
  for (const r of existing) {
    const lo = Math.min(r.person_a_id, r.person_b_id);
    const hi = Math.max(r.person_a_id, r.person_b_id);
    relatedSet.add(`${lo}:${hi}`);
  }

  return rows.map(r => ({
    personAId: r.a_id,
    personBId: r.b_id,
    personAName: r.a_name,
    personBName: r.b_name,
    sharedPhotoCount: r.shared,
    alreadyRelated: relatedSet.has(`${Math.min(r.a_id, r.b_id)}:${Math.max(r.a_id, r.b_id)}`),
  }));
}

/** Partner-likelihood score per candidate, relative to `anchorId`.
 *  Per shared photo, contributes  (1 / face_count²) * tag_multiplier:
 *    - Intimacy² — 2-face = 0.25, 4-face = 0.0625, 10-face = 0.01.
 *      Squared so that a single 2-person photo can't be drowned out by
 *      accumulated group-photo volume.
 *    - Tag boost (×5.0): wedding / bride / groom / bouquet / wedding_dress /
 *      tuxedo / ceremony / reception / gown / altar / chapel / married /
 *      newlywed / couple / engagement / proposal / honeymoon / romantic /
 *      kiss / hug / embrace / dating / selfie / portrait. Partnership
 *      context is so strong it should dominate non-partnership volume.
 *    - Tag penalty (×0.5): group / crowd / gathering / reunion / party /
 *      conference / classroom / team / concert.
 *    - Only tags at ≥0.70 confidence count.
 *    - Bonus (+10): when anchor and candidate share the exact same
 *      profile photo (avatar_data). Deterministic partnership signal —
 *      pins the real spouse to the top even if the photo's AI tags are
 *      sparse. */
export function getPartnerSuggestionScores(anchorId: number): { id: number; name: string; score: number; shared_photo_count: number }[] {
  const db = getDb();
  return db.prepare(`
    WITH anchor_photos AS (
      SELECT DISTINCT file_id FROM face_detections WHERE person_id = ?
    ),
    -- The "profile photo" shown in Trees comes from representative_face_id,
    -- which points to a face_detections row. Two people "share a profile
    -- photo" when their representative faces sit in the same file_id.
    -- avatar_data is kept as a fallback for the rare case where users
    -- have manually set an avatar that isn't one of their detected faces.
    anchor_profile AS (
      SELECT
        (SELECT fd.file_id FROM face_detections fd
         JOIN persons p ON p.representative_face_id = fd.id
         WHERE p.id = ?) AS profile_file_id,
        (SELECT avatar_data FROM persons WHERE id = ?) AS avatar_data
    ),
    shared AS (
      SELECT
        fd.file_id,
        fd.person_id AS candidate_id,
        (SELECT COUNT(*) FROM face_detections fd2 WHERE fd2.file_id = fd.file_id) AS face_count
      FROM face_detections fd
      WHERE fd.file_id IN (SELECT file_id FROM anchor_photos)
        AND fd.person_id IS NOT NULL
        AND fd.person_id != ?
    )
    SELECT
      p.id,
      p.name,
      COUNT(DISTINCT shared.file_id) AS shared_photo_count,
      (
        COALESCE(SUM(
          (1.0 / (shared.face_count * shared.face_count)) *
          CASE
            WHEN EXISTS (
              SELECT 1 FROM ai_tags t
              WHERE t.file_id = shared.file_id
                AND t.confidence >= 0.70
                AND LOWER(t.tag) IN (
                  'wedding','bride','groom','bouquet','wedding_dress','tuxedo',
                  'ceremony','reception','gown','altar','chapel','married','newlywed',
                  'couple','engagement','proposal','honeymoon','romantic','kiss',
                  'hug','embrace','dating','selfie','portrait'
                )
            ) THEN 5.0
            WHEN EXISTS (
              SELECT 1 FROM ai_tags t
              WHERE t.file_id = shared.file_id
                AND t.confidence >= 0.70
                AND LOWER(t.tag) IN (
                  'group','crowd','gathering','reunion','party','conference',
                  'classroom','team','concert'
                )
            ) THEN 0.5
            ELSE 1.0
          END
        ), 0.0)
        +
        CASE
          -- Shared representative-face photo: the strongest signal possible,
          -- both people literally have the same image as their profile.
          WHEN (SELECT fd.file_id FROM face_detections fd WHERE fd.id = p.representative_face_id)
               = (SELECT profile_file_id FROM anchor_profile)
               AND (SELECT profile_file_id FROM anchor_profile) IS NOT NULL
          THEN 10.0
          -- Fallback: explicit avatar_data equality (manually set avatars)
          WHEN p.avatar_data IS NOT NULL
            AND p.avatar_data = (SELECT avatar_data FROM anchor_profile)
          THEN 10.0
          ELSE 0.0
        END
      ) AS score
    FROM shared
    INNER JOIN persons p ON p.id = shared.candidate_id
    WHERE p.discarded_at IS NULL
      AND p.name NOT LIKE '__%'
    GROUP BY p.id, p.name, p.avatar_data, p.representative_face_id
    ORDER BY score DESC, shared_photo_count DESC
  `).all(anchorId, anchorId, anchorId, anchorId) as { id: number; name: string; score: number; shared_photo_count: number }[];
}

// ═══════════════════════════════════════════════════════════════
// Trees v1 — saved tree presets (named view bookmarks)
// ═══════════════════════════════════════════════════════════════

export interface SavedTreeRecord {
  id: number;
  name: string;
  focusPersonId: number | null;
  stepsEnabled: boolean;
  stepsDepth: number;
  generationsEnabled: boolean;
  ancestorsDepth: number;
  descendantsDepth: number;
  /** Optional data URL rendered faded behind the canvas. */
  backgroundImage: string | null;
  /** 0–1. Rendered opacity for the canvas background image. */
  backgroundOpacity: number;
  /** 0–1. Strengthens card borders/shadows so the tree stays legible
   *  on busy backdrops. */
  treeContrast: number;
  /** Person IDs whose ancestors (parents, grandparents, …) should be
   *  hidden from this tree's view. Keyed by partner — hiding Mel's
   *  ancestry leaves Mel in place but removes her parents et al. */
  hiddenAncestorPersonIds: number[];
  /** Person IDs the user has flagged as "not part of this family" so
   *  they stop surfacing as quick-add suggestions. Reversible via the
   *  picker's review list. Per-tree scope: the same person can be
   *  excluded here while remaining a valid candidate on a different
   *  tree. */
  excludedSuggestionPersonIds: number[];
  /** When true, half-sibling relationships render as plain
   *  Brother / Sister / Sibling rather than the technically accurate
   *  Half-brother / Half-sister. Per-tree preference for users who
   *  prefer the everyday term. */
  simplifyHalfLabels: boolean;
  /** When true, relationship labels on cards render gendered forms
   *  (Mother/Father/Brother/Sister/…) for anyone whose gender is set. */
  useGenderedLabels: boolean;
  /** When true, the Mars/Venus/Combined symbol in the top-right of
   *  each card is suppressed regardless of whether the gender is set. */
  hideGenderMarker: boolean;
  lastOpenedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const SAVED_TREE_CAP = 5;

interface SavedTreeRow {
  id: number;
  name: string;
  focus_person_id: number | null;
  steps_enabled: number;
  steps_depth: number;
  generations_enabled: number;
  ancestors_depth: number;
  descendants_depth: number;
  background_image: string | null;
  background_opacity: number;
  tree_contrast: number | null;
  hidden_ancestor_person_ids: string | null;
  excluded_suggestion_person_ids: string | null;
  simplify_half_labels: number | null;
  use_gendered_labels: number | null;
  hide_gender_marker: number | null;
  last_opened_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToSavedTree(row: SavedTreeRow): SavedTreeRecord {
  let hidden: number[] = [];
  if (row.hidden_ancestor_person_ids) {
    try {
      const parsed = JSON.parse(row.hidden_ancestor_person_ids);
      if (Array.isArray(parsed)) hidden = parsed.filter(n => typeof n === 'number');
    } catch {}
  }
  let excludedSuggestions: number[] = [];
  if (row.excluded_suggestion_person_ids) {
    try {
      const parsed = JSON.parse(row.excluded_suggestion_person_ids);
      if (Array.isArray(parsed)) excludedSuggestions = parsed.filter(n => typeof n === 'number');
    } catch {}
  }
  return {
    id: row.id,
    name: row.name,
    focusPersonId: row.focus_person_id,
    stepsEnabled: row.steps_enabled === 1,
    stepsDepth: row.steps_depth,
    generationsEnabled: row.generations_enabled === 1,
    ancestorsDepth: row.ancestors_depth,
    descendantsDepth: row.descendants_depth,
    backgroundImage: row.background_image,
    backgroundOpacity: typeof row.background_opacity === 'number' ? row.background_opacity : 0.15,
    treeContrast: typeof row.tree_contrast === 'number' ? row.tree_contrast : 0.3,
    hiddenAncestorPersonIds: hidden,
    excludedSuggestionPersonIds: excludedSuggestions,
    simplifyHalfLabels: row.simplify_half_labels === 1,
    useGenderedLabels: row.use_gendered_labels == null ? true : row.use_gendered_labels === 1,
    hideGenderMarker: row.hide_gender_marker === 1,
    lastOpenedAt: row.last_opened_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSavedTrees(): SavedTreeRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM saved_trees
    ORDER BY COALESCE(last_opened_at, created_at) DESC
  `).all() as SavedTreeRow[];
  return rows.map(rowToSavedTree);
}

export function getSavedTree(id: number): SavedTreeRecord | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM saved_trees WHERE id = ?`).get(id) as SavedTreeRow | undefined;
  return row ? rowToSavedTree(row) : null;
}

export function createSavedTree(args: {
  name: string;
  focusPersonId: number | null;
  stepsEnabled: boolean;
  stepsDepth: number;
  generationsEnabled: boolean;
  ancestorsDepth: number;
  descendantsDepth: number;
}): { success: boolean; data?: SavedTreeRecord; error?: string } {
  const db = getDb();
  const count = (db.prepare(`SELECT COUNT(*) AS cnt FROM saved_trees`).get() as { cnt: number }).cnt;
  if (count >= SAVED_TREE_CAP) {
    return { success: false, error: `You already have ${SAVED_TREE_CAP} saved trees — the maximum. Remove one in Manage Trees to create another.` };
  }
  const info = db.prepare(`
    INSERT INTO saved_trees (
      name, focus_person_id, steps_enabled, steps_depth,
      generations_enabled, ancestors_depth, descendants_depth,
      last_opened_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    args.name.trim() || 'Untitled tree',
    args.focusPersonId,
    args.stepsEnabled ? 1 : 0,
    args.stepsDepth,
    args.generationsEnabled ? 1 : 0,
    args.ancestorsDepth,
    args.descendantsDepth,
  );
  const record = getSavedTree(info.lastInsertRowid as number);
  return record ? { success: true, data: record } : { success: false, error: 'Insert failed.' };
}

export function updateSavedTree(id: number, patch: Partial<{
  name: string;
  focusPersonId: number | null;
  stepsEnabled: boolean;
  stepsDepth: number;
  generationsEnabled: boolean;
  ancestorsDepth: number;
  descendantsDepth: number;
  backgroundImage: string | null;
  backgroundOpacity: number;
  treeContrast: number;
  hiddenAncestorPersonIds: number[];
  excludedSuggestionPersonIds: number[];
  simplifyHalfLabels: boolean;
  useGenderedLabels: boolean;
  hideGenderMarker: boolean;
  markOpened: boolean;
}>): { success: boolean; data?: SavedTreeRecord; error?: string } {
  const db = getDb();
  const existing = getSavedTree(id);
  if (!existing) return { success: false, error: 'Tree not found.' };

  const sets: string[] = [];
  const values: any[] = [];
  if (patch.name != null)               { sets.push('name = ?');                values.push(patch.name.trim() || 'Untitled tree'); }
  if (patch.focusPersonId !== undefined) { sets.push('focus_person_id = ?');     values.push(patch.focusPersonId); }
  if (patch.stepsEnabled != null)       { sets.push('steps_enabled = ?');       values.push(patch.stepsEnabled ? 1 : 0); }
  if (patch.stepsDepth != null)         { sets.push('steps_depth = ?');         values.push(patch.stepsDepth); }
  if (patch.generationsEnabled != null) { sets.push('generations_enabled = ?'); values.push(patch.generationsEnabled ? 1 : 0); }
  if (patch.ancestorsDepth != null)     { sets.push('ancestors_depth = ?');     values.push(patch.ancestorsDepth); }
  if (patch.descendantsDepth != null)   { sets.push('descendants_depth = ?');   values.push(patch.descendantsDepth); }
  if (patch.backgroundImage !== undefined) { sets.push('background_image = ?'); values.push(patch.backgroundImage); }
  if (patch.backgroundOpacity != null)  { sets.push('background_opacity = ?'); values.push(Math.max(0, Math.min(1, patch.backgroundOpacity))); }
  if (patch.treeContrast != null)       { sets.push('tree_contrast = ?');       values.push(Math.max(0, Math.min(1, patch.treeContrast))); }
  if (patch.hiddenAncestorPersonIds)    { sets.push('hidden_ancestor_person_ids = ?'); values.push(JSON.stringify(patch.hiddenAncestorPersonIds)); }
  if (patch.excludedSuggestionPersonIds) { sets.push('excluded_suggestion_person_ids = ?'); values.push(JSON.stringify(patch.excludedSuggestionPersonIds)); }
  if (patch.simplifyHalfLabels != null) { sets.push('simplify_half_labels = ?'); values.push(patch.simplifyHalfLabels ? 1 : 0); }
  if (patch.useGenderedLabels != null)  { sets.push('use_gendered_labels = ?');  values.push(patch.useGenderedLabels ? 1 : 0); }
  if (patch.hideGenderMarker != null)   { sets.push('hide_gender_marker = ?');   values.push(patch.hideGenderMarker ? 1 : 0); }
  if (patch.markOpened)                 { sets.push(`last_opened_at = datetime('now')`); }
  sets.push(`updated_at = datetime('now')`);

  db.prepare(`UPDATE saved_trees SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  const record = getSavedTree(id);
  return record ? { success: true, data: record } : { success: false, error: 'Update failed.' };
}

export function setPersonCardBackground(personId: number, dataUrl: string | null): { success: boolean; error?: string } {
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM persons WHERE id = ?`).get(personId);
  if (!existing) return { success: false, error: 'Person not found.' };
  db.prepare(`UPDATE persons SET card_background = ?, updated_at = datetime('now') WHERE id = ?`).run(dataUrl, personId);
  return { success: true };
}

/** Set a person's gender. Writes to persons.gender and logs a
 *  reversible entry in graph_history so Ctrl+Z flips it back. */
export function setPersonGender(personId: number, gender: string | null): { success: boolean; error?: string } {
  const db = getDb();
  const row = db.prepare(`SELECT id, name, gender FROM persons WHERE id = ?`).get(personId) as { id: number; name: string; gender: string | null } | undefined;
  if (!row) return { success: false, error: 'Person not found.' };
  const previous = row.gender;
  if (previous === gender) return { success: true };
  const forward: HistoryOp = { kind: 'person_gender_set', personId, gender };
  const inverse: HistoryOp = { kind: 'person_gender_set', personId, gender: previous };
  const r = applyGraphOp(forward);
  if (!r.success) return { success: false, error: r.error ?? 'Could not set gender.' };
  const nm = (row.name ?? '').trim() || `#${personId}`;
  const label = gender === null ? 'cleared' : `set to ${gender.replace(/_/g, ' ')}`;
  logGraphHistory('person_gender_set', forward, inverse, `${nm}'s gender ${label}`);
  return { success: true };
}

export function deleteSavedTree(id: number): { success: boolean; error?: string } {
  const db = getDb();
  db.prepare(`DELETE FROM saved_trees WHERE id = ?`).run(id);
  return { success: true };
}

/** Toggle whether a person's ancestry is hidden in a given saved tree,
 *  AND log a reversible entry in graph_history so Ctrl+Z undoes it like
 *  any other graph action. Goes through applyGraphOp for the write so
 *  the same code path is used for forward + undo + redo. */
export function toggleHiddenAncestor(treeId: number, personId: number): { success: boolean; nowHidden?: boolean; error?: string } {
  const db = getDb();
  const tree = getSavedTree(treeId);
  if (!tree) return { success: false, error: 'Tree not found.' };
  const currentlyHidden = tree.hiddenAncestorPersonIds.includes(personId);
  const forwardKind = currentlyHidden ? 'tree_show_ancestor' : 'tree_hide_ancestor';
  const inverseKind = currentlyHidden ? 'tree_hide_ancestor' : 'tree_show_ancestor';
  const forward: HistoryOp = { kind: forwardKind as any, treeId, personId };
  const inverse: HistoryOp = { kind: inverseKind as any, treeId, personId };
  const r = applyGraphOp(forward);
  if (!r.success) return { success: false, error: r.error ?? 'Could not update tree.' };
  // Description uses the person's name for the Manage Trees history list.
  const nameRow = db.prepare(`SELECT name FROM persons WHERE id = ?`).get(personId) as { name?: string } | undefined;
  const nm = nameRow?.name?.trim() || `#${personId}`;
  const verb = currentlyHidden ? 'Showed' : 'Hid';
  logGraphHistory(forwardKind, forward, inverse, `${verb} ${nm}'s ancestry in "${tree.name}"`);
  return { success: true, nowHidden: !currentlyHidden };
}

// ═══════════════════════════════════════════════════════════════
// Trees v1 — placeholder persons (skip-generation bridges)
// ═══════════════════════════════════════════════════════════════

/** Create a blank placeholder person. Used when the user asserts a
 *  skip-generation relationship (grandparent, aunt/uncle, cousin)
 *  without the intermediary yet being named. Placeholders are hidden
 *  from People Manager and render as ghost circles in Trees. */
export function createPlaceholderPerson(): number {
  const db = getDb();
  const info = db.prepare(
    `INSERT INTO persons (name, is_placeholder) VALUES ('', 1)`
  ).run();
  return info.lastInsertRowid as number;
}

/** Create a new named person with no photos or faces yet. Used from the
 *  Trees modal when the user wants to add a family member who isn't yet
 *  represented in any photo (e.g. a great-grandparent they never had
 *  pictures of). The person shows up in People Manager like any other
 *  named person — photos can be assigned later if they ever surface. */
export function createNamedPerson(name: string): { success: boolean; data?: number; error?: string } {
  const trimmed = name.trim();
  if (!trimmed) return { success: false, error: 'Name cannot be empty.' };
  if (trimmed.startsWith('__')) return { success: false, error: 'Names starting with __ are reserved.' };
  const db = getDb();
  try {
    const info = db.prepare(
      `INSERT INTO persons (name, is_placeholder) VALUES (?, 0)`
    ).run(trimmed);
    return { success: true, data: info.lastInsertRowid as number };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** Turn a placeholder into a real named person (user typed their name). */
export function namePlaceholder(personId: number, name: string): { success: boolean; error?: string } {
  const db = getDb();
  const person = db.prepare(
    `SELECT COALESCE(is_placeholder, 0) AS is_placeholder FROM persons WHERE id = ?`
  ).get(personId) as { is_placeholder: number } | undefined;
  if (!person) return { success: false, error: 'Person not found.' };
  if (!person.is_placeholder) return { success: false, error: 'That person is not a placeholder.' };
  const trimmed = name.trim();
  if (!trimmed) return { success: false, error: 'Name cannot be empty.' };
  db.prepare(`UPDATE persons SET name = ?, is_placeholder = 0, updated_at = datetime('now') WHERE id = ?`)
    .run(trimmed, personId);
  return { success: true };
}

/** Replace a placeholder with an existing named person: transfer all
 *  edges touching the placeholder to the target, dedupe against the
 *  target's existing edges, then delete the placeholder. */
export function mergePlaceholderIntoPerson(placeholderId: number, targetPersonId: number): { success: boolean; error?: string } {
  const db = getDb();
  const ph = db.prepare(
    `SELECT COALESCE(is_placeholder, 0) AS is_placeholder FROM persons WHERE id = ?`
  ).get(placeholderId) as { is_placeholder: number } | undefined;
  if (!ph) return { success: false, error: 'Placeholder not found.' };
  if (!ph.is_placeholder) return { success: false, error: 'Source is not a placeholder.' };
  if (placeholderId === targetPersonId) return { success: false, error: 'Cannot merge into self.' };
  const target = db.prepare(`SELECT id FROM persons WHERE id = ? AND discarded_at IS NULL`).get(targetPersonId);
  if (!target) return { success: false, error: 'Target person not found.' };

  const tx = db.transaction(() => {
    const edges = db.prepare(
      `SELECT * FROM relationships WHERE person_a_id = ? OR person_b_id = ?`
    ).all(placeholderId, placeholderId) as { id: number; person_a_id: number; person_b_id: number; type: string }[];
    for (const edge of edges) {
      const newA = edge.person_a_id === placeholderId ? targetPersonId : edge.person_a_id;
      const newB = edge.person_b_id === placeholderId ? targetPersonId : edge.person_b_id;
      if (newA === newB) {
        db.prepare(`DELETE FROM relationships WHERE id = ?`).run(edge.id);
        continue;
      }
      const exists = db.prepare(
        `SELECT id FROM relationships WHERE person_a_id = ? AND person_b_id = ? AND type = ?`
      ).get(newA, newB, edge.type);
      if (exists) {
        db.prepare(`DELETE FROM relationships WHERE id = ?`).run(edge.id);
      } else {
        db.prepare(`UPDATE relationships SET person_a_id = ?, person_b_id = ? WHERE id = ?`).run(newA, newB, edge.id);
      }
    }
    db.prepare(`DELETE FROM persons WHERE id = ? AND is_placeholder = 1`).run(placeholderId);
  });
  tx();
  return { success: true };
}

/** Delete a placeholder entirely (and any edges touching it). */
export function removePlaceholder(placeholderId: number): { success: boolean; error?: string } {
  const db = getDb();
  const ph = db.prepare(
    `SELECT COALESCE(is_placeholder, 0) AS is_placeholder FROM persons WHERE id = ?`
  ).get(placeholderId) as { is_placeholder: number } | undefined;
  if (!ph) return { success: false, error: 'Placeholder not found.' };
  if (!ph.is_placeholder) return { success: false, error: 'Not a placeholder.' };
  // ON DELETE CASCADE on relationships takes care of edges.
  db.prepare(`DELETE FROM persons WHERE id = ?`).run(placeholderId);
  return { success: true };
}

// ═══ Albums (v2.0.8) ═════════════════════════════════════════════════════════

/**
 * Insert or update a Takeout-imported album by its external key (the original
 * Google Photos folder name). Returns the album_id. The partial unique index
 * `idx_albums_external_key` (WHERE source='takeout_imported') is what makes this
 * collision-free within Takeout imports while never bleeding into user-created
 * albums of the same name. User-created albums use createUserAlbum instead.
 */
export function upsertTakeoutAlbum(externalKey: string, title: string): number {
  const db = getDb();
  const existing = db.prepare(
    `SELECT id FROM albums WHERE external_album_key = ? AND source = 'takeout_imported' LIMIT 1`
  ).get(externalKey) as { id: number } | undefined;
  if (existing) {
    db.prepare(`UPDATE albums SET title = ?, updated_at = datetime('now') WHERE id = ?`).run(title, existing.id);
    return existing.id;
  }
  const result = db.prepare(
    `INSERT INTO albums (title, external_album_key, source) VALUES (?, ?, 'takeout_imported')`
  ).run(title, externalKey);
  return Number(result.lastInsertRowid);
}

/**
 * Reconcile auto source-group memberships for every album. Idempotent
 * INSERT OR IGNORE — runs the same SQL as the startup auto-seed in
 * initDatabase so albums created at RUNTIME (Takeout backfill, future
 * importers) get linked to their auto group (e.g. 'Google Photos')
 * without waiting for the next launch.
 *
 * Background — Terry 2026-05-21: the Takeout backfill in Settings
 * created 6 new Google Photos albums but they only appeared in the
 * all-albums grid, not in the tree. Root cause: the auto-membership
 * link was a once-at-init job. This function is the runtime version.
 *
 * Returns the number of new memberships inserted (0 when the DB is
 * already fully reconciled).
 */
export function reconcileAutoSourceMemberships(): number {
  const db = getDb();
  // Step 1: make sure every distinct source has an auto group. New
  // sources that didn't exist at last init (e.g. first-ever Takeout
  // import) need their group row before the membership INSERT can
  // join against it.
  const ALBUM_SOURCE_PROFILES: Record<string, { title: string; icon_key: string; palette_key: string }> = {
    user_created:     { title: 'PDR',                   icon_key: 'home',      palette_key: 'violet'   },
    takeout_imported: { title: 'Google Photos',         icon_key: 'sparkles',  palette_key: 'red'      },
  };
  const distinctSources = db.prepare(
    `SELECT DISTINCT source FROM albums WHERE source IS NOT NULL AND source != ''`
  ).all() as { source: string }[];
  const groupInsert = db.prepare(
    `INSERT OR IGNORE INTO album_groups (title, source_kind, source_key, icon_key, palette_key, parent_id)
       VALUES (?, 'auto', ?, ?, ?, NULL)`
  );
  for (const { source } of distinctSources) {
    const profile = ALBUM_SOURCE_PROFILES[source]
      ?? { title: source, icon_key: 'cloud', palette_key: 'sky' };
    groupInsert.run(profile.title, source, profile.icon_key, profile.palette_key);
  }
  // Step 2: link every album that isn't already linked to its source's
  // auto group. INSERT OR IGNORE skips albums already linked.
  const result = db.prepare(`
    INSERT OR IGNORE INTO album_group_memberships (album_id, group_id, is_auto)
    SELECT a.id, g.id, 1
      FROM albums a
      JOIN album_groups g
        ON g.source_kind = 'auto' AND g.source_key = a.source
  `).run();
  return Number(result.changes);
}

/**
 * Link a file to an album. Idempotent via the composite primary key — calling
 * twice with the same (albumId, fileId) is a no-op. Returns true iff a new row
 * was inserted (so callers can count fresh memberships vs. revisits).
 */
export function linkAlbumFile(albumId: number, fileId: number): boolean {
  const db = getDb();
  const result = db.prepare(
    `INSERT OR IGNORE INTO album_files (album_id, file_id) VALUES (?, ?)`
  ).run(albumId, fileId);
  return result.changes > 0;
}

/**
 * Apply Takeout sidecar metadata to an indexed_files row. Sets caption when a
 * description is provided and overrides original_filename with the sidecar's
 * `title` when present (sidecar title is the ground-truth device name; the
 * on-disk filename can drift if Google appended (1)/(2) for collisions or
 * truncated for length).
 *
 * COALESCE semantics: passing null leaves the existing value untouched, so
 * re-runs against the same file are non-destructive — if the sidecar drops a
 * description on a later import, we don't wipe the caption we already had.
 */
export function applyTakeoutSidecarMetadata(
  fileId: number,
  sidecarTitle: string | null,
  sidecarDescription: string | null,
): { captionSet: boolean; originalFilenameUpdated: boolean } {
  const db = getDb();
  const before = db.prepare(
    `SELECT caption, original_filename FROM indexed_files WHERE id = ?`
  ).get(fileId) as { caption: string | null; original_filename: string } | undefined;
  if (!before) return { captionSet: false, originalFilenameUpdated: false };

  const nextCaption = sidecarDescription ?? before.caption;
  const nextOriginal = sidecarTitle ?? before.original_filename;

  db.prepare(
    `UPDATE indexed_files SET caption = ?, original_filename = ? WHERE id = ?`
  ).run(nextCaption, nextOriginal, fileId);

  return {
    captionSet: !!sidecarDescription && sidecarDescription !== before.caption,
    originalFilenameUpdated: !!sidecarTitle && sidecarTitle !== before.original_filename,
  };
}

/**
 * Look up indexed_files.id by destination file_path within a specific run.
 * Used by the Takeout importer to match Fix-output paths back to the freshly
 * inserted DB rows after indexFixRun.
 */
export function findFileIdByPathInRun(runId: number, filePath: string): number | undefined {
  const db = getDb();
  const row = db.prepare(
    `SELECT id FROM indexed_files WHERE run_id = ? AND file_path = ? LIMIT 1`
  ).get(runId, filePath) as { id: number } | undefined;
  return row?.id;
}

/**
 * Look up indexed_files.id by (original_filename, size_bytes). Kept as a
 * secondary fallback for the backfill path when no sidecar timestamp is
 * available — most sidecars include photoTakenTime so this rarely fires.
 * NOTE: PDR's Fix writes EXIF into output files, which CHANGES the on-disk
 * size from whatever the Takeout ZIP originally held. So this size-based
 * lookup only works for files PDR DIDN'T EXIF-stamp (typically Marked
 * confidence with no derived date). For everything else use the date-based
 * variant below.
 */
export function findFileIdByOriginalNameAndSize(originalFilename: string, sizeBytes: number): number | undefined {
  const db = getDb();
  const row = db.prepare(
    `SELECT id FROM indexed_files
      WHERE original_filename = ? AND size_bytes = ?
      ORDER BY id DESC
      LIMIT 1`
  ).get(originalFilename, sizeBytes) as { id: number } | undefined;
  return row?.id;
}

/**
 * Look up indexed_files.id by (original_filename, derived_date). This is the
 * preferred match path for the backfill flow because the sidecar's
 * photoTakenTime → derived_date is invariant under PDR's Fix pipeline (Fix
 * writes EXIF, which changes file size, but the taken-date stays exactly
 * what the sidecar said).
 *
 * `derivedDate` is the canonical 'YYYY-MM-DD HH:MM:SS' format PDR stores in
 * indexed_files.derived_date. Returns the most recent id when multiple rows
 * match (e.g. the same filename + same taken-second from a re-imported
 * Takeout) so the latest indexing wins.
 */
export function findFileIdByOriginalNameAndDate(originalFilename: string, derivedDate: string): number | undefined {
  const db = getDb();
  const row = db.prepare(
    `SELECT id FROM indexed_files
      WHERE original_filename = ? AND derived_date = ?
      ORDER BY id DESC
      LIMIT 1`
  ).get(originalFilename, derivedDate) as { id: number } | undefined;
  return row?.id;
}

// ─── Album list / read / mutate helpers (v2.0.8 step 3) ─────────────────────

export interface AlbumSummary {
  id: number;
  title: string;
  source: 'user_created' | 'takeout_imported';
  externalAlbumKey: string | null;
  description: string | null;
  coverFileId: number | null;
  /** Resolved cover photo path: explicit cover_file_id if set, else the
   *  album's first-by-taken-date photo, else null when the album is empty. */
  coverPath: string | null;
  photoCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * List every album with its photo count and a resolved cover-photo path.
 * Cover resolution per question 3 of the v2.0.8 design: explicit
 * `cover_file_id` wins; on NULL we fall back to the first album_file by
 * the photo's derived_date (chronologically earliest). Cheap enough to
 * compute inline via correlated SELECTs — the user-album cardinality is
 * O(dozens-to-hundreds), not millions.
 *
 * Ordered by `updated_at DESC` so recently-touched albums bubble up. New
 * Takeout imports + recent additions both surface naturally.
 */
export function listAlbums(): AlbumSummary[] {
  const db = getDb();
  // v2.0.15 — count and cover-pick both exclude recycled files. A
  // recycled photo can still be a member of an album (the
  // album_files row stays so Restore puts it back in the album),
  // but it shouldn't inflate the album's photoCount or appear as
  // its cover.
  const rows = db.prepare(`
    SELECT
      a.id, a.title, a.source, a.external_album_key AS externalAlbumKey,
      a.description, a.cover_file_id AS coverFileId,
      a.created_at AS createdAt, a.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM album_files af
         JOIN indexed_files ic ON ic.id = af.file_id
         WHERE af.album_id = a.id
           AND (ic.in_recycle_bin IS NULL OR ic.in_recycle_bin = 0)
      ) AS photoCount,
      COALESCE(
        (SELECT file_path FROM indexed_files
           WHERE id = a.cover_file_id
             AND (in_recycle_bin IS NULL OR in_recycle_bin = 0)),
        (SELECT i.file_path
           FROM album_files af2
           JOIN indexed_files i ON i.id = af2.file_id
          WHERE af2.album_id = a.id
            AND (i.in_recycle_bin IS NULL OR i.in_recycle_bin = 0)
          ORDER BY i.derived_date ASC, i.id ASC
          LIMIT 1)
      ) AS coverPath
    FROM albums a
    ORDER BY a.updated_at DESC, a.created_at DESC
  `).all() as AlbumSummary[];
  return rows;
}

/**
 * Create a user-authored album. `external_album_key` stays NULL — only
 * Takeout-imported albums populate it. Returns the new album id.
 */
export function createUserAlbum(title: string): number {
  const db = getDb();
  const trimmed = title.trim() || 'Untitled album';
  const txn = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO albums (title, source) VALUES (?, 'user_created')`
    ).run(trimmed);
    const albumId = Number(result.lastInsertRowid);
    // Auto-link the new album to its source's auto group (here:
    // the "PDR" auto group, source_kind='auto', source_key=
    // 'user_created'). Mirrors what the startup-time seed migration
    // does for existing albums — without this, freshly created
    // albums only show in the "All albums" view until the app
    // restarts and the seed re-runs. Terry 2026-05-18: "closing
    // the app and relaunching it is not acceptable behaviour."
    db.prepare(`
      INSERT OR IGNORE INTO album_group_memberships (album_id, group_id, is_auto)
      SELECT ?, g.id, 1
        FROM album_groups g
       WHERE g.source_kind = 'auto'
         AND g.source_key  = 'user_created'
    `).run(albumId);
    return albumId;
  });
  return txn();
}

/** Rename an album. Always bumps updated_at so the list re-sorts. */
export function renameAlbum(albumId: number, newTitle: string): { success: boolean; error?: string } {
  const db = getDb();
  const trimmed = newTitle.trim();
  if (!trimmed) return { success: false, error: 'Album title cannot be empty.' };
  const result = db.prepare(
    `UPDATE albums SET title = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(trimmed, albumId);
  if (result.changes === 0) return { success: false, error: 'Album not found.' };
  return { success: true };
}

/**
 * Delete an album entirely. `album_files` rows cascade via the FK; the
 * actual photo files in `indexed_files` stay untouched (an album is a
 * virtual grouping, never a container).
 */
export function deleteAlbum(albumId: number): { success: boolean; error?: string } {
  const db = getDb();
  const result = db.prepare(`DELETE FROM albums WHERE id = ?`).run(albumId);
  if (result.changes === 0) return { success: false, error: 'Album not found.' };
  return { success: true };
}

/**
 * List the photos in an album, sorted by taken-date ascending (then id for
 * ties). Per question 1 of the v2.0.8 design: taken-date is the natural
 * order for chronological-muscle-memory readers. Photos with no derived_date
 * sink to the bottom (NULL sorts last in SQLite's ASC by default — actually
 * NULL sorts FIRST in SQLite ASC; we adjust with COALESCE to push them
 * down).
 */
export function listAlbumPhotos(albumId: number): IndexedFile[] {
  const db = getDb();
  // v2.0.15 — recycled photos are hidden from album views. Their
  // album_files row stays intact so Restore from the Recycle Bin
  // returns them to every album they were in.
  return db.prepare(`
    SELECT i.*
    FROM album_files af
    JOIN indexed_files i ON i.id = af.file_id
    WHERE af.album_id = ?
      AND (i.in_recycle_bin IS NULL OR i.in_recycle_bin = 0)
    ORDER BY COALESCE(i.derived_date, '9999-99-99') ASC, i.id ASC
  `).all(albumId) as IndexedFile[];
}

/**
 * Bulk-add files to an album. `INSERT OR IGNORE` makes the call
 * idempotent under the composite PK, so callers can pass the user's full
 * selection without de-duping client-side. Returns the count of NEW rows
 * inserted (excluding ignored duplicates).
 */
export function addPhotosToAlbum(albumId: number, fileIds: number[]): number {
  if (fileIds.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(`INSERT OR IGNORE INTO album_files (album_id, file_id) VALUES (?, ?)`);
  const txn = db.transaction((ids: number[]) => {
    let inserted = 0;
    for (const id of ids) {
      const r = stmt.run(albumId, id);
      if (r.changes > 0) inserted++;
    }
    // Bump the album's updated_at so the list re-sorts.
    db.prepare(`UPDATE albums SET updated_at = datetime('now') WHERE id = ?`).run(albumId);
    return inserted;
  });
  return txn(fileIds);
}

/**
 * Bulk-remove files from an album. Photos themselves stay in
 * indexed_files; only the membership row goes. Returns the count of
 * removed memberships.
 */
export function removePhotosFromAlbum(albumId: number, fileIds: number[]): number {
  if (fileIds.length === 0) return 0;
  const db = getDb();
  const placeholders = fileIds.map(() => '?').join(',');
  const result = db.prepare(
    `DELETE FROM album_files WHERE album_id = ? AND file_id IN (${placeholders})`
  ).run(albumId, ...fileIds);
  if (result.changes > 0) {
    db.prepare(`UPDATE albums SET updated_at = datetime('now') WHERE id = ?`).run(albumId);
  }
  return Number(result.changes);
}

// ─── Album-group helpers (v2.0.8 hierarchical multi-membership) ─────────────

export interface AlbumGroupRecord {
  id: number;
  title: string;
  parent_id: number | null;
  source_kind: 'auto' | 'user';
  source_key: string | null;
  icon_key: string | null;
  palette_key: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  /** Pre-aggregated count of albums (direct memberships) inside this
   *  group. Useful for the renderer's tree headers without an extra
   *  round-trip per node. */
  album_count: number;
}

export interface AlbumGroupMembershipRecord {
  album_id: number;
  group_id: number;
  is_auto: 0 | 1;
  added_at: string;
}

/**
 * Maximum folder nesting depth for USER groups. Auto/source groups
 * always sit at the root (parent_id NULL) and aren't counted. With
 * cap = 1, the tree is at most root → sub → album-leaf. Terry's
 * design decision 2026-05-18: "Two is the right choice + the album."
 */
const USER_GROUP_MAX_DEPTH = 1;

/** Walk parent_id upwards and return the depth (root = 0). Cycle-safe
 *  via a 16-hop guard — beyond that something has gone seriously
 *  wrong with the schema and we bail rather than loop forever. */
function getAlbumGroupDepth(groupId: number): number {
  const db = getDb();
  let currentId: number | null = groupId;
  let depth = 0;
  for (let i = 0; i < 16 && currentId !== null; i++) {
    const row = db.prepare(
      `SELECT parent_id FROM album_groups WHERE id = ?`
    ).get(currentId) as { parent_id: number | null } | undefined;
    if (!row || row.parent_id === null) return depth;
    currentId = row.parent_id;
    depth++;
  }
  return depth;
}

/** Max depth of any descendant under `groupId` (group itself = 0).
 *  Used by moveAlbumGroup to refuse moves that would push the
 *  subtree past USER_GROUP_MAX_DEPTH after the move. */
function getAlbumGroupSubtreeDepth(groupId: number): number {
  const db = getDb();
  const direct = db.prepare(
    `SELECT id FROM album_groups WHERE parent_id = ?`
  ).all(groupId) as { id: number }[];
  if (direct.length === 0) return 0;
  let max = 0;
  for (const child of direct) {
    const childDepth = 1 + getAlbumGroupSubtreeDepth(child.id);
    if (childDepth > max) max = childDepth;
  }
  return max;
}

/**
 * List every album group with its direct album_count. Flat list with
 * parent_id; the renderer assembles the tree. Sorted by sort_order
 * then alphabetical (case-insensitive), with auto groups bubbling
 * to the top of the root level so the source folders are always
 * the first thing the user sees.
 */
export function listAlbumGroups(): AlbumGroupRecord[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      g.id, g.title, g.parent_id, g.source_kind, g.source_key,
      g.icon_key, g.palette_key, g.sort_order,
      g.created_at, g.updated_at,
      (SELECT COUNT(*) FROM album_group_memberships m WHERE m.group_id = g.id) AS album_count
    FROM album_groups g
    ORDER BY
      CASE WHEN g.parent_id IS NULL AND g.source_kind = 'auto' THEN 0 ELSE 1 END,
      g.parent_id IS NULL DESC,
      g.sort_order ASC,
      g.title COLLATE NOCASE ASC
  `).all() as AlbumGroupRecord[];
}

/**
 * List every album_group membership in one query. Flat list; the
 * renderer joins against listAlbums() + listAlbumGroups() to render
 * the tree. Cheap — memberships are O(albums × ~3 average folders).
 */
export function listAlbumGroupMemberships(): AlbumGroupMembershipRecord[] {
  const db = getDb();
  return db.prepare(`
    SELECT album_id, group_id, is_auto, added_at
      FROM album_group_memberships
      ORDER BY group_id, album_id
  `).all() as AlbumGroupMembershipRecord[];
}

/**
 * List albums that live in a specific group, sorted alphabetically
 * (case-insensitive). Used by the AlbumsView when the user clicks
 * a group header to drill in.
 */
export function listAlbumsInGroup(groupId: number): AlbumSummary[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      a.id, a.title, a.source, a.external_album_key AS externalAlbumKey,
      a.description, a.cover_file_id AS coverFileId,
      a.created_at AS createdAt, a.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM album_files af WHERE af.album_id = a.id) AS photoCount,
      COALESCE(
        (SELECT file_path FROM indexed_files WHERE id = a.cover_file_id),
        (SELECT i.file_path
           FROM album_files af2
           JOIN indexed_files i ON i.id = af2.file_id
          WHERE af2.album_id = a.id
          ORDER BY i.derived_date ASC, i.id ASC
          LIMIT 1)
      ) AS coverPath
    FROM album_group_memberships m
    JOIN albums a ON a.id = m.album_id
    WHERE m.group_id = ?
    ORDER BY a.title COLLATE NOCASE ASC
  `).all(groupId) as AlbumSummary[];
}

/**
 * Create a user-authored folder. `parentId = null` lands at root;
 * non-null nests under that group, refused if it would exceed
 * USER_GROUP_MAX_DEPTH. Source-kind 'auto' parents are also refused
 * to keep auto groups flat (they're a render-time grouping, not a
 * place to nest user folders inside).
 */
export function createUserAlbumGroup(title: string, parentId: number | null = null): { success: boolean; id?: number; error?: string } {
  const db = getDb();
  const trimmed = title.trim() || 'New folder';
  if (parentId !== null) {
    const parent = db.prepare(
      `SELECT source_kind FROM album_groups WHERE id = ?`
    ).get(parentId) as { source_kind: 'auto' | 'user' } | undefined;
    if (!parent) return { success: false, error: 'Parent folder not found.' };
    if (parent.source_kind === 'auto') {
      return { success: false, error: "Source folders can't have sub-folders." };
    }
    const parentDepth = getAlbumGroupDepth(parentId);
    if (parentDepth >= USER_GROUP_MAX_DEPTH) {
      return { success: false, error: 'Folders can only nest one level deep.' };
    }
  }
  const result = db.prepare(
    `INSERT INTO album_groups (title, parent_id, source_kind) VALUES (?, ?, 'user')`
  ).run(trimmed, parentId);
  return { success: true, id: Number(result.lastInsertRowid) };
}

/** Rename a user folder. Refuses on auto groups (their titles come
 *  from ALBUM_SOURCE_PROFILES and are part of the source identity). */
export function renameAlbumGroup(groupId: number, newTitle: string): { success: boolean; error?: string } {
  const db = getDb();
  const trimmed = newTitle.trim();
  if (!trimmed) return { success: false, error: 'Folder name cannot be empty.' };
  const row = db.prepare(
    `SELECT source_kind FROM album_groups WHERE id = ?`
  ).get(groupId) as { source_kind: 'auto' | 'user' } | undefined;
  if (!row) return { success: false, error: 'Folder not found.' };
  if (row.source_kind === 'auto') {
    return { success: false, error: "Source folders can't be renamed." };
  }
  db.prepare(
    `UPDATE album_groups SET title = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(trimmed, groupId);
  return { success: true };
}

/** Delete a user folder. Cascades to child folders + memberships
 *  (the actual albums and photos are untouched — folders are
 *  virtual). Refuses on auto groups. */
export function deleteAlbumGroup(groupId: number): { success: boolean; error?: string } {
  const db = getDb();
  const row = db.prepare(
    `SELECT source_kind FROM album_groups WHERE id = ?`
  ).get(groupId) as { source_kind: 'auto' | 'user' } | undefined;
  if (!row) return { success: false, error: 'Folder not found.' };
  if (row.source_kind === 'auto') {
    return { success: false, error: "Source folders can't be deleted." };
  }
  db.prepare(`DELETE FROM album_groups WHERE id = ?`).run(groupId);
  return { success: true };
}

/**
 * Reorder a contiguous list of sibling album_groups by assigning each
 * one its index as sort_order. Used by the tree's drag-reorder
 * gesture (PM-style — Terry asked us to copy the People Manager
 * Unnamed-tab pattern). Caller passes the FULL list of siblings in
 * the desired new order; backend writes sort_order = 0, 1, 2, … so
 * the next listAlbumGroups returns them in that sequence.
 *
 * Idempotent re-runs are cheap (same writes). Single transaction so
 * a partial failure doesn't leave the row sequence broken.
 */
export function reorderAlbumGroups(siblingIds: number[]): { success: boolean; error?: string } {
  if (!Array.isArray(siblingIds) || siblingIds.length === 0) {
    return { success: true };
  }
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE album_groups SET sort_order = ?, updated_at = datetime('now') WHERE id = ?`
  );
  const txn = db.transaction((ids: number[]) => {
    for (let i = 0; i < ids.length; i++) {
      stmt.run(i, ids[i]);
    }
  });
  txn(siblingIds);
  return { success: true };
}

/**
 * Move a user folder under a new parent (or to root with newParentId
 * = null). Refuses if (a) it's an auto group, (b) the new parent is
 * an auto group, (c) the move would create a cycle, or (d) the move
 * would push the subtree past USER_GROUP_MAX_DEPTH.
 */
export function moveAlbumGroup(groupId: number, newParentId: number | null): { success: boolean; error?: string } {
  const db = getDb();
  const group = db.prepare(
    `SELECT source_kind FROM album_groups WHERE id = ?`
  ).get(groupId) as { source_kind: 'auto' | 'user' } | undefined;
  if (!group) return { success: false, error: 'Folder not found.' };
  if (group.source_kind === 'auto') return { success: false, error: "Source folders can't be moved." };

  if (newParentId !== null) {
    if (newParentId === groupId) return { success: false, error: "Can't move a folder into itself." };
    const parent = db.prepare(
      `SELECT source_kind FROM album_groups WHERE id = ?`
    ).get(newParentId) as { source_kind: 'auto' | 'user' } | undefined;
    if (!parent) return { success: false, error: 'Destination folder not found.' };
    if (parent.source_kind === 'auto') return { success: false, error: "Can't move folders into source folders." };

    // Cycle check — walk newParentId up; if we hit groupId, the move
    // would create a loop in the tree.
    let cursor: number | null = newParentId;
    for (let i = 0; i < 16 && cursor !== null; i++) {
      if (cursor === groupId) return { success: false, error: "Can't move a folder into one of its own sub-folders." };
      const up = db.prepare(`SELECT parent_id FROM album_groups WHERE id = ?`).get(cursor) as { parent_id: number | null } | undefined;
      cursor = up?.parent_id ?? null;
    }

    // Depth check — after the move, the moved group lives at
    // (parentDepth + 1) and its deepest descendant lives at
    // (parentDepth + 1 + subtreeDepth). Refuse if that exceeds the
    // cap.
    const parentDepth = getAlbumGroupDepth(newParentId);
    const subtreeDepth = getAlbumGroupSubtreeDepth(groupId);
    if (parentDepth + 1 + subtreeDepth > USER_GROUP_MAX_DEPTH) {
      return { success: false, error: 'Move would nest folders past the depth limit.' };
    }
  }

  db.prepare(
    `UPDATE album_groups SET parent_id = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(newParentId, groupId);
  return { success: true };
}

/**
 * Add an album to a user folder. INSERT OR IGNORE so drag-drop is
 * idempotent. Refuses adds to auto groups — those memberships are
 * managed by the system. Returns whether a NEW row was inserted so
 * the renderer can distinguish "added 1" from "already there".
 */
export function addAlbumToGroup(albumId: number, groupId: number): { success: boolean; inserted: boolean; error?: string } {
  const db = getDb();
  const group = db.prepare(
    `SELECT source_kind FROM album_groups WHERE id = ?`
  ).get(groupId) as { source_kind: 'auto' | 'user' } | undefined;
  if (!group) return { success: false, inserted: false, error: 'Folder not found.' };
  if (group.source_kind === 'auto') {
    return { success: false, inserted: false, error: "Albums can't be added to source folders manually." };
  }
  const result = db.prepare(
    `INSERT OR IGNORE INTO album_group_memberships (album_id, group_id, is_auto) VALUES (?, ?, 0)`
  ).run(albumId, groupId);
  db.prepare(`UPDATE album_groups SET updated_at = datetime('now') WHERE id = ?`).run(groupId);
  return { success: true, inserted: result.changes > 0 };
}

/**
 * Remove an album from a user folder. Refuses removing the auto-
 * source membership (UI hides this affordance anyway, but enforce
 * here too — the source identity is factual, not editable).
 */
export function removeAlbumFromGroup(albumId: number, groupId: number): { success: boolean; error?: string } {
  const db = getDb();
  const membership = db.prepare(
    `SELECT is_auto FROM album_group_memberships WHERE album_id = ? AND group_id = ?`
  ).get(albumId, groupId) as { is_auto: 0 | 1 } | undefined;
  if (!membership) return { success: false, error: 'Membership not found.' };
  if (membership.is_auto === 1) {
    return { success: false, error: "Source memberships can't be removed." };
  }
  db.prepare(`DELETE FROM album_group_memberships WHERE album_id = ? AND group_id = ?`).run(albumId, groupId);
  db.prepare(`UPDATE album_groups SET updated_at = datetime('now') WHERE id = ?`).run(groupId);
  return { success: true };
}
