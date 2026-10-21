/**
 * Verification vocabulary owned by the plan format (plan-verification-profiles-2026-10-17 P-002, D-001).
 *
 * A plan declares a verification PROFILE that sets the default deliverable kind for its items; an
 * item may override it with a `deliverable:` keyword on its line. The parser owns these words
 * because the item keyword is part of the plan text. Policy (which checks each kind pulls in) lives
 * with the consumer, not here.
 */

export const VERIFICATION_PROFILES = ['coding', 'general'] as const;
export type VerificationProfile = (typeof VERIFICATION_PROFILES)[number];

export const DELIVERABLE_KINDS = ['code', 'doc', 'decision', 'research', 'operation', 'artifact'] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export function isVerificationProfile(value: unknown): value is VerificationProfile {
  return typeof value === 'string' && (VERIFICATION_PROFILES as readonly string[]).includes(value);
}

export function isDeliverableKind(value: unknown): value is DeliverableKind {
  return typeof value === 'string' && (DELIVERABLE_KINDS as readonly string[]).includes(value);
}

/**
 * Namespaced item-type and plan-type slugs (plan-item-types-registry-cupboard-2026-10-20 P-002).
 *
 * `deliverable:` and the plan-level `type:` accept any `<namespace>/<name>` slug, for example
 * `acme/legal-review`. The parser checks GRAMMAR ONLY: lowercase letters, digits and hyphens,
 * exactly one slash, no empty segment, no leading hyphen. Whether such a type exists, and which
 * checks it pulls in, is the consumer's resolver's business, never the parser's. The same pattern
 * backs the registry's type ids and the `plan_items.deliverable` CHECK (migration 1542).
 */
export const TYPE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

/** A namespaced type slug: `${namespace}/${name}`. */
export type TypeSlug = `${string}/${string}`;

export function isTypeSlug(value: unknown): value is TypeSlug {
  return typeof value === 'string' && TYPE_SLUG_PATTERN.test(value);
}

/** What an item may declare on its `deliverable:` keyword: a built-in kind or a namespaced item type. */
export type DeliverableRef = DeliverableKind | TypeSlug;

export function isDeliverableRef(value: unknown): value is DeliverableRef {
  return isDeliverableKind(value) || isTypeSlug(value);
}

/**
 * Normalize one `deliverable:` token. A built-in kind keeps its historical case-insensitivity
 * (`Deliverable: DOC` is `doc`); a namespaced slug is taken verbatim and must already be
 * well-formed, so `Acme/legal-review`, `acme/`, `/legal-review` and `acme//x` are all refused
 * (null). Trailing sentence punctuation is not part of the token.
 */
export function normalizeDeliverableToken(token: string): DeliverableRef | null {
  const trimmed = token.replace(/[.,;:)]+$/, '');
  const lowered = trimmed.toLowerCase();
  if (isDeliverableKind(lowered)) return lowered;
  return isTypeSlug(trimmed) ? trimmed : null;
}
