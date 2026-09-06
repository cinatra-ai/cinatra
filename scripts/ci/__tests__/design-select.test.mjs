// THE DESIGN SUITE SELECTOR (the owner's ruling: "It should check only the
// specific design spec of what was implemented. Also, it should not run at all
// on lanes that don't implement or change any of the UI.").
//
// Runs in the root Vitest suite like its siblings under scripts/ci/__tests__ —
// that glob is in the root include, so a failure here reds a required check.
// The SELECTOR ITSELF stays dependency-free (node builtins only); only this
// suite needs vitest.
//
// Organised by the acceptance items the ruling implies:
//
//   1. NO UI  — a diff that touches no UI file skips Playwright entirely.
//   2. NARROW — a fixture page / a suite helper selects the families that
//               render it, and nothing else.
//   3. WIDEN  — a shared primitive, a workspace-package source file, a global
//               style/token, a dependency, a pinned manifest and the selector
//               itself all select EVERY family (the suite as it runs today).
//   4. FAIL OPEN — main, an unresolvable diff base, a git failure, an
//               unresolvable in-repo import and the DESIGN_SELECT=all override
//               all select EVERY family. A false negative (a family the diff
//               really touches, skipped) is the only unacceptable error, so
//               every uncertainty widens.
//
// The graph walk is exercised over a VIRTUAL file map (no temp dirs, no git):
// the selector takes its IO injected for exactly this reason.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { REPO_ROOT } from "../design-select.mjs";

const TSCONFIG_PATH = join(REPO_ROOT, "tsconfig.json");

import {
  WIDENING_RULES,
  aliasesFor,
  buildFamilies,
  discoverSpecFiles,
  main,
  parsePlan,
  playwrightArgs,
  resolveChangedFiles,
  routeFiles,
  stripJsonc,
  selectFamilies,
  wideningRuleFor,
} from "../design-select.mjs";

// Every virtual repo carries a tsconfig, because the selector READS its aliases
// there rather than assuming them — an unreadable tsconfig widens to the whole
// suite (the convergence round: packages/*/src modules import "@/..." back into
// src/, so a workspace alias treated as external hides a real edge).
const TSCONFIG_JSON = JSON.stringify({
  compilerOptions: {
    paths: {
      "@/*": ["./src/*"],
      "@cinatra-ai/agents": ["./packages/agents/src/index.ts"],
      "@cinatra-ai/agents/*": ["./packages/agents/src/*"],
    },
  },
});

/** A virtual repo: repo-relative path -> file text. */
const makeIo = (files) => {
  const all = Object.hasOwn(files, "tsconfig.json")
    ? files
    : { ...files, "tsconfig.json": TSCONFIG_JSON };
  return {
    read: (rel) => (Object.hasOwn(all, rel) ? all[rel] : null),
    exists: (rel) => Object.hasOwn(all, rel),
    list: (rel) => {
      const children = new Map();
      for (const path of Object.keys(all)) {
        if (!path.startsWith(`${rel}/`)) continue;
        const rest = path.slice(rel.length + 1);
        const slash = rest.indexOf("/");
        const name = slash === -1 ? rest : rest.slice(0, slash);
        if (!children.has(name) || slash !== -1) children.set(name, slash !== -1);
      }
      return [...children].map(([name, directory]) => ({ name, directory }));
    },
  };
};

// Three fixture routes, three specs. `widget` is mounted by TWO of them, so a
// change to it must select exactly those two.
const REPO = {
  "tests/e2e/design/alpha.spec.ts": `
    import { test } from "@playwright/test";
    const FIXTURE_PATH = "/design-fixtures/alpha";
    test("alpha", async ({ page }) => { await page.goto(FIXTURE_PATH); });
  `,
  "tests/e2e/design/beta.spec.ts": `
    import { test } from "@playwright/test";
    const FIXTURE_PATH = "/design-fixtures/beta";
    test("beta", async ({ page }) => { await page.goto(FIXTURE_PATH); });
  `,
  "tests/e2e/design/conformance/gamma.spec.ts": `
    import { test } from "@playwright/test";
    import { HARNESS_PATH } from "./contract";
    test("gamma", async ({ page }) => { await page.goto(HARNESS_PATH); });
  `,
  "tests/e2e/design/conformance/contract.ts": `
    export const HARNESS_PATH = "/design-fixtures/gamma";
  `,
  "src/app/design-fixtures/alpha/page.tsx": `
    import { Widget } from "@/lib/widget";
    export default function Page() { return <Widget />; }
  `,
  "src/app/design-fixtures/beta/page.tsx": `
    import { Widget } from "../../../lib/widget";
    export default function Page() { return <Widget />; }
  `,
  "src/app/design-fixtures/gamma/page.tsx": `
    import { Other } from "@/lib/other";
    export default function Page() { return <Other />; }
  `,
  "src/lib/widget.tsx": "export const Widget = () => null;",
  "src/lib/other.tsx": "export const Other = () => null;",
};

const SPECS = [
  "tests/e2e/design/alpha.spec.ts",
  "tests/e2e/design/beta.spec.ts",
  "tests/e2e/design/conformance/gamma.spec.ts",
];

const build = (files = REPO) => buildFamilies({ specFiles: SPECS, io: makeIo(files) });

const select = (changedFiles, files = REPO) =>
  selectFamilies({ changedFiles, ...build(files) });

const selectWith = (specFiles, files, changedFiles) =>
  selectFamilies({ changedFiles, ...buildFamilies({ specFiles, io: makeIo(files) }) });

describe("1. NO UI — nothing to check, nothing runs", () => {
  it("skips Playwright when the diff touches no UI file", () => {
    const result = select(["README.md", "scripts/ci/unrelated.mjs", "docs/a.md"]);
    expect(result.mode).toBe("none");
    expect(result.specs).toEqual([]);
    expect(result.summary).toBe("design suite: no UI change in 3 files — skipped");
  });

  it("skips when the changed UI files are rendered by no design family", () => {
    const result = select(["src/app/settings/billing/page.tsx"]);
    expect(result.mode).toBe("none");
    expect(result.specs).toEqual([]);
    expect(result.summary).toMatch(/no design family renders/);
  });
});

describe("2. NARROW — only the families the change can affect", () => {
  it("selects one family for its own fixture page", () => {
    const result = select(["src/app/design-fixtures/alpha/page.tsx"]);
    expect(result.mode).toBe("subset");
    expect(result.specs).toEqual(["tests/e2e/design/alpha.spec.ts"]);
  });

  it("selects one family for its own spec file", () => {
    const result = select(["tests/e2e/design/beta.spec.ts"]);
    expect(result.specs).toEqual(["tests/e2e/design/beta.spec.ts"]);
  });

  it("selects the conformance family for a change to its driver contract", () => {
    const result = select(["tests/e2e/design/conformance/contract.ts"]);
    expect(result.specs).toEqual(["tests/e2e/design/conformance/gamma.spec.ts"]);
  });

  it("selects EXACTLY the two families that mount a shared product module", () => {
    const result = select(["src/lib/widget.tsx"]);
    expect(result.mode).toBe("subset");
    expect(result.specs).toEqual([
      "tests/e2e/design/alpha.spec.ts",
      "tests/e2e/design/beta.spec.ts",
    ]);
  });

  it("names the changed file that pulled each family in", () => {
    const result = select(["src/lib/widget.tsx"]);
    expect(result.reasons).toEqual([
      { family: "tests/e2e/design/alpha.spec.ts", because: "src/lib/widget.tsx" },
      { family: "tests/e2e/design/beta.spec.ts", because: "src/lib/widget.tsx" },
    ]);
  });
});

describe("2b. NARROW — edges the graph only sees as a URL or a directory", () => {
  const withEndpoint = {
    ...REPO,
    "tests/e2e/design/conformance/contract.ts": `
      export const HARNESS_PATH = "/design-fixtures/gamma";
      export const SEED_ENDPOINT = "/design-fixtures/gamma/seed";
    `,
    "src/app/design-fixtures/gamma/seed/route.ts": "export async function POST() {}",
    "tests/e2e/design/conformance/render-parity/parity.spec.ts": `
      import { test } from "@playwright/test";
      test("parity", () => {});
    `,
    "tests/e2e/design/conformance/render-parity/fixtures/content/doc.md": "# corpus",
  };
  const specs = [...SPECS, "tests/e2e/design/conformance/render-parity/parity.spec.ts"];
  const localSelect = (changedFiles) => selectWith(specs, withEndpoint, changedFiles);

  it("selects the family whose harness POSTs to a changed route handler", () => {
    const result = localSelect(["src/app/design-fixtures/gamma/seed/route.ts"]);
    expect(result.specs).toEqual(["tests/e2e/design/conformance/gamma.spec.ts"]);
  });

  it("selects the specs below a changed corpus file the suite reads at runtime", () => {
    const result = localSelect([
      "tests/e2e/design/conformance/render-parity/fixtures/content/doc.md",
    ]);
    expect(result.specs).toEqual([
      "tests/e2e/design/conformance/render-parity/parity.spec.ts",
    ]);
  });

  it("widens when a fixture-route file is reachable from no family", () => {
    const result = localSelect(["src/app/design-fixtures/orphan/helper.tsx"]);
    expect(result.mode).toBe("all");
    expect(result.summary).toMatch(/no family imports/);
  });

  it("widens when a suite file has no spec below it and no family imports it", () => {
    const result = localSelect(["tests/e2e/design/__screenshots__/shell-light.png"]);
    expect(result.mode).toBe("all");
  });
});

describe("3. WIDEN — a global change still runs the whole suite", () => {
  const widening = [
    ["a shared primitive", "src/components/ui/button.tsx"],
    ["a workspace package source file", "packages/design/src/tokens.css"],
    ["a global stylesheet", "src/app/globals.css"],
    ["a dependency change", "pnpm-lock.yaml"],
    ["the package manifest", "package.json"],
    ["a pinned conformance manifest", "tests/e2e/design/conformance/manifests/marketplace.json"],
    ["the suite config", "tests/e2e/config/design.config.ts"],
    ["an app layout", "src/app/layout.tsx"],
    ["the generated extension manifest", "src/lib/generated/extensions.server.ts"],
    ["the selector itself", "scripts/ci/design-select.mjs"],
    ["the selector's own unit suite", "scripts/ci/__tests__/design-select.test.mjs"],
    ["the workflow that runs the suite", ".github/workflows/design-visual-verify.yml"],
  ];

  for (const [label, file] of widening) {
    it(`runs every family for ${label}`, () => {
      const result = select([file]);
      expect(result.mode).toBe("all");
      expect(result.specs).toEqual(SPECS);
      expect(result.summary).toContain(file);
    });
  }
});

describe("4. FAIL OPEN — every uncertainty runs the whole suite", () => {
  it("runs every family when an in-repo import does not resolve", () => {
    const broken = {
      ...REPO,
      "src/app/design-fixtures/alpha/page.tsx": `import { Gone } from "./gone";`,
    };
    const result = select(["src/lib/widget.tsx"], broken);
    expect(result.mode).toBe("all");
    expect(result.summary).toMatch(/could not be resolved/);
  });

  it("widens even a documentation-only diff when the graph is not trustworthy", () => {
    // An edge whose target is unknown could have gone anywhere, including a
    // file this list would otherwise call source-free, so nothing is judged
    // against a graph the walk could not finish.
    const broken = {
      ...REPO,
      "src/app/design-fixtures/alpha/page.tsx": `import { Gone } from "./gone";`,
    };
    const result = select(["README.md", "docs/a.md"], broken);
    expect(result.mode).toBe("all");
  });

  it("reads an import inside a comment as prose, not as an edge", () => {
    const commented = {
      ...REPO,
      "src/app/design-fixtures/alpha/page.tsx": `
        /* The emission site below is a LITERAL () => import("...") on purpose. */
        // import { Ghost } from "./ghost";
        import { Widget } from "@/lib/widget";
      `,
    };
    const result = select(["src/lib/widget.tsx"], commented);
    expect(result.mode).toBe("subset");
    expect(result.specs).toEqual([
      "tests/e2e/design/alpha.spec.ts",
      "tests/e2e/design/beta.spec.ts",
    ]);
  });

  it("runs every family on the DESIGN_SELECT=all override", () => {
    const diff = resolveChangedFiles({ env: { DESIGN_SELECT: "all" }, git: () => "" });
    expect(diff.mode).toBe("all");
    expect(diff.reason).toMatch(/DESIGN_SELECT=all/);
  });

  it("runs every family on a golden refresh run", () => {
    const diff = resolveChangedFiles({ env: { RENDER_PARITY_UPDATE: "1" }, git: () => "" });
    expect(diff.mode).toBe("all");
    expect(diff.reason).toMatch(/refresh/);
  });

  it("runs every family on main", () => {
    const diff = resolveChangedFiles({
      env: { CI: "true", GITHUB_REF_NAME: "main", GITHUB_EVENT_NAME: "push" },
      git: () => "",
    });
    expect(diff.mode).toBe("all");
    expect(diff.reason).toMatch(/main/);
  });

  it("runs every family when the diff base does not resolve", () => {
    const diff = resolveChangedFiles({
      env: {
        CI: "true",
        GITHUB_REF_NAME: "feature",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_BASE_REF: "main",
        DESIGN_SELECT_DIFF_BASE: "origin/nope",
      },
      git: (args) => {
        if (args[0] === "rev-parse" || args[0] === "fetch") throw new Error("no such revision");
        return "";
      },
    });
    expect(diff.mode).toBe("all");
    expect(diff.reason).toMatch(/does not resolve/);
  });

  it("runs every family when git itself fails", () => {
    const diff = resolveChangedFiles({
      env: { CI: "true", GITHUB_REF_NAME: "feature", GITHUB_EVENT_NAME: "pull_request" },
      git: () => {
        throw new Error("not a git repository");
      },
    });
    expect(diff.mode).toBe("all");
  });

  it("diffs against the merge base with the target branch on a pull request", () => {
    const calls = [];
    const diff = resolveChangedFiles({
      env: {
        CI: "true",
        GITHUB_REF_NAME: "feature",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_BASE_REF: "main",
      },
      git: (args) => {
        calls.push(args.join(" "));
        if (args[0] === "merge-base") return "abc123\n";
        if (args[0] === "diff") return "src/app/design-fixtures/alpha/page.tsx\nREADME.md\n";
        return "";
      },
    });
    expect(diff.mode).toBe("diff");
    expect(diff.files).toEqual(["src/app/design-fixtures/alpha/page.tsx", "README.md"]);
    expect(calls).toContain("merge-base origin/main HEAD");
    expect(calls).toContain("diff --name-only abc123 HEAD");
  });
});

describe("5. THE INVOCATION and THIS repo", () => {
  it("passes the selected spec files to Playwright, and no filter for the whole suite", () => {
    const { families } = build();
    const subset = selectFamilies({ changedFiles: ["src/lib/widget.tsx"], families });
    expect(playwrightArgs(subset)).toEqual([
      "test",
      "-c",
      "tests/e2e/config/design.config.ts",
      "tests/e2e/design/alpha.spec.ts",
      "tests/e2e/design/beta.spec.ts",
    ]);
    const whole = selectFamilies({ changedFiles: ["package.json"], families });
    expect(playwrightArgs(whole)).toEqual(["test", "-c", "tests/e2e/config/design.config.ts"]);
  });

  it("finds every design spec in THIS repo as its own family", () => {
    const specs = discoverSpecFiles();
    expect(specs.length).toBeGreaterThan(9);
    expect(specs.every((spec) => spec.endsWith(".spec.ts"))).toBe(true);
    expect(specs).toContain("tests/e2e/design/conformance/functional-acceptance.spec.ts");
    expect(specs).toContain("tests/e2e/design/design-fixtures.spec.ts");
  });

  it("resolves every in-repo import of THIS repo's families", () => {
    // The guard that keeps the feature alive: one unresolvable import anywhere
    // in a family's graph fails the whole selection open to the full suite, so
    // a drift that breaks resolution must red HERE, not silently un-narrow CI.
    const { unresolved } = buildFamilies({ specFiles: discoverSpecFiles() });
    expect(unresolved).toEqual([]);
  });

  it("narrows THIS repo to the families that mount a changed fixture page", () => {
    const { families, unresolved } = buildFamilies({ specFiles: discoverSpecFiles() });
    const result = selectFamilies({
      changedFiles: ["src/app/design-fixtures/agents-card/page.tsx"],
      families,
      unresolved,
    });
    expect(result.mode).toBe("subset");
    expect(result.specs).toEqual(["tests/e2e/design/agents-card-accent.spec.ts"]);
  });

  // The workflow file IS the gate: it decides whether the suite runs at all,
  // which families it runs, and on what boot. A change to it must therefore be
  // proved by the WHOLE suite — a narrowed (or skipped) run would let the file
  // that governs the selection certify its own selection.
  it("runs THIS repo's WHOLE suite for a workflow-only change", () => {
    const { families, unresolved } = buildFamilies({ specFiles: discoverSpecFiles() });
    const result = selectFamilies({
      changedFiles: [".github/workflows/design-visual-verify.yml", "README.md"],
      families,
      unresolved,
    });
    expect(result.mode).toBe("all");
    expect(result.summary).toContain(".github/workflows/design-visual-verify.yml");
  });

  it("runs THIS repo's WHOLE suite for a change to the selector's own unit suite", () => {
    const { families, unresolved } = buildFamilies({ specFiles: discoverSpecFiles() });
    const result = selectFamilies({
      changedFiles: ["scripts/ci/__tests__/design-select.test.mjs"],
      families,
      unresolved,
    });
    expect(result.mode).toBe("all");
    expect(result.summary).toContain("scripts/ci/__tests__/design-select.test.mjs");
  });

  // The intentional no-impact diff, judged against THIS repo's REAL graph
  // rather than the virtual one: a docs-only change reaches no family and
  // starts no Playwright, so the install/build/boot is never paid.
  it("skips THIS repo's suite entirely for an intentional no-impact diff", () => {
    const { families, unresolved } = buildFamilies({ specFiles: discoverSpecFiles() });
    const result = selectFamilies({
      changedFiles: ["README.md", "docs/internals/contracts/design-conformance-pin-drift.md"],
      families,
      unresolved,
    });
    expect(result.mode).toBe("none");
    expect(result.specs).toEqual([]);
    expect(result.summary).toContain("no UI change");
  });
});

describe("6. THE WALK'S OWN HOLES (the convergence round)", () => {
  it("keeps an import a naive comment stripper would have eaten", () => {
    // The stripper is a regex: a string containing a block-comment opener can
    // make it swallow the real import that follows. The scan reads the original
    // source too, so the edge survives.
    const tricky = {
      ...REPO,
      "src/app/design-fixtures/alpha/page.tsx": `
        const OPENER = "/*";
        import { Widget } from "@/lib/widget";
        const CLOSER = "*/";
      `,
    };
    const result = select(["src/lib/widget.tsx"], tricky);
    expect(result.specs).toContain("tests/e2e/design/alpha.spec.ts");
  });

  it("finds the specifier of an import statement hundreds of characters long", () => {
    const names = Array.from({ length: 120 }, (_, i) => `  NAME_${i},`).join("\n");
    const long = {
      ...REPO,
      "src/app/design-fixtures/alpha/page.tsx": `import {\n${names}\n} from "@/lib/widget";`,
    };
    const result = select(["src/lib/widget.tsx"], long);
    expect(result.specs).toContain("tests/e2e/design/alpha.spec.ts");
  });

  it("selects the family that calls a TEMPLATE api route for its dynamic handler", () => {
    const files = {
      ...REPO,
      "tests/e2e/design/alpha.spec.ts": `
        import { test } from "@playwright/test";
        const FIXTURE_PATH = "/design-fixtures/alpha";
        const item = (id) => \`/api/things/\${id}\`;
        test("alpha", async ({ page }) => { await page.goto(FIXTURE_PATH); });
      `,
      "src/app/api/things/[id]/route.ts": "export async function GET() {}",
    };
    const result = selectWith(SPECS, files, ["src/app/api/things/[id]/route.ts"]);
    expect(result.specs).toEqual(["tests/e2e/design/alpha.spec.ts"]);
  });

  it("resolves a route leaf whatever extension the app router accepted", () => {
    const files = {
      ...REPO,
      "src/app/design-fixtures/beta/page.tsx": undefined,
      "src/app/design-fixtures/beta/page.js": `import { Widget } from "@/lib/widget";`,
    };
    delete files["src/app/design-fixtures/beta/page.tsx"];
    const result = selectWith(SPECS, files, ["src/app/design-fixtures/beta/page.js"]);
    expect(result.specs).toContain("tests/e2e/design/beta.spec.ts");
  });

  it("does not poison the graph over an import shown inside prose", () => {
    const prosy = {
      ...REPO,
      "src/app/design-fixtures/alpha/page.tsx": `
        /* The emission site is a LITERAL () => import("...") on purpose. */
        import { Widget } from "@/lib/widget";
      `,
    };
    const result = select(["src/lib/widget.tsx"], prosy);
    expect(result.mode).toBe("subset");
  });
});

// 7. THE SECOND CONVERGENCE ROUND. Five more ways the walk could have SKIPPED a
// family the diff really touches. Each item is the hole, then its closure.
describe("7. THE SECOND CONVERGENCE ROUND (false negatives)", () => {
  const specsOf = (repo, specs, changed) => {
    const io = makeIo(repo);
    const { families, routes, unresolved } = buildFamilies({ specFiles: specs, io });
    return selectFamilies({ changedFiles: changed, families, routes, unresolved });
  };

  it("reaches what the ROOT layout renders, not only the layouts below it", () => {
    const repo = {
      ...REPO,
      "src/app/layout.tsx": 'import { Providers } from "@/app/providers";\nexport default Providers;',
      "src/app/providers.tsx": "export const Providers = () => null;",
    };
    // src/app/providers.tsx is UI, is under no design-fixtures route and is in
    // no widening class: before depth 0 it belonged to nothing and was skipped.
    const result = specsOf(repo, SPECS, ["src/app/providers.tsx"]);
    expect(result.mode).toBe("subset");
    expect(result.specs.length).toBeGreaterThan(0);
    expect(routeFiles("/design-fixtures/alpha", makeIo(repo))).toContain("src/app/layout.tsx");
  });

  it("reaches the DYNAMIC handler of a template route, and what that handler imports", () => {
    const repo = {
      ...REPO,
      "tests/e2e/design/alpha.spec.ts": `
        import { test } from "@playwright/test";
        test("alpha", async ({ request }) => { await request.post(\`/api/things/\${1}\`); });
      `,
      "src/app/api/things/[id]/route.ts": 'import { load } from "@/lib/things";\nexport const POST = load;',
      "src/lib/things.ts": "export const load = () => null;",
    };
    // The literal truncates to "/api/things", which has no leaf of its own; the
    // handler sits one dynamic segment below it, and only through the handler is
    // src/lib/things.ts visible at all. Without the subtree walk this diff was
    // classed "no UI" and the suite did not run.
    const result = specsOf(repo, SPECS, ["src/lib/things.ts"]);
    expect(result.mode).toBe("subset");
    expect(result.specs).toContain("tests/e2e/design/alpha.spec.ts");
  });

  it("does not let one family's IMPORT match hide another family's URL match", () => {
    const repo = {
      ...REPO,
      "tests/e2e/design/alpha.spec.ts": `
        import { test } from "@playwright/test";
        import { POST } from "../../../src/app/api/things/[id]/route";
        test("alpha", async () => { POST(); });
      `,
      "tests/e2e/design/beta.spec.ts": `
        import { test } from "@playwright/test";
        test("beta", async ({ request }) => { await request.get("/api/things"); });
      `,
      "src/app/api/things/[id]/route.ts": "export const POST = () => null;",
    };
    const result = specsOf(repo, SPECS, ["src/app/api/things/[id]/route.ts"]);
    expect(result.specs).toContain("tests/e2e/design/alpha.spec.ts");
    expect(result.specs).toContain("tests/e2e/design/beta.spec.ts");
  });

  it("keeps an import whose statement carries a comment inside it", () => {
    const repo = {
      ...REPO,
      "src/app/design-fixtures/alpha/page.tsx":
        'import { Widget } from /* the shared one */ "@/lib/widget";\nexport default Widget;',
    };
    // The RAW scan cannot see this specifier (the comment breaks "from" from the
    // quote) and the stripped scan can — the union keeps it, so a widget-only
    // diff still selects alpha instead of being classed "no UI".
    const result = specsOf(repo, SPECS, ["src/lib/widget.tsx"]);
    expect(result.mode).toBe("subset");
    expect(result.specs).toContain("tests/e2e/design/alpha.spec.ts");
  });

  it("follows a WORKSPACE alias back into src/, and widens if tsconfig will not parse", () => {
    const repo = {
      ...REPO,
      "src/app/design-fixtures/alpha/page.tsx": 'import { Screen } from "@cinatra-ai/agents";\nexport default Screen;',
      "packages/agents/src/index.ts": 'export { Screen } from "@/lib/screen";',
      "src/lib/screen.tsx": "export const Screen = () => null;",
    };
    // A workspace package imports "@/..." back into src/. Treating the alias as
    // external hid src/lib/screen.tsx from every graph, and src/lib is in no
    // widening class, so the change was classed "no UI".
    const reached = specsOf(repo, SPECS, ["src/lib/screen.tsx"]);
    expect(reached.mode).toBe("subset");
    expect(reached.specs).toContain("tests/e2e/design/alpha.spec.ts");

    const broken = specsOf({ ...repo, "tsconfig.json": "{ not json" }, SPECS, ["docs/README.md"]);
    expect(broken.mode).toBe("all");
  });

  it("strips tsconfig comments by scanning, not by regex", () => {
    const source = '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } /* x */ }, // tail\n }';
    expect(JSON.parse(stripJsonc(source)).compilerOptions.paths["@/*"]).toEqual(["./src/*"]);
    // A value that CONTAINS a comment marker survives.
    expect(JSON.parse(stripJsonc('{ "a": "http://x/y" }')).a).toBe("http://x/y");
  });

  it("reads THIS repo's real aliases and resolves every in-repo import with them", () => {
    const aliases = aliasesFor({
      read: (rel) => (rel === "tsconfig.json" ? readFileSync(TSCONFIG_PATH, "utf8") : null),
      exists: () => false,
    });
    expect(aliases.failed).toBe(null);
    expect(aliases.prefixes.length).toBeGreaterThanOrEqual(1);
    expect(aliases.exact.size).toBeGreaterThan(50);
    const { unresolved } = buildFamilies({ specFiles: discoverSpecFiles() });
    expect(unresolved).toEqual([]);
  });
});

describe("8. THE RULE TABLE'S SHAPE", () => {
  it("names every rule's predicate `applies`, never `match`", () => {
    expect(WIDENING_RULES.length).toBeGreaterThan(0);
    for (const rule of WIDENING_RULES) {
      expect(typeof rule.id).toBe("string");
      expect(typeof rule.why).toBe("string");
      expect(typeof rule.applies).toBe("function");
      // `match` is a string method: a rule object must not shadow that name,
      // because a reader (and a static analyser) then reads the call site as a
      // regular-expression build rather than a predicate test.
      expect(Object.prototype.hasOwnProperty.call(rule, "match")).toBe(false);
    }
  });

  it("decides through `applies`, so wideningRuleFor reads the same property", () => {
    const selector = WIDENING_RULES.find((rule) => rule.id === "selector");
    expect(selector.applies("scripts/ci/design-select.mjs")).toBe(true);
    expect(selector.applies("README.md")).toBe(false);
    expect(wideningRuleFor("src/components/button.tsx")?.id).toBe("shared-primitive");
    expect(wideningRuleFor("scripts/ci/design-select.mjs")?.id).toBe("selector");
    expect(wideningRuleFor("README.md")).toBe(null);
  });

  it("keeps the source free of the old property name", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts/ci/design-select.mjs"), "utf8");
    expect(source).not.toMatch(/^\s*match:/m);
    expect(source).not.toContain("rule.match(");
  });

  it("carries a rule for the workflow and for the selector's own tests", () => {
    const ids = WIDENING_RULES.map((rule) => rule.id);
    expect(ids).toContain("suite-workflow");
    expect(ids).toContain("selector-test");
    expect(wideningRuleFor(".github/workflows/design-visual-verify.yml")?.id).toBe("suite-workflow");
    expect(wideningRuleFor("scripts/ci/__tests__/design-select.test.mjs")?.id).toBe("selector-test");
    expect(
      wideningRuleFor("scripts/ci/__tests__/design-select-workflow.test.mjs")?.id,
    ).toBe("selector-test");
    // Precise, not "every workflow": an unrelated workflow does not run the
    // design suite, and a neighbouring CI test is not this selector's proof.
    expect(wideningRuleFor(".github/workflows/gates.yml")).toBe(null);
    expect(wideningRuleFor("scripts/ci/__tests__/product-tree-hygiene.test.mjs")).toBe(null);
  });
});

// The workflow boundary (cinatra#3268 item 2): the cheap `select` job PUBLISHES
// its plan and the expensive job CONSUMES it, so both halves of the run are
// bound to one selection taken against the event's frozen base commit. A plan
// the expensive job cannot trust is a hard failure — never a silent "none",
// which would skip the suite while reporting success.
describe("9. THE PUBLISHED PLAN — the expensive job consumes what the cheap job decided", () => {
  const KNOWN = ["tests/e2e/design/alpha.spec.ts", "tests/e2e/design/beta.spec.ts"];
  const planText = (plan) => JSON.stringify(plan);

  it("reads a subset plan and hands its families to Playwright", () => {
    const { plan, error } = parsePlan(
      planText({ mode: "subset", specs: KNOWN, reasons: [], summary: "2 of 3 selected" }),
      { knownSpecs: KNOWN },
    );
    expect(error).toBe(undefined);
    expect(plan.mode).toBe("subset");
    expect(playwrightArgs(plan)).toEqual([
      "test",
      "-c",
      "tests/e2e/config/design.config.ts",
      ...KNOWN,
    ]);
  });

  it("reads an all plan and hands Playwright no filter", () => {
    const { plan } = parsePlan(planText({ mode: "all", specs: KNOWN, summary: "all" }), {
      knownSpecs: KNOWN,
    });
    expect(playwrightArgs(plan)).toEqual(["test", "-c", "tests/e2e/config/design.config.ts"]);
  });

  it("refuses a plan that is not JSON at all", () => {
    const { plan, error } = parsePlan("not json {", { knownSpecs: KNOWN });
    expect(plan).toBe(undefined);
    expect(error).toMatch(/not JSON/);
  });

  it("refuses an empty plan file", () => {
    expect(parsePlan("").error).toMatch(/empty/);
    expect(parsePlan("   \n").error).toMatch(/empty/);
  });

  it("refuses a plan carrying an unknown mode", () => {
    expect(parsePlan(planText({ mode: "maybe", specs: [] })).error).toMatch(/mode/);
    expect(parsePlan(planText({ specs: [] })).error).toMatch(/mode/);
  });

  it("refuses a plan whose spec list is not a list of paths", () => {
    expect(parsePlan(planText({ mode: "subset", specs: "a.spec.ts" })).error).toMatch(/spec list/);
    expect(parsePlan(planText({ mode: "subset", specs: [1] })).error).toMatch(/spec list/);
  });

  it("refuses a subset that selects nothing, and a skip that names families", () => {
    expect(parsePlan(planText({ mode: "subset", specs: [] })).error).toMatch(/no families/);
    expect(parsePlan(planText({ mode: "none", specs: KNOWN })).error).toMatch(/names families/);
  });

  it("refuses a plan naming a spec this suite does not have", () => {
    const { error } = parsePlan(planText({ mode: "subset", specs: ["tests/e2e/design/ghost.spec.ts"] }), {
      knownSpecs: KNOWN,
    });
    expect(error).toMatch(/ghost\.spec\.ts/);
  });

  it("fails the run on a malformed plan file instead of skipping the suite", () => {
    const file = join(tmpdir(), `design-select-plan-${process.pid}-malformed.json`);
    writeFileSync(file, "{ mode: none }");
    try {
      expect(main(["--run", "--plan", file])).toBe(1);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("refuses --plan with no path instead of quietly selecting again", () => {
    // `--run --plan` with the path lost. Branching on the VALUE let this fall
    // through to an ordinary diff selection, which on a diff with no UI answers
    // "none" and returns 0 — a green expensive job that ran no test at all.
    const err = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m) => err.push(String(m)));
    try {
      expect(main(["--run", "--plan"])).toBe(1);
      expect(main(["--run", "--plan", ""])).toBe(1);
      expect(main(["--plan", "--run"])).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(err.join("\n")).toMatch(/--plan needs the path/);
  });

  it("fails the run when the published plan file is absent", () => {
    const file = join(tmpdir(), `design-select-plan-${process.pid}-absent.json`);
    rmSync(file, { force: true });
    expect(main(["--run", "--plan", file])).toBe(1);
  });

  it("starts no Playwright for a published plan that skips the suite", () => {
    const file = join(tmpdir(), `design-select-plan-${process.pid}-none.json`);
    writeFileSync(file, `${JSON.stringify({ mode: "none", specs: [], summary: "skipped" })}\n`);
    try {
      expect(main(["--run", "--plan", file])).toBe(0);
    } finally {
      rmSync(file, { force: true });
    }
  });
});
