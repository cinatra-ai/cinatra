import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseGateArgs, runWorkflowBpmnGate } from "../workflow-bpmn-gate.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXTENSIONS_ROOT = join(REPO_ROOT, "extensions");

// A real, in-tree workflow extension used as the single-package fixture. It is
// already covered by the default monorepo scan, so it must validate clean both
// ways — that equivalence is precisely the property --package-root must keep.
const FIXTURE_PACKAGE_ROOT = join(EXTENSIONS_ROOT, "cinatra-ai", "blog-content-workflow");

describe("parseGateArgs", () => {
  it("returns no roots when no flags are passed (default monorepo scan)", () => {
    expect(parseGateArgs([])).toEqual({ packageRoot: null, extensionsRoot: null });
  });

  it("parses --package-root <dir> to an absolute path", () => {
    const { packageRoot, extensionsRoot } = parseGateArgs(["--package-root", FIXTURE_PACKAGE_ROOT]);
    expect(extensionsRoot).toBeNull();
    expect(packageRoot).toBe(FIXTURE_PACKAGE_ROOT);
  });

  it("parses the --package-root=<dir> equals form", () => {
    const { packageRoot } = parseGateArgs([`--package-root=${FIXTURE_PACKAGE_ROOT}`]);
    expect(packageRoot).toBe(FIXTURE_PACKAGE_ROOT);
  });

  it("parses --extensions-root <dir>", () => {
    const { extensionsRoot, packageRoot } = parseGateArgs(["--extensions-root", EXTENSIONS_ROOT]);
    expect(packageRoot).toBeNull();
    expect(extensionsRoot).toBe(EXTENSIONS_ROOT);
  });

  it("fails loud when a flag is missing its value", () => {
    expect(() => parseGateArgs(["--package-root"])).toThrow(/requires a directory path/);
  });

  it("rejects combining --package-root with --extensions-root", () => {
    expect(() => parseGateArgs(["--package-root", "/a", "--extensions-root", "/b"])).toThrow(/mutually exclusive/);
  });
});

describe("runWorkflowBpmnGate (default monorepo scan)", () => {
  it("discovers the in-tree workflow extensions and passes Profile 1.0", async () => {
    const result = await runWorkflowBpmnGate();
    expect(result.exts.length).toBeGreaterThan(0);
    expect(result.failures, JSON.stringify(result.failures, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("runWorkflowBpmnGate (--package-root single extracted repo)", () => {
  it("validates exactly one package rooted at the given dir", async () => {
    const result = await runWorkflowBpmnGate({ packageRoot: FIXTURE_PACKAGE_ROOT });
    expect(result.exts).toHaveLength(1);
    expect(result.exts[0].packageRoot).toBe(FIXTURE_PACKAGE_ROOT);
    expect(result.failures, JSON.stringify(result.failures, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("fails loud when the package is not cinatra.kind:\"workflow\"", async () => {
    await expect(runWorkflowBpmnGate({ packageRoot: REPO_ROOT })).rejects.toThrow(/not cinatra\.kind/);
  });

  it("fails loud when there is no package.json at the root", async () => {
    await expect(
      runWorkflowBpmnGate({ packageRoot: join(REPO_ROOT, "this-dir-does-not-exist") }),
    ).rejects.toThrow(/no readable package\.json/);
  });
});
