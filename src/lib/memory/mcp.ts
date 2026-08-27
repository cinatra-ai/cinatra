import "server-only";

// ---------------------------------------------------------------------------
// The memory promotion REQUEST tool (cinatra#1381, epic #1373).
//
// ONE tool: `memory_promote_request`. It opens a PENDING request and writes
// NOTHING to the memory row. The DECISION surface is not here and is not built
// here — an approve/reject rides the already-shipped `approvals_*` tools over
// the shared promotion ApprovalSource, and the human surface is the existing
// `/notifications` feed. This module is the request half only.
//
// Business refusals are VALUES in the envelope (`{ ok: false, code, message }`)
// mirroring the data layer — never throws — so an agent can branch on `code`
// (e.g. `conflict` = a request is already pending for this row).
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";

import { resolveScope } from "@/lib/mcp-tool-scope";
import { requestMemoryPromotion } from "./memory-promotion-request";

const promoteRequestSchema = z.object({
  memoryId: z.string().min(1),
  toVisibility: z.enum(["team", "organization"]),
  /** Required for a team target (the team that will own the widened row). */
  targetTeamId: z.string().min(1).optional(),
});

const TOOL_META = {
  memory_promote_request: {
    description:
      "Request a scope promotion (widen) for one memory concept row the caller can see: `user/private` -> `team` (requires `targetTeamId`, a team in the active organization that the CALLER is a member of) or -> `organization`; a `team/team` row may be promoted to `organization`. No other move exists. Opens a PENDING request in the unified /notifications approvals feed (also listable via `approvals_list`) — it does NOT widen the row; only an admin approve there does, re-checked against the transition matrix and a fail-closed credential scan, and CAS-bound to the row version captured here (an edit after the request supersedes it). Structured refusals (`ok: false`) carry `code`: `not_found` (row absent, not a memory concept, OR not visible to the caller — deliberately indistinguishable) | `narrowing` (the target does not widen the current visibility) | `invalid_state` (team target without `targetTeamId`, a target team the caller is not a member of, or a move outside the matrix) | `conflict` (a pending request already exists for this row) | `not_authorized` (no attributable user principal).",
    inputSchema: promoteRequestSchema,
  },
} as const;

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

export function registerMemoryPromotionPrimitives(server: McpRuntimeToolServer): void {
  server.registerTool(
    "memory_promote_request",
    { title: "memory_promote_request", ...TOOL_META.memory_promote_request },
    (async (input: unknown) => {
      const parsed = promoteRequestSchema.parse(input);
      const { orgId, userId, actor } = resolveScope();
      // A promotion request must be attributable to a USER principal: it keys
      // the requester's "Your requests" listing, the reviewer inbox excludes
      // the requester's own rows, and a team target is validated against the
      // REQUESTER's team membership. A userless caller is refused.
      if (!userId) {
        return envelope({
          ok: false,
          code: "not_authorized",
          message: "memory_promote_request requires an attributable user principal.",
        });
      }
      const result = await requestMemoryPromotion({
        orgId,
        memoryId: parsed.memoryId,
        requestedBy: userId,
        toVisibility: parsed.toVisibility,
        ...(parsed.targetTeamId ? { targetTeamId: parsed.targetTeamId } : {}),
        actor,
      });
      if (!result.ok) {
        return envelope({ ok: false, code: result.code, message: result.message });
      }
      const r = result.request;
      // PUBLIC fields only — the adapter-internal row is never serialized whole.
      return envelope({
        ok: true,
        request: {
          id: r.id,
          objectId: r.objectId,
          title: r.objectTitle,
          status: r.status,
          fromVisibility: r.fromVisibility,
          toVisibility: r.toVisibility,
          rowVersion: r.rowVersion,
          createdAt: r.createdAt,
        },
      });
    }) as never,
  );
}

export function createMemoryPromotionModule() {
  return {
    registerCapabilities: registerMemoryPromotionPrimitives,
  };
}
