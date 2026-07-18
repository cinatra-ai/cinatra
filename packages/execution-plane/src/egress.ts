/**
 * Egress policy resolution (exec-plane S1, cinatra#1706 — epic D3).
 *
 * Maps the per-org/per-agent egress POLICY onto an enforceable network
 * configuration for one job:
 *
 *  - `none`             → `--network none` (kernel-level deny at the sandbox);
 *  - `allowlist` /
 *    `default_internet` → the sandbox attaches ONLY to an `--internal` docker
 *    network with no NAT route; the attributing egress gateway container is
 *    the sole dual-homed path out. ALL egress transits the gateway — with
 *    attribution (per-job token), the allowlist decision, and byte quotas.
 *
 * The gateway (runtime/egress-gateway.cjs) enforces:
 *  - mandatory job attribution (proxy credentials; unattributed ⇒ 407),
 *  - the host allowlist in `allowlist` mode (denied ⇒ 403 / tunnel refused),
 *  - the per-job byte ceiling,
 * and exposes per-job destination/byte stats on its admin endpoint, which the
 * worker folds into the broker's audit record.
 *
 * Host matching is exact or dot-suffix ("pypi.org" allows "pypi.org" and
 * "files.pypi.org", never "notpypi.org").
 */

import type {
  EgressGatewayEndpoint,
  EgressPolicy,
  ResolvedEgress,
} from "./types";

/** Default docker network name for the internal (no-NAT) sandbox network. */
export const DEFAULT_SANDBOX_NETWORK = "cinatra-exec-internal";

/** Exact or dot-suffix host allowlist match (case-insensitive). */
export function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h.length === 0) return false;
  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    if (entry.length === 0) continue;
    if (h === entry || h.endsWith(`.${entry}`)) return true;
  }
  return false;
}

export class EgressGatewayRequiredError extends Error {
  constructor(mode: string) {
    super(
      `Egress mode "${mode}" requires the attributing egress gateway (D3: all ` +
        `egress transits the gateway), but none is configured. Fail-closed: ` +
        `the job cannot run with unattributed egress — use mode "none" or ` +
        `start the gateway.`,
    );
    this.name = "EgressGatewayRequiredError";
  }
}

/**
 * Resolve a policy into the per-job network configuration. Fail-closed: a
 * gateway-requiring mode without a configured gateway throws — the broker
 * refuses the job rather than silently granting direct (unattributed) egress
 * OR silently downgrading to no network (which would misreport policy).
 */
export function resolveEgress(
  policy: EgressPolicy,
  opts: {
    jobToken: string;
    network?: string;
    gateway?: EgressGatewayEndpoint;
  },
): ResolvedEgress {
  if (policy.mode === "none") return { kind: "none" };
  if (!opts.gateway) throw new EgressGatewayRequiredError(policy.mode);
  return {
    kind: "gateway",
    mode: policy.mode,
    network: opts.network ?? DEFAULT_SANDBOX_NETWORK,
    gateway: opts.gateway,
    jobToken: opts.jobToken,
  };
}

/**
 * Environment for the gateway CONTAINER (trusted infra, not a sandbox). The
 * gateway reads its default policy + control secret exclusively from these
 * variables; per-job policy arrives at runtime on the authenticated control
 * channel (`registerJobEgress`).
 */
export function gatewayEnvironment(
  policy: EgressPolicy,
  proxyPort: number,
  adminPort: number,
  controlSecret: string,
): Record<string, string> {
  return {
    EGRESS_CONTROL_SECRET: controlSecret,
    EGRESS_MODE: policy.mode === "allowlist" ? "allowlist" : "allow_all",
    EGRESS_ALLOWLIST: (policy.allowlist ?? []).join(","),
    EGRESS_MAX_BYTES_PER_JOB: String(policy.maxBytesPerJob ?? 0),
    EGRESS_PROXY_PORT: String(proxyPort),
    EGRESS_ADMIN_PORT: String(adminPort),
  };
}

export class EgressRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressRegistrationError";
  }
}

/**
 * Register a per-job token together with its resolved policy at the gateway's
 * authenticated control channel, BEFORE the sandbox runs. The gateway rejects
 * any proxy request whose token is not registered (407), so this call is what
 * makes attribution unforgeable and per-job policy enforceable. Fail-closed:
 * a failed registration throws — the broker must refuse the command rather than
 * dispatch a sandbox whose egress the gateway would reject anyway (or, worse,
 * mis-attribute).
 */
export async function registerJobEgress(
  gateway: EgressGatewayEndpoint,
  jobToken: string,
  policy: EgressPolicy,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!gateway.adminUrl || !gateway.controlSecret) {
    throw new EgressRegistrationError(
      "Gateway control channel is not configured (adminUrl / controlSecret); " +
        "cannot register per-job egress policy (fail-closed).",
    );
  }
  let response: Response;
  try {
    response = await fetchImpl(`${gateway.adminUrl.replace(/\/$/, "")}/__register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-egress-control": gateway.controlSecret,
      },
      body: JSON.stringify({
        token: jobToken,
        mode: policy.mode === "allowlist" ? "allowlist" : "allow_all",
        allowlist: policy.allowlist ?? [],
        maxBytesPerJob: policy.maxBytesPerJob ?? 0,
      }),
    });
  } catch (err) {
    throw new EgressRegistrationError(
      `Gateway control channel unreachable: ${(err as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new EgressRegistrationError(
      `Gateway rejected the per-job egress registration (HTTP ${response.status}).`,
    );
  }
}
