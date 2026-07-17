# Current Product State ★

> **Owner:** Claude — **updated every release** (definition-of-done) · **Update when:** any version ships ·
> **Last reviewed:** 2026-07-17 · **Audience:** Leo (primary), Claude, Terry
>
> This is the single "what's true right now" snapshot. If you read one doc to know what PDR can do today, read this.

## Released version

**v3.0.3** — live on Cloudflare R2 since **2026-07-17**. Existing users auto-update on next launch / their
4-hourly check. `package.json` = `3.0.3`, git tag `v3.0.3`.

Shipped line: 2.0.14 → **3.0.0** (2026-06/07, the big release; v2.1 was never shipped — it *became* 3.0.0)
→ 3.0.1 (07-10) → 3.0.2 (07-12) → **3.0.3 (07-17, current)**.

## What PDR does today (headline capabilities)

- **Fix dates & filenames** — the core workflow. Add sources (folders, ZIPs, drives, Google Takeout,
  iCloud/Apple exports), analyze for date signals (EXIF, video metadata, Takeout/Apple JSON, filenames,
  folder structure), get confidence-scored recommendations, and apply fixes as **copies** (originals never
  destroyed). Duplicates skipped; EXIF can be written back.
- **Needs Dates** — a dedicated Memories view for files PDR couldn't confidently auto-date, with in-place
  correction.
- **Memories** — relive the library: **Dates** (chronological) + **Albums** views.
- **Search & Discover (S&D)** — find photos from the vaguest clue.
- **People Manager** — on-device face detection + clustering; name faces; drives People throughout PDR.
- **Family Trees** — build trees and attach photos to people (a signature, differentiating surface).
- **Collages & Carousels** — a genuine design studio (see below; the focus of the 3.0.x line).
- **Screen Capture** — record the screen with webcam bubbles, virtual backdrops, mic/voiceover, zoom.
- **Sharing** — drag-and-drop, Send to Phone (Wi-Fi QR), Print / Save PDF, Copy.
- **Workspace Recycle Bin** — soft-deleted photos **and** collages/templates recover here; permanent
  delete is the only step that reaches the OS Recycle Bin.

Full detail per surface: [`features.md`](features.md).

## The 3.0.x line = Collages grew up

3.0.1–3.0.3 turned Collages & Carousels into a real creative tool:
- **3.0.1** — text studio, emojis-with-effects, format painter, carousels; Screen Capture backdrops + 2nd camera.
- **3.0.2** — mid-flow per-property/per-word/inline-colour text, Cam-only full-screen, bigger cam bubbles, durable library refresh.
- **3.0.3 (current)** — **Dividers** (+ effect strength); the **Collages Homepage** as a real project
  browser (categories/Uncategorized, sort, pin favourites, recently-opened, grid+list, frozen headers,
  Templates search + pinned starters, drag-to-refile, "Saved to library" tag); the **collage Recycle
  Bin** (soft delete → 3-section Workspace bin: Templates / Collages & carousels / Photos → restore or
  delete-forever); WYSIWYG pixel-exact export; designer snapping/guides/measurements; save-state chip;
  performance pass.

Per-version user copy: `release-notes/v3.0.3.md` and the About PDR changelog (in-app).

## What's live vs. gated

- **Trees is unlocked** in v3.0 (the release gate no longer hides features).
- Free-trial users hit the **1,000-file lifetime cap** and creation caps (e.g. limited collages/carousels);
  paid tiers are uncapped. See [`product-vision.md`](product-vision.md) for pricing.

## What's next (short)

**v3.1 flagship = Clips** (a CapCut-lite video editor). **v4.0 = a private mobile companion + device-to-device
sync** (the big platform bet, closes the Mylio gap). Full plan: [`roadmap.md`](roadmap.md).
