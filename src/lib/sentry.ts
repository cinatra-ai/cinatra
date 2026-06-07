// The server-only Sentry surface lives in @cinatra-ai/errors/server
// (packages/errors/src/server.ts). This one-line re-export shim keeps the
// public `@/lib/sentry` path stable. `errors/server` already re-exports the
// runtime-safe shared surface from its `./index`, so `export *` carries both
// the server helpers and the shared surface (shouldInitSentry /
// buildSentryClientOptions / beforeSendFilter / beforeBreadcrumbFilter +
// the two types).
export * from "@cinatra-ai/errors/server";
