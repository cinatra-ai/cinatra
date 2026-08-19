/**
 * cinatra#2852 capture lane — produce a REAL review gate whose suggestion
 * snapshot carries §VIII's before/after pairs, on the running lane stack.
 *
 * THE PROJECTOR IS THE LANE'S OWN SEAM, and this is the one thing worth reading
 * carefully. `runSuggestionProducerLane` takes an injectable `SuggestionProjector`
 * and documents its default as "deliberately modest … a type-aware projector
 * that flattens a document's real content is a drop-in that changes nothing
 * else". This lane supplies exactly that drop-in, because the SHIPPED default
 * projector cannot produce a suggestion at all on a current schema: it discloses
 * only `representation.revision` (an integer, stringified) and
 * `representation.form`, and `representation.form` is CHECK-constrained to
 * {file, connectorRef, dashboard}. Every value it can ever disclose is already
 * its own canonical form, so R1 never fires, R2/R3 have no collection to look
 * at, and the auto-gate hook always refuses with `empty-snapshot`.
 *
 * What the projector discloses here is the artifact's OWN content, read back
 * through the SHIPPED readers — the object row the materializer wrote, and the
 * body bytes through `readBlogPostBodyArtifactBytes`. Nothing is invented: the
 * derivation, the hash, the gate binding and the store write are all the shipped
 * `runSuggestionProducerLane` -> `writeGateSuggestionSnapshot` path, and the
 * before/after pairs are whatever the deterministic producer derives from those
 * disclosed bytes.
 *
 * Mocks are the ones evidence/2047-flip/drivers/walk.test.ts uses, for the same
 * reasons (a headless process cannot load the sqlite-era facade or the MCP
 * instruction module).
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { it, vi } from "vitest";

vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const cfg = await import("@/lib/postgres-config");
  const real = await vi.importActual<typeof import("@/lib/postgres-schema-init")>(
    "@/lib/postgres-schema-init",
  );
  return {
    ...actual,
    readChatThreadForClassifier: () => null,
    readMetadataValueFromDatabase: (_k: string, fallback: unknown) => fallback,
    writeMetadataValueToDatabase: () => {},
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
const STEP = process.env.WALK_STEP ?? "PRODUCE";
const STATE_FILE = process.env.WALK_STATE_FILE!;

const say = (s: string, d: unknown) => console.log(`WALK ${s} ${JSON.stringify(d)}`);
const loadState = (): Record<string, string> => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
};
const saveState = (p: Record<string, string>) =>
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...p }, null, 2));

/**
 * The BODY the artifact is seeded with. Deliberately NON-CANONICAL in two
 * different ways so the producer has two real defects to find and the surface
 * has two chips to draw: section one carries per-line trailing whitespace, and
 * section two is wrapped in surrounding whitespace. Nothing else about it is
 * unusual — it is ordinary prose a writer would produce.
 */
const SEEDED_BODY = [
   "# Launch note",
   "",
   "## Summary   ",
   "The connector ships this week.   ",
   "It replaces the manual export step.",
   "",
   "## Rollout",
   "   Enable it per organization, then remove the old export job.   ",
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
  const slot = process.env.WALK_SLOT ?? "a";

  if (STEP === "PRODUCE") {
    const runId = randomUUID();
    const [tpl] = await sql(
      `select id, package_name from "${schema}".agent_templates where package_name=$1 limit 1`,
      [process.env.WALK_TEMPLATE_PKG],
    );
    await sql(
      `insert into "${schema}".agent_runs (id, template_id, status, input_params, source_type, org_id, run_by, human_present)
       values ($1,$2,'running','{}','agent_builder',$3,$4,true) on conflict (id) do nothing`,
      [runId, tpl.id, ORG, USER],
    );
    const { materializeBlogPostBodyArtifact } = await import("@/lib/blog-post-artifact-materializer");
    const produced = await materializeBlogPostBodyArtifact({
      content: SEEDED_BODY,
      title: process.env.WALK_ARTIFACT_TITLE ?? "Launch note",
      createdByRunId: runId,
    });
    saveState({
      [`runId_${slot}`]: runId,
      [`artifactId_${slot}`]: produced.artifactId,
      [`revisionId_${slot}`]: produced.representationRevisionId,
    });
    say("PRODUCE", { slot, runId, ...produced });
  }

  if (STEP === "GATE") {
    const st = loadState();
    const orch = await import("@cinatra-ai/agents/lifecycle-review-orchestration");
    const summary = await orch.sweepReviewOrchestration();
    const gates = await sql(
      `select id, run_id, review_task_id, status from "${schema}".artifact_review_gates where run_id=$1`,
      [st[`runId_${slot}`]],
    );
    if (gates[0])
      saveState({
        [`reviewTaskId_${slot}`]: String(gates[0].review_task_id),
        [`gateId_${slot}`]: String(gates[0].id),
      });
    say("GATE", { slot, summary, gates });
  }

  if (STEP === "SUGGEST") {
    const st = loadState();
    const artifactId = st[`artifactId_${slot}`];
    const revisionId = st[`revisionId_${slot}`];
    const { runSuggestionProducerLane } = await import(
      "../../../packages/agents/src/lifecycle-suggestion-producer-lane"
    );
    const { readBlogPostBodyArtifactBytes } = await import(
      "@/lib/blog-post-artifact-materializer"
    );

    // The TYPE-AWARE projector the lane documents as a drop-in. It reads the
    // artifact's own row and its own bytes through the shipped readers, and
    // flattens the document into the dot-separated field map every lifecycle
    // projector already uses. It discloses the title and the body's sections;
    // everything it does NOT read is named in `excludedFields`, so the producer
    // knows the disclosure is partial and R2 (destructive) stays disarmed.
    const project = async () => {
      const [row] = await sql(`select data from "${schema}".objects where id=$1`, [artifactId]);
      const data = (row?.data ?? {}) as Record<string, unknown>;
      const bytes = await readBlogPostBodyArtifactBytes({
        artifactId,
        representationRevisionId: revisionId,
      });
      const includedFields: Record<string, string> = {};
      if (typeof data.title === "string") includedFields["artifact.title"] = data.title;
      const body = bytes?.body ?? "";
      // Split on the document's own `## ` headings — the sections a reader sees.
      const parts = body.split(/\n(?=## )/g).filter((p) => p.trim() !== "");
      parts.forEach((part, i) => {
        includedFields[`artifact.sections.${i}.text`] = part;
      });
      return {
        projection: {
          includedFields,
          excludedFields: [
            "artifact.mime",
            "artifact.objectType",
            "artifact.sourceUrl",
            "representation.resource",
          ].sort(),
        },
        authzDecision: "authorized" as const,
      };
    };

    const outcome = await runSuggestionProducerLane({
      gateId: st[`gateId_${slot}`],
      target: { artifactId, representationRevisionId: revisionId },
      project,
    });
    const snap = await sql(
      `select id, gate_id, jsonb_array_length(payload->'suggestions') as n from "${schema}".gate_suggestion_snapshots where gate_id=$1`,
      [st[`gateId_${slot}`]],
    );
    const payload = await sql(
      `select payload from "${schema}".gate_suggestion_snapshots where gate_id=$1`,
      [st[`gateId_${slot}`]],
    );
    say("SUGGEST", {
      slot,
      outcome,
      snapshots: snap,
      suggestions: (payload[0]?.payload as { suggestions?: unknown[] } | undefined)?.suggestions,
    });
  }

  if (STEP === "REF") {
    const st = loadState();
    const { encodeLifecycleGateRef } = await import("@/lib/lifecycle/lifecycle-card-ref");
    const ref = encodeLifecycleGateRef({
      runId: st[`runId_${slot}`],
      reviewTaskId: st[`reviewTaskId_${slot}`],
    });
    saveState({ [`ref_${slot}`]: ref });
    say("REF", { slot, refLength: ref.length });
  }

  if (STEP === "DEFAULT_PROJECTOR_CONTROL") {
    // The control that makes the projector note above a MEASUREMENT rather than
    // a claim: the SHIPPED default projector, run against this same target.
    const st = loadState();
    const { defaultSuggestionProjector } = await import(
      "../../../packages/agents/src/lifecycle-suggestion-producer-lane"
    );
    const { buildGateSuggestions } = await import("@/lib/lifecycle/lifecycle-suggestion-producer");
    const target = {
      artifactId: st[`artifactId_${slot}`],
      representationRevisionId: st[`revisionId_${slot}`],
    };
    const projected = await defaultSuggestionProjector(ORG)(target);
    const built = buildGateSuggestions({
      target,
      projection: projected.projection,
      authzDecision: projected.authzDecision,
    });
    say("DEFAULT_PROJECTOR_CONTROL", {
      includedFields: projected.projection.includedFields,
      authzDecision: projected.authzDecision,
      suggestionCount: built.suggestions.length,
    });
  }
}

it("walk", async () => {
  await main();
});
