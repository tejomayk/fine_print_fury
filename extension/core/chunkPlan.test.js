import { describe, it, expect } from 'vitest';
import { planChunks, reattachVerdicts } from './chunkPlan.js';

describe('planChunks', () => {
  it('splits an exact multiple of the chunk size into even chunks', () => {
    const items = Array.from({ length: 80 }, (_, i) => i);
    const chunks = planChunks(items, 40);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(40);
    expect(chunks[1]).toHaveLength(40);
    expect(chunks[0][0]).toBe(0);
    expect(chunks[1][39]).toBe(79);
  });

  it('produces a smaller remainder chunk', () => {
    const items = Array.from({ length: 85 }, (_, i) => i);
    const chunks = planChunks(items, 40);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(40);
    expect(chunks[1]).toHaveLength(40);
    expect(chunks[2]).toHaveLength(5);
  });

  it('returns an empty array for empty input', () => {
    expect(planChunks([], 40)).toEqual([]);
  });

  it('returns a single chunk when size is larger than the input', () => {
    const items = [1, 2, 3];
    const chunks = planChunks(items, 40);
    expect(chunks).toEqual([[1, 2, 3]]);
  });

  it('defaults to a chunk size of 40', () => {
    const items = Array.from({ length: 41 }, (_, i) => i);
    const chunks = planChunks(items);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(40);
    expect(chunks[1]).toHaveLength(1);
  });

  it('never mutates the input array', () => {
    const items = [1, 2, 3, 4, 5];
    const copy = [...items];
    planChunks(items, 2);
    expect(items).toEqual(copy);
  });
});

describe('reattachVerdicts', () => {
  const clauses = [
    { id: 'c0', text: 'a' },
    { id: 'c1', text: 'b' },
    { id: 'c2', text: 'c' },
  ];
  const verdicts = [
    { flagged: false, probability: 0.1, category: null, categoryConfidence: null, severity: null },
    { flagged: true, probability: 0.9, category: 'no_refunds', categoryConfidence: 0.7, severity: 'high' },
    { flagged: false, probability: 0.2, category: null, categoryConfidence: null, severity: null },
  ];

  it('maps index-aligned verdicts onto clause ids', () => {
    const result = reattachVerdicts(clauses, verdicts);
    expect(result).toEqual([
      { ...verdicts[0], id: 'c0' },
      { ...verdicts[1], id: 'c1' },
      { ...verdicts[2], id: 'c2' },
    ]);
  });

  it('throws a clear error when there are fewer verdicts than clauses', () => {
    expect(() => reattachVerdicts(clauses, verdicts.slice(0, 2))).toThrow(/length mismatch/i);
  });

  it('throws a clear error when there are more verdicts than clauses', () => {
    expect(() => reattachVerdicts(clauses.slice(0, 2), verdicts)).toThrow(/length mismatch/i);
  });

  it('handles the empty case without throwing', () => {
    expect(reattachVerdicts([], [])).toEqual([]);
  });
});
