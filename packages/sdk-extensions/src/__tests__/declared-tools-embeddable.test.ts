/**
 * A CHILD'S CONSENT TO AN EMBEDDING PARENT, PER TOOL (cinatra#4154).
 *
 * An agent may embed another agent's flow. A step of that embedded flow may
 * reach a tool of the embedded (child) package only when the child's own
 * declaration of that tool says `embeddable: true`. The flag is the child's,
 * written in its own manifest; a dependency alone grants the parent nothing.
 *
 * Only the entry's OWN data property declares: an absent or inherited key is
 * not consent and is never read, an own `true` or `false` is kept, and an own
 * getter, an own `undefined` or any other own value refuses the whole list with
 * the existing `[declared-tools]` error, so a child whose declaration does not
 * parse reaches nothing. Unknown keys are still ignored.
 *
 *   pnpm --filter @cinatra-ai/sdk-extensions exec vitest run src/__tests__/declared-tools-embeddable.test.ts
 */
import { describe, expect, it } from "vitest";

import { declaredToolIsEmbeddable, parseDeclaredTools } from "../manifest";

/** A FIXTURE scope, never a real organisation's: this contract names no pack. */
const PACK = "@fixture-scope/fixture-tool-pack";
const MODULE = "./cinatra/tools/fixture-tool.mjs";

describe("cinatra.tools[].embeddable", () => {
  it("an absent key parses to the same entry as before and is not consent", () => {
    const [tool] = parseDeclaredTools([{ name: "fixture_tool", module: MODULE }], PACK);
    expect(tool).toEqual({ name: "fixture_tool", module: MODULE });
    expect(tool!.embeddable).toBeUndefined();
    expect(declaredToolIsEmbeddable(tool!)).toBe(false);
  });

  it("`true` is kept and is consent", () => {
    const [tool] = parseDeclaredTools(
      [{ name: "fixture_tool", module: MODULE, embeddable: true }],
      PACK,
    );
    expect(tool).toEqual({ name: "fixture_tool", module: MODULE, embeddable: true });
    expect(declaredToolIsEmbeddable(tool!)).toBe(true);
  });

  it("`false` is kept and is not consent", () => {
    const [tool] = parseDeclaredTools(
      [{ name: "fixture_tool", module: MODULE, embeddable: false }],
      PACK,
    );
    expect(tool).toEqual({ name: "fixture_tool", module: MODULE, embeddable: false });
    expect(declaredToolIsEmbeddable(tool!)).toBe(false);
  });

  it.each([
    ["the string \"true\"", "true"],
    ["the number 1", 1],
    ["null", null],
    ["an object", { value: true }],
    ["`undefined` set as the entry's own key", undefined],
  ])("%s refuses the whole list with the declared-tools error", (_label, value) => {
    expect(() =>
      parseDeclaredTools(
        [
          { name: "other_tool", module: "./cinatra/tools/other-tool.mjs" },
          { name: "fixture_tool", module: MODULE, embeddable: value },
        ],
        PACK,
      ),
    ).toThrow(/^\[declared-tools\] @fixture-scope\/fixture-tool-pack tool "fixture_tool": embeddable must be true or false$/);
  });

  it("the refusal does not repeat the declared value", () => {
    let message = "";
    try {
      parseDeclaredTools(
        [{ name: "fixture_tool", module: MODULE, embeddable: "/fixture/secret/path" }],
        PACK,
      );
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/embeddable must be true or false/);
    expect(message).not.toContain("/fixture/secret/path");
  });

  it("an inherited key is no declaration: it is never read and is not consent", () => {
    let read = false;
    const throwingProto = {
      get embeddable(): boolean {
        read = true;
        throw new Error("/fixture/secret/path");
      },
    };
    const tools = parseDeclaredTools(
      [
        Object.assign(Object.create({ embeddable: true }), { name: "fixture_tool", module: MODULE }),
        Object.assign(Object.create(throwingProto), { name: "other_tool", module: "./cinatra/tools/other-tool.mjs" }),
      ],
      PACK,
    );
    expect(tools).toEqual([
      { name: "fixture_tool", module: MODULE },
      { name: "other_tool", module: "./cinatra/tools/other-tool.mjs" },
    ]);
    expect(tools.map((tool) => Object.hasOwn(tool, "embeddable"))).toEqual([false, false]);
    expect(tools.map(declaredToolIsEmbeddable)).toEqual([false, false]);
    expect(read).toBe(false);
  });

  it("an own getter refuses the whole list and is never called", () => {
    let read = false;
    const entry = {
      name: "fixture_tool",
      module: MODULE,
      get embeddable(): boolean {
        read = true;
        return true;
      },
    };
    expect(() => parseDeclaredTools([entry], PACK)).toThrow(
      /^\[declared-tools\] @fixture-scope\/fixture-tool-pack tool "fixture_tool": embeddable must be true or false$/,
    );
    expect(read).toBe(false);
  });

  it("other unknown keys are still ignored beside the flag", () => {
    expect(
      parseDeclaredTools(
        [{ name: "fixture_tool", module: MODULE, embeddable: true, extra: "ignored" }],
        PACK,
      ),
    ).toEqual([{ name: "fixture_tool", module: MODULE, embeddable: true }]);
  });

  it("reads consent as `true` only, never as a truthy value", () => {
    expect(declaredToolIsEmbeddable({ name: "fixture_tool", module: MODULE })).toBe(false);
    expect(
      declaredToolIsEmbeddable({ name: "fixture_tool", module: MODULE, embeddable: false }),
    ).toBe(false);
    expect(
      declaredToolIsEmbeddable({
        name: "fixture_tool",
        module: MODULE,
        embeddable: "yes" as unknown as boolean,
      }),
    ).toBe(false);
    expect(
      declaredToolIsEmbeddable({ name: "fixture_tool", module: MODULE, embeddable: true }),
    ).toBe(true);
  });

  it("the helper reads only the tool's own data property, never an inherited key or a getter", () => {
    let read = false;
    const inherited = Object.assign(Object.create({ embeddable: true }), { name: "fixture_tool", module: MODULE });
    const getter = {
      name: "fixture_tool",
      module: MODULE,
      get embeddable(): boolean {
        read = true;
        return true;
      },
    };
    expect(declaredToolIsEmbeddable(inherited)).toBe(false);
    expect(declaredToolIsEmbeddable(getter)).toBe(false);
    expect(read).toBe(false);
  });
});
