/**
 * THE INVENTORY GATE (cinatra#2093, epic #2086 S6 AC3):
 * "No call site resolves an implicit default without an assigned policy."
 *
 * A hand-maintained list would rot within a release. This test therefore
 * MECHANICALLY re-derives the set of implicit-default resolution sites by
 * scanning the first-party source tree, and cross-checks it against
 * `LLM_PURPOSE_INVENTORY` in BOTH directions:
 *
 *   scan → inventory : a NEW implicit-default call site with no inventory entry
 *                      fails. This is the gate the AC asks for — you cannot add
 *                      one silently.
 *   inventory → scan : an entry whose file no longer carries the site it claims
 *                      fails, so the inventory cannot describe code that moved
 *                      or was deleted.
 *
 * WHAT COUNTS AS AN IMPLICIT DEFAULT: a call to one of the resolvers below that
 * does NOT name a provider. `resolveConfiguredLlmRuntime({preferredProviders})`
 * and `runDeterministicLlmTask({provider})` are EXPLICIT and are deliberately
 * not flagged — the explicit-pin entries are recorded in the inventory for
 * review, but the gate's job is the implicit ones.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  LLM_PURPOSE_INVENTORY,
  purposesWithPolicy,
  describeMatcherProviderConstraint,
  pinnedProviderForPurpose,
} from "@/lib/llm-purpose-policy";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/** Trees scanned for implicit-default resolution. First-party source only. */
const SCAN_ROOTS = [
  "src",
  "packages/agents/src",
  "packages/chat/src",
  "packages/objects/src",
  "packages/skills/src",
];

/**
 * The resolver names that, called WITHOUT a provider argument, take the
 * operator's stored default. `packages/llm/src` itself is deliberately NOT
 * scanned: it DEFINES these resolvers, so every occurrence there is the
 * implementation rather than a consumer taking a policy decision.
 */
const IMPLICIT_RESOLVERS = [
  "resolveConfiguredLlmRuntime",
  "resolveDefaultAdapter",
  "resolveBoundDefaultAdapter",
  "resolveFirstAvailableAdapter",
  "resolveDefaultImageAdapter",
  "hasConfiguredLlmRuntime",
  // cinatra#2094 F10 — the provider-NAMING counterpart of `hasConfiguredLlmRuntime`.
  // It walks the SAME implicit order (resolveImplicitGlobalProviderOrder) and is
  // what the pre-stream availability guards call, so leaving it off this list
  // would let a call site take the operator's stored-default decision with NO
  // inventory entry — i.e. silently shrink this gate's coverage.
  "describeLlmRuntimeUnavailability",
  "runDeterministicLlmTask",
] as const;

const SOURCE_EXT = new Set([".ts", ".tsx"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "generated") continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Tests and fixtures describe behaviour; they do not take policy
      // decisions for the running product.
      if (entry === "__tests__" || entry === "__fixtures__" || entry === "tests") continue;
      walk(full, out);
    } else if (SOURCE_EXT.has(path.extname(entry)) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract the argument text of the call that starts at `openParenIdx`, by
 * balanced-paren scan. Good enough for the shapes in this codebase (object
 * literals and identifiers) and far more honest than a line regex, which would
 * miss every multi-line call — i.e. most of them.
 */
function callArgs(src: string, openParenIdx: number): string {
  let depth = 0;
  for (let i = openParenIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(openParenIdx + 1, i);
    }
  }
  return "";
}

type Site = { file: string; resolver: string };

/** Does this call name a provider explicitly? */
function namesProvider(args: string): boolean {
  // `preferredProviders:` / `provider:` at any nesting inside the single
  // argument object. A false POSITIVE here would under-report a site, so the
  // patterns are deliberately narrow (a bare mention of the word "provider" in
  // a comment does not match — the colon is required).
  return /\bpreferredProviders\s*:/.test(args) || /\bprovider\s*:/.test(args);
}

function scanImplicitDefaultSites(): Site[] {
  const sites: Site[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(path.join(REPO_ROOT, root))) {
      const src = readFileSync(file, "utf8");
      for (const resolver of IMPLICIT_RESOLVERS) {
        // Match CALLS only (`name(`), not imports/re-exports/type positions.
        const re = new RegExp(`(?<![\\w.$])${resolver}\\s*\\(`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) {
          const openParen = m.index + m[0].length - 1;
          const args = callArgs(src, openParen);
          // A call forwarding a caller-supplied preference list (the shape
          // `hasConfiguredLlmRuntime(preferredProviders)`) is a pass-through,
          // not a policy decision by this file.
          if (namesProvider(args)) continue;
          if (/^\s*preferredProviders\s*$/.test(args)) continue;
          sites.push({ file: path.relative(REPO_ROOT, file), resolver });
        }
      }
    }
  }
  return sites;
}

describe("LLM purpose-policy inventory — the gate (cinatra#2093 AC3)", () => {
  const sites = scanImplicitDefaultSites();
  const inventoryFiles = new Set(LLM_PURPOSE_INVENTORY.map((e) => e.file));

  it("the scanner actually finds implicit-default resolution sites (guards against a silently-broken gate)", () => {
    // A gate that scans nothing passes vacuously forever. Pin a floor.
    expect(sites.length).toBeGreaterThanOrEqual(8);
  });

  it("EVERY implicit-default resolution site has an assigned purpose policy", () => {
    const unregistered = sites
      .filter((s) => !inventoryFiles.has(s.file))
      .map((s) => `${s.file} (${s.resolver})`);
    expect(
      unregistered,
      "These files resolve an implicit LLM default with no entry in LLM_PURPOSE_INVENTORY. " +
        "Add an entry naming the purpose and its policy (see src/lib/llm-purpose-policy.ts), " +
        "or pass an explicit provider if the site should not follow the operator's stored choice.",
    ).toEqual([]);
  });

  it("no inventory entry is STALE — every entry's file still exists and still carries its site", () => {
    const stale: string[] = [];
    for (const entry of LLM_PURPOSE_INVENTORY) {
      const full = path.join(REPO_ROOT, entry.file);
      let src: string;
      try {
        src = readFileSync(full, "utf8");
      } catch {
        stale.push(`${entry.purpose}: file missing (${entry.file})`);
        continue;
      }
      const mentionsAResolver = IMPLICIT_RESOLVERS.some((r) => src.includes(r));
      // An explicit-pin entry proves itself by naming a provider rather than by
      // calling an implicit resolver.
      const mentionsAPin = /\bpreferredProvider\b|\bprovider\s*:\s*"(openai|anthropic|gemini)"/.test(src);
      if (!mentionsAResolver && !mentionsAPin) {
        stale.push(`${entry.purpose}: ${entry.file} no longer resolves a provider at all`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("every purpose id is unique", () => {
    const ids = LLM_PURPOSE_INVENTORY.map((e) => e.purpose);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry carries a non-trivial rationale", () => {
    for (const entry of LLM_PURPOSE_INVENTORY) {
      expect(entry.rationale.length, `${entry.purpose} rationale`).toBeGreaterThan(30);
    }
  });

  it("every explicit-pin names the provider it pins (except the agent-declared pass-through)", () => {
    for (const entry of purposesWithPolicy("explicit-pin")) {
      if (entry.purpose === "agent-preferred-provider") continue; // pin comes from the agent, not from us
      expect(entry.pinnedProvider, `${entry.purpose} must name its pinned provider`).toBeTruthy();
    }
  });

  it("all four policies are represented (the inventory is a real classification, not a rubber stamp)", () => {
    expect(purposesWithPolicy("exact-default").length).toBeGreaterThan(0);
    expect(purposesWithPolicy("explicit-pin").length).toBeGreaterThan(0);
    expect(purposesWithPolicy("separate-default").length).toBeGreaterThan(0);
    expect(purposesWithPolicy("unavailable-without-provider").length).toBeGreaterThan(0);
  });
});

describe("the matcher constraint is surfaced honestly (cinatra#2093 AC3)", () => {
  it("skill auto-matching is pinned to OpenAI", () => {
    expect(pinnedProviderForPurpose("skill-llm-matching")).toBe("openai");
  });

  it("says nothing when the stored provider already satisfies the pin", () => {
    expect(describeMatcherProviderConstraint("openai")).toBeNull();
  });

  it("states the constraint plainly on a non-OpenAI default, without overstating the impact", () => {
    const msg = describeMatcherProviderConstraint("anthropic");
    expect(msg).toContain("Skill auto-matching requires OpenAI");
    // Honesty: it must say what still WORKS, not just what does not.
    expect(msg).toContain("runs on Anthropic");
    expect(msg).toContain("manually");
  });

  it("covers a Gemini default too", () => {
    expect(describeMatcherProviderConstraint("gemini")).toContain("Skill auto-matching requires OpenAI");
  });
});
