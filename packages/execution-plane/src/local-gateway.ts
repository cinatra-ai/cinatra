/**
 * Local-dev egress-gateway lifecycle (exec-plane S1, cinatra#1706).
 *
 * Brings up the network-layer enforcement topology on a local docker daemon:
 *
 *  1. an `--internal` sandbox network (`docker network create --internal`) —
 *     containers attached ONLY to it have no NAT route to the outside;
 *  2. the attributing gateway container: started on the default bridge (its
 *     internet leg + the host-published admin port), then CONNECTED to the
 *     internal network — the single dual-homed path out. The gateway process
 *     is `runtime/egress-gateway.cjs` over the L0 image's node runtime; the
 *     script rides a READ-ONLY bind mount, which is fine here: the gateway is
 *     TRUSTED INFRASTRUCTURE, not a sandbox — the no-host-mount invariant
 *     binds sandbox containers only (worker asserts it per dispatch).
 *
 * Production placements provision the same topology in the deployment layer
 * (ops tracker); this module exists so local-dev and the Docker E2E battery
 * run the REAL enforcement path, not a simulation.
 */

import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { gatewayEnvironment } from "./egress";
import { resolveL0ImageRef } from "./l0-profile";
import { runDocker, type DockerCli } from "./docker-cli";
import type { EgressGatewayEndpoint, EgressPolicy } from "./types";

export const GATEWAY_CONTAINER_NAME = "cinatra-exec-gateway";
export const GATEWAY_PROXY_PORT = 3128;
export const GATEWAY_ADMIN_PORT = 3129;

const GATEWAY_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "runtime",
  "egress-gateway.cjs",
);

export async function ensureInternalNetwork(
  name: string,
  docker: DockerCli = runDocker,
): Promise<void> {
  const existing = await docker(["network", "inspect", name, "--format", "{{.Internal}}"]);
  if (existing.exitCode === 0) {
    if (existing.stdout.trim() !== "true") {
      throw new Error(
        `Docker network "${name}" exists but is NOT internal — refusing to use ` +
          `it as the sandbox network (it would grant a direct NAT route).`,
      );
    }
    return;
  }
  const created = await docker(["network", "create", "--internal", name]);
  if (created.exitCode !== 0) {
    throw new Error(`Failed to create internal network ${name}: ${created.stderr.trim()}`);
  }
}

export type LocalGateway = {
  endpoint: EgressGatewayEndpoint;
  containerName: string;
  stop: () => Promise<void>;
};

/**
 * Start (or restart) the local gateway container for a given egress policy and
 * attach it to the internal sandbox network. The admin endpoint is published
 * on 127.0.0.1 only (host-side stats for the worker; never sandbox-reachable
 * semantics — the sandbox talks to the PROXY port over the internal network).
 */
export async function startLocalGateway(
  policy: EgressPolicy,
  opts: {
    internalNetwork: string;
    adminHostPort?: number;
    imageRef?: string;
    docker?: DockerCli;
    /**
     * Absolute host path of the gateway script to bind-mount (exec-plane S1b
     * activation, cinatra#2138 deliverable 4). Defaults to the package-relative
     * `runtime/egress-gateway.cjs` resolved from `import.meta.url`, which is
     * correct when the package runs from source (tests, E2E battery). The APP
     * consumes this package through a bundler, where `import.meta.url` points
     * into the build output rather than the workspace — so the boot wiring
     * passes the repo-resolved absolute path explicitly. The gateway is trusted
     * infrastructure, not a sandbox: the no-host-mount invariant binds sandbox
     * containers only.
     */
    scriptPath?: string;
  },
): Promise<LocalGateway> {
  const docker = opts.docker ?? runDocker;
  const gatewayScript = opts.scriptPath ?? GATEWAY_SCRIPT;
  const imageRef = resolveL0ImageRef(opts.imageRef);
  const adminHostPort = opts.adminHostPort ?? GATEWAY_ADMIN_PORT;
  // Control secret for the broker→gateway control channel. Generated fresh per
  // gateway; held by the broker (host side) and the gateway container; NEVER
  // injected into a sandbox. Authorizes /__register + /__stats.
  const controlSecret = randomBytes(32).toString("base64url");
  await ensureInternalNetwork(opts.internalNetwork, docker);
  await docker(["rm", "-f", GATEWAY_CONTAINER_NAME]);

  const env = gatewayEnvironment(policy, GATEWAY_PROXY_PORT, GATEWAY_ADMIN_PORT, controlSecret);
  const args = [
    "run",
    "-d",
    "--name",
    GATEWAY_CONTAINER_NAME,
    "--restart",
    "no",
    "-p",
    `127.0.0.1:${adminHostPort}:${GATEWAY_ADMIN_PORT}`,
    "--volume",
    `${gatewayScript}:/gateway/egress-gateway.cjs:ro`,
  ];
  for (const [key, value] of Object.entries(env)) {
    args.push("--env", `${key}=${value}`);
  }
  args.push(imageRef, "node", "/gateway/egress-gateway.cjs");
  const started = await docker(args);
  if (started.exitCode !== 0) {
    throw new Error(`Failed to start egress gateway: ${started.stderr.trim()}`);
  }
  const connected = await docker([
    "network",
    "connect",
    opts.internalNetwork,
    GATEWAY_CONTAINER_NAME,
  ]);
  if (connected.exitCode !== 0) {
    await docker(["rm", "-f", GATEWAY_CONTAINER_NAME]);
    throw new Error(
      `Failed to attach gateway to ${opts.internalNetwork}: ${connected.stderr.trim()}`,
    );
  }
  // Wait for the proxy listener before handing the endpoint out.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const health = await fetch(`http://127.0.0.1:${adminHostPort}/__health`);
      if (health.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      const logs = await docker(["logs", GATEWAY_CONTAINER_NAME]);
      await docker(["rm", "-f", GATEWAY_CONTAINER_NAME]);
      throw new Error(
        `Egress gateway did not become healthy: ${logs.stderr}${logs.stdout}`.slice(0, 2000),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    endpoint: {
      host: GATEWAY_CONTAINER_NAME,
      port: GATEWAY_PROXY_PORT,
      adminUrl: `http://127.0.0.1:${adminHostPort}`,
      controlSecret,
    },
    containerName: GATEWAY_CONTAINER_NAME,
    stop: async () => {
      await docker(["rm", "-f", GATEWAY_CONTAINER_NAME]);
    },
  };
}
