import { describe, expect, it } from 'vitest';
import { IdleBackoff } from './idle-backoff.js';

describe('IdleBackoff', () => {
  it('doubles the jitter ceiling from 200ms per miss (deterministic with an injected random)', () => {
    const backoff = new IdleBackoff(() => 0.5);
    const draws = [1, 2, 3, 4, 5].map(() => backoff.nextDelayMs());
    expect(draws).toEqual([100, 200, 400, 800, 1600]);
  });

  it('caps the ceiling at 5s no matter how long the queue stays idle', () => {
    const backoff = new IdleBackoff(() => 0.5);
    for (let i = 0; i < 20; i += 1) backoff.nextDelayMs();
    expect(backoff.nextDelayMs()).toBe(2500); // 0.5 of the 5000ms cap
  });

  it('reset restores the base ceiling', () => {
    const backoff = new IdleBackoff(() => 0.5);
    for (let i = 0; i < 6; i += 1) backoff.nextDelayMs();
    backoff.reset();
    expect(backoff.nextDelayMs()).toBe(100);
  });

  it('is full jitter: the whole range down to zero is drawable, and draws stay under the ceiling', () => {
    expect(new IdleBackoff(() => 0).nextDelayMs()).toBe(0);
    const nearOne = new IdleBackoff(() => 0.999_999);
    expect(nearOne.nextDelayMs()).toBeLessThan(200);
  });

  it('defaults to Math.random and stays within [0, 200) on the first draw', () => {
    const draw = new IdleBackoff().nextDelayMs();
    expect(draw).toBeGreaterThanOrEqual(0);
    expect(draw).toBeLessThan(200);
  });
});
