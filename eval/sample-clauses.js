#!/usr/bin/env node
// eval/sample-clauses.js
//
// Produces a stratified sample of clauses across all five corpus documents
// for hand-labeling (spec §7's "~50 hand-labeled clauses ... over-sampling
// near-misses"). Stratified by Jev's raw Noul probability into three bands:
//
//   p >= 0.70            -> 15 clauses  (precision on confident flags)
//   0.40 <= p < 0.70     -> 20 clauses  (the decision boundary -- the
//                           threshold is actually set here, so it is
//                           deliberately oversampled)
//   p < 0.40             -> 15 clauses  (recall -- are harmful clauses
//                           being missed?)
//
// Within each band, clauses are drawn round-robin across the five
// documents rather than exhausting one document first, so the final 50
// are spread across the whole corpus. Clauses under MIN_CLAUSE_LENGTH
// chars are excluded -- those are segmentation artifacts (stray fragments,
// list markers that slipped through), not judgment calls.
//
// This script only *samples*; it does not label. Labeling (spec §7's
// "hand-labeled") is a human/independent-reviewer judgment call and lives
// in eval/labels.candidate.json, written separately.
//
// Input: full `cli/scan.js --json` payloads for each corpus doc, expected
// at /tmp/<doc>.json (doc names below, no extension) -- exactly the
// convention produced by:
//
//   node --env-file=.env cli/scan.js eval/corpus/<doc>.html --source <doc> --json /tmp/<doc>.json
//
// If a cache file is missing and TYPESAFE_API_KEY is set in the
// environment, this script runs that same scan pipeline itself and writes
// the cache file, so `node --env-file=.env eval/sample-clauses.js` works
// standalone on a clean checkout. If the cache files already exist (the
// normal case once someone has run the scans once), a plain
// `node eval/sample-clauses.js` needs no API key at all.
//
// Usage:
//   node --env-file=.env eval/sample-clauses.js   (first run / regenerate caches)
//   node eval/sample-clauses.js                   (reuse existing /tmp/<doc>.json caches)

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBlocks } from '../cli/extract.js';
import { segmentBlocks } from '../extension/core/segment.js';
import { planChunks, reattachVerdicts } from '../extension/core/chunkPlan.js';
import { scoreChunk } from '../extension/core/scoreChunk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.join(__dirname, 'corpus');
const CACHE_DIR = '/tmp';
const CHUNK_SIZE = 40; // spec §3.4
const MAX_CONCURRENT_CHUNKS = 6; // spec §3.4
const MIN_CLAUSE_LENGTH = 30; // segmentation artifacts below this are excluded
const DOCUMENT_TYPE = 'Terms of Service';

// doc name (no extension) -> corpus filename. Order here is the fixed
// round-robin order used when drawing samples within a band.
const DOCS = [
  ['github', 'github.html'],
  ['spotify', 'spotify.html'],
  ['airline-coc', 'airline-coc.html'],
  ['saas-eula', 'saas-eula.html'],
  ['lease', 'lease.html'],
];

const BANDS = [
  { name: 'high', label: 'p >= 0.70', min: 0.70, max: Infinity, count: 15 },
  { name: 'boundary', label: '0.40 <= p < 0.70', min: 0.40, max: 0.70, count: 20 },
  { name: 'low', label: 'p < 0.40', min: -Infinity, max: 0.40, count: 15 },
];

// Small deterministic PRNG (mulberry32) so the sample is reproducible
// across runs given the same input scans -- a labeling exercise should not
// silently re-shuffle which 50 clauses were reviewed if it's re-run.
function mulberry32(seed) {
  let a = seed;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, rand) {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Loads the full cli/scan.js --json payload for `doc`, from cache if
 * present, otherwise running the scan pipeline directly (mirrors
 * cli/scan.js) and writing the cache for next time.
 */
async function getScanForDoc(doc, filename) {
  const cachePath = path.join(CACHE_DIR, `${doc}.json`);
  if (existsSync(cachePath)) {
    return JSON.parse(await readFile(cachePath, 'utf8'));
  }

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new Error(
      `No cached scan at ${cachePath} and no TYPESAFE_API_KEY in the environment. Run:\n` +
      `  node --env-file=.env cli/scan.js eval/corpus/${filename} --source ${doc} --json ${cachePath}\n` +
      `or re-run this script with --env-file=.env so it can generate the cache itself.`,
    );
  }

  const html = await readFile(path.join(CORPUS_DIR, filename), 'utf8');
  const blocks = extractBlocks(html);
  const clauses = segmentBlocks(blocks);
  const chunks = planChunks(clauses, CHUNK_SIZE);

  const perChunk = await mapWithConcurrency(chunks, MAX_CONCURRENT_CHUNKS, async (chunk) => {
    const verdicts = await scoreChunk(
      chunk.map((c) => c.text),
      { apiKey, documentType: DOCUMENT_TYPE, source: doc },
    );
    return reattachVerdicts(chunk, verdicts);
  });
  const reattached = perChunk.flat();
  const textById = new Map(clauses.map((c) => [c.id, c.text]));
  const results = reattached.map((v) => ({ ...v, text: textById.get(v.id) }));

  const payload = {
    meta: { file: `eval/corpus/${filename}`, source: doc, documentType: DOCUMENT_TYPE },
    clauses: results.map((r) => ({
      id: r.id,
      text: r.text,
      flagged: r.flagged,
      probability: r.probability,
      category: r.category,
      categoryConfidence: r.categoryConfidence,
      severity: r.severity,
    })),
  };
  await writeFile(cachePath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

/**
 * Draws up to `count` clauses from `perDocEligible` (doc -> shuffled
 * eligible-clause array) round-robin across docs, so no single document
 * dominates a band while still allowing bands with few eligible clauses in
 * a given document to be filled from elsewhere.
 */
function drawRoundRobin(perDocEligible, count) {
  const docOrder = DOCS.map(([doc]) => doc);
  const cursors = Object.fromEntries(docOrder.map((d) => [d, 0]));
  const picked = [];
  let madeProgress = true;
  while (picked.length < count && madeProgress) {
    madeProgress = false;
    for (const doc of docOrder) {
      if (picked.length >= count) break;
      const list = perDocEligible[doc] || [];
      if (cursors[doc] < list.length) {
        picked.push(list[cursors[doc]]);
        cursors[doc]++;
        madeProgress = true;
      }
    }
  }
  return picked;
}

async function main() {
  const rand = mulberry32(20260920); // fixed seed: reproducible sampling

  const allClauses = []; // { doc, filename, id, text, probability }
  for (const [doc, filename] of DOCS) {
    const scan = await getScanForDoc(doc, filename);
    for (const c of scan.clauses) {
      if (typeof c.text === 'string' && c.text.length >= MIN_CLAUSE_LENGTH) {
        allClauses.push({ doc, filename, id: c.id, text: c.text, probability: c.probability });
      }
    }
  }

  const sample = [];
  const bandReport = [];
  for (const band of BANDS) {
    const inBand = allClauses.filter((c) => c.probability >= band.min && c.probability < band.max);
    const perDoc = {};
    for (const [doc] of DOCS) {
      perDoc[doc] = shuffle(inBand.filter((c) => c.doc === doc), rand);
    }
    const picked = drawRoundRobin(perDoc, band.count);
    sample.push(...picked.map((c) => ({ ...c, band: band.name })));
    bandReport.push({ band: band.name, label: band.label, eligible: inBand.length, picked: picked.length });
  }

  // Write the raw sample (with probability, for the labeler's own
  // after-the-fact comparison -- NOT to be consulted before forming an
  // independent judgment) to a scratch file for the labeling step to read.
  const outPath = path.join(CACHE_DIR, 'fpf-sample.json');
  await writeFile(outPath, JSON.stringify(sample, null, 2), 'utf8');

  console.log('Fine Print Fury — clause sample');
  console.log('');
  console.log('Band counts:');
  for (const b of bandReport) {
    console.log(`  ${b.band.padEnd(10)} (${b.label.padEnd(18)}) eligible=${String(b.eligible).padEnd(5)} picked=${b.picked}`);
  }
  console.log('');
  console.log(`Total sampled: ${sample.length}`);
  console.log('');
  console.log('Per-document spread:');
  for (const [doc] of DOCS) {
    const n = sample.filter((c) => c.doc === doc).length;
    console.log(`  ${doc.padEnd(14)} ${n}`);
  }
  console.log('');
  console.log(`Wrote sample to ${outPath}`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error('sample-clauses.js failed:', err);
    process.exitCode = 1;
  });
}
