// extension/core/weights.js
//
// Category -> weight, and the page-score rollup (spec §4.3). Plain ESM,
// zero dependencies, safe in Node and a Chrome MV3 service worker alike:
// no browser-extension globals, no environment variables, no Node
// builtins, no DOM APIs.

import { CATEGORIES } from './questions.js';

// Explicit weight per category. Four are pinned by spec §4.3:
//   forced_arbitration: 1.0, class_action_waiver: 1.0,
//   liability_dodge: 0.4, no_refunds: 0.3
// The rest are this implementation's judgment call (see report), reasoned
// roughly as "how much concrete harm does this do to the reader":
//   - jury_trial_waiver (0.9): a fundamental-rights waiver on par with
//     forced_arbitration/class_action_waiver, but it almost always rides
//     alongside those two rather than standing alone, so it sits just
//     under them.
//   - data_retained_after_deletion (0.6) and broad_data_sharing (0.6):
//     concrete privacy harms — data outliving a deletion request or
//     reaching third parties is closer to irreversible than most
//     boilerplate.
//   - fee_shifting (0.6): indemnification can transfer real, unbounded
//     financial risk onto the reader.
//   - content_license_grab (0.5), auto_renewal_trap (0.5),
//     termination_without_cause (0.5), tracking_offsite (0.5),
//     unilateral_changes (0.5), hostile_jurisdiction (0.4): common,
//     meaningfully adverse ToS terms, but each is more of an inconvenience
//     or moderate risk than a stripped legal right.
//   - benign (0): by construction, never contributes to the score.
const EXPLICIT_WEIGHTS = {
  forced_arbitration: 1.0,
  class_action_waiver: 1.0,
  jury_trial_waiver: 0.9,
  unilateral_changes: 0.5,
  broad_data_sharing: 0.6,
  tracking_offsite: 0.5,
  content_license_grab: 0.5,
  auto_renewal_trap: 0.5,
  no_refunds: 0.3,
  liability_dodge: 0.4,
  fee_shifting: 0.6,
  hostile_jurisdiction: 0.4,
  termination_without_cause: 0.5,
  data_retained_after_deletion: 0.6,
  benign: 0,
};

// Built by walking Object.keys(CATEGORIES) rather than exporting
// EXPLICIT_WEIGHTS directly, so CATEGORY_WEIGHTS's key set is *structurally*
// guaranteed to match CATEGORIES's — a category added to questions.js
// without a matching weight here throws at import time instead of quietly
// producing `undefined * p = NaN` at runtime.
export const CATEGORY_WEIGHTS = Object.fromEntries(
  Object.keys(CATEGORIES).map((key) => {
    if (!Object.prototype.hasOwnProperty.call(EXPLICIT_WEIGHTS, key)) {
      throw new Error(`extension/core/weights.js: missing weight for category "${key}"`);
    }
    return [key, EXPLICIT_WEIGHTS[key]];
  })
);

// Weight used for a flagged clause whose category is `unclear` (spec §4.2:
// Noul cleared FLAG_THRESHOLD but the Choice's confidence was too low, or
// it disagreed with a `benign` Choice) or any other category string not
// present in CATEGORY_WEIGHTS. The Noul already made the absolute call
// that the clause is harmful — only the label is missing — so this must
// not be 0 (that would silently erase confirmed-harmful clauses from the
// score) and should not be pinned to the most severe category either.
// 0.5 sits in the middle of the explicit weight range above.
export const UNCLEAR_WEIGHT = 0.5;

// Calibrated 2026-09-20 against the 5-document eval corpus (github,
// spotify, airline-coc, saas-eula, lease). A sum-based rollup — raw =
// Σ p×weight over flagged clauses, undivided by document length — saturates
// every real document to 100/100 at K=3 and, worse, is biased by length:
// the 798-clause lease scored worst even at K=40 purely by having the most
// clauses, despite the *lowest* flag rate of the five. Switching to harm
// *density* (raw / totalClauses) fixed the length bias; K itself has been
// re-derived twice since as other inputs moved (see below).
//
// *** K IS A FUNCTION OF FLAG_THRESHOLD AND QUESTION_VERSION, NOT A ***
// *** STANDALONE CONSTANT. *** Moving the flag threshold or editing the
// Noul question wording changes which clauses count as "flagged" and at
// what probability, which changes the density every document produces —
// silently corrupting every page score until K is re-derived against the
// new density distribution. That coupling is exactly what broke between
// the two calibrations below; re-derive K any time either input moves,
// don't just leave the old constant in place.
//
//   2026-09-20, FLAG_THRESHOLD=0.55, QUESTION_VERSION='v1': K=0.10, from
//     github 0.089->59, spotify 0.150->78, airline-coc 0.116->69,
//     saas-eula 0.076->53, lease 0.086->58 (spread 53-78).
//   2026-09-20 (same day, re-run), FLAG_THRESHOLD=0.65, QUESTION_VERSION=
//     'v2': raising the threshold and shipping v2's tighter Noul wording
//     (fewer reader-favoring clauses mistakenly flagged) dropped flag
//     rates from 28-37% to 11-18%, which dropped every document's density
//     and, with the stale K=0.10, every page score (github fell to a
//     32 that reads as "this is fine" despite mandatory arbitration and an
//     AI-training-data waiver). Re-derived K=0.06 from the same five
//     documents' new densities: github 0.0386->47, lease 0.0446->52,
//     saas-eula 0.0511->57, airline-coc 0.0598->63, spotify 0.0777->73
//     (spread 47-73). The ranking (spotify worst, github best) is
//     unchanged — only K moved, to restore separation the stale constant
//     had collapsed.
//
// Known limitation: all five corpus documents are mainstream consumer
// contracts of broadly similar hostility (a ToS, a EULA, a lease, an
// airline contract of carriage, a music-streaming ToS) — there is no
// genuinely fair/benign document in the corpus. The low end of the 0-100
// scale (a score in the 0-30s) is therefore extrapolated from the
// exponential curve's shape, not measured against a real benign reference
// point. Re-tune if the corpus grows to include one.
export const DEFAULT_K = 0.06;

/**
 * Roll flagged clauses up into a single 0-100 page score, scored by harm
 * *density* rather than raw harm count so document length alone can't move
 * the score (spec §4.3's stated intent — a 600-clause document should not
 * score worse than a 100-clause one purely by length — which the original
 * undivided-sum formula did not actually deliver; see the DEFAULT_K comment
 * above):
 *
 *   density = (Σ over flagged clauses of probability_i × CATEGORY_WEIGHTS[category_i]) / totalClauses
 *   score   = round(100 × (1 − exp(−density / k)))
 *
 * Unknown/`unclear` categories fall back to UNCLEAR_WEIGHT so this never
 * throws or produces NaN on a runtime category outside the 15 in
 * CATEGORIES.
 *
 * @param {{probability:number, category:string}[]} flagged
 * @param {number} totalClauses   ALL clauses in the document, not just flagged
 * @param {number} [k=DEFAULT_K]
 * @returns {number} 0-100 integer
 */
export function rollupScore(flagged, totalClauses, k = DEFAULT_K) {
  if (typeof totalClauses !== 'number' || !Number.isFinite(totalClauses) || totalClauses <= 0) return 0;
  if (!Array.isArray(flagged) || flagged.length === 0) return 0;

  const kk = typeof k === 'number' && Number.isFinite(k) && k > 0 ? k : DEFAULT_K;

  const raw = flagged.reduce((sum, entry) => {
    const probability =
      entry && typeof entry.probability === 'number' && Number.isFinite(entry.probability)
        ? entry.probability
        : 0;
    const weight = Object.prototype.hasOwnProperty.call(CATEGORY_WEIGHTS, entry && entry.category)
      ? CATEGORY_WEIGHTS[entry.category]
      : UNCLEAR_WEIGHT;
    return sum + probability * weight;
  }, 0);

  const density = raw / totalClauses;

  return Math.round(100 * (1 - Math.exp(-density / kk)));
}
