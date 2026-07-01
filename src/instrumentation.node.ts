/**
 * Next.js Node.js-runtime-only instrumentation.
 *
 * Loaded ONLY in the Node.js runtime (Next.js 15+ convention).
 * Turbopack does not check this file for Edge Runtime compatibility,
 * so we can safely use process.on() and other Node.js APIs here without
 * triggering "A Node.js API is used ... not supported in the Edge Runtime"
 * warnings.
 *
 * Mirror file: src/instrumentation.ts (intentionally a no-op shim).
 *
 * ── BOOT ORCHESTRATION (engineering #302) ────────────────────────────────────
 * This file used to BE the implementation body for every boot side effect (~30
 * inline blocks). It is now a thin ORCHESTRATOR shim:
 *   1. the STATIC DI-wiring imports below run at module load (before register());
 *   2. register() installs the process-level fatal-error handlers, guards the
 *      `next build` page-data phase, then delegates the ordered boot sequence to
 *      `runBoot()` (src/lib/boot/boot-orchestrator.ts), which runs each named,
 *      policy-tagged boot phase and records its outcome in the boot-state
 *      readiness surface (src/lib/boot/boot-state.ts).
 * The phase ORDER, dev-only gating, and detached-vs-awaited semantics are
 * preserved EXACTLY; the only behavioral change is the production fatal-error
 * policy (see src/lib/boot/fatal-error-policy.ts).
 */

// REQUIRED-ENV PREFLIGHT (cinatra#789 item 3). MUST be the FIRST import: it runs at
// module load, BEFORE every other DI-wiring binder below (several of which throw at
// import on a missing env var — e.g. @/lib/auth via the register-* chain). Running
// first lets a misconfigured prod deploy fail with ONE clear, aggregated message
// naming every missing required var. Inert during `next build` and in dev (see the
// module's scope guard) so it never breaks the image build.
import "@/lib/boot/required-env-preflight.init";

// Sentry server SDK init. Runs side-effect-only when SENTRY_DSN
// is set; otherwise it's a no-op. Must execute BEFORE initializeOtelTracing()
// so that @sentry/core has a live client when @sentry/opentelemetry attaches
// SpanProcessor/Sampler/Propagator to Cinatra's NodeTracerProvider.
//
// The Sentry onRequestError hook lives in src/instrumentation.ts (canonical
// Next.js entry point), runtime-gated to avoid pulling node-only @sentry/nextjs
// code into the Edge module graph.
import "../sentry.server.config";

// Publish the per-concern host connector services at boot (serverEntry
// transports self-bind at activation). Importing the module is enough; it
// auto-registers on load (registerHostConnectorServices is also exported for
// explicit calls from non-Next.js entrypoints such as BullMQ workers +
// vitest setup).
import "@/lib/register-host-connector-services";

// Wire the host enforcement behind the SDK `requireExtensionAction(...)` guard
// so extension server actions can gate on the per-install connector policy
// without importing host auth modules directly.
import "@/lib/register-extension-action-guard";
import "@/lib/register-extension-connector-config-store";
// Bind the Better Auth oauthClient surface (SDK globalThis DI slot) so the
// mcp-client connector's setup page + disconnect action can list/delete the
// external MCP OAuth clients without importing @/lib/better-auth-db directly
// (SDK-only decouple).
import "@/lib/register-extension-mcp-oauth-client-store";
// Wire the host A2A connection-storage provider (Nango connection records +
// external-agent-template store) behind the SDK's requireA2AConnectionProvider()
// contract, so the a2a-server-connector's "use server" actions resolve it without
// importing the nango-connector/agents stores by name (SDK-only decouple).
import "@/lib/register-a2a-connection-provider";

// Publish the host-side email ROUTING services (sender-identity resolution,
// dev-mode override, sent-email writer) behind the
// `@cinatra-ai/host:email-routing` capability. The email facade extension
// configures itself at serverEntry activation; concrete providers register
// behind the `email-send` capability from their own serverEntry.
import "@/lib/register-email-providers";
// Bind the google-oauth connection provider (SDK globalThis DI slot) so the
// google-oauth-connector's in-package setup page + save action can resolve the
// facade via requireGoogleOAuthConnectionProvider() without importing
// @cinatra-ai/google-oauth-connection by name (SDK-only decouple).
import "@/lib/register-google-oauth-provider";
// Bind the crm-connector request-actor resolver (SDK globalThis DI slot) so the
// crm-connector MCP handlers can mint the pointer-write actor from the current
// MCP request identity without importing @cinatra-ai/mcp-server's
// mcpRequestContextStorage by name (SDK-only decouple).
import "@/lib/register-crm-request-actor";

// Wire the OBJECTS provider DI slot at boot (the
// last sdkOnly edge): binds @cinatra-ai/objects' object-type registry +
// sync-adapter registry + graphiti episode client + objects_save behind the SDK's
// requireObjectsProvider() slot, so crm-connector imports only the SDK. Bound here
// (before the in-process BullMQ worker is created) so the ctx-less projector /
// pointer-repair worker paths resolve the slot too.
import "@/lib/register-objects-provider";

// Bind the SDK CRM provider registry's external resolver to the capability
// registry so a CRM provider registered from an extension serverEntry
// (`crm-provider` capability) resolves through lookupCrmProvider — the host
// names no concrete CRM provider. (The social facade needs no host impls; it
// configures itself at serverEntry activation over the `social-post`
// capability.)
import "@/lib/register-crm-providers";

// Bind the SDK PM (project-management) provider registry's external resolver to
// the host capability registry (cinatra#317), so a PM provider extension
// (plane-connector) registering behind the `pm-provider` capability is resolved
// lazily by the schedule↔PM-task sync bridge. Mirrors register-crm-providers.
import "@/lib/register-pm-providers";

// Publish the host-side blog ROUTING services (`@cinatra-ai/host:blog-routing`)
// and keep the SDK blog-connector slot bound (routing into the `blog-connector`
// capability). The blog facade extension configures itself at serverEntry
// activation.
import "@/lib/register-blog-providers";

import { installFatalErrorHandlers } from "@/lib/boot/fatal-error-policy";
import { runBoot } from "@/lib/boot/boot-orchestrator";

export async function register() {
  // Process-level safety nets (engineering #302). The fatal-error policy routes
  // every uncaughtException / unhandledRejection through the prod/dev classifier:
  //   - DEVELOPMENT: log + keep the process alive (verbatim today's behavior, so
  //     the hot-reload loop survives an in-flight typo).
  //   - PRODUCTION: log + flush telemetry + exit non-zero so the orchestrator
  //     restarts a clean process — UNLESS the fault is an explicitly classified
  //     recoverable transient infrastructure error (a reconnecting pg.Pool /
  //     IORedis socket), which keeps the process alive (the old behavior, now
  //     opt-IN per class). See src/lib/boot/fatal-error-policy.ts.
  installFatalErrorHandlers();

  // Skip ALL boot-time DB / disk / scheduler side effects
  // during `next build` page-data collection. Next.js spawns ~13 worker
  // processes in parallel during the "Collecting page data" phase, each
  // of which invokes `register()` on first use. Without this guard the
  // 13 workers race to upsert the same `cinatra.extensions` /
  // `cinatra.skills` / `cinatra.objects` rows and Postgres throws
  // `tuple concurrently updated` on the colliding UPDATEs, which fails
  // the build. Runtime phase (`phase-production-server`) and dev mode
  // (unset NEXT_PHASE) still run the full boot chain.
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return;
  }

  // Delegate the ordered boot sequence to the orchestrator. It runs each named,
  // policy-tagged boot phase in the SAME order as the original inline body,
  // preserving dev-only gating + detached-vs-awaited semantics, and records each
  // outcome in the boot-state readiness surface. A `fatal` phase that throws
  // propagates out here exactly as the original inline rethrows did (e.g. core
  // migrations / required-activation assert / closure gate in production).
  await runBoot();
}
