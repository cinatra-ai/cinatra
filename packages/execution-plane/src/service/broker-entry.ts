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
 *   * VOLUME OPS. The broker provisions L2 workspace + read-only skills volumes
 *     through its own `DockerCli` seam, i.e. on the broker HOST. Routing those to
 *     a remote worker is a change inside `broker.ts` and is deliberately not made
 *     in this additive slice, so the broker host must genuinely have docker.
 *     `EXEC_BROKER_VOLUME_OPS=host-docker` is that acknowledgement; without it
 *     the service refuses to start rather than opening jobs whose workspace
 *     provisioning will fail at the first command.
 *
 * Both refusals name the missing binding verbatim so an operator is never left
 * guessing, and neither can be satisfied by accident.
 *
 * TWO TLS CREDENTIALS, because the broker is two identities. It LISTENS to the
 * app as `broker-server` and DIALS a worker as `broker-client`, and `mtls.ts`
 * admits exactly one URI SAN plus the direction-appropriate EKU per credential —
 * so one leaf cannot serve both hops. `EXEC_TLS_CERT_FILE`/`_KEY_FILE` is the
 * listening leaf; `EXEC_TLS_CLIENT_CERT_FILE`/`_KEY_FILE` is the dialing one;
 * `EXEC_TLS_CA_FILE` is shared (one PKI, two leaves). Both are required.
 */

import { pathToFileURL } from "node:url";

import { ExecutionBroker } from "../broker";
import { DEFAULT_SANDBOX_NETWORK } from "../egress";
import type { EgressGatewayEndpoint, EgressMode, EgressPolicy } from "../types";
import {
  createBrokerService,
  createBufferedAuditRelay,
  type BrokerService,
} from "./broker-server";
import { loadExecClientTlsMaterial, loadExecTlsMaterial } from "./mtls";
import { EXEC_PROTOCOL_VERSION, EXEC_PROTOCOL_VERSION_ENV } from "./protocol";
import { describeThrown } from "./rpc-transport";
import { WorkerServiceClient } from "./worker-client";

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
  const volumeOps = env.EXEC_BROKER_VOLUME_OPS?.trim();
  if (volumeOps !== "host-docker") {
    throw new Error(
      "Refusing to start the execution-plane broker service: it provisions L2 workspace and " +
        "read-only skills volumes through its own docker seam, so the broker HOST must have " +
        "docker. Set EXEC_BROKER_VOLUME_OPS=host-docker to acknowledge that; worker-routed " +
        "volume operations are not wired in this slice.",
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

  const broker = new ExecutionBroker({
    worker: workerClient,
    auditSink: relay.auditSink,
    stdioSink: relay.stdioSink,
    // Acknowledged above: bounded by carrier TTL, not by the run store.
    livenessProbe: async () => "alive",
    egressPolicyResolver: () => policy,
    sandboxNetwork: network,
    ...(gateway ? { gateway } : {}),
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
  return {
    service,
    workerClient,
    port,
    // mTLS (not network reachability) is the authorization boundary — the same
    // posture the egress gateway's admin listener documents.
    address: env.EXEC_LISTEN_ADDRESS?.trim() || "0.0.0.0",
    stop: async () => {
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
