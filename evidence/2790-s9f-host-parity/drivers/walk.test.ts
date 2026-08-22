/**
 * cinatra#2790 S9f HOST PARITY — the LIVE seeding walk on this lane's own dev
 * stack. It drives the SHIPPED paths and nothing else.
 *
 *   ASSIGN  — four organization-owned skill assignments through the shipped
 *             writer `upsertCustomSkillAssignment`, so the run actor AND the
 *             widget reader resolve the same candidate set.
 *   SEED    — one `pending_input`, human-present run per slot.
 *   HOLD    — park each through `maybeHoldRunForRecommendation`, the ONE seam
 *             the interactive run trigger uses, and read the park back.
 *   PROVIDER— seed the model provider connection through the SHIPPED writer
 *             `writeOpenAIConnection`, which SEALS the key at rest. The
 *             credential reaches this process ONLY through the process
 *             environment (the operator’s secret-manager `run` wrapper around this exact
 *             command) and is never written to a file, never echoed, never
 *             logged: this step reports presence and nothing else.
 *   PRODUCE — RETIRED for the WayFlow round. It wrote the review gate's
 *             artifact through the shipped materializer when the run could not
 *             execute; the run now produces its own output through the WayFlow
 *             runtime, so this step is not run and is kept only so the earlier
 *             rounds in this lane's history stay reproducible.
 *   GATE    — `sweepReviewOrchestration()`, the shipped sweeper, which mints
 *             the `artifact_review_gates` row and its review task id.
 *   READBACK— the rows, verbatim.
 *
 * Mock shape adapted from evidence/2841-v-redraw/drivers/walk.test.ts (a
 * headless process cannot load the sqlite-era facade or the MCP instruction
 * module).
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { it, vi } from "vitest";

vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const cfg = await import("@/lib/postgres-config");
  const metadataStore = await vi.importActual<typeof import("@/lib/database-metadata")>(
    "@/lib/database-metadata",
  );
  const real = await vi.importActual<typeof import("@/lib/postgres-schema-init")>(
    "@/lib/postgres-schema-init",
  );
  return {
    ...actual,
    readChatThreadForClassifier: () => null,
    // Metadata reads/writes are DELEGATED to the real store rather than
    // stubbed. The earlier stub (`(_k, fallback) => fallback`) made every
    // metadata row read as absent inside this harness, which silently turned
    // the BINDINGS pre-check below into a false negative: it reported the
    // instance identity as unconfigured while the row was in fact present.
    // A pre-check that cannot see the row it is checking is worse than none.
    readMetadataValueFromDatabase: (k: string, fallback: unknown) =>
      metadataStore.readMetadataValueInternal(k, fallback),
    writeMetadataValueToDatabase: (k: string, v: unknown) =>
      metadataStore.writeMetadataValueInternal(k, v),
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: real.ensurePostgresSchema,
  };
});

vi.mock("@/lib/mcp-instructions", () => ({
  CINATRA_MCP_INSTRUCTIONS: "",
  CINATRA_MCP_EXPERIMENTAL: {},
}));

const ORG = process.env.WALK_ORG_ID!;
const USER = process.env.WALK_USER_ID!;
const CONN = process.env.SUPABASE_DB_URL!;
const STEP = process.env.WALK_STEP ?? "READBACK";
const STATE_FILE = process.env.WALK_STATE_FILE!;
const PROMPT =
  process.env.WALK_PROMPT ??
  "Draft a blog post from the attached resource that classifies the brand voice and tone guide, and keep the editorial writing rules.";
const SLOTS = (process.env.WALK_SLOTS ?? "widget,review").split(",").filter(Boolean);

const say = (s: string, d: unknown) => console.log(`WALK2790 ${s} ${JSON.stringify(d)}`);
const loadState = (): Record<string, string> => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
};
const saveState = (p: Record<string, string>) =>
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...p }, null, 2));

/** The body the review-page slot's artifact is seeded with. Ordinary prose. */
const SEEDED_BODY = [
  "# Connector rollout note",
  "",
  "## Summary",
  "The connector ships this week.",
  "It replaces the manual export step.",
  "",
  "## Rollout",
  "Enable it per organization, then remove the old export job.",
  "",
].join("\n");

async function main() {
  const { runPostgresQueriesSync } = await import("@/lib/postgres-sync");
  const { postgresSchema } = await import("@/lib/postgres-config");
  const schema = postgresSchema.replaceAll('"', '""');
  const { registerArtifactExtensions } = await import(
    "@cinatra-ai/objects/register-artifact-extensions"
  );
  registerArtifactExtensions(process.cwd() + "/extensions");

  const sql = async (text: string, values: unknown[] = []) => {
    const r = await runPostgresQueriesSync({ connectionString: CONN, queries: [{ text, values }] });
    return (r?.[0]?.rows ?? []) as Array<Record<string, unknown>>;
  };

  if (STEP === "ASSIGN") {
    const { upsertCustomSkillAssignment } = await import("@/lib/database");
    const agentId = process.env.WALK_AGENT_ID!;
    const skillIds = (process.env.WALK_SKILL_IDS ?? "").split(",").filter(Boolean);
    for (const skillId of skillIds) {
      upsertCustomSkillAssignment({
        skillId,
        agentId,
        ownerType: "organization" as never,
        ownerId: ORG,
        createdBy: USER,
      });
    }
    const { getAssignedSkillIdsForAgent } = await import("@/lib/agents-store");
    say("ASSIGN", {
      agentId,
      wrote: skillIds,
      resolved: await getAssignedSkillIdsForAgent(agentId, {
        principalId: USER,
        teamIds: [],
        projectIds: [],
        organizationId: ORG,
      } as never),
    });
  }

  if (STEP === "SEED") {
    const TEMPLATE = process.env.WALK_TEMPLATE_ID!;
    const ids: Record<string, string> = {};
    for (const slot of SLOTS) {
      const id = randomUUID();
      await sql(
        `insert into "${schema}".agent_runs (id, template_id, status, input_params, source_type, org_id, run_by, human_present)
         values ($1,$2,'pending_input',$3,'agent_builder',$4,$5,true) on conflict (id) do nothing`,
        [id, TEMPLATE, JSON.stringify({ prompt: PROMPT }), ORG, USER],
      );
      ids[`${slot}RunId`] = id;
    }
    saveState({ ...ids, templateId: TEMPLATE });
    say("SEED", {
      rows: await sql(
        `select id, status, human_present from "${schema}".agent_runs where id = any($1)`,
        [Object.values(ids)],
      ),
    });
  }

  if (STEP === "HOLD") {
    const st = loadState();
    const { maybeHoldRunForRecommendation, readRecommendationParkForRun } = await import(
      "../../../packages/agents/src/recommendation-hold"
    );
    const [tplRow] = await sql(
      `select package_name, lifecycle_config from "${schema}".agent_templates where id=$1`,
      [st.templateId],
    );
    const out: Record<string, unknown> = {};
    for (const slot of SLOTS) {
      const runId = st[`${slot}RunId`];
      const [runRow] = await sql(
        `select id, org_id, run_by, source_type, human_present, input_params from "${schema}".agent_runs where id=$1`,
        [runId],
      );
      const hold = await maybeHoldRunForRecommendation({
        run: {
          id: String(runRow.id),
          orgId: String(runRow.org_id),
          runBy: (runRow.run_by as string | null) ?? null,
          sourceType: (runRow.source_type as string | null) ?? null,
          humanPresent: runRow.human_present as boolean | null,
          inputParams: runRow.input_params as never,
        },
        template: {
          packageName: String(tplRow.package_name),
          lifecycleConfig: (tplRow.lifecycle_config as string | null) ?? null,
        },
      });
      const park = await readRecommendationParkForRun(runId);
      out[slot] = {
        runId,
        hold,
        park: park ? { id: park.id, status: park.status, checkpoint: park.checkpoint } : null,
      };
    }
    say("HOLD", { packageName: String(tplRow.package_name), ...out });
  }

  if (STEP === "PROVIDER") {
    // The model credential arrives ONLY in the process environment, injected by
    // the operator’s secret-manager `run` wrapper around this exact command. It is read
    // once, handed straight to the shipped writer (which seals it at rest with
    // CINATRA_ENCRYPTION_KEY), and never touched again. Nothing below prints,
    // returns, stores or derives anything from the value — the read-back is a
    // BOOLEAN.
    const { writeOpenAIConnection, readOpenAIConnection } = await import(
      "@/lib/openai-connection-store"
    );
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    if (!apiKey.trim()) {
      throw new Error(
        "OPENAI_API_KEY is absent from the process environment — run this step " +
          "inside the vault wrapper; nothing is read from a file.",
      );
    }
    const organizationId = process.env.OPENAI_API_ORG?.trim() || undefined;
    const projectId = process.env.OPENAI_API_PROJECT?.trim() || undefined;
    writeOpenAIConnection({
      apiKey,
      organizationId,
      projectId,
      lastValidatedAt: new Date().toISOString(),
    });
    const back = readOpenAIConnection();
    say("PROVIDER", {
      wrote: true,
      // PRESENCE ONLY. Never a value, never a length, never a prefix.
      storeResolvesAKey: Boolean(back?.apiKey && back.apiKey.length > 0),
      defaultModel: back?.defaultModel ?? null,
      hasLastValidatedAt: Boolean(back?.lastValidatedAt),
      sealedAtRest: true,
    });
  }

  if (STEP === "PRODUCE") {
    const st = loadState();
    const runId = st.reviewRunId;
    const { materializeBlogPostBodyArtifact } = await import("@/lib/blog-post-artifact-materializer");
    const produced = await materializeBlogPostBodyArtifact({
      content: SEEDED_BODY,
      title: "Connector rollout note",
      createdByRunId: runId,
    });
    saveState({ artifactId: produced.artifactId, revisionId: produced.representationRevisionId });
    say("PRODUCE", { runId, ...produced });
  }

  if (STEP === "BINDINGS") {
    // ZERO-COST PRE-CHECK. The run's own production leg persists what it made
    // through the artifact materializer, which resolves the agent package's
    // artifact BINDINGS from the instance registry before it writes anything.
    // Every failure of that resolution costs a model call to discover from a
    // live run, so this step exercises exactly that resolution — the SHIPPED
    // `loadRunDerivationContext` — with no dispatch and no model call at all.
    const { loadRunDerivationContext } = await import(
      "@/lib/artifacts/run-artifact-materializer"
    );
    const st = loadState();
    const templateId = process.env.WALK_TEMPLATE_ID ?? st.templateId;
    let ctx: unknown;
    try {
      ctx = await loadRunDerivationContext({
        templateId,
        packageVersion: process.env.WALK_PACKAGE_VERSION ?? null,
      });
    } catch (e) {
      ctx = { error: e instanceof Error ? e.message : String(e) };
    }
    say("BINDINGS", { templateId, context: ctx });
  }

  if (STEP === "GATE") {
    const st = loadState();
    const orch = await import("@cinatra-ai/agents/lifecycle-review-orchestration");
    const summary = await orch.sweepReviewOrchestration();
    const gates = await sql(
      `select id, run_id, review_task_id, status from "${schema}".artifact_review_gates where run_id=$1`,
      [st.reviewRunId],
    );
    if (gates[0])
      saveState({ reviewTaskId: String(gates[0].review_task_id), gateId: String(gates[0].id) });
    say("GATE", { summary, gates });
  }

  if (STEP === "WIDGET") {
    // Register a widget INSTANCE and its connect-site for a plain local page, so
    // the `site_widget` host can be driven without a WordPress container. The
    // mechanism is taken verbatim from
    // evidence/2754-island-wire/drivers/02-seed-widget-site.mts; it runs inside
    // this walk because the two writers are `server-only` modules and this
    // config is what stubs that import.
    //
    // Nothing is written by hand: these are the two SHIPPED writers the CMS
    // OAuth exchange itself calls —
    //   * `writeConnectorConfigToDatabase("wordpress", { instances: [...] })`,
    //     the same store the connector's own dev-setup hook writes into, and
    //   * `upsertConnectSiteAndMintCredential(...)`, the same function
    //     `POST /api/connect/token` calls to mint a site.
    // Everything the widget then does — the PKCE frame handshake, the `cwu_`
    // mint, the recommendation-hold resolve and the decide — is the shipped
    // path, unseeded.
    const WIDGET_ORIGIN = process.env.WALK_WIDGET_ORIGIN!;
    const INSTANCE_ID = process.env.WALK_WIDGET_INSTANCE_ID!;
    const CLIENT = "wordpress";
    const { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } = await import(
      "@/lib/database"
    );
    const { upsertConnectSiteAndMintCredential } = await import("@/lib/connect-provisioning");
    const { deriveFrameBinding } = await import("@/lib/widget-frame-auth");

    const current = readConnectorConfigFromDatabase<{ instances?: unknown[] }>(CLIENT, {
      instances: [],
    });
    const instances = Array.isArray(current?.instances) ? [...current.instances] : [];
    const kept = instances.filter(
      (r) => !(r && typeof r === "object" && (r as { id?: unknown }).id === INSTANCE_ID),
    );
    // The connector declares `requiredInstanceFields` = id/name/username/
    // applicationPassword, and the `cit_` consume refuses an origin whose
    // instance row is short of them (`origin_unconfigured`). The two WordPress
    // credential fields are what the connector would use to call a WordPress
    // REST API; this capture never calls one (there is no WordPress), so they
    // are present-but-inert placeholders. Nothing on the lifecycle path reads
    // them.
    kept.push({
      id: INSTANCE_ID,
      siteUrl: WIDGET_ORIGIN,
      name: "2790 S9f capture site",
      username: "s9f-capture",
      applicationPassword: "2790 capture placeholder (no WordPress is called)",
    });
    writeConnectorConfigToDatabase(CLIENT, { ...(current ?? {}), instances: kept });

    const { site } = upsertConnectSiteAndMintCredential({
      client: CLIENT,
      widgetOrigin: WIDGET_ORIGIN,
      callbackOrigin: null,
      webhookSecretHash: null,
      adminUserId: USER,
      orgId: ORG,
    });

    // Prove the binding the frame will be judged by actually closes.
    const binding = deriveFrameBinding({ assistant: CLIENT, instanceId: INSTANCE_ID });
    say("WIDGET", {
      instances: kept.map((r) => (r as { id?: string }).id),
      site: {
        siteId: site.siteId,
        client: site.client,
        widgetOrigin: site.widgetOrigin,
        orgId: site.orgId,
        credentialVersion: site.credentialVersion,
      },
      deriveFrameBinding: binding,
    });
    if (!binding.ok) throw new Error("frame binding did not close");
  }

  if (STEP === "DIAG") {
    // Diagnostic only: what does the SHIPPED candidate seam answer for this run
    // and this viewer? Used to tell a lane-data gap (no assignment resolves for
    // the viewer) apart from a code gap (the seam answers nothing at all).
    const st = loadState();
    const runId = st[`${process.env.WALK_SLOT ?? "review"}RunId`];
    const { readAgentRunById } = await import("../../../packages/agents/src/store");
    const { resolveRecommendationCandidateSkillIds } = await import(
      "../../../packages/agents/src/recommendation-hold"
    );
    const { getRunRecommendations } = await import(
      "../../../packages/agents/src/recommendation-interception"
    );
    const { getAssignedSkillIdsForAgent } = await import("@/lib/agents-store");
    const actor = { userId: USER, orgId: ORG } as never;
    const run = await readAgentRunById(runId, actor).catch((e: unknown) => ({ error: String(e) }));
    const viewer = { principalId: USER, teamIds: [], projectIds: [], organizationId: ORG } as never;
    const assigned = await getAssignedSkillIdsForAgent(process.env.WALK_AGENT_ID!, viewer);
    let candidates: unknown = null;
    let recs: unknown = null;
    if (run && !(run as { error?: string }).error) {
      candidates = await resolveRecommendationCandidateSkillIds({
        run: run as never,
        packageName: process.env.WALK_AGENT_ID!,
        viewer,
      }).catch((e: unknown) => ({ error: String(e) }));
      recs = await getRunRecommendations({
        agentId: process.env.WALK_AGENT_ID!,
        intent: { promptText: JSON.stringify((run as { inputParams?: unknown }).inputParams ?? {}) },
        restrictToSkillIds: Array.isArray(candidates) ? (candidates as string[]) : undefined,
      }).catch((e: unknown) => ({ error: String(e) }));
    }
    say("DIAG", {
      runId,
      runFound: Boolean(run) && !(run as { error?: string }).error,
      runErr: (run as { error?: string })?.error ?? null,
      assignedForViewer: assigned,
      candidates,
      recs: Array.isArray(recs)
        ? (recs as Array<Record<string, unknown>>).map((r) => ({
            skillId: r.skillId,
            displayName: r.displayName,
            score: r.score,
            rank: r.rank,
            recommended: r.recommended,
          }))
        : recs,
    });
  }

  if (STEP === "READBACK") {
    const st = loadState();
    const runIds = SLOTS.map((s) => st[`${s}RunId`]).filter(Boolean);
    say("READBACK", {
      parks: await sql(
        `select run_id, checkpoint, status from "${schema}".lifecycle_continuation_park where run_id = any($1)`,
        [runIds],
      ),
      runs: await sql(`select id, status from "${schema}".agent_runs where id = any($1)`, [runIds]),
      gates: await sql(
        `select run_id, review_task_id, status from "${schema}".artifact_review_gates where run_id = any($1)`,
        [runIds],
      ),
      selected: await sql(
        `select run_id, skill_id, selection_source from "${schema}".run_selected_skill_revisions where run_id = any($1)`,
        [runIds],
      ),
      rejected: await sql(
        `select run_id, skill_id, recommendation_source from "${schema}".run_rejected_recommendations where run_id = any($1)`,
        [runIds],
      ),
    });
  }
}

it("walk", async () => {
  await main();
}, 900_000);
