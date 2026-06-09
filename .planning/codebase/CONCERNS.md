# Codebase Concerns

**Analysis Date:** 2026-06-09

## Tech Debt

**Deployment Registry Using Fixture Instead of Live Resolver:**
- Issue: `resolveDeploymentRegistryConfig()` reads from an in-repo fixture file rather than calling the live deployment-registry service.
- Files: `src/lib/deployment-registry-config.ts`, `src/lib/__fixtures__/deployment-registry-config.fixture.ts`
- Impact: Deployment registry config is static; live multi-tenant config changes have no effect at runtime.
- Fix approach: Replace fixture import path (marked `TODO(live integration)`) with the live resolver call once the deployment-registry service is accessible.

**Hardcoded Readiness Check in Database Layer:**
- Issue: A readiness check in `src/lib/database.ts:1135` returns hardcoded `false` instead of performing the actual admin readiness check.
- Files: `src/lib/database.ts`
- Impact: Any feature gated on this readiness check will behave as if it is never ready.
- Fix approach: Implement the real readiness check (see comment: admin check).

**LLM Pricing Table Has Unverified Low-Confidence Values:**
- Issue: All pricing values in the metric-cost-api are marked `LOW confidence` — developer noted they require manual verification against provider pricing pages before production.
- Files: `packages/metric-cost-api/src/pricing/index.ts`, `src/lib/drizzle-store.ts:974`
- Impact: Cost tracking and billing calculations will be inaccurate, potentially under- or over-charging.
- Fix approach: Audit all values in `LLM_PRICING` and `APOLLO_PRICING` against current OpenAI, Anthropic, Gemini, and Apollo pricing pages and update accordingly.

**Notification Test Suites Permanently Skipped (Host-Adapter Mock Migration Pending):**
- Issue: Three `describe.skip(...)` blocks in `src/lib/notifications/__tests__/agent-creation-progress.test.ts` are skipped pending migration of `vi.mock(@/lib/database)` to `setNotificationsHostAdapters` after package extraction.
- Files: `src/lib/notifications/__tests__/agent-creation-progress.test.ts`
- Impact: Notification emission behavior for agent creation is untested.
- Fix approach: Migrate mock to host-adapter injection pattern and re-enable all three describe blocks.

**Publish Vendor Guard Test Suite Skipped:**
- Issue: `describe.skip("publishToRegistry vendor guard", ...)` in `packages/agents/src/__tests__/publish-vendor-guard.test.ts` is permanently disabled without a follow-up ticket.
- Files: `packages/agents/src/__tests__/publish-vendor-guard.test.ts`
- Impact: Extension publish vendor-guard logic is untested.
- Fix approach: Investigate why it was skipped and re-enable or delete.

**MCP Actor Context Plumbing Incomplete:**
- Issue: `packages/chat/src/mcp/actor-context.ts:25` has a `TODO(mcp-actor-plumbing)` note that the MCP SDK registry passes an incomplete actor context — full actor plumbing is deferred.
- Files: `packages/chat/src/mcp/actor-context.ts`
- Impact: MCP tool calls may not carry correct actor attribution for audit/authz.
- Fix approach: Plumb full actor context through the MCP SDK registry when actor identity flow is wired.

**Campaign DB Ownership Not Wired:**
- Issue: `src/lib/database.ts:573` notes that `campaign-types / drafts / overrides` are still owned by `@cinatra/campaigns` (TODO) — the package boundary is not enforced.
- Files: `src/lib/database.ts`
- Impact: Database access to campaign data bypasses package ownership boundaries, making future extraction harder.
- Fix approach: Move campaign table access into `@cinatra/campaigns` package.

**`FieldRendererProps.hideSubmit` Type Is Missing (Cast Workaround in Tests):**
- Issue: `packages/agents/src/__tests__/schema-field-renderer-hide-submit.test.tsx` uses `as any` casts because `FieldRendererProps.hideSubmit` does not exist in the type definition yet.
- Files: `packages/agents/src/__tests__/schema-field-renderer-hide-submit.test.tsx`
- Impact: Type safety gap; if implementation ever diverges from test assumptions, no compiler error fires.
- Fix approach: Add `hideSubmit` to `FieldRendererProps` and remove `as any` casts.

## Known Bugs

**`currentValue` Keys Injected Verbatim Into LLM Prompt (HITL Assist Route):**
- Symptoms: Upstream issue where `currentValue` object keys from form state are injected verbatim into an LLM prompt without sanitization.
- Files: `src/app/api/agents/builder/[templateId]/hitl-assist/route.ts:76`
- Trigger: Any HITL-assist call where `currentValue` contains attacker-controlled field names.
- Workaround: None noted; mitigate by validating/allowlisting keys before prompt injection.

**A2A Dev Auto-Connect Name Regression:**
- Symptoms: Agents registered via `a2a-dev-auto-connect` may produce an `"a2a-dev-localhost-XXXX"` name regression visible in `/agents/run`.
- Files: `src/lib/a2a-dev-auto-connect.ts:298`
- Trigger: Local dev sessions with auto-connect enabled.
- Workaround: Not documented.

## Security Considerations

**Sync Adapter Config Stores Third-Party Credentials Without Encryption-at-Rest:**
- Risk: `object_sync_adapter_configs.config` column holds third-party API credentials in plaintext. The TODO explicitly flags that encryption-at-rest is required before any credential-bearing sync adapter ships.
- Files: `packages/objects/src/sync-adapters/adapter.ts:12`
- Current mitigation: Column not yet in active use by shipped sync adapters.
- Recommendations: Implement encryption-at-rest (e.g., envelope encryption via KMS) for the `config` column before enabling any credential-bearing sync adapter in production.

**LLM Bridge Not Hardened for Un-Vetted Extension Agents:**
- Risk: `src/app/api/llm-bridge/route.ts:770` has a `TODO(hardening)` noting that production use with un-vetted extension agents requires additional sandboxing/guardrails not yet implemented.
- Files: `src/app/api/llm-bridge/route.ts`
- Current mitigation: Only vetted extension agents in current deployments.
- Recommendations: Implement tool-call allowlisting, output filtering, or agent trust classification before allowing un-vetted agents access to the LLM bridge.

**MCP Registry Uses No OAuth Client Credentials for Assistant Identity:**
- Risk: `packages/chat/src/mcp/registry.ts:103` notes that proper OAuth `client_credentials` authentication for multi-assistant MCP calls is not yet implemented — assistants self-assert identity via `assistantClientId` parameter.
- Files: `packages/chat/src/mcp/registry.ts`
- Current mitigation: Caller must be authenticated; `assistantClientId` is passive attribution only.
- Recommendations: Issue and verify OAuth `client_credentials` tokens per assistant before expanding multi-assistant MCP deployments.

**`dangerouslySetInnerHTML` Used Without Explicit Sanitization in Multiple Render Paths:**
- Risk: Multiple components use `dangerouslySetInnerHTML` with rendered markdown/SVG content.
- Files:
  - `src/app/artifacts/[id]/handlers/markdown-handler.tsx:86`
  - `packages/chat/src/mermaid-block.tsx:99`
  - `packages/chat/src/chat-page.tsx:691`, `3335`, `3552`
  - `packages/agents/src/screens.tsx:846`
- Current mitigation: `packages/dashboards/src/components/cinatra-linked-table.tsx` has a comment explicitly noting this is an XSS path and avoids it. Other paths rely on the markdown renderer to be safe.
- Recommendations: Audit all `dangerouslySetInnerHTML` sites to confirm output is passed through a sanitization step (e.g., DOMPurify) before rendering.

**ToS Fetch for Marketplace Apply-Form Uses Hardcoded Canonical Text:**
- Risk: `src/app/configuration/environment/page.tsx:329` uses hardcoded ToS content with a `TODO(marketplace-terms-fetch)` to swap to a live fetch — ToS changes do not propagate automatically.
- Files: `src/app/configuration/environment/page.tsx`
- Current mitigation: Static content; acceptable until marketplace terms need updating.
- Recommendations: Implement the live ToS fetch before marketplace goes live.

## Performance Bottlenecks

**N+1 DB Queries in Agent.json Well-Known Route:**
- Problem: `src/app/.well-known/agent.json/route.ts:67` issues one DB query per published template via `Promise.all` — O(N) queries for N templates.
- Files: `src/app/.well-known/agent.json/route.ts`
- Cause: No batch/join query for template-level metadata.
- Improvement path: Rewrite to a single query joining all published template rows.

**Several Files Exceed 4,000 Lines (Complexity Risk):**
- Problem: Files with 2,000–4,900 lines are difficult to navigate, test in isolation, and reason about.
- Files:
  - `packages/agents/src/mcp/handlers.ts` (4,914 lines)
  - `packages/agents/src/store.ts` (4,466 lines)
  - `src/lib/drizzle-store.ts` (4,330 lines)
  - `packages/chat/src/chat-page.tsx` (3,745 lines)
  - `packages/skills/src/skills-store.ts` (2,495 lines)
- Cause: Organic growth without module decomposition.
- Improvement path: Extract cohesive sub-modules; each store/handler split along domain entity lines.

## Fragile Areas

**`src/instrumentation.node.ts` — Boot Sequencing and Crash Swallowing:**
- Files: `src/instrumentation.node.ts`
- Why fragile: Registers `uncaughtException` and `unhandledRejection` handlers that log but explicitly do NOT exit the process. Background job scheduling (marketplace sync, LiteLLM sync, authz audit sweep, graphiti repair) is interleaved in the same file across 800+ lines. A boot ordering mistake or thrown error can leave the server in a partially-initialized state with no crash signal.
- Safe modification: Only add new scheduled jobs at the end of the boot sequence; always check `NEXT_PHASE === "phase-production-build"` guard before scheduling. Test boot isolation by mocking `process.env.CINATRA_RUNTIME_MODE`.
- Test coverage: Boot sequencing is not independently unit-tested; integration tests require a live server.

**`src/app/api/llm-bridge/_llm-dispatch.ts` — Infinite Loop with `eslint-disable no-constant-condition`:**
- Files: `src/app/api/llm-bridge/_llm-dispatch.ts:202`
- Why fragile: A `while (true)` loop with a manually suppressed lint warning. Any missing `break`/`return` in an added code path will cause an infinite request loop.
- Safe modification: Always verify break paths are exhaustive; add integration tests for retry-exhaustion and error branch coverage.
- Test coverage: Retry behavior has partial coverage but the loop termination contract is not explicitly tested.

**`src/lib/background-jobs.ts` (1,705 lines) — Interleaved Scheduling Logic:**
- Files: `src/lib/background-jobs.ts`
- Why fragile: Background job definitions, scheduling, and execution logic coexist in a single large file. Adding or changing job timing can have unexpected cross-job interactions.
- Safe modification: Keep job definitions isolated; do not inline new scheduling logic without a corresponding test for idempotency.
- Test coverage: Individual job logic tested; overall scheduling orchestration is not.

## Scaling Limits

**Notification Stream Using Server-Sent Events with Polling Heartbeat:**
- Current capacity: One SSE connection per browser tab; heartbeat via `setInterval` at `src/app/api/notifications/stream/route.ts`.
- Limit: At high user counts, concurrent SSE connections exhaust server file descriptors and memory.
- Scaling path: Move to a pub/sub broker (Redis Streams / Supabase Realtime) with fan-out at the edge rather than per-process SSE loops.

**Agent Run Stream Using `setInterval` Keepalive:**
- Current capacity: One streaming connection per active agent run per user.
- Limit: Many concurrent runs will create many open connections and keepalive intervals.
- Scaling path: Use edge streaming infrastructure (Vercel streaming or a stateless SSE proxy) to reduce per-process connection state.

## Dependencies at Risk

**`@a2a-js/sdk` — Patched (Local Patch Applied):**
- Risk: `patches/@a2a-js__sdk@0.3.13.patch` indicates the vendored SDK version required a local patch; upstream may not have accepted the fix.
- Impact: SDK upgrades must re-apply or re-validate the patch; silent regressions possible on version bump.
- Migration plan: Track upstream issue; submit patch upstream; remove local patch once merged.

## Missing Critical Features

**Encryption-at-Rest for Sync Adapter Credentials:**
- Problem: Third-party API credentials stored in `object_sync_adapter_configs.config` are not encrypted.
- Blocks: Any production-grade sync adapter that stores OAuth tokens or API keys.

**Live Deployment Registry Resolver:**
- Problem: Deployment registry resolution is fixture-backed, not live.
- Blocks: Multi-tenant deployment config changes at runtime.

**OAuth `client_credentials` for Multi-Assistant MCP Identity:**
- Problem: Assistants self-assert identity via a parameter rather than a verified credential.
- Blocks: Secure multi-assistant MCP deployments with proper attribution and access control.

## Test Coverage Gaps

**Notification Emission for Agent Creation (Three Skipped Suites):**
- What's not tested: `emitAgentCreationProgress`, `safeEmitAgentCreationProgress`, and standing invariants for those functions.
- Files: `src/lib/notifications/__tests__/agent-creation-progress.test.ts`
- Risk: Regressions in notification delivery during agent creation go undetected.
- Priority: High

**Extension Publish Vendor Guard:**
- What's not tested: The full vendor-guard logic path in `publishToRegistry`.
- Files: `packages/agents/src/__tests__/publish-vendor-guard.test.ts`
- Risk: Unauthorized vendor extensions could be published if guard logic regresses.
- Priority: High

**Boot Sequencing in `src/instrumentation.node.ts`:**
- What's not tested: The interleaved background job scheduling and boot ordering. DB-gated tests skip unless `SUPABASE_DB_URL` is set.
- Files: `src/instrumentation.node.ts`
- Risk: A boot ordering bug leaves the server silently misconfigured with no failing test.
- Priority: Medium

**Large Store/Handler Modules Lack Sub-Unit Tests:**
- What's not tested: Internal sub-operations within `packages/agents/src/store.ts` (4,466 lines), `src/lib/drizzle-store.ts` (4,330 lines), and `packages/agents/src/mcp/handlers.ts` (4,914 lines) are tested largely through integration-level tests requiring a live DB (`skipIf(!hasDb)`).
- Files: `packages/agents/src/store.ts`, `src/lib/drizzle-store.ts`, `packages/agents/src/mcp/handlers.ts`
- Risk: Unit-level regressions are only caught when a full DB environment is available.
- Priority: Medium

**LLM Dispatch Retry/Loop Termination:**
- What's not tested: All break/return paths out of the `while (true)` loop in `src/app/api/llm-bridge/_llm-dispatch.ts`.
- Files: `src/app/api/llm-bridge/_llm-dispatch.ts`
- Risk: A code change that adds a branch bypassing the loop termination condition causes an infinite loop in production with no test failure.
- Priority: Medium

---

*Concerns audit: 2026-06-09*
