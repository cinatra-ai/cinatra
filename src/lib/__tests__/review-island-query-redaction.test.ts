// NEVER LOGGED (cinatra#2754, the maintainer's 2026-08-21 hardening ruling,
// requirement 3): "query redaction on /lifecycle/review-island is a MEASURED
// deployment requirement — after the first paint, every copy of the address in
// a log, a HAR, or the DOM opens nothing."
//
// WHY THIS ROUTE IS SPECIAL. It is the one route in this app whose QUERY is a
// bearer. An `<iframe src>` GET carries no Authorization header and, on a
// genuinely cross-site CMS, no cookie either, so the address authenticates the
// reader (the ratified position, plan §12). Every mechanism that copies a URL
// therefore copies a credential.
//
// WHAT IS MEASURED HERE, AND WHERE. The requirement is registered in
// `src/lib/boot/deployment-invariants.ts` and executed by the required-env
// preflight — the place a production boot already checks its deployment's
// configuration — so it is machine-checked on every prod boot rather than
// written down. This suite proves three things about that registration: the
// requirement HOLDS against the shipped redactor, a requirement that does NOT
// hold aborts a prod boot, and the island route hands its query to no logger of
// its own.
//
// THE RESIDUAL, NAMED. The half of this requirement that lives OUTSIDE this
// repository is the edge: a reverse proxy's or CDN's own access log is written
// before any Cinatra code runs and can only be redacted in that deployment's
// own configuration, by software this repository does not ship. Nothing here
// can measure that log, so nothing here claims to; what IS measured is every
// path this repository owns, and the boot-time invariant says so in the words
// an operator reads.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEPLOYMENT_INVARIANTS,
  checkDeploymentInvariants,
  formatDeploymentInvariantFailureMessage,
} from "@/lib/boot/deployment-invariants";
import { runRequiredEnvPreflight, checkRequiredEnv } from "@/lib/boot/required-env-preflight";
import { redactSensitive } from "@/lib/redact-sensitive";
import {
  REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM,
  REVIEW_ISLAND_ROUTE,
  reviewIslandUrl,
} from "@/lib/lifecycle/review-island-credential";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const INVARIANT = "review-island-query-redaction";

/** A readable stand-in, in the character class a sealed credential lives in. */
const CREDENTIAL = "island-credential-stand-in-value-0123456789abcdefghijklmnop";
const render = (value: unknown) => JSON.stringify(redactSensitive(value)) ?? "";

describe("THE REQUIREMENT IS ASSERTED WHERE DEPLOYMENT CONFIG IS CHECKED", () => {
  it("is registered as a MEASURED deployment invariant, not as prose", () => {
    const entry = DEPLOYMENT_INVARIANTS.find((i) => i.name === INVARIANT);
    expect(entry).toBeDefined();
    expect(typeof entry!.measure).toBe("function");
    expect(entry!.why.length).toBeGreaterThan(0);
  });

  it("HOLDS against the shipped redactor — the measurement passes", () => {
    expect(checkDeploymentInvariants()).toEqual([]);
    expect(checkRequiredEnv({ ...validEnv() }).invariantFailures).toEqual([]);
  });

  it("a requirement that does NOT hold ABORTS a prod boot, naming it", () => {
    const broken = [
      { name: "broken-requirement", why: "a stand-in", measure: () => "it did not hold" },
    ];
    expect(() =>
      runRequiredEnvPreflight({
        env: validEnv(),
        isProd: () => true,
        isBuildPhase: () => false,
        logWarn: () => {},
        logInfo: () => {},
        invariants: broken,
      }),
    ).toThrow(/broken-requirement/);
  });

  it("a measurement that THROWS is a failed measurement — fail closed", () => {
    const failures = checkDeploymentInvariants([
      {
        name: "explodes",
        why: "a stand-in",
        measure: () => {
          throw new Error("boom");
        },
      },
    ]);
    expect(failures).toHaveLength(1);
    expect(formatDeploymentInvariantFailureMessage(failures)).toMatch(/explodes/);
  });

  it("is inert outside app-runtime production, exactly as the env half is", () => {
    const broken = [
      { name: "broken-requirement", why: "a stand-in", measure: () => "it did not hold" },
    ];
    expect(() =>
      runRequiredEnvPreflight({
        env: validEnv(),
        isProd: () => false,
        isBuildPhase: () => false,
        logWarn: () => {},
        logInfo: () => {},
        invariants: broken,
      }),
    ).not.toThrow();
  });
});

describe("THE CREDENTIAL DOES NOT SURVIVE A LOG LINE", () => {
  const address = reviewIslandUrl({ ref: "gate-ref", credential: CREDENTIAL });

  it("is removed from an access-log request line", () => {
    const line = render(`GET ${address} HTTP/1.1" 200 1234`);
    expect(line).not.toContain(CREDENTIAL);
    expect(line).toContain("[redacted]");
  });

  it("is removed from an absolute URL, a bare query and a credential-first address", () => {
    for (const shape of [
      `https://app.example.test${address}`,
      `?ref=gate-ref&${REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM}=${CREDENTIAL}`,
      `${REVIEW_ISLAND_ROUTE}?${REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM}=${CREDENTIAL}`,
    ]) {
      expect(render(shape)).not.toContain(CREDENTIAL);
    }
  });

  it("is removed from an ALREADY-SERIALIZED query and a PERCENT-ENCODED address", () => {
    // The structural pass reaches a value only while it is still at a key, and
    // the value pattern keys on a literal `=`. These are the two shapes that
    // slip past both (found in the codex round on this change).
    for (const shape of [
      `island paint: query={"ic":"${CREDENTIAL}"}`,
      `https://app.example.test/x?next=%2Flifecycle%2Freview-island%3Fic%3D${CREDENTIAL}`,
    ]) {
      expect(render(shape)).not.toContain(CREDENTIAL);
    }
  });

  it("is removed from a structured record, a parsed query, an Error and a nested value", () => {
    for (const shape of [
      { event: "island_paint", url: address },
      { event: "island_paint", query: { ref: "gate-ref", ic: CREDENTIAL } },
      new Error(`island load failed for ${address}`),
      { outer: { inner: [address] } },
    ]) {
      expect(render(shape)).not.toContain(CREDENTIAL);
    }
  });

  it("keeps the line USEFUL — the ref and the path survive", () => {
    const line = render(`GET ${address} HTTP/1.1" 200`);
    expect(line).toContain(REVIEW_ISLAND_ROUTE);
    expect(line).toContain("ref=gate-ref");
  });

  it("is pinned to the QUERY PARAM the island actually reads", () => {
    // The redactor names the parameter as a literal to stay a zero-dependency
    // leaf; this is the lockstep, asserted behaviourally.
    expect(REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM).toBe("ic");
    const record = { [REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM]: CREDENTIAL };
    expect(render(record)).not.toContain(CREDENTIAL);
  });

  it("does NOT touch an ordinary short parameter that happens to be called ic", () => {
    // Narrowness, so the scrub cannot start eating unrelated log content.
    expect(render("GET /somewhere?ic=42 HTTP/1.1")).toContain("ic=42");
  });
});

describe("THE ROUTE ITSELF HANDS ITS QUERY TO NO LOGGER", () => {
  const page = readFileSync(
    path.join(REPO_ROOT, "src/app/lifecycle/review-island/page.tsx"),
    "utf8",
  );

  it("contains no logging call at all", () => {
    const code = page
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(/\bconsole\.(log|info|warn|error|debug|trace)\s*\(/);
    expect(code).not.toMatch(/\blogger\b/);
  });

  it("passes the credential to the resolver and to nothing else", () => {
    // CODE lines only — a comment that says the word does not read the value.
    const uses = page
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"))
      .filter((line) => /\bcredential\b/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    // The complete inventory of what the route may do with the value: read it
    // out of the query, narrow it, gate on it, and hand it to the resolver.
    // Anything else — a log call, an audit field, a header, a redirect target —
    // fails here, which is the point: this is the list that has to be EDITED
    // before the route can start doing something else with a bearer.
    const ALLOWED = [
      // The two imports: the parameter NAME and the resolver. Neither reads a value.
      /^import \{ REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM \} from "@\/lib\/lifecycle\/review-island-credential";$/,
      /^const rawCredential = sp\[REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM\];$/,
      /^const credential = typeof rawCredential === "string" \? rawCredential : null;$/,
      /^if \(credential\) \{$/,
      /^const reader = await resolveIslandCredentialReader\(\{ credential, ref \}\);$/,
    ];
    for (const line of uses) {
      expect(
        ALLOWED.some((allowed) => allowed.test(line)),
        `unexpected use of the island credential in the route: ${line}`,
      ).toBe(true);
    }
  });
});

function validEnv(): Record<string, string> {
  return {
    SUPABASE_DB_URL: "postgres://example",
    BETTER_AUTH_SECRET: "a-secret",
    CINATRA_ENCRYPTION_KEY: "0".repeat(64),
    CINATRA_BRIDGE_TOKEN: "a-bridge-token",
  };
}
