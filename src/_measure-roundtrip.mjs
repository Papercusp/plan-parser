// TEMP: measure renderPlanMarkdown round-trip fidelity over the real plan corpus.
// Run: node libs/generic/plan-parser/src/_measure-roundtrip.mjs <plans-dir>
// Delete after use.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// Build the lib to JS first isn't necessary — use tsx via a child import.
// Instead, import the TS source through tsx's loader by re-exec under tsx.
const dir = process.argv[2] || '/home/marsh-office/papercupai-workspace/papercup/apps/operator/docs/plans';

// Load parser+renderer via a dynamic tsx import.
const { parsePlan, renderPlanMarkdown } = await import('./index.ts');

function structKey(p) {
  return JSON.stringify({
    fm: {
      title: p.frontmatter.title ?? null,
      slug: p.frontmatter.slug ?? null,
      status: p.frontmatter.status ?? null,
      created: p.frontmatter.created ?? null,
      updated: p.frontmatter.updated ?? null,
      owner: p.frontmatter.owner ?? null,
      supersedes: p.frontmatter.supersedes ?? [],
      supersededBy: p.frontmatter.supersededBy ?? null,
    },
    now: p.now ? { state: p.now.state, next: p.now.next } : null,
    items: p.items.map((i) => ({
      id: i.id, s: i.storedStatus, t: i.text, imp: i.importance,
      bb: i.blockedBy, dr: i.decisionRefs, ph: i.phase,
    })),
    decisions: p.decisions.map((d) => ({ id: d.id, title: d.title, body: d.body, date: d.date, refs: d.itemRefs })),
  });
}

const files = readdirSync(dir).filter((f) => f.endsWith('.md') || f.endsWith('.mdx'));
let pass = 0, fail = 0;
const failSlugs = [];
for (const f of files) {
  const raw = readFileSync(join(dir, f), 'utf8');
  const p1 = parsePlan(raw, { filePath: f });
  const rendered = renderPlanMarkdown(p1);
  const p2 = parsePlan(rendered, { filePath: f });
  if (structKey(p1) === structKey(p2)) pass++;
  else { fail++; if (failSlugs.length < 12) failSlugs.push(f.replace(/\.mdx?$/, '')); }
}
console.log(`round-trip: ${pass}/${pass + fail} pass, ${fail} fail`);
if (failSlugs.length) console.log('sample fails:\n  ' + failSlugs.join('\n  '));
