/**
 * cinatra#3033 — A CLAIMED TYPE NOTHING REGISTERS IS NAMED, NOT SILENT.
 *
 * Ownership of an artifact object type is by NAMESPACE: a pack registers only
 * the ids under its own package name, and a well-formed foreign id is recorded
 * as a cross-namespace RENDERER target whose owning package is the sole
 * registrar. That is right when the owner exists.
 *
 * When it does not, the claim resolves nowhere: the type never registers, so it
 * is absent from `listArtifacts()` and therefore absent from the artifacts
 * console's type map — with nothing, anywhere, saying why.
 *
 * MEASURED over the pinned tree: three claims are orphaned this way
 * (`@cinatra-ai/brand-voice:guide`, `@cinatra-ai/marketing-icp:profile`,
 * `@cinatra-ai/slide-deck:deck`) — one per `-artifact` pack that declares its
 * type under a namespace no installed package has.
 *
 * The LinkedIn post-draft is NOT one of them, though it reads like the same
 * shape: it RESOLVES, because the host is its single runtime registrar. Its own
 * absence from the console's type map (cinatra#3033) had a different cause —
 * no `isArtifact` descriptor on that registration — and is fixed there. Each
 * type an orphaned claim names is the claiming pack's to fix (its id must be
 * self-namespaced, a change in that pack and a re-pin here); what this pins is
 * the floor: the map states what it could not draw instead of leaving a hole.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { objectTypeRegistry } from "../../registry";
import {
  registerParsedArtifactManifest,
  claimedTypeIdsWithNoRegistrar,
  reportClaimedTypeIdsWithNoRegistrar,
  forgetCrossNamespaceClaimsOf,
} from "../register-artifact-extensions";

const OWNER = "@cinatra-ai/owning-artifacts";
const CLAIMANT = "@cinatra-ai/claiming-artifacts";

/** A minimal descriptor declaring exactly the given claimed type ids. */
function descriptorDeclaring(typeIds: string[]) {
  return {
    accepts: { file: { mimeTypes: ["text/markdown"] } },
    objectTypes: typeIds.map((type) => ({
      type,
      claim: "dedicated" as const,
      schema: { type: "object" } as Record<string, unknown>,
    })),
  };
}

beforeEach(() => {
  objectTypeRegistry._clearForTests();
  // Reconcile both packs so no ledger row survives a previous case.
  registerParsedArtifactManifest(descriptorDeclaring([]), OWNER);
  registerParsedArtifactManifest(descriptorDeclaring([]), CLAIMANT);
});

describe("the cross-namespace claim ledger", () => {
  it("names a claimed id whose owning namespace belongs to no installed package", () => {
    registerParsedArtifactManifest(
      descriptorDeclaring(["@cinatra-ai/nobody:post-draft"]),
      CLAIMANT,
    );
    const orphans = claimedTypeIdsWithNoRegistrar();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      typeId: "@cinatra-ai/nobody:post-draft",
      owningNamespace: "@cinatra-ai/nobody",
      claimedBy: [CLAIMANT],
    });
    const lines = reportClaimedTypeIdsWithNoRegistrar();
    expect(lines).toHaveLength(1);
    // ONE LINE, and it says only what this reading can establish: what is
    // missing, who asked for it, and that nothing here defines it — never that
    // a package is "not installed", which the registry cannot answer.
    expect(lines[0]).toContain("@cinatra-ai/nobody:post-draft");
    expect(lines[0]).toContain(CLAIMANT);
    expect(lines[0]).toContain("nothing registered it in this process");
  });

  it("says nothing about a foreign claim whose OWNER does register the type", () => {
    // The legitimate cross-namespace case (cinatra#1896): a pack renders a type
    // another pack owns. Nothing is missing, so nothing is reported.
    registerParsedArtifactManifest(
      descriptorDeclaring([`${OWNER}:report`]),
      OWNER,
    );
    registerParsedArtifactManifest(
      descriptorDeclaring([`${OWNER}:report`]),
      CLAIMANT,
    );
    expect(objectTypeRegistry.getRegisteringPackage(`${OWNER}:report`)).toBe(OWNER);
    expect(claimedTypeIdsWithNoRegistrar()).toEqual([]);
  });

  it("a pack that DROPS the claim stops being reported for it", () => {
    registerParsedArtifactManifest(
      descriptorDeclaring(["@cinatra-ai/nobody:post-draft"]),
      CLAIMANT,
    );
    expect(claimedTypeIdsWithNoRegistrar()).toHaveLength(1);
    // Re-register the same pack with the claim gone — the same reconcile the
    // dev watcher performs.
    registerParsedArtifactManifest(descriptorDeclaring([]), CLAIMANT);
    expect(claimedTypeIdsWithNoRegistrar()).toEqual([]);
  });

  it("an UNINSTALLED pack stops being reported — the ledger reaps at teardown parity", () => {
    // The reconcile above is the re-registration road. Teardown is the other
    // one, and it is the road `removeByPackage` cannot travel for a claim: a
    // cross-namespace claimant registers no type of its own, so nothing in the
    // type registry names it. Without this reap an uninstalled pack keeps a
    // claim on the books and the map keeps naming a gap nobody asks about.
    registerParsedArtifactManifest(
      descriptorDeclaring(["@cinatra-ai/nobody:post-draft"]),
      CLAIMANT,
    );
    expect(claimedTypeIdsWithNoRegistrar()).toHaveLength(1);
    forgetCrossNamespaceClaimsOf(CLAIMANT);
    expect(claimedTypeIdsWithNoRegistrar()).toEqual([]);
  });

  it("reaping one pack leaves ANOTHER pack's claim on the same id standing", () => {
    const SECOND = "@cinatra-ai/second-claiming-artifacts";
    registerParsedArtifactManifest(
      descriptorDeclaring(["@cinatra-ai/nobody:post-draft"]),
      CLAIMANT,
    );
    registerParsedArtifactManifest(
      descriptorDeclaring(["@cinatra-ai/nobody:post-draft"]),
      SECOND,
    );
    forgetCrossNamespaceClaimsOf(CLAIMANT);
    const orphans = claimedTypeIdsWithNoRegistrar();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.claimedBy).toEqual([SECOND]);
  });
});
