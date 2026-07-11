// cinatra#1196 — multi-vendor OAS resolution at the context-route trust root.
//
// The front door (readInstalledOas via the shared runtime-mount resolver) must
// resolve an operator/third-party-vendor agent's installed OAS exactly like a
// first-party one: scope-derived `<mount>/<vendor>/<slug>/cinatra/oas.json`,
// never a first-party-only regex + literal "cinatra-ai" segment, and never a
// vendor enumeration that would let a same-slug package under one vendor
// shadow another (#538 class). Both trust-root call sites are covered:
//   1. loadTrustedSlot (the slot front door) — same-slug agents under
//      "acme-operator" and "cinatra-ai" each resolve their OWN installed OAS
//      (distinct slot sets prove which file was read);
//   2. deriveContextRouteContext's composed-child runOas read (the #907
//      attestation + #822 binding walk) — a fully NON-first-party parent/child
//      pair anchors and binds end-to-end on the run-token path.
// Fixtures are REAL files under a temp runtime mount root (readInstalledOas
// and the shared resolver run for real, as in the declaration-gate suite).
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

const MOUNT_ROOT = mkdtempSync(join(tmpdir(), "ctx-multivendor-"));

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

const { loadTrustedSlot, deriveContextRouteContext } = await import("../context-route-io");
const { ContextRouteError } = await import("../context-route-support");
const { computeContextAttestationV2 } = await import("../context-attestation");

// Same slug under an operator vendor and under first-party — DISTINCT slots.
const OPERATOR_LEAF_PKG = "@acme-operator/leaf-agent";
const FIRST_PARTY_LEAF_PKG = "@cinatra-ai/leaf-agent";
const OPERATOR_SLOT = "operatorIdeaContext";
const FIRST_PARTY_SLOT = "firstPartyIdeaContext";

// Composed run package (operator scope) for the runOas call site.
const OPERATOR_PKG = "@acme-operator/parent-agent";

// Composed non-first-party pair for the runOas call site.
const CHILD_PKG = "@acme-operator/child-agent";
const COMPOSED_SLOT = "composedIdeaContext";
const NODE = `ctx-${COMPOSED_SLOT}-resolve_context`;
const CTX_ID = "ctx-run-1";
const KEY = "attest-key-under-test";

function slot(slotId: string) {
  return {
    slotId,
    acceptedArtifactExtensions: ["@cinatra-ai/brand-voice-artifact"],
    selectionMode: "interactive",
    resolutionMode: "accumulate",
  };
}

/** Leaf OAS declaring one root-level context slot. */
function leafOasFile(packageName: string, slotId: string): string {
  return JSON.stringify({
    component_type: "Flow",
    id: "leaf-root",
    metadata: { cinatra: { packageName, contextSlots: [slot(slotId)] } },
  });
}

/** Slim composed parent (mirrors the declaration-gate fixture, non-first-party
 *  scope): the inlined child def DECLARES the slot; the referencing FlowNode
 *  names the child package. */
function slimParentOasFile(): string {
  return JSON.stringify({
    component_type: "Flow",
    id: "parent-root",
    start_node: { $component_ref: "start" },
    nodes: [{ $component_ref: "child_flow" }],
    metadata: { cinatra: { packageName: OPERATOR_PKG } },
    $referenced_components: {
      start: { component_type: "StartNode", id: "start" },
      "child-agent-subflow": {
        component_type: "Flow",
        id: "child-agent-subflow",
        start_node: { $component_ref: "child__start" },
        nodes: [],
        metadata: { cinatra: { contextSlots: [slot(COMPOSED_SLOT)] } },
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

function writeOas(vendor: string, slugDir: string, contents: string): void {
  const dir = join(MOUNT_ROOT, vendor, slugDir, "cinatra");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "oas.json"), contents);
}

beforeAll(() => {
  // Front-door pair: the SAME "leaf-agent" slug installed under the operator
  // vendor and under first-party, each declaring a DIFFERENT slot.
  writeOas("acme-operator", "leaf-agent", leafOasFile(OPERATOR_LEAF_PKG, OPERATOR_SLOT));
  writeOas("cinatra-ai", "leaf-agent", leafOasFile(FIRST_PARTY_LEAF_PKG, FIRST_PARTY_SLOT));
  // Composed operator parent (slim declaration format) for the runOas walk.
  writeOas("acme-operator", "parent-agent", slimParentOasFile());
  vi.stubEnv("CINATRA_CONTEXT_ATTEST_KEY", KEY);
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(MOUNT_ROOT, { recursive: true, force: true });
});

async function expectRouteError(p: Promise<unknown>, status: number, code: string) {
  await p.then(
    () => {
      throw new Error("expected ContextRouteError, got success");
    },
    (e: unknown) => {
      expect(e).toBeInstanceOf(ContextRouteError);
      const err = e as InstanceType<typeof ContextRouteError>;
      expect(err.status).toBe(status);
      expect(err.code).toBe(code);
    },
  );
}

describe("loadTrustedSlot — multi-vendor front door (cinatra#1196)", () => {
  it("resolves an operator-vendor agent's installed OAS (no oas_missing on vendor scope alone)", async () => {
    const s = await loadTrustedSlot(OPERATOR_LEAF_PKG, OPERATOR_SLOT);
    expect(s.slotId).toBe(OPERATOR_SLOT);
  });

  it("resolves the first-party same-slug agent's OWN OAS (no regression)", async () => {
    const s = await loadTrustedSlot(FIRST_PARTY_LEAF_PKG, FIRST_PARTY_SLOT);
    expect(s.slotId).toBe(FIRST_PARTY_SLOT);
  });

  it("same slug, crossed vendors: each package sees ONLY its own slots (no shadowing either way)", async () => {
    // The operator copy does NOT declare the first-party slot and vice versa —
    // slot_missing (not a resolve of the other vendor's file) proves which
    // installed OAS was read.
    await expectRouteError(
      loadTrustedSlot(OPERATOR_LEAF_PKG, FIRST_PARTY_SLOT),
      404,
      "slot_missing",
    );
    await expectRouteError(
      loadTrustedSlot(FIRST_PARTY_LEAF_PKG, OPERATOR_SLOT),
      404,
      "slot_missing",
    );
  });

  it("an uninstalled vendor still fails closed with oas_missing", async () => {
    await expectRouteError(
      loadTrustedSlot("@ghost-vendor/leaf-agent", OPERATOR_SLOT),
      404,
      "oas_missing",
    );
  });

  it("a malformed package name still fails closed with oas_missing", async () => {
    await expectRouteError(
      loadTrustedSlot("@acme-operator/leaf-agent/../escape", OPERATOR_SLOT),
      404,
      "oas_missing",
    );
  });
});

// --- Composed-child runOas call site under a NON-first-party run package ----

const RUN = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tmpl-1",
  projectId: null,
  oboCeiling: null,
};

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

beforeEach(() => {
  vi.clearAllMocks();
  readAgentTemplateById.mockResolvedValue({
    packageName: OPERATOR_PKG,
    ownerLevel: null,
    ownerId: null,
  });
  resolveAgentRunMcpActor.mockResolvedValue({ platformRole: "member" });
  readAgentRunByContextId.mockResolvedValue(RUN);
  readAgentRunById.mockResolvedValue(RUN);
});

describe("deriveContextRouteContext — non-first-party composed child (cinatra#1196)", () => {
  it("token-served composed call reads the operator parent's runOas, anchors, and binds the operator child package", async () => {
    readAgentRunByTokenHash.mockResolvedValue({
      id: "run-1",
      orgId: "org-1",
      runBy: "user-1",
    });
    const res = await deriveContextRouteContext(
      req(attestedHeaders({ "x-cinatra-run-token": "raw-token" })),
      { parentRunId: "run-1", parentPackageName: CHILD_PKG, slotId: COMPOSED_SLOT },
      "resolve",
    );
    expect(res.trustedPackageName).toBe(OPERATOR_PKG);
    expect(res.trustedSlotPackageName).toBe(CHILD_PKG);
    expect(res.servedBy).toBe("run_token");
  });

  it("an operator run package whose OAS is NOT installed fails the composed path closed (attestation cannot anchor)", async () => {
    readAgentRunByTokenHash.mockResolvedValue({
      id: "run-1",
      orgId: "org-1",
      runBy: "user-1",
    });
    readAgentTemplateById.mockResolvedValue({
      packageName: "@ghost-vendor/parent-agent",
      ownerLevel: null,
      ownerId: null,
    });
    await expectRouteError(
      deriveContextRouteContext(
        req(attestedHeaders({ "x-cinatra-run-token": "raw-token" })),
        { parentRunId: "run-1", parentPackageName: CHILD_PKG, slotId: COMPOSED_SLOT },
        "resolve",
      ),
      403,
      "attestation_node_unrecognized",
    );
  });
});
