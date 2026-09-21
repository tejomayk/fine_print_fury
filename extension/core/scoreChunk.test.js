import { describe, it, expect, vi, beforeEach } from 'vitest';

// extension/core/questions.js is owned by another agent working in parallel. Mock it
// so this suite never depends on its real content — we only need a stable
// shape: buildQuestions(clauseTexts) -> { harm_0, cat_0, harm_1, cat_1, ... }.
vi.mock('./questions.js', () => ({
  QUESTION_VERSION: 'test-version',
  buildQuestions: vi.fn((clauseTexts) => {
    const out = {};
    clauseTexts.forEach((_text, i) => {
      out[`harm_${i}`] = { type: 'noul', instructions: `harm ${i}`, criteria: {} };
      out[`cat_${i}`] = { type: 'choice', instructions: `cat ${i}`, criteria: {} };
    });
    return out;
  }),
}));

import { scoreChunk, validateApiKey } from './scoreChunk.js';

function makeResponse(status, jsonBody, headers = {}) {
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => jsonBody,
    headers: {
      get: (name) => lowerHeaders[name.toLowerCase()] ?? null,
    },
  };
}

const instantSleep = async () => {};

const baseMeta = () => ({
  apiKey: 'test-key',
  documentType: 'Terms of Service',
  source: 'example.com',
  sleepImpl: instantSleep,
});

describe('scoreChunk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a request body with harm_i and cat_i for every clause', async () => {
    const clauses = ['clause zero', 'clause one', 'clause two'];
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, {
        model: 'jev-1.13.0',
        answers: {
          harm_0: { type: 'noul', noul: 0.1 },
          cat_0: { type: 'choice', choice: 'benign', probabilities: {}, confidence: 0.9 },
          harm_1: { type: 'noul', noul: 0.1 },
          cat_1: { type: 'choice', choice: 'benign', probabilities: {}, confidence: 0.9 },
          harm_2: { type: 'noul', noul: 0.1 },
          cat_2: { type: 'choice', choice: 'benign', probabilities: {}, confidence: 0.9 },
        },
        usage: { input_tokens: 100, output_tokens: 20 },
      })
    );

    await scoreChunk(clauses, { ...baseMeta(), fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(init.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('jev-1.13.0');
    expect(body.state).toEqual({
      document_type: 'Terms of Service',
      source: 'example.com',
      clauses,
    });
    for (let i = 0; i < clauses.length; i++) {
      expect(body.questions).toHaveProperty(`harm_${i}`);
      expect(body.questions).toHaveProperty(`cat_${i}`);
    }
  });

  it('returns verdicts index-aligned with the input clauses', async () => {
    const clauses = ['low harm clause', 'high harm clause'];
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, {
        model: 'jev-1.13.0',
        answers: {
          harm_0: { type: 'noul', noul: 0.1 },
          cat_0: { type: 'choice', choice: 'benign', probabilities: {}, confidence: 0.9 },
          harm_1: { type: 'noul', noul: 0.95 },
          cat_1: { type: 'choice', choice: 'forced_arbitration', probabilities: {}, confidence: 0.9 },
        },
        usage: { input_tokens: 100, output_tokens: 20 },
      })
    );

    const verdicts = await scoreChunk(clauses, { ...baseMeta(), fetchImpl });

    expect(verdicts).toHaveLength(2);
    expect(verdicts[0].flagged).toBe(false);
    expect(verdicts[1].flagged).toBe(true);
    expect(verdicts[1].category).toBe('forced_arbitration');
    expect(verdicts[1].severity).toBe('high');
  });

  it('throws an UNAUTHORIZED error on a 401 without retrying', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(401, {}));

    const err = await scoreChunk(['a clause'], { ...baseMeta(), fetchImpl }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and eventually throws RATE_LIMITED, bounded to a small number of attempts', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(429, {}, { 'retry-after': '0' }));

    const err = await scoreChunk(['a clause'], { ...baseMeta(), fetchImpl }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('RATE_LIMITED');
    // Bounded retries: default max attempts is 3, not unbounded.
    expect(fetchImpl.mock.calls.length).toBe(3);
  });

  it('honors retry-after and recovers if a later attempt succeeds', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call < 3) return makeResponse(529, {}, { 'retry-after': '0' });
      return makeResponse(200, {
        model: 'jev-1.13.0',
        answers: {
          harm_0: { type: 'noul', noul: 0.7 },
          cat_0: { type: 'choice', choice: 'no_refunds', probabilities: {}, confidence: 0.9 },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    });

    const verdicts = await scoreChunk(['a clause'], { ...baseMeta(), fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(verdicts[0].flagged).toBe(true);
    expect(verdicts[0].category).toBe('no_refunds');
  });

  it('throws INVALID_RESPONSE when a 200 body is missing expected answer keys', async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, {
        model: 'jev-1.13.0',
        answers: {
          // harm_0 missing entirely
          cat_0: { type: 'choice', choice: 'benign', probabilities: {}, confidence: 0.9 },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    );

    const err = await scoreChunk(['a clause'], { ...baseMeta(), fetchImpl }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('INVALID_RESPONSE');
  });

  it('throws INVALID_RESPONSE when the "answers" object itself is missing', async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, { model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 1 } })
    );

    const err = await scoreChunk(['a clause'], { ...baseMeta(), fetchImpl }).catch((e) => e);

    expect(err.code).toBe('INVALID_RESPONSE');
  });

  it('throws a NETWORK error when fetch itself throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    const err = await scoreChunk(['a clause'], { ...baseMeta(), fetchImpl }).catch((e) => e);

    expect(err.code).toBe('NETWORK');
  });

  it('calls onUsage with the usage block and the returned model id', async () => {
    const onUsage = vi.fn();
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, {
        model: 'jev-1.13.0',
        answers: {
          harm_0: { type: 'noul', noul: 0.1 },
          cat_0: { type: 'choice', choice: 'benign', probabilities: {}, confidence: 0.9 },
        },
        usage: { input_tokens: 123, output_tokens: 45 },
      })
    );

    await scoreChunk(['a clause'], { ...baseMeta(), fetchImpl, onUsage });

    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 123,
      outputTokens: 45,
      model: 'jev-1.13.0',
    });
  });
});

describe('validateApiKey', () => {
  it('returns {ok:true} on a 200 response', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(200, { data: [] }));
    const result = await validateApiKey('some-key', { fetchImpl });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/models');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer some-key');
  });

  it('returns {ok:false, errorCode:"UNAUTHORIZED"} on a 401 response', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(401, {}));
    const result = await validateApiKey('bad-key', { fetchImpl });
    expect(result).toEqual({ ok: false, errorCode: 'UNAUTHORIZED' });
  });

  it('returns {ok:false, errorCode:"NETWORK"} when fetch throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('offline');
    });
    const result = await validateApiKey('some-key', { fetchImpl });
    expect(result).toEqual({ ok: false, errorCode: 'NETWORK' });
  });
});
