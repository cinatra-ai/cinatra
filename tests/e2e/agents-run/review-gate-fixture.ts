/**
 * Marked artifact-review gate fixture harness (cinatra#2566, epic #2564 S2).
 *
 * WHY THIS EXISTS. A `ReviewGateCard` can only be exercised against a REAL
 * `artifact_review_gates` row, and the run-executor mints one only for a gate
 * whose compiled step carries `artifactReviewTargetsInput` — the
 * `metadata.cinatra.artifactReview.targetsInput` marker (cinatra#1796,
 * `packages/agents/src/oas-compiler.ts` → `packages/agents/src/execution.ts`).
 * No SHIPPED extension declares that marker, so before this fixture the marked
 * path had no producer at all: an e2e run could not reach the card without a
 * credentialed agent, and a SQL-seeded gate is invisible by construction (the
 * listing filters every candidate through `enforceReviewRunAccess`, which 404s a
 * gate whose `run_id` resolves to no `agent_runs` row).
 *
 * WHAT THE FIXTURE IS. `tests/fixtures/review-gate-agent/` ships a deterministic,
 * NO-LLM agent — StartNode → a single marked `InputMessageNode` gate → EndNode —
 * mirroring the layout `tests/fixtures/works-after-agent/` already uses for the
 * works-after WayFlow proof (a `<vendor>/<slug>/` tree with `cinatra/oas.json`
 * and a `.cinatra-published.json` marker). It is NOT a product extension: it is
 * private, never published, and lives only in the harness tree.
 *
 * WHAT IS REAL AND WHAT IS BYPASSED. Everything downstream of run creation is the
 * shipped path: the WayFlow runtime executes the flow, pauses `input-required`,
 * and the run executor's marked-gate branch pins the run's targets through
 * `emitArtifactReviewGate` — a REAL gate on a REAL run, decided through the
 * shipped decision core. Only run CREATION is seeded (a row + the BullMQ job),
 * exactly as `tests/e2e/agents-run/seed.ts` already does and for the same stated
 * reason: the production `/new` route's only job is collecting the same inputs
 * interactively.
 *
 * The review targets are the run's OWN `inputParams` — so the gate pins whatever
 * artifacts the caller uploaded through the real upload path, and no LLM,
 * connector, or credential is involved anywhere in the chain.
 */
import { randomUUID } from "node:crypto";
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { Queue } from "bullmq";
import { Client } from "pg";

const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const QUEUE_NAME = process.env.BULLMQ_QUEUE_NAME ?? "cinatra-background-jobs";
const AGENT_BUILDER_EXECUTION = "agent-builder-execution";

/** The fixture's coordinates. `vendor/slug` is the on-disk tree AND the WayFlow
 * mount path; `packageName` is the `agent_templates` key the host registers. */
export const REVIEW_GATE_FIXTURE = {
  vendor: "cinatra-review-fixture",
  slug: "marked-review-gate",
  packageName: "@cinatra-review-fixture/marked-review-gate",
  /** The flow input the marker names — the gate pins whatever this carries. */
  targetsInput: "review_targets",
  /** Where the committed fixture tree lives, relative to the repo root. */
  fixtureRoot: "tests/fixtures/review-gate-agent",
  /** The A2A mount the WayFlow runtime serves it at. */
  agentPath: "/agents/cinatra-review-fixture/marked-review-gate",
} as const;

/** A pinned review target — an artifact frozen at an exact representation
 * revision. Structurally identical to `ArtifactReviewTarget`; redeclared here so
 * the harness module stays free of app imports. */
export interface FixtureReviewTarget {
  artifactId: string;
  representationRevisionId: string;
}

async function withPg<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Copy the committed fixture into the extension tree BOTH consumers scan: the
 * host's dev boot (`extensions/<vendor>/<slug>/cinatra/oas.json`, which registers
 * the `agent_templates` row) and the WayFlow runtime (the same tree, bind-mounted
 * read-only at `/agents`). `extensions/` is git-ignored, so this is a staging
 * step, never a commit — the same shape `scripts/ci/works-after/wayflow.sh` uses
 * when it mounts `tests/fixtures/works-after-agent` as the runtime's agent root.
 *
 * Idempotent: re-staging overwrites in place.
 */
export async function stageReviewGateFixture(repoRoot: string): Promise<string> {
  const source = join(
    repoRoot,
    REVIEW_GATE_FIXTURE.fixtureRoot,
    REVIEW_GATE_FIXTURE.vendor,
    REVIEW_GATE_FIXTURE.slug,
  );
  const vendorDir = join(repoRoot, "extensions", REVIEW_GATE_FIXTURE.vendor);
  const target = join(vendorDir, REVIEW_GATE_FIXTURE.slug);
  await mkdir(vendorDir, { recursive: true });
  await cp(source, target, { recursive: true, force: true });
  return target;
}

/**
 * Create a queued run of the fixture agent whose `inputParams` carry the pinned
 * review targets, and enqueue the execution job. Returns the run id.
 *
 * The run then follows the SHIPPED path end to end: dispatch → WayFlow →
 * `input-required` → the marked-gate branch → `emitArtifactReviewGate`.
 */
export async function seedMarkedReviewGateRun(input: {
  userId: string;
  orgId: string;
  targets: FixtureReviewTarget[];
  /**
   * THE CONVERSATION THIS RUN IS PLAYING OUT IN (cinatra#3080, fix leg 9).
   *
   * The review card in a chat thread has no address of its own: there is no
   * `/chat?run=` road and there never was, because a card is not addressed by
   * the run it belongs to — it is written INTO the turn the run is playing out
   * in, and that turn is found by content (`readAgentRunTurnRow`), not by a
   * query string. A walk that navigated to a run-keyed chat URL was therefore
   * measuring a route this product does not serve, and read as a missing floor.
   *
   * So the caller mints a thread id and hands it here, and the seeder writes the
   * conversation the run is shown in BEFORE the job is enqueued — a thread the
   * reviewing user owns and one assistant turn that names this run. The turn
   * names the run WITHOUT drawing the run card (no `kind: "tool_call"` on the
   * part), which is exactly the run-started-elsewhere case the run outbox exists
   * to serve: the shipped writer finds this turn when the gate opens and injects
   * the moment's card into it. Nothing about the card is seeded — only the
   * conversation it lands in.
   */
  chatTurn?: { threadId: string };
}): Promise<string> {
  if (input.targets.length === 0) {
    throw new Error("seedMarkedReviewGateRun: at least one review target is required");
  }
  const runId = randomUUID();
  const { templateId, packageVersion } = await withPg(async (c) => {
    const r = await c.query<{ id: string; package_version: string | null }>(
      `SELECT id, package_version FROM ${SCHEMA}.agent_templates
        WHERE package_name = $1 LIMIT 1`,
      [REVIEW_GATE_FIXTURE.packageName],
    );
    if (r.rowCount === 0) {
      throw new Error(
        `review-gate-fixture: agent_templates row for ${REVIEW_GATE_FIXTURE.packageName} ` +
          `not found — stage the fixture into extensions/ and restart the host so dev boot registers it.`,
      );
    }
    return { templateId: r.rows[0].id, packageVersion: r.rows[0].package_version };
  });

  const inputParams = { [REVIEW_GATE_FIXTURE.targetsInput]: input.targets };
  await withPg((c) =>
    c.query(
      `INSERT INTO ${SCHEMA}.agent_runs
         (id, template_id, run_by, status, input_params, source_type,
          package_version, ag_ui_enabled, org_id)
       VALUES ($1, $2, $3, 'queued', $4, 'agent_builder', $5, true, $6)`,
      [runId, templateId, input.userId, JSON.stringify(inputParams), packageVersion, input.orgId],
    ),
  );

  if (input.chatTurn) {
    await seedConversationForRun({
      threadId: input.chatTurn.threadId,
      runId,
      userId: input.userId,
      orgId: input.orgId,
    });
  }

  const queue = new Queue(QUEUE_NAME, { connection: { url: REDIS_URL } });
  try {
    await queue.add(
      AGENT_BUILDER_EXECUTION,
      {
        runId,
        __actorContext: {
          principalType: "HumanUser",
          principalId: input.userId,
          organizationId: input.orgId,
          platformRole: "platform_admin",
          orgRole: "member",
          authSource: "ui",
          policyVersion: "v2",
        },
      },
      { jobId: runId, removeOnComplete: 200, removeOnFail: 500, attempts: 1 },
    );
  } finally {
    await queue.close();
  }
  return runId;
}


/**
 * The durable content of one assistant turn that dispatched `runId` - written
 * exactly as the stream route's sink writes it (`ag-ui-sink-adapter.ts`).
 */
function durableDispatchTurn(runId: string): Record<string, unknown> {
  const toolCallId = randomUUID();
  return {
    format: "assistant-turn-v1",
    role: "assistant",
    content: "",
    parts: [{ type: "tool_call", id: toolCallId, name: "agent_run" }],
    dataParts: [{ kind: "agent_run", toolCallId, runId }],
  };
}

/**
 * The conversation a seeded run is shown in — an UNBOUND thread the reviewing
 * user owns, and one assistant turn that names the run.
 *
 * The turn is the sink's own durable `assistant-turn-v1` object, carrying the
 * one thing a chat dispatch really persists for a run: an `agent_run` tool call
 * and the data part that pins the run to it. That pair is what the transcript
 * projects into the inline run card, and the run card is where the review gate
 * is drawn IN PLACE while the run waits - which is how a reader meets this floor
 * in a conversation. The durable format is not decoration: the reload projection
 * admits ONLY that object and returns nothing for any other shape, so a turn
 * written in the client's transcript shape is a turn the thread draws as empty.
 * The thread carries no assistant package and no instance, so it is addressed in
 * the default container - which is why the walk reads that container off `/chat`
 * itself rather than assuming one.
 */
export async function seedConversationForRun(input: {
  threadId: string;
  runId: string;
  userId: string;
  orgId: string;
}): Promise<void> {
  await withPg(async (c) => {
    await c.query(
      `INSERT INTO ${SCHEMA}.assistant_threads (id, owner_user_id, org_id, title, origin)
       VALUES ($1, $2, $3, $4, 'assistant-native')
       ON CONFLICT (id) DO NOTHING`,
      [input.threadId, input.userId, input.orgId, "Review floor walk"],
    );
    // THE SPINE FIRST. The transcript is reconstructed from the legacy-mirror
    // spine and the run-bound durable turns are FOLDED INTO it: a thread with no
    // spine row reconstructs to null and the read answers 404, which is what an
    // empty conversation looked like. The spine row is the person's own message
    // - the one that asked for the work - and it carries the reserved `legacy:`
    // id namespace and an ordinal, both of which are what makes it the spine.
    await c.query(
      `INSERT INTO ${SCHEMA}.assistant_turns
         (id, thread_id, role, ordinal, status, content)
       VALUES ($1, $2, 'user', 1, 'completed', $3::jsonb)`,
      [
        `legacy:${randomUUID()}`,
        input.threadId,
        JSON.stringify({
          id: randomUUID(),
          role: "user",
          content: "Make the work and send it to review.",
        }),
      ],
    );
    await c.query(
      // NO `ordinal`. An ordinal is the legacy mirror SPINE's ordering key; a
      // run-bound durable turn carries none, and the transcript assembler tells
      // the two apart by exactly that. A run-bound row given an ordinal is read
      // as a spine row it does not look like, and folded into nothing.
      `INSERT INTO ${SCHEMA}.assistant_turns
         (id, thread_id, run_id, role, status, content)
       VALUES ($1, $2, $3, 'assistant', 'completed', $4::jsonb)`,
      [
        randomUUID(),
        input.threadId,
        input.runId,
        JSON.stringify(durableDispatchTurn(input.runId)),
      ],
    );
  });
}

export interface SeededReviewGate {
  gateId: string;
  runId: string;
  reviewTaskId: string;
  status: string;
  pinnedTargets: FixtureReviewTarget[];
}

/**
 * Poll until the run-executor's marked-gate branch has minted the gate. Returns
 * the row; throws on timeout so a harness failure names the missing gate rather
 * than failing later on an empty card.
 */
export async function waitForMarkedReviewGate(
  runId: string,
  timeoutMs = 90_000,
): Promise<SeededReviewGate> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await withPg(async (c) => {
      const r = await c.query<{
        id: string;
        run_id: string;
        review_task_id: string;
        status: string;
        pinned_targets: FixtureReviewTarget[];
      }>(
        `SELECT id, run_id, review_task_id, status, pinned_targets
           FROM ${SCHEMA}.artifact_review_gates WHERE run_id = $1 LIMIT 1`,
        [runId],
      );
      return r.rows[0] ?? null;
    });
    if (row) {
      return {
        gateId: row.id,
        runId: row.run_id,
        reviewTaskId: row.review_task_id,
        status: row.status,
        pinnedTargets: row.pinned_targets,
      };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `review-gate-fixture: no artifact_review_gates row for run ${runId} within ${timeoutMs}ms — ` +
          `check that the WayFlow runtime serves ${REVIEW_GATE_FIXTURE.agentPath} and that the ` +
          `compiled step carries artifactReviewTargetsInput.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/**
 * OPEN A LIFECYCLE-ROAD REVIEW GATE ON AN ALREADY-SEEDED RUN (cinatra#3080, fix
 * leg 9).
 *
 * WHY A SECOND GATE FAMILY IS NEEDED AT ALL. Regenerate is the CHANGE road's
 * canonical operation, and that road serves exactly one family of gate: the
 * `lifecycle-review:` gates an artifact production opens. The flow-authored
 * reviewer gate this fixture's agent parks on carries the disjoint `wayflow-`
 * prefix by construction (`AUTO_REVIEW_TASK_PREFIX` is documented as disjoint
 * from it so the resume-delivery worker can tell the two apart), and
 * `recordReviewSurfaceChangesRequested` answers `not-a-lifecycle-gate` for it —
 * which the floor states on screen as "This review has no producing step to send
 * the words back to". A walk that presses Regenerate on a `wayflow-` gate is
 * therefore measuring that refusal whatever else it declares; declaring the
 * producing template repair-capable does not change the family, so it cannot
 * change the answer.
 *
 * WHAT THIS SEEDS, AND WHAT IT DOES NOT. One row in the same store the shipped
 * emitter writes to, pinning the SAME targets the run's own gate already pins,
 * on the SAME run — so the reviewer's authorization, the artifact read and the
 * producing run are all the real ones and only the gate's ROUTING KEY is the
 * fixture's. Nothing downstream is bypassed: the decision still travels the
 * shipped floor, the shipped action and the shipped change-road store, which is
 * where the successor gate and the `superseded` reading come from.
 */
export async function seedLifecycleReviewGate(runId: string): Promise<string> {
  const reviewTaskId = `lifecycle-review:e2e-${randomUUID()}`;
  const inserted = await withPg(async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO ${SCHEMA}.artifact_review_gates
         (id, run_id, org_id, review_task_id, status, pinned_targets)
       SELECT $1, g.run_id, g.org_id, $2, 'pending', g.pinned_targets
         FROM ${SCHEMA}.artifact_review_gates g
        WHERE g.run_id = $3
        ORDER BY g.created_at ASC
        LIMIT 1
       RETURNING id`,
      [randomUUID(), reviewTaskId, runId],
    );
    return r.rows[0] ?? null;
  });
  if (!inserted) {
    throw new Error(
      `review-gate-fixture: no gate to clone for run ${runId} — seed the run's own gate first.`,
    );
  }
  return reviewTaskId;
}
