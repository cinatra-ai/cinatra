// REAL-POSTGRES proof for BIND-AT-CREATION (cinatra#2650). Five things cannot
// be proven with a query double, and all five are acceptance criteria:
//
//   1. BOTH create orderings bind. The /chat client fires its thread save
//      UNAWAITED and BEFORE it routes or streams, so in the field the legacy
//      mirror upsert usually INSERTs the row first and the turn path never
//      reaches its create arm. Only a real row, inserted by the real mirror
//      SQL, proves the fall-through bind actually writes.
//   2. The binding lands with the row's FIRST PERSIST, not with the turn's
//      success — so a first turn that fails afterwards still leaves a bound
//      thread.
//   3. The bound value comes from the SERVER's container, not from anything the
//      client writes: the mirror payload's own assistant-naming fields are
//      carried into the real INSERT here and must not move it.
//   4. A newly created NON-DEFAULT thread resolves at that assistant's URL with
//      NO repair write occurring — asserted by the ABSENCE of the UPDATE, via a
//      STATEMENT-level trigger that fires even when a statement matches zero
//      rows. A row snapshot or an `updated_at` comparison could not tell "the
//      repair ran and matched nothing" from "the repair never ran".
//   5. The set-once/ownership refusals, and the slug-collision refusal, against
//      the real container-unique index.
//
// Runner (the repo's standing DB-integration contract — the file tier is
// excluded from the default run):
//
//   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<live> \
//     pnpm exec vitest run src/lib/__tests__/chat-thread-container-binding.integration.test.ts
//
// The suite owns a lane-unique schema, dropped in `afterAll`.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

import { assistantThreadSchemaQueries } from "@/lib/assistant-thread-schema";
import type { AssistantRegistryEntry } from "@/lib/assistant-registry-reader";
import type { ChatRouteResolverDeps } from "@/lib/chat-route-resolver";
import type { ThreadContainer, UnboundThreadActor } from "@/lib/assistant-thread-store";

const CONNECTION = process.env.SUPABASE_DB_URL ?? "";
const RUN = process.env.CINATRA_DB_INTEGRATION_TESTS === "1" && CONNECTION.length > 0;

const SCHEMA = `t2650_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

const DEFAULT_PACKAGE = "@cinatra-ai/cinatra-assistant";
const OTHER_PACKAGE = "@acme/helper-assistant";
const REMOTE_PACKAGE = "@cinatra-ai/wordpress-assistant";

const OWNER: UnboundThreadActor = { userId: `user-owner-${SCHEMA}`, orgId: `org-${SCHEMA}` };
const STRANGER: UnboundThreadActor = { userId: `user-stranger-${SCHEMA}`, orgId: OWNER.orgId };

const DEFAULT_CONTAINER: ThreadContainer = { assistantPackage: DEFAULT_PACKAGE, instanceId: null };
const OTHER_CONTAINER: ThreadContainer = { assistantPackage: OTHER_PACKAGE, instanceId: null };
const REMOTE_CONTAINER: ThreadContainer = { assistantPackage: REMOTE_PACKAGE, instanceId: "site-1" };

type Store = typeof import("@/lib/assistant-thread-store");
type Resolver = typeof import("@/lib/chat-route-resolver");
type Inheritance = typeof import("@/lib/project-inheritance");

let admin: Client;
let store: Store;
let resolver: Resolver;
let inheritance: Inheritance;

function entry(
  over: Partial<AssistantRegistryEntry> & { packageName: string },
): AssistantRegistryEntry {
  return {
    templateId: "t",
    assistantUserId: "au",
    handle: "h",
    displayName: "Name",
    origin: "extension",
    aliases: [],
    isBuiltin: false,
    delivery: "host-runtime",
    launch: { kind: "local", targetProvider: null },
    ...over,
  };
}

const REGISTRY: AssistantRegistryEntry[] = [
  entry({ packageName: DEFAULT_PACKAGE, isBuiltin: true }),
  entry({ packageName: OTHER_PACKAGE }),
  entry({ packageName: REMOTE_PACKAGE, launch: { kind: "remote", targetProvider: "wordpress" } }),
];

/** The PRODUCTION resolver deps, with the ONE thing a test must inject — the
 *  actor identity (production derives it from the session) — bound to `actor`.
 *  Every thread lookup is the REAL store function against the REAL database, so
 *  this exercises the shipped resolution + #2649 repair path unchanged. */
function depsFor(actor: UnboundThreadActor): ChatRouteResolverDeps {
  return {
    readVisibleRegistry: async () => REGISTRY,
    authorizeInstance: async () => true,
    resolveThreadIdBySlug: async (pkg, instanceId, titleSlug) =>
      store.getAssistantThreadBySlug(pkg, instanceId, titleSlug)?.id ?? null,
    resolveThreadIdById: async (pkg, instanceId, threadId) =>
      store.getAssistantThreadByIdInContainer(pkg, instanceId, threadId)?.id ?? null,
    resolveUnboundThreadIdById: async (threadId) => {
      const t = store.getOwnedUnboundAssistantThreadById(threadId, actor);
      if (!t) return null;
      store.repairImplicitDefaultThreadBinding(t.id, actor);
      return t.id;
    },
    resolveUnboundThreadIdBySlug: async (titleSlug) => {
      const t = store.getOwnedUnboundAssistantThreadBySlug(titleSlug, actor);
      if (!t) return null;
      store.repairImplicitDefaultThreadBinding(t.id, actor);
      return t.id;
    },
  };
}

async function row(threadId: string): Promise<Record<string, unknown>> {
  const res = await admin.query(
    `SELECT assistant_package, instance_id, title_slug, owner_user_id, updated_at, origin
       FROM "${SCHEMA}"."assistant_threads" WHERE id = $1`,
    [threadId],
  );
  return res.rows[0] as Record<string, unknown>;
}

/** Run the /chat mirror upsert EXACTLY as `upsertChatThreadInDatabase` composes
 *  it, against the real database — the writer that usually wins the create race.
 *  `payload` is the client's own JSON body, so a test can plant whatever
 *  assistant-naming fields it likes in it. */
async function mirrorSave(payload: { id: string } & Record<string, unknown>): Promise<void> {
  const queries = inheritance.buildAssistantThreadMirrorQueries({
    schemaName: SCHEMA,
    thread: payload,
    explicitMirrorOrgId: OWNER.orgId,
  });
  for (const q of queries) await admin.query(q.text, q.values);
}

/** The statement-level UPDATE audit (AC#4). A STATEMENT-level AFTER UPDATE
 *  trigger fires ONCE PER STATEMENT even when the statement matches zero rows —
 *  which is exactly the distinction the AC needs, since #2649's repair is a
 *  conditional UPDATE that would match nothing against an already-bound row. A
 *  row-level trigger, a row snapshot, or an `updated_at` comparison would all be
 *  silent for an attempted-but-matched-nothing repair. */
async function installUpdateAudit(): Promise<void> {
  await admin.query(`CREATE TABLE "${SCHEMA}"."update_audit" (n bigserial primary key)`);
  await admin.query(`
    CREATE FUNCTION "${SCHEMA}".note_update() RETURNS trigger AS $$
    BEGIN INSERT INTO "${SCHEMA}"."update_audit" DEFAULT VALUES; RETURN NULL; END;
    $$ LANGUAGE plpgsql;
  `);
  await admin.query(`
    CREATE TRIGGER audit_thread_updates AFTER UPDATE ON "${SCHEMA}"."assistant_threads"
    FOR EACH STATEMENT EXECUTE FUNCTION "${SCHEMA}".note_update();
  `);
}

async function resetUpdateAudit(): Promise<void> {
  await admin.query(`TRUNCATE "${SCHEMA}"."update_audit"`);
}

async function updateStatementCount(): Promise<number> {
  const res = await admin.query(`SELECT count(*)::int AS n FROM "${SCHEMA}"."update_audit"`);
  return (res.rows[0] as { n: number }).n;
}

const describeDb = RUN ? describe : describe.skip;

beforeAll(async () => {
  if (!RUN) return;
  admin = new Client({ connectionString: CONNECTION, connectionTimeoutMillis: 5_000 });
  await admin.connect();
  await admin.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  for (const q of assistantThreadSchemaQueries(SCHEMA)) {
    await admin.query(q.text);
  }
  await installUpdateAudit();

  // The store reads its schema at MODULE LOAD, so the env must be set before
  // the dynamic imports below. The schema is already provisioned above, so the
  // (whole-store) bootstrap DDL is short-circuited rather than re-run here.
  process.env.SUPABASE_SCHEMA = SCHEMA;
  process.env.SUPABASE_DB_URL = CONNECTION;
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized =
    true;

  store = await import("@/lib/assistant-thread-store");
  resolver = await import("@/lib/chat-route-resolver");
  inheritance = await import("@/lib/project-inheritance");
}, 60_000);

afterAll(async () => {
  if (!RUN || !admin) return;
  await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.end();
});

afterEach(async () => {
  if (!RUN) return;
  await resetUpdateAudit();
});

describeDb("cinatra#2650 — bind at creation (real Postgres)", () => {

  // -------------------------------------------------------------------------
  // AC#1 — a thread whose first turn completes carries the binding, default and
  // non-default alike, on BOTH create orderings.
  // -------------------------------------------------------------------------

  it("TURN WINS: the turn path's create arm binds the container in its own INSERT — default and non-default", async () => {
    for (const container of [DEFAULT_CONTAINER, OTHER_CONTAINER, REMOTE_CONTAINER]) {
      const id = randomUUID();
      // exactly what streamAgUiChatTurn's create arm now does
      store.createAssistantThread({
        id,
        ownerUserId: OWNER.userId,
        orgId: OWNER.orgId,
        assistantPackage: container.assistantPackage,
        instanceId: container.instanceId,
      });
      const r = await row(id);
      expect(r.assistant_package).toBe(container.assistantPackage);
      expect(r.instance_id).toBe(container.instanceId);
      // a titleless create leaves the slug unminted, so the bound INSERT is
      // outside the partial container-unique index and cannot collide
      expect(r.title_slug).toBeNull();
    }
  });

  it("MIRROR WINS (the field's ordering): the real mirror upsert INSERTs an UNBOUND row, and the turn's set-once bind homes it — default and non-default", async () => {
    for (const container of [DEFAULT_CONTAINER, OTHER_CONTAINER, REMOTE_CONTAINER]) {
      const id = randomUUID();
      await mirrorSave({ id, title: "Hello", ownerUserId: OWNER.userId, messages: [] });
      // the mirror genuinely writes neither half of the binding
      const before = await row(id);
      expect(before.assistant_package).toBeNull();
      expect(before.instance_id).toBeNull();
      expect(before.origin).toBe("legacy-chat");

      expect(store.bindThreadContainerIfUnbound(id, container, OWNER)).toEqual({ kind: "bound" });
      const after = await row(id);
      expect(after.assistant_package).toBe(container.assistantPackage);
      expect(after.instance_id).toBe(container.instanceId);
    }
  });

  it("the bind does NOT move updated_at — recording a thread's home is not thread activity, and updated_at orders the sidebar", async () => {
    const id = randomUUID();
    await mirrorSave({ id, title: "T", ownerUserId: OWNER.userId, messages: [] });
    const before = await row(id);
    store.bindThreadContainerIfUnbound(id, OTHER_CONTAINER, OWNER);
    expect((await row(id)).updated_at).toEqual(before.updated_at);
  });

  // -------------------------------------------------------------------------
  // AC#2 — a first turn that FAILS after the row is inserted still leaves the
  // thread bound (the binding writes with the insert, not with turn success).
  // -------------------------------------------------------------------------

  it("A FAILED FIRST TURN still leaves a bound thread — on both orderings", async () => {
    // turn-wins: the row is created bound, then the producer throws
    const a = randomUUID();
    store.createAssistantThread({
      id: a,
      ownerUserId: OWNER.userId,
      orgId: OWNER.orgId,
      assistantPackage: OTHER_PACKAGE,
      instanceId: null,
    });
    await expect(
      (async () => {
        throw new Error("the producer failed after the row was inserted");
      })(),
    ).rejects.toThrow();
    expect((await row(a)).assistant_package).toBe(OTHER_PACKAGE);

    // mirror-wins: the row exists unbound, the turn binds it, then fails
    const b = randomUUID();
    await mirrorSave({ id: b, title: "T", ownerUserId: OWNER.userId, messages: [] });
    store.bindThreadContainerIfUnbound(b, OTHER_CONTAINER, OWNER);
    expect((await row(b)).assistant_package).toBe(OTHER_PACKAGE);
  });

  // -------------------------------------------------------------------------
  // AC#3 — the binding comes ONLY from the server-resolved container.
  // -------------------------------------------------------------------------

  it("a mirror payload NAMING a different package cannot move the binding — the mirror is package-blind by construction", async () => {
    const id = randomUUID();
    await mirrorSave({
      id,
      title: "T",
      ownerUserId: OWNER.userId,
      messages: [],
      // every client-controlled assistant-naming field the payload can carry
      assistantPackage: "@evil/hijack-assistant",
      instanceId: "someone-elses-site",
      activeAssistantHandle: "evil",
      taggedAssistantUserIds: ["evil-user"],
    });
    // the mirror wrote NEITHER half, despite the payload naming both
    const before = await row(id);
    expect(before.assistant_package).toBeNull();
    expect(before.instance_id).toBeNull();

    // and the server's container is what lands
    store.bindThreadContainerIfUnbound(id, DEFAULT_CONTAINER, OWNER);
    const after = await row(id);
    expect(after.assistant_package).toBe(DEFAULT_PACKAGE);
    expect(after.instance_id).toBeNull();
  });

  it("the CONTAINER GATE refuses a package the actor's registry does not contain — the caller can never name its way into one", async () => {
    const deps = { readVisibleRegistry: async () => REGISTRY, authorizeInstance: async () => true };
    await expect(
      resolver.resolveChatContainer({ assistantPackage: "@evil/hijack-assistant" }, deps),
    ).resolves.toEqual({ ok: false, code: "unknown-assistant" });
    // and a wrong-cased in-audience assertion binds the REGISTRY's spelling
    const ok = await resolver.resolveChatContainer(
      { assistantPackage: OTHER_PACKAGE.toUpperCase() },
      deps,
    );
    expect(ok).toEqual({ ok: true, container: OTHER_CONTAINER });

    const id = randomUUID();
    await mirrorSave({ id, title: "T", ownerUserId: OWNER.userId, messages: [] });
    store.bindThreadContainerIfUnbound(id, (ok as { container: ThreadContainer }).container, OWNER);
    expect((await row(id)).assistant_package).toBe(OTHER_PACKAGE); // canonical, not the caller's
  });

  // -------------------------------------------------------------------------
  // AC#4 — a new NON-DEFAULT thread resolves at that assistant's URL, and NO
  // repair write occurs (asserted by ABSENCE, via the statement-level audit).
  // -------------------------------------------------------------------------

  it("a newly created NON-DEFAULT thread resolves at ITS assistant's URL with NO repair statement attempted", async () => {
    const id = randomUUID();
    store.createAssistantThread({
      id,
      ownerUserId: OWNER.userId,
      orgId: OWNER.orgId,
      assistantPackage: OTHER_PACKAGE,
      instanceId: null,
    });
    await resetUpdateAudit(); // the creating request has returned

    const res = await resolver.resolveChatRoute(["acme", "helper-assistant", id], depsFor(OWNER));
    expect(res).toMatchObject({ kind: "resolved", threadId: id });
    expect((res as { assistant: { packageName: string } }).assistant.packageName).toBe(OTHER_PACKAGE);

    // THE ABSENCE ASSERTION: a statement-level AFTER UPDATE trigger fires even
    // for a statement that matches zero rows, so a zero count proves the repair
    // was never even ATTEMPTED — not merely that it changed nothing.
    expect(await updateStatementCount()).toBe(0);
  });

  it("the instance-scoped case resolves at its instance URL, also with no repair statement", async () => {
    const id = randomUUID();
    store.createAssistantThread({
      id,
      ownerUserId: OWNER.userId,
      orgId: OWNER.orgId,
      assistantPackage: REMOTE_PACKAGE,
      instanceId: "site-1",
    });
    await resetUpdateAudit();

    const res = await resolver.resolveChatRoute(
      ["cinatra-ai", "wordpress-assistant", "site-1", id],
      depsFor(OWNER),
    );
    expect(res).toMatchObject({ kind: "resolved", threadId: id });
    expect(await updateStatementCount()).toBe(0);
  });

  it("the CONTROL: an UNBOUND row DOES take #2649's repair on the same route — so the zero-count above is a real absence, not a dead trigger", async () => {
    const id = randomUUID();
    await mirrorSave({ id, title: "T", ownerUserId: OWNER.userId, messages: [] });
    await resetUpdateAudit();

    const res = await resolver.resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant", id],
      depsFor(OWNER),
    );
    expect(res).toMatchObject({ kind: "resolved", threadId: id });
    expect(await updateStatementCount()).toBeGreaterThan(0);
    expect((await row(id)).assistant_package).toBe(DEFAULT_PACKAGE);
  });

  it("a thread bound at creation is ALSO addressable by its title-slug once one mints, in its own container", async () => {
    const id = randomUUID();
    store.createAssistantThread({
      id,
      ownerUserId: OWNER.userId,
      orgId: OWNER.orgId,
      assistantPackage: OTHER_PACKAGE,
      instanceId: null,
    });
    const slug = store.ensureThreadSlug(id, "Quarterly planning");
    expect(slug).toBeTruthy();
    const res = await resolver.resolveChatRoute(
      ["acme", "helper-assistant", slug!],
      depsFor(OWNER),
    );
    expect(res).toMatchObject({ kind: "resolved", threadId: id });
  });

  // -------------------------------------------------------------------------
  // Set-once, ownership, and the concurrency/collision refusals.
  // -------------------------------------------------------------------------

  it("SET-ONCE: a bound thread is never re-pointed, and the outcome names the container it actually lives in", async () => {
    const id = randomUUID();
    store.createAssistantThread({
      id,
      ownerUserId: OWNER.userId,
      orgId: OWNER.orgId,
      assistantPackage: OTHER_PACKAGE,
      instanceId: null,
    });
    expect(store.bindThreadContainerIfUnbound(id, DEFAULT_CONTAINER, OWNER)).toEqual({
      kind: "bound-elsewhere",
      container: OTHER_CONTAINER,
    });
    expect((await row(id)).assistant_package).toBe(OTHER_PACKAGE);
  });

  it("an idempotent re-assert of the SAME container writes nothing", async () => {
    const id = randomUUID();
    await mirrorSave({ id, title: "T", ownerUserId: OWNER.userId, messages: [] });
    expect(store.bindThreadContainerIfUnbound(id, OTHER_CONTAINER, OWNER)).toEqual({ kind: "bound" });
    await resetUpdateAudit();
    expect(store.bindThreadContainerIfUnbound(id, OTHER_CONTAINER, OWNER)).toEqual({
      kind: "already-in-container",
    });
    // the second call's conditional UPDATE matched nothing; the row is untouched
    expect((await row(id)).assistant_package).toBe(OTHER_PACKAGE);
  });

  it("OWNERSHIP: a stranger cannot home another actor's unbound thread — and there is NO platform-admin bypass to try", async () => {
    const id = randomUUID();
    await mirrorSave({ id, title: "T", ownerUserId: OWNER.userId, messages: [] });
    expect(store.bindThreadContainerIfUnbound(id, OTHER_CONTAINER, STRANGER)).toEqual({
      kind: "refused-ineligible",
    });
    expect((await row(id)).assistant_package).toBeNull();
  });

  it("a TEAM-owned row and a FOREIGN-ORG row both refuse", async () => {
    const team = randomUUID();
    await mirrorSave({ id: team, title: "T", teamId: `team-${SCHEMA}`, messages: [] });
    expect(store.bindThreadContainerIfUnbound(team, OTHER_CONTAINER, OWNER)).toEqual({
      kind: "refused-ineligible",
    });
    expect((await row(team)).assistant_package).toBeNull();

    const foreign = randomUUID();
    store.createAssistantThread({ id: foreign, ownerUserId: OWNER.userId, orgId: `other-org-${SCHEMA}` });
    expect(store.bindThreadContainerIfUnbound(foreign, OTHER_CONTAINER, OWNER)).toEqual({
      kind: "refused-ineligible",
    });
    expect((await row(foreign)).assistant_package).toBeNull();
  });

  it("an ABSENT row is reported as absent, not as a refusal", async () => {
    expect(store.bindThreadContainerIfUnbound(randomUUID(), OTHER_CONTAINER, OWNER)).toEqual({
      kind: "absent",
    });
  });

  // GENUINELY OVERLAPPING, on two independent connections: B's statement is
  // issued while A's transaction still holds the row lock, so B physically
  // WAITS on A and only then re-evaluates its own WHERE clause. That is the
  // property the set-once design rests on (Postgres re-checks a conditional
  // UPDATE's predicate after the lock wait), and two sequential calls could
  // never demonstrate it. The store's own statement is synchronous, so the
  // contention is staged with the exact SQL the primitive issues, and the
  // primitive is then run against the committed outcome.
  it("CONCURRENT binders racing two DIFFERENT containers: the second statement WAITS on the first and then matches nothing — exactly one write lands", async () => {
    const id = randomUUID();
    await mirrorSave({ id, title: "T", ownerUserId: OWNER.userId, messages: [] });

    const a = new Client({ connectionString: CONNECTION });
    const b = new Client({ connectionString: CONNECTION });
    await a.connect();
    await b.connect();
    try {
      const bind = (pkg: string, instance: string | null) => ({
        text: `UPDATE "${SCHEMA}"."assistant_threads"
                 SET assistant_package = $1, instance_id = $2, title_slug = NULLIF(title_slug, '')
               WHERE id = $3
                 AND COALESCE(assistant_package, '') = ''
                 AND COALESCE(instance_id, '') = ''
                 AND COALESCE(team_id, '') = ''
                 AND owner_user_id = $4
                 AND (COALESCE(org_id, '') = '' OR org_id = $5)`,
        values: [pkg, instance, id, OWNER.userId, OWNER.orgId],
      });

      await a.query("BEGIN");
      await b.query("BEGIN");
      const aRes = await a.query(bind(OTHER_PACKAGE, null).text, bind(OTHER_PACKAGE, null).values);
      expect(aRes.rowCount).toBe(1);

      // Issued NOW, while A is uncommitted and holding the row lock — this
      // promise cannot settle until A commits below.
      const bPending = b.query(
        bind(REMOTE_PACKAGE, "site-1").text,
        bind(REMOTE_PACKAGE, "site-1").values,
      );
      let bSettled = false;
      void bPending.then(() => {
        bSettled = true;
      });
      await new Promise((r) => setTimeout(r, 150));
      expect(bSettled).toBe(false); // genuinely blocked on A's row lock

      await a.query("COMMIT");
      const bRes = await bPending;
      await b.query("COMMIT");
      expect(bRes.rowCount).toBe(0); // predicate re-checked after the wait
    } finally {
      await a.end();
      await b.end();
    }

    // exactly one write landed, and a later binder is told where the row lives
    expect((await row(id)).assistant_package).toBe(OTHER_PACKAGE);
    expect(store.bindThreadContainerIfUnbound(id, REMOTE_CONTAINER, OWNER)).toEqual({
      kind: "bound-elsewhere",
      container: OTHER_CONTAINER,
    });
    expect((await row(id)).assistant_package).toBe(OTHER_PACKAGE); // never re-pointed
  });

  it("SLUG COLLISION in the TARGET container refuses and leaves the row byte-unchanged — a minted slug is stable forever", async () => {
    // an already-bound thread owning the slug in the target container…
    const held = randomUUID();
    store.createAssistantThread({
      id: held,
      ownerUserId: OWNER.userId,
      orgId: OWNER.orgId,
      title: "Shared title",
      assistantPackage: OTHER_PACKAGE,
      instanceId: null,
    });
    const heldSlug = (await row(held)).title_slug as string;
    expect(heldSlug).toBeTruthy();

    // …and an UNBOUND row that already carries the SAME slug (only reachable
    // for a pre-existing titled row; neither creation seam mints one)
    const victim = randomUUID();
    await admin.query(
      `INSERT INTO "${SCHEMA}"."assistant_threads" (id, owner_user_id, org_id, title, title_slug)
       VALUES ($1, $2, $3, 'Shared title', $4)`,
      [victim, OWNER.userId, OWNER.orgId, heldSlug],
    );

    expect(store.bindThreadContainerIfUnbound(victim, OTHER_CONTAINER, OWNER)).toEqual({
      kind: "refused-slug-collision",
    });
    const after = await row(victim);
    expect(after.assistant_package).toBeNull(); // unchanged
    expect(after.title_slug).toBe(heldSlug); // NEVER cleared, NEVER re-minted
    // and the row stays reachable exactly as #2649 leaves it
    expect(store.getOwnedUnboundAssistantThreadBySlug(heldSlug, OWNER)?.id).toBe(victim);
  });

  it("a MALFORMED partial row (an instance with no package) is refused, never adopted into a scope nobody authorized", async () => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "${SCHEMA}"."assistant_threads" (id, owner_user_id, org_id, instance_id)
       VALUES ($1, $2, $3, 'orphan-site')`,
      [id, OWNER.userId, OWNER.orgId],
    );
    expect(store.bindThreadContainerIfUnbound(id, OTHER_CONTAINER, OWNER)).toEqual({
      kind: "refused-malformed-partial",
    });
    const after = await row(id);
    expect(after.assistant_package).toBeNull();
    expect(after.instance_id).toBe("orphan-site");
  });

  // -------------------------------------------------------------------------
  // AC#5 — #2649's behavioural assertions still hold on this schema.
  // -------------------------------------------------------------------------

  it("PRE-EXISTING unbound rows still resolve and repair exactly as #2649 pinned", async () => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "${SCHEMA}"."assistant_threads" (id, owner_user_id, org_id, title, assistant_package, title_slug)
       VALUES ($1, $2, $3, 'The reported thread', '', '')`,
      [id, OWNER.userId, OWNER.orgId],
    );
    const res = await resolver.resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant", id],
      depsFor(OWNER),
    );
    expect(res).toMatchObject({ kind: "resolved", threadId: id });
    const after = await row(id);
    expect(after.assistant_package).toBe(DEFAULT_PACKAGE);
    expect(after.title_slug).toBeNull(); // '' normalized out of the partial index

    // …and a stranger still cannot claim one
    const other = randomUUID();
    await admin.query(
      `INSERT INTO "${SCHEMA}"."assistant_threads" (id, owner_user_id, org_id, title)
       VALUES ($1, $2, $3, 'Not yours')`,
      [other, OWNER.userId, OWNER.orgId],
    );
    expect(
      await resolver.resolveChatRoute(["cinatra-ai", "cinatra-assistant", other], depsFor(STRANGER)),
    ).toEqual({ kind: "not-found" });
    expect((await row(other)).assistant_package).toBeNull();
  });

  it("a thread bound at creation into a NON-DEFAULT container is NOT adoptable through the implicit-default alias", async () => {
    const id = randomUUID();
    store.createAssistantThread({
      id,
      ownerUserId: OWNER.userId,
      orgId: OWNER.orgId,
      assistantPackage: OTHER_PACKAGE,
      instanceId: null,
    });
    expect(store.getOwnedUnboundAssistantThreadById(id, OWNER)).toBeNull();
    expect(store.repairImplicitDefaultThreadBinding(id, OWNER)).toBe(false);
    expect(
      await resolver.resolveChatRoute(["cinatra-ai", "cinatra-assistant", id], depsFor(OWNER)),
    ).toEqual({ kind: "not-found" });
    expect((await row(id)).assistant_package).toBe(OTHER_PACKAGE);
  });
});
