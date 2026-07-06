// Companion Phase A — the search "brain" over the curated corpus (companion-corpus.ts).
//
// v3.1 (Terry) — a fast, fully-offline lexical matcher: it tokenises the question, expands each word
// with PDR's synonym groups (so "pictures" hits "photos", "get in" hits "add"), then scores every
// corpus entry by weighted token overlap + coverage of the question + a phrase bonus. No model, no
// download, no network — it runs in the renderer in well under a millisecond over ~45 entries.
//
// It is deliberately a PURE FUNCTION behind a tiny interface (searchCompanion → ranked results +
// a quality flag). Phase A.2 can swap in a neural embedding re-rank behind this same signature
// without the UI or corpus changing.

import { COMPANION_CORPUS, COMPANION_SYNONYMS, type CompanionEntry } from './companion-corpus';

export interface CompanionResult {
  entry: CompanionEntry;
  score: number;
  /** Fraction of the question's words this entry actually answered (0..1). */
  coverageFrac?: number;
}

export interface CompanionSearchOutcome {
  results: CompanionResult[];
  /** good = a confident answer; weak = closest matches (say "closest"); none = nothing relevant. */
  quality: 'good' | 'weak' | 'none';
}

// Purely grammatical words that carry no retrieval signal. NB: words that appear in a synonym group
// (get, out, add, find, …) are intentionally NOT here — they carry meaning in PDR questions.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
  'i', 'my', 'me', 'mine', 'you', 'your', 'yours', 'we', 'our', 'us', 'it', 'its', 'they', 'them',
  'this', 'that', 'these', 'those', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'but', 'with',
  'how', 'what', 'where', 'when', 'why', 'which', 'who', 'whose', 'whom', 'can', 'could', 'would',
  'should', 'will', 'shall', 'so', 'if', 'then', 'than', 'there', 'here', 'as', 'by', 'about', 'into',
  'onto', 'just', 'also', 'some', 'any', 'all', 'more', 'most', 'very', 'really', 'please', 'need',
  'want', 'im', 'ive', 'dont', 'cant', 'does', 'not', 'no', 'use', 'using', 'used', 'app',
]);

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    // keep tokens of length >= 2, OR anything with an underscore/digit (so "_cf", "v2", "3d" survive)
    .filter((t) => (t.length >= 2 || /[_0-9]/.test(t)) && !STOPWORDS.has(t));
}

// word -> the full synonym group it belongs to (for query expansion). Built once.
const SYNONYM_MAP: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const group of COMPANION_SYNONYMS) for (const w of group) m.set(w, group);
  return m;
})();

function expand(token: string): string[] {
  const group = SYNONYM_MAP.get(token);
  return group ? group : [token];
}

// Pre-tokenised index per entry, built once on first search.
interface EntryIndex {
  entry: CompanionEntry;
  strong: Set<string>; // tokens from the title + keywords (high weight)
  weak: Set<string>;   // tokens from the answer body (low weight)
  qkStr: string;       // lower(title + ' ' + keywords) for the phrase bonus
  aStr: string;        // lower(answer) for the phrase bonus
}

let INDEX: EntryIndex[] | null = null;

function buildIndex(): EntryIndex[] {
  return COMPANION_CORPUS.map((entry) => {
    const qk = entry.q + ' ' + entry.keywords.join(' ');
    return {
      entry,
      strong: new Set(tokenize(qk)),
      weak: new Set(tokenize(entry.a)),
      qkStr: qk.toLowerCase(),
      aStr: entry.a.toLowerCase(),
    };
  });
}

// Does query token `qt` match anything in `set`? Exact, or a shared prefix of >= 4 chars
// (photo↔photos) — avoids junk substring hits like "art" inside "start".
function tokenHits(qt: string, set: Set<string>): boolean {
  if (set.has(qt)) return true;
  if (qt.length >= 4) {
    for (const t of set) {
      if (t.startsWith(qt) || (t.length >= 4 && qt.startsWith(t))) return true;
    }
  }
  return false;
}

export function searchCompanion(query: string, limit = 6): CompanionSearchOutcome {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return { results: [], quality: 'none' };
  if (!INDEX) INDEX = buildIndex();

  const qNorm = query.toLowerCase().replace(/[^a-z0-9_ ]+/g, ' ').replace(/\s+/g, ' ').trim();

  const scored: CompanionResult[] = [];
  for (const ix of INDEX) {
    let raw = 0;
    let coverage = 0; // how many DISTINCT question words this entry answers
    for (const qt of qTokens) {
      const variants = expand(qt);
      let best = 0;
      for (const v of variants) {
        if (tokenHits(v, ix.strong)) best = Math.max(best, 3);
        else if (tokenHits(v, ix.weak)) best = Math.max(best, 1);
      }
      if (best > 0) { raw += best; coverage += 1; }
    }
    if (raw === 0) continue;

    // Phrase bonus — the whole question (or most of it) appearing verbatim is a strong signal.
    if (qNorm.length >= 5) {
      if (ix.qkStr.includes(qNorm)) raw += 5;
      else if (ix.aStr.includes(qNorm)) raw += 2;
    }

    // Scale by how much of the question was covered, so a single common word can't top the list.
    const coverageFrac = coverage / qTokens.length;
    const score = raw * (0.4 + 0.6 * coverageFrac);
    scored.push({ entry: ix.entry, score, coverageFrac });
  }

  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, limit);

  // Quality: a confident ("good") answer must both score well AND actually cover most of the question —
  // so a topical near-miss (e.g. a carousel answer for a "collage" question) reads as a "closest match",
  // not a fuchsia "Best answer". Otherwise it's "weak".
  let quality: 'good' | 'weak' | 'none' = 'none';
  if (results.length > 0) {
    const top = results[0];
    // "good" = fully-covered + a strong-field hit (a single strong keyword fully covering a short
    // question counts). A topical near-miss with low coverage stays "weak" (a "closest match").
    quality = (top.score >= 3.0 && (top.coverageFrac || 0) >= 0.55) ? 'good' : 'weak';
  }
  return { results, quality };
}
