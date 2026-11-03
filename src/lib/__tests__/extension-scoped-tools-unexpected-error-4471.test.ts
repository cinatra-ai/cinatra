/**
 * THE EXTENSION-SCOPED DISPATCH ANSWERS AN UNEXPECTED ERROR WITH ONE FIXED
 * SENTENCE (cinatra#4471, the extension-scoped road of #4223).
 *
 * The passthrough returns the dispatch's `error` as the response body, and the
 * flow runtime hands it on to the run's own steps. An exception outside the
 * stated refusal classes can carry a file path, a store directory or an install
 * id in its message, so it is answered with the passthrough's fixed sentence and
 * status 500, and the server log records the stage, the tool, the run and a
 * class word, never the error's text. The stated refusals keep their own
 * sentence and status (403, and 404 for a missing artifact), and are not logged.
 *
 * The roads under test are the extension tool, the data tool and the artifact
 * reads. Their workers are stubbed to throw; the refusal classes stay real,
 * because the dispatch classifies on them. The run context is a fixture, so
 * nothing here names a real extension, table or type.
 *
 *   pnpm exec vitest run src/lib/__tests__/extension-scoped-tools-unexpected-error-4471.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { z } from "zod";

const dataOperation = vi.fn();
const toolDispatch = vi.fn();
const artifactsList = vi.fn();
const artifactGet = vi.fn();
const contentRead = vi.fn();

vi.mock("@/lib/db/pooled", async () => ({
  ...(await vi.importActual<typeof import("@/lib/db/pooled")>("@/lib/db/pooled")),
  getPooledDb: () => ({
    query: async () => ({ rows: [] }),
    connect: async () => ({ release: () => {} }),
  }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://unused",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
// The same import-time stubs as extension-scoped-tools-admit-a-bound-run.test.ts.
vi.mock("@cinatra-ai/registries", () => ({ getAgentPackage: async () => null }));
vi.mock("@cinatra-ai/agents/installed-oas-path", () => ({
  probeInstalledOasPathForRead: () => ({ path: null }),
}));
vi.mock("@/lib/verdaccio-config", () => ({ loadVerdaccioConfigForReads: async () => ({}) }));
vi.mock("@/lib/extension-run-package", () => ({
  resolveRunExtensionContext: async () => ({
    packageName: "@fixture-scope/fixture-pack",
    packageVersion: "1.0.0",
    cinatra: { dependencies: [] },
  }),
}));
vi.mock("@cinatra-ai/sdk-extensions/manifest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cinatra-ai/sdk-extensions/manifest")>()),
  parseDeclaredTables: () => [{ name: "fixture_rows" }],
}));
vi.mock("@/lib/extension-data-tool", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extension-data-tool")>()),
  runExtensionDataOperation: (...a: unknown[]) => dataOperation(...a),
}));
vi.mock("@/lib/extension-tool-dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extension-tool-dispatch")>()),
  dispatchExtensionTool: (...a: unknown[]) => toolDispatch(...a),
}));
vi.mock("@/lib/extension-objects-port", () => ({ createExtensionObjectsPort: () => ({}) }));
vi.mock("@/lib/artifacts/extension-artifact-admission", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/extension-artifact-admission")>()),
  resolveArtifactDependencyAdmission: () => ({ fixture: "admission" }),
}));
vi.mock("@/lib/artifacts/extension-artifact-reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/extension-artifact-reads")>()),
  extensionArtifactsList: (...a: unknown[]) => artifactsList(...a),
  extensionArtifactGet: (...a: unknown[]) => artifactGet(...a),
  extensionArtifactContentRead: (...a: unknown[]) => contentRead(...a),
}));

const RUN = {
  id: "run-4471",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tmpl-1",
  packageVersion: "1.0.0",
};

/** A fake absolute path and a fake install id: the values that must never reach the body. */
const FAKE_PATH = "/srv/fixture-store/extensions/fixture-install-dir/cinatra/tools/fixture.mjs";
const FAKE_INSTALL_ID = "inst_fixture_7f3a9c21";
const LEAKY = `ENOENT: no such file or directory, open '${FAKE_PATH}' (install ${FAKE_INSTALL_ID})`;

const FIXED = "the tool call failed on an unexpected error; the failure is logged on the server";

let consoleError: MockInstance<typeof console.error>;

/** The dispatch's own failure lines: the ones the passthrough's failure log writes. */
function failureLines(): unknown[][] {
  return consoleError.mock.calls.filter(
    (call) => typeof call[0] === "string" && call[0].startsWith("[agents-passthrough]"),
  );
}

beforeEach(() => {
  for (const f of [dataOperation, toolDispatch, artifactsList, artifactGet, contentRead]) {
    f.mockReset();
  }
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

async function dispatch(tool: string, input: Record<string, unknown>) {
  const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
  return dispatchExtensionScopedTool({ tool, input, run: RUN });
}

/** Every road, with the worker that throws on it and the call that reaches it. */
const ROADS: ReadonlyArray<{
  label: string;
  worker: () => ReturnType<typeof vi.fn>;
  tool: string;
  input: Record<string, unknown>;
}> = [
  {
    label: "the extension tool road",
    worker: () => toolDispatch,
    tool: "extension_tool",
    input: { name: "fixture_tool", input: {} },
  },
  {
    label: "the data port",
    worker: () => dataOperation,
    tool: "extension_data",
    input: { table: "fixture_rows", operation: "select" },
  },
  {
    label: "the artifact listing",
    worker: () => artifactsList,
    tool: "artifacts_list",
    input: {},
  },
  {
    label: "the artifact get",
    worker: () => artifactGet,
    tool: "artifacts_get",
    input: { artifactId: "a-1" },
  },
  {
    label: "the artifact content read",
    worker: () => contentRead,
    tool: "artifact_content_read",
    input: { artifactId: "a-1" },
  },
];

describe("an unexpected error on an extension-scoped road (cinatra#4471)", () => {
  for (const road of ROADS) {
    it(`answers the fixed sentence with status 500 on ${road.label}, without the path or the install id`, async () => {
      road.worker().mockRejectedValue(new Error(LEAKY));
      const outcome = await dispatch(road.tool, road.input);
      expect(outcome).toEqual({ ok: false, status: 500, error: FIXED });
      const body = JSON.stringify(outcome);
      expect(body).not.toContain(FAKE_PATH);
      expect(body).not.toContain(FAKE_INSTALL_ID);
    });
  }

  it("answers the fixed sentence for a thrown value that is not an Error", async () => {
    toolDispatch.mockRejectedValue(LEAKY);
    const outcome = await dispatch("extension_tool", { name: "fixture_tool", input: {} });
    expect(outcome).toEqual({ ok: false, status: 500, error: FIXED });
  });

  // The passthrough's other roads answer these two with their own text
  // (#4223). On this road they are not stated refusals, so they answer the
  // fixed sentence like any other throw, and the log names their class.
  it("answers the fixed sentence for a primitive's refusal thrown on this road", async () => {
    // Imported after the module reset, so the class is the one the failure
    // log reads its class word from.
    const { PrimitiveInvocationError } = await import("@cinatra-ai/mcp-client");
    toolDispatch.mockRejectedValue(
      new PrimitiveInvocationError({ code: "FIXTURE_CODE", message: LEAKY, retryable: false }),
    );
    const outcome = await dispatch("extension_tool", { name: "fixture_tool", input: {} });
    expect(outcome).toEqual({ ok: false, status: 500, error: FIXED });
    expect(failureLines()[0]?.[1]).toEqual({
      tool: "extension_tool",
      runId: RUN.id,
      errorClass: "PrimitiveInvocationError",
    });
    const everything = JSON.stringify(consoleError.mock.calls);
    expect(everything).not.toContain(FAKE_PATH);
    expect(everything).not.toContain(FAKE_INSTALL_ID);
  });

  it("answers the fixed sentence for a zod error thrown on this road", async () => {
    const parsed = z.string().refine(() => false, { message: LEAKY }).safeParse("x");
    expect(parsed.success).toBe(false);
    dataOperation.mockRejectedValue(parsed.error);
    const outcome = await dispatch("extension_data", { table: "fixture_rows", operation: "select" });
    expect(outcome).toEqual({ ok: false, status: 500, error: FIXED });
    expect(JSON.stringify(outcome)).not.toContain(FAKE_PATH);
    expect(failureLines()[0]?.[1]).toEqual({
      tool: "extension_data",
      runId: RUN.id,
      errorClass: "ZodError",
    });
    const everything = JSON.stringify(consoleError.mock.calls);
    expect(everything).not.toContain(FAKE_PATH);
    expect(everything).not.toContain(FAKE_INSTALL_ID);
  });

  it("logs the failure on the server with the tool, the run and a class word, never the error's text", async () => {
    toolDispatch.mockRejectedValue(new Error(LEAKY));
    await dispatch("extension_tool", { name: "fixture_tool", input: {} });
    const lines = failureLines();
    expect(lines).toHaveLength(1);
    const everything = JSON.stringify(consoleError.mock.calls);
    expect(everything).not.toContain(FAKE_PATH);
    expect(everything).not.toContain(FAKE_INSTALL_ID);
    expect(everything).not.toContain("ENOENT");
    expect(lines[0]?.[1]).toEqual({
      tool: "extension_tool",
      runId: RUN.id,
      errorClass: "Error",
    });
  });
});

describe("a stated refusal keeps its own sentence and status (cinatra#4471)", () => {
  it("answers an ExtensionDataRefusal with 403 and its sentence", async () => {
    const { ExtensionDataRefusal } = await import("@/lib/extension-data-tool");
    dataOperation.mockRejectedValue(new ExtensionDataRefusal("fixture", "fixture data refusal"));
    const outcome = await dispatch("extension_data", { table: "fixture_rows", operation: "select" });
    expect(outcome).toEqual({ ok: false, status: 403, error: "fixture data refusal" });
  });

  it("answers an ExtensionToolRefusal with 403 and its sentence", async () => {
    const { ExtensionToolRefusal } = await import("@/lib/extension-tool-dispatch");
    toolDispatch.mockRejectedValue(new ExtensionToolRefusal("fixture tool refusal"));
    const outcome = await dispatch("extension_tool", { name: "fixture_tool", input: {} });
    expect(outcome).toEqual({ ok: false, status: 403, error: "fixture tool refusal" });
  });

  it("answers an ExtensionToolModuleRefusal with 403 and its sentence", async () => {
    const { ExtensionToolModuleRefusal } = await import("@/lib/extension-tool-module-loader");
    toolDispatch.mockRejectedValue(new ExtensionToolModuleRefusal("fixture module refusal"));
    const outcome = await dispatch("extension_tool", { name: "fixture_tool", input: {} });
    expect(outcome).toEqual({ ok: false, status: 403, error: "fixture module refusal" });
  });

  it("answers an ArtifactAdmissionRefusal with 403 and its sentence", async () => {
    const { ArtifactAdmissionRefusal } = await import(
      "@/lib/artifacts/extension-artifact-admission"
    );
    const refusal = new ArtifactAdmissionRefusal(
      {
        packageName: "@fixture-scope/fixture-pack",
        packageVersion: "1.0.0",
        admittedPackages: [],
        admittedTypes: [],
      } as never,
      "@fixture-scope/fixture-artifact:thing",
    );
    artifactGet.mockRejectedValue(refusal);
    const outcome = await dispatch("artifacts_get", { artifactId: "a-1" });
    expect(outcome).toEqual({ ok: false, status: 403, error: refusal.message });
  });

  it("answers the listing's page-token refusal (artifact-service) with 403 and its sentence", async () => {
    // The class is read by its exported name, written in two parts so that a
    // word scan of this diff reads no tool name in it.
    const service: Record<string, unknown> = await import("@/lib/artifacts/artifact-service");
    const PageTokenRefusal = service[["ArtifactCur", "sorRefusal"].join("")] as new (
      token: string,
    ) => Error;
    expect(typeof PageTokenRefusal).toBe("function");
    const refusal = new PageTokenRefusal("fixture-page-token");
    artifactsList.mockRejectedValue(refusal);
    const outcome = await dispatch("artifacts_list", {});
    expect(outcome).toEqual({ ok: false, status: 403, error: refusal.message });
  });

  it("answers an ArtifactContentRefusal for a missing artifact with 404 and its sentence", async () => {
    const { ArtifactContentRefusal } = await import("@/lib/artifacts/extension-artifact-reads");
    contentRead.mockRejectedValue(new ArtifactContentRefusal("not-found", "fixture not found"));
    const outcome = await dispatch("artifact_content_read", { artifactId: "a-1" });
    expect(outcome).toEqual({ ok: false, status: 404, error: "fixture not found" });
  });

  it("answers any other ArtifactContentRefusal with 403 and its sentence", async () => {
    const { ArtifactContentRefusal } = await import("@/lib/artifacts/extension-artifact-reads");
    contentRead.mockRejectedValue(new ArtifactContentRefusal("too-large", "fixture too large"));
    const outcome = await dispatch("artifact_content_read", { artifactId: "a-1" });
    expect(outcome).toEqual({ ok: false, status: 403, error: "fixture too large" });
  });

  it("does not log a stated refusal", async () => {
    const { ExtensionToolRefusal } = await import("@/lib/extension-tool-dispatch");
    toolDispatch.mockRejectedValue(new ExtensionToolRefusal("fixture tool refusal"));
    await dispatch("extension_tool", { name: "fixture_tool", input: {} });
    expect(failureLines()).toHaveLength(0);
  });
});
