/**
 * THE SUPPLIED ROW ANCHORS (cinatra#3204).
 *
 * The runtime loader imports nothing without a trust anchor resolved from the
 * canonical row — a value held OUTSIDE the writable package store. Until this
 * leg that resolver accepted a `verdaccio` source and nothing else, so a package
 * an admin supplied could never anchor: it materialized, it finalized, and then
 * the loader refused it with "no trusted install record", the install did not
 * activate, and the dispatcher archived the row it had just written. That is
 * what the fourth proof round measured for the connector kind.
 *
 * So these tests pin the pair the fix rests on: a supplied row carrying the
 * content digest the supplied install entry records DOES anchor, and it carries
 * the ORIGIN factor the classifier reads — while a row without that digest, and
 * every other gate the resolver applies, is untouched.
 */
import { describe, expect, it } from "vitest";

import { resolveInstallAnchor } from "@/lib/extension-install-anchor";
import { classifyExtensionTrust } from "@/lib/extension-trust";

const DIGEST = "a".repeat(128);
const CONTENT_DIGEST = "b".repeat(64);
const INTEGRITY = "sha512-Zm9vYmFy";
const CONTENT_HASH = "c".repeat(64);

type Source = Record<string, unknown> | null;

const depsFor = (source: Source, over: { phase?: string } = {}) => ({
  readActiveInstall: async () => ({
    id: "iext_supplied",
    status: "active",
    kind: "connector",
    organizationId: null,
    source: source as never,
  }),
  readGrant: async () => null,
  readInstallOp: async () => ({ phase: over.phase ?? "finalized", digest: DIGEST }),
  orgId: null,
});

const suppliedSource = (over: Record<string, unknown> = {}) => ({
  type: "local",
  path: `${CONTENT_DIGEST}.tgz`,
  resolvedCommitOrTreeHash: CONTENT_DIGEST,
  contentDigest: CONTENT_DIGEST,
  activeDigest: DIGEST,
  integrity: INTEGRITY,
  contentHash: CONTENT_HASH,
  ...over,
});

describe("the operator-supplied row resolves a trust anchor", () => {
  it("anchors a LOCAL supplied row and carries its origin", async () => {
    const anchor = await resolveInstallAnchor("@acme/thing-connector", depsFor(suppliedSource()));
    expect(anchor).not.toBeNull();
    expect(anchor!.operatorSuppliedOrigin).toBe(true);
    // The evidence is the pipeline's own, recorded on the row: the loader
    // re-verifies the bytes on disk against THESE values.
    expect(anchor!.integrity).toBe(INTEGRITY);
    expect(anchor!.contentHash).toBe(CONTENT_HASH);
    expect(anchor!.digest).toBe(DIGEST);
    // No registry is claimed.
    expect(anchor!.registryUrl).toBeNull();
  });

  it("anchors a GITHUB supplied row the same way — one road, two front doors", async () => {
    const anchor = await resolveInstallAnchor(
      "@acme/thing-connector",
      depsFor(
        suppliedSource({
          type: "github",
          repo: "acme/thing",
          ref: "main",
          resolvedSha: "9".repeat(40),
        }),
      ),
    );
    expect(anchor).not.toBeNull();
    expect(anchor!.operatorSuppliedOrigin).toBe(true);
  });

  it("the anchor's origin is what admits the package where a store install reaches nothing", () => {
    // A deployment with NO configured marketplace: no activation host at all,
    // and the unsigned-bootstrap lever off.
    const verdict = classifyExtensionTrust({
      packageName: "@acme/thing-connector",
      registryUrl: null,
      integrityVerified: true,
      persistedTrustDecision: true,
      operatorSuppliedOrigin: true,
      trustedActivationHosts: [],
      allowMarketplaceBootstrapTrust: false,
    });
    expect(verdict.trusted).toBe(true);
    // Import only — never the privileged tier a verified signature buys.
    expect(verdict.tier).toBe("trusted-bootstrap");
  });
});

describe("the gates the supplied anchor does NOT move", () => {
  it("a supplied row with no content digest (written before the supplied entry) anchors nothing", async () => {
    const { contentDigest: _dropped, ...noDigest } = suppliedSource();
    expect(await resolveInstallAnchor("@acme/thing-connector", depsFor(noDigest))).toBeNull();
  });

  it("a supplied row whose journal never finalized anchors nothing", async () => {
    expect(
      await resolveInstallAnchor(
        "@acme/thing-connector",
        depsFor(suppliedSource(), { phase: "materialized" }),
      ),
    ).toBeNull();
  });

  it("a supplied row with no recorded integrity anchors nothing", async () => {
    const { integrity: _dropped, ...noIntegrity } = suppliedSource();
    expect(await resolveInstallAnchor("@acme/thing-connector", depsFor(noIntegrity))).toBeNull();
  });

  it("a BUNDLED source still anchors nothing", async () => {
    expect(
      await resolveInstallAnchor(
        "@acme/thing-connector",
        depsFor({ type: "bundled", packageName: "@acme/thing-connector", version: "1.0.0" }),
      ),
    ).toBeNull();
  });

  it("a registry row keeps its own answer — no supplied origin on it", async () => {
    const anchor = await resolveInstallAnchor(
      "@acme/thing-connector",
      depsFor({
        type: "verdaccio",
        registryUrl: "https://registry.example.test",
        packageName: "@acme/thing-connector",
        version: "1.0.0",
        integrity: INTEGRITY,
        contentHash: CONTENT_HASH,
        activeDigest: DIGEST,
      }),
    );
    expect(anchor).not.toBeNull();
    expect(anchor!.operatorSuppliedOrigin).toBeUndefined();
    expect(anchor!.registryUrl).toBe("https://registry.example.test");
  });
});
