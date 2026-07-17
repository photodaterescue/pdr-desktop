# Feature Catalogue (current, by surface)

> **Owner:** Claude — updated when features ship · **Update when:** a capability is added/changed/removed ·
> **Last reviewed:** 2026-07-17 (v3.0.3) · **Audience:** Leo (primary), Claude
>
> Supersedes the frozen `FEATURE_INVENTORY_v2.0.0.md` at the repo root. Surface names here are the
> **user-facing** names — always use these, never the React component names.

## Fix (dates & filenames) — the core workflow
- Add **sources**: folders, ZIP archives, external/USB drives; understands **Google Takeout** and
  **Apple/iCloud** export structures.
- **Workspace model**: accumulate multiple sources, then apply one fix run.
- **Analysis**: date signals from EXIF, video metadata, Takeout/Apple JSON, filename patterns, folder
  structure → **confidence-scored** recommendation, labeled by *how* the date was found (Confirmed /
  Recovered / Marked, plus Duplicates).
- **Safe apply**: renames + re-dates as **copies to a new location** (originals untouched); duplicates
  skipped; option to write EXIF date back into the file.
- Confidence-based **filename suffixes** so the user can always see how a date was determined.

## Needs Dates
- The Memories view for files PDR couldn't confidently auto-date; correct dates in place. (Replaced the
  cancelled "Date Editor" — that name is dead.)

## Memories
- **Dates** — chronological timeline of the library.
- **Albums** — album browsing; albums are many-to-many **membership** links (one file, many albums; remove
  from one album ≠ delete the file). Move/Copy between albums; read-only source albums (Takeout/iCloud)
  can't be gutted.
- Per-photo **caption** shared across Viewer, Albums, Memories-Dates, S&D, Needs Dates.

## Search & Discover (S&D)
- Find photos from vague clues; a details panel (People / Camera / Exposure / Location / Tags).

## People Manager
- **On-device** face detection + clustering (no cloud); name faces into People; verified names flow through
  PDR (e.g. Trees, Photo Info). Curation surface (distinct from a future browse-only People tab).

## Family Trees
- Build family trees and attach library photos to people. Focus-person model, generation/branch controls,
  sibling/extended-family panels, export to PNG / Print-PDF. A signature, differentiating surface.
- Relationship data always comes from the DB (never inferred from layout).

## Collages & Carousels (the 3.0.x focus — a real design studio)
- **Editor** (Viewer window, collage mode): frames, arrange layouts, multi-select (marquee + Ctrl+click),
  crop, curved corners, per-photo effects (glow, shadow/3D, lift, vignette, grain, blend), **Dividers**
  (stylable lines + effect strength), layered backgrounds (solid / blended / picture + glow/blur texture
  elements), **text studio** (per-property / per-word / inline multi-colour, fonts, effects, format
  painter), emojis-with-effects, symbols/arrows.
- **Carousels** — multi-page (e.g. IG 1080×1350), per-page editing, page outlines.
- **Designer aids** — equal-spacing snapping, alignment guides, measurement badges, IG safe-zone, an
  18-toggle rules panel, Ctrl+E glide-into-place.
- **Magic Resize** — change canvas size, layout preserved.
- **WYSIWYG export** — exports through the same engine that draws the editor, pixel-for-pixel.
- **Save model** — auto-saved editable **project** (`.pdrcollage`) vs. an exported **photo** (a real
  library image in the "PDR Collages" album). "Saved to library" tag marks exported ones. Save → Update →
  "Save as new version".
- **Collages Homepage (CWS)** — the project browser inside the collage window: Blank / IG Carousel tiles,
  Projects | Templates tabs, category chips (+ Uncategorized) and a Gallery dropdown, collapsible
  year/month sections, **sort / pin favourites / recently-opened / grid+list / frozen headers**, Templates
  **search** + pinned starter layouts, drag-to-refile, multi-select move/delete.
- **Recycle Bin** — deleting a collage/carousel/template is a **soft delete** into the Workspace Recycle
  Bin (Templates on their own row, then Collages & carousels, then Photos); **restore** or **delete
  forever** (→ OS Recycle Bin). Not a hard delete.

## Screen Capture
- Record the screen; **webcam bubbles** (resizable, up to 4×, second camera, zoom); **virtual backdrops**
  (blur / portrait depth / pixelate / scenes / brand palette / your own picture — all on-device);
  **Cam-only** full-screen mode (1 fills / 2 split, smooth transitions); **mic / voiceover** (blended with
  system audio); **manual + auto zoom** toward clicks; content-protected blur regions; Tiny quality; a
  stop → Save / Discard / keep-going check. (Click-ripple is built but parked until its input-hook lag is fixed.)

## Sharing
- Multi-file **drag-and-drop** out of PDR; **Send to Phone** (Wi-Fi QR, LAN transfer); **Print / Save PDF**
  (local/network printers); **Copy image**. (Share/Email parked.)

## Cross-app
- **Workspace Recycle Bin** — soft-deleted photos and collages/templates; restore or permanently delete.
- **AI, all on-device** — face clustering, captions, background removal / subject cut-out, image enhance.
- **Auto-update** — signed installer, delta updates via Cloudflare R2; in-app "update available" toast
  shows the release notes.
- **Licensing** — Lemon Squeezy + a Cloudflare Worker (trial file-counter, device slots, retention flow).
