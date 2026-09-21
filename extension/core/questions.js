// extension/core/questions.js
//
// Question definitions for the Jev call (spec §4.1). Plain ESM, zero
// dependencies, safe in Node and a Chrome MV3 service worker alike:
// no browser-extension globals, no environment variables, no Node
// builtins, no DOM APIs.
//
// Bump QUESTION_VERSION whenever ANY instruction or criteria string below
// changes — it is baked into the cache key (spec §6.1: sha256(normalize
// (clause_text) + question_version)) so a rubric edit invalidates cleanly
// instead of silently serving verdicts scored under the old wording.
export const QUESTION_VERSION = 'v2';

// Category key -> rubric description. Transcribed verbatim from spec §4.1's
// JSON block (the `cat_0.criteria` map) — do not paraphrase or reword these.
export const CATEGORIES = {
  forced_arbitration: 'Requires disputes go to binding arbitration instead of court.',
  class_action_waiver: 'Bars the reader from joining a class or collective action.',
  jury_trial_waiver: 'Waives the right to a jury trial.',
  unilateral_changes: 'Lets the company change the terms without notice or consent.',
  broad_data_sharing: 'Permits sharing personal data with third parties, affiliates, or advertisers.',
  tracking_offsite: 'Permits tracking the reader on other sites, apps, or services.',
  content_license_grab: "Grants the company a broad, perpetual, or sublicensable license to the reader's content.",
  auto_renewal_trap: 'Automatically renews or charges, or makes cancellation difficult.',
  no_refunds: 'Denies refunds or makes fees non-refundable.',
  liability_dodge: "Caps, disclaims, or excludes the company's liability or damages.",
  fee_shifting: "Makes the reader pay the company's legal costs or indemnify it.",
  hostile_jurisdiction: 'Forces disputes into a venue or governing law inconvenient to the reader.',
  termination_without_cause: 'Lets the company suspend or terminate the account without cause or notice.',
  data_retained_after_deletion: "Allows keeping the reader's data after deletion or account closure.",
  benign: 'None of the above; the clause is neutral or administrative.',
};

// The Noul instructions template. `state` names the chunk's clauses
// directly (spec §4.1: "the docs recommend naming state directly to
// reduce indirection"), so the instructions reference `clauses[i]` rather
// than an indirect pointer.
//
// v2 (2026-09-20): the v1 wording — transcribed verbatim from spec §4.1's
// harm_0.instructions — was diffed against the eval gate at precision 0.63
// against an 0.80 target. 6 of 9 false positives at the 0.55 threshold
// were clauses that HELP the reader: savings clauses, carve-outs, and
// exemptions that quote harmful-sounding vocabulary (arbitration,
// liability, warranties, confidentiality) only to narrow or disapply it.
// Jev was reading the register and vocabulary of these sentences rather
// than their direction of effect. v2 makes the direction-of-effect
// judgment explicit in the instructions themselves, rather than leaving it
// to the single implied phrase "protection that favors the reader" in the
// old `criteria.false` (see HARM_CRITERIA below).
export const HARM_INSTRUCTIONS = (i) =>
  `Does \`clauses[${i}]\` take away a right, protection, or remedy that the reader would otherwise have, or let the company act against the reader's interests without their agreement? Judge the clause's net effect on the reader, not the legal topics or vocabulary it uses: a clause that creates an exception to a restriction, narrows one, or otherwise leaves the reader better off than without it is not harmful — even when it names arbitration, liability, warranties, confidentiality, or other harmful-sounding topics only in order to exclude or limit them.`;

// v2 (2026-09-20, see HARM_INSTRUCTIONS above): `true` now states plainly
// that mentioning or quoting a restriction is not the same as imposing
// one, so a literal reading can't mistake a clause that merely discusses a
// harmful-sounding topic for one that inflicts it. `false` keeps the
// original neutral/administrative/definitional/heading list, then
// enumerates the specific reader-favoring sentence forms the v1 wording's
// closing clause ("or a protection that favors the reader") was too
// abstract to catch: exceptions/carve-outs, savings clauses, and
// exemptions.
export const HARM_CRITERIA = {
  true: `The clause's own operative effect removes a legal right, waives a remedy, grants the company broad unilateral power over the reader, or shifts a cost or risk onto the reader. Merely mentioning, quoting, or discussing a right, restriction, remedy, or harmful-sounding legal topic — without the clause itself narrowing the reader's position — is not enough on its own.`,
  false: `The clause is neutral, administrative, definitional, a trademark or copyright notice, a heading, or a protection that favors the reader. This includes reader-favoring forms such as: an exception or carve-out that narrows or disapplies a restriction stated elsewhere ("this Section does not apply to...", "shall not apply to..."); a savings clause preserving the reader's statutory or other legally-mandated rights ("some jurisdictions do not allow the exclusion of..."); an exemption releasing the reader from a duty or obligation ("shall not be required to...", "is not required to..."); and any clause that grants the reader a right, remedy, or option.`,
};

// The Choice instructions template, transcribed verbatim from spec §4.1's
// cat_0.instructions (with `clauses[0]` generalized to `clauses[i]`).
const CATEGORY_INSTRUCTIONS = (i) => `Which category best describes what \`clauses[${i}]\` does to the reader?`;

/**
 * Build the questions map for one chunk: harm_i (noul) + cat_i (choice) for
 * every clause index, both sent speculatively per clause (spec §4.1).
 *
 * @param {string[]} clauseTexts
 * @returns {Object} e.g. { harm_0: {...}, cat_0: {...}, harm_1: {...}, cat_1: {...} }
 */
export function buildQuestions(clauseTexts) {
  const questions = {};
  clauseTexts.forEach((_clauseText, i) => {
    questions[`harm_${i}`] = {
      type: 'noul',
      instructions: HARM_INSTRUCTIONS(i),
      criteria: { ...HARM_CRITERIA },
    };
    questions[`cat_${i}`] = {
      type: 'choice',
      instructions: CATEGORY_INSTRUCTIONS(i),
      criteria: { ...CATEGORIES },
    };
  });
  return questions;
}
