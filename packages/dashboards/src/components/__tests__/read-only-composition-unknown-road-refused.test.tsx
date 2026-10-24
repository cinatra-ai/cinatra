// @vitest-environment jsdom
//
// AN UNKNOWN DATA ROAD FETCHES NOTHING (cinatra#3092, #4118 fold, MUST-FIX 2).
// With the real drizzle-cube mounted, a road value the composition does not admit
// by equality draws its settled refusal and makes no request at all — above all
// none that carries the reader's credentials, which only the session road sends.
// The session road itself still fetches from its own address with them.
//
// Nothing of drizzle-cube is substituted. `fetch` is a recording stub.
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/read-only-composition-unknown-road-refused.test.tsx

import "./jsdom-shims";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import { ReadOnlyComposedDashboard, ReadOnlySinglePortlet } from "@cinatra-ai/sdk-dashboard/components";

import {
  API,
  CONFIGURED,
  CONFIGURED_PORTLETS,
  PAGE_ORIGIN,
  recordingFetch,
  REFUSED_ROADS,
  SAME_ORIGIN_API,
  VisibleObserver,
  type FetchCall,
} from "./read-only-composition-road-fixtures";

// Typed loosely so this file reads the same against any version of the props.
const Dashboard = ReadOnlyComposedDashboard as unknown as (p: Record<string, unknown>) => React.JSX.Element;
const Portlet = ReadOnlySinglePortlet as unknown as (p: Record<string, unknown>) => React.JSX.Element;

const REFUSAL = '[role="alert"][data-cinatra-read-only-composition-refused="data-road"]';

const calls: FetchCall[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("IntersectionObserver", VisibleObserver);
  vi.stubGlobal("fetch", vi.fn(recordingFetch(calls)));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Past drizzle-cube's query debounce, so a query that would run has run. */
async function pause() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
}

async function expectRefusedAndSilent() {
  await pause();
  // First the credentials: no request carries the reader's session ...
  expect(calls.filter((call) => call.credentials === "include")).toEqual([]);
  // ... and no request is made at all.
  expect(calls).toEqual([]);
  // The refusal is drawn, settled, in place of the grid.
  expect(document.querySelectorAll(REFUSAL)).toHaveLength(1);
  for (const portlet of CONFIGURED_PORTLETS) {
    expect(screen.queryByText(portlet.title)).toBeNull();
  }
  expect(document.querySelectorAll('[role="status"][aria-label="Loading"]')).toHaveLength(0);
}

describe("an unknown data road draws its refusal and fetches nothing (cinatra#3092 fold, MF2)", () => {
  test.each(REFUSED_ROADS)("(f1) the read-only dashboard refuses %s and fetches nothing", async (_name, dataRoad) => {
    render(<Dashboard config={CONFIGURED} dataRoad={dataRoad} />);
    await expectRefusedAndSilent();
  });

  test.each(REFUSED_ROADS)("(f2) the single portlet refuses %s and fetches nothing", async (_name, dataRoad) => {
    render(<Portlet config={CONFIGURED} portletId="p1" dataRoad={dataRoad} />);
    await expectRefusedAndSilent();
  });
});

describe("the session road still fetches from its own address with the reader's session (guard)", () => {
  test("(f3) road session with a root-relative address reads the cube metadata from it, resolved against the page's own origin, with credentials", async () => {
    render(<Dashboard config={CONFIGURED} dataRoad={{ road: "session", apiUrl: API }} />);
    await waitFor(() => expect(calls.map((call) => call.url)).toContain(`${SAME_ORIGIN_API}/meta`), { timeout: 15_000 });
    expect(document.querySelectorAll(REFUSAL)).toHaveLength(0);
    for (const call of calls) {
      expect(call.url.startsWith(`${SAME_ORIGIN_API}/`)).toBe(true);
      expect(call.credentials).toBe("include");
    }
  });

  test("[guard] (f4) road session with an absolute address of the page's own origin reads the metadata there, with credentials", async () => {
    render(<Portlet config={CONFIGURED} portletId="p1" dataRoad={{ road: "session", apiUrl: SAME_ORIGIN_API }} />);
    await waitFor(() => expect(calls.map((call) => call.url)).toContain(`${SAME_ORIGIN_API}/meta`), { timeout: 15_000 });
    expect(document.querySelectorAll(REFUSAL)).toHaveLength(0);
    for (const call of calls) {
      expect(call.url.startsWith(`${SAME_ORIGIN_API}/`)).toBe(true);
      expect(call.credentials).toBe("include");
    }
  });

  // A browser's fetch resolves a relative address against `document.baseURI`,
  // which a `<base>` element of another origin moves; so every recorded request
  // is read the way a browser reads it.
  test("(f5) under a <base> of another origin, road session with a root-relative address sends every request to the page's own origin", async () => {
    const base = document.createElement("base");
    base.href = "https://evil.example/";
    document.head.appendChild(base);
    try {
      expect(new URL(API, document.baseURI).origin).toBe("https://evil.example");
      render(<Dashboard config={CONFIGURED} dataRoad={{ road: "session", apiUrl: API }} />);
      await waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 15_000 });
      expect(document.querySelectorAll(REFUSAL)).toHaveLength(0);
      for (const call of calls) {
        expect(new URL(call.url, document.baseURI).origin).toBe(PAGE_ORIGIN);
        expect(call.url.startsWith(`${SAME_ORIGIN_API}/`)).toBe(true);
      }
      expect(calls.map((call) => call.url)).toContain(`${SAME_ORIGIN_API}/meta`);
    } finally {
      base.remove();
    }
  });
});
