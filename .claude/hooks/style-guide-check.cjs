#!/usr/bin/env node
/**
 * PreToolUse hook: when Claude is about to Write/Edit a UI file in
 * client/src, inject a system-reminder pointing at STYLE_GUIDE.md and
 * the existing UI primitives.
 *
 * The point: Claude has a memory note saying "always read the style
 * guide before editing UI" but kept skipping the step. This hook
 * makes the check automatic — the model receives the reminder
 * regardless of intent.
 *
 * Triggered by hooks.PreToolUse[].hooks[].command in
 * .claude/settings.local.json with matcher "Write|Edit".
 *
 * Stdin: { tool_input: { file_path }, ... } JSON.
 * Stdout (when match): JSON with hookSpecificOutput.additionalContext.
 * Stdout (no match): nothing — the hook is a no-op.
 */
let stdin = '';
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(stdin || '{}');
    const filePath = (data && data.tool_input && data.tool_input.file_path) || '';
    // Match any UI / styling file in client/src. (?:^|[\\/]) lets
    // the regex hit both relative ("client/src/...") and absolute
    // ("C:/Users/.../client/src/...") paths.
    const isUiFile = /(?:^|[\\/])client[\\/]src[\\/].+\.(tsx|ts|css)$/.test(filePath);
    if (!isUiFile) return;
    const reminder = [
      'STYLE GUIDE — read before this edit:',
      '• File being edited: ' + filePath,
      '• 8 Button tiers + 8 typography tiers are documented in STYLE_GUIDE.md (repo root).',
      '• Existing primitives live in client/src/components/ui/ — reuse one if it fits.',
      '• Lavender (#ad9eff = --primary) on white reads as faint body text. Use text-foreground for body content; reserve text-primary for icons, hover backgrounds, and bg-primary CTAs (text-primary-foreground = white on lavender).',
      '• Cancel buttons → Button variant="secondary" or the muted text-link convention from promptConfirm. Never freehand.',
      '• Tooltips → IconTooltip from @/components/ui/icon-tooltip. Never freehand the pill.',
      '• Confirm before shipping: does this match an existing primitive? If not, copy the radius/shadow/palette of the closest existing surface.',
    ].join('\n');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: reminder,
      },
    }));
  } catch {
    // Hook failure is non-fatal — fall through silently so a malformed
    // input never blocks Claude's actual work.
  }
});
