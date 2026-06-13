/**
 * risk-model.test.ts — the autonomy risk model (queen-autonomy-policy-2026-06-13
 * Brief B-01 / P-010 · P-011 · P-014).
 *
 * Pins: the graded risk_tier vocabulary + ranks; the authority axis; the pure
 * `deriveNeedsHuman` gate (including its BEHAVIOR-NEUTRAL default, D-007, and the
 * authority=owner override, P-011); the parser carrying `risk:`/`authority:`
 * keywords glyph-agnostically; the risk_tier ⊥ importance separation (P-014); and
 * the render round-trip.
 */
import { describe, expect, it } from 'vitest';
import {
  RISK_TIERS,
  AUTHORITY_LEVELS,
  AUTONOMY_CEILINGS,
  DEFAULT_AUTHORITY,
  riskTierRank,
  compareRiskTier,
  riskTierAtOrAbove,
  deriveNeedsHuman,
  type RiskTier,
} from './risk-model';
import { parsePlan } from './parser';
import { renderPlanMarkdown } from './renderer';

const lines = (...l: string[]) => l.join('\n');

const PLAN = (...itemLines: string[]) =>
  lines(
    '---',
    'title: Risk Plan',
    'slug: risk-plan',
    'status: active',
    '---',
    '',
    '## Now',
    '**State:** building',
    '**Next:** ship it',
    '',
    '## Phase 1 — Build',
    ...itemLines,
  );

describe('risk_tier vocabulary + ranks', () => {
  it('is the graded scale trivial → critical, ascending', () => {
    expect(RISK_TIERS).toEqual(['trivial', 'low', 'moderate', 'high', 'critical']);
  });

  it('riskTierRank is the ascending index (trivial=0 … critical=4)', () => {
    expect(riskTierRank('trivial')).toBe(0);
    expect(riskTierRank('critical')).toBe(4);
    expect(RISK_TIERS.every((t, i) => riskTierRank(t) === i)).toBe(true);
  });

  it('compareRiskTier orders by risk', () => {
    expect(compareRiskTier('low', 'high')).toBeLessThan(0);
    expect(compareRiskTier('high', 'low')).toBeGreaterThan(0);
    expect(compareRiskTier('moderate', 'moderate')).toBe(0);
  });

  it('riskTierAtOrAbove is an inclusive floor', () => {
    expect(riskTierAtOrAbove('high', 'moderate')).toBe(true);
    expect(riskTierAtOrAbove('moderate', 'moderate')).toBe(true);
    expect(riskTierAtOrAbove('low', 'moderate')).toBe(false);
  });

  it('authority levels are system | owner, default system; ceilings prepend never-auto', () => {
    expect(AUTHORITY_LEVELS).toEqual(['system', 'owner']);
    expect(DEFAULT_AUTHORITY).toBe('system');
    expect(AUTONOMY_CEILINGS).toEqual(['never-auto', 'trivial', 'low', 'moderate', 'high', 'critical']);
  });
});

describe('deriveNeedsHuman — the gate (D-004)', () => {
  it('BEHAVIOR-NEUTRAL by default (D-007): unarmed ⇒ exactly the stored token', () => {
    // The whole point of the migration: with nothing armed, the derived value IS
    // the legacy needs-human token, so behavior is identical to today.
    expect(deriveNeedsHuman({ storedNeedsHuman: true })).toBe(true);
    expect(deriveNeedsHuman({ storedNeedsHuman: false })).toBe(false);
    expect(deriveNeedsHuman({})).toBe(false); // no token ⇒ not needs-human
    // risk_tier present but unarmed must NOT change the answer (no premature gating).
    expect(deriveNeedsHuman({ riskTier: 'critical', storedNeedsHuman: false })).toBe(false);
    expect(deriveNeedsHuman({ riskTier: 'trivial', storedNeedsHuman: true })).toBe(true);
  });

  it('authority=owner ALWAYS gates (P-011), armed or not, regardless of risk', () => {
    expect(deriveNeedsHuman({ authority: 'owner', storedNeedsHuman: false })).toBe(true);
    expect(
      deriveNeedsHuman({ authority: 'owner', armed: true, ceiling: 'critical', riskTier: 'trivial' }),
    ).toBe(true);
  });

  it('armed: never-auto ceiling ⇒ never auto (locked-at-zero / protected, D-005)', () => {
    expect(deriveNeedsHuman({ armed: true, ceiling: 'never-auto', riskTier: 'trivial' })).toBe(true);
    expect(deriveNeedsHuman({ armed: true, ceiling: 'never-auto' })).toBe(true);
    // default ceiling is never-auto.
    expect(deriveNeedsHuman({ armed: true, riskTier: 'trivial' })).toBe(true);
  });

  it('armed: auto when risk_tier ≤ ceiling, needs-human when above', () => {
    expect(deriveNeedsHuman({ armed: true, ceiling: 'moderate', riskTier: 'low' })).toBe(false);
    expect(deriveNeedsHuman({ armed: true, ceiling: 'moderate', riskTier: 'moderate' })).toBe(false);
    expect(deriveNeedsHuman({ armed: true, ceiling: 'moderate', riskTier: 'high' })).toBe(true);
  });

  it('armed: unknown risk fails safe to needs-human (D-002)', () => {
    expect(deriveNeedsHuman({ armed: true, ceiling: 'high', riskTier: null })).toBe(true);
    expect(deriveNeedsHuman({ armed: true, ceiling: 'high' })).toBe(true);
  });
});

describe('parser — risk: / authority: keywords (P-010 / P-011)', () => {
  it('parses risk + authority glyph-agnostically and strips them from the text', () => {
    const p = parsePlan(PLAN('- **P-001** `todo` do the thing risk: high authority: owner'));
    const it0 = p.items[0]!;
    expect(it0.riskTier).toBe('high');
    expect(it0.authority).toBe('owner');
    expect(it0.text).toBe('do the thing');
  });

  it('defaults: no risk: ⇒ riskTier null; no authority: ⇒ system', () => {
    const p = parsePlan(PLAN('- **P-002** `todo` plain item'));
    const it0 = p.items[0]!;
    expect(it0.riskTier ?? null).toBeNull();
    expect(it0.authority).toBe('system');
  });

  it('unknown risk / authority values degrade to default without a warning', () => {
    const p = parsePlan(PLAN('- **P-003** `todo` weird risk: spicy authority: dictator'));
    const it0 = p.items[0]!;
    expect(it0.riskTier ?? null).toBeNull();
    expect(it0.authority).toBe('system');
    expect(p.parseWarnings).toEqual([]);
  });
});

describe('P-014 — risk_tier is DISTINCT from importance', () => {
  it('an item can carry independent importance and risk values', () => {
    // The ranker consumes importance; the autonomy gate consumes risk. They are
    // separate axes — set them to deliberately different bands and assert both.
    const p = parsePlan(PLAN('- **P-001** `todo` ship it importance: high risk: trivial'));
    const it0 = p.items[0]!;
    expect(it0.importance).toBe('high');
    expect(it0.riskTier).toBe('trivial');
    expect(it0.text).toBe('ship it');
  });

  it('the type carries both fields independently (no coupling)', () => {
    const p = parsePlan(
      PLAN(
        '- **P-001** `todo` low-risk urgent importance: urgent risk: low',
        '- **P-002** `todo` high-risk trivial importance: low risk: critical',
      ),
    );
    expect(p.items[0]!.importance).toBe('urgent');
    expect(p.items[0]!.riskTier).toBe('low');
    expect(p.items[1]!.importance).toBe('low');
    expect(p.items[1]!.riskTier).toBe('critical');
  });
});

describe('render round-trip preserves risk + authority', () => {
  it('parse → render → parse keeps riskTier/authority (and omits defaults)', () => {
    const src = PLAN(
      '- **P-001** `todo` with axes risk: moderate authority: owner importance: high',
      '- **P-002** `todo` defaults only',
    );
    const once = parsePlan(src);
    const twice = parsePlan(renderPlanMarkdown(once));

    expect(twice.items[0]!.riskTier).toBe('moderate');
    expect(twice.items[0]!.authority).toBe('owner');
    expect(twice.items[0]!.importance).toBe('high');
    expect(twice.items[0]!.text).toBe('with axes');

    // Defaults must NOT be emitted, so they re-parse to the same defaults.
    expect(twice.items[1]!.riskTier ?? null).toBeNull();
    expect(twice.items[1]!.authority).toBe('system');
  });

  it('a default item renders without any risk:/authority: keyword', () => {
    const src = PLAN('- **P-001** `todo` nothing special');
    const rendered = renderPlanMarkdown(parsePlan(src));
    expect(rendered).not.toContain('risk:');
    expect(rendered).not.toContain('authority:');
  });
});

// Type-level guard: AutonomyCeiling members line up with the tiers (compile-time).
const _ceilingCovers: Record<RiskTier, true> = {
  trivial: true,
  low: true,
  moderate: true,
  high: true,
  critical: true,
};
void _ceilingCovers;
