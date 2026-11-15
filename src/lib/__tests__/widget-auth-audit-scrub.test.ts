// cinatra#4217 fold 3 — the widget-auth audit line never carries a credential
// shape, whatever a caller put in a field it controls.
//
// The renew route copies caller-controlled values (the client handle, the user
// agent) into its audit line. The scrubber is the defence in depth behind that:
// a value shaped like a credential is replaced before the line is written.
//
// RED BEFORE fold 3 (head e804438a): the scrubber knew the site (`cnx_`) and user
// (`cwu_`) shapes only, so a transport-token-shaped (`cit_`) value was logged
// as it was. The `cnx_` and `cwu_` cases pin behaviour that head already had.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function logged(): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  const line = lines[0]!;
  expect(line.startsWith("[widget-auth-audit] ")).toBe(true);
  return JSON.parse(line.slice("[widget-auth-audit] ".length)) as Record<string, unknown>;
}

// The transport token's wire form: `cit_` + 43 base64url characters.
// Built at run time so no credential-shaped literal sits in the source.
const TRANSPORT = "cit_" + "Ab9_-".repeat(8) + "Ab9";
const USER = "cwu_" + "Zy8".repeat(8);
const SITE = "cnx_" + "0123abcd-0123-4abc-8def-0123456789ab" + "_tail";

describe("emitWidgetAuthAudit scrubs credential shapes from every field", () => {
  it("a transport-token-shaped value in a caller-controlled field is redacted", () => {
    emitWidgetAuthAudit("renew_failure", { client: TRANSPORT, ua: `agent ${TRANSPORT}`, reason: "rate_limited" });
    const line = logged();
    expect(line.client).toBe("[redacted-secret]");
    expect(line.ua).toBe("[redacted-secret]");
    expect(line.reason, "an ordinary value is kept").toBe("rate_limited");
    expect(lines[0]).not.toContain(TRANSPORT.slice(0, 12));
  });

  it("the user and site credential shapes stay redacted (control)", () => {
    emitWidgetAuthAudit("renew_failure", { client: USER, siteId: SITE });
    const line = logged();
    expect(line.client).toBe("[redacted-secret]");
    expect(line.siteId).toBe("[redacted-secret]");
  });

  it("a short value that only starts like a prefix is not a credential and is kept", () => {
    emitWidgetAuthAudit("renew_failure", { reason: "cit_x", client: "wordpress" });
    const line = logged();
    expect(line.reason).toBe("cit_x");
    expect(line.client).toBe("wordpress");
  });
});
