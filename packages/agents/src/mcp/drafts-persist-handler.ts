// Run-scoped drafts-review PERSIST primitive (cinatra#1959) — EXTRACTED from
// handlers.ts (file-size ratchet). Intra-package import cycle with ./handlers is
// intentional and safe: the shared helpers are hoisted declarations referenced
// only at call time (the ./test-delivery-handlers precedent).
//
// email_outreach_initial_drafts_update — the REAL run-scoped write the
// re-entrant drafts / follow-ups review gate's post-resume `apply` ApiNode
// dispatches (A-ii). It closes the "silent drop": the pack renderer emits the
// operator's per-recipient subject/body edits into the gate's `userResponse`,
// the passthrough seam parses that into a `drafts[]` batch, and this primitive
// persists it onto the run's own draft-bundle object (the SAME objects-store row
// the drafts _list read reads — reused, not a new store).
//
// TRUST MODEL — identical to the #1794 HITL prompt primitives: run, declaring
// package, and actor are all derived from the invocation frame, NEVER caller
// input.
//   - runId          ← the VERIFIED run scope on the ambient MCP frame
//                      (`verifiedRunScopeId`, stamped only by the run-bound
//                      `/api/agents/passthrough` seam after `bindBridgeRunId`);
//                      a caller `runId` is ignored.
//   - declaring pkg  ← the run's own template.packageName, matched against the
//                      REGISTRY set of packages that declare an `email-drafts-
//                      review` mid-run HITL gate (resolved from the manifest,
//                      never a hardcoded package name — the core-extension-
//                      coupling-ban; the #1625 test-delivery precedent).
//   - actor          ← `request.actor`, gated by `enforceRunAccess`
//                      ("respondToHitl", the same tier as
//                      agent_run_hitl_prompts_exclude — persisting the reviewed
//                      edits IS the HITL response).
// Absent run context ⇒ fail closed.

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { createDeterministicObjectsClient } from "@cinatra-ai/objects";
import { AuthzError, logAuditEvent, POLICY_VERSION, type AuditEventInput } from "@/lib/authz";
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
// precedent, honoured by ./test-delivery-handlers.
const DRAFTS_REVIEW_RENDERER_KIND = "email-drafts-review";

// Defensive bound on a single persist batch (one row per recipient; a campaign's
// recipient set is small — a generous ceiling that rejects a pathological
// payload rather than iterating an unbounded array).
const DRAFTS_PERSIST_MAX_BATCH = 2000;

// The set of packages whose run may invoke this persist primitive: the id-SCOPE
// of every registry binding of kind `email-drafts-review` that flags a mid-run
// HITL gate (the pack-served re-entrant gates — NOT the reviewer `:output`
// bindings, which carry no `midRunHitl`). Derived from the manifest, never a
// hardcoded package name. field-renderer-bindings.server is imported LAZILY so
// its filesystem-scanning graph stays off handlers.ts's eager import cycle.
async function resolveDraftsReviewDeclaringPackages(): Promise<Set<string>> {
  const { getMergedFieldRendererBindings } = await import("../field-renderer-bindings.server");
  return new Set(
    getMergedFieldRendererBindings()
      .filter((b) => b.kind === DRAFTS_REVIEW_RENDERER_KIND && b.midRunHitl === true)
      // The binding id is `@scope/package:local-id`; the package scope IS the
      // declaring agent (the pack DECLARES the component under the agent's id).
      .map((b) => b.id.split(":")[0])
      .filter((pkg) => pkg.length > 0),
  );
}

// ---------------------------------------------------------------------------
// Payload shape (post-passthrough-shaper). The gate's single string output
// `userResponse` is a JSON object the seam parses; only `drafts[]` is read here
// (campaignId/editedIds/approved* are informational — scope comes from the run
// frame, never the payload).
// ---------------------------------------------------------------------------
type ResumeDraftInput = {
  id?: unknown;
  recipientId?: unknown;
  recipientEmail?: unknown;
  subject?: unknown;
  body?: unknown;
  status?: unknown;
  followUpDay?: unknown;
};

type NormalizedEdit = {
  id: string;
  recipientEmail: string | null;
  subject: string;
  body: string;
};

export function normalizeEdits(raw: unknown): NormalizedEdit[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedEdit[] = [];
  for (const d of raw as ResumeDraftInput[]) {
    if (!d || typeof d !== "object") continue;
    const id = typeof d.id === "string" && d.id.length > 0 ? d.id : "";
    const recipientEmail =
      typeof d.recipientEmail === "string" && d.recipientEmail.length > 0 ? d.recipientEmail : null;
    // A row with neither a stable id nor an email cannot be matched to a bundle
    // entry — skip it rather than mis-apply by position.
    if (!id && !recipientEmail) continue;
    out.push({
      id,
      recipientEmail,
      subject: typeof d.subject === "string" ? d.subject : "",
      body: typeof d.body === "string" ? d.body : "",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bundle selection — the run's OWN latest draft-shaped object. Mirrors the
// drafts _list read's shape probes (a per-recipient array carrying subject/body,
// or a follow-up sequence) so write and read target the same row. Scoped to the
// verified run, so a single run yields a single bundle kind (no initial-vs-
// follow-up disambiguation needed — the run frame IS the routing).
// ---------------------------------------------------------------------------
type ObjEnvelope = {
  id: string;
  type: string;
  data: Record<string, unknown>;
  createdAt?: string;
};

// The keys, in read priority, under which a draft-bundle object stores its
// per-recipient array. First present array wins (matches the _list read's
// `raw.sequence ?? raw.followups ?? raw.drafts ?? raw.confirmedRecipients`,
// plus `draftedEmails` for the newer agent-output shape).
const BUNDLE_ARRAY_KEYS = [
  "draftedEmails",
  "sequence",
  "followups",
  "drafts",
  "confirmedRecipients",
] as const;

function bundleArrayKey(data: Record<string, unknown>): string | null {
  for (const key of BUNDLE_ARRAY_KEYS) {
    const arr = data[key];
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0] as Record<string, unknown> | undefined;
      if (first && typeof first === "object" && ("body" in first || "subject" in first)) {
        return key;
      }
    }
  }
  return null;
}

function pickLatestBundle(items: ObjEnvelope[]): { bundle: ObjEnvelope; arrayKey: string } | null {
  const candidates = items
    .filter((o) => o && typeof o === "object" && o.data && typeof o.data === "object")
    .map((o) => ({ o, arrayKey: bundleArrayKey(o.data) }))
    .filter((c): c is { o: ObjEnvelope; arrayKey: string } => c.arrayKey !== null);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.o.createdAt ?? "").localeCompare(a.o.createdAt ?? ""));
  return { bundle: candidates[0].o, arrayKey: candidates[0].arrayKey };
}

const rowEmail = (r: Record<string, unknown>): string | null => {
  const e = r.recipientEmail ?? r.email ?? r.contactEmail;
  return typeof e === "string" && e.length > 0 ? e : null;
};
const rowId = (r: Record<string, unknown>): string | null => {
  const id = r.id ?? r.recipientId;
  return typeof id === "string" && id.length > 0 ? id : null;
};

/**
 * Apply the normalized edits onto a copy of the bundle array. Matches each edit
 * to a bundle row by id first, then by recipient email. Returns the new array
 * plus the count of rows whose subject/body actually changed. Exported for the
 * unit test.
 */
export function applyEditsToBundleArray(
  bundleArray: ReadonlyArray<Record<string, unknown>>,
  edits: ReadonlyArray<NormalizedEdit>,
): { nextArray: Record<string, unknown>[]; changed: number; matched: number } {
  const byId = new Map<string, NormalizedEdit>();
  const byEmail = new Map<string, NormalizedEdit>();
  for (const e of edits) {
    if (e.id) byId.set(e.id, e);
    if (e.recipientEmail) byEmail.set(e.recipientEmail, e);
  }
  let changed = 0;
  let matched = 0;
  const nextArray = bundleArray.map((row) => {
    const id = rowId(row);
    const email = rowEmail(row);
    const edit = (id && byId.get(id)) || (email && byEmail.get(email)) || undefined;
    if (!edit) return row;
    matched += 1;
    const curSubject = typeof row.subject === "string" ? row.subject : "";
    const curBody = typeof row.body === "string" ? row.body : "";
    if (edit.subject === curSubject && edit.body === curBody) return row;
    changed += 1;
    return { ...row, subject: edit.subject, body: edit.body };
  });
  return { nextArray, changed, matched };
}

export async function handleEmailOutreachInitialDraftsUpdate(
  request: PrimitiveRequest<{ drafts?: unknown }>,
): Promise<unknown> {
  const runCtx = resolveRunScopedRunId();
  if ("error" in runCtx) return { error: runCtx.error };
  const { runId } = runCtx;

  const rawDrafts = request.input?.drafts;
  if (rawDrafts !== undefined && !Array.isArray(rawDrafts)) {
    return { error: "`drafts` must be an array of per-recipient edit rows when present." };
  }
  if (Array.isArray(rawDrafts) && rawDrafts.length > DRAFTS_PERSIST_MAX_BATCH) {
    return {
      error: `Too many drafts (${rawDrafts.length}); the persist batch is bounded at ${DRAFTS_PERSIST_MAX_BATCH}.`,
    };
  }
  const edits = normalizeEdits(rawDrafts);

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
    // whose declaring package declares an email-drafts-review mid-run gate may
    // persist reviewed drafts. Resolved from the manifest, never hardcoded.
    const allowedPackages = await resolveDraftsReviewDeclaringPackages();
    if (!agentPackageName || !allowedPackages.has(agentPackageName)) {
      return {
        error:
          "email_outreach_initial_drafts_update is only callable by a run whose declaring " +
          "package serves an email-drafts-review mid-run HITL gate.",
      };
    }

    // respondToHitl-tier authz — persisting the reviewed edits IS the HITL
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

    // Nothing to persist (operator approved with no editable rows) — a benign,
    // honest no-op. Never fabricate a write.
    if (edits.length === 0) {
      return { ok: true, runId, agentPackageName, matched: 0, updated: 0 };
    }

    // Read the run's OWN objects and select its latest draft-bundle row. The
    // objects handlers apply per-row object.read authz under this actor.
    const objects = createDeterministicObjectsClient({
      actor: actor as unknown as Parameters<typeof createDeterministicObjectsClient>[0]["actor"],
    });
    const listed = (await objects.list({ runId, limit: 500 })) as { items?: ObjEnvelope[] };
    const items = Array.isArray(listed.items) ? listed.items : [];
    const selected = pickLatestBundle(items);
    if (!selected) {
      // Edits were supplied but the run has no draft-bundle object to write them
      // onto — FAIL CLOSED (codex #1959 findings 1+2): return an error so the
      // passthrough responds non-2xx and the apply ApiNode FAILS the run, rather
      // than a 200 `ok:false` that both agents' unconditional apply->End edges
      // ignore (which would silently complete a run that dropped the operator's
      // edits). NOTE: no normal writer persists these bundle types pre-gate, so
      // this currently fails EVERY re-entrant run — the DELIBERATE loud surface
      // of the open persistence-lifecycle decision (create-or-pre-persist the
      // bundle + route the reviewed content into the EndNode output). See the
      // STAGE 2 handback.
      return {
        error:
          `email_outreach_initial_drafts_update: run ${runId} has no draft-bundle object to persist the reviewed edits onto ` +
          `(no pre-gate writer produced one). Refusing to complete the resume with the edits unsaved.`,
      };
    }

    const bundleArray = (selected.bundle.data[selected.arrayKey] as Record<string, unknown>[]) ?? [];
    const { nextArray, changed, matched } = applyEditsToBundleArray(bundleArray, edits);

    // FAIL CLOSED (codex #1959 finding 4): the renderer submits the COMPLETE
    // reviewed set, so every submitted row MUST match a stored bundle row. A
    // shortfall means an id/email mismatch silently dropped part of the approved
    // set — refuse rather than report a partial success.
    if (matched < edits.length) {
      return {
        error:
          `email_outreach_initial_drafts_update: ${edits.length - matched} of ${edits.length} reviewed draft(s) ` +
          `did not match a stored bundle row (id/email misalignment) — refusing to persist a partial set.`,
      };
    }

    if (changed === 0) {
      // Every submitted row matched and was identical to the stored content — a
      // legitimate no-op (operator approved without editing). Honest counts.
      return { ok: true, runId, agentPackageName, objectId: selected.bundle.id, matched, updated: 0 };
    }

    // Persist: objects_update merges the top-level array key over the stored
    // data (shallow), replacing exactly the edited array. object.update authz +
    // activated-type payload validation apply inside the handler.
    await objects.update({
      objectId: selected.bundle.id,
      data: { [selected.arrayKey]: nextArray },
    });

    return {
      ok: true,
      runId,
      agentPackageName,
      objectId: selected.bundle.id,
      matched,
      updated: changed,
    };
  } catch (err) {
    if (err instanceof AuthzError) {
      // Audit the ATTEMPTED WRITE op (respondToHitl) — persisting the reviewed
      // edits is a write, so a denial is not mislabeled as a read (mirrors
      // agent_run_hitl_prompts_exclude).
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
    return { error: `Drafts persist failed: ${message}` };
  }
}
