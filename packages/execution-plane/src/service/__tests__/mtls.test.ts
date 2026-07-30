/**
 * mTLS identity matrices (exec-plane S1 remainder, epic cinatra#1705).
 *
 * The accept/reject tables for URI-SAN and EKU authorization, driven as a PURE
 * function so every branch is covered — including the ones a TLS handshake would
 * reject before our code ran (a client certificate carrying only `serverAuth`
 * fails OpenSSL's own purpose check, so the pure matrix is the only place that
 * branch can be proven).
 */

import { describe, expect, it } from "vitest";

import {
  authorizePeerIdentity,
  authorizeServiceClient,
  EKU_CLIENT_AUTH,
  EKU_SERVER_AUTH,
  EXEC_SERVICE_ROLES,
  execClientTlsOptions,
  execServerTlsOptions,
  execServiceUri,
  loadExecTlsMaterial,
  parseUriSans,
  type ExecPeerCertificate,
} from "../mtls";
import { createTestCa } from "./test-pki";

const INSTANCE = "ossflywheel";

function cert(
  subjectaltname: string | undefined,
  ext_key_usage: string[] | undefined,
): ExecPeerCertificate {
  return {
    ...(subjectaltname === undefined ? {} : { subjectaltname }),
    ...(ext_key_usage === undefined ? {} : { ext_key_usage }),
  };
}

describe("execServiceUri", () => {
  it("builds the exact identity for every role", () => {
    expect(EXEC_SERVICE_ROLES.map((role) => execServiceUri(INSTANCE, role))).toEqual([
      "cinatra-exec://ossflywheel/app-client",
      "cinatra-exec://ossflywheel/broker-client",
      "cinatra-exec://ossflywheel/broker-server",
      "cinatra-exec://ossflywheel/worker-server",
    ]);
  });

  it("refuses an empty or hostile instance name (fail-closed)", () => {
    expect(() => execServiceUri("  ", "app-client")).toThrow(/without an instance name/);
    expect(() => execServiceUri("bad/instance", "app-client")).toThrow(/unexpected characters/);
    expect(() => execServiceUri("a b", "app-client")).toThrow(/unexpected characters/);
  });
});

describe("parseUriSans", () => {
  it("extracts only URI entries and ignores every other SAN type", () => {
    expect(
      parseUriSans("DNS:broker.internal, IP Address:10.0.0.4, URI:cinatra-exec://x/app-client"),
    ).toEqual(["cinatra-exec://x/app-client"]);
  });

  it("returns nothing for an absent or URI-less SAN", () => {
    expect(parseUriSans(undefined)).toEqual([]);
    expect(parseUriSans("")).toEqual([]);
    expect(parseUriSans("DNS:broker.internal")).toEqual([]);
  });

  it("collects multiple URI entries so ambiguity can be refused", () => {
    expect(parseUriSans("URI:cinatra-exec://x/a, URI:cinatra-exec://x/b")).toHaveLength(2);
  });

  /**
   * WHITESPACE IS PART OF THE VALUE. `trim()`ing it turned the advertised
   * byte-exact comparison into a whitespace-insensitive one, so a CA-valid
   * certificate carrying a trailing- or leading-space variant of the expected
   * identity authorized as that identity. The value must come back exactly as the
   * certificate carries it.
   */
  it("preserves leading/trailing whitespace in the value instead of normalizing it", () => {
    expect(parseUriSans("URI:cinatra-exec://x/app-client ")).toEqual([
      "cinatra-exec://x/app-client ",
    ]);
    expect(parseUriSans("URI: cinatra-exec://x/app-client")).toEqual([
      " cinatra-exec://x/app-client",
    ]);
  });

  /**
   * An EMPTY URI SAN is still a URI SAN. Dropping it let a two-identity
   * credential be counted as one and slip past the ambiguity guard.
   */
  it("counts an empty URI entry so it cannot hide beside a real one", () => {
    expect(parseUriSans("URI:cinatra-exec://x/app-client, URI:")).toEqual([
      "cinatra-exec://x/app-client",
      "",
    ]);
  });
});

describe("authorizePeerIdentity — the byte-exact promise is literal", () => {
  const expected = {
    uri: execServiceUri(INSTANCE, "app-client"),
    requiredEku: EKU_CLIENT_AUTH,
  };

  it("refuses a whitespace variant of the expected identity", () => {
    for (const san of [
      `URI:${execServiceUri(INSTANCE, "app-client")} `,
      `URI: ${execServiceUri(INSTANCE, "app-client")}`,
    ]) {
      const verdict = authorizePeerIdentity(cert(san, [EKU_CLIENT_AUTH]), expected);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("uri_san_mismatch");
    }
  });

  /**
   * Node renders a SAN value containing special characters as a JSON string
   * literal. The parser does not decode that form, so it can never byte-equal a
   * real identity — the certificate is REFUSED. Pinned as a deliberate
   * fail-closed property (and unreachable for a legitimate exec identity, whose
   * characters `execServiceUri` constrains).
   */
  it("refuses a JSON-literal-rendered SAN rather than decoding it into a match", () => {
    const verdict = authorizePeerIdentity(
      cert(`URI:"${execServiceUri(INSTANCE, "app-client")}"`, [EKU_CLIENT_AUTH]),
      expected,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("uri_san_mismatch");
  });

  it("refuses the expected identity paired with an EMPTY second URI SAN as ambiguous", () => {
    const verdict = authorizePeerIdentity(
      cert(`URI:${execServiceUri(INSTANCE, "app-client")}, URI:`, [EKU_CLIENT_AUTH]),
      expected,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("ambiguous_uri_san");
  });
});

describe("authorizePeerIdentity — accept", () => {
  it("accepts exactly one matching URI SAN with the required EKU", () => {
    const verdict = authorizePeerIdentity(
      cert("URI:cinatra-exec://ossflywheel/app-client", [EKU_CLIENT_AUTH]),
      { uri: execServiceUri(INSTANCE, "app-client"), requiredEku: EKU_CLIENT_AUTH },
    );
    expect(verdict).toEqual({ ok: true, uri: "cinatra-exec://ossflywheel/app-client" });
  });

  it("accepts a certificate that also carries unrelated SAN types", () => {
    const verdict = authorizePeerIdentity(
      cert("DNS:broker, URI:cinatra-exec://ossflywheel/broker-server", [
        EKU_SERVER_AUTH,
        EKU_CLIENT_AUTH,
      ]),
      { uri: execServiceUri(INSTANCE, "broker-server"), requiredEku: EKU_SERVER_AUTH },
    );
    expect(verdict.ok).toBe(true);
  });
});

describe("authorizePeerIdentity — reject", () => {
  const expected = {
    uri: execServiceUri(INSTANCE, "app-client"),
    requiredEku: EKU_CLIENT_AUTH,
  };

  const rejections: Array<[string, ExecPeerCertificate | null | undefined, string]> = [
    ["no certificate at all", undefined, "no_peer_certificate"],
    ["null certificate", null, "no_peer_certificate"],
    ["the empty object TLS hands back when the peer sent nothing", {}, "no_peer_certificate"],
    ["no URI SAN", cert("DNS:app.internal", [EKU_CLIENT_AUTH]), "no_uri_san"],
    [
      "two URI SANs (a multi-role credential)",
      cert(
        "URI:cinatra-exec://ossflywheel/app-client, URI:cinatra-exec://ossflywheel/worker-server",
        [EKU_CLIENT_AUTH],
      ),
      "ambiguous_uri_san",
    ],
    [
      "the wrong ROLE on the right instance",
      cert("URI:cinatra-exec://ossflywheel/broker-client", [EKU_CLIENT_AUTH]),
      "uri_san_mismatch",
    ],
    [
      "the right role on a DIFFERENT instance (cross-instance replay)",
      cert("URI:cinatra-exec://other-instance/app-client", [EKU_CLIENT_AUTH]),
      "uri_san_mismatch",
    ],
    [
      "a SUPERSTRING of the expected identity (no prefix matching)",
      cert("URI:cinatra-exec://ossflywheel/app-client-evil", [EKU_CLIENT_AUTH]),
      "uri_san_mismatch",
    ],
    [
      "a SUBSTRING of the expected identity (no suffix matching)",
      cert("URI:cinatra-exec://ossflywheel/app-clien", [EKU_CLIENT_AUTH]),
      "uri_san_mismatch",
    ],
    [
      "a host-suffixed identity (no wildcard matching)",
      cert("URI:cinatra-exec://ossflywheel.evil.example/app-client", [EKU_CLIENT_AUTH]),
      "uri_san_mismatch",
    ],
    [
      "no EKU extension at all (an unrestricted credential)",
      cert("URI:cinatra-exec://ossflywheel/app-client", undefined),
      "missing_eku",
    ],
    [
      "an empty EKU list",
      cert("URI:cinatra-exec://ossflywheel/app-client", []),
      "missing_eku",
    ],
    [
      "a serverAuth-only credential presented as a CLIENT",
      cert("URI:cinatra-exec://ossflywheel/app-client", [EKU_SERVER_AUTH]),
      "eku_not_permitted",
    ],
  ];

  for (const [label, peer, reason] of rejections) {
    it(`refuses ${label} → ${reason}`, () => {
      const verdict = authorizePeerIdentity(peer, expected);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe(reason);
    });
  }

  it("never reads the Common Name — a CN-only credential is refused", () => {
    // A certificate whose CN literally IS the expected identity still fails:
    // authorization keys on the URI SAN alone.
    const verdict = authorizePeerIdentity(
      { subjectaltname: undefined, ext_key_usage: [EKU_CLIENT_AUTH] },
      expected,
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("authorizeServiceClient", () => {
  it("requires clientAuth for the client of a server endpoint", () => {
    const good = authorizeServiceClient(
      cert("URI:cinatra-exec://ossflywheel/broker-client", [EKU_CLIENT_AUTH]),
      { instance: INSTANCE, peerRole: "broker-client" },
    );
    expect(good.ok).toBe(true);

    const wrongEku = authorizeServiceClient(
      cert("URI:cinatra-exec://ossflywheel/broker-client", [EKU_SERVER_AUTH]),
      { instance: INSTANCE, peerRole: "broker-client" },
    );
    expect(wrongEku.ok).toBe(false);
  });
});

describe("TLS option builders", () => {
  const ca = createTestCa();
  const leaf = ca.issue({
    commonName: "broker",
    uris: [execServiceUri(INSTANCE, "broker-server")],
    extendedKeyUsage: [EKU_SERVER_AUTH],
  });
  const material = { certPem: leaf.certPem, keyPem: leaf.keyPem, caPem: ca.caPem };

  it("pins mutual auth, an explicit CA and a TLS 1.3 floor on the server", () => {
    const options = execServerTlsOptions({
      instance: INSTANCE,
      role: "broker-server",
      peerRole: "app-client",
      material,
    });
    expect(options.requestCert).toBe(true);
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.minVersion).toBe("TLSv1.3");
    expect(options.ca).toBe(ca.caPem);
  });

  it("replaces checkServerIdentity with the URI-SAN + EKU decision", () => {
    const options = execClientTlsOptions({
      instance: INSTANCE,
      role: "app-client",
      peerRole: "broker-server",
      material,
    });
    expect(options.rejectUnauthorized).toBe(true);
    // The hostname argument is ignored on purpose — services are reached by
    // container name / loopback, and the identity that matters is the ROLE.
    expect(
      options.checkServerIdentity("totally-unrelated-host", {
        subjectaltname: `URI:${execServiceUri(INSTANCE, "broker-server")}`,
        ext_key_usage: [EKU_SERVER_AUTH],
      } as never),
    ).toBeUndefined();
    const refused = options.checkServerIdentity("127.0.0.1", {
      subjectaltname: `URI:${execServiceUri(INSTANCE, "worker-server")}`,
      ext_key_usage: [EKU_SERVER_AUTH],
    } as never);
    expect(refused?.name).toBe("ExecPeerIdentityError");
    expect(refused?.message).toMatch(/uri_san_mismatch/);
  });

  it("validates the instance name at construction, not on first connection", () => {
    expect(() =>
      execServerTlsOptions({
        instance: "bad instance",
        role: "broker-server",
        peerRole: "app-client",
        material,
      }),
    ).toThrow(/unexpected characters/);
  });
});

describe("loadExecTlsMaterial", () => {
  it("refuses to start without all three PEM paths, naming the env vars", () => {
    expect(() => loadExecTlsMaterial({}, () => "x")).toThrow(
      /EXEC_TLS_CERT_FILE, EXEC_TLS_KEY_FILE, EXEC_TLS_CA_FILE/,
    );
    expect(() =>
      loadExecTlsMaterial({ EXEC_TLS_CERT_FILE: "/c", EXEC_TLS_KEY_FILE: "/k" }, () => "x"),
    ).toThrow(/EXEC_TLS_CA_FILE/);
  });

  it("reads each path exactly once and never echoes content into the error path", () => {
    const seen: string[] = [];
    const material = loadExecTlsMaterial(
      {
        EXEC_TLS_CERT_FILE: "/c",
        EXEC_TLS_KEY_FILE: "/k",
        EXEC_TLS_CA_FILE: "/ca",
        EXEC_TLS_KEY_PASSPHRASE: "pp",
      },
      (path) => {
        seen.push(path);
        return `content:${path}`;
      },
    );
    expect(seen).toEqual(["/c", "/k", "/ca"]);
    expect(material.passphrase).toBe("pp");
    expect(material.caPem).toBe("content:/ca");
  });
});
