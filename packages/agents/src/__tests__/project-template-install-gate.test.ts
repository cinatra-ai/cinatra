import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Unit tests for the PROJECT-TEMPLATE install gate (cinatra#1032
// deliverable 3) — the host-side AUTHORITATIVE enforcement of the typed
// template contract in install-from-package's inert window. Real fixture
// packages on disk; the REAL sdk validators run (no mocks), so the tests
// prove the acceptance property end-to-end at this seam: a package shipping
// a template whose worker ref is absent from (or version-mismatched with)
// its cinatra.dependencies edges is REFUSED with a structured error, and a
// template-less package no-ops.

import type { ExtensionDependency } from "@cinatra-ai/sdk-extensions/dependencies";
import {
  enforceProjectTemplateInstallContract,
  ProjectTemplateContractViolationError,
  PROJECT_TEMPLATE_PACKAGE_PATH,
  PROJECT_TEMPLATE_CONTRACT_VIOLATION_CODE,
} from "../project-template-install-gate";

const WORKER_PKG = "@cinatra-ai/draft-writer-agent";

const validTemplate = () => ({
  formatVersion: "cinatra.ai/project-template@1",
  id: "launch-plan",
  name: "Launch plan",
  anchor: { id: "launch" },
  tasks: [
    {
      id: "draft",
      title: "Write the draft",
      schedule: { startOffsetDays: -10, dueOffsetDays: -5 },
      worker: {
        role: "draft-writer",
        packageName: WORKER_PKG,
        versionConstraint: { kind: "exact", version: "1.0.0" },
      },
    },
    { id: "review", title: "Human review", dependsOn: ["draft"], approval: { id: "sign-off" } },
  ],
});

const matchingEdges = (): ExtensionDependency[] => [
  {
    packageName: WORKER_PKG,
    kind: "agent",
    edgeType: "runtime",
    versionConstraint: { kind: "exact", version: "1.0.0" },
    requirement: "required",
  },
];

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "project-template-gate-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeTemplate(content: string): Promise<void> {
  await mkdir(join(dir, "cinatra"), { recursive: true });
  await writeFile(join(dir, PROJECT_TEMPLATE_PACKAGE_PATH), content, "utf8");
}

describe("enforceProjectTemplateInstallContract", () => {
  it("no-ops for a package that ships no template", async () => {
    const out = await enforceProjectTemplateInstallContract({
      extractedTempDir: dir,
      packageName: "@cinatra-ai/plain-agent",
      dependencyEdges: [],
    });
    expect(out).toEqual({ present: false });
  });

  it("passes a valid template whose worker refs exact-match the manifest edges", async () => {
    await writeTemplate(JSON.stringify(validTemplate()));
    const out = await enforceProjectTemplateInstallContract({
      extractedTempDir: dir,
      packageName: "@cinatra-ai/release-announcement-agent",
      dependencyEdges: matchingEdges(),
    });
    expect(out).toMatchObject({ present: true, template: { id: "launch-plan" } });
  });

  it("REFUSES a worker ref absent from cinatra.dependencies (Acceptance: exact-match rule)", async () => {
    await writeTemplate(JSON.stringify(validTemplate()));
    const err = await enforceProjectTemplateInstallContract({
      extractedTempDir: dir,
      packageName: "@cinatra-ai/release-announcement-agent",
      dependencyEdges: [], // worker not declared
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectTemplateContractViolationError);
    const v = err as ProjectTemplateContractViolationError;
    expect(v.code).toBe(PROJECT_TEMPLATE_CONTRACT_VIOLATION_CODE);
    expect(v.statusCode).toBe(422);
    expect(v.violations).toEqual([
      expect.objectContaining({ code: "worker_not_in_dependencies" }),
    ]);
  });

  it("REFUSES a worker ref whose version constraint mismatches its edge", async () => {
    await writeTemplate(JSON.stringify(validTemplate()));
    const edges = matchingEdges();
    edges[0] = { ...edges[0], versionConstraint: { kind: "exact", version: "2.0.0" } };
    await expect(
      enforceProjectTemplateInstallContract({
        extractedTempDir: dir,
        packageName: "@cinatra-ai/release-announcement-agent",
        dependencyEdges: edges,
      }),
    ).rejects.toMatchObject({
      code: PROJECT_TEMPLATE_CONTRACT_VIOLATION_CODE,
      violations: [expect.objectContaining({ code: "worker_version_mismatch" })],
    });
  });

  it("REFUSES a structurally invalid template, collecting ALL violations", async () => {
    const bad = validTemplate() as Record<string, unknown>;
    bad.formatVersion = "wrong";
    (bad.tasks as Array<Record<string, unknown>>)[1].dependsOn = ["nonexistent"];
    await writeTemplate(JSON.stringify(bad));
    const err = await enforceProjectTemplateInstallContract({
      extractedTempDir: dir,
      packageName: "@cinatra-ai/release-announcement-agent",
      dependencyEdges: matchingEdges(),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectTemplateContractViolationError);
    const codes = (err as ProjectTemplateContractViolationError).violations.map((v) => v.code);
    expect(codes).toContain("bad_format_version");
    expect(codes).toContain("unknown_dependency");
  });

  it("REFUSES unparsable template JSON with a structured violation (never a raw parse error)", async () => {
    await writeTemplate("{ not json");
    await expect(
      enforceProjectTemplateInstallContract({
        extractedTempDir: dir,
        packageName: "@cinatra-ai/release-announcement-agent",
        dependencyEdges: [],
      }),
    ).rejects.toMatchObject({
      code: PROJECT_TEMPLATE_CONTRACT_VIOLATION_CODE,
      violations: [expect.objectContaining({ code: "template_unparsable" })],
    });
  });

  it("REFUSES a present-but-unreadable template (integrity, not 'no template')", async () => {
    await writeTemplate(JSON.stringify(validTemplate()));
    await chmod(join(dir, PROJECT_TEMPLATE_PACKAGE_PATH), 0o000);
    try {
      await expect(
        enforceProjectTemplateInstallContract({
          extractedTempDir: dir,
          packageName: "@cinatra-ai/release-announcement-agent",
          dependencyEdges: matchingEdges(),
        }),
      ).rejects.toMatchObject({
        violations: [expect.objectContaining({ code: "template_unreadable" })],
      });
    } finally {
      await chmod(join(dir, PROJECT_TEMPLATE_PACKAGE_PATH), 0o644);
    }
  });
});
