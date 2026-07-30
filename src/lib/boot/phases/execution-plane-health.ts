// Execution-plane health boot phase (ops#517 / epic cinatra#1705 — the "health-view
// boot phase" listed as still-pending app wiring in
// packages/execution-plane/src/index.ts).
//
// Surfaces the app's EXECUTION-PLANE CLIENT readiness in the process boot-state
// snapshot so it reaches /api/health (src/app/api/health/route.ts) per INSTANCE-
// CLASS semantics:
//   - a class that REQUIRES the plane (EXECUTION_PLANE_REQUIRED=1) → `degraded`
//     policy: a not-configured / misconfigured plane is DEPLOY-BLOCKING (the phase
//     lands in snapshot.blockingPhases → health top-level status "degraded", HTTP
//     503 → the deploy gate rejects the boot).
//   - any other class → `retryable` policy: the deficit is surfaced (health
//     degradedPhases + degraded:true) but NON-blocking (HTTP 200) — matching the
//     epic's "internet-on / pass-through default; degraded otherwise".
//
// READINESS here is CONFIGURATION readiness — the client inputs the app needs to
// reach the broker: EXECUTION_BROKER_URL (a valid http(s) URL) and the client
// credential EXECUTION_BROKER_SECRET (packages/llm/src/execution-plane/session.ts
// fail-closes without it). This phase is INERT (skipped) on an instance that has
// not opted into the plane, so today's instances are unaffected.
//
// THE LIVE PROBE (exec-plane L4) — its own flag, default off.
// `EXECUTION_BROKER_LIVE_PROBE=on` (and ONLY that exact string) adds a bounded
// mutual-TLS call to the broker's composite health op on top of the config
// check. Three deliberate properties:
//
//   * IT IS A SECOND FLAG, not a rider on CINATRA_EXECUTION_PLANE_ROLLOUT. The
//     rollout flag decides whether the plane exists; this one decides whether
//     BOOT blocks on a network round trip to it. An operator can want the first
//     without the second — a broker restart window should not turn every app
//     boot into a deploy failure — so the two decisions stay separable.
//   * FLAG OFF IS BYTE-IDENTICAL to what shipped before it. Not "a probe that
//     returns early": the phase object returned is the same synchronous one,
//     built by the same function, so the boot-state snapshot, the phase timing
//     and /api/health cannot differ by a field.
//   * POLICY IS UNCHANGED. A live-probe failure routes through the SAME
//     per-instance-class policy a misconfiguration does — deploy-blocking only
//     where EXECUTION_PLANE_REQUIRED=1, degraded-but-serving everywhere else.
//     The probe adds a fact, not a new severity.
//
// Deliberately NOT importing "server-only": vitest unit tests import the phase list.
// The probe's heavy dependency (`@cinatra-ai/execution-plane`) is reached through
// a lazy dynamic import INSIDE the probe path for the same reason.

import type { BootPhase, BootPhaseOutcome } from "@/lib/boot/boot-phase";

/** The stable phase name surfaced to /api/health + operators. */
export const EXECUTION_PLANE_HEALTH_PHASE = "execution-plane-health";

/** Env var that opts an instance into the LIVE broker reachability probe. */
export const EXECUTION_BROKER_LIVE_PROBE_ENV = "EXECUTION_BROKER_LIVE_PROBE";

/**
 * Ceiling on the WHOLE live probe — the lazy module imports, the config read,
 * the TLS handshake and the composite round trip together, not just the HTTP
 * request (Codex convergence, adopted). A per-request timeout is not enough:
 * `EXECUTION_BROKER_REQUEST_TIMEOUT_MS` is operator-supplied and may exceed it,
 * and nothing bounds an import that stalls. A boot phase that can hang is
 * exactly what this flag's design promises it is not.
 */
export const LIVE_PROBE_TIMEOUT_MS = 3_000;

/** True when this instance CLASS requires the execution plane (deploy-blocking). */
export function executionPlaneRequired(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.EXECUTION_PLANE_REQUIRED === "1";
}

/**
 * True only for the exact string `"on"`, mirroring the rollout flag's rule: a
 * typo (`"true"`, `"1"`, `"ON"`) must leave the probe OFF, because the failure
 * direction of a mistyped opt-in should be "we did less", never "boot now
 * depends on a network call the operator did not ask for".
 */
export function isExecutionBrokerLiveProbeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[EXECUTION_BROKER_LIVE_PROBE_ENV] === "on";
}

export type ExecutionPlaneReadiness =
  | { state: "not-configured" }
  | { state: "ready" }
  | { state: "misconfigured"; reason: string };

/** Pure evaluation of the exec-plane CLIENT configuration (no I/O). */
export function evaluateExecutionPlaneReadiness(
  env: Record<string, string | undefined> = process.env,
): ExecutionPlaneReadiness {
  const url = (env.EXECUTION_BROKER_URL ?? "").trim();
  const secret = (env.EXECUTION_BROKER_SECRET ?? "").trim();
  if (url === "" && secret === "") return { state: "not-configured" };
  const missing: string[] = [];
  if (url === "") missing.push("EXECUTION_BROKER_URL");
  if (secret === "") missing.push("EXECUTION_BROKER_SECRET");
  if (missing.length > 0) {
    return { state: "misconfigured", reason: `missing ${missing.join(", ")}` };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { state: "misconfigured", reason: "EXECUTION_BROKER_URL is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      state: "misconfigured",
      reason: `EXECUTION_BROKER_URL must be http(s) (got ${parsed.protocol})`,
    };
  }
  return { state: "ready" };
}

export type ExecutionPlaneLiveProbeResult =
  | { ok: true; detail: string }
  | { ok: false; reason: string };

/**
 * The LIVE probe: one bounded mutual-TLS composite health call to the broker.
 *
 * NEVER THROWS, and that is enforced rather than asserted (Codex convergence,
 * adopted): the lazy imports, the config read, the client construction, the
 * round trip and the close are ALL inside the guard, because each of them can
 * fail and the caller's job is to record a boot-phase outcome, not to handle
 * four failure vocabularies.
 *
 * An ABSENT composite is a FAILURE here, not a pass: it means nothing below the
 * broker was checked, and "unverified" must never read as "healthy".
 */
export async function probeExecutionBrokerLive(
  env: Record<string, string | undefined> = process.env,
): Promise<ExecutionPlaneLiveProbeResult> {
  try {
    return await withDeadline(probeOnce(env), LIVE_PROBE_TIMEOUT_MS);
  } catch (err) {
    return { ok: false, reason: sanitize(describeError(err)) };
  }
}

function describeError(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return "unknown error";
  }
}

/**
 * Race a promise against a hard deadline. The timer is `unref`'d (a pending
 * probe must never be the reason a process stays alive) and always cleared (a
 * boot that retries must not leak one timer per attempt).
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the execution broker did not answer within ${ms} ms`)),
      ms,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeOnce(
  env: Record<string, string | undefined>,
): Promise<ExecutionPlaneLiveProbeResult> {
  // The LIGHT module on purpose (see its header): the probe needs the
  // connection inputs and the gate, and neither the agent-run store nor the
  // audit kernel the construction module pulls in.
  const [
    { resolveRemoteBrokerConfig, checkRemoteComposite, describeComposite, sanitizeOperatorDetail },
    { BrokerServiceClient },
  ] = await Promise.all([
    import("@/lib/execution/execution-broker-remote-config"),
    import("@cinatra-ai/execution-plane"),
  ]);

  const config = resolveRemoteBrokerConfig(env);
  if (!config.ok) return { ok: false, reason: sanitizeOperatorDetail(config.reason) };

  const client = new BrokerServiceClient({
    ...config.value,
    // The per-REQUEST timeout still applies; `withDeadline` above is what makes
    // the whole probe bounded regardless of what an operator configured.
    requestTimeoutMs: config.value.requestTimeoutMs ?? LIVE_PROBE_TIMEOUT_MS,
  });
  try {
    const composite = await checkRemoteComposite(client);
    if (!composite.ok) return { ok: false, reason: sanitizeOperatorDetail(composite.reason) };
    return { ok: true, detail: sanitizeOperatorDetail(describeComposite(composite.composite)) };
  } finally {
    // Always release the keep-alive agent: a boot phase that leaked a socket
    // per attempt would make a retry loop a file-descriptor leak. Guarded
    // because `close()` on a half-built agent can itself throw, and a cleanup
    // failure must not become the reported outcome.
    try {
      client.close();
    } catch {
      /* nothing to do; the probe's verdict is already decided */
    }
  }
}

/**
 * Local mirror of the shared redaction, used on the paths that run BEFORE (or
 * instead of) the light module loading — a failed dynamic import must not be
 * the one error that escapes unredacted, and this module deliberately takes no
 * static import of the execution-plane graph.
 *
 * Both repetitions are BOUNDED (CodeQL: polynomial regular expression on
 * uncontrolled data). An unbounded `[a-z0-9+.-]*` before the literal `://` is
 * quadratic on a long run of letters that never reaches it.
 */
const CREDENTIALED_ORIGIN_RE = /([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s@]{0,256}@/gi;

function sanitize(text: string): string {
  CREDENTIALED_ORIGIN_RE.lastIndex = 0;
  return text.replace(CREDENTIALED_ORIGIN_RE, "$1");
}

/**
 * The execution-plane health phase. Policy is chosen by instance class:
 *   required class → `degraded`  (a failure is DEPLOY-BLOCKING)
 *   otherwise      → `retryable` (a failure is non-blocking degraded)
 * Body:
 *   not-configured & not required → skipped (inert; today's instances)
 *   not-configured & required     → throw  (the class needs the plane → blocked)
 *   misconfigured                 → throw  (blocked if required, else degraded)
 *   ready                         → ok     (+ the LIVE probe when opted in)
 */
export function executionPlaneHealthPhases(
  env: Record<string, string | undefined> = process.env,
): BootPhase[] {
  const required = executionPlaneRequired(env);
  const live = isExecutionBrokerLiveProbeEnabled(env);

  /**
   * The config-only evaluation, unchanged since it shipped. Both phase variants
   * run it FIRST — the live probe is strictly additional evidence, never a
   * replacement, so a misconfigured instance still reports the misconfiguration
   * rather than a downstream connection error caused by it.
   */
  const evaluateConfig = (): BootPhaseOutcome => {
    const readiness = evaluateExecutionPlaneReadiness(env);
    switch (readiness.state) {
      case "ready":
        return;
      case "not-configured":
        if (required) {
          throw new Error(
            `[${EXECUTION_PLANE_HEALTH_PHASE}] EXECUTION_PLANE_REQUIRED=1 but the execution-plane ` +
              "client is not configured (EXECUTION_BROKER_URL + EXECUTION_BROKER_SECRET) — " +
              "deploy-blocking for this instance class.",
          );
        }
        return {
          skipped: "execution plane not configured and not required for this instance class",
        };
      case "misconfigured":
        throw new Error(
          `[${EXECUTION_PLANE_HEALTH_PHASE}] execution-plane client misconfigured: ${readiness.reason}` +
            (required ? " — deploy-blocking for this instance class." : ""),
        );
    }
  };

  // FLAG OFF ⇒ the phase that shipped, synchronous body and all. Written as an
  // early return rather than as a branch inside one body so there is no path on
  // which an opted-out instance awaits anything.
  if (!live) {
    return [
      {
        name: EXECUTION_PLANE_HEALTH_PHASE,
        policy: required ? "degraded" : "retryable",
        run: evaluateConfig,
      },
    ];
  }

  return [
    {
      name: EXECUTION_PLANE_HEALTH_PHASE,
      policy: required ? "degraded" : "retryable",
      run: async (): Promise<BootPhaseOutcome> => {
        const configOutcome = evaluateConfig();
        // `not-configured` on a non-required class: there is nothing to reach,
        // so the probe would only produce a second way of saying so.
        if (configOutcome && "skipped" in configOutcome) return configOutcome;

        const probe = await probeExecutionBrokerLive(env);
        if (!probe.ok) {
          throw new Error(
            `[${EXECUTION_PLANE_HEALTH_PHASE}] the execution broker is not reachable: ${probe.reason}` +
              (required ? " — deploy-blocking for this instance class." : ""),
          );
        }
        return;
      },
    },
  ];
}
