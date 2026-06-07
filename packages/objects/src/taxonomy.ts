// ---------------------------------------------------------------------------
// Single code-owned taxonomy.
// ---------------------------------------------------------------------------
//
// The ONE source of truth for the allowed object taxa. Everything that
// classifies, groups, or gates an object type references this module — never a
// locally re-declared union. `ENTITY_TYPE_IDS` / `ASSET_TYPE_IDS`
// (src/lib/register-all-object-types.ts) are gated against `OBJECT_TYPE_FAMILY`
// here; the objects-surface consistency check fails CI on additions outside the
// locked set.
//
// Locked taxa exported here:
//   - ObjectCategory   — domain category (re-exported from ./types; the
//                        classifier's category axis — single definition).
//   - UiFamily         — UI grouping (entity / asset / campaign / list / agent
//                        / artifact / workflow).
//   - ArtifactStatus   — lifecycle status vocabulary for artifact-bearing rows.
//   - WrapperPrimitive — the legacy wrapper primitive names being retired
//                        (accounts_* / contacts_*).
//   - RbacResourceType — the resource-type axis RBAC classifies on. A
//                        TYPE-ONLY alias of the authz ResourceType (no runtime
//                        import → no package coupling).

import type { ResourceType } from "@/lib/authz/resource-ref";
import {
  OBJECT_TYPE_NAMESPACE_RE,
  isNamespacedObjectTypeId,
} from "./namespace";

// Re-export the canonical classifier category. Defined once in ./types; the
// taxonomy surfaces it so callers have a single import for every object taxon.
export type { ObjectCategory } from "./types";

/** The allowed `ObjectCategory` values, as a runtime-checkable list. */
export const OBJECT_CATEGORIES = [
  "profile",
  "content",
  "project",
  "idea",
  "report",
] as const;

// ---------------------------------------------------------------------------
// UiFamily — the UI grouping an object type belongs to.
// ---------------------------------------------------------------------------

export type UiFamily =
  | "entity"
  | "asset"
  | "campaign"
  | "list"
  | "agent"
  | "artifact"
  | "workflow";

export const UI_FAMILIES = [
  "entity",
  "asset",
  "campaign",
  "list",
  "agent",
  "artifact",
  "workflow",
] as const satisfies readonly UiFamily[];

// ---------------------------------------------------------------------------
// ArtifactStatus — lifecycle status vocabulary for artifact-bearing objects.
// ---------------------------------------------------------------------------

export type ArtifactStatus = "draft" | "active" | "archived";

export const ARTIFACT_STATUSES = [
  "draft",
  "active",
  "archived",
] as const satisfies readonly ArtifactStatus[];

// ---------------------------------------------------------------------------
// WrapperPrimitive — legacy wrapper primitives being retired.
// (Registrations stay during transition; named here so the inventory +
// consistency checks share one vocabulary.)
// ---------------------------------------------------------------------------

export type WrapperPrimitive =
  | "accounts_list"
  | "accounts_get"
  | "accounts_create"
  | "accounts_update"
  | "accounts_delete"
  | "contacts_list"
  | "contacts_get"
  | "contacts_create"
  | "contacts_update"
  | "contacts_delete"
  | "contacts_sources_list"
  | "lists_list"
  | "lists_get"
  | "lists_create"
  | "lists_update"
  | "lists_delete"
  | "lists_members_add"
  | "lists_members_remove"
  | "lists_members_count";

export const WRAPPER_PRIMITIVES = [
  "accounts_list",
  "accounts_get",
  "accounts_create",
  "accounts_update",
  "accounts_delete",
  "contacts_list",
  "contacts_get",
  "contacts_create",
  "contacts_update",
  "contacts_delete",
  "contacts_sources_list",
  "lists_list",
  "lists_get",
  "lists_create",
  "lists_update",
  "lists_delete",
  "lists_members_add",
  "lists_members_remove",
  "lists_members_count",
] as const satisfies readonly WrapperPrimitive[];

// ---------------------------------------------------------------------------
// RbacResourceType — the RBAC resource-type axis.
// TYPE-ONLY alias of authz ResourceType (single source of truth; no runtime
// coupling between packages/objects and src/lib/authz). The consistency check
// asserts the object-relevant resource types still exist in the authz
// ResourceType union.
// ---------------------------------------------------------------------------

export type RbacResourceType = ResourceType;

/** Object-relevant RBAC resource types (subset, used by the consistency check). */
export const OBJECT_RBAC_RESOURCE_TYPES = [
  "object",
  "list",
  "entity_account",
  "entity_contact",
  "artifact",
] as const satisfies readonly RbacResourceType[];

// ---------------------------------------------------------------------------
// Object-type ID scheme: domain-namespaced `@scope/package:type`.
// ---------------------------------------------------------------------------

export { OBJECT_TYPE_NAMESPACE_RE, isNamespacedObjectTypeId };

/**
 * Assert an object type ID uses the canonical domain-namespaced scheme
 * `@cinatra-ai/<domain-package>:<type>` (never agent-scoped). Throws on a
 * non-conforming id so a malformed type can never enter the locked set.
 */
export function assertDomainNamespacedTypeId(id: string): void {
  if (!isNamespacedObjectTypeId(id)) {
    throw new Error(
      `Object type id "${id}" is not domain-namespaced (@scope/package:type)`,
    );
  }
}

// ---------------------------------------------------------------------------
// OBJECT_TYPE_FAMILY — the LOCKED set: every statically-known object type id →
// its UiFamily. `ENTITY_TYPE_IDS` / `ASSET_TYPE_IDS` are gated against this
// (the consistency check asserts lockstep). Adding a static type without an
// entry here fails the consistency check. Dynamic `@cinatra-ai/dynamic:*` types
// are NOT listed (they live in the surface inventory with a disposition until
// promoted or retired).
// NOTE: asset namespace renames `asset-blog`→`assets`; campaign types promote
// to `@cinatra-ai/campaigns:*`. This map reflects the current static surface
// and locks the vocabulary, not future renames.
// ---------------------------------------------------------------------------

export const OBJECT_TYPE_FAMILY = {
  "@cinatra-ai/entity-contacts:contact": "entity",
  "@cinatra-ai/entity-accounts:account": "entity",
  // The blog domain is modeled as canonical first-class objects at the
  // `@cinatra-ai/assets:*` namespace: project → idea → post via `parent_id`.
  // These supersede the legacy `@cinatra-ai/asset-blog:*` shadow types below.
  // The legacy entries stay registered through transition and are removed once
  // the source-of-truth flip + live parity verify complete.
  "@cinatra-ai/assets:blog-project": "asset",
  "@cinatra-ai/assets:blog-idea": "asset",
  "@cinatra-ai/assets:blog-post": "asset",
  // The legacy @cinatra-ai/asset-blog:{blog-post-idea,blog-post,saved-media}
  // types were removed. Live shadow rows were re-typed to
  // @cinatra-ai/assets:* in place; no @cinatra-ai/asset-blog:* rows remain in
  // cinatra.objects. The legacy LEGACY_ASSET_BLOG_TYPES const in
  // src/lib/blog/integration/asset-blog-backfill.ts is preserved (decoupled
  // from this taxonomy) so the one-shot backfill stays runnable for any
  // disaster-recovery / re-migration scenario.
  "@cinatra-ai/lists:list": "list",
  "@cinatra-ai/agent-builder:agent-template": "agent",
  "@cinatra-ai/artifact:object": "artifact",
  // Artifact object refs are a typed reference contract (distinct from the
  // generic `@cinatra-ai/artifact:object` catch-all). Registered for
  // classification so blog-post artifact refs are wired through the typed
  // surface and the consistency check verifies they are not a silently-dynamic
  // second object surface. Blob/version mechanics in `packages/artifacts/` stay
  // unchanged (consumer-surface fold-in only).
  "@cinatra-ai/artifacts:artifact-ref": "artifact",
  // Campaign domain types promoted to static at the domain namespace (NOT
  // agent-scoped). `:campaign` / `:context` / `:recipients` were already
  // registered on the classifier path
  // (packages/objects/src/integration/register-types.ts); the email
  // draft/followup/send-attempt bundles are promoted from
  // `@cinatra-ai/dynamic:*` here. Producers continue to accept the legacy
  // dynamic ids on READ for back-compat (PoC one-shot; no historical re-type
  // needed for transient run-scoped bundles).
  "@cinatra-ai/campaigns:campaign": "campaign",
  "@cinatra-ai/campaigns:context": "campaign",
  "@cinatra-ai/campaigns:recipients": "campaign",
  "@cinatra-ai/campaigns:email-draft-bundle": "campaign",
  "@cinatra-ai/campaigns:email-followup-bundle": "campaign",
  "@cinatra-ai/campaigns:send-attempt": "campaign",
} as const satisfies Record<string, UiFamily>;

export type KnownObjectTypeId = keyof typeof OBJECT_TYPE_FAMILY;

/** All locked object type ids whose UiFamily is `family`. */
export function objectTypeIdsForFamily(family: UiFamily): string[] {
  return Object.entries(OBJECT_TYPE_FAMILY)
    .filter(([, f]) => f === family)
    .map(([id]) => id)
    .sort();
}

/** The UiFamily of a locked object type id, or `undefined` if not in the set. */
export function uiFamilyForTypeId(id: string): UiFamily | undefined {
  return (OBJECT_TYPE_FAMILY as Record<string, UiFamily>)[id];
}

/** True when `id` is a locked, taxonomy-known static object type. */
export function isKnownObjectTypeId(id: string): id is KnownObjectTypeId {
  return Object.prototype.hasOwnProperty.call(OBJECT_TYPE_FAMILY, id);
}
