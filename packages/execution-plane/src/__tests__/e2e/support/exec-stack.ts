/**
 * The REAL `docker-compose.exec.yml` topology, brought up for the
 * service-boundary E2E battery (exec-plane L5, epic cinatra#1705).
 *
 * Three containers, the shipped compose file, the shipped worker image, the
 * shipped broker bundle: `cinatra-exec-broker` (no docker socket),
 * `cinatra-exec-worker` (the only socket in the topology) and
 * `cinatra-exec-gateway` (the attributing egress proxy, dual-homed onto the one
 * network with a route out). NOTHING in this module stands in for a service. A
 * stubbed handshake, a fabricated lease or an in-process broker would each mask
 * exactly the class of defect this battery exists to catch — a topology that
 * type-checks and unit-tests green but cannot execute a single command.
 *
 * TWO IMAGES, BOTH BUILT FROM THE REPO'S OWN ARTIFACTS:
 *
 *  - the WORKER image is `docker/exec-worker/Dockerfile`, built unmodified. Its
 *    build stage runs `pnpm build:exec-service-bundle`, so the worker bundle and
 *    the gateway script under test are the ones that Dockerfile produces.
 *  - the BROKER image carries `/app/scripts/exec-broker-service.bundle.mjs`,
 *    because that is the entire contract the compose file has with
 *    `CINATRA_APP_IMAGE` (`command: ["node", "/app/scripts/exec-broker-service.bundle.mjs"]`).
 *    The bundle is EXTRACTED FROM THE WORKER IMAGE'S BUILD STAGE — the same
 *    `pnpm build:exec-service-bundle` invocation, in the same container, from the
 *    same sources — and copied onto a bare `node:24-alpine`. Building the full
 *    Next.js app image to obtain one file it merely carries would add a
 *    multi-minute production build and prove nothing about this hop. What runs
 *    is the real broker; what is omitted is app code the broker must never
 *    touch, which is the compose file's own stated invariant.
 *
 * EVERY SECRET AND EVERY CREDENTIAL IS MINTED PER RUN and lives in a temp
 * directory that is removed on teardown. Nothing is committed, nothing is
 * reused, and nothing here is trusted outside the process that created it.
 */

import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createThrowawayCa,
  issueExecLeaf,
  type ExecCertificate,
  type ExecCertificateAuthority,
  type ExecRole,
  type LeafOverrides,
} from "./throwaway-pki";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../..",
);

/**
 * Lane-unique image tags and compose project. The battery must never clobber
 * the `cinatra-sandbox-l0:dev` tag the pre-existing docker battery builds, and
 * must never adopt another project's containers.
 */
export const L0_IMAGE = "cinatra-sandbox-l0:l5e2e";
export const WORKER_IMAGE = "cinatra-exec-worker:l5e2e";
export const BROKER_IMAGE = "cinatra-exec-broker-carrier:l5e2e";
export const COMPOSE_PROJECT = "cinatra-exec-l5e2e";
export const COMPOSE_FILE = "docker-compose.exec.yml";

/** Service names as the compose file declares them (also the DNS aliases). */
export const BROKER_SERVICE = "cinatra-exec-broker";
export const WORKER_SERVICE = "cinatra-exec-worker";
export const GATEWAY_SERVICE = "cinatra-exec-gateway";

/** The internal sandbox network — `internal: true`, fixed name by design. */
export const INTERNAL_NETWORK = "cinatra-exec-internal";

/** The broker's published loopback port, fixed by the compose file. */
export const BROKER_HOST_PORT = 4100;

export type RunResult = { exitCode: number; stdout: string; stderr: string };

export function run(
  file: string,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      {
        cwd: opts.cwd ?? REPO_ROOT,
        timeout: opts.timeoutMs ?? 300_000,
        maxBuffer: 32 * 1024 * 1024,
        ...(opts.env ? { env: opts.env } : {}),
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode:
            error && typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code as number)
              : error
                ? 1
                : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export async function runOrThrow(
  file: string,
  args: readonly string[],
  opts: Parameters<typeof run>[2] = {},
): Promise<RunResult> {
  const result = await run(file, args, opts);
  if (result.exitCode !== 0) {
    throw new Error(
      `${file} ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result;
}

export const docker = (args: readonly string[], opts?: Parameters<typeof run>[2]) =>
  run("docker", args, opts);

// ---------------------------------------------------------------------------
// Host-exclusivity lease documents
// ---------------------------------------------------------------------------

/**
 * The provisioning script's byte layout, reproduced here INDEPENDENTLY of
 * `service/lease.ts` — deliberately.
 *
 * If the battery wrote its fixtures with the very serializer under test, a
 * serializer that drifted from the shell writer would still produce a green
 * run: the test would be comparing the implementation with itself. The literal
 * below is transcribed from the provisioning side's own `printf` — the same
 * source `service/lease.ts` documents itself against — so a drift on either
 * side shows up here as a REFUSAL rather than as agreement.
 */
export function leaseDocument(lease: {
  tenant: string;
  acquiredAtEpochS: number;
  ttlSeconds: number;
  renewedAtEpochS: number;
}): string {
  return (
    `{"tenant":"${lease.tenant}",` +
    `"acquired_at":${lease.acquiredAtEpochS},` +
    `"ttl_seconds":${lease.ttlSeconds},` +
    `"renewed_at":${lease.renewedAtEpochS}}\n`
  );
}

export type ParsedLease = {
  tenant: string;
  acquired_at: number;
  ttl_seconds: number;
  renewed_at: number;
};

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

export type ExecStackOptions = {
  /** Deployment identity — half of every authorized URI SAN. */
  instance: string;
  /** Tenant slug the host-exclusivity lease must name. */
  tenant: string;
  /** Gateway default egress tier (per-job policy still overrides at register). */
  egressMode: "allowlist" | "default_internet";
  egressAllowlist: readonly string[];
  /** Deployment egress CEILING the broker clamps every signed policy against. */
  deploymentMaxMode?: "none" | "allowlist" | "default_internet";
  deploymentMaxAllowlist?: readonly string[];
  deploymentMaxBytesPerJob?: number;
  /** Host-exclusivity renewal cadence (ms). */
  leaseRenewMs: number;
};

export type ExecStack = {
  options: ExecStackOptions;
  ca: ExecCertificateAuthority;
  /** A second, UNRELATED CA — the "wrong CA" arm's issuer. */
  foreignCa: ExecCertificateAuthority;
  brokerUrl: string;
  brokerToken: string;
  workerToken: string;
  gatewayControlSecret: string;
  carrierSecret: string;
  /** Ed25519 voucher SIGNING key. The broker holds only the public half. */
  voucherPrivateKey: KeyObject;
  /** The broker's own `broker-server` URI SAN — the voucher audience. */
  aud: string;
  leaseDir: string;
  leasePath: string;
  tlsDir: string;
  workDir: string;
  leaf(role: ExecRole, overrides?: LeafOverrides): ExecCertificate;
  writeLease(lease: Partial<ParsedLease> & { tenant?: string }): void;
  readLease(): ParsedLease | null;
  removeLease(): void;
  /** Publish a lease the ops way: exclusive temp file in-dir, then atomic mv. */
  publishLeaseAtomically(lease: Partial<ParsedLease> & { tenant?: string }): void;
  containerId(service: string): Promise<string>;
  logs(service: string): Promise<string>;
  down(): Promise<void>;
};

/**
 * The compose variables the shipped file demands. Held at module scope because
 * every compose invocation — up, ps, logs, down — must see the SAME resolution;
 * a `down` run against a different set would leave the topology behind.
 */
let composeEnvSnapshot: Record<string, string> = {};

function compose(args: readonly string[], timeoutMs = 300_000): Promise<RunResult> {
  return run(
    "docker",
    ["compose", "-p", COMPOSE_PROJECT, "-f", COMPOSE_FILE, "--profile", "exec", ...args],
    { timeoutMs, env: { ...process.env, ...composeEnvSnapshot } },
  );
}

const nowEpochS = (): number => Math.floor(Date.now() / 1000);

/**
 * Build both images, mint the PKI and every scoped secret, write the lease, and
 * bring the compose stack up. THROWS on any failure — the battery must fail,
 * never skip, when the real thing cannot run.
 */
export async function bringUpExecStack(options: ExecStackOptions): Promise<ExecStack> {
  const info = await docker(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 60_000 });
  if (info.exitCode !== 0) {
    throw new Error(
      "The execution-plane service-boundary battery requires a running docker daemon and " +
        "docker compose. `docker info` failed: " +
        info.stderr.trim() +
        ". The battery FAILS rather than skips — a green run must always mean the real " +
        "topology ran.",
    );
  }

  // --- images -------------------------------------------------------------
  await runOrThrow("docker", ["build", "-t", L0_IMAGE, "docker/sandbox"], {
    timeoutMs: 600_000,
  });
  await runOrThrow(
    "docker",
    ["build", "-f", "docker/exec-worker/Dockerfile", "-t", WORKER_IMAGE, "."],
    { timeoutMs: 900_000 },
  );

  const workDir = mkdtempSync(path.join(os.tmpdir(), "cinatra-exec-l5-"));
  const brokerCtx = path.join(workDir, "broker-image");
  mkdirSync(brokerCtx, { recursive: true });

  // The broker bundle, taken from the worker Dockerfile's OWN build stage.
  const buildStageTag = `${BROKER_IMAGE}-bundle-src`;
  await runOrThrow(
    "docker",
    [
      "build",
      "--target",
      "build",
      "-f",
      "docker/exec-worker/Dockerfile",
      "-t",
      buildStageTag,
      ".",
    ],
    { timeoutMs: 900_000 },
  );
  const created = await runOrThrow("docker", ["create", buildStageTag, "true"]);
  const bundleContainer = created.stdout.trim();
  try {
    await runOrThrow("docker", [
      "cp",
      `${bundleContainer}:/app/scripts/exec-broker-service.bundle.mjs`,
      path.join(brokerCtx, "exec-broker-service.bundle.mjs"),
    ]);
  } finally {
    await docker(["rm", "-f", bundleContainer]);
  }
  writeFileSync(
    path.join(brokerCtx, "Dockerfile"),
    [
      "# Generated per run by the exec-plane L5 service-boundary battery.",
      "# The compose file's only contract with CINATRA_APP_IMAGE is that it can run",
      "# `node /app/scripts/exec-broker-service.bundle.mjs` — the broker is pure Node",
      "# and, in this topology, has no docker socket and no app configuration at all.",
      "FROM node:24-alpine",
      "WORKDIR /app",
      "COPY exec-broker-service.bundle.mjs /app/scripts/exec-broker-service.bundle.mjs",
      'CMD ["node", "/app/scripts/exec-broker-service.bundle.mjs"]',
      "",
    ].join("\n"),
  );
  await runOrThrow("docker", ["build", "-t", BROKER_IMAGE, brokerCtx], { timeoutMs: 300_000 });

  // --- PKI + secrets ------------------------------------------------------
  const ca = createThrowawayCa(`cinatra-exec-l5-ca-${options.instance}`);
  const foreignCa = createThrowawayCa(`cinatra-exec-l5-foreign-ca-${options.instance}`);
  const leaf = (role: ExecRole, overrides: LeafOverrides = {}): ExecCertificate =>
    issueExecLeaf(ca, options.instance, role, overrides);

  const tlsDir = path.join(workDir, "tls");
  const envDir = path.join(workDir, "env");
  const leaseDir = path.join(workDir, "lease");
  mkdirSync(tlsDir, { recursive: true });
  for (const svc of ["broker", "worker", "gateway"]) {
    mkdirSync(path.join(envDir, svc), { recursive: true });
  }
  mkdirSync(leaseDir, { recursive: true });

  const brokerServer = leaf("broker-server");
  const brokerClient = leaf("broker-client");
  const workerServer = leaf("worker-server");
  writeFileSync(path.join(tlsDir, "ca.crt"), ca.certPem);
  writeFileSync(path.join(tlsDir, "broker-server.crt"), brokerServer.certPem);
  writeFileSync(path.join(tlsDir, "broker-server.key"), brokerServer.keyPem);
  writeFileSync(path.join(tlsDir, "broker-client.crt"), brokerClient.certPem);
  writeFileSync(path.join(tlsDir, "broker-client.key"), brokerClient.keyPem);
  writeFileSync(path.join(tlsDir, "worker-server.crt"), workerServer.certPem);
  writeFileSync(path.join(tlsDir, "worker-server.key"), workerServer.keyPem);

  // VERIFY-ONLY voucher material for the broker; the signing half never leaves
  // this process (the broker is structurally unable to mint — see authz/voucher.ts).
  const voucherPair = generateKeyPairSync("ed25519");
  writeFileSync(
    path.join(tlsDir, "voucher-verify.pub.pem"),
    voucherPair.publicKey.export({ format: "pem", type: "spki" }) as string,
  );

  const brokerToken = randomBytes(32).toString("hex");
  const workerToken = randomBytes(32).toString("hex");
  const gatewayControlSecret = randomBytes(32).toString("hex");
  const carrierSecret = randomBytes(32).toString("hex");

  const envLines = (entries: Record<string, string | undefined>): string =>
    Object.entries(entries)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n";

  writeFileSync(
    path.join(envDir, "broker", ".env"),
    envLines({
      EXECUTION_BROKER_SECRET: carrierSecret,
      EXECUTION_BROKER_SERVICE_TOKEN: brokerToken,
      EXEC_WORKER_SERVICE_TOKEN: workerToken,
      EXEC_HOST_EXCLUSIVITY_TENANT: options.tenant,
      EXEC_GATEWAY_CONTROL_SECRET: gatewayControlSecret,
      EXEC_VOUCHER_VERIFY_PUBLIC_KEY_FILE: "/etc/cinatra-exec/tls/voucher-verify.pub.pem",
      ...(options.deploymentMaxMode ? { EXECUTION_EGRESS_MAX_MODE: options.deploymentMaxMode } : {}),
      ...(options.deploymentMaxAllowlist
        ? { EXECUTION_EGRESS_MAX_ALLOWLIST: options.deploymentMaxAllowlist.join(",") }
        : {}),
      ...(options.deploymentMaxBytesPerJob !== undefined
        ? { EXECUTION_EGRESS_MAX_BYTES_PER_JOB: String(options.deploymentMaxBytesPerJob) }
        : {}),
      // A canary the sandbox must never see. It is scoped to the BROKER's own
      // env file, which is the only place a broker-scoped value may live.
      CINATRA_EXEC_L5_BROKER_CANARY: "broker-scoped-canary-must-not-leak",
    }),
  );
  writeFileSync(
    path.join(envDir, "worker", ".env"),
    envLines({
      EXEC_WORKER_SERVICE_TOKEN: workerToken,
      CINATRA_EXEC_L5_WORKER_CANARY: "worker-scoped-canary-must-not-leak",
    }),
  );
  writeFileSync(
    path.join(envDir, "gateway", ".env"),
    envLines({ EGRESS_CONTROL_SECRET: gatewayControlSecret }),
  );

  const leasePath = path.join(leaseDir, "host-exclusivity.lease");
  const writeLease = (lease: Partial<ParsedLease> & { tenant?: string }): void => {
    const at = lease.acquired_at ?? nowEpochS();
    writeFileSync(
      leasePath,
      leaseDocument({
        tenant: lease.tenant ?? options.tenant,
        acquiredAtEpochS: at,
        ttlSeconds: lease.ttl_seconds ?? 3600,
        renewedAtEpochS: lease.renewed_at ?? at,
      }),
    );
  };
  writeLease({});

  composeEnvSnapshot = {
    CINATRA_APP_IMAGE: BROKER_IMAGE,
    CINATRA_EXEC_WORKER_IMAGE: WORKER_IMAGE,
    CINATRA_SANDBOX_L0_IMAGE: L0_IMAGE,
    CINATRA_EXEC_INSTANCE: options.instance,
    CINATRA_EXEC_ENV_DIR: envDir,
    CINATRA_EXEC_TLS_DIR: tlsDir,
    CINATRA_EXEC_LEASE_DIR: leaseDir,
    CINATRA_EXEC_EGRESS_MODE: options.egressMode,
    CINATRA_EXEC_EGRESS_ALLOWLIST: options.egressAllowlist.join(","),
    CINATRA_EXEC_LEASE_RENEW_MS: String(options.leaseRenewMs),
  };

  const stack: ExecStack = {
    options,
    ca,
    foreignCa,
    brokerUrl: `https://127.0.0.1:${BROKER_HOST_PORT}`,
    brokerToken,
    workerToken,
    gatewayControlSecret,
    carrierSecret,
    voucherPrivateKey: voucherPair.privateKey,
    aud: `cinatra-exec://${options.instance}/broker-server`,
    leaseDir,
    leasePath,
    tlsDir,
    workDir,
    leaf,
    writeLease,
    readLease: () => {
      try {
        return JSON.parse(readFileSync(leasePath, "utf8")) as ParsedLease;
      } catch {
        return null;
      }
    },
    removeLease: () => rmSync(leasePath, { force: true }),
    publishLeaseAtomically: (lease) => {
      const at = lease.acquired_at ?? nowEpochS();
      const body = leaseDocument({
        tenant: lease.tenant ?? options.tenant,
        acquiredAtEpochS: at,
        ttlSeconds: lease.ttl_seconds ?? 3600,
        renewedAtEpochS: lease.renewed_at ?? at,
      });
      const temp = path.join(leaseDir, `.lease.${randomBytes(6).toString("hex")}`);
      writeFileSync(temp, body, { mode: 0o600, flag: "wx" });
      // The ops publish: a fully-formed temp file in the SAME directory, then a
      // rename. A reader only ever sees one whole document.
      renameSync(temp, leasePath);
    },
    containerId: async (service) => {
      const out = await compose(["ps", "-q", service], 60_000);
      const id = out.stdout.trim().split("\n")[0]?.trim() ?? "";
      if (!id) throw new Error(`No running container for compose service "${service}".`);
      return id;
    },
    logs: async (service) => {
      const out = await compose(["logs", "--no-color", service], 60_000);
      return `${out.stdout}\n${out.stderr}`;
    },
    down: async () => {
      await compose(["down", "-v", "--remove-orphans", "-t", "5"], 180_000);
      await sweepExecArtifacts();
      rmSync(workDir, { recursive: true, force: true });
    },
  };

  // --- up -----------------------------------------------------------------
  await reclaimInternalNetwork();
  const up = await compose(["up", "-d", "--wait", "--wait-timeout", "90"], 300_000);
  if (up.exitCode !== 0) {
    const brokerLog = await compose(["logs", "--no-color", BROKER_SERVICE], 60_000);
    await stack.down().catch(() => {});
    throw new Error(
      `The execution-plane compose stack did not come up (exit ${up.exitCode}).\n` +
        `${up.stderr}\n--- broker logs ---\n${brokerLog.stdout}${brokerLog.stderr}`,
    );
  }
  return stack;
}

/**
 * Hand `cinatra-exec-internal` to compose when a previous run left it behind.
 *
 * The name is FIXED by design — the worker is told this exact string and
 * asserts the network really is internal — so it cannot be made lane-unique.
 * The in-process docker battery creates the same network directly (not through
 * compose) and does not remove it, and compose refuses to adopt a network it did
 * not label.
 *
 * The removal is CONDITIONAL and that condition is the safety property: a
 * network with a container still attached is somebody's live work, so it is left
 * alone and `up` fails loudly rather than a sibling being torn out from under
 * its own run. `docker network rm` would refuse anyway; checking first turns a
 * confusing compose error into an explicit decision.
 */
async function reclaimInternalNetwork(): Promise<void> {
  const inspected = await docker([
    "network",
    "inspect",
    "--format",
    "{{len .Containers}}|{{index .Labels \"com.docker.compose.network\"}}",
    INTERNAL_NETWORK,
  ]);
  if (inspected.exitCode !== 0) return; // absent — compose will create it
  const [attached, composeLabel] = inspected.stdout.trim().split("|");
  if (composeLabel && composeLabel.length > 0) return; // already compose-owned
  if (attached !== "0") {
    throw new Error(
      `The fixed sandbox network "${INTERNAL_NETWORK}" exists outside compose and still has ` +
        `${attached} container(s) attached. Refusing to remove it — that is another run's work. ` +
        "Stop whatever is using it and re-run.",
    );
  }
  await docker(["network", "rm", INTERNAL_NETWORK]);
}

/**
 * Remove every volume and container the execution plane stamped its ownership
 * label on. The worker creates these through the HOST socket, so they are not
 * compose-managed and `compose down -v` does not reach them.
 */
export async function sweepExecArtifacts(): Promise<void> {
  const containers = await docker([
    "ps",
    "--all",
    "--quiet",
    "--filter",
    "label=ai.cinatra.execution-plane",
  ]);
  for (const id of containers.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    await docker(["rm", "--force", id]);
  }
  const volumes = await docker([
    "volume",
    "ls",
    "--quiet",
    "--filter",
    "label=ai.cinatra.execution-plane",
  ]);
  for (const name of volumes.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    await docker(["volume", "rm", "--force", name]);
  }
}
