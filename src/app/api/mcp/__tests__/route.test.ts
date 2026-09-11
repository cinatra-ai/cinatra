// cinatra#3130 — the status `/api/mcp` answers an UNAUTHENTICATED probe.
//
// An external verification check calls this endpoint with no credential and
// keys off the status it gets back. That status is a contract, so it is stated
// in `src/app/api/mcp/route.ts`, stated in
// `docs/internals/contracts/mcp-supported-revisions.md` (Inbound), and pinned
// here — a future change to it has to change this file too, which makes the
// change deliberate instead of a silent break downstream.
//
// THE FIXTURE is the default posture, and only that: the dev-admin bypass
// disabled and no `Authorization` header at all. `grantDevAdminBypassThroughPort`
// in `packages/mcp-server/src/dev-admin-bypass.ts` returns false unless
// `CINATRA_MCP_DEV_ADMIN_BYPASS` is exactly "true" — before it consults the
// installed bypass port — and refuses again when nothing has filled that port,
// which is the case in this process. The variable is cleared below rather than
// assumed, so the fixture is the stated one even if the ambient environment
// sets it. It does NOT cover an enabled-bypass configuration.
//
// SCOPE vs. the sibling file. `src/lib/__tests__/mcp-cors-admission-contract.test.ts`
// pins the CORS header sets and the OPTIONS 204 seam. This file pins the five
// STATUSES as a set, driving the mount's own handlers rather than reconstructing
// the branch, and adds the route-export guard the 405 claim rests on.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpServerMount } from "../../../../../packages/mcp-server/src/index";

const __dirname_local = path.dirname(fileURLToPath(import.meta.url));
// src/app/api/mcp/__tests__ → repo root
const REPO_ROOT = path.resolve(__dirname_local, "../../../../..");

const BYPASS_ENV = "CINATRA_MCP_DEV_ADMIN_BYPASS";
const bypassEnvBefore = process.env[BYPASS_ENV];

beforeAll(() => {
  delete process.env[BYPASS_ENV];
});

afterAll(() => {
  if (bypassEnvBefore === undefined) {
    delete process.env[BYPASS_ENV];
  } else {
    process.env[BYPASS_ENV] = bypassEnvBefore;
  }
});

// The mount needs only `auth` and `getSession`. Neither is reached on this
// path: with no bearer token `verifyMcpAccessToken` answers false before it
// touches `auth`, so a bare object is enough and the fixture stays honest —
// nothing here stubs the auth gate itself.
const mount = createMcpServerMount({
  auth: {} as never,
  getSession: async () => null,
});

const PROBE_URL = "https://mcp.example.test/api/mcp";

type SupportedMethod = "GET" | "POST" | "DELETE" | "OPTIONS";

/** A probe carrying no credential, through the handler for its own method. */
function unauthenticatedProbe(method: SupportedMethod) {
  return mount.TransportHandlers[method](new Request(PROBE_URL, { method }));
}

/**
 * A method the route does not export. Next.js answers such a request 405 on
 * its own and never reaches the mount, so the mount's own method gate is
 * reached only by invoking an exported handler with it — which is exactly what
 * a direct (non-Next) invocation of the mount would do.
 */
function unsupportedMethodProbe(method: string) {
  return mount.TransportHandlers.GET(new Request(PROBE_URL, { method }));
}

describe("/api/mcp — the status an unauthenticated probe is answered with", () => {
  it.each(["GET", "POST", "DELETE"] as const)(
    "answers an unauthenticated %s with 401",
    async (method) => {
      const response = await unauthenticatedProbe(method);
      expect(response.status).toBe(401);
    },
  );

  it("answers the 401 with the recorded unauthorized body and a Bearer challenge", async () => {
    const response = await unauthenticatedProbe("POST");
    expect(await response.json()).toEqual({
      error: "unauthorized",
      message: "Authentication is required to access the Cinatra MCP server.",
    });
    expect(response.headers.get("WWW-Authenticate")).toMatch(/^Bearer resource_metadata=/);
  });

  it("answers OPTIONS with 204 — the preflight is never gated on a credential", async () => {
    expect((await unauthenticatedProbe("OPTIONS")).status).toBe(204);
  });

  it("answers a method the handler does not serve with 405", async () => {
    const response = await unsupportedMethodProbe("PUT");
    expect(response.status).toBe(405);
    // 405 wins over 401: the method gate runs before the auth gate, so an
    // unsupported method is never answered as an authentication problem.
    expect(response.status).not.toBe(401);
  });
});

// The 405 above is the mount's own defence-in-depth check. Under normal Next.js
// dispatch an unsupported method never reaches it: the route module exports
// exactly four methods, and Next answers anything else 405 itself. That claim
// rests on the export set, so the export set is pinned — including the
// spellings the route does not currently use, since any of them would widen the
// set just as effectively.
describe("the route exports exactly the four methods the contract names", () => {
  it("exports GET, POST, DELETE and OPTIONS, and no other method", () => {
    const source = readFileSync(
      path.join(REPO_ROOT, "src/app/api/mcp/route.ts"),
      "utf8",
    );
    const exported = new Set(
      [
        ...source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g),
        ...source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g),
      ].map((match) => match[1]),
    );
    expect(exported).toEqual(new Set(["GET", "POST", "DELETE", "OPTIONS"]));
    // A re-export list or a default export would add a handler without
    // matching either pattern above, so neither may appear.
    expect(source).not.toMatch(/export\s*\{/);
    expect(source).not.toMatch(/export\s+default\b/);
  });
});
