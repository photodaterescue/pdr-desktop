import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
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
  aiProcessed?: 'all' | 'unprocessed' | 'faces_only' | 'tags_only' | 'both';
  faceCountMin?: number;
  faceCountMax?: number;
  personTogetherIds?: number[];
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

    // ─── Pre-open backup ────────────────────────────────────────
    // Snapshot the live DB to a rolling backup before we open it.
    // Keeps 5 rotating backups (backup-0 newest, backup-4 oldest) so
    // if a bug destroys user data, we have a recent copy to restore
    // from. Cheap: copy only happens once at startup, file-system
    // level, no SQLite traffic.
    try {
      if (fs.existsSync(dbPath)) {
        const backupDir = path.join(path.dirname(dbPath), 'backups');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        // Rotate: shift backup-3 → backup-4, ..., backup-0 → backup-1.
        for (let i = 3; i >= 0; i--) {
          const src = path.join(backupDir, `pdr-search.backup-${i}.db`);
          const dst = path.join(backupDir, `pdr-search.backup-${i + 1}.db`);
          if (fs.existsSync(src)) fs.copyFileSync(src, dst);
        }
        fs.copyFileSync(dbPath, path.join(backupDir, 'pdr-search.backup-0.db'));
      }
    } catch (backupErr) {
      console.warn('[DB] Startup backup failed (non-fatal):', backupErr);
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
    `);

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

    // Normalise any legacy double-backslash destination paths
    db.exec(`UPDATE indexed_runs SET destination_path = REPLACE(destination_path, '\\\\', '\\') WHERE destination_path LIKE '%\\\\%'`);

    // Clean up orphaned indexed_files rows left from runs deleted before foreign_keys was enabled
    db.exec(`DELETE FROM indexed_files WHERE run_id NOT IN (SELECT id FROM indexed_runs)`);
    // Clean up orphaned AI data for files that no longer exist
    db.exec(`DELETE FROM ai_processing_status WHERE file_id NOT IN (SELECT id FROM indexed_files)`);
    db.exec(`DELETE FROM face_detections WHERE file_id NOT IN (SELECT id FROM indexed_files)`);
    db.exec(`DELETE FROM ai_tags WHERE file_id NOT IN (SELECT id FROM indexed_files)`);

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

    return { success: true };
  } catch (err) {
    console.error('Failed to initialise search database:', err);
    return { success: false, error: (err as Error).message };
  }
}

export function getDb(): Database.Database {
  if (!db) {
    const result = initDatabase();
    if (!result.success) {
      throw new Error(`Database not initialised: ${result.error}`);
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

  const conditions: string[] = [];
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
      SELECT fd.file_id FROM face_detections fd JOIN persons p ON fd.person_id = p.id WHERE LOWER(p.name) LIKE ?
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

  // Camera make
  if (query.cameraMake && query.cameraMake.length > 0) {
    conditions.push(`f.camera_make IN (${query.cameraMake.map(() => '?').join(',')})`);
    params.push(...query.cameraMake);
  }

  // Camera model
  if (query.cameraModel && query.cameraModel.length > 0) {
    conditions.push(`f.camera_model IN (${query.cameraModel.map(() => '?').join(',')})`);
    params.push(...query.cameraModel);
  }

  // GPS filter
  if (query.hasGps === true) {
    conditions.push(`f.gps_lat IS NOT NULL AND f.gps_lon IS NOT NULL`);
  } else if (query.hasGps === false) {
    conditions.push(`(f.gps_lat IS NULL OR f.gps_lon IS NULL)`);
  }

  // Country filter
  if (query.country && query.country.length > 0) {
    conditions.push(`f.geo_country IN (${query.country.map(() => '?').join(',')})`);
    params.push(...query.country);
  }

  // City filter
  if (query.city && query.city.length > 0) {
    conditions.push(`f.geo_city IN (${query.city.map(() => '?').join(',')})`);
    params.push(...query.city);
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

  // Lens model
  if (query.lensModel && query.lensModel.length > 0) {
    conditions.push(`f.lens_model IN (${query.lensModel.map(() => '?').join(',')})`);
    params.push(...query.lensModel);
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

  // AI: Person + Tag filters. Rendered as two SQL fragments first so we
  // can decide at the end whether to AND them into separate conditions
  // (default) or OR them into a single compound condition (used when the
  // user types "Mel, beach" — they want photos that match either).
  const personFragment = (() => {
    if (!query.personId || query.personId.length === 0) return null;
    const ph = query.personId.map(() => '?').join(',');
    if (query.personIdMode === 'and' && query.personId.length > 1) {
      return {
        sql: `f.id IN (SELECT fd.file_id FROM face_detections fd WHERE fd.person_id IN (${ph}) GROUP BY fd.file_id HAVING COUNT(DISTINCT fd.person_id) = ?)`,
        params: [...query.personId, query.personId.length],
      };
    }
    return {
      sql: `f.id IN (SELECT file_id FROM face_detections WHERE person_id IN (${ph}))`,
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

  const confidences = (database.prepare(`SELECT DISTINCT confidence FROM indexed_files ORDER BY confidence`).all() as { confidence: string }[]).map(r => r.confidence);
  const fileTypes = (database.prepare(`SELECT DISTINCT file_type FROM indexed_files ORDER BY file_type`).all() as { file_type: string }[]).map(r => r.file_type);
  const dateSources = (database.prepare(`SELECT DISTINCT date_source FROM indexed_files WHERE date_source != '' ORDER BY date_source`).all() as { date_source: string }[]).map(r => r.date_source);
  const years = (database.prepare(`SELECT DISTINCT year FROM indexed_files WHERE year IS NOT NULL ORDER BY year`).all() as { year: number }[]).map(r => r.year);
  const cameraMakes = (database.prepare(`SELECT DISTINCT camera_make FROM indexed_files WHERE camera_make IS NOT NULL ORDER BY camera_make`).all() as { camera_make: string }[]).map(r => r.camera_make);
  const cameraModels = (database.prepare(`SELECT DISTINCT camera_model FROM indexed_files WHERE camera_model IS NOT NULL ORDER BY camera_model`).all() as { camera_model: string }[]).map(r => r.camera_model);
  const lensModels = (database.prepare(`SELECT DISTINCT lens_model FROM indexed_files WHERE lens_model IS NOT NULL ORDER BY lens_model`).all() as { lens_model: string }[]).map(r => r.lens_model);
  const extensions = (database.prepare(`SELECT DISTINCT extension FROM indexed_files ORDER BY extension`).all() as { extension: string }[]).map(r => r.extension);
  const sceneCaptureTypes = (database.prepare(`SELECT DISTINCT scene_capture_type FROM indexed_files WHERE scene_capture_type IS NOT NULL ORDER BY scene_capture_type`).all() as { scene_capture_type: string }[]).map(r => r.scene_capture_type);
  const exposurePrograms = (database.prepare(`SELECT DISTINCT exposure_program FROM indexed_files WHERE exposure_program IS NOT NULL ORDER BY exposure_program`).all() as { exposure_program: string }[]).map(r => r.exposure_program);
  const whiteBalances = (database.prepare(`SELECT DISTINCT white_balance FROM indexed_files WHERE white_balance IS NOT NULL ORDER BY white_balance`).all() as { white_balance: string }[]).map(r => r.white_balance);
  const cameraPositions = (database.prepare(`SELECT DISTINCT camera_position FROM indexed_files WHERE camera_position IS NOT NULL ORDER BY camera_position`).all() as { camera_position: string }[]).map(r => r.camera_position);
  const orientations = (database.prepare(`SELECT DISTINCT orientation FROM indexed_files WHERE orientation IS NOT NULL ORDER BY orientation`).all() as { orientation: string }[]).map(r => r.orientation);
  const countries = (database.prepare(`SELECT DISTINCT geo_country FROM indexed_files WHERE geo_country IS NOT NULL ORDER BY geo_country`).all() as { geo_country: string }[]).map(r => r.geo_country);
  const cities = (database.prepare(`SELECT DISTINCT geo_city FROM indexed_files WHERE geo_city IS NOT NULL ORDER BY geo_city`).all() as { geo_city: string }[]).map(r => r.geo_city);
  const rawDestinations = (database.prepare(`SELECT DISTINCT destination_path FROM indexed_runs ORDER BY destination_path`).all() as { destination_path: string }[]).map(r => r.destination_path);
  // Normalise and deduplicate (handles legacy double-backslash entries)
  const destinations = [...new Set(rawDestinations.map(d => d.replace(/\\\\/g, '\\').replace(/\\$/, '')))];
  const runs = database.prepare(`SELECT id, report_id, destination_path, indexed_at, file_count FROM indexed_runs ORDER BY indexed_at DESC`).all() as FilterOptions['runs'];

  return { confidences, fileTypes, lensModels, dateSources, years, cameraMakes, cameraModels, extensions, sceneCaptureTypes, exposurePrograms, whiteBalances, cameraPositions, orientations, countries, cities, destinations, runs };
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
  name: string;
  avatar_data: string | null;
  photo_count?: number;
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
    WHERE fd.file_id = ?
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
    WHERE fd.file_id = ?
  `).all(fileId) as { name: string }[])
    .map(r => r.name).join(' ');

  // Delete existing entry, then insert
  database.prepare(`INSERT INTO files_ai_fts(files_ai_fts, rowid, ai_tags, person_names) VALUES ('delete', ?, '', '')`).run(fileId);
  if (tags || persons) {
    database.prepare(`INSERT INTO files_ai_fts(rowid, ai_tags, person_names) VALUES (?, ?, ?)`).run(fileId, tags, persons);
  }
}

/** Get all face detections for a file */
export function getFacesForFile(fileId: number): (FaceDetectionRecord & { person_name?: string })[] {
  const database = getDb();
  return database.prepare(`
    SELECT fd.*, p.name as person_name
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

/** List all active (non-discarded) persons with photo counts */
export function listPersons(): PersonRecord[] {
  const database = getDb();
  return database.prepare(`
    SELECT p.*, COUNT(DISTINCT fd.file_id) as photo_count
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
export function upsertPerson(name: string, avatarData?: string): number {
  const database = getDb();
  const existing = database.prepare(`SELECT id FROM persons WHERE name = ? COLLATE NOCASE`).get(name) as { id: number } | undefined;
  if (existing) {
    // Clear discarded_at in case this person was previously discarded
    database.prepare(`UPDATE persons SET discarded_at = NULL WHERE id = ? AND discarded_at IS NOT NULL`).run(existing.id);
    return existing.id;
  }
  const result = database.prepare(`INSERT INTO persons (name, avatar_data) VALUES (?, ?)`).run(name, avatarData ?? null);
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

export function verifyFace(faceId: number): void {
  const database = getDb();
  database.prepare(`UPDATE face_detections SET verified = 1 WHERE id = ?`).run(faceId);
}

/** Get all faces for a person or unnamed cluster, paginated, sorted by confidence ASC (lowest first) */
export function getClusterFaces(clusterId: number, page: number = 0, perPage: number = 40, personId?: number): { faces: { face_id: number; file_id: number; file_path: string; box_x: number; box_y: number; box_w: number; box_h: number; confidence: number; verified: number }[]; total: number; page: number; perPage: number; totalPages: number } {
  const database = getDb();
  // If personId is provided, query by person (handles reassigned faces correctly)
  if (personId) {
    const total = (database.prepare(`SELECT COUNT(*) as cnt FROM face_detections WHERE person_id = ?`).get(personId) as any).cnt;
    const faces = database.prepare(`
      SELECT fd.id as face_id, fd.file_id, f.file_path, fd.box_x, fd.box_y, fd.box_w, fd.box_h, fd.confidence, fd.verified
      FROM face_detections fd
      INNER JOIN indexed_files f ON fd.file_id = f.id
      WHERE fd.person_id = ?
      ORDER BY fd.confidence ASC
      LIMIT ? OFFSET ?
    `).all(personId, perPage, page * perPage) as any[];
    return { faces, total, page, perPage, totalPages: Math.ceil(total / perPage) };
  }
  // For unnamed clusters: only show faces with no person_id
  const total = (database.prepare(`SELECT COUNT(*) as cnt FROM face_detections WHERE cluster_id = ? AND person_id IS NULL`).get(clusterId) as any).cnt;
  const faces = database.prepare(`
    SELECT fd.id as face_id, fd.file_id, f.file_path, fd.box_x, fd.box_y, fd.box_w, fd.box_h, fd.confidence, fd.verified
    FROM face_detections fd
    INNER JOIN indexed_files f ON fd.file_id = f.id
    WHERE fd.cluster_id = ? AND fd.person_id IS NULL
    ORDER BY fd.confidence ASC
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
    WHERE fd.embedding IS NOT NULL AND fd.id != ?
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
export function renamePerson(personId: number, newName: string): void {
  const database = getDb();
  // Check if the new name already exists as a different person
  const existing = database.prepare(`SELECT id FROM persons WHERE name = ? COLLATE NOCASE AND id != ?`).get(newName, personId) as { id: number } | undefined;
  if (existing) {
    // Merge into the existing person with that name
    mergePersons(existing.id, personId);
  } else {
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
 * Soft-delete (discard) a person — unlinks all their faces and marks the person as discarded.
 * The person record is kept so the name can be restored or permanently deleted later.
 */
export function discardPerson(personId: number): { facesUnlinked: number; photosAffected: number } {
  const database = getDb();
  const photosAffected = (database.prepare(
    `SELECT COUNT(DISTINCT file_id) as cnt FROM face_detections WHERE person_id = ?`
  ).get(personId) as { cnt: number }).cnt;
  const result = database.prepare(`UPDATE face_detections SET person_id = NULL WHERE person_id = ?`).run(personId);
  database.prepare(`UPDATE persons SET discarded_at = datetime('now') WHERE id = ?`).run(personId);
  return { facesUnlinked: result.changes, photosAffected };
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

/** Get a person by ID */
export function getPersonById(personId: number): PersonRecord | null {
  const database = getDb();
  const row = database.prepare(`
    SELECT p.*, COUNT(DISTINCT fd.file_id) as photo_count
    FROM persons p
    LEFT JOIN face_detections fd ON fd.person_id = p.id
    WHERE p.id = ?
    GROUP BY p.id
  `).get(personId) as PersonRecord | undefined;
  return row ?? null;
}

/** Get all face embeddings for clustering */
export function getAllFaceEmbeddings(): { id: number; file_id: number; embedding: Buffer; cluster_id: number | null }[] {
  const database = getDb();
  return database.prepare(`SELECT id, file_id, embedding, cluster_id FROM face_detections WHERE embedding IS NOT NULL`).all() as any[];
}

/**
 * Refine facial recognition by computing per-person average embeddings
 * from verified faces, then matching unnamed faces against those averages.
 *
 * Processes persons in descending order of verified face count (most populous first).
 * Returns stats about what was done.
 */
export function refineFromVerifiedFaces(similarityThreshold: number = 0.72): {
  personsProcessed: number;
  newMatches: number;
  perPerson: { personId: number; personName: string; verifiedCount: number; matched: number }[];
} {
  const database = getDb();

  // Get all real named persons with their verified face counts, most populous first
  const persons = database.prepare(`
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

  for (const person of persons) {
    // Get verified embeddings for this person
    const verifiedRows = database.prepare(`
      SELECT embedding FROM face_detections
      WHERE person_id = ? AND verified = 1 AND embedding IS NOT NULL
    `).all(person.id) as { embedding: Buffer }[];

    if (verifiedRows.length === 0) {
      perPerson.push({ personId: person.id, personName: person.name, verifiedCount: 0, matched: 0 });
      continue;
    }

    // Compute average embedding
    const firstVec = new Float32Array(verifiedRows[0].embedding.buffer, verifiedRows[0].embedding.byteOffset, verifiedRows[0].embedding.byteLength / 4);
    const dim = firstVec.length;
    const avg = new Float32Array(dim);
    for (const row of verifiedRows) {
      const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      for (let i = 0; i < dim; i++) avg[i] += vec[i];
    }
    for (let i = 0; i < dim; i++) avg[i] /= verifiedRows.length;

    // Get all unnamed faces (person_id IS NULL) with embeddings
    const unnamed = database.prepare(`
      SELECT id, embedding FROM face_detections
      WHERE person_id IS NULL AND embedding IS NOT NULL
    `).all() as { id: number; embedding: Buffer }[];

    let matchedForThisPerson = 0;
    const assignStmt = database.prepare(`UPDATE face_detections SET person_id = ? WHERE id = ?`);
    const avgMag = Math.sqrt(avg.reduce((s, v) => s + v * v, 0));

    for (const row of unnamed) {
      const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      // Cosine similarity
      let dot = 0, magB = 0;
      for (let i = 0; i < dim; i++) {
        dot += avg[i] * vec[i];
        magB += vec[i] * vec[i];
      }
      const mag = avgMag * Math.sqrt(magB);
      const sim = mag === 0 ? 0 : dot / mag;
      if (sim >= similarityThreshold) {
        assignStmt.run(person.id, row.id);
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
  }

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

/** Get all face clusters with representative face data for the People management view */
export function getPersonClusters(): { cluster_id: number; person_id: number | null; person_name: string | null; face_count: number; photo_count: number; representative_face_id: number; representative_file_id: number; representative_file_path: string; box_x: number; box_y: number; box_w: number; box_h: number; sample_faces: { face_id: number; file_id: number; file_path: string; box_x: number; box_y: number; box_w: number; box_h: number; confidence: number; verified: number }[] }[] {
  const database = getDb();

  // Named clusters: group by person_id (so individually reassigned faces appear under their new person)
  // For special categories (__ignored__, __unsure__), group by cluster_id to keep original clusters separate
  const realNamedClusters = database.prepare(`
    SELECT
      fd.cluster_id,
      p.id as person_id,
      p.name as person_name,
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

  // For named: prefer user-chosen representative, fall back to highest confidence
  const repByPersonChosenStmt = database.prepare(`
    SELECT fd.id as face_id, fd.file_id, f.file_path, fd.box_x, fd.box_y, fd.box_w, fd.box_h, fd.confidence
    FROM face_detections fd
    INNER JOIN indexed_files f ON fd.file_id = f.id
    INNER JOIN persons p ON p.id = ?
    WHERE fd.id = p.representative_face_id
    LIMIT 1
  `);
  const repByPersonAutoStmt = database.prepare(`
    SELECT fd.id as face_id, fd.file_id, f.file_path, fd.box_x, fd.box_y, fd.box_w, fd.box_h, fd.confidence
    FROM face_detections fd
    INNER JOIN indexed_files f ON fd.file_id = f.id
    WHERE fd.person_id = ?
    ORDER BY fd.confidence DESC
    LIMIT 1
  `);
  // For unnamed: representative face is the highest confidence face in that cluster (with no person)
  const repByClusterStmt = database.prepare(`
    SELECT fd.id as face_id, fd.file_id, f.file_path, fd.box_x, fd.box_y, fd.box_w, fd.box_h, fd.confidence
    FROM face_detections fd
    INNER JOIN indexed_files f ON fd.file_id = f.id
    WHERE fd.cluster_id = ? AND fd.person_id IS NULL
    ORDER BY fd.confidence DESC
    LIMIT 1
  `);
  // Sample faces for named: by person_id
  const facesByPersonStmt = database.prepare(`
    SELECT fd.id as face_id, fd.file_id, f.file_path, fd.box_x, fd.box_y, fd.box_w, fd.box_h, fd.confidence, fd.verified
    FROM face_detections fd
    INNER JOIN indexed_files f ON fd.file_id = f.id
    WHERE fd.person_id = ?
    ORDER BY fd.confidence ASC
  `);
  // Sample faces for unnamed: by cluster_id (only unassigned)
  const facesByClusterStmt = database.prepare(`
    SELECT fd.id as face_id, fd.file_id, f.file_path, fd.box_x, fd.box_y, fd.box_w, fd.box_h, fd.confidence, fd.verified
    FROM face_detections fd
    INNER JOIN indexed_files f ON fd.file_id = f.id
    WHERE fd.cluster_id = ? AND fd.person_id IS NULL
    ORDER BY fd.confidence ASC
  `);
  // Sample faces for special categories: by cluster_id AND person_id
  const facesByClusterWithPersonStmt = database.prepare(`
    SELECT fd.id as face_id, fd.file_id, f.file_path, fd.box_x, fd.box_y, fd.box_w, fd.box_h, fd.confidence, fd.verified
    FROM face_detections fd
    INNER JOIN indexed_files f ON fd.file_id = f.id
    WHERE fd.cluster_id = ? AND fd.person_id = ?
    ORDER BY fd.confidence ASC
  `);
  // Representative for special categories: by cluster_id AND person_id
  const repByClusterWithPersonStmt = database.prepare(`
    SELECT fd.id as face_id, fd.file_id, f.file_path, fd.box_x, fd.box_y, fd.box_w, fd.box_h, fd.confidence
    FROM face_detections fd
    INNER JOIN indexed_files f ON fd.file_id = f.id
    WHERE fd.cluster_id = ? AND fd.person_id = ?
    ORDER BY fd.confidence DESC
    LIMIT 1
  `);

  return clusters.map((c: any) => {
    const isNamed = c.person_id != null;
    const isSpecial = isNamed && (c.person_name === '__ignored__' || c.person_name === '__unsure__');
    const rep = isSpecial
      ? (repByClusterWithPersonStmt.get(c.cluster_id, c.person_id) as any || {})
      : isNamed
        ? ((repByPersonChosenStmt.get(c.person_id) as any) || (repByPersonAutoStmt.get(c.person_id) as any) || {})
        : (repByClusterStmt.get(c.cluster_id) as any || {});
    const samples = isSpecial
      ? (facesByClusterWithPersonStmt.all(c.cluster_id, c.person_id) as any[])
      : isNamed
        ? (facesByPersonStmt.all(c.person_id) as any[])
        : (facesByClusterStmt.all(c.cluster_id) as any[]);
    return {
      cluster_id: c.cluster_id,
      person_id: c.person_id,
      person_name: c.person_name,
      face_count: c.face_count,
      photo_count: c.photo_count,
      representative_face_id: rep.face_id || c.representative_face_id,
      representative_file_id: rep.file_id,
      representative_file_path: rep.file_path || '',
      box_x: rep.box_x || 0,
      box_y: rep.box_y || 0,
      box_w: rep.box_w || 0,
      box_h: rep.box_h || 0,
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
 * Purge duplicate indexed_runs pointing to the same destination_path.
 * Keeps only the newest run (MAX id) per destination_path.
 * Older duplicate runs and their associated files/AI data are CASCADE-deleted.
 * This handles the scenario where a user deletes a destination, recreates it, and re-indexes —
 * the old run record would otherwise persist forever as a zombie.
 * Returns the number of duplicate runs removed.
 */
export function purgeDuplicateRuns(): number {
  const database = getDb();

  // Find run IDs to delete: for each destination_path with multiple runs, keep only the newest
  const duplicateRuns = database.prepare(`
    SELECT id FROM indexed_runs
    WHERE id NOT IN (
      SELECT MAX(id) FROM indexed_runs GROUP BY destination_path
    )
  `).all() as { id: number }[];

  if (duplicateRuns.length === 0) return 0;

  // Delete each duplicate run — CASCADE will clean up indexed_files and AI data
  const deleteStmt = database.prepare(`DELETE FROM indexed_runs WHERE id = ?`);
  const deleteTx = database.transaction(() => {
    for (const run of duplicateRuns) {
      deleteStmt.run(run.id);
    }
  });
  deleteTx();

  console.log(`[DB Cleanup] Purged ${duplicateRuns.length} duplicate indexed_runs (kept newest per destination_path)`);
  return duplicateRuns.length;
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
export function purgeStaleIndexedFiles(): { removed: number; checked: number } {
  const database = getDb();

  // Get all unique file paths
  const rows = database.prepare(`SELECT id, file_path FROM indexed_files`).all() as { id: number; file_path: string }[];
  const staleIds: number[] = [];

  for (const row of rows) {
    if (!fs.existsSync(row.file_path)) {
      staleIds.push(row.id);
    }
  }

  if (staleIds.length > 0) {
    // Delete in batches of 500 to avoid SQLite variable limits
    const batchSize = 500;
    for (let i = 0; i < staleIds.length; i += batchSize) {
      const batch = staleIds.slice(i, i + batchSize);
      const placeholders = batch.map(() => '?').join(',');
      database.prepare(`DELETE FROM indexed_files WHERE id IN (${placeholders})`).run(...batch);
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
export function purgeGhostRuns(): { autoRemoved: number; promptUser: IndexedRun[] } {
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
  const rows = database.prepare(`
    SELECT
      year,
      month,
      SUM(CASE WHEN file_type = 'photo' THEN 1 ELSE 0 END) AS photoCount,
      SUM(CASE WHEN file_type = 'video' THEN 1 ELSE 0 END) AS videoCount,
      -- Pick a stable sample file per bucket (lowest id = earliest indexed).
      (SELECT f2.file_path FROM indexed_files f2
         WHERE f2.year = f.year AND f2.month = f.month ${inner.sql}
         ORDER BY f2.id ASC LIMIT 1) AS sampleFilePath,
      (SELECT f2.id FROM indexed_files f2
         WHERE f2.year = f.year AND f2.month = f.month ${inner.sql}
         ORDER BY f2.id ASC LIMIT 1) AS sampleFileId
    FROM indexed_files f
    WHERE year IS NOT NULL AND month IS NOT NULL ${outer.sql}
    GROUP BY year, month
    ORDER BY year DESC, month DESC
  `).all(...inner.params, ...inner.params, ...outer.params) as MemoriesYearBucket[];
  return rows;
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
    ORDER BY year DESC, derived_date DESC
    LIMIT ?
  `).all(...params) as MemoriesOnThisDayItem[];
}

/**
 * Fetch every file taken on a specific calendar date, optionally scoped to a
 * set of runs. Used for the day-drill-down grid.
 */
export function getMemoriesDayFiles(year: number, month: number, day: number, runIds?: number[]): IndexedFile[] {
  const database = getDb();
  const clause = runIdsClause(runIds);
  const params: any[] = [year, month, day, ...clause.params];
  return database.prepare(`
    SELECT * FROM indexed_files
    WHERE year = ? AND month = ? AND day = ? ${clause.sql}
    ORDER BY derived_date ASC, id ASC
  `).all(...params) as IndexedFile[];
}

export function runDatabaseCleanup(): {
  staleRuns: IndexedRun[];
  duplicateRunsRemoved: number;
  duplicatesRemoved: number;
  staleRemoved: number;
  totalChecked: number;
  orphanRunsRemoved: number;
  ghostRunsRemoved: number;
} {
  // Step 1: Remove duplicate runs for the same destination_path (keeps newest)
  const dupeRuns = purgeDuplicateRuns();

  // Step 2: Remove duplicate file entries (same file_path across runs, keeps newest)
  const dupes = purgeDuplicateIndexedFiles();

  // Step 3: Remove file entries where the actual file no longer exists on disk
  const stale = purgeStaleIndexedFiles();

  // Step 4: Remove runs that now have zero files (orphaned by steps 2-3)
  const orphans = purgeOrphanRuns();

  // Step 5: Direct ghost-run cleanup — destination folder doesn't exist
  //   Auto-removes runs where folder AND all files are gone (nothing to preserve)
  //   Returns runs for StaleRunsModal where folder is gone but files may be relocatable
  const ghosts = purgeGhostRuns();

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
  | { kind: 'update'; personAId: number; personBId: number; type: RelationshipType; patch: Partial<RelationshipRecord> };

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

/** All relationships touching a person (as either endpoint). */
export function listRelationshipsForPerson(personId: number): RelationshipRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM relationships
    WHERE person_a_id = ? OR person_b_id = ?
    ORDER BY type, since
  `).all(personId, personId) as RelationshipRow[];
  return rows.map(rowToRelationship);
}

/** Every relationship in the database. Used for full-tree rendering. */
export function listAllRelationships(): RelationshipRecord[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM relationships ORDER BY id`).all() as RelationshipRow[];
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
  name: string;
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
  hopsFromFocus: number;
  photoCount: number;
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

  const neighbourStmt = db.prepare(`
    SELECT * FROM relationships
    WHERE person_a_id = ? OR person_b_id = ?
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
      SELECT * FROM relationships
      WHERE person_a_id IN (${qs}) AND person_b_id IN (${qs})
    `).all(...visitedIds, ...visitedIds) as RelationshipRow[];
    for (const row of boundary) {
      if (seenEdgeIds.has(row.id)) continue;
      seenEdgeIds.add(row.id);
      collectedEdges.push(rowToRelationship(row));
    }
  }

  // Pull person details for every reachable node, plus photo counts.
  const ids = Array.from(visited.keys());
  const placeholders = ids.map(() => '?').join(',');
  const personRows = db.prepare(`
    SELECT id, name, avatar_data, representative_face_id,
           birth_date, death_date, deceased_marker,
           COALESCE(is_placeholder, 0) AS is_placeholder
    FROM persons
    WHERE id IN (${placeholders})
  `).all(...ids) as PersonRow[];

  const photoCountRows = db.prepare(`
    SELECT person_id, COUNT(DISTINCT file_id) AS photo_count
    FROM face_detections
    WHERE person_id IN (${placeholders})
    GROUP BY person_id
  `).all(...ids) as { person_id: number; photo_count: number }[];
  const photoCountByPerson = new Map<number, number>();
  for (const r of photoCountRows) photoCountByPerson.set(r.person_id, r.photo_count);

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
      avatarData: row.avatar_data,
      representativeFaceId: row.representative_face_id,
      representativeFaceFilePath: face ? face.file_path : null,
      representativeFaceBox: face ? { x: face.box_x, y: face.box_y, w: face.box_w, h: face.box_h } : null,
      birthDate: row.birth_date,
      deathDate: row.death_date,
      deceasedMarker: row.deceased_marker,
      hopsFromFocus: visited.get(row.id) ?? maxHops,
      photoCount: photoCountByPerson.get(row.id) ?? 0,
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
  last_opened_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToSavedTree(row: SavedTreeRow): SavedTreeRecord {
  return {
    id: row.id,
    name: row.name,
    focusPersonId: row.focus_person_id,
    stepsEnabled: row.steps_enabled === 1,
    stepsDepth: row.steps_depth,
    generationsEnabled: row.generations_enabled === 1,
    ancestorsDepth: row.ancestors_depth,
    descendantsDepth: row.descendants_depth,
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
  if (patch.markOpened)                 { sets.push(`last_opened_at = datetime('now')`); }
  sets.push(`updated_at = datetime('now')`);

  db.prepare(`UPDATE saved_trees SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  const record = getSavedTree(id);
  return record ? { success: true, data: record } : { success: false, error: 'Update failed.' };
}

export function deleteSavedTree(id: number): { success: boolean; error?: string } {
  const db = getDb();
  db.prepare(`DELETE FROM saved_trees WHERE id = ?`).run(id);
  return { success: true };
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
