import { describe, it, expect } from 'vitest';
import {
  splitPlanIntoParts,
  joinPartsIntoPlan,
  diffPlanParts,
  mergeFederatedPart,
  joinFederatedParts,
  type FederatedPart,
} from './parts';

const PLAN = `---
title: Demo plan
slug: demo-2026-06-13
status: draft
---

# Demo plan

## Now

**State:** in progress.

**Next:** keep going.

## Background

Some prose with a literal \`## fake heading\` inline, and a fenced block:

\`\`\`md
## this is NOT a section
- **P-999** \`todo\` not an item either
\`\`\`

## Phase 1 — First phase

- **P-001** \`todo\` first item. → D-001
- **P-002** \`done\` second item.

## Phase 2 — Second phase

- **P-003** \`wip\` third item.

## Decisions

### D-001 — A decision
Date: 2026-06-13
The body of the decision.
Related: P-001
`;

describe('plan parts — byte-faithful split/join', () => {
  it('round-trips exactly (the load-bearing invariant)', () => {
    expect(joinPartsIntoPlan(splitPlanIntoParts(PLAN))).toBe(PLAN);
  });

  it.each([
    ['empty', ''],
    ['no frontmatter', '# Title\n\n## Now\n\nbody\n'],
    ['only frontmatter', '---\ntitle: x\n---\n'],
    ['no trailing newline', '# T\n\n## Now\n\nx'],
    ['fence with ## inside', '# T\n\n## S\n\n```\n## not a heading\n```\n'],
    ['windows-ish blank lines', '# T\n\n\n## Now\n\n\nbody\n'],
  ])('round-trips: %s', (_name, content) => {
    expect(joinPartsIntoPlan(splitPlanIntoParts(content))).toBe(content);
  });

  it('keys parts by stable identity (P-NNN / D-NNN / heading slug)', () => {
    const keys = splitPlanIntoParts(PLAN).map((p) => p.key);
    expect(keys).toContain('frontmatter');
    expect(keys).toContain('preamble');
    expect(keys).toContain('item:P-001');
    expect(keys).toContain('item:P-003');
    expect(keys).toContain('decision:D-001');
    expect(keys).toContain('section:now');
    expect(keys).toContain('section:phase-1-first-phase');
  });

  it('does NOT split on ## / - **P-** inside a fenced code block', () => {
    const keys = splitPlanIntoParts(PLAN).map((p) => p.key);
    expect(keys).not.toContain('item:P-999'); // it's inside the fence
    // the fenced "## this is NOT a section" must not become its own section
    expect(keys.filter((k) => k.startsWith('section:')).length).toBe(5); // Now, Background, Phase 1, Phase 2, Decisions
  });

  it('disambiguates colliding heading keys with a #n suffix', () => {
    const dup = '## Items\n\n- **P-001** `todo` a\n\n## Items\n\n- **P-002** `todo` b\n';
    const keys = splitPlanIntoParts(dup).map((p) => p.key);
    expect(keys).toContain('section:items');
    expect(keys).toContain('section:items#2');
  });
});

describe('plan parts — diff (capture-side delta)', () => {
  it('flags an edited item as upserted, untouched items not', () => {
    const before = splitPlanIntoParts(PLAN);
    const after = splitPlanIntoParts(PLAN.replace('first item.', 'FIRST ITEM (edited).'));
    const d = diffPlanParts(before, after);
    const keys = d.upserted.map((p) => p.key);
    expect(keys).toContain('item:P-001');
    expect(keys).not.toContain('item:P-002'); // untouched
    expect(keys).not.toContain('decision:D-001');
    expect(d.removedKeys).toEqual([]);
  });

  it('reports a removed part', () => {
    const before = splitPlanIntoParts(PLAN);
    const after = splitPlanIntoParts(PLAN.replace('- **P-002** `done` second item.\n', ''));
    const d = diffPlanParts(before, after);
    expect(d.removedKeys).toContain('item:P-002');
  });
});

describe('plan parts — LWW merge (the merge-not-clobber proof)', () => {
  const part = (key: string, text: string, fedTs: number, author = 'a'): FederatedPart => ({
    key,
    kind: 'item',
    text,
    order: 0,
    fedTs,
    author,
  });

  it('concurrent edits to DIFFERENT items BOTH survive (no clobber)', () => {
    // Shared baseline.
    let state = new Map<string, FederatedPart>();
    state = mergeFederatedPart(state, part('item:P-001', 'P1 base', 100));
    state = mergeFederatedPart(state, part('item:P-002', 'P2 base', 100));

    // Peer A edits P-001 @ ts 200; Peer B edits P-002 @ ts 201 (concurrent, different keys).
    const a = part('item:P-001', 'P1 by A', 200, 'A');
    const b = part('item:P-002', 'P2 by B', 201, 'B');

    // Merge both ops (order-independent) — the whole-doc model would have lost one.
    let merged = mergeFederatedPart(mergeFederatedPart(state, a), b);
    expect(merged.get('item:P-001')!.text).toBe('P1 by A');
    expect(merged.get('item:P-002')!.text).toBe('P2 by B');

    // Reverse apply order → identical (commutative).
    merged = mergeFederatedPart(mergeFederatedPart(state, b), a);
    expect(merged.get('item:P-001')!.text).toBe('P1 by A');
    expect(merged.get('item:P-002')!.text).toBe('P2 by B');
  });

  it('same-key edits: higher fedTs wins; strictly-older is dropped', () => {
    let s = new Map<string, FederatedPart>();
    s = mergeFederatedPart(s, part('item:P-001', 'old', 100));
    s = mergeFederatedPart(s, part('item:P-001', 'new', 200));
    expect(s.get('item:P-001')!.text).toBe('new');
    s = mergeFederatedPart(s, part('item:P-001', 'stale', 150)); // older → dropped
    expect(s.get('item:P-001')!.text).toBe('new');
  });

  it('equal fedTs → deterministic author tie-break (same on every peer)', () => {
    let s = new Map<string, FederatedPart>();
    s = mergeFederatedPart(s, part('item:P-001', 'from A', 100, 'A'));
    s = mergeFederatedPart(s, part('item:P-001', 'from B', 100, 'B')); // B > A → wins
    expect(s.get('item:P-001')!.text).toBe('from B');
    s = mergeFederatedPart(s, part('item:P-001', 'from A again', 100, 'A')); // A < B → drop
    expect(s.get('item:P-001')!.text).toBe('from B');
  });

  it('tombstone removes a key (LWW-guarded)', () => {
    let s = new Map<string, FederatedPart>();
    s = mergeFederatedPart(s, part('item:P-001', 'x', 100));
    s = mergeFederatedPart(s, { ...part('item:P-001', '', 90), tombstone: true }); // older del → ignored
    expect(s.has('item:P-001')).toBe(true);
    s = mergeFederatedPart(s, { ...part('item:P-001', '', 110), tombstone: true }); // newer del → removed
    expect(s.has('item:P-001')).toBe(false);
  });

  it('a merged part set recomposes to valid plan markdown', () => {
    const parts = splitPlanIntoParts(PLAN);
    let s = new Map<string, FederatedPart>();
    parts.forEach((p, i) => {
      s = mergeFederatedPart(s, { ...p, fedTs: 100 + i, author: 'seed' });
    });
    // Edit one item via a later op.
    s = mergeFederatedPart(s, {
      key: 'item:P-001',
      kind: 'item',
      text: '- **P-001** `done` first item. → D-001',
      order: parts.find((p) => p.key === 'item:P-001')!.order,
      fedTs: 1000,
      author: 'editor',
    });
    const rendered = joinFederatedParts(s);
    expect(rendered).toContain('- **P-001** `done` first item.');
    expect(rendered).toContain('- **P-002** `done` second item.'); // untouched, still present
    expect(rendered).toContain('### D-001 — A decision');
  });
});
