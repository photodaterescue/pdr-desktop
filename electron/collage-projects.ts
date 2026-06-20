// v2.1 round 315 (Terry) — EDITABLE "Work on Later" collages (Option B + autosave).
//
// A collage is now a first-class EDITABLE PROJECT, like Canva's "your designs": the editable
// state (snapshotCollage JSON + the source photo paths) is auto-saved here, and reopened later
// to keep editing. "Export" stays separate — it bakes the flat image into the Library + the PDR
// Collages album (the managed-library edge: the output is instantly indexed + filed, not just
// dumped to Downloads).
//
// Phase 1 storage: one <id>.pdrcollage record (JSON inside) + a thumbnail PNG under
// userData/collage-projects. (Phase 4 will move these onto the library drive so they travel
// with the library.)
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
    const rec = JSON.parse(fs.readFileSync(toLongPath(path.join(projectsDir(), `${id}${PROJECT_EXT}`)), 'utf8')) as CollageProjectData;
    return { success: true, project: rec };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('collage:deleteProject', async (_e, id: string) => {
  try {
    if (typeof id !== 'string' || !id) return { success: false, error: 'No project.' };
    const dir = projectsDir();
    for (const ext of [PROJECT_EXT, '.png']) { try { fs.unlinkSync(toLongPath(path.join(dir, id + ext))); } catch { /* already gone */ } }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});
