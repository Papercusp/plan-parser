/**
 * content-hash.property.test.ts — property-based coverage for hashPlanContent
 * (Plan 1 P-028, P-029).
 *
 * hashPlanContent backs the compare-and-swap in plans:set-content (D-011).
 * Both reader and writer use the SAME function — if either side uses a
 * different implementation, every save looks stale. Properties:
 *   - Deterministic: same input → same output (no Date, no Math.random)
 *   - Idempotent: hashing the same string twice gives identical results
 *   - Distinct: different strings → different hashes (collision resistance)
 *   - Fixed length: sha256 hex = always 64 chars
 *   - Sensitive: a 1-char change produces a different hash
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { hashPlanContent } from './content-hash';

describe('hashPlanContent (property-based)', () => {
  it('deterministic — same input always gives the same hash', () => {
    fc.assert(
      fc.property(fc.string(), (content) => {
        expect(hashPlanContent(content)).toBe(hashPlanContent(content));
      }),
    );
  });

  it('idempotent — hashing the output of hashPlanContent is a no-op (hash ≠ hash of hash)', () => {
    // More precisely: calling it twice with the same input is stable.
    fc.assert(
      fc.property(fc.string(), (content) => {
        const h1 = hashPlanContent(content);
        const h2 = hashPlanContent(content);
        expect(h1).toBe(h2);
      }),
    );
  });

  it('always returns a 64-character hex string', () => {
    fc.assert(
      fc.property(fc.string(), (content) => {
        const h = hashPlanContent(content);
        expect(h).toHaveLength(64);
        expect(/^[0-9a-f]{64}$/.test(h)).toBe(true);
      }),
    );
  });

  it('distinct — different content gives different hashes', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        fc.pre(a !== b);
        expect(hashPlanContent(a)).not.toBe(hashPlanContent(b));
      }),
      { numRuns: 200 },
    );
  });

  it('sensitive — a single appended character changes the hash', () => {
    const charArb = fc.constantFrom(
      'a', 'b', 'z', '0', '9', ' ', '\n', '\t', '!', '_', '-', '.', '/', '\\',
    );
    fc.assert(
      fc.property(fc.string(), charArb, (content, c) => {
        expect(hashPlanContent(content)).not.toBe(hashPlanContent(content + c));
      }),
    );
  });

  it('empty string has a stable known hash', () => {
    // sha256('') = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(hashPlanContent('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb924' +
      '27ae41e4649b934ca495991b7852b855',
    );
  });

  it('whitespace differences produce different hashes', () => {
    expect(hashPlanContent('a b')).not.toBe(hashPlanContent('a  b'));
    expect(hashPlanContent('a\nb')).not.toBe(hashPlanContent('a\n\nb'));
    expect(hashPlanContent('a')).not.toBe(hashPlanContent('a '));
  });
});
