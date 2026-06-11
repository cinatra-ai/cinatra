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
// Register workflow / workflow_template as known object types.
import { registerWorkflowObjectTypes } from "@cinatra-ai/workflows/integration/register-object-types";
import path from "node:path";
// Object-registry descriptor bridge: scans extensions/cinatra-ai/*-artifact
// and registers each as a generic artifact-bearing object type, consumed
// generically via objectTypeRegistry.listArtifacts().
import { registerArtifactExtensions } from "@cinatra-ai/objects/register-artifact-extensions";
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
  runExtensionObjectTypeRegistrars();
  registerBlogObjectTypes();
  registerAgentBuilderObjectTypes();
  registerWorkflowObjectTypes();
  // Bridge built-in + any added kind:"artifact" extensions into the object
  // registry as generic artifact-bearing types.
  registerArtifactExtensions(
    path.join(process.cwd(), "extensions", "cinatra-ai"),
  );
  // Artifact rows carry `objects.type = "@cinatra-ai/artifact:object"`.
  // Artifact-service.ts filters directly on the constant, bypassing the
  // registry, so functional reads work — but generic object tooling (e.g.,
  // `objectTypeRegistry.listArtifacts()` consumers, navigation routes, the
  // data/new wizard) needs this type registered. Register a minimal definition
  // with `isArtifact` set to the generic any-form manifest so the type appears
  // in `listArtifacts()`.
  registerSemanticArtifactObjectType();
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

function registerSemanticArtifactObjectType(): void {
  // Top-level imports for the objects barrel + zod: the barrel cost
  // is paid once per process either way, and the import discipline is
  // worth more than a deferred load.
  // Renderers are React-free `unknown` slots at the type layer — the
  // bridge's per-extension entries fill them with generic renderers
  // imported from the objects package's internal subpath. The generic
  // SEMANTIC_ARTIFACT_OBJECT_TYPE row never reaches a list/card/detail
  // surface yet; use null placeholders until the semantic library provides
  // real renderers.
  objectTypeRegistry.register({
    type: "@cinatra-ai/artifact:object",
    category: "report",
    schema: z.record(z.string(), z.unknown()),
    lifecycle: {
      sources: ["agent", "user", "import"],
      mutableBy: ["agent", "user"],
    },
    renderers: {
      listRow: null,
      card: null,
      detail: null,
    },
    isArtifact: {
      // Generic any-form manifest. The semantic identity of each row comes
      // from `semantic_assertion`, not from this descriptor.
      accepts: {
        file: { mimeTypes: ["*/*"] },
        connectorRef: { resolvedMimeTypes: ["*/*"] },
        dashboard: true,
      },
    },
  });
}
