import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  producesObjectTypeIdForExtension,
  type SemanticArtifactProducesRef,
} from "@cinatra-ai/agents/artifact-binding";
import { withActorContext } from "@cinatra-ai/llm/actor-context";
import type { ActorContext } from "@/lib/authz/actor-context";
import { getPooledDb } from "@/lib/db/pooled";
import {
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { buildAgentInstancePath } from "@/lib/agent-url";
import { resolveBoundArtifactTarget } from "./resolve-bound-artifact-type";
import {
  writeClaimedArtifact,
  resolveRunScopeOwnership,
  loadRunDerivationContext,
} from "./run-artifact-materializer";
import {
  MAX_AUTHORED_CONTENT_BYTES,
} from "./artifact-authoring";

// ---------------------------------------------------------------------------
// Unbound agent-output derivation (cinatra#1893, epic #1883 slice A5).
//
// The post-terminal half of the produces-scoped capture. The terminal
// transition (transitionRunStatus' `derivationOutbox` branch) already committed
// ONE `agent_run_output_derivations` row per non-empty WayFlow terminal-success
// run — the durable outbox — atomically with the status CAS + final-output
// snapshot. THIS module is the derivation job that drains that outbox: it types
// the captured final output against the run agent's VALIDATED `produces` only
// (ruling 6; the classifier merely tiebreaks AMONG the declared produces types),
// materializes through the standard writer under the new `derived_output` ledger
// path, and otherwise emits an advisory `info` notification instead of
// persisting.
//
// SERIALIZATION (codex round-0 Q4 — a correctness blocker): the one-shot job and
// the reconciliation sweep can both target the same `pending` row and reach
// DIFFERENT decisions (one classifies a match, the other times out). The ledger
// dedupe + the occurrence-deduped advisory guard the EFFECTS, but not the
// DECISION, so a recoverable ROW LEASE serializes it: a driver atomically claims
// the row (`pending`/expired-`deriving` → `deriving` + token + attempts++), then
// every terminal write is guarded by that token. A losing driver's claim matches
// zero rows and it simply exits. The LLM classifier call happens OUTSIDE any DB
// transaction. The sweep reclaims expired leases; exhausted rows (attempts cap
// reached) stay VISIBLE at their last non-terminal status rather than being
// forced to a wrong terminal outcome.
// ---------------------------------------------------------------------------

/**
 * Reserved ledger `output_id` for the derived-output path. It is DELIBERATELY
 * not a valid OAS node id / EndNode output name (it carries a `:`), so the
 * 4-part unique ledger key (run, output_id, extension, content_hash) — which
 * excludes `path` — can never collide with an `end_node_binding` /
 * `materialize_tool` row of the same run. `writeClaimedArtifact` additionally
 * verifies the winning row's `path` on conflict (defense-in-depth, codex Q3).
 */
export const DERIVED_OUTPUT_LEDGER_OUTPUT_ID = "cinatra:run-final-output";

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const CLASSIFIER_CONFIDENCE_THRESHOLD = 0.8;
const SWEEP_BATCH = 50;

/** A terminal derivation outcome, plus the two non-terminal dispositions the
 *  driver returns when it did NOT settle the row (another holder / nothing to
 *  do). Only `done | no_match | no_produces` are persisted as row status. */
export type UnboundDerivationOutcome =
  | "done"
  | "no_match"
  | "no_produces"
  | "skipped";

/** The classifier seam — the ONLY injectable/stubbed boundary (a genuine LLM
 *  dependency). Everything else in the derivation runs against the real store.
 *  Returns the chosen candidate objectTypeId + confidence, or null when no
 *  runtime is configured / nothing matched (⇒ the caller settles `no_match`). */
export type UnboundDerivationClassify = (input: {
  content: string;
  contentIsJson: boolean;
  candidateTypeIds: readonly string[];
}) => Promise<{ objectTypeId: string; confidence: number } | null>;

export type UnboundDerivationDeps = {
  classify?: UnboundDerivationClassify;
  now?: () => Date;
  leaseMs?: number;
  maxAttempts?: number;
};

/** Transient failure escaping the derivation so BullMQ (or the next sweep)
 *  re-drives — the lease is released before it is thrown. */
export class UnboundDerivationRetryableError extends Error {
  readonly retryable = true as const;
  constructor(message: string) {
    super(message);
    this.name = "UnboundDerivationRetryableError";
  }
}

function pool(): Pool {
  return getPooledDb({
    name: "unbound-output-derivation",
    connectionString: () => getPostgresConnectionString(),
  });
}

function schema(): string {
  return postgresSchema.replaceAll('"', '""');
}

type LeasedOutboxRow = {
  runId: string;
  orgId: string;
  templateId: string;
  packageVersion: string | null;
  createdBy: string | null;
  content: string;
  contentIsJson: boolean;
  contentHash: string;
  attempts: number;
};

type DerivationVerdict =
  | {
      status: "done" | "no_match" | "no_produces";
      detail: Record<string, unknown> | null;
      /** True ONLY for a fresh `done` create whose outbox row was already settled
       *  ATOMICALLY inside the write Tx2 (the residual-A fence) — the caller then
       *  skips finishOutbox. Absent/false ⇒ the caller settles via finishOutbox
       *  (no_match/no_produces, and the same-extension `done` dedupe). */
      alreadySettled?: boolean;
    }
  | { retryable: true; error: string }
  // The lease was reclaimed by another driver mid-write (the atomic done-settle's
  // guard raised, aborting the whole Tx): abort WITHOUT a further settle — the
  // reclaiming driver owns the derivation. Distinct from `retryable` (no error;
  // no re-throw).
  | { skip: true };

// ---------------------------------------------------------------------------
// Outbox lease store (real-store seam — no stubs).
// ---------------------------------------------------------------------------

/**
 * Atomically CLAIM the outbox row: `pending` (unclaimed) OR `deriving` with an
 * EXPIRED lease, and under the attempts cap, becomes `deriving` with a fresh
 * token + `attempts++`. Returns the row's derivation inputs on a win, else null
 * (missing / already-terminal / lease held by another driver / exhausted).
 */
async function claimOutboxLease(input: {
  runId: string;
  orgId: string;
  leaseToken: string;
  now: Date;
  leaseMs: number;
  maxAttempts: number;
}): Promise<LeasedOutboxRow | null> {
  ensurePostgresSchema();
  const s = schema();
  const expiry = new Date(input.now.getTime() + input.leaseMs);
  const res = await pool().query(
    `UPDATE "${s}"."agent_run_output_derivations"
        SET status = 'deriving', lease_token = $3, lease_expires_at = $4,
            attempts = attempts + 1, updated_at = $5
      WHERE run_id = $1 AND org_id = $2
        AND (status = 'pending' OR (status = 'deriving' AND lease_expires_at < $5))
        AND attempts < $6
    RETURNING run_id, org_id, template_id, package_version, created_by,
              content, content_is_json, content_hash, attempts`,
    [
      input.runId,
      input.orgId,
      input.leaseToken,
      expiry,
      input.now,
      input.maxAttempts,
    ],
  );
  const row = res.rows[0] as
    | {
        run_id: string;
        org_id: string;
        template_id: string;
        package_version: string | null;
        created_by: string | null;
        content: string;
        content_is_json: boolean;
        content_hash: string;
        attempts: number;
      }
    | undefined;
  if (!row) return null;
  return {
    runId: row.run_id,
    orgId: row.org_id,
    templateId: row.template_id,
    packageVersion: row.package_version,
    createdBy: row.created_by,
    content: row.content,
    contentIsJson: row.content_is_json,
    contentHash: row.content_hash,
    attempts: row.attempts,
  };
}

/** Write the terminal outcome, GUARDED by the held lease token (a driver whose
 *  lease was stolen by an expiry-reclaim writes zero rows and does not clobber
 *  the winner's decision). Clears the lease. */
async function finishOutbox(input: {
  runId: string;
  orgId: string;
  leaseToken: string;
  status: "done" | "no_match" | "no_produces";
  detail: Record<string, unknown> | null;
  now: Date;
}): Promise<boolean> {
  const s = schema();
  const res = await pool().query(
    `UPDATE "${s}"."agent_run_output_derivations"
        SET status = $4, detail = $5, lease_token = NULL, lease_expires_at = NULL,
            updated_at = $6
      WHERE run_id = $1 AND org_id = $2 AND lease_token = $3`,
    [
      input.runId,
      input.orgId,
      input.leaseToken,
      input.status,
      input.detail === null ? null : JSON.stringify(input.detail),
      input.now,
    ],
  );
  return (res.rowCount ?? 0) === 1;
}

/** Release the lease back to `pending` (a RETRYABLE mid-derive failure) so the
 *  next sweep re-drives — guarded by the held token. */
async function releaseOutboxLease(input: {
  runId: string;
  orgId: string;
  leaseToken: string;
  now: Date;
}): Promise<void> {
  const s = schema();
  await pool().query(
    `UPDATE "${s}"."agent_run_output_derivations"
        SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
            updated_at = $4
      WHERE run_id = $1 AND org_id = $2 AND lease_token = $3`,
    [input.runId, input.orgId, input.leaseToken, input.now],
  );
}

/**
 * WRITE FENCE (codex rounds 1-3, residual A). The MARKER a Tx2-composed
 * token-guarded `done`-settle raises when the lease was already reclaimed by
 * another driver — it aborts the WHOLE artifact-creation transaction, so a stale
 * driver's artifact is rolled back rather than persisted alongside the winner's.
 */
export const UNBOUND_OUTBOX_LEASE_LOST_MARKER = "unbound-output-lease-lost";

/** True when an error is the atomic done-settle's lease-lost guard firing. */
export function isUnboundOutboxLeaseLost(err: unknown): boolean {
  return err instanceof Error && err.message.includes(UNBOUND_OUTBOX_LEASE_LOST_MARKER);
}

/**
 * The token-guarded outbox `done`-settle, shaped as a Tx2 query so it commits
 * ATOMICALLY with the artifact + the ledger finalize (composed into
 * createSemanticArtifact's Tx2 via writeClaimedArtifact's `extraTx2Queries`).
 * This is the TRUE fence for residual A: the settle and the artifact write are
 * inseparable. If our lease was reclaimed (a different `lease_token`), the UPDATE
 * transitions zero rows and the `CASE` evaluates a failing cast that ABORTS Tx2 —
 * no artifact, no settle; the reclaiming driver owns the derivation. Mirrors the
 * ledger's `buildFinalizeMaterializationQuery` guard exactly (the CTE-dependent
 * subquery keeps the cast out of plan-time constant folding).
 */
function buildUnboundOutboxDoneTx2Query(input: {
  runId: string;
  orgId: string;
  leaseToken: string;
  detail: Record<string, unknown>;
  now: Date;
}): { text: string; values: unknown[] } {
  const s = schema();
  return {
    text: `WITH settled AS (
  UPDATE "${s}"."agent_run_output_derivations"
     SET status = 'done', detail = $3::jsonb, lease_token = NULL,
         lease_expires_at = NULL, updated_at = $4
   WHERE run_id = $1 AND org_id = $2 AND lease_token = $5
  RETURNING run_id
)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM settled) THEN 1
  ELSE ('${UNBOUND_OUTBOX_LEASE_LOST_MARKER}: lease lost before the atomic done-settle; rows=' || (SELECT count(*)::text FROM settled))::int
END`,
    values: [
      input.runId,
      input.orgId,
      JSON.stringify(input.detail),
      input.now,
      input.leaseToken,
    ],
  };
}

async function readTemplateNameAndPackage(
  templateId: string,
): Promise<{ name: string | null; packageName: string | null }> {
  ensurePostgresSchema();
  const s = schema();
  const res = await pool().query(
    `SELECT name, package_name FROM "${s}"."agent_templates" WHERE id = $1 LIMIT 1`,
    [templateId],
  );
  const row = res.rows[0] as
    | { name?: string | null; package_name?: string | null }
    | undefined;
  return {
    name: typeof row?.name === "string" ? row.name : null,
    packageName:
      typeof row?.package_name === "string" && row.package_name.length > 0
        ? row.package_name
        : null,
  };
}

// ---------------------------------------------------------------------------
// MIME selection — codex round-0: permit an EXACT MIME or text/plain only; never
// relabel bytes into a foreign text format (e.g. markdown as HTML/XML).
// ---------------------------------------------------------------------------
function pickDerivedWriteMime(
  contentIsJson: boolean,
  accepts: readonly string[],
): string | null {
  const candidates = contentIsJson
    ? ["application/json"]
    : ["text/markdown", "text/plain"];
  for (const m of candidates) if (accepts.includes(m)) return m;
  return null;
}

// ---------------------------------------------------------------------------
// Default classifier tiebreak (multi-produces only). Best-effort: routes the
// captured content through the objects classifier and keeps the result ONLY when
// it lands on one of the candidate produces types. No runtime / any error / a
// non-candidate result ⇒ null (the caller settles `no_match`). The single-produces
// path — the dominant case — never reaches this.
// ---------------------------------------------------------------------------
/**
 * The derivation worker's actor frame (codex round-1). `classifyObject`'s LLM
 * path resolves the runtime through `requireActorFrame`, which reads the ambient
 * `withActorContext` ALS frame. The UNBOUND_OUTPUT_DERIVE job runs with
 * `inheritActorContext: false` (it must not inherit the run principal), so the
 * background-jobs runner establishes NO frame — the multi-produces classifier
 * tiebreak MUST anchor its OWN org-scoped System frame (mirrors the artifact
 * matcher's `buildArtifactMatcherActorContext`) or every classify throws
 * `ACTOR_CONTEXT_MISSING` and silently settles `no_match`. Org-anchored so any
 * scope-filtered read the classifier makes stays tenant-correct.
 */
function buildDerivationActorContext(orgId: string): ActorContext {
  return {
    principalType: "System",
    principalId: "unbound-output-deriver",
    organizationId: orgId,
    teamIds: [],
    projectIds: [],
    authSource: "worker",
    policyVersion: "v2",
  };
}

const defaultClassify: UnboundDerivationClassify = async ({
  content,
  contentIsJson,
  candidateTypeIds,
}) => {
  const [{ classifyObject }, dbMod] = await Promise.all([
    import("@cinatra-ai/objects"),
    import("@/lib/database"),
  ]);
  let rawData: unknown;
  try {
    rawData = contentIsJson ? JSON.parse(content) : { content };
  } catch {
    rawData = { content };
  }
  const model = dbMod.readObjectsClassificationModelFromDatabase();
  // classifyObject THROWS on an infra failure (no LLM runtime configured, an
  // LLM/transport error, a missing actor frame). Codex round-1: do NOT swallow
  // those to `null` — a TRANSIENT failure must never become a PERMANENT no_match.
  // Let it propagate so the caller settles the row RETRYABLE (the sweep re-drives
  // until the attempts cap). `null` is returned ONLY for a SUCCESSFUL
  // classification that is a new type or lands OFF the declared-produces
  // candidate set — fail-closed: never guess a non-declared type (produces-only,
  // #1788).
  const out = await classifyObject(rawData, undefined, { model });
  if (!out || out.isNewType) return null;
  if (!candidateTypeIds.includes(out.type)) return null;
  return { objectTypeId: out.type, confidence: out.confidence };
};

// ---------------------------------------------------------------------------
// The typing seam: type one claimed outbox row against its run agent's produces.
// ---------------------------------------------------------------------------
async function deriveClaimedRow(
  row: LeasedOutboxRow,
  deps: UnboundDerivationDeps | undefined,
  lease: { leaseToken: string; now: () => Date },
): Promise<DerivationVerdict> {
  const ctx = await loadRunDerivationContext({
    templateId: row.templateId,
    packageVersion: row.packageVersion,
  });
  // Defensive: a bound run's output-wiring is the declarative binding path's
  // responsibility (the outbox captures every completion transaction-locally;
  // binding discovery is deferred to here). Settle it as done/bound WITHOUT a
  // second materialization.
  if (ctx.hasBindings) {
    return { status: "done", detail: { reason: "bound" } };
  }
  if (ctx.producesRefs.length === 0) {
    return { status: "no_produces", detail: null };
  }

  const byteLen = new TextEncoder().encode(row.content).byteLength;
  if (byteLen > MAX_AUTHORED_CONTENT_BYTES) {
    return {
      status: "no_match",
      detail: { reason: "content_too_large", bytes: byteLen },
    };
  }

  registerAllObjectTypes();

  // Resolve each declared produces ref to its artifact-safe target (the produces
  // objectTypeId pins the type; else the single-artifact-safe-type fallback).
  const targets: Array<{
    extension: string;
    objectTypeId: string;
    acceptedFileMimeTypes: string[];
  }> = [];
  for (const ref of ctx.producesRefs) {
    const producesObjectTypeId =
      ref.objectTypeId ??
      producesObjectTypeIdForExtension(ctx.producesRefs, ref.extension) ??
      undefined;
    const resolved = await resolveBoundArtifactTarget({
      orgId: row.orgId,
      extension: ref.extension,
      bindingObjectTypeId: undefined,
      producesObjectTypeId,
    });
    if (resolved.ok) {
      targets.push({ extension: ref.extension, ...resolved.target });
    }
  }
  if (targets.length === 0) {
    return {
      status: "no_match",
      detail: { reason: "no_artifact_safe_target" },
    };
  }

  // Choose the target: one produces ⇒ it; several ⇒ the classifier tiebreaks
  // among them (at/above threshold, landing on a candidate).
  let chosen: (typeof targets)[number];
  if (targets.length === 1) {
    chosen = targets[0];
  } else {
    const classify = deps?.classify ?? defaultClassify;
    let decision: { objectTypeId: string; confidence: number } | null;
    try {
      // Establish the org-scoped System actor frame so classifyObject's LLM path
      // resolves the runtime (requireActorFrame) instead of throwing
      // ACTOR_CONTEXT_MISSING (codex round-1). An injected test classify is a
      // harmless no-op inside the frame.
      decision = await withActorContext(
        buildDerivationActorContext(row.orgId),
        () =>
          classify({
            content: row.content,
            contentIsJson: row.contentIsJson,
            candidateTypeIds: targets.map((t) => t.objectTypeId),
          }),
      );
    } catch (err) {
      return {
        retryable: true,
        error: `classifier tiebreak failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!decision) {
      return { status: "no_match", detail: { reason: "classifier_unresolved" } };
    }
    if (decision.confidence < CLASSIFIER_CONFIDENCE_THRESHOLD) {
      return {
        status: "no_match",
        detail: { reason: "below_threshold", confidence: decision.confidence },
      };
    }
    const match = targets.find((t) => t.objectTypeId === decision!.objectTypeId);
    if (!match) {
      return {
        status: "no_match",
        detail: { reason: "classifier_off_candidate", picked: decision.objectTypeId },
      };
    }
    chosen = match;
  }

  const writeMime = pickDerivedWriteMime(
    row.contentIsJson,
    chosen.acceptedFileMimeTypes,
  );
  if (writeMime === null) {
    return {
      status: "no_match",
      detail: {
        reason: "mime_incompatible",
        contentIsJson: row.contentIsJson,
        accepts: chosen.acceptedFileMimeTypes,
      },
    };
  }

  const ownership = await resolveRunScopeOwnership({
    templateId: row.templateId,
    runId: row.runId,
    orgId: row.orgId,
  });
  const { name } = await readTemplateNameAndPackage(row.templateId);
  const title = `${name ?? "Agent"} output`;

  // Materialize through the standard writer (ledger claim → finalize atomic with
  // the artifact write; the 4-part identity + reserved sentinel output id ⇒
  // exactly once). WRITE FENCE (codex rounds 1-3, residual A): the token-guarded
  // outbox `done`-settle rides `extraTx2Queries`, so on a FRESH create the settle
  // commits ATOMICALLY with the artifact — if our lease was reclaimed mid-write,
  // the settle transitions zero rows, raises the lease-lost marker, and aborts the
  // WHOLE transaction (no artifact, no settle; the reclaiming driver owns it).
  // Infra failure THROWS → retryable re-drive; a validation refusal
  // (MIME/write-gate) is a TERMINAL no_match; the lease-lost marker ⇒ skip.
  const doneDetail = {
    extension: chosen.extension,
    objectTypeId: chosen.objectTypeId,
    mime: writeMime,
  };
  let write: Awaited<ReturnType<typeof writeClaimedArtifact>>;
  try {
    write = await writeClaimedArtifact({
      runId: row.runId,
      orgId: row.orgId,
      createdBy: row.createdBy,
      outputId: DERIVED_OUTPUT_LEDGER_OUTPUT_ID,
      nodeId: null,
      path: "derived_output",
      extension: chosen.extension,
      title,
      mime: writeMime,
      content: row.content,
      ownership,
      resolvedTarget: {
        objectTypeId: chosen.objectTypeId,
        acceptedFileMimeTypes: chosen.acceptedFileMimeTypes,
      },
      mimeDescription: "the derived output MIME",
      extraTx2Queries: (ids) => [
        buildUnboundOutboxDoneTx2Query({
          runId: row.runId,
          orgId: row.orgId,
          leaseToken: lease.leaseToken,
          now: lease.now(),
          detail: { ...doneDetail, ...ids },
        }),
      ],
    });
  } catch (err) {
    if (isUnboundOutboxLeaseLost(err)) return { skip: true };
    throw err; // infra failure → retryable
  }
  if (!write.ok) {
    return { status: "no_match", detail: { reason: "write_refused", error: write.error } };
  }
  if (write.deduped) {
    // A concurrent driver already materialized this EXACT identity (same run +
    // extension + content ⇒ same 4-part ledger key); our Tx2 (and its settle) did
    // NOT run. Same-extension dedupe ⇒ no split hazard; settle `done` via the
    // token-guarded finishOutbox instead.
    return {
      status: "done",
      detail: { ...doneDetail, ...write, deduped: true },
    };
  }
  // Fresh create: the outbox row was settled `done` ATOMICALLY inside the write
  // Tx2. Nothing more to settle.
  return {
    status: "done",
    alreadySettled: true,
    detail: {
      artifactId: write.artifactId,
      representationRevisionId: write.representationRevisionId,
      ...doneDetail,
      deduped: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Advisory channel — occurrence-deduped `info` notification (per run).
// ---------------------------------------------------------------------------
async function emitUnboundOutputAdvisory(
  row: LeasedOutboxRow,
  status: "no_match" | "no_produces",
): Promise<void> {
  try {
    const { createNotificationForRecipient } = await import("@/lib/notifications");
    const { name, packageName } = await readTemplateNameAndPackage(row.templateId);
    const label = name ?? "An agent run";
    const href = packageName
      ? buildAgentInstancePath(packageName, row.runId)
      : undefined;
    const body =
      status === "no_produces"
        ? `${label} produced an output that was not saved: the agent declares no output types to file it under. Add a \`produces\` declaration (or wire an output binding) to capture outputs automatically.`
        : `${label} produced an output that could not be matched to any of the agent's declared output types, so it was not saved. The output remains in the run history.`;
    await createNotificationForRecipient(
      row.createdBy
        ? { kind: "user", userId: row.createdBy }
        : { kind: "admins" },
      {
        kind: "info",
        title: "Agent output not captured",
        body,
        href,
        // Occurrence-deduped per run: a re-drive of the same run collapses to one
        // flyout row.
        dedupeKey: `unbound-output:${row.runId}`,
      },
    );
  } catch (err) {
    console.warn(
      `[unbound-output] advisory emit failed for run=${row.runId} (derivation already settled):`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------------------
// Public: derive ONE run's captured output.
// ---------------------------------------------------------------------------
export async function deriveUnboundRunOutput(
  input: { runId: string; orgId: string },
  deps?: UnboundDerivationDeps,
): Promise<{ outcome: UnboundDerivationOutcome }> {
  const now = deps?.now ?? (() => new Date());
  const leaseMs = deps?.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = deps?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const leaseToken = randomUUID();

  const row = await claimOutboxLease({
    runId: input.runId,
    orgId: input.orgId,
    leaseToken,
    now: now(),
    leaseMs,
    maxAttempts,
  });
  // No claim: the row is missing, already terminal, held by another driver, or
  // exhausted. Nothing to do (idempotent).
  if (!row) return { outcome: "skipped" };

  let verdict: DerivationVerdict;
  try {
    verdict = await deriveClaimedRow(row, deps, { leaseToken, now });
  } catch (err) {
    // Unexpected infra failure mid-derive: release the lease so a re-drive
    // retries, then surface as retryable.
    await releaseOutboxLease({
      runId: row.runId,
      orgId: row.orgId,
      leaseToken,
      now: now(),
    }).catch(() => undefined);
    throw new UnboundDerivationRetryableError(
      `derivation failed for run ${row.runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if ("retryable" in verdict) {
    await releaseOutboxLease({
      runId: row.runId,
      orgId: row.orgId,
      leaseToken,
      now: now(),
    }).catch(() => undefined);
    throw new UnboundDerivationRetryableError(verdict.error);
  }

  if ("skip" in verdict) {
    // The write fence tripped: the atomic done-settle found our lease reclaimed
    // and aborted the whole write Tx, so the reclaiming driver owns the
    // derivation. Do NOT finish or release — both are token-guarded to our
    // now-stale token and would no-op; leaving the row as the reclaimer left it
    // is correct.
    return { outcome: "skipped" };
  }

  if (verdict.status === "done" && verdict.alreadySettled) {
    // A fresh `done` create already settled the outbox row ATOMICALLY inside the
    // write Tx2 (the residual-A fence). Nothing more to persist.
    return { outcome: "done" };
  }

  const settled = await finishOutbox({
    runId: row.runId,
    orgId: row.orgId,
    leaseToken,
    status: verdict.status,
    detail: verdict.detail,
    now: now(),
  });
  // ONLY the driver that still holds the lease (settled) owns the outcome + its
  // advisory (codex round-1). A driver whose lease was reclaimed by an
  // expiry-sweep wrote zero rows here; the reclaiming driver settles the row and
  // emits the advisory, so a stale driver must not emit a duplicate/contradictory
  // one — and must report `skipped`, not a terminal outcome it did not persist.
  if (!settled) return { outcome: "skipped" };
  if (verdict.status === "no_match" || verdict.status === "no_produces") {
    await emitUnboundOutputAdvisory(row, verdict.status);
  }
  return { outcome: verdict.status };
}

// ---------------------------------------------------------------------------
// Public: reconciliation sweep — the backstop for outbox rows whose one-shot
// enqueue was lost / crashed, and for leases stranded by a crashed driver.
// Converges: a settled row (done/no_match/no_produces) is never re-selected.
// ---------------------------------------------------------------------------
export type UnboundDerivationSweepSummary = {
  attempted: number;
  done: number;
  no_match: number;
  no_produces: number;
  skipped: number;
  failed: number;
};

export async function sweepPendingUnboundDerivations(
  deps?: UnboundDerivationDeps & { batch?: number },
): Promise<UnboundDerivationSweepSummary> {
  ensurePostgresSchema();
  const s = schema();
  const now = deps?.now ?? (() => new Date());
  const maxAttempts = deps?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const batch = deps?.batch ?? SWEEP_BATCH;
  const candidates = await pool().query(
    `SELECT run_id, org_id
       FROM "${s}"."agent_run_output_derivations"
      WHERE (status = 'pending' OR (status = 'deriving' AND lease_expires_at < $1))
        AND attempts < $2
      ORDER BY created_at ASC
      LIMIT $3`,
    [now(), maxAttempts, batch],
  );
  const summary: UnboundDerivationSweepSummary = {
    attempted: 0,
    done: 0,
    no_match: 0,
    no_produces: 0,
    skipped: 0,
    failed: 0,
  };
  for (const c of candidates.rows as Array<{ run_id: string; org_id: string }>) {
    summary.attempted += 1;
    try {
      const { outcome } = await deriveUnboundRunOutput(
        { runId: c.run_id, orgId: c.org_id },
        deps,
      );
      summary[outcome] += 1;
    } catch (err) {
      // A retryable failure (or any throw): count it and continue — one poison
      // row must never abort the sweep. The lease was released; a later sweep
      // retries until the attempts cap.
      summary.failed += 1;
      console.warn(
        `[unbound-output-sweep] run=${c.run_id} failed (will retry until cap):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return summary;
}
