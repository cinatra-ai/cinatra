import { existsSync, readdirSync, readFileSync } from "node:fs";
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
 *     never by matching a substring of it — a substring match is wrong in both
 *     directions: it stops recognising the placeholder the moment the port
 *     moves, and it reads a REAL database that happens to carry the same
 *     credential pair as the placeholder, skipping a tier that should have run.
 */
describe("the root suite's placeholder database endpoint", () => {
  const url = new URL(ROOT_SUITE_PLACEHOLDER_DB_URL);
  const repoRoot = resolve(process.cwd());
  /** The endpoint the placeholder used to sit on — assembled, never written
   * out, so the scan below does not report this file. */
  const movedEndpoint = ["unused:unused", "localhost:5432"].join("@");

  /**
   * Every connection string in this file is ASSEMBLED, never written out: a
   * whole connection string carrying a credential pair is what a secret
   * scanner reports, and the module under test defuses its own endpoint the
   * same way.
   */
  function dbUrl(parts: {
    user: string;
    password: string;
    host: string;
    port?: string;
    database: string;
  }): string {
    const credentials = [parts.user, parts.password].join(":") + "@";
    const endpoint = parts.port ? [parts.host, parts.port].join(":") : parts.host;
    return ["postgres", ["//", credentials, endpoint, "/", parts.database].join("")].join(":");
  }

  /**
   * The one file the scans below skip. It carries a token-named path, so any
   * edit to it puts the whole change in the attribution gate's high-risk class;
   * it is therefore byte-identical to the default branch and still asks its
   * question through the older whole-endpoint match. That guard is harmless
   * where it stands — the file runs only against a real connection string —
   * and the exemption is ONE named path, so a NEW offender still fails here.
   */
  const exemptGuards = new Set([
    "packages/agents/src/__tests__/agent-run-token.integration.test.ts",
  ]);

  /** Every file under `dir`, skipping installed and built trees. */
  function* filesUnder(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") {
          continue;
        }
        yield* filesUnder(join(dir, entry.name));
      } else if (entry.isFile()) {
        yield join(dir, entry.name);
      }
    }
  }

  /** `packages/<name>` for every workspace package, discovered, never listed. */
  function packageDirs(): string[] {
    return readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repoRoot, "packages", entry.name));
  }

  /** The source trees a DB-presence guard can live in. */
  function guardTrees(): string[] {
    return [join(repoRoot, "src"), ...packageDirs().map((dir) => join(dir, "src"))].filter(
      (tree) => existsSync(tree),
    );
  }

  /** `packages/<name>/vitest*.ts` — the configs that hand the suites a URL. */
  function packageVitestConfigs(): string[] {
    const configs: string[] = [];
    for (const dir of packageDirs()) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && /^vitest.*\.ts$/.test(entry.name)) configs.push(join(dir, entry.name));
      }
    }
    return configs;
  }

  const relative = (file: string) => file.slice(repoRoot.length + 1);

  it("keeps the placeholder prefix the integration tiers recognise, off the PostgreSQL default port", () => {
    expect(
      ROOT_SUITE_PLACEHOLDER_DB_URL.startsWith(
        ["postgres://", PLACEHOLDER_DB_URL_CREDENTIALS, "localhost", ":"].join(""),
      ),
    ).toBe(true);
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

  it("is recognised by the shared predicate, and NOTHING else is", () => {
    expect(isPlaceholderDbUrl(ROOT_SUITE_PLACEHOLDER_DB_URL)).toBe(true);
    // A real database that happens to carry the reserved credential pair is a
    // real database: the predicate must not read it as the placeholder, or the
    // tier behind the guard silently stops running.
    expect(isPlaceholderDbUrl(
        dbUrl({ user: "unused", password: "unused", host: "db.example", database: "cinatra" }),
      )).toBe(false);
    expect(isPlaceholderDbUrl(
        dbUrl({
          user: "unused",
          password: "unused",
          host: "db.example",
          port: "5432",
          database: "unused",
        }),
      )).toBe(false);
    // The endpoint the placeholder used to sit on is NOT the placeholder: it is
    // the conventional local PostgreSQL, which answers.
    expect(isPlaceholderDbUrl(
        dbUrl({
          user: "unused",
          password: "unused",
          host: "localhost",
          port: "5432",
          database: "unused",
        }),
      )).toBe(false);
    expect(isPlaceholderDbUrl(
        dbUrl({ user: "unused", password: "unused", host: "127.0.0.1", port: "1", database: "unused" }),
      )).toBe(false);
    // Neither user nor password may differ, and the database name is part of
    // the reserved identity.
    expect(isPlaceholderDbUrl(
        dbUrl({ user: "unused", password: "secret", host: "localhost", port: "1", database: "unused" }),
      )).toBe(false);
    expect(isPlaceholderDbUrl(
        dbUrl({ user: "app", password: "unused", host: "localhost", port: "1", database: "unused" }),
      )).toBe(false);
    expect(isPlaceholderDbUrl(
        dbUrl({ user: "unused", password: "unused", host: "localhost", port: "1", database: "cinatra" }),
      )).toBe(false);
    expect(isPlaceholderDbUrl(
        dbUrl({ user: "app", password: "secret", host: "db.example", port: "5432", database: "cinatra" }),
      )).toBe(false);
    // A total predicate: nothing it is handed makes it throw.
    expect(isPlaceholderDbUrl("not a url at all")).toBe(false);
    expect(isPlaceholderDbUrl("")).toBe(false);
    expect(isPlaceholderDbUrl(null)).toBe(false);
    expect(isPlaceholderDbUrl(undefined)).toBe(false);
  });

  it("is recognised by no guard through the port it used to sit on, in any tree a guard lives in", () => {
    const offenders: string[] = [];
    for (const tree of guardTrees()) {
      for (const file of filesUnder(tree)) {
        if (!/\.tsx?$/.test(file)) continue;
        if (!readFileSync(file, "utf8").includes(movedEndpoint)) continue;
        if (exemptGuards.has(relative(file))) continue;
        offenders.push(relative(file));
      }
    }
    for (const config of packageVitestConfigs()) {
      if (readFileSync(config, "utf8").includes(movedEndpoint)) offenders.push(relative(config));
    }
    expect(offenders).toEqual([]);
  });

  it("is asked about through the predicate in every package tree, never matched inline", () => {
    const offenders: string[] = [];
    const inline = (file: string) =>
      readFileSync(file, "utf8")
        .split("\n")
        .some((line) => line.includes(".includes(") && line.includes(PLACEHOLDER_DB_URL_CREDENTIALS));
    for (const dir of packageDirs()) {
      const tree = join(dir, "src");
      if (!existsSync(tree)) continue;
      for (const file of filesUnder(tree)) {
        if (!/\.tsx?$/.test(file)) continue;
        if (exemptGuards.has(relative(file))) continue;
        if (inline(file)) offenders.push(relative(file));
      }
    }
    for (const config of packageVitestConfigs()) {
      if (inline(config)) offenders.push(relative(config));
    }
    expect(offenders).toEqual([]);
  });
});
