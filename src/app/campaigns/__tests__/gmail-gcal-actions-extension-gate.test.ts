/**
 * Security regression: the gmail + google-calendar server actions live in their
 * connectors and MUST gate on requireExtensionAction(pkg, "read") as the
 * FIRST executable statement. Both connectors are defaultVisibility "workspace"
 * and the setup page gates on enforceConnectorPolicy(..., "read"), so these
 * user-scoped self-service mutations (refresh MY send-as aliases / save MY
 * appointment schedule) must NOT require admin. "read" admits any workspace
 * member; each action self-scopes to the session user id. "read" is the
 * host-bound, workspace-scoped, fail-closed boundary and is THE security
 * boundary.
 *
 * Lives under src/ (root-vitest-covered) — NOT co-located in the extension — so
 * the invariant is enforced in CI (root vitest `include` skips extensions/**).
 * Both connectors reference the package id via a constant, so the gate assertion
 * matches that form.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function extractFunctionBody(source: string, fnName: string): string {
  const marker = `export async function ${fnName}`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`fn ${fnName} not found`);
  let i = source.indexOf("{", start);
  const bodyStart = i;
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(bodyStart + 1, i);
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

const CASES = [
  {
    file: "extensions/cinatra-ai/gmail-connector/src/actions.ts",
    fn: "refreshGmailSendAsAddressesAction",
    gate: `requireExtensionAction(GMAIL_PACKAGE_ID, "read")`,
  },
  {
    file: "extensions/cinatra-ai/google-calendar-connector/src/setup-actions.ts",
    fn: "addGoogleCalendarAppointmentScheduleAction",
    gate: `requireExtensionAction(GOOGLE_CALENDAR_PACKAGE_ID, "read")`,
  },
];

describe("gmail + google-calendar relocated actions — extension read (workspace) gate", () => {
  for (const c of CASES) {
    it(`${c.fn}: the FIRST executable statement is the requireExtensionAction read gate`, () => {
      const source = readFileSync(join(process.cwd(), c.file), "utf-8");
      const body = extractFunctionBody(source, c.fn);
      expect(firstExecutableStatement(body).startsWith(`await ${c.gate};`)).toBe(true);
    });
  }

  // Reach-around guard: a lower-privilege requireAuthSession-only copy of these
  // mutations in src/app/campaigns/actions.ts (a "use server" module) would be a
  // path AROUND the workspace-gated connector action — assert no such export
  // exists.
  it("the legacy campaigns/actions.ts reach-around exports do NOT exist", () => {
    const campaigns = readFileSync(join(process.cwd(), "src/app/campaigns/actions.ts"), "utf-8");
    for (const fn of [
      "refreshGmailSendAsAddressesAction",
      "addGoogleCalendarAppointmentScheduleAction",
      "clearGmailConnectionAction",
    ]) {
      expect(campaigns.includes(`export async function ${fn}`)).toBe(false);
    }
  });
});
