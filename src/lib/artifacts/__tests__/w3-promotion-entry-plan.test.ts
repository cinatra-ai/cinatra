// THE ROAD'S ENTRY, AND WHY A CONFIRMATION COULD NOT SAY WHY (cinatra#3091,
// wave 3 of #3087 — the resolution fix leg).
//
// MEASURED, NOT SUPPOSED. On the branch head under proof, confirming the
// `Slide Deck` meaning on an uploaded pdf in the library's picker retyped
// nothing AND reported nothing: the row kept its base type and the surface
// carried no reason. The road itself is not silent — its refusals are a closed,
// named set, and one of them is exactly this case:
//
//   "extension-owns-no-type" — The extension owns no type of its own to
//                              promote into.
//
// It was unreachable. The surface resolved the confirmed extension's own type
// from the object-type registry and returned NULL — no road, no report —
// whenever the count was not exactly one, which folds two different worlds into
// one silence:
//
//   1. A PURE MATCHER PACK. It declares no artifact type at all; there is
//      nothing to promote INTO and nothing worth reporting. The road genuinely
//      does not apply.
//   2. A PACK WHOSE DECLARED TYPE NEVER REGISTERED. It ships a display for a
//      type it declares, but the type-id's namespace is not its own package,
//      so ownership-by-namespace refuses the registration and NO package
//      registers that type. No row can ever carry it, the display can never be
//      reached, and a person confirming the meaning is told nothing.
//
// The second is a broken installation, not an inapplicable road, and this is
// the leaf that separates them. The evidence it separates them on is the pack's
// OWN registration state, read from the two registries: the artifact types it
// registered, and whether it ships a semantic display for a type no package
// registers.
import { describe, expect, it } from "vitest";

import { planPromotionEntry } from "../typed-promotion";

describe("planPromotionEntry — the typed promotion road's entry (#3091)", () => {
  it("runs the road for a pack that registered exactly one artifact type", () => {
    expect(
      planPromotionEntry({
        ownedRegisteredTypes: ["@cinatra-ai/screenshot-artifact:screenshot"],
        shipsDisplayForUnregisteredType: false,
      }),
    ).toEqual({ kind: "run", typeId: "@cinatra-ai/screenshot-artifact:screenshot" });
  });

  it("REFUSES, by name, for a pack that ships a display for a type no package registers", () => {
    // The slide-deck shape: a declared type whose namespace is not the pack's
    // own, refused by ownership-by-namespace, so the pack owns nothing while
    // still carrying a display for the orphaned id.
    expect(
      planPromotionEntry({
        ownedRegisteredTypes: [],
        shipsDisplayForUnregisteredType: true,
      }),
    ).toEqual({ kind: "refuse", reason: "extension-owns-no-type" });
  });

  it("stays inapplicable for a pure matcher pack — no type declared, nothing to report", () => {
    expect(
      planPromotionEntry({
        ownedRegisteredTypes: [],
        shipsDisplayForUnregisteredType: false,
      }),
    ).toEqual({ kind: "not-applicable" });
  });

  it("leaves a multi-type pack alone rather than guessing which type was meant", () => {
    expect(
      planPromotionEntry({
        ownedRegisteredTypes: ["@acme/pack:one", "@acme/pack:two"],
        shipsDisplayForUnregisteredType: false,
      }),
    ).toEqual({ kind: "not-applicable" });
  });

  it("prefers the one type it does own over an orphaned display it also ships", () => {
    // A pack can be BOTH: one registered type and a second declaration that
    // never registered. The road still has somewhere to go, so it goes.
    expect(
      planPromotionEntry({
        ownedRegisteredTypes: ["@acme/pack:one"],
        shipsDisplayForUnregisteredType: true,
      }),
    ).toEqual({ kind: "run", typeId: "@acme/pack:one" });
  });
});
