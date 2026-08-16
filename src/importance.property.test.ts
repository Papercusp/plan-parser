/**
 * Property + example coverage for the `importance:` item keyword
 * (planning-attention-importance-2026-05-31, P-002).
 *
 * Invariants under test:
 *   - a valid level round-trips and is stripped from the visible text
 *   - the separator/spacing/case is irrelevant (glyph-agnostic, like blocked-by)
 *   - a missing keyword defaults to `normal`
 *   - an UNKNOWN value degrades to `normal` AND adds no parseWarning —
 *     parseWarnings become lint *errors* (lint.ts:149), so a typo must
 *     never fail CI; plans:lint surfaces it as a soft warning instead
 *   - importance coexists with blocked-by / decision refs regardless of order
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parsePlan, IMPORTANCE_LEVELS, type Importance, type PlanItem } from './index';

function wrap(itemLine: string): string {
  return [
    '---',
    'title: T',
    'slug: t-2026-05-31',
    'status: active',
    '---',
    '',
    '# T',
    '',
    '## Now',
    '',
    '**State:** s',
    '',
    '**Next:** n',
    '',
    '## Phase 1',
    '',
    itemLine,
    '',
  ].join('\n');
}

function parseItemWithPlan(itemLine: string): {
  item: PlanItem;
  warnings: string[];
} {
  const plan = parsePlan(wrap(itemLine), { filePath: 't-2026-05-31.md' });
  return { item: plan.items[0]!, warnings: plan.parseWarnings };
}

function parseItem(itemLine: string): PlanItem {
  return parseItemWithPlan(itemLine).item;
}

// Words that never collide with the keywords/tokens the parser strips.
const wordArb = fc.constantFrom('alpha', 'beta', 'gamma', 'build', 'the', 'wire', 'step', 'thing');
const textArb = fc.array(wordArb, { minLength: 1, maxLength: 6 }).map((a) => a.join(' '));
const levelArb = fc.constantFrom<Importance>(...IMPORTANCE_LEVELS);
// Separators that all mean the same `importance:` keyword.
const sepArb = fc.constantFrom(
  'importance: ',
  'importance:',
  'importance :  ',
  'IMPORTANCE: ',
  'Importance:  ',
);
const letter = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split(''));
const badTokenArb = fc
  .array(letter, { minLength: 2, maxLength: 9 })
  .map((a) => a.join(''))
  .filter((s) => !(IMPORTANCE_LEVELS as readonly string[]).includes(s));

describe('importance keyword — properties', () => {
  it('a valid level round-trips and is stripped from the visible text', () => {
    fc.assert(
      fc.property(levelArb, textArb, sepArb, (level, text, sep) => {
        const item = parseItem(`- **P-001** \`todo\` ${text} ${sep}${level}`);
        expect(item.importance).toBe(level);
        expect(item.text).toBe(text);
        expect(item.text).not.toMatch(/importance/i);
      }),
    );
  });

  it('a missing keyword defaults to normal', () => {
    fc.assert(
      fc.property(textArb, (text) => {
        const item = parseItem(`- **P-001** \`todo\` ${text}`);
        expect(item.importance).toBe('normal');
      }),
    );
  });

  it('an unknown value degrades to normal with NO parseWarning (must not fail lint)', () => {
    fc.assert(
      fc.property(badTokenArb, textArb, (bad, text) => {
        const { item, warnings } = parseItemWithPlan(`- **P-001** \`todo\` ${text} importance: ${bad}`);
        expect(item.importance).toBe('normal');
        expect(item.text).toBe(text); // keyword still stripped
        expect(warnings).toEqual([]); // critical: no parseWarning ⇒ no lint error
      }),
    );
  });

  it('coexists with blocked-by and decision refs in any order', () => {
    fc.assert(
      fc.property(levelArb, fc.boolean(), (level, importanceFirst) => {
        const bb = 'blocked-by: P-002';
        const imp = `importance: ${level}`;
        const tail = importanceFirst ? `${imp} ${bb}` : `${bb} ${imp}`;
        const item = parseItem(`- **P-001** \`todo\` do the work ${tail} → D-003`);
        expect(item.importance).toBe(level);
        expect(item.blockedBy).toEqual(['P-002']);
        expect(item.decisionRefs).toEqual(['D-003']);
        expect(item.text).not.toMatch(/importance|blocked-by/i);
      }),
    );
  });
});

describe('importance keyword — examples', () => {
  it('importance:high with no space after the colon', () => {
    expect(parseItem('- **P-001** `todo` text importance:high').importance).toBe('high');
  });

  it('mixed case normalizes', () => {
    expect(parseItem('- **P-001** `needs-human` sign off Importance: URGENT').importance).toBe('urgent');
  });

  it('default is normal for a plain item', () => {
    expect(parseItem('- **P-001** `todo` just a task').importance).toBe('normal');
  });

  it('IMPORTANCE_LEVELS is ordered most→least for use as a sort rank', () => {
    expect(IMPORTANCE_LEVELS).toEqual(['urgent', 'high', 'normal', 'low']);
  });
});
