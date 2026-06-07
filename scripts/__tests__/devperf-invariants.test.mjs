// Dev-perf chokepoint-regression guard.
//
// Why: this guards two specific edges that, if reintroduced, would pull the
// ~800-module backend graph into ~168 authed pages that never use it:
//
//   (A) `packages/google-oauth-connection/src/index.ts` is server-only — the
//       two client re-exports (GoogleOAuthSettingsForm / GoogleOAuthSettingsPanel)
//       must stay dropped so the barrel no longer drags the "use client" form +
//       its @/app/campaigns/actions graph into auth.ts's every-authed-route
//       import chain. A future "tidy up the barrel" PR could silently re-add
//       them and undo the -86% /sign-in win.
//
//   (B) `@cinatra-ai/llm/actor-context` is a leaf subpath alias.
//       Eight server modules import getActorContext / withActorContext via it
//       so they DON'T pull the full barrel (objects-store -> ... -> agents).
//       A contributor "consolidating imports" could repoint any of them back
//       to the bare `@cinatra-ai/llm` barrel and silently regress.
//
//   (C) The three vitest configs that map the bare `@cinatra-ai/llm`
//       alias to a FILE / stub (root + a2a + skills) MUST place the
//       `/actor-context` subpath alias BEFORE the bare alias. `@rollup/plugin-alias`
//       string-match prefix-rewrites `<bare>/<sub>` to `<file>.ts/<sub>` (ENOTDIR
//       at resolve time, or worse: silently bypasses the stub). The fix is the
//       ordering. Undoing it would be a
//       silent test-bypass and would not flip a CI signal until the next
//       relevant test is added — by then the cause is long buried.
//
// Tests are STRUCTURAL (file content invariants), zero runtime cost.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

// ---------------------------------------------------------------------------
// (A) google-oauth-connection barrel must stay server-only
// ---------------------------------------------------------------------------
describe("google-oauth-connection barrel stays server-only", () => {
  const barrelPath = path.join(REPO_ROOT, "packages/google-oauth-connection/src/index.ts");
  const barrel = readFileSync(barrelPath, "utf8");

  it("does not re-export GoogleOAuthSettingsForm (the dropped client re-export)", () => {
    // The two reachable patterns: a direct named re-export, or a typed
    // re-export. Both reintroduce the chokepoint into auth.ts's graph.
    const reexported =
      /\bexport\s*\{[^}]*\bGoogleOAuthSettingsForm\b[^}]*\}\s*from\s*["']\.\/settings-form["']/.test(barrel) ||
      /\bexport\s+\{[^}]*\bGoogleOAuthSettingsForm\b[^}]*\}/.test(barrel);
    expect(reexported, "barrel must not re-export GoogleOAuthSettingsForm — pulls 'use client' graph into every authed page").toBe(false);
  });

  it("does not re-export GoogleOAuthSettingsPanel (the dropped client re-export)", () => {
    const reexported =
      /\bexport\s*\{[^}]*\bGoogleOAuthSettingsPanel\b[^}]*\}\s*from\s*["']\.\/settings-panel["']/.test(barrel) ||
      /\bexport\s+\{[^}]*\bGoogleOAuthSettingsPanel\b[^}]*\}/.test(barrel);
    expect(reexported, "barrel must not re-export GoogleOAuthSettingsPanel — pulls 'use client' graph into every authed page").toBe(false);
  });

  it("does not blanket-re-export from the client modules (`export * from './settings-form'`)", () => {
    // A wildcard re-export would un-do the server-only decoupling even without naming the symbols.
    const wildcard =
      /\bexport\s*\*\s*from\s*["']\.\/settings-form["']/.test(barrel) ||
      /\bexport\s*\*\s*from\s*["']\.\/settings-panel["']/.test(barrel);
    expect(wildcard, "barrel must not `export * from` the client settings modules").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (B) Server modules that ONLY need actor-context must import the subpath, not
// the bare barrel. The eight identified consumers are gated below.
// ---------------------------------------------------------------------------
describe("actor-context consumers use the leaf subpath, not the bare barrel", () => {
  // Each (file, symbols) pair: the file imports ONLY actor-context symbols from
  // the llm package. If a future PR repoints any of these to the bare barrel,
  // the chokepoint regresses (graph re-includes objects-store → agents).
  const CONSUMERS = [
    { file: "src/lib/background-jobs.ts", symbol: "getActorContext|withActorContext" },
    { file: "src/lib/objects-store.ts", symbol: "getActorContext" },
    { file: "src/lib/connectors-scope-guard.ts", symbol: "getActorContextOrThrow" },
    { file: "src/lib/blog/store.ts", symbol: "getActorContext" },
    { file: "src/app/api/a2a/route.ts", symbol: "withActorContext" },
    { file: "src/app/api/agents/passthrough/route.ts", symbol: "withActorContext" },
    { file: "packages/a2a/src/agent-executor.ts", symbol: "getActorContext" },
    { file: "packages/agents/src/mcp/agent-tools-registry.ts", symbol: "getActorContext" },
  ];

  for (const c of CONSUMERS) {
    it(`${c.file} imports actor-context symbol from the /actor-context subpath`, () => {
      const src = readFileSync(path.join(REPO_ROOT, c.file), "utf8");
      // Positive form: the file imports an actor-context symbol via the subpath.
      const subpathImport = new RegExp(
        String.raw`import\s+\{[^}]*\b(?:${c.symbol})\b[^}]*\}\s+from\s+["']@cinatra-ai/llm/actor-context["']`,
      );
      expect(subpathImport.test(src), `expected '${c.file}' to import (${c.symbol}) from '@cinatra-ai/llm/actor-context'`).toBe(true);
      // Negative form: the file MUST NOT import the same symbol from the bare barrel.
      const bareImport = new RegExp(
        String.raw`import\s+\{[^}]*\b(?:${c.symbol})\b[^}]*\}\s+from\s+["']@cinatra-ai/llm["']`,
      );
      expect(bareImport.test(src), `'${c.file}' must not import (${c.symbol}) from the bare '@cinatra-ai/llm' barrel — re-introduces the import chokepoint`).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// (C) Vitest alias ordering — subpath BEFORE bare when bare maps to a file/stub
// ---------------------------------------------------------------------------
// Returns indices of the FIRST occurrence of the two alias keys in the file,
// or -1 if not present.
function aliasIndices(src) {
  // The key is a string literal — either as a `find:` property OR as a plain
  // object-literal key. Both forms exist across the three configs.
  const subRe = /["'`]@cinatra-ai\/llm\/actor-context["'`]/;
  const bareRe = /["'`]@cinatra-ai\/llm["'`]/g;
  const subM = src.match(subRe);
  const subIdx = subM ? src.indexOf(subM[0]) : -1;
  let bareIdx = -1;
  let m;
  while ((m = bareRe.exec(src)) !== null) {
    // Skip occurrences that are actually the longer `/actor-context` form
    // (the bare regex matches both because the longer one starts the same).
    const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 16);
    if (tail.startsWith("/actor-context") || src.slice(m.index - 1, m.index) === "/") continue;
    // Verify this is followed by a quote terminator (not a path continuation
    // like `/foo`). The match itself includes the closing quote, so any
    // immediately-following `/x` would be a separate token. We're safe.
    bareIdx = m.index;
    break;
  }
  return { subIdx, bareIdx };
}

describe("vitest alias ordering: subpath BEFORE bare", () => {
  const CONFIGS = [
    "vitest.config.ts",
    "packages/a2a/vitest.config.ts",
    "packages/skills/vitest.config.ts",
  ];

  for (const rel of CONFIGS) {
    it(`${rel} declares the /actor-context subpath alias before the bare alias`, () => {
      const src = readFileSync(path.join(REPO_ROOT, rel), "utf8");
      const { subIdx, bareIdx } = aliasIndices(src);
      // Both must be present in every gated config — they all map the bare
      // alias to a FILE / stub and so are exposed to the prefix-match trap.
      expect(subIdx, `${rel} is missing the '@cinatra-ai/llm/actor-context' alias`).toBeGreaterThan(-1);
      expect(bareIdx, `${rel} is missing the bare '@cinatra-ai/llm' alias`).toBeGreaterThan(-1);
      // The subpath alias must precede the bare alias textually. @rollup/plugin-alias
      // (Vite/Vitest's alias resolver) iterates string aliases in declaration
      // order and prefix-matches; reversing the order would silently rewrite
      // `@cinatra-ai/llm/actor-context` to `<file>.ts/actor-context`.
      expect(subIdx, `${rel} has the bare alias BEFORE the subpath alias — silent prefix-match regression`).toBeLessThan(bareIdx);
    });
  }
});
