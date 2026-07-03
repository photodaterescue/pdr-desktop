// v2.1 round 315 (Terry) — EDITABLE "Work on Later" collages (Option B + autosave).
//
// A collage is now a first-class EDITABLE PROJECT, like Canva's "your designs": the editable
// state (snapshotCollage JSON + the source photo paths) is auto-saved here, and reopened later
// to keep editing. "Export" stays separate — it bakes the flat image into the Library + the PDR
// Collages album (the managed-library edge: the output is instantly indexed + filed, not just
// dumped to Downloads).
//
// Storage: one record file + a thumbnail PNG under userData/collage-projects (the WORKING copy — collages
// still open with the library drive unplugged). v3.0 (Terry, #7): each project is ALSO written through to
// the LIBRARY DRIVE at <LibraryRoot>\.pdr\collages\ so it survives a reinstall / new machine and travels
// with the photos; a list-time newer-wins merge restores everything once the library is re-attached.
import { app, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import log from 'electron-log/main.js';
import { toLongPath } from './long-path.js';

export interface CollageProjectData {
  id?: string;
  name: string;
  savedAt: string;          // ISO timestamp (stamped by the renderer)
  files: string[];          // source photo paths, in files[] order (so item idx round-trips)
  names: string[];          // matching display names
  snapshot: string;         // snapshotCollage() JSON
  aspectKey?: string;
  // v2.1 round 323 (Terry) — 'template' = a reusable design (shown in the CWS Templates row,
  // opened AS A NEW collage so the template stays pristine); default/absent = a normal project.
  kind?: 'project' | 'template';
  // v3.0 (Terry) — the library file id of the exported photo, set once the project has been Saved
  // (absent/null until first save). Powers the "take me there" links (Open in Viewer / Locate in Albums).
  exportedFileId?: number | null;
  // v3.0 round 542 (Terry) — a CAROUSEL project's saved album id (carousels export an album of
  // slides, not a single photo). Set on carousel save; powers Update + the Home-screen Albums link.
  carouselAlbumId?: number | null;
  // v3.0 round 546 (Terry) — the wide (joined) design's library file id, so View can open it
  // directly — the carousel counterpart of exportedFileId.
  carouselWideFileId?: number | null;
}

export interface CollageProjectSummary {
  id: string;
  name: string;
  savedAt: string;
  thumbnailDataUrl: string | null;
  kind: 'project' | 'template';
  exportedFileId?: number | null;
  carouselAlbumId?: number | null;   // v3.0 round 545 (Terry) — surfaced so the Home screen can link a carousel to its album
  carouselWideFileId?: number | null;   // v3.0 round 546 (Terry) — the wide design's file id (Home View for carousels)
  carousel?: boolean;   // v3.0 round 548 (Terry) — carousel-vs-collage kind, for the free-trial creation caps (5 of each)
}

const PROJECT_EXT = '.pdrcollage';
// v3.0 (Terry) — the on-disk file follows PDR's STANDARD naming convention, like every other file: the
// creation timestamp <YYYY-MM-DD>_<HH-MM-SS> + a type suffix. _CP = Collage Project, sitting alongside _CO
// (the collage OUTPUT / exported image) and the _CF/_RC/_E image variants. The friendly Category·Name·vN
// lives INSIDE the file (and in the exported image's caption), exactly like the JPG. The id IS that
// timestamp base, so there's no separate cryptic code. The timestamp is stamped once at creation, so
// renaming a collage never moves the file.
const PROJECT_SUFFIX = '_CP';

function projectsDir(): string {
  const dir = path.join(app.getPath('userData'), 'collage-projects');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* non-fatal */ }
  return dir;
}

// ---- v3.0 r388 (Terry) — library-drive durability (#7) -------------------------------------------
// The library root, read straight from the same state files library-sidecar writes (no import, so there's
// zero coupling to the search-DB mirror engine). null when no library is set OR the drive is unplugged.
function getLibraryRootLocal(): string | null {
  try { const p = path.join(app.getPath('userData'), 'library-state.json'); if (fs.existsSync(p)) { const st = JSON.parse(fs.readFileSync(p, 'utf8')); if (st && typeof st.libraryRoot === 'string' && st.libraryRoot) return st.libraryRoot; } } catch { /* fall through to legacy */ }
  try { const sp = path.join(app.getPath('userData'), 'settings.json'); if (fs.existsSync(sp)) { const s = JSON.parse(fs.readFileSync(sp, 'utf8')); if (s && typeof s.destinationPath === 'string' && s.destinationPath) return s.destinationPath; } } catch { /* none */ }
  return null;
}
// <LibraryRoot>\.pdr\collages — created on demand. null when the library is unset/offline so every caller
// silently falls back to the AppData-only path (no errors when the drive's unplugged).
function sidecarCollagesDir(): string | null {
  const root = getLibraryRootLocal();
  if (!root) return null;
  try { if (!fs.existsSync(root)) return null; } catch { return null; }
  const dir = path.join(root, '.pdr', 'collages');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return null; }
  return dir;
}
function mtimeOf(p: string): number { try { return fs.statSync(toLongPath(p)).mtimeMs; } catch { return 0; } }
// Copy PRESERVING mtime (atomic temp+rename), so a written-through copy has the SAME mtime as its source
// and the newer-wins merge below never ping-pongs identical files back and forth.
function copyPreservingMtime(src: string, dst: string): void {
  const st = fs.statSync(toLongPath(src));
  const tmp = dst + '.tmp';
  fs.copyFileSync(toLongPath(src), toLongPath(tmp));
  fs.renameSync(toLongPath(tmp), toLongPath(dst));
  try { fs.utimesSync(toLongPath(dst), st.atime, st.mtime); } catch { /* best-effort */ }
}
// Bidirectional newer-wins merge: AppData→drive catches up anything saved while the drive was offline;
// drive→AppData restores everything after a reinstall (AppData empty → every sidecar file is "newer").
function syncCollagesWithSidecar(): void {
  const sc = sidecarCollagesDir();
  if (!sc) return;
  const local = projectsDir();
  const isProj = (f: string) => f.endsWith(PROJECT_EXT) || f.endsWith('.png');
  let localFiles: string[] = [], scFiles: string[] = [];
  try { localFiles = fs.readdirSync(local).filter(isProj); } catch { /* none */ }
  try { scFiles = fs.readdirSync(sc).filter(isProj); } catch { /* none */ }
  for (const f of localFiles) { const lp = path.join(local, f), sp = path.join(sc, f); if (mtimeOf(lp) > mtimeOf(sp)) { try { copyPreservingMtime(lp, sp); } catch { /* best-effort */ } } }
  for (const f of scFiles) { const sp = path.join(sc, f), lp = path.join(local, f); if (mtimeOf(sp) > mtimeOf(lp)) { try { copyPreservingMtime(sp, lp); } catch { /* best-effort */ } } }
}
// -------------------------------------------------------------------------------------------------

// ---- v3.0 (Terry) — PDR naming convention for the project files ----------------------------------
function pad2(n: number): string { return (n < 10 ? '0' : '') + n; }
function tsBase(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`; }
function recPath(dir: string, id: string): string { return path.join(dir, `${id}${PROJECT_SUFFIX}${PROJECT_EXT}`); }
function thumbPath(dir: string, id: string): string { return path.join(dir, `${id}${PROJECT_SUFFIX}.png`); }
// Unique id = the creation timestamp, with a -2/-3 tiebreak if two projects are created in the same second.
function dedupeId(dir: string, base: string): string {
  if (!fs.existsSync(toLongPath(recPath(dir, base)))) return base;
  for (let n = 2; n < 1000; n++) { const c = `${base}-${n}`; if (!fs.existsSync(toLongPath(recPath(dir, c)))) return c; }
  return `${base}-${Date.now().toString(36)}`;
}
function genProjectId(): string { return dedupeId(projectsDir(), tsBase(new Date())); }

// One-time migration: convert the original random-code files (<c_id>.pdrcollage) to the timestamp
// convention (<YYYY-MM-DD>_<HH-MM-SS>_CP.pdrcollage). Idempotent (already-converted _CP files are skipped),
// per-file non-fatal, and ALWAYS writes the new file before deleting the old, so a project can never be lost.
function migrateOldProjects(): void {
  const dir = projectsDir();
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(PROJECT_EXT) && !f.endsWith(`${PROJECT_SUFFIX}${PROJECT_EXT}`)); } catch { return; }
  if (!files.length) return;
  const sc = sidecarCollagesDir();
  for (const f of files) {
    try {
      const oldId = f.slice(0, -PROJECT_EXT.length);
      const oldFull = path.join(dir, f);
      let rec: CollageProjectData;
      try { rec = JSON.parse(fs.readFileSync(toLongPath(oldFull), 'utf8')) as CollageProjectData; } catch { continue; }  // skip a corrupt record
      // Creation time: prefer the timestamp encoded in the old "c_<base36ms>_..." id; else savedAt; else file mtime.
      let ms = 0;
      const m = /^c_([0-9a-z]+)_/.exec(oldId);
      if (m) { const v = parseInt(m[1], 36); if (v > 1e12 && v < 4e12) ms = v; }
      if (!ms && rec.savedAt) { const t = Date.parse(rec.savedAt); if (!isNaN(t)) ms = t; }
      if (!ms) { try { ms = fs.statSync(toLongPath(oldFull)).mtimeMs; } catch { ms = Date.now(); } }
      const newId = dedupeId(dir, tsBase(new Date(ms)));
      rec.id = newId;
      // Write the NEW file first (crash-safe), then drop the old one.
      fs.writeFileSync(toLongPath(recPath(dir, newId)), JSON.stringify(rec), 'utf8');
      const oldThumb = path.join(dir, `${oldId}.png`);
      try { if (fs.existsSync(toLongPath(oldThumb))) fs.copyFileSync(toLongPath(oldThumb), toLongPath(thumbPath(dir, newId))); } catch { /* thumb best-effort */ }
      try { fs.unlinkSync(toLongPath(oldFull)); } catch { /* leave it — harmless dup */ }
      try { fs.unlinkSync(toLongPath(oldThumb)); } catch { /* none */ }
      // Drop the OLD-named copies from the drive too so they don't linger as duplicates (the list-time sync
      // mirrors the new-named files up).
      if (sc) { try { fs.unlinkSync(toLongPath(path.join(sc, f))); } catch { /* none */ } try { fs.unlinkSync(toLongPath(path.join(sc, `${oldId}.png`))); } catch { /* none */ } }
    } catch { /* per-file non-fatal */ }
  }
}

// Save (or overwrite, when `project.id` is supplied — that's what autosave does).
ipcMain.handle('collage:saveProject', async (_e, project: CollageProjectData, thumbnailDataUrl?: string) => {
  try {
    if (!project || typeof project.snapshot !== 'string') return { success: false, error: 'Nothing to save.' };
    const dir = projectsDir();
    const id = project.id || genProjectId();
    const rec: CollageProjectData = { ...project, id };
    fs.writeFileSync(toLongPath(recPath(dir, id)), JSON.stringify(rec), 'utf8');
    if (typeof thumbnailDataUrl === 'string' && thumbnailDataUrl.startsWith('data:image')) {
      const b64 = thumbnailDataUrl.split(',')[1] || '';
      if (b64) { try { fs.writeFileSync(toLongPath(thumbPath(dir, id)), Buffer.from(b64, 'base64')); } catch { /* thumb is best-effort */ } }
    }
    // v3.0 r388 (Terry) — write-through to the library drive (best-effort; AppData stays the working copy).
    try {
      const sc = sidecarCollagesDir();
      if (sc) {
        copyPreservingMtime(recPath(dir, id), recPath(sc, id));
        const tp = thumbPath(dir, id);
        if (fs.existsSync(toLongPath(tp))) { try { copyPreservingMtime(tp, thumbPath(sc, id)); } catch { /* thumb best-effort */ } }
      }
    } catch { /* drive offline — the next list-time sync catches up */ }
    return { success: true, id };
  } catch (err) {
    log.warn(`[collage-projects] save failed: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  }
});

// List newest-first, each with its thumbnail (for the gallery).
ipcMain.handle('collage:listProjects', async (): Promise<CollageProjectSummary[]> => {
  try {
    const dir = projectsDir();
    try { migrateOldProjects(); } catch { /* migration is best-effort; the list still works */ }   // v3.0 (Terry) — old random-code files → timestamp convention
    try { syncCollagesWithSidecar(); } catch { /* merge is best-effort; AppData still lists */ }      // v3.0 r388 (Terry) — restore-after-reinstall + offline-save catch-up
    let recs: string[] = [];
    try { recs = fs.readdirSync(dir).filter((f) => f.endsWith(PROJECT_EXT)); } catch { return []; }
    const out: CollageProjectSummary[] = [];
    for (const f of recs) {
      try {
        const rec = JSON.parse(fs.readFileSync(toLongPath(path.join(dir, f)), 'utf8')) as CollageProjectData;
        if (!rec || !rec.id) continue;
        let thumb: string | null = null;
        for (const tp of [thumbPath(dir, rec.id), path.join(dir, `${rec.id}.png`)]) {   // new <id>_CP.png, else legacy <id>.png
          try { if (fs.existsSync(toLongPath(tp))) { thumb = `data:image/png;base64,${fs.readFileSync(toLongPath(tp)).toString('base64')}`; break; } } catch { /* no thumb */ }
        }
        out.push({ id: rec.id, name: rec.name || 'Untitled collage', savedAt: rec.savedAt || '', thumbnailDataUrl: thumb, kind: rec.kind === 'template' ? 'template' : 'project', exportedFileId: (rec.exportedFileId != null) ? rec.exportedFileId : null, carouselAlbumId: (rec.carouselAlbumId != null) ? rec.carouselAlbumId : null, carouselWideFileId: (rec.carouselWideFileId != null) ? rec.carouselWideFileId : null, carousel: !!(rec as { carousel?: boolean }).carousel });
      } catch { /* skip a corrupt record */ }
    }
    out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
    return out;
  } catch (err) {
    log.warn(`[collage-projects] list failed: ${(err as Error).message}`);
    return [];
  }
});

// Load the full editable record (files + names + snapshot) to reopen.
ipcMain.handle('collage:loadProject', async (_e, id: string) => {
  try {
    if (typeof id !== 'string' || !id) return { success: false, error: 'No project.' };
    const dir = projectsDir();
    let raw: string | null = null;
    for (const p of [recPath(dir, id), path.join(dir, `${id}${PROJECT_EXT}`)]) {   // new, then legacy
      try { raw = fs.readFileSync(toLongPath(p), 'utf8'); break; } catch { /* try next */ }
    }
    if (raw == null) {
      // v3.0 r388 (Terry) — not in AppData (e.g. straight after a reinstall): pull it from the library sidecar.
      const sc = sidecarCollagesDir();
      if (sc) {
        for (const p of [recPath(sc, id), path.join(sc, `${id}${PROJECT_EXT}`)]) {
          try { raw = fs.readFileSync(toLongPath(p), 'utf8'); try { copyPreservingMtime(p, p.endsWith(`${PROJECT_SUFFIX}${PROJECT_EXT}`) ? recPath(dir, id) : path.join(dir, `${id}${PROJECT_EXT}`)); } catch { /* restore best-effort */ } break; } catch { /* try next */ }
        }
      }
    }
    if (raw == null) return { success: false, error: 'Project not found.' };
    const rec = JSON.parse(raw) as CollageProjectData;
    return { success: true, project: rec };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('collage:deleteProject', async (_e, id: string) => {
  try {
    if (typeof id !== 'string' || !id) return { success: false, error: 'No project.' };
    const dir = projectsDir();
    const sc = sidecarCollagesDir();   // v3.0 r388 (Terry) — delete from the library drive too, so a delete doesn't resurrect on the next sync
    // new (<id>_CP.pdrcollage / _CP.png) + legacy (<id>.pdrcollage / .png), in both AppData and the drive.
    const names = [`${id}${PROJECT_SUFFIX}${PROJECT_EXT}`, `${id}${PROJECT_SUFFIX}.png`, `${id}${PROJECT_EXT}`, `${id}.png`];
    for (const nm of names) {
      try { fs.unlinkSync(toLongPath(path.join(dir, nm))); } catch { /* already gone */ }
      if (sc) { try { fs.unlinkSync(toLongPath(path.join(sc, nm))); } catch { /* already gone */ } }
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});
