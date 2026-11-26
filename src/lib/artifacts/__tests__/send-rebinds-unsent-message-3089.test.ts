/**
 * cinatra#3089 — a message bound to an approved revision but never mailed moves
 * to a newer approved revision of its body; a sent or in-doubt message keeps
 * its binding.
 *
 * Driven through `createTriggerEmailSendUseCases` with the SHIPPED fan-out
 * (`bindFanoutMessageRevision`) and the SHIPPED send records
 * (`performRevisionEffectOnce` over `claimRevisionEffect`). The pooled database
 * is a stand-in: an `artifact_materializations` table with its unique key,
 * per-connection transactions (a rollback undoes the connection's writes) and
 * the advisory transaction locks (exclusive and shared forms, held until the
 * connection's COMMIT or ROLLBACK).
 *
 * Cases:
 *   U1 a send bound the message but mailed nothing (the mailbox is not
 *      connected); the body is edited and approved again: the repeat moves the
 *      binding to the new revision and mails its text
 *   S1 a sent message whose body is edited and approved again is terminal: not
 *      re-bound, not mailed again, counted as sent, the new revision named as
 *      not mailed; the send completes
 *   D1 an in-doubt message whose body is edited and approved again is terminal:
 *      not re-bound, not mailed, counted in doubt
 *   C1 a message that becomes terminal between the send-record read and its
 *      bind (a concurrent send mails the old revision): the bind's refusal is
 *      read as terminal (the send record is read again), not a refusal of the
 *      list; one mail
 *   C2 a re-bind that holds the revision lock while a claim of the old revision
 *      starts: the claim waits, finds no binding of the old revision and mails
 *      nothing; the new revision is mailed once
 *   P1 two sent, one in doubt, two unsent; one unsent body is edited: the repeat
 *      mails only the two unsent messages, each with its current approved text
 *   R1 (the review's trigger) two of five sent, one in doubt; the sent and the
 *      in-doubt bodies are edited; the full current list is approved: the two
 *      untouched unsent messages are mailed once, the sent and in-doubt ones
 *      are not, the counts are right
 *   T1 every message is terminal: nothing is mailed, the counts are reported,
 *      the send completes
 *   T2 a terminal message whose contact is removed from the new list: nothing
 *      is done for it; the others are sent
 *   K1 a contact mailed under one body artifact appears with a NEW artifact:
 *      it is not mailed a second time (`contact_other_body`); the others are
 *      sent
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  org_id: string;
  run_id: string;
  output_id: string;
  path: string;
  extension: string;
  content_hash: string;
  artifact_id: string;
  representation_revision_id: string;
  phase: string;
};

const { db } = vi.hoisted(() => ({
  db: {
    rows: [] as Row[],
    connect: (() => {
      throw new Error("not set");
    }) as () => Promise<unknown>,
    query: (() => {
      throw new Error("not set");
    }) as (sql: string, params: unknown[]) => Promise<unknown>,
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/pooled", async () => ({
  ...(await vi.importActual<typeof import("@/lib/db/pooled")>("@/lib/db/pooled")),
  getPooledDb: () => ({
    query: (sql: string, params: unknown[]) => db.query(sql, params),
    connect: () => db.connect(),
  }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "public",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@cinatra-ai/registries", () => ({ getAgentPackage: vi.fn() }));
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForReads: vi.fn(async () => ({ registryUrl: "http://registry.test", token: "t" })),
}));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: vi.fn() }));
vi.mock("../resolve-bound-artifact-type", () => ({ resolveBoundArtifactTarget: vi.fn() }));
vi.mock("../artifact-creation", () => ({ createSemanticArtifact: vi.fn() }));
vi.mock("../artifact-extension-access", () => ({ isArtifactExtensionWriteAllowed: vi.fn(async () => true) }));
vi.mock("../matcher-enqueue", () => ({ enqueueArtifactMatchRun: vi.fn() }));
// The stored revision's bytes: the storage key names the text (`blob:<text>`).
vi.mock("../local-disk-blob-store", () => ({
  createLocalDiskBlobStore: () => ({
    openByStorageKey: async ({ storageKey }: { storageKey: string }) => ({
      stream: (async function* () {
        yield Buffer.from(storageKey.replace(/^blob:/, ""), "utf8");
      })(),
    }),
  }),
}));
vi.mock("../artifact-authoring", () => ({
  MAX_AUTHORED_CONTENT_BYTES: 10 * 1024 * 1024,
  TEXT_AUTHORING_COMPATIBLE_MIMES: new Set(["text/markdown", "text/plain"]),
}));
vi.mock("@/lib/objects/artifact-claim-store", () => ({
  readArtifactTypeClaimsForOrg: () => [
    {
      id: "claim-1",
      scope: "platform",
      objectTypeId: "@cinatra-ai/email:body",
      claimKind: "dedicated",
      extensionPackage: "@cinatra-ai/email-artifacts",
      status: "active",
      generation: 1,
      dispositions: null,
      installId: null,
      createdAt: null,
      updatedAt: null,
    },
  ],
}));
vi.mock("@cinatra-ai/objects", () => ({
  createDeterministicObjectsClient: () => ({
    typesList: async () => ({ types: [{ type: "@cinatra-ai/email:body" }] }),
  }),
}));

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { EffectNotStartedError } from "../materialization-ledger";
import {
  createTriggerEmailSendUseCases,
  type DecidedBodyRead,
  type TriggerEmailSendDeps,
} from "../../trigger-email-send-use-cases";

// ---------------------------------------------------------------------------
// The stand-in database.
// ---------------------------------------------------------------------------

/** The stored text of each revision, by `<artifact>|<revision>`. */
const revisions = new Map<string, string>();

type Conn = { id: number; undo: Array<() => void> };
const locks = new Map<string, { ex: number | null; sh: Set<number> }>();
let wakers: Array<() => void> = [];
let nextConn = 0;

async function acquire(conn: Conn, key: string, mode: "ex" | "sh") {
  for (;;) {
    const l = locks.get(key) ?? { ex: null, sh: new Set<number>() };
    locks.set(key, l);
    const exOther = l.ex !== null && l.ex !== conn.id;
    const shOther = [...l.sh].some((id) => id !== conn.id);
    if (!(mode === "ex" ? exOther || shOther : exOther)) {
      if (mode === "ex") l.ex = conn.id;
      else l.sh.add(conn.id);
      return;
    }
    await new Promise<void>((resolve) => wakers.push(resolve));
  }
}

function releaseAll(conn: Conn) {
  for (const l of locks.values()) {
    if (l.ex === conn.id) l.ex = null;
    l.sh.delete(conn.id);
  }
  const w = wakers;
  wakers = [];
  for (const wake of w) wake();
}

/** A pause on the first statement matching `re`: `reached` resolves when it
 *  is hit, the statement runs after `release()`. */
type Pause = { re: RegExp; used: boolean; reached: Promise<void>; hit: () => void; gate: Promise<void>; release: () => void };
let pauses: Pause[] = [];
function pauseAt(re: RegExp): Pause {
  let hit!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (hit = r));
  const gate = new Promise<void>((r) => (release = r));
  const p = { re, used: false, reached, hit, gate, release };
  pauses.push(p);
  return p;
}

async function run(conn: Conn | null, sql: string, params: unknown[]) {
  const pause = pauses.find((p) => !p.used && p.re.test(sql));
  if (pause) {
    pause.used = true;
    pause.hit();
    await pause.gate;
  }
  const t = sql.trim();
  const p = (n: number) => params[n - 1] as string;
  const key = (r: Pick<Row, "run_id" | "output_id" | "extension" | "content_hash">) =>
    [r.run_id, r.output_id, r.extension, r.content_hash].join("|");
  const insert = (row: Row) => {
    if (db.rows.some((r) => key(r) === key(row))) return false;
    db.rows.push(row);
    conn?.undo.push(() => {
      db.rows = db.rows.filter((r) => r !== row);
    });
    return true;
  };
  const remove = (pred: (r: Row) => boolean) => {
    const gone = db.rows.filter(pred);
    db.rows = db.rows.filter((r) => !pred(r));
    conn?.undo.push(() => {
      db.rows.push(...gone);
    });
    return gone;
  };
  if (t === "BEGIN") return { rows: [] };
  if (t === "COMMIT" || t === "ROLLBACK") {
    if (conn) {
      if (t === "ROLLBACK") for (const u of conn.undo.reverse()) u();
      conn.undo = [];
      releaseAll(conn);
    }
    return { rows: [] };
  }
  if (t === "SELECT pg_advisory_xact_lock_shared(hashtext($1))") {
    await acquire(conn!, `art:${p(1)}`, "sh");
    return { rows: [] };
  }
  if (t === "SELECT pg_advisory_xact_lock(hashtext($1))") {
    await acquire(conn!, `art:${p(1)}`, "ex");
    return { rows: [] };
  }
  if (t === "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))") {
    await acquire(conn!, `bind:${p(1)}`, "ex");
    return { rows: [] };
  }
  if (t === "SELECT 'decided' AS state") return { rows: [{ state: "decided" }] };
  if (/SELECT template_id FROM "public"\."agent_runs"/.test(sql)) {
    return { rows: p(1) === "run-1" && p(2) === "org-a" ? [{ template_id: "tpl-1" }] : [] };
  }
  if (/SELECT b\.storage_key/.test(sql)) {
    const text = p(1) === "org-a" ? revisions.get(`${p(2)}|${p(3)}`) : undefined;
    return { rows: text === undefined ? [] : [{ storage_key: `blob:${text}` }] };
  }
  if (/SELECT artifact_id, representation_revision_id FROM "public"\."artifact_materializations"/.test(sql)) {
    return {
      rows: db.rows.filter(
        (r) => r.org_id === p(1) && r.run_id === p(2) && r.output_id === p(3) && r.path === "email_fanout" && r.phase === "finalized",
      ),
    };
  }
  if (/^SELECT 1 FROM "public"\."artifact_materializations"/.test(t) && /extension = content_hash/.test(sql)) {
    const hit = db.rows.some(
      (r) => r.org_id === p(1) && r.run_id === p(2) && r.output_id === p(3) && r.path === "email_fanout" && r.extension === r.content_hash,
    );
    return { rows: hit ? [{ "?column?": 1 }] : [] };
  }
  if (/^DELETE FROM/.test(t) && /extension <> content_hash/.test(sql)) {
    remove(
      (r) =>
        r.org_id === p(1) && r.run_id === p(2) && r.output_id === p(3) && r.path === "email_fanout" && r.phase === "finalized" && r.artifact_id === p(4) && r.extension !== r.content_hash,
    );
    return { rows: [] };
  }
  if (/^DELETE FROM/.test(t) && /WHERE id = \$1/.test(sql)) {
    remove((r) => r.id === p(1) && r.org_id === p(2) && r.extension === p(3) && r.content_hash === p(3) && r.phase === "claimed");
    return { rows: [] };
  }
  if (/INSERT INTO "public"\."artifact_materializations"[\s\S]*VALUES \(\$1, \$2, \$3, \$4, NULL, 'email_fanout'/.test(sql)) {
    insert({ id: p(1), org_id: p(2), run_id: p(3), output_id: p(4), path: "email_fanout", extension: p(5), content_hash: p(6), artifact_id: p(7), representation_revision_id: p(8), phase: "finalized" });
    return { rows: [] };
  }
  if (/WITH bound AS/.test(sql)) {
    const bound = db.rows.find(
      (r) => r.org_id === p(2) && r.run_id === p(3) && r.output_id === p(4) && r.path === p(5) && r.phase === "finalized" && r.artifact_id === p(6) && r.representation_revision_id === p(7) && !(r.extension === p(8) && r.content_hash === p(8)),
    );
    if (!bound) return { rows: [] };
    const won = insert({ ...bound, id: p(1), output_id: p(4), path: p(5), extension: p(8), content_hash: p(8), phase: "claimed" });
    return { rows: won ? [{ id: p(1) }] : [] };
  }
  if (/^SELECT phase FROM/.test(t) && /output_id = \$3/.test(sql)) {
    const row = db.rows.find((r) => r.org_id === p(1) && r.run_id === p(2) && r.output_id === p(3) && r.path === p(4) && r.extension === p(5) && r.content_hash === p(5));
    return { rows: row ? [{ phase: row.phase }] : [] };
  }
  if (/SET phase = 'finalized'/.test(sql)) {
    const row = db.rows.find((r) => r.id === p(1) && r.org_id === p(2) && r.extension === p(3) && r.content_hash === p(3) && r.phase === "claimed");
    if (!row) return { rows: [] };
    row.phase = "finalized";
    return { rows: [{ id: row.id }] };
  }
  // The send record read before the binding (`readRevisionEffect`).
  if (/^SELECT phase, representation_revision_id FROM/.test(t)) {
    const row = db.rows.find((r) => r.org_id === p(1) && r.run_id === p(2) && r.output_id === p(3) && r.path === p(4) && r.extension === p(5) && r.content_hash === p(5));
    return { rows: row ? [{ phase: row.phase, representation_revision_id: row.representation_revision_id }] : [] };
  }
  // The contact seat of the run (`holdRunSeat`).
  if (/INSERT INTO "public"\."artifact_materializations"[\s\S]*VALUES \(\$1, \$2, \$3, \$4, NULL, \$5, \$6, \$6, \$7, \$8, 'finalized'\)/.test(sql)) {
    insert({ id: p(1), org_id: p(2), run_id: p(3), output_id: p(4), path: p(5), extension: p(6), content_hash: p(6), artifact_id: p(7), representation_revision_id: p(8), phase: "finalized" });
    return { rows: [] };
  }
  if (/^SELECT artifact_id FROM/.test(t)) {
    const row = db.rows.find((r) => r.org_id === p(1) && r.run_id === p(2) && r.output_id === p(3) && r.path === p(4) && r.extension === p(5) && r.content_hash === p(5) && r.phase === "finalized");
    return { rows: row ? [{ artifact_id: row.artifact_id }] : [] };
  }
  throw new Error(`unexpected statement: ${sql}`);
}

// ---------------------------------------------------------------------------
// The send.
// ---------------------------------------------------------------------------

const actor: PrimitiveActorContext = { actorType: "human", source: "route", userId: "user-1", sessionId: "s-1", orgId: "org-a" };
const CAMPAIGN_ID = "33333333-3333-4333-8333-333333333333";

type Mail = { to: string; text: string };
type Mailer = (to: string, text: string) => void;
const ok: Mailer = () => undefined;

/** Message `n`: body artifact `art-<n>`; its contact is `c<n>` unless `contactOf` gives the
 *  number of another message whose contact (and address) it has. */
let contactOf: Record<number, number> = {};
const msg = (n: number) => {
  const c = contactOf[n] ?? n;
  return { artifactId: `art-${n}`, contactId: `c${c}`, recipientEmail: `p${c}@example.com`, subject: `Subject ${n}` };
};

/** Store revision `v` of message `n` (its text is `Body <n> v<v>`). */
function revise(n: number, v: number): string {
  const rev = `rev-${n}-${v}`;
  revisions.set(`art-${n}|${rev}`, `Body ${n} v${v}`);
  return rev;
}

/** One send of the approved list `approval` (message number → revision
 *  number): the list, the bundle and the body reads all show those revisions. */
function send(approval: Array<[number, number]>, mails: Mail[], mailer: Mailer = ok) {
  const list = approval.map(([n, v]) => ({ ...msg(n), representationRevisionId: `rev-${n}-${v}` }));
  const textOf = (n: number, v: number) => revisions.get(`art-${n}|rev-${n}-${v}`)!;
  const decision = {
    id: "d-1",
    status: "released",
    decidedBy: "user-2",
    surfacedValues: {
      campaignId: CAMPAIGN_ID,
      recipients: list.map((e) => ({ email: e.recipientEmail, subject: e.subject })),
      emailBodies: list,
    },
    declaredRows: [
      { kind: "list", label: "Recipients", input: "recipients", columns: [{ label: "Email", field: "email" }, { label: "Subject", field: "subject" }] },
      { kind: "artifacts", label: "Emails", input: "emailBodies" },
    ],
  };
  const deps = {
    getCampaign: async () => null,
    getDraftsByIds: async () => [],
    sendEmail: async (m: { to: string[]; textBody: string }) => {
      mailer(m.to[0]!, m.textBody);
      mails.push({ to: m.to[0]!, text: m.textBody });
      return { providerId: "p", providerMessageId: `m-${mails.length}`, sentAt: "2026-11-26T00:00:00Z" };
    },
    getObjectByRef: async (ref: string) =>
      ref === "bundle"
        ? {
            id: ref,
            data: {
              cinatraAgentRunId: "run-1",
              drafts: approval.map(([n, v]) => ({ recipientId: msg(n).contactId, recipientEmail: msg(n).recipientEmail, subject: msg(n).subject, body: textOf(n, v) })),
            },
          }
        : { id: ref, data: { confirmedRecipients: list.map((e) => ({ contactId: e.contactId, email: e.recipientEmail })) } },
    readDecidedBody: async (ref: { artifactId: string; representationRevisionId: string }): Promise<DecidedBodyRead> => {
      const entry = list.find((e) => e.artifactId === ref.artifactId && e.representationRevisionId === ref.representationRevisionId);
      if (!entry) return { ok: false, error: "not the current decided revision" };
      return { ok: true, text: revisions.get(`${ref.artifactId}|${ref.representationRevisionId}`)!, data: { campaignId: CAMPAIGN_ID, contactId: entry.contactId } };
    },
    readCallingRun: async () => ({ runId: "run-1", stepId: "send", claim: { runId: "run-1", decisionId: "d-1" } }),
    readPublishDecision: async () => decision,
    readClaimedPublishDecision: async (_runId: string, decisionId: string) => (decisionId === "d-1" ? decision : null),
    // The decision state on the claim's own connection under the revision's
    // lock (the shipped reader's query is its own suite's subject).
    readRevisionStateUnderLock: async (query: (text: string, values: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>) => {
      const { rows } = await query("SELECT 'decided' AS state", []);
      return rows[0]?.state === "decided" ? null : "not decided";
    },
  } as unknown as TriggerEmailSendDeps;
  return createTriggerEmailSendUseCases(deps).startInitialSend(
    { serviceId: "s", campaignId: CAMPAIGN_ID, approvedDraftBundleRef: "bundle", confirmedRecipientsRef: "list" } as never,
    actor,
  ) as unknown as Promise<{ status: string; sentCount: number; alreadySentCount?: number; inDoubtCount?: number; errorMessage?: string }>;
}

const bindings = (n: number) =>
  db.rows
    .filter((r) => r.output_id === `email-body:run-1:art-${n}` && r.extension !== r.content_hash)
    .map((r) => r.representation_revision_id);
const claims = (n: number) =>
  db.rows
    .filter((r) => r.output_id === `email-body:run-1:art-${n}` && r.extension === "message-send")
    .map((r) => [r.representation_revision_id, r.phase]);

beforeEach(() => {
  db.rows = [];
  revisions.clear();
  locks.clear();
  wakers = [];
  pauses = [];
  contactOf = {};
  db.query = (sql, params) => run(null, sql, params);
  db.connect = async () => {
    nextConn += 1;
    const conn: Conn = { id: nextConn, undo: [] };
    return { query: (sql: string, params: unknown[] = []) => run(conn, sql, params), release: () => undefined };
  };
});

describe("cinatra#3089 — an unsent message moves to its newly approved revision", () => {
  it("U1 a bound but unmailed message is re-bound to the edited revision and its text is mailed", async () => {
    revise(1, 1);
    const mails: Mail[] = [];
    const first = await send([[1, 1]], mails, () => {
      throw new EffectNotStartedError("The mailbox is not connected.");
    });
    expect(first).toMatchObject({ status: "failed", sentCount: 0 });
    expect(bindings(1)).toEqual(["rev-1-1"]);
    expect(claims(1)).toEqual([]);

    revise(1, 2);
    const again = await send([[1, 2]], mails);
    expect(again.errorMessage).toBeUndefined();
    expect(again).toMatchObject({ status: "completed", sentCount: 1 });
    expect(mails).toEqual([{ to: "p1@example.com", text: "Body 1 v2" }]);
    expect(bindings(1)).toEqual(["rev-1-2"]);
    expect(claims(1)).toEqual([["rev-1-2", "finalized"]]);
  });

  it("S1 a sent message is not re-bound and not mailed again", async () => {
    revise(1, 1);
    const mails: Mail[] = [];
    expect(await send([[1, 1]], mails)).toMatchObject({ status: "completed", sentCount: 1 });
    revise(1, 2);
    const again = await send([[1, 2]], mails);
    expect(again).toMatchObject({ status: "completed", sentCount: 0, alreadySentCount: 1, inDoubtCount: 0 });
    expect(again.errorMessage).toBe(
      "draft 1 already has a send record (sent or in doubt), so its newly approved revision was not mailed (revision_not_mailed)",
    );
    expect(mails).toEqual([{ to: "p1@example.com", text: "Body 1 v1" }]);
    expect(bindings(1)).toEqual(["rev-1-1"]);
    expect(claims(1)).toEqual([["rev-1-1", "finalized"]]);
  });

  it("D1 an in-doubt message is not re-bound and not mailed", async () => {
    revise(1, 1);
    const mails: Mail[] = [];
    const first = await send([[1, 1]], mails, () => {
      throw new Error("provider timeout");
    });
    expect(first).toMatchObject({ status: "failed", inDoubtCount: 1 });
    revise(1, 2);
    const again = await send([[1, 2]], mails);
    expect(again).toMatchObject({ status: "failed", sentCount: 0, alreadySentCount: 0, inDoubtCount: 1 });
    expect(again.errorMessage).toContain("draft 1 is in doubt (in_doubt)");
    expect(again.errorMessage).toContain("so its newly approved revision was not mailed (revision_not_mailed)");
    expect(again.errorMessage).not.toContain("already_bound");
    expect(mails).toEqual([]);
    expect(bindings(1)).toEqual(["rev-1-1"]);
    expect(claims(1)).toEqual([["rev-1-1", "claimed"]]);
  });

  it("C1 a message made terminal between the send-record read and its bind: the refusal is read as terminal; one mail", async () => {
    revise(1, 1);
    revise(2, 1);
    const mails: Mail[] = [];
    // Bind revision 1 of both messages with nothing mailed.
    await send([[1, 1], [2, 1]], mails, () => {
      throw new EffectNotStartedError("The mailbox is not connected.");
    });
    // Send B of revision 2 of message 1 read the send records (none) and stops before its first bind.
    revise(1, 2);
    const beforeBind = pauseAt(/SELECT template_id FROM "public"\."agent_runs"/);
    const b = send([[1, 2], [2, 1]], mails);
    await beforeBind.reached;
    // Send A of revision 1 mails both messages meanwhile.
    const ra = await send([[1, 1], [2, 1]], mails);
    expect(ra).toMatchObject({ status: "completed", sentCount: 2 });
    beforeBind.release();
    const rb = await b;
    // The binder refused message 1 (it has a send record now); B read the record again and skipped it.
    expect(rb).toMatchObject({ status: "completed", sentCount: 0, alreadySentCount: 2, inDoubtCount: 0 });
    expect(rb.errorMessage).toBe(
      "draft 1 already has a send record (sent or in doubt), so its newly approved revision was not mailed (revision_not_mailed)",
    );
    expect(mails).toEqual([
      { to: "p1@example.com", text: "Body 1 v1" },
      { to: "p2@example.com", text: "Body 2 v1" },
    ]);
    expect(bindings(1)).toEqual(["rev-1-1"]);
  });

  it("C2 a re-bind holding the lock: a claim of the old revision waits, mails nothing; the new revision is mailed once", async () => {
    revise(1, 1);
    const mails: Mail[] = [];
    await send([[1, 1]], mails, () => {
      throw new EffectNotStartedError("The mailbox is not connected.");
    });
    // Send A of revision 1 is bound and stops right before its claim takes the lock.
    const beforeClaim = pauseAt(/^SELECT pg_advisory_xact_lock_shared/);
    const a = send([[1, 1]], mails);
    await beforeClaim.reached;
    // Send B re-binds: it checked the claims under the lock and stops before the move.
    revise(1, 2);
    const beforeMove = pauseAt(/^DELETE FROM[\s\S]*extension <> content_hash/);
    const b = send([[1, 2]], mails);
    // (A send that refuses the re-bind never reaches the move.)
    await Promise.race([beforeMove.reached, b]);
    beforeClaim.release();
    for (let i = 0; i < 50; i += 1) await new Promise((r) => setImmediate(r));
    // A waits for B's lock: nothing is mailed yet.
    expect(mails).toEqual([]);
    beforeMove.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe("failed");
    expect(ra.sentCount).toBe(0);
    expect(rb.errorMessage).toBeUndefined();
    expect(rb).toMatchObject({ status: "completed", sentCount: 1 });
    expect(mails).toEqual([{ to: "p1@example.com", text: "Body 1 v2" }]);
    expect(bindings(1)).toEqual(["rev-1-2"]);
    expect(claims(1)).toEqual([["rev-1-2", "finalized"]]);
  });

  it("P1 two sent, one in doubt, two unsent, one unsent body edited: only the unsent are mailed, each with its current text", async () => {
    for (const n of [1, 2, 3, 4, 5]) revise(n, 1);
    const mails: Mail[] = [];
    const first = await send(
      [1, 2, 3, 4, 5].map((n) => [n, 1] as [number, number]),
      mails,
      (to) => {
        if (to === "p3@example.com") throw new Error("provider timeout");
      },
    );
    expect(first).toMatchObject({ status: "failed", sentCount: 2, inDoubtCount: 1 });
    expect(mails.map((m) => m.to)).toEqual(["p1@example.com", "p2@example.com"]);

    revise(4, 2);
    const again = await send([[1, 1], [2, 1], [3, 1], [4, 2], [5, 1]], mails);
    expect(again).toMatchObject({ sentCount: 2, alreadySentCount: 2, inDoubtCount: 1 });
    expect(mails.slice(2)).toEqual([
      { to: "p4@example.com", text: "Body 4 v2" },
      { to: "p5@example.com", text: "Body 5 v1" },
    ]);
    expect([1, 2, 3, 4, 5].map(bindings)).toEqual([["rev-1-1"], ["rev-2-1"], ["rev-3-1"], ["rev-4-2"], ["rev-5-1"]]);
    expect(claims(3)).toEqual([["rev-3-1", "claimed"]]);
  });

  it("R1 two of five sent, one in doubt, sent and in-doubt bodies edited, the full list approved: the two untouched unsent are mailed once", async () => {
    for (const n of [1, 2, 3, 4, 5]) revise(n, 1);
    const mails: Mail[] = [];
    const first = await send(
      [1, 2, 3, 4, 5].map((n) => [n, 1] as [number, number]),
      mails,
      (to) => {
        if (to === "p3@example.com") throw new Error("provider timeout");
      },
    );
    // The provider error on message 3 stopped the send: 4 and 5 were not attempted.
    expect(first).toMatchObject({ status: "failed", sentCount: 2, inDoubtCount: 1 });
    expect(mails.map((m) => m.to)).toEqual(["p1@example.com", "p2@example.com"]);
    expect(bindings(4)).toEqual(["rev-4-1"]);

    // A sent body and the in-doubt body are edited and approved again, with the full current list.
    revise(1, 2);
    revise(3, 2);
    const again = await send([[1, 2], [2, 1], [3, 2], [4, 1], [5, 1]], mails);
    expect(again).toMatchObject({ status: "failed", sentCount: 2, alreadySentCount: 2, inDoubtCount: 1 });
    expect(again.errorMessage).not.toContain("already_bound");
    expect(again.errorMessage).toContain("draft 3 is in doubt (in_doubt)");
    expect(again.errorMessage).toContain(
      "draft 1 already has a send record (sent or in doubt), so its newly approved revision was not mailed (revision_not_mailed)",
    );
    expect(again.errorMessage).toContain(
      "draft 3 already has a send record (sent or in doubt), so its newly approved revision was not mailed (revision_not_mailed)",
    );
    expect(mails.slice(2)).toEqual([
      { to: "p4@example.com", text: "Body 4 v1" },
      { to: "p5@example.com", text: "Body 5 v1" },
    ]);
    // The terminal messages keep their bindings and their records.
    expect([1, 2, 3].map(bindings)).toEqual([["rev-1-1"], ["rev-2-1"], ["rev-3-1"]]);
    expect([1, 3].map(claims)).toEqual([[["rev-1-1", "finalized"]], [["rev-3-1", "claimed"]]]);

    // A third send of the same list mails nobody.
    const third = await send([[1, 2], [2, 1], [3, 2], [4, 1], [5, 1]], mails);
    expect(third).toMatchObject({ sentCount: 0, alreadySentCount: 4, inDoubtCount: 1 });
    expect(mails).toHaveLength(4);
  });

  it("T1 every message terminal: nothing is mailed, the counts are reported, the send completes", async () => {
    revise(1, 1);
    revise(2, 1);
    const mails: Mail[] = [];
    expect(await send([[1, 1], [2, 1]], mails)).toMatchObject({ status: "completed", sentCount: 2 });
    const same = await send([[1, 1], [2, 1]], mails);
    expect(same).toMatchObject({ status: "completed", sentCount: 0, alreadySentCount: 2, inDoubtCount: 0 });
    expect(same.errorMessage).toBeUndefined();
    revise(2, 2);
    const edited = await send([[1, 1], [2, 2]], mails);
    expect(edited).toMatchObject({ status: "completed", sentCount: 0, alreadySentCount: 2, inDoubtCount: 0 });
    expect(edited.errorMessage).toBe(
      "draft 2 already has a send record (sent or in doubt), so its newly approved revision was not mailed (revision_not_mailed)",
    );
    expect(mails).toHaveLength(2);
    expect(bindings(2)).toEqual(["rev-2-1"]);
  });

  it("T2 a terminal message whose contact is removed from the new list: nothing is done for it; the others are sent", async () => {
    revise(1, 1);
    revise(2, 1);
    revise(3, 1);
    const mails: Mail[] = [];
    expect(await send([[1, 1], [2, 1]], mails)).toMatchObject({ status: "completed", sentCount: 2 });
    revise(1, 2);
    const again = await send([[2, 1], [3, 1]], mails);
    expect(again).toMatchObject({ status: "completed", sentCount: 1, alreadySentCount: 1, inDoubtCount: 0 });
    expect(again.errorMessage).toBeUndefined();
    expect(mails.slice(2)).toEqual([{ to: "p3@example.com", text: "Body 3 v1" }]);
    expect(bindings(1)).toEqual(["rev-1-1"]);
  });

  it("K1 a contact mailed under one body artifact appears with a NEW artifact: not mailed twice; the others are sent", async () => {
    revise(1, 1);
    revise(2, 1);
    revise(9, 1);
    const mails: Mail[] = [];
    expect(await send([[1, 1]], mails)).toMatchObject({ status: "completed", sentCount: 1 });
    // Contact c1 now has body artifact 9 (another artifact, so another message key of the run).
    contactOf = { 9: 1 };
    const again = await send([[9, 1], [2, 1]], mails);
    expect(again).toMatchObject({ status: "failed", sentCount: 1, alreadySentCount: 0, inDoubtCount: 0 });
    expect(again.errorMessage).toBe(
      "draft 1 was not sent, its contact was already claimed for another body of this run (contact_other_body)",
    );
    expect(mails).toEqual([
      { to: "p1@example.com", text: "Body 1 v1" },
      { to: "p2@example.com", text: "Body 2 v1" },
    ]);
    expect(claims(9)).toEqual([]);
  });
});
