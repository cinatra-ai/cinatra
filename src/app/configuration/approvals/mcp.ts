import "server-only";

import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";

import { approvalSourceRegistry } from "./sources/registry";
import type { ApprovalViewer } from "./sources/types";
import { collectApprovals, decideApproval, getApprovalItem } from "./mcp-core";

// ---------------------------------------------------------------------------
// `approvals_*` MCP tool surface (#1048). Three host tools — list / get / decide
// — over the ApprovalSource registry (#1044) and its marketplace sources
// (#1045), routing every decision through the SAME non-redirecting per-source
// decision helper the UI server actions use (no parallel decision path).
//
// The MCP boundary (posture-B, 6244acaa) gives these the enforced coarse gate;
// each tool is classified in src/lib/authz/inventory-augment.ts (list/get as a
// member-readable READ so a future non-admin-eligible viewer is not blocked at
// the inventory layer — per-source eligibility filters the content; decide as a
// membership-gated WRITE that defers source-specific eligibility to the
// handlers). `approvals_decide` is kept OFF delegated chat by the `decide`
// denied-verb token (delegated-chat-tool-policy.ts) — an admin decides through
// the /configuration/approvals UI, and a prompt-injected chat must not
// auto-approve.
// ---------------------------------------------------------------------------

const directionSchema = z
  .enum(["inbox", "mine"])
  .describe(
    "'inbox' = items awaiting the viewer's decision across sources; 'mine' = requests the viewer / this instance submitted, awaiting others.",
  );

const listSchema = z.object({
  direction: directionSchema,
  sourceId: z
    .string()
    .optional()
    .describe("Narrow to a single approval source id (e.g. 'agent-creation-requests', 'marketplace-submission-moderation'). Omit to federate all applicable sources."),
  status: z
    .string()
    .optional()
    .describe("Source-interpreted history filter for the 'mine' direction (e.g. the agent 'Your requests' window: 'all' for full history, or a specific status). Ignored by sources that do not interpret it."),
});

const getSchema = z.object({
  sourceId: z.string().describe("The approval source id the item belongs to (REQUIRED — an unqualified id must not be routed to the wrong source)."),
  id: z.string().describe("The item id within that source."),
});

const decideSchema = z.object({
  sourceId: z.string().describe("The approval source id the item belongs to (REQUIRED — an unqualified id must not be routed to the wrong source)."),
  id: z.string().describe("The item id to decide."),
  decision: z.enum(["approve", "reject"]).describe("The decision to record."),
  reason: z.string().optional().describe("Optional decision reason. REQUIRED by most sources when rejecting."),
  expectedVersion: z
    .string()
    .optional()
    .describe("Optimistic-concurrency token obtained from approvals_get / approvals_list `version`. REQUIRED by sources that declare one (e.g. agent creation requests' snapshot hash); the source refuses when it is absent or stale rather than reading a fresh value, preserving the capture-then-decide guard."),
});

export const APPROVALS_TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  approvals_list: {
    description:
      "List approval items across every source (agent creation requests, marketplace extension-submission + vendor-application moderation, the instance's own submissions/vendor-application, and the legacy workflow passthrough) for one direction. Rows are tagged with `sourceId` and each source carries a per-source `count` + its available `actions`. A source that is not connected / not configured / errored is reported in `unavailableSources` (with its state) instead of erroring the call — a remote failure never blocks a local section. Use `approvals_get` for full detail on one item and `approvals_decide` to act.",
    inputSchema: listSchema,
  },
  approvals_get: {
    description:
      "Get one approval item by `{ sourceId, id }` with its full detail and the source's available `actions` (each declaring `enforcement: 'local' | 'action-time'` and optional row `eligibility` when the source supplies it). `sourceId` is REQUIRED. Returns `{ ok: false, code: 'unknown_source' | 'not_found' | 'forbidden' | <availability> }` when the source id is unknown, the item is absent, the viewer cannot participate, or the source is unavailable. The returned `item.version`, when present, is the token to pass as `approvals_decide.expectedVersion`.",
    inputSchema: getSchema,
  },
  approvals_decide: {
    description:
      "Approve or reject an approval item. `sourceId` is REQUIRED (an unqualified id is never routed to the wrong source). Delegates to the source's own decision helper, so authorization, separation-of-duties (including the single-admin bypass), audit writes and structured refusals are IDENTICAL to the /configuration/approvals UI. A business refusal is returned as a value `{ ok: false, kind: 'refused' | 'transient' | 'forbidden', code, message, httpStatus? }` (e.g. a 409 separation-of-duties conflict), never thrown. Pass `expectedVersion` (from approvals_get / approvals_list `version`) for sources that declare one.",
    inputSchema: decideSchema,
  },
};

/**
 * Resolve the {@link ApprovalViewer} from the MCP request context. A2A identity
 * takes precedence for userId/orgId (mirrors the other host modules); `isAdmin`
 * is derived ONLY from the transport-resolved `platformRole` (a cookie-session
 * admin) — an A2A / bearer caller is treated as non-admin, which is the
 * conservative choice (it can under-authorize but never amplify privilege; the
 * per-source helper is the authoritative gate either way). Fail-closed: an
 * org-less caller is refused (the boundary also deny-by-defaults such callers).
 */
function resolveViewer(): ApprovalViewer {
  const ctx = mcpRequestContextStorage.getStore();
  const a2a = ctx?.a2aActorContext;
  const userId = a2a?.userId ?? ctx?.userId ?? null;
  const orgId = (a2a ? a2a.orgId : ctx?.orgId) ?? null;
  if (!userId || !orgId) {
    throw new Error(
      "approvals MCP: no active organization (fail-closed — refusing an unscoped approvals call).",
    );
  }
  const isAdmin = ctx?.platformRole === "platform_admin";
  return { userId, orgId, isAdmin };
}

function envelope(payload: unknown) {
  const resolved = payload === undefined ? null : payload;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(resolved) }],
    structuredContent:
      typeof resolved === "object" && resolved !== null
        ? (resolved as Record<string, unknown>)
        : { result: resolved },
  };
}

export function registerApprovalsPrimitives(server: McpRuntimeToolServer): void {
  server.registerTool(
    "approvals_list",
    { title: "approvals_list", ...APPROVALS_TOOL_META.approvals_list },
    (async (input: unknown) => {
      const parsed = listSchema.parse(input ?? {});
      const viewer = resolveViewer();
      const result = await collectApprovals(approvalSourceRegistry, viewer, parsed.direction, {
        ...(parsed.sourceId ? { sourceId: parsed.sourceId } : {}),
        ...(parsed.status ? { status: parsed.status } : {}),
      });
      return envelope(result);
    }) as never,
  );

  server.registerTool(
    "approvals_get",
    { title: "approvals_get", ...APPROVALS_TOOL_META.approvals_get },
    (async (input: unknown) => {
      const parsed = getSchema.parse(input);
      const viewer = resolveViewer();
      const result = await getApprovalItem(approvalSourceRegistry, viewer, parsed.sourceId, parsed.id);
      return envelope(result);
    }) as never,
  );

  server.registerTool(
    "approvals_decide",
    { title: "approvals_decide", ...APPROVALS_TOOL_META.approvals_decide },
    (async (input: unknown) => {
      const parsed = decideSchema.parse(input);
      const viewer = resolveViewer();
      const result = await decideApproval(approvalSourceRegistry, viewer, {
        sourceId: parsed.sourceId,
        id: parsed.id,
        decision: parsed.decision,
        ...(parsed.reason ? { reason: parsed.reason } : {}),
        ...(parsed.expectedVersion ? { expectedVersion: parsed.expectedVersion } : {}),
      });
      return envelope(result);
    }) as never,
  );
}

export function createApprovalsModule() {
  return {
    registerCapabilities: registerApprovalsPrimitives,
  };
}
