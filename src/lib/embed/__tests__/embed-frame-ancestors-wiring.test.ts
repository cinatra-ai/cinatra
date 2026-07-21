// S5 (cinatra#1221) Lane B §7/§2 — the frame-ancestors CSP wiring in the
// route-guard, and the /embed/assistant public-path allowlist. Proves the
// orphaned resolver is WIRED, FAIL-CLOSED to 'none', no-store, and that a
// sessionless visitor RENDERS (never 307→/sign-in).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { guardAppRoute } from "@/lib/auth-route-guard";
import type { NextRequest } from "next/server";

const GUARD_PATH = path.resolve(__dirname, "..", "..", "auth-route-guard.ts");
const guardSrc = fs.readFileSync(GUARD_PATH, "utf-8");

// No session cookie: a protected path 307s to /sign-in; a public path returns
// NextResponse.next() (status 200, no Location).
function req(pathname: string, search = ""): NextRequest {
  return {
    nextUrl: {
      pathname,
      searchParams: new URLSearchParams(search),
    },
    url: `http://localhost${pathname}${search ? `?${search}` : ""}`,
    cookies: { get: () => undefined },
    headers: new Headers(),
  } as unknown as NextRequest;
}

describe("auth-route-guard — /embed/assistant is public + CSP-wired (§2/§7)", () => {
  it("a SESSIONLESS visitor renders (200) — never 307→/sign-in", async () => {
    const res = await guardAppRoute(req("/embed/assistant", "assistant=wordpress&instanceId=inst-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("B7: FAILS CLOSED to frame-ancestors 'none' for an unknown assistant (DB-free path)", async () => {
    const res = await guardAppRoute(req("/embed/assistant", "assistant=bogus&instanceId=inst-1"));
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });

  it("FAILS CLOSED to 'none' when the assistant is absent", async () => {
    const res = await guardAppRoute(req("/embed/assistant"));
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });

  it("sets Cache-Control: no-store so a per-instance CSP is never cross-served, and omits X-Frame-Options", async () => {
    const res = await guardAppRoute(req("/embed/assistant", "assistant=wordpress&instanceId=inst-1"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBeNull();
  });

  it("sets the CSP from the resolver directive verbatim (no 'self' appended)", () => {
    // The resolver returns a bare origin or 'none'; the guard sets the directive
    // VERBATIM — it never concatenates 'self' onto the header value.
    expect(guardSrc).toMatch(/frame-ancestors \$\{directive\}/);
    expect(guardSrc).not.toMatch(/frame-ancestors \$\{directive\}\s*['"] *'self'/);
  });

  it("/embed/assistant is in the exact public allowlist", () => {
    expect(guardSrc).toMatch(/EMBED_ASSISTANT_PATH/);
    expect(guardSrc).toMatch(/"\/embed\/assistant"/);
  });
});

describe("AppShell — /embed/assistant renders CHROMELESS (§2/§3)", () => {
  const shellSrc = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "..", "components", "app-shell.tsx"),
    "utf-8",
  );
  it("bypasses the app shell for /embed/assistant (no sidebar/topbar/user chrome)", () => {
    expect(shellSrc).toMatch(/isEmbedAssistantPath\s*=\s*pathname === "\/embed\/assistant"/);
    // The bypass gate must actually include the embed path.
    expect(shellSrc).toMatch(/shouldBypassShell\s*=[^;]*isEmbedAssistantPath/);
  });

  it("a caller-supplied ?embed=1 can NOT activate the legacy cinatra:embed:submit listener on /embed/assistant", () => {
    // The legacy section-embed features are gated on `legacyEmbedMode`, which
    // excludes the embed-assistant path.
    expect(shellSrc).toMatch(/legacyEmbedMode\s*=\s*isEmbedMode && !isEmbedAssistantPath/);
    // The legacy listener + section styles hang off legacyEmbedMode, not isEmbedMode.
    expect(shellSrc).toMatch(/\{legacyEmbedMode && \(/);
    expect(shellSrc).toMatch(/rawEmbedSection = legacyEmbedMode/);
  });
});
