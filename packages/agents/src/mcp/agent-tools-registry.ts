import "server-only";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getActorContext } from "@cinatra-ai/llm/actor-context";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import {
  readPublishedAgentTemplates,
  isAgentPubliclyDiscoverable,
  createAgentRun,
  readAgentRunById,
} from "../store";
// ---------------------------------------------------------------------------
// MCP tool name sanitization
// ---------------------------------------------------------------------------

/**
 * Convert an npm-scoped package name into an MCP SDK-valid tool name.
 *
 * MCP SDK validates tool names against /^[A-Za-z0-9._-]{1,128}$/.
 * npm scoped names like "@cinatra-ai/email-outreach-agent" contain @ and /
 * which are not in the allowed character set.
 *
 * Transformation:
 *   "@cinatra-ai/email-outreach-agent" -> "cinatra-agents_email-outreach"
 *   "email-outreach"                 -> "email-outreach" (no-op for plain names)
 */
export function sanitizePackageNameToToolName(packageName: string): string {
  return packageName
    .replace(/^@/, "")                    // strip leading @
    .replace(/\//g, "_")                  // replace / with _
    .replace(/[^A-Za-z0-9._-]/g, "-")    // replace any other illegal chars with -
    .replace(/^[-.]|[-.]$/g, "")          // strip leading/trailing - or .
    .slice(0, 128);                       // enforce 128 char max
}

// ---------------------------------------------------------------------------
// Dynamic MCP tool registration for published agent templates
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 3_000;
const MAX_WAIT_MS = 60 * 1_000;

// ---------------------------------------------------------------------------
// Canonical install/lifecycle gate (true-IoC).
//
// The dynamic agent MCP tool surface consumes the canonical
// `installed_extension` gate so an archived / uninstalled / never-installed
// agent stops being registered as a tool the moment its manifest is no longer
// `active|locked`. The gate provider is HOST-INJECTED — the canonical store
// lives in `@cinatra-ai/extensions`, which depends on THIS package, so importing
// it here would create an agents↔extensions cycle. The host
// (`src/lib/mcp-server.ts`) wires `readActiveManifestsFromStore({kind:"agent"})`
// into the slot below.
//
// Scope note: this is the GLOBAL, actor-less tool-registration boundary. It
// applies the lifecycle gate (active|locked manifest) AND the visibility
// policy — PRIVATE agents are excluded (isAgentPubliclyDiscoverable); only
// public/grandfathered-null published agents register. (Per-actor scoping —
// showing a viewer their tenant's private agents — would be a future enhancement
// layered on top, not global advertisement.)
//
// Fail-open by design: when no provider is wired (package-local tests; a host
// that has not opted in) or the provider throws, the gate is INERT and every
// published template registers — i.e. the pre-gate behavior, never a NEW
// exposure (tool invocation stays auth-gated regardless).
// ---------------------------------------------------------------------------

/** Returns the set of agent package names with an `active|locked` canonical
 *  manifest, or `null` to signal "gate unavailable → register all". */
export type LiveAgentManifestProvider = () => Promise<Set<string> | null>;

const LIVE_AGENT_MANIFEST_PROVIDER_SLOT = Symbol.for(
  "cinatra.agents.liveAgentManifestProvider.v1",
);
type ProviderHolder = { provider: LiveAgentManifestProvider | null };
function providerHolder(): ProviderHolder {
  const g = globalThis as unknown as Record<symbol, ProviderHolder | undefined>;
  return (g[LIVE_AGENT_MANIFEST_PROVIDER_SLOT] ??= { provider: null });
}

/** Host wiring entry: inject the canonical-manifest gate provider. Pass `null`
 *  to clear (tests). */
export function setLiveAgentManifestProvider(
  provider: LiveAgentManifestProvider | null,
): void {
  providerHolder().provider = provider;
}

/**
 * Dynamically register each published agent template (with a packageName) as
 * an MCP tool on the runtime server. Called per-request from
 * registerAgentBuilderPrimitives.
 *
 * Tool name = sanitizePackageNameToToolName(template.packageName).
 * Tool handler = create agent_run, enqueue BullMQ job, poll up to 60s.
 *
 * Published templates are gated through the canonical install/lifecycle
 * manifest (see the gate note above): only those whose package has an
 * `active|locked` `installed_extension` row are registered. `opts` lets a unit
 * test inject the gate directly; production wires it once via
 * `setLiveAgentManifestProvider`.
 */
export async function registerPublishedAgentTools(
  server: McpRuntimeToolServer,
  opts?: { getLiveAgentPackageNames?: LiveAgentManifestProvider },
): Promise<void> {
  let templates: Awaited<ReturnType<typeof readPublishedAgentTemplates>>;
  try {
    templates = await readPublishedAgentTemplates();
  } catch {
    // DB unavailable — non-fatal; tools/list will simply not include agent tools
    return;
  }

  // Resolve the canonical-manifest gate. A null result (no provider wired, or a
  // provider that failed) leaves the gate inert → register every published
  // template (pre-gate behavior).
  let liveAgentPackages: Set<string> | null = null;
  const provider = opts?.getLiveAgentPackageNames ?? providerHolder().provider;
  if (provider) {
    try {
      liveAgentPackages = await provider();
    } catch {
      // Gate read failed — fail OPEN to the pre-gate behavior; never crash or
      // silently drop the entire agent tool surface on a transient gate error.
      liveAgentPackages = null;
    }
  }

  for (const template of templates) {
    if (!template.packageName) continue; // guard (should not happen given the query filter)
    // Visibility policy: the MCP tool list is global/actor-less (auth only
    // proves "some MCP client", not same-tenant), so PRIVATE agents' tool defs
    // must not be advertised here. Public + grandfathered-null only.
    if (!isAgentPubliclyDiscoverable(template)) continue;
    // Canonical install/lifecycle gate: skip published templates with no
    // active|locked manifest (archived / uninstalled / never-installed).
    if (liveAgentPackages && !liveAgentPackages.has(template.packageName)) continue;

    const toolName = sanitizePackageNameToToolName(template.packageName);
    const description = (
      template.description ?? `Run published agent: ${template.name}`
    ).slice(0, 500);

    try {
    server.registerTool(
      toolName,
      {
        title: template.name,
        description,
        inputSchema: z.object({}).passthrough(),
      },
      (async (args: unknown) => {
        const inputParams = (args && typeof args === "object") ? args as Record<string, unknown> : {};
        const result = await invokePublishedAgentTool(template.id, inputParams);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: (typeof result === "object" && result !== null)
            ? result as Record<string, unknown>
            : { result },
        };
      }) as any,
    );
    } catch (err) {
      // Skip if tool already registered on this server instance (hot-reload / per-request re-init).
      if (!(err instanceof Error) || !err.message.includes("already registered")) throw err;
    }
  }
}

/**
 * Invoke a published agent template: create a run, enqueue for execution,
 * and poll for completion up to 60 seconds. Returns the run's stepResults
 * on completion, an error object on failure, or a "launched" status on timeout.
 *
 * This mirrors the invokeAgentAsTool pattern in agentic-tools.ts but operates
 * on template IDs directly (not registry entries) since published agents are
 * discovered via agent_templates, not agent_registry_entries.
 */
async function invokePublishedAgentTool(
  templateId: string,
  inputParams: Record<string, unknown>,
): Promise<unknown> {
  const runId = randomUUID();

  // Read orgId from the ALS frame established at the route-level
  // `withActorContext` wrap. The MCP tool callback signature does NOT carry a
  // parentRunId, so we cannot look up the parent row; the parent's ALS frame is
  // the trust anchor. Hard-fail before any insert if the frame is missing or
  // has no org because agent_runs.org_id is NOT NULL.
  const ctx = getActorContext();
  const orgId = ctx?.organizationId;
  if (!orgId) {
    throw new Error(
      `invokePublishedAgentTool: missing organizationId in ActorContext (templateId=${templateId})`,
    );
  }

  await createAgentRun({
    id: runId,
    templateId,
    inputParams,
    orgId,
  });

  const { enqueueAgentRun } = await import("@/lib/agent-run-enqueue");
  await enqueueAgentRun({ runId });

  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const run = await readAgentRunById(runId);
    if (!run) continue;

    if (run.status === "completed") {
      return run.stepResults ?? {};
    }

    if (run.status === "failed") {
      return {
        error: run.error ?? "agent run failed",
        runId,
      };
    }

    if (run.status === "pending_approval") {
      return {
        status: "pending_approval",
        runId,
        message: `Agent run requires human approval. Run ID: ${runId}`,
      };
    }

    // queued or running — keep polling
  }

  return {
    status: "launched",
    runId,
    message: `Agent is still running after ${MAX_WAIT_MS / 1_000}s. Run ID: ${runId}. The agent will complete asynchronously.`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
