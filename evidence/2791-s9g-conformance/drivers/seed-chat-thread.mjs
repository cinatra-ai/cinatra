// ---------------------------------------------------------------------------
// Put a lifecycle DATA_PART into a REAL chat thread, through the app's OWN
// first-class thread-persistence route.
//
// `POST /api/assistants/threads` is the exact route the /chat client itself
// writes with (`saveChatThreadViaFetch`, packages/chat/src/ag-ui-chat-client.ts)
// — the same route tests/e2e/agents-run/chat-render-parity-target.ts seeds a
// deterministic thread through, and for the same reason: the card must reach
// the transcript the way a persisted assistant turn does, and a live model turn
// is not available on a credential-free host.
//
// The DATA_PART payload is the SHIPPED envelope and nothing else —
// `{ viewType, schemaVersion, ref }` — with `ref` minted by the shipped codec
// (`encodeLifecycleGateRef`) against a REAL gate this lane produced through the
// shipped producer + orchestration sweep. The card resolves its own state
// server-side from that ref on mount, so nothing about the gate is asserted by
// this seed: the transcript carries an addressing handle, the server answers.
//
// WHAT IS STOOD IN FOR, EXACTLY: the model layer. The assistant turn's text and
// the decision to emit the view are written here instead of produced by a live
// LLM. Everything downstream — persistence, reconstruction, the registry
// dispatch, the authoritative refetch, the access ladder — is the shipped path.
// ---------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { Client } from "pg";

const BASE = process.env.SEED_BASE;
const IDS = JSON.parse(fs.readFileSync(process.env.IDS_JSON, "utf8"));
const REF = process.env.SEED_REF;
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const DB = process.env.SUPABASE_DB_URL;

const threadId = randomUUID();
const nowIso = new Date().toISOString();
const title = process.env.SEED_TITLE ?? `lifecycle card ${threadId}`;

const body = {
  id: threadId,
  title,
  createdAt: nowIso,
  updatedAt: nowIso,
  messages: [
    {
      id: randomUUID(),
      role: "user",
      content: process.env.SEED_USER_TEXT ?? "Show me the review that is waiting on me.",
      createdAt: nowIso,
    },
    {
      id: randomUUID(),
      role: "assistant",
      content: process.env.SEED_ASSISTANT_TEXT ?? "Here is the review.",
      createdAt: nowIso,
      dataParts: [
        {
          viewType: process.env.SEED_VIEW_TYPE ?? "artifact_review_gate",
          schemaVersion: 1,
          ref: REF,
        },
      ],
    },
  ],
};

const res = await fetch(BASE + "/api/assistants/threads", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: BASE, Cookie: IDS.cookie },
  body: JSON.stringify(body),
});
console.log("SEED save", res.status);
if (!res.ok) {
  console.log("SEED body", (await res.text()).slice(0, 400));
  process.exit(1);
}

// Bind + slug the row exactly as the app's own W3 store primitives persist it,
// so the canonical /chat/<vendor>/<slug>/<titleSlug> URL resolves back to it.
const titleSlug = title
  .toLowerCase()
  .normalize("NFKD")
  .replace(/[^\w\s-]/g, "")
  .trim()
  .replace(/[\s_]+/g, "-")
  .replace(/-+/g, "-")
  .slice(0, 80);
const db = new Client({ connectionString: DB });
await db.connect();
const upd = await db.query(
  `UPDATE ${SCHEMA}.assistant_threads
      SET assistant_package = $1, instance_id = NULL, title_slug = $2, updated_at = now()
    WHERE id = $3`,
  ["@cinatra-ai/cinatra-assistant", titleSlug, threadId],
);
const back = await db.query(
  `SELECT id, role, content FROM ${SCHEMA}.assistant_turns WHERE thread_id = $1 ORDER BY ordinal`,
  [threadId],
);
await db.end();
console.log("SEED bound rows", upd.rowCount);
console.log(
  "SEED persisted dataParts",
  JSON.stringify(back.rows.map((r) => ({ role: r.role, dataParts: r.content?.dataParts ?? null }))).slice(0, 400),
);

const readBack = await fetch(`${BASE}/api/assistants/threads/${threadId}`, {
  headers: { Cookie: IDS.cookie },
});
const json = await readBack.json().catch(() => null);
const msgs = json?.messages ?? json?.thread?.messages ?? [];
console.log("SEED readback status", readBack.status, "messages", msgs.length);
console.log("SEED readback dataParts", JSON.stringify(msgs.map((m) => m.dataParts ?? null)).slice(0, 400));

fs.writeFileSync(
  process.env.SEED_OUT,
  JSON.stringify({ threadId, titleSlug, chatPath: `/chat/cinatra-ai/cinatra-assistant/${titleSlug}` }, null, 2),
);
console.log("SEED path", `/chat/cinatra-ai/cinatra-assistant/${titleSlug}`);
