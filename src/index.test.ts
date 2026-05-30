import { describe, it, expect } from 'vitest';
import {
  parsePlan,
  resolveEffectiveStatus,
  hashPlanContent,
  maskFences,
} from './index';

const PLAN = `---
title: Demo
slug: demo-2026-05-30
status: active
---

# Demo

## Now

**State:** building.

**Next:** ship it.

## Phase 1

- **P-001** \`done\` first thing
- **P-002** \`todo\` second thing blocked-by: P-001 → D-001

## Decisions

### D-001 — pick a thing
Date: 2026-05-30
We picked the thing.
`;

describe('@papercusp/plan-parser', () => {
  it('parsePlan extracts frontmatter, now, items, decisions', () => {
    const p = parsePlan(PLAN, { filePath: 'demo-2026-05-30.md' });
    expect(p.isLegacy).toBe(false);
    expect(p.frontmatter.slug).toBe('demo-2026-05-30');
    expect(p.now?.state).toContain('building');
    expect(p.items.map((i) => i.id)).toEqual(['P-001', 'P-002']);
    expect(p.items[1].blockedBy).toEqual(['P-001']);
    expect(p.items[1].decisionRefs).toEqual(['D-001']);
    expect(p.decisions.map((d) => d.id)).toEqual(['D-001']);
  });

  it('resolveEffectiveStatus blocks an item whose blocker is not done', () => {
    const p = parsePlan(PLAN.replace('**P-001** `done`', '**P-001** `wip`'));
    const { items } = resolveEffectiveStatus(p);
    const p2 = items.find((i) => i.id === 'P-002')!;
    expect(p2.effectiveStatus).toBe('blocked');
    expect(p2.unresolvedBlockers).toEqual(['P-001']);
  });

  it('resolveEffectiveStatus clears the block once the blocker is done', () => {
    const p = parsePlan(PLAN);
    const { items } = resolveEffectiveStatus(p);
    expect(items.find((i) => i.id === 'P-002')!.effectiveStatus).toBe('todo');
  });

  it('hashPlanContent is stable and content-sensitive', () => {
    expect(hashPlanContent('a')).toBe(hashPlanContent('a'));
    expect(hashPlanContent('a')).not.toBe(hashPlanContent('b'));
    expect(hashPlanContent('a')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('maskFences blanks fenced regions but preserves length', () => {
    const src = 'keep\n```\n- **P-999** `todo` fake\n```\nkeep2';
    const masked = maskFences(src);
    expect(masked.length).toBe(src.length);
    expect(masked).toContain('keep');
    expect(masked).not.toContain('P-999');
  });
});
