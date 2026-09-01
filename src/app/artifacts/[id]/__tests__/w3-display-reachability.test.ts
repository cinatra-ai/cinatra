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
//
// RE-MEASURED AT THE RE-PINNED HEADS. The one pack that failed that rule was
// the deck's, and it was named here as the measured break with its own
// repository owed the fix. That repository renamed the type to its own
// namespace and this branch re-pinned it, so the rungs below now measure a
// wave with NO orphaned display — while the host rule that produced the
// refusal is asserted directly, on the pure planner, so it stays pinned
// without depending on any pack shipping a violation for it to catch.
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
  ["slide-deck-artifact", "@cinatra-ai/slide-deck-artifact:deck", "application/pdf"],
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

  it("the deck kind now owns its own type too — the break the diagnosis leg named is closed", () => {
    registerFleet();
    // The pack is @cinatra-ai/slide-deck-artifact and the type it declares is
    // now @cinatra-ai/slide-deck-artifact:deck, so the namespace rule that
    // refused the old claim is SATISFIED rather than relaxed: ownership is
    // read off the registry, which is the only thing that decides it.
    expect(objectTypeRegistry.getRegisteringPackage("@cinatra-ai/slide-deck-artifact:deck")).toBe(
      "@cinatra-ai/slide-deck-artifact",
    );
    expect(objectTypeRegistry.getTypesForPackage("@cinatra-ai/slide-deck-artifact")).toEqual([
      "@cinatra-ai/slide-deck-artifact:deck",
    ]);
  });

  it("a type under a namespace NO installed package owns is still registered by nobody", () => {
    registerFleet();
    // The rule, not the pack: the deck pack's former declaration is used here
    // only as a known-foreign id. Nothing installed is @cinatra-ai/slide-deck,
    // so the registrar refuses the claim exactly as it always did.
    expect(objectTypeRegistry.getRegisteringPackage("@cinatra-ai/slide-deck:deck")).toBeNull();
  });

  it("and the display the deck pack ships is for the type it now owns", () => {
    registerFleet();
    expect(semanticRendererRegistry.listByPackage("@cinatra-ai/slide-deck-artifact")).toEqual([
      {
        objectTypeId: "@cinatra-ai/slide-deck-artifact:deck",
        packageName: "@cinatra-ai/slide-deck-artifact",
        slot: "detail",
        generatedKey: "@cinatra-ai/slide-deck-artifact::detail",
      },
    ]);
  });

  it("so the promotion road now RUNS for the deck pack, on the type it owns", () => {
    registerFleet();
    const packageName = "@cinatra-ai/slide-deck-artifact";
    const owned = objectTypeRegistry.getTypesForPackage(packageName);
    const orphaned = semanticRendererRegistry
      .listByPackage(packageName)
      .some((d) => objectTypeRegistry.getRegisteringPackage(d.objectTypeId) === null);
    expect(orphaned).toBe(false);
    expect(
      planPromotionEntry({
        ownedRegisteredTypes: owned,
        shipsDisplayForUnregisteredType: orphaned,
      }),
    ).toEqual({ kind: "run", typeId: "@cinatra-ai/slide-deck-artifact:deck" });
  });

  it("and the road STILL refuses BY NAME for a pack that owns no type but ships a display", () => {
    // The host rule that produced the diagnosis leg's refusal, asserted on the
    // planner itself. No pack in the wave is in that state any more, so
    // measuring it through a pack would have measured nothing — and a rule
    // that stops being asserted the moment nothing violates it is a rule that
    // quietly stops holding.
    expect(
      planPromotionEntry({ ownedRegisteredTypes: [], shipsDisplayForUnregisteredType: true }),
    ).toEqual({ kind: "refuse", reason: "extension-owns-no-type" });
  });

  it("NO kind in the wave ships a display for a type nobody registers", () => {
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
    // The wave's one known orphan was the deck's and the re-pin closed it.
    // Anything appearing in this list now is new.
    expect(orphaned).toEqual([]);
  });
});
