// cinatra#1875 W2 (Epic #1873) — AC#6: the MCP audience closure.
// The closure reuses the W1 audience-filtered registry as the single source of
// visibility truth. Injected deps keep this a pure unit test (no DB / server-only
// reader graph) while exercising the real decision logic.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The default deps reference the W1 reader at module load; mock it so importing
// the closure never pulls the DB graph. Tests inject their own deps anyway.
vi.mock("@/lib/assistant-registry-reader", () => ({
  resolveAssistantAudienceContext: vi.fn(),
  readAssistantRegistryForActor: vi.fn(),
}));

import {
  isAssistantInCallerAudience,
  partitionByCallerAudience,
  type AudienceClosureDeps,
  type AudienceCaller,
} from "../assistant-audience-closure";

const caller: AudienceCaller = { userId: "u-1", orgId: "org-1", platformRole: "member" };

/** Deps whose visible registry contains exactly `visibleIds`. Records the ctx it
 *  was asked to resolve so we can assert the caller footprint is threaded. */
function depsWithVisible(visibleIds: string[]): AudienceClosureDeps {
  return {
    resolveContext: async (c) => ({
      userId: c.userId,
      isPlatformAdmin: c.platformRole === "platform_admin",
      orgIds: new Set([c.orgId]),
      teamIds: new Set(),
      projectIds: new Set(),
    }),
    readVisibleRegistry: async () =>
      visibleIds.map((id) => ({
        packageName: `@x/${id}`,
        templateId: `t-${id}`,
        assistantUserId: id,
        handle: id,
        displayName: id,
        origin: "extension" as const,
        aliases: [],
        isBuiltin: false,
        delivery: "host-runtime" as const,
        launch: { kind: "local" as const, targetProvider: null },
      })),
  };
}

describe("isAssistantInCallerAudience", () => {
  it("returns true for a principal in the caller's audience-filtered registry", async () => {
    expect(
      await isAssistantInCallerAudience("u-gem", caller, depsWithVisible(["u-cin", "u-gem"])),
    ).toBe(true);
  });

  it("returns false (404-hide) for an out-of-audience principal", async () => {
    // A forged target: the registry the reader returns for THIS caller omits it.
    expect(
      await isAssistantInCallerAudience("u-secret", caller, depsWithVisible(["u-cin"])),
    ).toBe(false);
  });

  it("returns false for an empty principal id without reading the registry", async () => {
    const read = vi.fn();
    const deps: AudienceClosureDeps = {
      resolveContext: async () => ({
        userId: "u-1",
        isPlatformAdmin: false,
        orgIds: new Set(),
        teamIds: new Set(),
        projectIds: new Set(),
      }),
      readVisibleRegistry: read as never,
    };
    expect(await isAssistantInCallerAudience("", caller, deps)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it("REVOCATION: the same principal denies once the audience shrinks (per-turn re-check)", async () => {
    // Turn 1: in audience.
    expect(await isAssistantInCallerAudience("u-gem", caller, depsWithVisible(["u-gem"]))).toBe(true);
    // Audience revoked → turn 2 (a fresh evaluation) denies.
    expect(await isAssistantInCallerAudience("u-gem", caller, depsWithVisible([]))).toBe(false);
  });
});

describe("partitionByCallerAudience — mention/broadcast continuation", () => {
  it("splits targets into in- and out-of-audience, deduped", async () => {
    const { inAudience, outOfAudience } = await partitionByCallerAudience(
      ["u-cin", "u-gem", "u-secret", "u-cin"],
      caller,
      depsWithVisible(["u-cin", "u-gem"]),
    );
    expect(inAudience.sort()).toEqual(["u-cin", "u-gem"]);
    expect(outOfAudience).toEqual(["u-secret"]);
  });

  it("returns empties without reading the registry for an empty set", async () => {
    const read = vi.fn();
    const deps: AudienceClosureDeps = {
      resolveContext: async () => ({
        userId: "u-1",
        isPlatformAdmin: false,
        orgIds: new Set(),
        teamIds: new Set(),
        projectIds: new Set(),
      }),
      readVisibleRegistry: read as never,
    };
    expect(await partitionByCallerAudience([], caller, deps)).toEqual({
      inAudience: [],
      outOfAudience: [],
    });
    expect(read).not.toHaveBeenCalled();
  });
});
