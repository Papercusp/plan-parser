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
