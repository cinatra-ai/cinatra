// Verifies mention resolution reads the platform handle REGISTRY (cinatra#1037
// P1.2), not the un-normalized raw `public."user".username`. The registry helpers
// (@/lib/better-auth-db) are mocked so this pins the wiring: @handle → registry
// lookup → Mention, the reverse id→handle path, and the @cinatra default.

import { describe, it, expect, vi, beforeEach } from "vitest";

const resolveAssistantHandles = vi.fn<(handles: string[]) => Promise<Map<string, string>>>();
const lookupAssistantHandlesByIds = vi.fn<(ids: string[]) => Promise<Map<string, string>>>();

vi.mock("@/lib/better-auth-db", () => ({
  readOrganizationNameForUser: vi.fn(async () => null),
  listOrganizationsForUser: vi.fn(async () => []),
  resolveAssistantHandles: (h: string[]) => resolveAssistantHandles(h),
  lookupAssistantHandlesByIds: (ids: string[]) => lookupAssistantHandlesByIds(ids),
}));

beforeEach(() => {
  resolveAssistantHandles.mockReset();
  lookupAssistantHandlesByIds.mockReset();
});

describe("resolveMentions (registry-backed)", () => {
  it("resolves only handles present in the registry, dropping the rest", async () => {
    resolveAssistantHandles.mockResolvedValue(new Map([["foo", "id-foo"]]));
    const { resolveMentions } = await import("../mentions");

    const out = await resolveMentions([
      { handle: "foo", offset: 3, length: 4 },
      { handle: "ghost", offset: 20, length: 6 },
    ]);

    expect(resolveAssistantHandles).toHaveBeenCalledWith(["foo", "ghost"]);
    expect(out).toEqual([{ handle: "foo", assistantUserId: "id-foo", offset: 3, length: 4 }]);
  });

  it("short-circuits with no DB call on empty input", async () => {
    const { resolveMentions } = await import("../mentions");
    expect(await resolveMentions([])).toEqual([]);
    expect(resolveAssistantHandles).not.toHaveBeenCalled();
  });
});

describe("resolveAssistantsByIds (registry reverse lookup)", () => {
  it("maps principal ids to their registry handles", async () => {
    lookupAssistantHandlesByIds.mockResolvedValue(new Map([["id-foo", "foo"]]));
    const { resolveAssistantsByIds } = await import("../mentions");

    const out = await resolveAssistantsByIds(["id-foo", "id-unregistered"]);

    expect(lookupAssistantHandlesByIds).toHaveBeenCalledWith(["id-foo", "id-unregistered"]);
    expect(out).toEqual([{ handle: "foo", assistantUserId: "id-foo", offset: 0, length: 0 }]);
  });
});

describe("resolveMentionsWithDefault", () => {
  it("falls back to @cinatra (via the registry) when no mention is present", async () => {
    resolveAssistantHandles.mockResolvedValue(new Map([["cinatra", "id-cinatra"]]));
    const { resolveMentionsWithDefault } = await import("../mentions");

    const out = await resolveMentionsWithDefault("just a plain message");

    expect(resolveAssistantHandles).toHaveBeenCalledWith(["cinatra"]);
    expect(out).toEqual([{ handle: "cinatra", assistantUserId: "id-cinatra", offset: 0, length: 0 }]);
  });

  it("returns [] when @cinatra is not registered", async () => {
    resolveAssistantHandles.mockResolvedValue(new Map());
    const { resolveMentionsWithDefault } = await import("../mentions");
    expect(await resolveMentionsWithDefault("plain message")).toEqual([]);
  });

  it("resolves explicit mentions instead of the default when present", async () => {
    resolveAssistantHandles.mockResolvedValue(new Map([["wordpress", "id-wp"]]));
    const { resolveMentionsWithDefault } = await import("../mentions");

    const out = await resolveMentionsWithDefault("hey @wordpress draft a post");

    expect(out).toEqual([{ handle: "wordpress", assistantUserId: "id-wp", offset: 4, length: 10 }]);
  });
});
