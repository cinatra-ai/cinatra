import "server-only";

import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";

import { approvalSourceRegistry } from "./sources/registry";
import type {
  ApprovalAction,
  ApprovalRow,
  ApprovalSource,
  ApprovalViewer,
  Availability,
} from "./sources/types";

// ---------------------------------------------------------------------------
// Unified `approvals_*` MCP tools over the ApprovalSource registry.
//
// list / get / decide are the MCP twin of the unified /configuration/approvals
// page + its inline decide server action (actions.ts). They federate at READ
// time across the SAME source registry and execute EVERY decision through the
// SAME non-redirecting `source.actions.decide` helper the UI uses — so
// authorization, separation-of-duties (incl. the single-admin bypass), the audit
// writes, and the structured refusal codes (#1046) are IDENTICAL to the UI.
// There is NO parallel decision path and NO redirect semantics here.
//
// Boundary posture (Posture-B coarse gate — src/lib/authz/mcp-boundary.ts):
// these tools are classified in inventory-augment.ts as agent list/read/share.
// `approvals_list`/`approvals_get` are member-passable reads (a non-admin
// ELIGIBLE viewer clears the coarse gate; per-source `appliesTo`/eligibility
// filters the CONTENT); `approvals_decide` is admin-effect so the coarse gate
// membership-gates and DEFERS the real per-source authz to
// `source.actions.decide`. `approvals_decide` is additionally kept OFF the
// delegated-chat perimeter (a prompt-injected chat must never auto-approve).
//
// Authz invariants honored here:
//   * the viewer is resolved from the MCP request CONTEXT, never from tool input;
//   * only PUBLIC row fields are serialized — the adapter-private `raw` (which
//     may stash a source's internal CAS token / payload) is NEVER surfaced;
//   * a business refusal is a structured VALUE (never a throw); only a missing
//     org/user context (infra) throws, fail-closed.
//
// Source-agnostic: the tools iterate the registry, so marketplace sources (#1045)
// and the project-agent gate (#1032) are covered automatically once they join
// the registry — no MCP change. Each source stays authoritative for its own
// read/decide authorization; the coarse MCP boundary never substitutes for it.
// ---------------------------------------------------------------------------

const listSchema = z.object({
  direction: z.enum(["inbox", "mine"]),
  /** Restrict to a single source (by `ApprovalSource.id`). */
  sourceId: z.string().min(1).optional(),
  /** Source-interpreted history filter (v1: the agent "Your requests" window;
   *  other sources ignore it). */
  status: z.string().min(1).optional(),
});
const getSchema = z.object({
  sourceId: z.string().min(1),
  id: z.string().min(1),
});
const decideSchema = z.object({
  sourceId: z.string().min(1),
  id: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  reason: z.string().min(1).optional(),
  /** Optimistic-concurrency token from `approvals_get`'s `item.version` —
   *  REQUIRED by a source that guards against edit-after-view (the agent source
   *  refuses `version_required` without it). Sources with no concurrency token
   *  ignore it. */
  expectedVersion: z.string().min(1).optional(),
});

const TOOL_META = {
  approvals_list: {
    description:
      "List approvals across every connected source in one federated call. `direction`: 'inbox' (awaiting YOUR decision) or 'mine' (requests you / this instance submitted). Optional `sourceId` restricts to one source; optional `status` is a source-interpreted history filter. Returns `{ ok, direction, rows[], sources[], unavailableSources[] }`: each row is tagged with its `sourceId` (+ an opaque `version` when the source uses a concurrency token); `sources[]` gives the per-source count of returned rows; a source that is not connected / not configured / failing is reported in `unavailableSources[]` (with its availability) and NEVER errors the whole call. Content is filtered to what you are eligible to see. Read-only.",
    inputSchema: listSchema,
  },
  approvals_get: {
    description:
      "Fetch one approval currently visible to you in a source, with its full detail + available actions. Input `{ sourceId, id }` (sourceId REQUIRED). Returns `{ ok: true, sourceId, item, actions[], availability }` — each action declares `enforcement: 'local' | 'action-time'` — or `{ ok: false, error }` for an unknown source, an unavailable source, or a row not visible to you (`not_found`, which also covers a `sourceId` that does not own the id). `item.version` (when present) is the token to pass to `approvals_decide`. Read-only.",
    inputSchema: getSchema,
  },
  approvals_decide: {
    description:
      "Approve or reject one approval AT ITS SOURCE. Input `{ sourceId, id, decision: 'approve'|'reject', reason?, expectedVersion? }` — sourceId is REQUIRED so an unqualified id can never be routed to the wrong source. Delegates to the source's own decision helper, so authorization, separation-of-duties (incl. the single-admin bypass), audit writes, and structured errors are IDENTICAL to the UI. `expectedVersion` is the `version` from `approvals_get`: a source that guards edit-after-view (agent creation requests) refuses `version_required` without it and `stale_snapshot` if it changed. A rejection requires `reason`. Returns `{ ok: true, ... }` or a structured `{ ok: false, error: { code, kind, message, httpStatus? } }` refusal (e.g. SoD, conflict) surfaced readably. NOT available to delegated chat.",
    inputSchema: decideSchema,
  },
} as const;

// ── helpers ────────────────────────────────────────────────────────────────

function envelope(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function errorEnvelope(
  code: string,
  message: string,
  extra?: { kind?: string; httpStatus?: number; availability?: Availability },
) {
  return envelope({
    ok: false,
    error: {
      code,
      message,
      ...(extra?.kind ? { kind: extra.kind } : {}),
      ...(extra?.httpStatus ? { httpStatus: extra.httpStatus } : {}),
      ...(extra?.availability ? { availability: extra.availability } : {}),
    },
  });
}

/** Resolve the acting viewer from the MCP request CONTEXT — never from tool
 *  input. `isAdmin` mirrors the UI's `isPlatformAdmin(session)`
 *  (page.tsx / actions.ts). Fail-closed: an unauthenticated / org-less caller
 *  cannot read or decide anything (the coarse boundary already blocks an
 *  org-less caller; this is defense-in-depth AND the fetch/decide helpers need
 *  a real {userId, orgId}). */
function resolveViewer(): ApprovalViewer {
  const ctx = mcpRequestContextStorage.getStore();
  const userId = ctx?.userId ?? null;
  const orgId = ctx?.orgId ?? null;
  if (!userId || !orgId) {
    throw new Error(
      "approvals MCP: no active organization/user in request context (fail-closed).",
    );
  }
  return { userId, orgId, isAdmin: ctx?.platformRole === "platform_admin" };
}

/** Whitelist the PUBLIC row fields. The adapter-private `raw` is NEVER copied —
 *  nothing outside the owning source's rowRenderer may depend on its shape. */
function toPublicRow(r: ApprovalRow) {
  return {
    id: r.id,
    sourceId: r.sourceId,
    title: r.title,
    ...(r.subtitle !== undefined ? { subtitle: r.subtitle } : {}),
    status: r.status,
    createdAt: r.createdAt,
    ...(r.href !== undefined ? { href: r.href } : {}),
    ...(r.isOwnRequest ? { isOwnRequest: true } : {}),
    ...(r.eligibility ? { eligibility: r.eligibility } : {}),
    ...(r.version !== undefined ? { version: r.version } : {}),
  };
}

function toPublicAction(a: ApprovalAction) {
  return {
    id: a.id,
    label: a.label,
    enforcement: a.enforcement,
    ...(a.intent ? { intent: a.intent } : {}),
    ...(a.requiresReason ? { requiresReason: true } : {}),
  };
}

async function safeAvailability(source: ApprovalSource, viewer: ApprovalViewer): Promise<Availability> {
  try {
    return await source.availability(viewer);
  } catch {
    return "error";
  }
}

// ── handlers ─────────────────────────────────────────────────────────────

async function handleList(input: unknown) {
  const { direction, sourceId, status } = listSchema.parse(input ?? {});
  const viewer = resolveViewer();

  const rows: ReturnType<typeof toPublicRow>[] = [];
  const sources: { sourceId: string; title: string; count: number }[] = [];
  const unavailableSources: {
    sourceId: string;
    title: string;
    availability: Availability;
    message?: string;
  }[] = [];

  for (const source of approvalSourceRegistry) {
    if (sourceId && source.id !== sourceId) continue;

    const availability = await safeAvailability(source, viewer);
    if (availability !== "ready") {
      unavailableSources.push({ sourceId: source.id, title: source.title, availability });
      continue;
    }
    // A section the viewer can't participate in for THIS direction is omitted
    // (mirrors the page hiding it) — NOT a connectivity "unavailable" state.
    if (!source.appliesTo(viewer, direction)) continue;

    try {
      const opts = status ? { status } : undefined;
      const env =
        direction === "inbox"
          ? await source.fetchInbox(viewer, opts)
          : await source.fetchMine(viewer, opts);
      if (env.availability !== "ready") {
        unavailableSources.push({
          sourceId: source.id,
          title: source.title,
          availability: env.availability,
          // Source-authored, display-safe message only.
          ...(env.error?.message ? { message: env.error.message } : {}),
        });
        continue;
      }
      let count = 0;
      for (const r of env.rows) {
        rows.push(toPublicRow(r));
        count++;
      }
      sources.push({ sourceId: source.id, title: source.title, count });
    } catch {
      // Soft-fail: one source failing never blocks the others. Sanitized
      // message only — never leak the raw exception.
      unavailableSources.push({
        sourceId: source.id,
        title: source.title,
        availability: "error",
        message: "This source is temporarily unavailable.",
      });
    }
  }

  return envelope({ ok: true, direction, rows, sources, unavailableSources });
}

async function handleGet(input: unknown) {
  const { sourceId, id } = getSchema.parse(input);
  const viewer = resolveViewer();

  const source = approvalSourceRegistry.find((s) => s.id === sourceId);
  if (!source) {
    return errorEnvelope("unknown_source", `Unknown approval source '${sourceId}'.`, { httpStatus: 404 });
  }
  const availability = await safeAvailability(source, viewer);
  if (availability !== "ready") {
    return errorEnvelope("source_unavailable", `Approval source '${sourceId}' is ${availability}.`, { availability });
  }

  // Search only the directions the viewer can participate in, so a row the
  // viewer isn't eligible to see is never returned. "mine" uses the widest
  // history window so a decided own-request stays fetchable by id.
  for (const direction of ["inbox", "mine"] as const) {
    if (!source.appliesTo(viewer, direction)) continue;
    let env;
    try {
      env =
        direction === "inbox"
          ? await source.fetchInbox(viewer)
          : await source.fetchMine(viewer, { status: "all" });
    } catch {
      // A transient failure in one section must not mask a hit in the other.
      continue;
    }
    if (env.availability !== "ready") continue;
    const row = env.rows.find((r) => r.id === id);
    if (row) {
      return envelope({
        ok: true,
        sourceId,
        item: toPublicRow(row),
        actions: env.actions.map(toPublicAction),
        availability,
      });
    }
  }

  // Not found here — this is ALSO the answer for a MISMATCHED sourceId (an id
  // that belongs to a different source is simply not among this source's rows).
  return errorEnvelope("not_found", `No approval '${id}' visible to you in source '${sourceId}'.`, { httpStatus: 404 });
}

async function handleDecide(input: unknown) {
  const { sourceId, id, decision, reason, expectedVersion } = decideSchema.parse(input);
  const viewer = resolveViewer();

  const source = approvalSourceRegistry.find((s) => s.id === sourceId);
  if (!source) {
    return errorEnvelope("unknown_source", `Unknown approval source '${sourceId}'.`, { httpStatus: 404 });
  }

  // The SAME non-redirecting helper the UI server action calls — identical
  // authz, separation-of-duties, audit writes and structured refusal codes.
  const result = await source.actions.decide(
    {
      rowId: id,
      action: decision,
      ...(reason ? { reason } : {}),
      ...(expectedVersion ? { expectedVersion } : {}),
    },
    viewer,
  );

  if (!result.ok) {
    return errorEnvelope(result.code, result.message, {
      kind: result.kind,
      ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
    });
  }
  return envelope({
    ok: true,
    sourceId,
    id,
    decision,
    ...(result.row ? { item: toPublicRow(result.row) } : {}),
  });
}

// ── registration ─────────────────────────────────────────────────────────

export function registerApprovalsPrimitives(server: McpRuntimeToolServer): void {
  server.registerTool(
    "approvals_list",
    { title: "approvals_list", ...TOOL_META.approvals_list },
    (async (input: unknown) => handleList(input)) as never,
  );
  server.registerTool(
    "approvals_get",
    { title: "approvals_get", ...TOOL_META.approvals_get },
    (async (input: unknown) => handleGet(input)) as never,
  );
  server.registerTool(
    "approvals_decide",
    { title: "approvals_decide", ...TOOL_META.approvals_decide },
    (async (input: unknown) => handleDecide(input)) as never,
  );
}

export function createApprovalsMcpModule() {
  return { registerCapabilities: registerApprovalsPrimitives };
}
