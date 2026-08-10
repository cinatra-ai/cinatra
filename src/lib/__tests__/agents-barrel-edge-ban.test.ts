/**
 * cinatra#2656 — EDGE BAN for the import cinatra#2639 cut.
 *
 * ## The edge (verified from the #2639 diff, not guessed)
 *
 * `src/lib/assistant-agent-registration.ts` needed five symbols
 * (`upsertBuiltInAssistantAgentTemplate`, the two WordPress and two Drupal
 * built-in assistant template/package constants) and reached them through the
 * `@cinatra-ai/agents` PACKAGE BARREL. #2639 replaced that one specifier with
 * the narrow public subpath `@cinatra-ai/agents/builtin-assistant-template`,
 * which resolves to the leaf those five symbols are actually defined in.
 *
 * Why one specifier mattered: `@/lib/auth` imports this module, `@/lib/auth-session`
 * imports `@/lib/auth`, and 79 of the repository's 191 app routes import
 * `auth-session` directly. So the barrel put the whole agents ↔ skills ↔ a2a ↔
 * extensions import cycle into the compiled module graph of every route that
 * merely read the session. Cutting it dropped the summed per-route reachable
 * module count 20.4% and detached 41 routes from the shared 1222-module set.
 *
 * ## HONEST SCOPE — what is and is NOT guarded
 *
 * Two locks were added for #2639, and NEITHER tracks the 41 detached routes
 * individually. There is no per-route guard for them and this file does not
 * claim one:
 *
 *  - The route-graph ratchet (`scripts/audit/route-graph-ratchet.baseline.json`)
 *    guards the FIVE LOCKED `FIXED_ROUTES` ONLY — /sign-in, /api/mcp, /chat,
 *    /api/a2a, /api/llm-bridge. #2639's reduction reached exactly one of them:
 *    /sign-in fell 1693 -> 216 modules. The other four reach the agents subsystem
 *    through their own legitimate edges and were unchanged by the cut.
 *  - THIS FILE guards the CUT EDGE itself — the one specifier, in the one
 *    consumer, plus a coarse tripwire that the consumer has not re-attached to
 *    the blob some other way.
 *
 * The 41 routes stay detached because they inherit this edge's absence through
 * `auth-session`, NOT because anything measures them. A different route could
 * re-attach to the 1222-module set through an unrelated import and nothing here
 * or in the ratchet would notice.
 *
 * ## Why a structural test rather than a compile error
 *
 * Re-adding the barrel import typechecks perfectly — the barrel still re-exports
 * all five symbols (`index.ts` -> `./store` -> this leaf), deliberately, so
 * every other `@cinatra-ai/agents` importer keeps resolving. Nothing but an
 * explicit check can notice the regression.
 *
 * COMMENTS ARE STRIPPED BEFORE MATCHING (via the audit gates' shared lexical
 * stripper): the consumer documents this very ban in prose that names the banned
 * specifier, and that prose must not read as a violation. String literals are
 * deliberately KEPT so a dynamic `import("@cinatra-ai/agents")` or a
 * `require(...)` is still caught.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { analyzeRoute } from "../../../scripts/route-graph.mjs";
import { stripComments } from "../../../scripts/audit/lib/strip-comments.mjs";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/** The consumer #2639 changed. */
const CONSUMER = "src/lib/assistant-agent-registration.ts";
/** The barrel specifier #2639 REMOVED from that consumer. */
const BANNED_SPECIFIER = "@cinatra-ai/agents";
/** The narrow public subpath #2639 put in its place. */
const REQUIRED_SPECIFIER = "@cinatra-ai/agents/builtin-assistant-template";

/**
 * #2639 measured its effect in buckets of "routes with a >400-module first-party
 * graph" (161 -> 120). We reuse that published boundary as a coarse tripwire for
 * the consumer itself, which measures 55 modules today: staying OUT of that
 * bucket means at most 400. It is NOT a ratchet and carries deliberate slack —
 * it exists to catch a TRANSITIVE re-attachment (the consumer importing some
 * sibling that imports the barrel) that a specifier ban alone cannot see.
 * Re-adding the barrel takes this module to 1688.
 */
const DETACHED_CEILING = 400;

/**
 * Every module specifier the file names, in any edge-creating form:
 * `import … from "x"`, a bare `import "x"`, `export … from "x"`,
 * `import("x")` and `require("x")`. Backticks are accepted too, so a
 * no-substitution `import(`@cinatra-ai/agents`)` cannot slip the ban.
 *
 * Deliberately lexical, not AST-aware, and it scans comment-stripped source
 * with STRING LITERALS PRESERVED. That biases toward OVER-detection: a runtime
 * string that happens to spell an import of the banned specifier would trip
 * this. For a ban that is the safe direction, and no such string exists here.
 */
function moduleSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`]([^"'`]+)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) specifiers.push(m[1]);
  return specifiers;
}

function consumerSpecifiers(): string[] {
  return moduleSpecifiers(
    stripComments(readFileSync(join(REPO_ROOT, CONSUMER), "utf8")),
  );
}

describe("agents-barrel edge ban (#2656, locking in #2639)", () => {
  it(`${CONSUMER} does not import the ${BANNED_SPECIFIER} barrel in any form`, () => {
    // EXACT match: the ban is on the bare barrel. The subpath below shares the
    // prefix and is the REQUIRED replacement, so a prefix test would be wrong.
    const offenders = consumerSpecifiers().filter(
      (s) => s === BANNED_SPECIFIER,
    );
    expect(offenders).toEqual([]);
  });

  it(`${CONSUMER} reaches the built-in assistant template through ${REQUIRED_SPECIFIER}`, () => {
    // The positive anchor: without it the ban above is vacuously satisfiable by
    // deleting the import and reaching the symbols some other way.
    expect(consumerSpecifiers()).toContain(REQUIRED_SPECIFIER);
  });

  it(`${CONSUMER} stays detached from the shared module blob`, () => {
    const result = analyzeRoute(CONSUMER);
    expect(result.ok).toBe(true);
    // A deflated graph would make the ceiling below meaningless.
    expect(result.missingCount).toBe(0);
    expect(result.moduleCount).toBeLessThanOrEqual(DETACHED_CEILING);
  });
});
