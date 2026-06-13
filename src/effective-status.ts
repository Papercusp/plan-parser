/**
 * effectiveStatus — compute per-item status from storedStatus +
 * blocked-by graph.
 *
 * Per D-005 of agent-plan-tracking-2026-05-20.md: items with
 * `blocked-by: P-NNN` references whose blockers aren't yet *resolved*
 * have *effective* status `blocked`, regardless of what their stored
 * token says. A blocker counts as resolved when its stored status is
 * `done` (it completed) OR `dropped` (it was abandoned and will never
 * complete — keeping the dependent blocked forever would be the stale-
 * `blocked` trap D-005 exists to prevent). plans:lint emits a
 * `blocker_dropped` warning in that case so the dependency still gets
 * re-evaluated. As soon as all blockers resolve, effective reverts to
 * the stored token (typically `todo`).
 *
 * The stored `blocked` token is reserved for **external** blockers
 * (upstream PR, vendor response, awaiting release) — things markdown
 * genuinely can't compute. Stored `blocked` is always effective
 * `blocked`.
 *
 * Cycles: items in a blocked-by cycle resolve to effective `blocked`
 * and are flagged in `cycleMembers`.
 *
 * Missing refs: an item whose `blocked-by` references an unknown ID
 * resolves to effective `blocked` (we can't prove the blocker is done)
 * and is flagged in `missingRefs`.
 */

import type { ItemStatus, PlanItem, ParsedPlan } from './parser';
import { deriveNeedsHuman } from './risk-model';

export interface ResolvedItem extends PlanItem {
  effectiveStatus: ItemStatus;
  unresolvedBlockers: string[];
  /**
   * The DERIVED needs-human verdict (queen-autonomy-policy-2026-06-13 B-12 /
   * P-072): `needs-human` is no longer a stored token but the top band of the
   * risk model (D-001). The orchestrator DONE-gate + `plans:items needsHuman`
   * key on THIS, not on `storedStatus === 'needs-human'`, so the gate stays
   * correct under the new model. BEHAVIOR-NEUTRAL today (D-007): with the policy
   * unarmed `deriveNeedsHuman` returns exactly the stored token (plus the
   * authority=owner override, which no legacy item sets), so the value equals
   * `storedStatus === 'needs-human'` until the owner arms autonomy (P-092).
   */
  needsHuman: boolean;
}

/**
 * The derived needs-human verdict for one plan item (B-12 / P-072) — the pure
 * top-band derivation the DONE-gate keys on. Behavior-neutral by default
 * (`armed` defaults false ⇒ exactly the stored `needs-human` token, plus the
 * authority=owner override). The ARMED, ceiling-aware path (a high-risk item
 * above its category ceiling) flows once a caller supplies `ceiling` + `armed`;
 * plan items carry no tool/category today (work_items.risk_tier deferred, D-015),
 * so the live gate stays on the behavior-neutral path.
 */
export function deriveItemNeedsHuman(
  item: Pick<PlanItem, 'storedStatus' | 'riskTier' | 'authority'>,
  opts: { armed?: boolean; ceiling?: import('./risk-model').AutonomyCeiling | null } = {},
): boolean {
  return deriveNeedsHuman({
    storedNeedsHuman: item.storedStatus === 'needs-human',
    riskTier: item.riskTier ?? null,
    authority: item.authority ?? null,
    ceiling: opts.ceiling ?? null,
    armed: opts.armed ?? false,
  });
}

export interface ResolveResult {
  items: ResolvedItem[];
  missingRefs: Array<{ itemId: string; ref: string }>;
  cycleMembers: string[];
}

export function resolveEffectiveStatus(plan: ParsedPlan): ResolveResult {
  return resolveEffectiveStatusForItems(plan.items);
}

/**
 * Effective-status resolution over a bare item array — the core algorithm
 * (`resolveEffectiveStatus` is the ParsedPlan-shaped wrapper). Lets a caller
 * resolve from the PG-canonical structured `items` index (plans-pg-canonical-
 * migration Stage 3) without re-parsing the content blob. Only `id`,
 * `storedStatus`, and `blockedBy` drive the result; the rest of each PlanItem is
 * carried through to the ResolvedItem unchanged.
 */
export function resolveEffectiveStatusForItems(planItems: PlanItem[]): ResolveResult {
  const byId = new Map(planItems.map((it) => [it.id, it]));
  const missingRefs: Array<{ itemId: string; ref: string }> = [];
  const cycleMembers: string[] = [];

  const colors = new Map<string, 0 | 1 | 2>();
  const inCycle = new Set<string>();

  const visit = (id: string, stack: Set<string>): void => {
    const c = colors.get(id) ?? 0;
    if (c === 2) return;
    if (c === 1) {
      for (const sid of stack) inCycle.add(sid);
      inCycle.add(id);
      return;
    }
    colors.set(id, 1);
    stack.add(id);
    const it = byId.get(id);
    if (it) {
      for (const dep of it.blockedBy) {
        if (!byId.has(dep)) {
          missingRefs.push({ itemId: id, ref: dep });
          continue;
        }
        visit(dep, stack);
      }
    }
    stack.delete(id);
    colors.set(id, 2);
  };

  for (const it of planItems) visit(it.id, new Set());
  cycleMembers.push(...inCycle);

  const items: ResolvedItem[] = planItems.map((it) => {
    // The derived needs-human top band (B-12 / P-072) is computed from the item's
    // own risk axes, INDEPENDENT of the blocked-by graph (an item awaiting a human
    // decision still needs that human whether or not it is currently blocked) — so
    // it is the same on every effectiveStatus branch below.
    const needsHuman = deriveItemNeedsHuman(it);

    if (inCycle.has(it.id)) {
      return { ...it, effectiveStatus: 'blocked', unresolvedBlockers: it.blockedBy, needsHuman };
    }

    const unresolved: string[] = [];
    for (const dep of it.blockedBy) {
      const depItem = byId.get(dep);
      if (!depItem) {
        unresolved.push(dep);
        continue;
      }
      if (depItem.storedStatus !== 'done' && depItem.storedStatus !== 'dropped') {
        unresolved.push(dep);
      }
    }

    if (it.storedStatus === 'blocked') {
      return { ...it, effectiveStatus: 'blocked', unresolvedBlockers: unresolved, needsHuman };
    }

    if (unresolved.length > 0) {
      return { ...it, effectiveStatus: 'blocked', unresolvedBlockers: unresolved, needsHuman };
    }

    return { ...it, effectiveStatus: it.storedStatus, unresolvedBlockers: [], needsHuman };
  });

  return { items, missingRefs, cycleMembers };
}
