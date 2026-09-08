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
import { generateKeyPairSync, randomBytes, randomInt, type KeyObject } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
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
 * Lane-unique image tags. The battery must never clobber the
 * `cinatra-sandbox-l0:dev` tag the pre-existing docker battery builds, and must
 * never adopt another project's containers — which is also why the compose
 * PROJECT is no longer a constant here but derived per job below.
 */
export const L0_IMAGE = "cinatra-sandbox-l0:l5e2e";
export const WORKER_IMAGE = "cinatra-exec-worker:l5e2e";
export const BROKER_IMAGE = "cinatra-exec-broker-carrier:l5e2e";
export const COMPOSE_FILE = "docker-compose.exec.yml";

/** Service names as the compose file declares them (also the DNS aliases). */
export const BROKER_SERVICE = "cinatra-exec-broker";
export const WORKER_SERVICE = "cinatra-exec-worker";
export const GATEWAY_SERVICE = "cinatra-exec-gateway";

/**
 * THE JOB-SCOPED NAMES — the compose PROJECT this harness brings the stack up
 * under, and the three networks it creates.
 *
 * Each of these used to be a fixed literal, which put every battery on a
 * machine onto ONE project and ONE set of networks. A second battery job on the
 * same runner box then either found the first job's network with a container
 * attached and refused to run, or brought its own stack up and tore the first
 * one down on teardown — in both cases before executing a single assertion
 * (cinatra#3320 for the sandbox network, cinatra#3327 for the project, the
 * gateway's egress leg and the broker's app-facing leg). A machine per job hid
 * that on the hosted road; a shared pool does not.
 *
 * So every name carries THIS JOB'S OWN IDENTITY — the run id, the job and the
 * attempt when the CI environment offers them — plus a short random
 * discriminator, because every leg of a matrix shares all three of those and
 * there is no per-leg identifier in the environment at all. Off CI there is no
 * identity to read and the random half carries the whole name.
 *
 * The three network names are handed to compose as
 * `CINATRA_EXEC_SANDBOX_NETWORK`, `CINATRA_EXEC_EGRESS_NETWORK` and
 * `CINATRA_EXEC_APP_NETWORK`. The sandbox variable does double duty: the
 * compose file uses it BOTH for the network's real `name` and for the
 * `EXEC_SANDBOX_NETWORK` the broker asserts and attaches sandboxes to — one
 * variable, so the two can never drift into naming different networks. Every
 * compose DEFAULT is unchanged, so a deployment that never sets a variable
 * brings up exactly the topology it brought up before.
 *
 * An explicit value in the environment always wins: that is an operator naming
 * the project or the network, and the harness must not fight it.
 */
export const SANDBOX_NETWORK_BASE_NAME = "cinatra-exec-internal";
export const EGRESS_NETWORK_BASE_NAME = "cinatra-exec-egress";
export const APP_NETWORK_BASE_NAME = "cinatra-exec-app";
export const COMPOSE_PROJECT_BASE_NAME = "cinatra-exec-l5e2e";

/**
 * What the names are read from. `process.env` satisfies it, and so does one
 * job's identity written out on its own — which is how the rule is testable
 * without standing up a process environment. Exactly eight variables are ever
 * read: CINATRA_EXEC_SANDBOX_NETWORK, CINATRA_EXEC_EGRESS_NETWORK,
 * CINATRA_EXEC_APP_NETWORK, CINATRA_EXEC_COMPOSE_PROJECT,
 * CINATRA_EXEC_BROKER_HOST_PORT, GITHUB_RUN_ID, GITHUB_JOB,
 * GITHUB_RUN_ATTEMPT.
 */
export type JobScopedNameEnvironment = Readonly<Record<string, string | undefined>>;

/** The job's own identity, reduced to what docker accepts inside a name. */
function jobIdentityOf(env: JobScopedNameEnvironment): string {
  return [env.GITHUB_RUN_ID, env.GITHUB_JOB, env.GITHUB_RUN_ATTEMPT]
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0)
    .join("-")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 32);
}

/** `base-thisJob-random`; off CI the random half carries the whole name. */
function jobScopedName(base: string, env: JobScopedNameEnvironment): string {
  const discriminator = randomBytes(4).toString("hex");
  return [base, jobIdentityOf(env), discriminator].filter(Boolean).join("-");
}

export function sandboxNetworkNameFor(
  env: JobScopedNameEnvironment = process.env,
): string {
  const pinned = env.CINATRA_EXEC_SANDBOX_NETWORK?.trim();
  if (pinned) return pinned;
  return jobScopedName(SANDBOX_NETWORK_BASE_NAME, env);
}

export function egressNetworkNameFor(
  env: JobScopedNameEnvironment = process.env,
): string {
  const pinned = env.CINATRA_EXEC_EGRESS_NETWORK?.trim();
  if (pinned) return pinned;
  return jobScopedName(EGRESS_NETWORK_BASE_NAME, env);
}

/**
 * The broker's app-facing leg, on the same rule. This one is not shared between
 * jobs in the way the other two were — compose REFUSES it outright: a network
 * that already exists under another project's ownership is not adopted, so the
 * first job on a runner box owned the fixed name and every later job's `up`
 * failed with "a network with name cinatra-exec-app exists but was not created
 * for project ..." before a single assertion ran.
 */
export function appNetworkNameFor(
  env: JobScopedNameEnvironment = process.env,
): string {
  const pinned = env.CINATRA_EXEC_APP_NETWORK?.trim();
  if (pinned) return pinned;
  return jobScopedName(APP_NETWORK_BASE_NAME, env);
}

/**
 * The compose PROJECT name, on the same rule — but compose accepts a NARROWER
 * alphabet than docker does for a network: lower case, no dots. A job name is
 * free to carry both, so the derived name is folded down rather than handed to
 * compose to reject.
 */
export function composeProjectNameFor(
  env: JobScopedNameEnvironment = process.env,
): string {
  const pinned = env.CINATRA_EXEC_COMPOSE_PROJECT?.trim();
  if (pinned) return pinned;
  return jobScopedName(COMPOSE_PROJECT_BASE_NAME, env)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
}

/**
 * Whether a name was PINNED in the environment rather than derived here.
 *
 * This is the difference between a name this process invented — which nothing
 * else on the machine can be using, because it carries this job's identity and
 * a random discriminator — and a name an operator chose, which may well be an
 * existing network somebody else provisioned. Reclaim below is allowed to
 * remove the first kind and never the second: choosing a name is not consent to
 * have that network destroyed and recreated with the battery's own settings.
 */
export function nameIsPinned(
  variable:
    | "CINATRA_EXEC_SANDBOX_NETWORK"
    | "CINATRA_EXEC_EGRESS_NETWORK"
    | "CINATRA_EXEC_APP_NETWORK"
    | "CINATRA_EXEC_COMPOSE_PROJECT",
  env: JobScopedNameEnvironment = process.env,
): boolean {
  return (env[variable]?.trim() ?? "").length > 0;
}

/**
 * Resolved ONCE, at import: `up`, `ps`, `logs`, `down` and the reclaim step
 * below must all name the same project and the same networks, and a value
 * re-derived per call would leave a stack behind on teardown.
 */
export const INTERNAL_NETWORK = sandboxNetworkNameFor();
export const EGRESS_NETWORK = egressNetworkNameFor();
export const APP_NETWORK = appNetworkNameFor();
export const COMPOSE_PROJECT = composeProjectNameFor();

/** Same resolution, remembered: reclaim must not touch an operator's network. */
const INTERNAL_NETWORK_PINNED = nameIsPinned("CINATRA_EXEC_SANDBOX_NETWORK");
const EGRESS_NETWORK_PINNED = nameIsPinned("CINATRA_EXEC_EGRESS_NETWORK");
const APP_NETWORK_PINNED = nameIsPinned("CINATRA_EXEC_APP_NETWORK");

/**
 * The broker's PUBLISHED loopback port, on the same rule as the names above and
 * for the same reason: a published port is a HOST-wide object, not a
 * project-scoped one. Two stacks on one runner box cannot both bind
 * 127.0.0.1:4100, so a fixed publish turns the second job away at `up` exactly
 * the way the fixed network name did — the same collision one layer down.
 *
 * Only the HOST side moves. The container port stays 4100, every in-topology
 * dial stays what it was, and an unset variable leaves an ordinary deployment
 * publishing 4100, the port it has always published.
 *
 * The port is drawn from this process's own randomness rather than from the job
 * identity: every leg of a matrix shares run id, job and attempt, so identity
 * alone would put two concurrent legs back onto one port. The range sits below
 * the usual ephemeral range so an outgoing socket on the box is not holding it.
 */
export const BROKER_HOST_PORT_BASE = 4100;
const BROKER_HOST_PORT_RANGE_START = 20_000;
const BROKER_HOST_PORT_RANGE_END = 31_999;

export function brokerHostPortFor(env: JobScopedNameEnvironment = process.env): number {
  const pinned = env.CINATRA_EXEC_BROKER_HOST_PORT?.trim();
  if (pinned) {
    const parsed = Number(pinned);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
      throw new Error(
        `CINATRA_EXEC_BROKER_HOST_PORT must be a TCP port between 1 and 65535, got "${pinned}".`,
      );
    }
    return parsed;
  }
  // Drawn uniformly across the whole range. A modulo over raw random bytes
  // would lean on the low end of it — the span is not a whole divisor of the
  // byte width, so the first values of the range would come up more often than
  // the last — and a port picked more often is a port two stacks collide on
  // more often, which is the very thing this range exists to avoid.
  return randomInt(BROKER_HOST_PORT_RANGE_START, BROKER_HOST_PORT_RANGE_END + 1);
}

/** Resolved ONCE, like the names: the publish and every client must agree. */
export const BROKER_HOST_PORT = brokerHostPortFor();

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
  /**
   * Where the broker's DURABLE AUDIT SPOOL lives.
   *
   * `"compose-default"` (the default, and what every pre-existing arm gets)
   * leaves `CINATRA_EXEC_AUDIT_SPOOL_DIR` unset, so the compose file's own
   * default host path is used — unchanged behaviour.
   *
   * `"per-run"` points it at a fresh directory inside this run's temp
   * `workDir`, which `down()` removes. A battery that ASSERTS on spool
   * contents needs that isolation: the shared default path outlives a
   * `compose down -v` (it is a bind mount, not a compose volume), so a second
   * battery on the same host would otherwise read the first one's unacked
   * records and count them as its own.
   */
  auditSpool?: "compose-default" | "per-run";
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
  /**
   * Write the lease IN PLACE — a truncating `writeFileSync`, deliberately NOT
   * the temp-file-plus-rename publish `publishLeaseAtomically` does.
   *
   * That choice is a canary, and removing it would remove the only thing that
   * caught cinatra#2325. A rename-publish needs permission on the DIRECTORY
   * only, so it succeeds against a lease file this process can neither read nor
   * write; an in-place write is the operation that actually requires the
   * provisioning side to still OWN the document. If a broker renewal ever again
   * takes the lease away from the host identity that provisioned it, this is
   * where the battery finds out.
   */
  writeLease(lease: Partial<ParsedLease> & { tenant?: string }): void;
  readLease(): ParsedLease | null;
  /** The lease document's on-disk identity, as the HOST sees it. */
  leaseIdentity(): { uid: number; gid: number; mode: number } | null;
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

  const auditSpoolDir =
    options.auditSpool === "per-run" ? path.join(workDir, "audit-spool") : null;
  if (auditSpoolDir) mkdirSync(auditSpoolDir, { recursive: true });

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
    CINATRA_EXEC_SANDBOX_NETWORK: INTERNAL_NETWORK,
    CINATRA_EXEC_EGRESS_NETWORK: EGRESS_NETWORK,
    CINATRA_EXEC_APP_NETWORK: APP_NETWORK,
    CINATRA_EXEC_BROKER_HOST_PORT: String(BROKER_HOST_PORT),
    CINATRA_EXEC_ENV_DIR: envDir,
    CINATRA_EXEC_TLS_DIR: tlsDir,
    CINATRA_EXEC_LEASE_DIR: leaseDir,
    CINATRA_EXEC_EGRESS_MODE: options.egressMode,
    CINATRA_EXEC_EGRESS_ALLOWLIST: options.egressAllowlist.join(","),
    CINATRA_EXEC_LEASE_RENEW_MS: String(options.leaseRenewMs),
    ...(auditSpoolDir ? { CINATRA_EXEC_AUDIT_SPOOL_DIR: auditSpoolDir } : {}),
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
    leaseIdentity: () => {
      try {
        const stats = statSync(leasePath);
        return { uid: stats.uid, gid: stats.gid, mode: stats.mode & 0o777 };
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
  await reclaimJobNetwork(INTERNAL_NETWORK, "sandbox", INTERNAL_NETWORK_PINNED);
  await reclaimJobNetwork(EGRESS_NETWORK, "egress", EGRESS_NETWORK_PINNED);
  await reclaimJobNetwork(APP_NETWORK, "app", APP_NETWORK_PINNED);
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
 * Hand THIS JOB'S OWN network to compose when an earlier attempt left it behind.
 *
 * Every name this step can be given carries the job's identity and a random
 * discriminator (see `jobScopedName`), so a DERIVED name can only ever be one
 * this process itself invented: a sibling battery on the same machine has
 * different names and is never touched, and the in-process docker battery —
 * which creates the deployment-default network directly, not through compose,
 * and does not remove it — no longer shares a name with this one. Those shared
 * names are the collisions cinatra#3320 and cinatra#3327 closed.
 *
 * A PINNED name is the one case where that reasoning does not hold, so it is
 * refused outright. An operator who sets `CINATRA_EXEC_SANDBOX_NETWORK`,
 * `CINATRA_EXEC_EGRESS_NETWORK` or `CINATRA_EXEC_APP_NETWORK` may well be naming
 * a network somebody else provisioned, and an idle network is not an abandoned
 * one: removing it would silently replace its configuration with the battery's.
 * Naming a network is not consent to have it destroyed. Compose then either
 * adopts the network as it stands or fails saying so, which is the operator's
 * decision to make.
 *
 * For a derived name the removal stays CONDITIONAL and that condition is the
 * safety property: a network with a container still attached is somebody's live
 * work, so it is left alone and `up` fails loudly rather than a sibling being
 * torn out from under its own run. `docker network rm` would refuse anyway;
 * checking first turns a confusing compose error into an explicit decision. The
 * compose-owned early return is a leftover of this job's own previous attempt
 * under the same derived name, which `down` is entitled to clear up.
 */
async function reclaimJobNetwork(
  network: string,
  role: string,
  pinned: boolean,
): Promise<void> {
  // An operator's own name: inspect nothing, remove nothing.
  if (pinned) return;
  const inspected = await docker([
    "network",
    "inspect",
    "--format",
    "{{len .Containers}}|{{index .Labels \"com.docker.compose.network\"}}",
    network,
  ]);
  if (inspected.exitCode !== 0) return; // absent — compose will create it
  const [attached, composeLabel] = inspected.stdout.trim().split("|");
  if (composeLabel && composeLabel.length > 0) return; // already compose-owned
  if (attached !== "0") {
    throw new Error(
      `The ${role} network "${network}" named for this job exists outside compose ` +
        `and still has ${attached} container(s) attached. Refusing to remove it — that is ` +
        "another run's work. Stop whatever is using it and re-run.",
    );
  }
  await docker(["network", "rm", network]);
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
