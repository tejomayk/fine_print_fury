# Fine Print Fury

A Chrome MV3 extension that scans a Terms of Service, EULA, or privacy page,
splits it into clauses, and scores each one for "this is going to screw you"
probability — highlighted inline, before you click I Agree.

Bring your own [Jev](https://docs.typesafe.ai) API key. There is no backend,
no account, no telemetry. The extension talks to `api.typesafe.ai` and
nowhere else.

## Why Jev

The interesting part of this project isn't the extension chrome — it's what
Jev's request shape lets the scoring loop look like.

Jev ingests a `state` blob once and evaluates every question against it in
parallel, in the same round trip. So one chunk of document (~40 clauses) plus
roughly 80 questions — a Noul ("is this clause harmful?") and a Choice
("which of these 15 categories is it?") for every clause — is a single
request. Ask a category question for every clause even before you know
whether it's flagged: output tokens are free, and a second call to fetch the
label later would cost more than just asking speculatively.

The consequence: a full 400-clause Terms of Service scans in roughly 1–2
seconds (10 chunks at 6-way concurrency, sub-second per call) for about
$0.0065 — under a cent. A thousand scans is about six cents. There's no
architectural reason to cache, batch overnight, or throttle a "Scan" button;
the naive one-request-per-chunk design is already fast and cheap enough to
run synchronously off a click.

## How it works

```
detect → walk DOM → segment into clauses → chunk → score → highlight
```

1. **Detect** (`extension/detect.js`) — a two-signal heuristic (URL pattern
   + legal-boilerplate word density) flags whether the current page looks
   like a legal document. Advisory only; it logs a verdict but never gates
   a scan.
2. **Walk the DOM** (`extension/domwalk.js`) — collects block-level text
   (`p`, `li`, `td`, childless `div`), skipping `nav`/`header`/`footer` and
   hidden nodes.
3. **Segment** (`extension/core/segment.js`) — splits block text into
   clauses on numbered-item and sentence boundaries, with an abbreviation
   guard (`Inc.`, `e.g.`, `U.S.`, `No.`, ...) so those don't cause false
   splits. Short fragments are dropped as headings/nav scraps *unless* they
   end in terminal punctuation — "No refunds." and "Arbitration is
   mandatory." survive on purpose; they're exactly the clauses this tool
   exists to catch.
4. **Chunk** (`extension/core/chunkPlan.js`) — groups of 40 clauses, sent
   6-way concurrent. The chunk's full text becomes `state`, so a clause is
   judged with its neighbors visible (legal text is full of "the
   foregoing," "Section 5 notwithstanding").
5. **Score** (`extension/core/scoreChunk.js`) — the only place Jev is ever
   called. Sends the Noul + Choice questions (`extension/core/questions.js`)
   for every clause in the chunk.
6. **Highlight** (`extension/render.js`, `extension/hoverCard.js`) — wraps
   flagged clauses in `<mark>` via a `Range` over the original DOM offsets
   (not `innerHTML` rewriting, so page event handlers and framework
   bindings survive), and shows a hover card with the category label and
   raw probability.

The Noul and the Choice answer different questions, and the code treats them
that way. **The Noul is absolute** — it alone decides whether a clause is
flagged, on a 0–1 harm probability with no notion of alternatives. **The
Choice is relative** — its probabilities always sum to 1, so it always picks
some category, even a bad one, even for a clause that shouldn't have been
flagged at all. When a flagged clause's Choice lands on "benign" anyway,
that's a real disagreement between the two questions, not a tie-breaker in
benign's favor — the highlight stays (the Noul made the call) and the label
becomes `unclear`.

Clauses are scored across 15 categories (forced arbitration, class-action
waivers, auto-renewal traps, liability dodges, and so on — see
`extension/core/questions.js` for the full rubric), each with its own weight
toward the page-level score.

## Install and use

### Extension

```
npm install
npm test
```

Then load it unpacked:

1. Open `chrome://extensions`, enable Developer mode.
2. Click "Load unpacked" and select the `extension/` directory.
3. Click the extension icon, paste in a Jev API key, and hit Scan on any
   page.

The key is entered through the popup and stored in `chrome.storage.local`
(never `.sync` — that would replicate a billing credential through the
user's Google account). The extension **never reads `.env`**; that file is
for the CLI only, described below.

There is no auto-scan. The extension does nothing to a page until you click
Scan — see [Scope decisions](#scope-decisions) for why.

### CLI

For scoring a saved HTML file from the terminal, without loading the
extension:

```
echo "TYPESAFE_API_KEY=<your key>" > .env
node --env-file=.env cli/scan.js path/to/file.html
```

Optional flags: `--source example.com` (attached to the request as context)
and `--json out.json` (writes the full per-clause result alongside the
terminal report).

`.env` and the CLI's key handling are completely separate from the
extension's popup/`chrome.storage.local` path — there is no shared state
between the two ways of supplying a key.

## The eval

`eval/` holds a human-reviewed labelled set of 50 clauses (17 harmful, 33
benign) drawn from five real, currently-live contracts: GitHub's Terms of
Service, Spotify's Terms of Use, Delta's Contract of Carriage, a SaaS EULA
(Coats Digital), and a residential lease template. `eval/corpus/*.html` is
gitignored — run `node eval/fetch-corpus.js` to re-fetch it; the script
validates each candidate through the real extraction pipeline (not a crude
tag-strip) and substitutes a fallback source if one fails.

At the current flag threshold of 0.65:

| threshold | precision | recall | F1 | TP | FP | FN |
|---|---|---|---|---|---|---|
| 0.55 | 63.6% | 82.4% | 71.8% | 14 | 8 | 3 |
| 0.60 | 73.7% | 82.4% | 77.8% | 14 | 5 | 3 |
| **0.65** | **100.0%** | **70.6%** | **82.8%** ← F1 peak | 12 | 0 | 5 |
| 0.70 | 100.0% | 64.7% | 78.6% | 11 | 0 | 6 |
| 0.75 | 100.0% | 47.1% | 64.0% | 8 | 0 | 9 |

0.65 is both the F1 maximum and the lowest threshold that clears an 0.80
precision gate, matching a stated preference for precision over recall: a
missed clause is invisible, but a false alarm on boilerplate is what gets an
extension uninstalled. See the first limitation below before reading that
100% as more than it is.

Run it yourself:

```
node eval/fetch-corpus.js

node --env-file=.env cli/scan.js eval/corpus/github.html      --source github.com       --json /tmp/github.json
node --env-file=.env cli/scan.js eval/corpus/spotify.html     --source spotify.com      --json /tmp/spotify.json
node --env-file=.env cli/scan.js eval/corpus/airline-coc.html --source delta.com        --json /tmp/airline-coc.json
node --env-file=.env cli/scan.js eval/corpus/saas-eula.html   --source coatsdigital.com --json /tmp/saas-eula.json
node --env-file=.env cli/scan.js eval/corpus/lease.html       --source rocketlawyer.com --json /tmp/lease.json

node eval/report.js eval/labels.json \
  /tmp/github.json /tmp/spotify.json /tmp/airline-coc.json /tmp/saas-eula.json /tmp/lease.json
```

`report.js` takes the labels file first, then every scan's `--json` output
(order doesn't matter). The labels span all five documents, and clause ids
restart at `c0` in each one, so `report.js` joins on `(source, clauseId)`
and refuses to run — rather than silently reporting on a subset — unless
the scans passed on the command line cover every document referenced in
the labels file.

## Honest limitations

This section is the point, not a disclaimer at the bottom.

- **The 100% precision at threshold 0.65 is a small-sample artifact, not a
  guarantee.** It means zero false positives happened to land among the 50
  labelled clauses — of which only 17 are harmful — not that the system
  doesn't produce false positives. n=50 is small enough that a single
  differently-worded clause could have flipped it. It will not hold at
  real-world scale, and it should not be read as a real-world
  false-positive rate.
- **There is no benign reference point in the corpus.** All five documents
  are mainstream consumer contracts of broadly similar hostility. The low
  end of the 0–100 page score is extrapolated from the shape of the scoring
  curve, not measured against an actual fair contract. We don't know what a
  genuinely reader-friendly agreement scores, because none is in the eval
  set.
- **The page-score constant `K` is coupled to the flag threshold and the
  question wording, not a standalone constant.** Moving one without
  re-deriving the other silently shifts every score — `K` has already had
  to be re-derived once, from 0.10 to 0.06, purely because the flag
  threshold and question rubric changed underneath it (see
  `extension/core/weights.js` for the full history).
- **Run-to-run model variance moves page scores by roughly 1–4 points** —
  comparable to the gap between adjacent documents in the corpus. The score
  is reliable for separating broad bands ("this is bad" vs. "this is
  fine"), not for ranking two similar documents against each other.
- **45.9% of flagged clauses come back labeled `unclear`.** The Noul judged
  the clause harmful but the Choice either wasn't confident enough in a
  category or landed on `benign` anyway (see [How it works](#how-it-works)
  for why that keeps the flag). In practice: a user hovering a highlight has
  close to a coin flip's chance of seeing only "this looks harmful, we can't
  say what kind" instead of a specific category.
- **This is not legal advice.** It's a heuristic pointer at clauses worth
  reading more carefully, nothing more.

## Scope decisions

These are decisions, not unfinished work:

- **Manual scan only. No auto-detect, no `<all_urls>`.** Auto-detection
  would mean reading every page the user visits, silently, in the
  background. For a tool whose entire pitch is that companies quietly take
  more than you realize, making the extension itself quietly read
  everything you browse is not a trade worth making. `detect.js`'s
  heuristic runs and logs a verdict on every manual scan, but it gates
  nothing — it exists to warn, later, before a scan is spent on a page that
  plainly isn't a contract.
- **No cache.** At roughly half a cent and 1–2 seconds per document, caching
  buys little for a manually-triggered scan, and a stale-invalidation bug
  would serve verdicts scored under an old rubric — worse than being
  slightly slower.
- **No backend.** Bring-your-own-key keeps the key on the user's machine
  and the entire request/response path auditable in `extension/core/`. A
  proxy is a natural future extension (rate limiting, a shared cache, no
  key exposed to the client) but was deliberately left out of this scope.

## Repo layout

```
extension/
  core/            segmentation, questions, weights, scoring — the shared
                   logic used by both the extension and the CLI
  manifest.json, background.js, content.js, popup.*, render.js, ...
cli/
  scan.js          segment + score a saved HTML file from the terminal
  extract.js       HTML -> block text, used by both the CLI and eval/fetch-corpus.js
eval/
  corpus/          the 5-document eval corpus (gitignored; fetch-corpus.js rebuilds it)
  labels.json      50 hand-labeled clauses
  report.js        precision/recall/F1, confusion matrix, threshold sweep
spike/
  a standalone unpacked extension proving an MV3 service worker can call
  api.typesafe.ai directly under host_permissions without hitting the CORS
  preflight a page-context fetch would — the assumption the whole
  architecture rests on
```

One layout choice is worth explaining: `core/` lives *inside* `extension/`,
not beside it. A Chrome extension's root directory defines its package —
files outside it can't be imported, packed, or unpacked. Putting `core/` at
the repo root would make `extension/background.js`'s import of it
unresolvable inside Chrome. The CLI and eval scripts reach *into*
`extension/core/` from outside (`../extension/core/segment.js`, etc.); the
extension itself never reaches out.

## License

MIT, see [LICENSE](LICENSE).
