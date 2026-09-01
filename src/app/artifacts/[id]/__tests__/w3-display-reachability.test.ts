// WHY AN UPLOADED SCREENSHOT AND AN UPLOADED DECK DREW THE BASE DISPLAY
// (cinatra#3091, wave 3 of #3087 — the resolution fix leg).
//
// The first proof leg measured two artifact pages drawing the BASE display rather
// than the display the wave pinned. This suite locates the break by MEASUREMENT
// against the real pinned packs, so the record names one road and not a guess.
//
// IT IS NOT THE RESOLUTION. For a row that carries the kind's own object type,
// the page's own resolver reaches the kind's own detail entry in the generated
// map — proved below for every kind the proof leg owed and every kind it
// delivered. The break is upstream of the page: a row of that kind has to exist
// first.
//
// IT IS THE TYPE'S OWNERSHIP. A display is reachable only through an object
// type SOME package registers, and ownership is by namespace: a pack registers
// only the types whose id begins with its own package name. A declared type in
// a namespace no installed package owns is registered by nobody, so no row can
// ever carry it and the pack owns no type at all — which is also what makes the
// typed promotion road refuse, by name, instead of silently doing nothing.
import { afterEach, describe, expect, it } from "vitest";

import { resolve } from "node:path";

import { registerArtifactExtensionDir } from "@cinatra-ai/objects/register-artifact-extensions";
import { matcherManifestRegistry, objectTypeRegistry } from "@cinatra-ai/objects/registry";
import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";
import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

import { planPromotionEntry } from "@/lib/artifacts/typed-promotion";
import { GENERATED_ARTIFACT_RENDERERS } from "@/lib/generated/artifact-renderers";

import { resolveArtifactDispatchInputs, _resetFirstPartySeedForTests } from "../renderer-resolution";
import { pickArtifactRenderer } from "../renderer-dispatch";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");
const ORG = "org_w3_reachability";

// The kinds this leg is answering for: the three the proof leg owed, plus the
// three whose byte-road reading came back empty. Each row names the pack, the
// object type a row of the kind carries, and a form the pack accepts.
const KINDS = [
  ["screenshot-artifact", "@cinatra-ai/screenshot-artifact:screenshot", "image/png"],
  ["slide-deck-artifact", "@cinatra-ai/slide-deck:deck", "application/pdf"],
  ["cms-snapshot-artifact", "@cinatra-ai/cms-snapshot-artifact:artifact", "application/vnd.cinatra.cms-fields+json"],
  ["pdf-artifact", "@cinatra-ai/pdf-artifact:document", "application/pdf"],
  ["json-artifact", "@cinatra-ai/json-artifact:artifact", "application/json"],
  ["text-artifact", "@cinatra-ai/text-artifact:artifact", "text/csv"],
] as const;

function registerFleet(): void {
  for (const [slug] of KINDS) {
    registerArtifactExtensionDir(resolve(REPO_ROOT, "extensions/cinatra-ai", slug));
  }
}

function winner(extension: string): EffectiveIdentity {
  return { kind: "extension", extension };
}

afterEach(() => {
  for (const [slug] of KINDS) {
    objectTypeRegistry.removeByPackage("@cinatra-ai/" + slug);
    semanticRendererRegistry.removeByPackage("@cinatra-ai/" + slug);
    // Registering an extension dir writes THREE process-global registries, so
    // the teardown drops all three — a matcher manifest left behind would
    // travel to whatever test this worker runs next.
    matcherManifestRegistry.removeByPackage("@cinatra-ai/" + slug);
  }
  representationProviderRegistry._clearForTests(true);
  _resetFirstPartySeedForTests();
});

// WHAT THIS DESCRIBE MEASURES, EXACTLY. The resolver is handed the two facts
// the page hands it: the row's object type, and the effective identity the
// presentation road already picked. It therefore measures the RESOLUTION leaf —
// given a row of the kind and that kind's pack as the winner, does the page
// reach the kind's own display at the props version the wave pinned. It does
// NOT measure how a pack becomes the winner, and it is not evidence that a deck
// row can exist: the ownership describe below is where that is answered, and
// the answer there is that it cannot.
describe("the resolver reaches every kind's OWN display at props version 2, given a row of that kind and that kind's pack as the winner (#3091)", () => {
  it.each(KINDS)("%s", (slug, objectType, mime) => {
    registerFleet();
    const packageName = "@cinatra-ai/" + slug;
    const generatedKey = packageName + "::detail";
    const dispatch = pickArtifactRenderer(
      resolveArtifactDispatchInputs({
        orgId: ORG,
        baseType: objectType,
        identity: winner(packageName),
        mime,
      }),
    );
    expect(dispatch).toEqual({ kind: "semantic", packageName, generatedKey });
    // The key alone only says a module is loadable. The wave's claim is about
    // the CONTRACT the page mounts it under, so read the version off the
    // generated entry the key names rather than asserting it in prose.
    expect(GENERATED_ARTIFACT_RENDERERS[generatedKey]?.propsApiVersion).toBe(2);
  });
});

describe("a display is reachable only through a type some package registers (#3091)", () => {
  it("the screenshot kind owns its own type, so a promoted row can carry it", () => {
    registerFleet();
    expect(
      objectTypeRegistry.getRegisteringPackage("@cinatra-ai/screenshot-artifact:screenshot"),
    ).toBe("@cinatra-ai/screenshot-artifact");
    expect(
      objectTypeRegistry.getTypesForPackage("@cinatra-ai/screenshot-artifact"),
    ).toEqual(["@cinatra-ai/screenshot-artifact:screenshot"]);
  });

  it("the deck kind's declared type is registered by NOBODY — the measured break", () => {
    registerFleet();
    // The pack is @cinatra-ai/slide-deck-artifact; the type it declares is
    // @cinatra-ai/slide-deck:deck. Ownership is by namespace and no installed
    // package is @cinatra-ai/slide-deck, so the registrar refuses the claim.
    expect(objectTypeRegistry.getRegisteringPackage("@cinatra-ai/slide-deck:deck")).toBeNull();
    expect(objectTypeRegistry.getTypesForPackage("@cinatra-ai/slide-deck-artifact")).toEqual([]);
  });

  it("and the pack still ships a display for that orphaned type", () => {
    registerFleet();
    expect(semanticRendererRegistry.listByPackage("@cinatra-ai/slide-deck-artifact")).toEqual([
      {
        objectTypeId: "@cinatra-ai/slide-deck:deck",
        packageName: "@cinatra-ai/slide-deck-artifact",
        slot: "detail",
        generatedKey: "@cinatra-ai/slide-deck-artifact::detail",
      },
    ]);
  });

  it("so the road refuses the confirmation BY NAME instead of reporting nothing", () => {
    registerFleet();
    const packageName = "@cinatra-ai/slide-deck-artifact";
    const owned = objectTypeRegistry.getTypesForPackage(packageName);
    const orphaned = semanticRendererRegistry
      .listByPackage(packageName)
      .some((d) => objectTypeRegistry.getRegisteringPackage(d.objectTypeId) === null);
    expect(planPromotionEntry({
      ownedRegisteredTypes: owned,
      shipsDisplayForUnregisteredType: orphaned,
    })).toEqual({ kind: "refuse", reason: "extension-owns-no-type" });
  });

  it("no OTHER kind in the wave ships a display for a type nobody registers", () => {
    registerFleet();
    const orphaned: string[] = [];
    for (const [slug] of KINDS) {
      const packageName = "@cinatra-ai/" + slug;
      for (const desc of semanticRendererRegistry.listByPackage(packageName)) {
        if (objectTypeRegistry.getRegisteringPackage(desc.objectTypeId) === null) {
          orphaned.push(packageName + " -> " + desc.objectTypeId);
        }
      }
    }
    // The one known orphan is the deck's, tracked for its own repository's fix
    // plus a re-pin here; anything else appearing in this list is new.
    expect(orphaned).toEqual(["@cinatra-ai/slide-deck-artifact -> @cinatra-ai/slide-deck:deck"]);
  });
});
