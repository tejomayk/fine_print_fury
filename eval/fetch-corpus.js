// eval/fetch-corpus.js
//
// Downloads the 5-document evaluation corpus (spec §7) into eval/corpus/.
// Plain ESM, zero new dependencies beyond what's already in the repo
// (`linkedom`, via cli/extract.js) — uses Node's built-in `fetch`/`fs`.
//
// Usage:
//   node eval/fetch-corpus.js
//
// Why this validates through the REAL extractor (not a heuristic):
// a first pass of this script used a crude tag-stripping word count and
// got fooled twice: an Ally Bank URL that actually served a PDF (whose
// raw bytes happen to contain enough literal text tokens to clear a
// naive word count) and a lease-advice article whose prose is *about*
// lease clauses in the third person rather than an actual lease
// instrument (extracts fine, scores 0 flagged clauses, useless as
// eval material). Neither failure was visible through a word count
// alone. This version instead runs each candidate through the actual
// `extractBlocks()` the CLI/extension pipeline uses (spec §3.2/§3.3),
// and additionally checks that the extracted text reads like a contract
// addressed to a reader ("you agree", "shall not", ...) rather than
// commentary about one.
//
// Every source here is a *real, currently-live legal document* (or an
// official rendered/embedded copy of one) fetched over the network —
// nothing is invented or hand-authored. Two of the five required a
// documented `transform` (see TRANSFORMS below) to cut a real, unedited
// instrument out of a larger page; the transform never alters contract
// text, only trims surrounding site chrome. See eval/corpus/manifest.json
// for exactly which URL (and transform, if any) backed each file, plus
// all three acceptance checks and a first-5-blocks sample per document.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBlocks } from '../cli/extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.join(__dirname, 'corpus');

const WORD_THRESHOLD = 1500; // spec §3.2
const MARKER_THRESHOLD = 5;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Case-insensitive markers of contractual-obligation language directed at
// the reader ("you"/"we") rather than third-person commentary describing
// contracts in general. A page that discusses clauses in the abstract
// (an explainer article) reliably fails this; a real contract addressing
// its reader directly clears it easily.
const CONTRACT_MARKERS = [
  'you agree',
  'you may not',
  'shall not',
  'we reserve the right',
  'hereby',
  'this agreement',
  'you acknowledge',
  'at our sole discretion',
];

// Each slot is one corpus document. `tries` is walked in order; the first
// candidate that passes ALL THREE checks (isHtml, word count, marker
// count) wins. This is the "substitute freely if one fails" mechanism
// the task calls for, made explicit and automatic.
const SLOTS = [
  {
    name: 'GitHub Terms of Service',
    outFile: 'github.html',
    documentType: 'Terms of Service',
    tries: [
      {
        url: 'https://docs.github.com/en/site-policy/github-terms/github-terms-of-service',
        source: 'github.com',
      },
      {
        // Fallback: GitHub's own open-sourced mirror of the same terms,
        // as raw Markdown. Wrapped into minimal block-level HTML so the
        // segmentation pipeline (which walks p/li/td/div) sees the same
        // shape it would see on a real page.
        url: 'https://raw.githubusercontent.com/github/site-policy/main/Policies/github-terms/github-terms-of-service.md',
        source: 'github.com',
        transform: 'markdown',
      },
    ],
  },
  {
    name: 'Spotify Terms of Use',
    outFile: 'spotify.html',
    documentType: 'Terms of Use',
    tries: [
      { url: 'https://www.spotify.com/us/legal/end-user-agreement/', source: 'spotify.com' },
    ],
  },
  {
    // Every bank/card-issuer agreement tried (Ally, Chase, Discover,
    // Capital One, Wells Fargo, Varo, SoFi, Amex...) is either served as
    // a PDF, gated behind a bot check, or 404s its public HTML mirror —
    // see the accompanying report for the specific dead ends. Per the
    // task's own fallback guidance, substituting a different real
    // consumer contract served as HTML: an airline's Contract of
    // Carriage is exactly this — a live, binding, reader-facing
    // financial/commercial services agreement (fare rules, refund
    // rules, liability limitations, denied-boarding compensation).
    name: 'Delta Domestic Contract of Carriage (financial/consumer-contract substitute for a bank agreement)',
    outFile: 'airline-coc.html',
    documentType: 'Contract of Carriage',
    tries: [
      { url: 'https://www.delta.com/us/en/legal/contract-of-carriage-dgr', source: 'delta.com' },
      { url: 'https://www.delta.com/us/en/legal/contract-of-carriage-igr', source: 'delta.com' },
    ],
  },
  {
    name: 'Coats Digital SaaS EULA',
    outFile: 'saas-eula.html',
    documentType: 'EULA',
    tries: [
      { url: 'https://www.coatsdigital.com/en/eula-saas/', source: 'coatsdigital.com' },
      { url: 'https://cynomi.com/eula/', source: 'cynomi.com' },
    ],
  },
  {
    name: 'Residential Lease Agreement (Rocket Lawyer template, embedded document extracted)',
    outFile: 'lease.html',
    documentType: 'Lease Agreement',
    tries: [
      {
        // Rocket Lawyer's document-preview page embeds a full,
        // real, fillable lease *instrument* inside
        // <figure id="githubTmplt">...</figure>, wrapped in marketing
        // chrome (nav, FAQ, "why use this" copy) before and after it.
        // ipropertymanagement.com (this slot's original source) was
        // 100% commentary *about* leases and never contained an actual
        // instrument at any offset -- this page is the opposite: the
        // chrome is real, but so is a complete operative lease
        // underneath it. The 'trim' transform below cuts out exactly
        // that embedded instrument (unmodified) and discards the
        // surrounding chrome, so the saved corpus file *starts* with
        // "This Lease Agreement..." rather than "Account / Get our
        // app / What we'll cover".
        url: 'https://www.rocketlawyer.com/real-estate/landlords/residential-property/document/lease-agreement',
        source: 'rocketlawyer.com',
        transform: 'trim',
        trimStart: '<figure id="githubTmplt">',
        trimEnd: '</figure>',
      },
      {
        // Fallback if Rocket Lawyer's markup changes: a shorter but
        // still-genuine lease instrument (ailawyer.pro's template
        // generator embeds it in <div class="tpl-paper">...) trimmed
        // the same way. Noted as a fallback, not primary, because its
        // instrument alone runs under WORD_THRESHOLD once the
        // surrounding marketing copy is removed -- it would need a
        // higher tolerance to pass on its own, which is exactly why it
        // is second in line rather than first.
        url: 'https://ailawyer.pro/templates/residential-lease-agreement',
        source: 'ailawyer.pro',
        transform: 'trim',
        trimStart: '<h2 id="residential-lease">',
        trimEnd: '[Tenant Name]</em></p>',
      },
    ],
  },
];

/**
 * Minimal Markdown -> HTML: wraps paragraphs and list items in real block
 * elements (p/li inside ul) so the segmentation pipeline's block walk
 * finds the same shape it would in a rendered page. Deliberately dumb --
 * this is a fallback path for one candidate, not a Markdown renderer.
 *
 * @param {string} md
 * @returns {string}
 */
function markdownToBlockHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = md.split('\n');
  const out = ['<!doctype html><html><head><meta charset="utf-8"></head><body>'];
  let paragraph = [];
  let inList = false;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${esc(paragraph.join(' ')).trim()}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') {
      flushParagraph();
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      flushParagraph();
      closeList();
      const text = line.replace(/^#{1,6}\s+/, '');
      out.push(`<div>${esc(text)}</div>`);
      continue;
    }
    const listMatch = line.match(/^[-*]\s+(.*)$/);
    if (listMatch) {
      flushParagraph();
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${esc(listMatch[1])}</li>`);
      continue;
    }
    closeList();
    paragraph.push(line);
  }
  flushParagraph();
  closeList();
  out.push('</body></html>');
  return out.join('\n');
}

/**
 * Cuts a substring out of a larger real HTML page between two literal
 * anchor strings (inclusive), and wraps it in a minimal document shell.
 * Used to separate a real, embedded contract instrument from the
 * marketing/navigation chrome a template-generator site wraps around it
 * -- the contract text inside the slice is untouched, byte-for-byte.
 *
 * @param {string} html
 * @param {{trimStart:string, trimEnd:string}} candidate
 * @returns {string}
 */
function trimToFragment(html, candidate) {
  const startIdx = html.indexOf(candidate.trimStart);
  if (startIdx === -1) {
    throw new Error(`trim start marker not found: ${JSON.stringify(candidate.trimStart)}`);
  }
  const endMarkerIdx = html.indexOf(candidate.trimEnd, startIdx);
  if (endMarkerIdx === -1) {
    throw new Error(`trim end marker not found: ${JSON.stringify(candidate.trimEnd)}`);
  }
  const fragment = html.slice(startIdx, endMarkerIdx + candidate.trimEnd.length);
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${fragment}</body></html>`;
}

/**
 * Counts total (not distinct) case-insensitive occurrences of
 * CONTRACT_MARKERS across the extracted block text.
 *
 * @param {string[]} blocks
 * @returns {number}
 */
function countContractMarkers(blocks) {
  const joined = blocks.join(' \n ').toLowerCase();
  let count = 0;
  for (const marker of CONTRACT_MARKERS) {
    const re = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const matches = joined.match(re);
    if (matches) count += matches.length;
  }
  return count;
}

/**
 * Fetches one candidate, applies its transform (if any), and runs it
 * through the real pipeline: checks it's genuine HTML (not a PDF or
 * other content type wearing an .html extension), extracts blocks with
 * the actual `extractBlocks()`, and scores word/marker counts against
 * that extraction -- never against raw bytes or a tag-stripping
 * approximation.
 *
 * @param {object} candidate
 * @returns {Promise<{html:string, blocks:string[], checks:object}>}
 */
async function evaluateCandidate(candidate) {
  const res = await fetch(candidate.url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const contentType = res.headers.get('content-type') || '';
  const rawBody = await res.text();

  // Reject anything that isn't real HTML outright -- a 200 with an
  // application/pdf content-type (or a body starting with the PDF magic
  // bytes, in case a server mislabels it) is not a fetch failure but it
  // is definitely not a document extractBlocks() can do anything with.
  const isHtml = contentType.includes('text/html') && !rawBody.startsWith('%PDF');

  // Markdown candidates never claim text/html from the server (raw.
  // githubusercontent.com serves text/plain), so `isHtml` above is
  // always false for them -- that candidate type is synthesized into
  // HTML deliberately and is handled as its own branch below rather
  // than gated on the isHtml check.
  let html = rawBody;
  if (candidate.transform === 'markdown') {
    html = markdownToBlockHtml(rawBody);
  } else if (candidate.transform === 'trim') {
    if (!isHtml) throw new Error(`not HTML (content-type "${contentType}"), cannot trim`);
    html = trimToFragment(rawBody, candidate);
  } else if (!isHtml) {
    throw new Error(`not HTML (content-type "${contentType}")`);
  }

  const blocks = extractBlocks(html);
  const wordCount = blocks.join(' ').split(/\s+/).filter(Boolean).length;
  const markerCount = countContractMarkers(blocks);

  const checks = {
    isHtml: candidate.transform === 'markdown' ? true : isHtml, // markdown is synthesized into HTML deliberately
    blockCount: blocks.length,
    wordCount,
    wordsPass: wordCount >= WORD_THRESHOLD,
    markerCount,
    markersPass: markerCount >= MARKER_THRESHOLD,
  };
  checks.pass = checks.isHtml && checks.wordsPass && checks.markersPass;

  return { html, blocks, checks };
}

async function fetchSlot(slot) {
  const attempts = [];
  let winner = null;

  for (const candidate of slot.tries) {
    let evaluated = null;
    let error = null;
    try {
      evaluated = await evaluateCandidate(candidate);
    } catch (e) {
      error = e.message;
    }
    attempts.push({ url: candidate.url, error, checks: evaluated?.checks ?? null });
    if (evaluated && evaluated.checks.pass) {
      winner = { candidate, ...evaluated };
      break; // first fully-passing candidate wins
    }
  }

  return { slot, attempts, winner };
}

async function main() {
  await mkdir(CORPUS_DIR, { recursive: true });

  const results = [];
  const manifest = [];

  for (const slot of SLOTS) {
    const { attempts, winner } = await fetchSlot(slot);

    if (!winner) {
      results.push({ name: slot.name, outFile: slot.outFile, pass: false, attempts });
      console.error(`\nAll candidates failed for "${slot.name}":`);
      for (const a of attempts) {
        console.error(`  ${a.url}: ${a.error ?? JSON.stringify(a.checks)}`);
      }
      continue;
    }

    const outPath = path.join(CORPUS_DIR, slot.outFile);
    await writeFile(outPath, winner.html, 'utf8');

    const first5 = winner.blocks.slice(0, 5);
    results.push({
      name: slot.name,
      outFile: slot.outFile,
      url: winner.candidate.url,
      source: winner.candidate.source,
      transform: winner.candidate.transform ?? null,
      checks: winner.checks,
      first5,
      pass: true,
    });
    manifest.push({
      outFile: slot.outFile,
      documentType: slot.documentType,
      source: winner.candidate.source,
      url: winner.candidate.url,
      transform: winner.candidate.transform ?? null,
      fetchedAt: new Date().toISOString(),
      checks: {
        isHtml: winner.checks.isHtml,
        blockCount: winner.checks.blockCount,
        wordCount: winner.checks.wordCount,
        wordThreshold: WORD_THRESHOLD,
        wordsPass: winner.checks.wordsPass,
        markerCount: winner.checks.markerCount,
        markerThreshold: MARKER_THRESHOLD,
        markersPass: winner.checks.markersPass,
      },
      pass: winner.checks.pass,
      first5Blocks: first5.map((b) => (b.length > 200 ? `${b.slice(0, 200)}…` : b)),
    });
  }

  await writeFile(
    path.join(CORPUS_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  // --- Report ---
  console.log('');
  console.log('=== Per-document checks (real extractBlocks pipeline) ===');
  for (const r of results) {
    console.log('');
    console.log(`${r.name}`);
    console.log(`  file: eval/corpus/${r.outFile}`);
    if (!r.pass) {
      console.log('  RESULT: FAIL (no candidate passed all three checks)');
      continue;
    }
    console.log(`  source: ${r.url}${r.transform ? ` (transform: ${r.transform})` : ''}`);
    const c = r.checks;
    console.log(
      `  [${c.isHtml ? 'PASS' : 'FAIL'}] is HTML (not PDF/other)`,
    );
    console.log(
      `  [${c.wordsPass ? 'PASS' : 'FAIL'}] words in extractBlocks() output: ${c.wordCount} (need >= ${WORD_THRESHOLD}), across ${c.blockCount} blocks`,
    );
    console.log(
      `  [${c.markersPass ? 'PASS' : 'FAIL'}] contract-obligation markers: ${c.markerCount} (need >= ${MARKER_THRESHOLD})`,
    );
    console.log(`  RESULT: ${c.pass ? 'PASS' : 'FAIL'}`);
    console.log('  first 5 blocks:');
    r.first5.forEach((b, i) => {
      const shown = b.length > 140 ? `${b.slice(0, 140)}…` : b;
      console.log(`    ${i}: ${shown}`);
    });
  }

  console.log('');
  console.log('=== Summary ===');
  const nameW = Math.max(...results.map((r) => r.outFile.length), 'File'.length);
  console.log(`${'File'.padEnd(nameW)}  HTML  Words  Markers  Result`);
  for (const r of results) {
    if (!r.pass) {
      console.log(`${r.outFile.padEnd(nameW)}  --    --     --       FAIL`);
      continue;
    }
    const c = r.checks;
    console.log(
      `${r.outFile.padEnd(nameW)}  ${c.isHtml ? ' Y  ' : ' N  '}  ${String(c.wordCount).padEnd(5)}  ${String(c.markerCount).padEnd(7)}  ${c.pass ? 'PASS' : 'FAIL'}`,
    );
  }
  console.log('');

  const allPass = results.every((r) => r.pass);
  if (!allPass) {
    console.error('One or more corpus documents did not clear all three checks.');
    process.exitCode = 1;
  } else {
    console.log(`All ${results.length} documents passed: real HTML, word density, and contract-marker checks.`);
  }
}

main().catch((err) => {
  console.error('fetch-corpus failed:', err);
  process.exitCode = 1;
});
