// ---------------------------------------------------------------------------
// THE LAUNCH ANCHOR — one canonical home per persisted instance
// (cinatra#2809, per-scope surfaces S3, epic #2806).
//
// A run and a thread are now launched FROM a vantage: the workspace, an
// organization, a team, a project, or a person's own scope. The vantage a
// launch was made from is the instance's HOME, and this module is the only
// place that says so — the closed persisted union, its fail-closed decoder,
// the canonical address it derives, and the SQL that stores it.
//
// WHY A COLUMN OF ITS OWN, and why an immutable one. Every column that could
// have answered the question moves: a thread's `project_id` is the
// resource-project-move key, an org membership can change, a run's actor can
// be re-pointed. An address derived from a moving column moves with it, so a
// person's bookmark would open somewhere else — or worse, on a scope the
// launch was never made from. So the launch writes the anchor ONCE, from the
// exact route it was launched on, and nothing ever updates it.
//
// FAIL CLOSED, AND NEVER REPAIR. Unknown versions, unknown kinds, a missing or
// empty id, a workspace arm carrying an id — every one of them resolves to
// UNANCHORED, which is the flat bare route. No other column is consulted to
// guess what the row meant: inventing a home for a row whose home was never
// recorded would be recording a launch nobody made. There is deliberately no
// backfill for the same reason.
//
// USER IS FLAT BY DESIGN. `/personal` is actor-relative — it means "the person
// reading" — and a run can have other authorized viewers, so a user-anchored
// instance addressed under `/personal` would resolve to a different instance
// for each reader. Its canonical address stays the bare route, and the surface
// labels it "Personal (owner)" so the reading is not silently wrong.
//
// The model is `packages/dashboards/src/canonical-path.ts` (one canonical home
// per row, flat fallback, redirect after authorization), extended from that
// slice's two scope kinds to all five.
// ---------------------------------------------------------------------------

import { buildAgentInstancePath, type AgentPathScope } from "@/lib/agent-url";
import { WORKSPACE_SCOPE_SENTINEL } from "@/lib/assignment-scope";

/** The persisted shape's version. A reader that does not know a version treats
 *  the row as unanchored rather than guessing at its fields. */
export const LAUNCH_SCOPE_ANCHOR_VERSION = 1 as const;

/** The five vantages a launch can be made from, coarse to fine. */
export const LAUNCH_SCOPE_ANCHOR_KINDS = [
  "workspace",
  "organization",
  "team",
  "project",
  "user",
] as const;

export type LaunchScopeAnchorKind = (typeof LAUNCH_SCOPE_ANCHOR_KINDS)[number];

/**
 * The CLOSED persisted union. `id` is required for the four id-bearing kinds
 * and forbidden on the workspace, which is the instance itself and has no id
 * to point at. The user id is the ORIGINATING human.
 */
export type LaunchScopeAnchorV1 =
  | { readonly v: 1; readonly kind: "workspace" }
  | {
      readonly v: 1;
      readonly kind: "organization" | "team" | "project" | "user";
      readonly id: string;
    };

function isKind(value: unknown): value is LaunchScopeAnchorKind {
  return (
    typeof value === "string" &&
    (LAUNCH_SCOPE_ANCHOR_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Mint an anchor from a launch, or `null` when the launch does not describe a
 * scope this union can carry. A caller that gets `null` persists NO anchor —
 * it never persists a half-decided one.
 */
export function buildLaunchScopeAnchor(input: {
  kind: string | null | undefined;
  id?: string | null;
}): LaunchScopeAnchorV1 | null {
  if (!isKind(input.kind)) return null;
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (input.kind === "workspace") {
    // A workspace arm carrying an id is a caller that has not decided whether
    // this launch belongs to the instance or to something inside it. Judged on
    // the id being PRESENT, never on it being non-blank: a whitespace-only id
    // is exactly such an undecided caller, and trimming it to nothing would
    // silently promote the mistake to a valid workspace anchor.
    if (input.id != null) return null;
    return { v: LAUNCH_SCOPE_ANCHOR_VERSION, kind: "workspace" };
  }
  if (id.length === 0) return null;
  // The storage-only sentinel belongs to the assignment tuple's key, where a
  // NOT NULL column needed a total value. This anchor has a workspace ARM, so
  // the sentinel has nothing to express here and is never serialized into it.
  if (id === WORKSPACE_SCOPE_SENTINEL) return null;
  return { v: LAUNCH_SCOPE_ANCHOR_VERSION, kind: input.kind, id };
}

/**
 * THE MINT AT THE LAUNCH ROUTE. The scoped launcher knows exactly one thing the
 * store never can: which vantage the person was standing on. It hands that
 * scope here and gets the payload the run is stamped with.
 *
 * THE PERSONAL SCOPE BECOMES A `user` ANCHOR, named by the ORIGINATING HUMAN.
 * `/personal` is actor-relative — it means "the person reading" — so it is not
 * an address; the durable fact is who launched. With no signed-in human there
 * is nothing durable to record, and the launch is anchored to nothing rather
 * than to a guess.
 */
export function launchScopeAnchorForScope(
  scope:
    // The five vantages, spelled one arm each so the switch below narrows on
    // `kind` — structurally identical to `ScopeSurfaceRef`, and spelled here so
    // this leaf keeps its distance from the surface vocabulary.
    | { kind: "workspace" }
    | { kind: "personal" }
    | { kind: "organization"; id: string }
    | { kind: "team"; id: string }
    | { kind: "project"; id: string }
    | null
    | undefined,
  originatingUserId: string | null,
): LaunchScopeAnchorV1 | null {
  if (!scope) return null;
  if (scope.kind === "personal") {
    return buildLaunchScopeAnchor({ kind: "user", id: originatingUserId });
  }
  if (scope.kind === "workspace") return buildLaunchScopeAnchor({ kind: "workspace" });
  return buildLaunchScopeAnchor({ kind: scope.kind, id: scope.id });
}

/** The JSON the column carries. */
export function serializeLaunchScopeAnchor(anchor: LaunchScopeAnchorV1): string {
  return JSON.stringify(anchor);
}

/**
 * THE read. Takes the parsed object (a jsonb column) or the JSON text (a
 * caller that read the column as text). ONE argument on purpose: a decoder
 * that could be handed a second column could be asked to repair a row with it.
 */
export function parseLaunchScopeAnchor(raw: unknown): LaunchScopeAnchorV1 | null {
  if (raw == null) return null;
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj.v !== LAUNCH_SCOPE_ANCHOR_VERSION) return null;
  if (!isKind(obj.kind)) return null;
  if (obj.kind === "workspace") {
    // THE UNION'S WORKSPACE ARM HAS NO `id` FIELD, so a stored payload that
    // carries the key at all — `null` included — is one no mint on this build
    // can have produced. Fail closed: read it as unanchored rather than
    // canonicalizing an instance under /workspace on a payload we cannot
    // vouch for (convergence finding on this lane).
    return Object.prototype.hasOwnProperty.call(obj, "id")
      ? null
      : { v: LAUNCH_SCOPE_ANCHOR_VERSION, kind: "workspace" };
  }
  if (typeof obj.id !== "string") return null;
  const id = obj.id.trim();
  if (id.length === 0 || id === WORKSPACE_SCOPE_SENTINEL) return null;
  return { v: LAUNCH_SCOPE_ANCHOR_VERSION, kind: obj.kind, id };
}

/**
 * The read WITH its reason. A surface that labels an instance needs to tell a
 * row that predates the column (Legacy) from one whose payload this build
 * cannot vouch for (Global) — same address, different reading.
 */
export type LaunchScopeAnchorReading =
  | { readonly kind: "anchored"; readonly anchor: LaunchScopeAnchorV1 }
  | { readonly kind: "unanchored"; readonly reason: "absent" | "malformed" };

export function readLaunchScopeAnchor(raw: unknown): LaunchScopeAnchorReading {
  if (raw == null) return { kind: "unanchored", reason: "absent" };
  const anchor = parseLaunchScopeAnchor(raw);
  return anchor
    ? { kind: "anchored", anchor }
    : { kind: "unanchored", reason: "malformed" };
}

/**
 * The scope BASE an anchor addresses, or `null` when the instance is flat.
 * Identical to `scopeSurfaceBase` for the four container kinds — spelled here
 * rather than imported so this leaf stays free of the surface vocabulary; the
 * agreement is pinned by a test.
 */
export function launchScopeAnchorBase(anchor: LaunchScopeAnchorV1 | null): string | null {
  if (!anchor) return null;
  switch (anchor.kind) {
    case "workspace":
      return "/workspace";
    case "organization":
      return `/organizations/${encodeURIComponent(anchor.id)}`;
    case "team":
      return `/teams/${encodeURIComponent(anchor.id)}`;
    case "project":
      return `/projects/${encodeURIComponent(anchor.id)}`;
    case "user":
      // FLAT BY DESIGN — see the module doc.
      return null;
  }
}

function scopeOf(anchor: LaunchScopeAnchorV1 | null): AgentPathScope {
  const base = launchScopeAnchorBase(anchor);
  return base === null ? {} : { scopeBase: base };
}

/** The bare chat mount root, and the segment the SCOPED mount answers on.
 *  Both spelled here rather than imported from the chat package: this leaf
 *  stays on the host's side of the core/extension border and keeps its narrow
 *  import list. The agreement with `chatMountRoot` is pinned by a unit test. */
const CHAT_ROOT_PATH = "/chat";
const SCOPED_ASSISTANTS_SEGMENT = "assistants";

/** The canonical address of a persisted RUN. */
export function canonicalRunPath(row: {
  agentPackageName: string;
  instanceId: string;
  anchor: LaunchScopeAnchorV1 | null;
}): string {
  return buildAgentInstancePath(row.agentPackageName, row.instanceId, scopeOf(row.anchor));
}

/**
 * The canonical address of a persisted THREAD: the codec's own bare
 * `/chat/…` path, re-homed under the anchor. The bare path is built by the
 * caller with `buildChatPath`, so this leaf never imports the chat package
 * across the border.
 */
export function canonicalThreadPath(row: {
  chatPath: string;
  anchor: LaunchScopeAnchorV1 | null;
}): string {
  const base = launchScopeAnchorBase(row.anchor);
  if (base === null) return row.chatPath;
  // THE BASE IS A PREFIX OF THE MOUNT, NOT OF THE BARE PATH (convergence
  // finding on this lane). The scoped mount answers at `<base>/assistants/…`,
  // so re-homing a thread swaps the mount root for the scoped segment. Simply
  // concatenating produced `<base>/chat/…`, which resolves to NO route — a
  // canonical home the reader could never reach.
  const rest =
    row.chatPath === CHAT_ROOT_PATH
      ? ""
      : row.chatPath.startsWith(`${CHAT_ROOT_PATH}/`)
        ? row.chatPath.slice(CHAT_ROOT_PATH.length)
        : null;
  if (rest === null) {
    throw new Error(
      `launch-scope-anchor: not a chat path ${JSON.stringify(row.chatPath)}`,
    );
  }
  return `${base}/${SCOPED_ASSISTANTS_SEGMENT}${rest}`;
}

/**
 * The redirect an instance page owes its reader, or `null` when the page is
 * already AT the canonical home. Answered on the PATH, so the bare route and a
 * wrong scoped path take the same road: the page decides this AFTER its
 * authorization checks and renders no instance content before redirecting.
 */
export function homeRedirectFor(
  currentPath: string,
  canonicalPath: string,
): string | null {
  const here = currentPath.length > 1 ? currentPath.replace(/\/+$/, "") : currentPath;
  return here === canonicalPath ? null : canonicalPath;
}

/**
 * The label a FLAT instance carries, or `null` for one that lives at a scoped
 * home. A2A instances are Global whatever the column says: an inbound
 * agent-to-agent task is launched from no vantage of ours.
 */
export function launchScopeInstanceLabel(
  reading: LaunchScopeAnchorReading,
  opts: { a2a?: boolean },
): "Global" | "Legacy" | "Personal (owner)" | null {
  if (opts.a2a) return "Global";
  if (reading.kind === "anchored") {
    return reading.anchor.kind === "user" ? "Personal (owner)" : null;
  }
  return reading.reason === "absent" ? "Legacy" : "Global";
}

/**
 * THE run/thread creation seam.
 *
 * It takes the anchor the LAUNCH decided and re-reads it through the decoder,
 * so a malformed payload never lands in the column. It deliberately consults
 * NOTHING else: a writer with no anchor — headless, A2A, a global entry point —
 * persists none, and the absence is the honest record of a launch that was made
 * from no vantage of ours. Inferring one from the org, the project or the actor
 * would be inventing a home the launch never had.
 */
export function buildRunCreationLaunchScopeAnchor(input: {
  launchScopeAnchor?: LaunchScopeAnchorV1 | null;
}): LaunchScopeAnchorV1 | null {
  return parseLaunchScopeAnchor(input.launchScopeAnchor ?? null);
}

/**
 * The immutability rule, as a guard. Every update path calls this before it
 * builds its SET list, so a writer that adds the field to an update payload
 * fails loudly instead of quietly re-homing a live instance.
 */
export function assertLaunchScopeAnchorNotMutated(patch: Record<string, unknown>): void {
  if (
    Object.prototype.hasOwnProperty.call(patch, "launchScopeAnchor") ||
    Object.prototype.hasOwnProperty.call(patch, "launch_scope_anchor")
  ) {
    throw new Error(
      "launch_scope_anchor is IMMUTABLE — it is stamped from the launch route at creation and never updated. An instance whose home can move is a bookmark that stops resolving.",
    );
  }
}
