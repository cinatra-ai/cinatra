// Run-scoped campaign-recipients-review PERSIST primitive (cinatra#1960) — the
// recipients analogue of ./drafts-persist-handler (cinatra#1959), kept as its own
// module for the file-size ratchet. Intra-package import cycle with ./handlers is
// intentional and safe: the shared helpers are hoisted declarations referenced
// only at call time (the ./test-delivery-handlers / ./drafts-persist-handler
// precedent).
//
// email_outreach_recipients_update — the REAL run-scoped write the re-entrant
// campaign-recipients review gate's post-resume `apply` ApiNode dispatches
// (A-ii). It closes the "silent drop" the #1625 ruling recorded for the recipient
// stage-action mutations (`email_outreach_recipients_confirm` /
// `email_outreach_recipients_clear`): the pack renderer emits the operator's
// EXPLICIT removals into the gate's `userResponse`, the passthrough seam parses
// that into a `removedRecipients[]` batch, and this primitive removes exactly
// those rows from the run's own `@cinatra-ai/campaigns:recipients` bundle object.
//
// EXPLICIT-REMOVAL (NON-DESTRUCTIVE) SEMANTICS (codex #1960 round-1 findings 1+2).
// The primitive removes ONLY the rows the operator explicitly removed (matched
// one-to-one onto stored rows); every other stored row is KEPT. Consequences:
//   - an empty / absent removal batch is a NON-DESTRUCTIVE no-op — parity with the
//     drafts primitive, where absent edits leave the bundle untouched. A stray
//     self-MCP `email_outreach_recipients_update({})` from the generating LLM
//     therefore CANNOT erase the bundle before the operator approves (finding 1).
//   - a stored row the operator never SAW (present in the latest bundle but not in
//     the gate snapshot — a retry / concurrent write / save-return divergence) is
//     never in the removal batch, so it is never silently deleted (finding 2).
//
// DESIGN (a) — PRE-GATE PERSIST (cinatra#1959 stage-0 dataflow decision, reused
// here). The `generate` LLM node writes the recipient bundle to the run's objects
// store (objects_save, run-tagged) BEFORE the approval gate, so a removal batch
// against a missing bundle is genuine corruption and fails closed. The ONE benign
// exception (finding 3): a legitimate zero-recipient run whose generate early-exit
// produced no bundle AND whose operator removed nothing — that returns an empty
// reviewed set so the run completes.
//
// On every ok path it returns the AUTHORITATIVE reviewed content —
// `reviewedRecipients` (the KEPT stored rows, full content preserved) +
// `reviewedCount` — which the agent OAS wires into the EndNode terminal
// `confirmedRecipients` / `recipientCount` outputs, so a downstream consumer
// (email-drafting) sees the REVIEWED recipients, never the pre-gate generated set.
//
// TRUST MODEL — identical to ./drafts-persist-handler and the #1794 HITL prompt
// primitives: run, declaring package, and actor are all derived from the
// invocation frame, NEVER caller input.
//   - runId          ← the VERIFIED run scope on the ambient MCP frame
//                      (`verifiedRunScopeId` / an agent-run OBO delegation); a
//                      caller `runId` is ignored.
//   - declaring pkg  ← the run's own template.packageName, matched against the
//                      REGISTRY set of packages that declare a `campaign-
//                      recipients-review` mid-run HITL gate (from the manifest,
//                      never a hardcoded package name — the coupling-ban).
//   - actor          ← `request.actor`, gated by `enforceRunAccess`
//                      ("respondToHitl").
// Absent run context ⇒ fail closed.

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { createSessionObjectsClient } from "@cinatra-ai/objects";
import { AuthzError, logAuditEvent, POLICY_VERSION, type AuditEventInput } from "@/lib/authz";
import { buildActorContextFromRun } from "@/lib/authz/build-actor-context-from-run";
import {
  readAgentRunById,
  readAgentTemplateById,
  readRunCoOwners,
} from "../store";
import { enforceRunAccess } from "../auth-policy";
import {
  authzErrorToResponse,
  resolveRoleHintsFromSession,
  resolveRunScopedRunId,
  type PrimitiveRequest,
} from "./handlers";

// The renderer KIND whose mid-run HITL gate this persist wrapper serves. A
// renderer-KIND contract id (not a package name) — the #1854 A3 registry-routed
// precedent, honoured by ./test-delivery-handlers + ./drafts-persist-handler.
const RECIPIENTS_REVIEW_RENDERER_KIND = "campaign-recipients-review";

// Defensive bound on a single removal batch (a campaign's recipient set is capped
// at maxRecipients — a generous ceiling that rejects a pathological payload).
const RECIPIENTS_PERSIST_MAX_BATCH = 5000;

// The set of packages whose run may invoke this persist primitive: the id-SCOPE
// of every registry binding of kind `campaign-recipients-review` that flags a
// mid-run HITL gate (the pack-served re-entrant gate — NOT the reviewer
// `:contacts-output` / agent `:output` bindings, which carry no `midRunHitl`).
// Derived from the manifest, never a hardcoded package name.
// field-renderer-bindings.server is imported LAZILY so its filesystem-scanning
// graph stays off handlers.ts's eager import cycle.
async function resolveRecipientsReviewDeclaringPackages(): Promise<Set<string>> {
  const { getMergedFieldRendererBindings } = await import("../field-renderer-bindings.server");
  return new Set(
    getMergedFieldRendererBindings()
      .filter((b) => b.kind === RECIPIENTS_REVIEW_RENDERER_KIND && b.midRunHitl === true)
      // The binding id is `@scope/package:local-id`; the package scope IS the
      // declaring agent (the pack DECLARES the component under the agent's id).
      .map((b) => b.id.split(":")[0])
      .filter((pkg) => pkg.length > 0),
  );
}

// ---------------------------------------------------------------------------
// Payload shape (post-passthrough-shaper). The gate's single string output
// `userResponse` is a JSON object the seam parses; only `removedRecipients[]`
// (the operator's EXPLICIT removals) is read here (campaignId/approved* are
// informational — scope comes from the run frame, never the payload).
// ---------------------------------------------------------------------------
type RemovedRecipientInput = {
  id?: unknown;
  contactId?: unknown;
  accountId?: unknown;
  recipientId?: unknown;
  startupId?: unknown;
  recipientEmail?: unknown;
  email?: unknown;
};

// A removal's match identity. Keyed ONLY by contactId — the CRM-native id that is
// UNIQUE per recipient row. accountId (a shared company id) and recipientEmail (two
// contacts can share an address) are DELIBERATELY NOT match keys (codex #1960
// rounds 4+5): matching by any NON-unique key would remove an arbitrary sibling and
// be non-idempotent on a replayed apply (remove one, replay removes the next). The
// `generate` node stamps `contactId: CrmContact.id` on EVERY produced recipient, so
// a contactId is always present for a row this gate can review — a removal that
// lacks one is un-keyable and fails closed upstream (never a silent mis-remove).
type RemovalIdentity = {
  contactId: string | null;
};

function asId(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function normalizeRemovedRecipients(raw: unknown): RemovalIdentity[] {
  if (!Array.isArray(raw)) return [];
  const out: RemovalIdentity[] = [];
  for (const r of raw as RemovedRecipientInput[]) {
    if (!r || typeof r !== "object") continue;
    // contactId ONLY — the CRM-native id, unique per recipient. NOT `recipientId`
    // (a derived, collidable alias — codex #1960 round-6), NOT email/accountId. The
    // pack renderer already resolves any snapshot id into `contactId`, and the
    // generate node stamps a real contactId on every row, so a removal always
    // carries one in practice.
    const contactId = asId(r.contactId);
    // A removal with no UNIQUE key cannot name a single stored row — drop it rather
    // than mis-remove; the handler fail-closes if this drops any submitted removal
    // (`removals.length !== rawRemovedCount`).
    if (!contactId) continue;
    out.push({ contactId });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bundle selection — the run's OWN latest recipients object.
// ---------------------------------------------------------------------------
type ObjEnvelope = {
  id: string;
  type: string;
  data: Record<string, unknown>;
  createdAt?: string;
};

// The keys, in read priority, under which a recipients bundle stores its
// per-recipient array (matches the recipients _list read's shape:
// `confirmedRecipients` is the generate-node canonical key; `recipients` is the
// interrupt-payload compat key).
const RECIPIENTS_ARRAY_KEYS = ["confirmedRecipients", "recipients"] as const;

// The registered object type the pre-gate persist node writes. A stored object of
// this type IS this run's recipients bundle even when its per-recipient array is
// present-but-empty (a degenerate zero-recipient bundle), so it is recognized by
// type — never misreported as "missing bundle". A type-matched object carrying NO
// per-recipient array key at all is NOT a bundle shape and fails closed (this type
// registers a permissive `z.record` schema, so type alone cannot vouch for shape).
const CAMPAIGN_RECIPIENTS_TYPE = "@cinatra-ai/campaigns:recipients";

// First PRESENT array key (may be empty) among the known keys.
function firstPresentArrayKey(data: Record<string, unknown>): string | null {
  for (const key of RECIPIENTS_ARRAY_KEYS) {
    if (Array.isArray(data[key])) return key;
  }
  return null;
}

function pickLatestBundle(
  items: ObjEnvelope[],
): { bundle: ObjEnvelope; arrayKey: string } | null {
  const candidates = items
    .filter((o) => o && typeof o === "object" && o.data && typeof o.data === "object")
    .filter((o) => o.type === CAMPAIGN_RECIPIENTS_TYPE)
    .map((o) => ({ o, arrayKey: firstPresentArrayKey(o.data) }))
    .filter((c): c is { o: ObjEnvelope; arrayKey: string } => c.arrayKey !== null);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.o.createdAt ?? "").localeCompare(a.o.createdAt ?? ""));
  return { bundle: candidates[0].o, arrayKey: candidates[0].arrayKey };
}

const rowContactId = (r: Record<string, unknown>): string | null => asId(r.contactId);

/**
 * Apply the operator's EXPLICIT removals to the stored bundle array.
 *
 * UNIQUE-KEY matching (codex #1960 rounds 4+5): each removal binds to the stored
 * row with its contactId — the ONLY per-recipient-unique key. There is no
 * fall-through to a weaker/collidable key (accountId or email), so a removal can
 * NEVER drift onto a different row. This makes the operation BOTH row-safe AND
 * idempotent on a replayed apply: after the target row is removed, replaying the
 * same removal finds no row with that contactId and is a NO-OP — it can never
 * delete a second row (there is no second row with that unique contactId, and no
 * weaker key to fall through to). Each stored row is consumed by at most one
 * removal; the unmatched stored rows (full content, stored order) are the KEPT set.
 *
 * A removal that matches no still-present row is a safe NO-OP (codex round-2 F4):
 * an idempotent retry of an already-applied removal, or a stale-snapshot removal
 * whose target is already gone. The caller must NOT treat `matched <
 * removals.length` as a failure; only a MALFORMED (un-keyable) payload fails
 * closed, checked upstream via `removals.length !== rawRemovedCount`. Exported for
 * the unit test.
 */
export function applyRemovalsToBundleArray(
  bundleArray: ReadonlyArray<Record<string, unknown>>,
  removals: ReadonlyArray<RemovalIdentity>,
): { keptRows: Record<string, unknown>[]; removed: number; matched: number } {
  const removedIdx = new Set<number>();
  let matched = 0;
  for (const k of removals) {
    // The removal's UNIQUE per-recipient key — contactId only (normalize dropped
    // any removal without one).
    if (!k.contactId) continue;
    const idx = bundleArray.findIndex((row, i) => !removedIdx.has(i) && rowContactId(row) === k.contactId);
    if (idx >= 0) {
      removedIdx.add(idx);
      matched += 1;
    }
  }
  const keptRows = bundleArray.filter((_, i) => !removedIdx.has(i));
  return { keptRows, removed: removedIdx.size, matched };
}

export async function handleEmailOutreachRecipientsUpdate(
  request: PrimitiveRequest<{ removedRecipients?: unknown; approvedRecipientIds?: unknown }>,
): Promise<unknown> {
  const runCtx = resolveRunScopedRunId();
  if ("error" in runCtx) return { error: runCtx.error };
  const { runId } = runCtx;

  const rawRemoved = request.input?.removedRecipients;
  if (rawRemoved !== undefined && !Array.isArray(rawRemoved)) {
    return { error: "`removedRecipients` must be an array of the operator's removed recipient rows when present." };
  }
  if (Array.isArray(rawRemoved) && rawRemoved.length > RECIPIENTS_PERSIST_MAX_BATCH) {
    return {
      error: `Too many removed recipients (${rawRemoved.length}); the removal batch is bounded at ${RECIPIENTS_PERSIST_MAX_BATCH}.`,
    };
  }
  const removals = normalizeRemovedRecipients(rawRemoved);
  const rawRemovedCount = Array.isArray(rawRemoved) ? rawRemoved.length : 0;

  // FAIL CLOSED on a MALFORMED payload FIRST — before any DB work AND before the
  // missing-bundle disambiguation (codex #1960 round-3 F3). A submitted removal
  // that carried no stable match key (no contactId / email / accountId) was
  // dropped by `normalizeRemovedRecipients`, so `removals.length !==
  // rawRemovedCount`. Running this guard here (not deep in the bundle-found path)
  // stops an un-keyable SURFACED removal from silently collapsing `surfacedCount`
  // to zero and bypassing the missing-bundle failure below.
  if (removals.length !== rawRemovedCount) {
    const dropped = rawRemovedCount - removals.length;
    return {
      error:
        `email_outreach_recipients_update: ${dropped} of ${rawRemovedCount} removed recipient row(s) ` +
        `carried no stable match key (contactId / email / accountId) — refusing an unrecognized removal payload.`,
    };
  }

  // The size of the snapshot the gate SURFACED to the operator = the kept ids the
  // renderer forwarded (`approvedRecipientIds`) PLUS the explicit removals (raw
  // count — un-keyable removals were already rejected above). Used only to
  // disambiguate the missing-bundle path (codex #1960 finding 3): a missing bundle
  // with a NON-empty surfaced snapshot is a persistence gap, not a legitimate
  // zero-recipient run.
  const rawApproved = request.input?.approvedRecipientIds;
  const approvedCount = Array.isArray(rawApproved) ? rawApproved.length : 0;
  const surfacedCount = approvedCount + rawRemovedCount;

  const actor = request.actor as PrimitiveActorContext;
  const roles = await resolveRoleHintsFromSession();
  try {
    // read-enforced load (readAgentRunById applies enforceRunAccess("read")).
    const run = await readAgentRunById(runId, actor, roles);
    if (!run) return { error: `Run not found: ${runId}` };

    const template = await readAgentTemplateById(run.templateId);
    const agentPackageName =
      template?.packageName && template.packageName.length > 0 ? template.packageName : null;

    // Registry-routed declaring-package restriction (coupling-ban): only a run
    // whose declaring package declares a campaign-recipients-review mid-run gate
    // may remove recipients. Resolved from the manifest, never hardcoded.
    const allowedPackages = await resolveRecipientsReviewDeclaringPackages();
    if (!agentPackageName || !allowedPackages.has(agentPackageName)) {
      return {
        error:
          "email_outreach_recipients_update is only callable by a run whose declaring " +
          "package serves a campaign-recipients-review mid-run HITL gate.",
      };
    }

    // respondToHitl-tier authz — persisting the reviewed removals IS the HITL
    // response (same tier as agent_run_hitl_prompts_exclude). Thread co-owners +
    // effective policy so a user SHARED into the run passes.
    const coOwnerRows = await readRunCoOwners(run.id);
    const coOwnerUserIds = coOwnerRows.map((r) => r.userId);
    const effectivePolicy = run.authPolicy ?? template?.agentAuthPolicy ?? null;
    await enforceRunAccess(
      { ...run, effectivePolicy, coOwnerUserIds },
      actor,
      "respondToHitl",
      roles,
    );

    // Read the run's OWN objects and select its latest recipients bundle. Read/
    // update through the run's FULL OWNER ActorContext (teamIds, projectGrants,
    // org/platform role), mirroring the #1625 test-delivery / #1959 drafts
    // precedent — NOT the narrowed passthrough PrimitiveActorContext (which drops
    // team/project scope and would miss a team/project-scoped pre-gate save). The
    // `runId` filter bounds the read to THIS run's own objects; per-row
    // object.read/update authz still applies inside the objects handlers.
    const ownerCtx = await buildActorContextFromRun({
      id: run.id,
      runBy: run.runBy,
      orgId: run.orgId,
      dependentInstallId: run.dependentInstallId ?? null,
    });
    const objects = createSessionObjectsClient(ownerCtx);
    const listed = (await objects.list({ runId, limit: 500 })) as { items?: ObjEnvelope[] };
    const items = Array.isArray(listed.items) ? listed.items : [];
    const selected = pickLatestBundle(items);
    if (!selected) {
      // No recipients bundle object. Complete ONLY when the gate surfaced a
      // GENUINELY EMPTY snapshot (no kept ids AND no removals) — a legitimate
      // zero-recipient run whose generate early-exit (list-not-found / zero
      // members) produced no bundle (codex #1960 finding 3). If the operator
      // instead SAW recipients (surfacedCount > 0: kept ids and/or explicit
      // removals) but the bundle is gone, that is a persistence gap, NOT a
      // zero-recipient run — FAIL CLOSED (codex #1960 round-2 finding 3) so the
      // passthrough responds non-2xx and the apply node fails the run rather than
      // silently completing with every surfaced recipient dropped.
      if (surfacedCount === 0) {
        return {
          ok: true,
          runId,
          agentPackageName,
          objectId: null,
          matched: 0,
          removed: 0,
          reviewedRecipients: [],
          reviewedCount: 0,
        };
      }
      return {
        error:
          `email_outreach_recipients_update: run ${runId} has no recipients bundle object, but the gate surfaced ` +
          `${surfacedCount} recipient(s) to the operator (the pre-gate generate node's bundle is missing). Refusing to ` +
          `complete the resume with the surfaced recipients silently dropped.`,
      };
    }

    const bundleArray = (selected.bundle.data[selected.arrayKey] as Record<string, unknown>[]) ?? [];
    const { keptRows, removed, matched } = applyRemovalsToBundleArray(bundleArray, removals);

    // NOTE: the malformed-payload fail-closed guard (removals.length !==
    // rawRemovedCount) already ran BEFORE the bundle lookup. A well-keyed removal
    // that matched no CURRENT stored row (`matched < removals.length`) is
    // DELIBERATELY tolerated (codex #1960 round-2 F4): an idempotent retry of an
    // already-applied removal or a stale removal whose target is gone — both safe
    // non-destructive no-ops. Persist iff the operator actually removed something. An empty removal batch
    // (clean approval — nothing removed) legitimately writes nothing and still
    // returns the authoritative (unchanged) reviewed set below.
    if (removed > 0) {
      // objects_update merges the top-level keys over the stored data (shallow),
      // replacing exactly the recipient array + count. object.update authz +
      // activated-type payload validation apply inside the handler.
      await objects.update({
        objectId: selected.bundle.id,
        data: { [selected.arrayKey]: keptRows, recipientCount: keptRows.length },
      });
    }

    return {
      ok: true,
      runId,
      agentPackageName,
      objectId: selected.bundle.id,
      matched,
      removed,
      // Authoritative reviewed content for the EndNode (confirmedRecipients /
      // recipientCount): the KEPT stored rows (full content) + their count.
      reviewedRecipients: keptRows,
      reviewedCount: keptRows.length,
    };
  } catch (err) {
    if (err instanceof AuthzError) {
      // Audit the ATTEMPTED WRITE op (respondToHitl) — persisting the reviewed
      // removals is a write, so a denial is not mislabeled as a read.
      void logAuditEvent({
        actorPrincipalId: actor.userId,
        actorPrincipalType: (actor.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
        authSource: (actor.source as AuditEventInput["authSource"]) ?? "mcp",
        resourceType: "agent_run",
        resourceId: runId,
        operation: "respondToHitl",
        decision: "denied",
        policyVersion: POLICY_VERSION,
      });
      return authzErrorToResponse(err, `Run not found: ${runId}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Recipients persist failed: ${message}` };
  }
}
