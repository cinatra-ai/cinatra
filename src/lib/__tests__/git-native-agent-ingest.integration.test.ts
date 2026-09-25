/**
 * THE GIT-NATIVE AGENT INGEST, AGAINST A REAL DATABASE.
 *
 * The walk's own suite (`git-native-agent-ingest.test.ts`) drives an injected
 * loader, so it proves the layouts and the counts and nothing about rows. The
 * claim this boot phase exists to make IS a claim about rows: that one pass over
 * the extension source tree leaves the agent definitions on file, and that a
 * second pass writes nothing more. A stubbed store would agree with whatever
 * this code said about both, so there is no store double here — a real Postgres
 * and the real per-definition loader.
 *
 * It runs the BOOT PHASE's own body, not a re-assembled version of it, so the
 * summary line an operator reads is the line this suite reads too.
 *
 * THE RECIPE, whole. A bare `createdb` is not enough: the writers below reach
 * `public.user`, so the committed public-schema seed has to be applied first or
 * the run dies on `relation "public.user" does not exist`.
 *
 *   createdb <scratch>
 *   SUPABASE_DB_URL='<dsn>' node scripts/apply-public-schema.mjs
 *   SUPABASE_DB_URL='<dsn>' pnpm test:agent-ingest
 *
 * Three steps and no migration run: `beforeAll` forces the schema into
 * existence through the application's own initialiser, the way a fresh install
 * does. An already-migrated development database works too — the suite's
 * initialiser call is idempotent — but `pnpm db:migrate` on a bare `createdb`
 * does NOT, because the incremental core migrations alter tables that
 * initialiser creates.
 *
 * `pnpm test:agent-ingest` is the tier (`vitest/integration/3626.config.ts`).
 * The suite self-skips without a DSN, so any other config that picks the file up
 * keeps the ordinary skip.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const describeDb = HAS_DB ? describe : describe.skip;

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;

type TemplateRow = { id: string; name: string; packageName: string; packageVersion: string };

let admin: Client;

/**
 * The git-native rows, by NAME. The loader is the only writer that stamps a
 * package version, so this predicate is exactly "what the ingest put here" and
 * leaves the version-less system templates the migrations seed out of it.
 */
async function readIngestedTemplates(): Promise<TemplateRow[]> {
  const { rows } = await admin.query<TemplateRow>(
    `SELECT id, name, package_name AS "packageName", package_version AS "packageVersion"
       FROM ${q(SCHEMA)}.${q("agent_templates")}
      WHERE package_version IS NOT NULL
      ORDER BY package_name`,
  );
  return rows;
}

/** The three numbers the phase's summary line always reports. */
function countsIn(summary: string): { found: number; readIn: number; alreadyOnFile: number } {
  const m = /(\d+) found, (\d+) read in, (\d+) already on file/.exec(summary);
  expect(m, `the summary line reports three counts: ${summary}`).not.toBeNull();
  return { found: Number(m![1]), readIn: Number(m![2]), alreadyOnFile: Number(m![3]) };
}

/** Run the boot phase exactly as the orchestrator runs it. */
async function runTheBootPhase(): Promise<{ summary: string }> {
  const { devAgentIngestPhases } = await import("@/lib/boot/phases/dev-boot");
  const phases = devAgentIngestPhases();
  expect(phases).toHaveLength(1);
  expect(phases[0]!.name).toBe("dev-agent-ingest");
  expect(phases[0]!.policy).toBe("dev-only");

  const lines: string[] = [];
  const info = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    await phases[0]!.run();
  } finally {
    info.mockRestore();
  }
  const summary = lines.find((line) => line.startsWith("[agent-builder] git-native agent definitions:"));
  expect(summary, "the phase reports one summary line").toBeDefined();
  return { summary: summary! };
}

describeDb("the git-native agent ingest boot phase", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    const { ensurePostgresSchema } = await import("@/lib/postgres-schema-init");
    ensurePostgresSchema();

    // The FIRST pass is the claim, so the database has to start without the rows
    // it writes. A suite that quietly measured a second pass instead would have
    // agreed with a phase that reported a whole first ingest as "already
    // current" — which is exactly what reading the wrong field did.
    const standing = await readIngestedTemplates();
    if (standing.length > 0) {
      throw new Error(
        `this suite needs a scratch database with no git-native agent rows; ` +
          `${standing.length} are already on file. Point SUPABASE_DB_URL at a ` +
          `freshly migrated database.`,
      );
    }
  }, 180_000);

  afterAll(async () => {
    await admin?.end();
  });

  it("reads the tree's definitions into rows, and a second pass writes nothing", async () => {
    const first = await runTheBootPhase();
    const afterFirst = await readIngestedTemplates();

    // Something was read in, and every row the ingest wrote is identified.
    expect(afterFirst.length).toBeGreaterThan(0);
    for (const row of afterFirst) {
      expect(row.id).not.toEqual("");
      expect(row.name).not.toEqual("");
      expect(row.packageName.startsWith("@")).toBe(true);
      expect(row.packageVersion).not.toEqual("");
    }
    // The line an operator reads counts the SAME rows the database now holds —
    // the claim that catches a phase reporting a first ingest as "already
    // current". Nothing in the line is a connection string.
    expect(first.summary).not.toContain("not read in");
    expect(first.summary).not.toContain("declined");
    expect(first.summary).not.toContain("still pending");
    expect(countsIn(first.summary).readIn).toBe(afterFirst.length);
    expect(countsIn(first.summary).readIn).toBeGreaterThan(0);
    expect(first.summary).not.toContain(DB_URL);

    // --- the second pass ---------------------------------------------------
    const second = await runTheBootPhase();
    const afterSecond = await readIngestedTemplates();

    // Not one row more, not one row different — same ids, same versions.
    expect(afterSecond).toEqual(afterFirst);
    // And the phase says so: nothing read in, everything already current.
    expect(countsIn(second.summary)).toEqual({
      found: countsIn(first.summary).found,
      readIn: 0,
      alreadyOnFile: countsIn(first.summary).found,
    });
    expect(second.summary).not.toContain("not read in");
    expect(second.summary).not.toContain("declined");
    expect(second.summary).not.toContain("still pending");
  }, 900_000);

  it("is a no-op, not a failure, on an instance with no extension source tree", async () => {
    const { devAgentIngestPhases } = await import("@/lib/boot/phases/dev-boot");
    const mount = await import("@cinatra-ai/agents/agent-runtime-mount");
    const absent = vi
      .spyOn(mount, "resolveDevExtensionSourceRoot")
      .mockReturnValue("/a/path/no/instance/has");
    try {
      await expect(devAgentIngestPhases()[0]!.run()).resolves.toEqual({
        skipped: "no extension source tree to read agent definitions from",
      });
    } finally {
      absent.mockRestore();
    }
  }, 60_000);
});
