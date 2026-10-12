/**
 * plan-status-summary — a plan's current status, DERIVED from its item graph at
 * read time instead of read from hand-written `## Now` prose.
 *
 * # Why
 *
 * A plan's `## Now` block is a hand-maintained second copy of facts the item
 * graph already owns: which items are live, which are blocked and on what, what
 * is next. Nothing recomputes the prose when an item flips terminal, so it goes
 * stale silently and is believed because it is specific
 * (derived-status-not-hand-written-2026-10-12). `deriveNextPointer` already
 * removed ONE such copy (the `next:` line). This module derives the rest of the
 * status a reader needs, from the same resolution, so no status fact has to be
 * written by hand.
 *
 * # What it composes (and does not duplicate)
 *
 * - Effective status comes from `resolveEffectiveStatusForItems` — the same
 *   blocked-by resolution `plans:items` and the next-pointer use.
 * - Ordering comes from `rankItemsForPickup` — the next-pointer's ranking — so
 *   `actionable[0]` and `next.itemId` can never disagree about what is first.
 * - The plan lifecycle verdict and last-activity time are computed by the
 *   operator (`derivePlanLifecycleForRead`, which needs I/O); a caller passes
 *   them in and they are carried through unchanged, never recomputed here.
 * - Holders (who has claimed an item's linked work item) are I/O too; a caller
 *   passes them in.
 *
 * Pure + dependency-free (generic-first): items in, summary out. No I/O, no
 * clock. Every list is bounded, and every bound reports itself, so a capped
 * list is never read as the whole population.
 */

import { ITEM_STATUSES, type Importance, type ItemStatus, type PlanDecision, type PlanItem } from './parser';
import { resolveEffectiveStatusForItems, type ResolvedItem } from './effective-status';
import {
  deriveNextPointer,
  itemAwaitsHuman,
  rankItemsForPickup,
  type NextPointerReason,
} from './next-pointer';

/** Who currently holds an item's linked work item. Supplied by the I/O layer. */
export interface PlanItemHolder {
  workItemId: string;
  /** The claimant, or null when the linked work item is unclaimed. */
  holder: string | null;
  /** The linked work item's own state, verbatim. */
  state: string | null;
}

export interface PlanStatusSummaryInput {
  items: readonly PlanItem[];
  decisions?: readonly Pick<PlanDecision, 'id' | 'title' | 'date'>[];
  /** itemId → linked work items. Omit when not measured; the summary then reports `holdersMeasured: false`. */
  holders?: Readonly<Record<string, readonly PlanItemHolder[]>>;
  /** Carried through verbatim from the operator's lifecycle derivation. */
  lifecycle?: { verdict: string; lastActivityAt: string | null } | null;
  /** Cap on each list. Default 50. */
  listCap?: number;
}

export interface SummaryItem {
  id: string;
  effectiveStatus: ItemStatus;
  importance: Importance;
  phase: string | null;
  /** Holders of the linked work item(s) that are claimed; empty when none are, or when not measured. */
  heldBy: string[];
}

export interface SummaryBlockedItem extends SummaryItem {
  /** Unresolved in-plan blockers. Empty with `external: true` means the item is stored `blocked` with no in-plan cause. */
  blockedOn: string[];
  external: boolean;
}

export interface PlanStatusSummary {
  /** Item counts by EFFECTIVE status (blocked-by resolution applied), plus totals. */
  counts: Record<ItemStatus, number> & { total: number; terminal: number; nonTerminal: number };
  /** Items that can be picked up now (effective `todo`, not awaiting a human), in pickup order. */
  actionable: SummaryItem[];
  inFlight: SummaryItem[];
  blocked: SummaryBlockedItem[];
  awaitingHuman: SummaryItem[];
  /** True for each list that was cut at `listCap`. */
  truncated: { actionable: boolean; inFlight: boolean; blocked: boolean; awaitingHuman: boolean };
  next: { itemId: string | null; reason: NextPointerReason; text: string };
  latestDecision: { id: string; title: string; date: string | null } | null;
  lifecycle: { verdict: string; lastActivityAt: string | null } | null;
  holdersMeasured: boolean;
  /** One line, ready to render where a hand-written status line would have gone. */
  text: string;
}

const DEFAULT_LIST_CAP = 50;

function decisionNumber(id: string): number {
  const m = /^D-(\d+)$/.exec(id);
  return m ? Number(m[1]) : -1;
}

/**
 * The latest decision is the highest-numbered `D-NNN`. Decision ids are
 * allocated monotonically by `plans:add-decision`, so the number orders them
 * without trusting the optional `date` field; document order breaks a tie
 * (later wins) for ids that do not follow the `D-NNN` form.
 */
function latestDecision(
  decisions: readonly Pick<PlanDecision, 'id' | 'title' | 'date'>[] | undefined,
): PlanStatusSummary['latestDecision'] {
  if (!decisions || decisions.length === 0) return null;
  let best = decisions[0]!;
  for (const d of decisions) {
    if (decisionNumber(d.id) >= decisionNumber(best.id)) best = d;
  }
  return { id: best.id, title: best.title, date: best.date ?? null };
}

export function summarizePlanStatus(input: PlanStatusSummaryInput): PlanStatusSummary {
  const cap = Math.max(1, input.listCap ?? DEFAULT_LIST_CAP);
  const resolved = resolveEffectiveStatusForItems([...input.items]).items;

  const counts = Object.fromEntries(ITEM_STATUSES.map((s) => [s, 0])) as Record<ItemStatus, number>;
  for (const it of resolved) counts[it.effectiveStatus] += 1;
  const terminal = counts.done + counts.dropped;

  const heldBy = (id: string): string[] => {
    const links = input.holders?.[id] ?? [];
    return [...new Set(links.map((l) => l.holder).filter((h): h is string => typeof h === 'string' && h.length > 0))];
  };
  const toSummary = (it: ResolvedItem): SummaryItem => ({
    id: it.id,
    effectiveStatus: it.effectiveStatus,
    importance: it.importance,
    phase: it.phase,
    heldBy: heldBy(it.id),
  });

  const ranked = rankItemsForPickup(resolved);
  const actionableAll = ranked.filter((it) => it.effectiveStatus === 'todo' && !itemAwaitsHuman(it));
  const inFlightAll = ranked.filter((it) => it.effectiveStatus === 'wip');
  const awaitingAll = ranked.filter(
    (it) => it.effectiveStatus !== 'done' && it.effectiveStatus !== 'dropped' && it.effectiveStatus !== 'wip' && itemAwaitsHuman(it),
  );
  const blockedAll = ranked.filter((it) => it.effectiveStatus === 'blocked' && !itemAwaitsHuman(it));

  const pointer = deriveNextPointer(input.items);
  const decision = latestDecision(input.decisions);
  const lifecycle = input.lifecycle ?? null;

  const parts = [
    `${actionableAll.length} actionable${pointer.itemId && pointer.reason === 'actionable' ? ` (next: ${pointer.itemId})` : ''}`,
    `${inFlightAll.length} in flight`,
    `${blockedAll.length} blocked`,
    `${awaitingAll.length} awaiting a human`,
  ];
  const text =
    resolved.length === 0
      ? 'No items — no status can be derived from this plan’s graph.'
      : `${parts.join(', ')}; ${terminal} of ${resolved.length} terminal` +
        (lifecycle ? `; lifecycle ${lifecycle.verdict}` : '') +
        (decision ? `; latest decision ${decision.id}` : '') +
        '.';

  return {
    counts: { ...counts, total: resolved.length, terminal, nonTerminal: resolved.length - terminal },
    actionable: actionableAll.slice(0, cap).map(toSummary),
    inFlight: inFlightAll.slice(0, cap).map(toSummary),
    blocked: blockedAll.slice(0, cap).map((it) => ({
      ...toSummary(it),
      blockedOn: [...it.unresolvedBlockers],
      external: it.unresolvedBlockers.length === 0,
    })),
    awaitingHuman: awaitingAll.slice(0, cap).map(toSummary),
    truncated: {
      actionable: actionableAll.length > cap,
      inFlight: inFlightAll.length > cap,
      blocked: blockedAll.length > cap,
      awaitingHuman: awaitingAll.length > cap,
    },
    next: { itemId: pointer.itemId, reason: pointer.reason, text: pointer.text },
    latestDecision: decision,
    lifecycle,
    holdersMeasured: input.holders !== undefined,
    text,
  };
}
