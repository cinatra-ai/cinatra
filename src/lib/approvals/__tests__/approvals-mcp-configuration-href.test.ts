/**
 * PER-PRODUCER fixture for the approvals MCP output
 * (cinatra#2701 change 2, epic #2699 S2).
 *
 * The public row whitelist copied `href` verbatim for every caller. Those hrefs
 * address `/configuration` detail pages, which answer only to a platform-admin
 * session (S1, #2700) — so an agent acting for a member would be handed a URL it
 * can only be refused at. The field is now viewer-scoped, exactly as the
 * `/notifications` feed scopes it at render.
 *
 * Driven THROUGH the real registration + handler dispatch, inside a real
 * `mcpRequestContextStorage` frame, so the viewer is resolved from CONTEXT —
 * mirroring the sibling `approvals-mcp.test.ts` harness.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server";
import type {
  ApprovalEnvelope,
  ApprovalRow,
  ApprovalSource,
  Availability,
} from "../sources/types";

const { registryArr } = vi.hoisted(() => ({ registryArr: [] as ApprovalSource[] }));
vi.mock("../sources/registry", () => ({ approvalSourceRegistry: registryArr }));

import { registerApprovalsPrimitives } from "../approvals-mcp";

type Envelope = { content: unknown; structuredContent: Record<string, unknown> };
type Handler = (input: unknown) => Promise<Envelope>;

const handlers = (() => {
  const map = new Map<string, Handler>();
  registerApprovalsPrimitives({
    registerTool: (name: string, _cfg: unknown, h: Handler) => void map.set(name, h),
  } as never);
  return map;
})();

async function call(
  tool: string,
  input: unknown,
  ctx: Partial<McpRequestContext>,
): Promise<Record<string, unknown>> {
  const h = handlers.get(tool);
  if (!h) throw new Error(`tool ${tool} not registered`);
  const res = await mcpRequestContextStorage.run(ctx as McpRequestContext, () => h(input));
  return res.structuredContent;
}

const ISO = "2026-07-01T00:00:00.000Z";
const CONFIG_HREF = "/configuration/agents/approvals/a-1";
const PLAIN_HREF = "/artifacts/obj_1";

const adminCtx: Partial<McpRequestContext> = {
  userId: "u-admin",
  orgId: "org-1",
  platformRole: "platform_admin",
};
const memberCtx: Partial<McpRequestContext> = {
  userId: "u-member",
  orgId: "org-1",
  platformRole: "member",
};

function makeRow(id: string, href: string): ApprovalRow {
  return {
    id,
    sourceId: "src-a",
    title: `title-${id}`,
    status: "proposed",
    createdAt: ISO,
    href,
  };
}

function ready(rows: ApprovalRow[]): ApprovalEnvelope {
  return { availability: "ready", rows, actions: [] };
}

function source(rows: ApprovalRow[]): ApprovalSource {
  return {
    id: "src-a",
    title: "Source A",
    availability: (): Availability => "ready",
    appliesTo: (_v, direction) => direction === "inbox",
    fetchInbox: async () => ready(rows),
    fetchMine: async () => ready([]),
    counts: async () => ({ inbox: rows.length, mine: 0 }),
    rowRenderer: () => null,
    actions: { decide: async () => ({ ok: true, row: rows[0] }) },
  } as unknown as ApprovalSource;
}

type PublicRow = { id: string; href?: string };

beforeEach(() => {
  registryArr.length = 0;
  registryArr.push(source([makeRow("a-1", CONFIG_HREF), makeRow("a-2", PLAIN_HREF)]));
});

describe("cinatra#2701 — approvals_list omits /configuration hrefs for a non-admin caller", () => {
  it("a MEMBER caller gets the rows, without the field", async () => {
    const out = await call("approvals_list", { direction: "inbox" }, memberCtx);
    const rows = out.rows as PublicRow[];
    expect(rows.map((r) => r.id)).toEqual(["a-1", "a-2"]);
    expect(rows[0].href).toBeUndefined();
    expect("href" in rows[0]).toBe(false);
    // A non-configuration href is untouched.
    expect(rows[1].href).toBe(PLAIN_HREF);
    expect(JSON.stringify(out)).not.toContain("/configuration");
  });

  it("an ADMIN caller gets the href unchanged", async () => {
    const out = await call("approvals_list", { direction: "inbox" }, adminCtx);
    const rows = out.rows as PublicRow[];
    expect(rows[0].href).toBe(CONFIG_HREF);
    expect(rows[1].href).toBe(PLAIN_HREF);
  });
});

describe("cinatra#2701 — approvals_get and approvals_decide scope the href the same way", () => {
  it("approvals_get omits it for a member and keeps it for an admin", async () => {
    const member = await call(
      "approvals_get",
      { sourceId: "src-a", id: "a-1" },
      memberCtx,
    );
    expect((member.item as PublicRow).href).toBeUndefined();

    const admin = await call("approvals_get", { sourceId: "src-a", id: "a-1" }, adminCtx);
    expect((admin.item as PublicRow).href).toBe(CONFIG_HREF);
  });

  it("the row echoed back by approvals_decide is scoped too", async () => {
    const member = await call(
      "approvals_decide",
      { sourceId: "src-a", id: "a-1", decision: "approve" },
      memberCtx,
    );
    expect((member.item as PublicRow).href).toBeUndefined();

    const admin = await call(
      "approvals_decide",
      { sourceId: "src-a", id: "a-1", decision: "approve" },
      adminCtx,
    );
    expect((admin.item as PublicRow).href).toBe(CONFIG_HREF);
  });
});
