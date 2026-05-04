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
 * Standardised tooltip / message copy for gated features. Used in
 * tooltips, locked-state callouts, and toast messages so the wording
 * is consistent across surfaces.
 */
export const TREES_RELEASED_SHORTLY_MESSAGE = 'Trees will be released shortly';
export const EDIT_DATES_RELEASED_SHORTLY_MESSAGE = 'Edit Dates will be released shortly';
