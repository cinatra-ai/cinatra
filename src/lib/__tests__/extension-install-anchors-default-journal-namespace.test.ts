import { describe, it, expect, vi, beforeEach } from "vitest";

// A STOCK marketplace-installed connector must survive a reboot on a released
// image. The BOOT activation pass wires the PLURAL anchor resolver
// `makeDefaultInstallAnchorsResolver` (boot/phases/extension-activation.ts): it
// groups the live canonical rows by `row.version` and reads the install-op
// journal to gate each version's trust.
//
// The DEFAULT install path (the general pipeline's `beginInstallOp`) records its
// finalized journal op in the '0.0.0' DEFAULT/legacy namespace — it passes NO
// version, so the journal `version` column defaults to '0.0.0'. The canonical
// DEFAULT row, however, carries the REAL resolved semver (e.g. 0.1.6). So a
// default install's journal and its row.version DIVERGE by design.
//
// The bug: the plural resolver read the journal VERSION-SCOPED by `row.version`
// for EVERY row, including the default — so a default row at 0.1.6 missed its
// '0.0.0' journal op, `resolveInstallAnchor` returned null, and the connector was
// refused activation on every (re)boot (capabilities 404). Install-time worked
// only because the singular hot-activate resolver uses the versionless
// ('0.0.0'-preferring) trust-gate read. The fix makes the plural resolver read the
// DEFAULT row's journal versionless (matching the singular resolver + trust gate)
// while a NON-DEFAULT side-by-side sibling stays version-scoped. These tests
// exercise the REAL resolvers against mocked canonical/grant/journal stores.

type Row = {
  id: string;
  status: string;
  organizationId: string | null;
  /** cinatra#1040 S3 default-version flag (absent = default, legacy rows). */
  isDefault?: boolean;
  /** The canonical row's REAL resolved semver (store-derived from source.version). */
  version?: string;
  source: {
    type?: string;
    registryUrl?: string;
    integrity?: string;
    contentHash?: string;
    version?: string;
    activeDigest?: string;
  } | null;
};
type Op = { phase: string; digest: string | null };

let canonicalRows: Row[] = [];
// Journal ops keyed by VERSION NAMESPACE. '0.0.0' is the DEFAULT/legacy namespace
// (where the general install pipeline records a default install's op); a real
// semver key is a side-by-side sibling's own namespace.
let opsByVersion: Record<string, Op> = {};

const readInstalledExtensionsByPackageName = vi.fn(async () => canonicalRows);
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...a: unknown[]) =>
    readInstalledExtensionsByPackageName(...(a as [])),
}));

let grant: { status: string; approvedPorts: string[]; orgId: string | null } | null = null;
const readGrant = vi.fn(async () => grant);
vi.mock("@/lib/extension-host-port-grants", () => ({
  readGrant: (...a: unknown[]) => readGrant(...(a as [])),
}));

// Faithful journal-store semantics:
//  - readInstallOpForVersion(v): the op in EXACTLY the `v` namespace (or null);
//  - readInstallOp (versionless): finalized-first, PREFERS the '0.0.0' namespace
//    then any finalized op — mirrors the store's ORDER BY
//    (phase='finalized') DESC, (version='0.0.0') DESC.
const readInstallOpForVersion = vi.fn(
  async (_pkg: string, _org: string | null, version: string) => opsByVersion[version] ?? null,
);
const readInstallOp = vi.fn(async () => {
  const entries = Object.entries(opsByVersion);
  const finalized = entries.filter(([, o]) => o.phase === "finalized");
  const prefer = finalized.find(([v]) => v === "0.0.0") ?? finalized[0];
  const chosen = prefer ?? entries[0];
  return chosen ? chosen[1] : null;
});
vi.mock("@/lib/extension-install-ops", () => ({
  readInstallOp: (...a: unknown[]) => readInstallOp(...(a as [])),
  readInstallOpForVersion: (...a: unknown[]) =>
    readInstallOpForVersion(...(a as [string, string | null, string])),
}));

import {
  makeDefaultInstallAnchorsResolver,
  makeDefaultInstallAnchorResolver,
} from "@/lib/extension-install-anchor";

const PKG = "@acme/wordpress-mcp-connector";
const REGISTRY = "https://registry.cinatra.ai";
const DIGEST_016 = "sha256-016digest";
const DIGEST_030 = "sha256-030digest";

/**
 * The AUTHENTIC stock DB state proven by the 2026-07-18 reboot harness: the
 * canonical row carries the REAL resolved version 0.1.6 (store-derived from
 * source.version), yet the finalized journal op lives in the '0.0.0' default
 * namespace.
 */
function stockDefaultRow(over: Partial<Row> = {}): Row {
  return {
    id: "iext_stock",
    status: "active",
    organizationId: null,
    isDefault: true,
    version: "0.1.6",
    source: {
      type: "verdaccio",
      registryUrl: REGISTRY,
      integrity: "sha512-real016",
      contentHash: "deadbeef016",
      version: "0.1.6",
      activeDigest: DIGEST_016,
    },
    ...over,
  };
}

function sbsRow(over: Partial<Row> = {}): Row {
  return {
    id: "iext_sbs",
    status: "active",
    organizationId: null,
    isDefault: false,
    version: "0.3.0",
    source: {
      type: "verdaccio",
      registryUrl: REGISTRY,
      integrity: "sha512-real030",
      contentHash: "deadbeef030",
      version: "0.3.0",
      activeDigest: DIGEST_030,
    },
    ...over,
  };
}

beforeEach(() => {
  canonicalRows = [];
  opsByVersion = {};
  grant = { status: "approved", approvedPorts: ["settings"], orgId: null };
  vi.clearAllMocks();
});

describe("stock-install reboot survival — plural boot resolver reads the DEFAULT row's '0.0.0' journal namespace", () => {
  it("RESOLVES a DEFAULT row whose real semver (0.1.6) differs from its '0.0.0' journal namespace (the exact stock-install→reboot→refused path)", async () => {
    // Authentic stock state: row.version 0.1.6, but the finalized journal op is in
    // the '0.0.0' default namespace (pipeline beginInstallOp default). NOTHING is
    // journaled at 0.1.6.
    canonicalRows = [stockDefaultRow()];
    opsByVersion = { "0.0.0": { phase: "finalized", digest: DIGEST_016 } };

    const resolveAnchors = await makeDefaultInstallAnchorsResolver(); // boot: platform-global
    const anchors = await resolveAnchors(PKG);

    // PRE-FIX: [] — the version-scoped read of '0.1.6' missed the '0.0.0' journal →
    // "no trusted install record" → refused → capabilities 404 on every boot.
    // POST-FIX: the default row resolves against its '0.0.0' journal.
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.trustDecision).toBe(true);
    expect(anchors[0]!.version).toBe("0.1.6");
    expect(anchors[0]!.approvedPorts).toEqual(["settings"]);
    expect(anchors[0]!.isDefault).toBe(true);
    // The default row's journal was read at the EXACT '0.0.0' default namespace —
    // never version-scoped by its real semver (where the pre-fix miss happened),
    // and never the loose versionless reader (which could borrow a sibling's op).
    expect(readInstallOpForVersion).toHaveBeenCalledWith(PKG, null, "0.0.0");
    expect(readInstallOpForVersion).not.toHaveBeenCalledWith(PKG, null, "0.1.6");
    expect(readInstallOp).not.toHaveBeenCalled();
  });

  it("the SINGULAR hot-activate resolver already resolved the same stock row (the gap was BOOT-only)", async () => {
    canonicalRows = [stockDefaultRow()];
    opsByVersion = { "0.0.0": { phase: "finalized", digest: DIGEST_016 } };

    const resolveOne = await makeDefaultInstallAnchorResolver(); // hot-activate: versionless
    const anchor = await resolveOne(PKG);

    expect(anchor).not.toBeNull();
    expect(anchor?.trustDecision).toBe(true);
    expect(anchor?.version).toBe("0.1.6");
  });

  it("a NON-DEFAULT side-by-side sibling stays VERSION-SCOPED: default (0.0.0 journal) + sibling (own-version journal) each resolve at their own version", async () => {
    canonicalRows = [stockDefaultRow(), sbsRow()];
    opsByVersion = {
      "0.0.0": { phase: "finalized", digest: DIGEST_016 }, // the default install's op
      "0.3.0": { phase: "finalized", digest: DIGEST_030 }, // the sibling's own op
    };

    const resolveAnchors = await makeDefaultInstallAnchorsResolver();
    const anchors = await resolveAnchors(PKG);

    expect(anchors.map((a) => a.version).sort()).toEqual(["0.1.6", "0.3.0"]);
    // The default read its EXACT '0.0.0' namespace; the sibling read its own version.
    expect(readInstallOpForVersion).toHaveBeenCalledWith(PKG, null, "0.0.0");
    expect(readInstallOpForVersion).toHaveBeenCalledWith(PKG, null, "0.3.0");
    // The default's journal was NOT read version-scoped by its real semver.
    expect(readInstallOpForVersion).not.toHaveBeenCalledWith(PKG, null, "0.1.6");
  });

  it("a NON-DEFAULT sibling is REFUSED when its OWN version namespace has no finalized op — it must NOT fall back to the default '0.0.0' op (fail-closed scope preserved)", async () => {
    canonicalRows = [stockDefaultRow(), sbsRow()];
    // Only the DEFAULT '0.0.0' op is finalized; the sibling's 0.3.0 namespace has none.
    opsByVersion = { "0.0.0": { phase: "finalized", digest: DIGEST_016 } };

    const resolveAnchors = await makeDefaultInstallAnchorsResolver();
    const anchors = await resolveAnchors(PKG);

    // Only the default resolves; the sibling stays fail-closed (no version-scoped op).
    expect(anchors.map((a) => a.version)).toEqual(["0.1.6"]);
  });

  it("STRICT namespace isolation: a DEFAULT row whose OWN '0.0.0' op is absent does NOT borrow a non-default sibling's finalized op (even with no activeDigest to cross-check)", async () => {
    // Codex convergence counterexample: with the loose VERSIONLESS reader the
    // default would fall back to the sibling's finalized op, and selectActiveDigest
    // cannot catch it because the default row records NO activeDigest. The EXACT
    // '0.0.0' read binds the default to its own namespace → refused (fail-closed).
    canonicalRows = [
      stockDefaultRow({
        source: {
          type: "verdaccio",
          registryUrl: REGISTRY,
          integrity: "sha512-real016",
          contentHash: "deadbeef016",
          version: "0.1.6",
          // NO activeDigest → the digest cross-check cannot reject a borrowed op.
        },
      }),
      sbsRow(),
    ];
    // NO '0.0.0' op for the default; only the sibling's 0.3.0 op is finalized.
    opsByVersion = { "0.3.0": { phase: "finalized", digest: DIGEST_030 } };

    const resolveAnchors = await makeDefaultInstallAnchorsResolver();
    const anchors = await resolveAnchors(PKG);

    // ONLY the sibling resolves; the default is fail-closed (its '0.0.0' op absent).
    // Under the rejected versionless reader this would wrongly include "0.1.6".
    expect(anchors.map((a) => a.version)).toEqual(["0.3.0"]);
    expect(readInstallOpForVersion).toHaveBeenCalledWith(PKG, null, "0.0.0");
    expect(readInstallOp).not.toHaveBeenCalled();
  });

  it("a LEGACY default row (version '0.0.0', digest-unbound) still resolves against its '0.0.0' journal (no regression)", async () => {
    canonicalRows = [
      stockDefaultRow({
        version: "0.0.0",
        source: {
          type: "verdaccio",
          registryUrl: REGISTRY,
          integrity: "sha512-real",
          contentHash: "deadbeef",
          version: "0.0.0",
          // legacy row: no recorded activeDigest → the journal digest (null) alone.
        },
      }),
    ];
    opsByVersion = { "0.0.0": { phase: "finalized", digest: null } };

    const resolveAnchors = await makeDefaultInstallAnchorsResolver();
    const anchors = await resolveAnchors(PKG);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.version).toBe("0.0.0");
  });

  it("a DEFAULT row whose journal never finalized is still REFUSED (the fix does not weaken the finalized trust gate)", async () => {
    canonicalRows = [stockDefaultRow()];
    // The '0.0.0' op exists but is mid-saga (not finalized) → not anchorable.
    opsByVersion = { "0.0.0": { phase: "materialized", digest: DIGEST_016 } };

    const resolveAnchors = await makeDefaultInstallAnchorsResolver();
    const anchors = await resolveAnchors(PKG);
    expect(anchors).toEqual([]);
  });
});
