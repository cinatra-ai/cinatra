// Unit tests for scripts/ci/merge-readiness-inventory.mjs (engineering#658 item 3).
//
// The generator IS the record of how `.github/merge-readiness.json` is
// regenerated, so the last test runs its `--check` mode against the real
// repository: the committed inventory must match the live workflow set.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { INVENTORY_PATH, validateInventory } from "../merge-readiness.mjs";
import {
  SELF_CONTEXT,
  TRUSTED_APP,
  contextsOf,
  deriveInventory,
  parseEventConfig,
  parseJobAttrs,
  readWorkflows,
  serialize,
} from "../merge-readiness-inventory.mjs";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

const CAND = "on:\n  pull_request:\n  merge_group:\n";

const WF = {
  plain: `name: gates

${CAND}
jobs:
  build:
    runs-on: ubuntu-latest
  proof:
    name: proof
    runs-on: ubuntu-latest
`,
  remoteCall: `name: gitignore-gate

${CAND}
jobs:
  gitignore-gate:
    uses: cinatra-ai/ci/.github/workflows/gitignore-gate.yml@696c647 # v0.1.0
`,
  localCall: `name: toast-banner-gate

${CAND}
jobs:
  toast-banner-gate:
    uses: ./.github/workflows/toast-banner-gate-reusable.yml
`,
  localTarget: `name: toast-banner-gate-reusable

on:
  workflow_call:

jobs:
  toast-banner-gate:
    runs-on: ubuntu-latest
`,
  pathFiltered: `name: design-visual-verify

on:
  pull_request:
    paths:
      - 'src/**'
      - 'packages/*/src/**'
  merge_group:

jobs:
  design-visual-verify:
    runs-on: ubuntu-latest
`,
  prOnly: `name: dev-hmr-smoke

on:
  pull_request:

jobs:
  dev-hmr-smoke:
    runs-on: ubuntu-latest
`,
  pushOnly: `name: dockerhub-publish

on:
  push:
    branches: [main]

jobs:
  publish:
    runs-on: ubuntu-latest
`,
  report: `name: knip-report

${CAND}
jobs:
  knip-report:
    runs-on: ubuntu-latest
`,
  continueOnError: `name: soft-gate

${CAND}
jobs:
  soft-gate:
    continue-on-error: true
    runs-on: ubuntu-latest
`,
  guarded: `name: build-image

${CAND}
jobs:
  detect:
    name: Detect skip
    runs-on: ubuntu-latest
  image:
    if: ${'${{'} needs.detect.outputs.skip != 'true' }}
    runs-on: ubuntu-latest
  summary:
    if: ${'${{'} always() }}
    runs-on: ubuntu-latest
  leg:
    name: ${'${{'} matrix.name }}
    runs-on: ubuntu-latest
`,
};

// The generator reads the report-only rule off the workflow FILE name, so the
// fixtures carry the file names they stand in for.
const FILE_OF = {
  plain: "gates.yml",
  remoteCall: "gitignore-gate.yml",
  localCall: "toast-banner-gate.yml",
  localTarget: "toast-banner-gate-reusable.yml",
  pathFiltered: "design-visual-verify.yml",
  prOnly: "dev-hmr-smoke.yml",
  pushOnly: "dockerhub-publish.yml",
  report: "knip-report.yml",
  continueOnError: "soft-gate.yml",
  guarded: "build-image.yml",
};

const files = (keys) => keys.map((k) => ({ file: FILE_OF[k], text: WF[k] }));

describe("workflow readers", () => {
  it("reads branches and paths off one event's config", () => {
    expect(parseEventConfig(WF.pushOnly, "push")).toEqual({ present: true, branches: ["main"], paths: null });
    expect(parseEventConfig(WF.pathFiltered, "pull_request")).toEqual({
      present: true,
      branches: null,
      paths: ["src/**", "packages/*/src/**"],
    });
    expect(parseEventConfig(WF.pushOnly, "pull_request").present).toBe(false);
    expect(parseEventConfig(WF.prOnly, "merge_group").present).toBe(false);
  });

  it("reads a job's uses: target and continue-on-error flag", () => {
    expect(parseJobAttrs(WF.localCall).get("toast-banner-gate").uses).toBe("./.github/workflows/toast-banner-gate-reusable.yml");
    expect(parseJobAttrs(WF.continueOnError).get("soft-gate").continueOnError).toBe(true);
    expect(parseJobAttrs(WF.plain).get("build").uses).toBeNull();
    expect(parseJobAttrs(WF.guarded).get("image").if).toBe("${{ needs.detect.outputs.skip != 'true' }}");
    expect(parseJobAttrs(WF.guarded).get("summary").if).toBe("${{ always() }}");
  });

  it("derives the check-run name for plain, remote-call and local-call jobs", () => {
    const read = (rel) => (rel.endsWith("toast-banner-gate-reusable.yml") ? WF.localTarget : null);
    expect(contextsOf({ file: "gates.yml", text: WF.plain, readWorkflow: read }).map((c) => c.context)).toEqual(["build", "proof"]);
    expect(contextsOf({ file: "gitignore-gate.yml", text: WF.remoteCall, readWorkflow: read })[0].context).toBe(
      "gitignore-gate / gitignore-gate",
    );
    expect(contextsOf({ file: "toast-banner-gate.yml", text: WF.localCall, readWorkflow: read })[0].context).toBe(
      "toast-banner-gate / toast-banner-gate",
    );
  });
});

describe("inventory derivation", () => {
  it("expects every context a candidate produces, with its trusted app and paths", () => {
    const inv = deriveInventory(files(["plain", "remoteCall", "pathFiltered"]));
    expect(inv.expected.map((e) => e.context)).toEqual([
      "build",
      "design-visual-verify",
      "gitignore-gate / gitignore-gate",
      "proof",
    ]);
    expect(inv.expected.every((e) => e.app === TRUSTED_APP)).toBe(true);
    expect(inv.expected.find((e) => e.context === "design-visual-verify").paths).toEqual(["src/**", "packages/*/src/**"]);
    expect(inv.expected.find((e) => e.context === "build").paths).toEqual(["**"]);
    expect(inv.expected.every((e) => e.skippable === false)).toBe(true);
    expect(validateInventory(inv).ok).toBe(true);
  });

  it("excludes report-only and dynamically-named jobs, each with its reason", () => {
    const inv = deriveInventory(files(["plain", "report", "continueOnError", "guarded"]));
    const reasons = Object.fromEntries(inv.excluded.map((e) => [e.context, e.reason]));
    expect(reasons["knip-report"]).toMatch(/^report-only:/);
    expect(reasons["soft-gate"]).toMatch(/continue-on-error/);
    expect(reasons["${{ matrix.name }}"]).toMatch(/^dynamic-name:/);
    expect(inv.expected.map((e) => e.context)).toContain("build");
  });

  it("marks a job under an if: guard skippable, and an always() job not", () => {
    const inv = deriveInventory(files(["guarded"]));
    const flag = Object.fromEntries(inv.expected.map((e) => [e.context, e.skippable]));
    expect(flag["Detect skip"]).toBe(false);
    expect(flag.image).toBe(true);
    expect(flag.summary).toBe(false);
  });

  it("ignores a workflow that does not run on both candidate events", () => {
    expect(deriveInventory(files(["pushOnly"])).expected).toEqual([]);
    expect(deriveInventory(files(["prOnly"])).expected).toEqual([]);
  });

  it("never lists its own context and keeps the deadline under the queue timeout", () => {
    const inv = deriveInventory(files(["plain"]));
    expect(inv.selfContext).toBe(SELF_CONTEXT);
    expect(inv.expected.map((e) => e.context)).not.toContain(SELF_CONTEXT);
    expect(inv.deadlineMinutes).toBeLessThan(120);
  });
});

describe("--check mode against the real repository", () => {
  it("the committed inventory matches the live workflow set", () => {
    const derived = deriveInventory(readWorkflows(repoRoot));
    const committed = fs.readFileSync(path.join(repoRoot, INVENTORY_PATH), "utf8");
    expect(committed).toBe(serialize(derived));
  });

  it("the committed inventory is valid and excludes the merge-readiness context itself", () => {
    const inv = JSON.parse(fs.readFileSync(path.join(repoRoot, INVENTORY_PATH), "utf8"));
    expect(validateInventory(inv).ok).toBe(true);
    expect(inv.expected.map((e) => e.context)).not.toContain(SELF_CONTEXT);
    expect(inv.expected.length).toBeGreaterThan(0);
  });
});
