import { describe, it, expect } from 'vitest';
import {
  coverageKey,
  selectGenuinelyNewFiles,
  type WalkedCandidate,
} from './library-refresh-coverage.js';

// DEV-0005 regression — a library that was MOVED to another drive plus exactly
// 45 genuinely-new files. Mirrors Terry's field evidence (banner ~45 missing,
// Refresh reads 9,847 as new, dashboard total 11,941 from transient duplicates).
//
// Fixture: 9,802 files already indexed under OLD_ROOT (D:) now live on disk
// under NEW_ROOT (H:) with identical (filename, size), plus 45 brand-new files.

const OLD_ROOT = 'D:\\1. Photos\\PDR Library Drive';
const NEW_ROOT = 'H:\\PDR Library Drive';
const LIBRARY_SIZE = 9802;
const GENUINELY_NEW = 45;

const sizeFor = (i: number) => 100000 + ((i * 2654435761) % 5000000);

function buildFixture() {
  // The index as it stands: every library file recorded under OLD_ROOT.
  const indexedPaths = new Set<string>();
  const coveredByNameSize = new Set<string>();
  for (let i = 0; i < LIBRARY_SIZE; i++) {
    const name = `IMG_${String(i).padStart(5, '0')}.jpg`;
    indexedPaths.add(`${OLD_ROOT}\\${name}`);
    coveredByNameSize.add(coverageKey(name, sizeFor(i)));
  }

  // What the disk walk yields now: the same library under NEW_ROOT + 45 new.
  const walked: WalkedCandidate[] = [];
  for (let i = 0; i < LIBRARY_SIZE; i++) {
    const name = `IMG_${String(i).padStart(5, '0')}.jpg`;
    walked.push({ path: `${NEW_ROOT}\\${name}`, filename: name, size: sizeFor(i) });
  }
  for (let i = 0; i < GENUINELY_NEW; i++) {
    const name = `NEW_${String(i).padStart(4, '0')}.jpg`;
    walked.push({ path: `${NEW_ROOT}\\${name}`, filename: name, size: 7000000 + i });
  }

  // findExistingFilePaths restricted to the walked set: exact file_path match.
  const existingByPath = new Set<string>(
    walked.map((c) => c.path).filter((p) => indexedPaths.has(p)),
  );

  return { walked, existingByPath, coveredByNameSize };
}

describe('DEV-0005 moved-library Refresh coverage', () => {
  it('the moved paths do not match by exact file_path (this is why the old pre-filter broke)', () => {
    const { existingByPath } = buildFixture();
    expect(existingByPath.size).toBe(0);
  });

  it('OLD exact-path-only pre-filter treats the WHOLE moved library as new (the bug)', () => {
    const { walked, existingByPath } = buildFixture();
    // Reproduces search-indexer.ts BEFORE the fix: walked.filter(p => !known.has(p)).
    const oldPreFilterNewCount = walked.filter((c) => !existingByPath.has(c.path)).length;
    expect(oldPreFilterNewCount).toBe(LIBRARY_SIZE + GENUINELY_NEW); // 9,847 — Terry's number
  });

  it('coverage-aware pre-filter treats only the 45 genuinely-new files as new (matches the banner)', () => {
    const { walked, existingByPath, coveredByNameSize } = buildFixture();
    const genuinelyNew = selectGenuinelyNewFiles(walked, existingByPath, coveredByNameSize);
    expect(genuinelyNew).toHaveLength(GENUINELY_NEW); // 45
    // Every remaining file is one of the NEW_ files, never a moved library file.
    expect(genuinelyNew.every((c) => c.filename.startsWith('NEW_'))).toBe(true);
  });

  it('unreadable files (size -1) are still treated as new, not silently covered', () => {
    const { existingByPath, coveredByNameSize } = buildFixture();
    const unreadable: WalkedCandidate[] = [
      { path: `${NEW_ROOT}\\IMG_00000.jpg`, filename: 'IMG_00000.jpg', size: -1 },
    ];
    // Same filename as an indexed file but size unknown → must NOT be treated as covered.
    const result = selectGenuinelyNewFiles(unreadable, existingByPath, coveredByNameSize);
    expect(result).toHaveLength(1);
  });
});
