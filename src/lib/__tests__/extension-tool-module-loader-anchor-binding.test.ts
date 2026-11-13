/**
 * THE DECLARED-MODULE LOAD ROAD IS ANCHOR-BOUND (cinatra#3525, convergence).
 *
 * The host imports nothing out of the writable package store that the TRUSTED
 * canonical install row does not name: the boot loader binds the row's kind and
 * its digest to the store record before it activates a serverEntry, and the
 * road that runs a caller's DECLARED module is held to the same two bindings.
 * Reading name and version off the store itself would accept any retained
 * digest directory that self-reports the same version — including one
 * activation refuses.
 *
 *   pnpm vitest run src/lib/__tests__/extension-tool-module-loader-anchor-binding.test.ts
 */
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionToolPorts } from "@/lib/extension-tool-dispatch";
import type { ExtensionToolModuleLoaderDeps } from "@/lib/extension-tool-module-loader";

const PACK = "@fixture-scope/fixture-tool-pack";
const PINNED = "1.2.3";
const ORG = "org-fixture";
const LIVE_DIGEST = "aaaaaaaaaaaa";
const RETAINED_DIGEST = "bbbbbbbbbbbb";

type StoreRecord = {
  packageName: string;
  kind: string;
  storeDir: string;
  declaredDigest?: string;
};

/** A generated static-manifest record, in the two fields this road reads. */
type GeneratedRecord = { version: string | null; sourceDir: string };

const storeRecords: StoreRecord[] = [];
const anchors: {
  installId?: string | null;
  version: string | null;
  digest: string | null;
  kind: string | null;
}[] = [];
const anchorResolverCalls: (string | null)[] = [];
const generatedManifest: Record<string, GeneratedRecord> = {};
/** The canonical install rows of the package, in the fields the seed road reads. */
type InstallRow = {
  status: string;
  version?: string;
  organizationId: string | null;
  ownerLevel: string;
  source: { type: string } | null;
};
const installRows: InstallRow[] = [];
/** Every temporary fixture tree of one test, removed after it. */
const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
const dataRootRef = { current: "/unused-by-this-test" };

vi.mock("@/lib/extension-data-root", () => ({
  resolveExtensionDataRoot: () => dataRootRef.current,
}));

vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: async () => installRows,
}));

vi.mock("@/lib/extension-store-io", () => ({
  discoverStoreRecordsV2: async () => storeRecords,
  realStoreFs: {
    readFile: async (p: string) => (await import("node:fs/promises")).readFile(p, "utf8"),
  },
}));

vi.mock("@/lib/extension-install-anchor", () => ({
  makeDefaultInstallAnchorsResolver: async (orgId: string | null) => {
    anchorResolverCalls.push(orgId);
    return async () => anchors;
  },
}));

// The GENERATED static manifest, substituted like the three collaborators
// above: the arms below drive the record's own fields (its pinned version and
// the source directory it records) rather than the committed file's contents.
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: generatedManifest,
}));

/**
 * The fixture tool module's source — a CONSTANT, never built from a value.
 *
 * Constructing the module text by interpolating the digest into it made the
 * written file's CODE depend on a value, which is the shape the scanner names
 * (js/bad-code-sanitization). The fixture needs no such interpolation: the
 * store layout this file builds below is
 * `<dataRoot>/agent/fixture-tool-pack/<digest>/cinatra/tools/fixture-tool.mjs`,
 * so the digest is the fourth path segment from the end of the module's OWN
 * url and the module reads it out of its own location instead.
 *
 * Every arm of this suite passes `load` its own `importModule` stub, so this
 * body is never executed by the tests — the file exists only so the loader has
 * a real module to resolve and refuse or admit.
 */
const FIXTURE_TOOL_MODULE_SOURCE = `import path from "node:path";
import { fileURLToPath } from "node:url";

export function extensionTool() {
  const segments = path.dirname(fileURLToPath(import.meta.url)).split(path.sep);
  return { digest: segments[segments.length - 3] };
}
`;

/** Two digest dirs of the SAME package at the SAME version, as a store that has
 *  retained an older install beside the live one actually looks. */
async function twoDigestStore() {
  const dataRoot = await tempDir("cinatra-3525-store-");
  // The RETAINED digest is discovered FIRST, so a resolver that trusts the
  // store's own package.json hands back exactly the wrong directory.
  for (const digest of [RETAINED_DIGEST, LIVE_DIGEST]) {
    const dir = path.join(dataRoot, "agent", "fixture-tool-pack", digest, "cinatra", "tools");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dataRoot, "agent", "fixture-tool-pack", digest, "package.json"),
      JSON.stringify({ name: PACK, version: PINNED }),
    );
    await writeFile(path.join(dir, "fixture-tool.mjs"), FIXTURE_TOOL_MODULE_SOURCE);
    storeRecords.push({
      packageName: PACK,
      kind: "agent",
      declaredDigest: digest,
      storeDir: path.join(dataRoot, "agent", "fixture-tool-pack", digest),
    });
  }
  return dataRoot;
}

/**
 * A package lying in the SOURCE TREE, the way a development installation has
 * it: its own package.json and the declared module beside it, and no store
 * record anywhere. `sourceDir` is recorded the way a generated record records
 * one — relative to the process's own working directory.
 */
async function sourceTreePackage(
  options: { name?: string; version?: string; moduleEscapesTheTree?: boolean } = {},
) {
  const root = await tempDir("cinatra-3602-source-");
  const dir = path.join(root, "fixture-tool-pack");
  const toolsDir = path.join(dir, "cinatra", "tools");
  await mkdir(toolsDir, { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: options.name ?? PACK, version: options.version ?? PINNED }),
  );
  if (options.moduleEscapesTheTree) {
    // A link lying INSIDE the source directory whose real path is outside it:
    // the string-level gate passes and only the realpath containment refuses.
    const outside = path.join(root, "outside-the-tree.mjs");
    await writeFile(outside, FIXTURE_TOOL_MODULE_SOURCE);
    await symlink(outside, path.join(toolsDir, "fixture-tool.mjs"));
  } else {
    await writeFile(path.join(toolsDir, "fixture-tool.mjs"), FIXTURE_TOOL_MODULE_SOURCE);
  }
  return { dir, sourceDir: path.relative(process.cwd(), dir) };
}

/** The generated manifest holds this one record for the fixture package. */
function generatedRecord(record: GeneratedRecord) {
  for (const key of Object.keys(generatedManifest)) delete generatedManifest[key];
  generatedManifest[PACK] = record;
}

/** Run one arm under an explicit runtime mode, restoring the process after. */
async function withRuntimeMode<T>(mode: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.CINATRA_RUNTIME_MODE;
  process.env.CINATRA_RUNTIME_MODE = mode;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.CINATRA_RUNTIME_MODE;
    else process.env.CINATRA_RUNTIME_MODE = previous;
  }
}

async function load(
  importModule?: (absPath: string) => Promise<unknown>,
  modulePath = "./cinatra/tools/fixture-tool.mjs",
) {
  const { loadDeclaredToolModule } = await import("@/lib/extension-tool-module-loader");
  return loadDeclaredToolModule(
    {
      packageName: PACK,
      packageVersion: PINNED,
      orgId: ORG,
      toolName: "fixture_tool",
      modulePath,
    },
    importModule ? { importModule } : {},
  );
}

beforeEach(async () => {
  storeRecords.length = 0;
  anchors.length = 0;
  anchorResolverCalls.length = 0;
  installRows.length = 0;
  dataRootRef.current = "/unused-by-this-test";
  await twoDigestStore();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("the declared-module load road binds the trusted install anchor", () => {
  it("loads out of the digest directory the anchor names, never a retained sibling", async () => {
    anchors.push({ version: PINNED, digest: LIVE_DIGEST, kind: "agent" });
    const seen: string[] = [];
    await load(async (absPath) => {
      seen.push(absPath);
      return { extensionTool: () => ({ ok: true }) };
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(path.join(LIVE_DIGEST, "cinatra", "tools", "fixture-tool.mjs"));
    expect(seen[0]).not.toContain(RETAINED_DIGEST);
    // The anchor is read in the RUN'S OWN organisation, never platform-wide.
    expect(anchorResolverCalls).toEqual([ORG]);
  });

  it("refuses when the anchor names a digest that is not the one on disk", async () => {
    anchors.push({ version: PINNED, digest: "cccccccccccc", kind: "agent" });
    await expect(load(async () => ({ extensionTool: () => ({}) }))).rejects.toThrow(
      /not materialized at the pinned version/,
    );
  });

  it("refuses when the canonical row's kind contradicts the store path's kind", async () => {
    anchors.push({ version: PINNED, digest: LIVE_DIGEST, kind: "artifact" });
    await expect(load(async () => ({ extensionTool: () => ({}) }))).rejects.toThrow(
      /not materialized at the pinned version/,
    );
  });

  it("refuses when no trusted row carries the version the run is bound to", async () => {
    anchors.push({ version: "9.9.9", digest: LIVE_DIGEST, kind: "agent" });
    await expect(load(async () => ({ extensionTool: () => ({}) }))).rejects.toThrow(
      /not materialized at the pinned version/,
    );
  });

  it("refuses a digest-unbound legacy anchor while the store is ambiguous", async () => {
    anchors.push({ version: PINNED, digest: null, kind: "agent" });
    await expect(load(async () => ({ extensionTool: () => ({}) }))).rejects.toThrow(
      /not materialized at the pinned version/,
    );
  });
});

/**
 * THE SECOND ROAD (cinatra#3602): a package that lies in the source tree and
 * was never materialized into the writable store. It is consulted ONLY when
 * the store holds NO record for that package at all, only on a development
 * installation, and only while the generated record's own version and the
 * package.json lying on disk both carry the version the run is pinned to. The
 * two path gates are the ones the store road passes, unchanged.
 *
 * The shared setup above builds a two-digest store, so every arm that reads
 * the in-tree road empties it as its own first line; the arm that proves the
 * store still wins deliberately keeps it.
 */
describe("the declared-module load road reads the source directory the generated manifest pins", () => {
  it("an in-tree package whose store record is absent and whose generated version matches the pin loads its declared module", async () => {
    storeRecords.length = 0;
    const pack = await sourceTreePackage();
    generatedRecord({ version: PINNED, sourceDir: pack.sourceDir });
    const seen: string[] = [];
    await withRuntimeMode("development", () =>
      load(async (absPath) => {
        seen.push(absPath);
        return { extensionTool: () => ({ ok: true }) };
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(path.join("fixture-tool-pack", "cinatra", "tools", "fixture-tool.mjs"));
  });

  it("a declared path that escapes the source directory is refused", async () => {
    storeRecords.length = 0;
    const pack = await sourceTreePackage({ moduleEscapesTheTree: true });
    generatedRecord({ version: PINNED, sourceDir: pack.sourceDir });
    const seen: string[] = [];
    await expect(
      withRuntimeMode("development", () =>
        load(async (absPath) => {
          seen.push(absPath);
          return { extensionTool: () => ({}) };
        }),
      ),
    ).rejects.toThrow(/resolves outside the calling extension's own tree/);
    expect(seen).toEqual([]);
  });

  it("a generated version that is not the pinned version is refused", async () => {
    storeRecords.length = 0;
    const pack = await sourceTreePackage();
    generatedRecord({ version: "9.9.9", sourceDir: pack.sourceDir });
    await expect(
      withRuntimeMode("development", () => load(async () => ({ extensionTool: () => ({}) }))),
    ).rejects.toThrow(/not materialized at the pinned version/);
  });

  it("a generated record with no version is refused", async () => {
    storeRecords.length = 0;
    const pack = await sourceTreePackage();
    generatedRecord({ version: null, sourceDir: pack.sourceDir });
    await expect(
      withRuntimeMode("development", () => load(async () => ({ extensionTool: () => ({}) }))),
    ).rejects.toThrow(/not materialized at the pinned version/);
  });

  it("a generated version padded with whitespace is not the pinned version and is refused", async () => {
    storeRecords.length = 0;
    const pack = await sourceTreePackage();
    generatedRecord({ version: ` ${PINNED} `, sourceDir: pack.sourceDir });
    await expect(
      withRuntimeMode("development", () => load(async () => ({ extensionTool: () => ({}) }))),
    ).rejects.toThrow(/not materialized at the pinned version/);
  });

  it("an on-disk package.json whose name differs is refused", async () => {
    storeRecords.length = 0;
    const pack = await sourceTreePackage({ name: "@fixture-scope/another-fixture-pack" });
    generatedRecord({ version: PINNED, sourceDir: pack.sourceDir });
    await expect(
      withRuntimeMode("development", () => load(async () => ({ extensionTool: () => ({}) }))),
    ).rejects.toThrow(/not materialized at the pinned version/);
  });

  it("an on-disk package.json whose version differs is refused", async () => {
    storeRecords.length = 0;
    const pack = await sourceTreePackage({ version: "9.9.9" });
    generatedRecord({ version: PINNED, sourceDir: pack.sourceDir });
    await expect(
      withRuntimeMode("development", () => load(async () => ({ extensionTool: () => ({}) }))),
    ).rejects.toThrow(/not materialized at the pinned version/);
  });

  it("a present store record remains the only road", async () => {
    // The shared two-digest store STANDS, and the anchor binds neither digest.
    const pack = await sourceTreePackage();
    generatedRecord({ version: PINNED, sourceDir: pack.sourceDir });
    anchors.push({ version: PINNED, digest: "cccccccccccc", kind: "agent" });
    const seen: string[] = [];
    await expect(
      withRuntimeMode("development", () =>
        load(async (absPath) => {
          seen.push(absPath);
          return { extensionTool: () => ({}) };
        }),
      ),
    ).rejects.toThrow(/not materialized at the pinned version/);
    expect(seen).toEqual([]);
  });

  it("outside a development installation the in-tree road is not consulted", async () => {
    storeRecords.length = 0;
    const pack = await sourceTreePackage();
    generatedRecord({ version: PINNED, sourceDir: pack.sourceDir });
    const seen: string[] = [];
    await expect(
      withRuntimeMode("production", () =>
        load(async (absPath) => {
          seen.push(absPath);
          return { extensionTool: () => ({}) };
        }),
      ),
    ).rejects.toThrow(/not materialized at the pinned version/);
    expect(seen).toEqual([]);
  });
});

/**
 * THE EXACT-INSTALL ROAD (cinatra#4154). A later change loads an embedded
 * child step's tool from the EXACT child installation the parent's dependency
 * edge resolved to. The load road then selects the anchor BY INSTALL ID: another
 * install of the same package at the same version is never taken, the version,
 * kind and digest bindings and the on-disk name and version hold as on the
 * name-and-version road, the source-directory road is never consulted, and the
 * anchor is read again immediately before the import.
 *
 * Every refusing arm below lists a DECOY first: another install of the same
 * package at the pinned version, whose digest directory exists and loads. The
 * name-and-version road takes that decoy, so each arm fails on a load road that
 * ignores the binding.
 */
const LIVE_INSTALL = "install-live";
const OTHER_INSTALL = "install-other";
const DECOY = { installId: OTHER_INSTALL, version: PINNED, digest: RETAINED_DIGEST, kind: "agent" };
const SECRET_TEXT = "/fixture/secret/store/path install-secret-id";

type FixtureBinding = { installId: string; digest: string | null; stillBound?: () => Promise<boolean> };

async function loadBound(binding: FixtureBinding, deps: ExtensionToolModuleLoaderDeps = {}) {
  const { loadDeclaredToolModule } = await import("@/lib/extension-tool-module-loader");
  return loadDeclaredToolModule(
    {
      packageName: PACK,
      packageVersion: PINNED,
      orgId: ORG,
      toolName: "fixture_tool",
      modulePath: "./cinatra/tools/fixture-tool.mjs",
      install: binding,
    },
    deps,
  );
}

/** An import seam that records what it was asked for. */
function recordingImport(seen: string[]) {
  return async (absPath: string) => {
    seen.push(absPath);
    return { extensionTool: () => ({ ok: true }) };
  };
}

async function moduleRefusalClass() {
  return (await import("@/lib/extension-tool-module-loader")).ExtensionToolModuleRefusal;
}

describe("an install-bound load selects the anchor by install id", () => {
  it("loads out of the exact install's digest directory, never another install of the same name and version", async () => {
    anchors.push(DECOY, { installId: LIVE_INSTALL, version: PINNED, digest: LIVE_DIGEST, kind: "agent" });
    const seen: string[] = [];
    await loadBound({ installId: LIVE_INSTALL, digest: LIVE_DIGEST }, { importModule: recordingImport(seen) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(path.join(LIVE_DIGEST, "cinatra", "tools", "fixture-tool.mjs"));
    expect(seen[0]).not.toContain(RETAINED_DIGEST);
    // Read twice in the RUN'S organisation: to resolve the root, and again just before the import.
    expect(anchorResolverCalls).toEqual([ORG, ORG]);
  });

  it.each([
    ["no anchor carries the install id", [DECOY], { installId: LIVE_INSTALL, digest: LIVE_DIGEST }],
    [
      "the install's anchor carries another version",
      [DECOY, { installId: LIVE_INSTALL, version: "9.9.9", digest: LIVE_DIGEST, kind: "agent" }],
      { installId: LIVE_INSTALL, digest: LIVE_DIGEST },
    ],
    [
      "the install's anchor carries a kind the store path contradicts",
      [DECOY, { installId: LIVE_INSTALL, version: PINNED, digest: LIVE_DIGEST, kind: "artifact" }],
      { installId: LIVE_INSTALL, digest: LIVE_DIGEST },
    ],
    [
      "the install's anchor names a digest that is not on disk",
      [DECOY, { installId: LIVE_INSTALL, version: PINNED, digest: "cccccccccccc", kind: "agent" }],
      { installId: LIVE_INSTALL, digest: "cccccccccccc" },
    ],
    [
      "the bound digest is not the install's anchor digest",
      [DECOY, { installId: LIVE_INSTALL, version: PINNED, digest: LIVE_DIGEST, kind: "agent" }],
      { installId: LIVE_INSTALL, digest: RETAINED_DIGEST },
    ],
    [
      // The bound id equals one anchor's blank id, and that anchor carries the pinned version and the bound digest,
      // so only the blank-id rule refuses.
      "the bound install id is blank",
      [DECOY, { ...DECOY, installId: "" }],
      { installId: "", digest: RETAINED_DIGEST },
    ],
    [
      // The same with a whitespace-only id on both sides, so only the rule's trim() refuses.
      "the bound install id is whitespace only",
      [DECOY, { ...DECOY, installId: " " }],
      { installId: " ", digest: RETAINED_DIGEST },
    ],
    [
      // Both carry the pin and the bound digest, so only an exactly-one rule refuses.
      "two anchors carry the install id",
      [
        DECOY,
        { installId: LIVE_INSTALL, version: PINNED, digest: LIVE_DIGEST, kind: "agent" },
        { installId: LIVE_INSTALL, version: PINNED, digest: LIVE_DIGEST, kind: "agent" },
      ],
      { installId: LIVE_INSTALL, digest: LIVE_DIGEST },
    ],
  ])("refuses when %s", async (_label, given, binding) => {
    anchors.push(...given);
    const seen: string[] = [];
    const Refusal = await moduleRefusalClass();
    const outcome = loadBound(binding, { importModule: recordingImport(seen) });
    await expect(outcome).rejects.toBeInstanceOf(Refusal);
    await expect(outcome).rejects.toThrow(/not materialized at the pinned version/);
    expect(seen).toEqual([]);
  });

  it("never takes the source-directory road, even in a development installation", async () => {
    storeRecords.length = 0;
    const pack = await sourceTreePackage();
    generatedRecord({ version: PINNED, sourceDir: pack.sourceDir });
    anchors.push({ installId: LIVE_INSTALL, version: PINNED, digest: LIVE_DIGEST, kind: "agent" });
    const seen: string[] = [];
    await expect(
      withRuntimeMode("development", () =>
        loadBound({ installId: LIVE_INSTALL, digest: LIVE_DIGEST }, { importModule: recordingImport(seen) }),
      ),
    ).rejects.toThrow(/not materialized at the pinned version/);
    expect(seen).toEqual([]);
  });

  it("refuses a module whose real path leaves the exact install's root", async () => {
    const live = storeRecords.find((record) => record.declaredDigest === LIVE_DIGEST);
    if (!live) throw new Error("the fixture store has no live digest directory");
    const modulePath = path.join(live.storeDir, "cinatra", "tools", "fixture-tool.mjs");
    const outsideDir = await mkdtemp(path.join(tmpdir(), "cinatra-4154-outside-"));
    try {
      const outside = path.join(outsideDir, "outside-the-tree.mjs");
      await writeFile(outside, FIXTURE_TOOL_MODULE_SOURCE);
      await rm(modulePath);
      await symlink(outside, modulePath);
      anchors.push(DECOY, { installId: LIVE_INSTALL, version: PINNED, digest: LIVE_DIGEST, kind: "agent" });
      const seen: string[] = [];
      await expect(
        loadBound({ installId: LIVE_INSTALL, digest: LIVE_DIGEST }, { importModule: recordingImport(seen) }),
      ).rejects.toThrow(/resolves outside the calling extension's own tree/);
      expect(seen).toEqual([]);
    } finally {
      // This case's own directory outside the store; the fixture store itself is the suite's existing debt.
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("answers a resolver that throws with the fixed refusal, never the thrown text", async () => {
    const Refusal = await moduleRefusalClass();
    const outcome = loadBound(
      { installId: LIVE_INSTALL, digest: LIVE_DIGEST },
      {
        resolvePackageRoot: async () => {
          throw new Error(SECRET_TEXT);
        },
        importModule: async () => ({ extensionTool: () => ({}) }),
      },
    );
    await expect(outcome).rejects.toBeInstanceOf(Refusal);
    await expect(outcome).rejects.toThrow(/not materialized at the pinned version/);
    await expect(outcome).rejects.not.toThrow(/secret|install-secret-id/);
  });

  it("without an install binding, a resolver that throws is rethrown unchanged (the name-and-version road as before)", async () => {
    const { loadDeclaredToolModule } = await import("@/lib/extension-tool-module-loader");
    const thrown = new Error("fixture resolver failure");
    await expect(
      loadDeclaredToolModule(
        {
          packageName: PACK,
          packageVersion: PINNED,
          orgId: ORG,
          toolName: "fixture_tool",
          modulePath: "./cinatra/tools/fixture-tool.mjs",
        },
        {
          resolvePackageRoot: async () => {
            throw thrown;
          },
        },
      ),
    ).rejects.toBe(thrown);
  });
});

describe("an install-bound load reads the install again immediately before the import", () => {
  const bound = { installId: LIVE_INSTALL, digest: LIVE_DIGEST };

  beforeEach(() => {
    anchors.push(DECOY, { installId: LIVE_INSTALL, version: PINNED, digest: LIVE_DIGEST, kind: "agent" });
  });

  it("re-reads the exact install's anchor in the run's organisation", async () => {
    const reread = vi.fn(async () => ({ version: PINNED, digest: LIVE_DIGEST }));
    const seen: string[] = [];
    await loadBound(bound, { readInstallAnchor: reread, importModule: recordingImport(seen) });
    expect(reread).toHaveBeenCalledTimes(1);
    expect(reread).toHaveBeenCalledWith({ packageName: PACK, orgId: ORG, installId: LIVE_INSTALL });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(LIVE_DIGEST);
  });

  it.each([
    ["the anchor is gone", async () => null],
    ["the anchor names another digest", async () => ({ version: PINNED, digest: RETAINED_DIGEST })],
    ["the anchor carries another version", async () => ({ version: "9.9.9", digest: LIVE_DIGEST })],
    [
      "the re-read throws",
      async (): Promise<{ version: string | null; digest: string | null } | null> => {
        throw new Error(SECRET_TEXT);
      },
    ],
  ])("refuses when %s", async (_label, reread) => {
    const seen: string[] = [];
    const Refusal = await moduleRefusalClass();
    const outcome = loadBound(bound, { readInstallAnchor: reread, importModule: recordingImport(seen) });
    await expect(outcome).rejects.toBeInstanceOf(Refusal);
    await expect(outcome).rejects.toThrow(
      /^extension_tool: the installation bound for `fixture_tool` changed before its module was loaded$/,
    );
    expect(seen).toEqual([]);
  });

  it.each([
    ["the binding's own re-check answers false", async () => false],
    ["the binding's own re-check answers a value other than true", async () => "yes" as unknown as boolean],
    [
      "the binding's own re-check throws",
      async (): Promise<boolean> => {
        throw new Error(SECRET_TEXT);
      },
    ],
  ])("refuses when %s", async (_label, stillBound) => {
    const seen: string[] = [];
    const outcome = loadBound({ ...bound, stillBound }, { importModule: recordingImport(seen) });
    await expect(outcome).rejects.toThrow(/changed before its module was loaded/);
    await expect(outcome).rejects.not.toThrow(/secret|install-secret-id/);
    expect(seen).toEqual([]);
  });

  it("refuses when the re-read finds a second anchor carrying the install id", async () => {
    anchors.push({ installId: LIVE_INSTALL, version: PINNED, digest: LIVE_DIGEST, kind: "agent" });
    const live = storeRecords.find((record) => record.declaredDigest === LIVE_DIGEST);
    if (!live) throw new Error("the fixture store has no live digest directory");
    const seen: string[] = [];
    // The root is handed in, so only the default re-read (by install id) sees both anchors.
    const outcome = loadBound(bound, {
      resolvePackageRoot: async () => live.storeDir,
      importModule: recordingImport(seen),
    });
    await expect(outcome).rejects.toThrow(/changed before its module was loaded/);
    expect(seen).toEqual([]);
  });

  it("loads when the binding's own re-check answers true", async () => {
    const stillBound = vi.fn(async () => true);
    const seen: string[] = [];
    await loadBound({ ...bound, stillBound }, { importModule: recordingImport(seen) });
    expect(stillBound).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(LIVE_DIGEST);
  });
});

/**
 * A DIGEST-UNBOUND (legacy) BINDING ON THE EXACT-INSTALL ROAD: `digest: null`
 * holds only while the install's anchor carries no digest, at the resolve and
 * at the re-read. An unbound anchor proceeds only while the disk is
 * unambiguous, so these arms keep the live digest directory alone on disk; the
 * decoy listed first then names a directory that is gone, and the
 * name-and-version road refuses where the exact-install road loads.
 */
describe("a digest-unbound binding on the exact-install road", () => {
  const UNBOUND_LIVE = { installId: LIVE_INSTALL, version: PINNED, digest: null, kind: "agent" };

  function onlyTheLiveDigestOnDisk() {
    const retained = storeRecords.findIndex((record) => record.declaredDigest === RETAINED_DIGEST);
    storeRecords.splice(retained, 1);
  }

  it("loads while the install's anchor carries no digest either", async () => {
    onlyTheLiveDigestOnDisk();
    anchors.push(DECOY, UNBOUND_LIVE);
    const seen: string[] = [];
    await loadBound({ installId: LIVE_INSTALL, digest: null }, { importModule: recordingImport(seen) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(path.join(LIVE_DIGEST, "cinatra", "tools", "fixture-tool.mjs"));
  });

  it("refuses when the install's anchor now carries a digest", async () => {
    anchors.push(DECOY, { ...UNBOUND_LIVE, digest: LIVE_DIGEST });
    const seen: string[] = [];
    await expect(
      loadBound({ installId: LIVE_INSTALL, digest: null }, { importModule: recordingImport(seen) }),
    ).rejects.toThrow(/not materialized at the pinned version/);
    expect(seen).toEqual([]);
  });

  it("refuses when the re-read finds that the anchor now carries a digest", async () => {
    onlyTheLiveDigestOnDisk();
    anchors.push(DECOY, UNBOUND_LIVE);
    const seen: string[] = [];
    await expect(
      loadBound(
        { installId: LIVE_INSTALL, digest: null },
        {
          readInstallAnchor: async () => ({ version: PINNED, digest: LIVE_DIGEST }),
          importModule: recordingImport(seen),
        },
      ),
    ).rejects.toThrow(/changed before its module was loaded/);
    expect(seen).toEqual([]);
  });

  it("a resolver call by install id with no digest selects by install id alone", async () => {
    anchors.push(DECOY, { ...UNBOUND_LIVE, digest: LIVE_DIGEST });
    const { resolvePinnedPackageRoot } = await import("@/lib/extension-tool-module-loader");
    const root = await resolvePinnedPackageRoot({
      packageName: PACK,
      packageVersion: PINNED,
      orgId: ORG,
      installId: LIVE_INSTALL,
    });
    expect(root).toBe(storeRecords.find((record) => record.declaredDigest === LIVE_DIGEST)?.storeDir);
  });
});

describe("the dispatch hands an install binding through to the load road", () => {
  const CINATRA = { tools: [{ name: "fixture_tool", module: "./cinatra/tools/fixture-tool.mjs" }] };

  function stubPorts(): Omit<ExtensionToolPorts, "review"> {
    return {
      data: { select: vi.fn(), insertIfAbsent: vi.fn(), updateWhere: vi.fn() },
      artifacts: { list: vi.fn(), contentRead: vi.fn() },
      clock: { now: () => new Date("2026-11-04T00:00:00.000Z") },
      objects: { read: vi.fn(), save: vi.fn() },
    };
  }

  it("loads the exact install the binding names", async () => {
    anchors.push(DECOY, { installId: LIVE_INSTALL, version: PINNED, digest: LIVE_DIGEST, kind: "agent" });
    const { dispatchExtensionTool } = await import("@/lib/extension-tool-dispatch");
    const seen: string[] = [];
    const result = await dispatchExtensionTool({
      packageName: PACK,
      packageVersion: PINNED,
      orgId: ORG,
      cinatra: CINATRA,
      request: { name: "fixture_tool", input: {} },
      ports: stubPorts(),
      install: { installId: LIVE_INSTALL, digest: LIVE_DIGEST },
      deps: { importModule: recordingImport(seen) },
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(LIVE_DIGEST);
    expect(seen[0]).not.toContain(RETAINED_DIGEST);
  });

  it("refuses when the binding names an install no anchor carries", async () => {
    anchors.push(DECOY);
    const { dispatchExtensionTool } = await import("@/lib/extension-tool-dispatch");
    const seen: string[] = [];
    await expect(
      dispatchExtensionTool({
        packageName: PACK,
        packageVersion: PINNED,
        orgId: ORG,
        cinatra: CINATRA,
        request: { name: "fixture_tool", input: {} },
        ports: stubPorts(),
        install: { installId: LIVE_INSTALL, digest: LIVE_DIGEST },
        deps: { importModule: recordingImport(seen) },
      }),
    ).rejects.toThrow(/not materialized at the pinned version/);
    expect(seen).toEqual([]);
  });

  it("without a binding, the root resolver is asked by name, version and organisation only (unchanged)", async () => {
    const { dispatchExtensionTool } = await import("@/lib/extension-tool-dispatch");
    const resolvePackageRoot = vi.fn(async () => null);
    await expect(
      dispatchExtensionTool({
        packageName: PACK,
        packageVersion: PINNED,
        orgId: ORG,
        cinatra: CINATRA,
        request: { name: "fixture_tool", input: {} },
        ports: stubPorts(),
        deps: { resolvePackageRoot },
      }),
    ).rejects.toThrow(/not materialized at the pinned version/);
    expect(resolvePackageRoot).toHaveBeenCalledTimes(1);
    expect(Object.keys((resolvePackageRoot.mock.calls[0] as unknown[])[0] as object).sort()).toEqual([
      "orgId",
      "packageName",
      "packageVersion",
    ]);
  });
});

/**
 * THE SEED COPY: a pack the image bundles reaches an instance only as its seed
 * copy in the agent runtime mount, `<dataRoot>/.agent-mount/<scope>/<name>`,
 * which the store walk never reads. Where the store holds no record for the
 * package, the declared module loads from that copy, but only while exactly
 * one candidate install row (the image's bundled platform row, or a row of the
 * run's own organisation) carries the pinned version, the seed's own marker
 * names the package, and the copy's package.json carries the pinned name and
 * version. Every arm runs in production mode, where the source road is closed,
 * unless it says otherwise.
 */
const SEED_MARKER = { vendor: "fixture-scope", slug: "fixture-tool-pack", kind: "required-oas-seed" };

/** The image's bundled platform row, as the boot seeder writes it. */
function bundledRow(overrides: Partial<InstallRow> = {}): InstallRow {
  return {
    status: "active",
    version: PINNED,
    organizationId: null,
    ownerLevel: "platform",
    source: { type: "bundled" },
    ...overrides,
  };
}

async function seedCopy(
  options: {
    name?: string;
    version?: string;
    noPackageJson?: boolean;
    marker?: Record<string, unknown> | null;
    moduleEscapesTheTree?: boolean;
    packageDirIsALink?: boolean;
  } = {},
) {
  const dataRoot = await tempDir("cinatra-seed-copy-");
  const scopeDir = path.join(dataRoot, ".agent-mount", "fixture-scope");
  await mkdir(scopeDir, { recursive: true });
  // A link in the mount whose target lies outside it carries a whole valid copy.
  const dir = options.packageDirIsALink
    ? path.join(dataRoot, "outside-the-mount", "fixture-tool-pack")
    : path.join(scopeDir, "fixture-tool-pack");
  const toolsDir = path.join(dir, "cinatra", "tools");
  await mkdir(toolsDir, { recursive: true });
  if (options.packageDirIsALink) await symlink(dir, path.join(scopeDir, "fixture-tool-pack"));
  if (!options.noPackageJson) {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: options.name ?? PACK, version: options.version ?? PINNED }),
    );
  }
  const marker = options.marker === undefined ? SEED_MARKER : options.marker;
  if (marker !== null) await writeFile(path.join(dir, ".cinatra-required-seed.json"), JSON.stringify(marker));
  if (options.moduleEscapesTheTree) {
    const outside = path.join(dataRoot, "outside-the-tree.mjs");
    await writeFile(outside, FIXTURE_TOOL_MODULE_SOURCE);
    await symlink(outside, path.join(toolsDir, "fixture-tool.mjs"));
  } else {
    await writeFile(path.join(toolsDir, "fixture-tool.mjs"), FIXTURE_TOOL_MODULE_SOURCE);
  }
  dataRootRef.current = dataRoot;
  return { dataRoot, dir };
}

const SEED_MODULE = path.join(
  ".agent-mount",
  "fixture-scope",
  "fixture-tool-pack",
  "cinatra",
  "tools",
  "fixture-tool.mjs",
);

describe("the declared-module load road reads the image's seed copy where the store holds no record", () => {
  const loads = async (mode = "production") => {
    const seen: string[] = [];
    await withRuntimeMode(mode, () =>
      load(async (absPath) => {
        seen.push(absPath);
        return { extensionTool: () => ({ ok: true }) };
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(SEED_MODULE);
  };
  const refuses = async (pattern: RegExp, modulePath?: string, mode = "production") => {
    const seen: string[] = [];
    await expect(
      withRuntimeMode(mode, () =>
        load(async (absPath) => {
          seen.push(absPath);
          return { extensionTool: () => ({}) };
        }, modulePath),
      ),
    ).rejects.toThrow(pattern);
    expect(seen).toEqual([]);
  };
  const NOT_MATERIALIZED = /not materialized at the pinned version/;

  it("a marked seed copy at the pinned version with the bundled row at that version loads its declared module", async () => {
    storeRecords.length = 0;
    await seedCopy();
    installRows.push(bundledRow());
    await loads();
  });

  it("a locked bundled row loads too", async () => {
    storeRecords.length = 0;
    await seedCopy();
    installRows.push(bundledRow({ status: "locked" }));
    await loads();
  });

  it("the run's own organisation's row at the pinned version loads", async () => {
    storeRecords.length = 0;
    await seedCopy();
    installRows.push(bundledRow({ organizationId: ORG, ownerLevel: "organization", source: { type: "verdaccio" } }));
    await loads();
  });

  it("a row of another organisation is never a candidate", async () => {
    storeRecords.length = 0;
    await seedCopy();
    installRows.push(bundledRow({ organizationId: "org-other", ownerLevel: "organization" }));
    await refuses(NOT_MATERIALIZED);
  });

  it("a platform row that is not the bundled one is not a candidate", async () => {
    storeRecords.length = 0;
    await seedCopy();
    installRows.push(bundledRow({ source: { type: "verdaccio" } }));
    await refuses(NOT_MATERIALIZED);
  });

  it("two live candidates (the bundled row and the own organisation's row) are refused", async () => {
    storeRecords.length = 0;
    await seedCopy();
    installRows.push(bundledRow(), bundledRow({ organizationId: ORG, ownerLevel: "organization" }));
    await refuses(NOT_MATERIALIZED);
  });

  it("a candidate row at another version is refused", async () => {
    storeRecords.length = 0;
    await seedCopy();
    installRows.push(bundledRow({ version: "9.9.9" }));
    await refuses(NOT_MATERIALIZED);
  });

  it("no install row is refused", async () => {
    storeRecords.length = 0;
    await seedCopy();
    await refuses(NOT_MATERIALIZED);
  });

  it("an install row that is not live is refused", async () => {
    storeRecords.length = 0;
    await seedCopy();
    installRows.push(bundledRow({ status: "archived" }));
    await refuses(NOT_MATERIALIZED);
  });

  it("a copy without the seed marker is refused", async () => {
    storeRecords.length = 0;
    await seedCopy({ marker: null });
    installRows.push(bundledRow());
    await refuses(NOT_MATERIALIZED);
  });

  it("a seed marker that names another package is refused", async () => {
    storeRecords.length = 0;
    await seedCopy({ marker: { ...SEED_MARKER, slug: "another-fixture-pack" } });
    installRows.push(bundledRow());
    await refuses(NOT_MATERIALIZED);
  });

  it("a marker of another kind is refused", async () => {
    storeRecords.length = 0;
    await seedCopy({ marker: { ...SEED_MARKER, kind: "something-else" } });
    installRows.push(bundledRow());
    await refuses(NOT_MATERIALIZED);
  });

  it("a seed copy whose package.json names another package is refused", async () => {
    storeRecords.length = 0;
    await seedCopy({ name: "@fixture-scope/another-fixture-pack" });
    installRows.push(bundledRow());
    await refuses(NOT_MATERIALIZED);
  });

  it("a seed copy whose package.json carries another version is refused", async () => {
    storeRecords.length = 0;
    await seedCopy({ version: "9.9.9" });
    installRows.push(bundledRow());
    await refuses(NOT_MATERIALIZED);
  });

  it("a seed copy without a package.json is refused", async () => {
    storeRecords.length = 0;
    await seedCopy({ noPackageJson: true });
    installRows.push(bundledRow());
    await refuses(NOT_MATERIALIZED);
  });

  it("a seed copy that is a link to a directory outside the mount is refused", async () => {
    storeRecords.length = 0;
    await seedCopy({ packageDirIsALink: true });
    installRows.push(bundledRow());
    await refuses(NOT_MATERIALIZED);
  });

  it("a declared module that is a link out of the seed copy is refused", async () => {
    storeRecords.length = 0;
    await seedCopy({ moduleEscapesTheTree: true });
    installRows.push(bundledRow());
    await refuses(/resolves outside the calling extension's own tree/);
  });

  it("a declared path that climbs out of the seed copy is refused", async () => {
    storeRecords.length = 0;
    await seedCopy();
    installRows.push(bundledRow());
    await refuses(/leaves the calling extension's own tree/, "./cinatra/../../outside-the-tree.mjs");
  });

  it("a present store record keeps the seed copy out", async () => {
    // The shared two-digest store STANDS, and the anchor binds neither digest.
    await seedCopy();
    installRows.push(bundledRow());
    anchors.push({ version: PINNED, digest: "cccccccccccc", kind: "agent" });
    await refuses(NOT_MATERIALIZED);
  });

  it("a source package.json that cannot be parsed stays a refusal and never falls through to the seed copy", async () => {
    storeRecords.length = 0;
    await seedCopy();
    installRows.push(bundledRow());
    const pack = await sourceTreePackage();
    await writeFile(path.join(pack.dir, "package.json"), "{ not json");
    generatedRecord({ version: PINNED, sourceDir: pack.sourceDir });
    await refuses(NOT_MATERIALIZED, undefined, "development");
  });
});

describe("a root the resolver checked as a real path is not resolved again", () => {
  it("a link put in place of the checked root after the check cannot move the import", async () => {
    const { dataRoot, dir } = await seedCopy();
    const outside = path.join(dataRoot, "swapped-in");
    await mkdir(path.join(outside, "cinatra", "tools"), { recursive: true });
    await writeFile(path.join(outside, "cinatra", "tools", "fixture-tool.mjs"), FIXTURE_TOOL_MODULE_SOURCE);
    const seen: string[] = [];
    const { loadDeclaredToolModule } = await import("@/lib/extension-tool-module-loader");
    const checkedRealRoot = await (await import("node:fs/promises")).realpath(dir);
    await expect(
      loadDeclaredToolModule(
        {
          packageName: PACK,
          packageVersion: PINNED,
          orgId: ORG,
          toolName: "fixture_tool",
          modulePath: "./cinatra/tools/fixture-tool.mjs",
        },
        {
          // The check has passed on the real directory; the swap happens before
          // the loader uses the root.
          resolvePackageRoot: async () => {
            await rename(checkedRealRoot, `${checkedRealRoot}-aside`);
            await symlink(outside, checkedRealRoot);
            return { realRoot: checkedRealRoot };
          },
          importModule: async (absPath) => {
            seen.push(absPath);
            return { extensionTool: () => ({}) };
          },
        },
      ),
    ).rejects.toThrow(/resolves outside the calling extension's own tree/);
    expect(seen).toEqual([]);
  });
});

/**
 * THE EXACT-INSTALL ROAD MEETS THE SEED-COPY ROAD (cinatra#4154 on main's seed
 * copy). The seed copy picks its own install row (the image's bundled row or a
 * row of the run's organisation), never the bound install id, so an
 * install-bound load never takes it, even where the copy itself would load. A
 * root the resolver hands over as a checked real path still passes the
 * install's own re-read before the import.
 */
describe("an install-bound load and the seed copy", () => {
  it("an install-bound load never takes the seed copy, while the same unbound load does", async () => {
    storeRecords.length = 0;
    await seedCopy();
    installRows.push(bundledRow());
    anchors.push({ installId: LIVE_INSTALL, version: PINNED, digest: LIVE_DIGEST, kind: "agent" });
    const unbound: string[] = [];
    await withRuntimeMode("production", () => load(recordingImport(unbound)));
    expect(unbound).toHaveLength(1);
    expect(unbound[0]).toContain(SEED_MODULE);
    const bound: string[] = [];
    await expect(
      withRuntimeMode("production", () =>
        loadBound({ installId: LIVE_INSTALL, digest: LIVE_DIGEST }, { importModule: recordingImport(bound) }),
      ),
    ).rejects.toThrow(/not materialized at the pinned version/);
    expect(bound).toEqual([]);
  });

  it("an install-bound load whose resolver hands over a checked real root still reads the install again before the import", async () => {
    const live = storeRecords.find((record) => record.declaredDigest === LIVE_DIGEST);
    if (!live) throw new Error("the fixture store has no live digest directory");
    const realRoot = await (await import("node:fs/promises")).realpath(live.storeDir);
    const resolvePackageRoot = async () => ({ realRoot });
    const moved: string[] = [];
    await expect(
      loadBound(
        { installId: LIVE_INSTALL, digest: LIVE_DIGEST },
        {
          resolvePackageRoot,
          readInstallAnchor: async () => ({ version: PINNED, digest: "cccccccccccc" }),
          importModule: recordingImport(moved),
        },
      ),
    ).rejects.toThrow(/changed before its module was loaded/);
    expect(moved).toEqual([]);
    const held: string[] = [];
    await loadBound(
      { installId: LIVE_INSTALL, digest: LIVE_DIGEST },
      {
        resolvePackageRoot,
        readInstallAnchor: async () => ({ version: PINNED, digest: LIVE_DIGEST }),
        importModule: recordingImport(held),
      },
    );
    expect(held).toEqual([path.join(realRoot, "cinatra", "tools", "fixture-tool.mjs")]);
  });
});
