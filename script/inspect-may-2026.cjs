// Diagnostic — inspect May 2026 derived dates + folder mismatches.
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Photo Date Rescue', 'search-index', 'pdr-search.db');
const db = new Database(dbPath, { readonly: true });

console.log('=== Files PHYSICALLY in /2026/ folder — derived year breakdown ===');
const folderRows = db.prepare(`
  SELECT
    CAST(SUBSTR(derived_date, 1, 4) AS INTEGER) as derived_year,
    confidence,
    COUNT(*) as n
  FROM indexed_files
  WHERE file_path LIKE '%PDR Library Drive\\2026\\%'
  GROUP BY derived_year, confidence
  ORDER BY n DESC
  LIMIT 20
`).all();
folderRows.forEach(r => console.log(' year=' + r.derived_year, '| conf=' + r.confidence, '|', r.n, 'files'));

console.log('');
console.log('=== Sample of CONFIRMED May 2026 entries (original_filename) ===');
const cf = db.prepare(`
  SELECT filename, original_filename, file_path, date_source
  FROM indexed_files
  WHERE derived_date LIKE '2026-05%' AND confidence = 'confirmed'
  ORDER BY filename
  LIMIT 12
`).all();
cf.forEach(r => console.log('  current=' + r.filename, '| original=' + (r.original_filename || 'NULL'), '| src=' + r.date_source));

console.log('');
console.log('=== Sample of MARKED May 2026 entries ===');
const mk = db.prepare(`
  SELECT filename, original_filename, file_path, date_source
  FROM indexed_files
  WHERE derived_date LIKE '2026-05%' AND confidence = 'marked'
  ORDER BY filename
  LIMIT 12
`).all();
mk.forEach(r => console.log('  current=' + r.filename, '| original=' + (r.original_filename || 'NULL'), '| src=' + r.date_source));

console.log('');
console.log('=== Mtime of source PowerShell already showed for /2026/ folder files ===');
console.log('   ALL had LastWriteTime in late May 2026 (the copy time)');

db.close();
