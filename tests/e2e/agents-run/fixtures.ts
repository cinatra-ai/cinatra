/**
 * Locked `/agents/run` inventory + per-agent fixture data for the
 * end-to-end harness.
 *
 * The 16-agent visible set is locked from the canonical `cinatra`
 * schema on 2026-05-13 — it mirrors `selectHitlRunVisibleTemplates`
 * behavior. If the live filter ever diverges, the `preflight.spec.ts`
 * test will catch the drift on the very first run and tell the operator
 * exactly which package(s) changed.
 *
 * Classification:
 *  - LIVE-RUNNABLE       (10): no external API key, no real outbound calls
 *  - LIVE-WITH-OVERRIDE  (3):  exercises Gmail with the dev recipient
 *                             override at packages/connector-gmail/src/index.ts:312
 *  - DEFER-EXTERNAL      (3):  cannot complete without real LinkedIn/
 *                             WordPress/recipient fixture data
 *
 * The fixture set starts with the simplest LIVE-RUNNABLE samples that
 * have exactly one custom-renderer HITL screen each — enough to prove
 * the harness contract — and expands as more renderers are covered.
 */
import {
  seedApprovedDraftBundle,
  seedCampaignContext,
  seedConfirmedRecipients,
  seedContactList,
  seedDraftBundle,
  seedFollowupBundle,
  SEED_IDS,
} from "./seed";

/**
 * Helper closures the prereq-seeded fixtures invoke inside their seedFn.
 * Kept here (rather than inline) so the static import of seed.ts lives at
 * module top — Playwright's CJS transform rejects dynamic `import()` of
 * TS modules in this project.
 */
async function seedCampaignContextFromFixture(): Promise<void> {
  await seedCampaignContext(SEED_IDS.campaignContextA);
}

async function seedContactListFromFixture(): Promise<void> {
  await seedContactList(SEED_IDS.contactListA);
}

async function seedDraftBundleFromFixture(): Promise<void> {
  await seedDraftBundle(SEED_IDS.draftBundleA);
}

async function seedFollowupBundleFromFixture(): Promise<void> {
  await seedFollowupBundle(SEED_IDS.followupBundleA);
}

async function seedApprovedDraftBundleFromFixture(): Promise<void> {
  await seedApprovedDraftBundle(SEED_IDS.approvedDraftBundleA);
}

async function seedConfirmedRecipientsFromFixture(): Promise<void> {
  await seedConfirmedRecipients(SEED_IDS.confirmedRecipientsA);
}

export type AgentClassification =
  | "LIVE-RUNNABLE"
  | "LIVE-WITH-OVERRIDE"
  | "DEFER-EXTERNAL";

/** Locked from `cinatra.agent_templates` 2026-05-13. */
export const CANONICAL_VISIBLE_PACKAGES: ReadonlyArray<{
  packageName: string;
  classification: AgentClassification;
}> = [
  // Direct HITL (14)
  { packageName: "@cinatra-ai/auditor-agent", classification: "LIVE-RUNNABLE" },
  { packageName: "@cinatra-ai/blog-linkedin-publish-agent", classification: "DEFER-EXTERNAL" },
  { packageName: "@cinatra-ai/blog-wordpress-publish-agent", classification: "DEFER-EXTERNAL" },
  { packageName: "@cinatra-ai/email-delivery-agent", classification: "LIVE-WITH-OVERRIDE" },
  { packageName: "@cinatra-ai/email-drafting-agent", classification: "LIVE-RUNNABLE" },
  { packageName: "@cinatra-ai/email-follow-up-agent", classification: "LIVE-RUNNABLE" },
  { packageName: "@cinatra-ai/email-outreach-agent", classification: "LIVE-WITH-OVERRIDE" },
  { packageName: "@cinatra-ai/email-recipient-selection-agent", classification: "LIVE-RUNNABLE" },
  { packageName: "@cinatra-ai/email-test-delivery-agent", classification: "LIVE-WITH-OVERRIDE" },
  { packageName: "@cinatra-ai/list-curator-agent", classification: "DEFER-EXTERNAL" },
  { packageName: "@cinatra-ai/skill-recommender-agent", classification: "LIVE-RUNNABLE" },
  { packageName: "@cinatra-ai/trigger-agent", classification: "LIVE-RUNNABLE" },
  // Sub-agent descendants (1)
  { packageName: "@cinatra-ai/reviewer-agent", classification: "LIVE-RUNNABLE" },
];

/** Discriminated HITL screen specification. */
export type HitlScreenSpec =
  | {
      kind: "custom-renderer";
      /** x-renderer attribute carried in `inputMessageSchema["x-renderer"]`. */
      xRenderer: string;
      /** Accessible-name / heading text expected to appear on the panel. */
      expectedTitle?: string;
      /** Renderer-specific action payload. The HITL helper narrows per
       *  `xRenderer` before driving the UI. Free-form here keeps the
       *  fixture file compact as more renderers are onboarded. */
      action: Record<string, unknown>;
      /** Primary advancement button text (default: "Continue"). */
      primaryButtonText?: string;
    }
  | {
      kind: "generic-form";
      expectedTitle?: string;
      inputs: Record<string, string>;
      primaryButtonText?: string;
    };

/** Contract for object-persistence assertions. After the run reaches its
 *  expected terminal status, the spec queries `cinatra.objects` via direct pg
 *  for rows with `run_id = $1 AND object_type = $2` and asserts at least one
 *  match per declared expected output. Used by live targets that save objects
 *  (e.g. email-recipient-selection-agent, reviewer-agent). */
export type ExpectedOutput = {
  objectType: string;
  /** Optional row matcher: returns true if the object's `data` payload
   *  satisfies the assertion. Use this to assert specific content beyond
   *  "at least one object of this type was persisted." */
  matcher?: (obj: { id: string; objectType: string; data: unknown }) => boolean;
};

export type AgentFixture = {
  packageName: string;
  vendor: string;
  slug: string;
  classification: AgentClassification;
  /** StartNode inputs (the `/agents/<vendor>/<slug>/new` form). Hidden
   *  defaults like `cinatra_run_id` are NOT included — those are filled
   *  by the orchestrator at run-start. */
  startInputs: Record<string, string | number | boolean>;
  hitlScreens: ReadonlyArray<HitlScreenSpec>;
  expectedTerminalStatus: "completed" | "failed";
  /** Per-agent override; default 180_000ms. */
  runTimeoutMs?: number;
  /** Agents whose ApiNodes call `cinatra_llm` via `/api/llm-bridge`
   *  depend on a publicly reachable MCP base URL. Without one, these fail
   *  at the LLM-bridge step with `424 Failed Dependency`. The preflight
   *  detects the configured URL; the spec skips these fixtures with a
   *  `DEFERRED-PENDING-TUNNEL` reason if
   *  `connector_config:mcp_server.publicBaseUrl` is unset (no manual URL
   *  saved at `/configuration/development?tab=tunnel`). */
  tunnelDependent?: boolean;
  /** Skip the fixture at runtime with a documented reason. Use when the agent
   *  ITSELF runs fine (sub-agents pass standalone) but the Playwright harness's
   *  driver hits an unrelated UI/renderer issue that's out of scope to fix
   *  inline. The skip reason surfaces in Playwright's output so the agent is
   *  visibly tagged as needing follow-up rather than appearing green. */
  harnessDeferred?: string;
  /** Object-persistence assertions to apply after terminal status.
   *  Empty/undefined means the agent doesn't persist objects (e.g.
   *  skill-recommender-agent — pure HITL confirmation, no `objects_save`
   *  calls). */
  expectedOutputs?: ReadonlyArray<ExpectedOutput>;
  /**
   * Optional pre-run seed step for fixtures whose StartNode has
   * `cinatra.required + cinatra.hidden` fields (campaignId, draftBundleRef,
   * etc.). The runner ignores `/agents/<v>/<s>/new` when `seedFn` is set
   * and instead calls `seedAgentRun(packageName, seeded)` — direct DB insert
   * + BullMQ enqueue — because the empty-`/new` redirect can't surface
   * hidden+required fields as HITL gates (execution.ts:826 `x-hidden` guard
   * skips them).
   *
   * Return shape is the `inputParams` map the run should be created with.
   * Seed any prerequisite `cinatra.objects` rows inside the same `seedFn`
   * (see `seedCampaignContext` in `tests/e2e/agents-run/seed.ts`).
   */
  seedFn?: () => Promise<Record<string, unknown>>;
};

/**
 * Sample fixtures. Confirmed against OAS source 2026-05-13.
 */
export const AGENT_FIXTURES: ReadonlyArray<AgentFixture> = [
  {
    packageName: "@cinatra-ai/skill-recommender-agent",
    vendor: "cinatra-ai",
    slug: "skill-recommender-agent",
    classification: "LIVE-RUNNABLE",
    startInputs: {},
    hitlScreens: [
      {
        kind: "custom-renderer",
        xRenderer: "@cinatra-ai/skill-recommender-agent:recommend",
        expectedTitle: "Review skills",
        action: { confirmed: true },
        primaryButtonText: "Continue",
      },
    ],
    expectedTerminalStatus: "completed",
    // The prior 60_000 budget was too tight vs startAgentRun's documented
    // 120_000 Turbopack cold-compile waitForURL budget (the test aborted
    // before waitForURL's own deadline). Aligned to the LIVE-agent norm
    // so cold-start + real LLM + 1 HITL fits. Not masking a regression:
    // the run dispatches; this was a fixture-budget bug surfaced by cold
    // .next startup.
    runTimeoutMs: 300_000,
  },
  {
    packageName: "@cinatra-ai/trigger-agent",
    vendor: "cinatra-ai",
    slug: "trigger-agent",
    classification: "LIVE-RUNNABLE",
    // The persist ApiNode calls /api/llm-bridge → cinatra_llm, which
    // requires a publicly reachable MCP base URL. Without one, the run
    // fails with `424 Failed Dependency: Error retrieving tool list from
    // MCP server: 'cinatra'`. Preflight detects state; spec skips if unset.
    tunnelDependent: true,
    startInputs: {},
    hitlScreens: [
      {
        kind: "custom-renderer",
        xRenderer: "@cinatra-ai/trigger-agent:configure",
        expectedTitle: "Configure trigger",
        // Minimal valid payload — triggerType immediate + UTC timezone
        // satisfies the formSchema required[] without needing a future
        // ISO instant or a 5-field cron string. The persist ApiNode
        // LLM-bridge call will write a real trigger config row; cost
        // estimate < $0.05.
        action: { triggerType: "immediate", timezone: "UTC" },
        primaryButtonText: "Continue",
      },
    ],
    expectedTerminalStatus: "completed",
    // LLM-bridge persist node can be slow on cold start; allow 240s to
    // absorb tail latency without flaking. Real OpenAI calls vary 5-60s.
    runTimeoutMs: 240_000,
  },
  // ---------------------------------------------------------------------
  // email-recipient-selection-agent: prereq-seeded fixture. Uses `seedFn`
  // because campaignId is required+hidden in the StartNode metadata
  // (execution.ts:826 skips x-hidden in the setup-loop), so the empty-/new
  // redirect can't supply it as a HITL gate. seedFn also seeds a
  // `@cinatra-ai/lists:list` row so the list-picker gate has a list.
  // ---------------------------------------------------------------------
  {
    packageName: "@cinatra-ai/email-recipient-selection-agent",
    vendor: "cinatra-ai",
    slug: "email-recipient-selection-agent",
    classification: "LIVE-RUNNABLE",
    startInputs: {},
    seedFn: async () => {
      // seedCampaignContext + seedContactList are static-imported at module
      // top (Playwright's CJS transform rejects dynamic import() of TS
      // modules). accountScope intentionally omitted from the return — the
      // agent's list-picker gate sets the scope from the picked list.
      await seedCampaignContextFromFixture();
      await seedContactListFromFixture();
      return {
        campaignId: SEED_IDS.campaignContextA,
      };
    },
    hitlScreens: [
      {
        // Gate 1: pick the seeded recipient list.
        kind: "custom-renderer",
        xRenderer: "@cinatra-ai/email-outreach-agent:list-picker",
        action: { listName: "UAT Recipients — Example" },
      },
      {
        // Gate 2: reviewer-output gate over the LLM-selected recipients.
        kind: "custom-renderer",
        xRenderer: "@cinatra-ai/reviewer-agent:output",
        action: { userResponse: "Approved." },
      },
    ],
    expectedTerminalStatus: "completed",
    // Tunnel-dependent: the agent's ApiNodes call cinatra_llm via the bridge.
    tunnelDependent: true,
    runTimeoutMs: 300_000,
  },
  // ---------------------------------------------------------------------
  // email-drafting-agent: chained-after-recipient fixture. Single HITL gate:
  // `@cinatra-ai/reviewer-agent:drafts-output` over the LLM-generated drafts.
  // The agent's StartNode declares two hidden+required inputs:
  //   - campaignId      → reuses SEED_IDS.campaignContextA seeded above
  //   - confirmedRecipients → static array; the agent's skill iterates
  //     it directly (no MCP fetch). One synthetic recipient is enough
  //     to drive a single draft generation through the LLM.
  // ---------------------------------------------------------------------
  {
    packageName: "@cinatra-ai/email-drafting-agent",
    vendor: "cinatra-ai",
    slug: "email-drafting-agent",
    classification: "LIVE-RUNNABLE",
    startInputs: {},
    seedFn: async () => {
      await seedCampaignContextFromFixture();
      return {
        campaignId: SEED_IDS.campaignContextA,
        confirmedRecipients: [
          {
            name: "Pat Casey",
            title: "VP Engineering",
            accountName: "Example Co",
            email: "pat@example.com",
            painPoint: "manual outreach is eating their week",
          },
        ],
      };
    },
    hitlScreens: [
      {
        // Gate: review LLM-generated drafts. The EmailDraftsReviewRenderer
        // auto-seeds userResponse on mount; the helper falls back to
        // clicking outer-panel Continue when no #field-hitl-field input
        // is present (display-only path).
        kind: "custom-renderer",
        xRenderer: "@cinatra-ai/reviewer-agent:drafts-output",
        action: { userResponse: "Approved." },
      },
    ],
    expectedTerminalStatus: "completed",
    tunnelDependent: true,
    // Single subflow w/ a single LLM-bridge call — generous margin for
    // dev-server JIT priming on cold start.
    runTimeoutMs: 360_000,
  },
  // ---------------------------------------------------------------------
  // email-follow-up-agent: standalone-runnable. The StartNode declares:
  //   - campaignId (hidden+required) — reuses SEED_IDS.campaignContextA
  //   - followUpDays (array, custom renderer `:follow-up-cadence` —
  //     pre-fill via seeded inputParams to bypass the setup-loop)
  //   - agent_run_id (hidden, auto)
  // ---------------------------------------------------------------------
  {
    packageName: "@cinatra-ai/email-follow-up-agent",
    vendor: "cinatra-ai",
    slug: "email-follow-up-agent",
    classification: "LIVE-RUNNABLE",
    startInputs: {},
    seedFn: async () => {
      await seedCampaignContextFromFixture();
      return {
        campaignId: SEED_IDS.campaignContextA,
        // Pre-fill the follow-up cadence so the setup-loop has nothing
        // to surface — 3/7/14 days is the canonical default the cadence
        // renderer would render. If a future fixture wants to test the
        // cadence renderer, drop this entry and add the renderer drive
        // helper.
        followUpDays: [3, 7, 14],
      };
    },
    hitlScreens: [
      {
        // Mid-run gate: review LLM-generated follow-up sequence.
        kind: "custom-renderer",
        xRenderer: "@cinatra-ai/reviewer-agent:followups-output",
        action: { userResponse: "Approved." },
      },
    ],
    expectedTerminalStatus: "completed",
    tunnelDependent: true,
    runTimeoutMs: 360_000,
  },
  // ---------------------------------------------------------------------
  // email-test-delivery-agent (LIVE-WITH-OVERRIDE). Re-entrant HITL surface
  // to send a test preview before launching a campaign. StartNode declares:
  //   - campaignId (string, required+hidden) — seeded
  // The test fixture does NOT actually send a test email — it clicks the
  // renderer's "Continue" button to exit the gate (the renderer emits
  // testResult with userResponse="continue", lastSendResult=null).
  // If a future fixture wants to verify the actual Gmail send path,
  // exercise the dev recipient override at
  // packages/connector-gmail/src/index.ts:312.
  // ---------------------------------------------------------------------
  {
    packageName: "@cinatra-ai/email-test-delivery-agent",
    vendor: "cinatra-ai",
    slug: "email-test-delivery-agent",
    classification: "LIVE-WITH-OVERRIDE",
    startInputs: {},
    seedFn: async () => {
      await seedCampaignContextFromFixture();
      return {
        campaignId: SEED_IDS.campaignContextA,
      };
    },
    hitlScreens: [
      {
        kind: "custom-renderer",
        xRenderer: "@cinatra-ai/email-test-delivery-agent:input",
        action: {},
      },
    ],
    expectedTerminalStatus: "completed",
    runTimeoutMs: 300_000,
  },
  // ---------------------------------------------------------------------
  // email-delivery-agent (LIVE-WITH-OVERRIDE). Inputs are pre-filled via
  // seedFn; the agent's LLM calls email_outreach_send_initial_start, a real
  // synchronous send loop:
  //   1. objects_get(approvedDraftBundleRef) → drafts[]
  //   2. objects_get(confirmedRecipientsRef) → recipients[]
  //   3. For each draft, sendGmailMessage → real Gmail API call
  //   4. Dev recipient override (developmentModeEnabled=true) routes
  //      ALL outbound email to the configured override inbox.
  //   5. State recorded in process memory for the subsequent _status
  //      polls within the same dev-server lifetime.
  //
  // Verify: a real email lands in the override inbox after each run.
  // ---------------------------------------------------------------------
  {
    packageName: "@cinatra-ai/email-delivery-agent",
    vendor: "cinatra-ai",
    slug: "email-delivery-agent",
    classification: "LIVE-WITH-OVERRIDE",
    startInputs: {},
    seedFn: async () => {
      await seedCampaignContextFromFixture();
      await seedApprovedDraftBundleFromFixture();
      await seedConfirmedRecipientsFromFixture();
      return {
        campaignId: SEED_IDS.campaignContextA,
        approvedDraftBundleRef: SEED_IDS.approvedDraftBundleA,
        confirmedRecipientsRef: SEED_IDS.confirmedRecipientsA,
        senderEmail: "sender@example.com",
      };
    },
    hitlScreens: [],
    expectedTerminalStatus: "completed",
    runTimeoutMs: 180_000,
  },
  // NOTE — email-outreach-agent (orchestrator): attempted 2026-05-15 with
  // A2A dispatch, shell-tool gate handling, and REST interrupt snapshot
  // handling in place. Drives gates 1-2 (Campaign setup, Account scope)
  // successfully end-to-end. Gate 3 ("Review recipients") fails with a
  // WayFlow output-binding error:
  //   Field confirmedRecipientsRef of current step Recipients is
  //   required but has no default value
  //
  // The recipients_flow subflow's `recipients-generate` LLM step is
  // expected to call `objects_save` with `typeHint: '@cinatra-ai/dynamic:
  // email-recipients-bundle'` and return the saved objectId as
  // `confirmedRecipientsRef`, but the LLM step is not producing that
  // output. This is an OAS-level DFE/output-binding bug in the
  // orchestrator's recipients subflow. Filing as
  // DEFER-ORCHESTRATOR-RECIPIENTS-DFE.
  //
  // ---------------------------------------------------------------------
  // list-curator-agent. It requires real LinkedIn scraping, but OAuth and
  // auth connections are already in place. Only required input is `intent`;
  // seedUrls/targetMemberType/listName have defaults; the agent runs an
  // LLM-driven curation flow.
  // ---------------------------------------------------------------------
  // NOTE — list-curator-agent: attempted in an earlier dev session. The run
  // completes (status: 'completed', no error) but the LLM-driven `curate`
  // step is BYPASSING its declared HITL gates (scrape-schema-review +
  // final-list-review per the SKILL.md) AND not calling the CRM list
  // creation step at the end. Verified via DB query: zero matching CRM list
  // rows after a 'completed' run. The agent's ApiNode prompt explicitly
  // says "pause at HITL Gate 1 ... HITL Gate 2 ... then call crm_list_create"
  // but the LLM is short-circuiting. This is an agent-flow correctness bug —
  // the harness side is correct (renderer helpers wired in
  // hitl-actions.ts:advanceListCuratorApprove + driveCustomRenderer dispatch
  // are kept for future sub-flow fixtures). Filed as
  // DEFER-LIST-CURATOR-LLM-FLOW.
  //
  // NOTE — blog-linkedin-publish-agent: LinkedIn connector has
  // `accounts: []` in connector_config:linkedin (no connected account).
  // The agent's StartNode requires linkedinAccountId / destinationId /
  // destinationName which would come from a connected LinkedIn account.
  // To enable: connect a real LinkedIn account at /configuration and
  // re-derive a fixture. Filing as DEFER-LINKEDIN-ACCOUNT-NEEDED.
  //
  // NOTE — blog-wordpress-publish-agent: a WordPress test instance IS
  // configured (Cinatra TEST at localhost:8080,
  // wordpressInstanceId=8d44907a-391d-44f4-93ee-2ef989f4f721). The
  // agent's StartNode needs projectId+postId, which require a seeded
  // blog project with at least one post that has a wordpressDrafts[]
  // entry referencing the test instance. That seeding is multi-step
  // (project + post + draft generation) and intersects with the
  // separate blog-* agent chain. Filed for a focused follow-up phase.
  //
  // NOTE — auditor-agent (standalone): the earlier
  // DEFER-STANDALONE-INVESTIGATION ("run_skills needs real skill IDs;
  // empty skillIds invalid") was misdiagnosed. Empty skillIds:[] is fine
  // (it falls back to parent-package skill resolution and builds no skill
  // tools when empty). The real cause was missing start→node DFE wiring +
  // a dispatcher name mismatch (start declared `agent_run_id`, dispatcher
  // injects `cinatra_run_id`). Standalone is now a LIVE-RUNNABLE fixture
  // (see the @cinatra-ai/auditor-agent AGENT_FIXTURES entry below).
  //
  // reviewer-agent (standalone). Earlier DEFER hypothesized an EndNode
  // UUID-validation bounce, but the actual issue was that the OAS approval_gate
  // declared its renderer as `@cinatra-ai/email-reviewer-agent:output`, while
  // the text-envelope synthesis path (packages/agents/src/execution.ts:441)
  // only handles `@cinatra-ai/reviewer-agent:output`. The alternate renderer
  // path missed the synthesis hook so the gate never received a usable
  // userResponse and bounced. Fixed by normalizing the OAS renderer to the
  // canonical id and bumping package metadata so the install pipeline picks
  // up the new version.
  {
    packageName: "@cinatra-ai/reviewer-agent",
    vendor: "cinatra-ai",
    slug: "reviewer-agent",
    classification: "LIVE-RUNNABLE",
    startInputs: {},
    seedFn: async () => {
      await seedDraftBundleFromFixture();
      await seedFollowupBundleFromFixture();
      return {
        draftBundleRef: SEED_IDS.draftBundleA,
        followupBundleRef: SEED_IDS.followupBundleA,
      };
    },
    hitlScreens: [
      {
        // Approval gate now correctly hits the @cinatra-ai/reviewer-agent:output
        // renderer, which has the text-envelope synthesis behind it.
        kind: "custom-renderer",
        xRenderer: "@cinatra-ai/reviewer-agent:output",
        action: { userResponse: "Approved." },
      },
    ],
    expectedTerminalStatus: "completed",
    tunnelDependent: true,
    // 6-10 min: LLM review step fetches both bundles, critiques, saves
    // approved variants.
    runTimeoutMs: 600_000,
  },
  // auditor-agent (standalone). The OAS DFE wiring maps
  // start.agent_run_id → cinatra_run_id and includes start→{resolve_skills,
  // run_skills,apply_patches} edges. The standalone contract: seed {data,
  // parentPackageName, skillIds:[]}; runtime injects cinatra_run_id (= the
  // run's own id, run_by=test user so the /api/auditor/* run-ownership guard
  // passes). resolve_skills falls back to parent-package skill resolution;
  // with a skill-less parent it resolves [], run_skills builds no skill tools,
  // the LLM emits zero suggestions ("Do NOT invent suggestions when skills
  // produce none"), review_gate renders "No captured guidance", outer
  // Continue → apply_patches (acceptedIds=[] no-op) → end. parentPackageName
  // must be non-empty (route Zod `.min(1)`); the auditor's own package is
  // skill-less and self-referential-safe here.
  {
    packageName: "@cinatra-ai/auditor-agent",
    vendor: "cinatra-ai",
    slug: "auditor-agent",
    classification: "LIVE-RUNNABLE",
    startInputs: {},
    seedFn: async () => ({
      data: {
        note: "Standalone auditor smoke — no skills, expect zero suggestions.",
      },
      parentPackageName: "@cinatra-ai/auditor-agent",
      skillIds: [],
    }),
    hitlScreens: [
      {
        kind: "custom-renderer",
        xRenderer: "@cinatra-ai/auditor-agent:review",
        action: { userResponse: "Approved." },
      },
    ],
    expectedTerminalStatus: "completed",
    tunnelDependent: true,
    // 4-8 min: resolve_skills + run_skills LLM pass (zero skills) + the
    // single review_gate HITL + apply_patches no-op.
    runTimeoutMs: 600_000,
  },
];

/**
 * DEFER-PREREQ inventory.
 *
 * These agents are LIVE-RUNNABLE in principle but require pre-existing
 * platform state (campaign rows, contact lists, draft bundle refs) that
 * the harness can't seed without driving the email-outreach orchestrator
 * (or seeding via SQL/MCP). A focused prerequisite-seeding pass should either:
 *   - Adds a Playwright fixture builder that creates a campaign via
 *     `cinatra_email-outreach-agent` + captures the campaignId before
 *     dispatching the dependent agent, OR
 *   - Adds harness pre-test SQL to seed the minimal `cinatra.objects` rows
 *     each agent needs (typeHint + identityKey).
 *
 * Documenting here in the fixtures source-of-truth so the harness knows
 * which agents are intentionally absent from AGENT_FIXTURES and why.
 */
export const DEFER_PREREQ_AGENTS: ReadonlyArray<{
  packageName: string;
  prerequisites: string;
}> = [
  {
    packageName: "@cinatra-ai/email-recipient-selection-agent",
    prerequisites:
      "campaignId — requires a `@cinatra-ai/campaigns:context` object already in cinatra.objects.",
  },
  {
    packageName: "@cinatra-ai/email-drafting-agent",
    prerequisites:
      "campaignId + confirmedRecipients — chains after email-recipient-selection-agent.",
  },
  {
    packageName: "@cinatra-ai/email-follow-up-agent",
    prerequisites:
      "campaignId + followUpDays — chains after email-drafting-agent.",
  },
  {
    packageName: "@cinatra-ai/email-delivery-agent",
    prerequisites:
      "campaignId + approvedDraftBundleRef + confirmedRecipientsRef + senderEmail — last step of the email-outreach chain.",
  },
  {
    packageName: "@cinatra-ai/email-test-delivery-agent",
    prerequisites:
      "campaignId — needs a campaign already created.",
  },
  {
    packageName: "@cinatra-ai/auditor-agent",
    prerequisites:
      "data (object) + parentPackageName — typically called as a sub-agent during email-drafting.",
  },
  {
    packageName: "@cinatra-ai/list-curator-agent",
    prerequisites:
      "list creation context — needs a target list or seed data.",
  },
  {
    packageName: "@cinatra-ai/email-outreach-agent",
    prerequisites:
      "ORCHESTRATOR — drives 9 HITL screens across the full email workflow. Each step is testable but the orchestrator-level UAT is a multi-minute live run.",
  },
];

/** Convenience set for the preflight assertion. */
export const EXPECTED_VISIBLE_PACKAGE_SET: ReadonlySet<string> = new Set(
  CANONICAL_VISIBLE_PACKAGES.map((p) => p.packageName),
);
