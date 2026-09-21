// extension/detect.js
//
// Spec §3.2: advisory legal-page detection. Both signals (URL and density)
// must hold for isLegal, but per the Phase 3 build order (§9 step 3) this
// result is advisory only in this phase — logged, never used to gate a
// manual scan. Auto-triggering off this result is Phase 5 (§9 step 5).
//
// No ESM import/export — classic script injected via
// chrome.scripting.executeScript, published on globalThis.__FPF instead.

(function () {
  const URL_LEGAL_RE = /(terms|tos|eula|privacy|legal|conditions|agreement)/i;

  // Same eight markers as spec §3.2, checked as substrings against
  // lowercased document text (so "indemnif" matches indemnify/indemnified/
  // indemnification, "sole discretion" as a phrase, etc).
  const DENSITY_MARKERS = [
    'herein',
    'shall',
    'thereof',
    'waive',
    'arbitration',
    'indemnif',
    'notwithstanding',
    'sole discretion',
  ];

  const MIN_WORD_COUNT = 1500;
  const MIN_MARKER_HITS = 3;

  // Block tags used purely for the word-count density signal here — kept
  // in sync with domwalk.js's BLOCK_TAGS/isChildlessDiv rules so "words in
  // block elements" means the same thing in both places. Not reusing
  // walkBlocks() directly because detect.js must stay independently
  // callable (e.g. testable, or invoked before domwalk.js has been
  // injected) and because it only needs raw word count, not the
  // parallel-array node bookkeeping walkBlocks provides.
  const BLOCK_TAGS = new Set(['P', 'LI', 'TD', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV']);
  const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

  function countWordsInBlocks(doc) {
    let total = 0;
    const seen = new Set();
    const all = doc.querySelectorAll(Array.from(BLOCK_TAGS).join(','));
    for (const el of all) {
      // Avoid double-counting a childless DIV inside a counted ancestor,
      // and avoid double-counting nested block tags (e.g. a heading that
      // somehow sits inside a TD) by only counting leaf-ish text directly
      // via textContent once per element, then summing — small
      // overcounts from nesting are acceptable here since this signal is
      // advisory-only and just needs a coarse threshold check, not an
      // exact figure.
      if (seen.has(el)) continue;
      seen.add(el);
      const text = (el.textContent || '').trim();
      if (!text) continue;
      const words = text.split(/\s+/).filter(Boolean);
      total += words.length;
    }
    return total;
  }

  function countMarkerHits(lowerText) {
    let hits = 0;
    for (const marker of DENSITY_MARKERS) {
      if (lowerText.includes(marker)) hits += 1;
    }
    return hits;
  }

  function urlMatches(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return URL_LEGAL_RE.test(parsed.pathname);
    } catch {
      // Not a parseable absolute URL (e.g. already just a path, or a
      // test harness passing a bare string) — fall back to testing the
      // raw string directly.
      return URL_LEGAL_RE.test(url);
    }
  }

  function headingMatches(doc) {
    const headings = doc.querySelectorAll(Array.from(HEADING_TAGS).join(','));
    for (const h of headings) {
      const text = (h.textContent || '').trim();
      if (text && URL_LEGAL_RE.test(text)) return true;
    }
    return false;
  }

  /**
   * Advisory legal-page detection per spec §3.2. Does NOT gate a manual
   * scan in this phase — it is logged only. Both urlSignal and
   * densitySignal must hold for isLegal to be true.
   *
   * @param {Document} doc
   * @param {string} url
   * @returns {{isLegal: boolean, urlSignal: boolean, densitySignal: boolean,
   *            wordCount: number, markerHits: number}}
   */
  function detectLegalPage(doc, url) {
    const urlSignal = urlMatches(url) || headingMatches(doc);

    const wordCount = countWordsInBlocks(doc);
    const bodyText = (doc.body ? doc.body.textContent : doc.textContent) || '';
    const markerHits = countMarkerHits(bodyText.toLowerCase());
    const densitySignal = wordCount >= MIN_WORD_COUNT && markerHits >= MIN_MARKER_HITS;

    const isLegal = urlSignal && densitySignal;

    return { isLegal, urlSignal, densitySignal, wordCount, markerHits };
  }

  globalThis.__FPF = globalThis.__FPF || {};
  globalThis.__FPF.detectLegalPage = detectLegalPage;
})();
