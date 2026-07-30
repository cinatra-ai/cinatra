/**
 * Loopback mTLS round trip (exec-plane S1 remainder, epic cinatra#1705).
 *
 * REAL servers, REAL TLS 1.3, REAL client certificates minted under a throwaway
 * CA (`test-pki.ts`, dependency-free). Nothing here stubs the transport, because
 * the properties under test only exist on a real handshake: that an unauthorized
 * ROLE is refused even though its certificate chain verifies, that the service
 * token is a genuinely independent second factor, that a protocol-version
 * mismatch is refused over the wire, and that a `SandboxCommandResult` and an
 * `EnvironmentMountRefusedError` both survive the crossing unchanged.
 */

import * as https from "node:https";
import { afterEach, describe, expect, it } from "vitest";

import type { ExecutionBroker } from "../../broker";
import type { DockerCli, DockerRunOutcome } from "../../docker-cli";
import { EnvironmentMountRefusedError } from "../../environment/mount";
import type { CommandVoucherMinter } from "../../executor";
import type {
  ExecResult,
  ExecutionAuditRecord,
  OpenJobResult,
  SandboxCommandResult,
  SandboxCommandSpec,
  SandboxWorker,
} from "../../types";
import { BrokerServiceClient, createRemoteSandboxExecutor } from "../broker-client";
import {
  createBrokerService,
  createBufferedAuditRelay,
  type BrokerServiceBroker,
  type BrokerService,
} from "../broker-server";
import { EKU_CLIENT_AUTH, EKU_SERVER_AUTH, execServiceUri, type ExecTlsMaterial } from "../mtls";
import {
  EXEC_PROTOCOL_HEADER,
  EXEC_PROTOCOL_VERSION,
  EXEC_RPC_PATH,
  EXEC_SERVICE_TOKEN_HEADER,
} from "../protocol";
import { WorkerServiceClient } from "../worker-client";
import { createWorkerService, type WorkerService } from "../worker-server";
import { createTestCa } from "./test-pki";

const INSTANCE = "loopback-inst";
const BROKER_TOKEN = "broker-service-token-aaaaaaaaaaaaaaaa";
const WORKER_TOKEN = "worker-service-token-bbbbbbbbbbbbbbbb";

// ---------------------------------------------------------------------------
// PKI + fixtures
// ---------------------------------------------------------------------------

const ca = createTestCa();

function materialFor(
  role: "app-client" | "broker-client" | "broker-server" | "worker-server",
  eku: string,
  instance = INSTANCE,
): ExecTlsMaterial {
  const leaf = ca.issue({
    commonName: role,
    uris: [execServiceUri(instance, role)],
    extendedKeyUsage: [eku],
  });
  return { certPem: leaf.certPem, keyPem: leaf.keyPem, caPem: ca.caPem };
}

const APP_CLIENT = materialFor("app-client", EKU_CLIENT_AUTH);
const BROKER_CLIENT = materialFor("broker-client", EKU_CLIENT_AUTH);
const BROKER_SERVER = materialFor("broker-server", EKU_SERVER_AUTH);
const WORKER_SERVER = materialFor("worker-server", EKU_SERVER_AUTH);

const RESULT: SandboxCommandResult = {
  exitCode: 0,
  stdout: "cinatra-exec-handshake",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  termination: "exited",
  wallMs: 42,
  imageDigest: "sha256:deadbeef",
  workspaceKb: 128,
  egress: {
    totalBytes: 10,
    destinations: [{ host: "pypi.org", port: 443, allowed: true, bytesIn: 6, bytesOut: 4 }],
  },
};

const SPEC: SandboxCommandSpec = {
  jobId: "job-1",
  command: "printf cinatra-exec-handshake",
  workspaceVolume: "cinatra-exec-l2-run-1",
  egress: { kind: "none" },
  limits: {
    cpus: 1,
    memoryMb: 1024,
    pidsLimit: 256,
    timeoutMs: 120_000,
    maxStdioBytes: 1_048_576,
    workspaceQuotaKb: 262_144,
  },
};

/** The merged broker must satisfy the service's structural surface. */
const _brokerSurfaceIsSatisfied = (broker: ExecutionBroker): BrokerServiceBroker => broker;
void _brokerSurfaceIsSatisfied;

/**
 * A fixed opaque voucher for wire-level tests. Nothing here exercises
 * `ExecutionVoucherVerifier` (no real `ExecutionBroker` is constructed in this
 * file — see `_brokerSurfaceIsSatisfied` above), so the string is never
 * cryptographically verified; it only has to round-trip byte-exact through
 * the wire to the `FakeBroker`.
 */
const TEST_VOUCHER = "test-voucher";
const mintTestVoucher: CommandVoucherMinter = async () => ({ ok: true, voucher: TEST_VOUCHER });

type FakeBroker = BrokerServiceBroker & {
  execCalls: Array<{ jobId: string; command: string }>;
  openCalls: number;
  closed: string[];
  terminated: string[];
  swept: number[];
  openResult: OpenJobResult;
  execResult: ExecResult;
  execGate?: Promise<void>;
};

function fakeBroker(overrides: Partial<FakeBroker> = {}): FakeBroker {
  const state: FakeBroker = {
    execCalls: [],
    openCalls: 0,
    closed: [],
    terminated: [],
    swept: [],
    openResult: { ok: true, jobId: "job-1" },
    execResult: { ok: true, result: RESULT },
    executingCount: 3,
    openJob: async () => {
      state.openCalls += 1;
      return state.openResult;
    },
    exec: async (jobId, command) => {
      state.execCalls.push({ jobId, command });
      if (state.execGate) await state.execGate;
      return state.execResult;
    },
    closeJob: async (jobId) => {
      state.closed.push(jobId);
    },
    terminateJobsForRun: async (runId) => {
      state.terminated.push(runId);
      return 2;
    },
    closeIdleJobs: async (idleMs) => {
      state.swept.push(idleMs);
      return 1;
    },
    ...overrides,
  };
  return state;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Started<S> = { service: S; port: number };

async function listen<S extends { server: https.Server }>(service: S): Promise<Started<S>> {
  await new Promise<void>((resolve) => service.server.listen(0, "127.0.0.1", () => resolve()));
  const address = service.server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { service, port: address.port };
}

const teardown: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()?.();
});

async function startBroker(
  broker: BrokerServiceBroker,
  opts: { relay?: ReturnType<typeof createBufferedAuditRelay> } = {},
): Promise<Started<BrokerService>> {
  const service = createBrokerService({
    broker,
    instance: INSTANCE,
    serviceToken: BROKER_TOKEN,
    tls: BROKER_SERVER,
    ...(opts.relay ? { relay: opts.relay } : {}),
  });
  const started = await listen(service);
  teardown.push(() => service.close());
  return started;
}

async function startWorker(
  worker: SandboxWorker,
  docker?: DockerCli,
): Promise<Started<WorkerService>> {
  const service = createWorkerService({
    worker,
    instance: INSTANCE,
    serviceToken: WORKER_TOKEN,
    tls: WORKER_SERVER,
    ...(docker ? { docker } : {}),
  });
  const started = await listen(service);
  teardown.push(() => service.close());
  return started;
}

function brokerClient(
  port: number,
  overrides: { tls?: ExecTlsMaterial; serviceToken?: string; newCommandId?: () => string } = {},
): BrokerServiceClient {
  const client = new BrokerServiceClient({
    baseUrl: `https://127.0.0.1:${port}`,
    instance: INSTANCE,
    serviceToken: overrides.serviceToken ?? BROKER_TOKEN,
    tls: overrides.tls ?? APP_CLIENT,
    requestTimeoutMs: 10_000,
    ...(overrides.newCommandId ? { newCommandId: overrides.newCommandId } : {}),
  });
  teardown.push(() => client.close());
  return client;
}

function workerClient(
  port: number,
  overrides: { newCommandId?: () => string; maxAttempts?: number } = {},
): WorkerServiceClient {
  const client = new WorkerServiceClient({
    baseUrl: `https://127.0.0.1:${port}`,
    instance: INSTANCE,
    serviceToken: WORKER_TOKEN,
    tls: BROKER_CLIENT,
    requestTimeoutMs: 10_000,
    retryDelayMs: 1,
    ...(overrides.newCommandId ? { newCommandId: overrides.newCommandId } : {}),
    ...(overrides.maxAttempts === undefined ? {} : { maxAttempts: overrides.maxAttempts }),
  });
  teardown.push(() => client.close());
  return client;
}

/** Raw request so a test can send a body/headers the typed client never would. */
function rawPost(
  port: number,
  options: {
    material?: ExecTlsMaterial;
    token?: string;
    body: string;
    protocolHeader?: string;
    path?: string;
    method?: string;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port,
        method: options.method ?? "POST",
        path: options.path ?? EXEC_RPC_PATH,
        ...(options.material
          ? { cert: options.material.certPem, key: options.material.keyPem }
          : {}),
        ca: ca.caPem,
        // CHAIN VALIDATION STAYS ON. Only the HOSTNAME check is waived, because
        // the server's certificate deliberately carries no DNS/IP SAN for
        // 127.0.0.1 — the identity is the URI SAN, which is the whole point of
        // this module. `rejectUnauthorized: false` would have switched off chain
        // verification too (and CodeQL flags it high-severity, correctly); this
        // waives strictly the one check that does not apply.
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
        minVersion: "TLSv1.3",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(options.body),
          ...(options.token ? { [EXEC_SERVICE_TOKEN_HEADER]: options.token } : {}),
          ...(options.protocolHeader === undefined
            ? {}
            : { [EXEC_PROTOCOL_HEADER]: options.protocolHeader }),
        },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += String(chunk)));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

function envelopeBody(op: string, payload: unknown, protocolVersion: unknown): string {
  return JSON.stringify({ protocolVersion, op, payload });
}

// ---------------------------------------------------------------------------
// Broker service over real mTLS
// ---------------------------------------------------------------------------

describe("broker service — authorized round trip", () => {
  it("carries openJob + exec end to end with the result byte-identical", async () => {
    const broker = fakeBroker();
    const { port } = await startBroker(broker);
    const client = brokerClient(port);

    expect(await client.openJob("sealed.carrier")).toEqual({ ok: true, jobId: "job-1" });
    const result = await client.exec("job-1", "printf hi", TEST_VOUCHER, { commandId: "c1" });
    expect(result).toEqual({ ok: true, result: RESULT });
    expect(broker.execCalls).toEqual([{ jobId: "job-1", command: "printf hi" }]);
  });

  it("passes a broker VERDICT through on an ok envelope, unchanged", async () => {
    const broker = fakeBroker({
      openResult: { ok: false, reason: "carrier_expired", message: "stale" },
      execResult: { ok: false, reason: "run_removed", message: "purged" },
    });
    const { port } = await startBroker(broker);
    const client = brokerClient(port);

    // A refusal is a decision, not a transport error: the merged vocabulary
    // reaches the app verbatim so nothing above reinterprets it as a blip.
    expect(await client.openJob("c")).toEqual({
      ok: false,
      reason: "carrier_expired",
      message: "stale",
    });
    expect(await client.exec("job-1", "ls", TEST_VOUCHER, { commandId: "c2" })).toEqual({
      ok: false,
      reason: "run_removed",
      message: "purged",
    });
  });

  it("serves closeJob, terminateJobsForRun, sweep and health", async () => {
    const broker = fakeBroker();
    const { port } = await startBroker(broker);
    const client = brokerClient(port);

    await client.closeJob("job-1", { removeWorkspace: true });
    expect(broker.closed).toEqual(["job-1"]);
    expect(await client.terminateJobsForRun("run-9")).toBe(2);
    expect(broker.terminated).toEqual(["run-9"]);
    expect(await client.closeIdleJobs(900_000)).toBe(1);
    expect(broker.swept).toEqual([900_000]);

    const health = await client.health();
    expect(health.protocolVersion).toBe(EXEC_PROTOCOL_VERSION);
    expect(health.executingCount).toBe(3);
  });

  it("threads staged skills and a declared environment through openJob", async () => {
    let seen: unknown;
    const broker = fakeBroker({
      openJob: async (_carrier, openOpts) => {
        seen = openOpts;
        return { ok: true, jobId: "job-1" };
      },
    });
    const { port } = await startBroker(broker);
    const client = brokerClient(port);
    await client.openJob("c", {
      stagedSkills: [{ slug: "s", files: [{ path: "p", content: "c", digest: "d" }] }],
      environment: { imageRef: "cinatra-exec-l1:x", provenance: { signature: "sig" } as never },
    });
    expect(seen).toEqual({
      stagedSkills: [{ slug: "s", files: [{ path: "p", content: "c", digest: "d" }] }],
      environment: { imageRef: "cinatra-exec-l1:x", provenance: { signature: "sig" } },
    });
  });
});

describe("broker service — idempotency", () => {
  it("replays a completed commandId instead of executing twice", async () => {
    const broker = fakeBroker();
    const { port } = await startBroker(broker);
    const client = brokerClient(port);

    const first = await client.exec("job-1", "install", TEST_VOUCHER, { commandId: "same" });
    const second = await client.exec("job-1", "install", TEST_VOUCHER, { commandId: "same" });
    expect(second).toEqual(first);
    expect(broker.execCalls).toHaveLength(1);
  });

  it("refuses a concurrent duplicate as command_in_flight rather than running it twice", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const broker = fakeBroker({ execGate: gate });
    const { port } = await startBroker(broker);
    const client = brokerClient(port);

    const first = client.exec("job-1", "install", TEST_VOUCHER, { commandId: "hot" });
    // Give the first dispatch time to claim the id before the duplicate lands.
    // The claim happens synchronously right after the body parse, so this is a
    // generous margin rather than a race the test depends on winning.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    const duplicate = await client.exec("job-1", "install", TEST_VOUCHER, { commandId: "hot" });
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(duplicate.reason).toBe("worker_error");
    expect(duplicate.message).toMatch(/command_in_flight/);
    release();
    expect((await first).ok).toBe(true);
    expect(broker.execCalls).toHaveLength(1);
  });
});

describe("broker service — the two independent factors", () => {
  it("accepts the authorized role with the correct token", async () => {
    const { port } = await startBroker(fakeBroker());
    const answer = await rawPost(port, {
      material: APP_CLIENT,
      token: BROKER_TOKEN,
      body: envelopeBody("health", {}, EXEC_PROTOCOL_VERSION),
    });
    expect(answer.status).toBe(200);
  });

  it("refuses a chain-VALID certificate for the wrong role (403 unauthorized_peer)", async () => {
    const { port } = await startBroker(fakeBroker());
    // BROKER_CLIENT is issued by the same CA with clientAuth — TLS is happy.
    // Only the URI-SAN role check refuses it, which is the point.
    const answer = await rawPost(port, {
      material: BROKER_CLIENT,
      token: BROKER_TOKEN,
      body: envelopeBody("health", {}, EXEC_PROTOCOL_VERSION),
    });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatch(/unauthorized_peer/);
    expect(answer.body).toMatch(/broker-client/);
  });

  it("refuses a credential minted for a DIFFERENT instance", async () => {
    const { port } = await startBroker(fakeBroker());
    const answer = await rawPost(port, {
      material: materialFor("app-client", EKU_CLIENT_AUTH, "other-instance"),
      token: BROKER_TOKEN,
      body: envelopeBody("health", {}, EXEC_PROTOCOL_VERSION),
    });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatch(/uri_san_mismatch|unauthorized_peer/);
  });

  it("refuses a valid certificate with a WRONG token (401) — factor two is independent", async () => {
    const { port } = await startBroker(fakeBroker());
    const answer = await rawPost(port, {
      material: APP_CLIENT,
      token: "not-the-token-cccccccccccccccc",
      body: envelopeBody("health", {}, EXEC_PROTOCOL_VERSION),
    });
    expect(answer.status).toBe(401);
    expect(answer.body).toMatch(/unauthorized_token/);
  });

  it("refuses a valid certificate with NO token at all (401)", async () => {
    const { port } = await startBroker(fakeBroker());
    const answer = await rawPost(port, {
      material: APP_CLIENT,
      body: envelopeBody("health", {}, EXEC_PROTOCOL_VERSION),
    });
    expect(answer.status).toBe(401);
  });

  it("refuses NO client certificate at the TLS layer — the token cannot rescue it", async () => {
    const { port } = await startBroker(fakeBroker());
    await expect(
      rawPost(port, {
        token: BROKER_TOKEN,
        body: envelopeBody("health", {}, EXEC_PROTOCOL_VERSION),
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("refuses a certificate from an UNKNOWN CA at the TLS layer", async () => {
    const { port } = await startBroker(fakeBroker());
    const rogue = createTestCa("rogue-ca");
    const leaf = rogue.issue({
      commonName: "app-client",
      uris: [execServiceUri(INSTANCE, "app-client")],
      extendedKeyUsage: [EKU_CLIENT_AUTH],
    });
    await expect(
      rawPost(port, {
        material: { certPem: leaf.certPem, keyPem: leaf.keyPem, caPem: rogue.caPem },
        token: BROKER_TOKEN,
        body: envelopeBody("health", {}, EXEC_PROTOCOL_VERSION),
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  /**
   * A REAL certificate, signed by the real CA, whose URI SAN differs from the
   * expected identity only by a trailing space. `trim()`ing the parsed SAN made
   * this authorize as `app-client` — a whitespace-insensitive comparison wearing
   * the label "byte-exact". Proven over the handshake, not just at the unit level.
   */
  it("refuses a CA-VALID certificate whose SAN differs only by whitespace", async () => {
    const { port } = await startBroker(fakeBroker());
    const leaf = ca.issue({
      commonName: "app-client",
      uris: [`${execServiceUri(INSTANCE, "app-client")} `],
      extendedKeyUsage: [EKU_CLIENT_AUTH],
    });
    const answer = await rawPost(port, {
      material: { certPem: leaf.certPem, keyPem: leaf.keyPem, caPem: ca.caPem },
      token: BROKER_TOKEN,
      body: envelopeBody("health", {}, EXEC_PROTOCOL_VERSION),
    });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatch(/unauthorized_peer/);
  });

  /**
   * Both factors settle BEFORE the service reveals anything about its routes, so
   * an unauthorized peer gets the same 403 on a bogus path that it gets on the
   * real one — never a 404 that would map the surface.
   */
  it("does not leak route existence to an unauthorized peer", async () => {
    const { port } = await startBroker(fakeBroker());
    const answer = await rawPost(port, {
      material: BROKER_CLIENT, // chain-valid, wrong role for this endpoint
      token: BROKER_TOKEN,
      body: "{}",
      path: "/definitely-not-a-route",
    });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatch(/unauthorized_peer/);
  });

  it("refuses the wrong route and the wrong method without leaking a vocabulary", async () => {
    const { port } = await startBroker(fakeBroker());
    const wrongPath = await rawPost(port, {
      material: APP_CLIENT,
      token: BROKER_TOKEN,
      body: "{}",
      path: "/",
    });
    expect(wrongPath.status).toBe(404);
    const wrongMethod = await rawPost(port, {
      material: APP_CLIENT,
      token: BROKER_TOKEN,
      body: "{}",
      method: "GET",
    });
    expect(wrongMethod.status).toBe(405);
  });
});

describe("broker service — protocol version over the wire", () => {
  it("refuses a mismatched body version fail-closed", async () => {
    const broker = fakeBroker();
    const { port } = await startBroker(broker);
    const answer = await rawPost(port, {
      material: APP_CLIENT,
      token: BROKER_TOKEN,
      body: envelopeBody("exec", { jobId: "j", command: "ls", commandId: "c" }, EXEC_PROTOCOL_VERSION + 1),
    });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatch(/protocol_version_mismatch/);
    // Nothing executed — the refusal is BEFORE dispatch.
    expect(broker.execCalls).toHaveLength(0);
  });

  it("refuses a mismatched transport header even when the body agrees with us", async () => {
    const { port } = await startBroker(fakeBroker());
    const answer = await rawPost(port, {
      material: APP_CLIENT,
      token: BROKER_TOKEN,
      protocolHeader: String(EXEC_PROTOCOL_VERSION + 1),
      body: envelopeBody("health", {}, EXEC_PROTOCOL_VERSION),
    });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatch(/protocol_version_mismatch/);
  });

  it("refuses a non-JSON body and an unknown op", async () => {
    const { port } = await startBroker(fakeBroker());
    expect((await rawPost(port, { material: APP_CLIENT, token: BROKER_TOKEN, body: "not json" })).status).toBe(400);
    const unknown = await rawPost(port, {
      material: APP_CLIENT,
      token: BROKER_TOKEN,
      body: envelopeBody("dropTables", {}, EXEC_PROTOCOL_VERSION),
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatch(/unknown_op/);
  });
});

describe("broker service — audit relay", () => {
  it("hands the app the buffered audit + stdio records", async () => {
    const relay = createBufferedAuditRelay();
    const record: ExecutionAuditRecord = {
      jobId: "job-1",
      orgId: "org-1",
      userId: "user-1",
      surface: "agent_run",
      command: "printf hi",
      cwd: "/workspace",
      decision: "executed",
      effectivePolicy: { egressMode: "none", limits: SPEC.limits },
      atMs: 1234,
    };
    relay.auditSink(record);
    relay.stdioSink({ jobId: "job-1", seq: 0, stdout: "hi", stderr: "" });

    const { port } = await startBroker(fakeBroker(), { relay });
    const client = brokerClient(port);
    const drained = await client.drainAudit();
    expect(drained.relayed).toBe(true);
    expect(drained.audit).toEqual([record]);
    expect(drained.stdio).toEqual([{ jobId: "job-1", seq: 0, stdout: "hi", stderr: "" }]);
    // A drain is destructive — the second one is empty, not a duplicate.
    expect((await client.drainAudit()).audit).toEqual([]);
  });

  it("answers relayed:false when no relay is wired, instead of a misleading empty batch", async () => {
    const { port } = await startBroker(fakeBroker());
    const drained = await brokerClient(port).drainAudit();
    expect(drained).toEqual({
      audit: [],
      stdio: [],
      droppedAudit: 0,
      droppedStdio: 0,
      relayed: false,
    });
  });

  it("counts overflow instead of dropping silently or growing unbounded", () => {
    const relay = createBufferedAuditRelay({ maxAuditRecords: 2, maxStdioEntries: 1 });
    const record = (jobId: string): ExecutionAuditRecord => ({
      jobId,
      orgId: "o",
      userId: "u",
      surface: "chat",
      command: "x",
      cwd: "/workspace",
      decision: "executed",
      effectivePolicy: { egressMode: "none", limits: SPEC.limits },
      atMs: 1,
    });
    relay.auditSink(record("a"));
    relay.auditSink(record("b"));
    relay.auditSink(record("c"));
    relay.stdioSink({ jobId: "a", seq: 0, stdout: "", stderr: "" });
    relay.stdioSink({ jobId: "b", seq: 1, stdout: "", stderr: "" });
    const drained = relay.drain();
    expect(drained.audit.map((r) => r.jobId)).toEqual(["b", "c"]);
    expect(drained.droppedAudit).toBe(1);
    expect(drained.stdio).toHaveLength(1);
    expect(drained.droppedStdio).toBe(1);
    // Counters reset with the drain, so a gap is reported once, not forever.
    expect(relay.drain().droppedAudit).toBe(0);
  });
});

describe("broker service — the injected SandboxExecutor", () => {
  it("produces model-visible outputs over the real service", async () => {
    const { port } = await startBroker(fakeBroker());
    const executor = createRemoteSandboxExecutor(brokerClient(port), { mintVoucher: mintTestVoucher });
    const outputs = await executor({ sessionCarrier: "sealed", commands: ["a", "b"] });
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toEqual({
      stdout: RESULT.stdout,
      stderr: "",
      outcome: { type: "exit", exitCode: 0 },
    });
  });

  it("turns an unreachable broker into a structured refusal, never a rejection", async () => {
    // Point at a closed port: the executor's contract is that it NEVER rejects
    // into the provider tool loop.
    const client = brokerClient(1);
    const executor = createRemoteSandboxExecutor(client, { mintVoucher: mintTestVoucher });
    const outputs = await executor({ sessionCarrier: "sealed", commands: ["a"] });
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.outcome).toEqual({ type: "exit", exitCode: 126 });
    expect(outputs[0]?.stderr).toMatch(/service_unavailable/);
  });

  /**
   * `refusedByPlane` IS THE PROVENANCE BOUNDARY (cinatra#2175). The surface guard
   * (`observeSurfaceExecutionDispatches`) counts a dispatch as EXECUTED unless
   * EVERY output carries this flag — so a remote refusal that omitted it would be
   * booked as proof that a sandbox ran, which is precisely the fabrication that
   * guard was built to catch. The in-process executor sets it; the remote one must
   * be indistinguishable, on BOTH refusal paths.
   */
  it("marks a refused OPEN with refusedByPlane, exactly as the in-process executor does", async () => {
    const { port } = await startBroker(
      fakeBroker({
        openResult: { ok: false, reason: "open_jobs_exhausted", message: "too many" },
      }),
    );
    const executor = createRemoteSandboxExecutor(brokerClient(port), { mintVoucher: mintTestVoucher });
    const outputs = await executor({ sessionCarrier: "sealed", commands: ["a", "b"] });
    expect(outputs).toHaveLength(2);
    expect(outputs.every((o) => o.refusedByPlane === true)).toBe(true);
  });

  it("marks a refused COMMAND with refusedByPlane", async () => {
    const { port } = await startBroker(
      fakeBroker({
        execResult: { ok: false, reason: "queue_saturated", message: "full" },
      }),
    );
    const executor = createRemoteSandboxExecutor(brokerClient(port), { mintVoucher: mintTestVoucher });
    const outputs = await executor({ sessionCarrier: "sealed", commands: ["a"] });
    expect(outputs[0]?.refusedByPlane).toBe(true);
  });

  it("leaves a REAL execution unmarked, so the guard can still tell the two apart", async () => {
    const { port } = await startBroker(fakeBroker());
    const executor = createRemoteSandboxExecutor(brokerClient(port), { mintVoucher: mintTestVoucher });
    const outputs = await executor({ sessionCarrier: "sealed", commands: ["a"] });
    expect(outputs[0]?.refusedByPlane).toBeUndefined();
  });

  it("an unreachable broker's refusal is marked too — the transport path is not an exception", async () => {
    const executor = createRemoteSandboxExecutor(brokerClient(1), { mintVoucher: mintTestVoucher });
    const outputs = await executor({ sessionCarrier: "sealed", commands: ["a"] });
    expect(outputs[0]?.refusedByPlane).toBe(true);
  });
});

describe("service idempotency — a commandId is scoped to ONE job", () => {
  /**
   * The ledger is keyed on the commandId alone, because that is what makes the
   * claim atomic. Nothing in the KEY carries the job, so without an explicit
   * check a repeated id naming a DIFFERENT job would be answered with the FIRST
   * job's recorded output — one job's stdout attributed to another. Refused on
   * both hops.
   */
  it("refuses a reused commandId on the broker's exec rather than replaying another job's result", async () => {
    const broker = fakeBroker();
    const { port } = await startBroker(broker);
    const client = brokerClient(port);
    expect(await client.exec("job-1", "a", TEST_VOUCHER, { commandId: "shared-id" })).toEqual({
      ok: true,
      result: RESULT,
    });
    const crossed = await client.exec("job-2", "b", TEST_VOUCHER, { commandId: "shared-id" });
    expect(crossed).toEqual({
      ok: false,
      reason: "worker_error",
      message: expect.stringMatching(/scoped to ONE job/),
    });
    // The second job's command never reached the broker.
    expect(broker.execCalls).toEqual([{ jobId: "job-1", command: "a" }]);
  });

  /**
   * THE DANGEROUS CASE. `broker.exec` can throw AFTER the container already ran —
   * a host-injected audit or stdio sink rejecting does exactly that. Releasing the
   * claim on that ambiguity let a retry of the same commandId start a SECOND run
   * of a model-authored command. The failure is recorded instead, so the retry
   * replays it and the broker is never entered twice.
   */
  it("does not re-run a command whose first dispatch threw after it may have run", async () => {
    const broker = fakeBroker({
      exec: async (jobId, command) => {
        broker.execCalls.push({ jobId, command });
        // Stands in for a sink that rejects once the command has already run.
        throw new Error("audit sink rejected after the command ran");
      },
    });
    const { port } = await startBroker(broker);
    const client = brokerClient(port);

    const first = await client.exec("job-1", "a", TEST_VOUCHER, { commandId: "same-id" });
    expect(first.ok).toBe(false);
    const retry = await client.exec("job-1", "a", TEST_VOUCHER, { commandId: "same-id" });
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.message).toMatch(/not retryable under the same id/);
    // The broker was entered EXACTLY once, despite the retry.
    expect(broker.execCalls).toHaveLength(1);
  });

  /**
   * A NON-ERROR THROWABLE must not defeat the ledger write. `(err as Error).message`
   * on `throw null` throws again, which would skip the `complete()` call and leave
   * the commandId claimed forever — a command that can never be retried, and a
   * leaked claim. The service must record the failure and stay answerable.
   */
  it("records the failure even when the dispatch throws a non-Error", async () => {
    const broker = fakeBroker({
      exec: async (jobId, command) => {
        broker.execCalls.push({ jobId, command });
        // The point of the test IS a hostile non-Error throwable.
        throw null as unknown as Error;
      },
    });
    const { port } = await startBroker(broker);
    const client = brokerClient(port);
    const first = await client.exec("job-1", "a", TEST_VOUCHER, { commandId: "null-throw" });
    expect(first.ok).toBe(false);
    // Answerable, and the id is SPENT rather than wedged in-flight.
    const retry = await client.exec("job-1", "a", TEST_VOUCHER, { commandId: "null-throw" });
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.message).toMatch(/not retryable under the same id/);
    expect(broker.execCalls).toHaveLength(1);
  });

  it("does not start a second container when the worker's first dispatch threw", async () => {
    let runs = 0;
    const worker: SandboxWorker = {
      runCommand: async () => {
        runs += 1;
        throw new Error("placement failed while tearing down");
      },
    };
    const { port } = await startWorker(worker);
    // Two arrivals of the SAME commandId — exactly what a transport retry
    // delivers. The second must replay the recorded failure, not dispatch again.
    const client = workerClient(port, { newCommandId: () => "same-id", maxAttempts: 1 });
    await expect(client.runCommand(SPEC)).rejects.toThrow(/tearing down/);
    await expect(client.runCommand(SPEC)).rejects.toThrow(
      /not retryable under the same id/,
    );
    expect(runs).toBe(1);
  });

  it("refuses a reused commandId on the worker's runCommand", async () => {
    let runs = 0;
    const worker: SandboxWorker = {
      runCommand: async () => {
        runs += 1;
        return RESULT;
      },
    };
    const { port } = await startWorker(worker);
    const client = workerClient(port, { newCommandId: () => "shared-id", maxAttempts: 1 });
    expect(await client.runCommand({ ...SPEC, jobId: "job-A" })).toEqual(RESULT);
    await expect(client.runCommand({ ...SPEC, jobId: "job-B" })).rejects.toThrow(
      /scoped to ONE job/,
    );
    expect(runs).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Worker service over real mTLS
// ---------------------------------------------------------------------------

describe("worker service — the broker cannot tell the difference", () => {
  it("returns a SandboxCommandResult byte-identical across the wire", async () => {
    const specs: SandboxCommandSpec[] = [];
    const worker: SandboxWorker = {
      runCommand: async (spec) => {
        specs.push(spec);
        return RESULT;
      },
    };
    const { port } = await startWorker(worker);
    const client = workerClient(port);
    expect(await client.runCommand(SPEC)).toEqual(RESULT);
    expect(specs).toEqual([SPEC]);
  });

  it("preserves an L1 mount refusal as EnvironmentMountRefusedError with its reason", async () => {
    const worker: SandboxWorker = {
      runCommand: async () => {
        throw new EnvironmentMountRefusedError("no_provenance_key");
      },
    };
    const { port } = await startWorker(worker);
    const client = workerClient(port);
    // This is what keeps the broker's audited `environment_untrusted` refusal
    // intact remotely: a generic error would degrade it to `worker_error`.
    await expect(client.runCommand({ ...SPEC })).rejects.toBeInstanceOf(
      EnvironmentMountRefusedError,
    );
    await client.runCommand({ ...SPEC }).catch((err: unknown) => {
      expect((err as EnvironmentMountRefusedError).reason).toBe("no_provenance_key");
    });
  });

  it("throws (not returns) on any other worker failure, so the broker audits worker_error", async () => {
    const worker: SandboxWorker = {
      runCommand: async () => {
        throw new Error("docker daemon is unreachable");
      },
    };
    const { port } = await startWorker(worker);
    await expect(workerClient(port).runCommand(SPEC)).rejects.toThrow(/docker daemon is unreachable/);
  });

  it("replays a repeated commandId instead of starting a second container", async () => {
    let runs = 0;
    const worker: SandboxWorker = {
      runCommand: async () => {
        runs += 1;
        return RESULT;
      },
    };
    const { port } = await startWorker(worker);
    const client = workerClient(port, { newCommandId: () => "fixed-command-id" });
    expect(await client.runCommand(SPEC)).toEqual(RESULT);
    expect(await client.runCommand(SPEC)).toEqual(RESULT);
    expect(runs).toBe(1);
  });

  it("serves the volume lifecycles through the injected docker seam", async () => {
    const calls: string[][] = [];
    const docker: DockerCli = async (args): Promise<DockerRunOutcome> => {
      calls.push(args);
      return {
        exitCode: 0,
        // Since exec-plane L3 a REMOVAL re-reads the volume's labels and
        // refuses anything the execution plane did not create, so the seam has
        // to answer the inspect the way a plane-created volume would.
        stdout:
          args[0] === "volume" && args[1] === "inspect"
            ? JSON.stringify({ "ai.cinatra.execution-plane": "l2" })
            : "",
        stderr: "",
        stdioOverflow: false,
        timedOut: false,
      };
    };
    const worker: SandboxWorker = { runCommand: async () => RESULT };
    const { port } = await startWorker(worker, docker);
    const client = workerClient(port);

    expect(await client.ensureWorkspace("run-1")).toBe("cinatra-exec-l2-run-1");
    await client.removeWorkspace("cinatra-exec-l2-run-1");
    // Since exec-plane L3 both ops check ownership first (`volume create` adopts
    // an existing name rather than failing), so the create is the SECOND call.
    expect(calls.map((argv) => argv.slice(0, 2))).toEqual([
      ["volume", "inspect"],
      ["volume", "create"],
      ["volume", "inspect"],
      ["volume", "rm"],
    ]);
    expect(calls.at(-1)).toEqual(["volume", "rm", "-f", "cinatra-exec-l2-run-1"]);
  });

  it("routes the drain op to the worker host (exec-plane L3)", async () => {
    const calls: string[][] = [];
    const docker: DockerCli = async (args): Promise<DockerRunOutcome> => {
      calls.push(args);
      return {
        exitCode: 0,
        stdout: args[0] === "ps" ? "cinatra-exec-job-7-0\n" : "",
        stderr: "",
        stdioOverflow: false,
        timedOut: false,
      };
    };
    const worker: SandboxWorker = { runCommand: async () => RESULT };
    const { port } = await startWorker(worker, docker);

    // A JOB ID crosses the wire, never a container name: the worker derives and
    // validates the prefix itself, so this op cannot remove a container the job
    // does not own.
    expect(await workerClient(port).cancelJobContainers("job-7")).toEqual([
      "cinatra-exec-job-7-0",
    ]);
    expect(calls[0]?.[0]).toBe("ps");
    expect(calls.at(-1)).toEqual(["rm", "--force", "cinatra-exec-job-7-0"]);
  });

  it("refuses the app's own client role on a worker endpoint", async () => {
    const worker: SandboxWorker = { runCommand: async () => RESULT };
    const { port } = await startWorker(worker);
    // The app must never reach a worker directly — the broker stays the single
    // trust boundary, and the worker's endpoint enforces that itself.
    const answer = await rawPost(port, {
      material: APP_CLIENT,
      token: WORKER_TOKEN,
      body: envelopeBody("removeSkills", { volumeName: "v" }, EXEC_PROTOCOL_VERSION),
    });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatch(/unauthorized_peer/);
  });

  it("refuses a worker call carrying the BROKER's token — tokens are per service", async () => {
    const worker: SandboxWorker = { runCommand: async () => RESULT };
    const { port } = await startWorker(worker);
    const answer = await rawPost(port, {
      material: BROKER_CLIENT,
      token: BROKER_TOKEN,
      body: envelopeBody("removeSkills", { volumeName: "v" }, EXEC_PROTOCOL_VERSION),
    });
    expect(answer.status).toBe(401);
  });
});
