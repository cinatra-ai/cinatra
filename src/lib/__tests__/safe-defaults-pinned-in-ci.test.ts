// The safe defaults, pinned where they cannot be lost.
//
// Three defaults decide whether a fresh instance is safe on the day it boots:
//
//   2. registration is CLOSED unless the instance says otherwise, and a setting
//      that cannot be read leaves it closed;
//   3. the development fixture account's password is MINTED for the boot or
//      INJECTED by the operator — never derived from a literal in this
//      repository, where every reader of the source would know it;
//   4. the fixture account is not seeded at all on an instance the public can
//      reach, and BOTH signals that say so are read: the authentication base
//      URL, and the public base URL configured for the instance, which is also
//      what the sign-in stack trusts as an origin.
//
// Each of those is asserted here against the SHIPPED product, and each
// assertion is then pointed at a NEGATIVE FIXTURE named for its criterion and
// required to REJECT it. That second half is what makes the first half worth
// anything: an assertion nobody ever saw fail is an assertion that will go on
// passing after the default it guards has been lost. The fixtures live beside
// this file, one per criterion, and carry the wrong version of the rule they
// are named after.
//
// Criterion 5 — production and this file decide with the SAME predicate. The
// exposure rule is `devFixtureSeedingAllowed`, exported from the module the
// boot itself calls; the tests below drive that function, and a source pin
// holds the boot to calling it. A test that reimplemented the rule would pass
// against its own copy of it forever.
//
// Criterion 7 — this file sits where the root suite's own configuration picks
// it up, so a green run is a run in which these assertions EXECUTED. The last
// block pins that placement against the configuration file itself.

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { devFixtureSeedingAllowed } from "@/lib/dev-fixture-secret";

import { CRITERION_2_NEGATIVE_FIXTURE } from "./__fixtures__/safe-defaults/criterion-2-registration-defaults-open.fixture";
import { CRITERION_3_NEGATIVE_FIXTURE } from "./__fixtures__/safe-defaults/criterion-3-derived-literal-fixture-password.fixture";
import {
  CRITERION_4_NEGATIVE_FIXTURE,
  type ExposureDecision,
  type ExposureInputs,
} from "./__fixtures__/safe-defaults/criterion-4-ignores-the-public-base-url.fixture";

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const INSTANCE_MODE_PATH = path.join(REPO_ROOT, "src", "lib", "authz", "instance-mode.ts");
const DEV_FIXTURE_SECRET_PATH = path.join(REPO_ROOT, "src", "lib", "dev-fixture-secret.ts");
const DEV_AUTO_SETUP_PATH = path.join(REPO_ROOT, "src", "lib", "dev-auto-setup.ts");
const VITEST_CONFIG_PATH = path.join(REPO_ROOT, "vitest.config.ts");

function readSource(p: string): string {
  return fs.readFileSync(p, "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Step over a balanced `{ ... }` group, returning the index just past it. */
function skipBraceGroup(source: string, openBrace: number): number {
  let depth = 0;
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error("skipBraceGroup: unbalanced braces");
}

/**
 * The brace that opens a function BODY, which is not always the first one after
 * the name: a parameter destructuring, and a return type written as an inline
 * object, both open braces of their own. A brace that follows a `:`, a `|`, a
 * `&`, a `<` or a `,` belongs to a type, so it is stepped over.
 */
function bodyBraceIndex(source: string, from: number): number {
  let i = from;
  for (;;) {
    const brace = source.indexOf("{", i);
    if (brace < 0) throw new Error("bodyBraceIndex: no opening brace");
    const before = source.slice(0, brace).replace(/\s+$/, "");
    const prev = before[before.length - 1];
    if (prev === ":" || prev === "|" || prev === "&" || prev === "<" || prev === ",") {
      i = skipBraceGroup(source, brace);
      continue;
    }
    return brace;
  }
}

/** The body of a named top-level function, brace-balanced. */
function extractFunctionBody(source: string, fnName: string): string {
  const decl = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fnName}\\s*\\(`).exec(source);
  if (!decl) throw new Error(`extractFunctionBody: '${fnName}' not found`);
  const openBrace = bodyBraceIndex(source, decl.index + decl[0].length);
  if (openBrace < 0) throw new Error(`extractFunctionBody: '${fnName}' has no opening brace`);
  let depth = 0;
  for (let i = openBrace; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, i);
    }
  }
  throw new Error(`extractFunctionBody: '${fnName}' has unbalanced braces`);
}

/**
 * Run one of the assertions below against a negative fixture and require it to
 * FAIL. `expect` throws on a failed assertion, so an assertion that lets the
 * fixture through returns normally and is reported here as the defect it is.
 */
function rejects(label: string, assertion: () => void): void {
  let complaint: string | null = null;
  try {
    assertion();
  } catch (err) {
    complaint = err instanceof Error ? err.message : String(err);
  }
  expect(
    complaint,
    `the assertion for ${label} accepted its own negative fixture, so it would accept the defect it exists to catch`,
  ).not.toBeNull();
}

// ---------------------------------------------------------------------------
// Criterion 2 — registration is closed by default and fails closed.
// ---------------------------------------------------------------------------

/**
 * The rule, read off a source: nothing stored, an unreadable setting and a
 * value that is not the boolean `false` all leave registration CLOSED. Only an
 * explicit `false` opens it, and the failure path returns closed.
 */
function assertRegistrationDefaultsClosed(source: string): void {
  const body = stripComments(extractFunctionBody(source, "isRegistrationClosed"));
  // Only an explicit stored `false` opens the door. A rule written the other
  // way round (`=== true`) leaves a brand-new instance, which has nothing
  // stored at all, OPEN.
  expect(body, "registration must be closed unless the stored value is exactly false").toMatch(
    /closedRegistration\s*!==\s*false/,
  );
  expect(body, "registration must not be opened by a positive test for a stored value").not.toMatch(
    /closedRegistration\s*===\s*true/,
  );
  // Computing the right answer and returning a different one is the same defect
  // as computing the wrong one, so the read has to be what the function RETURNS.
  expect(body, "the closed-unless-exactly-false read must be the returned value").toMatch(
    /return\s+[^;]*closedRegistration\s*!==\s*false\s*;/,
  );
  const catchIdx = body.indexOf("catch");
  const successPath = catchIdx === -1 ? body : body.slice(0, catchIdx);
  expect(successPath, "a successful read must never resolve to open").not.toMatch(/return\s+false\s*;/);
  // A setting that cannot be read at all must leave the instance closed.
  const rescue = /catch\s*(?:\([^)]*\))?\s*\{([^}]*)\}/.exec(body);
  expect(rescue, "a failed read must be caught rather than left to the caller").not.toBeNull();
  expect(String(rescue?.[1]), "a failed read must fail CLOSED").toMatch(/return\s+true\s*;/);
  expect(String(rescue?.[1]), "a failed read must never resolve to open").not.toMatch(/return\s+false\s*;/);
}

describe("criterion 2 — an instance nobody has configured yet does not accept strangers", () => {
  it("holds on the shipped instance-mode module", () => {
    assertRegistrationDefaultsClosed(readSource(INSTANCE_MODE_PATH));
  });

  it(`rejects the negative fixture ${CRITERION_2_NEGATIVE_FIXTURE.name}`, () => {
    expect(CRITERION_2_NEGATIVE_FIXTURE.criterion).toBe(2);
    rejects(`criterion ${CRITERION_2_NEGATIVE_FIXTURE.criterion}`, () =>
      assertRegistrationDefaultsClosed(CRITERION_2_NEGATIVE_FIXTURE.source),
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 — the fixture secret is minted or injected, never a literal.
// ---------------------------------------------------------------------------

/**
 * The value a binding is bound to, read out with quotes, brackets and braces
 * BALANCED: a right-hand side ends at a comma, a semicolon or a line break only
 * where it is not inside one of them, and at the closing bracket of whatever
 * encloses it.
 *
 * Reading it any more cheaply than this is what makes a pin like the one below
 * worthless. A reader that stops at the first comma sees `["a", "b"].join("-")`
 * as `["a"`, and sees a credential written as an object property — which is
 * exactly how the seeding call is written — as the literal plus the punctuation
 * that closes the object, so neither is recognised for what it is.
 */
function readRightHandSide(source: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  let i = from;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { depth += 1; continue; }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth -= 1;
      continue;
    }
    if (depth === 0 && (ch === "," || ch === ";" || ch === "\n")) break;
  }
  return source.slice(from, i).trim();
}

/** What a source binds a name to, whatever the name is spelled like. */
function constantBinding(source: string, name: string): string | null {
  const decl = new RegExp(`(?:^|[^A-Za-z0-9_$.])(?:const|let|var)\\s+${name}\\s*=\\s*`).exec(source);
  if (!decl) return null;
  return readRightHandSide(source, decl.index + decl[0].length);
}

/**
 * A value that is the SAME on every boot of every instance: a fixed string, a
 * fixed string joined to another, or one assembled out of fixed fragments.
 * Names are folded in first, so a constant reached through an identifier —
 * `parts.join("-")`, whatever `parts` is spelled like — reads as the constant
 * it is; `["a","b"].join("-")` is computation in shape only.
 *
 * A value that is GENERATED (random bytes at boot) or INJECTED (the setting the
 * instance was started with) is not matched, and neither is a reference to one:
 * an identifier that is not bound to a constant here, a call, a member read and
 * a type annotation all pass.
 */
function isDerivedLiteral(rhs: string, source: string): boolean {
  let expr = rhs.replace(/\bas\s+const\b/g, " ");
  for (let pass = 0; pass < 3; pass += 1) {
    const folded = expr.replace(/\b[A-Za-z_$][A-Za-z0-9_$]*\b(?!\s*\()/g, (name) => {
      const bound = constantBinding(source, name);
      return bound === null || bound === "" || bound === name ? name : `(${bound})`;
    });
    if (folded === expr) break;
    expr = folded;
  }
  const skeleton = expr
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$\\]*`/g, "S")
    .replace(/\.\s*(?:join|concat|toString|toUpperCase|toLowerCase|trim|repeat|padStart|padEnd|slice)\s*/g, ".")
    .replace(/\s+/g, "");
  // Only string literals and the punctuation that assembles them survive.
  return /S/.test(skeleton) && /^[S[\](),.+]+$/.test(skeleton);
}

/** Every credential a source BINDS, with what it binds it to. */
function passwordBindings(source: string): Array<{ text: string; rhs: string }> {
  const stripped = stripComments(source);
  const out: Array<{ text: string; rhs: string }> = [];
  const pattern = /(?:^|[^A-Za-z0-9_$])(password|passwd|pass|secret)\s*(?::|=(?!=))\s*/gi;
  for (const match of stripped.matchAll(pattern)) {
    const from = (match.index ?? 0) + match[0].length;
    const rhs = readRightHandSide(stripped, from);
    out.push({ text: `${match[1]} = ${rhs}`, rhs });
  }
  return out;
}

/**
 * The rule, read off a source: nothing on the fixture-seeding path binds a
 * credential to a constant that is in this repository.
 */
function assertNoDerivedCredentialLiteral(source: string, where: string): void {
  for (const binding of passwordBindings(source)) {
    expect(
      isDerivedLiteral(binding.rhs, source),
      `${where} binds a credential to a value this repository already knows: ${binding.text}`,
    ).toBe(false);
  }
}

describe("criterion 3 — the fixture account's secret is minted for the boot, never read off the source", () => {
  it("holds on the module that owns the secret", () => {
    assertNoDerivedCredentialLiteral(readSource(DEV_FIXTURE_SECRET_PATH), "the fixture-secret module");
  });

  it("holds on the seeding path in the development boot", () => {
    const source = readSource(DEV_AUTO_SETUP_PATH);
    // The whole module, so that a fragment list declared beside the seeding
    // path is folded into the value it produces rather than read as a name.
    assertNoDerivedCredentialLiteral(source, "the development boot");
    // The value it does use comes from the shared mint, not from anywhere else.
    expect(stripComments(extractFunctionBody(source, "ensureDevConnectActor"))).toMatch(
      /resolveDevFixturePassword\(/,
    );
  });

  it("mints a different secret on each boot when the operator supplies none", async () => {
    vi.resetModules();
    const firstBoot = await import("@/lib/dev-fixture-secret");
    const first = firstBoot.resolveDevFixturePassword({});
    vi.resetModules();
    const secondBoot = await import("@/lib/dev-fixture-secret");
    const second = secondBoot.resolveDevFixturePassword({});
    expect(first.source).toBe("generated");
    expect(second.source).toBe("generated");
    expect(second.password).not.toBe(first.password);
  });

  it(`rejects the negative fixture ${CRITERION_3_NEGATIVE_FIXTURE.name}`, () => {
    expect(CRITERION_3_NEGATIVE_FIXTURE.criterion).toBe(3);
    rejects(`criterion ${CRITERION_3_NEGATIVE_FIXTURE.criterion}`, () =>
      assertNoDerivedCredentialLiteral(CRITERION_3_NEGATIVE_FIXTURE.source, "the negative fixture"),
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 — no seeding under a public exposure signal, and BOTH are read.
// ---------------------------------------------------------------------------

// The last of these is the container-network alias a container uses to reach
// the app on the machine that runs it — the value the end-to-end harness boots
// the app with, and a name nothing outside that machine can resolve.
const LOCAL_ORIGINS = [
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
  "http://[fd00::1]:3000",
  "http://host.docker.internal:3000",
] as const;
const PUBLIC_ORIGINS = ["https://instance.example.net", "https://app.example.org:8443", "https://example.com"] as const;

/**
 * The rule, driven through a decision: on a development runtime, an instance
 * whose every configured origin is loopback or private-network may seed, and an
 * instance that is reachable from outside through EITHER signal may not.
 */
function assertRefusesEveryPublicExposureSignal(decide: (inputs: ExposureInputs) => ExposureDecision): void {
  const dev = { runtimeMode: "development", nodeEnv: "development" } as const;

  // The signal a rule is most likely to be blind to, first: an instance served
  // to the internet at a URL the sign-in stack trusts, whose authentication
  // base URL is the loopback address it always is in development.
  for (const publicBaseUrl of PUBLIC_ORIGINS) {
    expect(
      decide({ ...dev, authBaseUrl: "http://127.0.0.1:3000", publicBaseUrl }).allowed,
      `seeding must be refused on an instance whose configured public base URL is ${publicBaseUrl}`,
    ).toBe(false);
  }

  for (const authBaseUrl of PUBLIC_ORIGINS) {
    expect(
      decide({ ...dev, authBaseUrl, publicBaseUrl: null }).allowed,
      `seeding must be refused on an instance whose authentication base URL is ${authBaseUrl}`,
    ).toBe(false);
  }

  for (const local of LOCAL_ORIGINS) {
    expect(
      decide({ ...dev, authBaseUrl: local, publicBaseUrl: null }).allowed,
      `seeding must be allowed on an instance served only at ${local}`,
    ).toBe(true);
    expect(
      decide({ ...dev, authBaseUrl: local, publicBaseUrl: local }).allowed,
      `seeding must be allowed when both signals are ${local}`,
    ).toBe(true);
  }

  // An instance with no public base URL configured — and one whose database
  // cannot be asked yet — is not thereby public.
  expect(decide({ ...dev, authBaseUrl: "http://127.0.0.1:3000", publicBaseUrl: null }).allowed).toBe(true);

  // Outside a development runtime nothing is seeded at all.
  expect(decide({ runtimeMode: "production", nodeEnv: "production", authBaseUrl: "http://127.0.0.1:3000" }).allowed).toBe(
    false,
  );
  expect(decide({ runtimeMode: "development", nodeEnv: "production", authBaseUrl: "http://127.0.0.1:3000" }).allowed).toBe(
    false,
  );
}

describe("criterion 4 — an instance the public can reach never carries the fixture account", () => {
  it("holds on the shared predicate the boot itself decides with", () => {
    assertRefusesEveryPublicExposureSignal(devFixtureSeedingAllowed);
  });

  it("says which origin it refused, and which signal carried it", () => {
    const decision = devFixtureSeedingAllowed({
      runtimeMode: "development",
      nodeEnv: "development",
      authBaseUrl: "http://127.0.0.1:3000",
      publicBaseUrl: "https://instance.example.net",
    });
    expect(decision.allowed).toBe(false);
    expect(String(decision.refusal)).toContain("https://instance.example.net");
    expect(String(decision.refusal).toLowerCase()).toContain("refus");
    expect(String(decision.refusal).toLowerCase()).toContain("public base url");
  });

  it("refuses when the public base URL cannot be read at all", () => {
    const decision = devFixtureSeedingAllowed({
      runtimeMode: "development",
      nodeEnv: "development",
      authBaseUrl: "http://127.0.0.1:3000",
      publicBaseUrl: null,
      publicBaseUrlUnreadable: true,
    });
    expect(decision.allowed, "a signal that cannot be read is not a signal that may be ignored").toBe(false);
    expect(decision.reason).toBe("exposure");
    expect(String(decision.refusal).toLowerCase()).toContain("could not be read");
  });

  it("still reads the settings the instance is served on", () => {
    const decision = devFixtureSeedingAllowed({
      runtimeMode: "development",
      nodeEnv: "development",
      authBaseUrl: "http://127.0.0.1:3000",
      env: { NEXT_PUBLIC_APP_URL: "https://instance.example.net" },
    });
    expect(decision.allowed).toBe(false);
    expect(String(decision.refusal)).toContain("NEXT_PUBLIC_APP_URL");
  });

  it(`rejects the negative fixture ${CRITERION_4_NEGATIVE_FIXTURE.name}`, () => {
    expect(CRITERION_4_NEGATIVE_FIXTURE.criterion).toBe(4);
    // Named precisely: the fixture is blind to the second signal, and lets the
    // seeding run on an instance the whole internet can reach.
    expect(
      CRITERION_4_NEGATIVE_FIXTURE.decide({
        runtimeMode: "development",
        nodeEnv: "development",
        authBaseUrl: "http://127.0.0.1:3000",
        publicBaseUrl: "https://instance.example.net",
      }).allowed,
    ).toBe(true);
    rejects(`criterion ${CRITERION_4_NEGATIVE_FIXTURE.criterion}`, () =>
      assertRefusesEveryPublicExposureSignal(CRITERION_4_NEGATIVE_FIXTURE.decide),
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 5 — the boot and this file decide with the same predicate.
// ---------------------------------------------------------------------------

describe("criterion 5 — one predicate, called by the boot and by these tests", () => {
  it("is exported from the module the boot imports", () => {
    expect(typeof devFixtureSeedingAllowed).toBe("function");
    expect(stripComments(readSource(DEV_FIXTURE_SECRET_PATH))).toMatch(
      /export function devFixtureSeedingAllowed\(/,
    );
  });

  it("is what the fixture-seeding path calls, before it reads or writes anything", () => {
    const body = stripComments(extractFunctionBody(readSource(DEV_AUTO_SETUP_PATH), "ensureDevConnectActor"));
    const decisionIdx = body.indexOf("devFixtureSeedingAllowed(");
    expect(decisionIdx).toBeGreaterThan(-1);
    const firstQueryIdx = body.indexOf("runPostgresQueriesSync");
    const signUpIdx = body.indexOf("signUpEmail");
    expect(firstQueryIdx).toBeGreaterThan(decisionIdx);
    expect(signUpIdx).toBeGreaterThan(decisionIdx);
  });

  it("is handed both exposure signals by the boot, not just the one from the environment", () => {
    const body = stripComments(extractFunctionBody(readSource(DEV_AUTO_SETUP_PATH), "ensureDevConnectActor"));
    expect(body).toMatch(/authBaseUrl:/);
    expect(body).toMatch(/publicBaseUrl:/);
    // Handed the value this instance actually stores, not a placeholder, and
    // told when that value could not be read at all.
    expect(body, "the public base URL handed over must be a value read at boot").toMatch(
      /publicBaseUrl:\s*[A-Za-z_$][A-Za-z0-9_$]*\s*(?:\.|\()/,
    );
    expect(body, "an unreadable public base URL must reach the rule as its own signal").toMatch(
      /publicBaseUrlUnreadable:/,
    );
    // And the reader must report a failed read AS a failed read. A catch arm
    // that answers "nothing configured" hands the rule a clean bill of health
    // it never established, which is the fail-open this criterion exists for.
    const reader = stripComments(extractFunctionBody(readSource(DEV_AUTO_SETUP_PATH), "configuredPublicBaseUrl"));
    const rescue = /catch\s*(?:\([^)]*\))?\s*\{([\s\S]*)\}\s*$/.exec(reader);
    expect(rescue, "a failed read must be caught rather than left to the caller").not.toBeNull();
    expect(String(rescue?.[1]), "a read that failed must be reported as unreadable").toMatch(
      /unreadable:\s*true/,
    );
    expect(String(rescue?.[1]), "a read that failed must never be reported as a clean read").not.toMatch(
      /unreadable:\s*false/,
    );
    // The second signal is the one the instance stores about itself, read
    // through the same reader the sign-in stack's trusted origins come from.
    expect(stripComments(readSource(DEV_AUTO_SETUP_PATH))).toMatch(/getMcpPublicBaseUrl/);
  });

  it("lets the decision it made govern the seeding", () => {
    const body = stripComments(extractFunctionBody(readSource(DEV_AUTO_SETUP_PATH), "ensureDevConnectActor"));
    const decl = /const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*devFixtureSeedingAllowed\(/.exec(body);
    expect(decl, "the boot must keep the decision it made").not.toBeNull();
    const guard = new RegExp(`if\\s*\\(\\s*!\\s*${String(decl?.[1])}\\.allowed\\s*\\)\\s*\\{`);
    expect(body, "a refusal must stop the boot, not be printed and walked past").toMatch(guard);
    const guardIdx = body.search(guard);
    const branchEnd = body.indexOf("\n  }", guardIdx);
    expect(branchEnd).toBeGreaterThan(guardIdx);
    const branch = body.slice(guardIdx, branchEnd);
    expect(branch, "the refusal branch must return without seeding").toMatch(/return\s+null\s*;/);
    expect(branch, "the refusal branch must not seed").not.toMatch(/signUpEmail/);
  });

  it("leaves no second reading of the rule behind in the development boot", () => {
    const source = readSource(DEV_AUTO_SETUP_PATH);
    const body = stripComments(extractFunctionBody(source, "ensureDevConnectActor"));
    // Handing the predicate its inputs is not deciding: what the seeding path
    // must not do is make up its own mind about either arm of the rule.
    expect(body).not.toMatch(/===\s*"development"/);
    expect(body).not.toMatch(/isLoopbackOrPrivateOrigin\(/);
    // The strict-development gate the rest of the development shell asks is the
    // SAME rule with no exposure signals, not a second copy of it. A local
    // re-reading beside the predicate is exactly the drift this criterion stops.
    expect(stripComments(extractFunctionBody(source, "isStrictDevelopmentRuntime"))).toMatch(
      /devFixtureSeedingAllowed\(/,
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 7 — a green run is a run in which the above EXECUTED.
// ---------------------------------------------------------------------------

describe("criterion 7 — this file is inside the root suite's own include", () => {
  it("is picked up by the pattern the root configuration lists", () => {
    const config = readSource(VITEST_CONFIG_PATH);
    expect(config).toContain('"src/**/__tests__/**/*.test.{ts,tsx}"');
    const here = path.relative(REPO_ROOT, __filename).split(path.sep).join("/");
    expect(here.startsWith("src/")).toBe(true);
    expect(here).toMatch(/^src\/(?:.*\/)?__tests__\/[^/]*\.test\.tsx?$/);
  });
});
