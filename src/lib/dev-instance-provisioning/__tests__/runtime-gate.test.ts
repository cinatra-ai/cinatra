/**
 * THE RUNTIME GATES EVERY DEVELOPMENT-ONLY PROVISIONING WRITE ASKS FOR ITSELF.
 *
 * Three claims, all mechanical:
 *
 *   1. `assertDevelopmentRuntime` runs on development instances only. It starts
 *      from the SAME predicate the rest of the codebase uses
 *      (`isAppDevelopmentMode()` / `getAppRuntimeMode()`, both env keys) and
 *      then asks for more than it: a DECLARED runtime mode is accepted only as
 *      `development` (any letter case, surrounding blanks trimmed) and refused
 *      otherwise, under every build; an UNDECLARED mode keeps parity with the
 *      shared reading and is refused only under a production build. A refusal
 *      names the variable and the accepted spelling, never the declared value.
 *   2. `assertDeclaredDevelopmentRuntime` adds exactly ONE requirement to that,
 *      for the write an operator cannot undo: the mode has to have been
 *      DECLARED. It asks the shared gate first, so a declared mode is judged by
 *      the same rule for both and the two decide differently in the undeclared
 *      case alone.
 *   3. EVERY wrapper module asks a gate ITSELF — the gate is the FIRST
 *      executable statement of each exported entry point, not a single
 *      top-level check in the composed command, and each entry point names
 *      WHICH gate it must ask. A source scan is the right instrument for that:
 *      it is a claim about the shape of the code, and it keeps holding for a
 *      wrapper somebody adds later.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { APP_RUNTIME_MODE_ENV_KEYS } from "@/lib/runtime-mode";
import {
  DeclaredDevelopmentRuntimeRequiredError,
  DevelopmentRuntimeRefusedError,
  assertDeclaredDevelopmentRuntime,
  assertDevelopmentRuntime,
} from "@/lib/dev-instance-provisioning/runtime-gate";

const RUNTIME_ENV_KEYS = ["CINATRA_RUNTIME_MODE", "APP_RUNTIME_MODE"] as const;

function withRuntimeEnv(values: Partial<Record<(typeof RUNTIME_ENV_KEYS)[number], string>>) {
  for (const key of RUNTIME_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

afterEach(() => {
  for (const key of RUNTIME_ENV_KEYS) delete process.env[key];
});

describe("assertDevelopmentRuntime", () => {
  it("passes in a development runtime (and with the mode unset, which IS development)", () => {
    withRuntimeEnv({});
    expect(() => assertDevelopmentRuntime("provisionInstanceNamespace")).not.toThrow();
    withRuntimeEnv({ CINATRA_RUNTIME_MODE: "development" });
    expect(() => assertDevelopmentRuntime("provisionInstanceNamespace")).not.toThrow();
  });

  it("refuses in production, naming the operation and the mode", () => {
    withRuntimeEnv({ CINATRA_RUNTIME_MODE: "production" });
    let caught: unknown = null;
    try {
      assertDevelopmentRuntime("provisionConnectorServiceSecret");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DevelopmentRuntimeRefusedError);
    expect((caught as DevelopmentRuntimeRefusedError).runtimeMode).toBe("production");
    expect(String((caught as Error).message)).toContain("provisionConnectorServiceSecret");
    expect(String((caught as Error).message)).toContain("production");
  });

  it("reads the second env key too, and the short `prod` spelling", () => {
    withRuntimeEnv({ APP_RUNTIME_MODE: "prod" });
    expect(() => assertDevelopmentRuntime("provisionPublicOrigin")).toThrow(
      DevelopmentRuntimeRefusedError,
    );
  });

  it("refuses an UNDECLARED runtime mode under a production build", () => {
    // The canonical predicate reads an unset mode as development — the whole
    // app does. But "nobody declared a mode" is not "this is a development
    // instance", and a production build says so through NODE_ENV. The gate
    // fails closed on that ambiguity rather than writing into it.
    try {
      withRuntimeEnv({});
      vi.stubEnv("NODE_ENV", "production");
      expect(() => assertDevelopmentRuntime("provisionInstanceNamespace")).toThrow(
        DevelopmentRuntimeRefusedError,
      );

      // A DECLARED development mode still passes under a production build: a
      // developer running one locally is exactly who this command is for.
      withRuntimeEnv({ CINATRA_RUNTIME_MODE: "development" });
      expect(() => assertDevelopmentRuntime("provisionInstanceNamespace")).not.toThrow();
    } finally {
      // `vi.stubEnv` restores the prior value (including "unset") on unstub.
      vi.unstubAllEnvs();
    }
  });

  // -------------------------------------------------------------------------
  // A DECLARED runtime mode has to be a development spelling.
  //
  // The shared reading is a two-value projection — everything that is not a
  // production spelling projects onto "development" — so these claims are about
  // the gate asking for MORE than it, in the closed direction only.
  // -------------------------------------------------------------------------

  it("accepts the development spelling, any letter case, surrounding blanks trimmed", () => {
    for (const declared of [
      "development",
      "DEVELOPMENT",
      "Development",
      "  development  ",
      "\tdevelopment\n",
    ]) {
      withRuntimeEnv({ CINATRA_RUNTIME_MODE: declared });
      expect(() => assertDevelopmentRuntime("provisionInstanceNamespace")).not.toThrow();
      withRuntimeEnv({ APP_RUNTIME_MODE: declared });
      expect(() => assertDevelopmentRuntime("provisionInstanceNamespace")).not.toThrow();
    }
  });

  it("refuses a DECLARED runtime mode that is not the development spelling", () => {
    // The short form `dev` belongs in this list: every strict development-only
    // switch in the codebase is a POSITIVE test for `development`, so an
    // instance declaring a short form enables no development path at all while
    // still asking for the development-only writes. `demo` belongs here for the
    // opposite reason — a demo instance IS a development instance and declares
    // `CINATRA_RUNTIME_MODE=development`, carrying its overlay on the separate
    // `CINATRA_INSTALL_PROFILE` axis (`src/lib/install-profile.ts`), so no
    // shipped install writes `demo` here. `producton` and `developmnet` are the
    // misspellings the shared two-value projection would read as development.
    for (const declared of [
      "dev",
      "Dev",
      "\tdev\n",
      "staging",
      "preview",
      "demo",
      "developmnet",
      "producton",
    ]) {
      withRuntimeEnv({ CINATRA_RUNTIME_MODE: declared });
      expect(() => assertDevelopmentRuntime("provisionInstanceNamespace")).toThrow(
        DevelopmentRuntimeRefusedError,
      );
      withRuntimeEnv({ APP_RUNTIME_MODE: declared });
      expect(() => assertDevelopmentRuntime("provisionInstanceNamespace")).toThrow(
        DevelopmentRuntimeRefusedError,
      );
    }
  });

  it("refuses a DECLARED non-development value under a development build too", () => {
    try {
      vi.stubEnv("NODE_ENV", "development");
      withRuntimeEnv({ CINATRA_RUNTIME_MODE: "staging" });
      expect(() => assertDevelopmentRuntime("provisionDevInstance")).toThrow(
        DevelopmentRuntimeRefusedError,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses the production spellings whatever their letter case and blanks", () => {
    for (const declared of ["production", "prod", "PROD", "  Production  "]) {
      withRuntimeEnv({ CINATRA_RUNTIME_MODE: declared });
      expect(() => assertDevelopmentRuntime("provisionPublicOrigin")).toThrow(
        DevelopmentRuntimeRefusedError,
      );
    }
  });

  it("accepts an UNDECLARED runtime mode when the build is not a production one", () => {
    // Parity with the shared reading, which defaults an undeclared mode to
    // development explicitly (`getAppRuntimeMode()` in `src/lib/runtime-mode.ts`
    // returns "development" when no key carries a value). A blank value is not a
    // declaration either.
    withRuntimeEnv({});
    expect(() => assertDevelopmentRuntime("provisionInstanceNamespace")).not.toThrow();
    withRuntimeEnv({ CINATRA_RUNTIME_MODE: "   " });
    expect(() => assertDevelopmentRuntime("provisionInstanceNamespace")).not.toThrow();
  });

  it("names the variable and the accepted spelling, never the declared value", () => {
    for (const declared of ["staging", "preview", "developmnet"]) {
      withRuntimeEnv({ CINATRA_RUNTIME_MODE: declared });
      let caught: unknown = null;
      try {
        assertDevelopmentRuntime("provisionConnectorServiceSecret");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DevelopmentRuntimeRefusedError);
      const refused = caught as DevelopmentRuntimeRefusedError;
      const reported = `${refused.message} ${refused.runtimeMode}`;
      expect(reported).not.toContain(declared);
      expect(reported).toContain("CINATRA_RUNTIME_MODE");
      expect(reported).toContain("development");
      expect(reported).toContain("provisionConnectorServiceSecret");
    }
  });
});

// ---------------------------------------------------------------------------
// THE STRICT GATE, for the write that seats the instance's operator.
//
// It asks the shared gate first, so a declared mode is judged by the same rule
// for both: `development`, and nothing else. What it adds is the requirement
// the shared gate deliberately does not make — that a mode was DECLARED at all.
// The shared gate accepts an undeclared mode whenever the build is not a
// production one, keeping parity with the app's own reading. That parity is
// right for a namespace or a public origin, which an operator can undo. It is
// not right for the one write that hands somebody platform-administrator rights
// on an instance that has nobody on it yet, so that write asks for a runtime
// the instance DECLARES.
// ---------------------------------------------------------------------------

describe("assertDeclaredDevelopmentRuntime", () => {
  it("accepts the spelling a development instance declares", () => {
    for (const declared of ["development", " Development ", "DEVELOPMENT"]) {
      withRuntimeEnv({ CINATRA_RUNTIME_MODE: declared });
      expect(
        () => assertDeclaredDevelopmentRuntime("provisionFirstAdministrator"),
        `"${declared}" must be accepted`,
      ).not.toThrow();
    }
    // The second env key carries the same weight as the first.
    withRuntimeEnv({ APP_RUNTIME_MODE: "development" });
    expect(() => assertDeclaredDevelopmentRuntime("provisionFirstAdministrator")).not.toThrow();
  });

  it("refuses a DECLARED runtime that is not a development one, under a production build", () => {
    // Through the shared gate it asks first: a declared mode that is not
    // `development` is refused under every build, whichever gate is asked.
    try {
      vi.stubEnv("NODE_ENV", "production");
      withRuntimeEnv({ CINATRA_RUNTIME_MODE: "staging" });
      expect(() => assertDevelopmentRuntime("provisionFirstAdministrator")).toThrow(
        DevelopmentRuntimeRefusedError,
      );
      expect(() => assertDeclaredDevelopmentRuntime("provisionFirstAdministrator")).toThrow(
        DevelopmentRuntimeRefusedError,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a short form or a typo rather than reading it as development", () => {
    for (const declared of [
      "dev",
      "DEV",
      "\tdev\n",
      "developement",
      "develop",
      "devel",
      "preview",
      "test",
      "prd",
    ]) {
      withRuntimeEnv({ CINATRA_RUNTIME_MODE: declared });
      expect(
        () => assertDeclaredDevelopmentRuntime("provisionFirstAdministrator"),
        `${JSON.stringify(declared)} must be refused`,
      ).toThrow(DevelopmentRuntimeRefusedError);
    }
  });

  it("refuses an UNDECLARED runtime, even under a development build", () => {
    try {
      vi.stubEnv("NODE_ENV", "development");
      withRuntimeEnv({});
      // The one case the two gates decide differently: the shared gate keeps
      // parity with the app's reading and accepts an undeclared mode here.
      expect(() => assertDevelopmentRuntime("provisionFirstAdministrator")).not.toThrow();
      // "Nobody said" is not "somebody said development".
      expect(() => assertDeclaredDevelopmentRuntime("provisionFirstAdministrator")).toThrow(
        DeclaredDevelopmentRuntimeRequiredError,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a BLANK value, which is not a declaration", () => {
    withRuntimeEnv({ CINATRA_RUNTIME_MODE: "   " });
    expect(() => assertDeclaredDevelopmentRuntime("provisionFirstAdministrator")).toThrow(
      DeclaredDevelopmentRuntimeRequiredError,
    );
  });

  it("still refuses a production runtime through the shared gate it calls first", () => {
    withRuntimeEnv({ CINATRA_RUNTIME_MODE: "production" });
    expect(() => assertDeclaredDevelopmentRuntime("provisionFirstAdministrator")).toThrow(
      DevelopmentRuntimeRefusedError,
    );
  });

  it("reads the app's OWN env keys, in the app's own order", () => {
    // The gates judge the declaration more strictly than the app does, but they
    // read the SAME declaration only while they read the same two variables in
    // the same precedence. Nothing pinned that while each file declared its own
    // copy of the tuple.
    expect([...APP_RUNTIME_MODE_ENV_KEYS]).toEqual([
      "CINATRA_RUNTIME_MODE",
      "APP_RUNTIME_MODE",
    ]);
  });

  it("lets the FIRST key decide when the two disagree, in both directions", () => {
    withRuntimeEnv({
      CINATRA_RUNTIME_MODE: "development",
      APP_RUNTIME_MODE: "production",
    });
    expect(() => assertDeclaredDevelopmentRuntime("provisionFirstAdministrator")).not.toThrow();

    withRuntimeEnv({
      CINATRA_RUNTIME_MODE: "production",
      APP_RUNTIME_MODE: "development",
    });
    expect(() => assertDeclaredDevelopmentRuntime("provisionFirstAdministrator")).toThrow(
      DevelopmentRuntimeRefusedError,
    );
  });

  it("skips a BLANK first key and reads the second, as the app does", () => {
    withRuntimeEnv({ CINATRA_RUNTIME_MODE: "   ", APP_RUNTIME_MODE: "development" });
    expect(() => assertDeclaredDevelopmentRuntime("provisionFirstAdministrator")).not.toThrow();
  });

  it("accepts a value a shell left a newline on", () => {
    for (const declared of ["development\n", "development\r\n", "\tdevelopment\n"]) {
      withRuntimeEnv({ CINATRA_RUNTIME_MODE: declared });
      expect(
        () => assertDeclaredDevelopmentRuntime("provisionFirstAdministrator"),
        `${JSON.stringify(declared)} must be accepted`,
      ).not.toThrow();
    }
  });

  it("names the operation, the variables to set and the accepted spelling when nothing is declared", () => {
    withRuntimeEnv({});
    let caught: unknown = null;
    try {
      assertDeclaredDevelopmentRuntime("provisionFirstAdministrator");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DeclaredDevelopmentRuntimeRequiredError);
    const message = String((caught as Error).message);
    expect(message).toContain("provisionFirstAdministrator");
    expect(message).toContain("CINATRA_RUNTIME_MODE");
    expect(message).toContain("APP_RUNTIME_MODE");
    expect(message).toContain("development");
  });

  it("refuses a declared value without echoing it back", () => {
    const declared = "synthetic-declared-value-6b12";
    withRuntimeEnv({ CINATRA_RUNTIME_MODE: declared });
    let caught: unknown = null;
    try {
      assertDeclaredDevelopmentRuntime("provisionFirstAdministrator");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DevelopmentRuntimeRefusedError);
    const refused = caught as DevelopmentRuntimeRefusedError;
    const reported = `${refused.message} ${refused.runtimeMode}`;
    // An environment value can hold anything, and this message is printed.
    expect(reported).not.toContain(declared);
    expect(reported).toContain("CINATRA_RUNTIME_MODE");
    expect(reported).toContain("development");
    expect(reported).toContain("provisionFirstAdministrator");
  });
});

// ---------------------------------------------------------------------------
// The shape claim: every wrapper asks the gate itself.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
type GatedEntryPoint = { file: string; fn: string; gate: string };

/**
 * Each entry point names WHICH gate it must ask. The four writes an operator
 * can undo take the shared one; the write that seats the operator takes the
 * strict one, and a future edit that swaps either way fails here.
 */
const GATED_ENTRY_POINTS: ReadonlyArray<GatedEntryPoint> = [
  {
    file: "src/lib/dev-instance-provisioning/provision-namespace.ts",
    fn: "provisionInstanceNamespace",
    gate: "assertDevelopmentRuntime",
  },
  {
    file: "src/lib/dev-instance-provisioning/provision-connector-service-secret.ts",
    fn: "provisionConnectorServiceSecret",
    gate: "assertDevelopmentRuntime",
  },
  {
    file: "src/lib/dev-instance-provisioning/provision-public-origin.ts",
    fn: "provisionPublicOrigin",
    gate: "assertDevelopmentRuntime",
  },
  {
    file: "src/lib/dev-instance-provisioning/provision-provider-connection.ts",
    fn: "provisionProviderConnection",
    gate: "assertDevelopmentRuntime",
  },
  {
    file: "src/lib/dev-instance-provisioning/provision-first-administrator.ts",
    fn: "provisionFirstAdministrator",
    gate: "assertDeclaredDevelopmentRuntime",
  },
  {
    file: "src/lib/dev-instance-provisioning/provision-instance.ts",
    fn: "provisionDevInstance",
    gate: "assertDevelopmentRuntime",
  },
];

/** The body of `export [async] function <name>(...)` up to its closing brace. */
function extractFunctionBody(source: string, name: string): string {
  const signature = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = signature.exec(source);
  if (!match) throw new Error(`${name} is not an exported function declaration`);
  const openBrace = source.indexOf("{", source.indexOf(")", match.index));
  let depth = 0;
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, i);
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

/** The first line that actually executes (comments and blanks skipped). */
function firstExecutableLine(body: string): string {
  const lines = body.split("\n");
  let inBlockComment = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (line.length === 0 || line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlockComment = true;
      continue;
    }
    return line;
  }
  return "";
}

describe("every development-only provisioning entry point gates itself", () => {
  for (const { file, fn, gate } of GATED_ENTRY_POINTS) {
    it(`${fn}: the FIRST executable statement is ${gate}`, () => {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      // Anchored AND closed on the opening bracket, so the strict gate's name
      // can never satisfy the shared gate's entry, nor the shared gate's name
      // the strict one's.
      expect(firstExecutableLine(extractFunctionBody(source, fn))).toMatch(
        new RegExp(`^${gate}\\(`),
      );
    });
  }

  it("the gate imports the app's env-key tuple rather than keeping a copy", () => {
    const source = readFileSync(
      path.join(ROOT, "src/lib/dev-instance-provisioning/runtime-gate.ts"),
      "utf8",
    );
    expect(source).toMatch(/APP_RUNTIME_MODE_ENV_KEYS/);
    // One tuple, one precedence: a second literal copy here is a second
    // reader that nothing keeps in step with the app.
    expect(source).not.toMatch(/=\s*\[\s*"CINATRA_RUNTIME_MODE"/);
  });

  it("the write that seats the operator is the one on the strict gate", () => {
    const strict = GATED_ENTRY_POINTS.filter(
      (entry) => entry.gate === "assertDeclaredDevelopmentRuntime",
    );
    expect(strict.map((entry) => entry.fn)).toEqual(["provisionFirstAdministrator"]);
  });
});
