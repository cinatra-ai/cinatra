/**
 * Regression: `ensureAgentPackageFromGitFile` must resolve the agent's version
 * SOLELY from the sibling `package.json#version` — NOT from the (now redundant)
 * `metadata.cinatra.packageVersion` in the OAS.
 *
 * The OAS copy is a non-typed passthrough kept only for provenance. Reading it
 * first risked OAS<->package.json drift: if the OAS carried a STALE version that
 * happened to equal the DB row's version, the version-skip guard would
 * short-circuit and silently skip re-importing the bumped code.
 *
 * This test pins the fix by making the OAS lie: OAS says "0.1.0" (matching the
 * existing DB row, which WOULD trigger the version-skip guard if read), while
 * the canonical sibling package.json says "0.1.1" — a normal forward bump. The
 * loader must read 0.1.1, see it differs from the DB row (and is NOT a
 * downgrade), and re-import rather than skip. If the loader instead read the
 * OAS's 0.1.0, it would equal the DB row and silently skip the bumped code.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/ensure-agent-package-version-source.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const AGENT_JSON_PATH = "/agents/cinatra-ai/demo-agent/cinatra/oas.json";

// OAS carries a STALE metadata.cinatra.packageVersion ("0.1.0") that equals the
// existing DB row — the trap the OLD OAS-first read would fall into (→ version
// skip). It is LOWER than package.json so reading package.json never triggers
// the downgrade guard; only the version-skip guard could fire, and only if the
// loader (wrongly) read this OAS value.
const OAS_CONTENT = JSON.stringify({
  agentspec_version: "26.1.0",
  component_type: "Flow",
  name: "Demo Agent",
  metadata: { cinatra: { packageName: "@cinatra-ai/demo-agent", packageVersion: "0.1.0" } },
});

// Canonical sibling package.json — the ONLY source of truth for the version.
const PKG_CONTENT = JSON.stringify({
  name: "@cinatra-ai/demo-agent",
  version: "0.1.1",
  description: "demo",
  license: "Apache-2.0",
  cinatra: { type: "flow" },
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (p: string) => {
    if (p === AGENT_JSON_PATH) return OAS_CONTENT;
    if (p.endsWith("/package.json")) return PKG_CONTENT;
    // LICENSE / NOTICE probes — not present in this fixture.
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
  // Typed signature so `.mock.calls[0][0]` (the base64 zip) is inspectable.
  importAgentTemplateCoreMock: vi.fn(
    async (..._args: unknown[]) => ({ templateId: "tpl-demo", upserted: true }),
  ),
}));
vi.mock("../import-agent-core", () => ({
  importAgentTemplateCore: importAgentTemplateCoreMock,
}));

// reserved-workspace-slugs: real check would reject reserved names; this slug is
// not reserved, so a tiny stub keeps the test hermetic.
vi.mock("../reserved-workspace-slugs", () => ({
  isReservedWorkspaceSlug: () => false,
}));

import { ensureAgentPackageFromGitFile } from "../ensure-agent-package";
import { readZipFiles } from "../zip-helpers";

describe("ensureAgentPackageFromGitFile — version resolves solely from package.json#version", () => {
  beforeEach(() => {
    importAgentTemplateCoreMock.mockClear();
    setAgentTemplatePackageNameMock.mockClear();
    readAgentTemplateByPackageNameMock.mockReset();
  });

  it("does NOT skip when the OAS packageVersion (stale) matches the DB row but package.json#version differs", async () => {
    // Existing DB row is at 0.1.0 — EQUAL to the OAS's stale packageVersion.
    // If the loader read the OAS value, the version-skip guard would fire (skip).
    readAgentTemplateByPackageNameMock.mockResolvedValue({ id: "tpl-demo", packageVersion: "0.1.0" });

    const result = await ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH });

    // It must have re-imported (package.json#version 0.1.1 ≠ DB row 0.1.0), NOT skipped.
    expect(result.skipped).toBe(false);
    expect(importAgentTemplateCoreMock).toHaveBeenCalledTimes(1);

    // The synthesized import zip's package.json must carry 0.1.1 (from sibling
    // package.json), never the OAS's 0.1.0.
    const zipBase64 = importAgentTemplateCoreMock.mock.calls[0]![0] as string;
    const files = readZipFiles(Buffer.from(zipBase64, "base64"));
    const pkgInZip = JSON.parse(files.get("package.json")!) as { version?: string };
    expect(pkgInZip.version).toBe("0.1.1");

    // The packageName identity write must also carry the package.json version.
    expect(setAgentTemplatePackageNameMock).toHaveBeenCalledWith("tpl-demo", "@cinatra-ai/demo-agent", "0.1.1");
  });

  it("DOES skip when package.json#version matches the DB row (regardless of the OAS value)", async () => {
    // DB row at 0.1.1 == sibling package.json#version → version-skip guard fires.
    // The OAS's 0.1.0 is irrelevant; the loader never reads it.
    readAgentTemplateByPackageNameMock.mockResolvedValue({ id: "tpl-demo", packageVersion: "0.1.1" });

    const result = await ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH });

    expect(result.skipped).toBe(true);
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
  });
});
