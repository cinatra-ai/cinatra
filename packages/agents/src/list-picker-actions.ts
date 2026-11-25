"use server";

import "server-only";

import { resolveCrmListReader } from "@/lib/crm-integration-providers";
import {
  requireActorContext,
  requireAuthSession,
  resolveOrgRoleForUser,
} from "@/lib/auth-session";
import { actorFromSession, type ActorRoleHints } from "@/lib/authz/build-actor-context";
import type { AgentRunRecord } from "./agent-run-record";
import { enforceRunAccess } from "./auth-policy";
import { readAgentRunById, readLatestDurableHitlGateArtifact } from "./store";

// The picker still exposes the legacy `AvailableListSummary` shape so its
// downstream consumers (orchestrator panels, list-curator scrape renderer,
// agent-builder steppers) don't need to migrate in the same slice. The
// source of truth is the CRM list-read capability surface — registered by the
// crm-connector's `register(ctx)` over the Twenty Views provider — resolved
// at call time instead of value-importing the connector package
// (cinatra#151 Stage 4); the outward shape is preserved.
//
// Field mapping from CrmList -> AvailableListSummary:
//   id          : CrmList.id
//   name        : CrmList.name
//   memberCount : NOT available from `crm_list_search` (Twenty Views are
//                 filter-defined, not materialized). Until the resolver
//                 wires per-view membership counts, this surfaces as null.
//   lastUpdated : not part of the CrmList shape; surfaces as null.
//   memberType  : derived from CrmList.objectType ("contact" / "account").
//                 The legacy "mixed" branch is gone — Twenty Views are
//                 single-type. Downstream `mixed` consumers fall back to
//                 the "contact" branch (the picker's only callers today
//                 work with contact lists).

export type AvailableListSummary = {
  id: string;
  name: string;
  /** null when the CRM provider does not expose a materialized member count. */
  memberCount: number | null;
  /** null when the CRM provider does not expose a last-updated timestamp. */
  lastUpdated: string | null;
  memberType: "account" | "contact" | "mixed";
};

/**
 * Authorize the CALLER against the RUN whose step is being drawn, for the
 * `read` operation — the canonical run-access rule (`enforceRunAccess`), the
 * same one the run page itself is drawn behind.
 *
 * Why this replaced the platform-administrator gate (cinatra#3050): drawing a
 * step of a run is not a platform-administration act. The picker's loader used
 * to open with `requireAdminSession()`, which REDIRECTS a caller without the
 * `admin` role to `/not-authorized` — so the ordinary owner of a run was thrown
 * off their own run the moment it reached the step this renderer draws. The
 * run, not the platform role, is the authority.
 *
 * `readAgentRunById(id, actor, roles)` is the canonical read seam: it resolves
 * the run's effective policy and its co-owner list and hands them to
 * `enforceRunAccess(..., "read", roles)`. That yields exactly the refusal shape
 * the run page gives — AuthzError 404 "hidden" for a run the caller may not
 * know exists, AuthzError 403 "forbidden" for a policy denial — and never a
 * redirect to an administrator screen.
 *
 * A missing or non-string run identifier takes the SAME hidden-run refusal as
 * an unknown one (`enforceRunAccess(null, …)`), so a caller cannot tell a
 * malformed id from a foreign run, and no CRM capability is resolved on the way
 * out.
 *
 * The role hints mirror `requireHitlActor` (actions.ts): the kernel context
 * carries the org role, team memberships and project grants that let a
 * non-administrator member reach their own run, and `actorOrganizationId` is
 * the actor's ACTIVE org — never `run.orgId`, which would weaken the cross-org
 * guard.
 */
async function requireRunReadAccess(runId: unknown): Promise<AgentRunRecord | null> {
  const session = await requireAuthSession();
  const kernel = await requireActorContext();
  const actor = actorFromSession(session);
  const roleHints: ActorRoleHints = {
    ...(kernel.platformRole ? { platformRole: kernel.platformRole } : {}),
    ...(kernel.orgRole ? { orgRole: kernel.orgRole } : {}),
    ...(kernel.teamRoles ? { teamRoles: kernel.teamRoles } : {}),
    ...(kernel.teamIds ? { teamIds: kernel.teamIds } : {}),
    ...(kernel.projectGrants ? { projectGrants: kernel.projectGrants } : {}),
    actorOrganizationId: kernel.organizationId ?? null,
  };

  if (typeof runId !== "string" || runId.trim() === "") {
    // Same hidden-run absence as an unknown id — no DB round-trip needed.
    await enforceRunAccess(null, actor, "read", roleHints);
    return null;
  }

  return readAgentRunById(runId, actor, roleHints);
}

/**
 * The only class words a failed CRM list search may write to the log. The
 * thrown value's `name` is compared with these literals (never matched by a
 * pattern), and the literal of this list is what is logged, so no text of the
 * thrown value reaches the line. The connector classes are named here as
 * strings only: the loader never imports a connector.
 */
const LOGGABLE_ERROR_CLASSES = Object.freeze([
  "Error",
  "SyntaxError",
  "TwentyConfigError",
  "TwentyMcpError",
  "TwentyToolContractError",
  "TypeError",
] as const);

/**
 * `<Class>` or `<Class>, code <n>` for a failed search, built from constants
 * and an in-range integer only. `<Class>` is a literal of
 * LOGGABLE_ERROR_CLASSES when the value is an Error whose `name` is a string
 * equal to one of them, else `UnknownError`. The code is written only for a
 * listed class and only when it is an integer HTTP status (100-599) or
 * JSON-RPC code (-32768 to -32000). A getter or a proxy that throws while
 * either is read gives `UnknownError`; that second error is dropped.
 */
function describeSearchFailure(err: unknown): string {
  try {
    if (!(err instanceof Error)) return "UnknownError";
    const name: unknown = err.name;
    if (typeof name !== "string") return "UnknownError";
    const loggedClass = LOGGABLE_ERROR_CLASSES.find((listed) => listed === name);
    if (loggedClass === undefined) return "UnknownError";
    const code: unknown = (err as { code?: unknown }).code;
    if (
      typeof code === "number" &&
      Number.isInteger(code) &&
      ((code >= 100 && code <= 599) || (code >= -32768 && code <= -32000))
    ) {
      return `${loggedClass}, code ${code}`;
    }
    return loggedClass;
  } catch {
    return "UnknownError";
  }
}

/**
 * @param runId - the `agent_run` this step belongs to, threaded by the
 *   renderer from `context.runId` (the shared field-renderer contract).
 */
export async function fetchAvailableLists(
  runId: string,
): Promise<AvailableListSummary[]> {
  // Run-access gate FIRST — no CRM capability is resolved or called before it.
  await requireRunReadAccess(runId);

  // Capability absent (crm-connector not installed/active — it is
  // acquirable-on-demand, not required) degrades to "no lists available".
  // Unlike a failed search below, this is not an error: the picker offers no
  // lists, and one fixed line in the server log says why.
  const reader = resolveCrmListReader();
  if (!reader) {
    console.warn(
      "[list-picker] no crm-list-reader capability is registered; the picker offers no lists",
    );
    return [];
  }

  let lists;
  try {
    // Picker shows contact-eligible lists. The provider reads the views of
    // each object type it is asked for (here: contacts) and counts a view as a
    // list only when the view carries the `inLists CONTAINS <slug>` filter;
    // every other view of that object is left out.
    //
    // SCOPE IS UNCHANGED by the run-access gate (cinatra#3050): the call and
    // its arguments are byte-identical to what the administrator-gated loader
    // issued, so an admitted caller sees exactly the set an administrator saw
    // — no widening. The reader contract takes only `query` + `objectType`
    // (packages/sdk-extensions/src/crm-list-reader-contract.ts), so it carries
    // no actor; per-actor list scoping is a separate change.
    lists = await reader.searchLists({ query: "", objectType: "contact" });
  } catch (err) {
    // A failed search is NOT an empty CRM: reject, so the picker shows its
    // existing load error instead of "No lists yet".
    //
    // What leaves this function is fixed words only. The log line names the
    // error's class only as a literal of LOGGABLE_ERROR_CLASSES (anything
    // else is `UnknownError`) and a code only when it is an in-range integer.
    // The thrown value's message, `data`, `cause` and any body are never
    // logged, never carried and never stringified, and the new error has no
    // `cause` (the framework's server error log prints the cause chain).
    console.warn(
      `[list-picker] the CRM list search failed (${describeSearchFailure(err)}); the picker shows the load error`,
    );
    throw new Error("the CRM list search failed");
  }

  if (lists.length === 0) {
    console.warn("[list-picker] the CRM list search answered no lists");
    return [];
  }

  return lists.map((l) => ({
    id: l.id,
    name: l.name,
    memberCount: null,
    lastUpdated: null,
    memberType: l.objectType,
  }));
}

// ---------------------------------------------------------------------------
// The list step's new read (cinatra#3562)
// ---------------------------------------------------------------------------

/**
 * What a list step holds: the CRM lists by id and name, and whether the read
 * worked. The step's `value` has this shape, and so has the answer of
 * `readListStepContent`.
 */
export type ListStepContent = {
  lists: Array<{ id: string; name: string }>;
  listsRead: "ok" | "failed";
};

/** The fixed refusal when the run is not waiting at a list step. */
const LIST_STEP_NOT_WAITING = "list_step_not_waiting";

/** A run that waits for a person stands at this status. */
const WAITING_RUN_STATUS = "pending_approval";

/** The renderer id of a list step ends with this. */
const LIST_STEP_RENDERER_SUFFIX = ":list-picker";

/** The tool the flow itself reads the lists with; its boundary decision is asked for the run. */
const CRM_LIST_READ_TOOL = "crm_list_search";

function failedListStepContent(): ListStepContent {
  return { lists: [], listsRead: "failed" };
}

/**
 * May the RUN itself read the CRM lists? The same boundary decision the
 * flow's own list-read tool call is checked with (`enforceMcpBoundary`, the
 * `connector_instance` / `list` classification), asked for the run's own
 * frame: the run's organization, the person the run acts for, and the run's
 * stored on-behalf-of ceiling. A ceiling narrower than the organization is
 * refused there, before any role short-circuit.
 *
 * Fail-closed: a run without a stored ceiling (its own call falls back to the
 * machine token, which the boundary refuses), a run without a person, and any
 * fault while the decision is asked answer `false`.
 */
async function runMayReadCrmLists(run: AgentRunRecord): Promise<boolean> {
  if (!run.oboCeiling || run.oboCeiling.length === 0) return false;
  if (typeof run.runBy !== "string" || run.runBy.length === 0) return false;
  try {
    const { enforceMcpBoundary } = await import("@/lib/authz/mcp-boundary");
    const orgRole = await resolveOrgRoleForUser(run.orgId, run.runBy);
    const decision = await enforceMcpBoundary({
      primitiveName: CRM_LIST_READ_TOOL,
      delegatedRestricted: false,
      ctx: {
        orgId: run.orgId,
        userId: run.runBy,
        ...(orgRole ? { orgRole } : {}),
        runId: run.id,
        oboCeiling: run.oboCeiling,
      },
    });
    return decision.allowed === true;
  } catch {
    return false;
  }
}

/**
 * The lists a read answered, as the step draws them: only a non-blank id and
 * a non-blank name, and a repeated id once (the first one read).
 */
function toListStepLists(
  lists: ReadonlyArray<{ id?: unknown; name?: unknown }>,
): ListStepContent["lists"] {
  const seen = new Set<string>();
  const out: ListStepContent["lists"] = [];
  for (const list of lists) {
    const id = list?.id;
    const name = list?.name;
    if (typeof id !== "string" || id.trim() === "") continue;
    if (typeof name !== "string" || name.trim() === "") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}

/**
 * Read the CRM lists again for the list step the run waits at (cinatra#3562).
 * A step's Try again calls this; nothing is sent to the run, the run does not
 * resume, and no gate is answered. The checks, in order:
 *
 *   1. the signed-in person may read the run (the run page's rule, as
 *      `fetchAvailableLists`); a refusal is thrown before anything else is read;
 *   2. the run waits now (`pending_approval`) at a list step: its newest
 *      durable gate names a renderer that ends with `:list-picker`, and, when
 *      a review task is named, it is that gate's. Otherwise the fixed refusal
 *      `list_step_not_waiting` is thrown and no CRM call is made. This is
 *      stricter than `fetchAvailableLists`, which reads the lists for any run
 *      the person may read;
 *   3. the run itself may read the CRM lists (`runMayReadCrmLists`); if not,
 *      the failed shape, with no CRM call;
 *   4. the CRM list read, with the same arguments as `fetchAvailableLists`. A
 *      missing capability and a failed read answer the failed shape; no error
 *      text leaves this function, and the log line is fixed words.
 *
 * Each read that passes check 2 writes one log line with the run and the
 * review task, and no value.
 */
export async function readListStepContent(
  runId: string,
  reviewTaskId?: string,
): Promise<ListStepContent> {
  const run = await requireRunReadAccess(runId);

  const namedTask =
    typeof reviewTaskId === "string" && reviewTaskId.length > 0 ? reviewTaskId : null;
  const gate =
    run !== null && run.status === WAITING_RUN_STATUS
      ? await readLatestDurableHitlGateArtifact(run.id).catch(() => null)
      : null;
  if (
    run === null ||
    gate === null ||
    typeof gate.xRenderer !== "string" ||
    !gate.xRenderer.endsWith(LIST_STEP_RENDERER_SUFFIX) ||
    (namedTask !== null && gate.reviewTaskId !== namedTask)
  ) {
    console.warn("[list-picker] a new list read was refused: the run is not waiting at a list step");
    throw new Error(LIST_STEP_NOT_WAITING);
  }

  console.info(
    `[list-picker] the list step is read again (run ${run.id}, review task ${gate.reviewTaskId})`,
  );

  if (!(await runMayReadCrmLists(run))) {
    console.warn("[list-picker] the run may not read the CRM lists; the step shows the failed read");
    return failedListStepContent();
  }

  const reader = resolveCrmListReader();
  if (!reader) {
    console.warn(
      "[list-picker] no crm-list-reader capability is registered; the step shows the failed read",
    );
    return failedListStepContent();
  }

  let lists;
  try {
    lists = await reader.searchLists({ query: "", objectType: "contact" });
  } catch (err) {
    console.warn(
      `[list-picker] the CRM list search failed (${describeSearchFailure(err)}); the step shows the failed read`,
    );
    return failedListStepContent();
  }

  if (!Array.isArray(lists)) {
    console.warn("[list-picker] the CRM list search answered no list array; the step shows the failed read");
    return failedListStepContent();
  }
  return { lists: toListStepLists(lists), listsRead: "ok" };
}
