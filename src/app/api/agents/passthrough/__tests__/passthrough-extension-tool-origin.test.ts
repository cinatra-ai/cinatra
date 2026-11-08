/**
 * WHOSE CODE AN `extension_tool` CALL RUNS, THROUGH THE ROUTE (cinatra#4154,
 * part C2; spec v2.2 sections 4.1 and 8.4).
 *
 * Drives the real passthrough route, the real scoped dispatch, the real origin
 * resolver and the real tool dispatch. The proven step comes only from the
 * runtime's signed pair; each flow document is a real file under a fresh
 * temporary folder, read from the root the (stubbed) install binding names.
 * Stubbed: the run store, the bridge auth, the run binding, the actor builder,
 * the template row and the registry read, the exact install binding (pinned in
 * extension-tool-install-binding.test.ts), the module import and the audit
 * write. The packages are fixtures.
 *
 * - the truth table: a step of the parent's own flow (P) or of the embedded
 *   child flow (C), crossed with a name the parent declares, the child
 *   declares, a sibling declares, nobody declares, or both declare;
 * - request positions: a package name in the body's `tool`, in `input`, in
 *   `input.name`, in `input.input`, or in an added envelope field never moves
 *   the code package;
 * - case P compatibility: a parent with no agent dependency (no flow read), an
 *   inline subflow, data payloads carrying `id`;
 * - refusal hygiene: a failing read is a fixed 403 and an unknown throw the
 *   fixed 500, neither carrying a path or an install id.
 *
 *   pnpm exec vitest run src/app/api/agents/passthrough/__tests__/passthrough-extension-tool-origin.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  query: vi.fn(),
  getAgentPackage: vi.fn(),
  loadDeclaredToolModule: vi.fn(),
  bindParentInstall: vi.fn(),
  bindChildInstall: vi.fn(),
  resolveOriginSpy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({ readAgentRunById: h.readAgentRunById }));
vi.mock("@/lib/primitive-handlers", () => ({ collectAllPrimitiveHandlers: async () => ({}) }));
vi.mock("@/lib/wayflow-bridge-auth", () => ({ isAuthorizedBridgeRequest: () => true }));
vi.mock("@/lib/authz/bridge-run-binding", () => ({
  bindBridgeRunId: async () => ({ ok: true, runId: "run-4154" }),
}));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-1",
    platformRole: "member",
  })),
}));
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/authz/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz/audit")>()),
  logAuditEvent: async () => {},
}));
vi.mock("@/lib/db/pooled", async () => ({
  ...(await vi.importActual<typeof import("@/lib/db/pooled")>("@/lib/db/pooled")),
  getPooledDb: () => ({ query: (...a: unknown[]) => h.query(...a) }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://unused",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: (...a: unknown[]) => h.getAgentPackage(...a),
}));
vi.mock("@cinatra-ai/agents/installed-oas-path", () => ({
  probeInstalledOasPathForRead: () => ({ path: null }),
}));
vi.mock("@/lib/verdaccio-config", () => ({ loadVerdaccioConfigForReads: async () => ({}) }));
vi.mock("@/lib/extension-tool-module-loader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extension-tool-module-loader")>()),
  loadDeclaredToolModule: (...a: unknown[]) => h.loadDeclaredToolModule(...a),
}));
vi.mock("@/lib/extension-tool-install-binding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extension-tool-install-binding")>()),
  bindParentInstall: (...a: unknown[]) => h.bindParentInstall(...a),
  bindChildInstall: (...a: unknown[]) => h.bindChildInstall(...a),
  childEdgeStillResolvesTo: async () => true,
}));
vi.mock("@/lib/extension-tool-origin", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/extension-tool-origin")>();
  return {
    ...real,
    resolveExtensionToolOrigin: (...a: Parameters<typeof real.resolveExtensionToolOrigin>) => {
      h.resolveOriginSpy(...a);
      return real.resolveExtensionToolOrigin(...a);
    },
  };
});

import { POST } from "@/app/api/agents/passthrough/route";

const KEY = "step-attest-key-under-test-4154-c2";
const CTX = "ctx-run-4154";
const PARENT = "@fixture-scope/fixture-parent-agent";
const CHILD = "@fixture-scope/fixture-child-agent";
/** A second agent dependency of the parent: it alone declares `sibling_tool`. */
const SIBLING = "@fixture-scope/fixture-sibling-agent";
const OWN_STEP = "own_step";
const CHILD_STEP = "child-embed_step";
const INLINE_STEP = "inline_step";
const CHILD_TOOL = "child_tool";
const FAKE_INSTALL_ID = "install-fake-7f3a9c21";
const RUN = {
  id: "run-4154",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tpl-4154",
  packageVersion: "2.0.0",
  versionId: null,
  dependentInstallId: "install-parent",
  oboCeiling: null,
};
const KEY_BEFORE = process.env.CINATRA_CONTEXT_ATTEST_KEY;
const UNDECLARED = "extension_tool: `name` must be one of the calling extension's own declared tools";
const origin = (code: string) => `extension_tool: the calling step reaches no tool of this origin (${code})`;

type Doc = Record<string, unknown>;

function childNodeBody(fixedName = CHILD_TOOL): Doc {
  return {
    component_type: "ApiNode",
    name: "Embedded step",
    url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
    http_method: "POST",
    data: { tool: "extension_tool", input: { name: fixedName, input: { ref: "{{ ref }}" } } },
    metadata: { cinatra: { packageName: CHILD } },
  };
}

function parentDoc(fixedName = CHILD_TOOL): Doc {
  return {
    component_type: "Flow",
    id: "parent-root",
    // A data payload carrying an `id` is no node: it causes no duplicate (8.4).
    inputs: [{ id: OWN_STEP }, { id: "payload-1" }],
    nodes: [{ $component_ref: OWN_STEP }, { $component_ref: "child_flow" }, { $component_ref: "inline_flow" }],
    $referenced_components: {
      [OWN_STEP]: { component_type: "ApiNode", id: OWN_STEP, data: { tool: "extension_tool", input: { name: "parent_tool" } } },
      child_flow: {
        component_type: "FlowNode",
        id: "child_flow",
        subflow: { $component_ref: "child-subflow" },
        metadata: { cinatra: { packageName: CHILD } },
      },
      "child-subflow": {
        component_type: "Flow",
        id: "child-subflow",
        nodes: [{ $component_ref: CHILD_STEP }],
        $referenced_components: { [CHILD_STEP]: { ...childNodeBody(fixedName), id: CHILD_STEP } },
      },
      // An unlabelled FlowNode with an inline Flow: the parent's own (8.4).
      inline_flow: {
        component_type: "FlowNode",
        id: "inline_flow",
        subflow: {
          component_type: "Flow",
          id: "inline-subflow",
          nodes: [{ $component_ref: INLINE_STEP }],
          $referenced_components: {
            [INLINE_STEP]: { component_type: "ApiNode", id: INLINE_STEP, data: { tool: "extension_tool" } },
          },
        },
      },
    },
  };
}

function childDoc(fixedName = CHILD_TOOL): Doc {
  return {
    component_type: "Flow",
    id: "child-root",
    nodes: [{ $component_ref: "embed_step" }],
    $referenced_components: { embed_step: { ...childNodeBody(fixedName), id: "embed_step" } },
  };
}

const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  module: `./cinatra/tools/${name}.mjs`,
  ...extra,
});
/** The parent declares `parent_tool` and `both_tool`; the child `child_tool` (embeddable) and `both_tool`. */
const PARENT_CINATRA = {
  kind: "agent",
  dependencies: [{ packageName: CHILD, kind: "agent" }, { packageName: SIBLING, kind: "agent" }],
  tools: [tool("parent_tool"), tool("both_tool")],
};
const CHILD_CINATRA: Record<string, unknown> = {
  kind: "agent",
  tools: [tool(CHILD_TOOL, { embeddable: true }), tool("both_tool", { embeddable: true })],
};

let ROOT = "";
let PARENT_ROOT = "";
let CHILD_ROOT = "";
/** A second pair whose embedded node names `both_tool`, a name the parent and the child both declare. */
let BOTH_PARENT_ROOT = "";
let BOTH_CHILD_ROOT = "";

function writeFlow(root: string, doc: Doc) {
  mkdirSync(path.join(root, "cinatra"), { recursive: true });
  writeFileSync(path.join(root, "cinatra", "oas.json"), JSON.stringify(doc));
}

beforeAll(() => {
  ROOT = mkdtempSync(path.join(tmpdir(), "c2-origin-route-"));
  PARENT_ROOT = path.join(ROOT, "parent");
  CHILD_ROOT = path.join(ROOT, "child");
  writeFlow(PARENT_ROOT, parentDoc());
  writeFlow(CHILD_ROOT, childDoc());
  BOTH_PARENT_ROOT = path.join(ROOT, "both-parent");
  BOTH_CHILD_ROOT = path.join(ROOT, "both-child");
  writeFlow(BOTH_PARENT_ROOT, parentDoc("both_tool"));
  writeFlow(BOTH_CHILD_ROOT, childDoc("both_tool"));
});

afterAll(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (KEY_BEFORE === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = KEY_BEFORE;
  vi.resetModules();
});

function boundParent(root = PARENT_ROOT) {
  return {
    ok: true,
    value: { row: { id: "install-parent", version: "2.0.0" }, root, digest: "digest-parent", cinatra: PARENT_CINATRA },
  };
}
function boundChild(root = CHILD_ROOT) {
  return {
    ok: true,
    value: {
      row: { id: "install-child", version: "0.1.1" },
      root,
      digest: "digest-child",
      cinatra: CHILD_CINATRA,
      edge: { packageName: CHILD, kind: "agent", resolvedInstallId: "install-child" },
    },
  };
}

function stepHeaders(node: string): Record<string, string> {
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const sig = createHmac("sha256", KEY).update(`s1\n${CTX}\n${node}\n${expiry}`).digest("hex");
  return { "x-cinatra-step-node": node, "x-cinatra-step-attestation": `s1:${expiry}:${sig}` };
}

function post(step: string | null, body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost:3000/api/agents/passthrough", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatra-a2a-context-id": CTX,
        ...(step ? stepHeaders(step) : {}),
      },
      body: JSON.stringify({ tool: "extension_tool", agent_run_id: RUN.id, ...body }),
    }),
  );
}

/** Which package's module the call loaded, and from which install (null: the run package's road). */
function loaded(): { packageName: string; installId: string | null } | null {
  const call = h.loadDeclaredToolModule.mock.calls[0];
  if (!call) return null;
  const arg = call[0] as { packageName: string; install?: { installId: string } };
  return { packageName: arg.packageName, installId: arg.install?.installId ?? null };
}

beforeEach(() => {
  process.env.CINATRA_CONTEXT_ATTEST_KEY = KEY;
  h.readAgentRunById.mockReset().mockResolvedValue(RUN);
  h.query.mockReset().mockResolvedValue({ rows: [{ package_name: PARENT, package_version: "2.0.0" }] });
  h.getAgentPackage.mockReset().mockResolvedValue({ manifest: { cinatra: PARENT_CINATRA } });
  h.loadDeclaredToolModule.mockReset().mockImplementation(async (i: { packageName: string }) => ({
    extensionTool: ({ input }: { input: unknown }) => ({ ranAs: i.packageName, input }),
  }));
  h.bindParentInstall.mockReset().mockImplementation(async () => boundParent());
  h.bindChildInstall.mockReset().mockImplementation(async () => boundChild());
  h.resolveOriginSpy.mockReset();
});

describe("the truth table through the route", () => {
  // The default flow's embedded node names `child_tool`; the two cases after
  // the table use a flow whose embedded node names `both_tool`.
  const rows: Array<[string, string, string, number, { packageName: string; installId: string | null } | null, string?]> = [
    ["P", OWN_STEP, "parent_tool", 200, { packageName: PARENT, installId: null }],
    ["P", OWN_STEP, CHILD_TOOL, 403, null, UNDECLARED],
    ["P", OWN_STEP, "sibling_tool", 403, null, UNDECLARED],
    ["P", OWN_STEP, "nobody_tool", 403, null, UNDECLARED],
    ["P", OWN_STEP, "both_tool", 200, { packageName: PARENT, installId: null }],
    ["C", CHILD_STEP, CHILD_TOOL, 200, { packageName: CHILD, installId: "install-child" }],
    ["C", CHILD_STEP, "parent_tool", 403, null, origin("name-not-bound")],
    ["C", CHILD_STEP, "sibling_tool", 403, null, origin("name-not-bound")],
    ["C", CHILD_STEP, "nobody_tool", 403, null, origin("name-not-bound")],
    ["C", CHILD_STEP, "both_tool", 403, null, origin("name-not-bound")],
  ];
  for (const [kind, step, name, status, code, error] of rows) {
    it(`${kind} step + ${name} answers ${status}${code ? ` from ${code.packageName === CHILD ? "the child" : "the parent"}` : ""}`, async () => {
      const res = await post(step, { input: { name, input: {} } });
      expect(res.status).toBe(status);
      expect(loaded()).toEqual(code);
      if (error) expect(await res.json()).toEqual({ error });
    });
  }

  it("C step with no proven pair is refused before the resolver", async () => {
    const res = await post(null, { input: { name: CHILD_TOOL, input: {} } });
    expect(res.status).toBe(403);
    expect(h.resolveOriginSpy).not.toHaveBeenCalled();
    expect(loaded()).toBeNull();
  });

  it("C step whose node the child marks not embeddable is refused", async () => {
    h.bindChildInstall.mockImplementation(async () => {
      const b = boundChild();
      b.value.cinatra = { kind: "agent", tools: [tool(CHILD_TOOL)] };
      return b;
    });
    const res = await post(CHILD_STEP, { input: { name: CHILD_TOOL, input: {} } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: origin("not-embeddable") });
    expect(loaded()).toBeNull();
  });

  it("C step whose fixed tool both packages declare runs the child's, from the child installation", async () => {
    h.bindParentInstall.mockImplementation(async () => boundParent(BOTH_PARENT_ROOT));
    h.bindChildInstall.mockImplementation(async () => boundChild(BOTH_CHILD_ROOT));
    const res = await post(CHILD_STEP, { input: { name: "both_tool", input: {} } });
    expect(res.status).toBe(200);
    expect(loaded()).toEqual({ packageName: CHILD, installId: "install-child" });
  });

  it("P step of the same flow with that name still runs the parent's", async () => {
    h.bindParentInstall.mockImplementation(async () => boundParent(BOTH_PARENT_ROOT));
    const res = await post(OWN_STEP, { input: { name: "both_tool", input: {} } });
    expect(res.status).toBe(200);
    expect(loaded()).toEqual({ packageName: PARENT, installId: null });
  });
});

describe("request positions never move the code package", () => {
  it("a package name as the body's tool never reaches the resolver", async () => {
    const res = await post(CHILD_STEP, { tool: CHILD, input: { name: CHILD_TOOL, input: {} } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(h.resolveOriginSpy).not.toHaveBeenCalled();
    expect(loaded()).toBeNull();
  });

  const positions: Array<[string, (pkg: string, name: string) => Record<string, unknown>]> = [
    ["in input", (pkg, name) => ({ input: { name, input: {}, packageName: pkg, package: pkg } })],
    ["in input.input", (pkg, name) => ({ input: { name, input: { packageName: pkg, package: pkg } } })],
    ["in an added envelope field", (pkg, name) => ({ packageName: pkg, package: pkg, input: { name, input: {} } })],
  ];
  for (const [label, body] of positions) {
    it(`the child's name ${label} leaves a P step on the parent`, async () => {
      const res = await post(OWN_STEP, body(CHILD, "parent_tool"));
      expect(res.status).toBe(200);
      expect(loaded()).toEqual({ packageName: PARENT, installId: null });
    });
    it(`the parent's name ${label} leaves a C step on the child`, async () => {
      const res = await post(CHILD_STEP, body(PARENT, CHILD_TOOL));
      expect(res.status).toBe(200);
      expect(loaded()).toEqual({ packageName: CHILD, installId: "install-child" });
    });
  }

  it("a package name as input.name is an undeclared name, on either road", async () => {
    for (const [step, error] of [[OWN_STEP, UNDECLARED], [CHILD_STEP, origin("name-not-bound")]] as const) {
      h.loadDeclaredToolModule.mockClear();
      const res = await post(step, { input: { name: CHILD, input: {} } });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error });
      expect(loaded()).toBeNull();
    }
  });
});

describe("case P compatibility through the route", () => {
  it("a parent with no agent dependency runs its tool and reads no flow", async () => {
    h.getAgentPackage.mockResolvedValue({ manifest: { cinatra: { kind: "agent", tools: [tool("parent_tool")] } } });
    const res = await post(OWN_STEP, { input: { name: "parent_tool", input: {} } });
    expect(res.status).toBe(200);
    expect(h.bindParentInstall).not.toHaveBeenCalled();
    expect(loaded()).toEqual({ packageName: PARENT, installId: null });
  });

  it("a step of an inline, unlabelled subflow runs the parent's tool", async () => {
    const res = await post(INLINE_STEP, { input: { name: "parent_tool", input: {} } });
    expect(res.status).toBe(200);
    expect(loaded()).toEqual({ packageName: PARENT, installId: null });
  });

  it("data payloads carrying an id in the flow do not refuse the parent's own step", async () => {
    const res = await post(OWN_STEP, { input: { name: "both_tool", input: {} } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ranAs: PARENT });
  });
});

describe("refusal hygiene through the route", () => {
  it("a failing flow read answers the fixed 403 without the path or the install id", async () => {
    const missing = path.join(ROOT, FAKE_INSTALL_ID, "nowhere");
    h.bindParentInstall.mockImplementation(async () => boundParent(missing));
    const res = await post(OWN_STEP, { input: { name: "parent_tool", input: {} } });
    expect(res.status).toBe(403);
    const text = JSON.stringify(await res.json());
    expect(text).toBe(JSON.stringify({ error: origin("origin-unreadable") }));
    expect(text).not.toContain(FAKE_INSTALL_ID);
    expect(text).not.toContain(ROOT);
  });

  it("an unknown throw answers the fixed 500 without its text", async () => {
    h.bindParentInstall.mockRejectedValue(new Error(`EACCES ${ROOT}/${FAKE_INSTALL_ID}`));
    const res = await post(OWN_STEP, { input: { name: "parent_tool", input: {} } });
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(FAKE_INSTALL_ID);
    expect(text).not.toContain(ROOT);
    expect(loaded()).toBeNull();
  });
});
