// The ONLY place Jev is called. Key handling and request-building must not
// leak outside this module (spec §2) — the caller resolves the API key and
// passes it in; this file never reads it from any host environment's
// storage or configuration on its own. Plain ESM, zero runtime deps, runs
// identically in Node and an MV3 service worker.

import { buildQuestions } from './questions.js';
import { decideVerdict } from './verdict.js';

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODELS_ENDPOINT = 'https://api.typesafe.ai/v1/models';
const DEFAULT_MODEL = 'jev-1.13.0';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 300;

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff: 300ms, 600ms, 1200ms, ... */
function backoffDelay(attempt, base = DEFAULT_BACKOFF_BASE_MS) {
  return base * 2 ** (attempt - 1);
}

/** `retry-after` is seconds per HTTP spec; returns ms, or null if unusable. */
function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

function getHeader(res, name) {
  // Support both the real fetch Headers object and plain-object test doubles.
  if (res.headers && typeof res.headers.get === 'function') {
    return res.headers.get(name);
  }
  if (res.headers && typeof res.headers === 'object') {
    return res.headers[name] ?? res.headers[name.toLowerCase()] ?? null;
  }
  return null;
}

async function postWithRetry({ fetchImpl, endpoint, apiKey, body, maxAttempts, sleepImpl, backoffBaseMs }) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw makeError('NETWORK', `scoreChunk: network error calling Jev: ${err.message}`);
    }

    if (res.status === 401) {
      throw makeError('UNAUTHORIZED', 'scoreChunk: Jev rejected the API key (401)');
    }

    if (res.status === 429 || res.status === 529) {
      if (attempt >= maxAttempts) {
        throw makeError('RATE_LIMITED', `scoreChunk: Jev rate-limited after ${attempt} attempts`);
      }
      const retryAfterMs = parseRetryAfterMs(getHeader(res, 'retry-after'));
      const delay = retryAfterMs ?? backoffDelay(attempt, backoffBaseMs);
      await sleepImpl(delay);
      continue;
    }

    if (!res.ok) {
      throw makeError('NETWORK', `scoreChunk: Jev returned HTTP ${res.status}`);
    }

    return res;
  }
}

async function parseJsonBody(res, code) {
  let data;
  try {
    data = await res.json();
  } catch {
    throw makeError(code, 'scoreChunk: Jev response body was not valid JSON');
  }
  if (!data || typeof data !== 'object') {
    throw makeError(code, 'scoreChunk: Jev response body was not a JSON object');
  }
  return data;
}

/**
 * @param {string[]} clauses
 * @param {Object} meta
 * @param {string} meta.apiKey          resolved by the CALLER, never read here
 * @param {string} meta.documentType
 * @param {string} meta.source
 * @param {string} [meta.model='jev-1.13.0']
 * @param {string} [meta.endpoint='https://api.typesafe.ai/v1/systemone']
 * @param {typeof fetch} [meta.fetchImpl]   injectable for tests
 * @param {(u:{inputTokens,outputTokens,model}) => void} [meta.onUsage]
 * @param {number} [meta.maxAttempts=3]     bounded retry attempts for 429/529
 * @param {(ms:number) => Promise<void>} [meta.sleepImpl]  injectable backoff sleep, for tests
 * @param {number} [meta.backoffBaseMs=300]
 * @returns {Promise<import('./verdict.js').Verdict[]>}   index-aligned with `clauses`
 */
export async function scoreChunk(clauses, meta) {
  const {
    apiKey,
    documentType,
    source,
    model = DEFAULT_MODEL,
    endpoint = DEFAULT_ENDPOINT,
    fetchImpl = fetch,
    onUsage,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    sleepImpl = defaultSleep,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  } = meta;

  const body = {
    model,
    state: {
      document_type: documentType,
      source,
      clauses,
    },
    questions: buildQuestions(clauses),
  };

  const res = await postWithRetry({
    fetchImpl,
    endpoint,
    apiKey,
    body,
    maxAttempts,
    sleepImpl,
    backoffBaseMs,
  });

  const data = await parseJsonBody(res, 'INVALID_RESPONSE');

  if (!data.answers || typeof data.answers !== 'object') {
    throw makeError('INVALID_RESPONSE', 'scoreChunk: Jev response missing "answers"');
  }

  const verdicts = clauses.map((_clauseText, i) => {
    const harm = data.answers[`harm_${i}`];
    const cat = data.answers[`cat_${i}`];
    if (!harm || typeof harm.noul !== 'number') {
      throw makeError('INVALID_RESPONSE', `scoreChunk: missing/invalid "harm_${i}" answer`);
    }
    if (!cat || typeof cat.choice !== 'string' || typeof cat.confidence !== 'number') {
      throw makeError('INVALID_RESPONSE', `scoreChunk: missing/invalid "cat_${i}" answer`);
    }
    return decideVerdict(harm.noul, cat);
  });

  if (typeof onUsage === 'function' && data.usage) {
    onUsage({
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
      model: data.model,
    });
  }

  return verdicts;
}

/**
 * Validate an API key via GET /v1/models. Lives here deliberately so the
 * popup never builds its own authenticated request — the key must not leak
 * outside this module.
 * @param {string} apiKey
 * @param {{endpoint?:string, fetchImpl?:typeof fetch}} [opts]
 * @returns {Promise<{ok:boolean, errorCode?:string}>}
 */
export async function validateApiKey(apiKey, { endpoint = DEFAULT_MODELS_ENDPOINT, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
  } catch {
    return { ok: false, errorCode: 'NETWORK' };
  }

  if (res.status === 401) {
    return { ok: false, errorCode: 'UNAUTHORIZED' };
  }
  if (res.status === 429 || res.status === 529) {
    return { ok: false, errorCode: 'RATE_LIMITED' };
  }
  if (!res.ok) {
    return { ok: false, errorCode: 'NETWORK' };
  }
  return { ok: true };
}
