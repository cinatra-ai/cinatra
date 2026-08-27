/**
 * The local, fail-closed secret scan (cinatra#1378 AC3, client half).
 *
 * Two properties are load-bearing and both are pinned here:
 *   - a credential-shaped literal produces a diagnostic naming the FILE and
 *     the SHAPE, and never the matched text;
 *   - a scan that cannot complete produces `secret-scan-failed`, NOT an empty
 *     array. "Could not look" must never be reported as "looked and found
 *     nothing".
 */
import { describe, expect, it } from "vitest";

import {
  collectMemoryScannableStrings,
  detectMemoryCredentialPattern,
  MemorySecretScanError,
  scanMemoryConceptForSecrets,
} from "../src/secret-scan.ts";

function concept(overrides: {
  frontmatter?: Record<string, unknown>;
  body?: string;
}) {
  return {
    path: "debugging/deploy-notes.md",
    frontmatter: { type: "debugging insight", ...(overrides.frontmatter ?? {}) },
    body: overrides.body ?? "Nothing to see here.",
  };
}

describe("detectMemoryCredentialPattern", () => {
  it("flags known credential prefixes", () => {
    expect(detectMemoryCredentialPattern("sk-abcdefghijklmnopqrstuvwx")).toBe("openai-sk");
    expect(detectMemoryCredentialPattern("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe(
      "github-pat",
    );
    expect(detectMemoryCredentialPattern("AKIAIOSFODNN7EXAMPLE")).toBe("aws-access-key");
  });

  it("flags a JWT shape without quadratic backtracking on hostile input", () => {
    expect(
      detectMemoryCredentialPattern("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln"),
    ).toBe("jwt");
    // 200k repetitions of the header marker: the linear scanner must return
    // promptly. A backtracking regex here is a reachable denial of service on
    // untrusted concept bodies.
    const started = process.hrtime.bigint();
    expect(detectMemoryCredentialPattern("eyJ".repeat(200_000))).toBeNull();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("tolerates the documentation shapes a concept file legitimately carries", () => {
    expect(detectMemoryCredentialPattern("export OPENAI_API_KEY=${OPENAI_API_KEY}")).toBeNull();
    expect(detectMemoryCredentialPattern("Authorization: Bearer <API_TOKEN>")).toBeNull();
    expect(detectMemoryCredentialPattern("sk-EXAMPLE")).toBeNull();
    expect(detectMemoryCredentialPattern("Use named exports everywhere.")).toBeNull();
  });
});

describe("scanMemoryConceptForSecrets", () => {
  it("clears an ordinary concept", () => {
    expect(scanMemoryConceptForSecrets(concept({ body: "Run pnpm test." }))).toEqual([]);
  });

  it("flags a seeded secret in the body, naming the shape and never the value", () => {
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
    const [finding, ...rest] = scanMemoryConceptForSecrets(
      concept({ body: `The deploy token is ${secret}\n` }),
    );
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      severity: "error",
      code: "secret-detected",
      path: "debugging/deploy-notes.md",
    });
    expect(finding?.message).toContain("github-pat");
    expect(finding?.message).not.toContain(secret);
  });

  it("flags a seeded secret hidden in frontmatter, not just in the body", () => {
    const findings = scanMemoryConceptForSecrets(
      concept({ frontmatter: { deployToken: "sk-abcdefghijklmnopqrstuvwx" } }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("secret-detected");
    expect(findings[0]?.message).toContain("frontmatter.deployToken");
  });

  it("reports scan FAILURE, not cleanliness, when the walk cannot complete", () => {
    // 40 levels of nesting exceeds the walk's depth bound. The scan has not
    // seen the whole payload, so it must refuse rather than return [].
    let nested: Record<string, unknown> = { leaf: "sk-abcdefghijklmnopqrstuvwx" };
    for (let i = 0; i < 40; i++) nested = { deeper: nested };
    const findings = scanMemoryConceptForSecrets(concept({ frontmatter: { nested } }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("secret-scan-failed");
    expect(findings[0]?.severity).toBe("error");
  });

  it("reports scan FAILURE on a cyclic frontmatter value", () => {
    const cyclic: Record<string, unknown> = { type: "convention" };
    cyclic.self = cyclic;
    const findings = scanMemoryConceptForSecrets({
      path: "c.md",
      frontmatter: cyclic,
      body: "",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("secret-scan-failed");
  });
});

describe("collectMemoryScannableStrings — the walk is bounded, and says so", () => {
  it("throws rather than truncating when the value is too deep", () => {
    let nested: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 40; i++) nested = { deeper: nested };
    expect(() => collectMemoryScannableStrings(nested, "frontmatter")).toThrow(
      MemorySecretScanError,
    );
  });

  // Object KEYS are collected too: `{ "<a real token>": "note" }` hides a
  // credential exactly as well as a value does, so a walk that only read
  // values would clear content it never looked at.
  it("collects every string with a locating path, KEYS included", () => {
    expect(
      collectMemoryScannableStrings({ a: "one", b: ["two", { c: "three" }] }, "frontmatter"),
    ).toEqual([
      { location: "frontmatter.a", value: "a" },
      { location: "frontmatter.a", value: "one" },
      { location: "frontmatter.b", value: "b" },
      { location: "frontmatter.b[0]", value: "two" },
      { location: "frontmatter.b[1].c", value: "c" },
      { location: "frontmatter.b[1].c", value: "three" },
    ]);
  });
});

describe("a credential in a KEY is found, and the diagnostic never echoes it", () => {
  const token = `ghp_${"A1b2C3d4E5f6G7h8J9k0".repeat(2)}`;

  it("flags a credential-shaped frontmatter KEY", () => {
    const findings = scanMemoryConceptForSecrets({
      path: "a.md",
      frontmatter: { type: "convention", [token]: "a note" },
      body: "Body.",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("secret-detected");
    expect(findings[0]?.message).toContain("github-pat");
  });

  it("renders the location positionally rather than echoing the key", () => {
    const findings = scanMemoryConceptForSecrets({
      path: "a.md",
      frontmatter: { type: "convention", [token]: "a note" },
      body: "Body.",
    });
    for (const finding of findings) {
      expect(finding.message).not.toContain(token);
    }
    expect(findings[0]?.message).toContain("[key#");
  });

  it("keeps ordinary keys legible in the location", () => {
    const strings = collectMemoryScannableStrings({ ordinary_key: "v" }, "frontmatter");
    expect(strings.map((s) => s.location)).toEqual([
      "frontmatter.ordinary_key",
      "frontmatter.ordinary_key",
    ]);
  });
});
