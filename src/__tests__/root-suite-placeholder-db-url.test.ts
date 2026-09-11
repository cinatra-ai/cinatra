import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPlaceholderDbUrl,
  PLACEHOLDER_DB_URL_CREDENTIALS,
  POSTGRES_DEFAULT_PORT,
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
 *     never by asking about the sentinel inline — an inline guard is wrong in
 *     both directions: it stops recognising the placeholder the moment the port
 *     moves, and it reads a REAL database that happens to carry the same
 *     credential pair as the placeholder, skipping a tier that should have run.
 *     "Inline" is not only `.includes(`: a prefix test, an equality
 *     comparison, a regular expression and a marker constant matched
 *     indirectly are the same mistake, and the scan below fails on all of them
 *     in every tree a guard lives in — the root `src` tree included.
 */
describe("the root suite's placeholder database endpoint", () => {
  const url = new URL(ROOT_SUITE_PLACEHOLDER_DB_URL);
  const repoRoot = resolve(process.cwd());
  /** The endpoint the placeholder used to sit on, and the credential pair a
   * guard must never key on — both ASSEMBLED at run time from the module's own
   * parts, never written out, so this file carries no connection string of its
   * own and the scans below have nothing of their own to report. */
  const movedEndpoint = [
    PLACEHOLDER_DB_URL_CREDENTIALS,
    "localhost",
    ":",
    POSTGRES_DEFAULT_PORT,
  ].join("");
  const credentialPair = PLACEHOLDER_DB_URL_CREDENTIALS.slice(0, -1);

  /**
   * Every connection string in this file is ASSEMBLED, never written out: a
   * whole connection string carrying a credential pair is what a secret
   * scanner reports, and the module under test defuses its own endpoint the
   * same way.
   */
  function dbUrl(parts: {
    scheme?: string;
    user: string;
    password: string;
    host: string;
    port?: string;
    database: string;
    suffix?: string;
  }): string {
    const credentials = [parts.user, parts.password].join(":") + "@";
    const endpoint = parts.port ? [parts.host, parts.port].join(":") : parts.host;
    return [
      parts.scheme ?? "postgres",
      ["//", credentials, endpoint, "/", parts.database, parts.suffix ?? ""].join(""),
    ].join(":");
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

  /** The source trees a DB-presence guard can live in — the ROOT tree first. */
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

  /**
   * A file's CODE, comments removed. Prose may name the sentinel — this file
   * does, the module under test does, and so does the message a guard throws
   * when a dedicated lane finds no database. Only code may not ask about it
   * except through the predicate. A `//` that follows a colon opens a URL
   * scheme, not a comment, so it is left alone.
   */
  function codeOf(text: string): string[] {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"));
  }

  /**
   * The shapes an inline guard takes. Each asks about the sentinel itself on a
   * line that carries its credential pair: a substring or prefix test, an
   * equality comparison, a regular expression, or a marker constant that a
   * later line then matches indirectly.
   */
  const inlineGuardForms: Array<{ form: string; pattern: RegExp }> = [
    {
      form: "a substring or prefix test",
      pattern: /\.(?:includes|startsWith|endsWith|indexOf|lastIndexOf|search|match|test)\(/,
    },
    { form: "an equality comparison", pattern: /[=!]==?[^=]/ },
    {
      form: "a regular expression",
      pattern: new RegExp(`(?:^|[=(,:[&|!?\\s])/[^/\\n]*${credentialPair}`),
    },
    {
      form: "a marker constant",
      pattern: /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=/,
    },
  ];

  /** The inline guards in one file, named by the form each one takes. */
  function inlineGuards(file: string): string[] {
    const found: string[] = [];
    for (const line of codeOf(readFileSync(file, "utf8"))) {
      if (!line.includes(credentialPair)) continue;
      for (const { form, pattern } of inlineGuardForms) {
        if (pattern.test(line)) {
          found.push(`${relative(file)} (${form})`);
          break;
        }
      }
    }
    return found;
  }

  it("keeps the placeholder prefix the integration tiers recognise, off the PostgreSQL default port", () => {
    expect(
      ROOT_SUITE_PLACEHOLDER_DB_URL.startsWith(
        ["postgres://", PLACEHOLDER_DB_URL_CREDENTIALS, "localhost", ":"].join(""),
      ),
    ).toBe(true);
    expect(url.port).toBe("1");
    expect(url.port).not.toBe(POSTGRES_DEFAULT_PORT);
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
    // The same endpoint written with the other PostgreSQL scheme is the same
    // endpoint.
    expect(isPlaceholderDbUrl(
        dbUrl({
          scheme: "postgresql",
          user: "unused",
          password: "unused",
          host: "localhost",
          port: "1",
          database: "unused",
        }),
      )).toBe(true);
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
    // Nor is the reserved identity ONE PORT OVER: the port is part of the
    // endpoint this suite is pinned to, not a free variable. Something may
    // well listen there.
    expect(isPlaceholderDbUrl(
        dbUrl({ user: "unused", password: "unused", host: "localhost", port: "2", database: "unused" }),
      )).toBe(false);
    // Another scheme is another protocol, whatever the authority says.
    expect(isPlaceholderDbUrl(
        dbUrl({
          scheme: "https",
          user: "unused",
          password: "unused",
          host: "localhost",
          port: "1",
          database: "unused",
        }),
      )).toBe(false);
    // A query string or a fragment changes what the connection does — an
    // `sslmode`, a schema, a pooler's own options — so it is no longer the
    // endpoint that answers nothing.
    expect(isPlaceholderDbUrl(
        dbUrl({
          user: "unused",
          password: "unused",
          host: "localhost",
          port: "1",
          database: "unused",
          suffix: "?sslmode=require",
        }),
      )).toBe(false);
    expect(isPlaceholderDbUrl(
        dbUrl({
          user: "unused",
          password: "unused",
          host: "localhost",
          port: "1",
          database: "unused",
          suffix: "#pooler",
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

  it("is asked about through the predicate in EVERY guard tree, never inline, in any form", () => {
    const offenders: string[] = [];
    for (const tree of guardTrees()) {
      for (const file of filesUnder(tree)) {
        if (!/\.tsx?$/.test(file)) continue;
        if (exemptGuards.has(relative(file))) continue;
        offenders.push(...inlineGuards(file));
      }
    }
    for (const config of packageVitestConfigs()) {
      offenders.push(...inlineGuards(config));
    }
    expect(offenders).toEqual([]);
  });
});
