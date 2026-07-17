// I3 grep-gate (cinatra#1037 P1.3/P1.4): assistant-agent registration is the ONE
// principal-minting path. This is the acceptance's "grep-gate proves no other
// principal-minting caller" — a static source scan (robust to a stray import /
// re-export in a way a bare `grep` count is not: it inventories the referencing
// FILES and pins the allow-set, and asserts the deleted direct-SQL seed is gone).
//
//   * createAssistantUserWithTx — the sole assistant-PRINCIPAL mint primitive —
//     is referenced ONLY by its definition (assistant-users.ts) and its sole
//     caller (assistant-agent-registration.ts). Any new caller fails this gate.
//   * the former direct-SQL seed `ensureBuiltInCinatraAssistant` no longer EXISTS
//     (P1.4 delete-half): no definition, no call — only prose in comments is
//     tolerated (a `(` call/def suffix is not).
//   * the removed manual admin mint action `createAssistantAction` is gone.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const SCAN_ROOTS = [join(REPO_ROOT, "src"), join(REPO_ROOT, "packages")];

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name === "dist" || name === "generated") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out = out.concat(walk(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !full.includes("__tests__")) {
      out.push(full);
    }
  }
  return out;
}

const SOURCE_FILES = SCAN_ROOTS.flatMap(walk);

function filesContaining(pattern: RegExp): string[] {
  return SOURCE_FILES.filter((f) => pattern.test(readFileSync(f, "utf8")));
}

describe("I3 — assistant-agent registration is the only principal-minting path", () => {
  it("finds the source tree (sanity)", () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(100);
  });

  it("createAssistantUserWithTx is referenced ONLY by its definition + its sole caller", () => {
    const referencing = filesContaining(/createAssistantUserWithTx/).map((f) => basename(f)).sort();
    expect(referencing).toEqual(["assistant-agent-registration.ts", "assistant-users.ts"]);
  });

  it("the mint primitive is actually INVOKED from the registration module (not orphaned)", () => {
    const reg = SOURCE_FILES.find((f) => basename(f) === "assistant-agent-registration.ts")!;
    expect(readFileSync(reg, "utf8")).toMatch(/createAssistantUserWithTx\s*\(/);
  });

  it("no residual direct-SQL principal seed — ensureBuiltInCinatraAssistant is neither defined nor called", () => {
    // A `(` suffix distinguishes a definition/call from prose in a comment.
    const offenders = filesContaining(/ensureBuiltInCinatraAssistant\s*\(/).map((f) => basename(f)).sort();
    expect(offenders).toEqual([]);
  });

  it("the manual admin create-assistant action is removed (P1.4)", () => {
    const offenders = filesContaining(/createAssistantAction/).map((f) => basename(f)).sort();
    expect(offenders).toEqual([]);
  });
});
