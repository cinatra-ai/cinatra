/**
 * The approvals MCP tools serialize a whitelist of PUBLIC row fields
 * (approvals-mcp.ts, toPublicRow). The repair flag the marketplace sources
 * publish for a view (`ApprovalRow.repairStuck`, cinatra#4296) is a display
 * field the whitelist does not name, and the adapter-private `raw` that holds
 * the repair data is never serialized. This pins both for `approvals_list` and
 * `approvals_get`, through the real registration and handler dispatch (the
 * same harness as approvals-mcp.test.ts): it characterizes existing behaviour
 * and pins it against a later widening of the whitelist.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server";
import type { ApprovalEnvelope, ApprovalRow, ApprovalSource, Availability } from "../sources/types";

const { registryArr } = vi.hoisted(() => ({ registryArr: [] as ApprovalSource[] }));
vi.mock("../sources/registry", () => ({ approvalSourceRegistry: registryArr }));

import { registerApprovalsPrimitives } from "../approvals-mcp";

type Envelope = { content: unknown; structuredContent: Record<string, unknown> };
type Handler = (input: unknown) => Promise<Envelope>;

const handlers = new Map<string, Handler>();
registerApprovalsPrimitives({
  registerTool: (name: string, _cfg: unknown, h: Handler) => {
    handlers.set(name, h);
  },
} as never);

async function call(tool: string, input: unknown): Promise<Record<string, unknown>> {
  const h = handlers.get(tool);
  if (!h) throw new Error(`tool ${tool} not registered`);
  const ctx: Partial<McpRequestContext> = { userId: "u-admin", orgId: "org-1", platformRole: "platform_admin" };
  const res = await mcpRequestContextStorage.run(ctx as McpRequestContext, () => h(input));
  return res.structuredContent;
}

const STUCK_ROW: ApprovalRow = {
  id: "app-1",
  sourceId: "V",
  title: "Acme Tools",
  subtitle: "acme",
  status: "applied",
  createdAt: "2026-05-15T06:00:00.000Z",
  repairStuck: { attempts: 3 },
  raw: {
    scope: "acme",
    tier: "standard",
    repairStuck: true,
    recoveryAttempts: 3,
    stuckAt: "2026-05-15T07:00:00.000Z",
  },
};

function source(rows: ApprovalRow[]): ApprovalSource {
  const ready = async (): Promise<ApprovalEnvelope> => ({ availability: "ready", rows, actions: [] });
  return {
    id: "V",
    title: "Vendor applications",
    availability: (): Availability => "ready",
    appliesTo: () => true,
    fetchInbox: ready,
    fetchMine: ready,
    counts: async () => ({ inbox: rows.length, mine: 0 }),
    rowRenderer: () => null,
    actions: { decide: async () => ({ ok: true }) },
  } as unknown as ApprovalSource;
}

beforeEach(() => {
  registryArr.length = 0;
});

function expectNoRepairLeak(serialized: unknown) {
  const text = JSON.stringify(serialized);
  expect(text).not.toContain("repairStuck");
  expect(text).not.toContain("recoveryAttempts");
  expect(text).not.toContain("stuckAt");
  expect(text).not.toContain('"raw"');
}

describe("the approvals MCP tools with a repair-stuck row", () => {
  it("approvals_list serializes the public fields and no repair field or raw payload", async () => {
    registryArr.push(source([STUCK_ROW]));
    const res = await call("approvals_list", { direction: "inbox" });
    const rows = res.rows as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "app-1", sourceId: "V", title: "Acme Tools", status: "applied" });
    expect(rows[0]).not.toHaveProperty("repairStuck");
    expect(rows[0]).not.toHaveProperty("raw");
    expectNoRepairLeak(res);
  });

  it("approvals_get serializes the public fields and no repair field or raw payload", async () => {
    registryArr.push(source([STUCK_ROW]));
    const res = await call("approvals_get", { sourceId: "V", id: "app-1" });
    expect(res).toMatchObject({ ok: true });
    const item = res.item as Record<string, unknown>;
    expect(item).toMatchObject({ id: "app-1", sourceId: "V", status: "applied" });
    expect(item).not.toHaveProperty("repairStuck");
    expect(item).not.toHaveProperty("raw");
    expectNoRepairLeak(res);
  });

  it("a flag without a count (the self-status road) does not leak either", async () => {
    registryArr.push(source([{ ...STUCK_ROW, repairStuck: {} }]));
    expectNoRepairLeak(await call("approvals_list", { direction: "inbox" }));
    expectNoRepairLeak(await call("approvals_get", { sourceId: "V", id: "app-1" }));
  });
});
