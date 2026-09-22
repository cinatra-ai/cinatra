/**
 * THE RUNTIME GATE EVERY DEVELOPMENT-ONLY PROVISIONING WRITE ASKS FOR ITSELF.
 *
 * Two claims, both mechanical:
 *
 *   1. `assertDevelopmentRuntime` runs on development instances only. It starts
 *      from the SAME predicate the rest of the codebase uses
 *      (`isAppDevelopmentMode()` / `getAppRuntimeMode()`, both env keys) and
 *      then asks for more than it: a DECLARED runtime mode is accepted only as
 *      `development` (any letter case, surrounding blanks trimmed) and refused
 *      otherwise, under every build; an UNDECLARED mode keeps parity with the
 *      shared reading and is refused only under a production build. A refusal
 *      names the variable and the accepted spelling, never the declared value.
 *   2. EVERY wrapper module asks the gate ITSELF — the gate is the FIRST
 *      executable statement of each exported entry point, not a single
 *      top-level check in the composed command. A source scan is the right
 *      instrument for that: it is a claim about the shape of the code, and it
 *      keeps holding for a wrapper somebody adds later.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DevelopmentRuntimeRefusedError,
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
// The shape claim: every wrapper asks the gate itself.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const GATED_ENTRY_POINTS: ReadonlyArray<{ file: string; fn: string }> = [
  { file: "src/lib/dev-instance-provisioning/provision-namespace.ts", fn: "provisionInstanceNamespace" },
  {
    file: "src/lib/dev-instance-provisioning/provision-connector-service-secret.ts",
    fn: "provisionConnectorServiceSecret",
  },
  { file: "src/lib/dev-instance-provisioning/provision-public-origin.ts", fn: "provisionPublicOrigin" },
  {
    file: "src/lib/dev-instance-provisioning/provision-provider-connection.ts",
    fn: "provisionProviderConnection",
  },
  { file: "src/lib/dev-instance-provisioning/provision-instance.ts", fn: "provisionDevInstance" },
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
  for (const { file, fn } of GATED_ENTRY_POINTS) {
    it(`${fn}: the FIRST executable statement is the runtime-mode gate`, () => {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      expect(firstExecutableLine(extractFunctionBody(source, fn))).toMatch(
        /^assertDevelopmentRuntime\(/,
      );
    });
  }
});
