/**
 * Broker service ENTRYPOINT (exec-plane S1 remainder, epic cinatra#1705).
 *
 * The runnable half of `broker-server.ts`, kept in its own module for the same
 * reason `runtime/egress-gateway.cjs` is its own file and not part of the
 * package barrel: the package index must stay free of any module that listens,
 * reads `process.argv` or touches the filesystem at import time. `src/index.ts`
 * therefore exports the FACTORY, and this file — the esbuild entry for
 * `pnpm build:exec-service-bundle` — is what a container runs.
 *
 * CONFIGURATION IS SCOPED ENV ONLY (ops#517). Every value below is an exec-plane
 * variable; the app's secret surface (SUPABASE_DB_URL, BETTER_AUTH_SECRET,
 * CINATRA_ENCRYPTION_KEY, provider API keys, …) must never reach this service,
 * and the ops-side deploy guard refuses a deploy that would hand it one.
 *
 * FAIL-CLOSED START-UP, INCLUDING ABOUT WHAT IS NOT WIRED YET. Two host seams
 * the merged broker takes as injections have no REMOTE binding in this slice,
 * and pretending otherwise would be the dangerous outcome:
 *
 *   * RUN LIVENESS. In-process the probe reads the agent-run store, so a
 *     hard-removed run fails the NEXT command closed. A remote broker has no
 *     store. The merged contract's documented posture for a host that cannot
 *     answer is `"alive"` + reliance on carrier expiry — which is a real, bounded
 *     posture but a WEAKER one, so it must be an explicit operator decision,
 *     never a silent default. `EXEC_BROKER_RUN_LIVENESS=carrier-ttl-only` is that
 *     acknowledgement; without it the service refuses to start.
 *
 *   * VOLUME OPS. Since exec-plane L3 both bindings exist and the choice is the
 *     operator's, still with no inferable default:
 *     `EXEC_BROKER_VOLUME_OPS=worker-routed` places the L2 workspace and
 *     read-only skills lifecycles on the WORKER host over the typed volume-ops
 *     seam — the deployed topology, in which the broker container has no docker
 *     socket at all — while `host-docker` keeps them on the broker host
 *     (local/single-host). Without either the service refuses to start.
 *
 * Both refusals name the missing binding verbatim so an operator is never left
 * guessing, and neither can be satisfied by accident.
 *
 * HOST EXCLUSIVITY (exec-plane L3). A spoke that runs workers IN-VM is
 * single-tenant for local execution, enforced by a lease the provisioning side
 * takes on the host. `EXEC_HOST_EXCLUSIVITY=enforced` (+
 * `EXEC_HOST_EXCLUSIVITY_TENANT`) makes the broker revalidate that lease before
 * every placement decision and drain when it stops holding;
 * `not-applicable` is the explicit statement that this broker's workers are not
 * host-exclusive. See `lease.ts` for why the lease is read BY PATH every time.
 *
 * TWO TLS CREDENTIALS, because the broker is two identities. It LISTENS to the
 * app as `broker-server` and DIALS a worker as `broker-client`, and `mtls.ts`
 * admits exactly one URI SAN plus the direction-appropriate EKU per credential —
 * so one leaf cannot serve both hops. `EXEC_TLS_CERT_FILE`/`_KEY_FILE` is the
 * listening leaf; `EXEC_TLS_CLIENT_CERT_FILE`/`_KEY_FILE` is the dialing one;
 * `EXEC_TLS_CA_FILE` is shared (one PKI, two leaves). Both are required.
 *
 * THE PER-COMMAND VOUCHER (epic #1705 L2, `authz/voucher.ts`). This service
 * holds VERIFY-ONLY Ed25519 public key material — `EXEC_VOUCHER_VERIFY_PUBLIC_KEY_FILE`,
 * an SPKI PEM file path — and is structurally unable to mint (the signing half
 * lives solely in the app's mint site). `aud` is derived from this broker's own
 * `broker-server` URI SAN (`EXEC_INSTANCE`), never separately configured, so a
 * voucher's audience and this service's mTLS identity can never drift apart.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { ExecutionVoucherVerifier } from "../authz/voucher";
import { ExecutionBroker } from "../broker";
import { DEFAULT_SANDBOX_NETWORK } from "../egress";
import type {
  EgressGatewayEndpoint,
  EgressMode,
  EgressPolicy,
  PlacementGuard,
} from "../types";
import {
  HOST_EXCLUSIVITY_LEASE_PATH_ENV,
  HOST_EXCLUSIVITY_MODE_ENV,
  HOST_EXCLUSIVITY_RENEW_INTERVAL_ENV,
  HOST_EXCLUSIVITY_TENANT_ENV,
  HostExclusivityLeaseGuard,
  hostExclusivityPlacementGuard,
  startHostExclusivityRenewal,
} from "./lease";
import {
  createBrokerService,
  createBufferedAuditRelay,
  type BrokerService,
} from "./broker-server";
import { execServiceUri, loadExecClientTlsMaterial, loadExecTlsMaterial } from "./mtls";
import { EXEC_PROTOCOL_VERSION, EXEC_PROTOCOL_VERSION_ENV } from "./protocol";
import { describeThrown } from "./rpc-transport";
import { WorkerServiceClient } from "./worker-client";

/**
 * Scoped env var carrying the path to the broker's VERIFY-ONLY Ed25519 voucher
 * key (SPKI PEM). Mirrors the `EXEC_TLS_*_FILE` convention: an ops-provisioned
 * file path, never the key material itself in the environment.
 */
export const EXEC_VOUCHER_VERIFY_PUBLIC_KEY_FILE_ENV = "EXEC_VOUCHER_VERIFY_PUBLIC_KEY_FILE";

export const DEFAULT_BROKER_LISTEN_PORT = 4100;

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(
      `Refusing to start the execution-plane broker service: ${key} is required (fail-closed).`,
    );
  }
  return value;
}

/**
 * The deployed wire version must match this build EXACTLY. A mismatch here is
 * the same fail-closed refusal a mismatched REQUEST gets — caught at start-up
 * instead of on the first command.
 */
export function assertProtocolVersionEnv(env: Env): void {
  const declared = env[EXEC_PROTOCOL_VERSION_ENV]?.trim();
  if (declared === undefined || declared === "") return; // unset ⇒ this build's version
  if (declared !== String(EXEC_PROTOCOL_VERSION)) {
    throw new Error(
      `${EXEC_PROTOCOL_VERSION_ENV}=${declared} does not match this build's wire protocol ` +
        `version ${EXEC_PROTOCOL_VERSION}; refusing to start (a version bump is a lockstep deploy).`,
    );
  }
}

function egressPolicyFromEnv(env: Env): EgressPolicy {
  const mode = (env.EXEC_EGRESS_MODE?.trim() || "default_internet") as EgressMode;
  if (mode !== "default_internet" && mode !== "allowlist" && mode !== "none") {
    throw new Error(
      `EXEC_EGRESS_MODE must be one of default_internet | allowlist | none (got "${mode}").`,
    );
  }
  if (mode === "none") return { mode: "none" };
  const allowlist = (env.EXEC_EGRESS_ALLOWLIST ?? "")
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
  const maxBytes = Number(env.EXEC_EGRESS_MAX_BYTES_PER_JOB ?? 0);
  return {
    mode,
    ...(mode === "allowlist" ? { allowlist } : {}),
    ...(Number.isFinite(maxBytes) && maxBytes > 0 ? { maxBytesPerJob: maxBytes } : {}),
  };
}

function gatewayFromEnv(env: Env, policy: EgressPolicy): EgressGatewayEndpoint | undefined {
  if (policy.mode === "none") return undefined;
  // Every gateway-requiring tier NEEDS the attributing gateway: the merged
  // `resolveEgress` refuses fail-closed rather than granting an unattributed
  // route, so an incomplete gateway config must fail here, loudly.
  const host = required(env, "EXEC_GATEWAY_HOST");
  const port = Number(required(env, "EXEC_GATEWAY_PORT"));
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`EXEC_GATEWAY_PORT must be a positive port number (got "${env.EXEC_GATEWAY_PORT}").`);
  }
  const adminUrl = env.EXEC_GATEWAY_ADMIN_URL?.trim();
  const controlSecret = env.EXEC_GATEWAY_CONTROL_SECRET;
  return {
    host,
    port,
    ...(adminUrl ? { adminUrl } : {}),
    ...(controlSecret ? { controlSecret } : {}),
  };
}

/**
 * Compose the host-exclusivity precondition from scoped env (exec-plane L3).
 *
 * THREE-VALUED ON PURPOSE. `enforced` builds the guard; `not-applicable` is an
 * explicit operator statement that this broker does not place work on a
 * host-exclusive spoke; anything else — including a typo — refuses to start.
 * Leaving the variable UNSET keeps the merged behaviour (no guard), because a
 * broker whose worker pool is off-host has no host to be exclusive about and
 * must not be broken by this slice. A spoke running workers IN-VM sets
 * `enforced`; the shipped `docker-compose.exec.yml` does.
 */
function composeHostExclusivity(
  env: Env,
): { guard: PlacementGuard; renewIntervalMs: number; leaseGuard: HostExclusivityLeaseGuard } | undefined {
  const mode = env[HOST_EXCLUSIVITY_MODE_ENV]?.trim();
  if (mode === undefined || mode === "" || mode === "not-applicable") return undefined;
  if (mode !== "enforced") {
    throw new Error(
      `${HOST_EXCLUSIVITY_MODE_ENV} must be "enforced" or "not-applicable" (got "${mode}").`,
    );
  }
  const tenant = required(env, HOST_EXCLUSIVITY_TENANT_ENV);
  const leasePath = env[HOST_EXCLUSIVITY_LEASE_PATH_ENV]?.trim();
  const leaseGuard = new HostExclusivityLeaseGuard({
    tenant,
    ...(leasePath ? { leasePath } : {}),
  });
  const rawInterval = env[HOST_EXCLUSIVITY_RENEW_INTERVAL_ENV]?.trim();
  const renewIntervalMs = rawInterval ? Number(rawInterval) : 0;
  if (!Number.isFinite(renewIntervalMs) || renewIntervalMs < 0) {
    throw new Error(
      `${HOST_EXCLUSIVITY_RENEW_INTERVAL_ENV} must be a non-negative number of milliseconds ` +
        `(got "${rawInterval}"); 0 disables renewal.`,
    );
  }
  return {
    guard: hostExclusivityPlacementGuard(leaseGuard),
    renewIntervalMs,
    leaseGuard,
  };
}

export type BrokerEntryComposition = {
  service: BrokerService;
  port: number;
  address: string;
  /**
   * The composed broker→worker client, exposed so the composition's OWN
   * credential wiring is provable against a real worker over a real handshake —
   * a composition test that only asserts "it composed" cannot tell a
   * `broker-client` leaf from a `broker-server` one, and that gap is exactly how
   * a broker that can never reach its worker would ship.
   */
  workerClient: WorkerServiceClient;
  /** Release the worker client's keep-alive agent + close the server. */
  stop: () => Promise<void>;
};

/**
 * Compose the broker service from scoped env. Pure composition — it does NOT
 * listen, so tests can assert every refusal without opening a socket.
 */
export function composeBrokerService(env: Env = process.env): BrokerEntryComposition {
  assertProtocolVersionEnv(env);

  const liveness = env.EXEC_BROKER_RUN_LIVENESS?.trim();
  if (liveness !== "carrier-ttl-only") {
    throw new Error(
      "Refusing to start the execution-plane broker service: the per-command RUN-LIVENESS " +
        "probe has no remote binding in this slice. Set " +
        "EXEC_BROKER_RUN_LIVENESS=carrier-ttl-only to acknowledge that liveness is bounded " +
        "by the sealed carrier's TTL only (the merged contract's documented posture for a " +
        "host that cannot consult the run store) — a hard-removed run will NOT fail the next " +
        "command closed until the app-side probe seam is wired.",
    );
  }
  const volumeOpsMode = env.EXEC_BROKER_VOLUME_OPS?.trim();
  if (volumeOpsMode !== "host-docker" && volumeOpsMode !== "worker-routed") {
    throw new Error(
      "Refusing to start the execution-plane broker service: where its L2 workspace and " +
        "read-only skills volumes are provisioned is not an inferable default. Set " +
        "EXEC_BROKER_VOLUME_OPS=worker-routed to place them on the WORKER host over the " +
        "typed volume-ops seam (the broker then needs no docker of its own — this is the " +
        "deployed topology), or EXEC_BROKER_VOLUME_OPS=host-docker to acknowledge that the " +
        "BROKER host has docker and performs them itself (local/single-host).",
    );
  }

  const instance = required(env, "EXEC_INSTANCE");
  const serviceToken = required(env, "EXECUTION_BROKER_SERVICE_TOKEN");
  const workerUrl = required(env, "EXEC_WORKER_URL");
  const workerToken = required(env, "EXEC_WORKER_SERVICE_TOKEN");
  // TWO credentials, not one. The broker both LISTENS (as `broker-server`, to
  // the app) and DIALS (as `broker-client`, to a worker), and `mtls.ts` requires
  // exactly one URI SAN plus the direction-appropriate EKU per credential — so a
  // single leaf physically cannot serve both hops. Loading one and reusing it
  // would hand the worker a `broker-server`/`serverAuth` leaf where it demands a
  // byte-exact `broker-client`/`clientAuth` one, and EVERY broker→worker call
  // would 403 at the far end. Both are required: a broker that cannot reach its
  // worker is useless, so this fails closed at start-up rather than on the first
  // command.
  const tls = loadExecTlsMaterial(env);
  const clientTls = loadExecClientTlsMaterial(env);

  // The per-command authorization boundary (epic #1705 L2). VERIFY-ONLY: this
  // service only ever holds the Ed25519 PUBLIC half (see `authz/voucher.ts`'s
  // header — the private/signing half lives solely in the app's mint site).
  // `aud` is this broker's own `broker-server` identity — the exact URI SAN
  // the mTLS peer check terminates on for this role — so "who is this voucher
  // for" and "who am I" read from the same source of truth.
  const voucherPublicKeyPath = required(env, EXEC_VOUCHER_VERIFY_PUBLIC_KEY_FILE_ENV);
  const voucherVerifier = new ExecutionVoucherVerifier({
    publicKey: readFileSync(voucherPublicKeyPath, "utf8"),
    aud: execServiceUri(instance, "broker-server"),
  });

  const policy = egressPolicyFromEnv(env);
  const gateway = gatewayFromEnv(env, policy);
  const network = env.EXEC_SANDBOX_NETWORK?.trim() || DEFAULT_SANDBOX_NETWORK;

  const workerClient = new WorkerServiceClient({
    baseUrl: workerUrl,
    instance,
    serviceToken: workerToken,
    tls: clientTls,
  });

  const relay = createBufferedAuditRelay();
  const hostExclusivity = composeHostExclusivity(env);

  const broker = new ExecutionBroker({
    worker: workerClient,
    auditSink: relay.auditSink,
    stdioSink: relay.stdioSink,
    // Acknowledged above: bounded by carrier TTL, not by the run store.
    livenessProbe: async () => "alive",
    voucherVerifier,
    egressPolicyResolver: () => policy,
    sandboxNetwork: network,
    ...(gateway ? { gateway } : {}),
    // exec-plane L3: worker-routed volume + container operations. The client is
    // structurally a `SandboxVolumeOps`/`SandboxContainerOps`, so the broker
    // performs NO docker call of its own in this mode — which is what lets the
    // deployment keep the socket on the worker container alone.
    ...(volumeOpsMode === "worker-routed"
      ? { volumeOps: workerClient, containerOps: workerClient }
      : {}),
    ...(hostExclusivity ? { placementGuard: hostExclusivity.guard } : {}),
  });

  const service = createBrokerService({
    broker,
    instance,
    serviceToken,
    tls,
    relay,
    onRefusal: (entry) => {
      // Structured, value-free refusal log (key names + codes only).
      process.stdout.write(`${JSON.stringify({ svc: "exec-broker", ...entry })}\n`);
    },
  });

  const port = Number(env.EXEC_BROKER_LISTEN_PORT ?? DEFAULT_BROKER_LISTEN_PORT);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`EXEC_BROKER_LISTEN_PORT must be a positive port number (got "${env.EXEC_BROKER_LISTEN_PORT}").`);
  }
  // Renewal keeps `acquired_at` moving so a TTL'd lease does not lapse under a
  // live broker. It is a TIMER, not a precondition: `check()` re-reads the lease
  // on every placement regardless, so a missed renewal degrades to a fail-closed
  // refusal rather than to silent over-run.
  const stopRenewal =
    hostExclusivity && hostExclusivity.renewIntervalMs > 0
      ? startHostExclusivityRenewal(
          hostExclusivity.leaseGuard,
          hostExclusivity.renewIntervalMs,
          (result) => {
            process.stdout.write(
              `${JSON.stringify({
                svc: "exec-broker",
                kind: "host-exclusivity-renewal",
                ok: result.ok,
                ...(result.ok ? {} : { reason: result.reason }),
              })}\n`,
            );
          },
        )
      : undefined;

  return {
    service,
    workerClient,
    port,
    // mTLS (not network reachability) is the authorization boundary — the same
    // posture the egress gateway's admin listener documents.
    address: env.EXEC_LISTEN_ADDRESS?.trim() || "0.0.0.0",
    stop: async () => {
      stopRenewal?.();
      workerClient.close();
      await service.close();
    },
  };
}

/** Compose, then listen. */
export function startBrokerService(env: Env = process.env): BrokerEntryComposition {
  const composed = composeBrokerService(env);
  composed.service.server.listen(composed.port, composed.address, () => {
    process.stdout.write(
      `${JSON.stringify({
        svc: "exec-broker",
        kind: "listen",
        port: composed.port,
        address: composed.address,
        protocolVersion: EXEC_PROTOCOL_VERSION,
      })}\n`,
    );
  });
  return composed;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  try {
    startBrokerService(process.env);
  } catch (err) {
    process.stderr.write(`FATAL: ${describeThrown(err)}\n`);
    process.exit(2);
  }
}
