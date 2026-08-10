// /chat route guard — the UNBOUND-thread decision table (cinatra#2642).
//
// A thread row with NO `assistant_package` is the documented "unbound
// (implicit-@cinatra)" state, and the CLIENT addresses it at
// `thread.assistantPackage ?? DEFAULT_ASSISTANT_PACKAGE`. The guard's two
// container-scoped lookups (#2589's id fallback + the title-slug match) resolve
// only the EXACT package, so an unbound row was out-of-container for its own
// URL and 404'd. This suite pins the last-resort lookups that close that gap,
// the ORDER they run in, and the gate that keeps them from widening anything.
//
// Deliberately a SEPARATE file: chat-route-resolver.test.ts (the #1878/#2589
// suite) stays byte-unchanged, which is itself the proof that the two new
// lookups are purely additive — its `deps()` factory supplies NEITHER of them
// and every one of its cases still passes (an omitted dep fails MORE closed).
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CHAT_ROUTE_RESOLVER_DEPS,
  resolveChatRoute,
  type ChatRouteResolverDeps,
} from "../chat-route-resolver";
import type { AssistantRegistryEntry } from "../assistant-registry-reader";

function entry(
  over: Partial<AssistantRegistryEntry> & { packageName: string },
): AssistantRegistryEntry {
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
const ACME = entry({ packageName: "@acme/helper-assistant" });
const WORDPRESS = entry({
  packageName: "@cinatra-ai/wordpress-assistant",
  launch: { kind: "remote", targetProvider: "wordpress" },
});

const THREAD_UUID = "cc862657-cbad-4aa9-b815-36eb839510da";

/** Deps whose CONTAINER-scoped lookups both MISS (the unbound row's reality:
 *  it is out-of-container for every package) unless a case says otherwise. */
function deps(over: Partial<ChatRouteResolverDeps> = {}): ChatRouteResolverDeps {
  return {
    readVisibleRegistry: async () => [CINATRA, ACME, WORDPRESS],
    authorizeInstance: async () => true,
    resolveThreadIdBySlug: async () => null,
    resolveThreadIdById: async () => null,
    resolveUnboundThreadIdById: async () => null,
    resolveUnboundThreadIdBySlug: async () => null,
    ...over,
  };
}

describe("unbound-thread resolution (cinatra#2642)", () => {
  it("an unbound thread the actor owns resolves by ID on the default route", async () => {
    const r = await resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant", THREAD_UUID],
      deps({ resolveUnboundThreadIdById: async () => THREAD_UUID }),
    );
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.threadId).toBe(THREAD_UUID);
  });

  it("an unbound thread the actor owns resolves by SLUG on the default route", async () => {
    const r = await resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant", "what-connectors-do-you-have"],
      deps({ resolveUnboundThreadIdBySlug: async () => THREAD_UUID }),
    );
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.threadId).toBe(THREAD_UUID);
  });

  it("a thread NO lookup owns is still 404-hidden", async () => {
    const r = await resolveChatRoute(["cinatra-ai", "cinatra-assistant", THREAD_UUID], deps());
    expect(r.kind).toBe("not-found");
  });

  it("the unbound lookup is NOT consulted when the container lookup already hit", async () => {
    const unboundById = vi.fn(async () => THREAD_UUID);
    const unboundBySlug = vi.fn(async () => THREAD_UUID);
    const r = await resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant", THREAD_UUID],
      deps({
        resolveThreadIdById: async () => "bound-thread",
        resolveUnboundThreadIdById: unboundById,
        resolveUnboundThreadIdBySlug: unboundBySlug,
      }),
    );
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.threadId).toBe("bound-thread");
    expect(unboundById).not.toHaveBeenCalled();
    expect(unboundBySlug).not.toHaveBeenCalled();
  });
});

describe("ordering (cinatra#2642 preserves #2589's id-precedence)", () => {
  it("the unbound ID lookup runs BEFORE the container slug lookup", async () => {
    // A legacy UUID-shaped title_slug in this container must NOT shadow the
    // thread whose actual id that segment is — #2589's rule, extended to the
    // unbound row that #2589's container-scoped id lookup cannot see.
    const order: string[] = [];
    const r = await resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant", THREAD_UUID],
      deps({
        resolveThreadIdBySlug: async () => {
          order.push("container-slug");
          return "slug-owner-thread";
        },
        resolveUnboundThreadIdById: async () => {
          order.push("unbound-id");
          return "id-owner-thread";
        },
      }),
    );
    expect(order).toEqual(["unbound-id"]);
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.threadId).toBe("id-owner-thread");
  });

  it("an EXPLICITLY bound thread beats the unbound slug alias (unbound slug is LAST)", async () => {
    const unboundBySlug = vi.fn(async () => "unbound-thread");
    const r = await resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant", "shared-slug"],
      deps({
        resolveThreadIdBySlug: async () => "bound-thread",
        resolveUnboundThreadIdBySlug: unboundBySlug,
      }),
    );
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.threadId).toBe("bound-thread");
    expect(unboundBySlug).not.toHaveBeenCalled();
  });
});

describe("the implicit-default gate (container security)", () => {
  it("a NON-default assistant's route never consults the unbound lookups", async () => {
    // The database holds NO evidence that a given unbound thread was ever
    // driven by some other assistant, so resolving it there would be exactly
    // the "claim a thread into a package the actor merely names" this gate
    // exists to forbid.
    const unboundById = vi.fn(async () => THREAD_UUID);
    const unboundBySlug = vi.fn(async () => THREAD_UUID);
    const r = await resolveChatRoute(
      ["acme", "helper-assistant", THREAD_UUID],
      deps({
        resolveUnboundThreadIdById: unboundById,
        resolveUnboundThreadIdBySlug: unboundBySlug,
      }),
    );
    expect(r.kind).toBe("not-found");
    expect(unboundById).not.toHaveBeenCalled();
    expect(unboundBySlug).not.toHaveBeenCalled();
  });

  it("an INSTANCE-scoped (remote) route never consults the unbound lookups", async () => {
    const unboundById = vi.fn(async () => THREAD_UUID);
    const r = await resolveChatRoute(
      ["cinatra-ai", "wordpress-assistant", "inst-1", THREAD_UUID],
      deps({ resolveUnboundThreadIdById: unboundById }),
    );
    expect(r.kind).toBe("not-found");
    expect(unboundById).not.toHaveBeenCalled();
  });

  it("the gate is CASE-INSENSITIVE on the package, like the audience match", async () => {
    const r = await resolveChatRoute(
      ["Cinatra-AI", "Cinatra-Assistant", THREAD_UUID],
      deps({ resolveUnboundThreadIdById: async () => THREAD_UUID }),
    );
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.threadId).toBe(THREAD_UUID);
  });

  it("an out-of-audience assistant is still 404 BEFORE any thread lookup runs", async () => {
    const unboundById = vi.fn(async () => THREAD_UUID);
    const r = await resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant", THREAD_UUID],
      deps({ readVisibleRegistry: async () => [], resolveUnboundThreadIdById: unboundById }),
    );
    expect(r.kind).toBe("not-found");
    expect(unboundById).not.toHaveBeenCalled();
  });

  it("an unauthorized instance is still 404 BEFORE any thread lookup runs", async () => {
    const unboundById = vi.fn(async () => THREAD_UUID);
    const r = await resolveChatRoute(
      ["cinatra-ai", "wordpress-assistant", "inst-1", THREAD_UUID],
      deps({ authorizeInstance: async () => false, resolveUnboundThreadIdById: unboundById }),
    );
    expect(r.kind).toBe("not-found");
    expect(unboundById).not.toHaveBeenCalled();
  });
});

describe("additive-by-omission + production wiring", () => {
  it("OMITTING both unbound deps reproduces the pre-#2642 behaviour exactly", async () => {
    const bare: ChatRouteResolverDeps = {
      readVisibleRegistry: async () => [CINATRA],
      authorizeInstance: async () => true,
      resolveThreadIdBySlug: async () => null,
      resolveThreadIdById: async () => null,
    };
    const r = await resolveChatRoute(["cinatra-ai", "cinatra-assistant", THREAD_UUID], bare);
    expect(r.kind).toBe("not-found");
  });

  it("the PRODUCTION deps supply both unbound lookups", () => {
    // Guards the wiring: the optional deps exist so an injected-dep caller can
    // fail closed, NOT so production can silently lose the repair path.
    expect(typeof DEFAULT_CHAT_ROUTE_RESOLVER_DEPS.resolveUnboundThreadIdById).toBe("function");
    expect(typeof DEFAULT_CHAT_ROUTE_RESOLVER_DEPS.resolveUnboundThreadIdBySlug).toBe("function");
  });
});
