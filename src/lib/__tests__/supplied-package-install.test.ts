/**
 * THE ROAD THE UPLOAD SCREEN TAKES (cinatra#3204 leg 3 — criteria 7, 8, 18, 19,
 * 20, 22 and the anchor half of 28).
 *
 * The claims:
 *   - a repository install re-reads AT THE PIN and refuses a commit or a digest
 *     that does not reproduce, before anything is packed or staged;
 *   - the kind's own validator runs before the packer on this road too;
 *   - the install goes through the SAME dispatcher a store install goes through,
 *     carrying the DECLARED provenance and the CHOSEN row anchor — so the row is
 *     never a registry claim and never anchored somewhere the operator did not
 *     choose;
 *   - two different anchors for the same package are two different row
 *     identities (the tenancy separation the anchor is for).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// The ORDER of the two things the dispatch entry does, recorded as it happens.
// `extensionRegistry` is per-process state: a Server Action worker holds only
// the handlers something in its own import graph registered, so a road that
// dispatches without pulling the registration in first answers every kind with
// `No extension handler registered for typeId: "<kind>"`.
const order = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock("@cinatra-ai/extensions/handler-bootstrap", () => {
  order.events.push("handlers-registered");
  return {};
});

const registry = vi.hoisted(() => ({
  extensionRegistry: {
    install: vi.fn(async () => {
      order.events.push("dispatch");
    }),
  },
}));
vi.mock("@cinatra-ai/extensions", () => registry);

const intake = vi.hoisted(() => ({
  fetchGitHubSuppliedPackageAtPin: vi.fn(),
}));
vi.mock("@cinatra-ai/skills/repository-package-intake", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchGitHubSuppliedPackageAtPin: (...a: unknown[]) =>
    intake.fetchGitHubSuppliedPackageAtPin(...(a as [])),
}));

import {
  installSuppliedCandidate,
  prepareSuppliedRepositorySnapshot,
} from "@/lib/supplied-package-install";
import { SUPPLIED_PACKAGE_ORIGIN } from "@/lib/extension-install-pipeline";

const SHA = "b".repeat(40);
const DIGEST = "a".repeat(64);
const OTHER = "c".repeat(64);

function stagedPackage(over: Record<string, unknown> = {}) {
  return {
    kind: "skill",
    packageName: "@acme/thing-skill",
    version: "1.0.0",
    packageJson: JSON.stringify({
      name: "@acme/thing-skill",
      version: "1.0.0",
      cinatra: { kind: "skill" },
    }),
    payload: new Map(),
    contentDigest: DIGEST,
    strippedPrefix: null,
    deliveredEntries: new Map([["package.json", new Uint8Array([123, 125])]]),
    repo: "acme/thing",
    ref: "main",
    resolvedSha: SHA,
    treeSha: "t".repeat(40),
    entryCount: 1,
    totalBytes: 2,
    provenance: {
      type: "github",
      repo: "acme/thing",
      ref: "main",
      resolvedSha: SHA,
      contentDigest: DIGEST,
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  intake.fetchGitHubSuppliedPackageAtPin.mockResolvedValue(stagedPackage());
});

describe("the repository road re-reads AT THE PIN (criterion 7)", () => {
  it("stages the snapshot and records github provenance carrying the pinned sha", async () => {
    const stageSnapshot = vi.fn(async (digest: string) => `${digest}.tgz`);
    const prepared = await prepareSuppliedRepositorySnapshot({
      client: {} as never,
      owner: "acme",
      repo: "thing",
      ref: "main",
      pin: { resolvedSha: SHA, contentDigest: DIGEST },
      resolveValidator: async () => null,
      stageSnapshot,
    });
    expect(prepared.kind).toBe("skill");
    expect(prepared.resolvedSha).toBe(SHA);
    expect(prepared.provenance).toMatchObject({
      type: "github",
      repo: "acme/thing",
      resolvedSha: SHA,
      contentDigest: DIGEST,
      path: `${DIGEST}.tgz`,
    });
    // The ref is NOT resolved again — only the pinned read happens.
    expect(intake.fetchGitHubSuppliedPackageAtPin).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed pin before a single request is made", async () => {
    await expect(
      prepareSuppliedRepositorySnapshot({
        client: {} as never,
        owner: "acme",
        repo: "thing",
        ref: "main",
        pin: { resolvedSha: "not-a-sha", contentDigest: DIGEST },
      }),
    ).rejects.toThrow(/immutable 40-character commit sha/);
    expect(intake.fetchGitHubSuppliedPackageAtPin).not.toHaveBeenCalled();
  });

  it("refuses when the repository no longer delivers the previewed bytes, staging nothing", async () => {
    intake.fetchGitHubSuppliedPackageAtPin.mockResolvedValue(
      stagedPackage({ contentDigest: OTHER, provenance: { type: "github", repo: "acme/thing", ref: "main", resolvedSha: SHA, contentDigest: OTHER } }),
    );
    const stageSnapshot = vi.fn(async () => "never.tgz");
    await expect(
      prepareSuppliedRepositorySnapshot({
        client: {} as never,
        owner: "acme",
        repo: "thing",
        ref: "main",
        pin: { resolvedSha: SHA, contentDigest: DIGEST },
        resolveValidator: async () => null,
        stageSnapshot,
      }),
    ).rejects.toThrow(/no longer delivers the previewed bytes/);
    expect(stageSnapshot).not.toHaveBeenCalled();
  });

  it("runs the kind's own validator before the packer, and refuses when it rejects", async () => {
    const stageSnapshot = vi.fn(async () => "never.tgz");
    await expect(
      prepareSuppliedRepositorySnapshot({
        client: {} as never,
        owner: "acme",
        repo: "thing",
        ref: "main",
        pin: { resolvedSha: SHA, contentDigest: DIGEST },
        resolveValidator: async () => async () => ({ valid: false, errors: ["nope"] }),
        stageSnapshot,
      }),
    ).rejects.toThrow(/did not pass the skill validator/);
    expect(stageSnapshot).not.toHaveBeenCalled();
  });
});

describe("both roads end at the SAME dispatcher (criteria 18, 19, 20)", () => {
  it("hands the dispatcher the declared provenance and the chosen anchor", async () => {
    await installSuppliedCandidate({
      candidate: {
        kind: "artifact",
        packageName: "@acme/thing-artifact",
        version: "2.0.0",
        provenance: { type: "local", path: `${DIGEST}.tgz`, contentDigest: DIGEST },
        validatorRan: true,
      },
      actor: { actorType: "human", source: "ui", userId: "u1", orgId: "org-1" },
      rowOwnership: { ownerLevel: "workspace", ownerId: null, organizationId: null },
    });

    expect(registry.extensionRegistry.install).toHaveBeenCalledTimes(1);
    const [typeId, ref, , options] = registry.extensionRegistry.install.mock
      .calls[0] as unknown as [
      string,
      Record<string, unknown>,
      unknown,
      { rowOwnership: Record<string, unknown> },
    ];
    // The KIND decides the handler — the ordering contract is the dispatcher's.
    expect(typeId).toBe("artifact");
    expect(ref.provenance).toMatchObject({ type: "local", contentDigest: DIGEST });
    // Never a registry URL: a supplied package was on no registry.
    expect(ref.registryUrl).toBe(SUPPLIED_PACKAGE_ORIGIN);
    expect(String(ref.registryUrl)).not.toMatch(/^https?:/);
    expect(options.rowOwnership).toEqual({
      ownerLevel: "workspace",
      ownerId: null,
      organizationId: null,
    });
  });

  it("two anchors for the same package are two different row identities (criterion 28)", async () => {
    const candidate = {
      kind: "artifact" as const,
      packageName: "@acme/thing-artifact",
      version: "2.0.0",
      provenance: { type: "local" as const, path: `${DIGEST}.tgz`, contentDigest: DIGEST },
      validatorRan: true,
    };
    const actor = { actorType: "human" as const, source: "ui" as const, userId: "u1", orgId: "org-1" };
    await installSuppliedCandidate({
      candidate,
      actor,
      rowOwnership: { ownerLevel: "organization", ownerId: "org-1", organizationId: "org-1" },
    });
    await installSuppliedCandidate({
      candidate,
      actor,
      rowOwnership: { ownerLevel: "organization", ownerId: "org-2", organizationId: "org-2" },
    });
    const calls = registry.extensionRegistry.install.mock.calls as unknown as unknown[][];
    const first = calls[0]![3] as { rowOwnership: unknown };
    const second = calls[1]![3] as { rowOwnership: unknown };
    expect(first.rowOwnership).not.toEqual(second.rowOwnership);
  });
});

describe("the dispatch entry registers the handler set in its OWN worker (cinatra#3204)", () => {
  it("loads the handler bootstrap BEFORE it dispatches, so no kind meets an empty registry", async () => {
    await installSuppliedCandidate({
      candidate: {
        kind: "skill",
        packageName: "@acme/thing-skill",
        version: "1.0.0",
        provenance: { type: "local", path: "x.tgz", contentDigest: DIGEST },
        validatorRan: true,
      },
      actor: { actorType: "human", source: "ui", userId: "u1", orgId: "org-1" },
      rowOwnership: { ownerLevel: "workspace", ownerId: null, organizationId: null },
    });
    // The very first thing that happened on this road, whichever test got here
    // first, is the registration — never a dispatch into an unpopulated registry.
    expect(order.events[0]).toBe("handlers-registered");
    expect(order.events).toContain("dispatch");
  });
});
