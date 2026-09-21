import { describe, it, expect } from 'vitest';
import { bandSeverity, decideVerdict } from './verdict.js';

describe('bandSeverity', () => {
  it('is null below 0.65', () => {
    expect(bandSeverity(0.649999)).toBeNull();
    expect(bandSeverity(0)).toBeNull();
  });

  it('is "low" exactly at 0.65', () => {
    expect(bandSeverity(0.65)).toBe('low');
  });

  it('is "low" up to just under 0.78', () => {
    expect(bandSeverity(0.77999)).toBe('low');
  });

  it('is "medium" exactly at 0.78', () => {
    expect(bandSeverity(0.78)).toBe('medium');
  });

  it('is "medium" up to and including 0.90', () => {
    expect(bandSeverity(0.90)).toBe('medium');
    expect(bandSeverity(0.89999)).toBe('medium');
  });

  it('is "high" strictly above 0.90', () => {
    expect(bandSeverity(0.900001)).toBe('high');
    expect(bandSeverity(1)).toBe('high');
  });
});

describe('decideVerdict', () => {
  const choice = (overrides = {}) => ({
    choice: 'forced_arbitration',
    probabilities: { forced_arbitration: 0.9 },
    confidence: 0.8,
    ...overrides,
  });

  it('does not flag and discards the category when noulP is below the flag threshold', () => {
    const result = decideVerdict(0.64999, choice());
    expect(result).toEqual({
      flagged: false,
      probability: 0.64999,
      category: null,
      categoryConfidence: null,
      severity: null,
    });
  });

  it('flags exactly at the default flag threshold (0.65)', () => {
    const result = decideVerdict(0.65, choice());
    expect(result.flagged).toBe(true);
    expect(result.severity).toBe('low');
  });

  it('flags exactly at a custom flag threshold too', () => {
    const result = decideVerdict(0.6, choice(), { flagThreshold: 0.6 });
    expect(result.flagged).toBe(true);
  });

  it('discards the category entirely when not flagged, even if the choice looks confident', () => {
    const result = decideVerdict(0.3, choice({ confidence: 0.99, choice: 'liability_dodge' }));
    expect(result.flagged).toBe(false);
    expect(result.category).toBeNull();
    expect(result.categoryConfidence).toBeNull();
  });

  it('uses the choice category when confidence is at or above the default threshold (0.4)', () => {
    const result = decideVerdict(0.9, choice({ confidence: 0.4, choice: 'no_refunds' }));
    expect(result.category).toBe('no_refunds');
    expect(result.categoryConfidence).toBe(0.4);
  });

  it('falls back to "unclear" when confidence is just below the default threshold (0.4)', () => {
    const result = decideVerdict(0.9, choice({ confidence: 0.39999, choice: 'no_refunds' }));
    expect(result.category).toBe('unclear');
  });

  it('respects a custom confidenceThreshold boundary', () => {
    const below = decideVerdict(0.9, choice({ confidence: 0.5 }), { confidenceThreshold: 0.5 });
    expect(below.category).toBe('forced_arbitration');
    const justBelow = decideVerdict(0.9, choice({ confidence: 0.49999 }), { confidenceThreshold: 0.5 });
    expect(justBelow.category).toBe('unclear');
  });

  it('bands severity exactly at 0.78 and 0.90 for a flagged clause', () => {
    expect(decideVerdict(0.78, choice()).severity).toBe('medium');
    expect(decideVerdict(0.90, choice()).severity).toBe('medium');
    expect(decideVerdict(0.900001, choice()).severity).toBe('high');
  });

  it('treats a confident "benign" choice on a flagged clause as "unclear", not "benign"', () => {
    const result = decideVerdict(0.91, choice({ choice: 'benign', confidence: 0.95 }));
    expect(result.flagged).toBe(true);
    expect(result.category).toBe('unclear');
    expect(result.category).not.toBe('benign');
    // The Noul is the absolute judgment — the highlight/severity survive
    // the disagreement.
    expect(result.severity).toBe('high');
  });

  it('treats a low-confidence "benign" choice on a flagged clause as "unclear" too', () => {
    const result = decideVerdict(0.7, choice({ choice: 'benign', confidence: 0.1 }));
    expect(result.flagged).toBe(true);
    expect(result.category).toBe('unclear');
  });

  it('carries the raw probability through on a flagged verdict', () => {
    const result = decideVerdict(0.777, choice());
    expect(result.probability).toBe(0.777);
  });
});
