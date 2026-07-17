# Known Issues & Technical Debt

> **Owner:** Claude · **Update when:** an issue opens/closes · **Last reviewed:** 2026-07-17 ·
> **Audience:** Claude (primary)
>
> Supersedes the frozen `NOTES_v2.0.9_open_bugs.md` at the repo root (that file is from v2.0.9 and needs a
> reconciliation pass — see the flag at the bottom; do not assume its entries are still open).

## Open

- **Recording mouse-lag (the global click hook).** The `uiohook-napi` global click detector adds noticeable
  mouse lag on Terry's CPU. Because of it, **Click-ripple is parked** (built but hidden/force-disabled) and
  **Auto-zoom** ships opt-in/default-off (it shares the same hook). Fixing/de-lagging the hook is a v3.1
  Capture task; ripple returns once it's fixed.
- **Sparse/empty carousels save with no page-1 thumbnail** — a near-empty design shows the placeholder
  icon instead of a page-1 preview. Low priority; an option is to always bake a background-based preview.
- **Trees — cousin differentiation** pending (per-level chevrons / open-all mostly done; distinguishing
  cousins visually is the remaining polish).
- **Library H:→D: migration** is planned, not built (index-only, ~1,800 H:-only photos; audit first).

## Technical debt / housekeeping

- **Dead Date-Editor window code** (`client/date-editor.html`, `date-editor-main.tsx`,
  `components/DateEditor.tsx`, the `dateEditor:*` IPC + preload block + Vite entry) still builds but nothing
  opens it — **removal queued** (kept out of pre-packaging windows to avoid destabilising the build). Keep
  the *engine* `electron/date-editor.ts` — it is live.
- **Stale root docs** — `FEATURE_INVENTORY_v2.0.0.md`, `NOTES_v2.0.9_open_bugs.md` (both frozen at old
  versions, now superseded by `/docs/features.md` and this file), and `tmp-commit.txt` (looks like a leftover
  scratch commit message). See the flag below.
- **Vite build warns** the main renderer chunk is >500 KB and that `electron-bridge` is both statically and
  dynamically imported — cosmetic, not a defect; noted so it isn't mistaken for a regression.
- **Local memory → repo docs migration** — the CTO's ~100 local memory files are backed up to
  `D:\...\.pdr\agent-memory-backup\`; this `/docs` layer is the curated subset. The raw archive is not the
  source of truth.

## ⚠️ FLAG for Terry
- `NOTES_v2.0.9_open_bugs.md` is old — I have **not** verified which of its entries are still open against
  the shipped 3.0.3 app. Want me to do a reconciliation pass and fold the still-live ones in here?
- Shall I **archive** the two stale root docs (`FEATURE_INVENTORY_v2.0.0.md`, `NOTES_v2.0.9_open_bugs.md`)
  into `docs/archive/` and **delete** `tmp-commit.txt`, now that they're superseded? (Non-destructive `git
  mv` preserves history — I'll only do this on your OK.)
