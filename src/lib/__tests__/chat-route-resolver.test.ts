// /chat route GUARD (cinatra#1878 W3, AC#3). The guard LOGIC runs for real; only
// the DATA sources (registry read / instance auth / thread lookup) are injected.
// Proves: unknown/out-of-audience ⇒ 404 on bare, instance, and thread paths;
// actor A never resolves actor B's instance; grammar redirects/invalids.
import { describe, expect, it, vi } from "vitest";
import {
  resolveChatRoute,
  type ChatRouteResolverDeps,
} from "../chat-route-resolver";
import type { AssistantRegistryEntry } from "../assistant-registry-reader";

function entry(over: Partial<AssistantRegistryEntry> & { packageName: string }): AssistantRegistryEntry {
  return {
    templateId: "t",
    assistantUserId: "au",
    handle: "h",
    displayName: "Name",
    origin: "extension",
    aliases: [],
    isBuiltin: false,
    delivery: "host-runtime",
    launch: { kind: "local", targetProvider: null },
    ...over,
  };
}

const CINATRA = entry({ packageName: "@cinatra-ai/cinatra-assistant", isBuiltin: true });
const WORDPRESS = entry({
  packageName: "@cinatra-ai/wordpress-assistant",
  launch: { kind: "remote", targetProvider: "wordpress" },
});

function deps(over: Partial<ChatRouteResolverDeps> = {}): ChatRouteResolverDeps {
  return {
    readVisibleRegistry: async () => [CINATRA, WORDPRESS],
    authorizeInstance: async () => true,
    resolveThreadIdBySlug: async () => "thread-uuid-1",
    ...over,
  };
}

describe("grammar", () => {
  it("bare /chat redirects to the canonical default", async () => {
    const r = await resolveChatRoute([], deps());
    expect(r).toEqual({ kind: "redirect", to: "/chat/cinatra-ai/cinatra-assistant" });
  });
  it("a lone legacy /chat/<uuid> segment is not-found (dead)", async () => {
    const r = await resolveChatRoute(["3f2504e0-4f89-11d3-9a0c-0305e82c3301"], deps());
    expect(r.kind).toBe("not-found");
  });
});

describe("assistant audience gate (AC#3)", () => {
  it("resolves an in-audience assistant's bare route (new/empty chat)", async () => {
    const r = await resolveChatRoute(["cinatra-ai", "cinatra-assistant"], deps());
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") {
      expect(r.assistant.packageName).toBe("@cinatra-ai/cinatra-assistant");
      expect(r.threadId).toBeNull();
      expect(r.route).toEqual({ vendor: "cinatra-ai", slug: "cinatra-assistant" });
    }
  });

  it("an UNKNOWN / out-of-audience assistant is 404 on the BARE path", async () => {
    const r = await resolveChatRoute(["acme", "secret-assistant"], deps());
    expect(r.kind).toBe("not-found");
  });

  it("an out-of-audience assistant is 404 on the THREAD path too", async () => {
    const r = await resolveChatRoute(["acme", "secret-assistant", "some-thread"], deps());
    expect(r.kind).toBe("not-found");
  });

  it("an out-of-audience assistant is 404 on the INSTANCE path too", async () => {
    const r = await resolveChatRoute(["acme", "secret-assistant", "inst", "thr"], deps());
    expect(r.kind).toBe("not-found");
  });

  it("the registry read is scoped to the actor (empty registry ⇒ everything 404s)", async () => {
    const r = await resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant"],
      deps({ readVisibleRegistry: async () => [] }),
    );
    expect(r.kind).toBe("not-found");
  });
});

describe("local vs remote disambiguation", () => {
  it("a LOCAL assistant: 3rd segment is a thread slug", async () => {
    const r = await resolveChatRoute(["cinatra-ai", "cinatra-assistant", "weekly-sync"], deps());
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") {
      expect(r.route).toEqual({ vendor: "cinatra-ai", slug: "cinatra-assistant", titleSlug: "weekly-sync" });
      expect(r.threadId).toBe("thread-uuid-1");
    }
  });

  it("a LOCAL assistant: a 2-segment tail is invalid (404)", async () => {
    const r = await resolveChatRoute(["cinatra-ai", "cinatra-assistant", "a", "b"], deps());
    expect(r.kind).toBe("not-found");
  });

  it("a REMOTE assistant: 3rd segment is an instance (new site-scoped chat)", async () => {
    const r = await resolveChatRoute(["cinatra-ai", "wordpress-assistant", "site-9"], deps());
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") {
      expect(r.route).toEqual({ vendor: "cinatra-ai", slug: "wordpress-assistant", instance: "site-9" });
      expect(r.threadId).toBeNull();
      expect(r.assistant.remoteCapable).toBe(true);
    }
  });

  it("a REMOTE assistant: instance + thread resolves both", async () => {
    const r = await resolveChatRoute(
      ["cinatra-ai", "wordpress-assistant", "site-9", "launch-plan"],
      deps(),
    );
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") {
      expect(r.route).toEqual({
        vendor: "cinatra-ai",
        slug: "wordpress-assistant",
        instance: "site-9",
        titleSlug: "launch-plan",
      });
    }
  });
});

describe("per-instance re-authorization (AC#3 — actor A ≠ actor B)", () => {
  it("404s a remote instance the actor is NOT authorized for", async () => {
    const authorizeInstance = vi.fn(async () => false);
    const r = await resolveChatRoute(
      ["cinatra-ai", "wordpress-assistant", "site-B"],
      deps({ authorizeInstance }),
    );
    expect(r.kind).toBe("not-found");
    expect(authorizeInstance).toHaveBeenCalledWith("wordpress", "site-B");
  });

  it("passes the resolved connector kind + instance to the authority", async () => {
    const authorizeInstance = vi.fn(async () => true);
    await resolveChatRoute(
      ["cinatra-ai", "wordpress-assistant", "site-A", "thr"],
      deps({ authorizeInstance }),
    );
    expect(authorizeInstance).toHaveBeenCalledWith("wordpress", "site-A");
  });

  it("404s a remote assistant whose targetProvider has no first-party resolver", async () => {
    const brokenRemote = entry({
      packageName: "@cinatra-ai/mystery-assistant",
      launch: { kind: "remote", targetProvider: "unknown-provider" },
    });
    const r = await resolveChatRoute(
      ["cinatra-ai", "mystery-assistant", "some-instance"],
      deps({ readVisibleRegistry: async () => [brokenRemote] }),
    );
    expect(r.kind).toBe("not-found");
  });
});

describe("thread resolution (AC#3)", () => {
  it("404s a titleSlug with no matching thread in the container", async () => {
    const r = await resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant", "ghost-thread"],
      deps({ resolveThreadIdBySlug: async () => null }),
    );
    expect(r.kind).toBe("not-found");
  });

  it("looks the thread up in the EXACT container (package + instance)", async () => {
    const resolveThreadIdBySlug = vi.fn(async () => "th-77");
    await resolveChatRoute(
      ["cinatra-ai", "wordpress-assistant", "site-9", "roadmap"],
      deps({ resolveThreadIdBySlug }),
    );
    expect(resolveThreadIdBySlug).toHaveBeenCalledWith(
      "@cinatra-ai/wordpress-assistant",
      "site-9",
      "roadmap",
    );
  });
});
