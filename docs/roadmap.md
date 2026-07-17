# Roadmap

> **Owner:** Claude · Terry directs priority · **Update when:** scope or sequencing changes ·
> **Last reviewed:** 2026-07-17 · **Audience:** Leo + Claude

Value estimates are **standalone** (each rated 0–100 on its own merit, not a share of 100). Terry sets final priority.

## Now (shipped)
**v3.0.3 is live** (2026-07-17). The v3.0 line is complete — see [`product-state.md`](product-state.md).
No v3.0.x work outstanding except one small parked item: sparse/empty carousels save with no page-1
thumbnail (blank placeholder). Low priority.

## v3.1 — next batch

- **Clips — the v3.1 flagship.** A native video-editing surface (CapCut-**lite**): stitch library clips on
  a timeline, trim/split/reorder, transitions at cuts, **voiceover over existing media**, a music track,
  title cards designed in Collages, social export shapes (16:9 / 9:16 / 1:1). **v1 scope is LOCKED**: one
  video row + two audio rows, transitions only at joins (stacked video layers explicitly out — a
  real-time composed preview is the one genuinely hard problem). High engine leverage: bundled ffmpeg
  already does cut/blur/zoom/encode; Viewer trim, mic voiceover, library pickers and the
  project/autosave/welcome architecture all already exist.
- **AI Companion — tweak the lightweight "Ask PDR", do NOT build the big local LLM.** The ~1–2.5 GB
  local-LLM chat is **on ice** — do not plan or build it without a fresh green light. v3.1 work = improve
  the existing Ask PDR retrieval/answers only.
- **Background Remover + Eraser in Collages** — subject cut-out (the on-device remover already exists in
  the Viewer) + a manual eraser to touch up edges. Deliberately deferred from v3.0 so it can't delay launch.
- **Tree portability & sharing** — export a family tree: **GEDCOM** (interop, lossy on photos/PDR
  metadata) + a full-fidelity **`.pdrtree`** + merge-on-import collaboration (cloud-free). The "so
  customised it won't export" worry is unfounded — the customisation is PDR's *rendering*, not the data.
- **Smaller items:** Photo Info across PDR (Viewer + Memories, not just collages); file size on display;
  a People browse sub-tab in Memories; a PDR-filters dropdown in S&D; a Library-drive migration tool; a
  File Converter UX surface; a Backup Plan wizard.

## v4.0 — platform expansion (a new platform, not a point release)

- **Private mobile companion + device-to-device sync (the headline).** PDR's single biggest competitive
  gap vs. Mylio. **Non-negotiable: "sync" must never mean "upload".** Photos and keys live only on the
  user's devices; PDR's servers see nothing (or, in the relay case, only ciphertext). No account required.
  - **Pairing** reuses the existing Send-to-Phone QR (device keypair swap).
  - **Metadata-first**: phone syncs the index + small previews; pulls a true original only on demand.
  - **Phase 1 = LAN-only sync (ship first)** — same Wi-Fi, direct, zero PDR infrastructure, 100% private.
  - **Phase 2 = sync-anywhere** — E2E P2P with a zero-knowledge relay fallback.
  - **Build approach:** do **not** start with the phone. Build the sync protocol + a small paired LAN
    service **inside the existing desktop app first** (test PC↔PC), then a thin **React Native + Expo**
    client — **read-only viewer first**, two-way later. Realistically months.

## How this list is maintained
Kept curated here; the exhaustive build history and per-round detail live in the CTO's working notes.
When priorities shift, Terry says so and this doc changes the same turn.
