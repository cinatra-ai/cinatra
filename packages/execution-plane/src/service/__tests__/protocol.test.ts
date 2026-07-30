/**
 * Wire-contract tests (exec-plane S1 remainder, epic cinatra#1705).
 *
 * Three things are proven here: the protocol-version refusal is EXACT and
 * fail-closed in both directions, the parsers are strict (no coercion of a
 * wrong-typed field into a plausible value), and every op's payload survives a
 * `JSON.stringify` → `JSON.parse` round trip unchanged — the `types.ts`
 * "JSON-serializable primitives only" doctrine, enforced rather than asserted in
 * a comment.
 */

import { describe, expect, it } from "vitest";

import {
  BROKER_OPS,
  EXEC_ERROR_STATUS,
  EXEC_PROTOCOL_VERSION,
  WORKER_OPS,
  checkProtocolHeader,
  checkProtocolVersion,
  execErrorResponse,
  execOkResponse,
  execRequestEnvelope,
  parseBrokerRequest,
  parseWorkerRequest,
} from "../protocol";
import type { SandboxCommandSpec } from "../../types";

const V = EXEC_PROTOCOL_VERSION;

function envelope(op: string, payload: unknown, protocolVersion: unknown = V): unknown {
  return { protocolVersion, op, payload };
}

const SPEC: SandboxCommandSpec = {
  jobId: "job-1",
  command: "echo hi",
  workspaceVolume: "cinatra-exec-l2-run-1",
  egress: {
    kind: "gateway",
    mode: "allowlist",
    network: "cinatra-exec-internal",
    jobToken: "job-token-1",
    gateway: { host: "gw", port: 3128, adminUrl: "http://127.0.0.1:3129", controlSecret: "s" },
  },
  limits: {
    cpus: 1,
    memoryMb: 1024,
    pidsLimit: 256,
    timeoutMs: 120_000,
    maxStdioBytes: 1_048_576,
    workspaceQuotaKb: 262_144,
  },
};

describe("protocol version", () => {
  it("accepts only the exact version", () => {
    expect(checkProtocolVersion(V).ok).toBe(true);
  });

  const mismatches: Array<[string, unknown]> = [
    ["a missing version", undefined],
    ["null", null],
    ["the version as a string", String(V)],
    ["an OLDER version", V - 1],
    ["a NEWER version", V + 1],
    ["a near-miss float", V + 0.0000001],
    ["NaN", Number.NaN],
  ];
  for (const [label, value] of mismatches) {
    it(`refuses ${label} fail-closed`, () => {
      const verdict = checkProtocolVersion(value);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe("protocol_version_mismatch");
    });
  }

  it("treats an absent transport header as fine but a differing one as a mismatch", () => {
    expect(checkProtocolHeader(undefined).ok).toBe(true);
    expect(checkProtocolHeader(` ${V} `).ok).toBe(true);
    const verdict = checkProtocolHeader(String(V + 1));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("protocol_version_mismatch");
  });

  it("refuses every op when the version is wrong — no op is exempt", () => {
    for (const op of [...BROKER_OPS]) {
      const verdict = parseBrokerRequest(envelope(op, {}, V + 1));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe("protocol_version_mismatch");
    }
    for (const op of [...WORKER_OPS]) {
      const verdict = parseWorkerRequest(envelope(op, {}, V + 1));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe("protocol_version_mismatch");
    }
  });

  it("maps a version mismatch to a 400 and an unauthorized peer to a 403", () => {
    expect(EXEC_ERROR_STATUS.protocol_version_mismatch).toBe(400);
    expect(EXEC_ERROR_STATUS.unauthorized_peer).toBe(403);
    expect(EXEC_ERROR_STATUS.unauthorized_token).toBe(401);
    expect(EXEC_ERROR_STATUS.command_in_flight).toBe(409);
  });
});

describe("envelope parsing", () => {
  it("refuses a non-object body, a missing op and an unknown op", () => {
    expect(parseBrokerRequest("nope").ok).toBe(false);
    expect(parseBrokerRequest(envelope("", {})).ok).toBe(false);
    const unknown = parseBrokerRequest(envelope("dropTables", {}));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("unknown_op");
  });

  it("keeps the two vocabularies separate — a worker op is unknown to the broker", () => {
    const onBroker = parseBrokerRequest(envelope("runCommand", { commandId: "c", spec: SPEC }));
    expect(onBroker.ok).toBe(false);
    if (!onBroker.ok) expect(onBroker.code).toBe("unknown_op");
    const onWorker = parseWorkerRequest(envelope("openJob", { carrier: "c" }));
    expect(onWorker.ok).toBe(false);
    if (!onWorker.ok) expect(onWorker.code).toBe("unknown_op");
  });

  it("requires an object payload", () => {
    expect(parseBrokerRequest(envelope("health", null)).ok).toBe(false);
    expect(parseBrokerRequest(envelope("health", "x")).ok).toBe(false);
  });
});

describe("app → broker payloads", () => {
  it("parses openJob with staged skills and a declared environment", () => {
    const parsed = parseBrokerRequest(
      envelope("openJob", {
        carrier: "sealed.carrier",
        stagedSkills: [
          { slug: "blog-writing", files: [{ path: "SKILL.md", content: "# x", digest: "ab" }] },
        ],
        environment: { imageRef: "cinatra-exec-l1:abc", provenance: { signature: "sig" } },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.op).toBe("openJob");
    if (parsed.request.op !== "openJob") return;
    expect(parsed.request.payload.stagedSkills?.[0]?.files[0]?.digest).toBe("ab");
    expect(parsed.request.payload.environment?.imageRef).toBe("cinatra-exec-l1:abc");
  });

  it("refuses a staged skill missing a digest — staging integrity is not optional", () => {
    const parsed = parseBrokerRequest(
      envelope("openJob", {
        carrier: "c",
        stagedSkills: [{ slug: "s", files: [{ path: "a", content: "b" }] }],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/digest/);
  });

  it("requires a commandId on exec — idempotency is part of the contract", () => {
    expect(
      parseBrokerRequest(envelope("exec", { jobId: "j", command: "ls", voucher: "v" })).ok,
    ).toBe(false);
    const parsed = parseBrokerRequest(
      envelope("exec", { jobId: "j", command: "ls", commandId: "c1", voucher: "v" }),
    );
    expect(parsed.ok).toBe(true);
  });

  it("requires a voucher on exec — the per-command authorization boundary is part of the contract", () => {
    expect(
      parseBrokerRequest(envelope("exec", { jobId: "j", command: "ls", commandId: "c1" })).ok,
    ).toBe(false);
    const parsed = parseBrokerRequest(
      envelope("exec", { jobId: "j", command: "ls", commandId: "c1", voucher: "v" }),
    );
    expect(parsed.ok).toBe(true);
  });

  it("accepts an EMPTY command string but not a non-string", () => {
    expect(
      parseBrokerRequest(
        envelope("exec", { jobId: "j", command: "", commandId: "c", voucher: "v" }),
      ).ok,
    ).toBe(true);
    expect(
      parseBrokerRequest(
        envelope("exec", { jobId: "j", command: 42, commandId: "c", voucher: "v" }),
      ).ok,
    ).toBe(false);
  });

  it("never coerces a wrong-typed optional flag", () => {
    const parsed = parseBrokerRequest(
      envelope("closeJob", { jobId: "j", removeWorkspace: "yes" }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("requires a non-negative integer idleMs on sweep", () => {
    expect(parseBrokerRequest(envelope("sweep", { idleMs: -1 })).ok).toBe(false);
    expect(parseBrokerRequest(envelope("sweep", { idleMs: 1.5 })).ok).toBe(false);
    expect(parseBrokerRequest(envelope("sweep", { idleMs: 0 })).ok).toBe(true);
  });

  it("omits absent optionals rather than materializing undefined keys", () => {
    const parsed = parseBrokerRequest(envelope("closeJob", { jobId: "j" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.request.payload)).toEqual(["jobId"]);
  });
});

describe("broker → worker payloads", () => {
  it("parses a full runCommand spec", () => {
    const parsed = parseWorkerRequest(envelope("runCommand", { commandId: "c", spec: SPEC }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.request.op !== "runCommand") return;
    expect(parsed.request.payload.spec).toEqual(SPEC);
  });

  it("refuses a spec whose egress union is malformed", () => {
    for (const egress of [
      { kind: "gateway" },
      { kind: "gateway", mode: "wide-open", network: "n", jobToken: "t", gateway: { host: "h", port: 1 } },
      { kind: "gateway", mode: "allowlist", network: "n", jobToken: "t" },
      { kind: "elsewhere" },
    ]) {
      const parsed = parseWorkerRequest(
        envelope("runCommand", { commandId: "c", spec: { ...SPEC, egress } }),
      );
      expect(parsed.ok, JSON.stringify(egress)).toBe(false);
    }
  });

  it("accepts the network-less `none` egress kind", () => {
    const parsed = parseWorkerRequest(
      envelope("runCommand", { commandId: "c", spec: { ...SPEC, egress: { kind: "none" } } }),
    );
    expect(parsed.ok).toBe(true);
  });

  it("refuses a spec with an incomplete or negative limits block", () => {
    const partial: Partial<typeof SPEC.limits> = { ...SPEC.limits };
    delete partial.workspaceQuotaKb;
    expect(
      parseWorkerRequest(envelope("runCommand", { commandId: "c", spec: { ...SPEC, limits: partial } })).ok,
    ).toBe(false);
    expect(
      parseWorkerRequest(
        envelope("runCommand", {
          commandId: "c",
          spec: { ...SPEC, limits: { ...SPEC.limits, memoryMb: -1 } },
        }),
      ).ok,
    ).toBe(false);
  });

  it("requires the volume name on both removal ops", () => {
    expect(parseWorkerRequest(envelope("removeWorkspace", {})).ok).toBe(false);
    expect(parseWorkerRequest(envelope("removeSkills", {})).ok).toBe(false);
    expect(parseWorkerRequest(envelope("removeSkills", { volumeName: "v" })).ok).toBe(true);
  });
});

describe("JSON-serializable doctrine", () => {
  const requests: unknown[] = [
    execRequestEnvelope("openJob", {
      carrier: "c",
      stagedSkills: [{ slug: "s", files: [{ path: "p", content: "c", digest: "d" }] }],
      environment: { imageRef: "r", provenance: { alg: "hmac", signature: "sig" } },
    }),
    execRequestEnvelope("exec", { jobId: "j", command: "ls -la", commandId: "c", voucher: "v" }),
    execRequestEnvelope("closeJob", { jobId: "j", removeWorkspace: true }),
    execRequestEnvelope("terminateJobsForRun", { runId: "r", removeWorkspace: false }),
    execRequestEnvelope("sweep", { idleMs: 900_000 }),
    execRequestEnvelope("drainAudit", { maxAuditRecords: 10, maxStdioEntries: 5 }),
    execRequestEnvelope("health", {}),
    execRequestEnvelope("runCommand", { commandId: "c", spec: SPEC }),
    execRequestEnvelope("ensureWorkspace", { workspaceKey: "run-1" }),
    execRequestEnvelope("removeWorkspace", { volumeName: "v" }),
    execRequestEnvelope("stageSkills", {
      jobId: "j",
      imageRef: "r",
      skills: [{ slug: "s", files: [{ path: "p", content: "c", digest: "d" }] }],
    }),
    execRequestEnvelope("removeSkills", { volumeName: "v" }),
  ];

  it("round-trips every request through JSON unchanged", () => {
    for (const request of requests) {
      expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    }
  });

  it("round-trips every request through the strict parsers after JSON transit", () => {
    for (const request of requests) {
      const transited = JSON.parse(JSON.stringify(request)) as { op: string };
      const parsed = BROKER_OPS.includes(transited.op as never)
        ? parseBrokerRequest(transited)
        : parseWorkerRequest(transited);
      expect(parsed.ok, transited.op).toBe(true);
    }
  });

  it("stamps the version on both response shapes", () => {
    expect(execOkResponse({ closed: true }).protocolVersion).toBe(V);
    const error = execErrorResponse("unauthorized_token", "no");
    expect(error.protocolVersion).toBe(V);
    expect(error.ok).toBe(false);
    expect(JSON.parse(JSON.stringify(error))).toEqual(error);
  });
});
