/**
 * cinatra#4220 — an agent run's host-derived connector-instance binding.
 *
 * Pins the write-once SQL shape of the dispatcher's setter against the real
 * drizzle builder (driver faked), and the fail-closed parse the run record
 * surfaces the column through.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Captured = { sql: string; params: unknown[] };
// Hoisted with the mocks: the ../db factory below records into it.
const captured = vi.hoisted((): Captured[] => []);
const state = vi.hoisted(() => ({ updateRows: 1 }));

vi.mock("server-only", () => ({}));

// Fake the drizzle pg driver: record every statement the store issues.
vi.mock("../db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const db = drizzle(async (sql: string, params: unknown[]) => {
    captured.push({ sql, params });
    // `.returning({id})` on the run UPDATE yields one row unless the test says
    // zero (a missing run, or a row already bound to another instance).
    if (/^update/i.test(sql.trim())) {
      return { rows: state.updateRows === 1 ? [["run-1"]] : [] };
    }
    return { rows: [] };
  });
  const withTx = Object.assign(db, {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(withTx),
  });
  return { db: withTx };
});

beforeEach(() => {
  captured.length = 0;
  state.updateRows = 1;
});

const BINDING_JSON = '{"connectorKey":"wordpress","instanceId":"wp-1"}';

describe("setAgentRunConnectorInstanceBinding — write-once binding", () => {
  it("issues ONE update on connector_instance_binding, guarded by is-null-or-equal", async () => {
    const { setAgentRunConnectorInstanceBinding } = await import("../run-token-store");
    await setAgentRunConnectorInstanceBinding("run-1", { connectorKey: "wordpress", instanceId: "wp-1" });

    expect(captured).toHaveLength(1);
    const stmt = captured[0];
    const lower = stmt.sql.toLowerCase();
    expect(lower.startsWith("update")).toBe(true);
    expect(lower).toContain("connector_instance_binding");
    expect(lower).toContain("is null");
    expect(lower).toMatch(/"connector_instance_binding"\s*=\s*\$\d/);
    expect(stmt.params).toContain(BINDING_JSON);
    expect(stmt.params).toContain("run-1");
  });

  it("throws 'already bound' when no row is updated", async () => {
    state.updateRows = 0;
    const { setAgentRunConnectorInstanceBinding } = await import("../run-token-store");
    await expect(
      setAgentRunConnectorInstanceBinding("run-1", { connectorKey: "wordpress", instanceId: "wp-1" }),
    ).rejects.toThrow(/already bound/);
  });

  it("refuses an empty runId, connectorKey or instanceId before any SQL", async () => {
    const { setAgentRunConnectorInstanceBinding } = await import("../run-token-store");
    await expect(setAgentRunConnectorInstanceBinding("", { connectorKey: "wordpress", instanceId: "wp-1" })).rejects.toThrow();
    await expect(setAgentRunConnectorInstanceBinding("run-1", { connectorKey: "", instanceId: "wp-1" })).rejects.toThrow();
    await expect(setAgentRunConnectorInstanceBinding("run-1", { connectorKey: "wordpress", instanceId: "" })).rejects.toThrow();
    expect(captured).toHaveLength(0);
  });
});

describe("parseConnectorInstanceBinding — fail-closed parse", () => {
  it("returns the binding for exactly {connectorKey, instanceId}", async () => {
    const { parseConnectorInstanceBinding } = await import("../agent-run-serde");
    expect(parseConnectorInstanceBinding(BINDING_JSON)).toEqual({ connectorKey: "wordpress", instanceId: "wp-1" });
  });

  it("returns null for anything else", async () => {
    const { parseConnectorInstanceBinding } = await import("../agent-run-serde");
    expect(parseConnectorInstanceBinding("{not json")).toBeNull();
    expect(parseConnectorInstanceBinding('["wordpress","wp-1"]')).toBeNull();
    expect(parseConnectorInstanceBinding('{"connectorKey":"wordpress","instanceId":"wp-1","extra":1}')).toBeNull();
    expect(parseConnectorInstanceBinding('{"connectorKey":"wordpress","instanceId":""}')).toBeNull();
    expect(parseConnectorInstanceBinding('{"connectorKey":7,"instanceId":"wp-1"}')).toBeNull();
    expect(parseConnectorInstanceBinding("")).toBeNull();
    expect(parseConnectorInstanceBinding(null)).toBeNull();
  });
});

describe("deserializeRun — surfaces the parsed binding", () => {
  const baseRow = (overrides: Record<string, unknown>) => ({
    id: "run-1",
    templateId: "tpl-1",
    versionId: null,
    runBy: "u-1",
    status: "completed",
    inputParams: "{}",
    stepResults: null,
    startedAt: null,
    completedAt: null,
    error: null,
    title: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    sourceType: "internal",
    sourceId: null,
    orgId: "org-1",
    ...overrides,
  });

  it("parses the column onto the record, and null without it", async () => {
    const { deserializeRun } = await import("../agent-run-serde");
    type Row = Parameters<typeof deserializeRun>[0];
    const bound = deserializeRun(baseRow({ connectorInstanceBinding: BINDING_JSON }) as unknown as Row);
    expect(bound.connectorInstanceBinding).toEqual({ connectorKey: "wordpress", instanceId: "wp-1" });
    const unbound = deserializeRun(baseRow({}) as unknown as Row);
    expect(unbound.connectorInstanceBinding).toBeNull();
  });
});
