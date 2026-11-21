// @vitest-environment jsdom
//
// THE SESSION ROAD'S ADDRESS IS RESOLVED ONCE (cinatra#3092, #4118). The session
// road sends the reader's credentials, so the composition resolves its `apiUrl`
// once, against the page's own origin, and hands the cube provider only that
// resolved href, or refuses. A path handed on as given would be resolved again
// by the browser's fetch against `document.baseURI`, which a `<base>` element of
// another origin moves. Each test reads both the verdict (admitted or refused)
// and the address that reaches the provider.
//
// Also here: the fail-closed own-property read when the read itself throws, a
// revoked Proxy as the road, the session road on an https page, and the settled
// answers the no-series road's query client gives each query family and key.
//
// `drizzle-cube/client` is substituted by the same RECORDING module as
// read-only-composition-unknown-road-providers.test.tsx.
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/read-only-composition-address-resolved.test.tsx

import "./jsdom-shims";
import React, { type ReactNode } from "react";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";

import { API, PAGE_ORIGIN, SAME_ORIGIN_API } from "./read-only-composition-road-fixtures";

const rec = vi.hoisted(() => ({
  cube: [] as Record<string, unknown>[],
  dashboard: [] as Record<string, unknown>[],
}));

function withoutChildren(props: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...props };
  delete rest.children;
  return rest;
}

vi.mock("drizzle-cube/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-cube/client")>();
  return {
    ...actual,
    CubeProvider: (props: { children?: ReactNode } & Record<string, unknown>) => {
      rec.cube.push(withoutChildren(props));
      return <div data-testid="cube-provider">{props.children}</div>;
    },
    DashboardProvider: (props: { children?: ReactNode } & Record<string, unknown>) => {
      rec.dashboard.push(withoutChildren(props));
      return <div data-testid="dashboard-provider">{props.children}</div>;
    },
    DashboardGridSurface: () => <div data-testid="grid-surface" />,
  };
});

import {
  ReadOnlyComposedDashboard,
  ReadOnlySinglePortlet,
} from "@cinatra-ai/sdk-dashboard/components";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  rec.cube.length = 0;
  rec.dashboard.length = 0;
  for (const base of Array.from(document.querySelectorAll("base"))) base.remove();
});

// What this file substituted, it hands back: the package's full run stays
// unaffected by the recording module.
afterAll(() => {
  vi.doUnmock("drizzle-cube/client");
  vi.resetModules();
});

const CONFIG = {
  portlets: [{ id: "p1", title: "Portlet one", x: 0, y: 0, w: 6, h: 4, chartType: "table", query: "{}" }],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

// Typed loosely so this file reads the same against any version of the props.
const Dashboard = ReadOnlyComposedDashboard as unknown as (p: Record<string, unknown>) => React.JSX.Element;
const Portlet = ReadOnlySinglePortlet as unknown as (p: Record<string, unknown>) => React.JSX.Element;

const REFUSAL = '[role="alert"][data-cinatra-read-only-composition-refused="data-road"]';
const PAGE = new URL(PAGE_ORIGIN);
const OTHER_ORIGIN = "https://evil.example";

function session(apiUrl: string) {
  return { road: "session", apiUrl };
}

function addBase(href: string) {
  const base = document.createElement("base");
  base.href = href;
  document.head.appendChild(base);
}

/** Admitted: one session provider, over exactly `href`, and no refusal. */
function expectAdmittedOver(href: string) {
  expect(rec.cube).toHaveLength(1);
  expect(rec.cube[0]?.apiOptions).toEqual({ apiUrl: href, credentials: "include" });
  expect(new URL(href).origin).toBe(PAGE_ORIGIN);
  expect(rec.dashboard).toHaveLength(1);
  expect(document.querySelectorAll(REFUSAL)).toHaveLength(0);
}

/** Refused: no provider of any road (so no address reaches one), one refusal. */
function expectRefused() {
  expect(rec.cube).toEqual([]);
  expect(rec.dashboard).toEqual([]);
  expect(document.querySelectorAll(REFUSAL)).toHaveLength(1);
}

describe("the session road hands the provider the address resolved against the page's own origin (#4118)", () => {
  test("(r1) a root-relative path reaches the provider as the absolute href of the page's own origin", () => {
    render(<Dashboard config={CONFIG} dataRoad={session(API)} />);
    expectAdmittedOver(SAME_ORIGIN_API);
  });

  test("(r2) under a <base> of another origin, a root-relative path reaches the provider on the page's own origin, never the <base> origin", () => {
    addBase(`${OTHER_ORIGIN}/`);
    expect(new URL(API, document.baseURI).origin).toBe(OTHER_ORIGIN);
    render(<Portlet config={CONFIG} portletId="p1" dataRoad={session(API)} />);
    expectAdmittedOver(SAME_ORIGIN_API);
    // Read the way a browser's fetch reads it: still the page's own origin.
    const handed = (rec.cube[0]?.apiOptions as { apiUrl: string }).apiUrl;
    expect(new URL(handed, document.baseURI).origin).toBe(PAGE_ORIGIN);
  });

  test("(r3) a root-relative path with dot segments reaches the provider resolved", () => {
    render(<Dashboard config={CONFIG} dataRoad={session("/api/dashboards/x/../cubejs-api/v1")} />);
    expectAdmittedOver(SAME_ORIGIN_API);
  });

  test("[guard] (r4) an absolute URL of the page's own origin is admitted and its resolved href reaches the provider", () => {
    render(<Dashboard config={CONFIG} dataRoad={session(SAME_ORIGIN_API)} />);
    expectAdmittedOver(new URL(SAME_ORIGIN_API).href);
  });

  test("(r5) an absolute URL of the page's own origin in upper case reaches the provider as its resolved href", () => {
    const upper = `${PAGE.protocol.toUpperCase()}//${PAGE.host.toUpperCase()}${API}`;
    render(<Portlet config={CONFIG} portletId="p1" dataRoad={session(upper)} />);
    expectAdmittedOver(SAME_ORIGIN_API);
  });

  test("[guard] (r6) a protocol-relative address is refused", () => {
    render(<Dashboard config={CONFIG} dataRoad={session("//evil.example/x")} />);
    expectRefused();
  });

  test("[guard] (r7) under a <base> of another origin, a protocol-relative address of the page host is still refused", () => {
    addBase(`${OTHER_ORIGIN}/`);
    render(<Dashboard config={CONFIG} dataRoad={session(`//${PAGE.host}${API}`)} />);
    expectRefused();
  });

  test("[guard] (r8) an absolute URL of another origin is refused", () => {
    render(<Dashboard config={CONFIG} dataRoad={session(`${OTHER_ORIGIN}${API}`)} />);
    expectRefused();
  });

  test("[guard] (r9) an absolute URL of the page's origin with an empty user name and a password is refused", () => {
    const url = `${PAGE.protocol}//:pw@${PAGE.host}${API}`;
    expect(new URL(url).username).toBe("");
    expect(new URL(url).password).toBe("pw");
    render(<Dashboard config={CONFIG} dataRoad={session(url)} />);
    expectRefused();
  });

  test("[guard] (r10) an absolute URL of the page's origin with a user name and no password is refused", () => {
    render(<Dashboard config={CONFIG} dataRoad={session(`${PAGE.protocol}//user@${PAGE.host}${API}`)} />);
    expectRefused();
  });

  test("[guard] (r11) a bare relative path is refused", () => {
    render(<Dashboard config={CONFIG} dataRoad={session("api/dashboards/cubejs-api/v1")} />);
    expectRefused();
  });

  test("(r12) a blob address whose origin reads as the page's own origin is refused: only http and https carry the session", () => {
    const blob = `blob:${PAGE_ORIGIN}/0b1c2d3e`;
    // The origin check alone would admit it: its parsed origin IS the page's.
    expect(new URL(blob).origin).toBe(PAGE_ORIGIN);
    expect(new URL(blob).protocol).toBe("blob:");
    render(<Portlet config={CONFIG} portletId="p1" dataRoad={session(blob)} />);
    expectRefused();
  });

  test("[guard] (r13) a file address is refused", () => {
    render(<Dashboard config={CONFIG} dataRoad={session("file:///etc/passwd")} />);
    expectRefused();
  });
});

/** An https page: `window` names a stand-in whose only field is the page's
 *  location; the document React renders into is jsdom's own. */
const HTTPS_PAGE_ORIGIN = "https://app.example";

function onHttpsPage() {
  vi.stubGlobal("window", { location: { origin: HTTPS_PAGE_ORIGIN } });
}

/** Admitted on the https page: one session provider over exactly `href`, an
 *  https address of that page's origin, and no refusal. */
function expectAdmittedOnHttpsPage(href: string) {
  expect(rec.cube).toHaveLength(1);
  expect(rec.cube[0]?.apiOptions).toEqual({ apiUrl: href, credentials: "include" });
  expect(new URL(href).protocol).toBe("https:");
  expect(new URL(href).origin).toBe(HTTPS_PAGE_ORIGIN);
  expect(rec.dashboard).toHaveLength(1);
  expect(document.querySelectorAll(REFUSAL)).toHaveLength(0);
}

describe("on an https page the session road is admitted over https (#4118)", () => {
  test("(r14) on an https page, a root-relative path reaches the provider as the https href of the page's own origin", () => {
    onHttpsPage();
    render(<Dashboard config={CONFIG} dataRoad={session(API)} />);
    expectAdmittedOnHttpsPage(`${HTTPS_PAGE_ORIGIN}${API}`);
  });

  test("[guard] (r15) on an https page, an absolute https URL of the page's own origin is admitted and reaches the provider", () => {
    onHttpsPage();
    render(<Portlet config={CONFIG} portletId="p1" dataRoad={session(`${HTTPS_PAGE_ORIGIN}${API}`)} />);
    expectAdmittedOnHttpsPage(`${HTTPS_PAGE_ORIGIN}${API}`);
  });
});

/** A road whose own-property read throws for each key in `throwing`. */
function throwingRoad(target: Record<string, unknown>, throwing: readonly string[], asked: string[]) {
  return new Proxy(target, {
    getOwnPropertyDescriptor(t, key) {
      asked.push(String(key));
      if (throwing.includes(String(key))) throw new Error(`read of ${String(key)} refused`);
      return Reflect.getOwnPropertyDescriptor(t, key);
    },
  });
}

/** A road its caller revoked: every operation on it throws, `Array.isArray`
 *  included, before any own-property read is reached. */
function revokedRoad(): object {
  const { proxy, revoke } = Proxy.revocable({ road: "session", apiUrl: API }, {});
  revoke();
  expect(() => Array.isArray(proxy)).toThrow();
  return proxy;
}

describe("a road whose own-property read throws reads as absent (#4118, the ownValue throw path)", () => {
  test("[guard] (t1) a road whose every read throws is refused", () => {
    const asked: string[] = [];
    render(<Dashboard config={CONFIG} dataRoad={throwingRoad({ road: "session", apiUrl: API }, ["road", "apiUrl"], asked)} />);
    expect(asked).toContain("road");
    expectRefused();
  });

  test("[guard] (t2) a session road whose address read throws is refused", () => {
    const asked: string[] = [];
    render(<Portlet config={CONFIG} portletId="p1" dataRoad={throwingRoad({ road: "session", apiUrl: API }, ["apiUrl"], asked)} />);
    expect(asked).toContain("apiUrl");
    expectRefused();
  });

  test("[guard] (t3) a none road whose address read would throw reads no address and mounts the no-series provider", () => {
    const asked: string[] = [];
    render(<Dashboard config={CONFIG} dataRoad={throwingRoad({ road: "none", apiUrl: API }, ["apiUrl"], asked)} />);
    expect(asked).toContain("road");
    expect(asked).not.toContain("apiUrl");
    expect(rec.cube).toHaveLength(1);
    expect(rec.cube[0]?.apiOptions).toEqual({ credentials: "omit" });
    expect(document.querySelectorAll(REFUSAL)).toHaveLength(0);
  });

  test("(t4) a revoked Proxy as the dashboard's road is refused, and the render does not throw", () => {
    render(<Dashboard config={CONFIG} dataRoad={revokedRoad()} />);
    expectRefused();
  });

  test("(t5) a revoked Proxy as the single portlet's road is refused, and the render does not throw", () => {
    render(<Portlet config={CONFIG} portletId="p1" dataRoad={revokedRoad()} />);
    expectRefused();
  });
});

/** The query client the no-series road hands its cube provider. */
function noSeriesQueryClient(): QueryClient {
  render(<Dashboard config={CONFIG} dataRoad={{ road: "none" }} />);
  expect(rec.cube).toHaveLength(1);
  const client = rec.cube[0]?.queryClient as QueryClient | undefined;
  expect(client).toBeDefined();
  return client as QueryClient;
}

const SETTLED_ANSWERS: ReadonlyArray<readonly [string, unknown]> = [
  ["multiLoad", { data: [], resultSets: [], perQueryData: [], errors: [], firstError: null }],
  ["funnel", { rawData: [], executionTime: 0, cacheInfo: undefined }],
  ["flow", { rawData: [], executionTime: 0, cacheInfo: undefined }],
  ["retention", { rawData: [], executionTime: 0, cacheInfo: undefined }],
  ["meta", { meta: { cubes: [] }, labelMap: {} }],
];

const UNANSWERED: ReadonlyArray<readonly [string, readonly unknown[]]> = [
  ["an unknown family", ["cube", "sealed", "q"]],
  ["a key outside the cube", ["other", "load"]],
];

/** Keys that are not arrays: the road reads no family from them. */
const NOT_ARRAY_KEYS: ReadonlyArray<readonly [string, unknown]> = [
  ["(q4a) a query with no key", undefined],
  ["(q4b) a query whose key is an array-like object, not an array", { 0: "cube", 1: "load", length: 2 }],
];

describe("the no-series road answers each query family settled and fetches nothing (#4118)", () => {
  test.each(SETTLED_ANSWERS)(
    "[guard] (q1) family %s is off, born with its empty answer, and answers it without the given query function",
    async (family, answer) => {
      const client = noSeriesQueryClient();
      const options = client.defaultQueryOptions({ queryKey: ["cube", family, "q"] });
      expect(options.enabled).toBe(false);
      expect(options.retry).toBe(false);
      expect(options.initialData).toEqual(answer);
      const given = vi.fn(() => Promise.resolve<unknown>("a request"));
      // `staleTime: 0` makes the initial answer stale at once, so the fetch runs a
      // query function instead of answering from the cache; only the road's own
      // function may answer, and the given one is never called.
      const key = ["cube", family, "q2"];
      await expect(client.fetchQuery({ queryKey: key, queryFn: given, staleTime: 0 })).resolves.toEqual(answer);
      expect(client.getQueryState(key)?.dataUpdateCount).toBe(1);
      expect(given).not.toHaveBeenCalled();
    },
  );

  test("[guard] (q2) the load family is off and born with an empty result set", () => {
    const client = noSeriesQueryClient();
    const options = client.defaultQueryOptions({ queryKey: ["cube", "load", "q"] });
    expect(options.enabled).toBe(false);
    const answer = options.initialData as { loadResponse: unknown; rawData: () => unknown[] };
    expect(answer.loadResponse).toEqual({ data: [], annotation: {} });
    expect(answer.rawData()).toEqual([]);
  });

  test.each(UNANSWERED)(
    "[guard] (q3) %s has no answer and settles with an error, never calling the given query function",
    async (_name, queryKey) => {
      const client = noSeriesQueryClient();
      const options = client.defaultQueryOptions({ queryKey: [...queryKey] });
      expect(options.enabled).toBe(false);
      expect(options.initialData).toBeUndefined();
      const given = vi.fn(() => Promise.resolve<unknown>("a request"));
      await expect(client.fetchQuery({ queryKey: [...queryKey], queryFn: given })).rejects.toThrow(
        "The no-series road answers no such query.",
      );
      expect(given).not.toHaveBeenCalled();
    },
  );

  test.each(NOT_ARRAY_KEYS)(
    "[guard] %s has no answer, stays off, and its query function rejects",
    async (_name, queryKey) => {
      const client = noSeriesQueryClient();
      const options = client.defaultQueryOptions({ queryKey } as never);
      expect(options.enabled).toBe(false);
      expect(options.initialData).toBeUndefined();
      const queryFn = options.queryFn as unknown as () => Promise<unknown>;
      await expect(queryFn()).rejects.toThrow("The no-series road answers no such query.");
    },
  );
});
