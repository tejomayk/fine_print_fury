# Label file format

`eval/labels.template.json` is the schema the hand-labeling step fills in
(spec §7: "~50 hand-labeled clauses, binary + category, over-sampling
near-misses"). Copy it to `labels.json` (or any name) and extend it — the
template's 3 example rows exist only to pin the format; replace/extend
them, don't ship them as real labels.

`eval/report.js <labels.json> <scan1.json> [scan2.json ...]` joins this
file against one or more `cli/scan.js --json` runs **by the (`source`,
`clauseId`) pair, never by `clauseId` alone** — clause ids restart at
`c0` in every document (spec §3.3, assigned in per-document order by
`extension/core/segment.js`), so `c1` exists in every corpus file, and a
label's `clauseId` is only unique once paired with its `source`. Because
the label set spans every corpus document, `report.js` refuses to run
unless the scans passed on the command line cover every `source` present
in the labels file — a partial set of scans would silently score only
some of the labels. Re-run segmentation and re-derive ids if the
segmenter's boundaries change; a stale (`source`, `clauseId`) pair
silently becomes a "skipped" row in the report rather than a match.

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `clauseId` | string | yes | Must match the `id` of a clause in the scan output for the same document (e.g. `"c42"`). This is the join key. |
| `source` | string | yes | Which corpus file the clause came from, e.g. `"github.html"`. Informational — the join key is `clauseId`, not `source` — but keeps the label human-traceable back to a document, and lets you filter results per-document later. |
| `text` | string | yes | The full clause text, copied verbatim from segmentation output. Kept here (not just referenced by id) so labels remain readable and auditable without re-running the scanner, and so a human reviewing false positives/negatives in `report.js` output can read the clause without cross-referencing another file. |
| `label` | `"harmful"` \| `"benign"` | yes | The ground-truth binary call spec §7 asks for. This is what precision/recall are computed against. |
| `category` | string \| `null` | yes | One of the 15 category keys in `extension/core/questions.js` (`CATEGORIES`) when `label` is `"harmful"`. **Must be `null` when `label` is `"benign"`** — a benign clause has no category by construction (spec §4.1's `benign` catch-all is itself one of the 15, but is not a valid value here; benign clauses simply carry `category: null`). |
| `rationale` | string | yes | One line of human judgment explaining the call. Required even for "obvious" cases — spec §7 asks the label set to over-sample near-misses (standard-but-scary liability language, harmless definitions that sound alarming), and the rationale is what lets a second labeler audit disagreements later. |
| `ambiguity` | number, 0–1 | yes | How close a call this was. 0 = obvious either way. 1 = a coin flip a reasonable second labeler could easily call the other way. Spec §7 specifically wants near-misses over-sampled, so this field is what lets `report.js` (or a human) later slice results by "how hard was this example" rather than treating all labels as equally confident ground truth. |

## Example rows (in the template)

The template includes 3 filled-in examples:

1. A clearly **harmful** clause (forced arbitration) with low ambiguity.
2. A clearly **benign** clause (a definitions/administrative clause) with
   low ambiguity — `category: null`.
3. A **near-miss harmful** clause (liability language that reads scarier
   than it is, but still meets the harm bar) with higher ambiguity — this
   is the kind of example spec §7 asks to over-sample.

## Building a real label set

- Aim for ~50 clauses total, drawn across the 5 corpus documents.
- Over-sample near-misses: clauses that sound alarming but are boilerplate
  (definitions, trademark notices), and clauses that sound mundane but
  meet the harm bar (a flat "No refunds." is short and easy to
  under-weight).
- Every clause your labels reference must exist in the `cli/scan.js
  --json` output you plan to evaluate against, joined by `clauseId`.
