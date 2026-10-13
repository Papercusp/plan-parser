import { defineConfig } from 'vitest/config';

// Declares this package's test layer to the test-run ledger. Every test here is an in-process
// unit test (pure parsing/derivation, no database or network), so the executing project
// provides papercuspTestLayer='unit'. The Papercusp reporter reads that value from the project
// config and nowhere else; a config-less `vitest run` records no layer at all, which leaves
// spec-test-adequacy unable to confirm the unit layer for clauses proven here.
// Plain vitest config on purpose: this generic lib must not depend on @papercusp/test-config.
export default defineConfig({
  test: {
    provide: { papercuspTestLayer: 'unit' },
  },
});
