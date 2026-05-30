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

export interface ResolvedItem extends PlanItem {
  effectiveStatus: ItemStatus;
  unresolvedBlockers: string[];
}

export interface ResolveResult {
  items: ResolvedItem[];
  missingRefs: Array<{ itemId: string; ref: string }>;
  cycleMembers: string[];
}

export function resolveEffectiveStatus(plan: ParsedPlan): ResolveResult {
  const byId = new Map(plan.items.map((it) => [it.id, it]));
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

  for (const it of plan.items) visit(it.id, new Set());
  cycleMembers.push(...inCycle);

  const items: ResolvedItem[] = plan.items.map((it) => {
    if (inCycle.has(it.id)) {
      return { ...it, effectiveStatus: 'blocked', unresolvedBlockers: it.blockedBy };
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
      return { ...it, effectiveStatus: 'blocked', unresolvedBlockers: unresolved };
    }

    if (unresolved.length > 0) {
      return { ...it, effectiveStatus: 'blocked', unresolvedBlockers: unresolved };
    }

    return { ...it, effectiveStatus: it.storedStatus, unresolvedBlockers: [] };
  });

  return { items, missingRefs, cycleMembers };
}
