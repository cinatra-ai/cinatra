import { describe, expect, it } from "vitest";

import {
  selectExtensionOwnedTypeIds,
  type ExtensionTypeCandidate,
} from "../extension-owned-types";

// cinatra#3033 (lifecycle-c W9), acceptance item 1: "each of the four displays
// draws on the page, on the card and inside a third-party application at the
// pinned revision". The LinkedIn display drew on NONE of them, because the type
// it draws for is HOST-registered and only CLAIMED by its pack — so the §VI.1
// Confirm road, which asks the registry which type the extension owns, was told
// "none" and promoted nothing. Measured on a live boot: the person picked
// "Post draft" through the product's own Upload control, the meaning assertion
// landed, and the row stayed `@cinatra-ai/markdown-artifact:artifact`.

const LINKEDIN_PACK = "@cinatra-ai/linkedin-artifacts";
const LINKEDIN_TYPE = "@cinatra-ai/linkedin:post-draft";

const hostRegistered: ExtensionTypeCandidate = {
  typeId: LINKEDIN_TYPE,
  registeringPackage: null,
  resolves: true,
};

describe("W9 — the types an extension owns are the ones it registered AND the ones it claimed", () => {
  it("owns a HOST-registered type it claims — nothing else has provenance for it", () => {
    expect(
      selectExtensionOwnedTypeIds({
        extension: LINKEDIN_PACK,
        registeredTypeIds: [],
        claimedTypeIds: [LINKEDIN_TYPE],
        candidates: [hostRegistered],
      }),
    ).toEqual([LINKEDIN_TYPE]);
  });

  it("keeps every type its own package registered", () => {
    expect(
      selectExtensionOwnedTypeIds({
        extension: "@acme/legal",
        registeredTypeIds: ["@acme/legal:contract"],
        claimedTypeIds: [],
        candidates: [],
      }),
    ).toEqual(["@acme/legal:contract"]);
  });

  it("does NOT own a type ANOTHER PACKAGE registered, however it is claimed", () => {
    expect(
      selectExtensionOwnedTypeIds({
        extension: LINKEDIN_PACK,
        registeredTypeIds: [],
        claimedTypeIds: ["@acme/legal:contract"],
        candidates: [
          { typeId: "@acme/legal:contract", registeringPackage: "@acme/legal", resolves: true },
        ],
      }),
    ).toEqual([]);
  });

  it("does NOT own a claim NOTHING registers — an orphaned claim mints no type", () => {
    expect(
      selectExtensionOwnedTypeIds({
        extension: "@cinatra-ai/brand-voice-artifact",
        registeredTypeIds: [],
        claimedTypeIds: ["@cinatra-ai/brand-voice:guide"],
        candidates: [
          { typeId: "@cinatra-ai/brand-voice:guide", registeringPackage: null, resolves: false },
        ],
      }),
    ).toEqual([]);
  });

  it("dedupes and sorts, so a re-registered claim is counted once", () => {
    expect(
      selectExtensionOwnedTypeIds({
        extension: LINKEDIN_PACK,
        registeredTypeIds: [LINKEDIN_TYPE, "@z/pack:thing"],
        claimedTypeIds: [LINKEDIN_TYPE],
        candidates: [hostRegistered],
      }),
    ).toEqual([LINKEDIN_TYPE, "@z/pack:thing"]);
  });
});
