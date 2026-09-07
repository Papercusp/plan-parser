/**
 * decision-round-trip.test.ts — the guard for EI-18804290731494084.
 *
 * A decision body is free markdown written by an agent or a human, and a plan
 * is markdown too, so the two grammars overlap. Three ways that overlap
 * destroyed real decisions on unified-agent-state-plane-2026-07-27:
 *
 *   1. a `##` heading in a body ENDED the `## Decisions` section, truncating
 *      the decision to its first paragraph and promoting the remainder to
 *      top-level plan sections (32 orphaned sections; D-057 and D-083 lost);
 *   2. a `###` heading whose text merely BEGAN with a decision id minted a
 *      phantom decision (`### D-045's framing was incomplete` → a second
 *      D-045), which produced a duplicate-id lint ERROR;
 *   3. because every lint error rejects every write, (2) left the plan
 *      PERMANENTLY un-editable — no single string replace could clear two
 *      errors ~370 lines apart.
 *
 * Each failure is silent: the bytes survive in the file, only the STRUCTURE is
 * destroyed, so nothing surfaces until someone reads a decision back and finds
 * it truncated. Hence a property test, not just examples — the space of bodies
 * that collide with the plan grammar is larger than the cases we happened to
 * hit.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parsePlan, normalizeDecisionBodyHeadings } from './parser';
import { renderPlanMarkdown } from './renderer';

const FM = [
  '---',
  'title: Test plan',
  'slug: test-plan',
  'status: active',
  'created: 2026-07-27',
  'updated: 2026-07-27',
  '---',
  '',
].join('\n');

function planWith(decisionsBlock: string): string {
  return `${FM}# Test plan\n\n## Now\n\nState: testing.\nNext: nothing.\n\n## Decisions\n\n${decisionsBlock}\n`;
}

describe('decision declaration matching (R1)', () => {
  it('does NOT treat an id glued to prose as a declaration', () => {
    // The exact live shape: `### D-045's framing was incomplete, ...` inside
    // D-045's own body. Before the fix this became a SECOND D-045.
    const p = parsePlan(
      planWith(
        [
          '### D-045 — the real decision',
          'Date: 2026-07-27',
          'The ruling.',
          '',
          "### D-045's framing was incomplete, and this is the correction",
          'The correction text.',
        ].join('\n'),
      ),
    );
    expect(p.decisions.map((d) => d.id)).toEqual(['D-045']);
    expect(p.decisions[0]?.body).toContain('The correction text.');
  });

  it('does NOT treat a repeat of an already-declared id as a second declaration', () => {
    // `### D-053 held, and is now pinned by tests` is LEXICALLY identical to a
    // legacy real head (`### D-004 P-011 and P-012 remain owned by ...`), so
    // only the already-declared check can separate them.
    const p = parsePlan(
      planWith(
        [
          '### D-053 — goal + assumptions ride expanded[]',
          'Date: 2026-07-27',
          'The ruling.',
          '',
          '### D-053 held, and is now pinned by tests at three levels',
          'The evidence.',
        ].join('\n'),
      ),
    );
    expect(p.decisions.map((d) => d.id)).toEqual(['D-053']);
    expect(p.decisions[0]?.body).toContain('The evidence.');
  });

  it('reports the absorbed repeat as a NOTICE, never as a parse warning', () => {
    // Load-bearing: a parse warning becomes a lint ERROR, and a lint error
    // rejects every write — so routing this through parseWarnings would wedge
    // the very plan the notice is describing.
    const p = parsePlan(
      planWith(
        [
          '### D-001 — first',
          'Body.',
          '',
          '### D-001 again, as prose',
          'More.',
        ].join('\n'),
      ),
    );
    expect(p.parseNotices).toHaveLength(1);
    expect(p.parseNotices[0]).toContain('D-001');
    expect(p.parseWarnings).toEqual([]);
  });

  it('still accepts BOTH real declaration forms — separator and legacy bare', () => {
    // 148 of the corpus's 3,921 decision heads are the bare form. A stricter
    // "must have a separator" rule would silently destroy every one of them,
    // which is why that design was rejected.
    const p = parsePlan(
      planWith(
        [
          '### D-001 Declaration over inference — no theory-of-mind module',
          'Body one.',
          '',
          '### D-002 — Auto-derive, never author',
          'Body two.',
          '',
          '### D-003: colon form',
          'Body three.',
        ].join('\n'),
      ),
    );
    expect(p.decisions.map((d) => d.id)).toEqual(['D-001', 'D-002', 'D-003']);
    expect(p.decisions[0]?.title).toBe('Declaration over inference — no theory-of-mind module');
    expect(p.decisions[1]?.title).toBe('Auto-derive, never author');
  });
});

describe('decision affects metadata', () => {
  it('parses, de-duplicates, and round-trips canonical Affects metadata', () => {
    const once = parsePlan(
      planWith(
        [
          '### D-004 — cross-plan authority',
          'Date: 2026-09-07',
          'Affects: target-plan, second-plan, target-plan',
          'The ruling is execution authority for both target plans.',
        ].join('\n'),
      ),
    );
    expect(once.decisions[0]?.affects).toEqual(['target-plan', 'second-plan']);

    const twice = parsePlan(renderPlanMarkdown(once));
    expect(twice.decisions[0]?.affects).toEqual(['target-plan', 'second-plan']);
    expect(twice.decisions[0]?.body).toContain('Affects: target-plan, second-plan, target-plan');
  });
});

describe('decision body heading normalization (R3)', () => {
  it('demotes `##` so the body cannot break out of the Decisions section', () => {
    const { body, normalized } = normalizeDecisionBodyHeadings(
      ['Preamble.', '', '## 1. The item is REAL', 'text', '', '## 2. RULING', 'more'].join('\n'),
    );
    expect(normalized).toBe(2);
    expect(body).toContain('#### 1. The item is REAL');
    expect(body).not.toMatch(/^#{1,3} /m);
  });

  it('THE INVARIANT: a normalized body has no heading at level ≤ 3', () => {
    // Level ≤ 3 is exactly the set that can act as a section break (1–2) or a
    // decision declaration (3). Nothing else about the body matters.
    for (const src of [
      '# top',
      '## mid\n### sub',
      '### D-001 mentioned in prose',
      'prose only, no headings',
      '#not-a-heading (no space)',
    ]) {
      const { body } = normalizeDecisionBodyHeadings(src);
      expect(body).not.toMatch(/^#{1,3}\s/m);
    }
  });

  it('preserves RELATIVE structure when the body mixes levels', () => {
    const { body } = normalizeDecisionBodyHeadings(['## Top', 'a', '### Sub', 'b'].join('\n'));
    expect(body).toContain('#### Top');
    expect(body).toContain('##### Sub');
  });

  it('is a byte-for-byte no-op on a body already at `####`+', () => {
    const src = ['#### Why this is better', 'a', '##### Detail', 'b'].join('\n');
    const { body, normalized } = normalizeDecisionBodyHeadings(src);
    expect(body).toBe(src);
    expect(normalized).toBe(0);
  });

  it('leaves headings inside a fence alone — that is content, not structure', () => {
    const src = ['Intro.', '', '```md', '## Now', '```', '', '## Real heading'].join('\n');
    const { body } = normalizeDecisionBodyHeadings(src);
    expect(body).toContain('```md\n## Now\n```');
    expect(body).toContain('#### Real heading');
  });

  it('clamps at h6 rather than emitting `#######`, which renders as literal text', () => {
    const { body } = normalizeDecisionBodyHeadings(['# a', '###### b'].join('\n'));
    expect(body).toContain('#### a');
    expect(body).toContain('###### b');
    expect(body).not.toContain('#######');
  });

  it('a normalized body survives the parser intact — the end-to-end claim', () => {
    const raw = ['Preamble.', '', '## 3. RULING', 'The ruling text.', '', '## 4. Acceptance', 'Accepted.'].join('\n');
    const { body } = normalizeDecisionBodyHeadings(raw);
    const p = parsePlan(planWith(`### D-083 — scoping\nDate: 2026-07-27\n${body}\n`));
    expect(p.decisions).toHaveLength(1);
    // Before the fix this body stopped at "Preamble." and the rest became
    // top-level plan sections.
    expect(p.decisions[0]?.body).toContain('The ruling text.');
    expect(p.decisions[0]?.body).toContain('Accepted.');
    // …and nothing leaked out into the plan's own section structure.
    expect(p.prose.split('\n').filter((l) => /^## /.test(l))).toEqual(['## Now', '## Decisions']);
  });
});

describe('property: a normalized decision body always round-trips', () => {
  it('parse(render(plan)) preserves every decision id and body', () => {
    // Bodies are generated from exactly the fragments that broke the real
    // plan: `##`/`###` headings, and prose LEADING with a decision id.
    const fragment = fc.oneof(
      fc.constant('## A section heading'),
      fc.constant('### A sub heading'),
      fc.constant('# A top heading'),
      fc.constant('### D-001 mentioned in prose'),
      fc.constant("### D-002's framing"),
      fc.constant('Some ordinary prose.'),
      fc.constant('- a list item'),
    );

    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 6 }),
        fc.array(fragment, { minLength: 1, maxLength: 8 }),
        (ids, fragments) => {
          const decisions = ids
            .map((n) => {
              const id = `D-${String(n).padStart(3, '0')}`;
              const { body } = normalizeDecisionBodyHeadings(fragments.join('\n\n'));
              return `### ${id} — title ${n}\nDate: 2026-07-27\n${body}`;
            })
            .join('\n\n');

          const once = parsePlan(planWith(decisions));
          const twice = parsePlan(renderPlanMarkdown(once));

          expect(twice.decisions.map((d) => d.id)).toEqual(once.decisions.map((d) => d.id));
          expect(twice.decisions.map((d) => d.body)).toEqual(once.decisions.map((d) => d.body));
          // Non-vacuity: the fixture must actually be exercising decisions.
          expect(once.decisions.length).toBe(ids.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});
