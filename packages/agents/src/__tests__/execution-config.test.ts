// Per-agent execution-config model (exec-plane S3 slice B, cinatra#1708).
//
// Locks the four rules the surface depends on and that would be silently wrong
// if regressed: authority resolution (manifest wins, unreadable fails closed),
// fail-closed submission parsing, the off-plus-declared contradiction, and the
// empty-declaration storage collapse.

import { describe, it, expect } from "vitest";

import {
  EXECUTION_ENVIRONMENT_STARTER_TEMPLATES,
  assertStarterTemplatesValid,
  countDeclaredEntries,
  environmentToEditorText,
  parseAgentExecutionConfigSubmission,
  resolveAgentEnvironmentAuthority,
  serializeExecutionEnvironmentForStorage,
  splitEnvironmentEntries,
} from "../execution-config";

describe("resolveAgentEnvironmentAuthority", () => {
  it("gives the MANIFEST authority when the package declares an environment (read-only, epic D8)", () => {
    const resolved = resolveAgentEnvironmentAuthority({
      manifestEnvironment: { os: ["pandoc"] },
      templateEnvironment: { pip: ["pandas"] },
    });
    expect(resolved.authority).toBe("manifest");
    // The config column is NOT blended in — a packaged recipe is reviewed in
    // its package, never re-authored on the instance.
    expect(resolved.spec).toEqual({ os: ["pandoc"] });
    expect(resolved.empty).toBe(false);
  });

  it("gives the CONFIG authority when the package declares none", () => {
    const resolved = resolveAgentEnvironmentAuthority({
      manifestEnvironment: null,
      templateEnvironment: { pip: ["pandas", "numpy"] },
    });
    expect(resolved.authority).toBe("config");
    expect(resolved.spec).toEqual({ pip: ["numpy", "pandas"] }); // canonical: sorted
  });

  it("FAILS CLOSED to manifest authority when the package manifest could not be read", () => {
    const resolved = resolveAgentEnvironmentAuthority({
      templateEnvironment: { pip: ["pandas"] },
      manifestReadFailed: true,
    });
    expect(resolved.authority).toBe("manifest");
    // UNKNOWN, not empty (codex round-2): an unreadable manifest must not
    // present a confident empty recipe, and must not hand the promotion
    // affordance an empty baseline.
    expect(resolved.spec).toBeNull();
    expect(resolved.empty).toBe(false);
    expect(resolved.errors.join(" ")).toMatch(/UNKNOWN/);
  });

  it("surfaces an INVALID declaration as spec:null + parser errors — never a salvaged recipe", () => {
    const resolved = resolveAgentEnvironmentAuthority({
      templateEnvironment: { pip: ["pandas"], typo: ["x"] },
    });
    expect(resolved.spec).toBeNull();
    expect(resolved.errors.join(" ")).toMatch(/unknown key "typo"/);
  });

  it("treats absent declarations as an empty (L0) environment", () => {
    const resolved = resolveAgentEnvironmentAuthority({});
    expect(resolved.authority).toBe("config");
    expect(resolved.empty).toBe(true);
    expect(resolved.spec).toEqual({});
  });
});

describe("starter templates", () => {
  it("every starter template is a VALID, canonical declaration", () => {
    expect(() => assertStarterTemplatesValid()).not.toThrow();
  });

  it("offers an explicit empty starting point plus at least one populated one", () => {
    const ids = EXECUTION_ENVIRONMENT_STARTER_TEMPLATES.map((t) => t.id);
    expect(ids).toContain("empty");
    expect(EXECUTION_ENVIRONMENT_STARTER_TEMPLATES.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("parseAgentExecutionConfigSubmission", () => {
  it("accepts newline-separated entries and canonicalizes them", () => {
    const result = parseAgentExecutionConfigSubmission({
      executionEnabled: "on",
      pip: "pandas\n numpy \n\npandas",
      os: "pandoc",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.executionEnabled).toBe(true);
    expect(result.config.environment).toEqual({ os: ["pandoc"], pip: ["numpy", "pandas"] });
  });

  it("REFUSES a malformed entry with the parser's own errors (never sanitizes it)", () => {
    const result = parseAgentExecutionConfigSubmission({
      executionEnabled: "inherit",
      os: "pandoc; rm -rf /",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/package-specifier grammar/);
  });

  it("REFUSES 'execution off' combined with a declared environment (the contradiction rule)", () => {
    const result = parseAgentExecutionConfigSubmission({
      executionEnabled: "off",
      pip: "pandas",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/switched OFF/);
  });

  it("allows 'execution off' with NO declared environment", () => {
    const result = parseAgentExecutionConfigSubmission({ executionEnabled: "off" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.executionEnabled).toBe(false);
    expect(result.config.environment).toEqual({});
  });

  it("maps 'inherit' to null — the instance/org posture, not a per-agent decision", () => {
    const result = parseAgentExecutionConfigSubmission({ executionEnabled: "inherit" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.executionEnabled).toBeNull();
  });
});

describe("storage + editor round-trip", () => {
  it("stores an EMPTY declaration as null so an env-less template never snapshots '{}'", () => {
    expect(serializeExecutionEnvironmentForStorage({})).toBeNull();
    expect(serializeExecutionEnvironmentForStorage({ pip: [] })).toBeNull();
  });

  it("stores a non-empty declaration in canonical JSON (the builder's cache-key identity)", () => {
    expect(serializeExecutionEnvironmentForStorage({ pip: ["pandas", "numpy"] })).toBe(
      '{"pip":["numpy","pandas"]}',
    );
  });

  it("round-trips submission → storage → editor text", () => {
    const parsed = parseAgentExecutionConfigSubmission({
      executionEnabled: "inherit",
      npm: "prettier\ntypescript",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const stored = serializeExecutionEnvironmentForStorage(parsed.config.environment);
    const back = environmentToEditorText(JSON.parse(stored!) as { npm: string[] });
    expect(back.npm).toBe("prettier\ntypescript");
    expect(back.os).toBe("");
  });

  it("counts declared entries across every manager", () => {
    expect(countDeclaredEntries({ os: ["a"], pip: ["b", "c"] })).toBe(3);
    expect(countDeclaredEntries(null)).toBe(0);
  });

  it("splits on NEWLINES ONLY, trimming blanks", () => {
    expect(splitEnvironmentEntries(" a\n b \n\n c ")).toEqual(["a", "b", "c"]);
    expect(splitEnvironmentEntries(undefined)).toEqual([]);
  });
});

describe("fail-closed submission edges (codex round-1)", () => {
  it("refuses an UNRECOGNIZED posture instead of coercing it to inherit", () => {
    const result = parseAgentExecutionConfigSubmission({
      executionEnabled: "yes" as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/not a valid execution posture/);
  });

  it("keeps a comma-bearing pip specifier intact (one entry per LINE, never per comma)", () => {
    // `pandas>=2,<3` is a single valid PEP-508 specifier the shared parser
    // accepts. Splitting on commas would shred it into two invalid entries and
    // make a whole class of declarations unauthorable in-app.
    expect(splitEnvironmentEntries("pandas>=2,<3\nnumpy")).toEqual(["pandas>=2,<3", "numpy"]);
    const result = parseAgentExecutionConfigSubmission({
      executionEnabled: "inherit",
      pip: "pandas>=2,<3",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.environment).toEqual({ pip: ["pandas>=2,<3"] });
  });
});
