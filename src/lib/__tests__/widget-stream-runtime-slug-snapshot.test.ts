/**
 * Widget-stream runtime-slug snapshot (widget-stream runtime trust, slice 4 —
 * design surface 3). The guard's public-path liveness layer.
 *
 * These tests pin the PURE-LIVENESS, FAIL-CLOSED-ASYMMETRIC contract of the
 * snapshot the sign-in wall unions in:
 *   - a cold/stale/failed snapshot can only ever 307 a legit widget route, never
 *     OPEN a protected one (the asymmetry);
 *   - a refresher failure freezes the last good snapshot (never clears → open);
 *   - a runtime slug that collides with a build-time widget defers to build-time;
 *   - a revoked slug drops from the snapshot on the next successful refresh.
 * All DB-free: the enumerator and the interval timer are injected seams.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import {
  __resetWidgetStreamRuntimeSlugSnapshotForTests,
  deriveBuildTimeWidgetSlugs,
  getWidgetStreamRuntimeSlugSnapshotState,
  installWidgetStreamRuntimeSlugSnapshot,
  isRuntimeApprovedWidgetStreamPublicPath,
  refreshWidgetStreamRuntimeSlugSnapshot,
  signalWidgetStreamRuntimeSlugRefresh,
  startWidgetStreamRuntimeSlugRefresher,
  type ApprovedWidgetStreamSlugEnumerator,
} from "@/lib/widget-stream-runtime-slug-snapshot";
import { createApprovedWidgetStreamSlugEnumerator } from "@/lib/widget-stream-runtime-slug-enumerator";
import { guardAppRoute } from "@/lib/auth-route-guard";
import { GENERATED_WIDGET_STREAM_PUBLIC_PATHS } from "@/lib/generated/widget-stream-public-paths";

const NO_BUILD_SLUGS = { buildTimeSlugs: new Set<string>() };

function paths(slug: string) {
  return [
    `/api/agents/${slug}/stream`,
    `/api/agents/${slug}/token`,
    `/api/agents/${slug}/capabilities`,
  ];
}

// Minimal NextRequest shape the guard reads (mirrors the sibling guard test): no
// session cookie, so a protected path 307s → /sign-in; a public path returns
// NextResponse.next() (status 200, no Location).
function fakeRequest(pathname: string): NextRequest {
  return {
    nextUrl: { pathname },
    url: `http://localhost${pathname}`,
    cookies: { get: () => undefined },
    headers: new Headers(),
  } as unknown as NextRequest;
}
function isNext(res: { status?: number; headers?: Headers }): boolean {
  const status = res.status ?? 200;
  const location = res.headers?.get?.("location") ?? null;
  return status !== 307 && location === null;
}

afterEach(() => {
  __resetWidgetStreamRuntimeSlugSnapshotForTests();
  vi.restoreAllMocks();
});

describe("snapshot membership — exact-match, three paths per slug, no wildcard", () => {
  it("an approved slug exposes exactly its three paths; nothing else", () => {
    installWidgetStreamRuntimeSlugSnapshot(["acme-editor"], NO_BUILD_SLUGS);
    for (const p of paths("acme-editor")) {
      expect(isRuntimeApprovedWidgetStreamPublicPath(p)).toBe(true);
    }
    // bare slug, sibling verbs, and unrelated protected paths are NOT public
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/acme-editor")).toBe(false);
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/acme-editor/run")).toBe(false);
    expect(isRuntimeApprovedWidgetStreamPublicPath("/dashboards")).toBe(false);
  });

  it("is EXACT-match only — never a prefix or wildcard", () => {
    installWidgetStreamRuntimeSlugSnapshot(["acme-editor"], NO_BUILD_SLUGS);
    for (const p of [
      "/api/agents/acme-editor/streamx",
      "/api/agents/acme-editor/stream/",
      "/api/agents/acme-editor/stream/extra",
      "/api/agents/",
      "/api/agents/acme-editor-evil/stream",
      "/api/agents",
    ]) {
      expect(isRuntimeApprovedWidgetStreamPublicPath(p)).toBe(false);
    }
  });

  it("drops malformed slugs (fail closed) and cannot be tricked into a non-widget path", () => {
    installWidgetStreamRuntimeSlugSnapshot(
      ["Bad_Slug", "../evil", "UPPER", "", "trailing-", "-leading", "ok-slug", "a1-b2"],
      NO_BUILD_SLUGS,
    );
    const state = getWidgetStreamRuntimeSlugSnapshotState();
    expect([...state.slugs].sort()).toEqual(["a1-b2", "ok-slug"]);
    // no path-injection: the traversal-looking slug never yields a path
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/../evil/stream")).toBe(false);
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/ok-slug/stream")).toBe(true);
  });

  it("bumps the generation counter on each install (observability)", () => {
    const g0 = getWidgetStreamRuntimeSlugSnapshotState().generation;
    installWidgetStreamRuntimeSlugSnapshot(["a-one"], NO_BUILD_SLUGS);
    installWidgetStreamRuntimeSlugSnapshot(["a-two"], NO_BUILD_SLUGS);
    expect(getWidgetStreamRuntimeSlugSnapshotState().generation).toBe(g0 + 2);
  });
});

describe("fail-closed floor — staleness asymmetry", () => {
  it("a COLD snapshot never opens: an approved-but-unrefreshed widget route 307s, as does any protected route", async () => {
    // nothing installed
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/acme-editor/stream")).toBe(false);
    expect(isNext(await guardAppRoute(fakeRequest("/api/agents/acme-editor/stream")))).toBe(false);
    expect(isNext(await guardAppRoute(fakeRequest("/dashboards")))).toBe(false);
  });

  it("the snapshot can only ADD widget paths — it never makes a non-widget protected route public", async () => {
    installWidgetStreamRuntimeSlugSnapshot(["acme-editor"], NO_BUILD_SLUGS);
    // the approved widget route is now reachable...
    expect(isNext(await guardAppRoute(fakeRequest("/api/agents/acme-editor/stream")))).toBe(true);
    // ...but arbitrary protected routes are unaffected (307)
    for (const p of ["/dashboards", "/configuration/approvals", "/api/agents/acme-editor/run"]) {
      expect(isNext(await guardAppRoute(fakeRequest(p)))).toBe(false);
    }
  });

  it("build-time widget paths stay public regardless of the runtime snapshot", async () => {
    // empty runtime snapshot — the build-time floor still holds via the guard
    for (const p of GENERATED_WIDGET_STREAM_PUBLIC_PATHS) {
      expect(isNext(await guardAppRoute(fakeRequest(p)))).toBe(true);
    }
  });

  it("STRUCTURAL floor: even a poisoned snapshot set cannot open a non-widget route", async () => {
    // Directly poison the global slot with a non-widget path (something no
    // sanctioned install path could ever produce) plus a valid widget path.
    const g = globalThis as unknown as {
      __cinatraWidgetStreamRuntimeSlugSnapshot?: { paths: Set<string> };
    };
    g.__cinatraWidgetStreamRuntimeSlugSnapshot!.paths = new Set([
      "/dashboards",
      "/configuration/approvals",
      "/api/agents/acme-editor/stream",
    ]);
    // the reader's structural gate rejects the non-widget paths regardless
    expect(isRuntimeApprovedWidgetStreamPublicPath("/dashboards")).toBe(false);
    expect(isRuntimeApprovedWidgetStreamPublicPath("/configuration/approvals")).toBe(false);
    expect(isNext(await guardAppRoute(fakeRequest("/dashboards")))).toBe(false);
    // ...but the well-formed widget path that IS in the set is still allowed
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/acme-editor/stream")).toBe(true);
  });

  it("the observability getter returns COPIES — mutating them cannot bypass approval", () => {
    installWidgetStreamRuntimeSlugSnapshot(["acme-editor"], NO_BUILD_SLUGS);
    const snap = getWidgetStreamRuntimeSlugSnapshotState();
    (snap.paths as Set<string>).add("/api/agents/evil-slug/stream");
    (snap.slugs as Set<string>).add("evil-slug");
    // internal state is untouched — the injected (valid-shape) path is NOT public
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/evil-slug/stream")).toBe(false);
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/acme-editor/stream")).toBe(true);
  });

  it("a structurally-malformed global slot fails closed and re-inits to empty", () => {
    const g = globalThis as unknown as { __cinatraWidgetStreamRuntimeSlugSnapshot?: unknown };
    // a poisoned slot whose `.has` would answer true, with a non-Set `slugs`
    g.__cinatraWidgetStreamRuntimeSlugSnapshot = { paths: { has: () => true }, slugs: null };
    // even a widget-shaped path fails closed (the slot is not a valid snapshot)
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/acme-editor/stream")).toBe(false);
    // and the slot has been replaced with a valid, empty snapshot
    expect(getWidgetStreamRuntimeSlugSnapshotState().pathCount).toBe(0);
  });
});

describe("refresher failure = frozen, not open", () => {
  it("keeps the last good snapshot frozen when the enumerator throws, and records the error", async () => {
    const ok = await refreshWidgetStreamRuntimeSlugSnapshot(async () => ["acme-editor"], NO_BUILD_SLUGS);
    expect(ok.ok).toBe(true);
    const genAfterOk = getWidgetStreamRuntimeSlugSnapshotState().generation;
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/acme-editor/stream")).toBe(true);

    const failed = await refreshWidgetStreamRuntimeSlugSnapshot(async () => {
      throw new Error("db unavailable");
    }, NO_BUILD_SLUGS);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("db unavailable");
    // FROZEN: the slug is still present, generation did not advance, nothing opened
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/acme-editor/stream")).toBe(true);
    expect(getWidgetStreamRuntimeSlugSnapshotState().generation).toBe(genAfterOk);
    expect(getWidgetStreamRuntimeSlugSnapshotState().lastError).toContain("db unavailable");
    expect(isNext(await guardAppRoute(fakeRequest("/dashboards")))).toBe(false);
  });

  it("an empty snapshot with a failing enumerator stays empty (never opens)", async () => {
    const failed = await refreshWidgetStreamRuntimeSlugSnapshot(async () => {
      throw new Error("boom");
    }, NO_BUILD_SLUGS);
    expect(failed.ok).toBe(false);
    expect(getWidgetStreamRuntimeSlugSnapshotState().pathCount).toBe(0);
    expect(isNext(await guardAppRoute(fakeRequest("/api/agents/acme-editor/stream")))).toBe(false);
  });

  it("a failure never widens the path set", async () => {
    await refreshWidgetStreamRuntimeSlugSnapshot(async () => ["acme-editor"], NO_BUILD_SLUGS);
    const before = [...getWidgetStreamRuntimeSlugSnapshotState().paths].sort();
    await refreshWidgetStreamRuntimeSlugSnapshot(async () => {
      throw new Error("x");
    }, NO_BUILD_SLUGS);
    const after = [...getWidgetStreamRuntimeSlugSnapshotState().paths].sort();
    expect(after).toEqual(before);
  });

  it("a SYNCHRONOUSLY-throwing enumerator does not wedge single-flight (recovers next refresh)", async () => {
    // A mis-implemented enumerator that throws BEFORE returning a promise must
    // not permanently pin the single-flight slot (frozen-forever). It freezes
    // this cycle, then the next refresh actually runs.
    const throwSync = (() => {
      throw new Error("sync boom");
    }) as unknown as ApprovedWidgetStreamSlugEnumerator;
    const r1 = await refreshWidgetStreamRuntimeSlugSnapshot(throwSync, NO_BUILD_SLUGS);
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("sync boom");
    // slot cleared → a subsequent refresh is NOT coalesced onto the dead one
    const r2 = await refreshWidgetStreamRuntimeSlugSnapshot(async () => ["acme-editor"], NO_BUILD_SLUGS);
    expect(r2.ok).toBe(true);
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/acme-editor/stream")).toBe(true);
  });
});

describe("collision defers to build-time (build wins absolutely)", () => {
  const buildTimeSlugs = deriveBuildTimeWidgetSlugs(GENERATED_WIDGET_STREAM_PUBLIC_PATHS);

  it("derives the build-time slugs from the generated stream paths", () => {
    expect([...buildTimeSlugs].sort()).toEqual(
      ["drupal-content-editor", "wordpress-content-editor"].sort(),
    );
  });

  it("a runtime slug colliding with a build-time slug is NOT added to the runtime set", () => {
    installWidgetStreamRuntimeSlugSnapshot(
      ["wordpress-content-editor", "acme-editor"],
      { buildTimeSlugs },
    );
    const state = getWidgetStreamRuntimeSlugSnapshotState();
    expect([...state.slugs]).toEqual(["acme-editor"]);
    // the runtime layer does not own the build-time slug's path
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/wordpress-content-editor/stream")).toBe(false);
  });

  it("the build-time path stays public via the build-time set even if the runtime layer 'revokes' it", async () => {
    // runtime enumerator briefly claims then drops the build-time slug
    await refreshWidgetStreamRuntimeSlugSnapshot(async () => ["wordpress-content-editor"], { buildTimeSlugs });
    expect(isNext(await guardAppRoute(fakeRequest("/api/agents/wordpress-content-editor/stream")))).toBe(true);
    await refreshWidgetStreamRuntimeSlugSnapshot(async () => [], { buildTimeSlugs });
    // still public — build wins absolutely
    expect(isNext(await guardAppRoute(fakeRequest("/api/agents/wordpress-content-editor/stream")))).toBe(true);
  });
});

describe("revoked slug drops on the next successful refresh", () => {
  it("a slug present in one refresh but absent in the next is removed", async () => {
    await refreshWidgetStreamRuntimeSlugSnapshot(async () => ["acme-editor", "beta-editor"], NO_BUILD_SLUGS);
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/beta-editor/stream")).toBe(true);

    await refreshWidgetStreamRuntimeSlugSnapshot(async () => ["acme-editor"], NO_BUILD_SLUGS);
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/acme-editor/stream")).toBe(true);
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/beta-editor/stream")).toBe(false);
    // the just-revoked route now 307s at the guard (self-healing liveness)
    expect(isNext(await guardAppRoute(fakeRequest("/api/agents/beta-editor/stream")))).toBe(false);
  });

  it("revocation propagates on the interval cadence", async () => {
    let approved = ["acme-editor", "beta-editor"];
    let tick: (() => void) | null = null;
    const setTimer = vi.fn((cb: () => void) => {
      tick = cb;
      return { id: 1 };
    });
    startWidgetStreamRuntimeSlugRefresher({
      enumerate: async () => approved,
      buildTimeSlugs: new Set(),
      intervalMs: 30_000,
      setTimer,
      clearTimer: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/beta-editor/stream")).toBe(true),
    );
    // admin revokes beta; the next interval tick observes it
    approved = ["acme-editor"];
    tick!();
    await vi.waitFor(() =>
      expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/beta-editor/stream")).toBe(false),
    );
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/acme-editor/stream")).toBe(true);
  });
});

describe("guard union — behavioral (real guardAppRoute)", () => {
  it("an approved runtime slug's three paths skip the sign-in redirect; an unknown one is 307'd", async () => {
    installWidgetStreamRuntimeSlugSnapshot(["acme-editor"], NO_BUILD_SLUGS);
    for (const p of paths("acme-editor")) {
      expect(isNext(await guardAppRoute(fakeRequest(p)))).toBe(true);
    }
    // an unapproved widget slug still redirects (fail-closed)
    const res = await guardAppRoute(fakeRequest("/api/agents/unknown-editor/stream"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/sign-in");
  });

  it("never exposes an /api/agents wildcard", async () => {
    installWidgetStreamRuntimeSlugSnapshot(["acme-editor"], NO_BUILD_SLUGS);
    for (const p of ["/api/agents/acme-editor", "/api/agents/other/stream", "/api/agents/acme-editor/run"]) {
      const res = await guardAppRoute(fakeRequest(p));
      expect(res.status).toBe(307);
    }
  });
});

describe("refresher lifecycle — single-flight, idempotent start, signal hook", () => {
  it("coalesces overlapping refreshes to a single enumerator call (single-flight)", async () => {
    let resolveEnum!: (v: string[]) => void;
    let calls = 0;
    const enumerate = () => {
      calls += 1;
      return new Promise<string[]>((res) => {
        resolveEnum = res;
      });
    };
    const p1 = refreshWidgetStreamRuntimeSlugSnapshot(enumerate, NO_BUILD_SLUGS);
    const p2 = refreshWidgetStreamRuntimeSlugSnapshot(enumerate, NO_BUILD_SLUGS);
    expect(calls).toBe(1);
    expect(p1).toBe(p2); // coalesced onto the in-flight refresh
    resolveEnum(["acme-editor"]);
    await Promise.all([p1, p2]);
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/acme-editor/stream")).toBe(true);
    // once settled, a subsequent refresh reads again
    const p3 = refreshWidgetStreamRuntimeSlugSnapshot(enumerate, NO_BUILD_SLUGS);
    expect(calls).toBe(2);
    resolveEnum(["acme-editor"]);
    await p3;
  });

  it("is idempotent to start — a second start does not schedule a second timer", async () => {
    const setTimer = vi.fn(() => ({ id: 1 }));
    const clearTimer = vi.fn();
    const opts = {
      enumerate: async () => [] as string[],
      buildTimeSlugs: new Set<string>(),
      intervalMs: 10_000,
      setTimer,
      clearTimer,
      runInitialRefresh: false,
    };
    startWidgetStreamRuntimeSlugRefresher(opts);
    startWidgetStreamRuntimeSlugRefresher(opts);
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(getWidgetStreamRuntimeSlugSnapshotState().running).toBe(true);
  });

  it("stop() clears the timer and marks not-running", () => {
    const clearTimer = vi.fn();
    const handle = startWidgetStreamRuntimeSlugRefresher({
      enumerate: async () => [],
      buildTimeSlugs: new Set(),
      intervalMs: 10_000,
      setTimer: () => ({ id: 1 }),
      clearTimer,
      runInitialRefresh: false,
    });
    handle.stop();
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(getWidgetStreamRuntimeSlugSnapshotState().running).toBe(false);
  });

  it("signal() triggers a coalesced refresh when running, and is a no-op when not", async () => {
    // not started → no-op
    expect(signalWidgetStreamRuntimeSlugRefresh()).toBeNull();

    const enumerate = vi.fn(async () => ["acme-editor"]);
    startWidgetStreamRuntimeSlugRefresher({
      enumerate,
      buildTimeSlugs: new Set(),
      intervalMs: 60_000,
      setTimer: () => ({ id: 1 }),
      clearTimer: vi.fn(),
      runInitialRefresh: false,
    });
    const p = signalWidgetStreamRuntimeSlugRefresh();
    expect(p).not.toBeNull();
    await p;
    expect(enumerate).toHaveBeenCalledTimes(1);
    expect(isRuntimeApprovedWidgetStreamPublicPath("/api/agents/acme-editor/stream")).toBe(true);
  });

  it("uses the real setInterval (unref'd) when no timer is injected, and stop() clears it", () => {
    const fakeHandle = { unref: vi.fn() };
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(fakeHandle as unknown as ReturnType<typeof setInterval>);
    const clearIntervalSpy = vi
      .spyOn(globalThis, "clearInterval")
      .mockImplementation(() => {});
    const handle = startWidgetStreamRuntimeSlugRefresher({
      enumerate: async () => [],
      buildTimeSlugs: new Set(),
      intervalMs: 1234,
      runInitialRefresh: false,
    });
    // default path scheduled a real interval at the configured cadence, and
    // unref()'d it so it never keeps the process alive / blocks shutdown
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0]![1]).toBe(1234);
    expect(fakeHandle.unref).toHaveBeenCalledTimes(1);
    handle.stop();
    expect(clearIntervalSpy).toHaveBeenCalledWith(fakeHandle);
  });

  it("clamps interval extremes for the real timer (no setInterval overflow / NaN hot-loop)", () => {
    for (const [input, expected] of [
      [999_999_999_999, 2_147_483_647], // above 2^31-1 → ceiling
      [Number.NaN, 60_000], // non-finite → safe module default, never ~1ms
      [0, 60_000], // non-positive → safe default
      [30_000, 30_000], // valid value passes through
    ] as const) {
      const fakeHandle = { unref: vi.fn() };
      const setIntervalSpy = vi
        .spyOn(globalThis, "setInterval")
        .mockReturnValue(fakeHandle as unknown as ReturnType<typeof setInterval>);
      vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
      const handle = startWidgetStreamRuntimeSlugRefresher({
        enumerate: async () => [],
        buildTimeSlugs: new Set(),
        intervalMs: input,
        runInitialRefresh: false,
      });
      expect(setIntervalSpy.mock.calls[0]![1]).toBe(expected);
      handle.stop();
      vi.restoreAllMocks();
      __resetWidgetStreamRuntimeSlugSnapshotForTests();
    }
  });
});

describe("createApprovedWidgetStreamSlugEnumerator — cross-org list swap (slice 5)", () => {
  // Capture the SQL text via a closure (the injected query is untyped test glue).
  // After the slice-5 swap the enumerator issues NO SQL of its own — it delegates
  // to the grant module's cross-org `listAllApprovedWidgetStreamMetadataGrants`,
  // so this captures the SQL THAT function issues through the injected query.
  function makeQuery(rows: { agent_slug: string }[]): {
    query: (text: string) => Promise<{ agent_slug: string }[]>;
    lastSql: () => string;
  } {
    let sql = "";
    return {
      query: (text: string) => {
        sql = text;
        return Promise.resolve(rows);
      },
      lastSql: () => sql,
    };
  }

  it("maps approved rows to DISTINCT slugs via the cross-org grant-module list", async () => {
    const { query, lastSql } = makeQuery([{ agent_slug: "acme-editor" }, { agent_slug: "beta-editor" }]);
    const enumerate = createApprovedWidgetStreamSlugEnumerator({ query: query as never });
    expect(await enumerate()).toEqual(["acme-editor", "beta-editor"]);
    const sql = lastSql().replace(/\s+/g, " ");
    // Cross-org: filter on status ONLY, no org_id PREDICATE (every scope's rows).
    // (org_id still appears as a SELECTED column — that is not a scope filter.)
    expect(sql).toContain("status = 'approved'");
    expect(sql).not.toContain("org_id IS NULL");
    expect(sql).not.toContain("org_id =");
    expect(sql).toContain(`"cinatra"."extension_widget_stream_metadata_grant"`);
  });

  it("dedupes a slug approved in more than one org scope to a single redirect-skip candidate", async () => {
    // Cross-org read: the SAME slug can be approved at global scope AND in an org.
    // The liveness snapshot only needs the slug once.
    const { query } = makeQuery([
      { agent_slug: "acme-editor" },
      { agent_slug: "acme-editor" },
      { agent_slug: "beta-editor" },
    ]);
    const enumerate = createApprovedWidgetStreamSlugEnumerator({ query: query as never });
    expect(await enumerate()).toEqual(["acme-editor", "beta-editor"]);
  });

  it("uses the provided schema and quotes a stray double-quote (identifier safety)", async () => {
    const { query, lastSql } = makeQuery([]);
    const enumerate = createApprovedWidgetStreamSlugEnumerator({ query: query as never, schema: 'we"ird' });
    await enumerate();
    expect(lastSql()).toContain(`"we""ird"."extension_widget_stream_metadata_grant"`);
  });

  it("returns an empty list for no approved rows", async () => {
    const { query } = makeQuery([]);
    const enumerate = createApprovedWidgetStreamSlugEnumerator({ query: query as never });
    expect(await enumerate()).toEqual([]);
  });
});
