/**
 * cinatra#3745 — the application verifies the step identity the flow runtime
 * signs on a run's calls, and the step the runtime records when a run pauses.
 *
 * A step pair is `X-Cinatra-Step-Node: <nodeId>` plus
 * `X-Cinatra-Step-Attestation: s1:<expiry>:<hex>`, the hex being HMAC-SHA256
 * with the runtime's dedicated key over `s1\n<contextId>\n<nodeId>\n<expiry>`.
 * A gate claim is `{ node, attestation: "g1:<hex>" }` over
 * `g1\n<contextId>\n<taskId>\n<nodeId>`. Each verifier answers the verified
 * node id or null. These cases drive the real functions.
 */
import { afterAll, describe, it, expect, vi } from "vitest";
import { createHmac, createHash } from "node:crypto";

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

const api = runToken as unknown as {
  verifyRunStepAttestation: (input: StepVerifyInput) => string | null;
  verifyGateNodeClaim: (input: GateVerifyInput) => string | null;
  RUN_STEP_NODE_HEADER: string;
  RUN_STEP_ATTESTATION_HEADER: string;
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

// Leave the module registry as this file found it.
afterAll(() => {
  vi.doUnmock("server-only");
  vi.resetModules();
});


describe("producer step production binding v2", () => {
  const inputsJson = JSON.stringify({ note: "draft the reviewed story", topic: "Launch" });
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const binding = { version: 2, producerStepId: NODE, noteInputPath: "note", sourceSha256: "a".repeat(64), graphSha256: "b".repeat(64), effectiveInputsJson: inputsJson, effectiveInputsSha256: sha(inputsJson) };
  function claim(value = binding, prefix = "s2", expiry = NOW_S + 300) {
    const material = `${prefix}\n${CTX}\n${value.producerStepId}\n${expiry}\n${value.sourceSha256}\n${value.graphSha256}\n${value.noteInputPath}\n${value.effectiveInputsSha256}`;
    return { binding: Buffer.from(JSON.stringify(value)).toString("base64url"), attestation: `${prefix}:${expiry}:${hmacHex(KEY, material)}` };
  }
  function verify(pair = claim(), opts = {}) {
    expect(typeof runToken.verifyRunProducerBinding).toBe("function");
    return runToken.verifyRunProducerBinding({ key: KEY, contextId: CTX, node: NODE, ...pair, nowMs: NOW_MS, ...opts });
  }
  it("records actual effective inputs and immutable graph pin from the separately signed v2 claim", () => {
    expect(verify()).toMatchObject({ version: 2, producerStepId: NODE, inputParams: { note: "draft the reviewed story", topic: "Launch" }, graphSha256: binding.graphSha256 });
  });
  it("v1 offered as v2 fails rather than manufacturing production inputs", () => {
    expect(verify({ ...claim(), attestation: stepPair({}).attestation })).toBeNull();
    expect(verify(claim(binding, "s1"))).toBeNull();
    const s2 = claim();
    expect(api.verifyRunStepAttestation({ key: KEY, contextId: CTX, node: NODE, attestation: s2.attestation, nowMs: NOW_MS })).toBeNull();
  });
  it("tampered effective inputs or digest cannot verify", () => {
    const signed = claim();
    for (const changed of [{ ...binding, effectiveInputsJson: JSON.stringify({ note: "different" }) }, { ...binding, effectiveInputsSha256: "c".repeat(64) }]) {
      expect(verify({ ...signed, binding: Buffer.from(JSON.stringify(changed)).toString("base64url") })).toBeNull();
    }
  });
  it("wrong recorded graph pin, altered producer, Note declaration or source pin cannot verify", () => {
    const signed = claim();
    expect(verify(signed, { expectedGraphSha256: "c".repeat(64) })).toBeNull();
    expect(verify(signed, { expectedGraphSha256: binding.graphSha256 })).not.toBeNull();
    for (const changed of [{ ...binding, graphSha256: "c".repeat(64) }, { ...binding, sourceSha256: "c".repeat(64) }, { ...binding, noteInputPath: "topic" }, { ...binding, producerStepId: "other" }]) {
      expect(verify({ ...signed, binding: Buffer.from(JSON.stringify(changed)).toString("base64url") })).toBeNull();
    }
  });
  it("retains context, key and unchanged expiry-window refusal", () => {
    for (const opts of [{ contextId: "other" }, { key: OTHER_KEY }, { key: "" }, { node: "other" }]) expect(verify(claim(), opts)).toBeNull();
    expect(verify(claim(binding, "s2", NOW_S - 61))).toBeNull();
    expect(verify(claim(binding, "s2", NOW_S + 601))).toBeNull();
    expect(verify(claim(binding, "s2", NOW_S - 59))).not.toBeNull();
  });
  it("rejects a signed dotted Note path instead of inferring nested Step inputs", () => {
    const nestedJson = JSON.stringify({ inputs: { note: "draft the reviewed story" } });
    const nested = { ...binding, noteInputPath: "inputs.note", effectiveInputsJson: nestedJson, effectiveInputsSha256: sha(nestedJson) };
    expect(verify(claim(nested))).toBeNull();
    expect(verify()).not.toBeNull();
  });
  it("unknown versions, nonobject inputs, malformed Note paths and hostile oversized payloads fail closed", () => {
    for (const changed of [{ ...binding, version: 1 }, { ...binding, noteInputPath: "__proto__.note" }, { ...binding, effectiveInputsJson: "[]", effectiveInputsSha256: sha("[]") }, { ...binding, effectiveInputsJson: '{"note":null}', effectiveInputsSha256: sha('{"note":null}') }]) expect(verify(claim(changed))).toBeNull();
    expect(verify({ ...claim(), binding: "a".repeat(100_000) })).toBeNull();
  });
});
