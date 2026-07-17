# UI & Design Principles

> **Owner:** Claude · **Update when:** design conventions change · **Last reviewed:** 2026-07-17 ·
> **Audience:** Claude (primary), Leo (background — for brand consistency in copy/assets)
>
> The build-time detail (button + typography taxonomy) lives in [`../STYLE_GUIDE.md`](../STYLE_GUIDE.md).
> This is the *why* and the house rules.

## Feel
Premium, calm, reassuring, minimal, professional. **Lavender**-themed. It should feel considered and
trustworthy — never like a cheap utility. Put features where a polished, mainstream app would put them; if
Terry instinctively reached for something, build it to the mainstream affordance.

## House rules
- **Nothing renders soft or blurry.** Suspect `will-change` + canvas-without-DPR; verify on hi-DPI.
- **Nothing cramped or half-built.** No "coming soon" placeholders — ship real behaviour or ask.
- **Reuse the existing components** (`custom-button.tsx`, the shared modal/tooltip primitives) — don't
  freehand. There are **two** Button files; check which a screen imports. 8 button tiers + 8 typography
  tiers in `STYLE_GUIDE.md` — no per-button overrides.
- **Tooltips = PDR `IconTooltip`, not native OS tooltips** — with documented exceptions (sliding-thumb
  toggles and long-text overflow-previews are intentionally native; don't "fix" them).
- **US spelling for all user-facing text.** Code identifiers and comments stay as-is and must **not** be
  changed. Settled exceptions kept British on purpose: **"Nardo Grey"**, **"PDR Catalogue"**.
- **Verify visuals before claiming them** — a screenshot or a real rect/computed-style check, never
  inferred from adjacency or "it compiled".
- **Never block the main thread** with sync heavy work reachable from frequent renderer paths (test titlebar drag).

## Brand accents
Lavender base, with per-area accents:

| Area | Hex |
|---|---|
| AI | `#A99CFF` |
| Gold | `#FEC242` |
| Fuchsia | `#D946EF` |
| Trees | `#10B981` |
| Collages | `#283593` |

## Copy voice
Simple, everyday language; calm and confident; honest about what the app knows. No competitor names as
design references in user-facing copy (functional interop — reading Takeout/Apple exports — is fine to state).
Business email is always `admin@photodaterescue.com`.
