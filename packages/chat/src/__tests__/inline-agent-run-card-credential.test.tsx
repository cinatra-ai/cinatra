// @vitest-environment jsdom
/**
 * THE INLINE RUN PANEL'S SEED ASKS WITH THE HOST'S OWN CREDENTIAL (cinatra#2902).
 *
 * The panel's first act is to read the run it must draw. Until this slice that
 * read was made one way — a plain same-origin `fetch` with no `credentials` mode
 * — so on the embedded widget it carried no cookie (a `Lax` session cookie does
 * not travel cross-site), the guard answered it before the handler ran, and the
 * panel drew "Could not load agent run … — please try again." for ever.
 *
 * What this file pins:
 *
 *   · BROKER — the seed carries the broker headers AND explicit
 *     `credentials: "omit"`. Both come from the one shared builder, so a caller
 *     cannot forget the mode and send a cookie it must not send.
 *   · COOKIE — a PRESERVATION CONTROL. The first-party request is unchanged: the
 *     same URL, the same `Accept`, the same `cache: "no-store"`, NO widget header
 *     and NO `credentials` field, so the ambient session rides it exactly as it
 *     did before.
 *   · REFUSED — a host that cannot say who is asking issues NO request at all. A
 *     run is somebody's work; a mis-wired widget mount must not learn about one
 *     by firing a cookie-bound read from a frame that is same-origin to the app.
 *
 * `AgenticRunPanel` is stubbed: this file is about the request the WRAPPER makes.
 */
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const panelProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("@cinatra-ai/agents/client-entry", () => ({
  AgenticRunPanel: (props: Record<string, unknown>) => {
    panelProps.current = props;
    return <div data-testid="run-panel-stub" />;
  },
}));
vi.mock("../use-agent-creation-progress", () => ({
  useAgentCreationProgress: () => [],
}));

import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import { InlineAgentRunCard } from "../inline-agent-run-card";

const RUN_ID = "85bd2267-3f9a-4f0d-a1da-bb3a54f1a50d";
const SEED_URL = `/api/agents/runs/${RUN_ID}`;

const BROKER_AUTH = {
  headers: () => ({
    Authorization: "Bearer cit_site",
    "X-Cinatra-Widget-User-Token": "cwu_user",
    "X-Cinatra-Widget-Assistant": "wordpress",
    "X-Cinatra-Widget-Origin": "https://blog.example.com",
  }),
  credentials: "omit" as const,
};
const BROKER_FRAME = { assistant: "wordpress", instanceId: "inst-1" };

const cookieHost = (children: ReactNode) => (
  <LifecycleCardSurfaceProvider host="chat_thread">{children}</LifecycleCardSurfaceProvider>
);
const brokerHost = (children: ReactNode) => (
  <LifecycleCardSurfaceProvider host="site_widget" auth={BROKER_AUTH} frame={BROKER_FRAME}>
    {children}
  </LifecycleCardSurfaceProvider>
);
/** A non-cookie host whose credential the runtime REFUSED (no `auth` prop). */
const refusedHost = (children: ReactNode) => (
  <LifecycleCardSurfaceProvider host="site_widget">{children}</LifecycleCardSurfaceProvider>
);

const SEED_BODY = {
  status: "completed",
  error: null,
  inputParams: {},
  templateId: "tmpl-1",
  agentPackageName: "@cinatra-ai/blog-draft-writer-agent",
  agUiEnabled: true,
  taskId: null,
  traceId: null,
  messages: [],
  hitlContext: null,
};

let fetchCalls: Array<{ url: string; init: RequestInit }>;

beforeEach(() => {
  cleanup();
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      fetchCalls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        json: async () => SEED_BODY,
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The headers of a recorded call, normalized to a lower-cased plain map. */
function headersOf(init: RequestInit): Record<string, string> {
  const raw = (init.headers ?? {}) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = v;
  return out;
}

describe("the BROKER transport", () => {
  it("carries the broker headers and explicit credentials:\"omit\"", async () => {
    render(brokerHost(<InlineAgentRunCard runId={RUN_ID} />));
    await screen.findByTestId("run-panel-stub");

    expect(fetchCalls).toHaveLength(1);
    const [call] = fetchCalls;
    expect(call.url).toBe(SEED_URL);
    // The mode is EXPLICIT. Without it the browser's default would attach the
    // same-origin cookie, which is the identity this branch must not use.
    expect(call.init.credentials).toBe("omit");
    const headers = headersOf(call.init);
    expect(headers["x-cinatra-widget-user-token"]).toBe("cwu_user");
    expect(headers["x-cinatra-widget-assistant"]).toBe("wordpress");
    expect(headers["x-cinatra-widget-origin"]).toBe("https://blog.example.com");
    expect(headers["authorization"]).toBe("Bearer cit_site");
    // …and the seed's own header is still there beside them.
    expect(headers["accept"]).toBe("application/json");
  });

  it("draws the panel — the failure line is absent", async () => {
    render(brokerHost(<InlineAgentRunCard runId={RUN_ID} />));
    await screen.findByTestId("run-panel-stub");
    expect(screen.queryByText(/Could not load agent run/i)).toBeNull();
  });
});

describe("PRESERVATION CONTROL — the signed-in cookie branch is unchanged", () => {
  it("makes the SAME request it made before this slice", async () => {
    render(cookieHost(<InlineAgentRunCard runId={RUN_ID} />));
    await screen.findByTestId("run-panel-stub");

    expect(fetchCalls).toHaveLength(1);
    const [call] = fetchCalls;
    expect(call.url).toBe(SEED_URL);
    expect(call.init.method).toBe("GET");
    expect(call.init.cache).toBe("no-store");
    // NO `credentials` field at all — the ambient session rides the request the
    // way it always has. Setting one here, even to a permissive value, would be
    // a change to a first-party path this slice must not touch.
    expect("credentials" in call.init).toBe(false);
    expect(headersOf(call.init)).toEqual({ accept: "application/json" });
  });

  it("never presents a widget header on the cookie branch", async () => {
    render(cookieHost(<InlineAgentRunCard runId={RUN_ID} />));
    await screen.findByTestId("run-panel-stub");
    const headers = headersOf(fetchCalls[0].init);
    for (const name of Object.keys(headers)) {
      expect(name.startsWith("x-cinatra-widget-")).toBe(false);
    }
  });
});

describe("a host that cannot say who is asking issues no request", () => {
  it("asks NOTHING and says so, rather than firing a cookie-bound read", async () => {
    render(refusedHost(<InlineAgentRunCard runId={RUN_ID} />));
    await waitFor(() =>
      expect(screen.getByText(/cannot be shown here/i)).toBeTruthy(),
    );
    expect(fetchCalls).toHaveLength(0);
    expect(screen.queryByTestId("run-panel-stub")).toBeNull();
  });
});

// cinatra#2997 — the panel re-reads the run's review slot after the run
// finishes, so the placeholder can become the review screen without anybody
// asking. That read is the SAME route the seed is, so it must travel on the SAME
// credential: the wrapper hands the panel a reader built by the one shared
// builder, and a host that cannot say who is asking hands it nothing at all.
describe("the review-slot reader asks with the host's own credential", () => {
  it("BROKER: the slot read carries the widget headers and omits cookies", async () => {
    render(brokerHost(<InlineAgentRunCard runId={RUN_ID} />));
    await screen.findByTestId("run-panel-stub");
    await waitFor(() => expect(panelProps.current).not.toBeNull());

    const read = panelProps.current!.readReviewSlot as () => Promise<unknown>;
    expect(typeof read).toBe("function");
    fetchCalls = [];
    await read();

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call.url).toBe(SEED_URL);
    expect(call.init.credentials).toBe("omit");
    const headers = headersOf(call.init);
    expect(headers["x-cinatra-widget-user-token"]).toBe("cwu_user");
    expect(headers["authorization"]).toBe("Bearer cit_site");
  });

  it("COOKIE: the first-party slot read is the first-party request, unchanged", async () => {
    render(cookieHost(<InlineAgentRunCard runId={RUN_ID} />));
    await screen.findByTestId("run-panel-stub");
    await waitFor(() => expect(panelProps.current).not.toBeNull());

    fetchCalls = [];
    await (panelProps.current!.readReviewSlot as () => Promise<unknown>)();

    expect(fetchCalls).toHaveLength(1);
    expect("credentials" in fetchCalls[0].init).toBe(false);
    for (const name of Object.keys(headersOf(fetchCalls[0].init))) {
      expect(name.startsWith("x-cinatra-widget-")).toBe(false);
    }
  });

  it("REFUSED: no reader is handed down, so nothing is ever read", async () => {
    panelProps.current = null;
    render(refusedHost(<InlineAgentRunCard runId={RUN_ID} />));
    await waitFor(() =>
      expect(screen.getByText(/cannot be shown here/i)).toBeTruthy(),
    );
    expect(panelProps.current).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("the run's own re-read, after the seed (cinatra#3051)", () => {
  // The panel keeps the run current on its own tick — that is how a run that
  // parks for review while the page is open reaches its review without anybody
  // re-opening the page. That re-read is the SAME route the seed is, so it
  // travels on the SAME credential, built by the same shared builder.
  it("is handed down on the broker host, and carries the broker proof", async () => {
    render(brokerHost(<InlineAgentRunCard runId={RUN_ID} />));
    await screen.findByTestId("run-panel-stub");

    const read = panelProps.current?.readRunSnapshot as
      | (() => Promise<unknown>)
      | undefined;
    expect(typeof read).toBe("function");

    fetchCalls.length = 0;
    await read!();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(SEED_URL);
    const headers = headersOf(fetchCalls[0].init);
    expect(headers["authorization"]).toBe("Bearer cit_site");
    expect(headers["x-cinatra-widget-user-token"]).toBe("cwu_user");
    expect(fetchCalls[0].init.credentials).toBe("omit");
  });

  it("is the UNCHANGED first-party request on a cookie host", async () => {
    render(cookieHost(<InlineAgentRunCard runId={RUN_ID} />));
    await screen.findByTestId("run-panel-stub");

    const read = panelProps.current?.readRunSnapshot as
      | (() => Promise<unknown>)
      | undefined;
    expect(typeof read).toBe("function");

    fetchCalls.length = 0;
    await read!();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(SEED_URL);
    expect(headersOf(fetchCalls[0].init)["x-cinatra-widget-user-token"]).toBeUndefined();
    expect(fetchCalls[0].init.credentials).toBeUndefined();
  });

  it("is never built for a host whose credential was refused", async () => {
    // The refusal is total: no seed, no re-read, and no panel to hand one to.
    panelProps.current = null;
    render(refusedHost(<InlineAgentRunCard runId={RUN_ID} />));
    await waitFor(() => expect(fetchCalls).toHaveLength(0));
    expect(panelProps.current).toBeNull();
  });
});
