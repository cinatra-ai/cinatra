/**
 * The declared-tables contract (cinatra#3031, epic #3023 W7).
 *
 * Enabler 0.24 fixes the NAME: "`ext_`, then the extension's scope and slug
 * lowercased with every character outside letters, digits and underscore
 * replaced by an underscore, joined and terminated by underscores —
 * `ext_cinatra_ai_blog_pipeline_agent_` for the pipeline". Enabler 0.23 fixes
 * WHAT MAY BE DECLARED and when it is refused: "the host, not the migration,
 * creates the declared tables and indexes, from the declaration, under the
 * prefix of item 0.24 and within the database's 63-byte identifier limit — a
 * declaration that breaks either is refused at preflight, before anything
 * runs" and "the install also refuses an extension whose derived prefix
 * collides with an installed extension's, since two names can normalise to
 * one".
 */
import { describe, expect, it } from "vitest";

import {
  assertNoDeclaredTablePrefixCollision,
  declaredIndexPhysicalName,
  declaredTablePhysicalName,
  extensionDatabaseRoleName,
  extensionTablePrefix,
  parseDeclaredTables,
  PG_IDENTIFIER_MAX_BYTES,
} from "../manifest";

const PIPELINE = "@cinatra-ai/blog-pipeline-agent";

const ONE_TABLE = [
  {
    name: "idea_reservations",
    organizationColumn: "org_id",
    columns: [
      { name: "id", type: "uuid", notNull: true, primaryKey: true },
      { name: "org_id", type: "text", notNull: true },
      { name: "idea_artifact_id", type: "text", notNull: true },
      { name: "state", type: "text", notNull: true },
      { name: "expires_at", type: "timestamptz" },
    ],
    indexes: [{ name: "idea_reservations_live", columns: ["org_id", "idea_artifact_id"], unique: true }],
  },
];

describe("the prefix, derived once (enabler 0.24)", () => {
  it("is ext_ + scope + slug, normalised, terminated by an underscore", () => {
    expect(extensionTablePrefix(PIPELINE)).toBe("ext_cinatra_ai_blog_pipeline_agent_");
  });

  it("replaces every character outside letters, digits and underscore", () => {
    expect(extensionTablePrefix("@Acme.Co/My-Ext")).toBe("ext_acme_co_my_ext_");
  });

  it("refuses an unscoped package name — it owns no namespace", () => {
    expect(() => extensionTablePrefix("blog-pipeline-agent")).toThrow(/scoped package name/);
  });

  it("derives the role as the prefix without its terminating underscore", () => {
    expect(extensionDatabaseRoleName(PIPELINE)).toBe("ext_cinatra_ai_blog_pipeline_agent");
  });
});

describe("the identifier limit, checked before anything runs (enabler 0.23)", () => {
  it("refuses a declared table whose PHYSICAL name exceeds 63 bytes", () => {
    const long = "t".repeat(64 - "ext_cinatra_ai_blog_pipeline_agent_".length);
    expect(() => declaredTablePhysicalName(PIPELINE, long)).toThrow(
      new RegExp(`over PostgreSQL's ${PG_IDENTIFIER_MAX_BYTES}-byte identifier limit`),
    );
  });

  it("admits a declared table one byte inside the limit", () => {
    const fits = "t".repeat(63 - "ext_cinatra_ai_blog_pipeline_agent_".length);
    expect(declaredTablePhysicalName(PIPELINE, fits)).toHaveLength(63);
  });

  it("checks index names the same way", () => {
    const long = "i".repeat(64 - "ext_cinatra_ai_blog_pipeline_agent_".length);
    expect(() => declaredIndexPhysicalName(PIPELINE, long)).toThrow(/identifier limit/);
  });

  it("refuses the whole declaration at parse time when one table breaks the limit", () => {
    const over = "t".repeat(64 - "ext_cinatra_ai_blog_pipeline_agent_".length);
    expect(() =>
      parseDeclaredTables([{ ...ONE_TABLE[0], name: over }], PIPELINE),
    ).toThrow(/identifier limit/);
  });
});

describe("what a declaration may say (enabler 0.23)", () => {
  it("parses a well-formed declaration", () => {
    const [t] = parseDeclaredTables(ONE_TABLE, PIPELINE);
    expect(t?.name).toBe("idea_reservations");
    expect(t?.organizationColumn).toBe("org_id");
    expect(t?.columns.map((c) => c.name)).toEqual([
      "id",
      "org_id",
      "idea_artifact_id",
      "state",
      "expires_at",
    ]);
    expect(t?.indexes[0]?.unique).toBe(true);
  });

  it("treats an absent declaration as owning no table", () => {
    expect(parseDeclaredTables(undefined, PIPELINE)).toEqual([]);
  });

  it("refuses a column type outside the closed vocabulary — a declaration is never free SQL", () => {
    const bad = [{ ...ONE_TABLE[0], columns: [{ name: "org_id", type: "text NOT NULL); DROP TABLE objects;--", notNull: true }] }];
    expect(() => parseDeclaredTables(bad, PIPELINE)).toThrow(/closed vocabulary/);
  });

  it("refuses a default outside the closed vocabulary", () => {
    const bad = [
      {
        ...ONE_TABLE[0],
        columns: [{ name: "org_id", type: "text", notNull: true, default: "(SELECT 1)" }],
      },
    ];
    expect(() => parseDeclaredTables(bad, PIPELINE)).toThrow(/closed vocabulary/);
  });

  it("refuses a table with no organisation column", () => {
    const bad = [{ name: "t", columns: [{ name: "a", type: "text" }] }];
    expect(() => parseDeclaredTables(bad, PIPELINE)).toThrow(/organizationColumn/);
  });

  it("refuses a NULLABLE organisation column — a row outside every tenant", () => {
    const bad = [
      { name: "t", organizationColumn: "org_id", columns: [{ name: "org_id", type: "text" }] },
    ];
    expect(() => parseDeclaredTables(bad, PIPELINE)).toThrow(/notNull/);
  });

  it("refuses a COLUMN name over the 63-byte identifier limit — PostgreSQL would truncate it", () => {
    // A column carries no prefix, so its declared name IS the identifier the
    // database sees; two names sharing their first 63 bytes would collapse into
    // one and the host's own CREATE TABLE would fail halfway through the DDL.
    const long = `c${"x".repeat(PG_IDENTIFIER_MAX_BYTES)}`;
    const bad = [
      {
        ...ONE_TABLE[0],
        columns: [...ONE_TABLE[0].columns, { name: long, type: "text" }],
      },
    ];
    expect(() => parseDeclaredTables(bad, PIPELINE)).toThrow(/identifier limit/);
  });

  it("refuses an index over a column the table does not declare", () => {
    const bad = [{ ...ONE_TABLE[0], indexes: [{ name: "x", columns: ["nope"] }] }];
    expect(() => parseDeclaredTables(bad, PIPELINE)).toThrow(/does not declare/);
  });

  it("refuses the same table declared twice", () => {
    expect(() => parseDeclaredTables([ONE_TABLE[0], ONE_TABLE[0]], PIPELINE)).toThrow(/declared twice/);
  });
});

describe("the run column a declaration may name (cinatra#3249)", () => {
  const RUN_BOUND = [
    {
      name: "run_reservations",
      organizationColumn: "org_id",
      runColumn: "run_id",
      columns: [
        { name: "id", type: "uuid", notNull: true, primaryKey: true },
        { name: "org_id", type: "text", notNull: true },
        { name: "run_id", type: "text", notNull: true },
        { name: "state", type: "text", notNull: true },
      ],
    },
  ];

  it("parses a run column named beside the organisation column", () => {
    const [t] = parseDeclaredTables(RUN_BOUND, PIPELINE);
    expect(t?.organizationColumn).toBe("org_id");
    expect(t?.runColumn).toBe("run_id");
  });

  it("leaves a table that names none bound to no run", () => {
    const [t] = parseDeclaredTables(ONE_TABLE, PIPELINE);
    expect(t?.runColumn).toBeNull();
  });

  it("refuses a runColumn the table does not declare", () => {
    const bad = [{ ...RUN_BOUND[0], runColumn: "nope" }];
    expect(() => parseDeclaredTables(bad, PIPELINE)).toThrow(/runColumn/);
  });

  it("refuses a NULLABLE run column — a row belonging to no run", () => {
    const bad = [
      {
        ...RUN_BOUND[0],
        columns: RUN_BOUND[0].columns.map((c) =>
          c.name === "run_id" ? { name: "run_id", type: "text" } : c,
        ),
      },
    ];
    expect(() => parseDeclaredTables(bad, PIPELINE)).toThrow(/nullable run/);
  });

  it("refuses a runColumn that IS the organisation column — two bindings, two columns", () => {
    const bad = [{ ...RUN_BOUND[0], runColumn: "org_id" }];
    expect(() => parseDeclaredTables(bad, PIPELINE)).toThrow(/organisation column/);
  });
});

describe("the scope columns a declaration may name (cinatra#3249)", () => {
  // The scope a run belongs to, in the host's OWN per-scope vocabulary: the
  // workspace, an organisation, a team, a project or a person's own scope. The
  // declaration names the two columns; the host writes the kind and the id.
  const SCOPE_BOUND = [
    {
      name: "run_reservations",
      organizationColumn: "org_id",
      runColumn: "run_id",
      scopeKindColumn: "scope_kind",
      scopeIdColumn: "scope_id",
      columns: [
        { name: "id", type: "uuid", notNull: true, primaryKey: true },
        { name: "org_id", type: "text", notNull: true },
        { name: "run_id", type: "text", notNull: true },
        { name: "scope_kind", type: "text", notNull: true },
        { name: "scope_id", type: "text", notNull: true },
        { name: "state", type: "text", notNull: true },
      ],
    },
  ];

  it("parses the scope kind and the scope id the run belongs to", () => {
    const [t] = parseDeclaredTables(SCOPE_BOUND, PIPELINE);
    expect(t?.scopeKindColumn).toBe("scope_kind");
    expect(t?.scopeIdColumn).toBe("scope_id");
  });

  it("leaves a table that names none bound to no scope", () => {
    const [t] = parseDeclaredTables(ONE_TABLE, PIPELINE);
    expect(t?.scopeKindColumn).toBeNull();
    expect(t?.scopeIdColumn).toBeNull();
  });

  it("refuses a scope column the table does not declare", () => {
    expect(() =>
      parseDeclaredTables([{ ...SCOPE_BOUND[0], scopeKindColumn: "nope" }], PIPELINE),
    ).toThrow(/scopeKindColumn/);
    expect(() =>
      parseDeclaredTables([{ ...SCOPE_BOUND[0], scopeIdColumn: "nope" }], PIPELINE),
    ).toThrow(/scopeIdColumn/);
  });

  it("refuses a NULLABLE scope column — a row belonging to no scope", () => {
    const nullable = (name: string) => [
      {
        ...SCOPE_BOUND[0],
        columns: SCOPE_BOUND[0].columns.map((c) => (c.name === name ? { name, type: "text" } : c)),
      },
    ];
    expect(() => parseDeclaredTables(nullable("scope_kind"), PIPELINE)).toThrow(
      /nullable scope kind/,
    );
    expect(() => parseDeclaredTables(nullable("scope_id"), PIPELINE)).toThrow(/nullable scope id/);
  });

  it("refuses a scope column that IS the organisation column, or the run column", () => {
    expect(() =>
      parseDeclaredTables([{ ...SCOPE_BOUND[0], scopeKindColumn: "org_id" }], PIPELINE),
    ).toThrow(/organisation column/);
    expect(() =>
      parseDeclaredTables([{ ...SCOPE_BOUND[0], scopeIdColumn: "run_id" }], PIPELINE),
    ).toThrow(/run column/);
  });

  it("refuses a scope binding declared HALF — a kind without an id, or an id without a kind", () => {
    expect(() =>
      parseDeclaredTables([{ ...SCOPE_BOUND[0], scopeIdColumn: undefined }], PIPELINE),
    ).toThrow(/PAIR/);
    expect(() =>
      parseDeclaredTables([{ ...SCOPE_BOUND[0], scopeKindColumn: undefined }], PIPELINE),
    ).toThrow(/PAIR/);
  });
});

describe("the collision refusal (enabler 0.23)", () => {
  it("refuses an install whose derived prefix collides with an installed extension's", () => {
    expect(() =>
      assertNoDeclaredTablePrefixCollision("@acme-co/thing", ["@acme_co/thing"]),
    ).toThrow(/collides with the installed extension/);
  });

  it("is not a collision with the package's own earlier install", () => {
    expect(() =>
      assertNoDeclaredTablePrefixCollision("@acme-co/thing", ["@acme-co/thing"]),
    ).not.toThrow();
  });

  it("ignores an unscoped installed name — it owns no prefix", () => {
    expect(() => assertNoDeclaredTablePrefixCollision("@acme-co/thing", ["legacy"])).not.toThrow();
  });
});
