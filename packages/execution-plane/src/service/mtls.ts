/**
 * Execution-plane mTLS IDENTITY (exec-plane S1 remainder, epic cinatra#1705).
 *
 * Both service hops (app→broker, broker→worker) are mutually authenticated. The
 * authorization decision is made on ONE thing: an exact URI subjectAltName
 * naming the instance and the role.
 *
 *     cinatra-exec://<instance>/<role>
 *     roles: app-client | broker-client | broker-server | worker-server
 *
 * WHY A URI SAN AND NOT A COMMON NAME. A CN is a display string; matching one
 * means substring/wildcard matching, and every substring match is a
 * confused-deputy waiting to happen (`app-client` matches `not-app-client`,
 * `broker-server` matches `broker-server.evil`). The URI SAN is a structured,
 * single-purpose field, and this module compares it BYTE-EXACTLY — there is no
 * prefix rule, no suffix rule, no wildcard, and no CN read anywhere in this
 * file. A certificate is authorized when it carries exactly ONE URI SAN and
 * that SAN equals the expected identity, or it is refused.
 *
 * WHY EXACTLY ONE URI SAN. A certificate carrying both
 * `cinatra-exec://x/app-client` and `cinatra-exec://x/worker-server` would be
 * two identities in one credential — role confusion by construction. One URI
 * SAN per credential keeps "who is this" a total function.
 *
 * WHY EKU IS ALSO ENFORCED. TLS itself checks the EKU when the extension is
 * present, but a certificate with NO EKU is unrestricted, so a client
 * credential could be replayed as a server credential (and vice versa) inside
 * the same PKI. This module requires the EKU to be PRESENT and to include the
 * direction-appropriate purpose: `clientAuth` for the peer of a server,
 * `serverAuth` for the peer of a client. Absent EKU is a refusal, not a pass.
 *
 * TWO FACTORS, INDEPENDENTLY SCOPED. mTLS identity is the FIRST factor; the
 * broker's existing `verifyServiceToken` (timing-safe, its own rotation
 * lifecycle) is the SECOND. Both must pass on every request — see
 * `broker-server.ts` / `worker-server.ts`. Compromising the PKI does not by
 * itself grant execution, and a leaked token without a credential reaches
 * nothing.
 *
 * No new npm dependency: `node:tls`, `node:https`, `node:fs` only.
 */

import { readFileSync } from "node:fs";
import type { PeerCertificate, SecureContextOptions } from "node:tls";

// ---------------------------------------------------------------------------
// Identity vocabulary
// ---------------------------------------------------------------------------

/** URI scheme reserved for execution-plane service identities. */
export const EXEC_URI_SAN_SCHEME = "cinatra-exec";

export type ExecServiceRole =
  /** The app process calling the broker. */
  | "app-client"
  /** The broker process calling a worker. */
  | "broker-client"
  /** The broker's listening service. */
  | "broker-server"
  /** A worker's listening service. */
  | "worker-server";

export const EXEC_SERVICE_ROLES: readonly ExecServiceRole[] = [
  "app-client",
  "broker-client",
  "broker-server",
  "worker-server",
] as const;

/** RFC 5280 extended-key-usage OIDs this module enforces. */
export const EKU_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
export const EKU_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

/**
 * The exact URI SAN a credential for `role` on `instance` must carry.
 *
 * `instance` is the deployment identity (the ops-side instance name). It is
 * part of the authorization key so a credential minted for one instance cannot
 * authenticate to another even under a shared CA — cross-instance replay is
 * refused by the same byte comparison that refuses a wrong role.
 */
export function execServiceUri(instance: string, role: ExecServiceRole): string {
  const trimmed = instance.trim();
  if (trimmed.length === 0) {
    throw new Error(
      "Refusing to build an execution-plane service identity without an instance name (fail-closed).",
    );
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(trimmed)) {
    throw new Error(
      `Refusing an execution-plane instance name with unexpected characters: "${trimmed}".`,
    );
  }
  return `${EXEC_URI_SAN_SCHEME}://${trimmed}/${role}`;
}

// ---------------------------------------------------------------------------
// Peer authorization
// ---------------------------------------------------------------------------

/**
 * The narrow view of a peer certificate this module reads. Node's
 * `PeerCertificate` is structurally assignable to it; keeping our own minimal
 * shape means the authorization matrix is unit-testable without synthesising a
 * full `PeerCertificate`, and documents that NOTHING else on the certificate
 * (subject, CN, issuer string, fingerprint) participates in the decision.
 */
export type ExecPeerCertificate = {
  /** OpenSSL's flattened SAN list, e.g. `URI:cinatra-exec://x/app-client`. */
  subjectaltname?: string | undefined;
  /** Extended-key-usage OIDs; ABSENT means unrestricted, which we refuse. */
  ext_key_usage?: string[] | undefined;
};

export type PeerRefusalReason =
  /** TLS handed us `{}` — no client certificate at all. */
  | "no_peer_certificate"
  /** No `URI:` entry among the SANs. */
  | "no_uri_san"
  /** More than one `URI:` SAN — an ambiguous, multi-role credential. */
  | "ambiguous_uri_san"
  /** A single URI SAN that is not byte-equal to the expected identity. */
  | "uri_san_mismatch"
  /** No extendedKeyUsage extension — an unrestricted credential. */
  | "missing_eku"
  /** EKU present but without the direction-appropriate purpose. */
  | "eku_not_permitted";

export type PeerAuthorization =
  | { ok: true; uri: string }
  | { ok: false; reason: PeerRefusalReason; message: string };

/**
 * Extract the `URI:` entries from Node's flattened subjectAltName string.
 *
 * The flattened form is `TYPE:value, TYPE:value` — comma followed by exactly one
 * space. Node escapes a comma occurring INSIDE a URI value (as `,`), so
 * splitting on the comma cannot split a single URI in two. Any entry that does
 * not start with `URI:` is ignored rather than guessed at, so a DNS or IP SAN can
 * coexist without ever becoming an identity.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO, both of which silently broke the
 * guarantees this module advertises:
 *
 *  - IT DOES NOT TRIM THE VALUE. Only the ONE separator space is removed. A
 *    certificate carrying `URI:cinatra-exec://x/app-client ` (trailing space) or
 *    `URI: cinatra-exec://x/app-client` (leading space) is a DIFFERENT identity
 *    string, and `trim()` normalized both into a match — turning the advertised
 *    byte-exact comparison into a whitespace-insensitive one. They must be
 *    refused, so the value is returned exactly as the certificate carries it.
 *
 *  - IT DOES NOT DROP AN EMPTY VALUE. `URI:<expected>, URI:` is TWO URI SANs;
 *    discarding the empty one made a two-identity credential count as one and
 *    slip past the "exactly one URI SAN" ambiguity guard. An empty entry is kept
 *    so it is counted, and therefore refused as ambiguous.
 *
 * TWO LIMITS WORTH NAMING, both of which fail CLOSED.
 *
 *  - Node renders a SAN value that contains special characters (a comma, a quote)
 *    as a JSON string LITERAL — `URI:"…,…"` — and this parser deliberately
 *    does not decode that form. The quoted text is not byte-equal to any identity
 *    `execServiceUri` can produce, so such a certificate is REFUSED. That is the
 *    safe direction, and it costs nothing here: `execServiceUri` constrains the
 *    instance name to `[a-z0-9._-]` and the role to a fixed set, so a
 *    legitimately-issued exec identity can never contain a character that
 *    triggers quoting. Decoding is therefore added complexity on a security
 *    boundary with no legitimate case to serve.
 *
 *  - Node exposes SANs only as this flattened string (there is no structured
 *    accessor on a peer certificate), so a non-URI SAN whose rendered value
 *    itself contained `, URI:…` would be read as a URI entry. That requires a
 *    certificate MIS-ISSUED by this deployment's own private exec CA — and an
 *    attacker able to obtain one would simply request the URI SAN directly.
 *
 * The CA remains the trust root; this parser is not a substitute for it.
 */
export function parseUriSans(subjectaltname: string | undefined): string[] {
  if (typeof subjectaltname !== "string" || subjectaltname.length === 0) return [];
  const out: string[] = [];
  for (const part of subjectaltname.split(",")) {
    // Strip EXACTLY the one separator space, never arbitrary whitespace.
    const entry = part.startsWith(" ") ? part.slice(1) : part;
    if (!entry.startsWith("URI:")) continue;
    out.push(entry.slice("URI:".length));
  }
  return out;
}

function isEmptyCertificate(cert: ExecPeerCertificate | null | undefined): boolean {
  if (!cert) return true;
  // `getPeerCertificate()` returns `{}` when the peer sent nothing.
  return Object.keys(cert).length === 0;
}

/**
 * The single authorization decision. Total, fail-closed, and free of any
 * hostname or CN reasoning: exactly one URI SAN, byte-equal to `expectedUri`,
 * plus an EKU that explicitly permits `requiredEku`.
 */
export function authorizePeerIdentity(
  cert: ExecPeerCertificate | null | undefined,
  expected: { uri: string; requiredEku: string },
): PeerAuthorization {
  if (isEmptyCertificate(cert)) {
    return {
      ok: false,
      reason: "no_peer_certificate",
      message:
        "The peer presented no certificate; the execution-plane service boundary requires mutual TLS (fail-closed).",
    };
  }
  const uris = parseUriSans(cert?.subjectaltname);
  if (uris.length === 0) {
    return {
      ok: false,
      reason: "no_uri_san",
      message:
        `The peer certificate carries no URI subjectAltName; an execution-plane ` +
        `identity must be a ${EXEC_URI_SAN_SCHEME}:// URI SAN (a Common Name is never read).`,
    };
  }
  if (uris.length > 1) {
    return {
      ok: false,
      reason: "ambiguous_uri_san",
      message:
        `The peer certificate carries ${uris.length} URI subjectAltNames; exactly one is ` +
        `required so the peer's role is unambiguous (refused).`,
    };
  }
  const presented = uris[0] as string;
  if (presented !== expected.uri) {
    return {
      ok: false,
      reason: "uri_san_mismatch",
      message:
        `The peer identity "${presented}" is not authorized for this endpoint, which ` +
        `accepts exactly "${expected.uri}" (byte-exact; no prefix, suffix or wildcard match).`,
    };
  }
  const eku = cert?.ext_key_usage;
  if (!Array.isArray(eku) || eku.length === 0) {
    return {
      ok: false,
      reason: "missing_eku",
      message:
        `The peer certificate "${presented}" carries no extendedKeyUsage extension. An ` +
        `unrestricted credential could be replayed in the opposite direction, so an ` +
        `explicit EKU is required (fail-closed).`,
    };
  }
  if (!eku.includes(expected.requiredEku)) {
    return {
      ok: false,
      reason: "eku_not_permitted",
      message:
        `The peer certificate "${presented}" does not permit ${expected.requiredEku} ` +
        `(it permits ${eku.join(", ")}); refused.`,
    };
  }
  return { ok: true, uri: presented };
}

// ---------------------------------------------------------------------------
// TLS material
// ---------------------------------------------------------------------------

export type ExecTlsMaterial = {
  /** PEM certificate chain for THIS service's own identity. */
  certPem: string;
  /** PEM private key for `certPem`. */
  keyPem: string;
  /** PEM CA bundle used to verify the PEER. Explicit — never the system store. */
  caPem: string;
  /** Optional key passphrase. */
  passphrase?: string;
};

export const EXEC_TLS_CERT_FILE_ENV = "EXEC_TLS_CERT_FILE";
export const EXEC_TLS_KEY_FILE_ENV = "EXEC_TLS_KEY_FILE";
export const EXEC_TLS_CA_FILE_ENV = "EXEC_TLS_CA_FILE";
export const EXEC_TLS_KEY_PASSPHRASE_ENV = "EXEC_TLS_KEY_PASSPHRASE";

/**
 * The broker's SECOND credential — the one it presents when it CALLS a worker.
 *
 * WHY A SECOND FILE SET IS NOT OPTIONAL. `authorizePeerIdentity` requires
 * exactly ONE URI SAN per credential (a two-identity credential is role
 * confusion by construction), and it requires the direction-appropriate EKU. A
 * `broker-server` leaf therefore CANNOT double as a `broker-client` leaf: its
 * SAN says `.../broker-server` where the worker demands a byte-exact
 * `.../broker-client`, and its EKU says `serverAuth` where the worker demands
 * `clientAuth`. A broker process that listens AND dials is two identities, so it
 * is provisioned two leaves under the same CA.
 */
export const EXEC_TLS_CLIENT_CERT_FILE_ENV = "EXEC_TLS_CLIENT_CERT_FILE";
export const EXEC_TLS_CLIENT_KEY_FILE_ENV = "EXEC_TLS_CLIENT_KEY_FILE";
export const EXEC_TLS_CLIENT_KEY_PASSPHRASE_ENV = "EXEC_TLS_CLIENT_KEY_PASSPHRASE";

function loadMaterialFrom(
  vars: { cert: string; key: string; ca: string; passphrase: string },
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): ExecTlsMaterial {
  const certPath = env[vars.cert]?.trim();
  const keyPath = env[vars.key]?.trim();
  const caPath = env[vars.ca]?.trim();
  const missing: string[] = [];
  if (!certPath) missing.push(vars.cert);
  if (!keyPath) missing.push(vars.key);
  if (!caPath) missing.push(vars.ca);
  if (missing.length > 0) {
    throw new Error(
      `Refusing to start an execution-plane service without mutual-TLS material: ${missing.join(", ")} ` +
        `must be set (fail-closed).`,
    );
  }
  const passphrase = env[vars.passphrase];
  return {
    certPem: readFile(certPath as string),
    keyPem: readFile(keyPath as string),
    caPem: readFile(caPath as string),
    ...(passphrase ? { passphrase } : {}),
  };
}

/**
 * Load this service's OWN (listening) TLS material from the ops-provisioned file
 * paths. Every path is REQUIRED — a service that cannot present a credential, or
 * cannot verify its peer against an explicit CA, must not start (fail-closed).
 * The error names the missing ENV VAR / PATH, never any file content.
 */
export function loadExecTlsMaterial(
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): ExecTlsMaterial {
  return loadMaterialFrom(
    {
      cert: EXEC_TLS_CERT_FILE_ENV,
      key: EXEC_TLS_KEY_FILE_ENV,
      ca: EXEC_TLS_CA_FILE_ENV,
      passphrase: EXEC_TLS_KEY_PASSPHRASE_ENV,
    },
    env,
    readFile,
  );
}

/**
 * Load the CLIENT credential a service presents when it dials a peer (today:
 * the broker's `broker-client` identity for the broker→worker hop). The CA
 * bundle is shared with the listening identity — one PKI, two leaves.
 */
export function loadExecClientTlsMaterial(
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): ExecTlsMaterial {
  return loadMaterialFrom(
    {
      cert: EXEC_TLS_CLIENT_CERT_FILE_ENV,
      key: EXEC_TLS_CLIENT_KEY_FILE_ENV,
      ca: EXEC_TLS_CA_FILE_ENV,
      passphrase: EXEC_TLS_CLIENT_KEY_PASSPHRASE_ENV,
    },
    env,
    readFile,
  );
}

// ---------------------------------------------------------------------------
// TLS option builders
// ---------------------------------------------------------------------------

/**
 * TLS 1.3 floor on both sides. These are first-party, same-deployment peers —
 * there is no legacy client to accommodate, so nothing weaker is offered.
 */
export const EXEC_TLS_MIN_VERSION = "TLSv1.3" as const;

export type ExecServerRole = Extract<ExecServiceRole, "broker-server" | "worker-server">;
export type ExecClientRole = Extract<ExecServiceRole, "app-client" | "broker-client">;

export type ExecServerTlsConfig = {
  instance: string;
  /** This server's own role (the identity it presents). */
  role: ExecServerRole;
  /** The ONLY client role this endpoint accepts. */
  peerRole: ExecClientRole;
  material: ExecTlsMaterial;
};

/**
 * `https.createServer` options for an execution-plane service.
 *
 * `requestCert: true` + `rejectUnauthorized: true` + an explicit `ca` mean TLS
 * itself refuses any peer that does not chain to our CA — the request handler
 * never sees it. The URI-SAN/EKU decision on top of that
 * (`authorizePeerIdentity`) is what turns "a valid certificate from our PKI"
 * into "the ONE role allowed on this endpoint".
 */
export function execServerTlsOptions(config: ExecServerTlsConfig): SecureContextOptions & {
  requestCert: true;
  rejectUnauthorized: true;
  minVersion: typeof EXEC_TLS_MIN_VERSION;
} {
  // Build (and therefore validate) both identities eagerly: a bad instance name
  // must fail at construction, not on the first connection.
  execServiceUri(config.instance, config.role);
  execServiceUri(config.instance, config.peerRole);
  return {
    cert: config.material.certPem,
    key: config.material.keyPem,
    ca: config.material.caPem,
    ...(config.material.passphrase ? { passphrase: config.material.passphrase } : {}),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: EXEC_TLS_MIN_VERSION,
  };
}

export type ExecClientTlsConfig = {
  instance: string;
  /** This client's own role (the identity it presents). */
  role: ExecClientRole;
  /** The server role this client will accept — and nothing else. */
  peerRole: ExecServerRole;
  material: ExecTlsMaterial;
};

export type ExecClientTlsOptions = SecureContextOptions & {
  rejectUnauthorized: true;
  minVersion: typeof EXEC_TLS_MIN_VERSION;
  checkServerIdentity: (hostname: string, cert: PeerCertificate) => Error | undefined;
};

/**
 * `https.request` / `https.Agent` options for an execution-plane client.
 *
 * `checkServerIdentity` is REPLACED, not extended: the default implementation
 * matches the DNS/IP SAN against the connect hostname, which is exactly the
 * wrong question here (services are reached by container name, service DNS or
 * loopback, and the identity that matters is the role). The replacement ignores
 * the hostname entirely and applies the same byte-exact URI-SAN + EKU decision
 * the servers apply — so a valid certificate for the WRONG role fails the
 * handshake even though the chain verifies.
 */
export function execClientTlsOptions(config: ExecClientTlsConfig): ExecClientTlsOptions {
  execServiceUri(config.instance, config.role);
  const expectedServerUri = execServiceUri(config.instance, config.peerRole);
  return {
    cert: config.material.certPem,
    key: config.material.keyPem,
    ca: config.material.caPem,
    ...(config.material.passphrase ? { passphrase: config.material.passphrase } : {}),
    rejectUnauthorized: true,
    minVersion: EXEC_TLS_MIN_VERSION,
    checkServerIdentity: (_hostname: string, cert: PeerCertificate): Error | undefined => {
      const verdict = authorizePeerIdentity(cert, {
        uri: expectedServerUri,
        requiredEku: EKU_SERVER_AUTH,
      });
      if (verdict.ok) return undefined;
      const error = new Error(
        `Execution-plane server identity refused (${verdict.reason}): ${verdict.message}`,
      );
      error.name = "ExecPeerIdentityError";
      return error;
    },
  };
}

/**
 * Authorize the CLIENT of a server endpoint. The server half of the same
 * decision `execClientTlsOptions` makes about the server.
 */
export function authorizeServiceClient(
  cert: ExecPeerCertificate | null | undefined,
  config: { instance: string; peerRole: ExecClientRole },
): PeerAuthorization {
  return authorizePeerIdentity(cert, {
    uri: execServiceUri(config.instance, config.peerRole),
    requiredEku: EKU_CLIENT_AUTH,
  });
}
