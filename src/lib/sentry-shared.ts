// The Sentry runtime-safe shared surface lives in @cinatra-ai/errors
// (packages/errors/src/index.ts). This one-line re-export shim preserves the
// public `@/lib/sentry-shared` path so any lingering importer keeps working.
export * from "@cinatra-ai/errors";
