// Host-half tests for the type-driven effective-identity resolver (epic #1785).
// The postgres runner is mocked; the resolver reads the in-process object-type
// registry for identity and `semantic_assertion` ONLY for the raw
// eligible-extension summary set. These tests prove:
//   - identity is TYPE-DRIVEN (the type's installed namespace-definer, else
//     no-primary) — no claim-registry read, no install read;
//   - the eligible read is a SINGLE batched, org-scoped, eligible-only query;
//   - a read error fails CLOSED to an empty eligible set (never throws).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));

import { objectTypeRegistry } from "@cinatra-ai/objects";
import {
  resolveArtifactEffectiveIdentities,
  resolveArtifactEffectiveIdentity,
} from "@/lib/objects/effective-identity";

const ORG = "org-1";
const GENERIC = "@cinatra-ai/artifact:object";
const EMAIL_TYPE = "@cinatra-ai/email:body";
const EMAIL_EXT = "@cinatra-ai/email";
const PACK_TYPE = "@acme/pack-artifact:thing";
const PACK_EXT = "@acme/pack-artifact";
const ICP_EXT = "@cinatra-ai/marketing-icp-artifact";

type Row = Record<string, unknown>;

function registerType(type: string, pkg?: string): void {
  objectTypeRegistry.register(
    {
      type,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: { listRow: null, card: null, detail: null },
    },
    pkg,
  );
}

/** Prime the single eligible-assertion read (or an error). */
function primeEligible(rows: Row[] | Error): void {
  runPostgresQueriesSync.mockImplementation((input: { queries: Array<{ text: string }> }) => {
    const text = input.queries[0]?.text ?? "";
    if (text.includes("semantic_assertion")) {
      if (rows instanceof Error) throw rows;
      return [{ rows, rowCount: rows.length }];
    }
    throw new Error(`unexpected query: ${text}`);
  });
}

beforeEach(() => {
  runPostgresQueriesSync.mockReset();
  objectTypeRegistry._clearForTests();
});

describe("eligible-extension read: SQL shape + scoping", () => {
  it("is a SINGLE batched, org-scoped, eligible-only query — no install / claim read", () => {
    primeEligible([{ artifact_id: "a1", extension: ICP_EXT }]);
    registerType(GENERIC);
    resolveArtifactEffectiveIdentities({ orgId: ORG, rows: [{ id: "a1", type: GENERIC }] });
    const calls = runPostgresQueriesSync.mock.calls.map(
      (c) => (c[0] as { queries: Array<{ text: string; values: unknown[] }> }).queries[0],
    );
    expect(calls).toHaveLength(1);
    const q = calls[0]!;
    expect(q.text).toContain("semantic_assertion");
    expect(q.text).toContain("eligibility = 'eligible'");
    expect(q.text).not.toContain("installed_extension");
    expect(q.values).toEqual([ORG, ["a1"]]);
  });

  it("eligibleExtensions is the raw eligible set for the row", () => {
    primeEligible([
      { artifact_id: "a1", extension: ICP_EXT },
      { artifact_id: "a1", extension: EMAIL_EXT },
    ]);
    const out = resolveArtifactEffectiveIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.eligibleExtensions.sort()).toEqual([EMAIL_EXT, ICP_EXT].sort());
  });

  it("a read error fails CLOSED to an empty eligible set (never throws)", () => {
    primeEligible(new Error("connection refused"));
    const out = resolveArtifactEffectiveIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.eligibleExtensions).toEqual([]);
  });
});

describe("type-driven identity (epic #1785)", () => {
  it("the generic artifact catch-all resolves to no-primary (no defining extension)", () => {
    primeEligible([]);
    registerType(GENERIC);
    const out = resolveArtifactEffectiveIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "no-primary" });
  });

  it("a host-namespaced installed type resolves to its id namespace extension", () => {
    primeEligible([]);
    registerType(EMAIL_TYPE); // host registers work-product types WITHOUT provenance
    const out = resolveArtifactEffectiveIdentity({ orgId: ORG, artifactId: "a2", baseType: EMAIL_TYPE });
    expect(out.identity).toEqual({ kind: "extension", extension: EMAIL_EXT });
  });

  it("an extension-provenanced installed type resolves to its namespace extension", () => {
    primeEligible([]);
    registerType(PACK_TYPE, PACK_EXT);
    const out = resolveArtifactEffectiveIdentity({ orgId: ORG, artifactId: "a3", baseType: PACK_TYPE });
    expect(out.identity).toEqual({ kind: "extension", extension: PACK_EXT });
  });

  it("an UNREGISTERED (uninstalled) type resolves to no-primary (fail closed)", () => {
    primeEligible([]);
    const out = resolveArtifactEffectiveIdentity({ orgId: ORG, artifactId: "a4", baseType: PACK_TYPE });
    expect(out.identity).toEqual({ kind: "no-primary" });
  });

  it("batched resolution maps each row independently by its type", () => {
    primeEligible([]);
    registerType(PACK_TYPE, PACK_EXT);
    registerType(GENERIC);
    const out = resolveArtifactEffectiveIdentities({
      orgId: ORG,
      rows: [
        { id: "a1", type: PACK_TYPE },
        { id: "a2", type: GENERIC },
      ],
    });
    expect(out.get("a1")!.identity).toEqual({ kind: "extension", extension: PACK_EXT });
    expect(out.get("a2")!.identity).toEqual({ kind: "no-primary" });
  });
});
