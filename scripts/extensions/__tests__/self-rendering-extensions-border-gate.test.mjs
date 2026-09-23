// Unit tests for the self-rendering-extensions BORDER GATE (cinatra#3471,
// epic #2926 — decision 407 of 2026-09-13).
//
// Every case runs the gate as a SUBPROCESS against a SYNTHETIC extension tree
// written into a throwaway temp dir, so the assertion is the gate's real exit
// code and real message — never an internal shortcut. The shared committed
// `extensions/` tree is never read by these tests: the gate is pointed at the
// synthetic root with SELF_RENDERING_BORDER_EXT_ROOT and at a synthetic
// baseline with SELF_RENDERING_BORDER_BASELINE (the same injectable-root shape
// `CINATRA_INVENTORY_EXT_ROOT` gives scripts/extensions/inventory.mjs).

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE = join(__dirname, "..", "self-rendering-extensions-border-gate.mjs");

const temps = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

/**
 * Build a synthetic extension tree.
 * `packages` = [{ dir, kind, files: { "<relpath>": "<contents>" } }]
 * `baseline` = { "<dir>": ["src/components/ui/button.tsx", ...] } | null
 */
function makeTree(packages, baseline) {
  const base = mkdtempSync(join(tmpdir(), "cinatra-border-gate-"));
  temps.push(base);
  const extRoot = join(base, "extensions");
  for (const pkg of packages) {
    const pkgDir = join(extRoot, "cinatra-ai", pkg.dir);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: `@cinatra-ai/${pkg.dir}`, cinatra: { kind: pkg.kind } }, null, 2),
    );
    for (const [rel, contents] of Object.entries(pkg.files ?? {})) {
      const dest = join(pkgDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, contents);
    }
  }
  const baselinePath = join(base, "baseline.json");
  writeFileSync(
    baselinePath,
    JSON.stringify({ note: "synthetic test baseline", copies: baseline ?? {} }, null, 2) + "\n",
  );
  return { extRoot, baselinePath };
}

function runGate({ extRoot, baselinePath }, args = []) {
  const res = spawnSync(process.execPath, [GATE, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      SELF_RENDERING_BORDER_EXT_ROOT: extRoot,
      SELF_RENDERING_BORDER_BASELINE: baselinePath,
    },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const BUTTON_COPY = 'import { cn } from "../../lib/utils";\nexport const Button = () => null;\n';

describe("self-rendering-extensions border gate", () => {
  it("(a) FAILS on a connector primitive copy that is not in the baseline", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/components/ui/button.tsx": BUTTON_COPY },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(status).not.toBe(0);
    expect(stderr).toContain("demo-connector");
    expect(stderr).toContain("src/components/ui/button.tsx");
  });

  it("(a) PASSES when the same (package, path) pair is in the baseline", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/components/ui/button.tsx": BUTTON_COPY },
        },
      ],
      { "demo-connector": ["src/components/ui/button.tsx"] },
    );
    const { status, stderr } = runGate(tree);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("(b) FAILS on a baseline pair whose file no longer exists (shrink-only)", () => {
    const tree = makeTree(
      [{ dir: "demo-connector", kind: "connector", files: {} }],
      { "demo-connector": ["src/components/ui/button.tsx"] },
    );
    const { status, stderr } = runGate(tree);
    expect(status).not.toBe(0);
    expect(stderr).toContain("src/components/ui/button.tsx");
  });

  it("(c) FAILS on a direct @/components/ui import in a connector source file", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: {
            "src/setup-page.tsx": 'import { Button } from "@/components/ui/button";\nexport default Button;\n',
          },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(status).not.toBe(0);
    expect(stderr).toContain("@/components/ui/button");
  });

  it("(c) FAILS on a direct @/lib/utils import and on a src/components/ui import", () => {
    const utils = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/a.ts": 'import { cn } from "@/lib/utils";\nexport { cn };\n' },
        },
      ],
      {},
    );
    const utilsRun = runGate(utils);
    expect(utilsRun.status).not.toBe(0);
    expect(utilsRun.stderr).toContain("@/lib/utils");

    const deep = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: {
            "src/b.ts": 'import { Button } from "../../../src/components/ui/button";\nexport { Button };\n',
          },
        },
      ],
      {},
    );
    const deepRun = runGate(deep);
    expect(deepRun.status).not.toBe(0);
    expect(deepRun.stderr).toContain("src/components/ui/button");
  });

  it("(c) PASSES on a relative import of the package's own baselined copy", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: {
            "src/components/ui/button.tsx": BUTTON_COPY,
            "src/setup-page.tsx": 'import { Button } from "./components/ui/button";\nexport default Button;\n',
          },
        },
      ],
      { "demo-connector": ["src/components/ui/button.tsx"] },
    );
    const { status, stderr } = runGate(tree);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  // cinatra#3512 (slice 2b of #3471): the BUILD-TIME road. A source-compiled
  // package (a connector setup page, an artifact package's server part) takes
  // the host's primitives through the host-neutral module id. The border rule
  // bans the product-INTERNAL path, never the shared id — the gate must let the
  // migrated form through, or slice 3 cannot land a single package.
  it("(c) PASSES on the host-shared primitives module id @cinatra-ai/design-primitives", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: {
            "src/setup-page.tsx":
              'import { Alert, AlertDescription } from "@cinatra-ai/design-primitives";\nexport default [Alert, AlertDescription];\n',
          },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("(c) does not read the ban out of a COMMENT that merely names the host path", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: {
            "src/notes.ts": '// bundled-react connectors cannot import "@/components/ui/tabs"\nexport const x = 1;\n',
          },
        },
      ],
      {},
    );
    const { status } = runGate(tree);
    expect(status).toBe(0);
  });

  it("a kind:agent package is out of scope here (gate #3470 covers agents)", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-agent",
          kind: "agent",
          files: {
            "src/components/ui/button.tsx": BUTTON_COPY,
            "src/renderer.tsx": 'import { Button } from "@/components/ui/button";\nexport default Button;\n',
          },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("names decision 407 and issue #3471 in its failure message", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/components/ui/button.tsx": BUTTON_COPY },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(status).not.toBe(0);
    expect(stderr).toContain("decision 407");
    expect(stderr).toContain("#3471");
  });

  // --- convergence round (codex, 2026-09-13): the detection gaps below were
  // found on the delta and are pinned here so they cannot come back.

  it("(c) FAILS on a side-effect import written without whitespace", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/side-effect.ts": 'import"@/components/ui/button";\nexport const x = 1;\n' },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(status).not.toBe(0);
    expect(stderr).toContain("@/components/ui/button");
  });

  it("(c) FAILS on the host alias written with an explicit code extension", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/a.ts": 'import { cn } from "@/lib/utils.ts";\nexport { cn };\n' },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(status).not.toBe(0);
    expect(stderr).toContain("@/lib/utils.ts");
  });

  it("(c) PASSES on a relative reach into a sibling directory that is not the banned one", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: {
            "src/b.ts": 'import { Button } from "../../../src/components/ui-extra/button";\nexport { Button };\n',
          },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("(a) FAILS on an unlisted copy parked in a build-named subdirectory of the ui tree", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/components/ui/build/button.tsx": BUTTON_COPY },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(status).not.toBe(0);
    expect(stderr).toContain("src/components/ui/build/button.tsx");
  });

  it("(b) counts a SYMLINKED baselined copy as present, not stale", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/button-impl.tsx": BUTTON_COPY },
        },
      ],
      { "demo-connector": ["src/components/ui/button.tsx"] },
    );
    const uiDir = join(tree.extRoot, "cinatra-ai", "demo-connector", "src", "components", "ui");
    mkdirSync(uiDir, { recursive: true });
    symlinkSync(join("..", "..", "button-impl.tsx"), join(uiDir, "button.tsx"));
    const { status, stderr } = runGate(tree);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("--write-baseline refuses to GROW the committed baseline (shrink-only)", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/components/ui/button.tsx": BUTTON_COPY },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree, ["--write-baseline"]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("shrink-only");
  });
});
