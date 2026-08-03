import { describe, it, expect } from 'vitest';
import { resolveEffectiveStatus, deriveItemNeedsHuman } from './effective-status';
import type { ItemStatus, ParsedPlan, PlanItem } from './parser';

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

// ── EI-19397307303043951: staleBlockedHint — the "stored blocked never gets
// re-evaluated when its blocked-by dependency completes" diagnostic ─────────
describe('resolveEffectiveStatus — staleBlockedHint (EI-19397307303043951)', () => {
  it('is null for a plain unblocked item', () => {
    const r = resolve(item('A', 'todo'));
    expect(eff(r, 'A').staleBlockedHint).toBeNull();
  });

  it('is null for a stored-blocked item with NO blocked-by (the legitimate external-block case)', () => {
    const r = resolve(item('A', 'blocked'));
    expect(eff(r, 'A').effectiveStatus).toBe('blocked');
    expect(eff(r, 'A').staleBlockedHint).toBeNull();
  });

  it('is null while the blocked-by dependency is still unresolved (no false alarm)', () => {
    const r = resolve(item('A', 'blocked', ['B']), item('B', 'todo'));
    expect(eff(r, 'A').effectiveStatus).toBe('blocked');
    expect(eff(r, 'A').unresolvedBlockers).toEqual(['B']);
    expect(eff(r, 'A').staleBlockedHint).toBeNull();
  });

  it('fires once every blocked-by dependency is done, WITHOUT changing effectiveStatus', () => {
    const r = resolve(item('A', 'blocked', ['B']), item('B', 'done'));
    // The trap this closes: effectiveStatus stays 'blocked' (the stored token
    // is sticky by design — see the module docstring) even though
    // unresolvedBlockers is now empty. staleBlockedHint is what makes that
    // contradiction legible instead of silently confusing.
    expect(eff(r, 'A').effectiveStatus).toBe('blocked');
    expect(eff(r, 'A').unresolvedBlockers).toEqual([]);
    expect(eff(r, 'A').staleBlockedHint).toMatch(/already resolved/);
    expect(eff(r, 'A').staleBlockedHint).toMatch(/plans:set-status/);
  });

  it('fires the same way when the dependency resolved via dropped, not done', () => {
    const r = resolve(item('A', 'blocked', ['B']), item('B', 'dropped'));
    expect(eff(r, 'A').unresolvedBlockers).toEqual([]);
    expect(eff(r, 'A').staleBlockedHint).not.toBeNull();
  });

  it('never auto-clears effectiveStatus even when staleBlockedHint fires — a deliberate post-dependency re-block (the P-011/D-016 shape) must survive unchanged', () => {
    // Mirrors a real live case: an item explicitly re-blocked BY RULING after
    // its blocked-by dependency already completed. The resolver cannot tell
    // this apart from the trap by data alone, so it must stay conservative:
    // effectiveStatus stays 'blocked', only the diagnostic hint changes.
    const r = resolve(item('P-011', 'blocked', ['P-010']), item('P-010', 'done'));
    expect(eff(r, 'P-011').effectiveStatus).toBe('blocked');
    expect(eff(r, 'P-011').staleBlockedHint).not.toBeNull();
  });
});

// ── B-12 / P-072: the DERIVED needs-human top band the DONE-gate keys on ──────
describe('resolveEffectiveStatus — derived needsHuman (B-12 / P-072)', () => {
  const pi = (p: Partial<PlanItem> & { id: string; storedStatus: ItemStatus }): PlanItem =>
    ({ text: 'x', importance: 'normal', blockedBy: [], ...p }) as PlanItem;
  const resolvePI = (...items: PlanItem[]) =>
    resolveEffectiveStatus({ items } as unknown as ParsedPlan);
  const got = (r: ReturnType<typeof resolvePI>, id: string) => r.items.find((i) => i.id === id)!;

  it('BEHAVIOR-NEUTRAL: needsHuman equals storedStatus === "needs-human" (unarmed default)', () => {
    const r = resolvePI(
      pi({ id: 'A', storedStatus: 'todo' }),
      pi({ id: 'B', storedStatus: 'needs-human' }),
      pi({ id: 'C', storedStatus: 'done' }),
    );
    expect(got(r, 'A').needsHuman).toBe(false);
    expect(got(r, 'B').needsHuman).toBe(true);
    expect(got(r, 'C').needsHuman).toBe(false);
  });

  it('authority=owner derives needsHuman even from a non-needs-human stored token (P-011)', () => {
    const r = resolvePI(pi({ id: 'A', storedStatus: 'todo', authority: 'owner' }));
    expect(got(r, 'A').needsHuman).toBe(true);
  });

  it('a high riskTier alone does NOT gate while unarmed (behavior-neutral; armed path is P-092)', () => {
    const r = resolvePI(pi({ id: 'A', storedStatus: 'todo', riskTier: 'critical' }));
    expect(got(r, 'A').needsHuman).toBe(false);
  });

  it('needsHuman is independent of the blocked-by graph (a blocked needs-human item still needs the human)', () => {
    const r = resolvePI(
      pi({ id: 'A', storedStatus: 'needs-human', blockedBy: ['B'] }),
      pi({ id: 'B', storedStatus: 'todo' }),
    );
    expect(got(r, 'A').effectiveStatus).toBe('blocked'); // its blocker isn't done…
    expect(got(r, 'A').needsHuman).toBe(true); // …but it still needs a human decision
  });

  it('deriveItemNeedsHuman: armed + ceiling-aware path gates a risk above the effective ceiling', () => {
    // The wired-but-inert armed path (P-092). Unarmed (default) ⇒ stored token.
    const item = { storedStatus: 'todo' as const, riskTier: 'high' as const, authority: 'system' as const };
    expect(deriveItemNeedsHuman(item)).toBe(false); // unarmed
    expect(deriveItemNeedsHuman(item, { armed: true, ceiling: 'low' })).toBe(true); // high > low
    expect(deriveItemNeedsHuman(item, { armed: true, ceiling: 'critical' })).toBe(false); // high ≤ critical
    expect(deriveItemNeedsHuman(item, { armed: true, ceiling: 'never-auto' })).toBe(true); // never-auto
  });
});
