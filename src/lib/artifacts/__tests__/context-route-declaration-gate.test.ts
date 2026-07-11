// cinatra#1194 — route-level proof that the declaration re-anchor is gated on
// the RUN-TOKEN path (servedBy === "run_token"), not merely available as a
// pure-walker option: the SAME slim installed OAS + valid attestation
// succeeds when the run is token-resolved and fails closed (403,
// attestation_node_unrecognized) when the run was resolved via the legacy
// context-id header. The parent OAS is a REAL file under a temp runtime
// mount root (readInstalledOas runs for real).
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

const MOUNT_ROOT = mkdtempSync(join(tmpdir(), "ctx-decl-gate-"));

const readAgentRunByTokenHash = vi.fn();
const readAgentRunById = vi.fn();
const readAgentRunByContextId = vi.fn();
const readAgentTemplateById = vi.fn();

vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunByTokenHash: (...a: unknown[]) => readAgentRunByTokenHash(...a),
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentRunByContextId: (...a: unknown[]) => readAgentRunByContextId(...a),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
}));
vi.mock("@cinatra-ai/agents/agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => MOUNT_ROOT,
}));
vi.mock("@/lib/wayflow-bridge-auth", () => ({
  isAuthorizedBridgeRequest: () => true,
}));
vi.mock("@/lib/a2a-auth", () => ({
  verifyLangGraphBridgeToken: () => ({ ok: true }),
}));
const resolveAgentRunMcpActor = vi.fn();
vi.mock("@/lib/agent-run-actor-resolve", () => ({
  resolveAgentRunMcpActor: (...a: unknown[]) => resolveAgentRunMcpActor(...a),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: async () => [],
  readProjectGrantsForUser: async () => [],
}));
vi.mock("@cinatra-ai/mcp-server/obo-ceiling", () => ({
  deriveOboCeilingChain: () => null,
  oboCeilingContains: () => false,
}));
vi.mock("@/lib/authz/build-actor-context", () => ({
  buildActorContextFromPrimitive: () => ({ sub: "user-1", organizationId: "org-1" }),
}));
vi.mock("../context-mcp", () => ({ getInstalledExtensionDescriptors: () => [] }));
vi.mock("../context-resolver", () => ({ resolveContextSlot: () => [] }));

const { deriveContextRouteContext } = await import("../context-route-io");
const { ContextRouteError } = await import("../context-route-support");
const { computeContextAttestationV2 } = await import("../context-attestation");

const PARENT_PKG = "@cinatra-ai/parent-agent";
const CHILD_PKG = "@cinatra-ai/child-agent";
const SLOT = "ideaContext";
const NODE = `ctx-${SLOT}-resolve_context`;
const CTX_ID = "ctx-run-1";
const KEY = "attest-key-under-test";

/** Slim composed parent: the inlined child def DECLARES the slot (no subflow
 *  bytes anywhere); the referencing FlowNode names the child package. */
function slimParentOasFile(): string {
  return JSON.stringify({
    component_type: "Flow",
    id: "parent-root",
    start_node: { $component_ref: "start" },
    nodes: [{ $component_ref: "child_flow" }],
    metadata: { cinatra: { packageName: PARENT_PKG } },
    $referenced_components: {
      start: { component_type: "StartNode", id: "start" },
      "child-agent-subflow": {
        component_type: "Flow",
        id: "child-agent-subflow",
        start_node: { $component_ref: "child__start" },
        nodes: [],
        metadata: {
          cinatra: {
            contextSlots: [
              {
                slotId: SLOT,
                acceptedArtifactExtensions: ["@cinatra-ai/brand-voice-artifact"],
                selectionMode: "interactive",
                resolutionMode: "accumulate",
              },
            ],
          },
        },
        $referenced_components: {
          child__start: { component_type: "StartNode", id: "child__start" },
        },
      },
      child_flow: {
        component_type: "FlowNode",
        id: "child_flow",
        subflow: { $component_ref: "child-agent-subflow" },
        metadata: { cinatra: { packageName: CHILD_PKG } },
      },
    },
  });
}

beforeAll(() => {
  const dir = join(MOUNT_ROOT, "cinatra-ai", "parent-agent", "cinatra");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "oas.json"), slimParentOasFile());
  vi.stubEnv("CINATRA_CONTEXT_ATTEST_KEY", KEY);
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(MOUNT_ROOT, { recursive: true, force: true });
});

function attestedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const exp = Math.floor(Date.now() / 1000) + 60;
  return {
    "x-cinatra-a2a-context-id": CTX_ID,
    "x-cinatra-context-node": NODE,
    "x-cinatra-context-attestation": `v2:${exp}:${computeContextAttestationV2(
      KEY,
      CTX_ID,
      NODE,
      exp,
    )}`,
    ...extra,
  };
}

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/context-resolve", {
    method: "POST",
    headers,
  });
}

function composedBody() {
  return { parentRunId: "run-1", parentPackageName: CHILD_PKG, slotId: SLOT };
}

const RUN = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tmpl-1",
  projectId: null,
  oboCeiling: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  readAgentTemplateById.mockResolvedValue({
    packageName: PARENT_PKG,
    ownerLevel: null,
    ownerId: null,
  });
  resolveAgentRunMcpActor.mockResolvedValue({ platformRole: "member" });
  readAgentRunByContextId.mockResolvedValue(RUN);
  readAgentRunById.mockResolvedValue(RUN);
});

describe("declaration re-anchor is gated on the run-token path (route level)", () => {
  it("token-served composed call anchors via declaration and binds the child package", async () => {
    readAgentRunByTokenHash.mockResolvedValue({
      id: "run-1",
      orgId: "org-1",
      runBy: "user-1",
    });
    const res = await deriveContextRouteContext(
      req(attestedHeaders({ "x-cinatra-run-token": "raw-token" })),
      composedBody(),
      "resolve",
    );
    expect(res.trustedPackageName).toBe(PARENT_PKG);
    expect(res.trustedSlotPackageName).toBe(CHILD_PKG);
  });

  it("the SAME call served via the legacy context-id header fails closed", async () => {
    await deriveContextRouteContext(
      req(attestedHeaders()), // no run token ⇒ servedBy = context_id
      composedBody(),
      "resolve",
    ).then(
      () => {
        throw new Error("expected ContextRouteError, got success");
      },
      (e: unknown) => {
        expect(e).toBeInstanceOf(ContextRouteError);
        const err = e as InstanceType<typeof ContextRouteError>;
        expect(err.status).toBe(403);
        expect(err.code).toBe("attestation_node_unrecognized");
      },
    );
  });

  it("a forged attestation on the token path still fails closed", async () => {
    readAgentRunByTokenHash.mockResolvedValue({
      id: "run-1",
      orgId: "org-1",
      runBy: "user-1",
    });
    await deriveContextRouteContext(
      req(
        attestedHeaders({
          "x-cinatra-run-token": "raw-token",
          "x-cinatra-context-attestation": `v2:9999999999:${"0".repeat(64)}`,
        }),
      ),
      composedBody(),
      "resolve",
    ).then(
      () => {
        throw new Error("expected ContextRouteError, got success");
      },
      (e: unknown) => {
        expect((e as InstanceType<typeof ContextRouteError>).code).toBe(
          "attestation_invalid",
        );
      },
    );
  });

  it("token path + a slot the declaration does NOT bind to the claimed package ⇒ 403 package_mismatch", async () => {
    readAgentRunByTokenHash.mockResolvedValue({
      id: "run-1",
      orgId: "org-1",
      runBy: "user-1",
    });
    await deriveContextRouteContext(
      req(attestedHeaders({ "x-cinatra-run-token": "raw-token" })),
      { ...composedBody(), parentPackageName: "@cinatra-ai/other-agent" },
      "resolve",
    ).then(
      () => {
        throw new Error("expected ContextRouteError, got success");
      },
      (e: unknown) => {
        expect((e as InstanceType<typeof ContextRouteError>).code).toBe(
          "package_mismatch",
        );
      },
    );
  });
});
