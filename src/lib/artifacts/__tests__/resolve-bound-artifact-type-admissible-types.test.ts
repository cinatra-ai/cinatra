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
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  artifactPackSurfaceRegistry,
  matcherManifestRegistry,
  objectTypeRegistry,
} from "@cinatra-ai/objects/registry";
import {
  registerArtifactExtensionDir,
  registerArtifactExtensions,
} from "@cinatra-ai/objects/register-artifact-extensions";
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
  /** The records a discovery mock answers; null = the real discovery over the
   *  data root, as production lists the store (cinatra#3319 T31). */
  records: Array<{ packageName: string; storeDir: string; declaredDigest?: string }> | null;
  discoverCalls: number;
  /** The store discovery throws (cinatra#3319 T15). */
  discoverThrows: boolean;
  /** The canonical install rows by id (cinatra#3319 T15). */
  rows: Record<string, unknown>;
  /** The install-row read throws (cinatra#3319 T26 (g)). */
  rowsThrow: boolean;
  /** The finalized install-op journal the runtime's trust gate reads
   *  (cinatra#3319 T30); undefined = a finalized op at the digest the claim's
   *  install row records, as a completed install leaves it. */
  op: { phase: string; installOpId: string; digest: string | null } | null | undefined;
  /** Each journal read, as `<package>|<org>|<version namespace>`. */
  opCalls: string[];
  /** The journal read throws (cinatra#3319 T30 (g)). */
  opThrows: boolean;
  /** Journal ops by version namespace (cinatra#3319 T41): when set, a read
   *  answers the op of exactly that namespace, or none. */
  opsByNs: Record<string, { phase: string; installOpId: string; digest: string | null }> | null;
} = {
  dataRoot: null,
  devRoot: null,
  records: null,
  discoverCalls: 0,
  discoverThrows: false,
  rows: {},
  rowsThrow: false,
  op: undefined,
  opCalls: [],
  opThrows: false,
  opsByNs: null,
};
// cinatra#3319 MF2: the runtime-discovery dispatcher the reader reads the
// pack surfaces through. A faithful stand-in of the host entry point: the
// lifecycle-live artifact rows of `t3Store.rows` are its manifests, and its
// artifact facet is the real facet's rule (the bridge's surfaces of the live,
// scope-visible packages). The real facet is pinned by the extensions package's
// own facet test; this suite pins what the reader does with the answer.
const discoverState = vi.hoisted(() => ({
  calls: [] as Array<{ kind?: string; scope: unknown }>,
  throws: false,
  facetThrows: false,
  unmigrated: false,
  registered: [] as string[],
}));
// cinatra#3319 T31: failures the store's file system answers, by path (an
// errno code such as EACCES), and every manifest read, so a case can say which
// store record was read. Both the reader and the real discovery read through it.
const fsFaults = vi.hoisted(() => ({
  codes: new Map<string, string>(),
  reads: [] as string[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  type AnyFn = (...args: unknown[]) => Promise<unknown>;
  const fault = (p: unknown) => {
    const code = fsFaults.codes.get(String(p));
    if (code) throw Object.assign(new Error(`${code}: injected for ${String(p)}`), { code });
  };
  const wrapped = {
    ...actual,
    stat: async (...args: unknown[]) => {
      fault(args[0]);
      return (actual.stat as unknown as AnyFn)(...args);
    },
    readdir: async (...args: unknown[]) => {
      fault(args[0]);
      return (actual.readdir as unknown as AnyFn)(...args);
    },
    readFile: async (...args: unknown[]) => {
      fsFaults.reads.push(String(args[0]));
      fault(args[0]);
      return (actual.readFile as unknown as AnyFn)(...args);
    },
  };
  return { ...wrapped, default: wrapped };
});
vi.mock("@/lib/extension-data-root", () => ({
  resolveExtensionDataRoot: () => {
    if (t3Store.dataRoot === null) throw new Error("no extension data root in this suite");
    return t3Store.dataRoot;
  },
}));
vi.mock("@/lib/extension-store-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/extension-store-io")>();
  return {
    ...actual,
    discoverStoreRecordsV2: async (dataRoot: string) => {
      t3Store.discoverCalls += 1;
      if (t3Store.discoverThrows) throw new Error("store unreadable in this case");
      return t3Store.records ?? actual.discoverStoreRecordsV2(dataRoot);
    },
  };
});
// The install-op journal the runtime's trust gate reads (cinatra#3319 T30).
vi.mock("@/lib/extension-install-ops", () => ({
  readInstallOpForVersion: async (packageName: string, orgId: string | null, version: string) => {
    t3Store.opCalls.push(`${packageName}|${orgId}|${version}`);
    if (t3Store.opThrows) throw new Error("journal unreadable in this case");
    if (t3Store.opsByNs !== null) return t3Store.opsByNs[version] ?? null;
    if (t3Store.op !== undefined) return t3Store.op;
    const row = Object.values(t3Store.rows).find(
      (r) => (r as { packageName?: unknown }).packageName === packageName,
    ) as { source?: { activeDigest?: unknown } | null } | undefined;
    const digest = row?.source?.activeDigest;
    return {
      phase: "finalized",
      installOpId: "op-t3",
      digest: typeof digest === "string" ? digest : null,
    };
  },
}));
// The claim's install row, read by its id (cinatra#3319 T15), and the rows of
// one package, which the runtime's multi-version trust gate reads (T41).
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionById: async (id: string) => {
    if (t3Store.rowsThrow) throw new Error("install row read failed in this case");
    return t3Store.rows[id] ?? null;
  },
  readInstalledExtensionsByPackageName: async (packageName: string) =>
    Object.values(t3Store.rows).filter(
      (r) => (r as { packageName?: unknown }).packageName === packageName,
    ),
}));
// The reader never reads a port grant (cinatra#3319 T41): the grant decides
// approved ports, never whether a row anchors.
vi.mock("@/lib/extension-host-port-grants", () => ({
  readGrant: async () => {
    throw new Error("the reader read a port grant");
  },
}));
vi.mock("@cinatra-ai/extensions/runtime-discovery-host", async () => {
  const { artifactPackSurfaceRegistry } = await import("@cinatra-ai/objects/registry");
  const { visibleManifestPackageNames } = await import("@cinatra-ai/extension-types");
  return {
    discoverActiveExtensionCapabilities: async (input: {
      kind?: string;
      scope: Parameters<typeof visibleManifestPackageNames>[1];
      onError?: (kind: string, error: unknown) => void;
    }) => {
      discoverState.calls.push({ kind: input.kind, scope: input.scope });
      if (discoverState.throws) throw new Error("dispatcher unreadable in this case");
      if (discoverState.unmigrated) return { byKind: {}, all: [], unmigratedKinds: ["artifact"] };
      if (discoverState.facetThrows) {
        input.onError?.("artifact", new Error("artifact facet failed in this case"));
        return { byKind: { artifact: [] }, all: [], unmigratedKinds: [] };
      }
      const manifests = Object.values(t3Store.rows)
        .map((r) => r as Record<string, unknown>)
        .filter((r) => r.kind === "artifact" && (r.status === "active" || r.status === "locked"))
        .map((r) => ({
          id: String(r.id),
          packageName: String(r.packageName),
          kind: "artifact",
          ownerLevel: (r.ownerLevel as string | undefined) ?? "platform",
          ownerId: (r.ownerId as string | null | undefined) ?? null,
          organizationId: (r.organizationId as string | null | undefined) ?? null,
          status: String(r.status),
        }));
      const live = visibleManifestPackageNames(manifests, input.scope);
      const packs = artifactPackSurfaceRegistry
        .list()
        .filter((surface) => live.has(surface.packageName))
        .map((surface) => ({ packageName: surface.packageName, artifactPack: surface }));
      return { byKind: { artifact: packs }, all: packs, unmigratedKinds: [] };
    },
  };
});
vi.mock("@cinatra-ai/extensions", () => ({
  extensionRegistry: {
    registerIfAbsent: (handler: { typeId: string }) => {
      discoverState.registered.push(handler.typeId);
    },
  },
}));
vi.mock("@cinatra-ai/extensions/artifact-handler", () => ({
  createArtifactExtensionHandler: () => ({ typeId: "artifact" }),
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
/** The source fields of a registry install that went through the real pipeline,
 *  which the runtime's trust gate requires (cinatra#3319 T30). */
const PIPELINE = { integrity: "sha512-t3", contentHash: "t3-content-hash" };
/** A live artifact install row of the LinkedIn pack: a registry install at
 *  `activeDigest`, or, for null, a bundled install (no store digest). */
function linkedinRow(activeDigest: string | null, over: Record<string, unknown> = {}) {
  return {
    id: LI_INSTALL,
    packageName: EXT_LINKEDIN,
    kind: "artifact",
    status: "active",
    source:
      activeDigest === null
        ? { type: "bundled" }
        : { type: "verdaccio", activeDigest, ...PIPELINE },
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
  /** cinatra#3319 T27: a 1.0.0 record that is no artifact manifest, and an
   *  artifact record whose `version` is a number. */
  let recWrongKind: string;
  let recNumVersion: string;
  /** Store records of the LinkedIn pack; each record's digest is its dir's name. */
  const recordsIn = (dirs: string[]) =>
    dirs.map((storeDir) => ({
      packageName: EXT_LINKEDIN,
      storeDir,
      declaredDigest: digestOf(storeDir),
    }));
  /** A fixture record's store digest: a hex sha256 of its folder's name, so it
   *  is a well-formed `<digest>` path segment (cinatra#3319 T30). */
  const digestOf = (dir: string) =>
    createHash("sha256")
      .update(dir.split("/").pop() as string)
      .digest("hex");
  /** The LinkedIn pack's folder in the kind-segregated store layout. */
  const liSlugDir = () =>
    join(t3Store.dataRoot as string, "artifact", "@cinatra-ai", "linkedin-artifacts");
  /** Place fixture records in the store at `<root>/artifact/<slug>/<digest>/`,
   *  where the real discovery finds them. */
  const stock = (dirs: string[]) => {
    for (const dir of dirs) cpSync(dir, join(liSlugDir(), digestOf(dir)), { recursive: true });
    t3Store.records = null;
  };
  // cinatra#3319 MF2: THE READER READS WHAT THE RUNTIME REGISTERED. The
  // object-registry bridge is the runtime's registration of an artifact pack:
  // the store rescan registers an anchor-vetted store record with its digest,
  // the bundled scan registers the development tree. These two helpers make the
  // same calls the runtime makes, through the real bridge, so the pack's
  // surface reaches the dispatcher the way production puts it there.
  /** The runtime registers the pack from its store record at `dir`'s digest
   *  (`registerArtifactExtensionDir`, as the store rescan calls it). */
  const runtimeRegistersStore = (dir: string) =>
    registerArtifactExtensionDir(join(liSlugDir(), digestOf(dir)), {
      source: "store",
      digest: digestOf(dir),
    });
  /** The runtime's bundled scan over the development root
   *  (`registerArtifactExtensions`, as the registry warm calls it). */
  const runtimeRegistersDevTree = () => registerArtifactExtensions(t3Store.devRoot as string);

  beforeAll(() => {
    registerHostShaped(T_POST_DRAFT, "artifact-safe");
    registerHostShaped(T3_SELF_PACK_HOST, "artifact-safe");
    registerHostShaped(T3_MATCHERS, "artifact-safe");
    for (const t of T3_MULTI) registerHostShaped(t, "artifact-safe");
    registerHostShaped(T3_NO_ACCEPTS, "artifact-safe");
    registerPackageOwned(T3_OWNED, EXT_T3_OWNER);
    // Rule 2 reads the pack's surface, never the mutable matcher registry.
    matcherManifestRegistry._clearForTests();

    root = mkdtempSync(join(tmpdir(), "t3319-"));
    t3Store.dataRoot = join(root, "data");
    mkdirSync(t3Store.dataRoot);
    // The development root: empty, so only what a case writes is there.
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
    recWrongKind = join(root, "store-connector-1.0.0");
    mkdirSync(recWrongKind, { recursive: true });
    writeFileSync(
      join(recWrongKind, "package.json"),
      JSON.stringify({ name: EXT_LINKEDIN, version: "1.0.0", cinatra: { kind: "connector" } }),
    );
    recNumVersion = join(root, "store-numeric-version");
    mkdirSync(recNumVersion, { recursive: true });
    writeFileSync(
      join(recNumVersion, "package.json"),
      JSON.stringify({
        name: EXT_LINKEDIN,
        version: 1,
        cinatra: { kind: "artifact", artifact: { accepts } },
      }),
    );
  });

  afterEach(() => {
    t3Store.records = null;
    t3Store.discoverCalls = 0;
    t3Store.discoverThrows = false;
    t3Store.rows = {};
    t3Store.rowsThrow = false;
    t3Store.op = undefined;
    t3Store.opCalls = [];
    t3Store.opThrows = false;
    t3Store.opsByNs = null;
    discoverState.calls = [];
    discoverState.throws = false;
    discoverState.facetThrows = false;
    discoverState.unmigrated = false;
    discoverState.registered = [];
    fsFaults.codes.clear();
    fsFaults.reads.length = 0;
    // What the runtime registered in this case is gone with it.
    artifactPackSurfaceRegistry?._clearForTests();
    matcherManifestRegistry._clearForTests();
    rmSync(join(t3Store.dataRoot as string, "artifact"), { recursive: true, force: true });
    rmSync(join(t3Store.devRoot as string, "cinatra-ai"), { recursive: true, force: true });
    rmSync(join(t3Store.devRoot as string, "linkedin-artifacts"), { recursive: true, force: true });
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
    // An injected per-winner read is the whole read: the dispatcher is not asked.
    expect(discoverState.calls).toEqual([]);
  });

  // The store records sit in the store's own layout (cinatra#3319 T31), one
  // folder per digest, so there is no record order to vary.
  it("3319 T3 (ii) the default adapter keeps the pack whose winner is at 1.0.0 while 2.0.0 declares matchers", async () => {
    stock([rec1, rec2]);
    // The claim's install row pins the 1.0.0 record's digest, and the runtime
    // registered the pack from that record.
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1)) };
    runtimeRegistersStore(rec1);
    const got = await helperMod.readClaimBackedMeaningTypesForOrg(ORG, {
      readClaimsForOrg: linkedinWinnerAt("1.0.0"),
    });
    expect(got).toEqual([expect.objectContaining(POST_DRAFT_ENTRY)]);
  });

  it("3319 T3 (ii) the default adapter drops the pack whose winner is at 2.0.0 (matchers) though 1.0.0 has none", async () => {
    stock([rec1, rec2]);
    // The claim's install row pins the 2.0.0 record's digest.
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec2)) };
    runtimeRegistersStore(rec2);
    const got = await helperMod.readClaimBackedMeaningTypesForOrg(ORG, {
      readClaimsForOrg: linkedinWinnerAt("2.0.0"),
    });
    expect(got).toEqual([]);
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
    expect(discoverState.calls).toEqual([]);
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

  it("3319 T15 (a) two records of the winner's exact version: only the record at the install's digest answers", async () => {
    stock([recA1, rec1]);
    // The install pins the record that declares matchers: no entry.
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(recA1)) };
    runtimeRegistersStore(recA1);
    expect(await readLinkedin("1.0.0")).toEqual([]);
    // The install pins the record that declares none: the entry, naming its winner.
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1)) };
    runtimeRegistersStore(rec1);
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
  });

  /** A development-tree manifest of the LinkedIn pack at `version` under `rel`. */
  const writeDevManifest = (rel: string[], version: string, cinatraExtra: Record<string, unknown> = {}) => {
    const dir = join(t3Store.devRoot as string, ...rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: EXT_LINKEDIN,
        version,
        cinatra: {
          kind: "artifact",
          artifact: { accepts: { file: { mimeTypes: POST_DRAFT_ACCEPTS } } },
          ...cinatraExtra,
        },
      }),
    );
  };

  it("3319 T15 (c) a bundled install answers through the development tree the runtime registered the pack from", async () => {
    writeDevManifest(["cinatra-ai", "linkedin-artifacts"], "1.0.0");
    t3Store.rows = { [LI_INSTALL]: linkedinRow(null) };
    runtimeRegistersDevTree();
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
  });

  it("3319 T15 (d) an unbound claim, or one whose install row is not a live artifact row of the pack, gets no entry", async () => {
    stock([rec1]);
    runtimeRegistersStore(rec1);
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

  it("3319 T26 (a) a locked install row answers like an active one", async () => {
    stock([rec1]);
    runtimeRegistersStore(rec1);
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1), { status: "locked" }) };
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
  });

  it("3319 T26 (b) the surface the runtime registered from the store record at the install's digest answers (a digest that is no store digest makes the reader throw: T27 (c))", async () => {
    stock([rec1]);
    runtimeRegistersStore(rec1);
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1)) };
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
  });

  it("3319 T26 (c) a surface at the claim's version answers, from the install's store record and from the development tree (another version makes the reader throw: T27 (e))", async () => {
    const at101 = { ...POST_DRAFT_ENTRY_AT_1, extensionVersion: "1.0.1" };
    stock([recV101]);
    runtimeRegistersStore(recV101);
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(recV101)) };
    expect(await readLinkedin("1.0.1")).toEqual([at101]);
    writeDevManifest(["cinatra-ai", "linkedin-artifacts"], "1.0.1");
    rmSync(liSlugDir(), { recursive: true, force: true });
    runtimeRegistersDevTree();
    t3Store.rows = { [LI_INSTALL]: linkedinRow(null) };
    expect(await readLinkedin("1.0.1")).toEqual([at101]);
  });

  it("3319 T26 (d) an unscoped development folder of the pack answers like a vendor folder", async () => {
    t3Store.rows = { [LI_INSTALL]: linkedinRow(null) };
    writeDevManifest(["linkedin-artifacts"], "1.0.0");
    runtimeRegistersDevTree();
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
  });

  it("3319 T26 (f) an empty or non-string activeDigest makes the reader throw: the runtime's trust gate refuses it, so the development-tree surface never answers for it", async () => {
    writeDevManifest(["cinatra-ai", "linkedin-artifacts"], "1.0.0");
    runtimeRegistersDevTree();
    for (const activeDigest of ["", 42]) {
      t3Store.rows = {
        [LI_INSTALL]: linkedinRow(null, {
          source: { type: "verdaccio", activeDigest, ...PIPELINE },
        }),
      };
      await expect(readLinkedin("1.0.0")).rejects.toThrow(
        "the manifest of the claim's install cannot be read",
      );
    }
  });

  it("3319 T26 (g) a failed install-row read makes the reader throw", async () => {
    stock([rec1]);
    runtimeRegistersStore(rec1);
    t3Store.rowsThrow = true;
    await expect(readLinkedin("1.0.0")).rejects.toThrow("install row read failed in this case");
  });

  // cinatra#3319 T27: A SURFACE THAT IS NOT THE LIVE INSTALL'S MAKES THE READER
  // THROW. Answering nothing would make the pack "not claim-backed", and a
  // matcher entry under its name would then reach the org-wide matcher gate. A
  // throw is the failed claim-backed read the upload actions refuse such an
  // entry on (upload-typing-actions T21, T22). A surface that breaks a rule
  // (matchers, no accepts) and an install row that is not a live artifact row
  // of the pack still answer nothing (T3 (ii), T15 (a), T15 (d)).
  const UNREADABLE = "the manifest of the claim's install cannot be read";

  it("3319 T27 (c) an install digest that is no store digest makes the reader throw", async () => {
    stock([rec1]);
    runtimeRegistersStore(rec1);
    t3Store.rows = { [LI_INSTALL]: linkedinRow("dup-digest") };
    await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
  });

  it("3319 T27 (d) an install pinned to an unreadable record, a record with no manifest or a record that is no artifact manifest makes the reader throw while the runtime's surface is another record's", async () => {
    stock([rec1]);
    runtimeRegistersStore(rec1);
    for (const bad of [recBad, recGone, recWrongKind]) {
      stock([bad]);
      t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(bad)) };
      await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
      rmSync(join(liSlugDir(), digestOf(bad)), { recursive: true, force: true });
    }
  });

  it("3319 T27 (e) a surface at another version than the claim's makes the reader throw, from the install's store record and from the development tree", async () => {
    stock([recV101]);
    runtimeRegistersStore(recV101);
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(recV101)) };
    await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
    writeDevManifest(["cinatra-ai", "linkedin-artifacts"], "1.0.1");
    rmSync(liSlugDir(), { recursive: true, force: true });
    runtimeRegistersDevTree();
    t3Store.rows = { [LI_INSTALL]: linkedinRow(null) };
    await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
  });

  it("3319 T27 (f) a manifest whose version is not a string makes the reader throw", async () => {
    stock([recNumVersion]);
    runtimeRegistersStore(recNumVersion);
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(recNumVersion)) };
    await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
  });

  // cinatra#3319 T30: THE STORE INSTALL IS BOUND THROUGH THE RUNTIME'S OWN TRUST
  // GATE: the finalized install-op journal, read in the namespace the
  // multi-version anchor resolver reads, selects the digest; the row's
  // `activeDigest` alone never does. An install that gate refuses can never be
  // activated, so no surface is read as the install's.
  it("3319 T30 (a) a row digest the finalized journal does not confirm (a torn restore) makes the reader throw", async () => {
    stock([rec1, rec2]);
    runtimeRegistersStore(rec1);
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1)) };
    t3Store.op = { phase: "finalized", installOpId: "op-old", digest: digestOf(rec2) };
    await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
  });

  it("3319 T30 (b) no journal row, or a journal that is not finalized, makes the reader throw", async () => {
    stock([rec1]);
    runtimeRegistersStore(rec1);
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1)) };
    for (const op of [null, { phase: "materialized", installOpId: "op-mid", digest: digestOf(rec1) }]) {
      t3Store.op = op;
      await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
    }
  });

  it("3319 T30 (c) a placeholder integrity or no content hash makes the reader throw", async () => {
    stock([rec1]);
    runtimeRegistersStore(rec1);
    for (const source of [
      { type: "verdaccio", activeDigest: digestOf(rec1), integrity: "dispatcher-install", contentHash: "h" },
      { type: "verdaccio", activeDigest: digestOf(rec1), integrity: "sha512-t3" },
      { type: "github", activeDigest: digestOf(rec1), ...PIPELINE },
    ]) {
      t3Store.rows = { [LI_INSTALL]: linkedinRow(null, { source }) };
      await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
    }
  });

  it("3319 T30 (d) a row with no source, or a source the runtime anchors no install from, makes the reader throw though the runtime registered the development tree", async () => {
    writeDevManifest(["cinatra-ai", "linkedin-artifacts"], "1.0.0");
    runtimeRegistersDevTree();
    for (const source of [null, { type: "t30-unknown-source" }]) {
      t3Store.rows = { [LI_INSTALL]: linkedinRow(null, { source }) };
      await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
    }
  });

  it("3319 T30 (e) the journal is read in the default row's namespace (0.0.0) and in a non-default row's own version, for every live version row of the package (fold 5)", async () => {
    stock([rec1]);
    runtimeRegistersStore(rec1);
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1)) };
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
    expect(t3Store.opCalls).toEqual([`${EXT_LINKEDIN}|null|0.0.0`]);
    // A non-default 1.0.0 row beside the package's default 2.0.0 row: the
    // runtime's resolver reads each row in its own namespace.
    t3Store.opCalls = [];
    t3Store.rows = {
      "inst-li-default": linkedinRow(digestOf(rec2), { id: "inst-li-default", version: "2.0.0" }),
      [LI_INSTALL]: linkedinRow(digestOf(rec1), { isDefault: false, version: "1.0.0" }),
    };
    t3Store.opsByNs = {
      "0.0.0": { phase: "finalized", installOpId: "op-default", digest: digestOf(rec2) },
      "1.0.0": { phase: "finalized", installOpId: "op-sbs", digest: digestOf(rec1) },
    };
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
    expect([...t3Store.opCalls].sort()).toEqual(
      [`${EXT_LINKEDIN}|null|0.0.0`, `${EXT_LINKEDIN}|null|1.0.0`].sort(),
    );
  });

  it("3319 T30 (f) a row that records no digest takes the digest the finalized journal records, as the runtime does", async () => {
    stock([rec1, rec2]);
    runtimeRegistersStore(rec1);
    t3Store.rows = {
      [LI_INSTALL]: linkedinRow(null, { source: { type: "verdaccio", ...PIPELINE } }),
    };
    t3Store.op = { phase: "finalized", installOpId: "op-t30", digest: digestOf(rec1) };
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
    // The journal selects the 2.0.0 record while the runtime registered the
    // 1.0.0 one: not the install's surface.
    t3Store.op = { phase: "finalized", installOpId: "op-t30", digest: digestOf(rec2) };
    await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
  });

  it("3319 T30 (g) a gate that selects no digest takes the store record the runtime registered the pack from (fold 5)", async () => {
    t3Store.rows = {
      [LI_INSTALL]: linkedinRow(null, { source: { type: "verdaccio", ...PIPELINE } }),
    };
    t3Store.op = { phase: "finalized", installOpId: "op-legacy", digest: null };
    stock([rec1]);
    runtimeRegistersStore(rec1);
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
    // A development-tree surface is not a store install's.
    artifactPackSurfaceRegistry?._clearForTests();
    writeDevManifest(["cinatra-ai", "linkedin-artifacts"], "1.0.0");
    runtimeRegistersDevTree();
    await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
  });

  it("3319 T30 (h) a journal that cannot be read makes the reader throw", async () => {
    stock([rec1]);
    runtimeRegistersStore(rec1);
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1)) };
    t3Store.opThrows = true;
    await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
  });

  // cinatra#3319 T32: A SURFACE ANSWERS ONLY FOR THE PACKAGE IT NAMES.
  it("3319 T32 (b) another package's development manifest beside the pack's own does not count: the pack's own answers", async () => {
    t3Store.rows = { [LI_INSTALL]: linkedinRow(null) };
    writeDevManifest(["cinatra-ai", "linkedin-artifacts"], "1.0.0");
    const otherDir = join(t3Store.devRoot as string, "linkedin-artifacts");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(
      join(otherDir, "package.json"),
      JSON.stringify({
        name: "linkedin-artifacts",
        version: "1.0.0",
        cinatra: { kind: "artifact", artifact: { accepts: { file: { mimeTypes: ["image/png"] } } } },
      }),
    );
    runtimeRegistersDevTree();
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
  });

  it("3319 T32 (e) an unscoped pack's bundled install answers through its one development path", async () => {
    const extPlain = "t32-plain-artifacts";
    const typePlain = "@cinatra-ai/t32plain:note";
    registerHostShaped(typePlain, "artifact-safe");
    t3Store.rows = {
      "inst-t32-plain": {
        id: "inst-t32-plain",
        packageName: extPlain,
        kind: "artifact",
        status: "active",
        source: { type: "bundled" },
      },
    };
    const devDir = join(t3Store.devRoot as string, extPlain);
    mkdirSync(devDir, { recursive: true });
    writeFileSync(
      join(devDir, "package.json"),
      JSON.stringify({
        name: extPlain,
        version: "1.0.0",
        cinatra: { kind: "artifact", artifact: { accepts: { file: { mimeTypes: POST_DRAFT_ACCEPTS } } } },
      }),
    );
    try {
      runtimeRegistersDevTree();
      const got = await helperMod.readClaimBackedMeaningTypesForOrg(ORG, {
        readClaimsForOrg: () => [
          claim({ id: "t32-plain", type: typePlain, ext: extPlain, status: "active", installId: "inst-t32-plain" }),
        ],
      });
      expect(got).toEqual([
        {
          objectTypeId: typePlain,
          extension: extPlain,
          acceptMimes: POST_DRAFT_ACCEPTS,
          extensionVersion: "1.0.0",
          installId: "inst-t32-plain",
          scope: `org:${ORG}`,
        },
      ]);
    } finally {
      rmSync(devDir, { recursive: true, force: true });
    }
  });

  // cinatra#3319 T33: ALL OR NOTHING, FOR THE EXTENSIONS THAT REACH THE MANIFEST
  // READ. One otherwise-eligible extension whose manifest cannot be read fails
  // the whole answer; an extension a rule drops before that read never does.
  it("3319 T33 an unreadable manifest fails the whole answer only for an extension that reaches the manifest read", async () => {
    const bound = { installId: "inst-t33" };
    const claims = [
      claim({ id: "t33-li", type: T_POST_DRAFT, ext: EXT_LINKEDIN, status: "active", ...bound }),
      // Rule 1 drops EXT_SELF before its manifest is read.
      claim({ id: "t33-self", type: T3_SELF_PACK_HOST, ext: EXT_SELF, status: "active", ...bound }),
      claim({ id: "t33-na", type: T3_NO_ACCEPTS, ext: EXT_T3_NO_ACCEPTS, status: "active", ...bound }),
    ];
    const readThatFailsFor =
      (failing: string) =>
      async (winner: { extension: string }) => {
        if (winner.extension === failing) throw new Error(`t33 unreadable ${failing}`);
        return {
          accepts: winner.extension === EXT_T3_NO_ACCEPTS ? [] : POST_DRAFT_ACCEPTS,
          objectTypeIds: [],
          matchers: [],
        };
      };
    expect(
      await helperMod.readClaimBackedMeaningTypesForOrg(ORG, {
        readClaimsForOrg: () => claims,
        readManifestFields: readThatFailsFor(EXT_SELF),
      }),
    ).toEqual([expect.objectContaining(POST_DRAFT_ENTRY)]);
    await expect(
      helperMod.readClaimBackedMeaningTypesForOrg(ORG, {
        readClaimsForOrg: () => claims,
        readManifestFields: readThatFailsFor(EXT_T3_NO_ACCEPTS),
      }),
    ).rejects.toThrow(`t33 unreadable ${EXT_T3_NO_ACCEPTS}`);
  });

  // cinatra#3319 T24: the packages that could be claim-backed are exactly the
  // packages that pass every rule but the surface read.
  it("3319 T24: readClaimBackedCandidatePackagesForOrg names each package that passes every rule but the manifest read, and a failed claim read throws", () => {
    const bound = { installId: "inst-t24" };
    const claims = [
      claim({ id: "t24-li", type: T_POST_DRAFT, ext: EXT_LINKEDIN, status: "active", ...bound }),
      // Rule 2 and rule 5 need the manifest, so these two stay candidates.
      claim({ id: "t24-matchers", type: T3_MATCHERS, ext: EXT_T3_MATCHERS, status: "active", ...bound }),
      claim({ id: "t24-na", type: T3_NO_ACCEPTS, ext: EXT_T3_NO_ACCEPTS, status: "active", ...bound }),
      // Rule 1, rule 3 and rule 4 drop these.
      claim({ id: "t24-self", type: T3_SELF_PACK_HOST, ext: EXT_SELF, status: "active", ...bound }),
      ...T3_MULTI.map((type, i) =>
        claim({ id: `t24-multi-${i}`, type, ext: EXT_T3_MULTI, status: "active", ...bound }),
      ),
      claim({ id: "t24-owned", type: T3_OWNED, ext: EXT_T3_OWNED_CLAIMANT, status: "active", ...bound }),
      // No winner: a dormant claim and an unregistered type.
      claim({ id: "t24-dormant", type: T_HOST_DORMANT, ext: EXT_CLAIMANT, status: "dormant", ...bound }),
      claim({ id: "t24-nowhere", type: T_UNREGISTERED, ext: EXT_NOWHERE, status: "active", ...bound }),
    ];
    expect(helperMod.readClaimBackedCandidatePackagesForOrg(ORG, () => claims)).toEqual(
      [EXT_LINKEDIN, EXT_T3_MATCHERS, EXT_T3_NO_ACCEPTS].sort(),
    );
    // Rule 0 (a versionless winner) and rule 6 (an unbound claim) drop a package too.
    expect(
      helperMod.readClaimBackedCandidatePackagesForOrg(ORG, () => [
        claim({ id: "t24-v0", type: T_POST_DRAFT, ext: EXT_LINKEDIN, status: "active", version: "0.0.0", ...bound }),
        claim({ id: "t24-unbound", type: T3_MATCHERS, ext: EXT_T3_MATCHERS, status: "active", installId: null }),
      ]),
    ).toEqual([]);
    expect(() =>
      helperMod.readClaimBackedCandidatePackagesForOrg(ORG, () => {
        throw new Error("claim store unavailable");
      }),
    ).toThrow("claim store unavailable");
  });

  // ---------------------------------------------------------------------------
  // cinatra#3319 fold 5 (pre-review 3).
  // ---------------------------------------------------------------------------

  // MUST-FIX 1: the install is bound through the runtime's MULTI-VERSION trust
  // gate (`makeDefaultInstallAnchorsResolver`), never through one row alone.
  it("3319 T41 (a) a version two live owner rows share has no anchor in the runtime's resolver: the reader throws though the claim's own row passes the gate alone", async () => {
    stock([rec1]);
    runtimeRegistersStore(rec1);
    const nonDefault = { isDefault: false, version: "1.0.0" };
    const defaultRow = linkedinRow(digestOf(rec2), { id: "inst-li-default", version: "2.0.0" });
    t3Store.opsByNs = {
      "0.0.0": { phase: "finalized", installOpId: "op-default", digest: digestOf(rec2) },
      "1.0.0": { phase: "finalized", installOpId: "op-sbs", digest: digestOf(rec1) },
    };
    // Control: the claim's 1.0.0 row beside the package's default answers.
    t3Store.rows = {
      "inst-li-default": defaultRow,
      [LI_INSTALL]: linkedinRow(digestOf(rec1), nonDefault),
    };
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
    // A second live owner row at 1.0.0 in the same organisation: the runtime
    // skips the version (activates neither row), so the reader rejects the
    // read: it throws, and gives no empty answer.
    t3Store.rows = {
      "inst-li-default": defaultRow,
      [LI_INSTALL]: linkedinRow(digestOf(rec1), nonDefault),
      "inst-li-other-owner": linkedinRow(digestOf(rec1), { ...nonDefault, id: "inst-li-other-owner" }),
    };
    await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
  });

  it("3319 T41 (b) two live default rows of the package: the runtime's resolver activates no version, so the reader throws", async () => {
    stock([rec1]);
    runtimeRegistersStore(rec1);
    t3Store.rows = {
      [LI_INSTALL]: linkedinRow(digestOf(rec1), { version: "1.0.0" }),
      "inst-li-second-default": linkedinRow(digestOf(rec1), {
        id: "inst-li-second-default",
        version: "2.0.0",
      }),
    };
    await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
  });

  // MUST-FIX 3: a store folder is not the reader's to list. A store entry is a
  // record only when the runtime's store discovery takes it as one (a digest
  // named directory with a readable, valid manifest of the folder's kind and
  // package: `collectSlugDirRecords`), and the reader answers only from the
  // record or development tree the runtime registered the pack from.
  it("3319 T42 a store folder of the package that holds only current, a .tgz or a temporary entry holds no record: a bundled install answers from the development tree the runtime registered", async () => {
    writeDevManifest(["cinatra-ai", "linkedin-artifacts"], "1.0.0");
    mkdirSync(liSlugDir(), { recursive: true });
    writeFileSync(join(liSlugDir(), "current"), digestOf(rec1));
    writeFileSync(join(liSlugDir(), `${digestOf(rec1)}.tgz`), "tarball");
    mkdirSync(join(liSlugDir(), `.tmp-${digestOf(rec1)}`), { recursive: true });
    const { discoverStoreRecordsV2 } = await import("@/lib/extension-store-io");
    expect(
      (await discoverStoreRecordsV2(t3Store.dataRoot as string)).filter(
        (r) => r.packageName === EXT_LINKEDIN,
      ),
    ).toEqual([]);
    runtimeRegistersDevTree();
    t3Store.rows = { [LI_INSTALL]: linkedinRow(null) };
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
  });

  it("3319 T43 a digest-named record the runtime's discovery skips (a malformed manifest or an ordinary file) does not count: an install with no selected digest answers from the one record the runtime takes", async () => {
    stock([rec1, recBad]);
    writeFileSync(join(liSlugDir(), digestOf(join(root, "store-plain-file"))), "not a record");
    const { discoverStoreRecordsV2 } = await import("@/lib/extension-store-io");
    const taken = (await discoverStoreRecordsV2(t3Store.dataRoot as string)).filter(
      (r) => r.packageName === EXT_LINKEDIN,
    );
    expect(taken.map((r) => r.declaredDigest)).toEqual([digestOf(rec1)]);
    // The store rescan registers the one record of a package whose anchor
    // selects no digest.
    for (const rec of taken) {
      registerArtifactExtensionDir(rec.storeDir, { source: "store", digest: rec.declaredDigest as string });
    }
    t3Store.rows = {
      [LI_INSTALL]: linkedinRow(null, { source: { type: "verdaccio", ...PIPELINE } }),
    };
    t3Store.op = { phase: "finalized", installOpId: "op-legacy", digest: null };
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
  });

  // MUST-FIX 2: the picker's capabilities come from the one runtime-discovery
  // road. A pack the runtime registered no capability of is offered nothing,
  // whatever its manifest declares on disk.
  it("3319 T44 a bundled install whose development manifest declares Markdown acceptance but which the runtime did not register is offered nothing", async () => {
    t3Store.rows = { [LI_INSTALL]: linkedinRow(null) };
    // The bridge refuses the manifest (a key an artifact manifest may not
    // carry), as it refuses any manifest it cannot register.
    writeDevManifest(["cinatra-ai", "linkedin-artifacts"], "1.0.0", { serverEntry: "./server.js" });
    runtimeRegistersDevTree();
    expect(artifactPackSurfaceRegistry?.listForPackage(EXT_LINKEDIN) ?? []).toEqual([]);
    expect(await readLinkedin("1.0.0")).toEqual([]);
    // A valid manifest the runtime never registered (no scan ran) is offered
    // nothing either.
    writeDevManifest(["cinatra-ai", "linkedin-artifacts"], "1.0.0");
    expect(await readLinkedin("1.0.0")).toEqual([]);
    // Once the runtime registers it, it is offered.
    runtimeRegistersDevTree();
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
  });

  it("3319 T49 (a) the reader asks the dispatcher once per answer, for the artifact kind, in the organisation's own scope, registers the artifact facet if absent, and opens no store or development file", async () => {
    stock([rec1]);
    runtimeRegistersStore(rec1);
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1)) };
    fsFaults.reads.length = 0;
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
    expect(discoverState.calls).toEqual([
      {
        kind: "artifact",
        scope: { userId: null, organizationId: ORG, teamIds: [], orgRole: "org_admin" },
      },
    ]);
    expect(discoverState.registered).toEqual(["artifact"]);
    const fileReads = fsFaults.reads.filter(
      (p) => p.startsWith(t3Store.dataRoot as string) || p.startsWith(t3Store.devRoot as string),
    );
    expect(fileReads).toEqual([]);
  });

  it("3319 T49 (b) a pack whose install another organisation owns is not in this organisation's discovery: no entry", async () => {
    stock([rec1]);
    runtimeRegistersStore(rec1);
    t3Store.rows = {
      [LI_INSTALL]: linkedinRow(digestOf(rec1), {
        ownerLevel: "organization",
        organizationId: "org-3319-other",
      }),
    };
    expect(await readLinkedin("1.0.0")).toEqual([]);
    t3Store.rows = {
      [LI_INSTALL]: linkedinRow(digestOf(rec1), { ownerLevel: "organization", organizationId: ORG }),
    };
    t3Store.opsByNs = {
      "0.0.0": { phase: "finalized", installOpId: "op-org", digest: digestOf(rec1) },
    };
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
  });

  it("3319 T49 (c) a failed dispatcher read, a failed artifact facet and a missing artifact facet make the reader throw: none is \"no surface\"", async () => {
    stock([rec1]);
    runtimeRegistersStore(rec1);
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1)) };
    for (const flag of ["throws", "facetThrows", "unmigrated"] as const) {
      discoverState[flag] = true;
      await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
      discoverState[flag] = false;
    }
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
  });

  it("3319 T49 (d) a store install whose surface the runtime registered from the development tree, or from another store record of that version, makes the reader throw; a bundled install whose surface is a store record's does too", async () => {
    stock([recA1, rec1]);
    // The anchor selects the matcher-free record; the runtime registered the other.
    runtimeRegistersStore(recA1);
    t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1)) };
    await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
    // The development tree is no store install's record.
    writeDevManifest(["cinatra-ai", "linkedin-artifacts"], "1.0.0");
    runtimeRegistersDevTree();
    await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
    // A bundled install whose pack the runtime registered from a store record only.
    artifactPackSurfaceRegistry?._clearForTests();
    runtimeRegistersStore(rec1);
    t3Store.rows = { [LI_INSTALL]: linkedinRow(null) };
    await expect(readLinkedin("1.0.0")).rejects.toThrow(UNREADABLE);
  });

  // The registry warm (registerAllObjectTypes) runs the bundled scan again on
  // every call, after the boot's store rescan, and the store rescan runs again
  // on an install: a pack with a store record and a development tree has both
  // surfaces registered, in either order. Each install binds to its own record.
  it("3319 T50 a pack the runtime registered from a store record and from the development tree, in either order: a store install answers from its store record, a bundled install from the development tree", async () => {
    stock([rec1]);
    writeDevManifest(["cinatra-ai", "linkedin-artifacts"], "1.0.0", {
      artifact: { accepts: { file: { mimeTypes: ["text/markdown"] } }, skills: { matchers: ["t50-dev-matcher"] } },
    });
    for (const order of ["store-then-dev", "dev-then-store"] as const) {
      artifactPackSurfaceRegistry?._clearForTests();
      if (order === "store-then-dev") {
        runtimeRegistersStore(rec1);
        runtimeRegistersDevTree();
      } else {
        runtimeRegistersDevTree();
        runtimeRegistersStore(rec1);
      }
      // The store install answers from the matcher-free store record.
      t3Store.rows = { [LI_INSTALL]: linkedinRow(digestOf(rec1)) };
      expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
      // The bundled install reads the development tree's surface, which
      // declares matchers (rule 2): no entry, and no throw.
      t3Store.rows = { [LI_INSTALL]: linkedinRow(null) };
      expect(await readLinkedin("1.0.0")).toEqual([]);
    }
  });

  it("3319 T49 (e) a bundled install whose store folder holds a record answers from the development tree the runtime registered (the store rescan registers no record of a governed package it cannot anchor)", async () => {
    stock([rec1]);
    writeDevManifest(["cinatra-ai", "linkedin-artifacts"], "1.0.0");
    runtimeRegistersDevTree();
    t3Store.rows = { [LI_INSTALL]: linkedinRow(null) };
    expect(await readLinkedin("1.0.0")).toEqual([POST_DRAFT_ENTRY_AT_1]);
  });

  it("3319 T49 (f) a development manifest that names another package, or none, registers no surface of the pack: no entry", async () => {
    t3Store.rows = { [LI_INSTALL]: linkedinRow(null) };
    const devDir = join(t3Store.devRoot as string, "cinatra-ai", "linkedin-artifacts");
    for (const name of ["@t32-evil/linkedin-artifacts", undefined]) {
      artifactPackSurfaceRegistry?._clearForTests();
      mkdirSync(devDir, { recursive: true });
      writeFileSync(
        join(devDir, "package.json"),
        JSON.stringify({
          ...(name ? { name } : {}),
          version: "1.0.0",
          cinatra: { kind: "artifact", artifact: { accepts: { file: { mimeTypes: POST_DRAFT_ACCEPTS } } } },
        }),
      );
      runtimeRegistersDevTree();
      expect(artifactPackSurfaceRegistry?.listForPackage(EXT_LINKEDIN) ?? []).toEqual([]);
      expect(await readLinkedin("1.0.0")).toEqual([]);
    }
  });
});
