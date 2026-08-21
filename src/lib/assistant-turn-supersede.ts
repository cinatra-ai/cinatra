import "server-only";
/**
 * The `assistant_turns` SUPERSEDE (tombstone) writer — cinatra#2823 S9j.
 *
 * ITS OWN MODULE, because the org-axis write ledger asks for one. The mirror
 * reconcile's other builders live in `src/lib/project-inheritance.ts`, a BROAD
 * module the raw org-axis table sweep deliberately does not prefix-cover: it
 * carries a committed per-file DML-site count instead, so a NEW raw org-axis
 * statement there fails the gate rather than hiding behind a prefix
 * (`scripts/audit/org-write-table-sweep.mjs`). A tombstone is a new org-axis
 * statement, so it registers the way every other single-purpose store does —
 * its own module, a row in `src/lib/org-write/write-registry.ts`, a prefix in
 * the sweep's covered set, and a writer-set lockstep pin over its full export
 * surface (`src/lib/__tests__/org-write-edge-writer-inventory.test.ts`).
 *
 * A STATEMENT BUILDER, NOT AN EXECUTOR. The tombstone MUST commit in the same
 * transaction as the truncation whose intent it acts on — see
 * `buildSupersedeRunBoundTurnsQuery` — so it is composed into
 * `upsertChatThreadInDatabase`'s single transaction rather than executing its
 * own. The registry row records that relationship explicitly.
 */

/** `[]::jsonb` for anything that is not an array — so a malformed/absent key
 *  yields no rows instead of erroring the whole reconcile transaction. */
function jsonbArrayOrEmpty(expr: string): string {
  return `CASE WHEN jsonb_typeof(${expr}) = 'array' THEN ${expr} ELSE '[]'::jsonb END`;
}

/**
 * The SQL that TOMBSTONES the run-bound turns a truncating save ASSERTS it
 * removed.
 *
 * THE DEFECT IT CLOSES. The reconcile DELETE beside it is scoped
 * `id LIKE 'legacy:%'` so a legacy write can never delete a runtime-minted row —
 * correct, and it left an edit-and-resend deleting the mirror row of a turn
 * while the run-bound row survived. The reload's fold-in then put that turn
 * back, ABOVE the edited prompt (the run-bound stamp is taken at run START, the
 * edited message gets a fresh one), and the next whole-transcript save wrote it
 * down again. The user deleted a turn and it came back, permanently.
 *
 * THE SEPARATION, STATED HONESTLY. Server time cannot tell a lost save from a
 * deliberate truncation, and neither can "the turn is absent from the payload" —
 * a lost save looks exactly like that, and repairing it is what this whole leg is
 * for. "The row was in the database and this payload dropped it" is not enough
 * either: that DELETE is keyed on the PAYLOAD, not on what this writer ever
 * knew. A second tab loaded before turn X existed saves its own stale
 * transcript, the reconcile drops X's mirror row because the payload omits it,
 * and X would be tombstoned by a writer that NEVER OBSERVED IT — permanently
 * blocking the very repair this leg exists for, from a plain save with no edit
 * in it.
 *
 * SO THE ASSERTION IS EXPLICIT, and it is the only thing that tombstones. The
 * edit-and-resend path is the one caller that truly truncates: it knows the user
 * edited message M and dropped its successors, and it CARRIES that intent
 * (`removedMessageIds`, `packages/chat/src/message-edit-flow.ts`). A plain
 * full-payload save — from any tab, stale or fresh — asserts nothing and
 * supersedes nothing. `removedIds` is that assertion, already narrowed to this
 * thread's mirror namespace, and it is INTERSECTED with the payload's own
 * removals below: a row can be tombstoned only when the writer BOTH asserts it
 * removed the message AND no longer carries it. The intent can only ever narrow
 * what the reconcile removes, never widen it.
 *
 * ── SELF-HARM ONLY: WHO MAY TOMBSTONE ────────────────────────────────────────
 *
 * The separation above rests on a claim about REACH — that a false assertion
 * costs the writer the repair of its OWN turn and nothing else. That claim holds
 * only where the thread has ONE writer, and two thread shapes do not:
 *
 *   * a TEAM-owned thread (`owner_user_id IS NULL`, `team_id` set) is writable by
 *     every member of the team's org;
 *   * a legacy UNOWNED thread (both null) is writable by anyone who can reach it.
 *
 * On either, one member's edit-and-resend would permanently supersede run-bound
 * rows belonging to turns another member is still reading — rows that are the
 * server's only copy, and whose loss is exactly the defect this leg removes. So
 * the tombstone is scoped to the ACTOR'S OWN rows: it reaches a run-bound row
 * only on a thread the acting writer PERSONALLY OWNS, where every run-bound row
 * was necessarily produced under that same owner's session (the turn route
 * refuses to append a turn to a thread another user owns, and the save route
 * refuses a personal-thread write from anyone but its owner). The tombstone can
 * then only ever cost the actor a repair of their own turn — self-harm, which is
 * the boundary the reach argument actually states.
 *
 * `actorUserId` is the TRANSPORT-VERIFIED caller (the session/principal the route
 * derived), never a body field: a spoofable actor would hand back the whole
 * boundary. It is compared against the thread row IN THIS STATEMENT, inside the
 * write's own transaction, so the ownership it authorizes against is the
 * ownership the write commits under. A null actor authorizes nothing.
 *
 * On a team or unowned thread the tombstone is simply refused — the reconcile
 * DELETE still removes the writer's own mirror rows (its own transcript is its
 * own to truncate), and the run-bound rows survive to be folded back in. A
 * refused tombstone costs a turn that has to be removed again; an unauthorized
 * one costs another reader their card forever.
 *
 * ── HOW A REMOVED MIRROR ROW IS LINKED TO A RUN-BOUND ONE ────────────────────
 *
 * The two writers share no key — the mirror row's id is built from the CLIENT's
 * message id and the run-bound row's is the turn's — so the link is the
 * SERVER-MINTED identity both copies of the turn carry, read from every shape the
 * projection produces and matched to the durable row's own:
 *
 *   1. A SHARED TOOL-CALL ID with THIS removed row. The primary key: the
 *      tool-call ids in the ordinary ordered trace (`parts[].id`) and in the
 *      Slack-mode layout (`thoughtGroups[].toolCalls[].id`).
 *   2. A SHARED SLOT-BOUND VIEW KEY — a lifecycle card's `viewType|ref` BOUND TO
 *      THE TOOL CALL THAT PRODUCED IT.
 *
 * WHY (2) CARRIES THE SLOT, and why a bare `viewType|ref` is not a key at all. A
 * lifecycle `ref` names an ENTITY, not a turn, and any number of turns may draw
 * that entity's card. Keyed on the ref alone, an older message that records no
 * tool call but happens to show the same card claims a LATER turn whose save was
 * lost, and that turn is suppressed entirely — a card lost, which is the exact
 * defect this leg exists to remove. A third message re-rendering the entity turns
 * a clean repair into an ambiguous one for the same reason.
 *
 * The turn identity a card DOES carry is its PRODUCING TOOL CALL — server-minted,
 * per-turn, and durable on both sides since the slot stamp landed: the removed
 * mirror row folds a stamped card onto its producing `tool_call` part
 * (`parts[].views`), and the durable row keeps the stamp in `dataPartSlots`,
 * positionally aligned with `dataParts`. So the key is `viewType|ref@callId` on
 * both sides, and a card carrying NO slot contributes NO key: it names an entity,
 * which is not an identity claim about a turn.
 *
 * That is also why (2) needs no "and only when the removed row records no tool
 * call" fence any more. The fence existed to keep a weak key away from a row that
 * was not silent about its identity; a slot-bound key IS an identity claim about
 * one server-minted call, so it contradicts nothing and can be offered outright.
 *
 * A tombstone is the strictly more expensive way to be wrong here: a refused one
 * costs a turn that has to be removed again, an over-eager one costs a kept turn
 * its card forever.
 *
 * ORDERED BEFORE THE DELETE, in the SAME transaction the whole mirror write runs
 * in, so it sees the rows that are about to go and cannot half-apply: the
 * truncation and the tombstone commit together or not at all.
 */
export function buildSupersedeRunBoundTurnsQuery(args: {
  schema: string;
  threadId: string;
  keptIds: string[];
  /** The asserted removals, as this thread's mirror row ids. Never empty. */
  removedIds: string[];
  /** The mirror namespace prefix the removed rows live in. */
  mirrorPrefix: string;
  /** The TRANSPORT-VERIFIED acting writer, or null when the caller derived none
   *  (which authorizes nothing — see the self-harm boundary above). */
  actorUserId: string | null;
}): { text: string; values: unknown[] } {
  const { schema } = args;
  const parts = jsonbArrayOrEmpty("r.content->'parts'");
  const groups = jsonbArrayOrEmpty("r.content->'thoughtGroups'");
  const durableParts = jsonbArrayOrEmpty("t.content->'parts'");
  const durableViews = jsonbArrayOrEmpty("t.content->'dataParts'");
  const durableSlots = jsonbArrayOrEmpty("t.content->'dataPartSlots'");
  return {
    text: `WITH removed AS (
  SELECT id, content FROM "${schema}"."assistant_turns"
   WHERE thread_id = $1
     AND id LIKE '${args.mirrorPrefix}%'
     AND NOT (id = ANY($2::text[]))
     AND id = ANY($3::text[])
     AND content IS NOT NULL
),
removed_call AS (
  -- a tool-call id in the ordinary ordered trace
  SELECT r.id AS removed_id, 'call:' || (p->>'id') AS token
    FROM removed r, jsonb_array_elements(${parts}) p
   WHERE p->>'kind' = 'tool_call' AND jsonb_typeof(p->'id') = 'string'
  UNION
  -- ...or in the Slack-mode layout, which omits parts and keeps thoughtGroups
  SELECT r.id, 'call:' || (tc->>'id')
    FROM removed r, jsonb_array_elements(${groups}) g,
         jsonb_array_elements(${jsonbArrayOrEmpty("g->'toolCalls'")}) tc
   WHERE jsonb_typeof(tc->'id') = 'string'
),
removed_view AS (
  -- a lifecycle card's identity BOUND TO THE CALL THAT PRODUCED IT: the card is
  -- folded onto that tool_call part, so the part's own id is the slot. A card
  -- sitting at turn level carries no slot and therefore no key.
  SELECT r.id AS removed_id,
         'view:' || (v->>'viewType') || '|' || (v->>'ref') || '@' || (p->>'id') AS token
    FROM removed r, jsonb_array_elements(${parts}) p,
         jsonb_array_elements(${jsonbArrayOrEmpty("p->'views'")}) v
   WHERE p->>'kind' = 'tool_call' AND jsonb_typeof(p->'id') = 'string'
     AND jsonb_typeof(v->'viewType') = 'string' AND v->>'viewType' <> ''
     AND jsonb_typeof(v->'ref') = 'string'
)
UPDATE "${schema}"."assistant_turns" t
   SET superseded_at = now(), updated_at = now()
 WHERE t.thread_id = $1
   AND t.run_id IS NOT NULL
   AND t.superseded_at IS NULL
   AND t.content->>'format' = 'assistant-turn-v1'
   -- SELF-HARM ONLY: a personally-owned thread, owned by THIS actor. A team or
   -- unowned thread has other legitimate writers, so no writer's assertion is
   -- self-harm there and none of them may tombstone.
   AND $4::text IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM "${schema}"."assistant_threads" th
      WHERE th.id = $1
        AND th.owner_user_id IS NOT NULL
        AND th.owner_user_id = $4::text
        AND th.team_id IS NULL
   )
   AND EXISTS (
     SELECT 1 FROM removed r
      WHERE EXISTS (
              -- (1) a SHARED tool-call id with THIS removed row
              SELECT 1 FROM jsonb_array_elements(${durableParts}) dp
               WHERE dp->>'type' = 'tool_call' AND jsonb_typeof(dp->'id') = 'string'
                 AND ('call:' || (dp->>'id')) IN (
                   SELECT rc.token FROM removed_call rc WHERE rc.removed_id = r.id
                 )
            )
         OR EXISTS (
              -- (2) a SHARED SLOT-BOUND view key. The durable row keeps the slot
              --     stamp in dataPartSlots, positionally aligned with
              --     dataParts; an entry whose slot is null carries no key.
              SELECT 1
                FROM jsonb_array_elements(${durableViews}) WITH ORDINALITY AS dv(item, pos)
               WHERE jsonb_typeof(dv.item->'viewType') = 'string' AND dv.item->>'viewType' <> ''
                 AND jsonb_typeof(dv.item->'ref') = 'string'
                 -- Length parity, exactly as the reload projection demands it: a
                 -- slots array that does not match dataParts one-for-one is a
                 -- writer this reader does not understand, so NO entry is treated
                 -- as slotted and the whole arm yields no key.
                 AND jsonb_array_length(${durableSlots}) = jsonb_array_length(${durableViews})
                 AND jsonb_typeof((${durableSlots}) -> (dv.pos::int - 1)) = 'string'
                 AND ('view:' || (dv.item->>'viewType') || '|' || (dv.item->>'ref')
                      || '@' || ((${durableSlots}) ->> (dv.pos::int - 1))) IN (
                   SELECT rv.token FROM removed_view rv WHERE rv.removed_id = r.id
                 )
            )
   )`,
    values: [args.threadId, args.keptIds, args.removedIds, args.actorUserId],
  };
}
