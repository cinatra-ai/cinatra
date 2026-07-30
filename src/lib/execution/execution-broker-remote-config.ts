// Connection inputs + the readiness GATE for the remote execution placement
// (exec-plane L4; epic cinatra#1705).
//
// Deliberately SPLIT from `execution-broker-remote-construct.ts`. That module
// composes the whole placement and therefore pulls the agent-run store, the
// authz audit kernel and the voucher mint site. Two callers need only the two
// functions below — the health boot phase's live probe and the construction
// module itself — and making the probe drag the entire graph in would put a
// large lazy import on a path whose whole job is to be cheap and bounded.
//
// Deliberately NOT importing "server-only" either: the health phase reaches
// this through a dynamic import and its unit tests substitute the module. The
// file is server-side by construction anyway — it reads `node:fs`, which no
// client bundle can resolve.

import { readFileSync } from "node:fs";

import {
  execServiceUri,
  redactCompositeDetail,
  type ExecCompositeHealth,
  type ExecTlsMaterial,
} from "@cinatra-ai/execution-plane";
import type { HealthResultPayload } from "@cinatra-ai/execution-plane";

type Env = Record<string, string | undefined>;

/**
 * App-side names for the remote placement. The exec SERVICES read their own
 * `EXEC_*` variables from their own scoped env files (docker-compose.exec.yml)
 * and never from the app's environment — that separation is what the compose
 * scoping gate enforces, and using a distinct prefix here keeps it legible.
 */
export const REMOTE_BROKER_URL_ENV = "EXECUTION_BROKER_URL";
export const REMOTE_BROKER_INSTANCE_ENV = "EXECUTION_BROKER_INSTANCE";
export const REMOTE_BROKER_SERVICE_TOKEN_ENV = "EXECUTION_BROKER_SERVICE_TOKEN";
export const REMOTE_BROKER_CA_FILE_ENV = "EXECUTION_BROKER_CA_FILE";
export const REMOTE_BROKER_CLIENT_CERT_FILE_ENV = "EXECUTION_BROKER_CLIENT_CERT_FILE";
export const REMOTE_BROKER_CLIENT_KEY_FILE_ENV = "EXECUTION_BROKER_CLIENT_KEY_FILE";
export const REMOTE_BROKER_CLIENT_KEY_PASSPHRASE_ENV =
  "EXECUTION_BROKER_CLIENT_KEY_PASSPHRASE";
export const REMOTE_BROKER_REQUEST_TIMEOUT_ENV = "EXECUTION_BROKER_REQUEST_TIMEOUT_MS";

export type RemoteBrokerConfig = {
  baseUrl: string;
  instance: string;
  serviceToken: string;
  tls: ExecTlsMaterial;
  requestTimeoutMs?: number;
};

export type ResolveRemoteConfigResult =
  | { ok: true; value: RemoteBrokerConfig }
  | { ok: false; reason: string };

/**
 * Resolve the remote placement's connection inputs. EVERY missing input is
 * named in one message rather than one-at-a-time: an operator wiring a new
 * placement should not have to restart six times to learn six names.
 *
 * The file READS happen here, at boot, deliberately: an unreadable key file is
 * a configuration error the phase must report as `unavailable`, not a surprise
 * on the first command.
 */
export function resolveRemoteBrokerConfig(
  env: Env,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): ResolveRemoteConfigResult {
  const baseUrl = env[REMOTE_BROKER_URL_ENV]?.trim() ?? "";
  const instance = env[REMOTE_BROKER_INSTANCE_ENV]?.trim() ?? "";
  const serviceToken = env[REMOTE_BROKER_SERVICE_TOKEN_ENV]?.trim() ?? "";
  const certPath = env[REMOTE_BROKER_CLIENT_CERT_FILE_ENV]?.trim() ?? "";
  const keyPath = env[REMOTE_BROKER_CLIENT_KEY_FILE_ENV]?.trim() ?? "";
  const caPath = env[REMOTE_BROKER_CA_FILE_ENV]?.trim() ?? "";

  const missing: string[] = [];
  if (baseUrl === "") missing.push(REMOTE_BROKER_URL_ENV);
  if (instance === "") missing.push(REMOTE_BROKER_INSTANCE_ENV);
  if (serviceToken === "") missing.push(REMOTE_BROKER_SERVICE_TOKEN_ENV);
  if (certPath === "") missing.push(REMOTE_BROKER_CLIENT_CERT_FILE_ENV);
  if (keyPath === "") missing.push(REMOTE_BROKER_CLIENT_KEY_FILE_ENV);
  if (caPath === "") missing.push(REMOTE_BROKER_CA_FILE_ENV);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `the remote placement is not configured — missing ${missing.join(", ")}`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, reason: `${REMOTE_BROKER_URL_ENV} is not a valid URL` };
  }
  // https ONLY. The boundary IS mutual TLS; an http origin would silently drop
  // both the server's identity check and the client certificate, which is the
  // entire authorization story of this hop.
  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `${REMOTE_BROKER_URL_ENV} must be https (the broker boundary is mutual TLS; got ${parsed.protocol})`,
    };
  }

  let tls: ExecTlsMaterial;
  try {
    const passphrase = env[REMOTE_BROKER_CLIENT_KEY_PASSPHRASE_ENV];
    tls = {
      certPem: readFile(certPath),
      keyPem: readFile(keyPath),
      caPem: readFile(caPath),
      ...(passphrase ? { passphrase } : {}),
    };
  } catch (err) {
    // The PATH is named, never the contents: a key file's bytes must not reach
    // a log line or an admin page through an error message.
    return {
      ok: false,
      reason: sanitizeOperatorDetail(
        `the app's broker client TLS material could not be read (${
          err instanceof Error ? err.message : String(err)
        })`,
      ),
    };
  }

  // Fail here rather than deep inside the client: `execServiceUri` is what the
  // peer check and the voucher audience are both built from, so an instance
  // name it refuses can never produce a working placement.
  try {
    execServiceUri(instance, "broker-server");
  } catch (err) {
    return {
      ok: false,
      reason: `${REMOTE_BROKER_INSTANCE_ENV} is unusable: ${(err as Error).message}`,
    };
  }

  const rawTimeout = env[REMOTE_BROKER_REQUEST_TIMEOUT_ENV]?.trim();
  let requestTimeoutMs: number | undefined;
  if (rawTimeout) {
    const value = Number(rawTimeout);
    if (!Number.isFinite(value) || value <= 0) {
      return {
        ok: false,
        reason: `${REMOTE_BROKER_REQUEST_TIMEOUT_ENV}="${rawTimeout}" is not a positive number of milliseconds`,
      };
    }
    requestTimeoutMs = value;
  }

  return {
    ok: true,
    value: {
      baseUrl,
      instance,
      serviceToken,
      tls,
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    },
  };
}

/**
 * Strip the `user:password@` userinfo component out of any origin in an
 * operator-facing string
 * (Codex convergence, adopted).
 *
 * WHY THIS EXISTS even though nothing here interpolates a URL on purpose: the
 * strings below are assembled from transport errors and from a remote broker's
 * own prose, neither of which this module authors. `EXECUTION_BROKER_URL` is
 * operator-supplied and CAN carry a userinfo component, these strings land in a
 * boot log and on an admin page, and pages get screenshotted into tickets. A
 * cheap unconditional redaction on the way out is worth more than an audit of
 * every message that might one day include an origin.
 */
export function sanitizeOperatorDetail(text: string): string {
  // Delegates to the package's own redaction so the app and the services cannot
  // drift into two different ideas of what a credential-bearing origin is — and
  // so the BOUNDED scheme/userinfo repetitions (the CodeQL ReDoS fix) live in
  // exactly one place.
  return redactCompositeDetail(text);
}

/** Render a composite verdict as one operator-readable line. */
export function describeComposite(composite: ExecCompositeHealth): string {
  return [
    `worker ${composite.worker.state} (${composite.worker.detail})`,
    `gateway ${composite.gateway.state} (${composite.gateway.detail})`,
    `lease ${composite.lease.state} (${composite.lease.detail})`,
  ].join("; ");
}

export type RemoteCompositeResult =
  | { ok: true; composite: ExecCompositeHealth; executingCount: number }
  | { ok: false; reason: string; composite?: ExecCompositeHealth };

/**
 * The minimal client surface the gate needs. `BrokerServiceClient` satisfies it
 * structurally, and so does a plain object in a test — which is the point: the
 * gate's logic is worth testing without a TLS handshake.
 */
export type CompositeHealthSource = { health(): Promise<HealthResultPayload> };

/**
 * THE COMPOSITE GATE. Three outcomes, and the middle one is the one that
 * matters: a broker that answers WITHOUT a composite is a broker whose
 * dependencies were never checked, and this returns `ok: false` for it. Reading
 * an absent composite as an all-clear would make every future peer that drops
 * the field silently activate the plane.
 */
export async function checkRemoteComposite(
  client: CompositeHealthSource,
): Promise<RemoteCompositeResult> {
  let health: HealthResultPayload;
  try {
    health = await client.health();
  } catch (err) {
    // The transport's message is not ours to trust: redact any userinfo before
    // it reaches a boot log or the admin health surface.
    return {
      ok: false,
      reason: sanitizeOperatorDetail(
        `the broker did not answer a health call: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
  if (!health.composite) {
    return {
      ok: false,
      reason:
        "the broker answered but reported no composite readiness, so its worker, gateway and " +
        "host-exclusivity lease are unproven — the plane stays fail-closed",
    };
  }
  if (!health.composite.ok) {
    return {
      ok: false,
      reason: sanitizeOperatorDetail(
        `the broker's dependencies are not healthy — ${describeComposite(health.composite)}`,
      ),
      composite: health.composite,
    };
  }
  return { ok: true, composite: health.composite, executingCount: health.executingCount };
}
