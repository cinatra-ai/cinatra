/**
 * cinatra#3745 — an extension-scoped tool answers a refused run tool call with
 * the passthrough's fixed 403 outcome.
 *
 * The outward-action refusal, the action-check refusal and the step-tool
 * policy refusal end the call with status 403, one fixed sentence and the
 * refusal's code; the outcome carries no other text. An error that only
 * borrows one of those class names, an error with the zod marker (a refusal
 * class included, cinatra#4465), and every other error keep the generic 500
 * outcome with the fixed failure sentence (cinatra#4223), never their
 * message. The scope's own refusals keep their 403 and their message.
 *
 * The run's extension context, the table operation and the host's argument
 * preparation module (the three refusal classes and its identity reading of
 * them, which run-tool-argument-preparation-3745.test.ts pins on the real
 * module) are test doubles; the dispatch and its error mapping are the real
 * ones.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class OutwardActionRefusal extends Error {
    constructor(readonly code: string) { super(code); this.name = "OutwardActionRefusal"; }
  }
  class ArtifactActionCheckRefusal extends Error {
    constructor(readonly code: string) { super(code); this.name = "ArtifactActionCheckRefusal"; }
  }
  class RunStepToolPolicyRefusal extends Error {
    constructor(readonly code: string) { super(code); this.name = "RunStepToolPolicyRefusal"; }
  }
  return {
    OutwardActionRefusal,
    ArtifactActionCheckRefusal,
    RunStepToolPolicyRefusal,
    // The host's reading: the code of an instance of one of the three classes, else null.
    runActionRefusalClassCode: (err: unknown): string | null => {
      if (!(err instanceof OutwardActionRefusal) && !(err instanceof ArtifactActionCheckRefusal) &&
          !(err instanceof RunStepToolPolicyRefusal)) return null;
      const code = (err as { code?: unknown }).code;
      return typeof code === "string" && code.length > 0 ? code : null;
    },
    runOperation: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/pooled", async () => ({
  ...await vi.importActual<typeof import("@/lib/db/pooled")>("@/lib/db/pooled"),
  getPooledDb: () => ({ connect: async () => ({ release: () => {} }) }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://unused",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@cinatra-ai/registries", () => ({ getAgentPackage: vi.fn() }));
vi.mock("@cinatra-ai/agents/installed-oas-path", () => ({
  probeInstalledOasPathForRead: () => ({ path: null }),
}));
vi.mock("@/lib/verdaccio-config", () => ({ loadVerdaccioConfigForReads: async () => ({}) }));
// The run resolves to one fixture extension that declares one table.
vi.mock("@/lib/extension-run-package", () => ({
  resolveRunExtensionContext: async () => ({
    packageName: "@fixture-scope/fixture-data-pack",
    packageVersion: "1.2.3",
    cinatra: { declaredTables: [{ name: "fixture_rows", columns: [{ name: "id", type: "text" }] }] },
  }),
}));
vi.mock("@cinatra-ai/sdk-extensions/manifest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cinatra-ai/sdk-extensions/manifest")>()),
  parseDeclaredTables: () => [{ name: "fixture_rows" }],
}));
vi.mock("@/lib/extension-data-tool", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extension-data-tool")>()),
  runExtensionDataOperation: (...args: unknown[]) => h.runOperation(...args),
}));
// The three refusal classes and the identity reading of them, from the host's
// argument preparation module (it names the run store's class itself).
vi.mock("@/lib/extension-host-context", () => ({
  OutwardActionRefusal: h.OutwardActionRefusal,
  ArtifactActionCheckRefusal: h.ArtifactActionCheckRefusal,
  runActionRefusalClassCode: h.runActionRefusalClassCode,
}));

import { dispatchExtensionScopedTool } from "@/lib/extension-scoped-tools";
import { PASSTHROUGH_UNEXPECTED_ERROR } from "@/lib/passthrough-refusal";

const RUN = { id: "run-1", orgId: "org-1", runBy: "user-1", templateId: "tmpl-1", packageVersion: "1.2.3" };
const SENTENCE = "The run's tool call was refused.";

function call(input: Record<string, unknown> = { table: "fixture_rows", operation: "select" }) {
  return dispatchExtensionScopedTool({ tool: "extension_data", input, run: RUN });
}

beforeEach(() => {
  h.runOperation.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a refused run tool call answers the fixed 403 outcome", () => {
  it.each([
    ["the outward-action refusal", () => new h.OutwardActionRefusal("action_loaded_identity_missing_or_stale")],
    ["the action-check refusal", () => new h.ArtifactActionCheckRefusal("action_checker_missing_or_ambiguous")],
    ["the step-tool policy refusal", () => new h.RunStepToolPolicyRefusal("step_tool_not_declared")],
  ])("%s", async (_label, make) => {
    const error = make();
    h.runOperation.mockRejectedValue(error);
    expect(await call()).toEqual({ ok: false, status: 403, error: SENTENCE, code: error.code });
  });
});

describe("every other error keeps its answer", () => {
  it("an error that only borrows a refusal class name is a 500 with the fixed failure sentence", async () => {
    h.runOperation.mockRejectedValue(
      Object.assign(new Error("lookalike failure"), { name: "OutwardActionRefusal", code: "x" }),
    );
    expect(await call()).toEqual({ ok: false, status: 500, error: PASSTHROUGH_UNEXPECTED_ERROR });
  });

  it("an ordinary error is a 500 with the fixed failure sentence, never its message", async () => {
    h.runOperation.mockRejectedValue(new Error("table read failed: detail"));
    expect(await call()).toEqual({ ok: false, status: 500, error: PASSTHROUGH_UNEXPECTED_ERROR });
  });

  it("a refusal that carries the zod marker is a 500 with the fixed failure sentence (cinatra#4465)", async () => {
    h.runOperation.mockRejectedValue(
      Object.assign(new h.RunStepToolPolicyRefusal("step_tool_not_declared"), {
        _zod: { traits: new Set(["$ZodError"]) },
        issues: [{ path: ["table"], code: "invalid_type", expected: "string" }],
      }),
    );
    expect(await call()).toEqual({ ok: false, status: 500, error: PASSTHROUGH_UNEXPECTED_ERROR });
  });

  it("M3 a callable refusal that carries the zod marker is a 500 with the fixed failure sentence", async () => {
    // A function whose prototype is the refusal's: an Error by instanceof, of type "function".
    const callable = Object.setPrototypeOf(function refused() {}, h.RunStepToolPolicyRefusal.prototype) as unknown as Error;
    Object.defineProperty(callable, "name", { value: "RunStepToolPolicyRefusal" });
    Object.assign(callable, {
      code: "step_tool_not_declared",
      _zod: { traits: new Set(["$ZodError"]) },
      issues: [{ path: ["table"], code: "invalid_type", expected: "string" }],
    });
    h.runOperation.mockRejectedValue(callable);
    expect(await call()).toEqual({ ok: false, status: 500, error: PASSTHROUGH_UNEXPECTED_ERROR });
  });

  it("the scope's own refusal keeps its 403 and its message", async () => {
    expect(await call({ operation: "select" })).toEqual({
      ok: false,
      status: 403,
      error: "extension_data: `table` and `operation` are required",
    });
    expect(h.runOperation).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  vi.doUnmock("server-only");
  vi.doUnmock("@/lib/db/pooled");
  vi.doUnmock("@/lib/postgres-config");
  vi.doUnmock("@/lib/postgres-schema-init");
  vi.doUnmock("@cinatra-ai/registries");
  vi.doUnmock("@cinatra-ai/agents/installed-oas-path");
  vi.doUnmock("@/lib/verdaccio-config");
  vi.doUnmock("@/lib/extension-run-package");
  vi.doUnmock("@cinatra-ai/sdk-extensions/manifest");
  vi.doUnmock("@/lib/extension-data-tool");
  vi.doUnmock("@/lib/extension-host-context");
  vi.resetModules();
});
