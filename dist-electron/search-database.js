import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
// ─── Database singleton ──────────────────────────────────────────────────────
let db = null;
function getDbPath() {
    const dir = path.join(app.getPath('userData'), 'search-index');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, 'pdr-search.db');
}
export function initDatabase() {
    try {
        if (db)
            return { success: true };
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
        const cols = db.prepare(`PRAGMA table_info(indexed_files)`).all();
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
        const personCols = db.prepare(`PRAGMA table_info(persons)`).all();
        const personColNames = new Set(personCols.map(c => c.name));
        if (!personColNames.has('discarded_at')) {
            try {
                db.exec(`ALTER TABLE persons ADD COLUMN discarded_at TEXT`);
            }
            catch { }
        }
        // Migrate persons — add representative_face_id if missing (user-chosen avatar)
        if (!personColNames.has('representative_face_id')) {
            try {
                db.exec(`ALTER TABLE persons ADD COLUMN representative_face_id INTEGER`);
            }
            catch { }
        }
        // Migrate face_detections — add verified column if missing
        const faceCols = db.prepare(`PRAGMA table_info(face_detections)`).all();
        const faceColNames = new Set(faceCols.map(c => c.name));
        if (!faceColNames.has('verified')) {
            try {
                db.exec(`ALTER TABLE face_detections ADD COLUMN verified INTEGER NOT NULL DEFAULT 0`);
            }
            catch { }
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
    }
    catch (err) {
        console.error('Failed to initialise search database:', err);
        return { success: false, error: err.message };
    }
}
export function getDb() {
    if (!db) {
        const result = initDatabase();
        if (!result.success) {
            throw new Error(`Database not initialised: ${result.error}`);
        }
    }
    return db;
}
export function closeDatabase() {
    if (db) {
        db.close();
        db = null;
    }
}
// ─── Run management ──────────────────────────────────────────────────────────
export function insertRun(reportId, destinationPath, sourceLabels) {
    const database = getDb();
    // Normalise path: resolve double backslashes and trailing slashes
    const normalised = destinationPath.replace(/\\\\/g, '\\').replace(/\\$/, '');
    const stmt = database.prepare(`INSERT INTO indexed_runs (report_id, destination_path, source_labels) VALUES (?, ?, ?)`);
    const result = stmt.run(reportId, normalised, sourceLabels);
    return result.lastInsertRowid;
}
export function updateRunFileCount(runId, count) {
    const database = getDb();
    database.prepare(`UPDATE indexed_runs SET file_count = ? WHERE id = ?`).run(count, runId);
}
export function removeRun(runId) {
    const database = getDb();
    // CASCADE will delete indexed_files rows; FTS triggers will clean up FTS table
    database.prepare(`DELETE FROM indexed_runs WHERE id = ?`).run(runId);
}
export function removeRunByReportId(reportId) {
    const database = getDb();
    database.prepare(`DELETE FROM indexed_runs WHERE report_id = ?`).run(reportId);
}
export function getRun(runId) {
    const database = getDb();
    return database.prepare(`SELECT * FROM indexed_runs WHERE id = ?`).get(runId);
}
export function getRunByReportId(reportId) {
    const database = getDb();
    return database.prepare(`SELECT * FROM indexed_runs WHERE report_id = ?`).get(reportId);
}
export function listRuns() {
    const database = getDb();
    return database.prepare(`SELECT * FROM indexed_runs ORDER BY indexed_at DESC`).all();
}
// ─── File insertion (batch) ──────────────────────────────────────────────────
export function insertFiles(runId, files) {
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
    const insertMany = database.transaction((rows) => {
        let count = 0;
        for (const f of rows) {
            stmt.run(runId, f.file_path, f.filename, f.extension, f.file_type, f.size_bytes, f.hash ?? null, f.confidence, f.date_source, f.original_filename, f.derived_date ?? null, f.year ?? null, f.month ?? null, f.day ?? null, f.camera_make ?? null, f.camera_model ?? null, f.lens_model ?? null, f.width ?? null, f.height ?? null, f.megapixels ?? null, f.iso ?? null, f.shutter_speed ?? null, f.aperture ?? null, f.focal_length ?? null, f.flash_fired ?? null, f.scene_capture_type ?? null, f.exposure_program ?? null, f.white_balance ?? null, f.orientation ?? null, f.camera_position ?? null, f.gps_lat ?? null, f.gps_lon ?? null, f.gps_alt ?? null, f.geo_country ?? null, f.geo_country_code ?? null, f.geo_city ?? null, f.exif_read_ok);
            count++;
        }
        return count;
    });
    return insertMany(files);
}
// ─── Search / Query ──────────────────────────────────────────────────────────
export function searchFiles(query) {
    const database = getDb();
    const conditions = [];
    const params = [];
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
    }
    else if (query.hasGps === false) {
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
    if (query.isoFrom != null) {
        conditions.push(`f.iso >= ?`);
        params.push(query.isoFrom);
    }
    if (query.isoTo != null) {
        conditions.push(`f.iso <= ?`);
        params.push(query.isoTo);
    }
    // Aperture range
    if (query.apertureFrom != null) {
        conditions.push(`f.aperture >= ?`);
        params.push(query.apertureFrom);
    }
    if (query.apertureTo != null) {
        conditions.push(`f.aperture <= ?`);
        params.push(query.apertureTo);
    }
    // Focal length range
    if (query.focalLengthFrom != null) {
        conditions.push(`f.focal_length >= ?`);
        params.push(query.focalLengthFrom);
    }
    if (query.focalLengthTo != null) {
        conditions.push(`f.focal_length <= ?`);
        params.push(query.focalLengthTo);
    }
    // Flash fired
    if (query.flashFired === true) {
        conditions.push(`f.flash_fired = 1`);
    }
    else if (query.flashFired === false) {
        conditions.push(`f.flash_fired = 0`);
    }
    // Megapixels range
    if (query.megapixelsFrom != null) {
        conditions.push(`f.megapixels >= ?`);
        params.push(query.megapixelsFrom);
    }
    if (query.megapixelsTo != null) {
        conditions.push(`f.megapixels <= ?`);
        params.push(query.megapixelsTo);
    }
    // File size range (bytes)
    if (query.sizeFrom != null) {
        conditions.push(`f.size_bytes >= ?`);
        params.push(query.sizeFrom);
    }
    if (query.sizeTo != null) {
        conditions.push(`f.size_bytes <= ?`);
        params.push(query.sizeTo);
    }
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
    // AI: Person filter — 'and' = intersection (all selected people in same photo), 'or' = union (any)
    if (query.personId && query.personId.length > 0) {
        const placeholders = query.personId.map(() => '?').join(',');
        if (query.personIdMode === 'and' && query.personId.length > 1) {
            conditions.push(`f.id IN (SELECT fd.file_id FROM face_detections fd WHERE fd.person_id IN (${placeholders}) GROUP BY fd.file_id HAVING COUNT(DISTINCT fd.person_id) = ?)`);
            params.push(...query.personId, query.personId.length);
        }
        else {
            conditions.push(`f.id IN (SELECT file_id FROM face_detections WHERE person_id IN (${placeholders}))`);
            params.push(...query.personId);
        }
    }
    // AI: Tag filter — photos with specific AI tags
    if (query.aiTag && query.aiTag.length > 0) {
        conditions.push(`f.id IN (SELECT file_id FROM ai_tags WHERE tag IN (${query.aiTag.map(() => '?').join(',')}))`);
        params.push(...query.aiTag);
    }
    // AI: Has faces
    if (query.hasFaces === true) {
        conditions.push(`f.id IN (SELECT file_id FROM face_detections)`);
    }
    else if (query.hasFaces === false) {
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
    const totalRow = database.prepare(countSql).get(...params);
    // Fetch page (deduplicated)
    const selectSql = `SELECT f.* FROM indexed_files f ${whereDeduped} ORDER BY f.${sortBy} ${sortDir} LIMIT ? OFFSET ?`;
    const files = database.prepare(selectSql).all(...params, limit, offset);
    return {
        files,
        total: totalRow.total,
        limit,
        offset,
    };
}
// ─── Filter options (for dropdowns) ──────────────────────────────────────────
export function getFilterOptions() {
    const database = getDb();
    const confidences = database.prepare(`SELECT DISTINCT confidence FROM indexed_files ORDER BY confidence`).all().map(r => r.confidence);
    const fileTypes = database.prepare(`SELECT DISTINCT file_type FROM indexed_files ORDER BY file_type`).all().map(r => r.file_type);
    const dateSources = database.prepare(`SELECT DISTINCT date_source FROM indexed_files WHERE date_source != '' ORDER BY date_source`).all().map(r => r.date_source);
    const years = database.prepare(`SELECT DISTINCT year FROM indexed_files WHERE year IS NOT NULL ORDER BY year`).all().map(r => r.year);
    const cameraMakes = database.prepare(`SELECT DISTINCT camera_make FROM indexed_files WHERE camera_make IS NOT NULL ORDER BY camera_make`).all().map(r => r.camera_make);
    const cameraModels = database.prepare(`SELECT DISTINCT camera_model FROM indexed_files WHERE camera_model IS NOT NULL ORDER BY camera_model`).all().map(r => r.camera_model);
    const lensModels = database.prepare(`SELECT DISTINCT lens_model FROM indexed_files WHERE lens_model IS NOT NULL ORDER BY lens_model`).all().map(r => r.lens_model);
    const extensions = database.prepare(`SELECT DISTINCT extension FROM indexed_files ORDER BY extension`).all().map(r => r.extension);
    const sceneCaptureTypes = database.prepare(`SELECT DISTINCT scene_capture_type FROM indexed_files WHERE scene_capture_type IS NOT NULL ORDER BY scene_capture_type`).all().map(r => r.scene_capture_type);
    const exposurePrograms = database.prepare(`SELECT DISTINCT exposure_program FROM indexed_files WHERE exposure_program IS NOT NULL ORDER BY exposure_program`).all().map(r => r.exposure_program);
    const whiteBalances = database.prepare(`SELECT DISTINCT white_balance FROM indexed_files WHERE white_balance IS NOT NULL ORDER BY white_balance`).all().map(r => r.white_balance);
    const cameraPositions = database.prepare(`SELECT DISTINCT camera_position FROM indexed_files WHERE camera_position IS NOT NULL ORDER BY camera_position`).all().map(r => r.camera_position);
    const orientations = database.prepare(`SELECT DISTINCT orientation FROM indexed_files WHERE orientation IS NOT NULL ORDER BY orientation`).all().map(r => r.orientation);
    const countries = database.prepare(`SELECT DISTINCT geo_country FROM indexed_files WHERE geo_country IS NOT NULL ORDER BY geo_country`).all().map(r => r.geo_country);
    const cities = database.prepare(`SELECT DISTINCT geo_city FROM indexed_files WHERE geo_city IS NOT NULL ORDER BY geo_city`).all().map(r => r.geo_city);
    const rawDestinations = database.prepare(`SELECT DISTINCT destination_path FROM indexed_runs ORDER BY destination_path`).all().map(r => r.destination_path);
    // Normalise and deduplicate (handles legacy double-backslash entries)
    const destinations = [...new Set(rawDestinations.map(d => d.replace(/\\\\/g, '\\').replace(/\\$/, '')))];
    const runs = database.prepare(`SELECT id, report_id, destination_path, indexed_at, file_count FROM indexed_runs ORDER BY indexed_at DESC`).all();
    return { confidences, fileTypes, lensModels, dateSources, years, cameraMakes, cameraModels, extensions, sceneCaptureTypes, exposurePrograms, whiteBalances, cameraPositions, orientations, countries, cities, destinations, runs };
}
// ─── Index stats ─────────────────────────────────────────────────────────────
export function getIndexStats() {
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
  `).get();
    const runCount = database.prepare(`SELECT COUNT(*) as cnt FROM indexed_runs`).get().cnt;
    let dbSizeBytes = 0;
    try {
        dbSizeBytes = fs.statSync(dbPath).size;
    }
    catch { /* ignore */ }
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
export function clearAllIndexData() {
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
export function saveFavouriteFilter(name, query) {
    const database = getDb();
    const queryJson = JSON.stringify(query);
    const stmt = database.prepare(`INSERT INTO favourite_filters (name, query_json) VALUES (?, ?)`);
    const result = stmt.run(name, queryJson);
    return {
        id: result.lastInsertRowid,
        name,
        query_json: queryJson,
        created_at: new Date().toISOString(),
    };
}
export function listFavouriteFilters() {
    const database = getDb();
    return database.prepare(`SELECT * FROM favourite_filters ORDER BY created_at DESC`).all();
}
export function deleteFavouriteFilter(id) {
    const database = getDb();
    database.prepare(`DELETE FROM favourite_filters WHERE id = ?`).run(id);
}
export function renameFavouriteFilter(id, name) {
    const database = getDb();
    database.prepare(`UPDATE favourite_filters SET name = ? WHERE id = ?`).run(name, id);
}
/** Get file IDs that haven't been processed by AI yet */
export function getUnprocessedFileIds(task, limit = 100) {
    const database = getDb();
    const col = task === 'faces' ? 'face_processed' : 'tags_processed';
    const rows = database.prepare(`
    SELECT f.id FROM indexed_files f
    LEFT JOIN ai_processing_status s ON f.id = s.file_id
    WHERE f.file_type = 'photo' AND (s.file_id IS NULL OR s.${col} = 0)
      AND f.id = (SELECT MAX(f2.id) FROM indexed_files f2 WHERE f2.file_path = f.file_path)
    ORDER BY f.derived_date DESC
    LIMIT ?
  `).all(limit);
    return rows.map(r => r.id);
}
/** Get file path by ID */
export function getFileById(fileId) {
    const database = getDb();
    return database.prepare(`SELECT * FROM indexed_files WHERE id = ?`).get(fileId);
}
/** Mark a file as AI-processed */
export function markAiProcessed(fileId, task, modelVer) {
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
export function insertFaceDetections(faces) {
    const database = getDb();
    const stmt = database.prepare(`
    INSERT INTO face_detections (file_id, person_id, box_x, box_y, box_w, box_h, embedding, confidence, cluster_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const insertMany = database.transaction((items) => {
        for (const f of items) {
            stmt.run(f.file_id, f.person_id, f.box_x, f.box_y, f.box_w, f.box_h, f.embedding, f.confidence, f.cluster_id);
        }
    });
    insertMany(faces);
}
/** Insert AI tags for a file (replaces any existing tags for the same file) */
export function insertAiTags(tags) {
    const database = getDb();
    const deleteStmt = database.prepare(`DELETE FROM ai_tags WHERE file_id = ?`);
    const insertStmt = database.prepare(`
    INSERT INTO ai_tags (file_id, tag, confidence, source, model_ver)
    VALUES (?, ?, ?, ?, ?)
  `);
    const replaceAll = database.transaction((items) => {
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
/** Rebuild AI FTS entry for a specific file */
export function rebuildAiFts(fileId) {
    const database = getDb();
    // Gather all tags for this file
    const tags = database.prepare(`SELECT tag FROM ai_tags WHERE file_id = ?`).all(fileId)
        .map(r => r.tag).join(' ');
    // Gather all person names for faces in this file
    const persons = database.prepare(`
    SELECT DISTINCT p.name FROM face_detections fd
    JOIN persons p ON fd.person_id = p.id
    WHERE fd.file_id = ?
  `).all(fileId)
        .map(r => r.name).join(' ');
    // Delete existing entry, then insert
    database.prepare(`INSERT INTO files_ai_fts(files_ai_fts, rowid, ai_tags, person_names) VALUES ('delete', ?, '', '')`).run(fileId);
    if (tags || persons) {
        database.prepare(`INSERT INTO files_ai_fts(rowid, ai_tags, person_names) VALUES (?, ?, ?)`).run(fileId, tags, persons);
    }
}
/** Get all face detections for a file */
export function getFacesForFile(fileId) {
    const database = getDb();
    return database.prepare(`
    SELECT fd.*, p.name as person_name
    FROM face_detections fd
    LEFT JOIN persons p ON fd.person_id = p.id
    WHERE fd.file_id = ?
  `).all(fileId);
}
/** Get all AI tags for a file */
export function getAiTagsForFile(fileId) {
    const database = getDb();
    return database.prepare(`SELECT * FROM ai_tags WHERE file_id = ? ORDER BY confidence DESC`).all(fileId);
}
/** List all active (non-discarded) persons with photo counts */
export function listPersons() {
    const database = getDb();
    return database.prepare(`
    SELECT p.*, COUNT(DISTINCT fd.file_id) as photo_count
    FROM persons p
    LEFT JOIN face_detections fd ON fd.person_id = p.id
    WHERE p.discarded_at IS NULL AND p.name != '__ignored__' AND p.name != '__unsure__'
    GROUP BY p.id
    ORDER BY photo_count DESC
  `).all();
}
/**
 * Get persons with co-occurrence counts: given a set of already-selected person IDs,
 * return all other persons with the count of photos they share with ALL selected persons.
 * If no persons selected, returns the regular photo_count for each person.
 */
export function getPersonsWithCooccurrence(selectedPersonIds) {
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
    return database.prepare(query).all(...selectedPersonIds, ...selectedPersonIds);
}
/** Remove person records that have no face detections pointing to them (orphaned leftovers) */
export function cleanupOrphanedPersons() {
    const database = getDb();
    const result = database.prepare(`
    DELETE FROM persons
    WHERE id NOT IN (SELECT DISTINCT person_id FROM face_detections WHERE person_id IS NOT NULL)
      AND discarded_at IS NULL
  `).run();
    if (result.changes > 0) {
        console.log(`[AI] Cleaned up ${result.changes} orphaned person record(s) with no face detections`);
    }
    return result.changes;
}
/** Create or get a person by name */
export function upsertPerson(name, avatarData) {
    const database = getDb();
    const existing = database.prepare(`SELECT id FROM persons WHERE name = ? COLLATE NOCASE`).get(name);
    if (existing) {
        // Clear discarded_at in case this person was previously discarded
        database.prepare(`UPDATE persons SET discarded_at = NULL WHERE id = ? AND discarded_at IS NOT NULL`).run(existing.id);
        return existing.id;
    }
    const result = database.prepare(`INSERT INTO persons (name, avatar_data) VALUES (?, ?)`).run(name, avatarData ?? null);
    return result.lastInsertRowid;
}
/** Assign a person to a face detection (and all faces in the same cluster) */
export function assignPersonToCluster(clusterId, personId) {
    const database = getDb();
    database.prepare(`UPDATE face_detections SET person_id = ? WHERE cluster_id = ?`).run(personId, clusterId);
}
/** Assign a person to a single face detection */
export function assignPersonToFace(faceId, personId, verified = false) {
    const database = getDb();
    if (verified) {
        database.prepare(`UPDATE face_detections SET person_id = ?, verified = 1 WHERE id = ?`).run(personId, faceId);
    }
    else {
        database.prepare(`UPDATE face_detections SET person_id = ? WHERE id = ?`).run(personId, faceId);
    }
}
export function setPersonRepresentativeFace(personId, faceId) {
    const database = getDb();
    database.prepare(`UPDATE persons SET representative_face_id = ? WHERE id = ?`).run(faceId, personId);
}
export function verifyFace(faceId) {
    const database = getDb();
    database.prepare(`UPDATE face_detections SET verified = 1 WHERE id = ?`).run(faceId);
}
/** Get all faces for a person or unnamed cluster, paginated, sorted by confidence ASC (lowest first) */
export function getClusterFaces(clusterId, page = 0, perPage = 40, personId) {
    const database = getDb();
    // If personId is provided, query by person (handles reassigned faces correctly)
    if (personId) {
        const total = database.prepare(`SELECT COUNT(*) as cnt FROM face_detections WHERE person_id = ?`).get(personId).cnt;
        const faces = database.prepare(`
      SELECT fd.id as face_id, fd.file_id, f.file_path, fd.box_x, fd.box_y, fd.box_w, fd.box_h, fd.confidence, fd.verified
      FROM face_detections fd
      INNER JOIN indexed_files f ON fd.file_id = f.id
      WHERE fd.person_id = ?
      ORDER BY fd.confidence ASC
      LIMIT ? OFFSET ?
    `).all(personId, perPage, page * perPage);
        return { faces, total, page, perPage, totalPages: Math.ceil(total / perPage) };
    }
    // For unnamed clusters: only show faces with no person_id
    const total = database.prepare(`SELECT COUNT(*) as cnt FROM face_detections WHERE cluster_id = ? AND person_id IS NULL`).get(clusterId).cnt;
    const faces = database.prepare(`
    SELECT fd.id as face_id, fd.file_id, f.file_path, fd.box_x, fd.box_y, fd.box_w, fd.box_h, fd.confidence, fd.verified
    FROM face_detections fd
    INNER JOIN indexed_files f ON fd.file_id = f.id
    WHERE fd.cluster_id = ? AND fd.person_id IS NULL
    ORDER BY fd.confidence ASC
    LIMIT ? OFFSET ?
  `).all(clusterId, perPage, page * perPage);
    return { faces, total, page, perPage, totalPages: Math.ceil(total / perPage) };
}
/** Get count of faces for a person or unnamed cluster */
export function getClusterFaceCount(clusterId, personId) {
    const database = getDb();
    if (personId) {
        const result = database.prepare(`
      SELECT COUNT(*) as face_count, COUNT(DISTINCT file_id) as photo_count
      FROM face_detections WHERE person_id = ?
    `).get(personId);
        return { faceCount: result.face_count, photoCount: result.photo_count };
    }
    const result = database.prepare(`
    SELECT COUNT(*) as face_count, COUNT(DISTINCT file_id) as photo_count
    FROM face_detections WHERE cluster_id = ? AND person_id IS NULL
  `).get(clusterId);
    return { faceCount: result.face_count, photoCount: result.photo_count };
}
/**
 * Get visual similarity suggestions for a face — compare its embedding against
 * all named faces and return ranked matches by cosine similarity.
 */
export function getVisualSuggestions(faceId, limit = 5) {
    const database = getDb();
    // Get the target face's embedding
    const targetFace = database.prepare(`SELECT embedding FROM face_detections WHERE id = ?`).get(faceId);
    if (!targetFace?.embedding)
        return [];
    const targetVec = new Float32Array(targetFace.embedding.buffer, targetFace.embedding.byteOffset, targetFace.embedding.byteLength / 4);
    // Get all named faces with embeddings (one representative per person for speed)
    const namedFaces = database.prepare(`
    SELECT fd.embedding, p.id as person_id, p.name as person_name
    FROM face_detections fd
    JOIN persons p ON fd.person_id = p.id
    WHERE fd.embedding IS NOT NULL AND fd.id != ?
  `).all(faceId);
    if (namedFaces.length === 0)
        return [];
    // Calculate cosine similarity for each and aggregate by person (best match per person)
    const personBest = new Map();
    for (const nf of namedFaces) {
        const vec = new Float32Array(nf.embedding.buffer, nf.embedding.byteOffset, nf.embedding.byteLength / 4);
        if (vec.length !== targetVec.length)
            continue;
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
export function unnameFace(faceId) {
    const database = getDb();
    database.prepare(`UPDATE face_detections SET person_id = NULL, verified = 0 WHERE id = ?`).run(faceId);
}
/** Rename a person — updates the name everywhere it appears */
export function renamePerson(personId, newName) {
    const database = getDb();
    // Check if the new name already exists as a different person
    const existing = database.prepare(`SELECT id FROM persons WHERE name = ? COLLATE NOCASE AND id != ?`).get(newName, personId);
    if (existing) {
        // Merge into the existing person with that name
        mergePersons(existing.id, personId);
    }
    else {
        database.prepare(`UPDATE persons SET name = ? WHERE id = ?`).run(newName, personId);
    }
}
/**
 * Merge sourcePersonId into targetPersonId.
 * All faces assigned to source get reassigned to target, then source is deleted.
 * Returns the number of faces reassigned.
 */
export function mergePersons(targetPersonId, sourcePersonId) {
    const database = getDb();
    const result = database.prepare(`UPDATE face_detections SET person_id = ? WHERE person_id = ?`).run(targetPersonId, sourcePersonId);
    database.prepare(`DELETE FROM persons WHERE id = ?`).run(sourcePersonId);
    return result.changes;
}
/**
 * Soft-delete (discard) a person — unlinks all their faces and marks the person as discarded.
 * The person record is kept so the name can be restored or permanently deleted later.
 */
export function discardPerson(personId) {
    const database = getDb();
    const photosAffected = database.prepare(`SELECT COUNT(DISTINCT file_id) as cnt FROM face_detections WHERE person_id = ?`).get(personId).cnt;
    const result = database.prepare(`UPDATE face_detections SET person_id = NULL WHERE person_id = ?`).run(personId);
    database.prepare(`UPDATE persons SET discarded_at = datetime('now') WHERE id = ?`).run(personId);
    return { facesUnlinked: result.changes, photosAffected };
}
/**
 * Permanently delete a discarded person — removes the person record entirely.
 * Only works on persons that have already been discarded.
 */
export function permanentlyDeletePerson(personId) {
    const database = getDb();
    const result = database.prepare(`DELETE FROM persons WHERE id = ? AND discarded_at IS NOT NULL`).run(personId);
    return result.changes > 0;
}
/**
 * Delete face detections for a specific person by their person_id.
 * Used for permanently removing ignored/unsure faces — deletes the actual face records
 * and the person record if no faces remain.
 */
export function deleteFacesByPerson(personId) {
    const database = getDb();
    // Get affected file IDs before deleting (for FTS rebuild)
    const affectedFiles = database.prepare(`SELECT DISTINCT file_id FROM face_detections WHERE person_id = ?`).all(personId);
    // Delete face detection records
    const result = database.prepare(`DELETE FROM face_detections WHERE person_id = ?`).run(personId);
    // Clean up the person record if no faces remain
    const remaining = database.prepare(`SELECT COUNT(*) as cnt FROM face_detections WHERE person_id = ?`).get(personId).cnt;
    if (remaining === 0) {
        database.prepare(`DELETE FROM persons WHERE id = ?`).run(personId);
    }
    return { facesDeleted: result.changes };
}
/**
 * Restore a discarded person — clears the discarded_at timestamp.
 * Note: faces must be re-assigned manually since they were unlinked on discard.
 */
export function restorePerson(personId) {
    const database = getDb();
    const result = database.prepare(`UPDATE persons SET discarded_at = NULL WHERE id = ?`).run(personId);
    return result.changes > 0;
}
/** List discarded persons */
export function listDiscardedPersons() {
    const database = getDb();
    return database.prepare(`
    SELECT p.*, 0 as photo_count
    FROM persons p
    WHERE p.discarded_at IS NOT NULL
    ORDER BY p.discarded_at DESC
  `).all();
}
/**
 * Legacy alias — soft-deletes (discards) a person.
 */
export function deletePerson(personId) {
    return discardPerson(personId);
}
/** Get a person by ID */
export function getPersonById(personId) {
    const database = getDb();
    const row = database.prepare(`
    SELECT p.*, COUNT(DISTINCT fd.file_id) as photo_count
    FROM persons p
    LEFT JOIN face_detections fd ON fd.person_id = p.id
    WHERE p.id = ?
    GROUP BY p.id
  `).get(personId);
    return row ?? null;
}
/** Get all face embeddings for clustering */
export function getAllFaceEmbeddings() {
    const database = getDb();
    return database.prepare(`SELECT id, file_id, embedding, cluster_id FROM face_detections WHERE embedding IS NOT NULL`).all();
}
/**
 * Refine facial recognition by computing per-person average embeddings
 * from verified faces, then matching unnamed faces against those averages.
 *
 * Processes persons in descending order of verified face count (most populous first).
 * Returns stats about what was done.
 */
export function refineFromVerifiedFaces(similarityThreshold = 0.72) {
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
  `).all();
    const perPerson = [];
    let totalNewMatches = 0;
    for (const person of persons) {
        // Get verified embeddings for this person
        const verifiedRows = database.prepare(`
      SELECT embedding FROM face_detections
      WHERE person_id = ? AND verified = 1 AND embedding IS NOT NULL
    `).all(person.id);
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
            for (let i = 0; i < dim; i++)
                avg[i] += vec[i];
        }
        for (let i = 0; i < dim; i++)
            avg[i] /= verifiedRows.length;
        // Get all unnamed faces (person_id IS NULL) with embeddings
        const unnamed = database.prepare(`
      SELECT id, embedding FROM face_detections
      WHERE person_id IS NULL AND embedding IS NOT NULL
    `).all();
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
export function updateFaceCluster(faceId, clusterId) {
    const database = getDb();
    database.prepare(`UPDATE face_detections SET cluster_id = ? WHERE id = ?`).run(clusterId, faceId);
}
/** Get all face clusters with representative face data for the People management view */
export function getPersonClusters() {
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
  `).all();
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
  `).all();
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
  `).all();
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
    return clusters.map((c) => {
        const isNamed = c.person_id != null;
        const isSpecial = isNamed && (c.person_name === '__ignored__' || c.person_name === '__unsure__');
        const rep = isSpecial
            ? (repByClusterWithPersonStmt.get(c.cluster_id, c.person_id) || {})
            : isNamed
                ? (repByPersonChosenStmt.get(c.person_id) || repByPersonAutoStmt.get(c.person_id) || {})
                : (repByClusterStmt.get(c.cluster_id) || {});
        const samples = isSpecial
            ? facesByClusterWithPersonStmt.all(c.cluster_id, c.person_id)
            : isNamed
                ? facesByPersonStmt.all(c.person_id)
                : facesByClusterStmt.all(c.cluster_id);
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
export function getAiTagOptions() {
    const database = getDb();
    return database.prepare(`
    SELECT t.tag, COUNT(DISTINCT t.file_id) as count
    FROM ai_tags t
    INNER JOIN indexed_files f ON t.file_id = f.id
    WHERE t.confidence >= 0.3
      AND f.id = (SELECT MAX(f2.id) FROM indexed_files f2 WHERE f2.file_path = f.file_path)
    GROUP BY t.tag
    ORDER BY count DESC
  `).all();
}
/** Get AI processing stats (scoped to current/valid files only) */
export function getAiStats() {
    const database = getDb();
    // Only count AI data for files that are the latest per path (not stale duplicates)
    const processed = database.prepare(`
    SELECT COUNT(*) as cnt FROM ai_processing_status s
    INNER JOIN indexed_files f ON s.file_id = f.id
    WHERE (s.face_processed = 1 OR s.tags_processed = 1)
      AND f.id = (SELECT MAX(f2.id) FROM indexed_files f2 WHERE f2.file_path = f.file_path)
  `).get().cnt;
    const faces = database.prepare(`
    SELECT COUNT(*) as cnt FROM face_detections fd
    INNER JOIN indexed_files f ON fd.file_id = f.id
    WHERE f.id = (SELECT MAX(f2.id) FROM indexed_files f2 WHERE f2.file_path = f.file_path)
  `).get().cnt;
    const persons = database.prepare(`SELECT COUNT(*) as cnt FROM persons WHERE discarded_at IS NULL AND name != '__ignored__' AND name != '__unsure__'`).get().cnt;
    const tags = database.prepare(`
    SELECT COUNT(DISTINCT t.tag) as cnt FROM ai_tags t
    INNER JOIN indexed_files f ON t.file_id = f.id
    WHERE f.id = (SELECT MAX(f2.id) FROM indexed_files f2 WHERE f2.file_path = f.file_path)
  `).get().cnt;
    const totalPhotos = database.prepare(`SELECT COUNT(*) as cnt FROM indexed_files f WHERE f.file_type = 'photo' AND f.id = (SELECT MAX(f2.id) FROM indexed_files f2 WHERE f2.file_path = f.file_path)`).get().cnt;
    return { totalProcessed: processed, totalFaces: faces, totalPersons: persons, totalTags: tags, unprocessed: Math.max(0, totalPhotos - processed) };
}
/** Clear old face data from a previous model so faces get re-processed */
export function clearFaceDataForModelUpgrade() {
    const database = getDb();
    // Check if any faces were processed with the old model (transformers-v1 = DETR)
    const oldFaces = database.prepare(`SELECT COUNT(*) as cnt FROM ai_processing_status WHERE face_processed = 1 AND (face_model_ver = 'transformers-v1' OR face_model_ver IS NULL)`).get();
    if (oldFaces.cnt > 0) {
        console.log(`[AI] Clearing ${oldFaces.cnt} old DETR face detections for model upgrade to @vladmandic/human`);
        database.exec(`
      DELETE FROM face_detections;
      DELETE FROM persons;
      UPDATE ai_processing_status SET face_processed = 0, face_model_ver = NULL WHERE face_processed = 1 AND (face_model_ver = 'transformers-v1' OR face_model_ver IS NULL);
    `);
        // Rebuild FTS for affected files
        const affectedFiles = database.prepare(`SELECT file_id FROM ai_processing_status WHERE face_processed = 0`).all();
        for (const f of affectedFiles) {
            rebuildAiFts(f.file_id);
        }
    }
    // Also reset files that were marked as human-v1 processed but have zero face detections
    // (this happens if the face model failed to load but files were still marked as processed)
    const brokenProcessed = database.prepare(`SELECT COUNT(*) as cnt FROM ai_processing_status aps
     WHERE aps.face_processed = 1 AND aps.face_model_ver = 'human-v1'
     AND NOT EXISTS (SELECT 1 FROM face_detections fd WHERE fd.file_id = aps.file_id)`).get();
    if (brokenProcessed.cnt > 0) {
        console.log(`[AI] Resetting ${brokenProcessed.cnt} files marked face-processed but with 0 detections (previous failed run)`);
        database.exec(`
      UPDATE ai_processing_status SET face_processed = 0, face_model_ver = NULL
      WHERE face_processed = 1 AND face_model_ver = 'human-v1'
      AND NOT EXISTS (SELECT 1 FROM face_detections fd WHERE fd.file_id = ai_processing_status.file_id);
    `);
    }
}
/** Clear all AI data (faces, tags, processing status) */
export function clearAllAiData() {
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
export function clearAllIndexAndAiData() {
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
export function purgeDuplicateRuns() {
    const database = getDb();
    // Find run IDs to delete: for each destination_path with multiple runs, keep only the newest
    const duplicateRuns = database.prepare(`
    SELECT id FROM indexed_runs
    WHERE id NOT IN (
      SELECT MAX(id) FROM indexed_runs GROUP BY destination_path
    )
  `).all();
    if (duplicateRuns.length === 0)
        return 0;
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
export function purgeDuplicateIndexedFiles() {
    const database = getDb();
    // Find IDs to keep (latest per file_path)
    const result = database.prepare(`
    DELETE FROM indexed_files
    WHERE id NOT IN (
      SELECT MAX(id) FROM indexed_files GROUP BY file_path
    )
  `).run();
    console.log(`[DB Cleanup] Purged ${result.changes} duplicate indexed_files rows`);
    return result.changes;
}
/**
 * Remove indexed_files where the file no longer exists on disk.
 * Returns { removed: number, checked: number }.
 */
export function purgeStaleIndexedFiles() {
    const database = getDb();
    // Get all unique file paths
    const rows = database.prepare(`SELECT id, file_path FROM indexed_files`).all();
    const staleIds = [];
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
export function purgeOrphanRuns() {
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
export function purgeGhostRuns() {
    const database = getDb();
    const runs = database.prepare(`SELECT * FROM indexed_runs`).all();
    const autoRemoveIds = [];
    const promptUser = [];
    for (const run of runs) {
        if (!fs.existsSync(run.destination_path)) {
            // Check if ANY files from this run still exist on disk
            const files = database.prepare(`SELECT file_path FROM indexed_files WHERE run_id = ? LIMIT 100`).all(run.id);
            const hasLiveFiles = files.some(f => fs.existsSync(f.file_path));
            if (hasLiveFiles) {
                // Folder gone but files exist somewhere — user may want to Relocate
                promptUser.push(run);
            }
            else {
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
export function relocateRun(runId, newDestinationPath) {
    const database = getDb();
    const run = database.prepare(`SELECT * FROM indexed_runs WHERE id = ?`).get(runId);
    if (!run)
        throw new Error(`Run #${runId} not found`);
    const oldPath = run.destination_path;
    // Normalise both paths for consistent replacement
    const oldNorm = oldPath.replace(/\\/g, '/');
    const newNorm = newDestinationPath.replace(/\\/g, '/');
    // Update the run's destination path
    database.prepare(`UPDATE indexed_runs SET destination_path = ? WHERE id = ?`).run(newDestinationPath, runId);
    // Update all file paths: replace the old destination prefix with the new one
    const files = database.prepare(`SELECT id, file_path FROM indexed_files WHERE run_id = ?`).all(runId);
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
export function runDatabaseCleanup() {
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
