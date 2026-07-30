// cinatra#2221 — the `/api/mcp` CORS request-header admission contract.
//
// #2218 L1 admitted `Mcp-Method` / `Mcp-Name` into
// `Access-Control-Allow-Headers` because the 2026-07-28 revision REQUIRES them
// on a modern request (a modern request missing a required one is answered
// `-32020` by the SDK's `validateStandardRequestHeaders`). Dropping either one
// would therefore make the revision unusable from any browser-origin client —
// silently, and only for browsers. Nothing gated that until this file.
//
// It also pins the SEPARATE expose-list answer: both are REQUEST headers. No
// audited path — the SDK's or cinatra's — writes either onto a response, so
// `Access-Control-Expose-Headers` deliberately does not carry them.
//
// SCOPE. This file pins the two header SETS and the OPTIONS seam, and nothing
// else about CORS: the allow-origin value and the allowed-method list are not
// asserted here, because #2221 decided nothing about them.
//
// PLACEMENT. This lives under `src/lib/__tests__` (the root vitest include)
// rather than beside its subject in `packages/mcp-server/src/__tests__`,
// because that package's suite is not wired into a required check — only two
// named files from it run in CI. Importing the module under test directly keeps
// the set assertions behavioural rather than a source-text match.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendCorsHeaders,
  MCP_CORS_ALLOW_HEADERS,
  MCP_CORS_EXPOSE_HEADERS,
} from "../../../packages/mcp-server/src/inbound-era";

const __dirname_local = path.dirname(fileURLToPath(import.meta.url));
// src/lib/__tests__ → repo root
const REPO_ROOT = path.resolve(__dirname_local, "../../..");

/** Header names are case-insensitive; compare normalized SETS, never strings. */
function headerNameSet(value: string | null): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
}

/**
 * The exact response `createMcpServerMount`'s `transportHandler` returns for a
 * CORS preflight. The seam guard at the bottom of this file fails if that
 * branch — or the route wiring that reaches it — stops matching.
 */
function preflightResponse() {
  return appendCorsHeaders(new Response(null, { status: 204 }));
}

function normalizeSource(repoRelativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, repoRelativePath), "utf8").replace(/\s+/g, " ");
}

describe("/api/mcp CORS preflight — revision-required request headers", () => {
  it("answers a preflight 204 carrying an allow-headers list", () => {
    const response = preflightResponse();
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Headers")).toBeTruthy();
  });

  it.each([
    // Sent by every authenticated MCP client.
    "authorization",
    "content-type",
    // Revision negotiation (2025-era header validation + the modern claim).
    "mcp-protocol-version",
    // 2026-07-28: REQUIRED on every modern request.
    "mcp-method",
    // 2026-07-28: REQUIRED on tools/call, prompts/get and resources/read when
    // the body supplies the mirrored params.name / params.uri.
    "mcp-name",
  ])("admits %s, which a spec-conformant modern request must be able to send", (headerName) => {
    expect(headerNameSet(preflightResponse().headers.get("Access-Control-Allow-Headers"))).toContain(
      headerName,
    );
  });

  it("admits EXACTLY the recorded set — any change must be deliberate", () => {
    // Widening the allow list on an endpoint served with a wildcard origin is a
    // real decision, and narrowing it can break a spec-conformant client. Either
    // way, record it in docs/internals/contracts/mcp-supported-revisions.md
    // before updating this expectation.
    expect(headerNameSet(preflightResponse().headers.get("Access-Control-Allow-Headers"))).toEqual(
      new Set([
        "authorization",
        "content-type",
        "mcp-protocol-version",
        "mcp-method",
        "mcp-name",
      ]),
    );
    expect(headerNameSet(MCP_CORS_ALLOW_HEADERS)).toEqual(
      headerNameSet(preflightResponse().headers.get("Access-Control-Allow-Headers")),
    );
  });
});

describe("/api/mcp CORS preflight — the expose list is answered separately", () => {
  it("does NOT expose Mcp-Method / Mcp-Name: they are request headers", () => {
    // `Access-Control-Expose-Headers` governs which RESPONSE headers a browser
    // client may read. No audited path writes either header onto a response, so
    // exposing them would advertise readability of something that is not there.
    const exposed = headerNameSet(preflightResponse().headers.get("Access-Control-Expose-Headers"));
    expect(exposed.has("mcp-method")).toBe(false);
    expect(exposed.has("mcp-name")).toBe(false);
  });

  it("exposes EXACTLY the recorded set", () => {
    expect(headerNameSet(preflightResponse().headers.get("Access-Control-Expose-Headers"))).toEqual(
      new Set(["www-authenticate", "mcp-protocol-version"]),
    );
    expect(headerNameSet(MCP_CORS_EXPOSE_HEADERS)).toEqual(
      headerNameSet(preflightResponse().headers.get("Access-Control-Expose-Headers")),
    );
  });
});

// STRUCTURAL seam guard — not behavioural proof.
//
// `packages/mcp-server/src/index.tsx` is a Next.js/React server module and
// cannot be imported here, so the chain from the route to the branch under test
// is asserted on normalized source instead. It proves the wiring is WRITTEN, not
// that it executes. Without it, the assertions above could keep passing while
// the route stopped emitting CORS at all.
//
// If a refactor reds this: that is the guard doing its job. Re-point the
// expectations at the new shape rather than deleting them.
describe("the preflight tested above is the one the route is wired to serve", () => {
  it("the /api/mcp route delegates OPTIONS to the mount's transport handler", () => {
    const route = normalizeSource("src/app/api/mcp/route.ts");
    expect(route).toContain("export async function OPTIONS(");
    expect(route).toContain("return transportHandlers.OPTIONS(...args);");
  });

  it("the mount maps OPTIONS onto transportHandler", () => {
    expect(normalizeSource("packages/mcp-server/src/index.tsx")).toContain(
      "TransportHandlers: { GET: transportHandler, POST: transportHandler, DELETE: transportHandler, OPTIONS: transportHandler, }",
    );
  });

  it("transportHandler answers OPTIONS through appendCorsHeaders", () => {
    expect(normalizeSource("packages/mcp-server/src/index.tsx")).toContain(
      'if (request.method === "OPTIONS") { return appendCorsHeaders(new Response(null, { status: 204 })); }',
    );
  });
});
