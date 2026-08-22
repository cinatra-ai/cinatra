// THE WIDGET TURN, THROUGH THE SAME THREE PRIMITIVES (cinatra#2577, epic #2564
// S8d), exercised at the same seam the S3 suite uses: the real registration, a
// real `mcpRequestContextStorage` frame, and the REAL producer bind on the way
// out — so what is asserted is what the AG-UI sink would actually mint.
//
// The slice's promise on this branch is one sentence with two halves, and the
// halves fail differently, so both are proven here:
//
//   · a widget reader WITH the `lifecycle.read` grant and access to the row
//     gets the same refs and the same minted card a first-party reader gets —
//     nothing about the widget path narrows the ANSWER;
//   · a widget reader WITHOUT the grant gets the ONE fixed refusal sentence and
//     NO DATA_PART. Not an error, not a reason, not a count. Reaching the tool
//     is not reading a row: the policy makes the primitive visible, and this
//     handler is where consent is decided.
//
// The frame is what discriminates. A `public_site_widget` delegation is resolved
// through S8a's actor module — which resolves the reader's live standing — and
// never through the transport role hints a chat frame carries, so this suite
// also pins that the widget branch does not silently fall back to those.
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-widget-lifecycle-pull";

const enforceReviewRunAccess = vi.fn();
const readReviewGateState = vi.fn();
const readReviewGate = vi.fn();
const readVerificationRecordForGate = vi.fn();
const listOpenReviewGateCandidates = vi.fn();
const resolveWidgetLifecycleActorForFrame = vi.fn();

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: (...args: unknown[]) => enforceReviewRunAccess(...args),
  readReviewGateState: (...args: unknown[]) => readReviewGateState(...args),
  readReviewGate: (...args: unknown[]) => readReviewGate(...args),
  // §VII's advisory comments ride the verification body (epic S9, slice S9e).
  // The reading is what this suite is about, so the comments are stubbed empty.
  readAdvisoryCommentsForGates: async () => [],
}));

vi.mock("@cinatra-ai/agents/lifecycle-verification-read-store", () => ({
  readVerificationRecordForGate: (...args: unknown[]) =>
    readVerificationRecordForGate(...args),
}));

vi.mock("@cinatra-ai/agents/lifecycle-policy-store", () => ({
  listOpenReviewGateCandidates: (...args: unknown[]) =>
    listOpenReviewGateCandidates(...args),
}));

// The S8a actor module is mocked at ITS boundary, not re-implemented: this suite
// is about what the PULL does with the frame, and the actor module has its own
// (live-standing, membership, floor) suite next door.
vi.mock("@/lib/lifecycle/widget-lifecycle-frame-actor", () => ({
  resolveWidgetLifecycleActorForFrame: (...args: unknown[]) =>
    resolveWidgetLifecycleActorForFrame(...args),
}));

import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server";

import {
  LIFECYCLE_REFUSAL_RESULT,
  recognizeLifecycleViewEnvelope,
} from "@/lib/assistant-runtime/lifecycle-view-envelope";
import { decodeLifecycleGateRef, encodeLifecycleGateRef } from "../lifecycle-card-refetch";
import { registerLifecyclePullPrimitives } from "../lifecycle-pull-mcp";

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
};
type Handler = (input: unknown) => Promise<ToolResult>;

const handlers = new Map<string, Handler>();
registerLifecyclePullPrimitives({
  registerTool: (name: string, _cfg: unknown, h: Handler) => {
    handlers.set(name, h);
  },
} as never);

const WIDGET_USER = "u-widget-reviewer";
const WIDGET_ORG = "org-widget";

/** A `public_site_widget` frame, with or without the signed grant. */
function widgetFrame(lifecycleRead: boolean): Partial<McpRequestContext> {
  return {
    // The transport stamps these for every frame; on the widget branch they must
    // NOT be what resolves the reader (that is the whole point of S8a), and the
    // suite proves it by never priming the actor module to agree with them.
    userId: WIDGET_USER,
    orgId: WIDGET_ORG,
    platformRole: "member",
    orgRole: "member",
    delegatedActor: {
      delegation: "public_site_widget",
      userId: WIDGET_USER,
      orgId: WIDGET_ORG,
      instanceId: "inst-canonical",
      kind: "wordpress",
      jti: "turn-nonce",
      platformRole: "member",
      lifecycleRead,
    },
  };
}

const ACTOR_CTX = {
  actor: { actorType: "human", source: "a2a", userId: WIDGET_USER, orgId: WIDGET_ORG },
  orgId: WIDGET_ORG,
  roleHints: {
    platformRole: "member",
    orgRole: "member",
    teamIds: ["team-7"],
    actorOrganizationId: WIDGET_ORG,
  },
};

async function call(
  tool: string,
  input: unknown,
  ctx: Partial<McpRequestContext>,
): Promise<ToolResult> {
  const h = handlers.get(tool);
  if (!h) throw new Error(`tool ${tool} not registered`);
  return mcpRequestContextStorage.run(ctx as McpRequestContext, () => h(input));
}

function text(res: ToolResult): string {
  return res.content[0].text;
}

/** Through the REAL producer bind, exactly as the AG-UI sink would. */
function mintedPart(res: ToolResult, toolName: string) {
  return recognizeLifecycleViewEnvelope({
    serverLabel: "cinatra",
    toolName,
    result: text(res),
  });
}

const REF = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" }) as string;

/** A readable verification record — the resolver projects §VII's body from it,
 *  and a row it cannot read resolves `absent`, so the fixture must be whole. */
const VERIFICATION_RECORD = {
  id: "vr-1",
  gateId: "gate-row-1",
  reviewedTarget: { artifactId: "art-1", representationRevisionId: "rev-base" },
  repairedTarget: { artifactId: "art-1", representationRevisionId: "rev-fixed" },
  scopeManifest: { paths: ["content.title"] },
  fieldDiff: [{ field: "content.title", before: "old", after: "new" }],
  outcome: "verified",
  createdAt: new Date(0),
};


beforeEach(() => {
  vi.clearAllMocks();
  resolveWidgetLifecycleActorForFrame.mockResolvedValue({ ok: true, actorCtx: ACTOR_CTX });
  enforceReviewRunAccess.mockResolvedValue({ ok: true });
  listOpenReviewGateCandidates.mockResolvedValue([
    { runId: "run-1", reviewTaskId: "task-1" },
  ]);
  readReviewGateState.mockResolvedValue({ status: "pending" });
  readReviewGate.mockResolvedValue({
    runId: "run-1",
    reviewTaskId: "task-1",
    status: "pending",
  });
  readVerificationRecordForGate.mockResolvedValue(VERIFICATION_RECORD);
});

describe("a CONSENTED widget reader with access", () => {
  it("lists the refs of the gates it may read", async () => {
    const res = await call("artifact_review_gates_list", {}, widgetFrame(true));
    const body = JSON.parse(text(res)) as { refs: string[] };
    expect(body.refs).toHaveLength(1);
    // The codec is nonced, so a ref is compared by what it ADDRESSES — and the
    // decode is also the assertion that the listing emitted a real, resolvable
    // ref rather than an opaque-looking string.
    expect(decodeLifecycleGateRef(body.refs[0])).toMatchObject({
      runId: "run-1",
      reviewTaskId: "task-1",
    });
    expect(text(res)).not.toContain(LIFECYCLE_REFUSAL_RESULT);
  });

  it("mints a review card DATA_PART through the real producer bind", async () => {
    const res = await call("artifact_review_gate_render", { ref: REF }, widgetFrame(true));
    const part = mintedPart(res, "artifact_review_gate_render");
    expect(part?.viewType).toBe("artifact_review_gate");
    expect(part?.ref).toBe(REF);
  });

  it("mints a verification card DATA_PART", async () => {
    const res = await call("verification_record_render", { ref: REF }, widgetFrame(true));
    const part = mintedPart(res, "verification_record_render");
    expect(part?.viewType).toBe("verification_summary");
  });

  it("resolves the reader through the S8a actor, from the FRAME's own identity", async () => {
    await call("artifact_review_gates_list", {}, widgetFrame(true));
    expect(resolveWidgetLifecycleActorForFrame).toHaveBeenCalledWith({
      userId: WIDGET_USER,
      orgId: WIDGET_ORG,
      kind: "wordpress",
    });
  });

  it("hands the RESOLVED actor to the per-row access check — the live standing, not the floor", async () => {
    await call("artifact_review_gates_list", {}, widgetFrame(true));
    // The teams axis is the tell: a frame-derived actor carries none, and a row
    // reachable only through a team grant would silently vanish under it.
    expect(enforceReviewRunAccess).toHaveBeenCalledWith(
      "run-1",
      ACTOR_CTX.actor,
      "read",
      ACTOR_CTX.roleHints,
    );
  });
});

describe("a NON-CONSENTED widget reader", () => {
  it("gets the ONE fixed refusal from the listing, and no refs", async () => {
    const res = await call("artifact_review_gates_list", {}, widgetFrame(false));
    expect(text(res)).toBe(LIFECYCLE_REFUSAL_RESULT);
  });

  it.each(["artifact_review_gate_render", "verification_record_render"])(
    "%s refuses and mints NO DATA_PART",
    async (tool) => {
      const res = await call(tool, { ref: REF }, widgetFrame(false));
      expect(text(res)).toBe(LIFECYCLE_REFUSAL_RESULT);
      expect(mintedPart(res, tool)).toBeNull();
    },
  );

  it("never even asks for an actor — consent is decided before identity", async () => {
    await call("artifact_review_gate_render", { ref: REF }, widgetFrame(false));
    expect(resolveWidgetLifecycleActorForFrame).not.toHaveBeenCalled();
  });

  it("reads NO lifecycle row — the refusal cannot be an existence probe", async () => {
    await call("artifact_review_gates_list", {}, widgetFrame(false));
    await call("artifact_review_gate_render", { ref: REF }, widgetFrame(false));
    expect(listOpenReviewGateCandidates).not.toHaveBeenCalled();
    expect(readReviewGate).not.toHaveBeenCalled();
    expect(enforceReviewRunAccess).not.toHaveBeenCalled();
  });

  it("is INDISTINGUISHABLE from a consented reader whose rows are all denied", async () => {
    // The property the surface rests on: the two answers are byte-equal, so the
    // refusal says nothing about which of the two happened.
    const noGrant = await call("artifact_review_gate_render", { ref: REF }, widgetFrame(false));
    enforceReviewRunAccess.mockResolvedValue({ ok: false });
    readReviewGate.mockResolvedValue(null);
    const denied = await call("artifact_review_gate_render", { ref: REF }, widgetFrame(true));
    expect(text(denied)).toBe(text(noGrant));
  });
});

describe("the grant claim is read STRICTLY", () => {
  it.each([undefined, false, "true", 1, null])(
    "a `lifecycleRead` of %p is NO grant",
    async (value) => {
      const frame = widgetFrame(true);
      (frame.delegatedActor as { lifecycleRead?: unknown }).lifecycleRead = value;
      const res = await call("artifact_review_gates_list", {}, frame);
      expect(text(res)).toBe(LIFECYCLE_REFUSAL_RESULT);
    },
  );
});

describe("a widget frame whose reader no longer stands", () => {
  it("refuses when the S8a actor resolution denies (membership revoked mid-turn)", async () => {
    resolveWidgetLifecycleActorForFrame.mockResolvedValue({
      ok: false,
      reason: "not_org_member",
    });
    const res = await call("artifact_review_gates_list", {}, widgetFrame(true));
    expect(text(res)).toBe(LIFECYCLE_REFUSAL_RESULT);
    expect(listOpenReviewGateCandidates).not.toHaveBeenCalled();
  });

  it("the denial REASON never reaches the wire", async () => {
    resolveWidgetLifecycleActorForFrame.mockResolvedValue({
      ok: false,
      reason: "not_org_member",
    });
    const res = await call("artifact_review_gate_render", { ref: REF }, widgetFrame(true));
    expect(text(res)).not.toContain("not_org_member");
    expect(JSON.stringify(res.structuredContent)).not.toContain("not_org_member");
  });
});

describe("the chat branch is untouched", () => {
  it("a frame with no delegated actor never consults the widget actor module", async () => {
    await call("artifact_review_gates_list", {}, {
      userId: "u-chat",
      orgId: "org-1",
      platformRole: "member",
      orgRole: "member",
    });
    expect(resolveWidgetLifecycleActorForFrame).not.toHaveBeenCalled();
    expect(listOpenReviewGateCandidates).toHaveBeenCalled();
  });
});
