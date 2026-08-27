import { describe, it, expect } from "vitest";
import { parsePlan, resolveEffectiveStatus, maskFences } from "./index";
import * as browserBarrel from "./index";
import { hashPlanContent } from "./content-hash";

const PLAN = `---
title: Demo
slug: demo-2026-05-30
status: active
---

# Demo

## Now

**State:** building.

**Next:** ship it.

## Phase 1

- **P-001** \`done\` first thing
- **P-002** \`todo\` second thing blocked-by: P-001 → D-001

## Decisions

### D-001 — pick a thing
Date: 2026-05-30
We picked the thing.
`;

describe("@papercusp/plan-parser", () => {
  it("keeps Node-only hashing and project history off the browser barrel", () => {
    expect(browserBarrel).not.toHaveProperty("hashPlanContent");
    expect(browserBarrel).not.toHaveProperty("generateProjectHistory");
  });

  it("parsePlan extracts frontmatter, now, items, decisions", () => {
    const p = parsePlan(PLAN, { filePath: "demo-2026-05-30.md" });
    expect(p.isLegacy).toBe(false);
    expect(p.frontmatter.slug).toBe("demo-2026-05-30");
    expect(p.now?.state).toContain("building");
    expect(p.items.map((i) => i.id)).toEqual(["P-001", "P-002"]);
    expect(p.items[1].blockedBy).toEqual(["P-001"]);
    expect(p.items[1].decisionRefs).toEqual(["D-001"]);
    expect(p.decisions.map((d) => d.id)).toEqual(["D-001"]);
  });

  it("EI-522: a set-status-injected note's free prose is excluded from decisionRefs (only structured refs count)", () => {
    // Mirrors exactly what plans:set-status's flipStatusInBody appends —
    // ` — note: <free text>` — where the note prose happens to cite ANOTHER
    // plan's decision id in prose. That must not be parsed as a local D-NNN ref
    // (spurious unknown_decision_ref lint warning, or silent wrong resolution
    // if it collides with a real local id).
    const withNote = PLAN.replace(
      "- **P-002** `todo` second thing blocked-by: P-001 → D-001",
      "- **P-002** `todo` second thing blocked-by: P-001 → D-001 — note: back-refs added to other-plan D-025, another-plan D-011",
    );
    const p = parsePlan(withNote, { filePath: "demo-2026-05-30.md" });
    const p2 = p.items.find((i) => i.id === "P-002")!;
    // The real, structured ref (D-001) is still captured...
    expect(p2.decisionRefs).toEqual(["D-001"]);
    // ...but the note's prose-cited cross-plan ids (D-025, D-011) are NOT.
    expect(p2.decisionRefs).not.toContain("D-025");
    expect(p2.decisionRefs).not.toContain("D-011");
    // The note text itself is still preserved in the displayed `text` (only
    // ref-extraction excludes it, not the field callers render).
    expect(p2.text).toContain("note: back-refs added to other-plan D-025");
  });

  it("parses the optional `initiative` frontmatter grouping label (P-015)", () => {
    const withInit = parsePlan(
      PLAN.replace("status: active", "status: active\ninitiative: shared-hive"),
    );
    expect(withInit.frontmatter.initiative).toBe("shared-hive");
    // Absent ⇒ undefined (a plan with no initiative groups into nothing).
    expect(parsePlan(PLAN).frontmatter.initiative).toBeUndefined();
  });

  it("resolveEffectiveStatus blocks an item whose blocker is not done", () => {
    const p = parsePlan(PLAN.replace("**P-001** `done`", "**P-001** `wip`"));
    const { items } = resolveEffectiveStatus(p);
    const p2 = items.find((i) => i.id === "P-002")!;
    expect(p2.effectiveStatus).toBe("blocked");
    expect(p2.unresolvedBlockers).toEqual(["P-001"]);
  });

  it("resolveEffectiveStatus clears the block once the blocker is done", () => {
    const p = parsePlan(PLAN);
    const { items } = resolveEffectiveStatus(p);
    expect(items.find((i) => i.id === "P-002")!.effectiveStatus).toBe("todo");
  });

  it("hashPlanContent is stable and content-sensitive", () => {
    expect(hashPlanContent("a")).toBe(hashPlanContent("a"));
    expect(hashPlanContent("a")).not.toBe(hashPlanContent("b"));
    expect(hashPlanContent("a")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maskFences blanks fenced regions but preserves length", () => {
    const src = "keep\n```\n- **P-999** `todo` fake\n```\nkeep2";
    const masked = maskFences(src);
    expect(masked.length).toBe(src.length);
    expect(masked).toContain("keep");
    expect(masked).not.toContain("P-999");
  });
});
