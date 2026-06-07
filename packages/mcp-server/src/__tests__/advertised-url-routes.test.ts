// MCP-04a — advertised-URL ↔ route-file shape guard.
//
// The MCP server advertises OAuth handshake URLs (loginPage / signupPage /
// consentPage + account variants) to external clients. Each must map to a real
// Next.js route file under src/app/api/mcp/*. A bare-suffix mismatch (e.g.
// advertising `<base>/sign-in` when the route file is `auth/[path]/page.tsx`)
// would 404 the OAuth handshake — this test would catch that regression.

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMcpHandshakeUrls } from "../handshake-urls";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/mcp-server/src/__tests__ → repo root
const REPO_ROOT = path.resolve(__dirname, "../../../..");

const HANDSHAKE_BASE = "/api/mcp";

/**
 * Map an advertised URL to the route file that must back it.
 * - `<base>/auth/<view>`    → src/app/api/mcp/auth/[path]/page.tsx
 * - `<base>/account/<view>` → src/app/api/mcp/account/[path]/page.tsx
 * - `<base>/consent`        → src/app/api/mcp/consent/page.tsx
 */
function routeFileForUrl(url: string): string {
  const rel = url.replace(/^\/api\/mcp/, "");
  if (rel.startsWith("/auth/")) return "src/app/api/mcp/auth/[path]/page.tsx";
  if (rel.startsWith("/account/")) return "src/app/api/mcp/account/[path]/page.tsx";
  if (rel === "/consent") return "src/app/api/mcp/consent/page.tsx";
  throw new Error(`No route mapping for advertised URL ${url}`);
}

describe("MCP advertised URLs map to real route files", () => {
  const urls = buildMcpHandshakeUrls(HANDSHAKE_BASE);

  it("loginPage carries the /auth/ prefix and resolves to a route file", () => {
    expect(urls.loginPage).toBe("/api/mcp/auth/sign-in");
    expect(existsSync(path.join(REPO_ROOT, routeFileForUrl(urls.loginPage)))).toBe(true);
  });

  it("signupPage carries the /auth/ prefix and resolves to a route file", () => {
    expect(urls.signupPage).toBe("/api/mcp/auth/sign-up");
    expect(existsSync(path.join(REPO_ROOT, routeFileForUrl(urls.signupPage)))).toBe(true);
  });

  it("consentPage resolves to a route file", () => {
    expect(urls.consentPage).toBe("/api/mcp/consent");
    expect(existsSync(path.join(REPO_ROOT, routeFileForUrl(urls.consentPage)))).toBe(true);
  });

  it("account variants resolve to the account route file", () => {
    expect(urls.accountSettings).toBe("/api/mcp/account/settings");
    expect(urls.accountSecurity).toBe("/api/mcp/account/security");
    expect(existsSync(path.join(REPO_ROOT, routeFileForUrl(urls.accountSettings)))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, routeFileForUrl(urls.accountSecurity)))).toBe(true);
  });
});
