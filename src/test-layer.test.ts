import { describe, expect, inject, it } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    papercuspTestLayer: string;
  }
}

// The test-run ledger records a row's testLayer only from the executing project's
// `test.provide.papercuspTestLayer` (vitest.config.ts beside package.json). Without it every
// run of this package records no layer, and spec-test-adequacy cannot confirm the unit layer
// for clauses proven here. This fails if the config is removed or stops providing the value.
describe('plan-parser vitest project', () => {
  it('provides papercuspTestLayer=unit to the test-run reporter', () => {
    expect(inject('papercuspTestLayer')).toBe('unit');
  });
});
