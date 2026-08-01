/**
 * cinatra#2044 GAP 2, hop 1 of 2 — `ensureAgentPackageFromGitFile` must carry the
 * sibling `package.json#cinatra.lifecycle` block through the synthesized import
 * ZIP.
 *
 * The wave124 negative proof: a real install of `@cinatra-ai/wordpress-agent`
 * 0.1.6 (whose manifest DOES declare `cinatra.lifecycle.repairCapable: true`)
 * left `agent_templates.lifecycle_config` NULL, so a reviewer's changes-request
 * routed `human_escalation` instead of `producer_repair` and the repair
 * round-trip could never start. Cause, hop 1: this loader synthesized the
 * install ZIP's `package.json` with only name/version/description/license and
 * `cinatra.{type,agentDependencies,produces}` — the lifecycle block was dropped
 * before `importAgentTemplateCore` ever saw it.
 *
 * Structurally the same defect class as cinatra#1454 GAP 2 (`cinatra.produces`
 * dropped by the same synthesis), and pinned the same way — see
 * `ensure-agent-package-produces-carry.test.ts`.
 *
 * Hop 2 (the ZIP's declaration actually reaching the column) is pinned by
 * `import-agent-core-lifecycle-config.test.ts`; the two hops end-to-end against
 * a real database, plus the wave124 routing repro, by
 * `lifecycle-config-loader-path.integration.test.ts`.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/ensure-agent-package-lifecycle-carry.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const AGENT_JSON_PATH = "/agents/cinatra-ai/wordpress-agent/cinatra/oas.json";

const OAS_CONTENT = JSON.stringify({
  agentspec_version: "26.1.0",
  component_type: "Flow",
  name: "WordPress Agent",
  metadata: { cinatra: { packageName: "@cinatra-ai/wordpress-agent" } },
});

/** The sibling manifest shape a repair-capable CMS producer ships — the same
 * `cinatra.lifecycle` block the lock-pinned `@cinatra-ai/wordpress-agent`
 * release declares, alongside the contract fields the synthesis already carried. */
const PKG_WITH_LIFECYCLE = JSON.stringify({
  name: "@cinatra-ai/wordpress-agent",
  version: "0.1.6",
  description: "produces WordPress content",
  license: "Apache-2.0",
  cinatra: {
    type: "flow",
    agentDependencies: { "@cinatra-ai/objects": "^0.1.0" },
    produces: [{ extension: "@cinatra-ai/objects", objectTypeId: "@cinatra-ai/objects:cms-preview-capture" }],
    lifecycle: { repairCapable: true },
  },
});

/** The same manifest with NO lifecycle block — the back-compat control. */
const PKG_WITHOUT_LIFECYCLE = JSON.stringify({
  name: "@cinatra-ai/wordpress-agent",
  version: "0.1.6",
  description: "produces WordPress content",
  license: "Apache-2.0",
  cinatra: { type: "flow" },
});

/** An unrelated manifest at a path the agent's layout does NOT designate — it
 *  must never be read. Declares a CONTRADICTORY lifecycle so shadowing would
 *  fail the assertion loudly rather than coincidentally agree. */
const DECOY_PKG = JSON.stringify({
  name: "@cinatra-ai/some-other-package",
  version: "9.9.9",
  license: "Apache-2.0",
  cinatra: { type: "orchestrator", lifecycle: { repairCapable: false } },
});

let PKG_CONTENT = PKG_WITH_LIFECYCLE;

/** The legacy FLAT layout dev-boot.ts:150 still loads: the OAS sits at
 *  `agents/<slug>/agent.json`, so its manifest is ADJACENT, not one level up. */
const FLAT_AGENT_JSON_PATH = "/agents/cinatra-ai/flat-agent/agent.json";

/**
 * When non-null, ONLY these exact paths resolve as manifests — every other path
 * throws ENOENT. Used by the layout-sensitive cases, where "which candidate path
 * did the loader actually probe" IS the assertion. Left null by default so the
 * cases above keep the original path-agnostic mock.
 */
let MANIFEST_PATHS: Record<string, string> | null = null;

/** The ZIP bytes `ensureAgentPackage` (the data/downloads system-agent path)
 *  reads. Set by that suite; irrelevant to the git-file cases. */
let DOWNLOAD_ZIP: Buffer | null = null;

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (p: string) => {
    if (p.endsWith(".zip") && DOWNLOAD_ZIP) return DOWNLOAD_ZIP;
    if (p === AGENT_JSON_PATH || p === FLAT_AGENT_JSON_PATH) return OAS_CONTENT;
    if (MANIFEST_PATHS !== null) {
      const hit = MANIFEST_PATHS[p];
      if (hit !== undefined) return hit;
    } else if (p.endsWith("/package.json")) {
      return PKG_CONTENT;
    }
    const err = new Error("ENOENT") as Error & { code: string };
    err.code = "ENOENT";
    throw err;
  }),
}));

const { readAgentTemplateByPackageNameMock, setAgentTemplatePackageNameMock } = vi.hoisted(() => ({
  readAgentTemplateByPackageNameMock: vi.fn(),
  setAgentTemplatePackageNameMock: vi.fn(async () => {}),
}));
vi.mock("../store", () => ({
  readAgentTemplateByPackageName: readAgentTemplateByPackageNameMock,
  setAgentTemplatePackageName: setAgentTemplatePackageNameMock,
}));

const { importAgentTemplateCoreMock } = vi.hoisted(() => ({
  importAgentTemplateCoreMock: vi.fn(async (..._args: unknown[]) => ({
    templateId: "tpl-wordpress",
    upserted: true,
  })),
}));
vi.mock("../import-agent-core", () => ({
  importAgentTemplateCore: importAgentTemplateCoreMock,
}));

vi.mock("../reserved-workspace-slugs", () => ({
  isReservedWorkspaceSlug: () => false,
}));

import { ensureAgentPackage, ensureAgentPackageFromGitFile } from "../ensure-agent-package";
import { createZipBuffer, readZipFiles } from "../zip-helpers";

type SynthesizedCinatra = {
  lifecycle?: unknown;
  produces?: Array<{ extension: string; objectTypeId?: string }>;
  agentDependencies?: Record<string, string>;
  type?: string;
};

async function synthesizedCinatraBlock(
  oasSourcePath: string = AGENT_JSON_PATH,
): Promise<SynthesizedCinatra | undefined> {
  // No existing DB row → not a version-skip; the loader synthesizes + imports.
  readAgentTemplateByPackageNameMock.mockResolvedValue(undefined);
  const result = await ensureAgentPackageFromGitFile({ oasSourcePath });
  expect(result.skipped).toBe(false);
  expect(importAgentTemplateCoreMock).toHaveBeenCalledTimes(1);
  const zipBase64 = importAgentTemplateCoreMock.mock.calls[0]![0] as string;
  const files = readZipFiles(Buffer.from(zipBase64, "base64"));
  return (JSON.parse(files.get("package.json")!) as { cinatra?: SynthesizedCinatra }).cinatra;
}

describe("cinatra#2044 GAP 2 — ensureAgentPackageFromGitFile carries cinatra.lifecycle through the import ZIP", () => {
  beforeEach(() => {
    importAgentTemplateCoreMock.mockClear();
    setAgentTemplatePackageNameMock.mockClear();
    readAgentTemplateByPackageNameMock.mockReset();
    PKG_CONTENT = PKG_WITH_LIFECYCLE;
    MANIFEST_PATHS = null;
  });

  it("synthesized ZIP package.json carries cinatra.lifecycle verbatim", async () => {
    const cinatra = await synthesizedCinatraBlock();
    // The byte the persistence hop compiles onto agent_templates.lifecycle_config
    // — absent ⇒ the column stays NULL ⇒ every changes-request escalates.
    expect(cinatra?.lifecycle).toEqual({ repairCapable: true });
  });

  it("the already-carried contract fields are untouched by the lifecycle carry", async () => {
    const cinatra = await synthesizedCinatraBlock();
    expect(cinatra?.type).toBe("flow");
    expect(cinatra?.agentDependencies).toEqual({ "@cinatra-ai/objects": "^0.1.0" });
    expect(cinatra?.produces).toEqual([
      { extension: "@cinatra-ai/objects", objectTypeId: "@cinatra-ai/objects:cms-preview-capture" },
    ]);
  });

  it("a manifest declaring NO lifecycle block synthesizes none (back-compat)", async () => {
    PKG_CONTENT = PKG_WITHOUT_LIFECYCLE;
    const cinatra = await synthesizedCinatraBlock();
    expect(cinatra?.lifecycle).toBeUndefined();
    expect(cinatra?.type).toBe("flow");
  });

  it("an ARRAY lifecycle is not carried (the declaration is an object)", async () => {
    // `typeof [] === "object"`, so the shape check is explicit. `normalizeLifecycle`
    // rejects arrays at the persistence hop too — this keeps the two ends agreeing
    // rather than relying on the downstream normalizer alone.
    PKG_CONTENT = JSON.stringify({
      name: "@cinatra-ai/wordpress-agent",
      version: "0.1.6",
      license: "Apache-2.0",
      cinatra: { type: "flow", lifecycle: [{ repairCapable: true }] },
    });
    const cinatra = await synthesizedCinatraBlock();
    expect(cinatra?.lifecycle).toBeUndefined();
  });
});

/**
 * The VERSION-SKIP guard is part of the same GAP 2 fix, and is what makes the
 * fix reach an instance that had ALREADY installed the producer.
 *
 * Before it, `existing.packageVersion === packageVersion` returned `skipped`
 * unconditionally, so the wave124 machine — `@cinatra-ai/wordpress-agent@0.1.6`
 * installed with `lifecycle_config` NULL — would take that early return on every
 * boot and never pick the declaration up. The guard now also requires the
 * DERIVED projection to be current.
 *
 * The end-to-end repair (real DB, real router) is proven by the UPGRADE case in
 * `lifecycle-config-loader-path.integration.test.ts`; these cases pin the
 * decision itself at the unit boundary.
 */
/**
 * The sibling-manifest PROBE, pinned per supported layout (codex round 0).
 *
 * `readSiblingPackageJsonIdentity` used to probe ONLY `../package.json` (the
 * canonical `agents/<slug>/cinatra/oas.json` layout), while the OAS compiler's
 * own sibling read probes BOTH candidates "for robustness"
 * (`oas-compiler.ts` readSiblingPackageJson). For the legacy FLAT layout —
 * `agents/<slug>/agent.json`, still loaded by `dev-boot.ts:150` — the loader
 * therefore found NO manifest at all.
 *
 * Before GAP 2 that only lost `description`/`produces`. WITH the version-skip
 * drift check it turns DESTRUCTIVE: "no manifest" compiles to "declares
 * nothing", which no longer matches an installed row carrying a real
 * `lifecycle_config`, so every boot re-imports and CLEARS the column — turning
 * a repair-capable producer back into `human_escalation`, the very bug this
 * issue fixes. Both layouts must reach the same declaration.
 */
describe("cinatra#2044 GAP 2 — the sibling manifest is resolved per supported layout", () => {
  beforeEach(() => {
    importAgentTemplateCoreMock.mockClear();
    setAgentTemplatePackageNameMock.mockClear();
    readAgentTemplateByPackageNameMock.mockReset();
    PKG_CONTENT = PKG_WITH_LIFECYCLE;
    MANIFEST_PATHS = null;
  });

  it("FLAT layout (agents/<slug>/agent.json): the ADJACENT package.json's lifecycle is carried", async () => {
    // ONLY the adjacent path exists. The canonical `../package.json` candidate
    // (/agents/cinatra-ai/package.json) throws ENOENT, so a passing assertion
    // here can only come from the second candidate being probed.
    MANIFEST_PATHS = {
      "/agents/cinatra-ai/flat-agent/package.json": PKG_WITH_LIFECYCLE,
    };
    const cinatra = await synthesizedCinatraBlock(FLAT_AGENT_JSON_PATH);
    expect(cinatra?.lifecycle).toEqual({ repairCapable: true });
  });

  it("CANONICAL layout: the PARENT package.json's lifecycle is still carried", async () => {
    // The mirror control — only the one-level-up path exists.
    MANIFEST_PATHS = {
      "/agents/cinatra-ai/wordpress-agent/package.json": PKG_WITH_LIFECYCLE,
    };
    const cinatra = await synthesizedCinatraBlock(AGENT_JSON_PATH);
    expect(cinatra?.lifecycle).toEqual({ repairCapable: true });
  });

  it("FLAT layout: an unrelated VENDOR-level package.json does NOT shadow the agent's own", async () => {
    // The ambiguity a [parent, adjacent] candidate LIST would have (codex round
    // 1): for a flat agent the parent path is `extensions/<vendor>/package.json`
    // — an unrelated manifest that a list ordered parent-first would read FIRST
    // and accept as authoritative, dropping the agent's real declaration and
    // clearing lifecycle_config. Layout-derived resolution never reads it.
    MANIFEST_PATHS = {
      "/agents/cinatra-ai/package.json": DECOY_PKG,
      "/agents/cinatra-ai/flat-agent/package.json": PKG_WITH_LIFECYCLE,
    };
    const cinatra = await synthesizedCinatraBlock(FLAT_AGENT_JSON_PATH);
    expect(cinatra?.lifecycle).toEqual({ repairCapable: true });
    expect(cinatra?.type).toBe("flow");
  });

  it("CANONICAL layout: a decoy package.json inside cinatra/ does NOT shadow the parent", async () => {
    // The mirror decoy — an adjacent manifest beside `cinatra/oas.json`.
    MANIFEST_PATHS = {
      "/agents/cinatra-ai/wordpress-agent/cinatra/package.json": DECOY_PKG,
      "/agents/cinatra-ai/wordpress-agent/package.json": PKG_WITH_LIFECYCLE,
    };
    const cinatra = await synthesizedCinatraBlock(AGENT_JSON_PATH);
    expect(cinatra?.lifecycle).toEqual({ repairCapable: true });
    expect(cinatra?.type).toBe("flow");
  });

  it("neither layout carries a manifest: no lifecycle is synthesized (still imports off the OAS)", async () => {
    // Genuinely absent — distinct from unreadable. The OAS supplies the
    // packageName, so the import proceeds and honestly declares nothing.
    MANIFEST_PATHS = {};
    const cinatra = await synthesizedCinatraBlock(AGENT_JSON_PATH);
    expect(cinatra?.lifecycle).toBeUndefined();
  });
});

/**
 * A manifest that parses but carries no usable `name` (codex round 0).
 *
 * It used to be reported `absent`, which DISCARDED its lifecycle/produces and
 * let the drift check write an authoritative "declares nothing" over a real
 * declaration — the same clobber class as the layout probe above. Identity
 * still falls back to the OAS's `metadata.cinatra.packageName`, so nothing about
 * the existing name-resolution contract changes.
 */
describe("cinatra#2044 GAP 2 — a nameless sibling manifest keeps its declarations", () => {
  beforeEach(() => {
    importAgentTemplateCoreMock.mockClear();
    setAgentTemplatePackageNameMock.mockClear();
    readAgentTemplateByPackageNameMock.mockReset();
    PKG_CONTENT = PKG_WITH_LIFECYCLE;
    MANIFEST_PATHS = null;
  });

  it("carries cinatra.lifecycle even though the manifest declares no name", async () => {
    // The OAS's metadata.cinatra.packageName supplies identity.
    PKG_CONTENT = JSON.stringify({
      version: "0.1.6",
      license: "Apache-2.0",
      cinatra: { type: "flow", lifecycle: { repairCapable: true } },
    });
    const cinatra = await synthesizedCinatraBlock();
    expect(cinatra?.lifecycle).toEqual({ repairCapable: true });
  });
});

describe("cinatra#2044 GAP 2 — the version-skip guard also compares the derived lifecycle projection", () => {
  beforeEach(() => {
    importAgentTemplateCoreMock.mockClear();
    setAgentTemplatePackageNameMock.mockClear();
    readAgentTemplateByPackageNameMock.mockReset();
    PKG_CONTENT = PKG_WITH_LIFECYCLE;
    MANIFEST_PATHS = null;
  });

  it("SKIPS when the installed row's lifecycle_config already matches the manifest", async () => {
    readAgentTemplateByPackageNameMock.mockResolvedValue({
      id: "tpl-wordpress",
      packageVersion: "0.1.6",
      lifecycleConfig: JSON.stringify({ repairCapable: true }),
    });
    const result = await ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH });
    expect(result.skipped).toBe(true);
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
  });

  it("RE-IMPORTS at the same version when the installed row's lifecycle_config is NULL", async () => {
    // The wave124 row, exactly.
    readAgentTemplateByPackageNameMock.mockResolvedValue({
      id: "tpl-wordpress",
      packageVersion: "0.1.6",
      lifecycleConfig: null,
    });
    const result = await ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH });
    expect(result.skipped).toBe(false);
    expect(importAgentTemplateCoreMock).toHaveBeenCalledTimes(1);
  });

  it("RE-IMPORTS at the same version when the installed row carries a STALE declaration", async () => {
    // A pin that DROPPED the block must clear the column, not leave a producer
    // wrongly routed as repair-capable — the drift check is bidirectional.
    PKG_CONTENT = PKG_WITHOUT_LIFECYCLE;
    readAgentTemplateByPackageNameMock.mockResolvedValue({
      id: "tpl-wordpress",
      packageVersion: "0.1.6",
      lifecycleConfig: JSON.stringify({ repairCapable: true }),
    });
    const result = await ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH });
    expect(result.skipped).toBe(false);
    expect(importAgentTemplateCoreMock).toHaveBeenCalledTimes(1);
  });

  it("still SKIPS a declaration-less package whose column is already NULL (no re-import loop)", async () => {
    PKG_CONTENT = PKG_WITHOUT_LIFECYCLE;
    readAgentTemplateByPackageNameMock.mockResolvedValue({
      id: "tpl-wordpress",
      packageVersion: "0.1.6",
      lifecycleConfig: null,
    });
    const result = await ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH });
    expect(result.skipped).toBe(true);
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
  });
});

/**
 * The ABSENT-sibling clobber (codex round 1) — the destructive direction this
 * change would otherwise have OPENED.
 *
 * With no sibling manifest on disk the loader still synthesizes a `package.json`
 * into the ZIP (it needs the identity fields), so that synthesis carries no
 * `cinatra.lifecycle` for a reason that says nothing about the author's intent.
 * Handed to the importer as an authoritative manifest it compiles to an explicit
 * CLEAR, wiping a correct `lifecycle_config` off an installed row — including one
 * the REGISTRY path legitimately wrote — on the next boot scan or watcher event.
 * A single transient ENOENT during a clone-back is enough to trigger it.
 *
 * Two halves, and BOTH are required: the importer must be told the synthesis is
 * non-authoritative, and the drift check must not report permanent "drift"
 * against a row it can then never change (which would re-import on every boot
 * forever).
 */
describe("cinatra#2044 GAP 2 — an ABSENT sibling manifest never clears an installed declaration", () => {
  beforeEach(() => {
    importAgentTemplateCoreMock.mockClear();
    setAgentTemplatePackageNameMock.mockClear();
    readAgentTemplateByPackageNameMock.mockReset();
    PKG_CONTENT = PKG_WITH_LIFECYCLE;
    MANIFEST_PATHS = null;
    DOWNLOAD_ZIP = null;
  });

  it("passes lifecycleDeclarationAuthoritative:false when no sibling manifest exists", async () => {
    MANIFEST_PATHS = {};
    readAgentTemplateByPackageNameMock.mockResolvedValue(undefined);
    await ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH });
    expect(importAgentTemplateCoreMock).toHaveBeenCalledTimes(1);
    const options = importAgentTemplateCoreMock.mock.calls[0]![2] as {
      lifecycleDeclarationAuthoritative?: boolean;
    };
    expect(options.lifecycleDeclarationAuthoritative).toBe(false);
  });

  it("passes lifecycleDeclarationAuthoritative:true when the sibling manifest WAS read", async () => {
    readAgentTemplateByPackageNameMock.mockResolvedValue(undefined);
    await ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH });
    const options = importAgentTemplateCoreMock.mock.calls[0]![2] as {
      lifecycleDeclarationAuthoritative?: boolean;
    };
    expect(options.lifecycleDeclarationAuthoritative).toBe(true);
  });

  it("SKIPS instead of re-importing a POPULATED row forever when the manifest is absent", async () => {
    // Without this the drift check compares a populated column against a derived
    // `null` on EVERY boot, re-imports, and — now that the importer correctly
    // refuses to clear — never converges: an unbounded re-import loop.
    MANIFEST_PATHS = {};
    readAgentTemplateByPackageNameMock.mockResolvedValue({
      id: "tpl-wordpress",
      packageVersion: undefined,
      lifecycleConfig: JSON.stringify({ repairCapable: true }),
    });
    const result = await ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH });
    expect(result.skipped).toBe(true);
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
  });

  it("ensureAgentPackage (data/downloads): a MANIFEST-LESS ZIP is non-authoritative too", async () => {
    // codex round 2 — the SAME clobber in the sibling entry point. This path
    // injects its own `{name, version}` package.json when the ZIP carries none,
    // so handing that to the importer as authoritative would clear a populated
    // lifecycle_config on any version mismatch (i.e. every upgrade).
    DOWNLOAD_ZIP = createZipBuffer([
      { name: "agent.json", content: OAS_CONTENT },
      { name: "manifest.json", content: JSON.stringify({ version: 1 }) },
    ]);
    readAgentTemplateByPackageNameMock.mockResolvedValue({
      id: "tpl-wordpress",
      packageVersion: "0.1.5",
    });
    await ensureAgentPackage({
      packageName: "@cinatra-ai/wordpress-agent",
      packageVersion: "0.1.6",
      zipFileName: "wordpress-agent.zip",
    });
    const options = importAgentTemplateCoreMock.mock.calls[0]![2] as {
      lifecycleDeclarationAuthoritative?: boolean;
    };
    expect(options.lifecycleDeclarationAuthoritative).toBe(false);
  });

  it("ensureAgentPackage: an UNPARSEABLE manifest (replaced by the synthesis) is non-authoritative", async () => {
    DOWNLOAD_ZIP = createZipBuffer([
      { name: "agent.json", content: OAS_CONTENT },
      { name: "package.json", content: "{ not json" },
    ]);
    readAgentTemplateByPackageNameMock.mockResolvedValue({
      id: "tpl-wordpress",
      packageVersion: "0.1.5",
    });
    await ensureAgentPackage({
      packageName: "@cinatra-ai/wordpress-agent",
      packageVersion: "0.1.6",
      zipFileName: "wordpress-agent.zip",
    });
    const options = importAgentTemplateCoreMock.mock.calls[0]![2] as {
      lifecycleDeclarationAuthoritative?: boolean;
    };
    expect(options.lifecycleDeclarationAuthoritative).toBe(false);
  });

  it("ensureAgentPackage: a REAL author manifest in the ZIP stays authoritative", async () => {
    // The control. This branch carries the author's cinatra block through intact,
    // so a version that legitimately DROPS the lifecycle block must still clear
    // the column — the opt-out must not blanket-disable the explicit-clear rule.
    DOWNLOAD_ZIP = createZipBuffer([
      { name: "agent.json", content: OAS_CONTENT },
      { name: "package.json", content: PKG_WITH_LIFECYCLE },
    ]);
    readAgentTemplateByPackageNameMock.mockResolvedValue({
      id: "tpl-wordpress",
      packageVersion: "0.1.5",
    });
    await ensureAgentPackage({
      packageName: "@cinatra-ai/wordpress-agent",
      packageVersion: "0.1.6",
      zipFileName: "wordpress-agent.zip",
    });
    const options = importAgentTemplateCoreMock.mock.calls[0]![2] as {
      lifecycleDeclarationAuthoritative?: boolean;
    };
    expect(options.lifecycleDeclarationAuthoritative).toBe(true);
    // …and the author's declaration survives the ZIP rebuild that renames the
    // package, so it still reaches the column.
    const rebuilt = readZipFiles(
      Buffer.from(importAgentTemplateCoreMock.mock.calls[0]![0] as string, "base64"),
    );
    const manifest = JSON.parse(rebuilt.get("package.json")!) as {
      cinatra?: { lifecycle?: unknown };
    };
    expect(manifest.cinatra?.lifecycle).toEqual({ repairCapable: true });
  });

  it("an UNREADABLE sibling still refuses outright (the stronger, pre-existing guard)", async () => {
    // The absent case degrades gracefully; a manifest that EXISTS but cannot be
    // read is a hard refusal, because every OTHER manifest-derived column would
    // be synthesized hollow too. Pinned here so the new absent-path leniency is
    // never mistaken for a relaxation of that guard.
    const { readFile } = await import("node:fs/promises");
    vi.mocked(readFile).mockImplementationOnce(async () => OAS_CONTENT);
    vi.mocked(readFile).mockImplementationOnce(async () => {
      const err = new Error("EACCES") as Error & { code: string };
      err.code = "EACCES";
      throw err;
    });
    readAgentTemplateByPackageNameMock.mockResolvedValue(undefined);
    const result = await ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH });
    expect(result.skipped).toBe(true);
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
  });
});
