/**
 * parser-edge.test.ts — plan-parser edge cases (Plan 2 Phase D, P-019).
 *
 * plan-parser is load-bearing — it backs every `plans:*` tool + the admin UI.
 * The happy path is covered (index.test.ts); these pin the resilience edges that
 * matter for `plans:list` not crashing on real-world plan files: legacy/unknown
 * tagging (malformed or missing frontmatter), the fence-skip (item-like lines in
 * a worked-example code block must NOT become items), duplicate/malformed-id
 * warnings, slug derivation from the file path, and decision parsing.
 */
import { describe, expect, it } from 'vitest';
import { parsePlan } from './parser';
import { renderPlanMarkdown } from './renderer';

const lines = (...l: string[]) => l.join('\n');

const VALID = lines(
  '---',
  'title: My Plan',
  'slug: my-plan',
  'status: active',
  '---',
  '',
  '## Now',
  '**State:** building',
  '**Next:** ship it',
  '',
  '## Phase 1 — Build',
  '- **P-001** `todo` do a thing',
  '- **P-002** `done` did a thing',
  '',
  '## Decisions',
  '### D-001 — Chose X over Y',
  'Date: 2026-05-30',
  'Because reasons.',
);

describe('parsePlan — frontmatter / legacy tagging', () => {
  it('a well-formed plan is not legacy and derives its slug from the file path', () => {
    const p = parsePlan(VALID, { filePath: 'docs/plans/my-plan-2026-05-30.md' });
    expect(p.isLegacy).toBe(false);
    expect(p.slug).toBe('my-plan-2026-05-30');
    expect(p.frontmatter.status).toBe('active');
  });

  it('a plan with no frontmatter is tagged legacy (not a crash)', () => {
    const p = parsePlan(lines('# Old Plan', '', '## Phase 1', '- **P-001** `todo` x'));
    expect(p.isLegacy).toBe(true);
    expect(p.items.map((i) => i.id)).toEqual(['P-001']);
  });

  it('frontmatter missing status (or slug) is legacy', () => {
    const noStatus = parsePlan(lines('---', 'slug: p', '---', '', '# P'));
    expect(noStatus.isLegacy).toBe(true);
    const noSlug = parsePlan(lines('---', 'status: active', '---', '', '# P'));
    expect(noSlug.isLegacy).toBe(true);
  });
});

describe('parsePlan — structure', () => {
  it('does NOT parse item-like lines inside a code fence', () => {
    const src = lines(
      '---', 'slug: p', 'status: active', '---', '',
      '## Phase 1 — Build',
      '- **P-001** `todo` real item',
      '```',
      '- **P-999** `todo` fake item inside a fence',
      '```',
      '- **P-002** `todo` another real item',
    );
    const p = parsePlan(src);
    expect(p.items.map((i) => i.id)).toEqual(['P-001', 'P-002']);
  });

  it('warns on a duplicate item id', () => {
    const src = lines(
      '---', 'slug: p', 'status: active', '---', '',
      '## Phase 1',
      '- **P-001** `todo` a',
      '- **P-001** `todo` b',
    );
    const p = parsePlan(src);
    expect(p.parseWarnings.some((w) => /Duplicate item id: P-001/.test(w))).toBe(true);
  });

  it('parses a Decisions section into decision entries', () => {
    const p = parsePlan(VALID);
    expect(p.decisions.map((d) => d.id)).toEqual(['D-001']);
    expect(p.decisions[0].title).toMatch(/Chose X/);
  });

  it('extracts the Now block state + next', () => {
    const p = parsePlan(VALID);
    expect(p.now?.state).toMatch(/building/);
    expect(p.now?.next).toMatch(/ship it/);
  });
});

/**
 * Hanging-indent CONTINUATION lines (EI-19403572587513008).
 *
 * A long item is normally written wrapped under a hanging indent. Every
 * physical line after the first used to be dropped, so the item was stored as
 * a sentence fragment — and because nothing errored and `content` still
 * rendered fine, it read to the claiming agent as a vague item rather than a
 * truncated one. The first test is the recurrence guard: the LAST line's
 * content must survive.
 */
describe('parsePlan — hanging-indent continuation lines', () => {
  // Verbatim from no-http-anywhere-2026-07-28 P-008, the item this was found on.
  const WRAPPED = lines(
    '---', 'slug: p', 'status: active', '---', '',
    '## Phase 1',
    '- **P-008** `todo` **Cut queries-per-screen.** Coarser reads for above-the-fold data, defer',
    '  below-the-fold, kill duplicates found in P-002. A screen needing 106 round-trips is the condition',
    '  the gate exists to manage; removing the wave beats scheduling it.',
  );

  it('folds a 3-line hanging-indent item, keeping the LAST line', () => {
    const [item] = parsePlan(WRAPPED).items;
    expect(item.id).toBe('P-008');
    // The exact regression: it used to end mid-clause on the word "defer".
    expect(item.text).not.toMatch(/defer$/);
    expect(item.text).toContain('below-the-fold, kill duplicates');
    expect(item.text).toContain('removing the wave beats scheduling it.');
  });

  it('keeps rawLine PHYSICAL so unparsed-line detection still matches the source', () => {
    const [item] = parsePlan(WRAPPED).items;
    // detectUnparsedItemLines (lint.ts / item-parse-feedback.ts) looks each
    // parsed rawLine up among the source's own lines; a folded value here
    // would report every wrapped item as an unparsed item line.
    expect(WRAPPED.split('\n')).toContain(item.rawLine);
    expect(item.rawLine).toMatch(/defer$/);
  });

  it('round-trips through the renderer as ONE line', () => {
    const rendered = renderPlanMarkdown(parsePlan(WRAPPED));
    const itemLines = rendered.split('\n').filter((l) => l.includes('P-008'));
    expect(itemLines).toHaveLength(1);
    // Re-parsing the render is stable and still carries the tail.
    expect(parsePlan(rendered).items[0].text).toBe(parsePlan(WRAPPED).items[0].text);
  });

  it('honours a keyword that wrapped onto a continuation line', () => {
    const p = parsePlan(
      lines(
        '---', 'slug: p', 'status: active', '---', '',
        '## Phase 1',
        '- **P-001** `todo` a long item whose keywords wrapped onto the next',
        '  line entirely blocked-by: P-002 importance: high',
      ),
    );
    const [item] = p.items;
    expect(item.blockedBy).toEqual(['P-002']);
    expect(item.importance).toBe('high');
    expect(item.text).toContain('line entirely');
    expect(item.text).not.toMatch(/blocked-by|importance/);
    expect(p.parseWarnings).toEqual([]);
  });

  it('stops at a blank line, a sibling bullet, a nested bullet and a fence', () => {
    const p = parsePlan(
      lines(
        '---', 'slug: p', 'status: active', '---', '',
        '## Phase 1',
        '- **P-001** `todo` first',
        '  continues here',
        '',
        '  a detached paragraph that is NOT part of P-001',
        '- **P-002** `todo` second',
        '  also continues',
        '  - a nested bullet that is NOT folded',
        '- **P-003** `todo` third',
        '  ```',
        '  fenced, not folded',
        '  ```',
      ),
    );
    expect(p.items.map((i) => i.id)).toEqual(['P-001', 'P-002', 'P-003']);
    expect(p.items[0].text).toBe('first continues here');
    expect(p.items[1].text).toBe('second also continues');
    expect(p.items[2].text).toBe('third');
  });

  it('leaves an unwrapped item exactly as before', () => {
    const p = parsePlan(VALID);
    expect(p.items.map((i) => i.text)).toEqual(['do a thing', 'did a thing']);
  });
});

describe('parsePlan — wrapper corruption diagnostics', () => {
  it('notices lowercase-to-lowercase hard line breaks but ignores fenced examples', () => {
    const p = parsePlan(
      lines(
        '---', 'slug: p', 'status: active', '---', '',
        '## Phase 1',
        '- **P-001** `todo` publish/y',
        'ank/revoke and audit.',
        '```',
        'fenced/wrap',
        'ped example',
        '```',
      ),
    );

    expect(p.parseWarnings).toEqual([]);
    expect(p.parseNotices).toHaveLength(1);
    expect(p.parseNotices[0]).toMatch(/mid-word hard line break/i);
    expect(p.parseNotices[0]).toMatch(/lowercase letter.*newline.*lowercase letter/i);
  });

  it('errors when blocked-by and importance markers are detached from an item line', () => {
    const p = parsePlan(
      lines(
        '---', 'slug: p', 'status: active', '---', '',
        '## Phase 1',
        '- **P-001** `todo` provenance, maintainer review, publish/y',
        'ank/revoke, and audit. blocked-by: P-006 importance: high',
      ),
    );

    expect(p.items).toHaveLength(1);
    expect(p.items[0]?.blockedBy).toEqual([]);
    expect(p.items[0]?.importance).toBe('normal');
    expect(p.parseWarnings).toHaveLength(1);
    expect(p.parseWarnings[0]).toMatch(/orphan item marker/i);
    expect(p.parseWarnings[0]).toMatch(/blocked-by:.*importance:/i);
  });
});
