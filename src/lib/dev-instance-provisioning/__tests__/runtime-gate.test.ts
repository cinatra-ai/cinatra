/**
 * THE RUNTIME GATE EVERY DEVELOPMENT-ONLY PROVISIONING WRITE ASKS FOR ITSELF.
 *
 * Two claims, both mechanical:
 *
 *   1. `assertDevelopmentRuntime` refuses outside a development runtime, reads
 *      the mode through the SAME predicate the rest of the codebase uses
 *      (`isAppDevelopmentMode()` / `getAppRuntimeMode()`, both env keys), and
 *      names the mode it refused in.
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
