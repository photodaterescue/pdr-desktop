# PDR Style Guide

The whole app uses one button taxonomy and one typography tier system.
No per-call border or text-opacity overrides — pick a tier, full stop.

## Buttons — 8 tiers

Defined in [`client/src/components/ui/button.tsx`](client/src/components/ui/button.tsx).
Use `<Button variant="…" />` with one of the variants below. Do **not**
add `border-…/30`, `text-…/60`, or other faint-colour className overrides.

| Variant | Use for | Examples |
| --- | --- | --- |
| `primary` | The main action on a screen | Run Fix · Continue · Save · Choose Destination |
| `secondary` | Alternative or cancel that's still important | Cancel · Back · Skip · Keep Sources |
| `information` | Opens an informational view, doesn't mutate | Drive Advisor · Reports History · Open Destination · DA · Help & Support |
| `success` | Affirmative completion or status confirmed | View Report (Fix Complete) · "Yes, save" confirm |
| `caution` | Action with consequences, but not destructive | Cancel Fix mid-run · Re-cluster · Improve Recognition · Reset settings |
| `destructive` | Irreversible | Remove · Delete · Clear Sources · Permanently remove |
| `icon` | Square icon-only control | X close · ⓘ info · ⋯ menu · pin |
| `link` | Inline text link inside copy | "Review library plan" · "Don't show this again" |

### How to pick a tier

Ask: **what is this button doing?**

- Mutating data, irreversible → `destructive`.
- Mutating data, has consequences but reversible → `caution`.
- Mutating data, normal → `primary` (if it's THE action) or `secondary` (if it's an alternative).
- Just opens or shows something → `information`.
- Confirms completion / says "yes this is good" → `success`.
- Just an icon → `icon`.
- Looks like text inside a paragraph → `link`.

### Status indicators (badges / pills) use the same colour intent

The CONFIRMED / Analysis complete / Required-X-GB pills use `success`
colours. The Settings backup info banner uses `information`. Match the
button tier colour for consistency: a green pill should mean the same
"good state" the green button means.

## Typography — 8 tiers

Defined in [`client/src/index.css`](client/src/index.css). Use these
classes instead of hand-rolling sizes/weights/opacities.

| Class | Used on | Looks like |
| --- | --- | --- |
| `text-display` | Modal/page hero | Montserrat 24–30px / 600 |
| `text-h1` | Section headings | Montserrat 18px / 600 |
| `text-h2` | Sub-section headings | Montserrat 16px / 600 |
| `text-body` | Paragraphs, descriptions | Inter 14px / 400 / full opacity |
| `text-body-muted` | Helper text under a heading | Inter 14px / 400 / 75% opacity (defined tier, not a hack) |
| `text-label` | Buttons, chips, form labels | Inter 12px / 500 |
| `text-caption` | Microcopy, timestamps, footnotes | Inter 12px / 400 / 65% opacity |
| `text-mono` | Paths, file names, IDs | JetBrains Mono / Inter mono fallback / 12px |

### Why the opacity is hardcoded inside the tier

It's not the `text-foreground/40` problem we just fixed — these classes
have **defined** opacity for that role with measured contrast on both
light and dark themes. The point is to never write `text-foreground/40`
ad-hoc again. If a piece of copy needs to be muted, it's `text-body-muted`
or `text-caption` — never a freehand opacity.

## Things to never do again

- ❌ `<Button className="border-primary/30 text-primary">` — pick a tier.
- ❌ `<p className="text-[10px] text-foreground/40">` — use `text-caption`.
- ❌ Two different greens for the same status — pick the variant the
  button taxonomy already gives you.
- ❌ `<Button variant="outline" className="border-emerald-400/60 text-emerald-600">`
  — that's `success` (or `information` if it's not actually a confirmation).
- ❌ Skipping the variant prop and styling the button entirely via
  `className` — defaults to the legacy `default` variant; pick `primary`.

## Migration status

The 8 tiers are defined; each surface gets swept in its own commit.
Legacy variants (`default`, `outline`, `ghost`) remain in `button.tsx`
so existing buttons keep working until they're migrated. New code
**must** use one of the eight tiers above.

Open migration list: see the audit findings in the conversation
transcript that produced this guide (~70 buttons across workspace,
SearchPanel, Memories, FolderBrowser, modals, Trees, PM).
