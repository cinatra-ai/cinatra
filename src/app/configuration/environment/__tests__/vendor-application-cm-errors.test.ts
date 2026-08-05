// Guards the terminal/auth-failure classifier that decides whether
// `applyVendorApplicationAction` rolls back its persist-first marker
// (cinatra#436 Defect 1). A regression that mis-classifies an auth refusal as
// ambiguous would re-strand a false "applied" state; mis-classifying an
// ambiguous transient failure as terminal would discard the idempotency marker
// and let a retry mint a duplicate cm row.

import { describe, expect, it } from "vitest";

import { isTerminalAuthFailure } from "../vendor-application-cm-errors";

// Local stub mirroring the shape `isTerminalAuthFailure` duck-types on
// (Error.message + a `responseBody` string). We deliberately do NOT import the
// real MarketplaceMcpError from the vendored marketplace MCP client package —
// that import is banned for new call sites (see
// scripts/audit/marketplace-mcp-client-banned.mjs) and the classifier never
// touches the concrete class, only these two fields.
class MarketplaceMcpError extends Error {
  constructor(
    message: string,
    public httpStatus: number,
    public responseBody: string,
  ) {
    super(message);
    this.name = "MarketplaceMcpError";
  }
}

describe("isTerminalAuthFailure", () => {
  it("matches the transport-level JSON-RPC McpError message (-32010)", () => {
    const err = new Error("MCP error -32010: Unauthorized: User not authenticated");
    expect(isTerminalAuthFailure(err)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // cinatra#2218 L2b — the MCP client's message format changed underneath this
  // classifier. Under `@modelcontextprotocol/sdk@1.29.0` a JSON-RPC error was an
  // `McpError` whose message EMBEDDED the code ("MCP error -32010: …"), so the
  // text scan saw it. Under `@modelcontextprotocol/client@2.0.0` it is a
  // `ProtocolError` whose message is the bare server text and whose code lives
  // on `.code` — measured, not assumed. Without the structural read these first
  // two cases regress to resting entirely on the English phrase.
  // ---------------------------------------------------------------------------

  it("matches a v2 ProtocolError-shaped error by its numeric .code alone (no code in the message)", () => {
    // The exact post-migration shape: unprefixed message, code on the property.
    const err = Object.assign(new Error("Unauthorized: User not authenticated"), {
      code: -32010,
    });
    expect(isTerminalAuthFailure(err)).toBe(true);
  });

  it("matches by numeric .code even when the message carries NO recognisable text", () => {
    // Guards the signal itself rather than the phrase: if cm ever rewords the
    // refusal, the code must still classify it terminal.
    const err = Object.assign(new Error("refused"), { code: -32010 });
    expect(isTerminalAuthFailure(err)).toBe(true);
  });

  it("does NOT match a NEIGHBOURING numeric code", () => {
    expect(isTerminalAuthFailure(Object.assign(new Error("nope"), { code: -32011 }))).toBe(false);
    expect(isTerminalAuthFailure(Object.assign(new Error("nope"), { code: -320100 }))).toBe(false);
    expect(isTerminalAuthFailure(Object.assign(new Error("nope"), { code: -32603 }))).toBe(false);
  });

  it("does NOT match a non-numeric .code that merely stringifies to the refusal code", () => {
    // An SdkError's `code` is a STRING enum member; a MarketplaceMcpError has no
    // `code` at all. Neither may be coerced into a terminal verdict — a false
    // terminal match discards the idempotency marker and lets a retry mint a
    // duplicate cm row.
    expect(isTerminalAuthFailure(Object.assign(new Error("nope"), { code: "-32010" }))).toBe(false);
    expect(
      isTerminalAuthFailure(Object.assign(new Error("nope"), { code: "ERA_NEGOTIATION_FAILED" })),
    ).toBe(false);
  });

  it("matches the explicit 'User not authenticated' phrase without the code", () => {
    expect(isTerminalAuthFailure(new Error("Unauthorized: User not authenticated"))).toBe(true);
  });

  it("matches when the auth refusal is in the MarketplaceMcpError responseBody", () => {
    const err = new MarketplaceMcpError(
      "Marketplace vendorApplicationApply returned an error: see body",
      502,
      JSON.stringify({ code: -32010, message: "Unauthorized: User not authenticated" }),
    );
    expect(isTerminalAuthFailure(err)).toBe(true);
  });

  it("matches the full phrase case-insensitively", () => {
    expect(isTerminalAuthFailure(new Error("UNAUTHORIZED: USER NOT AUTHENTICATED"))).toBe(true);
  });

  it("does NOT match a bare 'unauthorized' without the full unauthenticated phrase", () => {
    // A bare "unauthorized" can surface AFTER the cm row was created (a
    // downstream authorization/permission failure); treating it as terminal
    // would wrongly discard the idempotency marker and allow a duplicate row.
    expect(isTerminalAuthFailure(new Error("Unauthorized to publish to that scope"))).toBe(false);
    expect(
      isTerminalAuthFailure(
        new MarketplaceMcpError(
          "Marketplace vendorApplicationApply returned an error: scope unauthorized",
          403,
          JSON.stringify({ code: "scope_unauthorized", message: "scope unauthorized" }),
        ),
      ),
    ).toBe(false);
  });

  it("matches -32010 with surrounding punctuation/whitespace", () => {
    expect(isTerminalAuthFailure(new Error("rpc error (code=-32010): refused"))).toBe(true);
    expect(isTerminalAuthFailure(new Error("code -32010"))).toBe(true);
  });

  it("does NOT match a larger code that merely contains the -32010 digits", () => {
    // Boundary-anchored: -320100 / -132010 are different JSON-RPC codes and must
    // not be misread as the auth-refusal code -32010.
    expect(isTerminalAuthFailure(new Error("MCP error -320100: some other failure"))).toBe(false);
    expect(isTerminalAuthFailure(new Error("MCP error -132010: some other failure"))).toBe(false);
  });

  it("does NOT match an ambiguous transient/network failure (no rollback)", () => {
    expect(isTerminalAuthFailure(new Error("fetch failed: ECONNRESET"))).toBe(false);
    expect(isTerminalAuthFailure(new Error("socket hang up"))).toBe(false);
    expect(
      isTerminalAuthFailure(
        new MarketplaceMcpError("Marketplace vendorApplicationApply: empty response", 502, ""),
      ),
    ).toBe(false);
  });

  it("does NOT match the structured terms errors (those use error_code, not a throw)", () => {
    expect(isTerminalAuthFailure(new Error("TERMS_VERSION_STALE"))).toBe(false);
    expect(isTerminalAuthFailure(new Error("TERMS_DIGEST_MISMATCH"))).toBe(false);
  });

  it("is null/undefined/non-error safe", () => {
    expect(isTerminalAuthFailure(null)).toBe(false);
    expect(isTerminalAuthFailure(undefined)).toBe(false);
    expect(isTerminalAuthFailure(42)).toBe(false);
    expect(isTerminalAuthFailure({})).toBe(false);
  });
});
