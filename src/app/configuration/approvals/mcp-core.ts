/**
 * Framework-free core for the unified `approvals_*` MCP tools (#1048).
 *
 * These pure functions federate the SAME `ApprovalSource` registry the
 * `/configuration/approvals` UI renders, and route every decision through the
 * SAME per-source `actions.decide` helper (the non-redirecting helper shared
 * with the UI server actions). There is NO parallel decision path and NO
 * redirect: the MCP boundary gets the source's own authorization, SoD (incl.
 * the single-admin bypass), audit behavior and structured errors identically.
 *
 * Deliberately dependency-light: it imports ONLY the type contract, takes the
 * `sources` array as an explicit argument (the server-only module passes the
 * real `approvalSourceRegistry`; tests pass fakes), and touches no React / DB /
 * `server-only` module — so every branch (list resilience, unavailable sources,
 * get-by-id precedence, decide routing, unknown/mismatched sourceId) is unit
 * testable without a running stack.
 *
 * Parity with the UI section model (#1044/#1045): a source's coarse
 * `availability(viewer)` already encodes marketplace group-connectivity
 * (`marketplaceAvailability()` returns `not_connected` when no credential
 * resolves), so a not-connected source is listed WITHOUT firing a remote call;
 * a per-direction `sectionConfigured` gate surfaces a misconfigured credential
 * as `not_configured` rather than silently masking it. A remote failure (a
 * non-`ready` envelope or a thrown fetch) NEVER errors the whole call or blocks
 * a local section — it is reported in `unavailableSources`.
 */
import type {
  ApprovalAction,
  ApprovalRow,
  ApprovalSource,
  ApprovalViewer,
  Availability,
  DecideResult,
  Direction,
  FetchOpts,
} from "./sources/types";

/** A row as surfaced to an MCP caller: the public {@link ApprovalRow} shape with
 *  the ADAPTER-PRIVATE `raw` field stripped (never serialized past the source's
 *  own rowRenderer). `version` is the source-declared optimistic-concurrency
 *  token a caller round-trips back into `approvals_decide` (`expectedVersion`). */
export type ApprovalItem = Omit<ApprovalRow, "raw">;

export interface SourceRows {
  sourceId: string;
  title: string;
  /** Per-source count for this direction (the returned actionable window). */
  count: number;
  actions: ApprovalAction[];
  rows: ApprovalItem[];
}

export interface UnavailableSource {
  sourceId: string;
  title: string;
  availability: Exclude<Availability, "ready">;
  reason?: string;
}

export interface ApprovalsListResult {
  direction: Direction;
  sources: SourceRows[];
  unavailableSources: UnavailableSource[];
  /** Sum of per-source counts across the ready sources. */
  totalCount: number;
}

export type ApprovalsGetResult =
  | { ok: true; item: ApprovalItem & { direction: Direction }; actions: ApprovalAction[] }
  | { ok: false; code: string; message: string };

/** Strip the adapter-private `raw` before a row leaves the source boundary. */
export function toItem(row: ApprovalRow): ApprovalItem {
  // Explicit allow-list projection — never spread `raw` through.
  const { raw: _raw, ...pub } = row;
  void _raw;
  return pub;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type SourceFetch =
  | { ok: true; rows: ApprovalRow[]; actions: ApprovalAction[] }
  | { ok: false; availability: Exclude<Availability, "ready">; reason?: string };

/**
 * Resolve one source for one direction WITHOUT ever throwing: coarse
 * availability first (encodes marketplace connectivity — a not-connected source
 * is reported without a remote call), then the per-direction `sectionConfigured`
 * credential gate, then the guarded fetch (a thrown fetch or a non-`ready`
 * envelope becomes a reported unavailable state, never a blocked sibling).
 * Assumes the caller already checked `appliesTo(viewer, direction)`.
 */
async function fetchSource(
  source: ApprovalSource,
  viewer: ApprovalViewer,
  direction: Direction,
  opts: FetchOpts | undefined,
): Promise<SourceFetch> {
  let coarse: Availability;
  try {
    coarse = await source.availability(viewer);
  } catch (err) {
    return { ok: false, availability: "error", reason: errMessage(err) };
  }
  if (coarse !== "ready") {
    return { ok: false, availability: coarse };
  }
  // Per-direction credential gate (local read only, no network) — a configured
  // group whose own section credential is absent is `not_configured`, so a
  // misconfiguration is discoverable rather than silently masked. Guarded like
  // `availability` above so a throwing predicate is reported, never propagated.
  try {
    if (source.sectionConfigured && !source.sectionConfigured(viewer, direction)) {
      return { ok: false, availability: "not_configured" };
    }
  } catch (err) {
    return { ok: false, availability: "error", reason: errMessage(err) };
  }
  let env;
  try {
    env = direction === "inbox"
      ? await source.fetchInbox(viewer, opts)
      : await source.fetchMine(viewer, opts);
  } catch (err) {
    return { ok: false, availability: "error", reason: errMessage(err) };
  }
  if (env.availability !== "ready") {
    return { ok: false, availability: env.availability, reason: env.error?.message };
  }
  return { ok: true, rows: env.rows, actions: env.actions };
}

/**
 * `approvals_list` core. Federates `direction`'s applicable sources; a source
 * that is not connected / not configured / errored / throwing is reported in
 * `unavailableSources` rather than erroring the call. `opts.sourceId` narrows to
 * a single source (already validated by the handler); `opts.status` is a
 * source-interpreted history filter (the agent "Your requests" window).
 */
export async function collectApprovals(
  sources: ApprovalSource[],
  viewer: ApprovalViewer,
  direction: Direction,
  opts?: FetchOpts & { sourceId?: string },
): Promise<ApprovalsListResult> {
  const wantSource = opts?.sourceId;
  const fetchOpts: FetchOpts | undefined = opts?.status ? { status: opts.status } : undefined;

  const ready: SourceRows[] = [];
  const unavailable: UnavailableSource[] = [];

  // Sequential is fine (v1 has a handful of sources); it also keeps the audit /
  // remote-call ordering deterministic. Each source is fully guarded — a throw
  // anywhere (appliesTo / sectionConfigured / availability / fetch) is reported
  // as an errored source, never blocking the call or a sibling. A source that is
  // simply NOT APPLICABLE to this direction/viewer is skipped silently (not
  // reported) — "not applicable" ≠ "unavailable".
  for (const source of sources) {
    if (wantSource && source.id !== wantSource) continue;
    try {
      if (!source.appliesTo(viewer, direction)) continue;
      const res = await fetchSource(source, viewer, direction, fetchOpts);
      if (res.ok) {
        ready.push({
          sourceId: source.id,
          title: source.title,
          count: res.rows.length,
          actions: res.actions,
          rows: res.rows.map(toItem),
        });
      } else {
        unavailable.push({
          sourceId: source.id,
          title: source.title,
          availability: res.availability,
          ...(res.reason ? { reason: res.reason } : {}),
        });
      }
    } catch (err) {
      unavailable.push({ sourceId: source.id, title: source.title, availability: "error", reason: errMessage(err) });
    }
  }

  return {
    direction,
    sources: ready,
    unavailableSources: unavailable,
    totalCount: ready.reduce((sum, s) => sum + s.count, 0),
  };
}

/**
 * `approvals_get` core. `sourceId` is REQUIRED and must resolve to a registered
 * source (an unknown id is rejected — an unqualified id must never be routed to
 * the wrong source). There is no per-source get-by-id in the adapter contract,
 * so the item is located by fetching the source's rows: Inbox first (the
 * actionable view), then "Your requests"; the first `{sourceId,id}` match wins
 * and its originating `direction` is returned. A source that is unavailable in
 * every applicable direction surfaces its connectivity state; a source with no
 * matching row surfaces `not_found`.
 */
export async function getApprovalItem(
  sources: ApprovalSource[],
  viewer: ApprovalViewer,
  sourceId: string,
  id: string,
): Promise<ApprovalsGetResult> {
  const source = sources.find((s) => s.id === sourceId);
  if (!source) {
    return { ok: false, code: "unknown_source", message: `Unknown approval source '${sourceId}'.` };
  }

  let lastUnavailable: { availability: Exclude<Availability, "ready">; reason?: string } | undefined;
  let anyApplicable = false;

  for (const direction of ["inbox", "mine"] as const) {
    // Fully guarded per direction: a throwing appliesTo / fetch never propagates
    // — it is recorded as an error state and the other direction still tried.
    try {
      if (!source.appliesTo(viewer, direction)) continue;
      anyApplicable = true;
      const res = await fetchSource(source, viewer, direction, undefined);
      if (!res.ok) {
        lastUnavailable = { availability: res.availability, ...(res.reason ? { reason: res.reason } : {}) };
        continue;
      }
      const row = res.rows.find((r) => r.id === id);
      if (row) {
        return { ok: true, item: { ...toItem(row), direction }, actions: res.actions };
      }
    } catch (err) {
      lastUnavailable = { availability: "error", reason: errMessage(err) };
    }
  }

  // Surface a concrete error/unavailable state ahead of `forbidden`: an
  // indeterminate failure must not masquerade as a definitive permission denial.
  if (lastUnavailable) {
    return {
      ok: false,
      code: lastUnavailable.availability,
      message: lastUnavailable.reason ?? `Source '${sourceId}' is ${lastUnavailable.availability}.`,
    };
  }
  if (!anyApplicable) {
    // The viewer cannot participate in this source in any direction (e.g. a
    // non-admin asking for an admin-only moderation source).
    return { ok: false, code: "forbidden", message: `You cannot view '${sourceId}' items.` };
  }
  return { ok: false, code: "not_found", message: `No '${sourceId}' item with id '${id}'.` };
}

/**
 * `approvals_decide` core. `sourceId` is REQUIRED and must resolve to a
 * registered source (an unknown/mismatched id is rejected up front so an
 * unqualified id is never routed to the wrong source). It delegates to the
 * source's OWN `actions.decide` helper — the SAME non-redirecting helper the UI
 * server action uses — so authorization, SoD (incl. the single-admin bypass),
 * audit writes and structured refusals are identical to the UI. `expectedVersion`
 * is the optimistic-concurrency token a source that declares one (e.g. the agent
 * creation source's snapshot hash) REQUIRES; obtain it from `approvals_get` /
 * `approvals_list` `version` — the helper refuses when it is absent/stale rather
 * than reading a fresh value, preserving the capture-then-decide CAS guard.
 */
export async function decideApproval(
  sources: ApprovalSource[],
  viewer: ApprovalViewer,
  input: { sourceId: string; id: string; decision: "approve" | "reject"; reason?: string; expectedVersion?: string },
): Promise<DecideResult> {
  const source = sources.find((s) => s.id === input.sourceId);
  if (!source) {
    return {
      ok: false,
      kind: "refused",
      code: "unknown_source",
      message: `Unknown approval source '${input.sourceId}'.`,
    };
  }
  return source.actions.decide(
    {
      rowId: input.id,
      action: input.decision,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.expectedVersion ? { expectedVersion: input.expectedVersion } : {}),
    },
    viewer,
  );
}
