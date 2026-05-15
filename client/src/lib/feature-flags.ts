/**
 * Feature flags for v2.0.0 release-gating.
 *
 * Controlled by the VITE_PDR_RELEASE_GATE env var, read at Vite
 * build time:
 *   - unset (or anything !== 'release'): all features active. Default
 *     for `npm run dev` so we keep iterating on Trees and Edit Dates.
 *   - 'release': production v2.0.0 build. Trees + Edit Dates are
 *     gated off so customers don't reach the broken Trees layout or
 *     the unfinished Edit Dates UX. The sidebar / ribbon / Welcome
 *     showcase entries still RENDER (so the chrome doesn't shift
 *     and returning users see what's coming), but they're visually
 *     greyed and their click handlers refuse with a tooltip
 *     ("Trees will be released shortly" / "Edit Dates will be
 *     released shortly").
 *
 * Vite replaces `import.meta.env.VITE_PDR_RELEASE_GATE` with the
 * literal string at build time, so these helpers compile down to
 * literal-true / literal-false in production bundles. No runtime
 * env-var lookup, no risk of leaking the dev experience to shipped
 * users.
 *
 * Lifting the gate is a one-line flip in the production build script
 * (or removing the helper's `'release'` check entirely once the
 * features are ready).
 */

const RELEASE_GATE: string = (import.meta.env.VITE_PDR_RELEASE_GATE as string | undefined) ?? '';

/**
 * Whether Trees (the family-tree view) is reachable. Returns true
 * in dev builds and any non-release production build. Returns false
 * for the v2.0.0 release-gated build.
 */
export function isTreesEnabled(): boolean {
  return RELEASE_GATE !== 'release';
}

/**
 * Whether Edit Dates (the date-strip click → date-editor surface) is
 * reachable. Returns true in dev builds and any non-release production
 * build. Returns false for the v2.0.0 release-gated build.
 */
export function isEditDatesEnabled(): boolean {
  return RELEASE_GATE !== 'release';
}

/**
 * Whether photo-format conversion (PNG / JPG output) is offered in the
 * Output card. Returns true in dev builds and any non-release
 * production build. Returns false for the v2.0.0 release-gated build:
 * the conversion path has a memory / responsiveness regression on
 * large Takeouts that we couldn't pin down before ship, so the
 * dropdown is greyed off and the fix is forced to use the
 * originals-only path. Re-enabled in v2.1.0 once we've profiled
 * the conversion-worker child-process path against real workloads.
 */
export function isFormatConversionEnabled(): boolean {
  return RELEASE_GATE !== 'release';
}

/**
 * Standardised tooltip / message copy for gated features. Used in
 * tooltips, locked-state callouts, and toast messages so the wording
 * is consistent across surfaces.
 *
 * Concrete version reference ("Coming in v2.1") replaced the vague
 * "released shortly" copy in v2.0.5 — users were left guessing how
 * long "shortly" meant, which felt evasive rather than premium.
 * Pinning to a version number tells the user exactly which release
 * to wait for without committing to a specific date that could slip.
 * When the v2.1 gate is flipped these constants become unreachable
 * code and can be removed.
 */
export const TREES_RELEASED_SHORTLY_MESSAGE = 'Coming in v2.1';
export const EDIT_DATES_RELEASED_SHORTLY_MESSAGE = 'Coming in v2.1';
export const FORMAT_CONVERSION_RELEASED_SHORTLY_MESSAGE = 'Coming in v2.1';
