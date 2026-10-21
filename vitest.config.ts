import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Inside the Papercusp monorepo, run its restricted-hold preflight before any test starts
// (Decision D-012, WI-10005765). This standalone config cannot import @papercusp/test-config,
// which carries that preflight for every other package. A standalone clone of this repo has no
// such file, so it runs none.
function monorepoHostPreflight(): string[] {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const candidate = join(dir, 'scripts/lib/vitest-host-preflight.mjs');
    if (existsSync(candidate)) return [candidate];
    if (dirname(dir) === dir) return [];
  }
}

// Declares this package's test layer to the test-run ledger. Every test here is an in-process
// unit test (pure parsing/derivation, no database or network), so the executing project
// provides papercuspTestLayer='unit'. The Papercusp reporter reads that value from the project
// config and nowhere else; a config-less `vitest run` records no layer at all, which leaves
// spec-test-adequacy unable to confirm the unit layer for clauses proven here.
// Plain vitest config on purpose: this generic lib must not depend on @papercusp/test-config.
export default defineConfig({
  test: {
    globalSetup: monorepoHostPreflight(),
    provide: { papercuspTestLayer: 'unit' },
  },
});
