// Pure decision logic for turning a Jev Noul/Choice answer pair into a
// verdict. No I/O, no environment dependencies — see spec §4.2.

// Calibrated 2026-09-20 against eval/labels.json (50 human-reviewed clauses,
// 5 contracts) with QUESTION_VERSION = 'v2':
//
//   thr    TP  FP  FN   precision  recall    F1
//   0.55    14   7   3     0.67      0.82    0.74
//   0.60    12   6   5     0.67      0.71    0.69
//   0.65    12   1   5     0.92      0.71    0.80   <- F1 peak, clears the 0.80 precision gate
//   0.70    10   0   7     1.00      0.59    0.74
//
// 0.65 is both the F1 maximum and the lowest threshold that clears the
// precision gate — matches spec §7's stated preference for precision over
// recall (a missed clause is invisible; a false alarm on boilerplate is
// what gets the extension uninstalled).
//
// This number is a property of the rubric it was measured against, not a
// universal constant: re-derive it from the eval whenever the question
// wording (QUESTION_VERSION) or the label set changes. A threshold tuned
// against one rubric does not transfer to another.
const DEFAULT_FLAG_THRESHOLD = 0.65;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.4;

/**
 * Bands a Noul probability into a severity tier for rendering.
 *
 * Re-spaced 2026-09-20 alongside the DEFAULT_FLAG_THRESHOLD bump to 0.65.
 * The old bands (0.55/0.70/0.85) were equal-width thirds of the reachable
 * range [oldFlagThreshold, 1.0] = [0.55, 1.0]. With the flag threshold now
 * at 0.65, that same reachable range is [0.65, 1.0] (width 0.35, versus the
 * old 0.45) — nothing below 0.65 is ever flagged, so the old 0.55-0.70
 * "low" band was mostly unreachable and would have left "low" nearly dead.
 *
 * Re-spaced across the new reachable range, rounded to clean two-decimal
 * boundaries rather than exact thirds (0.65 / 0.7667 / 0.8833) for
 * legibility in the UI and in code:
 *   0.65–0.78  -> "low"    (amber underline)  width 0.13
 *   0.78–0.90  -> "medium" (amber fill)        width 0.12
 *   >0.90      -> "high"   (red fill)          width 0.10 (open-ended above)
 *
 * All three bands are reachable and each holds a comparable slice of the
 * post-threshold range, with "high" deliberately the narrowest/rarest band
 * since it renders as a hard red fill.
 *
 * @param {number} p
 * @returns {"high"|"medium"|"low"|null}
 */
export function bandSeverity(p) {
  if (p > 0.90) return 'high';
  if (p >= 0.78) return 'medium';
  if (p >= 0.65) return 'low';
  return null;
}

/**
 * @param {number} noulP
 * @param {{choice:string, probabilities:Object, confidence:number}} choiceAnswer
 * @param {{flagThreshold?:number, confidenceThreshold?:number}} [opts]
 * @returns {{flagged:boolean, probability:number, category:string|null,
 *            categoryConfidence:number|null, severity:string|null}}
 */
export function decideVerdict(noulP, choiceAnswer, opts = {}) {
  const flagThreshold = opts.flagThreshold ?? DEFAULT_FLAG_THRESHOLD;
  const confidenceThreshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  if (noulP < flagThreshold) {
    // Noul is the absolute judgment. Below the bar, the clause is not
    // flagged at all and the Choice answer is discarded entirely — we
    // never surface a category for a clause we didn't flag.
    return {
      flagged: false,
      probability: noulP,
      category: null,
      categoryConfidence: null,
      severity: null,
    };
  }

  // Flagged. The Choice only labels the clause after the Noul has already
  // decided it's bad. Two ways the label collapses to "unclear":
  //   1. Low confidence — the Choice itself isn't sure which category fits.
  //   2. The Choice landed on "benign" anyway. Since the Noul already
  //      cleared the flag bar, "benign" here isn't a real answer — it's a
  //      genuine disagreement between the two questions (the docs warn
  //      against expecting structural invariance between a Noul and a
  //      Choice). We keep the highlight — the Noul is the absolute
  //      judgment — but refuse to label a flagged clause "benign".
  const lowConfidence = choiceAnswer.confidence < confidenceThreshold;
  const category = (lowConfidence || choiceAnswer.choice === 'benign')
    ? 'unclear'
    : choiceAnswer.choice;

  return {
    flagged: true,
    probability: noulP,
    category,
    categoryConfidence: choiceAnswer.confidence,
    severity: bandSeverity(noulP),
  };
}
