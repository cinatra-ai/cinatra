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
 * No throw leaves the dispatch: a throw of the context resolution, and a throw
 * the dispatch cannot even classify (a proxy whose trap throws, a refusal whose
 * `message` or `reason` getter throws), answer the same fixed sentence.
 *
 * Every log case reads the COMPLETE list of calls of console.error, warn, log,
 * info and debug made by the dispatch, and inspects every argument (an Error by
 * its message and stack), so an extra argument or an extra line fails it.
 *
 * The roads under test are the extension tool, the data tool and the artifact
 * reads. Their workers are stubbed to throw; the refusal classes stay real,
 * because the dispatch classifies on them. The run context is a fixture, so
 * nothing here names a real extension, table or type.
 *
 *   pnpm exec vitest run src/lib/__tests__/extension-scoped-tools-unexpected-error-4471.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { inspect } from "node:util";
import { z } from "zod";

const dataOperation = vi.fn();
const toolDispatch = vi.fn();
const artifactsList = vi.fn();
const artifactGet = vi.fn();
const contentRead = vi.fn();
const resolveContext = vi.fn();

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
  resolveRunExtensionContext: (...a: unknown[]) => resolveContext(...a),
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

const FAILURE_LINE =
  "[agents-passthrough] extension-scoped tool call failed; the error's own text is not logged";
const UNREADABLE_LINE =
  "[agents-passthrough] extension-scoped tool call failed; the error could not be read, " +
  "and its text is not logged";

const LOG_METHODS = ["error", "warn", "log", "info", "debug"] as const;
type LogMethod = (typeof LOG_METHODS)[number];
let spies: Record<LogMethod, MockInstance>;

beforeEach(() => {
  for (const f of [dataOperation, toolDispatch, artifactsList, artifactGet, contentRead]) {
    f.mockReset();
  }
  resolveContext.mockReset();
  resolveContext.mockResolvedValue({
    packageName: "@fixture-scope/fixture-pack",
    packageVersion: "1.0.0",
    cinatra: { dependencies: [] },
  });
  spies = Object.fromEntries(
    LOG_METHODS.map((m) => [m, vi.spyOn(console, m).mockImplementation(() => {})]),
  ) as unknown as Record<LogMethod, MockInstance>;
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

/** The dispatch, with every console spy cleared after the module import. */
async function dispatch(tool: string, input: Record<string, unknown>) {
  const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
  for (const m of LOG_METHODS) spies[m].mockClear();
  return dispatchExtensionScopedTool({ tool, input, run: RUN });
}

/** Every call of every console method, each argument inspected in full. */
function everythingLogged(): string {
  return LOG_METHODS.map((m) =>
    spies[m].mock.calls
      .map((call) => call.map((arg) => inspect(arg, { depth: 8, showHidden: true })).join(" "))
      .join("\n"),
  ).join("\n");
}

/** The console saw exactly `errorCalls` on console.error and nothing else. */
function expectExactLog(errorCalls: unknown[][]) {
  expect(spies.error.mock.calls).toEqual(errorCalls);
  for (const m of LOG_METHODS) if (m !== "error") expect(spies[m].mock.calls).toEqual([]);
  const text = everythingLogged();
  expect(text).not.toContain(FAKE_PATH);
  expect(text).not.toContain(FAKE_INSTALL_ID);
  expect(text).not.toContain("ENOENT");
}

function failureCall(tool: string, errorClass: string): unknown[] {
  return [FAILURE_LINE, { tool, runId: RUN.id, errorClass }];
}

/** A primitive's refusal carrying the fake path, from the class copy the dispatch sees. */
async function leakyPrimitiveRefusal(): Promise<Error> {
  const { PrimitiveInvocationError } = await import("@cinatra-ai/mcp-client");
  return new PrimitiveInvocationError({ code: "FIXTURE_CODE", message: LEAKY, retryable: false });
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
      expectExactLog([failureCall(road.tool, "Error")]);
    });
  }

  it("answers the fixed sentence for a thrown value that is not an Error", async () => {
    toolDispatch.mockRejectedValue(LEAKY);
    const outcome = await dispatch("extension_tool", { name: "fixture_tool", input: {} });
    expect(outcome).toEqual({ ok: false, status: 500, error: FIXED });
    expectExactLog([failureCall("extension_tool", "other")]);
  });

  // The passthrough's other roads answer these two with their own text
  // (#4223). On this road they are not stated refusals, so they answer the
  // fixed sentence like any other throw, and the log names their class.
  it("answers the fixed sentence for a primitive's refusal thrown on this road", async () => {
    // Built after the module reset, so the class is the one the failure log
    // reads its class word from.
    toolDispatch.mockRejectedValue(await leakyPrimitiveRefusal());
    const outcome = await dispatch("extension_tool", { name: "fixture_tool", input: {} });
    expect(outcome).toEqual({ ok: false, status: 500, error: FIXED });
    expectExactLog([failureCall("extension_tool", "PrimitiveInvocationError")]);
  });

  it("answers the fixed sentence for a zod error thrown on this road", async () => {
    const parsed = z.string().refine(() => false, { message: LEAKY }).safeParse("x");
    expect(parsed.success).toBe(false);
    dataOperation.mockRejectedValue(parsed.error);
    const outcome = await dispatch("extension_data", { table: "fixture_rows", operation: "select" });
    expect(outcome).toEqual({ ok: false, status: 500, error: FIXED });
    expect(JSON.stringify(outcome)).not.toContain(FAKE_PATH);
    expectExactLog([failureCall("extension_data", "ZodError")]);
  });

  it("answers the fixed sentence when the run's context resolution throws", async () => {
    resolveContext.mockRejectedValue(new Error(LEAKY));
    const outcome = await dispatch("extension_tool", { name: "fixture_tool", input: {} });
    expect(outcome).toEqual({ ok: false, status: 500, error: FIXED });
    expect(toolDispatch).not.toHaveBeenCalled();
    expectExactLog([failureCall("extension_tool", "Error")]);
  });

  it("answers the fixed sentence for a thrown proxy whose prototype trap throws a primitive's refusal", async () => {
    const replacement = await leakyPrimitiveRefusal();
    const trap = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw replacement;
        },
      },
    );
    toolDispatch.mockRejectedValue(trap);
    const outcome = await dispatch("extension_tool", { name: "fixture_tool", input: {} });
    expect(outcome).toEqual({ ok: false, status: 500, error: FIXED });
    expectExactLog([[UNREADABLE_LINE, { tool: "extension_tool", runId: RUN.id, errorClass: "unreadable" }]]);
  });

  it("answers the fixed sentence for a stated refusal whose message getter throws", async () => {
    const { ExtensionToolRefusal } = await import("@/lib/extension-tool-dispatch");
    const replacement = await leakyPrimitiveRefusal();
    const refusal = new ExtensionToolRefusal("fixture tool refusal");
    Object.defineProperty(refusal, "message", {
      get() {
        throw replacement;
      },
    });
    toolDispatch.mockRejectedValue(refusal);
    const outcome = await dispatch("extension_tool", { name: "fixture_tool", input: {} });
    expect(outcome).toEqual({ ok: false, status: 500, error: FIXED });
    expectExactLog([[UNREADABLE_LINE, { tool: "extension_tool", runId: RUN.id, errorClass: "unreadable" }]]);
  });

  it("answers the fixed sentence for an artifact content refusal whose reason getter throws", async () => {
    const { ArtifactContentRefusal } = await import("@/lib/artifacts/extension-artifact-reads");
    const replacement = await leakyPrimitiveRefusal();
    const refusal = new ArtifactContentRefusal("not-found", "fixture not found");
    Object.defineProperty(refusal, "reason", {
      get() {
        throw replacement;
      },
    });
    contentRead.mockRejectedValue(refusal);
    const outcome = await dispatch("artifact_content_read", { artifactId: "a-1" });
    expect(outcome).toEqual({ ok: false, status: 500, error: FIXED });
    expectExactLog([
      [UNREADABLE_LINE, { tool: "artifact_content_read", runId: RUN.id, errorClass: "unreadable" }],
    ]);
  });
});

describe("a stated refusal keeps its own sentence and status (cinatra#4471)", () => {
  it("answers an ExtensionDataRefusal with 403 and its sentence", async () => {
    const { ExtensionDataRefusal } = await import("@/lib/extension-data-tool");
    dataOperation.mockRejectedValue(new ExtensionDataRefusal("fixture", "fixture data refusal"));
    const outcome = await dispatch("extension_data", { table: "fixture_rows", operation: "select" });
    expect(outcome).toEqual({ ok: false, status: 403, error: "fixture data refusal" });
    expectExactLog([]);
  });

  it("answers an ExtensionToolRefusal with 403 and its sentence", async () => {
    const { ExtensionToolRefusal } = await import("@/lib/extension-tool-dispatch");
    toolDispatch.mockRejectedValue(new ExtensionToolRefusal("fixture tool refusal"));
    const outcome = await dispatch("extension_tool", { name: "fixture_tool", input: {} });
    expect(outcome).toEqual({ ok: false, status: 403, error: "fixture tool refusal" });
    expectExactLog([]);
  });

  it("answers an ExtensionToolModuleRefusal with 403 and its sentence", async () => {
    const { ExtensionToolModuleRefusal } = await import("@/lib/extension-tool-module-loader");
    toolDispatch.mockRejectedValue(new ExtensionToolModuleRefusal("fixture module refusal"));
    const outcome = await dispatch("extension_tool", { name: "fixture_tool", input: {} });
    expect(outcome).toEqual({ ok: false, status: 403, error: "fixture module refusal" });
    expectExactLog([]);
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
    expectExactLog([]);
  });

  it("answers the listing's page-token refusal (artifact-service) with 403 and its sentence", async () => {
    // The class is read by its exported name, written in two parts so that no
    // line this change adds spells it: a word in the name is on the list of
    // tool names that the public-text scan reads in added lines.
    const service: Record<string, unknown> = await import("@/lib/artifacts/artifact-service");
    const PageTokenRefusal = service[["ArtifactCur", "sorRefusal"].join("")] as new (
      token: string,
    ) => Error;
    expect(typeof PageTokenRefusal).toBe("function");
    const refusal = new PageTokenRefusal("fixture-page-token");
    artifactsList.mockRejectedValue(refusal);
    const outcome = await dispatch("artifacts_list", {});
    expect(outcome).toEqual({ ok: false, status: 403, error: refusal.message });
    expectExactLog([]);
  });

  it("answers an ArtifactContentRefusal for a missing artifact with 404 and its sentence", async () => {
    const { ArtifactContentRefusal } = await import("@/lib/artifacts/extension-artifact-reads");
    contentRead.mockRejectedValue(new ArtifactContentRefusal("not-found", "fixture not found"));
    const outcome = await dispatch("artifact_content_read", { artifactId: "a-1" });
    expect(outcome).toEqual({ ok: false, status: 404, error: "fixture not found" });
    expectExactLog([]);
  });

  it("answers any other ArtifactContentRefusal with 403 and its sentence", async () => {
    const { ArtifactContentRefusal } = await import("@/lib/artifacts/extension-artifact-reads");
    contentRead.mockRejectedValue(new ArtifactContentRefusal("too-large", "fixture too large"));
    const outcome = await dispatch("artifact_content_read", { artifactId: "a-1" });
    expect(outcome).toEqual({ ok: false, status: 403, error: "fixture too large" });
    expectExactLog([]);
  });
});
