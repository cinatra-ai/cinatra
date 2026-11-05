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
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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

vi.mock("@/lib/extension-data-root", () => ({
  resolveExtensionDataRoot: () => "/unused-by-this-test",
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
  const dataRoot = await mkdtemp(path.join(tmpdir(), "cinatra-3525-store-"));
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
  const root = await mkdtemp(path.join(tmpdir(), "cinatra-3602-source-"));
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

async function load(importModule?: (absPath: string) => Promise<unknown>) {
  const { loadDeclaredToolModule } = await import("@/lib/extension-tool-module-loader");
  return loadDeclaredToolModule(
    {
      packageName: PACK,
      packageVersion: PINNED,
      orgId: ORG,
      toolName: "fixture_tool",
      modulePath: "./cinatra/tools/fixture-tool.mjs",
    },
    importModule ? { importModule } : {},
  );
}

beforeEach(async () => {
  storeRecords.length = 0;
  anchors.length = 0;
  anchorResolverCalls.length = 0;
  await twoDigestStore();
});

afterEach(() => {
  vi.restoreAllMocks();
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
