import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPlaceholderDbUrl,
  PLACEHOLDER_DB_URL_CREDENTIALS,
  ROOT_SUITE_PLACEHOLDER_DB_URL,
} from "../../vitest.placeholder-db-url";

/**
 * The root unit suite must never reach a real database. Two things keep that
 * true and this file pins both, STRUCTURALLY — no socket is opened here, so
 * the arm says the same thing on every machine, in CI, and on a workstation
 * that happens to run a local PostgreSQL.
 *
 *  1. The placeholder endpoint sits off the PostgreSQL default port. On 5432 it
 *     met a PostgreSQL that happened to listen on the conventional local
 *     endpoint and turned fifteen unrelated tests red with "password
 *     authentication failed" instead of a refused connection.
 *  2. Every DB-presence guard recognises the placeholder through ONE predicate,
 *     never by matching the whole string — a guard keyed on the whole string
 *     stops recognising the placeholder the moment the port moves, reads it as
 *     a real database, and runs a DB tier against nothing.
 */
describe("the root suite's placeholder database endpoint", () => {
  const url = new URL(ROOT_SUITE_PLACEHOLDER_DB_URL);
  const repoRoot = resolve(process.cwd());
  /** The endpoint the placeholder used to sit on — assembled, never written
   * out, so the scan below does not report this file. */
  const movedEndpoint = ["unused:unused", "localhost:5432"].join("@");

  it("keeps the placeholder prefix the integration tiers recognise, off the PostgreSQL default port", () => {
    expect(ROOT_SUITE_PLACEHOLDER_DB_URL.startsWith("postgres://unused:unused@localhost:")).toBe(true);
    expect(url.port).toBe("1");
    expect(url.port).not.toBe("5432");
  });

  it("is the address the root configuration hands to the suite, and the configuration says what is true about it", () => {
    const config = readFileSync(join(repoRoot, "vitest.config.ts"), "utf8");
    expect(config).toContain("ROOT_SUITE_PLACEHOLDER_DB_URL");
    expect(config).not.toContain(PLACEHOLDER_DB_URL_CREDENTIALS);
    // The address is routable; nothing in the test environment answers it.
    expect(config).not.toMatch(/unroutable/);
    expect(readFileSync(join(repoRoot, "vitest.placeholder-db-url.ts"), "utf8")).not.toMatch(/unroutable/);
  });

  it("is recognised by the shared predicate in every shape a guard can meet it in", () => {
    expect(isPlaceholderDbUrl(ROOT_SUITE_PLACEHOLDER_DB_URL)).toBe(true);
    expect(isPlaceholderDbUrl(`postgres://${movedEndpoint}/unused`)).toBe(true);
    expect(isPlaceholderDbUrl("postgres://unused:unused@127.0.0.1:5432/unused")).toBe(true);
    expect(isPlaceholderDbUrl("postgres://app:secret@db.example:5432/cinatra")).toBe(false);
    expect(isPlaceholderDbUrl("")).toBe(false);
    expect(isPlaceholderDbUrl(undefined)).toBe(false);
  });

  it("is recognised by no guard through the port it used to sit on", () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(join(repoRoot, "src"), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.test\.tsx?$/.test(entry.name)) continue;
      const file = join(entry.parentPath, entry.name);
      if (readFileSync(file, "utf8").includes(movedEndpoint)) {
        offenders.push(file.slice(repoRoot.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
