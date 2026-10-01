/**
 * EVERY PACK'S `extension_tool` CALL REACHES THE MODULE IT DECLARES
 * (cinatra#3249, #3035).
 *
 * The passthrough runs the calling extension's own declared module for the
 * one generic name `extension_tool`, whatever that extension's flow looks
 * like. A flow that calls the passthrough from its own nodes gets no road of
 * its own in the application: the call is resolved against the caller's
 * declared tools and handed to that module with the ports, and a set of
 * review targets the module files rides out on the result.
 *
 * The extension under test is a FIXTURE one (a fixture scope, the fixture
 * tool name of the admission suite beside this file), so nothing here names
 * an extension, a table, a type or a state.
 *
 *   pnpm exec vitest run src/lib/__tests__/extension-tool-reaches-the-declared-module.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const query = vi.fn();
const getAgentPackage = vi.fn();
const loadDeclaredToolModule = vi.fn();
/** The declaration file the installed-declaration probe answers with. */
let declarationPath: string | null = null;

vi.mock("@/lib/db/pooled", () => ({
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
// THE INSTALLED DECLARATION. The probe answers a declaration this file writes
// under a temporary directory, so a case can hand the dispatch a flow that
// calls the passthrough from its own nodes, or one that does not.
vi.mock("@cinatra-ai/agents/installed-oas-path", () => ({
  probeInstalledOasPathForRead: () => ({ path: declarationPath }),
}));
vi.mock("@/lib/verdaccio-config", () => ({ loadVerdaccioConfigForReads: async () => ({}) }));
// Only the LOAD road is stubbed: the declaration parse, the name resolution,
// the envelope rule, the port wiring and the review filing are the real ones.
vi.mock("@/lib/extension-tool-module-loader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extension-tool-module-loader")>()),
  loadDeclaredToolModule: (...args: unknown[]) => loadDeclaredToolModule(...args),
}));

const PACK = "@fixture-scope/fixture-tool-pack";
const DECLARED = { name: "fixture_tool", module: "./cinatra/tools/fixture-tool.mjs" };

/** The run row as the passthrough hands it over, pinned to its own version. */
const RUN = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tmpl-1",
  packageVersion: "1.2.3",
};

const CALL = { name: "fixture_tool", input: { op: "review" } };

let tmpRoot = "";
let callsThePassthrough = "";
let callsNoPassthrough = "";

function writeDeclaration(name: string, url: string): string {
  const file = path.join(tmpRoot, name);
  writeFileSync(
    file,
    JSON.stringify({
      component_type: "Flow",
      name: "fixture flow",
      nodes: [
        {
          component_type: "ApiNode",
          name: "run_fixture_tool",
          url,
          http_method: "POST",
          data: { tool: "extension_tool", input: CALL },
        },
      ],
    }),
  );
  return file;
}

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "extension-tool-declared-module-"));
  callsThePassthrough = writeDeclaration(
    "calls-the-passthrough.json",
    "{{CINATRA_BASE_URL}}/api/agents/passthrough",
  );
  callsNoPassthrough = writeDeclaration(
    "calls-no-passthrough.json",
    "{{CINATRA_BASE_URL}}/api/fixture-elsewhere",
  );
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.doUnmock("@/lib/db/pooled");
  vi.doUnmock("@/lib/postgres-config");
  vi.doUnmock("@/lib/postgres-schema-init");
  vi.doUnmock("@cinatra-ai/registries");
  vi.doUnmock("@cinatra-ai/agents/installed-oas-path");
  vi.doUnmock("@/lib/verdaccio-config");
  vi.doUnmock("@/lib/extension-tool-module-loader");
  vi.resetModules();
});

beforeEach(() => {
  query.mockReset();
  getAgentPackage.mockReset();
  loadDeclaredToolModule.mockReset();
  query.mockResolvedValue({ rows: [{ package_name: PACK }] });
  getAgentPackage.mockResolvedValue({ manifest: { cinatra: { tools: [DECLARED] } } });
});

afterEach(() => {
  declarationPath = null;
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("extension_tool reaches the module the calling pack declares", () => {
  it("a pack whose own flow calls the passthrough reaches its declared module", async () => {
    declarationPath = callsThePassthrough;
    loadDeclaredToolModule.mockResolvedValue({ extensionTool: () => ({ ok: true }) });
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: "extension_tool",
      input: CALL,
      run: RUN,
    });
    expect(outcome).toEqual({ ok: true, result: { ok: true } });
    expect(loadDeclaredToolModule).toHaveBeenCalledTimes(1);
    expect(loadDeclaredToolModule).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: PACK, toolName: "fixture_tool" }),
      expect.anything(),
    );
  });

  it("the set the module files through its review port rides out at the top of the result", async () => {
    declarationPath = callsThePassthrough;
    loadDeclaredToolModule.mockResolvedValue({
      extensionTool: ({ ports }: { ports: { review: { file(t: unknown): void } } }) => {
        ports.review.file([{ artifactId: "art-post-1", representationRevisionId: "rev-post-1" }]);
        return { ok: true };
      },
    });
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: "extension_tool",
      input: CALL,
      run: RUN,
    });
    expect(outcome).toEqual({
      ok: true,
      result: {
        ok: true,
        reviewTargets: [{ artifactId: "art-post-1", representationRevisionId: "rev-post-1" }],
      },
    });
  });

  it("a pack whose flow names no passthrough node reaches its declared module too", async () => {
    declarationPath = callsNoPassthrough;
    loadDeclaredToolModule.mockResolvedValue({ extensionTool: () => ({ ok: true }) });
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: "extension_tool",
      input: CALL,
      run: RUN,
    });
    expect(outcome).toEqual({ ok: true, result: { ok: true } });
    expect(loadDeclaredToolModule).toHaveBeenCalledTimes(1);
    expect(loadDeclaredToolModule).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: PACK, toolName: "fixture_tool" }),
      expect.anything(),
    );
  });
});
