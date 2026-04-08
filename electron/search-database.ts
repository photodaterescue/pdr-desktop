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
  aiTag?: string[];
  hasFaces?: boolean;
  hasUnnamedFaces?: boolean;
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

    // Normalise any legacy double-backslash destination paths
    db.exec(`UPDATE indexed_runs SET destination_path = REPLACE(destination_path, '\\\\', '\\') WHERE destination_path LIKE '%\\\\%'`);

    // Clean up orphaned indexed_files rows left from runs deleted before foreign_keys was enabled
    db.exec(`DELETE FROM indexed_files WHERE run_id NOT IN (SELECT id FROM indexed_runs)`);
    // Clean up orphaned AI data for files that no longer exist
    db.exec(`DELETE FROM ai_processing_status WHERE file_id NOT IN (SELECT id FROM indexed_files)`);
    db.exec(`DELETE FROM face_detections WHERE file_id NOT IN (SELECT id FROM indexed_files)`);
    db.exec(`DELETE FROM ai_tags WHERE file_id NOT IN (SELECT id FROM indexed_files)`);

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
  `);

  const insertMany = database.transaction((rows: typeof files) => {
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

  return insertMany(files);
}

// ─── Search / Query ──────────────────────────────────────────────────────────

export function searchFiles(query: SearchQuery): SearchResult {
  const database = getDb();

  const conditions: string[] = [];
  const params: any[] = [];

  // Full-text search — queries both filename FTS and AI tags/person names FTS
  if (query.text && query.text.trim()) {
    const searchTerm = query.text.trim().replace(/['"]/g, '').split(/\s+/).map(t => `"${t}"*`).join(' ');
    conditions.push(`f.id IN (
      SELECT rowid FROM files_fts WHERE files_fts MATCH ?
      UNION
      SELECT rowid FROM files_ai_fts WHERE files_ai_fts MATCH ?
    )`);
    params.push(searchTerm, searchTerm);
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

  // AI: Person filter — photos containing specific named people
  if (query.personId && query.personId.length > 0) {
    conditions.push(`f.id IN (SELECT file_id FROM face_detections WHERE person_id IN (${query.personId.map(() => '?').join(',')}))`);
    params.push(...query.personId);
  }

  // AI: Tag filter — photos with specific AI tags
  if (query.aiTag && query.aiTag.length > 0) {
    conditions.push(`f.id IN (SELECT file_id FROM ai_tags WHERE tag IN (${query.aiTag.map(() => '?').join(',')}))`);
    params.push(...query.aiTag);
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

/** Insert AI tags for a file */
export function insertAiTags(tags: AiTagRecord[]): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO ai_tags (file_id, tag, confidence, source, model_ver)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertMany = database.transaction((items: AiTagRecord[]) => {
    for (const t of items) {
      stmt.run(t.file_id, t.tag, t.confidence, t.source, t.model_ver);
    }
  });
  insertMany(tags);
}

/** Rebuild AI FTS entry for a specific file */
export function rebuildAiFts(fileId: number): void {
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

/** List all persons with photo counts */
export function listPersons(): PersonRecord[] {
  const database = getDb();
  return database.prepare(`
    SELECT p.*, COUNT(DISTINCT fd.file_id) as photo_count
    FROM persons p
    LEFT JOIN face_detections fd ON fd.person_id = p.id
    GROUP BY p.id
    ORDER BY photo_count DESC
  `).all() as PersonRecord[];
}

/** Create or get a person by name */
export function upsertPerson(name: string, avatarData?: string): number {
  const database = getDb();
  const existing = database.prepare(`SELECT id FROM persons WHERE name = ? COLLATE NOCASE`).get(name) as { id: number } | undefined;
  if (existing) return existing.id;
  const result = database.prepare(`INSERT INTO persons (name, avatar_data) VALUES (?, ?)`).run(name, avatarData ?? null);
  return result.lastInsertRowid as number;
}

/** Assign a person to a face detection (and all faces in the same cluster) */
export function assignPersonToCluster(clusterId: number, personId: number): void {
  const database = getDb();
  database.prepare(`UPDATE face_detections SET person_id = ? WHERE cluster_id = ?`).run(personId, clusterId);
}

/** Assign a person to a single face detection */
export function assignPersonToFace(faceId: number, personId: number): void {
  const database = getDb();
  database.prepare(`UPDATE face_detections SET person_id = ? WHERE id = ?`).run(personId, faceId);
}

/** Get all face embeddings for clustering */
export function getAllFaceEmbeddings(): { id: number; file_id: number; embedding: Buffer; cluster_id: number | null }[] {
  const database = getDb();
  return database.prepare(`SELECT id, file_id, embedding, cluster_id FROM face_detections WHERE embedding IS NOT NULL`).all() as any[];
}

/** Update cluster assignments */
export function updateFaceCluster(faceId: number, clusterId: number): void {
  const database = getDb();
  database.prepare(`UPDATE face_detections SET cluster_id = ? WHERE id = ?`).run(clusterId, faceId);
}

/** Get distinct AI tags with counts for filter options */
export function getAiTagOptions(): { tag: string; count: number }[] {
  const database = getDb();
  return database.prepare(`
    SELECT tag, COUNT(DISTINCT file_id) as count
    FROM ai_tags
    WHERE confidence >= 0.3
    GROUP BY tag
    ORDER BY count DESC
  `).all() as any[];
}

/** Get AI processing stats */
export function getAiStats(): { totalProcessed: number; totalFaces: number; totalPersons: number; totalTags: number; unprocessed: number } {
  const database = getDb();
  const processed = (database.prepare(`SELECT COUNT(*) as cnt FROM ai_processing_status WHERE face_processed = 1 OR tags_processed = 1`).get() as any).cnt;
  const faces = (database.prepare(`SELECT COUNT(*) as cnt FROM face_detections`).get() as any).cnt;
  const persons = (database.prepare(`SELECT COUNT(*) as cnt FROM persons`).get() as any).cnt;
  const tags = (database.prepare(`SELECT COUNT(DISTINCT tag) as cnt FROM ai_tags`).get() as any).cnt;
  const totalPhotos = (database.prepare(`SELECT COUNT(*) as cnt FROM indexed_files f INNER JOIN indexed_runs r ON f.run_id = r.id WHERE f.file_type = 'photo'`).get() as any).cnt;
  return { totalProcessed: processed, totalFaces: faces, totalPersons: persons, totalTags: tags, unprocessed: Math.max(0, totalPhotos - processed) };
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
