/**
 * item-type-slug.test.ts — namespaced item-type and plan-type slugs in the plan format
 * (plan-item-types-registry-cupboard-2026-10-20 P-002, requirement R-4).
 *
 * Pins:
 *   - `deliverable:` accepts a well-formed namespaced slug verbatim and applies NO policy to it
 *     (the parser does not know or care whether the type exists);
 *   - the plan-level `type:` frontmatter key accepts a namespaced slug the same way;
 *   - both survive parse → render → parse (the plan-read path);
 *   - malformed slugs (uppercase namespace, empty segment, leading or trailing slash, more
 *     than one slash) are refused, degrading to undeclared without a parse warning.
 */
import { describe, expect, it } from 'vitest';
import { parsePlan } from './parser';
import { renderPlanMarkdown } from './renderer';
import {
  DELIVERABLE_KINDS,
  TYPE_SLUG_PATTERN,
  isDeliverableRef,
  isTypeSlug,
  normalizeDeliverableToken,
} from './verification-vocabulary';

const plan = (itemLines: string[], frontmatterExtra: string[] = []): string =>
  [
    '---',
    'slug: item-type-slug-fixture',
    'title: Item-type slug fixture',
    'status: active',
    ...frontmatterExtra,
    'created: 2026-10-21',
    'updated: 2026-10-21',
    '---',
    '',
    '# Item-type slug fixture',
    '',
    '## Items',
    '',
    ...itemLines,
    '',
  ].join('\n');

const MALFORMED = [
  'Acme/legal-review', // uppercase namespace
  'acme/Legal-review', // uppercase name
  'acme/', // empty name segment
  '/legal-review', // leading slash, empty namespace
  'acme/legal-review/', // trailing slash
  'acme//legal-review', // empty middle segment
  'acme/legal/review', // more than one slash
  '-acme/legal-review', // leading hyphen
  'acme/legal_review', // underscore is not in the grammar
];

describe('namespaced deliverable slugs (R-4)', () => {
  it('accepts a well-formed namespaced slug verbatim and strips it from the item text', () => {
    const parsed = parsePlan(plan(['- **P-001** `todo` Review the contract deliverable: acme/legal-review importance: high']));
    const item = parsed.items[0]!;
    expect(item.deliverable).toBe('acme/legal-review');
    expect(item.importance).toBe('high');
    expect(item.text).toBe('Review the contract');
    expect(parsed.parseWarnings ?? []).toEqual([]);
  });

  it('applies no policy: an unregistered namespace parses exactly like a first-party one', () => {
    for (const slug of ['papercusp/code', 'acme/legal-review', 'zz9/x', 'a/b-c-d']) {
      const parsed = parsePlan(plan([`- **P-001** \`todo\` Do it deliverable: ${slug}`]));
      expect(parsed.items[0]!.deliverable).toBe(slug);
    }
  });

  it('keeps every built-in kind, case-insensitively, so existing plans parse unchanged', () => {
    for (const kind of DELIVERABLE_KINDS) {
      const parsed = parsePlan(plan([`- **P-001** \`todo\` Do it deliverable: ${kind.toUpperCase()}.`]));
      expect(parsed.items[0]!.deliverable).toBe(kind);
    }
  });

  it('refuses each malformed slug (undeclared, no warning) and still strips the keyword', () => {
    for (const bad of MALFORMED) {
      const parsed = parsePlan(plan([`- **P-001** \`todo\` Do it deliverable: ${bad}`]));
      expect(parsed.items[0]!.deliverable, bad).toBeNull();
      expect(parsed.items[0]!.text, bad).toBe('Do it');
      expect(isTypeSlug(bad), bad).toBe(false);
      expect(normalizeDeliverableToken(bad), bad).toBeNull();
    }
  });

  it('a namespaced slug survives parse → render → parse', () => {
    const first = parsePlan(plan([
      '- **P-001** `todo` Review the contract deliverable: acme/legal-review',
      '- **P-002** `todo` Write the summary deliverable: doc blocked-by: P-001',
    ]));
    const rendered = renderPlanMarkdown(first);
    expect(rendered).toContain('deliverable: acme/legal-review');
    const second = parsePlan(rendered);
    expect(second.items.map((i) => [i.id, i.deliverable])).toEqual([
      ['P-001', 'acme/legal-review'],
      ['P-002', 'doc'],
    ]);
    expect(second.items[1]!.blockedBy).toEqual(['P-001']);
  });
});

describe('the plan-level type (R-4)', () => {
  it('accepts a namespaced plan-type slug', () => {
    const parsed = parsePlan(plan([], ['type: acme/legal-matter']));
    expect(parsed.frontmatter.type).toBe('acme/legal-matter');
    expect(parsed.isLegacy).toBe(false);
  });

  it('refuses a malformed plan type, leaving it only in raw', () => {
    for (const bad of [...MALFORMED, 'coding', 'feature']) {
      const parsed = parsePlan(plan([], [`type: ${bad}`]));
      expect(parsed.frontmatter.type, bad).toBeUndefined();
      expect(parsed.frontmatter.raw.type, bad).toBe(bad);
    }
  });

  it('survives parse → render → parse', () => {
    const first = parsePlan(plan(['- **P-001** `todo` Do it deliverable: acme/legal-review'], ['type: acme/legal-matter']));
    const second = parsePlan(renderPlanMarkdown(first));
    expect(second.frontmatter.type).toBe('acme/legal-matter');
    expect(second.items[0]!.deliverable).toBe('acme/legal-review');
  });
});

describe('the slug grammar', () => {
  it('is one lowercase namespace and one lowercase name', () => {
    expect(TYPE_SLUG_PATTERN.source).toBe('^[a-z0-9][a-z0-9-]*\\/[a-z0-9][a-z0-9-]*$');
    expect(isDeliverableRef('code')).toBe(true);
    expect(isDeliverableRef('acme/legal-review')).toBe(true);
    expect(isDeliverableRef('legal-review')).toBe(false);
  });
});
