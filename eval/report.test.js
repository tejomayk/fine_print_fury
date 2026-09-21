import { describe, it, expect } from 'vitest';
import {
  safeDiv,
  joinScanAndLabels,
  computeCounts,
  computeMetrics,
  computeThresholdSweep,
  computeConfusionMatrix,
  computeUnclearRate,
  falsePositives,
  falseNegatives,
  THRESHOLD_SWEEP,
  docKeyForScan,
  attachSourceToClauses,
  findMissingSources,
  runReport,
} from './report.js';

// ---------------------------------------------------------------------
// Synthetic fixture, hand-computed. 6 clauses:
//
//   id   flagged  probability  category            label     labeled_category
//   c0   true     0.95         forced_arbitration  harmful   forced_arbitration   -> TP (category match)
//   c1   true     0.80         liability_dodge      harmful   fee_shifting         -> TP (category mismatch)
//   c2   true     0.60         unclear              harmful   no_refunds           -> TP (system said unclear)
//   c3   true     0.70         auto_renewal_trap    benign    null                 -> FP
//   c4   false    0.30         null                 harmful   no_refunds           -> FN
//   c5   false    0.20         null                 harmful   liability_dodge      -> FN
//   c6   false    0.10         null                 benign    null                 -> TN (unlabeled-adjacent, but included to prove TN counting)
//
// By hand:
//   TP = 3 (c0, c1, c2)   -- all "flagged AND label=harmful"
//   FP = 1 (c3)           -- "flagged AND label=benign"
//   FN = 2 (c4, c5)       -- "not flagged AND label=harmful"
//   TN = 1 (c6)           -- "not flagged AND label=benign"
//
//   precision = TP / (TP + FP) = 3 / (3 + 1) = 0.75
//   recall    = TP / (TP + FN) = 3 / (3 + 2) = 0.60
//   f1        = 2PR / (P + R)  = 2*0.75*0.60 / (0.75 + 0.60)
//             = 0.9 / 1.35 = 0.6666...
//
//   unclear rate = (flagged clauses with category "unclear") / (flagged clauses)
//                = 1 (c2) / 4 (c0,c1,c2,c3) = 0.25
//
//   confusion matrix, restricted to flagged AND label=harmful (c0, c1, c2):
//     forced_arbitration -> forced_arbitration: 1  (c0)
//     liability_dodge     -> fee_shifting:       1  (c1)
//     unclear             -> no_refunds:         1  (c2)
// ---------------------------------------------------------------------

// All fixture clauses/labels below share one document ("fixture.html"),
// so the (source, clauseId) join added to fix the cross-document
// collision bug behaves identically to a plain clauseId join for these
// existing cases -- the collision-specific behavior gets its own
// describe block further down, with two distinct documents.
function makeClause(id, flagged, probability, category, source = 'fixture.html') {
  return {
    id,
    source,
    text: `text of ${id}`,
    flagged,
    probability,
    category,
    categoryConfidence: flagged ? 0.8 : null,
    severity: flagged ? 'medium' : null,
  };
}

const SCAN_CLAUSES = [
  makeClause('c0', true, 0.95, 'forced_arbitration'),
  makeClause('c1', true, 0.80, 'liability_dodge'),
  makeClause('c2', true, 0.60, 'unclear'),
  makeClause('c3', true, 0.70, 'auto_renewal_trap'),
  makeClause('c4', false, 0.30, null),
  makeClause('c5', false, 0.20, null),
  makeClause('c6', false, 0.10, null),
];

function makeLabel(clauseId, label, category, ambiguity = 0.1) {
  return {
    clauseId,
    source: 'fixture.html',
    text: `text of ${clauseId}`,
    label,
    category,
    rationale: 'fixture',
    ambiguity,
  };
}

const LABELS = [
  makeLabel('c0', 'harmful', 'forced_arbitration'),
  makeLabel('c1', 'harmful', 'fee_shifting'),
  makeLabel('c2', 'harmful', 'no_refunds'),
  makeLabel('c3', 'benign', null),
  makeLabel('c4', 'harmful', 'no_refunds'),
  makeLabel('c5', 'harmful', 'liability_dodge'),
  makeLabel('c6', 'benign', null),
];

describe('safeDiv', () => {
  it('divides normally', () => {
    expect(safeDiv(3, 4)).toBe(0.75);
  });

  it('returns null (not NaN/Infinity) for a zero denominator', () => {
    expect(safeDiv(0, 0)).toBeNull();
    expect(safeDiv(5, 0)).toBeNull();
  });
});

describe('joinScanAndLabels', () => {
  it('matches by the (source, clauseId) pair and reports unmatched labels as skipped', () => {
    const labelsWithGhost = [...LABELS, makeLabel('c999-does-not-exist', 'harmful', 'no_refunds')];
    const { matched, skipped } = joinScanAndLabels(SCAN_CLAUSES, labelsWithGhost);
    expect(matched).toHaveLength(7);
    expect(skipped).toEqual([{ source: 'fixture.html', clauseId: 'c999-does-not-exist' }]);
  });

  it('handles an empty labels file', () => {
    const { matched, skipped } = joinScanAndLabels(SCAN_CLAUSES, []);
    expect(matched).toEqual([]);
    expect(skipped).toEqual([]);
  });
});

describe('computeCounts + computeMetrics (hand-computed fixture)', () => {
  it('produces TP=3 FP=1 FN=2 TN=1 -> precision 0.75, recall 0.60, f1 ~0.667', () => {
    const { matched } = joinScanAndLabels(SCAN_CLAUSES, LABELS);
    const counts = computeCounts(matched);
    expect(counts).toEqual({ tp: 3, fp: 1, fn: 2, tn: 1 });

    const metrics = computeMetrics(counts);
    expect(metrics.precision).toBeCloseTo(0.75, 10);
    expect(metrics.recall).toBeCloseTo(0.6, 10);
    expect(metrics.f1).toBeCloseTo(2 * 0.75 * 0.6 / (0.75 + 0.6), 10);
  });
});

describe('computeMetrics division-by-zero guards', () => {
  it('precision is null (N/A) when nothing was flagged', () => {
    // All clauses unflagged; some labeled harmful (FN), none flagged (no TP/FP).
    const counts = computeCounts(
      SCAN_CLAUSES.map((c) => ({ ...c, flagged: false })).map((c) => ({
        clause: c,
        label: LABELS.find((l) => l.clauseId === c.id),
      })),
    );
    expect(counts.tp).toBe(0);
    expect(counts.fp).toBe(0);
    const metrics = computeMetrics(counts);
    expect(metrics.precision).toBeNull(); // 0/0
    // recall is well-defined here (0 / (0+fn)) since fn > 0.
    expect(metrics.recall).toBe(0);
    expect(metrics.f1).toBeNull();
  });

  it('recall is null (N/A) when nothing is labeled harmful', () => {
    const allBenignLabels = LABELS.map((l) => ({ ...l, label: 'benign', category: null }));
    const { matched } = joinScanAndLabels(SCAN_CLAUSES, allBenignLabels);
    const counts = computeCounts(matched);
    expect(counts.tp).toBe(0);
    expect(counts.fn).toBe(0);
    const metrics = computeMetrics(counts);
    expect(metrics.recall).toBeNull(); // 0/0
    expect(metrics.f1).toBeNull();
  });

  it('handles a fully empty match set (empty labels file) without throwing', () => {
    const counts = computeCounts([]);
    expect(counts).toEqual({ tp: 0, fp: 0, fn: 0, tn: 0 });
    const metrics = computeMetrics(counts);
    expect(metrics.precision).toBeNull();
    expect(metrics.recall).toBeNull();
    expect(metrics.f1).toBeNull();
  });
});

describe('computeThresholdSweep', () => {
  it('sweeps the documented 0.40-0.90 default range in 0.05 steps', () => {
    expect(THRESHOLD_SWEEP).toEqual([0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]);
  });

  it('produces monotonically non-increasing recall as the threshold rises', () => {
    const { matched } = joinScanAndLabels(SCAN_CLAUSES, LABELS);
    const sweep = computeThresholdSweep(matched);
    expect(sweep).toHaveLength(THRESHOLD_SWEEP.length);

    let prevRecall = Infinity;
    for (const row of sweep) {
      if (row.recall !== null) {
        expect(row.recall).toBeLessThanOrEqual(prevRecall);
        prevRecall = row.recall;
      }
    }
  });

  it('hand-checks two specific thresholds', () => {
    const { matched } = joinScanAndLabels(SCAN_CLAUSES, LABELS);
    const sweep = computeThresholdSweep(matched);

    // At threshold 0.90: only c0 (p=0.95) clears the bar among harmful-
    // labeled clauses; c1(.80) c2(.60) c4(.30) c5(.20) drop below.
    // Flagged-and-harmful (TP) = {c0} = 1. Flagged-and-benign (FP): c3
    // (p=0.70) also drops below 0.90, so FP = 0.
    // precision = 1/1 = 1.0; recall = 1/(1+4) = 0.2
    const at90 = sweep.find((r) => r.threshold === 0.9);
    expect(at90.tp).toBe(1);
    expect(at90.fp).toBe(0);
    expect(at90.precision).toBeCloseTo(1.0, 10);
    expect(at90.recall).toBeCloseTo(0.2, 10);

    // At threshold 0.40: everything with p>=0.40 flagged -> c0(.95) c1(.80)
    // c2(.60) c3(.70) flagged; c4(.30) c5(.20) c6(.10) not flagged.
    // TP = {c0,c1,c2} = 3, FP = {c3} = 1, FN = {c4,c5} = 2.
    // Same as the headline fixture: precision 0.75, recall 0.60.
    const at40 = sweep.find((r) => r.threshold === 0.4);
    expect(at40.tp).toBe(3);
    expect(at40.fp).toBe(1);
    expect(at40.precision).toBeCloseTo(0.75, 10);
    expect(at40.recall).toBeCloseTo(0.6, 10);
  });
});

describe('computeConfusionMatrix', () => {
  it('tabulates predicted vs. labeled category over true positives only', () => {
    const { matched } = joinScanAndLabels(SCAN_CLAUSES, LABELS);
    const matrix = computeConfusionMatrix(matched);
    expect(matrix).toEqual({
      forced_arbitration: { forced_arbitration: 1 },
      liability_dodge: { fee_shifting: 1 },
      unclear: { no_refunds: 1 },
    });
  });

  it('excludes false positives and false negatives', () => {
    const { matched } = joinScanAndLabels(SCAN_CLAUSES, LABELS);
    const matrix = computeConfusionMatrix(matched);
    // c3 (FP, auto_renewal_trap/benign) must not appear as a predicted row.
    expect(matrix.auto_renewal_trap).toBeUndefined();
  });
});

describe('computeUnclearRate', () => {
  it('is the fraction of flagged clauses whose category is "unclear"', () => {
    // Flagged: c0, c1, c2, c3 (4 total). Unclear among them: c2 (1).
    expect(computeUnclearRate(SCAN_CLAUSES)).toBeCloseTo(0.25, 10);
  });

  it('is null (N/A), not 0, when nothing was flagged', () => {
    const noneFlagged = SCAN_CLAUSES.map((c) => ({ ...c, flagged: false }));
    expect(computeUnclearRate(noneFlagged)).toBeNull();
  });
});

describe('falsePositives / falseNegatives', () => {
  it('lists exactly the FP and FN clauses from the fixture', () => {
    const { matched } = joinScanAndLabels(SCAN_CLAUSES, LABELS);
    const fps = falsePositives(matched);
    const fns = falseNegatives(matched);
    expect(fps.map((f) => f.clauseId)).toEqual(['c3']);
    expect(fns.map((f) => f.clauseId).sort()).toEqual(['c4', 'c5']);
  });

  it('caps each list at 10 entries', () => {
    const manyFpClauses = Array.from({ length: 15 }, (_, i) => makeClause(`fp${i}`, true, 0.9, 'no_refunds'));
    const manyFpLabels = manyFpClauses.map((c) => makeLabel(c.id, 'benign', null));
    const { matched } = joinScanAndLabels(manyFpClauses, manyFpLabels);
    expect(falsePositives(matched)).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------
// Regression: clause ids restart at c0 in every document (spec §3.3), so
// "c1" exists in every corpus file. A join keyed on clauseId ALONE
// (the shape this file used to test) silently matches a label against
// whichever same-numbered clause happens to be in the map -- almost
// always the wrong document's clause. This is not hypothetical: on the
// real 50-label set, 28 labels collided with a same-numbered clause from
// a different document, and measured precision came out at 60% instead
// of the correct ~92%. Under the OLD (clauseId-only) join, this exact
// two-document setup would have silently matched at least one label
// against the wrong clause; these tests would have passed anyway,
// because nothing checked WHICH clause got matched -- that's why the bug
// shipped. The assertions below specifically check clause identity
// (flagged/text), not just match counts, so they would fail under the
// old join.
// ---------------------------------------------------------------------
describe('multi-document join (regression: clause ids collide across documents)', () => {
  // doc-a.html:c1 -- a real, flagged, harmful clause (forced arbitration).
  const scanA = {
    meta: { file: 'eval/corpus/doc-a.html', documentType: 'Terms', model: 'jev-1.13.0' },
    pageScore: 50,
    clauses: [
      {
        id: 'c1',
        text: 'Disputes shall be resolved by binding arbitration.',
        flagged: true,
        probability: 0.9,
        category: 'forced_arbitration',
        categoryConfidence: 0.9,
        severity: 'high',
      },
    ],
  };
  // doc-b.html:c1 -- a different, unflagged, benign clause. Same bare id
  // ("c1") as doc-a's clause, on purpose.
  const scanB = {
    meta: { file: 'eval/corpus/doc-b.html', documentType: 'Terms', model: 'jev-1.13.0' },
    pageScore: 5,
    clauses: [
      {
        id: 'c1',
        text: 'Acme is a registered trademark of Acme Inc.',
        flagged: false,
        probability: 0.05,
        category: null,
        categoryConfidence: null,
        severity: null,
      },
    ],
  };
  const collisionLabels = [
    { clauseId: 'c1', source: 'doc-a.html', text: 'arbitration clause', label: 'harmful', category: 'forced_arbitration', rationale: 'r', ambiguity: 0.1 },
    { clauseId: 'c1', source: 'doc-b.html', text: 'trademark notice', label: 'benign', category: null, rationale: 'r', ambiguity: 0.1 },
  ];

  it('docKeyForScan derives the document key from basename(meta.file)', () => {
    expect(docKeyForScan(scanA)).toBe('doc-a.html');
    expect(docKeyForScan(scanB)).toBe('doc-b.html');
  });

  it('joins each label against its OWN document\'s clause, not a same-id clause from another document', () => {
    const scanClauses = [scanA, scanB].flatMap(attachSourceToClauses);
    const { matched, skipped } = joinScanAndLabels(scanClauses, collisionLabels);
    expect(skipped).toEqual([]);
    expect(matched).toHaveLength(2);

    const docAMatch = matched.find((m) => m.label.source === 'doc-a.html');
    const docBMatch = matched.find((m) => m.label.source === 'doc-b.html');
    // Both share clauseId "c1" -- if the join were still keyed on id
    // alone, these two assertions could not both pass, because there
    // would only be one "c1" in the map (whichever document's clause
    // was inserted last), and it would answer to both labels.
    expect(docAMatch.clause.flagged).toBe(true);
    expect(docAMatch.clause.text).toMatch(/arbitration/);
    expect(docBMatch.clause.flagged).toBe(false);
    expect(docBMatch.clause.text).toMatch(/trademark/);
  });

  it('produces TP=1 TN=1 under the correct join (the old id-only join could report this as TP=2 or FN=1 depending on map insertion order)', () => {
    const scanClauses = [scanA, scanB].flatMap(attachSourceToClauses);
    const { matched } = joinScanAndLabels(scanClauses, collisionLabels);
    const counts = computeCounts(matched);
    // doc-a: flagged=true + label=harmful -> TP. doc-b: flagged=false + label=benign -> TN.
    expect(counts).toEqual({ tp: 1, fp: 0, fn: 0, tn: 1 });
  });

  it('end-to-end via runReport: global counts are correct and per-document breakdown attributes each result to its own source', () => {
    const report = runReport([scanA, scanB], collisionLabels);
    expect(report.counts).toEqual({ tp: 1, fp: 0, fn: 0, tn: 1 });
    expect(report.metrics.precision).toBe(1);

    const byDoc = Object.fromEntries(report.perDocument.map((d) => [d.source, d]));
    expect(byDoc['doc-a.html'].tp).toBe(1);
    expect(byDoc['doc-a.html'].fp).toBe(0);
    expect(byDoc['doc-b.html'].tp).toBe(0);
    expect(byDoc['doc-b.html'].tn).toBe(1);
  });

  it('findMissingSources catches silently-partial coverage: passing only doc-a is detected as missing doc-b', () => {
    expect(findMissingSources([scanA], collisionLabels)).toEqual(['doc-b.html']);
    expect(findMissingSources([scanB], collisionLabels)).toEqual(['doc-a.html']);
    expect(findMissingSources([scanA, scanB], collisionLabels)).toEqual([]);
  });
});
