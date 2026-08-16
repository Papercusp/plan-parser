/**
 * parser.property.test.ts — property-based coverage for parsePlan and
 * maskFences (Plan 1 P-028, P-029).
 *
 * Properties verified:
 *   maskFences:
 *     - Idempotent: masking twice is the same as masking once
 *     - Length-preserving: output is same length as input
 *     - Fence-free: output contains no triple-backtick sequences
 *
 *   parsePlan:
 *     - Never throws: any string input → a ParsedPlan (no exception)
 *     - Item ids match the P-NNN pattern when present
 *     - Item statuses are always within ITEM_STATUSES
 *     - Item importance is always within IMPORTANCE_LEVELS
 *     - items + decisions counts are always non-negative
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  maskFences,
  parsePlan,
  ITEM_STATUSES,
  IMPORTANCE_LEVELS,
} from './index';

// ─── maskFences ───────────────────────────────────────────────────────────────

describe('maskFences — properties', () => {
  it('idempotent: masking twice is the same as masking once', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (text) => {
        const once = maskFences(text);
        const twice = maskFences(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 200 },
    );
  });

  it('length-preserving: output has the same length as input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (text) => {
        expect(maskFences(text)).toHaveLength(text.length);
      }),
      { numRuns: 200 },
    );
  });

  it('fence-free: output contains no ``` sequences', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (text) => {
        expect(maskFences(text)).not.toContain('```');
      }),
      { numRuns: 200 },
    );
  });

  it('non-fence content is unchanged (no backticks in input → identity)', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[^`]*$/), (text) => {
        expect(maskFences(text)).toBe(text);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── parsePlan — invariants ───────────────────────────────────────────────────

describe('parsePlan — properties', () => {
  it('never throws on arbitrary string input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1000 }), (source) => {
        expect(() => parsePlan(source)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it('item ids always match P-NNN (or are absent/undefined)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1000 }), (source) => {
        const plan = parsePlan(source);
        for (const item of plan.items) {
          if (item.id) {
            expect(/^P-\d+$/.test(item.id)).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('item storedStatus is always in ITEM_STATUSES', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1000 }), (source) => {
        const plan = parsePlan(source);
        for (const item of plan.items) {
          expect((ITEM_STATUSES as readonly string[]).includes(item.storedStatus)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('item importance is always in IMPORTANCE_LEVELS', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1000 }), (source) => {
        const plan = parsePlan(source);
        for (const item of plan.items) {
          expect((IMPORTANCE_LEVELS as readonly string[]).includes(item.importance)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('items and decisions counts are non-negative', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1000 }), (source) => {
        const plan = parsePlan(source);
        expect(plan.items.length).toBeGreaterThanOrEqual(0);
        expect(plan.decisions.length).toBeGreaterThanOrEqual(0);
        expect(plan.parseWarnings.length).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });

  it('a well-formed plan always produces isLegacy=false', () => {
    const WELL_FORMED = `---
title: Test Plan
slug: test-2026-05-31
status: active
---

# Test Plan

## Now

**State:** doing something.

**Next:** finish it.

## Phase 1

- **P-001** \`todo\` do the thing
`;
    fc.assert(
      fc.property(
        fc.constantFrom(WELL_FORMED),
        fc.string({ maxLength: 100 }).filter((s) => !s.includes('---')),
        (base, extra) => {
          const plan = parsePlan(base + extra);
          // Adding text after the items doesn't make it legacy.
          expect(plan.isLegacy).toBe(false);
        },
      ),
      { numRuns: 20 },
    );
  });
});
