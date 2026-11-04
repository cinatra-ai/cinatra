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
  /** The install row the claim is bound to (cinatra#3319); absent = unbound. */
  installId?: string | null;
}): ArbitrableClaim & { installId?: string | null } {
  return {
    ...(input.installId !== undefined ? { installId: input.installId } : {}),
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
  records: Array<{ packageName: string; storeDir: string; declaredDigest?: string }>;
  discoverCalls: number;
  /** The store discovery throws (cinatra#3319 T15). */
  discoverThrows: boolean;
  /** The canonical install rows by id (cinatra#3319 T15). */
  rows: Record<string, unknown>;
  /** The install-row read throws (cinatra#3319 T26 (g)). */
  rowsThrow: boolean;
} = {
  dataRoot: null,
  devRoot: null,
  records: [],
  discoverCalls: 0,
  discoverThrows: false,
  rows: {},
  rowsThrow: false,
};
vi.mock("@/lib/extension-data-root", () => ({
  resolveExtensionDataRoot: () => {
    if (t3Store.dataRoot === null) throw new Error("no extension data root in this suite");
    return t3Store.dataRoot;
  },
}));
vi.mock("@/lib/extension-store-io", () => ({
  discoverStoreRecordsV2: async () => {
    t3Store.discoverCalls += 1;
    if (t3Store.discoverThrows) throw new Error("store unreadable in this case");
    return t3Store.records;
  },
}));
// The claim's install row, read by its id (cinatra#3319 T15).
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionById: async (id: string) => {
    if (t3Store.rowsThrow) throw new Error("install row read failed in this case");
    return t3Store.rows[id] ?? null;
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
/** The LinkedIn pack's install row the T3/T15 claims are bound to. */
const LI_INSTALL = "inst-linkedin";
/** POST_DRAFT_ENTRY with the winning claim's identity (cinatra#3319 T15). */
const POST_DRAFT_ENTRY_AT_1 = {
  ...POST_DRAFT_ENTRY,
  extensionVersion: "1.0.0",
  installId: LI_INSTALL,
  scope: `org:${ORG}`,
};
/** A live artifact install row of the LinkedIn pack; `activeDigest` null = none recorded. */
function linkedinRow(activeDigest: string | null, over: Record<string, unknown> = {}) {
  return {
    id: LI_INSTALL,
    packageName: EXT_LINKEDIN,
    kind: "artifact",
    status: "active",
    source: activeDigest === null ? { type: "bundled" } : { type: "verdaccio", activeDigest },
    ...over,
  };
}

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

const linkedinWinnerAt = (version: string, installId: string | null = LI_INSTALL) => () => [
  claim({
    id: `t3-li-${version}`,
    type: T_POST_DRAFT,
    ext: EXT_LINKEDIN,
    status: "active",
    version,
    installId,
  }),
];

describe("cinatra#3319 — readClaimBackedMeaningTypesForOrg", () => {
  let root: string;
  let rec1: string;
  let rec2: string;
  let recZero: string;
  let recLatest: string;
  /** cinatra#3319 T15: a second 1.0.0 record that declares matchers, an
   *  unreadable 1.0.0 record and a record dir with no manifest. */
  let recA1: string;
  let recBad: string;
  let recGone: string;
  /** cinatra#3319 T26: a valid record at 1.0.1 (no matchers). */
  let recV101: string;
  /** Store records of the LinkedIn pack; each record's digest is its dir's name. */
  const recordsIn = (dirs: string[]) =>
    dirs.map((storeDir) => ({
      packageName: EXT_LINKEDIN,
      storeDir,
      declaredDigest: storeDir.split("/").pop(),
    }));
  const digestOf = (dir: string) => dir.split("/").pop() as string;

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
    recA1 = writeLinkedinRecord(join(root, "store-a-1.0.0"), "1.0.0", {
      accepts,
      skills: { matchers: ["t3-a-matcher"] },
    });
    recBad = join(root, "store-bad-1.0.0");
    mkdirSync(recBad, { recursive: true });
    writeFileSync(join(recBad, "package.json"), "{ not json");
    recGone = join(root, "store-gone-1.0.0");
    mkdirSync(recGone, { recursive: true });
    recV101 = writeLinkedinRecord(join(root, "store-1.0.1"), "1.0.1", { accepts });
  });

  afterEach(() => {
    t3Store.records = [];
    t3Store.discoverCalls = 0;
    t3Store.discoverThrows = false;
    t3Store.rows = {};
    t3Store.rowsThrow = false;
  });

  afterAll(() => {
    t3Store.dataRoot = null;
    t3Store.devRoot = null;
    rmSync(root, { recursive: true, force: true });
  });

  it("3319 T3 (i) keeps only the linkedin-like pack, reading a manifest only past rules 0, 1, 3 and 4", async () => {
    expect(matcherManifestRegistry.list()).toEqual([]);
    const bound = { installId: "inst-t3" };
    const claims = [
      claim({ id: "t3-li", type: T_POST_DRAFT, ext: EXT_LINKEDIN, status: "active", ...bound }),
      claim({ id: "t3-self", type: T3_SELF_PACK_HOST, ext: EXT_SELF, status: "active", ...bound }),
      claim({ id: "t3-matchers", type: T3_MATCHERS, ext: EXT_T3_MATCHERS, status: "active", ...bound }),
      ...T3_MULTI.map((type, i) =>
        claim({ id: `t3-multi-${i}`, type, ext: EXT_T3_MULTI, status: "active", ...bound }),
      ),
      claim({ id: "t3-noaccepts", type: T3_NO_ACCEPTS, ext: EXT_T3_NO_ACCEPTS, status: "active", ...bound }),
      claim({ id: "t3-owned", type: T3_OWNED, ext: EXT_T3_OWNED_CLAIMANT, status: "active", ...bound }),
    ];
    const reads: string[] = [];
    const got = await helperMod.readClaimBackedMeaningTypesForOrg(ORG, {
      readClaimsForOrg: () => claims,
      // The reader takes the winner as one object (cinatra#3319 T15); before
      // that it took the extension and the version, so both shapes are read.
      readManifestFields: (async (
        winner: string | { extension: string; extensionVersion: string },
        version?: string,
      ) => {
        const { extension, extensionVersion } =
          typeof winner === "string" ? { extension: winner, extensionVersion: version } : winner;
        reads.push(`${extension}@${extensionVersion}`);
        // Every manifest passes rules 2 and 5 but the one pack that breaks each.
        return {
          accepts: extension === EXT_T3_NO_ACCEPTS ? [] : POST_DRAFT_ACCEPTS,
          objectTypeIds: [],
          matchers: extension === EXT_T3_MATCHERS ? ["t3-matcher"] : [],
        };
      }) as never,
    });
    expect(got).toEqual([expect.objectContaining(POST_DRAFT_ENTRY)]);
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
      // The claim's install row pins the 1.0.0 record's digest.
      t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1)) };
      const got = await helperMod.readClaimBackedMeaningTypesForOrg(ORG, {
        readClaimsForOrg: linkedinWinnerAt("1.0.0"),
      });
      expect(got).toEqual([expect.objectContaining(POST_DRAFT_ENTRY)]);
    }
    expect(t3Store.discoverCalls).toBe(2);
  });

  it("3319 T3 (ii) the default adapter drops the pack whose winner is at 2.0.0 (matchers) though 1.0.0 has none, in either record order", async () => {
    for (const dirs of [[rec1, rec2], [rec2, rec1]]) {
      t3Store.records = recordsIn(dirs);
      // The claim's install row pins the 2.0.0 record's digest.
      t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec2)) };
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
      t3Store.rows = { [LI_INSTALL]: linkedinRow("store-3.0.0") };
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

  const readLinkedin = (version: string, installId?: string | null) =>
    helperMod.readClaimBackedMeaningTypesForOrg(ORG, {
      readClaimsForOrg: linkedinWinnerAt(version, installId),
    });

  it("3319 T15 (a) two records of the winner's exact version: only the record at the install's digest answers, in either record order", async () => {
    for (const dirs of [[recA1, rec1], [rec1, recA1]]) {
      t3Store.records = recordsIn(dirs);
      // The install pins the record that declares matchers: no entry.
      t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(recA1)) };
      expect(await readLinkedin("1.0.0")).toEqual([]);
      // The install pins the record that declares none: the entry, naming its winner.
      t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1)) };
      expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
    }
  });

  it("3319 T15 (b) an unreadable record or a missing manifest at the install's digest answers nothing, though another record of that version is valid", async () => {
    for (const bad of [recBad, recGone]) {
      for (const dirs of [[bad, rec1], [rec1, bad]]) {
        t3Store.records = recordsIn(dirs);
        t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(bad)) };
        expect(await readLinkedin("1.0.0")).toEqual([]);
      }
    }
  });

  it("3319 T15 (c) the development tree answers only an install with no recorded digest, and only when the store read succeeded and holds no record of the pack", async () => {
    const devDir = join(t3Store.devRoot as string, "cinatra-ai", "linkedin-artifacts");
    mkdirSync(devDir, { recursive: true });
    writeFileSync(
      join(devDir, "package.json"),
      JSON.stringify({
        name: EXT_LINKEDIN,
        version: "1.0.0",
        cinatra: { kind: "artifact", artifact: { accepts: { file: { mimeTypes: POST_DRAFT_ACCEPTS } } } },
      }),
    );
    try {
      // No recorded digest, the store read fails: nothing, not the dev tree.
      t3Store.rows = { [LI_INSTALL]: linkedinRow(null) };
      t3Store.discoverThrows = true;
      expect(await readLinkedin("1.0.0")).toEqual([]);
      // A recorded digest and a failed store read: nothing either.
      t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1)) };
      expect(await readLinkedin("1.0.0")).toEqual([]);
      t3Store.discoverThrows = false;
      // No recorded digest while the store holds a record of the pack: nothing.
      t3Store.rows = { [LI_INSTALL]: linkedinRow(null) };
      t3Store.records = recordsIn([rec1]);
      expect(await readLinkedin("1.0.0")).toEqual([]);
      // No recorded digest and a store that holds nothing of the pack: the dev tree.
      t3Store.records = [];
      expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
    } finally {
      rmSync(join(t3Store.devRoot as string, "cinatra-ai"), { recursive: true, force: true });
    }
  });

  it("3319 T15 (d) an unbound claim, or one whose install row is not a live artifact row of the pack, gets no entry", async () => {
    t3Store.records = recordsIn([rec1]);
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1)) };
    expect(await readLinkedin("1.0.0", null)).toEqual([]);
    for (const rows of [
      {},
      { [LI_INSTALL]: linkedinRow(digestOf(rec1), { status: "archived" }) },
      { [LI_INSTALL]: linkedinRow(digestOf(rec1), { packageName: "@cinatra-ai/other-artifacts" }) },
      { [LI_INSTALL]: linkedinRow(digestOf(rec1), { kind: "connector" }) },
    ]) {
      t3Store.rows = rows;
      expect(await readLinkedin("1.0.0")).toEqual([]);
    }
    // The same record through the live row answers.
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1)) };
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
  });

  it("3319 T24: readArtifactSafeClaimWinnerPackagesForOrg names each package that wins an artifact-safe claim once, from the same arbitration, and a failed claim read throws", () => {
    const claims = [
      claim({ id: "t24-li", type: T_POST_DRAFT, ext: EXT_LINKEDIN, status: "active" }),
      ...T3_MULTI.map((type, i) =>
        claim({ id: `t24-multi-${i}`, type, ext: EXT_T3_MULTI, status: "active" }),
      ),
      // No winner: a dormant claim, a `none` projection and an unregistered type.
      claim({ id: "t24-dormant", type: T3_NO_ACCEPTS, ext: EXT_T3_NO_ACCEPTS, status: "dormant" }),
      claim({ id: "t24-none", type: T3_MATCHERS, ext: EXT_T3_MATCHERS, status: "active", projection: "none" }),
      claim({ id: "t24-nowhere", type: T_UNREGISTERED, ext: EXT_NOWHERE, status: "active" }),
    ];
    expect(helperMod.readArtifactSafeClaimWinnerPackagesForOrg(ORG, () => claims)).toEqual(
      [EXT_LINKEDIN, EXT_T3_MULTI].sort(),
    );
    expect(() =>
      helperMod.readArtifactSafeClaimWinnerPackagesForOrg(ORG, () => {
        throw new Error("claim store unavailable");
      }),
    ).toThrow("claim store unavailable");
  });

  it("3319 T25 (reader): a pack that registers a type without isArtifact and wins a claim over a host type stays claim-backed (rule 1 reads isArtifact only)", async () => {
    const t25Host = "@cinatra-ai/t25host:note";
    registerHostShaped(t25Host, "artifact-safe");
    const got = await helperMod.readClaimBackedMeaningTypesForOrg(ORG, {
      readClaimsForOrg: () => [
        claim({ id: "t25-owner", type: t25Host, ext: EXT_T3_OWNER, status: "active", installId: "inst-t25" }),
      ],
      readManifestFields: async () => ({
        accepts: POST_DRAFT_ACCEPTS,
        objectTypeIds: [],
        matchers: [],
      }),
    });
    // EXT_T3_OWNER registered T3_OWNED, a type with no `isArtifact`.
    expect(objectTypeRegistry.getTypesForPackage(EXT_T3_OWNER)).toEqual([T3_OWNED]);
    expect(got).toEqual([
      {
        objectTypeId: t25Host,
        extension: EXT_T3_OWNER,
        acceptMimes: POST_DRAFT_ACCEPTS,
        extensionVersion: "1.0.0",
        installId: "inst-t25",
        scope: `org:${ORG}`,
      },
    ]);
  });

  /** A development-tree manifest of the LinkedIn pack at `version` under `rel`. */
  const writeDevManifest = (rel: string[], version: string) => {
    const dir = join(t3Store.devRoot as string, ...rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: EXT_LINKEDIN,
        version,
        cinatra: { kind: "artifact", artifact: { accepts: { file: { mimeTypes: POST_DRAFT_ACCEPTS } } } },
      }),
    );
  };
  const clearDevTree = () => {
    rmSync(join(t3Store.devRoot as string, "cinatra-ai"), { recursive: true, force: true });
    rmSync(join(t3Store.devRoot as string, "linkedin-artifacts"), { recursive: true, force: true });
  };

  it("3319 T26 (a) a locked install row answers like an active one", async () => {
    t3Store.records = recordsIn([rec1]);
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1), { status: "locked" }) };
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
  });

  it("3319 T26 (b) two store records at the install's digest answer nothing; one record there answers", async () => {
    const atDup = { packageName: EXT_LINKEDIN, storeDir: rec1, declaredDigest: "dup-digest" };
    t3Store.rows = { [LI_INSTALL]: linkedinRow("dup-digest") };
    t3Store.records = [atDup, { ...atDup }];
    expect(await readLinkedin("1.0.0")).toEqual([]);
    t3Store.records = [atDup];
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
  });

  it("3319 T26 (c) a manifest whose version is not the claim's answers nothing, at the install's digest and in the development tree", async () => {
    const at101 = { ...POST_DRAFT_ENTRY_AT_1, extensionVersion: "1.0.1" };
    t3Store.records = recordsIn([recV101]);
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(recV101)) };
    expect(await readLinkedin("1.0.0")).toEqual([]);
    expect(await readLinkedin("1.0.1")).toEqual([at101]);
    writeDevManifest(["cinatra-ai", "linkedin-artifacts"], "1.0.1");
    try {
      t3Store.records = [];
      t3Store.rows = { [LI_INSTALL]: linkedinRow(null) };
      expect(await readLinkedin("1.0.0")).toEqual([]);
      expect(await readLinkedin("1.0.1")).toEqual([at101]);
    } finally {
      clearDevTree();
    }
  });

  it("3319 T26 (d) two readable development manifests answer nothing, and so do none; exactly one answers", async () => {
    t3Store.records = [];
    t3Store.rows = { [LI_INSTALL]: linkedinRow(null) };
    try {
      expect(await readLinkedin("1.0.0")).toEqual([]);
      writeDevManifest(["cinatra-ai", "linkedin-artifacts"], "1.0.0");
      writeDevManifest(["linkedin-artifacts"], "1.0.0");
      expect(await readLinkedin("1.0.0")).toEqual([]);
      rmSync(join(t3Store.devRoot as string, "linkedin-artifacts"), { recursive: true, force: true });
      expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
    } finally {
      clearDevTree();
    }
  });

  it("3319 T26 (e) an unavailable development root answers nothing", async () => {
    const devRoot = t3Store.devRoot;
    t3Store.records = [];
    t3Store.rows = { [LI_INSTALL]: linkedinRow(null) };
    t3Store.devRoot = null;
    try {
      expect(await readLinkedin("1.0.0")).toEqual([]);
    } finally {
      t3Store.devRoot = devRoot;
    }
  });

  it("3319 T26 (f) an empty or non-string activeDigest is read as no recorded digest", async () => {
    writeDevManifest(["cinatra-ai", "linkedin-artifacts"], "1.0.0");
    try {
      for (const activeDigest of ["", 42]) {
        t3Store.rows = {
          [LI_INSTALL]: linkedinRow(null, { source: { type: "verdaccio", activeDigest } }),
        };
        // The store holds a record of the pack: no digest, so nothing.
        t3Store.records = recordsIn([rec1]);
        expect(await readLinkedin("1.0.0")).toEqual([]);
        // The store holds none: the development tree answers.
        t3Store.records = [];
        expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
      }
    } finally {
      clearDevTree();
    }
  });

  it("3319 T26 (g) a failed install-row read makes the reader throw", async () => {
    t3Store.records = recordsIn([rec1]);
    t3Store.rowsThrow = true;
    await expect(readLinkedin("1.0.0")).rejects.toThrow("install row read failed in this case");
  });
});
