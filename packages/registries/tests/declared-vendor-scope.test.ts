/**
 * cinatra#3447 — step 3 of the vendor byline chain: the vendor identity a
 * package's OWN scope siblings DECLARE in the generated static manifest.
 *
 * Every first-party agent entry of the generated manifest carries
 * `"vendor":null`, so the §V settings header of an installed agent dropped the
 * "by {Vendor}" clause on every frame while the connector entries of the very
 * same scope declare `{"key":"cinatra-ai","name":"Cinatra"}`. The chain's
 * ratified ban stands: the name is read from DECLARED manifest data only — the
 * raw npm scope segment is never rendered as a vendor (scope.ts, the byline
 * docblock).
 */
import { describe, expect, it } from "vitest";
import { declaredVendorNameForScope, resolveInstalledVendorName } from "@cinatra-ai/registries";

/** The shape the generated static manifest carries, reduced to the read fields. */
const MANIFEST = [
  { packageName: "@cinatra-ai/research-agent", kind: "agent", vendor: null },
  { packageName: "@cinatra-ai/deep-research-agent", kind: "agent", vendor: null },
  {
    packageName: "@cinatra-ai/apify-connector",
    kind: "connector",
    vendor: { key: "cinatra-ai", name: "Cinatra" },
  },
  {
    packageName: "@cinatra-ai/default-artifact",
    kind: "artifact",
    vendor: { key: "cinatra-ai", name: "Cinatra" },
  },
  {
    packageName: "@meridian/ledger-connector",
    kind: "connector",
    vendor: { key: "meridian", name: "Meridian Labs" },
  },
];

describe("declaredVendorNameForScope (cinatra#3447 — byline chain step 3)", () => {
  it("reads the vendor name the package's own scope siblings DECLARE", () => {
    expect(declaredVendorNameForScope(MANIFEST, "@cinatra-ai/research-agent")).toBe("Cinatra");
    expect(declaredVendorNameForScope(MANIFEST, "@meridian/ledger-agent")).toBe("Meridian Labs");
  });

  it("never synthesizes a name from the scope segment itself", () => {
    // No entry of this scope declares a vendor identity, so there is no
    // declared name to read — and "orphan-scope" is NEVER the answer.
    expect(declaredVendorNameForScope(MANIFEST, "@orphan-scope/lonely-agent")).toBeNull();
    expect(
      declaredVendorNameForScope([{ vendor: { key: "acme", name: "   " } }], "@acme/thing"),
    ).toBeNull();
  });

  it("refuses to guess when the scope's declarations disagree", () => {
    expect(
      declaredVendorNameForScope(
        [
          { vendor: { key: "acme", name: "Acme Corp" } },
          { vendor: { key: "acme", name: "Acme Limited" } },
        ],
        "@acme/thing",
      ),
    ).toBeNull();
  });

  it("matches on the DECLARED vendor key, not on the entry's package name", () => {
    // A package published under one scope may declare another vendor's
    // identity; only the declared key decides.
    const resellerOfAcme = [
      { packageName: "@reseller/acme-connector", vendor: { key: "acme", name: "Acme Corp" } },
    ];
    const acmeReselling = [
      { packageName: "@acme/reseller-connector", vendor: { key: "other", name: "Other Inc" } },
    ];
    expect(declaredVendorNameForScope(resellerOfAcme, "@acme/thing")).toBe("Acme Corp");
    expect(declaredVendorNameForScope(acmeReselling, "@acme/thing")).toBeNull();
  });

  it("tolerates an unscoped or malformed package name, and malformed entries", () => {
    expect(declaredVendorNameForScope(MANIFEST, "bare-name")).toBeNull();
    expect(declaredVendorNameForScope(MANIFEST, "@/x")).toBeNull();
    expect(
      declaredVendorNameForScope(
        [null, undefined, { vendor: null }, { vendor: { name: "Nameless" } }, { vendor: { key: 7, name: "Numeric" } }],
        "@acme/thing",
      ),
    ).toBeNull();
  });

  it("feeds the byline chain: a first-party agent reads 'Cinatra', not nothing", () => {
    const vendor = resolveInstalledVendorName({
      // The agent entry's OWN declaration — null in the shipped manifest.
      manifestVendorName: null,
      // No registry summary author for a package that was never published.
      author: null,
      scopeVendorName: declaredVendorNameForScope(MANIFEST, "@cinatra-ai/research-agent"),
    });
    expect(vendor).toBe("Cinatra");
  });
});
