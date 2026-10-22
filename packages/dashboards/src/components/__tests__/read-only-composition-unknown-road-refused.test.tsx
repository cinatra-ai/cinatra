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
  recordingFetch,
  REFUSED_ROADS,
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
  test("[guard] (f3) road session reads the cube metadata from its address, with credentials", async () => {
    render(<Dashboard config={CONFIGURED} dataRoad={{ road: "session", apiUrl: API }} />);
    await waitFor(() => expect(calls.map((call) => call.url)).toContain(`${API}/meta`), { timeout: 15_000 });
    expect(document.querySelectorAll(REFUSAL)).toHaveLength(0);
    for (const call of calls) {
      expect(call.url.startsWith(`${API}/`)).toBe(true);
      expect(call.credentials).toBe("include");
    }
  });
});
