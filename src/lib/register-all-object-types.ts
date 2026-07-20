import "server-only";

// Extension-shipped object types (the CRM account / contact / list set today)
// register through the `object-type-registrar` capability their connector
// registers at activation — resolved generically here, never by importing an
// extension package by name (lazy/guarded host-access cutover).
import { runExtensionObjectTypeRegistrars } from "@/lib/extension-object-type-registrars";
// Blog object types are registered from the host module. The host helper
// delegates to the asset-blog implementation.
import { registerBlogObjectTypes } from "@/lib/blog-project-store";
import { registerAgentBuilderObjectTypes } from "@cinatra-ai/agents/integration/register-object-types";
import path from "node:path";
// Object-registry descriptor bridge: scans extensions/cinatra-ai/*-artifact
// and registers each as a generic artifact-bearing object type, consumed
// generically via objectTypeRegistry.listArtifacts().
import { registerArtifactExtensions } from "@cinatra-ai/objects/register-artifact-extensions";
// Host CLAIM object types shipped by the objects package (@cinatra-ai/email:body,
// campaign/linkedin/drupal/wordpress/memory, and the generic objects:object
// catch-all). Imported through the NARROW registration subpath — NOT
// `@cinatra-ai/objects/module`, whose createObjectsModule() barrel also drags in
// the deterministic MCP client + the MCP primitive registry (cinatra#1866).
import { registerAllObjectTypes as registerObjectsPackageObjectTypes } from "@cinatra-ai/objects/register-object-types";
import { objectTypeRegistry, objectTypeIdsForFamily } from "@cinatra-ai/objects";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Family type ID sets
// ---------------------------------------------------------------------------

// Derived from the single code-owned taxonomy
// (`packages/objects/src/taxonomy.ts`) so the classifier registration path and
// this app/UI registry path cannot drift. Lists and agent templates are NOT
// entities — they carry their own UiFamily ("list" / "agent") and live in
// their own registries, so they do not appear here.
export const ASSET_TYPE_IDS = new Set(objectTypeIdsForFamily("asset"));

export const ENTITY_TYPE_IDS = new Set(objectTypeIdsForFamily("entity"));

// ---------------------------------------------------------------------------
// Creation URL map
// ---------------------------------------------------------------------------

export const OBJECT_TYPE_NEW_URLS: Record<string, string> = {
  "@cinatra-ai/agent-builder:agent-template":          "/chat",
  // Blog types (`@cinatra-ai/assets:blog-project|blog-idea|blog-post`) have
  // NO standalone /new route — creation flows through the dashboard portlets
  // shipped by the `@cinatra-ai/blog-content-workflow` extension.
  // CRM types (account / contact / list) — creation flows through agent
  // dispatch (`company-discovery-agent`, `contact-discovery-agent`,
  // `apollo-prospecting-agent`, `list-curator-agent`) rather than a cinatra
  // /new route. CRM types (account / contact / list) have no cinatra-side
  // read surface — they live in Twenty and are reached via the `crm_*` MCP
  // facade.
};

// ---------------------------------------------------------------------------
// registerAllObjectTypes
// ---------------------------------------------------------------------------

export function registerAllObjectTypes(): void {
  // Objects-package CLAIM types FIRST (cinatra#1866). Before this, they were
  // registered ONLY as a module-top-level side effect of importing
  // `@/lib/mcp-server` (createObjectsModule()), so a process that never served
  // an MCP HTTP request — the production worker / run-completion path — had
  // `@cinatra-ai/email:body` UNREGISTERED. `resolveBoundArtifactTarget`
  // intersects each winning org claim with a currently-registered host type
  // (readEffectiveArtifactSafeTypeIdsForExtension), so the intersection was
  // empty and run-completion materialization failed CLOSED (`declares: [none]`,
  // zero artifacts). Registering here makes claim-type availability an INVARIANT
  // of every registry warm — the materializer's two call sites,
  // `ensureArtifactTypesRegistered`, artifact-service, context-mcp, authoring,
  // template, url-import, matcher-runtime — instead of incidental HTTP import
  // ordering. Runs FIRST to establish the foundational package built-ins before
  // the host/extension registrars run; the ids are DISJOINT from the host
  // registrars below (email/campaign/… vs blog/agent-builder/artifact-ref), so
  // ordering is not a correctness lever here. All of these register as
  // null-definer built-ins, so the registry's guard treats a same-id repeat as
  // an idempotent replace and throws `ObjectTypeDefinitionConflictError` only on
  // a genuine cross-definer collision (registry.ts) — this call cannot silently
  // clobber, nor be clobbered by, an extension-owned type. `createObjectsModule()`
  // keeps its own call — the registrar is idempotent, so the MCP path is
  // byte-for-byte unchanged.
  registerObjectsPackageObjectTypes();
  runExtensionObjectTypeRegistrars();
  registerBlogObjectTypes();
  registerAgentBuilderObjectTypes();
  // Bridge built-in + any added kind:"artifact" extensions into the object
  // registry as generic artifact-bearing types. Pass the extensions ROOT (not
  // a single vendor dir): the bridge scans `<root>/*-artifact` AND
  // `<root>/<vendor>/*-artifact`, so a THIRD-VENDOR `kind:"artifact"` package
  // registers exactly like a first-party one (cinatra#1425 multi-vendor fix —
  // passing `extensions/cinatra-ai` here silently skipped every other vendor
  // root). Ids keep their vendor scope (`@<vendor>/<pkg>:artifact`).
  registerArtifactExtensions(path.join(process.cwd(), "extensions"));
  // The generic `@cinatra-ai/artifact:object` catch-all type registration is
  // RETIRED (epic #1785, wave A3): every artifact row now carries its exact
  // declared pack type in `objects.type`, validated at the writer. There is no
  // generic any-form type to register — an upload maps its MIME to a concrete
  // system-base pack (pdf/audio/video/image) or is refused.
  registerArtifactRefObjectType();
}

// Typed artifact-ref reference contract.
// Distinct from the generic `@cinatra-ai/artifact:object` catch-all above: a
// blog-post (and other object types) carry artifact refs (blob/version pointers
// from packages/artifacts/) in their `data`; registering this type makes those
// refs a CLASSIFIED, typed surface rather than a silently-dynamic second object
// surface. No row is created per ref — the type exists for classification;
// blob/version mechanics in packages/artifacts/ are untouched.
function registerArtifactRefObjectType(): void {
  objectTypeRegistry.register({
    type: "@cinatra-ai/artifacts:artifact-ref",
    category: "report",
    schema: z
      .object({
        artifactId: z.string(),
        representationRevisionId: z.string(),
        artifactType: z.string().optional(),
      })
      .passthrough(),
    lifecycle: {
      sources: ["agent", "user", "import"],
      mutableBy: ["agent", "user"],
    },
    renderers: {
      listRow: null,
      card: null,
      detail: null,
    },
    // Artifact refs are MATERIALIZER-OWNED:
    // the artifact-creation pipeline writes the blob + the ref together (see
    // `src/lib/blog-image-materializer.ts` and friends). An agent should never
    // auto-create or auto-overwrite an artifact-ref via the auto-mapping
    // dispatcher — those are real persistence side-effects that must go
    // through the materializer's lock + idempotency contract. Always HITL.
    crudPolicy: {
      onMatch: "skip",
      onNoMatch: "hitl",
      requiredFields: ["artifactId", "representationRevisionId"],
    },
  });
}

