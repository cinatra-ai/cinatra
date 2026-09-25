/**
 * WHAT THE SERVER BOUNDARY ASKS THE ROAD TO DOWNLOAD (cinatra#3204 fix leg).
 *
 * THE MAINTAINER'S RULING, in their words: "Anyone can download a ZIP of
 * origin/main of a repo or a ZIP of a release — no need to be logged in at
 * GitHub. The user provides that link and Cinatra gets the ZIP."
 *
 * The form mocks the actions and the road tests call the install helper
 * directly, so the ONE thing neither of them sees is the step between: what the
 * repository action turns a pasted link into before it hands it down. That is
 * where a link's ref and its namespace can be lost, so it is measured here —
 * against the real `parseGitHubArchiveLink` and the real URL builder, with only
 * the session and the road itself replaced.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const session = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  session: { activeOrganizationId: "org-1" } as { activeOrganizationId: string | null } | null,
}));
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => session),
  buildCanDoOptsFromSession: vi.fn(async () => ({ orgRole: "org_admin" })),
}));

const road = vi.hoisted(() => ({
  previewSuppliedRepositoryArchive: vi.fn(),
  prepareSuppliedRepositoryArchiveSnapshot: vi.fn(),
}));
vi.mock("@/lib/supplied-package-install", () => road);

vi.mock("@/lib/anthropic-skill-config-service", () => ({
  snapshotSkillPackageIds: () => new Set<string>(),
  resolveInstalledClosure: () => [],
  recordSkillInstallConsent: () => ({ grant: false, reason: "not-asked", outcome: "" }),
  buildInstallConsentPrompt: () => ({
    headline: "h",
    advisory: "a",
    closureLines: [],
    closureDigest: "d",
    consentApplies: false,
  }),
}));

import { previewSuppliedRepositoryAction } from "../supplied-install-actions";

const SHA = "e".repeat(40);

function previewed(over: Record<string, unknown> = {}) {
  return {
    kind: "skill",
    packageName: "@acme/thing-skill",
    version: "1.0.0",
    contentDigest: "f".repeat(64),
    deliveredEntries: new Map<string, Uint8Array>(),
    provenance: { type: "local", path: "supplied-archive", contentDigest: "f".repeat(64) },
    repo: "acme/thing",
    ref: "HEAD",
    resolvedSha: SHA,
    archiveUrl: "https://codeload.github.com/acme/thing/zip/HEAD",
    ...over,
  };
}

/** What the action handed the road for this link. */
async function targetFor(repoUrl: string, ref?: string) {
  road.previewSuppliedRepositoryArchive.mockResolvedValueOnce(previewed() as never);
  const result = await previewSuppliedRepositoryAction({
    repoUrl,
    ...(ref === undefined ? {} : { ref }),
  });
  expect(result.ok).toBe(true);
  return road.previewSuppliedRepositoryArchive.mock.calls.at(-1)![0] as {
    owner: string;
    repo: string;
    ref: string | null;
    archiveUrl: string;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the repository action turns the LINK into the archive it will download", () => {
  it("asks for the default branch when the link names no ref", async () => {
    expect(await targetFor("https://github.com/acme/thing")).toEqual({
      owner: "acme",
      repo: "thing",
      ref: null,
      archiveUrl: "https://codeload.github.com/acme/thing/zip/HEAD",
    });
  });

  it("asks for a RELEASE under refs/tags, exactly as the release page named it", async () => {
    expect(await targetFor("https://github.com/acme/thing/releases/tag/v1.2.3")).toEqual({
      owner: "acme",
      repo: "thing",
      ref: "v1.2.3",
      archiveUrl: "https://codeload.github.com/acme/thing/zip/refs/tags/v1.2.3",
    });
  });

  it("keeps the namespace a direct archive link qualified", async () => {
    expect(await targetFor("https://github.com/acme/thing/archive/refs/heads/main.zip")).toEqual({
      owner: "acme",
      repo: "thing",
      ref: "refs/heads/main",
      archiveUrl: "https://codeload.github.com/acme/thing/zip/refs/heads/main",
    });
  });

  it("lets a typed ref override the link, including a slashed branch name", async () => {
    expect(
      await targetFor("https://github.com/acme/thing/tree/main", "feature/nested-name"),
    ).toEqual({
      owner: "acme",
      repo: "thing",
      ref: "feature/nested-name",
      archiveUrl: "https://codeload.github.com/acme/thing/zip/feature/nested-name",
    });
  });

  it("refuses a link off the repository host, and a typed ref it cannot fetch, by name", async () => {
    const offHost = await previewSuppliedRepositoryAction({
      repoUrl: "https://gitlab.com/acme/thing",
    });
    expect(offHost).toMatchObject({ ok: false });
    if (!offHost.ok) expect(offHost.error).toMatch(/not a github\.com repository link/i);

    const badRef = await previewSuppliedRepositoryAction({
      repoUrl: "https://github.com/acme/thing",
      ref: "../../evil",
    });
    expect(badRef).toMatchObject({ ok: false });
    if (!badRef.ok) expect(badRef.error).toMatch(/is not a branch, tag or commit/i);

    expect(road.previewSuppliedRepositoryArchive).not.toHaveBeenCalled();
  });
});
