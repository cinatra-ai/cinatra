// Unit tests for the boot-only broker construction seams (exec-plane S1b
// activation, cinatra#2138 deliverables 3 + 4; AC3).
//
// The three host-owned seams the merged packages left injectable — the audit
// sink, the run-liveness probe and the egress policy — plus the handshake that
// AC3 makes the sole gate on `ready`.

import { generateKeyPairSync } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logAuditEvent: vi.fn(async (_input: unknown) => {}),
  readAgentRunById: vi.fn(async (_id: string) => null as unknown),
  readAgentTemplateById: vi.fn(async (_id: string) => null as unknown),
}));
const { logAuditEvent, readAgentRunById } = mocks;

vi.mock("@/lib/authz/audit", () => ({ logAuditEvent: mocks.logAuditEvent }));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: mocks.readAgentRunById,
  readAgentTemplateById: mocks.readAgentTemplateById,
}));

import {
  BOOT_HANDSHAKE_ACTOR_ID,
  BOOT_HANDSHAKE_ORG_ID,
  createExecutionAuditSink,
  createRunLivenessProbe,
  createVoucherMintAuditSink,
  egressPolicyFromSettings,
  resolveBrokerIdentity,
  resolveDeploymentEgressMaximum,
  resolveVoucherKeyMaterial,
  runBrokerHandshake,
} from "@/lib/execution/execution-broker-construct";
import {
  DEFAULT_SANDBOX_LIMITS,
  type CommandVoucherMinter,
  type ExecutionAuditRecord,
} from "@cinatra-ai/execution-plane";
import {
  createCommandVoucherMinter,
  createEd25519VoucherSigner,
  DEFAULT_BROKER_IDENTITY_URI,
} from "@/lib/execution/execution-voucher-mint";

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

/**
 * The handshake now mints a REAL per-command voucher (the boot self-check goes
 * through the same authorization boundary a tenant's command does), so these
 * tests build the real minter over a real Ed25519 key — no stubbed crypto. The
 * fake broker ignores the token; what matters here is that the handshake asks
 * for one, refuses to proceed without it, and still reports every pre-existing
 * failure mode verbatim.
 */
function handshakeMinter(
  over: Partial<Parameters<typeof createCommandVoucherMinter>[0]> = {},
): CommandVoucherMinter {
  return createCommandVoucherMinter({
    aud: "urn:cinatra:execution-broker:test",
    signer: createEd25519VoucherSigner(generateKeyPairSync("ed25519").privateKey),
    livenessProbe: async () => "alive",
    readRun: async () => null,
    readTemplate: async () => null,
    resolveEgressPolicy: () => ({ mode: "none" }),
    audit: () => {},
    carrierSecret: "handshake-secret",
    ...over,
  });
}

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
    const result = await runBrokerHandshake(broker, handshakeMinter());
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
    await runBrokerHandshake(spy, handshakeMinter());
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
    await expect(runBrokerHandshake(broker, handshakeMinter())).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("carrier_expired"),
    });
  });

  it("fails when the command is refused", async () => {
    const { broker } = fakeBroker({ execOk: false });
    await expect(runBrokerHandshake(broker, handshakeMinter())).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("worker_error"),
    });
  });

  it("fails on a non-zero exit — a live daemon is not a live WORKER", async () => {
    const { broker, closed } = fakeBroker({ result: { exitCode: 127 } });
    await expect(runBrokerHandshake(broker, handshakeMinter())).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("exit=127"),
    });
    expect(closed).toEqual(["job-boot"]);
  });

  it("fails on a timeout termination", async () => {
    const { broker } = fakeBroker({ result: { termination: "timeout", exitCode: null } });
    await expect(runBrokerHandshake(broker, handshakeMinter())).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("termination=timeout"),
    });
  });

  it("fails when the sandbox is not the expected one (wrong output)", async () => {
    const { broker } = fakeBroker({ result: { stdout: "something else" } });
    await expect(runBrokerHandshake(broker, handshakeMinter())).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("unexpected output"),
    });
  });

  it("fails closed when no broker secret is configured (no unsigned carrier)", async () => {
    delete process.env.EXECUTION_BROKER_SECRET;
    const { broker } = fakeBroker({});
    await expect(runBrokerHandshake(broker, handshakeMinter())).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("cannot seal"),
    });
  });
});

describe("the per-command authorization boundary — host-side seams (epic #1705)", () => {
  it("names the broker from its own scoped env, falling back to the local-dev URI", () => {
    expect(resolveBrokerIdentity({})).toBe(DEFAULT_BROKER_IDENTITY_URI);
    expect(resolveBrokerIdentity({ EXECUTION_BROKER_IDENTITY_URI: "  spiffe://x  " })).toBe(
      "spiffe://x",
    );
  });

  it("uses a CONFIGURED signing key and derives the broker's verify half from it", () => {
    const pem = generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const material = resolveVoucherKeyMaterial({ EXECUTION_VOUCHER_SIGNING_KEY: pem });
    expect(material.ephemeral).toBe(false);
    // The verify half is DERIVED, so the pair can never be mismatched.
    expect(material.signer.publicKey.type).toBe("public");
    expect(material.signer.publicKey.asymmetricKeyType).toBe("ed25519");
  });

  it("generates an EPHEMERAL keypair when none is configured (in-process local-dev only)", () => {
    const material = resolveVoucherKeyMaterial({});
    expect(material.ephemeral).toBe(true);
    expect(material.signer.publicKey.asymmetricKeyType).toBe("ed25519");
  });

  it("refuses to arm on unusable signing key material rather than coming up unauthorized", () => {
    expect(() =>
      resolveVoucherKeyMaterial({ EXECUTION_VOUCHER_SIGNING_KEY: "-----BEGIN NONSENSE-----" }),
    ).toThrow();
  });

  it("reads the DEPLOYMENT egress ceiling from the env, and hard-fails a typo'd mode", () => {
    // Absent entirely ⇒ no ceiling (the signed policy stands).
    expect(resolveDeploymentEgressMaximum({})).toEqual({ ok: true });
    expect(
      resolveDeploymentEgressMaximum({
        EXECUTION_EGRESS_MAX_MODE: "allowlist",
        EXECUTION_EGRESS_MAX_ALLOWLIST: "pypi.org, files.pypi.org",
        EXECUTION_EGRESS_MAX_BYTES_PER_JOB: "1024",
      }),
    ).toEqual({
      ok: true,
      maximum: { mode: "allowlist", allowlist: ["pypi.org", "files.pypi.org"], maxBytesPerJob: 1024 },
    });
    // A typo must be LOUD: guessing either widens the ceiling or invents an outage.
    expect(resolveDeploymentEgressMaximum({ EXECUTION_EGRESS_MAX_MODE: "allowlst" })).toMatchObject({
      ok: false,
    });
    expect(
      resolveDeploymentEgressMaximum({ EXECUTION_EGRESS_MAX_BYTES_PER_JOB: "-1" }),
    ).toMatchObject({ ok: false });
    // A ceiling given as hosts only still implies a bound.
    expect(
      resolveDeploymentEgressMaximum({ EXECUTION_EGRESS_MAX_ALLOWLIST: "pypi.org" }),
    ).toMatchObject({ ok: true, maximum: { allowlist: ["pypi.org"] } });
  });

  it("audits a mint DENIAL as a denied authz row — it never reaches the broker to be audited there", async () => {
    await createVoucherMintAuditSink()({
      decision: "denied",
      denial: "obo_ceiling_mismatch",
      detail: "chain does not contain the re-derived chain",
      orgId: "org-1",
      userId: "user-1",
      surface: "agent_run",
      runId: "run-1",
      jobId: "job-1",
      commandId: "cmd-1",
    });
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    expect(logAuditEvent.mock.calls[0][0]).toMatchObject({
      organizationId: "org-1",
      actorPrincipalType: "model",
      resourceType: "execution_command_voucher",
      operation: "sandbox_authorize",
      decision: "denied",
      runId: "run-1",
      metadata: { denial: "obo_ceiling_mismatch", commandId: "cmd-1" },
    });
  });

  it("audits a successful mint as an ALLOWED row — `the ceiling was checked` is evidence, not a claim", async () => {
    await createVoucherMintAuditSink()({
      decision: "minted",
      detail: "authorized",
      orgId: "org-1",
      userId: "user-1",
      surface: "agent_run",
      jobId: "job-1",
      commandId: "cmd-1",
      livenessDegraded: true,
    });
    expect(logAuditEvent.mock.calls[0][0]).toMatchObject({
      decision: "allowed",
      metadata: { livenessDegraded: true },
    });
  });

  it("never lets the mint audit transport escape into the decision path", async () => {
    logAuditEvent.mockRejectedValueOnce(new Error("pg down"));
    await expect(
      createVoucherMintAuditSink()({
        decision: "denied",
        denial: "run_removed",
        detail: "gone",
        orgId: "org-1",
        userId: "user-1",
        surface: "agent_run",
        jobId: "job-1",
        commandId: "cmd-1",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("AC3 — the boot handshake goes THROUGH the authorization boundary", () => {
  it("fails when the plane cannot authorize the handshake command", async () => {
    const { broker } = fakeBroker({});
    // A mint that denies (here: the carrier secret does not match) must stop the
    // handshake — a plane that cannot authorize a command must not report ready.
    const result = await runBrokerHandshake(
      broker,
      handshakeMinter({ carrierSecret: "a-different-secret" }),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("could not authorize the handshake command"),
    });
  });

  it("asks for a voucher bound to the handshake job + command, and submits it", async () => {
    const seen: Array<{ jobId: string; command: string; commandId: string }> = [];
    const { broker } = fakeBroker({});
    const submitted: string[] = [];
    const spy = {
      ...broker,
      exec: async (_jobId: string, _command: string, voucher: string) => {
        submitted.push(voucher);
        return {
          ok: true,
          result: {
            exitCode: 0,
            stdout: "cinatra-exec-handshake",
            stderr: "",
            termination: "exited",
            imageDigest: "sha256:l0",
            wallMs: 11,
          },
        };
      },
    } as unknown as FakeBroker;
    const minter = handshakeMinter();
    const wrapped: CommandVoucherMinter = async (input) => {
      seen.push({ jobId: input.jobId, command: input.command, commandId: input.commandId });
      return minter(input);
    };
    await expect(runBrokerHandshake(spy, wrapped)).resolves.toMatchObject({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ jobId: "job-boot", command: "printf cinatra-exec-handshake" });
    expect(seen[0].commandId.startsWith("boot-handshake-")).toBe(true);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].startsWith("v1.")).toBe(true);
  });
});
