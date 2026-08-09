/**
 * cinatra#2578 — the usage ledger's choke point stays a choke point.
 *
 * The defect this guards against is not a wrong number, it is a MISSING ROW.
 * `/analytics/llm` sums `cinatra.usage_events`, and before this change every row
 * came from a hand-written emit sitting next to an adapter call. A new code path
 * that reached a provider some other way was billed and invisible, and nothing
 * failed — the ledger under-reported real OpenAI spend by roughly 10x.
 *
 * The invariants below are what make the ledger structural instead of a
 * convention, so they are asserted over the SOURCE rather than over behaviour
 * (a behavioural test can only cover the paths someone remembered to write):
 *
 *   1. NO MODULE MINTS AN UNMETERED ADAPTER. `createAdapter()` — a connector's
 *      adapter factory — may be called from exactly one file, the registry that
 *      wraps its result in the metering proxy. Any other caller would hold a
 *      raw adapter and its spend would vanish.
 *   2. NO MODULE TALKS TO A PROVIDER'S INFERENCE API DIRECTLY, except the files
 *      registered below with a stated reason.
 *   3. THE METERING OPT-OUT STAYS RARE. `withCallerEmittedUsage` silences the
 *      proxy; only the registered files may use it, and each says why.
 *
 * KNOWN OPEN PATHS are registered too, with the issue that owns them, so this
 * file is an honest inventory rather than a claim of completeness. Graphiti's
 * per-episode OpenAI fan-out is uncounted and is DEFERRED pending the owner's
 * analysis — see cinatra#2582. It is recorded here, not fixed here.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** Runtime source trees. Test files and fixtures are excluded (see `isScanned`). */
const SCANNED_ROOTS = ["src", "packages"];

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "__tests__",
  "__mocks__",
  "__stubs__",
  "__helpers__",
  "tests",
  "dist",
  "build",
  ".next",
  "generated",
]);

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function isScanned(filePath: string): boolean {
  if (!SCANNED_EXTENSIONS.has(path.extname(filePath))) return false;
  const base = path.basename(filePath);
  return !base.includes(".test.") && !base.includes(".spec.");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (isScanned(full)) out.push(full);
  }
  return out;
}

const SOURCE_FILES: Array<{ rel: string; text: string }> = SCANNED_ROOTS.flatMap(
  (root) => walk(path.join(REPO_ROOT, root)),
).map((full) => ({
  rel: path.relative(REPO_ROOT, full).split(path.sep).join("/"),
  text: readFileSync(full, "utf8"),
}));

function filesMatching(pattern: RegExp): string[] {
  return SOURCE_FILES.filter((file) => pattern.test(file.text))
    .map((file) => file.rel)
    .sort();
}

// ---------------------------------------------------------------------------
// Registered exceptions — each carries the reason it is allowed to exist.
// ---------------------------------------------------------------------------

type Registered = { file: string; why: string; knownOpenIssue?: number };

/** The ONE file permitted to call a connector's adapter factory. */
const ADAPTER_MINT_POINT = "packages/llm/src/registry.ts";

/** Files permitted to reach a provider API without going through an adapter. */
const DIRECT_PROVIDER_CALLERS: Registered[] = [
  {
    file: "src/app/configuration/mcp/llm-access/test/route.ts",
    why:
      "Admin MCP-access probe. Hand-rolled fetch predates the adapter seam; it is " +
      "INSTRUMENTED — every probe emits an operation:\"validate\" row (cinatra#2578).",
  },
  {
    file: "packages/llm/src/tools/anthropic-custom-skills-client.ts",
    why:
      "Anthropic Custom Skills MANAGEMENT API (skill CRUD / upload). No inference, " +
      "no tokens, nothing to meter.",
  },
];

/** Files permitted to silence the metering proxy because they emit their own row. */
const CALLER_EMITTED_USAGE_SITES: Registered[] = [
  {
    file: "src/app/api/llm-bridge/route.ts",
    why:
      "Media branch emits a RICHER row than the transport seam can build — it knows " +
      "the dispatch's requested/effective provider and the calling agent id.",
  },
];

/**
 * Paths that reach a provider and are still NOT in the ledger. Recorded, not
 * hidden: each names the issue that owns it.
 */
const KNOWN_OPEN_PATHS: Registered[] = [
  {
    file: "packages/objects/src/graphiti-client.ts",
    why:
      "Graphiti runs in its own container on its own key and fans out many OpenAI " +
      "calls per episode (extraction, dedup, summaries, embeddings). None reach " +
      "usage_events. DEFERRED pending the owner's analysis — not touched by this change.",
    knownOpenIssue: 2582,
  },
];

const registeredFiles = (entries: Registered[]) =>
  entries.map((entry) => entry.file).sort();

describe("the adapter mint point is the only place an adapter is created", () => {
  it("only the registry calls a connector's createAdapter()", () => {
    // `resolveProviderAdapter` wraps what this returns in the metering proxy.
    // A second caller would hold a RAW adapter and its spend would not be counted.
    //
    // Matches an INVOCATION (`surface.createAdapter()`) or a destructuring that
    // detaches the factory (`const { createAdapter } = surface`) — not the ABI's
    // own member DECLARATION in the SDK contract, which is a type, not a call.
    const INVOKES_ADAPTER_FACTORY = /\.createAdapter\s*\(|createAdapter\s*[,}][^=]*}\s*=/;
    expect(filesMatching(INVOKES_ADAPTER_FACTORY)).toEqual([ADAPTER_MINT_POINT]);
  });

  it("the registry actually applies the metering wrapper", () => {
    const registry = SOURCE_FILES.find((file) => file.rel === ADAPTER_MINT_POINT);
    expect(registry).toBeDefined();
    expect(registry!.text).toContain("meterLlmProviderAdapter");
  });
});

describe("no module reaches a provider inference API outside the seam", () => {
  it("direct provider-host callers are exactly the registered ones", () => {
    const PROVIDER_HOSTS =
      /https:\/\/api\.openai\.com|https:\/\/api\.anthropic\.com|https:\/\/generativelanguage\.googleapis\.com/;
    expect(filesMatching(PROVIDER_HOSTS)).toEqual(
      registeredFiles(DIRECT_PROVIDER_CALLERS),
    );
  });

  it("the admin probe registered above really does emit usage", () => {
    const probe = SOURCE_FILES.find(
      (file) => file.rel === "src/app/configuration/mcp/llm-access/test/route.ts",
    );
    expect(probe).toBeDefined();
    expect(probe!.text).toContain("emitLlmUsage");
    // All three provider round trips in that route are recorded.
    expect(probe!.text.match(/recordProbeUsage\(\{/g) ?? []).toHaveLength(3);
  });

  it("every registered exception states a reason", () => {
    for (const entry of DIRECT_PROVIDER_CALLERS) {
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });
});

describe("the metering opt-out stays rare and deliberate", () => {
  it("only the registered files silence the metering proxy", () => {
    expect(filesMatching(/withCallerEmittedUsage/)).toEqual(
      [
        // The seam that defines it.
        "packages/llm/src/index.ts",
        "packages/llm/src/usage-metering.ts",
        ...registeredFiles(CALLER_EMITTED_USAGE_SITES),
      ].sort(),
    );
  });

  it("a caller that opts out still emits its own usage event", () => {
    for (const entry of CALLER_EMITTED_USAGE_SITES) {
      const file = SOURCE_FILES.find((candidate) => candidate.rel === entry.file);
      expect(file, `${entry.file} is registered but missing`).toBeDefined();
      expect(file!.text).toMatch(/emitUsageEvent|emitLlmUsage/);
    }
  });
});

describe("known-open paths are recorded, not hidden", () => {
  it("names the issue that owns each still-uncounted path", () => {
    expect(KNOWN_OPEN_PATHS.length).toBeGreaterThan(0);
    for (const entry of KNOWN_OPEN_PATHS) {
      expect(
        entry.knownOpenIssue,
        `${entry.file} must name the issue that owns it`,
      ).toBeTypeOf("number");
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });

  it("Graphiti's fan-out is registered as open against cinatra#2582", () => {
    const graphiti = KNOWN_OPEN_PATHS.find((entry) =>
      entry.file.includes("graphiti"),
    );
    expect(graphiti).toBeDefined();
    expect(graphiti!.knownOpenIssue).toBe(2582);
  });

  it("a known-open path is NOT silently counted as an allowed direct caller", () => {
    // If Graphiti's path is ever instrumented it must move OUT of this list
    // rather than accumulate in both — that move is the signal the gap closed.
    const openFiles = new Set(registeredFiles(KNOWN_OPEN_PATHS));
    for (const allowed of registeredFiles(DIRECT_PROVIDER_CALLERS)) {
      expect(openFiles.has(allowed)).toBe(false);
    }
  });
});
