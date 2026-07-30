/**
 * Service ENTRYPOINT composition tests (exec-plane S1 remainder, epic
 * cinatra#1705).
 *
 * The entrypoints' most important behaviour is what they REFUSE. Two host seams
 * the merged broker takes as injections have no remote binding in this slice
 * (per-command run liveness, and worker-routed volume operations), and the
 * dangerous outcome would be a broker that starts anyway and quietly runs with a
 * weaker posture. These tests pin the refusals, the messages that name them, and
 * the fail-closed protocol-version assertion at start-up.
 */

import { afterEach, describe, expect, it } from "vitest";

import { composeBrokerService } from "../broker-entry";
import {
  EKU_CLIENT_AUTH,
  EKU_SERVER_AUTH,
  execServiceUri,
  type ExecTlsMaterial,
} from "../mtls";
import { EXEC_PROTOCOL_VERSION, EXEC_PROTOCOL_VERSION_ENV } from "../protocol";
import { composeWorkerService } from "../worker-entry";
import { createWorkerService } from "../worker-server";
import { createTestCa } from "./test-pki";

const INSTANCE = "entry-inst";
const ca = createTestCa();

function pemEnv(
  role: "broker-server" | "worker-server" | "broker-client",
  eku: string = EKU_SERVER_AUTH,
): Record<string, string> {
  const leaf = ca.issue({
    commonName: role,
    uris: [execServiceUri(INSTANCE, role)],
    extendedKeyUsage: [eku],
  });
  // The loader takes PATHS; the tests inject a reader instead of touching disk,
  // so these values are the map keys the fake reader resolves.
  return { cert: leaf.certPem, key: leaf.keyPem, ca: ca.caPem };
}

const BROKER_PEM = pemEnv("broker-server");
const WORKER_PEM = pemEnv("worker-server");
/**
 * The broker's SECOND leaf. A broker both listens (`broker-server`) and dials
 * (`broker-client`), and `mtls.ts` admits exactly one URI SAN plus the
 * direction-appropriate EKU per credential — so the two hops need two leaves.
 */
const BROKER_CLIENT_PEM = pemEnv("broker-client", EKU_CLIENT_AUTH);

const teardown: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()?.();
});

/**
 * `loadExecTlsMaterial` reads from the filesystem, so the entry tests write the
 * PEMs to a temp dir. Kept tiny and deterministic.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tlsEnv(pem: Record<string, string>): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "exec-entry-"));
  const paths = {
    EXEC_TLS_CERT_FILE: join(dir, "svc.crt"),
    EXEC_TLS_KEY_FILE: join(dir, "svc.key"),
    EXEC_TLS_CA_FILE: join(dir, "ca.crt"),
  };
  writeFileSync(paths.EXEC_TLS_CERT_FILE, pem.cert as string);
  writeFileSync(paths.EXEC_TLS_KEY_FILE, pem.key as string);
  writeFileSync(paths.EXEC_TLS_CA_FILE, pem.ca as string);
  return paths;
}

/** The dialing leaf's own file pair (the CA is shared with the listening one). */
function clientTlsEnv(pem: Record<string, string>): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "exec-entry-client-"));
  const paths = {
    EXEC_TLS_CLIENT_CERT_FILE: join(dir, "client.crt"),
    EXEC_TLS_CLIENT_KEY_FILE: join(dir, "client.key"),
  };
  writeFileSync(paths.EXEC_TLS_CLIENT_CERT_FILE, pem.cert as string);
  writeFileSync(paths.EXEC_TLS_CLIENT_KEY_FILE, pem.key as string);
  return paths;
}

function brokerEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    EXEC_INSTANCE: INSTANCE,
    EXECUTION_BROKER_SERVICE_TOKEN: "broker-token-aaaaaaaaaaaaaaaaaaaa",
    EXEC_WORKER_URL: "https://cinatra-exec-worker:4200",
    EXEC_WORKER_SERVICE_TOKEN: "worker-token-bbbbbbbbbbbbbbbbbbbb",
    EXEC_BROKER_RUN_LIVENESS: "carrier-ttl-only",
    EXEC_BROKER_VOLUME_OPS: "host-docker",
    EXEC_EGRESS_MODE: "none",
    ...tlsEnv(BROKER_PEM),
    ...clientTlsEnv(BROKER_CLIENT_PEM),
    ...overrides,
  };
}

function workerEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    EXEC_INSTANCE: INSTANCE,
    EXEC_WORKER_SERVICE_TOKEN: "worker-token-bbbbbbbbbbbbbbbbbbbb",
    ...tlsEnv(WORKER_PEM),
    ...overrides,
  };
}

describe("broker entry — fail-closed on unwired seams", () => {
  it("refuses to start without the run-liveness acknowledgement, naming the deficit", () => {
    expect(() => composeBrokerService(brokerEnv({ EXEC_BROKER_RUN_LIVENESS: undefined }))).toThrow(
      /RUN-LIVENESS probe has no remote binding/,
    );
    expect(() => composeBrokerService(brokerEnv({ EXEC_BROKER_RUN_LIVENESS: "store" }))).toThrow(
      /EXEC_BROKER_RUN_LIVENESS=carrier-ttl-only/,
    );
  });

  it("refuses to start without the volume-ops acknowledgement", () => {
    expect(() => composeBrokerService(brokerEnv({ EXEC_BROKER_VOLUME_OPS: undefined }))).toThrow(
      /EXEC_BROKER_VOLUME_OPS=host-docker/,
    );
  });

  it("refuses to start without an instance, a token, a worker URL or TLS material", () => {
    expect(() => composeBrokerService(brokerEnv({ EXEC_INSTANCE: undefined }))).toThrow(
      /EXEC_INSTANCE is required/,
    );
    expect(() =>
      composeBrokerService(brokerEnv({ EXECUTION_BROKER_SERVICE_TOKEN: undefined })),
    ).toThrow(/EXECUTION_BROKER_SERVICE_TOKEN is required/);
    expect(() => composeBrokerService(brokerEnv({ EXEC_WORKER_URL: undefined }))).toThrow(
      /EXEC_WORKER_URL is required/,
    );
    expect(() => composeBrokerService(brokerEnv({ EXEC_TLS_CA_FILE: undefined }))).toThrow(
      /EXEC_TLS_CA_FILE/,
    );
  });

  it("refuses a plaintext worker URL — the hop is mutually-authenticated TLS", () => {
    expect(() =>
      composeBrokerService(brokerEnv({ EXEC_WORKER_URL: "http://cinatra-exec-worker:4200" })),
    ).toThrow(/not https/);
  });

  it("refuses a declared protocol version that is not this build's", () => {
    expect(() =>
      composeBrokerService(
        brokerEnv({ [EXEC_PROTOCOL_VERSION_ENV]: String(EXEC_PROTOCOL_VERSION + 1) }),
      ),
    ).toThrow(/lockstep deploy/);
  });

  it("requires a complete gateway config for every gateway-requiring egress tier", () => {
    expect(() =>
      composeBrokerService(brokerEnv({ EXEC_EGRESS_MODE: "allowlist" })),
    ).toThrow(/EXEC_GATEWAY_HOST is required/);
    expect(() =>
      composeBrokerService(
        brokerEnv({ EXEC_EGRESS_MODE: "default_internet", EXEC_GATEWAY_HOST: "gw" }),
      ),
    ).toThrow(/EXEC_GATEWAY_PORT is required/);
  });

  it("refuses an unknown egress tier", () => {
    expect(() => composeBrokerService(brokerEnv({ EXEC_EGRESS_MODE: "wide-open" }))).toThrow(
      /EXEC_EGRESS_MODE must be one of/,
    );
  });

  it("composes a listening-ready service when every seam is acknowledged", async () => {
    const composed = composeBrokerService(brokerEnv());
    expect(composed.port).toBe(4100);
    expect(composed.address).toBe("0.0.0.0");
    expect(composed.service.server.listening).toBe(false);
    await composed.stop();
  });

  it("refuses to start without the DIALING credential — one leaf cannot serve both hops", () => {
    expect(() =>
      composeBrokerService(brokerEnv({ EXEC_TLS_CLIENT_CERT_FILE: undefined })),
    ).toThrow(/EXEC_TLS_CLIENT_CERT_FILE/);
    expect(() =>
      composeBrokerService(brokerEnv({ EXEC_TLS_CLIENT_KEY_FILE: undefined })),
    ).toThrow(/EXEC_TLS_CLIENT_KEY_FILE/);
  });

  /**
   * THE TEST THAT PROVES THE CREDENTIAL WIRING, not merely that it composed.
   *
   * A composition assertion cannot tell a `broker-client` leaf from a
   * `broker-server` one — both load, both are valid, and the service object looks
   * identical. Only a real handshake against a real worker can: the worker demands
   * a byte-exact `cinatra-exec://<instance>/broker-client` URI SAN and a
   * `clientAuth` EKU, so a broker that dialed with its LISTENING leaf would be
   * refused `unauthorized_peer` on every single call — a broker that can never
   * reach its worker, and nothing short of this test would have caught it.
   */
  it("dials a REAL worker with the broker-client leaf and completes the hop", async () => {
    const ran: string[] = [];
    const worker = createWorkerService({
      worker: {
        runCommand: async (spec) => {
          ran.push(spec.command);
          return {
            exitCode: 0,
            stdout: "two-leaf-handshake",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            termination: "exited" as const,
            wallMs: 1,
            imageDigest: "sha256:feed",
            workspaceKb: 1,
          };
        },
      },
      instance: INSTANCE,
      serviceToken: "worker-token-bbbbbbbbbbbbbbbbbbbb",
      tls: {
        certPem: WORKER_PEM.cert as string,
        keyPem: WORKER_PEM.key as string,
        caPem: WORKER_PEM.ca as string,
      } satisfies ExecTlsMaterial,
    });
    await new Promise<void>((resolve) =>
      worker.server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = worker.server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    teardown.push(() => worker.close());

    const composed = composeBrokerService(
      brokerEnv({ EXEC_WORKER_URL: `https://127.0.0.1:${address.port}` }),
    );
    teardown.push(() => composed.stop());

    const result = await composed.workerClient.runCommand({
      jobId: "job-entry-1",
      command: "printf two-leaf-handshake",
      workspaceVolume: "cinatra-exec-l2-entry",
      egress: { kind: "none" },
      limits: {
        cpus: 1,
        memoryMb: 1024,
        pidsLimit: 256,
        timeoutMs: 120_000,
        maxStdioBytes: 1_048_576,
        workspaceQuotaKb: 262_144,
      },
    });
    expect(result.stdout).toBe("two-leaf-handshake");
    expect(ran).toEqual(["printf two-leaf-handshake"]);
  });

  it("honours an explicit port and bind address", async () => {
    const composed = composeBrokerService(
      brokerEnv({ EXEC_BROKER_LISTEN_PORT: "4321", EXEC_LISTEN_ADDRESS: "127.0.0.1" }),
    );
    expect(composed.port).toBe(4321);
    expect(composed.address).toBe("127.0.0.1");
    await composed.stop();
  });
});

describe("worker entry", () => {
  it("composes with no acknowledgements — running containers on its own host IS the design", async () => {
    const composed = composeWorkerService(workerEnv());
    expect(composed.port).toBe(4200);
    expect(composed.service.server.listening).toBe(false);
    await composed.stop();
  });

  it("refuses to start without an instance, a token or TLS material", () => {
    expect(() => composeWorkerService(workerEnv({ EXEC_INSTANCE: undefined }))).toThrow(
      /EXEC_INSTANCE is required/,
    );
    expect(() =>
      composeWorkerService(workerEnv({ EXEC_WORKER_SERVICE_TOKEN: undefined })),
    ).toThrow(/EXEC_WORKER_SERVICE_TOKEN is required/);
    expect(() => composeWorkerService(workerEnv({ EXEC_TLS_KEY_FILE: undefined }))).toThrow(
      /EXEC_TLS_KEY_FILE/,
    );
  });

  it("refuses a mismatched declared protocol version", () => {
    expect(() =>
      composeWorkerService(
        workerEnv({ [EXEC_PROTOCOL_VERSION_ENV]: String(EXEC_PROTOCOL_VERSION + 1) }),
      ),
    ).toThrow(/lockstep deploy/);
  });

  it("refuses a non-numeric listen port", () => {
    expect(() => composeWorkerService(workerEnv({ EXEC_WORKER_LISTEN_PORT: "nope" }))).toThrow(
      /positive port number/,
    );
  });
});
