/**
 * Worker service ENTRYPOINT (exec-plane S1 remainder, epic cinatra#1705).
 *
 * The runnable half of `worker-server.ts` — same separation-of-concerns as
 * `broker-entry.ts` (nothing that listens or reads argv belongs in the package
 * barrel), and the esbuild entry for the worker bundle.
 *
 * Unlike the broker entry, this one has NO unwired seams to acknowledge: a
 * worker's whole job is to run containers on its own host, so `docker` on the
 * host is the design, not a deficit. Everything it needs is scoped env
 * (ops#517): its mTLS identity, its service token, the digest-pinned L0 image
 * ref, and the host-held provenance key that lets it re-verify a declared L1
 * layer before mounting it.
 *
 * The provenance key is deliberately OPTIONAL: absent, a command that declares
 * an L1 environment is refused fail-closed by the merged mount path (a layer can
 * only be mounted if it can be verified) while L0-base commands keep working.
 * That is the merged contract — this entry does not soften it.
 */

import { pathToFileURL } from "node:url";

import { LocalDevSandboxWorker } from "../worker";
import { loadExecTlsMaterial } from "./mtls";
import { EXEC_PROTOCOL_VERSION, EXEC_PROTOCOL_VERSION_ENV } from "./protocol";
import { describeThrown } from "./rpc-transport";
import { createWorkerService, type WorkerService } from "./worker-server";

export const DEFAULT_WORKER_LISTEN_PORT = 4200;

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(
      `Refusing to start the execution-plane worker service: ${key} is required (fail-closed).`,
    );
  }
  return value;
}

export function assertProtocolVersionEnv(env: Env): void {
  const declared = env[EXEC_PROTOCOL_VERSION_ENV]?.trim();
  if (declared === undefined || declared === "") return;
  if (declared !== String(EXEC_PROTOCOL_VERSION)) {
    throw new Error(
      `${EXEC_PROTOCOL_VERSION_ENV}=${declared} does not match this build's wire protocol ` +
        `version ${EXEC_PROTOCOL_VERSION}; refusing to start (a version bump is a lockstep deploy).`,
    );
  }
}

export type WorkerEntryComposition = {
  service: WorkerService;
  port: number;
  address: string;
  stop: () => Promise<void>;
};

/** Compose the worker service from scoped env. Does not listen. */
export function composeWorkerService(env: Env = process.env): WorkerEntryComposition {
  assertProtocolVersionEnv(env);
  const instance = required(env, "EXEC_INSTANCE");
  const serviceToken = required(env, "EXEC_WORKER_SERVICE_TOKEN");
  const tls = loadExecTlsMaterial(env);

  const worker = new LocalDevSandboxWorker({
    ...(env.CINATRA_SANDBOX_L0_IMAGE?.trim()
      ? { imageRef: env.CINATRA_SANDBOX_L0_IMAGE.trim() }
      : {}),
    ...(env.EXECUTION_ENVIRONMENT_PROVENANCE_KEY
      ? { provenanceKey: env.EXECUTION_ENVIRONMENT_PROVENANCE_KEY }
      : {}),
  });

  const service = createWorkerService({
    worker,
    instance,
    serviceToken,
    tls,
    onRefusal: (entry) => {
      process.stdout.write(`${JSON.stringify({ svc: "exec-worker", ...entry })}\n`);
    },
  });

  const port = Number(env.EXEC_WORKER_LISTEN_PORT ?? DEFAULT_WORKER_LISTEN_PORT);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(
      `EXEC_WORKER_LISTEN_PORT must be a positive port number (got "${env.EXEC_WORKER_LISTEN_PORT}").`,
    );
  }
  return {
    service,
    port,
    address: env.EXEC_LISTEN_ADDRESS?.trim() || "0.0.0.0",
    stop: () => service.close(),
  };
}

export function startWorkerService(env: Env = process.env): WorkerEntryComposition {
  const composed = composeWorkerService(env);
  composed.service.server.listen(composed.port, composed.address, () => {
    process.stdout.write(
      `${JSON.stringify({
        svc: "exec-worker",
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
    startWorkerService(process.env);
  } catch (err) {
    process.stderr.write(`FATAL: ${describeThrown(err)}\n`);
    process.exit(2);
  }
}
