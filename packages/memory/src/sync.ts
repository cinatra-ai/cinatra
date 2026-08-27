/**
 * `memory sync` — one-way, local bundle → `objects` rows.
 *
 * The direction is the design (epic #1373). Nothing here reads a row back into
 * a file, deletes a remote row, or narrows one. Concretely:
 *
 *  - **The bundle is never written.** A sync run touches exactly one file, the
 *    sync ledger, and only after a write it actually made. A `--dry-run`
 *    touches nothing at all.
 *  - **No remote deletion, ever.** A ledger entry whose file is gone is
 *    reported as an orphan and left alone. Deletion arrives later as an
 *    explicit, previewed operation; it is not something a sync run does by
 *    noticing an absence.
 *  - **No narrowing.** Ownership and visibility are sent ONLY for a row this
 *    run creates. For a row that already exists they are omitted, so
 *    `objects_save`'s `ON CONFLICT` arm preserves whatever the row carries —
 *    including a scope that promotion widened after the last sync.
 *
 * Classification is a preflight (`objects_list` by `externalId`, batched)
 * read alongside the local content-hash ledger. A concept whose stored
 * envelope already digests to the local content is SKIPPED with no write at
 * all, so an unchanged bundle produces no version churn and no history rows.
 * The preflight is what DECIDES; the ledger records what the last run pushed
 * and reports a row that drifted since, but it never suppresses a write the
 * preflight says is needed.
 */
import { loadMemoryBundle } from "./bundle.ts";
import { scanMemoryConceptForSecrets } from "./secret-scan.ts";
import {
  memoryVisibilityRank,
  resolveMemoryConceptScopeRequest,
} from "./sync-binding.ts";
import {
  buildMemoryConceptEnvelope,
  memoryConceptContentDigest,
  remoteMemoryConceptDigest,
  MEMORY_CONCEPT_TYPE_ID,
  type MemoryConceptEnvelope,
} from "./sync-envelope.ts";
import {
  emptyMemorySyncLedger,
  loadMemorySyncLedger,
  writeMemorySyncLedger,
} from "./sync-ledger.ts";
import type { MemorySyncTransport } from "./sync-transport.ts";
import {
  MemorySyncError,
  type MemoryBundle,
  type MemoryScopeRequest,
  type MemorySyncDiagnostic,
  type MemorySyncItem,
  type MemorySyncLedger,
  type MemorySyncOrphan,
  type MemorySyncPlan,
  type MemorySyncResult,
} from "./types.ts";

/** Identity the sync run declares as client-side provenance. */
export const MEMORY_SYNC_TOOL_ID = "@cinatra-ai/memory:sync";
export const MEMORY_SYNC_TOOL_VERSION = "0.1.0";

/**
 * How many `externalId`s one preflight call carries.
 *
 * `objects_list` caps `limit` at 500 and caps the `externalIds` batch at the
 * same number, so a batch that asked for more than it could receive would
 * silently look like "those rows do not exist" — the one misreading that turns
 * a skip into a duplicate write. Batches are therefore sized to the cap.
 */
export const MEMORY_SYNC_PREFLIGHT_BATCH = 500;

/** One row as the preflight learned it. */
interface PreflightRow {
  objectId: string;
  digest: string | null;
  ownerLevel?: string;
  ownerId?: string;
  visibility?: string;
  projectId?: string | null;
}

/** What `planMemorySync` needs, with the remote half already resolved. */
export interface MemorySyncPlanInput {
  bundle: MemoryBundle;
  ledger: MemorySyncLedger;
  /** `externalId` → the row the preflight found. Absent = no visible row. */
  remote: Map<string, PreflightRow>;
}

/**
 * Classify every concept in the bundle, plus the ledger's orphans.
 *
 * Pure: no network, no filesystem, no clock. The two inputs it decides on —
 * the local bundle and the preflight — are both handed in, so the whole
 * classification is a unit-testable function and `--dry-run` is exactly this
 * function with the write loop skipped.
 */
export function planMemorySync(input: MemorySyncPlanInput): MemorySyncPlan {
  const { bundle, ledger, remote } = input;
  const bundleId = bundle.config.bundleId;
  const items: MemorySyncItem[] = [];
  const diagnostics: MemorySyncDiagnostic[] = [];
  const livePaths = new Set<string>();

  for (const concept of bundle.concepts) {
    livePaths.add(concept.path);
    const envelope = buildMemoryConceptEnvelope(bundleId, concept, {
      tool: MEMORY_SYNC_TOOL_ID,
      toolVersion: MEMORY_SYNC_TOOL_VERSION,
    });
    const conceptDiagnostics: MemorySyncDiagnostic[] = [];

    // Secret scan FIRST. A concept that carries a credential-shaped literal is
    // blocked before it is classified, so it never reaches a batch, a
    // transport, or the ledger. The scan is fail-closed: a scan that could not
    // complete blocks the concept exactly like a hit.
    const secretFindings = scanMemoryConceptForSecrets(concept);
    if (secretFindings.length > 0) {
      conceptDiagnostics.push(...secretFindings);
      diagnostics.push(...secretFindings);
      items.push({
        path: concept.path,
        conceptId: concept.id,
        externalId: envelope.externalId,
        action: "blocked",
        reason: secretFindings[0]?.message ?? "refused by the local secret scan",
        diagnostics: conceptDiagnostics,
      });
      continue;
    }

    const localDigest = memoryConceptContentDigest(envelope);
    const row = remote.get(envelope.externalId);

    if (row === undefined) {
      // Nothing visible remotely. That is either "not synced yet" or "synced
      // into a row this caller can no longer read" — indistinguishable on
      // purpose, because the read gate must not be an existence oracle. Both
      // resolve to a create attempt, and a create that collides with a row the
      // caller cannot touch is refused server-side, not silently merged.
      items.push({
        path: concept.path,
        conceptId: concept.id,
        externalId: envelope.externalId,
        action: "create",
        reason: "no matching row in the preflight",
        diagnostics: conceptDiagnostics,
      });
      continue;
    }

    const scopeRequest = resolveMemoryConceptScopeRequest(bundle.config.sync, concept);
    if (
      scopeRequest.visibility !== undefined &&
      memoryVisibilityRank(row.visibility) > memoryVisibilityRank(scopeRequest.visibility)
    ) {
      const note: MemorySyncDiagnostic = {
        severity: "info",
        code: "scope-preserved",
        path: concept.path,
        message: `the existing row is ${row.visibility}, wider than the requested ${scopeRequest.visibility}; sync preserves it and never narrows a row`,
      };
      conceptDiagnostics.push(note);
      diagnostics.push(note);
    }
    const boundProjectId = bundle.config.sync?.projectId;
    if (
      boundProjectId !== undefined &&
      row.projectId !== undefined &&
      row.projectId !== null &&
      row.projectId !== boundProjectId
    ) {
      const note: MemorySyncDiagnostic = {
        severity: "warning",
        code: "project-binding-conflict",
        path: concept.path,
        message: `the existing row is bound to a different project than the bundle's sync.projectId; moving a row is an audited operation sync does not perform`,
      };
      conceptDiagnostics.push(note);
      diagnostics.push(note);
    }

    // The PREFLIGHT alone decides skip-vs-update for a row it found, and the
    // ledger can never overrule it.
    //
    // An earlier shape let a matching ledger entry skip a concept even when
    // the preflight had positively reported different content, on the theory
    // that the ledger saves churn. It does not: it LOSES a write. If anything
    // changed the row after the last sync — an older tool, a different client,
    // a partial write — the ledger still records the digest THIS bundle last
    // pushed, so the run would skip forever and the local truth would never be
    // restored. A ledger is bookkeeping about the past; only the preflight
    // knows the present.
    //
    // The ledger's disagreement is still worth SAYING, so a drifted row is
    // reported rather than silently rewritten.
    const ledgerDigest = ledger.entries[concept.path]?.sha256;
    if (row.digest !== null && row.digest === localDigest) {
      items.push({
        path: concept.path,
        conceptId: concept.id,
        externalId: envelope.externalId,
        action: "skip",
        reason: "the stored row already carries this exact content",
        objectId: row.objectId,
        diagnostics: conceptDiagnostics,
      });
      continue;
    }
    if (ledgerDigest === localDigest) {
      const note: MemorySyncDiagnostic = {
        severity: "warning",
        code: "ledger-stale",
        path: concept.path,
        message:
          "the ledger records this content as already synced, but the stored row no longer carries it; the row changed after the last sync and this run rewrites it from the local file",
      };
      conceptDiagnostics.push(note);
      diagnostics.push(note);
    }
    items.push({
      path: concept.path,
      conceptId: concept.id,
      externalId: envelope.externalId,
      action: "update",
      reason:
        row.digest === null
          ? "the stored row is not envelope-shaped"
          : "the local file differs from the stored row",
      objectId: row.objectId,
      diagnostics: conceptDiagnostics,
    });
  }

  // Orphans: the ledger says a concept was synced, the file is gone. Reported,
  // never acted on — sync performs no remote deletion in any form.
  const orphans: MemorySyncOrphan[] = [];
  for (const [path, entry] of Object.entries(ledger.entries)) {
    if (livePaths.has(path)) continue;
    const conceptId = path.endsWith(".md") ? path.slice(0, -3) : path;
    orphans.push({ path, conceptId, objectId: entry.objectId });
    diagnostics.push({
      severity: "info",
      code: "orphan-retained",
      path,
      message:
        "the local file is gone; the remote row is retained — sync never deletes a row for a missing file",
    });
  }
  orphans.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { bundleId, items, orphans, diagnostics };
}

/**
 * Run the remote preflight: a batched `objects_list` keyed on `externalId`.
 *
 * The list is per-row `object.read`-gated server-side, so a row the caller
 * cannot read simply is not in the answer — the same shape as "there is no
 * such row". That is what keeps the preflight from being an existence oracle,
 * and it is why an absent row classifies as a create attempt rather than as a
 * silent merge.
 */
async function runMemorySyncPreflight(
  transport: MemorySyncTransport,
  externalIds: string[],
  projectId: string | undefined,
): Promise<Map<string, PreflightRow>> {
  const out = new Map<string, PreflightRow>();
  for (let i = 0; i < externalIds.length; i += MEMORY_SYNC_PREFLIGHT_BATCH) {
    const batch = externalIds.slice(i, i + MEMORY_SYNC_PREFLIGHT_BATCH);
    const result = await transport.callTool("objects_list", {
      type: MEMORY_CONCEPT_TYPE_ID,
      externalIds: batch,
      limit: MEMORY_SYNC_PREFLIGHT_BATCH,
      ...(projectId === undefined ? {} : { projectId }),
    });
    const items =
      result !== null && typeof result === "object" && Array.isArray((result as Record<string, unknown>)["items"])
        ? ((result as Record<string, unknown>)["items"] as unknown[])
        : [];
    for (const entry of items) {
      if (entry === null || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const data = row["data"];
      const externalId =
        data !== null && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>)["externalId"]
          : undefined;
      if (typeof externalId !== "string" || typeof row["id"] !== "string") continue;
      out.set(externalId, {
        objectId: row["id"],
        digest: remoteMemoryConceptDigest(data),
        ...(typeof row["ownerLevel"] === "string" ? { ownerLevel: row["ownerLevel"] } : {}),
        ...(typeof row["ownerId"] === "string" ? { ownerId: row["ownerId"] } : {}),
        ...(typeof row["visibility"] === "string" ? { visibility: row["visibility"] } : {}),
        ...("projectId" in row
          ? { projectId: typeof row["projectId"] === "string" ? row["projectId"] : null }
          : {}),
      });
    }
  }
  return out;
}

/**
 * Build the `objects_save` input for one item.
 *
 * `ownerLevel` / `ownerId` / `visibility` ride ONLY on a create. On an update
 * they are omitted so the writer's `ON CONFLICT` arm preserves the row's
 * stored tuple; sending them would either be a no-op or — if the row had been
 * promoted since the last sync — a refused scope change. Omission is the
 * behaviour that lets a promoted row stay promoted through every resync.
 *
 * `projectId` rides on BOTH, when the bundle binds one. On an update that is
 * deliberate: if the row has since moved to another project, the explicit
 * binding makes the server refuse loudly with the move path named, instead of
 * the run quietly writing into a room it no longer belongs to.
 */
export function buildMemorySaveInput(
  envelope: MemoryConceptEnvelope,
  scopeRequest: MemoryScopeRequest,
  projectId: string | undefined,
  isCreate: boolean,
): Record<string, unknown> {
  return {
    typeHint: MEMORY_CONCEPT_TYPE_ID,
    rawData: envelope as unknown as Record<string, unknown>,
    ...(projectId === undefined ? {} : { projectId }),
    ...(isCreate
      ? {
          ...(scopeRequest.ownerLevel === undefined ? {} : { ownerLevel: scopeRequest.ownerLevel }),
          ...(scopeRequest.ownerId === undefined ? {} : { ownerId: scopeRequest.ownerId }),
          ...(scopeRequest.visibility === undefined ? {} : { visibility: scopeRequest.visibility }),
        }
      : {}),
  };
}

/** Options for {@link runMemorySync}. */
export interface RunMemorySyncOptions {
  /** Absolute path of the bundle root. */
  root: string;
  transport: MemorySyncTransport;
  /** Classify and report only. No tool call that writes, no ledger write. */
  dryRun?: boolean;
}

/**
 * Classify the bundle, then (unless `dryRun`) write the create/update items.
 *
 * A per-concept refusal is recorded as a `server-refused` diagnostic and the
 * run continues: one rejected concept must not strand the rest of a bundle.
 * The refusals this path produces are terminal by contract, so nothing is
 * retried under the authorization it already failed.
 */
export async function runMemorySync(
  options: RunMemorySyncOptions,
): Promise<MemorySyncResult> {
  const bundle = loadMemoryBundle(options.root);
  const bundleId = bundle.config.bundleId;
  const ledger = loadMemorySyncLedger(options.root, bundleId);

  const externalIds = bundle.concepts.map((concept) =>
    buildMemoryConceptEnvelope(bundleId, concept, {
      tool: MEMORY_SYNC_TOOL_ID,
      toolVersion: MEMORY_SYNC_TOOL_VERSION,
    }).externalId,
  );
  const remote = await runMemorySyncPreflight(
    options.transport,
    externalIds,
    bundle.config.sync?.projectId,
  );
  const plan = planMemorySync({ bundle, ledger, remote });

  const result: MemorySyncResult = {
    plan,
    created: 0,
    updated: 0,
    skipped: plan.items.filter((i) => i.action === "skip").length,
    blocked: plan.items.filter((i) => i.action === "blocked").length,
    failed: 0,
    diagnostics: [],
  };
  if (options.dryRun) return result;

  const conceptsByPath = new Map(bundle.concepts.map((c) => [c.path, c]));
  const nextLedger: MemorySyncLedger = {
    ...emptyMemorySyncLedger(bundleId),
    entries: { ...ledger.entries },
  };
  let ledgerDirty = false;

  for (const item of plan.items) {
    if (item.action !== "create" && item.action !== "update") continue;
    const concept = conceptsByPath.get(item.path);
    if (concept === undefined) continue;
    const envelope = buildMemoryConceptEnvelope(bundleId, concept, {
      tool: MEMORY_SYNC_TOOL_ID,
      toolVersion: MEMORY_SYNC_TOOL_VERSION,
    });
    const scopeRequest = resolveMemoryConceptScopeRequest(bundle.config.sync, concept);
    const input = buildMemorySaveInput(
      envelope,
      scopeRequest,
      bundle.config.sync?.projectId,
      item.action === "create",
    );
    let saved: unknown;
    try {
      saved = await options.transport.callTool("objects_save", input);
    } catch (error) {
      result.failed += 1;
      const diagnostic: MemorySyncDiagnostic = {
        severity: "error",
        code: "server-refused",
        path: item.path,
        message: error instanceof Error ? error.message : String(error),
      };
      result.diagnostics.push(diagnostic);
      item.diagnostics.push(diagnostic);
      continue;
    }
    if (item.action === "create") result.created += 1;
    else result.updated += 1;
    const objectId =
      saved !== null && typeof saved === "object" && typeof (saved as Record<string, unknown>)["objectId"] === "string"
        ? ((saved as Record<string, unknown>)["objectId"] as string)
        : item.objectId;
    if (objectId !== undefined) {
      nextLedger.entries[item.path] = {
        sha256: memoryConceptContentDigest(envelope),
        objectId,
      };
      ledgerDirty = true;
    }
  }

  // The ledger is written only when a write actually landed. A run that
  // classified everything as skip leaves the bundle directory byte-identical.
  if (ledgerDirty) writeMemorySyncLedger(options.root, nextLedger);
  return result;
}

/** Guard used by the CLI: a transport is required for a non-dry run. */
export function assertMemorySyncTransport(
  transport: MemorySyncTransport | undefined,
): asserts transport is MemorySyncTransport {
  if (transport === undefined) {
    throw new MemorySyncError(
      "no MCP endpoint configured; pass --url or set CINATRA_MCP_URL (and CINATRA_MCP_TOKEN)",
    );
  }
}
