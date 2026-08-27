import { describe, expect, it } from 'vitest';
import {
  assembleProjectHistory,
  assertProjectHistoryDocument,
  completedWorkItemsFromPlan,
  generateProjectHistory,
  projectHistoryCommitUrl,
  validationAssertionsFromPlan,
} from './project-history';

const MARKDOWN = `---
title: Demo release
slug: demo-release-2026-08-14
status: active
updated: 2026-08-14T20:00:00.000Z
---

## Phase — Build

- **P-001** \`done\` Build the feature — note: ← WI-100 completed (done)
  - **[VAL-demo-release-2026-08-14-001]**
    - **Verify:** The delivered page renders the feature.
    - **Evidence:** tests/history.test.tsx — renders the feature
    - **Status:** \`passed\`
  - **[VAL-demo-release-2026-08-14-002]**
    - **Verify:** The copy matches the approved design.
    - **Evidence:** Visual inspection
    - **Status:** \`validating\`
    - **RequiresTest:** \`false\`
- **P-002** \`todo\` Verify it blocked-by: P-001

## Decisions

### D-001 — Reuse the shared assembler
Date: 2026-08-14
Project history is a read model.
`;

const source = {
  kind: 'papercusp-plan-export' as const,
  workspace: 'workspace',
  harness: 'demo',
  planPrefix: 'demo-',
  generatedAt: '2026-08-14T21:00:00.000Z',
  generator: 'project-history',
};

const project = {
  id: 'demo',
  name: 'Demo',
  repository: {
    provider: 'github' as const,
    url: 'git@github.com:Papercusp/demo.git',
    webUrl: 'https://github.com/Papercusp/demo',
    defaultBranch: 'main',
  },
};

describe('Project History v2', () => {
  it('assembles parsed plan structure and compatibility completion markers', () => {
    const document = assembleProjectHistory({
      project,
      source,
      plans: [{ markdown: MARKDOWN, filePath: 'demo-release-2026-08-14.md' }],
    });

    expect(document.schemaVersion).toBe(2);
    expect(document.source.planCount).toBe(1);
    expect(document.plans[0]).toMatchObject({
      slug: 'demo-release-2026-08-14',
      title: 'Demo release',
      status: 'active',
    });
    expect(document.plans[0]?.items.map((item) => [item.id, item.effectiveStatus])).toEqual([
      ['P-001', 'done'],
      ['P-002', 'todo'],
    ]);
    expect(document.plans[0]?.decisions[0]?.id).toBe('D-001');
    expect(document.plans[0]?.items[0]?.validationAssertions).toEqual([
      expect.objectContaining({
        id: 'VAL-demo-release-2026-08-14-001',
        status: 'passed',
        requiresTest: true,
        source: 'canonical-plan-inline',
      }),
      expect.objectContaining({
        id: 'VAL-demo-release-2026-08-14-002',
        status: 'validating',
        requiresTest: false,
      }),
    ]);
    expect(document.plans[0]?.validationSummary).toEqual({
      total: 2,
      passed: 1,
      failed: 0,
      validating: 1,
      todo: 0,
      requiringTest: 1,
    });
    expect(document.plans[0]?.completedItems[0]).toMatchObject({
      id: 'WI-100',
      completionAuthority: 'plan-ledger',
      commits: [],
    });
  });

  it('attaches per-work-item commits with provenance, stable file order, and GitHub links', () => {
    const document = assembleProjectHistory({
      project,
      source,
      plans: [{ markdown: MARKDOWN }],
      commits: [{
        sha: 'abc1234def5678',
        subject: 'feat: build demo',
        committedAt: '2026-08-14T20:30:00.000Z',
        files: ['z.ts', 'a.ts', 'z.ts'],
        remoteStatus: 'confirmed',
        links: [{ workItemId: 'WI-100', attribution: 'authoritative' }],
      }],
    });

    expect(document.plans[0]?.completedItems[0]?.commits).toEqual([{
      sha: 'abc1234def5678',
      url: 'https://github.com/Papercusp/demo/commit/abc1234def5678',
      subject: 'feat: build demo',
      committedAt: '2026-08-14T20:30:00.000Z',
      files: ['a.ts', 'z.ts'],
      remoteStatus: 'confirmed',
      attribution: 'authoritative',
    }]);
  });

  // A product can span repos (SideStage's mobile work lives in sidestage-mobile). Such a
  // commit MUST resolve against its own repo: pointing it at the primary project yields a
  // confident 404, which is worse than the no-link state this feature replaced (WI-39898).
  it('links a commit carried in from a secondary repo to THAT repo, not the primary one', () => {
    const document = assembleProjectHistory({
      project,
      source,
      plans: [{ markdown: MARKDOWN }],
      commits: [
        {
          sha: 'aaa1111',
          subject: 'primary repo work',
          committedAt: '2026-08-14T20:30:00.000Z',
          files: ['a.ts'],
          remoteStatus: 'confirmed',
          links: [{ workItemId: 'WI-100', attribution: 'authoritative' }],
        },
        {
          sha: 'bbb2222',
          subject: 'mobile repo work',
          committedAt: '2026-08-14T20:31:00.000Z',
          files: ['ios/App.swift'],
          remoteStatus: 'confirmed',
          links: [{ workItemId: 'WI-100', attribution: 'authoritative' }],
          repository: {
            provider: 'github' as const,
            url: 'git@github.com:Papercusp/demo-mobile.git',
            webUrl: 'https://github.com/Papercusp/demo-mobile',
            defaultBranch: 'main',
          },
        },
      ],
    });

    const urlBySha = new Map(
      (document.plans[0]?.completedItems[0]?.commits ?? []).map((commit) => [commit.sha, commit.url]),
    );
    expect(urlBySha.get('aaa1111')).toBe('https://github.com/Papercusp/demo/commit/aaa1111');
    expect(urlBySha.get('bbb2222')).toBe('https://github.com/Papercusp/demo-mobile/commit/bbb2222');
  });

  // The falsifier for the rule above: a secondary repo with no browsable webUrl must yield
  // a null link rather than silently borrowing the primary repo's URL space.
  it('yields no link for a secondary-repo commit whose own repo is not browsable', () => {
    const document = assembleProjectHistory({
      project,
      source,
      plans: [{ markdown: MARKDOWN }],
      commits: [{
        sha: 'ccc3333',
        subject: 'private mirror work',
        committedAt: '2026-08-14T20:32:00.000Z',
        files: ['x.ts'],
        remoteStatus: 'confirmed',
        links: [{ workItemId: 'WI-100', attribution: 'authoritative' }],
        repository: {
          provider: 'git' as const,
          url: 'ssh://git@internal.example/mirror.git',
          webUrl: null,
        },
      }],
    });

    expect(document.plans[0]?.completedItems[0]?.commits[0]?.url).toBeNull();
  });

  it('lets an explicit provider item replace the compatibility marker without losing commits', () => {
    const document = assembleProjectHistory({
      project,
      source,
      plans: [{
        markdown: MARKDOWN,
        completedItems: [{
          id: 'WI-100',
          kind: 'feature',
          title: 'Authoritative title',
          state: 'done',
          completedAt: '2026-08-14T20:15:00.000Z',
          completionAuthority: 'work-item-ledger',
          completionSummary: 'Verified.',
          completionEvidence: { test: 'green' },
        }],
      }],
      commits: [{
        sha: 'def5678abc1234',
        links: [{ workItemId: 'WI-100', attribution: 'body-reference' }],
      }],
    });

    expect(document.plans[0]?.completedItems).toEqual([
      expect.objectContaining({
        id: 'WI-100',
        title: 'Authoritative title',
        completionAuthority: 'work-item-ledger',
        commits: [expect.objectContaining({ attribution: 'body-reference' })],
      }),
    ]);
  });

  it('keeps commit links null for repositories without a browser-safe GitHub URL', () => {
    expect(projectHistoryCommitUrl(null, 'abc1234')).toBeNull();
    expect(projectHistoryCommitUrl({ provider: 'git', url: 'ssh://host/repo', webUrl: null }, 'abc1234')).toBeNull();
  });

  it('deduplicates repeated completion markers by work-item id', () => {
    const items = [
      { id: 'P-001', text: 'First — note: ← WI-1 completed (done)' },
      { id: 'P-002', text: 'Replacement — note: ← WI-1 completed (done)' },
    ];
    expect(completedWorkItemsFromPlan('p', null, 'hash', items)).toHaveLength(1);
  });

  it('rejects schema drift and invalid commit SHAs at the read boundary', () => {
    const valid = assembleProjectHistory({ project, source, plans: [{ markdown: MARKDOWN }] });
    expect(() => assertProjectHistoryDocument({ ...valid, schemaVersion: 1 })).toThrow(/schemaVersion/);
    const invalid = structuredClone(valid);
    invalid.plans[0]!.completedItems[0]!.commits.push({
      sha: 'not-a-sha',
      url: null,
      subject: null,
      committedAt: null,
      files: [],
      remoteStatus: 'unknown',
      attribution: 'inferred',
    });
    expect(() => assertProjectHistoryDocument(invalid)).toThrow(/invalid commit sha/);
  });

  it('rejects incomplete validation provenance, stale rollups, timestamps, and commit linkage', () => {
    const valid = assembleProjectHistory({
      project,
      source,
      plans: [{ markdown: MARKDOWN }],
      commits: [{
        sha: 'abc1234def5678',
        committedAt: '2026-08-14T20:30:00.000Z',
        files: ['src/history.ts'],
        remoteStatus: 'confirmed',
        links: [{ workItemId: 'WI-100', attribution: 'authoritative' }],
      }],
    });

    const missingEvidence = structuredClone(valid);
    missingEvidence.plans[0]!.items[0]!.validationAssertions[0]!.evidenceLocator = '';
    expect(() => assertProjectHistoryDocument(missingEvidence)).toThrow(/invalid validation assertion/);

    const staleSummary = structuredClone(valid);
    staleSummary.plans[0]!.validationSummary.passed = 0;
    expect(() => assertProjectHistoryDocument(staleSummary)).toThrow(/validationSummary/);

    const invalidTimestamp = structuredClone(valid);
    invalidTimestamp.plans[0]!.completedItems[0]!.completedAt = 'not-a-timestamp';
    expect(() => assertProjectHistoryDocument(invalidTimestamp)).toThrow(/completedAt/);

    const invalidCommit = structuredClone(valid);
    invalidCommit.plans[0]!.completedItems[0]!.commits[0]!.remoteStatus = 'confirmed-locally' as never;
    expect(() => assertProjectHistoryDocument(invalidCommit)).toThrow(/invalid commit sha/);
  });

  it('parses canonical inline validation blocks and coerces unknown statuses to todo', () => {
    const assertions = validationAssertionsFromPlan(MARKDOWN.replace('`passed`', '`dropped`'));
    expect(assertions).toHaveLength(2);
    expect(assertions[0]).toMatchObject({
      planItemId: 'P-001',
      status: 'todo',
      verify: 'The delivered page renders the feature.',
      evidenceLocator: 'tests/history.test.tsx — renders the feature',
    });
  });

  it('loads provider records once and attaches unscoped work items only where plans reference them', async () => {
    const secondMarkdown = MARKDOWN
      .replace('Demo release', 'Second release')
      .replace('demo-release-2026-08-14', 'second-release-2026-08-14')
      .replaceAll('WI-100', 'WI-200');
    const requested: string[][] = [];

    const document = await generateProjectHistory({
      project,
      source,
      provider: {
        async loadPlans() {
          return [{ markdown: MARKDOWN }, { markdown: secondMarkdown }];
        },
        async loadWorkItems(ids) {
          requested.push([...ids]);
          return ids.map((id) => ({
            id,
            kind: 'feature',
            title: `Ledger ${id}`,
            state: 'done',
            completedAt: '2026-08-14T20:15:00.000Z',
            completionAuthority: 'work-item-ledger',
            completionSummary: 'Verified.',
            completionEvidence: { provider: true },
          }));
        },
        async loadCommits(ids) {
          requested.push([...ids]);
          return [{
            sha: 'abc1234def5678',
            links: [{ workItemId: 'WI-200', attribution: 'authoritative' }],
          }];
        },
      },
    });

    expect(requested).toEqual([
      ['WI-100', 'WI-200'],
      ['WI-100', 'WI-200'],
    ]);
    expect(document.plans[0]?.completedItems.map((item) => item.id)).toEqual(['WI-100']);
    expect(document.plans[1]?.completedItems).toEqual([
      expect.objectContaining({
        id: 'WI-200',
        title: 'Ledger WI-200',
        commits: [expect.objectContaining({ attribution: 'authoritative' })],
      }),
    ]);
  });
});
