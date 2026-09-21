import { describe, it, expect } from 'vitest';
import { CATEGORIES, buildQuestions } from './questions.js';
import { CATEGORY_WEIGHTS, DEFAULT_K, rollupScore } from './weights.js';

describe('CATEGORY_WEIGHTS keys', () => {
  it('exactly matches Object.keys(CATEGORIES) — same set, no extras, no missing', () => {
    // The single most important test here: if a category in CATEGORIES is
    // missing from CATEGORY_WEIGHTS (or a key is typo'd on either side),
    // rollupScore's `weight * probability` silently becomes `undefined *
    // number = NaN` at runtime, and NaN propagates through the whole page
    // score.
    const categoryKeys = Object.keys(CATEGORIES).sort();
    const weightKeys = Object.keys(CATEGORY_WEIGHTS).sort();
    expect(weightKeys).toEqual(categoryKeys);
    // Sanity: there really are 15 categories per spec §4.1.
    expect(categoryKeys).toHaveLength(15);
  });
});

describe('rollupScore — hand-computed values', () => {
  it('one flagged clause out of 20, p=0.8, class_action_waiver (weight 1.0), k=0.06 (DEFAULT_K)', () => {
    // raw     = 0.8 * 1.0 = 0.8
    // density = raw / totalClauses = 0.8 / 20 = 0.04
    // score   = round(100 * (1 - e^(-0.04/0.06))) = round(100 * (1 - e^-0.666667))
    //         e^-0.666667 ≈ 0.513417
    //         1 - 0.513417 = 0.486583
    //         100 * 0.486583 ≈ 48.658 → rounds to 49
    const score = rollupScore([{ probability: 0.8, category: 'class_action_waiver' }], 20);
    expect(score).toBe(49);
  });

  it('two flagged clauses out of 50, mixed categories, k=0.06 (DEFAULT_K)', () => {
    // clause 1: p=0.9, forced_arbitration, weight 1.0 -> 0.9 * 1.0 = 0.90
    // clause 2: p=0.7, no_refunds,         weight 0.3 -> 0.7 * 0.3 = 0.21
    // raw     = 0.90 + 0.21 = 1.11
    // density = 1.11 / 50 = 0.0222
    // score   = round(100 * (1 - e^(-0.0222/0.06))) = round(100 * (1 - e^-0.37))
    //         e^-0.37 ≈ 0.690734
    //         1 - 0.690734 = 0.309266
    //         100 * 0.309266 ≈ 30.927 → rounds to 31
    const score = rollupScore(
      [
        { probability: 0.9, category: 'forced_arbitration' },
        { probability: 0.7, category: 'no_refunds' },
      ],
      50,
    );
    expect(score).toBe(31);
  });
});

describe('rollupScore — density corpus regression (spec §4.3, re-calibrated 2026-09-20)', () => {
  // These pin the exact real-world numbers the K=0.06 recalibration was
  // measured against, so a future change to the formula or DEFAULT_K shows
  // up here immediately instead of only at scan time.
  //
  // This replaces an earlier version of this test pinned to K=0.10's
  // density->score pairs (github 0.089->59, spotify 0.150->78, etc.),
  // measured at FLAG_THRESHOLD=0.55 under QUESTION_VERSION='v1'. Raising
  // the threshold to 0.65 and shipping the v2 Noul wording (see
  // questions.js) dropped flag rates from 28-37% to 11-18%, which dropped
  // every document's *density* — K is a function of the flag threshold and
  // question wording, not a standalone constant (see the DEFAULT_K comment
  // in weights.js), so those old pairs are now stale and have been
  // replaced with the re-measured densities below.
  //
  // One flagged clause whose probability × weight equals the target raw
  // score, over a totalClauses chosen to reproduce the corpus's measured
  // density.
  it.each([
    ['github', 0.0386, 47],
    ['lease', 0.0446, 52],
    ['saas-eula', 0.0511, 57],
    ['airline-coc', 0.0598, 63],
    ['spotify', 0.0777, 73],
  ])('%s: density %f -> score %i', (_name, density, expected) => {
    // raw / totalClauses = density  =>  pick totalClauses=1, raw=density,
    // achieved with a single flagged clause of probability=density against
    // a weight-1.0 category (forced_arbitration).
    const score = rollupScore([{ probability: density, category: 'forced_arbitration' }], 1);
    expect(score).toBe(expected);
  });
});

describe('rollupScore — edge cases', () => {
  it('empty flagged array scores 0', () => {
    expect(rollupScore([], 200)).toBe(0);
  });

  it('totalClauses <= 0 scores 0 even with flagged clauses present', () => {
    expect(rollupScore([{ probability: 0.9, category: 'forced_arbitration' }], 0)).toBe(0);
    expect(rollupScore([{ probability: 0.9, category: 'forced_arbitration' }], -5)).toBe(0);
  });

  it('does NOT let document length alone move the score: equal density, very different clause counts, same score', () => {
    // This is the entire point of the density rewrite (spec §4.3's stated
    // intent, which the old undivided-sum formula did not deliver — see
    // the DEFAULT_K comment in weights.js): a short document and a long
    // document with the same proportion of harmful clauses must land on
    // the same page score.
    //
    // Doc A: 1 flagged clause, p=0.5, forced_arbitration (weight 1.0), out
    //        of 10 total clauses.
    //        raw = 0.5 * 1.0 = 0.5  ->  density = 0.5 / 10  = 0.05
    // Doc B: 10 flagged clauses, each p=0.5, forced_arbitration, out of
    //        100 total clauses (10x the clauses, 10x the flags, same mix).
    //        raw = 10 * (0.5 * 1.0) = 5.0  ->  density = 5.0 / 100 = 0.05
    // Same density -> same score, even though doc B has 10x the raw sum
    // and 10x the clause count of doc A.
    const docA = rollupScore([{ probability: 0.5, category: 'forced_arbitration' }], 10);
    const docB = rollupScore(
      Array.from({ length: 10 }, () => ({ probability: 0.5, category: 'forced_arbitration' })),
      100,
    );
    // score = round(100 * (1 - e^(-0.05/0.06))) = round(100 * (1 - e^-0.833333))
    //       e^-0.833333 ≈ 0.434598 -> 1 - 0.434598 = 0.565402 -> ≈ 56.540 -> 57
    expect(docA).toBe(57);
    expect(docB).toBe(57);
    expect(docA).toBe(docB);
  });

  it('never produces NaN for an "unclear" category', () => {
    const score = rollupScore([{ probability: 0.8, category: 'unclear' }], 10);
    expect(Number.isNaN(score)).toBe(false);
    expect(typeof score).toBe('number');
    // raw     = 0.8 * UNCLEAR_WEIGHT(0.5) = 0.4
    // density = 0.4 / 10 = 0.04
    // score   = round(100 * (1 - e^(-0.04/0.06))) ≈ round(48.658) = 49
    expect(score).toBe(49);
  });

  it('never produces NaN for a completely unknown/typo\'d category', () => {
    const score = rollupScore([{ probability: 0.7, category: 'not_a_real_category' }], 10);
    expect(Number.isNaN(score)).toBe(false);
    // Falls back to the same UNCLEAR_WEIGHT (0.5) as "unclear".
    // raw = 0.7 * 0.5 = 0.35 -> density = 0.35 / 10 = 0.035
    // score = round(100 * (1 - e^(-0.035/0.06))) ≈ round(43.539) = 44
    expect(score).toBe(44);
  });

  it('never produces NaN for a malformed entry (missing/NaN probability)', () => {
    const score = rollupScore(
      [{ probability: NaN, category: 'forced_arbitration' }, { category: 'benign' }],
      10,
    );
    expect(Number.isNaN(score)).toBe(false);
    expect(score).toBe(0);
  });

  it('guards against a non-positive k instead of dividing by zero', () => {
    const score = rollupScore([{ probability: 0.5, category: 'benign' }], 10, 0);
    expect(Number.isNaN(score)).toBe(false);
  });

  it('DEFAULT_K is the documented, corpus-calibrated value', () => {
    expect(DEFAULT_K).toBe(0.06);
  });
});

describe('buildQuestions', () => {
  it('produces harm_i/cat_i for every clause index with correct types and full category criteria', () => {
    const clauses = ['clause A text long enough to survive segmentation.', 'clause B text.', 'clause C text.'];
    const questions = buildQuestions(clauses);

    expect(Object.keys(questions).sort()).toEqual(
      ['harm_0', 'cat_0', 'harm_1', 'cat_1', 'harm_2', 'cat_2'].sort()
    );

    clauses.forEach((_clause, i) => {
      const harm = questions[`harm_${i}`];
      const cat = questions[`cat_${i}`];

      expect(harm.type).toBe('noul');
      expect(harm.instructions).toContain(`clauses[${i}]`);
      expect(harm.criteria).toHaveProperty('true');
      expect(harm.criteria).toHaveProperty('false');

      expect(cat.type).toBe('choice');
      expect(cat.instructions).toContain(`clauses[${i}]`);
      expect(Object.keys(cat.criteria).sort()).toEqual(Object.keys(CATEGORIES).sort());
      expect(cat.criteria).toEqual(CATEGORIES);
    });
  });

  it('handles an empty clause list', () => {
    expect(buildQuestions([])).toEqual({});
  });
});
