/**
 * COMPOSITE health for the broker service (exec-plane L4, epic cinatra#1705).
 *
 * The merged `health` op answered one question — "is this broker process
 * running" — and the app had no way to ask the question that actually gates a
 * remote placement: is the WHOLE path usable. A broker whose worker container
 * has been killed still answers its own health perfectly, so an activation gate
 * built on that answer would register an executor factory for a plane that
 * cannot run a single command.
 *
 * This module composes the answer from the dependencies the broker already
 * holds, and states three things precisely:
 *
 *  1. EVERY PROBE IS BOUNDED. A dependency that hangs must degrade to
 *     `unhealthy` on a timer, never hold the health request (and therefore the
 *     caller's boot phase) open. `Promise.race` against a timer, not a hope.
 *  2. A PROBE NEVER THROWS OUT. Each one resolves to an `ExecSubsystemHealth`;
 *     a rejection becomes `unhealthy` WITH the failure text, which is the whole
 *     diagnostic value of the endpoint.
 *  3. `not-applicable` IS NOT `ok`. A `none` egress tier has no gateway and a
 *     non-host-exclusive broker has no lease; saying so is honest, and it is a
 *     different claim from "I checked it and it is fine". `ok` is the
 *     conjunction over the APPLICABLE subsystems only.
 *
 * SECRET DISCIPLINE. Nothing here reads, carries or echoes the gateway control
 * secret, the service token or any TLS private material. The gateway is probed
 * on its OPEN `/__health` endpoint (no credential), and the gateway probe's
 * failure text is composed from a fixed vocabulary plus an HTTP status rather
 * than from the URL, so an admin URL that ever carried a userinfo component
 * could not ride out on a health string.
 */

import type { ExecCompositeHealth, ExecSubsystemHealth } from "./protocol";

/** Default ceiling for one dependency probe. */
export const DEFAULT_COMPOSITE_PROBE_TIMEOUT_MS = 2_000;

/**
 * Hard ceiling on a configured probe timeout (Codex convergence, adopted). The
 * value is operator-influenced upstream, and a health endpoint that can be
 * configured to hold a request open for a minute is a health endpoint that can
 * be used to hold a request open for a minute.
 */
export const MAX_COMPOSITE_PROBE_TIMEOUT_MS = 10_000;

/**
 * A probe RESOLVES when the dependency answered and REJECTS otherwise.
 *
 * Typed `Promise<void>` rather than `Promise<unknown>` deliberately (Codex
 * convergence, adopted): with a value-returning signature, a probe written as
 * `() => someCheck()` that resolves to `false` would be read as a pass. Void
 * makes "answered" the only thing a resolution can mean, and turns the mistake
 * into a compile error at the composition site.
 */
export type SubsystemProbe = () => Promise<void>;

/**
 * One dependency, as a CHOICE the caller must make explicitly: either there is
 * something to probe, or there is a stated reason there is not.
 *
 * A union rather than an optional field (Codex convergence, adopted). With
 * optionals, forgetting to wire a dependency and deliberately declaring it
 * absent are the same code — and the first silently produces a composite that
 * reports `not-applicable` for something the placement actually depends on.
 * Here, omitting it does not compile.
 */
export type SubsystemSource = { probe: SubsystemProbe } | { notApplicable: string };

export type CompositeHealthSources = {
  /**
   * The broker→worker hop. A bare probe, with no `not-applicable` arm: a broker
   * with no worker cannot run anything, so there is no honest way to declare it
   * inapplicable.
   */
  worker: SubsystemProbe;
  gateway: SubsystemSource;
  lease: SubsystemSource;
  timeoutMs?: number;
};

/**
 * Longest scheme this redaction will consider. Real URI schemes are short
 * (`https`, `postgresql`); the BOUND is the point, not the exact number — an
 * unbounded `[a-z0-9+.-]*` before the literal `://` makes the scan polynomial
 * on a long run of letters that never reaches `://`, which CodeQL correctly
 * flags as a ReDoS on input this function does not author. A bounded
 * repetition caps the backtracking at a constant factor.
 */
const MAX_SCHEME_LENGTH = 31;

const CREDENTIALED_ORIGIN_RE = new RegExp(
  `([a-z][a-z0-9+.-]{0,${MAX_SCHEME_LENGTH}}://)[^/\\s@]{0,256}@`,
  "gi",
);

/**
 * Redact the `user:password@` userinfo component out of any origin in a
 * detail string.
 *
 * These strings are assembled from transport errors this module does not author
 * and are served to an operator surface, so the redaction is unconditional
 * rather than reasoned about per message.
 */
export function redactCompositeDetail(text: string): string {
  // A fresh lastIndex per call: the pattern is `g`, and a shared RegExp object
  // would carry state between calls and silently skip matches.
  CREDENTIALED_ORIGIN_RE.lastIndex = 0;
  return text.replace(CREDENTIALED_ORIGIN_RE, "$1");
}

function describe(err: unknown): string {
  try {
    if (err instanceof Error) return redactCompositeDetail(err.message);
    return redactCompositeDetail(String(err));
  } catch {
    return "unknown error";
  }
}

/** Clamp a configured timeout into a finite, positive, bounded range. */
function clampTimeout(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_COMPOSITE_PROBE_TIMEOUT_MS;
  }
  return Math.min(raw, MAX_COMPOSITE_PROBE_TIMEOUT_MS);
}

/**
 * Run one probe under a hard deadline. The timer is `unref`'d so a pending
 * probe can never be the reason a process stays alive, and it is always
 * cleared — a health poll must not leak a timer per call.
 *
 * THE DEADLINE IS AN OUTER BOUND, NOT A CANCELLATION, and that is deliberate
 * (Codex convergence, rebutted with rationale). Both probes this module is
 * composed with already carry their OWN transport deadline — the worker call
 * through the RPC client's `requestTimeoutMs`, the gateway call through an
 * `AbortSignal.timeout` — so the operation the race abandons is already on its
 * way to failing. Threading an `AbortSignal` through the `SubsystemProbe`
 * signature would buy cancellation of an already-bounded call at the cost of
 * making every probe implement abort handling. What this layer owes the caller
 * is that the ANSWER is bounded, and that it delivers.
 */
async function runProbe(
  probe: SubsystemProbe,
  okDetail: string,
  timeoutMs: number,
): Promise<ExecSubsystemHealth> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`did not answer within ${timeoutMs} ms`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    await Promise.race([probe(), deadline]);
    return { state: "ok", detail: okDetail };
  } catch (err) {
    return { state: "unhealthy", detail: describe(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function evaluate(
  source: SubsystemSource,
  okDetail: string,
  timeoutMs: number,
): Promise<ExecSubsystemHealth> {
  if ("notApplicable" in source) {
    return { state: "not-applicable", detail: redactCompositeDetail(source.notApplicable) };
  }
  return runProbe(source.probe, okDetail, timeoutMs);
}

/**
 * Build the provider `createBrokerService({ composite })` calls. Probes run
 * CONCURRENTLY: they are independent, and running them in series would make the
 * endpoint's worst case the sum of three timeouts instead of one.
 */
export function createCompositeHealthProvider(
  sources: CompositeHealthSources,
): () => Promise<ExecCompositeHealth> {
  const timeoutMs = clampTimeout(sources.timeoutMs);
  return async (): Promise<ExecCompositeHealth> => {
    const [worker, gateway, lease] = await Promise.all([
      runProbe(sources.worker, "the sandbox worker answered an authorized health call", timeoutMs),
      evaluate(
        sources.gateway,
        "the attributing egress gateway answered its health endpoint",
        timeoutMs,
      ),
      evaluate(
        sources.lease,
        "this broker holds the host-exclusivity lease for its tenant",
        timeoutMs,
      ),
    ]);
    return {
      // The conjunction over APPLICABLE subsystems: `not-applicable` neither
      // passes nor fails, `unhealthy` always fails.
      ok: [worker, gateway, lease].every((s) => s.state !== "unhealthy"),
      worker,
      gateway,
      lease,
    };
  };
}

/**
 * Probe the attributing gateway's OPEN `/__health` endpoint (the same endpoint
 * `local-gateway.ts` waits on at start-up). No credential is sent and none is
 * needed — the admin listener keeps `/__health` open precisely so liveness can
 * be checked without handing anything the control secret.
 *
 * The failure text is deliberately composed here rather than taken from the
 * transport error: an admin URL is operator-supplied and could in principle
 * carry a userinfo component, and a health string is a surface that gets copied
 * into tickets.
 */
export function createGatewayHealthProbe(adminUrl: string, timeoutMs: number): SubsystemProbe {
  const bounded = clampTimeout(timeoutMs);
  return async () => {
    const target = new URL("/__health", adminUrl);
    const response = await fetch(target, {
      signal: AbortSignal.timeout(bounded),
    }).catch(() => {
      throw new Error("the attributing egress gateway did not answer /__health");
    });
    if (!response.ok) {
      throw new Error(
        `the attributing egress gateway answered /__health with status ${response.status}`,
      );
    }
  };
}
