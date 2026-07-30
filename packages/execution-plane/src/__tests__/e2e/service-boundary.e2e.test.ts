/**
 * SERVICE-BOUNDARY E2E BATTERY (exec-plane L5, epic cinatra#1705).
 *
 * The managed placement, end to end, against the topology that actually ships:
 * `docker-compose.exec.yml` up, three real containers, real mutual TLS on both
 * hops, a real host-exclusivity lease FILE on a real bind mount, real hardened
 * sandbox containers, real volumes and real internet egress through the
 * attributing gateway.
 *
 * NOTHING IN THIS BATTERY IS STUBBED, and that is the whole design. A stubbed
 * handshake proves the shape of a certificate, not that OpenSSL accepts it. A
 * fabricated lease proves the parser, not that the broker reads the file the
 * provisioning script wrote through a bind mount that gets its inode replaced
 * under it. An in-process broker proves the class, not that the deployed image
 * can construct one. Every one of those gaps has a real failure hiding in it,
 * and each is exactly the failure a green stub-run would have certified as
 * working. So: `beforeAll` builds images and brings the stack up, and it FAILS —
 * never skips — when docker is unavailable. A green run always means the real
 * thing ran.
 *
 * Run with: pnpm --filter @cinatra-ai/execution-plane test:e2e
 * Deliberately NOT part of the default `pnpm test` run — same economics as the
 * pre-existing `docker-battery.e2e.test.ts`, which this battery sits beside
 * rather than duplicates: that one proves the SANDBOX contract in-process, this
 * one proves the SERVICE BOUNDARY between the app, the broker and the worker.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  mintExecutionSession,
  sealExecutionSession,
} from "@cinatra-ai/llm/execution-plane";

import { commandDigest } from "../../authz/voucher";
import { BrokerServiceClient } from "../../service/broker-client";
import { containerNamePrefixFor } from "../../l0-profile";
import type { ExecResult, ExecutionAuditRecord } from "../../types";
import {
  mintVoucher,
  rawExecRpc,
  refusalCode,
  workerRpcFromInternalNetwork,
  type RawRpcResult,
  type VoucherInput,
} from "./support/exec-rpc";
import { issueExecLeaf } from "./support/throwaway-pki";
import {
  BROKER_HOST_PORT,
  BROKER_SERVICE,
  GATEWAY_SERVICE,
  L0_IMAGE,
  WORKER_SERVICE,
  bringUpExecStack,
  docker,
  type ExecStack,
} from "./support/exec-stack";

const INSTANCE = "l5e2e";
const TENANT = "l5-tenant";
const ORG = "org-l5";
const USER = "user-l5";
const SURFACE = "agent_run";

/** Deployment ceiling for the clamp arm — deliberately NARROWER than any mint. */
const DEPLOYMENT_MAX_ALLOWLIST = ["pypi.org", "files.pythonhosted.org"];
const DEPLOYMENT_MAX_BYTES = 256 * 1024;

let stack: ExecStack;
let app: BrokerServiceClient;

beforeAll(async () => {
  stack = await bringUpExecStack({
    instance: INSTANCE,
    tenant: TENANT,
    // The GATEWAY's default tier. Per-job policy still arrives on the
    // authenticated control channel at dispatch, which is what the clamp arm
    // actually measures.
    egressMode: "allowlist",
    egressAllowlist: DEPLOYMENT_MAX_ALLOWLIST,
    deploymentMaxMode: "allowlist",
    deploymentMaxAllowlist: DEPLOYMENT_MAX_ALLOWLIST,
    deploymentMaxBytesPerJob: DEPLOYMENT_MAX_BYTES,
    // Short enough that a renewal is observable inside one test.
    leaseRenewMs: 3_000,
  });
  const leaf = stack.leaf("app-client");
  app = new BrokerServiceClient({
    baseUrl: stack.brokerUrl,
    instance: INSTANCE,
    serviceToken: stack.brokerToken,
    tls: { certPem: leaf.certPem, keyPem: leaf.keyPem, caPem: stack.ca.certPem },
    requestTimeoutMs: 180_000,
  });
}, 1_800_000);

afterAll(async () => {
  app?.close();
  if (stack) await stack.down();
}, 300_000);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function carrierFor(runId: string, orgId: string = ORG, userId: string = USER): string {
  return sealExecutionSession(
    mintExecutionSession({ orgId, userId, surface: SURFACE, runId }),
    { secret: stack.carrierSecret },
  );
}

/**
 * The session each open job was opened under.
 *
 * A voucher is bound to the JOB'S session — org, user, surface AND runId — so a
 * mint that guesses any of them is refused as `voucher_invalid`. Recording the
 * session at open, rather than restating it at every call site, is what keeps
 * this battery testing the broker instead of testing whether the test remembered
 * a runId (the first run failed several arms for exactly that reason, which is a
 * fixture bug wearing an authorization failure's clothes).
 */
const jobSessions = new Map<string, { orgId: string; userId: string; runId: string }>();

async function openJob(
  runId: string,
  orgId: string = ORG,
  userId: string = USER,
): Promise<string> {
  const opened = await app.openJob(carrierFor(runId, orgId, userId));
  if (!opened.ok) throw new Error(`openJob refused: ${opened.reason} — ${opened.message}`);
  jobSessions.set(opened.jobId, { orgId, userId, runId });
  return opened.jobId;
}

type ExecOverrides = Partial<Omit<VoucherInput, "jobId" | "command">>;

/** One authorized command over the real wire: mint for THIS job, then `exec`. */
function execCommand(
  jobId: string,
  command: string,
  overrides: ExecOverrides = {},
  opts: { commandId?: string; voucher?: string } = {},
): Promise<ExecResult> {
  const session = jobSessions.get(jobId);
  const voucher =
    opts.voucher ??
    mintVoucher(stack, {
      jobId,
      command,
      orgId: session?.orgId ?? ORG,
      userId: session?.userId ?? USER,
      surface: SURFACE,
      ...(session?.runId ? { runId: session.runId } : {}),
      ...overrides,
    });
  return app.exec(jobId, command, voucher, opts.commandId ? { commandId: opts.commandId } : {});
}

/** Pull every buffered audit record the remote broker holds. */
async function drainAudit(): Promise<ExecutionAuditRecord[]> {
  const drained = await app.drainAudit({});
  expect(drained.relayed).toBe(true);
  return drained.audit;
}

const rowsFor = (rows: ExecutionAuditRecord[], jobId: string): ExecutionAuditRecord[] =>
  rows.filter((row) => row.jobId === jobId);

/** A live, valid, same-tenant lease — the state every other arm starts from. */
function restoreHealthyLease(): void {
  stack.writeLease({ ttl_seconds: 3600 });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Assert a credential was refused BY THE HANDSHAKE — and not by an endpoint that
 * simply was not there.
 *
 * This distinction is not pedantry, it is the difference between a security
 * assertion and a decoration. A plain `expect(result.kind).toBe("transport")`
 * passes when the broker is dead, so every "wrong CA / expired / no certificate"
 * arm would go green against a topology that cannot serve anything at all — the
 * first run of this battery did exactly that, on a stack whose published port
 * never took effect. A connect-level failure is therefore a FAILURE of the arm.
 */
function expectHandshakeRefusal(result: RawRpcResult): void {
  expect(result.kind).toBe("transport");
  if (result.kind !== "transport") return;
  expect(
    /ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|ECONNRESET: connect/.test(result.error),
    `expected a TLS-level refusal, got a connect-level failure (the endpoint was not ` +
      `reachable at all, so this arm proved nothing): ${result.error}`,
  ).toBe(false);
}

// ===========================================================================
// 1. TRANSPORT — both hops, and every way in that must fail closed
// ===========================================================================

describe("1. transport: mutual TLS on both hops, fail-closed on every negative", () => {
  it("app-client -> broker: a correctly-issued leaf completes a real handshake", async () => {
    const health = await app.health();
    expect(health.protocolVersion).toBe(1);
    expect(health.atMs).toBeGreaterThan(0);
  });

  it("broker -> worker: the composed broker-client credential reaches the worker", async () => {
    // Not a separate probe: opening a job routes `ensureWorkspace` over the
    // broker->worker hop (EXEC_BROKER_VOLUME_OPS=worker-routed), so a job that
    // opens IS a completed broker-client -> worker-server handshake. The volume
    // it created is the receipt.
    const runId = `l5-hop-${randomUUID()}`;
    const jobId = await openJob(runId);
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    const volumes = await docker([
      "volume",
      "ls",
      "--quiet",
      "--filter",
      "label=ai.cinatra.execution-plane=l2",
    ]);
    expect(volumes.stdout.trim().length).toBeGreaterThan(0);
    await app.closeJob(jobId, { removeWorkspace: true });
  });

  const brokerRaw = (over: Partial<Parameters<typeof rawExecRpc>[0]>): Promise<RawRpcResult> =>
    rawExecRpc({
      host: "127.0.0.1",
      port: BROKER_HOST_PORT,
      ca: stack.ca.certPem,
      token: stack.brokerToken,
      op: "health",
      payload: {},
      ...over,
    });

  it("wrong CA: a leaf from a foreign issuer never completes the handshake", async () => {
    const leaf = issueExecLeaf(stack.foreignCa, INSTANCE, "app-client");
    expectHandshakeRefusal(await brokerRaw({ cert: leaf.certPem, key: leaf.keyPem }));
  });

  it("expired client certificate: refused at TLS, before any handler runs", async () => {
    const leaf = stack.leaf("app-client", { expired: true });
    expectHandshakeRefusal(await brokerRaw({ cert: leaf.certPem, key: leaf.keyPem }));
  });

  it("right CA, wrong role SAN: chain verifies, identity does not — 403", async () => {
    // A perfectly valid `broker-client` leaf from the SAME PKI. The chain is
    // fine; the endpoint accepts exactly `app-client`, byte-exact.
    const leaf = stack.leaf("broker-client");
    const result = await brokerRaw({ cert: leaf.certPem, key: leaf.keyPem });
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.status).toBe(403);
    expect(refusalCode(result)).toBe("unauthorized_peer");
  });

  it("two URI SANs: an ambiguous multi-role credential is refused", async () => {
    const leaf = stack.leaf("app-client", {
      uriSans: [
        `cinatra-exec://${INSTANCE}/app-client`,
        `cinatra-exec://${INSTANCE}/worker-server`,
      ],
    });
    const result = await brokerRaw({ cert: leaf.certPem, key: leaf.keyPem });
    expect(refusalCode(result)).toBe("unauthorized_peer");
  });

  it("no extendedKeyUsage: an unrestricted credential is refused", async () => {
    const leaf = stack.leaf("app-client", { ekus: [] });
    expect(refusalCode(await brokerRaw({ cert: leaf.certPem, key: leaf.keyPem }))).toBe(
      "unauthorized_peer",
    );
  });

  it("no client certificate at all: refused at TLS", async () => {
    expectHandshakeRefusal(await brokerRaw({}));
  });

  it("valid certificate + wrong service token: 401, the second factor stands alone", async () => {
    const leaf = stack.leaf("app-client");
    const result = await brokerRaw({
      cert: leaf.certPem,
      key: leaf.keyPem,
      token: "not-the-service-token",
    });
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.status).toBe(401);
    expect(refusalCode(result)).toBe("unauthorized_token");
  });

  it("valid certificate + NO token header: 401 (absent is not a pass)", async () => {
    const leaf = stack.leaf("app-client");
    const result = await brokerRaw({ cert: leaf.certPem, key: leaf.keyPem, token: undefined });
    expect(refusalCode(result)).toBe("unauthorized_token");
  });

  it("valid token + no client certificate: refused at TLS (neither factor substitutes)", async () => {
    expectHandshakeRefusal(await brokerRaw({ token: stack.brokerToken }));
  });

  it("protocol-version mismatch in the BODY: 400, refused not coerced", async () => {
    const leaf = stack.leaf("app-client");
    const result = await brokerRaw({
      cert: leaf.certPem,
      key: leaf.keyPem,
      protocolVersion: 2,
      protocolHeader: "2",
    });
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.status).toBe(400);
    expect(refusalCode(result)).toBe("protocol_version_mismatch");
  });

  it("protocol-version mismatch in the HEADER alone: still refused", async () => {
    const leaf = stack.leaf("app-client");
    const result = await brokerRaw({
      cert: leaf.certPem,
      key: leaf.keyPem,
      protocolVersion: 1,
      protocolHeader: "2",
    });
    expect(refusalCode(result)).toBe("protocol_version_mismatch");
  });

  it("an unauthorized peer cannot map the surface: same 403 on every route", async () => {
    const leaf = stack.leaf("broker-client");
    const onRpc = await brokerRaw({ cert: leaf.certPem, key: leaf.keyPem });
    const onNonsense = await brokerRaw({
      cert: leaf.certPem,
      key: leaf.keyPem,
      routePath: "/does-not-exist",
    });
    const onGet = await brokerRaw({ cert: leaf.certPem, key: leaf.keyPem, method: "GET" });
    expect(refusalCode(onRpc)).toBe("unauthorized_peer");
    expect(refusalCode(onNonsense)).toBe("unauthorized_peer");
    expect(refusalCode(onGet)).toBe("unauthorized_peer");
  });

  it("worker endpoint: an app-client leaf is refused — the app never reaches a worker", async () => {
    const leaf = stack.leaf("app-client");
    const result = await workerRpcFromInternalNetwork(stack, {
      cert: leaf.certPem,
      key: leaf.keyPem,
      token: stack.workerToken,
      op: "removeWorkspace",
      payload: { volumeName: "cinatra-exec-ws-nope" },
    });
    expect(refusalCode(result)).toBe("unauthorized_peer");
  });

  it("worker endpoint: a broker-client leaf with the WRONG token is refused", async () => {
    const leaf = stack.leaf("broker-client");
    const result = await workerRpcFromInternalNetwork(stack, {
      cert: leaf.certPem,
      key: leaf.keyPem,
      token: "not-the-worker-token",
      op: "removeWorkspace",
      payload: { volumeName: "cinatra-exec-ws-nope" },
    });
    expect(refusalCode(result)).toBe("unauthorized_token");
  });

  it("worker endpoint: protocol-version mismatch is refused there too", async () => {
    const leaf = stack.leaf("broker-client");
    const result = await workerRpcFromInternalNetwork(stack, {
      cert: leaf.certPem,
      key: leaf.keyPem,
      token: stack.workerToken,
      protocolVersion: 99,
      op: "removeWorkspace",
      payload: { volumeName: "cinatra-exec-ws-nope" },
    });
    expect(refusalCode(result)).toBe("protocol_version_mismatch");
  });
});

// ===========================================================================
// 2. ROUND TRIP
// ===========================================================================

describe("2. round trip: openJob -> exec -> stdout -> closeJob, across the wire", () => {
  it("runs a command, persists the workspace across commands, and audits the digest that ran", async () => {
    await drainAudit(); // start from a known-empty relay
    const runId = `l5-trip-${randomUUID()}`;
    const jobId = await openJob(runId);

    const first = await execCommand(jobId, "echo hello-across-the-wire > note.txt; cat note.txt");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.result.exitCode).toBe(0);
    expect(first.result.stdout.trim()).toBe("hello-across-the-wire");
    expect(first.result.termination).toBe("exited");

    // A SECOND command on the same runId proves the L2 workspace survived the
    // first container's teardown — fresh container, same volume.
    const second = await execCommand(jobId, "cat note.txt");
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.result.stdout.trim()).toBe("hello-across-the-wire");

    // The digest on the audit record is the digest that ACTUALLY ran: compare
    // against what the daemon reports for the image the worker was configured
    // with, not against a constant this test made up.
    const inspected = await docker([
      "image",
      "inspect",
      "--format",
      "{{.Id}} {{range .RepoDigests}}{{.}} {{end}}",
      L0_IMAGE,
    ]);
    expect(inspected.exitCode).toBe(0);
    // Every sha256 the daemon knows this image by. Comparing the recorded HEX
    // against that set — rather than against one reference form — is what makes
    // this an independent check instead of a restatement of the worker's own
    // `{{if .RepoDigests}}…{{else}}{{.Id}}{{end}}` template.
    const daemonHexes = new Set(
      [...inspected.stdout.matchAll(/sha256:([0-9a-f]{64})/g)].map((m) => m[1] as string),
    );
    expect(daemonHexes.size).toBeGreaterThan(0);
    const rows = rowsFor(await drainAudit(), jobId);
    const executed = rows.filter((row) => row.decision === "executed");
    expect(executed).toHaveLength(2);
    for (const row of executed) {
      const recorded = /sha256:([0-9a-f]{64})/.exec(row.imageDigest ?? "");
      expect(recorded, `audit row carries no sha256 digest: ${String(row.imageDigest)}`).not.toBeNull();
      expect(daemonHexes.has(recorded?.[1] as string)).toBe(true);
      expect(row.orgId).toBe(ORG);
      expect(row.runId).toBe(runId);
    }

    await app.closeJob(jobId, { removeWorkspace: true });
  }, 300_000);
});

// ===========================================================================
// 3. HOST-EXCLUSIVITY LEASE — a real FILE on a real bind mount
// ===========================================================================

describe("3. host-exclusivity lease: a real file, read by path on every placement", () => {
  afterAll(() => restoreHealthyLease());

  it("admits under a valid, same-tenant lease", async () => {
    restoreHealthyLease();
    const jobId = await openJob(`l5-lease-ok-${randomUUID()}`);
    const result = await execCommand(jobId, "echo leased");
    expect(result.ok).toBe(true);
    await app.closeJob(jobId, { removeWorkspace: true });
  }, 120_000);

  it("refuses when the lease is ABSENT", async () => {
    stack.removeLease();
    const opened = await app.openJob(carrierFor(`l5-lease-absent-${randomUUID()}`));
    expect(opened).toMatchObject({ ok: false, reason: "placement_refused" });
    restoreHealthyLease();
  });

  it("refuses when the lease has EXPIRED", async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    stack.writeLease({ acquired_at: past, ttl_seconds: 60, renewed_at: past });
    const opened = await app.openJob(carrierFor(`l5-lease-expired-${randomUUID()}`));
    expect(opened).toMatchObject({ ok: false, reason: "placement_refused" });
    restoreHealthyLease();
  });

  it("refuses when the lease names ANOTHER tenant", async () => {
    stack.writeLease({ tenant: "someone-else" });
    const opened = await app.openJob(carrierFor(`l5-lease-other-${randomUUID()}`));
    expect(opened).toMatchObject({ ok: false, reason: "placement_refused" });
    restoreHealthyLease();
  });

  it("refuses a lease that is not in the writer's canonical form", async () => {
    // Structurally valid JSON the writer would never emit. The greedy `sed` the
    // shell parses with and `JSON.parse` disagree about documents like this, so
    // anything but the canonical bytes is refused.
    const nowS = Math.floor(Date.now() / 1000);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      stack.leasePath,
      JSON.stringify({
        tenant: TENANT,
        acquired_at: nowS,
        ttl_seconds: 3600,
        renewed_at: nowS,
        extra: "not canonical",
      }) + "\n",
    );
    const opened = await app.openJob(carrierFor(`l5-lease-noncanon-${randomUUID()}`));
    expect(opened).toMatchObject({ ok: false, reason: "placement_refused" });
    restoreHealthyLease();
  });

  it("renewal rewrites acquired_at under the mkdir mutex, and survives a concurrent atomic mv", async () => {
    const started = Math.floor(Date.now() / 1000) - 300;
    stack.writeLease({ acquired_at: started, ttl_seconds: 3600, renewed_at: started });

    // Concurrent ops-style publishes while the broker's renewal timer runs. The
    // mutex is what keeps the two writers from interleaving a half-written
    // document; the atomic `mv` is what keeps a reader from ever seeing one.
    const deadline = Date.now() + 9_000;
    while (Date.now() < deadline) {
      stack.publishLeaseAtomically({ acquired_at: started, ttl_seconds: 3600 });
      const seen = stack.readLease();
      // Never a partial document: whatever a reader sees is a whole lease.
      expect(seen).not.toBeNull();
      expect(seen?.tenant).toBe(TENANT);
      await sleep(300);
    }

    // The renewal has to have moved `acquired_at` forward — the ONLY field the
    // writer's expiry math reads. A renewal that bumped `renewed_at` alone would
    // leave the lease reclaimable while our workers are live.
    await sleep(4_000);
    const renewed = stack.readLease();
    expect(renewed).not.toBeNull();
    expect(renewed?.acquired_at).toBeGreaterThan(started);
    expect(renewed?.renewed_at).toBeGreaterThanOrEqual(renewed?.acquired_at ?? 0);
    expect(renewed?.ttl_seconds).toBe(3600);

    // The mutex directory is RELEASED, not left wedged.
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    expect(existsSync(join(stack.leaseDir, ".host-exclusivity.lock.d"))).toBe(false);

    // And the plane still admits.
    const jobId = await openJob(`l5-lease-renewed-${randomUUID()}`);
    expect((await execCommand(jobId, "echo still-leased")).ok).toBe(true);
    await app.closeJob(jobId, { removeWorkspace: true });
  }, 180_000);

  it("a mid-job reclaim DRAINS: the in-flight container is gone and the command is not clean", async () => {
    restoreHealthyLease();
    await drainAudit();
    const runId = `l5-drain-${randomUUID()}`;
    const jobId = await openJob(runId);
    const prefix = containerNamePrefixFor(jobId);

    // A command long enough to still be running when the host is taken away.
    const inFlight = execCommand(jobId, "sleep 45; echo never-reached");

    // Wait for the real container to exist.
    let containerSeen = false;
    for (let attempt = 0; attempt < 120 && !containerSeen; attempt += 1) {
      const ps = await docker(["ps", "--format", "{{.Names}}", "--filter", `name=${prefix}`]);
      containerSeen = ps.stdout.trim().length > 0;
      if (!containerSeen) await sleep(500);
    }
    expect(containerSeen).toBe(true);

    // The provisioning side hands the host to somebody else.
    stack.writeLease({ tenant: "another-tenant" });

    // The next placement decision revalidates, refuses, and drains.
    const refused = await execCommand(jobId, "echo should-not-place");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(["placement_revoked", "job_terminated"]).toContain(refused.reason);
    }

    // The container that was mid-run is GONE — terminating a job is only a flag
    // flip; the drain is what removes what is already running.
    let stillThere = true;
    for (let attempt = 0; attempt < 60 && stillThere; attempt += 1) {
      const ps = await docker([
        "ps",
        "--all",
        "--format",
        "{{.Names}}",
        "--filter",
        `name=${prefix}`,
      ]);
      stillThere = ps.stdout.trim().length > 0;
      if (stillThere) await sleep(500);
    }
    expect(stillThere).toBe(false);

    // The interrupted command answers — it never hangs — and it never reports a
    // clean success, because it did not have one.
    const outcome = await inFlight;
    if (outcome.ok) {
      expect(outcome.result.stdout).not.toContain("never-reached");
    } else {
      expect(outcome.reason).toBeTruthy();
    }

    // And the interruption is on the audit trail: every command yields a row.
    const rows = rowsFor(await drainAudit(), jobId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((row) => row.decision === "refused")).toBe(true);
    expect(
      rows.every((row) => !(row.decision === "executed" && row.termination === "exited" && row.exitCode === 0)),
    ).toBe(true);

    restoreHealthyLease();
  }, 300_000);
});

// ===========================================================================
// 4. VOUCHER — the per-command authorization boundary, over the wire
// ===========================================================================

describe("4. voucher: every way an unauthorized command can be presented", () => {
  let jobId = "";
  let runId = "";

  beforeAll(async () => {
    restoreHealthyLease();
    runId = `l5-voucher-${randomUUID()}`;
    jobId = await openJob(runId);
  }, 120_000);

  afterAll(async () => {
    if (jobId) await app.closeJob(jobId, { removeWorkspace: true });
  });

  const base = () => ({ orgId: ORG, userId: USER, surface: SURFACE, runId });

  it("MISSING: the wire itself refuses an empty voucher", async () => {
    const leaf = stack.leaf("app-client");
    const result = await rawExecRpc({
      host: "127.0.0.1",
      port: BROKER_HOST_PORT,
      ca: stack.ca.certPem,
      cert: leaf.certPem,
      key: leaf.keyPem,
      token: stack.brokerToken,
      op: "exec",
      payload: { jobId, command: "echo x", commandId: randomUUID(), voucher: "" },
    });
    expect(refusalCode(result)).toBe("malformed_request");
  });

  it("MISSING: a payload with no voucher field at all is refused by the parser", async () => {
    const leaf = stack.leaf("app-client");
    const result = await rawExecRpc({
      host: "127.0.0.1",
      port: BROKER_HOST_PORT,
      ca: stack.ca.certPem,
      cert: leaf.certPem,
      key: leaf.keyPem,
      token: stack.brokerToken,
      op: "exec",
      payload: { jobId, command: "echo x", commandId: randomUUID() },
    });
    expect(refusalCode(result)).toBe("malformed_request");
  });

  it("FORGED: a well-formed voucher signed by a key the broker does not trust", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const foreign = generateKeyPairSync("ed25519");
    const command = "echo forged";
    const voucher = mintVoucher(stack, {
      jobId,
      command,
      ...base(),
      signWith: foreign.privateKey,
    });
    const result = await app.exec(jobId, command, voucher);
    expect(result).toMatchObject({ ok: false, reason: "voucher_invalid" });
  });

  it("REPLAYED NONCE: the same voucher presented twice", async () => {
    const command = "echo replay-me";
    const voucher = mintVoucher(stack, { jobId, command, ...base() });
    const first = await app.exec(jobId, command, voucher);
    expect(first.ok).toBe(true);
    const second = await app.exec(jobId, command, voucher);
    expect(second).toMatchObject({ ok: false, reason: "voucher_replayed" });
  }, 120_000);

  it("WRONG AUDIENCE: a voucher minted for a different broker", async () => {
    const command = "echo wrong-aud";
    const voucher = mintVoucher(stack, {
      jobId,
      command,
      ...base(),
      aud: "cinatra-exec://some-other-instance/broker-server",
    });
    expect(await app.exec(jobId, command, voucher)).toMatchObject({
      ok: false,
      reason: "voucher_invalid",
    });
  });

  it("COMMAND-HASH MISMATCH: authorized for one command, submitted with another", async () => {
    const voucher = mintVoucher(stack, {
      jobId,
      command: "echo authorized",
      ...base(),
      commandSha256: commandDigest("echo authorized"),
    });
    expect(await app.exec(jobId, "echo something-else-entirely", voucher)).toMatchObject({
      ok: false,
      reason: "voucher_invalid",
    });
  });

  it("PRE-EXPIRED: a voucher already past its expiry when it arrives", async () => {
    const command = "echo stale";
    const iat = Date.now() - 120_000;
    const voucher = mintVoucher(stack, { jobId, command, ...base(), iat, exp: iat + 1_000 });
    expect(await app.exec(jobId, command, voucher)).toMatchObject({
      ok: false,
      reason: "voucher_expired",
    });
  });

  it("SESSION MISMATCH: a cross-org voucher on another org's job is refused", async () => {
    const command = "echo cross-org";
    const voucher = mintVoucher(stack, {
      jobId,
      command,
      orgId: "org-somebody-else",
      userId: USER,
      surface: SURFACE,
      runId,
    });
    expect(await app.exec(jobId, command, voucher)).toMatchObject({
      ok: false,
      reason: "voucher_invalid",
    });
  });

  it("JOB MISMATCH: a voucher bound to a different open job is refused", async () => {
    const otherRun = `l5-voucher-other-${randomUUID()}`;
    const otherJob = await openJob(otherRun);
    try {
      const command = "echo wrong-job";
      const voucher = mintVoucher(stack, {
        jobId: otherJob,
        command,
        orgId: ORG,
        userId: USER,
        surface: SURFACE,
        runId: otherRun,
      });
      expect(await app.exec(jobId, command, voucher)).toMatchObject({
        ok: false,
        reason: "voucher_invalid",
      });
    } finally {
      await app.closeJob(otherJob, { removeWorkspace: true });
    }
  }, 120_000);

  it("EXPIRED DURING THE QUEUE WAIT: exactly one remint, then revalidation_exhausted", async () => {
    // A REAL queue, not a simulated one. The per-org concurrency ceiling is 2, so
    // two long commands make a third WAIT — and the admission wait is the only
    // place a voucher can expire between "authorized" and "about to run", which
    // is precisely the window the one-shot revalidation exists for.
    //
    // Both attempts have to wait, so the blockers come in TWO WAVES: the second
    // wave is submitted the moment the first challenge lands, before the remint,
    // so the remint queues instead of slipping through the permits its own
    // predecessor just released.
    const blockRun = `l5-queue-${randomUUID()}`;
    const blockJob = await openJob(blockRun);
    const running: Promise<ExecResult>[] = [];
    const startWave = (tag: string): void => {
      running.push(
        ...[0, 1].map((i) => execCommand(blockJob, `sleep 25; echo ${tag}-${i}`)),
      );
    };
    /**
     * An authorization that is inside its skew window NOW and outside it after a
     * few seconds of waiting: `checkFreshness` is `exp + 5s <= now`, so `exp` four
     * seconds in the past verifies on arrival and is stale one second later.
     */
    const nearlyStale = (): number => Date.now() - 4_000;
    const command = "echo expires-in-the-queue";
    const commandId = randomUUID();
    /**
     * TWO DIFFERENT IDS, and conflating them silently disables the remint.
     *
     * The VOUCHER's `commandId` is stable across the remint — it is the slot the
     * broker keys its one-shot cap and its challenge on, so the retry must carry
     * the same one. The WIRE's `commandId` is the transport-retry idempotency key
     * `command-ledger.ts` records outcomes under, and it must be FRESH: pinning it
     * to the voucher's value makes the ledger replay the first `revalidation_required`
     * answer verbatim, so the remint never reaches the broker and the cap can never
     * be reached. `createRemoteSandboxExecutor` mints a new one per attempt for
     * exactly this reason; this fixture does the same rather than inventing its own
     * calling convention.
     */
    const submit = (nonce?: string): Promise<ExecResult> =>
      app.exec(
        blockJob,
        command,
        mintVoucher(stack, {
          jobId: blockJob,
          command,
          orgId: ORG,
          userId: USER,
          surface: SURFACE,
          runId: blockRun,
          iat: Date.now() - 60_000,
          exp: nearlyStale(),
          commandId,
          ...(nonce ? { nonce } : {}),
        }),
      );

    try {
      startWave("wave-a");
      await sleep(4_000); // both permits are genuinely held by running containers

      const first = await submit();
      expect(first).toMatchObject({ ok: false, reason: "revalidation_required" });
      if (first.ok || first.reason !== "revalidation_required") return;
      const challenge = first.revalidation;
      expect(challenge?.commandId).toBe(commandId);
      expect(challenge?.nonce).toBeTruthy();
      // The challenge names THIS broker's audience — the remint cannot be aimed
      // anywhere else.
      expect(challenge?.aud).toBe(stack.aud);

      // Refill the permits before the remint gets a chance at them.
      startWave("wave-b");
      await sleep(4_000);

      // One remint is all there is: it answers the challenge, waits, expires
      // again, and is refused terminally rather than challenged a second time.
      const second = await submit(challenge?.nonce);
      expect(second).toMatchObject({ ok: false, reason: "revalidation_exhausted" });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.revalidation).toBeUndefined();
    } finally {
      await Promise.allSettled(running);
      await app.closeJob(blockJob, { removeWorkspace: true });
    }
  }, 300_000);
});

// ===========================================================================
// 5. EGRESS CLAMP — clamped at the broker AND enforced at the network layer
// ===========================================================================

describe("5. egress clamp: a signed default_internet policy against an allowlist ceiling", () => {
  it("clamps all three axes, and the denied host actually fails from inside the sandbox", async () => {
    restoreHealthyLease();
    await drainAudit();
    const runId = `l5-egress-${randomUUID()}`;
    const jobId = await openJob(runId);
    try {
      // What the MINT SITE signed: the widest tier, a host set that reaches past
      // the deployment ceiling, and a byte cap far above it.
      const signed = {
        mode: "default_internet" as const,
        allowlist: ["example.com", "pypi.org"],
        maxBytesPerJob: 50 * 1024 * 1024,
      };

      // A SMALL fetch of a host inside the deployment ceiling's set. Small on
      // purpose: the byte cap is a per-JOB budget metered across every stream,
      // and the last step of this test spends it deliberately.
      const allowed = await execCommand(
        jobId,
        `curl -s -o /dev/null -w "%{http_code}" --max-time 45 https://pypi.org/robots.txt`,
        { egressPolicy: signed },
      );
      expect(allowed.ok).toBe(true);
      if (!allowed.ok) return;
      expect(allowed.result.stdout.trim()).toBe("200");

      // OUTSIDE it ⇒ actually denied at the network layer, not merely recorded
      // as denied. `default_internet` would have permitted this host; the clamp
      // is the only reason it fails.
      const denied = await execCommand(
        jobId,
        `curl -s -o /dev/null -w "%{http_code}" --max-time 20 https://example.com/ 2>/dev/null; echo " exit=$?"`,
        { egressPolicy: signed },
      );
      expect(denied.ok).toBe(true);
      if (denied.ok) expect(denied.result.stdout).not.toMatch(/^2\d\d /);

      // The proxy cannot be side-stepped: the sandbox network is `internal`, so
      // ignoring the proxy variables leaves no route at all.
      const bypass = await execCommand(
        jobId,
        `curl -sS --noproxy '*' --max-time 10 https://example.com/ >/dev/null 2>&1; echo bypass-exit=$?`,
        { egressPolicy: signed },
      );
      expect(bypass.ok).toBe(true);
      if (bypass.ok) expect(bypass.result.stdout.trim()).not.toBe("bypass-exit=0");

      // The BYTE CAP is the MINIMUM of the two, and it is metered in transit. The
      // signed 50 MiB would have carried the whole simple-index (many megabytes);
      // the deployment's 256 KiB severs it partway.
      const capped = await execCommand(
        jobId,
        `curl -s -o /tmp/big --max-time 60 https://pypi.org/simple/ >/dev/null 2>&1; wc -c < /tmp/big`,
        { egressPolicy: signed },
      );
      expect(capped.ok).toBe(true);
      if (capped.ok) {
        const bytes = Number(capped.result.stdout.trim());
        expect(Number.isFinite(bytes)).toBe(true);
        expect(bytes).toBeLessThan(DEPLOYMENT_MAX_BYTES);
      }

      // The budget is now spent, so the SAME allowed host that answered 200 at
      // the top of this test is refused. Under the signed 50 MiB ceiling it would
      // still be answering — which is what makes this the proof that `min` was
      // taken rather than the signed value.
      const afterQuota = await execCommand(
        jobId,
        `curl -s -o /dev/null -w "%{http_code}" --max-time 30 https://pypi.org/robots.txt`,
        { egressPolicy: signed },
      );
      expect(afterQuota.ok).toBe(true);
      if (afterQuota.ok) expect(afterQuota.result.stdout.trim()).not.toBe("200");

      // And every narrowing is on the audit trail — an operator asking "why did
      // egress fail" must be able to see it.
      const rows = rowsFor(await drainAudit(), jobId).filter((r) => r.decision === "executed");
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.egressClamped).toBeDefined();
        expect(row.egressClamped).toContain("mode");
        expect(row.egressClamped).toContain("allowlist");
        expect(row.egressClamped).toContain("max_bytes");
        // The tier the command actually ran under is the CLAMPED one.
        expect(row.effectivePolicy.egressMode).toBe("allowlist");
      }
    } finally {
      await app.closeJob(jobId, { removeWorkspace: true });
    }
  }, 600_000);
});

// ===========================================================================
// 6. AUDIT — one row per command, drained across the wire
// ===========================================================================

describe("6. audit: every executed AND refused command yields exactly one row", () => {
  it("one row per command, and repeated drains never duplicate or lose one", async () => {
    restoreHealthyLease();
    await drainAudit();
    const runId = `l5-audit-${randomUUID()}`;
    const jobId = await openJob(runId);
    try {
      // Two that run, two that are refused for different reasons.
      expect((await execCommand(jobId, "echo audited-one")).ok).toBe(true);
      expect((await execCommand(jobId, "echo audited-two")).ok).toBe(true);
      expect(await app.exec(jobId, "echo unauthorized", "not-a-voucher")).toMatchObject({
        ok: false,
      });
      const staleIat = Date.now() - 120_000;
      expect(
        await app.exec(
          jobId,
          "echo stale-auth",
          mintVoucher(stack, {
            jobId,
            command: "echo stale-auth",
            orgId: ORG,
            userId: USER,
            surface: SURFACE,
            runId,
            iat: staleIat,
            exp: staleIat + 1_000,
          }),
        ),
      ).toMatchObject({ ok: false, reason: "voucher_expired" });

      // A PARTIAL drain, then the rest: no record is served twice and none is
      // lost between the two calls.
      const firstBatch = await app.drainAudit({ maxAuditRecords: 2 });
      expect(firstBatch.audit).toHaveLength(2);
      const secondBatch = await app.drainAudit({});
      const all = [...firstBatch.audit, ...secondBatch.audit].filter((r) => r.jobId === jobId);
      expect(all).toHaveLength(4);
      expect(all.filter((r) => r.decision === "executed")).toHaveLength(2);
      expect(all.filter((r) => r.decision === "refused")).toHaveLength(2);

      // Identity is unique per row: no duplicate (command, decision, atMs) pair.
      const keys = new Set(all.map((r) => `${r.jobId}|${r.command}|${r.decision}|${r.atMs}`));
      expect(keys.size).toBe(all.length);

      // A third drain returns nothing for this job — the relay is exhaustive.
      const third = await app.drainAudit({});
      expect(third.audit.filter((r) => r.jobId === jobId)).toHaveLength(0);
    } finally {
      await app.closeJob(jobId, { removeWorkspace: true });
    }
  }, 300_000);

  it("relay overflow is COUNTED and reported, never a silent gap", async () => {
    restoreHealthyLease();
    await drainAudit();
    const runId = `l5-overflow-${randomUUID()}`;
    const jobId = await openJob(runId);
    try {
      // Refusals are the cheap way to produce audit rows: no container, no
      // volume, one row each. Push past the relay's 4096-record ring.
      const total = 4_400;
      const batchSize = 32;
      for (let sent = 0; sent < total; sent += batchSize) {
        await Promise.all(
          Array.from({ length: Math.min(batchSize, total - sent) }, () =>
            app.exec(jobId, "echo overflow", "not-a-voucher"),
          ),
        );
      }
      const drained = await app.drainAudit({});
      // The buffer is bounded — it did not grow with traffic.
      expect(drained.audit.length).toBeLessThanOrEqual(4_096);
      // And the gap is REPORTED rather than silently swallowed.
      expect(drained.droppedAudit).toBeGreaterThan(0);
      expect(drained.droppedAudit + drained.audit.length).toBeGreaterThanOrEqual(total);
      // The counter resets on drain, so a caller can attribute the next gap.
      expect((await app.drainAudit({})).droppedAudit).toBe(0);
    } finally {
      await app.closeJob(jobId, { removeWorkspace: true });
    }
  }, 600_000);

  it(
    "RECORDED GAP: audit delivery is at-most-once — a broker restart drops what was buffered",
    async () => {
      // Characterization, not an endorsement. `drainAudit` SPLICES records out of
      // the relay and the relay is process-local, so nothing survives a restart
      // and nothing can be re-delivered. That is the merged contract; the epic's
      // target (a spool with an ACK and a de-dup key, refusing new commands
      // rather than dropping a record) is NOT implemented, and this arm exists so
      // the gap is measured rather than assumed either way.
      restoreHealthyLease();
      await drainAudit();
      const runId = `l5-restart-${randomUUID()}`;
      const jobId = await openJob(runId);
      expect((await execCommand(jobId, "echo before-restart")).ok).toBe(true);

      const brokerId = await stack.containerId(BROKER_SERVICE);
      await docker(["restart", "-t", "2", brokerId], { timeoutMs: 120_000 });

      // Wait for the broker to answer again.
      let healthy = false;
      for (let attempt = 0; attempt < 120 && !healthy; attempt += 1) {
        try {
          await app.health();
          healthy = true;
        } catch {
          await sleep(500);
        }
      }
      expect(healthy).toBe(true);

      const afterRestart = await app.drainAudit({});
      expect(afterRestart.relayed).toBe(true);
      // The row that existed before the restart is NOT re-delivered, and the
      // loss is not counted either — the drop counter is process-local too.
      expect(afterRestart.audit.filter((r) => r.jobId === jobId)).toHaveLength(0);

      // The job did not survive the restart either: broker state is in-process,
      // so the app must re-open. Fail-closed, and visible.
      const orphaned = await app.exec(
        jobId,
        "echo after-restart",
        mintVoucher(stack, {
          jobId,
          command: "echo after-restart",
          orgId: ORG,
          userId: USER,
          surface: SURFACE,
          runId,
        }),
      );
      expect(orphaned).toMatchObject({ ok: false, reason: "unknown_job" });
    },
    600_000,
  );
});

// ===========================================================================
// 7. ISOLATION — the invariants a service boundary must not quietly relax
// ===========================================================================

describe("7. isolation: the topology's own invariants, checked on the running stack", () => {
  it("the SOCKET is on the worker and ONLY on the worker", async () => {
    const brokerMounts = await docker([
      "inspect",
      "--format",
      "{{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}",
      await stack.containerId(BROKER_SERVICE),
    ]);
    expect(brokerMounts.exitCode).toBe(0);
    expect(brokerMounts.stdout).not.toContain("docker.sock");

    const gatewayMounts = await docker([
      "inspect",
      "--format",
      "{{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}",
      await stack.containerId(GATEWAY_SERVICE),
    ]);
    expect(gatewayMounts.stdout).not.toContain("docker.sock");

    const workerMounts = await docker([
      "inspect",
      "--format",
      "{{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}",
      await stack.containerId(WORKER_SERVICE),
    ]);
    expect(workerMounts.stdout).toContain("docker.sock");
  });

  it("the broker's app-facing leg publishes a port, and carries the hardening it claims", async () => {
    const brokerId = await stack.containerId(BROKER_SERVICE);

    // HALF ONE — the publish actually took effect. This is the fix: a broker on
    // an internal network alone keeps its `HostConfig.PortBindings` and gets an
    // EMPTY `NetworkSettings.Ports`, so `127.0.0.1:4100` answered nothing and the
    // whole topology was unreachable.
    const published = await docker([
      "inspect",
      "--format",
      "{{json .NetworkSettings.Ports}}",
      brokerId,
    ]);
    expect(published.stdout).toContain("4100");
    expect(published.stdout).toContain("127.0.0.1");
    expect((await app.health()).protocolVersion).toBe(1);

    // HALF TWO — the leg is scoped to the broker and carries both hardening
    // options. Only the broker is ever attached, so the app-facing bridge cannot
    // become an incidental side-channel between exec services.
    const inspected = await docker([
      "network",
      "inspect",
      "--format",
      "{{json .Options}}|{{len .Containers}}",
      "cinatra-exec-app",
    ]);
    expect(inspected.exitCode).toBe(0);
    const [options, attached] = inspected.stdout.trim().split("|");
    expect(options).toContain('"com.docker.network.bridge.enable_ip_masquerade":"false"');
    expect(options).toContain('"com.docker.network.bridge.enable_icc":"false"');
    expect(attached).toBe("1");
  }, 120_000);

  it(
    "RECORDED EXPOSURE: disabling bridge masquerade does not remove the broker's outbound route on every runtime",
    async () => {
      // Measured, not assumed. `enable_ip_masquerade: "false"` removes the
      // bridge's own NAT — which is a real hardening on a plain Linux engine, the
      // deploy target — but Docker Desktop NATs at the VM boundary underneath it,
      // so the option does not make the broker unroutable there. Asserting "the
      // broker has no internet" would therefore be asserting something this
      // battery can watch fail; asserting the option is APPLIED (above) and
      // recording what it does NOT buy (here) is the honest pair.
      //
      // What the broker's containment actually rests on, and what the rest of
      // this suite proves: no docker socket, no app configuration, no app code,
      // and mTLS + a service token on the only port it serves.
      const brokerId = await stack.containerId(BROKER_SERVICE);
      const outbound = await docker(
        [
          "exec",
          brokerId,
          "node",
          "-e",
          // A raw TCP connect, never a DNS lookup — a resolver failure would
          // prove nothing about routing.
          "const net=require('node:net');" +
            "const s=net.connect({host:'1.1.1.1',port:443});" +
            "s.setTimeout(6000);" +
            "s.on('connect',()=>{console.log('REACHED');process.exit(0)});" +
            "s.on('timeout',()=>{console.log('NO-ROUTE');process.exit(0)});" +
            "s.on('error',(e)=>{console.log('NO-ROUTE:'+e.code);process.exit(0)});",
        ],
        { timeoutMs: 60_000 },
      );
      // Either answer is a real observation of this runtime; a THIRD answer
      // (a crash, an empty read) would mean the probe itself did not run.
      expect(outbound.stdout).toMatch(/REACHED|NO-ROUTE/);
    },
    120_000,
  );

  it("the sandbox network really is internal — that is the enforcement, not a policy check", async () => {
    const internal = await docker([
      "network",
      "inspect",
      "--format",
      "{{.Internal}}",
      "cinatra-exec-internal",
    ]);
    expect(internal.stdout.trim()).toBe("true");
  });

  it("no host bind mounts reach a sandbox: only the L2 volume and the bounded tmpfs are writable", async () => {
    restoreHealthyLease();
    const runId = `l5-mounts-${randomUUID()}`;
    const jobId = await openJob(runId);
    try {
      const probe = await execCommand(
        jobId,
        `awk '$4 ~ /(^|,)rw(,|$)/ {print $2}' /proc/mounts`,
      );
      expect(probe.ok).toBe(true);
      if (!probe.ok) return;
      const writable = probe.result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(
          (line) =>
            line.length > 0 &&
            !line.startsWith("/proc") &&
            !line.startsWith("/sys") &&
            !line.startsWith("/dev"),
        );
      expect(writable.sort()).toEqual(["/tmp", "/workspace"]);
    } finally {
      await app.closeJob(jobId, { removeWorkspace: true });
    }
  }, 180_000);

  it("no service-scoped secret is reachable inside the sandbox", async () => {
    restoreHealthyLease();
    const runId = `l5-secrets-${randomUUID()}`;
    const jobId = await openJob(runId);
    try {
      const probe = await execCommand(jobId, "env | sort");
      expect(probe.ok).toBe(true);
      if (!probe.ok) return;
      const env = probe.result.stdout;
      // The two canaries scoped to the broker's and the worker's OWN env files.
      expect(env).not.toContain("broker-scoped-canary-must-not-leak");
      expect(env).not.toContain("worker-scoped-canary-must-not-leak");
      // The three secrets that would be catastrophic in a model-driven shell.
      expect(env).not.toContain(stack.brokerToken);
      expect(env).not.toContain(stack.workerToken);
      expect(env).not.toContain(stack.carrierSecret);
      // Nor the gateway's control secret — the sandbox gets an attribution
      // TOKEN, never the credential that could register a policy of its own.
      expect(env).not.toContain(stack.gatewayControlSecret);
      // Scrub-by-omission: no EXEC_/EXECUTION_ configuration crosses at all.
      expect(env).not.toMatch(/^EXECUTION_/m);
      expect(env).not.toMatch(/^EXEC_TLS_/m);
      // Nor any TLS private key material.
      const keys = await execCommand(
        jobId,
        "cat /etc/cinatra-exec/tls/* 2>&1 | head -1; echo read-exit=$?",
      );
      expect(keys.ok).toBe(true);
      if (keys.ok) expect(keys.result.stdout).not.toContain("PRIVATE KEY");
    } finally {
      await app.closeJob(jobId, { removeWorkspace: true });
    }
  }, 180_000);

  it("the broker container carries no app configuration at all", async () => {
    const printed = await docker(["exec", await stack.containerId(BROKER_SERVICE), "env"]);
    expect(printed.exitCode).toBe(0);
    for (const appKey of [
      "SUPABASE_DB_URL",
      "BETTER_AUTH_SECRET",
      "CINATRA_ENCRYPTION_KEY",
      "DATABASE_URL",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "NANGO_SECRET_KEY",
    ]) {
      expect(printed.stdout).not.toContain(`${appKey}=`);
    }
  });

  it("cross-org carrier replay: another org's carrier opens its OWN job, never inherits one", async () => {
    restoreHealthyLease();
    const runId = `l5-crossorg-${randomUUID()}`;
    const mine = await openJob(runId, ORG);
    try {
      // A perfectly valid carrier for a DIFFERENT org, replayed against this
      // broker. It may open its own job; what it must never do is authorize a
      // command on somebody else's.
      const theirCarrier = carrierFor(runId, "org-intruder", "user-intruder");
      const theirs = await app.openJob(theirCarrier);
      expect(theirs.ok).toBe(true);
      if (!theirs.ok) return;
      try {
        const command = "echo cross-org-replay";
        const voucher = mintVoucher(stack, {
          jobId: mine,
          command,
          orgId: "org-intruder",
          userId: "user-intruder",
          surface: SURFACE,
          runId,
        });
        expect(await app.exec(mine, command, voucher)).toMatchObject({
          ok: false,
          reason: "voucher_invalid",
        });
      } finally {
        await app.closeJob(theirs.jobId, { removeWorkspace: true });
      }
    } finally {
      await app.closeJob(mine, { removeWorkspace: true });
    }
  }, 180_000);

  it("the worker refuses an out-of-contract volume name from an authorized broker-client", async () => {
    const leaf = stack.leaf("broker-client");
    const call = (payload: unknown, op = "removeWorkspace"): Promise<RawRpcResult> =>
      workerRpcFromInternalNetwork(stack, {
        cert: leaf.certPem,
        key: leaf.keyPem,
        token: stack.workerToken,
        op,
        payload,
      });

    // Outside the execution plane's namespace entirely.
    expect(refusalCode(await call({ volumeName: "postgres-data" }))).toBe("malformed_request");
    // Option-shaped — a name that could be read as an argv flag.
    expect(refusalCode(await call({ volumeName: "--privileged" }))).toBe("malformed_request");
    // Traversal inside a plane-shaped prefix.
    expect(refusalCode(await call({ volumeName: "cinatra-exec-l2-../../etc" }))).toBe(
      "malformed_request",
    );
    // A path, not a name.
    expect(refusalCode(await call({ volumeName: "/" }))).toBe("malformed_request");
    // Right shape, WRONG TIER: an L2 name presented to the skills lifecycle.
    expect(refusalCode(await call({ volumeName: "cinatra-exec-l2-abc" }, "removeSkills"))).toBe(
      "malformed_request",
    );
    // Unbounded input: a job id past the guard's length ceiling would sanitize
    // into a container-name prefix docker itself refuses.
    expect(
      refusalCode(await call({ jobId: "j".repeat(500) }, "cancelJobContainers")),
    ).toBe("malformed_request");
    // A well-formed but UNKNOWN job drains nothing rather than erroring — the
    // drain is idempotent by contract, and the broker retries it on every refusal.
    const unknown = await call({ jobId: `l5-no-such-job-${randomUUID()}` }, "cancelJobContainers");
    expect(unknown.kind).toBe("answered");
    if (unknown.kind === "answered") expect(unknown.status).toBe(200);
  }, 300_000);
});
