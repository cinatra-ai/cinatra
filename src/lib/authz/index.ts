/**
 * Authorization kernel — public barrel.
 *
 * Single import surface for downstream modules. Explicit named re-exports
 * only — no wildcard re-exports.
 *
 * Both TypeScript types AND runtime values are exported (Permission,
 * Role, EFFECTIVE_GRANTS, AuthzError, POLICY_VERSION are runtime; the
 * rest are types).
 *
 * Server-only barrel. Client components must import types from the
 * separate type-only entrypoint (or directly from the per-file modules
 * via the workspace path) to avoid pulling in `enforce.ts`'s
 * `import "server-only"` at build time.
 */
import "server-only";

// -------- Runtime values --------
export { can, canDo, buildActorContext } from "./enforce";
export { AuthzError } from "./errors";
export { EFFECTIVE_GRANTS } from "./policies";
export { POLICY_VERSION } from "./actor-context";
export { logAuditEvent } from "./audit";
export { withPlatformAdminBypass } from "./admin-bypass";
export type { AdminBypassReason } from "./admin-bypass";
// Canonical `requireAccess` primitive, classification registry, and
// CarveOut catalog.
export { requireAccess, canRequireAccess } from "./require-access";
export type { RequireAccessOpts } from "./require-access";
export {
  CLASSIFICATION_ENTRIES,
  lookupClassification,
  listRegisteredTuples,
} from "./registry";
export type { Action, ClassificationEntry, EffectClass, RequiredAccess } from "./registry";
export { CARVE_OUTS, findCarveOut, listCarveOuts } from "./carve-out";
export type { CarveOut, CarveOutRef, BoundaryPerimeter, CarveOutRisk } from "./carve-out";
export { PRIMITIVE_CLASSIFICATIONS, lookupPrimitiveClassification } from "./inventory-augment";
export type { EnforcementStatus, PrimitiveClassification } from "./inventory-augment";
// Delegated execution-actor identity.
export {
  captureDelegatedActorSnapshot,
  reconstructActorFromSnapshot,
  detectRevokedGrants,
} from "./delegated-agent-run";
export type { DelegatedAgentRunSnapshot } from "./delegated-agent-run";

// -------- Types --------
export type { Principal, PrincipalType, ActorContext } from "./actor-context";
export type {
  ResourceRef,
  ResourceType,
  OwnerLevel,
  ProjectRefinementTarget,
  OwnerType,
  Visibility,
} from "./resource-ref";
// Runtime ownership-tier helpers: four-tier model; project is a
// refinement, not a tier.
export { normalizeOwnerLevel, isOwnerLevelValue } from "./resource-ref";
export type { Permission } from "./permissions";
export type { Role } from "./policies";
export type { EvaluationContext } from "./enforce";
export type { AuthzErrorCode } from "./errors";
export type { AuditEvent } from "./audit";
export type { AuditEventInput } from "./audit";
