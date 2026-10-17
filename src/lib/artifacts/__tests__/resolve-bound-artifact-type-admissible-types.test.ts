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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { matcherManifestRegistry, objectTypeRegistry } from "@cinatra-ai/objects/registry";
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
  version?: string;
}): ArbitrableClaim {
  return {
    id: input.id,
    scope: input.scope === "platform" ? "platform" : `org:${ORG}`,
    objectTypeId: input.type,
    claimKind: "dedicated",
    status: input.status as ArbitrableClaim["status"],
    extensionPackage: input.ext,
    extensionVersion: input.version ?? "1.0.0",
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
// cinatra#3319 T3: the manifest reader's discovery. ONE vi.mock per module, each
// reading this mutable state. Unset, the roots throw and discovery finds nothing,
// which the reader takes as "no store"; only T3 reaches these modules at all.
const t3Store: {
  dataRoot: string | null;
  devRoot: string | null;
  records: Array<{ packageName: string; storeDir: string }>;
  discoverCalls: number;
} = { dataRoot: null, devRoot: null, records: [], discoverCalls: 0 };
vi.mock("@/lib/extension-data-root", () => ({
  resolveExtensionDataRoot: () => {
    if (t3Store.dataRoot === null) throw new Error("no extension data root in this suite");
    return t3Store.dataRoot;
  },
}));
vi.mock("@/lib/extension-store-io", () => ({
  discoverStoreRecordsV2: async () => {
    t3Store.discoverCalls += 1;
    return t3Store.records;
  },
}));
vi.mock("@cinatra-ai/agents/agent-runtime-mount", () => ({
  resolveDevExtensionSourceRoot: () => {
    if (t3Store.devRoot === null) throw new Error("no dev extension root in this suite");
    return t3Store.devRoot;
  },
}));

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

// ---------------------------------------------------------------------------
// cinatra#3319 T3 — readClaimBackedMeaningTypesForOrg: the picker's claim-backed
// channel, read from the same arbitration and bound to the winner's own
// manifest version.
// ---------------------------------------------------------------------------

const T_POST_DRAFT = "@cinatra-ai/linkedin:post-draft";
const EXT_LINKEDIN = "@cinatra-ai/linkedin-artifacts";
/** Host-shaped, claimed by EXT_SELF — a pack that owns an `isArtifact` type. */
const T3_SELF_PACK_HOST = "@cinatra-ai/t3self:note";
/** Its pack's manifest declares matchers. */
const T3_MATCHERS = "@cinatra-ai/t3matchers:note";
const EXT_T3_MATCHERS = "@cinatra-ai/t3matchers-artifacts";
/** Three winners for one pack. */
const T3_MULTI = ["@cinatra-ai/t3multi:a", "@cinatra-ai/t3multi:b", "@cinatra-ai/t3multi:c"];
const EXT_T3_MULTI = "@cinatra-ai/t3multi-artifacts";
/** Its pack's manifest accepts nothing. */
const T3_NO_ACCEPTS = "@cinatra-ai/t3noaccepts:note";
const EXT_T3_NO_ACCEPTS = "@cinatra-ai/t3noaccepts-artifacts";
/** Registered BY a package (no `isArtifact`), claimed by another package. */
const T3_OWNED = "@cinatra-ai/t3owned:note";
const EXT_T3_OWNER = "@cinatra-ai/t3owned";
const EXT_T3_OWNED_CLAIMANT = "@cinatra-ai/t3owned-artifacts";

const POST_DRAFT_ACCEPTS = ["text/markdown", "text/plain"];
const POST_DRAFT_ENTRY = {
  objectTypeId: T_POST_DRAFT,
  extension: EXT_LINKEDIN,
  acceptMimes: POST_DRAFT_ACCEPTS,
};

function registerPackageOwned(type: string, packageName: string) {
  objectTypeRegistry.register(
    {
      type,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: { listRow: null, card: null, detail: null },
      // A package's own registration with NO `isArtifact`.
      dispositions: { projection: "artifact-safe" },
    } as never,
    packageName,
  );
}

/** A store record dir holding a real LinkedIn-pack `package.json` at `version`. */
function writeLinkedinRecord(dir: string, version: string, artifact: unknown): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: EXT_LINKEDIN, version, cinatra: { kind: "artifact", artifact } }),
  );
  return dir;
}

const linkedinWinnerAt = (version: string) => () => [
  claim({ id: `t3-li-${version}`, type: T_POST_DRAFT, ext: EXT_LINKEDIN, status: "active", version }),
];

describe("cinatra#3319 — readClaimBackedMeaningTypesForOrg", () => {
  let root: string;
  let rec1: string;
  let rec2: string;
  let recZero: string;
  let recLatest: string;
  const recordsIn = (dirs: string[]) =>
    dirs.map((storeDir) => ({ packageName: EXT_LINKEDIN, storeDir }));

  beforeAll(() => {
    registerHostShaped(T_POST_DRAFT, "artifact-safe");
    registerHostShaped(T3_SELF_PACK_HOST, "artifact-safe");
    registerHostShaped(T3_MATCHERS, "artifact-safe");
    for (const t of T3_MULTI) registerHostShaped(t, "artifact-safe");
    registerHostShaped(T3_NO_ACCEPTS, "artifact-safe");
    registerPackageOwned(T3_OWNED, EXT_T3_OWNER);
    // Rule 2 reads the manifest, never the mutable matcher registry.
    matcherManifestRegistry._clearForTests();

    root = mkdtempSync(join(tmpdir(), "t3319-"));
    t3Store.dataRoot = join(root, "data");
    mkdirSync(t3Store.dataRoot);
    // The bundled dir fallback: an empty dev root, so only store records answer.
    t3Store.devRoot = join(root, "dev");
    mkdirSync(t3Store.devRoot);
    const accepts = { file: { mimeTypes: POST_DRAFT_ACCEPTS } };
    rec1 = writeLinkedinRecord(join(root, "store-1.0.0"), "1.0.0", { accepts });
    rec2 = writeLinkedinRecord(join(root, "store-2.0.0"), "2.0.0", {
      accepts: { file: { mimeTypes: ["text/markdown"] } },
      skills: { matchers: ["t3-post-matcher"] },
    });
    // A readable record AT each versionless string, so only rule 0 can drop it.
    recZero = writeLinkedinRecord(join(root, "store-0.0.0"), "0.0.0", { accepts });
    recLatest = writeLinkedinRecord(join(root, "store-latest"), "latest", { accepts });
  });

  afterEach(() => {
    t3Store.records = [];
    t3Store.discoverCalls = 0;
  });

  afterAll(() => {
    t3Store.dataRoot = null;
    t3Store.devRoot = null;
    rmSync(root, { recursive: true, force: true });
  });

  it("3319 T3 (i) keeps only the linkedin-like pack, reading a manifest only past rules 0, 1, 3 and 4", async () => {
    expect(matcherManifestRegistry.list()).toEqual([]);
    const claims = [
      claim({ id: "t3-li", type: T_POST_DRAFT, ext: EXT_LINKEDIN, status: "active" }),
      claim({ id: "t3-self", type: T3_SELF_PACK_HOST, ext: EXT_SELF, status: "active" }),
      claim({ id: "t3-matchers", type: T3_MATCHERS, ext: EXT_T3_MATCHERS, status: "active" }),
      ...T3_MULTI.map((type, i) =>
        claim({ id: `t3-multi-${i}`, type, ext: EXT_T3_MULTI, status: "active" }),
      ),
      claim({ id: "t3-noaccepts", type: T3_NO_ACCEPTS, ext: EXT_T3_NO_ACCEPTS, status: "active" }),
      claim({ id: "t3-owned", type: T3_OWNED, ext: EXT_T3_OWNED_CLAIMANT, status: "active" }),
    ];
    const reads: string[] = [];
    const got = await helperMod.readClaimBackedMeaningTypesForOrg(ORG, {
      readClaimsForOrg: () => claims,
      readManifestFields: async (extension, extensionVersion) => {
        reads.push(`${extension}@${extensionVersion}`);
        // Every manifest passes rules 2 and 5 but the one pack that breaks each.
        return {
          accepts: extension === EXT_T3_NO_ACCEPTS ? [] : POST_DRAFT_ACCEPTS,
          objectTypeIds: [],
          matchers: extension === EXT_T3_MATCHERS ? ["t3-matcher"] : [],
        };
      },
    });
    expect(got).toEqual([POST_DRAFT_ENTRY]);
    // EXT_SELF (rule 1), EXT_T3_MULTI (rule 3) and EXT_T3_OWNED_CLAIMANT (rule 4)
    // are dropped before any manifest read; each read names the winner's version.
    expect(reads.sort()).toEqual(
      [`${EXT_LINKEDIN}@1.0.0`, `${EXT_T3_MATCHERS}@1.0.0`, `${EXT_T3_NO_ACCEPTS}@1.0.0`].sort(),
    );
    expect(t3Store.discoverCalls).toBe(0);
  });

  it("3319 T3 (ii) the default adapter keeps the pack whose winner is at 1.0.0 while 2.0.0 declares matchers, in either record order", async () => {
    for (const dirs of [[rec1, rec2], [rec2, rec1]]) {
      t3Store.records = recordsIn(dirs);
      const got = await helperMod.readClaimBackedMeaningTypesForOrg(ORG, {
        readClaimsForOrg: linkedinWinnerAt("1.0.0"),
      });
      expect(got).toEqual([POST_DRAFT_ENTRY]);
    }
    expect(t3Store.discoverCalls).toBe(2);
  });

  it("3319 T3 (ii) the default adapter drops the pack whose winner is at 2.0.0 (matchers) though 1.0.0 has none, in either record order", async () => {
    for (const dirs of [[rec1, rec2], [rec2, rec1]]) {
      t3Store.records = recordsIn(dirs);
      const got = await helperMod.readClaimBackedMeaningTypesForOrg(ORG, {
        readClaimsForOrg: linkedinWinnerAt("2.0.0"),
      });
      expect(got).toEqual([]);
    }
    expect(t3Store.discoverCalls).toBe(2);
  });

  it("3319 T3 (ii) the default adapter drops the pack whose winner is at 3.0.0, a version no record holds", async () => {
    for (const dirs of [[rec1, rec2], [rec2, rec1]]) {
      t3Store.records = recordsIn(dirs);
      const got = await helperMod.readClaimBackedMeaningTypesForOrg(ORG, {
        readClaimsForOrg: linkedinWinnerAt("3.0.0"),
      });
      expect(got).toEqual([]);
    }
    expect(t3Store.discoverCalls).toBe(2);
  });

  it("3319 T3 (iii) a versionless winner ('0.0.0', 'latest') gets no entry and no manifest read", async () => {
    for (const [version, dir] of [
      ["0.0.0", recZero],
      ["latest", recLatest],
    ] as const) {
      t3Store.records = recordsIn([dir]);
      let reads = 0;
      const injected = await helperMod.readClaimBackedMeaningTypesForOrg(ORG, {
        readClaimsForOrg: linkedinWinnerAt(version),
        readManifestFields: async () => {
          reads += 1;
          return { accepts: POST_DRAFT_ACCEPTS, objectTypeIds: [], matchers: [] };
        },
      });
      expect(injected).toEqual([]);
      expect(reads).toBe(0);
      const adapted = await helperMod.readClaimBackedMeaningTypesForOrg(ORG, {
        readClaimsForOrg: linkedinWinnerAt(version),
      });
      expect(adapted).toEqual([]);
    }
    expect(t3Store.discoverCalls).toBe(0);
  });

  it("3319 T3 (iv) readInstalledPackAcceptedMimeTypes still answers the first readable record, as on main", async () => {
    t3Store.records = recordsIn([rec1, rec2]);
    expect(await helperMod.readInstalledPackAcceptedMimeTypes(EXT_LINKEDIN)).toEqual(
      POST_DRAFT_ACCEPTS,
    );
    t3Store.records = recordsIn([rec2, rec1]);
    expect(await helperMod.readInstalledPackAcceptedMimeTypes(EXT_LINKEDIN)).toEqual([
      "text/markdown",
    ]);
  });
});
