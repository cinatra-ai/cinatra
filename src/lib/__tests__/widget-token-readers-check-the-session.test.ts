/**
 * EVERY READER OF A WIDGET TOKEN ROW ASKS WHETHER ITS SESSION IS STILL THERE
 * (cinatra#2684).
 *
 * The fix is a property of the ROW, not of one verifier: a `cwu_` row is bound
 * to the Better Auth session that authorized it, and anything that reads such a
 * row to authorize something must consult that binding. Today there are two such
 * readers — the raw-token verifier and the jti-keyed capture probe — and both
 * derive their answer from the same leaf.
 *
 * The risk this test exists for is a THIRD one. The pattern is established: a
 * new surface that cannot present the bearer seals the `jti` instead and reads
 * `widget_user_tokens` by it (the review-island credential on the S8e branch does
 * exactly that). A reader like that inherits the revocation only if it asks, and
 * nothing in the type system makes it. So the rule is structural: name the table
 * in a source module and you must also name the liveness predicate.
 *
 * It is a source scan on purpose. A behavioural test can only cover the readers
 * that already exist, and the one this is written for has not been merged yet.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src");
const TABLE = "widget_user_tokens";
/**
 * The leaf that owns the predicate. Naming the MODULE rather than one function
 * is deliberate: it exports a boolean form and a three-valued form, and a reader
 * that needs to tell "revoked" from "could not ask" uses the latter. Either
 * counts as consulting the binding; importing neither does not.
 */
const LIVENESS_MODULE = "@/lib/widget-session-binding";
const LIVENESS_READERS = [
  "widgetAuthSessionIsLive",
  "readWidgetAuthSessionLiveness",
  "readWidgetTokenParentLiveness",
];

/**
 * Modules that name the table for a reason other than authorizing off one of its
 * rows. Each is listed with the reason, so adding a file here is a decision
 * somebody made in the open rather than a silent exemption.
 */
const NOT_A_READER: Record<string, string> = {
  "src/lib/drizzle-store.ts": "the schema SSOT — it CREATEs and ALTERs the tables, it never reads a row",
  "src/lib/widget-session-binding.ts": "the leaf that DEFINES the liveness predicate",
  "src/lib/org-write/write-registry.ts":
    "the org-write registry names the table as the write target of the mint/verify exports it catalogues; it performs no read of its own",
  "src/lib/postgres-sync-inventory.ts":
    "the sync-bridge inventory names the table INSIDE a per-file justification string — it is prose describing what another module reads, holds no query and authorizes nothing. cinatra#2674 put the table's name in it by classifying review-island-serving.ts, which is itself a real reader and consults the predicate on its own line",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("widget token readers inherit the session cascade", () => {
  const sources = walk(SRC).map((file) => ({
    rel: path.relative(process.cwd(), file),
    text: readFileSync(file, "utf8"),
  }));

  const namesTable = sources.filter((f) => f.text.includes(TABLE));

  it("finds the readers at all (a scan that matched nothing would pass vacuously)", () => {
    expect(namesTable.length).toBeGreaterThanOrEqual(3);
    expect(namesTable.map((f) => f.rel)).toContain("src/lib/widget-user-auth.ts");
    expect(namesTable.map((f) => f.rel)).toContain(
      "src/lib/lifecycle/widget-capture-principal.ts",
    );
  });

  it("every module that reads the table consults the parent-session predicate", () => {
    const offenders = namesTable
      .filter((f) => !(f.rel in NOT_A_READER))
      .filter(
        (f) =>
          !f.text.includes(LIVENESS_MODULE) ||
          !LIVENESS_READERS.some((fn) => f.text.includes(fn)),
      )
      .map((f) => f.rel);
    if (offenders.length > 0) {
      throw new Error(
        `These modules read ${TABLE} without asking whether the row's Better Auth ` +
          `session is still live (cinatra#2684). Import one of ` +
          `${LIVENESS_READERS.join(" / ")} from ${LIVENESS_MODULE}, or record the ` +
          `file in NOT_A_READER with the reason it authorizes nothing:\n` +
          offenders.map((f) => `  - ${f}`).join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the exemption list honest — every entry still names the table", () => {
    const named = new Set(namesTable.map((f) => f.rel));
    const stale = Object.keys(NOT_A_READER).filter((f) => !named.has(f));
    expect(stale, "a stale exemption hides the next reader").toEqual([]);
  });

  it("the predicate has exactly one definition, and it is the leaf", () => {
    for (const fn of LIVENESS_READERS) {
      const definers = sources
        .filter((f) => new RegExp(`export function ${fn}\\b`).test(f.text))
        .map((f) => f.rel);
      expect(definers, fn).toEqual(["src/lib/widget-session-binding.ts"]);
    }
  });

  // codex round 0, finding E. The whole mechanism rests on Postgres being the
  // authority for Better Auth sessions. Turn on secondary storage while keeping
  // `preserveSessionInDatabase`, and a revoke removes only the secondary entry —
  // the Postgres row survives, the liveness read says "live", and the revocation
  // silently stops working. It is a configuration change nobody would connect to
  // this file, so the invariant is pinned here rather than left in a comment.
  it("Better Auth keeps the DATABASE as the authority for sessions", () => {
    const auth = readFileSync(path.join(SRC, "lib/auth.ts"), "utf8");
    // The BARE WORD, not a `key:` shape (codex round 1): shorthand
    // `secondaryStorage,` or an options spread would slip past a narrower match,
    // and the point of this guard is that nobody has to notice.
    expect(auth, "secondaryStorage would move session truth out of Postgres").not.toMatch(
      /\bsecondaryStorage\b/,
    );
    expect(auth).not.toContain("preserveSessionInDatabase");
  });
});
