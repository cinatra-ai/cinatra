/**
 * cinatra#2094 finding F7-A — a multi-file extension skill must never be pinned
 * to a router-ONLY bundle head, AND the heal that unpins it must never touch a
 * head the authority actually owns.
 *
 * THE DEFECT THIS PINS, as measured on a real instance: the catalog registration
 * gives every installed skill a lifecycle `active_revision_id` whose stored blob
 * is only the SKILL.md body. `captureSkillBundleFromDisk`'s pre-S1 re-baseline
 * then seeded a bundle-of-ONE head from it. Because that head's revision id
 * carries no `bundle:` prefix, capture classified the skill as an
 * `authorityOwnedDivergence` and NEVER advanced the head again — so the stored
 * manifest could not gain the `references/*` files the router links to, and S2's
 * fail-closed one-hop lint (cinatra#2089) then REFUSED the skill as an upload
 * candidate on every sync, forever.
 *
 * Measured consequence: after a readiness saga that rendered "AI setup complete —
 * 22 skill(s) uploaded", exactly the 6 catalog skills with MULTI-FILE bundles had
 * no `cinatra.anthropic_skill_sync` row — including 3 of the 5 the Cinatra
 * assistant itself requires (`chat-assistant-core`, `chat-extension-authoring`,
 * `chat-automation-authoring`), while the 2 single-file ones
 * (`company-research`, `blog-content`) synced fine. The first `/chat` turn then
 * failed loud on skills the wizard claimed to have synced.
 *
 * THE TWO HAZARDS THE HEAL ITSELF CREATES, and which these cases pin closed
 * (codex round-1 blockers on this branch):
 *
 *   1. a custom/personal skill is a DELIBERATE bundle of one whose disk write
 *      rewrites only `SKILL.md`, so manifest CARDINALITY cannot tell it apart
 *      from the defective seed. The discriminator is durable ROW PROVENANCE —
 *      chiefly `skill_revisions.bundle_digest IS NULL`, a column an append-only
 *      table can only ever set at INSERT and which the lifecycle write path
 *      always stamps when it records a file set;
 *   2. the head replacement must be a TARGET-ROW compare-and-swap. A guard
 *      expressed as a correlated subquery over `skill_revision_files` is NOT
 *      race-free under READ COMMITTED: the subquery runs in the statement's
 *      snapshot, so it can see a concurrent transaction's new head row while that
 *      transaction's manifest rows are still invisible, pass, and clobber a
 *      freshly installed authority head.
 *
 * Split in two: the pure SQL-shape cases (no DB) and the behavioural cases, which
 * drive the real `captureSkillBundleFromDisk` over a scripted row sequence so the
 * classification is enforced deterministically in CI. The same scenarios are
 * re-proven against a REAL Postgres — including a genuine two-transaction race —
 * in `integration/skill-bundle-store.integration.test.ts`.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const capturedQueries: Array<{ text: string; values: unknown[] }> = [];
/** Successive answers to the head-pointer SELECT, in call order. */
let headReads: Array<Array<Record<string, unknown>>> = [];
/** Successive answers to the provenance classification SELECT. */
let classifications: Array<Array<Record<string, unknown>>> = [];
/** Successive answers to the SEED's lifecycle-revision lookup. */
let seedLookups: Array<Array<Record<string, unknown>>> = [];

vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://unused",
}));
vi.mock("@/lib/postgres-sync", () => ({
  // Answers are routed by query SHAPE, not by call order, so a test scripts the
  // reads it cares about and stays insensitive to how many writes ride along.
  runPostgresQueriesSync: vi.fn((opts: { queries: Array<{ text: string; values?: unknown[] }> }) =>
    opts.queries.map((q) => {
      capturedQueries.push({ text: q.text, values: q.values ?? [] });
      if (/SELECT skill_id, revision_id, bundle_digest/.test(q.text)) {
        return { rows: headReads.shift() ?? [], rowCount: 0 };
      }
      if (q.text.includes("router_file_count")) {
        return { rows: classifications.shift() ?? [], rowCount: 0 };
      }
      if (q.text.includes("sk.active_revision_id")) {
        return { rows: seedLookups.shift() ?? [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
  ),
}));

const {
  buildRevisionBundleQueries,
  captureSkillBundleFromDisk,
  computeBundleDigest,
  derivedBundleRevisionId,
  SKILL_ROUTER_PATH,
} = await import("@/lib/skill-bundle-store");

const bytes = (s: string) => Buffer.from(s, "utf8");
const d = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const MULTI_FILE = {
  revisionId: "bundle:deadbeef",
  skillId: "@cinatra-ai/chat:chat-assistant-core",
  files: [
    { path: SKILL_ROUTER_PATH, bytes: bytes("# router\n[ref](references/a.md)\n"), isRouter: true },
    { path: "references/a.md", bytes: bytes("# a\n") },
  ],
};

/** The head UPSERT is the last query the builder emits. */
const headQuery = (qs: Array<{ text: string }>) => qs[qs.length - 1].text;

describe("buildRevisionBundleQueries — head guards", () => {
  it("`always` writes an UNGUARDED head advance (the lifecycle write path)", () => {
    const q = buildRevisionBundleQueries("cinatra", MULTI_FILE, { headGuard: "always" }).at(-1)!;
    expect(q.text).toContain("ON CONFLICT (skill_id) DO UPDATE");
    expect(q.text).not.toContain("WHERE");
    expect(q.values).toHaveLength(3);
  });

  it("`only-derived` advances ONLY over a disk-derived head (unchanged behaviour)", () => {
    const text = headQuery(buildRevisionBundleQueries("cinatra", MULTI_FILE, { headGuard: "only-derived" }));
    expect(text).toContain("revision_id LIKE 'bundle:%'");
  });

  it("`only-if-absent` never overwrites — the SEED can only install a missing head", () => {
    const text = headQuery(buildRevisionBundleQueries("cinatra", MULTI_FILE, { headGuard: "only-if-absent" }));
    expect(text).toContain("ON CONFLICT (skill_id) DO NOTHING");
    expect(text).not.toContain("DO UPDATE");
  });

  it("the CAS guard compares the INCUMBENT head row's own columns against BOUND params", () => {
    const q = buildRevisionBundleQueries("cinatra", MULTI_FILE, {
      headGuard: { cas: { revisionId: "rev-seeded", bundleDigest: "digest-seeded", skillPayload: '{"a":1}' } },
    }).at(-1)!;
    expect(q.text).toContain('"cinatra"."skill_bundle_heads".revision_id = $4');
    expect(q.text).toContain('"cinatra"."skill_bundle_heads".bundle_digest = $5');
    // The compared values are PARAMETERS, never interpolated into the SQL.
    expect(q.values).toEqual([
      MULTI_FILE.skillId,
      MULTI_FILE.revisionId,
      expect.any(String),
      "rev-seeded",
      "digest-seeded",
      '{"a":1}',
    ]);
    expect(q.text).not.toContain("rev-seeded");
    // A guard correlated to EXCLUDED (the incoming row) would always be true and
    // would silently clobber any head at all.
    expect(q.text).not.toContain("EXCLUDED.revision_id =");
  });

  it("the CAS also LOCKS and re-checks the classified catalog payload", () => {
    // codex round-4 finding: a head-only CAS misses a skill ENTERING the
    // custom/personal class, because a raw catalog writer
    // (`compileAndRegisterAgentSkillsViaPg`) flips `payload` with a bare
    // `ON CONFLICT ... DO UPDATE SET payload` that writes no revision and no head.
    // The ownership CTE runs BEFORE the head upsert, takes the row lock, and
    // re-checks the payload the classification was decided on — so the head write
    // produces nothing at all if the class changed underneath.
    const text = headQuery(
      buildRevisionBundleQueries("cinatra", MULTI_FILE, {
        headGuard: { cas: { revisionId: "r", bundleDigest: "b", skillPayload: "{}" } },
      }),
    );
    expect(text).toContain("WITH ownership AS (");
    expect(text).toContain('SELECT 1 FROM "cinatra"."skills" WHERE id = $1 AND payload = $6 FOR UPDATE');
    // Gated on the CTE: an empty `ownership` inserts NOTHING.
    expect(text).toContain("SELECT $1, $2, $3, now() FROM ownership");
    // Compared as TEXT — never a `payload::jsonb` cast a malformed row could
    // abort the whole write on.
    expect(text).not.toContain("jsonb");
  });

  it("NO head guard resolves its CONFLICT with a correlated subquery — the race-unsafe shape", () => {
    // codex round-1 finding #2: under READ COMMITTED an ON CONFLICT DO UPDATE
    // re-evaluates its WHERE against the LATEST committed version of the head row,
    // but a subquery inside that WHERE still runs in the statement's snapshot — so
    // it can see a concurrent lifecycle transaction's new head row while that
    // transaction's manifest rows are invisible, pass, and clobber it. Structural
    // pin: the conflict resolution reads nothing but the head row's own columns.
    // (The CAS's ownership CTE is not an exception: it is evaluated BEFORE the
    // conflict, and it holds a row lock rather than trusting a snapshot.)
    for (const headGuard of [
      "always",
      "only-derived",
      "only-if-absent",
      { cas: { revisionId: "r", bundleDigest: "b", skillPayload: "{}" } },
    ] as const) {
      const text = headQuery(buildRevisionBundleQueries("cinatra", MULTI_FILE, { headGuard }));
      const conflict = text.slice(text.indexOf("ON CONFLICT"));
      expect(conflict).not.toContain("SELECT");
      expect(conflict).not.toContain("skill_revision_files");
      expect(conflict).not.toContain("skills");
    }
  });

  it("schema identifiers are quoted in the guard clause too", () => {
    const text = headQuery(
      buildRevisionBundleQueries('we"ird', MULTI_FILE, {
        headGuard: { cas: { revisionId: "r", bundleDigest: "b", skillPayload: "{}" } },
      }),
    );
    expect(text).toContain('"we""ird"."skill_bundle_heads".revision_id = $4');
  });

  it("still records every manifest entry alongside the guarded head", () => {
    const qs = buildRevisionBundleQueries("cinatra", MULTI_FILE, {
      headGuard: { cas: { revisionId: "r", bundleDigest: "b", skillPayload: "{}" } },
    });
    const manifestInserts = qs.filter((q) => /INSERT INTO\s+"cinatra"\."skill_revision_files"/.test(q.text));
    expect(manifestInserts).toHaveLength(2);
    expect(qs.filter((q) => q.text.includes("skill_bundle_blobs"))).toHaveLength(2);
    expect(qs.some((q) => (q.values ?? []).includes(d("# a\n")))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Behavioural: which heads the heal is allowed to replace.
// ---------------------------------------------------------------------------

const SKILL_ID = "@cinatra-ai/chat:chat-assistant-core";
const ROUTER_BODY = "# router\n[ref](references/a.md)\n";
const SEED_REVISION = "rev-lifecycle-0001";

/** The bundle-of-ONE digest the defective seed minted from the router blob. */
const SEEDED_HEAD_DIGEST = computeBundleDigest([{ path: SKILL_ROUTER_PATH, digest: d(ROUTER_BODY) }]);
/** What the MULTI-FILE disk bundle content-addresses to (what a heal installs). */
const DISK_DIGEST = computeBundleDigest([
  { path: SKILL_ROUTER_PATH, digest: d(ROUTER_BODY) },
  { path: "references/a.md", digest: d("# a\n") },
]);
const DISK_REVISION = derivedBundleRevisionId(SKILL_ID, DISK_DIGEST);

let diskDir: string;

/** Materialize a MULTI-FILE skill directory (the shape the heal exists for). */
function writeMultiFileSkill(): string {
  diskDir = mkdtempSync(path.join(tmpdir(), "skill-heal-"));
  mkdirSync(path.join(diskDir, "references"), { recursive: true });
  writeFileSync(path.join(diskDir, SKILL_ROUTER_PATH), ROUTER_BODY);
  writeFileSync(path.join(diskDir, "references", "a.md"), "# a\n");
  return path.join(diskDir, SKILL_ROUTER_PATH);
}

/**
 * `captureSkillBundleFromDisk` probes the head pointer three times: the seed's
 * own probe (which returns early, so the seed no-ops), the provenance read's
 * probe, and the read-back AFTER the guarded write. `afterWrite` scripts that
 * last one — it is what the capture reports, so it is how a CAS MISS is
 * expressed (the incumbent head still stands).
 */
function scriptHead(
  headRow: Record<string, unknown>,
  classification: Record<string, unknown>,
  afterWrite?: Record<string, unknown>,
) {
  headReads = [[headRow], [headRow], afterWrite ? [afterWrite] : []];
  classifications = [[classification]];
}

const HEAD_ROW = {
  skill_id: SKILL_ID,
  revision_id: SEED_REVISION,
  bundle_digest: SEEDED_HEAD_DIGEST,
};

/** The classification of a head the DEFECTIVE seed minted. */
const DEFECTIVE_SEED_CLASSIFICATION = {
  revision_bundle_digest: null, // never stamped ⇒ no lifecycle write recorded a file set
  revision_source: "manual",
  skill_payload: JSON.stringify({ packageId: "@cinatra-ai/chat" }), // package-owned ⇒ disk is authority
  manifest_file_count: "1",
  router_file_count: "1",
};

/** The head statement of the last write batch (the batch that carries blobs). */
const lastHeadWrite = () =>
  [...capturedQueries].reverse().find((q) => q.text.includes("INSERT INTO \"cinatra\".\"skill_bundle_heads\""));

beforeEach(() => {
  capturedQueries.length = 0;
  headReads = [];
  classifications = [];
  seedLookups = [];
});
afterEach(() => {
  if (diskDir) rmSync(diskDir, { recursive: true, force: true });
});

describe("captureSkillBundleFromDisk — which heads the heal may replace", () => {
  it("HEALS a provenance-confirmed seed head, as a target-row CAS on that exact row", async () => {
    const skillMd = writeMultiFileSkill();
    scriptHead(HEAD_ROW, DEFECTIVE_SEED_CLASSIFICATION, {
      skill_id: SKILL_ID,
      revision_id: DISK_REVISION,
      bundle_digest: DISK_DIGEST,
    });
    const result = await captureSkillBundleFromDisk(SKILL_ID, skillMd);

    const head = lastHeadWrite();
    expect(head?.text).toContain('"cinatra"."skill_bundle_heads".revision_id = $4');
    // The CAS names the EXACT rows that were classified — the head row AND the
    // catalog payload condition 0 was decided on — not the incoming ones.
    expect(head?.values.slice(3)).toEqual([
      SEED_REVISION,
      SEEDED_HEAD_DIGEST,
      DEFECTIVE_SEED_CLASSIFICATION.skill_payload,
    ]);
    expect(head?.values[1]).toBe(DISK_REVISION);
    expect(result).toMatchObject({
      revisionId: DISK_REVISION,
      bundleDigest: DISK_DIGEST,
      changed: true,
      authorityOwnedDivergence: false,
    });
  });

  it("a CAS MISS is reported as a divergence, never as a successful heal", async () => {
    // The interleaving codex blocker 2 names: between the provenance read and the
    // guarded write, a lifecycle/rollback transaction commits a REAL authority
    // head. The CAS no longer matches, so nothing is replaced — and the capture
    // reports the head as it ACTUALLY stands rather than claiming the advance.
    const skillMd = writeMultiFileSkill();
    scriptHead(HEAD_ROW, DEFECTIVE_SEED_CLASSIFICATION, {
      skill_id: SKILL_ID,
      revision_id: "rev-lifecycle-0002",
      bundle_digest: "digest-from-the-concurrent-authority-write",
    });
    const result = await captureSkillBundleFromDisk(SKILL_ID, skillMd);

    expect(result).toMatchObject({
      revisionId: "rev-lifecycle-0002",
      bundleDigest: "digest-from-the-concurrent-authority-write",
      changed: false,
      authorityOwnedDivergence: true,
    });
  });

  it("does NOT heal a DELIBERATE custom/personal bundle-of-one (codex blocker 1)", async () => {
    // Same file counts as the defective seed — one manifest row, a multi-file
    // disk directory (the disk write rewrites only SKILL.md and leaves siblings).
    // What differs is durable provenance: the lifecycle write STAMPED the
    // revision's bundle_digest at INSERT, which the seed can never do.
    const skillMd = writeMultiFileSkill();
    scriptHead(HEAD_ROW, { ...DEFECTIVE_SEED_CLASSIFICATION, revision_bundle_digest: SEEDED_HEAD_DIGEST });
    const result = await captureSkillBundleFromDisk(SKILL_ID, skillMd);

    expect(result.authorityOwnedDivergence).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.revisionId).toBe(SEED_REVISION);
    // No head write was even attempted.
    expect(lastHeadWrite()).toBeUndefined();
  });

  it("does NOT heal a ROLLBACK head, whose bundle_digest is legitimately NULL", async () => {
    // A rollback restoring a pre-S1 target copies that target's NULL identity
    // onto the new revision while writing its manifest — so it presents every
    // other seed signature. It is a deliberate authority decision; never healed.
    const skillMd = writeMultiFileSkill();
    scriptHead(HEAD_ROW, { ...DEFECTIVE_SEED_CLASSIFICATION, revision_source: "rollback" });
    const result = await captureSkillBundleFromDisk(SKILL_ID, skillMd);

    expect(result.authorityOwnedDivergence).toBe(true);
    expect(lastHeadWrite()).toBeUndefined();
  });

  it("does NOT heal a head with ZERO manifest rows (codex blocker 2, second half)", async () => {
    // An empty manifest is an UNRESOLVABLE head that every read already fails
    // closed on — not a router-only seed. The retired `NOT EXISTS` predicate read
    // it as "carries no non-router file" and would have replaced it.
    const skillMd = writeMultiFileSkill();
    scriptHead(HEAD_ROW, {
      ...DEFECTIVE_SEED_CLASSIFICATION,
      manifest_file_count: "0",
      router_file_count: "0",
    });
    const result = await captureSkillBundleFromDisk(SKILL_ID, skillMd);

    expect(result.authorityOwnedDivergence).toBe(true);
    expect(lastHeadWrite()).toBeUndefined();
  });

  it.each([
    ["a custom package id", { packageId: "custom:personal-skills" }],
    ["the isCustomSkill flag", { packageId: "@cinatra-ai/chat", isCustomSkill: true }],
    ["the isPersonal flag", { packageId: "@cinatra-ai/chat", isPersonal: true }],
  ])("does NOT heal a CUSTOM/PERSONAL skill — %s (codex blocker 1, pre-S1 lineage)", async (_label, payload) => {
    // core__0029 seeded a NULL-stamped `migration` revision for exactly the
    // pre-S1 CUSTOM/PERSONAL skills, and a pre-S1 upsertSkill recorded no file
    // set either — so such a skill reaches the seed with the SAME row shape a
    // derived one does, and any stray sibling on disk makes it look multi-file.
    // For this class the DB is the content authority and the bundle-of-one head
    // is the seed's CORRECT re-baseline.
    const skillMd = writeMultiFileSkill();
    scriptHead(HEAD_ROW, { ...DEFECTIVE_SEED_CLASSIFICATION, skill_payload: JSON.stringify(payload) });
    const result = await captureSkillBundleFromDisk(SKILL_ID, skillMd);

    expect(result.authorityOwnedDivergence).toBe(true);
    expect(lastHeadWrite()).toBeUndefined();
  });

  it("does NOT heal when the catalog payload is unreadable (fail closed)", async () => {
    const skillMd = writeMultiFileSkill();
    scriptHead(HEAD_ROW, { ...DEFECTIVE_SEED_CLASSIFICATION, skill_payload: "{not json" });
    const result = await captureSkillBundleFromDisk(SKILL_ID, skillMd);

    expect(result.authorityOwnedDivergence).toBe(true);
    expect(lastHeadWrite()).toBeUndefined();
  });

  it("does NOT heal a head naming no lifecycle revision of this skill", async () => {
    // No `skill_revisions` row for `(head.revision_id, skill_id)` ⇒ nothing
    // proves the seed wrote that manifest ⇒ fail closed.
    const skillMd = writeMultiFileSkill();
    headReads = [[HEAD_ROW], [HEAD_ROW], []];
    classifications = [[]];
    const result = await captureSkillBundleFromDisk(SKILL_ID, skillMd);

    expect(result.authorityOwnedDivergence).toBe(true);
    expect(lastHeadWrite()).toBeUndefined();
  });

  it("never classifies on the mutable ACTIVE-REVISION pointer", async () => {
    // codex round-2 finding: the head-row CAS can only protect the head row. A
    // classifier keyed on `skills.active_revision_id` — which a lifecycle "pure
    // state re-record" (no `bundleFiles`) moves WITHOUT touching the head — would
    // decide on state that can go stale with nothing to catch it. The remaining
    // mutable read, `skills.payload`, is safe in the direction that matters: a
    // skill ENTERS the custom/personal class through a write that also replaces
    // the head, which the CAS detects.
    const skillMd = writeMultiFileSkill();
    scriptHead(HEAD_ROW, DEFECTIVE_SEED_CLASSIFICATION, {
      skill_id: SKILL_ID,
      revision_id: DISK_REVISION,
      bundle_digest: DISK_DIGEST,
    });
    await captureSkillBundleFromDisk(SKILL_ID, skillMd);

    const classify = capturedQueries.find((q) => q.text.includes("router_file_count"));
    expect(classify).toBeDefined();
    expect(classify!.text).toContain('"cinatra"."skill_revisions"');
    expect(classify!.text).toContain('"cinatra"."skill_revision_files"');
    expect(classify!.text).toContain("sk.payload");
    expect(classify!.text).not.toContain("active_revision_id");
  });

  it("the inlined custom/personal predicate agrees with the canonical one", async () => {
    // A faithful twin of `isCustomOrPersonalSkillPayload` (packages/skills) and of
    // core__0029's CUSTOM_PREDICATE. Pinned here so the three can never drift into
    // classifying the same skill differently — the same contract the
    // `normalizeBundledRelPath` twin in this store carries.
    // Imported from SOURCE, not the barrel: the root vitest config aliases
    // `@cinatra-ai/skills` to a narrow stub, and the point of this case is the
    // real canonical implementation.
    const { isCustomOrPersonalSkillPayload } = await import("../../../packages/skills/src/skill-source");
    const payloads: Array<Record<string, unknown>> = [
      { packageId: "custom:personal-skills" },
      { packageId: "custom:email-recipients" },
      { packageId: "@cinatra-ai/chat" },
      { packageId: "github:acme/skills" },
      { packageId: "@cinatra-ai/chat", isCustomSkill: true },
      { packageId: "@cinatra-ai/chat", isPersonal: true },
      { packageId: "@cinatra-ai/chat", isCustomSkill: false, isPersonal: false },
      {},
    ];
    for (const payload of payloads) {
      const skillMd = writeMultiFileSkill();
      scriptHead(HEAD_ROW, { ...DEFECTIVE_SEED_CLASSIFICATION, skill_payload: JSON.stringify(payload) }, {
        skill_id: SKILL_ID,
        revision_id: DISK_REVISION,
        bundle_digest: DISK_DIGEST,
      });
      capturedQueries.length = 0;
      const result = await captureSkillBundleFromDisk(SKILL_ID, skillMd);
      rmSync(diskDir, { recursive: true, force: true });
      // Refused to heal ⇔ the canonical predicate calls it custom/personal.
      expect({ payload, refused: lastHeadWrite() === undefined }).toEqual({
        payload,
        refused: isCustomOrPersonalSkillPayload(payload),
      });
      expect(result.authorityOwnedDivergence).toBe(isCustomOrPersonalSkillPayload(payload));
    }
  });

  it("a head with a MULTI-FILE manifest is never a seed head", async () => {
    const skillMd = writeMultiFileSkill();
    scriptHead(HEAD_ROW, {
      ...DEFECTIVE_SEED_CLASSIFICATION,
      manifest_file_count: "2",
      router_file_count: "1",
    });
    const result = await captureSkillBundleFromDisk(SKILL_ID, skillMd);

    expect(result.authorityOwnedDivergence).toBe(true);
    expect(lastHeadWrite()).toBeUndefined();
  });

  it("a SINGLE-file disk bundle keeps the strict guard even over a seed head", async () => {
    // The heal exists because a router-only manifest can never gain the
    // `references/*` the router links to. With nothing to gain, a divergence is an
    // ordinary authority divergence (a rollback that did not rewrite disk).
    diskDir = mkdtempSync(path.join(tmpdir(), "skill-heal-"));
    writeFileSync(path.join(diskDir, SKILL_ROUTER_PATH), "# a DIFFERENT router body\n");
    scriptHead(HEAD_ROW, DEFECTIVE_SEED_CLASSIFICATION);
    const result = await captureSkillBundleFromDisk(SKILL_ID, path.join(diskDir, SKILL_ROUTER_PATH));

    expect(result.authorityOwnedDivergence).toBe(true);
    expect(lastHeadWrite()).toBeUndefined();
  });

  it("the multi-file SEED SKIP does not apply to a custom/personal skill (codex round-4 blocker)", async () => {
    // No head yet — the FIRST capture after an upgrade. The multi-file skip was
    // unconditional, so a pre-S1 custom/personal skill with residue on disk was
    // left head-less and the capture below INSERTed a disk-derived head over its
    // DB-authoritative revision, with no head for the guard to compare against.
    // Provenance is never consulted on that path, so this had to be fixed in the
    // SEED itself.
    const skillMd = writeMultiFileSkill();
    const seedRow = { skill_id: SKILL_ID, revision_id: SEED_REVISION, bundle_digest: SEEDED_HEAD_DIGEST };
    // head probes: the seed's own (absent) → its read-back → the provenance probe.
    headReads = [[], [seedRow], [seedRow]];
    classifications = [
      [{ ...DEFECTIVE_SEED_CLASSIFICATION, skill_payload: JSON.stringify({ packageId: "custom:personal-skills" }) }],
    ];
    seedLookups = [
      [
        {
          active_revision_id: SEED_REVISION,
          payload: JSON.stringify({ packageId: "custom:personal-skills" }),
          content: ROUTER_BODY,
        },
      ],
    ];
    const result = await captureSkillBundleFromDisk(SKILL_ID, skillMd);

    // The seed RAN despite the multi-file disk bundle, installing the
    // DB-authoritative bundle-of-one head — and it can only ever INSERT.
    const head = lastHeadWrite();
    expect(head?.text).toContain("ON CONFLICT (skill_id) DO NOTHING");
    expect(head?.values[1]).toBe(SEED_REVISION);
    // No disk-derived head was written anywhere in the run.
    expect(capturedQueries.some((q) => (q.values ?? []).includes(DISK_REVISION))).toBe(false);
    expect(result).toMatchObject({ revisionId: SEED_REVISION, authorityOwnedDivergence: true, changed: false });
  });

  it("the multi-file SEED SKIP still applies to a package-owned skill", async () => {
    const skillMd = writeMultiFileSkill();
    // The seed SKIPS, so it never reads a head back: probe → final read-back.
    headReads = [[], [{ skill_id: SKILL_ID, revision_id: DISK_REVISION, bundle_digest: DISK_DIGEST }]];
    seedLookups = [
      [
        {
          active_revision_id: SEED_REVISION,
          payload: JSON.stringify({ packageId: "@cinatra-ai/chat" }),
          content: ROUTER_BODY,
        },
      ],
    ];
    const result = await captureSkillBundleFromDisk(SKILL_ID, skillMd);

    // Capture recorded the real multi-file disk bundle under a derived revision.
    expect(result.revisionId).toBe(DISK_REVISION);
    expect(result.changed).toBe(true);
    expect(lastHeadWrite()?.text).toContain("revision_id LIKE 'bundle:%'");
  });

  it("a DERIVED head takes the ordinary path and never consults provenance", async () => {
    const skillMd = writeMultiFileSkill();
    const derived = { skill_id: SKILL_ID, revision_id: "bundle:old", bundle_digest: "stale" };
    headReads = [[derived], [derived], [{ skill_id: SKILL_ID, revision_id: DISK_REVISION, bundle_digest: DISK_DIGEST }]];
    await captureSkillBundleFromDisk(SKILL_ID, skillMd);

    expect(capturedQueries.some((q) => q.text.includes("router_file_count"))).toBe(false);
    expect(lastHeadWrite()?.text).toContain("revision_id LIKE 'bundle:%'");
  });
});
