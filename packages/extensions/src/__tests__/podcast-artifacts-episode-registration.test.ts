// The episode kind's registration in this application (cinatra#3093, W5 of #3087).
//
// Wave 5 gives the feed lister's episodes a kind of their own:
// `@cinatra-ai/podcast-artifacts` — one artifact per episode, each holding the
// episode's data exactly as the agent emits it, the title from the episode's
// title. The package lives in its own repository and carries its own suites;
// what THIS repository owes is the registration that makes the kind real here —
// a declared development extension, a commit pin, and the two host-maintained
// aliases the generated renderer map resolves the display through. Without
// them the package is invisible to the pinned clone-back, to the registry
// reconciliation and to the extension suite tier, so nothing can install it.
//
// The wave's other half — a kind for the research agent's rows and for the
// scraper's rows — was decided at planning as NONE on both axes: neither
// dataset gets a kind, and both stay with the generic structured-data
// extension on the default road, because the rows' shape is the run's own
// output schema and not a shape a kind can promise. The last case below is
// that decision's guard: a dataset kind cannot appear here unnoticed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

const PACKAGE_NAME = "@cinatra-ai/podcast-artifacts";
const REPO_SLUG = "cinatra-ai/podcast-artifacts";
const EPISODE_FORM = "application/json";

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relPath), "utf8"));
}

function readText(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

function hostManifest(): Record<string, unknown> {
  return readJson("package.json").cinatra as Record<string, unknown>;
}

type LockEntry = { packageName: string; repo: string; resolvedSha: string };

function devLockEntries(): LockEntry[] {
  return readJson("cinatra-dev-extensions.lock.json").packages as LockEntry[];
}

function requiredLockNames(): string[] {
  return (readJson("cinatra-required-extensions.lock.json").packages as LockEntry[]).map(
    (p) => p.packageName,
  );
}

function installedManifest(): Record<string, unknown> {
  return readJson(`extensions/cinatra-ai/podcast-artifacts/package.json`);
}

describe("the episode kind is registered in this application (#3093)", () => {
  it("declares the episode extension as a development extension on its own repository", () => {
    const devExtensions = hostManifest().devExtensions as Record<string, string>;
    expect(devExtensions[PACKAGE_NAME]).toBe(`https://github.com/${REPO_SLUG}.git`);
  });

  it("pins it at a commit in the development lock and leaves it out of the shipped set", () => {
    const pinned = devLockEntries().filter((p) => p.packageName === PACKAGE_NAME);
    expect(pinned).toHaveLength(1);
    expect(pinned[0].repo).toBe(REPO_SLUG);
    expect(pinned[0].resolvedSha).toMatch(/^[0-9a-f]{40}$/);

    // Placement: the episode kind is installed where the feed lister is, not
    // shipped with every instance. It therefore stays out of the required lock
    // and out of the two shipped-set lists that lock mirrors.
    expect(requiredLockNames()).not.toContain(PACKAGE_NAME);
    expect(hostManifest().systemExtensions as string[]).not.toContain(PACKAGE_NAME);
    const shipped = hostManifest().extensions as string[];
    expect(shipped.filter((s) => s.startsWith(`${PACKAGE_NAME}@`))).toEqual([]);
  });
});

describe("the installed episode package is complete (#3093 acceptance 1)", () => {
  it("claims exactly one dedicated artifact type of its own and accepts the episode's form", () => {
    const cinatra = installedManifest().cinatra as Record<string, unknown>;
    expect(cinatra.kind).toBe("artifact");

    const artifact = cinatra.artifact as Record<string, unknown>;
    // One type, the episode, claimed for this package's own family and
    // carrying its schema inline. The family convention lets a plural family
    // repository register under the family name rather than the package name
    // (the mail and the professional-network families both do), so the
    // namespace is asserted by family, not as one literal.
    const claims = artifact.objectTypes as Array<Record<string, unknown>>;
    expect(claims).toHaveLength(1);
    expect(claims[0].claim).toBe("dedicated");
    // The plan writes the id as the podcast FAMILY plus the episode kind
    // (`@cinatra-ai/podcast:episode`); the pinned package ships the
    // package-plus-artifact form instead, which is legal grammar but does not
    // name the episode. Both are named here as an EXACT two-member set: a
    // namespace-prefix match would also accept an unrelated
    // `@cinatra-ai/podcast-tools:item`, while pinning only the shipped form
    // would close the correction road before wave 6's typed produces entry
    // becomes the id's first consumer.
    expect([
      "@cinatra-ai/podcast:episode",
      "@cinatra-ai/podcast-artifacts:artifact",
    ]).toContain(String(claims[0].type));
    expect(claims[0].schema).toBeTypeOf("object");

    const accepts = artifact.accepts as { file?: { mimeTypes?: string[] } };
    expect(accepts.file?.mimeTypes).toContain(EPISODE_FORM);
  });

  it("draws one episode in both slots and publishes each through its own exports", () => {
    const manifest = installedManifest();
    const artifact = (manifest.cinatra as Record<string, unknown>).artifact as Record<string, unknown>;
    const ui = artifact.ui as Record<string, unknown>;
    expect(ui.abiVersion).toBe(1);

    const renderers = ui.renderers as Record<string, { entry: string; propsApiVersion: number; representations: string[] }>;
    expect(Object.keys(renderers).sort()).toEqual(["detail", "preview"]);

    const exportsMap = manifest.exports as Record<string, string>;
    for (const slot of ["detail", "preview"] as const) {
      const renderer = renderers[slot];
      expect(renderer.propsApiVersion).toBe(1);
      expect(renderer.representations).toContain(EPISODE_FORM);
      // The packaging rule: the display is reached through the package's own
      // `exports` key, never through a path into the package's source tree.
      const exportsKey = renderer.entry.replace(/\.(tsx|ts|jsx|js)$/, "");
      expect(Object.keys(exportsMap)).toContain(exportsKey);
    }
  });
});

describe("the host resolves the episode display (#3093 acceptance 1)", () => {
  const rendererSpecifiers = [
    `${PACKAGE_NAME}/src/renderers/detail`,
    `${PACKAGE_NAME}/src/renderers/preview`,
  ];

  it("carries both slots in the generated renderer map, behind the optional-import guard", () => {
    const generated = readText("src/lib/generated/artifact-renderers.ts");
    for (const slot of ["detail", "preview"]) {
      expect(generated).toContain(`"${PACKAGE_NAME}::${slot}"`);
    }
    // The package is outside the shipped set, so every one of its renderer
    // imports must go through the guard that degrades to the generic display
    // when the package is not present.
    for (const specifier of rendererSpecifiers) {
      expect(generated).toContain(`guardedExtensionImport("${specifier}"`);
    }
  });

  it("resolves each renderer specifier through a host-maintained alias", () => {
    // The build manifest is the source; the committed tsconfig is rendered
    // from it, and is read as text because it carries comments.
    const buildAliases = readJson("config/build-config.manifest.json").tsconfigPaths as Array<{
      alias: string;
      target: string;
    }>;
    const tsconfigText = readText("tsconfig.json");
    for (const specifier of rendererSpecifiers) {
      const target = `./extensions/cinatra-ai/podcast-artifacts/src/renderers/${specifier.split("/").pop()}.tsx`;
      expect(buildAliases.find((a) => a.alias === specifier)?.target).toBe(target);
      expect(tsconfigText).toContain(JSON.stringify(specifier));
    }
  });
});

describe("the datasets keep the default road (#3093 acceptance 2)", () => {
  // The recorded decision: neither the research agent's enriched rows nor the
  // scraper's items get a kind of their own — the rows' shape is the run's own
  // output schema, not a shape a kind can promise — so both stay with the
  // generic structured-data extension on the default road. What that means in
  // the code is that NEITHER agent declares a typed `produces` entry; the
  // moment one does, the decision has been reversed and this case says so.
  // The two agents the decision names are read directly rather than scanned
  // for by package name: a dataset kind registered under another name would
  // slip past a name scan, and a legitimate future package carrying the word
  // would trip it.
  const DATASET_AGENTS = ["web-research-agent", "web-scrape-agent"] as const;

  it.each(DATASET_AGENTS)("%s declares no produces entry of its own", (pkg) => {
    const manifest = readJson(`extensions/cinatra-ai/${pkg}/package.json`);
    const cinatra = manifest.cinatra as Record<string, unknown>;
    expect(cinatra.kind).toBe("agent");
    const agent = (cinatra.agent ?? {}) as Record<string, unknown>;
    expect(agent.produces ?? []).toEqual([]);
  });
});
