# PDR Knowledge Layer

The curated, current source of truth for Photo Date Rescue. This is what a future business AI (**Leo**)
reads to understand PDR without Terry relaying it, and what the CTO (**Claude**) keeps honest.

> **Rule:** these docs are **authoritative over any agent's session-local memory**. When they disagree,
> the docs win for *what exists*; genuine product-intent questions go to Terry (they are not decided silently).

## Map

| Doc | What's in it | Kept current by | Leo reads |
|---|---|---|---|
| [`product-vision.md`](product-vision.md) | Vision, philosophy, who it's for, positioning, **pricing/plans** | Terry directs · Claude maintains | ✅ primary |
| [`product-state.md`](product-state.md) | ★ **Current truth**: released version, what's live now, headline capabilities, recently shipped | **Claude — every release** | ✅ primary |
| [`features.md`](features.md) | Full current feature set, by surface | Claude — when features ship | ✅ primary |
| [`roadmap.md`](roadmap.md) | Forward plan (v3.1 Clips, v4.0 mobile) + backlog | Claude · Terry directs | ✅ |
| [`architecture.md`](architecture.md) | Technical architecture + build/release/signing pipeline | Claude | ○ background |
| [`decisions.md`](decisions.md) | Decision log (what + why) | Claude · Terry approves intent | ○ background |
| [`known-issues.md`](known-issues.md) | Open issues + technical debt | Claude | ○ background |
| [`ui-principles.md`](ui-principles.md) | Design principles (premium ethos, US spelling, tooltips) → `STYLE_GUIDE.md` | Claude | ○ background |

**Operating rules** (roles, approval gates, release/deploy boundaries) live one level up in
[`../AGENTS.md`](../AGENTS.md).

## Conventions

- Each doc starts with a header: **Owner · Update when · Last reviewed · Audience.**
- Product-facing docs use **US spelling** (Leo derives marketing copy from them).
- "Current truth" for *what exists* is the **shipped app + this repo**, not older docs or memories.
- Keep it lean: most docs are write-rarely; only `product-state` / `features` / `roadmap` / `known-issues`
  change with any regularity, and those ride the release definition-of-done ([`../AGENTS.md` §7](../AGENTS.md)).
