// A "use server" module may export async functions — and nothing else
// (cinatra#2683).
//
// WHY THIS IS A TEST AND NOT A STYLE NOTE. `pending-call-actions.ts` re-exported
// a TYPE (`export type { PendingToolConfirmationRow }`) after its implementation
// moved to the shared surface. TypeScript erases that, and every unit test in
// this package kept passing — but the bundler's server-actions loader enumerates
// a "use server" module's exports from the export list it sees BEFORE erasure and
// registers each as a server reference. The type became a value binding nothing
// defines, the actions module for `/chat` failed to evaluate with
// `ReferenceError: PendingToolConfirmationRow is not defined`, and EVERY server
// action on the page answered 500: send a message, rename a thread, delete a
// thread, decide a parked tool call. The page was unusable and no test noticed.
//
// So the guard has to read the SOURCE, which is the only place the distinction
// still exists at the moment it matters.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC_DIR = path.resolve(__dirname, "..");

/** Every `.ts`/`.tsx` module in this package's src root (tests excluded). */
function packageSourceFiles(): string[] {
  return readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => path.join(SRC_DIR, e.name));
}

/** The directive must be the module's first statement to take effect. */
function isUseServerModule(source: string): boolean {
  // Leading trivia is stripped iteratively — a single regex over the comment
  // run backtracks catastrophically on long non-matching preambles (js/redos).
  let s = source;
  for (;;) {
    const trimmed = s.replace(/^[\t\n\r ]+/, "");
    if (trimmed.startsWith("//")) {
      const nl = trimmed.indexOf("\n");
      if (nl === -1) return false;
      s = trimmed.slice(nl + 1);
    } else if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      if (end === -1) return false;
      s = trimmed.slice(end + 2);
    } else {
      s = trimmed;
      break;
    }
  }
  return /^["']use server["'];/.test(s);
}

/**
 * The RE-EXPORT spellings, which are the ones that bite:
 *   `export type { X };`   — X is an imported binding this module must resolve
 *   `export { type X };`   — the same, spelled inline in a value export
 *
 * SCOPE, and why it is exactly this. A LOCALLY DECLARED `export type X = …`
 * is erased together with its declaration, so the loader has no binding left to
 * resolve and nothing breaks — `actions.ts` has shipped several of those since
 * long before this guard, and flagging them would be a false alarm this test
 * would teach people to silence. A re-export is different in kind: the name
 * survives in the export list with nothing behind it.
 */
const TYPE_REEXPORT_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "export type { … }", re: /^\s*export\s+type\s*\{/m },
  { label: "export { type X }", re: /^\s*export\s*\{[^}]*\btype\s+[A-Za-z_$]/m },
];

describe('"use server" modules re-export no types', () => {
  const files = packageSourceFiles();

  it("finds the package's server-action modules at all (guard is not vacuous)", () => {
    const serverModules = files.filter((f) => isUseServerModule(readFileSync(f, "utf8")));
    expect(serverModules.length).toBeGreaterThan(0);
  });

  it("no server-action module re-exports a type", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (!isUseServerModule(source)) continue;
      for (const { label, re } of TYPE_REEXPORT_PATTERNS) {
        if (re.test(source)) offenders.push(`${path.basename(file)}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
