import { describe, it, expect } from 'vitest';
import { summarizePlanStatus } from './plan-status-summary';
import { deriveNextPointer } from './next-pointer';
import type { Importance, ItemStatus, PlanItem } from './parser';

/**
 * plan-status-summary.test.ts — P-001 of derived-status-not-hand-written-2026-10-12
 * (SPEC-P-001: summarizePlanStatus lists only items whose effective status is
 * actionable).
 *
 * FALSIFIABILITY. Each membership assertion is PAIRED with a control that
 * differs in exactly one field and moves the item to a different list, so a
 * mutant that lists every non-terminal item as actionable — or that reads the
 * STORED status instead of the effective one — fails one half of each pair.
 */

const item = (id: string, storedStatus: ItemStatus, extra: Partial<PlanItem> = {}): PlanItem => ({
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
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('summarizePlanStatus — actionable is derived from EFFECTIVE status', () => {
  it('lists a todo item with no blockers as actionable', () => {
    const s = summarizePlanStatus({ items: [item('P-001', 'todo')] });
    expect(ids(s.actionable)).toEqual(['P-001']);
  });

  it('CONTROL: the same item once done is NOT actionable (the stale-Now failure)', () => {
    const s = summarizePlanStatus({ items: [item('P-001', 'done')] });
    expect(s.actionable).toEqual([]);
    expect(s.counts.done).toBe(1);
  });

  it('a stored-todo item blocked by a live item is listed blocked, not actionable', () => {
    const s = summarizePlanStatus({
      items: [item('P-001', 'todo'), item('P-002', 'todo', { blockedBy: ['P-001'] })],
    });
    expect(ids(s.actionable)).toEqual(['P-001']);
    expect(s.blocked.map((b) => [b.id, b.blockedOn, b.external])).toEqual([['P-002', ['P-001'], false]]);
    expect(s.counts.blocked).toBe(1);
  });

  it('CONTROL: once its blocker is done, the same item becomes actionable', () => {
    const s = summarizePlanStatus({
      items: [item('P-001', 'done'), item('P-002', 'todo', { blockedBy: ['P-001'] })],
    });
    expect(ids(s.actionable)).toEqual(['P-002']);
    expect(s.blocked).toEqual([]);
  });

  it('a stored-blocked item with no in-plan blocker is reported as externally blocked', () => {
    const s = summarizePlanStatus({ items: [item('P-001', 'blocked')] });
    expect(s.blocked.map((b) => [b.id, b.external])).toEqual([['P-001', true]]);
    expect(s.actionable).toEqual([]);
  });

  it('wip items are in flight, not actionable', () => {
    const s = summarizePlanStatus({ items: [item('P-001', 'wip'), item('P-002', 'todo')] });
    expect(ids(s.inFlight)).toEqual(['P-001']);
    expect(ids(s.actionable)).toEqual(['P-002']);
  });

  it('a needs-human item awaits a human and is not actionable', () => {
    const s = summarizePlanStatus({ items: [item('P-001', 'needs-human')] });
    expect(ids(s.awaitingHuman)).toEqual(['P-001']);
    expect(s.actionable).toEqual([]);
  });
});

describe('summarizePlanStatus — ordering matches the next-pointer', () => {
  const items = [item('P-001', 'todo', imp('low')), item('P-002', 'todo', imp('urgent')), item('P-003', 'todo')];

  it('ranks actionable items by importance, then document order', () => {
    expect(ids(summarizePlanStatus({ items }).actionable)).toEqual(['P-002', 'P-003', 'P-001']);
  });

  it('actionable[0] is the next-pointer item for every input order', () => {
    for (const order of [items, [...items].reverse()]) {
      const s = summarizePlanStatus({ items: order });
      expect(s.actionable[0]!.id).toBe(deriveNextPointer(order).itemId);
      expect(s.next.itemId).toBe('P-002');
      expect(s.next.reason).toBe('actionable');
    }
  });
});

describe('summarizePlanStatus — composed inputs', () => {
  it('reports claimed holders per item and marks holders as measured', () => {
    const s = summarizePlanStatus({
      items: [item('P-001', 'todo'), item('P-002', 'todo')],
      holders: {
        'P-001': [{ workItemId: 'WI-1', holder: 'su-a', state: 'wip' }],
        'P-002': [{ workItemId: 'WI-2', holder: null, state: 'open' }],
      },
    });
    expect(s.holdersMeasured).toBe(true);
    expect(s.actionable.map((a) => [a.id, a.heldBy])).toEqual([
      ['P-001', ['su-a']],
      ['P-002', []],
    ]);
  });

  it('CONTROL: without a holders map, holders are reported unmeasured rather than empty-as-fact', () => {
    const s = summarizePlanStatus({ items: [item('P-001', 'todo')] });
    expect(s.holdersMeasured).toBe(false);
  });

  it('picks the highest-numbered decision as the latest, regardless of array order', () => {
    const decisions = [
      { id: 'D-002', title: 'second', date: null },
      { id: 'D-010', title: 'tenth', date: '2026-10-12' },
      { id: 'D-001', title: 'first', date: null },
    ];
    expect(summarizePlanStatus({ items: [], decisions }).latestDecision?.id).toBe('D-010');
    expect(summarizePlanStatus({ items: [], decisions: [...decisions].reverse() }).latestDecision?.id).toBe('D-010');
  });

  it('carries the lifecycle verdict through verbatim and names it in the text line', () => {
    const s = summarizePlanStatus({
      items: [item('P-001', 'todo')],
      lifecycle: { verdict: 'active', lastActivityAt: '2026-10-12T00:00:00.000Z' },
    });
    expect(s.lifecycle).toEqual({ verdict: 'active', lastActivityAt: '2026-10-12T00:00:00.000Z' });
    expect(s.text).toContain('lifecycle active');
  });
});

describe('summarizePlanStatus — blocks from outside the graph (blind review #14 G-1)', () => {
  it('an externally blocked todo item is counted and listed blocked, names its blocker, and is never next', () => {
    const s = summarizePlanStatus({ items: [item('P-001', 'todo'), item('P-002', 'todo')], externalBlocks: { 'P-001': ['EI-1'] } });
    expect(s.counts.blocked).toBe(1);
    expect(s.actionable.map((i) => i.id)).toEqual(['P-002']);
    expect(s.blocked).toEqual([expect.objectContaining({ id: 'P-001', blockedOn: ['EI-1'], external: true })]);
    expect(s.next.itemId).toBe('P-002');
  });
  it('CONTROL: without the external block the same item is actionable', () => {
    const s = summarizePlanStatus({ items: [item('P-001', 'todo'), item('P-002', 'todo')] });
    expect(s.counts.blocked).toBe(0);
    expect(s.actionable.map((i) => i.id)).toContain('P-001');
  });
  it('a wip item under an external block derives blocked; a terminal one stays terminal', () => {
    const s = summarizePlanStatus({ items: [item('P-001', 'wip'), item('P-002', 'done')], externalBlocks: { 'P-001': ['EI-1'], 'P-002': ['EI-2'] } });
    expect(s.counts.blocked).toBe(1);
    expect(s.counts.wip).toBe(0);
    expect(s.counts.done).toBe(1);
  });
});

describe('summarizePlanStatus — bounds report themselves', () => {
  it('caps a list and flags it truncated; counts still census every item', () => {
    const items = Array.from({ length: 7 }, (_, i) => item(`P-00${i + 1}`, 'todo'));
    const s = summarizePlanStatus({ items, listCap: 5 });
    expect(s.actionable).toHaveLength(5);
    expect(s.truncated.actionable).toBe(true);
    expect(s.counts.todo).toBe(7);
  });

  it('CONTROL: under the cap nothing is flagged truncated', () => {
    const items = Array.from({ length: 5 }, (_, i) => item(`P-00${i + 1}`, 'todo'));
    expect(summarizePlanStatus({ items, listCap: 5 }).truncated.actionable).toBe(false);
  });

  it('an empty plan yields no verdict, not a finished one', () => {
    const s = summarizePlanStatus({ items: [] });
    expect(s.next.reason).toBe('no-items');
    expect(s.counts.total).toBe(0);
    expect(s.text).toMatch(/No items/);
  });
});
