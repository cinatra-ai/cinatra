// ---------------------------------------------------------------------------
// Put ONE lifecycle DATA_PART into each of four REAL chat threads, through the
// app's OWN first-class thread-persistence route.
//
// `POST /api/assistants/threads` is the exact route the /chat client itself
// writes with (`saveChatThreadViaFetch`, packages/chat/src/ag-ui-chat-client.ts)
// and the one `tests/e2e/agents-run/chat-render-parity-target.ts` seeds a
// deterministic thread through, for the same reason: the card must reach the
// transcript the way a persisted assistant turn does, and a live model turn is
// not available on a credential-free host.
//
// ONE CARD PER THREAD, ON PURPOSE. `resolveComposerTarget` binds the composer
// implicitly only when exactly ONE card is eligible; two would make every typed
// message a `refuse-ambiguous`, which is a different cell than the four this
// round is photographing. So each gate gets its own thread.
//
// The DATA_PART payload is the SHIPPED envelope and nothing else —
// `{ viewType, schemaVersion, ref }` — with `ref` minted by the shipped codec
// against a REAL pending gate. The card resolves its own state server-side from
// that ref on mount, so no state is asserted by this seed.
//
// WHAT IS STOOD IN FOR: the model layer — the assistant's sentence and the
// decision to emit the view. Everything downstream is the shipped path.
//
// Usage: node 03-seed-threads.mjs
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { Client } from "pg";

const BASE = process.env.SEED_BASE;
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const DB = process.env.SUPABASE_DB_URL;
const WALK = JSON.parse(fs.readFileSync(process.env.WALK_STATE_FILE, "utf8"));
const PLAN = JSON.parse(fs.readFileSync(process.env.SEED_PLAN, "utf8"));

const slugify = (t) =>
  t.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim()
    .replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 80);

const out = [];
const db = new Client({ connectionString: DB });
await db.connect();

for (const cell of PLAN.threads) {
  const threadId = randomUUID();
  const nowIso = new Date().toISOString();
  const ref = WALK[`ref_${cell.slot}`];
  if (!ref) throw new Error(`no ref recorded for slot ${cell.slot}`);
  const body = {
    id: threadId,
    title: cell.title,
    createdAt: nowIso,
    updatedAt: nowIso,
    messages: [
      { id: randomUUID(), role: "user", content: cell.userText, createdAt: nowIso },
      {
        id: randomUUID(),
        role: "assistant",
        content: cell.assistantText,
        createdAt: nowIso,
        dataParts: [{ viewType: "artifact_review_gate", schemaVersion: 1, ref }],
      },
    ],
  };
  const res = await fetch(BASE + "/api/assistants/threads", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, Cookie: cell.cookie },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`thread save ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const titleSlug = slugify(cell.title);
  await db.query(
    `UPDATE ${SCHEMA}.assistant_threads
        SET assistant_package = $1, instance_id = NULL, title_slug = $2, updated_at = now()
      WHERE id = $3`,
    ["@cinatra-ai/cinatra-assistant", titleSlug, threadId],
  );
  const path = `/chat/cinatra-ai/cinatra-assistant/${titleSlug}`;
  out.push({ cell: cell.cell, slot: cell.slot, threadId, path, owner: cell.owner });
  console.log(`SEED ${cell.cell} slot=${cell.slot} owner=${cell.owner} -> ${path}`);
}
await db.end();
fs.writeFileSync(process.env.SEED_OUT, JSON.stringify(out, null, 2));
