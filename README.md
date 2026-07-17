# Photo Date Rescue (PDR) — Desktop App

**Photo Date Rescue** is a premium Windows desktop app that safely repairs photo and video **dates and
filenames** after cloud exports, phone transfers and backups — then grows into a full home for the
library: browse and relive in **Memories**, find anything in **Search & Discover**, name faces in
**People Manager**, build **Family Trees**, design **Collages & Carousels**, **record the screen**, and
**share** — all on the user's own hardware, with **nothing uploaded**.

This repository (**PDR App**) is the desktop application **and the canonical source of truth for PDR's
product knowledge** (see [`/docs`](docs/README.md)).

## Where things are

| Path | What |
|---|---|
| [`AGENTS.md`](AGENTS.md) | **Operating contract** for every AI agent + human — roles, approval gates, release/deploy rules. Read this first. |
| [`docs/`](docs/README.md) | The curated knowledge layer — vision, product state, features, roadmap, architecture, decisions, known issues, UI principles. |
| [`STYLE_GUIDE.md`](STYLE_GUIDE.md) | Button + typography taxonomy (code-referenced). |
| `release-notes/` | Per-version user-facing release notes (mandatory each release). |
| `client/` | React + TypeScript renderer (Vite). |
| `electron/` | Electron main process, IPC, workers, engines. |
| `server/`, `shared/`, `worker/` | Dev server, shared types, Cloudflare Worker (licensing/updates). |
| `script/` | Build + release pipeline (`release.ts`, `build.ts`). |

## Build & run (development)

```
npm install
npm run build            # Vite client + server bundle
npm run build:electron   # compile Electron main/workers (TypeScript)
# launch the built app (Windows):
node_modules\electron\dist\electron.exe dist-electron/main.js
```

- `npm run build` alone is enough for renderer-only changes (`client/`). Electron/main changes also need `build:electron`.
- Release/packaging is a separate, gated flow — see [`AGENTS.md` §4](AGENTS.md) and `/docs/architecture.md`. **Never package or sign during ordinary development.**

## Platform

Windows desktop (Electron). Tech: React + TypeScript + Vite (renderer), Electron + Node (main),
`better-sqlite3` local search index, worker threads for heavy work, `electron-builder` (NSIS) + Sectigo
EV code-signing for packaging, Cloudflare R2 for auto-updates, Cloudflare Worker for licensing.

## Related repos (separate)

- **PDR Website** — public marketing site.
- **PDR WebApp** — browser demo.

Both link back to this repo's `/docs` for core product facts rather than duplicating them.
