/**
 * verification-vocabulary.test.ts — the `deliverable:` item keyword
 * (plan-verification-profiles-2026-10-17 P-002, D-001).
 *
 * Pins: the parser reads a declared deliverable kind and strips it from the visible text; an
 * undeclared or unknown value is `null` (never a lint error); the renderer writes it back so
 * parse(render(parse(x))) keeps the declaration.
 */
import { describe, expect, it } from 'vitest';
import { parsePlan } from './parser';
import { renderPlanMarkdown } from './renderer';
import {
  DELIVERABLE_KINDS,
  VERIFICATION_PROFILES,
  isDeliverableKind,
  isVerificationProfile,
} from './verification-vocabulary';

const plan = (itemLines: string[]): string =>
  [
    '---',
    'slug: verification-vocab-fixture',
    'title: Verification vocabulary fixture',
    'status: active',
    'created: 2026-10-20',
    'updated: 2026-10-20',
    '---',
    '',
    '# Verification vocabulary fixture',
    '',
    '## Items',
    '',
    ...itemLines,
    '',
  ].join('\n');

describe('verification vocabulary (plan-verification-profiles P-002)', () => {
  it('names the two profiles and six deliverable kinds', () => {
    expect([...VERIFICATION_PROFILES]).toEqual(['coding', 'general']);
    expect([...DELIVERABLE_KINDS]).toEqual(['code', 'doc', 'decision', 'research', 'operation', 'artifact']);
    expect(isVerificationProfile('general')).toBe(true);
    expect(isVerificationProfile('generic')).toBe(false);
    expect(isDeliverableKind('doc')).toBe(true);
    expect(isDeliverableKind('docs')).toBe(false);
  });

  it('parses a declared deliverable kind and strips it from the item text', () => {
    const parsed = parsePlan(plan(['- **P-001** `todo` Write the runbook deliverable: doc importance: high']));
    const item = parsed.items[0]!;
    expect(item.deliverable).toBe('doc');
    expect(item.importance).toBe('high');
    expect(item.text).toBe('Write the runbook');
  });

  it('every kind round-trips, case-insensitively', () => {
    for (const kind of DELIVERABLE_KINDS) {
      const parsed = parsePlan(plan([`- **P-001** \`todo\` Do it Deliverable: ${kind.toUpperCase()}`]));
      expect(parsed.items[0]!.deliverable).toBe(kind);
    }
  });

  it('an undeclared item is null, and an unknown kind degrades to null without a parse warning', () => {
    const parsed = parsePlan(plan([
      '- **P-001** `todo` Plain item',
      '- **P-002** `todo` Typo item deliverable: docs',
    ]));
    expect(parsed.items[0]!.deliverable).toBeNull();
    expect(parsed.items[1]!.deliverable).toBeNull();
    expect(parsed.items[1]!.text).toBe('Typo item');
    expect(parsed.parseWarnings ?? []).toEqual([]);
  });

  it('the renderer writes the declaration back and leaves undeclared items unchanged', () => {
    const source = plan([
      '- **P-001** `todo` Decide the retention window deliverable: decision',
      '- **P-002** `todo` Ship the migration',
    ]);
    const first = parsePlan(source);
    const rendered = renderPlanMarkdown(first);
    expect(rendered).toContain('deliverable: decision');
    expect(rendered).not.toMatch(/Ship the migration[^\n]*deliverable:/);
    const second = parsePlan(rendered);
    expect(second.items.map((i) => [i.id, i.deliverable])).toEqual([
      ['P-001', 'decision'],
      ['P-002', null],
    ]);
  });
});
