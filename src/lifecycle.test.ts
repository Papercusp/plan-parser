import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STALLED_AFTER_DAYS,
  derivePlanLifecycle,
  reconcilePlanLifecycle,
} from './lifecycle';
import type { ItemStatus, PlanItem } from './parser';

/**
 * lifecycle.test.ts — P-003 of deterministic-plan-state-derivation-2026-08-31.
 *
 * FALSIFIABILITY. Every verdict assertion is PAIRED with a control that differs
 * in exactly ONE input and lands on a DIFFERENT verdict, so a constant-return
 * mutant (`verdict: 'active'` always, `disposition: 'agreed'` always) fails at
 * least one half of every pair. The staleness pair straddles the threshold by a
 * single day in each direction, which a mutant that ignores the clock cannot
 * satisfy in both directions.
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

const NOW = '2026-08-31T12:00:00.000Z';
/** An ISO instant `days` before NOW. */
const daysAgo = (days: number): string =>
  new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
const fresh = (days: number) => ({ lastActivityAt: daysAgo(days), now: NOW });

describe('derivePlanLifecycle — the implementation axis', () => {
  it('reports active while any item is still live', () => {
    const d = derivePlanLifecycle([item('P-001', 'done'), item('P-002', 'todo')], {
      freshness: fresh(1),
    });
    expect(d.verdict).toBe('active');
    expect(d.counts).toMatchObject({ total: 2, done: 1, nonTerminal: 1 });
  });

  it('CONTROL: the same graph with P-002 done instead of todo is implementation-complete', () => {
    // One field differs — P-002's storedStatus — and the verdict changes with
    // it. A mutant hardcoding either verdict fails one half of this pair.
    const d = derivePlanLifecycle([item('P-001', 'done'), item('P-002', 'done')], {
      freshness: fresh(1),
      acceptance: { rubricActive: false },
    });
    expect(d.verdict).toBe('implementation-complete');
    expect(d.counts.nonTerminal).toBe(0);
  });

  it('counts dropped items as terminal — a dropped item is a decision, not open work', () => {
    const d = derivePlanLifecycle([item('P-001', 'done'), item('P-002', 'dropped')], {
      acceptance: { rubricActive: false },
    });
    expect(d.verdict).toBe('implementation-complete');
    expect(d.counts).toMatchObject({ done: 1, dropped: 1, nonTerminal: 0 });
  });

  it('an itemless plan abstains — it is NOT implementation-complete', () => {
    // The load-bearing distinction: an empty plan has finished nothing. If this
    // ever returns 'implementation-complete', every stub plan in the corpus
    // starts reading as landed work.
    const d = derivePlanLifecycle([], { acceptance: { rubricActive: false } });
    expect(d.verdict).toBe('no-items');
    expect(d.text).toMatch(/not a finished one/i);
  });

  it('resolves EFFECTIVE status, so a blocked item counts as live work', () => {
    const d = derivePlanLifecycle(
      [item('P-001', 'todo'), item('P-002', 'todo', { blockedBy: ['P-001'] })],
      { freshness: fresh(0) },
    );
    expect(d.verdict).toBe('active');
    expect(d.counts.nonTerminal).toBe(2);
    expect(d.counts.blocked).toBe(1);
  });
});

describe('derivePlanLifecycle — the acceptance axis', () => {
  const drained = [item('P-001', 'done'), item('P-002', 'done')];

  it('reports awaiting-acceptance when a rubric is active', () => {
    const d = derivePlanLifecycle(drained, {
      acceptance: { rubricActive: true, rubricRef: 'acc/plan-x' },
    });
    expect(d.verdict).toBe('awaiting-acceptance');
    expect(d.text).toContain('acc/plan-x');
  });

  it('CONTROL: the same drained graph with no active rubric is implementation-complete', () => {
    const d = derivePlanLifecycle(drained, { acceptance: { rubricActive: false } });
    expect(d.verdict).toBe('implementation-complete');
  });

  // EI-22078741539479611: an acceptance rubric retires WITH its shipped plan, so
  // `rubricActive:false` beside a retired ref is a validation that CLOSED. The old
  // text ("the validation path has not begun") sent agents to author a duplicate.
  it('a RETIRED rubric reads as validation CLOSED, not "not begun"', () => {
    const d = derivePlanLifecycle(drained, {
      acceptance: { rubricActive: false, retiredRubricRef: 'acc/plan-x' },
    });
    expect(d.verdict).toBe('implementation-complete');
    expect(d.text).toContain('acc/plan-x');
    expect(d.text).toMatch(/completed and closed/i);
    expect(d.text).not.toMatch(/has not begun/i);
    expect(d.unmeasured).not.toContain('acceptance');
  });

  it('CONTROL: the same signal WITHOUT a retired ref keeps the "not begun" reading', () => {
    const d = derivePlanLifecycle(drained, { acceptance: { rubricActive: false, retiredRubricRef: null } });
    expect(d.verdict).toBe('implementation-complete');
    expect(d.text).toMatch(/has not begun/i);
  });

  it('an ACTIVE rubric outranks a retired one — a successor contract means grading is pending again', () => {
    const d = derivePlanLifecycle(drained, {
      acceptance: { rubricActive: true, rubricRef: 'acc/plan-x-r2', retiredRubricRef: 'acc/plan-x' },
    });
    expect(d.verdict).toBe('awaiting-acceptance');
    expect(d.text).toContain('acc/plan-x-r2');
  });

  it('never claims a plan is ACCEPTED — an active rubric is not a passing grade', () => {
    const d = derivePlanLifecycle(drained, { acceptance: { rubricActive: true } });
    expect(d.text).toMatch(/not a claim that it will pass/i);
    expect(d.verdict).not.toBe('accepted' as unknown as typeof d.verdict);
  });

  it('an UNMEASURED acceptance signal is reported, not defaulted to false', () => {
    // "not measured" and "measured false" are different facts. Both land on
    // implementation-complete, so `unmeasured` is the ONLY thing separating a
    // checked verdict from an unchecked one.
    const measured = derivePlanLifecycle(drained, { acceptance: { rubricActive: false } });
    const unmeasured = derivePlanLifecycle(drained, {});
    expect(measured.verdict).toBe(unmeasured.verdict);
    expect(measured.unmeasured).not.toContain('acceptance');
    expect(unmeasured.unmeasured).toContain('acceptance');
    expect(unmeasured.text).toMatch(/not measured/i);
  });
});

describe('derivePlanLifecycle — the momentum axis', () => {
  const live = [item('P-001', 'done'), item('P-002', 'todo')];

  it('reports stalled once idle days reach the threshold', () => {
    const d = derivePlanLifecycle(live, { freshness: fresh(DEFAULT_STALLED_AFTER_DAYS) });
    expect(d.verdict).toBe('stalled');
    expect(d.idleDays).toBe(DEFAULT_STALLED_AFTER_DAYS);
  });

  it('CONTROL: one day inside the threshold is still active', () => {
    // The pair straddles the boundary by a single day in each direction, so a
    // mutant that ignores the clock fails one half whichever verdict it picks.
    const d = derivePlanLifecycle(live, { freshness: fresh(DEFAULT_STALLED_AFTER_DAYS - 1) });
    expect(d.verdict).toBe('active');
  });

  it('honours a caller-supplied threshold and reports the yardstick it used', () => {
    const d = derivePlanLifecycle(live, { freshness: fresh(10), stalledAfterDays: 7 });
    expect(d.verdict).toBe('stalled');
    expect(d.stalledAfterDays).toBe(7);
  });

  it('a DRAINED plan is never stalled, however cold', () => {
    // "finished and untouched" is not "unfinished and abandoned". Reporting the
    // first as the second sends a reader to restart work that is already done.
    const d = derivePlanLifecycle([item('P-001', 'done')], {
      freshness: fresh(900),
      acceptance: { rubricActive: false },
    });
    expect(d.verdict).toBe('implementation-complete');
    expect(d.idleDays).toBe(900);
  });

  it('an unmeasurable timestamp abstains from the momentum axis instead of reading as fresh', () => {
    // A null/garbage timestamp must not become idleDays 0 — a broken clock
    // would then be the strongest possible evidence of freshness.
    const nulled = derivePlanLifecycle(live, { freshness: { lastActivityAt: null, now: NOW } });
    expect(nulled.verdict).toBe('active');
    expect(nulled.idleDays).toBeNull();
    expect(nulled.unmeasured).toContain('freshness');

    const garbage = derivePlanLifecycle(live, {
      freshness: { lastActivityAt: 'not-a-date', now: NOW },
    });
    expect(garbage.idleDays).toBeNull();
    expect(garbage.unmeasured).toContain('freshness');
  });

  it('clamps a future timestamp to zero rather than reporting negative idle days', () => {
    const d = derivePlanLifecycle(live, { freshness: fresh(-5) });
    expect(d.idleDays).toBe(0);
    expect(d.verdict).toBe('active');
  });
});

describe('reconcilePlanLifecycle — jurisdiction', () => {
  const drained = derivePlanLifecycle([item('P-001', 'done'), item('P-002', 'done')], {
    acceptance: { rubricActive: false },
  });
  const liveGraph = derivePlanLifecycle([item('P-001', 'todo')], { freshness: fresh(1) });

  it('contradicts a live status over a drained graph — the headline drift class', () => {
    const r = reconcilePlanLifecycle('active', drained);
    expect(r.disposition).toBe('contradicted');
    expect(r.contradiction?.evidence).toMatch(/every one of 2 items is terminal/i);
  });

  it('CONTROL: the same live status over a live graph agrees', () => {
    expect(reconcilePlanLifecycle('active', liveGraph).disposition).toBe('agreed');
  });

  it('does NOT claim a drained plan is finished — only that the status is stale', () => {
    // The distinction this whole plan exists to protect: all-items-terminal is
    // evidence about implementation, never about acceptance.
    const r = reconcilePlanLifecycle('draft', drained);
    expect(r.contradiction?.evidence).toMatch(/NOT a claim/);
    expect(r.contradiction?.evidence).toMatch(/independent\s+acceptance grading/i);
  });

  it('contradicts shipped over a live graph', () => {
    const r = reconcilePlanLifecycle('shipped', liveGraph);
    expect(r.disposition).toBe('contradicted');
    expect(r.contradiction?.evidence).toContain('P-001');
  });

  it('CONTROL: shipped over a drained graph agrees', () => {
    expect(reconcilePlanLifecycle('shipped', drained).disposition).toBe('agreed');
  });

  it('NEVER contradicts superseded, whose whole meaning is abandonment mid-flight', () => {
    // The paired case above proves the live-graph branch fires for `shipped`,
    // so this passing is a real exemption rather than a dead branch.
    expect(reconcilePlanLifecycle('superseded', liveGraph).disposition).toBe('agreed');
    expect(reconcilePlanLifecycle('superseded', drained).disposition).toBe('agreed');
  });

  it('abstains on an itemless plan rather than judging its label', () => {
    const none = derivePlanLifecycle([]);
    expect(reconcilePlanLifecycle('active', none).disposition).toBe('abstained');
    expect(reconcilePlanLifecycle('shipped', none).disposition).toBe('abstained');
  });

  it('reports an unknown label as unrecognized rather than guessing', () => {
    const r = reconcilePlanLifecycle('in-review', drained);
    expect(r.disposition).toBe('unrecognized');
    expect(r.contradiction).toBeNull();
  });

  it('treats a missing status as unrecognized, not as draft', () => {
    expect(reconcilePlanLifecycle(null, drained).disposition).toBe('unrecognized');
    expect(reconcilePlanLifecycle('   ', drained).disposition).toBe('unrecognized');
  });

  it('staleness is NOT a contradiction — it rides on the verdict, not the disposition', () => {
    // Overloading one field with two independent judgments is how a reader
    // loses the ability to act on either.
    const stale = derivePlanLifecycle([item('P-001', 'todo')], { freshness: fresh(400) });
    const r = reconcilePlanLifecycle('active', stale);
    expect(r.disposition).toBe('agreed');
    expect(r.derived.verdict).toBe('stalled');
  });

  it('carries the derivation on EVERY disposition, including the pass-throughs', () => {
    // A reader must always be able to see what was checked, rather than trust
    // that a pass-through was checked at all.
    for (const status of ['active', 'shipped', 'superseded', 'in-review', null]) {
      expect(reconcilePlanLifecycle(status, drained).derived.verdict).toBe(
        'implementation-complete',
      );
    }
  });
});
