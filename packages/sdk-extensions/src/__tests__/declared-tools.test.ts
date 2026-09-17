/**
 * THE DECLARED-TOOLS CONTRACT (cinatra#3249, epic #3023).
 *
 * The passthrough admits ONE generic dispatch tool. It names no package: the
 * caller is derived from the run's own binding, and the NAME the caller asks
 * for is resolved against THAT package's own manifest — the list parsed here.
 *
 * The contract the issue asks to land "in host code and tests" — "the exact
 * field names (the manifest's tools list: name, module path), the
 * package-relative path constraint on the module (inside the pack's own tree,
 * no traversal), the callable export's signature (the port-shaped function the
 * module exports)" — is THIS FILE and the host dispatch tests beside it. A
 * pull request body is not a versioned contract; a pack lane reads these cases.
 *
 *   pnpm --filter @cinatra-ai/sdk-extensions test declared-tools
 */
import { describe, expect, it } from "vitest";

import {
  EXTENSION_TOOL_MODULE_EXPORT,
  declaredToolModulePathIssue,
  parseDeclaredTools,
} from "../manifest";

/** A FIXTURE scope, never a real organisation's: this contract names no pack. */
const PACK = "@fixture-scope/fixture-tool-pack";

describe("the field names cinatra.tools is read by", () => {
  it("parses a list of `name` + `module` entries, and reads nothing else", () => {
    expect(
      parseDeclaredTools(
        [{ name: "fixture_tool", module: "./cinatra/tools/fixture-tool.mjs", extra: "ignored" }],
        PACK,
      ),
    ).toEqual([{ name: "fixture_tool", module: "./cinatra/tools/fixture-tool.mjs" }]);
  });

  it("treats an absent list as a package that declares no tool at all", () => {
    expect(parseDeclaredTools(undefined, PACK)).toEqual([]);
    expect(parseDeclaredTools(null, PACK)).toEqual([]);
  });

  it("refuses a list that is not an array", () => {
    expect(() => parseDeclaredTools({ fixture_tool: "./a.mjs" }, PACK)).toThrow(
      /cinatra\.tools must be an array/,
    );
  });

  it("refuses an entry that is not an object", () => {
    expect(() => parseDeclaredTools(["fixture_tool"], PACK)).toThrow(
      /each declared tool must be an object/,
    );
  });

  it("refuses a name outside the local-identifier vocabulary", () => {
    expect(() => parseDeclaredTools([{ name: "Fixture-Tool", module: "./a.mjs" }], PACK)).toThrow(
      /tool name "Fixture-Tool" must match/,
    );
    expect(() => parseDeclaredTools([{ name: "", module: "./a.mjs" }], PACK)).toThrow(
      /must match/,
    );
  });

  it("refuses the same name declared twice — one name resolves to one module", () => {
    expect(() =>
      parseDeclaredTools(
        [
          { name: "fixture_tool", module: "./a.mjs" },
          { name: "fixture_tool", module: "./b.mjs" },
        ],
        PACK,
      ),
    ).toThrow(/tool "fixture_tool" is declared twice/);
  });
});

describe("the package-relative path constraint on the module", () => {
  it("admits a package-relative path to a built artifact", () => {
    expect(declaredToolModulePathIssue("./cinatra/tools/fixture-tool.mjs")).toBeNull();
    expect(declaredToolModulePathIssue("./register.cjs")).toBeNull();
    expect(declaredToolModulePathIssue("./dist/tool.js")).toBeNull();
  });

  it("refuses a parent-directory segment — the module stays inside the pack's own tree", () => {
    expect(declaredToolModulePathIssue("./../outside.mjs")).toMatch(/parent-directory segment/);
    expect(declaredToolModulePathIssue("./cinatra/../../outside.mjs")).toMatch(
      /parent-directory segment/,
    );
    expect(() => parseDeclaredTools([{ name: "escape", module: "./../outside.mjs" }], PACK)).toThrow(
      /parent-directory segment/,
    );
  });

  it("refuses an absolute path", () => {
    expect(declaredToolModulePathIssue("/etc/passwd.mjs")).toMatch(/package-relative/);
    expect(declaredToolModulePathIssue("C:/windows/tool.mjs")).toMatch(/package-relative/);
  });

  it("refuses a path that does not declare itself package-relative", () => {
    expect(declaredToolModulePathIssue("cinatra/tools/fixture-tool.mjs")).toMatch(
      /package-relative/,
    );
  });

  it("refuses a backslash path — the declaration is one vocabulary, not two", () => {
    expect(declaredToolModulePathIssue(".\\cinatra\\tools\\fixture-tool.mjs")).toMatch(
      /forward slashes/,
    );
  });

  it("refuses a source mirror — a declared module is a BUILT artifact", () => {
    expect(declaredToolModulePathIssue("./src/tool.ts")).toMatch(/BUILT artifact/);
    expect(declaredToolModulePathIssue("./tool")).toMatch(/BUILT artifact/);
  });

  it("refuses a blank or missing module", () => {
    expect(declaredToolModulePathIssue(undefined)).toMatch(/non-empty package-relative path/);
    expect(declaredToolModulePathIssue("   ")).toMatch(/non-empty package-relative path/);
    expect(() => parseDeclaredTools([{ name: "fixture_tool" }], PACK)).toThrow(
      /non-empty package-relative path/,
    );
  });
});

describe("the callable export's signature", () => {
  it("names ONE export the host calls, and the pack lane reads the name from here", () => {
    expect(EXTENSION_TOOL_MODULE_EXPORT).toBe("extensionTool");
  });
});
