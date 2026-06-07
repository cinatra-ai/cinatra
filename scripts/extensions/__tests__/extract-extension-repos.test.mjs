import { describe, expect, it } from "vitest";
import {
  assertNoWorkspaceSpecs,
  planExtractionForPackage,
  planExtractionOrder,
  partitionDependencies,
  resolveLicense,
  shouldExtract,
  applyKindGate,
  kindGateSteps,
  isInsideGitWorkTree,
  assertNoDuplicateIdentifiers,
  resolveLicenseBody,
  LICENSE_BODY_TEMPLATES,
  buildNpmrc,
  packageDeclaresFirstParty,
  isFirstPartyDep,
  assertSourceImportsDeclared,
} from "../extract-extension-repos.mjs";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

describe("resolveLicenseBody (LICENSE-text fix — real SPDX bodies, override source)", () => {
  const LIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "extension-repo", "licenses");

  it("Apache-2.0 → Apache body template", () => {
    expect(resolveLicenseBody({ license: "Apache-2.0", name: "@cinatra-ai/openai-connector" })).toEqual({ templateFile: "Apache-2.0.txt" });
  });
  it("GPL-2.0-or-later → GPL body (generic SPDX→body mapping; no extension is GPL-forced today)", () => {
    expect(resolveLicenseBody({ license: "GPL-2.0-or-later", name: "@cinatra-ai/some-gpl-extension" })).toEqual({ templateFile: "GPL-2.0-or-later.txt" });
  });
  it("vendored third-party → preserve upstream (no override)", () => {
    expect(resolveLicenseBody({ license: "Apache-2.0", name: "@anthropics/skills", vendored: true })).toEqual({ vendored: true });
  });
  it("unsupported SPDX (not vendored) → FAILS CLOSED (never a placeholder)", () => {
    expect(() => resolveLicenseBody({ license: "MIT", name: "@cinatra-ai/x" })).toThrow(/no LICENSE body template for SPDX "MIT"/);
  });
  it("every supported SPDX has a real (non-placeholder) committed body template", () => {
    for (const spdx of LICENSE_BODY_TEMPLATES) {
      const p = join(LIC_DIR, `${spdx}.txt`);
      expect(existsSync(p), `${p} missing`).toBe(true);
      expect(readFileSync(p, "utf8")).not.toMatch(/LICENSE PLACEHOLDER/);
    }
    expect(readFileSync(join(LIC_DIR, "Apache-2.0.txt"), "utf8")).toMatch(/Apache License/);
    expect(readFileSync(join(LIC_DIR, "GPL-2.0-or-later.txt"), "utf8")).toMatch(/GNU GENERAL PUBLIC LICENSE/);
  });
});

describe("assertNoDuplicateIdentifiers (launch preflight, fail-closed)", () => {
  it("passes on distinct slugs + names", () => {
    expect(() =>
      assertNoDuplicateIdentifiers([
        { slug: "a-connector", name: "@cinatra-ai/a-connector" },
        { slug: "b-agent", name: "@cinatra-ai/b-agent" },
      ]),
    ).not.toThrow();
  });
  it("throws on a duplicate slug", () => {
    expect(() =>
      assertNoDuplicateIdentifiers([
        { slug: "dup", name: "@cinatra-ai/x" },
        { slug: "dup", name: "@cinatra-ai/y" },
      ]),
    ).toThrow(/duplicate slug "dup"/);
  });
  it("throws on a duplicate package name", () => {
    expect(() =>
      assertNoDuplicateIdentifiers([
        { slug: "x", name: "@cinatra-ai/dup" },
        { slug: "y", name: "@cinatra-ai/dup" },
      ]),
    ).toThrow(/duplicate package name "@cinatra-ai\/dup"/);
  });
  it("planExtractionOrder fails closed on duplicates", () => {
    expect(() =>
      planExtractionOrder({}, [
        { slug: "dup", name: "@cinatra-ai/x" },
        { slug: "dup", name: "@cinatra-ai/y" },
      ]),
    ).toThrow(/duplicate/);
  });
});

const TEMPLATE_CI = `jobs:
  build:
    steps:
      - name: Install dependencies
        run: corepack pnpm install --no-frozen-lockfile
  kind-gates:
    needs: build
    steps:
      - uses: actions/checkout@v4
      - name: No kind-specific gate
        run: echo "No kind-specific gate for this extension kind."
`;

describe("applyKindGate (CI kind-specific gate injection)", () => {
  it("injects the self-contained workflow gate for kind:workflow (replacing the placeholder)", () => {
    const out = applyKindGate(TEMPLATE_CI, "workflow");
    expect(out).not.toContain("No kind-specific gate");
    expect(out).toContain("node extension-kind-gate.mjs --package-root .");
  });

  it("injects the self-contained agent gate for kind:agent", () => {
    const out = applyKindGate(TEMPLATE_CI, "agent");
    expect(out).not.toContain("No kind-specific gate");
    expect(out).toContain("node extension-kind-gate.mjs --package-root .");
  });

  it("NEVER resolves the unpublished @cinatra-ai/extension-tools via pnpm dlx (404 hazard)", () => {
    // The retired form `corepack pnpm dlx @cinatra-ai/extension-tools …` failed
    // closed on a registry 404 for every public agent/workflow repo, since that
    // package does not exist on the registry. The gate must be plain-node + zero-dep.
    for (const kind of ["workflow", "agent"]) {
      const out = applyKindGate(TEMPLATE_CI, kind);
      expect(out).not.toContain("extension-tools");
      expect(out).not.toContain("pnpm dlx");
    }
  });

  it("leaves the placeholder for kinds with no extra gate", () => {
    for (const kind of ["connector", "artifact", "skill", undefined]) {
      expect(applyKindGate(TEMPLATE_CI, kind)).toBe(TEMPLATE_CI);
      expect(kindGateSteps(kind)).toBeNull();
    }
  });

  it("baseline template installs WITHOUT a frozen lockfile", () => {
    expect(TEMPLATE_CI).toContain("--no-frozen-lockfile");
    expect(TEMPLATE_CI).not.toContain("install --frozen-lockfile");
  });
});

describe("extracted-repo CI typecheck gate (regression: must not silently skip)", () => {
  // The real shipped template — read from disk so this test catches a
  // regression in the actual file, not a copy.
  const ciPath = new URL(
    "../templates/extension-repo/.github/workflows/ci.yml",
    import.meta.url,
  );

  it("does NOT use `pnpm run --if-present typecheck` (exits 0 when the script is absent → hollow gate)", async () => {
    const { readFileSync } = await import("node:fs");
    const ci = readFileSync(ciPath, "utf8");
    expect(ci).not.toMatch(/run\s+--if-present\s+typecheck/);
  });

  it("runs a real typecheck when there are TS sources (script → local tsc → ephemeral tsc), exactly one path", async () => {
    const { readFileSync } = await import("node:fs");
    const ci = readFileSync(ciPath, "utf8");
    // Branches on whether the package declares a typecheck script…
    expect(ci).toMatch(/scripts.*\.typecheck/);
    // …then on whether it depends on typescript…
    expect(ci).toMatch(/devDependencies/);
    expect(ci).toContain("pnpm exec tsc --noEmit");
    // …else an ephemeral tsc via npx (NOT pnpm dlx — that fails on typescript's
    // two bins, ERR_PNPM_DLX_MULTIPLE_BINS).
    expect(ci).toContain("npx -y -p typescript tsc --noEmit");
    expect(ci).not.toContain("pnpm dlx -p typescript");
    expect(ci).not.toMatch(/tsc --noEmit \|\| corepack pnpm dlx/);
  });

  it("skips typecheck ONLY when the repo tracks no TS at all (content-only extension) — not a hollow skip", async () => {
    const { readFileSync } = await import("node:fs");
    const ci = readFileSync(ciPath, "utf8");
    // Guard keys off tracked sources (git ls-files), not a swallowed command
    // exit code — so a repo WITH TypeScript can never silently skip. The pathspec
    // covers every TS extension, not just .ts/.tsx.
    expect(ci).toContain("git ls-files '*.ts' '*.tsx' '*.mts' '*.cts'");
    expect(ci).toMatch(/nothing to typecheck/i);
    // An explicit `typecheck` script is authoritative — it must be checked BEFORE
    // the no-source skip, so a repo declaring one can never be skipped.
    const scriptIdx = ci.indexOf(".typecheck?0:1");
    const skipIdx = ci.indexOf("git ls-files '*.ts'");
    expect(scriptIdx).toBeGreaterThan(-1);
    expect(skipIdx).toBeGreaterThan(scriptIdx);
  });
});

describe("assertSourceImportsDeclared (fail-closed: no undeclared first-party imports)", () => {
  const mkSrc = (importLine) => {
    const dir = mkdtempSync(join(tmpdir(), "extract-imp-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), `${importLine}\nexport const x = 1;\n`);
    return join(dir, "src");
  };

  it("THROWS when src imports an @cinatra-ai/* package the manifest doesn't declare", async () => {
    const src = mkSrc(`import type { T } from "@cinatra-ai/sdk-extensions";`);
    await expect(
      assertSourceImportsDeclared(src, { cinatra: {} }, "@cinatra-ai/foo-artifact"),
    ).rejects.toThrow(/not declared in package\.json: @cinatra-ai\/sdk-extensions/);
  });

  it("PASSES when the imported package is declared (any bucket — here devDependencies)", async () => {
    const src = mkSrc(`import type { T } from "@cinatra-ai/sdk-extensions";`);
    await expect(
      assertSourceImportsDeclared(
        src,
        { devDependencies: { "@cinatra-ai/sdk-extensions": "*" } },
        "@cinatra-ai/foo-artifact",
      ),
    ).resolves.toBeUndefined();
  });

  it("THROWS on an undeclared first-party SUBPATH import (resolves to the package name)", async () => {
    const src = mkSrc(`import type { T } from "@cinatra-ai/sdk-extensions/manifest";`);
    await expect(
      assertSourceImportsDeclared(src, { cinatra: {} }, "@cinatra-ai/foo-artifact"),
    ).rejects.toThrow(/@cinatra-ai\/sdk-extensions/);
  });

  it("PASSES when src imports no first-party packages at all (content-only / external-only)", async () => {
    const src = mkSrc(`import { z } from "zod";`);
    await expect(
      assertSourceImportsDeclared(src, { dependencies: { zod: "^3" } }, "@cinatra-ai/foo-agent"),
    ).resolves.toBeUndefined();
  });
});

describe("model B: host-internal @cinatra-ai/* packages stay in the monorepo (NOT registry artifacts)", () => {
  it("buildNpmrc: only auto-install-peers=false — NO registry scope, NO auth token", () => {
    const npmrc = buildNpmrc();
    expect(npmrc).toContain("auto-install-peers=false");
    // Host-internal packages are not registry artifacts today, so the .npmrc must
    // NOT scope @cinatra-ai to a registry or carry a (now-useless) auth token.
    expect(npmrc).not.toContain("@cinatra-ai:registry");
    expect(npmrc).not.toContain("_authToken");
    expect(npmrc).not.toContain("always-auth");
    expect(npmrc).not.toContain("CINATRA_REGISTRY_TOKEN");
  });

  it("isFirstPartyDep: matches @cinatra-ai/* and @cinatra/*, not external", () => {
    expect(isFirstPartyDep("@cinatra-ai/sdk-extensions")).toBe(true);
    expect(isFirstPartyDep("@cinatra/foo")).toBe(true);
    expect(isFirstPartyDep("zod")).toBe(false);
    expect(isFirstPartyDep("@types/node")).toBe(false);
  });

  it("packageDeclaresFirstParty: TRUE when an @cinatra-ai/* dep is present (deps/peers/dev/optional)", () => {
    expect(packageDeclaresFirstParty({ peerDependencies: { "@cinatra-ai/sdk-extensions": "*" } })).toBe(true);
    expect(packageDeclaresFirstParty({ dependencies: { "@cinatra-ai/sdk-ui": "1.0.0" } })).toBe(true);
    expect(packageDeclaresFirstParty({ devDependencies: { "@cinatra/foo": "*" } })).toBe(true);
  });

  it("packageDeclaresFirstParty: FALSE for a genuinely standalone package (only external deps)", () => {
    expect(packageDeclaresFirstParty({ dependencies: { zod: "^3", lodash: "*" } })).toBe(false);
    expect(packageDeclaresFirstParty({})).toBe(false);
    expect(packageDeclaresFirstParty(null)).toBe(false);
  });

  it("planner reclassifies first-party dependencies into optional peers (never a normal/dev dep)", () => {
    const plan = planExtractionForPackage({
      name: "@cinatra-ai/some-connector",
      version: "0.1.0",
      cinatra: { kind: "connector" },
      dependencies: { "@cinatra-ai/sdk-extensions": "workspace:*", zod: "^3" },
      devDependencies: { "@cinatra-ai/sdk-ui": "workspace:*", typescript: "^6" },
    });
    const pj = plan.packageJson;
    // first-party deps -> peers "*"; external deps stay where they are
    expect(pj.peerDependencies["@cinatra-ai/sdk-extensions"]).toBe("*");
    expect(pj.peerDependencies["@cinatra-ai/sdk-ui"]).toBe("*");
    expect(pj.dependencies).toEqual({ zod: "^3" });
    expect(pj.devDependencies).toEqual({ typescript: "^6" });
    expect(pj.dependencies["@cinatra-ai/sdk-extensions"]).toBeUndefined();
    expect(pj.devDependencies["@cinatra-ai/sdk-ui"]).toBeUndefined();
    // every first-party peer is marked optional (quiet standalone install/pack)
    expect(pj.peerDependenciesMeta["@cinatra-ai/sdk-extensions"]).toEqual({ optional: true });
    expect(pj.peerDependenciesMeta["@cinatra-ai/sdk-ui"]).toEqual({ optional: true });
  });

  it("the per-repo CI workflow carries NO registry token and skips standalone typecheck/test for first-party repos", async () => {
    const { readFileSync } = await import("node:fs");
    const ci = readFileSync(
      new URL("../templates/extension-repo/.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    // The registry-auth .npmrc model is gone (host-internal packages aren't
    // registry artifacts), so the build job no longer carries a registry token.
    expect(ci).not.toContain("CINATRA_REGISTRY_TOKEN");
    // The build job classifies the repo and, for source mirrors (host-internal
    // @cinatra-ai/* peers), skips install + typecheck + test — keeping only the
    // packaging gate. Standalone repos run the full pipeline.
    expect(ci).toContain("first_party=1");
    expect(ci).toContain("Skipping standalone install");
    expect(ci).toContain("Skipping standalone typecheck");
    expect(ci).toContain("Skipping standalone tests");
    expect(ci).toContain("npm pack --dry-run");
    // The skip is HONEST: a first-party package leaked into deps/devDeps (or a
    // first-party peer missing optional meta) fails the classify gate (exit 2).
    expect(ci).toContain("must be OPTIONAL peerDependencies");
    expect(ci).toContain("peerDependenciesMeta.optional");
    expect(ci).toContain("dependency-shape regression");
  });
});

describe("marketplace release pipeline templates", () => {
  const read = async (rel) => {
    const { readFileSync } = await import("node:fs");
    return readFileSync(new URL(rel, import.meta.url), "utf8");
  };

  it("the per-repo caller is a thin release: published → reusable-workflow call (no inline publish)", async () => {
    const yml = await read("../templates/extension-repo/.github/workflows/release.yml");
    expect(yml).toMatch(/release:\s*\n\s*types:\s*\[published\]/);
    expect(yml).toContain("uses: cinatra-ai/.github/.github/workflows/reusable-extension-release.yml@main");
    expect(yml).toContain("secrets: inherit");
    expect(yml).toContain("id-token: write"); // provenance permissions granted to the called workflow
    // It must NOT itself publish (thin caller only).
    expect(yml).not.toContain("pnpm publish");
    expect(yml).not.toContain("npm publish");
  });

  it("the reusable workflow is workflow_call, submits via the marketplace proxy, and NEVER publishes directly to Verdaccio", async () => {
    const yml = await read("../templates/release/reusable-extension-release.yml");
    expect(yml).toContain("workflow_call");
    expect(yml).toContain("CINATRA_MARKETPLACE_VENDOR_TOKEN");
    expect(yml).toContain("release-submit.mjs"); // submit through the proxy tool
    expect(yml).toContain("attest-build-provenance"); // build provenance
    // The hard rule: no direct Verdaccio publish anywhere in the pipeline.
    expect(yml).not.toMatch(/pnpm publish|npm publish|VERDACCIO_PUBLISH_TOKEN/);
    // tag==version gate + pre-release skip.
    expect(yml).toContain('"v${VERSION}"');
    expect(yml).toContain("should_publish");
  });

  it("the shared submit tool calls extension-submit-for-review (proxy), not a registry publish", async () => {
    const mjs = await read("../templates/release/release-submit.mjs");
    // Marketplace MCP tool names flatten the namespace `/` to `-`:
    // the deployed tool is `cinatra-extension-submit-for-review`.
    expect(mjs).toContain("cinatra-extension-submit-for-review");
    expect(mjs).toContain("CINATRA_MARKETPLACE_VENDOR_TOKEN");
    expect(mjs).not.toMatch(/pnpm publish|npm publish/);
  });
});

describe("isInsideGitWorkTree (--push safety guard)", () => {
  it("returns true when git reports inside a work tree", async () => {
    const exec = async () => ({ stdout: "true\n" });
    expect(await isInsideGitWorkTree("/some/dir", exec)).toBe(true);
  });
  it("returns false when git reports not-a-work-tree (false) or errors", async () => {
    expect(await isInsideGitWorkTree("/x", async () => ({ stdout: "false\n" }))).toBe(false);
    expect(
      await isInsideGitWorkTree("/x", async () => {
        throw new Error("fatal: not a git repository");
      }),
    ).toBe(false);
  });
});

// A representative Apache-default agent with workspace + external deps.
const apacheAgentPkg = {
  name: "@cinatra-ai/scrape-agent",
  version: "1.2.3",
  description: "Scrapes things.",
  type: "module",
  license: "Apache-2.0",
  dependencies: {
    "@cinatra-ai/sdk-extensions": "workspace:*",
    "@cinatra-ai/shared-utils": "workspace:*",
    cheerio: "^1.2.0",
  },
  peerDependencies: {
    react: "^19.0.0",
  },
  devDependencies: {
    vitest: "^2.0.0",
    "@cinatra-ai/test-helpers": "workspace:*",
  },
  cinatra: {
    kind: "agent",
    serverEntry: "src/server.ts",
    sdkAbiRange: "^1.0.0",
    requestedHostPorts: ["llm", "db"],
    dependencies: [],
  },
};

// wordpress-agent / drupal-agent are NOT GPL-forced: they integrate with GPL
// CMSes over their HTTP/MCP APIs but are not derivative works of GPL code, so
// they carry the cinatra-ai default (Apache-2.0), matching their source LICENSE.
const wpAgentPkg = {
  name: "@cinatra-ai/wordpress-agent",
  version: "0.9.0",
  license: "Apache-2.0",
  dependencies: {
    "@cinatra-ai/sdk-extensions": "workspace:*",
  },
  cinatra: { kind: "agent" },
};

describe("partitionDependencies", () => {
  it("splits workspace:* from external deps", () => {
    const { workspaceDeps, externalDeps } = partitionDependencies(
      apacheAgentPkg.dependencies,
    );
    expect(workspaceDeps).toEqual({
      "@cinatra-ai/sdk-extensions": "*",
      "@cinatra-ai/shared-utils": "*",
    });
    expect(externalDeps).toEqual({ cheerio: "^1.2.0" });
  });
});

describe("planExtractionForPackage", () => {
  const plan = planExtractionForPackage(apacheAgentPkg);

  it("(a) leaves NO workspace:* anywhere in the emitted package.json", () => {
    const json = JSON.stringify(plan.packageJson);
    expect(json).not.toContain("workspace:");
    // and the explicit invariant check does not throw
    expect(() => assertNoWorkspaceSpecs(plan.packageJson)).not.toThrow();
  });

  it("converts workspace deps into peerDependencies \"*\" and reclassifies ALL first-party deps as optional peers (model B)", () => {
    expect(plan.packageJson.peerDependencies).toMatchObject({
      "@cinatra-ai/sdk-extensions": "*",
      "@cinatra-ai/shared-utils": "*",
      react: "^19.0.0",
      // model B: a first-party DEV dep is also reclassified into peers (host
      // provides it; never installed/typechecked standalone).
      "@cinatra-ai/test-helpers": "*",
    });
    // external dep stays in dependencies, verbatim
    expect(plan.packageJson.dependencies).toEqual({ cheerio: "^1.2.0" });
    // first-party devDep moved OUT of devDependencies; the external devDep stays
    expect(plan.packageJson.devDependencies["@cinatra-ai/test-helpers"]).toBeUndefined();
    expect(plan.packageJson.devDependencies).toEqual({ vitest: "^2.0.0" });
    // every first-party peer is marked optional; react (external peer) is not
    expect(plan.packageJson.peerDependenciesMeta).toMatchObject({
      "@cinatra-ai/sdk-extensions": { optional: true },
      "@cinatra-ai/shared-utils": { optional: true },
      "@cinatra-ai/test-helpers": { optional: true },
    });
    expect(plan.packageJson.peerDependenciesMeta.react).toBeUndefined();
    expect(plan.workspaceDepsConverted.sort()).toEqual([
      "@cinatra-ai/sdk-extensions",
      "@cinatra-ai/shared-utils",
    ]);
  });

  it("(b) preserves the cinatra block verbatim", () => {
    expect(plan.packageJson.cinatra).toEqual(apacheAgentPkg.cinatra);
    expect(plan.kind).toBe("agent");
  });

  it("(c) license mapping: Apache for all agents, incl. wordpress/drupal (NO GPL override)", () => {
    expect(plan.license).toBe("Apache-2.0");
    expect(plan.packageJson.license).toBe("Apache-2.0");

    // Regression guard: wordpress-agent (and drupal-agent) are Apache-2.0, not GPL.
    const wpPlan = planExtractionForPackage(wpAgentPkg);
    expect(wpPlan.license).toBe("Apache-2.0");
    expect(wpPlan.packageJson.license).toBe("Apache-2.0");
  });

  it("defaults to Apache-2.0 when source has no license", () => {
    const noLicense = planExtractionForPackage({
      name: "@cinatra-ai/foo-skill",
      cinatra: { kind: "skill" },
    });
    expect(noLicense.license).toBe("Apache-2.0");
  });

  it("throws if a workspace spec would leak through", () => {
    expect(() =>
      assertNoWorkspaceSpecs({ dependencies: { x: "workspace:*" } }),
    ).toThrow(/workspace protocol leaked/);
  });
});

describe("resolveLicense", () => {
  it("does NOT force GPL on wordpress-agent / drupal-agent (they follow source like any agent)", () => {
    // Regression guard for the license correction: these are Apache-2.0, not GPL.
    expect(
      resolveLicense({ name: "@cinatra-ai/wordpress-agent", sourceLicense: "Apache-2.0" }),
    ).toBe("Apache-2.0");
    expect(
      resolveLicense({ name: "@cinatra-ai/drupal-agent", sourceLicense: "Apache-2.0" }),
    ).toBe("Apache-2.0");
    // No slug is GPL-forced now → source license wins.
    expect(
      resolveLicense({ name: "@cinatra-ai/wordpress-agent", sourceLicense: "MIT" }),
    ).toBe("MIT");
  });
  it("keeps source license for non-GPL, defaults otherwise", () => {
    expect(resolveLicense({ name: "@x/y", sourceLicense: "MIT" })).toBe("MIT");
    expect(resolveLicense({ name: "@x/y" })).toBe("Apache-2.0");
  });
});

describe("shouldExtract / carve-outs (d)", () => {
  it("INCLUDES anthropic-connector (un-exempt — extractable like every connector)", () => {
    expect(
      shouldExtract({
        name: "@cinatra-ai/anthropic-connector",
        slug: "anthropic-connector",
        extensionRelPath: "cinatra-ai/anthropic-connector",
      }),
    ).toBe(true);
  });

  it("includes ordinary extensions", () => {
    expect(
      shouldExtract({
        name: "@cinatra-ai/scrape-agent",
        slug: "scrape-agent",
        extensionRelPath: "cinatra-ai/scrape-agent",
      }),
    ).toBe(true);
  });
});

describe("planExtractionOrder", () => {
  const entries = [
    {
      name: "@cinatra-ai/scrape-agent",
      slug: "scrape-agent",
      extensionRelPath: "cinatra-ai/scrape-agent",
    },
    {
      name: "@cinatra-ai/anthropic-connector",
      slug: "anthropic-connector",
      extensionRelPath: "cinatra-ai/anthropic-connector",
    },
    {
      name: "@cinatra-ai/blog-workflow",
      slug: "blog-workflow",
      extensionRelPath: "cinatra-ai/blog-workflow",
    },
  ];

  it("honors graph order", () => {
    const graph = {
      extractionOrder: [
        "@cinatra-ai/blog-workflow",
        "@cinatra-ai/anthropic-connector",
        "@cinatra-ai/scrape-agent",
      ],
    };
    const ordered = planExtractionOrder(graph, entries);
    expect(ordered.map((e) => e.slug)).toEqual([
      "blog-workflow",
      // anthropic-connector is extractable (un-exempt).
      "anthropic-connector",
      "scrape-agent",
    ]);
  });

  it("respects --only subset", () => {
    const graph = { order: ["@cinatra-ai/scrape-agent", "@cinatra-ai/blog-workflow"] };
    const ordered = planExtractionOrder(graph, entries, new Set(["blog-workflow"]));
    expect(ordered.map((e) => e.slug)).toEqual(["blog-workflow"]);
  });

  it("appends discovered entries missing from the graph", () => {
    const ordered = planExtractionOrder({}, entries);
    // anthropic-connector is un-exempt; all three in slug-sorted order.
    expect(ordered.map((e) => e.slug).sort()).toEqual([
      "anthropic-connector",
      "blog-workflow",
      "scrape-agent",
    ]);
  });
});
