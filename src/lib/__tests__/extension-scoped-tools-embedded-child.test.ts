/**
 * AN EMBEDDED CHILD STEP'S `extension_tool` CALL RUNS THE CHILD'S CODE
 * (cinatra#4154, part C): the scoped dispatch asks the origin resolver whose
 * code the proven step reaches, and for a child it loads the child's declared
 * module from the exact child installation, with the ports bound to the
 * child's declarations and to this same run. A refusal of the resolver is a
 * 403 carrying its fixed sentence, and nothing is loaded.
 *
 * The resolver itself is pinned in extension-tool-origin.test.ts; here it is
 * stubbed, and the dispatch, the declaration parse, the envelope rule and the
 * port wiring are the real ones. The packages are fixtures.
 *
 *   pnpm exec vitest run src/lib/__tests__/extension-scoped-tools-embedded-child.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const getAgentPackage = vi.fn();
const loadDeclaredToolModule = vi.fn();
const resolveExtensionToolOrigin = vi.fn();

vi.mock("@/lib/db/pooled", async () => ({
  ...await vi.importActual<typeof import("@/lib/db/pooled")>("@/lib/db/pooled"),
  getPooledDb: () => ({ query: (...a: unknown[]) => query(...a) }),
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
const PARENT_TOOL = { name: "parent_tool", module: "./cinatra/tools/parent-tool.mjs" };
const CHILD_TOOL = { name: "child_tool", module: "./cinatra/tools/child-tool.mjs", embeddable: true };
const PARENT_CINATRA = {
  dependencies: [{ packageName: CHILD, kind: "agent" }],
  tools: [PARENT_TOOL],
  declaredTables: [{ name: "parent_rows", columns: [{ name: "id", type: "text" }], primaryKey: ["id"] }],
};
const CHILD_CINATRA = { tools: [CHILD_TOOL] };
const RUN = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tmpl-1",
  packageVersion: "2.0.0",
  dependentInstallId: "install-parent",
  verifiedStepId: "child-embed_step",
};
const stillBound = async () => true;
const CHILD_ORIGIN = {
  kind: "child",
  codeInstallId: "install-child",
  context: { packageName: CHILD, packageVersion: "0.1.1", cinatra: CHILD_CINATRA },
  install: { installId: "install-child", digest: "digest-child", stillBound },
};

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("dispatchExtensionScopedTool — the origin of an extension_tool call", () => {
  beforeEach(() => {
    query.mockReset();
    getAgentPackage.mockReset();
    loadDeclaredToolModule.mockReset();
    resolveExtensionToolOrigin.mockReset();
    query.mockResolvedValue({ rows: [{ package_name: PARENT }] });
    getAgentPackage.mockResolvedValue({ manifest: { cinatra: PARENT_CINATRA } });
  });

  it("asks the resolver with the run, the run package's context and the request", async () => {
    resolveExtensionToolOrigin.mockResolvedValue({ kind: "parent" });
    loadDeclaredToolModule.mockResolvedValue({ extensionTool: () => ({ ok: true }) });
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const request = { name: "parent_tool", input: {} };
    await dispatchExtensionScopedTool({ tool: "extension_tool", input: request, run: RUN });
    expect(resolveExtensionToolOrigin).toHaveBeenCalledWith({
      run: RUN,
      context: { packageName: PARENT, packageVersion: "2.0.0", cinatra: PARENT_CINATRA },
      request,
    });
  });

  it("runs a parent step's tool from the run package, with no install binding", async () => {
    resolveExtensionToolOrigin.mockResolvedValue({ kind: "parent" });
    loadDeclaredToolModule.mockResolvedValue({ extensionTool: () => ({ ran: "parent" }) });
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: "extension_tool",
      input: { name: "parent_tool", input: {} },
      run: RUN,
    });
    expect(outcome).toEqual({ ok: true, result: { ran: "parent" } });
    expect(loadDeclaredToolModule).toHaveBeenCalledWith(
      { packageName: PARENT, packageVersion: "2.0.0", orgId: RUN.orgId, toolName: "parent_tool",
        modulePath: PARENT_TOOL.module },
      expect.anything(),
    );
  });

  it("runs a proven child step's tool from the exact child installation", async () => {
    resolveExtensionToolOrigin.mockResolvedValue(CHILD_ORIGIN);
    loadDeclaredToolModule.mockResolvedValue({ extensionTool: () => ({ ran: "child" }) });
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: "extension_tool",
      input: { name: "child_tool", input: {} },
      run: RUN,
    });
    expect(outcome).toEqual({ ok: true, result: { ran: "child" } });
    expect(loadDeclaredToolModule).toHaveBeenCalledWith(
      {
        packageName: CHILD,
        packageVersion: "0.1.1",
        orgId: RUN.orgId,
        toolName: "child_tool",
        modulePath: CHILD_TOOL.module,
        install: { installId: "install-child", digest: "digest-child", stillBound },
      },
      expect.anything(),
    );
  });

  it("binds a child tool's ports to the child's declarations, not the parent's", async () => {
    resolveExtensionToolOrigin.mockResolvedValue(CHILD_ORIGIN);
    loadDeclaredToolModule.mockResolvedValue({
      extensionTool: async ({ ports }: { ports: { data: { select: (r: unknown) => Promise<unknown> } } }) =>
        ports.data.select({ table: "parent_rows" }),
    });
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: "extension_tool",
      input: { name: "child_tool", input: {} },
      run: RUN,
    });
    // The parent declares that table; the child declares none, so the child's code reaches none.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(403);
    expect(outcome.error).toBe(
      `extension_data: ${CHILD} declares no tables — the tool operates only on the calling extension's declared tables`,
    );
  });

  it("refuses a parent-declared name on the child road: the child declaration is the only one read", async () => {
    resolveExtensionToolOrigin.mockResolvedValue(CHILD_ORIGIN);
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: "extension_tool",
      input: { name: "parent_tool", input: {} },
      run: RUN,
    });
    expect(outcome).toEqual({
      ok: false,
      status: 403,
      error: "extension_tool: `name` must be one of the calling extension's own declared tools",
    });
    expect(loadDeclaredToolModule).not.toHaveBeenCalled();
  });

  it("answers a resolver refusal with 403 and its fixed sentence, and loads nothing", async () => {
    const { ExtensionToolOriginRefusal } = await import("@/lib/extension-tool-origin");
    resolveExtensionToolOrigin.mockRejectedValue(new ExtensionToolOriginRefusal("provenance-mismatch"));
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: "extension_tool",
      input: { name: "child_tool", input: {} },
      run: RUN,
    });
    expect(outcome).toEqual({
      ok: false,
      status: 403,
      error: "extension_tool: the calling step reaches no tool of this origin (provenance-mismatch)",
    });
    expect(loadDeclaredToolModule).not.toHaveBeenCalled();
  });

  it("never asks the resolver for the other scoped tools", async () => {
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    await dispatchExtensionScopedTool({ tool: "artifacts_list", input: {}, run: RUN });
    expect(resolveExtensionToolOrigin).not.toHaveBeenCalled();
  });
});
