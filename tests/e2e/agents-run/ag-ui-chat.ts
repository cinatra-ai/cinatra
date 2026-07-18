/**
 * AG-UI chat-turn helpers for the agents-run e2e suite (cinatra#1218 delete
 * stage). The bespoke POST /api/chat SSE endpoint is gone — chat turns ride
 * the unified assistant stream: POST /api/assistants/chat with a
 * caller-minted threadId, SSE frames of `id:`/`data:` blocks whose `data:`
 * payload is one JSON AG-UI event (`type` travels IN the JSON; there is no
 * `event:` field on this wire).
 *
 * Wire facts the specs depend on (see src/lib/assistant-runtime/
 * ag-ui-sink-adapter.ts — the ratified mapping):
 *  - Tool NAMES arrive on TOOL_CALL_START (`toolCallName`); TOOL_CALL_END
 *    carries ONLY the toolCallId — no name, no result payload.
 *  - The ONLY run pointer on the wire is `DATA_PART { kind: "agent_run",
 *    toolCallId, runId }`, emitted for the generic `agent_run` tool. Tools
 *    that return a runId inside their (off-wire) result — `a2a_agent_dispatch`
 *    and the `cinatra_<slug>` wrappers — surface NO runId on the wire, so
 *    callers needing one fall back to a DB lookup keyed on the expected
 *    agent package + the turn's start time.
 */
import { randomUUID } from "node:crypto";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { Client } from "pg";

export type AgUiWireEvent = { type: string } & Record<string, unknown>;

const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";

/** POST one user turn to the unified assistant endpoint. Each call mints a
 *  fresh threadId — the route claims an absent thread for the caller. */
export async function postAssistantChatTurn(
  request: APIRequestContext,
  prompt: string,
  options: { baseUrl: string; timeoutMs: number },
): Promise<APIResponse> {
  return request.post("/api/assistants/chat", {
    data: {
      threadId: randomUUID(),
      messages: [{ role: "user", content: prompt }],
    },
    headers: {
      "content-type": "application/json",
      Origin: options.baseUrl,
      Accept: "text/event-stream",
    },
    timeout: options.timeoutMs,
  });
}

/** Parse an AG-UI SSE response body into its JSON events. Malformed frames
 *  and keepalive comments are skipped (mirrors the production client). */
export async function readAgUiEvents(
  response: APIResponse,
): Promise<AgUiWireEvent[]> {
  const events: AgUiWireEvent[] = [];
  const text = await response.text();
  for (const block of text.split("\n\n")) {
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    try {
      const parsed = JSON.parse(dataLines.join("\n")) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        typeof (parsed as { type?: unknown }).type === "string"
      ) {
        events.push(parsed as AgUiWireEvent);
      }
    } catch {
      // skip malformed
    }
  }
  return events;
}

/** Tool names invoked during the turn, in order (from TOOL_CALL_START). */
export function toolCallNames(events: AgUiWireEvent[]): string[] {
  return events
    .filter((e) => e.type === "TOOL_CALL_START")
    .map((e) => String((e as { toolCallName?: unknown }).toolCallName ?? ""));
}

/** The wire-carried agent runId, if any (`DATA_PART { kind: "agent_run" }` —
 *  emitted only for the generic `agent_run` tool). */
export function agentRunIdFromWire(events: AgUiWireEvent[]): string | null {
  for (const e of events) {
    if (e.type !== "DATA_PART") continue;
    const data = (e as { data?: unknown }).data;
    if (
      data !== null &&
      typeof data === "object" &&
      (data as { kind?: unknown }).kind === "agent_run" &&
      typeof (data as { runId?: unknown }).runId === "string" &&
      ((data as { runId: string }).runId.length > 0)
    ) {
      return (data as { runId: string }).runId;
    }
  }
  return null;
}

/** Compact per-event debug line for assertion messages. */
export function describeAgUiEvents(events: AgUiWireEvent[]): string {
  return events
    .map((e) => {
      if (e.type === "TOOL_CALL_START") {
        return `TOOL_CALL_START/${String((e as { toolCallName?: unknown }).toolCallName ?? "_")}`;
      }
      if (e.type === "DATA_PART") {
        const data = (e as { data?: unknown }).data as { kind?: unknown } | null;
        return `DATA_PART/${String(data?.kind ?? "view")}`;
      }
      return e.type;
    })
    .join(", ");
}

/** Resolve a runId's agent package name via direct pg (unchanged from the
 *  bespoke-wire harness — the DB is the source of truth either way). */
export async function fetchRunPackageName(runId: string): Promise<string | null> {
  const client = new Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    const res = await client.query<{ package_name: string | null }>(
      `SELECT t.package_name FROM ${SCHEMA}.agent_runs r
       JOIN ${SCHEMA}.agent_templates t ON t.id = r.template_id
       WHERE r.id = $1`,
      [runId],
    );
    return res.rows[0]?.package_name ?? null;
  } finally {
    await client.end();
  }
}

/**
 * DB fallback for tools whose runId never rides the wire
 * (`a2a_agent_dispatch`, `cinatra_<slug>`): the newest run of the EXPECTED
 * agent package that STARTED at/after the turn began. `agent_runs` has no
 * created_at — `started_at` is stamped when the worker picks the run up, so
 * this polls briefly (a freshly dispatched run starts within seconds on the
 * UAT stack). Sound there: one test writer per package at a time.
 */
export async function fetchLatestRunIdForPackage(
  packageName: string,
  sinceIso: string,
  pollTimeoutMs = 60_000,
): Promise<string | null> {
  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    const client = new Client({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 5_000,
    });
    await client.connect();
    try {
      const res = await client.query<{ id: string }>(
        `SELECT r.id FROM ${SCHEMA}.agent_runs r
         JOIN ${SCHEMA}.agent_templates t ON t.id = r.template_id
         WHERE t.package_name = $1 AND r.started_at >= $2
         ORDER BY r.started_at DESC
         LIMIT 1`,
        [packageName, sinceIso],
      );
      const id = res.rows[0]?.id ?? null;
      if (id) return id;
    } finally {
      await client.end();
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}
