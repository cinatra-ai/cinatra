/**
 * cinatra#2790 S9f — THE CHAT ROUND'S LANE FIXTURE.
 *
 * Everything this file writes is WORLD, never SUBJECT. No hold, no park, no
 * run, no decision, no output and no review gate is ever seeded here: those are
 * what the sequence produces, and seeding any of them would be the defect the
 * maintainer's objection is about.
 *
 * Three writes, each through a SHIPPED writer:
 *
 *   PROVIDER  — a provider PRESENCE placeholder through `writeOpenAIConnection`
 *               (which seals at rest). NO REAL KEY EXISTS ON THIS LANE: the
 *               placeholder is a published literal, and generation is served by
 *               `CINATRA_TEST_LLM_PROVIDER=scripted`, which since #2917 also
 *               serves `POST /api/llm-bridge` — the surface the agent's own step
 *               performs its model call on. Without SOME bound adapter the
 *               assistant turn goes conversation-only and the hard pre-router
 *               never fires, which is the whole reason presence is needed.
 *   MCP       — the MCP public base URL, origin-only, on this lane's app origin.
 *   ASSIGN    — four organization-owned skill assignments through the shipped
 *               writer `upsertCustomSkillAssignment`, so the recommendation
 *               scorer has candidates to offer. Without them the checkpoint
 *               answers "no recommendation candidates" and the run dispatches
 *               UNHELD — a green walk proving the opposite of what it claims.
 *
 * Plus two read-only pre-checks that cost no model call:
 *
 *   IDENTITY  — the SHIPPED `readInstanceIdentity`, so a missing instance
 *               identity is found BEFORE a run is driven rather than after the
 *               step has already answered.
 *   READBACK  — the run's rows, verbatim, with the timestamps the TIMELINE cites.
 *
 * Mock shape and metadata delegation are taken verbatim from `walk.test.ts`
 * beside this file.
 */
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

/**
 * THE PROVIDER PRESENCE PLACEHOLDER — a published literal, not a credential.
 * It is the same shape the S9k dev-runtime flow publishes, for the same reason.
 */
const PRESENCE_PLACEHOLDER = "sk-not-a-real-key-s9f-chat-sequence";

const say = (s: string, d: unknown) => console.log(`S9FCHAT ${s} ${JSON.stringify(d)}`);
const loadState = (): Record<string, string> => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
};
const saveState = (p: Record<string, string>) =>
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...p }, null, 2));

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

  if (STEP === "PROVIDER") {
    const { writeOpenAIConnection, readOpenAIConnection } = await import(
      "@/lib/openai-connection-store"
    );
    writeOpenAIConnection({ apiKey: PRESENCE_PLACEHOLDER });
    const back = readOpenAIConnection();
    say("PROVIDER", {
      placeholderOnly: true,
      storeResolvesAKey: Boolean(back?.apiKey && back.apiKey.length > 0),
      isThePublishedPlaceholder: back?.apiKey === PRESENCE_PLACEHOLDER,
      defaultModel: back?.defaultModel ?? null,
    });
  }

  if (STEP === "PROVIDER_READ") {
    const { readOpenAIConnection } = await import("@/lib/openai-connection-store");
    const back = readOpenAIConnection();
    say("PROVIDER_READ", {
      storeResolvesAKey: Boolean(back?.apiKey && back.apiKey.length > 0),
      isThePublishedPlaceholder: back?.apiKey === PRESENCE_PLACEHOLDER,
    });
  }

  if (STEP === "PROVIDER_CLEAR") {
    // THE PROVIDER WINDOW CLOSES. Read the header: the presence placeholder is
    // there ONLY so the chat turn reaches its hard pre-router, and it is removed
    // through the SHIPPED `clearOpenAIConnection` before the agent's own model
    // call, so `resolveConfiguredLlmRuntime()` reaches its last resort and the
    // bridge is served by the scripted runtime (#2917) instead of trying a real
    // OpenAI call with a published non-key.
    const { clearOpenAIConnection, readOpenAIConnection } = await import(
      "@/lib/openai-connection-store"
    );
    // The writer clears the sealed row and THEN calls `revalidatePath`, which
    // throws outside a Next request scope. The clear has already landed at that
    // point, so the throw is caught and the read-back below — not the absence of
    // an exception — is what says whether the key is gone.
    let revalidateThrew: string | null = null;
    try {
      await clearOpenAIConnection();
    } catch (e) {
      revalidateThrew = e instanceof Error ? e.message : String(e);
    }
    const back = readOpenAIConnection();
    say("PROVIDER_CLEAR", {
      storeResolvesAKey: Boolean(back?.apiKey && back.apiKey.length > 0),
      revalidateThrewOutsideRequestScope: revalidateThrew,
    });
  }

  if (STEP === "MCP") {
    const { setMcpPublicBaseUrl, getMcpPublicBaseUrl } = await import(
      "@cinatra-ai/mcp-server/credentials"
    );
    setMcpPublicBaseUrl(process.env.WALK_BASE!);
    say("MCP", getMcpPublicBaseUrl());
  }

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

  if (STEP === "IDENTITY") {
    // The pre-check that costs no model call. The artifact-binding loader
    // resolves the instance's registry namespace from the `instance_identity`
    // metadata row, and a lane whose row is absent refuses EVERY materialization
    // — discovered only after the step has already answered. Read here through
    // the SHIPPED reader, before anything is driven.
    const { readInstanceIdentity } = await import("@/lib/instance-identity-store");
    const id = readInstanceIdentity() as { instanceNamespace?: string; displayName?: string } | null;
    say("IDENTITY", {
      present: Boolean(id),
      hasNamespace: Boolean(id?.instanceNamespace),
      displayName: id?.displayName ?? null,
    });
  }

  if (STEP === "READBACK") {
    const runId = loadState().runId ?? process.env.WALK_RUN_ID ?? "";
    const rows = {
      run: await sql(
        `select id, status, human_present, created_at, completed_at, error from "${schema}".agent_runs where id=$1`,
        [runId],
      ),
      park: await sql(
        `select id, checkpoint, status, created_at, resolved_at from "${schema}".lifecycle_continuation_park where run_id=$1`,
        [runId],
      ),
      selections: await sql(
        `select skill_id, selection_source, selected_at from "${schema}".run_selected_skill_revisions where run_id=$1 order by selected_at, skill_id`,
        [runId],
      ),
      representations: await sql(
        `select id, created_at, media_type, created_by_run_id from "${schema}".representation where created_by_run_id=$1 order by created_at`,
        [runId],
      ),
      outbox: await sql(
        `select id, created_at, processed_at, emitter, origin_kind from "${schema}".artifact_produced_outbox where producer_run_id=$1`,
        [runId],
      ),
      gates: await sql(
        `select id, review_task_id, status, created_at from "${schema}".artifact_review_gates where run_id=$1`,
        [runId],
      ),
    };
    if (rows.gates[0]) saveState({ reviewTaskId: String(rows.gates[0].review_task_id) });
    say("READBACK", rows);
  }
}

it("s9f chat lane fixture", async () => {
  await main();
}, 900_000);
