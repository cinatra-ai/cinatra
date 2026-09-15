// The MCP transport endpoint — the one HTTP surface external MCP clients
// connect through. Every method below forwards to the single `transportHandler`
// inside `createMcpServerMount` (`packages/mcp-server/src/index.tsx`).
//
// THE STATUS THIS ENDPOINT ANSWERS AN UNAUTHENTICATED PROBE WITH IS A CONTRACT.
// External checks call it with no credential and key off what comes back, so
// the matrix below is stated here, stated in
// `docs/internals/contracts/mcp-supported-revisions.md` (Inbound), and pinned by
// `src/app/api/mcp/__tests__/route.test.ts`. Changing any of these statuses
// means changing that test too — which is the point: it makes the change
// deliberate rather than a silent break downstream.
//
// With the dev-admin bypass at its default (`CINATRA_MCP_DEV_ADMIN_BYPASS`
// unset, so `grantDevAdminBypassThroughPort` refuses before it consults the
// installed bypass port at all) and no `Authorization` header:
//
//   OPTIONS                  204  — the CORS preflight is never gated on a
//                                   credential; it is answered before the auth
//                                   gate runs.
//   GET / POST / DELETE      401  — `createUnauthorizedResponse`: JSON
//                                   `{ error: "unauthorized", ... }` plus a
//                                   `WWW-Authenticate: Bearer resource_metadata=...`
//                                   challenge. This is answered BEFORE any
//                                   method-specific transport handling, so it is
//                                   the same status for all three.
//   any other method         405  — Next.js's own route dispatch answers this,
//                                   since only the four methods below are
//                                   exported and an unsupported one never
//                                   reaches `transportHandler`. `transportHandler`
//                                   separately answers 405 at the mount boundary
//                                   when it is invoked directly with one.
//
// The 405 that an AUTHENTICATED `GET` / `DELETE` gets from the legacy transport
// leg (a 2025-era session operation this endpoint does not serve) is a different
// answer, reached only after authentication has already passed. See the contract
// doc's Inbound section.
import { mcpServerMount } from "@/lib/mcp-server";

const transportHandlers = mcpServerMount.TransportHandlers;

export async function GET(
  ...args: Parameters<typeof transportHandlers.GET>
): ReturnType<typeof transportHandlers.GET> {
  return transportHandlers.GET(...args);
}

export async function POST(
  ...args: Parameters<typeof transportHandlers.POST>
): ReturnType<typeof transportHandlers.POST> {
  return transportHandlers.POST(...args);
}

export async function DELETE(
  ...args: Parameters<typeof transportHandlers.DELETE>
): ReturnType<typeof transportHandlers.DELETE> {
  return transportHandlers.DELETE(...args);
}

export async function OPTIONS(
  ...args: Parameters<typeof transportHandlers.OPTIONS>
): ReturnType<typeof transportHandlers.OPTIONS> {
  return transportHandlers.OPTIONS(...args);
}
