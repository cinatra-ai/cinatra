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
  memoryConceptScopeRefusals,
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
 * Every local refusal for a bundle, keyed by concept path.
 *
 * Two sources, both fail-closed: the credential scan, and the frontmatter scope
 * keys a concept may not carry (`ownerId` — see `memoryConceptScopeRefusals`).
 * A concept with an entry here is blocked; the map is what
 * {@link runMemorySync} computes before it builds the preflight batch.
 */
export function scanMemoryBundleLocally(
  bundle: MemoryBundle,
): Map<string, MemorySyncDiagnostic[]> {
  const out = new Map<string, MemorySyncDiagnostic[]>();
  for (const concept of bundle.concepts) {
    const findings: MemorySyncDiagnostic[] = [...scanMemoryConceptForSecrets(concept)];
    for (const { key, reason } of memoryConceptScopeRefusals(concept)) {
      findings.push({
        severity: "error",
        code: "scope-key-refused",
        path: concept.path,
        message: `frontmatter.${key} is not accepted — ${reason}`,
      });
    }
    if (findings.length > 0) out.set(concept.path, findings);
  }
  return out;
}

/**
 * Classify every concept in the bundle, plus the ledger's orphans.
 *
 * Pure: no network, no filesystem, no clock. The two inputs it decides on —
 * the local bundle and the preflight — are both handed in, so the whole
 * classification is a unit-testable function and `--dry-run` is exactly this
 * function with the write loop skipped.
 *
 * The local scan (cinatra#1378 review item 12) always runs fresh, computed
 * from `input.bundle` alone. An earlier shape took the blocked-concept map as
 * an optional PUBLIC field a caller could supply — including an empty one,
 * which reclassified a credential-carrying concept as `create` with zero
 * diagnostics (round-2 item 5). A fail-closed local guard whose result a
 * caller can hand it is not fail-closed at the API boundary, so the
 * computation moved inside the function, where nothing outside this module
 * can override it. {@link runMemorySync} needs the same map a step earlier —
 * to keep a blocked concept's key out of the preflight batch — and gets it
 * from {@link scanMemoryBundleLocally} directly rather than through here.
 */
export function planMemorySync(input: MemorySyncPlanInput): MemorySyncPlan {
  return planMemorySyncClassified(input, scanMemoryBundleLocally(input.bundle));
}

/**
 * {@link planMemorySync}'s classification, taking the local-scan result as a
 * parameter instead of recomputing it. NOT exported: the only caller that may
 * hand in a map computed elsewhere is {@link runMemorySync}, which needs the
 * exact map it already used to build the preflight batch, and it is not a
 * public seam a caller from outside this module can reach.
 */
function planMemorySyncClassified(
  input: MemorySyncPlanInput,
  blocked: Map<string, MemorySyncDiagnostic[]>,
): MemorySyncPlan {
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

    // Local refusals FIRST, and they were computed BEFORE the preflight ran
    // (cinatra#1378 review item 12): a concept that carries a credential-shaped
    // literal is blocked before its key is put in a batch, so it never reaches
    // a batch, a transport, or the ledger. The scan is fail-closed — a scan
    // that could not complete blocks the concept exactly like a hit.
    const secretFindings = blocked.get(concept.path) ?? [];
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
    // STRICT (cinatra#1378 review item 10). A result this code cannot read is
    // NOT "no such row": read that way, every concept classifies as `create`
    // and the run duplicates the whole bundle. An unreadable answer is an
    // unreadable answer, and it aborts the run.
    if (
      result === null ||
      typeof result !== "object" ||
      !Array.isArray((result as Record<string, unknown>)["items"])
    ) {
      throw new MemorySyncError(
        "objects_list: the preflight answer carried no `items` array; the run was stopped rather than reading an unreadable response as \"no such row\"",
      );
    }
    const items = (result as Record<string, unknown>)["items"] as unknown[];
    for (const entry of items) {
      if (entry === null || typeof entry !== "object") {
        throw new MemorySyncError(
          "objects_list: the preflight answer carried a row that is not an object",
        );
      }
      const row = entry as Record<string, unknown>;
      const data = row["data"];
      const externalId =
        data !== null && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>)["externalId"]
          : undefined;
      // NON-EMPTY, not just present (cinatra#1378 round-2 item 2): an empty
      // string satisfies `typeof x === "string"` and used to be accepted,
      // keying the row into the remote map under `""` — indistinguishable from
      // no such row, so the concept it belonged to never matched and classified
      // `create` instead of the update it should have been.
      if (
        typeof externalId !== "string" ||
        externalId === "" ||
        typeof row["id"] !== "string" ||
        row["id"] === ""
      ) {
        throw new MemorySyncError(
          "objects_list: the preflight answer carried a row without a non-empty `id` and `data.externalId`",
        );
      }
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
 * `ownerLevel` / `visibility` ride ONLY on a create. On an update they are
 * omitted so the writer's `ON CONFLICT` arm preserves the row's stored tuple;
 * sending them would either be a no-op or — if the row had been promoted since
 * the last sync — a refused scope change. Omission is the behaviour that lets a
 * promoted row stay promoted through every resync.
 *
 * `ownerId` is never sent at all (cinatra#1378 review item 4): the owning
 * principal is derived from the authenticated caller server-side, and a memory
 * bundle is an untrusted file that may not name one.
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

  // LOCAL SCAN FIRST (cinatra#1378 review item 12).
  //
  // The order used to be preflight-then-scan, which made the comment on the
  // scan ("it never reaches a batch, a transport") false: a concept the local
  // scan would block had already had its key sent to the server. The content
  // never left the machine, so it was not a leak — but it also meant the local
  // diagnostic this feature is built around could not be produced without a
  // reachable endpoint, because the run threw in the preflight first.
  //
  // Scanning first fixes both. A blocked concept's key is excluded from the
  // batch, and a bundle whose concepts are ALL blocked makes no tool call at
  // all, so the diagnostic is produced with no server in reach.
  const blocked = scanMemoryBundleLocally(bundle);
  const externalIds = bundle.concepts
    .filter((concept) => !blocked.has(concept.path))
    .map(
      (concept) =>
        buildMemoryConceptEnvelope(bundleId, concept, {
          tool: MEMORY_SYNC_TOOL_ID,
          toolVersion: MEMORY_SYNC_TOOL_VERSION,
        }).externalId,
    );
  const remote =
    externalIds.length === 0
      ? new Map<string, PreflightRow>()
      : await runMemorySyncPreflight(
          options.transport,
          externalIds,
          bundle.config.sync?.projectId,
        );
  const plan = planMemorySyncClassified({ bundle, ledger, remote }, blocked);

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
  let loopCompleted = false;

  try {
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
      // STRICT (cinatra#1378 review item 10). A call that did not throw is not
      // yet a write: `objects_save` answers with the row it wrote, and a result
      // carrying no `objectId` means this code cannot say what happened. Counting
      // it as created/updated would record a fact about the store that nothing
      // established, and would write a ledger entry pointing at a row id this run
      // never saw. The run stops instead.
      //
      // The ledger for the writes that DID land is flushed first (the `finally`
      // below), so an abort here never loses the bookkeeping for work already
      // done — a lost ledger entry is a duplicate write on the next run.
      // NON-EMPTY, not just present (cinatra#1378 round-2 item 2): a save
      // answering `{ objectId: "" }` used to satisfy `typeof x === "string"`
      // and complete, writing a ledger entry pointing at `""` — the exact
      // "row this run never saw" outcome the comment below forbids.
      const rawObjectId =
        saved !== null && typeof saved === "object"
          ? (saved as Record<string, unknown>)["objectId"]
          : undefined;
      const objectId =
        typeof rawObjectId === "string" && rawObjectId !== "" ? rawObjectId : undefined;
      if (objectId === undefined) {
        throw new MemorySyncError(
          `objects_save: the answer for ${item.path} carried no non-empty \`objectId\`; the run was stopped rather than recording an unconfirmed write`,
        );
      }
      if (item.action === "create") result.created += 1;
      else result.updated += 1;
      nextLedger.entries[item.path] = {
        sha256: memoryConceptContentDigest(envelope),
        objectId,
      };
      ledgerDirty = true;
    }
    loopCompleted = true;
  } finally {
    // The ledger is written only when a write actually landed, and it is
    // written even when the loop aborts on a malformed answer: a ledger entry
    // that was earned and then dropped becomes a duplicate write next run. A
    // run that classified everything as skip leaves the bundle directory
    // byte-identical.
    if (ledgerDirty) {
      if (loopCompleted) {
        writeMemorySyncLedger(options.root, nextLedger);
      } else {
        // Unwinding an abort. A ledger write that fails HERE would replace the
        // error the caller actually needs to see with a filesystem message
        // about bookkeeping, so the write is attempted and its own failure is
        // dropped. Losing the ledger costs a redundant write next run; losing
        // the abort's reason costs the author the diagnosis.
        try {
          writeMemorySyncLedger(options.root, nextLedger);
        } catch {
          // deliberately swallowed — see above
        }
      }
    }
  }

  return result;
}
