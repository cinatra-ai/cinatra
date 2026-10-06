/**
 * cinatra#3033 (CELL4, the confirmation) — the pure owned-type selection the
 * §VI.1 Confirm road reads: the ids a package REGISTERED, plus the ids it
 * CLAIMED that resolve and carry no registering package (a host-registered
 * type, as the LinkedIn post draft is). A claim over another package's
 * registered type is a display registration and never ownership.
 */
import { describe, expect, it } from "vitest";

import { selectExtensionOwnedTypeIds } from "../extension-owned-types";

const PACK = "@cinatra-ai/linkedin-artifacts";

describe("selectExtensionOwnedTypeIds (cinatra#3033)", () => {
  it("keeps every id the package registered", () => {
    expect(
      selectExtensionOwnedTypeIds({
        extension: "@acme/legal",
        registeredTypeIds: ["@acme/legal:nda", "@acme/legal:contract"],
        claimedTypeIds: [],
        candidates: [],
      }),
    ).toEqual(["@acme/legal:contract", "@acme/legal:nda"]);
  });

  it("keeps a claimed id that resolves and has no registering package", () => {
    expect(
      selectExtensionOwnedTypeIds({
        extension: PACK,
        registeredTypeIds: [],
        claimedTypeIds: ["@cinatra-ai/linkedin:post-draft"],
        candidates: [
          {
            typeId: "@cinatra-ai/linkedin:post-draft",
            registeringPackage: null,
            resolves: true,
          },
        ],
      }),
    ).toEqual(["@cinatra-ai/linkedin:post-draft"]);
  });

  it("drops a claimed id that does not resolve", () => {
    expect(
      selectExtensionOwnedTypeIds({
        extension: PACK,
        registeredTypeIds: [],
        claimedTypeIds: ["@cinatra-ai/nowhere:thing"],
        candidates: [
          { typeId: "@cinatra-ai/nowhere:thing", registeringPackage: null, resolves: false },
        ],
      }),
    ).toEqual([]);
  });

  it("drops a claimed id with no candidate reading at all", () => {
    expect(
      selectExtensionOwnedTypeIds({
        extension: PACK,
        registeredTypeIds: [],
        claimedTypeIds: ["@cinatra-ai/unread:thing"],
        candidates: [],
      }),
    ).toEqual([]);
  });

  it("drops a claim over another package's registered type", () => {
    expect(
      selectExtensionOwnedTypeIds({
        extension: "@acme/meaning-pack",
        registeredTypeIds: [],
        claimedTypeIds: ["@cinatra-ai/dashboard-artifact:dashboard"],
        candidates: [
          {
            typeId: "@cinatra-ai/dashboard-artifact:dashboard",
            registeringPackage: "@cinatra-ai/dashboard-artifact",
            resolves: true,
          },
        ],
      }),
    ).toEqual([]);
  });

  it("answers sorted and deduplicated", () => {
    expect(
      selectExtensionOwnedTypeIds({
        extension: "@acme/mixed",
        registeredTypeIds: ["@acme/mixed:b", "@acme/mixed:a", "@acme/mixed:b"],
        claimedTypeIds: ["@host/x:z", "@acme/mixed:a", "@host/x:z"],
        candidates: [
          { typeId: "@host/x:z", registeringPackage: null, resolves: true },
          { typeId: "@acme/mixed:a", registeringPackage: "@acme/mixed", resolves: true },
        ],
      }),
    ).toEqual(["@acme/mixed:a", "@acme/mixed:b", "@host/x:z"]);
  });
});
