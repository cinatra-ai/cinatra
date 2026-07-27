import "server-only";

// The broker-executor DI slot (exec-plane S1b activation, cinatra#2138).
//
// A LEAF on purpose: this module has no runtime imports at all, so the hot
// surfaces that need the executor (the chat runtime, the llm-bridge run seam)
// reach it without dragging the execution-environment service — and through it
// the boot-phase and execution-plane type graph — into their route bundles. The
// route-graph ratchet is the guard that keeps it that way.
//
// ANCHORED ON `globalThis`, not a module-local binding: the boot phase runs in
// the Next instrumentation bundle while the surfaces run in their own route
// bundles, so a module-local `let` would give each bundle its own copy and boot
// could register an executor no request ever sees. Same pattern, same reason, as
// the sibling S3 environment-service slot.
//
// FAIL-CLOSED DEFAULT: unregistered ⇒ `undefined` ⇒ the injection layer reports
// `capability_unavailable` and the model continues without the tool.

import type { SandboxExecutor } from "@cinatra-ai/llm";

/** Factory the boot phase registers once a handshake has proven the plane. */
export type ExecutionExecutorFactory = () => SandboxExecutor;

declare global {
  var __cinatraExecutionExecutorFactory: ExecutionExecutorFactory | undefined;
}

/**
 * Register the broker-executor factory. The `execution-broker` boot phase calls
 * this — and ONLY past a completed broker↔worker health handshake — so `ready`
 * is reachable exactly when the plane has really run a command on a live worker.
 * With the default-off ROLLOUT flag unset that phase does not exist, nothing
 * registers, and declared-env runs keep failing closed.
 */
export function registerExecutionExecutorFactory(factory: ExecutionExecutorFactory): void {
  globalThis.__cinatraExecutionExecutorFactory = factory;
}

/**
 * Explicitly CLEAR the registration. A re-boot whose handshake fails — or that
 * reads a `disabled` / `remote` mode — must not leave an earlier boot's executor
 * in place, or readiness would keep reporting `ready` against a broker that is
 * no longer proven. Every non-ready boot branch calls this.
 */
export function clearExecutionExecutorFactory(): void {
  globalThis.__cinatraExecutionExecutorFactory = undefined;
}

/** The registered factory, or `undefined` when the plane is not wired. */
export function getExecutionExecutorFactory(): ExecutionExecutorFactory | undefined {
  return globalThis.__cinatraExecutionExecutorFactory;
}

/**
 * The broker-backed executor for the trusted surface issuers (chat + agent-run),
 * or `undefined` when the plane is not wired (flag off, mode disabled/remote,
 * handshake failed). The injection layer treats an absent executor as
 * `capability_unavailable` and keeps the model usable — it NEVER delivers a tool
 * schema the model could call into a void.
 */
export function getRegisteredExecutionExecutor(): SandboxExecutor | undefined {
  return getExecutionExecutorFactory()?.();
}

/** Test seam — drop the registered factory between hermetic runs. */
export function _resetExecutionExecutorFactoryForTests(): void {
  clearExecutionExecutorFactory();
}
