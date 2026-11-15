import { describe, expect, it } from 'vitest';
import {
  dependencyEvidenceIdentity,
  dependencyEvidenceScopeErrors,
  extractDependencyEvidence,
  validateDependencyEvidence,
  type DependencyEvidenceAlternative,
} from './dependency-evidence';

const edge = (): DependencyEvidenceAlternative => ({
  schemaVersion: 1, workspaceId: 'workspace', harnessSlug: 'harness', planSlug: 'example',
  dependentItemId: 'P-002', blockerItemId: 'P-001', producerWorkItemId: 'WI-123',
  selectedBuild: { repositoryRoot: '/repo', commit: 'b'.repeat(40), checkRef: 'tests:contract',
    recipeRef: 'recipe:v1', configurationFingerprint: 'c'.repeat(64) },
  clauses: [{ specId: 'CONTRACT', revision: 2, contentHash: 'a'.repeat(64), bindingIds: ['123', '124'] }],
});

describe('dependency evidence selectors', () => {
  it('accepts a complete exact declaration and snapshots the input', () => {
    const input = [edge()];
    const result = validateDependencyEvidence(input);
    expect(result.errors).toEqual([]);
    expect(result.alternatives).toEqual(input);
    input[0]!.clauses[0]!.bindingIds.push('125');
    expect(result.alternatives[0]!.clauses[0]!.bindingIds).toEqual(['123', '124']);
    expect(result.alternatives[0]).not.toHaveProperty('ready');
  });

  it.each([
    ['empty alternatives', []],
    ['oversized edge cohort', Array.from({ length: 41 }, edge)],
    ['unknown schema', [{ ...edge(), schemaVersion: 2 }]],
    ['unknown field', [{ ...edge(), ready: true }]],
    ['duplicate edge', [edge(), edge()]],
    ['no clauses', [{ ...edge(), clauses: [] }]],
    ['duplicate clause', [{ ...edge(), clauses: [edge().clauses[0], edge().clauses[0]] }]],
    ['no bindings', [{ ...edge(), clauses: [{ ...edge().clauses[0], bindingIds: [] }] }]],
    ['duplicate binding', [{ ...edge(), clauses: [{ ...edge().clauses[0], bindingIds: ['123', '123'] }] }]],
    ['bad hash', [{ ...edge(), clauses: [{ ...edge().clauses[0], contentHash: 'current' }] }]],
    ['bad revision', [{ ...edge(), clauses: [{ ...edge().clauses[0], revision: 0 }] }]],
    ['missing producer', [{ ...edge(), producerWorkItemId: '' }]],
    ['missing build', [{ ...edge(), selectedBuild: undefined }]],
    ['historical short commit', [{ ...edge(), selectedBuild: { ...edge().selectedBuild, commit: 'abc123' } }]],
    ['relative root', [{ ...edge(), selectedBuild: { ...edge().selectedBuild, repositoryRoot: 'repo' } }]],
    ['missing configuration', [{ ...edge(), selectedBuild: { ...edge().selectedBuild, configurationFingerprint: '' } }]],
    ['unknown build selector', [{ ...edge(), selectedBuild: { ...edge().selectedBuild, latest: true } }]],
    ['unbounded bindings', [{ ...edge(), clauses: [{ ...edge().clauses[0],
      bindingIds: Array.from({ length: 129 }, (_, i) => String(i)) }] }]],
  ])('refuses %s without retaining any partial selector', (_name, value) => {
    const result = validateDependencyEvidence(value);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.alternatives).toEqual([]);
  });

  it('bounds the total binding set across clauses', () => {
    const value = edge();
    value.clauses = Array.from({ length: 2 }, (_, clause) => ({ specId: 'C' + clause,
      revision: 1, contentHash: 'a'.repeat(64),
      bindingIds: Array.from({ length: 65 }, (_, i) => clause + '-' + i) }));
    expect(validateDependencyEvidence([value]).errors).toContain('dependency-evidence[0]: binding cohort exceeds 128');
  });

  it('extracts JSON before other keywords, preserving surrounding metadata', () => {
    const value = edge();
    value.clauses[0]!.specId = 'D-999';
    const result = extractDependencyEvidence('Consumer blocked-by: P-001 dependency-evidence: `' +
      JSON.stringify([value]) + '` importance: high');
    expect(result.errors).toBeUndefined();
    expect(result.alternatives).toEqual([value]);
    expect(result.text).toBe('Consumer blocked-by: P-001  importance: high');
    expect(result.text).not.toContain('D-999');
  });

  it('does not treat a marker inside a JSON string as a second declaration', () => {
    const value = edge();
    value.clauses[0]!.specId = 'dependency-evidence:';
    expect(extractDependencyEvidence('x dependency-evidence: `' +
      JSON.stringify([value]) + '`').errors).toBeUndefined();
  });

  it.each([
    'x dependency-evidence: []',
    'x dependency-evidence: `unterminated',
    'x dependency-evidence: `{invalid}`',
    'x dependency-evidence: `[]`',
    'x dependency-evidence: `' + JSON.stringify([edge()]) + '` dependency-evidence: `[]`',
    'x dependency-evidence: `' + ' '.repeat(65537) + '`',
  ])('reports malformed or repeated marker %#', text => {
    expect(extractDependencyEvidence(text).errors!.length).toBeGreaterThan(0);
    expect(extractDependencyEvidence(text).alternatives).toBeUndefined();
  });

  it('validates the exact structural edge and plan scope', () => {
    const item = { id: 'P-002', blockedBy: ['P-001'] };
    expect(dependencyEvidenceScopeErrors([edge()], item, 'example', new Set(['P-001', 'P-002']))).toEqual([]);
    for (const patch of [{ planSlug: 'foreign' }, { dependentItemId: 'P-003' },
      { blockerItemId: 'P-003' }, { blockerItemId: 'P-002' }]) {
      expect(dependencyEvidenceScopeErrors([{ ...edge(), ...patch }], item, 'example').length).toBeGreaterThan(0);
    }
    expect(dependencyEvidenceScopeErrors([edge()], item, 'example', new Set(['P-002'])))
      .toContain('dependency-evidence blocker endpoint is missing');
  });

  it('compares sets deterministically and fences build, scope and revision changes', () => {
    const a = edge();
    const b = edge();
    b.clauses[0]!.bindingIds.reverse();
    expect(dependencyEvidenceIdentity(a)).toBe(dependencyEvidenceIdentity(b));
    for (const changed of [
      { ...b, workspaceId: 'foreign' },
      { ...b, selectedBuild: { ...b.selectedBuild, commit: 'd'.repeat(40) } },
      { ...b, selectedBuild: { ...b.selectedBuild, configurationFingerprint: 'd'.repeat(64) } },
      { ...b, clauses: [{ ...b.clauses[0]!, revision: 3 }] },
    ]) expect(dependencyEvidenceIdentity(a)).not.toBe(dependencyEvidenceIdentity(changed));
  });

  it('leaves legacy item prose untouched when no marker exists', () => {
    expect(extractDependencyEvidence('Legacy blocked-by: P-001')).toEqual({ text: 'Legacy blocked-by: P-001' });
  });
});
