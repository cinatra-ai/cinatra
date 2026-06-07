// ---------------------------------------------------------------------------
// Machine-readable objects-surface inventory.
// ---------------------------------------------------------------------------
//
// This is the single mandatory source of truth for object-surface inventory
// tests, replacement-coverage tests, and internal inventory assertions.
// It is hand-authored because these surfaces are not all machine-discoverable.
//
// Scope: this file inventories and classifies objects-related surfaces.
// Actual removal or conversion work happens in the owning implementation files:
// entity-read bypass removal, primitive unregistration, campaign raw-SQL
// conversion to canonical objects access, agent-prompt call-shape fixes, and
// dynamic-type dispositions.

import type { WrapperPrimitive } from "@cinatra-ai/objects";

// ---------------------------------------------------------------------------
// Carve-out commitment.
// A typed `CarveOut` registry does not exist in code. The inventory therefore
// fails closed: there is no carve-out escape hatch, and any uninventoried
// object-surface bypass fails CI.
// ---------------------------------------------------------------------------
export const CARVE_OUT_MODE = "fail-closed" as const;

// ---------------------------------------------------------------------------
// Wrapper primitives -> canonical replacement.
// `registered: false` means the wrapper primitive is still registered. The
// tool-count test asserts these registrations exist while `registered: false`,
// and asserts their absence once the registry stops exposing them.
// ---------------------------------------------------------------------------
export type LegacyPrimitiveEntry = {
  name: WrapperPrimitive;
  registry: string;
  registered: boolean;
  replacement: string;
  /**
   * When `true`, the in-process handler implementation under
   * `<registry-dir>/handlers.ts` is INTENTIONALLY retained even though the
   * MCP-wire registry no longer exposes the primitive. This is the staged
   * retirement window — wire surface goes dark first, handler files are
   * deleted alongside the package stubs in a later slice. The drift test
   * (`objects-surface-drift.test.ts`) consults this flag to permit handler
   * presence while still requiring registry absence.
   */
  handlerRetained?: boolean;
};

export const LEGACY_PRIMITIVES: readonly LegacyPrimitiveEntry[] = [
  // accounts_* -- packages/entity-accounts/src/mcp/registry.ts (retired)
  { name: "accounts_list",   registry: "packages/entity-accounts/src/mcp/registry.ts", registered: false, replacement: "crm_account_search({ query })" },
  { name: "accounts_get",    registry: "packages/entity-accounts/src/mcp/registry.ts", registered: false, replacement: "crm_account_get({ id })" },
  { name: "accounts_create", registry: "packages/entity-accounts/src/mcp/registry.ts", registered: false, replacement: "crm_account_create({ name, domainName?, apolloOrganizationId?, inLists? })" },
  { name: "accounts_update", registry: "packages/entity-accounts/src/mcp/registry.ts", registered: false, replacement: "crm_account_update({ id, patch })" },
  { name: "accounts_delete", registry: "packages/entity-accounts/src/mcp/registry.ts", registered: false, replacement: "no CRM equivalent - operator deletes via Twenty UI" },
  // contacts_* -- packages/entity-contacts/src/mcp/registry.ts (retired)
  { name: "contacts_list",         registry: "packages/entity-contacts/src/mcp/registry.ts", registered: false, replacement: "crm_contact_search({ query })" },
  { name: "contacts_get",          registry: "packages/entity-contacts/src/mcp/registry.ts", registered: false, replacement: "crm_contact_get({ id })" },
  { name: "contacts_create",       registry: "packages/entity-contacts/src/mcp/registry.ts", registered: false, replacement: "crm_contact_create({ name, email?, accountId?, ... })" },
  { name: "contacts_update",       registry: "packages/entity-contacts/src/mcp/registry.ts", registered: false, replacement: "crm_contact_update({ id, patch })" },
  { name: "contacts_delete",       registry: "packages/entity-contacts/src/mcp/registry.ts", registered: false, replacement: "no CRM equivalent - operator deletes via Twenty UI" },
  { name: "contacts_sources_list", registry: "packages/entity-contacts/src/mcp/registry.ts", registered: false, replacement: "no CRM equivalent - segment-by-campaign-source surface retired with the legacy entity-contacts shape" },
  // lists_* -- packages/lists/src/mcp/registry.ts (wire-retired; the
  // in-process handler bodies were emptied with the package's
  // deprecation-stub slice — createListPrimitiveHandlers() now returns {}).
  { name: "lists_list",            registry: "packages/lists/src/mcp/registry.ts", registered: false, replacement: "crm_list_search({ query, objectType? })" },
  { name: "lists_get",             registry: "packages/lists/src/mcp/registry.ts", registered: false, replacement: "crm_list_get({ id })" },
  { name: "lists_create",          registry: "packages/lists/src/mcp/registry.ts", registered: false, replacement: "crm_list_create({ slug, name, objectType }) + per-member crm_list_member_add (non-atomic; idempotent per-member)" },
  { name: "lists_update",          registry: "packages/lists/src/mcp/registry.ts", registered: false, replacement: "no CRM equivalent - Twenty Views are renamed via the Twenty UI" },
  { name: "lists_delete",          registry: "packages/lists/src/mcp/registry.ts", registered: false, replacement: "no CRM equivalent - Twenty Views are deleted via the Twenty UI" },
  { name: "lists_members_add",     registry: "packages/lists/src/mcp/registry.ts", registered: false, replacement: "crm_list_member_add({ listId, objectId, objectType }) (per-member, idempotent)" },
  { name: "lists_members_remove",  registry: "packages/lists/src/mcp/registry.ts", registered: false, replacement: "crm_list_member_remove({ listId, objectId, objectType }) (per-member, idempotent)" },
  { name: "lists_members_count",   registry: "packages/lists/src/mcp/registry.ts", registered: false, replacement: "crm_list_members_get({ listId }) + caller-side .length on returned { contactIds, accountIds }" },
];

// ---------------------------------------------------------------------------
// Raw `cinatra.objects` table access allow-list.
// Every file that reads or writes the objects table via raw SQL or drizzle
// matching the `."objects"` quoted-identifier pattern. The inventory test
// asserts the live set is contained by this allow-list, so a new raw access
// file without an entry fails CI.
// `category`: "substrate" = the canonical store / schema / artifact substrate
// (legitimate, stays); "entity-bypass" = entity access that should not use raw
// object rows; "campaign-bypass" = campaign access that should use canonical
// objects APIs.
// ---------------------------------------------------------------------------
export type RawObjectAccessEntry = {
  file: string;
  category: "substrate" | "entity-bypass" | "campaign-bypass";
  note: string;
};

export const RAW_OBJECT_ACCESS_ALLOWLIST: readonly RawObjectAccessEntry[] = [
  // -- canonical substrate (legitimate; the implementation of objects_*) --
  { file: "src/lib/objects-store.ts",                        category: "substrate", note: "canonical objects store (getObjectById/upsert/listObjectsByFilter) used by objects_* handlers" },
  { file: "src/lib/drizzle-store.ts",                        category: "substrate", note: "schema DDL builder (buildCreateStoreSchemaQueries)" },
  { file: "src/lib/resource-project-move.ts",                category: "substrate", note: "objects_update project-move audit cascade" },
  { file: "packages/objects/src/graphiti-projector.ts",      category: "substrate", note: "Graphiti projection reads object rows" },
  { file: "src/app/projects/[projectId]/page.tsx",           category: "substrate", note: "project sealed-room object count" },
  // -- object-history substrate (canonical history-aware writer + restore eligibility) --
  { file: "src/lib/object-history/canonical-writer.ts",      category: "substrate", note: "canonical history-aware writer — every objects mutation flows through the atomic CTE (object mutation + change-event + outbox in one transaction)" },
  { file: "src/lib/object-history/eligibility.ts",           category: "substrate", note: "restore-time eligibility reads object scope/version from the objects table" },
  // -- artifacts substrate (blob/version internals are outside this inventory) --
  { file: "src/lib/artifacts/context-resolver.ts",           category: "substrate", note: "artifacts substrate (blob/version internals are out of scope)" },
  { file: "src/lib/artifacts/artifact-creation.ts",          category: "substrate", note: "artifacts substrate" },
  { file: "src/lib/artifacts/artifact-retention.ts",         category: "substrate", note: "artifacts substrate" },
  { file: "src/lib/artifacts/semantic-assertion-store.ts",   category: "substrate", note: "artifacts substrate" },
  { file: "src/lib/artifacts/run-context-selections-store.ts", category: "substrate", note: "artifacts substrate" },
  { file: "src/lib/artifacts/matcher-runtime.ts",            category: "substrate", note: "artifacts substrate" },
  { file: "src/lib/artifacts/artifact-read.ts",              category: "substrate", note: "artifacts substrate" },
  // No live entity-bypass remains; the raw-objects-table scan re-asserts this.
];

// ---------------------------------------------------------------------------
// SKILL.md / OAS / invalid-call-shape references.
// Inventoried references that need canonical objects call shapes.
// ---------------------------------------------------------------------------
export type SkillOasRefEntry = {
  file: string;
  line: number;
  issue: "legacy-primitive" | "invalid-type-id-shape" | "invalid-id-shape";
  note: string;
};

export const SKILL_OAS_REFS: readonly SkillOasRefEntry[] = [
  { file: "extensions/cinatra-ai/email-outreach-agent/cinatra/oas.json",            line: 1160, issue: "invalid-type-id-shape", note: 'objects_get({ type: "contact", id }) -> objects_get({ objectId })' },
  { file: "extensions/cinatra-ai/email-recipient-selection-agent/cinatra/oas.json", line: 277,  issue: "invalid-type-id-shape", note: "objects_get({ type, id }) -> objects_get({ objectId })" },
  { file: "extensions/cinatra-ai/email-recipient-selection-agent/skills/email-recipient-selection/SKILL.md", line: 42, issue: "invalid-type-id-shape", note: "objects_get({ type, id }) -> objects_get({ objectId })" },
  { file: "extensions/cinatra-ai/contact-discovery-agent/skills/contact-discovery-agent/SKILL.md", line: 36,  issue: "invalid-id-shape", note: "objects_get({ id }) -> objects_get({ objectId })" },
  { file: "extensions/cinatra-ai/contact-discovery-agent/skills/contact-discovery-agent/SKILL.md", line: 216, issue: "invalid-id-shape", note: "objects_get({ id }) -> objects_get({ objectId })" },
  { file: "extensions/cinatra-ai/company-discovery-agent/skills/company-discovery-agent/SKILL.md", line: 20,  issue: "legacy-primitive", note: "accounts_list -> objects_list" },
  { file: "extensions/cinatra-ai/email-recipient-selection-agent/skills/email-recipient-selection/SKILL.md", line: 40, issue: "legacy-primitive", note: "contacts_list -> objects_list" },
];

// ---------------------------------------------------------------------------
// Dynamic type inventory + disposition.
// ---------------------------------------------------------------------------
export type DynamicTypeEntry = {
  typeId: string;
  disposition: "promote" | "internal" | "retire";
  note: string;
};

export const DYNAMIC_TYPES: readonly DynamicTypeEntry[] = [
  { typeId: "@cinatra-ai/dynamic:email-drafts-bundle",            disposition: "promote",  note: "durable campaign product -> @cinatra-ai/campaigns:email-draft-bundle" },
  { typeId: "@cinatra-ai/dynamic:email-followup-bundle",          disposition: "promote",  note: "durable -> @cinatra-ai/campaigns:email-followup-bundle" },
  { typeId: "@cinatra-ai/dynamic:approved-email-draft-bundle",    disposition: "promote",  note: "reviewer-approved durable output" },
  { typeId: "@cinatra-ai/dynamic:approved-email-followup-bundle", disposition: "promote",  note: "reviewer-approved durable output" },
  { typeId: "@cinatra-ai/dynamic:email-recipients-bundle",        disposition: "promote",  note: "durable alias of @cinatra-ai/campaigns:recipients" },
  { typeId: "@cinatra-ai/dynamic:blog-pipeline-selected-idea",    disposition: "internal", note: "transient agent-to-UI passthrough; mark internal" },
  { typeId: "@cinatra-ai/dynamic:blog-pipeline-draft-projection", disposition: "internal", note: "transient LinkedIn draft projection; mark internal" },
];

// ---------------------------------------------------------------------------
// Artifact-ref consumer surface (substrate out of scope).
// List member-resolution surface (no generic-collection redesign).
// ---------------------------------------------------------------------------
export const ARTIFACT_SURFACE = {
  typeId: "@cinatra-ai/artifact:object",
  consumerFiles: [
    "packages/objects/src/graphiti-projector.ts",
    "packages/objects/src/integration/register-artifact-extensions.ts",
    "src/lib/artifacts/artifact-service.ts",
  ],
  substrateNote:
    "Blob/version/storage internals in packages/artifacts/ are out of scope (consumer surface only).",
} as const;

export const LIST_SURFACE = {
  typeId: "@cinatra-ai/lists:list",
  memberRefTypes: [
    "@cinatra-ai/entity-accounts:account",
    "@cinatra-ai/entity-contacts:contact",
  ],
  note:
    "Member resolution routes through canonical objects_* (list-adapters deterministic client). No generic-collection schema redesign.",
} as const;

// ---------------------------------------------------------------------------
// Delegated-chat allowlist (object-relevant entries). The inventory test
// asserts the live allowlist matches this set. Chat reads accounts, contacts,
// and CRM lists via the canonical `objects_*` (for shared object types) plus
// the provider-agnostic `crm_*` facade (for CRM read paths).
//
// `lists_list` + `lists_get` removed (entries retired alongside the
// unregistered `lists_*` MCP primitives). The CRM-facade read replacements
// are listed below; the live allowlist in
// `packages/mcp-server/src/delegated-chat-tool-policy.ts` `ALLOWED_EXACT`
// must match this set (parity asserted by the inventory test).
// ---------------------------------------------------------------------------
export const DELEGATED_CHAT_OBJECT_ALLOWLIST: readonly string[] = [
  "objects_list",
  "objects_get",
  "crm_list_search",
  "crm_list_get",
  "crm_list_members_get",
  "crm_account_search",
  "crm_account_get",
  "crm_contact_search",
  "crm_contact_get",
  "crm_contact_find_by_email",
];
