import "server-only";
import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { buildActorContextFromPrimitive } from "@/lib/authz/build-actor-context";
import type { ActorContext } from "@/lib/authz/actor-context";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { readAgentContextSlotsFromOas } from "@cinatra-ai/extensions/agent-context-slots-reader";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { getArtifact } from "./artifact-service";
import {
  resolveContextSlot,
  type InstalledExtensionDescriptor,
  type ResolvedContextRef,
} from "./context-resolver";

// ---------------------------------------------------------------------------
// `context_*` MCP primitives.
//
// Two primitives:
//   - context_resolve(input): given a parent agent's slot id + its OAS,
//     resolve eligible refs for the calling actor. The MCP handler derives
//     installedExtensions from the local object registry (NEVER trusts
//     caller-supplied lists).
//   - context_list_eligible_assertions(input): inspection primitive listing
//     eligible assertions for a given artifact id. Read-only.
//
// Both primitives gate on the actor-context kernel via the standard
// mcp-context storage (a2a precedence + org fail-closed).
// ---------------------------------------------------------------------------

const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');

const resolveSchema = z
  .object({
    /** The parent agent's OAS object as installed locally. The MCP
     *  handler parses contextSlots and finds the slot by `slotId`. */
    parentAgentOas: z.unknown(),
    /** The slot id to resolve (must exist on the parent agent's OAS). */
    slotId: z.string().min(1),
    /** Optional project refinement (must be in the actor's projectIds
     *  set or the resolver fails closed and returns `[]`). */
    projectId: z.string().min(1).optional(),
  })
  .strict();

const listEligibleSchema = z
  .object({
    artifactId: z.string().min(1),
  })
  .strict();

const TOOL_META = {
  context_resolve: {
    description:
      "Resolve a parent agent's context slot for the calling actor. " +
      "Returns eligible artifact refs (pinned at resolution time as " +
      "{artifactId, representationRevisionId, semanticAssertionId, " +
      "extension, sourceScope, ownerId}) ordered narrow→broad and " +
      "filtered by the slot's resolutionMode (override|accumulate). " +
      "Walks user→team→org→workspace ownership; project refinement is " +
      "applied when projectId is provided AND present in the actor's " +
      "projectIds. Filters on eligibility = 'eligible' only.",
    inputSchema: resolveSchema,
  },
  context_list_eligible_assertions: {
    description:
      "Read-only inspection primitive — list eligible semantic " +
      "assertions for an artifact (matcher drafts excluded). For debug " +
      "and admin surfaces; agentic flows should prefer context_resolve.",
    inputSchema: listEligibleSchema,
  },
} as const;

// ---------------------------------------------------------------------------
// Actor resolution — mirrors src/lib/artifacts/mcp.ts:resolveActor
// ---------------------------------------------------------------------------

function resolveActorAndOrg(): {
  orgId: string;
  userId: string | null;
  actor: ActorContext;
} {
  const ctx = mcpRequestContextStorage.getStore();
  const a2a = ctx?.a2aActorContext;
  const userId = a2a?.userId ?? ctx?.userId ?? null;
  const orgId = (a2a ? a2a.orgId : ctx?.orgId) ?? null;
  if (!orgId) {
    throw new Error(
      "context MCP: no active organization (fail-closed — refusing an unscoped read" +
        (a2a ? "; A2A context carries no orgId" : "") +
        ")",
    );
  }
  const platformRole = ctx?.platformRole;
  const primitive = {
    actorType: a2a ? "a2a" : platformRole ? "human" : "model",
    source: a2a ? "a2a" : "agent",
    ...(userId ? { userId } : {}),
    ...(a2a?.tokenScopes ? { tokenScopes: a2a.tokenScopes } : {}),
  } as Parameters<typeof buildActorContextFromPrimitive>[0];
  const actor = buildActorContextFromPrimitive(primitive, orgId, {
    platformRole,
    // Transport-resolved org-membership role — non-A2A only (the A2A
    // branch's identity comes from a2aActorContext, potentially a
    // different user/org; see src/lib/artifacts/mcp.ts).
    orgRole: a2a ? undefined : ctx?.orgRole,
    actorOrganizationId: orgId,
    teamIds: a2a?.teamIds,
    projectIds: a2a?.projectIds,
  }) as unknown as ActorContext;
  return { orgId, userId, actor };
}

function envelope(payload: unknown) {
  const resolved = payload === undefined ? null : payload;
  return {
    content: [{ type: "text", text: JSON.stringify(resolved) }],
    structuredContent:
      typeof resolved === "object" && resolved !== null
        ? (resolved as Record<string, unknown>)
        : { result: resolved },
  };
}

// ---------------------------------------------------------------------------
// Server-side installed-extension discovery
// ---------------------------------------------------------------------------

/** Derive the installed-extension descriptors server-side from the
 *  object registry (NEVER trust caller-supplied
 *  installedExtensions). Walks `objectTypeRegistry.listArtifacts()` and
 *  extracts each manifest's `satisfies` array.
 *
 *  Warm the app-level registry FIRST via `registerAllObjectTypes()`.
 *  Without this, the satisfies-graph
 *  expansion could be order-dependent: a context_resolve call before the
 *  artifact registry is lazily warmed would see an empty extension list. */
export function getInstalledExtensionDescriptors(): InstalledExtensionDescriptor[] {
  registerAllObjectTypes();
  const ARTIFACT_TYPE_SUFFIX = ":artifact";
  const descriptors: InstalledExtensionDescriptor[] = [];
  for (const def of objectTypeRegistry.listArtifacts()) {
    if (!def.type.endsWith(ARTIFACT_TYPE_SUFFIX)) continue;
    const extension = def.type.slice(
      0,
      def.type.length - ARTIFACT_TYPE_SUFFIX.length,
    );
    if (!extension) continue;
    const manifest = def.isArtifact;
    if (!manifest) continue;
    descriptors.push({
      extension,
      satisfies: Array.isArray(manifest.satisfies) ? [...manifest.satisfies] : [],
    });
  }
  return descriptors;
}

// ---------------------------------------------------------------------------
// Duplicate-slot-id rejection
// ---------------------------------------------------------------------------

/** Find the named slot in an agent's contextSlots. Throws if the OAS
 *  declares duplicate slot ids. The reader intentionally does NOT enforce
 *  uniqueness — the consumer side does. */
function findSlotOrThrow(oas: unknown, slotId: string) {
  const slots = readAgentContextSlotsFromOas(oas);
  const matches = slots.filter((s) => s.slotId === slotId);
  if (matches.length === 0) {
    throw new Error(
      `[context_resolve] no contextSlot with slotId='${slotId}' found on the parent agent OAS`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `[context_resolve] duplicate slotId='${slotId}' on the parent agent OAS — ` +
        `slot ids must be unique per agent (resolver rejects ambiguity)`,
    );
  }
  return matches[0];
}

// ---------------------------------------------------------------------------
// context_list_eligible_assertions — direct DB read
// ---------------------------------------------------------------------------

function listEligibleAssertionsForArtifact(input: {
  orgId: string;
  artifactId: string;
}): Array<{
  semanticAssertionId: string;
  extension: string;
  assertedBy: string;
  confidence: number | null;
  assertedAt: string;
}> {
  ensurePostgresSchema();
  const schema = q();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT id, extension, asserted_by, confidence, asserted_at
FROM "${schema}"."semantic_assertion"
WHERE org_id = $1 AND artifact_id = $2 AND eligibility = 'eligible'
ORDER BY asserted_at DESC, id ASC`,
        values: [input.orgId, input.artifactId],
      },
    ],
  });
  type Row = {
    id: string;
    extension: string;
    asserted_by: string;
    confidence: number | null;
    asserted_at: Date | string;
  };
  return (res?.rows ?? []).map((r) => {
    const row = r as Row;
    return {
      semanticAssertionId: row.id,
      extension: row.extension,
      assertedBy: row.asserted_by,
      confidence: row.confidence,
      assertedAt:
        row.asserted_at instanceof Date
          ? row.asserted_at.toISOString()
          : String(row.asserted_at),
    };
  });
}

// ---------------------------------------------------------------------------
// Public registration
// ---------------------------------------------------------------------------

export function registerContextPrimitives(server: McpRuntimeToolServer): void {
  server.registerTool(
    "context_resolve",
    { title: "context_resolve", ...TOOL_META.context_resolve },
    (async (input: unknown) => {
      const parsed = resolveSchema.parse(input ?? {});
      const { actor } = resolveActorAndOrg();
      const slot = findSlotOrThrow(parsed.parentAgentOas, parsed.slotId);
      const installedExtensions = getInstalledExtensionDescriptors();
      const refs: ResolvedContextRef[] = resolveContextSlot({
        actor,
        slot,
        projectId: parsed.projectId,
        installedExtensions,
      });
      return envelope({
        slotId: slot.slotId,
        resolutionMode: slot.resolutionMode,
        refs,
      });
    }) as never,
  );

  server.registerTool(
    "context_list_eligible_assertions",
    {
      title: "context_list_eligible_assertions",
      ...TOOL_META.context_list_eligible_assertions,
    },
    (async (input: unknown) => {
      const { artifactId } = listEligibleSchema.parse(input ?? {});
      const { orgId, actor } = resolveActorAndOrg();
      // Gate per-artifact actor visibility BEFORE returning assertions.
      // Mirrors the
      // `artifact_assertion_list` pattern in mcp.ts: call
      // `getArtifact({...,actor})` first; throw 404 if the actor can't
      // see the artifact. Without this gate, any org-scoped MCP caller
      // could enumerate assertions on artifacts outside their owner /
      // team / project visibility.
      const visible = getArtifact({ artifactId, orgId, actor });
      if (!visible) throw new Error(`artifact ${artifactId} not found`);
      const assertions = listEligibleAssertionsForArtifact({
        orgId,
        artifactId,
      });
      return envelope({ artifactId, assertions });
    }) as never,
  );
}

export function createContextModule() {
  return {
    registerCapabilities: registerContextPrimitives,
  };
}
