// The SUPPLIED road onto the finalized store payload (cinatra#3204 leg 3).
//
// WHY THIS EXISTS. The agent and skill handlers consume the FINALIZED store
// payload the pipeline wrote before them, and they read it through
// `resolveFinalizedStorePayload`. That resolver had exactly one road into the
// store — the runtime IMPORT-TRUST anchor — and that anchor admits a
// `verdaccio` source alone. A supplied package records an honest `local` /
// `github` source instead, so every supplied agent and skill install resolved
// NO payload and the handler refused a package the pipeline had just
// materialized, verified and finalized.
//
// The selector below is the supplied road onto the same finalized bytes, and it
// is deliberately NOT the import-trust anchor: it answers "which finalized
// store dir do these metadata-only bytes live in", never "may this package be
// imported into this process". The connector kind — the one kind whose install
// runs code in this process — is refused here by name, so nothing about
// in-process activation is widened.
import { describe, it, expect } from "vitest";

import { selectSuppliedStorePayloadDigest } from "@/lib/extension-store-payload";

const DIGEST = "a".repeat(128);
const OTHER_DIGEST = "b".repeat(128);
const CONTENT_DIGEST = "c".repeat(64);

function localSource(over: Record<string, unknown> = {}) {
  return {
    type: "local",
    path: "snapshot.tgz",
    resolvedCommitOrTreeHash: CONTENT_DIGEST,
    contentDigest: CONTENT_DIGEST,
    activeDigest: DIGEST,
    ...over,
  };
}

describe("selectSuppliedStorePayloadDigest", () => {
  it("resolves the finalized digest for a live supplied row of a metadata-only kind", () => {
    expect(
      selectSuppliedStorePayloadDigest({
        expectedKind: "agent",
        row: { status: "active", kind: "agent", source: localSource() },
        op: { phase: "finalized", digest: DIGEST },
      }),
    ).toBe(DIGEST);
  });

  it("resolves a github-supplied row and a locked row too", () => {
    expect(
      selectSuppliedStorePayloadDigest({
        expectedKind: "skill",
        row: {
          status: "locked",
          kind: "skill",
          source: {
            type: "github",
            repo: "o/r",
            ref: "main",
            resolvedSha: "s",
            contentDigest: CONTENT_DIGEST,
            activeDigest: DIGEST,
          },
        },
        op: { phase: "finalized", digest: DIGEST },
      }),
    ).toBe(DIGEST);
  });

  it("refuses a journal that did not finalize", () => {
    expect(
      selectSuppliedStorePayloadDigest({
        expectedKind: "agent",
        row: { status: "active", kind: "agent", source: localSource() },
        op: { phase: "materialized", digest: DIGEST },
      }),
    ).toBeNull();
    expect(
      selectSuppliedStorePayloadDigest({
        expectedKind: "agent",
        row: { status: "active", kind: "agent", source: localSource() },
        op: null,
      }),
    ).toBeNull();
  });

  it("fails closed when the row digest is not the one the journal confirmed", () => {
    expect(
      selectSuppliedStorePayloadDigest({
        expectedKind: "agent",
        row: { status: "active", kind: "agent", source: localSource() },
        op: { phase: "finalized", digest: OTHER_DIGEST },
      }),
    ).toBeNull();
  });

  it("never resolves for the connector kind — its install imports code", () => {
    expect(
      selectSuppliedStorePayloadDigest({
        expectedKind: "connector",
        row: { status: "active", kind: "connector", source: localSource() },
        op: { phase: "finalized", digest: DIGEST },
      }),
    ).toBeNull();
  });

  it("refuses a row that is not a supplied digest source, and a dead row", () => {
    expect(
      selectSuppliedStorePayloadDigest({
        expectedKind: "agent",
        row: {
          status: "active",
          kind: "agent",
          source: {
            type: "verdaccio",
            registryUrl: "u",
            packageName: "p",
            version: "1.0.0",
            integrity: "sha512-x",
          },
        },
        op: { phase: "finalized", digest: DIGEST },
      }),
    ).toBeNull();
    expect(
      selectSuppliedStorePayloadDigest({
        expectedKind: "agent",
        row: { status: "active", kind: "agent", source: localSource({ contentDigest: undefined }) },
        op: { phase: "finalized", digest: DIGEST },
      }),
    ).toBeNull();
    expect(
      selectSuppliedStorePayloadDigest({
        expectedKind: "agent",
        row: { status: "archived", kind: "agent", source: localSource() },
        op: { phase: "finalized", digest: DIGEST },
      }),
    ).toBeNull();
  });

  it("refuses a row whose kind contradicts the caller expectation", () => {
    expect(
      selectSuppliedStorePayloadDigest({
        expectedKind: "agent",
        row: { status: "active", kind: "skill", source: localSource() },
        op: { phase: "finalized", digest: DIGEST },
      }),
    ).toBeNull();
  });
});
