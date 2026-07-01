import { describe, it, expect } from "vitest";
// Imported from the component module (the sdk-ui test convention — the module
// LOADS fine in the node env, only rendering needs testing-library). Inlining the
// helper there keeps it off the route-import graph the dev-perf ratchet tracks.
import { describeNangoConnectError } from "../nango-user-connect-button";

const GUIDANCE = "registered allow-list";

describe("describeNangoConnectError", () => {
  it("appends actionable guidance for LinkedIn-style redirect_uri mismatch", () => {
    const raw = "The redirect_uri does not match the registered value";
    const out = describeNangoConnectError(raw);
    expect(out.startsWith(raw)).toBe(true); // raw message preserved (may name the URI)
    expect(out).toContain(GUIDANCE);
    expect(out).toContain("Authorized redirect URI");
  });

  it("detects the Google-style redirect_uri_mismatch token", () => {
    expect(describeNangoConnectError("Error 400: redirect_uri_mismatch")).toContain(GUIDANCE);
  });

  it("detects a spaced/cased 'Redirect URI ... not allowed' variant", () => {
    expect(describeNangoConnectError("Redirect URI is not in the allow list")).toContain(GUIDANCE);
  });

  it("detects 'redirect URL' / 'callback URL' wording and whitelist phrasing", () => {
    expect(describeNangoConnectError("The redirect URL is not whitelisted")).toContain(GUIDANCE);
    expect(describeNangoConnectError("callback url does not match the registered one")).toContain(GUIDANCE);
  });

  it("passes other provider errors through UNCHANGED (no false-positive guidance)", () => {
    const raw = "Access denied by the user";
    expect(describeNangoConnectError(raw)).toBe(raw);
    const scope = "The requested scope is invalid for this app"; // 'invalid' but no redirect uri
    expect(describeNangoConnectError(scope)).toBe(scope);
  });

  it("falls back to a generic message for empty/missing input", () => {
    expect(describeNangoConnectError(undefined)).toBe("Authorization failed.");
    expect(describeNangoConnectError(null)).toBe("Authorization failed.");
    expect(describeNangoConnectError("   ")).toBe("Authorization failed.");
  });
});
