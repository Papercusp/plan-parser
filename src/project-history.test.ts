import { describe, expect, it } from 'vitest';
import {
  assembleProjectHistory,
  assertProjectHistoryDocument,
  completedWorkItemsFromPlan,
  projectHistoryCommitUrl,
} from './project-history';

const MARKDOWN = `---
title: Demo release
slug: demo-release-2026-08-14
status: active
updated: 2026-08-14T20:00:00.000Z
---

## Phase — Build

- **P-001** \`done\` Build the feature — note: ← WI-100 completed (done)
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

describe('Project History v1', () => {
  it('assembles parsed plan structure and compatibility completion markers', () => {
    const document = assembleProjectHistory({
      project,
      source,
      plans: [{ markdown: MARKDOWN, filePath: 'demo-release-2026-08-14.md' }],
    });

    expect(document.schemaVersion).toBe(1);
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
    expect(() => assertProjectHistoryDocument({ ...valid, schemaVersion: 2 })).toThrow(/schemaVersion/);
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
});
