/**
 * Security regression for the two RELOCATED self-service mutations the
 * campaigns surface used to own: refreshing MY Gmail send-as aliases, and
 * saving MY appointment schedule.
 *
 * They now live in two DIFFERENT connectors, behind two DIFFERENT — both
 * host-owned, both fail-closed — boundaries, so this file pins one invariant
 * per shape:
 *
 *   1. gmail-connector ships a `"use server"` action. A server action is
 *      reachable by anyone who can POST to the page, so the authorization has
 *      to be IN the function: `requireExtensionAction(pkg, "read")` must be its
 *      FIRST executable statement. "read" admits any workspace member (the
 *      connector declares a user-scope default in cinatra/config.json —
 *      workspace tier, cinatra#955) and the action self-scopes to the session
 *      user id, so this self-service mutation must NOT require admin.
 *
 *   2. google-appointment-schedules-connector (cinatra#2367) ships NO server
 *      action at all: its surface is declarative (uiSurface "schema-config")
 *      and every mutation is a NAMED ACTION the host dispatches through
 *      /api/extensions/{installId}/actions/{actionId}, which resolves and
 *      authorizes the actor BEFORE any handler runs. The handler-side invariant
 *      is therefore SELF-SCOPING: each action that touches per-user state must
 *      resolve the session user first (`await requireUserId(ctx)`) and never
 *      accept a user id from action input. A `"use server"` export appearing in
 *      that package would be a NEW, unreviewed boundary — pinned absent.
 *
 * Both halves also guard against a lower-privilege reach-around copy in
 * src/app/campaigns/actions.ts.
 *
 * Lives under src/ (root-vitest-covered) — NOT co-located in the extensions —
 * so the invariant is enforced in CI (root vitest `include` skips extensions/**).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function sliceBalancedBlock(source: string, openBraceIndex: number): string {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(openBraceIndex + 1, i);
    }
  }
  throw new Error("unbalanced block");
}

function extractFunctionBody(source: string, fnName: string): string {
  const marker = `export async function ${fnName}`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`fn ${fnName} not found`);
  return sliceBalancedBlock(source, source.indexOf("{", start));
}

/**
 * The body of the `handler:` arrow registered for a schema-config named action
 * (`ctx.ui.registerAction({ id: "<actionId>", handler: async (...) => { … } })`).
 */
function extractNamedActionHandlerBody(source: string, actionId: string): string {
  const idMarker = `id: "${actionId}"`;
  const idAt = source.indexOf(idMarker);
  if (idAt === -1) throw new Error(`named action ${actionId} not found`);
  const handlerAt = source.indexOf("handler:", idAt);
  if (handlerAt === -1) throw new Error(`named action ${actionId} has no handler`);
  return sliceBalancedBlock(source, source.indexOf("{", source.indexOf("=>", handlerAt)));
}

function firstExecutableStatement(body: string): string {
  let s = body;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, "");
    if (s.startsWith("//")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1);
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end === -1 ? "" : s.slice(end + 2);
    }
    if (s === before) break;
  }
  return s;
}

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf-8");

const GMAIL_ACTIONS = "extensions/cinatra-ai/gmail-connector/src/actions.ts";
const SCHEDULES_REGISTER =
  "extensions/cinatra-ai/google-appointment-schedules-connector/src/register.ts";
const CALENDAR_SETUP_ACTIONS =
  "extensions/cinatra-ai/google-calendar-connector/src/setup-actions.ts";

describe("gmail relocated server action — extension read (workspace) gate", () => {
  it("refreshGmailSendAsAddressesAction: the FIRST executable statement is the requireExtensionAction read gate", () => {
    const body = extractFunctionBody(read(GMAIL_ACTIONS), "refreshGmailSendAsAddressesAction");
    expect(
      firstExecutableStatement(body).startsWith(
        `await requireExtensionAction(GMAIL_PACKAGE_ID, "read");`,
      ),
    ).toBe(true);
  });
});

describe("appointment-schedule named actions — host-dispatched, session-self-scoped", () => {
  // Every action that reads or writes a user's stored schedules (or their
  // account-scoped calendar list). `bookingPageGuideReady` is deliberately
  // excluded: it is the Help tab's always-ready probe and touches no state.
  const PER_USER_ACTIONS = [
    "listAppointmentSchedules",
    "deleteAppointmentSchedule",
    "listCalendars",
    "addSchedule",
  ];

  for (const actionId of PER_USER_ACTIONS) {
    it(`${actionId}: resolves the session user FIRST (self-scoping, never from input)`, () => {
      const body = extractNamedActionHandlerBody(read(SCHEDULES_REGISTER), actionId);
      expect(firstExecutableStatement(body).startsWith("const userId = await requireUserId(ctx);")).toBe(
        true,
      );
    });
  }

  it("the connector ships NO server action (its whole surface is host-dispatched)", () => {
    const source = read(SCHEDULES_REGISTER);
    expect(source.includes('"use server"')).toBe(false);
    expect(/export async function \w+Action\b/.test(source)).toBe(false);
  });

  it("the add path carries calendarId from input but the user id from the session", () => {
    const body = extractNamedActionHandlerBody(read(SCHEDULES_REGISTER), "addSchedule");
    // The session-resolved `userId` is the FIRST argument of the store call…
    expect(body).toContain("addUserGoogleAppointmentSchedule(userId, url,");
    // …while `calendarId` is the only per-call selection the payload supplies.
    expect(body).toMatch(/calendarId/);
    // No user identity is ever read off the action payload.
    expect(body).not.toMatch(/\b\w+\s*\??\.\s*_?userId\b/);
  });
});

describe("no reach-around copies of the relocated mutations", () => {
  // A lower-privilege requireAuthSession-only copy of these mutations in
  // src/app/campaigns/actions.ts (a "use server" module) would be a path AROUND
  // the gated connector surfaces — assert no such export exists, under the old
  // spellings as well as the new one.
  it("the legacy campaigns/actions.ts reach-around exports do NOT exist", () => {
    const campaigns = read("src/app/campaigns/actions.ts");
    for (const fn of [
      "refreshGmailSendAsAddressesAction",
      "addGoogleCalendarAppointmentScheduleAction",
      "addAppointmentScheduleAction",
      "clearGmailConnectionAction",
    ]) {
      expect(campaigns.includes(`export async function ${fn}`)).toBe(false);
    }
  });

  // Extraction-clean (cinatra#2367 S2): the appointment-schedule action left
  // google-calendar-connector entirely. A copy surviving there would be a
  // SECOND owner of the same mutation, on the older (connector-config) store.
  it("google-calendar-connector no longer ships the appointment-schedule action", () => {
    const setupActions = read(CALENDAR_SETUP_ACTIONS);
    expect(setupActions.includes("addGoogleCalendarAppointmentScheduleAction")).toBe(false);
    expect(/export async function \w*Appointment\w*/.test(setupActions)).toBe(false);
  });
});
