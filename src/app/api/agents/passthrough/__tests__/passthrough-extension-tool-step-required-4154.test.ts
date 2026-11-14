/**
 * cinatra#4154 (PR A) — an `extension_tool` call must come from a PROVEN step.
 *
 * The runtime signs the executing step's own id over the run's context id
 * (cinatra#3745); the route verifies the pair with the context id the run
 * binding proved. The extension tool road now refuses a call whose pair does
 * not verify, before any dispatch, with one fixed sentence and a 403: which
 * package's tool a call reaches is decided from that step, so an unproven call
 * reaches no tool. A proven call hands the verified step and the run's own
 * install fields to the dispatch. `extension_data` and the artifact reads keep
 * their current behaviour.
 *
 * Drives the real route; the run store, the bridge auth, the run binding, the
 * actor builder and the scoped dispatch are test doubles.
 *
 *   npx vitest run src/app/api/agents/passthrough/__tests__/passthrough-extension-tool-step-required-4154.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  dispatchExtensionScopedTool: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: h.readAgentRunById,
  publishCallAllowed: async () => true, // cinatra#4150: no publish decision holds this run
}));
vi.mock("@/lib/primitive-handlers", () => ({ collectAllPrimitiveHandlers: async () => ({}) }));
vi.mock("@/lib/wayflow-bridge-auth", () => ({ isAuthorizedBridgeRequest: () => true }));
vi.mock("@/lib/authz/bridge-run-binding", () => ({ bindBridgeRunId: async () => ({ ok: true }) }));
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
vi.mock("@/lib/extension-scoped-tools", () => ({
  EXTENSION_SCOPED_TOOLS: new Set<string>([
    "extension_data",
    "extension_tool",
    "artifacts_list",
    "artifacts_get",
    "artifact_content_read",
  ]),
  dispatchExtensionScopedTool: h.dispatchExtensionScopedTool,
}));

import { POST } from "@/app/api/agents/passthrough/route";
import { EXTENSION_TOOL_STEP_UNPROVEN } from "@/lib/extension-scoped-tools-refusals";

const KEY = "step-attest-key-under-test-4154";
const CTX = "ctx-run-4154";
const NODE = "sender-file_recipients";
const RUN = {
  id: "run-4154",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tpl-4154",
  packageVersion: "1.0.0",
  versionId: "ver-4154",
  dependentInstallId: "install-parent-4154",
  oboCeiling: null,
};
const KEY_BEFORE = process.env.CINATRA_CONTEXT_ATTEST_KEY;

function sign(opts: { ctx?: string; node?: string; key?: string; expiry?: number } = {}) {
  const ctx = opts.ctx ?? CTX;
  const node = opts.node ?? NODE;
  const key = opts.key ?? KEY;
  const expiry = opts.expiry ?? Math.floor(Date.now() / 1000) + 300;
  const sig = createHmac("sha256", key).update(`s1\n${ctx}\n${node}\n${expiry}`).digest("hex");
  return { node, attestation: `s1:${expiry}:${sig}` };
}

function stepHeaders(opts: Parameters<typeof sign>[0] = {}): Record<string, string> {
  const s = sign(opts);
  return { "x-cinatra-step-node": s.node, "x-cinatra-step-attestation": s.attestation };
}

function req(tool: string, headers: Record<string, string>, input: Record<string, unknown> = {}) {
  return new Request("http://localhost:3000/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cinatra-a2a-context-id": CTX, ...headers },
    body: JSON.stringify({ tool, input, agent_run_id: RUN.id }),
  });
}

const TOOL_INPUT = { name: "recipient_records", input: { campaignId: "c-1" } };

beforeEach(() => {
  h.readAgentRunById.mockReset().mockResolvedValue(RUN);
  h.dispatchExtensionScopedTool.mockReset().mockResolvedValue({ ok: true, result: { ok: true } });
  process.env.CINATRA_CONTEXT_ATTEST_KEY = KEY;
});

afterEach(() => {
  if (KEY_BEFORE === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = KEY_BEFORE;
});

afterAll(() => {
  for (const m of [
    "server-only",
    "@cinatra-ai/agents",
    "@/lib/primitive-handlers",
    "@/lib/wayflow-bridge-auth",
    "@/lib/authz/bridge-run-binding",
    "@/lib/authz/build-actor-context-from-run",
    "@cinatra-ai/llm/actor-context",
    "@/lib/extension-scoped-tools",
  ]) {
    vi.doUnmock(m);
  }
  vi.resetModules();
});

describe("cinatra#4154 — extension_tool needs a proven step", () => {
  it("a proven call reaches the dispatch with the verified step and the run's install fields", async () => {
    const res = await POST(req("extension_tool", stepHeaders(), TOOL_INPUT));
    expect(res.status).toBe(200);
    expect(h.dispatchExtensionScopedTool).toHaveBeenCalledTimes(1);
    const arg = h.dispatchExtensionScopedTool.mock.calls[0]![0] as {
      tool: string;
      run: Record<string, unknown>;
    };
    expect(arg.tool).toBe("extension_tool");
    expect(arg.run).toEqual({
      id: RUN.id,
      orgId: RUN.orgId,
      runBy: RUN.runBy,
      templateId: RUN.templateId,
      packageVersion: RUN.packageVersion,
      versionId: RUN.versionId,
      dependentInstallId: RUN.dependentInstallId,
      verifiedStepId: NODE,
    });
  });

  it("a run row without install fields hands null, never undefined", async () => {
    h.readAgentRunById.mockResolvedValue({ ...RUN, versionId: undefined, dependentInstallId: undefined });
    const res = await POST(req("extension_tool", stepHeaders(), TOOL_INPUT));
    expect(res.status).toBe(200);
    const arg = h.dispatchExtensionScopedTool.mock.calls[0]![0] as { run: Record<string, unknown> };
    expect(arg.run.versionId).toBeNull();
    expect(arg.run.dependentInstallId).toBeNull();
  });

  // Only a blank key counts as no key: a key with outer spaces is used as it
  // is, never trimmed, so a pair signed with the raw spaced value verifies and
  // a pair signed with the trimmed value does not.
  it("a key with outer spaces is kept raw: a pair signed with the raw spaced key verifies", async () => {
    const spaced = `  ${KEY}  `;
    process.env.CINATRA_CONTEXT_ATTEST_KEY = spaced;
    const res = await POST(req("extension_tool", stepHeaders({ key: spaced }), TOOL_INPUT));
    expect(res.status).toBe(200);
    const arg = h.dispatchExtensionScopedTool.mock.calls[0]![0] as { run: Record<string, unknown> };
    expect(arg.run.verifiedStepId).toBe(NODE);
  });

  it("a key with outer spaces is kept raw: a pair signed with the trimmed key is refused", async () => {
    process.env.CINATRA_CONTEXT_ATTEST_KEY = `  ${KEY}  `;
    const res = await POST(req("extension_tool", stepHeaders({ key: KEY }), TOOL_INPUT));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: EXTENSION_TOOL_STEP_UNPROVEN });
    expect(h.dispatchExtensionScopedTool).not.toHaveBeenCalled();
  });

  const now = Math.floor(Date.now() / 1000);
  const valid = sign();
  const unproven: Array<[string, Record<string, string>, (() => void)?]> = [
    ["both step headers absent", {}],
    ["only the node header", { "x-cinatra-step-node": NODE }],
    ["only the attestation header", { "x-cinatra-step-attestation": valid.attestation }],
    ["an attestation of another version", { "x-cinatra-step-node": NODE, "x-cinatra-step-attestation": valid.attestation.replace(/^s1:/, "s2:") }],
    ["a non-numeric expiry", { "x-cinatra-step-node": NODE, "x-cinatra-step-attestation": "s1:soon:abcd" }],
    ["a non-hex signature", { "x-cinatra-step-node": NODE, "x-cinatra-step-attestation": `s1:${now + 300}:not-hex` }],
    ["a signature under another key", stepHeaders({ key: "another-key-under-test" })],
    ["a signature over another context id", stepHeaders({ ctx: "ctx-other-run" })],
    ["a node header that differs from the signed node", { ...stepHeaders(), "x-cinatra-step-node": "forged-write" }],
    ["an expired signature", stepHeaders({ expiry: now - 120 })],
    ["an expiry too far ahead", stepHeaders({ expiry: now + 3600 })],
    [
      "no attest key on the host",
      stepHeaders(),
      () => {
        delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
      },
    ],
    [
      "a whitespace-only attest key on the host",
      stepHeaders({ key: "   " }),
      () => {
        process.env.CINATRA_CONTEXT_ATTEST_KEY = "   ";
      },
    ],
  ];

  for (const [label, headers, arrange] of unproven) {
    it(`refuses ${label} with a fixed 403 and no dispatch`, async () => {
      arrange?.();
      const res = await POST(req("extension_tool", headers, TOOL_INPUT));
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ error: EXTENSION_TOOL_STEP_UNPROVEN });
      expect(h.dispatchExtensionScopedTool).not.toHaveBeenCalled();
    });
  }

  it("a package name in any request position does not open an unproven call", async () => {
    const res = await POST(
      req("extension_tool", {}, {
        name: "recipient_records",
        packageName: "@cinatra-ai/email-delivery-agent",
        input: { package: "@cinatra-ai/email-delivery-agent" },
      }),
    );
    expect(res.status).toBe(403);
    expect(h.dispatchExtensionScopedTool).not.toHaveBeenCalled();
  });

  for (const tool of ["extension_data", "artifacts_list", "artifacts_get", "artifact_content_read"]) {
    it(`${tool} without a step pair is served as before`, async () => {
      const res = await POST(req(tool, {}, { table: "fixture_rows", operation: "select" }));
      expect(res.status).toBe(200);
      expect(h.dispatchExtensionScopedTool).toHaveBeenCalledTimes(1);
      const arg = h.dispatchExtensionScopedTool.mock.calls[0]![0] as { run: Record<string, unknown> };
      expect(arg.run.verifiedStepId).toBeNull();
    });
  }
});
