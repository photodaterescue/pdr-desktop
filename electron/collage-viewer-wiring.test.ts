import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DEV-0006 + DEV-0008 wiring regression locks for the Collages editor.
//
// The Collages editor is a single, self-contained inline <script> in
// client/public/viewer.html (~32k lines) with NO module boundary and NO DOM
// test harness in this repo (test runner is vitest/node). We therefore cannot
// unit-test its DOM behaviour directly. These are STRUCTURAL invariants that
// fail-before / pass-after the fix and lock the wiring in so it can't silently
// regress. Behavioural QA (actual F2 keypress, swatch rendering) is manual/GUI.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWER = path.resolve(__dirname, '../client/public/viewer.html');
const html = readFileSync(VIEWER, 'utf8');

describe('DEV-0006 — F2 enters text edit (Excel-style)', () => {
  it('the collage keydown handler binds F2 to enterTextEdit on the selected text box', () => {
    // A dedicated `k === 'f2'` branch that enters edit on the currently-selected
    // text layer. selectAll=false → caret at end, matching Excel F2.
    expect(html).toMatch(/=== 'f2'[\s\S]{0,600}enterTextEdit\(\s*selectedText\s*,\s*false\s*\)/);
  });

  it('F2 respects the same guards as double-click entry (not emoji, not locked)', () => {
    expect(html).toMatch(/=== 'f2'[\s\S]{0,600}!selectedText\.isEmoji[\s\S]{0,80}!selectedText\.locked/);
  });
});

describe('DEV-0008 — Page Outline receives the complete shared palette', () => {
  it('generates the page-outline swatches from the shared palette data', () => {
    expect(html).toMatch(/function buildPageOutlineSwatches/);
  });

  it('the builder pulls from the SAME shared palette constants the text picker uses', () => {
    // Single source of truth: TEXT_COLOR_DEFAULTS (quick colours) + COLOR_COLLECTIONS
    // (the 12 named collections), not a hand-maintained subset.
    expect(html).toMatch(/function buildPageOutlineSwatches[\s\S]{0,1200}TEXT_COLOR_DEFAULTS[\s\S]{0,300}COLOR_COLLECTIONS/);
  });

  it('the builder runs idempotently (marks the row once built)', () => {
    expect(html).toMatch(/function buildPageOutlineSwatches[\s\S]{0,700}dataset\.fullPalette/);
  });

  it('syncPageOutlineUi builds the full palette before ringing the active swatch', () => {
    expect(html).toMatch(/function syncPageOutlineUi\(\)[\s\S]{0,200}buildPageOutlineSwatches\(\)/);
  });
});
