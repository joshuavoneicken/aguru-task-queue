import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.js';

describe('cursor', () => {
  it('round-trips a position', () => {
    const c = { failedAt: '2026-09-12T10:00:00.000Z', id: '2fbd8f11-9a45-4b70-b1a1-30fcbf22d1af' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('returns null for garbage, truncation and shape-valid-but-wrong JSON', () => {
    expect(decodeCursor('not-base64url!!')).toBeNull();
    expect(decodeCursor(encodeCursor({ failedAt: new Date().toISOString(), id: '2fbd8f11-9a45-4b70-b1a1-30fcbf22d1af' }).slice(0, 5))).toBeNull();
    expect(decodeCursor(Buffer.from('{"a":1}').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('{"failedAt":"yesterday","id":"x"}').toString('base64url'))).toBeNull();
  });
});
