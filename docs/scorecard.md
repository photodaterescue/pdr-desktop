# PDR Feature Scorecard

> **Owner:** Claude · **Cadence:** reassess on the **1st of every month** · Terry directs priority ·
> **Audience:** Terry (primary), Claude
>
> Purpose: a fast, at-a-glance health read on each surface so we don't re-derive it every time. Each score
> is 0–100 (depth + maturity + open bugs, standalone). "Target" = where a focused gap-closer could
> realistically take it. Log each month below so we can compare month-over-month and plan.

## Latest scores — baseline 2026-07-19 (v3.0.3)

| Surface | Score | Target | Gap-closer (what would raise it) |
|---|---|---|---|
| Collages & Carousels | 90 | 95 | Baked page-1 previews for sparse carousels; a few pro layout templates; minor perf pass on large designs. |
| Date identification (Fix) | 88 | 94 | Tighten low-confidence recovery so fewer files fall through to Needs Dates; surface *why* a date was chosen inline. |
| File/folder structuring & safe apply | 86 | 92 | Preview/undo of a fix run before commit; smarter duplicate detection (perceptual, not just exact). |
| Auto-update + Licensing infra | 85 | 90 | Retry/resume on failed delta; clearer offline-activation path. |
| Memories — Dates (timeline) | 84 | 90 | Faster scroll on huge libraries; jump-to-year and on-this-day surfacing. |
| Memories — Albums | 82 | 88 | Bulk album ops; smart/auto albums (by person, place, date range). |
| Viewer | 82 | 88 | Faster load on RAW/large files; keyboard-first navigation polish. |
| Family Trees | 80 | 88 | Finish cousin differentiation; richer relationship editing; share/export polish. |
| Needs Dates | 80 | 86 | Batch-assign by folder/pattern; better guesses to pre-fill the low-confidence set. |
| People Manager | 78 | 86 | Browse-only People tab; merge/split cluster UX; better recall on side/low-light faces. |
| On-device AI (clustering, captions, bg-removal, enhance) | 78 | 85 | Edge quality on cut-outs; faster batch enhance; caption quality pass. |
| Search & Discover | 72 | 85 | Natural-language query + better recall on vague clues; combine signals (person+place+date) in one query. |
| Screen Capture | 72 | 84 | Fix the uiohook mouse-lag → unpark click-ripple and default-on auto-zoom. |
| Sharing | 70 | 82 | Ship the parked Share/Email path; more export presets; direct-to-social sizes. |
| Ask PDR | 72 | 82 | Judged on its own merit as a lightweight, in-app helper (NOT against a big local LLM — deliberately ruled out on app-size grounds). Improve retrieval/answers (v3.1 task): better indexing of PDR's own docs/features; grounded, cited answers scoped to what the app can do. |

**Biggest wins today:** Date engine + Collages.
**Biggest upside:** Search & Discover and Sharing — most under-realised vs potential.

## Monthly log

Add a new dated row-set on the 1st of each month. Keep just the numbers here for trend-spotting; put reasoning in the table above.

| Date | Fix-date | Fix-structure | Needs Dates | Mem-Dates | Mem-Albums | S&D | People | Trees | Collages | Viewer | Ask PDR | On-device AI | Screen Cap | Sharing | Update/License |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-07-19 (baseline) | 88 | 86 | 80 | 84 | 82 | 72 | 78 | 80 | 90 | 82 | 72 | 78 | 72 | 70 | 85 |
