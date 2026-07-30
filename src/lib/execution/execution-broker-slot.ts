import "server-only";

// Execution-broker status slot (exec-plane S1b activation, cinatra#2138
// deliverables 1 + 5; epic #1705).
//
// The health surface and the settings screen must report the REAL state of the
// boot-wired broker without importing the heavy `@cinatra-ai/execution-plane`
// graph at their own module load. Same `globalThis`-anchored register-* pattern
// the S3 A2 environment-service slot uses.
//
// FAIL-CLOSED DEFAULT: an unregistered slot reads `inert` — the plane is not
// wired, so the health surface says exactly that. The boot phase only registers
// a `running` status AFTER a completed broker↔worker health handshake.
//
// SECRET DISCIPLINE: the gateway's control secret, the broker service token and
// every piece of mTLS private material NEVER enter this slot — only a container
// name, the proxy port, the loopback admin origin and, since exec-plane L4, the
// broker's COMPOSITE readiness, which is a fixed three-state verdict plus
// operator prose per subsystem. The remote placement's own credentials
// (`EXECUTION_BROKER_SERVICE_TOKEN`, the app-client key/cert, the voucher
// signing key) are held by the construction module and never handed here; the
// slot is read by a server component that renders to an admin, so anything it
// holds is one template interpolation away from a page.

import type { ExecCompositeHealth } from "@cinatra-ai/execution-plane";

import type { ExecutionEgressMode, ExecutionPlaneMode } from "@/lib/execution/execution-plane-settings";

/** The handshake evidence that authorizes a `running` status (AC3). */
export type ExecutionBrokerHandshake = {
  /** Epoch ms the handshake command returned exit 0 from a live worker. */
  completedAtMs: number;
  /** Immutable identity of the L0 image the probe container actually ran. */
  imageDigest: string;
  /** Wall time of the probe command, ms. */
  wallMs: number;
};

export type ExecutionBrokerGatewayInfo = {
  containerName: string;
  proxyPort: number;
  /** Loopback admin origin (host side). Never carries the control secret. */
  adminOrigin?: string;
};

/**
 * The remote broker's COMPOSITE readiness (exec-plane L4), re-exported under an
 * app-layer name so the admin surface never imports the package barrel just for
 * a type. Sub-states are `ok` / `unhealthy` / `not-applicable` per subsystem —
 * worker, gateway, lease — plus the broker-side conjunction.
 *
 * WHY THE APP DOES NOT RECOMPUTE `ok`: the broker sits next to these
 * dependencies and knows which of them this deployment actually has. An
 * app-side re-derivation would be a second opinion of what "composite" means,
 * and the two would drift the first time a subsystem is added.
 */
export type ExecutionBrokerComposite = ExecCompositeHealth;

export type ExecutionBrokerStatus = {
  /** Was the default-off ROLLOUT flag on at boot? */
  rolloutEnabled: boolean;
  /** The persisted placement mode the boot phase read. */
  mode: ExecutionPlaneMode;
  /**
   * - `inert`       — nothing wired (flag off, or mode `disabled`). Today's state.
   * - `unavailable` — wiring attempted and refused (no handshake, no gateway…).
   * - `running`     — handshake completed against a live worker; the executor
   *   factory is registered and the plane can run commands.
   */
  state: "inert" | "unavailable" | "running";
  /** Operator-facing explanation of `inert` / `unavailable`. */
  detail?: string;
  handshake?: ExecutionBrokerHandshake;
  gateway?: ExecutionBrokerGatewayInfo;
  egressMode?: ExecutionEgressMode;
  /**
   * The composite the boot handshake obtained from a REMOTE broker (exec-plane
   * L4). Absent for the `local-dev` placement, which has no service boundary to
   * ask — and absent is NOT an all-clear: the surface renders "—" for a
   * placement that has no composite rather than implying one passed.
   */
  composite?: ExecutionBrokerComposite;
  /**
   * Live re-probe seam the health surface calls to answer "is the worker alive
   * RIGHT NOW" rather than "did it come up at boot". Present only when running.
   */
  probeLiveness?: () => Promise<ExecutionBrokerLiveness>;
};

export type ExecutionBrokerLiveness = {
  ok: boolean;
  detail: string;
  /** Epoch ms the probe ran. */
  atMs: number;
  /**
   * The composite as of THIS probe, when the placement has one. The boot-time
   * composite above answers "how did it come up"; this one answers "what is
   * true now", and the surface prefers it whenever it is present.
   */
  composite?: ExecutionBrokerComposite;
};

declare global {
  var __cinatraExecutionBrokerStatus: ExecutionBrokerStatus | undefined;
}

/** The default an unregistered slot reports: nothing is wired. */
export const INERT_EXECUTION_BROKER_STATUS: ExecutionBrokerStatus = {
  rolloutEnabled: false,
  mode: "disabled",
  state: "inert",
  detail: "The execution plane is not wired on this instance.",
};

/** Install the status (boot phase). Last write wins (idempotent re-boot). */
export function registerExecutionBrokerStatus(status: ExecutionBrokerStatus): void {
  globalThis.__cinatraExecutionBrokerStatus = status;
}

/** Read the status. Unregistered ⇒ the inert default (fail-closed). */
export function getExecutionBrokerStatus(): ExecutionBrokerStatus {
  return globalThis.__cinatraExecutionBrokerStatus ?? INERT_EXECUTION_BROKER_STATUS;
}

/** Test seam — drop the registered status between hermetic runs. */
export function _resetExecutionBrokerStatusForTests(): void {
  globalThis.__cinatraExecutionBrokerStatus = undefined;
}
