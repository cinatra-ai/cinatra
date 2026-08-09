// The conversational PULL primitives (cinatra#2567, epic #2564 S3), exercised
// THROUGH the real registration + handler dispatch: the module registers into a
// capture server exactly as `src/lib/mcp-server.ts` does, and each handler runs
// inside a real `mcpRequestContextStorage` frame — so the caller is resolved
// from CONTEXT, never from tool input.
//
// The assertions are about the three properties the slice actually promises,
// each proven at the SEAM rather than by reading the implementation:
//
//   · a card mints only through S1's REAL producer bind — the tool result is
//     fed to `recognizeLifecycleViewEnvelope` with the (serverLabel, toolName)
//     tuple the sink would see, and the per-viewType binding is proven by the
//     CROSS pair (a review result under the verification tool name mints
//     nothing);
//   · access follows the S1 ladder — run READ is decided BEFORE anything reads
//     the gate, so a reader without run access never learns the gate exists;
//   · every ROW-dependent denial is the ONE fixed sentence, carrying no id,
//     count or reason, and mints no card — and the DECLARED input schemas let
//     those denials reach the handler at all, rather than being pre-empted by
//     the SDK's own validation error.
import { beforeEach, describe, expect, it, vi } from "vitest";

// The ref codec is keyed off the app secret (as the chat / agent-run MCP actor
// tokens are), so the suite pins one.
process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-pull";

const enforceReviewRunAccess = vi.fn();
const readReviewGateState = vi.fn();
const readReviewGate = vi.fn();
const readVerificationRecordForGate = vi.fn();
const listOpenReviewGateCandidates = vi.fn();

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: (...args: unknown[]) => enforceReviewRunAccess(...args),
  readReviewGateState: (...args: unknown[]) => readReviewGateState(...args),
  readReviewGate: (...args: unknown[]) => readReviewGate(...args),
}));

vi.mock("@cinatra-ai/agents/lifecycle-verification-read-store", () => ({
  readVerificationRecordForGate: (...args: unknown[]) =>
    readVerificationRecordForGate(...args),
}));

vi.mock("@cinatra-ai/agents/lifecycle-policy-store", () => ({
  listOpenReviewGateCandidates: (...args: unknown[]) =>
    listOpenReviewGateCandidates(...args),
}));

import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server";

import {
  LIFECYCLE_PRODUCER_TOOLS,
  LIFECYCLE_REFUSAL_RESULT,
  recognizeLifecycleViewEnvelope,
} from "@/lib/assistant-runtime/lifecycle-view-envelope";
import { decodeLifecycleGateRef } from "../lifecycle-card-refetch";
import { registerLifecyclePullPrimitives } from "../lifecycle-pull-mcp";

// ── capture server (mirrors the registration in src/lib/mcp-server.ts) ───────
type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
};
type Handler = (input: unknown) => Promise<ToolResult>;

type ToolConfig = {
  description: string;
  inputSchema: { safeParse: (value: unknown) => { success: boolean } };
};

const handlers = new Map<string, Handler>();
const configs = new Map<string, ToolConfig>();
registerLifecyclePullPrimitives({
  registerTool: (name: string, cfg: ToolConfig, h: Handler) => {
    handlers.set(name, h);
    configs.set(name, cfg);
  },
} as never);

const CALLER: Partial<McpRequestContext> = {
  userId: "u-reviewer",
  orgId: "org-1",
  platformRole: "member",
  orgRole: "member",
};

async function call(
  tool: string,
  input: unknown,
  ctx: Partial<McpRequestContext> = CALLER,
): Promise<ToolResult> {
  const h = handlers.get(tool);
  if (!h) throw new Error(`tool ${tool} not registered`);
  return mcpRequestContextStorage.run(ctx as McpRequestContext, () => h(input));
}

/** The tool-result TEXT — exactly what the provider hands back and the sink sees. */
function text(res: ToolResult): string {
  return res.content[0].text;
}

/** Run the result through the REAL producer bind, as the AG-UI sink would. */
function throughProducerBind(res: ToolResult, toolName: string, serverLabel = "cinatra") {
  return recognizeLifecycleViewEnvelope({
    serverLabel,
    toolName,
    result: text(res),
  });
}

/** Grant a specific set of run-access ops; every other op denies. */
function accessFor(granted: string[]) {
  enforceReviewRunAccess.mockImplementation(async (_runId, _actor, op) => ({
    ok: granted.includes(op as string),
  }));
}

/** A candidate row — the narrow listing returns the ref pair and nothing else. */
function gateRow(runId: string, reviewTaskId: string) {
  return { runId, reviewTaskId };
}

/** List once and hand back the refs the caller was given. */
async function listRefs(input: unknown = {}): Promise<string[]> {
  const res = await call("artifact_review_gates_list", input);
  return (res.structuredContent as { refs?: string[] }).refs ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  listOpenReviewGateCandidates.mockResolvedValue([gateRow("run-1", "task-1")]);
  readReviewGateState.mockResolvedValue({ status: "pending", pinnedTargets: [] });
  readReviewGate.mockResolvedValue({ id: "gate-run-1" });
  readVerificationRecordForGate.mockResolvedValue({ id: "vr-1" });
  accessFor(["read", "approveHitl", "respondToHitl"]);
});

// ---------------------------------------------------------------------------
// The surface itself
// ---------------------------------------------------------------------------

describe("the pull surface", () => {
  it("registers EXACTLY the three read-only primitives", () => {
    expect([...handlers.keys()].sort()).toEqual([
      "artifact_review_gate_render",
      "artifact_review_gates_list",
      "verification_record_render",
    ]);
  });

  it("declares schemas that let every ROW-dependent denial reach the handler", () => {
    // The MCP SDK validates the DECLARED schema before the callback runs, so a
    // schema that rejected a well-formed-but-unusable ref would answer with a
    // protocol error instead of the fixed refusal — and "every row-dependent
    // denial looks identical" would hold only inside this file. Anything that is
    // a plausible ref must therefore be the HANDLER's to refuse.
    for (const tool of ["artifact_review_gate_render", "verification_record_render"]) {
      const schema = configs.get(tool)!.inputSchema;
      for (const ref of ["not-one-of-ours", "a", "Zm9v", "x".repeat(512)]) {
        expect(schema.safeParse({ ref }).success, `${tool} <- ${ref.slice(0, 12)}`).toBe(
          true,
        );
      }
    }
    // The list takes no required input at all, so "show my reviews" can never
    // fail on arguments.
    expect(configs.get("artifact_review_gates_list")!.inputSchema.safeParse({}).success).toBe(
      true,
    );
  });

  it("registers the names S1's producer allowlist already pins VERBATIM", () => {
    // A rename here without moving `LIFECYCLE_PRODUCER_TOOLS` in the same commit
    // stops cards minting SILENTLY (the recognizer just returns null), so the
    // relationship is pinned rather than trusted.
    expect(LIFECYCLE_PRODUCER_TOOLS.artifact_review_gate).toEqual([
      "artifact_review_gates_list",
      "artifact_review_gate_render",
    ]);
    expect(LIFECYCLE_PRODUCER_TOOLS.verification_summary).toEqual([
      "verification_record_render",
    ]);
    for (const producers of Object.values(LIFECYCLE_PRODUCER_TOOLS)) {
      for (const name of producers) expect(handlers.has(name)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The producer bind — a card mints only through the real S1 tuple
// ---------------------------------------------------------------------------

describe("minting through the REAL producer bind", () => {
  it("renders a review gate as an artifact_review_gate DATA_PART", async () => {
    const [ref] = await listRefs();
    const res = await call("artifact_review_gate_render", { ref });
    expect(throughProducerBind(res, "artifact_review_gate_render")).toEqual({
      viewType: "artifact_review_gate",
      schemaVersion: 1,
      ref,
    });
  });

  it("renders a verification record as a verification_summary DATA_PART", async () => {
    const [ref] = await listRefs();
    const res = await call("verification_record_render", { ref });
    expect(throughProducerBind(res, "verification_record_render")).toEqual({
      viewType: "verification_summary",
      schemaVersion: 1,
      ref,
    });
  });

  it("is bound PER VIEWTYPE — a review result under the verification tool mints nothing", async () => {
    const [ref] = await listRefs();
    const review = await call("artifact_review_gate_render", { ref });
    const verification = await call("verification_record_render", { ref });
    // The cross pair: each result is legitimate under its OWN tool name and
    // mints nothing under the other's, so a first-party tool that may show a
    // verification reading can never mint a review gate card.
    expect(throughProducerBind(review, "verification_record_render")).toBeNull();
    expect(throughProducerBind(verification, "artifact_review_gate_render")).toBeNull();
  });

  it("mints nothing when the result does not come from the first-party server", async () => {
    const [ref] = await listRefs();
    const res = await call("artifact_review_gate_render", { ref });
    for (const label of ["Cinatra", "cinatra-", "acme-tools", ""]) {
      expect(throughProducerBind(res, "artifact_review_gate_render", label)).toBeNull();
    }
  });

  it("the LIST result is refs, not a card — it mints no DATA_PART", async () => {
    const res = await call("artifact_review_gates_list", {});
    expect(throughProducerBind(res, "artifact_review_gates_list")).toBeNull();
    expect(res.structuredContent).toEqual({ refs: [expect.any(String)] });
  });
});

// ---------------------------------------------------------------------------
// Access — run read before gate existence
// ---------------------------------------------------------------------------

describe("run-read authorization ordering", () => {
  it("decides run READ access BEFORE anything reads the gate", async () => {
    const [ref] = await listRefs();
    vi.clearAllMocks();
    accessFor([]); // no access at all
    const res = await call("artifact_review_gate_render", { ref });
    expect(text(res)).toBe(LIFECYCLE_REFUSAL_RESULT);
    // The load-bearing half: the gate was never consulted, so a reader holding
    // a ref cannot learn whether it addresses anything.
    expect(readReviewGateState).not.toHaveBeenCalled();
    expect(enforceReviewRunAccess).toHaveBeenCalledWith(
      "run-1",
      expect.anything(),
      "read",
      expect.anything(),
    );
  });

  it("refuses a ref for a gate that does not exist — same answer as no access", async () => {
    const [ref] = await listRefs();
    readReviewGateState.mockResolvedValue({ status: "unavailable" });
    const absent = await call("artifact_review_gate_render", { ref });
    accessFor([]);
    const denied = await call("artifact_review_gate_render", { ref });
    expect(text(absent)).toBe(LIFECYCLE_REFUSAL_RESULT);
    expect(text(denied)).toBe(text(absent));
  });

  it("still renders a gate the reader may READ but not DECIDE (restricted, not withheld)", async () => {
    const [ref] = await listRefs();
    accessFor(["read"]);
    const res = await call("artifact_review_gate_render", { ref });
    // A withheld card must never appear as a disabled one — and a disabled one
    // must never be silently dropped. The card mints; its floor is the
    // refetch's business.
    expect(throughProducerBind(res, "artifact_review_gate_render")).not.toBeNull();
  });

  it("refuses a verification reading that does not exist yet", async () => {
    const [ref] = await listRefs();
    readVerificationRecordForGate.mockResolvedValue(null);
    const res = await call("verification_record_render", { ref });
    expect(text(res)).toBe(LIFECYCLE_REFUSAL_RESULT);
    expect(throughProducerBind(res, "verification_record_render")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The list — per-row access, opaque refs, honest emptiness
// ---------------------------------------------------------------------------

describe("artifact_review_gates_list", () => {
  it("lists ONLY the gates whose run the caller may read", async () => {
    listOpenReviewGateCandidates.mockResolvedValue([
      gateRow("run-mine", "task-1"),
      gateRow("run-theirs", "task-2"),
    ]);
    enforceReviewRunAccess.mockImplementation(async (runId) => ({
      ok: runId === "run-mine",
    }));
    const refs = await listRefs();
    expect(refs).toHaveLength(1);
    expect(decodeLifecycleGateRef(refs[0])).toEqual({
      runId: "run-mine",
      reviewTaskId: "task-1",
    });
  });

  it("drops a row whose access check THROWS rather than disclosing it", async () => {
    listOpenReviewGateCandidates.mockResolvedValue([
      gateRow("run-ok", "task-1"),
      gateRow("run-broken", "task-2"),
    ]);
    enforceReviewRunAccess.mockImplementation(async (runId) => {
      if (runId === "run-broken") throw new Error("store exploded");
      return { ok: true };
    });
    const refs = await listRefs();
    expect(refs).toHaveLength(1);
    expect(decodeLifecycleGateRef(refs[0])?.runId).toBe("run-ok");
  });

  it("returns OPAQUE refs — no run id, no gate id, nothing readable", async () => {
    const res = await call("artifact_review_gates_list", {});
    const serialized = text(res);
    expect(serialized).not.toContain("run-1");
    expect(serialized).not.toContain("task-1");

  });

  it("honors its bound and never returns more than asked for", async () => {
    listOpenReviewGateCandidates.mockResolvedValue(
      Array.from({ length: 9 }, (_, i) => gateRow(`run-${i}`, `task-${i}`)),
    );
    expect(await listRefs({ limit: 2 })).toHaveLength(2);
    // The default is the backlog HEAD a person can act on, not an export.
    expect((await listRefs()).length).toBeLessThanOrEqual(5);
  });

  it("asks the store for ids only, bounded — never the rollup reader", async () => {
    await call("artifact_review_gates_list", {});
    expect(listOpenReviewGateCandidates).toHaveBeenCalledWith({
      orgId: "org-1",
      limit: 25,
    });
  });

  it("REFUSES rather than reporting an empty queue when no ref can be minted", async () => {
    // The readable rows are real; the mint is what failed (no signing key, ids
    // past the wire bound). Reporting "nothing waiting" here would be a
    // comfortable lie about work that IS waiting.
    listOpenReviewGateCandidates.mockResolvedValue([
      gateRow("r".repeat(200), "task-1"),
    ]);
    const res = await call("artifact_review_gates_list", {});
    expect(text(res)).toBe(LIFECYCLE_REFUSAL_RESULT);
  });

  it("REFUSES a PARTIAL queue too — a short list reads as 'that is everything'", async () => {
    listOpenReviewGateCandidates.mockResolvedValue([
      gateRow("run-ok", "task-1"),
      gateRow("r".repeat(200), "task-2"),
    ]);
    const res = await call("artifact_review_gates_list", {});
    expect(text(res)).toBe(LIFECYCLE_REFUSAL_RESULT);
  });

  it("answers an EMPTY queue truthfully — an empty list is not a refusal", async () => {
    listOpenReviewGateCandidates.mockResolvedValue([]);
    const res = await call("artifact_review_gates_list", {});
    expect(res.structuredContent).toEqual({ refs: [] });
    expect(text(res)).not.toBe(LIFECYCLE_REFUSAL_RESULT);
  });

  it("refuses when the store fails — a failure is not an existence signal", async () => {
    listOpenReviewGateCandidates.mockRejectedValue(new Error("db down"));
    expect(text(await call("artifact_review_gates_list", {}))).toBe(
      LIFECYCLE_REFUSAL_RESULT,
    );
  });
});

// ---------------------------------------------------------------------------
// The refusal contract
// ---------------------------------------------------------------------------

describe("the refusal contract", () => {
  const refusalCases: [string, unknown, Partial<McpRequestContext>][] = [
    ["no attributable user", { ref: "x" }, { orgId: "org-1" }],
    ["no active organization", { ref: "x" }, { userId: "u-reviewer" }],
    ["a ref that does not decode", { ref: "not-one-of-ours" }, CALLER],
    ["a malformed input", { gateId: "gate-1" }, CALLER],
    ["an unbounded ref", { ref: "z".repeat(4096) }, CALLER],
  ];

  for (const [what, input, ctx] of refusalCases) {
    it(`answers the ONE fixed sentence for ${what}`, async () => {
      for (const tool of ["artifact_review_gate_render", "verification_record_render"]) {
        const res = await call(tool, input, ctx);
        expect(text(res)).toBe(LIFECYCLE_REFUSAL_RESULT);
        expect(throughProducerBind(res, tool)).toBeNull();
      }
    });
  }

  it("carries no identifier, count or reason — the persisted result is inert", async () => {
    const [ref] = await listRefs();
    accessFor([]);
    const res = await call("artifact_review_gate_render", { ref });
    const persisted = text(res);
    for (const secret of ["run-1", "task-1", "gate-run-1", "org-1", ref]) {
      expect(persisted).not.toContain(secret);
    }
    expect(persisted).not.toMatch(/\d/); // no counts, no ids, no status codes
  });

  it("refuses the list to a caller with no attributable principal", async () => {
    const res = await call("artifact_review_gates_list", {}, { orgId: "org-1" });
    expect(text(res)).toBe(LIFECYCLE_REFUSAL_RESULT);
    expect(listOpenReviewGateCandidates).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The property the whole ref design exists for
// ---------------------------------------------------------------------------

describe("a scope change between list and render", () => {
  it("drops the card — the ref is not a capability", async () => {
    const [ref] = await listRefs();
    expect(ref).toBeTruthy();

    // The caller loses run access after the list and before the render — the
    // exact window a snapshot-carrying transcript would otherwise paper over.
    accessFor([]);
    const res = await call("artifact_review_gate_render", { ref });

    expect(text(res)).toBe(LIFECYCLE_REFUSAL_RESULT);
    expect(throughProducerBind(res, "artifact_review_gate_render")).toBeNull();
  });

  it("re-authorizes a ref minted for ANOTHER caller from scratch", async () => {
    const [ref] = await listRefs();
    enforceReviewRunAccess.mockImplementation(async (_runId, actor) => ({
      ok: (actor as { userId?: string }).userId === "u-reviewer",
    }));
    const stolen = await call("artifact_review_gate_render", { ref }, {
      ...CALLER,
      userId: "u-outsider",
    });
    expect(text(stolen)).toBe(LIFECYCLE_REFUSAL_RESULT);
  });
});
