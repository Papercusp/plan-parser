/**
 * lifecycle — DERIVE "where is this plan actually up to?" from the item graph,
 * instead of reading the hand-asserted `status` label.
 *
 * # Why this is derived and not stored
 *
 * `status` (draft / ready / active / shipped / superseded) is written ONCE, by
 * hand, and nothing recomputes it when the plan's items go terminal. It is the
 * same defect class P-002 removed from the `## Now` next-pointer, one level up:
 * a second copy of a fact the item graph already owns, believed precisely
 * because it is authoritative-looking and was correct when it was typed.
 *
 * The consequence is named in this repo's own agent guide: *"ALL ITEMS TERMINAL
 * IS NOT A FINISHED PLAN, AND `plans:items` CANNOT TELL YOU IT ISN'T"* — and
 * the mirror-image error is just as common, a plan sitting in `active` with
 * every item done, read as live work by every reader who trusts the label.
 *
 * Computing the verdict at READ time is rung 1 of the derived-truth ladder: it
 * cannot drift, it has no failure window, and it removes the second copy rather
 * than policing it on a schedule.
 *
 * # What this module is, and is not
 *
 * It answers TWO questions from evidence, and refuses to answer a third.
 *
 *   · **Implementation** — is there live work left? That is pure graph, and it
 *     is answered unconditionally.
 *   · **Momentum** — has anything moved lately? That needs a clock and an
 *     activity timestamp, both INJECTED, so this stays pure.
 *   · **Acceptance** — has the plan actually been VALIDATED? Deliberately NOT
 *     answered. That verdict belongs to the acceptance gate, which runs five
 *     check families across several tables and is expensive by design; a cheap
 *     second opinion here would be a competing definition of "may this ship",
 *     which is exactly the drift this plan exists to remove. All this module
 *     accepts is the cheap, indexed fact of whether the acceptance path has
 *     BEGUN — and it reports `awaiting-acceptance`, never `accepted`.
 *
 * Every signal is optional, and an ABSENT signal is reported as `unmeasured`
 * rather than defaulted. "Not measured" and "measured false" are different
 * facts: defaulting the first to the second would let a plan whose freshness
 * could not be read present as freshly active.
 *
 * Pure + dependency-free (generic-first): items and signals in, verdict out.
 * No I/O, no `Date.now()` — the caller injects its own clock, so the same
 * inputs always produce the same verdict and a test needs no fake timers.
 */

import { isTerminalPlanStatus, type ItemStatus, type PlanItem } from './parser';
import { resolveEffectiveStatusForItems, type ResolvedItem } from './effective-status';

/**
 * Where the plan actually is, per the evidence.
 *
 * Five values, not a boolean, for the same reason `NextPointerReason` has six:
 * "nothing is left to do because the plan finished" and "nothing is left to do
 * because the plan never had items" are opposite situations, and collapsing
 * them is how an empty plan comes to read as complete.
 */
export type PlanLifecycleVerdict =
  /** The plan has no items; the graph has nothing to say. Callers MUST treat
   *  this as "no verdict" and never as "finished". */
  | 'no-items'
  /** Live items remain, and something moved within the staleness window. */
  | 'active'
  /** Live items remain, but nothing has moved for `stalledAfterDays`. The work
   *  is not finished and nobody is doing it. */
  | 'stalled'
  /** Every item is terminal and the acceptance path has NOT begun (or could
   *  not be measured — read `unmeasured`). Implementation landed; validation
   *  has not started. */
  | 'implementation-complete'
  /** Every item is terminal and an acceptance rubric is active — the remaining
   *  work is grading. Deliberately NOT a claim that it will pass. */
  | 'awaiting-acceptance';

/**
 * The cheap half of the acceptance-gate state: has the acceptance path BEGUN?
 *
 * Nothing here reports whether the plan may ship — see the module header.
 */
export interface PlanAcceptanceSignal {
  /** An acceptance rubric is active/ready for this plan as its subject. */
  rubricActive: boolean;
  /** Which rubric, when one was found. */
  rubricRef?: string | null;
}

/**
 * Activity timestamps, and the clock to measure them against.
 *
 * `lastActivityAt` is the NEWEST instant across whatever sources the caller
 * could actually measure, and `sources` records each one by name — so a reader
 * can see that "12 days idle" rests on a plan write and a work-item transition
 * rather than on one column that might mean something else.
 */
export interface PlanFreshnessSignal {
  /** ISO-8601. `null` ⇒ nothing measurable; the momentum axis abstains. */
  lastActivityAt: string | null;
  /** Per-source attribution, newest-first is not required. */
  sources?: Array<{ source: string; at: string | null }>;
  /** The caller's clock, ISO-8601. Injected so this module stays pure. */
  now: string;
}

export interface PlanLifecycleSignals {
  /** Omit or pass `null` when the acceptance path was not looked up. */
  acceptance?: PlanAcceptanceSignal | null;
  /** Omit or pass `null` when no activity timestamp could be read. */
  freshness?: PlanFreshnessSignal | null;
  /**
   * Idle days past which a plan with live items reads `stalled`.
   *
   * Defaults to {@link DEFAULT_STALLED_AFTER_DAYS}, which is P-003's own
   * number ("a 30-day-cold plan cannot read as live"), not a tuned one.
   */
  stalledAfterDays?: number;
}

/** What the verdict could not see. Never silently omitted — see module header. */
export type PlanLifecycleUnmeasured = 'acceptance' | 'freshness';

export interface DerivedPlanLifecycle {
  verdict: PlanLifecycleVerdict;
  /** One line, ready to render where a bare `status` would have gone. */
  text: string;
  /** Terminal-item census — what makes each verdict a positive answer. */
  counts: {
    total: number;
    done: number;
    dropped: number;
    nonTerminal: number;
    wip: number;
    blocked: number;
    needsHuman: number;
  };
  /** Live items, ranked head-first, bounded — who the remaining work is. */
  liveItems: Array<{ id: string; effectiveStatus: ItemStatus }>;
  liveItemsTruncated: boolean;
  /** Whole days since the newest measured activity; `null` when unmeasured. */
  idleDays: number | null;
  /** The threshold actually applied, so a verdict carries its own yardstick. */
  stalledAfterDays: number;
  /** Signals the caller did not (or could not) supply. */
  unmeasured: PlanLifecycleUnmeasured[];
  acceptance: PlanAcceptanceSignal | null;
  freshness: PlanFreshnessSignal | null;
}

/** P-003's own number: a plan cold for a month must not read as live. */
export const DEFAULT_STALLED_AFTER_DAYS = 30;

/** How many live items travel with the verdict. */
const LIVE_ITEM_CAP = 5;

const MS_PER_DAY = 86_400_000;

function isTerminal(status: ItemStatus): boolean {
  return status === 'done' || status === 'dropped';
}

/**
 * Same needs-human band as the next-pointer: read BOTH the derived boolean and
 * the effective token, because `deriveItemNeedsHuman` is behavior-neutral until
 * the autonomy policy is armed, and until then the stored token is the only
 * signal there is.
 */
function awaitsHuman(item: ResolvedItem): boolean {
  return item.needsHuman || item.effectiveStatus === 'needs-human';
}

/**
 * Whole days between two instants, or `null` if either is unparseable.
 *
 * An unparseable timestamp returns `null` rather than `0`: zero reads as "just
 * touched", which would make a broken clock the strongest possible evidence of
 * freshness.
 */
function idleDaysBetween(lastActivityAt: string | null, now: string): number | null {
  if (!lastActivityAt) return null;
  const then = Date.parse(lastActivityAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(then) || !Number.isFinite(nowMs)) return null;
  // A future timestamp (clock skew, a scheduled-at column) is clamped to 0
  // rather than going negative — "moved recently" is the honest reading.
  return Math.max(0, Math.floor((nowMs - then) / MS_PER_DAY));
}

/**
 * Derive a plan's lifecycle verdict.
 *
 * Precedence is deliberate: the IMPLEMENTATION axis is decided first and from
 * the graph alone, then momentum refines it. A plan whose items are all
 * terminal is never `stalled` however cold it is — "finished and untouched" is
 * not the same condition as "unfinished and abandoned", and reporting the first
 * as the second would send a reader to restart work that is already done.
 */
export function derivePlanLifecycle(
  items: readonly PlanItem[],
  signals: PlanLifecycleSignals = {},
): DerivedPlanLifecycle {
  const stalledAfterDays = signals.stalledAfterDays ?? DEFAULT_STALLED_AFTER_DAYS;
  const acceptance = signals.acceptance ?? null;
  const freshness = signals.freshness ?? null;
  const idleDays = freshness ? idleDaysBetween(freshness.lastActivityAt, freshness.now) : null;

  const unmeasured: PlanLifecycleUnmeasured[] = [];
  if (!acceptance) unmeasured.push('acceptance');
  // A supplied freshness signal that yields no usable age is still unmeasured:
  // the caller looked and found nothing, which for a reader is the same gap.
  if (idleDays === null) unmeasured.push('freshness');

  const counts = {
    total: items.length,
    done: 0,
    dropped: 0,
    nonTerminal: 0,
    wip: 0,
    blocked: 0,
    needsHuman: 0,
  };

  const base = {
    counts,
    liveItems: [] as Array<{ id: string; effectiveStatus: ItemStatus }>,
    liveItemsTruncated: false,
    idleDays,
    stalledAfterDays,
    unmeasured,
    acceptance,
    freshness,
  };

  if (items.length === 0) {
    return {
      ...base,
      verdict: 'no-items',
      text:
        'no verdict — this plan has no items, so its lifecycle cannot be derived from the graph. ' +
        'An itemless plan is not a finished one.',
    };
  }

  const resolved = resolveEffectiveStatusForItems([...items]);
  const live: ResolvedItem[] = [];
  for (const item of resolved.items) {
    if (item.effectiveStatus === 'done') counts.done += 1;
    else if (item.effectiveStatus === 'dropped') counts.dropped += 1;
    else {
      counts.nonTerminal += 1;
      if (item.effectiveStatus === 'wip') counts.wip += 1;
      if (awaitsHuman(item)) counts.needsHuman += 1;
      else if (item.unresolvedBlockers.length > 0) counts.blocked += 1;
      live.push(item);
    }
  }

  base.liveItems = live
    .slice(0, LIVE_ITEM_CAP)
    .map((it) => ({ id: it.id, effectiveStatus: it.effectiveStatus }));
  base.liveItemsTruncated = live.length > LIVE_ITEM_CAP;

  if (live.length === 0) {
    const terminalCensus = `${counts.done} done, ${counts.dropped} dropped`;
    if (acceptance?.rubricActive) {
      return {
        ...base,
        verdict: 'awaiting-acceptance',
        text:
          `every item is terminal (${terminalCensus}) and an acceptance rubric is active` +
          `${acceptance.rubricRef ? ` (${acceptance.rubricRef})` : ''} — the remaining work is ` +
          'independent grading, not implementation. This is not a claim that it will pass.',
      };
    }
    return {
      ...base,
      verdict: 'implementation-complete',
      text:
        `every item is terminal (${terminalCensus}), and ` +
        (acceptance
          ? 'no acceptance rubric is active — the validation path has not begun. '
          : 'the acceptance path was not measured on this read. ') +
        'Implementation landing is not the same as a finished plan.',
    };
  }

  const remaining =
    `${counts.nonTerminal} of ${counts.total} items are still live ` +
    `(${counts.wip} wip, ${counts.blocked} blocked, ${counts.needsHuman} needs-human)`;

  if (idleDays !== null && idleDays >= stalledAfterDays) {
    return {
      ...base,
      verdict: 'stalled',
      text:
        `${remaining}, and nothing has moved for ${idleDays} days ` +
        `(threshold ${stalledAfterDays}). The work is unfinished and nobody is doing it.`,
    };
  }

  return {
    ...base,
    verdict: 'active',
    text:
      `${remaining}` +
      (idleDays === null
        ? ', and no activity timestamp was measurable on this read.'
        : `, last activity ${idleDays} days ago.`),
  };
}

/**
 * What the derivation has to say about the plan's STORED status.
 *
 * Four values rather than a boolean, for P-002's reason: "the graph agrees",
 * "the graph has nothing to say", and "this label is not one we know" are three
 * different reasons a stored status survives a read, and flattening them would
 * let an unchecked pass-through read as a ratified one.
 */
export type PlanLifecycleDisposition =
  /** The graph is silent (no items); the stored label stands unexamined. */
  | 'abstained'
  /** The stored label is consistent with what the graph shows. */
  | 'agreed'
  /** The stored label claims something the graph refutes. */
  | 'contradicted'
  /** The stored label is not in the known status vocabulary. */
  | 'unrecognized';

export interface PlanLifecycleReconciliation {
  storedStatus: string | null;
  disposition: PlanLifecycleDisposition;
  /** Set only on `contradicted`: the claim, and the evidence against it. */
  contradiction: { claim: string; evidence: string } | null;
  /** The graph's own verdict, attached on EVERY disposition — a reader can
   *  always see what was checked rather than trusting that it was. */
  derived: DerivedPlanLifecycle;
}

/**
 * Reconcile a plan's stored `status` against the derived lifecycle.
 *
 * # Jurisdiction (narrow on purpose — the sibling of D-003)
 *
 * The graph contradicts the label in exactly TWO cases, both of which are
 * statements about ITEMS, which is the only thing the graph can see:
 *
 *   1. **A live status over a drained graph** — `draft`/`ready`/`active` while
 *      every item is terminal. This is the headline drift class, and the one a
 *      reader most often mistakes for live work.
 *   2. **`shipped` over a live graph** — the ship gate refuses a plan with a
 *      `todo`/`blocked`/`needs-human` item, so a shipped plan with live items
 *      means the graph moved after the ship (or the gate was forced past).
 *
 * Everything else is left alone. In particular `superseded` is NEVER
 * contradicted: a superseded plan is deliberately abandoned mid-flight, so live
 * items are its normal, correct shape — flagging them would manufacture drift
 * out of the one status whose whole meaning is "we stopped".
 *
 * STALENESS IS NOT A CONTRADICTION and is deliberately not folded in here. A
 * cold `active` plan is a real problem, but it is a different axis with a
 * different remedy, and overloading one field with two independent judgments is
 * how a reader loses the ability to act on either. It rides on
 * `derived.verdict` / `derived.idleDays` instead, where it can be read on its
 * own terms.
 *
 * Pure. Never mutates, never writes, and — like every derivation in this
 * module — reports rather than repairs.
 */
export function reconcilePlanLifecycle(
  storedStatus: string | null | undefined,
  derived: DerivedPlanLifecycle,
): PlanLifecycleReconciliation {
  const stored = (storedStatus ?? '').trim() || null;
  const base = { storedStatus: stored, derived, contradiction: null };

  if (derived.verdict === 'no-items') return { ...base, disposition: 'abstained' };

  const known =
    stored === 'draft' ||
    stored === 'ready' ||
    stored === 'active' ||
    isTerminalPlanStatus(stored);
  if (!known) return { ...base, disposition: 'unrecognized' };

  const drained = derived.counts.nonTerminal === 0;

  if (stored === 'shipped' && !drained) {
    return {
      ...base,
      disposition: 'contradicted',
      contradiction: {
        claim: 'status: shipped — the plan is finished and validated',
        evidence:
          `${derived.counts.nonTerminal} of ${derived.counts.total} items are still live ` +
          `(${derived.liveItems.map((it) => `${it.id} [${it.effectiveStatus}]`).join(', ')}` +
          `${derived.liveItemsTruncated ? ', …' : ''}). The ship gate refuses live items, so ` +
          'either the graph moved after the ship or the gate was forced past.',
      },
    };
  }

  if ((stored === 'draft' || stored === 'ready' || stored === 'active') && drained) {
    return {
      ...base,
      disposition: 'contradicted',
      contradiction: {
        claim: `status: ${stored} — there is live work here`,
        evidence:
          `every one of ${derived.counts.total} items is terminal ` +
          `(${derived.counts.done} done, ${derived.counts.dropped} dropped). ` +
          'Implementation landed; the status was never updated. Note this is NOT a claim ' +
          'that the plan is finished — shipping needs a code-truth audit and independent ' +
          'acceptance grading that no item status can evidence.',
      },
    };
  }

  return { ...base, disposition: 'agreed' };
}
