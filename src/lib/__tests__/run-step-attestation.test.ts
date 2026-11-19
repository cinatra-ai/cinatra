/**
 * cinatra#3745 — the application verifies the step identity the flow runtime
 * signs on a run's calls, and the step the runtime records when a run pauses.
 *
 * A step pair is `X-Cinatra-Step-Node: <nodeId>` plus
 * `X-Cinatra-Step-Attestation: s1:<expiry>:<hex>`, the hex being HMAC-SHA256
 * with the runtime's dedicated key over `s1\n<contextId>\n<nodeId>\n<expiry>`.
 * A gate claim is `{ node, attestation: "g1:<hex>" }` over
 * `g1\n<contextId>\n<taskId>\n<nodeId>`. Each verifier answers the verified
 * node id or null. A source-bound pair (`s2`) also signs the execution attempt
 * the task was sent under and the three digests of the executing source, sent
 * in their own headers; its verifier answers the frozen step, attempt and
 * digests, or null. These cases drive the real functions.
 */
import { afterAll, describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("server-only", () => ({}));

import * as runToken from "@/lib/agent-run-token";

const KEY = "step-attest-key-under-test";
const OTHER_KEY = "another-key-under-test";
const CTX = "ctx-run-1";
const NODE = "step-node-1";
const TASK = "task-gate-1";
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

type StepVerifyInput = {
  key: string | null | undefined;
  contextId: string | null | undefined;
  node: string | null | undefined;
  attestation: string | null | undefined;
  nowMs?: number;
};
type GateVerifyInput = {
  key: string | null | undefined;
  contextId: string | null | undefined;
  taskId: string | null | undefined;
  claim: unknown;
};

type SourceVerifyInput = {
  key?: string | null;
  contextId?: string | null;
  node?: string | null;
  executionAttemptId?: string | null;
  attestation?: string | null;
  sourceSha256?: string | null;
  executedSourceSha256?: string | null;
  declarationSourceSha256?: string | null;
  nowMs?: number;
};

const api = runToken as unknown as {
  verifyRunStepAttestation: (input: StepVerifyInput) => string | null;
  verifyGateNodeClaim: (input: GateVerifyInput) => string | null;
  verifySourceBoundRunStep?: (input: SourceVerifyInput) => Record<string, string> | null;
  RUN_STEP_NODE_HEADER: string;
  RUN_STEP_ATTESTATION_HEADER: string;
  RUN_RAW_SOURCE_HEADER?: string;
  RUN_EXECUTED_SOURCE_HEADER?: string;
  RUN_DECLARATION_SOURCE_HEADER?: string;
  RUN_EXECUTION_ATTEMPT_HEADER?: string;
  CINATRA_EXECUTION_ATTEMPT_MESSAGE_KEY?: string;
};

function hmacHex(key: string, material: string): string {
  return createHmac("sha256", key).update(material).digest("hex");
}

function stepPair(opts: {
  key?: string;
  ctx?: string;
  node?: string;
  expiry?: number;
}): { node: string; attestation: string } {
  const key = opts.key ?? KEY;
  const ctx = opts.ctx ?? CTX;
  const node = opts.node ?? NODE;
  const expiry = opts.expiry ?? NOW_S + 300;
  return {
    node,
    attestation: `s1:${expiry}:${hmacHex(key, `s1\n${ctx}\n${node}\n${expiry}`)}`,
  };
}

function gateClaim(opts: { key?: string; ctx?: string; task?: string; node?: string }) {
  const key = opts.key ?? KEY;
  const ctx = opts.ctx ?? CTX;
  const task = opts.task ?? TASK;
  const node = opts.node ?? NODE;
  return { node, attestation: `g1:${hmacHex(key, `g1\n${ctx}\n${task}\n${node}`)}` };
}

describe("step identity verification", () => {
  // (a1)
  it("a pair signed with the key over the given context answers the node id", () => {
    expect(api.RUN_STEP_NODE_HEADER).toBe("x-cinatra-step-node");
    expect(api.RUN_STEP_ATTESTATION_HEADER).toBe("x-cinatra-step-attestation");
    const pair = stepPair({});
    expect(
      api.verifyRunStepAttestation({ key: KEY, contextId: CTX, ...pair, nowMs: NOW_MS }),
    ).toBe(NODE);
  });

  // (a2)
  it("a changed node, context, expiry or signature, or another key, answers null", () => {
    const pair = stepPair({});
    const [, expiry, sig] = pair.attestation.split(":");
    const cases: StepVerifyInput[] = [
      { key: KEY, contextId: CTX, node: "step-node-2", attestation: pair.attestation },
      { key: KEY, contextId: "ctx-run-2", node: NODE, attestation: pair.attestation },
      { key: KEY, contextId: CTX, node: NODE, attestation: `s1:${Number(expiry) + 1}:${sig}` },
      {
        key: KEY,
        contextId: CTX,
        node: NODE,
        attestation: `s1:${expiry}:${sig!.slice(0, -1)}${sig!.endsWith("0") ? "1" : "0"}`,
      },
      { key: KEY, contextId: CTX, ...stepPair({ key: OTHER_KEY }) },
      { key: OTHER_KEY, contextId: CTX, node: NODE, attestation: pair.attestation },
    ];
    for (const input of cases) {
      expect(api.verifyRunStepAttestation({ ...input, nowMs: NOW_MS })).toBeNull();
    }
  });

  // (a3)
  it("an expiry past the window or too far ahead answers null", () => {
    const past = stepPair({ expiry: NOW_S - 61 });
    const ahead = stepPair({ expiry: NOW_S + 601 });
    const edgePast = stepPair({ expiry: NOW_S - 59 });
    const edgeAhead = stepPair({ expiry: NOW_S + 599 });
    expect(api.verifyRunStepAttestation({ key: KEY, contextId: CTX, ...past, nowMs: NOW_MS })).toBeNull();
    expect(api.verifyRunStepAttestation({ key: KEY, contextId: CTX, ...ahead, nowMs: NOW_MS })).toBeNull();
    expect(api.verifyRunStepAttestation({ key: KEY, contextId: CTX, ...edgePast, nowMs: NOW_MS })).toBe(NODE);
    expect(api.verifyRunStepAttestation({ key: KEY, contextId: CTX, ...edgeAhead, nowMs: NOW_MS })).toBe(NODE);
  });

  // (a4)
  it("a context-resolution pair presented as a step pair answers null", () => {
    const expiry = NOW_S + 300;
    const v2 = `v2:${expiry}:${hmacHex(KEY, `v2\n${CTX}\n${NODE}\n${expiry}`)}`;
    expect(
      api.verifyRunStepAttestation({ key: KEY, contextId: CTX, node: NODE, attestation: v2, nowMs: NOW_MS }),
    ).toBeNull();
    // the same v2 material under the step prefix does not verify either
    const relabelled = `s1:${expiry}:${hmacHex(KEY, `v2\n${CTX}\n${NODE}\n${expiry}`)}`;
    expect(
      api.verifyRunStepAttestation({ key: KEY, contextId: CTX, node: NODE, attestation: relabelled, nowMs: NOW_MS }),
    ).toBeNull();
    // a gate claim's attestation is not a step pair
    expect(
      api.verifyRunStepAttestation({
        key: KEY,
        contextId: CTX,
        node: NODE,
        attestation: gateClaim({}).attestation,
        nowMs: NOW_MS,
      }),
    ).toBeNull();
  });

  // (a5)
  it("no key, no context id or a missing half of the pair answers null", () => {
    const pair = stepPair({});
    const cases: StepVerifyInput[] = [
      { key: undefined, contextId: CTX, ...pair },
      { key: "", contextId: CTX, ...pair },
      { key: KEY, contextId: null, ...pair },
      { key: KEY, contextId: "", ...pair },
      { key: KEY, contextId: CTX, node: null, attestation: pair.attestation },
      { key: KEY, contextId: CTX, node: "", attestation: pair.attestation },
      { key: KEY, contextId: CTX, node: NODE, attestation: null },
      { key: KEY, contextId: CTX, node: NODE, attestation: "" },
      { key: KEY, contextId: CTX, node: NODE, attestation: "s1:notanumber:abcd" },
    ];
    for (const input of cases) {
      expect(api.verifyRunStepAttestation({ ...input, nowMs: NOW_MS })).toBeNull();
    }
  });
});

describe("recorded pause step verification", () => {
  // (a6)
  it("a gate claim answers its node for its own context and task, and null otherwise", () => {
    const claim = gateClaim({});
    expect(api.verifyGateNodeClaim({ key: KEY, contextId: CTX, taskId: TASK, claim })).toBe(NODE);
    expect(api.verifyGateNodeClaim({ key: KEY, contextId: CTX, taskId: "task-gate-2", claim })).toBeNull();
    expect(api.verifyGateNodeClaim({ key: KEY, contextId: "ctx-run-2", taskId: TASK, claim })).toBeNull();
    expect(api.verifyGateNodeClaim({ key: OTHER_KEY, contextId: CTX, taskId: TASK, claim })).toBeNull();
    expect(
      api.verifyGateNodeClaim({ key: KEY, contextId: CTX, taskId: TASK, claim: { ...claim, node: "step-node-2" } }),
    ).toBeNull();
    for (const malformed of [
      null,
      undefined,
      "g1:00",
      42,
      [],
      {},
      { node: NODE },
      { attestation: claim.attestation },
      { node: 7, attestation: claim.attestation },
      { node: NODE, attestation: 7 },
      { node: NODE, attestation: claim.attestation.replace("g1:", "s1:") },
      { node: NODE, attestation: "g1:not-hex" },
    ]) {
      expect(
        api.verifyGateNodeClaim({ key: KEY, contextId: CTX, taskId: TASK, claim: malformed }),
      ).toBeNull();
    }
    expect(api.verifyGateNodeClaim({ key: undefined, contextId: CTX, taskId: TASK, claim })).toBeNull();
    expect(api.verifyGateNodeClaim({ key: KEY, contextId: CTX, taskId: "", claim })).toBeNull();
  });
});

describe("source-bound step verification (s2)", () => {
  const RAW = "a".repeat(64);
  const EXECUTED = "b".repeat(64);
  const DECLARATION = "c".repeat(64);
  const ATTEMPT = "attempt-a";
  function signed(opts: { key?: string; expiry?: number; attempt?: string } = {}): string {
    const expiry = opts.expiry ?? NOW_S + 300;
    const attempt = opts.attempt ?? ATTEMPT;
    return `s2:${expiry}:${hmacHex(opts.key ?? KEY, `s2\n${CTX}\n${NODE}\n${attempt}\n${RAW}\n${EXECUTED}\n${DECLARATION}\n${expiry}`)}`;
  }
  const input = (): SourceVerifyInput => ({
    key: KEY, contextId: CTX, node: NODE, executionAttemptId: ATTEMPT, attestation: signed(),
    sourceSha256: RAW, executedSourceSha256: EXECUTED, declarationSourceSha256: DECLARATION, nowMs: NOW_MS,
  });
  function verify(value: SourceVerifyInput) {
    expect(typeof api.verifySourceBoundRunStep).toBe("function");
    return api.verifySourceBoundRunStep!(value);
  }

  // (s1)
  it("names its three source headers, its attempt header and the attempt's message key", () => {
    expect([api.RUN_RAW_SOURCE_HEADER, api.RUN_EXECUTED_SOURCE_HEADER, api.RUN_DECLARATION_SOURCE_HEADER])
      .toEqual(["x-cinatra-raw-source", "x-cinatra-executed-source", "x-cinatra-declaration-source"]);
    expect(api.RUN_EXECUTION_ATTEMPT_HEADER).toBe("x-cinatra-execution-attempt");
    // A cross-language ABI with docker/wayflow/agent_loader.py (no shared import).
    expect(api.CINATRA_EXECUTION_ATTEMPT_MESSAGE_KEY).toBe("__cinatra_execution_attempt__");
  });

  // (s2)
  it("a pair signed over the step, the attempt and all three digests answers them, frozen", () => {
    const proof = verify(input());
    expect(proof).toEqual({ stepId: NODE, contextId: CTX, executionAttemptId: ATTEMPT, sourceSha256: RAW,
      executedSourceSha256: EXECUTED, declarationSourceSha256: DECLARATION });
    expect(Object.isFrozen(proof)).toBe(true);
  });

  // (s3)
  it("refuses a change of any signed value, another key, an s1 pair, a line break or a malformed digest", () => {
    for (const change of [
      { sourceSha256: "f".repeat(64) },
      { executedSourceSha256: "f".repeat(64) },
      { declarationSourceSha256: "f".repeat(64) },
      { contextId: "ctx-run-2" },
      { node: "step-node-2" },
      { executionAttemptId: "attempt-b" },
      { attestation: signed({ attempt: "attempt-b" }) },
      { executionAttemptId: null },
      { executionAttemptId: "" },
      { executionAttemptId: "attempt\nother" },
      { executionAttemptId: "attempt\rother" },
      { executionAttemptId: "a".repeat(513) },
      { key: OTHER_KEY },
      { attestation: stepPair({}).attestation },
      { attestation: signed().replace(/:[a-f0-9]{64}$/, ":" + "A".repeat(64)) },
      { attestation: signed() + "0" },
      { node: "step\nother" },
      { contextId: "ctx\rother" },
      { sourceSha256: null },
      { executedSourceSha256: "B".repeat(64) },
      { declarationSourceSha256: "c".repeat(63) },
      { key: null },
      { attestation: null },
    ] satisfies SourceVerifyInput[]) {
      expect(verify({ ...input(), ...change }), JSON.stringify(change)).toBeNull();
    }
  });

  // (s4)
  it("refuses an expiry more than 60 seconds past or more than 600 seconds ahead", () => {
    expect(verify({ ...input(), attestation: signed({ expiry: NOW_S - 60 }) })).not.toBeNull();
    expect(verify({ ...input(), attestation: signed({ expiry: NOW_S - 61 }) })).toBeNull();
    expect(verify({ ...input(), attestation: signed({ expiry: NOW_S + 600 }) })).not.toBeNull();
    expect(verify({ ...input(), attestation: signed({ expiry: NOW_S + 601 }) })).toBeNull();
  });

  // (s5)
  it("an s2 pair is no s1 pair: the step-only verifier refuses it", () => {
    expect(api.verifyRunStepAttestation({ key: KEY, contextId: CTX, node: NODE, attestation: signed(), nowMs: NOW_MS }))
      .toBeNull();
  });

  // (s6)
  it("refuses a line break in the context id or the step id even when the signature covers the joined values", () => {
    const expiry = NOW_S + 300;
    const over = (contextId: string, node: string) =>
      `s2:${expiry}:${hmacHex(KEY, `s2\n${contextId}\n${node}\n${ATTEMPT}\n${RAW}\n${EXECUTED}\n${DECLARATION}\n${expiry}`)}`;
    // Control: the same signing answers a pair without a line break, so a null below comes from the line-break refusal.
    expect(verify({ ...input(), contextId: "ctx-a", node: "step-b", attestation: over("ctx-a", "step-b") }))
      .not.toBeNull();
    // "ctx\nother" + "step" and "ctx" + "other\nstep" join to the same signed text; each split is refused.
    const joined = over("ctx\nother", "step");
    expect(over("ctx", "other\nstep")).toBe(joined);
    expect(verify({ ...input(), contextId: "ctx\nother", node: "step", attestation: joined })).toBeNull();
    expect(verify({ ...input(), contextId: "ctx", node: "other\nstep", attestation: joined })).toBeNull();
  });

  // (s7)
  it("binds the pair to the attempt it was signed under: one signed without an attempt, or under another, is refused", () => {
    const expiry = NOW_S + 300;
    // The material without the attempt: a pair a task of any attempt of the run could present.
    const noAttempt = `s2:${expiry}:${hmacHex(KEY, `s2\n${CTX}\n${NODE}\n${RAW}\n${EXECUTED}\n${DECLARATION}\n${expiry}`)}`;
    expect(verify({ ...input(), attestation: noAttempt })).toBeNull();
    expect(verify({ ...input(), executionAttemptId: undefined, attestation: noAttempt })).toBeNull();
    // Attempt A's pair presented with attempt B's id, and the reverse.
    expect(verify({ ...input(), executionAttemptId: "attempt-b", attestation: signed() })).toBeNull();
    expect(verify({ ...input(), attestation: signed({ attempt: "attempt-b" }) })).toBeNull();
    expect(verify({ ...input(), executionAttemptId: "attempt-b", attestation: signed({ attempt: "attempt-b" }) }))
      .toMatchObject({ executionAttemptId: "attempt-b" });
  });

  // (s8)
  it("accepts a signed context id, step id or attempt of 512 characters and refuses one of 513, as the run-source proof does", () => {
    const expiry = NOW_S + 300;
    const at = (field: "contextId" | "node" | "executionAttemptId", length: number): SourceVerifyInput => {
      const v = { contextId: CTX, node: NODE, executionAttemptId: ATTEMPT, [field]: "x".repeat(length) };
      return { ...input(), ...v,
        attestation: `s2:${expiry}:${hmacHex(KEY, `s2\n${v.contextId}\n${v.node}\n${v.executionAttemptId}\n${RAW}\n${EXECUTED}\n${DECLARATION}\n${expiry}`)}` };
    };
    for (const field of ["contextId", "node", "executionAttemptId"] as const) {
      expect(verify(at(field, 512)), `${field} 512`).not.toBeNull();
      // Correctly signed, so the null comes from the length refusal alone.
      expect(verify(at(field, 513)), `${field} 513`).toBeNull();
    }
  });
});

// Leave the module registry as this file found it.
afterAll(() => {
  vi.doUnmock("server-only");
  vi.resetModules();
});
