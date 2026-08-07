// cinatra#2478 — the advertised-origin treatment shared by every OAuth metadata
// document this instance serves.
//
// `origin-rewrite.test.ts` (sibling file) covers the pure string/value
// transforms. THIS file covers the two request-shaped pieces that sit on top of
// them — `inferRequestOrigin` (the single trusted source of the PUBLIC origin)
// and `rewriteJsonOriginResponse` (the treatment applied to an already-built
// JSON document) — plus a composition guard for the SIBLING routes that were
// already correct before #2478 and are deliberately NOT modified by it:
//
//   src/app/.well-known/oauth-authorization-server/api/auth/route.ts
//   src/app/.well-known/openid-configuration/api/auth/route.ts
//
// Both are two-line re-exports of the mount's handler groups, so the treatment
// they depend on lives in `createMcpServerMount`. Before #2478 that treatment
// was a PRIVATE function in index.tsx with no direct coverage: moving it into
// the shared, exported leaf is what let the `/api/cli` protected-resource route
// reuse it, and it is also what makes a regression in the sibling's document
// visible here rather than only on a live deployment.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { inferRequestOrigin, rewriteJsonOriginResponse } from "../origin-rewrite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/mcp-server/src/__tests__ → repo root
const REPO_ROOT = path.resolve(__dirname, "../../../..");

const INTERNAL = "https://0.0.0.0:3102";
const PUBLIC = "https://cinatra.ossflywheel.com";

/** A request as it arrives at the app behind a TLS-terminating reverse proxy. */
function proxiedRequest(pathname: string): Request {
  return new Request(`${INTERNAL}${pathname}`, {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "cinatra.ossflywheel.com",
    },
  });
}

describe("inferRequestOrigin — the trusted public-origin source", () => {
  it("prefers the forwarded proto+host pair over the internal request origin", () => {
    expect(inferRequestOrigin(proxiedRequest("/.well-known/oauth-protected-resource/api/cli"))).toBe(PUBLIC);
  });

  it("falls back to the request URL origin when the request is not proxied", () => {
    expect(inferRequestOrigin(new Request("http://localhost:3103/x"))).toBe("http://localhost:3103");
  });

  it("falls back to the request URL origin when only ONE of the pair is present", () => {
    // A half-set pair is not a proxy contract — trusting `x-forwarded-host`
    // alone would have to guess the scheme, and trusting `x-forwarded-proto`
    // alone yields the internal host under a different scheme. Both are worse
    // than the honest internal origin.
    expect(
      inferRequestOrigin(new Request("http://internal.test:3000/x", { headers: { "x-forwarded-host": "public.test" } })),
    ).toBe("http://internal.test:3000");
    expect(
      inferRequestOrigin(new Request("http://internal.test:3000/x", { headers: { "x-forwarded-proto": "https" } })),
    ).toBe("http://internal.test:3000");
  });
});

describe("rewriteJsonOriginResponse", () => {
  it("rewrites the internal origin to the public one throughout a JSON document", async () => {
    const request = proxiedRequest("/.well-known/oauth-authorization-server/api/auth");
    const rewritten = await rewriteJsonOriginResponse({
      request,
      response: Response.json({
        issuer: `${INTERNAL}/api/auth`,
        authorization_endpoint: `${INTERNAL}/api/auth/oauth2/authorize`,
        token_endpoint: `${INTERNAL}/api/auth/oauth2/token`,
        jwks_uri: `${INTERNAL}/api/auth/jwks`,
        scopes_supported: ["openid", "cli:status"],
        authorization_response_iss_parameter_supported: true,
      }),
    });

    await expect(rewritten.json()).resolves.toEqual({
      issuer: `${PUBLIC}/api/auth`,
      authorization_endpoint: `${PUBLIC}/api/auth/oauth2/authorize`,
      token_endpoint: `${PUBLIC}/api/auth/oauth2/token`,
      jwks_uri: `${PUBLIC}/api/auth/jwks`,
      scopes_supported: ["openid", "cli:status"],
      authorization_response_iss_parameter_supported: true,
    });
  });

  it("preserves status and headers, and drops the now-wrong content-length", async () => {
    const response = Response.json(
      { issuer: `${INTERNAL}/api/auth` },
      { status: 200, headers: { "cache-control": "no-store", "content-length": "42" } },
    );
    const rewritten = await rewriteJsonOriginResponse({ request: proxiedRequest("/x"), response });

    expect(rewritten.status).toBe(200);
    expect(rewritten.headers.get("cache-control")).toBe("no-store");
    expect(rewritten.headers.get("content-type")).toContain("application/json");
    // A rewrite changes the byte length; a stale content-length would truncate
    // or stall the response on the wire.
    expect(rewritten.headers.get("content-length")).toBeNull();
  });

  it("returns the SAME response object untouched when the request is not proxied", async () => {
    const response = Response.json({ issuer: "http://localhost:3103/api/auth" });
    const rewritten = await rewriteJsonOriginResponse({
      request: new Request("http://localhost:3103/.well-known/oauth-authorization-server/api/auth"),
      response,
    });

    expect(rewritten).toBe(response);
    await expect(rewritten.json()).resolves.toEqual({ issuer: "http://localhost:3103/api/auth" });
  });

  it("returns a non-JSON response untouched", async () => {
    const response = new Response(INTERNAL, { headers: { "content-type": "text/plain" } });
    const rewritten = await rewriteJsonOriginResponse({ request: proxiedRequest("/x"), response });

    expect(rewritten).toBe(response);
    await expect(rewritten.text()).resolves.toBe(INTERNAL);
  });

  it("returns an unparseable JSON body untouched rather than failing the request", async () => {
    const response = new Response("{not json", { headers: { "content-type": "application/json" } });
    const rewritten = await rewriteJsonOriginResponse({ request: proxiedRequest("/x"), response });

    expect(rewritten).toBe(response);
  });
});

describe("sibling metadata routes keep the origin-rewrite treatment (#2478 regression)", () => {
  const indexSource = readFileSync(path.join(REPO_ROOT, "packages/mcp-server/src/index.tsx"), "utf8");

  // The two route files are unmodified by #2478; assert they still delegate to
  // the mount handler groups whose treatment the behavioral cases above pin.
  it.each([
    ["src/app/.well-known/oauth-authorization-server/api/auth/route.ts", "AuthorizationServerMetadataHandlers"],
    ["src/app/.well-known/openid-configuration/api/auth/route.ts", "OpenIdConfigurationHandlers"],
  ])("%s re-exports mcpServerMount.%s", (routeFile, handlerGroup) => {
    const full = path.join(REPO_ROOT, routeFile);
    expect(existsSync(full)).toBe(true);
    expect(readFileSync(full, "utf8")).toContain(`mcpServerMount.${handlerGroup}`);
  });

  it.each([["AuthorizationServerMetadataHandlers"], ["OpenIdConfigurationHandlers"]])(
    "createMcpServerMount still routes %s through rewriteJsonOriginResponse",
    (handlerGroup) => {
      // Slice from the group key to the end of its handler object so a
      // `rewriteJsonOriginResponse` occurrence in a NEIGHBOURING group cannot
      // satisfy this assertion.
      const start = indexSource.indexOf(`${handlerGroup}: {`);
      expect(start).toBeGreaterThan(-1);
      const end = indexSource.indexOf("\n    },", start);
      expect(end).toBeGreaterThan(start);
      expect(indexSource.slice(start, end)).toContain("rewriteJsonOriginResponse({");
    },
  );

  it("index.tsx sources both origin helpers from the shared leaf (no private re-declaration)", () => {
    expect(indexSource).toContain(`import { inferRequestOrigin, rewriteJsonOriginResponse } from "./origin-rewrite";`);
    expect(indexSource).not.toMatch(/^(?:async )?function (?:inferRequestOrigin|rewriteJsonOriginResponse)\b/m);
  });
});
