/**
 * Regression (cinatra#1454, GAP 2): `ensureAgentPackageFromGitFile` must carry
 * the sibling package.json's `cinatra.produces` through the synthesized import
 * ZIP. The OAS compiler's sibling read (`readSiblingPackageJson`) FAIL-CLOSES a
 * declared EndNode artifact binding when `cinatra.produces` is absent/empty, so
 * dropping produces during the ZIP synthesis broke dev git-file import of EVERY
 * binding-bearing agent (the binding read produces=[] → "not declared in
 * cinatra.produces").
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/ensure-agent-package-produces-carry.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const AGENT_JSON_PATH = "/agents/cinatra-ai/email-drafting-agent/cinatra/oas.json";

const OAS_CONTENT = JSON.stringify({
  agentspec_version: "26.1.0",
  component_type: "Flow",
  name: "Email Drafting Agent",
  metadata: { cinatra: { packageName: "@cinatra-ai/email-drafting-agent" } },
});

// Canonical sibling package.json — carries a typed `cinatra.produces` entry
// (extension + objectTypeId, the shape a binding-bearing agent declares).
const PKG_CONTENT = JSON.stringify({
  name: "@cinatra-ai/email-drafting-agent",
  version: "0.1.4",
  description: "drafts emails",
  license: "Apache-2.0",
  cinatra: {
    type: "flow",
    agentDependencies: { "@cinatra-ai/email-artifacts": "^0.1.0" },
    produces: [{ extension: "@cinatra-ai/email-artifacts", objectTypeId: "@cinatra-ai/email:body" }],
  },
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (p: string) => {
    if (p === AGENT_JSON_PATH) return OAS_CONTENT;
    if (p.endsWith("/package.json")) return PKG_CONTENT;
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
  importAgentTemplateCoreMock: vi.fn(async (..._args: unknown[]) => ({ templateId: "tpl-email", upserted: true })),
}));
vi.mock("../import-agent-core", () => ({
  importAgentTemplateCore: importAgentTemplateCoreMock,
}));

vi.mock("../reserved-workspace-slugs", () => ({
  isReservedWorkspaceSlug: () => false,
}));

import { ensureAgentPackageFromGitFile } from "../ensure-agent-package";
import { readZipFiles } from "../zip-helpers";

describe("ensureAgentPackageFromGitFile — carries cinatra.produces through the import ZIP", () => {
  beforeEach(() => {
    importAgentTemplateCoreMock.mockClear();
    setAgentTemplatePackageNameMock.mockClear();
    readAgentTemplateByPackageNameMock.mockReset();
  });

  it("synthesized ZIP package.json carries cinatra.produces (verbatim, incl objectTypeId)", async () => {
    // No existing DB row → not a version-skip; the loader synthesizes + imports.
    readAgentTemplateByPackageNameMock.mockResolvedValue(undefined);

    const result = await ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH });
    expect(result.skipped).toBe(false);
    expect(importAgentTemplateCoreMock).toHaveBeenCalledTimes(1);

    const zipBase64 = importAgentTemplateCoreMock.mock.calls[0]![0] as string;
    const files = readZipFiles(Buffer.from(zipBase64, "base64"));
    const pkgInZip = JSON.parse(files.get("package.json")!) as {
      cinatra?: { produces?: Array<{ extension: string; objectTypeId?: string }>; agentDependencies?: Record<string, string>; type?: string };
    };

    // produces must survive verbatim — this is the byte the compiler's binding
    // parity check reads (absent ⇒ every binding fail-closes).
    expect(pkgInZip.cinatra?.produces).toEqual([
      { extension: "@cinatra-ai/email-artifacts", objectTypeId: "@cinatra-ai/email:body" },
    ]);
    // The already-carried contract fields are untouched.
    expect(pkgInZip.cinatra?.type).toBe("flow");
    expect(pkgInZip.cinatra?.agentDependencies).toEqual({ "@cinatra-ai/email-artifacts": "^0.1.0" });
  });
});
