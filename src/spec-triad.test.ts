import { describe, it, expect } from 'vitest';
import {
  evaluateSpecTriad,
  describeSpecTriadGap,
  SPEC_TRIAD_MIN_BODY_CHARS,
  SPEC_TRIAD_PLACEHOLDERS,
} from './spec-triad';

const REQ_BODY =
  'The recall path must surface anchor staleness to the agent, not only to the settings UI.';
const DESIGN_BODY =
  'Fold the nightly sweep verdict into memory:search as a prepended banner on the body.';

function plan(parts: {
  requirements?: string | null;
  design?: string | null;
  items?: number;
  extra?: string;
}): string {
  const out = ['---', 'slug: t', 'status: active', '---', '', '# T', ''];
  if (parts.requirements !== undefined && parts.requirements !== null) {
    out.push('## Requirements', '', parts.requirements, '');
  }
  if (parts.design !== undefined && parts.design !== null) {
    out.push('## Design', '', parts.design, '');
  }
  const n = parts.items ?? 1;
  if (n > 0) {
    out.push('## Items', '');
    for (let i = 1; i <= n; i++) {
      out.push(`- **P-${String(i).padStart(3, '0')}** todo — thing ${i}`);
    }
    out.push('');
  }
  if (parts.extra) out.push(parts.extra, '');
  return out.join('\n');
}

describe('evaluateSpecTriad', () => {
  it('a plan with all three legs is complete', () => {
    const v = evaluateSpecTriad(plan({ requirements: REQ_BODY, design: DESIGN_BODY }));
    expect(v.complete).toBe(true);
    expect(v.missing).toEqual([]);
    expect(v.legs.every((l) => l.why === null)).toBe(true);
  });

  it('reports each leg independently, in a stable order', () => {
    const v = evaluateSpecTriad(plan({ requirements: null, design: null, items: 0 }));
    expect(v.complete).toBe(false);
    expect(v.missing).toEqual(['requirements', 'design', 'tasks']);
    expect(v.legs.map((l) => l.name)).toEqual(['requirements', 'design', 'tasks']);
  });

  it('a HEADING ALONE does not satisfy a leg — this is the fake-compliance case', () => {
    // The whole reason the detector is not `content.includes('## Requirements')`.
    const v = evaluateSpecTriad(plan({ requirements: '', design: DESIGN_BODY }));
    expect(v.missing).toEqual(['requirements']);
    expect(v.legs[0].why).toMatch(/empty/);
  });

  it.each(SPEC_TRIAD_PLACEHOLDERS.map((p) => [p] as const))(
    'a %s body does not satisfy a leg',
    (placeholder) => {
      const v = evaluateSpecTriad(plan({ requirements: placeholder, design: DESIGN_BODY }));
      expect(v.missing).toEqual(['requirements']);
      expect(v.legs[0].why).toMatch(/placeholder/);
    },
  );

  it('normalizes placeholder punctuation and emphasis (_T.B.D._ is TBD)', () => {
    const v = evaluateSpecTriad(plan({ requirements: '_T.B.D._', design: DESIGN_BODY }));
    expect(v.missing).toEqual(['requirements']);
  });

  it('enforces the exported min-body floor, and one char over clears it', () => {
    const justUnder = 'x'.repeat(SPEC_TRIAD_MIN_BODY_CHARS - 1);
    const justOver = 'x'.repeat(SPEC_TRIAD_MIN_BODY_CHARS);
    expect(evaluateSpecTriad(plan({ requirements: justUnder, design: DESIGN_BODY })).missing).toEqual(
      ['requirements'],
    );
    expect(evaluateSpecTriad(plan({ requirements: justOver, design: DESIGN_BODY })).complete).toBe(
      true,
    );
  });

  it('a section of only sub-headings carries no content', () => {
    const v = evaluateSpecTriad(
      plan({ requirements: '### R1\n\n### R2\n\n### R3', design: DESIGN_BODY }),
    );
    expect(v.missing).toEqual(['requirements']);
  });

  it('matches heading PREFIXES — "Requirements (v2)" and "Design Decisions" count', () => {
    const src = [
      '---',
      'slug: t',
      '---',
      '',
      '## Requirements (v2)',
      '',
      REQ_BODY,
      '',
      '## Design Decisions',
      '',
      DESIGN_BODY,
      '',
      '## Items',
      '',
      '- **P-001** todo — a',
      '',
    ].join('\n');
    expect(evaluateSpecTriad(src).complete).toBe(true);
  });

  it('does NOT match an unrelated heading that merely contains the word', () => {
    const src = [
      '---',
      'slug: t',
      '---',
      '',
      '## Non-Requirements',
      '',
      REQ_BODY,
      '',
      '## Items',
      '',
      '- **P-001** todo — a',
      '',
    ].join('\n');
    const v = evaluateSpecTriad(src);
    expect(v.missing).toContain('requirements');
  });

  it('takes the BEST of several same-named sections', () => {
    const src = [
      '---',
      'slug: t',
      '---',
      '',
      '## Requirements',
      '',
      'TBD',
      '',
      '## Requirements',
      '',
      REQ_BODY,
      '',
      '## Design',
      '',
      DESIGN_BODY,
      '',
      '## Items',
      '',
      '- **P-001** todo — a',
      '',
    ].join('\n');
    expect(evaluateSpecTriad(src).complete).toBe(true);
  });

  it('tasks == the plan P-NNN items; a plan with no items owes the tasks leg', () => {
    const v = evaluateSpecTriad(plan({ requirements: REQ_BODY, design: DESIGN_BODY, items: 0 }));
    expect(v.missing).toEqual(['tasks']);
  });

  it('accepts an itemCount supplied by the caller instead of re-counting', () => {
    const src = plan({ requirements: REQ_BODY, design: DESIGN_BODY, items: 0 });
    expect(evaluateSpecTriad(src, { itemCount: 3 }).complete).toBe(true);
    expect(evaluateSpecTriad(src, { itemCount: 0 }).missing).toEqual(['tasks']);
  });

  it('ignores headings inside a fenced block (they are content, not structure)', () => {
    const src = [
      '---',
      'slug: t',
      '---',
      '',
      '## Notes',
      '',
      '```md',
      '## Requirements',
      '',
      REQ_BODY,
      '```',
      '',
      '## Items',
      '',
      '- **P-001** todo — a',
      '',
    ].join('\n');
    const v = evaluateSpecTriad(src);
    expect(v.missing).toEqual(['requirements', 'design']);
  });

  it('an empty document owes all three legs rather than throwing', () => {
    const v = evaluateSpecTriad('');
    expect(v.complete).toBe(false);
    expect(v.missing).toEqual(['requirements', 'design', 'tasks']);
  });

  it('describeSpecTriadGap names every missing leg, and says so when complete', () => {
    const gap = describeSpecTriadGap(evaluateSpecTriad(plan({ items: 0 })));
    expect(gap).toMatch(/Requirements/);
    expect(gap).toMatch(/Design/);
    expect(gap).toMatch(/items/);
    const ok = describeSpecTriadGap(
      evaluateSpecTriad(plan({ requirements: REQ_BODY, design: DESIGN_BODY })),
    );
    expect(ok).toMatch(/complete/);
  });
});
