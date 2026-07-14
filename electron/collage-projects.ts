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
  // v2.1 round 376 (Terry) — a carousel is a single wide canvas; these flag it + its page count so
  // reopen re-enters carousel mode. (Persisted by the renderer; previously read here via casts.)
  carousel?: boolean;
  carouselPages?: number;
  // v3.1 (Terry) — the template a design was created from (openTemplateById re-links it), so
  // reopening still offers "Update template". v3.0.3 (Terry 2026-07-14) — ALSO the key that
  // converges every design opened from one template onto a SINGLE card (see saveProject) instead
  // of spawning a fresh card every session the template is reopened.
  sourceTemplateId?: string;
  sourceTemplateName?: string;
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
  carouselPages?: number | null;   // v3.0 round 584 (Terry) — page count, for the gallery card's "N pages" badge
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
// v3.1 (Terry) — ASYNC + OFF the list path. The old sync version stat'd every project file on the
// LIBRARY DRIVE synchronously inside collage:listProjects (104 projects ≈ 800+ blocking stats on a
// USB/HDD), freezing the MAIN process — the whole app, window dragging included — every time the
// Collages welcome screen opened ("always having to wait for this to populate before I'm able to
// grab the titlebar"). Stats are now fs.promises; copies stay sync but only fire for genuinely
// newer files (normally zero); an in-flight guard stops overlap and callers throttle.
let sidecarSyncInFlight = false;
let sidecarSyncLastMs = 0;
async function syncCollagesWithSidecarAsync(): Promise<void> {
  if (sidecarSyncInFlight) return;
  sidecarSyncInFlight = true;
  try {
    const sc = sidecarCollagesDir();
    if (!sc) return;
    const local = projectsDir();
    const isProj = (f: string) => f.endsWith(PROJECT_EXT) || f.endsWith('.png');
    const statMs = async (p: string): Promise<number> => { try { return (await fs.promises.stat(toLongPath(p))).mtimeMs; } catch { return 0; } };
    const _syT0 = Date.now();   // v3.0.3 TEMP (Terry ~3s/60s freeze) — time the once-a-minute sidecar sync + count copies
    let _syCopies = 0;
    const [localFiles, scFiles] = await Promise.all([
      fs.promises.readdir(local).then((l) => l.filter(isProj)).catch(() => [] as string[]),
      fs.promises.readdir(sc).then((l) => l.filter(isProj)).catch(() => [] as string[]),
    ]);
    for (const f of localFiles) {
      const lp = path.join(local, f), sp = path.join(sc, f);
      const [a, b] = await Promise.all([statMs(lp), statMs(sp)]);
      if (a > b) { try { copyPreservingMtime(lp, sp); _syCopies++; } catch { /* best-effort */ } }
    }
    for (const f of scFiles) {
      const sp = path.join(sc, f), lp = path.join(local, f);
      const [a, b] = await Promise.all([statMs(sp), statMs(lp)]);
      if (a > b) { try { copyPreservingMtime(sp, lp); _syCopies++; } catch { /* best-effort */ } }
    }
    if (Date.now() - _syT0 > 200 || _syCopies > 0) log.warn(`[collage-projects] TEMP sidecar sync ${Date.now() - _syT0}ms, ${localFiles.length}+${scFiles.length} files, ${_syCopies} sync copies`);
    sidecarSyncLastMs = Date.now();
  } finally { sidecarSyncInFlight = false; }
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

// v3.0.3 (Terry 2026-07-14) — converge template-derived designs onto ONE card.
// Opening a saved template starts a NEW design (the renderer nulls the project id at
// applyCollageRecordAsNew so the template stays pristine), so the FIRST autosave used to mint a
// brand-new card EVERY session — Terry reopened his "PDR — Pain" template ~25× in one day and got
// 25 near-identical carousel cards flooding the homepage. When a template-derived design has no id
// yet, adopt the most-recent EXISTING (non-template) project from the SAME template and overwrite
// it instead of creating another card. Never touches the template's own record. Async so the
// once-per-template-open scan never blocks the main thread.
async function latestProjectIdFromTemplate(dir: string, templateId: string, wantCarousel: boolean): Promise<string | null> {
  let files: string[] = [];
  try { files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(PROJECT_EXT)); } catch { return null; }
  let best: { id: string; savedAt: string } | null = null;
  for (const f of files) {
    try {
      const rec = JSON.parse(await fs.promises.readFile(toLongPath(path.join(dir, f)), 'utf8')) as CollageProjectData;
      if (!rec || !rec.id) continue;
      if (rec.kind === 'template') continue;                        // never overwrite a template itself
      if ((rec.sourceTemplateId || '') !== templateId) continue;    // must be a design FROM this template
      if (!!(rec as { carousel?: boolean }).carousel !== wantCarousel) continue;   // keep carousels + collages distinct
      const sa = rec.savedAt || '';
      if (!best || sa > best.savedAt) best = { id: rec.id, savedAt: sa };
    } catch { /* skip a corrupt record */ }
  }
  return best ? best.id : null;
}

// Save (or overwrite, when `project.id` is supplied — that's what autosave does).
ipcMain.handle('collage:saveProject', async (_e, project: CollageProjectData, thumbnailDataUrl?: string) => {
  const _sp0 = Date.now();   // v3.0.3 TEMP (Terry ~4s freeze) — time the SYNC record write + library-drive copy on the main thread
  try {
    if (!project || typeof project.snapshot !== 'string') return { success: false, error: 'Nothing to save.' };
    const dir = projectsDir();
    // v3.0.3 (Terry) — a template-derived design with no id yet: adopt the existing card from the
    // same template rather than spawning a new one each session (see latestProjectIdFromTemplate).
    // The returned id flows back to the renderer (currentCollageProjectId), so every later autosave
    // this session overwrites the same card directly — the scan runs at most once per template-open.
    let id = project.id || null;
    if (!id && project.sourceTemplateId) {
      try { id = await latestProjectIdFromTemplate(dir, project.sourceTemplateId, !!project.carousel); } catch { /* fall through to a fresh id */ }
    }
    if (!id) id = genProjectId();
    const rec: CollageProjectData = { ...project, id };
    const _json = JSON.stringify(rec);
    const _sw0 = Date.now();
    fs.writeFileSync(toLongPath(recPath(dir, id)), _json, 'utf8');
    if (Date.now() - _sw0 > 150) log.warn(`[collage-projects] TEMP recWrite ${Date.now() - _sw0}ms (json ${(_json.length / 1024) | 0}KB)`);
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
    if (Date.now() - _sp0 > 200) log.warn(`[collage-projects] TEMP saveProject total ${Date.now() - _sp0}ms (the sync record write + library-drive copy on the main thread)`);
    return { success: true, id };
  } catch (err) {
    log.warn(`[collage-projects] save failed: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  }
});

// v3.1 (Terry) — one-time SAFE re-bake of a stale carousel card thumbnail. Carousel thumbnails are
// baked ONCE at save time; the page-1-slice fix (SS2) only applies to NEW saves, so existing saved
// carousels + templates still show the pre-fix "jumbled" thumbnail. The renderer re-bakes each one to
// the clean page-1 image and hands the PNG dataURL here. ABSOLUTE SAFETY RULE: this writes ONLY the
// thumbnail sidecar PNG (thumbPath) + its library-drive copy — it NEVER reads, modifies, or writes the
// record JSON, so savedAt and the Recent ordering are preserved, and it deletes nothing.
ipcMain.handle('collage:rebakeThumbnail', async (_e, id: string, thumbnailDataUrl: string) => {
  try {
    if (typeof id !== 'string' || !id) return { success: false, error: 'No project.' };
    if (typeof thumbnailDataUrl !== 'string' || !thumbnailDataUrl.startsWith('data:image')) return { success: false, error: 'No thumbnail.' };
    const b64 = thumbnailDataUrl.split(',')[1] || '';
    if (!b64) return { success: false, error: 'Empty thumbnail.' };
    const dir = projectsDir();
    // Write ONLY the thumbnail PNG (mirrors saveProject's base64→writeFileSync).
    fs.writeFileSync(toLongPath(thumbPath(dir, id)), Buffer.from(b64, 'base64'));
    // v3.0 r388 pattern — write-through the thumbnail to the library drive (best-effort). The record
    // JSON is deliberately untouched here, so the newer-wins merge keeps the existing record as-is.
    try {
      const sc = sidecarCollagesDir();
      if (sc) { try { copyPreservingMtime(thumbPath(dir, id), thumbPath(sc, id)); } catch { /* thumb best-effort */ } }
    } catch { /* drive offline — the next list-time sync catches up */ }
    return { success: true };
  } catch (err) {
    log.warn(`[collage-projects] rebakeThumbnail failed: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  }
});

// List newest-first, each with its thumbnail (for the gallery).
ipcMain.handle('collage:listProjects', async (): Promise<CollageProjectSummary[]> => {
  try {
    const dir = projectsDir();
    try { migrateOldProjects(); } catch { /* migration is best-effort; the list still works */ }   // v3.0 (Terry) — old random-code files → timestamp convention
    // v3.1 (Terry) — the sidecar merge is OFF the list path (the sync version froze the main
    // process — see syncCollagesWithSidecarAsync). List straight from AppData (the working copy)
    // and run the merge in the BACKGROUND, throttled to once a minute. ONE exception awaits it:
    // empty AppData with a sidecar present = the reinstall-restore case, where waiting IS the
    // feature (a fresh install must see every project on its very first open).
    let recs: string[] = [];
    try { recs = fs.readdirSync(dir).filter((f) => f.endsWith(PROJECT_EXT)); } catch { recs = []; }
    if (!recs.length && sidecarCollagesDir()) {
      try { await syncCollagesWithSidecarAsync(); } catch { /* best-effort */ }
      try { recs = fs.readdirSync(dir).filter((f) => f.endsWith(PROJECT_EXT)); } catch { return []; }
    } else if (Date.now() - sidecarSyncLastMs > 60_000) {
      void syncCollagesWithSidecarAsync().catch(() => { /* background best-effort */ });
    }
    const _lpT0 = Date.now();   // v3.0.3 TEMP (Terry ~3s/60s freeze) — time the full list parse (scales with the 103 project files)
    const out: CollageProjectSummary[] = [];
    for (const f of recs) {
      try {
        // v3.0 (Terry 2026-07-05) — PERF: read the record ASYNC and DON'T bulk-load the thumbnail
        // here. Previously each project's thumbnail PNG was readFileSync'd + base64'd inline, so the
        // whole gallery's thumbnails were decoded on the UI thread before returning — which froze the
        // Collages window (couldn't grab the title bar until every thumbnail loaded). Thumbnails now
        // lazy-load per card via collage:getProjectThumbnail as each scrolls into view.
        const raw = await fs.promises.readFile(toLongPath(path.join(dir, f)), 'utf8');
        const rec = JSON.parse(raw) as CollageProjectData;
        if (!rec || !rec.id) continue;
        out.push({ id: rec.id, name: rec.name || 'Untitled collage', savedAt: rec.savedAt || '', thumbnailDataUrl: null, kind: rec.kind === 'template' ? 'template' : 'project', exportedFileId: (rec.exportedFileId != null) ? rec.exportedFileId : null, carouselAlbumId: (rec.carouselAlbumId != null) ? rec.carouselAlbumId : null, carouselWideFileId: (rec.carouselWideFileId != null) ? rec.carouselWideFileId : null, carousel: !!(rec as { carousel?: boolean }).carousel, carouselPages: (typeof (rec as { carouselPages?: number }).carouselPages === 'number') ? (rec as { carouselPages?: number }).carouselPages : null });
      } catch { /* skip a corrupt record */ }
    }
    if (Date.now() - _lpT0 > 200) log.warn(`[collage-projects] TEMP listProjects parsed ${recs.length} files in ${Date.now() - _lpT0}ms`);
    out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
    return out;
  } catch (err) {
    log.warn(`[collage-projects] list failed: ${(err as Error).message}`);
    return [];
  }
});

// v3.0 (Terry 2026-07-05) — lazy per-card thumbnail for the gallery. listProjects no longer bulk-loads
// thumbnails (that blocked the UI thread); the Collages welcome screen calls this once per card as it
// scrolls into view. Async read so it never stalls the main process → the window stays draggable.
ipcMain.handle('collage:getProjectThumbnail', async (_e, id: string): Promise<string | null> => {
  try {
    if (!id) return null;
    const dir = projectsDir();
    for (const tp of [thumbPath(dir, id), path.join(dir, `${id}.png`)]) {   // new <id>_CP.png, else legacy <id>.png
      try {
        const buf = await fs.promises.readFile(toLongPath(tp));
        return `data:image/png;base64,${buf.toString('base64')}`;
      } catch { /* try next path / no thumb */ }
    }
    return null;
  } catch { return null; }
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
