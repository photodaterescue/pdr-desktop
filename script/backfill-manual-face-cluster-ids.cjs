// One-shot: assign unique cluster_ids to manual-mark face_detections
// rows that landed with cluster_id = NULL during v2.1's brief window
// of the Mark-a-face bug (before 7cb724f). PM filters those out, so
// without this they're invisible. After backfill, PM treats them as
// singleton clusters in the Unnamed tab.
//
// Safety: only touches rows where embedding IS NULL (auto-detected
// faces always have embeddings; manual marks never do). PDR must be
// closed (no DB lock).
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Photo Date Rescue', 'search-index', 'pdr-search.db');
console.log('DB:', dbPath);

const db = new Database(dbPath);
const before = db.prepare(`SELECT COUNT(*) AS n FROM face_detections WHERE cluster_id IS NULL AND embedding IS NULL`).get();
console.log('NULL cluster_id manual rows BEFORE:', before.n);

const result = db.prepare(`
  UPDATE face_detections
  SET cluster_id = (SELECT COALESCE(MAX(cluster_id), 0) FROM face_detections) + id
  WHERE cluster_id IS NULL AND embedding IS NULL
`).run();
console.log('Updated rows:', result.changes);

const after = db.prepare(`SELECT COUNT(*) AS n FROM face_detections WHERE cluster_id IS NULL AND embedding IS NULL`).get();
console.log('NULL cluster_id manual rows AFTER:', after.n);

// Sample a couple of just-touched rows so we can see what file they
// belong to.
const recent = db.prepare(`SELECT id, file_id, cluster_id, box_x, box_y FROM face_detections WHERE embedding IS NULL AND person_id IS NULL ORDER BY id DESC LIMIT 5`).all();
console.log('Recent manual rows:', JSON.stringify(recent, null, 2));

db.close();
