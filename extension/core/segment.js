/**
 * Clause segmentation over already-extracted block text (spec §3.3, §3.4).
 *
 * Pure, dependency-free ESM. No `require`, no npm packages, no DOM/BOM
 * globals, no `chrome.*`, no `process.env`, no Node built-ins — this file
 * must run byte-identically under Node (CLI) and inside a Chrome MV3
 * service worker / content script (extension).
 *
 * @typedef {{ blockIndex: number, start: number, end: number }} Span
 * @typedef {{ id: string, text: string, spans: Span[] }} Clause
 */

// Rule 4 (spec §3.3.4): fragments shorter than this are dropped — but only
// when they also lack terminal sentence punctuation. A short fragment that
// *is* a complete sentence ("No refunds.", "Arbitration is mandatory.") is
// exactly the kind of clause this product exists to catch; a bare length
// cutoff would delete it right alongside real headings and nav scraps.
const MIN_FRAGMENT_LENGTH = 40;
const TERMINAL_PUNCTUATION = /[.;?!]$/;

// Secondary floor on the carve-out above ("belt and braces"): a short
// fragment only qualifies for the terminal-punctuation carve-out if it also
// reads like a real sentence — at least two words and at least this many
// characters. A single word with a period ("Overview.", "iv.") is enumeration
// scaffolding regardless of punctuation, not a clause.
const CARVEOUT_MIN_LENGTH = 8;
const CARVEOUT_MIN_WORDS = 2;

// Rule 5 (spec §3.3.5): surviving fragments shorter than this merge into
// their predecessor clause rather than standing alone. Exception: a
// fragment that only survived rule 4 *because* of the terminal-punctuation
// carve-out (i.e. it's under 40 chars) is exempted from this merge — see
// the "protected" handling in segmentBlocks for the reasoning.
const MERGE_THRESHOLD = 100;

// Section-title forward merge (spec §3.3, post-1.13 fix): a fragment that
// is *only* a numbered/lettered marker plus a short label — "2. Arbitration."
// "(a) Overview." — is a severed section title, not a clause. Detected by
// matching a marker at the very start of the fragment and checking what's
// left after stripping it.
const TITLE_MARKER_RE = /^(?:\d+(?:\.\d+)*\.?|\([a-z]\)|\([ivxlcdm]{2,6}\)|§\s*\d*)\s*/i;
const TITLE_REMAINDER_MAX = 60;

// Abbreviation guard (spec §3.3.3). Exact, case-sensitive strings: matching
// case-insensitively would make a genuine sentence ending in the word "no."
// (lowercase, "the answer is no.") get swallowed as the abbreviation "No."
// (capitalized, short for "Number"). Keeping case sensitivity distinguishes
// the two correctly.
const ABBREVIATIONS = [
  'Inc.',
  'e.g.',
  'i.e.',
  'U.S.',
  'No.',
  'Ltd.',
  'Co.',
  'vs.',
  'etc.',
  'Art.',
];

/**
 * Find offsets in `text` where a new numbered/lettered/section item begins
 * (spec §3.3.3, rule 1): `1.`, `2.`, `(a)`, `(b)`, `§`, `4.2.1`,
 * `Section 5.`, roman numerals like `(iv)`.
 *
 * A candidate boundary is only accepted when it sits at the very start of
 * the text or immediately after whitespace — this is what keeps a plain
 * decimal number or a price ("$9.99") from being mistaken for an item
 * marker, since those are preceded by a digit or punctuation, not
 * whitespace.
 *
 * @param {string} text
 * @returns {Set<number>}
 */
function findNumberedItemBoundaries(text) {
  const boundaries = new Set();

  const addIfBoundaryOk = (idx) => {
    const prev = idx > 0 ? text[idx - 1] : '';
    if (idx === 0 || /\s/.test(prev)) {
      boundaries.add(idx);
    }
  };

  // Simple numbered item: "1.", "2.", "12."
  const simpleItem = /\d+\.(?=\s)/g;
  for (const m of text.matchAll(simpleItem)) addIfBoundaryOk(m.index);

  // Multi-level numbering: "4.2.1" or "4.2.1." — at least one internal dot,
  // so it's already distinctive enough that the trailing dot is optional.
  const multiLevel = /\d+(?:\.\d+)+\.?(?=\s)/g;
  for (const m of text.matchAll(multiLevel)) addIfBoundaryOk(m.index);

  // Lettered items: "(a)", "(b)" — a single letter.
  const lettered = /\([a-z]\)/gi;
  for (const m of text.matchAll(lettered)) addIfBoundaryOk(m.index);

  // Roman-numeral items: "(iv)", "(ix)", "(xii)" — 2+ roman-numeral chars,
  // so single-letter items are only ever handled by `lettered` above.
  const roman = /\([ivxlcdm]{2,6}\)/gi;
  for (const m of text.matchAll(roman)) addIfBoundaryOk(m.index);

  // Section symbol: "§5", "§ 5", or bare "§".
  const sectionSymbol = /§\s*\d*/g;
  for (const m of text.matchAll(sectionSymbol)) addIfBoundaryOk(m.index);

  // Spelled-out "Section 5." / "Section 5.2".
  const sectionWord = /\bSection\s+\d+(?:\.\d+)*\.?/g;
  for (const m of text.matchAll(sectionWord)) addIfBoundaryOk(m.index);

  return boundaries;
}

/**
 * Find offsets in `text` where a new sentence begins (spec §3.3.3, rule 2),
 * honoring the abbreviation guard so "Inc.", "e.g.", "i.e.", "U.S.", "No.",
 * "Ltd.", "Co.", "vs.", "etc.", "Art." never cause a split.
 *
 * A candidate is a run of `.`/`!`/`?` followed by whitespace (or end of
 * string). Candidates immediately preceded by a digit are skipped — those
 * are numbered-item markers ("1.", "4.2.1.") already handled by
 * `findNumberedItemBoundaries`, not sentence endings.
 *
 * @param {string} text
 * @returns {Set<number>}
 */
function findSentenceBoundaries(text) {
  const boundaries = new Set();
  const re = /[.!?]+(?=\s|$)/g;

  for (const m of text.matchAll(re)) {
    const idx = m.index;
    const punctEnd = idx + m[0].length;
    const charBefore = idx > 0 ? text[idx - 1] : '';

    if (/[0-9]/.test(charBefore)) continue; // numbered-item marker, not a sentence end

    const context = text.slice(Math.max(0, idx - 10), idx + 1);
    if (ABBREVIATIONS.some((a) => context.endsWith(a))) continue;

    let next = punctEnd;
    while (next < text.length && /\s/.test(text[next])) next++;
    if (next >= text.length) continue; // trailing punctuation, nothing follows

    // Only treat it as a real sentence start if what follows looks like one
    // (capital letter, digit, or an opening quote/paren) — guards against
    // odd lowercase continuations that aren't in the abbreviation list.
    if (/[A-Z0-9"'(]/.test(text[next])) {
      boundaries.add(next);
    }
  }

  return boundaries;
}

/**
 * Trim a [start, end) range in `text` down to its non-whitespace content.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {[number, number]}
 */
function trimmedBounds(text, start, end) {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return [s, e];
}

/**
 * Is `text` a severed section title: starts with a numbered/lettered/
 * section marker, and what remains after stripping that marker is short
 * enough to be a label rather than a clause body?
 *
 * This only looks at the fragment's own text — whether there is more text
 * *following* it in the block (the discriminator that keeps a genuine
 * standalone short clause like "5. No refunds." from being misread as a
 * heading) is a separate, positional check made by the caller.
 *
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeSeveredTitle(text) {
  const m = TITLE_MARKER_RE.exec(text);
  if (!m) return false;
  const remainder = text.slice(m[0].length);
  return remainder.length <= TITLE_REMAINDER_MAX;
}

/**
 * Is `text` nothing but a section marker — "O.", "3.", "4.2.1.", "§5" —
 * with no remainder at all once the marker is stripped? This is enumeration
 * scaffolding, never a clause, regardless of terminal punctuation or length.
 *
 * Deliberately independent of `looksLikeSeveredTitle`'s ≤60-char allowance:
 * a title needs *some* label text to legitimately merge forward into a
 * body ("2. Arbitration."); a bare marker has nothing there at all.
 *
 * Note this only fires when `TITLE_MARKER_RE` recognizes the marker (digit
 * or parenthesized letter/roman-numeral forms). It does not match a bare
 * enumeration letter like "H." or "O." (no digits, no parens) or a bare
 * roman numeral like "iv." — those rely on the word/length floor below.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isBareMarker(text) {
  const m = TITLE_MARKER_RE.exec(text);
  if (!m) return false;
  return text.slice(m[0].length).trim().length === 0;
}

/**
 * Fold section-title fragments forward into the fragment that follows them,
 * within one block's fragment list. A fragment merges forward when it looks
 * like a severed title (`looksLikeSeveredTitle`) *and* it is not the last
 * fragment in the block — that second condition is what stops a genuine
 * short clause that happens to start with a marker ("5. No refunds." with
 * nothing after it) from being swept into whatever follows in the next
 * block, or misread as a heading with no body at all.
 *
 * Deliberately a single pass with no re-checking of the merged result
 * against further neighbors: title+body is folded into one fragment and
 * left there. Re-evaluating the combined fragment against the same test
 * would occasionally keep absorbing the next real clause too (e.g. a title
 * merged with a short-but-complete clause can itself still look "short with
 * a marker prefix"), swallowing content the rule isn't meant to touch.
 *
 * @param {{ blockIndex: number, start: number, end: number, text: string }[]} fragments
 * @param {string} blockText
 * @returns {{ blockIndex: number, start: number, end: number, text: string }[]}
 */
function mergeTitlesForward(fragments, blockText) {
  const merged = [];
  for (let i = 0; i < fragments.length; i++) {
    const frag = fragments[i];
    const hasNext = i + 1 < fragments.length;
    if (hasNext && looksLikeSeveredTitle(frag.text)) {
      const next = fragments[i + 1];
      merged.push({
        blockIndex: frag.blockIndex,
        start: frag.start,
        end: next.end,
        text: blockText.slice(frag.start, next.end),
      });
      i++; // the next fragment is now folded into the title; skip it
    } else {
      merged.push(frag);
    }
  }
  return merged;
}

/**
 * Split one block's text into raw fragments (numbered-item + sentence
 * boundaries combined), before the drop/merge passes, with severed section
 * titles folded forward into their body (see `mergeTitlesForward`).
 *
 * @param {number} blockIndex position of this block in the `blocks` array
 * @param {string} text
 * @returns {{ blockIndex: number, start: number, end: number, text: string }[]}
 */
function extractFragments(blockIndex, text) {
  const numBoundaries = findNumberedItemBoundaries(text);
  const sentBoundaries = findSentenceBoundaries(text);
  const all = new Set([...numBoundaries, ...sentBoundaries]);
  all.delete(0);

  const sorted = [...all].sort((a, b) => a - b);
  const cuts = [0, ...sorted, text.length];

  const fragments = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const [s, e] = trimmedBounds(text, cuts[i], cuts[i + 1]);
    if (e > s) {
      fragments.push({ blockIndex, start: s, end: e, text: text.slice(s, e) });
    }
  }
  return mergeTitlesForward(fragments, text);
}

/**
 * Render a clause's spans back to text: each span's raw slice, joined with
 * a single space. Because same-block runs are coalesced into one span
 * during merging (see `segmentBlocks`), consecutive spans in this array are
 * always from *different* blocks, so "single space between spans from
 * different blocks" and "join all spans with a single space" are the same
 * rule here.
 *
 * @param {Span[]} spans
 * @param {string[]} blockTexts
 * @returns {string}
 */
function renderSpans(spans, blockTexts) {
  return spans.map((s) => blockTexts[s.blockIndex].slice(s.start, s.end)).join(' ');
}

/**
 * Pure clause segmentation over already-extracted block text.
 * The caller walks its own tree (live DOM for the extension, parsed HTML for
 * the CLI) to produce `blockTexts`, in the same order as its own parallel
 * array of nodes, and joins `spans[].blockIndex` back to that array by
 * position afterwards.
 *
 * `Span.blockIndex` is unambiguously the index of the block within the
 * `blockTexts` array passed in here — there is no separate caller-supplied
 * id to reconcile it with, which is what makes `blockTexts[span.blockIndex]`
 * always safe.
 *
 * Title forward-merge (runs *before* rules 4/5, inside `extractFragments`):
 * a severed section title ("2. Arbitration." immediately followed by
 * "You agree...") is folded forward into its body fragment within the same
 * block, so it never reaches rule 4/5 as its own unit — see
 * `mergeTitlesForward`. This runs first specifically so that rule 4's
 * terminal-punctuation carve-out and rule 5's `protected` status are always
 * computed on the *final* fragment text (title+body already combined),
 * never on the bare title alone. That is also the answer to what happens
 * when a title merges forward into what would otherwise have been a
 * protected short clause (e.g. "3. Refunds." immediately followed by
 * "No refunds."): there is no special case for it. The combined fragment
 * ("3. Refunds. No refunds.") is evaluated fresh, exactly like any other
 * fragment — if it's still under 40 chars and ends in terminal punctuation,
 * *that combined unit* becomes protected and stands alone, sealed off from
 * its neighbors; if the title pushed it to 40+ chars (the common case),
 * it's just an ordinary clause under the existing rules. Folding titles in
 * before protection is computed means the two rules never need to know
 * about each other.
 *
 * Order of operations (spec §3.3, rules 4 then 5): rule 4 drops fragments
 * under 40 chars *unless* they end in terminal sentence punctuation
 * (`.` `;` `?` `!`) — that's what keeps "No refunds." or "Arbitration is
 * mandatory." while still dropping bare headings and nav scraps. The
 * merge-under-100 pass (rule 5) then runs only over survivors, so a dropped
 * fragment never has a chance to become — or to interrupt — a span.
 *
 * Rule 4/5 interaction: a fragment that survives rule 4 *only* because of
 * the terminal-punctuation carve-out (i.e. it's under 40 chars) is marked
 * "protected" and is sealed off from rule 5's merge in *both* directions —
 * it never folds into its predecessor, and no later short fragment folds
 * into it either. Rule 5 exists to fold away sub-sentence fragments that
 * read badly and highlight noisily on their own; a fragment that cleared
 * the bar specifically for being a *complete* sentence is the opposite of
 * that, and either direction of merge would bury the short, punchy clause
 * rule 4 was just changed to preserve, costing it its own highlight and
 * verdict. Fragments that are 40–99 chars (not relying on the carve-out)
 * are unaffected and still merge under rule 5 as before, including as a
 * merge target for a later short fragment.
 *
 * A survivor's own length and protected status, and its predecessor's
 * protected status (not the running merged-clause length), decide whether
 * *it* folds into its predecessor, so a run of several ordinary short
 * fragments in a row still all collapse into one clause, a run of
 * protected short sentences each stand alone, and an ordinary short
 * fragment immediately after a protected one starts its own clause rather
 * than being absorbed into it.
 *
 * When a fragment does merge into a predecessor whose last span is in the
 * *same* block, that span's end is simply extended (coalesced) rather than
 * appending a second span for the same block — this is what keeps
 * single-block clauses down to exactly one span. Only a merge that crosses
 * a block boundary appends a new span. `clause.text` is always *derived*
 * from `spans` (never stored independently), so the round-trip invariant —
 * joining `blockTexts[s.blockIndex].slice(s.start, s.end)` over all spans
 * with a single space between spans from different blocks reproduces
 * `clause.text` exactly — holds by construction.
 *
 * @param {string[]} blockTexts ordered block text; nav/header/footer/script/style already removed
 * @returns {Clause[]} spans[].blockIndex indexes into blockTexts
 */
export function segmentBlocks(blockTexts) {
  /** @type {{ blockIndex: number, start: number, end: number, text: string }[]} */
  const rawFragments = [];
  for (let i = 0; i < blockTexts.length; i++) {
    const text = typeof blockTexts[i] === 'string' ? blockTexts[i] : '';
    rawFragments.push(...extractFragments(i, text));
  }

  // Rule 4: drop fragments under MIN_FRAGMENT_LENGTH chars, unless they end
  // in terminal sentence punctuation — those are complete short clauses,
  // not headings/nav scraps, and must survive. Two exceptions layered on
  // top, in order:
  //   - Primary: a fragment that is nothing but a section marker ("O.",
  //     "3.", "4.2.1.") is always dropped, full stop — enumeration
  //     scaffolding is never a clause, no matter its punctuation.
  //   - Secondary floor: the carve-out itself only applies to a fragment
  //     that reads like a real sentence (>=2 words, >=8 chars). This is
  //     what catches bare-marker variants the marker regex above doesn't
  //     recognize — a bare enumeration letter ("H.", "O.") or a bare roman
  //     numeral ("iv.") — since those are single "words" regardless.
  const surviving = rawFragments.filter((f) => {
    if (isBareMarker(f.text)) return false;
    if (f.text.length >= MIN_FRAGMENT_LENGTH) return true;
    if (!TERMINAL_PUNCTUATION.test(f.text)) return false;
    const wordCount = f.text.trim().split(/\s+/).filter(Boolean).length;
    return f.text.length >= CARVEOUT_MIN_LENGTH && wordCount >= CARVEOUT_MIN_WORDS;
  });

  // Rule 5: merge fragments under MERGE_THRESHOLD chars into their
  // predecessor, coalescing same-block spans as we go — except fragments
  // "protected" by the rule-4 carve-out above, which are sealed off from
  // merging in either direction.
  /** @type {{ spans: Span[], protected: boolean }[]} */
  const clauses = [];
  for (const frag of surviving) {
    const isProtectedShort =
      frag.text.length < MIN_FRAGMENT_LENGTH && TERMINAL_PUNCTUATION.test(frag.text);
    const predecessor = clauses[clauses.length - 1];
    const canMergeIntoPredecessor =
      predecessor &&
      !predecessor.protected &&
      !isProtectedShort &&
      frag.text.length < MERGE_THRESHOLD;

    if (canMergeIntoPredecessor) {
      const spans = predecessor.spans;
      const lastSpan = spans[spans.length - 1];
      if (lastSpan.blockIndex === frag.blockIndex) {
        lastSpan.end = frag.end;
      } else {
        spans.push({ blockIndex: frag.blockIndex, start: frag.start, end: frag.end });
      }
    } else {
      clauses.push({
        spans: [{ blockIndex: frag.blockIndex, start: frag.start, end: frag.end }],
        protected: isProtectedShort,
      });
    }
  }

  return clauses.map((clause, i) => ({
    id: `c${i}`,
    text: renderSpans(clause.spans, blockTexts),
    spans: clause.spans,
  }));
}

/**
 * Collapse whitespace, lowercase, strip punctuation. Used for cache keys
 * (spec §6.1): `sha256(normalize(clause_text) + question_version)`.
 *
 * Punctuation is replaced with a space (not deleted outright) so word
 * boundaries survive — "arm's-length" normalizes to "arm s length" rather
 * than the run-together "armslength".
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeForHash(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
