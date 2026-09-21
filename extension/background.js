// Fine Print Fury — background service worker (the orchestrator).
//
// This is the ONLY extension file that touches `extension/core/` or the network
// (spec §2). MV3 content scripts cannot use static ESM imports, so this
// worker — declared `"type": "module"` in manifest.json — is where
// segmentation, chunking, and scoring all happen. The content script only
// walks the DOM and sends raw block text; it never imports from
// `extension/core/`. This worker sends back verdicts carrying `spans` so
// the content script can map them onto DOM Ranges without ever running
// `extension/core/segment.js` itself.
//
// Message contract (must match extension/content.js and extension/popup.js
// exactly — three files are coded against this same list):
//
//   content -> background:
//     { type:'SCAN_REQUEST', requestId, documentType, source, blocks: string[] }
//
//   background -> content:
//     { type:'SCAN_RESULT', requestId, ok:true, pageScore, model, clauseCount,
//       flaggedCount, verdicts: [{ id, flagged, probability, category,
//       categoryConfidence, severity, spans }] }
//     { type:'SCAN_RESULT', requestId, ok:false,
//       errorCode: 'NO_KEY'|'UNAUTHORIZED'|'RATE_LIMITED'|'NETWORK'|'UNKNOWN',
//       message }
//
//   popup -> background:
//     { type:'GET_KEY_STATUS' }      -> { type:'KEY_STATUS', hasKey }
//     { type:'SET_API_KEY', apiKey } -> { type:'SET_API_KEY_RESULT', ok, errorCode? }
//     { type:'TRIGGER_SCAN' }        -> { type:'TRIGGER_SCAN_RESULT', ok, errorCode?, message? }
//
// The API key lives in chrome.storage.local ONLY — never `.sync`, which
// would replicate a billing credential through the user's Google account
// (spec §2, §6.3, §10). It is never logged, not even partially.

import { segmentBlocks } from './core/segment.js';
import { scoreChunk, validateApiKey } from './core/scoreChunk.js';
import { planChunks, reattachVerdicts } from './core/chunkPlan.js';
import { rollupScore } from './core/weights.js';

const LOG_PREFIX = '[FPF]';

// Single storage key for the Jev API key. chrome.storage.LOCAL only — see
// the header comment above and spec §10 ("Holding a user's billing
// credential" -> ".local only, never .sync").
const STORAGE_KEY_API_KEY = 'fpf_jev_api_key';

const CHUNK_SIZE = 40; // spec §3.4
const MAX_CONCURRENT_CHUNKS = 6; // spec §3.4: "sent 6-way concurrent"

// URL prefixes/suffixes chrome.scripting.executeScript cannot inject into,
// or that would produce no usable page text even if injection "succeeded":
// browser-internal pages, the extension gallery, and the built-in PDF
// viewer. Checked before attempting injection so the failure is a clear
// errorCode instead of a silent no-op (spec responsibility #3).
const RESTRICTED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'chrome-untrusted://',
  'edge://',
  'about:',
  'devtools://',
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com',
];

function isRestrictedUrl(url) {
  if (!url || typeof url !== 'string') return true;
  if (RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) return true;
  if (url.toLowerCase().split('?')[0].endsWith('.pdf')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Key storage
// ---------------------------------------------------------------------------

async function getStoredApiKey() {
  const result = await chrome.storage.local.get(STORAGE_KEY_API_KEY);
  return typeof result[STORAGE_KEY_API_KEY] === 'string' ? result[STORAGE_KEY_API_KEY] : null;
}

async function setStoredApiKey(apiKey) {
  await chrome.storage.local.set({ [STORAGE_KEY_API_KEY]: apiKey });
}

// ---------------------------------------------------------------------------
// Concurrency helper (same shape as cli/scan.js's, so the two orchestrators
// behave identically under load)
// ---------------------------------------------------------------------------

/**
 * Runs `worker` over `items` with at most `limit` in flight concurrently.
 * Results are returned index-aligned with `items` regardless of completion
 * order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item:T, index:number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    for (;;) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }

  const laneCount = Math.min(limit, items.length);
  const lanes = Array.from({ length: laneCount }, () => runNext());
  await Promise.all(lanes);
  return results;
}

// ---------------------------------------------------------------------------
// extension/core/scoreChunk.js error -> SCAN_RESULT errorCode mapping (spec §6.2)
// ---------------------------------------------------------------------------

function mapScoreChunkErrorCode(err) {
  const code = err && err.code;
  if (code === 'UNAUTHORIZED' || code === 'RATE_LIMITED' || code === 'NETWORK') {
    return code;
  }
  // Includes 'INVALID_RESPONSE' from scoreChunk, plain Errors thrown by
  // reattachVerdicts on a length mismatch, and anything unanticipated.
  // Never let one of these escape unmapped — the content script is
  // waiting on a reply and would hang forever otherwise.
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleGetKeyStatus() {
  const apiKey = await getStoredApiKey();
  return { type: 'KEY_STATUS', hasKey: Boolean(apiKey) };
}

async function handleSetApiKey(message) {
  const apiKey = typeof message.apiKey === 'string' ? message.apiKey.trim() : '';

  if (!apiKey) {
    console.log(`${LOG_PREFIX} SET_API_KEY: empty key submitted, rejecting.`);
    return { type: 'SET_API_KEY_RESULT', ok: false, errorCode: 'UNKNOWN' };
  }

  console.log(`${LOG_PREFIX} SET_API_KEY: validating key via validateApiKey()...`);

  let validation;
  try {
    validation = await validateApiKey(apiKey);
  } catch (err) {
    console.log(`${LOG_PREFIX} SET_API_KEY: validateApiKey threw unexpectedly: ${err && err.message}`);
    return { type: 'SET_API_KEY_RESULT', ok: false, errorCode: 'UNKNOWN' };
  }

  if (!validation.ok) {
    console.log(`${LOG_PREFIX} SET_API_KEY: rejected (${validation.errorCode}). Not storing.`);
    return { type: 'SET_API_KEY_RESULT', ok: false, errorCode: validation.errorCode || 'UNKNOWN' };
  }

  await setStoredApiKey(apiKey);
  console.log(`${LOG_PREFIX} SET_API_KEY: validated OK, stored in chrome.storage.local.`);
  return { type: 'SET_API_KEY_RESULT', ok: true };
}

async function handleTriggerScan() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (err) {
    console.log(`${LOG_PREFIX} TRIGGER_SCAN: tabs.query failed: ${err && err.message}`);
    return {
      type: 'TRIGGER_SCAN_RESULT',
      ok: false,
      errorCode: 'NO_ACTIVE_TAB',
      message: 'Could not find the active tab.',
    };
  }

  const tab = tabs && tabs[0];
  if (!tab || typeof tab.id !== 'number') {
    console.log(`${LOG_PREFIX} TRIGGER_SCAN: no active tab found.`);
    return {
      type: 'TRIGGER_SCAN_RESULT',
      ok: false,
      errorCode: 'NO_ACTIVE_TAB',
      message: 'No active tab to scan.',
    };
  }

  if (isRestrictedUrl(tab.url)) {
    console.log(`${LOG_PREFIX} TRIGGER_SCAN: refusing to inject into restricted page: ${tab.url}`);
    return {
      type: 'TRIGGER_SCAN_RESULT',
      ok: false,
      errorCode: 'RESTRICTED_PAGE',
      message: "This page can't be scanned (browser page, extension store, or PDF viewer).",
    };
  }

  console.log(
    `${LOG_PREFIX} TRIGGER_SCAN: injecting domwalk.js, detect.js, hoverCard.js, render.js, content.js into tab ${tab.id} (${tab.url})...`,
  );

  try {
    // Order matters: domwalk.js and detect.js publish walkBlocks()/
    // detectLegalPage() onto the shared globalThis.__FPF namespace;
    // hoverCard.js publishes showHoverCard()/hideHoverCard(); render.js
    // publishes renderVerdicts()/clearHighlights() (and calls into the
    // hover-card functions when hovering/focusing a mark, guarded so a
    // hoverCard.js load failure can't break highlighting). content.js
    // consumes all of it at its own top level and must load last. MV3
    // content scripts can't use static ESM imports, so this injection
    // order is the only thing gluing these files together (see
    // extension/content.js's header comment and extension/render.js's).
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['domwalk.js', 'detect.js', 'hoverCard.js', 'render.js', 'content.js'],
    });
  } catch (err) {
    console.log(`${LOG_PREFIX} TRIGGER_SCAN: injection failed: ${err && err.message}`);
    return {
      type: 'TRIGGER_SCAN_RESULT',
      ok: false,
      errorCode: 'RESTRICTED_PAGE',
      message: "Couldn't run on this page. It may be a restricted browser page or a local file.",
    };
  }

  // highlight.css has no manifest content_scripts block to load it
  // automatically (§3.1), so it needs its own explicit insertion, same as
  // the scripts above. This is best-effort and deliberately does not
  // affect the TRIGGER_SCAN_RESULT contract or error mapping: a CSS
  // injection failure means marks would render unstyled, not that the
  // scan itself failed, so it's logged and swallowed rather than turned
  // into a RESTRICTED_PAGE/errorCode response.
  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['highlight.css'],
    });
  } catch (err) {
    console.log(`${LOG_PREFIX} TRIGGER_SCAN: insertCSS failed (highlights may render unstyled): ${err && err.message}`);
  }

  console.log(`${LOG_PREFIX} TRIGGER_SCAN: content script injected; it will send SCAN_REQUEST when ready.`);
  return { type: 'TRIGGER_SCAN_RESULT', ok: true, message: 'Scanning this page…' };
}

async function handleScanRequest(message) {
  const { requestId, documentType, source, blocks } = message;

  const apiKey = await getStoredApiKey();
  if (!apiKey) {
    console.log(`${LOG_PREFIX} SCAN_REQUEST ${requestId}: no stored API key.`);
    return {
      type: 'SCAN_RESULT',
      requestId,
      ok: false,
      errorCode: 'NO_KEY',
      message: 'No Jev API key is saved yet. Add one in the extension popup.',
    };
  }

  if (!Array.isArray(blocks) || blocks.length === 0) {
    console.log(`${LOG_PREFIX} SCAN_REQUEST ${requestId}: no blocks provided.`);
    return {
      type: 'SCAN_RESULT',
      requestId,
      ok: false,
      errorCode: 'UNKNOWN',
      message: 'No text was found on this page to scan.',
    };
  }

  console.log(`${LOG_PREFIX} SCAN_REQUEST ${requestId}: segmenting ${blocks.length} block(s)...`);

  let clauses;
  try {
    clauses = segmentBlocks(blocks);
  } catch (err) {
    console.log(`${LOG_PREFIX} SCAN_REQUEST ${requestId}: segmentBlocks threw: ${err && err.message}`);
    return {
      type: 'SCAN_RESULT',
      requestId,
      ok: false,
      errorCode: 'UNKNOWN',
      message: 'Could not segment this page into clauses.',
    };
  }

  if (clauses.length === 0) {
    console.log(`${LOG_PREFIX} SCAN_REQUEST ${requestId}: segmentation produced zero clauses.`);
    return {
      type: 'SCAN_RESULT',
      requestId,
      ok: false,
      errorCode: 'UNKNOWN',
      message: 'No scoreable clauses were found on this page.',
    };
  }

  const chunks = planChunks(clauses, CHUNK_SIZE);
  console.log(
    `${LOG_PREFIX} SCAN_REQUEST ${requestId}: ${clauses.length} clause(s) -> ${chunks.length} chunk(s) ` +
      `of up to ${CHUNK_SIZE}, max ${MAX_CONCURRENT_CHUNKS} concurrent.`,
  );

  let modelSeen = null;

  let perChunkVerdicts;
  try {
    perChunkVerdicts = await mapWithConcurrency(chunks, MAX_CONCURRENT_CHUNKS, async (chunk, i) => {
      const verdicts = await scoreChunk(
        chunk.map((clause) => clause.text),
        {
          apiKey,
          documentType,
          source,
          onUsage: (usage) => {
            if (usage && usage.model) modelSeen = usage.model;
            console.log(
              `${LOG_PREFIX} SCAN_REQUEST ${requestId}: chunk ${i + 1}/${chunks.length} scored ` +
                `(model=${usage && usage.model}, in=${usage && usage.inputTokens}tok, ` +
                `out=${usage && usage.outputTokens}tok).`,
            );
          },
        },
      );
      // reattachVerdicts is index-aligned with `chunk`, so `chunk[j]` below
      // is the same clause that produced verdicts[j] — safe to pull its
      // `spans` straight across for the content script to turn into Ranges.
      return reattachVerdicts(chunk, verdicts).map((verdict, j) => ({
        ...verdict,
        spans: chunk[j].spans,
      }));
    });
  } catch (err) {
    const errorCode = mapScoreChunkErrorCode(err);
    console.log(
      `${LOG_PREFIX} SCAN_REQUEST ${requestId}: scoring failed, mapped to ${errorCode}: ${err && err.message}`,
    );
    return {
      type: 'SCAN_RESULT',
      requestId,
      ok: false,
      errorCode,
      message: (err && err.message) || 'Scan failed.',
    };
  }

  const verdicts = perChunkVerdicts.flat();
  const flagged = verdicts.filter((v) => v.flagged);
  const pageScore = rollupScore(
    flagged.map((v) => ({ probability: v.probability, category: v.category })),
    clauses.length,
  );

  console.log(
    `${LOG_PREFIX} SCAN_REQUEST ${requestId}: done. pageScore=${pageScore}, ` +
      `flagged=${flagged.length}/${clauses.length}, model=${modelSeen}.`,
  );

  return {
    type: 'SCAN_RESULT',
    requestId,
    ok: true,
    pageScore,
    model: modelSeen || 'unknown',
    clauseCount: clauses.length,
    flaggedCount: flagged.length,
    verdicts,
  };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
//
// chrome.runtime.onMessage handlers here are all async internally, but the
// MV3 contract for that is specific: returning a Promise from the listener
// does NOT keep the message channel open. The listener must synchronously
// `return true`, then call `sendResponse` later once the async work
// finishes. Every branch below does exactly that, and every async handler
// call is chained with `.catch(...)` so a thrown/rejected error still
// reaches `sendResponse` — otherwise the caller (content script or popup)
// waits on a promise that never resolves.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return false; // Not a message this worker understands; let others handle it.
  }

  console.log(`${LOG_PREFIX} received "${message.type}"${message.requestId ? ` (requestId=${message.requestId})` : ''}`);

  switch (message.type) {
    case 'GET_KEY_STATUS':
      handleGetKeyStatus()
        .then(sendResponse)
        .catch((err) => {
          console.log(`${LOG_PREFIX} GET_KEY_STATUS: unexpected error: ${err && err.message}`);
          sendResponse({ type: 'KEY_STATUS', hasKey: false });
        });
      return true;

    case 'SET_API_KEY':
      handleSetApiKey(message)
        .then(sendResponse)
        .catch((err) => {
          console.log(`${LOG_PREFIX} SET_API_KEY: unexpected error: ${err && err.message}`);
          sendResponse({ type: 'SET_API_KEY_RESULT', ok: false, errorCode: 'UNKNOWN' });
        });
      return true;

    case 'TRIGGER_SCAN':
      handleTriggerScan()
        .then(sendResponse)
        .catch((err) => {
          console.log(`${LOG_PREFIX} TRIGGER_SCAN: unexpected error: ${err && err.message}`);
          sendResponse({
            type: 'TRIGGER_SCAN_RESULT',
            ok: false,
            errorCode: 'UNKNOWN',
            message: 'Unexpected error starting the scan.',
          });
        });
      return true;

    case 'SCAN_REQUEST':
      handleScanRequest(message)
        .then(sendResponse)
        .catch((err) => {
          console.log(`${LOG_PREFIX} SCAN_REQUEST: unexpected error: ${err && err.message}`);
          sendResponse({
            type: 'SCAN_RESULT',
            requestId: message.requestId,
            ok: false,
            errorCode: 'UNKNOWN',
            message: 'Unexpected background error during scan.',
          });
        });
      return true;

    default:
      return false;
  }
});

// Defense in depth: if an async handler somehow still throws outside the
// per-branch .catch above (e.g. a bug in a future edit), log it loudly with
// the [FPF] prefix instead of letting Chrome swallow it silently — this
// worker has no UI, so its console is the only diagnostic surface (per the
// task brief).
self.addEventListener('unhandledrejection', (event) => {
  console.log(`${LOG_PREFIX} UNHANDLED REJECTION in service worker:`, event.reason && event.reason.message);
});

console.log(`${LOG_PREFIX} background service worker started.`);
