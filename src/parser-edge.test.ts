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
