/**
 * Tests for resolveVersionBeforeRun.
 *
 * Mocks `@cinatra/agent-builder` so no DB / Postgres / Redis involvement.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@cinatra/agent-builder", () => ({
  readAgentTemplateByPackageName: vi.fn(),
  readAgentTemplateVersionBySemver: vi.fn(),
}));

import {
  readAgentTemplateByPackageName,
  readAgentTemplateVersionBySemver,
} from "@cinatra-ai/agents";
import { resolveVersionBeforeRun } from "../version-pinning";

const mockTemplate = readAgentTemplateByPackageName as unknown as ReturnType<
  typeof vi.fn
>;
const mockVersion = readAgentTemplateVersionBySemver as unknown as ReturnType<
  typeof vi.fn
>;

describe("resolveVersionBeforeRun", () => {
  beforeEach(() => {
    mockTemplate.mockReset();
    mockVersion.mockReset();
  });

  it("returns { resolvedVersion } from template.packageVersion when no requestedVersion is provided", async () => {
    mockTemplate.mockResolvedValueOnce({
      id: "tmpl-1",
      packageName: "pkg-a",
      packageVersion: "1.2.3",
    });
    const result = await resolveVersionBeforeRun({ packageName: "pkg-a" });
    expect(result).toEqual({ templateId: "tmpl-1", resolvedVersion: "1.2.3" });
    expect(mockVersion).not.toHaveBeenCalled();
  });

  it("throws A2AError (invalidParams) when requested version is not found", async () => {
    mockTemplate.mockResolvedValueOnce({
      id: "tmpl-1",
      packageName: "pkg-a",
      packageVersion: "1.2.3",
    });
    mockVersion.mockResolvedValueOnce(null);
    await expect(
      resolveVersionBeforeRun({ packageName: "pkg-a", requestedVersion: "9.9.9" }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("9.9.9"),
    });
  });

  it("returns the requested version when it exists in agent_template_versions", async () => {
    mockTemplate.mockResolvedValueOnce({
      id: "tmpl-1",
      packageName: "pkg-a",
      packageVersion: "1.2.3",
    });
    mockVersion.mockResolvedValueOnce({
      id: "snap-abc",
      semver: "1.2.0",
      templateId: "tmpl-1",
    });
    const result = await resolveVersionBeforeRun({
      packageName: "pkg-a",
      requestedVersion: "1.2.0",
    });
    expect(result).toEqual({
      templateId: "tmpl-1",
      resolvedVersion: "1.2.0",
      snapshotId: "snap-abc",
    });
  });

  it("throws A2AError (invalidParams) when packageName is not known", async () => {
    mockTemplate.mockResolvedValueOnce(null);
    await expect(
      resolveVersionBeforeRun({ packageName: "missing" }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("missing"),
    });
  });

  it("throws A2AError (invalidParams) when template has no publishedVersion and none requested", async () => {
    mockTemplate.mockResolvedValueOnce({
      id: "tmpl-1",
      packageName: "pkg-a",
      packageVersion: null,
    });
    await expect(
      resolveVersionBeforeRun({ packageName: "pkg-a" }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("No published version"),
    });
  });
});
