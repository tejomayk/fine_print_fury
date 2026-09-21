import { describe, it, expect } from 'vitest';
import { segmentBlocks, normalizeForHash } from './segment.js';

/**
 * Reconstruct a clause's text purely from its spans and the original
 * `blockTexts` array, per the contract: join each span's raw slice, with a
 * single space between spans from different blocks.
 */
function renderSpans(clause, blockTexts) {
  return clause.spans.map((s) => blockTexts[s.blockIndex].slice(s.start, s.end)).join(' ');
}

function assertRoundTrip(clauses, blockTexts) {
  for (const clause of clauses) {
    expect(clause.spans.length).toBeGreaterThan(0);
    for (const span of clause.spans) {
      expect(span.blockIndex).toBeGreaterThanOrEqual(0);
      expect(span.blockIndex).toBeLessThan(blockTexts.length);
      expect(span.start).toBeGreaterThanOrEqual(0);
      expect(span.end).toBeGreaterThan(span.start);
      expect(span.end).toBeLessThanOrEqual(blockTexts[span.blockIndex].length);
    }
    expect(renderSpans(clause, blockTexts)).toBe(clause.text);
  }
}

describe('segmentBlocks — numbered-item splitting', () => {
  it('splits on "1." / "2." item markers', () => {
    const frag1 =
      '1. The Company may modify these Terms of Service at any time without prior written notice to the user.';
    const frag2 =
      '2. Continued use of the Service after any such changes constitutes binding acceptance of the modified Terms.';
    const blockTexts = [`${frag1} ${frag2}`];

    const clauses = segmentBlocks(blockTexts);

    expect(clauses.map((c) => c.text)).toEqual([frag1, frag2]);
    assertRoundTrip(clauses, blockTexts);
  });

  it('splits on "(a)" / "(b)" lettered item markers', () => {
    const fragA =
      '(a) The Provider shall not be liable for any indirect, incidental, or consequential damages arising from use of the Service.';
    const fragB =
      "(b) The Customer shall indemnify and hold harmless the Provider against any claims arising from the Customer's breach of these Terms.";
    const blockTexts = [`${fragA} ${fragB}`];

    const clauses = segmentBlocks(blockTexts);

    expect(clauses.map((c) => c.text)).toEqual([fragA, fragB]);
    assertRoundTrip(clauses, blockTexts);
  });

  it('splits on roman-numeral item markers like "(iv)"', () => {
    const fragThree =
      '(iii) The Licensee shall not sublicense, resell, or otherwise transfer rights granted under this Agreement to any third party.';
    const fragFour =
      '(iv) The Licensor reserves the right to audit usage records at any time upon fourteen days written notice to the Licensee.';
    const blockTexts = [`${fragThree} ${fragFour}`];

    const clauses = segmentBlocks(blockTexts);

    expect(clauses.map((c) => c.text)).toEqual([fragThree, fragFour]);
    assertRoundTrip(clauses, blockTexts);
  });

  it('splits on the "§" section symbol', () => {
    const intro =
      'The Company may terminate this Agreement and suspend your account at its sole discretion at any time for any reason.';
    const section =
      '§5 Governing law shall be the law of the State of Delaware without regard to its conflict of laws principles and provisions.';
    const blockTexts = [`${intro} ${section}`];

    const clauses = segmentBlocks(blockTexts);

    expect(clauses.map((c) => c.text)).toEqual([intro, section]);
    assertRoundTrip(clauses, blockTexts);
  });

  it('splits on multi-level numbering like "4.2.1"', () => {
    const intro =
      'The Company may terminate this Agreement and suspend your account at its sole discretion at any time for any reason.';
    const item =
      '4.2.1 In no event shall either party be liable to the other for any special, incidental, or consequential damages arising hereunder.';
    const blockTexts = [`${intro} ${item}`];

    const clauses = segmentBlocks(blockTexts);

    expect(clauses.map((c) => c.text)).toEqual([intro, item]);
    assertRoundTrip(clauses, blockTexts);
  });
});

describe('segmentBlocks — sentence boundaries and the abbreviation guard', () => {
  it('does not split on "Inc.", "e.g.", "U.S.", or "No."', () => {
    const s1 =
      'This Agreement is entered into by Example Corp, Inc. and governs use of the Service by all registered users.';
    const s2 =
      'For example, e.g. arbitration clauses like this one are enforceable under the Federal Arbitration Act in the U.S. and its territories.';
    const s3 =
      'See Rejection No. 5 for a full explanation of the grounds on which your submission was declined by the review board.';
    const blockTexts = [`${s1} ${s2} ${s3}`];

    const clauses = segmentBlocks(blockTexts);

    // Each sentence survives whole — none of the guarded abbreviations
    // caused a mid-sentence split.
    expect(clauses.map((c) => c.text)).toEqual([s1, s2, s3]);
    assertRoundTrip(clauses, blockTexts);
  });

  it('still splits on the genuine sentence boundary that follows a guarded abbreviation', () => {
    // "U.S." sits mid-sentence here (not at the sentence's own end), so the
    // guard must suppress a split right after it while the real sentence
    // boundary later on still fires normally.
    const s1 =
      'The parties agree that this Agreement is governed by the laws of the U.S. and no other jurisdiction.';
    const s2 =
      'Any dispute not resolved informally shall be submitted to binding arbitration administered by a neutral third party.';
    const blockTexts = [`${s1} ${s2}`];

    const clauses = segmentBlocks(blockTexts);

    expect(clauses).toHaveLength(2);
    expect(clauses[0].text).toBe(s1);
    expect(clauses[1].text).toBe(s2);
    assertRoundTrip(clauses, blockTexts);
  });
});

describe('segmentBlocks — rule 4: drop under 40 chars only when not a complete sentence', () => {
  const KEPT_SHORT_CLAUSES = [
    'No refunds.',
    'Arbitration is mandatory.',
    'You agree to indemnify us.',
    'You waive all claims.',
    'This license survives termination.',
  ];

  const DROPPED_FRAGMENTS = [
    'TERMS OF SERVICE',
    'Table of Contents',
    'Last updated: January 2026',
  ];

  it.each(KEPT_SHORT_CLAUSES)(
    'keeps the short but complete sentence %j even though it is under 40 chars',
    (sentence) => {
      expect(sentence.length).toBeLessThan(40);
      const clauses = segmentBlocks([sentence]);
      expect(clauses.map((c) => c.text)).toContain(sentence);
    },
  );

  it.each(DROPPED_FRAGMENTS)('drops the heading/nav-scrap fragment %j', (fragment) => {
    const clauses = segmentBlocks([fragment]);
    expect(clauses).toEqual([]);
  });

  it('keeps short complete sentences alongside real content, dropping only true headings', () => {
    // Headings sit in their own block element in real markup (an `h1`/`h2`,
    // or at least a separate text container from the body copy) — modeled
    // here as separate array entries rather than run together in one
    // string with no punctuation between them.
    const heading = 'TERMS OF SERVICE';
    const intro =
      'The Company may terminate this Agreement and suspend your account at its sole discretion at any time for any reason.';
    const punchy = 'No refunds.';
    const blockTexts = [heading, intro, punchy];

    const clauses = segmentBlocks(blockTexts);

    const texts = clauses.map((c) => c.text);
    expect(texts).not.toContain(heading);
    expect(texts).toContain(intro);
    expect(texts).toContain(punchy);
    assertRoundTrip(clauses, blockTexts);
  });

  it('drops a whitespace-only block, producing no clauses', () => {
    expect(segmentBlocks(['   \n\t  '])).toEqual([]);
  });
});

describe('segmentBlocks — bare section markers are always dropped (GitHub ToS false-positive fix)', () => {
  // Real corpus evidence: GitHub's ToS enumerates sections as "H.", "I.",
  // "J." ... each alone in its own block. Each is 2 chars and ends in a
  // period, so the rule-4 terminal-punctuation carve-out used to keep them,
  // and Jev then scored them as clauses (55-86% probability, mostly
  // liability_dodge) — 15 of 72 flagged clauses on the real document were
  // bare letters. Two independent checks fix this: (1) a fragment that is
  // nothing but a marker (empty remainder after stripping it) is always
  // dropped; (2) the carve-out itself now requires >=2 words and >=8 chars,
  // which catches marker forms `TITLE_MARKER_RE` doesn't recognize, like a
  // bare enumeration letter ("H.", "O.") or a bare roman numeral ("iv.").
  const BARE_MARKERS = ['O.', 'H.', 'iv.', '(a)', '3.', '4.2.1.'];

  it.each(BARE_MARKERS)('drops the bare marker %j with no remainder', (marker) => {
    expect(segmentBlocks([marker])).toEqual([]);
  });

  it('drops bare enumeration letters interspersed with real clauses, without disturbing the real clauses', () => {
    const intro =
      'The Company may terminate this Agreement and suspend your account at its sole discretion at any time for any reason.';
    const punchy = 'No refunds.';
    const blockTexts = ['H.', intro, 'I.', punchy, 'J.'];

    const clauses = segmentBlocks(blockTexts);

    expect(clauses.map((c) => c.text)).toEqual([intro, punchy]);
    assertRoundTrip(clauses, blockTexts);
  });

  it('still keeps a marker fragment that has real content after it, with nothing following in the block', () => {
    // "5. No refunds." has a marker AND a non-empty remainder, and it's
    // alone in its block — the bare-marker rule must not touch it.
    const blockTexts = ['5. No refunds.'];
    const clauses = segmentBlocks(blockTexts);

    expect(clauses).toHaveLength(1);
    expect(clauses[0].text).toBe('5. No refunds.');
    assertRoundTrip(clauses, blockTexts);
  });

  it('the carve-out floor still keeps genuine short multi-word clauses', () => {
    const genuineShortClauses = [
      'No refunds.',
      'All sales are final.',
      'Arbitration is mandatory.',
      'You agree to indemnify us.',
    ];
    for (const sentence of genuineShortClauses) {
      const clauses = segmentBlocks([sentence]);
      expect(clauses.map((c) => c.text)).toEqual([sentence]);
    }
  });
});

describe('segmentBlocks — rule 4/5 interaction: protected short sentences do not get merged away', () => {
  it('keeps a sub-40-char complete sentence as its own clause instead of folding it into its predecessor', () => {
    const long =
      'The Company may terminate this Agreement and suspend your account at its sole discretion at any time for any reason.';
    const punchy = 'No refunds.'; // 11 chars, well under both the 40 and 100 thresholds
    const blockTexts = [`${long} ${punchy}`];

    const clauses = segmentBlocks(blockTexts);

    // Without the rule 4/5 interaction fix, this would be a single
    // 129-char merged clause and "No refunds." would lose its own
    // highlight/verdict. It must stand alone instead.
    expect(clauses).toHaveLength(2);
    expect(clauses[0].text).toBe(long);
    expect(clauses[1].text).toBe(punchy);
    assertRoundTrip(clauses, blockTexts);
  });

  it('still merges an ordinary 40-99 char fragment that is not relying on the rule-4 carve-out', () => {
    const long =
      'The Company may terminate this Agreement and suspend your account at its sole discretion at any time for any reason.';
    const ordinaryShort = 'This provision survives termination of the Agreement.'; // 53 chars — already >=40, no carve-out involved
    const blockTexts = [`${long} ${ordinaryShort}`];

    const clauses = segmentBlocks(blockTexts);

    // This fragment didn't need the terminal-punctuation exception to
    // survive rule 4 (it's already >=40 chars), so the merge-away behavior
    // from rule 5 is unaffected by the fix.
    expect(clauses).toHaveLength(1);
    expect(clauses[0].text).toBe(`${long} ${ordinaryShort}`);
    expect(clauses[0].spans).toHaveLength(1);
    assertRoundTrip(clauses, blockTexts);
  });

  it('keeps several consecutive protected short sentences each as their own clause', () => {
    const long =
      'The Company may terminate this Agreement and suspend your account at its sole discretion at any time for any reason.';
    const p1 = 'No refunds.';
    const p2 = 'You waive all claims.';
    const blockTexts = [`${long} ${p1} ${p2}`];

    const clauses = segmentBlocks(blockTexts);

    expect(clauses.map((c) => c.text)).toEqual([long, p1, p2]);
    assertRoundTrip(clauses, blockTexts);
  });
});

describe('segmentBlocks — cross-block merge (the hard case)', () => {
  it('merges a short fragment starting block N into the clause ending block N-1, producing two spans', () => {
    const blockZeroText =
      'The Company may terminate this Agreement and suspend your account at its sole discretion at any time for any reason.';
    const bridge = 'This clause continues the point raised above in the prior section.'; // 66 chars, under 100
    const rest =
      "The arbitrator's decision shall be final and binding on both parties and may be entered as a judgment in any court of competent jurisdiction.";
    const blockTexts = [blockZeroText, `${bridge} ${rest}`];

    const clauses = segmentBlocks(blockTexts);

    expect(clauses).toHaveLength(2);

    const merged = clauses[0];
    expect(merged.text).toBe(`${blockZeroText} ${bridge}`);
    // The defining assertion: this clause touches two blocks, so it must
    // carry exactly one span per block, in order.
    expect(merged.spans).toHaveLength(2);
    expect(merged.spans[0].blockIndex).toBe(0);
    expect(merged.spans[1].blockIndex).toBe(1);
    // Block-0 span covers the whole of block 0's contribution.
    expect(blockTexts[0].slice(merged.spans[0].start, merged.spans[0].end)).toBe(blockZeroText);
    // Block-1 span covers just the bridging fragment, not `rest`.
    expect(blockTexts[1].slice(merged.spans[1].start, merged.spans[1].end)).toBe(bridge);

    expect(clauses[1].text).toBe(rest);
    expect(clauses[1].spans).toHaveLength(1);
    expect(clauses[1].spans[0].blockIndex).toBe(1);

    assertRoundTrip(clauses, blockTexts);
  });

  it('a protected short sentence between two ordinary blocks stands alone rather than bridging them', () => {
    const blockTexts = [
      'The Company may terminate this Agreement at its sole discretion for any reason whatsoever.',
      'This continues.', // 15 chars, but ends in "." — protected: survives rule 4, sealed from rule 5 in both directions
      'Subject to the notice period described elsewhere in this Agreement.', // 69 chars, ordinary short (not protected)
    ];

    const clauses = segmentBlocks(blockTexts);

    // Block 1's fragment is short but a complete sentence, so it is kept
    // and — because protection is sealed in both directions — it neither
    // merges backward into block 0's clause nor absorbs block 2's ordinary
    // short fragment into itself. Block 2's fragment has nothing to merge
    // into (its would-be predecessor is protected) and stands alone too.
    expect(clauses.map((c) => c.text)).toEqual([blockTexts[0], blockTexts[1], blockTexts[2]]);
    for (const c of clauses) {
      expect(c.spans).toHaveLength(1);
    }
    assertRoundTrip(clauses, blockTexts);
  });

  it('still bridges three blocks into one clause when the middle fragment truly lacks terminal punctuation', () => {
    const blockTexts = [
      'The Company may terminate this Agreement at its sole discretion for any reason whatsoever.',
      'See above', // 9 chars, no terminal punctuation: dropped by rule 4
      'Subject to the notice period described elsewhere in this Agreement.', // under 100
    ];

    const clauses = segmentBlocks(blockTexts);

    // Block 1's only fragment is dropped (under 40, no terminal
    // punctuation), so the clause only ends up touching blocks 0 and 2 —
    // never a dangling span into block 1.
    expect(clauses).toHaveLength(1);
    expect(clauses[0].spans.map((s) => s.blockIndex)).toEqual([0, 2]);
    assertRoundTrip(clauses, blockTexts);
  });
});

describe('segmentBlocks — severed section titles merge forward into their body', () => {
  it('keeps a standalone short clause with no marker alone in its own block', () => {
    const blockTexts = ['No refunds.'];
    const clauses = segmentBlocks(blockTexts);

    expect(clauses).toHaveLength(1);
    expect(clauses[0].text).toBe('No refunds.');
    assertRoundTrip(clauses, blockTexts);
  });

  it('keeps a marker-prefixed short clause alone when nothing follows it in the block', () => {
    // The critical discriminator: "5. No refunds." has a marker and a short
    // remainder, exactly like a title, but there is no body after it in
    // this block, so it must NOT be folded into anything.
    const blockTexts = ['5. No refunds.'];
    const clauses = segmentBlocks(blockTexts);

    expect(clauses).toHaveLength(1);
    expect(clauses[0].text).toBe('5. No refunds.');
    assertRoundTrip(clauses, blockTexts);
  });

  it('merges "2. Arbitration." forward into its body as one clause', () => {
    const text =
      '2. Arbitration. You agree that any dispute shall be resolved by binding arbitration on an individual basis.';
    const clauses = segmentBlocks([text]);

    expect(clauses).toHaveLength(1);
    expect(clauses[0].text).toBe(text);
    expect(clauses[0].spans).toHaveLength(1);
    assertRoundTrip(clauses, [text]);
  });

  it('merges "1. Acceptance of Terms." forward into its body as one clause', () => {
    const text =
      '1. Acceptance of Terms. By accessing the Service you agree to be bound by these Terms.';
    const clauses = segmentBlocks([text]);

    expect(clauses).toHaveLength(1);
    expect(clauses[0].text).toBe(text);
    assertRoundTrip(clauses, [text]);
  });

  it('merges multi-level "4.2.1. Data Sharing." forward into its body as one clause', () => {
    const text =
      '4.2.1. Data Sharing. We may share your personal data with third-party advertisers.';
    const clauses = segmentBlocks([text]);

    expect(clauses).toHaveLength(1);
    expect(clauses[0].text).toBe(text);
    assertRoundTrip(clauses, [text]);
  });

  it('does not treat a marker-prefixed fragment as a title when the remainder is over 60 chars', () => {
    // The whole sentence after "1." is the clause itself, not a short
    // label — over the 60-char remainder cap, so it's real content, and
    // there is nothing after it to have merged into anyway.
    const text =
      '1. You agree that any dispute arising under these Terms shall be resolved by binding arbitration administered by JAMS.';
    const clauses = segmentBlocks([text]);

    expect(clauses).toHaveLength(1);
    expect(clauses[0].text).toBe(text);
    assertRoundTrip(clauses, [text]);
  });

  it('does not fold a title across a block boundary — the discriminator is scoped to one block', () => {
    const titleOnly = '5. No refunds.';
    const nextBlock =
      'This is a separate paragraph entirely unrelated to the refund policy stated earlier in the document.';
    const blockTexts = [titleOnly, nextBlock];

    const clauses = segmentBlocks(blockTexts);

    expect(clauses.map((c) => c.text)).toEqual([titleOnly, nextBlock]);
    assertRoundTrip(clauses, blockTexts);
  });

  describe('interaction with the protected flag', () => {
    it('a title merging forward into what would have been a protected short clause becomes one protected unit', () => {
      // "3. Refunds." is a title (marker + short remainder, more text
      // follows), so it folds forward into "No refunds." — which, on its
      // own, would have qualified as a protected short clause under rule
      // 4/5. The combined fragment is evaluated fresh: it's still under 40
      // chars and ends in terminal punctuation, so *it* becomes the
      // protected unit instead, standing alone.
      const text = '3. Refunds. No refunds.';
      expect(text.length).toBeLessThan(40);

      const clauses = segmentBlocks([text]);

      expect(clauses).toHaveLength(1);
      expect(clauses[0].text).toBe(text);
      assertRoundTrip(clauses, [text]);
    });

    it('the resulting protected title+clause unit is sealed off from neighbors in both directions', () => {
      const intro =
        'The Company may terminate this Agreement and suspend your account at its sole discretion at any time for any reason.';
      const titlePlusShortClause = '3. Refunds. No refunds.';
      const ordinaryShortFollower =
        'This clause continues an unrelated topic entirely on its own accord.';
      const blockTexts = [intro, titlePlusShortClause, ordinaryShortFollower];

      const clauses = segmentBlocks(blockTexts);

      // Neither neighbor absorbs the protected title+clause unit, and it
      // doesn't absorb either of them: three distinct clauses.
      expect(clauses.map((c) => c.text)).toEqual([intro, titlePlusShortClause, ordinaryShortFollower]);
      for (const c of clauses) {
        expect(c.spans).toHaveLength(1);
      }
      assertRoundTrip(clauses, blockTexts);
    });

    it('when the title pushes the combined fragment to 40+ chars, it is an ordinary (unprotected) clause and can still rule-5-merge across a block boundary', () => {
      const intro =
        'The Company may terminate this Agreement and suspend your account at its sole discretion at any time for any reason.';
      const titledClause = '6. Interpretation. Headings in this Agreement are for convenience only.';
      expect(titledClause.length).toBeGreaterThanOrEqual(40);
      expect(titledClause.length).toBeLessThan(100);
      const blockTexts = [intro, titledClause];

      const clauses = segmentBlocks(blockTexts);

      // The forward-merged (title+body) fragment from block 1 is ordinary
      // short (not protected), so it still undergoes its own separate
      // rule-5 backward merge into block 0's clause — crossing a block
      // boundary, producing two spans on one clause.
      expect(clauses).toHaveLength(1);
      expect(clauses[0].text).toBe(`${intro} ${titledClause}`);
      expect(clauses[0].spans).toHaveLength(2);
      expect(clauses[0].spans[0].blockIndex).toBe(0);
      expect(clauses[0].spans[1].blockIndex).toBe(1);
      assertRoundTrip(clauses, blockTexts);
    });
  });
});

describe('segmentBlocks — stable ids', () => {
  it('assigns sequential c0, c1, c2, ... ids across the whole document', () => {
    const blockTexts = [
      '1. The Company may modify these Terms of Service at any time without prior written notice to the user. ' +
        '2. Continued use of the Service after any such changes constitutes binding acceptance of the modified Terms.',
      '(a) The Provider shall not be liable for any indirect, incidental, or consequential damages arising from use of the Service.',
    ];

    const clauses = segmentBlocks(blockTexts);

    expect(clauses.map((c) => c.id)).toEqual(clauses.map((_, i) => `c${i}`));
    expect(clauses.length).toBeGreaterThanOrEqual(3);
  });
});

describe('segmentBlocks — edge cases', () => {
  it('returns [] for empty input', () => {
    expect(segmentBlocks([])).toEqual([]);
  });

  it('returns [] for a single whitespace-only block', () => {
    expect(segmentBlocks(['\n\n   \t  '])).toEqual([]);
  });

  it('handles a single block with one sentence', () => {
    const text =
      'By clicking accept, you agree to be bound by all of the terms and conditions set forth in this lengthy user agreement.';
    const blockTexts = [text];

    const clauses = segmentBlocks(blockTexts);

    expect(clauses).toHaveLength(1);
    expect(clauses[0].id).toBe('c0');
    expect(clauses[0].text).toBe(text);
    expect(clauses[0].spans).toEqual([{ blockIndex: 0, start: 0, end: text.length }]);
    assertRoundTrip(clauses, blockTexts);
  });
});

describe('normalizeForHash', () => {
  it('is deterministic across whitespace and case variants of the same text', () => {
    const variants = [
      'You agree that any dispute shall be resolved by binding arbitration.',
      'YOU AGREE THAT ANY DISPUTE SHALL BE RESOLVED BY BINDING ARBITRATION.',
      '  You   agree  that any dispute\nshall be resolved by binding arbitration.  ',
      'You agree that any dispute shall be resolved by binding arbitration',
    ];

    const normalized = variants.map(normalizeForHash);
    for (const n of normalized) {
      expect(n).toBe(normalized[0]);
    }
    expect(normalized[0]).toBe('you agree that any dispute shall be resolved by binding arbitration');
  });

  it('produces different output for genuinely different text', () => {
    expect(normalizeForHash('forced arbitration clause')).not.toBe(
      normalizeForHash('class action waiver clause'),
    );
  });
});
