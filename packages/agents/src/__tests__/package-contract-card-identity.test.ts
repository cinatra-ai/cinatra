import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { cinatraAgentPackageMetadataSchema } from "../verdaccio/package-contract";
import { carryManifestDisplayName, carryManifestVendor } from "../verdaccio/client";

// cinatra#2494 — "Agent publisher's manifest rebuild also drops displayName
// and vendor (same class as the #2469 logo drop)".
//
// #2469's own PR named this exact gap and deliberately scoped it out, with
// codex agreement: "the sibling card-identity keys admitted cross-kind by
// #1570/#1605 … are also not carried through the agent publisher's manifest
// rebuild. That is pre-existing and identical in kind, but outside #2469's
// mandate. Worth its own issue." This is that issue.
//
// The agent kind reaches the registry through `publishAgentPackageFromGitDir`,
// which BUILDS A FRESH `cinatra` block rather than spreading the source one —
// so any field not explicitly carried is lost on publish. Unlike `logo`,
// `displayName`/`vendor` name no separate ASSET (they live entirely inside
// package.json), so the fix has only the two parts `logo` needed beyond its
// own asset-pointer machinery:
//   1. `carryManifestDisplayName` / `carryManifestVendor` (verdaccio/client.ts)
//      — the values survive the publisher's fresh-cinatra-block rebuild.
//      Covered below.
//   2. THIS schema — the values survive the parse (Zod's default STRIP
//      behavior on a plain `z.object` silently removes an undeclared key).
//      Covered below.
//
// A test that only asserts "parsing does not throw" would pass even with the
// fields missing from the schema; every assertion below inspects the PARSED
// OUTPUT instead.

const validBase = {
  packageType: "agent" as const,
  manifestVersion: 1 as const,
  sourceTemplateId: "tpl-1",
  sourceVersionId: "ver-1",
  sourceVersionNumber: 1,
  type: "leaf" as const,
  riskLevel: "low" as const,
  hasApprovalGates: false,
  toolAccess: [],
  ownerOrgId: null,
};

describe("cinatraAgentPackageMetadataSchema — the self-declared displayName/vendor (cinatra#2494)", () => {
  it("PRESERVES a declared displayName through the parse (not merely 'does not throw')", () => {
    const parsed = cinatraAgentPackageMetadataSchema.parse({
      ...validBase,
      displayName: "Ledger Beacon",
    });
    expect(parsed.displayName).toBe("Ledger Beacon");
  });

  it("PRESERVES a declared vendor through the parse", () => {
    const parsed = cinatraAgentPackageMetadataSchema.parse({
      ...validBase,
      vendor: { key: "acme", name: "Acme Corp" },
    });
    expect(parsed.vendor).toEqual({ key: "acme", name: "Acme Corp" });
  });

  it("proves the strip semantics that made both fields necessary", () => {
    // An UNDECLARED key parses cleanly and vanishes — the exact mechanism that
    // erased `logo` before #2469 added it to the schema, and would erase
    // `displayName`/`vendor` here without this change.
    const parsed = cinatraAgentPackageMetadataSchema.parse({
      ...validBase,
      notAField: "Ledger Beacon",
    }) as Record<string, unknown>;
    expect(parsed.notAField).toBeUndefined();
  });

  it("stay OPTIONAL — every already-published displayName/vendor-less package still parses", () => {
    const parsed = cinatraAgentPackageMetadataSchema.parse(validBase);
    expect(parsed.displayName).toBeUndefined();
    expect(parsed.vendor).toBeUndefined();
  });

  it("a malformed displayName degrades to ABSENT rather than rejecting the whole manifest (codex round-0, fail-soft by design — see logo's fail-LOUD posture above for the contrast)", () => {
    // `parseAgentPackageManifestForInstall` calls this schema at every agent
    // install. `displayName` is a soft presentation hint the generator's own
    // `resolveDisplayName` silently degrades to null for anything malformed —
    // never a build error — so a strict sub-schema here would make an
    // unrelated, optional, install-irrelevant field REJECT THE INSTALL of an
    // otherwise-valid package. `.catch(undefined)` makes that impossible: a
    // malformed value degrades to absent, exactly like the carry side.
    for (const bad of [42, true, {}, [], "", "   "]) {
      const parsed = cinatraAgentPackageMetadataSchema.parse({
        ...validBase,
        displayName: bad,
      });
      expect(parsed.displayName, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("a malformed vendor degrades to ABSENT rather than rejecting the whole manifest", () => {
    for (const bad of [
      42,
      true,
      [],
      "",
      { key: "acme" },
      { name: "Acme Corp" },
      { key: "", name: "Acme Corp" },
      { key: "acme", name: "" },
      { key: "  ", name: "Acme Corp" },
    ]) {
      const parsed = cinatraAgentPackageMetadataSchema.parse({ ...validBase, vendor: bad });
      expect(parsed.vendor, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("does NOT resolve or validate ownership/uniqueness — that stays the marketplace publish gate's job", () => {
    // Carried as DATA (the same discipline the artifact allowlist uses) — this
    // schema only enforces shape, never a vendor roster or a name collision.
    const parsed = cinatraAgentPackageMetadataSchema.parse({
      ...validBase,
      vendor: { key: "totally-unregistered-vendor-key", name: "Whoever" },
    });
    expect(parsed.vendor).toEqual({ key: "totally-unregistered-vendor-key", name: "Whoever" });
  });
});

// ---------------------------------------------------------------------------
// The PUBLISH half of the same fix.
// ---------------------------------------------------------------------------
describe("carryManifestDisplayName (publisher carry — cinatra#2494)", () => {
  it("carries a declared displayName, trimmed", () => {
    expect(carryManifestDisplayName({ cinatra: { displayName: "Ledger Beacon" } })).toBe(
      "Ledger Beacon",
    );
    expect(carryManifestDisplayName({ cinatra: { displayName: "  Ledger Beacon  " } })).toBe(
      "Ledger Beacon",
    );
  });

  it("absence stays absence — a displayName-less agent publishes exactly as before", () => {
    expect(carryManifestDisplayName({ cinatra: { kind: "agent" } })).toBeUndefined();
    expect(carryManifestDisplayName({})).toBeUndefined();
    expect(carryManifestDisplayName({ cinatra: { displayName: null } })).toBeUndefined();
    expect(carryManifestDisplayName({ cinatra: null })).toBeUndefined();
    expect(carryManifestDisplayName({ cinatra: "not-an-object" })).toBeUndefined();
    expect(carryManifestDisplayName({ cinatra: ["not-an-object"] })).toBeUndefined();
  });

  it("a malformed declaration resolves to absent rather than throwing (soft presentation hint, unlike logo)", () => {
    // Mirrors the generator's own `resolveDisplayName`, which silently returns
    // null for anything non-string/blank — there is no build-time fail-closed
    // contract on this field the way there is on `logo`.
    for (const bad of [42, true, {}, [], "", "   "]) {
      expect(carryManifestDisplayName({ cinatra: { displayName: bad } }), String(bad)).toBeUndefined();
    }
  });
});

describe("carryManifestVendor (publisher carry — cinatra#2494)", () => {
  it("carries a declared vendor, trimmed", () => {
    expect(carryManifestVendor({ cinatra: { vendor: { key: "acme", name: "Acme Corp" } } })).toEqual({
      key: "acme",
      name: "Acme Corp",
    });
    expect(
      carryManifestVendor({ cinatra: { vendor: { key: "  acme  ", name: "  Acme Corp  " } } }),
    ).toEqual({ key: "acme", name: "Acme Corp" });
  });

  it("absence stays absence — a vendor-less agent publishes exactly as before", () => {
    expect(carryManifestVendor({ cinatra: { kind: "agent" } })).toBeUndefined();
    expect(carryManifestVendor({})).toBeUndefined();
    expect(carryManifestVendor({ cinatra: { vendor: null } })).toBeUndefined();
    expect(carryManifestVendor({ cinatra: null })).toBeUndefined();
  });

  it("a malformed declaration resolves to absent rather than throwing", () => {
    for (const bad of [42, true, "acme", [], {}, { key: "acme" }, { name: "Acme Corp" }, { key: "", name: "" }]) {
      expect(carryManifestVendor({ cinatra: { vendor: bad } }), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("round-trip through the package-contract schema (carry + parse, the full publish path — cinatra#2494 AC1)", () => {
  it("a manifest declaring BOTH displayName and vendor survives the rebuild with BOTH keys present", () => {
    // The issue's acceptance criterion 1, verbatim: "manifest declaring
    // displayName + vendor → publisher rebuild → both keys present in the
    // published manifest." The two halves are only useful TOGETHER: the carry
    // puts the fields on the synthesized manifest, and the schema must not
    // strip them back off.
    const sourcePkgJson = {
      name: "@cinatra-fixtures/card-identity-agent",
      version: "1.0.0",
      cinatra: {
        kind: "agent",
        displayName: "Card Identity Agent",
        vendor: { key: "cinatra-fixtures", name: "Cinatra Fixtures" },
      },
    };

    const carriedDisplayName = carryManifestDisplayName(sourcePkgJson);
    const carriedVendor = carryManifestVendor(sourcePkgJson);

    // Reproduces the EXACT conditional-spread shape `publishAgentPackageFromGitDir`
    // builds into `distManifest.cinatra`.
    const rebuiltCinatraBlock = {
      ...validBase,
      ...(carriedDisplayName !== undefined ? { displayName: carriedDisplayName } : {}),
      ...(carriedVendor !== undefined ? { vendor: carriedVendor } : {}),
    };

    const published = cinatraAgentPackageMetadataSchema.parse(rebuiltCinatraBlock);

    expect(published.displayName).toBe("Card Identity Agent");
    expect(published.vendor).toEqual({ key: "cinatra-fixtures", name: "Cinatra Fixtures" });
  });

  it("a manifest declaring NEITHER field still publishes cleanly (no regression for the common case)", () => {
    const sourcePkgJson = {
      name: "@cinatra-fixtures/no-card-identity-agent",
      version: "1.0.0",
      cinatra: { kind: "agent" },
    };
    const carriedDisplayName = carryManifestDisplayName(sourcePkgJson);
    const carriedVendor = carryManifestVendor(sourcePkgJson);
    const rebuiltCinatraBlock = {
      ...validBase,
      ...(carriedDisplayName !== undefined ? { displayName: carriedDisplayName } : {}),
      ...(carriedVendor !== undefined ? { vendor: carriedVendor } : {}),
    };
    const published = cinatraAgentPackageMetadataSchema.parse(rebuiltCinatraBlock);
    expect(published.displayName).toBeUndefined();
    expect(published.vendor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Wiring guard (mirrors the #2469 logo wiring guard — cinatra#2494 AC2: "the
// rebuild's key handling is a single closed set shared with the #2489 logo
// path (no second divergent allowlist)").
//
// The helpers above are pure and fully unit-covered, but
// `publishAgentPackageFromGitDir` does live registry I/O, so no in-lane test
// EXECUTES the assembly that uses them — deleting the `displayName`/`vendor`
// spread from `distManifest` would leave every assertion above green.
// ---------------------------------------------------------------------------
describe("publishAgentPackageFromGitDir wiring (cinatra#2494 source-text guard)", () => {
  const source = readFileSync(
    path.join(__dirname, "..", "verdaccio", "client.ts"),
    "utf8",
  );

  it("carries displayName/vendor INTO the same rebuilt distManifest cinatra block logo uses", () => {
    expect(source).toContain("const displayName = carryManifestDisplayName(gitPkgJson)");
    expect(source).toContain("const vendor = carryManifestVendor(gitPkgJson)");
    // The conditional spreads are what actually put them on the published
    // manifest — same mechanism, same object literal `logo` is spread into
    // (proven by locating both spreads inside the SAME
    // `publishAgentPackageFromGitDir` function body, not a second, divergent
    // allowlist defined elsewhere).
    expect(source).toContain("...(displayName !== undefined ? { displayName } : {})");
    expect(source).toContain("...(vendor !== undefined ? { vendor } : {})");

    const fnStart = source.indexOf("export async function publishAgentPackageFromGitDir");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf("\nexport ", fnStart + 1);
    const fnBody = source.slice(fnStart, fnEnd === -1 ? source.length : fnEnd);

    expect(fnBody).toContain("...(logo !== undefined ? { logo } : {})");
    expect(fnBody).toContain("...(displayName !== undefined ? { displayName } : {})");
    expect(fnBody).toContain("...(vendor !== undefined ? { vendor } : {})");
  });
});
