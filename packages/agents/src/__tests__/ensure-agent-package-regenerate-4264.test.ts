/**
 * cinatra#4264 slice A1b, review 1 finding 1: the git-file loader's two early
 * returns must not keep a stored `regenerate` list that the CURRENT flow on
 * disk no longer honours.
 *
 *   - The same-version guard skips the import (and so the compile) when the
 *     version and the lifecycle projection match. The dev watcher still
 *     reloads the runtime from disk after that skip, so an OAS edit at the same
 *     version that removes a step a stored list names would run the new flow
 *     with the old list. The loader now checks the stored list against the
 *     flow on disk before it takes that skip, and throws when the flow no
 *     longer honours it (the watcher then does not reload).
 *   - An unreadable sibling manifest returns "skipped" before any validation.
 *     The loader now checks the stored list of the row the OAS names first.
 *
 * Harness: `ensure-agent-package-lifecycle-carry.test.ts` (file reads, the row
 * read and the import mocked); the regenerate check itself is real.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/ensure-agent-package-regenerate-4264.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const PKG = "@cinatra-ai/synthetic-gemini-agent";
const AGENT_JSON_PATH = "/agents/cinatra-ai/synthetic-gemini-agent/cinatra/oas.json";

const gemini = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "synthetic-gemini-agent.json"), "utf8"),
) as { metadata: { cinatra: Record<string, unknown> } };
const GEMINI_NO_IDENTITY = JSON.stringify(gemini);
gemini.metadata.cinatra = { ...gemini.metadata.cinatra, packageName: PKG };
const GEMINI_WITH_IDENTITY = JSON.stringify(gemini);
/** The OAS on disk; review 2 also drives one WITHOUT metadata.cinatra.packageName. */
let OAS_CONTENT = GEMINI_WITH_IDENTITY;

// The fixture's ApiNode files its own output from the start's `user` input.
const KEPT = [{ artifactNode: "call_llm_bridge", step: "call_llm_bridge", noteInput: "user" }];
// A list that names a step the fixture flow does not have (removed by an edit).
const STALE = [{ artifactNode: "file_image", step: "image_flow", noteInput: "prompt" }];

/** The sibling manifest text, or "EACCES" for one that exists but cannot be read. */
let PKG_CONTENT = "";
const manifest = (lifecycle: unknown) =>
  JSON.stringify({
    name: PKG,
    version: "1.0.0",
    license: "Apache-2.0",
    cinatra: { type: "flow", lifecycle },
  });

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (p: string) => {
    if (p === AGENT_JSON_PATH) return OAS_CONTENT;
    if (p.endsWith("/package.json")) {
      if (PKG_CONTENT === "EACCES") {
        const err = new Error("EACCES") as Error & { code: string };
        err.code = "EACCES";
        throw err;
      }
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
    templateId: "tpl-gemini",
    upserted: true,
  })),
}));
vi.mock("../import-agent-core", () => ({
  importAgentTemplateCore: importAgentTemplateCoreMock,
}));

vi.mock("../reserved-workspace-slugs", () => ({
  isReservedWorkspaceSlug: () => false,
}));

import { ensureAgentPackageFromGitFile as ensureReal } from "../ensure-agent-package";

// Review 2 note: the install-record and declared-tables seams are injected, so
// the same-version controls reach the skip branch without the real
// install-record road (and so without any database state).
const ensureAgentPackageFromGitFile = (opts: { oasSourcePath: string }) =>
  ensureReal({
    ...opts,
    healInstallRecord: async () => ({ outcome: "already-live" }),
    activateDeclaredTables: async () => {},
  });
import { serializeLifecycleConfig, normalizeLifecycle } from "@/lib/lifecycle/lifecycle-policy";

/** The row the registry or an earlier import wrote: the manifest's own projection. */
const rowFor = (lifecycle: unknown, packageVersion = "1.0.0") => ({
  id: "tpl-gemini",
  packageVersion,
  lifecycleConfig: serializeLifecycleConfig(normalizeLifecycle(lifecycle)),
});

beforeEach(() => {
  OAS_CONTENT = GEMINI_WITH_IDENTITY;
  importAgentTemplateCoreMock.mockClear();
  setAgentTemplatePackageNameMock.mockClear();
  readAgentTemplateByPackageNameMock.mockReset();
});

describe("cinatra#4264 A1b review 1 — the same-version skip checks a stored regenerate list against the flow on disk", () => {
  it("REFUSES the skip when the row and the manifest keep a list the flow on disk no longer honours", async () => {
    const lifecycle = { regenerate: STALE };
    PKG_CONTENT = manifest(lifecycle);
    readAgentTemplateByPackageNameMock.mockResolvedValue(rowFor(lifecycle));
    await expect(ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH })).rejects.toThrow(
      /REGENERATE_DECLARATION_INVALID/,
    );
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
  });

  it("control: a list the flow on disk still honours keeps the skip", async () => {
    const lifecycle = { regenerate: KEPT };
    PKG_CONTENT = manifest(lifecycle);
    readAgentTemplateByPackageNameMock.mockResolvedValue(rowFor(lifecycle));
    const result = await ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH });
    expect(result.skipped).toBe(true);
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
  });

  it("control: a row without a list keeps the skip (no check, no import)", async () => {
    const lifecycle = { repairCapable: true };
    PKG_CONTENT = manifest(lifecycle);
    readAgentTemplateByPackageNameMock.mockResolvedValue(rowFor(lifecycle));
    const result = await ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH });
    expect(result.skipped).toBe(true);
  });
});

describe("cinatra#4264 A1b review 1 — an unreadable sibling manifest checks the stored list before it skips", () => {
  it("REFUSES when the row the OAS names keeps a list the flow on disk no longer honours", async () => {
    PKG_CONTENT = "EACCES";
    readAgentTemplateByPackageNameMock.mockResolvedValue(rowFor({ regenerate: STALE }));
    await expect(ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH })).rejects.toThrow(
      /REGENERATE_DECLARATION_INVALID/,
    );
    expect(readAgentTemplateByPackageNameMock).toHaveBeenCalledWith(PKG);
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
  });

  it("REFUSES when the row's stored lifecycle text cannot be read (review 1 finding 6)", async () => {
    PKG_CONTENT = "EACCES";
    readAgentTemplateByPackageNameMock.mockResolvedValue({
      id: "tpl-gemini",
      packageVersion: "1.0.0",
      lifecycleConfig: '{"regenerate":[{"artifactNode":"file_ima',
    });
    await expect(ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH })).rejects.toThrow(
      /stored lifecycle declaration cannot be read/,
    );
  });

  it("review 2: an OAS WITHOUT metadata.cinatra.packageName looks up the layout's scoped row and REFUSES a stale list", async () => {
    // The supported identity-less OAS shape: the row is the one the layout
    // names (agents/<vendor>/<slug> -> @vendor/slug), as the runtime mounts it.
    OAS_CONTENT = GEMINI_NO_IDENTITY;
    PKG_CONTENT = "EACCES";
    readAgentTemplateByPackageNameMock.mockResolvedValue(rowFor({ regenerate: STALE }));
    await expect(ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH })).rejects.toThrow(
      /REGENERATE_DECLARATION_INVALID/,
    );
    expect(readAgentTemplateByPackageNameMock).toHaveBeenCalledWith(PKG);
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
  });

  it("control: a list the flow still honours keeps the graceful skip", async () => {
    PKG_CONTENT = "EACCES";
    readAgentTemplateByPackageNameMock.mockResolvedValue(rowFor({ regenerate: KEPT }));
    const result = await ensureAgentPackageFromGitFile({ oasSourcePath: AGENT_JSON_PATH });
    expect(result.skipped).toBe(true);
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
  });
});
