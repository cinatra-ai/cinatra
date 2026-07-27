// Unit tests for the boot-only broker construction seams (exec-plane S1b
// activation, cinatra#2138 deliverables 3 + 4; AC3).
//
// The three host-owned seams the merged packages left injectable — the audit
// sink, the run-liveness probe and the egress policy — plus the handshake that
// AC3 makes the sole gate on `ready`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logAuditEvent: vi.fn(async (_input: unknown) => {}),
  readAgentRunById: vi.fn(async (_id: string) => null as unknown),
}));
const { logAuditEvent, readAgentRunById } = mocks;

vi.mock("@/lib/authz/audit", () => ({ logAuditEvent: mocks.logAuditEvent }));
vi.mock("@cinatra-ai/agents", () => ({ readAgentRunById: mocks.readAgentRunById }));

import {
  BOOT_HANDSHAKE_ACTOR_ID,
  BOOT_HANDSHAKE_ORG_ID,
  createExecutionAuditSink,
  createRunLivenessProbe,
  egressPolicyFromSettings,
  runBrokerHandshake,
} from "@/lib/execution/execution-broker-construct";
import { DEFAULT_SANDBOX_LIMITS, type ExecutionAuditRecord } from "@cinatra-ai/execution-plane";

const RECORD: ExecutionAuditRecord = {
  jobId: "job-1",
  orgId: "org-1",
  userId: "user-1",
  surface: "chat",
  command: "pip install pandas",
  cwd: "/workspace",
  decision: "executed",
  exitCode: 0,
  termination: "exited",
  imageDigest: "sha256:abc",
  effectivePolicy: { egressMode: "default_internet", limits: DEFAULT_SANDBOX_LIMITS },
  atMs: 1,
};

let priorSecret: string | undefined;

beforeEach(() => {
  logAuditEvent.mockClear();
  readAgentRunById.mockClear();
  priorSecret = process.env.EXECUTION_BROKER_SECRET;
  process.env.EXECUTION_BROKER_SECRET = "handshake-secret";
});

afterEach(() => {
  if (priorSecret === undefined) delete process.env.EXECUTION_BROKER_SECRET;
  else process.env.EXECUTION_BROKER_SECRET = priorSecret;
});

describe("egress policy projection (deliverable 4)", () => {
  it("maps the three admin tiers onto the merged gateway vocabulary", () => {
    expect(
      egressPolicyFromSettings({ mode: "local-dev", egressMode: "none", egressAllowlist: ["x"] }),
    ).toEqual({ mode: "none" });
    expect(
      egressPolicyFromSettings({
        mode: "local-dev",
        egressMode: "allowlist",
        egressAllowlist: ["pypi.org"],
      }),
    ).toEqual({ mode: "allowlist", allowlist: ["pypi.org"] });
    expect(
      egressPolicyFromSettings({
        mode: "local-dev",
        egressMode: "default_internet",
        egressAllowlist: [],
      }),
    ).toEqual({ mode: "default_internet" });
  });
});

describe("audit sink (deliverable 3)", () => {
  it("writes ONE authz-kernel row per broker record, without the command", async () => {
    await createExecutionAuditSink()(RECORD);
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    const input = logAuditEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({
      organizationId: "org-1",
      actorPrincipalType: "model",
      resourceType: "execution_sandbox",
      operation: "sandbox_execute",
      decision: "allowed",
    });
    expect(JSON.stringify(input)).not.toContain("pip install pandas");
  });

  it("never lets an audit-transport failure escape into the model loop", async () => {
    logAuditEvent.mockRejectedValueOnce(new Error("pg down"));
    await expect(createExecutionAuditSink()(RECORD)).resolves.toBeUndefined();
  });
});

describe("run-liveness probe", () => {
  it("answers alive for a session with no run binding (chat / deterministic tasks)", async () => {
    await expect(
      createRunLivenessProbe()({ orgId: "o", userId: "u", surface: "chat" }),
    ).resolves.toBe("alive");
    expect(readAgentRunById).not.toHaveBeenCalled();
  });

  it("answers gone when the bound run row was hard-removed", async () => {
    readAgentRunById.mockResolvedValueOnce(null);
    await expect(
      createRunLivenessProbe()({ orgId: "o", userId: "u", surface: "agent_run", runId: "run-9" }),
    ).resolves.toBe("gone");
    expect(readAgentRunById).toHaveBeenCalledWith("run-9");
  });

  it("answers alive while the run row exists", async () => {
    readAgentRunById.mockResolvedValueOnce({ id: "run-9", orgId: "o", runBy: "u" });
    await expect(
      createRunLivenessProbe()({ orgId: "o", userId: "u", surface: "agent_run", runId: "run-9" }),
    ).resolves.toBe("alive");
  });

  it("answers gone when the run row's ORG no longer matches the sealed session", async () => {
    readAgentRunById.mockResolvedValueOnce({ id: "run-9", orgId: "other-org", runBy: "u" });
    await expect(
      createRunLivenessProbe()({ orgId: "o", userId: "u", surface: "agent_run", runId: "run-9" }),
    ).resolves.toBe("gone");
  });

  it("answers gone when the run row's OWNER no longer matches the sealed session", async () => {
    readAgentRunById.mockResolvedValueOnce({ id: "run-9", orgId: "o", runBy: "someone-else" });
    await expect(
      createRunLivenessProbe()({ orgId: "o", userId: "u", surface: "agent_run", runId: "run-9" }),
    ).resolves.toBe("gone");
  });

  it("does not kill live jobs on a transient store failure", async () => {
    readAgentRunById.mockRejectedValueOnce(new Error("pg down"));
    await expect(
      createRunLivenessProbe()({ orgId: "o", userId: "u", surface: "agent_run", runId: "run-9" }),
    ).resolves.toBe("alive");
  });
});

type FakeBroker = Parameters<typeof runBrokerHandshake>[0];

function fakeBroker(exec: {
  open?: { ok: boolean; reason?: string; message?: string; jobId?: string };
  result?: Partial<{
    exitCode: number | null;
    stdout: string;
    termination: string;
    imageDigest: string;
    wallMs: number;
  }>;
  execOk?: boolean;
}): { broker: FakeBroker; closed: string[] } {
  const closed: string[] = [];
  const broker = {
    openJob: async () => exec.open ?? { ok: true, jobId: "job-boot" },
    exec: async () =>
      exec.execOk === false
        ? { ok: false, reason: "worker_error", message: "docker missing" }
        : {
            ok: true,
            result: {
              exitCode: 0,
              stdout: "cinatra-exec-handshake",
              stderr: "",
              termination: "exited",
              imageDigest: "sha256:l0",
              wallMs: 11,
              ...exec.result,
            },
          },
    closeJob: async (jobId: string) => {
      closed.push(jobId);
    },
  } as unknown as FakeBroker;
  return { broker, closed };
}

describe("AC3 — the broker↔worker health handshake", () => {
  it("completes on exit 0 + the expected stdout from a live worker, then closes the job", async () => {
    const { broker, closed } = fakeBroker({});
    const result = await runBrokerHandshake(broker);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.imageDigest).toBe("sha256:l0");
      expect(result.value.wallMs).toBe(11);
    }
    expect(closed).toEqual(["job-boot"]);
  });

  it("mints its session under the reserved non-tenant identity", async () => {
    let seen = "";
    const { broker } = fakeBroker({});
    const spy = {
      ...broker,
      openJob: async (carrier: string) => {
        seen = carrier;
        return { ok: true as const, jobId: "job-boot" };
      },
    } as unknown as FakeBroker;
    await runBrokerHandshake(spy);
    const payload = JSON.parse(
      Buffer.from(seen.split(".")[1], "base64url").toString("utf8"),
    ) as { orgId: string; userId: string };
    expect(payload.orgId).toBe(BOOT_HANDSHAKE_ORG_ID);
    expect(payload.userId).toBe(BOOT_HANDSHAKE_ACTOR_ID);
  });

  it("fails when the job cannot be opened", async () => {
    const { broker } = fakeBroker({
      open: { ok: false, reason: "carrier_expired", message: "stale" },
    });
    await expect(runBrokerHandshake(broker)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("carrier_expired"),
    });
  });

  it("fails when the command is refused", async () => {
    const { broker } = fakeBroker({ execOk: false });
    await expect(runBrokerHandshake(broker)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("worker_error"),
    });
  });

  it("fails on a non-zero exit — a live daemon is not a live WORKER", async () => {
    const { broker, closed } = fakeBroker({ result: { exitCode: 127 } });
    await expect(runBrokerHandshake(broker)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("exit=127"),
    });
    expect(closed).toEqual(["job-boot"]);
  });

  it("fails on a timeout termination", async () => {
    const { broker } = fakeBroker({ result: { termination: "timeout", exitCode: null } });
    await expect(runBrokerHandshake(broker)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("termination=timeout"),
    });
  });

  it("fails when the sandbox is not the expected one (wrong output)", async () => {
    const { broker } = fakeBroker({ result: { stdout: "something else" } });
    await expect(runBrokerHandshake(broker)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("unexpected output"),
    });
  });

  it("fails closed when no broker secret is configured (no unsigned carrier)", async () => {
    delete process.env.EXECUTION_BROKER_SECRET;
    const { broker } = fakeBroker({});
    await expect(runBrokerHandshake(broker)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("cannot seal"),
    });
  });
});
