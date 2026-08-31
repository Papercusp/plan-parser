import { describe, it, expect } from 'vitest';
import { deriveNextPointer } from './next-pointer';
import type { Importance, ItemStatus, PlanItem } from './parser';

/**
 * next-pointer.test.ts — P-002 of deterministic-plan-state-derivation-2026-08-31.
 *
 * FALSIFIABILITY. Every band assertion below is PAIRED with a control that
 * differs in exactly ONE field and lands in a DIFFERENT band. A constant-return
 * mutant (`reason: 'actionable'` always, `itemId: items[0].id` always) fails at
 * least one half of every pair, so these tests cannot all pass on a stub. The
 * ordering tests are likewise paired against a reversed input, which a
 * "return the first item" mutant cannot satisfy in both directions.
 */

const item = (
  id: string,
  storedStatus: ItemStatus,
  extra: Partial<PlanItem> = {},
): PlanItem => ({
  id,
  text: `${id} body text`,
  storedStatus,
  importance: 'normal',
  riskTier: null,
  authority: 'system',
  blockedBy: [],
  decisionRefs: [],
  phase: null,
  lineNumber: 1,
  rawLine: `- **${id}** \`${storedStatus}\` ${id} body text`,
  ...extra,
});

const imp = (importance: Importance): Partial<PlanItem> => ({ importance });

describe('deriveNextPointer — band precedence', () => {
  it('points at the in-flight item when one is wip', () => {
    const d = deriveNextPointer([item('P-001', 'done'), item('P-002', 'wip'), item('P-003', 'todo')]);
    expect(d.reason).toBe('in-flight');
    expect(d.itemId).toBe('P-002');
  });

  it('CONTROL: the same graph with P-002 todo instead of wip points at P-002 as actionable', () => {
    // One field differs from the case above — P-002's storedStatus — and the
    // band changes with it. A mutant that hardcodes either band fails one half.
    const d = deriveNextPointer([item('P-001', 'done'), item('P-002', 'todo'), item('P-003', 'todo')]);
    expect(d.reason).toBe('actionable');
    expect(d.itemId).toBe('P-002');
  });

  it('prefers an in-flight item over a HIGHER-importance actionable one', () => {
    // The bands are checked before the ranking: pointing a second reader at an
    // urgent todo while something is already in flight is how work gets
    // double-placed.
    const d = deriveNextPointer([
      item('P-001', 'todo', imp('urgent')),
      item('P-002', 'wip', imp('low')),
    ]);
    expect(d.reason).toBe('in-flight');
    expect(d.itemId).toBe('P-002');
  });

  it('CONTROL: with the wip item finished, the urgent todo wins', () => {
    const d = deriveNextPointer([
      item('P-001', 'todo', imp('urgent')),
      item('P-002', 'done', imp('low')),
    ]);
    expect(d.reason).toBe('actionable');
    expect(d.itemId).toBe('P-001');
  });

  it('reports needs-human when the only live item awaits a human', () => {
    const d = deriveNextPointer([item('P-001', 'done'), item('P-002', 'needs-human')]);
    expect(d.reason).toBe('needs-human');
    expect(d.itemId).toBe('P-002');
  });

  it('does not rank a needs-human item as actionable even when it is stored todo', () => {
    // authority:'owner' derives the needs-human band from a `todo` token. The
    // pointer must not advertise it as pickable work.
    const d = deriveNextPointer([item('P-001', 'todo', { authority: 'owner' })]);
    expect(d.reason).toBe('needs-human');
    expect(d.itemId).toBe('P-001');
  });

  it('CONTROL: the same item with authority system IS actionable', () => {
    const d = deriveNextPointer([item('P-001', 'todo', { authority: 'system' })]);
    expect(d.reason).toBe('actionable');
    expect(d.itemId).toBe('P-001');
  });

  it('reports blocked, and names the blockers, when every live item is blocked', () => {
    const d = deriveNextPointer([
      item('P-001', 'todo', { blockedBy: ['P-002'] }),
      item('P-002', 'blocked'),
    ]);
    expect(d.reason).toBe('blocked');
    expect(d.itemId).toBe('P-001');
    expect(d.blockedOn).toEqual(['P-002']);
    expect(d.text).toContain('P-002');
  });

  it('CONTROL: resolving the blocker moves the same graph to actionable', () => {
    const d = deriveNextPointer([
      item('P-001', 'todo', { blockedBy: ['P-002'] }),
      item('P-002', 'done'),
    ]);
    expect(d.reason).toBe('actionable');
    expect(d.itemId).toBe('P-001');
    expect(d.blockedOn).toEqual([]);
  });

  it('reports drained — not "blocked", not a stale id — when every item is terminal', () => {
    // This is the exact class the stored pointer gets wrong: a finished plan
    // whose `next:` still names P-001. The derivation cannot produce an id here.
    const d = deriveNextPointer([item('P-001', 'done'), item('P-002', 'dropped')]);
    expect(d.reason).toBe('drained');
    expect(d.itemId).toBeNull();
    expect(d.counts).toEqual({ total: 2, done: 1, dropped: 1, nonTerminal: 0 });
    expect(d.text).toContain('every item is terminal');
  });

  it('abstains with no-items rather than claiming the plan is drained', () => {
    // A plan with no items must NOT read as finished — the graph simply has
    // nothing to say, and the caller has to leave the author's prose alone.
    const d = deriveNextPointer([]);
    expect(d.reason).toBe('no-items');
    expect(d.itemId).toBeNull();
    expect(d.counts.total).toBe(0);
  });

  it('CONTROL: one terminal item is drained, which no-items is not', () => {
    const d = deriveNextPointer([item('P-001', 'done')]);
    expect(d.reason).toBe('drained');
    expect(d.counts.total).toBe(1);
  });
});

describe('deriveNextPointer — ranking', () => {
  it('ranks by importance, urgent first', () => {
    const d = deriveNextPointer([
      item('P-001', 'todo', imp('low')),
      item('P-002', 'todo', imp('normal')),
      item('P-003', 'todo', imp('urgent')),
      item('P-004', 'todo', imp('high')),
    ]);
    expect(d.itemId).toBe('P-003');
    expect(d.candidates.map((c) => c.id)).toEqual(['P-003', 'P-004', 'P-002', 'P-001']);
  });

  it('breaks importance ties by document order — and by order ALONE, both ways', () => {
    // Paired directions: a mutant that returns items[0] passes the first and
    // fails the second; one that sorts by id passes the first and fails the
    // second too, since the second's answer is the LATER id.
    const forward = deriveNextPointer([item('P-001', 'todo'), item('P-002', 'todo')]);
    expect(forward.itemId).toBe('P-001');
    const reversed = deriveNextPointer([item('P-002', 'todo'), item('P-001', 'todo')]);
    expect(reversed.itemId).toBe('P-002');
  });

  it('applies importance ACROSS document order, not merely within it', () => {
    const d = deriveNextPointer([item('P-001', 'todo'), item('P-002', 'todo', imp('urgent'))]);
    expect(d.itemId).toBe('P-002');
  });

  it('lists only live items as candidates, head first, and reports truncation', () => {
    const live = Array.from({ length: 7 }, (_, i) =>
      item(`P-1${String(i).padStart(2, '0')}`, 'todo'),
    );
    const d = deriveNextPointer([item('P-001', 'done'), ...live]);
    expect(d.candidates).toHaveLength(5);
    expect(d.candidates.map((c) => c.id)).not.toContain('P-001');
    expect(d.candidates[0]!.id).toBe(d.itemId);
    expect(d.candidatesTruncated).toBe(true);
  });

  it('CONTROL: a short live list is not reported as truncated', () => {
    const d = deriveNextPointer([item('P-001', 'todo'), item('P-002', 'todo')]);
    expect(d.candidates).toHaveLength(2);
    expect(d.candidatesTruncated).toBe(false);
  });
});

describe('deriveNextPointer — pointer text', () => {
  it('quotes the item body so the pointer is readable without a second lookup', () => {
    const d = deriveNextPointer([item('P-007', 'todo', { text: 'Wire the sweep backstop' })]);
    expect(d.text).toContain('P-007');
    expect(d.text).toContain('Wire the sweep backstop');
  });

  it('clips a long body instead of pasting the whole item into the Now block', () => {
    const long = 'word '.repeat(200).trim();
    const d = deriveNextPointer([item('P-007', 'todo', { text: long })]);
    expect(d.text.length).toBeLessThan(300);
    expect(d.text).toContain('…');
  });

  it('CONTROL: a short body is quoted whole, with no ellipsis', () => {
    const d = deriveNextPointer([item('P-007', 'todo', { text: 'Short body' })]);
    expect(d.text).toContain('Short body');
    expect(d.text).not.toContain('…');
  });

  it('never emits an item id in the text when the verdict has no item', () => {
    // The failure this whole module exists to prevent, asserted directly: a
    // finished plan must not hand a reader a P-NNN to go do.
    for (const d of [
      deriveNextPointer([item('P-001', 'done'), item('P-002', 'dropped')]),
      deriveNextPointer([]),
    ]) {
      expect(d.itemId).toBeNull();
      expect(d.text).not.toMatch(/P-\d{3,}/);
    }
  });

  it('is a pure function of its input — repeated calls agree, input is unmutated', () => {
    const items = [item('P-001', 'todo', imp('low')), item('P-002', 'todo', imp('urgent'))];
    const snapshot = JSON.stringify(items);
    const a = deriveNextPointer(items);
    const b = deriveNextPointer(items);
    expect(a).toEqual(b);
    expect(JSON.stringify(items)).toBe(snapshot);
  });
});

/**
 * FALSIFIABILITY CONTROLS — permanent, in-suite, and safe.
 *
 * The suite above passed 22/22 on its first run, and a suite that has never
 * failed is not yet evidence. These controls are the tier-1 mechanism from the
 * repo's mutation-probe guidance: deliberately-wrong implementations kept
 * PERMANENTLY in the test file, never an in-tree mutation of the real module
 * (which the git-sync sweep can commit even when nothing goes wrong).
 *
 * Each control is paired with a CALIBRATION assertion that the real
 * implementation passes the same scenario — without it, a broken property
 * would let the controls pass too, and the whole block would prove nothing.
 */
describe('deriveNextPointer — falsifiability controls', () => {
  /** Mutant A: ignore the graph, always point at the first item as actionable. */
  const alwaysFirstActionable = (items: PlanItem[]) => ({
    itemId: items[0]?.id ?? null,
    reason: 'actionable' as const,
  });

  /** Mutant B: rank live items lexicographically by id instead of by importance. */
  const rankByIdOnly = (items: PlanItem[]) => {
    const live = items
      .filter((i) => i.storedStatus !== 'done' && i.storedStatus !== 'dropped')
      .map((i) => i.id)
      .sort();
    return { itemId: live[0] ?? null, reason: 'actionable' as const };
  };

  it('a constant-return mutant is CAUGHT by the drained case (and the real one passes it)', () => {
    const drained = [item('P-001', 'done'), item('P-002', 'dropped')];
    // Calibration: the real implementation gives the right answer here.
    expect(deriveNextPointer(drained).itemId).toBeNull();
    expect(deriveNextPointer(drained).reason).toBe('drained');
    // Control: the mutant does not — so this scenario has discriminating power.
    expect(alwaysFirstActionable(drained).itemId).toBe('P-001');
    expect(alwaysFirstActionable(drained).reason).not.toBe('drained');
  });

  it('a constant-return mutant is CAUGHT by the in-flight case (and the real one passes it)', () => {
    const inFlight = [item('P-001', 'todo'), item('P-002', 'wip')];
    expect(deriveNextPointer(inFlight).itemId).toBe('P-002');
    expect(deriveNextPointer(inFlight).reason).toBe('in-flight');
    expect(alwaysFirstActionable(inFlight).itemId).toBe('P-001');
  });

  it('an id-ranking mutant is CAUGHT by importance ordering (and the real one passes it)', () => {
    const ranked = [item('P-001', 'todo', imp('low')), item('P-002', 'todo', imp('urgent'))];
    expect(deriveNextPointer(ranked).itemId).toBe('P-002');
    expect(rankByIdOnly(ranked).itemId).toBe('P-001');
  });

  it('an id-ranking mutant is CAUGHT by the blocked band (and the real one passes it)', () => {
    // P-001 sorts first by id but is blocked by P-002, which is the live one.
    const graph = [item('P-001', 'todo', { blockedBy: ['P-002'] }), item('P-002', 'todo')];
    expect(deriveNextPointer(graph).itemId).toBe('P-002');
    expect(deriveNextPointer(graph).reason).toBe('actionable');
    expect(rankByIdOnly(graph).itemId).toBe('P-001');
  });
});
