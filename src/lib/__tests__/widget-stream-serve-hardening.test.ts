import { describe, it, expect, vi } from "vitest";

// Widget-stream runtime trust, slice 5 — the §7b public-surface hardening around
// the runtime resolver arm: single-flight, positive/negative caching with a
// short bounded backoff, a per-source rate limit charged ONLY on the expensive
// (cache-missing) verification path, and opaque outcomes with an audit sink.
//
// Every case is DB-free: the expensive resolver, the clock, the state, and the
// audit sink are injected seams. The KEY safety property — a positive-cached
// resolution can NEVER become an authorization bypass — is proven at the end:
// the cache serves the pinned descriptor, but `reassertWidgetStreamGrantBefore
// OboRun` re-validates LIVE and fails closed the instant the grant is revoked.

import {
  hardenedResolveWidgetStreamRuntime,
  createWidgetStreamServeHardeningState,
  reassertWidgetStreamGrantBeforeOboRun,
  resolveWidgetStreamAgent,
  resolveWidgetStreamAgentUnion,
  widgetStreamRequestSource,
  __resetWidgetStreamServeHardeningForTests,
  type ResolvedWidgetStreamAgent,
  type ResolvedWidgetStreamGrant,
  type WidgetStreamAgent,
  type WidgetStreamServeHardeningSeams,
  type WidgetStreamServeAuditEvent,
} from "@/lib/widget-stream-agents.server";

const PKG = "@cinatra-ai/wordpress-mcp-connector";
const WS_SERVE_RATE_MAX = 240; // mirrors the module constant

function fakeResolved(
  slug: string,
  grant?: Partial<ResolvedWidgetStreamGrant> | null,
): ResolvedWidgetStreamAgent {
  const g: ResolvedWidgetStreamGrant | null =
    grant === undefined || grant === null
      ? null
      : {
          agentSlug: slug,
          packageName: PKG,
          bindingHashV2: "hash-v2",
          anchorDigest: "d".repeat(64),
          grantRowVersion: 1,
          tokenConfigKey: "wordpress_widget_auth",
          moduleExportKey: "./widget-chat-tool",
          ...grant,
        };
  return { agentSlug: slug, entry: {} as WidgetStreamAgent, grant: g };
}

function freshSeams(): { seams: WidgetStreamServeHardeningSeams; advance: (ms: number) => void; audits: WidgetStreamServeAuditEvent[] } {
  let clock = 1_000;
  const audits: WidgetStreamServeAuditEvent[] = [];
  return {
    seams: {
      state: createWidgetStreamServeHardeningState(),
      now: () => clock,
      audit: (e) => audits.push(e),
    },
    advance: (ms) => {
      clock += ms;
    },
    audits,
  };
}

describe("single-flight — concurrent identical verifications coalesce to one", () => {
  it("N concurrent resolves for the same slug call the expensive resolver ONCE", async () => {
    const { seams } = freshSeams();
    let release!: (v: ResolvedWidgetStreamAgent | null) => void;
    const gate = new Promise<ResolvedWidgetStreamAgent | null>((r) => (release = r));
    const resolveExpensive = vi.fn(() => gate);

    const p1 = hardenedResolveWidgetStreamRuntime("slug-a", undefined, resolveExpensive, seams);
    const p2 = hardenedResolveWidgetStreamRuntime("slug-a", undefined, resolveExpensive, seams);
    const p3 = hardenedResolveWidgetStreamRuntime("slug-a", undefined, resolveExpensive, seams);
    release(fakeResolved("slug-a"));
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(resolveExpensive).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });

  it("a settled single-flight is cleared so the next miss re-resolves", async () => {
    const { seams } = freshSeams();
    const resolveExpensive = vi.fn(async () => null); // null → negative-cached
    await hardenedResolveWidgetStreamRuntime("slug-b", undefined, resolveExpensive, seams);
    // Same slug within the negative backoff would be cached; a DIFFERENT slug is
    // a fresh miss and must reach the resolver (proves inflight cleared).
    await hardenedResolveWidgetStreamRuntime("slug-c", undefined, resolveExpensive, seams);
    expect(resolveExpensive).toHaveBeenCalledTimes(2);
  });
});

describe("positive cache — short ttl, then re-resolves", () => {
  it("serves a successful resolution from cache within the ttl, re-resolves after it", async () => {
    const { seams, advance } = freshSeams();
    const resolved = fakeResolved("slug-pos");
    const resolveExpensive = vi.fn(async () => resolved);

    const first = await hardenedResolveWidgetStreamRuntime("slug-pos", undefined, resolveExpensive, seams);
    const cached = await hardenedResolveWidgetStreamRuntime("slug-pos", undefined, resolveExpensive, seams);
    expect(first).toBe(resolved);
    expect(cached).toBe(resolved); // same pinned descriptor, no re-resolve
    expect(resolveExpensive).toHaveBeenCalledTimes(1);

    advance(5_001); // past WS_SERVE_POSITIVE_TTL_MS
    await hardenedResolveWidgetStreamRuntime("slug-pos", undefined, resolveExpensive, seams);
    expect(resolveExpensive).toHaveBeenCalledTimes(2);
  });
});

describe("negative cache — bounded backoff self-heals", () => {
  it("caches a null within the backoff, then re-resolves (a fresh approval propagates)", async () => {
    const { seams, advance } = freshSeams();
    const resolveExpensive = vi.fn(async (): Promise<ResolvedWidgetStreamAgent | null> => null);

    expect(await hardenedResolveWidgetStreamRuntime("slug-neg", undefined, resolveExpensive, seams)).toBeNull();
    expect(await hardenedResolveWidgetStreamRuntime("slug-neg", undefined, resolveExpensive, seams)).toBeNull();
    expect(resolveExpensive).toHaveBeenCalledTimes(1); // 2nd served from negative cache

    advance(3_001); // past WS_SERVE_NEGATIVE_TTL_MS
    // Now the slug has been approved — the resolver would return an entry.
    resolveExpensive.mockResolvedValueOnce(fakeResolved("slug-neg"));
    expect(await hardenedResolveWidgetStreamRuntime("slug-neg", undefined, resolveExpensive, seams)).not.toBeNull();
    expect(resolveExpensive).toHaveBeenCalledTimes(2);
  });
});

describe("per-source rate limit — only the expensive path, self-healing", () => {
  it("allows up to the cap of DISTINCT verifications per source, then opaque-nulls + audits", async () => {
    const { seams, audits } = freshSeams();
    const resolveExpensive = vi.fn(async () => null);
    const opts = { requestSource: "1.2.3.4" };

    for (let i = 0; i < WS_SERVE_RATE_MAX; i++) {
      // distinct slugs → each a fresh cache miss that charges the limiter
      await hardenedResolveWidgetStreamRuntime(`s-${i}`, opts, resolveExpensive, seams);
    }
    expect(resolveExpensive).toHaveBeenCalledTimes(WS_SERVE_RATE_MAX);
    expect(audits).toHaveLength(0);

    // One over the cap → refused BEFORE the resolver, opaque null + audit.
    const over = await hardenedResolveWidgetStreamRuntime("s-over", opts, resolveExpensive, seams);
    expect(over).toBeNull();
    expect(resolveExpensive).toHaveBeenCalledTimes(WS_SERVE_RATE_MAX); // NOT called for the refused one
    expect(audits).toEqual([{ agentSlug: "s-over", outcome: "rate-limited", source: "1.2.3.4" }]);
  });

  it("a rate-limited refusal is NOT cached — it self-heals when the window resets", async () => {
    const { seams, advance } = freshSeams();
    const resolveExpensive = vi.fn(async () => null);
    const opts = { requestSource: "9.9.9.9" };
    for (let i = 0; i < WS_SERVE_RATE_MAX; i++) {
      await hardenedResolveWidgetStreamRuntime(`d-${i}`, opts, resolveExpensive, seams);
    }
    expect(await hardenedResolveWidgetStreamRuntime("d-x", opts, resolveExpensive, seams)).toBeNull();
    const callsAtLimit = resolveExpensive.mock.calls.length;

    advance(60_001); // past WS_SERVE_RATE_WINDOW_MS
    await hardenedResolveWidgetStreamRuntime("d-x", opts, resolveExpensive, seams);
    expect(resolveExpensive.mock.calls.length).toBe(callsAtLimit + 1); // reached the resolver now
  });

  it("no source ⇒ never rate-limited (a missing source cannot throttle a serve)", async () => {
    const { seams, audits } = freshSeams();
    const resolveExpensive = vi.fn(async () => null);
    for (let i = 0; i < WS_SERVE_RATE_MAX + 5; i++) {
      await hardenedResolveWidgetStreamRuntime(`n-${i}`, undefined, resolveExpensive, seams);
    }
    expect(resolveExpensive).toHaveBeenCalledTimes(WS_SERVE_RATE_MAX + 5);
    expect(audits).toHaveLength(0);
  });

  it("coalesced single-flight joiners do NOT each charge the limiter", async () => {
    const { seams } = freshSeams();
    let release!: (v: ResolvedWidgetStreamAgent | null) => void;
    const gate = new Promise<ResolvedWidgetStreamAgent | null>((r) => (release = r));
    const resolveExpensive = vi.fn(() => gate);
    const opts = { requestSource: "7.7.7.7" };

    // Fire WS_SERVE_RATE_MAX concurrent requests for the SAME slug: they coalesce
    // to ONE verification → ONE charge, not WS_SERVE_RATE_MAX charges.
    const inflight = Array.from({ length: WS_SERVE_RATE_MAX }, () =>
      hardenedResolveWidgetStreamRuntime("same-slug", opts, resolveExpensive, seams),
    );
    release(null);
    await Promise.all(inflight);
    expect(resolveExpensive).toHaveBeenCalledTimes(1);

    // Budget consumed = 1, so WS_SERVE_RATE_MAX-1 more DISTINCT verifications are
    // still allowed and the next one after that is the first to be refused.
    const later = vi.fn(async () => null);
    for (let i = 0; i < WS_SERVE_RATE_MAX - 1; i++) {
      expect(await hardenedResolveWidgetStreamRuntime(`later-${i}`, opts, later, seams)).toBeNull();
    }
    // Now the budget is exhausted.
    const refused = vi.fn(async () => fakeResolved("would-resolve"));
    expect(await hardenedResolveWidgetStreamRuntime("refused", opts, refused, seams)).toBeNull();
    expect(refused).not.toHaveBeenCalled();
  });
});

describe("union deps-bypass — the injected-authority path is unhardened", () => {
  it("resolveWidgetStreamAgentUnion(slug, deps) does NOT cache — the runtime arm runs each call", async () => {
    __resetWidgetStreamServeHardeningForTests();
    let queries = 0;
    const metadataGrantDeps = {
      query: async () => {
        queries += 1;
        return [] as never[]; // no approved grant → runtime arm null
      },
    };
    const slug = "serve-hardening-bypass-slug"; // not in the build map
    expect(await resolveWidgetStreamAgentUnion(slug, { metadataGrantDeps })).toBeNull();
    expect(await resolveWidgetStreamAgentUnion(slug, { metadataGrantDeps })).toBeNull();
    // Two full runtime-arm runs (no positive/negative cache on the deps path).
    expect(queries).toBe(2);
  });
});

describe("prototype-pollution guard — inherited Object keys are never build entries", () => {
  it("resolveWidgetStreamAgent returns null for inherited keys (constructor/toString/__proto__), never an Object member", () => {
    // A bare index access would return a truthy INHERITED member for these,
    // mis-classifying an attacker-controlled slug as a baked (grant: null,
    // re-assert-skipped) build entry. The own-property guard fails closed.
    for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"]) {
      expect(resolveWidgetStreamAgent(key)).toBeNull();
    }
  });

  it("resolveWidgetStreamAgentUnion does not classify an inherited key as a build entry", async () => {
    __resetWidgetStreamServeHardeningForTests();
    // deps make the runtime arm deterministic (no approved grant → null). If the
    // build lookup were prototype-sensitive, `constructor` would short-circuit to
    // a build entry BEFORE the runtime arm and the injected query would never run.
    let queried = false;
    const metadataGrantDeps = {
      query: async () => {
        queried = true;
        return [] as never[];
      },
    };
    expect(await resolveWidgetStreamAgentUnion("constructor", { metadataGrantDeps })).toBeNull();
    expect(queried).toBe(true); // reached the fail-closed runtime arm, not a build short-circuit
  });
});

describe("widgetStreamRequestSource", () => {
  it("takes the first x-forwarded-for hop, trims it, and falls back to 'unknown'", () => {
    const src = (xff: string | null) =>
      widgetStreamRequestSource(new Request("https://h/x", xff === null ? {} : { headers: { "x-forwarded-for": xff } }));
    expect(src("1.2.3.4, 5.6.7.8")).toBe("1.2.3.4");
    expect(src("  10.0.0.1  ")).toBe("10.0.0.1");
    expect(src(null)).toBe("unknown");
    expect(src("")).toBe("unknown");
  });
});

describe("SAFETY — a positive-cached resolution is NOT an authorization bypass", () => {
  it("the cache serves the pinned descriptor, but the live point-of-use re-assert fails closed on revocation", async () => {
    const { seams } = freshSeams();
    const slug = "runtime-editor-cached";
    const resolved = fakeResolved(slug, {}); // WITH a runtime grant descriptor
    const resolveExpensive = vi.fn(async () => resolved);

    // Resolve + positive-cache; a 2nd resolve is served from cache (same object,
    // the expensive resolver is NOT re-run) — the amplification win.
    const first = await hardenedResolveWidgetStreamRuntime(slug, undefined, resolveExpensive, seams);
    const cached = await hardenedResolveWidgetStreamRuntime(slug, undefined, resolveExpensive, seams);
    expect(cached).toBe(first);
    expect(resolveExpensive).toHaveBeenCalledTimes(1);

    // The grant is now REVOKED in the DB. The point-of-use re-assert reads LIVE
    // (never the cache) and MUST fail closed — so the cached resolution can never
    // drive an OBO run for a revoked widget. This is the linearization guarantee.
    const revokedRow = {
      id: "row-1",
      package_name: PKG,
      org_id: null,
      agent_slug: slug,
      binding_hash_v2: "hash-v2",
      canon_json: "{}",
      status: "revoked",
      approved_by: "admin",
      revoked_by: "admin",
      revoked_at: new Date().toISOString(),
      row_version: 2,
    };
    const stillAuthorized = await reassertWidgetStreamGrantBeforeOboRun(cached!, {
      metadataGrantDeps: { query: async () => [revokedRow] as never },
      isSignedActivated: () => true,
    });
    expect(stillAuthorized).toBe(false);
  });
});
