/**
 * ONE `extension_tool.dispatch` AUDIT EVENT PER CALL, AND THE TOOL'S PORTS
 * ATTRIBUTED (cinatra#4154, part C2).
 *
 * Every `extension_tool` call that reaches the scoped dispatch writes one
 * `extension_tool.dispatch` event, allowed and refused alike, carrying
 * `runPackage`, `codePackage`, `codeInstallId` (null on the run package's own
 * road) and `verifiedStepId`. A refused call records a fixed reason word, the
 * resolver's fixed code where the resolver refused, and never the thrown text;
 * a refused event is never folded away by the denied-event cooldown. The ports
 * a tool is handed write their own audit events with the same four fields.
 *
 * The origin resolver and the module loader are stubbed (the resolver is
 * pinned in extension-tool-origin.test.ts); the dispatch, the declaration
 * parse, the port wiring and the data tool's compile are the real ones. The
 * audit write is captured at `@/lib/authz/audit`. The packages are fixtures.
 *
 *   pnpm exec vitest run src/lib/__tests__/extension-scoped-tools-dispatch-audit.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const getAgentPackage = vi.fn();
const loadDeclaredToolModule = vi.fn();
const resolveExtensionToolOrigin = vi.fn();
const logAuditEvent = vi.fn();

vi.mock("@/lib/db/pooled", async () => ({
  ...(await vi.importActual<typeof import("@/lib/db/pooled")>("@/lib/db/pooled")),
  getPooledDb: () => ({
    query: (...a: unknown[]) => query(...a),
    connect: async () => ({ query: (...a: unknown[]) => query(...a), release: () => {} }),
  }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://unused",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: (...a: unknown[]) => getAgentPackage(...a),
}));
vi.mock("@cinatra-ai/agents/installed-oas-path", () => ({
  probeInstalledOasPathForRead: () => ({ path: null }),
}));
vi.mock("@/lib/verdaccio-config", () => ({ loadVerdaccioConfigForReads: async () => ({}) }));
vi.mock("@/lib/authz/audit", () => ({
  logAuditEvent: (...a: unknown[]) => logAuditEvent(...a),
}));
vi.mock("@/lib/extension-tool-module-loader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extension-tool-module-loader")>()),
  loadDeclaredToolModule: (...args: unknown[]) => loadDeclaredToolModule(...args),
}));
vi.mock("@/lib/extension-tool-origin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extension-tool-origin")>()),
  resolveExtensionToolOrigin: (...args: unknown[]) => resolveExtensionToolOrigin(...args),
}));

const PARENT = "@fixture-scope/fixture-parent-agent";
const CHILD = "@fixture-scope/fixture-child-agent";
const STEP = "child-embed_step";
const PARENT_TOOL = { name: "parent_tool", module: "./cinatra/tools/parent-tool.mjs" };
const CHILD_TOOL = { name: "child_tool", module: "./cinatra/tools/child-tool.mjs", embeddable: true };
const PARENT_CINATRA = { dependencies: [{ packageName: CHILD, kind: "agent" }], tools: [PARENT_TOOL] };
const CHILD_CINATRA = {
  tools: [CHILD_TOOL],
  declaredTables: [
    {
      name: "child_rows",
      organizationColumn: "org_id",
      columns: [
        { name: "id", type: "text", notNull: true, primaryKey: true },
        { name: "org_id", type: "text", notNull: true },
      ],
    },
  ],
};
const RUN = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tmpl-1",
  packageVersion: "2.0.0",
  dependentInstallId: "install-parent",
  verifiedStepId: STEP,
};
const CHILD_ORIGIN = {
  kind: "child",
  codeInstallId: "install-child",
  context: { packageName: CHILD, packageVersion: "0.1.1", cinatra: CHILD_CINATRA },
  install: { installId: "install-child", digest: "digest-child", stillBound: async () => true },
};
/** Text a thrown module failure carries that no audit event may hold. */
const LEAKY = "ENOENT /srv/fixture-store/agent/fixture-child-agent/digest-x install-leaky-id";

type Event = Record<string, unknown> & { metadata: Record<string, unknown> };

function dispatchEvents(): Event[] {
  return logAuditEvent.mock.calls
    .map((c) => c[0] as Event)
    .filter((e) => e.operation === "extension_tool.dispatch");
}

/**
 * The answer never waits for the dispatch event (the write is started before
 * the answer returns): wait until `n` events landed, let any further write
 * land, and return them.
 */
async function settledEvents(n: number): Promise<Event[]> {
  await vi.waitFor(() => expect(dispatchEvents()).toHaveLength(n));
  await drain();
  expect(dispatchEvents()).toHaveLength(n);
  return dispatchEvents();
}

/** Let a write the call started land, for a case that expects none. */
const drain = () => new Promise((resolve) => setTimeout(resolve, 50));

async function call(name: string, run: Record<string, unknown> = RUN) {
  const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
  return dispatchExtensionScopedTool({
    tool: "extension_tool",
    input: { name, input: {} },
    run: run as typeof RUN,
  });
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("the extension_tool.dispatch audit event", () => {
  beforeEach(() => {
    query.mockReset();
    getAgentPackage.mockReset();
    loadDeclaredToolModule.mockReset();
    resolveExtensionToolOrigin.mockReset();
    logAuditEvent.mockReset().mockResolvedValue(undefined);
    query.mockResolvedValue({ rows: [{ package_name: PARENT }] });
    getAgentPackage.mockResolvedValue({ manifest: { cinatra: PARENT_CINATRA } });
  });

  it("records an allowed call of the run package's own road, with no install id", async () => {
    resolveExtensionToolOrigin.mockResolvedValue({ kind: "parent" });
    loadDeclaredToolModule.mockResolvedValue({ extensionTool: () => ({ ran: "parent" }) });
    expect(await call("parent_tool")).toEqual({ ok: true, result: { ran: "parent" } });
    const events = await settledEvents(1);
    expect(events[0]).toMatchObject({
      organizationId: RUN.orgId,
      actorPrincipalId: RUN.runBy,
      resourceType: "extension_tool",
      runId: RUN.id,
      decision: "allowed",
    });
    expect(events[0]!.metadata).toEqual({
      runPackage: PARENT,
      codePackage: PARENT,
      codeInstallId: null,
      verifiedStepId: STEP,
    });
  });

  it("records an allowed call of an embedded child step with the exact child installation", async () => {
    resolveExtensionToolOrigin.mockResolvedValue(CHILD_ORIGIN);
    loadDeclaredToolModule.mockResolvedValue({ extensionTool: () => ({ ran: "child" }) });
    expect(await call("child_tool")).toEqual({ ok: true, result: { ran: "child" } });
    const events = await settledEvents(1);
    expect(events[0]).toMatchObject({ decision: "allowed", resourceId: CHILD });
    expect(events[0]!.metadata).toEqual({
      runPackage: PARENT,
      codePackage: CHILD,
      codeInstallId: "install-child",
      verifiedStepId: STEP,
    });
  });

  it("records a resolver refusal with its fixed code, no code package and no cooldown", async () => {
    const { ExtensionToolOriginRefusal } = await import("@/lib/extension-tool-origin");
    resolveExtensionToolOrigin.mockRejectedValue(new ExtensionToolOriginRefusal("provenance-mismatch"));
    const outcome = await call("child_tool");
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    const events = await settledEvents(1);
    expect(events[0]).toMatchObject({ decision: "denied", deniedCooldown: "record_every" });
    expect(events[0]).not.toHaveProperty("resourceId");
    expect(events[0]!.metadata).toEqual({
      runPackage: PARENT,
      codePackage: null,
      codeInstallId: null,
      verifiedStepId: STEP,
      reason: "refused",
      originCode: "provenance-mismatch",
    });
  });

  it("records a dispatch refusal on the child road with the child as the code package", async () => {
    resolveExtensionToolOrigin.mockResolvedValue(CHILD_ORIGIN);
    const outcome = await call("parent_tool");
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    const events = await settledEvents(1);
    expect(events[0]!.metadata).toEqual({
      runPackage: PARENT,
      codePackage: CHILD,
      codeInstallId: "install-child",
      verifiedStepId: STEP,
      reason: "refused",
    });
  });

  it("records a module's failure as `failed`, never with its text", async () => {
    resolveExtensionToolOrigin.mockResolvedValue(CHILD_ORIGIN);
    loadDeclaredToolModule.mockResolvedValue({
      extensionTool: () => {
        throw new Error(LEAKY);
      },
    });
    const outcome = await call("child_tool");
    expect(outcome).toMatchObject({ ok: false, status: 500 });
    const events = await settledEvents(1);
    expect(events[0]).toMatchObject({ decision: "denied", deniedCooldown: "record_every" });
    expect(events[0]!.metadata.reason).toBe("failed");
    expect(JSON.stringify(events[0])).not.toContain("install-leaky-id");
    expect(JSON.stringify(events[0])).not.toContain("/srv/fixture-store");
  });

  it("records a run with no package as refused, with no package fields", async () => {
    query.mockResolvedValue({ rows: [] });
    const outcome = await call("parent_tool");
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    const events = await settledEvents(1);
    expect(events[0]!.metadata).toEqual({
      runPackage: null,
      codePackage: null,
      codeInstallId: null,
      verifiedStepId: STEP,
      reason: "refused",
    });
  });

  it("keeps the answer when the audit write fails", async () => {
    resolveExtensionToolOrigin.mockResolvedValue({ kind: "parent" });
    loadDeclaredToolModule.mockResolvedValue({ extensionTool: () => ({ ran: "parent" }) });
    logAuditEvent.mockRejectedValue(new Error(LEAKY));
    expect(await call("parent_tool")).toEqual({ ok: true, result: { ran: "parent" } });
  });

  it("writes no dispatch event for the other scoped tools", async () => {
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    await dispatchExtensionScopedTool({ tool: "artifacts_list", input: {}, run: RUN });
    await drain();
    expect(dispatchEvents()).toHaveLength(0);
  });

  it("attributes the audit event a child tool's data port writes", async () => {
    resolveExtensionToolOrigin.mockResolvedValue(CHILD_ORIGIN);
    loadDeclaredToolModule.mockResolvedValue({
      extensionTool: async ({ ports }: { ports: { data: { select: (r: unknown) => Promise<unknown> } } }) =>
        ports.data.select({ table: "undeclared_rows" }),
    });
    const outcome = await call("child_tool");
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    const data = logAuditEvent.mock.calls
      .map((c) => c[0] as Event)
      .filter((e) => e.operation === "extension_data.select");
    expect(data).toHaveLength(1);
    expect(data[0]!.metadata).toMatchObject({
      extension: CHILD,
      reason: "table-not-declared",
      runPackage: PARENT,
      codePackage: CHILD,
      codeInstallId: "install-child",
      verifiedStepId: STEP,
    });
  });

  it("leaves a direct extension_data call's audit event without the four fields", async () => {
    getAgentPackage.mockResolvedValue({ manifest: { cinatra: { ...PARENT_CINATRA, ...CHILD_CINATRA } } });
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    await dispatchExtensionScopedTool({
      tool: "extension_data",
      input: { table: "undeclared_rows", operation: "select" },
      run: RUN,
    });
    const data = logAuditEvent.mock.calls
      .map((c) => c[0] as Event)
      .filter((e) => e.operation === "extension_data.select");
    expect(data).toHaveLength(1);
    for (const key of ["runPackage", "codePackage", "codeInstallId", "verifiedStepId"]) {
      expect(data[0]!.metadata).not.toHaveProperty(key);
    }
  });

  it("records a context failure as `failed`, with no package fields and never its text", async () => {
    query.mockRejectedValue(new Error(LEAKY));
    const outcome = await call("parent_tool");
    expect(outcome).toMatchObject({ ok: false, status: 500 });
    const events = await settledEvents(1);
    expect(events[0]).toMatchObject({ decision: "denied", deniedCooldown: "record_every" });
    expect(events[0]).not.toHaveProperty("resourceId");
    expect(events[0]!.metadata).toEqual({
      runPackage: null,
      codePackage: null,
      codeInstallId: null,
      verifiedStepId: STEP,
      reason: "failed",
    });
    expect(JSON.stringify(events[0])).not.toContain("/srv/fixture-store");
  });
});

/**
 * THE EVENT NEVER CHANGES THE ANSWER AND NEVER SKIPS A CALL (cinatra#4154 C2
 * fold 1). The dispatch reads the call's `tool` and `run` exactly as often and
 * in the same order as without the event; the event takes what those reads
 * saw. A throw whose class cannot be read stays the fixed 500. A run field
 * that cannot be read is left out of the event, never the event. The answer
 * never waits for the write.
 */
describe("the dispatch event and the answer", () => {
  beforeEach(() => {
    query.mockReset();
    getAgentPackage.mockReset();
    loadDeclaredToolModule.mockReset();
    resolveExtensionToolOrigin.mockReset();
    logAuditEvent.mockReset().mockResolvedValue(undefined);
    query.mockResolvedValue({ rows: [{ package_name: PARENT }] });
    getAgentPackage.mockResolvedValue({ manifest: { cinatra: PARENT_CINATRA } });
  });

  it("answers a resolver throw whose class check throws with the fixed 500, never its text", async () => {
    const { ExtensionDataRefusal } = await import("@/lib/extension-data-tool");
    const { PASSTHROUGH_UNEXPECTED_ERROR } = await import("@/lib/passthrough-refusal");
    const replacement = new ExtensionDataRefusal("fixture", LEAKY);
    const trap = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw replacement;
        },
      },
    );
    resolveExtensionToolOrigin.mockRejectedValue(trap);
    const outcome = await call("child_tool");
    expect(outcome).toEqual({ ok: false, status: 500, error: PASSTHROUGH_UNEXPECTED_ERROR });
    const events = await settledEvents(1);
    expect(events[0]!.metadata).toMatchObject({ reason: "failed", codePackage: null });
    expect(events[0]!.metadata).not.toHaveProperty("originCode");
    expect(JSON.stringify(events[0])).not.toContain("/srv/fixture-store");
  });

  it("answers a tool name that throws on its first read with the fixed 500, and records the call", async () => {
    const { PASSTHROUGH_UNEXPECTED_ERROR } = await import("@/lib/passthrough-refusal");
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    resolveExtensionToolOrigin.mockResolvedValue({ kind: "parent" });
    loadDeclaredToolModule.mockResolvedValue({ extensionTool: () => ({ ran: "parent" }) });
    let reads = 0;
    const input = {
      get tool(): string {
        reads += 1;
        if (reads === 1) throw new Error(LEAKY);
        return "extension_tool";
      },
      input: { name: "parent_tool", input: {} },
      run: RUN,
    };
    const outcome = await dispatchExtensionScopedTool(input);
    expect(outcome).toEqual({ ok: false, status: 500, error: PASSTHROUGH_UNEXPECTED_ERROR });
    expect(loadDeclaredToolModule).not.toHaveBeenCalled();
    const events = await settledEvents(1);
    expect(events[0]).toMatchObject({ decision: "denied", runId: RUN.id });
    expect(events[0]!.metadata).toMatchObject({ reason: "failed", codePackage: null });
  });

  it("reads the run no more often than the dispatch does, so the no-package refusal stays", async () => {
    query.mockResolvedValue({ rows: [] });
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    let reads = 0;
    const input = {
      tool: "extension_tool",
      input: { name: "parent_tool", input: {} },
      get run(): typeof RUN {
        reads += 1;
        if (reads > 2) throw new Error(LEAKY);
        return RUN;
      },
    };
    const outcome = await dispatchExtensionScopedTool(input);
    expect(outcome).toMatchObject({
      ok: false,
      status: 403,
      error: expect.stringContaining("resolves to no extension package"),
    });
    const events = await settledEvents(1);
    expect(reads).toBe(2);
    expect(events[0]).toMatchObject({ organizationId: RUN.orgId, runId: RUN.id, decision: "denied" });
    expect(events[0]!.metadata).toMatchObject({ reason: "refused", verifiedStepId: STEP });
  });

  it("writes the event without the run id when the run's id cannot be read", async () => {
    resolveExtensionToolOrigin.mockResolvedValue({ kind: "parent" });
    loadDeclaredToolModule.mockResolvedValue({ extensionTool: () => ({ ran: "parent" }) });
    const run: Record<string, unknown> = { ...RUN };
    Object.defineProperty(run, "id", {
      get() {
        throw new Error(LEAKY);
      },
    });
    expect(await call("parent_tool", run)).toEqual({ ok: true, result: { ran: "parent" } });
    const events = await settledEvents(1);
    expect(events[0]).toMatchObject({ organizationId: RUN.orgId, decision: "allowed" });
    expect(events[0]).not.toHaveProperty("runId");
    expect(events[0]!.metadata).toEqual({
      runPackage: PARENT,
      codePackage: PARENT,
      codeInstallId: null,
      verifiedStepId: STEP,
    });
  });

  it("answers without waiting for the dispatch event to be written", async () => {
    await import("@/lib/extension-scoped-tools");
    resolveExtensionToolOrigin.mockResolvedValue({ kind: "parent" });
    loadDeclaredToolModule.mockResolvedValue({ extensionTool: () => ({ ran: "parent" }) });
    logAuditEvent.mockImplementation(() => new Promise<void>(() => {}));
    const late = Symbol("late");
    const answer = await Promise.race([
      call("parent_tool"),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(late), 2000)),
    ]);
    expect(answer).toEqual({ ok: true, result: { ran: "parent" } });
    await vi.waitFor(() => expect(dispatchEvents()).toHaveLength(1));
  });
});
