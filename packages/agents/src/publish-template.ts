// Transactional publish-and-bind for an agent template (cinatra#2653).
//
// Extracted VERTICAL SLICE out of ./store (file-size ratchet; same split as
// ./store-template-versions and ./template-snapshot). This is the seam the
// admin UPLOAD path uses: per the owner ruling on PR #2658, an uploaded agent
// extension goes live under /agents directly — no draft limbo, no approval
// step — so the upload import calls this right after the archive lands.
//
// ./store does NOT re-export this module (that edge would close an import
// cycle: this module imports ./store's `_runAgentTemplateUpdate`). Consumers
// import it directly.
//
// NOTE for the route-graph ratchet: this module is reachable only from the
// upload import action; its first-party imports (./db, ./store,
// ./store-template-versions, ./agent-builder-ids) are all reachable there
// already, so it adds no new subtree.

import { db } from "./db";
import { shadowUpsertObject } from "@/lib/objects-dual-write";
import { AGENT_TEMPLATE_TYPE_ID } from "./agent-builder-ids";
import { _runAgentTemplateUpdate } from "./store";
import type { AgentTemplateRecord, AgentTemplateVersionRecord } from "./store";
import type { AgentTemplateIdentityClaim } from "./agent-template-identity";
import { _createAgentTemplateVersionIfChanged } from "./store-template-versions";

/**
 * Publish a template AND bind its current version in ONE transaction
 * (cinatra#2653, CodeRabbit major). The old two-step caller flow
 * (`updateAgentTemplate({status:"published"})` then
 * `createAgentTemplateVersionIfChanged`) could commit the status flip and then
 * fail the binding, leaving a published template without a usable version —
 * and the caller's idempotent-success path masked the damage on retry.
 *
 * Here the status flip (with ALL THREE assistant guard arms via
 * `_runAgentTemplateUpdate`) and the version create + `current_version_id`
 * advance run on one transaction: either the template leaves published WITH a
 * bound version, or nothing changed. Calling it again on an
 * already-published template is the REPAIR path: the flip is a no-op and the
 * version binding is created or re-pointed as needed.
 *
 * Returns null when the write was refused (assistant-kind guard, or the
 * template disappeared) — mirroring `updateAgentTemplate`'s zero-row
 * classification. The Objects-layer shadow mirror runs AFTER commit, exactly
 * like `_updateAgentTemplateImpl` (a refusal must never publish a mirrored
 * state the transaction then rolls back).
 */
export async function publishAgentTemplateAndBindVersion(
  id: string,
  opts: {
    createdBy?: string | null;
    /** WHO is publishing (CodeRabbit security finding on this seam): the
     *  identity claim rides the flip's WHERE via `_runAgentTemplateUpdate`,
     *  so an organization-scoped caller can never flip another tenant's
     *  template — the foreign write matches zero rows and returns null.
     *  Callers derive it with `deriveAgentTemplateIdentityClaim`; the
     *  platform claim keeps the unrestricted operator arm. */
    claim?: AgentTemplateIdentityClaim;
  } = {},
): Promise<{ record: AgentTemplateRecord; version: AgentTemplateVersionRecord } | null> {
  const result = await db.transaction(async (tx) => {
    const record = await _runAgentTemplateUpdate(tx, id, { status: "published" }, opts.claim);
    if (!record) return null;
    const { version } = await _createAgentTemplateVersionIfChanged(tx, record, {
      createdBy: opts.createdBy ?? null,
    });
    return { record: { ...record, currentVersionId: version.id }, version };
  });
  if (!result) return null;

  // Mirror AFTER the transaction commits (same ordering rationale as
  // _updateAgentTemplateImpl).
  shadowUpsertObject({
    id: result.record.id,
    type: AGENT_TEMPLATE_TYPE_ID,
    data: {
      ...result.record,
      createdAt: result.record.createdAt.toISOString(),
      updatedAt: result.record.updatedAt.toISOString(),
    },
    orgId: result.record.orgId ?? null,
    createdBy: result.record.creatorId ?? null,
  });

  return result;
}
