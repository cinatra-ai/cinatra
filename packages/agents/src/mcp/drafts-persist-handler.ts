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
// persists it onto the run's own draft-bundle object.
//
// DESIGN (a) — PRE-GATE PERSIST (cinatra#1959 stage-0 dataflow decision). The
// draft/followup LLM node writes the GENERATED bundle to the run's objects store
// (an `objects_save` run-tagged by the llm-bridge run-context registry, mirroring
// the recipients-generate precedent) BEFORE the approval gate. This primitive is
// therefore UPDATE-ONLY + fail-closed: a missing bundle at apply time is genuine
// corruption, not a first write. On every ok path it returns the AUTHORITATIVE
// reviewed content — `reviewedBundle` (the stored bundle with the reviewed array
// spliced in) + a server-regenerated `reviewedDocument` — which the agent OAS
// wires into the EndNode terminal output/artifact (nit #4), so a downstream
// consumer sees the REVIEWED drafts, never the pre-gate generated draft.
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

// The registered object types the pre-gate persist node writes (the DATA
// contract this primitive operates on — an object-type id, NOT a package name,
// so the core-extension-coupling-ban is preserved). A stored object of one of
// these types IS this run's bundle even when its per-recipient array is
// present-but-empty (a degenerate zero-recipient bundle), so it is recognized
// by type — never misreported as "missing bundle" (corruption). A type-matched
// object carrying NO per-recipient array key at all is NOT a bundle shape and
// fails closed (these types register a permissive `z.record` schema, so type
// alone cannot vouch for shape).
const CAMPAIGN_BUNDLE_TYPES = new Set<string>([
  "@cinatra-ai/campaigns:email-draft-bundle",
  "@cinatra-ai/campaigns:email-followup-bundle",
]);

// First PRESENT array key (may be empty) among the known keys — for a
// type-recognized bundle, where an empty array is still a valid target.
function firstPresentArrayKey(data: Record<string, unknown>): string | null {
  for (const key of BUNDLE_ARRAY_KEYS) {
    if (Array.isArray(data[key])) return key;
  }
  return null;
}

// Legacy shape heuristic for an UNTYPED / back-compat row: first NON-EMPTY key
// whose first row looks like a draft (carries subject/body).
function draftShapedArrayKey(data: Record<string, unknown>): string | null {
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
    .map((o) => {
      // A registered campaign-bundle type is recognized when it carries a
      // PRESENT per-recipient array key — an EMPTY array counts (a degenerate
      // zero-recipient bundle: `Array.isArray([])` is true, so
      // `firstPresentArrayKey` returns it). A registered-type object carrying NO
      // array key at all resolves to null and fails closed as "missing/
      // corruption" rather than being defaulted to an empty `draftedEmails` —
      // that default would return a phantom `ok` for a malformed object under
      // this permissive-schema type. Untyped/back-compat rows use the non-empty
      // draft-shape heuristic.
      const arrayKey = CAMPAIGN_BUNDLE_TYPES.has(o.type)
        ? firstPresentArrayKey(o.data)
        : draftShapedArrayKey(o.data);
      return { o, arrayKey };
    })
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

// The follow-up agent's reviewed document uses the follow-up digest heading
// shape; every other drafts-review declaring package uses the per-recipient
// draft-document shape. A package-name switch (not a hardcoded coupling — the
// package is the run's own template.packageName) mirroring the two agents'
// original LLM document formats (email-drafting-agent draft node / follow-up
// node system prompts).
const FOLLOWUP_DECLARING_PACKAGE = "@cinatra-ai/email-follow-up-agent";

// The internal run-provenance fields objects_save stamps onto the bundle
// (`cinatra_agent_run_id` set by the pre-gate LLM save; `cinatraAgentRunId`
// injected server-side). Stripped from the reviewed bundle so the terminal
// EndNode output mirrors the agent's original `{...Bundle}` shape and never
// leaks a run id into the flow's product output.
const BUNDLE_PROVENANCE_KEYS = ["cinatra_agent_run_id", "cinatraAgentRunId"] as const;

/**
 * Regenerate the reviewed-bundle Markdown document server-side from the
 * AUTHORITATIVE post-update array (never a caller-supplied document). Faithful
 * to each agent's own draft node prompt: the drafting agent renders one
 * `## <recipientName>` section per recipient; the follow-up agent renders one
 * `## Follow-up <n> (day <day>)` section per step. Exported for the unit test.
 */
export function renderReviewedDocument(
  array: ReadonlyArray<Record<string, unknown>>,
  packageName: string | null,
): string {
  const isFollowup = packageName === FOLLOWUP_DECLARING_PACKAGE;
  const sections = array.map((row, i) => {
    const subject = typeof row.subject === "string" ? row.subject : "";
    const body = typeof row.body === "string" ? row.body : "";
    if (isFollowup) {
      const day = typeof row.followUpDay === "number" ? row.followUpDay : null;
      const heading =
        day !== null ? `## Follow-up ${i + 1} (day ${day})` : `## Follow-up ${i + 1}`;
      return `${heading}\n**Subject:** ${subject}\n\n${body}\n`;
    }
    const name =
      (typeof row.recipientName === "string" && row.recipientName.length > 0
        ? row.recipientName
        : rowEmail(row)) ?? `Recipient ${i + 1}`;
    return `## ${name}\n**Subject:** ${subject}\n\n${body}\n\n---\n`;
  });
  return sections.join(isFollowup ? "\n" : "");
}

// Build the reviewed bundle returned to the EndNode: the stored bundle data
// with the reviewed array spliced in and the internal run-provenance stripped.
function buildReviewedBundle(
  storedData: Record<string, unknown>,
  arrayKey: string,
  nextArray: Record<string, unknown>[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(storedData)) {
    if ((BUNDLE_PROVENANCE_KEYS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  out[arrayKey] = nextArray;
  return out;
}

/**
 * Apply the normalized edits onto a copy of the bundle array. Matches each edit
 * to a bundle row by id first, then by recipient email — ONE-TO-ONE: an edit is
 * consumed by at most one row, so a duplicate key (e.g. two stored rows sharing
 * an email) can never clobber a second row with the same edit, and `matched`
 * (distinct edits consumed) can never exceed `edits.length`. The handler then
 * asserts `matched === edits.length` (every submitted edit applied to exactly
 * one row) so an id/email misalignment fails closed rather than dropping edits.
 * Returns the new array + the distinct-edit match count + the changed-row count.
 * Exported for the unit test.
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
  const consumed = new Set<NormalizedEdit>();
  let changed = 0;
  const nextArray = bundleArray.map((row) => {
    const id = rowId(row);
    const email = rowEmail(row);
    const edit = (id && byId.get(id)) || (email && byEmail.get(email)) || undefined;
    // Skip an unmatched row, and skip a row whose edit was already consumed by a
    // prior row (one-to-one — never apply one edit to two rows).
    if (!edit || consumed.has(edit)) return row;
    consumed.add(edit);
    const curSubject = typeof row.subject === "string" ? row.subject : "";
    const curBody = typeof row.body === "string" ? row.body : "";
    if (edit.subject === curSubject && edit.body === curBody) return row;
    changed += 1;
    return { ...row, subject: edit.subject, body: edit.body };
  });
  return { nextArray, changed, matched: consumed.size };
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

    // ALWAYS read the run's OWN objects and select its latest draft-bundle row —
    // even for an empty edit set. Under design (a) (PRE-GATE PERSIST) the draft
    // node's LLM step wrote the generated bundle BEFORE the approval gate, so the
    // row must exist; the EndNode's terminal output/artifact is now sourced from
    // THIS authoritative reviewed bundle (never the pre-gate generated draft), so
    // every ok path must load and return it.
    //
    // Read/update through the run's FULL OWNER ActorContext (teamIds,
    // projectGrants, org/platform role), mirroring the #1625 test-delivery
    // precedent — NOT the narrowed passthrough PrimitiveActorContext. The
    // pre-gate `objects_save` scope-DERIVES the bundle's ownership from the run's
    // OBO ceiling (deriveAgentRunScopeOwnership), so an agent_run-delegated save
    // lands team/project/org-scoped, not necessarily user-owned. A read under the
    // narrowed actor — which drops teamIds/projectGrants — would NOT match that
    // row in buildOwnershipFilter (no team/project clause) and would fail closed
    // as "missing bundle" for every team/project-scoped run (codex #1959 finding
    // 3). The owner context sees every row the run owner can; the `runId` filter
    // below bounds the read to THIS run's own objects (the same runId-bounded
    // posture #1625 relies on). Per-row object.read/update authz still applies
    // inside the objects handlers.
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
      // The run has no draft-bundle object — genuine corruption (the pre-gate
      // save is a create-once node the flow always runs before the gate). FAIL
      // CLOSED (codex #1959 findings 1+2): return an error so the passthrough
      // responds non-2xx and the apply ApiNode FAILS the run, rather than a 200
      // that both agents' unconditional apply->End edges would let complete with
      // the operator's edits unsaved.
      return {
        error:
          `email_outreach_initial_drafts_update: run ${runId} has no draft-bundle object to persist the reviewed edits onto ` +
          `(the pre-gate persist node produced none). Refusing to complete the resume with the edits unsaved.`,
      };
    }

    const bundleArray = (selected.bundle.data[selected.arrayKey] as Record<string, unknown>[]) ?? [];
    const { nextArray, changed, matched } = applyEditsToBundleArray(bundleArray, edits);

    // FAIL CLOSED (codex #1959 finding 4, hardened): the renderer submits the
    // COMPLETE reviewed set, so EVERY submitted row must map ONE-TO-ONE onto a
    // distinct stored bundle row. Two independent shortfalls are both refused
    // rather than reported as a partial success:
    //   (a) a submitted row was dropped as un-keyable (neither id nor email) or
    //       non-object before matching — `edits.length !== rawRowCount`;
    //   (b) a submitted edit matched no stored row, or collided with another
    //       edit onto the same row — `matched !== edits.length`.
    // An empty edit set (rawRowCount===0) satisfies both and returns the stored
    // bundle unchanged.
    const rawRowCount = Array.isArray(rawDrafts) ? rawDrafts.length : 0;
    if (matched !== edits.length || edits.length !== rawRowCount) {
      const unaccounted = rawRowCount - matched;
      return {
        error:
          `email_outreach_initial_drafts_update: ${unaccounted} of ${rawRowCount} reviewed draft row(s) ` +
          `did not map one-to-one onto a stored bundle row (un-keyable or id/email misalignment) — refusing to persist a partial set.`,
      };
    }

    // Persist iff the reviewed content actually diverges from the stored content.
    // A clean approval (every row identical, or an empty edit set) legitimately
    // writes nothing — the pre-gate row already holds the generated content — and
    // still returns the authoritative reviewed bundle below.
    if (changed > 0) {
      // objects_update merges the top-level array key over the stored data
      // (shallow), replacing exactly the edited array. object.update authz +
      // activated-type payload validation apply inside the handler.
      await objects.update({
        objectId: selected.bundle.id,
        data: { [selected.arrayKey]: nextArray },
      });
    }

    // Authoritative reviewed content for the EndNode / artifact (nit #4): the
    // stored bundle with the reviewed array spliced in, plus a server-regenerated
    // Markdown document. Returned on EVERY ok path (write, clean no-op, empty
    // edit set) so the terminal output never reverts to the pre-gate draft.
    const reviewedBundle = buildReviewedBundle(selected.bundle.data, selected.arrayKey, nextArray);
    const reviewedDocument = renderReviewedDocument(nextArray, agentPackageName);

    return {
      ok: true,
      runId,
      agentPackageName,
      objectId: selected.bundle.id,
      matched,
      updated: changed,
      reviewedBundle,
      reviewedDocument,
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
