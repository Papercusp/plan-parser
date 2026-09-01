import { describe, it, expect } from 'vitest';
import {
  derivePlanLifecycle,
  derivePlanStatusTransition,
  reconcilePlanLifecycle,
} from './lifecycle';
import { PLAN_STATUSES, NON_TERMINAL_PLAN_STATUSES, type ItemStatus, type PlanItem } from './parser';

/**
 * plan-status-transition.test.ts — P-004 of
 * deterministic-plan-state-derivation-2026-08-31.
 *
 * FALSIFIABILITY. Same discipline as lifecycle.test.ts: every assertion that a
 * transition IS proposed is paired with a control differing in exactly ONE
 * input where none is, so a mutant that always proposes (or always returns
 * null) fails at least one half of every pair. The status-exclusion block
 * additionally sweeps the WHOLE vocabulary rather than spot-checking, so a new
 * status added to PLAN_STATUSES without a decision here fails a test instead of
 * silently inheriting whichever branch it happens to fall into.
 */

const item = (id: string, storedStatus: ItemStatus): PlanItem => ({
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
});

/** Every item terminal — the shape that warrants moving to awaiting-acceptance. */
const DRAINED = [item('P-001', 'done'), item('P-002', 'dropped')];
/** One live item — the shape that warrants moving back. */
const LIVE = [item('P-001', 'done'), item('P-002', 'todo')];

const drained = () => derivePlanLifecycle(DRAINED);
const live = () => derivePlanLifecycle(LIVE);

describe('derivePlanStatusTransition — the forward edge (drained)', () => {
  it('moves a drained `ready` plan to awaiting-acceptance', () => {
    const t = derivePlanStatusTransition('ready', drained());
    expect(t).not.toBeNull();
    expect(t).toMatchObject({ from: 'ready', to: 'awaiting-acceptance' });
  });

  it('CONTROL: the same `ready` plan with one live item proposes nothing', () => {
    expect(derivePlanStatusTransition('ready', live())).toBeNull();
  });

  it('accepts the legacy `active` as a source, and never writes it back', () => {
    const t = derivePlanStatusTransition('active', drained());
    expect(t).toMatchObject({ from: 'active', to: 'awaiting-acceptance' });
    // `active` is legacy (set-plan-status maps it to `ready`); it must never be
    // a TARGET, or the rule would keep a retired value alive on fresh writes.
    const targets = PLAN_STATUSES.map(
      (s) => derivePlanStatusTransition(s, live())?.to ?? null,
    ).concat(PLAN_STATUSES.map((s) => derivePlanStatusTransition(s, drained())?.to ?? null));
    expect(targets).not.toContain('active');
  });

  it('states the terminal census as its evidence, so the reason survives without the graph', () => {
    const t = derivePlanStatusTransition('ready', drained());
    expect(t?.reason).toContain('1 done, 1 dropped');
    // It must not be readable as "this plan passed acceptance". Asserting the
    // DISCLAIMER rather than banning keywords: the first version of this test
    // banned /passed/ and failed on the reason's own "NOT a claim that the plan
    // passed one" — a keyword ban cannot tell an assertion from its denial.
    expect(t?.reason).toContain('NOT a claim');
  });
});

describe('derivePlanStatusTransition — the reverse edge (an item reopens)', () => {
  it('moves an awaiting-acceptance plan back to ready when an item goes live', () => {
    const t = derivePlanStatusTransition('awaiting-acceptance', live());
    expect(t).toMatchObject({ from: 'awaiting-acceptance', to: 'ready' });
    expect(t?.reason).toContain('P-002');
  });

  it('CONTROL: the same awaiting-acceptance plan while still drained proposes nothing', () => {
    expect(derivePlanStatusTransition('awaiting-acceptance', drained())).toBeNull();
  });

  it('round-trips: drain then reopen returns the plan to where it started', () => {
    const forward = derivePlanStatusTransition('ready', drained());
    expect(forward?.to).toBe('awaiting-acceptance');
    const back = derivePlanStatusTransition(forward!.to, live());
    expect(back?.to).toBe('ready');
    // Invertibility is the property that makes storing this bit admissible at
    // all (plan D-005 point 4): the write destroys nothing the graph cannot
    // reconstruct. A one-way transition would strand plans on reopen.
    const settled = derivePlanStatusTransition(back!.to, live());
    expect(settled).toBeNull();
  });
});

describe('derivePlanStatusTransition — what it must never touch', () => {
  it('never moves a `draft` plan, drained or not', () => {
    // draft vs ready encodes an authorial greenlight the graph cannot see, so
    // moving a drained draft would silently approve a plan nobody approved —
    // and could not be undone, since the reverse edge restores `ready`.
    expect(derivePlanStatusTransition('draft', drained())).toBeNull();
    expect(derivePlanStatusTransition('draft', live())).toBeNull();
  });

  it('never moves off a terminal status, and never proposes one', () => {
    for (const terminal of ['shipped', 'superseded'] as const) {
      expect(derivePlanStatusTransition(terminal, drained())).toBeNull();
      expect(derivePlanStatusTransition(terminal, live())).toBeNull();
    }
    const everyProposal = PLAN_STATUSES.flatMap((s) => [
      derivePlanStatusTransition(s, drained())?.to,
      derivePlanStatusTransition(s, live())?.to,
    ]).filter((t): t is Exclude<typeof t, undefined> => t !== undefined);
    expect(everyProposal.length).toBeGreaterThan(0);
    expect(everyProposal).not.toContain('shipped');
    expect(everyProposal).not.toContain('superseded');
  });

  it('proposes a move for EXACTLY the two statuses that differ by the drained bit', () => {
    // A whole-vocabulary sweep, not a spot check: a status added to
    // PLAN_STATUSES without a deliberate decision here changes this set and
    // fails, instead of quietly inheriting a branch.
    const movable = PLAN_STATUSES.filter(
      (s) =>
        derivePlanStatusTransition(s, drained()) !== null ||
        derivePlanStatusTransition(s, live()) !== null,
    );
    expect([...movable].sort()).toEqual(['active', 'awaiting-acceptance', 'ready']);
  });

  it('abstains on an itemless plan rather than reading it as drained', () => {
    // The failure this prevents: "no live items" read as "finished" would
    // declare every itemless plan complete on first run (D-004 point 4).
    const itemless = derivePlanLifecycle([]);
    expect(itemless.verdict).toBe('no-items');
    for (const status of PLAN_STATUSES) {
      expect(derivePlanStatusTransition(status, itemless)).toBeNull();
    }
  });

  it('proposes nothing for a status outside the vocabulary', () => {
    expect(derivePlanStatusTransition('in-review', drained())).toBeNull();
    expect(derivePlanStatusTransition(null, drained())).toBeNull();
    expect(derivePlanStatusTransition(undefined, drained())).toBeNull();
  });
});

describe('the vocabulary itself', () => {
  it('carries awaiting-acceptance as a NON-terminal status', () => {
    expect(PLAN_STATUSES).toContain('awaiting-acceptance');
    // Load-bearing: were it terminal, a drained plan would read as finished and
    // skip the very acceptance gate this status exists to route it into.
    expect(NON_TERMINAL_PLAN_STATUSES).toContain('awaiting-acceptance');
  });

  it('derives the non-terminal set from the vocabulary, leaving no status unclassified', () => {
    const terminal = PLAN_STATUSES.filter((s) => !NON_TERMINAL_PLAN_STATUSES.includes(s));
    expect([...terminal].sort()).toEqual(['shipped', 'superseded']);
    expect(NON_TERMINAL_PLAN_STATUSES.length + terminal.length).toBe(PLAN_STATUSES.length);
  });
});

describe('reconcilePlanLifecycle — the new status is judged, not merely tolerated', () => {
  it('agrees when awaiting-acceptance sits over a drained graph', () => {
    const r = reconcilePlanLifecycle('awaiting-acceptance', drained());
    expect(r.disposition).toBe('agreed');
    expect(r.contradiction).toBeNull();
  });

  it('CONTROL: contradicts when awaiting-acceptance sits over a LIVE graph', () => {
    const r = reconcilePlanLifecycle('awaiting-acceptance', live());
    expect(r.disposition).toBe('contradicted');
    expect(r.contradiction?.evidence).toContain('P-002');
  });

  it('recognises every status in the vocabulary', () => {
    // The regression this pins: `known` used to be a hand-listed set, so a new
    // status reported `unrecognized` — "this label is not one we know" — on
    // every plan holding it, which is far more alarming than the truth.
    for (const status of PLAN_STATUSES) {
      expect(reconcilePlanLifecycle(status, drained()).disposition).not.toBe('unrecognized');
      expect(reconcilePlanLifecycle(status, live()).disposition).not.toBe('unrecognized');
    }
    expect(reconcilePlanLifecycle('not-a-status', drained()).disposition).toBe('unrecognized');
  });
});
