/**
 * parser-now-keywords.test.ts — coverage for the `## Now` State/Next
 * extraction and the per-item keyword (`importance:`/`risk:`/`authority:`)
 * strip, plus the first-Now-wins / last-Decisions-wins asymmetry and the
 * `splitFrontmatter` EOF edges. (Continuous-coverage loop W1, Gaps 4–7.)
 *
 * Gap 4 (FIXED + teeth-pinned here): `parseNow`'s State and Next captures
 * each stop at the *other* marker, so the two blocks parse independently of
 * the order an author writes them in. The pre-fix Next capture ran lazily to
 * EOF and swallowed a trailing `**State:**` line. The out-of-order test below
 * is the regression teeth: revert the Next-regex anchor and it fails.
 *
 * Gap 7 (PINNED — intended): an unknown `importance:`/`risk:`/`authority:`
 * token degrades to the default WITHOUT a parseWarning, and the matched span
 * is stripped from `item.text` regardless of whether the value was valid (the
 * strip is unconditional, not gated on a known-value match — so the bogus
 * token never leaks into the visible text).
 */
import { describe, expect, it } from 'vitest';
import { parsePlan } from './parser';

const lines = (...l: string[]) => l.join('\n');

const FM = ['---', 'slug: p', 'status: active', '---', ''];

const now = (...body: string[]) => parsePlan(lines(...FM, '## Now', ...body)).now;

// ─── Gap 4 — `## Now` State/Next order-independence ──────────────────────────

describe('parseNow — State / Next anchoring (Gap 4)', () => {
  it('parses State and Next in canonical order', () => {
    const n = now('**State:** building', '**Next:** ship');
    expect(n?.state).toBe('building');
    expect(n?.next).toBe('ship');
  });

  it('parses cleanly when **Next:** is written BEFORE **State:** (regression)', () => {
    // Pre-fix the Next capture ran `[\s\S]*?$` and swallowed the trailing
    // State line → next was "ship\n**State:** building". The fix anchors Next
    // at a following **State:** marker so order does not matter.
    const n = now('**Next:** ship', '**State:** building');
    expect(n?.state).toBe('building');
    expect(n?.next).toBe('ship');
    // Teeth: the Next capture must NOT have absorbed the State marker.
    expect(n?.next).not.toContain('**State:**');
    expect(n?.next).not.toContain('building');
  });

  it('a State with no following Next yields an empty next', () => {
    const n = now('**State:** only');
    expect(n?.state).toBe('only');
    expect(n?.next).toBe('');
  });

  it('a Next with no preceding/following State yields an empty state', () => {
    const n = now('**Next:** just go');
    expect(n?.state).toBe('');
    expect(n?.next).toBe('just go');
  });

  it('a blank Now block parses to null', () => {
    expect(now('')).toBeNull();
  });

  it('multi-line State is captured up to the Next marker, not past it', () => {
    const n = now('**State:** line one', 'line two', '**Next:** do the thing');
    expect(n?.state).toBe('line one\nline two');
    expect(n?.next).toBe('do the thing');
  });
});

// ─── Gap 7 — per-item keyword strip + unknown-value degrade ───────────────────

describe('parseItemLine — keyword strip & unknown-value degrade (Gap 7)', () => {
  const item = (line: string) =>
    parsePlan(lines(...FM, '## Phase 1', line)).items[0];

  it('a known importance is applied and stripped from the text', () => {
    const it0 = item('- **P-001** `todo` do it importance: high');
    expect(it0?.importance).toBe('high');
    expect(it0?.text).toBe('do it');
  });

  it('an UNKNOWN importance degrades to normal, emits NO warning, and is stripped (no leak)', () => {
    const p = parsePlan(lines(...FM, '## Phase 1', '- **P-001** `todo` do it importance: bananas'));
    const it0 = p.items[0];
    expect(it0?.importance).toBe('normal');
    expect(it0?.text).toBe('do it');
    // The bogus token must not leak into the visible text.
    expect(it0?.text).not.toContain('bananas');
    expect(it0?.text).not.toContain('importance');
    // No parseWarning for an unknown importance (that is a soft lint concern).
    expect(p.parseWarnings.some((w) => /importance/i.test(w))).toBe(false);
  });

  it('a known risk tier is applied and stripped', () => {
    const it0 = item('- **P-001** `todo` do it risk: low');
    expect(it0?.riskTier).toBe('low');
    expect(it0?.text).toBe('do it');
  });

  it('an UNKNOWN risk degrades to null and is stripped (no leak)', () => {
    const p = parsePlan(lines(...FM, '## Phase 1', '- **P-001** `todo` do it risk: nope'));
    const it0 = p.items[0];
    expect(it0?.riskTier).toBeNull();
    expect(it0?.text).toBe('do it');
    expect(it0?.text).not.toContain('nope');
    expect(it0?.text).not.toContain('risk');
    expect(p.parseWarnings.some((w) => /risk/i.test(w))).toBe(false);
  });

  it('a known authority is applied and stripped', () => {
    const it0 = item('- **P-001** `todo` do it authority: owner');
    expect(it0?.authority).toBe('owner');
    expect(it0?.text).toBe('do it');
  });

  it('preserves keyword-like suffixes inside hyphenated prose', () => {
    const text =
      'OWNER-AUTHORITY: turn on the low-risk: option, high-importance: urgent preference, and not-blocked-by: P-002.';
    const it0 = item(`- **P-001** \`todo\` ${text}`);

    expect(it0?.text).toBe(text);
    expect(it0?.authority).toBe('system');
    expect(it0?.riskTier).toBeNull();
    expect(it0?.importance).toBe('normal');
    expect(it0?.blockedBy).toEqual([]);
  });

  it('an UNKNOWN authority degrades to the system default and is stripped (no leak)', () => {
    const p = parsePlan(lines(...FM, '## Phase 1', '- **P-001** `todo` do it authority: nope'));
    const it0 = p.items[0];
    expect(it0?.authority).toBe('system');
    expect(it0?.text).toBe('do it');
    expect(it0?.text).not.toContain('nope');
    expect(it0?.text).not.toContain('authority');
    expect(p.parseWarnings.some((w) => /authority/i.test(w))).toBe(false);
  });
});

// ─── Gap 5 — first ## Now wins; last ## Decisions wins (intentional asymmetry) ─

describe('parsePlan — duplicate-section precedence (Gap 5)', () => {
  it('the FIRST of two ## Now sections is honored', () => {
    const p = parsePlan(
      lines(
        ...FM,
        '## Now',
        '**State:** first',
        '**Next:** n1',
        '',
        '## Now',
        '**State:** second',
        '**Next:** n2',
      ),
    );
    expect(p.now?.state).toBe('first');
    expect(p.now?.next).toBe('n1');
  });

  it('the SECOND of two ## Decisions sections REPLACES the first (no guard — footgun)', () => {
    const p = parsePlan(
      lines(
        ...FM,
        '## Decisions',
        '### D-001 — first',
        'body one',
        '',
        '## Decisions',
        '### D-002 — second',
        'body two',
      ),
    );
    // Asymmetric with ## Now: the later Decisions section wins outright.
    expect(p.decisions.map((d) => d.id)).toEqual(['D-002']);
  });
});

// ─── Gap 6 — splitFrontmatter EOF edges ──────────────────────────────────────

describe('parsePlan — frontmatter EOF edges (Gap 6)', () => {
  it('unterminated frontmatter (no closing ---) is legacy but items still parse', () => {
    const p = parsePlan(lines('---', 'title: x', '# no close', '', '## Phase 1', '- **P-001** `todo` x'));
    expect(p.isLegacy).toBe(true);
    expect(p.items.map((i) => i.id)).toEqual(['P-001']);
  });

  it('frontmatter with no trailing newline after the close yields an empty body, parsed fm', () => {
    const p = parsePlan('---\nslug: p\nstatus: active\n---');
    expect(p.prose).toBe('');
    expect(p.frontmatter.slug).toBe('p');
    expect(p.frontmatter.status).toBe('active');
    expect(p.isLegacy).toBe(false);
    expect(p.items).toEqual([]);
  });
});
