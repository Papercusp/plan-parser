/**
 * Immutable proof selectors on an existing blocked-by edge.
 * This module parses declarations only. It performs no I/O and grants no readiness.
 */
export interface DependencyEvidenceClause {
  specId: string;
  revision: number;
  contentHash: string;
  bindingIds: string[];
}

export interface DependencyEvidenceBuild {
  repositoryRoot: string;
  commit: string;
  checkRef: string;
  recipeRef: string;
  configurationFingerprint: string;
}

export interface DependencyEvidenceAlternative {
  schemaVersion: 1;
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  dependentItemId: string;
  blockerItemId: string;
  producerWorkItemId: string;
  selectedBuild: DependencyEvidenceBuild;
  clauses: DependencyEvidenceClause[];
}

export const DEPENDENCY_EVIDENCE_LIMITS = { edges: 40, clauses: 32, bindings: 128, chars: 65536 } as const;
const ITEM_ID = /^P-\d{3,}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const WORK_ITEM_ID = /^(?:WI|EI)-[A-Za-z0-9._-]+$/;
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MARKER = /(?<![\w-])dependency-evidence\s*:/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function token(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

/** Strict also for structured-index readers: never cast untrusted stored JSON. */
export function validateDependencyEvidence(value: unknown): {
  alternatives: DependencyEvidenceAlternative[];
  errors: string[];
} {
  const errors: string[] = [];
  if (!Array.isArray(value) || value.length === 0 || value.length > DEPENDENCY_EVIDENCE_LIMITS.edges) {
    return { alternatives: [], errors: ['dependency-evidence requires 1..40 edge alternatives'] };
  }
  const edges = new Set<string>();
  for (const [i, edge] of value.entries()) {
    const at = `dependency-evidence[${i}]`;
    if (!record(edge) || !exactKeys(edge, ['schemaVersion', 'workspaceId', 'harnessSlug', 'planSlug',
      'dependentItemId', 'blockerItemId', 'producerWorkItemId', 'selectedBuild', 'clauses'])) {
      errors.push(`${at}: exact schema fields required`);
      continue;
    }
    if (edge.schemaVersion !== 1) errors.push(`${at}: unsupported schemaVersion`);
    for (const key of ['workspaceId', 'harnessSlug', 'planSlug'] as const) {
      if (!token(edge[key])) errors.push(`${at}: invalid ${key}`);
    }
    for (const key of ['dependentItemId', 'blockerItemId'] as const) {
      if (typeof edge[key] !== 'string' || !ITEM_ID.test(edge[key])) errors.push(`${at}: invalid ${key}`);
    }
    if (typeof edge.producerWorkItemId !== 'string' || !WORK_ITEM_ID.test(edge.producerWorkItemId)) {
      errors.push(`${at}: original producer work-item required`);
    }
    const key = JSON.stringify([edge.workspaceId, edge.harnessSlug, edge.planSlug,
      edge.dependentItemId, edge.blockerItemId]);
    if (edges.has(key)) errors.push(`${at}: duplicate/conflicting alternative`);
    edges.add(key);
    const build = edge.selectedBuild;
    if (!record(build) || !exactKeys(build,
      ['repositoryRoot', 'commit', 'checkRef', 'recipeRef', 'configurationFingerprint'])) {
      errors.push(`${at}: exact selected immutable build required`);
    } else {
      if (typeof build.repositoryRoot !== 'string' || !build.repositoryRoot.startsWith('/') ||
          build.repositoryRoot.length > 4096 || /[\r\n\0`]/.test(build.repositoryRoot)) {
        errors.push(`${at}: absolute committed repository root required`);
      }
      if (typeof build.commit !== 'string' || !COMMIT.test(build.commit)) errors.push(`${at}: full immutable commit required`);
      for (const field of ['checkRef', 'recipeRef', 'configurationFingerprint'] as const) {
        if (!token(build[field])) errors.push(`${at}: selected ${field} required`);
      }
    }
    if (!Array.isArray(edge.clauses) || edge.clauses.length === 0 || edge.clauses.length > DEPENDENCY_EVIDENCE_LIMITS.clauses) {
      errors.push(`${at}: requires 1..32 immutable clauses`);
      continue;
    }
    const specs = new Set<string>();
    const bindings = new Set<string>();
    let bindingCount = 0;
    for (const [j, clause] of edge.clauses.entries()) {
      const ref = `${at}.clauses[${j}]`;
      if (!record(clause) || !exactKeys(clause, ['specId', 'revision', 'contentHash', 'bindingIds'])) {
        errors.push(`${ref}: exact immutable clause fields required`);
        continue;
      }
      if (!token(clause.specId)) errors.push(`${ref}: invalid specId`);
      else if (specs.has(clause.specId)) errors.push(`${ref}: duplicate/conflicting clause`);
      else specs.add(clause.specId);
      if (!Number.isSafeInteger(clause.revision) || (clause.revision as number) <= 0) errors.push(`${ref}: positive immutable revision required`);
      if (typeof clause.contentHash !== 'string' || !HASH.test(clause.contentHash)) errors.push(`${ref}: immutable contentHash required`);
      if (!Array.isArray(clause.bindingIds) || clause.bindingIds.length === 0 || clause.bindingIds.length > DEPENDENCY_EVIDENCE_LIMITS.bindings) {
        errors.push(`${ref}: nonempty bounded binding cohort required`);
        continue;
      }
      bindingCount += clause.bindingIds.length;
      for (const binding of clause.bindingIds) {
        if (!token(binding)) errors.push(`${ref}: invalid binding identity`);
        else if (bindings.has(binding)) errors.push(`${ref}: duplicate binding identity`);
        else bindings.add(binding);
      }
    }
    if (bindingCount > DEPENDENCY_EVIDENCE_LIMITS.bindings) errors.push(`${at}: binding cohort exceeds 128`);
  }
  return { alternatives: errors.length ? [] : JSON.parse(JSON.stringify(value)), errors };
}

/** Remove the complete JSON token before scanning decision refs or other item metadata. */
export function extractDependencyEvidence(text: string): {
  text: string;
  alternatives?: DependencyEvidenceAlternative[];
  errors?: string[];
} {
  const match = MARKER.exec(text);
  if (!match) return { text };
  const errors: string[] = [];
  const rest = text.slice(match.index + match[0].length).trimStart();
  if (!rest.startsWith('`')) return { text, errors: ['dependency-evidence requires backtick-delimited JSON'] };
  const end = rest.indexOf('`', 1);
  if (end < 0 || end > DEPENDENCY_EVIDENCE_LIMITS.chars) {
    return { text, errors: ['dependency-evidence JSON is unterminated or exceeds 65536 characters'] };
  }
  const tail = rest.slice(end + 1);
  if (MARKER.test(tail)) errors.push('duplicate dependency-evidence marker');
  const clean = (text.slice(0, match.index) + tail).trim();
  try {
    const result = validateDependencyEvidence(JSON.parse(rest.slice(1, end)));
    errors.push(...result.errors);
    return errors.length ? { text: clean, errors } : { text: clean, alternatives: result.alternatives };
  } catch {
    return { text: clean, errors: [...errors, 'dependency-evidence contains invalid JSON'] };
  }
}

export function dependencyEvidenceScopeErrors(
  alternatives: readonly DependencyEvidenceAlternative[],
  item: { id: string; blockedBy: readonly string[] },
  planSlug?: string,
  itemIds?: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  for (const edge of alternatives) {
    if (edge.dependentItemId !== item.id || (planSlug !== undefined && edge.planSlug !== planSlug)) {
      errors.push('dependency-evidence names a foreign plan or dependent item');
    }
    if (edge.blockerItemId === item.id || !item.blockedBy.includes(edge.blockerItemId)) {
      errors.push('dependency-evidence must name an existing, non-self blocked-by edge');
    }
    if (itemIds && !itemIds.has(edge.blockerItemId)) errors.push('dependency-evidence blocker endpoint is missing');
  }
  return errors;
}

/** A deterministic selector identity, never an evidence or currentness verdict. */
export function dependencyEvidenceIdentity(edge: DependencyEvidenceAlternative): string {
  const build = edge.selectedBuild;
  return JSON.stringify({ schemaVersion: edge.schemaVersion, workspaceId: edge.workspaceId,
    harnessSlug: edge.harnessSlug, planSlug: edge.planSlug, dependentItemId: edge.dependentItemId,
    blockerItemId: edge.blockerItemId, producerWorkItemId: edge.producerWorkItemId,
    selectedBuild: { repositoryRoot: build.repositoryRoot, commit: build.commit,
      checkRef: build.checkRef, recipeRef: build.recipeRef, configurationFingerprint: build.configurationFingerprint },
    clauses: edge.clauses.map(clause => ({ specId: clause.specId, revision: clause.revision,
      contentHash: clause.contentHash, bindingIds: [...clause.bindingIds].sort() }))
      .sort((a, b) => a.specId < b.specId ? -1 : a.specId > b.specId ? 1 : 0) });
}
