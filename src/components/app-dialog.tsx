"use client";

// AppDialog now lives in @cinatra-ai/sdk-ui so extension pages can consume it
// without an `@/` host edge. This host module re-exports it for host callers.
export { AppDialog } from "@cinatra-ai/sdk-ui";
