// Stub for "@cinatra-ai/a2a" — vitest alias target used by root-level tests
// (e.g. src/__tests__/a2a-route.test.ts).
//
// The real @cinatra-ai/a2a barrel pulls in @cinatra/agent-builder (Drizzle, pg,
// pacote) and other heavy dependencies that blow up the root vitest runner.
// The A2A route module only needs `toSseResponse` + the `JSONRPCResponse`
// type at import time, so this stub re-exports them directly from their
// source files without going through the full barrel.
//
// @a2a-js/sdk lives only in packages/a2a/node_modules/ (not hoisted to root
// by pnpm). Define JSONRPCResponse inline here to avoid a TS2307 resolution
// error in the root tsconfig while keeping the shape structurally compatible.
//
// Unit tests in packages/a2a/src/__tests__ still use the real index via
// their package-level vitest.config.ts.
export { toSseResponse } from "../../packages/a2a/src/sse-response";

// Minimal structural alias — matches the JSON-RPC 2.0 response shape that
// @a2a-js/sdk exports as JSONRPCResponse. Used only as a type annotation in
// root-level tests; the real type is identical at the structural level.
export type JSONRPCResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};
