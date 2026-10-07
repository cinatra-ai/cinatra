import { describe, it, expect, afterEach, beforeEach } from "vitest";
import type { HostDevInstanceIsolation } from "@cinatra-ai/sdk-extensions";
import { createExtensionHostContext, readDevInstanceIsolation } from "@/lib/extension-host-context";

// The runtime port answers a development instance's isolation inputs as a
// credential-free record (database endpoint, schema, development-main
// declaration) and answers null outside a development runtime.

// Connection strings are assembled from parts at run time.
const PG = ["postgre", "sql", "://"].join("");
const PG_SHORT = ["postgre", "s", "://"].join("");
const USER = "u";
const PASSWORD = "p";
const withCredential = (user: string, password: string | null, rest: string): string =>
  [PG, user, password === null ? "" : [":", password].join(""), "@", rest].join("");

const FIXTURE_PACKAGE = "@example-org/fixture-extension";
const SETTING_KEYS = [
  "SUPABASE_DB_URL",
  "SUPABASE_SCHEMA",
  "CINATRA_DEV_MAIN_DATABASE",
  "CINATRA_RUNTIME_MODE",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SITE_URL",
  "BETTER_AUTH_URL",
  "DEV_ISOLATION_FIXTURE_FLAG",
  "DEV_ISOLATION_FIXTURE_SECRET",
] as const;

type Env = Record<string, string | undefined>;
const devEnv = (values: Env): Env => values;

describe("runtime port — development instance isolation inputs", () => {
  const prior = new Map<string, string | undefined>();

  beforeEach(() => {
    prior.clear();
    for (const key of SETTING_KEYS) {
      prior.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of SETTING_KEYS) {
      const value = prior.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    prior.clear();
  });

  it("answers the endpoint of a connection string without its user name or password", () => {
    const connection = withCredential(USER, PASSWORD, "h:5432/cinatra_clone_a");
    const record = readDevInstanceIsolation(devEnv({ SUPABASE_DB_URL: connection }), "development");
    expect(record).toEqual({
      databaseConfigured: true,
      databaseEndpoint: "h:5432/cinatra_clone_a",
      schema: null,
      mainDeclared: false,
      mainEndpoint: null,
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain([USER, ":", PASSWORD].join(""));
    expect(serialized).not.toContain([PASSWORD, "@"].join(""));
    expect(serialized).not.toContain(connection);
  });

  it("serves the same record through the extension context's runtime port in a development runtime", () => {
    process.env.CINATRA_RUNTIME_MODE = "development";
    process.env.SUPABASE_DB_URL = withCredential(USER, PASSWORD, "h:5432/cinatra_clone_a");
    const ctx = createExtensionHostContext(FIXTURE_PACKAGE, []);
    expect(ctx.runtime.devInstanceIsolation?.()).toEqual({
      databaseConfigured: true,
      databaseEndpoint: "h:5432/cinatra_clone_a",
      schema: null,
      mainDeclared: false,
      mainEndpoint: null,
    });
  });

  it("answers the configured schema trimmed, and null for an empty or blank schema", () => {
    const connection = [PG, "h:5432/cinatra"].join("");
    const read = (schema: string | undefined) =>
      readDevInstanceIsolation(devEnv({ SUPABASE_DB_URL: connection, SUPABASE_SCHEMA: schema }), "development");
    expect(read("  cinatra_clone_a  ")?.schema).toBe("cinatra_clone_a");
    expect(read("")?.schema).toBeNull();
    expect(read("   ")?.schema).toBeNull();
    expect(read(undefined)?.schema).toBeNull();
  });

  it("answers the development-main declaration in its endpoint form without a credential", () => {
    const read = (declaration: string) =>
      readDevInstanceIsolation(devEnv({ CINATRA_DEV_MAIN_DATABASE: declaration }), "development");

    const full = read(withCredential(USER, PASSWORD, "h:5434/cinatra"));
    expect(full?.mainDeclared).toBe(true);
    expect(full?.mainEndpoint).toBe("h:5434/cinatra");
    expect(JSON.stringify(full)).not.toContain([USER, ":", PASSWORD].join(""));
    expect(JSON.stringify(full)).not.toContain([PASSWORD, "@"].join(""));

    const bare = read("h/db");
    expect(bare?.mainDeclared).toBe(true);
    expect(bare?.mainEndpoint).toBe("h:5432/db");

    const nameOnly = read("cinatra");
    expect(nameOnly?.mainDeclared).toBe(true);
    expect(nameOnly?.mainEndpoint).toBeNull();
  });

  it("reads each accepted connection string form to its host:port/database endpoint", () => {
    const table: Array<[string, string]> = [
      [withCredential(USER, PASSWORD, "Db.Example:5434/cinatra"), "db.example:5434/cinatra"],
      [withCredential(USER, null, "h/cinatra"), "h:5432/cinatra"],
      [withCredential(USER, "p%40ss", "h:5432/cinatra"), "h:5432/cinatra"],
      [[PG, "[::1]:5434/cinatra"].join(""), "[::1]:5434/cinatra"],
      [[PG, "[::1]/cinatra"].join(""), "[::1]:5432/cinatra"],
      [[PG, "h:5432/cinatra?sslmode=require"].join(""), "h:5432/cinatra"],
      [[PG, "h:5434/cinatra/"].join(""), "h:5434/cinatra"],
      [[PG, "h.:5434/cinatra"].join(""), "h:5434/cinatra"],
      [[PG, "h:5434/cinatra"].join(""), "h:5434/cinatra"],
      [[PG_SHORT, "h:5434/cinatra"].join(""), "h:5434/cinatra"],
    ];
    for (const [connection, endpoint] of table) {
      const record = readDevInstanceIsolation(devEnv({ SUPABASE_DB_URL: connection }), "development");
      expect({ connection, endpoint: record?.databaseEndpoint }).toEqual({ connection, endpoint });
    }
  });

  it("answers a configured database with no endpoint for each ambiguous connection string, without throwing", () => {
    const refused = [
      [PG, "h:5432/"].join(""),
      [PG, "h:notaport/cinatra"].join(""),
      [PG, "h:0/cinatra"].join(""),
      [PG, "h:070/cinatra"].join(""),
      [PG, "h:99999/cinatra"].join(""),
      [PG, "h:/cinatra"].join(""),
      [PG, "::1/cinatra"].join(""),
      [PG, "h/a/b"].join(""),
      [PG, "h"].join(""),
      "https://h:5432/cinatra",
      "mysql://h:3306/cinatra",
      [PG, "h:5432/cinatra?host=elsewhere"].join(""),
      [PG, "h:5432/cinatra?port=6543"].join(""),
      [PG, "/cinatra?host=elsewhere"].join(""),
      [PG, "h:5432/cinatra?%68ost=elsewhere"].join(""),
    ];
    for (const connection of refused) {
      let record: HostDevInstanceIsolation | null = null;
      expect(() => {
        record = readDevInstanceIsolation(devEnv({ SUPABASE_DB_URL: connection }), "development");
      }).not.toThrow();
      expect({ connection, record }).toEqual({
        connection,
        record: expect.objectContaining({ databaseConfigured: true, databaseEndpoint: null }),
      });
    }
  });

  it("answers no endpoint when user info sits past the authority, a fragment is present or the query names a database", () => {
    const refused = [
      [PG, USER, ":5432/", PASSWORD, "@h/"].join(""),
      [PG, USER, ":5432/", PASSWORD, "?x@h/cinatra"].join(""),
      [PG, "h:5432/cinatra#", PASSWORD].join(""),
      [PG, "h:5432/cinatra?database=elsewhere"].join(""),
      [PG, "h:5432/cinatra?%64atabase=elsewhere"].join(""),
    ];
    for (const connection of refused) {
      const record = readDevInstanceIsolation(
        devEnv({ SUPABASE_DB_URL: connection, CINATRA_DEV_MAIN_DATABASE: connection }),
        "development",
      );
      expect({ connection, record }).toEqual({
        connection,
        record: expect.objectContaining({
          databaseConfigured: true,
          databaseEndpoint: null,
          mainDeclared: true,
          mainEndpoint: null,
        }),
      });
    }
  });

  it("answers no configured database for an unset or blank connection string", () => {
    for (const connection of [undefined, "", "   "]) {
      const record = readDevInstanceIsolation(devEnv({ SUPABASE_DB_URL: connection }), "development");
      expect(record?.databaseConfigured).toBe(false);
      expect(record?.databaseEndpoint).toBeNull();
    }
  });

  it("answers null in a production runtime, from the reader and from the extension context", () => {
    const env = devEnv({
      SUPABASE_DB_URL: withCredential(USER, PASSWORD, "h:5432/cinatra"),
      SUPABASE_SCHEMA: "cinatra",
      CINATRA_DEV_MAIN_DATABASE: "h:5432/cinatra",
    });
    expect(readDevInstanceIsolation(env, "production")).toBeNull();
    expect(readDevInstanceIsolation(devEnv({}), "production")).toBeNull();

    process.env.CINATRA_RUNTIME_MODE = "production";
    process.env.SUPABASE_DB_URL = env.SUPABASE_DB_URL;
    process.env.SUPABASE_SCHEMA = env.SUPABASE_SCHEMA;
    process.env.CINATRA_DEV_MAIN_DATABASE = env.CINATRA_DEV_MAIN_DATABASE;
    const ctx = createExtensionHostContext(FIXTURE_PACKAGE, []);
    expect(ctx.runtime.mode).toBe("production");
    expect(ctx.runtime.devInstanceIsolation?.()).toBeNull();
  });

  it("answers a frozen record, equal across calls", () => {
    const env = devEnv({ SUPABASE_DB_URL: [PG, "h:5432/cinatra"].join(""), SUPABASE_SCHEMA: "cinatra" });
    const first = readDevInstanceIsolation(env, "development");
    const second = readDevInstanceIsolation(env, "development");
    expect(first).not.toBeNull();
    expect(Object.isFrozen(first)).toBe(true);
    expect(second).toEqual(first);
  });

  it("keeps the port's mode, flag and public base URL answers with the isolation settings set and unset", () => {
    for (const withSettings of [false, true]) {
      for (const mode of ["development", "production"] as const) {
        process.env.CINATRA_RUNTIME_MODE = mode;
        if (withSettings) {
          process.env.SUPABASE_DB_URL = withCredential(USER, PASSWORD, "h:5432/cinatra");
          process.env.SUPABASE_SCHEMA = "cinatra";
          process.env.CINATRA_DEV_MAIN_DATABASE = "h:5432/cinatra";
        } else {
          delete process.env.SUPABASE_DB_URL;
          delete process.env.SUPABASE_SCHEMA;
          delete process.env.CINATRA_DEV_MAIN_DATABASE;
        }
        process.env.DEV_ISOLATION_FIXTURE_FLAG = "1";
        process.env.DEV_ISOLATION_FIXTURE_SECRET = "true";
        process.env.NEXT_PUBLIC_APP_URL = "https://h";
        const ctx = createExtensionHostContext(FIXTURE_PACKAGE, []);
        expect(ctx.runtime.mode).toBe(mode);
        expect(ctx.runtime.flag("DEV_ISOLATION_FIXTURE_FLAG")).toBe(true);
        expect(ctx.runtime.flag("DEV_ISOLATION_FIXTURE_SECRET")).toBe(false);
        expect(ctx.runtime.flag("DEV_ISOLATION_FIXTURE_UNSET")).toBe(false);
        expect(ctx.runtime.publicBaseUrl()).toBe("https://h");
        delete process.env.NEXT_PUBLIC_APP_URL;
        expect(createExtensionHostContext(FIXTURE_PACKAGE, []).runtime.publicBaseUrl()).toBeNull();
      }
    }
  });

  it("types the isolation record through the SDK's exported type", () => {
    const sample = {
      databaseConfigured: true,
      databaseEndpoint: "h:5432/cinatra",
      schema: null,
      mainDeclared: false,
      mainEndpoint: null,
    } satisfies HostDevInstanceIsolation;
    expect(Object.keys(sample).sort()).toEqual(
      ["databaseConfigured", "databaseEndpoint", "mainDeclared", "mainEndpoint", "schema"].sort(),
    );
  });
});
