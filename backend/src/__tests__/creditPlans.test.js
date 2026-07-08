import { describe, it, expect } from 'vitest';
import { resolveTopicBackfillCost, CREDIT_COSTS } from '../lib/creditPlans';

describe('resolveTopicBackfillCost', () => {
  it('charges nothing for an empty backlog', () => {
    expect(resolveTopicBackfillCost(0)).toBe(0);
    expect(resolveTopicBackfillCost(-5)).toBe(0);
    expect(resolveTopicBackfillCost(NaN)).toBe(0);
  });

  it('tier 1 (<=500) uses CREDIT_COSTS.topic_backfill', () => {
    expect(resolveTopicBackfillCost(1)).toBe(CREDIT_COSTS.topic_backfill);
    expect(resolveTopicBackfillCost(500)).toBe(CREDIT_COSTS.topic_backfill);
  });

  it('tier 2 (501-5,000) is a flat 40', () => {
    expect(resolveTopicBackfillCost(501)).toBe(40);
    expect(resolveTopicBackfillCost(5000)).toBe(40);
  });

  it('tier 3 (5,001-50,000) is a flat 200', () => {
    expect(resolveTopicBackfillCost(5001)).toBe(200);
    expect(resolveTopicBackfillCost(50_000)).toBe(200);
  });

  it('above tier 3, cost climbs linearly instead of flattening out', () => {
    // Deliberately different from resolveCustomCost's flat top tier — Catch
    // Up Tagging processes every response with no sampling, so cost is
    // genuinely unbounded and must keep tracking volume above tier 3, or the
    // exact margin-risk bug this pricing model exists to fix would return
    // for very large backlogs.
    expect(resolveTopicBackfillCost(50_001)).toBe(205); // +1 into the next 1k bucket
    expect(resolveTopicBackfillCost(51_000)).toBe(205);
    expect(resolveTopicBackfillCost(52_000)).toBe(210);
    expect(resolveTopicBackfillCost(100_000)).toBe(450);
  });

  it('caps at the same 500-credit platform ceiling resolveCustomCost uses', () => {
    expect(resolveTopicBackfillCost(1_000_000)).toBe(500);
    expect(resolveTopicBackfillCost(10_000_000)).toBe(500);
  });

  it('cost is monotonically non-decreasing as backlog size grows', () => {
    const sizes = [0, 1, 500, 501, 5000, 5001, 50_000, 50_001, 100_000, 1_000_000];
    let prev = -1;
    for (const n of sizes) {
      const cost = resolveTopicBackfillCost(n);
      expect(cost).toBeGreaterThanOrEqual(prev);
      prev = cost;
    }
  });

  it('a small backlog costs LESS than the old flat rate of 20 credits', () => {
    // The pricing fix must not make small, common jobs more expensive than
    // before — only large ones should now cost more.
    expect(resolveTopicBackfillCost(20)).toBeLessThan(20);
  });
});
