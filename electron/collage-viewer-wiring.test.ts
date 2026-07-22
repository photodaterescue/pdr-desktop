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

describe('DEV-0008 — Page Outline reuses the shared text-palette component', () => {
  // Revised per Terry: not a flat wall of ~199 swatches, but the SAME presentation
  // component the Text and Divider pickers use (renderTextColorPalette) — current-colour
  // readout, quick colours, custom "+", saved slots and collapsible named collections.
  it('renders the page-outline palette via the shared renderTextColorPalette component', () => {
    expect(html).toMatch(/function renderPageOutlinePalette\(\)[\s\S]{0,400}renderTextColorPalette\(/);
  });

  it('the palette writes the picked colour back to collagePageOutline.color', () => {
    // onPick drives the single source of truth for the page-outline colour.
    expect(html).toMatch(/function renderPageOutlinePalette\(\)[\s\S]{0,600}collagePageOutline\.color\s*=\s*hex/);
  });

  it('renders into the same #pageoutline-swatches host the component styles reuse', () => {
    expect(html).toMatch(/function renderPageOutlinePalette\(\)[\s\S]{0,300}getElementById\('pageoutline-swatches'\)/);
  });

  it('exposes Expand/Collapse-all for the collapsible named collections (setAllCollections scoped to the host)', () => {
    // Proves the collapsible collections are present and driveable — same as the Divider pair.
    expect(html).toMatch(/setAllCollections\(true,\s*'pageoutline-swatches'\)/);
    expect(html).toMatch(/setAllCollections\(false,\s*'pageoutline-swatches'\)/);
  });

  it('syncPageOutlineUi rebuilds the shared palette (which rings the active colour itself)', () => {
    expect(html).toMatch(/function syncPageOutlineUi\(\)[\s\S]{0,200}renderPageOutlinePalette\(\)/);
  });
});
