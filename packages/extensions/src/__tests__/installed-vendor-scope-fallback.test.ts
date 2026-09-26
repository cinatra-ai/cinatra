/**
 * cinatra#3447 — the §V header byline of an installed agent, read through the
 * extensions-side module path the loader itself imports.
 *
 * Grounded on the SHIPPED data: the generated static extension manifest
 * declares `cinatra.vendor` on connector/artifact entries of the `cinatra-ai`
 * scope and on NO agent entry, so the byline chain's first two steps return
 * nothing for a first-party agent and the header dropped its "by {Vendor}"
 * clause on every frame. The third step reads the vendor identity the scope's
 * own entries DECLARE — never the raw npm scope segment.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  declaredVendorNameForScope,
  resolveInstalledVendorName,
} from "../screens/installed-vendor";

/** The generated manifest, read as text: importing it drags the host's
 *  server-only extension-load guard into this sandbox. */
const GENERATED_MANIFEST = readFileSync(
  path.resolve(__dirname, "../../../../src/lib/generated/extensions.server.ts"),
  "utf-8",
);

/** Every declared vendor identity in the generated manifest, as data. */
const DECLARED_ENTRIES = [
  ...GENERATED_MANIFEST.matchAll(/"vendor":\{"key":"([^"]+)","name":"([^"]+)"\}/g),
].map((m) => ({ vendor: { key: m[1], name: m[2] } }));

describe("the shipped manifest's own vendor declarations (cinatra#3447)", () => {
  it("declares the first-party vendor identity, under ONE human name", () => {
    const firstParty = DECLARED_ENTRIES.filter((e) => e.vendor.key === "cinatra-ai");
    expect(firstParty.length).toBeGreaterThan(0);
    expect(new Set(firstParty.map((e) => e.vendor.name))).toEqual(new Set(["Cinatra"]));
  });

  it("resolves the byline of a first-party agent that declares no vendor of its own", () => {
    // The loader's own call shape: the agent entry's `vendor` is null and a
    // never-published package has no registry author.
    const vendor = resolveInstalledVendorName({
      manifestVendorName: null,
      author: null,
      scopeVendorName: declaredVendorNameForScope(
        DECLARED_ENTRIES,
        "@cinatra-ai/deep-research-agent",
      ),
    });
    expect(vendor).toBe("Cinatra");
  });

  it("still renders no vendor for a scope whose entries declare none", () => {
    expect(
      resolveInstalledVendorName({
        manifestVendorName: null,
        author: null,
        scopeVendorName: declaredVendorNameForScope(DECLARED_ENTRIES, "@nobody/orphan-agent"),
      }),
    ).toBeNull();
  });
});
