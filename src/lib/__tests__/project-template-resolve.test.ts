import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Unit tests for the installed-package resolution seams (cinatra#1032
// deliverable 3): the ORG-SCOPE RESOLUTION RULE (exact-org first, then the
// PLATFORM-SCOPE `orgId: null` fallback — NEVER the omitted-orgId
// platform-GLOBAL resolution, which could surface a FOREIGN org's single live
// row), the fail-closed manifest read, and the installed-template resolution's
// discriminated misses. The finalized-store resolver (anchor + fs IO) is
// mocked; the PM-seat predicate and template validation run REAL.

const mocks = vi.hoisted(() => ({
  resolveFinalizedStorePayload: vi.fn(),
}));

vi.mock("@/lib/extension-store-payload", () => ({
  resolveFinalizedStorePayload: mocks.resolveFinalizedStorePayload,
}));

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveInstalledAgentManifest,
  resolveInstalledProjectTemplate,
  agentManifestDeclaresPmSeat,
} from "@/lib/project-template-resolve";

let storeDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  storeDir = await mkdtemp(join(tmpdir(), "resolve-store-"));
  await writeFile(
    join(storeDir, "package.json"),
    JSON.stringify({
      name: "@cinatra-ai/project-manager-agent",
      cinatra: { consumes: [{ primitive: "pm-work-store", requirement: "required" }] },
    }),
    "utf8",
  );
});
afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

const payload = () => ({ storeDir, digest: "digest-1", version: "1.0.0", registryUrl: null });

describe("org-scope resolution rule", () => {
  it("resolves the EXACT-ORG anchor first (no fallback call on a hit)", async () => {
    mocks.resolveFinalizedStorePayload.mockResolvedValueOnce(payload());
    const out = await resolveInstalledAgentManifest("@cinatra-ai/project-manager-agent", "org-A");
    expect(out).toMatchObject({ digest: "digest-1" });
    expect(mocks.resolveFinalizedStorePayload).toHaveBeenCalledTimes(1);
    expect(mocks.resolveFinalizedStorePayload).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-A", expectedKind: "agent" }),
    );
  });

  it("falls back to the PLATFORM SCOPE with an EXPLICIT orgId: null — never the omitted-orgId global resolution", async () => {
    mocks.resolveFinalizedStorePayload
      .mockResolvedValueOnce(null) // exact-org miss
      .mockResolvedValueOnce(payload()); // platform-scope hit
    const out = await resolveInstalledAgentManifest("@cinatra-ai/project-manager-agent", "org-A");
    expect(out).toMatchObject({ digest: "digest-1" });
    expect(mocks.resolveFinalizedStorePayload).toHaveBeenCalledTimes(2);
    const secondCall = mocks.resolveFinalizedStorePayload.mock.calls[1][0];
    // The property must be PRESENT and null (exact platform-scope resolution),
    // not omitted (which would be the cross-org single-live-row semantics).
    expect(Object.prototype.hasOwnProperty.call(secondCall, "orgId")).toBe(true);
    expect(secondCall.orgId).toBeNull();
  });

  it("returns null (fail-closed) when both scopes miss", async () => {
    mocks.resolveFinalizedStorePayload.mockResolvedValue(null);
    expect(
      await resolveInstalledAgentManifest("@cinatra-ai/project-manager-agent", "org-A"),
    ).toBeNull();
  });

  it("returns null (fail-closed) on an unreadable/unparsable store manifest", async () => {
    mocks.resolveFinalizedStorePayload.mockResolvedValue({ ...payload(), storeDir: "/nonexistent" });
    expect(
      await resolveInstalledAgentManifest("@cinatra-ai/project-manager-agent", "org-A"),
    ).toBeNull();
  });
});

describe("resolveInstalledProjectTemplate discriminated misses", () => {
  it("not_installed when no finalized payload resolves", async () => {
    mocks.resolveFinalizedStorePayload.mockResolvedValue(null);
    expect(await resolveInstalledProjectTemplate("@x/y", "org-A")).toEqual({
      ok: false,
      reason: "not_installed",
    });
  });

  it("no_template when the installed package ships none", async () => {
    mocks.resolveFinalizedStorePayload.mockResolvedValue(payload());
    expect(await resolveInstalledProjectTemplate("@x/y", "org-A")).toMatchObject({
      ok: false,
      reason: "no_template",
    });
  });

  it("template_invalid on an installed-but-invalid template; ok with digest on a valid one", async () => {
    mocks.resolveFinalizedStorePayload.mockResolvedValue(payload());
    await mkdir(join(storeDir, "cinatra"), { recursive: true });
    await writeFile(join(storeDir, "cinatra", "project-template.json"), "{ nope", "utf8");
    expect(await resolveInstalledProjectTemplate("@x/y", "org-A")).toMatchObject({
      ok: false,
      reason: "template_invalid",
    });

    await writeFile(
      join(storeDir, "cinatra", "project-template.json"),
      JSON.stringify({
        formatVersion: "cinatra.ai/project-template@1",
        id: "launch-plan",
        name: "Launch plan",
        anchor: { id: "launch" },
        tasks: [{ id: "draft", title: "Draft" }],
      }),
      "utf8",
    );
    expect(await resolveInstalledProjectTemplate("@x/y", "org-A")).toMatchObject({
      ok: true,
      digest: "digest-1",
      template: { id: "launch-plan" },
    });
  });
});

describe("agentManifestDeclaresPmSeat (pure predicate)", () => {
  it("true only for a REQUIRED pm-work-store consumes declaration", () => {
    expect(
      agentManifestDeclaresPmSeat({
        cinatra: { consumes: [{ primitive: "pm-work-store", requirement: "required" }] },
      }),
    ).toBe(true);
    expect(
      agentManifestDeclaresPmSeat({
        cinatra: { consumes: [{ primitive: "pm-work-store", requirement: "optional" }] },
      }),
    ).toBe(false);
    expect(agentManifestDeclaresPmSeat({ cinatra: {} })).toBe(false);
    // Malformed block (explicit null) fails CLOSED, not loud.
    expect(agentManifestDeclaresPmSeat({ cinatra: { consumes: null } })).toBe(false);
  });
});
