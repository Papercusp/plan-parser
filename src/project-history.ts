import { hashPlanContent } from './content-hash';
import { resolveEffectiveStatus } from './effective-status';
import { parsePlan, type PlanDecision, type PlanFrontmatter } from './parser';

export const PROJECT_HISTORY_SCHEMA_VERSION = 1 as const;

export type ProjectHistoryCommitAttribution =
  | 'authoritative'
  | 'body-reference'
  | 'inferred';

export type ProjectHistoryCommitRemoteStatus =
  | 'confirmed'
  | 'local-only'
  | 'unknown';

export interface ProjectHistoryRepository {
  provider: 'github' | 'git';
  /** Clone/fetch URL. It may be private and is therefore metadata, not a browser link. */
  url: string;
  /** Browser-safe repository root, for example https://github.com/Papercusp/sidestage. */
  webUrl: string | null;
  defaultBranch?: string | null;
}

export interface ProjectHistoryProject {
  id: string;
  name: string;
  repository: ProjectHistoryRepository | null;
}

export interface ProjectHistoryCommit {
  sha: string;
  url: string | null;
  subject: string | null;
  committedAt: string | null;
  files: string[];
  remoteStatus: ProjectHistoryCommitRemoteStatus;
  attribution: ProjectHistoryCommitAttribution;
}

export interface ProjectHistoryWorkItem {
  id: string;
  kind: string;
  title: string;
  state: string;
  completedAt: string | null;
  completionAuthority: string | null;
  completionSummary: string | null;
  completionEvidence: Record<string, unknown> | null;
  commits: ProjectHistoryCommit[];
}

export interface ProjectHistoryPlanItem {
  id: string;
  text: string;
  storedStatus: string;
  effectiveStatus: string;
  importance: string | null;
  riskTier: string | null;
  authority: string | null;
  blockedBy: string[];
  phase: string | null;
  lineNumber: number;
}

export interface ProjectHistoryDecision {
  id: string;
  title: string;
  body: string;
  date: string | null;
  itemRefs: string[];
  lineNumber: number;
}

export interface ProjectHistoryPlan {
  slug: string;
  title: string;
  status: string;
  updatedAt: string | null;
  contentHash: string;
  markdown: string;
  frontmatter: Record<string, unknown>;
  items: ProjectHistoryPlanItem[];
  decisions: ProjectHistoryDecision[];
  completedItems: ProjectHistoryWorkItem[];
}

export interface ProjectHistorySource {
  kind: 'papercusp-plan-export';
  workspace: string;
  harness: string;
  planPrefix: string | null;
  generatedAt: string;
  planCount: number;
  generator: string;
}

/**
 * Versioned, disposable read model. The Papercusp ledgers and Git remain the
 * sources of truth; consumers may regenerate this document at any time.
 */
export interface ProjectHistoryDocument {
  schemaVersion: typeof PROJECT_HISTORY_SCHEMA_VERSION;
  project: ProjectHistoryProject;
  source: ProjectHistorySource;
  plans: ProjectHistoryPlan[];
}

export interface ProjectHistoryCommitLink {
  workItemId: string;
  attribution: ProjectHistoryCommitAttribution;
}

export interface ProjectHistoryCommitInput {
  sha: string;
  subject?: string | null;
  committedAt?: string | null;
  files?: readonly string[];
  remoteStatus?: ProjectHistoryCommitRemoteStatus;
  links: readonly ProjectHistoryCommitLink[];
}

export interface ProjectHistoryWorkItemInput
  extends Omit<ProjectHistoryWorkItem, 'commits'> {
  /** Restrict an explicit item to these plans. Omit to attach it wherever its id is referenced. */
  planSlugs?: readonly string[];
}

export interface ProjectHistoryPlanInput {
  markdown: string;
  filePath?: string;
  updatedAt?: string | null;
  completedItems?: readonly ProjectHistoryWorkItemInput[];
}

export interface AssembleProjectHistoryInput {
  project: ProjectHistoryProject;
  source: Omit<ProjectHistorySource, 'planCount'>;
  plans: readonly ProjectHistoryPlanInput[];
  commits?: readonly ProjectHistoryCommitInput[];
}

/**
 * I/O boundary for Project History generation. Implementations may read the
 * Papercusp ledgers, a fixture directory, or another compatible store; the
 * assembler itself remains pure and product-neutral.
 */
export interface ProjectHistoryProvider {
  loadPlans(): Promise<readonly ProjectHistoryPlanInput[]>;
  loadWorkItems?(ids: readonly string[]): Promise<readonly ProjectHistoryWorkItemInput[]>;
  loadCommits?(ids: readonly string[]): Promise<readonly ProjectHistoryCommitInput[]>;
}

export interface GenerateProjectHistoryInput {
  project: ProjectHistoryProject;
  source: Omit<ProjectHistorySource, 'planCount'>;
  provider: ProjectHistoryProvider;
}

const COMPLETION_MARKER_RE = /\u2190\s+((?:WI|EI|F)-\d+)\s+completed\b/g;
const NOTE_SUFFIX_RE = /\s+\u2014\s+note:.*$/;

function frontmatterRecord(frontmatter: PlanFrontmatter): Record<string, unknown> {
  const { raw: _raw, ...known } = frontmatter;
  return { ...frontmatter.raw, ...known };
}

function historyDecision(decision: PlanDecision): ProjectHistoryDecision {
  return {
    id: decision.id,
    title: decision.title,
    body: decision.body,
    date: decision.date,
    itemRefs: [...decision.itemRefs],
    lineNumber: decision.lineNumber,
  };
}

/**
 * Work-item completion markers are a compatibility provider, not the long-term
 * authority. Explicit provider records replace them by id when available.
 */
export function completedWorkItemsFromPlan(
  planSlug: string,
  updatedAt: string | null,
  contentHash: string,
  items: readonly { id: string; text: string }[],
): ProjectHistoryWorkItem[] {
  const completed = new Map<string, ProjectHistoryWorkItem>();
  for (const item of items) {
    for (const match of item.text.matchAll(COMPLETION_MARKER_RE)) {
      const id = match[1];
      if (!id) continue;
      completed.set(id, {
        id,
        kind: 'work-item',
        title: item.text.replace(NOTE_SUFFIX_RE, '').trim(),
        state: 'done',
        completedAt: updatedAt,
        completionAuthority: 'plan-ledger',
        completionSummary: `Recorded complete by ${item.id} in the canonical plan ledger.`,
        completionEvidence: {
          source: 'canonical-plan-completion-marker',
          plan: planSlug,
          planItem: item.id,
          contentHash,
        },
        commits: [],
      });
    }
  }
  return [...completed.values()];
}

export function projectHistoryCommitUrl(
  repository: ProjectHistoryRepository | null,
  sha: string,
): string | null {
  if (repository?.provider !== 'github' || !repository.webUrl) return null;
  return `${repository.webUrl.replace(/\/$/, '')}/commit/${encodeURIComponent(sha)}`;
}

function commitsByWorkItem(
  repository: ProjectHistoryRepository | null,
  commits: readonly ProjectHistoryCommitInput[],
): Map<string, ProjectHistoryCommit[]> {
  const byWorkItem = new Map<string, ProjectHistoryCommit[]>();
  for (const commit of commits) {
    for (const link of commit.links) {
      const output: ProjectHistoryCommit = {
        sha: commit.sha,
        url: projectHistoryCommitUrl(repository, commit.sha),
        subject: commit.subject ?? null,
        committedAt: commit.committedAt ?? null,
        files: [...new Set(commit.files ?? [])].sort(),
        remoteStatus: commit.remoteStatus ?? 'unknown',
        attribution: link.attribution,
      };
      const current = byWorkItem.get(link.workItemId) ?? [];
      const previous = current.findIndex((entry) => entry.sha === output.sha);
      if (previous === -1) current.push(output);
      else if (
        current[previous]?.attribution !== 'authoritative'
        && output.attribution === 'authoritative'
      ) current[previous] = output;
      byWorkItem.set(link.workItemId, current);
    }
  }
  for (const values of byWorkItem.values()) {
    values.sort((left, right) => {
      const byTime = (right.committedAt ?? '').localeCompare(left.committedAt ?? '');
      return byTime || left.sha.localeCompare(right.sha);
    });
  }
  return byWorkItem;
}

function appliesToPlan(item: ProjectHistoryWorkItemInput, planSlug: string): boolean {
  return !item.planSlugs || item.planSlugs.length === 0 || item.planSlugs.includes(planSlug);
}

function referencedWorkItems(planInput: ProjectHistoryPlanInput): Set<string> {
  const parsed = parsePlan(planInput.markdown, { filePath: planInput.filePath });
  const resolved = resolveEffectiveStatus(parsed);
  const slug = parsed.frontmatter.slug ?? parsed.slug;
  const updatedAt = planInput.updatedAt ?? (
    typeof parsed.frontmatter.updated === 'string' ? parsed.frontmatter.updated : null
  );
  const contentHash = hashPlanContent(planInput.markdown);
  return new Set([
    ...completedWorkItemsFromPlan(slug, updatedAt, contentHash, resolved.items).map((item) => item.id),
    ...(planInput.completedItems ?? []).map((item) => item.id),
  ]);
}

/**
 * Load provider data and produce a validated Project History document.
 * Provider work items without an explicit planSlugs list are attached only to
 * plans that already reference their id, preserving the plan ledger as the
 * membership authority.
 */
export async function generateProjectHistory(
  input: GenerateProjectHistoryInput,
): Promise<ProjectHistoryDocument> {
  const plans = [...await input.provider.loadPlans()];
  const references = plans.map(referencedWorkItems);
  const ids = [...new Set(references.flatMap((values) => [...values]))].sort();
  const workItems = ids.length > 0 && input.provider.loadWorkItems
    ? [...await input.provider.loadWorkItems(ids)]
    : [];

  // A provider that resolves NOTHING for referenced ids is a broken read, not a
  // project without completed work — and the difference is invisible in the output,
  // because `completedWorkItemsFromPlan` happily produces a well-formed document
  // full of evidence-free plan-ledger stubs. That is exactly what shipped: 327 of
  // 327 items published with no verification, files or commits while the ledger
  // held 505 evidenced completions (WI-39831). Fail loudly instead of degrading.
  if (input.provider.loadWorkItems && ids.length > 0 && workItems.length === 0) {
    throw new Error(
      `Project History provider resolved 0 work items for ${ids.length} referenced id(s). `
      + 'Refusing to emit a document built entirely from plan-completion markers: a silent '
      + 'fallback to the plan-ledger compatibility stub is indistinguishable from real '
      + 'completion evidence once published. Fix the provider read, or omit loadWorkItems '
      + 'to declare the marker ledger as the intended authority.',
    );
  }
  const commits = ids.length > 0 && input.provider.loadCommits
    ? [...await input.provider.loadCommits(ids)]
    : [];

  return assembleProjectHistory({
    project: input.project,
    source: input.source,
    plans: plans.map((plan, index) => ({
      ...plan,
      completedItems: [
        ...(plan.completedItems ?? []),
        ...workItems.filter((item) => {
          if (item.planSlugs && item.planSlugs.length > 0) {
            const parsed = parsePlan(plan.markdown, { filePath: plan.filePath });
            return item.planSlugs.includes(parsed.frontmatter.slug ?? parsed.slug);
          }
          return references[index]?.has(item.id) ?? false;
        }),
      ],
    })),
    commits,
  });
}

/** Assemble one deterministic Project History v1 document from provider inputs. */
export function assembleProjectHistory(
  input: AssembleProjectHistoryInput,
): ProjectHistoryDocument {
  const commits = commitsByWorkItem(input.project.repository, input.commits ?? []);
  const plans = input.plans.map((planInput) => {
    const parsed = parsePlan(planInput.markdown, { filePath: planInput.filePath });
    const resolved = resolveEffectiveStatus(parsed);
    const slug = parsed.frontmatter.slug ?? parsed.slug;
    const updatedAt = planInput.updatedAt ?? (
      typeof parsed.frontmatter.updated === 'string' ? parsed.frontmatter.updated : null
    );
    const contentHash = hashPlanContent(planInput.markdown);
    const inferred = completedWorkItemsFromPlan(slug, updatedAt, contentHash, resolved.items);
    const byId = new Map(inferred.map((item) => [item.id, item]));
    for (const explicit of planInput.completedItems ?? []) {
      if (!appliesToPlan(explicit, slug)) continue;
      const { planSlugs: _planSlugs, ...item } = explicit;
      byId.set(item.id, { ...item, commits: [] });
    }
    const completedItems = [...byId.values()].map((item) => ({
      ...item,
      commits: [...(commits.get(item.id) ?? [])],
    }));

    return {
      slug,
      title: parsed.frontmatter.title ?? slug,
      status: parsed.frontmatter.status ?? 'unknown',
      updatedAt,
      contentHash,
      markdown: planInput.markdown,
      frontmatter: frontmatterRecord(parsed.frontmatter),
      items: resolved.items.map((item) => ({
        id: item.id,
        text: item.text,
        storedStatus: item.storedStatus,
        effectiveStatus: item.effectiveStatus,
        importance: item.importance ?? null,
        riskTier: item.riskTier ?? null,
        authority: item.authority ?? null,
        blockedBy: [...item.blockedBy],
        phase: item.phase,
        lineNumber: item.lineNumber,
      })),
      decisions: parsed.decisions.map(historyDecision),
      completedItems,
    } satisfies ProjectHistoryPlan;
  });

  const document: ProjectHistoryDocument = {
    schemaVersion: PROJECT_HISTORY_SCHEMA_VERSION,
    project: {
      ...input.project,
      repository: input.project.repository ? { ...input.project.repository } : null,
    },
    source: { ...input.source, planCount: plans.length },
    plans,
  };
  return assertProjectHistoryDocument(document);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Runtime guard for generated or remotely loaded History documents. */
export function assertProjectHistoryDocument(value: unknown): ProjectHistoryDocument {
  if (!value || typeof value !== 'object') throw new TypeError('Project History document must be an object');
  const document = value as Partial<ProjectHistoryDocument>;
  if (document.schemaVersion !== PROJECT_HISTORY_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported Project History schemaVersion: ${String(document.schemaVersion)}`);
  }
  if (!document.project || !nonEmptyString(document.project.id) || !nonEmptyString(document.project.name)) {
    throw new TypeError('Project History project.id and project.name are required');
  }
  if (!document.source || !nonEmptyString(document.source.workspace) || !nonEmptyString(document.source.harness)) {
    throw new TypeError('Project History source.workspace and source.harness are required');
  }
  if (!Array.isArray(document.plans)) throw new TypeError('Project History plans must be an array');
  if (document.source.planCount !== document.plans.length) {
    throw new TypeError('Project History source.planCount must equal plans.length');
  }
  const slugs = new Set<string>();
  for (const plan of document.plans) {
    if (!nonEmptyString(plan.slug) || slugs.has(plan.slug)) {
      throw new TypeError(`Project History plan slugs must be non-empty and unique: ${String(plan.slug)}`);
    }
    slugs.add(plan.slug);
    if (!Array.isArray(plan.completedItems)) throw new TypeError(`Project History ${plan.slug} completedItems must be an array`);
    for (const item of plan.completedItems) {
      if (!nonEmptyString(item.id) || !Array.isArray(item.commits)) {
        throw new TypeError(`Project History ${plan.slug} has an invalid completed item`);
      }
      for (const commit of item.commits) {
        if (!/^[0-9a-f]{7,64}$/i.test(commit.sha)) {
          throw new TypeError(`Project History ${item.id} has an invalid commit sha: ${commit.sha}`);
        }
      }
    }
  }
  return document as ProjectHistoryDocument;
}
