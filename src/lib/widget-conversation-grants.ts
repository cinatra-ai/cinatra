import "server-only";

// ---------------------------------------------------------------------------
// The CONVERSATION GRANTS a widget request is consumed under (cinatra#2683,
// epic #2564 S8f).
// ---------------------------------------------------------------------------
// A grant is a (route audience, required scope) pair plus the audit events its
// authorization decision is written to. The pairs live HERE, in one file, for
// the same reason the lifecycle pair states its own: an audience and the scope
// that unlocks it must not be able to drift apart at a call site.
//
// Every one of these is consumed through the ONE door
// (`@/lib/widget-conversation-branch`), which builds the S8a FULL actor, and
// every route behind them runs the SAME per-row authorization the first-party
// surface runs. The grant answers "may this session reach this surface at all";
// it never answers "may this person have this row".
// ---------------------------------------------------------------------------

import type { WidgetTokenGrant } from "@/lib/lifecycle/widget-lifecycle-actor";
import {
  WIDGET_AGENT_RUN_SEED_ROUTE_PATH,
  WIDGET_CHAT_PARTICIPANTS_ROUTE_PATH,
  WIDGET_CHAT_PENDING_CALLS_ROUTE_PATH,
  WIDGET_CHAT_SETTINGS_ROUTE_PATH,
  WIDGET_CHAT_THREADS_ROUTE_PATH,
  WIDGET_CHAT_UNDO_ROUTE_PATH,
  WIDGET_CHAT_UPLOAD_ROUTE_PATH,
  WIDGET_CONVERSATION_READ_SCOPE,
  WIDGET_CONVERSATION_WRITE_SCOPE,
  WIDGET_TOOL_CONFIRM_SCOPE,
} from "@/lib/widget-lifecycle-scope";

/** Item 1 — restore the reader's OWN thread after the frame reloads. */
export const WIDGET_THREAD_HISTORY_GRANT: WidgetTokenGrant = {
  routePath: WIDGET_CHAT_THREADS_ROUTE_PATH,
  requiredScopes: [WIDGET_CONVERSATION_READ_SCOPE],
  auditAuthorized: "widget_conversation_read_authorized",
  auditRejected: "widget_conversation_read_rejected",
};

/**
 * Item 1, THE WRITE HALF — keep the turns the restore above reads back.
 *
 * SAME ROUTE PATH, DIFFERENT SCOPE, exactly as the Skill-autosave pair above:
 * the audience admits the surface, the scope admits the verb. A session granted
 * only `conversation.read` can restore a transcript and cannot append to one,
 * which is the negative control this pair exists to make possible.
 *
 * It is a SEPARATE constant rather than a second `requiredScopes` entry on the
 * history grant because the two consumes are two different decisions with two
 * different audit series — a refused write must not read, in the log, like a
 * refused read.
 */
export const WIDGET_THREAD_WRITE_GRANT: WidgetTokenGrant = {
  routePath: WIDGET_CHAT_THREADS_ROUTE_PATH,
  requiredScopes: [WIDGET_CONVERSATION_WRITE_SCOPE],
  auditAuthorized: "widget_conversation_write_authorized",
  auditRejected: "widget_conversation_write_rejected",
};

/** Item 4 — the @-mention participant list, from the SAME directory reader. */
export const WIDGET_PARTICIPANTS_GRANT: WidgetTokenGrant = {
  routePath: WIDGET_CHAT_PARTICIPANTS_ROUTE_PATH,
  requiredScopes: [WIDGET_CONVERSATION_READ_SCOPE],
  auditAuthorized: "widget_conversation_read_authorized",
  auditRejected: "widget_conversation_read_rejected",
};

/** Item 3 — READ the Skill-autosave setting (the flyout row's initial state). */
export const WIDGET_CHAT_SETTINGS_READ_GRANT: WidgetTokenGrant = {
  routePath: WIDGET_CHAT_SETTINGS_ROUTE_PATH,
  requiredScopes: [WIDGET_CONVERSATION_READ_SCOPE],
  auditAuthorized: "widget_conversation_read_authorized",
  auditRejected: "widget_conversation_read_rejected",
};

/**
 * Item 3 — WRITE the Skill-autosave setting. Same route, different operation,
 * different scope: the audience admits the surface, the scope admits the verb.
 */
export const WIDGET_CHAT_SETTINGS_WRITE_GRANT: WidgetTokenGrant = {
  routePath: WIDGET_CHAT_SETTINGS_ROUTE_PATH,
  requiredScopes: [WIDGET_CONVERSATION_WRITE_SCOPE],
  auditAuthorized: "widget_conversation_write_authorized",
  auditRejected: "widget_conversation_write_rejected",
};

/** Item 2 — the attachment upload, owned by the WIDGET principal. */
export const WIDGET_ATTACHMENT_UPLOAD_GRANT: WidgetTokenGrant = {
  routePath: WIDGET_CHAT_UPLOAD_ROUTE_PATH,
  requiredScopes: [WIDGET_CONVERSATION_WRITE_SCOPE],
  auditAuthorized: "widget_conversation_write_authorized",
  auditRejected: "widget_conversation_write_rejected",
};

/** Item 5 — LIST the reader's own parked destructive calls. */
export const WIDGET_PENDING_CALLS_READ_GRANT: WidgetTokenGrant = {
  routePath: WIDGET_CHAT_PENDING_CALLS_ROUTE_PATH,
  requiredScopes: [WIDGET_CONVERSATION_READ_SCOPE],
  auditAuthorized: "widget_conversation_read_authorized",
  auditRejected: "widget_conversation_read_rejected",
};

/** Item 5 — DECIDE one of them. Its own grant, its own audit series. */
export const WIDGET_PENDING_CALLS_DECIDE_GRANT: WidgetTokenGrant = {
  routePath: WIDGET_CHAT_PENDING_CALLS_ROUTE_PATH,
  requiredScopes: [WIDGET_TOOL_CONFIRM_SCOPE],
  auditAuthorized: "widget_tool_confirm_authorized",
  auditRejected: "widget_tool_confirm_rejected",
};

/**
 * Item 6 — "did this run leave a change set this reader could still undo?".
 *
 * READ ONLY, deliberately. The undo itself is not a widget capability at all: it
 * happens on the first-party restore surface the chip deep-links to, under the
 * reader's own session, through the same per-event restore authorization it
 * always ran.
 */
export const WIDGET_UNDO_CANDIDATE_GRANT: WidgetTokenGrant = {
  routePath: WIDGET_CHAT_UNDO_ROUTE_PATH,
  requiredScopes: [WIDGET_CONVERSATION_READ_SCOPE],
  auditAuthorized: "widget_conversation_read_authorized",
  auditRejected: "widget_conversation_read_rejected",
};

/**
 * cinatra#2902 — the inline run panel's SEED: "draw the agent run this message
 * is about".
 *
 * READ ONLY, and it is the seed only. The panel's live transports (the run's
 * stream, its creation-progress notifications) are separately session-only and
 * carry no grant here, so a widget session reaches the one read this grant names
 * and nothing beside it.
 *
 * It rides `conversation.read` because the run is part of the conversation the
 * reader is already looking at — the same reading the parked-call list and the
 * undo chip are — and its own audience keeps AC-1 true: a session minted before
 * this slice holds the scope, not the audience, and dies at the consume.
 */
export const WIDGET_AGENT_RUN_SEED_GRANT: WidgetTokenGrant = {
  routePath: WIDGET_AGENT_RUN_SEED_ROUTE_PATH,
  requiredScopes: [WIDGET_CONVERSATION_READ_SCOPE],
  auditAuthorized: "widget_conversation_read_authorized",
  auditRejected: "widget_conversation_read_rejected",
};
