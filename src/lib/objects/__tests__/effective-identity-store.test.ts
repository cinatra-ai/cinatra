// Host-half tests for the effective-identity resolver (cinatra#1426):
// batched SQL shape + the install axis wiring. The postgres runner and the
// claim-registry read are mocked (the artifact-claim-store harness pattern);
// the PURE truth-table leaf runs for real, so these tests prove the host
// feeds it the right DB state:
//   - the assertion query is batched, org-scoped, and excludes archived rows;
//   - the install query is kind:'artifact', live-status, org-or-ambient, and
//     NEVER includes the floor extension (system-extension exemption);
//   - the claim registry is read ONLY when a non-generic base type appears
//     (a page of plain artifacts never touches it);
//   - AC-4 at the store level: a classic extension absent from the install
//     read resolves INACTIVE (identity falls to the floor);
//   - an install-read ERROR fails CLOSED (floor, never an uninstalled ext);
//   - winner install checks are CLAIM-SCOPED (bound install must be the
//     exact live row governing the claim's scope; an ambient row never
//     satisfies an org-scoped claim);
//   - a dedicated claim winner without a binding surfaces the BROWSE-ONLY
//     catalog identity; the enrichment still lists the eligible set.

import { beforeEach, describe, expect, it, vi } from "vitest";

const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));
const readArtifactTypeClaimsForOrg = vi.fn();
vi.mock("@/lib/objects/artifact-claim-store", () => ({
  readArtifactTypeClaimsForOrg: (...a: unknown[]) => readArtifactTypeClaimsForOrg(...a),
}));

import {
  resolveArtifactEffectiveIdentities,
  resolveArtifactEffectiveIdentity,
} from "@/lib/objects/effective-identity";

const ORG = "org-1";
const GENERIC = "@cinatra-ai/artifact:object";
const EMAIL_TYPE = "@cinatra-ai/email:draft";
const EMAIL_EXT = "@cinatra-ai/email-artifact";
const ICP_EXT = "@cinatra-ai/marketing-icp-artifact";
const DEF = "@cinatra-ai/default-artifact";

type Row = Record<string, unknown>;

function assertionRow(over: Partial<Row>): Row {
  return {
    id: "sa-1",
    artifact_id: "a1",
    extension: ICP_EXT,
    asserted_by: "user",
    eligibility: "eligible",
    assertion_basis: "classic",
    binding_claim_id: null,
    binding_generation: null,
    asserted_at: "2026-07-01T00:00:00Z",
    ...over,
  };
}

function installRow(over: Partial<Row>): Row {
  return { id: "inst-1", package_name: ICP_EXT, organization_id: ORG, ...over };
}

/** Route the two runner calls: assertion rows, then install rows (or an error). */
function primeRunner(assertions: Row[], installs: Row[] | Error): void {
  runPostgresQueriesSync.mockImplementation((input: { queries: Array<{ text: string }> }) => {
    const text = input.queries[0]?.text ?? "";
    if (text.includes("semantic_assertion")) {
      return [{ rows: assertions, rowCount: assertions.length }];
    }
    if (text.includes("installed_extension")) {
      if (installs instanceof Error) throw installs;
      return [{ rows: installs, rowCount: installs.length }];
    }
    throw new Error(`unexpected query: ${text}`);
  });
}

beforeEach(() => {
  runPostgresQueriesSync.mockReset();
  readArtifactTypeClaimsForOrg.mockReset();
  readArtifactTypeClaimsForOrg.mockReturnValue([]);
});

describe("SQL shape + read scoping", () => {
  it("assertion read is batched, org-scoped, excludes archived; install read is live artifact-kind rows for the org or ambient", () => {
    primeRunner([assertionRow({})], [installRow({})]);
    resolveArtifactEffectiveIdentities({ orgId: ORG, rows: [{ id: "a1", type: GENERIC }] });
    const calls = runPostgresQueriesSync.mock.calls.map(
      (c) => (c[0] as { queries: Array<{ text: string; values: unknown[] }> }).queries[0],
    );
    const assertionQ = calls.find((q) => q.text.includes("semantic_assertion"))!;
    expect(assertionQ.text).toContain("eligibility <> 'archived'");
    expect(assertionQ.text).toContain("assertion_basis");
    expect(assertionQ.text).toContain("binding_claim_id");
    expect(assertionQ.text).toContain("binding_generation");
    expect(assertionQ.values).toEqual([ORG, ["a1"]]);
    const installQ = calls.find((q) => q.text.includes("installed_extension"))!;
    expect(installQ.text).toContain("kind = 'artifact'");
    expect(installQ.text).toContain("status IN ('active','locked')");
    expect(installQ.text).toContain("organization_id = $2 OR organization_id IS NULL");
    expect(installQ.values).toEqual([[ICP_EXT], ORG]);
  });

  it("the floor extension is NEVER install-checked (system-extension exemption)", () => {
    primeRunner([assertionRow({ extension: DEF, asserted_by: "agent" })], []);
    const out = resolveArtifactEffectiveIdentities({ orgId: ORG, rows: [{ id: "a1", type: GENERIC }] });
    const installCalls = runPostgresQueriesSync.mock.calls.filter((c) =>
      (c[0] as { queries: Array<{ text: string }> }).queries[0]!.text.includes("installed_extension"),
    );
    expect(installCalls).toHaveLength(0);
    expect(out.get("a1")!.identity).toMatchObject({ kind: "default-artifact", selectable: true, assertionId: "sa-1" });
  });

  it("a page of GENERIC artifact rows never touches the claim registry", () => {
    primeRunner([assertionRow({})], [installRow({})]);
    resolveArtifactEffectiveIdentities({ orgId: ORG, rows: [{ id: "a1", type: GENERIC }] });
    expect(readArtifactTypeClaimsForOrg).not.toHaveBeenCalled();
  });
});

describe("install axis (AC-4) + fail-closed", () => {
  it("an installed classic extension resolves as the identity", () => {
    primeRunner([assertionRow({}), assertionRow({ id: "sa-f", extension: DEF, asserted_by: "agent" })], [installRow({})]);
    const out = resolveArtifactEffectiveIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toMatchObject({ kind: "extension", basis: "classic", extension: ICP_EXT, assertionId: "sa-1" });
    expect(out.eligibleExtensions.sort()).toEqual([DEF, ICP_EXT].sort());
  });

  it("an extension with NO live install row is INACTIVE — identity falls to the floor", () => {
    primeRunner([assertionRow({}), assertionRow({ id: "sa-f", extension: DEF, asserted_by: "agent" })], []);
    const out = resolveArtifactEffectiveIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toMatchObject({ kind: "default-artifact", selectable: true, assertionId: "sa-f" });
    // The eligible set is a RAW read — the uninstalled extension stays listed.
    expect(out.eligibleExtensions).toContain(ICP_EXT);
  });

  it("an install-read ERROR fails CLOSED: floor identity, never an unproven extension", () => {
    primeRunner(
      [assertionRow({}), assertionRow({ id: "sa-f", extension: DEF, asserted_by: "agent" })],
      new Error("connection refused"),
    );
    const out = resolveArtifactEffectiveIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toMatchObject({ kind: "default-artifact", assertionId: "sa-f" });
  });
});

describe("claim wiring (typed rows)", () => {
  const dedicatedClaim = {
    id: "c1",
    scope: `org:${ORG}`,
    objectTypeId: EMAIL_TYPE,
    claimKind: "dedicated",
    status: "active",
    extensionPackage: EMAIL_EXT,
    extensionVersion: "1.0.0",
    generation: 2,
    installId: null,
    dispositions: null,
    createdAt: null,
    updatedAt: null,
  };

  it("a dedicated winner without a binding resolves BROWSE-ONLY (catalog) when its scope-governing install is live", () => {
    readArtifactTypeClaimsForOrg.mockReturnValue([dedicatedClaim]);
    primeRunner([], [installRow({ package_name: EMAIL_EXT })]);
    const out = resolveArtifactEffectiveIdentity({ orgId: ORG, artifactId: "a2", baseType: EMAIL_TYPE });
    expect(out.identity).toEqual({
      kind: "extension",
      extension: EMAIL_EXT,
      basis: "catalog",
      selectable: false,
      assertionId: null,
    });
  });

  it("a valid binding (winner's claim row + extension + generation) is the identity", () => {
    readArtifactTypeClaimsForOrg.mockReturnValue([dedicatedClaim]);
    primeRunner(
      [assertionRow({ id: "b1", artifact_id: "a2", extension: EMAIL_EXT, asserted_by: "agent", assertion_basis: "binding", binding_claim_id: "c1", binding_generation: 2 })],
      [installRow({ package_name: EMAIL_EXT })],
    );
    const out = resolveArtifactEffectiveIdentity({ orgId: ORG, artifactId: "a2", baseType: EMAIL_TYPE });
    expect(out.identity).toMatchObject({ kind: "extension", basis: "binding", extension: EMAIL_EXT, assertionId: "b1" });
  });

  it("a binding anchored to a DIFFERENT claim row than the winner is stale (per-claim generation counters)", () => {
    readArtifactTypeClaimsForOrg.mockReturnValue([dedicatedClaim]);
    primeRunner(
      [assertionRow({ id: "b0", artifact_id: "a2", extension: EMAIL_EXT, asserted_by: "agent", assertion_basis: "binding", binding_claim_id: "c-retired", binding_generation: 2 })],
      [installRow({ package_name: EMAIL_EXT })],
    );
    const out = resolveArtifactEffectiveIdentity({ orgId: ORG, artifactId: "a2", baseType: EMAIL_TYPE });
    expect(out.identity).toMatchObject({ basis: "catalog", selectable: false, assertionId: null });
  });

  it("an UNINSTALLED winner is INACTIVE at the store level — resolution falls through (plain object with nothing else)", () => {
    readArtifactTypeClaimsForOrg.mockReturnValue([dedicatedClaim]);
    primeRunner([], []); // no install rows at all
    const out = resolveArtifactEffectiveIdentity({ orgId: ORG, artifactId: "a2", baseType: EMAIL_TYPE });
    expect(out.identity).toMatchObject({ kind: "plain-object" });
  });

  it("CLAIM-SCOPED: an AMBIENT install never satisfies an ORG-scoped claim (no cross-scope bleed), though it DOES satisfy the package-level classic check", () => {
    readArtifactTypeClaimsForOrg.mockReturnValue([dedicatedClaim]); // scope org:org-1
    primeRunner(
      [assertionRow({ id: "c9", artifact_id: "a2", extension: ICP_EXT, asserted_by: "user" })],
      [
        installRow({ id: "inst-amb", package_name: EMAIL_EXT, organization_id: null }), // ambient — governs platform, not org:org-1
        installRow({ id: "inst-icp", package_name: ICP_EXT, organization_id: null }), // ambient governs the org for CLASSIC package-level checks
      ],
    );
    const out = resolveArtifactEffectiveIdentity({ orgId: ORG, artifactId: "a2", baseType: EMAIL_TYPE });
    // Winner INACTIVE (org claim, only an ambient install) → falls through to
    // the installed classic.
    expect(out.identity).toMatchObject({ kind: "extension", basis: "classic", extension: ICP_EXT, assertionId: "c9" });
  });

  it("CLAIM-SCOPED: a claim BOUND to an install validates ONLY through that exact live row", () => {
    readArtifactTypeClaimsForOrg.mockReturnValue([{ ...dedicatedClaim, installId: "inst-bound" }]);
    // A live sibling row exists for the same package/org, but the bound row
    // is gone — the claim is INACTIVE (a stale claim must not re-authorize
    // through a sibling install).
    primeRunner([], [installRow({ id: "inst-sibling", package_name: EMAIL_EXT })]);
    const out = resolveArtifactEffectiveIdentity({ orgId: ORG, artifactId: "a2", baseType: EMAIL_TYPE });
    expect(out.identity).toMatchObject({ kind: "plain-object" });
  });
});
