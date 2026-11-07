import { describe, expect, it } from 'vitest';
import {
  breakEvenTurns,
  COST_DEFAULTS,
  estimateCost,
  formatCostReport,
  usd,
  type CostInput,
} from '../src/index.js';

function input(extra: Partial<CostInput> = {}): CostInput {
  return {
    ...COST_DEFAULTS,
    jevCostUsd: 0,
    minSavingUsd: 0,
    contextTokens: 100_000,
    keepRatio: 0.3,
    cacheCold: false,
    minReductionRatio: 0.25,
    ...extra,
  };
}

describe('cost model', () => {
  it('prices the two options turn by turn', () => {
    // 100k tokens at $3/1M: a cache read costs $0.03, a cache write $0.375.
    const estimate = estimateCost(input({ expectedTurns: 10 }));
    expect(estimate.keepUsd).toBeCloseTo(10 * 0.03, 10);
    expect(estimate.writeUsd).toBeCloseTo(1.25 * 0.3 * 0.3, 10);
    expect(estimate.readUsd).toBeCloseTo(9 * 0.1 * 0.3 * 0.3, 10);
    expect(estimate.pruneUsd).toBeCloseTo(estimate.writeUsd + estimate.readUsd, 10);
    expect(estimate.savingUsd).toBeCloseTo(estimate.keepUsd - estimate.pruneUsd, 10);
  });

  it('finds the break-even turn count and agrees with the two totals', () => {
    const even = breakEvenTurns(input())!;
    expect(even).toBe(5);
    expect(estimateCost(input({ expectedTurns: even })).savingUsd).toBeGreaterThan(0);
    expect(estimateCost(input({ expectedTurns: even - 1 })).savingUsd).toBeLessThan(0);
  });

  it('does not depend on the size of the context when Jev is free', () => {
    expect(breakEvenTurns(input({ contextTokens: 20_000 }))).toBe(breakEvenTurns(input({ contextTokens: 400_000 })));
  });

  it('raises the break-even when Jev costs money or the prune keeps more', () => {
    expect(breakEvenTurns(input({ jevCostUsd: 0.1 }))!).toBeGreaterThan(breakEvenTurns(input())!);
    expect(breakEvenTurns(input({ keepRatio: 0.7 }))!).toBeGreaterThan(breakEvenTurns(input())!);
    expect(breakEvenTurns(input({ keepRatio: 1 }))).toBeNull();
  });

  it('pays back at once when the cache already expired', () => {
    expect(breakEvenTurns(input({ cacheCold: true }))).toBe(1);
    const estimate = estimateCost(input({ cacheCold: true, expectedTurns: 1 }));
    expect(estimate.verdict).toBe('compact');
    expect(estimate.keepUsd).toBeCloseTo(1.25 * 0.3, 10);
  });

  it('keeps the context when too few turns remain', () => {
    const estimate = estimateCost(input({ expectedTurns: 2 }));
    expect(estimate.verdict).toBe('keep');
    expect(estimate.reason).toContain('costs more');
  });

  it('keeps the context when the prune removes less than the minimum', () => {
    const estimate = estimateCost(input({ keepRatio: 0.9, expectedTurns: 1000 }));
    expect(estimate.verdict).toBe('keep');
    expect(estimate.reason).toContain('minimum is 25%');
  });

  it('keeps the context when the saving is below the minimum saving', () => {
    const estimate = estimateCost(input({ contextTokens: 20_000, minSavingUsd: 0.5 }));
    expect(estimate.savingUsd).toBeGreaterThan(0);
    expect(estimate.verdict).toBe('keep');
    expect(estimate.reason).toContain('below the minimum');
  });

  it('formats amounts and the report', () => {
    expect(usd(0.0123)).toBe('$0.0123');
    expect(usd(1.5)).toBe('$1.50');
    expect(usd(-0.02)).toBe('-$0.0200');
    const filled = input();
    const lines = formatCostReport(filled, estimateCost(filled), { keepRatioSource: 'assumed', idleMinutes: 7 });
    expect(lines.join('\n')).toContain('Cache: warm');
    expect(lines.at(-1)).toMatch(/^Verdict: (COMPACT|DO NOT COMPACT)\./);
  });
});
