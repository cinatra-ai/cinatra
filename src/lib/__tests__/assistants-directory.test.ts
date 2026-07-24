// /assistants directory builder (cinatra#1878 W3, AC#4/#5). The build logic runs
// for real; the registry read + instance authority are injected. Proves: exactly
// the actor's audience; remote rows expand per AUTHORIZED instance with both
// actions; remote links match the instance records.
import { describe, expect, it, vi } from "vitest";
import {
  buildAssistantsDirectory,
  resolveRemoteChatForBoundRoute,
  type AssistantsDirectoryDeps,
} from "../assistants-directory.server";
import type { AssistantRegistryEntry } from "../assistant-registry-reader";

function entry(over: Partial<AssistantRegistryEntry> & { packageName: string }): AssistantRegistryEntry {
  return {
    templateId: "t",
    assistantUserId: "au",
    handle: "h",
    displayName: over.packageName,
    origin: "extension",
    aliases: [],
    isBuiltin: false,
    delivery: "host-runtime",
    launch: { kind: "local", targetProvider: null },
    ...over,
  };
}

const CINATRA = entry({
  packageName: "@cinatra-ai/cinatra-assistant",
  displayName: "Cinatra",
  // Ruled shape (owner ruling 2026-07-23 (groganz)): the built-in's ONE tag is its
  // resolving handle `cinatra` (@cinatra), with no builtin alias.
  handle: "cinatra",
  aliases: [],
  isBuiltin: true,
});
const WORDPRESS = entry({
  packageName: "@cinatra-ai/wordpress-assistant",
  displayName: "WordPress",
  handle: "wordpress",
  launch: { kind: "remote", targetProvider: "wordpress" },
});

describe("buildAssistantsDirectory (AC#4)", () => {
  it("lists exactly the actor's audience, builtin first, with local chat hrefs", async () => {
    const deps: AssistantsDirectoryDeps = {
      readVisibleRegistry: async () => [WORDPRESS, CINATRA],
      listAuthorizedInstances: async () => [],
    };
    const rows = await buildAssistantsDirectory(deps);
    expect(rows.map((r) => r.packageName)).toEqual([
      "@cinatra-ai/cinatra-assistant", // builtin sorts first
      "@cinatra-ai/wordpress-assistant",
    ]);
    const cin = rows[0];
    expect(cin.localChatHref).toBe("/chat/cinatra-ai/cinatra-assistant");
    expect(cin.remoteCapable).toBe(false);
    expect(cin.remoteInstances).toEqual([]);
    expect(cin.handle).toBe("cinatra");
    expect(cin.aliases).toEqual([]);
  });

  it("expands a remote row per AUTHORIZED instance with both actions", async () => {
    const listAuthorizedInstances = vi.fn(async () => [
      { id: "wp-1", name: "Marketing Site", siteUrl: "https://mktg.example" },
      { id: "wp-2", name: "Docs", siteUrl: "https://docs.example/blog" },
    ]);
    const rows = await buildAssistantsDirectory({
      readVisibleRegistry: async () => [WORDPRESS],
      listAuthorizedInstances,
    });
    expect(listAuthorizedInstances).toHaveBeenCalledWith("wordpress");
    const wp = rows[0];
    expect(wp.remoteCapable).toBe(true);
    expect(wp.remoteInstances).toEqual([
      {
        instanceId: "wp-1",
        name: "Marketing Site",
        localChatHref: "/chat/cinatra-ai/wordpress-assistant/wp-1",
        remoteHref: "https://mktg.example/wp-admin/",
      },
      {
        instanceId: "wp-2",
        name: "Docs",
        localChatHref: "/chat/cinatra-ai/wordpress-assistant/wp-2",
        remoteHref: "https://docs.example/blog/wp-admin/",
      },
    ]);
  });

  it("drops an instance whose siteUrl is invalid (no broken remote link)", async () => {
    const rows = await buildAssistantsDirectory({
      readVisibleRegistry: async () => [WORDPRESS],
      listAuthorizedInstances: async () => [
        { id: "good", name: "Good", siteUrl: "https://ok.example" },
        { id: "bad", name: "Bad", siteUrl: "not-a-url" },
      ],
    });
    expect(rows[0].remoteInstances.map((i) => i.instanceId)).toEqual(["good"]);
  });

  it("a remote assistant with an unknown provider shows no instances", async () => {
    const listAuthorizedInstances = vi.fn(async () => [
      { id: "x", name: "X", siteUrl: "https://x.example" },
    ]);
    const broken = entry({
      packageName: "@cinatra-ai/mystery-assistant",
      launch: { kind: "remote", targetProvider: "unknown" },
    });
    const rows = await buildAssistantsDirectory({
      readVisibleRegistry: async () => [broken],
      listAuthorizedInstances,
    });
    expect(rows[0].remoteInstances).toEqual([]);
    expect(listAuthorizedInstances).not.toHaveBeenCalled();
  });
});

describe("resolveRemoteChatForBoundRoute (AC#5)", () => {
  it("resolves the flyout href for an authorized instance", async () => {
    const deps: AssistantsDirectoryDeps = {
      readVisibleRegistry: async () => [],
      listAuthorizedInstances: async () => [
        { id: "wp-1", name: "Site", siteUrl: "https://site.example" },
      ],
    };
    const out = await resolveRemoteChatForBoundRoute(
      { targetProvider: "wordpress", instanceId: "wp-1" },
      deps,
    );
    expect(out).toEqual({ href: "https://site.example/wp-admin/" });
  });

  it("returns null for an instance the actor is not authorized for", async () => {
    const out = await resolveRemoteChatForBoundRoute(
      { targetProvider: "wordpress", instanceId: "wp-9" },
      { readVisibleRegistry: async () => [], listAuthorizedInstances: async () => [] },
    );
    expect(out).toBeNull();
  });

  it("returns null for a non-remote / unknown provider", async () => {
    const out = await resolveRemoteChatForBoundRoute(
      { targetProvider: null, instanceId: "x" },
      { readVisibleRegistry: async () => [], listAuthorizedInstances: async () => [] },
    );
    expect(out).toBeNull();
  });
});
