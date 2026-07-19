# Product Vision & Philosophy

> **Owner:** Terry directs · Claude maintains · **Update when:** positioning or pricing changes ·
> **Last reviewed:** 2026-07-17 · **Audience:** Leo (primary), Claude, Terry

## What PDR is

Photo Date Rescue (PDR) is a **premium Windows desktop app** that first solves a real, painful problem —
photos and videos lose their correct **dates and filenames** after Google Takeout exports, iCloud
downloads, phone transfers and backups — and then grows into a **calm, private home for a person's whole
photo library**.

One-line: **"Bring every photo home."**

## Philosophy (the non-negotiables)

1. **Nothing uploaded. Everything on the user's own hardware.** All analysis, AI (face clustering,
   captions, background removal), editing and storage happen locally. This is the core trust promise and
   the main competitive moat — it must never be quietly broken. Any future "sync" means device-to-device,
   never "upload to us".
2. **Never destroy originals.** Fixes are copies to a new location; deletes are recoverable (Recycle Bin →
   OS bin as the last stop). The user's library is sacred.
3. **Premium, calm, reassuring.** Lavender-themed, minimal, professional. It should feel like a considered,
   trustworthy product, not a utility. Quality bar is high; nothing renders soft, cramped, or half-built.
4. **Confidence and honesty.** Date fixes are confidence-scored and labeled by *how* the date was found.
   The app tells the truth about what it knows.

## Who it's for

Everyday people with large, messy, precious photo libraries — the "fix my family's photos" customer — who
are not technical, who care about their memories, and who are uneasy about handing their whole life to a
cloud service. They value safety, clarity and calm over power-user density.

## Positioning

- **vs. cloud photo services (Google/Apple/Amazon):** private, one-time-or-owned, on your own hardware; you
  are not the product.
- **vs. Mylio (the closest "local library" competitor):** PDR matches much of the local-library experience
  and leads on the date-repair workflow and the creative surfaces (Collages, Capture); Mylio's remaining
  lead is **cross-device / mobile sync** — the single biggest gap, and the reason v4.0 exists (see
  [`roadmap.md`](roadmap.md)).
- **Do not name competitors in user-facing copy** as design references; functional interoperability
  (e.g. reading Takeout/Apple exports) is fine to state.

## Pricing & plans (canonical — decided 2026-05-09)

Two free surfaces, three paid tiers (same desktop app, different licence durations):

| Tier | Surface | Price | Cap |
|---|---|---|---|
| Free Web Demo | Browser at photodaterescue.com | **$0** | 200 MB ZIP, photos only |
| Full Desktop Free Trial | Installed desktop app | **$0** | 1,000 files **lifetime** per key (Cloudflare Worker counter) |
| Monthly | Desktop, recurring | **$19/mo** | unlimited |
| Yearly | Desktop, recurring (best-value) | **$79/yr** | unlimited |
| Lifetime | Desktop, one-time | **$199** | unlimited |

- **Device limits per license:** 3 (paid), **2 (trial)** — trial raised from 1 → 2 on 2026-07-18. Safe because the 1,000-file cap is per **license key** (shared across devices), so extra devices grant no extra trial; it cuts "max uses reached" support tickets and boosts adoption. New trial keys get 2 automatically; already-issued keys keep their stamped limit unless overridden per-license in Lemon Squeezy.
- **Both** subscriptions **and** a Lifetime option exist — never describe PDR as only-subscription or only-one-off.
- **Retention pricing** ($9/3mo, $55/yr, $139) is shown **only** inside the in-app cancellation flow —
  never on the public site or storefront.
- These must match across: the website pricing page, the Lemon Squeezy storefront, in-app upgrade CTAs,
  and any About/Best-Practices copy.

> ⚠️ **FLAG for Terry — verify before Leo uses pricing:** the canonical prices are **$79/yr** and **$199
> lifetime**. As of 2026-05-09 the *website* was still showing introductory **$59/yr** and **$119
> lifetime**, with a rebasing "queued". I don't know the current live state. **Which is correct today —
> and is the website in sync?** Leo should not quote prices until this is confirmed.

## Support philosophy

In-app **Help & Support** first (glossary, FAQs, Best Practices), with `admin@photodaterescue.com` as the
human fallback. Business email is always `admin@photodaterescue.com`, never a personal address.
