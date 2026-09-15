// THE TOOL ROAD'S EGRESS SEAM — `appointment_schedule_add` reached from the
// MCP tool dispatch rather than from the connector's own setup screen.
//
// WHY THIS TEST EXISTS (measured, not supposed). On one instance, in one
// minute, against one live connection: the SAME add settled in 1.95 s through
// the connector's setup screen, while every attempt on the tool road was still
// unanswered when its caller gave up at about 59 s — four times in the same
// window, with the toolbox handshake answering in 0.16 to 0.28 s beside them.
// The connector's work was therefore not slow; the road was unbounded.
//
// The mechanism is the one `src/lib/extension-egress-fetch.ts` names: the app
// runtime replaces the server's `fetch` with a deduplicating wrapper that tees
// every dedupable GET response and retains the sibling branch, so an AWAITED
// release of an unread body — what any hop-following fetch loop does on every
// redirect — never settles. Handing the request a bound is that path's own
// documented opt-out. The ui-action dispatch enters the host's egress scope
// and so gets that bound; the capability facade this suite drives did not,
// because the tool dispatch and the deterministic passthrough never enter a ui
// action.
//
// Everything below runs against the runtime's OWN dedupe fetch over a LOCAL
// loopback 302 chain and a stub connector module. No real booking link, no
// Google credential and no network are involved.
//
// RED at the previous head: the hop-following specs and the refusal spec hang
// until vitest's own test timeout, and the never-settling spec hangs forever
// because the facade had no bound at all.
// GREEN now: the facade runs every touch of the connector inside the shared
// bounded egress scope, so the hops finish, an unreachable connector answers a
// named sentence, and the connector's OWN refusal sentence arrives unchanged.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDedupeFetch } from "next/dist/server/lib/dedupe-fetch";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import {
  addAppointmentScheduleForUser,
  APPOINTMENT_SCHEDULE_ADD_TIMEOUT_ERROR,
  APPOINTMENT_SCHEDULE_ADD_TIMEOUT_MS,
  appointmentScheduleAddTimeoutError,
} from "@/lib/appointment-schedule-add.server";
import { createAppointmentScheduleAddMcpModule } from "@/lib/appointment-schedule-add-mcp";

const mocks = vi.hoisted(() => ({
  loadConnectorModule: vi.fn(),
  resolveExtensionActorSummary: vi.fn(),
}));

vi.mock("@/lib/connector-modules.server", () => ({
  hasConnectorModule: () => true,
  loadConnectorModule: mocks.loadConnectorModule,
}));

vi.mock("@/lib/extension-host-actor", () => ({
  resolveExtensionActorSummary: mocks.resolveExtensionActorSummary,
}));

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const CONNECTOR_SOURCE = readFileSync(
  join(
    REPO_ROOT,
    "extensions",
    "cinatra-ai",
    "google-appointment-schedules-connector",
    "src",
    "index.ts",
  ),
  "utf8",
);

/** The connector's refusal for a calendar id that is not one of the person's —
 *  the acceptance sentence, rendered for one id. Pinned against the connector's
 *  own source below so this is never a sentence invented by the test. */
function invalidCalendarRefusal(requested: string): string {
  return (
    `"${requested}" is not one of your Google calendars. Connect Google Calendar and try again, ` +
    `or omit calendarId to use your primary calendar.`
  );
}

const PAGE_HTML =
  "<!doctype html><html><head><title>Booking page</title></head><body>ok</body></html>";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/short") {
      res.writeHead(302, { location: "/mid" });
      res.end("redirecting");
      return;
    }
    if (req.url === "/mid") {
      res.writeHead(302, { location: "/page" });
      res.end("redirecting");
      return;
    }
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** The app runtime's OWN server fetch: the real deduplicating wrapper that tees
 *  every dedupable GET response and retains the sibling branch. */
function installRuntimeServerFetch() {
  vi.stubGlobal("fetch", createDedupeFetch(globalThis.fetch) as unknown as typeof fetch);
}

/** The connector's own shape: vet-then-request each hop with redirects
 *  unfollowed, releasing each redirect's unread body before moving on. The
 *  release is AWAITED, exactly as a connector written against the fetch
 *  standard writes it. */
async function followHopsReleasingBodies(startUrl: string): Promise<string> {
  let current = startUrl;
  for (let hop = 0; hop <= 5; hop += 1) {
    const response = await fetch(current, {
      headers: { "User-Agent": "Cinatra/1.0" },
      cache: "no-store",
      redirect: "manual",
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Unable to load the page (${response.status}).`);
      if (response.body && !response.bodyUsed) await response.body.cancel();
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) {
      if (response.body && !response.bodyUsed) await response.body.cancel();
      throw new Error(`Unable to load the page (${response.status}).`);
    }
    return await response.text();
  }
  throw new Error("too many redirects");
}

type StubSchedule = { id: string; title: string; calendarId: string };

/** Install a stub connector module in place of the bundled one. */
function stubConnector(over: {
  add: (userId: string, url: string, calendarId?: string) => Promise<unknown>;
  stored?: () => unknown;
}) {
  mocks.loadConnectorModule.mockResolvedValue({
    addUserGoogleAppointmentSchedule: over.add,
    getStoredGoogleAppointmentSchedules: over.stored ?? (() => ({ schedules: [] })),
  });
}

/** Drive the REAL MCP registration and hand back the tool callback the chat
 *  road invokes. */
function takeToolCallback(): (input: unknown) => Promise<{
  content: { type: string; text: string }[];
  structuredContent?: unknown;
}> {
  let registered: ((input: unknown) => Promise<unknown>) | undefined;
  const server = {
    registerTool: (_name: string, _config: unknown, handler: (input: unknown) => Promise<unknown>) => {
      registered = handler;
    },
  } as unknown as McpRuntimeToolServer;
  createAppointmentScheduleAddMcpModule().registerCapabilities(server);
  if (!registered) throw new Error("the MCP module registered no tool");
  return registered as (input: unknown) => Promise<{
    content: { type: string; text: string }[];
    structuredContent?: unknown;
  }>;
}

describe("the appointment_schedule_add tool road runs the connector inside the host's bounded egress scope", () => {
  it("the refusal sentence this suite drives is the CONNECTOR's own, read from its source", () => {
    expect(CONNECTOR_SOURCE).toContain(
      "is not one of your Google calendars. Connect Google Calendar and try again, ",
    );
    expect(CONNECTOR_SOURCE).toContain("or omit calendarId to use your primary calendar.");
  });

  it("a connector that follows hops and releases each body COMPLETES through the MCP tool road", async () => {
    installRuntimeServerFetch();
    mocks.resolveExtensionActorSummary.mockResolvedValue({ userId: "u-1" });
    const stored: StubSchedule[] = [];
    stubConnector({
      add: async (_userId, url) => {
        const html = await followHopsReleasingBodies(url);
        expect(html).toContain("Booking page");
        stored.push({ id: "s-1", title: "Booking page", calendarId: "primary" });
        return stored[0];
      },
      stored: () => ({ schedules: stored }),
    });

    const call = takeToolCallback();
    const answer = await call({ url: `${base}/short` });

    expect((answer.structuredContent as { schedules: StubSchedule[] }).schedules).toHaveLength(1);
    expect(answer.content[0]?.text).toContain("Booking page");
  }, 15_000);

  it("the same hop-following add COMPLETES through the shared implementation both host surfaces call", async () => {
    installRuntimeServerFetch();
    const stored: StubSchedule[] = [];
    stubConnector({
      add: async (_userId, url) => {
        await followHopsReleasingBodies(url);
        stored.push({ id: "s-1", title: "Booking page", calendarId: "primary" });
        return stored[0];
      },
      stored: () => ({ schedules: stored }),
    });

    const result = await addAppointmentScheduleForUser({
      invokingUserId: "u-1",
      url: `${base}/short`,
      calendarId: undefined,
    });

    expect((result as { schedules: StubSchedule[] }).schedules).toHaveLength(1);
  }, 15_000);

  it("a connector that never settles is given up on with a bounded, named answer, not an endless await", async () => {
    stubConnector({ add: () => new Promise<never>(() => {}) });

    await expect(
      addAppointmentScheduleForUser({
        invokingUserId: "u-1",
        url: `${base}/short`,
        calendarId: undefined,
        timeoutMs: 60,
      }),
      // The sentence names the bound THIS run waited, not the default one: the
      // caller chose 60 ms, so telling somebody we waited thirty seconds would
      // be a sentence about a wait that never happened.
    ).rejects.toThrow(appointmentScheduleAddTimeoutError(60));
  });

  it("the timeout sentence names the bound that was actually waited", () => {
    expect(appointmentScheduleAddTimeoutError(60)).toContain("within 60 milliseconds");
    expect(appointmentScheduleAddTimeoutError(60)).not.toContain("30 seconds");
    // The shipped road waits the default bound, and its sentence is unchanged.
    expect(APPOINTMENT_SCHEDULE_ADD_TIMEOUT_MS).toBe(30_000);
    expect(APPOINTMENT_SCHEDULE_ADD_TIMEOUT_ERROR).toContain("within 30 seconds");
    expect(appointmentScheduleAddTimeoutError(APPOINTMENT_SCHEDULE_ADD_TIMEOUT_MS)).toBe(
      APPOINTMENT_SCHEDULE_ADD_TIMEOUT_ERROR,
    );
  });

  it("an unknown calendar id is refused with the CONNECTOR's exact sentence, never a generic timeout", async () => {
    // Turn (c) of the acceptance walk. The refusal lives BEHIND the booking-page
    // fetch in the connector's own call order, so on the unbounded road the
    // refusal was never reached at all and the person saw a timeout instead.
    installRuntimeServerFetch();
    mocks.resolveExtensionActorSummary.mockResolvedValue({ userId: "u-1" });
    stubConnector({
      add: async (_userId, url, calendarId) => {
        await followHopsReleasingBodies(url);
        throw new Error(invalidCalendarRefusal(String(calendarId)));
      },
    });

    const call = takeToolCallback();
    // The runtime turns a thrown tool error into the tool's error text using
    // the error's own `message`, so what is asserted here is what the caller
    // reads.
    let raised: unknown;
    try {
      await call({ url: `${base}/short`, calendarId: "not-real" });
    } catch (error) {
      raised = error;
    }
    expect((raised as Error | undefined)?.message).toBe(invalidCalendarRefusal("not-real"));
    expect((raised as Error | undefined)?.message).not.toBe(APPOINTMENT_SCHEDULE_ADD_TIMEOUT_ERROR);
  }, 15_000);

  it("a connector that answers straight away is not slowed and its value is returned untouched", async () => {
    stubConnector({
      add: async () => ({ id: "s-1" }),
      stored: () => ({ schedules: [{ id: "s-1", title: "t", calendarId: "primary" }] }),
    });

    const started = Date.now();
    const result = await addAppointmentScheduleForUser({
      invokingUserId: "u-1",
      url: `${base}/page`,
      calendarId: undefined,
    });

    expect(result).toEqual({ schedules: [{ id: "s-1", title: "t", calendarId: "primary" }] });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("the host's own refusals still answer without ever reaching the connector", async () => {
    stubConnector({
      add: async () => {
        throw new Error("the connector must not be reached");
      },
    });

    await expect(
      addAppointmentScheduleForUser({ invokingUserId: "u-1", url: "", calendarId: undefined }),
    ).resolves.toEqual({ error: "A booking page URL is required." });
    expect(mocks.loadConnectorModule).not.toHaveBeenCalled();
  });
});
