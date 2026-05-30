/**
 * @papercusp/plan-parser — the pure tier of the plan-document system.
 *
 * Markdown+frontmatter parsing, the item/decision algebra, effective-status
 * resolution (blocked-by graph), and the canonical content hash. Zero I/O,
 * zero domain coupling — the plans *lifecycle* (revisions, promote, launch,
 * runs, CAS writes, git history) stays in the operator and consumes this.
 *
 * Extracted per papercusp-systems-abstraction-2026-05-29 (P-022 / D-005).
 */
export * from './parser';
export * from './effective-status';
export * from './content-hash';
