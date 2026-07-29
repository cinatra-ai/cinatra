// WordPress reference freshness adapter.
//
// Probes the WordPress community MCP catalog for the captured remote post and
// determines whether it's fresh (matches the snapshot), changed (remote
// edited since capture), missing (deleted), unsupported (instance not
// configured), or unknown (network/transient/not-yet-resolvable).
//
// Comparison: modified_gmt-equivalent timestamp + content_hash (sha256 of the
// rendered/raw content). modified_gmt alone is unstable across some plugin
// updates; the content hash provides a second signal.
//
// cinatra#2022 S7 freshness re-point: this used to be a bespoke direct
// WordPress REST call with an inline Basic-auth header build
// (`fetchPostStatus`/`resolveAuthHeader`, pre-re-point). It now goes through
// the SAME governed connector-instance invoker every other WordPress
// consumer uses (`wordpress_site_tool_call`'s own host-bound path,
// `connector-instance-invoker.ts`'s authz -> policy -> classify -> hook ->
// execute -> audit order) via the `ewpa/get-post` / `ewpa/get-page`
// community-catalog abilities — never a second bespoke transport. This buys
// three things for free from the invoker's own machinery, unchanged by this
// file: (a) the per-process catalog-snapshot cache (CATALOG_TTL_MS /
// CATALOG_MAX_STALE_MS) is REUSED across every object checked for the same
// instance in one sweep, so only the FIRST object for a given instance in a
// TTL window pays for a fresh `tools/list` discovery — one catalog session
// per instance per sweep, not one per object; (b) the SAME per-user "use"
// authority gate (cinatra#409) + per-instance tool-policy floor that already
// gate every write path now ALSO gate freshness reads — a real, disclosed
// posture change from pre-re-point (the old bespoke REST call did zero
// per-user authorization; ANY org member could probe ANY configured
// instance's post). A user who currently lacks live "use" authority on the
// instance (revoked membership, no connector-package entitlement) now gets
// an `unknown` verdict instead of a REST response, never a crash; (c) auth
// (Nango -> Basic) is resolved host-side by the invoker, so this file no
// longer builds or holds a credential at all.
//
// DISCLOSED GAP (not closed by this change): `ewpa/get-post` is CONFIRMED
// PRESENT in the pinned fixture's tools/list discovery captures
// (tests/e2e/wp-mcp-gateway/captures/annotations-c-gateway-triad.json,
// annotations-f-fixturelabs-surfacing.json — "Get Single Post"/"Get Single
// Page"), but its exact request/response SHAPE was never captured by the
// live VERIFY suite (only `ewpa/get-posts`/`create-post`/`update-post-meta`
// have a recorded verdict in captures/verify-verdicts.json), and proving it
// empirically requires a live capture run against the booted pinned fixture
// (cinatra#2016's workflow). Rather than guess a single field name and risk
// a silent misparse, the extraction below tries every plausible field name
// this plugin's OTHER abilities' observed conventions suggest (flat
// WP_Post-style `post_id`/`post_content`/`post_modified_gmt`, matching
// `ewpa/delete-post`'s captured `post_id` schema, plus a defensive fallback
// to the REST-API-style nested `content.raw`/`content.rendered` in case
// this ability's shape differs) and degrades cleanly to `unknown` if none
// match — NEVER a crash, and never a false "fresh". A fixture-backed
// acceptance test proving the real shape is deliberately a follow-up:
// adding it to `equivalence.spec.ts` would bump that file's provenance hash
// (`equivalenceSha256`) and force a full capture-refresh cycle for a
// single-field question — disclosed where this change is reviewed, not
// silently skipped.
//
// A site whose community MCP stack doesn't expose this ability at all
// (`tool_not_found`) degrades to `unknown` rather than attempting an
// unverified `ewpa/get-posts`-list reconstruction: that list ability's own
// captured response (verify-verdicts.json) does not evidence a modified-date
// field or full rendered content per row, so a list-based fallback would be
// a materially weaker, equally-unverified freshness signal — not a real
// hardening, just a different guess. A deliberate, disclosed narrowing for
// this read-only freshness leg.

import { createHash } from "node:crypto";

import {
  type FreshnessAdapter,
  type FreshnessState,
} from "./contract";
// The invoker stack is resolved LAZILY (dynamic import at probe time, never
// at module load) — the same discipline the pre-re-point file applied to the
// relocated WordPress client, for the same reason: this adapter is loaded via
// `object-history/index.ts` by many light consumers (UI server actions, the
// objects package's MCP handlers, unit tests), and a STATIC value-import of
// `register-host-connector-services` would drag the entire host wiring graph
// (~70 imports deep — DB / audit / MCP-SDK chains) into every one of them. A
// failed lazy resolution folds through the adapter's existing outer try/catch
// to an `unknown` freshness verdict — never a crash of the freshness sweep.
// Type-only imports are erased at compile time and stay static.
import type { InvokerTrustedActor } from "@/lib/connector-instance-invoker";

/** Lazily resolve the governed-invoker stack (see the import-discipline note
 * above). Split per module so vitest `vi.mock` factories intercept each one
 * independently, exactly as they would a static import. */
async function loadInvokerStack() {
  const [invoker, hostServices, writeAuthority, transport] = await Promise.all([
    import("@/lib/connector-instance-invoker"),
    import("@/lib/register-host-connector-services"),
    import("@/lib/connector-instance-write-authority"),
    import("@/lib/connector-instance-mcp-transport"),
  ]);
  return {
    invokeConnectorInstanceTool: invoker.invokeConnectorInstanceTool,
    buildConnectorInstanceInvokerDeps: hostServices.buildConnectorInstanceInvokerDeps,
    resolveTrustedWriteActor: writeAuthority.resolveTrustedWriteActor,
    InvokerError: transport.InvokerError,
  };
}

type ProbeResult =
  | {
      ok: true;
      modifiedGmt: string | null;
      /** True ONLY when a RECOGNIZED content field was actually present in the
       * payload. When false, `contentHash` is the hash of the empty string and
       * MUST NOT be used as a comparison signal (an unrecognized ability
       * response shape would otherwise alias the empty document — the
       * false-fresh-by-empty-hash trap). */
      contentFound: boolean;
      contentHash: string;
      contentRaw: string;
    }
  | { ok: false; kind: "missing" }
  | { ok: false; kind: "unknown"; reason: string };

/** Case-insensitive substring check against a handful of "the remote object
 * doesn't exist" phrasings a WP_Error passthrough or an ability's own
 * `{success:false, error}` envelope plausibly uses. Deliberately permissive
 * (a false positive here just means "missing" instead of "unknown" — both
 * already block automatic restore per the freshness contract, so the blast
 * radius of a wrong guess is small); never used to decide `fresh`. */
function looksLikeNotFound(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("invalid_id") ||
    m.includes("invalid id") ||
    m.includes("not found") ||
    m.includes("no post") ||
    m.includes("no page") ||
    m.includes("does not exist") ||
    m.includes("rest_post_invalid_id")
  );
}

/** Defensive multi-name extraction — see the file-header DISCLOSED GAP note.
 * Tries the flat WP_Post-style field first (matching this plugin's OTHER
 * abilities' observed convention), then a couple of plausible variants. */
function extractModifiedGmt(data: Record<string, unknown>): string | null {
  for (const key of ["post_modified_gmt", "modified_gmt", "modified"]) {
    const v = data[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/** Defensive multi-name content extraction (flat `post_content`, a bare
 * `content` string, or a REST-API-style nested `content.raw`/`.rendered`).
 * `found: false` means NO recognized content field was present — the caller
 * must treat the content signal as absent, never as an empty document. */
function extractContentRaw(data: Record<string, unknown>): { content: string; found: boolean } {
  if (typeof data.post_content === "string") return { content: data.post_content, found: true };
  if (typeof data.content === "string") return { content: data.content, found: true };
  if (data.content && typeof data.content === "object") {
    const c = data.content as Record<string, unknown>;
    if (typeof c.raw === "string") return { content: c.raw, found: true };
    if (typeof c.rendered === "string") return { content: c.rendered, found: true };
  }
  return { content: "", found: false };
}

/** Unwrap an ability's payload: abilities in this catalog have been observed
 * (verify-verdicts.json: create-post, update-post-meta) wrapping the real
 * fields under `{success, data:{...}}`; prefer that when present and
 * object-shaped, else treat the top-level object as the payload itself. */
function unwrapAbilityPayload(raw: unknown): {
  payload: Record<string, unknown>;
  success: boolean | null;
  failureMessage: string;
} {
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const success = typeof data.success === "boolean" ? data.success : null;
  const payload =
    data.data && typeof data.data === "object" ? (data.data as Record<string, unknown>) : data;
  const failureMessage =
    typeof data.error === "string"
      ? data.error
      : typeof data.message === "string"
        ? data.message
        : "";
  return { payload, success, failureMessage };
}

// Probe the remote post/page through the governed invoker (cinatra#2022
// S7). One call per object — the invoker has no batch-call surface — but the
// catalog snapshot behind it is shared across every call for the same
// instance via the invoker's own per-process cache (buildConnectorInstanceInvokerDeps
// closes over the SAME cache singleton every call, so a fresh-within-TTL
// snapshot never re-triggers a `tools/list` discovery). Bounded concurrency
// / per-instance-session timeout across MULTIPLE objects in one sweep is the
// sweep orchestrator's job (../resolve.ts), not this per-object probe's.
async function fetchPostStatus(
  stack: Awaited<ReturnType<typeof loadInvokerStack>>,
  instanceId: string,
  remoteId: string,
  postType: string,
  trustedActor: InvokerTrustedActor,
  causation: string,
): Promise<ProbeResult> {
  const toolName = postType === "page" ? "ewpa/get-page" : "ewpa/get-post";
  // `post_id` matches the ONE fully-captured single-post-targeting ability
  // schema this fixture evidences (`ewpa/delete-post`: `{post_id: integer}`,
  // tests/e2e/wp-mcp-gateway/captures/annotations-d-eafm-coverage.json) —
  // the best-evidenced guess available without booting the fixture (see the
  // file-header DISCLOSED GAP note).
  const args = { post_id: Number(remoteId) };

  let raw: unknown;
  try {
    raw = await stack.invokeConnectorInstanceTool(
      {
        connectorKey: "wordpress",
        instanceId,
        toolName,
        args,
        actor: trustedActor,
        primitiveName: "wordpress_freshness_check",
        sourceType: "freshness_sweep",
        causation,
      },
      stack.buildConnectorInstanceInvokerDeps("wordpress"),
    );
  } catch (e) {
    if (e instanceof stack.InvokerError) {
      if (e.code === "tool_error") {
        // Ability-level failure (WP_Error passthrough). A "not found"-shaped
        // message maps to `missing`; anything else (permission, malformed
        // args, etc.) degrades to `unknown` — never assume missing on a
        // generic ability error (mirrors the pre-re-point 404-only `missing`
        // discipline).
        return looksLikeNotFound(e.message)
          ? { ok: false, kind: "missing" }
          : { ok: false, kind: "unknown", reason: `wordpress ability error: ${e.message}` };
      }
      if (e.code === "tool_not_found") {
        // This instance's community stack doesn't expose the ability at all
        // — disclosed narrowing (file header): degrade to unknown rather
        // than an unverified list-based reconstruction.
        return {
          ok: false,
          kind: "unknown",
          reason: `ability "${toolName}" is not present in this instance's catalog`,
        };
      }
      // Every other InvokerError (network_error, timeout, session_required,
      // catalog_unavailable, tool_policy_denied, ambiguous_tool,
      // instance_id_required, instance_pin_mismatch, pending_confirmation,
      // confirmation_unavailable, empty_response, invalid_response,
      // connector_key_underivable, ...) is a transient/authorization/shape
      // condition, never proof the remote object is gone.
      return {
        ok: false,
        kind: "unknown",
        reason: `wordpress probe failed: ${e.code} ${e.message}`,
      };
    }
    throw e;
  }

  const { payload, success, failureMessage } = unwrapAbilityPayload(raw);
  if (success === false) {
    return looksLikeNotFound(failureMessage)
      ? { ok: false, kind: "missing" }
      : {
          ok: false,
          kind: "unknown",
          reason: `wordpress ability reported failure: ${failureMessage || "unknown reason"}`,
        };
  }

  const modifiedGmt = extractModifiedGmt(payload);
  const { content: contentRaw, found: contentFound } = extractContentRaw(payload);
  const contentHash = createHash("sha256").update(contentRaw).digest("hex");
  return { ok: true, modifiedGmt, contentFound, contentHash, contentRaw };
}

export const wordpressFreshnessAdapter: FreshnessAdapter = {
  connectorName: "wordpress",
  async check({ objectId, orgId, remoteRevisionRef }): Promise<FreshnessState> {
    if (
      !remoteRevisionRef ||
      remoteRevisionRef.connector !== "wordpress" ||
      !remoteRevisionRef.remoteId
    ) {
      // The local object isn't WordPress-tagged at all.
      return { state: "unsupported" };
    }
    // Resolve the WordPress instance id. RemoteRevisionRef carries `extra`
    // metadata; we expect `instanceId` to be present so the invoker can
    // scope the call. If absent, the adapter is unsupported for this row.
    const ref = remoteRevisionRef as unknown as {
      connector: string;
      kind: string;
      remoteId: string;
      revisionId?: string;
      modifiedAt?: string;
      extra?: { instanceId?: string; postType?: string; contentHash?: string };
    };
    const instanceId = ref.extra?.instanceId;
    if (!instanceId) {
      return {
        state: "unknown",
        reason: "remoteRevisionRef missing extra.instanceId",
      };
    }

    let probe: ProbeResult;
    try {
      // Lazy invoker-stack resolution (see the import-discipline note at the
      // top of this file) — a load failure folds to `unknown` via this catch.
      const stack = await loadInvokerStack();

      // Host-derived trusted actor (cinatra#2017 S2 §2.4) — NEVER connector /
      // tool input. Works from whichever ambient trusted-context store is
      // live (llm / MCP request / cookie session), matching every other
      // invoker consumer. Absent (no live actor resolvable) degrades to
      // `unknown` rather than probing with no authorization context.
      const resolvedActor = await stack.resolveTrustedWriteActor();
      if (!resolvedActor) {
        return {
          state: "unknown",
          reason: "no trusted actor available for the freshness check",
        };
      }
      // Org-binding assertion: the freshness verdict is FOR a change-set
      // loaded under `orgId`; the probe must be authorized under that SAME
      // authority domain. A mismatched ambient actor (a cross-org store mixup
      // would be a caller bug) degrades to `unknown` rather than returning a
      // real verdict authorized under the wrong org.
      if (orgId && resolvedActor.orgId !== orgId) {
        return {
          state: "unknown",
          reason: "trusted actor's organization does not match the change-set organization",
        };
      }
      const trustedActor: InvokerTrustedActor = {
        actor: resolvedActor.actor,
        userId: resolvedActor.userId,
        orgId: resolvedActor.orgId,
      };

      probe = await fetchPostStatus(
        stack,
        instanceId,
        ref.remoteId,
        ref.extra?.postType ?? "post",
        trustedActor,
        objectId,
      );
    } catch (e) {
      return {
        state: "unknown",
        reason: `wordpress probe failed: ${(e as Error).message}`,
      };
    }
    if (!probe.ok) {
      if (probe.kind === "missing") return { state: "missing" };
      return { state: "unknown", reason: probe.reason };
    }
    // Compare modified timestamp + content hash against what we captured.
    //
    // `fresh` is returned ONLY when at least one comparison ACTUALLY RAN and
    // passed. Signals that could not be compared (a captured value with no
    // recognized remote counterpart, or vice versa) are NEVER treated as
    // implicit matches — with the ability's exact response shape uncaptured
    // (file-header DISCLOSED GAP), an unrecognized payload must land on
    // `unknown`, never on a false `fresh`. In particular:
    //   - `probe.contentFound === false` means NO recognized content field
    //     was in the payload; the empty-string hash it produces is an
    //     artifact, not a document (the empty-hash-alias trap), so a captured
    //     contentHash cannot be verified -> unknown, not fresh.
    //   - a captured modifiedAt with no recognized remote timestamp is
    //     likewise not comparable (the pre-re-point code silently treated
    //     this as passing — a latent false-fresh, fixed here).
    const capturedModifiedAt = ref.modifiedAt;
    const capturedContentHash = ref.extra?.contentHash;
    if (!probe.modifiedGmt && !probe.contentFound) {
      return {
        state: "unknown",
        reason:
          "wordpress ability response had no recognized modified-timestamp or content field (unrecognized shape)",
      };
    }
    const baseRevision = probe.modifiedGmt ?? probe.contentHash;
    let comparisonsPassed = 0;
    if (capturedModifiedAt && probe.modifiedGmt) {
      // ISO/timestamp comparison — if they don't match, remote was edited.
      if (capturedModifiedAt !== probe.modifiedGmt) {
        return {
          state: "changed",
          baseRevision,
          changedFields: ["content"],
        };
      }
      comparisonsPassed += 1;
    }
    if (capturedContentHash) {
      if (!probe.contentFound) {
        return {
          state: "unknown",
          reason:
            "captured contentHash cannot be verified: no recognized content field in the ability response",
        };
      }
      if (capturedContentHash !== probe.contentHash) {
        return {
          state: "changed",
          baseRevision,
          changedFields: ["content"],
        };
      }
      comparisonsPassed += 1;
    }
    if (comparisonsPassed === 0) {
      // Nothing was actually comparable (nothing captured, or the captured
      // signal has no recognized remote counterpart). Return unknown rather
      // than pretending fresh.
      return {
        state: "unknown",
        reason:
          "no captured freshness signal was comparable against the ability response",
      };
    }
    return { state: "fresh", baseRevision };
  },
};
