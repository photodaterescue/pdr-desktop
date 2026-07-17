# Technical Architecture

> **Owner:** Claude · **Update when:** architecture changes · **Last reviewed:** 2026-07-17 ·
> **Audience:** Claude (primary), Leo (background)
>
> Describes the **shipped Windows desktop app**. (The `Express/Drizzle/PostgreSQL` layer in the root
> `replit.md` is a dev-server / webapp scaffold, **not** how the desktop app stores data — see below.)

## Shape

- **Electron app.** Main process (`electron/main.ts`) owns window lifecycle + IPC; a preload
  (`electron/preload.ts`) exposes a safe `window.pdr` API via `contextBridge`; the renderer is
  **React + TypeScript + Vite** (`client/`), styled with Tailwind v4 + shadcn/Radix + custom PDR components.
- **Windows** (each its own renderer):
  - **Workspace** (`index.html`) — the main app (Dashboard, S&D, Memories, Trees, People, Settings, About).
  - **Viewer / Collages** (`viewer.html`) — the photo viewer *and* the collage/carousel editor
    (`body.collage-mode`). **Singleton** window: it only reloads its HTML/JS on window *create*, so a
    rebuilt viewer feature can look "missing" until a full relaunch.
  - **People Manager** (`people.html`).
- **Renderer ↔ main bridge:** `client/src/lib/electron-bridge.ts` wraps `window.pdr.*` with graceful
  non-Electron fallbacks.

## Data & storage (local, no cloud)

- **Search index:** a local **`better-sqlite3`** database — canonical at
  `%APPDATA%\Photo Date Rescue\search-index\pdr-search.db`, mirrored to a **library-drive sidecar**
  `<LibraryRoot>\.pdr\pdr-search.db` for portability. ⚠ Sync `better-sqlite3` work on the **main thread**
  freezes the window — heavy DB/file work must run off-main (worker threads) or yield.
- **Collage projects:** editable `.pdrcollage` files in `%APPDATA%\...\collage-projects\`, **write-through
  mirrored** to `<LibraryRoot>\.pdr\collages\`. A bidirectional **newer-wins merge** keeps the two in step
  (AppData = working copy; drive copy survives a reinstall). Soft-delete = a `trashed` flag in the record
  (see [`decisions.md`](decisions.md)).
- **Exported collages** land as flat images in a library album ("PDR Collages").
- **User library files are never destroyed** by fixes; deletes are recoverable.

## Heavy work = worker threads

Analysis, extraction, AI (face clustering, captions, enhance, background removal), transcription, catalogue,
conversion, etc. run in **worker threads** (the `*-worker.cjs` files) so the UI thread stays responsive.
All AI is **on-device**.

## Screen capture pipeline

Desktop capture (`getUserMedia` desktop source) → `MediaRecorder` (WebM) → temp file → **bundled ffmpeg at
save** encodes to MP4 and applies crop / blur / zoom as filter stages (zero live-perf cost). Webcam bubbles
+ ripple/zoom overlays are separate non-content-protected windows the capture films naturally.

## Versioning

`package.json` `version` is the single source. Vite injects it as `__APP_VERSION__` (drives About PDR
header/Details, the "Current version" changelog tag, the app footer). `app.getVersion()` drives the
Settings footer. **Bump `package.json` only** (+ resync `package-lock` root) — everything cascades. The
titlebar "3.0" pill is a fixed **series** brand (opens the "What's new in 3.0" showcase), not the patch number.

## Build

- `npm run build` — Vite builds the client to `dist/public`; esbuild bundles the dev server to `dist/index.cjs`.
- `npm run build:electron` — `tsc` compiles `electron/` to `dist-electron/` + renames workers to `.cjs` + copies bin/geodata.
- `npm run build:release` — the client build with the release gate flag (gated features greyed appropriately).

## Release & signing pipeline (`script/release.ts`)

`release:package` → kill running PDR → preflight (env, clean tree, tag free) → `build:release` →
`build:electron` → **electron-builder NSIS**, signing every binary with the **Sectigo EV USB fob**
(`signtool`, PIN prompts) → generate `latest.yml` → **STOP** (no R2, no tag).
`release:publish` (`--publish-only`) → inject `release-notes/v<version>.md` into `latest.yml` → validate
(no duplicate keys) → upload installer + blockmap + manifest to **Cloudflare R2** (S3 API) → smoke-test the
public manifest → tag + push `vX.Y.Z`.

- **Packaged-only trap:** native deps (`better-sqlite3`, `ffmpeg-static`, `exiftool`, `uiohook-napi`,
  `UnRAR`) must be **`asarUnpack`**'d and paths remapped `app.asar` → `app.asar.unpacked`, or they're
  unspawnable only when packaged.
- Full release rules + approval gates: [`../AGENTS.md`](../AGENTS.md).

## Licensing & updates infrastructure

- **Cloudflare Worker** (`worker/`) — free-trial file counter, device slots, retention flow; talks to **Lemon Squeezy**.
- **Cloudflare R2** — hosts the signed installer + `latest.yml`; `electron-updater` polls it.

## Known dead code
An orphaned standalone Date-Editor window (`client/date-editor.html`, `date-editor-main.tsx`,
`components/DateEditor.tsx`, the `dateEditor:*` IPC) still builds but nothing opens it — removal is queued.
The date-correction **engine** `electron/date-editor.ts` is **live** (Needs Dates + Trees use it) — do not delete it.
