/**
 * cinatra#3603 — the reader's admissible-type set is the WRITER's set.
 *
 * The cut gives every claim-backed reader the same source of admissible types
 * the writer already uses. The one thing a reviewer must be able to check
 * without running a database is that the new org-wide set is NOT WIDER than
 * what the writer admits — so this suite MEASURES it rather than asserting it:
 * over one claim fixture (a dormant claim, a retired claim, a `none`-projection
 * claim, a claim over a type no registrar registered, and a CONTESTED pair
 * whose platform-scope artifact-safe claim LOSES to an org-scope `none`
 * winner), the helper's
 * claim-derived addition is compared against the union of the write side's own
 * `readEffectiveArtifactSafeTypeIdsForExtension` over the extensions those same
 * claim rows name.
 *
 * No database: the claim store is mocked for BOTH sides at once, so the two
 * functions arbitrate the identical rows.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import {
  claimWinnerProjectionDisposition,
  resolveClaimWinner,
  type ArbitrableClaim,
} from "@cinatra-ai/objects/claims";

const ORG = "org-3603-unit";

/** A SELF-registered bridge artifact type (its own pack's namespace) — carries
 * `isArtifact`, so it is in `listArtifacts()` with or without a claim. */
const T_SELF = "@cinatra-ai/selfpack:doc";
const EXT_SELF = "@cinatra-ai/selfpack";
/** A registered artifact type NOBODY claims — in `listArtifacts()` only. */
const T_UNCLAIMED_ARTIFACT = "@cinatra-ai/otherpack:thing";
const EXT_OTHER = "@cinatra-ai/otherpack";
/** HOST-SHAPED: registered host-side with a disposition and NO `isArtifact`,
 * claimed by a package whose name is not the type's namespace. */
const T_HOST = "@cinatra-ai/hostns:post";
const T_HOST_NONE = "@cinatra-ai/hostns:recipient";
const T_HOST_DORMANT = "@cinatra-ai/hostns:dormant";
const T_HOST_RETIRED = "@cinatra-ai/hostns:retired";
const EXT_CLAIMANT = "@cinatra-ai/hostns-artifacts";
/** Claimed, artifact-safe — and registered by NO registrar in this process. */
const T_UNREGISTERED = "@cinatra-ai/nowhere:thing";
const EXT_NOWHERE = "@cinatra-ai/nowhere-artifacts";
/** CONTESTED: a PLATFORM-scope artifact-safe claim by one package and the
 * ORG-scope WINNER (same kind, higher precedence) projecting `none` by another.
 * Arbitration must run BEFORE the projection filter, or a LOSING artifact-safe
 * claim would admit a type whose winner projects nothing. */
const T_HOST_CONTESTED = "@cinatra-ai/hostns:contested";
const EXT_PLATFORM_CLAIMANT = "@cinatra-ai/hostns-platform-artifacts";

function claim(input: {
  id: string;
  type: string;
  ext: string;
  status: string;
  projection?: "artifact-safe" | "none";
  scope?: "platform";
}): ArbitrableClaim {
  return {
    id: input.id,
    scope: input.scope === "platform" ? "platform" : `org:${ORG}`,
    objectTypeId: input.type,
    claimKind: "dedicated",
    status: input.status as ArbitrableClaim["status"],
    extensionPackage: input.ext,
    extensionVersion: "1.0.0",
    generation: 1,
    dispositions:
      input.projection === "none"
        ? { projection: "none", pinnable: false, snapshotPolicy: "none" }
        : { projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" },
  };
}

const CLAIMS: ArbitrableClaim[] = [
  claim({ id: "c-self", type: T_SELF, ext: EXT_SELF, status: "active" }),
  claim({ id: "c-host", type: T_HOST, ext: EXT_CLAIMANT, status: "active" }),
  claim({
    id: "c-none",
    type: T_HOST_NONE,
    ext: EXT_CLAIMANT,
    status: "active",
    projection: "none",
  }),
  claim({ id: "c-dormant", type: T_HOST_DORMANT, ext: EXT_CLAIMANT, status: "dormant" }),
  claim({ id: "c-retired", type: T_HOST_RETIRED, ext: EXT_CLAIMANT, status: "retired" }),
  claim({ id: "c-nowhere", type: T_UNREGISTERED, ext: EXT_NOWHERE, status: "active" }),
  // The contested pair: the platform claim is artifact-safe and LOSES to the
  // org-scope claim of the same kind, which projects `none`.
  claim({
    id: "c-contested-platform",
    type: T_HOST_CONTESTED,
    ext: EXT_PLATFORM_CLAIMANT,
    status: "active",
    scope: "platform",
  }),
  claim({
    id: "c-contested-org",
    type: T_HOST_CONTESTED,
    ext: EXT_CLAIMANT,
    status: "active",
    projection: "none",
  }),
];

// The claim store — mocked once for BOTH sides, so the reader's helper and the
// writer's resolver arbitrate the identical rows without a database.
vi.mock("@/lib/objects/artifact-claim-store", () => ({
  readArtifactTypeClaimsForOrg: () => CLAIMS,
}));
// The heavy boot registrar, so this suite's directly-registered types survive
// the helper's registry warm.
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));

// ONE module now holds both halves: the reader's org-wide helper and the
// writer's per-extension resolver, sharing the arbitration (cinatra#3603).
let helperMod: typeof import("@/lib/artifacts/resolve-bound-artifact-type");
let writeSideMod: typeof import("@/lib/artifacts/resolve-bound-artifact-type");

function registerSelfRegistered(type: string, packageName: string) {
  objectTypeRegistry.register(
    {
      type,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } },
      dispositions: { projection: "artifact-safe" },
    } as never,
    packageName,
  );
}

function registerHostShaped(type: string, projection: "artifact-safe" | "none") {
  objectTypeRegistry.register({
    type,
    category: "report",
    schema: z.record(z.string(), z.unknown()),
    lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
    renderers: { listRow: null, card: null, detail: null },
    // No `isArtifact`, no package name — the host registrar's exact shape.
    dispositions: { projection },
  } as never);
}

beforeAll(async () => {
  helperMod = await import("@/lib/artifacts/resolve-bound-artifact-type");
  writeSideMod = helperMod;
  objectTypeRegistry._clearForTests();
  registerSelfRegistered(T_SELF, EXT_SELF);
  registerSelfRegistered(T_UNCLAIMED_ARTIFACT, EXT_OTHER);
  registerHostShaped(T_HOST, "artifact-safe");
  registerHostShaped(T_HOST_NONE, "none");
  registerHostShaped(T_HOST_DORMANT, "artifact-safe");
  registerHostShaped(T_HOST_RETIRED, "artifact-safe");
  registerHostShaped(T_HOST_CONTESTED, "artifact-safe");
  // T_UNREGISTERED is deliberately registered NOWHERE.
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  objectTypeRegistry._clearForTests();
  vi.resetModules();
});

const registeredArtifactTypes = () =>
  objectTypeRegistry
    .listArtifacts()
    .map((d) => d.type)
    .sort();

/** The writer's own answer, unioned over the extensions THESE claim rows name. */
const writerUnion = () => {
  const extensions = [...new Set(CLAIMS.map((c) => c.extensionPackage))];
  const out = new Set<string>();
  for (const ext of extensions) {
    for (const t of writeSideMod.readEffectiveArtifactSafeTypeIdsForExtension(ORG, ext)) {
      out.add(t);
    }
  }
  return [...out].sort();
};

describe("cinatra#3603 — readAdmissibleArtifactTypeIdsForOrg", () => {
  it("is the registered artifact types PLUS exactly the writer's artifact-safe claim winners", () => {
    const admissible = helperMod.readAdmissibleArtifactTypeIdsForOrg(ORG);
    const expected = [
      ...new Set([...registeredArtifactTypes(), ...writerUnion()]),
    ].sort();
    expect(admissible).toEqual(expected);
  });

  it("is NO WIDER than the writer: everything it adds beyond the registry is a type the writer admits", () => {
    const registered = registeredArtifactTypes();
    const admissible = helperMod.readAdmissibleArtifactTypeIdsForOrg(ORG);
    const added = admissible.filter((t) => !registered.includes(t));
    const writerAdds = writerUnion().filter((t) => !registered.includes(t));
    expect(added).toEqual(writerAdds);
    // And the addition is real: the host-shaped claim-backed type is in it.
    expect(added).toContain(T_HOST);
  });

  it("excludes a dormant claim, a retired claim, a 'none' projection and an unregistered type", () => {
    const admissible = helperMod.readAdmissibleArtifactTypeIdsForOrg(ORG);
    expect(admissible).not.toContain(T_HOST_DORMANT);
    expect(admissible).not.toContain(T_HOST_RETIRED);
    expect(admissible).not.toContain(T_HOST_NONE);
    expect(admissible).not.toContain(T_UNREGISTERED);
    // A registered artifact type nobody claims is still admissible.
    expect(admissible).toContain(T_UNCLAIMED_ARTIFACT);
  });

  it("follows the WINNING claim, not any artifact-safe claim: an org-scope 'none' winner beats a platform artifact-safe claim", () => {
    // Independently expected, not compared against the writer: the winner of
    // T_HOST_CONTESTED is the org-scope claim (dedicated + org outranks
    // dedicated + platform) and it projects `none`, so the type is NOT
    // admissible even though a live artifact-safe claim exists over it. A
    // projection filter applied BEFORE arbitration would admit it here.
    const winner = resolveClaimWinner(CLAIMS, {
      orgId: ORG,
      objectTypeId: T_HOST_CONTESTED,
    });
    expect(winner?.id).toBe("c-contested-org");
    expect(claimWinnerProjectionDisposition(winner!)).toBe("none");
    expect(helperMod.readAdmissibleArtifactTypeIdsForOrg(ORG)).not.toContain(
      T_HOST_CONTESTED,
    );
    // And the write side agrees for the losing claimant's own extension.
    expect(
      writeSideMod.readEffectiveArtifactSafeTypeIdsForExtension(
        ORG,
        EXT_PLATFORM_CLAIMANT,
      ),
    ).not.toContain(T_HOST_CONTESTED);
  });

  it("reads the claim chain through its injectable input when one is given", () => {
    const seen: string[] = [];
    const admissible = helperMod.readAdmissibleArtifactTypeIdsForOrg(ORG, {
      readClaimsForOrg: (orgId) => {
        seen.push(orgId);
        return [];
      },
    });
    expect(seen).toEqual([ORG]);
    // With no claims at all, the set is the registered artifact types alone.
    expect(admissible).toEqual(registeredArtifactTypes());
  });
});
