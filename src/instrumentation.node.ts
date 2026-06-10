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
 */
import { ensureDevEncryptionKey } from "@/lib/dev-encryption-key-bootstrap";

// Sentry server SDK init. Runs side-effect-only when SENTRY_DSN
// is set; otherwise it's a no-op. Must execute BEFORE initializeOtelTracing()
// so that @sentry/core has a live client when @sentry/opentelemetry attaches
// SpanProcessor/Sampler/Propagator to Cinatra's NodeTracerProvider.
//
// The Sentry onRequestError hook lives in src/instrumentation.ts (canonical
// Next.js entry point), runtime-gated to avoid pulling node-only @sentry/nextjs
// code into the Edge module graph.
import "../sentry.server.config";

// Wire host-runtime impls into every transport
// connector at boot. Importing the module is enough; it auto-registers on
// load (registerTransportConnectors is also exported for explicit calls
// from non-Next.js entrypoints such as BullMQ workers + vitest setup).
import "@/lib/register-transport-connectors";

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

// Wire the email-connector facade at boot:
// register every EmailConnector provider (gmail today) + configure host-
// side routing + dev-mode override. After this loads, callers can call
// sendEmailThroughSystem(msg) from @cinatra-ai/email-connector.
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

// Wire the crm-connector facade at boot:
// registers every CrmConnector provider (twenty today) with the facade so
// lookupCrmProvider("twenty") resolves. After this loads, callers can use
// crmFacade.{contact,account,list}.* from @cinatra-ai/crm-connector.
import "@/lib/register-crm-providers";

// Wire the social-media-connector facade at boot.
// Auto-registers on import: configureSocialMediaSystem + registerSocialMediaConnector(linkedIn).
// After this loads, callers can call publishSocialMediaPostThroughSystem(post)
// from @cinatra-ai/social-media-connector.
import "@/lib/register-social-providers";

// Wire the blog-connector facade at boot.
// Auto-registers on import: configureBlogSystem + registerBlogConnector(defaultBlogConnector).
// After this loads, callers can call buildBlogDraftPayloadThroughSystem(input)
// from @cinatra-ai/blog-connector. Bundled site connectors self-register via their
// serverEntry into the facade (the SDK blog-connector provider slot).
import "@/lib/register-blog-providers";

export async function register() {
  // Process-level safety nets: log the actual error before the process dies.
  // Without these, any unhandled EventEmitter 'error' (e.g. from a pg.Pool or
  // IORedis connection drop) kills the process silently. These handlers both
  // prevent silent crashes and log the root cause for diagnosis.
  process.on("uncaughtException", (err) => {
    console.error("[CRASH] uncaughtException — server will NOT exit:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[CRASH] unhandledRejection — server will NOT exit:", reason);
  });

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

  // Dev-mode encryption key auto-gen. No-op in production.
  ensureDevEncryptionKey();

  // Install the durable extension data-teardown hook at boot so a hard
  // uninstall/forceDelete via a UI Server Action (which does NOT load the heavy
  // @/lib/extensions handler graph) still finds the hook wired. Lightweight
  // (only the hook setter + the prefix-delete helper); runs in dev AND prod.
  await import("@/lib/extension-data-teardown-wiring");

  // Install the hot-activate hook at boot for the SAME reason: a connector
  // install/update via a UI Server Action must hot-activate in-process (no
  // restart) even in a worker that never imported @/lib/extensions. Lightweight
  // (only the hook setter; the activator body is lazily imported on the first
  // install). Without it the dispatcher fail-closes the connector install.
  await import("@/lib/extension-activate-hook-wiring");

  // Pre-warm all version-based globalThis caches before the first navigation
  // arrives. Without this, the first 1-5 route visits hit cold caches and
  // spawn many Worker threads (Atomics.wait), each blocking the event loop.
  // Combined with Turbopack's lazy compilation window this creates a 5-30s
  // blackout that the browser interprets as "network error" / blank page.
  //
  // Running the DB reads here (at startup, no requests queued) also triggers
  // ensurePostgresSchema() — so the 30+ CREATE TABLE / migration queries run
  // once during startup, not during the first navigation.
  try {
    const {
      readStartupDatasetFromDatabase,
      readSkillCatalogFromDatabase,
      readStartupOverridesFromDatabase,
    } = await import("@/lib/database");
    readStartupDatasetFromDatabase();
    readSkillCatalogFromDatabase();
    readStartupOverridesFromDatabase();
  } catch {
    // Non-fatal — DB may not be configured yet (fresh install before setup wizard).
    // First navigation will warm caches normally.
  }

  // Backfill instanceId + instanceAttachSecret on the existing
  // instance_identity row. Idempotent; no-op for fresh installs pre-setup
  // (no row yet) and for any install where the setup wizard already
  // populated the fields inline. Awaited so downstream marketplace-attach
  // hooks see the populated fields.
  try {
    const { ensureInstanceId } = await import("@/lib/instance-identity-store");
    await ensureInstanceId();
  } catch (err) {
    console.error(
      "[boot] ensureInstanceId failed — instance-attach call sites will retry on next boot:",
      err,
    );
  }

  // Marketplace consumer attach + vendor-state reconcile. Awaited so any
  // downstream boot work that reads `identity.consumerAttachment` /
  // `vendorState` (e.g. the BullMQ seed for `vendor-application-state-reconcile`
  // or the catalog-sync deps assembly) sees the post-reconcile values.
  // Bails internally when `MARKETPLACE_INSTANCE_TOKEN` is set, when
  // `ensureInstanceId` hasn't populated durable fields yet, or when the
  // marketplace is unreachable — never blocks boot.
  try {
    const { ensureMarketplaceAttachment } = await import("@/lib/marketplace-attach");
    await ensureMarketplaceAttachment();
  } catch (err) {
    console.error(
      "[boot] ensureMarketplaceAttachment failed — marketplace consumer attach + vendor-state reconcile will retry on next boot:",
      err,
    );
  }

  // Prototype: run the StaticBundleLoader ALONGSIDE the legacy
  // facade registrations imported above, proving the host can consume the
  // generated manifest + activate a `register(ctx)`-shaped extension. ADDITIVE +
  // dev-default-on (the legacy registration already ran at import; the loader's
  // `capabilities` port dedupes by connectorId, so an already-registered provider
  // is a logged no-op). Dev-only + kill-switchable; never blocks boot. A later
  // cutover makes this the source of truth + drops the legacy path.
  if (
    process.env.CINATRA_RUNTIME_MODE === "development" &&
    process.env.CINATRA_DISABLE_STATIC_BUNDLE_LOADER !== "true"
  ) {
    try {
      const { loadStaticBundleExtensions } = await import("@/lib/static-bundle-loader");
      const results = await loadStaticBundleExtensions();
      if (results.length) {
        console.info(
          `[boot] StaticBundleLoader: ${results.length} result(s) — ` +
            results
              .map((r) => `${r.packageName.replace("@cinatra-ai/", "")}:${r.status}${r.reason ? `(${r.reason})` : ""}`)
              .join(", "),
        );
      }
    } catch (err) {
      console.error("[boot] StaticBundleLoader failed (non-fatal, additive prototype):", err);
    }
  }

  // Window-2 instance signature backfill — runs BEFORE the RuntimePackageLoader so
  // it sees the backfilled `source.signature` and can classify rows `trusted-signed`.
  // Inert until the host trusts a signing key (CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS);
  // kill-switchable, idempotent, bounded per-row, and soft-failing (never blocks boot).
  if ((process.env.CINATRA_EXTENSION_SIGNATURE_BACKFILL ?? "").trim().toLowerCase() !== "off") {
    try {
      const { runExtensionSignatureBackfill } = await import("@/lib/extension-signature-backfill");
      const r = await runExtensionSignatureBackfill({ log: (m) => console.info(m) });
      if (r.skippedReason) {
        console.info(`[boot] ExtensionSignatureBackfill: skipped (${r.skippedReason})`);
      } else if (r.scanned > 0) {
        console.info(
          `[boot] ExtensionSignatureBackfill: scanned ${r.scanned}, ` +
            `written ${r.written}, skipped ${r.skipped}, failed ${r.failed}`,
        );
      }
    } catch (err) {
      console.error("[boot] ExtensionSignatureBackfill failed (non-fatal):", err);
    }
  }

  // The runtime installer — the RuntimePackageLoader (PROD half of "dual loaders,
  // single activation"). Discovers extensions MATERIALIZED into the on-disk
  // package store (`/data/extensions/packages`) by the live installer and
  // activates them through the SAME shared driver WITHOUT an image rebuild —
  // the core plug-and-play proof. Runs in dev AND prod (unlike the dev-only
  // StaticBundleLoader); a missing `/data` volume / empty store is a clean
  // no-op. AWAITED on purpose: capabilities must be registered before the
  // server takes traffic (fast no-op when the store is empty). Trust-gated +
  // re-verifies integrity on every boot. In the runtime loader NO trusted install-record
  // resolver is injected, so the loader fails closed (activates nothing) until
  // the installer flow wires the DB-backed `resolveInstallAnchor`. Kill-switchable.
  if (process.env.CINATRA_DISABLE_RUNTIME_PACKAGE_LOADER !== "true") {
    try {
      const { loadRuntimePackageExtensions } = await import("@/lib/runtime-package-loader");
      const { makeDefaultInstallAnchorResolver } = await import("@/lib/extension-install-anchor");
      const resolveInstallAnchor = await makeDefaultInstallAnchorResolver();
      const results = await loadRuntimePackageExtensions(undefined, { resolveInstallAnchor });
      if (results.length) {
        console.info(
          `[boot] RuntimePackageLoader: ${results.length} result(s) — ` +
            results
              .map((r) => `${r.packageName.replace("@cinatra-ai/", "")}:${r.status}${r.reason ? `(${r.reason})` : ""}`)
              .join(", "),
        );
      }
    } catch (err) {
      console.error("[boot] RuntimePackageLoader failed (non-fatal):", err);
    }
  }

  // (Extension migrations run INSIDE loadRuntimePackageExtensions above —
  // for the loader's already trust-gated records, under the SAME verdict used for
  // in-process import — so an untrusted/pending package never creates its tables.
  // There is intentionally no separate boot migration pass.)

  // ── workflow-install-saga boot-orphan cleanup ────────────────────
  // A process killed mid-saga leaves an `extension_install_ops` row in a
  // NON-terminal phase (materialized/granted/preflighted). At boot, after the
  // schema is ensured, compensate + roll back any such op that has not advanced
  // for a threshold so a crashed half-install never lingers as a non-finalized
  // (and thus non-activatable, per the anchor gate) row. Idempotent +
  // best-effort: a transient DB error here must NOT crash boot. Self-contained
  // and clearly delimited so later boot blocks (migration runner, snapshot
  // GC) added to this file do not collide. Kill-switchable.
  if (process.env.CINATRA_DISABLE_INSTALL_OP_BOOT_CLEANUP !== "true") {
    try {
      const { listUnfinalizedInstallOps } = await import("@/lib/extension-install-ops");
      const { compensateOrphanInstallOp, makeDefaultWorkflowInstallSagaDeps } = await import(
        "@/lib/extension-workflow-install-saga"
      );
      // Only sweep ops idle for ≥5 minutes so an install in-flight in another
      // worker is never compensated out from under it.
      const STALE_MS = 5 * 60 * 1000;
      const orphans = await listUnfinalizedInstallOps(STALE_MS);
      if (orphans.length) {
        const deps = await makeDefaultWorkflowInstallSagaDeps();
        for (const op of orphans) {
          await compensateOrphanInstallOp(
            { installOpId: op.installOpId, packageName: op.packageName, orgId: op.orgId, phase: op.phase },
            deps,
          );
        }
        console.info(
          `[boot] workflow-install-saga: rolled back ${orphans.length} orphan install op(s) — ` +
            orphans.map((o) => `${o.packageName.replace("@cinatra-ai/", "")}(${o.phase})`).join(", "),
        );
      }
    } catch (err) {
      console.error("[boot] workflow-install-saga orphan cleanup failed (non-fatal):", err);
    }
  }

  // Dev-only — auto-load agents from the on-disk `agents/` tree at boot so
  // local edits to oas.json files surface immediately on dev-server restart.
  // Production installs go through `agent_builder_git_publish` / MCP (or
  // `cinatra setup prod` at provisioning time), never via this filesystem
  // scan, so gating on CINATRA_RUNTIME_MODE === "development" keeps prod
  // boot lean and avoids touching the DB with disk state at runtime.
  if (process.env.CINATRA_RUNTIME_MODE === "development") {
    // Fire-and-forget. This
    // dev-only agents/skills filesystem scan + marker backfill + WayFlow
    // reload + hot-reload watcher is ~18s of boot work and is NOT
    // prod-relevant (gated on CINATRA_RUNTIME_MODE; prod loads agents via
    // publish/MCP, never this scan). Running it detached lets register()
    // return immediately so the dev server starts serving ~18s sooner. The
    // synchronous DB pre-warm above is intentionally NOT deferred because it
    // prevents the first-navigation blackout. Trade-off: the first 1-2 dev requests
    // may hit a not-yet-loaded agent until this completes (dev-only; prod
    // behaviour unchanged). Errors stay self-contained — the inner
    // try/catch blocks below log and swallow; the `void` + top-level
    // unhandledRejection handler are the final nets.
    void (async () => {
    // Load git-native agent definitions from agents/ at startup.
    // The version-skip guard in ensureAgentPackageFromGitFile ensures DB writes
    // are skipped when the packageVersion matches — restarts are low-overhead.
    //
    // Canonical layout is extensions/cinatra-ai/<slug>-agent/cinatra/oas.json.
    // Scanner walks each top-level entry and probes both vendor-namespace and
    // fallback layouts:
    //   For each entry under <agentsDir>:
    //     a. Vendor-namespace dir (new): try entry/<sub>/cinatra/oas.json then
    //        entry/<sub>/cinatra/agent.json. If any sub-entry matches, treat the
    //        top-level entry as a vendor dir and continue to next entry.
    //     b. Backward-compatible layouts: entry/cinatra/agent.json or
    //        entry/agent.json — load via the entry-as-slug convention.
    try {
      const { readdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const {
        ensureAgentPackageFromGitFile,
        backfillPublishedMarkers,
        triggerWayflowReload,
      } = await import("@cinatra-ai/agents");
      const { resolveAgentInstallDir } = await import("@cinatra-ai/agents/agent-install-path");
      const agentsDir = resolveAgentInstallDir();

      // Backfill `.cinatra-published.json` markers for every
      // existing on-disk agent dir BEFORE wayflow's loader scans. The wayflow
      // container mounts `./agents:/agents:ro` so it can't write markers
      // itself; backfill must run from this Cinatra TS app where we have
      // write access.
      //
      // Idempotent: existing markers are preserved untouched. Missing markers
      // are derived from the current oas.json hash and treated as published.
      // Once every agent has a marker, scanned==N skipped==N written==0.
      try {
        const result = await backfillPublishedMarkers(agentsDir);
        const repaired = result.written + result.rewritten;
        if (repaired > 0 || result.errors.length > 0) {
          console.log(
            `[agents/backfill-markers] scanned=${result.scanned} ` +
              `written=${result.written} rewritten=${result.rewritten} ` +
              `skipped=${result.skipped} errors=${result.errors.length}`,
          );
          for (const err of result.errors) {
            console.warn(`[agents/backfill-markers] ${err.path}: ${err.reason}`);
          }
        }
        // If backfill wrote any markers, the wayflow
        // container that started before Next.js (compose dependency order
        // notwithstanding) scanned a markerless tree and mounted nothing.
        // Wake it with a best-effort reload so the live runtime catches up.
        // Rewritten markers from stale-hash repair also need a
        // reload — without it the loader still sees the agent gated as
        // `hash_mismatch` until the next publish/preflight.
        // Failure is non-fatal — the next publish/preflight will retry.
        if (repaired > 0) {
          try {
            const reloadResult = await triggerWayflowReload();
            if (reloadResult.ok) {
              console.log(
                `[agents/backfill-markers] post-backfill reload triggered (` +
                  `wrote ${result.written} + rewrote ${result.rewritten} markers; ` +
                  `wayflow mounted ${reloadResult.report.agents ?? "?"} agents)`,
              );
            } else {
              console.warn(
                `[agents/backfill-markers] post-backfill reload returned ok:false ` +
                  `reason=${reloadResult.reason} detail=${reloadResult.detail ?? "—"} ` +
                  `(wayflow may still be starting; next publish/preflight will retry)`,
              );
            }
          } catch (reloadErr) {
            console.warn(
              "[agents/backfill-markers] post-backfill reload threw (non-fatal):",
              reloadErr,
            );
          }
        }
      } catch (err) {
        console.warn("[agents/backfill-markers] failed (non-fatal):", err);
      }

      const entries = await readdir(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const entryPath = join(agentsDir, entry.name);

        // Vendor-namespace probe first
        // (e.g., extensions/cinatra-ai/<slug>-agent/cinatra/oas.json).
        let foundInside = false;
        try {
          const subEntries = await readdir(entryPath, { withFileTypes: true });
          for (const sub of subEntries) {
            if (!sub.isDirectory()) continue;
            const oasJson = join(entryPath, sub.name, "cinatra", "oas.json");
            const transitional = join(entryPath, sub.name, "cinatra", "agent.json");
            const target = existsSync(oasJson)
              ? oasJson
              : (existsSync(transitional) ? transitional : null);
            if (target) {
              try {
                await ensureAgentPackageFromGitFile({ agentJsonPath: target, licenseAcknowledged: true });
              } catch (fileErr) {
                console.warn(`[agent-builder] git agent load skipped (${entry.name}/${sub.name}):`, fileErr);
              }
              foundInside = true;
            }
          }
        } catch {
          // Non-fatal — skip unreadable subdirectories
        }
        if (foundInside) continue;

        // Fallback layout — entry/<cinatra/agent.json> or entry/agent.json.
        const cinatraAgentJson = join(entryPath, "cinatra", "agent.json");
        const firstLevelAgentJson = join(entryPath, "agent.json");
        if (existsSync(cinatraAgentJson)) {
          try {
            await ensureAgentPackageFromGitFile({ agentJsonPath: cinatraAgentJson, licenseAcknowledged: true });
          } catch (fileErr) {
            console.warn(`[agent-builder] git agent load skipped (${entry.name}/cinatra):`, fileErr);
          }
        } else if (existsSync(firstLevelAgentJson)) {
          try {
            await ensureAgentPackageFromGitFile({ agentJsonPath: firstLevelAgentJson, licenseAcknowledged: true });
          } catch (fileErr) {
            console.warn(`[agent-builder] git agent load skipped (${entry.name}):`, fileErr);
          }
        }
      }
    } catch (err) {
      // Non-fatal — agents/ directory may not exist in minimal deployments
      console.warn("[agent-builder] agents/ directory scan skipped:", err);
    }

    // Dev-mode: load SKILL-kind extension packages at boot (the agent scan
    // above only covers agent kind) AND start the recursive hot-reload
    // watcher so live edits/additions under extensions/ surface without a
    // server restart. Both are no-ops outside development.
    try {
      const { resolveAgentInstallDir } = await import("@cinatra-ai/agents/agent-install-path");
      const {
        loadAllSkillPackagesAtBoot,
        startDevExtensionsWatcher,
      } = await import("@/lib/extensions-dev-watcher");
      const extRoot = resolveAgentInstallDir();
      await loadAllSkillPackagesAtBoot(extRoot);
      startDevExtensionsWatcher(extRoot);
    } catch (err) {
      console.warn(
        "[dev-extensions] boot wiring skipped:",
        err instanceof Error ? err.message : err,
      );
    }
    })();
  }

  // Seed built-in assistant users (@cinatra) on every startup. Idempotent —
  // checks for existing rows before inserting. Running here ensures new
  // built-ins are present even on existing installs. The bootstrap helper seeds
  // only the current built-in set; existing rows outside that set are left untouched.
  try {
    const { ensureAssistantBootstrap } = await import("@/lib/auth");
    await ensureAssistantBootstrap();
  } catch (err) {
    console.warn("[assistant-bootstrap] Could not seed built-in assistants:", err instanceof Error ? err.message : err);
  }

  // Initialize OTel NodeTracerProvider so tracer.startSpan() calls
  // in agentic-execution.ts produce spans that reach PostgresSpanExporter.
  // Idempotent: re-invocation is a no-op (dev hot-reload guard in otel-bootstrap.ts).
  try {
    const { initializeOtelTracing } = await import("@/lib/otel-bootstrap");
    await initializeOtelTracing();
  } catch (err) {
    // Non-fatal — OTel bootstrap failure must not prevent the server from starting.
    console.warn("[otel-bootstrap] Failed to initialize OTel tracing:", err);
  }

  // Dev-only A2A peer auto-import. Double-gated: this outer guard
  // uses CINATRA_RUNTIME_MODE (project convention), the hook itself also
  // guards on NODE_ENV. Any failure
  // is logged and swallowed so app boot is never blocked.
  if (process.env.CINATRA_RUNTIME_MODE === "development") {
    try {
      const { ensureA2ADevPeerConnections } = await import("@/lib/a2a-dev-auto-connect");
      await ensureA2ADevPeerConnections();
    } catch (err) {
      console.warn(
        "[a2a-dev-auto-connect] skipped:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Start the metric-cost-api usage event subscriber so LLM and connector
  // usage events are persisted to PostgreSQL from the first request.
  // The subscriber's internal idempotency guard means the duplicate call
  // from registerCapabilities() (when an MCP client connects) is harmless.
  const { startUsageEventSubscriber } = await import("@cinatra-ai/metric-cost-api");
  startUsageEventSubscriber();

  // Register the table-backed Anthropic
  // skill sync map so AnthropicContainerSkillDelivery resolves
  // real refs instead of the fail-loud null stub. Idempotent; also called
  // lazily by the sync service. Inert behaviour is enforced downstream by the
  // governance gate (the map's resolve() returns null when the opt-in is OFF).
  try {
    const { ensureAnthropicSkillSyncMapRegistered } = await import(
      "@/lib/anthropic-skill-sync-service"
    );
    ensureAnthropicSkillSyncMapRegistered();
  } catch (err) {
    console.warn(
      "[instrumentation] Anthropic skill sync map registration skipped:",
      err instanceof Error ? err.message : err,
    );
  }

  // Schedule weekly LiteLLM pricing sync (one-time at startup).
  // BullMQ deduplicates by jobId, so restarts don't create duplicates.
  try {
    const {
      enqueueBackgroundJob,
      BACKGROUND_JOB_NAMES,
      LITELLM_PRICING_SYNC_LOOP_JOB_ID,
    } = await import("@/lib/background-jobs");
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.LITELLM_PRICING_SYNC,
      {},
      {
        jobId: LITELLM_PRICING_SYNC_LOOP_JOB_ID,
        delay: 7 * 24 * 60 * 60 * 1000, // 7 days
        // A retained completed/failed job under this stable id would block
        // re-seeding on the next boot — overwrite the stale entry (matches
        // the graphiti-projection-repair-loop boot-seed).
        overwriteIfStale: true,
        skipWorker: true,
        // System cron enqueue from instrumentation boot — opt out of the
        // HumanUser auto-attribution cascade so this job stays clearly
        // system-scoped. Per the canonical perpetual-loop pattern the handler
        // catches+logs cycle errors (no admin notification on caught failures);
        // only an uncaught throw (e.g. moveToDelayed re-delay failure that
        // somehow propagates) reaches `worker.on("failed")` → admins via
        // SYSTEM_JOBS.
        inheritActorContext: false,
      },
    );
    console.log("[metric-cost-api] LiteLLM weekly sync scheduled (7-day delay)");
  } catch (err) {
    // Redis unavailable or BullMQ not ready — non-fatal, sync is best-effort
    console.warn("[metric-cost-api] Could not schedule LiteLLM sync:", err);
  }

  // Seed the daily audit-log retention sweep (one-time
  // at startup; BullMQ dedups by jobId so restarts don't pile up). The worker
  // handler self-reschedules at 24h cadence after each run.
  try {
    const {
      enqueueBackgroundJob,
      BACKGROUND_JOB_NAMES,
      AUDIT_RETENTION_ENFORCE_LOOP_JOB_ID,
    } = await import("@/lib/background-jobs");
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.AUDIT_RETENTION_ENFORCE,
      {},
      {
        jobId: AUDIT_RETENTION_ENFORCE_LOOP_JOB_ID,
        delay: 24 * 60 * 60 * 1000, // 24h
        // A retained completed/failed job under this stable id would block
        // re-seeding on the next boot — overwrite the stale entry (matches
        // the graphiti-projection-repair-loop boot-seed).
        overwriteIfStale: true,
        skipWorker: true,
        inheritActorContext: false,
      },
    );
    console.log("[authz/audit] daily retention sweep scheduled (24h delay)");
  } catch (err) {
    console.warn("[authz/audit] Could not schedule audit retention sweep:", err);
  }

  // Seed the marketplace catalog sync's hourly full-sweep loop. The handler
  // self-reschedules at 1h cadence after each run via moveToDelayed (matches
  // the canonical loop pattern enforced by the BullMQ-loop-recurrence CI gate).
  // Per-promotion single-package reconciles are queued separately by the
  // admin Approve action.
  try {
    const {
      enqueueBackgroundJob,
      BACKGROUND_JOB_NAMES,
      MARKETPLACE_CATALOG_SYNC_LOOP_JOB_ID,
    } = await import("@/lib/background-jobs");
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.MARKETPLACE_CATALOG_SYNC,
      {},
      {
        jobId: MARKETPLACE_CATALOG_SYNC_LOOP_JOB_ID,
        delay: 60 * 60 * 1000, // 1h
        overwriteIfStale: true,
        skipWorker: true,
        inheritActorContext: false,
      },
    );
    console.log("[marketplace-catalog-sync] hourly full-sweep loop scheduled (1h delay)");
  } catch (err) {
    console.warn(
      "[marketplace-catalog-sync] Could not schedule full-sweep loop:",
      err instanceof Error ? err.message : err,
    );
  }

  // Seed the vendor-application state reconcile loop.
  // The handler self-reschedules at 5-min cadence after each run via
  // moveToDelayed (matches the canonical loop pattern enforced by the
  // BullMQ-loop-recurrence CI gate). The stable jobId dedups against
  // crash-restart per the BullMQ convention; on each tick the worker
  // calls `vendor_application_complete_recovery` for any local namespace-
  // reservation rows stuck in the `applied` state.
  try {
    const {
      enqueueBackgroundJob,
      BACKGROUND_JOB_NAMES,
      VENDOR_APPLICATION_STATE_RECONCILE_LOOP_JOB_ID,
    } = await import("@/lib/background-jobs");
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.VENDOR_APPLICATION_STATE_RECONCILE,
      {},
      {
        jobId: VENDOR_APPLICATION_STATE_RECONCILE_LOOP_JOB_ID,
        delay: 5 * 60 * 1000, // 5m
        overwriteIfStale: true,
        skipWorker: true,
        inheritActorContext: false,
      },
    );
    console.log(
      "[vendor-application-state-reconcile] 5-minute reconcile loop scheduled (5m delay)",
    );
  } catch (err) {
    console.warn(
      "[vendor-application-state-reconcile] Could not schedule reconcile loop:",
      err instanceof Error ? err.message : err,
    );
  }

  // Schedule the Graphiti projection repair loop. The shared
  // jobId "graphiti-projection-repair-loop" is the BullMQ-level dedup key:
  // on crash-restart, instrumentation re-enqueues the same jobId and BullMQ
  // returns the existing delayed job rather than creating a duplicate loop.
  try {
    const { enqueueBackgroundJob, BACKGROUND_JOB_NAMES, GRAPHITI_PROJECTION_REPAIR_LOOP_JOB_ID } = await import("@/lib/background-jobs");
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.GRAPHITI_PROJECTION_REPAIR,
      {},
      {
        jobId: GRAPHITI_PROJECTION_REPAIR_LOOP_JOB_ID,
        delay: 30_000,
        skipWorker: true,
        overwriteIfStale: true,
        // System loop scheduled from instrumentation boot — opt out of the
        // HumanUser auto-attribution cascade.
        inheritActorContext: false,
      },
    );
    console.log("[graphiti-projection-repair] repair loop scheduled (30s delay)");
  } catch (err) {
    console.warn("[graphiti-projection-repair] could not bootstrap:", err);
  }

  // Schedule the provider-file ref-cache
  // eviction sweep (4h period, 5min initial delay so boot traffic
  // settles first). On by default; there is no admin toggle. Stable bootstrap jobId dedups against
  // crash-restart per the BullMQ convention; the handler re-delays THIS
  // canonical job in place (moveToDelayed) each cycle, so the single loop
  // continues without spawning anonymous successors that would pile up.
  //
  // The sibling `ARTIFACT_RESOURCE_GC` scheduler remains disabled because
  // activating it can race GC against pin INSERT until pin/representation
  // writers share the resource-level advisory lock.
  try {
    const {
      enqueueBackgroundJob,
      BACKGROUND_JOB_NAMES,
      ARTIFACT_PROVIDER_CACHE_EVICT_LOOP_JOB_ID,
    } = await import("@/lib/background-jobs");
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.ARTIFACT_PROVIDER_CACHE_EVICT,
      {},
      {
        jobId: ARTIFACT_PROVIDER_CACHE_EVICT_LOOP_JOB_ID,
        delay: 5 * 60_000,
        skipWorker: true,
        overwriteIfStale: true,
        inheritActorContext: false,
      },
    );
    console.log(
      "[artifact-provider-cache-evict] loop scheduled (5m initial delay, 4h period)",
    );
  } catch (err) {
    console.warn(
      "[artifact-provider-cache-evict] could not bootstrap loop:",
      err,
    );
  }

  // Eager BullMQ worker registration.
  //
  // Both bootstrap enqueues above use `skipWorker: true`, which short-
  // circuits `ensureBackgroundJobRuntime()` and therefore never registers
  // the BullMQ `Worker`. After a `pnpm dev` restart with no user activity,
  // queued jobs from the previous process sit dormant in
  // `bull:cinatra-background-jobs:wait` indefinitely until the FIRST
  // user-triggered (non-`skipWorker`) enqueue fires.
  //
  // After a dev restart, queued jobs and agent runs can remain stuck until the
  // operator manually triggers an unrelated MCP call.
  //
  // Fix: call `ensureBackgroundJobRuntime()` AFTER the bootstrap enqueues
  // so the Worker is registered before any user request lands. Idempotent;
  // wrapped to match the existing failure-mode shape (Redis unavailable →
  // log + continue, never crash boot).
  try {
    const { ensureBackgroundJobRuntime } = await import("@/lib/background-jobs");
    await ensureBackgroundJobRuntime();
    console.log(
      "[background-jobs] worker registered eagerly at boot",
    );
  } catch (err) {
    console.warn(
      "[background-jobs] eager worker registration failed (Redis unavailable?):",
      err,
    );
  }

  // Boot the durable release-workflow reconciler runtime on its own
  // dedicated, worktree-isolated BullMQ queue. Soft-fails if Redis
  // is unavailable. App-layer wiring injects the agent_task executor + child-run poller
  // (built in the app layer so they can reach the agent-run enqueue chokepoint);
  // the notification executor is left to its package default for now.
  try {
    const { ensureWorkflowEngine, buildExecutorRegistry } = await import(
      "@cinatra-ai/workflows/engine"
    );
    const { buildWorkflowAgentTaskExecutor, getWorkflowChildRunStatus } = await import(
      "@/lib/workflow-agent-executor"
    );
    const { buildWorkflowNotifier } = await import("@/lib/workflow-notifier");
    const { updateAgentRunStatus } = await import("@cinatra-ai/agents");
    await ensureWorkflowEngine({
      executors: buildExecutorRegistry({ agent_task: buildWorkflowAgentTaskExecutor() }),
      getChildRunStatus: getWorkflowChildRunStatus,
      notify: buildWorkflowNotifier(),
      // Tear down in-flight child runs when a reject-cancel cancels the
      // workflow (best-effort; mirrors the cancelWorkflowAction teardown).
      cancelChildRun: async (childRunId: string) => {
        try {
          await updateAgentRunStatus(childRunId, "stopped", { error: "workflow_cancelled" });
        } catch {
          /* best-effort */
        }
      },
    });
    console.log("[workflows] reconciler runtime registered at boot");
  } catch (err) {
    console.warn(
      "[workflows] reconciler runtime boot failed (Redis unavailable?):",
      err,
    );
  }

  // Relocation worker boot.
  //
  // Crash-recovery sweep MUST run BEFORE startRelocationWorker(): the recovery
  // pass reads rows in 'in_progress' state (left over from a crash mid-rename),
  // reconciles them based on disk state, and either re-enqueues as 'pending'
  // or marks them 'completed'/'failed'. If the worker starts first it would
  // ignore those rows (they're not 'pending'), and we'd silently leak partial
  // renames forever.
  try {
    const { recoverPendingMoves, startRelocationWorker } = await import(
      "@cinatra-ai/skills"
    );
    await recoverPendingMoves();
    await startRelocationWorker();
    console.log("[skills-relocation] relocation worker started at boot");
  } catch (err) {
    console.warn(
      "[skills-relocation] relocation worker boot failed (DB unavailable?):",
      err,
    );
  }

  // Dev-only — auto-wire the local docker Drupal + WordPress instances so the
  // assistant can read/write them with zero manual configuration. Idempotent;
  // soft-fails (logs only, never throws). Detached so app boot isn't blocked
  // by docker exec latency or wp-cli/drush hiccups. See src/lib/dev-auto-setup.ts.
  if (process.env.CINATRA_RUNTIME_MODE === "development") {
    void (async () => {
      try {
        const { runDevAutoSetup } = await import("@/lib/dev-auto-setup");
        await runDevAutoSetup();
      } catch (err) {
        console.warn("[dev-auto-setup] boot hook failed:", err);
      }
      // After dev-auto-setup has ensured the dev org + connector wiring exists,
      // apply each extension's declared `cinatra.devFixtures` into its own
      // org-scoped surfaces so a freshly-installed extension is visible on this
      // dev boot. Soft-fail + idempotent; never blocks boot.
      try {
        const { runDevFixtureSeeder } = await import("@/lib/dev-fixture-seeder");
        await runDevFixtureSeeder();
      } catch (err) {
        console.warn("[dev-fixture-seeder] boot hook failed:", err);
      }
    })();
  }

  // Extension dependency-closure + required-in-prod boot advisories.
  //
  // Both are NON-throwing, LOG-only. A boot-time throw risks bricking on
  // pre-existing data (same reasoning that defers the prod-fail-closed throw to
  // a later prod-installer milestone), so everything is wrapped in try/catch and the whole block is
  // fire-and-forget — boot is never broken or blocked by it. Dynamically
  // imported (mirroring @/lib/extensions) so it stays out of unrelated bundles.
  // Runs AFTER the `phase-production-build` guard above, so it never runs during
  // `next build`.
  void (async () => {
    // Boot closure advisory: scan the installed-extension manifest
    // for any active|locked row whose REQUIRED dependency closure is broken (a
    // required dep is archived or missing) and log it loudly. findBrokenClosures
    // is a PURE helper; it does NOT remediate.
    try {
      const { listInstalledExtensions } = await import(
        "@cinatra-ai/extensions/canonical-store"
      );
      const { findBrokenClosures } = await import(
        "@cinatra-ai/extensions/dependency-closure"
      );
      const rows = await listInstalledExtensions({});
      const broken = findBrokenClosures(rows);
      if (broken.length > 0) {
        console.warn(
          `[extensions] BOOT CLOSURE ADVISORY: ${broken.length} installed extension(s) ` +
            `have missing/archived required dependencies: ` +
            broken
              .map((b) => `${b.packageName} → [${b.missingRequired.join(", ")}]`)
              .join("; "),
        );
      }
    } catch (err) {
      console.warn(
        "[extensions] boot closure advisory skipped (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    }

    // Dev required-in-prod advisory: ONLY in development, verify the
    // required-in-prod packages are installed/locked AND that pinned entries'
    // installed versions satisfy their declared ranges. If any are not, log a
    // warning noting that production would fail closed (the prod throw is
    // deferred to the prod installer — NOT wired here).
    if (process.env.CINATRA_RUNTIME_MODE === "development") {
      try {
        const { verifyRequiredInProdInstalled } = await import(
          "@cinatra-ai/extensions/required-in-prod"
        );
        const result = await verifyRequiredInProdInstalled();
        if (!result.ok) {
          console.warn(
            `[extensions] DEV ADVISORY: required-in-prod contract not satisfied — ` +
              `${result.reason} (in production this would fail closed — ` +
              `deferred to the prod installer)`,
          );
        }
      } catch (err) {
        console.warn(
          "[extensions] dev required-in-prod advisory skipped (non-fatal):",
          err instanceof Error ? err.message : err,
        );
      }
    }
  })();

}
