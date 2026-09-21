#!/usr/bin/env node
// cli/scan.js
//
// Segment + score a saved HTML file against Jev (spec §8 "cli/scan.ts",
// §9 build-order step 1). This is the thing a human reads to judge
// whether Jev's answers are any good, so the terminal report is the
// actual deliverable here, not a side effect.
//
// Invocation:
//   node --env-file=.env cli/scan.js <path-to-html> [--source example.com] [--json out.json]

import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { extractBlocks } from './extract.js';
import { segmentBlocks } from '../extension/core/segment.js';
import { planChunks, reattachVerdicts } from '../extension/core/chunkPlan.js';
import { scoreChunk } from '../extension/core/scoreChunk.js';
import { rollupScore } from '../extension/core/weights.js';
import { CATEGORIES } from '../extension/core/questions.js';

const CHUNK_SIZE = 40; // spec §3.4
const MAX_CONCURRENT_CHUNKS = 6; // spec §3.4: "sent 6-way concurrent"
const PRICE_PER_MILLION_INPUT_TOKENS = 0.042; // spec §1/§5 — output is free
const DOCUMENT_TYPE = 'Terms of Service';
const UNCLEAR_DESCRIPTION =
  "Noul flagged this as harmful, but the Choice's category label was low-confidence or " +
  'disagreed outright (landed on "benign") — spec §4.2 keeps the flag and drops the label ' +
  'rather than forcing a category.';

const USAGE = 'Usage: node --env-file=.env cli/scan.js <path-to-html> [--source example.com] [--json out.json]';

const isTTY = Boolean(process.stdout.isTTY);
const ansi = (code, text) => (isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const red = (t) => ansi('31', t);
const amber = (t) => ansi('33', t);
const bold = (t) => ansi('1', t);
const dim = (t) => ansi('2', t);

function colorForSeverity(severity, text) {
  if (severity === 'high') return red(text);
  if (severity === 'medium' || severity === 'low') return amber(text);
  return text;
}

function parseArgs(argv) {
  const args = { file: null, source: 'unknown', json: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') {
      args.source = argv[++i];
    } else if (a === '--json') {
      args.json = argv[++i];
    } else {
      positional.push(a);
    }
  }
  args.file = positional[0] ?? null;
  return args;
}

// Word-wraps `text` to `width` columns with a fixed left indent, without
// truncating any of it — a clause can run past 300 chars and still print
// in full, just over more lines.
function wrapText(text, width = 96, indent = '      ') {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && indent.length + candidate.length > width) {
      lines.push(indent + current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(indent + current);
  return lines.join('\n');
}

function formatPct(p) {
  return `${Math.round(p * 100)}%`;
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

// Maps thrown-error `.code`s (extension/core/scoreChunk.js) to messages a human can
// act on. Never includes the key itself, not even partially.
function describeError(err) {
  switch (err && err.code) {
    case 'UNAUTHORIZED':
      return (
        'Jev rejected the API key (401). The key in .env is invalid or has been revoked — ' +
        'get a fresh one from the TypeSafe console and update .env.'
      );
    case 'RATE_LIMITED':
      return 'Jev rate-limited this scan and retries were exhausted. Wait a bit and try again.';
    case 'NETWORK':
      return `Network error talking to Jev: ${err.message}`;
    case 'INVALID_RESPONSE':
      return `Jev's response wasn't in the shape scan.js expected: ${err.message}`;
    default:
      return err && err.message ? err.message : String(err);
  }
}

async function main() {
  const t0 = performance.now();
  const { file, source, json } = parseArgs(process.argv.slice(2));

  if (!file) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    console.error(
      'Missing TYPESAFE_API_KEY. Add a line "TYPESAFE_API_KEY=<your key>" to .env in the ' +
      'project root, then run: node --env-file=.env cli/scan.js <path-to-html>'
    );
    process.exitCode = 1;
    return;
  }

  let html;
  try {
    html = await readFile(file, 'utf8');
  } catch (err) {
    console.error(`Could not read "${file}": ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const blocks = extractBlocks(html);
  const clauses = segmentBlocks(blocks);
  const chunks = planChunks(clauses, CHUNK_SIZE);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let modelSeen = null;

  const onUsage = ({ inputTokens, outputTokens, model }) => {
    totalInputTokens += inputTokens || 0;
    totalOutputTokens += outputTokens || 0;
    if (model) modelSeen = model;
  };

  let reattached;
  try {
    const perChunk = await mapWithConcurrency(chunks, MAX_CONCURRENT_CHUNKS, async (chunk) => {
      const verdicts = await scoreChunk(
        chunk.map((c) => c.text),
        { apiKey, documentType: DOCUMENT_TYPE, source, onUsage },
      );
      return reattachVerdicts(chunk, verdicts);
    });
    reattached = perChunk.flat();
  } catch (err) {
    console.error(describeError(err));
    process.exitCode = 1;
    return;
  }

  // Join verdicts back to clause text by id — the same join key the eval
  // harness will use against a labels file, per the spec's JSON-design
  // requirement below.
  const textById = new Map(clauses.map((c) => [c.id, c.text]));
  const results = reattached.map((v) => ({ ...v, text: textById.get(v.id) }));

  const flagged = results.filter((r) => r.flagged);
  const pageScore = rollupScore(
    flagged.map((f) => ({ probability: f.probability, category: f.category })),
    results.length,
  );
  const unclearCount = results.filter((r) => r.category === 'unclear').length;

  const categoryBreakdown = {};
  for (const f of flagged) {
    categoryBreakdown[f.category] = (categoryBreakdown[f.category] || 0) + 1;
  }

  const elapsedMs = performance.now() - t0;
  const estimatedCost = (totalInputTokens / 1_000_000) * PRICE_PER_MILLION_INPUT_TOKENS;

  // ---- Report ----
  console.log(bold('Fine Print Fury — scan report'));
  console.log(`  file:    ${file}`);
  console.log(`  source:  ${source}`);
  console.log(`  blocks:  ${blocks.length}   clauses: ${clauses.length}   chunks: ${chunks.length}`);
  console.log('');

  const sortedFlagged = [...flagged].sort((a, b) => b.probability - a.probability);

  if (sortedFlagged.length === 0) {
    console.log(dim('No clauses flagged.'));
  } else {
    console.log(bold(`Flagged clauses (${sortedFlagged.length}), by probability descending:`));
    console.log('');
    for (const f of sortedFlagged) {
      const pctText = formatPct(f.probability).padStart(4);
      const catLabel = f.category === 'unclear' ? 'unclear' : f.category;
      const catDesc = f.category === 'unclear' ? '' : CATEGORIES[f.category] ? ` — ${CATEGORIES[f.category]}` : '';
      const confText = f.categoryConfidence != null ? `confidence ${formatPct(f.categoryConfidence)}` : 'confidence n/a';
      const header = `  [${pctText}] ${catLabel}${catDesc}  (${confText}, severity: ${f.severity})`;
      console.log(colorForSeverity(f.severity, header));
      if (f.category === 'unclear') {
        console.log(dim(wrapText(UNCLEAR_DESCRIPTION, 96, '      ')));
      }
      console.log(wrapText(f.text, 96, '      '));
      console.log('');
    }
  }

  console.log(bold('Summary'));
  console.log(`  total clauses:     ${results.length}`);
  console.log(
    `  flagged:           ${flagged.length} (${results.length ? formatPct(flagged.length / results.length) : '0%'})`,
  );
  console.log(`  unclear verdicts:  ${unclearCount}`);
  console.log(`  page score:        ${pageScore} / 100`);
  console.log('  category breakdown:');
  const catEntries = Object.entries(categoryBreakdown).sort((a, b) => b[1] - a[1]);
  if (catEntries.length === 0) {
    console.log('    (none)');
  } else {
    for (const [cat, count] of catEntries) {
      console.log(`    ${cat.padEnd(30)} ${count}`);
    }
  }
  console.log('');
  console.log(bold('Usage & cost'));
  console.log(`  model:             ${modelSeen ?? '(unknown)'}`);
  console.log(`  input tokens:      ${totalInputTokens.toLocaleString()}`);
  console.log(`  output tokens:     ${totalOutputTokens.toLocaleString()} (free)`);
  console.log(`  estimated cost:    $${estimatedCost.toFixed(6)}`);
  console.log(`  elapsed:           ${(elapsedMs / 1000).toFixed(2)}s`);

  if (json) {
    const payload = {
      meta: {
        file,
        source,
        documentType: DOCUMENT_TYPE,
        model: modelSeen,
        generatedAt: new Date().toISOString(),
        blockCount: blocks.length,
        clauseCount: clauses.length,
        chunkCount: chunks.length,
      },
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        estimatedCostUsd: estimatedCost,
      },
      pageScore,
      summary: {
        totalClauses: results.length,
        flaggedCount: flagged.length,
        flaggedPercent: results.length ? flagged.length / results.length : 0,
        categoryBreakdown,
        unclearCount,
      },
      // Flagged and unflagged clauses alike, each carrying its own id and
      // text, so an eval report can join this against a labels file by
      // clause id without a second lookup into the source document.
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
    await writeFile(json, JSON.stringify(payload, null, 2), 'utf8');
    console.log('');
    console.log(dim(`Wrote full results to ${json}`));
  }
}

main();
