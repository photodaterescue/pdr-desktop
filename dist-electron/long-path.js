/**
 * Windows extended-length path helper — the `\\?\` prefix.
 *
 * Background: classic Win32 limits paths to MAX_PATH = 260 characters.
 * Anything longer fails inside Node's fs binding with `UNKNOWN: unknown
 * error` (the exact symptom Jane hit on her USB-to-USB Google Takeout —
 * Takeout shared-album folder names like "Trip to <very long
 * destination> with <friends>" combined with Google's deeply-nested
 * chronological tree can push individual entry paths past 260 chars long
 * before we even add the PDR_Temp root prefix). The escape is the `\\?\`
 * prefix on Windows which raises the effective limit to ~32K chars.
 *
 * Constraints of the prefix:
 *   - Only Windows. No-op on macOS/Linux.
 *   - Only works with ABSOLUTE paths. Relative paths pass through unchanged
 *     (the caller is responsible for resolving them against cwd first).
 *   - Only with backslashes — forward slashes inside a `\\?\`-prefixed
 *     path are treated as literal characters and break the path.
 *   - UNC paths get a different prefix shape: `\\server\share\…` becomes
 *     `\\?\UNC\server\share\…` (NOT `\\?\\\server\…`).
 *   - Already-prefixed paths must NOT be re-prefixed (`\\?\\\?\…` is
 *     invalid).
 *
 * Apply at any fs callsite that may touch a path long enough to trip
 * MAX_PATH — extraction temp dirs, Fix-copy destinations, indexer walks,
 * face-crop / thumbnail outputs. Cheap to apply (≈ one string slice on
 * Windows, free elsewhere) so over-application is safer than under.
 */
export function toLongPath(p) {
    if (process.platform !== 'win32')
        return p;
    if (!p)
        return p;
    if (p.startsWith('\\\\?\\'))
        return p; // already prefixed — leave alone
    const normalised = p.replace(/\//g, '\\');
    if (normalised.startsWith('\\\\')) {
        // UNC: \\server\share\… → \\?\UNC\server\share\…
        return '\\\\?\\UNC\\' + normalised.slice(2);
    }
    if (/^[A-Za-z]:\\/.test(normalised)) {
        return '\\\\?\\' + normalised;
    }
    // Relative path — pass through. The prefix would not work and caller
    // is presumably operating on a path they constructed locally.
    return p;
}
