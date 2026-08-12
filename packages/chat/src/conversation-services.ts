"use client";

// ---------------------------------------------------------------------------
// THE conversation column's DATA PATHS — one implementation, one transport seam
// (cinatra#2683, epic #2564 S8f).
// ---------------------------------------------------------------------------
// S8f made `/chat` and the widget render one conversation column. Six of its
// affordances still failed closed on the widget, and the column was never the
// reason: each one reads or writes through a request that `/chat` made with a
// cookie, and the widget cannot make a cookie request — the embed frame is
// same-origin to the Cinatra app, so an ambient cookie answers as whoever else
// is signed in on that browser.
//
// This module is where those requests live now. There is ONE of each, and it
// takes an optional TRANSPORT: absent means the first-party cookie request,
// byte-identical to what `/chat` sent before; present means broker headers built
// AT CALL TIME from the host's closure-held tokens, with `credentials: "omit"`.
// That is the same seam the turn driver already takes, applied to the rest of
// the column's data — so a conversation feature cannot be wired for one surface
// and forgotten on the other, because there is only one place to wire it.
//
// EVERY ONE OF THESE IS A REQUEST, NOT A DECISION. What comes back is decided by
// the endpoint, against the caller's own live standing, with the same per-row
// check on both branches. Nothing here narrows or widens anything.
// ---------------------------------------------------------------------------

import type { Mentionable } from "@cinatra-ai/sdk-ui/prompt-field";
import type { UiMessage } from "./types";

/**
 * How a surface proves who is asking. Structurally identical to the turn
 * driver's pair, and deliberately not imported from the column: this module must
 * be reachable from a host that has not mounted a column yet (the embed resolves
 * its history BEFORE it mounts one).
 */
export type ConversationServiceTransport = {
  authHeaders: () => Record<string, string>;
  credentialsMode: "omit";
};

/** The fetch init a transport implies. Cookie hosts get exactly what they had. */
function requestInit(
  transport: ConversationServiceTransport | undefined,
  init: RequestInit = {},
): RequestInit {
  const headers = { ...(init.headers as Record<string, string> | undefined) };
  if (!transport) return { ...init, headers };
  return {
    ...init,
    headers: { ...headers, ...transport.authHeaders() },
    credentials: transport.credentialsMode,
  };
}

// ---------------------------------------------------------------------------
// Item 1 — the thread transcript.
// ---------------------------------------------------------------------------

/**
 * Read one thread's messages, for seeding the column's `initialMessages`.
 *
 * Returns `null` for every unusable answer — a 401, a 404 (which is also what a
 * denial looks like: the endpoint refuses to disclose a thread's existence
 * across tenants), a transport failure, a body that is not a message array. A
 * caller renders an empty conversation for all of them, which is what it would
 * have rendered anyway, so a failed restore is never a visible error.
 */
export async function fetchThreadMessages(
  threadId: string,
  transport?: ConversationServiceTransport,
): Promise<UiMessage[] | null> {
  if (!threadId) return null;
  try {
    const res = await fetch(
      `/api/assistants/threads/${encodeURIComponent(threadId)}`,
      requestInit(transport, { cache: "no-store" }),
    );
    if (!res.ok) return null;
    const payload = (await res.json()) as { messages?: unknown } | null;
    if (!Array.isArray(payload?.messages)) return null;
    return payload.messages as UiMessage[];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Item 4 — the @-mention participant list.
// ---------------------------------------------------------------------------

/**
 * The people and assistants this reader may address. The endpoint is
 * tenant-scoped by a PROVEN current membership, so what comes back is the
 * reader's own directory on either surface; an empty list is the honest answer
 * for a reader with no co-members, and for a failure.
 */
export async function fetchMentionables(
  transport?: ConversationServiceTransport,
): Promise<Mentionable[]> {
  try {
    const res = await fetch("/api/assistants/list", requestInit(transport));
    if (!res.ok) return [];
    const data = (await res.json()) as { assistants?: { id: string; handle: string }[] };
    if (!Array.isArray(data.assistants)) return [];
    return data.assistants.map((a) => ({ ...a, displayName: a.handle }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Item 3 — the Skill-autosave account setting.
// ---------------------------------------------------------------------------

export type ChatCaptureConfig = {
  enabled: boolean;
  userCanConfigure: boolean;
  userCanSeeIndicator: boolean;
};

/** Read the Skill-autosave config. A failure reads as "not visible", so the
 *  flyout row is absent rather than wrong. */
export async function fetchChatCaptureConfig(
  transport?: ConversationServiceTransport,
): Promise<ChatCaptureConfig | null> {
  try {
    const res = await fetch("/api/assistants/autosave", requestInit(transport));
    if (!res.ok) return null;
    const config = (await res.json()) as {
      enabled?: boolean;
      userCanConfigure?: boolean;
      userCanSeeIndicator?: boolean;
    };
    return {
      enabled: Boolean(config.enabled),
      userCanConfigure: Boolean(config.userCanConfigure),
      userCanSeeIndicator: Boolean(config.userCanSeeIndicator),
    };
  } catch {
    return null;
  }
}

/**
 * Write the Skill-autosave switch — the SAME account setting, through the same
 * handler and the same `can()` check on both surfaces. The server decides what
 * this reader may change; this function only asks.
 */
export async function patchChatCaptureConfig(
  enabled: boolean,
  transport?: ConversationServiceTransport,
): Promise<void> {
  try {
    await fetch(
      "/api/assistants/autosave",
      requestInit(transport, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }),
    );
  } catch {
    /* best-effort: the next read re-states the server's answer. */
  }
}
