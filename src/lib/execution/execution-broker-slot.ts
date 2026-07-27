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
// SECRET DISCIPLINE: the gateway's control secret and the broker service token
// NEVER enter this slot — only a container name, the proxy port and the
// loopback admin origin, all of which are already operator-visible.

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
