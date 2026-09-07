// THE ANCHOR IS IMMUTABLE, PROVED ON THE WRITERS (cinatra#2809, S3).
//
// The issue's sentence: "The IMMUTABLE `launch_scope_anchor` lives on
// `agent_runs` and `assistant_threads`, stamped from the exact launch route".
//
// WHY THIS GUARANTEE IS PINNED ON THE SOURCE. `assertLaunchScopeAnchorNotMutated`
// existed but nothing called it, and nothing could: the guard lives in the
// host's `src/lib` while the writers live in the store, which four LOCKED
// route graphs reach -- importing it there would add a module to every one of
// them, and their counts may only ever shrink. So the guarantee is enforced
// the way the three DDL copies are: on the SOURCE of the writers themselves.
// An update path that learned to write the column fails this suite.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertLaunchScopeAnchorNotMutated } from "@/lib/launch-scope-anchor";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const WRITERS = [
  "packages/agents/src/store.ts",
  "src/lib/drizzle-store.ts",
  "src/lib/assistant-thread-schema.ts",
];

const COLUMN = ["launchScopeAnchor", "launch_scope_anchor"];

/** Every `.set(` argument in a source, as text: the UPDATE payloads. */
function updatePayloads(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const at = source.indexOf(".set(", i);
    if (at === -1) break;
    let depth = 0;
    let j = at + ".set(".length - 1;
    for (; j < source.length; j++) {
      const ch = source[j];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(source.slice(at, j + 1));
    i = j + 1;
  }
  return out;
}

describe("no update path writes the anchor", () => {
  it("finds the update payloads it is meant to be reading", () => {
    expect(updatePayloads(read("packages/agents/src/store.ts")).length).toBeGreaterThan(10);
  });

  for (const rel of WRITERS) {
    it(`${rel} carries the column in no SET list`, () => {
      for (const payload of updatePayloads(read(rel))) {
        for (const token of COLUMN) {
          expect(payload.includes(token), `${rel}: an update SET writes ${token}`).toBe(false);
        }
      }
    });
  }

  it("no writer runs an UPDATE statement over the column in raw SQL either", () => {
    for (const rel of WRITERS) {
      const source = read(rel);
      expect(/update[\s\S]{0,400}?set[\s\S]{0,200}?launch_scope_anchor/i.test(source)).toBe(false);
    }
  });
});

describe("the column IS stamped where a row is created", () => {
  it("both agent-run creation paths stamp it from the launch input", () => {
    const source = read("packages/agents/src/store.ts");
    const stamps = source.split("launchScopeAnchor: input.launchScopeAnchor ?? null").length - 1;
    expect(stamps).toBe(2);
  });
});

describe("the guard refuses both spellings", () => {
  it("throws on a patch that carries either", () => {
    for (const token of COLUMN) {
      expect(() => assertLaunchScopeAnchorNotMutated({ [token]: "anything" })).toThrow();
      expect(() => assertLaunchScopeAnchorNotMutated({ [token]: null })).toThrow();
    }
  });

  it("lets an ordinary patch through", () => {
    expect(() => assertLaunchScopeAnchorNotMutated({ title: "fine", status: "done" })).not.toThrow();
  });
});
