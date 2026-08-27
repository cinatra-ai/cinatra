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

// ---------------------------------------------------------------------------
// Round-3 review probes (PR #3017). Every case below is a shape the reviewer
// carried through the detector on the first attempt. The literals follow this
// file's existing fixture convention — ordered alphabet runs, never a
// real-looking credential — so the organization's own secret-scan and
// source-leak gates stay green on them.
// ---------------------------------------------------------------------------

/** Fixture credential shapes: obviously synthetic, structurally credential-like. */
const PAT_SHAPED = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
const ANTHROPIC_SHAPED = "sk-ant-0123456789abcdefghijklmnopqrstuvwxyz";
/** A 64-char hex run over the full hex alphabet — maximal normalized entropy. */
const HEX_KEY_SHAPED = "0123456789abcdef".repeat(4);

describe("placeholder tolerance is per token, not a whole-value switch (item 1)", () => {
  it("still tolerates a value that documents how to set a key", () => {
    expect(detectMemoryCredentialPattern("export OPENAI_API_KEY=${OPENAI_API_KEY}")).toBeNull();
    expect(detectMemoryCredentialPattern("Authorization: Bearer <API_TOKEN>")).toBeNull();
    expect(detectMemoryCredentialPattern("Set ${HOME} first.")).toBeNull();
    expect(detectMemoryCredentialPattern("See <TODO>.")).toBeNull();
    expect(detectMemoryCredentialPattern("{{ MY_TEMPLATE_VAR }}")).toBeNull();
    expect(detectMemoryCredentialPattern("****")).toBeNull();
    expect(detectMemoryCredentialPattern("REDACTED")).toBeNull();
    expect(detectMemoryCredentialPattern("$HOME")).toBeNull();
  });

  it("does NOT let a placeholder anywhere in the value un-scan the rest of it", () => {
    expect(detectMemoryCredentialPattern(`Set \${HOME} first. ${PAT_SHAPED}`)).toBe("github-pat");
    expect(detectMemoryCredentialPattern(`See <TODO>. ${PAT_SHAPED}`)).toBe("github-pat");
    expect(detectMemoryCredentialPattern(`See <BR>. ${ANTHROPIC_SHAPED}`)).toBe("anthropic-key");
    expect(detectMemoryCredentialPattern(`{{ ${PAT_SHAPED} }}`)).toBe("github-pat");
    expect(detectMemoryCredentialPattern(`<X> ${PAT_SHAPED}`)).toBe("github-pat");
    expect(
      detectMemoryCredentialPattern(`https://host/hook?a=\${T}&token=${PAT_SHAPED}`),
    ).toBe("github-pat");
  });
});

describe('a token that merely CONTAINS "example" is not skipped (item 6)', () => {
  it("skips the placeholder word as a whole token or a delimited word", () => {
    expect(detectMemoryCredentialPattern("sk-EXAMPLE")).toBeNull();
    expect(detectMemoryCredentialPattern("token.example.placeholder-value")).toBeNull();
  });

  it("does not skip a credential-shaped token with the word embedded in it", () => {
    // The reviewer's probe: a 35-character mixed-case token with `example`
    // spliced into its middle. The word is not a whole token and not a
    // delimited word inside one, so it must not switch the detector off.
    const embedded = "0123456789abcdexampleefghijklmnopqr";
    expect(embedded).toHaveLength(35);
    expect(detectMemoryCredentialPattern(embedded)).toBe("high-entropy-token");
  });
});

describe("the entropy branch is alphabet-aware (item 5)", () => {
  it("flags a hex-encoded key, which a 4.5-bits-per-char rule can never reach", () => {
    expect(detectMemoryCredentialPattern(HEX_KEY_SHAPED)).toBe("high-entropy-token");
    expect(detectMemoryCredentialPattern(HEX_KEY_SHAPED.repeat(2))).toBe("high-entropy-token");
  });

  it("flags a PEM private-key block, which no entropy rule catches", () => {
    expect(
      detectMemoryCredentialPattern("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"),
    ).toBe("pem-private-key");
    expect(detectMemoryCredentialPattern("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(
      "pem-private-key",
    );
  });

  it("flags a password carried in a connection URL's userinfo", () => {
    expect(detectMemoryCredentialPattern("postgres://app:hunter2@db.internal:5432/main")).toBe(
      "url-credential",
    );
    expect(detectMemoryCredentialPattern("https://user:tokenvalue@example.com/path")).toBe(
      "url-credential",
    );
  });

  it("tolerates a connection URL whose password is a placeholder", () => {
    expect(
      detectMemoryCredentialPattern("postgres://app:${PGPASSWORD}@db.internal:5432/main"),
    ).toBeNull();
    expect(detectMemoryCredentialPattern("https://user@example.com/path")).toBeNull();
  });

  it("does not flag ordinary long identifiers, paths or prose", () => {
    for (const benign of [
      "resolveMemoryConceptScopeRequestForBundle",
      "OBJECTS_COLLISION_SCOPE_CHANGE_REJECTED",
      "memory-sync-preflight-batch-classification",
      "packages/objects/src/mcp/handlers.ts",
      "internationalizationandlocalization",
      "ObjectSyncAdapterConfigRow",
      "a concept about debugging the sync run end to end",
    ]) {
      expect(detectMemoryCredentialPattern(benign)).toBeNull();
    }
  });
});

describe("the reported pattern names the most specific prefix (item 13)", () => {
  it("reports an Anthropic key as anthropic-key, not openai-sk", () => {
    expect(detectMemoryCredentialPattern(ANTHROPIC_SHAPED)).toBe("anthropic-key");
  });
});

// ---------------------------------------------------------------------------
// Codex convergence round (PR #3017 fix round). Two shapes that survived the
// round-3 fixes on the first attempt and are pinned here so they cannot come
// back.
// ---------------------------------------------------------------------------

describe("a placeholder WORD does not launder the token it is glued to", () => {
  it("flags a high-entropy token with a delimited placeholder word inside it", () => {
    // 38 characters, `example` delimited by hyphens in the middle. Matching the
    // word — as a substring OR as a delimited word — switched the detector off
    // for the whole token, which is a one-word bypass anyone can find.
    expect(detectMemoryCredentialPattern("Ab3Cd5Ef7Gh9-example-Jk2Lm4Np6Qr8St0Uv")).toBe(
      "high-entropy-token",
    );
    expect(detectMemoryCredentialPattern("Ab3Cd5Ef7Gh9_redacted_Jk2Lm4Np6Qr8St0Uv")).toBe(
      "high-entropy-token",
    );
  });

  it("still skips a token that is documentation once the word is removed", () => {
    // The residue is what decides: `sk` and `tokenvalue` are far too short to
    // be a credential, so tolerance holds exactly where it should.
    expect(detectMemoryCredentialPattern("sk-EXAMPLE")).toBeNull();
    expect(detectMemoryCredentialPattern("token.example.placeholder-value")).toBeNull();
    expect(detectMemoryCredentialPattern("API_KEY_PLACEHOLDER")).toBeNull();
    expect(detectMemoryCredentialPattern("my-redacted-value")).toBeNull();
  });
});

describe("a standard-base64 credential is not split into invisibility", () => {
  it("flags a contiguous standard-base64 run carrying + or /", () => {
    // The token splitter consumes `/`, so a standard-base64 key reached the
    // token loop as fragments too short to score. An AWS-secret-shaped key is
    // the everyday case.
    const shaped = "wJalrXUtnFEMI+K7MDENG/bPxRfiCYzEXAMPLEKEYaZ";
    expect(detectMemoryCredentialPattern(shaped)).toBe("standard-base64-token");
  });

  it("does not flag a slash-separated path, which carries no digit", () => {
    expect(
      detectMemoryCredentialPattern("packages/objects/src/mcp/handlers.ts"),
    ).toBeNull();
    expect(
      detectMemoryCredentialPattern("docs/internals/workflows/memory-conventions.md"),
    ).toBeNull();
  });
});
