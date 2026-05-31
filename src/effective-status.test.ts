import { describe, it, expect } from 'vitest';
import { resolveEffectiveStatus } from './effective-status';
import type { ItemStatus, ParsedPlan } from './parser';

/**
 * effective-status.test.ts — P-020 of test-coverage-rest-non-critical. The
 * blocked-by resolution (per D-005): an item with unresolved blockers is
 * effective `blocked`; a blocker resolves when stored `done` OR `dropped`
 * (the anti-stale-blocked rule); stored `blocked` is always blocked; cycles
 * and missing refs resolve to blocked + are flagged.
 */

type Item = { id: string; storedStatus: ItemStatus; blockedBy: string[] };
const item = (id: string, storedStatus: ItemStatus, blockedBy: string[] = []): Item => ({
  id,
  storedStatus,
  blockedBy,
});
const resolve = (...items: Item[]) =>
  resolveEffectiveStatus({ items } as unknown as ParsedPlan);
const eff = (r: ReturnType<typeof resolve>, id: string) =>
  r.items.find((i) => i.id === id)!;

describe('resolveEffectiveStatus', () => {
  it('passes stored status through when there are no blockers', () => {
    const r = resolve(item('A', 'todo'), item('B', 'wip'), item('C', 'done'));
    expect(eff(r, 'A').effectiveStatus).toBe('todo');
    expect(eff(r, 'B').effectiveStatus).toBe('wip');
    expect(eff(r, 'C').effectiveStatus).toBe('done');
  });

  it('blocks an item whose blocker is unresolved (still todo/wip)', () => {
    const r = resolve(item('A', 'todo', ['B']), item('B', 'todo'));
    expect(eff(r, 'A').effectiveStatus).toBe('blocked');
    expect(eff(r, 'A').unresolvedBlockers).toEqual(['B']);
    expect(eff(r, 'B').effectiveStatus).toBe('todo');
  });

  it('unblocks when the blocker is done', () => {
    const r = resolve(item('A', 'todo', ['B']), item('B', 'done'));
    expect(eff(r, 'A').effectiveStatus).toBe('todo');
    expect(eff(r, 'A').unresolvedBlockers).toEqual([]);
  });

  it('unblocks when the blocker is dropped (D-005 anti-stale-blocked rule)', () => {
    const r = resolve(item('A', 'todo', ['B']), item('B', 'dropped'));
    expect(eff(r, 'A').effectiveStatus).toBe('todo');
  });

  it('treats a stored `blocked` token as always effective blocked (external blocker)', () => {
    const r = resolve(item('A', 'blocked'));
    expect(eff(r, 'A').effectiveStatus).toBe('blocked');
  });

  it('flags a missing blocked-by ref and resolves the item to blocked', () => {
    const r = resolve(item('A', 'todo', ['X']));
    expect(eff(r, 'A').effectiveStatus).toBe('blocked');
    expect(eff(r, 'A').unresolvedBlockers).toEqual(['X']);
    expect(r.missingRefs).toEqual([{ itemId: 'A', ref: 'X' }]);
  });

  it('resolves a blocked-by cycle to blocked and flags both members', () => {
    const r = resolve(item('A', 'todo', ['B']), item('B', 'todo', ['A']));
    expect(eff(r, 'A').effectiveStatus).toBe('blocked');
    expect(eff(r, 'B').effectiveStatus).toBe('blocked');
    expect([...r.cycleMembers].sort()).toEqual(['A', 'B']);
  });
});
