// Single dynamic-import entry point for the governed connector-instance
// invoker stack, used ONLY by the WordPress freshness adapter's lazy
// resolution (`wordpress-adapter.ts`'s `loadInvokerStack`).
//
// cinatra#2022 S7-γ post-merge repair: the adapter originally batched FOUR
// independent `await import(...)` call sites (invoker / host-services /
// write-authority / transport) via `Promise.all` directly at its own
// callsite. Each `import()` expression is its own bundler split point, so
// that shape created FOUR separate Turbopack async chunk groups reaching
// into a module graph that OTHER parts of the app (the S5 pending-call
// resume executor `connector-instance-pending-call-executor.ts`, the blog
// WordPress client `blog/wordpress.ts`) ALSO reach via ordinary STATIC
// imports of the very same specifiers. That dual static+dynamic
// reachability of the same modules, multiplied across four independent
// split points, is what Turbopack's production build (`next build`, browser
// e2e workflows) collided on: "Two or more assets with different content
// were emitted to the same output path" for chunk `_1mh00px._.js` — a
// chunk-naming collision, not a logic bug (both browser-e2e jobs; the
// separately-bundled main `build` check was unaffected).
//
// Fix: collapse the four split points into exactly ONE. This file's own
// imports below are ordinary static ES imports — but because NOTHING else
// in the app imports this file, and `wordpress-adapter.ts` only ever reaches
// it through a single `await import("./invoker-deps-lazy")`, Turbopack
// treats this whole file + its statically-imported closure as ONE async
// chunk group instead of four. Nothing about WHEN the graph loads changes
// (still fully lazy — nothing here executes until `loadInvokerDeps()` is
// awaited, i.e. only once a freshness probe actually runs); only how many
// independent chunk boundaries Turbopack has to reconcile against the same
// modules' static bundling elsewhere.
//
// vi.mock note: Vitest intercepts a specifier at the module-registry level
// regardless of whether the importing statement is static or dynamic, and
// regardless of which file performs it — moving these four imports here
// does not change the wordpress-freshness-adapter test's existing
// `vi.mock("@/lib/connector-instance-invoker", ...)` /
// `vi.mock("@/lib/register-host-connector-services", ...)` /
// `vi.mock("@/lib/connector-instance-write-authority", ...)` factories.
import { invokeConnectorInstanceTool } from "@/lib/connector-instance-invoker";
import { buildConnectorInstanceInvokerDeps } from "@/lib/register-host-connector-services";
import { resolveTrustedWriteActor } from "@/lib/connector-instance-write-authority";
import { InvokerError } from "@/lib/connector-instance-mcp-transport";

export async function loadInvokerDeps() {
  return {
    invokeConnectorInstanceTool,
    buildConnectorInstanceInvokerDeps,
    resolveTrustedWriteActor,
    InvokerError,
  };
}
