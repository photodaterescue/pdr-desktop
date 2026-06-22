// v2.1 round 315 (Terry) — EDITABLE "Work on Later" collages (Option B + autosave).
//
// A collage is now a first-class EDITABLE PROJECT, like Canva's "your designs": the editable
// state (snapshotCollage JSON + the source photo paths) is auto-saved here, and reopened later
// to keep editing. "Export" stays separate — it bakes the flat image into the Library + the PDR
// Collages album (the managed-library edge: the output is instantly indexed + filed, not just
// dumped to Downloads).
//
// Storage: one <id>.pdrcollage record (JSON inside) + a thumbnail PNG under userData/collage-projects
// (the WORKING copy — collages still open with the library drive unplugged). v3.0 r388 (Terry, #7): each
// project is ALSO written through to the LIBRARY DRIVE at <LibraryRoot>\.pdr\collages\ so it survives a
// reinstall / new machine and travels with the photos; a list-time newer-wins merge restores everything
// once the library is re-attached.
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
}

export interface CollageProjectSummary {
  id: string;
  name: string;
  savedAt: string;
  thumbnailDataUrl: string | null;
  kind: 'project' | 'template';
}

// v2.1 round 315 (Terry) — distinct extension marks these as PDR collage PROJECTS (self-
// documenting, like .psd/.fig). NOT a 2-letter suffix — that style is reserved for enhanced
// IMAGE variants (_CF/_RC/_E). The friendly name lives INSIDE the file, so the on-disk name is
// just the id (renaming a project never moves files).
const PROJECT_EXT = '.pdrcollage';

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

function genProjectId(): string {
  // main-process code, so Date.now()/Math.random() are fine here (unlike workflow scripts).
  return `c_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// Save (or overwrite, when `project.id` is supplied — that's what autosave does).
ipcMain.handle('collage:saveProject', async (_e, project: CollageProjectData, thumbnailDataUrl?: string) => {
  try {
    if (!project || typeof project.snapshot !== 'string') return { success: false, error: 'Nothing to save.' };
    const dir = projectsDir();
    const id = project.id || genProjectId();
    const rec: CollageProjectData = { ...project, id };
    fs.writeFileSync(toLongPath(path.join(dir, `${id}${PROJECT_EXT}`)), JSON.stringify(rec), 'utf8');
    if (typeof thumbnailDataUrl === 'string' && thumbnailDataUrl.startsWith('data:image')) {
      const b64 = thumbnailDataUrl.split(',')[1] || '';
      if (b64) { try { fs.writeFileSync(toLongPath(path.join(dir, `${id}.png`)), Buffer.from(b64, 'base64')); } catch { /* thumb is best-effort */ } }
    }
    // v3.0 r388 (Terry) — write-through to the library drive (best-effort; AppData stays the working copy).
    try {
      const sc = sidecarCollagesDir();
      if (sc) {
        copyPreservingMtime(path.join(dir, `${id}${PROJECT_EXT}`), path.join(sc, `${id}${PROJECT_EXT}`));
        const tp = path.join(dir, `${id}.png`);
        if (fs.existsSync(toLongPath(tp))) { try { copyPreservingMtime(tp, path.join(sc, `${id}.png`)); } catch { /* thumb best-effort */ } }
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
    try { syncCollagesWithSidecar(); } catch { /* merge is best-effort; AppData still lists */ }   // v3.0 r388 (Terry) — restore-after-reinstall + offline-save catch-up
    let recs: string[] = [];
    try { recs = fs.readdirSync(dir).filter((f) => f.endsWith(PROJECT_EXT)); } catch { return []; }
    const out: CollageProjectSummary[] = [];
    for (const f of recs) {
      try {
        const rec = JSON.parse(fs.readFileSync(toLongPath(path.join(dir, f)), 'utf8')) as CollageProjectData;
        if (!rec || !rec.id) continue;
        let thumb: string | null = null;
        const tp = path.join(dir, `${rec.id}.png`);
        try { if (fs.existsSync(tp)) thumb = `data:image/png;base64,${fs.readFileSync(toLongPath(tp)).toString('base64')}`; } catch { /* no thumb */ }
        out.push({ id: rec.id, name: rec.name || 'Untitled collage', savedAt: rec.savedAt || '', thumbnailDataUrl: thumb, kind: rec.kind === 'template' ? 'template' : 'project' });
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
    const local = path.join(projectsDir(), `${id}${PROJECT_EXT}`);
    let raw: string;
    try {
      raw = fs.readFileSync(toLongPath(local), 'utf8');
    } catch {
      // v3.0 r388 (Terry) — not in AppData (e.g. straight after a reinstall): pull it from the library sidecar.
      const sc = sidecarCollagesDir();
      if (!sc) throw new Error('Project not found.');
      const sp = path.join(sc, `${id}${PROJECT_EXT}`);
      raw = fs.readFileSync(toLongPath(sp), 'utf8');
      try { copyPreservingMtime(sp, local); const stp = path.join(sc, `${id}.png`); if (fs.existsSync(toLongPath(stp))) copyPreservingMtime(stp, path.join(projectsDir(), `${id}.png`)); } catch { /* restore best-effort */ }
    }
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
    for (const ext of [PROJECT_EXT, '.png']) {
      try { fs.unlinkSync(toLongPath(path.join(dir, id + ext))); } catch { /* already gone */ }
      if (sc) { try { fs.unlinkSync(toLongPath(path.join(sc, id + ext))); } catch { /* already gone */ } }
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});
